/* eslint-env node */

/**
 * Regression tests for the paragraph-based chunker and the hybrid search
 * settings that drive it.
 *
 * The rules under test are the ones the retrieval design depends on:
 * chunks follow Markdown paragraphs, aim at the target length, may absorb one
 * short trailing paragraph, split oversized paragraphs on complete sentences,
 * keep document order (so chunk ids are reading order), and never drop body
 * text on the way.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

// Plugin sources import each other without a file extension (esbuild resolves
// that at build time), so teach Node's resolver the same trick before the
// dynamic imports below.
register("./ts-ext-hooks.mjs", import.meta.url);

// The chunker logs through ztoolkit and reads the user's preferences through
// Zotero.Prefs, so both have to exist before the module is imported.
const prefs = new Map();
globalThis.Zotero = {
  Prefs: {
    get: (key) => prefs.get(key),
    set: (key, value) => prefs.set(key, value),
    clear: (key) => prefs.delete(key),
  },
  Libraries: { userLibraryID: 1 },
};
globalThis.ztoolkit = { log: () => {} };

const PREFIX = "extensions.zotero.zotero-mcp-plugin.";

const { TextChunker } = await import("../src/modules/semantic/textChunker.ts");
const { validateHybridSearchOptions } = await import(
  "../src/modules/hybridSearch.ts"
);
const {
  getHybridSearchSettings,
  setVectorScanTimeoutMs,
  setKeywordSearchTimeoutMs,
  resolveResultCap,
  resolveScoreFloor,
  resolveNeighborRadius,
  getChunkingSignature,
  HYBRID_SETTING_BOUNDS,
  INDEX_CHUNK_SIGNATURE_PREF,
  getStoredChunkingSignature,
  hasIncompleteFullLibraryRebuild,
  hasUntrustedLegacyChunkingSignature,
  invalidateStoredChunkingSignature,
  setStoredChunkingSignature,
  clearStoredChunkingSignatures,
  shouldShowChunkingWarning,
  shouldRecordFullLibraryChunkingSignature,
} = await import("../src/modules/hybridSearchSettings.ts");

// ---- settings: defaults, clamping, and "the user's value is a ceiling" ----

prefs.clear();
const defaults = getHybridSearchSettings();
assert.equal(defaults.gpuPrecision, "auto");
assert.equal(defaults.maxDocuments, 20);
assert.equal("candidateK" in defaults, false);
assert.equal(defaults.maxChunksPerItem, 5);
assert.equal(defaults.vectorScanTimeoutMs, 8000);
assert.equal(defaults.keywordSearchTimeoutMs, 30000);
assert.equal(defaults.minScore, 0.6);
assert.equal(defaults.chunkTargetChars, 1000);
assert.equal(defaults.chunkAppendToleranceChars, 500);
assert.equal(defaults.neighborRadius, 1);
prefs.set(PREFIX + "hybrid.gpuPrecision", "float32");
assert.equal(getHybridSearchSettings().gpuPrecision, "float32");
prefs.set(PREFIX + "hybrid.gpuPrecision", "corrupt");
assert.equal(getHybridSearchSettings().gpuPrecision, "auto");
prefs.clear();

// The threshold is stored as a string because preference files have no float
// type; reading it must still yield a number.
prefs.set(PREFIX + "hybrid.minScore", "0.75");
assert.equal(getHybridSearchSettings().minScore, 0.75);
prefs.set(PREFIX + "hybrid.minScore", "not a number");
assert.equal(
  getHybridSearchSettings().minScore,
  0.6,
  "a corrupt threshold must fall back to the default, not disable filtering",
);
prefs.set(PREFIX + "hybrid.maxDocuments", 100000);
assert.equal(
  getHybridSearchSettings().maxDocuments,
  20,
  "out-of-range preferences must be clamped on read",
);
prefs.clear();

assert.equal(setVectorScanTimeoutMs(1234.01), 1235);
assert.equal(
  getHybridSearchSettings().vectorScanTimeoutMs,
  1235,
  "the benchmark recommendation must persist across a fresh settings read",
);
assert.equal(setVectorScanTimeoutMs(9_000_000), 3_600_000);
assert.equal(setKeywordSearchTimeoutMs(12_345.2), 12_346);
assert.equal(
  getHybridSearchSettings().keywordSearchTimeoutMs,
  12_346,
  "the keyword-search recommendation must persist across a fresh settings read",
);
// Both ends of the keyword bounds, so neither an absurd nor a sub-second value
// can be stored: a 5ms keyword timeout would fail every real search.
assert.equal(setKeywordSearchTimeoutMs(5), 1000);
assert.equal(setKeywordSearchTimeoutMs(9_000_000), 3_600_000);
prefs.clear();

// A caller may ask for less, never for more.
assert.equal(resolveResultCap(undefined, 20).value, 20);
assert.equal(resolveResultCap(5, 20).value, 5);
assert.deepEqual(resolveResultCap(50, 20), { value: 20, clamped: true });

// A caller may be stricter, never looser.
assert.equal(resolveScoreFloor(undefined, 0.6).value, 0.6);
assert.equal(resolveScoreFloor(0.8, 0.6).value, 0.8);
assert.deepEqual(resolveScoreFloor(0.1, 0.6), { value: 0.6, clamped: true });

assert.equal(resolveNeighborRadius(undefined, 1).value, 1);
assert.equal(resolveNeighborRadius(0, 1).value, 0);
assert.deepEqual(resolveNeighborRadius(9, 1), { value: 1, clamped: true });

assert.deepEqual(HYBRID_SETTING_BOUNDS.maxDocuments, { min: 1, max: 20 });
assert.doesNotThrow(() =>
  validateHybridSearchOptions({
    query: "a question",
    topK: 20,
    candidateK: 999999,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
    minScore: 0.6,
  }),
  "legacy clients may still send candidateK; it is ignored",
);
assert.throws(
  () => validateHybridSearchOptions({
    query: "a question",
    topK: 21,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
  }),
  /between 1 and 20/,
);

// The signature only tracks chunk layout, not query-time controls.
const signature = getChunkingSignature({
  ...defaults,
  maxDocuments: 3,
  minScore: 0.9,
});
assert.equal(signature, getChunkingSignature(defaults));
assert.notEqual(
  getChunkingSignature({ ...defaults, chunkTargetChars: 800 }),
  signature,
);

// Chunk signatures are per Library. A legacy global value proves completion
// for none of them and remains untrusted until each Library is rebuilt.
prefs.clear();
prefs.set(INDEX_CHUNK_SIGNATURE_PREF, "paragraph-v2:1000:500");
assert.equal(getStoredChunkingSignature(1), null);
assert.equal(getStoredChunkingSignature(2), null);
assert.equal(hasUntrustedLegacyChunkingSignature(1), true);
assert.equal(hasUntrustedLegacyChunkingSignature(2), true);
setStoredChunkingSignature(1, "sig-library-1");
assert.equal(getStoredChunkingSignature(1), "sig-library-1");
assert.equal(getStoredChunkingSignature(2), null);
assert.equal(hasUntrustedLegacyChunkingSignature(1), false);
assert.equal(hasUntrustedLegacyChunkingSignature(2), true);
setStoredChunkingSignature(2, "sig-library-2");
assert.equal(getStoredChunkingSignature(1), "sig-library-1");
assert.equal(getStoredChunkingSignature(2), "sig-library-2");

invalidateStoredChunkingSignature(2);
assert.equal(getStoredChunkingSignature(1), "sig-library-1");
assert.equal(getStoredChunkingSignature(2), null);
assert.equal(hasIncompleteFullLibraryRebuild(1), false);
assert.equal(hasIncompleteFullLibraryRebuild(2), true);
setStoredChunkingSignature(2, "sig-library-2-new");
assert.equal(hasIncompleteFullLibraryRebuild(2), false);

assert.equal(
  shouldShowChunkingWarning({
    chunkCount: 0,
    float32VectorCount: 0,
    indexedItemCount: 0,
    storedSignature: null,
    currentSignature: signature,
    incomplete: true,
    legacyUntrusted: true,
  }),
  false,
  "an empty Library must never inherit a stale chunk warning",
);
assert.equal(
  shouldShowChunkingWarning({
    chunkCount: 1,
    float32VectorCount: 1,
    indexedItemCount: 1,
    storedSignature: null,
    currentSignature: signature,
    incomplete: false,
    legacyUntrusted: true,
  }),
  true,
);
clearStoredChunkingSignatures();
assert.equal(prefs.has(INDEX_CHUNK_SIGNATURE_PREF), false);

const workingSetPreference = Zotero.Prefs.set;
Zotero.Prefs.set = () => {
  throw new Error("preference storage unavailable");
};
assert.throws(
  () => invalidateStoredChunkingSignature(2),
  /preference storage unavailable/,
  "a rebuild must not proceed to clearing if signature invalidation failed",
);
Zotero.Prefs.set = workingSetPreference;

const completeRebuild = {
  rebuild: true,
  itemKeysProvided: false,
  status: "completed",
  processed: 10,
  total: 10,
  failedCount: 0,
};
assert.equal(shouldRecordFullLibraryChunkingSignature(completeRebuild), true);
assert.equal(shouldRecordFullLibraryChunkingSignature({ ...completeRebuild, itemKeysProvided: true }), false);
assert.equal(shouldRecordFullLibraryChunkingSignature({ ...completeRebuild, processed: 9 }), false);
assert.equal(shouldRecordFullLibraryChunkingSignature({ ...completeRebuild, failedCount: 1 }), false);
assert.equal(shouldRecordFullLibraryChunkingSignature({ ...completeRebuild, status: "aborted" }), false);

// ---- chunking ----

function chunker(overrides = {}) {
  return new TextChunker({
    targetChunkSize: 1000,
    appendToleranceSize: 500,
    skipReferences: true,
    ...overrides,
  });
}

const para = (label, length) =>
  `${label}. ` +
  "本段落用于测试分块规则，句子结束。".repeat(
    Math.max(1, Math.ceil(length / 18)),
  );

// Paragraphs are the unit: several short ones merge until the target is met.
const shortParagraphs = Array.from({ length: 12 }, (_, i) =>
  para(`第${i}段`, 200),
).join("\n\n");
const merged = chunker().chunk(shortParagraphs);
assert.ok(merged.length > 1, "a long document must produce several chunks");
assert.ok(
  merged.every((chunk) => chunk.length <= 1500),
  "no chunk may exceed target + tolerance",
);
assert.ok(
  merged.slice(0, -1).every((chunk) => chunk.length >= 400),
  "chunks should fill up towards the target rather than staying tiny",
);

// A short trailing paragraph joins the chunk that already hit the target; a
// long one starts the next chunk instead.
const withShortTail = [para("A", 980), "简短的收尾段。"].join("\n\n");
assert.equal(
  chunker().chunk(withShortTail).length,
  1,
  "a paragraph within the append tolerance must join the chunk at target",
);

const withLongTail = [para("A", 980), para("B", 900)].join("\n\n");
assert.equal(
  chunker().chunk(withLongTail).length,
  2,
  "a paragraph beyond the append tolerance must start a new chunk",
);

// Oversized paragraphs are split on complete sentences, never mid-sentence.
const longParagraph =
  "第一句话在这里结束。" +
  "这是一个很长的段落，需要按完整句子继续切分而不能截断。".repeat(80);
const sentenceSplit = chunker().chunk(longParagraph);
assert.ok(sentenceSplit.length > 1, "an oversized paragraph must be split");
for (const chunk of sentenceSplit) {
  assert.ok(
    /[。！？.!?;；]$/.test(chunk.trim()),
    `a sentence-split chunk must end on sentence punctuation: ...${chunk.slice(-20)}`,
  );
}

// Nothing may be lost: every non-whitespace character of the body survives.
function condense(text) {
  return text.replace(/\s+/g, "");
}
const body = [
  "# 引言",
  para("引言", 700),
  para("方法", 1600),
  "很短的一段。",
  para("结论", 300),
].join("\n\n");
const bodyChunks = chunker().chunk(body);
assert.equal(
  condense(bodyChunks.join("")),
  condense(body),
  "chunking must preserve the body text exactly, in order",
);

// Reading order is chunk order, which is what neighbour expansion relies on.
const ordered = chunker().chunk(
  ["ALPHA 开头段。", para("中间", 1200), "OMEGA 结尾段。"].join("\n\n"),
);
assert.ok(ordered[0].startsWith("ALPHA"));
assert.ok(ordered[ordered.length - 1].endsWith("OMEGA 结尾段。"));

// References are citations, not body text, and stay out of the index.
const withReferences = [
  para("正文", 600),
  "参考文献",
  "[1] Some Author, Journal, 2020.",
  "[2] Another Author, Journal, 2021.",
].join("\n\n");
const withoutRefs = chunker().chunk(withReferences).join("");
assert.ok(!withoutRefs.includes("Some Author"));
assert.ok(
  chunker({ skipReferences: false })
    .chunk(withReferences)
    .join("")
    .includes("Some Author"),
  "skipReferences: false must keep the reference list",
);

// A text with no sentence punctuation at all still has to be chunked without
// losing anything — an unpunctuated OCR run must not become one giant chunk.
const unpunctuated = "数据".repeat(2000);
const hard = chunker().chunk(unpunctuated);
assert.ok(hard.length > 1);
assert.ok(hard.every((chunk) => chunk.length <= 1500));
assert.equal(condense(hard.join("")), condense(unpunctuated));

// Settings drive the chunker live: no restart needed after changing them.
prefs.set(PREFIX + "hybrid.chunkTargetChars", 300);
prefs.set(PREFIX + "hybrid.chunkAppendToleranceChars", 100);
const smallChunks = new TextChunker({ skipReferences: true }).chunk(
  shortParagraphs,
);
assert.ok(
  smallChunks.every((chunk) => chunk.length <= 400),
  "a smaller configured target must take effect without recreating the chunker",
);
prefs.clear();

console.log("Chunking and hybrid-settings regression tests passed");
