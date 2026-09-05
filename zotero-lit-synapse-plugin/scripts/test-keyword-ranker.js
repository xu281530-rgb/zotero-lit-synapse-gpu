/* eslint-env node */
/**
 * The combined keyword ranker: metadata fields from the live item, body from the
 * inverted index, one BM25F pass.
 *
 *   node --experimental-strip-types scripts/test-keyword-ranker.js
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { rankKeywordCandidates, METADATA_FIELD_MAP } = await import(
  "../src/modules/keyword/keywordRanker.ts"
);
const { normalizeBm25fScore, BM25F_SCORE_SATURATION } = await import(
  "../src/modules/keyword/bm25f.ts"
);

globalThis.ztoolkit = { log: () => undefined };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const probe = (text, weight = 1) => ({ text, weight });

function candidate(key, fields, libraryID = 1) {
  return { key, libraryID, title: fields.title ?? "", fields };
}

/** A pool big enough that idf means something, as the real library is. */
function filler(count, prefix = "F") {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    out.push(
      candidate(`${prefix}${index}`, {
        title: `Unrelated study number ${index}`,
        abstractNote: "This record has nothing to do with the query at all.",
      }),
    );
  }
  return out;
}

const LIBRARY_SIZE = 931;

/** Library-level field averages, as the statistics provider supplies them. */
const LIBRARY_AVERAGES = {
  title: 14.2,
  abstract: 199.2,
  tags: 8.4,
  publicationTitle: 3.0,
  creator: 8.7,
  extra: 18.1,
  body: 7700,
};

// -------------------------------------------------------------------------

test("a metadata-only match still scores, exactly as before the body existed", () => {
  const ranked = rankKeywordCandidates({
    probes: [probe("FGH4096")],
    candidates: [
      candidate("A", { title: "Hot deformation of FGH4096 superalloy" }),
      ...filler(50),
    ],
    libraryDocumentCount: LIBRARY_SIZE,
    averageFieldLengths: LIBRARY_AVERAGES,
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].key, "A");
  assert.deepEqual(ranked[0].matchedFields, ["title"]);
  assert.ok(ranked[0].relevanceScore > 0);
});

test("a document with ONLY a body hit enters the ranking", () => {
  // The whole point: this document's metadata says nothing about the term, so
  // the metadata scan never produced it as a candidate.
  const ranked = rankKeywordCandidates({
    probes: [probe("FGH4096")],
    candidates: filler(50),
    bodyContributions: new Map([
      [
        "BODY1",
        {
          itemKey: "BODY1",
          frequencies: new Map([["FGH4096", 6]]),
          bodyLength: 7000,
          evidence: [
            { chunkId: 12, matchedKeywords: ["FGH4096"], occurrences: 3 },
          ],
        },
      ],
    ]),
    libraryDocumentCount: LIBRARY_SIZE,
    bodyDocumentCount: 26,
    averageFieldLengths: LIBRARY_AVERAGES,
    averageBodyLength: 7700,
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].key, "BODY1");
  assert.deepEqual(ranked[0].matchedFields, ["body"]);
  assert.equal(ranked[0].bodyEvidence[0].chunkId, 12);
});

test("at EQUAL occurrence counts, a title hit outranks a body hit", () => {
  // This is what "title weighs most" means, and it is the invariant worth
  // pinning: same evidence, better field, higher score.
  const ranked = rankKeywordCandidates({
    probes: [probe("FGH4096")],
    candidates: [
      candidate("TITLED", { title: "Hot deformation of FGH4096 superalloy" }),
      ...filler(50),
    ],
    bodyContributions: new Map([
      [
        "BODYONLY",
        {
          itemKey: "BODYONLY",
          frequencies: new Map([["FGH4096", 1]]),
          bodyLength: 7700,
          evidence: [],
        },
      ],
    ]),
    libraryDocumentCount: LIBRARY_SIZE,
    bodyDocumentCount: 26,
    averageFieldLengths: LIBRARY_AVERAGES,
    averageBodyLength: 7700,
  });
  assert.equal(ranked[0].key, "TITLED");
  assert.ok(ranked[1].relevanceScore > 0, "the body hit still counts");
});

test("how far body evidence can carry depends on how much has been READ", () => {
  /*
   * This replaces an earlier expectation that sustained body evidence always
   * outranks a single title mention. That was true only because body IDF was
   * being computed against the library count while the body index covered 26 of
   * 931 documents — an inflation of about 4x. With N and df drawn from the same
   * observed corpus, the honest picture is:
   *
   *   partial coverage (26 of 931 bodies read)
   *     a title mention wins, because idf over a 26-document corpus tops out at
   *     2.89 while idf over the library reaches 6.43 — we simply know much less
   *     about the body corpus, and the score says so.
   *
   *   complete coverage (all 931 bodies read)
   *     the same eight body occurrences win, because now the body corpus IS the
   *     library and the two IDFs are on the same scale.
   *
   * So the ranking's trust in body evidence grows as the user indexes more, with
   * no parameter to retune. That is the property worth pinning, and it is not a
   * preference — it falls out of requiring N and df to describe one corpus.
   */
  const ranked = (bodyDocumentCount) =>
    rankKeywordCandidates({
      probes: [probe("FGH4096")],
      candidates: [
        candidate("TITLED", { title: "Hot deformation of FGH4096 superalloy" }),
        ...filler(50),
      ],
      bodyContributions: new Map([
        [
          "DISCUSSED",
          {
            itemKey: "DISCUSSED",
            frequencies: new Map([["FGH4096", 8]]),
            bodyLength: 7000,
            evidence: [],
          },
        ],
      ]),
      libraryDocumentCount: LIBRARY_SIZE,
      bodyDocumentCount,
      averageFieldLengths: LIBRARY_AVERAGES,
      averageBodyLength: 7700,
    });

  const partial = ranked(26);
  assert.equal(
    partial[0].key,
    "TITLED",
    "with 26 of 931 bodies read, a title mention must win",
  );
  assert.ok(
    partial.find((item) => item.key === "DISCUSSED").relevanceScore > 0,
    "the body evidence still counts, it just counts less",
  );

  const complete = ranked(LIBRARY_SIZE);
  assert.equal(
    complete[0].key,
    "DISCUSSED",
    "with every body read, sustained body evidence must win",
  );
});

test("a title hit PLUS a body hit beats the title hit alone", () => {
  // Corroboration must lift a document, which is the rule the fusion downstream
  // already follows for the semantic branch.
  const withoutBody = rankKeywordCandidates({
    probes: [probe("FGH4096")],
    candidates: [
      candidate("A", { title: "FGH4096 superalloy study" }),
      ...filler(50),
    ],
    libraryDocumentCount: LIBRARY_SIZE,
    averageFieldLengths: LIBRARY_AVERAGES,
  });
  const withBody = rankKeywordCandidates({
    probes: [probe("FGH4096")],
    candidates: [
      candidate("A", { title: "FGH4096 superalloy study" }),
      ...filler(50),
    ],
    bodyContributions: new Map([
      [
        "A",
        {
          itemKey: "A",
          frequencies: new Map([["FGH4096", 5]]),
          bodyLength: 7000,
          evidence: [],
        },
      ],
    ]),
    libraryDocumentCount: LIBRARY_SIZE,
    bodyDocumentCount: 26,
    averageFieldLengths: LIBRARY_AVERAGES,
    averageBodyLength: 7700,
  });
  assert.ok(
    withBody[0].relevanceScore > withoutBody[0].relevanceScore,
    "adding body evidence must never lower a score",
  );
  assert.deepEqual(withBody[0].matchedFields, ["title", "body"]);
});

test("body evidence merges onto the SAME row, never a second row", () => {
  const ranked = rankKeywordCandidates({
    probes: [probe("FGH4096")],
    candidates: [candidate("A", { title: "FGH4096 study" }), ...filler(20)],
    bodyContributions: new Map([
      [
        "A",
        {
          itemKey: "A",
          frequencies: new Map([["FGH4096", 3]]),
          bodyLength: 5000,
          evidence: [
            { chunkId: 4, matchedKeywords: ["FGH4096"], occurrences: 3 },
          ],
        },
      ],
    ]),
    libraryDocumentCount: LIBRARY_SIZE,
    bodyDocumentCount: 26,
    averageFieldLengths: LIBRARY_AVERAGES,
    averageBodyLength: 7700,
  });
  assert.equal(ranked.filter((item) => item.key === "A").length, 1);
  assert.equal(ranked[0].libraryID, 1, "the metadata row's identity survives");
  assert.equal(ranked[0].bodyEvidence.length, 1);
});

test("a long body dilutes a body hit; the title contribution is untouched", () => {
  const score = (bodyLength) =>
    rankKeywordCandidates({
      probes: [probe("FGH4096")],
      candidates: [candidate("A", { title: "FGH4096 study" }), ...filler(20)],
      bodyContributions: new Map([
        [
          "A",
          {
            itemKey: "A",
            frequencies: new Map([["FGH4096", 4]]),
            bodyLength,
            evidence: [],
          },
        ],
      ]),
      libraryDocumentCount: LIBRARY_SIZE,
      bodyDocumentCount: 26,
      averageFieldLengths: LIBRARY_AVERAGES,
      averageBodyLength: 7700,
    })[0].relevanceScore;
  assert.ok(score(2000) > score(30000), "independent per-field normalisation");
});

test("more distinct keywords matched outranks one keyword repeated", () => {
  const ranked = rankKeywordCandidates({
    probes: [
      probe("superalloy"),
      probe("columnar grain"),
      probe("hot deformation"),
    ],
    candidates: [
      candidate("BROAD", {
        title: "Hot deformation of a superalloy with columnar grains",
        abstractNote: "Columnar grain superalloy deformed hot.",
      }),
      candidate("NARROW", {
        title: "Superalloy superalloy superalloy superalloy superalloy",
        abstractNote: "Superalloy superalloy superalloy superalloy.",
      }),
      ...filler(60),
    ],
    libraryDocumentCount: LIBRARY_SIZE,
    averageFieldLengths: LIBRARY_AVERAGES,
  });
  assert.equal(ranked[0].key, "BROAD");
  assert.equal(ranked[0].keywordCoverage, 1);
  assert.ok(ranked.find((item) => item.key === "NARROW").keywordCoverage < 1);
});

test("a Chinese term is matched in metadata by the same rule as in the body", () => {
  const ranked = rankKeywordCandidates({
    probes: [probe("柱状晶")],
    candidates: [
      candidate("REAL", { title: "定向凝固柱状晶组织演化" }),
      candidate("DECOY", { title: "柱状组织与环状晶粒的对比" }),
      ...filler(40),
    ],
    libraryDocumentCount: LIBRARY_SIZE,
    averageFieldLengths: LIBRARY_AVERAGES,
  });
  assert.deepEqual(
    ranked.map((item) => item.key),
    ["REAL"],
    "the decoy satisfies both bigrams but not the term",
  );
});

test("an en-dashed grade in a title is found by the hyphenated query", () => {
  const ranked = rankKeywordCandidates({
    probes: [probe("Ti-6Al-4V")],
    candidates: [
      candidate("A", { title: "Fatigue of Ti–6Al–4V produced by SLM" }),
      ...filler(30),
    ],
    libraryDocumentCount: LIBRARY_SIZE,
    averageFieldLengths: LIBRARY_AVERAGES,
  });
  assert.deepEqual(
    ranked.map((item) => item.key),
    ["A"],
  );
});

test("searching for a word inside a hyphenated term does not match it", () => {
  const ranked = rankKeywordCandidates({
    probes: [probe("ray")],
    candidates: [
      candidate("A", { title: "X-ray diffraction of alloys" }),
      ...filler(30),
    ],
    libraryDocumentCount: LIBRARY_SIZE,
    averageFieldLengths: LIBRARY_AVERAGES,
  });
  assert.deepEqual(ranked, []);
});

test("every metadata field the previous ranker scored is still scored", () => {
  // Regression guard: dropping publicationTitle / creator / extra would silently
  // lose every document that only matches there.
  for (const [sourceField] of Object.entries(METADATA_FIELD_MAP)) {
    const fields = { title: "Something else entirely" };
    fields[sourceField] =
      sourceField === "tags"
        ? "columnar solidification"
        : "columnar solidification";
    const ranked = rankKeywordCandidates({
      probes: [probe("columnar solidification")],
      candidates: [candidate("A", fields), ...filler(30)],
      libraryDocumentCount: LIBRARY_SIZE,
      averageFieldLengths: LIBRARY_AVERAGES,
    });
    assert.equal(ranked.length, 1, `${sourceField} produced no match`);
    assert.ok(
      ranked[0].matchedFields.includes(METADATA_FIELD_MAP[sourceField]),
      `${sourceField} not attributed correctly`,
    );
  }
});

test("a rare term outranks a common one, using the LIBRARY's document count", () => {
  const common = filler(400, "C").map((item) => ({
    ...item,
    fields: { ...item.fields, abstractNote: "a superalloy was studied" },
  }));
  const ranked = rankKeywordCandidates({
    probes: [probe("superalloy"), probe("FGH4096")],
    candidates: [
      candidate("RARE", { abstractNote: "the FGH4096 superalloy was studied" }),
      ...common,
    ],
    libraryDocumentCount: LIBRARY_SIZE,
    averageFieldLengths: LIBRARY_AVERAGES,
  });
  assert.equal(ranked[0].key, "RARE");
  assert.ok(
    ranked[0].relevanceScore > ranked[1].relevanceScore * 2,
    "the discriminative term has to dominate the broad one",
  );
});

test("the normalized score is bounded and monotone in the raw score", () => {
  assert.equal(normalizeBm25fScore(0), 0);
  assert.equal(normalizeBm25fScore(-5), 0);
  assert.equal(normalizeBm25fScore(undefined), 0);
  assert.equal(normalizeBm25fScore(NaN), 0);
  assert.ok(normalizeBm25fScore(1) < normalizeBm25fScore(2));
  assert.ok(normalizeBm25fScore(1e9) < 1, "never reaches 1");
  // The documented calibration point: this is why K is 4 rather than 5.
  assert.ok(
    normalizeBm25fScore(8.06) > 0.6,
    "the weakest previously-passing document must still clear the floor",
  );
  assert.ok(
    8.06 / (8.06 + 5) < 0.62,
    "K=5 would leave it within a hair of the floor",
  );
  assert.equal(BM25F_SCORE_SATURATION, 4);
});

test("no probes, no candidates and no body all answer empty", () => {
  assert.deepEqual(
    rankKeywordCandidates({
      probes: [],
      candidates: [candidate("A", { title: "anything" })],
      libraryDocumentCount: LIBRARY_SIZE,
    }),
    [],
  );
  assert.deepEqual(
    rankKeywordCandidates({
      probes: [probe("FGH4096")],
      candidates: [],
      libraryDocumentCount: LIBRARY_SIZE,
    }),
    [],
  );
});

test("an unindexable probe does not make everything match", () => {
  const ranked = rankKeywordCandidates({
    probes: [probe("a")],
    candidates: [
      candidate("A", { title: "a study of a thing" }),
      ...filler(20),
    ],
    libraryDocumentCount: LIBRARY_SIZE,
    averageFieldLengths: LIBRARY_AVERAGES,
  });
  assert.deepEqual(ranked, []);
});

test("a zero-weight probe is ignored without affecting the others", () => {
  const ranked = rankKeywordCandidates({
    probes: [probe("superalloy", 0), probe("FGH4096", 1)],
    candidates: [
      candidate("A", { title: "FGH4096 superalloy" }),
      candidate("B", { title: "Another superalloy" }),
      ...filler(30),
    ],
    libraryDocumentCount: LIBRARY_SIZE,
    averageFieldLengths: LIBRARY_AVERAGES,
  });
  assert.deepEqual(
    ranked.map((item) => item.key),
    ["A"],
  );
  assert.deepEqual(ranked[0].matchedKeywords, ["FGH4096"]);
});

test("the limit caps output without changing the order", () => {
  const all = rankKeywordCandidates({
    probes: [probe("superalloy")],
    candidates: [
      candidate("A", {
        title: "superalloy one",
        abstractNote: "superalloy superalloy",
      }),
      candidate("B", { title: "superalloy two" }),
      candidate("C", { abstractNote: "a superalloy" }),
      ...filler(30),
    ],
    libraryDocumentCount: LIBRARY_SIZE,
    averageFieldLengths: LIBRARY_AVERAGES,
  });
  const capped = rankKeywordCandidates({
    probes: [probe("superalloy")],
    candidates: [
      candidate("A", {
        title: "superalloy one",
        abstractNote: "superalloy superalloy",
      }),
      candidate("B", { title: "superalloy two" }),
      candidate("C", { abstractNote: "a superalloy" }),
      ...filler(30),
    ],
    libraryDocumentCount: LIBRARY_SIZE,
    averageFieldLengths: LIBRARY_AVERAGES,
    limit: 2,
  });
  assert.equal(capped.length, 2);
  assert.deepEqual(
    capped.map((item) => item.key),
    all.slice(0, 2).map((item) => item.key),
  );
});

test("ordering is stable for identical scores", () => {
  const build = () =>
    rankKeywordCandidates({
      probes: [probe("superalloy")],
      candidates: [
        candidate("ZZZ", { title: "A superalloy" }),
        candidate("AAA", { title: "A superalloy" }),
        ...filler(20),
      ],
      libraryDocumentCount: LIBRARY_SIZE,
      averageFieldLengths: LIBRARY_AVERAGES,
    });
  assert.deepEqual(
    build().map((item) => item.key),
    build().map((item) => item.key),
  );
  assert.equal(
    build()[0].key,
    "AAA",
    "ties break on the key, deterministically",
  );
});

// -------------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(
      `       ${String(error.message).split("\n").join("\n       ")}`,
    );
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
