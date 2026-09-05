/* eslint-env node */

/**
 * Two things are pinned here.
 *
 * ONE: the chunk-level saturation constant stays where the measurement left it.
 * `calibrate-chunk-threshold.js` asked whether K could be re-derived so that the
 * 0.52 keyword gate lands on reliable evidence, and found that it cannot — the
 * calibration optimum does not survive held-out validation, and the highest
 * scoring non-evidence passages (headings, captions, bibliography) outscore
 * most real evidence, which no monotone rescaling can repair. This suite fails
 * if someone changes K without redoing that work, and equally if the data ever
 * starts supporting a change.
 *
 * TWO: the properties that made the answer "leave it alone" safe. Changing the
 * saturation is a monotone transform, so it can never reorder the keyword
 * branch and can only lengthen or shorten the admitted PREFIX. Those are the
 * invariants that bound what any future recalibration is allowed to do to the
 * final RRF ranking, so they are asserted directly rather than trusted.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.ztoolkit = { log: () => undefined };
globalThis.Zotero = {
  Prefs: { get: () => undefined, set: () => undefined, clear: () => undefined },
  Libraries: { userLibraryID: 1 },
};

const {
  LEXICAL_SCORE_SATURATION,
  normalizeLexicalScore,
  fuseHybridSearchResultsDetailed,
} = await import("../src/modules/hybridSearch.ts");
const { HYBRID_SETTING_RECOMMENDATIONS } = await import(
  "../src/modules/hybridSearchSettings.ts"
);
const {
  pool,
  evaluate,
  bestCut,
  gateFor,
  scoreQuery,
  JUDGMENTS,
  CALIBRATION,
  HELD_OUT,
  CUTS,
} = await import("./calibrate-chunk-threshold.js");

// ---------------------------------------------------------------------------
// 1. The constant is still the validated one.
// ---------------------------------------------------------------------------

assert.equal(
  LEXICAL_SCORE_SATURATION,
  4,
  "The chunk/lexical saturation constant changed. Re-run `npm run calibrate:chunk-threshold`: the measurement there says K is not identifiable from real labelled passages, so a change needs new evidence, not a new preference.",
);

// The gate the constant implies, stated once so the arithmetic cannot drift.
const gate = gateFor(LEXICAL_SCORE_SATURATION);
assert.ok(Math.abs(gate - 4.3333) < 1e-3, `0.52 must land on raw ${gate}`);
assert.ok(
  Math.abs(
    normalizeLexicalScore(gate) -
      HYBRID_SETTING_RECOMMENDATIONS.keywordMinScore,
  ) < 1e-9,
  "the gate and the recommendation must be two views of one number",
);

// ---------------------------------------------------------------------------
// 2. The measurement still says what the decision was based on.
// ---------------------------------------------------------------------------

const calibration = pool(CALIBRATION);
const heldOut = pool(HELD_OUT);
assert.ok(
  calibration.length >= 100 && heldOut.length >= 30,
  "the judgment set must be substantial",
);
assert.ok(
  CALIBRATION.length >= 5 && HELD_OUT.length >= 3,
  "held-out queries must exist, or 'independent validation' means nothing",
);
// Held-out queries must really be held out.
for (const name of HELD_OUT)
  assert.ok(!CALIBRATION.includes(name), `${name} leaked into calibration`);

// The ceiling is the whole finding: no cut anywhere makes this branch precise.
const ceiling = Math.max(
  ...CUTS.map((c) => evaluate(calibration, c).precision),
);
assert.ok(
  ceiling < 0.8,
  `A cut now reaches precision ${ceiling.toFixed(3)} on chunk-level keyword matching. That is better than when K was last examined — re-run the calibration, because the reason for leaving K alone may no longer hold.`,
);

// And the reason it is a ceiling: structural noise outscores real evidence.
const noise = calibration
  .filter((r) => !r.relevant)
  .sort((a, b) => b.raw - a.raw);
const evidence = calibration
  .filter((r) => r.relevant)
  .sort((a, b) => b.raw - a.raw);
assert.ok(
  noise[0].raw > evidence[1].raw,
  "the top non-evidence passage should still outscore all but the single best evidence passage — if it no longer does, the index got cleaner and this analysis is stale",
);

// The calibration optimum must still fail to transfer. This is the assertion
// that stops someone shipping the in-sample optimum.
const calibrationOptimum = bestCut(calibration, "f05");
const shippedOnHeldOut = evaluate(heldOut, gate);
const candidateOnHeldOut = evaluate(heldOut, calibrationOptimum.cut);
assert.ok(
  candidateOnHeldOut.f05 <= shippedOnHeldOut.f05 + 1e-9,
  `The calibration optimum (raw ${calibrationOptimum.cut}) now beats the shipped gate on the held-out queries (${candidateOnHeldOut.f05.toFixed(3)} vs ${shippedOnHeldOut.f05.toFixed(3)}). That is new evidence — redo the calibration deliberately instead of relaxing this test.`,
);

// ---------------------------------------------------------------------------
// 3. What a rescaling can and cannot do to the ranking.
// ---------------------------------------------------------------------------

// A saturating map is strictly monotone, so the keyword branch's ORDER is the
// same for every K. This is why re-deriving K could never have reordered the
// branch — only moved the cut along a fixed list.
for (const K of [0.5, 2, 4, 8, 40]) {
  const map = (raw) => raw / (raw + K);
  for (const query of JUDGMENTS.queries) {
    const scored = scoreQuery(query);
    for (let i = 1; i < scored.length; i += 1) {
      assert.ok(
        map(scored[i - 1].raw) >= map(scored[i].raw) - 1e-12,
        `saturation K=${K} reordered ${query.name}`,
      );
    }
  }
}

// Consequence: the admitted set is a PREFIX for every K, so lowering K can only
// append passages at the worst ranks and can never displace one already there.
{
  const query = JUDGMENTS.queries.find((q) => q.name === "fgh_gradient");
  const scored = scoreQuery(query);
  const admitted = (K) =>
    scored.filter((s) => s.raw >= gateFor(K)).map((s) => s.chunkId);
  const strict = admitted(8);
  const shipped = admitted(4);
  const loose = admitted(2);
  assert.deepEqual(
    shipped.slice(0, strict.length),
    strict,
    "a stricter gate must be a prefix",
  );
  assert.deepEqual(
    loose.slice(0, shipped.length),
    shipped,
    "a looser gate must extend the prefix",
  );
}

// And the ranking consequence that matters to a reader: a passage admitted late
// by the keyword branch cannot overtake one that beat it in BOTH branches.
{
  const keyword = Array.from({ length: 30 }, (_, i) => ({
    key: `C${i + 1}`,
    libraryID: 1,
    // Descending raw scores; C1..C10 clear even a strict gate, the tail is what
    // a looser K would newly admit.
    relevanceScore: 40 - i * 1.2,
  }));
  const semantic = [
    { itemKey: "C3", libraryID: 1, score: 0.92 },
    { itemKey: "C1", libraryID: 1, score: 0.88 },
    { itemKey: "C25", libraryID: 1, score: 0.61 },
  ];
  const fuse = (keywordMinScore) =>
    fuseHybridSearchResultsDetailed(keyword, semantic, {
      topK: 30,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
      keywordMinScore,
      semanticMinScore: 0.6,
    });

  const tight = fuse(normalizeLexicalScore(30));
  const loose = fuse(normalizeLexicalScore(5));
  assert.ok(
    loose.keywordAdmittedCount > tight.keywordAdmittedCount,
    "the looser gate must admit more of the keyword branch",
  );
  // C3 and C1 win both branches; nothing the looser gate lets in may pass them.
  for (const outcome of [tight, loose]) {
    assert.deepEqual(
      outcome.ranked.slice(0, 2).map((r) => r.itemKey),
      // C1 leads: keyword rank 1 + semantic rank 2 beats C3's keyword rank 3 +
      // semantic rank 1, because RRF adds positions rather than scores.
      ["C1", "C3"],
      "passages strong in both branches must stay on top whatever the gate admits",
    );
  }
  // C25 is weak on keyword and only middling on semantics: admitting it into the
  // keyword branch lifts it, but never above a both-branch passage.
  const c25Tight = tight.ranked.findIndex((r) => r.itemKey === "C25");
  const c25Loose = loose.ranked.findIndex((r) => r.itemKey === "C25");
  assert.ok(c25Loose <= c25Tight, "a newly admitted passage may rise");
  assert.ok(
    c25Loose >= 2,
    "but never above the passages both branches agreed on",
  );
}

console.log("Chunk-level keyword threshold tests passed");
