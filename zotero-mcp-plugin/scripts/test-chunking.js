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
// This file creates the Zotero global itself a few lines down, so it is
// declared here rather than in eslint.config.mjs — a scripts/**-wide global
// would stop `no-undef` from catching a stray Zotero reference in the ~40
// other test scripts, which have no such stub.
/* global Zotero */
const prefs = new Map();
globalThis.Zotero = {
  Prefs: {
    get: (key) => prefs.get(key),
    set: (key, value) => prefs.set(key, value),
    clear: (key) => prefs.delete(key),
    has: (key) => prefs.has(key),
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
  HYBRID_SETTING_RECOMMENDATIONS: RECOMMENDATIONS,
  migrateFusedScoreThreshold,
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
assert.equal(defaults.keywordMinScore, 0.52);
assert.equal(defaults.semanticMinScore, 0.6);
assert.equal(defaults.keywordRrfWeight, 1);
assert.equal(defaults.semanticRrfWeight, 1);
// The retired single floor must be gone from the settings object entirely, not
// merely unused: leaving it readable is what would let a later change quietly
// reintroduce a second filter on top of the RRF ranking.
assert.equal("minScore" in defaults, false);
// The pane's "推荐值" hints and the shipped defaults are the same table, so a
// hint can never advertise a number the plugin does not actually start from.
assert.equal(defaults.keywordMinScore, RECOMMENDATIONS.keywordMinScore);
assert.equal(defaults.semanticMinScore, RECOMMENDATIONS.semanticMinScore);
assert.equal(defaults.keywordRrfWeight, RECOMMENDATIONS.keywordRrfWeight);
assert.equal(defaults.semanticRrfWeight, RECOMMENDATIONS.semanticRrfWeight);
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
prefs.set(PREFIX + "hybrid.semanticMinScore", "0.75");
assert.equal(getHybridSearchSettings().semanticMinScore, 0.75);
prefs.set(PREFIX + "hybrid.semanticMinScore", "not a number");
assert.equal(
  getHybridSearchSettings().semanticMinScore,
  0.6,
  "a corrupt threshold must fall back to the default, not disable filtering",
);
prefs.clear();
prefs.set(PREFIX + "hybrid.keywordMinScore", "0.4");
assert.equal(getHybridSearchSettings().keywordMinScore, 0.4);
assert.equal(
  getHybridSearchSettings().semanticMinScore,
  0.6,
  "the two thresholds are independent settings, not one value read twice",
);
prefs.clear();
prefs.set(PREFIX + "hybrid.keywordRrfWeight", "2.5");
assert.equal(getHybridSearchSettings().keywordRrfWeight, 2.5);
prefs.set(PREFIX + "hybrid.keywordRrfWeight", "9999");
assert.equal(
  getHybridSearchSettings().keywordRrfWeight,
  10,
  "an out-of-range weight is clamped, not accepted",
);
prefs.clear();
// ---- the one-shot migration of the retired fused-score threshold ----

// A user who never touched the old threshold has nothing to carry over, and
// must be left entirely alone rather than have a value written on their behalf.
prefs.clear();
prefs.set(PREFIX + "hybrid.minScore", "0.6");
let migration = migrateFusedScoreThreshold();
assert.equal(migration.migrated, false);
assert.equal(migration.reason, "left-at-default");
assert.equal(
  prefs.has(PREFIX + "hybrid.semanticMinScore"),
  false,
  "an untouched default must not be written through as a user value",
);
assert.equal(getHybridSearchSettings().semanticMinScore, 0.6);
assert.equal(getHybridSearchSettings().keywordMinScore, 0.52);

// A user who HAD tuned it keeps that tuning, on the semantic side — the side
// where the number still means what it meant, because a semantic-only match's
// old fused score was exactly its cosine similarity.
prefs.clear();
prefs.set(PREFIX + "hybrid.minScore", "0.75");
migration = migrateFusedScoreThreshold();
assert.equal(migration.migrated, true);
assert.equal(migration.reason, "carried-over");
assert.equal(migration.value, 0.75);
assert.equal(getHybridSearchSettings().semanticMinScore, 0.75);
// The keyword side starts from its own measured recommendation instead: the
// old number was never a BM25F threshold, so reusing it there would invent a
// calibration rather than migrate one.
assert.equal(
  getHybridSearchSettings().keywordMinScore,
  RECOMMENDATIONS.keywordMinScore,
  "the old fused floor must not be reused as a keyword floor",
);

// Once is once. A second run must not overwrite a value the user has since
// changed in the new pane.
prefs.set(PREFIX + "hybrid.semanticMinScore", "0.5");
migration = migrateFusedScoreThreshold();
assert.equal(migration.migrated, false);
assert.equal(migration.reason, "already-migrated");
assert.equal(getHybridSearchSettings().semanticMinScore, 0.5);
prefs.clear();

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

// The version half of the signature announces that the RULES moved, not the
// settings. It was left at v5 when sentence splitting was fixed, and the
// consequence was concrete: an explicit rebuild of the affected paper
// reported success and returned the same chunks, because nothing downstream
// could tell that the chunks predated the fix.
assert.match(
  signature,
  /^paragraph-v6:/u,
  "a chunker change that moves boundaries has to bump the signature version",
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

// ---------------------------------------------------------------------------
// A heading always ends the open chunk
// ---------------------------------------------------------------------------

const { stripFrontMatterDuplicates } = await import(
  "../src/modules/keyword/contentFilters.ts"
);

const headingChunker = new TextChunker({
  targetChunkSize: 1000,
  appendToleranceSize: 500,
  skipReferences: true,
});
const isHeading = (line) => /^\s{0,3}#{1,6}\s+\S/.test(line);

const sectioned = [
  "## 1. Introduction",
  "Short opening line.",
  "## 2. Method",
  "Another short line.",
  "### 2.1 Setup",
  "Setup detail.",
].join("\n\n");
const sectionedChunks = headingChunker.chunk(sectioned);

// Every chunk sits inside exactly one section: once body text has started, no
// further heading may appear. Consecutive headings before any body are a stack
// resolving to the deepest of them, and are allowed.
const spansSection = (chunk) => {
  const lines = chunk.split("\n").filter((line) => line.trim());
  const firstBody = lines.findIndex((line) => !isHeading(line));
  return firstBody >= 0 && lines.slice(firstBody).some(isHeading);
};
for (const chunk of sectionedChunks) {
  assert.ok(!spansSection(chunk), `chunk must not span a section: ${JSON.stringify(chunk)}`);
}
assert.deepEqual(sectionedChunks, [
  "## 1. Introduction\n\nShort opening line.",
  "## 2. Method\n\nAnother short line.",
  "### 2.1 Setup\n\nSetup detail.",
]);

// The cut happens however short the open chunk is — these three sections
// together are far below the 1000-character target and would previously have
// been merged into one chunk.
assert.equal(
  sectionedChunks.length,
  3,
  "a heading truncates the open chunk regardless of its length",
);

// A heading introducing an oversized paragraph rides along on the first piece
// instead of being published as a chunk containing only the heading.
const longBody = `${"This sentence carries the section's argument. ".repeat(60)}`;
const oversized = headingChunker.chunk(`## 3. Results\n\n${longBody}`);
assert.ok(oversized.length > 1, "the oversized paragraph must still be split");
assert.ok(
  oversized[0].startsWith("## 3. Results\n\n"),
  "the heading must open the first piece of the section it introduces",
);
assert.ok(
  !oversized.some((chunk) => chunk.trim() === "## 3. Results"),
  "no chunk may consist of nothing but a heading",
);

// A heading is never published on its own, whatever the size arithmetic says.
// Its section's first paragraph may be too long to fit under the target and
// too long to count as a tail, which used to orphan the heading.
const orphanCheck = headingChunker.chunk(
  `## 1. Introduction\n\n${"Body sentence that runs long. ".repeat(45)}`,
);
assert.ok(
  orphanCheck[0].startsWith("## 1. Introduction\n\n"),
  "a heading must stay with the paragraph it introduces",
);
assert.ok(
  !orphanCheck.some((chunk) => !/\n/.test(chunk) && isHeading(chunk)),
  "no chunk may hold only a heading",
);

// Consecutive headings stack instead of each becoming an empty chunk.
const stacked = headingChunker.chunk(
  "## 2. Method\n\n### 2.1 Setup\n\nThe setup is described here.",
);
assert.deepEqual(stacked, [
  "## 2. Method\n\n### 2.1 Setup\n\nThe setup is described here.",
]);

// Sizing is otherwise untouched: paragraphs inside one section still fill to
// the target and absorb a short tail exactly as before.
const oneSection = [
  "## 4. Discussion",
  "a".repeat(600),
  "b".repeat(300),
  "c".repeat(80),
].join("\n\n");
const filled = headingChunker.chunk(oneSection);
assert.equal(filled.length, 1, "paragraphs within a section still pack together");

// ---------------------------------------------------------------------------
// Front matter the item record already holds
// ---------------------------------------------------------------------------

const metadata = {
  title: "A Study of Columnar Grains",
  abstract:
    "This work studies columnar grain growth under directional solidification " +
    "and reports the resulting mechanical properties across five distinct heat " +
    "treatment schedules applied to nickel superalloy blade specimens.",
  creators: ["Jiayu Pan", "Feng Liu"],
};
const paper = [
  "# A Study of Columnar Grains",
  "Jiayu Pan $^{a}$ , Feng Liu $^{b,*}$",
  "$^{a}$ Department of Mechanical Engineering, Tsinghua University, Beijing 100084, China",
  "## ABSTRACT",
  "This work studies columnar grain growth under directional solidification and " +
    "reports the resulting mechanical properties across five distinct heat " +
    "treatment schedules applied to nickel superalloy blade specimens.",
  "Keywords: columnar grain, directional solidification",
  "## 1. Introduction",
  "Columnar grains matter because they set the creep life of a blade.",
].join("\n\n");

const stripped = stripFrontMatterDuplicates(paper, metadata);
assert.equal(stripped.matchedAbstract, true);
assert.equal(
  stripped.text,
  "## 1. Introduction\n\nColumnar grains matter because they set the creep life of a blade.",
);

// An abstract that differs slightly — a formula the record spells out — still
// matches, because maths and punctuation are dropped before comparison.
const withFormula = stripFrontMatterDuplicates(
  [
    "## Abstract",
    "This work studies columnar grain growth under $\\alpha$ directional solidification and " +
      "reports the resulting mechanical properties across five distinct heat " +
      "treatment schedules applied to nickel superalloy blade specimens.",
    "## 1. Introduction",
    "Body text.",
  ].join("\n\n"),
  metadata,
);
assert.equal(withFormula.matchedAbstract, true);
assert.equal(withFormula.text, "## 1. Introduction\n\nBody text.");

// Nothing past the front matter is ever touched, even when it restates the
// abstract closely — a conclusions section must survive.
const withConclusion = stripFrontMatterDuplicates(
  [
    "## 1. Introduction",
    "Body text.",
    "## 5. Conclusions",
    "This work studies columnar grain growth under directional solidification and " +
      "reports the resulting mechanical properties across five distinct heat " +
      "treatment schedules applied to nickel superalloy blade specimens.",
  ].join("\n\n"),
  metadata,
);
assert.match(withConclusion.text, /## 5\. Conclusions/);
assert.match(withConclusion.text, /columnar grain growth under directional/);

// When the record cannot vouch for the front matter — a translated PDF, or an
// abstract that was never printed — nothing is cut.
const unmatched = stripFrontMatterDuplicates(
  ["# 完全不同的标题", "一段与元数据毫无关系的正文。"].join("\n\n"),
  {
    title: "Something Entirely Different",
    abstract:
      "An abstract with no shared vocabulary whatsoever regarding unrelated matters " +
      "of astronomy and celestial navigation across the southern hemisphere.",
    creators: ["Nobody At All"],
  },
);
assert.equal(unmatched.matchedAbstract, false);
assert.match(unmatched.text, /完全不同的标题/);
assert.match(unmatched.text, /毫无关系的正文/);

// A patent's claims restate the title in almost every clause; the length guard
// is what keeps them from being deleted as title duplicates.
const patent = stripFrontMatterDuplicates(
  [
    "## (54) 发明名称",
    "一种单晶TiAl的等温锻造方法",
    "## (57) 摘要",
    "本发明公开了一种单晶TiAl的等温锻造方法，属于TiAl金属间化合物单晶材料加工技术领域，通过等温锻造获得单晶产品。",
    "1.一种单晶TiAl的等温锻造方法，其特征在于：以PST单晶TiAl合金为原料，采用等温锻造，得到单晶产品。",
    "2.根据权利要求1所述的一种单晶TiAl的等温锻造方法，其特征在于：锻造后仍保持单一取向层片的组织特征。",
  ].join("\n\n"),
  {
    title: "一种单晶TiAl的等温锻造方法",
    abstract:
      "本发明公开了一种单晶TiAl的等温锻造方法，属于TiAl金属间化合物单晶材料加工技术领域，通过等温锻造获得单晶产品。",
    creators: [],
  },
);
assert.doesNotMatch(patent.text, /\(54\) 发明名称/);
assert.doesNotMatch(patent.text, /^一种单晶TiAl的等温锻造方法$/m);
assert.match(patent.text, /1\.一种单晶TiAl的等温锻造方法，其特征在于/);
assert.match(patent.text, /2\.根据权利要求1所述/);

// ---------------------------------------------------------------------------
// Keyword blocks: the terms are paragraphs of their own as often as not
// ---------------------------------------------------------------------------

// Doc2X leaves a blank line between the label and every term, so each one
// becomes its own paragraph. Before the keyword block existed, only the
// `Keywords:` label was removed and the five bare noun phrases reached the
// index as body text — embedded as a chunk, scored in the `body` field, and
// duplicating tags the item already carried.
const doc2xKeywords = stripFrontMatterDuplicates(
  [
    "# A Study of Columnar Grains",
    "Jiayu Pan $^{a}$ , Feng Liu $^{b,*}$",
    "$^{a}$ Department of Mechanical Engineering, Tsinghua University, Beijing 100084, China",
    "## A R T I C L E I N F O",
    "Keywords:",
    "Composites",
    "Additive manufacturing",
    "Path planning",
    "Manufacturing constraints",
    "## A B S T R A C T",
    metadata.abstract,
    "## 1. Introduction",
    "Columnar grains matter because they set the creep life of a blade.",
  ].join("\n\n"),
  metadata,
);
assert.equal(doc2xKeywords.matchedAbstract, true);
assert.equal(
  doc2xKeywords.text,
  "## 1. Introduction\n\nColumnar grains matter because they set the creep life of a blade.",
);
assert.ok(
  doc2xKeywords.removed.keywordChars > 0,
  "the terms are accounted for as keywords, not as anonymous losses",
);

// MinerU glues label and terms into one paragraph. That form was already
// handled by KEYWORD_LINE_PATTERN alone and must stay handled.
const minerUKeywords = stripFrontMatterDuplicates(
  [
    "## ARTICLE INFO",
    "Keywords:\nComposites\nAdditive manufacturing\nPath planning",
    "## ABSTRACT",
    metadata.abstract,
    "## 1. Introduction",
    "Body text.",
  ].join("\n\n"),
  metadata,
);
assert.equal(minerUKeywords.text, "## 1. Introduction\n\nBody text.");

// KEYWORDS printed after ABSTRACT. The terms must still go: reaching them
// through the "front matter is over" terminator would have kept the whole
// block AND disabled every rule below it for the rest of the document.
const keywordsAfterAbstract = stripFrontMatterDuplicates(
  [
    "## Abstract",
    metadata.abstract,
    "Keywords:",
    "Composites",
    "Additive manufacturing",
    "## 1. Introduction",
    "Columnar grains matter because they set the creep life of a blade.",
  ].join("\n\n"),
  metadata,
);
assert.equal(keywordsAfterAbstract.matchedAbstract, true);
assert.equal(
  keywordsAfterAbstract.text,
  "## 1. Introduction\n\nColumnar grains matter because they set the creep life of a blade.",
);

// Zotero's own PDF worker is the last-resort body source and marks up no
// headings at all, so the block's primary terminator never fires. The first
// paragraph that does not read as a term has to stop it, or the block runs to
// the end of the front-matter window and takes the introduction with it.
const headinglessKeywords = stripFrontMatterDuplicates(
  [
    "A Study of Columnar Grains",
    "Keywords:",
    "Composites",
    "Additive manufacturing",
    "Columnar grains matter because they set the creep life of a blade, and " +
      "this paragraph is far too long to pass for a keyword.",
    "A second body paragraph carries the argument further still.",
  ].join("\n\n"),
  metadata,
);
assert.doesNotMatch(headinglessKeywords.text, /Composites/);
assert.doesNotMatch(headinglessKeywords.text, /Additive manufacturing/);
assert.match(headinglessKeywords.text, /creep life of a blade/);
assert.match(headinglessKeywords.text, /A second body paragraph/);

// Same, for the short unpunctuated section name a headingless extraction
// leaves behind. It passes the length and punctuation tests, so the body
// section names are what catch it.
const headinglessSection = stripFrontMatterDuplicates(
  [
    "A Study of Columnar Grains",
    "Keywords: composites, additive manufacturing",
    "Introduction",
    "Columnar grains matter because they set the creep life of a blade.",
  ].join("\n\n"),
  metadata,
);
assert.match(headinglessSection.text, /^Introduction/m);
assert.match(headinglessSection.text, /creep life of a blade/);

// Chinese journals separate keywords with a semicolon. That is a term
// separator here, not sentence punctuation, and must not close the block.
const chineseMetadata = {
  title: "连续纤维增材制造路径规划",
  abstract:
    "本文提出一种考虑制造约束的应力对齐场方法，用于连续纤维增材制造的打印路径规划，" +
    "并通过实验验证了该方法在复杂构件上的承载性能与可打印性。",
  creators: ["潘佳宇"],
};
const chineseKeywords = stripFrontMatterDuplicates(
  [
    "# 连续纤维增材制造路径规划",
    "## 摘要",
    chineseMetadata.abstract,
    "关键词：",
    "连续纤维增材制造；",
    "路径规划；",
    "纤维取向",
    "## 1 引言",
    "连续纤维复合材料在航空结构中的应用日益广泛。",
  ].join("\n\n"),
  chineseMetadata,
);
assert.doesNotMatch(chineseKeywords.text, /连续纤维增材制造；/);
assert.doesNotMatch(chineseKeywords.text, /路径规划；/);
assert.doesNotMatch(chineseKeywords.text, /纤维取向/);
assert.match(chineseKeywords.text, /## 1 引言/);
assert.match(chineseKeywords.text, /航空结构中的应用日益广泛/);

// An abstract printed with no label of its own, directly under the keywords,
// must end the block rather than be swallowed by it.
const unlabelledAbstract = stripFrontMatterDuplicates(
  [
    "Keywords:",
    "Composites",
    metadata.abstract,
    "## 1. Introduction",
    "Body text.",
  ].join("\n\n"),
  metadata,
);
assert.equal(unlabelledAbstract.matchedAbstract, true);
assert.equal(unlabelledAbstract.text, "## 1. Introduction\n\nBody text.");

// A block that finds no terminator at all is still bounded, so a pathological
// document cannot lose its whole front-matter window to one keyword label.
const runawayKeywords = stripFrontMatterDuplicates(
  [
    "Keywords:",
    ...Array.from({ length: 24 }, (_, i) => `Term number ${i}`),
  ].join("\n\n"),
  metadata,
);
assert.match(runawayKeywords.text, /Term number 23/);

console.log("Chunking and hybrid-settings regression tests passed");
