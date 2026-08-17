/* eslint-env node */

/**
 * A Zotero query that never returns must not be able to lock a library out of
 * keyword search — and fixing that must not let the plugin spawn unkillable
 * background queries without limit.
 *
 * The regression this suite exists for: the gate used to hold a library's slot
 * until the underlying query settled, and chained every waiter onto that same
 * promise. For a merely slow query that is correct. For one that never
 * returns it was fatal — the slot was never released, the waiters' slots were
 * never released either, and the library was refused keyword search forever,
 * with no recovery short of restarting Zotero. One hung query was enough.
 *
 * `Zotero.Search.search()` genuinely cannot be cancelled (its only parameter
 * is `asTempTable`), so the abandoned query really does keep running. What the
 * gate can control is how much it is allowed to cost: the slot is freed on a
 * timer, and a circuit breaker then rations how fast new queries may be
 * created while the database is unresponsive.
 *
 * Timings here are deliberately tiny so the suite runs in well under a second;
 * production values are minutes.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.ztoolkit = { log: () => {} };

const {
  KeywordSearchGate,
  MAX_QUERY_GRACE_MS,
  MIN_QUERY_GRACE_MS,
  QUERY_GRACE_MULTIPLIER,
  isKeywordSearchAbandonedError,
  isKeywordSearchGateError,
  isKeywordSearchOverloadedError,
  isKeywordSearchUnavailableError,
  resolveQueryGraceMs,
} = await import("../src/modules/keywordSearchGate.ts");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lexicalSource = fs.readFileSync(
  path.join(root, "src/modules/lexicalSearch.ts"),
  "utf8",
);
const mcpSource = fs.readFileSync(
  path.join(root, "src/modules/streamableMCPServer.ts"),
  "utf8",
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GRACE = 60;
const COOLDOWN = 80;

const newGate = () =>
  new KeywordSearchGate({
    maxWaiting: 2,
    cooldownMs: COOLDOWN,
    maxCooldownMs: 4 * COOLDOWN,
  });

/** Classify however a run ended, without letting it become unhandled. */
const outcome = (promise) =>
  promise.then(
    (value) => ({ kind: "resolved", value }),
    (error) =>
      isKeywordSearchAbandonedError(error)
        ? { kind: "abandoned" }
        : isKeywordSearchUnavailableError(error)
          ? { kind: "unavailable", retryAfterMs: error.retryAfterMs }
          : isKeywordSearchOverloadedError(error)
            ? { kind: "overloaded" }
            : { kind: "error", message: error.message },
  );

/** A query that never settles, and a counter of how many were ever started. */
function hangingQuery(state) {
  return () => {
    state.started += 1;
    state.live += 1;
    state.peakLive = Math.max(state.peakLive, state.live);
    return new Promise(() => {});
  };
}

// ============================================================================
// 1. THE REGRESSION: a query that never resolves must not brick the library.
// ============================================================================

{
  const gate = newGate();
  const zombies = { started: 0, live: 0, peakLive: 0 };

  // Exactly the shape that used to be unrecoverable: one hung query, then a
  // burst of ordinary searches behind it.
  const first = outcome(gate.run(1, hangingQuery(zombies), { graceMs: GRACE }));
  const followers = [2, 3, 4].map((i) =>
    outcome(gate.run(1, async () => `ok${i}`, { graceMs: GRACE })),
  );

  assert.equal(
    gate.pending(1),
    3,
    "the backlog limit still applies while the first query is merely slow",
  );

  const firstResult = await first;
  assert.equal(
    firstResult.kind,
    "abandoned",
    "past its grace period the query must be presumed dead, not waited on forever",
  );

  // Raced against a wall clock on purpose: under the old implementation these
  // never settled at all, and a test that simply awaited them would hang
  // rather than report anything useful.
  const followerResults = await Promise.race([
    Promise.all(followers),
    sleep(500).then(() => "STILL PENDING"),
  ]);
  assert.notEqual(
    followerResults,
    "STILL PENDING",
    "THE REGRESSION: waiters chained behind a dead query used to hang forever, " +
      "because their slots were only released when a promise that never " +
      "settled settled",
  );
  assert.deepEqual(
    followerResults.map((result) => result.kind),
    ["unavailable", "unavailable", "overloaded"],
    "every waiter must get a specific answer rather than be left hanging: the " +
      "two that fitted in the backlog are told the database stopped answering " +
      "(they were released when the dead query's slot was), and the third was " +
      "refused at the door while the first query still looked merely slow",
  );

  // THE point: the library is not stuck. Everything drained.
  await sleep(20);
  const snapshot = gate.inspect(1);
  assert.equal(
    snapshot.inFlight,
    0,
    "THE REGRESSION: every slot must be released even though the query never " +
      "returned — this counter used to stay pinned at 3 forever",
  );
  assert.equal(
    snapshot.abandoned,
    1,
    "the gate must still remember that one query is unaccounted for",
  );
  assert.equal(
    snapshot.circuit,
    "open",
    "and must stop creating more queries while the database looks unresponsive",
  );
  assert.equal(
    zombies.started,
    1,
    "only ONE uncancellable query may have been created by this burst",
  );
}

// ---- and it must not be waited on for anything like the grace period ----

{
  const gate = newGate();
  const startedAt = Date.now();
  const result = await outcome(
    gate.run(1, () => new Promise(() => {}), { graceMs: GRACE }),
  );
  const elapsed = Date.now() - startedAt;
  assert.equal(result.kind, "abandoned");
  assert.ok(
    elapsed >= GRACE - 15 && elapsed < GRACE + 200,
    `the slot must be freed at ~${GRACE}ms (took ${elapsed}ms)`,
  );
}

// ============================================================================
// 2. Recovery: cool down, then let exactly ONE probe through.
// ============================================================================

{
  const gate = newGate();
  const zombies = { started: 0, live: 0, peakLive: 0 };

  await outcome(gate.run(1, hangingQuery(zombies), { graceMs: GRACE }));
  assert.equal(gate.inspect(1).circuit, "open");

  // Immediately afterwards, searches are refused fast rather than queued.
  const refusedAt = Date.now();
  const refused = await outcome(
    gate.run(1, hangingQuery(zombies), { graceMs: GRACE }),
  );
  assert.equal(
    refused.kind,
    "unavailable",
    "while cooling down, a search must be refused rather than start another " +
      "query into a database that is not answering",
  );
  assert.ok(
    Date.now() - refusedAt < 30,
    "the refusal must be immediate — spending the caller's budget in a queue " +
      "is a slower way to reach the same failure",
  );
  assert.ok(refused.retryAfterMs > 0, "the refusal must say when to come back");
  assert.equal(
    zombies.started,
    1,
    "a refused search must NOT have created a second uncancellable query",
  );

  // After the cool-down, exactly one probe is admitted.
  await sleep(COOLDOWN + 20);
  const probe = outcome(gate.run(1, hangingQuery(zombies), { graceMs: GRACE }));
  const alsoRefused = await outcome(
    gate.run(1, hangingQuery(zombies), { graceMs: GRACE }),
  );
  assert.equal(
    alsoRefused.kind,
    "unavailable",
    "only ONE probe may run: a second concurrent one would double the zombies",
  );
  assert.equal(
    zombies.started,
    2,
    "one cool-down window must cost at most one new query",
  );

  // The probe hangs too, so the cool-down grows instead of hammering Zotero.
  const before = gate.inspect(1);
  assert.equal((await probe).kind, "abandoned");
  const after = gate.inspect(1);
  assert.equal(after.circuit, "open");
  assert.ok(
    after.retryAfterMs > before.retryAfterMs,
    "a probe that hangs too must back off further, not retry at the same rate",
  );
  assert.equal(after.abandoned, 2);
  assert.equal(after.consecutiveAbandonments, 2);
}

// ============================================================================
// 3. A LATE resolve is proof of life and restores service immediately.
// ============================================================================

{
  const gate = newGate();
  let releaseLate;
  const late = outcome(
    gate.run(1, () => new Promise((resolve) => (releaseLate = resolve)), {
      graceMs: GRACE,
    }),
  );
  assert.equal((await late).kind, "abandoned");
  assert.equal(gate.inspect(1).circuit, "open");
  assert.equal(gate.inspect(1).abandoned, 1);

  // The query Zotero was sitting on finally comes back, long after anyone
  // stopped caring about its result.
  releaseLate([1, 2, 3]);
  await sleep(20);

  const snapshot = gate.inspect(1);
  assert.equal(
    snapshot.circuit,
    "closed",
    "a late answer proves the database is alive, so full service must resume " +
      "at once rather than waiting out a cool-down that is no longer justified",
  );
  assert.equal(snapshot.abandoned, 0, "the query is no longer unaccounted for");
  assert.equal(snapshot.consecutiveAbandonments, 0, "the backoff must reset");

  // And a search right now runs normally — no probe rationing.
  assert.deepEqual(
    await outcome(gate.run(1, async () => "fine", { graceMs: GRACE })),
    { kind: "resolved", value: "fine" },
  );
}

// ============================================================================
// 4. Repeated timeouts, then genuine recovery.
// ============================================================================

{
  const gate = newGate();
  const zombies = { started: 0, live: 0, peakLive: 0 };

  // Five consecutive rounds against a wedged database.
  for (let round = 0; round < 5; round++) {
    const result = await outcome(
      gate.run(1, hangingQuery(zombies), { graceMs: GRACE }),
    );
    assert.ok(
      result.kind === "abandoned" || result.kind === "unavailable",
      `round ${round}: expected abandonment or refusal, got ${result.kind}`,
    );
    await sleep(COOLDOWN + 15);
  }

  assert.ok(
    zombies.started <= 5,
    `repeated timeouts must not multiply queries (created ${zombies.started})`,
  );
  assert.ok(
    zombies.peakLive <= 5,
    "at most one new unkillable query per cool-down window may exist",
  );
  assert.ok(
    gate.inspect(1).retryAfterMs <= 4 * COOLDOWN,
    "the cool-down must respect its ceiling instead of growing without bound",
  );

  // Zotero recovers. The next probe succeeds and everything returns to normal.
  await sleep(4 * COOLDOWN + 40);
  const healed = await outcome(
    gate.run(1, async () => [10, 11], { graceMs: GRACE }),
  );
  assert.deepEqual(
    healed,
    { kind: "resolved", value: [10, 11] },
    "once Zotero answers a probe, keyword search must work again",
  );
  const snapshot = gate.inspect(1);
  assert.equal(snapshot.circuit, "closed");
  assert.equal(snapshot.consecutiveAbandonments, 0);

  // Normal concurrency is restored, not permanently reduced to one probe.
  const parallel = await Promise.all(
    [1, 2, 3].map((i) =>
      outcome(gate.run(1, async () => `n${i}`, { graceMs: GRACE })),
    ),
  );
  assert.deepEqual(
    parallel.map((r) => r.kind),
    ["resolved", "resolved", "resolved"],
    "after recovery the gate must behave exactly as it did before the stall",
  );
}

// ============================================================================
// 5. The healthy path is untouched.
// ============================================================================

{
  const gate = newGate();

  // Serialisation still holds: a second query must not start while the first
  // is running, because that is the pile-up the gate exists to prevent.
  let releaseFirst;
  let secondStarted = false;
  const first = gate.run(1, () => new Promise((r) => (releaseFirst = r)), {
    graceMs: 5000,
  });
  const second = gate.run(
    1,
    async () => {
      secondStarted = true;
      return "second";
    },
    { graceMs: 5000 },
  );
  await sleep(20);
  assert.equal(secondStarted, false, "queries must still run one at a time");
  releaseFirst("first");
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.equal(gate.pending(1), 0);

  // A backlog that is genuinely full is still refused.
  const gate2 = newGate();
  let release2;
  const blocking = outcome(
    gate2.run(1, () => new Promise((r) => (release2 = r)), { graceMs: 5000 }),
  );
  const queued = [1, 2].map(() =>
    outcome(gate2.run(1, async () => "q", { graceMs: 5000 })),
  );
  const overflow = await outcome(
    gate2.run(1, async () => "x", { graceMs: 5000 }),
  );
  assert.equal(overflow.kind, "overloaded");
  release2("done");
  await Promise.all([blocking, ...queued]);

  // A query that FAILS is an answer, so it must not open the circuit.
  const gate3 = newGate();
  const failed = await outcome(
    gate3.run(1, async () => {
      throw new Error("Zotero said no");
    }, { graceMs: GRACE }),
  );
  assert.equal(failed.kind, "error");
  assert.equal(
    gate3.inspect(1).circuit,
    "closed",
    "an error is proof the database is responding — only silence is not",
  );
  assert.equal(await gate3.run(1, async () => "next", { graceMs: GRACE }), "next");

  // Libraries are independent: one wedged library must not stop the others.
  const gate4 = newGate();
  await outcome(gate4.run(1, () => new Promise(() => {}), { graceMs: GRACE }));
  assert.equal(gate4.inspect(1).circuit, "open");
  assert.equal(gate4.inspect(2).circuit, "closed");
  assert.equal(await gate4.run(2, async () => "other", { graceMs: GRACE }), "other");
}

// ============================================================================
// 6. The two clocks are genuinely different.
// ============================================================================

{
  assert.equal(
    resolveQueryGraceMs(30_000),
    Math.min(MAX_QUERY_GRACE_MS, 30_000 * QUERY_GRACE_MULTIPLIER),
    "the background grace period must be derived from, and longer than, the " +
      "user's own wait timeout",
  );
  assert.ok(
    resolveQueryGraceMs(30_000) > 30_000,
    "a query must outlive the caller who gave up on it — most stalls are slow, " +
      "not dead, and a late answer is worth more than the slot it holds",
  );
  assert.equal(
    resolveQueryGraceMs(1_000),
    MIN_QUERY_GRACE_MS,
    "a very short configured timeout must not declare healthy queries dead",
  );
  assert.equal(
    resolveQueryGraceMs(60 * 60_000),
    MAX_QUERY_GRACE_MS,
    "a very long one must not re-create the permanent lockout",
  );
  for (const bogus of [0, -1, Number.NaN, undefined]) {
    assert.equal(resolveQueryGraceMs(bogus), MIN_QUERY_GRACE_MS);
  }
}

// ---- the callers wire both clocks, and report the states apart ----

{
  assert.match(
    lexicalSource,
    /queryGraceMs\?: number;/,
    "the search path must accept a background grace period",
  );
  assert.match(
    lexicalSource,
    /graceMs:\s*\n\s*options\.queryGraceMs \?\?\s*\n\s*resolveQueryGraceMs\(/,
    "and derive it from the caller's deadline when not given one",
  );

  assert.match(
    mcpSource,
    /if \(isKeywordSearchUnavailableError\(error\)\) \{/,
    "a refused search must be reported as its own state, not as a timeout: " +
      "retrying a timeout immediately is reasonable, retrying this is not",
  );
  assert.match(
    mcpSource,
    /keywordSearchUnavailable/,
    "the response must carry a machine-readable flag for it",
  );
  assert.match(
    mcpSource,
    /retryAfterMs/,
    "and say when it is worth trying again",
  );
}

assert.ok(isKeywordSearchGateError({ name: "KeywordSearchAbandonedError" }));
assert.ok(isKeywordSearchGateError({ name: "KeywordSearchUnavailableError" }));
assert.ok(isKeywordSearchGateError({ name: "KeywordSearchOverloadedError" }));
assert.ok(!isKeywordSearchGateError(new Error("unrelated")));

console.log("keyword gate recovery: all assertions passed");
