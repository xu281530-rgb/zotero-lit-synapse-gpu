/* eslint-env node */

/**
 * Regression tests for the stage-1 candidate projection
 * (src/modules/hybridCandidates.ts).
 *
 * The contract under test is the retrieval funnel's first narrowing: what
 * hybrid_search hands back is a shortlist to triage, not the documents
 * themselves. Abstracts stay in retrieval and out of the response; evidence
 * comes back as a taste, not as content; and every row carries the one thing
 * stage 3 cannot proceed without — the language the document is written in,
 * because single-document keywords have to be in that language.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  HYBRID_EVIDENCE_CHARS,
  HYBRID_EVIDENCE_CHUNKS,
  detectDocumentLanguage,
  projectHybridCandidate,
  truncateEvidence,
} = await import("../src/modules/hybridCandidates.ts");

const LONG_ABSTRACT =
  "We investigate the columnar-to-equiaxed transition in directionally solidified Al-Cu alloys under varying thermal gradients. ".repeat(
    12,
  );

/** A fused match as it looks after both branches and enrichment. */
function fusedMatch(overrides = {}) {
  return {
    itemKey: "HX2ZCV22",
    libraryID: 1,
    title: "In situ investigation of the columnar-to-equiaxed transition",
    creators: "F. Ngomesse, G. Reinhart",
    date: "2021-05-13",
    itemType: "journalArticle",
    publicationTitle: "Acta Materialia",
    DOI: "10.1016/j.actamat.2021.117401",
    relevanceScore: 21.99877899664887,
    keywordCoverage: 0.38461538461538464,
    matchedFields: ["title", "abstractNote", "tags"],
    matchedKeywords: ["directional solidification", "CET"],
    score: 0.9339062114625931,
    normalizedKeywordScore: 0.846146620942638,
    normalizedSemanticScore: 0.7780380946444805,
    rrfScore: 0.03252247488101534,
    keywordRank: 1,
    semanticRank: 2,
    keywordScore: 21.99877899664887,
    semanticScore: 0.7780380946444805,
    matchedChunks: [
      { chunkId: 89, text: "During industrial processes, the CET is governed by the thermal gradient.", score: 0.7780380946444805 },
      { chunkId: 90, text: "Growth rate measurements were performed in microgravity.", score: 0.71 },
      { chunkId: 91, text: "A third chunk that must not travel back.", score: 0.66 },
    ],
    // what enrichHybridResults records instead of the abstract itself
    hasAbstract: true,
    abstractChars: LONG_ABSTRACT.length,
    language: "en",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. THE CORE RULE: no abstract text ever reaches the candidate row.
// ---------------------------------------------------------------------------
{
  // Even if an upstream branch were to attach abstract text, the projection
  // must not carry it: the field is not in the projected shape at all.
  const withAbstract = fusedMatch({ abstract: LONG_ABSTRACT, abstractNote: LONG_ABSTRACT });
  const row = projectHybridCandidate(withAbstract);
  const serialized = JSON.stringify(row);

  assert.equal("abstract" in row, false, "abstract must not be projected");
  assert.equal("abstractNote" in row, false, "abstractNote must not be projected");
  assert.ok(
    !serialized.includes("We investigate the columnar-to-equiaxed transition in directionally"),
    "no abstract text may appear anywhere in the row",
  );

  // Availability is reported, so the caller knows what get_item_abstract offers.
  assert.equal(row.hasAbstract, true);
  assert.equal(row.abstractChars, LONG_ABSTRACT.length);
}

// ---------------------------------------------------------------------------
// 2. What triage actually needs is kept.
// ---------------------------------------------------------------------------
{
  const row = projectHybridCandidate(fusedMatch());
  assert.equal(row.itemKey, "HX2ZCV22");
  assert.equal(row.title, "In situ investigation of the columnar-to-equiaxed transition");
  assert.equal(row.creators, "F. Ngomesse, G. Reinhart");
  assert.equal(row.year, "2021", "a full date must be reduced to a 4-digit year");
  assert.equal(row.itemType, "journalArticle");
  assert.equal(row.publicationTitle, "Acta Materialia");
  assert.equal(row.DOI, "10.1016/j.actamat.2021.117401");
  assert.deepEqual(row.matchedKeywords, ["directional solidification", "CET"]);
  assert.deepEqual(row.matchedFields, ["title", "abstractNote", "tags"]);
  assert.equal(row.score, 0.9339, "score is rounded, not re-fused");
  assert.equal(row.matchedBy, "keyword+semantic");
}

// ---------------------------------------------------------------------------
// 3. Scoring internals are summarised, not shipped.
// ---------------------------------------------------------------------------
{
  const row = projectHybridCandidate(fusedMatch());
  for (const dropped of [
    "normalizedKeywordScore",
    "normalizedSemanticScore",
    "rrfScore",
    "keywordRank",
    "semanticRank",
    "keywordScore",
    "semanticScore",
    "relevanceScore",
    "keywordCoverage",
  ]) {
    assert.equal(dropped in row, false, `${dropped} must not be projected`);
  }

  assert.equal(
    projectHybridCandidate(fusedMatch({ semanticRank: undefined })).matchedBy,
    "keyword",
  );
  assert.equal(
    projectHybridCandidate(fusedMatch({ keywordRank: undefined })).matchedBy,
    "semantic",
  );
}

// ---------------------------------------------------------------------------
// 4. Evidence is a taste, not the document.
// ---------------------------------------------------------------------------
{
  const row = projectHybridCandidate(fusedMatch());
  assert.equal(row.matchedChunks.length, HYBRID_EVIDENCE_CHUNKS);
  assert.equal(row.matchedChunks[0].chunkId, 89, "chunkId survives — context expansion needs it");
  assert.equal(row.matchedChunks[0].score, 0.778);
  assert.ok(
    !JSON.stringify(row).includes("A third chunk that must not travel back"),
    "only the top chunks are returned",
  );

  const long = "定向凝固过程中的柱状晶转变机理研究。".repeat(40);
  const truncated = truncateEvidence(long);
  assert.equal(truncated.length, HYBRID_EVIDENCE_CHARS + 1, "truncation adds one ellipsis char");
  assert.ok(truncated.endsWith("…"));
  assert.equal(truncateEvidence("  already\n\n short  "), "already short");

  // A keyword-only match has no chunks at all: the key is omitted, not empty.
  const noChunks = projectHybridCandidate(fusedMatch({ matchedChunks: undefined }));
  assert.equal("matchedChunks" in noChunks, false);
}

// ---------------------------------------------------------------------------
// 5. Language: what stage-3 keywords must be written in.
// ---------------------------------------------------------------------------
{
  // Zotero's own field wins when it is filled in.
  assert.equal(detectDocumentLanguage("zh-CN", ["Anything at all"]), "zh");
  assert.equal(detectDocumentLanguage("en-US", ["随便什么中文"]), "en");
  assert.equal(detectDocumentLanguage("Chinese", ["x"]), "zh");

  // Otherwise the script mix decides.
  assert.equal(detectDocumentLanguage("", ["Grain refinement in aluminium castings"]), "en");
  assert.equal(detectDocumentLanguage("", ["AF9628超高强度钢热处理工艺优化研究"]), "zh");
  assert.equal(
    detectDocumentLanguage("", ["超高强度钢的强韧化机理 (AKV≥185 J, LUHSBS)"]),
    "zh",
    "incidental Latin inside Chinese text must not flip the verdict",
  );
  assert.equal(
    detectDocumentLanguage("", ["Machine learning for alloy design 机器学习"]),
    "en",
    "an English title with a short Chinese tail stays English",
  );
  assert.equal(detectDocumentLanguage("", ["", ""]), "en", "no signal at all defaults to en");

  // The projection always emits a language, even with nothing enriched.
  const bare = projectHybridCandidate({
    itemKey: "K1",
    title: "钛合金增材制造的组织演变",
    score: 0.7,
    semanticRank: 1,
  });
  assert.equal(bare.language, "zh");
  assert.equal(bare.matchedBy, "semantic");
}

// ---------------------------------------------------------------------------
// 6. The response really is smaller — that is the point of the change.
// ---------------------------------------------------------------------------
{
  const old = [];
  const now = [];
  for (let i = 0; i < 20; i += 1) {
    const match = fusedMatch({ itemKey: `KEY${i}` });
    old.push({ ...match, abstract: LONG_ABSTRACT });
    now.push(projectHybridCandidate(match));
  }
  const before = JSON.stringify(old).length;
  const after = JSON.stringify(now).length;
  // 3x on this fixture, whose abstracts are short and whose chunks are one
  // sentence each; real abstracts and real passages are both far longer, so
  // this is the floor of the saving, not the typical one.
  assert.ok(
    after * 3 < before,
    `a 20-candidate response must shrink at least 3x (was ${before}, now ${after})`,
  );
}

// ---------------------------------------------------------------------------
// A row must say whether the document actually has indexed body text.
// ---------------------------------------------------------------------------
//
// Without this, a paper whose PDF failed to parse produces a row that is
// indistinguishable from a real one: same fused score, same
// matchedBy: "semantic", same matchedChunks — except those chunks ARE its
// title and abstract. Nothing else in the response could tell them apart, so
// the abstract gets quoted as the paper's findings.
{
  const indexed = projectHybridCandidate(
    fusedMatch({ fullText: "indexed" }),
  );
  assert.equal(indexed.fullText, "indexed");
  assert.equal(
    "fullTextNote" in indexed,
    false,
    "a document that has full text needs no warning; a note on every row is noise",
  );

  const broken = projectHybridCandidate(
    fusedMatch({
      fullText: "parse_failed",
      fullTextNote: "NO FULL TEXT: this paper has a PDF/Markdown attachment but it could not be parsed",
    }),
  );
  assert.equal(broken.fullText, "parse_failed");
  assert.match(broken.fullTextNote, /NO FULL TEXT/);

  // The note has to be readable before the snippets it is about.
  const keys = Object.keys(broken);
  assert.ok(
    keys.indexOf("fullTextNote") < keys.indexOf("matchedChunks"),
    "the warning must precede the evidence it qualifies",
  );

  // Evidence still travels: the caller must be able to see WHY it matched,
  // it just must not read it as body text.
  assert.equal(broken.matchedChunks.length, 2);
}

console.log("Hybrid candidate projection regression tests passed");
