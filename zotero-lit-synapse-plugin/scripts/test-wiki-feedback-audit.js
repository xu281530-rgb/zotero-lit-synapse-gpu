import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);
const { buildToolCatalog } = await import("../src/modules/toolCatalog.ts");
const { auditSynthesis, citedChunkIds, splitSentences, verifySynthesisAudit } =
  await import("../src/modules/wiki/wikiSynthesisAudit.ts");
const { assertChunkCitationsResolvable } = await import(
  "../src/modules/wiki/wikiReadingNote.ts"
);
const { expandedCitedChunkIds } = await import(
  "../src/modules/wiki/wikiRecordTemplate.ts"
);

const chunks = [51, 52, 53, 57].map((chunkId) => ({
  chunkId,
  text: "The methods provide identical responses under the specified experimental conditions, as verified by the recorded measurements.",
}));
const sentence =
  "The methods provide identical responses under the specified conditions (chunk 51-53).";
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

test("relation confidence is advertised with its numeric bounds", () => {
  const tool = buildToolCatalog().find((entry) => entry.name === "wiki_commit");
  assert.deepEqual(
    tool.inputSchema.properties.actions.items.properties.confidence,
    {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "Required for LINK_RELATION. Claim confidence is derived from evidence.",
    },
  );
});
test("coverage and audit expand mixed ranges and lists identically", () => {
  const text = "Results (chunk 51-53, 57), with references [12-19].";
  assert.deepEqual(citedChunkIds(text), [51, 52, 53, 57]);
  assert.deepEqual(expandedCitedChunkIds(text), [51, 52, 53, 57]);
});
test("a range cannot cite undelivered interior chunks", () => {
  assert.throws(
    () =>
      assertChunkCitationsResolvable(sentence, {
        allowedChunkIds: [51, 53],
        totalChunks: 60,
      }),
    /52/,
  );
});
test("reversed or oversized ranges are refused without partial interpretation", () => {
  assert.throws(() => citedChunkIds("chunk 53-51"), /range/i);
  assert.throws(() => citedChunkIds("chunk 1-999999999"), /range/i);
});
test("range audit requires evidence for the whole cited range", () => {
  const flags = auditSynthesis(sentence, { chunks });
  assert.deepEqual(flags[0].citedChunks, [51, 52, 53]);
  assert.ok(
    verifySynthesisAudit(
      flags,
      [{ sentence, support: [{ chunkId: 51, quote: chunks[0].text }] }],
      chunks,
    ).length,
  );
  assert.deepEqual(
    verifySynthesisAudit(
      flags,
      [
        {
          sentence,
          support: chunks
            .slice(0, 3)
            .map(({ chunkId, text }) => ({ chunkId, quote: text })),
        },
      ],
      chunks,
    ),
    [],
  );
});
test("a shared trailing citation keeps semicolon clauses together", () => {
  const text =
    "\u4e24\u79cd\u65b9\u6cd5\u7684\u54cd\u5e94\u76f8\u540c\uff1b\u5728\u9650\u5b9a\u6761\u4ef6\u4e0b\u4fdd\u8bc1\u7ed3\u679c\u7a33\u5b9a\uff08chunk 51\uff09\u3002";
  assert.deepEqual(splitSentences(text), [text]);
  const flags = auditSynthesis(text, { chunks });
  assert.deepEqual(
    verifySynthesisAudit(
      flags,
      [{ sentence: text, support: [{ chunkId: 51, quote: chunks[0].text }] }],
      chunks,
    ),
    [],
  );
});
test("audit ids accept unchanged statements and reject changed source versions", () => {
  const flags = auditSynthesis(sentence, { chunks });
  assert.match(flags[0].auditId, /^audit-/);
  const support = chunks
    .slice(0, 3)
    .map(({ chunkId, text }) => ({ chunkId, quote: text }));
  assert.deepEqual(
    verifySynthesisAudit(
      flags,
      [{ auditId: flags[0].auditId, support }],
      chunks,
    ),
    [],
  );
  const changed = chunks.map((chunk) => ({
    ...chunk,
    text: `${chunk.text} Additional qualification.`,
  }));
  const newFlags = auditSynthesis(sentence, { chunks: changed });
  assert.notEqual(newFlags[0].auditId, flags[0].auditId);
  assert.ok(
    verifySynthesisAudit(
      newFlags,
      [{ auditId: flags[0].auditId, support }],
      changed,
    ).length,
  );
});
test("audit ids distinguish mathematical powers from adjacent digits", () => {
  const squared = sentence.replace("responses", "responses at x\u00B2");
  const flat = sentence.replace("responses", "responses at x2");
  const a = auditSynthesis(squared, { chunks });
  const b = auditSynthesis(flat, { chunks });
  const sourceA = chunks.map((chunk) => ({
    ...chunk,
    text: `${chunk.text} x\u00B2`,
  }));
  const sourceB = chunks.map((chunk) => ({
    ...chunk,
    text: `${chunk.text} x2`,
  }));
  assert.notEqual(a.at(-1)?.auditId, b.at(-1)?.auditId);
  assert.notEqual(
    auditSynthesis(sentence, { chunks: sourceA })[0].auditId,
    auditSynthesis(sentence, { chunks: sourceB })[0].auditId,
  );
});
test("paging and source-view options are advertised", () => {
  const tools = buildToolCatalog();
  assert.equal(
    tools.find((entry) => entry.name === "wiki_build_from_paper").inputSchema
      .properties.includeSourceText.type,
    "boolean",
  );
  const paging = tools.find((entry) => entry.name === "wiki_get_reading_note")
    .inputSchema.properties;
  assert.equal(paging.markdownLimit.maximum, 30000);
  assert.equal(paging.expectedBodyHash.type, "string");
});
process.exitCode = failed ? 1 : 0;
