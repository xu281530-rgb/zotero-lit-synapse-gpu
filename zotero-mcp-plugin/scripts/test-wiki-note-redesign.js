/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  appendMacroSummary,
  appendReadingRecord,
  assertMacroSummaryCoversRecords,
  parseAppendOnlyReadingNote,
} = await import("../src/modules/wiki/wikiReadingNote.ts");

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("reading records are server-numbered and append-only", () => {
  const first = appendReadingRecord("", {
    chunkIds: [12, 13],
    content: "- The pressure may reach 50 MPa (chunk 12).",
  });
  const second = appendReadingRecord(first, {
    chunkIds: [14],
    content: "- Correction to record 1: the pressure is conditional (chunk 14).",
  });
  const parsed = parseAppendOnlyReadingNote(second);

  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].number, 1);
  assert.deepEqual(parsed.records[0].chunkIds, [12, 13]);
  assert.equal(parsed.records[1].number, 2);
  assert.match(second, /### 第 1 次 · chunk 12-13/u);
  assert.match(second, /### 第 2 次 · chunk 14/u);
  assert.ok(
    second.includes(first.trim()),
    "the exact earlier document is a prefix of the appended document",
  );
});

test("legacy notes stay byte-for-byte intact before new records", () => {
  const legacy = "# Old narrative\n\nA legacy paragraph (chunk 7).";
  const next = appendReadingRecord(legacy, {
    chunkIds: [20],
    content: "- A new observation (chunk 20).",
  });
  const parsed = parseAppendOnlyReadingNote(next);

  assert.equal(parsed.legacyBody, legacy);
  assert.ok(next.startsWith(legacy));
  assert.equal(parsed.records.length, 1);
});

test("no-new-content records may repeat without invented prose", () => {
  let body = appendReadingRecord("", {
    chunkIds: [30],
    content: "- 本次无新内容（参考文献）。",
  });
  body = appendReadingRecord(body, {
    chunkIds: [31],
    content: "- 本次无新内容（致谢）。",
  });

  const parsed = parseAppendOnlyReadingNote(body);
  assert.equal(parsed.records.length, 2);
  assert.ok(parsed.records.every((record) => record.noNewContent));
});

test("macro summary is appended and names uncovered records", () => {
  let body = appendReadingRecord("", {
    chunkIds: [40],
    content: "- The method is proposed as a possible solution (chunk 40).",
  });
  body = appendReadingRecord(body, {
    chunkIds: [41],
    content: "- 本次无新内容（参考文献）。",
  });
  const beforeSummary = body;

  assert.throws(
    () => assertMacroSummaryCoversRecords(body, "The paper proposes a method."),
    /第 1 次/u,
  );

  const summary = "The paper proposes a possible solution (chunk 40).";
  assertMacroSummaryCoversRecords(body, summary);
  body = appendMacroSummary(body, summary);
  const parsed = parseAppendOnlyReadingNote(body);

  assert.ok(body.startsWith(beforeSummary.trim()));
  assert.equal(parsed.macroSummary, summary);
  assert.throws(
    () => appendMacroSummary(body, summary),
    /already has|已有/u,
  );
});

test("macro summary covers every finding even when findings share a chunk", () => {
  const body = appendReadingRecord("", {
    chunkIds: [42],
    content: [
      "- The peak pressure is 50 MPa (chunk 42).",
      "- The holding temperature is 1180 C (chunk 42).",
    ].join("\n"),
  });

  assert.throws(
    () =>
      assertMacroSummaryCoversRecords(
        body,
        "The experiment reaches a peak pressure of 50 MPa (chunk 42).",
      ),
    /第 1 次/u,
    "sharing a citation must not let one finding stand in for another",
  );
  assert.throws(
    () =>
      assertMacroSummaryCoversRecords(
        body,
        [
          "The holding temperature is 50 C (chunk 42).",
          "The peak pressure is 1180 MPa (chunk 42).",
        ].join("\n"),
      ),
    /第 1 次/u,
    "numbers cannot be reassigned to a different finding from the same chunk",
  );
  const repeatedValueBody = appendReadingRecord("", {
    chunkIds: [43],
    content: [
      "- The pressure is 50 MPa (chunk 43).",
      "- The temperature is also 50 C (chunk 43).",
    ].join("\n"),
  });
  assert.throws(
    () =>
      assertMacroSummaryCoversRecords(
        repeatedValueBody,
        [
          "The pressure is 50 C (chunk 43).",
          "The temperature is also 50 MPa (chunk 43).",
        ].join("\n"),
      ),
    /第 1 次/u,
    "repeated numeric values still need to stay with their original units",
  );

  assert.doesNotThrow(() =>
    assertMacroSummaryCoversRecords(
      body,
      [
        "The experiment reaches a peak pressure of 50 MPa (chunk 42).",
        "Its holding temperature is 1180 C (chunk 42).",
      ].join("\n"),
    ),
  );
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  not ok  ${name}`);
    console.error(error);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
