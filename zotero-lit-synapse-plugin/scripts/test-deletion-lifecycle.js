/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./index-failure-hooks.mjs", import.meta.url);

const preferences = new Map();
globalThis.Zotero = {
  Libraries: { userLibraryID: 1 },
  Prefs: {
    get: (key) => preferences.get(key),
    set: (key, value) => preferences.set(key, value),
    clear: (key) => preferences.delete(key),
  },
  Items: {
    getByLibraryAndKeyAsync: async () => {
      throw new Error("a deletion task must not look up the deleted item");
    },
  },
};
globalThis.ztoolkit = { log: () => undefined };

const { VectorStore } = await import(
  "../src/modules/semantic/vectorStore.ts"
);
const { SemanticSearchService } = await import(
  "../src/modules/semantic/semanticSearchService.ts"
);
const queue = await import(
  "../src/modules/semantic/indexRefreshQueue.ts"
);
const { clearSemanticDatabase } = await import(
  "../src/modules/semantic/semanticDatabaseReset.ts"
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-delete-race-"));
const dbPath = path.join(tempDir, "index.sqlite");
const sqlite = new DatabaseSync(dbPath);
sqlite.exec(`
  CREATE TABLE embeddings (item_key TEXT NOT NULL, chunk_id INTEGER NOT NULL);
  CREATE TABLE vectors_f32 (item_key TEXT NOT NULL, chunk_id INTEGER NOT NULL);
  CREATE TABLE index_status (item_key TEXT PRIMARY KEY);
  CREATE TABLE index_failures (
    library_id INTEGER NOT NULL,
    item_key TEXT NOT NULL,
    error_type TEXT NOT NULL,
    error_message TEXT NOT NULL,
    failed_at INTEGER NOT NULL,
    build_id TEXT,
    PRIMARY KEY (library_id, item_key)
  );
  CREATE TABLE index_build_targets (
    build_id TEXT NOT NULL,
    library_id INTEGER NOT NULL,
    item_key TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (build_id, library_id, item_key)
  );
`);

let transactionDepth = 0;
const fault = { failTargetCleanup: false };
const db = {
  async queryAsync(sql, params = []) {
    if (
      fault.failTargetCleanup &&
      /^\s*DELETE FROM index_build_targets/iu.test(sql)
    ) {
      fault.failTargetCleanup = false;
      throw new Error("injected build-target cleanup failure");
    }
    const statement = sqlite.prepare(sql);
    const normalized = params.map((value) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
    if (/^\s*(select|pragma)/iu.test(sql)) return statement.all(...normalized);
    statement.run(...normalized);
    return [];
  },
  async valueQueryAsync(sql, params = []) {
    const row = sqlite.prepare(sql).get(...params);
    return row ? Object.values(row)[0] : undefined;
  },
  async executeTransaction(operation) {
    if (transactionDepth > 0) return operation();
    transactionDepth += 1;
    sqlite.exec("BEGIN");
    try {
      const result = await operation();
      sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      transactionDepth -= 1;
    }
  },
};

const store = new VectorStore({
  isEnabled: () => false,
  registerProvider: () => undefined,
  startIfEnabled: async () => undefined,
  search: async () => [],
  publishMutation: async () => undefined,
  fallback: () => undefined,
  setEnabled: async () => undefined,
  shutdown: async () => undefined,
});
store.initialized = true;
store.db = db;
store.dbPath = dbPath;
await store.getKeywordIndexStore().ensureSchema();

const storageKey = (libraryID, itemKey) =>
  libraryID === 1 ? itemKey : `${libraryID}:${itemKey}`;
const paper = (libraryID, itemKey) => ({
  libraryID,
  itemKey,
  title: "Delete during manual build",
  abstract: "The final cleanup must win the race.",
  tags: [],
  publicationTitle: "Test",
  creator: "Tester",
  extra: "",
  chunks: ["body keyword"],
});
async function seedIndex(libraryID, itemKey) {
  const key = storageKey(libraryID, itemKey);
  sqlite.prepare("INSERT INTO embeddings VALUES (?, 0)").run(key);
  sqlite.prepare("INSERT INTO vectors_f32 VALUES (?, 0)").run(key);
  sqlite.prepare("INSERT INTO index_status VALUES (?)").run(key);
  await store.getKeywordIndexStore().writeItem(paper(libraryID, itemKey));
}
function indexState(libraryID, itemKey) {
  const key = storageKey(libraryID, itemKey);
  const count = (table, where, ...params) =>
    Number(
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
        .get(...params).n,
    );
  return {
    semantic: count("embeddings", "item_key = ?", key),
    vectors: count("vectors_f32", "item_key = ?", key),
    status: count("index_status", "item_key = ?", key),
    keyword: count(
      "kw_docs",
      "library_id = ? AND item_key = ? AND alive = 1",
      libraryID,
      itemKey,
    ),
  };
}
function lifecycleState(libraryID, itemKey) {
  const count = (table) =>
    Number(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE library_id = ? AND item_key = ?`,
        )
        .get(libraryID, itemKey).n,
    );
  return {
    failures: count("index_failures"),
    targets: count("index_build_targets"),
  };
}
function seedLifecycleState(libraryID, itemKey, buildID) {
  sqlite
    .prepare(
      "INSERT OR REPLACE INTO index_failures VALUES (?, ?, 'embedding', 'failed', 1, ?)",
    )
    .run(libraryID, itemKey, buildID);
  sqlite
    .prepare(
      "INSERT OR REPLACE INTO index_build_targets VALUES (?, ?, ?, 'failed')",
    )
    .run(buildID, libraryID, itemKey);
}

// A manual build is active even though hooks.ts's isAutoIndexing flag is not.
await seedIndex(2, "RACE");
const immediate = await queue.deleteItemIndexWithRecovery(
  store,
  2,
  "RACE",
  "permanent-delete-notifier",
  { buildActive: true },
);
assert.equal(
  immediate,
  false,
  "an immediate delete during a build is not final until post-build cleanup",
);
assert.deepEqual(indexState(2, "RACE"), {
  semantic: 0,
  vectors: 0,
  status: 0,
  keyword: 0,
});

const queuePref =
  "extensions.zotero.zotero-lit-synapse.semantic.pendingIndexRefresh";
let persisted = JSON.parse(preferences.get(queuePref));
assert.deepEqual(
  persisted.map(({ libraryID, itemKey, operation }) => ({
    libraryID,
    itemKey,
    operation,
  })),
  [{ libraryID: 2, itemKey: "RACE", operation: "delete" }],
  "the successful first delete still has a durable post-build cleanup",
);

// The in-flight build had already captured the Zotero item and writes it back.
await seedIndex(2, "RACE");
let buildActive = true;
const service = {
  isBuildActive: () => buildActive,
  isReady: async () => true,
  deleteItemIndex: (itemKey, libraryID) =>
    store.deleteItemVectors(itemKey, libraryID),
  indexItemWithProcessor: async () => {
    throw new Error("delete cleanup must not rebuild an item");
  },
};
const whileBuilding = await queue.processIndexRefreshQueue({ service });
assert.equal(whileBuilding.outcome, "build-active");
assert.deepEqual(indexState(2, "RACE"), {
  semantic: 1,
  vectors: 1,
  status: 1,
  keyword: 1,
});

buildActive = false;
const afterBuild = await queue.processIndexRefreshQueue({ service });
assert.equal(afterBuild.processed, 1);
assert.equal(afterBuild.remaining, 0);
assert.deepEqual(indexState(2, "RACE"), {
  semantic: 0,
  vectors: 0,
  status: 0,
  keyword: 0,
});

// The existing automatic-build guard keeps the same durable guarantee.
await seedIndex(3, "AUTO");
const automatic = await queue.deleteItemIndexWithRecovery(
  store,
  3,
  "AUTO",
  "automatic-build-delete",
  { buildActive: true },
);
assert.equal(automatic, false);
persisted = JSON.parse(preferences.get(queuePref));
assert.equal(
  persisted.some(
    (entry) =>
      entry.operation === "delete" &&
      entry.libraryID === 3 &&
      entry.itemKey === "AUTO",
  ),
  true,
);

// Standalone incremental indexing (PDF refresh / persisted refresh) also
// participates in the real activity state, even though buildIndex() is absent.
let releaseTimestampCheck;
const timestampGate = new Promise((resolve) => {
  releaseTimestampCheck = resolve;
});
const standaloneService = Object.create(SemanticSearchService.prototype);
standaloneService._databaseResetActive = false;
standaloneService._buildActive = false;
standaloneService._activeIndexOperations = 0;
standaloneService._paused = true;
standaloneService._aborted = false;
standaloneService._forceRun = false;
standaloneService.indexProgress = {};
standaloneService.vectorStore = {
  needsReindexByTimestamp: async () => {
    await timestampGate;
    return true;
  },
};
const standaloneIndex = standaloneService.indexItemWithProcessor(
  {
    key: "STANDALONE",
    libraryID: 2,
    getDisplayTitle: () => "Standalone refresh",
    isRegularItem: () => false,
  },
  null,
  true,
);
await Promise.resolve();
assert.equal(
  standaloneService.isBuildActive(),
  true,
  "direct incremental indexing must make permanent deletion durable too",
);
releaseTimestampCheck();
await standaloneIndex;
assert.equal(standaloneService.isBuildActive(), false);

// A delete notifier can arrive while the persistent queue awaits a refresh.
// The drain's old snapshot must not overwrite that newly persisted deletion.
preferences.set(
  queuePref,
  JSON.stringify([
    {
      libraryID: 2,
      itemKey: "REFRESHING",
      operation: "refresh",
      queuedAt: 1,
      attempts: 0,
      reason: "body-updated",
    },
  ]),
);
globalThis.Zotero.Items.getByLibraryAndKeyAsync = async (libraryID, itemKey) =>
  libraryID === 2 && itemKey === "REFRESHING"
    ? { key: itemKey, libraryID, isRegularItem: () => true }
    : undefined;
const refreshService = {
  isBuildActive: () => false,
  isReady: async () => true,
  deleteItemIndex: async () => undefined,
  indexItemWithProcessor: async () => {
    queue.enqueueIndexDeletion(3, "DELETED_DURING_REFRESH", "notifier");
  },
};
await queue.processIndexRefreshQueue({ service: refreshService });
persisted = JSON.parse(preferences.get(queuePref));
assert.equal(
  persisted.some(
    (entry) =>
      entry.operation === "delete" &&
      entry.libraryID === 3 &&
      entry.itemKey === "DELETED_DURING_REFRESH",
  ),
  true,
  "a concurrent delete must survive refresh-drain bookkeeping",
);

// Permanent deletion removes every item-level retry/journal row atomically.
await seedIndex(2, "FAILED");
await seedIndex(2, "OTHER");
await seedIndex(3, "FAILED");
seedLifecycleState(2, "FAILED", "build-2-failed");
seedLifecycleState(2, "FAILED", "build-2-second");
seedLifecycleState(2, "OTHER", "build-2-other");
seedLifecycleState(3, "FAILED", "build-3-failed");

await store.deleteItemVectors("FAILED", 2);
assert.deepEqual(lifecycleState(2, "FAILED"), { failures: 0, targets: 0 });
assert.deepEqual(lifecycleState(2, "OTHER"), { failures: 1, targets: 1 });
assert.deepEqual(lifecycleState(3, "FAILED"), { failures: 1, targets: 1 });
assert.deepEqual(indexState(3, "FAILED"), {
  semantic: 1,
  vectors: 1,
  status: 1,
  keyword: 1,
});

await seedIndex(2, "BATCH_A");
await seedIndex(2, "BATCH_B");
seedLifecycleState(2, "BATCH_A", "batch-a");
seedLifecycleState(2, "BATCH_B", "batch-b");
await store.deleteItemsVectors(["BATCH_A", "BATCH_B"], 2);
assert.deepEqual(lifecycleState(2, "BATCH_A"), { failures: 0, targets: 0 });
assert.deepEqual(lifecycleState(2, "BATCH_B"), { failures: 0, targets: 0 });

// A failure in the newly included lifecycle cleanup rolls both indexes back.
await seedIndex(2, "ROLLBACK");
seedLifecycleState(2, "ROLLBACK", "rollback-build");
fault.failTargetCleanup = true;
await assert.rejects(
  store.deleteItemVectors("ROLLBACK", 2),
  /injected build-target cleanup failure/,
);
assert.deepEqual(indexState(2, "ROLLBACK"), {
  semantic: 1,
  vectors: 1,
  status: 1,
  keyword: 1,
});
assert.deepEqual(lifecycleState(2, "ROLLBACK"), {
  failures: 1,
  targets: 1,
});

// The service's in-memory failure mirror must agree with the durable rows.
await seedIndex(2, "MEMORY_FAILED");
seedLifecycleState(2, "MEMORY_FAILED", "memory-build");
const semanticService = Object.create(SemanticSearchService.prototype);
semanticService.vectorStore = store;
semanticService._failedItems = new Map([
  [
    "2:MEMORY_FAILED",
    {
      libraryID: 2,
      itemKey: "MEMORY_FAILED",
      error: "failed",
      errorType: "unknown",
      timestamp: 1,
    },
  ],
]);
semanticService.indexProgress = { failedCount: 1 };
await semanticService.deleteItemIndex("MEMORY_FAILED", 2);
assert.deepEqual(semanticService.getFailedItems(), []);
assert.equal(semanticService.indexProgress.failedCount, 0);
assert.deepEqual(lifecycleState(2, "MEMORY_FAILED"), {
  failures: 0,
  targets: 0,
});

// "Delete all" preserves the durable queue unless the database clear commits.
sqlite.exec("CREATE TABLE reset_probe (value TEXT NOT NULL)");
sqlite.prepare("INSERT INTO reset_probe VALUES ('present')").run();
const originalQueue = [
  {
    libraryID: 2,
    itemKey: "DELETE_PENDING",
    operation: "delete",
    queuedAt: 1,
    attempts: 0,
    reason: "permanent-delete-notifier",
  },
  {
    libraryID: 3,
    itemKey: "REFRESH_PENDING",
    operation: "refresh",
    queuedAt: 2,
    attempts: 0,
    reason: "body-updated",
  },
];
preferences.set(queuePref, JSON.stringify(originalQueue));
let failDatabaseClear = true;
const resetEvents = [];
const resetDependencies = {
  semanticService: {
    beginDatabaseReset: async () => resetEvents.push("begin-reset"),
    resetAfterDatabaseClear: () => resetEvents.push("runtime-reset"),
    endDatabaseReset: () => resetEvents.push("end-reset"),
  },
  vectorStore: {
    initialize: async () => resetEvents.push("initialize"),
    clearAll: async (options) => {
      resetEvents.push("database-clear");
      sqlite.exec("BEGIN");
      try {
        sqlite.exec("DELETE FROM reset_probe");
        if (failDatabaseClear) throw new Error("injected clearAll failure");
        sqlite.exec("COMMIT");
        await options.onDatabaseCleared();
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return {
        before: {},
        after: {},
        database: { path: dbPath, pageCountBefore: 1, pageCountAfter: 1 },
      };
    },
  },
  suspendRefreshQueue: async () => resetEvents.push("suspend-refresh"),
  resumeRefreshQueue: () => resetEvents.push("resume-refresh"),
  prepareRefreshQueueReset: () => {
    resetEvents.push("queue-prepare");
    return "deletion-lifecycle-reset";
  },
  markRefreshQueueDatabaseCleared: () =>
    resetEvents.push("queue-database-cleared"),
  cancelRefreshQueueReset: () => resetEvents.push("queue-reset-cancel"),
  suspendPDFRefreshes: async () => resetEvents.push("suspend-pdf"),
  resumePDFRefreshes: () => resetEvents.push("resume-pdf"),
  clearRefreshQueue: () => {
    resetEvents.push("queue-clear");
    preferences.delete(queuePref);
  },
  suspendAutoUpdates: () => resetEvents.push("suspend-auto"),
  resumeAutoUpdates: () => resetEvents.push("resume-auto"),
  clearChunkingSignatures: () => resetEvents.push("chunk-signatures"),
  clearPaginationState: () => resetEvents.push("pagination"),
};

await assert.rejects(
  clearSemanticDatabase(resetDependencies),
  /injected clearAll failure/,
  "the UI command must reject instead of reporting deletion success",
);
assert.equal(
  sqlite.prepare("SELECT COUNT(*) AS n FROM reset_probe").get().n,
  1,
  "the failed database transaction rolls back",
);
assert.deepEqual(
  JSON.parse(preferences.get(queuePref)),
  originalQueue,
  "delete and refresh recovery tasks survive a failed database clear",
);
assert.equal(
  resetEvents.includes("queue-clear"),
  false,
  "the persistent queue is untouched when the database does not commit",
);

failDatabaseClear = false;
resetEvents.length = 0;
await clearSemanticDatabase(resetDependencies);
assert.equal(
  sqlite.prepare("SELECT COUNT(*) AS n FROM reset_probe").get().n,
  0,
);
assert.equal(preferences.has(queuePref), false);
assert.equal(
  resetEvents.indexOf("queue-clear") > resetEvents.indexOf("database-clear"),
  true,
);

const hooksSource = fs.readFileSync(
  new URL("../src/hooks.ts", import.meta.url),
  "utf8",
);
const deletedHandler = hooksSource.slice(
  hooksSource.indexOf("async function handleItemsDeleted"),
  hooksSource.indexOf("function registerItemNotifier"),
);
assert.match(
  deletedHandler,
  /buildActive:\s*isAutoIndexing\s*\|\|\s*semanticService\.isBuildActive\(\)/,
  "manual and automatic builds must both make notifier cleanup durable",
);

sqlite.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log("Deletion lifecycle race regression tests passed");
