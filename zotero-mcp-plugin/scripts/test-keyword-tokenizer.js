/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  containsHan,
  latinTokenVariants,
  normalize,
  planQueryTerm,
  tokenizeForIndex,
  verifyOccurrence,
} = await import("../src/modules/keyword/scientificTokenizer.ts");
const { filterBodyForKeywordIndex, findReferencesBoundary, isNonBodyChunk } =
  await import("../src/modules/keyword/contentFilters.ts");
const {
  DEFAULT_FIELD_PARAMETERS,
  inverseDocumentFrequency,
  keywordCoverage,
  scoreDocument,
  weightedFrequency,
} = await import("../src/modules/keyword/bm25f.ts");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const terms = (text) => tokenizeForIndex(text).map((entry) => entry.term);

// ---------------------------------------------------------------- normalisation

test("dash variants fold onto the ASCII hyphen a user types", () => {
  // The publisher typesets an EN DASH; the user types a hyphen. Without this
  // the grade is unsearchable in exactly the papers that discuss it.
  assert.equal(normalize("Ti–6Al–4V"), "ti-6al-4v");
  assert.equal(normalize("Ti—6Al—4V"), "ti-6al-4v");
  assert.equal(normalize("Ti−6Al−4V"), "ti-6al-4v");
  assert.equal(normalize("Ti-6Al-4V"), "ti-6al-4v");
});

test("prime and apostrophe variants fold together", () => {
  assert.equal(normalize("γ′"), "γ'");
  assert.equal(normalize("γ’"), "γ'");
  assert.equal(normalize("γ'"), "γ'");
});

test("full-width Latin folds onto ASCII", () => {
  assert.equal(normalize("ＦＧＨ４０９６"), "fgh4096");
});

// ------------------------------------------------------------------- Latin side

test("material grades survive as one token", () => {
  assert.ok(terms("Ti-6Al-4V").includes("ti-6al-4v"));
  assert.ok(terms("FGH4096 superalloy").includes("fgh4096"));
  assert.ok(terms("Ni3Al precipitates").includes("ni3al"));
  assert.ok(terms("Al2O3 particles").includes("al2o3"));
});

test("the hyphenated and solid spellings find each other, both ways", () => {
  // Measured asymmetry this closes: on the real library `Ti-6Al-4V` returned 23
  // documents and `Ti6Al4V` returned 31 — the same grade, because a paper that
  // printed it solid had no separators to strip and so never indexed the
  // hyphenated form. The query side now carries the equivalence.
  const hyphenated = planQueryTerm("Ti-6Al-4V");
  assert.deepEqual(hyphenated.terms, ["ti-6al-4v"]);
  assert.deepEqual(
    (hyphenated.alternatives ?? []).map((plan) => plan.terms),
    [["ti6al4v"]],
    "must offer the solid spelling as an ALTERNATIVE",
  );
  // Not as an extra required term: demanding both spellings in one field would
  // find nothing at all.
  assert.ok(!hyphenated.terms.includes("ti6al4v"));

  const solid = planQueryTerm("Ti6Al4V");
  assert.deepEqual(solid.terms, ["ti6al4v"]);

  // And a document written either way carries the token the other query asks for.
  assert.ok(terms("Ti–6Al–4V sample").includes("ti6al4v"));
  assert.ok(terms("Ti6Al4V sample").includes("ti6al4v"));
});

test("a grade is also indexed written solid, so either spelling finds it", () => {
  const indexed = terms("Ti–6Al–4V was tested");
  assert.ok(indexed.includes("ti-6al-4v"), "hyphenated form");
  assert.ok(indexed.includes("ti6al4v"), "solid form");
  // And the query side reaches the document from either spelling.
  assert.deepEqual(planQueryTerm("Ti6Al4V").terms, ["ti6al4v"]);
  assert.deepEqual(planQueryTerm("Ti-6Al-4V").terms, ["ti-6al-4v"]);
});

test("greek symbols are also indexed spelled out", () => {
  const indexed = terms("the γ′ precipitate");
  assert.ok(indexed.includes("γ'"), "symbol form");
  assert.ok(indexed.includes("gamma'"), "spelled form");
});

test("gamma prime and γ′ reach each other, but γ and γ′ stay distinct", () => {
  const prime = planQueryTerm("gamma prime");
  const alternatives = (prime.alternatives ?? []).map(
    (plan) => plan.normalized,
  );
  assert.ok(
    alternatives.includes("γ'"),
    "spelled-out query must reach the symbol",
  );
  // The prime is never stripped: in a nickel superalloy γ is the matrix and γ′
  // is the strengthening precipitate, so folding them together would answer a
  // question about one with papers about the other.
  assert.ok(!latinTokenVariants("γ'").includes("γ"));
});

test("a term inside a hyphenated word is NOT a hit for that word", () => {
  // Requested explicitly: x-ray must not be found by searching for ray.
  const indexed = terms("x-ray diffraction");
  assert.ok(indexed.includes("x-ray"));
  assert.ok(indexed.includes("xray"));
  assert.ok(!indexed.includes("ray"), "no sub-token pieces");
  assert.ok(!indexed.includes("x"), "single letters are not indexed");
});

test("single characters and punctuation are not indexable terms", () => {
  assert.deepEqual(planQueryTerm("a").terms, []);
  assert.deepEqual(planQueryTerm("   ").terms, []);
  assert.deepEqual(planQueryTerm("--").terms, []);
});

// --------------------------------------------------------------------- Han side

test("non-Han tokens NEVER go through the Han bigram path", () => {
  // A grade must be one term, not a pile of 2-character fragments: the Han
  // bigram rule applies only to runs of Han characters, and Latin/digit/symbol
  // tokens keep their own tokeniser.
  for (const grade of ["FGH4096", "Ti-6Al-4V", "Ni3Al", "GH4169", "Al2O3"]) {
    const indexed = terms(grade);
    const expected = latinTokenVariants(normalize(grade));
    assert.deepEqual(
      indexed,
      expected,
      `${grade} must yield only its Latin variants, got ${JSON.stringify(indexed)}`,
    );
    for (const term of indexed) {
      assert.ok(
        !/^[一-鿿]{2}$/u.test(term),
        `${grade} produced a Han bigram: ${term}`,
      );
    }
  }
});

test("a mixed Han/Latin string splits at the script boundary, not inside it", () => {
  // FGH4096 stays whole; only the Han run becomes bigrams.
  const indexed = terms("FGH4096合金锰造");
  assert.ok(indexed.includes("fgh4096"), "grade kept whole");
  assert.ok(
    !indexed.some((term) => term.startsWith("40")),
    "no digit fragments",
  );
  const han = indexed.filter((term) => /[一-鿿]/u.test(term));
  assert.deepEqual(han, ["合金", "金锰", "锰造"]);
});

test("Han runs are indexed as overlapping bigrams", () => {
  assert.deepEqual(terms("定向凝固"), ["定向", "向凝", "凝固"]);
});

test("a two-character Han term needs no verification: the bigram IS the term", () => {
  const plan = planQueryTerm("锰造");
  assert.equal(plan.terms.length, 1);
  assert.equal(plan.requiresVerification, false);
});

test("a longer Han term is a bigram conjunction and MUST be verified", () => {
  const plan = planQueryTerm("柱状晶");
  assert.deepEqual(plan.terms, ["柱状", "状晶"]);
  assert.equal(plan.requiresVerification, true);
});

test("verification is what removes the false hit the conjunction allows", () => {
  const plan = planQueryTerm("柱状晶");
  // Both bigrams present, but never adjacent: the passage does not contain the
  // term. Measured on the real library this shape is 6.3% of bigram-only hits.
  const decoy = "柱状组织与环状晶粒";
  assert.ok(plan.terms.every((term) => decoy.includes(term)));
  assert.equal(verifyOccurrence(decoy, plan), false);
  assert.equal(verifyOccurrence("定向柱状晶阵列", plan), true);
});

test("mixed-script terms are verified too", () => {
  const plan = planQueryTerm("δ相");
  assert.equal(plan.requiresVerification, true);
  assert.equal(verifyOccurrence("析出δ相", plan), true);
});

test("a multi-word keyword is verified as a literal phrase", () => {
  // Matches how the existing metadata ranker has always treated a multi-word
  // keyword: as a substring, not as a bag of words. A paper mentioning Inconel
  // 625 and, separately, the number 718 has not mentioned Inconel 718.
  const plan = planQueryTerm("Inconel 718");
  assert.deepEqual(plan.terms, ["inconel", "718"]);
  assert.equal(plan.requiresVerification, true);
  assert.equal(verifyOccurrence("the Inconel 718 alloy", plan), true);
  assert.equal(
    verifyOccurrence("Inconel 625 per ISO 718", plan),
    false,
    "both tokens present but the phrase is not",
  );
});

test("a single-token keyword needs no verification at all", () => {
  for (const keyword of ["FGH4096", "Ti-6Al-4V", "superalloy", "锰造"]) {
    assert.equal(
      planQueryTerm(keyword).requiresVerification,
      false,
      `${keyword} should be answerable from the index alone`,
    );
  }
});

test("containsHan distinguishes the two tokenisation regimes", () => {
  assert.equal(containsHan("高温合金"), true);
  assert.equal(containsHan("superalloy"), false);
});

// -------------------------------------------------------------- content filters

test("a Markdown references heading is found, which the old pattern missed", () => {
  // This is the whole reason reference lists were being indexed: the body text
  // comes from MinerU Markdown, where the heading is "## References", and the
  // previous pattern required the word alone on a line.
  const body = "Conclusions here.\n\n## References\n\n[1] R.C. Reed (2006).\n";
  const at = findReferencesBoundary(body);
  assert.notEqual(at, null);
  assert.ok(body.slice(at).startsWith("## References"));
});

test("reference headings are found in every real spelling", () => {
  for (const heading of [
    "## References",
    "# REFERENCES",
    "References",
    "5. References",
    "### Bibliography",
    "## 参考文献",
    "References:",
  ]) {
    const body = `Body text.\n\n${heading}\n\n[1] Someone (2020).`;
    assert.notEqual(
      findReferencesBoundary(body),
      null,
      `not detected: ${heading}`,
    );
  }
});

test("a sentence merely containing the word is not a heading", () => {
  const body = "References to prior work appear throughout the discussion.";
  assert.equal(findReferencesBoundary(body), null);
});

test("a duplicated body keeps everything up to the LAST reference list", () => {
  // Real shape in this library: the same paper's text appears twice, so taking
  // the first heading would throw away a whole body's worth of real content.
  const half =
    "## 1. Introduction\n\nReal content.\n\n## References\n\n[1] A (2001).\n";
  const at = findReferencesBoundary(half + half);
  assert.ok(at > half.length, "must take the second heading");
});

test("references, images, hashes and submission boilerplate are dropped", () => {
  const body = [
    "## 1. Introduction",
    "",
    "The FGH4096 alloy was studied.",
    "",
    "![](images/8f3a2b7c9d1e4f5a6b8c0d2e4f6a8b0c2d4e6f8a.jpg)",
    "",
    "## CRediT authorship contribution statement",
    "",
    "Kai Chang: Investigation, Methodology.",
    "",
    "## Declaration of Competing Interest",
    "",
    "The authors declare no competing interest.",
    "",
    "## References",
    "",
    "[1] Y. Ning, Flow behaviour of FGH4096, Mater. Sci. Eng. A 531 (2012) 91.",
  ].join("\n");
  const result = filterBodyForKeywordIndex(body);
  assert.ok(result.text.includes("FGH4096 alloy was studied"), "body kept");
  assert.ok(!/images\//u.test(result.text), "image link dropped");
  assert.ok(!/CRediT/iu.test(result.text), "contribution section dropped");
  assert.ok(!/Competing Interest/iu.test(result.text), "declaration dropped");
  assert.ok(!/Mater\. Sci\. Eng/u.test(result.text), "reference entry dropped");
  assert.ok(result.removed.referencesChars > 0);
  assert.ok(result.removed.boilerplateChars > 0);
});

test("a chunk that is entirely bibliography is skipped whole", () => {
  const chunk = [
    "[1] R.C. Reed, The Superalloys, Cambridge (2006).",
    "[2] Y. Ning, Flow behaviour, Mater. Sci. Eng. A 531 (2012) 91.",
    "[3] W. Liu, Hot deformation, J. Alloys Compd. 938 (2023) 168.",
  ].join("\n");
  assert.equal(isNonBodyChunk(chunk), true);
});

test("a body chunk that merely cites something is kept", () => {
  const chunk =
    "Dynamic recrystallisation nucleates at grain boundaries [18], and the " +
    "resulting grain size follows the model proposed earlier [19].";
  assert.equal(isNonBodyChunk(chunk), false);
});

test("an empty or image-only chunk is skipped", () => {
  assert.equal(isNonBodyChunk("   \n  "), true);
  assert.equal(isNonBodyChunk("![](images/abc.jpg)"), true);
});

// ---------------------------------------------------------------------- BM25F

const statistics = {
  documentCount: 900,
  fields: {
    title: { averageLength: 12 },
    abstract: { averageLength: 180 },
    tags: { averageLength: 8 },
    body: { averageLength: 6000 },
  },
};
const lengths = { title: 12, abstract: 180, tags: 8, body: 6000 };

test("idf never goes negative, so a common word cannot punish a document", () => {
  // The textbook form goes negative once a term is in more than half the corpus,
  // which would make containing a common word REDUCE a document's score. The
  // floor is what stops that; a ubiquitous term must contribute ~nothing, not
  // something harmful.
  assert.ok(
    inverseDocumentFrequency(900, 1) > inverseDocumentFrequency(900, 400),
  );
  for (const df of [0, 1, 450, 899, 900, 100000]) {
    assert.ok(
      inverseDocumentFrequency(900, df) >= 0,
      `idf went negative at df=${df}`,
    );
  }
  assert.ok(inverseDocumentFrequency(900, 900) < 0.01, "ubiquitous term ~ 0");
  assert.equal(inverseDocumentFrequency(0, 0), 0, "empty corpus");
});

test("field weights order title above abstract above body above tags", () => {
  const one = (field) =>
    weightedFrequency({
      frequencies: { [field]: 1 },
      lengths,
      statistics,
    });
  assert.ok(one("title") > one("abstract"), "title beats abstract");
  assert.ok(one("abstract") > one("body"), "abstract beats body");
  assert.ok(one("body") > one("tags"), "body beats tags");
});

test("frequencies are summed ACROSS fields before saturating", () => {
  // This is what makes it BM25F rather than a weighted sum of per-field BM25
  // scores: one hit in the title plus one in the abstract must beat two hits in
  // the abstract alone, because breadth of evidence is the stronger signal.
  const spread = scoreDocument({
    contributions: [
      {
        term: "t",
        documentFrequency: 20,
        frequencies: { title: 1, abstract: 1 },
      },
    ],
    lengths,
    statistics,
  }).score;
  const piled = scoreDocument({
    contributions: [
      { term: "t", documentFrequency: 20, frequencies: { abstract: 2 } },
    ],
    lengths,
    statistics,
  }).score;
  assert.ok(spread > piled, `${spread} should exceed ${piled}`);
});

test("each field normalises by its OWN average length", () => {
  // A long body dilutes a body hit. The same document with a short body scores
  // higher for the same count — and the title's contribution is untouched,
  // which is the point of independent per-field normalisation.
  const longBody = weightedFrequency({
    frequencies: { body: 3 },
    lengths: { ...lengths, body: 24000 },
    statistics,
  });
  const shortBody = weightedFrequency({
    frequencies: { body: 3 },
    lengths: { ...lengths, body: 1500 },
    statistics,
  });
  assert.ok(shortBody > longBody);
  const titleOnly = (bodyLength) =>
    weightedFrequency({
      frequencies: { title: 1 },
      lengths: { ...lengths, body: bodyLength },
      statistics,
    });
  assert.equal(titleOnly(24000), titleOnly(1500));
});

test("repeated occurrences saturate instead of accumulating linearly", () => {
  const at = (frequency) =>
    scoreDocument({
      contributions: [
        { term: "t", documentFrequency: 20, frequencies: { body: frequency } },
      ],
      lengths,
      statistics,
    }).score;
  const step1 = at(2) - at(1);
  const step2 = at(40) - at(39);
  assert.ok(step1 > step2, "later occurrences must add less");
  assert.ok(at(40) < 40 * at(1), "not linear");
});

test("a rare term outweighs a common one at equal frequency", () => {
  const rare = scoreDocument({
    contributions: [
      { term: "fgh4096", documentFrequency: 3, frequencies: { body: 5 } },
    ],
    lengths,
    statistics,
  }).score;
  const common = scoreDocument({
    contributions: [
      { term: "alloy", documentFrequency: 700, frequencies: { body: 5 } },
    ],
    lengths,
    statistics,
  }).score;
  assert.ok(rare > common * 3, `${rare} vs ${common}`);
});

test("a zero-weight probe contributes nothing", () => {
  const result = scoreDocument({
    contributions: [
      { term: "t", documentFrequency: 5, frequencies: { title: 3 }, weight: 0 },
    ],
    lengths,
    statistics,
  });
  assert.equal(result.score, 0);
  assert.deepEqual(result.matchedTerms, []);
});

test("matched fields and terms are reported for evidence", () => {
  const result = scoreDocument({
    contributions: [
      { term: "a", documentFrequency: 10, frequencies: { title: 1, body: 2 } },
      { term: "b", documentFrequency: 10, frequencies: { tags: 1 } },
      { term: "c", documentFrequency: 10, frequencies: {} },
    ],
    lengths,
    statistics,
  });
  assert.deepEqual(result.matchedTerms, ["a", "b"]);
  assert.deepEqual(result.matchedFields, ["title", "tags", "body"]);
  assert.equal(keywordCoverage(result.matchedTerms.length, 3), 2 / 3);
});

test("an empty corpus scores nothing rather than dividing by zero", () => {
  const result = scoreDocument({
    contributions: [
      { term: "t", documentFrequency: 0, frequencies: { title: 1 } },
    ],
    lengths: { title: 0, abstract: 0, tags: 0, body: 0 },
    statistics: {
      documentCount: 0,
      fields: {
        title: { averageLength: 0 },
        abstract: { averageLength: 0 },
        tags: { averageLength: 0 },
        body: { averageLength: 0 },
      },
    },
  });
  assert.equal(result.score, 0);
  assert.ok(Number.isFinite(result.score));
});

test("field parameter table stays in the documented order", () => {
  const { title, abstract, body, tags } = DEFAULT_FIELD_PARAMETERS;
  assert.ok(title.boost > abstract.boost);
  assert.ok(abstract.boost > body.boost);
  assert.ok(body.boost > tags.boost);
  for (const parameters of [title, abstract, body, tags]) {
    assert.ok(parameters.b >= 0 && parameters.b <= 1);
  }
});

// ------------------------------------------------------------------------ run

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message.split("\n").join("\n       ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
