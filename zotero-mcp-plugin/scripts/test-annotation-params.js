/* eslint-env node */

/**
 * Regression tests for the annotation tools' parameter handling
 * (src/modules/smartAnnotationExtractor.ts).
 *
 * Each of these pins a bug that was live and silent — the failure mode
 * throughout was a call that succeeded while ignoring what it was asked:
 *
 *  - The schema advertised `mode`, the implementation read `outputMode`, and
 *    nothing bridged them, so the parameter was dropped on every call.
 *  - The schema's `complete` and the code's `full` were different words for
 *    the same level, and the code only recognised `full`, so `complete` — the
 *    only value the schema offered for verbatim text — never took effect.
 *  - `itemKeys` was documented as a list and implemented as `itemKeys[0]`.
 *  - `outputMode: 'full'` disabled pagination entirely.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  MAX_ANNOTATIONS_PER_PAGE,
  resolveAnnotationDetail,
  resolveAnnotationItemKeys,
  resolveAnnotationPageSize,
} = await import("../src/modules/smartAnnotationExtractor.ts");

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("the schema's vocabulary and the code's now mean the same thing", () => {
  // The schema offered these four. Every one must survive to the code.
  assert.equal(resolveAnnotationDetail("minimal"), "minimal");
  assert.equal(resolveAnnotationDetail("preview"), "preview");
  assert.equal(resolveAnnotationDetail("standard"), "standard");
  assert.equal(resolveAnnotationDetail("complete"), "complete");

  // The code used these two internally. Both still resolve, so a caller
  // written against the old spelling keeps working.
  assert.equal(resolveAnnotationDetail("full"), "complete");
  assert.equal(resolveAnnotationDetail("smart"), "standard");
});

test("`complete` is a real level, not a synonym that never fired", () => {
  // This is THE bug: the schema's only verbatim level normalised to something
  // the compression check did not recognise, so asking for complete text
  // silently got compressed text.
  assert.equal(resolveAnnotationDetail("complete"), "complete");
  assert.notEqual(resolveAnnotationDetail("complete"), "standard");
});

test("detail is read from whichever name the caller used", () => {
  // Callers may send `detail` (current), `mode` (what the schema advertised)
  // or `outputMode` (what the code read). First non-empty wins, in that order.
  assert.equal(resolveAnnotationDetail(undefined, "complete"), "complete");
  assert.equal(resolveAnnotationDetail(undefined, undefined, "minimal"), "minimal");
  assert.equal(resolveAnnotationDetail("preview", "complete"), "preview");
});

test("an unrecognised or missing detail falls back to standard, never crashes", () => {
  assert.equal(resolveAnnotationDetail(), "standard");
  assert.equal(resolveAnnotationDetail(null, 42, {}, []), "standard");
  assert.equal(resolveAnnotationDetail("verbose"), "standard");
  assert.equal(resolveAnnotationDetail("  COMPLETE  "), "complete");
});

test("every detail level is capped, including the verbatim one", () => {
  // `full` used to skip pagination outright, which on a well-read PDF meant
  // hundreds of highlights in one response and no way to ask for fewer.
  assert.equal(resolveAnnotationPageSize(undefined, 20), 20);
  assert.equal(resolveAnnotationPageSize(5, 20), 5);
  assert.equal(resolveAnnotationPageSize(10000, 20), MAX_ANNOTATIONS_PER_PAGE);
  assert.equal(
    resolveAnnotationPageSize(undefined, 100000),
    MAX_ANNOTATIONS_PER_PAGE,
    "a large user setting is still a page, not the whole library",
  );
  assert.equal(resolveAnnotationPageSize(0, 20), 20);
  assert.equal(resolveAnnotationPageSize(-1, 20), 20);
  assert.equal(resolveAnnotationPageSize("x", 20), 20);
});

test("itemKeys means all of them", () => {
  assert.deepEqual(
    resolveAnnotationItemKeys({ itemKeys: ["A", "B", "C"] }),
    ["A", "B", "C"],
    "every key must survive; the old code used itemKeys[0]",
  );
});

test("itemKey and itemKeys compose without duplicating", () => {
  assert.deepEqual(
    resolveAnnotationItemKeys({ itemKeys: ["A", "B"], itemKey: "C" }),
    ["A", "B", "C"],
  );
  assert.deepEqual(
    resolveAnnotationItemKeys({ itemKeys: ["A", "B"], itemKey: "A" }),
    ["A", "B"],
    "the same document must not be read twice",
  );
});

test("blank and non-string keys are dropped rather than searched for", () => {
  assert.deepEqual(
    resolveAnnotationItemKeys({ itemKeys: ["A", "", "  ", null, 7, "B"] }),
    ["A", "B"],
  );
  assert.deepEqual(resolveAnnotationItemKeys({}), []);
  assert.deepEqual(resolveAnnotationItemKeys({ itemKeys: "A" }), []);
  assert.deepEqual(resolveAnnotationItemKeys({ itemKey: "  D  " }), ["D"]);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error.message}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
