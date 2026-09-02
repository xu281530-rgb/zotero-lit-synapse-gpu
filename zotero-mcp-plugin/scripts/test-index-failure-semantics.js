/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./index-failure-hooks.mjs", import.meta.url);

const preferences = new Map();
const items = new Map();
const wikiReverifyCalls = [];
globalThis.__wikiReverifyCalls = wikiReverifyCalls;
globalThis.Zotero = {
  Libraries: { userLibraryID: 1 },
  Prefs: {
    get: (key) => preferences.get(key),
    set: (key, value) => preferences.set(key, value),
    clear: (key) => preferences.delete(key),
  },
  Items: {
    getByLibraryAndKeyAsync: async (libraryID, itemKey) =>
      items.get(`${libraryID}:${itemKey}`),
    getAsync: async () => null,
  },
};
globalThis.ztoolkit = { log: () => {} };

const { SemanticSearchService } = await import(
  "../src/modules/semantic/semanticSearchService.ts"
);
const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");

function buildStore() {
  const targets = new Map();
  const failures = new Map();
  const sessions = new Map();
  const semanticWrites = [];
  const keywordWrites = [];
  const semanticHashes = new Map();
  const chunkSignatures = new Map();
  let keywordFails = true;

  return {
    targets,
    failures,
    sessions,
    semanticWrites,
    keywordWrites,
    chunkSignatures,
    allowKeywordWrites() {
      keywordFails = false;
    },
    async createBuildSession(session, identities) {
      sessions.set(session.buildID, { ...session, resetCompleted: false });
      for (const identity of identities) {
        targets.set(
          `${session.buildID}:${identity.libraryID}:${identity.itemKey}`,
          {
            ...identity,
            state: "pending",
          },
        );
      }
    },
    async replaceItemIndex(options) {
      semanticWrites.push(options);
      semanticHashes.set(
        `${options.libraryID}:${options.itemKey}`,
        options.contentHash,
      );
    },
    // Called by indexItem BETWEEN the vector write and the keyword write, to
    // stamp the chunking rules the stored chunks were made under. It is not
    // what this suite is about, and it has to be here anyway: a double missing
    // a method the real store has does not make the caller skip it, it makes
    // the caller throw - which looked exactly like "the keyword write was
    // never attempted", the failure this suite exists to detect.
    async setChunkSignature(itemKey, signature, libraryID) {
      chunkSignatures.set(`${libraryID}:${itemKey}`, signature);
    },
    async writeKeywordIndex(options) {
      keywordWrites.push(options);
      return keywordFails
        ? { ok: false, error: "simulated keyword write failure" }
        : { ok: true, indexedChunks: options.chunks.length };
    },
    async needsReindexByTimestamp() {
      return true;
    },
    async getIndexStatus() {
      return null;
    },
    async needsReindex(itemKey, contentHash, libraryID) {
      return semanticHashes.get(`${libraryID}:${itemKey}`) !== contentHash;
    },
    async updateBuildTarget(buildID, identity, state) {
      const target = targets.get(
        `${buildID}:${identity.libraryID}:${identity.itemKey}`,
      );
      if (target) target.state = state;
    },
    async recordFailedItem(failure) {
      failures.set(`${failure.libraryID}:${failure.itemKey}`, failure);
      if (failure.buildID) {
        await this.updateBuildTarget(failure.buildID, failure, "failed");
      }
    },
    async clearFailedItems(identities) {
      for (const identity of identities ?? []) {
        failures.delete(`${identity.libraryID}:${identity.itemKey}`);
      }
    },
    async getFailedItems() {
      return [...failures.values()];
    },
    async getMetadataOnlyItems() {
      return [];
    },
    async getBuildTargets(buildID) {
      return [...targets.entries()]
        .filter(([key]) => key.startsWith(`${buildID}:`))
        .map(([, target]) => ({ ...target }));
    },
    async getBuildTargetSummary(buildID) {
      const rows = await this.getBuildTargets(buildID);
      const summary = {
        total: rows.length,
        pending: 0,
        succeeded: 0,
        failed: 0,
      };
      for (const row of rows) summary[row.state] += 1;
      return summary;
    },
    async updateBuildSessionStatus(buildID, status) {
      const session = sessions.get(buildID);
      if (session) session.status = status;
    },
    async getBuildSession(buildID) {
      return sessions.get(buildID) ?? null;
    },
    async compactKeywordIndex() {},
  };
}

function buildService(store) {
  const service = Object.create(SemanticSearchService.prototype);
  const embeddingBatches = [];
  service.initialized = true;
  service.initialize = async () => {};
  service.vectorStore = store;
  service.embeddingService = {
    embedBatch: async (batch) => {
      embeddingBatches.push(batch);
      return new Map(
        batch.map(({ id }) => [
          id,
          { embedding: new Float32Array([1, 0]), language: "en" },
        ]),
      );
    },
  };
  service.checkDimensionCompatibility = async () => ({
    compatible: true,
    storedDimensions: null,
    currentDimensions: 2,
  });
  service.extractItemContent = async () => ({
    text: "alpha beta gamma",
    hasBody: true,
    hasBodySource: true,
    bodySources: ["test"],
    failedSources: [],
  });
  service.indexProgress = {
    total: 0,
    processed: 0,
    status: "idle",
    failedCount: 0,
  };
  service._failedItems = new Map();
  service._chunkOversizeGate = { reset() {} };
  service._paused = false;
  service._aborted = false;
  service._buildActive = false;
  service._forceRun = false;
  service._activeBuildID = null;
  service._activeFullLibraryRebuild = false;
  service._databaseResetActive = false;
  service.embeddingBatches = embeddingBatches;
  return service;
}

function testItem(itemKey = "ITEM", libraryID = 2) {
  return {
    key: itemKey,
    libraryID,
    dateModified: "2026-08-18",
    isRegularItem: () => false,
    getDisplayTitle: () => "Failure semantics",
    getField: () => "",
    getTags: () => [],
    getCreators: () => [],
  };
}

async function waitForScheduledWikiReverify() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (wikiReverifyCalls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// A build target succeeds only after both writes. A keyword failure is durable
// and the public retry entry point can recover it.
{
  const item = testItem();
  items.set("2:ITEM", item);
  const store = buildStore();
  const service = buildService(store);

  const failed = await service.buildIndex({
    itemKeys: ["ITEM"],
    libraryID: 2,
    force: true,
    frozenChunkSettings: { target: 1000, tolerance: 500, signature: "test" },
  });

  assert.equal(
    store.semanticWrites.length,
    1,
    "semantic write completed first",
  );
  assert.equal(store.keywordWrites.length, 1, "keyword write was attempted");
  assert.equal(failed.status, "failed");
  assert.equal(store.failures.has("2:ITEM"), true);
  const [buildID] = store.sessions.keys();
  assert.equal(store.targets.get(`${buildID}:2:ITEM`).state, "failed");
  await waitForScheduledWikiReverify();
  assert.deepEqual(
    wikiReverifyCalls,
    [{ libraryID: 2, itemKeys: ["ITEM"] }],
    "a committed body index must reverify even when its keyword write fails",
  );
  wikiReverifyCalls.length = 0;

  store.allowKeywordWrites();
  const retried = await service.retryFailedItems();
  await waitForScheduledWikiReverify();
  assert.equal(retried.status, "completed");
  assert.equal(store.failures.size, 0);
  assert.equal(store.targets.get(`${buildID}:2:ITEM`).state, "succeeded");
  assert.equal(
    store.keywordWrites.length,
    2,
    "retry rewrites the missing keyword index",
  );
  assert.equal(
    store.semanticWrites.length,
    1,
    "retry keeps the committed semantic index",
  );
  assert.equal(
    service.embeddingBatches.length,
    1,
    "retry spends no extra embedding quota",
  );
  assert.deepEqual(wikiReverifyCalls, [{ libraryID: 2, itemKeys: ["ITEM"] }]);
  wikiReverifyCalls.length = 0;
}

// A mixed-result build reverifies every successfully committed target without
// letting one failed item hold the other 19 in pending_relink.
{
  wikiReverifyCalls.length = 0;
  const store = buildStore();
  store.allowKeywordWrites();
  const service = buildService(store);
  const itemKeys = Array.from(
    { length: 20 },
    (_, index) => `BATCH${String(index + 1).padStart(2, "0")}`,
  );
  for (const itemKey of itemKeys) items.set(`2:${itemKey}`, testItem(itemKey));
  service.indexItemWithProcessor = async (item) => {
    if (item.key === "BATCH20") throw new Error("simulated parse failure");
    return { status: "succeeded" };
  };

  const result = await service.buildIndex({
    itemKeys,
    libraryID: 2,
    force: true,
    frozenChunkSettings: { target: 1000, tolerance: 500, signature: "test" },
  });
  await waitForScheduledWikiReverify();

  assert.equal(result.status, "failed");
  const [buildID] = store.sessions.keys();
  const targetRows = await store.getBuildTargets(buildID);
  assert.equal(
    targetRows.filter((target) => target.state === "succeeded").length,
    19,
  );
  assert.deepEqual(wikiReverifyCalls, [
    { libraryID: 2, itemKeys: itemKeys.slice(0, 19) },
  ]);
}

// Every terminal status schedules only the targets that actually succeeded.
{
  wikiReverifyCalls.length = 0;
  const store = buildStore();
  const service = buildService(store);
  const itemKeys = ["INCOMPLETE1", "INCOMPLETE2"];
  for (const itemKey of itemKeys) items.set(`2:${itemKey}`, testItem(itemKey));
  service.indexItemWithProcessor = async () => {
    service.indexProgress.chunkOversizeSkipped = 1;
    return { status: "succeeded" };
  };

  const result = await service.buildIndex({
    itemKeys,
    libraryID: 2,
    force: true,
    frozenChunkSettings: { target: 1000, tolerance: 500, signature: "test" },
  });
  await waitForScheduledWikiReverify();

  assert.equal(result.status, "incomplete");
  assert.deepEqual(wikiReverifyCalls, [{ libraryID: 2, itemKeys }]);
}

{
  wikiReverifyCalls.length = 0;
  const store = buildStore();
  const service = buildService(store);
  const itemKeys = Array.from({ length: 6 }, (_, index) => `ABORT${index + 1}`);
  for (const itemKey of itemKeys) items.set(`2:${itemKey}`, testItem(itemKey));
  service.indexItemWithProcessor = async (item) => {
    if (item.key === "ABORT1") service._aborted = true;
    return { status: "succeeded" };
  };

  const result = await service.buildIndex({
    itemKeys,
    libraryID: 2,
    force: true,
    frozenChunkSettings: { target: 1000, tolerance: 500, signature: "test" },
  });
  await waitForScheduledWikiReverify();

  assert.equal(result.status, "aborted");
  assert.deepEqual(wikiReverifyCalls, [
    { libraryID: 2, itemKeys: itemKeys.slice(0, 5) },
  ]);
}

function deletionStore(events, removeItem) {
  const store = new VectorStore({
    isEnabled: () => true,
    registerProvider: () => {},
    startIfEnabled: async () => {},
    search: async () => [],
    publishMutation: async (event) => events.push(event),
    fallback: () => {},
    setEnabled: async () => {},
    shutdown: async () => {},
  });
  store.initialized = true;
  store.db = {
    executeTransaction: async (operation) => operation(),
    queryAsync: async () => [],
  };
  store.keywordStore = {
    ensureSchema: async () => {},
    removeItem,
  };
  return store;
}

// The unified single-item deletion entry point must not report completion when
// the keyword half failed.
{
  const events = [];
  const store = deletionStore(events, async () => {
    throw new Error("simulated keyword removal failure");
  });
  await assert.rejects(
    store.deleteItemVectors("ITEM", 2),
    /simulated keyword removal failure/,
  );
  assert.deepEqual(events, []);
}

// Batch/category/attachment callers share this entry point and receive the
// same failure instead of a false success notification.
{
  const events = [];
  const store = deletionStore(events, async () => {
    throw new Error("simulated batch keyword removal failure");
  });
  await assert.rejects(
    store.deleteItemsVectors(["A", "B"], 2),
    /simulated batch keyword removal failure/,
  );
  assert.deepEqual(events, []);
}

// Library clearing has the same contract: the single atomic store operation
// reaches the settings caller instead of being logged as an overall success.
{
  const service = Object.create(SemanticSearchService.prototype);
  service.initialize = async () => {};
  service.vectorStore = {
    clear: async () => {
      throw new Error("simulated keyword library clear failure");
    },
  };
  await assert.rejects(
    service.clearIndex(2),
    /simulated keyword library clear failure/,
  );
}

console.log("Index failure semantics regression tests passed");
