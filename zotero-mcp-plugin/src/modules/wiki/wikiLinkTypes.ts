/**
 * The vocabulary of cross-paper link candidates.
 *
 * Three nouns, and keeping them apart is the point of the whole design:
 *
 *   CANDIDATE - an unordered pair of papers, its two directional scores, and a
 *       lifecycle. Says nothing about what the papers have in common.
 *   SIGNAL    - one reason to think the pair is related, with the passages on
 *       both sides that produced it and its own settled state. A pair may hold
 *       several, and rejecting one must never touch the others.
 *   RESOLUTION - what was written into the Wiki because of one or more
 *       signals. The knowledge itself lives in Pages, Claims, Evidence,
 *       Concepts and Relations; this only records which discovery led to it.
 */

export const WIKI_LINK_STATUSES = [
  "open",
  "resolved",
  "dismissed",
  "stale",
  "source_deleted",
] as const;
export type WikiLinkStatus = (typeof WIKI_LINK_STATUSES)[number];

export const WIKI_LINK_SIGNAL_TYPES = ["semantic", "lexical", "concept"] as const;
export type WikiLinkSignalType = (typeof WIKI_LINK_SIGNAL_TYPES)[number];

/**
 * Which way a signal was measured.
 *
 * Not decoration. The library's similarity aggregate scores a CANDIDATE
 * against a set of QUERY chunks, so "how well is A covered by B" and "how well
 * is B covered by A" are different questions with different answers - most
 * visibly when one paper is a long review and the other a short specialist
 * study. A signal that does not say which question it answered cannot be
 * explained to a reader or recomputed by anyone.
 */
export const WIKI_LINK_DIRECTIONS = ["a_to_b", "b_to_a", "symmetric"] as const;
export type WikiLinkDirection = (typeof WIKI_LINK_DIRECTIONS)[number];

export const WIKI_LINK_SIGNAL_STATES = [
  "pending",
  "accepted",
  "rejected",
  "stale",
] as const;
export type WikiLinkSignalState = (typeof WIKI_LINK_SIGNAL_STATES)[number];

export const WIKI_LINK_RESOLUTION_TYPES = [
  "shared_claim",
  "same_page",
  "conflict",
  "concept_relation",
  "no_action",
] as const;
export type WikiLinkResolutionType =
  (typeof WIKI_LINK_RESOLUTION_TYPES)[number];

export const WIKI_LINK_SCAN_STATES = [
  "queued",
  "running",
  "done",
  "failed",
] as const;
export type WikiLinkScanState = (typeof WIKI_LINK_SCAN_STATES)[number];

/** One side's index identity, as of when a signal was computed. */
export interface WikiLinkSourceFingerprint {
  contentHash: string;
  chunkSignature: string;
  resetGeneration: string;
}

export interface WikiLinkCandidateRecord {
  linkId: number;
  libraryID: number;
  aItemKey: string;
  bItemKey: string;
  scoreAB: number | null;
  scoreBA: number | null;
  scoreSymmetric: number | null;
  status: WikiLinkStatus;
  computedAt: number;
  reviewedAt: number | null;
  /** When a settled pair was put back in the queue, and why. */
  reopenedAt: number | null;
  reopenedReason: string;
  a: WikiLinkSourceFingerprint;
  b: WikiLinkSourceFingerprint;
  semanticModel: string;
  semanticDimensions: number;
  semanticAlgorithmVersion: string;
  semanticSelectorVersion: string;
}

/** One side of a signal: which passage, and what it said. */
export interface WikiLinkSignalSide {
  chunkIdSnapshot: number | null;
  chunkTextHash: string;
  excerpt: string;
  excerptHash: string;
}

export interface WikiLinkSignalRecord {
  signalId: number;
  linkId: number;
  signalType: WikiLinkSignalType;
  direction: WikiLinkDirection;
  algorithmVersion: string;
  sourceModel: string;
  signalFingerprint: string;
  score: number;
  /** IDF-style weight; how much this signal's anchor discriminates. */
  specificityWeight: number | null;
  /** How many documents the anchor reached in the same scan. */
  breadthDocs: number | null;
  termId: number | null;
  termSnapshot: string;
  a: WikiLinkSignalSide;
  b: WikiLinkSignalSide;
  state: WikiLinkSignalState;
  rejectedReason: string;
  /**
   * What an earlier reader concluded about this signal, if it was dismissed
   * and later reopened. Empty for a signal nobody has judged yet.
   */
  priorRejection: string;
  createdAt: number;
  settledAt: number | null;
}

/** A signal joined to its pair, which is how every caller wants to read one. */
export interface WikiLinkSignalWithPair extends WikiLinkSignalRecord {
  libraryID: number;
  aItemKey: string;
  bItemKey: string;
  scoreAB: number | null;
  scoreBA: number | null;
  scoreSymmetric: number | null;
  candidateStatus: WikiLinkStatus;
}

/** A signal to write. Ids and timestamps are the store's business. */
export interface WikiLinkSignalInput {
  signalType: WikiLinkSignalType;
  direction: WikiLinkDirection;
  algorithmVersion: string;
  sourceModel?: string;
  score: number;
  specificityWeight?: number | null;
  breadthDocs?: number | null;
  termId?: number | null;
  termSnapshot?: string;
  a: Partial<WikiLinkSignalSide>;
  b: Partial<WikiLinkSignalSide>;
}

export interface WikiLinkResolutionRecord {
  resolutionId: number;
  linkId: number;
  resolutionType: WikiLinkResolutionType;
  claimId: number | null;
  pageId: number | null;
  relationId: number | null;
  resolutionNote: string;
  createdAt: number;
  signalIds: number[];
}

export interface WikiLinkScanRecord {
  libraryID: number;
  itemKey: string;
  state: WikiLinkScanState;
  reason: string;
  attempts: number;
  lastError: string;
  enqueuedAt: number;
  nextAttemptAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  contentHash: string;
  chunkSignature: string;
  resetGeneration: string;
  selectorVersion: string;
  algorithmVersion: string;
  embeddingModel: string;
  candidatesWritten: number;
  signalsWritten: number;
}

/**
 * Everything `wiki_status` reports about the link layer.
 *
 * Broken out by signal type on purpose: the point of the counters is to say
 * WHICH of the three discovery paths is producing noise, and one total cannot.
 * A rejection rate of 0.8 on lexical signals and 0.1 on concept ones is a
 * finding; the average of the two is not.
 */
export interface WikiLinkStatistics {
  linkCandidates: number;
  linkCandidatesResolved: number;
  linkCandidatesDismissed: number;
  linkCandidatesStale: number;
  linkSignalsPending: number;
  linkSignalsMandatory: number;
  linkSignalsOptional: number;
  linkSignalsAccepted: number;
  linkSignalsRejected: number;
  linkSignalsStale: number;
  linkRejectedRate: number;
  linkSignalsByType: Record<WikiLinkSignalType, number>;
  linkPendingByType: Record<WikiLinkSignalType, number>;
  linkRejectedByType: Record<WikiLinkSignalType, number>;
  linkScanQueued: number;
  linkScanRunning: number;
  linkScanDone: number;
  linkScanFailed: number;
}
