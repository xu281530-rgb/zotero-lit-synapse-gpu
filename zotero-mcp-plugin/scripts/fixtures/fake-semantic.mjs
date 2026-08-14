/* eslint-env node */

/**
 * Stand-in for src/modules/semantic used by the deep-dive tests.
 *
 * Only the two methods the document-level search calls are implemented:
 * getItemChunks (all stored chunks, in reading order) and searchItemChunks
 * (the vector branch). Scores are fixed so the assertions can reason about the
 * fused result exactly.
 */

export const state = {
  chunks: [],
  semanticHits: [],
  semanticError: null,
  lastSearchOptions: null,
};

export function getSemanticSearchService() {
  return {
    async getItemChunks() {
      return state.chunks;
    },
    async searchItemChunks(query, options) {
      state.lastSearchOptions = { query, ...options };
      if (state.semanticError) throw state.semanticError;
      return state.semanticHits;
    },
  };
}
