export const CROSS_PAPER_PROTOCOL_VERSION = 1;
export const CLAIM_RELATION_TYPES = [
  "extends_method",
  "qualifies_scope",
  "compares_with",
] as const;
export type ClaimRelationType = (typeof CLAIM_RELATION_TYPES)[number];

export interface ReviewEvidenceBinding {
  claimId: number | string;
  /** Existing Evidence ID, or an exact excerpt for Evidence created in this commit. */
  evidenceId?: number;
  itemKey?: string;
  excerpt?: string;
}

export interface CrossPaperOutcome {
  outcome:
    | "shared_claim"
    | "conflict"
    | "same_page"
    | "concept_relation"
    | "extends_method"
    | "qualifies_scope"
    | "compares_with"
    | "no_relation"
    | "noise"
    | "deferred";
  targetClaimIds: number[];
  basis: string;
  evidenceBindings: ReviewEvidenceBinding[];
  conceptSourceIds?: number[];
  resultRefs?: {
    claimIds?: Array<number | string>;
    pageId?: number | string;
    relationId?: number | string;
  };
  relation?: {
    sourceClaimId: number | string;
    targetClaimId: number | string;
    dimension: string;
    conditions: string;
    statement: string;
  };
  gap?: string;
  trigger?: "target_knowledge_changed" | "source_restored" | "new_evidence";
}

export interface CrossPaperReviewInput {
  taskId: number;
  expectedRevision: string;
  reviewedTargets: Array<{
    claimId: number;
    version: number;
    disposition: "reviewed" | "excluded" | "deferred";
    basis: string;
  }>;
  outcomes: CrossPaperOutcome[];
}

export interface MissingTargetSelection {
  taskId: number;
  expectedRevision: string;
}

export interface EvidenceAssessmentInput {
  claimId: number | string;
  expectedVersion: number;
  supportCompleteness: "complete" | "partial" | "overstated" | "unverified";
  conditionCompleteness:
    | "explicit"
    | "incomplete"
    | "not_applicable"
    | "unverified";
  basisTypes: Array<
    "simulation" | "experiment" | "theory" | "assumption" | "secondary_citation"
  >;
  independence: "verified_independent" | "same_study" | "unknown";
  studyGroups?: Array<{ itemKeys: string[]; basis: string }>;
  basis: string;
  evidenceBindings: ReviewEvidenceBinding[];
}
