/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const { FulltextDatabaseService } = await import(
  "../src/modules/fulltextDatabaseService.ts"
);
const { FulltextService } = await import("../src/modules/fulltextService.ts");

const metadataCalls = [];
const textCalls = [];
const searchCalls = [];
const service = new FulltextDatabaseService({
  vectorStore: {
    initialize: async () => {},
    listIndexedContentMetadata: async (libraryID, limit) => {
      metadataCalls.push({ libraryID, limit });
      return {
        total: 2,
        items: [
          {
            itemKey: "A",
            libraryID,
            contentLength: 1234,
            hash: "hash-a",
            indexedAt: 10,
            sourceKind: "markdown-on-demand",
          },
        ],
      };
    },
    getStats: async () => ({
      totalItems: 2,
      totalVectors: 5,
      zhVectors: 1,
      enVectors: 4,
      cachedContentItems: 0,
      cachedContentSizeBytes: 0,
    }),
  },
  fulltextService: {
    searchFulltext: async (query, options) => {
      searchCalls.push({ query, options });
      return {
        results: [
          {
            itemKey: "B",
            totalMatches: 2,
            matches: [{ context: "...needle..." }],
          },
        ],
      };
    },
    getItemFulltextText: async (itemKey, libraryID) => {
      textCalls.push({ itemKey, libraryID });
      return {
        content: `body-${itemKey}`,
        contentLength: 6,
        sources: ["mineru_cache"],
      };
    },
  },
});

await assert.rejects(
  service.execute({ action: "search", query: "needle", libraryID: 7 }),
  /itemKeys.*required/i,
);
assert.equal(searchCalls.length, 0, "unscoped search must perform no body reads");

const searched = await service.execute({
  action: "search",
  query: "needle",
  itemKeys: ["A", "B"],
  libraryID: 7,
  limit: 10,
});
assert.deepEqual(searchCalls[0].options.itemKeys, ["A", "B"]);
assert.equal(searchCalls[0].options.libraryID, 7);
assert.equal(searched.data[0].snippet, "...needle...");
assert.equal(searched.metadata.storageMode, "on-demand");
assert.equal(searched.metadata.sqliteBodyCopies, 0);

const fetched = await service.execute({
  action: "get",
  itemKeys: ["A", "B"],
  libraryID: 7,
});
assert.deepEqual(textCalls, [
  { itemKey: "A", libraryID: 7 },
  { itemKey: "B", libraryID: 7 },
]);
assert.equal(fetched.data[0].content, "body-A");
assert.equal(fetched.metadata.storageMode, "on-demand");

const listed = await service.execute({ action: "list", libraryID: 7, limit: 1 });
assert.deepEqual(metadataCalls, [{ libraryID: 7, limit: 1 }]);
assert.equal(listed.metadata.totalCached, 2, "compatibility count now means indexed metadata");
assert.equal(listed.metadata.sqliteBodyCopies, 0);

const stats = await service.execute({ action: "stats", libraryID: 7 });
assert.equal(stats.data.cachedItems, 0);
assert.equal(stats.data.cachedContentSize, 0);
assert.equal(stats.data.storageMode, "on-demand");
assert.equal(stats.data.indexedItems, 2);

const itemLookups = [];
const bodyReads = [];
globalThis.Zotero.Items = {
  getByLibraryAndKeyAsync: async (libraryID, itemKey) => {
    itemLookups.push({ libraryID, itemKey });
    return {
      key: itemKey,
      itemType: "journalArticle",
      getDisplayTitle: () => `Title ${itemKey}`,
    };
  },
};
globalThis.Zotero.Search = class {
  constructor() {
    throw new Error("whole-library enumeration must not be used");
  }
};
const scopedFulltext = new FulltextService();
scopedFulltext.getItemFulltext = async (itemKey) => {
  bodyReads.push(itemKey);
  return {
    itemKey,
    abstract: itemKey === "A" ? "needle once" : "no match",
    fulltext: { attachments: [], notes: [], webpage: null },
  };
};
await assert.rejects(
  scopedFulltext.searchFulltext("needle", { libraryID: 7 }),
  /itemKeys.*required/i,
);
assert.equal(itemLookups.length, 0);
assert.equal(bodyReads.length, 0);
await scopedFulltext.searchFulltext("needle", {
  libraryID: 7,
  itemKeys: ["A", "B"],
});
assert.deepEqual(itemLookups, [
  { libraryID: 7, itemKey: "A" },
  { libraryID: 7, itemKey: "B" },
]);
assert.deepEqual(
  bodyReads,
  ["A", "B"],
  "search opens only the explicit candidates and each at most once",
);

console.log("On-demand full-text database tests passed");
