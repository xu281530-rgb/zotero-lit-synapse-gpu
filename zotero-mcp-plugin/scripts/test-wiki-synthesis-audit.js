/* eslint-env node */

/**
 * The evidence-closure gate on the whole-paper synthesis.
 *
 * Every case here is a GENERIC drift, written against an invented paper about
 * an invented technique, because the failure being guarded is not one paper's:
 * it is what happens to any careful source when a model is asked to say it in
 * one voice. Nothing in this suite - or in the module it tests - knows anything
 * about the paper that exposed the problem.
 *
 * The transformations under test, one block each:
 *
 *   1. common -> orthogonal          (a relation reversed, wording untouched)
 *   2. may -> definitely             (a hedge deleted)
 *   3. difficult -> impossible       (a difficulty promoted to a barrier)
 *   4. family -> one member          (ET's merits attributed to DC-ET)
 *   5. A's capability -> B           (one technique credited with another's)
 *   6. a negation deleted            (a boundary read as a capability)
 *   7. a number kept, its conditions dropped
 *   8. two chunks fused into a relationship neither states
 *   9. an enumeration silently shortened
 *
 * And the two halves of the contract that keep it honest:
 *
 *   - a note written at the paper's own strength passes untouched, because a
 *     gate that refuses everything is a gate nobody can satisfy;
 *   - a quotation that is not in the chunk, character for character, is
 *     refused - no similarity, no threshold, no "close enough".
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  auditSynthesis,
  verifySynthesisAudit,
  citedChunkIds,
  splitSentences,
  splitNoteBlocks,
  enumerationDepth,
  techniqueTokens,
  describeFlaggedSentences,
  WIKI_SYNTHESIS_MIN_QUOTE_CHARS,
} = await import("../src/modules/wiki/wikiSynthesisAudit.ts");

const { describeEvidenceMismatch, longestMatchingPrefix } = await import(
  "../src/modules/wiki/wikiEvidenceDiagnostics.ts"
);

const {
  assertChunkCitationsResolvable,
  assertBlockCitations,
} = await import("../src/modules/wiki/wikiReadingNote.ts");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message.split("\n")[0]}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

/** Does the audit flag this sentence, and for the reason expected? */
function flagsOf(markdown, chunks) {
  const flagged = auditSynthesis(markdown, { chunks });
  return flagged.map((entry) => ({
    sentence: entry.sentence,
    reasons: entry.reasons,
    cited: entry.citedChunks,
    details: entry.details.join(" | "),
  }));
}

function assertFlagged(markdown, chunks, reason, hint) {
  const flags = flagsOf(markdown, chunks);
  const match = flags.find((entry) => entry.reasons.includes(reason));
  assert.ok(
    match,
    `expected a "${reason}" flag${hint ? ` (${hint})` : ""}, got ${JSON.stringify(flags, null, 2)}`,
  );
  return match;
}

// --- Fixtures -------------------------------------------------------------
//
// An invented review of an invented technique. The wording mirrors the SHAPES
// that real careful writing uses - hedges, enumerations, explicit boundaries -
// without reproducing any real paper.

const CHUNKS = [
  {
    chunkId: 0,
    text:
      "The ordered Xy4Z phase forms six equivalent orientation variants in the disordered matrix. " +
      "Figure 2 illustrates two of the six variants that have the common c-axis coinciding with the " +
      "[001] axis of the matrix. Because each variant exhibits reflections at different locations in " +
      "reciprocal space, dark-field imaging visualises one of the six variants.",
  },
  {
    chunkId: 1,
    text:
      "Because the structure factors for superlattice reflections are generally smaller than those of " +
      "fundamental reflections, it is expected that the visualisation of superlattice domain structures " +
      "by ZBSD or ZCCI in the surface instrument is difficult. Therefore, the contrast tomography " +
      "demonstrated above is notably unique among the various three-dimensional imaging methods.",
  },
  {
    chunkId: 2,
    text:
      "Based on their findings, they proposed the following essential points for obtaining reliable " +
      "three-dimensional reconstructed volumes: (i) selection of a higher acceleration voltage; " +
      "(ii) selection of a low-index reflection; (iii) precise alignment to a particular condition; " +
      "(iv) avoidance of low-index zone axis illumination; (v) difficulties in visualising anti-phase " +
      "domain boundaries; and (vi) use of an iteration-type reconstruction algorithm.",
  },
  {
    chunkId: 3,
    text:
      "The wide diameter of the side-entry holder is capable of a full rotation along the primary tilt " +
      "axis without rotating the stage goniometer. This full rotation combined with needle-shaped " +
      "specimen preparation can be a solution for missing wedge artifacts as well as alignment. " +
      "Furthermore, the free space around a specimen on the tri-axial holder gives remarkably high " +
      "efficiency in X-ray measurements.",
  },
  {
    chunkId: 4,
    text:
      "In situ imaging of defect dynamics is a promising topic for future applications. It is very " +
      "challenging to observe the dynamics under a constant diffraction condition because rotation, as " +
      "well as deformation, occurs with loading stress. Therefore, alignment-free observation is " +
      "proposed as follows: repeatedly acquire tilt-series data sets during deformation and select the " +
      "frames in which the defects are visible. Figure 14 depicts a preliminary observation of the " +
      "dynamics in a drawn and heat-treated alloy specimen.",
  },
  {
    chunkId: 5,
    text:
      "The merits of selecting intermediate-resolution volume imaging as a three-dimensional method " +
      "include not only the superior resolving power of the transmission instrument but also unique " +
      "applications, such as the visualisation of electromagnetic fields, domain structures in " +
      "compound crystals and defect substructures in metallic materials, among others.",
  },
  {
    chunkId: 6,
    text:
      "A combination of holographic interferometry with volume imaging is capable of visualising " +
      "nanoscale electromagnetic fields in three dimensions. Holographic volume imaging was applied to " +
      "visualise the electric potential fields in semiconducting devices.",
  },
  {
    chunkId: 7,
    text:
      "The extinction distances of the two reflections are 35 nm and 175 nm under the following " +
      "conditions: an acceleration voltage of 200 kV and exact Bragg cases in systematic excitation " +
      "conditions. The intensities increase monotonically up to 17 nm and 55 nm respectively.",
  },
  {
    chunkId: 8,
    text:
      "When the specimen is a thin foil, it is generally challenging to acquire tilt-series data in " +
      "the high tilt angular range. Thus information from that angular range is not available, and the " +
      "missing information severely degrades the resolution along the thickness direction.",
  },
];

const CHUNK_IDS = CHUNKS.map((chunk) => chunk.chunkId);

// --- 1. Parsing primitives ------------------------------------------------

section("The primitives the gate is built on");

test("chunk citations are read from prose and never from a bibliography bracket", () => {
  assert.deepEqual(citedChunkIds("the value rises (chunk 7)"), [7]);
  assert.deepEqual(citedChunkIds("cited work [51-68] says so (chunk 3, chunk 4)"), [3, 4]);
  // A reference bracket alone is not a citation, however numeric it looks.
  assert.deepEqual(citedChunkIds("earlier work [51-68] established this"), []);
});

test("sentence splitting survives inline maths, decimals and abbreviations", () => {
  const sentences = splitSentences(
    "The alloy is Ni-19.5 at.% Mo aged at 1073 K. The range is $\\pm70^\\circ$ to $90^\\circ$. Done.",
  );
  assert.equal(sentences.length, 3, JSON.stringify(sentences));
  assert.ok(sentences[0].includes("19.5 at.% Mo"), sentences[0]);
  assert.ok(sentences[1].includes("$\\pm70^\\circ$"), sentences[1]);
});

test("each bullet is its own block, so one citation cannot cover five findings", () => {
  const blocks = splitNoteBlocks(
    "## Heading\n\n- first finding here\n- second finding here\n\nA paragraph.\n",
  ).filter((block) => block.prose);
  assert.equal(blocks.length, 3, JSON.stringify(blocks));
});

test("enumeration depth reads roman and arabic markers", () => {
  assert.equal(enumerationDepth("(i) a; (ii) b; (iii) c; (iv) d; (v) e; (vi) f"), 6);
  assert.equal(enumerationDepth("(1) a; (2) b"), 2);
  assert.equal(enumerationDepth("no enumeration here"), 0);
});

test("technique tokens are acronym-shaped names, not ordinary capitalised words", () => {
  const tokens = techniqueTokens("The DC-ET result differs from the LAADF-STEM result in Figure.");
  assert.ok(tokens.includes("DC-ET"), JSON.stringify(tokens));
  assert.ok(tokens.includes("LAADF-STEM"), JSON.stringify(tokens));
  assert.ok(!tokens.includes("Figure"), JSON.stringify(tokens));
  assert.ok(!tokens.includes("The"), JSON.stringify(tokens));
});

// --- 2. The nine drifts ---------------------------------------------------

section("Drift 1-9: the transformations a complete reading still produces");

test("common -> orthogonal: a reversed relation is flagged, not waved through", () => {
  const note =
    "# Paper\n\nThe reconstruction resolved two orthogonal c-axis variants of the ordered phase (chunk 0).\n";
  const flag = assertFlagged(note, CHUNKS, "relation-word", "orthogonal reverses common");
  assert.ok(/orthogonal/i.test(flag.details), flag.details);
});

test("may -> definitely: a deleted hedge is caught by reading the source, not the wording", () => {
  const note =
    "# Paper\n\nIn situ alignment-free acquisition captures four-dimensional defect dynamics during " +
    "plastic deformation of the alloy (chunk 4).\n";
  assertFlagged(note, CHUNKS, "hedge-dropped", "chunk 4 says promising / challenging / proposed / preliminary");
});

test("difficult -> impossible: a difficulty promoted to a barrier is flagged twice over", () => {
  const note =
    "# Paper\n\nBecause the structure factors are weak, the surface instrument cannot image these " +
    "domains at all (chunk 1).\n";
  const flags = flagsOf(note, CHUNKS);
  const entry = flags[0];
  assert.ok(entry, "expected the sentence to be flagged");
  assert.ok(entry.reasons.includes("absolute-language"), JSON.stringify(entry));
  assert.ok(entry.reasons.includes("hedge-dropped"), JSON.stringify(entry));
});

test("family -> one member: narrowing the subject of a merit is flagged", () => {
  // chunk 5 credits the whole family; the note credits one acronym inside it,
  // and that acronym appears nowhere in the chunk.
  const note =
    "# Paper\n\nIntermediate-resolution DC-ET is irreplaceable for domain structures and " +
    "electromagnetic fields (chunk 5).\n";
  const flag = assertFlagged(note, CHUNKS, "subject-not-in-cited-chunks", "DC-ET is not in chunk 5");
  assert.ok(/DC-ET/.test(flag.details), flag.details);
  assert.ok(flag.reasons.includes("absolute-language"), JSON.stringify(flag));
});

test("A's capability -> B: crediting one technique with another's is flagged", () => {
  // Electromagnetic-field visualisation belongs to the holographic method in
  // chunk 6; asserting it of an acronym absent from the cited chunk is exactly
  // the misattribution.
  const note =
    "# Paper\n\nWBDF-STEM tomography visualises nanoscale electromagnetic fields in three " +
    "dimensions (chunk 6).\n";
  const flag = assertFlagged(note, CHUNKS, "subject-not-in-cited-chunks");
  assert.ok(/WBDF-STEM/.test(flag.details), flag.details);
});

test("a deleted negation is flagged, because the sentence reads as a capability", () => {
  const note =
    "# Paper\n\nTilt-series data in the high angular range is available for thin foils, so axial " +
    "resolution is preserved (chunk 8).\n";
  const flags = flagsOf(note, CHUNKS);
  assert.ok(flags.length, "expected the sentence to be flagged");
  assert.ok(
    flags[0].reasons.includes("hedge-dropped") ||
      flags[0].reasons.includes("polarity-word"),
    JSON.stringify(flags[0]),
  );
});

test("a number kept while its measurement conditions were dropped is flagged", () => {
  // The number is right. What went missing is "at 200 kV under exact Bragg
  // conditions", without which 175 nm reads as a property of the material
  // rather than of one reflection at one voltage.
  const note =
    "# Paper\n\nThe extinction distances of the two reflections are 35 nm and 175 nm (chunk 7).\n";
  const flag = assertFlagged(note, CHUNKS, "condition-dropped");
  assert.ok(/conditions its source attached/i.test(flag.details), flag.details);
});

test("a number that already carries its conditions is left alone", () => {
  const note =
    "# Paper\n\nUnder an acceleration voltage of 200 kV and exact Bragg conditions, the extinction " +
    "distances of the two reflections are 35 nm and 175 nm (chunk 7).\n";
  const flags = flagsOf(note, CHUNKS);
  assert.equal(flags.length, 0, JSON.stringify(flags, null, 2));
});

test("a direction word alone passes; a direction word WITH a number escalates", () => {
  // Two weak signals in one sentence is the shape "increased by 10%" and
  // "decreased by 10%" share. One weak signal is just ordinary prose.
  const bare =
    "# Paper\n\nDark-field imaging of a single reflection improves the visibility of the ordered " +
    "domains throughout the reconstructed volume of this specimen (chunk 0).\n";
  assert.equal(
    flagsOf(bare, CHUNKS).length,
    0,
    JSON.stringify(flagsOf(bare, CHUNKS), null, 2),
  );

  const both =
    "# Paper\n\nDark-field imaging of a single reflection improves the visibility of the ordered " +
    "domains by 10 percent throughout this specimen (chunk 0).\n";
  const flags = flagsOf(both, CHUNKS);
  assert.equal(flags.length, 1, JSON.stringify(flags, null, 2));
  assert.ok(flags[0].reasons.includes("direction-word"), JSON.stringify(flags[0]));
  assert.ok(flags[0].reasons.includes("quantity"), JSON.stringify(flags[0]));
});

test("two chunks fused into one claim must be answered by both", () => {
  const note =
    "# Paper\n\nFull rotation with needle specimens removes missing wedge artifacts and raises " +
    "X-ray collection efficiency (chunk 3, chunk 8).\n";
  const flag = assertFlagged(note, CHUNKS, "multi-chunk-fusion");
  assert.deepEqual(flag.cited, [3, 8]);
});

test("an enumeration shortened against its source is flagged and says so", () => {
  const note =
    "# Paper\n\nThe essential points are (i) higher acceleration voltage, (ii) a low-index " +
    "reflection, (iii) precise alignment, (iv) avoiding low-index zone axes and (v) an iterative " +
    "reconstruction algorithm (chunk 2).\n";
  const flag = assertFlagged(note, CHUNKS, "enumeration-shortened");
  assert.ok(/enumerates 5 item\(s\) where chunk 2 enumerates 6/.test(flag.details), flag.details);
});

// --- 3. The gate does not refuse honest writing ---------------------------

section("A note written at the paper's own strength");

test("careful prose that keeps the source's hedges is not flagged", () => {
  const note =
    "# Paper\n\nCombining full rotation with needle-shaped specimens can be a solution for missing " +
    "wedge artifacts (chunk 3).\n";
  const flags = flagsOf(note, CHUNKS);
  assert.equal(flags.length, 0, JSON.stringify(flags, null, 2));
});

test("a sentence naming one chunk whose subject really is in it is not flagged", () => {
  const note =
    "# Paper\n\nDark-field imaging by a superlattice reflection visualises one of the six orientation " +
    "variants of the ordered phase, which is generally how the variants are told apart (chunk 0).\n";
  const flags = flagsOf(note, CHUNKS);
  assert.equal(flags.length, 0, JSON.stringify(flags, null, 2));
});

// --- 4. Proof is verbatim, and nothing else counts ------------------------

section("Verifying the proof");

test("a real quotation from the cited chunk closes the sentence", () => {
  const note =
    "# Paper\n\nThe extinction distances of the two reflections are 35 nm and 175 nm (chunk 7).\n";
  const flagged = auditSynthesis(note, { chunks: CHUNKS });
  assert.equal(flagged.length, 1);
  const problems = verifySynthesisAudit(
    flagged,
    [
      {
        sentence: flagged[0].sentence,
        support: [
          {
            chunkId: 7,
            quote:
              "The extinction distances of the two reflections are 35 nm and 175 nm under the following conditions",
          },
        ],
      },
    ],
    CHUNKS,
  );
  assert.deepEqual(problems, [], JSON.stringify(problems, null, 2));
});

test("a quotation that is not in the chunk is refused, however close it reads", () => {
  const note =
    "# Paper\n\nThe extinction distances of the two reflections are 35 nm and 175 nm (chunk 7).\n";
  const flagged = auditSynthesis(note, { chunks: CHUNKS });
  const problems = verifySynthesisAudit(
    flagged,
    [
      {
        sentence: flagged[0].sentence,
        // One digit changed. Semantically near-identical, factually opposite.
        support: [
          {
            chunkId: 7,
            quote:
              "The extinction distances of the two reflections are 35 nm and 195 nm under the following conditions",
          },
        ],
      },
    ],
    CHUNKS,
  );
  // Two problems, and both are right: the quotation is not in the chunk, and
  // the chunk it was meant to prove therefore stands unquoted. A refused
  // quotation must never leave the citation looking satisfied.
  assert.ok(
    problems.some((problem) => /character for character/.test(problem.problem)),
    JSON.stringify(problems, null, 2),
  );
  assert.ok(
    problems.some((problem) => /cited but not quoted/.test(problem.problem)),
    JSON.stringify(problems, null, 2),
  );
});

test("a fused sentence is not closed by quoting only one of its chunks", () => {
  const note =
    "# Paper\n\nFull rotation with needle specimens removes missing wedge artifacts and raises " +
    "X-ray collection efficiency (chunk 3, chunk 8).\n";
  const flagged = auditSynthesis(note, { chunks: CHUNKS });
  const problems = verifySynthesisAudit(
    flagged,
    [
      {
        sentence: flagged[0].sentence,
        support: [
          {
            chunkId: 3,
            quote:
              "This full rotation combined with needle-shaped specimen preparation can be a solution for missing wedge artifacts",
          },
        ],
      },
    ],
    CHUNKS,
  );
  assert.ok(
    problems.some((problem) => /chunk\(s\) 8 are cited but not quoted/.test(problem.problem)),
    JSON.stringify(problems, null, 2),
  );
});

test("a token-length quotation proves nothing and is refused", () => {
  const note = "# Paper\n\nThe extinction distances of the two reflections are 35 nm and 175 nm (chunk 7).\n";
  const flagged = auditSynthesis(note, { chunks: CHUNKS });
  const problems = verifySynthesisAudit(
    flagged,
    [{ sentence: flagged[0].sentence, support: [{ chunkId: 7, quote: "35 nm" }] }],
    CHUNKS,
  );
  assert.ok(
    problems.some((problem) =>
      problem.problem.includes(String(WIKI_SYNTHESIS_MIN_QUOTE_CHARS)),
    ),
    JSON.stringify(problems),
  );
});

test("an unanswered flagged sentence is named, not silently accepted", () => {
  const note = "# Paper\n\nThe extinction distances of the two reflections are 35 nm and 175 nm (chunk 7).\n";
  const flagged = auditSynthesis(note, { chunks: CHUNKS });
  const problems = verifySynthesisAudit(flagged, [], CHUNKS);
  assert.equal(problems.length, 1);
  assert.ok(/not answered/.test(problems[0].problem), problems[0].problem);
});

test("an audit entry matching no flagged sentence is reported back", () => {
  const note = "# Paper\n\nThe extinction distances of the two reflections are 35 nm and 175 nm (chunk 7).\n";
  const flagged = auditSynthesis(note, { chunks: CHUNKS });
  const problems = verifySynthesisAudit(
    flagged,
    [
      {
        sentence: flagged[0].sentence,
        support: [
          {
            chunkId: 7,
            quote:
              "The extinction distances of the two reflections are 35 nm and 175 nm under the following conditions",
          },
        ],
      },
      { sentence: "A sentence that is not in the note at all.", support: [] },
    ],
    CHUNKS,
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(/was not flagged/.test(problems[0].problem), problems[0].problem);
});

// --- 5. Citations have to resolve ----------------------------------------

section("Citations that resolve to nothing");

test("a chunk number the paper does not have is refused, naming it", () => {
  assert.throws(
    () =>
      assertChunkCitationsResolvable("The value rises (chunk 91).", {
        allowedChunkIds: CHUNK_IDS,
        totalChunks: CHUNKS.length,
      }),
    (error) =>
      /chunk\(s\) 91/.test(error.message) && /do not exist/.test(error.message),
  );
});

test("a chunk that exists but has not been delivered is refused separately", () => {
  assert.throws(
    () =>
      assertChunkCitationsResolvable("The value rises (chunk 7).", {
        allowedChunkIds: [0, 1, 2],
        totalChunks: 20,
      }),
    (error) => /have not been delivered/.test(error.message),
  );
});

test("a resolvable citation passes", () => {
  assertChunkCitationsResolvable("The value rises (chunk 3).", {
    allowedChunkIds: CHUNK_IDS,
    totalChunks: CHUNKS.length,
  });
});

test("a substantive paragraph with no citation is refused and quoted back", () => {
  const note =
    "# Paper\n\nThe reconstruction resolved the spatial occupancy of both variants and confirmed " +
    "that their boundaries meet along a single crystallographic direction throughout the volume.\n";
  assert.throws(
    () => assertBlockCitations(note),
    (error) => /without naming a chunk/.test(error.message),
  );
});

test("a substantive CHINESE paragraph with no citation is refused too", () => {
  // 79 characters, three findings, no chunk number - and comfortably under the
  // 120 the English threshold asks for, because Chinese states a finding in a
  // third of the characters. This is the shape that used to pass.
  const note = [
    "# 论文",
    "",
    "重构结果给出了两种变体的空间占位关系，并确认其界面在整个体积内沿同一晶体学方向相交。该结论在三个样品上重复出现。",
    "",
  ].join("\n");
  assert.throws(
    () => assertBlockCitations(note),
    (error) => /without naming a chunk/.test(error.message),
  );
});

/**
 * The 一句話 slot, in the words that actually hit this rule.
 *
 * The template gave the plain-language summary a slot of its own and did not
 * say it had to cite anything, which made the refusal look random: 40
 * characters slipped under the Chinese threshold and passed, 58 did not. The
 * rule is right - a block generalising across a batch is exactly what it
 * exists to tether - so the answer is the batch range, and the guidance now
 * says so.
 */
test("a batch summary is refused uncited and accepted with its range", () => {
  const summary =
    "介绍了高强变形铝合金挤压铸造加压凝固的研究背景，概述了压力对组织细化、共晶相抑制和性能提升的总体效果及现有研究不足。";
  assert.throws(
    () => assertBlockCitations(`**一句话**\n\n${summary}\n`),
    (error) =>
      /without naming a chunk/.test(error.message) &&
      /chunk 0-7/.test(error.message),
    "and the refusal has to say that a range is the right answer here",
  );
  assertBlockCitations(`**一句话**\n\n${summary}（chunk 0-7）\n`);
});

test("a short Chinese connective line is still left alone", () => {
  assertBlockCitations(
    ["# 论文", "", "两个问题制约着它：", "", "- 第一个（chunk 3）", ""].join("\n"),
  );
});

test("a short connective line without a citation is left alone", () => {
  assertBlockCitations("# Paper\n\nTwo issues constrain this:\n\n- the first one (chunk 3)\n");
});

test("a heading is never asked for a citation, since a heading naming one is refused elsewhere", () => {
  assertBlockCitations(
    "## A heading long enough to pass the length threshold if it were prose at all, and then some more\n\n" +
      "- a finding (chunk 1)\n",
  );
});

// --- 6. Evidence diagnostics ---------------------------------------------

section("Telling a model why its Evidence excerpt failed");

test("the divergence point is named when the excerpt is nearly right", () => {
  // The chunk renders an inline-maths delimiter the excerpt omitted: the real
  // case, reduced to its mechanism.
  const chunks = [
    {
      chunkId: 4,
      text:
        "the convergent beam illumination in STEM effectively weakens the dynamical diffraction " +
        "contrast $[51-68]$ . Thus, STEM is becoming a standard imaging mode.",
    },
  ];
  const message = describeEvidenceMismatch({
    itemKey: "AAAA1111",
    excerpt:
      "the convergent beam illumination in STEM effectively weakens the dynamical diffraction contrast [51-68]. Thus,",
    chunkIdSnapshot: 4,
    chunks,
    context: "actions[2] ADD_CLAIM, claim \"STEM weakens dynamical contrast\", evidence[0]",
  });
  assert.ok(/actions\[2\] ADD_CLAIM/.test(message), message);
  assert.ok(/chunkIdSnapshot 4: exists, and does NOT contain/.test(message), message);
  assert.ok(/Whole-document fallback: not found/.test(message), message);
  assert.ok(/The first \d+ character\(s\) match/.test(message), message);
  assert.ok(/the excerpt continues/.test(message), message);
});

test("a right excerpt under a wrong chunkIdSnapshot is told exactly where it really is", () => {
  const message = describeEvidenceMismatch({
    itemKey: "AAAA1111",
    excerpt: "This full rotation combined with needle-shaped specimen preparation can be a solution",
    chunkIdSnapshot: 0,
    chunks: CHUNKS,
  });
  assert.ok(/FOUND in chunk 3/.test(message), message);
  assert.ok(/chunkIdSnapshot 0: exists, and does NOT contain/.test(message), message);
});

test("a chunkIdSnapshot outside the document says so, with the real range", () => {
  const message = describeEvidenceMismatch({
    itemKey: "AAAA1111",
    excerpt: "nothing like this appears anywhere in the indexed text of the document",
    chunkIdSnapshot: 900,
    chunks: CHUNKS,
  });
  assert.ok(/NOT an indexed chunk/.test(message), message);
  assert.ok(/numbered 0 to 8/.test(message), message);
});

test("an excerpt sharing nothing with the paper is told to re-read, not to guess", () => {
  const message = describeEvidenceMismatch({
    itemKey: "AAAA1111",
    excerpt: "Quantum entanglement of the observer collapses the tomographic wavefunction entirely.",
    chunkIdSnapshot: null,
    chunks: CHUNKS,
  });
  assert.ok(/written from the reading note/.test(message), message);
  assert.ok(/not supplied/.test(message), message);
});

test("verification is never relaxed, and the message says so", () => {
  const message = describeEvidenceMismatch({
    itemKey: "AAAA1111",
    excerpt: "anything at all",
    chunkIdSnapshot: 1,
    chunks: CHUNKS,
  });
  assert.ok(/verbatim by design and is not relaxed/.test(message), message);
});

test("Chinese splits into sentences, so two facts are not read as one", () => {
  // Chinese puts no space after a full stop, and the whitespace rule was
  // applied to the full-width marks too - so a whole paragraph came back as
  // ONE sentence citing every chunk in it, and was refused as a fusion of
  // chunks the note had never fused.
  const body =
    "该方法完全消除了缺失楔形伪影（chunk 12）。样品制备仍然困难（chunk 13）。";
  const sentences = splitSentences(body);
  assert.equal(sentences.length, 2, JSON.stringify(sentences));

  const chunks = [
    { chunkId: 12, text: "该方法可能有助于减弱缺失楔形伪影。" },
    { chunkId: 13, text: "针状样品制备较为困难。" },
  ];
  const flagged = auditSynthesis(body, { chunks });
  assert.equal(flagged.length, 1, JSON.stringify(flagged));
  assert.deepEqual(flagged[0].citedChunks, [12], "one sentence, one chunk");
  assert.ok(
    flagged[0].reasons.includes("absolute-language"),
    "完全消除 is still caught",
  );
  assert.ok(
    !flagged[0].reasons.includes("multi-chunk-fusion"),
    "nothing was fused; the splitter just could not see the boundary",
  );
});

test("a short Chinese absolute is audited, exactly as its English twin is", () => {
  // The same claim, in two languages, against the same hedged source. The
  // floor used to be one character count for both, so English reached it and
  // Chinese - which says the same thing in a third of the characters - did
  // not: the drift this module names first was caught in one language and
  // waved through in the other.
  const chunks = [
    { chunkId: 12, text: "该方法可能有助于减弱缺失楔形伪影。" },
  ];
  const zh = auditSynthesis("完全消除伪影（chunk 12）。", { chunks });
  assert.equal(zh.length, 1, JSON.stringify(zh));
  assert.ok(zh[0].reasons.includes("absolute-language"), JSON.stringify(zh));

  const english = auditSynthesis(
    "Completely eliminates the artifact (chunk 12).",
    { chunks: [{ chunkId: 12, text: "The method may help to weaken it." }] },
  );
  assert.equal(english.length, 1, JSON.stringify(english));
});

test("a genuinely trivial fragment is still not audited, in either script", () => {
  const chunks = [{ chunkId: 1, text: "irrelevant" }];
  assert.equal(auditSynthesis("见图3。", { chunks }).length, 0);
  assert.equal(auditSynthesis("See figure 3.", { chunks }).length, 0);
});

test("a closing bracket after a full-width stop stays with its sentence", () => {
  assert.deepEqual(splitSentences("第一句。”第二句。"), ["第一句。”", "第二句。"]);
});

test("an English decimal point is still not a sentence boundary", () => {
  assert.deepEqual(
    splitSentences("The alloy is Ni-19.5 at.% Mo. It was homogenised."),
    ["The alloy is Ni-19.5 at.% Mo.", "It was homogenised."],
  );
});

test("a truncated flag list does not excuse the sentences it left out", () => {
  // More flagged sentences than one refusal can carry. The tail used to read
  // "... and N more sentence(s) in the same shape.", which invites a model to
  // answer the listed ones and resubmit - and verifySynthesisAudit then
  // demands every one of the others, including the ones it was never shown.
  const flagged = Array.from({ length: 50 }, (_, i) => ({
    sentence: `Sentence number ${i} eliminates the artifact entirely.`,
    citedChunks: [i],
    reasons: ["absolute-language"],
    details: ['states "eliminates"'],
  }));
  const message = describeFlaggedSentences(flagged);
  assert.ok(/\.\.\. and 10 more sentence/u.test(message), message);
  assert.ok(/NOT excused/u.test(message), message);
  assert.ok(/named individually when you resubmit/u.test(message), message);
  assert.ok(
    !/more sentence\(s\) in the same shape\./u.test(message),
    "the dismissive wording must be gone",
  );
});

test("the prefix search finds the exact divergence offset", () => {
  const found = longestMatchingPrefix("abcdefXghij", "abcdefYghij");
  assert.equal(found.length, 6);
  assert.equal(found.index, 0);
});

// --- Result ---------------------------------------------------------------

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
