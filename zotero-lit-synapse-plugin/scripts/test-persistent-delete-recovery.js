/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register("./index-failure-hooks.mjs", import.meta.url);

const preferences = new Map();
let itemLookups = 0;
globalThis.Zotero = {
  Libraries: { userLibraryID: 1 },
  Prefs: {
    get: (key) => preferences.get(key),
    set: (key, value) => preferences.set(key, value),
    clear: (key) => preferences.delete(key),
  },
  Items: {
    getByLibraryAndKeyAsync: async () => {
      itemLookups += 1;
      return undefined;
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
const firstRuntime = await import(
  "../src/modules/semantic/indexRefreshQueue.ts"
);

assert.equal(
  typeof firstRuntime.enqueueIndexDeletion,
  "function",
  "the existing persistent queue must support deletion tasks",
);
assert.equal(
  typeof firstRuntime.deleteItemIndexWithRecovery,
  "function",
  "the notifier needs one durable cleanup helper",
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-delete-recovery-"));
const dbPath = path.join(tempDir, "index.sqlite");
const sqlite = new DatabaseSync(dbPath);
sqlite.exec(`
  CREATE TABLE embeddings (item_key TEXT NOT NULL, chunk_id INTEGER NOT NULL);
  CREATE TABLE vectors_f32 (item_key TEXT NOT NULL, chunk_id INTEGER NOT NULL);
  CREATE TABLE index_status (item_key TEXT PRIMARY KEY);
  CREATE TABLE index_failures (
    library_id INTEGER NOT NULL,
    item_key TEXT NOT NULL,
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

const fault = { failNextKeywordDelete: false };
let transactionDepth = 0;
const db = {
  async queryAsync(sql, params = []) {
    if (
      fault.failNextKeywordDelete &&
      /UPDATE kw_docs SET alive = 0/.test(sql)
    ) {
      fault.failNextKeywordDelete = false;
      throw new Error("injected notifier cleanup failure");
    }
    const statement = sqlite.prepare(sql);
    const normalised = params.map((value) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
    if (/^\s*(select|pragma)/iu.test(sql)) return statement.all(...normalised);
    statement.run(...normalised);
    return [];
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

const gpuEvents = [];
const store = new VectorStore({
  isEnabled: () => true,
  registerProvider: () => {},
  startIfEnabled: async () => {},
  search: async () => [],
  publishMutation: async (event) => gpuEvents.push(event),
  fallback: () => {},
  setEnabled: async () => {},
  shutdown: async () => {},
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
  title: "Persistent deletion cleanup",
  abstract: "A deleted Zotero item must not remain searchable.",
  tags: [],
  publicationTitle: "Test",
  creator: "Tester",
  extra: "",
  chunks: ["The body keyword index must be removed too."],
});
async function seed(libraryID, itemKey) {
  const key = storageKey(libraryID, itemKey);
  sqlite.prepare("INSERT INTO embeddings VALUES (?, 0)").run(key);
  sqlite.prepare("INSERT INTO vectors_f32 VALUES (?, 0)").run(key);
  sqlite.prepare("INSERT INTO index_status VALUES (?)").run(key);
  await store.getKeywordIndexStore().writeItem(paper(libraryID, itemKey));
}
function state(libraryID, itemKey) {
  const key = storageKey(libraryID, itemKey);
  const count = (table, where, ...params) =>
    Number(
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
        .get(...params).n,
    );
  return {
    embeddings: count("embeddings", "item_key = ?", key),
    float32: count("vectors_f32", "item_key = ?", key),
    status: count("index_status", "item_key = ?", key),
    keywordAlive: count(
      "kw_docs",
      "library_id = ? AND item_key = ? AND alive = 1",
      libraryID,
      itemKey,
    ),
  };
}

await seed(2, "DELETED");
await seed(3, "DELETED");
fault.failNextKeywordDelete = true;

const deleted = await firstRuntime.deleteItemIndexWithRecovery(
  store,
  2,
  "DELETED",
  "permanent-delete-notifier",
);
assert.equal(deleted, false, "the first cleanup reports that it is pending");
assert.deepEqual(state(2, "DELETED"), {
  embeddings: 1,
  float32: 1,
  status: 1,
  keywordAlive: 1,
});
assert.deepEqual(gpuEvents, [], "a rolled-back cleanup publishes no completion");

const queuePref =
  "extensions.zotero.zotero-lit-synapse.semantic.pendingIndexRefresh";
const persisted = JSON.parse(preferences.get(queuePref));
assert.equal(persisted.length, 1);
assert.equal(persisted[0].operation, "delete");
assert.equal(persisted[0].libraryID, 2);
assert.equal(persisted[0].itemKey, "DELETED");

// A distinct module URL models a fresh runtime: no module-local queue state is
// shared, only the persisted Zotero preference above.
const restartedRuntime = await import(
  `../src/modules/semantic/indexRefreshQueue.ts?restart=${Date.now()}`
);
let readinessChecks = 0;
let rebuildCalls = 0;
const service = Object.create(SemanticSearchService.prototype);
service.initialize = async () => {};
service.vectorStore = store;
service._failedItems = new Map();
service.indexProgress = { failedCount: 0 };
service.isBuildActive = () => false;
service.isReady = async () => {
  readinessChecks += 1;
  return true;
};
service.indexItemWithProcessor = async () => {
  rebuildCalls += 1;
};

// A second injected failure proves the persisted cleanup task backs off
// instead of spinning or vanishing.
fault.failNextKeywordDelete = true;
const retryFailure = await restartedRuntime.processIndexRefreshQueue({
  service,
  now: 1_000,
});
assert.equal(retryFailure.failed, 1);
assert.equal(retryFailure.remaining, 1);
const backedOff = JSON.parse(preferences.get(queuePref))[0];
assert.equal(backedOff.operation, "delete");
assert.equal(backedOff.attempts, 1);
assert.ok(backedOff.nextAttemptAt > 1_000);

const tooEarly = await restartedRuntime.processIndexRefreshQueue({
  service,
  now: backedOff.nextAttemptAt - 1,
});
assert.equal(tooEarly.processed, 0);
assert.equal(tooEarly.failed, 0);
assert.equal(tooEarly.remaining, 1);

const result = await restartedRuntime.processIndexRefreshQueue({
  service,
  now: backedOff.nextAttemptAt,
});
assert.equal(result.processed, 1);
assert.equal(result.remaining, 0);
assert.deepEqual(state(2, "DELETED"), {
  embeddings: 0,
  float32: 0,
  status: 0,
  keywordAlive: 0,
});
assert.deepEqual(state(3, "DELETED"), {
  embeddings: 1,
  float32: 1,
  status: 1,
  keywordAlive: 1,
});
assert.equal(itemLookups, 0, "cleanup never looks up the deleted Zotero item");
assert.equal(readinessChecks, 0, "cleanup does not require an Embedding endpoint");
assert.equal(rebuildCalls, 0, "cleanup never enters the indexing path");

// Repeated delivery is harmless and remains library-qualified.
restartedRuntime.enqueueIndexDeletion(2, "DELETED", "duplicate-notifier");
restartedRuntime.enqueueIndexDeletion(2, "DELETED", "duplicate-notifier");
assert.equal(JSON.parse(preferences.get(queuePref)).length, 1);
const duplicate = await restartedRuntime.processIndexRefreshQueue({ service });
assert.equal(duplicate.failed, 0);
assert.equal(duplicate.remaining, 0);
assert.deepEqual(state(3, "DELETED"), {
  embeddings: 1,
  float32: 1,
  status: 1,
  keywordAlive: 1,
});
assert.equal(rebuildCalls, 0);

// Queue entries written by older releases have no operation field. They remain
// refresh tasks and still use the existing indexing path.
const legacyItem = { key: "LEGACY", libraryID: 4, isRegularItem: () => true };
globalThis.Zotero.Items.getByLibraryAndKeyAsync = async (libraryID, itemKey) => {
  itemLookups += 1;
  return libraryID === 4 && itemKey === "LEGACY" ? legacyItem : undefined;
};
preferences.set(
  queuePref,
  JSON.stringify([
    {
      libraryID: 4,
      itemKey: "LEGACY",
      queuedAt: Date.now(),
      attempts: 0,
      reason: "legacy-refresh",
    },
  ]),
);
const legacyRefresh = await restartedRuntime.processIndexRefreshQueue({ service });
assert.equal(legacyRefresh.processed, 1);
assert.equal(legacyRefresh.remaining, 0);
assert.equal(itemLookups, 1);
assert.equal(readinessChecks, 1);
assert.equal(rebuildCalls, 1);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hooksSource = fs.readFileSync(path.join(rootDir, "src/hooks.ts"), "utf8");
const deleteHandler = hooksSource.slice(
  hooksSource.indexOf("async function handleItemsDeleted"),
  hooksSource.indexOf("function registerItemNotifier"),
);
assert.match(
  deleteHandler,
  /deleteItemIndexWithRecovery\(/,
  "the permanent-delete notifier must persist cleanup instead of only warning",
);
const notifier = hooksSource.slice(
  hooksSource.indexOf("notify: async"),
  hooksSource.indexOf("}, ['item'], 'zotero-lit-synapse-auto-update'"),
);
const deleteBranch = notifier.indexOf("if (event === 'delete')");
assert.ok(deleteBranch >= 0, "the notifier must handle permanent deletion");
const refreshGuard = notifier.indexOf("if (!enabled || semanticAutoUpdatesSuspended)");
assert.ok(refreshGuard >= 0, "the notifier must honor refresh scheduling settings");
assert.ok(
  deleteBranch < refreshGuard,
  "disabled or suspended refresh must not drop permanent deletion cleanup",
);
assert.ok(
  deleteBranch < notifier.indexOf("PREF_SEMANTIC_AUTO_UPDATE"),
  "permanent deletion cleanup must not depend on the auto-refresh preference",
);
assert.match(notifier, /await handleItemsDeleted\(numericIds, extraData\)/);
const autoUpdatePreference = notifier.indexOf(
  "const enabled = Zotero.Prefs.get(PREF_SEMANTIC_AUTO_UPDATE",
);
const lifecycleCall = notifier.indexOf(
  "await trackMinerUMarkdownLifecycle(numericIds, event)",
  autoUpdatePreference,
);
assert.ok(lifecycleCall >= 0);
assert.ok(
  lifecycleCall < notifier.indexOf("return;", lifecycleCall),
  "generated Markdown deletion state must be recorded even when semantic auto-update is disabled",
);

sqlite.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log("Persistent delete recovery regression tests passed");
