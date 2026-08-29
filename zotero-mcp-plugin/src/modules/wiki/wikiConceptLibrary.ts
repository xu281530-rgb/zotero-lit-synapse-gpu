/**
 * The concept library: concepts as first-class entities, independent of pages.
 *
 * Before 2.4.3 a concept could only be born inside `CREATE_PAGE`, which made
 * the term store a by-product of the page store - you could not record that a
 * paper uses "柱状晶到等轴晶转变 / columnar-to-equiaxed transition / CET"
 * without also deciding that CET deserved a knowledge page. So the terminology
 * a library actually runs on was either missing or buried in page titles.
 *
 * Here a concept is its own record with its own terms and its own sources, and
 * a page is an optional thing that may point at one. Everything else in the
 * Wiki keeps working because `wiki_concepts.canonical_name` and `wiki_aliases`
 * are still written - they are now a PROJECTION of the structured terms rather
 * than the storage. Retrieval, the graph, `prepareUpdate` and the existing page
 * UI read the projection and never needed to learn about term rows.
 *
 * Deduplication is about the ENTITY, never about deleting a name. Two terms
 * the model judges to be one concept end up as one concept with one primary
 * term and the rest as aliases; every Chinese name, English name and
 * abbreviation stays in its own column, and every source stays attached to the
 * term it was seen for.
 */

import { hashWikiText, normalizeWikiName, normalizeWikiText } from "./wikiCanonicalizer";
import {
  CONCEPT_EMBEDDING_COLUMNS,
  conceptEmbeddingTextFromRow,
} from "./wikiConceptEmbedding";
import {
  CONCEPT_EMBEDDING_TARGET,
  WikiEmbeddingQueue,
} from "./wikiEmbeddingQueue";
import { rowColumn } from "./wikiRow";
import {
  EMPTY_ORIGINS,
  WikiTermError,
  choosePrimaryTerm,
  classifyLegacyName,
  normalizeOrigin,
  normalizeTermFields,
  normalizeTermOrigins,
  reconcileTerm,
  sameTerm,
  termCompleteness,
  termDisplayName,
  termSearchNames,
  type WikiConceptEntity,
  type WikiConceptEntityInput,
  type WikiTermFields,
  type WikiTermInput,
  type WikiTermOrigin,
  type WikiTermOrigins,
  type WikiTermRecord,
  type WikiTermSourceInput,
  type WikiTermSourceRecord,
} from "./wikiConceptTerms";
import type { WikiDatabase } from "./wikiTypes";

/** Sources already verified (or deliberately not) by the service layer. */
export interface WikiPreparedSource extends WikiTermSourceInput {
  libraryID: number;
  excerpt: string;
  chunkIdSnapshot: number | null;
}

export interface WikiConceptRecordResult {
  createdConcepts: number;
  updatedConcepts: number;
  mergedConcepts: number;
  createdTerms: number;
  completedTerms: number;
  /** Fields an inferred value held until a paper contradicted it. */
  correctedTerms: number;
  addedSources: number;
  conceptIds: number[];
  warnings: string[];
}

interface PreparedTerm {
  fields: WikiTermFields;
  origins: WikiTermOrigins;
  sources: WikiPreparedSource[];
  source: string;
  confidence: number;
  wantsPrimary: boolean;
}

/** The three name columns and their provenance, as stored. */
function storedTerm(term: WikiTermRecord): {
  fields: WikiTermFields;
  origins: WikiTermOrigins;
} {
  return {
    fields: { zh: term.zh, en: term.en, abbr: term.abbr },
    origins: term.origins,
  };
}

function clampConfidence(value: unknown): number {
  const numeric = Number(value ?? 1);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1, Math.max(0, numeric));
}

function keyOf(fields: WikiTermFields, part: "zh" | "en"): string {
  const raw = part === "zh" ? fields.zh : fields.en;
  return raw ? `${part}:${normalizeWikiName(raw)}` : "";
}

export class WikiConceptLibrary {
  private readonly db: WikiDatabase;

  /**
   * The concept embedding queue.
   *
   * Constructed here rather than passed in because the only thing it needs is
   * this same database handle, and because the alternative - having the store
   * remember to re-queue after every call into this class - is the kind of
   * list that is complete on the day it is written and wrong a release later.
   */
  private readonly embeddings: WikiEmbeddingQueue;

  constructor(db: WikiDatabase) {
    this.db = db;
    this.embeddings = new WikiEmbeddingQueue(db, CONCEPT_EMBEDDING_TARGET);
  }

  /**
   * Mark this concept's vector as owed.
   *
   * Called from {@link syncProjection}, which is the single funnel every term
   * mutation passes through on its way to `canonical_name` and `wiki_aliases`.
   * Placing it there rather than at each of the nine write paths above is why
   * a term edited in the UI, a merge, a rename and a paper recording a new
   * alias all reach the queue without any of them knowing it exists.
   */
  private async queueEmbedding(conceptId: number): Promise<void> {
    const rows = await this.db.queryAsync(
      `SELECT ${CONCEPT_EMBEDDING_COLUMNS}
         FROM wiki_concepts c WHERE c.concept_id = ?`,
      [conceptId],
    );
    if (!rows?.[0]) return;
    const text = conceptEmbeddingTextFromRow(rows[0]);
    if (text) await this.embeddings.enqueue(conceptId, text);
  }

  // ---- Reading ------------------------------------------------------------

  async list(libraryID: number): Promise<WikiConceptEntity[]> {
    const conceptRows = await this.db.queryAsync(
      `SELECT concept_id, library_id, concept_type, description, canonical_name,
              primary_term_locked
         FROM wiki_concepts WHERE library_id = ? ORDER BY concept_id`,
      [libraryID],
    );
    const entities: WikiConceptEntity[] = [];
    for (const row of conceptRows) {
      const entity = await this.buildEntity(row);
      if (entity) entities.push(entity);
    }
    // Chinese-first display order, so the index reads the way the titles do.
    return entities.sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "zh-Hans-CN"),
    );
  }

  async get(conceptId: number): Promise<WikiConceptEntity | null> {
    const rows = await this.db.queryAsync(
      `SELECT concept_id, library_id, concept_type, description, canonical_name,
              primary_term_locked
         FROM wiki_concepts WHERE concept_id = ?`,
      [conceptId],
    );
    return rows[0] ? this.buildEntity(rows[0]) : null;
  }

  private async buildEntity(row: any): Promise<WikiConceptEntity | null> {
    const conceptId = Number(rowColumn(row, "concept_id", "conceptId"));
    const terms = await this.termsOf(conceptId);
    const pageRows = await this.db.queryAsync(
      "SELECT page_id FROM wiki_pages WHERE primary_concept_id = ? AND status = 'active'",
      [conceptId],
    );
    const primary = terms.find((term) => term.role === "primary") ?? null;
    const canonicalName = String(
      rowColumn(row, "canonical_name", "canonicalName") ?? "",
    );
    return {
      conceptId,
      libraryID: Number(rowColumn(row, "library_id", "libraryID")),
      conceptType: String(rowColumn(row, "concept_type", "conceptType") ?? ""),
      description: String(rowColumn(row, "description", "description") ?? ""),
      displayName:
        (primary ? termDisplayName(primary) : "") ||
        primary?.abbr ||
        canonicalName,
      primaryTerm: primary,
      aliasTerms: terms.filter((term) => term.role !== "primary"),
      primaryLocked:
        Number(rowColumn(row, "primary_term_locked", "primaryTermLocked") ?? 0) ===
        1,
      pageIds: pageRows.map((page) =>
        Number(rowColumn(page, "page_id", "pageId")),
      ),
    };
  }

  private async termsOf(conceptId: number): Promise<WikiTermRecord[]> {
    const rows = await this.db.queryAsync(
      `SELECT term_id, concept_id, role, name_zh, name_en, abbreviation,
              origin_zh, origin_en, origin_abbr,
              source, confidence, created_at, updated_at
         FROM wiki_concept_terms WHERE concept_id = ?
        ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, term_id`,
      [conceptId],
    );
    const terms: WikiTermRecord[] = [];
    for (const row of rows) {
      const termId = Number(rowColumn(row, "term_id", "termId"));
      terms.push({
        termId,
        conceptId: Number(rowColumn(row, "concept_id", "conceptId")),
        role: String(rowColumn(row, "role", "role")) === "primary"
          ? "primary"
          : "alias",
        zh: String(rowColumn(row, "name_zh", "nameZh") ?? ""),
        en: String(rowColumn(row, "name_en", "nameEn") ?? ""),
        abbr: String(rowColumn(row, "abbreviation", "abbreviation") ?? ""),
        origins: {
          zh: normalizeOrigin(rowColumn(row, "origin_zh", "originZh")),
          en: normalizeOrigin(rowColumn(row, "origin_en", "originEn")),
          abbr: normalizeOrigin(rowColumn(row, "origin_abbr", "originAbbr")),
        },
        source: String(rowColumn(row, "source", "source") ?? "ai"),
        confidence: Number(rowColumn(row, "confidence", "confidence") ?? 1),
        createdAt: Number(rowColumn(row, "created_at", "createdAt") ?? 0),
        updatedAt: Number(rowColumn(row, "updated_at", "updatedAt") ?? 0),
        sources: await this.sourcesOf(termId),
      });
    }
    return terms;
  }

  private async sourcesOf(termId: number): Promise<WikiTermSourceRecord[]> {
    const rows = await this.db.queryAsync(
      `SELECT source_id, term_id, library_id, item_key, chunk_id_snapshot, excerpt, created_at
         FROM wiki_concept_term_sources WHERE term_id = ? ORDER BY source_id`,
      [termId],
    );
    return rows.map((row) => {
      const chunk = rowColumn(row, "chunk_id_snapshot", "chunkIdSnapshot");
      return {
        sourceId: Number(rowColumn(row, "source_id", "sourceId")),
        termId: Number(rowColumn(row, "term_id", "termId")),
        libraryID: Number(rowColumn(row, "library_id", "libraryID")),
        itemKey: String(rowColumn(row, "item_key", "itemKey")),
        chunkIdSnapshot: chunk == null ? null : Number(chunk),
        excerpt: String(rowColumn(row, "excerpt", "excerpt") ?? ""),
        createdAt: Number(rowColumn(row, "created_at", "createdAt") ?? 0),
      };
    });
  }

  /** Concept ids whose terms were recognised in a given document. */
  async conceptIdsForItem(
    libraryID: number,
    itemKey: string,
  ): Promise<number[]> {
    const rows = await this.db.queryAsync(
      `SELECT DISTINCT t.concept_id
         FROM wiki_concept_term_sources s
         JOIN wiki_concept_terms t ON t.term_id = s.term_id
        WHERE s.library_id = ? AND s.item_key = ?`,
      [libraryID, itemKey],
    );
    return rows.map((row) => Number(rowColumn(row, "concept_id", "conceptId")));
  }

  // ---- Writing ------------------------------------------------------------

  /**
   * Record the concepts one reading pass recognised.
   *
   * Every entity is resolved against what the library already holds before
   * anything is written: a term whose Chinese or English full name is already
   * known joins that concept instead of founding a second one, and an entity
   * whose terms reach two existing concepts merges them, because the caller
   * has asserted they are one thing. Nothing is ever deleted to deduplicate -
   * the losing primary term becomes an alias and keeps all three of its fields
   * and all of its sources.
   */
  async record(options: {
    libraryID: number;
    entities: Array<
      WikiConceptEntityInput & { sources?: WikiPreparedSource[] }
    >;
    /** Runs after every concept statement but before the transaction commits. */
    beforeCommit?: () => Promise<void>;
  }): Promise<WikiConceptRecordResult> {
    const result: WikiConceptRecordResult = {
      createdConcepts: 0,
      updatedConcepts: 0,
      mergedConcepts: 0,
      createdTerms: 0,
      completedTerms: 0,
      correctedTerms: 0,
      addedSources: 0,
      conceptIds: [],
      warnings: [],
    };
    await this.db.executeTransaction(async () => {
      for (const entity of options.entities ?? []) {
        await this.recordOne(options.libraryID, entity, result);
      }
      await options.beforeCommit?.();
    });
    return result;
  }

  private prepareTerms(
    entity: WikiConceptEntityInput & { sources?: WikiPreparedSource[] },
    warnings: string[],
  ): PreparedTerm[] {
    const inputs: Array<{ input: WikiTermInput; wantsPrimary: boolean }> = [];
    if (entity.primaryTerm) {
      inputs.push({ input: entity.primaryTerm, wantsPrimary: true });
    }
    for (const term of entity.terms ?? []) {
      inputs.push({ input: term, wantsPrimary: false });
    }
    const shared = (entity.sources ?? []) as WikiPreparedSource[];
    const prepared: PreparedTerm[] = [];
    for (const { input, wantsPrimary } of inputs) {
      let fields: WikiTermFields;
      try {
        fields = normalizeTermFields(input);
      } catch (error) {
        warnings.push(
          error instanceof WikiTermError
            ? error.message
            : String((error as Error)?.message ?? error),
        );
        continue;
      }
      const origins = normalizeTermOrigins(fields, input);
      // A term that names its own sources uses them; one that does not
      // inherits the entity's, which is the common case - every term of a
      // concept recognised while reading one paper came from that paper.
      const own = (input.sources ?? []) as WikiPreparedSource[];
      const sources = own.length ? own : shared;
      // Two entries of ONE submission fold together only when nothing is lost
      // by folding. Two spellings of the same English name inside a single
      // call are two terms, exactly as they would be across two calls.
      const twin = prepared.find(
        (existing) =>
          reconcileTerm(
            { fields: existing.fields, origins: existing.origins },
            { fields, origins },
          ) !== null,
      );
      if (twin) {
        const folded = reconcileTerm(
          { fields: twin.fields, origins: twin.origins },
          { fields, origins },
        );
        if (folded) {
          twin.fields = folded.fields;
          twin.origins = folded.origins;
        }
        twin.sources.push(...sources);
        twin.wantsPrimary = twin.wantsPrimary || wantsPrimary;
        continue;
      }
      prepared.push({
        fields,
        origins,
        sources: [...sources],
        source: normalizeWikiName(input.source || "ai") || "ai",
        confidence: clampConfidence(input.confidence),
        wantsPrimary,
      });
    }
    return prepared;
  }

  /**
   * Resolve one submitted entity against the library and write it.
   *
   * 2.4.3 treated "these terms reach two concepts" as an instruction to fuse
   * them. That is too much authority for a single reading pass: a full name
   * two concepts happen to share is good evidence they are one thing, but a
   * wrong fusion destroys a distinction nobody can restore. So the merge now
   * has to survive {@link mergeVerdict}, and a refused merge is not a failure -
   * each term simply goes to the concept it actually matched, sources and all,
   * and both concepts stay standing with a warning naming them.
   */
  private async recordOne(
    libraryID: number,
    entity: WikiConceptEntityInput & { sources?: WikiPreparedSource[] },
    result: WikiConceptRecordResult,
  ): Promise<void> {
    const terms = this.prepareTerms(entity, result.warnings);
    if (!terms.length) return;

    // Which existing concepts does each term reach, and how strongly does each
    // concept answer this submission as a whole?
    const reach = new Map<PreparedTerm, number[]>();
    const bridges = new Map<PreparedTerm, number[]>();
    const tally = new Map<number, number>();
    for (const term of terms) {
      const ids = await this.matchConcepts(libraryID, [term]);
      reach.set(term, ids);
      // Reaching a concept by a shared full name is not the same as agreeing
      // with it. A term only BRIDGES to a concept when it can be absorbed by
      // one of that concept's terms without overruling anything, and only a
      // bridge is evidence strong enough to fuse two concepts below.
      const compatible: number[] = [];
      for (const id of ids) {
        const existing = await this.termsOf(id);
        const fits = existing.some((candidate) =>
          reconcileTerm(storedTerm(candidate), {
            fields: term.fields,
            origins: term.origins,
          }),
        );
        if (fits) compatible.push(id);
      }
      bridges.set(term, compatible);
      for (const id of ids) tally.set(id, (tally.get(id) ?? 0) + 1);
    }
    const matched = Array.from(tally.keys()).sort((a, b) => a - b);
    const bridged = (left: number, right: number): boolean =>
      terms.some((term) => {
        const compatible = bridges.get(term) ?? [];
        return compatible.includes(left) && compatible.includes(right);
      });

    let conceptId: number;
    if (!matched.length) {
      conceptId = await this.createConceptShell(libraryID, entity, terms);
      result.createdConcepts += 1;
    } else {
      conceptId = await this.chooseMergeTarget(matched, tally);
      result.updatedConcepts += 1;
    }

    // Concepts this submission touched that were NOT folded in.
    const separate = new Set<number>();
    for (const other of matched.filter((id) => id !== conceptId)) {
      const verdict = !bridged(conceptId, other)
        ? "ambiguous"
        : await this.mergeVerdict(conceptId, other);
      if (verdict === "ok") {
        await this.mergeConcepts(conceptId, other);
        result.mergedConcepts += 1;
        continue;
      }
      separate.add(other);
      result.warnings.push(
        verdict === "pages"
          ? `Concepts ${conceptId} and ${other} share a name but both own an active knowledge page, so they were left separate. ` +
            "Delete or re-point one of the pages if they really are one concept."
          : `Concepts ${conceptId} and ${other} are reachable from the same submission but nothing you sent agrees with both of them, ` +
            "so they were left separate rather than merged. Edit them in the terminology view if they really are one concept.",
      );
    }

    const touched = new Set<number>([conceptId]);
    for (const term of terms) {
      const reached = reach.get(term) ?? [];
      // A term whose only home is a concept that stayed separate goes THERE.
      // Copying it onto the merge target instead would put the same name under
      // two concepts and make the ambiguity worse rather than leaving it alone.
      const stranded = reached.filter((id) => separate.has(id));
      const home =
        stranded.length && !reached.includes(conceptId) ? stranded[0] : conceptId;
      const upserted = await this.upsertTerm(home, term);
      if (upserted.created) result.createdTerms += 1;
      if (upserted.completed) result.completedTerms += 1;
      if (upserted.corrected) result.correctedTerms += 1;
      result.addedSources += await this.attachSources(
        upserted.termId,
        libraryID,
        term.sources,
      );
      touched.add(home);
    }
    for (const id of touched) {
      await this.recomputePrimary(id);
      await this.syncProjection(id, result.warnings);
      if (!result.conceptIds.includes(id)) result.conceptIds.push(id);
    }
  }

  /** Every existing concept any of these terms already belongs to. */
  private async matchConcepts(
    libraryID: number,
    terms: PreparedTerm[],
  ): Promise<number[]> {
    const found = new Set<number>();
    for (const term of terms) {
      const keys = [
        { column: "normalized_zh", value: keyOf(term.fields, "zh") },
        { column: "normalized_en", value: keyOf(term.fields, "en") },
      ].filter((entry) => entry.value);
      for (const entry of keys) {
        const normalized = entry.value.slice(3);
        const rows = await this.db.queryAsync(
          `SELECT t.concept_id FROM wiki_concept_terms t
             JOIN wiki_concepts c ON c.concept_id = t.concept_id
            WHERE c.library_id = ? AND t.${entry.column} = ?`,
          [libraryID, normalized],
        );
        for (const row of rows) {
          found.add(Number(rowColumn(row, "concept_id", "conceptId")));
        }
      }
    }
    return Array.from(found).sort((a, b) => a - b);
  }

  /**
   * Which concept the submission is really about.
   *
   * A pinned primary term outranks everything: a concept a person has curated
   * must not be dissolved into one nobody has looked at. After that, the
   * concept the most submitted terms landed on wins, then the one whose
   * primary term is most complete.
   */
  private async chooseMergeTarget(
    conceptIds: number[],
    tally: Map<number, number>,
  ): Promise<number> {
    let best = conceptIds[0];
    let bestScore: [number, number, number] = [-1, -1, -1];
    for (const conceptId of conceptIds) {
      const locked = Number(
        await this.db.valueQueryAsync(
          "SELECT primary_term_locked FROM wiki_concepts WHERE concept_id = ?",
          [conceptId],
        ),
      );
      const terms = await this.termsOf(conceptId);
      const primary = terms.find((term) => term.role === "primary");
      const score: [number, number, number] = [
        locked === 1 ? 1 : 0,
        tally.get(conceptId) ?? 0,
        primary ? termCompleteness(primary) : 0,
      ];
      const better =
        score[0] !== bestScore[0]
          ? score[0] > bestScore[0]
          : score[1] !== bestScore[1]
            ? score[1] > bestScore[1]
            : score[2] > bestScore[2];
      if (better) {
        bestScore = score;
        best = conceptId;
      }
    }
    return best;
  }

  /**
   * May these two concepts be fused, on the evidence available here?
   *
   * "pages"     - both own an active knowledge page. Merging would have to
   *               destroy or silently re-point one of them, and neither is an
   *               outcome a term-recording call may cause on its own.
   * "ambiguous" - they hold terms that share a full name but disagree about
   *               another field neither side may overrule. That disagreement
   *               is the strongest available signal that they are two things,
   *               not one, so the merge is refused.
   * "ok"        - nothing they already hold contradicts. The caller has
   *               additionally had to supply a term that agrees with BOTH of
   *               them before this is asked at all; a merge never rests on a
   *               shared abbreviation, and never on a single submitted term
   *               whose Chinese half points at one concept while its English
   *               half points at another.
   */
  private async mergeVerdict(
    survivor: number,
    victim: number,
  ): Promise<"ok" | "pages" | "ambiguous"> {
    const pageCount = Number(
      await this.db.valueQueryAsync(
        `SELECT COUNT(*) FROM wiki_pages
          WHERE primary_concept_id IN (?, ?) AND status = 'active'`,
        [survivor, victim],
      ),
    );
    if (pageCount > 1) return "pages";
    const survivorTerms = await this.termsOf(survivor);
    const victimTerms = await this.termsOf(victim);
    for (const mine of survivorTerms) {
      for (const theirs of victimTerms) {
        if (!sameTerm(storedTerm(mine).fields, storedTerm(theirs).fields)) {
          continue;
        }
        if (!reconcileTerm(storedTerm(mine), storedTerm(theirs))) {
          return "ambiguous";
        }
      }
    }
    return "ok";
  }

  private async createConceptShell(
    libraryID: number,
    entity: WikiConceptEntityInput,
    terms: PreparedTerm[],
  ): Promise<number> {
    const lead =
      terms.find((term) => term.wantsPrimary) ??
      terms.slice().sort(
        (left, right) =>
          termCompleteness(right.fields) - termCompleteness(left.fields),
      )[0];
    const display =
      termDisplayName(lead.fields) || lead.fields.abbr || "unnamed concept";
    const name = await this.availableConceptName(libraryID, display);
    await this.db.queryAsync(
      `INSERT INTO wiki_concepts
         (library_id, canonical_name, normalized_name, concept_type, description)
       VALUES (?, ?, ?, ?, ?)`,
      [
        libraryID,
        name,
        normalizeWikiName(name),
        normalizeWikiText(entity.conceptType || "concept"),
        normalizeWikiText(entity.description || ""),
      ],
    );
    return Number(await this.db.valueQueryAsync("SELECT last_insert_rowid()"));
  }

  /**
   * A name `wiki_concepts` will accept.
   *
   * `UNIQUE(library_id, normalized_name)` predates the term store and cannot
   * be dropped without rewriting every foreign key that hangs off it, so on
   * the rare genuine clash - two concepts that share a display name without
   * sharing a full name - the second gets a disambiguating suffix. The terms
   * themselves are untouched; only this projection column is decorated.
   */
  private async availableConceptName(
    libraryID: number,
    display: string,
    exceptConceptId?: number,
  ): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? display : `${display} (${attempt + 1})`;
      const taken = await this.db.valueQueryAsync(
        "SELECT concept_id FROM wiki_concepts WHERE library_id = ? AND normalized_name = ? LIMIT 1",
        [libraryID, normalizeWikiName(candidate)],
      );
      if (!taken || Number(taken) === exceptConceptId) return candidate;
    }
    return `${display} (${Date.now()})`;
  }

  /**
   * Fold `victim` into `survivor`. Only ever called after {@link mergeVerdict}
   * has said the fusion is safe, which is where the refusals live.
   *
   * A merged-away primary term keeps all three of its fields, its provenance
   * and its sources; it becomes an alias of the survivor rather than a
   * deletion. Nothing here removes a name.
   */
  private async mergeConcepts(
    survivor: number,
    victim: number,
  ): Promise<boolean> {
    const locked = Number(
      await this.db.valueQueryAsync(
        "SELECT primary_term_locked FROM wiki_concepts WHERE concept_id = ?",
        [victim],
      ),
    );
    const victimTerms = await this.termsOf(victim);
    await this.db.queryAsync(
      "UPDATE wiki_pages SET primary_concept_id = ? WHERE primary_concept_id = ?",
      [survivor, victim],
    );
    // Relations survive the merge where they still say something: a relation
    // that would now point a concept at itself is dropped, and one that
    // duplicates an existing edge is ignored rather than raising.
    await this.db.queryAsync(
      `UPDATE OR IGNORE wiki_relations SET source_concept_id = ?
        WHERE source_concept_id = ?`,
      [survivor, victim],
    );
    await this.db.queryAsync(
      `UPDATE OR IGNORE wiki_relations SET target_concept_id = ?
        WHERE target_concept_id = ?`,
      [survivor, victim],
    );
    await this.db.queryAsync(
      "DELETE FROM wiki_relations WHERE source_concept_id = target_concept_id",
    );
    // The victim's rows go through the same upsert as a fresh submission, so a
    // term it shares with the survivor completes that term instead of becoming
    // a duplicate row.
    await this.db.queryAsync("DELETE FROM wiki_concepts WHERE concept_id = ?", [
      victim,
    ]);
    for (const term of victimTerms) {
      const upserted = await this.upsertTerm(survivor, {
        fields: { zh: term.zh, en: term.en, abbr: term.abbr },
        origins: term.origins,
        sources: [],
        source: term.source,
        confidence: term.confidence,
        wantsPrimary: false,
      });
      for (const source of term.sources) {
        await this.attachSources(upserted.termId, source.libraryID, [
          {
            libraryID: source.libraryID,
            itemKey: source.itemKey,
            chunkIdSnapshot: source.chunkIdSnapshot,
            excerpt: source.excerpt,
          },
        ]);
      }
    }
    // A lock a person set on the concept being folded away follows its terms,
    // so a curated primary term is not silently re-elected by the survivor.
    if (locked === 1) {
      await this.db.queryAsync(
        "UPDATE wiki_concepts SET primary_term_locked = 1 WHERE concept_id = ?",
        [survivor],
      );
    }
    return true;
  }

  /**
   * Put one term into a concept without ever losing a name.
   *
   * The 2.4.3 version matched on a single agreeing field and then folded the
   * rest in with `base.en || extra.en`, which quietly discarded whatever the
   * stored row already held. So a concept that knew
   * "动态再结晶 / Dynamic Recrystallization / DRX" swallowed a later paper's
   * "动态再结晶 / Dynamic Recrystallisation" and no column anywhere recorded
   * the second spelling. Now a stored row is only reused when
   * {@link reconcileTerm} can absorb the arrival without overruling anything -
   * filling blanks, upgrading provenance, or replacing a value the model had
   * merely inferred. When it cannot, the arrival becomes its own alias row and
   * BOTH names survive.
   *
   * When several stored rows could take it, the one agreeing on the most
   * fields wins, so an arrival lands on the row it actually restates.
   */
  private async upsertTerm(
    conceptId: number,
    term: PreparedTerm,
  ): Promise<{
    termId: number;
    created: boolean;
    completed: boolean;
    corrected: boolean;
  }> {
    const existing = await this.termsOf(conceptId);
    let best: { term: WikiTermRecord; result: NonNullable<ReturnType<typeof reconcileTerm>> } | null =
      null;
    for (const candidate of existing) {
      const result = reconcileTerm(storedTerm(candidate), {
        fields: term.fields,
        origins: term.origins,
      });
      if (!result) continue;
      if (!best || result.exact > best.result.exact) {
        best = { term: candidate, result };
      }
    }
    const now = Date.now();
    if (best) {
      const { term: twin, result } = best;
      if (result.changed) {
        // A completed term may now collide with a sibling row that already
        // held the fuller form. `OR IGNORE` leaves the twin as it was rather
        // than failing the whole submission; the sibling already carries the
        // information, and the next `recomputePrimary` picks the better row.
        await this.db.queryAsync(
          `UPDATE OR IGNORE wiki_concept_terms
              SET name_zh = ?, name_en = ?, abbreviation = ?,
                  normalized_zh = ?, normalized_en = ?, normalized_abbr = ?,
                  origin_zh = ?, origin_en = ?, origin_abbr = ?,
                  source = CASE WHEN source = 'legacy' THEN ? ELSE source END,
                  updated_at = ?
            WHERE term_id = ?`,
          [
            result.fields.zh,
            result.fields.en,
            result.fields.abbr,
            result.fields.zh ? normalizeWikiName(result.fields.zh) : "",
            result.fields.en ? normalizeWikiName(result.fields.en) : "",
            result.fields.abbr ? normalizeWikiName(result.fields.abbr) : "",
            result.origins.zh,
            result.origins.en,
            result.origins.abbr,
            term.source,
            now,
            twin.termId,
          ],
        );
      }
      return {
        termId: twin.termId,
        created: false,
        completed: result.changed,
        corrected: result.corrected,
      };
    }
    await this.db.queryAsync(
      `INSERT OR IGNORE INTO wiki_concept_terms
         (concept_id, role, name_zh, name_en, abbreviation,
          normalized_zh, normalized_en, normalized_abbr,
          origin_zh, origin_en, origin_abbr,
          source, confidence, created_at, updated_at)
       VALUES (?, 'alias', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conceptId,
        term.fields.zh,
        term.fields.en,
        term.fields.abbr,
        term.fields.zh ? normalizeWikiName(term.fields.zh) : "",
        term.fields.en ? normalizeWikiName(term.fields.en) : "",
        term.fields.abbr ? normalizeWikiName(term.fields.abbr) : "",
        term.origins.zh,
        term.origins.en,
        term.origins.abbr,
        term.source,
        term.confidence,
        now,
        now,
      ],
    );
    const inserted = await this.db.valueQueryAsync(
      `SELECT term_id FROM wiki_concept_terms
        WHERE concept_id = ? AND normalized_zh = ? AND normalized_en = ? AND normalized_abbr = ?`,
      [
        conceptId,
        term.fields.zh ? normalizeWikiName(term.fields.zh) : "",
        term.fields.en ? normalizeWikiName(term.fields.en) : "",
        term.fields.abbr ? normalizeWikiName(term.fields.abbr) : "",
      ],
    );
    return {
      termId: Number(inserted),
      created: true,
      completed: false,
      corrected: false,
    };
  }

  private async attachSources(
    termId: number,
    libraryID: number,
    sources: WikiTermSourceInput[],
  ): Promise<number> {
    let added = 0;
    for (const source of sources ?? []) {
      const itemKey = String(source.itemKey ?? "").trim();
      if (!itemKey) continue;
      const excerpt = normalizeWikiText(String(source.excerpt ?? ""));
      const excerptHash = excerpt ? await hashWikiText(excerpt) : "";
      const before = Number(
        await this.db.valueQueryAsync(
          "SELECT COUNT(*) FROM wiki_concept_term_sources WHERE term_id = ?",
          [termId],
        ),
      );
      await this.db.queryAsync(
        `INSERT OR IGNORE INTO wiki_concept_term_sources
           (term_id, library_id, item_key, chunk_id_snapshot, excerpt, excerpt_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          termId,
          Number(source.libraryID ?? libraryID),
          itemKey,
          source.chunkIdSnapshot == null
            ? null
            : Number(source.chunkIdSnapshot),
          excerpt,
          excerptHash,
          Date.now(),
        ],
      );
      const after = Number(
        await this.db.valueQueryAsync(
          "SELECT COUNT(*) FROM wiki_concept_term_sources WHERE term_id = ?",
          [termId],
        ),
      );
      if (after > before) added += 1;
    }
    return added;
  }

  /**
   * Re-elect the primary term after any change to a concept's terms.
   *
   * Skipped entirely once a person has pinned one. Automatic election exists
   * because most concepts nobody has looked at still need a title; the moment
   * somebody decides which name this concept goes by, a later paper arriving
   * with a more complete term group is not grounds to overrule them. Only
   * another manual choice moves a pinned primary.
   *
   * Where election does run, the old primary is demoted before the new one is
   * promoted because the database holds a partial unique index over
   * `role = 'primary'`: two primaries cannot exist even for the duration of a
   * statement.
   */
  async recomputePrimary(conceptId: number): Promise<void> {
    const locked = Number(
      await this.db.valueQueryAsync(
        "SELECT primary_term_locked FROM wiki_concepts WHERE concept_id = ?",
        [conceptId],
      ),
    );
    const terms = await this.termsOf(conceptId);
    if (!terms.length) return;
    if (locked === 1) {
      // Unless the pinned row is gone - deleted by hand - in which case the
      // lock has nothing left to protect and election takes over again.
      if (terms.some((term) => term.role === "primary")) return;
      await this.db.queryAsync(
        "UPDATE wiki_concepts SET primary_term_locked = 0 WHERE concept_id = ?",
        [conceptId],
      );
    }
    const chosen = choosePrimaryTerm(
      terms.map((term) => ({
        zh: term.zh,
        en: term.en,
        abbr: term.abbr,
        createdAt: term.createdAt,
        termId: term.termId,
      })),
    );
    if (!chosen) return;
    const current = terms.find((term) => term.role === "primary");
    if (current && current.termId === chosen.termId) return;
    await this.db.queryAsync(
      "UPDATE wiki_concept_terms SET role = 'alias' WHERE concept_id = ?",
      [conceptId],
    );
    await this.db.queryAsync(
      "UPDATE wiki_concept_terms SET role = 'primary' WHERE term_id = ?",
      [chosen.termId],
    );
  }

  /**
   * Rewrite the flat name projection every older surface still reads.
   *
   * `wiki_concepts.canonical_name` becomes the primary term's display name and
   * `wiki_aliases` becomes every other name the concept carries, one row per
   * name. Wiki search, `prepareUpdate`, the knowledge graph and the existing
   * page view therefore see the new terms without knowing the term store
   * exists, and a name recorded in any of the three structured fields is
   * findable by all of them.
   */
  async syncProjection(
    conceptId: number,
    warnings: string[] = [],
  ): Promise<void> {
    const conceptRow = await this.db.queryAsync(
      "SELECT library_id, canonical_name FROM wiki_concepts WHERE concept_id = ?",
      [conceptId],
    );
    if (!conceptRow[0]) return;
    const libraryID = Number(rowColumn(conceptRow[0], "library_id", "libraryID"));
    const currentName = String(
      rowColumn(conceptRow[0], "canonical_name", "canonicalName") ?? "",
    );
    const terms = await this.termsOf(conceptId);
    const primary = terms.find((term) => term.role === "primary");
    const display = primary
      ? termDisplayName(primary) || primary.abbr || currentName
      : currentName;
    if (display && normalizeWikiName(display) !== normalizeWikiName(currentName)) {
      const name = await this.availableConceptName(
        libraryID,
        display,
        conceptId,
      );
      if (normalizeWikiName(name) !== normalizeWikiName(display)) {
        warnings.push(
          `Another concept already uses the name "${display}", so this one is filed as "${name}". Its terms are unchanged.`,
        );
      }
      await this.db.queryAsync(
        "UPDATE wiki_concepts SET canonical_name = ?, normalized_name = ? WHERE concept_id = ?",
        [name, normalizeWikiName(name), conceptId],
      );
    }
    const finalName = String(
      (await this.db.valueQueryAsync(
        "SELECT canonical_name FROM wiki_concepts WHERE concept_id = ?",
        [conceptId],
      )) ?? "",
    );
    const wanted = new Map<string, { name: string; source: string }>();
    for (const term of terms) {
      for (const name of termSearchNames(term)) {
        const normalized = normalizeWikiName(name);
        if (!normalized || normalized === normalizeWikiName(finalName)) continue;
        if (!wanted.has(normalized)) {
          wanted.set(normalized, { name, source: term.source });
        }
      }
    }
    await this.db.queryAsync(
      "DELETE FROM wiki_aliases WHERE concept_id = ?",
      [conceptId],
    );
    for (const [normalized, entry] of wanted) {
      await this.db.queryAsync(
        `INSERT OR IGNORE INTO wiki_aliases
           (concept_id, alias, normalized_alias, language, source, confidence)
         VALUES (?, ?, ?, 'und', ?, 1)`,
        [conceptId, entry.name, normalized, entry.source],
      );
    }
    // The names are now settled, so the vector for the old ones is owed.
    await this.queueEmbedding(conceptId);
  }

  /**
   * Give a concept born inside `CREATE_PAGE` the structured terms it implies.
   *
   * `CREATE_PAGE` still speaks the old vocabulary - one canonical name and a
   * list of flat alias strings - and there is no reason to break that call.
   * The names it supplies are classified the same way a migrated database's
   * are, so a concept created from a page and one recorded while reading end
   * up as the same kind of record.
   *
   * Deliberately transaction-free: the commit that calls it already owns one.
   */
  async ingestFlatNames(
    conceptId: number,
    entries: Array<{ name: string; language?: string; source?: string }>,
  ): Promise<void> {
    for (const entry of entries) {
      const fields = classifyLegacyName(entry.name, entry.language);
      if (!fields.zh && !fields.en && !fields.abbr) continue;
      const source = normalizeWikiName(entry.source || "ai") || "ai";
      if (!fields.zh && !fields.en) {
        await this.placeLooseAbbreviation(conceptId, fields.abbr, source);
        continue;
      }
      await this.upsertTerm(conceptId, {
        fields,
        // A flat name says nothing about where it came from beyond who wrote
        // it, so a page-created name is marked by its writer and nothing is
        // claimed about the paper it may or may not have been quoted from.
        origins: {
          zh: fields.zh ? (source as WikiTermOrigin) : "",
          en: fields.en ? (source as WikiTermOrigin) : "",
          abbr: fields.abbr ? (source as WikiTermOrigin) : "",
        },
        sources: [],
        source,
        confidence: 1,
        wantsPrimary: false,
      });
    }
    await this.recomputePrimary(conceptId);
    await this.syncProjection(conceptId);
  }

  /**
   * Find a home for an abbreviation that arrived without a full name.
   *
   * It fills the first term of this concept that has no abbreviation yet,
   * which asserts nothing new - the caller already said this string names this
   * concept. Only when every term already carries a different abbreviation is
   * a `legacy` row created to hold it, and the terminology view marks such a
   * row as needing a full name rather than pretending it is complete.
   */
  private async placeLooseAbbreviation(
    conceptId: number,
    abbr: string,
    source: string,
  ): Promise<void> {
    if (!abbr) return;
    const terms = await this.termsOf(conceptId);
    const normalized = normalizeWikiName(abbr);
    if (terms.some((term) => normalizeWikiName(term.abbr) === normalized)) {
      return;
    }
    const vacant = terms.find((term) => !term.abbr);
    const now = Date.now();
    if (vacant) {
      await this.db.queryAsync(
        `UPDATE OR IGNORE wiki_concept_terms
            SET abbreviation = ?, normalized_abbr = ?, origin_abbr = ?,
                updated_at = ?
          WHERE term_id = ?`,
        [abbr, normalized, source as WikiTermOrigin, now, vacant.termId],
      );
      return;
    }
    await this.db.queryAsync(
      `INSERT OR IGNORE INTO wiki_concept_terms
         (concept_id, role, name_zh, name_en, abbreviation,
          normalized_zh, normalized_en, normalized_abbr,
          origin_zh, origin_en, origin_abbr,
          source, confidence, created_at, updated_at)
       VALUES (?, 'alias', '', '', ?, '', '', ?, '', '', '', 'legacy', 1, ?, ?)`,
      [conceptId, abbr, normalized, now, now],
    );
  }

  /**
   * Apply a flat rename to the structured terms behind it.
   *
   * `updateConcept({ canonicalName })` still exists and still means "this
   * concept's main name is now X". Structurally that is an edit to ONE field
   * of the primary term - the Chinese one if X is Chinese, the English one
   * otherwise - not a new term, so renaming does not leave the old name behind
   * as an alias it never was.
   *
   * Transaction-free; the caller owns the transaction.
   */
  async renamePrimaryFlat(conceptId: number, name: string): Promise<void> {
    const fields = classifyLegacyName(name);
    if (!fields.zh && !fields.en && !fields.abbr) return;
    const terms = await this.termsOf(conceptId);
    const primary = terms.find((term) => term.role === "primary");
    if (!primary) {
      await this.ingestFlatNames(conceptId, [{ name, source: "user" }]);
      return;
    }
    // Only the field the new name belongs to is replaced. Renaming an
    // English-named concept to a Chinese name therefore fills the Chinese
    // column and keeps the English one, which is a completion rather than a
    // loss of the name the library was already using.
    const next: WikiTermFields = {
      zh: fields.zh || primary.zh,
      en: fields.en || primary.en,
      abbr: fields.abbr || primary.abbr,
    };
    const renamed: WikiTermOrigins = {
      zh: fields.zh ? "user" : primary.origins.zh,
      en: fields.en ? "user" : primary.origins.en,
      abbr: fields.abbr ? "user" : primary.origins.abbr,
    };
    await this.db.queryAsync(
      `UPDATE OR IGNORE wiki_concept_terms
          SET name_zh = ?, name_en = ?, abbreviation = ?,
              normalized_zh = ?, normalized_en = ?, normalized_abbr = ?,
              origin_zh = ?, origin_en = ?, origin_abbr = ?,
              updated_at = ?
        WHERE term_id = ?`,
      [
        next.zh,
        next.en,
        next.abbr,
        next.zh ? normalizeWikiName(next.zh) : "",
        next.en ? normalizeWikiName(next.en) : "",
        next.abbr ? normalizeWikiName(next.abbr) : "",
        renamed.zh,
        renamed.en,
        renamed.abbr,
        Date.now(),
        primary.termId,
      ],
    );
    await this.syncProjection(conceptId);
  }

  /**
   * Drop one flat name from wherever it lives in the structured terms.
   *
   * A term left with no full name after the removal goes with it, because an
   * abbreviation on its own is not a term this store will keep.
   */
  async removeFlatName(conceptId: number, name: string): Promise<void> {
    const normalized = normalizeWikiName(name);
    if (!normalized) return;
    for (const term of await this.termsOf(conceptId)) {
      const next: WikiTermFields = {
        zh: normalizeWikiName(term.zh) === normalized ? "" : term.zh,
        en: normalizeWikiName(term.en) === normalized ? "" : term.en,
        abbr: normalizeWikiName(term.abbr) === normalized ? "" : term.abbr,
      };
      if (next.zh === term.zh && next.en === term.en && next.abbr === term.abbr) {
        continue;
      }
      if (!next.zh && !next.en) {
        await this.db.queryAsync(
          "DELETE FROM wiki_concept_terms WHERE term_id = ?",
          [term.termId],
        );
        continue;
      }
      await this.db.queryAsync(
        `UPDATE OR IGNORE wiki_concept_terms
            SET name_zh = ?, name_en = ?, abbreviation = ?,
                normalized_zh = ?, normalized_en = ?, normalized_abbr = ?,
                origin_zh = ?, origin_en = ?, origin_abbr = ?,
                updated_at = ?
          WHERE term_id = ?`,
        [
          next.zh,
          next.en,
          next.abbr,
          next.zh ? normalizeWikiName(next.zh) : "",
          next.en ? normalizeWikiName(next.en) : "",
          next.abbr ? normalizeWikiName(next.abbr) : "",
          next.zh ? term.origins.zh : "",
          next.en ? term.origins.en : "",
          next.abbr ? term.origins.abbr : "",
          Date.now(),
          term.termId,
        ],
      );
    }
    await this.recomputePrimary(conceptId);
    await this.syncProjection(conceptId);
  }

  // ---- Manual editing (the terminology view) ------------------------------

  async addTerm(options: {
    libraryID: number;
    conceptId: number;
    fields: Partial<WikiTermFields>;
  }): Promise<void> {
    const fields = normalizeTermFields(options.fields);
    await this.db.executeTransaction(async () => {
      await this.requireConcept(options.conceptId, options.libraryID);
      await this.upsertTerm(options.conceptId, {
        fields,
        origins: {
          zh: fields.zh ? "user" : "",
          en: fields.en ? "user" : "",
          abbr: fields.abbr ? "user" : "",
        },
        sources: [],
        source: "user",
        confidence: 1,
        wantsPrimary: false,
      });
      await this.recomputePrimary(options.conceptId);
      await this.syncProjection(options.conceptId);
    });
  }

  /**
   * Edit one term by hand.
   *
   * Only the fields the person actually CHANGED become theirs. Opening the
   * editor, retyping nothing and pressing save must not relabel a quoted term
   * as a manual one - the tints would stop meaning anything within a week of
   * ordinary use. A field that did change is marked "user" and no automatic
   * pass may overwrite it afterwards.
   */
  async updateTerm(options: {
    libraryID: number;
    conceptId: number;
    termId: number;
    fields: Partial<WikiTermFields>;
  }): Promise<void> {
    const fields = normalizeTermFields(options.fields);
    await this.db.executeTransaction(async () => {
      await this.requireConcept(options.conceptId, options.libraryID);
      const before = (await this.termsOf(options.conceptId)).find(
        (term) => term.termId === options.termId,
      );
      const kept = before ? before.origins : EMPTY_ORIGINS;
      const mark = (key: keyof WikiTermFields): WikiTermOrigin => {
        if (!fields[key]) return "";
        if (!before) return "user";
        return normalizeWikiName(before[key]) === normalizeWikiName(fields[key])
          ? kept[key]
          : "user";
      };
      const origins: WikiTermOrigins = {
        zh: mark("zh"),
        en: mark("en"),
        abbr: mark("abbr"),
      };
      await this.db.queryAsync(
        `UPDATE wiki_concept_terms
            SET name_zh = ?, name_en = ?, abbreviation = ?,
                normalized_zh = ?, normalized_en = ?, normalized_abbr = ?,
                origin_zh = ?, origin_en = ?, origin_abbr = ?,
                source = 'user', updated_at = ?
          WHERE term_id = ? AND concept_id = ?`,
        [
          fields.zh,
          fields.en,
          fields.abbr,
          fields.zh ? normalizeWikiName(fields.zh) : "",
          fields.en ? normalizeWikiName(fields.en) : "",
          fields.abbr ? normalizeWikiName(fields.abbr) : "",
          origins.zh,
          origins.en,
          origins.abbr,
          Date.now(),
          options.termId,
          options.conceptId,
        ],
      );
      await this.recomputePrimary(options.conceptId);
      await this.syncProjection(options.conceptId);
    });
  }

  /**
   * Remove one term row, with its sources.
   *
   * A concept's last remaining term cannot be removed: a concept with no name
   * is not a record anyone can act on. Delete the concept instead.
   */
  async removeTerm(options: {
    libraryID: number;
    conceptId: number;
    termId: number;
  }): Promise<void> {
    await this.db.executeTransaction(async () => {
      await this.requireConcept(options.conceptId, options.libraryID);
      const remaining = Number(
        await this.db.valueQueryAsync(
          "SELECT COUNT(*) FROM wiki_concept_terms WHERE concept_id = ?",
          [options.conceptId],
        ),
      );
      if (remaining <= 1) {
        throw new Error(
          "A concept must keep at least one term. Delete the concept itself instead.",
        );
      }
      await this.db.queryAsync(
        "DELETE FROM wiki_concept_terms WHERE term_id = ? AND concept_id = ?",
        [options.termId, options.conceptId],
      );
      await this.recomputePrimary(options.conceptId);
      await this.syncProjection(options.conceptId);
    });
  }

  /**
   * Pin one term as primary by hand, and LOCK it there.
   *
   * The lock is the point, not a side effect. Without it the next paper that
   * arrived with a more complete term group would re-elect the primary by
   * completeness and quietly undo the choice, which reads as the panel
   * changing its mind on its own. Only another call here moves it.
   */
  async setPrimaryTerm(options: {
    libraryID: number;
    conceptId: number;
    termId: number;
  }): Promise<void> {
    await this.db.executeTransaction(async () => {
      await this.requireConcept(options.conceptId, options.libraryID);
      const exists = Number(
        await this.db.valueQueryAsync(
          "SELECT COUNT(*) FROM wiki_concept_terms WHERE term_id = ? AND concept_id = ?",
          [options.termId, options.conceptId],
        ),
      );
      if (!exists) throw new Error("That term does not belong to this concept");
      await this.db.queryAsync(
        "UPDATE wiki_concept_terms SET role = 'alias' WHERE concept_id = ?",
        [options.conceptId],
      );
      await this.db.queryAsync(
        "UPDATE wiki_concept_terms SET role = 'primary' WHERE term_id = ?",
        [options.termId],
      );
      await this.db.queryAsync(
        "UPDATE wiki_concepts SET primary_term_locked = 1 WHERE concept_id = ?",
        [options.conceptId],
      );
      await this.syncProjection(options.conceptId);
    });
  }

  /**
   * Hand the primary term back to automatic election.
   *
   * The way out of a pin, so a choice made once is not permanent by accident.
   * Electing immediately rather than at the next write means the panel shows
   * the consequence of unlocking straight away.
   */
  async clearPrimaryLock(options: {
    libraryID: number;
    conceptId: number;
  }): Promise<void> {
    await this.db.executeTransaction(async () => {
      await this.requireConcept(options.conceptId, options.libraryID);
      await this.db.queryAsync(
        "UPDATE wiki_concepts SET primary_term_locked = 0 WHERE concept_id = ?",
        [options.conceptId],
      );
      await this.recomputePrimary(options.conceptId);
      await this.syncProjection(options.conceptId);
    });
  }

  /**
   * Delete a concept outright.
   *
   * Refused while a knowledge page still names it as its primary concept: the
   * page would silently lose its terminology, and deleting the page is a
   * separate, louder decision with its own confirmation.
   */
  async deleteConcept(options: {
    libraryID: number;
    conceptId: number;
  }): Promise<void> {
    await this.db.executeTransaction(async () => {
      await this.requireConcept(options.conceptId, options.libraryID);
      const pages = Number(
        await this.db.valueQueryAsync(
          "SELECT COUNT(*) FROM wiki_pages WHERE primary_concept_id = ? AND status = 'active'",
          [options.conceptId],
        ),
      );
      if (pages) {
        throw new Error(
          "This concept is the primary concept of a knowledge entry. Delete that entry first.",
        );
      }
      await this.db.queryAsync(
        "DELETE FROM wiki_concepts WHERE concept_id = ?",
        [options.conceptId],
      );
    });
  }

  private async requireConcept(
    conceptId: number,
    libraryID: number,
  ): Promise<void> {
    const found = Number(
      await this.db.valueQueryAsync(
        "SELECT COUNT(*) FROM wiki_concepts WHERE concept_id = ? AND library_id = ?",
        [conceptId, libraryID],
      ),
    );
    if (!found) {
      throw new Error(
        `Wiki concept ${conceptId} does not exist in library ${libraryID}`,
      );
    }
  }
}
