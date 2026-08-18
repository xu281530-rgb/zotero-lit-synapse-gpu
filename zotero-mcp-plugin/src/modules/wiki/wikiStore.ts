import {
  hashWikiText,
  normalizeWikiName,
  normalizeWikiText,
} from "./wikiCanonicalizer";
import { ensureWikiSchema } from "./wikiSchema";
import type {
  WikiClaimRecord,
  WikiCommitAction,
  WikiCommitInput,
  WikiCommitResult,
  WikiDatabase,
  WikiEvidenceInput,
  WikiEvidenceRecord,
  WikiPageRecord,
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

function rowValue(row: any, snake: string, camel: string): any {
  return row?.[snake] ?? row?.[camel];
}

export class WikiStore {
  private initialized = false;
  private readonly db: WikiDatabase;

  constructor(db: WikiDatabase) {
    this.db = db;
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
          entry.readDepth,
          Date.now(),
          Date.now(),
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
      let deepest = "chunk_local";
      for (const row of evidenceRows) {
        const count = Number(row.count ?? 0);
        const role = String(rowValue(row, "evidence_role", "evidenceRole"));
        const state = String(rowValue(row, "link_state", "linkState"));
        const depth = String(rowValue(row, "read_depth", "readDepth"));
        roleCounts.set(role, (roleCounts.get(role) ?? 0) + count);
        stateCounts.set(state, (stateCounts.get(state) ?? 0) + count);
        if (depthOrder.indexOf(depth) > depthOrder.indexOf(deepest)) {
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
      parts.push(`Evidence: ${roles} (${states}; deepest ${deepest}).`);
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
      attachedEvidence: 0,
      updatedClaims: 0,
      linkedRelations: 0,
      refs: {},
      affectedClaimIds: [],
    };
    const affectedPageIds = new Set<number>();

    await this.db.executeTransaction(async () => {
      for (const action of input.actions) {
        if (action.action === "SKIP") continue;
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
          const knowledgeDuplicate = Number(
            await this.db.valueQueryAsync(
              `SELECT COUNT(*) FROM (
                 SELECT concept_id AS id FROM wiki_concepts
                 WHERE library_id = ? AND normalized_name = ?
                 UNION ALL
                 SELECT a.alias_id AS id FROM wiki_aliases a
                 JOIN wiki_concepts c ON c.concept_id = a.concept_id
                 WHERE c.library_id = ? AND a.normalized_alias = ?
                 UNION ALL
                 SELECT cl.claim_id AS id FROM wiki_claims cl
                 JOIN wiki_pages p ON p.page_id = cl.page_id
                 WHERE p.library_id = ? AND cl.normalized_claim_text = ?
               )`,
              [
                input.libraryID,
                normalizedTitle,
                input.libraryID,
                normalizedTitle,
                input.libraryID,
                normalizedTitle,
              ],
            ),
          );
          if (knowledgeDuplicate) {
            throw new Error(
              `Wiki page title matches existing Concept, Alias, or Claim: ${canonicalTitle}`,
            );
          }
          const primaryConceptId = action.primaryConcept
            ? await this.createConcept(input.libraryID, action.primaryConcept)
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
                `Concept already has active Wiki Page ${Number(existingConceptPage)}`,
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
          const duplicate = Number(
            await this.db.valueQueryAsync(
              `SELECT COUNT(*) FROM wiki_claims c
               JOIN wiki_pages p ON p.page_id = c.page_id
               WHERE p.library_id = ? AND c.normalized_claim_text = ?`,
              [input.libraryID, normalizedClaim],
            ),
          );
          if (duplicate)
            throw new Error(
              "An equivalent Claim already exists in this Wiki library",
            );
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
          result.createdClaims += 1;
          result.affectedClaimIds.push(claimId);
          result.attachedEvidence += await this.attachEvidence(
            claimId,
            input.libraryID,
            action.evidence,
          );
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
            (coveragePromoted || statusPromoted) &&
            !action.evidence?.length
          ) {
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

      for (const pageId of affectedPageIds) {
        await this.refreshPageSummary(pageId);
      }
    });
    return result;
  }

  private mapEvidence(row: any): WikiEvidenceRecord {
    return {
      evidenceId: Number(rowValue(row, "evidence_id", "evidenceId")),
      claimId: Number(rowValue(row, "claim_id", "claimId")),
      libraryID: Number(rowValue(row, "library_id", "libraryID")),
      itemKey: String(rowValue(row, "item_key", "itemKey")),
      chunkIdSnapshot: Number(
        rowValue(row, "chunk_id_snapshot", "chunkIdSnapshot"),
      ),
      chunkTextHash: String(rowValue(row, "chunk_text_hash", "chunkTextHash")),
      sourceContentHash: String(
        rowValue(row, "source_content_hash", "sourceContentHash"),
      ),
      sourceChunkSignature: String(
        rowValue(row, "source_chunk_signature", "sourceChunkSignature"),
      ),
      sourceResetGeneration: String(
        rowValue(row, "source_reset_generation", "sourceResetGeneration"),
      ),
      excerptHash: String(rowValue(row, "excerpt_hash", "excerptHash")),
      excerpt: String(row.excerpt),
      evidenceRole: rowValue(row, "evidence_role", "evidenceRole"),
      readDepth: rowValue(row, "read_depth", "readDepth"),
      linkState: rowValue(row, "link_state", "linkState"),
      createdAt: Number(rowValue(row, "created_at", "createdAt")),
      lastVerifiedAt:
        rowValue(row, "last_verified_at", "lastVerifiedAt") == null
          ? null
          : Number(rowValue(row, "last_verified_at", "lastVerifiedAt")),
    };
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
      evidence: Number(
        await this.db.valueQueryAsync(
          libraryID === undefined
            ? "SELECT COUNT(*) FROM wiki_evidence"
            : `SELECT COUNT(*) FROM wiki_evidence e JOIN wiki_claims c ON c.claim_id = e.claim_id
               JOIN wiki_pages p ON p.page_id = c.page_id WHERE p.library_id = ?`,
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
    };
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
      }
      for (const alias of options.addAliases ?? []) {
        const value = normalizeWikiText(alias.alias);
        if (!value) continue;
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
      for (const aliasId of options.removeAliasIds ?? []) {
        await this.db.queryAsync(
          "DELETE FROM wiki_aliases WHERE alias_id = ? AND concept_id = ?",
          [aliasId, options.conceptId],
        );
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

  async mergePages(
    sourcePageId: number,
    targetPageId: number,
    libraryID: number,
  ): Promise<void> {
    if (sourcePageId === targetPageId)
      throw new Error("Cannot merge a Wiki page into itself");
    await this.requirePage(sourcePageId, libraryID);
    await this.requirePage(targetPageId, libraryID);
    await this.db.executeTransaction(async () => {
      const claims = await this.db.queryAsync(
        "SELECT claim_id, normalized_claim_text FROM wiki_claims WHERE page_id = ?",
        [sourcePageId],
      );
      for (const row of claims) {
        const claimId = Number(rowValue(row, "claim_id", "claimId"));
        const duplicate = await this.db.valueQueryAsync(
          "SELECT claim_id FROM wiki_claims WHERE page_id = ? AND normalized_claim_text = ?",
          [
            targetPageId,
            rowValue(row, "normalized_claim_text", "normalizedClaimText"),
          ],
        );
        if (!duplicate) {
          await this.db.queryAsync(
            "UPDATE wiki_claims SET page_id = ?, updated_at = ?, version = version + 1 WHERE claim_id = ?",
            [targetPageId, Date.now(), claimId],
          );
          continue;
        }
        const evidence = await this.db.queryAsync(
          "SELECT * FROM wiki_evidence WHERE claim_id = ?",
          [claimId],
        );
        for (const item of evidence) {
          await this.db.queryAsync(
            `INSERT OR IGNORE INTO wiki_evidence
             (claim_id, library_id, item_key, chunk_id_snapshot, chunk_text_hash,
              source_content_hash, source_chunk_signature, source_reset_generation,
              excerpt_hash, excerpt, evidence_role, read_depth, link_state,
              created_at, last_verified_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              Number(duplicate),
              rowValue(item, "library_id", "libraryID"),
              rowValue(item, "item_key", "itemKey"),
              rowValue(item, "chunk_id_snapshot", "chunkIdSnapshot"),
              rowValue(item, "chunk_text_hash", "chunkTextHash"),
              rowValue(item, "source_content_hash", "sourceContentHash"),
              rowValue(item, "source_chunk_signature", "sourceChunkSignature"),
              rowValue(
                item,
                "source_reset_generation",
                "sourceResetGeneration",
              ),
              rowValue(item, "excerpt_hash", "excerptHash"),
              item.excerpt,
              rowValue(item, "evidence_role", "evidenceRole"),
              rowValue(item, "read_depth", "readDepth"),
              rowValue(item, "link_state", "linkState"),
              rowValue(item, "created_at", "createdAt"),
              rowValue(item, "last_verified_at", "lastVerifiedAt"),
            ],
          );
        }
        await this.db.queryAsync("DELETE FROM wiki_claims WHERE claim_id = ?", [
          claimId,
        ]);
      }
      await this.refreshPageSummary(targetPageId);
      await this.db.queryAsync("DELETE FROM wiki_pages WHERE page_id = ?", [
        sourcePageId,
      ]);
    });
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
      if (rowValue(row, "link_state", "linkState") === "source_deleted")
        continue;
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
    await this.refreshPagesForEvidence(
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
         WHERE library_id = ? AND item_key IN (${placeholders})
           AND link_state != 'source_deleted'`,
        params,
      ),
    );
    await this.db.queryAsync(
      `UPDATE wiki_evidence SET link_state = 'pending_relink',
       source_reset_generation = ?
       WHERE library_id = ? AND item_key IN (${placeholders})
         AND link_state != 'source_deleted'`,
      [resetGeneration, ...params],
    );
    await this.refreshPagesForEvidence(
      `e.library_id = ? AND e.item_key IN (${placeholders})`,
      params,
    );
    return count;
  }

  async listEvidenceForRelink(
    libraryID?: number,
  ): Promise<WikiEvidenceRecord[]> {
    await this.initialize();
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_evidence WHERE link_state IN ('pending_relink','stale')${
        libraryID === undefined ? "" : " AND library_id = ?"
      } ORDER BY evidence_id`,
      libraryID === undefined ? [] : [libraryID],
    );
    return rows.map((row) => this.mapEvidence(row));
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
    await this.recomputeClaimStatusForEvidence(evidenceId);
    await this.refreshPagesForEvidence("e.evidence_id = ?", [evidenceId]);
  }

  private async recomputeClaimStatusForEvidence(
    evidenceId: number,
  ): Promise<void> {
    const claimId = Number(
      await this.db.valueQueryAsync(
        "SELECT claim_id FROM wiki_evidence WHERE evidence_id = ?",
        [evidenceId],
      ),
    );
    if (!claimId) return;
    const valid = Number(
      await this.db.valueQueryAsync(
        "SELECT COUNT(*) FROM wiki_evidence WHERE claim_id = ? AND link_state != 'source_deleted'",
        [claimId],
      ),
    );
    if (valid === 0) {
      await this.db.queryAsync(
        "UPDATE wiki_claims SET epistemic_status = 'unsupported', updated_at = ?, version = version + 1 WHERE claim_id = ? AND epistemic_status != 'unsupported'",
        [Date.now(), claimId],
      );
    }
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
      );
    }
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
