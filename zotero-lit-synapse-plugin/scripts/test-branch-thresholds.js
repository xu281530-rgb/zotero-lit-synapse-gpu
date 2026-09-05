/* eslint-env node */

/**
 * The contract of the two-branch threshold + RRF retrieval, in one place.
 *
 * Three things are pinned here that no other suite can pin:
 *
 *  1. The SHIPPED keyword threshold is still the MEASURED optimum. Without
 *     this the recommendation degrades into a number someone typed once and
 *     `calibrate-branch-thresholds.js` into a script nobody runs.
 *  2. hybrid_search and search_fulltext really do read the same four settings —
 *     asserted against the source, because "we changed both" is exactly the
 *     kind of claim that quietly stops being true.
 *  3. The retired unified floor is GONE, not merely unused: no second filter
 *     sits on top of the RRF ranking anywhere.
 *
 * The fusion's own behaviour (which branch admits what, how the union ranks,
 * what the weights move) lives in test-hybrid-search.js and test-deep-dive.js.
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
const read = (relative) =>
  fs.readFileSync(path.join(rootDir, relative), "utf8");

globalThis.ztoolkit = { log: () => undefined };
globalThis.Zotero = {
  Prefs: { get: () => undefined, set: () => undefined, clear: () => undefined },
  Libraries: { userLibraryID: 1 },
};

const { HYBRID_SETTING_DEFAULTS, HYBRID_SETTING_RECOMMENDATIONS } =
  await import("../src/modules/hybridSearchSettings.ts");
const { fuseHybridSearchResultsDetailed } = await import(
  "../src/modules/hybridSearch.ts"
);

// ---------------------------------------------------------------------------
// 1. The recommended keyword threshold is measured, and still is.
// ---------------------------------------------------------------------------

const { best, bestF1, scored } = (
  await import("./calibrate-branch-thresholds.js")
).measureKeywordThreshold();

assert.equal(
  HYBRID_SETTING_RECOMMENDATIONS.keywordMinScore,
  best.threshold,
  `The keyword threshold advertised as "推荐值" (${HYBRID_SETTING_RECOMMENDATIONS.keywordMinScore}) is no longer what the calibration measures (${best.threshold}). Re-run "npm run calibrate:branch-thresholds", read the table, and change the recommendation deliberately — do not silently relax this assertion.`,
);
assert.equal(
  HYBRID_SETTING_DEFAULTS.keywordMinScore,
  HYBRID_SETTING_RECOMMENDATIONS.keywordMinScore,
  "the shipped default and the advertised recommendation must be one number",
);

// The measurement has to be worth something: a threshold that admits mostly
// noise would make the whole exercise theatre.
assert.ok(
  best.precision >= 0.9,
  `the measured optimum must be a high-precision point (got ${best.precision.toFixed(3)})`,
);
// And it must be stricter than the recall-maximising point, which is the
// entire reason F0.5 rather than F1 was chosen.
assert.ok(
  best.threshold > bestF1.threshold,
  "the precision-weighted optimum must be stricter than the F1 optimum",
);

// The judgment set has to actually exercise both verdicts, or precision and
// recall are measured against a set that cannot disagree with anything.
const labels = scored.flatMap((entry) => entry.labelled);
assert.ok(labels.length >= 100, "the judgment set must be substantial");
assert.ok(
  labels.some((entry) => entry.relevant) &&
    labels.some((entry) => !entry.relevant),
  "the judgment set must contain both relevant and irrelevant documents",
);
// Every label must name a document the branch really retrieved; a stale key
// would be silently scored 0 and quietly bias the optimum upward.
assert.ok(
  labels.every((entry) => typeof entry.score === "number"),
  "every labelled document must have been retrieved by the keyword branch",
);

// ---------------------------------------------------------------------------
// 2. The semantic recommendation is the behaviour it replaced, not a new guess.
// ---------------------------------------------------------------------------

// The retired `hybrid.minScore` default was 0.6, and for a document only the
// semantic branch found, that fused score WAS its cosine similarity — so 0.6
// has been the de-facto semantic-only floor all along. Keeping it is the option
// that changes the fewest results, which is why it is the recommendation.
assert.equal(HYBRID_SETTING_RECOMMENDATIONS.semanticMinScore, 0.6);
assert.match(
  read("addon/prefs.js"),
  /pref\("hybrid\.minScore", "0\.6"\);/,
  "the legacy default must stay declared so the migration can still read it",
);

// No evidence supports biasing either branch, so neither is biased.
assert.equal(HYBRID_SETTING_RECOMMENDATIONS.keywordRrfWeight, 1);
assert.equal(HYBRID_SETTING_RECOMMENDATIONS.semanticRrfWeight, 1);

// ---------------------------------------------------------------------------
// 3. The pane advertises exactly the numbers the plugin ships.
// ---------------------------------------------------------------------------

const ftlEN = read("addon/locale/en-US/preferences.ftl");
const ftlZH = read("addon/locale/zh-CN/preferences.ftl");

for (const [key, id] of [
  ["keywordMinScore", "pref-hybrid-keyword-min-score"],
  ["semanticMinScore", "pref-hybrid-semantic-min-score"],
  ["keywordRrfWeight", "pref-hybrid-keyword-rrf-weight"],
  ["semanticRrfWeight", "pref-hybrid-semantic-rrf-weight"],
]) {
  for (const suffix of ["label", "hint", "recommended"]) {
    for (const [name, ftl] of [
      ["en-US", ftlEN],
      ["zh-CN", ftlZH],
    ]) {
      assert.ok(
        ftl.includes(`${id}-${suffix} =`),
        `${name} is missing ${id}-${suffix}`,
      );
    }
  }

  // The advertised number must be the shipped number. A hint that recommends
  // 0.52 while the plugin starts at something else is worse than no hint.
  const value = HYBRID_SETTING_RECOMMENDATIONS[key];
  const printed = key.endsWith("MinScore")
    ? value.toFixed(2)
    : value.toFixed(1);
  const enLine = ftlEN
    .split("\n")
    .find((line) => line.startsWith(`${id}-recommended =`));
  const zhLine = ftlZH
    .split("\n")
    .find((line) => line.startsWith(`${id}-recommended =`));
  assert.ok(
    enLine.includes(printed),
    `${id}-recommended (en-US) must quote ${printed}, got: ${enLine}`,
  );
  assert.ok(
    zhLine.includes(printed),
    `${id}-recommended (zh-CN) must quote ${printed}, got: ${zhLine}`,
  );
  // The Chinese pane is the one the user reads; the required wording is
  // literally "推荐值：X".
  assert.ok(
    zhLine.includes(`推荐值：${printed}`),
    `${id}-recommended (zh-CN) must read "推荐值：${printed}"`,
  );
}

// Every input is an editable number box bound to its own persisted pref.
const pane = read("addon/content/preferences.xhtml");
const prefsJs = read("addon/prefs.js");
const bindings = read("src/modules/preferenceScript.ts");
for (const [prefName, elementId] of [
  ["keywordMinScore", "hybrid-keyword-min-score"],
  ["semanticMinScore", "hybrid-semantic-min-score"],
  ["keywordRrfWeight", "hybrid-keyword-rrf-weight"],
  ["semanticRrfWeight", "hybrid-semantic-rrf-weight"],
]) {
  assert.ok(
    pane.includes(`id="zotero-prefpane-__addonRef__-${elementId}"`),
    `the pane must carry an input for ${prefName}`,
  );
  assert.ok(
    pane.includes(
      `preference="extensions.zotero.__addonRef__.hybrid.${prefName}"`,
    ),
    `${prefName}'s input must be bound to its preference`,
  );
  assert.match(
    pane,
    new RegExp(
      `id="zotero-prefpane-__addonRef__-${elementId}"[\\s\\S]{0,200}?type="number"|type="number"[\\s\\S]{0,200}?id="zotero-prefpane-__addonRef__-${elementId}"`,
    ),
    `${prefName} must be an editable number input`,
  );
  assert.ok(
    prefsJs.includes(`pref("hybrid.${prefName}"`),
    `${prefName} must have a declared default so it persists`,
  );
  assert.ok(
    bindings.includes(`P + "${prefName}"`),
    `${prefName} must be bound by preferenceScript so edits are written back`,
  );
}

// ---------------------------------------------------------------------------
// 4. Both tools read the same four settings.
// ---------------------------------------------------------------------------

const server = read("src/modules/streamableMCPServer.ts");
const deepDive = read("src/modules/documentDeepDive.ts");

const hybridHandler = server.slice(
  server.indexOf("private async callHybridSearch"),
  server.indexOf("private async continueHybridSearch"),
);
for (const source of [hybridHandler, deepDive]) {
  assert.match(source, /settings\.keywordMinScore/);
  assert.match(source, /settings\.semanticMinScore/);
  assert.match(source, /settings\.keywordRrfWeight/);
  assert.match(source, /settings\.semanticRrfWeight/);
  // The "caller may only be stricter" rule is enforced by the same helper in
  // both, so an AI cannot loosen a floor through either entry point.
  assert.match(source, /resolveScoreFloor\(/);
}

// ---------------------------------------------------------------------------
// 5. The retired unified threshold is gone, not merely unused.
// ---------------------------------------------------------------------------

const fusionSource = read("src/modules/hybridSearch.ts");
assert.doesNotMatch(
  fusionSource,
  /computeFusedScore/,
  "the max+0.15*min fusion must be deleted, not left importable",
);
assert.doesNotMatch(
  fusionSource,
  /HYBRID_AGREEMENT_BONUS/,
  "the agreement bonus must be gone with it",
);
// `minScore` may still appear as the substring of the two branch options, but
// never as a standalone unified floor.
assert.doesNotMatch(
  fusionSource,
  /(?<![a-zA-Z])minScore(?![A-Za-z])/,
  "hybridSearch.ts must not carry a unified minScore any more",
);
// And no settings object exposes one for a caller to reach for.
assert.doesNotMatch(
  read("src/modules/hybridSearchSettings.ts"),
  /^\s*minScore: number;/m,
  "HybridSearchSettings must not expose a unified minScore",
);

// The behavioural version of the same claim: RRF scores are tiny, and if any
// legacy 0.6-style filter survived anywhere in fusion, every result would
// vanish. Both branches admit everything here, so all four must come back.
const noSecondFilter = fuseHybridSearchResultsDetailed(
  [
    { key: "A", libraryID: 1, relevanceScore: 40 },
    { key: "B", libraryID: 1, relevanceScore: 30 },
  ],
  [
    { itemKey: "B", libraryID: 1, score: 0.99 },
    { itemKey: "C", libraryID: 1, score: 0.98 },
    { itemKey: "D", libraryID: 1, score: 0.97 },
  ],
  {
    topK: 10,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
    keywordMinScore: 0.6,
    semanticMinScore: 0.6,
  },
);
assert.equal(
  noSecondFilter.ranked.length,
  4,
  "nothing may be filtered a second time by the RRF score",
);
assert.ok(
  noSecondFilter.ranked.every((row) => row.score < 0.6),
  "every RRF score is below the old unified floor — which is why it must not be applied",
);
assert.equal(noSecondFilter.discardedBelowThreshold, 0);

console.log("Branch threshold and RRF recommendation tests passed");
