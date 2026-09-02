/* eslint-env node */

/**
 * The hint that tells a reading turn it owes the Wiki a record.
 *
 * The first version of this read `result.chunks` and nothing else, so it
 * worked for search_fulltext and did nothing at all for get_document_chunks,
 * whose passages arrive under `data`. It failed the way shape bugs fail: no
 * error, no log, just an absent reminder - indistinguishable from the problem
 * the hint was written to fix, and only visible by running a real read against
 * a real library. These tests are that run, made cheap.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { buildReadingLedgerHint, deliveredChunkIds } = await import(
  "../src/modules/readingLedgerHint.ts"
);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("both reading tools' response shapes are recognised", () => {
  // search_fulltext: ranked passages under `chunks`.
  assert.deepEqual(
    deliveredChunkIds({ chunks: [{ chunkId: 1 }, { chunkId: 35 }] }),
    [1, 35],
  );
  // get_document_chunks: consecutive passages under `data`.
  assert.deepEqual(
    deliveredChunkIds({ data: [{ chunkIndex: 24, chunkId: 25 }] }),
    [25],
  );
});

test("chunk 0 is a chunk", () => {
  // The first chunk of every document. A truthiness check drops it, and the
  // opening of a paper is exactly the passage a question is most likely to use.
  assert.deepEqual(deliveredChunkIds({ chunks: [{ chunkId: 0 }] }), [0]);
  assert.ok(buildReadingLedgerHint({ chunks: [{ chunkId: 0 }] }, "AAAA1111"));
});

test("responses that delivered no passage get no hint", () => {
  for (const empty of [
    null,
    undefined,
    "a string",
    {},
    { chunks: [] },
    { data: [] },
    { chunks: [{ text: "no id here" }] },
    { data: [{ chunkId: "25" }] }, // a string id is not an id
  ]) {
    assert.equal(
      buildReadingLedgerHint(empty, "AAAA1111"),
      null,
      `${JSON.stringify(empty)} should produce no hint`,
    );
  }
  // A cursor call whose document could not be named has nothing to point at.
  assert.equal(buildReadingLedgerHint({ chunks: [{ chunkId: 1 }] }, ""), null);
});

test("the hint carries what readChunkIds needs, and says what to do", () => {
  const hint = buildReadingLedgerHint(
    { chunks: [{ chunkId: 1 }, { chunkId: 7 }, { chunkId: 16 }] },
    "4V3CP6BB",
  );
  assert.deepEqual(hint.deliveredChunkIds, [1, 7, 16]);
  assert.equal(hint.itemKey, "4V3CP6BB");
  assert.equal(hint.recorded, false);
  // It has to name the tool and the item, or it is a nudge with no address.
  assert.match(hint.nextStep, /wiki_update_reading_note/);
  assert.match(hint.nextStep, /4V3CP6BB/);
  assert.match(hint.nextStep, /readChunkIds/);
  // And it must not turn retrieval into reading: the server counts what the
  // caller declares, so over-declaring opens Wiki debt for unread passages.
  assert.match(hint.nextStep, /Retrieval is not reading/);
  // Cheap enough to ride on every reading response.
  assert.ok(
    JSON.stringify(hint).length < 700,
    `the hint is ${JSON.stringify(hint).length} chars; it rides on every read`,
  );
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
