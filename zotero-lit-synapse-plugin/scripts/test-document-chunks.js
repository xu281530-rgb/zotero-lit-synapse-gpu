/* eslint-env node */

/**
 * Regression tests for `get_document_chunks` (src/modules/documentChunks.ts).
 *
 * The contract under test is the one `fulltext_database.get` did not have: a
 * document comes back in windows, in reading order, with the chunk ids the
 * other tools accept — and a document with no real body text is refused rather
 * than answered with its abstract wearing the shape of body text.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  DEFAULT_DOCUMENT_CHUNKS_PER_PAGE,
  MAX_DOCUMENT_CHUNKS_PER_PAGE,
  DocumentChunksError,
  decodeChunkCursor,
  encodeChunkCursor,
  readDocumentChunks,
  resolvePageSize,
} = await import("../src/modules/documentChunks.ts");

const LIBRARY = 1;

/** A document with `count` chunks whose ids deliberately are NOT 0..n-1. */
function makeDeps(overrides = {}) {
  const count = overrides.count ?? 25;
  const availability = overrides.availability ?? "indexed";
  const chunks = Array.from({ length: count }, (_, index) => ({
    // Gaps on purpose: chunkId is the index's own id, and a caller that
    // computed it from chunkIndex would address the wrong passage here.
    chunkId: index * 2 + 5,
    text: `passage ${index}`,
    language: "en",
  }));
  return {
    chunks,
    deps: {
      getChunks: async () => (overrides.chunks ? overrides.chunks : chunks),
      getFullTextAvailability: async () => availability,
      getTitle: async () => "A paper about grain refinement",
    },
  };
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("a page is bounded, whatever the caller asks for", () => {
  assert.equal(resolvePageSize(undefined), DEFAULT_DOCUMENT_CHUNKS_PER_PAGE);
  assert.equal(resolvePageSize(0), DEFAULT_DOCUMENT_CHUNKS_PER_PAGE);
  assert.equal(resolvePageSize(-4), DEFAULT_DOCUMENT_CHUNKS_PER_PAGE);
  assert.equal(resolvePageSize("nonsense"), DEFAULT_DOCUMENT_CHUNKS_PER_PAGE);
  assert.equal(resolvePageSize(3), 3);
  // The whole point of the tool: there is no value that returns everything.
  assert.equal(resolvePageSize(100000), MAX_DOCUMENT_CHUNKS_PER_PAGE);
  assert.equal(resolvePageSize(Infinity), DEFAULT_DOCUMENT_CHUNKS_PER_PAGE);
});

test("the first page starts at the beginning and reports the whole document", async () => {
  const { deps } = makeDeps({ count: 25 });
  const result = await readDocumentChunks({ itemKey: "AAA" }, deps, LIBRARY);

  assert.equal(result.itemKey, "AAA");
  assert.equal(result.title, "A paper about grain refinement");
  assert.equal(result.fullText, "indexed");
  assert.equal(result.pagination.totalChunks, 25);
  assert.equal(result.pagination.offset, 0);
  assert.equal(result.pagination.returned, DEFAULT_DOCUMENT_CHUNKS_PER_PAGE);
  assert.equal(result.pagination.hasMore, true);
  assert.ok(result.pagination.nextCursor);
  assert.equal(result.data[0].chunkIndex, 0);
  assert.equal(result.data[0].text, "passage 0");
});

test("chunkId is the index's id, never derived from chunkIndex", async () => {
  const { deps } = makeDeps({ count: 10 });
  const result = await readDocumentChunks({ itemKey: "AAA" }, deps, LIBRARY);
  for (const row of result.data) {
    assert.equal(
      row.chunkId,
      row.chunkIndex * 2 + 5,
      "chunkId must come from the store, not from the position",
    );
    assert.notEqual(
      row.chunkId,
      row.chunkIndex,
      "the fixture exists precisely so the two cannot be confused",
    );
  }
});

test("paging with the cursor walks the document exactly once", async () => {
  const { deps } = makeDeps({ count: 25 });
  const seen = [];
  let cursor;
  let pages = 0;

  for (;;) {
    const page = await readDocumentChunks(
      cursor ? { cursor } : { itemKey: "AAA" },
      deps,
      LIBRARY,
    );
    pages += 1;
    seen.push(...page.data.map((row) => row.chunkIndex));
    if (!page.pagination.hasMore) {
      assert.equal(page.pagination.nextCursor, undefined);
      break;
    }
    cursor = page.pagination.nextCursor;
    assert.ok(pages < 20, "paging did not terminate");
  }

  assert.deepEqual(
    seen,
    Array.from({ length: 25 }, (_, i) => i),
    "every chunk exactly once, in order, with no gaps or repeats",
  );
  assert.equal(pages, Math.ceil(25 / DEFAULT_DOCUMENT_CHUNKS_PER_PAGE));
});

test("the cursor keeps the page size the caller chose", async () => {
  const { deps } = makeDeps({ count: 25 });
  const first = await readDocumentChunks(
    { itemKey: "AAA", limit: 3 },
    deps,
    LIBRARY,
  );
  assert.equal(first.pagination.returned, 3);

  // Following a cursor without re-stating limit must not silently jump back
  // to the default — a caller that asked for 3 and then just paged was being
  // handed 8.
  const second = await readDocumentChunks(
    { cursor: first.pagination.nextCursor },
    deps,
    LIBRARY,
  );
  assert.equal(second.pagination.returned, 3);
  assert.equal(second.pagination.offset, 3);
  assert.equal(second.pagination.servedFromCursor, true);

  // An explicit limit alongside a cursor still wins.
  const resized = await readDocumentChunks(
    { cursor: first.pagination.nextCursor, limit: 10 },
    deps,
    LIBRARY,
  );
  assert.equal(resized.pagination.returned, 10);
});

test("a cursor and a conflicting itemKey is an error, not a silent choice", async () => {
  const { deps } = makeDeps({ count: 25 });
  const first = await readDocumentChunks({ itemKey: "AAA" }, deps, LIBRARY);
  await assert.rejects(
    () =>
      readDocumentChunks(
        { cursor: first.pagination.nextCursor, itemKey: "BBB" },
        deps,
        LIBRARY,
      ),
    (error) => {
      assert.ok(error instanceof DocumentChunksError);
      assert.match(error.message, /AAA/);
      assert.match(error.message, /BBB/);
      return true;
    },
  );
});

test("a malformed cursor fails with instructions, not a stack trace", async () => {
  const { deps } = makeDeps();
  for (const bad of ["", "not-base64!!", Buffer.from("{}").toString("base64")]) {
    if (bad === "") continue; // empty is treated as absent by the caller
    await assert.rejects(
      () => readDocumentChunks({ cursor: bad }, deps, LIBRARY),
      (error) => {
        assert.ok(error instanceof DocumentChunksError);
        assert.match(error.message, /nextCursor|itemKey/);
        return true;
      },
    );
  }
});

test("cursors round-trip", () => {
  const cursor = { k: "ABCD1234", l: 3, o: 16, s: 4 };
  assert.deepEqual(decodeChunkCursor(encodeChunkCursor(cursor)), cursor);
});

test("a document with no body text is refused, and the refusal says why", async () => {
  for (const [availability, expected] of [
    ["parse_failed", /could not be parsed/],
    ["no_source", /no PDF, Markdown or text attachment/],
    ["not_indexed", /not in the semantic index yet/],
  ]) {
    const { deps } = makeDeps({ availability });
    await assert.rejects(
      () => readDocumentChunks({ itemKey: "AAA" }, deps, LIBRARY),
      (error) => {
        assert.ok(error instanceof DocumentChunksError);
        assert.match(error.message, expected);
        // Refusing is only useful if it points somewhere. Each refusal must
        // name a tool that CAN answer, or the caller just retries.
        assert.match(error.message, /get_item_abstract|get_attachment_text/);
        return true;
      },
    );
  }
});

test("an unverified legacy index is readable but flagged", async () => {
  const { deps } = makeDeps({ availability: "unknown" });
  const result = await readDocumentChunks({ itemKey: "AAA" }, deps, LIBRARY);
  assert.equal(result.fullText, "unknown");
  assert.match(result.fullTextNote, /never established/);
  assert.ok(result.data.length > 0, "unknown must not be refused outright");
});

test("an empty index for a document said to be indexed is reported, not returned as nothing", async () => {
  const deps = {
    getChunks: async () => [],
    getFullTextAvailability: async () => "indexed",
    getTitle: async () => "Ghost",
  };
  await assert.rejects(
    () => readDocumentChunks({ itemKey: "AAA" }, deps, LIBRARY),
    (error) => {
      assert.match(error.message, /no stored chunks/);
      assert.match(error.message, /stale/);
      return true;
    },
  );
});

test("offset past the end returns an empty final page rather than throwing", async () => {
  const { deps } = makeDeps({ count: 5 });
  const result = await readDocumentChunks(
    { itemKey: "AAA", offset: 500 },
    deps,
    LIBRARY,
  );
  assert.equal(result.pagination.returned, 0);
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.range, "none");
});

test("itemKey is required when there is no cursor", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => readDocumentChunks({}, deps, LIBRARY),
    (error) => {
      assert.ok(error instanceof DocumentChunksError);
      assert.match(error.message, /itemKey is required/);
      return true;
    },
  );
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
