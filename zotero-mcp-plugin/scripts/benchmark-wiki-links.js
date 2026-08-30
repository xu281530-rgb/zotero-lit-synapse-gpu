/* eslint-env node */

/**
 * What cross-paper candidates actually cost, and what they actually score.
 *
 * The design document is explicit that none of the thresholds may be trusted
 * until they have been measured on real libraries at 50 and 500 papers, and
 * equally explicit that no time estimate may be written down before someone
 * runs one. This is the harness for doing that. It does NOT decide anything:
 * it reports the distributions, and a person reads them and sets the prefs.
 *
 * The metrics are the ones §12.3 asks for:
 *
 *   - representative-chunk selection time per paper
 *   - full-library coarse recall time
 *   - pairwise bidirectional refinement time
 *   - candidates per paper
 *   - score_ab / score_ba / score_symmetric distributions
 *   - breadth distribution of the high-frequency boilerplate
 *   - consistency: does scanning from A and from B produce the same pair
 *
 * What it cannot measure is the one that matters most - how many candidates a
 * human judges useful. That needs the candidates in front of a person, which
 * is what `wiki_scan_links` followed by `wiki_prepare_update` is for.
 *
 * Run:  npm run benchmark:wiki-links
 * Env:  WL_DOCUMENTS  papers in the synthetic library (default 50)
 *       WL_CHUNKS     chunks per paper (default 150)
 *       WL_DIMENSIONS vector dimensions (default 768)
 *       WL_TOPICS     latent topics; papers sharing one should pair (default 8)
 *       WL_BOILER     fraction of chunks that are field-wide boilerplate (0.15)
 *       WL_SEED       RNG seed, so a run is reproducible
 */

import { performance } from "node:perf_hooks";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const { selectRepresentativeChunks } = await import(
  "../src/modules/wiki/wikiRepresentativeChunks.ts"
);
const { scoreDirection, symmetricScore } = await import(
  "../src/modules/wiki/wikiLinkScoring.ts"
);
const { breadthCap, WIKI_LINK_SETTING_DEFAULTS } = await import(
  "../src/modules/wiki/wikiLinkSettings.ts"
);

const DOCUMENTS = Number(process.env.WL_DOCUMENTS ?? 50);
const CHUNKS = Number(process.env.WL_CHUNKS ?? 150);
const DIMENSIONS = Number(process.env.WL_DIMENSIONS ?? 768);
const TOPICS = Number(process.env.WL_TOPICS ?? 8);
const BOILER = Number(process.env.WL_BOILER ?? 0.15);
let seed = Number(process.env.WL_SEED ?? 20260830);

/** Deterministic RNG: a benchmark whose numbers move between runs is noise. */
function random() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function unit(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

function randomVector() {
  const vector = new Float32Array(DIMENSIONS);
  for (let index = 0; index < DIMENSIONS; index += 1) {
    vector[index] = random() * 2 - 1;
  }
  return unit(vector);
}

/** A vector near `centre`, by mixing in noise. Lower spread = tighter topic. */
function near(centre, spread) {
  const vector = new Float32Array(DIMENSIONS);
  for (let index = 0; index < DIMENSIONS; index += 1) {
    vector[index] = centre[index] + (random() * 2 - 1) * spread;
  }
  return unit(vector);
}

function cosine(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

// ---- A synthetic library with a known answer -------------------------------
//
// Topics are what SHOULD produce candidates. Boilerplate is what should not:
// one shared centre every paper draws from, which is the "samples were ground
// and polished" of this fixture. If the scoring works, papers sharing a topic
// outrank papers sharing only boilerplate - and that gap is the thing the
// thresholds have to sit inside.

const topicCentres = Array.from({ length: TOPICS }, () => randomVector());
const boilerplateCentre = randomVector();

const documents = [];
for (let index = 0; index < DOCUMENTS; index += 1) {
  const primary = index % TOPICS;
  const secondary = (index * 7 + 3) % TOPICS;
  const chunks = [];
  for (let chunkIndex = 0; chunkIndex < CHUNKS; chunkIndex += 1) {
    const isBoilerplate = random() < BOILER;
    const centre = isBoilerplate
      ? boilerplateCentre
      : topicCentres[chunkIndex % 3 === 0 ? secondary : primary];
    chunks.push({
      chunkId: chunkIndex,
      text: isBoilerplate
        ? `试样经砂纸打磨后抛光并腐蚀，段落 ${chunkIndex}`
        : `文献 ${index} 主题 ${primary} 的第 ${chunkIndex} 段正文内容`,
      vector: near(centre, isBoilerplate ? 0.35 : 0.55),
      topic: isBoilerplate ? -1 : primary,
    });
  }
  documents.push({ itemKey: `ITEM${String(index).padStart(4, "0")}`, primary, chunks });
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const position = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  );
  return sorted[position];
}

function describe(label, values) {
  if (!values.length) {
    console.log(`  ${label.padEnd(28)} (none)`);
    return;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  console.log(
    `  ${label.padEnd(28)} n=${String(values.length).padStart(5)}  ` +
      `p10=${percentile(values, 0.1).toFixed(4)}  ` +
      `p50=${percentile(values, 0.5).toFixed(4)}  ` +
      `p90=${percentile(values, 0.9).toFixed(4)}  ` +
      `max=${percentile(values, 1).toFixed(4)}  mean=${mean.toFixed(4)}`,
  );
}

// ---- 1. Selector -----------------------------------------------------------

console.log(
  `\nLibrary: ${DOCUMENTS} papers x ${CHUNKS} chunks x ${DIMENSIONS} dims ` +
    `(${TOPICS} topics, ${(BOILER * 100).toFixed(0)}% boilerplate)`,
);

const selectorTimes = [];
const selections = new Map();
for (const document of documents) {
  const started = performance.now();
  const selection = selectRepresentativeChunks(document.chunks);
  selectorTimes.push(performance.now() - started);
  selections.set(document.itemKey, selection);
}
console.log("\nRepresentative selection");
describe("ms per paper", selectorTimes);
describe(
  "representatives per paper",
  Array.from(selections.values(), (selection) => selection.chunkIds.length),
);
describe(
  "boilerplate excluded",
  Array.from(selections.values(), (selection) => selection.excludedBoilerplate),
);

// ---- 2. Coarse recall ------------------------------------------------------
//
// One paper's representatives against every chunk in the library. This is the
// cost that the 20-chunk guardrail exists to bound, and the reason batching
// around it is forbidden: ten batches is ten of these.

const settings = WIKI_LINK_SETTING_DEFAULTS;
const cap = breadthCap(DOCUMENTS, settings.breadthCapFraction);

function coarseScan(query, selection) {
  const representatives = selection.chunkIds.map((chunkId) =>
    query.chunks.find((chunk) => chunk.chunkId === chunkId),
  );
  const perDocument = new Map();
  for (const candidate of documents) {
    if (candidate.itemKey === query.itemKey) continue;
    const perQuery = representatives.map((representative) => {
      const scored = candidate.chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        score: cosine(representative.vector, chunk.vector),
      }));
      scored.sort((left, right) => right.score - left.score);
      return scored.slice(0, 2);
    });
    perDocument.set(candidate.itemKey, perQuery);
  }
  return { representatives, perDocument };
}

const coarseTimes = [];
const pairwiseTimes = [];
const scoreAB = [];
const scoreBA = [];
const scoreSym = [];
const breadthOfBoilerplate = [];
const breadthOfTopic = [];
const candidatesPerPaper = [];
const sameTopicScores = [];
const crossTopicScores = [];

// A subset, because this is O(N^2 * chunks) in JavaScript and the shape of the
// distribution is what is being measured, not its last digit.
const SAMPLE = Math.min(documents.length, Number(process.env.WL_SAMPLE ?? 12));

for (let index = 0; index < SAMPLE; index += 1) {
  const query = documents[index];
  const selection = selections.get(query.itemKey);
  const startedCoarse = performance.now();
  const { representatives, perDocument } = coarseScan(query, selection);
  coarseTimes.push(performance.now() - startedCoarse);

  // breadth_i: how many DIFFERENT documents this representative reached.
  const breadth = representatives.map((representative, position) => {
    let reached = 0;
    for (const perQuery of perDocument.values()) {
      if (
        (perQuery[position] ?? []).some(
          (hit) => hit.score >= settings.breadthChunkScore,
        )
      ) {
        reached += 1;
      }
    }
    if (representative.topic === -1) breadthOfBoilerplate.push(reached);
    else breadthOfTopic.push(reached);
    return reached;
  });

  let kept = 0;
  const startedPairwise = performance.now();
  for (const candidate of documents) {
    if (candidate.itemKey === query.itemKey) continue;
    const perQuery = perDocument.get(candidate.itemKey);
    const forward = scoreDirection(
      representatives.map((representative, position) => ({
        queryChunkId: representative.chunkId,
        matchedChunkId: perQuery[position]?.[0]?.chunkId ?? null,
        score:
          (perQuery[position] ?? []).reduce((sum, hit) => sum + hit.score, 0) /
          Math.max(1, (perQuery[position] ?? []).length),
        breadthDocs: breadth[position],
      })),
      { documentCount: DOCUMENTS, breadthCap: cap },
    );
    // The reverse direction, computed locally: the candidate's own
    // representatives against the query's chunks, weights unmeasured.
    const candidateSelection = selections.get(candidate.itemKey);
    const reverse = scoreDirection(
      candidateSelection.chunkIds.map((chunkId) => {
        const representative = candidate.chunks.find(
          (chunk) => chunk.chunkId === chunkId,
        );
        const scored = query.chunks.map((chunk) =>
          cosine(representative.vector, chunk.vector),
        );
        scored.sort((left, right) => right - left);
        return {
          queryChunkId: chunkId,
          matchedChunkId: null,
          score: (scored[0] + scored[1]) / 2,
          breadthDocs: 0,
        };
      }),
      { documentCount: DOCUMENTS, breadthCap: cap },
    );
    const symmetric = symmetricScore(forward.score, reverse.score);
    scoreAB.push(forward.score);
    scoreBA.push(reverse.score);
    scoreSym.push(symmetric);
    if (query.primary === candidate.primary) sameTopicScores.push(symmetric);
    else crossTopicScores.push(symmetric);
    if (symmetric >= settings.minSymmetricScore) kept += 1;
  }
  pairwiseTimes.push(performance.now() - startedPairwise);
  candidatesPerPaper.push(Math.min(kept, settings.topK));
}

console.log("\nScanning cost");
describe("coarse recall ms", coarseTimes);
describe("pairwise refinement ms", pairwiseTimes);

console.log("\nScore distributions");
describe("score_ab", scoreAB);
describe("score_ba", scoreBA);
describe("score_symmetric", scoreSym);
describe("same-topic symmetric", sameTopicScores);
describe("cross-topic symmetric", crossTopicScores);
describe("candidates kept per paper", candidatesPerPaper);

console.log("\nBreadth (the boilerplate guard)");
describe("boilerplate representatives", breadthOfBoilerplate);
describe("topical representatives", breadthOfTopic);
console.log(`  breadth cap at N=${DOCUMENTS}: ${cap}`);

// ---- 3. The threshold question --------------------------------------------
//
// The whole point. A threshold is defensible when it separates the pairs that
// share a topic from the pairs that share only the field's boilerplate. If
// these two distributions overlap, no single number will do it and the
// candidates will be noise whatever value is chosen.

const separation =
  percentile(sameTopicScores, 0.1) - percentile(crossTopicScores, 0.9);
console.log("\nThreshold guidance");
console.log(
  `  same-topic p10   ${percentile(sameTopicScores, 0.1).toFixed(4)}\n` +
    `  cross-topic p90  ${percentile(crossTopicScores, 0.9).toFixed(4)}\n` +
    `  separation       ${separation.toFixed(4)}`,
);
console.log(
  separation > 0
    ? `  A threshold anywhere in (${percentile(crossTopicScores, 0.9).toFixed(4)}, ` +
        `${percentile(sameTopicScores, 0.1).toFixed(4)}) separates them on this fixture. ` +
        `Current wiki.link.minSymmetricScore = ${settings.minSymmetricScore}.`
    : "  The two distributions OVERLAP: no single symmetric threshold separates " +
        "topical pairs from boilerplate pairs here. Raise the breadth weighting, " +
        "or accept that candidates need a second signal before they are shown.",
);
console.log(
  "\nThese numbers describe a synthetic library. Run against a real one before " +
    "changing any pref, and remember the metric this cannot produce: how many " +
    "of these candidates a person judges worth acting on.\n",
);
