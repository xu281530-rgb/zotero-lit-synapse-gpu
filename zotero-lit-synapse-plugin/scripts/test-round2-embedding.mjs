import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register("./ts-ext-hooks.mjs", import.meta.url);

const prefPrefix = "extensions.zotero.zotero-lit-synapse.embedding.";
const prefs = new Map();
let requestHandler;
globalThis.Zotero = {
  Libraries: { userLibraryID: 1 },
  Prefs: {
    get: (key) => prefs.get(key),
    set: (key, value) => prefs.set(key, value),
    clear: (key) => prefs.delete(key),
  },
  HTTP: { request: (...args) => requestHandler(...args) },
};
globalThis.ztoolkit = { log: () => undefined };

const { EmbeddingService } = await import(
  "../src/modules/semantic/embeddingService.ts"
);
const { SemanticSearchService } = await import(
  "../src/modules/semantic/semanticSearchService.ts"
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeSearchService(embed, search) {
  const service = Object.create(SemanticSearchService.prototype);
  service.initialize = async () => undefined;
  service.embeddingService = { embed };
  service.vectorStore = { search };
  return service;
}

function queryVector() {
  return {
    embedding: new Float32Array([1, 0]),
    language: "en",
    dimensions: 2,
    identity: {
      apiBase: "http://127.0.0.1:11434",
      provider: "ollama",
      model: "qwen3-embedding",
      dimensions: 2,
      requestedDimensions: 2,
    },
  };
}

test("single-paper cancellation reaches the local scanner before another batch", async () => {
  const controller = new AbortController();
  let embeddingSignal;
  let receivedSignal;
  let completedBatches = 0;
  const service = makeSearchService(
    async (_query, _language, _isQuery, options) => {
      embeddingSignal = options.signal;
      return queryVector();
    },
    async (_vector, options) => {
      receivedSignal = options.signal;
      controller.abort();
      for (let batch = 0; batch < 3; batch++) {
        if (options.signal?.aborted) throw new Error("Vector scan cancelled");
        await Promise.resolve();
        completedBatches++;
      }
      return [];
    },
  );
  await assert.rejects(
    service.searchItemChunks("query", {
      itemKey: "PAPER001",
      libraryID: 1,
      topK: 3,
      signal: controller.signal,
    }),
    /cancelled/iu,
  );
  assert.equal(receivedSignal, embeddingSignal);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(completedBatches, 0);
});

test("cancellation at the end of embedding prevents starting a local scan", async () => {
  const controller = new AbortController();
  let scans = 0;
  const service = makeSearchService(
    async () => {
      controller.abort();
      return queryVector();
    },
    async () => {
      scans++;
      return [];
    },
  );
  await assert.rejects(
    service.searchItemChunks("query", {
      itemKey: "PAPER001",
      topK: 3,
      signal: controller.signal,
    }),
    /cancelled/iu,
  );
  assert.equal(scans, 0);
});

test("an already cancelled search starts neither embedding nor scanning", async () => {
  const controller = new AbortController();
  controller.abort();
  let embeddings = 0;
  let scans = 0;
  const service = makeSearchService(
    async () => {
      embeddings++;
      return queryVector();
    },
    async () => {
      scans++;
      return [];
    },
  );
  await assert.rejects(
    service.searchItemChunks("query", {
      itemKey: "PAPER001",
      topK: 3,
      signal: controller.signal,
    }),
    /cancelled/iu,
  );
  assert.equal(embeddings, 0);
  assert.equal(scans, 0);
});

test("Ollama freezes endpoint, model, explicit dimensions, headers and timeout before waiting", async () => {
  prefs.clear();
  prefs.set(`${prefPrefix}dimensions`, "2");
  const service = new EmbeddingService({
    apiBase: "http://127.0.0.1:11434",
    apiKey: "old-test-key",
    model: "qwen3-embedding",
    dimensions: 2,
    timeout: 12345,
    maxRetries: 2,
  });
  const waiting = deferred();
  const release = deferred();
  service.checkRateLimit = () => ({ canProceed: false, waitMs: 1 });
  service.waitForRateLimit = async () => {
    waiting.resolve();
    await release.promise;
  };
  const calls = [];
  requestHandler = async (_method, url, options) => {
    const body = JSON.parse(options.body);
    calls.push({
      url,
      body,
      headers: options.headers,
      timeout: options.timeout,
    });
    return {
      status: 200,
      response: {
        model: "qwen3-embedding:actual",
        embeddings: [[0.5, 0.5, 0.5]],
      },
    };
  };
  const pending = service.embed("A pending note embedding");
  await waiting.promise;
  service.updateConfig({
    apiBase: "https://new-endpoint.invalid/v1",
    apiProvider: "openai",
    apiKey: "new-test-key",
    model: "unsupported-custom-model",
    dimensions: 3,
    timeout: 99999,
  });
  release.resolve();
  const result = await pending;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/embed");
  assert.equal(calls[0].body.model, "qwen3-embedding");
  assert.equal(calls[0].body.dimensions, 2);
  assert.equal(calls[0].headers.Authorization, "Bearer old-test-key");
  assert.equal(calls[0].timeout, 12345);
  assert.equal(result.identity.requestedDimensions, 2);
  assert.equal(result.identity.dimensions, 3);
  assert.equal(result.dimensions, 3);
  assert.equal(result.identity.model, "qwen3-embedding:actual");
  assert.equal(result.identity.apiBase, "http://127.0.0.1:11434");
  assert.equal(result.identity.provider, "ollama");
});

test("Ollama preserves absence of explicit dimensions throughout waiting", async () => {
  prefs.clear();
  const service = new EmbeddingService({
    apiBase: "http://127.0.0.1:11434",
    model: "qwen3-embedding",
    maxRetries: 1,
  });
  const waiting = deferred();
  const release = deferred();
  service.checkRateLimit = () => ({ canProceed: false, waitMs: 1 });
  service.waitForRateLimit = async () => {
    waiting.resolve();
    await release.promise;
  };
  let requestBody;
  requestHandler = async (_method, _url, options) => {
    requestBody = JSON.parse(options.body);
    return { status: 200, response: { embeddings: [[0.5, 0.5, 0.5, 0.5]] } };
  };
  const pending = service.embed("Native output dimensionality");
  await waiting.promise;
  service.updateConfig({ dimensions: 3 });
  release.resolve();
  const result = await pending;
  assert.equal(Object.hasOwn(requestBody, "dimensions"), false);
  assert.equal(result.identity.requestedDimensions, undefined);
  assert.equal(result.identity.dimensions, 4);
});

test("Ollama retries the original request after configuration changes during a 429 wait", async () => {
  prefs.clear();
  prefs.set(`${prefPrefix}dimensions`, "2");
  const service = new EmbeddingService({
    apiBase: "http://127.0.0.1:11434",
    model: "qwen3-embedding",
    dimensions: 2,
    maxRetries: 2,
  });
  service.checkRateLimit = () => ({ canProceed: true });
  service.waitForRateLimit = async () => {
    service.updateConfig({ dimensions: 7 });
  };
  const bodies = [];
  requestHandler = async (_method, _url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1)
      throw Object.assign(new Error("Rate limit"), { status: 429 });
    return { status: 200, response: { embeddings: [[0.5, 0.5]] } };
  };
  const result = await service.embed("Retry an existing document embedding");
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[1].dimensions, 2);
  assert.equal(result.identity.requestedDimensions, 2);
});

test("every batch keeps the initial Ollama dimensions preference", async () => {
  prefs.clear();
  prefs.set(`${prefPrefix}dimensions`, "2");
  prefs.set(`${prefPrefix}maxBatchItems`, 1);
  const service = new EmbeddingService({
    apiBase: "http://127.0.0.1:11434",
    model: "qwen3-embedding",
    dimensions: 2,
    maxRetries: 1,
  });
  service.checkRateLimit = () => ({ canProceed: true });
  const bodies = [];
  requestHandler = async (_method, _url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    prefs.set(`${prefPrefix}dimensions`, "7");
    return {
      status: 200,
      response: { embeddings: [new Array(body.dimensions).fill(0.5)] },
    };
  };
  const results = await service.embedBatch([
    { id: "a", text: "First chunk" },
    { id: "b", text: "Second chunk" },
  ]);
  assert.equal(bodies.length, 2);
  assert.deepEqual(
    bodies.map((body) => body.dimensions),
    [2, 2],
  );
  for (const result of results.values()) {
    assert.equal(result.identity.requestedDimensions, 2);
    assert.equal(result.identity.dimensions, 2);
  }
});

test("native Zotero rate-limit headers support seconds, HTTP dates and zero delay", () => {
  const service = new EmbeddingService();
  const error = (header) => ({ status: 429, xmlhttp: { getResponseHeader: () => header } });
  assert.equal(service.detectErrorType(error("1")).retryAfterMs, 1000);
  assert.equal(service.detectErrorType(error("0")).retryAfterMs, 0);
  assert.equal(service.detectErrorType(error("invalid")).retryAfterMs, 60000);
  const future = new Date(Date.now() + 10000).toUTCString();
  const wait = service.detectErrorType(error(future)).retryAfterMs;
  assert.ok(wait >= 8500 && wait <= 10000);
});

test("a dimensions preference change cannot coalesce requests with different actual inputs", async () => {
  prefs.clear();
  const service = new EmbeddingService({
    apiBase: "http://127.0.0.1:11434",
    model: "qwen3-embedding",
    maxRetries: 1,
  });
  const entered = deferred();
  const release = deferred();
  const bodies = [];
  service.checkRateLimit = () => ({ canProceed: true });
  requestHandler = async (_method, _url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    entered.resolve();
    await release.promise;
    return {
      status: 200,
      response: { embeddings: [new Array(body.dimensions || 4).fill(0.5)] },
    };
  };
  const native = service.embed("Same query", "en", true);
  await entered.promise;
  prefs.set(`${prefPrefix}dimensions`, "2");
  const explicit = service.embed("Same query", "en", true);
  release.resolve();
  const [nativeResult, explicitResult] = await Promise.all([native, explicit]);
  assert.equal(bodies.length, 2);
  assert.equal(Object.hasOwn(bodies[0], "dimensions"), false);
  assert.equal(bodies[1].dimensions, 2);
  assert.equal(nativeResult.identity.requestedDimensions, undefined);
  assert.equal(explicitResult.identity.requestedDimensions, 2);
});
