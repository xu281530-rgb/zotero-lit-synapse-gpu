import assert from "node:assert/strict";
import { register } from "node:module";
import Ajv from "ajv";
register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Prefs: { get() {} } };
globalThis.ztoolkit = { log() {} };
const citations = await import("../src/modules/wiki/wikiCitations.ts");
const audit = await import("../src/modules/wiki/wikiSynthesisAudit.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const {
  buildToolCatalog,
  projectToolsForList,
  renderToolDoctrine,
  toolDoctrineUri,
} = await import("../src/modules/toolCatalog.ts");
const {
  WIKI_CONTEXT_SECTIONS,
  WIKI_PREPARE_IDLE_SECONDS,
  boundPreparedContext,
  fragmentContextText,
  pagePreparedContext,
} = await import("../src/modules/wiki/wikiPreparedContext.ts");
/** The idle window in milliseconds, read from the source of truth. */
const IDLE_MS = WIKI_PREPARE_IDLE_SECONDS * 1000;
let failed = 0;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

await test("commit exposes required fields for each action", () => {
  const schema = buildToolCatalog().find(
    (t) => t.name === "wiki_commit",
  ).inputSchema;
  const variants = schema.properties.actions.items.oneOf;
  assert.ok(variants?.length >= 9);
  const add = variants.find((v) => v.properties.action.const === "ADD_CLAIM");
  for (const name of [
    "pageId",
    "claimText",
    "claimType",
    "epistemicStatus",
    "coverageLevel",
    "evidence",
  ])
    assert.ok(add.required.includes(name), name);
  assert.ok(
    schema.properties.deferMissingTargets.items.required.includes(
      "expectedRevision",
    ),
  );
  const outcomes =
    schema.properties.crossPaperReview.items.properties.outcomes.items;
  assert.ok(
    outcomes.oneOf
      .find((v) => v.properties.outcome.const === "compares_with")
      .required.includes("relation"),
  );
});
await test("the public commit contract validates its example and rejects incomplete actions", () => {
  const tools = buildToolCatalog();
  const tool = tools.find((t) => t.name === "wiki_commit");
  const schema = tool.inputSchema;
  const example = tool.examples[0];
  const validator = new Ajv({ allErrors: true }).compile(schema);
  assert.ok(validator(example), JSON.stringify(validator.errors));
  assert.ok(!validator({ actions: [{ action: "ADD_CLAIM" }] }));
  assert.ok(
    !validator({
      actions: [{ action: "ATTACH_EVIDENCE", claimId: 0, evidence: [] }],
    }),
  );
  assert.ok(
    validator({
      actions: [],
      deferMissingTargets: [{ taskId: 1, expectedRevision: "r1" }],
    }),
  );
  assert.ok(!validator({ actions: [], deferMissingTargets: [{ taskId: 1 }] }));
  assert.ok(
    validator({
      actions: [
        {
          action: "UPDATE_CLAIM",
          claimId: 1,
          expectedVersion: 2,
          coverageLevel: "partial",
          evidence: [],
        },
      ],
    }),
  );
  const bad = structuredClone(example);
  delete bad.crossPaperReview[0].outcomes[0].relation;
  assert.ok(!validator(bad));
  assert.ok(
    renderToolDoctrine(tools, toolDoctrineUri("wiki_commit")).includes(
      JSON.stringify(example, null, 2),
    ),
  );
  assert.ok(
    !JSON.stringify(projectToolsForList(tools)).includes(example.operationId),
  );
});

await test("colon citations share the range and list grammar", () => {
  assert.deepEqual(
    citations.citedWikiChunkIds("[chunk:110] (chunks: 2-4, 7)"),
    [2, 3, 4, 7, 110],
  );
  assert.throws(() => citations.parseWikiCitations("[chunk:4-2]"), /range/i);
});
await test("malformed explicit citations retain raw text and offsets", () => {
  assert.deepEqual(
    citations.invalidWikiCitations("(chunk 7, chunk 8) (chunk 2 and chunk 3)"),
    [],
  );
  const text = "Observation [chunk:unknown].";
  const issues = citations.invalidWikiCitations(text);
  assert.equal(issues[0].raw, "[chunk:unknown]");
  assert.equal(text.slice(issues[0].start, issues[0].end), issues[0].raw);
});
await test("a citation bracket may carry the writer's own words", () => {
  // Refused on the first attempt for a shape nobody had been warned about, and
  // for no reason: every address in it parses.
  const aside = "（chunk 43，呼应第一批记录中 chunk 2 的存疑）";
  assert.deepEqual(citations.invalidWikiCitations(aside), []);
  assert.deepEqual(citations.citedWikiChunkIds(aside), [2, 43]);
  assert.deepEqual(
    citations.invalidWikiCitations("(chunk 12, see also Figure 4)"),
    [],
  );
  // A bracket that announces an address and gives none is still refused.
  assert.equal(citations.invalidWikiCitations("(chunk twelve)").length, 1);
  assert.equal(citations.invalidWikiCitations("(chunk )").length, 1);
});
await test("post-sentence citations stay with their statement", () => {
  assert.deepEqual(
    audit.splitSentences(
      "First observation was recorded. (chunk 1) Second observation was recorded. [chunk:2]",
    ),
    [
      "First observation was recorded. (chunk 1)",
      "Second observation was recorded. [chunk:2]",
    ],
  );
  assert.deepEqual(
    audit.splitSentences("第一项观察。（chunk 1）第二项观察。（chunk 2）"),
    ["第一项观察。（chunk 1）", "第二项观察。（chunk 2）"],
  );
  assert.deepEqual(
    audit.splitSentences(
      "(chunk 1) First observation. (chunk 2) Second observation.",
    ),
    ["(chunk 1) First observation.", "(chunk 2) Second observation."],
  );
});
await test("consecutive trailing citations stay together without crossing paragraphs", () => {
  assert.deepEqual(
    audit.splitSentences(
      "First observation. (chunk 1) [chunk:2] Second observation. (chunk 3)",
    ),
    ["First observation. (chunk 1) [chunk:2]", "Second observation. (chunk 3)"],
  );
  assert.deepEqual(
    audit.splitSentences("First observation.\n\n(chunk 2) Second observation."),
    ["First observation.", "(chunk 2) Second observation."],
  );
});
await test("equation numbers are not counted as list entries", () => {
  const source =
    "The controller applies the update in Eq. (17) to the measured state. The reward is specified in Eq. (18).";
  const flags = audit.auditSynthesis(
    "The measured state is updated using Eq. (17) (chunk 4).",
    { chunks: [{ chunkId: 4, text: source }] },
  );
  assert.ok(!flags.some((f) => f.reasons.includes("enumeration-shortened")));
  assert.equal(
    audit.enumerationDepth(
      "(i) the treatment; (ii) the comparison; (iii) the control",
    ),
    3,
  );
  assert.equal(audit.enumerationDepth("(1) training; (2) testing"), 2);
});
await test("equation filtering preserves unspaced Chinese list markers", () => {
  assert.equal(audit.enumerationDepth("(1)训练；(2)测试"), 2);
  assert.equal(audit.enumerationDepth("(i)训练；(ii)测试"), 2);
  assert.equal(
    audit.enumerationDepth(
      "The update is $x=y$ (17)\nThe next step records the state.",
    ),
    0,
  );
  assert.equal(
    audit.enumerationDepth(
      "The update is \\[x=y\\] (17)\nThe next step records the state.",
    ),
    0,
  );
});
await test("stale audit responses have an explicit machine-readable disposition", () => {
  const problems = audit.verifySynthesisAudit(
    [],
    [{ auditId: "obsolete", support: [] }],
    [],
  );
  assert.equal(problems[0].code, "STALE_AUDIT");
});

const longClaims = Array.from({ length: 10 }, (_, i) => ({
  claimId: i + 1,
  pageId: 1,
  claimText: "A reusable result with conditions and limitations. ".repeat(60),
  version: 1,
  evidence: [],
  evidenceOverview: { explanation: "Evidence details. ".repeat(400) },
  claimRelations: [],
}));
const service = new WikiService({
  getClaim: async (id) => longClaims.find((c) => c.claimId === id),
  crossPaperReviews: async () => ({ relations: async () => [] }),
});
await test("record validation returns independent citation, section and prose issues together", () => {
  const record =
    "**阅读总结**\nA short summary.\n\n**方法**\n- The sensor was calibrated under the reported conditions.\n\n**结果与结论**\nThe calibrated sensor recorded the expected response.";
  assert.throws(
    () =>
      service.assertReadingRecordValid(record, {
        fulltext: true,
        recordChunkIds: [0],
        allowedChunkIds: [0],
        totalChunks: 1,
        batchChunks: [
          {
            chunkId: 0,
            text: "The sensor was calibrated under the reported conditions.",
          },
        ],
        readable: [],
        currentChunkAddresses: new Set([0]),
        explicitRecord: true,
        audit: [],
      }),
    (error) => {
      const issues = error.details.validationIssues;
      for (const code of [
        "CHUNK_CITATIONS",
        "RECORD_TEMPLATE",
        "CONNECTED_PROSE",
      ])
        assert.ok(
          issues.some((i) => i.code === code),
          code,
        );
      assert.ok(issues.every((i) => i.path === "/readingRecord"));
      assert.ok(issues.some((i) => i.section === "方法"));
      assert.equal(error.details.requiredSections.length, 6);
      return true;
    },
  );
});
await test("compact prepare stays bounded while full claims remain recoverable", async () => {
  service.prepareTokens.set("large", {
    libraryID: 1,
    expiresAt: Date.now() + IDLE_MS,
    preparedPageTitles: new Set(),
  });
  const result = await service.presentPreparedContext(
    {
      prepareToken: "large",
      pages: [],
      claims: longClaims,
      semanticClaims: longClaims,
      pagePreparations: [],
      wikiSkeleton: { pages: [] },
      crossPaperTasks: [],
    },
    { libraryID: 1, compact: true },
  );
  assert.ok(
    JSON.stringify(result).length < 20000,
    `received ${JSON.stringify(result).length} characters`,
  );
  assert.ok(Array.isArray(result.recalledPages));
  const parts = [];
  let offset = 0;
  do {
    const page = service.getPreparedContext({
      libraryID: 1,
      prepareToken: "large",
      section: "claims",
      offset,
    });
    parts.push(...page.items);
    offset = page.pagination.nextOffset;
  } while (offset !== null);
  assert.equal(parts[0].claimText, longClaims[0].claimText);
});
await test("successful reads renew the idle timeout; invalid reads do not", () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const context = Object.fromEntries(
      WIKI_CONTEXT_SECTIONS.map((s) => [s, []]),
    );
    const token = {
      libraryID: 1,
      expiresAt: now + IDLE_MS,
      preparedPageTitles: new Set(),
      context,
    };
    service.prepareTokens.set("renew", token);
    // Wind almost the whole window away, leaving a tenth of it.
    const remaining = IDLE_MS / 10;
    now += IDLE_MS - remaining;
    assert.throws(() =>
      service.getPreparedContext({
        libraryID: 2,
        prepareToken: "renew",
        section: "claims",
      }),
    );
    assert.equal(token.expiresAt, now + remaining);
    assert.throws(() =>
      service.getPreparedContext({
        libraryID: 1,
        prepareToken: "renew",
        section: "unknown",
      }),
    );
    assert.equal(token.expiresAt, now + remaining);
    service.getPreparedContext({
      libraryID: 1,
      prepareToken: "renew",
      section: "claims",
    });
    now += IDLE_MS - remaining;
    const page = service.getPreparedContext({
      libraryID: 1,
      prepareToken: "renew",
      section: "claims",
    });
    // Read from the constant, never spelled out again: a test that repeats the
    // number it is checking goes stale the moment the number is tuned, and
    // then reports the tuning as a defect.
    assert.equal(page.prepareTokenExpiresInSeconds, WIKI_PREPARE_IDLE_SECONDS);
    now += IDLE_MS + 1;
    assert.throws(
      () =>
        service.getPreparedContext({
          libraryID: 1,
          prepareToken: "renew",
          section: "claims",
        }),
      (e) => e.code === "PREPARED_CONTEXT_EXPIRED",
    );
  } finally {
    Date.now = originalNow;
  }
});
await test("nested and text fragments round-trip through budget-limited pages", () => {
  const originalTask = {
    taskId: 8,
    revision: "r8",
    targets: [{ claimId: 3, detail: 'quote: "A"; line\n'.repeat(3500) }],
  };
  const originalRecord = {
    id: 9,
    content: "Measured response and conditions. ".repeat(1800),
  };
  const context = boundPreparedContext({
    ...Object.fromEntries(WIKI_CONTEXT_SECTIONS.map((s) => [s, []])),
    crossPaperTasks: [originalTask],
    readingRecords: fragmentContextText([originalRecord], "content"),
  });
  const readAll = (section) => {
    const items = [];
    let offset = 0;
    let limited = false;
    do {
      const page = pagePreparedContext(context, section, offset, 50);
      assert.equal(page.pagination.unit, "context_entry");
      assert.equal(page.pagination.requestedLimit, 50);
      assert.equal(page.pagination.returned, page.items.length);
      assert.ok(
        page.items.reduce(
          (chars, row) => chars + JSON.stringify(row).length,
          0,
        ) <= 20000,
      );
      items.push(...page.items);
      limited ||= page.pagination.characterBudgetLimited;
      const next = page.pagination.nextOffset;
      assert.ok(next === null || next > offset);
      offset = next;
    } while (offset !== null);
    assert.ok(limited);
    return items;
  };
  const tasks = readAll("crossPaperTasks");
  assert.ok(tasks.every((t) => t.contextFragment.entryIndex === 0));
  assert.deepEqual(JSON.parse(tasks.map((t) => t.text).join("")), originalTask);
  const records = readAll("readingRecords");
  assert.equal(records.map((r) => r.content).join(""), originalRecord.content);
  assert.equal(records.at(-1).textFragment.hasMore, false);
});

console.log(`general Wiki workflow: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
