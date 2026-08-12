/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fuseHybridSearchResults,
  runHybridSearch,
} from "../src/modules/hybridSearch.ts";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function keywordItem(key, relevanceScore) {
  return { key, title: `Keyword ${key}`, relevanceScore };
}

function semanticItem(itemKey, score) {
  return {
    itemKey,
    title: `Semantic ${itemKey}`,
    score,
    matchedChunks: [{ chunkId: 1, text: itemKey, score }],
  };
}

const fused = fuseHybridSearchResults(
  [keywordItem("A", 9), keywordItem("B", 7), keywordItem("C", 5)],
  [semanticItem("B", 0.9), semanticItem("C", 0.8), semanticItem("D", 0.7)],
  { topK: 4, rrfK: 60, keywordWeight: 1, semanticWeight: 1 },
);

assert.deepEqual(
  fused.map((result) => result.itemKey),
  ["B", "C", "A", "D"],
  "items present in both ranked lists should lead the fused results",
);
assert.equal(fused[0].keywordRank, 2);
assert.equal(fused[0].semanticRank, 1);
assert.equal(fused[0].keywordScore, 7);
assert.equal(fused[0].semanticScore, 0.9);
assert.deepEqual(fused[0].matchedChunks, [
  { chunkId: 1, text: "B", score: 0.9 },
]);
assert.equal(fused[2].semanticRank, undefined);
assert.equal(fused[3].keywordRank, undefined);

const semanticWeighted = fuseHybridSearchResults(
  [keywordItem("A", 9), keywordItem("B", 7)],
  [semanticItem("B", 0.9), semanticItem("A", 0.8)],
  { topK: 2, rrfK: 60, keywordWeight: 0, semanticWeight: 1 },
);
assert.deepEqual(
  semanticWeighted.map((result) => result.itemKey),
  ["B", "A"],
  "zero keyword weight should preserve semantic ordering",
);
assert.ok(
  semanticWeighted.every((result) => result.semanticRank !== undefined),
  "zero keyword weight should exclude keyword-only candidates",
);

const semanticOnlyRun = await runHybridSearch(
  {
    query: "semantic only",
    topK: 2,
    candidateK: 4,
    rrfK: 60,
    keywordWeight: 0,
    semanticWeight: 1,
  },
  {
    keywordSearch: async () => {
      throw new Error("disabled keyword branch executed");
    },
    semanticSearch: async () => [semanticItem("A", 0.9)],
  },
);
assert.equal(semanticOnlyRun.degraded, false);
assert.equal(semanticOnlyRun.keywordResultCount, 0);
assert.deepEqual(
  semanticOnlyRun.results.map((result) => result.itemKey),
  ["A"],
);

const degraded = await runHybridSearch(
  {
    query: "columnar grains",
    topK: 2,
    candidateK: 4,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
  },
  {
    keywordSearch: async () => [keywordItem("A", 9), keywordItem("B", 7)],
    semanticSearch: async () => {
      throw new Error("semantic index unavailable");
    },
  },
);

assert.equal(degraded.degraded, true);
assert.equal(degraded.keywordResultCount, 2);
assert.equal(degraded.semanticResultCount, 0);
assert.deepEqual(
  degraded.results.map((result) => result.itemKey),
  ["A", "B"],
);
assert.match(degraded.warnings[0], /semantic/i);

const serverSource = fs.readFileSync(
  path.join(rootDir, "src/modules/streamableMCPServer.ts"),
  "utf8",
);
assert.match(serverSource, /name:\s*['"]hybrid_search['"]/);
assert.match(serverSource, /case\s+['"]hybrid_search['"]/);
assert.match(serverSource, /callHybridSearch\(/);
assert.ok(
  serverSource.indexOf("name: 'hybrid_search'") <
    serverSource.indexOf("name: 'get_libraries'"),
  "hybrid_search should be listed before other tools",
);
assert.match(serverSource, /required:\s*\[['"]q['"],\s*['"]itemKeys['"]\]/);
assert.match(serverSource, /whole-library full-text scanning is disabled/);

const searchEngineSource = fs.readFileSync(
  path.join(rootDir, "src/modules/searchEngine.ts"),
  "utf8",
);
assert.match(searchEngineSource, /quicksearch-fields/);
assert.doesNotMatch(searchEngineSource, /quicksearch-everything/);
assert.match(
  searchEngineSource,
  /search_library\.fulltext is disabled/,
);

const vectorStoreSource = fs.readFileSync(
  path.join(rootDir, "src/modules/semantic/vectorStore.ts"),
  "utf8",
);
assert.match(vectorStoreSource, /item_key IN \(\$\{placeholders\}\)/);

const fulltextServiceSource = fs.readFileSync(
  path.join(rootDir, "src/modules/fulltextService.ts"),
  "utf8",
);
assert.doesNotMatch(fulltextServiceSource, /Zotero\.Items\.getAll\(libraryID\)/);

await assert.rejects(
  runHybridSearch(
    {
      query: "unavailable",
      topK: 2,
      candidateK: 4,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
    },
    {
      keywordSearch: async () => {
        throw new Error("keyword unavailable");
      },
      semanticSearch: async () => {
        throw new Error("semantic unavailable");
      },
    },
  ),
  /Hybrid search failed/,
);

console.log("Hybrid search regression tests passed");
