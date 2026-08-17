/* eslint-env node */
/**
 * The statistical contract of the keyword branch: what N, df and avgdl are
 * allowed to be.
 *
 * Two defects motivated this suite, both measured on the real library first.
 *
 * 1. IDF pooled a body document frequency with a library-sized N. The body
 *    index covers 26 of 931 documents, so a term found in 8 bodies and no
 *    metadata was scored as df=8 against N=931 — which asserts that the 905
 *    documents whose bodies were never read do NOT contain it. Measured
 *    inflation: 3.76x to 4.39x on real body-only terms.
 *
 * 2. Metadata avgdl was the mean over the CANDIDATE POOL, so the same document
 *    and the same query term were normalised against a different reference
 *    depending on which unrelated documents happened to match.
 *
 *   node --experimental-strip-types --experimental-sqlite scripts/test-keyword-statistics.js
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { rankKeywordCandidates, rankKeywordCandidatesDetailed } = await import(
  "../src/modules/keyword/keywordRanker.ts"
);
const { BM25_FIELDS, FIELD_REGIME, inverseDocumentFrequency, scoreDocument } =
  await import("../src/modules/keyword/bm25f.ts");
const { LibraryFieldStats } = await import(
  "../src/modules/keyword/libraryFieldStats.ts"
);

globalThis.ztoolkit = { log: () => undefined };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const probe = (text, weight = 1) => ({ text, weight });

function candidate(key, fields, libraryID = 1) {
  return { key, libraryID, title: fields.title ?? "", fields };
}

/** Unrelated documents, so the candidate pool can be varied independently. */
function filler(count, prefix, abstractWords = 30) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    out.push(
      candidate(`${prefix}${index}`, {
        title: `Unrelated study number ${index}`,
        abstractNote: Array.from(
          { length: abstractWords },
          (_, word) => `filler${word}`,
        ).join(" "),
      }),
    );
  }
  return out;
}

/** Library-level averages, as the stable statistics provider would supply. */
const LIBRARY_AVERAGES = {
  title: 14.2,
  abstract: 199.2,
  tags: 8.4,
  publicationTitle: 3.0,
  creator: 8.7,
  extra: 18.1,
  body: 0,
};

const N_LIB = 931;
const N_BODY = 26;

function bodyContribution(itemKey, term, count, bodyLength = 7000) {
  return [
    itemKey,
    {
      itemKey,
      frequencies: new Map([[term, count]]),
      bodyLength,
      evidence: [],
    },
  ];
}

// ================================================================ regime split

test("every field belongs to exactly one observation regime", () => {
  // The regime is what pairs a field with the collection its df was counted in.
  // A field with no regime would silently borrow another collection's N.
  for (const field of BM25_FIELDS) {
    assert.ok(
      FIELD_REGIME[field] === "metadata" || FIELD_REGIME[field] === "body",
      `${field} has no regime`,
    );
  }
  assert.equal(FIELD_REGIME.body, "body");
  assert.equal(FIELD_REGIME.title, "metadata");
});

test("a body-only term's IDF is counted over the BODY corpus, not the library", () => {
  // The defect: df_body=8 against N=931 gives 4.697, asserting that 905 unread
  // bodies do not contain the term. Over the corpus actually observed — the 26
  // indexed documents — the same evidence gives 1.156.
  const scored = scoreDocument({
    contributions: [
      {
        term: "dislocation-free",
        documentFrequency: 0,
        bodyDocumentFrequency: 8,
        frequencies: { body: 6 },
      },
    ],
    lengths: { ...LIBRARY_AVERAGES, body: 7000 },
    statistics: {
      documentCount: N_LIB,
      bodyDocumentCount: N_BODY,
      fields: Object.fromEntries(
        BM25_FIELDS.map((field) => [
          field,
          { averageLength: field === "body" ? 7700 : LIBRARY_AVERAGES[field] },
        ]),
      ),
    },
  });

  const idfBody = inverseDocumentFrequency(N_BODY, 8);
  const idfInflated = inverseDocumentFrequency(N_LIB, 8);
  assert.ok(idfInflated / idfBody > 3.5, "the inflation this guards is real");

  // The score must be explained entirely by the body-corpus IDF.
  const saturated = scored.score / idfBody;
  assert.ok(
    saturated > 0 && saturated < 1,
    `score should be idf_body times a saturation in (0,1), got ${scored.score}`,
  );
  assert.ok(
    scored.score < idfInflated * 0.999,
    "must be strictly below what the library-sized N would have produced",
  );
});

test("an unindexed body is unknown, not evidence of absence", () => {
  // Same term, same body evidence, but the body index grows from 26 to 931
  // documents with the term still found in 8. Only then may IDF approach the
  // library-scale value — because only then has the whole library been read.
  const score = (bodyDocumentCount) =>
    scoreDocument({
      contributions: [
        {
          term: "t",
          documentFrequency: 0,
          bodyDocumentFrequency: 8,
          frequencies: { body: 6 },
        },
      ],
      lengths: { ...LIBRARY_AVERAGES, body: 7000 },
      statistics: {
        documentCount: N_LIB,
        bodyDocumentCount,
        fields: Object.fromEntries(
          BM25_FIELDS.map((field) => [
            field,
            {
              averageLength: field === "body" ? 7700 : LIBRARY_AVERAGES[field],
            },
          ]),
        ),
      },
    }).score;

  const partial = score(26);
  const complete = score(931);
  assert.ok(
    complete > partial * 3,
    `full coverage should raise IDF, got ${partial} -> ${complete}`,
  );
});

test("metadata and body evidence keep their own IDF in one score", () => {
  // A term present in both regimes contributes twice, each part weighted by the
  // collection its own df was measured in. Neither borrows the other's N.
  const statistics = {
    documentCount: N_LIB,
    bodyDocumentCount: N_BODY,
    fields: Object.fromEntries(
      BM25_FIELDS.map((field) => [
        field,
        { averageLength: field === "body" ? 7700 : LIBRARY_AVERAGES[field] },
      ]),
    ),
  };
  const lengths = { ...LIBRARY_AVERAGES, body: 7000 };

  const metaOnly = scoreDocument({
    contributions: [
      {
        term: "t",
        documentFrequency: 3,
        bodyDocumentFrequency: 0,
        frequencies: { title: 1 },
      },
    ],
    lengths,
    statistics,
  }).score;
  const bodyOnly = scoreDocument({
    contributions: [
      {
        term: "t",
        documentFrequency: 0,
        bodyDocumentFrequency: 6,
        frequencies: { body: 4 },
      },
    ],
    lengths,
    statistics,
  }).score;
  const both = scoreDocument({
    contributions: [
      {
        term: "t",
        documentFrequency: 3,
        bodyDocumentFrequency: 6,
        frequencies: { title: 1, body: 4 },
      },
    ],
    lengths,
    statistics,
  }).score;

  assert.ok(both > metaOnly, "body evidence may only add");
  assert.ok(both > bodyOnly, "metadata evidence may only add");
  // And each part is separable: the whole is the sum of the two regimes.
  assert.ok(
    Math.abs(both - (metaOnly + bodyOnly)) < 1e-9,
    `regimes must be additive: ${both} vs ${metaOnly + bodyOnly}`,
  );
});

test("no body index at all means body evidence cannot be scored", () => {
  // N_body = 0 is an empty corpus. Scoring body evidence against it would be
  // dividing by a collection that does not exist.
  const scored = scoreDocument({
    contributions: [
      {
        term: "t",
        documentFrequency: 0,
        bodyDocumentFrequency: 0,
        frequencies: { body: 5 },
      },
    ],
    lengths: { ...LIBRARY_AVERAGES, body: 7000 },
    statistics: {
      documentCount: N_LIB,
      bodyDocumentCount: 0,
      fields: Object.fromEntries(
        BM25_FIELDS.map((field) => [field, { averageLength: 0 }]),
      ),
    },
  });
  assert.equal(scored.score, 0);
});

// ============================================================ df bookkeeping

test("df_meta counts metadata hits only; df_body counts body hits only", () => {
  // Pooling them was the defect: a body-only document used to raise the
  // metadata df, and a metadata-only document used to raise the body df.
  const ranked = rankKeywordCandidatesDetailed({
    probes: [probe("FGH4096")],
    candidates: [
      candidate("META1", { title: "FGH4096 study one" }),
      candidate("META2", { title: "FGH4096 study two" }),
      ...filler(50, "F"),
    ],
    bodyContributions: new Map([
      bodyContribution("BODY1", "FGH4096", 5),
      bodyContribution("BODY2", "FGH4096", 5),
      bodyContribution("BODY3", "FGH4096", 5),
    ]),
    libraryDocumentCount: N_LIB,
    bodyDocumentCount: N_BODY,
    averageFieldLengths: LIBRARY_AVERAGES,
    averageBodyLength: 7700,
  });
  const stats = ranked.statistics;
  assert.equal(stats.documentFrequency.get("FGH4096"), 2, "two metadata hits");
  assert.equal(
    stats.bodyDocumentFrequency.get("FGH4096"),
    3,
    "three body hits",
  );
  assert.equal(stats.documentCount, N_LIB);
  assert.equal(stats.bodyDocumentCount, N_BODY);
});

test("a collection scope makes N the scope, so N and df share one corpus", () => {
  // df is measured inside the scope, so N must be the scope too. Using the
  // library count there would repeat the original mistake at a smaller scale.
  const scope = new Set(["META1", "F0", "F1", "F2"]);
  const ranked = rankKeywordCandidatesDetailed({
    probes: [probe("FGH4096")],
    candidates: [
      candidate("META1", { title: "FGH4096 study" }),
      ...filler(3, "F"),
    ],
    libraryDocumentCount: N_LIB,
    bodyDocumentCount: N_BODY,
    scopeDocumentCount: scope.size,
    scopeBodyDocumentCount: 2,
    averageFieldLengths: LIBRARY_AVERAGES,
    averageBodyLength: 7700,
  });
  assert.equal(ranked.statistics.documentCount, 4);
  assert.equal(ranked.statistics.bodyDocumentCount, 2);
});

// ================================================================ avgdl stability

test("an unrelated candidate set cannot move a document's own score", () => {
  // The defect: avgdl was the pool mean, so adding documents that have nothing
  // to do with the query changed the length normalisation of the one that did.
  const target = candidate("TARGET", {
    title: "Hot deformation of FGH4096 superalloy",
    abstractNote: "The FGH4096 alloy was compressed at high temperature.",
  });
  const score = (pool) =>
    rankKeywordCandidates({
      probes: [probe("FGH4096")],
      candidates: [target, ...pool],
      libraryDocumentCount: N_LIB,
      bodyDocumentCount: N_BODY,
      averageFieldLengths: LIBRARY_AVERAGES,
      averageBodyLength: 7700,
    }).find((item) => item.key === "TARGET").relevanceScore;

  // Same target, wildly different unrelated company: short abstracts, long
  // abstracts, and none at all.
  const withNone = score([]);
  const withShort = score(filler(40, "S", 5));
  const withLong = score(filler(40, "L", 400));
  assert.equal(
    withShort,
    withNone,
    "short unrelated documents must not matter",
  );
  assert.equal(withLong, withNone, "long unrelated documents must not matter");
});

test("a co-matching document's LENGTH cannot move this document's score", () => {
  /*
   * The sharp version of the avgdl test, with document frequency held constant.
   *
   * Adding another MATCHING document legitimately changes df, and therefore IDF —
   * that is a real property of the collection, not a defect. So this compares two
   * runs that both have exactly two matching documents, differing only in how long
   * the OTHER one is. Before the fix those two runs gave 5.3521 and 4.2930 for the
   * same target; the length of an unrelated document is not allowed to matter.
   */
  const target = candidate("TARGET", {
    title: "Hot deformation of FGH4096 superalloy",
    abstractNote: "The FGH4096 alloy was compressed at high temperature.",
  });
  const verbose = Array.from({ length: 60 }, () => "verbose").join(" ");
  const padding = Array.from({ length: 900 }, () => "padding").join(" ");
  const longCoMatch = candidate("OTHER", {
    title: `${verbose} FGH4096`,
    abstractNote: `${padding} FGH4096`,
  });
  const shortCoMatch = candidate("OTHER", { title: "FGH4096" });

  const score = (other) =>
    rankKeywordCandidates({
      probes: [probe("FGH4096")],
      candidates: [target, other],
      libraryDocumentCount: N_LIB,
      bodyDocumentCount: N_BODY,
      averageFieldLengths: LIBRARY_AVERAGES,
      averageBodyLength: 7700,
    }).find((item) => item.key === "TARGET").relevanceScore;

  assert.equal(
    score(longCoMatch).toFixed(9),
    score(shortCoMatch).toFixed(9),
    "the co-matching document's length leaked into the target's normalisation",
  );
});

test("length normalisation is actually applied, not cancelled out", () => {
  /*
   * The other half of the old defect: with one matching document the pool mean WAS
   * that document's own length, so len/avgdl was always exactly 1 and a 1-word
   * title scored the same as an 81-word one (both 4.5942 before the fix). Against
   * a library reference the short field must win.
   */
  const scoreOf = (title) =>
    rankKeywordCandidates({
      probes: [probe("FGH4096")],
      candidates: [candidate("ONLY", { title })],
      libraryDocumentCount: N_LIB,
      bodyDocumentCount: N_BODY,
      averageFieldLengths: LIBRARY_AVERAGES,
      averageBodyLength: 7700,
    })[0].relevanceScore;

  const short = scoreOf("FGH4096");
  const long = scoreOf(
    `FGH4096 ${Array.from({ length: 80 }, () => "verbose").join(" ")}`,
  );
  assert.ok(
    short > long,
    `a 1-word title must outscore an 81-word title: ${short} vs ${long}`,
  );
});

test("the library averages are used verbatim, not re-derived from the pool", () => {
  const target = candidate("TARGET", { title: "FGH4096 superalloy" });
  const highBaseline = rankKeywordCandidates({
    probes: [probe("FGH4096")],
    candidates: [target, ...filler(20, "F")],
    libraryDocumentCount: N_LIB,
    bodyDocumentCount: N_BODY,
    averageFieldLengths: { ...LIBRARY_AVERAGES, title: 100 },
    averageBodyLength: 7700,
  })[0].relevanceScore;
  const lowBaseline = rankKeywordCandidates({
    probes: [probe("FGH4096")],
    candidates: [target, ...filler(20, "F")],
    libraryDocumentCount: N_LIB,
    bodyDocumentCount: N_BODY,
    averageFieldLengths: { ...LIBRARY_AVERAGES, title: 2 },
    averageBodyLength: 7700,
  })[0].relevanceScore;
  // A short title against a long library average is relatively concentrated, so
  // it must score higher. If the pool were still being used, both would agree.
  assert.ok(
    highBaseline > lowBaseline,
    `avgdl_title must reach the score: ${highBaseline} vs ${lowBaseline}`,
  );
});

// ================================================== library statistics provider

/** A stand-in library whose contents and signature can be driven by the test. */
function fakeLibrary(documents) {
  const state = { documents: [...documents], reads: 0 };
  return {
    state,
    provider: new LibraryFieldStats({
      async signature() {
        return `${state.documents.length}:${state.documents
          .map((document) => document.modified)
          .sort()
          .slice(-1)}`;
      },
      async readFields() {
        state.reads += 1;
        return state.documents.map((document) => document.fields);
      },
    }),
  };
}

const DOC = (modified, title, abstract) => ({
  modified,
  fields: { title, abstractNote: abstract },
});

test("library averages are computed once and reused while nothing changes", async () => {
  const { state, provider } = fakeLibrary([
    DOC("2026-01-01", "one two three", "alpha beta"),
    DOC("2026-01-02", "four five", "gamma delta epsilon"),
  ]);
  const first = await provider.get(1);
  const second = await provider.get(1);
  assert.equal(state.reads, 1, "the second call must not re-read the library");
  assert.deepEqual(first, second);
  assert.equal(first.documentCount, 2);
  assert.ok(first.averageLengths.title > 0);
});

test("adding a document updates the averages", async () => {
  const { state, provider } = fakeLibrary([
    DOC("2026-01-01", "one two", "a b"),
  ]);
  const before = await provider.get(1);
  state.documents.push(DOC("2026-01-03", "three four five six", "c d e f"));
  const after = await provider.get(1);
  assert.equal(state.reads, 2, "a changed signature must force a re-read");
  assert.equal(after.documentCount, 2);
  assert.ok(
    after.averageLengths.title > before.averageLengths.title,
    "a longer new title must raise the average",
  );
});

test("deleting a document updates the averages", async () => {
  const { state, provider } = fakeLibrary([
    DOC("2026-01-01", "one two", "a b"),
    DOC("2026-01-02", "three four five six seven", "c d e f g"),
  ]);
  const before = await provider.get(1);
  state.documents.pop();
  const after = await provider.get(1);
  assert.equal(after.documentCount, 1);
  assert.ok(after.averageLengths.title < before.averageLengths.title);
});

test("editing a document updates the averages", async () => {
  const { state, provider } = fakeLibrary([
    DOC("2026-01-01", "one two", "a b"),
  ]);
  const before = await provider.get(1);
  // Same document count; only the content and its timestamp move.
  state.documents[0] = DOC("2026-02-01", "one two three four five", "a b c d");
  const after = await provider.get(1);
  assert.equal(state.reads, 2, "an edit must be noticed, not just add/delete");
  assert.equal(after.documentCount, 1);
  assert.ok(after.averageLengths.title > before.averageLengths.title);
});

test("libraries are cached independently", async () => {
  const { state, provider } = fakeLibrary([
    DOC("2026-01-01", "one two", "a b"),
  ]);
  await provider.get(1);
  await provider.get(2);
  assert.equal(state.reads, 2, "one read per library");
  await provider.get(1);
  assert.equal(state.reads, 2, "and then cached per library");
});

test("an empty library yields zero averages rather than NaN", async () => {
  const { provider } = fakeLibrary([]);
  const stats = await provider.get(1);
  assert.equal(stats.documentCount, 0);
  for (const value of Object.values(stats.averageLengths)) {
    assert.equal(value, 0);
    assert.ok(Number.isFinite(value));
  }
});

test("a failing library read degrades to zero averages, not to a crash", async () => {
  const provider = new LibraryFieldStats({
    async signature() {
      return "x";
    },
    async readFields() {
      throw new Error("Zotero is busy");
    },
  });
  const stats = await provider.get(1);
  assert.equal(stats.documentCount, 0);
  // Zero averages disable length normalisation for that query rather than
  // inventing a reference; the search still answers.
  assert.equal(stats.averageLengths.title, 0);
});

// -------------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
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
