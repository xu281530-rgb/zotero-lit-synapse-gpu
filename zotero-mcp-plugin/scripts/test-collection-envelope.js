/* eslint-env node */

/**
 * Collection listings must survive serialisation.
 *
 * `handleGetCollections` answered with a bare JSON array and put the total in
 * an `X-Total-Count` header. `callGetCollections` then did
 * `result.metadata = { mode, appliedModeConfig }` on the parsed array -- and
 * `JSON.stringify` dropped it, because properties hung on an Array are not
 * serialised. MCP forwards only the body, so over MCP the metadata never
 * existed and the total never existed either: a page of 100 out of 300 was
 * indistinguishable from a complete library of 100.
 *
 * Nothing threw. The assignment was valid JavaScript that produced no visible
 * effect, which is why it survived. These tests call JSON.stringify, because
 * that is the step where the information was lost.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const { buildCollectionListEnvelope } = await import(
  "../src/modules/collectionListEnvelope.ts"
);
const { buildToolCatalog } = await import("../src/modules/toolCatalog.ts");

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

const rows = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    key: `C${from + i}`,
    name: `Collection ${from + i}`,
  }));

/** What the MCP layer actually sees: the body, after a round trip. */
const overTheWire = (value) => JSON.parse(JSON.stringify(value));

test("metadata survives JSON.stringify", () => {
  // The bug, inverted. Everything else here depends on this holding.
  const body = overTheWire(
    buildCollectionListEnvelope(
      rows(3),
      { total: 3, offset: 0, limit: 100 },
      {
        mode: "standard",
      },
    ),
  );
  assert.equal(body.metadata.mode, "standard");
});

test("an array cannot carry metadata, which is what went wrong", () => {
  // Kept as an executable explanation of the original defect.
  const legacy = rows(3);
  legacy.metadata = { mode: "standard" };
  assert.equal(legacy.metadata.mode, "standard"); // fine in memory
  assert.equal(overTheWire(legacy).metadata, undefined); // gone on the wire
});

test("the MCP layer can add its own metadata without losing the handler's", () => {
  // callGetCollections merges into metadata after parsing the body. Both keys
  // must be present afterwards, which the array form made impossible.
  const body = overTheWire(
    buildCollectionListEnvelope(
      rows(2),
      { total: 2, offset: 0, limit: 100 },
      {
        scope: { level: "top" },
      },
    ),
  );
  body.metadata = { ...body.metadata, mode: "standard" };
  const final = overTheWire(body);
  assert.equal(final.metadata.mode, "standard");
  assert.deepEqual(final.metadata.scope, { level: "top" });
  assert.ok(final.metadata.extractedAt);
});

test("a partial page is distinguishable from a complete one", () => {
  // Without this, 100 of 300 and 100 of 100 look identical.
  const partial = buildCollectionListEnvelope(rows(100), {
    total: 300,
    offset: 0,
    limit: 100,
  }).pagination;
  const complete = buildCollectionListEnvelope(rows(100), {
    total: 100,
    offset: 0,
    limit: 100,
  }).pagination;

  assert.equal(partial.hasMore, true);
  assert.equal(partial.nextOffset, 100);
  assert.equal(complete.hasMore, false);
  assert.equal(complete.nextOffset, undefined);
  assert.notEqual(partial.total, complete.total);
});

test("paging state describes the window that was returned", () => {
  const page2 = buildCollectionListEnvelope(rows(50, 100), {
    total: 220,
    offset: 100,
    limit: 50,
  }).pagination;
  assert.deepEqual(page2, {
    total: 220,
    returned: 50,
    offset: 100,
    limit: 50,
    range: "101-150",
    hasMore: true,
    nextOffset: 150,
  });
});

test("the last page and an empty page both terminate", () => {
  const last = buildCollectionListEnvelope(rows(20, 200), {
    total: 220,
    offset: 200,
    limit: 50,
  }).pagination;
  assert.equal(last.hasMore, false);
  assert.equal(last.range, "201-220");

  const empty = buildCollectionListEnvelope([], {
    total: 0,
    offset: 0,
    limit: 50,
  }).pagination;
  assert.equal(empty.hasMore, false);
  assert.equal(empty.range, "none");
  assert.equal(empty.returned, 0);
});

test("an offset past the end does not claim there is more", () => {
  const beyond = buildCollectionListEnvelope([], {
    total: 12,
    offset: 500,
    limit: 50,
  }).pagination;
  assert.equal(beyond.returned, 0);
  assert.equal(beyond.hasMore, false);
  assert.equal(beyond.nextOffset, undefined);
});

test("no collection handler answers with a bare array any more", () => {
  // The array body is the shape that cannot hold metadata. A source check is
  // the only way to stop a new handler quietly reintroducing it.
  const source = fs.readFileSync(
    path.join(rootDir, "src/modules/apiHandlers.ts"),
    "utf8",
  );
  const bare = [
    ...source.matchAll(/body:\s*JSON\.stringify\(\s*formatCollectionList\(/g),
  ];
  assert.equal(
    bare.length,
    0,
    `${bare.length} collection handler(s) still serialise a bare list; wrap it with buildCollectionListEnvelope`,
  );
  assert.ok(
    source.includes("buildCollectionListEnvelope("),
    "apiHandlers.ts no longer builds the envelope at all",
  );
});

test("the schema no longer offers the unpaginated whole tree", () => {
  // `recursive` returned every level in one response, which is both the bulk
  // dump the level-by-level browser replaced and a shape with no paging state
  // to report.
  const tool = buildToolCatalog().find(
    (entry) => entry.name === "get_collections",
  );
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.recursive, undefined);
  assert.ok(
    !/recursive=true/.test(JSON.stringify(tool.inputSchema)),
    "get_collections still describes recursive in its parameter text",
  );
  assert.ok(
    tool.description.includes("get_collection_items"),
    "get_collections does not point at the tool that replaced recursive",
  );
});

test("asking for recursive is refused, not ignored", () => {
  // Silently serving page one of the top level to someone who asked for the
  // whole subtree is the worse failure: it looks like a complete answer.
  const source = fs.readFileSync(
    path.join(rootDir, "src/modules/apiHandlers.ts"),
    "utf8",
  );
  const guard = source.slice(source.indexOf('query.has("recursive")'));
  assert.ok(
    guard.startsWith('query.has("recursive")'),
    "handleGetCollections no longer checks for recursive at all",
  );
  assert.match(guard.slice(0, 900), /status:\s*400/);
  assert.match(guard.slice(0, 900), /get_collection_items/);
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
