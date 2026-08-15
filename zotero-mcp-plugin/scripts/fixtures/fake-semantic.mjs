/* eslint-env node */

/**
 * Stand-in for src/modules/semantic used by the deep-dive tests.
 *
 * Only what the document-level search calls is implemented: getItemChunks (all
 * stored chunks, in reading order), searchItemChunks (the vector branch), and
 * getItemBodyIndexState (whether the stored index holds body text at all).
 * Scores are fixed so the assertions can reason about the fused result exactly.
 *
 * The body-state helpers are re-exported from the real module rather than
 * faked: their exact answers are what decides whether search_fulltext refuses
 * a metadata-only document, so a copy here could drift from the code that
 * ships.
 */

export {
  describeFullTextAvailability,
  describeMissingBodyText,
  describePageFullTextGaps,
  emptyFullTextCoverage,
  fullTextAvailabilityFromState,
  fullTextCoverageTotal,
  hasBodyText,
  rowHasBodyText,
  bodyIndexStateFromSourceKind,
  isBodyExtractionFailure,
  sourceKindForBodyState,
  FULL_TEXT_AVAILABILITIES,
} from "../../src/modules/semantic/bodyIndexState.ts";

/** Mirrors the real module's fixed embedding deadline. */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 30000;

export const state = {
  chunks: [],
  semanticHits: [],
  semanticError: null,
  lastSearchOptions: null,
  /** What getItemBodyIndexState reports; 'body' is the normal case. */
  bodyIndexState: "body",
};

export function getSemanticSearchService() {
  return {
    async getItemChunks() {
      return state.chunks;
    },
    async getItemBodyIndexState() {
      return state.bodyIndexState;
    },
    async searchItemChunks(query, options) {
      state.lastSearchOptions = { query, ...options };
      if (state.semanticError) throw state.semanticError;
      return state.semanticHits;
    },
  };
}
