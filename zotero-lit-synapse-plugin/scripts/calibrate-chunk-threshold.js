/* eslint-env node */
/**
 * Ask whether the chunk-level keyword score can be re-mapped so that the
 * 0.52 keyword gate lands on "reliable evidence".
 *
 * THE ANSWER IS NO, AND THAT IS THE POINT OF KEEPING THIS SCRIPT.
 *
 * The question is a reasonable one. `search_fulltext` gates its keyword branch
 * with the same 0.52 the library-level search uses, but the two numbers are
 * produced by different scorers: at library level by BM25F over a document's
 * fields, inside one paper by the single-field lexical ranker whose term
 * specificity is computed over that paper's own passages. 0.52 was measured on
 * the first scorer and merely inherited by the second, so it is fair to ask
 * what raw chunk score it corresponds to and whether the saturation constant
 * should be re-derived to put it somewhere better.
 *
 *   normalized = raw / (raw + K),  so a gate at 0.52 is a gate at raw = 1.0833·K
 *   K = 4 (LEXICAL_SCORE_SATURATION)  =>  raw >= 4.333
 *
 * Method: 8 real per-paper queries against every indexed passage of 8 real
 * documents, scored with the production chunk ranker, against passage-level
 * relevance labels. 5 queries calibrate, 3 are held out.
 *
 * What the measurement shows:
 *
 *  1. No cut separates evidence from noise. Precision never exceeds ~0.74 at
 *     any threshold, and it FALLS again as the cut rises — the signature of
 *     noise that outscores signal.
 *  2. The noise is structural, not weak: the highest-scoring non-evidence
 *     passages are section headings, figure captions, reference entries and
 *     publisher boilerplate. They are keyword-dense by construction. A heading
 *     scoring 24.6 while the best real evidence in the same paper scores 18.9
 *     cannot be fixed by any monotone rescaling, because rescaling preserves
 *     order.
 *  3. The calibration optimum (raw 4.0, K=3.69) does NOT transfer: on the
 *     held-out queries the optimum is raw 2.5, and K=3.69 scores WORSE than the
 *     shipped K=4 on every metric. Fitting K to the calibration set is fitting
 *     noise.
 *
 * Conclusion: K stays at 4. The binding constraint is which passages are in the
 * index, not where the gate sits — the same conclusion the document-level
 * calibration reached about the reference-list problem.
 *
 *   npm run calibrate:chunk-threshold
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  rankLexicalCandidates,
  CHUNK_FIELD_WEIGHTS,
  resolveHybridKeywords,
  LEXICAL_SCORE_SATURATION,
} = await import("../src/modules/hybridSearch.ts");
const { HYBRID_SETTING_RECOMMENDATIONS } = await import(
  "../src/modules/hybridSearchSettings.ts"
);

globalThis.ztoolkit = { log: () => undefined };

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const JUDGMENTS = JSON.parse(
  fs.readFileSync(
    path.join(rootDir, "scripts/fixtures/chunk-threshold-judgments.json"),
    "utf8",
  ),
);

/** The gate in raw-score terms, for a given saturation constant. */
export function gateFor(
  saturation,
  threshold = HYBRID_SETTING_RECOMMENDATIONS.keywordMinScore,
) {
  return (saturation * threshold) / (1 - threshold);
}

/**
 * Score one query's passages exactly the way `runDocumentDeepDive` does:
 * one candidate per chunk, one field, the chunk field-weight table.
 */
export function scoreQuery(query) {
  const { entries } = resolveHybridKeywords(query.query, query.keywords);
  const ranked = rankLexicalCandidates(
    query.chunks.map((c) => ({
      key: String(c.chunkId),
      libraryID: 1,
      title: "",
      fields: { chunkText: c.text },
    })),
    entries,
    { fieldWeights: CHUNK_FIELD_WEIGHTS },
  );
  return ranked.map((r, index) => ({
    rank: index + 1,
    chunkId: Number(r.key),
    raw: r.relevanceScore,
  }));
}

/** Labelled rows for a set of query names. */
export function pool(names) {
  const rows = [];
  for (const query of JUDGMENTS.queries) {
    if (!names.includes(query.name)) continue;
    const positive = new Set(JUDGMENTS.positives[query.name] ?? []);
    const negative = new Set(JUDGMENTS.negatives[query.name] ?? []);
    for (const scored of scoreQuery(query)) {
      if (positive.has(scored.chunkId))
        rows.push({ ...scored, query: query.name, relevant: true });
      else if (negative.has(scored.chunkId))
        rows.push({ ...scored, query: query.name, relevant: false });
    }
  }
  return rows;
}

export function evaluate(rows, cut) {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const row of rows) {
    if (row.raw >= cut)
      row.relevant ? (truePositives += 1) : (falsePositives += 1);
    else if (row.relevant) falseNegatives += 1;
  }
  const precision =
    truePositives + falsePositives === 0
      ? 1
      : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0
      ? 1
      : truePositives / (truePositives + falseNegatives);
  const fBeta = (beta) =>
    precision + recall === 0
      ? 0
      : ((1 + beta * beta) * precision * recall) /
        (beta * beta * precision + recall);
  return {
    cut,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1: fBeta(1),
    f05: fBeta(0.5),
  };
}

export const CALIBRATION = JUDGMENTS.queries
  .filter((q) => !q.hold)
  .map((q) => q.name);
export const HELD_OUT = JUDGMENTS.queries
  .filter((q) => q.hold)
  .map((q) => q.name);
export const CUTS = Array.from({ length: 121 }, (_, i) =>
  Number((2 + i * 0.1).toFixed(1)),
);

/** Best cut by a metric, ties broken towards the stricter value. */
export function bestCut(rows, metric) {
  return CUTS.map((cut) => evaluate(rows, cut)).reduce((best, row) =>
    row[metric] > best[metric] + 1e-9 ||
    (Math.abs(row[metric] - best[metric]) <= 1e-9 && row.cut > best.cut)
      ? row
      : best,
  );
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const shippedGate = gateFor(LEXICAL_SCORE_SATURATION);
  console.log(
    `shipped: K=${LEXICAL_SCORE_SATURATION}, keyword gate ${HYBRID_SETTING_RECOMMENDATIONS.keywordMinScore} ` +
      `=> raw >= ${shippedGate.toFixed(3)}`,
  );

  const calibration = pool(CALIBRATION);
  console.log(
    `\ncalibration: ${CALIBRATION.length} queries, ${calibration.length} labelled passages ` +
      `(${calibration.filter((r) => r.relevant).length} evidence)`,
  );
  console.log(
    `  cut   kept  noise  lost   prec  recall     F1   F0.5    K that puts 0.52 here`,
  );
  for (const cut of CUTS) {
    if (Math.round(cut * 10) % 5 !== 0 || cut > 14) continue;
    const e = evaluate(calibration, cut);
    console.log(
      `${cut.toFixed(1).padStart(5)}${String(e.truePositives).padStart(7)}${String(e.falsePositives).padStart(7)}` +
        `${String(e.falseNegatives).padStart(6)}${e.precision.toFixed(3).padStart(7)}${e.recall.toFixed(3).padStart(8)}` +
        `${e.f1.toFixed(3).padStart(7)}${e.f05.toFixed(3).padStart(7)}` +
        `${((cut * (1 - 0.52)) / 0.52).toFixed(2).padStart(12)}`,
    );
  }

  // The noise is not weak matches. It is headings, captions and bibliography,
  // which sit at the very top of the ranking.
  const classOf = new Map();
  for (const [cls, byQuery] of Object.entries(JUDGMENTS.classes))
    for (const [q, ids] of Object.entries(byQuery))
      for (const id of ids) classOf.set(`${q}:${id}`, cls);
  console.log("\nhighest-scoring NON-evidence passages (why no cut works):");
  for (const row of calibration
    .filter((r) => !r.relevant)
    .sort((a, b) => b.raw - a.raw)
    .slice(0, 6)) {
    console.log(
      `  raw=${row.raw.toFixed(2).padStart(6)}  ${(classOf.get(`${row.query}:${row.chunkId}`) ?? "?").padEnd(12)} ${row.query}:${row.chunkId}`,
    );
  }
  const bestEvidence = calibration
    .filter((r) => r.relevant)
    .sort((a, b) => b.raw - a.raw);
  console.log(
    `  (best real evidence in the pool scores raw=${bestEvidence[0].raw.toFixed(2)}; the second best ${bestEvidence[1].raw.toFixed(2)})`,
  );

  console.log(
    "\n=== does the calibration optimum survive independent validation? ===",
  );
  for (const [label, names] of [
    ["calibration", CALIBRATION],
    ["HELD-OUT", HELD_OUT],
  ]) {
    const rows = pool(names);
    const best = bestCut(rows, "f05");
    const shipped = evaluate(rows, shippedGate);
    const candidate = evaluate(rows, 4.0);
    console.log(
      `${label.padEnd(12)} n=${String(rows.length).padStart(3)}  ` +
        `F0.5-optimal cut ${best.cut.toFixed(1).padStart(4)} (P ${best.precision.toFixed(3)})  |  ` +
        `shipped K=4 -> P ${shipped.precision.toFixed(3)} R ${shipped.recall.toFixed(3)} F0.5 ${shipped.f05.toFixed(3)}  |  ` +
        `candidate K=3.69 -> P ${candidate.precision.toFixed(3)} R ${candidate.recall.toFixed(3)} F0.5 ${candidate.f05.toFixed(3)}`,
    );
    console.log(
      `${" ".repeat(12)} precision ceiling over every cut: ${Math.max(...CUTS.map((c) => evaluate(rows, c).precision)).toFixed(3)}`,
    );
  }
  console.log(
    "\nThe two optima disagree and the candidate loses on the held-out set, so K is\n" +
      "not identifiable from this data. It stays at 4.",
  );
}
