/* eslint-env node */

/**
 * The two indexes are ONE index as far as the user is concerned.
 *
 * The plugin keeps a semantic vector index and a body-keyword inverted index in
 * the same SQLite file, written in one pass from one parse. Every constructive
 * path already treated them as a unit; the DESTRUCTIVE ones did not, and that
 * asymmetry is what this suite exists to prevent coming back:
 *
 *   - "Delete all" (clearAll) emptied the six vector tables and left kw_terms,
 *     kw_docs and kw_postings untouched. keyword_search then went on answering
 *     for documents whose vectors, index_status rows and failure records had
 *     all been deleted — rows nothing else in the plugin could explain.
 *   - A full-library rebuild (clearLibraryForBuild) had the same hole, and a
 *     worse consequence: it committed a "reset completed" flag over a keyword
 *     index that had not been reset, so resuming the build skipped the cleanup
 *     for good.
 *
 * Both are tested here against REAL SQLite rather than a mock, because what
 * failed was the SQL, not the control flow.
 *
 * The suite also pins the statistics the preferences pane reads. Those numbers
 * are the only place a user can see that the two indexes agree, so a count that
 * silently means something else is a bug in exactly the tool you would use to
 * notice the bug.
 *
 * Run with:
 *   node --experimental-strip-types --experimental-sqlite scripts/test-index-sync.js
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./index-failure-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => undefined };

const { KeywordIndexStore } = await import(
  "../src/modules/keyword/keywordIndexStore.ts"
);
const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");
const { SemanticSearchService } = await import(
  "../src/modules/semantic/semanticSearchService.ts"
);
const { buildToolCatalog, renderToolDoctrine, toolDoctrineUri } = await import(
  "../src/modules/toolCatalog.ts"
);

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Adapt node:sqlite to the two methods the store uses. */
function adapt(sqlite, beforeQuery = () => {}) {
  let depth = 0;
  return {
    async queryAsync(sql, params = []) {
      beforeQuery(sql, params);
      const statement = sqlite.prepare(sql);
      const normalised = params.map((value) =>
        typeof value === "boolean" ? (value ? 1 : 0) : value,
      );
      if (/^\s*(select|pragma)/iu.test(sql))
        return statement.all(...normalised);
      statement.run(...normalised);
      return [];
    },
    async valueQueryAsync(sql, params = []) {
      beforeQuery(sql, params);
      const statement = sqlite.prepare(sql);
      const normalised = params.map((value) =>
        typeof value === "boolean" ? (value ? 1 : 0) : value,
      );
      const row = statement.get(...normalised);
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(fn) {
      // Zotero's executeTransaction joins an enclosing transaction rather than
      // failing, and clearLibraryForBuild relies on that: it clears the keyword
      // index from inside the vector transaction.
      if (depth > 0) return fn();
      depth += 1;
      sqlite.exec("BEGIN");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        depth -= 1;
      }
    },
    get transactionDepth() {
      return depth;
    },
  };
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-index-sync-"));
const opened = [];

function freshStore() {
  const file = path.join(
    tempDir,
    `sync-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  const sqlite = new DatabaseSync(file);
  opened.push(sqlite);
  return { store: new KeywordIndexStore(adapt(sqlite)), sqlite };
}

async function freshCombinedStore() {
  const file = path.join(
    tempDir,
    `atomic-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  const sqlite = new DatabaseSync(file);
  opened.push(sqlite);
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

  const fault = { when: null };
  const db = adapt(sqlite, (sql, params) => {
    if (fault.when?.(sql, params)) {
      throw new Error("injected atomic delete failure");
    }
  });
  const events = [];
  const store = new VectorStore({
    isEnabled: () => true,
    registerProvider: () => {},
    startIfEnabled: async () => {},
    search: async () => [],
    publishMutation: async (event) => {
      events.push({ event, transactionDepth: db.transactionDepth });
    },
    fallback: () => {},
    setEnabled: async () => {},
    shutdown: async () => {},
  });
  store.initialized = true;
  store.db = db;
  store.dbPath = file;
  await store.getKeywordIndexStore().ensureSchema();
  return { store, sqlite, fault, events };
}

function storageKey(libraryID, itemKey) {
  return libraryID === 1 ? itemKey : `${libraryID}:${itemKey}`;
}

async function seedCombined(store, sqlite, libraryID, itemKey) {
  const key = storageKey(libraryID, itemKey);
  sqlite
    .prepare(`INSERT INTO embeddings (item_key, chunk_id) VALUES (?, 0)`)
    .run(key);
  sqlite
    .prepare(`INSERT INTO vectors_f32 (item_key, chunk_id) VALUES (?, 0)`)
    .run(key);
  sqlite.prepare(`INSERT INTO index_status (item_key) VALUES (?)`).run(key);
  await store.getKeywordIndexStore().writeItem(PAPER(libraryID, itemKey));
  store.vectorCache.set(`${key}_0`, new Float32Array([1, 0]));
}

function combinedState(sqlite, libraryID, itemKey) {
  const key = storageKey(libraryID, itemKey);
  const count = (table, column, value) =>
    Number(
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
        .get(value).n,
    );
  return {
    embeddings: count("embeddings", "item_key", key),
    float32: count("vectors_f32", "item_key", key),
    status: count("index_status", "item_key", key),
    keywordAlive: Number(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM kw_docs WHERE library_id = ? AND item_key = ? AND alive = 1`,
        )
        .get(libraryID, itemKey).n,
    ),
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Row counts of the three keyword tables. */
function keywordRows(sqlite) {
  const one = (table) =>
    Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  return {
    terms: one("kw_terms"),
    docs: one("kw_docs"),
    postings: one("kw_postings"),
  };
}

const PAPER = (libraryID, itemKey) => ({
  libraryID,
  itemKey,
  title: "Columnar to equiaxed transition in directional solidification",
  abstract: "The withdrawal rate controls the columnar grain array.",
  tags: ["solidification", "CET"],
  publicationTitle: "Acta Materialia",
  creator: "Kurz W, Fisher D",
  extra: "DOI 10.0000/example",
  chunks: [
    "Columnar to equiaxed transition in directional solidification",
    "The withdrawal rate controls the columnar grain array during growth.",
    "Thermal gradient ahead of the interface sets the dendrite arm spacing.",
  ],
});

// ---------------------------------------------------------------------------
// 1. Scoped clearing: the shape clearLibraryForBuild depends on.
// ---------------------------------------------------------------------------

test("clearing one library leaves the other library's keyword index intact", async () => {
  const { store, sqlite } = freshStore();
  await store.writeItem(PAPER(1, "AAAA1111"));
  await store.writeItem(PAPER(2, "BBBB2222"));
  const before = keywordRows(sqlite);
  assert.ok(before.docs === 2 && before.postings > 0);

  await store.clear(1);

  const after = keywordRows(sqlite);
  assert.equal(after.docs, 1, "only the cleared library's document is gone");
  assert.ok(after.postings > 0, "the surviving library keeps its postings");
  const libraries = (table) =>
    sqlite
      .prepare(`SELECT DISTINCT library_id AS l FROM ${table}`)
      .all()
      .map((row) => Number(row.l));
  assert.deepEqual(libraries("kw_docs"), [2]);
  assert.deepEqual(libraries("kw_terms"), [2]);
  // Every surviving posting must point at a surviving term. A term-scoped
  // delete that missed rows would leave orphans that no query can reach but
  // every count includes.
  assert.equal(
    Number(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM kw_postings WHERE term_id NOT IN (SELECT term_id FROM kw_terms)`,
        )
        .get().n,
    ),
    0,
    "no orphaned postings may survive a scoped clear",
  );
});

test("clearWithoutTransaction is the same clear, minus the transaction", async () => {
  // clearLibraryForBuild calls this one from INSIDE the vector transaction, so
  // that a rebuild cannot commit "vectors deleted" without "keywords deleted".
  const plain = freshStore();
  await plain.store.writeItem(PAPER(1, "AAAA1111"));
  await plain.store.writeItem(PAPER(2, "BBBB2222"));
  await plain.store.clear(1);

  const raw = freshStore();
  await raw.store.writeItem(PAPER(1, "AAAA1111"));
  await raw.store.writeItem(PAPER(2, "BBBB2222"));
  await raw.store.clearWithoutTransaction(1);

  assert.deepEqual(keywordRows(raw.sqlite), keywordRows(plain.sqlite));
});

test("clearing with no library empties the keyword index completely", async () => {
  const { store, sqlite } = freshStore();
  await store.writeItem(PAPER(1, "AAAA1111"));
  await store.writeItem(PAPER(2, "BBBB2222"));
  await store.clear();
  assert.deepEqual(keywordRows(sqlite), { terms: 0, docs: 0, postings: 0 });
});

test("re-indexing then compacting leaves no residue of the old revision", async () => {
  // This is the rebuild story in miniature: writeItem tombstones the previous
  // revision instead of deleting it, so "no residue" depends on compact()
  // actually running at the end of a build.
  const { store, sqlite } = freshStore();
  await store.writeItem(PAPER(1, "AAAA1111"));
  await store.writeItem({ ...PAPER(1, "AAAA1111"), chunks: ["Short."] });

  const beforeCompact = await store.report(1);
  assert.equal(beforeCompact.documentCount, 1, "only one live revision");
  assert.equal(
    beforeCompact.tombstonedDocuments,
    1,
    "the superseded revision is still on disk until compaction",
  );

  await store.compact();

  const afterCompact = await store.report(1);
  assert.equal(afterCompact.tombstonedDocuments, 0);
  assert.equal(
    Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM kw_docs`).get().n),
    1,
    "compaction removes the tombstoned row itself, not just its postings",
  );
  assert.equal(
    Number(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM kw_postings WHERE term_id NOT IN (SELECT term_id FROM kw_terms)`,
        )
        .get().n,
    ),
    0,
  );
});

// ---------------------------------------------------------------------------
// 2. The statistics the preferences pane shows.
// ---------------------------------------------------------------------------

test("the keyword report counts what its labels say it counts", async () => {
  const { store, sqlite } = freshStore();
  await store.writeItem(PAPER(1, "AAAA1111"));
  await store.writeItem(PAPER(1, "CCCC3333"));
  // A metadata-only document: real, indexed, and with no body passages at all.
  await store.writeItem({ ...PAPER(1, "DDDD4444"), chunks: [] });
  // Another library must not leak into this library's figures.
  await store.writeItem(PAPER(2, "BBBB2222"));

  const report = await store.report(1);

  assert.equal(report.documentCount, 3, "live documents in THIS library");
  assert.equal(report.documentsWithBody, 2);
  assert.equal(report.documentsMetadataOnly, 1);
  assert.equal(
    report.documentsWithBody + report.documentsMetadataOnly,
    report.documentCount,
    "the split must account for every document, with no third bucket",
  );
  assert.equal(
    report.indexedChunks,
    6,
    "three body passages each, for the two documents that have a body",
  );
  assert.equal(
    report.termCount,
    Number(
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM kw_terms WHERE library_id = 1`)
        .get().n,
    ),
    "terms are scoped to the library",
  );
  assert.ok(report.termCount > 0);
  assert.equal(
    report.postingCount,
    Number(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM kw_postings WHERE term_id IN (SELECT term_id FROM kw_terms WHERE library_id = 1)`,
        )
        .get().n,
    ),
    "postings are scoped to this library",
  );
  assert.notEqual(
    report.postingCount,
    Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM kw_postings`).get().n),
    "the other library must make the old whole-table count observably wrong",
  );
});

test("an empty keyword index reports zeroes rather than failing", async () => {
  const { store } = freshStore();
  const report = await store.report(1);
  assert.deepEqual(report, {
    documentCount: 0,
    indexedChunks: 0,
    termCount: 0,
    postingCount: 0,
    documentsWithBody: 0,
    documentsMetadataOnly: 0,
    tombstonedDocuments: 0,
  });
});

test("removing one item removes it from the report", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER(1, "AAAA1111"));
  await store.writeItem(PAPER(1, "CCCC3333"));
  await store.removeItem(1, "AAAA1111");
  const report = await store.report(1);
  assert.equal(report.documentCount, 1);
  assert.equal(report.tombstonedDocuments, 1, "tombstoned, not yet reclaimed");
  await store.compact();
  assert.equal((await store.report(1)).tombstonedDocuments, 0);
});

test("a keyword SQL failure rolls back the semantic half of one-item deletion", async () => {
  const { store, sqlite, fault, events } = await freshCombinedStore();
  await seedCombined(store, sqlite, 2, "ATOMIC_A");
  fault.when = (sql) => /UPDATE kw_docs SET alive = 0/.test(sql);

  await assert.rejects(
    store.deleteItemVectors("ATOMIC_A", 2),
    /injected atomic delete failure/,
  );

  assert.deepEqual(combinedState(sqlite, 2, "ATOMIC_A"), {
    embeddings: 1,
    float32: 1,
    status: 1,
    keywordAlive: 1,
  });
  assert.equal(store.vectorCache.has("2:ATOMIC_A_0"), true);
  assert.deepEqual(
    events,
    [],
    "a rolled-back deletion publishes no completion",
  );
});

test("a semantic SQL failure leaves the keyword document alive", async () => {
  const { store, sqlite, fault, events } = await freshCombinedStore();
  await seedCombined(store, sqlite, 2, "ATOMIC_B");
  fault.when = (sql) => /DELETE FROM vectors_f32/.test(sql);

  await assert.rejects(
    store.deleteItemVectors("ATOMIC_B", 2),
    /injected atomic delete failure/,
  );

  assert.deepEqual(combinedState(sqlite, 2, "ATOMIC_B"), {
    embeddings: 1,
    float32: 1,
    status: 1,
    keywordAlive: 1,
  });
  assert.equal(store.vectorCache.has("2:ATOMIC_B_0"), true);
  assert.deepEqual(events, []);
});

test("a keyword failure rolls back the whole batch and preserves another library", async () => {
  const { store, sqlite, fault, events } = await freshCombinedStore();
  await seedCombined(store, sqlite, 2, "BATCH_A");
  await seedCombined(store, sqlite, 2, "BATCH_B");
  await seedCombined(store, sqlite, 3, "BATCH_A");
  fault.when = (sql, params) =>
    /UPDATE kw_docs SET alive = 0/.test(sql) && params[1] === "BATCH_B";

  await assert.rejects(
    store.deleteItemsVectors(["BATCH_A", "BATCH_B"], 2),
    /injected atomic delete failure/,
  );

  for (const [libraryID, itemKey] of [
    [2, "BATCH_A"],
    [2, "BATCH_B"],
    [3, "BATCH_A"],
  ]) {
    assert.deepEqual(combinedState(sqlite, libraryID, itemKey), {
      embeddings: 1,
      float32: 1,
      status: 1,
      keywordAlive: 1,
    });
  }
  assert.deepEqual(events, []);
});

test("an atomic batch publishes completion only after commit", async () => {
  const { store, sqlite, events } = await freshCombinedStore();
  await seedCombined(store, sqlite, 2, "COMMIT_A");
  await seedCombined(store, sqlite, 2, "COMMIT_B");
  await seedCombined(store, sqlite, 3, "COMMIT_A");

  await store.deleteItemsVectors(["COMMIT_A", "COMMIT_B"], 2);

  assert.deepEqual(combinedState(sqlite, 2, "COMMIT_A"), {
    embeddings: 0,
    float32: 0,
    status: 0,
    keywordAlive: 0,
  });
  assert.deepEqual(combinedState(sqlite, 2, "COMMIT_B"), {
    embeddings: 0,
    float32: 0,
    status: 0,
    keywordAlive: 0,
  });
  assert.deepEqual(combinedState(sqlite, 3, "COMMIT_A"), {
    embeddings: 1,
    float32: 1,
    status: 1,
    keywordAlive: 1,
  });
  assert.deepEqual(events, [
    {
      event: {
        kind: "itemsDeleted",
        items: [
          { libraryID: 2, itemKey: "COMMIT_A" },
          { libraryID: 2, itemKey: "COMMIT_B" },
        ],
      },
      transactionDepth: 0,
    },
  ]);
});

test("a keyword failure rolls back clearIndex before cache and GPU completion", async () => {
  const { store, sqlite, fault, events } = await freshCombinedStore();
  await seedCombined(store, sqlite, 2, "CLEAR_A");
  await seedCombined(store, sqlite, 3, "CLEAR_A");
  const service = Object.create(SemanticSearchService.prototype);
  service.initialize = async () => {};
  service.vectorStore = store;
  fault.when = (sql) => /DELETE FROM kw_postings/.test(sql);

  await assert.rejects(service.clearIndex(2), /injected atomic delete failure/);

  for (const libraryID of [2, 3]) {
    assert.deepEqual(combinedState(sqlite, libraryID, "CLEAR_A"), {
      embeddings: 1,
      float32: 1,
      status: 1,
      keywordAlive: 1,
    });
  }
  assert.equal(store.vectorCache.has("2:CLEAR_A_0"), true);
  assert.deepEqual(events, [], "a rolled-back clear publishes no completion");
});

// ---------------------------------------------------------------------------
// 3. Every deletion path reaches both indexes.
//
// Read from source rather than executed: these are wiring facts about which
// function calls which, and the failure was always an omitted call, never a
// wrong result from a call that was made.
// ---------------------------------------------------------------------------

const source = (relative) =>
  fs.readFileSync(path.join(rootDir, relative), "utf8");

const vectorStoreSource = source("src/modules/semantic/vectorStore.ts");
const serviceSource = source("src/modules/semantic/semanticSearchService.ts");
const hooksSource = source("src/hooks.ts");
const preferenceSource = source("src/modules/preferenceScript.ts");
const embeddingSource = source("src/modules/semantic/embeddingService.ts");
const serverSource = source("src/modules/streamableMCPServer.ts");
const chunksSource = source("src/modules/documentChunks.ts");
const deepDiveSource = source("src/modules/documentDeepDive.ts");
const bodyStateSource = source("src/modules/semantic/bodyIndexState.ts");
const resetSource = source("src/modules/semantic/semanticDatabaseReset.ts");
const enumerationSource = source("src/modules/semantic/libraryEnumeration.ts");

/** The body of one method, from its signature to the next top-level method. */
function methodBody(text, signature) {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `could not find ${signature}`);
  const rest = text.slice(start + signature.length);
  const end = rest.search(
    /\n {2}(?:\/\*\*|(?:private |protected )?(?:async )?[a-zA-Z])/,
  );
  return rest.slice(0, end === -1 ? rest.length : end);
}

/** The callback body of a method's first database transaction. */
function transactionBody(method) {
  const signature = method.includes("await this.mutateEmbeddings(async () => {")
    ? "await this.mutateEmbeddings(async () => {"
    : "await this.db.executeTransaction(async () => {";
  if (signature.includes("mutateEmbeddings")) {
    assert.match(
      vectorStoreSource,
      /private async mutateEmbeddings[\s\S]*?await this\.db\.executeTransaction\(write\)/u,
      "the shared mutation helper must open the transaction",
    );
  }
  const start = method.indexOf(signature);
  assert.ok(start >= 0, "method must open a database transaction");
  const bodyStart = start + signature.length;
  const end = method.indexOf(
    signature.includes("mutateEmbeddings") ? "\n    }, [" : "\n    });",
    bodyStart,
  );
  assert.ok(end >= 0, "could not find the transaction boundary");
  return method.slice(bodyStart, end);
}

test("deleting one item's vectors also drops its keyword postings", async () => {
  const singleDelete = methodBody(
    vectorStoreSource,
    "async deleteItemVectors(itemKey: string, libraryID?: number)",
  );
  assert.match(
    transactionBody(singleDelete),
    /keywordStore\.removeItem\(/,
    "deleteItemVectors must tombstone the keyword document in the same transaction",
  );
  const batchDelete = methodBody(
    vectorStoreSource,
    "async deleteItemsVectors(",
  );
  assert.match(
    transactionBody(batchDelete),
    /keywordStore\.removeItem\(/,
    "the batch form must tombstone every keyword document in the same transaction",
  );
});

test("hooks may delete vectors directly, because that path now covers both", async () => {
  // Collection and selected-item commands reach the vector store directly.
  // Permanent deletion uses the recovery wrapper around the same atomic entry.
  const directSingleDeletes =
    hooksSource.match(/vectorStore\.deleteItemVectors\(/g) ?? [];
  const directBatchDeletes =
    hooksSource.match(/vectorStore\.deleteItemsVectors\(/g) ?? [];
  const recoveredDeletes =
    hooksSource.match(/deleteItemIndexWithRecovery\(/g) ?? [];
  assert.ok(
    directSingleDeletes.length + directBatchDeletes.length >= 2,
    "collection and selected-item commands still use atomic vector-store deletion",
  );
  assert.ok(
    recoveredDeletes.length >= 2,
    "notifier deletions must be recoverable",
  );
  assert.match(
    transactionBody(
      methodBody(
        vectorStoreSource,
        "async deleteItemVectors(itemKey: string, libraryID?: number)",
      ),
    ),
    /keywordStore\.removeItem\(/,
  );
});

test("collection and selected-item deletion cannot swallow keyword failures", async () => {
  const collectionHandler = hooksSource.slice(
    hooksSource.indexOf("async function handleClearCollectionIndex"),
    hooksSource.indexOf("async function handleClearSelectedIndex"),
  );
  const selectedHandler = hooksSource.slice(
    hooksSource.indexOf("async function handleClearSelectedIndex"),
    hooksSource.indexOf("async function runBuildsPerLibrary"),
  );
  for (const [handler, successMessage] of [
    [collectionHandler, "menu-collection-index-cleared"],
    [selectedHandler, "menu-semantic-clear-selected-done"],
  ]) {
    assert.match(handler, /await vectorStore\.deleteItemsVectors\(/);
    assert.doesNotMatch(handler, /deleteItemVectors\(/);
    assert.doesNotMatch(
      handler,
      /Ignore errors for items that weren't indexed/,
    );
    assert.ok(
      handler.indexOf("await vectorStore.deleteItemsVectors(") <
        handler.indexOf(successMessage),
      "the success notification must be constructed only after deletion commits",
    );
  }
});

test("clearing a library clears both indexes", async () => {
  const clearIndex = methodBody(
    serviceSource,
    "async clearIndex(libraryID?: number): Promise<void> {",
  );
  assert.match(clearIndex, /vectorStore\.clear\(libraryID\)/);
  assert.doesNotMatch(clearIndex, /clearKeywordIndex\(/);
  const atomicClear = methodBody(
    vectorStoreSource,
    "async clear(libraryID?: number)",
  );
  assert.match(
    transactionBody(atomicClear),
    /keywordStore\.clearWithoutTransaction\(libraryID\)/,
  );
});

test("a full-library rebuild resets the keyword index inside the same transaction", async () => {
  const forBuild = methodBody(vectorStoreSource, "async clearLibraryForBuild(");
  assert.match(
    forBuild,
    /clearWithoutTransaction\(libraryID\)/,
    "the keyword clear must be the transaction-less form, i.e. inside the vector transaction",
  );
  // Ordering is the point: the flag that says "this rebuild already reset the
  // library" must not commit before the keyword index is actually reset.
  assert.ok(
    forBuild.indexOf("clearWithoutTransaction(libraryID)") <
      forBuild.indexOf("reset_completed = 1"),
    "the keyword clear must precede the reset flag",
  );
});

test("a build ends by reclaiming superseded keyword postings", async () => {
  assert.match(
    serviceSource,
    /finally \{[\s\S]*?compactKeywordIndex\(\)/,
    "compaction must run even when the build failed or was aborted",
  );
});

test("one statistics refresh updates both indexes and API usage", async () => {
  const serviceStats = methodBody(serviceSource, "async getStats():");
  assert.match(serviceStats, /getStats\(libraryID\)/, "semantic counts");
  assert.match(
    serviceStats,
    /getKeywordIndexReport\(libraryID\)/,
    "keyword counts",
  );
  assert.match(
    serviceStats,
    /getIndexedDocumentTotals\(libraryID\)/,
    "combined total",
  );
  assert.match(serviceStats, /getIndexStorageBreakdown\(\)/, "storage split");

  const refresh = methodBody(
    preferenceSource,
    "function refreshAllStats(silent = false) {",
  );
  assert.match(refresh, /loadSemanticStats\(silent\)/);
  assert.match(refresh, /#refresh-api-usage-button/);
  assert.match(refresh, /apiRefreshBtn\?\.click\(\)/);
});

test("reset statistics only resets API usage counters", async () => {
  const reset = methodBody(
    preferenceSource,
    "async function resetApiUsageStats() {",
  );
  assert.match(reset, /resetUsageStats\(true\)/);
  assert.doesNotMatch(reset, /clear(?:All|Index|Keyword|Semantic)|delete/i);
});

test("settings paths use the Search panel name in every locale", async () => {
  assert.doesNotMatch(embeddingSource, /Settings\s*→\s*Semantic Search/);
  assert.doesNotMatch(embeddingSource, /设置\s*→\s*语义搜索/);
  assert.doesNotMatch(
    serverSource,
    /Preferences\s*→\s*Zotero LitSynapse\s*→\s*Semantic Search/,
  );

  const expectedTitles = new Map([
    ["en-US", "Search"],
    ["zh-CN", "搜索"],
    ["de-DE", "Suche"],
    ["es-ES", "Búsqueda"],
    ["fr-FR", "Recherche"],
    ["ja-JP", "検索"],
  ]);
  for (const [locale, title] of expectedTitles) {
    const localeSource = source(`addon/locale/${locale}/preferences.ftl`);
    assert.match(
      localeSource,
      new RegExp(`^pref-embedding-title = ${title}$`, "mu"),
      `${locale} must call the settings panel ${title}`,
    );
  }
});

test("dual-index operations are not described as semantic-only", async () => {
  assert.doesNotMatch(hooksSource, /clear the semantic index for/i);
  assert.doesNotMatch(hooksSource, /Auto-updating semantic index/i);
  assert.doesNotMatch(preferenceSource, /semantic database/i);
  assert.doesNotMatch(resetSource, /semantic database/i);
  assert.doesNotMatch(vectorStoreSource, /Semantic database/);
  assert.doesNotMatch(
    chunksSource,
    /build\/refresh the semantic index in the plugin preferences/i,
  );
  assert.doesNotMatch(
    deepDiveSource,
    /Build or refresh the semantic index for it.*update semantic index/i,
  );
  assert.doesNotMatch(
    serverSource,
    /search_fulltext needs the semantic index/i,
  );
  assert.doesNotMatch(
    bodyStateSource,
    /item context menu → update semantic index/i,
  );
  assert.doesNotMatch(
    serviceSource,
    /item context menu → update semantic index/i,
  );
  assert.doesNotMatch(
    enumerationSource,
    /existing semantic index has been left untouched/i,
  );
});

// ---------------------------------------------------------------------------
// 4. What the tools say about themselves.
// ---------------------------------------------------------------------------

const catalog = buildToolCatalog();
const tool = (name) => {
  const found = catalog.find((entry) => entry.name === name);
  assert.ok(found, `${name} must exist in the catalog`);
  return found;
};

/**
 * Everything a caller ends up reading about one tool, both halves joined.
 *
 * A tool's prose lives in two fields: `description`, which tools/list re-sends
 * every turn, and `doctrine`, which the caller fetches once from
 * zotero://tool/<name>. Which half a given sentence sits in is a token-budget
 * decision, and it has already moved once — the split that introduced
 * `doctrine` left this suite asserting on `description` for a sentence that had
 * become doctrine, so the test failed while the guarantee it protects was
 * perfectly intact and still being served.
 *
 * So assert on what the model reads, not on where this build happens to keep
 * it. renderToolDoctrine is the exact text zotero://tool/<name> returns; a tool
 * with no doctrine has only its description to read.
 */
const toolText = (name) =>
  renderToolDoctrine(catalog, toolDoctrineUri(name)) ?? tool(name).description;

test("find_similar does not promise a fixed page size", async () => {
  // The server applies resolveResultCap(args.topK, settings.maxDocuments): the
  // page size IS the user's maximum-documents setting. "20 documents per page"
  // was true only for a user who never changed the default.
  const similar = tool("find_similar");
  const text = [
    toolText("find_similar"),
    similar.inputSchema.properties.topK.description,
  ].join("\n");
  assert.doesNotMatch(
    text,
    /\b20 documents per page\b/,
    "the page size is a user setting, not a constant",
  );
  assert.doesNotMatch(
    text,
    /maximum \(20\)/,
    "naming the default's value as the maximum reads as a hard limit",
  );
  assert.match(
    toolText("find_similar"),
    /page size is the user's configured MAXIMUM NUMBER OF DOCUMENTS/i,
  );
  assert.match(
    similar.inputSchema.properties.topK.description,
    /user's configured maximum number of documents/i,
  );
});

test("find_similar stays purely semantic", async () => {
  // Its definition is "representative chunks -> vector similarity -> document
  // aggregation". Nothing keyword-shaped may creep into it.
  const similar = tool("find_similar");
  assert.match(toolText("find_similar"), /Purely semantic/i);
  assert.deepEqual(
    Object.keys(similar.inputSchema.properties).filter((name) =>
      /keyword/i.test(name),
    ),
    [],
    "no keyword parameter may appear on find_similar",
  );
  assert.match(
    toolText("find_similar"),
    /the floor applied to it is the user's SEMANTIC relevance threshold/i,
  );
});

test("no tool claims the body is unsearchable", async () => {
  // hybrid_search and keyword_search DO search body text - the indexed body.
  // The old wording said they did not, and a model that believes it will never
  // pass body-bearing keywords.
  for (const entry of catalog) {
    const text = JSON.stringify(entry);
    assert.doesNotMatch(
      text,
      /document body text is not scanned|body text is not scanned|no full-text scan/i,
      `${entry.name} still says the body is not searched`,
    );
    assert.doesNotMatch(
      text,
      /metadata-only keyword|keyword retrieval over Zotero metadata only/i,
      `${entry.name} still describes keyword retrieval as metadata-only`,
    );
  }
  for (const name of ["hybrid_search", "keyword_search"]) {
    assert.match(
      toolText(name),
      /indexed body|body text/i,
      `${name} must say that indexed body text is searched`,
    );
  }
});

test("search_fulltext does not claim its keyword floor is on the BM25F scale", async () => {
  // Inside one paper the keyword branch is rankLexicalCandidates over that
  // paper's own passages, not BM25F over a document's fields. The description
  // body has said so since the scales were separated; the parameter used to
  // contradict it.
  const deepDive = tool("search_fulltext");
  assert.doesNotMatch(
    deepDive.inputSchema.properties.minKeywordScore.description,
    /on the normalised BM25F scale/i,
  );
  assert.match(
    deepDive.inputSchema.properties.minKeywordScore.description,
    /NOT the BM25F scale/i,
  );
});

test("the packaged configuration guides name only tools that exist", async () => {
  // This list is the fourth copy of the tool names and it rotted the longest:
  // every locale advertised get_item_fulltext for as long as it had not
  // existed. A user pasted that guide into their client.
  const known = new Set(catalog.map((entry) => entry.name));
  const localeDir = path.join(rootDir, "addon/locale");
  const locales = fs.readdirSync(localeDir);
  assert.ok(locales.length >= 6, "every shipped locale must be checked");

  for (const locale of locales) {
    const file = path.join(localeDir, locale, "addon.ftl");
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    const block = /^config-guide-tools-list =\n((?:[ \t]+.*\n)+)/m.exec(source);
    assert.ok(block, `${locale}: the configuration guide must list tools`);
    const named = Array.from(
      block[1].matchAll(/^\s+-\s+([a-z][a-z0-9_]+)\s+-/gm),
    ).map((match) => match[1]);
    assert.ok(named.length >= 5, `${locale}: the list looks empty`);
    for (const name of named) {
      assert.ok(
        known.has(name),
        `${locale}: the configuration guide advertises "${name}", which is not a tool`,
      );
    }
  }
});

// ---------------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(
      `       ${String(error.message).split("\n").join("\n       ")}`,
    );
  }
}
for (const sqlite of opened) {
  try {
    sqlite.close();
  } catch {
    // Already closed; releasing the file lock is all that matters.
  }
}
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch (error) {
  console.warn(`  note: could not remove ${tempDir}: ${error.code ?? error}`);
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
