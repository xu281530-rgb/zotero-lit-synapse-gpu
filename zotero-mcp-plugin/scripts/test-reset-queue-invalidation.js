/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const queuePref =
  "extensions.zotero.zotero-mcp-plugin.semantic.pendingIndexRefresh";
const resetPref =
  "extensions.zotero.zotero-mcp-plugin.semantic.pendingIndexReset";
const preferences = new Map();
let failQueueClear = false;
let itemLookups = 0;

globalThis.Zotero = {
  Libraries: { userLibraryID: 1 },
  Prefs: {
    get: (key) => preferences.get(key),
    set: (key, value) => preferences.set(key, value),
    clear: (key) => {
      if (key === queuePref && failQueueClear) return;
      preferences.delete(key);
    },
  },
  Items: {
    getByLibraryAndKeyAsync: async (libraryID, itemKey) => {
      itemLookups += 1;
      return {
        libraryID,
        key: itemKey,
        isRegularItem: () => true,
      };
    },
  },
};
globalThis.ztoolkit = { log: () => undefined };

const queue = await import(
  "../src/modules/semantic/indexRefreshQueue.ts"
);
const { clearSemanticDatabase } = await import(
  "../src/modules/semantic/semanticDatabaseReset.ts"
);

const oldTasks = [
  {
    libraryID: 2,
    itemKey: "REFRESH_A",
    operation: "refresh",
    queuedAt: 1,
    attempts: 0,
    reason: "old-refresh",
  },
  {
    libraryID: 3,
    itemKey: "DELETE_B",
    operation: "delete",
    queuedAt: 2,
    attempts: 0,
    reason: "old-delete",
  },
];
preferences.set(queuePref, JSON.stringify(oldTasks));

let databaseRows = 1;
let resumeCalls = 0;
let legacyRefreshExecutions = 0;
let resumedAutoUpdates = 0;
let resumedPDFRefreshes = 0;
failQueueClear = true;
const resetDependencies = {
  semanticService: {
    beginDatabaseReset: async () => undefined,
    resetAfterDatabaseClear: () => undefined,
    endDatabaseReset: () => undefined,
  },
  vectorStore: {
    initialize: async () => undefined,
    clearAll: async (options) => {
      databaseRows = 0;
      await options.onDatabaseCleared();
      return {
        before: {},
        after: {},
        database: {
          path: "semantic.sqlite",
          pageCountBefore: 2,
          pageCountAfter: 1,
        },
      };
    },
  },
  suspendRefreshQueue: queue.suspendIndexRefreshQueue,
  resumeRefreshQueue: () => {
    resumeCalls += 1;
    const persisted = JSON.parse(preferences.get(queuePref) || "[]");
    legacyRefreshExecutions += persisted.filter(
      (entry) => entry.operation !== "delete",
    ).length;
    queue.resumeIndexRefreshQueue();
  },
  prepareRefreshQueueReset: queue.prepareIndexRefreshQueueReset,
  markRefreshQueueDatabaseCleared:
    queue.markIndexRefreshQueueDatabaseCleared,
  cancelRefreshQueueReset: queue.cancelIndexRefreshQueueReset,
  suspendPDFRefreshes: async () => undefined,
  resumePDFRefreshes: () => {
    resumedPDFRefreshes += 1;
  },
  clearRefreshQueue: queue.clearIndexRefreshQueue,
  suspendAutoUpdates: () => undefined,
  resumeAutoUpdates: () => {
    resumedAutoUpdates += 1;
  },
  clearChunkingSignatures: () => undefined,
  clearPaginationState: () => undefined,
};

await assert.rejects(
  clearSemanticDatabase(resetDependencies),
  /database rows were cleared|runtime cleanup was incomplete/i,
);
assert.equal(databaseRows, 0, "clearAll already committed");
assert.deepEqual(JSON.parse(preferences.get(queuePref)), oldTasks);
assert.equal(
  JSON.parse(preferences.get(resetPref)).phase,
  "database-cleared",
  "the committed reset phase must survive a post-commit queue cleanup failure",
);
assert.equal(
  legacyRefreshExecutions,
  0,
  "resuming the legacy drain would execute the stale refresh against the empty database",
);
assert.equal(
  resumeCalls,
  0,
  "a committed reset with uncleared old tasks must keep the drain blocked",
);
assert.equal(resumedAutoUpdates, 0);
assert.equal(resumedPDFRefreshes, 0);

let deletes = 0;
let refreshes = 0;
const service = {
  isBuildActive: () => false,
  isReady: async () => true,
  deleteItemIndex: async () => {
    deletes += 1;
  },
  indexItemWithProcessor: async () => {
    refreshes += 1;
  },
};
const blockedDrain = await queue.processIndexRefreshQueue({
  service,
  finalizeCommittedReset: async () => undefined,
});
assert.equal(blockedDrain.outcome, "reset-pending");
assert.equal(deletes, 0);
assert.equal(refreshes, 0);
assert.equal(itemLookups, 0);

// A fresh module instance models startup after Zotero restarted: its in-memory
// suspended flag is new, so only the persisted invalidation fence can protect
// the empty database from the old tasks.
const restartedQueue = await import(
  `../src/modules/semantic/indexRefreshQueue.ts?restart=${Date.now()}`
);
restartedQueue.startIndexRefreshQueue();
const blockedAfterRestart = await restartedQueue.processIndexRefreshQueue({
  service,
  finalizeCommittedReset: async () => undefined,
});
assert.equal(blockedAfterRestart.outcome, "reset-pending");
assert.equal(deletes, 0);
assert.equal(refreshes, 0);
assert.equal(itemLookups, 0);
assert.deepEqual(JSON.parse(preferences.get(queuePref)), oldTasks);
assert.equal(JSON.parse(preferences.get(resetPref)).phase, "database-cleared");

// Once cleanup succeeds, the fence is removed and only newly-created work may
// enter the normal drain.
failQueueClear = false;
assert.equal(
  (
    await restartedQueue.processIndexRefreshQueue({
      service,
      finalizeCommittedReset: async () => undefined,
    })
  ).outcome,
  "reset-recovered",
);
restartedQueue.stopIndexRefreshQueue();
assert.equal(preferences.has(queuePref), false);
assert.equal(preferences.has(resetPref), false);

restartedQueue.enqueueIndexRefresh(4, "NEW_REFRESH", "after-reset");
restartedQueue.enqueueIndexDeletion(5, "NEW_DELETE", "after-reset");
const recoveredDrain = await restartedQueue.processIndexRefreshQueue({ service });
assert.equal(recoveredDrain.outcome, "drained");
assert.equal(deletes, 1);
assert.equal(refreshes, 1);
assert.equal(itemLookups, 1);
assert.deepEqual(JSON.parse(preferences.get(queuePref)), []);

// The pre-commit failure branch has the opposite contract: clearAll rolls
// back, the original tasks remain valid, and normal processing resumes.
const rollbackTasks = oldTasks.map((entry) => ({
  ...entry,
  itemKey: `ROLLBACK_${entry.itemKey}`,
}));
preferences.set(queuePref, JSON.stringify(rollbackTasks));
databaseRows = 2;
let rollbackResumeCalls = 0;
const rollbackQueue = await import(
  `../src/modules/semantic/indexRefreshQueue.ts?rollback=${Date.now()}`
);
await assert.rejects(
  clearSemanticDatabase({
    ...resetDependencies,
    vectorStore: {
      initialize: async () => undefined,
      clearAll: async () => {
        throw new Error("injected clearAll failure");
      },
    },
    suspendRefreshQueue: rollbackQueue.suspendIndexRefreshQueue,
    resumeRefreshQueue: () => {
      rollbackResumeCalls += 1;
      rollbackQueue.resumeIndexRefreshQueue();
      rollbackQueue.stopIndexRefreshQueue();
    },
    prepareRefreshQueueReset: rollbackQueue.prepareIndexRefreshQueueReset,
    markRefreshQueueDatabaseCleared:
      rollbackQueue.markIndexRefreshQueueDatabaseCleared,
    cancelRefreshQueueReset: rollbackQueue.cancelIndexRefreshQueueReset,
    clearRefreshQueue: rollbackQueue.clearIndexRefreshQueue,
  }),
  /injected clearAll failure/,
);
assert.equal(databaseRows, 2);
assert.deepEqual(JSON.parse(preferences.get(queuePref)), rollbackTasks);
assert.equal(preferences.has(resetPref), false);
assert.equal(rollbackResumeCalls, 1);

queue.stopIndexRefreshQueue();
restartedQueue.stopIndexRefreshQueue();
rollbackQueue.stopIndexRefreshQueue();
assert.equal(itemLookups, 1);
console.log("Reset queue invalidation regression tests passed");
