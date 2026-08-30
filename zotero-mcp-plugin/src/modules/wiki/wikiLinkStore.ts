/**
 * Reading and writing the cross-paper link layer.
 *
 * The one rule that shapes every method here: `wiki_link_candidates.status` is
 * a CACHE, derived from the signals and resolutions under it, and it is
 * recomputed inside the same transaction as any change to them. Nothing sets a
 * status directly except {@link refreshStatus}. A status maintained by hand
 * would be wrong within a week - a new pending signal on a pair someone
 * dismissed last month has to reopen it, an accepted signal going stale has to
 * stop counting, and no caller is going to remember all six transitions.
 *
 * The derivation, in full:
 *
 *   source_deleted - either paper is gone. Terminal until it comes back.
 *   stale          - no signal is usable: every one is stale, and the pair has
 *                    no resolution to its name. It is not debt and not a
 *                    finding; it is waiting for a rescan.
 *   open           - at least one pending signal survives.
 *   dismissed      - nothing pending, at least one rejected, no resolution.
 *   resolved       - nothing pending and at least one resolution.
 *
 * `resolved` deliberately does NOT mean "this pair is understood". A pair may
 * hold a shared-claim resolution, a conflict resolution and a rejected piece
 * of boilerplate at the same time, and all three stay readable afterwards.
 */

import { hashWikiText } from "./wikiCanonicalizer";
import { rowColumn } from "./wikiRow";
import {
  normalizePair,
  signalFingerprint,
} from "./wikiLinkScoring";
import type {
  WikiLinkCandidateRecord,
  WikiLinkResolutionRecord,
  WikiLinkResolutionType,
  WikiLinkScanRecord,
  WikiLinkScanState,
  WikiLinkSignalInput,
  WikiLinkSignalRecord,
  WikiLinkSignalType,
  WikiLinkSignalWithPair,
  WikiLinkSourceFingerprint,
  WikiLinkStatistics,
  WikiLinkStatus,
} from "./wikiLinkTypes";
import { WIKI_LINK_SIGNAL_TYPES } from "./wikiLinkTypes";
import type { WikiDatabase } from "./wikiTypes";

declare let ztoolkit: ZToolkit;

const EMPTY_FINGERPRINT: WikiLinkSourceFingerprint = {
  contentHash: "",
  chunkSignature: "",
  resetGeneration: "",
};

function text(row: any, snake: string, camel: string): string {
  const value = rowColumn(row, snake, camel);
  return value == null ? "" : String(value);
}

function numberOrNull(row: any, snake: string, camel: string): number | null {
  const value = rowColumn(row, snake, camel);
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapCandidate(row: any): WikiLinkCandidateRecord {
  return {
    linkId: Number(rowColumn(row, "link_id", "linkId")),
    libraryID: Number(rowColumn(row, "library_id", "libraryID")),
    aItemKey: text(row, "a_item_key", "aItemKey"),
    bItemKey: text(row, "b_item_key", "bItemKey"),
    scoreAB: numberOrNull(row, "score_ab", "scoreAb"),
    scoreBA: numberOrNull(row, "score_ba", "scoreBa"),
    scoreSymmetric: numberOrNull(row, "score_symmetric", "scoreSymmetric"),
    status: text(row, "status", "status") as WikiLinkStatus,
    computedAt: Number(rowColumn(row, "computed_at", "computedAt") ?? 0),
    reviewedAt: numberOrNull(row, "reviewed_at", "reviewedAt"),
    a: {
      contentHash: text(row, "a_content_hash", "aContentHash"),
      chunkSignature: text(row, "a_chunk_signature", "aChunkSignature"),
      resetGeneration: text(row, "a_reset_generation", "aResetGeneration"),
    },
    b: {
      contentHash: text(row, "b_content_hash", "bContentHash"),
      chunkSignature: text(row, "b_chunk_signature", "bChunkSignature"),
      resetGeneration: text(row, "b_reset_generation", "bResetGeneration"),
    },
    semanticModel: text(row, "semantic_model", "semanticModel"),
    semanticDimensions: Number(
      rowColumn(row, "semantic_dimensions", "semanticDimensions") ?? 0,
    ),
    semanticAlgorithmVersion: text(
      row,
      "semantic_algorithm_version",
      "semanticAlgorithmVersion",
    ),
    semanticSelectorVersion: text(
      row,
      "semantic_selector_version",
      "semanticSelectorVersion",
    ),
  };
}

function mapSignal(row: any): WikiLinkSignalRecord {
  return {
    signalId: Number(rowColumn(row, "signal_id", "signalId")),
    linkId: Number(rowColumn(row, "link_id", "linkId")),
    signalType: text(row, "signal_type", "signalType") as WikiLinkSignalType,
    direction: text(row, "direction", "direction") as any,
    algorithmVersion: text(row, "algorithm_version", "algorithmVersion"),
    sourceModel: text(row, "source_model", "sourceModel"),
    signalFingerprint: text(row, "signal_fingerprint", "signalFingerprint"),
    score: Number(rowColumn(row, "score", "score") ?? 0),
    specificityWeight: numberOrNull(
      row,
      "specificity_weight",
      "specificityWeight",
    ),
    breadthDocs: numberOrNull(row, "breadth_docs", "breadthDocs"),
    termId: numberOrNull(row, "term_id", "termId"),
    termSnapshot: text(row, "term_snapshot", "termSnapshot"),
    a: {
      chunkIdSnapshot: numberOrNull(
        row,
        "a_chunk_id_snapshot",
        "aChunkIdSnapshot",
      ),
      chunkTextHash: text(row, "a_chunk_text_hash", "aChunkTextHash"),
      excerpt: text(row, "a_excerpt", "aExcerpt"),
      excerptHash: text(row, "a_excerpt_hash", "aExcerptHash"),
    },
    b: {
      chunkIdSnapshot: numberOrNull(
        row,
        "b_chunk_id_snapshot",
        "bChunkIdSnapshot",
      ),
      chunkTextHash: text(row, "b_chunk_text_hash", "bChunkTextHash"),
      excerpt: text(row, "b_excerpt", "bExcerpt"),
      excerptHash: text(row, "b_excerpt_hash", "bExcerptHash"),
    },
    state: text(row, "state", "state") as any,
    rejectedReason: text(row, "rejected_reason", "rejectedReason"),
    createdAt: Number(rowColumn(row, "created_at", "createdAt") ?? 0),
    settledAt: numberOrNull(row, "settled_at", "settledAt"),
  };
}

function mapScan(row: any): WikiLinkScanRecord {
  return {
    libraryID: Number(rowColumn(row, "library_id", "libraryID")),
    itemKey: text(row, "item_key", "itemKey"),
    state: text(row, "state", "state") as WikiLinkScanState,
    reason: text(row, "reason", "reason"),
    attempts: Number(rowColumn(row, "attempts", "attempts") ?? 0),
    lastError: text(row, "last_error", "lastError"),
    enqueuedAt: Number(rowColumn(row, "enqueued_at", "enqueuedAt") ?? 0),
    nextAttemptAt: Number(
      rowColumn(row, "next_attempt_at", "nextAttemptAt") ?? 0,
    ),
    startedAt: numberOrNull(row, "started_at", "startedAt"),
    finishedAt: numberOrNull(row, "finished_at", "finishedAt"),
    contentHash: text(row, "content_hash", "contentHash"),
    chunkSignature: text(row, "chunk_signature", "chunkSignature"),
    resetGeneration: text(row, "reset_generation", "resetGeneration"),
    selectorVersion: text(row, "selector_version", "selectorVersion"),
    algorithmVersion: text(row, "algorithm_version", "algorithmVersion"),
    embeddingModel: text(row, "embedding_model", "embeddingModel"),
    candidatesWritten: Number(
      rowColumn(row, "candidates_written", "candidatesWritten") ?? 0,
    ),
    signalsWritten: Number(
      rowColumn(row, "signals_written", "signalsWritten") ?? 0,
    ),
  };
}

export interface WikiLinkCandidateInput {
  libraryID: number;
  /** Either order; the store normalises. */
  itemKeyA: string;
  itemKeyB: string;
  scoreAB?: number | null;
  scoreBA?: number | null;
  scoreSymmetric?: number | null;
  fingerprintA?: WikiLinkSourceFingerprint;
  fingerprintB?: WikiLinkSourceFingerprint;
  semanticModel?: string;
  semanticDimensions?: number;
  semanticAlgorithmVersion?: string;
  semanticSelectorVersion?: string;
}

export class WikiLinkStore {
  private readonly db: WikiDatabase;

  constructor(db: WikiDatabase) {
    this.db = db;
  }

  // ---- Candidates ---------------------------------------------------------

  /**
   * Create or refresh the container for one pair.
   *
   * Scores and fingerprints are written only when the caller supplies them, so
   * a concept-derived pair - which has no vector model and no selector - does
   * not blank out the semantic metadata a previous scan wrote. That asymmetry
   * is in the design: not every discovery path has every field.
   */
  async upsertCandidate(input: WikiLinkCandidateInput): Promise<number> {
    const { aItemKey, bItemKey, swapped } = normalizePair(
      String(input.itemKeyA),
      String(input.itemKeyB),
    );
    if (aItemKey === bItemKey) {
      throw new Error("A link candidate needs two different documents");
    }
    // The caller thinks in "query side / candidate side"; the row thinks in
    // a/b. Swapping here rather than at every call site is what makes a pair
    // discovered from B identical to the same pair discovered from A.
    const scoreAB = swapped ? input.scoreBA : input.scoreAB;
    const scoreBA = swapped ? input.scoreAB : input.scoreBA;
    const fingerprintA = (swapped ? input.fingerprintB : input.fingerprintA) ??
      EMPTY_FINGERPRINT;
    const fingerprintB = (swapped ? input.fingerprintA : input.fingerprintB) ??
      EMPTY_FINGERPRINT;
    const now = Date.now();

    await this.db.queryAsync(
      `INSERT INTO wiki_link_candidates
         (library_id, a_item_key, b_item_key, score_ab, score_ba, score_symmetric,
          status, computed_at,
          a_content_hash, a_chunk_signature, a_reset_generation,
          b_content_hash, b_chunk_signature, b_reset_generation,
          semantic_model, semantic_dimensions,
          semantic_algorithm_version, semantic_selector_version)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(library_id, a_item_key, b_item_key) DO UPDATE SET
         score_ab = COALESCE(excluded.score_ab, wiki_link_candidates.score_ab),
         score_ba = COALESCE(excluded.score_ba, wiki_link_candidates.score_ba),
         score_symmetric = COALESCE(excluded.score_symmetric, wiki_link_candidates.score_symmetric),
         computed_at = excluded.computed_at,
         a_content_hash = CASE WHEN excluded.a_content_hash = '' THEN wiki_link_candidates.a_content_hash ELSE excluded.a_content_hash END,
         a_chunk_signature = CASE WHEN excluded.a_chunk_signature = '' THEN wiki_link_candidates.a_chunk_signature ELSE excluded.a_chunk_signature END,
         a_reset_generation = CASE WHEN excluded.a_reset_generation = '' THEN wiki_link_candidates.a_reset_generation ELSE excluded.a_reset_generation END,
         b_content_hash = CASE WHEN excluded.b_content_hash = '' THEN wiki_link_candidates.b_content_hash ELSE excluded.b_content_hash END,
         b_chunk_signature = CASE WHEN excluded.b_chunk_signature = '' THEN wiki_link_candidates.b_chunk_signature ELSE excluded.b_chunk_signature END,
         b_reset_generation = CASE WHEN excluded.b_reset_generation = '' THEN wiki_link_candidates.b_reset_generation ELSE excluded.b_reset_generation END,
         semantic_model = CASE WHEN excluded.semantic_model = '' THEN wiki_link_candidates.semantic_model ELSE excluded.semantic_model END,
         semantic_dimensions = CASE WHEN excluded.semantic_dimensions = 0 THEN wiki_link_candidates.semantic_dimensions ELSE excluded.semantic_dimensions END,
         semantic_algorithm_version = CASE WHEN excluded.semantic_algorithm_version = '' THEN wiki_link_candidates.semantic_algorithm_version ELSE excluded.semantic_algorithm_version END,
         semantic_selector_version = CASE WHEN excluded.semantic_selector_version = '' THEN wiki_link_candidates.semantic_selector_version ELSE excluded.semantic_selector_version END`,
      [
        input.libraryID,
        aItemKey,
        bItemKey,
        scoreAB ?? null,
        scoreBA ?? null,
        input.scoreSymmetric ?? null,
        now,
        fingerprintA.contentHash,
        fingerprintA.chunkSignature,
        fingerprintA.resetGeneration,
        fingerprintB.contentHash,
        fingerprintB.chunkSignature,
        fingerprintB.resetGeneration,
        input.semanticModel ?? "",
        input.semanticDimensions ?? 0,
        input.semanticAlgorithmVersion ?? "",
        input.semanticSelectorVersion ?? "",
      ],
    );
    return Number(
      await this.db.valueQueryAsync(
        `SELECT link_id FROM wiki_link_candidates
          WHERE library_id = ? AND a_item_key = ? AND b_item_key = ?`,
        [input.libraryID, aItemKey, bItemKey],
      ),
    );
  }

  async getCandidate(linkId: number): Promise<WikiLinkCandidateRecord | null> {
    const rows = await this.db.queryAsync(
      "SELECT * FROM wiki_link_candidates WHERE link_id = ?",
      [linkId],
    );
    return rows[0] ? mapCandidate(rows[0]) : null;
  }

  /** Every pair one paper takes part in, whichever side it sits on. */
  async candidatesForItem(
    libraryID: number,
    itemKey: string,
    statuses?: readonly WikiLinkStatus[],
  ): Promise<WikiLinkCandidateRecord[]> {
    const filter = statuses?.length
      ? ` AND status IN (${statuses.map(() => "?").join(",")})`
      : "";
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_link_candidates
        WHERE library_id = ? AND (a_item_key = ? OR b_item_key = ?)${filter}
        ORDER BY score_symmetric DESC, link_id`,
      [libraryID, itemKey, itemKey, ...(statuses ?? [])],
    );
    return rows.map(mapCandidate);
  }

  async listCandidates(
    libraryID: number,
    statuses?: readonly WikiLinkStatus[],
  ): Promise<WikiLinkCandidateRecord[]> {
    const filter = statuses?.length
      ? ` AND status IN (${statuses.map(() => "?").join(",")})`
      : "";
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_link_candidates WHERE library_id = ?${filter}
        ORDER BY score_symmetric DESC, link_id`,
      [libraryID, ...(statuses ?? [])],
    );
    return rows.map(mapCandidate);
  }

  // ---- Signals ------------------------------------------------------------

  /**
   * Write signals for one pair, capped per type, and refresh the status.
   *
   * `INSERT OR IGNORE` against the fingerprint unique index is what stops a
   * rescan from doubling every finding: the same discovery, computed twice by
   * the same algorithm over the same text, is one signal.
   *
   * The per-type cap is applied AFTER insertion rather than by refusing rows,
   * because "keep the best three" needs to compare a new signal against the
   * ones already stored - a scan run in two halves must not keep three from
   * each half. Only `pending` rows are trimmed: a signal somebody accepted or
   * rejected is a record of a decision and outlives any cap.
   */
  async recordSignals(options: {
    linkId: number;
    signals: readonly WikiLinkSignalInput[];
    /** Per pair, per signal type. */
    cap: number;
  }): Promise<{ written: number; trimmed: number }> {
    let written = 0;
    const touchedTypes = new Set<WikiLinkSignalType>();
    const now = Date.now();
    for (const signal of options.signals) {
      const a = signal.a ?? {};
      const b = signal.b ?? {};
      const aExcerpt = String(a.excerpt ?? "");
      const bExcerpt = String(b.excerpt ?? "");
      const aExcerptHash =
        a.excerptHash ?? (aExcerpt ? await hashWikiText(aExcerpt) : "");
      const bExcerptHash =
        b.excerptHash ?? (bExcerpt ? await hashWikiText(bExcerpt) : "");
      const fingerprint = signalFingerprint({
        signalType: signal.signalType,
        algorithmVersion: signal.algorithmVersion,
        direction: signal.direction,
        sourceModel: signal.sourceModel,
        termSnapshot: signal.termSnapshot,
        aChunkTextHash: a.chunkTextHash,
        bChunkTextHash: b.chunkTextHash,
        aExcerptHash,
        bExcerptHash,
      });
      const before = Number(
        await this.db.valueQueryAsync(
          "SELECT COUNT(*) FROM wiki_link_signals WHERE link_id = ?",
          [options.linkId],
        ),
      );
      await this.db.queryAsync(
        `INSERT OR IGNORE INTO wiki_link_signals
           (link_id, signal_type, direction, algorithm_version, source_model,
            signal_fingerprint, score, specificity_weight, breadth_docs,
            term_id, term_snapshot,
            a_chunk_id_snapshot, b_chunk_id_snapshot,
            a_chunk_text_hash, b_chunk_text_hash,
            a_excerpt, b_excerpt, a_excerpt_hash, b_excerpt_hash,
            state, rejected_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?)`,
        [
          options.linkId,
          signal.signalType,
          signal.direction,
          signal.algorithmVersion,
          signal.sourceModel ?? "",
          fingerprint,
          signal.score,
          signal.specificityWeight ?? null,
          signal.breadthDocs ?? null,
          signal.termId ?? null,
          signal.termSnapshot ?? "",
          a.chunkIdSnapshot ?? null,
          b.chunkIdSnapshot ?? null,
          a.chunkTextHash ?? "",
          b.chunkTextHash ?? "",
          aExcerpt,
          bExcerpt,
          aExcerptHash,
          bExcerptHash,
          now,
        ],
      );
      const after = Number(
        await this.db.valueQueryAsync(
          "SELECT COUNT(*) FROM wiki_link_signals WHERE link_id = ?",
          [options.linkId],
        ),
      );
      if (after > before) {
        written += 1;
        touchedTypes.add(signal.signalType);
      }
    }
    let trimmed = 0;
    for (const type of touchedTypes) {
      trimmed += await this.trimSignals(options.linkId, type, options.cap);
    }
    await this.refreshStatus(options.linkId);
    return { written, trimmed };
  }

  /** Keep the `cap` highest-scoring PENDING signals of one type. */
  private async trimSignals(
    linkId: number,
    signalType: WikiLinkSignalType,
    cap: number,
  ): Promise<number> {
    const rows = await this.db.queryAsync(
      `SELECT signal_id FROM wiki_link_signals
        WHERE link_id = ? AND signal_type = ? AND state = 'pending'
        ORDER BY score DESC, signal_id
        LIMIT -1 OFFSET ?`,
      [linkId, signalType, Math.max(0, Math.floor(cap))],
    );
    let trimmed = 0;
    for (const row of rows) {
      await this.db.queryAsync(
        "DELETE FROM wiki_link_signals WHERE signal_id = ?",
        [Number(rowColumn(row, "signal_id", "signalId"))],
      );
      trimmed += 1;
    }
    return trimmed;
  }

  async getSignal(signalId: number): Promise<WikiLinkSignalWithPair | null> {
    const rows = await this.db.queryAsync(
      `SELECT s.*, c.library_id, c.a_item_key, c.b_item_key,
              c.score_ab, c.score_ba, c.score_symmetric, c.status AS candidate_status
         FROM wiki_link_signals s
         JOIN wiki_link_candidates c ON c.link_id = s.link_id
        WHERE s.signal_id = ?`,
      [signalId],
    );
    return rows[0] ? this.mapSignalWithPair(rows[0]) : null;
  }

  private mapSignalWithPair(row: any): WikiLinkSignalWithPair {
    return {
      ...mapSignal(row),
      libraryID: Number(rowColumn(row, "library_id", "libraryID")),
      aItemKey: text(row, "a_item_key", "aItemKey"),
      bItemKey: text(row, "b_item_key", "bItemKey"),
      scoreAB: numberOrNull(row, "score_ab", "scoreAb"),
      scoreBA: numberOrNull(row, "score_ba", "scoreBa"),
      scoreSymmetric: numberOrNull(row, "score_symmetric", "scoreSymmetric"),
      candidateStatus: text(
        row,
        "candidate_status",
        "candidateStatus",
      ) as WikiLinkStatus,
    };
  }

  /**
   * Pending signals touching one paper.
   *
   * `chunkIds` narrows to the passages a turn actually read, which is what a
   * question-driven write-up wants: floating every candidate in the library
   * because one of them happens to mention this paper is how a five-chunk
   * question turns into a forty-item checklist.
   */
  async pendingSignalsForItem(options: {
    libraryID: number;
    itemKey: string;
    chunkIds?: readonly number[];
    limit?: number;
  }): Promise<WikiLinkSignalWithPair[]> {
    const params: unknown[] = [
      options.libraryID,
      options.itemKey,
      options.itemKey,
    ];
    let chunkFilter = "";
    if (options.chunkIds?.length) {
      const placeholders = options.chunkIds.map(() => "?").join(",");
      chunkFilter =
        ` AND ((c.a_item_key = ? AND s.a_chunk_id_snapshot IN (${placeholders}))` +
        ` OR (c.b_item_key = ? AND s.b_chunk_id_snapshot IN (${placeholders})))`;
      params.push(
        options.itemKey,
        ...options.chunkIds,
        options.itemKey,
        ...options.chunkIds,
      );
    }
    const rows = await this.db.queryAsync(
      `SELECT s.*, c.library_id, c.a_item_key, c.b_item_key,
              c.score_ab, c.score_ba, c.score_symmetric, c.status AS candidate_status
         FROM wiki_link_signals s
         JOIN wiki_link_candidates c ON c.link_id = s.link_id
        WHERE c.library_id = ?
          AND c.status NOT IN ('source_deleted')
          AND (c.a_item_key = ? OR c.b_item_key = ?)
          AND s.state = 'pending'${chunkFilter}
        ORDER BY c.score_symmetric DESC, s.score DESC, s.signal_id
        LIMIT ?`,
      [...params, Math.max(1, Math.floor(options.limit ?? 50))],
    );
    return rows.map((row) => this.mapSignalWithPair(row));
  }

  /** Accept signals as part of a knowledge write. */
  async acceptSignals(signalIds: readonly number[]): Promise<number> {
    return this.settle(signalIds, "accepted", "");
  }

  /** Reject signals, each keeping the reason permanently. */
  async rejectSignals(
    signalIds: readonly number[],
    reason: string,
  ): Promise<number> {
    return this.settle(signalIds, "rejected", reason);
  }

  private async settle(
    signalIds: readonly number[],
    state: "accepted" | "rejected",
    reason: string,
  ): Promise<number> {
    let settled = 0;
    const links = new Set<number>();
    for (const rawId of signalIds) {
      const signalId = Number(rawId);
      const linkId = await this.db.valueQueryAsync(
        "SELECT link_id FROM wiki_link_signals WHERE signal_id = ? AND state = 'pending'",
        [signalId],
      );
      if (linkId == null) continue;
      await this.db.queryAsync(
        `UPDATE wiki_link_signals
            SET state = ?, rejected_reason = ?, settled_at = ?
          WHERE signal_id = ? AND state = 'pending'`,
        [state, reason, Date.now(), signalId],
      );
      links.add(Number(linkId));
      settled += 1;
    }
    for (const linkId of links) await this.refreshStatus(linkId);
    return settled;
  }

  // ---- Resolutions --------------------------------------------------------

  /**
   * Record what a knowledge write settled, and accept the signals behind it.
   *
   * One resolution may cover several signals, which is the common case: two
   * papers found similar through three passages usually produce ONE shared
   * Claim, and recording that as three separate settlements would misstate
   * what happened.
   */
  async recordResolution(options: {
    linkId: number;
    resolutionType: WikiLinkResolutionType;
    signalIds: readonly number[];
    claimId?: number | null;
    pageId?: number | null;
    relationId?: number | null;
    note: string;
  }): Promise<number> {
    await this.db.queryAsync(
      `INSERT INTO wiki_link_resolutions
         (link_id, resolution_type, claim_id, page_id, relation_id,
          resolution_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        options.linkId,
        options.resolutionType,
        options.claimId ?? null,
        options.pageId ?? null,
        options.relationId ?? null,
        options.note,
        Date.now(),
      ],
    );
    const resolutionId = Number(
      await this.db.valueQueryAsync("SELECT last_insert_rowid()"),
    );
    for (const signalId of options.signalIds) {
      await this.db.queryAsync(
        `INSERT OR IGNORE INTO wiki_link_resolution_signals
           (resolution_id, signal_id) VALUES (?, ?)`,
        [resolutionId, Number(signalId)],
      );
    }
    // no_action is a rejection with a resolution row: the reason is kept in
    // both places because the audit reads resolutions and the debt reads
    // signals, and neither should have to join to answer its own question.
    if (options.resolutionType === "no_action") {
      await this.rejectSignals(options.signalIds, options.note);
    } else {
      await this.acceptSignals(options.signalIds);
    }
    await this.db.queryAsync(
      "UPDATE wiki_link_candidates SET reviewed_at = ? WHERE link_id = ?",
      [Date.now(), options.linkId],
    );
    await this.refreshStatus(options.linkId);
    return resolutionId;
  }

  async resolutionsFor(linkId: number): Promise<WikiLinkResolutionRecord[]> {
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_link_resolutions WHERE link_id = ? ORDER BY resolution_id`,
      [linkId],
    );
    const records: WikiLinkResolutionRecord[] = [];
    for (const row of rows) {
      const resolutionId = Number(
        rowColumn(row, "resolution_id", "resolutionId"),
      );
      const signalRows = await this.db.queryAsync(
        "SELECT signal_id FROM wiki_link_resolution_signals WHERE resolution_id = ?",
        [resolutionId],
      );
      records.push({
        resolutionId,
        linkId: Number(rowColumn(row, "link_id", "linkId")),
        resolutionType: text(
          row,
          "resolution_type",
          "resolutionType",
        ) as WikiLinkResolutionType,
        claimId: numberOrNull(row, "claim_id", "claimId"),
        pageId: numberOrNull(row, "page_id", "pageId"),
        relationId: numberOrNull(row, "relation_id", "relationId"),
        resolutionNote: text(row, "resolution_note", "resolutionNote"),
        createdAt: Number(rowColumn(row, "created_at", "createdAt") ?? 0),
        signalIds: signalRows.map((signalRow: any) =>
          Number(rowColumn(signalRow, "signal_id", "signalId")),
        ),
      });
    }
    return records;
  }

  // ---- Lifecycle ----------------------------------------------------------

  /** Recompute one pair's cached status. The only writer of `status`. */
  async refreshStatus(linkId: number): Promise<WikiLinkStatus> {
    const current = String(
      (await this.db.valueQueryAsync(
        "SELECT status FROM wiki_link_candidates WHERE link_id = ?",
        [linkId],
      )) ?? "",
    );
    if (!current) return "open";
    // A deleted source is not a state the signals can argue with.
    if (current === "source_deleted") return "source_deleted";

    const counts = await this.db.queryAsync(
      `SELECT state, COUNT(*) AS n FROM wiki_link_signals
        WHERE link_id = ? GROUP BY state`,
      [linkId],
    );
    const byState = new Map<string, number>();
    for (const row of counts) {
      byState.set(
        text(row, "state", "state"),
        Number(rowColumn(row, "n", "n") ?? 0),
      );
    }
    const resolutions = Number(
      await this.db.valueQueryAsync(
        "SELECT COUNT(*) FROM wiki_link_resolutions WHERE link_id = ?",
        [linkId],
      ),
    );
    const pending = byState.get("pending") ?? 0;
    const rejected = byState.get("rejected") ?? 0;
    const accepted = byState.get("accepted") ?? 0;
    const stale = byState.get("stale") ?? 0;

    let status: WikiLinkStatus;
    if (pending > 0) {
      status = "open";
    } else if (resolutions > 0 || accepted > 0) {
      status = "resolved";
    } else if (rejected > 0) {
      status = "dismissed";
    } else if (stale > 0) {
      status = "stale";
    } else {
      // No signals at all yet - a container written before its first scan
      // finished. Open is right: it owes a scan, not a decision.
      status = "open";
    }
    await this.db.queryAsync(
      "UPDATE wiki_link_candidates SET status = ? WHERE link_id = ?",
      [status, linkId],
    );
    return status;
  }

  /**
   * Mark signals stale because the text or the algorithm underneath moved.
   *
   * Only PENDING signals become stale. An accepted one has already produced a
   * Claim whose Evidence is maintained by the evidence relinker, and a
   * rejected one is a decision somebody made about text that existed - both
   * are history, and history does not go stale. What must not survive is a
   * pending signal still claiming to be settleable debt against a chunk id
   * that now points at different words.
   */
  async markSignalsStale(signalIds: readonly number[]): Promise<number> {
    let marked = 0;
    const links = new Set<number>();
    for (const rawId of signalIds) {
      const signalId = Number(rawId);
      const linkId = await this.db.valueQueryAsync(
        "SELECT link_id FROM wiki_link_signals WHERE signal_id = ? AND state = 'pending'",
        [signalId],
      );
      if (linkId == null) continue;
      await this.db.queryAsync(
        `UPDATE wiki_link_signals SET state = 'stale', settled_at = ?
          WHERE signal_id = ? AND state = 'pending'`,
        [Date.now(), signalId],
      );
      links.add(Number(linkId));
      marked += 1;
    }
    for (const linkId of links) await this.refreshStatus(linkId);
    return marked;
  }

  /**
   * Point one side of a signal at the chunk that now holds its passage.
   *
   * The excerpt is deliberately NOT rewritten. It is what the scan actually
   * compared, and replacing it with whatever the new chunk says would turn a
   * relocation into a silent re-finding - the row would then claim a
   * resemblance nothing ever computed.
   */
  async relocateSignalSide(
    signalId: number,
    side: "a" | "b",
    anchor: { chunkIdSnapshot: number; chunkTextHash: string },
  ): Promise<void> {
    const idColumn = side === "a" ? "a_chunk_id_snapshot" : "b_chunk_id_snapshot";
    const hashColumn = side === "a" ? "a_chunk_text_hash" : "b_chunk_text_hash";
    await this.db.queryAsync(
      `UPDATE wiki_link_signals SET ${idColumn} = ?, ${hashColumn} = ?
        WHERE signal_id = ? AND state = 'pending'`,
      [anchor.chunkIdSnapshot, anchor.chunkTextHash, signalId],
    );
  }

  /** Every pending signal of one library, for the relinker to check. */
  async pendingSignalsForRelink(
    libraryID?: number,
    itemKeys?: readonly string[],
  ): Promise<WikiLinkSignalWithPair[]> {
    const clauses: string[] = ["s.state = 'pending'"];
    const params: unknown[] = [];
    if (libraryID !== undefined) {
      clauses.push("c.library_id = ?");
      params.push(libraryID);
    }
    if (itemKeys?.length) {
      const placeholders = itemKeys.map(() => "?").join(",");
      clauses.push(
        `(c.a_item_key IN (${placeholders}) OR c.b_item_key IN (${placeholders}))`,
      );
      params.push(...itemKeys, ...itemKeys);
    }
    const rows = await this.db.queryAsync(
      `SELECT s.*, c.library_id, c.a_item_key, c.b_item_key,
              c.score_ab, c.score_ba, c.score_symmetric, c.status AS candidate_status
         FROM wiki_link_signals s
         JOIN wiki_link_candidates c ON c.link_id = s.link_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY s.signal_id`,
      params,
    );
    return rows.map((row) => this.mapSignalWithPair(row));
  }

  /** A paper left the library: its pairs stop being settleable debt. */
  async markSourceDeleted(
    libraryID: number,
    itemKey: string,
  ): Promise<number> {
    const rows = await this.db.queryAsync(
      `SELECT link_id FROM wiki_link_candidates
        WHERE library_id = ? AND (a_item_key = ? OR b_item_key = ?)
          AND status <> 'source_deleted'`,
      [libraryID, itemKey, itemKey],
    );
    for (const row of rows) {
      const linkId = Number(rowColumn(row, "link_id", "linkId"));
      await this.db.queryAsync(
        `UPDATE wiki_link_signals SET state = 'stale', settled_at = ?
          WHERE link_id = ? AND state = 'pending'`,
        [Date.now(), linkId],
      );
      await this.db.queryAsync(
        "UPDATE wiki_link_candidates SET status = 'source_deleted' WHERE link_id = ?",
        [linkId],
      );
    }
    return rows.length;
  }

  /** A paper came back, or was reindexed: let its pairs be judged again. */
  async clearSourceDeleted(
    libraryID: number,
    itemKey: string,
  ): Promise<number> {
    const rows = await this.db.queryAsync(
      `SELECT link_id FROM wiki_link_candidates
        WHERE library_id = ? AND (a_item_key = ? OR b_item_key = ?)
          AND status = 'source_deleted'`,
      [libraryID, itemKey, itemKey],
    );
    for (const row of rows) {
      const linkId = Number(rowColumn(row, "link_id", "linkId"));
      await this.db.queryAsync(
        "UPDATE wiki_link_candidates SET status = 'stale' WHERE link_id = ?",
        [linkId],
      );
      await this.refreshStatus(linkId);
    }
    return rows.length;
  }

  // ---- Scan queue ---------------------------------------------------------

  /**
   * Ask for a paper to be scanned.
   *
   * Idempotent by design: a paper read four times in one session enqueues once.
   * A row already `done` is re-armed only when the caller says the reason
   * changed - normally because its index fingerprint moved - so ordinary
   * re-reading of an already-scanned paper costs nothing.
   */
  async enqueueScan(options: {
    libraryID: number;
    itemKey: string;
    reason: string;
    /** Re-arm a finished or failed row. */
    force?: boolean;
  }): Promise<boolean> {
    const now = Date.now();
    const existing = await this.db.queryAsync(
      "SELECT state FROM wiki_link_scan_queue WHERE library_id = ? AND item_key = ?",
      [options.libraryID, options.itemKey],
    );
    if (existing.length) {
      const state = text(existing[0], "state", "state");
      if (state === "queued" || state === "running") return false;
      if (!options.force) return false;
      await this.db.queryAsync(
        `UPDATE wiki_link_scan_queue
            SET state = 'queued', reason = ?, attempts = 0, last_error = '',
                enqueued_at = ?, next_attempt_at = ?, started_at = NULL,
                finished_at = NULL
          WHERE library_id = ? AND item_key = ?`,
        [options.reason, now, now, options.libraryID, options.itemKey],
      );
      return true;
    }
    await this.db.queryAsync(
      `INSERT INTO wiki_link_scan_queue
         (library_id, item_key, state, reason, attempts, last_error,
          enqueued_at, next_attempt_at)
       VALUES (?, ?, 'queued', ?, 0, '', ?, ?)`,
      [options.libraryID, options.itemKey, options.reason, now, now],
    );
    return true;
  }

  /** The next due scan, or null. Marks it running in the same statement. */
  async claimNextScan(now = Date.now()): Promise<WikiLinkScanRecord | null> {
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_link_scan_queue
        WHERE state = 'queued' AND next_attempt_at <= ?
        ORDER BY next_attempt_at, enqueued_at LIMIT 1`,
      [now],
    );
    if (!rows.length) return null;
    const record = mapScan(rows[0]);
    await this.db.queryAsync(
      `UPDATE wiki_link_scan_queue
          SET state = 'running', started_at = ?, attempts = attempts + 1
        WHERE library_id = ? AND item_key = ? AND state = 'queued'`,
      [now, record.libraryID, record.itemKey],
    );
    return { ...record, state: "running", attempts: record.attempts + 1 };
  }

  async finishScan(options: {
    libraryID: number;
    itemKey: string;
    contentHash: string;
    chunkSignature: string;
    resetGeneration: string;
    selectorVersion: string;
    algorithmVersion: string;
    embeddingModel: string;
    candidatesWritten: number;
    signalsWritten: number;
  }): Promise<void> {
    await this.db.queryAsync(
      `UPDATE wiki_link_scan_queue
          SET state = 'done', finished_at = ?, last_error = '',
              content_hash = ?, chunk_signature = ?, reset_generation = ?,
              selector_version = ?, algorithm_version = ?, embedding_model = ?,
              candidates_written = ?, signals_written = ?
        WHERE library_id = ? AND item_key = ?`,
      [
        Date.now(),
        options.contentHash,
        options.chunkSignature,
        options.resetGeneration,
        options.selectorVersion,
        options.algorithmVersion,
        options.embeddingModel,
        options.candidatesWritten,
        options.signalsWritten,
        options.libraryID,
        options.itemKey,
      ],
    );
  }

  /**
   * A scan failed. Backoff, then give up without deleting the row.
   *
   * The row stays as the record that this paper has no candidates and why -
   * `wiki_status` reports it. Deleting it would make a permanently broken
   * index look identical to a library nobody has read yet.
   */
  async failScan(options: {
    libraryID: number;
    itemKey: string;
    error: string;
    retryDelayMs: number;
    maxAttempts: number;
  }): Promise<void> {
    const attempts = Number(
      await this.db.valueQueryAsync(
        "SELECT attempts FROM wiki_link_scan_queue WHERE library_id = ? AND item_key = ?",
        [options.libraryID, options.itemKey],
      ),
    );
    const exhausted = attempts >= options.maxAttempts;
    await this.db.queryAsync(
      `UPDATE wiki_link_scan_queue
          SET state = ?, last_error = ?, finished_at = ?, next_attempt_at = ?
        WHERE library_id = ? AND item_key = ?`,
      [
        exhausted ? "failed" : "queued",
        options.error.slice(0, 500),
        exhausted ? Date.now() : null,
        Date.now() + Math.max(0, options.retryDelayMs),
        options.libraryID,
        options.itemKey,
      ],
    );
  }

  async scanRecord(
    libraryID: number,
    itemKey: string,
  ): Promise<WikiLinkScanRecord | null> {
    const rows = await this.db.queryAsync(
      "SELECT * FROM wiki_link_scan_queue WHERE library_id = ? AND item_key = ?",
      [libraryID, itemKey],
    );
    return rows[0] ? mapScan(rows[0]) : null;
  }

  async listScans(
    libraryID: number,
    states?: readonly WikiLinkScanState[],
  ): Promise<WikiLinkScanRecord[]> {
    const filter = states?.length
      ? ` AND state IN (${states.map(() => "?").join(",")})`
      : "";
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_link_scan_queue WHERE library_id = ?${filter}
        ORDER BY enqueued_at`,
      [libraryID, ...(states ?? [])],
    );
    return rows.map(mapScan);
  }

  /** Abandon a running scan that a restart orphaned. */
  async requeueOrphanedScans(): Promise<number> {
    const rows = await this.db.queryAsync(
      "SELECT COUNT(*) AS n FROM wiki_link_scan_queue WHERE state = 'running'",
    );
    const orphaned = Number(rowColumn(rows[0], "n", "n") ?? 0);
    if (!orphaned) return 0;
    await this.db.queryAsync(
      `UPDATE wiki_link_scan_queue
          SET state = 'queued', started_at = NULL, next_attempt_at = ?
        WHERE state = 'running'`,
      [Date.now()],
    );
    ztoolkit.log(`[wiki] requeued ${orphaned} orphaned link scan(s)`);
    return orphaned;
  }

  // ---- Reporting ----------------------------------------------------------

  /**
   * The counters `wiki_status` reports.
   *
   * `mandatory` is passed in rather than computed here: whether a signal must
   * be settled depends on the reading ledger, which lives in another store,
   * and duplicating that rule would be the surest way to have two answers to
   * one question. See WikiLinkService.mandatorySignalIds.
   */
  async statistics(
    libraryID: number,
    mandatorySignalIds: ReadonlySet<number> = new Set(),
  ): Promise<WikiLinkStatistics> {
    const emptyByType = () =>
      Object.fromEntries(
        WIKI_LINK_SIGNAL_TYPES.map((type) => [type, 0]),
      ) as Record<WikiLinkSignalType, number>;

    const candidateRows = await this.db.queryAsync(
      `SELECT status, COUNT(*) AS n FROM wiki_link_candidates
        WHERE library_id = ? GROUP BY status`,
      [libraryID],
    );
    const byStatus = new Map<string, number>();
    let linkCandidates = 0;
    for (const row of candidateRows) {
      const n = Number(rowColumn(row, "n", "n") ?? 0);
      byStatus.set(text(row, "status", "status"), n);
      linkCandidates += n;
    }

    const signalRows = await this.db.queryAsync(
      `SELECT s.state AS state, s.signal_type AS signal_type, s.signal_id AS signal_id
         FROM wiki_link_signals s
         JOIN wiki_link_candidates c ON c.link_id = s.link_id
        WHERE c.library_id = ?`,
      [libraryID],
    );
    const byType = emptyByType();
    const pendingByType = emptyByType();
    const rejectedByType = emptyByType();
    let pending = 0;
    let accepted = 0;
    let rejected = 0;
    let stale = 0;
    let mandatory = 0;
    for (const row of signalRows) {
      const state = text(row, "state", "state");
      const type = text(row, "signal_type", "signalType") as WikiLinkSignalType;
      if (byType[type] !== undefined) byType[type] += 1;
      if (state === "pending") {
        pending += 1;
        if (pendingByType[type] !== undefined) pendingByType[type] += 1;
        if (
          mandatorySignalIds.has(
            Number(rowColumn(row, "signal_id", "signalId")),
          )
        ) {
          mandatory += 1;
        }
      } else if (state === "accepted") {
        accepted += 1;
      } else if (state === "rejected") {
        rejected += 1;
        if (rejectedByType[type] !== undefined) rejectedByType[type] += 1;
      } else if (state === "stale") {
        stale += 1;
      }
    }
    const settled = accepted + rejected;

    const scanRows = await this.db.queryAsync(
      `SELECT state, COUNT(*) AS n FROM wiki_link_scan_queue
        WHERE library_id = ? GROUP BY state`,
      [libraryID],
    );
    const byScanState = new Map<string, number>();
    for (const row of scanRows) {
      byScanState.set(
        text(row, "state", "state"),
        Number(rowColumn(row, "n", "n") ?? 0),
      );
    }

    return {
      linkCandidates,
      linkCandidatesResolved: byStatus.get("resolved") ?? 0,
      linkCandidatesDismissed: byStatus.get("dismissed") ?? 0,
      linkCandidatesStale: byStatus.get("stale") ?? 0,
      linkSignalsPending: pending,
      linkSignalsMandatory: mandatory,
      linkSignalsOptional: pending - mandatory,
      linkSignalsAccepted: accepted,
      linkSignalsRejected: rejected,
      linkSignalsStale: stale,
      // The number the design asks to watch for abuse: a model that rejects
      // everything looks exactly like a library with no real connections, and
      // only this ratio tells them apart.
      linkRejectedRate: settled > 0 ? rejected / settled : 0,
      linkSignalsByType: byType,
      linkPendingByType: pendingByType,
      linkRejectedByType: rejectedByType,
      linkScanQueued: byScanState.get("queued") ?? 0,
      linkScanRunning: byScanState.get("running") ?? 0,
      linkScanDone: byScanState.get("done") ?? 0,
      linkScanFailed: byScanState.get("failed") ?? 0,
    };
  }

  /** Rows a Wiki reset must remove. Used by clearAll. */
  static readonly TABLES = [
    "wiki_link_resolution_signals",
    "wiki_link_resolutions",
    "wiki_link_signals",
    "wiki_link_candidates",
    "wiki_link_scan_queue",
  ] as const;
}
