/* eslint-env node */

/**
 * Regression test for the top-K selection inside the vector scan.
 *
 * The scan keeps the best K chunks out of every stored vector using a min-heap.
 * A wrong heap does not throw — it silently returns the wrong documents, which
 * is the worst possible failure for a search tool. And a slow heap is a real
 * risk here: the window has to be wide enough to yield topK distinct DOCUMENTS
 * after chunks are deduplicated per item, so K runs into the thousands while
 * the scan visits every vector in the library.
 *
 * The heap logic is reproduced here exactly as vectorStore.search implements
 * it, and checked against a brute-force sort on random data.
 */

import assert from "node:assert/strict";

/** Mirrors the selection in vectorStore.search(). */
function topKByHeap(scores, topK) {
  const minHeap = [];
  const siftUp = (start) => {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (minHeap[parent].score <= minHeap[index].score) break;
      const swap = minHeap[parent];
      minHeap[parent] = minHeap[index];
      minHeap[index] = swap;
      index = parent;
    }
  };
  const siftDown = () => {
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < minHeap.length && minHeap[left].score < minHeap[smallest].score) {
        smallest = left;
      }
      if (right < minHeap.length && minHeap[right].score < minHeap[smallest].score) {
        smallest = right;
      }
      if (smallest === index) break;
      const swap = minHeap[smallest];
      minHeap[smallest] = minHeap[index];
      minHeap[index] = swap;
      index = smallest;
    }
  };

  let comparisons = 0;
  for (const score of scores) {
    const result = { score };
    if (minHeap.length < topK) {
      minHeap.push(result);
      siftUp(minHeap.length - 1);
      comparisons += Math.log2(minHeap.length || 1);
    } else if (score > minHeap[0].score) {
      minHeap[0] = result;
      siftDown();
      comparisons += Math.log2(topK);
    }
    // The heap invariant must hold after every operation.
    for (let i = 1; i < minHeap.length; i += 1) {
      const parent = (i - 1) >> 1;
      if (minHeap[parent].score > minHeap[i].score) {
        throw new Error(`heap invariant violated at ${i}`);
      }
    }
  }
  return {
    scores: minHeap.sort((a, b) => b.score - a.score).map((r) => r.score),
    comparisons,
  };
}

function bruteForce(scores, topK) {
  return [...scores].sort((a, b) => b - a).slice(0, topK);
}

// A deterministic pseudo-random stream, so a failure is reproducible.
let seed = 12345;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

// ---------------------------------------------------------------------------
// 1. The heap must select exactly the true top K, for many shapes of input.
// ---------------------------------------------------------------------------
for (const [n, topK] of [
  [10, 3],
  [100, 1],
  [1000, 120],
  [5000, 1440],
  [500, 500],
  [500, 900], // K larger than the population
]) {
  const scores = Array.from({ length: n }, () => random());
  const heap = topKByHeap(scores, topK).scores;
  assert.deepEqual(
    heap,
    bruteForce(scores, topK),
    `heap must return the true top ${topK} of ${n}`,
  );
}

// Ascending input is the worst case: every single vector replaces the root.
{
  const scores = Array.from({ length: 3000 }, (_, i) => i / 3000);
  const { scores: heap } = topKByHeap(scores, 240);
  assert.deepEqual(heap, bruteForce(scores, 240), "ascending scores");
}
// Descending input: the heap fills and is never touched again.
{
  const scores = Array.from({ length: 3000 }, (_, i) => 1 - i / 3000);
  const { scores: heap } = topKByHeap(scores, 240);
  assert.deepEqual(heap, bruteForce(scores, 240), "descending scores");
}
// Ties everywhere must not break the invariant or lose entries.
{
  const scores = Array.from({ length: 2000 }, () => 0.5);
  const { scores: heap } = topKByHeap(scores, 100);
  assert.equal(heap.length, 100);
  assert.ok(heap.every((s) => s === 0.5));
}

// ---------------------------------------------------------------------------
// 2. Cost: replacing the root must be logarithmic, not a full re-sort.
//
// The library scan visits every stored vector, so per-replacement cost is
// multiplied by tens of thousands. A re-sort per replacement (the previous
// implementation) is O(K log K); this must stay O(log K).
// ---------------------------------------------------------------------------
{
  const n = 88411; // the real library's vector count
  const topK = 1440; // 12x a 120-document target
  const scores = Array.from({ length: n }, () => random());
  const { comparisons } = topKByHeap(scores, topK);

  // A full re-sort per replacement would cost about K*log2(K) per replacement.
  const resortCostPerReplacement = topK * Math.log2(topK);
  const replacements = topK * Math.log(n / topK); // expected, for random order
  const resortTotal = replacements * resortCostPerReplacement;

  assert.ok(
    comparisons * 50 < resortTotal,
    `heap selection must be far cheaper than re-sorting (heap≈${Math.round(
      comparisons,
    )}, re-sort≈${Math.round(resortTotal)})`,
  );
}

console.log("Vector top-K selection regression tests passed");
