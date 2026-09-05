/* eslint-env node */

/**
 * Regression tests for collection scoping (src/modules/collectionScope.ts).
 *
 * Narrowing a search to part of the library is the one optimisation here that
 * can lose results, so the rule it must obey is directional: every uncertainty
 * resolves towards searching MORE. A collection whose subject cannot be judged
 * belongs in the scope; a scope that turns out to be unusable falls back to the
 * whole library rather than returning nothing.
 *
 * The resolver never reads meaning from a collection's name — that judgement is
 * the caller's, and the tests below pin the consequence: an opaque folder like
 * "待读" is scoped exactly like a clearly-named one.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { resolveCollectionScope, MAX_SCOPE_ITEMS } = await import(
  "../src/modules/collectionScope.ts"
);

/** A tiny in-memory collection tree. */
function library(defs) {
  const map = new Map(defs.map((d) => [d.key, d]));
  return {
    getCollection: (key) => {
      const found = map.get(key);
      if (!found) return null;
      return {
        key: found.key,
        name: found.name,
        childCollectionKeys: found.children || [],
        itemKeys: found.items || [],
      };
    },
  };
}

const DEPS = library([
  { key: "MAT", name: "材料科学", children: ["SOLID"], items: ["m1", "m2"] },
  { key: "SOLID", name: "凝固与铸造", children: [], items: ["s1", "s2", "m2"] },
  { key: "BIO", name: "分子生物学", children: [], items: ["b1"] },
  // No subject in the name at all — the case the selection rule exists for.
  { key: "TODO", name: "待读", children: [], items: ["t1", "m1"] },
  { key: "EMPTY", name: "空分类", children: [], items: [] },
]);

// ---------------------------------------------------------------------------
// 1. A clearly relevant collection: scoped, with subcollections pulled in.
// ---------------------------------------------------------------------------
{
  const scope = resolveCollectionScope(["MAT"], DEPS);
  assert.equal(scope.searchScope, "collections");
  assert.equal(scope.fellBackToLibrary, false);
  assert.deepEqual(scope.itemKeys.sort(), ["m1", "m2", "s1", "s2"]);
  assert.equal(
    scope.subcollectionsIncluded,
    1,
    "choosing a parent must bring its subcollections with it",
  );
  assert.deepEqual(scope.collections, [
    { key: "MAT", name: "材料科学", itemCount: 4 },
  ]);
}

// ---------------------------------------------------------------------------
// 2. An unrelated collection is simply not in the scope — exclusion is the
//    caller's decision, and the resolver honours it exactly.
// ---------------------------------------------------------------------------
{
  const scope = resolveCollectionScope(["SOLID"], DEPS);
  assert.deepEqual(scope.itemKeys.sort(), ["m2", "s1", "s2"]);
  assert.ok(!scope.itemKeys.includes("b1"), "BIO was not asked for");
}

// ---------------------------------------------------------------------------
// 3. AN UNJUDGEABLE FOLDER IS SCOPED LIKE ANY OTHER.
//
// "待读" says nothing about its subject, and the whole selection rule rests on
// including it anyway. The resolver must therefore treat it identically to a
// clearly-named collection — no name inspection, no heuristics, no dropping.
// ---------------------------------------------------------------------------
{
  const scope = resolveCollectionScope(["TODO"], DEPS);
  assert.equal(scope.searchScope, "collections");
  assert.deepEqual(scope.itemKeys.sort(), ["m1", "t1"]);
  assert.equal(scope.collections[0].name, "待读");

  // And including it alongside a subject collection widens the scope.
  const widened = resolveCollectionScope(["SOLID", "TODO"], DEPS);
  assert.deepEqual(widened.itemKeys.sort(), ["m1", "m2", "s1", "s2", "t1"]);
  assert.ok(
    widened.itemKeys.length > resolveCollectionScope(["SOLID"], DEPS).itemKeys.length,
    "adding an uncertain collection may only ever add documents",
  );
}

// ---------------------------------------------------------------------------
// 4. Several collections: union, de-duplicated, counted honestly.
// ---------------------------------------------------------------------------
{
  const scope = resolveCollectionScope(["MAT", "BIO", "TODO"], DEPS);
  assert.deepEqual(scope.itemKeys.sort(), ["b1", "m1", "m2", "s1", "s2", "t1"]);
  assert.equal(
    new Set(scope.itemKeys).size,
    scope.itemKeys.length,
    "an item in two collections must appear once",
  );
  // m1 and m2 were already counted under MAT, so TODO only adds t1.
  assert.deepEqual(
    scope.collections.map((c) => [c.key, c.itemCount]),
    [
      ["MAT", 4],
      ["BIO", 1],
      ["TODO", 1],
    ],
  );

  // Repeating a key is not an error and does not double-count.
  const repeated = resolveCollectionScope(["MAT", "MAT", " MAT "], DEPS);
  assert.deepEqual(repeated.itemKeys.sort(), ["m1", "m2", "s1", "s2"]);
  assert.deepEqual(repeated.requested, ["MAT"]);
}

// ---------------------------------------------------------------------------
// 5. Unknown keys: use what exists, report what did not, never fail the search.
// ---------------------------------------------------------------------------
{
  const scope = resolveCollectionScope(["MAT", "NOPE"], DEPS);
  assert.equal(scope.searchScope, "collections");
  assert.deepEqual(scope.missing, ["NOPE"]);
  assert.deepEqual(scope.itemKeys.sort(), ["m1", "m2", "s1", "s2"]);
  assert.equal(scope.fellBackToLibrary, false);
}

// ---------------------------------------------------------------------------
// 6. Every unusable scope falls back to the WHOLE LIBRARY, never to nothing.
// ---------------------------------------------------------------------------
{
  // No keys at all: the ordinary whole-library search.
  for (const empty of [undefined, null, [], ["", "  "]]) {
    const scope = resolveCollectionScope(empty, DEPS);
    assert.equal(scope.searchScope, "library");
    assert.equal(scope.fellBackToLibrary, false, "not asking is not a fallback");
    assert.equal(scope.fallbackReason, null);
  }

  // Keys that do not exist.
  const unknown = resolveCollectionScope(["NOPE", "ALSO_NOPE"], DEPS);
  assert.equal(unknown.searchScope, "library");
  assert.equal(unknown.fellBackToLibrary, true);
  assert.match(unknown.fallbackReason, /none of the requested collections exist/);
  assert.match(unknown.fallbackReason, /instead of returning nothing/);

  // A collection that exists but holds nothing.
  const empty = resolveCollectionScope(["EMPTY"], DEPS);
  assert.equal(empty.searchScope, "library");
  assert.equal(empty.fellBackToLibrary, true);
  assert.match(empty.fallbackReason, /contain no items/);

  // A scope too large to push through a SQL IN list.
  const huge = library([
    {
      key: "BIG",
      name: "everything",
      children: [],
      items: Array.from({ length: MAX_SCOPE_ITEMS + 1 }, (_, i) => `k${i}`),
    },
  ]);
  const over = resolveCollectionScope(["BIG"], huge);
  assert.equal(over.searchScope, "library");
  assert.equal(over.fellBackToLibrary, true);
  assert.match(over.fallbackReason, /above the .* limit for scoped search/);
}

// ---------------------------------------------------------------------------
// 7. Structural safety: a cycle must not hang the search.
// ---------------------------------------------------------------------------
{
  const cyclic = library([
    { key: "A", name: "A", children: ["B"], items: ["a1"] },
    { key: "B", name: "B", children: ["A"], items: ["b1"] },
  ]);
  const scope = resolveCollectionScope(["A"], cyclic);
  assert.deepEqual(scope.itemKeys.sort(), ["a1", "b1"]);
}

// ---------------------------------------------------------------------------
// 8. Malformed input is rejected clearly rather than silently ignored.
// ---------------------------------------------------------------------------
{
  assert.throws(() => resolveCollectionScope("MAT", DEPS), /must be an array/);
  assert.throws(() => resolveCollectionScope([1, 2], DEPS), /must be an array/);
}

console.log("Collection scope regression tests passed");
