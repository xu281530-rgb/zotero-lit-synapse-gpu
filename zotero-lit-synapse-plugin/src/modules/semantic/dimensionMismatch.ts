/**
 * The one failure that must never look like "no results".
 *
 * Cosine similarity between vectors of different lengths is not a low score —
 * it is undefined. When the embedding model changes without a rebuild, every
 * stored vector becomes incomparable to every query vector, so the semantic
 * branch can answer nothing at all.
 *
 * Both scan paths used to log and `return []`. To every caller above them that
 * is indistinguishable from a library that genuinely contains nothing
 * relevant: `hybrid_search` counted zero semantic hits, produced no warning,
 * left `degraded` false, and handed back a pure keyword ranking that presented
 * itself as a normal hybrid result. An AI client had no way to tell that half
 * the retrieval system was offline, and the user had no reason to suspect
 * their index needed rebuilding.
 *
 * So it throws. The branch fails loudly, the failure has a stable type, and
 * every surface above it reports a degraded/error state naming the cause and
 * the fix.
 */

export class VectorDimensionMismatchError extends Error {
  readonly queryDimensions: number;
  readonly storedDimensions: number;

  constructor(queryDimensions: number, storedDimensions: number) {
    super(
      `Semantic index is incompatible with the current embedding model: ` +
        `stored vectors have ${storedDimensions} dimensions but the query ` +
        `embedding has ${queryDimensions}. Vectors of different dimensions ` +
        `cannot be compared, so no semantic result can be produced. ` +
        `Rebuild the semantic index to match the current embedding model.`,
    );
    this.name = 'VectorDimensionMismatchError';
    this.queryDimensions = queryDimensions;
    this.storedDimensions = storedDimensions;
  }
}

export function isVectorDimensionMismatchError(
  error: unknown,
): error is VectorDimensionMismatchError {
  return (
    error instanceof VectorDimensionMismatchError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'VectorDimensionMismatchError')
  );
}

/**
 * The user-facing sentence every surface uses for this condition.
 *
 * One string, so the wording an AI client sees from `hybrid_search`,
 * `semantic_search` and `find_similar` is identical and recognisable.
 */
export const DIMENSION_MISMATCH_HINT =
  '当前语义索引与嵌入模型不兼容，需要重建索引 / The semantic index is ' +
  'incompatible with the current embedding model; rebuild the index.';
