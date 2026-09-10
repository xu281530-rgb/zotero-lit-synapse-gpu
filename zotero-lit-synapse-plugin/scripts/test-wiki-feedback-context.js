import assert from "node:assert/strict";
import { register } from "node:module";
register("./ts-ext-hooks.mjs", import.meta.url);
globalThis.Zotero = { Prefs: { get() {} } };
globalThis.ztoolkit = { log() {} };
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { findWikiSourceQuote, canonicalWikiSourceText, wikiSourceTextView } =
  await import("../src/modules/wiki/wikiSourceText.ts");
const { auditSynthesis, verifySynthesisAudit } = await import(
  "../src/modules/wiki/wikiSynthesisAudit.ts"
);
const { boundPreparedContext, pagePreparedContext } = await import(
  "../src/modules/wiki/wikiPreparedContext.ts"
);
const { isUsableLexicalTerm } = await import(
  "../src/modules/wiki/wikiLexicalSignals.ts"
);
const record =
  "This record retains the exact experimental conditions and observations. ".repeat(
    1600,
  );
const source =
  "The nozzle diameter was 2.0\\mathrm{\\;{mm}} under the stated experimental conditions.";
const quote =
  "The nozzle diameter was 2.0 mm under the stated experimental conditions.";
const claim = {
  claimId: 2,
  pageId: 1,
  claimText: "A previous paper's related result.",
  version: 3,
  evidence: [{ evidenceId: 1, itemKey: "OTHER", excerpt: source }],
};
const store = {
  crossPaperReviews: async () => ({ relations: async () => [] }),
  getClaim: async () => claim,
  listClaimsByEvidenceSource: async () => [claim],
};
const service = new WikiService(store);
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}
await test("known unit formatting maps back to the raw indexed quotation", () => {
  assert.equal(canonicalWikiSourceText(source), quote);
  assert.equal(findWikiSourceQuote(source, quote).excerpt, source);
  assert.equal(findWikiSourceQuote(source, quote.replace("2.0", "3.0")), null);
  assert.equal(
    findWikiSourceQuote("The formula is x^2 + y.", "The formula is x2 + y."),
    null,
  );
  assert.equal(
    findWikiSourceQuote(
      "The formula is x2 + y.",
      "The formula is x\u00B2 + y.",
    ),
    null,
  );
  assert.equal(
    findWikiSourceQuote("The formula is x_1 - y.", "The formula is x_1 + y."),
    null,
  );
});
await test("audit accepts typographic unit equivalents while still checking the source", () => {
  const flags = [
    {
      auditId: "audit-test",
      sentence: "The specified comparison requires clarification.",
      citedChunks: [1],
      reasons: ["relation-word"],
      details: [],
    },
  ];
  assert.deepEqual(
    verifySynthesisAudit(
      flags,
      [{ auditId: "audit-test", support: [{ chunkId: 1, quote }] }],
      [{ chunkId: 1, text: source }],
    ),
    [],
  );
});
await test("a sentence proved once in a reading is not asked for again", () => {
  // The cost this removes: one unproved sentence failed the WHOLE submission,
  // and the next response listed every sentence again - including the ones that
  // had just verified - so each round trip had to resend every quotation. Two
  // batches of one paper took five to seven rounds of that.
  const chunks = [
    {
      chunkId: 1,
      text: "The interleaved core path ensures a reliable bond between adjacent honeycomb cells under the tested conditions.",
    },
    {
      chunkId: 2,
      text: "The measured compressive modulus increases with the number of interlacing points in every specimen group.",
    },
  ];
  const proved = {
    sentence: "The interleaved path eliminates debonding between adjacent cells (chunk 1).",
    support: [
      {
        chunkId: 1,
        quote: "The interleaved core path ensures a reliable bond between adjacent honeycomb cells",
      },
    ],
  };
  const later = {
    sentence: "The modulus increases by 67 percent across the groups (chunk 2).",
    support: [
      {
        chunkId: 2,
        quote: "The measured compressive modulus increases with the number of interlacing points",
      },
    ],
  };
  const record = `${proved.sentence}\n\n${later.sentence}\n`;
  const call = (audit, scope) =>
    service.assertReadingRecordAudited(record, chunks, new Set([1, 2]), false, audit, scope);

  // Round one proves the first sentence and leaves the second open. It still
  // fails - nothing is written - but the proof is banked.
  let first;
  try {
    call([proved], "session-7");
  } catch (error) {
    first = error;
  }
  assert.ok(first, "the unproved sentence still fails the whole submission");
  assert.match(first.message, /does not close/);
  assert.ok(/67 percent/.test(first.message), first.message);
  assert.ok(!/eliminates debonding/.test(first.message), "the proved one is gone from the list");

  // Round two answers only what was still open, and closes.
  call([later], "session-7");

  // A different reading has its own bank and still has to prove both.
  assert.throws(() => call([later], "session-8"), /eliminates debonding/);
  // And with no scope at all the check is exactly as stateless as it was.
  assert.throws(() => call([later], undefined), /eliminates debonding/);
});
await test("faithful source wording is not stopped by its own absolute words", () => {
  const text =
    "This configuration cannot provide identical responses under these experimental conditions.";
  assert.deepEqual(
    auditSynthesis(`${text.slice(0, -1)} (chunk 1).`, {
      chunks: [{ chunkId: 1, text }],
    }),
    [],
  );
});
await test("compact prepare preserves candidates and pages every reading-record character", async () => {
  service.prepareTokens.set("context-token", {
    libraryID: 1,
    expiresAt: Date.now() + 60000,
    preparedPageTitles: new Set(),
  });
  const signals = Array.from({ length: 18 }, (_, i) => ({
    signalId: i + 1,
    signalType: "semantic",
    mustResolve: true,
    thisChunk: { chunkId: i, excerpt: "A source passage.", read: true },
    otherChunk: {
      chunkId: i,
      excerpt: "The other source passage.",
      read: true,
    },
  }));
  const result = await service.presentPreparedContext(
    {
      prepareToken: "context-token",
      pages: [],
      claims: [],
      semanticClaims: [claim],
      pagePreparations: [],
      wikiSkeleton: {
        pages: Array.from({ length: 120 }, (_, i) => ({
          pageId: i + 1,
          canonicalTitle: `Topic ${i}`,
        })),
      },
      wikiReconciliation: {
        readingRecords: [{ recordNumber: 1, chunkIds: [1], content: record }],
        claims: [],
      },
      pendingLinkSignals: [
        {
          linkId: 1,
          otherItemKey: "OTHER",
          otherTitle: "Other paper",
          signals,
          suggestedLabels: [],
        },
      ],
    },
    { libraryID: 1 },
  );
  assert.equal(Object.keys(result)[0], "prepareToken");
  assert.ok(JSON.stringify(result).length < 20000);
  assert.equal(result.wikiReconciliation.readingRecords, undefined);
  assert.equal(result.crossPaperCandidates[0].claimId, 2);
  assert.equal(result.reviewTasks.mandatorySignalIds.length, 18);
  assert.equal(result.pendingLinkSignals.length, 10);
  assert.equal(result.context.sections.pages, 120);
  let offset = 0;
  let rebuilt = "";
  do {
    const page = service.getPreparedContext({
      libraryID: 1,
      prepareToken: "context-token",
      section: "readingRecords",
      offset,
    });
    assert.ok(JSON.stringify(page).length < 22000);
    rebuilt += page.items.map((entry) => entry.content).join("");
    offset = page.pagination.nextOffset;
  } while (offset !== null);
  assert.equal(rebuilt, record);
  assert.throws(
    () =>
      service.getPreparedContext({
        libraryID: 2,
        prepareToken: "context-token",
        section: "pages",
      }),
    /unavailable/,
  );
  service.prepareTokens.get("context-token").expiresAt = 0;
  assert.throws(
    () =>
      service.getPreparedContext({
        libraryID: 1,
        prepareToken: "context-token",
        section: "pages",
      }),
    /expired/,
  );
});
await test("a compact duplicate candidate carries its probe and its matches", async () => {
  service.prepareTokens.set("dup-token", {
    libraryID: 1,
    expiresAt: Date.now() + 60000,
    preparedPageTitles: new Set(),
  });
  const matches = [
    { conceptId: 30, name: "核心交错对齐打印方法", score: 0.81412, matchedBy: "vector", sourceDocuments: 1, sourcedFromThisPaper: true },
    { conceptId: 31, name: "有效粘接长度", score: 0.69631, matchedBy: "vector", sourceDocuments: 1, sourcedFromThisPaper: true },
    { conceptId: 22, name: "连续曲线纤维铺放", score: 0.61612, matchedBy: "vector", sourceDocuments: 3, sourcedFromThisPaper: false },
  ];
  const result = await service.presentPreparedContext(
    {
      prepareToken: "dup-token",
      pages: [],
      claims: [],
      semanticClaims: [],
      pagePreparations: [],
      wikiSkeleton: {
        pages: [],
        duplicateCandidates: [{ probe: "交错对齐打印路径策略", matches }],
        nearbyConcepts: [
          { conceptId: 12, name: "连续纤维增材制造", description: "A field term." },
        ],
      },
      pendingLinkSignals: [],
    },
    { libraryID: 1, compact: true },
  );
  const [candidate] = result.wikiSkeleton.duplicateCandidates;
  // The bug: the concept mapper read canonicalName/name/description off a
  // {probe, matches} record and emptied every one of them.
  assert.equal(candidate.probe, "交错对齐打印路径策略");
  assert.equal(candidate.matchCount, 3);
  assert.equal(candidate.matches[0].name, "核心交错对齐打印方法");
  assert.equal(candidate.matches[0].conceptId, 30);
  assert.equal(candidate.matches[0].score, 0.8141);
  assert.equal(candidate.matches[2].sourcedFromThisPaper, false);
  assert.equal(candidate.canonicalName, undefined);
  // Concepts of a real shape still compact the way they always did.
  assert.equal(result.wikiSkeleton.nearbyConcepts[0].name, "连续纤维增材制造");
  // And the section the pointer names holds concepts, not the wrapper record.
  const paged = service.getPreparedContext({
    libraryID: 1,
    prepareToken: "dup-token",
    section: "concepts",
  });
  assert.deepEqual(
    paged.items.map((entry) => entry.conceptId).sort((a, b) => a - b),
    [12, 22, 30, 31],
  );
});
await test("reading-note pagination rejects mixed versions and reconstructs the full note", async () => {
  const first = await service.readingMarkdownPage(record, {});
  assert.equal(first.markdown.length, 12000);
  let output = first.markdown;
  let offset = first.markdownPagination.nextOffset;
  while (offset !== null) {
    const page = await service.readingMarkdownPage(record, {
      markdownOffset: offset,
      expectedBodyHash: first.markdownPagination.bodyHash,
    });
    output += page.markdown;
    offset = page.markdownPagination.nextOffset;
  }
  assert.equal(output, record);
  await assert.rejects(
    service.readingMarkdownPage(`${record} changed`, {
      markdownOffset: 12000,
      expectedBodyHash: first.markdownPagination.bodyHash,
    }),
    /changed/,
  );
});
await test("source views retain raw text and mark missing table layout", async () => {
  const raw = "Table 3 1 2 3 4 5 6 7 8 9 10 \uFFFD";
  const view = await wikiSourceTextView(raw);
  assert.equal(view.rawText, raw);
  assert.ok(view.qualityIssues.includes("table_layout_unavailable"));
  assert.ok(view.qualityIssues.includes("replacement_characters"));
});
await test("large nested signals can be paged and reconstructed without dropping passages", () => {
  const signal = {
    signalId: 71,
    mustResolve: true,
    thisChunk: { excerpt: record },
    otherChunk: { excerpt: record },
  };
  const context = boundPreparedContext({
    pages: [],
    claims: [],
    evidence: [],
    readingRecords: [],
    linkSignals: [signal],
    concepts: [],
    relations: [],
  });
  let offset = 0;
  let json = "";
  do {
    const page = pagePreparedContext(context, "linkSignals", offset);
    assert.ok(JSON.stringify(page).length < 22000);
    json += page.items.map((part) => part.text).join("");
    offset = page.pagination.nextOffset;
  } while (offset !== null);
  assert.deepEqual(JSON.parse(json), signal);
});
await test("lexical labels exclude bare prose while retaining specific scientific terms", () => {
  for (const value of ["ambiguity", "arises", "black", "mmmin"])
    assert.equal(isUsableLexicalTerm(value), false, value);
  for (const value of [
    "MCSAF",
    "2-RoSy",
    "black phosphorus",
    "ti6al4v",
    "dislocation",
  ])
    assert.equal(isUsableLexicalTerm(value), true, value);
});
/*
 * The prepare token is an IDLE timer, and the work it gates is long.
 *
 * It used to be renewed by exactly one tool, wiki_get_prepared_context, while
 * the workflow it belongs to spends its time elsewhere entirely — reading the
 * paper, recording concepts, reviewing cross-paper links. A caller who
 * followed the prescribed order found the token dead at the one moment it is
 * needed, at wiki_commit, and lost the prepared page titles it had drafted
 * against. These tests pin both halves of the answer: using a token renews it,
 * and the map of live tokens is bounded so that a longer window cannot turn
 * into an unbounded pile of prepared context.
 */
await test("using a prepare token renews it, and a lapsed one is refused", async () => {
  const { WIKI_PREPARE_IDLE_SECONDS, WIKI_PREPARE_MAX_TOKENS } = await import(
    "../src/modules/wiki/wikiPreparedContext.ts"
  );
  assert.ok(
    WIKI_PREPARE_IDLE_SECONDS >= 1800,
    "the window has to outlast reading a paper, not just skimming one",
  );

  const scoped = new WikiService(store);
  scoped.prepareTokens.set("idle-token", {
    libraryID: 1,
    // Nearly lapsed: a renewal on use is the only thing that can save it.
    expiresAt: Date.now() + 50,
    preparedPageTitles: new Set(),
    context: { pages: [], claims: [] },
  });

  const before = scoped.prepareTokens.get("idle-token").expiresAt;
  scoped.getPreparedContext({
    libraryID: 1,
    prepareToken: "idle-token",
    section: "pages",
  });
  const afterPaging = scoped.prepareTokens.get("idle-token").expiresAt;
  assert.ok(afterPaging > before, "a successful read must restart the clock");

  // The commit path reads the token too, and must renew it the same way.
  scoped.prepareTokens.get("idle-token").expiresAt = Date.now() + 50;
  assert.ok(scoped.touchPrepareToken("idle-token"), "a live token resolves");
  assert.ok(
    scoped.prepareTokens.get("idle-token").expiresAt > Date.now() + 1000,
    "the commit path renews the token it uses",
  );

  scoped.prepareTokens.get("idle-token").expiresAt = 0;
  assert.equal(
    scoped.touchPrepareToken("idle-token"),
    undefined,
    "a genuinely idle token is refused",
  );
  assert.equal(
    scoped.prepareTokens.has("idle-token"),
    false,
    "and dropped rather than left to accumulate",
  );

  // A longer window is only affordable with a bound on how many are held.
  const many = new WikiService(store);
  for (let i = 0; i < WIKI_PREPARE_MAX_TOKENS + 8; i += 1) {
    many.prepareTokens.set(`token-${i}`, {
      libraryID: 1,
      expiresAt: Date.now() + WIKI_PREPARE_IDLE_SECONDS * 1000,
      preparedPageTitles: new Set(),
    });
    many.prunePrepareTokens();
  }
  assert.equal(
    many.prepareTokens.size,
    WIKI_PREPARE_MAX_TOKENS,
    "live prepare tokens are capped",
  );
  assert.ok(
    many.prepareTokens.has(`token-${WIKI_PREPARE_MAX_TOKENS + 7}`),
    "the most recent token survives; the least recently used goes first",
  );
});

process.exitCode = failed ? 1 : 0;
