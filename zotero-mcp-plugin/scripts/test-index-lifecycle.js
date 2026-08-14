/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");
const { groupFailedIndexItems } = await import(
  "../src/modules/semantic/failedIndexRetry.ts"
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceSource = fs.readFileSync(
  path.join(root, "src/modules/semantic/semanticSearchService.ts"),
  "utf8",
);
const vectorStoreSource = fs.readFileSync(
  path.join(root, "src/modules/semantic/vectorStore.ts"),
  "utf8",
);

function mockStore(gpuBackend) {
  const failureRows = new Map();
  const targetRows = new Map();
  const buildRows = new Map();
  const calls = [];
  const db = {
    executeTransaction: async (operation) => operation(),
    queryAsync: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes("INSERT OR REPLACE INTO index_failures")) {
        failureRows.set(`${params[0]}:${params[1]}`, {
          library_id: params[0],
          item_key: params[1],
          error_type: params[2],
          error_message: params[3],
          failed_at: params[4],
          build_id: params[5] ?? null,
        });
        return [];
      }
      if (sql.includes("SELECT library_id, item_key, error_type")) {
        return Array.from(failureRows.values());
      }
      if (
        sql.includes(
          "DELETE FROM index_failures WHERE library_id = ? AND item_key = ?",
        )
      ) {
        failureRows.delete(`${params[0]}:${params[1]}`);
        return [];
      }
      if (sql.includes("DELETE FROM index_failures WHERE library_id = ?")) {
        for (const [identity, failure] of failureRows) {
          if (failure.library_id === params[0]) failureRows.delete(identity);
        }
        return [];
      }
      if (sql.includes("INSERT OR REPLACE INTO index_build_targets")) {
        targetRows.set(`${params[0]}:${params[1]}:${params[2]}`, {
          build_id: params[0],
          library_id: params[1],
          item_key: params[2],
          state: params[3],
        });
        return [];
      }
      if (sql.includes("INSERT OR REPLACE INTO index_builds")) {
        buildRows.set(params[0], {
          build_id: params[0],
          library_id: params[1],
          scope: params[2],
          status: params[3],
          chunk_signature: params[4],
          chunk_target_chars: params[5],
          chunk_append_tolerance_chars: params[6],
          created_at: params[7],
          reset_completed: 0,
        });
        return [];
      }
      if (sql.includes("UPDATE index_builds SET reset_completed = 1")) {
        buildRows.get(params[0]).reset_completed = 1;
        return [];
      }
      if (
        sql.includes("SELECT build_id, library_id, scope, status") &&
        sql.includes("WHERE build_id = ?")
      ) {
        const row = buildRows.get(params[0]);
        return row ? [row] : [];
      }
      if (sql.includes("UPDATE index_build_targets SET state =")) {
        const row = targetRows.get(`${params[1]}:${params[2]}:${params[3]}`);
        if (row) row.state = params[0];
        return [];
      }
      if (
        sql.includes(
          "SELECT library_id, item_key, state FROM index_build_targets",
        )
      ) {
        return Array.from(targetRows.values()).filter(
          (row) => row.build_id === params[0],
        );
      }
      return [];
    },
    valueQueryAsync: async (sql, params = []) => {
      calls.push({ sql, params });
      return 0;
    },
  };
  const store = new VectorStore(gpuBackend);
  store.initialized = true;
  store.db = db;
  return { store, calls };
}

function mutationBackend(events) {
  return {
    isEnabled: () => true,
    registerProvider: () => {},
    startIfEnabled: async () => {},
    search: async () => [],
    publishMutation: async (event) => events.push(event),
    fallback: () => {},
    setEnabled: async () => {},
    shutdown: async () => {},
  };
}

// Zotero 9 rejects LIKE patterns embedded directly in SQL. Keep the legacy
// failure migration and indexed-item UI query on the same bound-parameter
// contract as production DBConnection.queryAsync().
{
  const calls = [];
  const db = {
    queryAsync: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/\b(?:NOT\s+)?LIKE\s+'[^']*'/i.test(sql)) {
        throw new Error("Please enter a LIKE clause with bindings");
      }
      if (sql.includes("SELECT item_key, content_hash FROM index_status")) {
        return [{ item_key: "ITEM", content_hash: "failed:unknown" }];
      }
      if (sql.includes("SELECT item_key FROM index_status")) {
        return [{ item_key: "ITEM" }];
      }
      return [];
    },
  };
  const store = new VectorStore();
  store.initialized = true;
  store.db = db;

  await store.migrateLegacyFailureMarkers();
  assert.deepEqual(await store.getSuccessfullyIndexedItems(), new Set(["ITEM"]));
  const likeCalls = calls.filter((call) => /\bLIKE\b/i.test(call.sql));
  assert.deepEqual(
    likeCalls.map((call) => call.params),
    [["failed:%"], ["ITEM", "failed:%"], ["failed:%"]],
    "all LIKE patterns are passed as Zotero query bindings",
  );
}

// Per-item replacement is atomic: a write failure rolls every deletion back
// and leaves the cache untouched; success replaces old extra chunks and clears
// only that Library-qualified failure.
{
  const state = {
    embeddings: new Map([
      ["2:ITEM:0", "old-0"],
      ["2:ITEM:1", "old-1"],
    ]),
    vectors: new Map([
      ["2:ITEM:0", "old-vector-0"],
      ["2:ITEM:1", "old-vector-1"],
    ]),
    status: new Map([["2:ITEM", "old-hash"]]),
    failures: new Set(["2:ITEM", "1:ITEM"]),
    targets: new Map([["build:2:ITEM", "failed"]]),
  };
  let failEmbeddingInsert = true;
  const cloneState = () => ({
    embeddings: new Map(state.embeddings),
    vectors: new Map(state.vectors),
    status: new Map(state.status),
    failures: new Set(state.failures),
    targets: new Map(state.targets),
  });
  const restore = (snapshot) => {
    Object.assign(state, snapshot);
  };
  const db = {
    executeTransaction: async (operation) => {
      const snapshot = cloneState();
      try {
        await operation();
      } catch (error) {
        restore(snapshot);
        throw error;
      }
    },
    queryAsync: async (sql, params = []) => {
      if (sql.startsWith("DELETE FROM embeddings")) {
        for (const key of [...state.embeddings.keys()]) {
          if (key.startsWith(`${params[0]}:`)) state.embeddings.delete(key);
        }
      } else if (sql.startsWith("DELETE FROM vectors_f32")) {
        for (const key of [...state.vectors.keys()]) {
          if (key.startsWith(`${params[0]}:`)) state.vectors.delete(key);
        }
      } else if (sql.includes("INSERT OR REPLACE INTO embeddings")) {
        if (failEmbeddingInsert)
          throw new Error("simulated embedding write failure");
        state.embeddings.set(`${params[0]}:${params[1]}`, params[4]);
      } else if (sql.includes("INSERT OR REPLACE INTO vectors_f32")) {
        state.vectors.set(`${params[0]}:${params[1]}`, params[2]);
      } else if (sql.includes("INSERT OR REPLACE INTO index_status")) {
        state.status.set(params[0], params[2]);
      } else if (sql.includes("DELETE FROM index_failures")) {
        state.failures.delete(`${params[0]}:${params[1]}`);
      } else if (
        sql.includes("UPDATE index_build_targets SET state = 'succeeded'")
      ) {
        state.targets.set(
          `${params[0]}:${params[1]}:${params[2]}`,
          "succeeded",
        );
      }
      return [];
    },
  };
  const store = new VectorStore();
  store.initialized = true;
  store.db = db;
  store.vectorCache.set("2:ITEM_0", new Float32Array([1, 0]));
  store.vectorCache.set("2:ITEM_1", new Float32Array([0, 1]));
  const replacement = {
    itemKey: "ITEM",
    libraryID: 2,
    records: [
      {
        itemKey: "ITEM",
        libraryID: 2,
        chunkId: 0,
        vector: new Float32Array([0.5, 0.5]),
        language: "en",
        chunkText: "new",
      },
    ],
    contentHash: "new-hash",
    contentLength: 3,
    sourceKind: "on-demand",
    buildID: "build",
  };

  await assert.rejects(
    store.replaceItemIndex(replacement),
    /simulated embedding write failure/,
  );
  assert.deepEqual([...state.embeddings.keys()], ["2:ITEM:0", "2:ITEM:1"]);
  assert.equal(state.status.get("2:ITEM"), "old-hash");
  assert.equal(state.failures.has("2:ITEM"), true);
  assert.equal(state.failures.has("1:ITEM"), true);
  assert.equal(store.vectorCache.has("2:ITEM_1"), true);

  failEmbeddingInsert = false;
  await store.replaceItemIndex(replacement);
  assert.deepEqual([...state.embeddings.keys()], ["2:ITEM:0"]);
  assert.equal(state.status.get("2:ITEM"), "new-hash");
  assert.equal(state.failures.has("2:ITEM"), false);
  assert.equal(state.failures.has("1:ITEM"), true);
  assert.equal(state.targets.get("build:2:ITEM"), "succeeded");
  assert.equal(store.vectorCache.has("2:ITEM_1"), false);
}

// Failed retries retain the original Library identity even when both
// Libraries contain the same Zotero key.
{
  const groups = groupFailedIndexItems([
    {
      libraryID: 1,
      itemKey: "SAMEKEY",
      errorType: "unknown",
      error: "personal",
      timestamp: 1,
    },
    {
      libraryID: 2,
      itemKey: "SAMEKEY",
      errorType: "unknown",
      error: "group",
      timestamp: 2,
    },
  ]);
  assert.deepEqual(
    groups.map((group) => ({
      libraryID: group[0].libraryID,
      itemKeys: group.map((failure) => failure.itemKey),
    })),
    [
      { libraryID: 1, itemKeys: ["SAMEKEY"] },
      { libraryID: 2, itemKeys: ["SAMEKEY"] },
    ],
  );
}

// Failure identities are Library-qualified. The same Zotero key can fail in
// My Library and a Group Library without collision, and clearing one leaves the
// other intact.
{
  const { store } = mockStore();
  await store.recordFailedItem({
    libraryID: 1,
    itemKey: "SAMEKEY",
    errorType: "unknown",
    error: "personal failure",
    timestamp: 10,
  });
  await store.recordFailedItem({
    libraryID: 2,
    itemKey: "SAMEKEY",
    errorType: "network",
    error: "group failure",
    timestamp: 20,
  });

  assert.deepEqual(await store.getFailedItems(), [
    {
      libraryID: 1,
      itemKey: "SAMEKEY",
      errorType: "unknown",
      error: "personal failure",
      timestamp: 10,
      buildID: undefined,
    },
    {
      libraryID: 2,
      itemKey: "SAMEKEY",
      errorType: "network",
      error: "group failure",
      timestamp: 20,
      buildID: undefined,
    },
  ]);

  await store.clearFailedItems([{ libraryID: 2, itemKey: "SAMEKEY" }]);
  assert.deepEqual(
    (await store.getFailedItems()).map(({ libraryID, itemKey }) => [
      libraryID,
      itemKey,
    ]),
    [[1, "SAMEKEY"]],
  );
}

// A full rebuild's destructive reset and its durable completion flag share a
// transaction. A resumed session can therefore distinguish "never committed"
// from "already cleared" without clearing successful recovery work again.
{
  const { store, calls } = mockStore();
  await store.recordFailedItem({
    libraryID: 1,
    itemKey: "PERSONAL",
    errorType: "unknown",
    error: "keep",
    timestamp: 1,
  });
  await store.recordFailedItem({
    libraryID: 2,
    itemKey: "GROUP",
    errorType: "unknown",
    error: "superseded by rebuild",
    timestamp: 2,
  });
  await store.createBuildSession(
    {
      buildID: "full-1",
      libraryID: 2,
      scope: "full-library",
      status: "indexing",
      chunkSignature: "sig",
      chunkTargetChars: 1000,
      chunkAppendToleranceChars: 500,
      createdAt: 1,
    },
    [{ libraryID: 2, itemKey: "A" }],
  );
  assert.equal((await store.getBuildSession("full-1")).resetCompleted, false);
  await store.clearLibraryForBuild("full-1", 2);
  assert.equal((await store.getBuildSession("full-1")).resetCompleted, true);
  const transactionDeletes = calls.filter((call) =>
    /^DELETE FROM/.test(call.sql),
  );
  assert.equal(transactionDeletes.length, 4);
  const indexDeletes = transactionDeletes.filter(
    (call) => !call.sql.includes("index_failures"),
  );
  assert.ok(indexDeletes.every((call) => call.params[0] === "2:*"));
  assert.deepEqual(
    transactionDeletes.find((call) => call.sql.includes("index_failures"))
      ?.params,
    [2],
  );
  assert.deepEqual(
    (await store.getFailedItems()).map(({ libraryID, itemKey }) => [
      libraryID,
      itemKey,
    ]),
    [[1, "PERSONAL"]],
  );
  assert.ok(
    calls.findIndex((call) => call.sql.includes("reset_completed = 1")) >
      calls.findIndex((call) =>
        call.sql.startsWith("DELETE FROM index_status"),
      ),
  );
}

// Completion is reconciled against the entire frozen target journal, not only
// the failed subset processed by a resume/retry call.
{
  const { store } = mockStore();
  await store.addBuildTargets("full-2", [
    { libraryID: 1, itemKey: "A" },
    { libraryID: 1, itemKey: "B" },
  ]);
  await store.updateBuildTarget(
    "full-2",
    { libraryID: 1, itemKey: "A" },
    "succeeded",
  );
  assert.deepEqual(await store.getBuildTargetSummary("full-2"), {
    total: 2,
    pending: 1,
    succeeded: 1,
    failed: 0,
  });
  await store.updateBuildTarget(
    "full-2",
    { libraryID: 1, itemKey: "B" },
    "succeeded",
  );
  assert.equal((await store.getBuildTargetSummary("full-2")).succeeded, 2);
}

// The durable target journal records each Library-qualified target separately.
{
  const { store } = mockStore();
  await store.addBuildTargets("build-1", [
    { libraryID: 1, itemKey: "SAMEKEY" },
    { libraryID: 2, itemKey: "SAMEKEY" },
  ]);
  assert.deepEqual(await store.getBuildTargets("build-1"), [
    { libraryID: 1, itemKey: "SAMEKEY", state: "pending" },
    { libraryID: 2, itemKey: "SAMEKEY", state: "pending" },
  ]);
}

// Targeted rebuild deletion is batched, Library-qualified, and leaves every
// non-target item untouched.
{
  const { store, calls } = mockStore();
  store.vectorCache.set("2:TARGET_A_0", new Float32Array([1]));
  store.vectorCache.set("2:TARGET_WITH_UNDERSCORE_4", new Float32Array([1]));
  store.vectorCache.set("2:OTHER_0", new Float32Array([1]));
  store.vectorCache.set("3:TARGET_A_0", new Float32Array([1]));

  await store.deleteItemsVectors(
    ["TARGET_A", "TARGET_WITH_UNDERSCORE"],
    2,
  );

  const deletes = calls.filter((call) => /^DELETE FROM/.test(call.sql));
  assert.equal(deletes.length, 3);
  for (const call of deletes) {
    assert.deepEqual(call.params, ["2:TARGET_A", "2:TARGET_WITH_UNDERSCORE"]);
    assert.match(call.sql, /item_key IN \(\?,\?\)/);
  }
  assert.equal(store.vectorCache.has("2:TARGET_A_0"), false);
  assert.equal(store.vectorCache.has("2:TARGET_WITH_UNDERSCORE_4"), false);
  assert.equal(store.vectorCache.has("2:OTHER_0"), true);
  assert.equal(store.vectorCache.has("3:TARGET_A_0"), true);
}

// An explicitly empty target list is a no-op, never a full-Library delete.
{
  const { store, calls } = mockStore();
  await store.deleteItemsVectors([], 2);
  assert.equal(calls.length, 0);
}

// A true full rebuild clears only the requested Library in every index table.
{
  const { store, calls } = mockStore();
  await store.clear(2);
  const deletes = calls.filter((call) => /^DELETE FROM/.test(call.sql));
  assert.equal(deletes.length, 3);
  for (const call of deletes) {
    assert.match(call.sql, /WHERE item_key GLOB \?/);
    assert.deepEqual(call.params, ["2:*"]);
  }
}

// GPU synchronization is emitted only after the SQLite mutation commits, and
// uses Library-qualified identities for every mutation shape.
{
  const events = [];
  const { store } = mockStore(mutationBackend(events));
  await store.replaceItemIndex({
    itemKey: "SYNC_ITEM",
    libraryID: 2,
    records: [{
      itemKey: "SYNC_ITEM",
      libraryID: 2,
      chunkId: 0,
      vector: new Float32Array([1, 0]),
      language: "en",
      chunkText: "sync",
    }],
    contentHash: "sync-hash",
    contentLength: 4,
    sourceKind: "on-demand",
  });
  await store.deleteItemsVectors(["SYNC_ITEM"], 2);
  await store.createBuildSession(
    {
      buildID: "sync-build",
      libraryID: 2,
      scope: "full-library",
      status: "indexing",
      createdAt: 1,
    },
    [],
  );
  await store.clearLibraryForBuild("sync-build", 2);
  await store.clearAll();
  assert.deepEqual(events, [
    { kind: "itemChanged", libraryID: 2, itemKey: "SYNC_ITEM" },
    {
      kind: "itemsDeleted",
      items: [{ libraryID: 2, itemKey: "SYNC_ITEM" }],
    },
    { kind: "libraryCleared", libraryID: 2 },
    { kind: "allCleared" },
  ]);
}

{
  const events = [];
  const { store } = mockStore(mutationBackend(events));
  store.db.executeTransaction = async (operation) => {
    await operation();
    throw new Error("simulated rollback");
  };
  await assert.rejects(
    store.replaceItemIndex({
      itemKey: "ROLLBACK",
      libraryID: 2,
      records: [],
      contentHash: "rollback",
      contentLength: 0,
      sourceKind: "on-demand",
    }),
    /simulated rollback/,
  );
  assert.deepEqual(events, [], "failed transactions must not publish GPU events");
}

// buildIndex classifies by presence, not item count: [] is still targeted.
assert.match(
  serviceSource,
  /const itemKeysProvided = options\.itemKeys !== undefined;/,
);
assert.doesNotMatch(serviceSource, /getCachedContent|setCachedContent/);
assert.doesNotMatch(
  vectorStoreSource,
  /CREATE TABLE IF NOT EXISTS content_cache/,
);
assert.match(vectorStoreSource, /DROP TABLE content_cache/);
assert.ok(
  serviceSource.indexOf("getIndexTextForAttachment") <
    serviceSource.indexOf("processor.extractText", serviceSource.indexOf("getIndexTextForAttachment")),
  "existing Doc2X/MinerU Markdown must be resolved before the PDF fallback",
);
assert.match(
  serviceSource,
  /const content = await this\.extractItemContent\([\s\S]*?this\.textChunker\.chunk\(content\)/,
  "resolved item text flows directly into chunking without a SQLite body cache",
);
assert.match(
  serviceSource,
  /const fullLibraryRebuild = rebuild && !itemKeysProvided;/,
);
assert.match(
  serviceSource,
  /const targetedRebuild = rebuild && itemKeysProvided;/,
);
const targetedBranch = serviceSource.slice(
  serviceSource.indexOf("if (targetedRebuild)"),
  serviceSource.indexOf("} else if (!rebuild && !force)"),
);
assert.doesNotMatch(
  targetedBranch,
  /deleteItemsVectors|deleteItemVectors|vectorStore\.clear/,
  "targeted rebuilds must preserve old vectors until atomic replacement",
);
assert.match(serviceSource, /replaceItemIndex\(\{/);
assert.match(
  serviceSource,
  /invalidateStoredChunkingSignature\(libraryID\)[\s\S]*?clearLibraryForBuild\(buildID, libraryID\)/,
);
assert.match(serviceSource, /getBuildTargetSummary\(buildID\)/);
assert.match(
  serviceSource,
  /reconcileFullLibraryBuildTargets\(buildID, libraryID\)/,
);
assert.match(
  serviceSource,
  /if \(!this\._activeFullLibraryRebuild\) return;[\s\S]*?addBuildTargets\(buildID, missing\)/,
  "final Library reconciliation must be isolated to full-Library rebuilds",
);
assert.doesNotMatch(serviceSource, /vectorStore\.clear\(\)/);
assert.match(
  serviceSource,
  /getByLibraryAndKeyAsync\(libraryID, key\)/,
  "item lookup must use the retry group's original Library ID",
);
assert.match(serviceSource, /libraryID: first\.libraryID/);

// Targeted/incremental builds keep dimension compatibility checks; only a
// true full rebuild may replace incompatible vectors.
assert.match(
  serviceSource,
  /if \(!fullLibraryBuild\) \{[\s\S]*?checkDimensionCompatibility\(\)/,
);

console.log("Index lifecycle regression tests passed");
