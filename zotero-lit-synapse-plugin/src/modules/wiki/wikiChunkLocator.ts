/**
 * Finding a passage again after the index has moved under it.
 *
 * Extracted from the Evidence relinker, where it was a private method, because
 * link signals need exactly the same primitive and must NOT be run through the
 * Evidence relinker to get it. That relinker writes `wiki_evidence` - its
 * columns, its unique constraint, its `link_state` vocabulary and its
 * downstream Claim-status recomputation - and a signal is none of those
 * things. What the two share is this question and only this question:
 *
 *     I recorded a quotation from a chunk whose text hashed to X. The document
 *     has been reindexed. Which chunk holds that quotation now, if any?
 *
 * Two answers in order, because they carry different confidence:
 *
 *   1. EXACT. Some chunk still hashes to X. The passage did not move; only
 *      the chunk id did. Nothing was lost and nothing needs judging.
 *   2. RELOCATED. No chunk matches the hash, but one contains the quotation
 *      well enough. Re-chunking splits and merges paragraphs constantly, so
 *      this is the ordinary case after a chunk-size change, and refusing it
 *      would invalidate a whole library's provenance over a settings tweak.
 *
 * Anything below the threshold is NOT a match. Returning the closest chunk
 * regardless would be the worst possible outcome: a citation pointing
 * confidently at text that no longer says what it was quoted for.
 */

import { hashWikiText, normalizeWikiName } from "./wikiCanonicalizer";

/** Bigram containment: how much of the excerpt survives in this chunk. */
export function tokenOverlap(excerpt: string, text: string): number {
  const needle = normalizeWikiName(excerpt);
  const haystack = normalizeWikiName(text);
  if (!needle || !haystack) return 0;
  if (haystack.includes(needle)) return 1;
  const grams = (value: string): Set<string> => {
    const output = new Set<string>();
    for (let index = 0; index + 2 <= value.length; index += 1) {
      output.add(value.slice(index, index + 2));
    }
    return output;
  };
  const left = grams(needle);
  const right = grams(haystack);
  let common = 0;
  for (const gram of left) if (right.has(gram)) common += 1;
  return left.size ? common / left.size : 0;
}

/**
 * How much of a quotation must survive for a chunk to count as its new home.
 *
 * Calibrated by the Evidence relinker, which has been shipping with it: high
 * enough that a paragraph merely discussing the same topic does not qualify,
 * low enough that ordinary re-chunking - which moves boundaries, not words -
 * still relocates.
 */
export const RELOCATION_THRESHOLD = 0.72;

export interface LocatableChunk {
  chunkId: number;
  text: string;
}

export type ChunkMatchKind = "exact" | "relocated";

export interface ChunkMatch<T extends LocatableChunk> {
  chunk: T;
  kind: ChunkMatchKind;
  /** 1 for an exact hash match; the overlap score for a relocation. */
  score: number;
}

export async function locateChunk<T extends LocatableChunk>(
  chunkTextHash: string,
  excerpt: string,
  chunks: readonly T[],
  threshold = RELOCATION_THRESHOLD,
): Promise<ChunkMatch<T> | null> {
  for (const chunk of chunks) {
    if (chunkTextHash && (await hashWikiText(chunk.text)) === chunkTextHash) {
      return { chunk, kind: "exact", score: 1 };
    }
  }
  let best: { chunk: T; score: number } | null = null;
  for (const chunk of chunks) {
    const score = tokenOverlap(excerpt, chunk.text);
    if (!best || score > best.score) best = { chunk, score };
  }
  return best && best.score >= threshold
    ? { chunk: best.chunk, kind: "relocated", score: best.score }
    : null;
}
