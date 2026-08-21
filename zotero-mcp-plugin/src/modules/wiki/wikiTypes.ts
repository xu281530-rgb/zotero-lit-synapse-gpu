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
    }
  | {
      action: "ADD_CLAIM";
      ref?: string;
      pageId: number | string;
      claimText: string;
      claimType: WikiClaimType;
      epistemicStatus: WikiEpistemicStatus;
      coverageLevel: WikiCoverageLevel;
      confidence: number;
      evidence: WikiEvidenceInput[];
    }
  | {
      action: "ATTACH_EVIDENCE";
      claimId: number | string;
      evidence: WikiEvidenceInput[];
    }
  | {
      action: "UPDATE_CLAIM";
      claimId: number | string;
      expectedVersion: number;
      claimText?: string;
      claimType?: WikiClaimType;
      epistemicStatus?: WikiEpistemicStatus;
      coverageLevel?: WikiCoverageLevel;
      confidence?: number;
      /** Required when changing Claim text or promoting coverage/status. */
      evidence?: WikiEvidenceInput[];
    }
  | {
      action: "LINK_RELATION";
      sourceConceptId: number | string;
      predicate: string;
      targetConceptId: number | string;
      confidence: number;
    }
  | {
      action: "MARK_CONFLICT";
      claimId: number | string;
      evidence: WikiEvidenceInput[];
    };

export interface WikiCommitInput {
  libraryID: number;
  userInitiated: boolean;
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
