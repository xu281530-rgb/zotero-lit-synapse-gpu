/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { runIndexWorkQueue } = await import(
  "../src/modules/semantic/indexBuildQueue.ts"
);

// An interrupted item stays pending. Items that already succeeded are never
// replayed when the queue resumes.
{
  const attempts = new Map();
  let paused = false;
  let waits = 0;
  const settled = [];

  const result = await runIndexWorkQueue({
    items: ["A", "B", "C"],
    concurrency: 2,
    processItem: async (item) => {
      attempts.set(item, (attempts.get(item) ?? 0) + 1);
      if (item === "B" && attempts.get(item) === 1) {
        paused = true;
        return { status: "incomplete" };
      }
      return { status: "succeeded" };
    },
    isPaused: () => paused,
    isAborted: () => false,
    waitWhilePaused: async () => {
      waits += 1;
      paused = false;
    },
    onSettled: (item, outcome) => settled.push([item, outcome.status]),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.processed, 3);
  assert.equal(result.failedCount, 0);
  assert.equal(waits, 1);
  assert.equal(attempts.get("A"), 1);
  assert.equal(attempts.get("B"), 2);
  assert.equal(attempts.get("C"), 1);
  assert.deepEqual(settled, [
    ["A", "succeeded"],
    ["C", "succeeded"],
    ["B", "succeeded"],
  ]);
}

// A terminal item failure is processed work, but the queue itself is failed,
// never completed.
{
  const result = await runIndexWorkQueue({
    items: ["GOOD", "BAD"],
    concurrency: 2,
    processItem: async (item) =>
      item === "BAD"
        ? { status: "failed", error: new Error("broken") }
        : { status: "succeeded" },
    isPaused: () => false,
    isAborted: () => false,
    waitWhilePaused: async () => {},
  });

  assert.equal(result.status, "failed");
  assert.equal(result.processed, 2);
  assert.equal(result.failedCount, 1);
}

// Aborted work does not turn an incomplete item into processed work.
{
  let aborted = false;
  const result = await runIndexWorkQueue({
    items: ["PENDING"],
    concurrency: 1,
    processItem: async () => {
      aborted = true;
      return { status: "incomplete" };
    },
    isPaused: () => false,
    isAborted: () => aborted,
    waitWhilePaused: async () => {},
  });

  assert.equal(result.status, "aborted");
  assert.equal(result.processed, 0);
  assert.equal(result.failedCount, 0);
}

console.log("Index recovery regression tests passed");
