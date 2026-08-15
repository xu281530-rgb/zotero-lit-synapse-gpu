/* eslint-env node */

/**
 * Tests for adaptive embedding batch capacity.
 *
 * Two things are being pinned down here.
 *
 * The first is a correctness guarantee: a chunk is either embedded whole or
 * not at all. The service used to cut an oversized chunk down to its first 800
 * characters and embed that, while the indexer stored the FULL chunk text next
 * to the resulting vector — so a search scored a passage on a quarter of the
 * text it claimed to be about. Every request in every test below is checked,
 * character for character, against the chunks that were handed in.
 *
 * The second is that batch sizing learns from evidence and only from evidence.
 * A refusal that says "your input is too long" narrows the search; a timeout,
 * a 429, an expired key or a 500 must leave it exactly where it was.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("./ts-ext-hooks.mjs", import.meta.url);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Every text this fake endpoint has ever been asked to embed.
 *
 * Shared across all scenarios so the "no chunk was ever truncated" check at the
 * end of the file covers every code path exercised anywhere in this file, not
 * just the paths a single test remembered to assert on.
 */
const allSentTexts = [];
const allOfferedChunks = new Set();

let activePrefs = new Map();
let activeServer = null;

globalThis.Zotero = {
  Prefs: {
    get: (key) => activePrefs.get(key),
    set: (key, value) => activePrefs.set(key, value),
    clear: (key) => activePrefs.delete(key),
  },
  HTTP: {
    request: (method, url, options) => activeServer(method, url, options),
  },
};
globalThis.ztoolkit = { log: () => {} };

const {
  EmbeddingService,
  SINGLE_CHUNK_TOO_LARGE_MESSAGE,
  resolveMaxBatchItems,
  extractBatchLimit,
  DEFAULT_MAX_BATCH_ITEMS,
  MAX_MAX_BATCH_ITEMS,
} = await import("../src/modules/semantic/embeddingService.ts");

const MAX_ITEMS_PREF =
  "extensions.zotero.zotero-mcp-plugin.embedding.maxBatchItems";

/**
 * Raise or lower the inputs-per-request limit for one scenario.
 *
 * Tests about CHARACTER capacity set this out of the way, because the two
 * limits are independent and a test that lets the count limit bind is no
 * longer testing the thing it claims to.
 */
const setMaxBatchItems = (n) => activePrefs.set(MAX_ITEMS_PREF, n);
const capacity = await import("../src/modules/semantic/batchCapacity.ts");

/** An HTTP error shaped the way Zotero.HTTP surfaces one. */
const httpError = (status, body, headers) => {
  const error = new Error(`XMLHttpRequest error: ${status}`);
  error.status = status;
  error.headers = headers;
  error.xmlhttp = { status, response: body };
  return error;
};

const OVERLONG_400 = () =>
  httpError(400, {
    error: { message: "This model's maximum context length is 8192 tokens" },
  });

/**
 * A fake embeddings endpoint.
 *
 * `limitChars` is the total number of characters it will accept in one
 * request; `reject` lets a scenario fail the call for some other reason.
 */
function makeServer({ limitChars = Infinity, reject = null, dims = 4 } = {}) {
  const calls = [];
  const server = (method, url, options) => {
    const body = JSON.parse(options.body);
    const texts = Array.isArray(body.input) ? body.input : [body.input];
    const chars = texts.reduce((sum, t) => sum + t.length, 0);
    calls.push({ count: texts.length, chars, texts, model: body.model, url });
    allSentTexts.push(...texts);

    const failure = reject?.(calls.length, texts);
    if (failure) return Promise.reject(failure);
    if (chars > limitChars) return Promise.reject(OVERLONG_400());

    return Promise.resolve({
      status: 200,
      response: {
        data: texts.map((_, index) => ({
          index,
          embedding: new Array(dims).fill(0.5),
        })),
        usage: { total_tokens: chars },
      },
    });
  };
  server.calls = calls;
  return server;
}

function newService(overrides = {}) {
  return new EmbeddingService({
    apiBase: "https://api.example.com/v1",
    apiKey: "test-key",
    model: "test-embed",
    dimensions: undefined,
    timeout: 1000,
    maxRetries: 1,
    ...overrides,
  });
}

/** `count` chunks of exactly `size` characters, distinguishable from each other. */
function chunks(count, size, tag = "c") {
  return Array.from({ length: count }, (_, i) => {
    const head = `${tag}${i}:`;
    const text = head + "x".repeat(Math.max(0, size - head.length));
    allOfferedChunks.add(text);
    return { id: `${tag}${i}`, text };
  });
}

async function run(name, fn) {
  activePrefs = new Map();
  try {
    await fn();
  } catch (error) {
    console.error(`FAILED: ${name}`);
    throw error;
  }
  console.log(`ok - ${name}`);
}

// ===========================================================================
// 1. Pure capacity algorithm
// ===========================================================================

await run("unbounded until a length failure is observed", () => {
  let state = capacity.createCapacityState();
  assert.equal(capacity.capacityBudget(state), Infinity);

  // Successes alone never impose a ceiling: an endpoint that has not refused
  // anything must not be throttled by the size of the last document.
  state = capacity.recordCapacitySuccess(state, 5000);
  assert.equal(capacity.capacityBudget(state), Infinity);
  assert.equal(state.successChars, 5000);
});

await run("halves down from the failure until something succeeds", () => {
  let state = capacity.createCapacityState();
  state = capacity.recordCapacityLengthFailure(state, 40000);
  assert.equal(capacity.capacityBudget(state), 20000);

  state = capacity.recordCapacityLengthFailure(state, 20000);
  assert.equal(capacity.capacityBudget(state), 10000);
});

await run("bisects between the proven bounds and converges", () => {
  let state = capacity.createCapacityState();
  state = capacity.recordCapacityLengthFailure(state, 40000);
  state = capacity.recordCapacitySuccess(state, 20000);

  // Midpoint of [20000, 40000).
  assert.equal(capacity.capacityBudget(state), 30000);
  assert.equal(state.converged, false);

  state = capacity.recordCapacitySuccess(state, 30000);
  assert.equal(capacity.capacityBudget(state), 35000);

  state = capacity.recordCapacityLengthFailure(state, 35000);
  assert.equal(capacity.capacityBudget(state), 32500);

  // Squeeze until the gap is inside the tolerance.
  let guard = 0;
  while (!state.converged && guard++ < 100) {
    const budget = capacity.capacityBudget(state);
    state = capacity.recordCapacitySuccess(state, budget);
  }
  assert.ok(state.converged, "bisection must terminate");
  assert.ok(state.successChars < state.failureChars);
  assert.ok(
    state.failureChars - state.successChars <=
      Math.max(
        capacity.CAPACITY_CONVERGE_ABS_CHARS,
        state.successChars * capacity.CAPACITY_CONVERGE_REL,
      ),
  );
  // A converged endpoint reuses its proven safe budget directly.
  assert.equal(capacity.capacityBudget(state), state.successChars);
});

await run("a contradicting measurement discards the stale bound", () => {
  // Success above the recorded failure: the upper bound was wrong, so it is
  // dropped rather than pinning the budget to a number we know is achievable.
  let state = capacity.createCapacityState();
  state = capacity.recordCapacityLengthFailure(state, 10000);
  state = capacity.recordCapacitySuccess(state, 12000);
  assert.equal(state.failureChars, null);
  assert.equal(state.successChars, 12000);

  // Failure at or below the recorded success: the floor is no longer proven,
  // so the next budget drops to half the failure. This strict decrease is what
  // makes the retry loop terminate instead of resending the same batch.
  state = capacity.createCapacityState();
  state = capacity.recordCapacitySuccess(state, 10000);
  state = capacity.recordCapacityLengthFailure(state, 8000);
  assert.equal(state.successChars, null);
  assert.equal(state.failureChars, 8000);
  assert.equal(capacity.capacityBudget(state), 4000);
});

await run("packing never splits a chunk and never returns nothing", () => {
  const items = chunks(5, 100, "pack");

  // Budget fits two whole chunks; the third would overflow it.
  const two = capacity.packBatch(items, 0, 250, 100);
  assert.equal(two.length, 2);
  assert.equal(capacity.totalChars(two), 200);

  // Budget below one chunk still yields exactly one, intact.
  const one = capacity.packBatch(items, 0, 10, 100);
  assert.equal(one.length, 1);
  assert.equal(one[0].text, items[0].text);

  // The item cap binds independently of the character budget.
  const capped = capacity.packBatch(items, 0, Infinity, 3);
  assert.equal(capped.length, 3);
});

await run("persisted records are per endpoint and survive a round trip", () => {
  const a = capacity.capacityKey("openai", "https://api.openai.com/v1", "text-embedding-3-small");
  const b = capacity.capacityKey("openai", "https://api.openai.com/v1", "text-embedding-3-large");
  const c = capacity.capacityKey("ollama", "http://localhost:11434", "text-embedding-3-small");
  assert.notEqual(a, b, "a different model is a different capacity");
  assert.notEqual(a, c, "a different host is a different capacity");
  // Trailing slashes and case are not identity.
  assert.equal(
    a,
    capacity.capacityKey("OpenAI", "https://API.openai.com/v1/", "text-embedding-3-small"),
  );

  const state = capacity.recordCapacitySuccess(
    capacity.recordCapacityLengthFailure(capacity.createCapacityState(), 9000),
    8500,
  );
  const records = capacity.writeCapacityRecord({}, a, state);
  const reloaded = capacity.parseCapacityRecords(JSON.stringify(records));
  assert.equal(reloaded[a].successChars, 8500);
  assert.equal(reloaded[a].failureChars, 9000);
  assert.equal(reloaded[a].converged, true);

  // Garbage in the pref must not poison the search.
  assert.deepEqual(capacity.parseCapacityRecords("not json"), {});
  const nonsense = capacity.parseCapacityRecords(
    JSON.stringify({ [a]: { successChars: 900, failureChars: 100 } }),
  );
  assert.equal(nonsense[a].successChars, 900);
  assert.equal(nonsense[a].failureChars, null, "impossible bound is discarded");

  // Old endpoints are evicted, the one just written is not.
  let many = {};
  for (let i = 0; i < capacity.CAPACITY_STORE_MAX_ENTRIES + 5; i++) {
    many = capacity.writeCapacityRecord(many, `k${i}`, {
      ...capacity.createCapacityState(i + 1),
      successChars: 100,
    });
  }
  const keys = Object.keys(many);
  assert.equal(keys.length, capacity.CAPACITY_STORE_MAX_ENTRIES);
  assert.ok(keys.includes(`k${capacity.CAPACITY_STORE_MAX_ENTRIES + 4}`));
  assert.ok(!keys.includes("k0"), "the oldest entry is evicted first");
});

// ===========================================================================
// 2. embedBatch: learning against a real (fake) endpoint
// ===========================================================================

await run("batch shrinks on a length refusal, then climbs back up", async () => {
  // 8000-char server limit; 60 chunks of 500 chars = 30000 chars in total.
  setMaxBatchItems(2048);
  activeServer = makeServer({ limitChars: 8000 });
  const service = newService();
  const items = chunks(60, 500, "doc");

  const results = await service.embedBatch(items);
  assert.equal(results.size, 60, "every chunk gets a vector");

  const calls = activeServer.calls;
  // First request is unbounded: everything the item cap allows.
  assert.equal(calls[0].count, 60);
  assert.equal(calls[0].chars, 30000);
  // It was refused, so the next attempt is half.
  assert.ok(calls[1].chars <= 15000, `expected <=15000, got ${calls[1].chars}`);

  const accepted = calls.filter((c) => c.chars <= 8000);
  const refused = calls.filter((c) => c.chars > 8000);
  assert.ok(accepted.length > 0);
  for (const call of refused) {
    assert.ok(call.chars > 8000, "only oversized requests may be refused");
  }

  // The point of bisection: later batches approach the true limit from below
  // instead of staying at whatever small size first happened to work.
  const acceptedSizes = accepted.map((c) => c.chars);
  const firstOk = acceptedSizes[0];
  const best = Math.max(...acceptedSizes);
  assert.ok(
    best > firstOk,
    `later batches must grow past the first success (${firstOk} -> ${best})`,
  );
  assert.ok(best >= 6000, `should approach the 8000 limit, reached ${best}`);

  // ...and what it learned is written down, inside the true limit.
  const learned = service.getBatchCapacity();
  assert.ok(learned.successChars >= 6000 && learned.successChars <= 8000);
  assert.ok(learned.failureChars > 8000 === false || learned.failureChars > learned.successChars);
});

await run("a converged budget is reused instead of re-probing", async () => {
  setMaxBatchItems(2048);
  activeServer = makeServer({ limitChars: 8000 });
  const first = newService();
  await first.embedBatch(chunks(60, 500, "warm"));
  const learnedCalls = activeServer.calls.length;
  const learned = first.getBatchCapacity();
  assert.ok(learned.successChars > 0);

  // A second service reads the same pref: no failed probe at all this time.
  activeServer = makeServer({ limitChars: 8000 });
  const second = newService();
  const results = await second.embedBatch(chunks(60, 500, "hot"));
  assert.equal(results.size, 60);
  for (const call of activeServer.calls) {
    assert.ok(
      call.chars <= 8000,
      `a warm start must not resend an oversized batch (${call.chars})`,
    );
  }
  assert.ok(
    activeServer.calls.length < learnedCalls,
    "a warm start costs fewer requests than learning did",
  );
});

await run("a single oversized chunk stops the build with the exact message", async () => {
  activeServer = makeServer({ limitChars: 1000 });
  const service = newService();
  // One 3000-char chunk: no smaller request exists that keeps it whole.
  const items = chunks(1, 3000, "huge");

  await assert.rejects(
    () => service.embedBatch(items),
    (error) => {
      assert.equal(error.name, "EmbeddingAPIError");
      assert.equal(error.type, "chunk_too_large");
      assert.equal(error.retryable, false);
      assert.equal(error.getUserMessage(), SINGLE_CHUNK_TOO_LARGE_MESSAGE);
      assert.match(
        error.message,
        /单个 Chunk 已超过当前向量模型\/API允许的输入长度，请降低 Chunk 长度或更换支持更长输入的向量模型。/,
      );
      return true;
    },
  );

  // Nothing was embedded, and nothing shorter than the chunk was ever sent.
  for (const call of activeServer.calls) {
    assert.equal(call.count, 1);
    assert.equal(call.texts[0], items[0].text, "the chunk must go out intact");
  }
});

await run("an oversized chunk inside a document fails the document", async () => {
  activeServer = makeServer({ limitChars: 2000 });
  const service = newService();
  const items = [
    ...chunks(4, 400, "small"),
    { id: "giant", text: "G".repeat(5000) },
    ...chunks(2, 400, "tail"),
  ];
  allOfferedChunks.add(items[4].text);

  await assert.rejects(
    () => service.embedBatch(items),
    (error) => error.type === "chunk_too_large",
  );
  // The giant chunk was offered whole and refused whole; no prefix of it was
  // ever sent as a consolation vector.
  const giantCalls = activeServer.calls.filter((c) =>
    c.texts.some((t) => t.startsWith("GGG")),
  );
  assert.ok(giantCalls.length > 0);
  for (const call of giantCalls) {
    for (const text of call.texts) {
      if (text.startsWith("G")) assert.equal(text.length, 5000);
    }
  }
});

// ---------------------------------------------------------------------------
// Non-length errors must leave the learned capacity untouched
// ---------------------------------------------------------------------------

const NON_LENGTH_FAILURES = [
  {
    name: "429 rate limit whose body mentions a token limit",
    // The exact trap the old classifier fell into: OpenAI words its throughput
    // throttle in tokens, and matching on "token limit" turned every busy
    // afternoon into a permanently shrunken batch.
    error: () =>
      httpError(
        429,
        { error: { message: "Rate limit reached: token limit exceeded, 150000 tokens per min (TPM)" } },
        { "retry-after": "1" },
      ),
    type: "rate_limit",
  },
  {
    name: "403 quota exhausted",
    error: () =>
      httpError(403, {
        error: { message: "You exceeded your current quota, please check your plan and billing" },
      }),
    type: "auth",
  },
  {
    name: "401 bad key",
    error: () => httpError(401, { error: { message: "Invalid API key provided" } }),
    type: "auth",
  },
  {
    name: "500 whose body echoes the oversized request",
    error: () =>
      httpError(500, {
        error: { message: "internal error while handling input length 30000" },
      }),
    type: "server",
  },
  {
    name: "request timeout",
    error: () => Object.assign(new Error("Request timeout"), { status: 0 }),
    type: "network",
  },
  {
    name: "400 that is not about size",
    error: () =>
      httpError(400, { error: { message: "Unsupported value for parameter 'encoding_format'" } }),
    type: "invalid_request",
  },
];

for (const scenario of NON_LENGTH_FAILURES) {
  await run(`no capacity learning from: ${scenario.name}`, async () => {
    activeServer = makeServer({ reject: () => scenario.error() });
    const service = newService();
    const before = service.getBatchCapacity();
    assert.equal(before.successChars, null);
    assert.equal(before.failureChars, null);

    await assert.rejects(
      () => service.embedBatch(chunks(20, 500, "err")),
      (error) => {
        assert.equal(
          error.type,
          scenario.type,
          `expected ${scenario.type}, got ${error.type}: ${error.message}`,
        );
        return true;
      },
    );

    const after = service.getBatchCapacity();
    assert.equal(after.successChars, null, "a non-length error proves no floor");
    assert.equal(after.failureChars, null, "a non-length error proves no ceiling");
    assert.equal(
      activePrefs.get("extensions.zotero.zotero-mcp-plugin.embedding.batchCapacity"),
      undefined,
      "nothing may be persisted",
    );
  });
}

await run("a non-length error after learning does not narrow the bounds", async () => {
  // Learn a real capacity first...
  setMaxBatchItems(2048);
  activeServer = makeServer({ limitChars: 8000 });
  const service = newService();
  await service.embedBatch(chunks(60, 500, "pre"));
  const learned = service.getBatchCapacity();
  assert.ok(learned.successChars > 0);

  // ...then have the endpoint fall over for an unrelated reason.
  activeServer = makeServer({
    limitChars: 8000,
    reject: () => httpError(503, { error: { message: "upstream unavailable" } }),
  });
  await assert.rejects(
    () => service.embedBatch(chunks(20, 500, "post")),
    (error) => error.type === "server",
  );

  const after = service.getBatchCapacity();
  assert.equal(after.successChars, learned.successChars);
  assert.equal(after.failureChars, learned.failureChars);
});

// ---------------------------------------------------------------------------
// Isolation between endpoints
// ---------------------------------------------------------------------------

await run("capacity learned for one model is not applied to another", async () => {
  // A tight endpoint teaches a small budget.
  setMaxBatchItems(2048);
  activeServer = makeServer({ limitChars: 3000 });
  const tight = newService({ model: "tiny-context", apiBase: "https://tiny.example.com/v1" });
  await tight.embedBatch(chunks(40, 500, "tiny"));
  const tightState = tight.getBatchCapacity();
  assert.ok(tightState.successChars <= 3000);

  // A roomy endpoint, sharing the same pref store, must start unbounded.
  activeServer = makeServer({ limitChars: Infinity });
  const roomy = newService({ model: "big-context", apiBase: "https://big.example.com/v1" });
  const roomyBefore = roomy.getBatchCapacity();
  assert.notEqual(roomyBefore.key, tightState.key);
  assert.equal(roomyBefore.successChars, null);

  await roomy.embedBatch(chunks(40, 500, "big"));
  assert.equal(activeServer.calls.length, 1, "no probing on a healthy endpoint");
  assert.equal(activeServer.calls[0].chars, 20000);

  // The tight endpoint's record is still intact and still small.
  assert.equal(tight.getBatchCapacity().successChars, tightState.successChars);
  assert.ok(roomy.getBatchCapacity().successChars >= 20000);
});

await run("changing the model on one service re-keys its capacity", async () => {
  setMaxBatchItems(2048);
  activeServer = makeServer({ limitChars: 3000 });
  const service = newService({ model: "model-a" });
  await service.embedBatch(chunks(40, 500, "a"));
  const stateA = service.getBatchCapacity();
  assert.ok(stateA.failureChars !== null);

  service.updateConfig({ model: "model-b" });
  const stateB = service.getBatchCapacity();
  assert.notEqual(stateB.key, stateA.key);
  assert.equal(stateB.successChars, null, "the new model starts from scratch");
  assert.equal(stateB.failureChars, null);
});



// ===========================================================================
// 3. The inputs-per-request limit
// ===========================================================================

await run("the setting is clamped, and junk falls back to the default", () => {
  assert.equal(DEFAULT_MAX_BATCH_ITEMS, 20);
  assert.equal(resolveMaxBatchItems(20), 20);
  assert.equal(resolveMaxBatchItems("20"), 20);
  assert.equal(resolveMaxBatchItems(1), 1);
  assert.equal(resolveMaxBatchItems(2048), MAX_MAX_BATCH_ITEMS);
  // Above the ceiling is clamped, not honoured.
  assert.equal(resolveMaxBatchItems(999999), MAX_MAX_BATCH_ITEMS);
  // Anything that would mean "no limit" must NOT mean "send everything".
  for (const junk of [0, -1, "", "abc", null, undefined, NaN]) {
    assert.equal(
      resolveMaxBatchItems(junk),
      DEFAULT_MAX_BATCH_ITEMS,
      `${String(junk)} must fall back to the default, never to unbounded`,
    );
  }
  assert.equal(resolveMaxBatchItems(7.9), 7, "fractions floor");
});

await run("27, 74 and 152 chunks split exactly at a limit of 20", async () => {
  // The three batch sizes from the reported log.
  const expected = {
    27: [20, 7],
    74: [20, 20, 20, 14],
    152: [20, 20, 20, 20, 20, 20, 20, 12],
  };
  for (const [count, split] of Object.entries(expected)) {
    activePrefs = new Map();
    setMaxBatchItems(20);
    activeServer = makeServer({ limitChars: Infinity });
    const service = newService();
    const items = chunks(Number(count), 400, `s${count}`);
    const results = await service.embedBatch(items);

    assert.equal(results.size, Number(count), `${count} chunks all embedded`);
    assert.deepEqual(
      activeServer.calls.map((c) => c.count),
      split,
      `${count} chunks must split as ${split.join("+")}`,
    );
    assert.equal(
      split.reduce((a, b) => a + b, 0),
      Number(count),
      "the split must account for every chunk",
    );
  }
});

await run("the count limit and the character budget both bind", async () => {
  // 20 inputs allowed, but only 3000 characters — so the character budget is
  // the tighter of the two and decides. Neither limit may stand in for the
  // other: 20 chunks of 1000 chars is a legal batch size and an illegal
  // payload, and one chunk of 200 chars is the reverse of nothing at all.
  setMaxBatchItems(20);
  activeServer = makeServer({ limitChars: 3000 });
  const service = newService();
  await service.embedBatch(chunks(60, 1000, "both"));

  for (const call of activeServer.calls) {
    assert.ok(call.count <= 20, `count limit breached: ${call.count}`);
  }
  const accepted = activeServer.calls.filter((c) => c.chars <= 3000);
  assert.ok(accepted.length > 0);
  for (const call of accepted) {
    assert.ok(
      call.count <= 3,
      `1000-char chunks under a 3000-char budget must be <=3 per request, got ${call.count}`,
    );
  }
  // The learned character capacity is real and below the count limit's reach.
  assert.ok(service.getBatchCapacity().successChars <= 3000);
  assert.equal(service.getBatchCapacity().maxItems, 20);
});

await run("the count limit binds when the character budget is loose", async () => {
  // The mirror image: plenty of character headroom, so the count is what caps
  // the request. If the two were conflated this is the case that would send
  // everything in one go — which is exactly the reported bug.
  setMaxBatchItems(20);
  activeServer = makeServer({ limitChars: Infinity });
  const service = newService();
  await service.embedBatch(chunks(50, 50, "loose"));

  assert.deepEqual(
    activeServer.calls.map((c) => c.count),
    [20, 20, 10],
  );
  // No length failure ever happened, so the character budget stayed unbounded
  // — proving the split came from the count limit alone.
  assert.equal(service.getBatchCapacity().failureChars, null);
});

await run("a limit of 1 sends one chunk at a time", async () => {
  setMaxBatchItems(1);
  activeServer = makeServer({ limitChars: Infinity });
  const service = newService();
  await service.embedBatch(chunks(5, 300, "one"));
  assert.deepEqual(
    activeServer.calls.map((c) => c.count),
    [1, 1, 1, 1, 1],
  );
});

await run("changing the setting takes effect on the next request", async () => {
  // Requirement 7: no rebuild, no cache to clear, no vectors invalidated.
  setMaxBatchItems(20);
  activeServer = makeServer({ limitChars: Infinity });
  const service = newService();
  await service.embedBatch(chunks(30, 100, "before"));
  assert.deepEqual(activeServer.calls.map((c) => c.count), [20, 10]);

  setMaxBatchItems(5);
  activeServer = makeServer({ limitChars: Infinity });
  // Same service instance — the limit is read per request, not cached at
  // construction, so no restart is needed for the change to apply.
  await service.embedBatch(chunks(12, 100, "after"));
  assert.deepEqual(activeServer.calls.map((c) => c.count), [5, 5, 2]);
});

// ---------------------------------------------------------------------------
// The reported failure, end to end
// ---------------------------------------------------------------------------

await run("the reported Alibaba MaaS failure now indexes cleanly", async () => {
  // The exact shape from the log: an OpenAI-compatible Alibaba Cloud MaaS
  // endpoint whose hostname is not dashscope.aliyuncs.com, accepting at most
  // 20 inputs, and a document of 152 chunks. Before the fix the whole document
  // went out in one request and came back 400 invalid_request, non-retryable,
  // so every document that needed re-embedding failed.
  activeServer = makeServer({
    limitChars: Infinity,
    reject: (_n, texts) =>
      texts.length > 20
        ? httpError(400, {
            error: {
              message: "batch size is invalid, it should not be larger than 20",
            },
          })
        : null,
  });
  const service = newService({
    apiBase: "https://maas-api.example-aliyun.com/v1",
    model: "qwen3.7-text-embedding",
  });

  for (const count of [27, 37, 74, 114, 152]) {
    activeServer.calls.length = 0;
    const items = chunks(count, 420, `maas${count}`);
    const results = await service.embedBatch(items);
    assert.equal(results.size, count, `${count} chunks must all be embedded`);
    for (const call of activeServer.calls) {
      assert.ok(
        call.count <= 20,
        `${count}-chunk document still sent a batch of ${call.count}`,
      );
    }
  }
});

await run("a batch-size refusal keeps the server's words and names the fix", async () => {
  // Requirement 6: if the user's setting is still too high, the real error
  // survives and the message says which setting to change and to what.
  setMaxBatchItems(50);
  activeServer = makeServer({
    limitChars: Infinity,
    reject: (_n, texts) =>
      texts.length > 20
        ? httpError(400, {
            error: {
              message: "batch size is invalid, it should not be larger than 20",
            },
          })
        : null,
  });
  const service = newService();

  await assert.rejects(
    () => service.embedBatch(chunks(50, 100, "over")),
    (error) => {
      assert.equal(error.type, "batch_too_many_inputs");
      assert.equal(error.retryable, false);
      // The server's own sentence, verbatim.
      assert.match(error.message, /batch size is invalid, it should not be larger than 20/);
      // How many we actually sent.
      assert.match(error.message, /50/);
      // The setting to change, and the number to change it to.
      assert.match(error.message, /单次请求最大批量/);
      assert.match(error.message, /Max inputs per request/);
      assert.match(error.message, /改为 20 或更小/);
      assert.equal(error.getUserMessage(), error.message);
      return true;
    },
  );

  // A count refusal says nothing about how much TEXT fits, so it must not
  // touch the learned character capacity.
  assert.equal(service.getBatchCapacity().successChars, null);
  assert.equal(service.getBatchCapacity().failureChars, null);
});

await run("the server's stated limit is extracted from many phrasings", () => {
  const cases = [
    ["batch size is invalid, it should not be larger than 20", 20],
    ["Batch size should not be greater than 10", 10],
    ["you may submit at most 16 inputs per request", 16],
    ["maximum of 64 inputs allowed", 64],
    ["The batch size limit is 25", 25],
    ["up to 32 texts per request", 32],
    ["expected no more than 8 items", 8],
  ];
  for (const [message, expected] of cases) {
    assert.equal(extractBatchLimit(message), expected, message);
  }
  // Nothing to extract, and nothing invented.
  assert.equal(extractBatchLimit("batch size is invalid"), null);
  assert.equal(extractBatchLimit("too many inputs"), null);
  // Out-of-range numbers are not credible limits.
  assert.equal(extractBatchLimit("not larger than 999999"), null);
});

await run("a count refusal is never confused with a length refusal", async () => {
  // The two are separate failures with separate fixes. Classifying a count
  // limit as payload_too_large would send the plugin bisecting the character
  // budget forever against a server that never objected to the text at all.
  setMaxBatchItems(40);
  activeServer = makeServer({
    limitChars: Infinity,
    reject: (_n, texts) =>
      texts.length > 20
        ? httpError(400, { error: { message: "too many inputs in one request" } })
        : null,
  });
  const service = newService();
  await assert.rejects(
    () => service.embedBatch(chunks(40, 100, "cnt")),
    (error) => error.type === "batch_too_many_inputs",
  );
  assert.equal(activeServer.calls.length, 1, "no bisection was attempted");

  // ...and the reverse still classifies as a length problem.
  activePrefs = new Map();
  setMaxBatchItems(2048);
  activeServer = makeServer({ limitChars: 4000 });
  const other = newService();
  await other.embedBatch(chunks(30, 500, "len"));
  assert.ok(other.getBatchCapacity().failureChars !== null);
});

await run("no provider table decides the batch size any more", () => {
  const source = fs.readFileSync(
    path.join(rootDir, "src/modules/semantic/embeddingService.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /getProviderMaxBatchSize/,
    "the per-provider batch table must be gone",
  );
  // Same limit regardless of how the endpoint is detected: the number comes
  // from the user, not from the hostname.
  for (const apiBase of [
    "https://api.openai.com/v1",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "http://localhost:11434",
    "https://maas-api.example-aliyun.com/v1",
  ]) {
    activePrefs = new Map();
    setMaxBatchItems(20);
    assert.equal(
      newService({ apiBase }).getBatchCapacity().maxItems,
      20,
      `${apiBase} must honour the user's setting`,
    );
  }
  // And with nothing configured, the conservative default applies everywhere.
  activePrefs = new Map();
  assert.equal(newService().getBatchCapacity().maxItems, DEFAULT_MAX_BATCH_ITEMS);
});

await run("the setting is exposed in the preferences UI", () => {
  const xhtml = fs.readFileSync(
    path.join(rootDir, "addon/content/preferences.xhtml"),
    "utf8",
  );
  assert.match(xhtml, /embedding\.maxBatchItems" type="int"/, "pref declared");
  assert.match(xhtml, /embedding-max-batch-items/, "input present");
  assert.match(xhtml, /min="1" max="2048" placeholder="20"/, "bounds on the field");

  const prefsJs = fs.readFileSync(path.join(rootDir, "addon/prefs.js"), "utf8");
  assert.match(prefsJs, /pref\("embedding\.maxBatchItems", 20\);/);

  const script = fs.readFileSync(
    path.join(rootDir, "src/modules/preferenceScript.ts"),
    "utf8",
  );
  assert.match(
    script,
    /embedding-max-batch-items`,\s*\n\s*"extensions\.zotero\.zotero-mcp-plugin\.embedding\.maxBatchItems",\s*\n\s*1,\s*\n\s*2048,\s*\n\s*20,/,
    "bound with the 1-2048 range and a default of 20",
  );

  const locales = fs
    .readdirSync(path.join(rootDir, "addon/locale"))
    .filter((entry) =>
      fs.existsSync(path.join(rootDir, "addon/locale", entry, "preferences.ftl")),
    );
  assert.ok(locales.length >= 6);
  for (const locale of locales) {
    const ftl = fs.readFileSync(
      path.join(rootDir, "addon/locale", locale, "preferences.ftl"),
      "utf8",
    );
    for (const key of [
      "pref-embedding-max-batch-items-label",
      "pref-embedding-max-batch-items-hint",
    ]) {
      assert.match(ftl, new RegExp(`^${key} = \\S`, "m"), `${locale}/${key}`);
    }
  }
});

await run("a batch-size refusal pauses the build instead of failing every item", () => {
  const serviceSource = fs.readFileSync(
    path.join(rootDir, "src/modules/semantic/semanticSearchService.ts"),
    "utf8",
  );
  const block = serviceSource.slice(
    serviceSource.indexOf("const isGlobalError ="),
    serviceSource.indexOf("const isGlobalError =") + 400,
  );
  assert.match(
    block,
    /error\.type === 'batch_too_many_inputs'/,
    "it is a run-level problem: every remaining document would fail identically",
  );
});

// ===========================================================================
// 4. The truncation guarantee
// ===========================================================================

await run("no request ever carried a truncated chunk", () => {
  assert.ok(allSentTexts.length > 50, "the scenarios above must have sent traffic");
  for (const text of allSentTexts) {
    assert.ok(
      allOfferedChunks.has(text),
      `a text was sent that is not a verbatim chunk (${text.length} chars): ${text.slice(0, 40)}...`,
    );
  }
  // Specifically: nothing 800 characters long, the old truncation width.
  assert.equal(
    allSentTexts.filter((t) => t.length === 800).length,
    0,
    "an 800-character body is the signature of the removed truncation path",
  );
});

await run("the truncation code is gone from the source", () => {
  const source = fs.readFileSync(
    path.join(rootDir, "src/modules/semantic/embeddingService.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /MAX_SAFE_LENGTH/, "the truncation constant must be gone");
  assert.doesNotMatch(source, /Truncating oversized/, "the truncation branch must be gone");

  // The batching loop is the only place that decides what text goes out, so it
  // is the only place a chunk could be shortened. It must not shorten anything
  // — no substring, no slice, no fixed-width cap. (Elsewhere in the file those
  // methods legitimately clip log previews and error bodies, which never reach
  // the wire, so the check is scoped to this function rather than to the file.)
  const batchStart = source.indexOf("async embedBatch(");
  assert.ok(batchStart > 0, "embedBatch must exist");
  const batchEnd = source.indexOf("\n  private estimateTokens(", batchStart);
  assert.ok(batchEnd > batchStart, "could not delimit embedBatch");
  const batchBody = source.slice(batchStart, batchEnd);
  assert.doesNotMatch(batchBody, /\.substring\(/, "embedBatch must not shorten a chunk");
  assert.doesNotMatch(batchBody, /\.slice\(/, "embedBatch must not shorten a chunk");
  assert.doesNotMatch(batchBody, /\b800\b/, "no 800-character cap may survive");
  // The single-chunk case must terminate rather than degrade.
  assert.match(source, /'chunk_too_large'/);
  assert.match(source, /SINGLE_CHUNK_TOO_LARGE_MESSAGE/);

  // And the build must never treat it as one more failed item quietly logged
  // while the rest of the library follows it into the same wall. It is put to
  // the user — skip these documents, or stop and fix the setting — which
  // test-chunk-oversize-policy.js covers in full; here we only pin down that
  // the build does not decide it silently.
  const serviceSource = fs.readFileSync(
    path.join(rootDir, "src/modules/semantic/semanticSearchService.ts"),
    "utf8",
  );
  assert.match(
    serviceSource,
    /error\.type === 'chunk_too_large'[\s\S]{0,200}resolveChunkTooLarge\(/,
    "chunk_too_large must be routed to the user's decision",
  );
});

console.log("\nAll embedding batching tests passed.");
