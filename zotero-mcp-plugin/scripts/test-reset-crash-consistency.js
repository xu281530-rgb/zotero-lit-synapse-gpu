/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";

register("./ts-ext-hooks.mjs", import.meta.url);

const queuePref =
  "extensions.zotero.zotero-mcp-plugin.semantic.pendingIndexRefresh";
const resetPref =
  "extensions.zotero.zotero-mcp-plugin.semantic.pendingIndexReset";
const legacyInvalidatedPref =
  "extensions.zotero.zotero-mcp-plugin.semantic.pendingIndexRefreshInvalidated";
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

const {
  INDEX_BUSINESS_TABLES,
  SemanticDatabaseClearError,
  VectorStore,
} = await import("../src/modules/semantic/vectorStore.ts");
const queue = await import("../src/modules/semantic/indexRefreshQueue.ts");
const { clearSemanticDatabase } = await import(
  "../src/modules/semantic/semanticDatabaseReset.ts"
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-reset-crash-"));

function createStore(name) {
  const dbPath = path.join(tempDir, `${name}.sqlite`);
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode=WAL");
  for (const table of INDEX_BUSINESS_TABLES) {
    sqlite.exec(
      `CREATE TABLE ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT)`,
    );
  }
  sqlite.exec(`
    CREATE TABLE index_internal_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const injection = {
    failDeleteTable: null,
    failVacuum: false,
    failPhysicalValidation: false,
    transactionCommitted: false,
    vacuumRan: false,
  };
  const adapter = {
    executeTransaction: async (operation) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        await operation();
        sqlite.exec("COMMIT");
        injection.transactionCommitted = true;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    queryAsync: async (sql, params = []) => {
      const normalized = sql.trim();
      if (
        injection.failDeleteTable &&
        new RegExp(`^DELETE FROM ${injection.failDeleteTable}\\b`, "i").test(
          normalized,
        )
      ) {
        throw new Error(`injected delete failure: ${injection.failDeleteTable}`);
      }
      if (normalized === "VACUUM") {
        if (injection.failVacuum) throw new Error("injected VACUUM failure");
        sqlite.exec("VACUUM");
        injection.vacuumRan = true;
        return [];
      }
      if (/^(SELECT|PRAGMA)\b/i.test(normalized)) {
        return sqlite.prepare(normalized).all(...params);
      }
      sqlite.prepare(normalized).run(...params);
      return [];
    },
    valueQueryAsync: async (sql, params = []) => {
      const normalized = sql.trim();
      if (
        injection.failPhysicalValidation &&
        injection.vacuumRan &&
        normalized === "PRAGMA freelist_count"
      ) {
        return 1;
      }
      const row = sqlite.prepare(normalized).get(...params);
      return row ? Object.values(row)[0] : undefined;
    },
  };
  const gpuBackend = {
    registerProvider: () => undefined,
    isEnabled: () => false,
    shutdown: async () => undefined,
  };
  const store = new VectorStore(gpuBackend);
  store.initialized = true;
  store.db = adapter;
  store.dbPath = dbPath;

  function seed() {
    for (const table of INDEX_BUSINESS_TABLES) {
      sqlite.prepare(`INSERT INTO ${table} (payload) VALUES (?)`).run(table);
    }
  }

  function businessRows() {
    return INDEX_BUSINESS_TABLES.reduce(
      (total, table) =>
        total + sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
      0,
    );
  }

  return { sqlite, store, injection, seed, businessRows };
}

// A SQL failure before COMMIT rolls back both the business deletes and marker.
{
  const fixture = createStore("pre-commit");
  fixture.seed();
  fixture.injection.failDeleteTable = "vectors_f32";
  let committedCallback = 0;
  await assert.rejects(
    fixture.store.clearAll({
      resetGeneration: "reset-pre-commit",
      onDatabaseCleared: () => {
        committedCallback += 1;
      },
    }),
    (error) =>
      error instanceof SemanticDatabaseClearError &&
      error.databaseCleared === false,
  );
  assert.equal(fixture.businessRows(), INDEX_BUSINESS_TABLES.length);
  assert.equal(
    await fixture.store.getCommittedResetGeneration(),
    null,
  );
  assert.equal(committedCallback, 0);
  fixture.sqlite.close();
}

// COMMIT and its SQLite marker are one atomic fact. A crash in the first
// callback after executeTransaction returns cannot make the queue ambiguous.
{
  const fixture = createStore("commit-crash");
  fixture.seed();
  await assert.rejects(
    fixture.store.clearAll({
      resetGeneration: "reset-commit-crash",
      onDatabaseCleared: () => {
        throw new Error("simulated crash immediately after COMMIT");
      },
    }),
    (error) =>
      error instanceof SemanticDatabaseClearError &&
      error.databaseCleared === true,
  );
  assert.equal(fixture.businessRows(), 0);
  assert.equal(
    await fixture.store.getCommittedResetGeneration(),
    "reset-commit-crash",
  );
  fixture.sqlite.close();
}

// VACUUM and physical verification are post-commit diagnostics. Their failure
// is visible to the UI but cannot turn the old queue back into valid work.
for (const scenario of ["vacuum", "physical-validation"]) {
  const fixture = createStore(scenario);
  fixture.seed();
  fixture.injection.failVacuum = scenario === "vacuum";
  fixture.injection.failPhysicalValidation =
    scenario === "physical-validation";
  let committedCallback = 0;
  await assert.rejects(
    fixture.store.clearAll({
      resetGeneration: `reset-${scenario}`,
      onDatabaseCleared: () => {
        committedCallback += 1;
      },
    }),
    (error) =>
      error instanceof SemanticDatabaseClearError &&
      error.databaseCleared === true,
  );
  assert.equal(fixture.businessRows(), 0);
  assert.equal(
    await fixture.store.getCommittedResetGeneration(),
    `reset-${scenario}`,
  );
  assert.equal(committedCallback, 1);
  fixture.sqlite.close();
}

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
let refreshes = 0;
let deletes = 0;
const service = {
  isBuildActive: () => false,
  isReady: async () => true,
  deleteItemIndex: async (_itemKey, libraryID) => {
    deletes += 1;
    assert.equal(libraryID, 3);
  },
  indexItemWithProcessor: async (item) => {
    refreshes += 1;
    assert.equal(item.libraryID, 2);
  },
};

function resetPreferences() {
  preferences.clear();
  preferences.set(queuePref, JSON.stringify(oldTasks));
  failQueueClear = false;
}

// A boolean left by the previous XPI contains no generation and cannot be
// classified safely. It blocks instead of guessing. An explicit new reset can
// upgrade it; rollback restores the block, while commit makes cleanup safe.
{
  resetPreferences();
  preferences.set(legacyInvalidatedPref, true);
  const legacyQueue = await import(
    `../src/modules/semantic/indexRefreshQueue.ts?legacy=${Date.now()}`
  );
  const before = { refreshes, deletes, itemLookups };
  assert.equal(
    (
      await legacyQueue.processIndexRefreshQueue({
        service,
        getCommittedResetGeneration: async () => null,
        finalizeCommittedReset: async () => undefined,
      })
    ).outcome,
    "reset-pending",
  );
  assert.deepEqual(JSON.parse(preferences.get(queuePref)), oldTasks);
  assert.deepEqual({ refreshes, deletes, itemLookups }, before);

  legacyQueue.prepareIndexRefreshQueueReset("legacy-retry-rollback");
  legacyQueue.cancelIndexRefreshQueueReset("legacy-retry-rollback");
  assert.equal(preferences.get(legacyInvalidatedPref), true);
  assert.equal(
    (
      await legacyQueue.processIndexRefreshQueue({
        service,
        getCommittedResetGeneration: async () => null,
      })
    ).outcome,
    "reset-pending",
  );

  legacyQueue.prepareIndexRefreshQueueReset("legacy-retry-commit");
  legacyQueue.markIndexRefreshQueueDatabaseCleared("legacy-retry-commit");
  assert.equal(
    (
      await legacyQueue.processIndexRefreshQueue({
        service,
        finalizeCommittedReset: async () => undefined,
      })
    ).outcome,
    "reset-recovered",
  );
  assert.equal(preferences.has(queuePref), false);
  assert.equal(preferences.has(resetPref), false);
  assert.equal(preferences.has(legacyInvalidatedPref), false);
  legacyQueue.stopIndexRefreshQueue();
}

// The UI-level reset must use the structured commit state. Post-commit
// VACUUM/verification failures reject, keep every producer paused, and are
// completed after restart without executing the old queue.
for (const scenario of ["ui-vacuum", "ui-physical-validation"]) {
  resetPreferences();
  const fixture = createStore(scenario);
  fixture.seed();
  fixture.injection.failVacuum = scenario === "ui-vacuum";
  fixture.injection.failPhysicalValidation =
    scenario === "ui-physical-validation";
  const runtimeQueue = await import(
    `../src/modules/semantic/indexRefreshQueue.ts?ui=${scenario}-${Date.now()}`
  );
  let resumedDrain = 0;
  let resumedAuto = 0;
  let resumedPDF = 0;
  await assert.rejects(
    clearSemanticDatabase({
      semanticService: {
        beginDatabaseReset: async () => undefined,
        resetAfterDatabaseClear: () => undefined,
        endDatabaseReset: () => undefined,
      },
      vectorStore: fixture.store,
      suspendRefreshQueue: runtimeQueue.suspendIndexRefreshQueue,
      resumeRefreshQueue: () => {
        resumedDrain += 1;
      },
      prepareRefreshQueueReset: runtimeQueue.prepareIndexRefreshQueueReset,
      markRefreshQueueDatabaseCleared:
        runtimeQueue.markIndexRefreshQueueDatabaseCleared,
      cancelRefreshQueueReset: runtimeQueue.cancelIndexRefreshQueueReset,
      suspendPDFRefreshes: async () => undefined,
      resumePDFRefreshes: () => {
        resumedPDF += 1;
      },
      clearRefreshQueue: runtimeQueue.clearIndexRefreshQueue,
      suspendAutoUpdates: () => undefined,
      resumeAutoUpdates: () => {
        resumedAuto += 1;
      },
      clearChunkingSignatures: () => undefined,
      clearPaginationState: () => undefined,
    }),
    (error) =>
      error instanceof SemanticDatabaseClearError &&
      error.databaseCleared === true,
  );
  assert.equal(fixture.businessRows(), 0);
  assert.deepEqual(JSON.parse(preferences.get(queuePref)), oldTasks);
  assert.equal(JSON.parse(preferences.get(resetPref)).phase, "database-cleared");
  assert.deepEqual([resumedDrain, resumedAuto, resumedPDF], [0, 0, 0]);

  fixture.injection.failVacuum = false;
  fixture.injection.failPhysicalValidation = false;
  const restarted = await import(
    `../src/modules/semantic/indexRefreshQueue.ts?ui-restart=${scenario}-${Date.now()}`
  );
  const before = { refreshes, deletes, itemLookups };
  const recovery = await restarted.processIndexRefreshQueue({
    service,
    getCommittedResetGeneration: () =>
      fixture.store.getCommittedResetGeneration(),
    finalizeCommittedReset: () => fixture.store.finalizeCommittedReset(),
  });
  assert.equal(recovery.outcome, "reset-recovered");
  assert.equal(preferences.has(queuePref), false);
  assert.equal(preferences.has(resetPref), false);
  assert.deepEqual({ refreshes, deletes, itemLookups }, before);
  restarted.stopIndexRefreshQueue();
  runtimeQueue.stopIndexRefreshQueue();
  fixture.sqlite.close();
}

// Crash while preparing, before the generation reached SQLite: restart keeps
// the original multi-library queue and returns it to normal processing.
{
  resetPreferences();
  queue.prepareIndexRefreshQueueReset("preparing-no-commit");
  const restarted = await import(
    `../src/modules/semantic/indexRefreshQueue.ts?preparing=${Date.now()}`
  );
  restarted.startIndexRefreshQueue();
  const recovery = await restarted.processIndexRefreshQueue({
    service,
    getCommittedResetGeneration: async () => null,
    finalizeCommittedReset: async () => undefined,
  });
  assert.equal(recovery.outcome, "reset-recovered");
  assert.deepEqual(JSON.parse(preferences.get(queuePref)), oldTasks);
  assert.equal(preferences.has(resetPref), false);
  assert.equal(preferences.has(legacyInvalidatedPref), false);
  const drained = await restarted.processIndexRefreshQueue({ service });
  assert.equal(drained.outcome, "drained");
  assert.equal(refreshes, 1);
  assert.equal(deletes, 1);
  restarted.stopIndexRefreshQueue();
}

// Crash after the SQLite COMMIT but before the preference phase transition:
// the matching SQLite generation upgrades preparing to database-cleared and
// old tasks are cleared without looking up an item or calling either worker.
{
  resetPreferences();
  queue.prepareIndexRefreshQueueReset("committed-before-pref");
  const restarted = await import(
    `../src/modules/semantic/indexRefreshQueue.ts?committed=${Date.now()}`
  );
  const before = { refreshes, deletes, itemLookups };
  const recovery = await restarted.processIndexRefreshQueue({
    service,
    getCommittedResetGeneration: async () => "committed-before-pref",
    finalizeCommittedReset: async () => undefined,
  });
  assert.equal(recovery.outcome, "reset-recovered");
  assert.equal(preferences.has(queuePref), false);
  assert.equal(preferences.has(resetPref), false);
  assert.deepEqual({ refreshes, deletes, itemLookups }, before);
  restarted.stopIndexRefreshQueue();
}

// An explicit database-cleared phase never needs to inspect queue contents.
// Failed cleanup remains blocked across restart; successful retry releases the
// fence and newly-created work functions normally.
{
  resetPreferences();
  queue.prepareIndexRefreshQueueReset("post-commit-cleanup");
  queue.markIndexRefreshQueueDatabaseCleared("post-commit-cleanup");
  const before = { refreshes, deletes, itemLookups };
  const unfinishedPostProcessing = await queue.processIndexRefreshQueue({
    service,
    finalizeCommittedReset: async () => {
      throw new Error("injected restart VACUUM failure");
    },
  });
  assert.equal(unfinishedPostProcessing.outcome, "reset-pending");
  assert.deepEqual(JSON.parse(preferences.get(queuePref)), oldTasks);
  assert.deepEqual({ refreshes, deletes, itemLookups }, before);

  failQueueClear = true;
  const restarted = await import(
    `../src/modules/semantic/indexRefreshQueue.ts?cleanup=${Date.now()}`
  );
  const blocked = await restarted.processIndexRefreshQueue({
    service,
    finalizeCommittedReset: async () => undefined,
  });
  assert.equal(blocked.outcome, "reset-pending");
  assert.deepEqual({ refreshes, deletes, itemLookups }, before);
  assert.deepEqual(JSON.parse(preferences.get(resetPref)), {
    phase: "database-cleared",
    generation: "post-commit-cleanup",
  });

  failQueueClear = false;
  const recovered = await restarted.processIndexRefreshQueue({
    service,
    finalizeCommittedReset: async () => undefined,
  });
  assert.equal(recovered.outcome, "reset-recovered");
  assert.equal(preferences.has(queuePref), false);
  assert.equal(preferences.has(resetPref), false);

  restarted.enqueueIndexRefresh(4, "NEW_REFRESH", "after-reset");
  restarted.enqueueIndexDeletion(5, "NEW_DELETE", "after-reset");
  const newService = {
    ...service,
    deleteItemIndex: async (_itemKey, libraryID) => {
      assert.equal(libraryID, 5);
    },
    indexItemWithProcessor: async (item) => {
      assert.equal(item.libraryID, 4);
    },
  };
  assert.equal(
    (await restarted.processIndexRefreshQueue({ service: newService })).outcome,
    "drained",
  );
  restarted.stopIndexRefreshQueue();
}

queue.stopIndexRefreshQueue();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log("Reset crash-consistency regression tests passed");
