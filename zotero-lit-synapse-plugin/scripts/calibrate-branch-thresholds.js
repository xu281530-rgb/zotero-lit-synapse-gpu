/* eslint-env node */
/**
 * Measure the keyword-branch relevance threshold instead of guessing it.
 *
 * After the RRF change the two branches are gated INDEPENDENTLY: a document
 * enters the fusion as soon as it clears its own branch's threshold, and the
 * other branch can no longer veto it. That makes the keyword threshold a
 * question about ONE branch in isolation — "at what normalised BM25F score does
 * a keyword hit stop being evidence and start being a coincidence?" — which is
 * exactly what a labelled query set can answer.
 *
 * Method:
 *   - corpus  scripts/fixtures/keyword-scoring-candidates.json (931 real
 *             documents from the user's own library, metadata only)
 *   - labels  scripts/fixtures/keyword-threshold-judgments.json
 *   - scorer  the production ranker (rankKeywordCandidates + normalizeBm25fScore),
 *             not a reimplementation
 *
 * Precision and recall are pooled over every labelled document of every query,
 * and the recommended threshold is the one that maximises F0.5 — precision
 * weighted double, because the union gives recall a backstop (the semantic
 * branch) and gives precision none. Ties break towards the STRICTER value.
 * The F1 optimum is printed alongside it for contrast, never used.
 *
 *   npm run calibrate:branch-thresholds
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { rankKeywordCandidates } = await import(
  "../src/modules/keyword/keywordRanker.ts"
);
const { normalizeBm25fScore } = await import("../src/modules/keyword/bm25f.ts");
const { LibraryFieldStats } = await import(
  "../src/modules/keyword/libraryFieldStats.ts"
);
const { HYBRID_SETTING_DEFAULTS } = await import(
  "../src/modules/hybridSearchSettings.ts"
);

globalThis.ztoolkit = { log: () => undefined };

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const candidates = JSON.parse(
  fs.readFileSync(
    path.join(rootDir, "scripts/fixtures/keyword-scoring-candidates.json"),
    "utf8",
  ),
);
const judgments = JSON.parse(
  fs.readFileSync(
    path.join(rootDir, "scripts/fixtures/keyword-threshold-judgments.json"),
    "utf8",
  ),
);

// Library-level average field lengths from the SAME provider production uses,
// computed over the whole library rather than over the matching subset.
const averageFieldLengths = (
  await new LibraryFieldStats({
    async signature() {
      return `fixture:${candidates.length}`;
    },
    async readFields() {
      return candidates.map((candidate) => candidate.fields ?? {});
    },
  }).get(1)
).averageLengths;

/** Score one labelled query with the production keyword ranker. */
function scoreQuery(query) {
  const ranked = rankKeywordCandidates({
    probes: query.keywords.map((text) => ({ text, weight: 1 })),
    candidates,
    bodyContributions: new Map(),
    libraryDocumentCount: candidates.length,
    bodyDocumentCount: 0,
    averageFieldLengths,
  });
  const scoreByKey = new Map(
    ranked.map((item) => [item.key, normalizeBm25fScore(item.relevanceScore)]),
  );
  const labelled = [];
  for (const key of query.relevant) {
    labelled.push({ key, relevant: true, score: scoreByKey.get(key) ?? null });
  }
  for (const key of query.irrelevant) {
    labelled.push({ key, relevant: false, score: scoreByKey.get(key) ?? null });
  }
  return { ranked, labelled };
}

const scored = judgments.queries.map((query) => ({
  query,
  ...scoreQuery(query),
}));

// A label that names a document the keyword branch never retrieved is a stale
// label, not a measurement. Fail loudly rather than quietly scoring 0.
const unretrieved = scored.flatMap(({ query, labelled }) =>
  labelled
    .filter((entry) => entry.score === null)
    .map((entry) => `${query.name}/${entry.key}`),
);
if (unretrieved.length > 0) {
  console.error(
    `These labelled documents were not retrieved by the keyword branch at all, ` +
      `so the judgment file is out of date: ${unretrieved.join(", ")}`,
  );
  process.exitCode = 1;
}

const THRESHOLDS = [];
for (let value = 0.3; value <= 0.75 + 1e-9; value += 0.01) {
  THRESHOLDS.push(Number(value.toFixed(2)));
}

function evaluate(threshold) {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const { labelled } of scored) {
    for (const entry of labelled) {
      const admitted = (entry.score ?? 0) >= threshold;
      if (admitted && entry.relevant) truePositives += 1;
      else if (admitted) falsePositives += 1;
      else if (entry.relevant) falseNegatives += 1;
    }
  }
  const precision =
    truePositives + falsePositives === 0
      ? 1
      : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0
      ? 1
      : truePositives / (truePositives + falseNegatives);
  const fBeta = (beta) => {
    const b2 = beta * beta;
    return precision + recall === 0
      ? 0
      : ((1 + b2) * precision * recall) / (b2 * precision + recall);
  };
  return {
    threshold,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1: fBeta(1),
    f05: fBeta(0.5),
  };
}

const rows = THRESHOLDS.map(evaluate);

/*
 * The objective is F0.5, not F1 — precision counts double.
 *
 * That is a consequence of the union: after the RRF change the semantic branch
 * admits documents on its own, so a paper the keyword threshold rejects is not
 * lost from the search, only from ONE branch's rank list. Nothing, however,
 * compensates for noise: a coincidental keyword match that clears the threshold
 * enters the fused ranking, counts towards totalRelevant and fills a page.
 * Recall has a backstop here and precision does not, so they are not worth the
 * same and F1 would misprice them.
 *
 * Ties break towards the stricter value: when two thresholds separate the
 * labelled set equally well, the one admitting less noise is the honest one.
 */
function pickBest(metric) {
  let best = rows[0];
  for (const row of rows) {
    if (row[metric] > best[metric] + 1e-9) best = row;
    else if (
      Math.abs(row[metric] - best[metric]) <= 1e-9 &&
      row.threshold > best.threshold
    ) {
      best = row;
    }
  }
  return best;
}

/**
 * The measurement itself, exported so `scripts/test-branch-thresholds.js` can
 * assert that the SHIPPED default is still the value this produces. Without
 * that link the recommendation would be a number someone typed once and the
 * calibration a script nobody runs.
 */
export function measureKeywordThreshold() {
  return { rows, best: pickBest("f05"), bestF1: pickBest("f1"), scored };
}

// Everything below is the report. Skipped on import so the test pays for the
// measurement only.
const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  console.log(
    `corpus: ${candidates.length} real documents (metadata only) · ` +
      `${judgments.queries.length} labelled queries · ` +
      `${scored.reduce((sum, entry) => sum + entry.labelled.length, 0)} judgments`,
  );

  console.log("\n=== pooled precision / recall / F by keyword threshold ===");
  console.log(
    `${"thr".padStart(5)}${"kept".padStart(7)}${"noise".padStart(7)}${"lost".padStart(6)}` +
      `${"prec".padStart(8)}${"recall".padStart(8)}${"F1".padStart(8)}${"F0.5".padStart(8)}`,
  );
  for (const row of rows) {
    // Print every 0.02 to keep the table readable; the search itself uses 0.01.
    if (Math.round(row.threshold * 100) % 2 !== 0) continue;
    console.log(
      `${row.threshold.toFixed(2).padStart(5)}` +
        `${String(row.truePositives).padStart(7)}` +
        `${String(row.falsePositives).padStart(7)}` +
        `${String(row.falseNegatives).padStart(6)}` +
        `${row.precision.toFixed(3).padStart(8)}` +
        `${row.recall.toFixed(3).padStart(8)}` +
        `${row.f1.toFixed(3).padStart(8)}` +
        `${row.f05.toFixed(3).padStart(8)}`,
    );
  }

  const { best, bestF1 } = measureKeywordThreshold();
  console.log(
    `
  F1-optimal (recall-heavy, shown for contrast): ${bestF1.threshold.toFixed(2)} ` +
      `(precision ${bestF1.precision.toFixed(3)}, recall ${bestF1.recall.toFixed(3)})`,
  );

  console.log(
    `\nbest F1 = ${best.f1.toFixed(3)} at threshold ${best.threshold.toFixed(2)} ` +
      `(precision ${best.precision.toFixed(3)}, recall ${best.recall.toFixed(3)})`,
  );

  console.log("\n=== per query at the recommended threshold ===");
  console.log(
    `${"query".padEnd(18)}${"kept".padStart(6)}${"noise".padStart(7)}${"lost".padStart(6)}   best-scoring dropped document`,
  );
  for (const { query, labelled } of scored) {
    const kept = labelled.filter((e) => (e.score ?? 0) >= best.threshold);
    const noise = kept.filter((e) => !e.relevant);
    const lost = labelled
      .filter((e) => e.relevant && (e.score ?? 0) < best.threshold)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    console.log(
      `${query.name.padEnd(18)}` +
        `${String(kept.length - noise.length).padStart(6)}` +
        `${String(noise.length).padStart(7)}` +
        `${String(lost.length).padStart(6)}   ` +
        (lost.length ? `${lost[0].key} @ ${(lost[0].score ?? 0).toFixed(4)}` : "—"),
    );
  }

  console.log(
    `\nshipped default: ${HYBRID_SETTING_DEFAULTS.keywordMinScore} · ` +
      `measured optimum: ${best.threshold.toFixed(2)}`,
  );

}
