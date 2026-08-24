/* eslint-env node */

/**
 * Regression tests for the annotation tools' full-text paging contract.
 * Legacy content controls remain harmless extra input for old clients, while
 * pagination is the only response-size guard.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register("./ts-ext-hooks.mjs", import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.ztoolkit = { log: () => {} };
globalThis.Zotero = {};

const {
  MAX_ANNOTATIONS_PER_PAGE,
  resolveAnnotationItemKeys,
  resolveAnnotationPageSize,
  SmartAnnotationExtractor,
} = await import("../src/modules/smartAnnotationExtractor.ts");

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("annotation pages retain their fixed defaults and hard cap", () => {
  assert.equal(resolveAnnotationPageSize(undefined, 20), 20);
  assert.equal(resolveAnnotationPageSize(5, 20), 5);
  assert.equal(resolveAnnotationPageSize(10000, 20), MAX_ANNOTATIONS_PER_PAGE);
  assert.equal(resolveAnnotationPageSize(0, 20), 20);
  assert.equal(resolveAnnotationPageSize(-1, 20), 20);
  assert.equal(resolveAnnotationPageSize("x", 20), 20);
});

test("the annotation service has no hidden preview or detail branch", () => {
  const source = fs.readFileSync(
    path.join(root, "src/modules/annotationService.ts"),
    "utf8",
  );
  for (const removed of [
    "processAnnotationContent",
    "contentMode",
    "detailed?:",
    "isPreview",
  ]) {
    assert.ok(!source.includes(removed), `annotation service still has ${removed}`);
  }
});

const longMark = (index) => ({
  id: `N${index}`,
  annotationKey: `N${index}`,
  itemKey: `N${index}`,
  sourceItemKey: "DOC",
  type: "note",
  content: `needle ${index} ${"full text ".repeat(30)}`,
  comment: `comment ${index}`,
  tags: [],
  dateModified: "2026-08-24T00:00:00Z",
});

function extractorWith(annotationService) {
  const extractor = new SmartAnnotationExtractor();
  extractor.annotationService = annotationService;
  return extractor;
}

function assertFullPage(result, expectedLimit) {
  assert.equal(result.data.length, expectedLimit);
  assert.equal(result.metadata.pagination.limit, expectedLimit);
  assert.ok(result.data[0].content.includes("full text full text"));
  assert.ok(result.data[0].content.includes("Comment: comment"));
  for (const removed of ["mode", "estimatedTokens", "compressionRatio"]) {
    assert.ok(!(removed in result), `response still exposes ${removed}`);
  }
  assert.ok(!("userSettings" in result.metadata));
}

test("get_annotations ignores legacy controls and returns full text in pages", async () => {
  const notes = Array.from({ length: 25 }, (_, index) => longMark(index));
  const extractor = extractorWith({
    getAllNotes: async () => notes,
    getPDFAnnotations: async () => [],
  });
  const legacy = {
    detail: "minimal",
    mode: "minimal",
    outputMode: "minimal",
    maxTokens: 1,
  };
  const first = await extractor.getAnnotations({
    itemKey: "DOC",
    types: ["note"],
    ...legacy,
  });
  assertFullPage(first, 20);
  assert.equal(first.metadata.pagination.nextOffset, 20);
  const second = await extractor.getAnnotations({
    itemKey: "DOC",
    types: ["note"],
    offset: 20,
    ...legacy,
  });
  assert.equal(second.data.length, 5);
  assert.equal(second.data[0].annotationKey, "N20");
  assert.equal(second.metadata.pagination.hasMore, false);
});

test("a commented highlight keeps both the highlighted text and comment", async () => {
  const extractor = extractorWith({
    getAllNotes: async () => [],
    getPDFAnnotations: async () => [
      {
        ...longMark(0),
        type: "highlight",
        content: "my comment",
        text: `highlighted original ${"source text ".repeat(30)}`,
        comment: "my comment",
      },
    ],
  });
  const result = await extractor.getAnnotations({
    itemKey: "DOC",
    types: ["highlight"],
  });
  assert.ok(result.data[0].content.includes("highlighted original"));
  assert.ok(result.data[0].content.includes("source text source text"));
  assert.ok(result.data[0].content.includes("Comment: my comment"));
});

test("search_annotations ignores legacy controls and returns full text in pages", async () => {
  const notes = Array.from({ length: 18 }, (_, index) => longMark(index));
  const extractor = extractorWith({
    searchAnnotations: async () => ({
      results: notes,
      pagination: { hasMore: false },
    }),
  });
  const result = await extractor.searchAnnotations("needle", {
    detail: "minimal",
    mode: "minimal",
    outputMode: "minimal",
    maxTokens: 1,
  });
  assertFullPage(result, 15);
  assert.equal(result.metadata.pagination.nextOffset, 15);
});

test("itemKeys means all of them", () => {
  assert.deepEqual(
    resolveAnnotationItemKeys({ itemKeys: ["A", "B", "C"] }),
    ["A", "B", "C"],
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
