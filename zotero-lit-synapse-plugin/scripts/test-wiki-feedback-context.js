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
process.exitCode = failed ? 1 : 0;
