import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { register } from "node:module";
import { test } from "node:test";

register("./ts-ext-hooks.mjs", import.meta.url);
const { floatVector, vectorBytes, cosine } = await import(
  "../src/modules/wiki/wikiVector.ts"
);
const original = new Float32Array([1, -0.5]);
const bytes = vectorBytes(original);

test("Zotero mozStorage byte arrays decode like typed BLOBs", () => {
  const decoded = floatVector(Array.from(bytes), 2);
  assert.deepEqual(decoded, original);
  assert.equal(cosine(decoded, original), 1);
});

test("typed BLOBs from another window decode without instanceof assumptions", () => {
  const foreignView = runInNewContext(
    "new Uint8Array([0, 0, 128, 63, 0, 0, 0, 191])",
  );
  assert.equal(foreignView instanceof Uint8Array, false);
  assert.deepEqual(floatVector(foreignView, 2), original);
  assert.deepEqual(floatVector(foreignView.buffer, 2), original);
});

test("a sliced byte view decodes only its own bytes", () => {
  const padded = new Uint8Array(12);
  padded.set(bytes, 2);
  assert.deepEqual(floatVector(padded.subarray(2, 10), 2), original);
});

test("invalid byte arrays and wrong lengths cannot produce plausible vectors", () => {
  for (const invalid of [
    [...bytes, 0],
    bytes.slice(1),
    [-1, ...bytes.slice(1)],
    [256, ...bytes.slice(1)],
    [0.5, ...bytes.slice(1)],
    ["0", ...bytes.slice(1)],
    [NaN, ...bytes.slice(1)],
    new Array(8),
    null,
    { byteLength: 8 },
  ]) {
    assert.equal(floatVector(invalid, 2), null);
  }
});
