export const WIKI_CLAIM_TYPES = [
  "definition",
  "mechanism",
  "model",
  "condition",
  "comparison",
  "limitation",
  "consensus",
  "conflict",
] as const;

export type WikiClaimType = (typeof WIKI_CLAIM_TYPES)[number];

export const WIKI_EPISTEMIC_STATUSES = [
  "provisional",
  "supported",
  "corroborated",
  "disputed",
  "unsupported",
] as const;
export type WikiEpistemicStatus = (typeof WIKI_EPISTEMIC_STATUSES)[number];

export const WIKI_READ_DEPTHS = [
  "chunk_local",
  "section_read",
  "paper_reviewed",
  "cross_paper",
] as const;
export type WikiReadDepth = (typeof WIKI_READ_DEPTHS)[number];

export const WIKI_COVERAGE_LEVELS = [
  ...WIKI_READ_DEPTHS,
  "partial",
  "incomplete",
] as const;
export type WikiCoverageLevel = (typeof WIKI_COVERAGE_LEVELS)[number];

export const WIKI_EVIDENCE_ROLES = [
  "SUPPORTS",
  "CONTRADICTS",
  "QUALIFIES",
  "EXAMPLE",
] as const;
export type WikiEvidenceRole = (typeof WIKI_EVIDENCE_ROLES)[number];

export const WIKI_LINK_STATES = [
  "valid",
  "pending_relink",
  "stale",
  "source_deleted",
] as const;
export type WikiLinkState = (typeof WIKI_LINK_STATES)[number];

export const WIKI_ACTIONS = [
  "SKIP",
  "ATTACH_EVIDENCE",
  "ADD_CLAIM",
  "UPDATE_CLAIM",
  "CREATE_PAGE",
  "LINK_RELATION",
  "MARK_CONFLICT",
  // The only settlement that writes no knowledge. Everything else settles a
  // cross-paper candidate by carrying `resolvesSignalIds` on the write it
  // already had to make; "these two passages only look alike" has no such
  // write, and without a way to say it the honest answer would be unavailable
  // - which is how a reader ends up inventing a Claim to clear a checklist.
  "DISMISS_LINK_SIGNALS",
  "RESOLVE_LINK_SIGNAL",
] as const;
export type WikiActionName = (typeof WIKI_ACTIONS)[number];

export interface WikiDatabase {
  queryAsync(sql: string, params?: unknown[]): Promise<any[]>;
  valueQueryAsync(sql: string, params?: unknown[]): Promise<unknown>;
  executeTransaction<T>(operation: () => Promise<T>): Promise<T>;
  closeDatabase?(): Promise<void>;
}

export interface WikiAliasInput {
  alias: string;
  language?: string;
  source?: string;
  confidence?: number;
}

export interface WikiConceptInput {
  canonicalName: string;
  conceptType?: string;
  description?: string;
  aliases?: WikiAliasInput[];
}

export interface WikiEvidenceInput {
  libraryID: number;
  itemKey: string;
  chunkIdSnapshot: number;
  chunkTextHash: string;
  sourceContentHash: string;
  sourceChunkSignature: string;
  sourceResetGeneration: string;
  excerpt: string;
  evidenceRole: WikiEvidenceRole;
  readDepth: WikiReadDepth;
  /** Server-derived ceiling used when the indexed source is not confirmed body text. */
  readDepthCeiling?: WikiReadDepth;
}

export type WikiCommitAction =
  | { action: "SKIP"; reason?: string }
  | {
      action: "CREATE_PAGE";
      ref?: string;
      canonicalTitle: string;
      /** Optional reference for LINK_RELATION actions later in this commit. */
      primaryConceptRef?: string;
      /** Accepted for compatibility but ignored; summaries are derived from Claims. */
      summary?: string;
      primaryConcept?: WikiConceptInput;
      resolvesSignalIds?: number[];
    }
  | {
      action: "ADD_CLAIM";
      ref?: string;
      pageId: number | string;
      claimText: string;
      claimType: WikiClaimType;
      epistemicStatus: WikiEpistemicStatus;
      coverageLevel: WikiCoverageLevel;
      /**
       * No `confidence` here on purpose.
       *
       * It is derived from the evidence by `deriveClaimConfidence`, because
       * every Claim in a real library carried 0.95 for as long as the model
       * was asked for it. A `confidence` that arrives anyway is ignored rather
       * than refused - an older caller should not fail, it should just stop
       * being believed.
       */
      evidence: WikiEvidenceInput[];
      /**
       * Cross-paper candidate signals this write settles.
       *
       * Reusing the existing actions rather than inventing a parallel set of
       * "settle a candidate" verbs is the whole point: a shared Claim IS the
       * settlement, and a second action to announce it could be sent without
       * the Claim ever being written.
       */
      resolvesSignalIds?: number[];
    }
  | {
      action: "ATTACH_EVIDENCE";
      claimId: number | string;
      evidence: WikiEvidenceInput[];
      resolvesSignalIds?: number[];
    }
  | {
      action: "UPDATE_CLAIM";
      claimId: number | string;
      expectedVersion: number;
      claimText?: string;
      claimType?: WikiClaimType;
      epistemicStatus?: WikiEpistemicStatus;
      coverageLevel?: WikiCoverageLevel;
      /** Required when changing Claim text or promoting coverage/status. */
      evidence?: WikiEvidenceInput[];
      resolvesSignalIds?: number[];
    }
  | {
      action: "LINK_RELATION";
      ref?: string;
      sourceConceptId: number | string;
      predicate: string;
      targetConceptId: number | string;
      confidence: number;
      resolvesSignalIds?: number[];
    }
  | {
      action: "MARK_CONFLICT";
      claimId: number | string;
      evidence: WikiEvidenceInput[];
      resolvesSignalIds?: number[];
    }
  | {
      action: "DISMISS_LINK_SIGNALS";
      /**
       * One signal, one reason.
       *
       * The pair below - `signalIds` plus a single `reason` - is the older
       * shape and is accepted only when it names ONE signal. A batch used to
       * carry one sentence that was then copied onto every signal in it, and
       * signals in a batch are not alike: a measured run archived a semantic
       * pair about misorientation profiles under "both sides are the journal's
       * standard competing-interest declaration". Kept permanently, read back
       * by whoever later asks whether a connection was rightly dropped.
       */
      dismissals?: Array<{ signalId: number; reason: string }>;
      signalIds?: number[];
      /** At least 40 characters, arguing from both sides' quoted text. */
      reason?: string;
    }
  | {
      action: "RESOLVE_LINK_SIGNAL";
      signalId: number;
      resolutionType: WikiLinkResolutionType;
      claimId?: number | string;
      claimIds?: Array<number | string>;
      pageId?: number | string;
      relationId?: number | string;
      reason: string;
    };

export interface WikiCommitInput {
  libraryID: number;
  userInitiated: boolean;
  operationId?: string;
  resume?: boolean;
  /** Required by WikiService when CREATE_PAGE is present. */
  prepareToken?: string;
  /**
   * The reading session this commit concludes.
   *
   * Optional: a commit that cites the open paper's evidence closes that
   * session anyway. Passing it explicitly closes the right session even when
   * the claims cite several papers.
   */
  readingSessionId?: number;
  actions: WikiCommitAction[];
}

export interface WikiCommitResult {
  createdPages: number;
  createdClaims: number;
  /**
   * ADD_CLAIM actions that matched a Claim already on the target Page and were
   * folded into it instead of creating a second one.
   */
  reusedClaims: number;
  attachedEvidence: number;
  updatedClaims: number;
  linkedRelations: number;
  refs: Record<string, number>;
  affectedClaimIds: number[];
  /**
   * Claims whose EVIDENCE this commit changed.
   *
   * Not the same set as `affectedClaimIds`, and deliberately separate from it.
   * An ATTACH_EVIDENCE changes what a Claim rests on - its derived status, its
   * derived confidence, and which pairs of papers now share it - without
   * changing a word of its text, so it belongs here and not in the set that
   * drives re-embedding. The contradicted-dismissal sweep reads both, because
   * a second paper's Evidence arriving on an existing Claim is exactly the
   * case where a pair somebody dismissed turns out to share one.
   */
  evidenceChangedClaimIds: number[];
  /**
   * The Claim and Page each action created or touched, by action position.
   *
   * `refs` only answers this when the caller thought to name a `ref`, and a
   * caller that did not still produced a Claim. Link resolutions were reading
   * `action.claimId` and getting NaN for every ADD_CLAIM, so the audit trail
   * said "settled by a shared Claim" without being able to name it. Position
   * is the one key that always exists.
   */
  actionClaimIds: Array<number | null>;
  actionPageIds: Array<number | null>;
  actionRelationIds?: Array<number | null>;
  /** Verified and saved in the same transaction as the knowledge. */
  linkSettlement?: WikiLinkSettlementResult;
}

export interface WikiEvidenceRecord {
  evidenceId: number;
  claimId: number;
  libraryID: number;
  itemKey: string;
  chunkIdSnapshot: number;
  chunkTextHash: string;
  sourceContentHash: string;
  sourceChunkSignature: string;
  sourceResetGeneration: string;
  excerptHash: string;
  excerpt: string;
  evidenceRole: WikiEvidenceRole;
  readDepth: WikiReadDepth;
  linkState: WikiLinkState;
  createdAt: number;
  lastVerifiedAt: number | null;
}

export interface WikiClaimRecord {
  claimId: number;
  pageId: number;
  claimText: string;
  claimType: WikiClaimType;
  epistemicStatus: WikiEpistemicStatus;
  coverageLevel: WikiCoverageLevel;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  version: number;
  evidence: WikiEvidenceRecord[];
}

export interface WikiSourceClaimRecord extends WikiClaimRecord {
  pageTitle: string;
}

export interface WikiPageRecord {
  pageId: number;
  libraryID: number;
  canonicalTitle: string;
  summary: string;
  primaryConceptId: number | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  claims: WikiClaimRecord[];
}

export interface WikiSourceChunk {
  chunkId: number;
  text: string;
  contentHash: string;
  chunkSignature: string;
  resetGeneration: string;
}

export interface WikiEvidenceSource {
  getChunks(libraryID: number, itemKey: string): Promise<WikiSourceChunk[]>;
  sourceExists(libraryID: number, itemKey: string): Promise<boolean>;
  /** Whether a successful body index exists and an unmatched Evidence may become stale. */
  indexReadyForRelink?(
    libraryID: number,
    itemKey: string,
  ): Promise<boolean>;
}

export interface WikiConceptRecord {
  conceptId: number;
  libraryID: number;
  canonicalName: string;
  normalizedName: string;
  conceptType: string;
  description: string;
}

export interface WikiAliasRecord {
  aliasId: number;
  conceptId: number;
  alias: string;
  normalizedAlias: string;
  language: string;
  source: string;
  confidence: number;
}

export interface WikiRelationRecord {
  relationId: number;
  sourceConceptId: number;
  predicate: string;
  normalizedPredicate: string;
  targetConceptId: number;
  confidence: number;
  createdAt: number;
}

/**
 * Everything one Wiki page owns, counted.
 *
 * The same shape answers two questions: what a delete is about to destroy -
 * which is what the confirmation dialog reads out - and what it actually
 * destroyed. Producing both from one type is deliberate: a preview that could
 * drift from the deletion it describes would be worse than no preview.
 *
 * `concepts`, `aliases` and `relations` are zero whenever the page's primary
 * concept is still the primary concept of another page. Aliases and relations
 * hang off `wiki_concepts`, not off `wiki_pages`, so a shared concept is left
 * exactly as it was rather than taken down with one of its pages.
 */
export interface WikiPageDeletion {
  pageId: number;
  canonicalTitle: string;
  claims: number;
  evidence: number;
  claimEmbeddings: number;
  queuedEmbeddings: number;
  /** 1 when the primary concept is removed with the page, otherwise 0. */
  concepts: number;
  aliases: number;
  relations: number;
  /** Pages whose summary mentioned a relation this delete removed. */
  refreshedPages: number[];
}
import type { WikiLinkResolutionType, WikiLinkSettlementResult } from "./wikiLinkTypes";
