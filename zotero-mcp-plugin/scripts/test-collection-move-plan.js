/* eslint-env node */

/**
 * The one rule that makes `move_items_to_collection` safe to point at a whole
 * library: a batch containing anything unmovable moves NOTHING.
 *
 * Everything else the tool does is recoverable by calling it again. A
 * half-applied batch is not: the caller would have to diff its own plan
 * against a receipt to work out what is left, and the user's library sits in a
 * state nobody described in the meantime.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { planCollectionMove } = await import(
  "../src/modules/collectionMovePlan.ts"
);

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

/** A movable item filed in the given collections. */
function filed(itemKey, collections, title = `Title of ${itemKey}`) {
  return {
    itemKey,
    found: true,
    title,
    isChildItem: false,
    inTrash: false,
    collections: collections.map((key) => ({
      collectionKey: key,
      name: key,
      path: `My Library/${key}`,
    })),
  };
}

test("a move strips every other filing and keeps only the target", () => {
  const result = planCollectionMove(
    [filed("A", ["OLD", "OTHER"]), filed("B", ["OLD"])],
    "NEW",
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows[0].leaving, [
    "My Library/OLD",
    "My Library/OTHER",
  ]);
  assert.deepEqual(result.rows[1].leaving, ["My Library/OLD"]);
  assert.equal(result.summary.items, 2);
  assert.equal(
    result.summary.removedFilings,
    3,
    "the summary counts filings removed, not items moved — they differ whenever a document was cross-filed",
  );
});

test("an item already in the target is reported, not silently skipped", () => {
  const result = planCollectionMove([filed("A", ["NEW", "OLD"])], "NEW");
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].alreadyInTarget, true);
  assert.deepEqual(
    result.rows[0].leaving,
    ["My Library/OLD"],
    "already being in the target says nothing about the OTHER folders it must leave",
  );
  assert.equal(result.summary.alreadyInTarget, 1);
});

test("an unfiled item is a move, not a no-op", () => {
  const result = planCollectionMove([filed("A", [])], "NEW");
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows[0].leaving, []);
  assert.equal(result.rows[0].alreadyInTarget, false);
  assert.equal(result.summary.items, 1);
});

test("one missing key rejects the whole batch", () => {
  const result = planCollectionMove(
    [filed("A", ["OLD"]), { itemKey: "GONE", found: false }, filed("B", [])],
    "NEW",
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.notFound, ["GONE"]);
  assert.equal(
    result.wouldHaveMoved,
    2,
    "the rejection has to say how much of the batch was fine, or the caller cannot tell a typo from a stale plan",
  );
});

test("a child note or attachment rejects the whole batch, with a reason", () => {
  const result = planCollectionMove(
    [filed("A", ["OLD"]), { itemKey: "CHILD", found: true, isChildItem: true }],
    "NEW",
  );
  assert.equal(result.ok, false);
  assert.equal(result.notFilable.length, 1);
  assert.equal(result.notFilable[0].itemKey, "CHILD");
  assert.match(
    result.notFilable[0].reason,
    /parent/,
    "the reason must point at the fix, since the caller cannot see why Zotero refused",
  );
});

test("a trashed item rejects the whole batch", () => {
  const result = planCollectionMove(
    [filed("A", []), { itemKey: "DEAD", found: true, inTrash: true }],
    "NEW",
  );
  assert.equal(result.ok, false);
  assert.equal(result.notFilable[0].itemKey, "DEAD");
  assert.match(result.notFilable[0].reason, /trash/i);
});

test("a rejected batch produces no rows at all", () => {
  const result = planCollectionMove(
    [filed("A", ["OLD"]), { itemKey: "GONE", found: false }],
    "NEW",
  );
  assert.equal(result.ok, false);
  assert.equal(
    result.rows,
    undefined,
    "a rejection must not hand back a partial plan that a caller could mistake for an executable one",
  );
});

test("a repeated key is collapsed and counted, not rejected", () => {
  const result = planCollectionMove(
    [filed("A", ["OLD"]), filed("A", ["OLD"]), filed("B", [])],
    "NEW",
  );
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.summary.duplicateKeysIgnored, 1);
});

test("no duplicates means the count is absent, not zero", () => {
  const result = planCollectionMove([filed("A", [])], "NEW");
  assert.equal(result.ok, true);
  assert.equal(
    "duplicateKeysIgnored" in result.summary,
    false,
    "a zero would read as a finding; the field is there to be noticed",
  );
});

test("an item missing its collections list is treated as unfiled", () => {
  const result = planCollectionMove(
    [{ itemKey: "A", found: true, title: "T" }],
    "NEW",
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows[0].leaving, []);
});

test("an untitled item still gets a readable row", () => {
  const result = planCollectionMove(
    [{ itemKey: "A", found: true, title: "", collections: [] }],
    "NEW",
  );
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].title, "(no title)");
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} passed`);
if (failures > 0) process.exit(1);
