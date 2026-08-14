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
  },
  Libraries: { userLibraryID: 1 },
};
globalThis.ztoolkit = { log: () => {} };

const PREFIX = "extensions.zotero.zotero-mcp-plugin.";

const { TextChunker } = await import("../src/modules/semantic/textChunker.ts");
const { validateHybridSearchOptions, CANDIDATE_K_BOUNDS } = await import(
  "../src/modules/hybridSearch.ts"
);
const {
  getHybridSearchSettings,
  resolveResultCap,
  resolveScoreFloor,
  resolveNeighborRadius,
  resolveCandidateDepth,
  getChunkingSignature,
  HYBRID_SETTING_BOUNDS,
} = await import("../src/modules/hybridSearchSettings.ts");

// ---- settings: defaults, clamping, and "the user's value is a ceiling" ----

prefs.clear();
const defaults = getHybridSearchSettings();
assert.equal(defaults.maxDocuments, 20);
assert.equal(defaults.candidateK, 240);
assert.equal(defaults.maxChunksPerItem, 5);
assert.equal(defaults.minScore, 0.6);
assert.equal(defaults.chunkTargetChars, 1000);
assert.equal(defaults.chunkAppendToleranceChars, 500);
assert.equal(defaults.neighborRadius, 1);

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
  100,
  "out-of-range preferences must be clamped on read",
);
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

// RETRIEVAL DEPTH is the one setting that is a default rather than a ceiling.
//
// The others exist to stop an AI returning more or filtering less than the user
// allows. This one only decides how far down the library is examined, and the
// response explicitly tells the caller to raise it when the candidate pool came
// back full — an instruction that would be impossible to follow if the caller's
// value were clamped to the user's.
prefs.clear();
prefs.set(PREFIX + "hybrid.candidateK", 200);
assert.equal(getHybridSearchSettings().candidateK, 200);
assert.equal(
  resolveCandidateDepth(undefined, 200).value,
  200,
  "no request means the user's configured depth",
);
assert.deepEqual(
  resolveCandidateDepth(480, 200),
  { value: 480, clamped: false },
  "a caller may dig DEEPER than the user's default - this one is not a cap",
);
assert.deepEqual(
  resolveCandidateDepth(50, 200),
  { value: 50, clamped: false },
  "and may dig shallower for a quick look",
);

// The hard bounds are a latency guard, and they are reported when they bite.
const depthBounds = HYBRID_SETTING_BOUNDS.candidateK;
assert.deepEqual(resolveCandidateDepth(99999, 240), {
  value: depthBounds.max,
  clamped: true,
});
assert.deepEqual(resolveCandidateDepth(1, 240), {
  value: depthBounds.min,
  clamped: true,
});
assert.throws(() => resolveCandidateDepth(0, 240), /positive integer/);
assert.throws(() => resolveCandidateDepth(-5, 240), /positive integer/);
assert.throws(() => resolveCandidateDepth("deep", 240), /positive integer/);

// A corrupt or out-of-range stored preference must not disable retrieval.
prefs.set(PREFIX + "hybrid.candidateK", 100000);
assert.equal(getHybridSearchSettings().candidateK, depthBounds.max);
prefs.set(PREFIX + "hybrid.candidateK", "not a number");
assert.equal(getHybridSearchSettings().candidateK, 240);
prefs.clear();

// EVERY value the resolver can produce must be accepted by the SEARCH ENGINE.
//
// This is the check that was missing while three places each carried their own
// copy of these bounds: the settings clamped a large request to 600, one
// validator rejected anything above 500, and a third required candidateK to be
// at least topK. Asking for a deeper sweep therefore failed outright instead of
// being clamped, and a small configured depth with a large page size threw on
// every search. Testing the resolver on its own could never see any of it —
// only running its output through the real validator can.
{
  const pageSizes = [1, 5, 20, 100];
  const requests = [
    undefined,
    1,
    20,
    depthBounds.min,
    100,
    240,
    depthBounds.max,
    depthBounds.max + 1,
    99999,
  ];
  for (const pageSize of pageSizes) {
    for (const requested of requests) {
      const { value } = resolveCandidateDepth(requested, 240);
      assert.ok(
        Number.isInteger(value),
        `depth must be an integer (page ${pageSize}, request ${requested})`,
      );
      assert.ok(
        value >= depthBounds.min && value <= depthBounds.max,
        `depth ${value} must stay inside the configured bounds`,
      );
      // Exactly what callHybridSearch builds: a pool smaller than a page is
      // raised to the page size rather than rejected.
      const effective = Math.max(value, pageSize);
      assert.doesNotThrow(
        () =>
          validateHybridSearchOptions({
            query: "a question",
            topK: pageSize,
            candidateK: effective,
            rrfK: 60,
            keywordWeight: 1,
            semanticWeight: 1,
            minScore: 0.6,
          }),
        `the engine must accept depth ${effective} with page size ${pageSize} (requested ${requested})`,
      );
    }
  }

  // And the bounds really are one definition, not two that happen to agree.
  assert.equal(depthBounds, CANDIDATE_K_BOUNDS);
}

// The signature only tracks chunk layout: query-time caps — including the new
// retrieval depth — must not invalidate an index that is otherwise current.
const signature = getChunkingSignature({
  ...defaults,
  maxDocuments: 3,
  minScore: 0.9,
  candidateK: 600,
});
assert.equal(signature, getChunkingSignature(defaults));
assert.notEqual(
  getChunkingSignature({ ...defaults, chunkTargetChars: 800 }),
  signature,
);

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
