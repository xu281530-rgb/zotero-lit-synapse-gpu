/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { buildSearchIndex, MAX_SEARCH_INDEX_BUILD_ITEMS } = await import(
  "../src/modules/semantic/searchIndexBuilder.ts"
);

function indexStatus(itemKey, sourceKind, chunkCount = 3) {
  return {
    itemKey,
    indexedAt: 1,
    chunkCount,
    contentHash: `${itemKey}-hash`,
    version: 2,
    contentLength: 100,
    sourceKind,
    bodyRetrySignature: null,
  };
}

const buildCalls = [];
const statuses = new Map([
  ["OK", indexStatus("OK", "body")],
  ["KEYWORDFAIL", indexStatus("KEYWORDFAIL", "body")],
  ["NOSOURCE", indexStatus("NOSOURCE", "metadata-no-source", 1)],
  ["PARSEFAIL", indexStatus("PARSEFAIL", "metadata-only", 1)],
]);
const result = await buildSearchIndex(
  {
    libraryID: 1,
    itemKeys: ["OK", "KEYWORDFAIL", "NOSOURCE", "PARSEFAIL", "OK"],
  },
  {
    async buildIndex(options) {
      buildCalls.push(options);
      return {
        total: 4,
        processed: 4,
        indexed: 4,
        failedCount: 1,
        bodyFailures: 1,
        status: "failed",
      };
    },
    async getIndexStatus(itemKey) {
      return statuses.get(itemKey) ?? null;
    },
    async getKeywordItemKeys() {
      return new Set(["OK", "NOSOURCE", "PARSEFAIL"]);
    },
    async getFailedItems() {
      return [
        {
          libraryID: 1,
          itemKey: "KEYWORDFAIL",
          errorType: "unknown",
          error: "Keyword index write failed for KEYWORDFAIL: disk full",
          timestamp: 1,
        },
      ];
    },
  },
);

assert.deepEqual(buildCalls, [
  {
    itemKeys: ["OK", "KEYWORDFAIL", "NOSOURCE", "PARSEFAIL"],
    libraryID: 1,
    rebuild: false,
    force: true,
  },
]);
assert.deepEqual(
  result.items.map((item) => [
    item.itemKey,
    item.status,
    item.semantic.status,
    item.keyword.status,
  ]),
  [
    ["OK", "success", "success", "success"],
    ["KEYWORDFAIL", "partial_failure", "success", "failed"],
    ["NOSOURCE", "no_source", "metadata_only", "metadata_only"],
    ["PARSEFAIL", "parse_failed", "metadata_only", "metadata_only"],
  ],
  "one lifecycle must report both index branches and real body extraction outcomes per item",
);
assert.deepEqual(result.totals, {
  success: 1,
  partialFailure: 1,
  parseFailed: 1,
  noSource: 1,
  failed: 0,
  busy: 0,
});

let readAfterBusy = false;
const busy = await buildSearchIndex(
  { libraryID: 1, itemKeys: ["RESETBLOCKED"] },
  {
    async buildIndex() {
      return { total: 0, processed: 0, status: "busy" };
    },
    async getIndexStatus() {
      readAfterBusy = true;
      return indexStatus("RESETBLOCKED", "body");
    },
    async getKeywordItemKeys() {
      readAfterBusy = true;
      return new Set(["RESETBLOCKED"]);
    },
    async getFailedItems() {
      readAfterBusy = true;
      return [];
    },
  },
);
assert.equal(readAfterBusy, false);
assert.equal(busy.items[0].status, "busy");
assert.equal(busy.totals.success, 0);
assert.equal(
  busy.totals.busy,
  1,
  "reset/build fences must survive the MCP wrapper instead of exposing an old index as a new success",
);

let readAfterPaused = false;
const paused = await buildSearchIndex(
  { libraryID: 1, itemKeys: ["OLDINDEX"] },
  {
    async buildIndex() {
      return {
        total: 1,
        processed: 0,
        status: "paused",
        error: "Embedding service is unavailable",
      };
    },
    async getIndexStatus() {
      readAfterPaused = true;
      return indexStatus("OLDINDEX", "body");
    },
    async getKeywordItemKeys() {
      readAfterPaused = true;
      return new Set(["OLDINDEX"]);
    },
    async getFailedItems() {
      readAfterPaused = true;
      return [];
    },
  },
);
assert.equal(readAfterPaused, false);
assert.equal(paused.items[0].status, "failed");
assert.match(paused.items[0].semantic.error, /unavailable/iu);

await assert.rejects(
  () =>
    buildSearchIndex(
      {
        libraryID: 1,
        itemKeys: Array.from(
          { length: MAX_SEARCH_INDEX_BUILD_ITEMS + 1 },
          (_, index) => `ITEM${index}`,
        ),
      },
      {},
    ),
  /at most/iu,
);

console.log("search index builder tests passed");
