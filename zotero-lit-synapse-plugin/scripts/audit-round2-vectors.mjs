import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";

register("./ts-ext-hooks.mjs", import.meta.url);

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

const { EmbeddingService, sameEmbeddingSpace } = await import("../src/modules/semantic/embeddingService.ts");
const { SemanticSearchService } = await import("../src/modules/semantic/semanticSearchService.ts");
const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiRetriever } = await import("../src/modules/wiki/wikiRetriever.ts");
const { hashWikiText } = await import("../src/modules/wiki/wikiCanonicalizer.ts");

function adapt(sqlite) {
  return {
    async queryAsync(sql, params = []) {
      const stmt = sqlite.prepare(sql);
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) return stmt.all(...params);
      stmt.run(...params);
      return [];
    },
    async valueQueryAsync(sql, params = []) {
      const row = sqlite.prepare(sql).get(...params);
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(fn) {
      sqlite.exec("BEGIN");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const reports = [];

// Real source classes, local SQLite, controlled HTTP adapter; no network call.
{
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const store = new WikiStore(adapt(sqlite));
  await store.initialize();
  const claimText = "Thermal gradients suppress interface instability.";
  const commit = await store.commit({
    libraryID: 1, userInitiated: true,
    actions: [
      { action: "CREATE_PAGE", ref: "p", primaryConceptRef: "c", canonicalTitle: "Solidification", primaryConcept: { canonicalName: "solidification", conceptType: "process" } },
      { action: "ADD_CLAIM", ref: "a", pageId: "p", claimText, claimType: "mechanism", epistemicStatus: "provisional", coverageLevel: "chunk_local", confidence: 0.8, evidence: [{ libraryID: 1, itemKey: "PAPER001", chunkIdSnapshot: 0, chunkTextHash: await hashWikiText(claimText), sourceContentHash: "source-a", sourceChunkSignature: "v1", sourceResetGeneration: "reset-a", excerpt: claimText, evidenceRole: "SUPPORTS", readDepth: "chunk_local" }] },
    ],
  });
  const calls = [];
  requestHandler = async (_method, url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, model: body.model, input: body.input });
    return { status: 200, response: { model: "same-alias", data: [{ index: 0, embedding: [1, 0] }] } };
  };
  const service = new EmbeddingService({ apiBase: "https://endpoint-a.invalid/v1", apiKey: "local-test", model: "same-alias", dimensions: 2, maxRetries: 1 });
  const stored = await service.embed(claimText);
  await store.saveClaimEmbedding({ claimId: commit.refs.a, vector: stored.embedding, model: stored.identity.model, textHash: await hashWikiText(claimText) });
  service.updateConfig({ apiBase: "https://endpoint-b.invalid/v1" });
  const query = "Unrelatedxylophoneresearch";
  const searched = await service.embed(query, "auto", true);
  assert.equal(sameEmbeddingSpace(stored.identity, searched.identity), false);
  const result = await new WikiRetriever(store).search({ libraryID: 1, query, queryVector: searched.embedding, queryVectorModel: searched.identity.model, minScore: 0.9 });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].normalizedWikiScore, 1);
  reports.push({ case: "cross-service-stored-wiki-embedding", identitiesCompatible: false, returnedClaims: result.claims.length, vectorScore: result.claims[0].normalizedWikiScore, endpoints: calls.map((call) => call.url) });
  sqlite.close();
}

{
  const service = Object.create(SemanticSearchService.prototype);
  service.initialize = async () => undefined;
  service.embeddingService = { embed: async () => ({ embedding: new Float32Array([1, 0]), language: "en", dimensions: 2 }) };
  const controller = new AbortController();
  let receivedSignal;
  let completedBatches = 0;
  service.vectorStore = {
    async search(_vector, options) {
      receivedSignal = options.signal;
      controller.abort();
      for (let batch = 0; batch < 3; batch++) {
        if (options.signal?.aborted) throw new Error("Vector scan cancelled");
        await Promise.resolve();
        completedBatches++;
      }
      return [];
    },
  };
  await service.searchItemChunks("query", { itemKey: "PAPER001", libraryID: 1, topK: 3, signal: controller.signal });
  assert.equal(receivedSignal, undefined);
  assert.equal(completedBatches, 3);
  reports.push({ case: "single-paper-scan-cancellation", callerCancelled: controller.signal.aborted, scanReceivedSignal: Boolean(receivedSignal), completedBatches });
}

{
  prefs.clear();
  prefs.set("extensions.zotero.zotero-lit-synapse.embedding.dimensions", "2");
  const service = new EmbeddingService({ apiBase: "http://127.0.0.1:11434", model: "qwen3-embedding", dimensions: 2, maxRetries: 1 });
  const waiting = deferred();
  const release = deferred();
  service.checkRateLimit = () => ({ canProceed: false, waitMs: 1, reason: "controlled test gate" });
  service.waitForRateLimit = async () => { waiting.resolve(); await release.promise; };
  let requestDimensions;
  requestHandler = async (_method, _url, options) => {
    const body = JSON.parse(options.body);
    requestDimensions = body.dimensions;
    return { status: 200, response: { model: body.model, embeddings: [new Array(body.dimensions).fill(0.5)] } };
  };
  const pending = service.embed("A pending note embedding");
  await waiting.promise;
  service.updateConfig({ dimensions: 3 });
  release.resolve();
  const result = await pending;
  assert.equal(requestDimensions, 3);
  assert.equal(result.identity.requestedDimensions, 2);
  reports.push({ case: "ollama-config-snapshot", actualRequestedDimensions: requestDimensions, identityRequestedDimensions: result.identity.requestedDimensions, returnedDimensions: result.dimensions });
}

console.log(JSON.stringify({ environment: "Node, in-memory SQLite, mocked HTTP; no production Zotero mutation and no network", reports }, null, 2));
