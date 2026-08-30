/* eslint-env node */

/**
 * Where a sentence ends, for the chunker and the auditor alike.
 *
 * The case that made this a shared module is real and is quoted verbatim
 * below: a paper in the reference library was indexed with one chunk ending
 * "Meanwhile, Xu et al." and the next opening "(2021) studied that...". The
 * chunker split there because it treated any full stop followed by nothing in
 * particular as a boundary; the reading note's auditor, reading the same
 * prose, did not. A chunk is the unit Evidence is quoted from and the unit a
 * reading record has to account for, so half a citation is a passage nobody
 * can quote or summarise - and the two components disagreeing about it is the
 * kind of defect that only shows up in the index, months later.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

// The chunker logs through ztoolkit and reads preferences through Zotero.Prefs,
// so both have to exist before it is imported. See test-chunking.js.
const prefs = new Map();
globalThis.Zotero = {
  Prefs: {
    get: (key) => prefs.get(key),
    set: (key, value) => prefs.set(key, value),
    clear: (key) => prefs.delete(key),
    has: (key) => prefs.has(key),
  },
  Libraries: { userLibraryID: 1 },
};
globalThis.ztoolkit = { log: () => {} };

const { TextChunker } = await import("../src/modules/semantic/textChunker.ts");
const { splitSentences } = await import(
  "../src/modules/wiki/wikiSynthesisAudit.ts"
);
const { isFalseSentenceEnd, ABBREVIATION } = await import(
  "../src/modules/sentenceBoundary.ts"
);

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`);
    process.exitCode = 1;
  }
};

/** Verbatim from the paper that exposed the split. */
const CITATION_PROSE =
  "In as-cast Al-Zn-Mg-Cu alloys with high Zn content, the non-equilibrium eutectic phases consist of eta(MgZn), Mg (Zn, Cu, Al)2, S(Al2CuMg), theta(Al2Cu) and Fe-IMCs (intermetallic compounds) (Wen et al. , 2017). Meanwhile, Xu et al. (2021) studied that the net-shaped eutectic phases are difficult to transform and dissolve during homogenization and heat treatment.";

check("REAL FAILURE: 'Xu et al. (2021)' is one sentence, not two", () => {
  const sentences = splitSentences(CITATION_PROSE);
  const broken = sentences.filter((sentence) => /et\s+al\.$/u.test(sentence.trim()));
  assert.deepEqual(broken, [], `split inside a citation: ${JSON.stringify(sentences)}`);
  assert.ok(
    sentences.some((sentence) => /Xu et al\. \(2021\) studied/u.test(sentence)),
    `the author and the finding stay together: ${JSON.stringify(sentences)}`,
  );
});

/** The chunker takes its size budget from preferences, not the constructor. */
const PREFIX = "extensions.zotero.zotero-mcp-plugin.";
function chunkWith(text, target, tolerance) {
  prefs.set(`${PREFIX}hybrid.chunkTargetChars`, target);
  prefs.set(`${PREFIX}hybrid.chunkAppendToleranceChars`, tolerance);
  try {
    return new TextChunker({ skipReferences: false })
      .chunk(text)
      .map((chunk) => String(chunk).trim());
  } finally {
    prefs.clear();
  }
}

check("and the chunker agrees, which is the whole point", () => {
  // Small budget so the paragraph is split on sentence boundaries rather than
  // emitted whole; the question is WHERE it chooses to break.
  const texts = chunkWith(CITATION_PROSE, 220, 40);
  assert.ok(texts.length > 1, "the fixture has to actually be split to test this");
  for (const text of texts) {
    assert.ok(
      !/et\s+al\.$/u.test(text),
      `a chunk ends mid-citation: ${JSON.stringify(text)}`,
    );
    assert.ok(
      !/^\(\d{4}\)/u.test(text),
      `a chunk opens with an orphaned year: ${JSON.stringify(text)}`,
    );
  }
});

check("a decimal is not a boundary, in either reader", () => {
  const prose =
    "The pressure was raised from 0.1 MPa to 125 MPa. The cooling rate reached 1.91 K/s.";
  assert.equal(splitSentences(prose).length, 2);
  for (const text of chunkWith(prose, 50, 10)) {
    assert.ok(
      !/\d\.$/u.test(text),
      `a chunk ends mid-number: ${JSON.stringify(text)}`,
    );
  }
});

check("the OCR's gapped decimal survives too", () => {
  // MinerU writes "Al-8. 5Zn-2Mg-2Cu" often enough that this is not academic.
  assert.equal(splitSentences("The alloy Al-8. 5Zn-2Mg-2Cu was prepared.").length, 1);
});

check("the abbreviations that matter in a materials paper", () => {
  for (const stop of [
    "as shown in Fig.",
    "see Eq.",
    "reported in Ref.",
    "Ni-19.5 at.",
    "the composition in wt.",
    "compared with e.g.",
    "namely i.e.",
    "Zou et al.",
    "et al.",
  ]) {
    assert.ok(ABBREVIATION.test(stop), `${JSON.stringify(stop)} should not end a sentence`);
  }
});

check("a real sentence still ends", () => {
  assert.equal(isFalseSentenceEnd("The melt was held at 700 C.", " Then it was poured."), false);
  assert.equal(isFalseSentenceEnd("It was hot.", ""), false);
  // A stop with no space after it is inside a token.
  assert.equal(isFalseSentenceEnd("0.", "1 MPa"), true);
});

check("full-width stops are unaffected", () => {
  assert.deepEqual(splitSentences("第一句。第二句。"), ["第一句。", "第二句。"]);
});

console.log(`sentence boundary: ${passed} check(s) passed`);
