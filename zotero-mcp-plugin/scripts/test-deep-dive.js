/* eslint-env node */

/**
 * Regression tests for the single-document (chunk-level) hybrid search and the
 * neighbouring-passage expansion that backs search_fulltext.
 *
 * The semantic branch is a fixture, so what is under test here is the part that
 * is actually new: chunk candidates going through the shared lexical ranker and
 * the shared fusion, the user's threshold and caps being enforced, degraded /
 * warning reporting, and neighbour expansion staying inside its radius.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./deep-dive-hooks.mjs", import.meta.url);

const prefs = new Map();
const PREFIX = "extensions.zotero.zotero-mcp-plugin.";

globalThis.Zotero = {
  Prefs: {
    get: (key) => prefs.get(key),
    set: (key, value) => prefs.set(key, value),
  },
  Libraries: { userLibraryID: 1 },
  Items: {
    getByLibraryAndKeyAsync: async (libraryID, key) =>
      key === "MISSING"
        ? false
        : {
            key,
            libraryID,
            getDisplayTitle: () => "Directional solidification of Al-Cu alloys",
            getField: () => "",
          },
  },
};
globalThis.ztoolkit = { log: () => {} };

const { state } = await import("./fixtures/fake-semantic.mjs");
const { runDocumentDeepDive, expandChunkContext } = await import(
  "../src/modules/documentDeepDive.ts"
);

const CHUNKS = [
  {
    chunkId: 0,
    text: "Introduction: sample preparation and casting setup.",
    language: "en",
  },
  {
    chunkId: 1,
    text: "The columnar-to-equiaxed transition occurred once the temperature gradient dropped below 3 K/mm.",
    language: "en",
  },
  {
    chunkId: 2,
    text: "Figure 3 shows the microstructure after etching.",
    language: "en",
  },
  {
    chunkId: 3,
    text: "The temperature gradient was measured with type-K thermocouples.",
    language: "en",
  },
  {
    chunkId: 4,
    text: "Acknowledgements and funding information.",
    language: "en",
  },
];

function resetFixture() {
  prefs.clear();
  state.chunks = CHUNKS;
  state.semanticError = null;
  state.lastSearchOptions = null;
  state.semanticHits = [
    { chunkId: 1, text: CHUNKS[1].text, score: 0.88 },
    { chunkId: 3, text: CHUNKS[3].text, score: 0.62 },
    { chunkId: 0, text: CHUNKS[0].text, score: 0.12 },
  ];
}

const baseRequest = {
  itemKey: "ABCD1234",
  query:
    "Under what thermal gradient does this alloy show the columnar-to-equiaxed transition? / 该合金在何种温度梯度下出现柱状晶-等轴晶转变？",
  keywords: ["columnar-to-equiaxed transition", "temperature gradient"],
  domain: "materials science / solidification",
  expertRole: "solidification microstructure specialist",
};

// ---- the passages that clear the threshold come back, ranked and scoped ----

resetFixture();
const result = await runDocumentDeepDive(baseRequest);

assert.equal(result.mode, "document_hybrid");
assert.equal(result.itemKey, "ABCD1234");
assert.equal(result.totalChunks, CHUNKS.length);
assert.equal(
  result.keywordSource,
  "ai",
  "keywords plus a declared domain and expert role must be recorded as expert retrieval",
);
assert.equal(result.degraded, false);
assert.deepEqual(result.warnings, []);
assert.equal(
  result.chunks[0].chunkId,
  1,
  "the passage both branches agree on must rank first",
);
assert.ok(
  result.chunks.every((chunk) => chunk.score >= 0.6),
  "passages below the user's threshold must not be returned",
);
assert.ok(
  result.chunks.every((chunk) => chunk.text.length > 0),
  "returned passages must carry their text",
);
assert.ok(
  result.chunks.length < CHUNKS.length,
  "irrelevant passages must be discarded, not returned with a low score",
);
assert.equal(result.metadata.appliedMinScore, 0.6);
assert.equal(result.metadata.appliedMaxChunks, 5);
assert.ok(result.metadata.discardedBelowThreshold > 0);
// The semantic branch must be scoped to this one document.
assert.equal(state.lastSearchOptions.itemKey, "ABCD1234");

// ---- the caps are ceilings the caller cannot raise ----

resetFixture();
prefs.set(PREFIX + "hybrid.maxChunksPerItem", 1);
const capped = await runDocumentDeepDive({ ...baseRequest, maxChunks: 20 });
assert.equal(capped.chunks.length, 1, "the user's per-document cap wins");
assert.match(capped.warnings.join(" "), /per-document limit/i);

resetFixture();
const stricter = await runDocumentDeepDive({ ...baseRequest, maxChunks: 1 });
assert.equal(stricter.chunks.length, 1, "the caller may ask for fewer");
assert.deepEqual(
  stricter.warnings,
  [],
  "asking for fewer is not a degradation",
);

resetFixture();
const loosened = await runDocumentDeepDive({ ...baseRequest, minScore: 0.1 });
assert.equal(
  loosened.metadata.appliedMinScore,
  0.6,
  "a caller must not be able to lower the user's relevance threshold",
);
assert.match(loosened.warnings.join(" "), /raised to/i);

// ---- nothing relevant means nothing returned ----

resetFixture();
state.semanticHits = [{ chunkId: 4, text: CHUNKS[4].text, score: 0.05 }];
const empty = await runDocumentDeepDive({
  ...baseRequest,
  query: "unrelated question about neural network training / 无关问题",
  keywords: ["backpropagation", "神经网络"],
});
assert.equal(empty.chunks.length, 0);
assert.match(String(empty.metadata.nextStep), /threshold/i);

// ---- provenance and degraded reporting ----

resetFixture();
const undeclared = await runDocumentDeepDive({
  ...baseRequest,
  expertRole: undefined,
});
assert.equal(undeclared.keywordSource, "fallback");
assert.equal(undeclared.degraded, true);
assert.match(
  undeclared.warning,
  /Do not simply reuse the library-level (?:bilingual )?search terms/,
);
assert.ok(
  undeclared.chunks.length > 0,
  "an unverified rewrite still returns real results; only the label degrades",
);

resetFixture();
const mechanical = await runDocumentDeepDive({
  ...baseRequest,
  keywords: undefined,
});
assert.equal(mechanical.keywordSource, "fallback");
assert.equal(mechanical.degraded, true);
assert.match(mechanical.metadata.keywordFallbackReason, /tokenization/i);

// A failed semantic branch degrades the result but keeps the keyword ranking.
resetFixture();
state.semanticError = new Error("embedding endpoint unreachable");
const semanticDown = await runDocumentDeepDive(baseRequest);
assert.equal(semanticDown.degraded, true);
assert.match(semanticDown.warnings.join(" "), /Semantic search unavailable/i);
assert.ok(
  semanticDown.chunks.length > 0,
  "a dead semantic branch must fall back to keyword ranking, not fail the call",
);

// ---- errors that must not be papered over ----

resetFixture();
state.chunks = [];
await assert.rejects(
  () => runDocumentDeepDive(baseRequest),
  /no indexed full text/i,
  "an unindexed document must say so instead of returning nothing quietly",
);

resetFixture();
await assert.rejects(
  () => runDocumentDeepDive({ ...baseRequest, itemKey: "MISSING" }),
  /was not found/i,
);
await assert.rejects(
  () => runDocumentDeepDive({ ...baseRequest, query: "  " }),
  /query must not be blank/i,
);

// ---- neighbour expansion ----

resetFixture();
const expanded = await expandChunkContext({
  itemKey: "ABCD1234",
  chunkIds: [2],
});
assert.deepEqual(
  expanded.chunks.map((chunk) => chunk.chunkId),
  [1, 2, 3],
  "radius 1 must return the passage plus one neighbour on each side, in reading order",
);
assert.deepEqual(
  expanded.chunks.map((chunk) => chunk.role),
  ["context", "anchor", "context"],
);
assert.equal(expanded.appliedRadius, 1);
assert.equal(expanded.degraded, false);

resetFixture();
const clamped = await expandChunkContext({
  itemKey: "ABCD1234",
  chunkIds: [2],
  radius: 9,
});
assert.equal(
  clamped.appliedRadius,
  1,
  "the user's radius limit cannot be raised",
);
assert.equal(clamped.chunks.length, 3);
assert.match(clamped.warnings.join(" "), /capped at 1/);

resetFixture();
prefs.set(PREFIX + "hybrid.neighborRadius", 0);
const noExpansion = await expandChunkContext({
  itemKey: "ABCD1234",
  chunkIds: [2],
});
assert.deepEqual(
  noExpansion.chunks.map((chunk) => chunk.chunkId),
  [2],
  "radius 0 must return only the requested passage",
);

// Document edges must not wrap around or invent passages.
resetFixture();
const atStart = await expandChunkContext({
  itemKey: "ABCD1234",
  chunkIds: [0],
});
assert.deepEqual(
  atStart.chunks.map((chunk) => chunk.chunkId),
  [0, 1],
);

resetFixture();
const unknown = await expandChunkContext({
  itemKey: "ABCD1234",
  chunkIds: [1, 999],
});
assert.deepEqual(
  unknown.chunks.map((chunk) => chunk.chunkId),
  [0, 1, 2],
);
assert.equal(
  unknown.degraded,
  true,
  "a partly-ignored request is a partial failure and must be flagged",
);
assert.match(unknown.warnings.join(" "), /999/);

await assert.rejects(
  () => expandChunkContext({ itemKey: "ABCD1234", chunkIds: [] }),
  /non-empty array/i,
);

console.log("Document deep-dive regression tests passed");
