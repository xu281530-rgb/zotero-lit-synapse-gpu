/* eslint-env node */

/**
 * The three race boundaries of the keyword-search circuit breaker.
 *
 * These are the states that only exist for a moment, and that a hand-trace of
 * the state machine is bad at reasoning about:
 *
 *   1. a query that was already presumed dead answering LATE, while its slot
 *      has long since been handed to someone else;
 *   2. many searches arriving in the SAME tick that the cool-down expires,
 *      each of which could plausibly believe it is the one probe;
 *   3. a stale zombie answering after a NEWER probe has already failed, which
 *      moves the state machine backwards through its own transitions.
 *
 * Everything here is measured from the outside, on the two things that
 * actually matter: how many real Zotero queries were STARTED, and what the
 * gate's own state did. Assertions on returned text would pass just as well
 * against a gate that had quietly started six queries.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.ztoolkit = { log: () => {} };

const {
  KeywordSearchGate,
  isKeywordSearchAbandonedError,
  isKeywordSearchOverloadedError,
  isKeywordSearchUnavailableError,
} = await import("../src/modules/keywordSearchGate.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Generous relative to timer jitter: every decision below turns on whether a
// cool-down has elapsed, and values near the scheduler's resolution would make
// the suite flaky rather than strict.
const GRACE = 80;
const COOLDOWN = 120;

const newGate = () =>
  new KeywordSearchGate({
    maxWaiting: 2,
    cooldownMs: COOLDOWN,
    maxCooldownMs: 8 * COOLDOWN,
  });

const classify = (error) =>
  isKeywordSearchAbandonedError(error)
    ? "abandoned"
    : isKeywordSearchUnavailableError(error)
      ? "unavailable"
      : isKeywordSearchOverloadedError(error)
        ? "overloaded"
        : `error:${error.message}`;

const outcome = (promise) =>
  promise.then(
    (value) => ({ kind: "resolved", value }),
    (error) => ({ kind: classify(error) }),
  );

/**
 * Instrumentation for the only question that matters about a gate: how much
 * real work did it actually set in motion?
 *
 * `active` counts queries that have started and are neither finished nor yet
 * presumed dead — that is, the query the gate currently believes in. Zombies
 * are tracked separately, because an uncancellable query that outlived its
 * grace period is a cost already sunk; what must never grow is the number of
 * NEW ones.
 */
function tracker() {
  const state = {
    started: 0,
    active: 0,
    peakActive: 0,
    zombies: 0,
    settled: 0,
  };
  const pending = [];

  /** A query that never answers. */
  state.hang = () => {
    state.started += 1;
    state.active += 1;
    state.peakActive = Math.max(state.peakActive, state.active);
    return new Promise(() => {});
  };

  /** A query that answers only when the test says so. */
  state.deferred = () => {
    state.started += 1;
    state.active += 1;
    state.peakActive = Math.max(state.peakActive, state.active);
    let settle;
    const promise = new Promise((resolve) => {
      settle = (value) => {
        state.active = Math.max(0, state.active - 1);
        state.settled += 1;
        resolve(value);
      };
    });
    pending.push(settle);
    return promise;
  };

  /** A query that answers immediately. */
  state.instant = (value) => async () => {
    state.started += 1;
    state.settled += 1;
    return value;
  };

  /** Mark the query the gate has just given up on as no longer "active". */
  state.noteAbandoned = () => {
    state.active = Math.max(0, state.active - 1);
    state.zombies += 1;
  };

  /** Let the n-th deferred query answer, long after anyone stopped waiting. */
  state.answerLate = (index = 0, value = [1, 2, 3]) => {
    const settle = pending[index];
    assert.ok(settle, `no deferred query at index ${index}`);
    settle(value);
  };

  return state;
}

// ============================================================================
// BOUNDARY 1 — a late answer may prove the database is alive, and nothing else.
// ============================================================================
//
// The hazard: the slot was released by the grace timer, the counters were
// adjusted then, and the run already rejected. When the query finally answers,
// it must not release that slot a second time, must not decrement a counter
// that was already decremented, and must not disturb whoever holds the slot
// now.

{
  const gate = newGate();
  const queries = tracker();

  const first = outcome(gate.run(1, queries.deferred, { graceMs: GRACE }));
  assert.deepEqual(gate.inspect(1), {
    inFlight: 1,
    abandoned: 0,
    circuit: "closed",
    retryAfterMs: 0,
    consecutiveAbandonments: 0,
  });

  assert.equal((await first).kind, "abandoned");
  queries.noteAbandoned();

  const afterAbandonment = gate.inspect(1);
  assert.equal(afterAbandonment.inFlight, 0, "the slot must have been freed");
  assert.equal(afterAbandonment.abandoned, 1);
  assert.equal(afterAbandonment.circuit, "open");

  // Someone else takes the slot while the old query is still out there.
  await sleep(COOLDOWN + 30);
  const probe = outcome(gate.run(1, queries.deferred, { graceMs: 5000 }));
  const duringProbe = gate.inspect(1);
  assert.equal(duringProbe.inFlight, 1, "the probe now holds the slot");
  assert.equal(duringProbe.circuit, "half-open");

  // ...and NOW the first query answers, hours late.
  queries.answerLate(0);
  await sleep(30);

  const afterLate = gate.inspect(1);
  assert.equal(
    afterLate.inFlight,
    1,
    "THE RACE: a late answer must not release a slot it no longer owns — " +
      "decrementing here would have handed the library's one slot to a second " +
      "query while the probe was still running",
  );
  assert.ok(
    afterLate.abandoned >= 0 && afterLate.inFlight >= 0,
    "no counter may go negative",
  );
  assert.equal(
    afterLate.abandoned,
    0,
    "the late answer accounts for exactly the one query that was unaccounted for",
  );

  // Answering twice must be impossible, but the state must survive it anyway.
  const before = gate.inspect(1);
  queries.answerLate(1, "probe result");
  await sleep(20);
  assert.equal((await probe).kind, "resolved");
  const after = gate.inspect(1);
  assert.ok(after.inFlight >= 0 && after.abandoned >= 0);
  assert.equal(
    after.abandoned,
    before.abandoned,
    "a query that answered on time must not decrement the zombie count",
  );

  // The queue is healthy: a fresh search runs immediately.
  assert.equal(
    (await outcome(gate.run(1, queries.instant("ok"), { graceMs: GRACE })))
      .kind,
    "resolved",
  );
  assert.equal(gate.inspect(1).inFlight, 0);
  assert.equal(
    queries.peakActive,
    1,
    "at no point may two believed-in queries run at once",
  );
}

// ---- a late answer must not resurrect a slot for a REFUSED caller either ----

{
  const gate = newGate();
  const queries = tracker();

  const hung = outcome(gate.run(1, queries.deferred, { graceMs: GRACE }));
  const queued = [1, 2].map(() =>
    outcome(gate.run(1, queries.instant("q"), { graceMs: GRACE })),
  );
  assert.equal((await hung).kind, "abandoned");
  queries.noteAbandoned();
  await Promise.all(queued);

  const before = gate.inspect(1);
  queries.answerLate(0);
  await sleep(20);
  const after = gate.inspect(1);

  assert.equal(after.inFlight, 0, "inFlight must not drift below zero or above");
  assert.equal(after.abandoned, before.abandoned - 1);
  assert.equal(
    after.circuit,
    "closed",
    "the late answer is proof of life and closes the circuit",
  );
}

// ============================================================================
// BOUNDARY 2 — exactly ONE probe, however many callers arrive together.
// ============================================================================
//
// Dispatched in a single tick with no await in between, so this is not a
// question of who wins a timing race: every one of these callers sees the same
// expired cool-down and the same gate state.

{
  const gate = newGate();
  const queries = tracker();

  assert.equal((await outcome(gate.run(1, queries.hang, { graceMs: GRACE }))).kind, "abandoned");
  queries.noteAbandoned();
  assert.equal(queries.started, 1);
  assert.equal(gate.inspect(1).circuit, "open");

  await sleep(COOLDOWN + 40);

  // Twelve concurrent hybrid_search / keyword_search calls, all at once.
  const burst = Array.from({ length: 12 }, () =>
    outcome(gate.run(1, queries.hang, { graceMs: GRACE })),
  );

  // Checked before yielding: admission is decided synchronously, so by the
  // time control returns from the twelfth `run()` the gate must already have
  // committed to exactly one probe. A gate that decided this asynchronously
  // would still be "closed" here and would let several callers through.
  assert.equal(
    gate.inspect(1).circuit,
    "half-open",
    "THE RACE: twelve callers arriving in one tick must be adjudicated " +
      "synchronously — the gate must already be in the single-probe state " +
      "before any of them has had a chance to run",
  );
  assert.equal(
    gate.inspect(1).inFlight,
    1,
    "and exactly one of the twelve may hold the slot",
  );

  // The admitted caller starts its query a microtask later; the refused ones
  // never start one at all.
  await sleep(20);
  assert.equal(
    queries.started,
    2,
    "exactly ONE of twelve simultaneous callers may reach Zotero — anything " +
      "more means the breaker was punched through by concurrency",
  );

  const results = await Promise.all(burst);
  queries.noteAbandoned();

  const probes = results.filter((r) => r.kind === "abandoned");
  const refused = results.filter((r) => r.kind === "unavailable");
  assert.equal(probes.length, 1, "exactly one caller may have run a query");
  assert.equal(
    refused.length,
    11,
    "every other caller must be told to wait, not silently given nothing",
  );
  assert.equal(
    queries.started,
    2,
    "the refused callers must not have started a query between them",
  );
  assert.equal(
    queries.peakActive,
    1,
    "two believed-in queries must never be live at the same instant",
  );
}

// ---- a second caller during a LIVE probe is refused too ----

{
  const gate = newGate();
  const queries = tracker();
  assert.equal((await outcome(gate.run(1, queries.hang, { graceMs: GRACE }))).kind, "abandoned");
  queries.noteAbandoned();
  await sleep(COOLDOWN + 40);

  const probe = outcome(gate.run(1, queries.hang, { graceMs: 5000 }));
  await sleep(20);
  assert.equal(queries.started, 2, "the probe is now genuinely mid-flight");

  // Spread across ticks this time, so the probe is genuinely mid-flight.
  for (let i = 0; i < 4; i++) {
    await sleep(10);
    const attempt = await outcome(gate.run(1, queries.hang, { graceMs: GRACE }));
    assert.equal(
      attempt.kind,
      "unavailable",
      "while a probe is in flight, nothing else may run",
    );
  }
  assert.equal(
    queries.started,
    2,
    "four attempts during a live probe must have started zero queries",
  );
  assert.ok(
    gate.inspect(1).retryAfterMs > 0,
    "a caller refused during a live probe must be told roughly when to return, " +
      "not handed a zero that invites an immediate retry",
  );
  probe.catch(() => undefined);
}

// ---- a probe that never becomes a query must hand the probe back ----
//
// Found by this suite: a task that threw synchronously left the probe claimed
// for ever. The circuit sat in half-open with nothing running and no cool-down
// left to wait out, so every later search was refused permanently — the exact
// class of lockout this module exists to prevent.

{
  const gate = newGate();
  const queries = tracker();
  assert.equal((await outcome(gate.run(1, queries.hang, { graceMs: GRACE }))).kind, "abandoned");
  queries.noteAbandoned();
  await sleep(COOLDOWN + 40);

  const boom = await outcome(
    gate.run(
      1,
      () => {
        throw new Error("synchronous failure before any query started");
      },
      { graceMs: GRACE },
    ),
  );
  assert.equal(boom.kind, "error:synchronous failure before any query started");

  const afterBoom = gate.inspect(1);
  assert.notEqual(
    afterBoom.circuit,
    "half-open",
    "a probe that never ran must not leave the gate stuck in the single-probe " +
      "state with nothing to wait for",
  );
  assert.ok(
    afterBoom.retryAfterMs > 0,
    "there must be a real cool-down to wait out, not a permanent zero",
  );
  assert.equal(
    afterBoom.consecutiveAbandonments,
    1,
    "nothing was learned, so the failure count must not grow",
  );

  // And recovery still works.
  await sleep(afterBoom.retryAfterMs + 40);
  assert.equal(
    (await outcome(gate.run(1, queries.instant("recovered"), { graceMs: GRACE })))
      .kind,
    "resolved",
    "the library must become usable again once the cool-down elapses",
  );
  assert.equal(gate.inspect(1).circuit, "closed");
}

// ============================================================================
// BOUNDARY 3 — a stale zombie answering after a newer probe already failed.
// ============================================================================
//
// A -> hangs -> breaker opens
// B -> probe -> hangs too -> breaker opens wider
// A -> answers LATE -> recovery
// C -> hangs again -> breaker must open cleanly, from a clean slate

{
  const gate = newGate();
  const queries = tracker();

  // A hangs.
  assert.equal(
    (await outcome(gate.run(1, queries.deferred, { graceMs: GRACE }))).kind,
    "abandoned",
  );
  queries.noteAbandoned();
  const afterA = gate.inspect(1);
  assert.deepEqual(
    [afterA.circuit, afterA.abandoned, afterA.consecutiveAbandonments],
    ["open", 1, 1],
  );

  // B probes, and hangs too.
  await sleep(COOLDOWN + 40);
  assert.equal(
    (await outcome(gate.run(1, queries.hang, { graceMs: GRACE }))).kind,
    "abandoned",
  );
  queries.noteAbandoned();
  const afterB = gate.inspect(1);
  assert.equal(afterB.circuit, "open");
  assert.equal(afterB.abandoned, 2, "two queries are now unaccounted for");
  assert.equal(afterB.consecutiveAbandonments, 2);
  assert.ok(
    afterB.retryAfterMs > afterA.retryAfterMs,
    "a failed probe must widen the cool-down",
  );
  assert.equal(queries.started, 2);

  // A answers, long after B already failed.
  queries.answerLate(0);
  await sleep(30);
  const afterLate = gate.inspect(1);
  assert.equal(
    afterLate.circuit,
    "closed",
    "a query answering is proof of life, so service resumes",
  );
  assert.equal(
    afterLate.abandoned,
    1,
    "exactly one zombie is accounted for — B is still out there",
  );
  assert.equal(afterLate.inFlight, 0, "and no slot may be leaked or duplicated");
  assert.equal(
    afterLate.consecutiveAbandonments,
    0,
    "the backoff resets on proven recovery",
  );
  assert.equal(afterLate.retryAfterMs, 0);

  // C runs immediately (no probe rationing), and hangs.
  const cStarted = queries.started;
  const c = outcome(gate.run(1, queries.hang, { graceMs: GRACE }));
  assert.equal(
    gate.inspect(1).circuit,
    "closed",
    "after recovery a search must be admitted normally rather than rationed " +
      "as a probe",
  );
  await sleep(20);
  assert.equal(
    queries.started,
    cStarted + 1,
    "and it must actually reach Zotero",
  );
  assert.equal((await c).kind, "abandoned");
  queries.noteAbandoned();

  const afterC = gate.inspect(1);
  assert.equal(
    afterC.circuit,
    "open",
    "THE RACE: the state machine must be able to open again after a recovery " +
      "driven by a stale answer",
  );
  assert.equal(afterC.abandoned, 2, "B and C are both unaccounted for");
  assert.ok(afterC.abandoned >= 0 && afterC.inFlight >= 0);
  assert.equal(afterC.inFlight, 0);
  assert.equal(
    afterC.consecutiveAbandonments,
    1,
    "the backoff restarts from scratch, because the recovery was real",
  );
  assert.equal(
    afterC.retryAfterMs > 0 && afterC.retryAfterMs <= COOLDOWN,
    true,
    "and the cool-down restarts at the base value, not the widened one",
  );

  assert.equal(
    queries.peakActive,
    1,
    "through the whole sequence, only ever one believed-in query at a time",
  );
  assert.equal(
    queries.started,
    3,
    "A, B and C — the sequence must not have created a fourth query anywhere",
  );

  // And it still recovers afterwards.
  await sleep(afterC.retryAfterMs + 40);
  assert.equal(
    (await outcome(gate.run(1, queries.instant("fine"), { graceMs: GRACE })))
      .kind,
    "resolved",
  );
  assert.equal(gate.inspect(1).circuit, "closed");
}

// ---- a long storm must not create queries faster than one per cool-down ----

{
  const gate = newGate();
  const queries = tracker();
  const rounds = 6;

  for (let round = 0; round < rounds; round++) {
    // Each round: a burst of callers, only one of which can possibly run.
    const burst = Array.from({ length: 5 }, () =>
      outcome(gate.run(1, queries.hang, { graceMs: GRACE })),
    );
    const results = await Promise.all(burst);
    if (results.some((r) => r.kind === "abandoned")) queries.noteAbandoned();
    await sleep(gate.inspect(1).retryAfterMs + 40);
  }

  assert.ok(
    queries.started <= rounds + 1,
    `${rounds} rounds of 5 callers each (30 calls) must not have started more ` +
      `than ${rounds + 1} queries, got ${queries.started}`,
  );
  assert.equal(
    queries.peakActive,
    1,
    "no matter how long the storm lasts, only one query is ever believed in",
  );
  assert.ok(
    gate.inspect(1).retryAfterMs <= 8 * COOLDOWN,
    "the cool-down must respect its ceiling",
  );

  // Zotero comes back.
  await sleep(gate.inspect(1).retryAfterMs + 40);
  assert.equal(
    (await outcome(gate.run(1, queries.instant("back"), { graceMs: GRACE })))
      .kind,
    "resolved",
  );
  const healed = gate.inspect(1);
  assert.equal(healed.circuit, "closed");
  assert.equal(healed.consecutiveAbandonments, 0);
  assert.equal(healed.inFlight, 0);

  // Normal concurrency is restored, not permanently reduced to one probe.
  const parallel = await Promise.all(
    [1, 2, 3].map(() =>
      outcome(gate.run(1, queries.instant("n"), { graceMs: GRACE })),
    ),
  );
  assert.deepEqual(
    parallel.map((r) => r.kind),
    ["resolved", "resolved", "resolved"],
  );
}

// ============================================================================
// Reverse verification — these assertions are not vacuous.
// ============================================================================
//
// A model of the ORIGINAL design, whose slot was released only when the task
// settled and whose waiters chained onto that same promise. The checks above
// are re-run against it; every one of them must fail. Without this, a test
// that asserts "nothing went wrong" could be passing because it never looked.

class OriginalGateModel {
  constructor() {
    this.tail = Promise.resolve();
    this.inFlight = 0;
  }
  run(libraryID, task) {
    if (this.inFlight > 2) {
      return Promise.reject(
        Object.assign(new Error("overloaded"), {
          name: "KeywordSearchOverloadedError",
        }),
      );
    }
    this.inFlight += 1;
    const result = this.tail.then(task, task);
    const release = () => {
      this.inFlight -= 1;
    };
    this.tail = result.then(release, release);
    return result;
  }
  inspect() {
    return {
      inFlight: this.inFlight,
      abandoned: 0,
      circuit: "closed",
      retryAfterMs: 0,
      consecutiveAbandonments: 0,
    };
  }
}

{
  const broken = new OriginalGateModel();
  const queries = tracker();

  const first = outcome(broken.run(1, queries.hang, { graceMs: GRACE }));
  const followers = [1, 2].map(() =>
    outcome(broken.run(1, queries.instant("q"), { graceMs: GRACE })),
  );

  const settledInTime = await Promise.race([
    Promise.all([first, ...followers]).then(() => true),
    sleep(GRACE * 4).then(() => false),
  ]);
  assert.equal(
    settledInTime,
    false,
    "reverse check: the original design must hang here — if this passes, the " +
      "model is wrong and the comparison below proves nothing",
  );
  assert.equal(
    broken.inspect(1).inFlight,
    3,
    "reverse check: the original design pinned its slot counter for ever, " +
      "which is exactly what BOUNDARY 1 asserts must not happen",
  );

  // The circuit-breaker assertions cannot even be expressed against it: there
  // is no recovery path at all.
  const muchLater = await Promise.race([
    outcome(broken.run(1, queries.instant("later"), { graceMs: GRACE })),
    sleep(GRACE * 2).then(() => ({ kind: "STILL PENDING" })),
  ]);
  assert.equal(
    muchLater.kind,
    "overloaded",
    "reverse check: under the original design the library stayed refused for " +
      "ever, with no probe and no cool-down",
  );
  first.catch(() => undefined);
}

console.log("keyword gate races: all assertions passed");
