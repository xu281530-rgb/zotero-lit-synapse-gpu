import {
  hashWikiText,
  normalizeWikiName,
  normalizeWikiText,
} from "./wikiCanonicalizer";
import { ensureWikiSchema } from "./wikiSchema";
import { mapWikiEvidenceRow } from "./wikiDto";
import { rowColumn as rowValue } from "./wikiRow";
import {
  CLAIM_EMBEDDING_TARGET,
  CONCEPT_EMBEDDING_TARGET,
  WikiEmbeddingQueue,
} from "./wikiEmbeddingQueue";
import {
  CONCEPT_EMBEDDING_COLUMNS,
  conceptEmbeddingTextFromRow,
} from "./wikiConceptEmbedding";
import { cosine, floatVector, vectorBytes } from "./wikiVector";
import { WikiConceptLibrary } from "./wikiConceptLibrary";
import { WikiLinkStore } from "./wikiLinkStore";
import { classifyLegacyName } from "./wikiConceptTerms";
import { WikiReadingSessions } from "./wikiReadingSession";
import {
  WIKI_READ_DEPTHS,
  type WikiClaimRecord,
  type WikiCommitAction,
  type WikiCommitInput,
  type WikiCommitResult,
  type WikiDatabase,
  type WikiEvidenceInput,
  type WikiEvidenceRecord,
  type WikiPageDeletion,
  type WikiPageRecord,
  type WikiSourceClaimRecord,
} from "./wikiTypes";

declare let Zotero: any;
declare let ztoolkit: ZToolkit;
declare let PathUtils: any;

function numberInRange(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

/**
 * How many ids one verification statement may bind.
 *
 * SQLite refuses a statement with more than 32766 bound parameters, and a
 * page's claim count has no ceiling, so the residue checks run in batches.
 */
const ID_BATCH = 500;

const WIKI_PERSISTENT_STATUS_KEYS = [
  "pages",
  "claims",
  "concepts",
  "aliases",
  "conceptTerms",
  "conceptTermSources",
  "relations",
  "evidence",
  "claimEmbeddings",
] as const;

export function countWikiPersistentRows(
  status: Record<string, number | string>,
): number {
  return WIKI_PERSISTENT_STATUS_KEYS.reduce(
    (total, key) => total + (Number(status[key]) || 0),
    0,
  );
}

interface WikiConceptScanRow {
  conceptId: number;
  name: string;
  type: string;
  description: string;
  vector: Float32Array | null;
  model: string;
}

export interface WikiScoredConcept {
  conceptId: number;
  name: string;
  type: string;
  description: string;
  score: number;
}

export interface WikiConceptMatch {
  probe: string;
  matches: (WikiScoredConcept & {
    matchedBy: "name" | "vector";
    /**
     * How many distinct documents are recorded as sources of this concept, and
     * whether the paper being written up is already one of them.
     *
     * Present only when `matchConcepts` was given an itemKey. They exist
     * because "this concept already exists" was being read as "nothing to do
     * here": a concept the model recognises in a second paper needs that paper
     * added as a source, and a duplicate list that does not say whether that
     * happened cannot ask for it. A term sourced from one document can never
     * connect two.
     */
    sourceDocuments?: number;
    sourcedFromThisPaper?: boolean;
  })[];
}

/**
 * What the Wiki looks like from where this paper is standing.
 *
 * Everything here is bounded by the paper, not by the library: the same
 * response comes back for a library of ninety concepts and one of ninety
 * thousand. That is the whole point of computing it - the flat enumeration it
 * replaces grew with the library and stopped fitting in a context window
 * somewhere around two thousand papers, which is a functional failure rather
 * than an expense.
 */
export interface WikiConceptNeighbourhood {
  conceptCount: number;
  /** Concepts still waiting for a vector; recall is partial while non-zero. */
  pendingVectors: number;
  seeds: WikiScoredConcept[];
  /** Nearest by meaning - the ones this paper might be repeating or relating to. */
  neighbours: WikiScoredConcept[];
  /** One relation away from a seed: already asserted to be connected. */
  related: WikiScoredConcept[];
  /**
   * The most-connected concepts in the library.
   *
   * The cheap catch-all for what vector proximity structurally cannot find: a
   * genuine link between two distant fields. A hub is by definition the
   * concept most likely to connect to something new, and there are a dozen of
   * them however large the library gets.
   */
  hubs: (WikiScoredConcept & { degree: number })[];
  relations: string[];
}

export class WikiStore {
  private initialized = false;
  private readonly db: WikiDatabase;

  /**
   * The reading-session ledger and the embedding queue share this store's
   * database and its one schema-initialisation path, so they are exposed from
   * here rather than constructed separately. Reach them through the accessors,
   * which guarantee the schema exists first.
   */
  private readonly sessions: WikiReadingSessions;
  private readonly embeddingQueueStore: WikiEmbeddingQueue;
  private readonly conceptEmbeddingQueueStore: WikiEmbeddingQueue;
  private readonly conceptLibrary: WikiConceptLibrary;
  private readonly linkStore: WikiLinkStore;

  constructor(db: WikiDatabase) {
    this.db = db;
    this.sessions = new WikiReadingSessions(db);
    this.embeddingQueueStore = new WikiEmbeddingQueue(
      db,
      CLAIM_EMBEDDING_TARGET,
    );
    this.conceptEmbeddingQueueStore = new WikiEmbeddingQueue(
      db,
      CONCEPT_EMBEDDING_TARGET,
    );
    this.conceptLibrary = new WikiConceptLibrary(db);
    this.linkStore = new WikiLinkStore(db);
  }

  async readingSessions(): Promise<WikiReadingSessions> {
    await this.initialize();
    return this.sessions;
  }

  /** Cross-paper link candidates, signals and resolutions. Schema-initialised. */
  async links(): Promise<WikiLinkStore> {
    await this.initialize();
    return this.linkStore;
  }

  /** The structured term store. Schema-initialised, like the other two. */
  async concepts(): Promise<WikiConceptLibrary> {
    await this.initialize();
    return this.conceptLibrary;
  }

  async embeddingQueue(): Promise<WikiEmbeddingQueue> {
    await this.initialize();
    return this.embeddingQueueStore;
  }

  async conceptEmbeddingQueue(): Promise<WikiEmbeddingQueue> {
    await this.initialize();
    return this.conceptEmbeddingQueueStore;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await ensureWikiSchema(this.db);
    this.initialized = true;
  }

  private async lastInsertId(): Promise<number> {
    return Number(await this.db.valueQueryAsync("SELECT last_insert_rowid()"));
  }

  private resolveId(
    value: number | string,
    refs: Record<string, number>,
  ): number {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
    const resolved = refs[String(value)];
    if (!resolved) throw new Error(`Unknown Wiki reference: ${String(value)}`);
    return resolved;
  }

  private assignRef(
    ref: string | undefined,
    value: number,
    refs: Record<string, number>,
  ): void {
    if (!ref) return;
    if (refs[ref] !== undefined) {
      throw new Error(`Duplicate Wiki commit ref: ${ref}`);
    }
    refs[ref] = value;
  }

  private async assertConceptNameAvailable(
    libraryID: number,
    conceptId: number,
    displayName: string,
  ): Promise<void> {
    const normalizedName = normalizeWikiName(displayName);
    const collision = await this.db.valueQueryAsync(
      `SELECT concept_id FROM (
         SELECT concept_id FROM wiki_concepts
         WHERE library_id = ? AND normalized_name = ?
         UNION
         SELECT a.concept_id FROM wiki_aliases a
         JOIN wiki_concepts c ON c.concept_id = a.concept_id
         WHERE c.library_id = ? AND a.normalized_alias = ?
       ) WHERE concept_id != ? LIMIT 1`,
      [libraryID, normalizedName, libraryID, normalizedName, conceptId],
    );
    if (collision) {
      throw new Error(
        `Wiki name already resolves to another Concept: ${displayName}`,
      );
    }
  }

  private async requirePage(pageId: number, libraryID: number): Promise<void> {
    const found = Number(
      await this.db.valueQueryAsync(
        "SELECT COUNT(*) FROM wiki_pages WHERE page_id = ? AND library_id = ?",
        [pageId, libraryID],
      ),
    );
    if (found !== 1)
      throw new Error(
        `Wiki page ${pageId} does not exist in library ${libraryID}`,
      );
  }

  private async requireClaim(claimId: number, libraryID: number): Promise<any> {
    const rows = await this.db.queryAsync(
      `SELECT c.* FROM wiki_claims c JOIN wiki_pages p ON p.page_id = c.page_id
       WHERE c.claim_id = ? AND p.library_id = ?`,
      [claimId, libraryID],
    );
    if (!rows[0])
      throw new Error(
        `Wiki claim ${claimId} does not exist in library ${libraryID}`,
      );
    return rows[0];
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
    if (found !== 1) {
      throw new Error(
        `Wiki concept ${conceptId} does not exist in library ${libraryID}`,
      );
    }
  }

  private async createConcept(libraryID: number, input: any): Promise<number> {
    const canonicalName = normalizeWikiText(input.canonicalName);
    if (!canonicalName)
      throw new Error("Concept canonicalName must not be blank");
    const normalized = normalizeWikiName(canonicalName);
    const existing = await this.db.valueQueryAsync(
      "SELECT concept_id FROM wiki_concepts WHERE library_id = ? AND normalized_name = ?",
      [libraryID, normalized],
    );
    const aliasMatch = await this.db.valueQueryAsync(
      `SELECT a.concept_id FROM wiki_aliases a
       JOIN wiki_concepts c ON c.concept_id = a.concept_id
       WHERE c.library_id = ? AND a.normalized_alias = ? LIMIT 1`,
      [libraryID, normalized],
    );
    let conceptId = existing
      ? Number(existing)
      : aliasMatch
        ? Number(aliasMatch)
        : 0;
    if (!conceptId) {
      await this.db.queryAsync(
        `INSERT INTO wiki_concepts
         (library_id, canonical_name, normalized_name, concept_type, description)
         VALUES (?, ?, ?, ?, ?)`,
        [
          libraryID,
          canonicalName,
          normalized,
          normalizeWikiText(input.conceptType || "concept"),
          normalizeWikiText(input.description || ""),
        ],
      );
      conceptId = await this.lastInsertId();
    }
    for (const alias of input.aliases ?? []) {
      const display = normalizeWikiText(alias.alias);
      if (!display) continue;
      const normalizedAlias = normalizeWikiName(display);
      const collision = await this.db.valueQueryAsync(
        `SELECT concept_id FROM (
           SELECT concept_id FROM wiki_concepts
           WHERE library_id = ? AND normalized_name = ?
           UNION
           SELECT a.concept_id FROM wiki_aliases a
           JOIN wiki_concepts c ON c.concept_id = a.concept_id
           WHERE c.library_id = ? AND a.normalized_alias = ?
         ) WHERE concept_id != ? LIMIT 1`,
        [libraryID, normalizedAlias, libraryID, normalizedAlias, conceptId],
      );
      if (collision) {
        throw new Error(
          `Wiki alias already resolves to another Concept: ${display}`,
        );
      }
      await this.db.queryAsync(
        `INSERT OR IGNORE INTO wiki_aliases
         (concept_id, alias, normalized_alias, language, source, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          conceptId,
          display,
          normalizedAlias,
          normalizeWikiName(alias.language || "und"),
          normalizeWikiName(alias.source || "ai"),
          numberInRange(alias.confidence ?? 1, "alias confidence"),
        ],
      );
    }
    // The same names, recorded as structured terms, so a concept created by
    // CREATE_PAGE shows up in the terminology library exactly like one
    // recorded while reading. `ingestFlatNames` rewrites the flat projection
    // from the terms afterwards, so the rows just written above are the input
    // to that pass rather than a second source of truth.
    await this.conceptLibrary.ingestFlatNames(conceptId, [
      { name: canonicalName, source: "ai" },
      ...(input.aliases ?? [])
        .map((alias: any) => ({
          name: normalizeWikiText(alias.alias),
          language: alias.language,
          source: alias.source || "ai",
        }))
        .filter((entry: { name: string }) => entry.name),
    ]);
    // Inside the caller's transaction, so the intent to embed is exactly as
    // durable as the concept - the same guarantee the Claim queue relies on.
    // Also covers the branch where an EXISTING concept was matched and merely
    // gained aliases: its old vector no longer reflects its names.
    await this.enqueueConceptEmbedding(conceptId);
    return conceptId;
  }

  private async attachEvidence(
    claimId: number,
    libraryID: number,
    evidence: WikiEvidenceInput[],
    forceContradiction = false,
  ): Promise<number> {
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new Error(
        "A Claim write must include the Evidence chunks actually used",
      );
    }
    let attached = 0;
    for (const entry of evidence) {
      if (entry.libraryID !== libraryID) {
        throw new Error(
          "Evidence libraryID must match the Wiki commit libraryID",
        );
      }
      if (!entry.itemKey?.trim())
        throw new Error("Evidence itemKey is required");
      if (
        !Number.isInteger(entry.chunkIdSnapshot) ||
        entry.chunkIdSnapshot < 0
      ) {
        throw new Error(
          "Evidence chunkIdSnapshot must be a non-negative integer",
        );
      }
      if (
        !entry.chunkTextHash ||
        !entry.sourceContentHash ||
        !entry.sourceChunkSignature
      ) {
        throw new Error(
          "Evidence must include stable source and chunk fingerprints",
        );
      }
      const excerpt = normalizeWikiText(entry.excerpt);
      if (!excerpt) throw new Error("Evidence excerpt must not be blank");
      const excerptHash = await hashWikiText(excerpt);
      const submittedDepth = WIKI_READ_DEPTHS.indexOf(entry.readDepth);
      const ceilingDepth = entry.readDepthCeiling
        ? WIKI_READ_DEPTHS.indexOf(entry.readDepthCeiling)
        : -1;
      const persistedReadDepth =
        ceilingDepth >= 0 && submittedDepth > ceilingDepth
          ? (entry.readDepthCeiling ?? entry.readDepth)
          : entry.readDepth;
      const before = Number(
        await this.db.valueQueryAsync(
          `SELECT COUNT(*) FROM wiki_evidence
           WHERE claim_id = ? AND library_id = ? AND item_key = ?
             AND excerpt_hash = ? AND evidence_role = ?`,
          [
            claimId,
            libraryID,
            entry.itemKey,
            excerptHash,
            forceContradiction ? "CONTRADICTS" : entry.evidenceRole,
          ],
        ),
      );
      await this.db.queryAsync(
        `INSERT INTO wiki_evidence
         (claim_id, library_id, item_key, chunk_id_snapshot, chunk_text_hash,
          source_content_hash, source_chunk_signature, source_reset_generation,
          excerpt_hash, excerpt, evidence_role, read_depth, link_state,
          created_at, last_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?)
         ON CONFLICT(claim_id, library_id, item_key, excerpt_hash, evidence_role)
         DO UPDATE SET
           chunk_id_snapshot = excluded.chunk_id_snapshot,
           chunk_text_hash = excluded.chunk_text_hash,
           source_content_hash = excluded.source_content_hash,
           source_chunk_signature = excluded.source_chunk_signature,
           source_reset_generation = excluded.source_reset_generation,
           excerpt = excluded.excerpt,
           read_depth = CASE
             -- 1 when the server imposed a depth ceiling on this Evidence,
             -- in which case excluded.read_depth is already clamped and must
             -- win even if that lowers the stored depth. 0 otherwise, leaving
             -- the only-ever-raise rule below in charge.
             --
             -- An explicit 0/1 rather than a nullable flag because Zotero.DB
             -- cannot bind NULL in this position. Its parseQueryAndParams only
             -- recognises a placeholder preceded by '=', ',' or '(', so a
             -- placeholder after WHEN is invisible to it, and a NULL bound to
             -- an invisible placeholder runs its scan off the end and throws
             -- 'Null parameter provided for a query without placeholders'.
             -- See scripts/zotero-db-params.mjs.
             WHEN ? = 1 THEN excluded.read_depth
             WHEN CASE excluded.read_depth
               WHEN 'chunk_local' THEN 0
               WHEN 'section_read' THEN 1
               WHEN 'paper_reviewed' THEN 2
               WHEN 'cross_paper' THEN 3
             END > CASE wiki_evidence.read_depth
               WHEN 'chunk_local' THEN 0
               WHEN 'section_read' THEN 1
               WHEN 'paper_reviewed' THEN 2
               WHEN 'cross_paper' THEN 3
             END
             THEN excluded.read_depth
             ELSE wiki_evidence.read_depth
           END,
           link_state = 'valid',
           last_verified_at = excluded.last_verified_at`,
        [
          claimId,
          libraryID,
          entry.itemKey.trim(),
          entry.chunkIdSnapshot,
          entry.chunkTextHash,
          entry.sourceContentHash,
          entry.sourceChunkSignature,
          entry.sourceResetGeneration || "unknown",
          excerptHash,
          excerpt,
          forceContradiction ? "CONTRADICTS" : entry.evidenceRole,
          persistedReadDepth,
          Date.now(),
          Date.now(),
          entry.readDepthCeiling == null ? 0 : 1,
        ],
      );
      const after = Number(
        await this.db.valueQueryAsync(
          `SELECT COUNT(*) FROM wiki_evidence
           WHERE claim_id = ? AND library_id = ? AND item_key = ?
             AND excerpt_hash = ? AND evidence_role = ?`,
          [
            claimId,
            libraryID,
            entry.itemKey,
            excerptHash,
            forceContradiction ? "CONTRADICTS" : entry.evidenceRole,
          ],
        ),
      );
      attached += Math.max(0, after - before);
    }
    return attached;
  }

  private assertCoverageSupported(
    coverageLevel: string,
    evidence: WikiEvidenceInput[],
  ): void {
    const depthOrder = [
      "chunk_local",
      "section_read",
      "paper_reviewed",
      "cross_paper",
    ];
    const requiredDepth = depthOrder.indexOf(coverageLevel);
    if (requiredDepth < 0) return;
    const submittedDepth = evidence.reduce(
      (best, entry) => Math.max(best, depthOrder.indexOf(entry.readDepth)),
      -1,
    );
    if (submittedDepth < requiredDepth) {
      throw new Error(
        `Claim coverageLevel ${coverageLevel} exceeds submitted Evidence read_depth`,
      );
    }
    if (
      coverageLevel === "cross_paper" &&
      new Set(evidence.map((entry) => `${entry.libraryID}:${entry.itemKey}`))
        .size < 2
    ) {
      throw new Error(
        "cross_paper coverage requires at least 2 distinct itemKey Evidence sources",
      );
    }
  }

  private assertEpistemicStatusSupported(
    epistemicStatus: string,
    evidence: WikiEvidenceInput[],
  ): void {
    if (epistemicStatus !== "supported" && epistemicStatus !== "corroborated") {
      return;
    }
    const supportingSources = new Set(
      evidence
        .filter((entry) => entry.evidenceRole === "SUPPORTS")
        .map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    const requiredSources = epistemicStatus === "corroborated" ? 2 : 1;
    if (supportingSources.size < requiredSources) {
      throw new Error(
        `${epistemicStatus} requires SUPPORTS Evidence from at least ${requiredSources} distinct itemKey source${requiredSources === 1 ? "" : "s"}`,
      );
    }
  }

  private async refreshPageSummary(pageId: number): Promise<void> {
    const [claimRows, evidenceRows, relationRows] = await Promise.all([
      this.db.queryAsync(
        `SELECT claim_text FROM wiki_claims WHERE page_id = ?
       ORDER BY confidence DESC, updated_at DESC, claim_id LIMIT 5`,
        [pageId],
      ),
      this.db.queryAsync(
        `SELECT e.evidence_role, e.read_depth, e.link_state, COUNT(*) AS count
         FROM wiki_evidence e
         JOIN wiki_claims c ON c.claim_id = e.claim_id
         WHERE c.page_id = ?
         GROUP BY e.evidence_role, e.read_depth, e.link_state`,
        [pageId],
      ),
      this.db.queryAsync(
        `SELECT sc.canonical_name AS source_name, r.predicate,
                tc.canonical_name AS target_name
         FROM wiki_pages p
         JOIN wiki_relations r
           ON r.source_concept_id = p.primary_concept_id
           OR r.target_concept_id = p.primary_concept_id
         JOIN wiki_concepts sc ON sc.concept_id = r.source_concept_id
         JOIN wiki_concepts tc ON tc.concept_id = r.target_concept_id
         WHERE p.page_id = ?
         ORDER BY r.confidence DESC, r.relation_id
         LIMIT 5`,
        [pageId],
      ),
    ]);
    const parts = claimRows
      .map((claim) =>
        normalizeWikiText(String(rowValue(claim, "claim_text", "claimText"))),
      )
      .filter(Boolean);
    if (evidenceRows.length) {
      const roleCounts = new Map<string, number>();
      const stateCounts = new Map<string, number>();
      const depthOrder = [
        "chunk_local",
        "section_read",
        "paper_reviewed",
        "cross_paper",
      ];
      let deepest: string | null = null;
      for (const row of evidenceRows) {
        const count = Number(row.count ?? 0);
        const role = String(rowValue(row, "evidence_role", "evidenceRole"));
        const state = String(rowValue(row, "link_state", "linkState"));
        const depth = String(rowValue(row, "read_depth", "readDepth"));
        roleCounts.set(role, (roleCounts.get(role) ?? 0) + count);
        stateCounts.set(state, (stateCounts.get(state) ?? 0) + count);
        if (
          (state === "valid" || state === "source_deleted") &&
          (deepest === null ||
            depthOrder.indexOf(depth) > depthOrder.indexOf(deepest))
        ) {
          deepest = depth;
        }
      }
      const roles = Array.from(roleCounts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([role, count]) => `${count} ${role}`)
        .join(", ");
      const states = Array.from(stateCounts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([state, count]) => `${count} ${state}`)
        .join(", ");
      parts.push(
        `Evidence: ${roles} (${states}; deepest ${deepest ?? "none"}).`,
      );
    }
    if (relationRows.length) {
      const relations = relationRows
        .map(
          (row) =>
            `${String(rowValue(row, "source_name", "sourceName"))} ${String(
              row.predicate,
            )} ${String(rowValue(row, "target_name", "targetName"))}`,
        )
        .join("; ");
      parts.push(`Relations: ${relations}.`);
    }
    const summary = parts.join(" ");
    await this.db.queryAsync(
      `UPDATE wiki_pages SET summary = ?, updated_at = ?, version = version + 1
       WHERE page_id = ?`,
      [summary, Date.now(), pageId],
    );
  }

  private async refreshPagesForEvidence(
    whereSql: string,
    params: unknown[],
  ): Promise<void> {
    const rows = await this.db.queryAsync(
      `SELECT DISTINCT c.page_id
       FROM wiki_evidence e
       JOIN wiki_claims c ON c.claim_id = e.claim_id
       WHERE ${whereSql}`,
      params,
    );
    for (const row of rows) {
      await this.refreshPageSummary(Number(rowValue(row, "page_id", "pageId")));
    }
  }

  private async refreshDerivedForEvidence(
    whereSql: string,
    params: unknown[],
  ): Promise<void> {
    const rows = await this.db.queryAsync(
      `SELECT DISTINCT e.claim_id
       FROM wiki_evidence e
       WHERE ${whereSql}`,
      params,
    );
    for (const row of rows) {
      await this.recomputeClaimStatus(
        Number(rowValue(row, "claim_id", "claimId")),
      );
    }
    await this.refreshPagesForEvidence(whereSql, params);
  }

  async commit(input: WikiCommitInput): Promise<WikiCommitResult> {
    await this.initialize();
    if (!Number.isInteger(input.libraryID) || input.libraryID <= 0) {
      throw new Error("libraryID must be a positive integer");
    }
    if (!input.userInitiated) {
      throw new Error("Wiki auto-write is not authorized for this commit");
    }
    if (!Array.isArray(input.actions) || input.actions.length === 0) {
      throw new Error("Wiki commit requires at least one controlled action");
    }
    const createCount = input.actions.filter(
      (action) => action.action === "CREATE_PAGE",
    ).length;
    if (createCount > 2)
      throw new Error("A Wiki commit may create at most 2 pages");

    const result: WikiCommitResult = {
      createdPages: 0,
      createdClaims: 0,
      reusedClaims: 0,
      attachedEvidence: 0,
      updatedClaims: 0,
      linkedRelations: 0,
      refs: {},
      affectedClaimIds: [],
      actionClaimIds: input.actions.map(() => null),
      actionPageIds: input.actions.map(() => null),
    };
    const affectedPageIds = new Set<number>();
    const evidenceChangedClaimIds = new Set<number>();

    await this.db.executeTransaction(async () => {
      for (let actionIndex = 0; actionIndex < input.actions.length; actionIndex += 1) {
        const action = input.actions[actionIndex];
        if (action.action === "SKIP") continue;
        // Settled by WikiService once the transaction is durable, because the
        // link tables record what a write PRODUCED - and a resolution written
        // inside a transaction that then rolls back would claim a settlement
        // for a Claim that does not exist.
        if (action.action === "DISMISS_LINK_SIGNALS") continue;
        if (
          "ref" in action &&
          action.ref &&
          result.refs[action.ref] !== undefined
        ) {
          throw new Error(`Duplicate Wiki commit ref: ${action.ref}`);
        }
        if (action.action === "CREATE_PAGE") {
          const canonicalTitle = normalizeWikiText(action.canonicalTitle);
          if (!canonicalTitle)
            throw new Error("Wiki page title must not be blank");
          const normalizedTitle = normalizeWikiName(canonicalTitle);
          const exists = Number(
            await this.db.valueQueryAsync(
              "SELECT COUNT(*) FROM wiki_pages WHERE library_id = ? AND normalized_title = ?",
              [input.libraryID, normalizedTitle],
            ),
          );
          if (exists)
            throw new Error(`Wiki page already exists: ${canonicalTitle}`);
          const claimDuplicate = Number(
            await this.db.valueQueryAsync(
              `SELECT COUNT(*) FROM wiki_claims cl
                 JOIN wiki_pages p ON p.page_id = cl.page_id
                WHERE p.library_id = ? AND cl.normalized_claim_text = ?`,
              [input.libraryID, normalizedTitle],
            ),
          );
          if (claimDuplicate) {
            throw new Error(
              `Wiki page title matches an existing Claim: ${canonicalTitle}`,
            );
          }
          // A title that names a concept the library already knows is no
          // longer a collision. Concepts became independent records in 2.4.3,
          // so most of them will never have a page, and refusing every page
          // whose title happens to be a known term would have made the
          // terminology store fight the page store. The page ADOPTS that
          // concept instead - which is what a page about a known term is. The
          // one-page-per-concept rule below still stops fragmentation, and now
          // says so in the message.
          const titledConcept = await this.db.valueQueryAsync(
            `SELECT concept_id FROM (
               SELECT concept_id FROM wiki_concepts
               WHERE library_id = ? AND normalized_name = ?
               UNION
               SELECT a.concept_id FROM wiki_aliases a
               JOIN wiki_concepts c ON c.concept_id = a.concept_id
               WHERE c.library_id = ? AND a.normalized_alias = ?
             ) LIMIT 1`,
            [
              input.libraryID,
              normalizedTitle,
              input.libraryID,
              normalizedTitle,
            ],
          );
          const primaryConceptId = action.primaryConcept
            ? await this.createConcept(input.libraryID, action.primaryConcept)
            : titledConcept
              ? Number(titledConcept)
              : null;
          if (primaryConceptId != null) {
            const existingConceptPage = await this.db.valueQueryAsync(
              `SELECT page_id FROM wiki_pages
               WHERE library_id = ? AND primary_concept_id = ? AND status = 'active'
               LIMIT 1`,
              [input.libraryID, primaryConceptId],
            );
            if (existingConceptPage) {
              throw new Error(
                `Concept already has active Wiki Page ${Number(existingConceptPage)}. ` +
                  `The title "${canonicalTitle}" names a concept that already has a knowledge entry; ` +
                  "add to that entry instead of starting a second one.",
              );
            }
          }
          if (action.primaryConceptRef) {
            if (primaryConceptId == null) {
              throw new Error("primaryConceptRef requires primaryConcept");
            }
            this.assignRef(
              action.primaryConceptRef,
              primaryConceptId,
              result.refs,
            );
          }
          const now = Date.now();
          await this.db.queryAsync(
            `INSERT INTO wiki_pages
             (library_id, canonical_title, normalized_title, summary,
              primary_concept_id, status, created_at, updated_at, version)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 1)`,
            [
              input.libraryID,
              canonicalTitle,
              normalizedTitle,
              "",
              primaryConceptId,
              now,
              now,
            ],
          );
          const pageId = await this.lastInsertId();
          this.assignRef(action.ref, pageId, result.refs);
          result.actionPageIds[actionIndex] = pageId;
          affectedPageIds.add(pageId);
          result.createdPages += 1;
          continue;
        }
        if (action.action === "ADD_CLAIM") {
          const pageId = this.resolveId(action.pageId, result.refs);
          await this.requirePage(pageId, input.libraryID);
          affectedPageIds.add(pageId);
          const claimText = normalizeWikiText(action.claimText);
          if (!claimText) throw new Error("Claim text must not be blank");
          const normalizedClaim = normalizeWikiName(claimText);
          // An equivalent Claim already in the library is two different
          // situations, and they need opposite answers.
          //
          // On ANOTHER Page it is genuine duplication of knowledge, and the
          // Wiki refuses it exactly as before.
          //
          // On THIS Page it is a re-submission, and refusing it breaks the
          // workflow that partial commits exist to support: read part of a
          // paper, commit what you have, read the rest, then submit the paper's
          // claims. That second submission naturally repeats the claims already
          // written, and a hard failure rolled back the whole commit - losing
          // the NEW claims too, and leaving the paper permanently open because
          // the only commit that could close it always failed. So it folds into
          // the existing Claim: no second row, Evidence upserted onto it, and
          // the ref resolves to the Claim that is already there.
          const duplicateRows = await this.db.queryAsync(
            `SELECT c.claim_id, c.page_id FROM wiki_claims c
             JOIN wiki_pages p ON p.page_id = c.page_id
             WHERE p.library_id = ? AND c.normalized_claim_text = ?
             LIMIT 1`,
            [input.libraryID, normalizedClaim],
          );
          if (duplicateRows[0]) {
            const existingClaimId = Number(
              rowValue(duplicateRows[0], "claim_id", "claimId"),
            );
            const existingPageId = Number(
              rowValue(duplicateRows[0], "page_id", "pageId"),
            );
            if (existingPageId !== pageId) {
              throw new Error(
                "An equivalent Claim already exists in this Wiki library",
              );
            }
            numberInRange(action.confidence, "claim confidence");
            this.assertCoverageSupported(action.coverageLevel, action.evidence);
            this.assertEpistemicStatusSupported(
              action.epistemicStatus,
              action.evidence,
            );
            this.assignRef(action.ref, existingClaimId, result.refs);
            result.actionClaimIds[actionIndex] = existingClaimId;
            result.reusedClaims += 1;
            result.attachedEvidence += await this.attachEvidence(
              existingClaimId,
              input.libraryID,
              action.evidence,
            );
            if (action.evidence.length) {
              evidenceChangedClaimIds.add(existingClaimId);
            }
            if (!result.affectedClaimIds.includes(existingClaimId)) {
              result.affectedClaimIds.push(existingClaimId);
            }
            continue;
          }
          numberInRange(action.confidence, "claim confidence");
          this.assertCoverageSupported(action.coverageLevel, action.evidence);
          this.assertEpistemicStatusSupported(
            action.epistemicStatus,
            action.evidence,
          );
          const now = Date.now();
          await this.db.queryAsync(
            `INSERT INTO wiki_claims
             (page_id, claim_text, normalized_claim_text, claim_type,
              epistemic_status, coverage_level, confidence, created_at,
              updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
              pageId,
              claimText,
              normalizedClaim,
              action.claimType,
              action.epistemicStatus,
              action.coverageLevel,
              action.confidence,
              now,
              now,
            ],
          );
          const claimId = await this.lastInsertId();
          this.assignRef(action.ref, claimId, result.refs);
          result.actionClaimIds[actionIndex] = claimId;
          result.createdClaims += 1;
          result.affectedClaimIds.push(claimId);
          result.attachedEvidence += await this.attachEvidence(
            claimId,
            input.libraryID,
            action.evidence,
          );
          if (action.evidence.length) evidenceChangedClaimIds.add(claimId);
          if (!result.affectedClaimIds.includes(claimId)) {
            result.affectedClaimIds.push(claimId);
          }
          continue;
        }
        if (
          action.action === "ATTACH_EVIDENCE" ||
          action.action === "MARK_CONFLICT"
        ) {
          const claimId = this.resolveId(action.claimId, result.refs);
          const existing = await this.requireClaim(claimId, input.libraryID);
          affectedPageIds.add(Number(rowValue(existing, "page_id", "pageId")));
          result.attachedEvidence += await this.attachEvidence(
            claimId,
            input.libraryID,
            action.evidence,
            action.action === "MARK_CONFLICT",
          );
          if (action.evidence.length) evidenceChangedClaimIds.add(claimId);
          if (action.action === "MARK_CONFLICT") {
            await this.db.queryAsync(
              "UPDATE wiki_claims SET epistemic_status = 'disputed', updated_at = ?, version = version + 1 WHERE claim_id = ?",
              [Date.now(), claimId],
            );
            result.updatedClaims += 1;
          }
          continue;
        }
        if (action.action === "UPDATE_CLAIM") {
          const claimId = this.resolveId(action.claimId, result.refs);
          const existing = await this.requireClaim(claimId, input.libraryID);
          affectedPageIds.add(Number(rowValue(existing, "page_id", "pageId")));
          const currentVersion = Number(
            rowValue(existing, "version", "version"),
          );
          if (currentVersion !== action.expectedVersion) {
            throw new Error(`Wiki claim ${claimId} version conflict`);
          }
          const claimText = normalizeWikiText(
            action.claimText ?? rowValue(existing, "claim_text", "claimText"),
          );
          const knowledgeTextChanged =
            normalizeWikiName(claimText) !==
            String(
              rowValue(
                existing,
                "normalized_claim_text",
                "normalizedClaimText",
              ),
            );
          const knowledgeSemanticsChanged =
            knowledgeTextChanged ||
            (action.claimType !== undefined &&
              action.claimType !==
                rowValue(existing, "claim_type", "claimType"));
          const confidence = action.confidence ?? Number(existing.confidence);
          numberInRange(confidence, "claim confidence");
          const currentCoverage = String(
            rowValue(existing, "coverage_level", "coverageLevel"),
          );
          const nextCoverage = action.coverageLevel ?? currentCoverage;
          const depthOrder = [
            "chunk_local",
            "section_read",
            "paper_reviewed",
            "cross_paper",
          ];
          const currentDepth = depthOrder.indexOf(currentCoverage);
          const nextDepth = depthOrder.indexOf(nextCoverage);
          const coveragePromoted =
            nextDepth >= 0 && (currentDepth < 0 || nextDepth > currentDepth);
          const statusOrder: Record<string, number> = {
            unsupported: -1,
            provisional: 0,
            disputed: 0,
            supported: 1,
            corroborated: 2,
          };
          const currentStatus = String(
            rowValue(existing, "epistemic_status", "epistemicStatus"),
          );
          const nextStatus = action.epistemicStatus ?? currentStatus;
          const statusPromoted =
            (statusOrder[nextStatus] ?? 0) > (statusOrder[currentStatus] ?? 0);
          if (
            (knowledgeSemanticsChanged || coveragePromoted || statusPromoted) &&
            !action.evidence?.length
          ) {
            if (knowledgeSemanticsChanged) {
              throw new Error(
                "Changing Claim knowledge text requires the Evidence used for the new content",
              );
            }
            throw new Error(
              "Claim coverage or epistemic promotion requires the Evidence used for this promotion",
            );
          }
          if (coveragePromoted) {
            this.assertCoverageSupported(nextCoverage, action.evidence ?? []);
          }
          if (statusPromoted) {
            this.assertEpistemicStatusSupported(
              nextStatus,
              action.evidence ?? [],
            );
          }
          const duplicate = Number(
            await this.db.valueQueryAsync(
              `SELECT COUNT(*) FROM wiki_claims c
               JOIN wiki_pages p ON p.page_id = c.page_id
               WHERE p.library_id = ? AND c.normalized_claim_text = ?
                 AND c.claim_id != ?`,
              [input.libraryID, normalizeWikiName(claimText), claimId],
            ),
          );
          if (duplicate) {
            throw new Error(
              "UPDATE_CLAIM would duplicate an existing Wiki Claim",
            );
          }
          await this.db.queryAsync(
            `UPDATE wiki_claims SET claim_text = ?, normalized_claim_text = ?,
             claim_type = ?, epistemic_status = ?, coverage_level = ?,
             confidence = ?, updated_at = ?, version = version + 1
             WHERE claim_id = ? AND version = ?`,
            [
              claimText,
              normalizeWikiName(claimText),
              action.claimType ?? rowValue(existing, "claim_type", "claimType"),
              action.epistemicStatus ??
                rowValue(existing, "epistemic_status", "epistemicStatus"),
              action.coverageLevel ??
                rowValue(existing, "coverage_level", "coverageLevel"),
              confidence,
              Date.now(),
              claimId,
              action.expectedVersion,
            ],
          );
          result.updatedClaims += 1;
          if (!result.affectedClaimIds.includes(claimId)) {
            result.affectedClaimIds.push(claimId);
          }
          if (action.evidence?.length) {
            result.attachedEvidence += await this.attachEvidence(
              claimId,
              input.libraryID,
              action.evidence,
            );
            evidenceChangedClaimIds.add(claimId);
          }
          continue;
        }
        if (action.action === "LINK_RELATION") {
          const source = this.resolveId(action.sourceConceptId, result.refs);
          const target = this.resolveId(action.targetConceptId, result.refs);
          if (source === target)
            throw new Error("A Wiki relation cannot link a concept to itself");
          await this.requireConcept(source, input.libraryID);
          await this.requireConcept(target, input.libraryID);
          numberInRange(action.confidence, "relation confidence");
          const predicate = normalizeWikiText(action.predicate);
          if (!predicate)
            throw new Error("Wiki relation predicate must not be blank");
          await this.db.queryAsync(
            `INSERT INTO wiki_relations
             (source_concept_id, predicate, normalized_predicate,
              target_concept_id, confidence, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_concept_id, normalized_predicate, target_concept_id)
             DO UPDATE SET confidence = MAX(confidence, excluded.confidence)`,
            [
              source,
              predicate,
              normalizeWikiName(predicate),
              target,
              action.confidence,
              Date.now(),
            ],
          );
          result.linkedRelations += 1;
          const relationPages = await this.db.queryAsync(
            `SELECT page_id FROM wiki_pages
             WHERE library_id = ? AND primary_concept_id IN (?, ?)`,
            [input.libraryID, source, target],
          );
          for (const row of relationPages) {
            affectedPageIds.add(Number(rowValue(row, "page_id", "pageId")));
          }
        }
      }

      for (const claimId of evidenceChangedClaimIds) {
        await this.recomputeClaimStatus(claimId);
      }
      for (const pageId of affectedPageIds) {
        await this.refreshPageSummary(pageId);
      }

      // Queue the derived vectors INSIDE the transaction. The intent to embed
      // then commits atomically with the claim it describes, so there is no
      // window in which a claim exists but nothing remembers it needs a
      // vector - which is what used to make an embedding outage a permanent,
      // invisible hole in Wiki retrieval.
      for (const claimId of result.affectedClaimIds) {
        const claim = await this.db.queryAsync(
          "SELECT claim_text FROM wiki_claims WHERE claim_id = ?",
          [claimId],
        );
        if (!claim[0]) continue;
        await this.embeddingQueueStore.enqueue(
          claimId,
          String(rowValue(claim[0], "claim_text", "claimText")),
        );
      }
    });
    return result;
  }

  private mapEvidence(row: any): WikiEvidenceRecord {
    return mapWikiEvidenceRow(row);
  }

  async getClaim(claimId: number): Promise<WikiClaimRecord | null> {
    await this.initialize();
    const rows = await this.db.queryAsync(
      "SELECT * FROM wiki_claims WHERE claim_id = ?",
      [claimId],
    );
    const row = rows[0];
    if (!row) return null;
    const evidenceRows = await this.db.queryAsync(
      "SELECT * FROM wiki_evidence WHERE claim_id = ? ORDER BY evidence_id",
      [claimId],
    );
    return {
      claimId: Number(rowValue(row, "claim_id", "claimId")),
      pageId: Number(rowValue(row, "page_id", "pageId")),
      claimText: String(rowValue(row, "claim_text", "claimText")),
      claimType: rowValue(row, "claim_type", "claimType"),
      epistemicStatus: rowValue(row, "epistemic_status", "epistemicStatus"),
      coverageLevel: rowValue(row, "coverage_level", "coverageLevel"),
      confidence: Number(row.confidence),
      createdAt: Number(rowValue(row, "created_at", "createdAt")),
      updatedAt: Number(rowValue(row, "updated_at", "updatedAt")),
      version: Number(row.version),
      evidence: evidenceRows.map((item) => this.mapEvidence(item)),
    };
  }

  /** Every Claim whose Evidence cites one paper, independent of query text. */
  async listClaimsByEvidenceSource(
    libraryID: number,
    itemKey: string,
  ): Promise<WikiSourceClaimRecord[]> {
    await this.initialize();
    const rows = await this.db.queryAsync(
      `SELECT DISTINCT c.claim_id, p.canonical_title
       FROM wiki_evidence e
       JOIN wiki_claims c ON c.claim_id = e.claim_id
       JOIN wiki_pages p ON p.page_id = c.page_id
       WHERE e.library_id = ? AND e.item_key = ? AND p.library_id = ?
       ORDER BY c.claim_id`,
      [libraryID, itemKey, libraryID],
    );
    const claims: WikiSourceClaimRecord[] = [];
    for (const row of rows) {
      const claim = await this.getClaim(
        Number(rowValue(row, "claim_id", "claimId")),
      );
      if (!claim) continue;
      claims.push({
        ...claim,
        pageTitle: String(
          rowValue(row, "canonical_title", "canonicalTitle") ?? "",
        ),
      });
    }
    return claims;
  }

  async getPage(pageId: number): Promise<WikiPageRecord | null> {
    await this.initialize();
    const rows = await this.db.queryAsync(
      "SELECT * FROM wiki_pages WHERE page_id = ?",
      [pageId],
    );
    const row = rows[0];
    if (!row) return null;
    const claimRows = await this.db.queryAsync(
      "SELECT claim_id FROM wiki_claims WHERE page_id = ? ORDER BY claim_id",
      [pageId],
    );
    const claims: WikiClaimRecord[] = [];
    for (const claimRow of claimRows) {
      const claim = await this.getClaim(
        Number(rowValue(claimRow, "claim_id", "claimId")),
      );
      if (claim) claims.push(claim);
    }
    return {
      pageId: Number(rowValue(row, "page_id", "pageId")),
      libraryID: Number(rowValue(row, "library_id", "libraryID")),
      canonicalTitle: String(
        rowValue(row, "canonical_title", "canonicalTitle"),
      ),
      summary: String(row.summary ?? ""),
      primaryConceptId:
        rowValue(row, "primary_concept_id", "primaryConceptId") == null
          ? null
          : Number(rowValue(row, "primary_concept_id", "primaryConceptId")),
      status: String(row.status),
      createdAt: Number(rowValue(row, "created_at", "createdAt")),
      updatedAt: Number(rowValue(row, "updated_at", "updatedAt")),
      version: Number(row.version),
      claims,
    };
  }

  async prepareUpdate(options: {
    libraryID: number;
    query: string;
    limit?: number;
  }): Promise<{
    pages: Array<{ pageId: number; canonicalTitle: string; score: number }>;
    concepts: Array<{
      conceptId: number;
      canonicalName: string;
      aliases: string[];
      score: number;
    }>;
    claims: Array<{
      claimId: number;
      pageId: number;
      claimText: string;
      score: number;
    }>;
  }> {
    await this.initialize();
    const query = normalizeWikiName(options.query);
    if (!query) throw new Error("Wiki prepare query must not be blank");
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
    const score = (value: string): number => {
      const normalized = normalizeWikiName(value);
      if (normalized === query) return 1;
      if (normalized.includes(query) || query.includes(normalized)) return 0.9;
      const terms = query
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length > 1);
      if (!terms.length) return 0;
      return (
        terms.filter((term) => normalized.includes(term)).length / terms.length
      );
    };
    const pageRows = await this.db.queryAsync(
      "SELECT page_id, canonical_title, primary_concept_id FROM wiki_pages WHERE library_id = ? AND status = 'active'",
      [options.libraryID],
    );
    const conceptRows = await this.db.queryAsync(
      `SELECT c.concept_id, c.canonical_name, a.alias
       FROM wiki_concepts c LEFT JOIN wiki_aliases a ON a.concept_id = c.concept_id
       WHERE c.library_id = ?`,
      [options.libraryID],
    );
    const claimRows = await this.db.queryAsync(
      `SELECT c.claim_id, c.page_id, c.claim_text
       FROM wiki_claims c JOIN wiki_pages p ON p.page_id = c.page_id
       WHERE p.library_id = ? AND p.status = 'active'`,
      [options.libraryID],
    );
    const concepts = new Map<
      number,
      { conceptId: number; canonicalName: string; aliases: string[] }
    >();
    for (const row of conceptRows) {
      const conceptId = Number(rowValue(row, "concept_id", "conceptId"));
      const entry = concepts.get(conceptId) ?? {
        conceptId,
        canonicalName: String(rowValue(row, "canonical_name", "canonicalName")),
        aliases: [],
      };
      if (row.alias) entry.aliases.push(String(row.alias));
      concepts.set(conceptId, entry);
    }
    return {
      pages: pageRows
        .map((row) => {
          const concept = concepts.get(
            Number(rowValue(row, "primary_concept_id", "primaryConceptId")),
          );
          return {
            pageId: Number(rowValue(row, "page_id", "pageId")),
            canonicalTitle: String(
              rowValue(row, "canonical_title", "canonicalTitle"),
            ),
            score: Math.max(
              score(String(rowValue(row, "canonical_title", "canonicalTitle"))),
              concept ? score(concept.canonicalName) : 0,
              ...(concept?.aliases ?? []).map(score),
            ),
          };
        })
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || a.pageId - b.pageId)
        .slice(0, limit),
      concepts: Array.from(concepts.values())
        .map((entry) => ({
          ...entry,
          score: Math.max(
            score(entry.canonicalName),
            ...entry.aliases.map(score),
          ),
        }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || a.conceptId - b.conceptId)
        .slice(0, limit),
      claims: claimRows
        .map((row) => ({
          claimId: Number(rowValue(row, "claim_id", "claimId")),
          pageId: Number(rowValue(row, "page_id", "pageId")),
          claimText: String(rowValue(row, "claim_text", "claimText")),
          score: score(String(rowValue(row, "claim_text", "claimText"))),
        }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || a.claimId - b.claimId)
        .slice(0, limit),
    };
  }

  async getRetrievalSnapshot(libraryID: number): Promise<{
    pages: any[];
    claims: any[];
    concepts: any[];
    aliases: any[];
    relations: any[];
    evidence: any[];
    embeddings: any[];
  }> {
    await this.initialize();
    const pages = await this.db.queryAsync(
      "SELECT * FROM wiki_pages WHERE library_id = ? AND status = 'active'",
      [libraryID],
    );
    const claims = await this.db.queryAsync(
      `SELECT c.* FROM wiki_claims c JOIN wiki_pages p ON p.page_id = c.page_id
       WHERE p.library_id = ? AND p.status = 'active'`,
      [libraryID],
    );
    const concepts = await this.db.queryAsync(
      "SELECT * FROM wiki_concepts WHERE library_id = ?",
      [libraryID],
    );
    const aliases = await this.db.queryAsync(
      `SELECT a.* FROM wiki_aliases a JOIN wiki_concepts c ON c.concept_id = a.concept_id
       WHERE c.library_id = ?`,
      [libraryID],
    );
    const relations = await this.db.queryAsync(
      `SELECT r.* FROM wiki_relations r
       JOIN wiki_concepts s ON s.concept_id = r.source_concept_id
       JOIN wiki_concepts t ON t.concept_id = r.target_concept_id
       WHERE s.library_id = ? AND t.library_id = ?`,
      [libraryID, libraryID],
    );
    const evidence = await this.db.queryAsync(
      `SELECT e.* FROM wiki_evidence e JOIN wiki_claims c ON c.claim_id = e.claim_id
       JOIN wiki_pages p ON p.page_id = c.page_id WHERE p.library_id = ?`,
      [libraryID],
    );
    const embeddings = await this.db.queryAsync(
      `SELECT ce.* FROM wiki_claim_embeddings ce
       JOIN wiki_claims c ON c.claim_id = ce.claim_id
       JOIN wiki_pages p ON p.page_id = c.page_id WHERE p.library_id = ?`,
      [libraryID],
    );
    return {
      pages,
      claims,
      concepts,
      aliases,
      relations,
      evidence,
      embeddings,
    };
  }

  async saveClaimEmbedding(options: {
    claimId: number;
    vector: Float32Array;
    model: string;
    textHash: string;
  }): Promise<void> {
    await this.initialize();
    const claims = await this.db.queryAsync(
      "SELECT claim_text FROM wiki_claims WHERE claim_id = ?",
      [options.claimId],
    );
    if (!claims[0]) throw new Error(`Wiki claim ${options.claimId} not found`);
    const expectedTextHash = await hashWikiText(
      String(rowValue(claims[0], "claim_text", "claimText")),
    );
    if (options.textHash !== expectedTextHash) {
      throw new Error(
        `Claim Embedding text_hash does not match Claim ${options.claimId}`,
      );
    }
    const identities = await this.db.queryAsync(
      "SELECT DISTINCT model, dimensions FROM wiki_claim_embeddings",
    );
    for (const identity of identities) {
      if (
        String(identity.model) !== options.model ||
        Number(identity.dimensions) !== options.vector.length
      ) {
        throw new Error(
          "Wiki Claim Embeddings already use a different model or dimensions; clear Wiki data before changing the embedding space",
        );
      }
    }
    const bytes = new Uint8Array(
      options.vector.buffer,
      options.vector.byteOffset,
      options.vector.byteLength,
    );
    await this.db.queryAsync(
      `INSERT INTO wiki_claim_embeddings
       (claim_id, embedding, dimensions, model, text_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(claim_id) DO UPDATE SET embedding = excluded.embedding,
       dimensions = excluded.dimensions, model = excluded.model,
       text_hash = excluded.text_hash, updated_at = excluded.updated_at`,
      [
        options.claimId,
        bytes,
        options.vector.length,
        options.model,
        options.textHash,
        Date.now(),
      ],
    );
  }

  async getStatus(
    libraryID?: number,
  ): Promise<Record<string, number | string>> {
    await this.initialize();
    const pageWhere = libraryID === undefined ? "" : " WHERE library_id = ?";
    const pageParams = libraryID === undefined ? [] : [libraryID];
    const claimWhere =
      libraryID === undefined
        ? ""
        : " JOIN wiki_pages p ON p.page_id = c.page_id WHERE p.library_id = ?";
    const claimParams = pageParams;
    return {
      database: "zotero-mcp-wiki.sqlite",
      pages: Number(
        await this.db.valueQueryAsync(
          `SELECT COUNT(*) FROM wiki_pages${pageWhere}`,
          pageParams,
        ),
      ),
      claims: Number(
        await this.db.valueQueryAsync(
          `SELECT COUNT(*) FROM wiki_claims c${claimWhere}`,
          claimParams,
        ),
      ),
      concepts: Number(
        await this.db.valueQueryAsync(
          `SELECT COUNT(*) FROM wiki_concepts${pageWhere}`,
          pageParams,
        ),
      ),
      aliases: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_aliases"
            : `SELECT COUNT(*) FROM wiki_aliases a JOIN wiki_concepts c ON c.concept_id = a.concept_id
               WHERE c.library_id = ?`,
          pageParams,
        ),
      ),
      conceptTerms: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_concept_terms"
            : `SELECT COUNT(*) FROM wiki_concept_terms t JOIN wiki_concepts c ON c.concept_id = t.concept_id
               WHERE c.library_id = ?`,
          pageParams,
        ),
      ),
      conceptTermSources: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_concept_term_sources"
            : `SELECT COUNT(*) FROM wiki_concept_term_sources s
               JOIN wiki_concept_terms t ON t.term_id = s.term_id
               JOIN wiki_concepts c ON c.concept_id = t.concept_id
               WHERE c.library_id = ?`,
          pageParams,
        ),
      ),
      relations: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_relations"
            : `SELECT COUNT(*) FROM wiki_relations r JOIN wiki_concepts c ON c.concept_id = r.source_concept_id
               WHERE c.library_id = ?`,
          pageParams,
        ),
      ),
      evidence: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_evidence"
            : `SELECT COUNT(*) FROM wiki_evidence e JOIN wiki_claims c ON c.claim_id = e.claim_id
               JOIN wiki_pages p ON p.page_id = c.page_id WHERE p.library_id = ?`,
          pageParams,
        ),
      ),
      claimEmbeddings: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_claim_embeddings"
            : `SELECT COUNT(*) FROM wiki_claim_embeddings ce JOIN wiki_claims c ON c.claim_id = ce.claim_id
               JOIN wiki_pages p ON p.page_id = c.page_id WHERE p.library_id = ?`,
          pageParams,
        ),
      ),
      /*
       * Reported, but deliberately NOT in WIKI_PERSISTENT_STATUS_KEYS. Those
       * keys count what a reset destroys and what the user would lose; a
       * concept vector is derived from the concept and is rebuilt from it, so
       * counting it would inflate "rows deleted" with rows nobody wrote. It is
       * reported because the gap between the two numbers below is exactly how
       * incomplete concept recall currently is.
       */
      conceptEmbeddings: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_concept_embeddings"
            : `SELECT COUNT(*) FROM wiki_concept_embeddings ce
               JOIN wiki_concepts c ON c.concept_id = ce.concept_id
               WHERE c.library_id = ?`,
          pageParams,
        ),
      ),
      pendingConceptEmbeddings: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_concept_embedding_queue"
            : `SELECT COUNT(*) FROM wiki_concept_embedding_queue q
               JOIN wiki_concepts c ON c.concept_id = q.concept_id
               WHERE c.library_id = ?`,
          pageParams,
        ),
      ),
      pendingRelink: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_evidence WHERE link_state = 'pending_relink'"
            : "SELECT COUNT(*) FROM wiki_evidence WHERE library_id = ? AND link_state = 'pending_relink'",
          pageParams,
        ),
      ),
      validEvidence: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_evidence WHERE link_state = 'valid'"
            : "SELECT COUNT(*) FROM wiki_evidence WHERE library_id = ? AND link_state = 'valid'",
          pageParams,
        ),
      ),
      staleEvidence: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_evidence WHERE link_state = 'stale'"
            : "SELECT COUNT(*) FROM wiki_evidence WHERE library_id = ? AND link_state = 'stale'",
          pageParams,
        ),
      ),
      deletedSources: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_evidence WHERE link_state = 'source_deleted'"
            : "SELECT COUNT(*) FROM wiki_evidence WHERE library_id = ? AND link_state = 'source_deleted'",
          pageParams,
        ),
      ),
      /*
       * Whether concepts are CONNECTING anything, which the three counts above
       * them cannot say.
       *
       * `concepts` and `conceptTermSources` both grow when a paper founds
       * twenty terms of its own and connects to nothing - the observed state
       * this work exists to fix was 20 concepts against 20 sources, one
       * apiece. These three move only when a term reaches a second document:
       *
       *   conceptsWithMultipleSources - concepts behind 2+ documents; the
       *     numerator of "is the concept library load-bearing yet".
       *   conceptSourceDocumentPairs  - distinct document pairs any concept
       *     connects; the shared-concept edges before rarity weighting.
       *   conceptSourceOnlyWrites     - source rows written by the attach
       *     path. Zero while a reader stages terminology it never submits.
       */
      ...(await this.conceptConnectionStats(libraryID)),
    };
  }

  /** The three "are concepts connecting papers yet" counts. See getStatus. */
  private async conceptConnectionStats(libraryID?: number): Promise<{
    conceptsWithMultipleSources: number;
    conceptSourceDocumentPairs: number;
    conceptSourceOnlyWrites: number;
  }> {
    const scope =
      libraryID === undefined ? "" : " AND c.library_id = ? AND s.library_id = ?";
    const params = libraryID === undefined ? [] : [libraryID, libraryID];
    const rows = await this.db.queryAsync(
      `SELECT t.concept_id AS concept_id, s.item_key AS item_key
         FROM wiki_concept_term_sources s
         JOIN wiki_concept_terms t ON t.term_id = s.term_id
         JOIN wiki_concepts c ON c.concept_id = t.concept_id
        WHERE 1 = 1${scope}
        GROUP BY t.concept_id, s.item_key`,
      params,
    );
    const byConcept = new Map<number, string[]>();
    for (const row of rows) {
      const conceptId = Number(rowValue(row, "concept_id", "conceptId"));
      const itemKey = String(rowValue(row, "item_key", "itemKey") ?? "");
      if (!itemKey) continue;
      (byConcept.get(conceptId) ?? byConcept.set(conceptId, []).get(conceptId)!)
        .push(itemKey);
    }
    const pairs = new Set<string>();
    let multiple = 0;
    for (const itemKeys of byConcept.values()) {
      if (itemKeys.length < 2) continue;
      multiple += 1;
      const ordered = itemKeys.slice().sort();
      for (let left = 0; left < ordered.length; left += 1) {
        for (let right = left + 1; right < ordered.length; right += 1) {
          pairs.add(`${ordered[left]} ${ordered[right]}`);
        }
      }
    }
    return {
      conceptsWithMultipleSources: multiple,
      conceptSourceDocumentPairs: pairs.size,
      conceptSourceOnlyWrites: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_concept_term_sources WHERE write_path = 'attach'"
            : `SELECT COUNT(*) FROM wiki_concept_term_sources s
                 JOIN wiki_concept_terms t ON t.term_id = s.term_id
                 JOIN wiki_concepts c ON c.concept_id = t.concept_id
                WHERE s.write_path = 'attach' AND c.library_id = ?`,
          libraryID === undefined ? [] : [libraryID],
        ),
      ),
    };
  }

  async clearAll(): Promise<{ deletedRows: number }> {
    const before = await this.getStatus();
    const deletedRows = countWikiPersistentRows(before);
    await this.db.executeTransaction(async () => {
      for (const table of [
        // The link layer first: its rows reference nothing outside itself, but
        // every one of them DESCRIBES a pair of papers, and leaving candidates
        // behind after a reset would leave the graph drawing edges between
        // documents the Wiki no longer knows anything about.
        ...WikiLinkStore.TABLES,
        "wiki_claim_embeddings",
        "wiki_concept_embeddings",
        "wiki_concept_embedding_queue",
        "wiki_evidence",
        "wiki_relations",
        "wiki_concept_term_sources",
        "wiki_concept_terms",
        "wiki_aliases",
        "wiki_claims",
        "wiki_pages",
        "wiki_concepts",
      ]) {
        await this.db.queryAsync(`DELETE FROM ${table}`);
      }
    });
    const after = await this.getStatus();
    const remaining = countWikiPersistentRows(after);
    if (remaining !== 0) {
      throw new Error(`Wiki data reset left ${remaining} persistent rows`);
    }
    return { deletedRows };
  }

  /**
   * Every relation in the library, named rather than numbered.
   *
   * The skeleton handed to a write-up has to be readable without a second
   * lookup: `挤压铸造 --suppresses--> 非平衡共晶相` says what the Wiki already
   * believes, where `76 -> 79` says only that it believes something.
   */
  async listRelationNames(
    libraryID: number,
  ): Promise<{ source: string; predicate: string; target: string }[]> {
    await this.initialize();
    const rows = await this.db.queryAsync(
      `SELECT s.canonical_name AS source, r.predicate AS predicate,
              t.canonical_name AS target
         FROM wiki_relations r
         JOIN wiki_concepts s ON s.concept_id = r.source_concept_id
         JOIN wiki_concepts t ON t.concept_id = r.target_concept_id
        WHERE s.library_id = ? AND t.library_id = ?
        ORDER BY s.canonical_name, r.predicate`,
      [libraryID, libraryID],
    );
    return rows.map((row: any) => ({
      source: String(rowValue(row, "source", "source") ?? ""),
      predicate: String(rowValue(row, "predicate", "predicate") ?? ""),
      target: String(rowValue(row, "target", "target") ?? ""),
    }));
  }

  /** Queue one concept for a vector, using its text as it stands now. */
  private async enqueueConceptEmbedding(conceptId: number): Promise<void> {
    const rows = await this.db.queryAsync(
      `SELECT ${CONCEPT_EMBEDDING_COLUMNS}
         FROM wiki_concepts c WHERE c.concept_id = ?`,
      [conceptId],
    );
    if (!rows?.[0]) return;
    const text = conceptEmbeddingTextFromRow(rows[0]);
    if (!text) return;
    await this.conceptEmbeddingQueueStore.enqueue(conceptId, text);
  }

  async saveConceptEmbedding(options: {
    conceptId: number;
    vector: Float32Array;
    model: string;
    textHash: string;
  }): Promise<void> {
    await this.initialize();
    /*
     * A vector from another embedding space is DISCARDED, not refused.
     *
     * The Claim version of this throws, and has to: a Claim embedding is
     * expensive to rebuild and the user is told to clear the Wiki deliberately.
     * A concept vector is derived from the concept and costs one API call, so
     * refusing here buys nothing and costs everything - it is what turned one
     * mis-stamped row into a permanent wall. That row said
     * `text-embedding-3-small`; every one of the other 118 concepts was then
     * rejected as foreign, exhausted its retries, and the neighbourhood recall
     * this table exists for was blind for an entire 30-paper run while the
     * Wiki reported itself healthy.
     *
     * So the incoming vector wins and the stale space is cleared and re-queued.
     * Changing the embedding model becomes a supported operation for concepts
     * rather than a silent, unrecoverable one.
     */
    const foreign = await this.db.queryAsync(
      `SELECT concept_id FROM wiki_concept_embeddings
        WHERE model != ? OR dimensions != ?`,
      [options.model, options.vector.length],
    );
    for (const row of foreign ?? []) {
      const conceptId = Number(rowValue(row, "concept_id", "conceptId"));
      await this.db.queryAsync(
        "DELETE FROM wiki_concept_embeddings WHERE concept_id = ?",
        [conceptId],
      );
      if (conceptId !== options.conceptId) {
        await this.enqueueConceptEmbedding(conceptId);
      }
    }
    if (foreign?.length) {
      ztoolkit.log(
        `[WikiStore] ${foreign.length} concept vector(s) were built in a ` +
          `different embedding space and have been re-queued for ${options.model}`,
      );
    }
    await this.db.queryAsync(
      `INSERT INTO wiki_concept_embeddings
       (concept_id, embedding, dimensions, model, text_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(concept_id) DO UPDATE SET embedding = excluded.embedding,
       dimensions = excluded.dimensions, model = excluded.model,
       text_hash = excluded.text_hash, updated_at = excluded.updated_at`,
      [
        options.conceptId,
        vectorBytes(options.vector),
        options.vector.length,
        options.model,
        options.textHash,
        Date.now(),
      ],
    );
  }

  /**
   * Re-queue concepts whose stored vector no longer matches their text.
   *
   * A concept's text changes from more places than a Claim's ever does - a
   * rename, an alias added while reading, a description rewritten in the terms
   * UI, a legacy term completed by hand - and an enqueue call planted in each
   * of those paths is a list that will be incomplete the first time someone
   * adds a fifth. This compares hashes instead, so a stale vector is found by
   * what it IS rather than by having been reported.
   *
   * Two exclusions, both for the same reason - an enqueue RESETS the backoff,
   * so re-enqueuing a row that is already owed is not idempotent, it erases
   * the record of how many times the backend has already refused it, and a
   * permanently failing concept would never reach "exhausted" and never be
   * reported:
   *
   *   - a concept with NO vector is already queued by the schema backfill;
   *   - a concept already sitting in the queue has already been noticed.
   *
   * What is left is exactly the case nothing else can see: a vector that
   * exists, is not queued, and no longer describes its concept.
   */
  async resyncConceptEmbeddings(
    libraryID?: number,
  ): Promise<{ requeued: number }> {
    await this.initialize();
    const rows = await this.db.queryAsync(
      `SELECT c.concept_id AS concept_id, ${CONCEPT_EMBEDDING_COLUMNS},
              e.text_hash AS stored_hash
         FROM wiki_concepts c
         JOIN wiki_concept_embeddings e ON e.concept_id = c.concept_id
        WHERE NOT EXISTS (
                SELECT 1 FROM wiki_concept_embedding_queue q
                 WHERE q.concept_id = c.concept_id)
          ${libraryID === undefined ? "" : "AND c.library_id = ?"}`,
      libraryID === undefined ? [] : [libraryID],
    );
    let requeued = 0;
    for (const row of rows) {
      const text = conceptEmbeddingTextFromRow(row);
      if (!text) continue;
      const stored = String(rowValue(row, "stored_hash", "storedHash") ?? "");
      if (!stored || stored === (await hashWikiText(text))) continue;
      await this.conceptEmbeddingQueueStore.enqueue(
        Number(rowValue(row, "concept_id", "conceptId")),
        text,
      );
      requeued += 1;
    }
    return { requeued };
  }

  /**
   * The concepts this paper introduced or reused.
   *
   * The join exists because `wiki_record_concepts` records, for every term it
   * writes, the paper and chunk the term was read out of. That makes the
   * paper's own concept list recoverable from the database rather than from
   * something the model has to restate - which is what lets the server seed
   * its own recall instead of waiting for the model to write a query, the
   * distinction the whole neighbourhood design rests on.
   */
  async conceptIdsForItem(
    libraryID: number,
    itemKey: string,
  ): Promise<number[]> {
    await this.initialize();
    const rows = await this.db.queryAsync(
      `SELECT DISTINCT t.concept_id AS concept_id
         FROM wiki_concept_term_sources s
         JOIN wiki_concept_terms t ON t.term_id = s.term_id
         JOIN wiki_concepts c ON c.concept_id = t.concept_id
        WHERE s.library_id = ? AND s.item_key = ? AND c.library_id = ?`,
      [libraryID, itemKey, libraryID],
    );
    return rows.map((row: any) =>
      Number(rowValue(row, "concept_id", "conceptId")),
    );
  }

  private async conceptScanRows(
    libraryID: number,
  ): Promise<WikiConceptScanRow[]> {
    const rows = await this.db.queryAsync(
      `SELECT c.concept_id AS concept_id, c.canonical_name AS canonical_name,
              c.concept_type AS concept_type, c.description AS description,
              e.embedding AS embedding, e.dimensions AS dimensions,
              e.model AS model
         FROM wiki_concepts c
         LEFT JOIN wiki_concept_embeddings e ON e.concept_id = c.concept_id
        WHERE c.library_id = ?`,
      [libraryID],
    );
    return rows.map((row: any) => ({
      conceptId: Number(rowValue(row, "concept_id", "conceptId")),
      name: String(rowValue(row, "canonical_name", "canonicalName") ?? ""),
      type: String(rowValue(row, "concept_type", "conceptType") ?? ""),
      description: String(rowValue(row, "description", "description") ?? ""),
      vector: floatVector(
        rowValue(row, "embedding", "embedding"),
        Number(rowValue(row, "dimensions", "dimensions") ?? 0),
      ),
      model: String(rowValue(row, "model", "model") ?? ""),
    }));
  }

  /** How many relations each concept in this library takes part in. */
  private async conceptDegrees(
    libraryID: number,
  ): Promise<Map<number, number>> {
    const rows = await this.db.queryAsync(
      `SELECT concept_id, COUNT(*) AS degree FROM (
         SELECT r.source_concept_id AS concept_id FROM wiki_relations r
           JOIN wiki_concepts c ON c.concept_id = r.source_concept_id
          WHERE c.library_id = ?
         UNION ALL
         SELECT r.target_concept_id AS concept_id FROM wiki_relations r
           JOIN wiki_concepts c ON c.concept_id = r.target_concept_id
          WHERE c.library_id = ?
       ) GROUP BY concept_id`,
      [libraryID, libraryID],
    );
    return new Map(
      rows.map((row: any) => [
        Number(rowValue(row, "concept_id", "conceptId")),
        Number(rowValue(row, "degree", "degree")),
      ]),
    );
  }

  /** Concepts one relation away from any of these. */
  private async relationNeighbours(
    conceptIds: number[],
  ): Promise<Set<number>> {
    if (!conceptIds.length) return new Set();
    const list = conceptIds.map(() => "?").join(",");
    const rows = await this.db.queryAsync(
      `SELECT source_concept_id AS a, target_concept_id AS b
         FROM wiki_relations
        WHERE source_concept_id IN (${list}) OR target_concept_id IN (${list})`,
      [...conceptIds, ...conceptIds],
    );
    const found = new Set<number>();
    for (const row of rows) {
      found.add(Number(rowValue(row, "a", "a")));
      found.add(Number(rowValue(row, "b", "b")));
    }
    for (const id of conceptIds) found.delete(id);
    return found;
  }

  /** Relations with BOTH ends inside this set, named rather than numbered. */
  private async relationsAmong(conceptIds: number[]): Promise<string[]> {
    if (conceptIds.length < 2) return [];
    const list = conceptIds.map(() => "?").join(",");
    const rows = await this.db.queryAsync(
      `SELECT s.canonical_name AS source, r.predicate AS predicate,
              t.canonical_name AS target
         FROM wiki_relations r
         JOIN wiki_concepts s ON s.concept_id = r.source_concept_id
         JOIN wiki_concepts t ON t.concept_id = r.target_concept_id
        WHERE r.source_concept_id IN (${list})
          AND r.target_concept_id IN (${list})
        ORDER BY s.canonical_name, r.predicate`,
      [...conceptIds, ...conceptIds],
    );
    return rows.map(
      (row: any) =>
        `${rowValue(row, "source", "source")} --${rowValue(
          row,
          "predicate",
          "predicate",
        )}--> ${rowValue(row, "target", "target")}`,
    );
  }

  /**
   * Existing concepts that a proposed name may already be.
   *
   * Two retrievals, because they fail in opposite directions. The lexical one
   * is exact and certain: a hit on `normalized_name` or the alias table means
   * the concept IS this one, and it is reported first with score 1. The vector
   * one is approximate and is the only thing that can see that `界面换热系数`
   * and `界面传热系数` are one concept - normalization cannot, since they differ
   * by a character, which is precisely how a library ends up holding both.
   */
  async matchConcepts(options: {
    libraryID: number;
    probes: { text: string; vector: Float32Array | null }[];
    model: string;
    limit?: number;
    /** The paper being written up; annotates each match with its source state. */
    itemKey?: string;
  }): Promise<WikiConceptMatch[]> {
    await this.initialize();
    const limit = Math.max(1, Math.min(20, options.limit ?? 5));
    const rows = await this.conceptScanRows(options.libraryID);
    const byId = new Map(rows.map((row) => [row.conceptId, row]));
    const results: WikiConceptMatch[] = [];
    for (const probe of options.probes) {
      const normalized = normalizeWikiName(probe.text);
      const exact = normalized
        ? await this.db.queryAsync(
            `SELECT concept_id FROM wiki_concepts
              WHERE library_id = ? AND normalized_name = ?
              UNION
             SELECT a.concept_id FROM wiki_aliases a
               JOIN wiki_concepts c ON c.concept_id = a.concept_id
              WHERE c.library_id = ? AND a.normalized_alias = ?`,
            [options.libraryID, normalized, options.libraryID, normalized],
          )
        : [];
      const matched: WikiConceptMatch["matches"] = [];
      const seen = new Set<number>();
      for (const row of exact) {
        const hit = byId.get(Number(rowValue(row, "concept_id", "conceptId")));
        if (!hit || seen.has(hit.conceptId)) continue;
        seen.add(hit.conceptId);
        matched.push({
          conceptId: hit.conceptId,
          name: hit.name,
          type: hit.type,
          description: hit.description,
          score: 1,
          matchedBy: "name",
        });
      }
      if (probe.vector) {
        const scored = rows
          .filter(
            (row) =>
              !seen.has(row.conceptId) &&
              row.vector &&
              row.model === options.model &&
              row.vector.length === probe.vector!.length,
          )
          .map((row) => ({
            row,
            score: cosine(probe.vector as Float32Array, row.vector!),
          }))
          .sort((left, right) => right.score - left.score)
          .slice(0, limit);
        for (const entry of scored) {
          matched.push({
            conceptId: entry.row.conceptId,
            name: entry.row.name,
            type: entry.row.type,
            description: entry.row.description,
            score: Number(entry.score.toFixed(4)),
            matchedBy: "vector",
          });
        }
      }
      results.push({ probe: probe.text, matches: matched.slice(0, limit) });
    }
    const itemKey = String(options.itemKey ?? "").trim();
    if (itemKey) {
      const attestation = await this.conceptSourceAttestation(
        options.libraryID,
        itemKey,
      );
      for (const result of results) {
        for (const match of result.matches) {
          const state = attestation.get(match.conceptId);
          match.sourceDocuments = state?.sourceDocuments ?? 0;
          match.sourcedFromThisPaper = state?.sourcedFromThisPaper ?? false;
        }
      }
    }
    return results;
  }

  /**
   * Per concept: how many documents source it, and whether `itemKey` is one.
   *
   * One aggregate for the whole library rather than a lookup per match - the
   * duplicate list is short, but it is computed on every write-up and the
   * concept count is not bounded by it.
   */
  private async conceptSourceAttestation(
    libraryID: number,
    itemKey: string,
  ): Promise<Map<number, { sourceDocuments: number; sourcedFromThisPaper: boolean }>> {
    const rows = await this.db.queryAsync(
      `SELECT t.concept_id AS concept_id,
              COUNT(DISTINCT s.item_key) AS source_documents,
              MAX(CASE WHEN s.item_key = ? THEN 1 ELSE 0 END) AS this_paper
         FROM wiki_concept_terms t
         JOIN wiki_concept_term_sources s ON s.term_id = t.term_id
        WHERE s.library_id = ?
        GROUP BY t.concept_id`,
      [itemKey, libraryID],
    );
    const attestation = new Map<
      number,
      { sourceDocuments: number; sourcedFromThisPaper: boolean }
    >();
    for (const row of rows) {
      attestation.set(Number(rowValue(row, "concept_id", "conceptId")), {
        sourceDocuments: Number(
          rowValue(row, "source_documents", "sourceDocuments") ?? 0,
        ),
        sourcedFromThisPaper:
          Number(rowValue(row, "this_paper", "thisPaper") ?? 0) > 0,
      });
    }
    return attestation;
  }

  /**
   * Pages this paper could extend, found through their Claims.
   *
   * The Wiki grew one page per paper for thirty papers in a row, with the
   * complete page list in front of the model every time. A list of thirty
   * titles is not an answer to "which of these is about what I just read" - it
   * is the raw material for that question, and the model answered it by not
   * answering it.
   *
   * Pages cannot be compared to a paper directly: `wiki_pages.primary_concept_id`
   * was null for all thirty, so there is no edge from a page into the concept
   * graph. Their CLAIMS have vectors though, and a page is what its claims say,
   * so the nearest claims name the nearest pages. Scored by the best claim
   * rather than the average: a page of four claims where one is exactly this
   * paper's subject is a page to extend, and averaging that against the other
   * three would hide it.
   */
  async pagesNearVectors(options: {
    libraryID: number;
    vectors: Float32Array[];
    /** Concepts of the paper being written up; their vectors probe too. */
    seedConceptIds?: number[];
    model: string;
    limit?: number;
  }): Promise<
    { pageId: number; title: string; score: number; nearestClaim: string }[]
  > {
    await this.initialize();
    /*
     * The paper's own concepts probe alongside the caller's query. The query is
     * the model's one-line description of what it just read, which is a fair
     * probe; the concepts are what it actually recorded, which is a better one,
     * and they are already in the database by the time this runs.
     */
    const probes = [...options.vectors];
    for (const id of options.seedConceptIds ?? []) {
      const rows = await this.db.queryAsync(
        `SELECT embedding, dimensions, model FROM wiki_concept_embeddings
          WHERE concept_id = ?`,
        [id],
      );
      const row = rows?.[0];
      if (!row) continue;
      if (String(rowValue(row, "model", "model") ?? "") !== options.model) {
        continue;
      }
      const vector = floatVector(
        rowValue(row, "embedding", "embedding"),
        Number(rowValue(row, "dimensions", "dimensions") ?? 0),
      );
      if (vector) probes.push(vector);
    }
    if (!probes.length) return [];
    const rows = await this.db.queryAsync(
      `SELECT p.page_id AS page_id, p.canonical_title AS title,
              c.claim_text AS claim_text,
              e.embedding AS embedding, e.dimensions AS dimensions,
              e.model AS model
         FROM wiki_claim_embeddings e
         JOIN wiki_claims c ON c.claim_id = e.claim_id
         JOIN wiki_pages p ON p.page_id = c.page_id
        WHERE p.library_id = ? AND p.status = 'active'`,
      [options.libraryID],
    );
    const best = new Map<
      number,
      { pageId: number; title: string; score: number; nearestClaim: string }
    >();
    for (const row of rows ?? []) {
      if (String(rowValue(row, "model", "model") ?? "") !== options.model) {
        continue;
      }
      const vector = floatVector(
        rowValue(row, "embedding", "embedding"),
        Number(rowValue(row, "dimensions", "dimensions") ?? 0),
      );
      if (!vector) continue;
      let score = 0;
      for (const probe of probes) {
        if (probe.length === vector.length) {
          score = Math.max(score, cosine(probe, vector));
        }
      }
      if (score <= 0) continue;
      const pageId = Number(rowValue(row, "page_id", "pageId"));
      const current = best.get(pageId);
      if (current && current.score >= score) continue;
      best.set(pageId, {
        pageId,
        title: String(rowValue(row, "title", "title") ?? ""),
        score: Number(score.toFixed(4)),
        nearestClaim: String(
          rowValue(row, "claim_text", "claimText") ?? "",
        ).slice(0, 160),
      });
    }
    return [...best.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(20, options.limit ?? 6)));
  }

  /** {@link WikiConceptNeighbourhood} for one paper's concepts. */
  async conceptNeighbourhood(options: {
    libraryID: number;
    seedConceptIds: number[];
    seedVectors?: Float32Array[];
    model: string;
    limit?: number;
    hubLimit?: number;
  }): Promise<WikiConceptNeighbourhood> {
    await this.initialize();
    const limit = Math.max(1, Math.min(200, options.limit ?? 40));
    const hubLimit = Math.max(0, Math.min(50, options.hubLimit ?? 12));
    const rows = await this.conceptScanRows(options.libraryID);
    const byId = new Map(rows.map((row) => [row.conceptId, row]));
    const seedIds = new Set(
      options.seedConceptIds.filter((id) => byId.has(id)),
    );

    const usable = (row: WikiConceptScanRow): row is WikiConceptScanRow =>
      Boolean(row.vector) && row.model === options.model;
    const seedVectors = [
      ...(options.seedVectors ?? []),
      ...rows
        .filter((row) => seedIds.has(row.conceptId) && usable(row))
        .map((row) => row.vector as Float32Array),
    ];

    const scored = rows
      .filter((row) => !seedIds.has(row.conceptId) && usable(row))
      .map((row) => ({
        row,
        score: seedVectors.reduce(
          (best, seed) =>
            seed.length === row.vector!.length
              ? Math.max(best, cosine(seed, row.vector!))
              : best,
          0,
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    const toScored = (
      row: WikiConceptScanRow,
      score: number,
    ): WikiScoredConcept => ({
      conceptId: row.conceptId,
      name: row.name,
      type: row.type,
      description: row.description,
      score: Number(score.toFixed(4)),
    });

    const neighbourIds = new Set(scored.map((entry) => entry.row.conceptId));
    const relatedIds = await this.relationNeighbours([...seedIds]);
    for (const id of neighbourIds) relatedIds.delete(id);

    const degrees = await this.conceptDegrees(options.libraryID);
    const claimed = new Set([...seedIds, ...neighbourIds, ...relatedIds]);
    const hubs = rows
      .filter((row) => !claimed.has(row.conceptId) && degrees.get(row.conceptId))
      .sort(
        (left, right) =>
          (degrees.get(right.conceptId) ?? 0) -
          (degrees.get(left.conceptId) ?? 0),
      )
      .slice(0, hubLimit);

    const inScope = [
      ...seedIds,
      ...neighbourIds,
      ...relatedIds,
      ...hubs.map((row) => row.conceptId),
    ];
    const queue = await this.conceptEmbeddingQueue();
    return {
      conceptCount: rows.length,
      pendingVectors: await queue.pendingCount(),
      seeds: [...seedIds].map((id) => toScored(byId.get(id)!, 1)),
      neighbours: scored.map((entry) => toScored(entry.row, entry.score)),
      related: [...relatedIds]
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((row) => toScored(row as WikiConceptScanRow, 0)),
      hubs: hubs.map((row) => ({
        ...toScored(row, 0),
        degree: degrees.get(row.conceptId) ?? 0,
      })),
      relations: await this.relationsAmong(inScope),
    };
  }

  /**
   * A value that changes whenever anything in the skeleton would change.
   *
   * The skeleton is recomputed and re-sent on every `wiki_prepare_update`, and
   * in question-driven reading that is once per answering turn - several
   * identical copies of the same structure inside one conversation. This is
   * what lets the second one be answered with "unchanged" instead.
   *
   * Counts and max-ids rather than a timestamp, because `wiki_concepts` has no
   * `updated_at` and an edit in place moves neither a count nor a max id. The
   * two hashes cover that gap: the names catch a rename, and the stored
   * embedding hashes catch a rewritten description - a description edit
   * re-queues the concept, which moves `queued`, and then changes its stored
   * hash when the drain lands, so the edit is visible at both ends of the
   * round trip rather than only after it completes.
   */
  async wikiRevision(libraryID: number): Promise<string> {
    await this.initialize();
    /*
     * Seven scalar reads rather than one SELECT with seven subqueries.
     *
     * The single-query version was the only SELECT in this codebase with no
     * FROM clause of its own, and `Zotero.DBConnection.queryAsync` handed it
     * back `undefined` instead of a row array - so `row[0]` threw
     * "can't access property 0, row is undefined" and took down every
     * wiki_prepare_update, on every paper, for as long as the build was
     * installed. Every other `rows[0]` in the plugin reads a SELECT with a
     * real FROM, which is the shape that has always worked; this now uses the
     * same `valueQueryAsync` path that `getStatus` runs a dozen times per call.
     */
    const scalar = async (sql: string, params: unknown[] = []) =>
      Number((await this.db.valueQueryAsync(sql, params)) ?? 0);
    const parts = [
      await scalar("SELECT COUNT(*) FROM wiki_pages WHERE library_id = ?", [
        libraryID,
      ]),
      await scalar("SELECT MAX(updated_at) FROM wiki_pages WHERE library_id = ?", [
        libraryID,
      ]),
      await scalar("SELECT COUNT(*) FROM wiki_concepts WHERE library_id = ?", [
        libraryID,
      ]),
      await scalar(
        "SELECT MAX(concept_id) FROM wiki_concepts WHERE library_id = ?",
        [libraryID],
      ),
      await scalar(
        `SELECT COUNT(*) FROM wiki_relations r
           JOIN wiki_concepts c ON c.concept_id = r.source_concept_id
          WHERE c.library_id = ?`,
        [libraryID],
      ),
      await scalar("SELECT COUNT(*) FROM wiki_concept_embeddings"),
      await scalar("SELECT COUNT(*) FROM wiki_concept_embedding_queue"),
    ];
    const fingerprint = await this.db.valueQueryAsync(
      `SELECT group_concat(mark, ' ') FROM (
         SELECT c.normalized_name || ':' || COALESCE(e.text_hash, '') AS mark
           FROM wiki_concepts c
           LEFT JOIN wiki_concept_embeddings e ON e.concept_id = c.concept_id
          WHERE c.library_id = ? ORDER BY c.concept_id)`,
      [libraryID],
    );
    return `${parts.join("-")}-${await hashWikiText(String(fingerprint ?? ""))}`;
  }


  /**
   * Page titles and claim counts, without loading the pages.
   *
   * `listPages` hydrates every Claim and every piece of Evidence of every
   * page, which is the right thing for the Wiki panel and the wrong thing for
   * a header that shows titles: the write-up's skeleton needed two fields per
   * page and was reading the entire Wiki to get them, on every prepare. The
   * token cost of that response was the visible problem; this was the
   * invisible one underneath it.
   */
  async listPageTitles(
    libraryID: number,
  ): Promise<{ title: string; claims: number }[]> {
    await this.initialize();
    const rows = await this.db.queryAsync(
      `SELECT p.canonical_title AS title,
              (SELECT COUNT(*) FROM wiki_claims c WHERE c.page_id = p.page_id)
                AS claims
         FROM wiki_pages p
        WHERE p.library_id = ? AND p.status = 'active'
        ORDER BY p.updated_at DESC, p.page_id`,
      [libraryID],
    );
    return rows.map((row: any) => ({
      title: String(rowValue(row, "title", "title") ?? ""),
      claims: Number(rowValue(row, "claims", "claims") ?? 0),
    }));
  }

  async listPages(libraryID: number): Promise<WikiPageRecord[]> {
    await this.initialize();
    const rows = await this.db.queryAsync(
      "SELECT page_id FROM wiki_pages WHERE library_id = ? AND status = 'active' ORDER BY updated_at DESC, page_id",
      [libraryID],
    );
    const pages: WikiPageRecord[] = [];
    for (const row of rows) {
      const page = await this.getPage(
        Number(rowValue(row, "page_id", "pageId")),
      );
      if (page) pages.push(page);
    }
    return pages;
  }

  async updateConcept(options: {
    libraryID: number;
    conceptId: number;
    canonicalName?: string;
    addAliases?: Array<{
      alias: string;
      language?: string;
      source?: string;
      confidence?: number;
    }>;
    removeAliasIds?: number[];
  }): Promise<void> {
    await this.initialize();
    const count = Number(
      await this.db.valueQueryAsync(
        "SELECT COUNT(*) FROM wiki_concepts WHERE concept_id = ? AND library_id = ?",
        [options.conceptId, options.libraryID],
      ),
    );
    if (!count) throw new Error("Wiki concept does not exist in this library");
    await this.db.executeTransaction(async () => {
      if (options.canonicalName !== undefined) {
        const name = normalizeWikiText(options.canonicalName);
        if (!name) throw new Error("Canonical concept name must not be blank");
        await this.assertConceptNameAvailable(
          options.libraryID,
          options.conceptId,
          name,
        );
        await this.db.queryAsync(
          "UPDATE wiki_concepts SET canonical_name = ?, normalized_name = ? WHERE concept_id = ?",
          [name, normalizeWikiName(name), options.conceptId],
        );
        // The flat column and the structured terms must not disagree: the
        // term store is the authority and rewrites this column from the
        // primary term, so a rename that only touched the column would be
        // undone by the next projection sync.
        await this.conceptLibrary.renamePrimaryFlat(options.conceptId, name);
      }
      const addedNames: Array<{ name: string; language?: string }> = [];
      for (const alias of options.addAliases ?? []) {
        const value = normalizeWikiText(alias.alias);
        if (!value) continue;
        addedNames.push({ name: value, language: alias.language });
        await this.assertConceptNameAvailable(
          options.libraryID,
          options.conceptId,
          value,
        );
        await this.db.queryAsync(
          `INSERT OR IGNORE INTO wiki_aliases
           (concept_id, alias, normalized_alias, language, source, confidence)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            options.conceptId,
            value,
            normalizeWikiName(value),
            alias.language || "und",
            alias.source || "user",
            numberInRange(alias.confidence ?? 1, "alias confidence"),
          ],
        );
      }
      if (addedNames.length) {
        await this.conceptLibrary.ingestFlatNames(
          options.conceptId,
          addedNames.map((entry) => ({ ...entry, source: "user" })),
        );
      }
      for (const aliasId of options.removeAliasIds ?? []) {
        const removed = await this.db.valueQueryAsync(
          "SELECT alias FROM wiki_aliases WHERE alias_id = ? AND concept_id = ?",
          [aliasId, options.conceptId],
        );
        await this.db.queryAsync(
          "DELETE FROM wiki_aliases WHERE alias_id = ? AND concept_id = ?",
          [aliasId, options.conceptId],
        );
        if (removed != null) {
          await this.conceptLibrary.removeFlatName(
            options.conceptId,
            String(removed),
          );
        }
      }
      if (options.canonicalName !== undefined) {
        const pages = await this.db.queryAsync(
          `SELECT DISTINCT p.page_id
           FROM wiki_pages p
           LEFT JOIN wiki_relations r
             ON r.source_concept_id = p.primary_concept_id
             OR r.target_concept_id = p.primary_concept_id
           WHERE p.library_id = ? AND (
             p.primary_concept_id = ?
             OR r.source_concept_id = ?
             OR r.target_concept_id = ?
           )`,
          [
            options.libraryID,
            options.conceptId,
            options.conceptId,
            options.conceptId,
          ],
        );
        for (const page of pages) {
          await this.refreshPageSummary(
            Number(rowValue(page, "page_id", "pageId")),
          );
        }
      }
      // A rename or an alias change moves the concept in the embedding space,
      // so the vector it has is now a vector for a name it no longer carries.
      await this.enqueueConceptEmbedding(options.conceptId);
    });
  }

  async deleteClaim(claimId: number, libraryID: number): Promise<void> {
    const claim = await this.requireClaim(claimId, libraryID);
    const pageId = Number(rowValue(claim, "page_id", "pageId"));
    await this.db.executeTransaction(async () => {
      await this.db.queryAsync("DELETE FROM wiki_claims WHERE claim_id = ?", [
        claimId,
      ]);
      await this.refreshPageSummary(pageId);
    });
  }

  /**
   * The claim ids of one page, read before anything is deleted.
   *
   * Every child table reaches a page through `wiki_claims.page_id`, so once
   * the claims are gone there is no query left that can find their rows. The
   * ids are captured up front, and the deletes and the verification both work
   * from that list rather than from a join that stops matching halfway
   * through.
   */
  private async claimIdsOfPage(pageId: number): Promise<number[]> {
    const rows = await this.db.queryAsync(
      "SELECT claim_id FROM wiki_claims WHERE page_id = ?",
      [pageId],
    );
    return rows.map((row: any) => Number(rowValue(row, "claim_id", "claimId")));
  }

  /**
   * Work out exactly what deleting one page would destroy.
   *
   * The concept question is the whole reason this is a separate step. A page
   * points at `primary_concept_id`, and `wiki_aliases` and `wiki_relations`
   * hang off that concept - not off the page. If another page shares the
   * concept, none of it may be touched: the delete would silently strip a
   * second knowledge entry of its terminology. So the concept, its aliases and
   * every relation that ends on it are in scope only when this page is the
   * last one using it.
   *
   * Relations that are in scope may still be quoted in another page's summary,
   * because `refreshPageSummary` writes the relations of a page's concept into
   * its summary text. Those pages are collected here and rewritten after the
   * delete, so no summary outlives the relation it describes.
   */
  private async planPageDeletion(
    pageId: number,
    libraryID: number,
  ): Promise<{ plan: WikiPageDeletion; conceptId: number | null }> {
    const rows = await this.db.queryAsync(
      "SELECT canonical_title, primary_concept_id FROM wiki_pages WHERE page_id = ? AND library_id = ?",
      [pageId, libraryID],
    );
    if (!rows[0]) {
      throw new Error(
        `Wiki page ${pageId} does not exist in library ${libraryID}`,
      );
    }
    const canonicalTitle = String(
      rowValue(rows[0], "canonical_title", "canonicalTitle"),
    );
    const rawConceptId = rowValue(
      rows[0],
      "primary_concept_id",
      "primaryConceptId",
    );
    const primaryConceptId =
      rawConceptId === null || rawConceptId === undefined
        ? null
        : Number(rawConceptId);

    const claimIds = await this.claimIdsOfPage(pageId);
    const countForClaims = async (table: string): Promise<number> => {
      if (!claimIds.length) return 0;
      const slots = claimIds.map(() => "?").join(", ");
      return Number(
        await this.db.valueQueryAsync(
          `SELECT COUNT(*) FROM ${table} WHERE claim_id IN (${slots})`,
          claimIds,
        ),
      );
    };

    let conceptId: number | null = null;
    if (primaryConceptId !== null) {
      const shared = Number(
        await this.db.valueQueryAsync(
          "SELECT COUNT(*) FROM wiki_pages WHERE primary_concept_id = ? AND page_id != ?",
          [primaryConceptId, pageId],
        ),
      );
      if (!shared) conceptId = primaryConceptId;
    }

    let aliases = 0;
    let relations = 0;
    const refreshedPages: number[] = [];
    if (conceptId !== null) {
      aliases = Number(
        await this.db.valueQueryAsync(
          "SELECT COUNT(*) FROM wiki_aliases WHERE concept_id = ?",
          [conceptId],
        ),
      );
      relations = Number(
        await this.db.valueQueryAsync(
          `SELECT COUNT(*) FROM wiki_relations
           WHERE source_concept_id = ? OR target_concept_id = ?`,
          [conceptId, conceptId],
        ),
      );
      const neighbours = await this.db.queryAsync(
        `SELECT DISTINCT p.page_id
         FROM wiki_pages p
         JOIN wiki_relations r
           ON r.source_concept_id = p.primary_concept_id
           OR r.target_concept_id = p.primary_concept_id
         WHERE p.page_id != ?
           AND (r.source_concept_id = ? OR r.target_concept_id = ?)`,
        [pageId, conceptId, conceptId],
      );
      for (const row of neighbours) {
        refreshedPages.push(Number(rowValue(row, "page_id", "pageId")));
      }
    }

    return {
      conceptId,
      plan: {
        pageId,
        canonicalTitle,
        claims: claimIds.length,
        evidence: await countForClaims("wiki_evidence"),
        claimEmbeddings: await countForClaims("wiki_claim_embeddings"),
        queuedEmbeddings: await countForClaims("wiki_embedding_queue"),
        concepts: conceptId === null ? 0 : 1,
        aliases,
        relations,
        refreshedPages,
      },
    };
  }

  /**
   * What deleting this page would destroy, without destroying anything.
   *
   * The confirmation dialog is only honest if it counts the rows the delete
   * will actually remove, so it reads this rather than assembling its own
   * totals from whatever the panel happens to have loaded.
   */
  async describePageDeletion(
    pageId: number,
    libraryID: number,
  ): Promise<WikiPageDeletion> {
    await this.initialize();
    const { plan } = await this.planPageDeletion(pageId, libraryID);
    return plan;
  }

  /**
   * Which concept every other page in the database is bound to.
   *
   * Read before the delete and compared after it. `wiki_pages.primary_concept_id`
   * is declared `ON DELETE SET NULL`, so removing a concept silently rebinds
   * any page still pointing at it - the one way this delete could reach into
   * another knowledge entry without issuing a statement against it. A concept
   * is only ever removed when no other page uses it, so this snapshot must
   * come back identical; if it does not, the delete is refused.
   */
  private async conceptBindings(
    pageId: number,
  ): Promise<Array<[number, number | null]>> {
    const rows = await this.db.queryAsync(
      "SELECT page_id, primary_concept_id FROM wiki_pages WHERE page_id != ? ORDER BY page_id",
      [pageId],
    );
    return rows.map((row: any) => {
      const bound = rowValue(row, "primary_concept_id", "primaryConceptId");
      return [
        Number(rowValue(row, "page_id", "pageId")),
        bound === null || bound === undefined ? null : Number(bound),
      ] as [number, number | null];
    });
  }

  /**
   * Refuse to commit a delete that left anything behind - or took too much.
   *
   * This runs inside the transaction, so anything it finds aborts the whole
   * delete rather than reporting a page that is half gone. It asks two
   * questions, both scoped to this delete and nothing else:
   *
   *   - is there any row left anywhere that refers to this page, its claims or
   *     its concept? Asked table by table against the captured ids, rather
   *     than trusting the DELETE statements above to have covered every table.
   *   - did any other page change? No page outside this one may vanish or be
   *     rebound to a different concept.
   *
   * Deliberately *not* asked: whether the database contains orphan rows in
   * general. Rows that belong to nothing are a pre-existing condition of the
   * file, not something one page's delete created, and this operation neither
   * reports nor repairs them - see the note on `deletePage`.
   */
  private async assertPageFullyDeleted(
    pageId: number,
    claimIds: number[],
    conceptId: number | null,
    bindingsBefore: Array<[number, number | null]>,
  ): Promise<void> {
    const residue: string[] = [];
    const check = async (
      label: string,
      sql: string,
      params: unknown[],
    ): Promise<void> => {
      const left = Number(await this.db.valueQueryAsync(sql, params));
      if (left) residue.push(`${label}=${left}`);
    };
    await check(
      "wiki_pages",
      "SELECT COUNT(*) FROM wiki_pages WHERE page_id = ?",
      [pageId],
    );
    await check(
      "wiki_claims.page_id",
      "SELECT COUNT(*) FROM wiki_claims WHERE page_id = ?",
      [pageId],
    );
    // In batches, because SQLite binds at most 32766 parameters per statement
    // and a page's claim count has no ceiling.
    for (let start = 0; start < claimIds.length; start += ID_BATCH) {
      const batch = claimIds.slice(start, start + ID_BATCH);
      const slots = batch.map(() => "?").join(", ");
      for (const table of [
        "wiki_claims",
        "wiki_evidence",
        "wiki_claim_embeddings",
        "wiki_embedding_queue",
      ]) {
        await check(
          table,
          `SELECT COUNT(*) FROM ${table} WHERE claim_id IN (${slots})`,
          batch,
        );
      }
    }
    if (conceptId !== null) {
      await check(
        "wiki_concepts",
        "SELECT COUNT(*) FROM wiki_concepts WHERE concept_id = ?",
        [conceptId],
      );
      await check(
        "wiki_aliases",
        "SELECT COUNT(*) FROM wiki_aliases WHERE concept_id = ?",
        [conceptId],
      );
      await check(
        "wiki_relations",
        `SELECT COUNT(*) FROM wiki_relations
         WHERE source_concept_id = ? OR target_concept_id = ?`,
        [conceptId, conceptId],
      );
      await check(
        "wiki_pages.primary_concept_id",
        "SELECT COUNT(*) FROM wiki_pages WHERE primary_concept_id = ?",
        [conceptId],
      );
    }
    if (residue.length) {
      throw new Error(
        `Deleting Wiki page ${pageId} left referencing rows behind (${residue.join(", ")}); the delete was rolled back`,
      );
    }

    const bindingsAfter = await this.conceptBindings(pageId);
    const describe = (bindings: Array<[number, number | null]>): string =>
      bindings.map(([page, concept]) => `${page}:${concept ?? "-"}`).join(",");
    if (describe(bindingsAfter) !== describe(bindingsBefore)) {
      throw new Error(
        `Deleting Wiki page ${pageId} altered other pages (before ${describe(bindingsBefore)}; after ${describe(bindingsAfter)}); the delete was rolled back`,
      );
    }
  }

  /**
   * Delete one knowledge entry and everything that belongs to it, for good.
   *
   * Physical deletion, not a status flag: the page row, its claims, their
   * evidence, their embeddings and their queued embedding work all leave the
   * database, and so do the page's concept, aliases and relations when no
   * other page shares that concept. Every statement runs in one transaction
   * that is verified before it commits, so a fault at any step leaves the Wiki
   * exactly as it was rather than half deleted.
   *
   * Nothing outside this page is removed. Other pages change in one way only:
   * a summary that quoted a relation to the deleted concept is rewritten
   * without it, because that relation no longer exists.
   *
   * That includes rows the database may already hold that belong to nothing -
   * evidence whose claim is missing, an alias whose concept is missing. This
   * used to sweep those away database-wide while it was here anyway, which
   * made deleting one entry silently rewrite unrelated history: the scope of
   * the operation stopped being predictable from what the user asked for, and
   * a row that looked like debris - a `pending_relink` evidence waiting on a
   * rebuild, a queue entry mid-flight - was destroyed without a word. Such
   * rows are a property of the file, not of this page, and repairing them is a
   * maintenance action a user should invoke deliberately. `clearAll()` is the
   * one that exists today.
   */
  async deletePage(
    pageId: number,
    libraryID: number,
  ): Promise<WikiPageDeletion> {
    await this.initialize();
    await this.requirePage(pageId, libraryID);
    return this.db.executeTransaction(async () => {
      const { plan, conceptId } = await this.planPageDeletion(
        pageId,
        libraryID,
      );
      const claimIds = await this.claimIdsOfPage(pageId);
      const bindings = await this.conceptBindings(pageId);
      if (claimIds.length) {
        // Children before parents, so the delete rests on its own statements
        // rather than on whether this connection has foreign keys enabled.
        //
        // Scoped by `page_id` through a subquery rather than by binding the
        // captured ids: the reach is identical - these claims and no others -
        // but it costs no bound parameters, and SQLite refuses a statement
        // with more than 32766 of them. The ids are still captured, because
        // the verification below has to run after the claims are gone, when
        // this subquery would return nothing.
        for (const table of [
          "wiki_embedding_queue",
          "wiki_claim_embeddings",
          "wiki_evidence",
        ]) {
          await this.db.queryAsync(
            `DELETE FROM ${table}
             WHERE claim_id IN (SELECT claim_id FROM wiki_claims WHERE page_id = ?)`,
            [pageId],
          );
        }
      }
      await this.db.queryAsync("DELETE FROM wiki_claims WHERE page_id = ?", [
        pageId,
      ]);
      await this.db.queryAsync("DELETE FROM wiki_pages WHERE page_id = ?", [
        pageId,
      ]);
      if (conceptId !== null) {
        await this.db.queryAsync(
          `DELETE FROM wiki_relations
           WHERE source_concept_id = ? OR target_concept_id = ?`,
          [conceptId, conceptId],
        );
        await this.db.queryAsync(
          "DELETE FROM wiki_aliases WHERE concept_id = ?",
          [conceptId],
        );
        await this.db.queryAsync(
          "DELETE FROM wiki_concepts WHERE concept_id = ?",
          [conceptId],
        );
      }
      // The neighbours were read before the relations went; refreshing them
      // now is what keeps a surviving page's summary from quoting a relation
      // that no longer exists.
      for (const neighbour of plan.refreshedPages) {
        await this.refreshPageSummary(neighbour);
      }
      await this.assertPageFullyDeleted(pageId, claimIds, conceptId, bindings);
      return plan;
    });
  }

  /**
   * How much of each paper has actually been read, in one query.
   *
   * The graph needs this for every node it draws, and asking per document
   * would be one round trip per paper on a view that already reads the whole
   * Wiki. The distinction it supports is not cosmetic: a paper read in full
   * with no edges is evidence that it really does not connect to anything,
   * while a paper nobody has opened is evidence of nothing at all, and the
   * old drawn/dim pair rendered them identically.
   *
   * `paper_reviewed` keeps its strict meaning - a full-text session, every
   * chunk delivered, whole-paper synthesis recorded. A question-driven session
   * that happens to have touched every chunk is `section_read`, exactly as
   * Evidence depth treats it.
   */
  async getDocumentReadDepths(
    libraryID: number,
  ): Promise<Map<string, "paper_reviewed" | "section_read">> {
    await this.initialize();
    const rows = await this.db.queryAsync(
      `SELECT s.item_key AS item_key, s.mode AS mode, s.total_chunks AS total_chunks,
              s.final_synthesis_at AS final_synthesis_at,
              COUNT(DISTINCT c.chunk_index) AS delivered
         FROM wiki_reading_sessions s
         LEFT JOIN wiki_reading_chunks c ON c.session_id = s.session_id
        WHERE s.library_id = ?
        GROUP BY s.session_id
        ORDER BY s.session_id`,
      [libraryID],
    );
    const depths = new Map<string, "paper_reviewed" | "section_read">();
    for (const row of rows) {
      const itemKey = String(rowValue(row, "item_key", "itemKey") ?? "");
      if (!itemKey) continue;
      const mode = String(rowValue(row, "mode", "mode") ?? "fulltext");
      const total = Number(rowValue(row, "total_chunks", "totalChunks") ?? 0);
      const delivered = Number(rowValue(row, "delivered", "delivered") ?? 0);
      const synthesised =
        rowValue(row, "final_synthesis_at", "finalSynthesisAt") != null;
      const reviewed =
        mode === "fulltext" && synthesised && total > 0 && delivered >= total;
      // A paper may have several sessions over its life; the deepest reading
      // is the one that describes the state of knowledge about it.
      if (reviewed) depths.set(itemKey, "paper_reviewed");
      else if (!depths.has(itemKey)) depths.set(itemKey, "section_read");
    }
    return depths;
  }

  /**
   * Which documents each concept was read out of, with its rarity.
   *
   * The raw material for the shared-concept edges. `wiki_relations` joins
   * concepts to concepts and `wiki_evidence` joins claims to sources, so
   * neither can say that two PAPERS both discuss one concept - but the source
   * table has recorded exactly that all along, and nothing was reading it that
   * way. A concept behind two or more documents is a demonstrated connection
   * between them, with the passages that show it already stored.
   *
   * Aggregated per CONCEPT rather than per term. Two papers that use the
   * Chinese name and the English name of one thing share that thing, and
   * splitting them by term would hide the connection the concept library
   * exists to record.
   *
   * Rarity is what keeps this from drawing a complete graph. Every paper in a
   * metallurgy library discusses 再结晶; almost none discuss Lomer-Cottrell
   * 位错锁, and the second is worth far more as evidence that two papers are
   * about the same thing:
   *
   *     df(concept)  = documents this concept was read out of
   *     idf(concept) = log((N + 1) / (df + 1))
   *
   * N is the number of documents with ANY concept source, not the size of the
   * Zotero library. A Wiki covering five papers of nine hundred would
   * otherwise score every one of its concepts as vanishingly rare, which says
   * something about the import backlog rather than about the terms.
   *
   * Pairing and the hub cutoff are the caller's: this returns facts, and how
   * many of them to draw is a rendering decision.
   */
  async getConceptDocumentSources(libraryID: number): Promise<{
    documentCount: number;
    concepts: Array<{
      conceptId: number;
      name: string;
      df: number;
      idf: number;
      itemKeys: string[];
    }>;
  }> {
    await this.initialize();
    const rows = await this.db.queryAsync(
      `SELECT DISTINCT t.concept_id AS concept_id,
              c.canonical_name AS canonical_name,
              s.item_key AS item_key
         FROM wiki_concept_term_sources s
         JOIN wiki_concept_terms t ON t.term_id = s.term_id
         JOIN wiki_concepts c ON c.concept_id = t.concept_id
        WHERE s.library_id = ? AND c.library_id = ?
        ORDER BY t.concept_id, s.item_key`,
      [libraryID, libraryID],
    );
    const byConcept = new Map<
      number,
      { conceptId: number; name: string; itemKeys: Set<string> }
    >();
    const documents = new Set<string>();
    for (const row of rows) {
      const conceptId = Number(rowValue(row, "concept_id", "conceptId"));
      const itemKey = String(rowValue(row, "item_key", "itemKey") ?? "");
      if (!itemKey) continue;
      documents.add(itemKey);
      const entry =
        byConcept.get(conceptId) ??
        byConcept
          .set(conceptId, {
            conceptId,
            name: String(
              rowValue(row, "canonical_name", "canonicalName") ?? "",
            ),
            itemKeys: new Set<string>(),
          })
          .get(conceptId)!;
      entry.itemKeys.add(itemKey);
    }
    const documentCount = documents.size;
    const concepts = Array.from(byConcept.values())
      .map((entry) => {
        const df = entry.itemKeys.size;
        return {
          conceptId: entry.conceptId,
          name: entry.name,
          df,
          idf: Math.log((documentCount + 1) / (df + 1)),
          itemKeys: Array.from(entry.itemKeys).sort(),
        };
      })
      // Rarest first, so a caller that truncates keeps what discriminates.
      .sort(
        (left, right) => right.idf - left.idf || left.conceptId - right.conceptId,
      );
    return { documentCount, concepts };
  }

  async getDocumentGraph(libraryID: number): Promise<{
    nodes: Array<{ itemKey: string; claimCount: number; conceptCount: number }>;
    edges: Array<{
      source: string;
      target: string;
      strength: number;
      claimIds: number[];
      relations: string[];
    }>;
  }> {
    const snapshot = await this.getRetrievalSnapshot(libraryID);
    const claims = new Map(
      snapshot.claims.map((row) => [
        Number(rowValue(row, "claim_id", "claimId")),
        row,
      ]),
    );
    const pages = new Map(
      snapshot.pages.map((row) => [
        Number(rowValue(row, "page_id", "pageId")),
        row,
      ]),
    );
    const itemClaims = new Map<string, Set<number>>();
    const claimItems = new Map<number, Set<string>>();
    const claimItemRoles = new Map<number, Map<string, Set<string>>>();
    for (const row of snapshot.evidence) {
      if (rowValue(row, "link_state", "linkState") !== "valid") continue;
      const itemKey = String(rowValue(row, "item_key", "itemKey"));
      const claimId = Number(rowValue(row, "claim_id", "claimId"));
      (
        itemClaims.get(itemKey) ??
        itemClaims.set(itemKey, new Set()).get(itemKey)!
      ).add(claimId);
      (
        claimItems.get(claimId) ??
        claimItems.set(claimId, new Set()).get(claimId)!
      ).add(itemKey);
      const rolesByItem =
        claimItemRoles.get(claimId) ??
        claimItemRoles.set(claimId, new Map()).get(claimId)!;
      const roles = rolesByItem.get(itemKey) ?? new Set<string>();
      roles.add(String(rowValue(row, "evidence_role", "evidenceRole")));
      rolesByItem.set(itemKey, roles);
    }
    const edges = new Map<
      string,
      {
        source: string;
        target: string;
        strength: number;
        claimIds: number[];
        relations: string[];
      }
    >();
    for (const [claimId, items] of claimItems) {
      const ordered = Array.from(items).sort();
      for (let left = 0; left < ordered.length; left += 1) {
        for (let right = left + 1; right < ordered.length; right += 1) {
          const key = `${ordered[left]}\u0000${ordered[right]}`;
          const edge = edges.get(key) ?? {
            source: ordered[left],
            target: ordered[right],
            strength: 0,
            claimIds: [],
            relations: [],
          };
          edge.strength += 1;
          edge.claimIds.push(claimId);
          const leftRoles =
            claimItemRoles.get(claimId)?.get(ordered[left]) ?? new Set();
          const rightRoles =
            claimItemRoles.get(claimId)?.get(ordered[right]) ?? new Set();
          for (const role of new Set([...leftRoles, ...rightRoles])) {
            if (!edge.relations.includes(role)) edge.relations.push(role);
          }
          for (const leftRole of leftRoles) {
            for (const rightRole of rightRoles) {
              if (leftRole === rightRole) continue;
              const relation = `${leftRole}<->${rightRole}`;
              if (!edge.relations.includes(relation))
                edge.relations.push(relation);
            }
          }
          edges.set(key, edge);
        }
      }
    }
    return {
      nodes: Array.from(itemClaims, ([itemKey, claimIds]) => ({
        itemKey,
        claimCount: claimIds.size,
        conceptCount: new Set(
          Array.from(claimIds).map((claimId) =>
            rowValue(
              pages.get(
                Number(rowValue(claims.get(claimId), "page_id", "pageId")),
              ),
              "primary_concept_id",
              "primaryConceptId",
            ),
          ),
        ).size,
      })),
      edges: Array.from(edges.values()).sort((a, b) => b.strength - a.strength),
    };
  }

  async markResetPending(
    resetGeneration: string,
    libraryID?: number,
  ): Promise<number> {
    await this.initialize();
    const where = libraryID === undefined ? "" : " AND library_id = ?";
    const params: unknown[] = [resetGeneration];
    if (libraryID !== undefined) params.push(libraryID);
    const count = Number(
      await this.db.valueQueryAsync(
        `SELECT COUNT(*) FROM wiki_evidence WHERE link_state != 'source_deleted'${where}`,
        libraryID === undefined ? [] : [libraryID],
      ),
    );
    await this.db.queryAsync(
      `UPDATE wiki_evidence SET link_state = 'pending_relink', source_reset_generation = ?
       WHERE link_state != 'source_deleted'${where}`,
      params,
    );
    await this.refreshDerivedForEvidence(
      libraryID === undefined ? "1 = 1" : "e.library_id = ?",
      libraryID === undefined ? [] : [libraryID],
    );
    return count;
  }

  async markItemsPending(
    resetGeneration: string,
    libraryID: number,
    itemKeys: string[],
  ): Promise<number> {
    await this.initialize();
    const keys = Array.from(
      new Set(itemKeys.map((itemKey) => itemKey.trim()).filter(Boolean)),
    );
    if (!keys.length) return 0;
    const placeholders = keys.map(() => "?").join(",");
    const params = [libraryID, ...keys];
    const count = Number(
      await this.db.valueQueryAsync(
        `SELECT COUNT(*) FROM wiki_evidence
         WHERE library_id = ? AND item_key IN (${placeholders})`,
        params,
      ),
    );
    await this.db.queryAsync(
      `UPDATE wiki_evidence SET link_state = 'pending_relink',
       source_reset_generation = ?
       WHERE library_id = ? AND item_key IN (${placeholders})
      `,
      [resetGeneration, ...params],
    );
    await this.refreshDerivedForEvidence(
      `e.library_id = ? AND e.item_key IN (${placeholders})`,
      params,
    );
    return count;
  }

  private buildEvidenceScope(
    linkStateWhere: string,
    libraryID?: number,
    itemKeys?: string[],
  ): { where: string; params: unknown[] } | null {
    const keys = itemKeys
      ? Array.from(new Set(itemKeys.map((key) => key.trim()).filter(Boolean)))
      : undefined;
    if (keys && !keys.length) return null;
    const params: unknown[] = [];
    let where = ` WHERE ${linkStateWhere}`;
    if (libraryID !== undefined) {
      where += " AND library_id = ?";
      params.push(libraryID);
    }
    if (keys) {
      where += ` AND item_key IN (${keys.map(() => "?").join(",")})`;
      params.push(...keys);
    }
    return { where, params };
  }

  async listEvidenceForRelink(
    libraryID?: number,
    itemKeys?: string[],
  ): Promise<WikiEvidenceRecord[]> {
    await this.initialize();
    const scope = this.buildEvidenceScope(
      "link_state IN ('pending_relink','stale')",
      libraryID,
      itemKeys,
    );
    if (!scope) return [];
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_evidence${scope.where} ORDER BY evidence_id`,
      scope.params,
    );
    return rows.map((row) => this.mapEvidence(row));
  }

  async listDeletedEvidenceSources(
    libraryID?: number,
    itemKeys?: string[],
  ): Promise<Array<{ libraryID: number; itemKey: string }>> {
    await this.initialize();
    const scope = this.buildEvidenceScope(
      "link_state = 'source_deleted'",
      libraryID,
      itemKeys,
    );
    if (!scope) return [];
    const rows = await this.db.queryAsync(
      `SELECT DISTINCT library_id, item_key FROM wiki_evidence
       ${scope.where} ORDER BY library_id, item_key`,
      scope.params,
    );
    return rows.map((row) => ({
      libraryID: Number(rowValue(row, "library_id", "libraryID")),
      itemKey: String(rowValue(row, "item_key", "itemKey")),
    }));
  }

  async updateEvidenceLink(
    evidenceId: number,
    update: {
      chunkIdSnapshot: number;
      chunkTextHash: string;
      sourceContentHash: string;
      sourceChunkSignature: string;
      sourceResetGeneration: string;
      linkState: "valid" | "stale" | "source_deleted";
    },
    options: { deferDerivedUpdates?: boolean } = {},
  ): Promise<void> {
    await this.initialize();
    await this.db.queryAsync(
      `UPDATE wiki_evidence SET chunk_id_snapshot = ?, chunk_text_hash = ?,
       source_content_hash = ?, source_chunk_signature = ?,
       source_reset_generation = ?, link_state = ?, last_verified_at = ?
       WHERE evidence_id = ?`,
      [
        update.chunkIdSnapshot,
        update.chunkTextHash,
        update.sourceContentHash,
        update.sourceChunkSignature,
        update.sourceResetGeneration,
        update.linkState,
        Date.now(),
        evidenceId,
      ],
    );
    if (!options.deferDerivedUpdates) {
      await this.refreshDerivedForEvidence("e.evidence_id = ?", [evidenceId]);
    }
  }

  async finalizeEvidenceRelink(evidenceIds: number[]): Promise<void> {
    await this.initialize();
    const ids = Array.from(
      new Set(evidenceIds.filter((id) => Number.isInteger(id) && id > 0)),
    );
    if (!ids.length) return;
    const placeholders = ids.map(() => "?").join(",");
    await this.refreshDerivedForEvidence(
      `e.evidence_id IN (${placeholders})`,
      ids,
    );
  }

  private async recomputeClaimStatus(claimId: number): Promise<void> {
    const rows = await this.db.queryAsync(
      `SELECT evidence_role, library_id, item_key
       FROM wiki_evidence
       WHERE claim_id = ? AND link_state IN ('valid', 'source_deleted')`,
      [claimId],
    );
    const supportingSources = new Set<string>();
    let contradicts = false;
    for (const row of rows) {
      const role = String(rowValue(row, "evidence_role", "evidenceRole"));
      if (role === "SUPPORTS") {
        supportingSources.add(
          `${rowValue(row, "library_id", "libraryID")}:${rowValue(
            row,
            "item_key",
            "itemKey",
          )}`,
        );
      } else if (role === "CONTRADICTS") {
        contradicts = true;
      }
    }
    const nextStatus =
      rows.length === 0
        ? "unsupported"
        : contradicts
          ? "disputed"
          : supportingSources.size >= 2
            ? "corroborated"
            : supportingSources.size === 1
              ? "supported"
              : "provisional";
    await this.db.queryAsync(
      `UPDATE wiki_claims SET epistemic_status = ?, updated_at = ?, version = version + 1
       WHERE claim_id = ? AND epistemic_status != ?`,
      [nextStatus, Date.now(), claimId, nextStatus],
    );
  }

  async markSourceDeleted(libraryID: number, itemKey: string): Promise<number> {
    await this.initialize();
    const rows = await this.db.queryAsync(
      "SELECT evidence_id FROM wiki_evidence WHERE library_id = ? AND item_key = ? AND link_state != 'source_deleted'",
      [libraryID, itemKey],
    );
    for (const row of rows) {
      await this.updateEvidenceLink(
        Number(rowValue(row, "evidence_id", "evidenceId")),
        {
          chunkIdSnapshot: Number(
            await this.db.valueQueryAsync(
              "SELECT chunk_id_snapshot FROM wiki_evidence WHERE evidence_id = ?",
              [rowValue(row, "evidence_id", "evidenceId")],
            ),
          ),
          chunkTextHash: String(
            await this.db.valueQueryAsync(
              "SELECT chunk_text_hash FROM wiki_evidence WHERE evidence_id = ?",
              [rowValue(row, "evidence_id", "evidenceId")],
            ),
          ),
          sourceContentHash: String(
            await this.db.valueQueryAsync(
              "SELECT source_content_hash FROM wiki_evidence WHERE evidence_id = ?",
              [rowValue(row, "evidence_id", "evidenceId")],
            ),
          ),
          sourceChunkSignature: String(
            await this.db.valueQueryAsync(
              "SELECT source_chunk_signature FROM wiki_evidence WHERE evidence_id = ?",
              [rowValue(row, "evidence_id", "evidenceId")],
            ),
          ),
          sourceResetGeneration: String(
            await this.db.valueQueryAsync(
              "SELECT source_reset_generation FROM wiki_evidence WHERE evidence_id = ?",
              [rowValue(row, "evidence_id", "evidenceId")],
            ),
          ),
          linkState: "source_deleted",
        },
        { deferDerivedUpdates: true },
      );
    }
    await this.refreshDerivedForEvidence(
      "e.library_id = ? AND e.item_key = ?",
      [libraryID, itemKey],
    );
    return rows.length;
  }

  async close(): Promise<void> {
    await this.db.closeDatabase?.();
  }
}

let singleton: WikiStore | null = null;

export function getWikiStore(): WikiStore {
  if (!singleton) {
    const dbPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "zotero-mcp-wiki.sqlite",
    );
    singleton = new WikiStore(new Zotero.DBConnection(dbPath));
    ztoolkit.log(`[WikiStore] independent database: ${dbPath}`);
  }
  return singleton;
}

export async function resetWikiStore(): Promise<void> {
  const current = singleton;
  singleton = null;
  await current?.close();
}
