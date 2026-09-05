/* eslint-env node */

/**
 * The arithmetic behind cross-paper candidates: the representative selector,
 * the directional scores, the symmetric aggregate, and the lexical terms.
 *
 * All pure, so this runs with no database, no Zotero and no vector index -
 * which matters because these are exactly the parts the design says must be
 * calibrated later, and a formula nobody can run in isolation is a formula
 * nobody will recalibrate.
 *
 * The failures each block pins down:
 *
 *   1. The selector returns the opening of the paper, so a long study is
 *      characterised by its introduction and matches every other paper's.
 *   2. The 20-chunk guardrail is bypassed by batching, which is the same
 *      full-library scan run ten times under another name.
 *   3. Boilerplate - references, acknowledgements, sample preparation - is
 *      used as a query vector and recalls the entire library.
 *   4. A one-directional resemblance is stored as a symmetric edge, so a
 *      review that contains everything appears related to everything.
 *   5. Breadth weighting is claimed but does not change the aggregate.
 *   6. A chunk that resembles half the library still anchors an edge.
 *   7. Fingerprints collide, so a rescan doubles every signal - or fail to
 *      change when the algorithm does, so an upgrade is invisible.
 *   8. A pair discovered from B is not the same row as one discovered from A.
 *   9. Lexical signals use a rarity that is not document frequency.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  MAX_REPRESENTATIVE_CHUNKS,
  REPRESENTATIVE_SELECTOR_VERSION,
  isBoilerplateChunk,
  representativeTarget,
  selectRepresentativeChunks,
} = await import("../src/modules/wiki/wikiRepresentativeChunks.ts");

const {
  LINK_ALGORITHM_VERSION,
  lexicalIdf,
  normalizePair,
  orientDirection,
  scoreDirection,
  signalFingerprint,
  specificityWeight,
  symmetricScore,
} = await import("../src/modules/wiki/wikiLinkScoring.ts");

const { breadthCap, WIKI_LINK_SETTING_DEFAULTS } = await import(
  "../src/modules/wiki/wikiLinkSettings.ts"
);

const {
  LEXICAL_SCORE_CEILING,
  lexicalScore,
  sharedRareTerms,
  termChunkIndex,
} = await import("../src/modules/wiki/wikiLexicalSignals.ts");

const results = [];
function block(name, fn) {
  try {
    fn();
    results.push([true, name]);
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message}`);
  }
}

/** A vector pointing mostly along one axis, so similarity is predictable. */
function axisVector(axis, dimensions = 8, magnitude = 1) {
  const vector = new Float32Array(dimensions);
  vector[axis % dimensions] = magnitude;
  return vector;
}

function chunk(chunkId, text, axis) {
  return {
    chunkId,
    text,
    vector: axis === undefined ? null : axisVector(axis),
  };
}

// --- 1-3. The representative selector --------------------------------------

block("the target follows the documented formula", () => {
  // R = min(20, max(12, ceil(sqrt(total))));  total < 12 -> everything.
  assert.equal(representativeTarget(0), 0);
  assert.equal(representativeTarget(5), 5, "a short paper is taken whole");
  assert.equal(representativeTarget(11), 11);
  assert.equal(representativeTarget(12), 12);
  assert.equal(representativeTarget(150), 13, "ceil(sqrt(150)) = 13");
  assert.equal(representativeTarget(400), 20);
  assert.equal(
    representativeTarget(100000),
    MAX_REPRESENTATIVE_CHUNKS,
    "the 20-chunk ceiling is the cost guardrail and cannot be exceeded",
  );
});

block("selection covers the whole paper, not its opening", () => {
  // Sixty chunks in three topical thirds. A selector that clusters without
  // position layering returns thirty from whichever third is most uniform.
  const chunks = [];
  for (let index = 0; index < 60; index += 1) {
    chunks.push(chunk(index, `段落 ${index} 的内容`, Math.floor(index / 20)));
  }
  const selection = selectRepresentativeChunks(chunks);
  assert.ok(
    selection.chunkIds.length <= MAX_REPRESENTATIVE_CHUNKS,
    "never more than the coarse scan is budgeted for",
  );
  const thirds = [0, 0, 0];
  for (const chunkId of selection.chunkIds) thirds[Math.floor(chunkId / 20)] += 1;
  assert.ok(
    thirds.every((count) => count > 0),
    `every third of the paper must be represented, got ${thirds.join("/")}`,
  );
});

block("the selection is deterministic and versioned", () => {
  const chunks = Array.from({ length: 40 }, (_, index) =>
    chunk(index, `第 ${index} 段`, index % 5),
  );
  const first = selectRepresentativeChunks(chunks);
  const second = selectRepresentativeChunks(chunks);
  assert.deepEqual(first.chunkIds, second.chunkIds);
  assert.equal(first.signature, second.signature);
  assert.equal(first.selectorVersion, REPRESENTATIVE_SELECTOR_VERSION);
  assert.ok(
    first.signature.startsWith(REPRESENTATIVE_SELECTOR_VERSION),
    "the signature carries the version, so a selector change invalidates it",
  );
  // Ascending order, so the same set never produces two signatures.
  assert.deepEqual(first.chunkIds, first.chunkIds.slice().sort((a, b) => a - b));
});

block("boilerplate is not used as a query vector", () => {
  for (const text of [
    "References",
    "参考文献",
    "Acknowledgements",
    "致谢",
    "Data availability statement",
    "[1] Smith J. [2] Lee K. [3] Wang M. [4] Zhou L. [5] Chen P. [6] Ito T.",
  ]) {
    assert.ok(isBoilerplateChunk(text), `${text} should be excluded`);
  }
  assert.ok(
    !isBoilerplateChunk("动态再结晶在临界应变之后细化了晶粒组织。"),
    "ordinary body text must never be mistaken for boilerplate",
  );
  const chunks = [
    chunk(1, "参考文献", 0),
    chunk(2, "动态再结晶细化了晶粒组织", 1),
    chunk(3, "致谢", 0),
  ];
  const selection = selectRepresentativeChunks(chunks);
  assert.equal(selection.excludedBoilerplate, 2);
  assert.deepEqual(selection.chunkIds, [2]);
});

block("a Markdown heading does not hide a boilerplate section", () => {
  // The filter was anchored at the start of the chunk, and body extraction
  // produces Markdown - so `## Declaration of Competing Interest` never
  // matched and the filter had removed NOTHING on a real library. Measured
  // consequence: a competing-interest section was chosen as a representative
  // chunk, became the anchor of a semantic candidate against another paper's
  // competing-interest section, and the reader had to spend a rejection on it.
  for (const text of [
    "## Declaration of Competing Interest The authors declare none.",
    "## Acknowledgements The work is financially supported by the NSFC.",
    "### Data Availability The raw data cannot be shared at this time.",
    "## References",
    "**Acknowledgements** The work is supported by a grant.",
    "> ## Funding This work was funded by the foundation.",
    "## 参考文献 [1] 李杨, 抽拉速率对组织的影响",
    "## 致谢 感谢实验室的支持",
  ]) {
    assert.ok(
      isBoilerplateChunk(text),
      `a heading must not hide it: ${JSON.stringify(text.slice(0, 46))}`,
    );
  }
  // And a numbered body heading is still body.
  for (const text of [
    "## 4.2.2 DRX mechanisms at super-solvus temperature",
    "## Results and Discussion The grain size decreased with strain rate.",
    "## Introduction Columnar grains are common in directionally solidified alloys.",
  ]) {
    assert.ok(
      !isBoilerplateChunk(text),
      `real content must survive: ${JSON.stringify(text.slice(0, 46))}`,
    );
  }
});

block("a paper that is entirely boilerplate still yields something", () => {
  // Returning nothing would leave the paper permanently without candidates
  // and hide what is really a body-extraction failure.
  const selection = selectRepresentativeChunks([
    chunk(1, "参考文献", 0),
    chunk(2, "致谢", 1),
  ]);
  assert.equal(selection.chunkIds.length, 2);
});

// --- 4-6. Direction, symmetry and breadth ----------------------------------

block("a one-sided resemblance is not a symmetric edge", () => {
  // The long-review case: A is covered by B almost perfectly, B is barely
  // covered by A. The geometric mean has to punish that; the arithmetic mean
  // would call it 0.55 and rank it alongside a genuinely mutual pair.
  const lopsided = symmetricScore(0.95, 0.15);
  const mutual = symmetricScore(0.55, 0.55);
  assert.ok(
    lopsided < mutual,
    `lopsided ${lopsided.toFixed(3)} must rank below mutual ${mutual.toFixed(3)}`,
  );
  assert.ok(Math.abs(mutual - 0.55) < 1e-9, "a balanced pair keeps its score");
  assert.equal(symmetricScore(0.9, 0), 0, "no coverage one way is no edge");
  assert.equal(
    symmetricScore(0.4, 0.7),
    symmetricScore(0.7, 0.4),
    "strictly symmetric, whichever side computed it",
  );
});

block("breadth weighting really changes the aggregate", () => {
  // Two anchors of identical similarity. One is a passage almost every paper
  // in the library resembles; the other only two papers do. If the weights
  // were decorative these would score the same.
  const documentCount = 100;
  const cap = breadthCap(documentCount, WIKI_LINK_SETTING_DEFAULTS.breadthCapFraction);
  const specific = scoreDirection(
    [{ queryChunkId: 1, matchedChunkId: 9, score: 0.7, breadthDocs: 2 }],
    { documentCount, breadthCap: cap },
  );
  const generic = scoreDirection(
    [{ queryChunkId: 2, matchedChunkId: 9, score: 0.7, breadthDocs: 95 }],
    { documentCount, breadthCap: cap },
  );
  assert.ok(
    specific.score > generic.score,
    `a rare passage (${specific.score.toFixed(3)}) must outweigh boilerplate ` +
      `(${generic.score.toFixed(3)}) at equal similarity`,
  );
  assert.ok(
    specificityWeight(2, documentCount) > specificityWeight(95, documentCount),
  );
  assert.ok(specificityWeight(0, documentCount) <= 1);
  assert.ok(specificityWeight(documentCount, documentCount) >= 0);
});

block("a passage half the library shares cannot anchor an edge", () => {
  const documentCount = 100;
  const cap = breadthCap(documentCount, 0.3);
  assert.equal(cap, 30);
  const direction = scoreDirection(
    [
      { queryChunkId: 1, matchedChunkId: 11, score: 0.95, breadthDocs: 60 },
      { queryChunkId: 2, matchedChunkId: 12, score: 0.6, breadthDocs: 3 },
    ],
    { documentCount, breadthCap: cap },
  );
  assert.equal(direction.suppressed, 1);
  assert.equal(
    direction.best.queryChunkId,
    2,
    "the edge is explained by the rare passage, never by the boilerplate",
  );
  // It still counts toward the score - it IS part of the paper - it just may
  // not be what the edge is labelled with.
  assert.ok(direction.score > 0);
});

block("the breadth cap has a floor", () => {
  // On a four-paper library every fraction rounds to something useless.
  assert.equal(breadthCap(4, 0.3), 3);
  assert.equal(breadthCap(0, 0.3), 3);
  assert.equal(breadthCap(1000, 0.3), 300);
});

block("an empty anchor set scores zero rather than throwing", () => {
  const direction = scoreDirection([], { documentCount: 10, breadthCap: 3 });
  assert.equal(direction.score, 0);
  assert.equal(direction.best, null);
});

// --- 7-8. Identity ---------------------------------------------------------

block("a rescan of unchanged text produces the same fingerprint", () => {
  const parts = {
    signalType: "semantic",
    algorithmVersion: LINK_ALGORITHM_VERSION,
    direction: "a_to_b",
    sourceModel: "bge-m3",
    aChunkTextHash: "hash-a",
    bChunkTextHash: "hash-b",
    aExcerptHash: "ex-a",
    bExcerptHash: "ex-b",
  };
  assert.equal(signalFingerprint(parts), signalFingerprint({ ...parts }));
  // Score and time are deliberately absent: they move on every scan, and a
  // fingerprint that moved with them would never deduplicate anything.
  assert.equal(
    signalFingerprint(parts),
    signalFingerprint({ ...parts, score: 0.9 }),
  );
});

block("an algorithm or model change produces a new fingerprint", () => {
  const parts = {
    signalType: "semantic",
    algorithmVersion: LINK_ALGORITHM_VERSION,
    direction: "a_to_b",
    sourceModel: "bge-m3",
    aChunkTextHash: "hash-a",
    bChunkTextHash: "hash-b",
  };
  for (const changed of [
    { algorithmVersion: "link-sem-next" },
    { sourceModel: "other-model" },
    { direction: "b_to_a" },
    { aChunkTextHash: "hash-a-reindexed" },
  ]) {
    assert.notEqual(
      signalFingerprint(parts),
      signalFingerprint({ ...parts, ...changed }),
      `${Object.keys(changed)[0]} must not be silently reused`,
    );
  }
});

block("a pair is the same row whichever side discovered it", () => {
  const fromA = normalizePair("AAAA", "BBBB");
  const fromB = normalizePair("BBBB", "AAAA");
  assert.deepEqual(
    [fromA.aItemKey, fromA.bItemKey],
    [fromB.aItemKey, fromB.bItemKey],
  );
  assert.equal(fromA.swapped, false);
  assert.equal(fromB.swapped, true, "the caller's order has to be recorded");
  // And the direction label flips with it, or the two discoveries would
  // record contradictory directions for one measurement.
  assert.equal(orientDirection(true), "a_to_b");
  assert.equal(orientDirection(false), "b_to_a");
});

// --- 9. Lexical ------------------------------------------------------------

block("shared rare terms are found with their passages", () => {
  const a = [
    { chunkId: 11, text: "The Lomer-Cottrell lock suppresses dislocation glide." },
    { chunkId: 12, text: "Samples were ground and polished before etching." },
  ];
  const b = [
    { chunkId: 21, text: "Samples were ground and polished before etching." },
    { chunkId: 22, text: "TEM shows the Lomer-Cottrell lock throughout the matrix." },
  ];
  // The real tokeniser keeps the hyphenated form AND its joined variant, so a
  // frequency map that only knows the halves is a map that knows neither.
  const frequencies = new Map([
    ["lomer-cottrell", 2],
    ["lomercottrell", 2],
    ["lock", 3],
    ["the", 99],
    ["were", 96],
    ["and", 99],
    ["before", 94],
    ["suppresses", 12],
    ["glide", 30],
    ["tem", 55],
    ["shows", 80],
    ["throughout", 70],
    ["matrix", 60],
    ["samples", 90],
    ["ground", 88],
    ["polished", 87],
    ["etching", 85],
    ["dislocation", 40],
  ]);
  const hits = sharedRareTerms(a, b, frequencies, {
    documentCount: 100,
    maxDocumentFraction: 0.25,
    termsPerPair: 3,
    unknownFrequency: "skip",
  });
  const terms = hits.map((hit) => hit.term);
  assert.ok(
    terms.includes("lomer-cottrell"),
    `the rare term must survive, got ${terms.join(", ")}`,
  );
  assert.ok(
    !terms.includes("the") && !terms.includes("and"),
    `function words are not findings, got ${terms.join(", ")}`,
  );
  assert.ok(
    !terms.includes("samples") && !terms.includes("polished"),
    "sample-preparation boilerplate is shared by the whole field and is not a finding",
  );
  const hit = hits[0];
  assert.ok(hit.aChunkId === 11 || hit.aChunkId === 12);
  assert.ok(hit.aExcerpt.length > 0 && hit.bExcerpt.length > 0);
  assert.ok(
    hits.every((entry, index) => index === 0 || entry.idf <= hits[index - 1].idf),
    "rarest first",
  );
});

block("an unindexed term is not treated as maximally rare", () => {
  // DF 0 would give the highest possible IDF to a string the index has never
  // seen - typically an artefact - and float it above genuine rare terms.
  const a = [{ chunkId: 1, text: "xq7zzt appears here" }];
  const b = [{ chunkId: 2, text: "xq7zzt appears here too" }];
  const [hit] = sharedRareTerms(a, b, new Map(), {
    documentCount: 100,
    maxDocumentFraction: 1,
    termsPerPair: 1,
  });
  assert.equal(hit.df, 2, "these two documents are its two known sources");
});

block("a df=0 term would be maximally rare, which is why absent must not mean 0", () => {
  // Not a hypothetical. This is what shipped: `documentFrequencies` returned 0
  // for a term it had no posting for, the "skip unknown" guard reads
  // `=== undefined` and never fired, and `acknowledgements` scored the maximum.
  const documentCount = 32;
  const zero = lexicalScore(lexicalIdf(0, documentCount), documentCount);
  const genuinelyRare = lexicalScore(lexicalIdf(2, documentCount), documentCount);
  assert.ok(
    zero > genuinelyRare,
    "df=0 outscores a term two papers actually share - so a confident 0 is the " +
      "worst possible answer to 'I have never seen this term'",
  );
  assert.ok(Math.abs(zero - LEXICAL_SCORE_CEILING) < 1e-9, "and it pegs the scale");

  // With the contract fixed, a Map that OMITS the term skips it entirely.
  const a = [{ chunkId: 1, text: "The work is financially supported by the Foundation." }];
  const b = [{ chunkId: 2, text: "This work is financially supported by the Foundation." }];
  const hits = sharedRareTerms(a, b, new Map(), {
    documentCount,
    maxDocumentFraction: 1,
    termsPerPair: 5,
    unknownFrequency: "skip",
  });
  assert.deepEqual(hits, [], "no frequency for any of them, so no signal at all");
});

block("the lexical scale sits below the semantic one", () => {
  // Both types are compared directly - per-pair top-N truncation, the panel's
  // ordering, the status counters. Lexical tops out at "this term is in only
  // these two papers", which is cheap; semantic tops out at "the two papers'
  // representative passages correspond", which measured max 0.888 on the real
  // library. Letting lexical reach 1.000 pushed every semantic signal out of
  // the panel - the observed failure.
  const documentCount = 32;
  const rarest = lexicalScore(lexicalIdf(1, documentCount), documentCount);
  assert.ok(rarest <= LEXICAL_SCORE_CEILING);
  assert.ok(
    LEXICAL_SCORE_CEILING < 0.9,
    "must stay under the semantic maximum observed in practice",
  );
});

block("lexical scores share the semantic scale", () => {
  // The per-type top-3 truncation and the status counters compare the two, so
  // they cannot be on different rulers.
  const documentCount = 100;
  const rare = lexicalScore(lexicalIdf(1, documentCount), documentCount);
  const common = lexicalScore(lexicalIdf(90, documentCount), documentCount);
  assert.ok(rare <= 1 && rare >= 0);
  assert.ok(common >= 0 && common < rare);
  assert.equal(lexicalScore(0, 0), 0);
});

block("a term index records where each term was first seen", () => {
  const index = termChunkIndex([
    { chunkId: 5, text: "recrystallization begins" },
    { chunkId: 6, text: "recrystallization continues" },
  ]);
  assert.equal(
    index.get("recrystallization").chunkId,
    5,
    "first occurrence, because a term used a hundred times is no rarer",
  );
});

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
