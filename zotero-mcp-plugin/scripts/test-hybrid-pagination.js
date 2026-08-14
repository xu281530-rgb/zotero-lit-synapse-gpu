/* eslint-env node */

/**
 * Regression tests for hybrid_search pagination
 * (src/modules/hybridSearchPages.ts + the fusion window in hybridSearch.ts).
 *
 * The invariant under test is the order of operations:
 *
 *   retrieve -> score/rank -> apply minScore -> THEN page
 *
 * Everything else follows from it. Paging cannot surface a document the
 * threshold rejected, cannot pad a short final page, and cannot re-rank —
 * because by the time paging happens, the ranking and the filtering are done
 * and a page is only a window onto the finished list.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  CursorError,
  HybridSearchPageStore,
  decodeCursor,
  encodeCursor,
  fingerprintsMatch,
  windowOf,
} = await import("../src/modules/hybridSearchPages.ts");

const { fuseHybridSearchResultsDetailed } = await import(
  "../src/modules/hybridSearch.ts"
);

const FINGERPRINT = {
  query: "columnar-to-equiaxed transition / 柱状晶转变",
  keywords: ["CET", "定向凝固"],
  domain: "materials science / solidification",
  expertRole: "solidification specialist",
  appliedMinScore: 0.7,
  language: "all",
  libraryID: 1,
  candidateK: 120,
  rrfK: 60,
  keywordWeight: 1,
  semanticWeight: 1,
  pageSize: 20,
  scope: "library",
};

// ---------------------------------------------------------------------------
// 1. THE CORE RULE: the threshold decides the population, paging only windows
//    it. 100 candidates in, 47 above 0.70, so 47 is what can ever be paged.
// ---------------------------------------------------------------------------
{
  // Semantic scores are passed through unchanged by normalizeSemanticScore, so
  // a document's fused score here is exactly its branch score.
  const semanticResults = [];
  for (let i = 0; i < 100; i += 1) {
    // 47 documents at >= 0.70, the rest strictly below.
    const score = i < 47 ? 0.99 - i * 0.005 : 0.69 - (i - 47) * 0.001;
    semanticResults.push({
      itemKey: `KEY${String(i).padStart(3, "0")}`,
      libraryID: 1,
      title: `Paper ${i}`,
      score,
      matchedChunks: [{ chunkId: i, text: `passage ${i}`, score }],
    });
  }

  const fusion = fuseHybridSearchResultsDetailed([], semanticResults, {
    topK: 20,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
    minScore: 0.7,
  });

  assert.equal(fusion.ranked.length, 47, "only documents above 0.70 may be paged");
  assert.equal(fusion.discardedBelowThreshold, 53);
  assert.equal(fusion.results.length, 20, "page 1 is still topK");
  assert.deepEqual(
    fusion.results,
    fusion.ranked.slice(0, 20),
    "page 1 must be the head of the ranked list, not a separate ranking",
  );
  assert.ok(
    fusion.ranked.every((row) => row.score >= 0.7),
    "no sub-threshold document may appear anywhere in the paged population",
  );
  assert.ok(
    fusion.ranked.every((row, i, all) => i === 0 || all[i - 1].score >= row.score),
    "the paged population must be in descending fused-score order",
  );

  // ------------------------------------------------------------------------
  // 2. 20 / 20 / 7, then it ends. No padding, no eighth page.
  // ------------------------------------------------------------------------
  const store = new HybridSearchPageStore();
  const searchId = store.create(FINGERPRINT, fusion.ranked, { note: "meta" });

  const page1 = windowOf(fusion.ranked, 0, 20, searchId);
  assert.equal(page1.returned, 20);
  assert.equal(page1.totalRelevant, 47);
  assert.equal(page1.offset, 0);
  assert.equal(page1.hasMore, true);
  assert.ok(page1.nextCursor);

  const page2 = store.read(page1.nextCursor, {}, 20).window;
  assert.equal(page2.returned, 20);
  assert.equal(page2.offset, 20);
  assert.equal(page2.totalRelevant, 47);
  assert.equal(page2.hasMore, true);

  const page3 = store.read(page2.nextCursor, {}, 20).window;
  assert.equal(page3.returned, 7, "the last page is short, never padded to 20");
  assert.equal(page3.offset, 40);
  assert.equal(page3.totalRelevant, 47);
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextCursor, undefined, "no cursor is offered past the end");

  // ------------------------------------------------------------------------
  // 3. One cursor chain: stable order, no duplicates, no gaps.
  // ------------------------------------------------------------------------
  const seen = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.itemKey);
  assert.equal(seen.length, 47);
  assert.equal(new Set(seen).size, 47, "no document may appear on two pages");
  assert.deepEqual(
    seen,
    fusion.ranked.map((r) => r.itemKey),
    "the pages concatenated must reproduce the ranking exactly, in order",
  );

  // ------------------------------------------------------------------------
  // 4. Page 2 is a window, not a second search: re-reading the same cursor
  //    returns the identical page.
  // ------------------------------------------------------------------------
  const page2Again = store.read(page1.nextCursor, {}, 20).window;
  assert.deepEqual(
    page2Again.rows.map((r) => r.itemKey),
    page2.rows.map((r) => r.itemKey),
    "the same cursor must always return the same page",
  );
  assert.equal(page2Again.offset, page2.offset);

  // A different page size windows the same list rather than re-ranking it.
  const wide = store.read(page1.nextCursor, {}, 30).window;
  assert.equal(wide.returned, 27);
  assert.deepEqual(
    wide.rows.slice(0, 20).map((r) => r.itemKey),
    page2.rows.map((r) => r.itemKey),
  );
}

// ---------------------------------------------------------------------------
// 5. Changing what defines the search invalidates the cursor.
// ---------------------------------------------------------------------------
{
  const store = new HybridSearchPageStore();
  const ranked = Array.from({ length: 30 }, (_, i) => ({ itemKey: `K${i}` }));
  const searchId = store.create(FINGERPRINT, ranked, {});
  const cursor = encodeCursor(searchId, 10);

  // Re-sending the same values is fine, as is omitting them entirely.
  assert.doesNotThrow(() => store.read(cursor, {}, 10));
  assert.doesNotThrow(() => store.read(cursor, { ...FINGERPRINT }, 10));
  assert.doesNotThrow(() =>
    store.read(cursor, { query: "  Columnar-to-Equiaxed Transition / 柱状晶转变 " }, 10),
  );
  assert.doesNotThrow(() =>
    store.read(cursor, { keywords: ["定向凝固", "cet"] }, 10),
    "keyword order and case are not a change of search",
  );

  for (const [label, claim] of [
    ["query", { query: "something else entirely" }],
    ["keywords", { keywords: ["CET", "定向凝固", "等轴晶"] }],
    ["domain", { domain: "physical metallurgy" }],
    ["expertRole", { expertRole: "someone else" }],
    ["minScore", { appliedMinScore: 0.6 }],
    ["language", { language: "zh" }],
    ["libraryID", { libraryID: 2 }],
    // Retrieval knobs change the ranking, so they cannot be applied to a
    // stored one. Accepting them silently would answer a different question.
    ["candidateK", { candidateK: 400 }],
    ["rrfK", { rrfK: 5 }],
    ["keywordWeight", { keywordWeight: 9 }],
    ["semanticWeight", { semanticWeight: 0 }],
    // Narrowing to collections is a different result set, not a filter on the
    // one already ranked.
    ["collectionKeys", { scope: "collections:ABCD1234" }],
  ]) {
    assert.throws(
      () => store.read(cursor, claim, 10),
      (error) =>
        error instanceof CursorError &&
        error.message.includes(label) &&
        /run hybrid_search again/i.test(error.message),
      `changing ${label} alongside a cursor must be rejected with a clear message`,
    );
  }

  // Lowering the threshold is the specific abuse this blocks: it must not be
  // possible to widen a result set by paging it.
  const verdict = fingerprintsMatch(FINGERPRINT, { appliedMinScore: 0.5 });
  assert.equal(verdict.match, false);
  assert.equal(verdict.changed, "minScore");
}

// ---------------------------------------------------------------------------
// 5b. Page size is a property of the cursor chain, not of the defaults.
//
// A caller that asked for 5 and then simply followed nextCursor was being
// handed 20 on page 2: the continuation re-resolved topK against the user's
// maximum instead of inheriting what page 1 used.
// ---------------------------------------------------------------------------
{
  const store = new HybridSearchPageStore();
  const ranked = Array.from({ length: 47 }, (_, i) => ({ itemKey: `K${i}` }));
  const searchId = store.create({ ...FINGERPRINT, pageSize: 5 }, ranked, {});

  const page1 = windowOf(ranked, 0, 5, searchId);
  assert.equal(page1.returned, 5);

  // Omitting the page size inherits page 1's.
  const page2 = store.read(page1.nextCursor, {}).window;
  assert.equal(page2.returned, 5, "an omitted topK must inherit the page size");
  assert.equal(page2.offset, 5);

  // Asking explicitly still re-sizes the window.
  const wide = store.read(page1.nextCursor, {}, 20).window;
  assert.equal(wide.returned, 20, "an explicit topK still re-sizes the page");
  assert.equal(wide.offset, 5, "and starts where the cursor points either way");
}

// ---------------------------------------------------------------------------
// 6. Expired, evicted and malformed cursors fail loudly.
// ---------------------------------------------------------------------------
{
  let now = 1_000_000;
  const store = new HybridSearchPageStore(() => now, 60_000, 2);
  const ranked = Array.from({ length: 5 }, (_, i) => ({ itemKey: `K${i}` }));

  const id = store.create(FINGERPRINT, ranked, {});
  const cursor = encodeCursor(id, 2);
  assert.doesNotThrow(() => store.read(cursor, {}, 2));

  now += 61_000; // past the TTL
  assert.throws(
    () => store.read(cursor, {}, 2),
    (error) =>
      error instanceof CursorError &&
      /no longer valid/.test(error.message) &&
      /run hybrid_search again/i.test(error.message),
    "an expired cursor must say so and say what to do instead",
  );

  // Oldest search is evicted once the cap is exceeded.
  const first = store.create(FINGERPRINT, ranked, {});
  now += 1;
  store.create(FINGERPRINT, ranked, {});
  now += 1;
  store.create(FINGERPRINT, ranked, {});
  assert.equal(store.size, 2, "only the most recent searches are kept");
  assert.throws(
    () => store.read(encodeCursor(first, 2), {}, 2),
    CursorError,
  );

  for (const bad of ["", "garbage", "hs1_abc", "hs9_abc_0", "hs1_abc_-1", "hs1_abc_x"]) {
    assert.throws(
      () => decodeCursor(bad),
      CursorError,
      `malformed cursor ${JSON.stringify(bad)} must be rejected`,
    );
  }
}

// ---------------------------------------------------------------------------
// 7. totalRelevant counts the threshold survivors, not the page and not the
//    raw candidate pool.
// ---------------------------------------------------------------------------
{
  const ranked = Array.from({ length: 47 }, (_, i) => ({ itemKey: `K${i}` }));
  for (const pageSize of [5, 20, 50]) {
    const w = windowOf(ranked, 0, pageSize, "sid");
    assert.equal(w.totalRelevant, 47, "totalRelevant never depends on page size");
    assert.equal(w.returned, Math.min(pageSize, 47));
    assert.equal(w.hasMore, pageSize < 47);
  }
  const past = windowOf(ranked, 47, 20, "sid");
  assert.equal(past.returned, 0);
  assert.equal(past.hasMore, false);
  assert.equal(past.totalRelevant, 47);

  const empty = windowOf([], 0, 20, "sid");
  assert.equal(empty.totalRelevant, 0);
  assert.equal(empty.hasMore, false);
  assert.equal(empty.nextCursor, undefined);
}

// ---------------------------------------------------------------------------
// 8. Ranking itself is untouched: page 1 is what the old topK-only call
//    returned, and a deeper candidate pool does not move any score.
// ---------------------------------------------------------------------------
{
  // Both branches rank the same documents in the same order, so slicing
  // deeper only appends documents that were not in the shallow pool at all —
  // which is what raising candidateK actually does, since each branch scores
  // and sorts its whole candidate set and merely hands over a longer prefix.
  const semantic = Array.from({ length: 60 }, (_, i) => ({
    itemKey: `S${i}`,
    libraryID: 1,
    title: `S${i}`,
    score: 0.95 - i * 0.004,
  }));
  const keyword = Array.from({ length: 60 }, (_, i) => ({
    key: `S${i}`,
    libraryID: 1,
    title: `S${i}`,
    relevanceScore: 30 - i * 0.4,
    matchedKeywords: ["CET"],
    matchedFields: ["title"],
  }));
  const options = {
    topK: 20,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
    minScore: 0.6,
  };

  const shallow = fuseHybridSearchResultsDetailed(
    keyword.slice(0, 20),
    semantic.slice(0, 20),
    options,
  );
  const deep = fuseHybridSearchResultsDetailed(keyword, semantic, options);

  assert.ok(
    deep.ranked.length > shallow.ranked.length,
    "a deeper pool must reveal more of the ranking",
  );
  for (const [index, row] of shallow.ranked.entries()) {
    const same = deep.ranked[index];
    assert.equal(
      same.itemKey,
      row.itemKey,
      "documents already visible must keep their exact positions",
    );
    assert.equal(
      same.score,
      row.score,
      `${row.itemKey} must keep the exact score it had — depth must not re-score`,
    );
    assert.equal(same.rrfScore, row.rrfScore, "branch ranks must not shift");
  }

  // And page 1 of the deep search is still the same 20 documents the old
  // topK-only call would have returned.
  assert.deepEqual(
    deep.results.map((r) => r.itemKey),
    shallow.results.map((r) => r.itemKey),
  );
}

console.log("Hybrid search pagination regression tests passed");
