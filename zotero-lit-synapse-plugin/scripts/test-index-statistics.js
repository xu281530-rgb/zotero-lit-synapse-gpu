/* eslint-env node */
/**
 * The numbers the preferences pane prints, checked against a REAL database
 * holding BOTH indexes.
 *
 * Three defects motivated this suite, and each is pinned by a test that the
 * previous implementation cannot pass:
 *
 * 1. The combined document total was `max(semantic, keyword)`. A maximum is the
 *    union only when one index's documents are a subset of the other's; the
 *    moment the two sets merely overlap — a partially rebuilt index, a keyword
 *    write that failed, an item removed from one index and not yet the other —
 *    it undercounts. It also compared a whole-database vector count with a
 *    library-scoped keyword count, so a second library inflated one side only.
 * 2. The posting count was `SELECT COUNT(*) FROM kw_postings`: every library's
 *    rows, plus the tombstoned revisions that compaction has not reclaimed.
 * 3. Neither index reported its own share of the database file.
 *
 * The schema comes from production code (VectorStore.createTables), not from a
 * copy in this file, so a schema change cannot leave these tests measuring a
 * shape that no longer exists.
 *
 *   node --experimental-strip-types --experimental-sqlite scripts/test-index-statistics.js
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const USER_LIBRARY = 1;
const GROUP_LIBRARY = 5;

globalThis.Zotero = { Libraries: { userLibraryID: USER_LIBRARY } };
globalThis.ztoolkit = { log: () => undefined };

const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");

/** Adapt node:sqlite to the three methods the store uses. */
function adapt(sqlite, hooks = {}) {
  let depth = 0;
  return {
    async queryAsync(sql, params = []) {
      hooks.onQuery?.(sql);
      const statement = sqlite.prepare(sql);
      const normalised = params.map((value) =>
        typeof value === "boolean" ? (value ? 1 : 0) : value,
      );
      if (/^\s*(select|pragma|with)/iu.test(sql)) {
        return statement.all(...normalised);
      }
      statement.run(...normalised);
      return [];
    },
    async valueQueryAsync(sql, params = []) {
      hooks.onQuery?.(sql);
      const row = sqlite.prepare(sql).get(...params);
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(fn) {
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
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let tempDir;
const opened = [];

async function freshStore(hooks) {
  const file = path.join(
    tempDir,
    `stats-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  const sqlite = new DatabaseSync(file);
  opened.push(sqlite);
  const store = new VectorStore();
  store.db = adapt(sqlite, hooks);
  store.dbPath = file;
  store.initialized = true;
  // Production DDL, including the keyword tables it creates alongside its own.
  await store.createTables();
  return { store, sqlite, file };
}

/**
 * Store a vector for one document, through the same key normalisation
 * production uses: bare key in My Library, `<libraryID>:<key>` elsewhere.
 */
function addVector(sqlite, libraryID, itemKey, chunkId = 0, language = "en") {
  const storageKey =
    libraryID === USER_LIBRARY ? itemKey : `${libraryID}:${itemKey}`;
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO embeddings (item_key, chunk_id, vector, language, chunk_text, dimensions, vector_int8) VALUES (?, ?, x'', ?, ?, ?, ?)`,
    )
    .run(storageKey, chunkId, language, "passage text", 8, new Uint8Array(8));
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO index_status (item_key, indexed_at, chunk_count, content_hash, content_length, source_kind) VALUES (?, ?, 1, 'hash', 100, 'body')`,
    )
    .run(storageKey, Math.floor(Date.now() / 1000));
}

const PAPER = (libraryID, itemKey, chunks = ["Body passage about nickel."]) => ({
  libraryID,
  itemKey,
  title: `Study ${itemKey}`,
  abstract: "Superalloy creep behaviour under load.",
  tags: ["superalloy"],
  chunks,
});

// ---------------------------------------------------------------------------
// 1. The combined document total is a union.
// ---------------------------------------------------------------------------

test("crossing sets are counted once each, not by taking the larger", async () => {
  const { store, sqlite } = await freshStore();
  // Semantic: A, B.   Keyword: B, C.   Union: A, B, C.
  addVector(sqlite, USER_LIBRARY, "AAAA1111");
  addVector(sqlite, USER_LIBRARY, "BBBB2222");
  await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, "BBBB2222"));
  await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, "CCCC3333"));

  const totals = await store.getIndexedDocumentTotals(USER_LIBRARY);

  assert.equal(totals.semanticDocuments, 2);
  assert.equal(totals.keywordDocuments, 2);
  assert.equal(totals.totalDocuments, 3, "A ∪ B ∪ C");
  // Reverse verification: the implementation this replaced returns 2 here, so
  // restoring it fails this test rather than silently passing it.
  assert.notEqual(
    Math.max(totals.semanticDocuments, totals.keywordDocuments),
    totals.totalDocuments,
    "max() must be provably wrong on this fixture",
  );
});

test("a document held by both indexes is one document", async () => {
  const { store, sqlite } = await freshStore();
  addVector(sqlite, USER_LIBRARY, "AAAA1111", 0);
  addVector(sqlite, USER_LIBRARY, "AAAA1111", 1);
  await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, "AAAA1111"));

  const totals = await store.getIndexedDocumentTotals(USER_LIBRARY);
  assert.equal(totals.semanticDocuments, 1, "two chunks, one document");
  assert.equal(totals.keywordDocuments, 1);
  assert.equal(totals.totalDocuments, 1);
});

test("another library never reaches this library's total", async () => {
  const { store, sqlite } = await freshStore();
  addVector(sqlite, USER_LIBRARY, "AAAA1111");
  await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, "AAAA1111"));
  // A group library with entirely different documents.
  addVector(sqlite, GROUP_LIBRARY, "GGGG1111");
  addVector(sqlite, GROUP_LIBRARY, "GGGG2222");
  await store
    .getKeywordIndexStore()
    .writeItem(PAPER(GROUP_LIBRARY, "GGGG3333"));

  const user = await store.getIndexedDocumentTotals(USER_LIBRARY);
  assert.equal(user.semanticDocuments, 1);
  assert.equal(user.keywordDocuments, 1);
  assert.equal(user.totalDocuments, 1);

  const group = await store.getIndexedDocumentTotals(GROUP_LIBRARY);
  assert.equal(group.semanticDocuments, 2);
  assert.equal(group.keywordDocuments, 1);
  assert.equal(group.totalDocuments, 3, "GGGG1111 ∪ GGGG2222 ∪ GGGG3333");
});

test("a group library's prefixed vector key matches its bare keyword key", async () => {
  const { store, sqlite } = await freshStore();
  // The SAME document, stored as `5:GGGG1111` by the vector index and as
  // `GGGG1111` by the keyword index. Without normalisation the union counts it
  // twice.
  addVector(sqlite, GROUP_LIBRARY, "GGGG1111");
  await store
    .getKeywordIndexStore()
    .writeItem(PAPER(GROUP_LIBRARY, "GGGG1111"));

  const totals = await store.getIndexedDocumentTotals(GROUP_LIBRARY);
  assert.equal(totals.totalDocuments, 1);
});

test("residue from a half-finished rebuild is counted honestly", async () => {
  const { store, sqlite } = await freshStore();
  // Vectors written, keyword write never completed.
  addVector(sqlite, USER_LIBRARY, "AAAA1111");
  addVector(sqlite, USER_LIBRARY, "BBBB2222");
  // Keyword document whose vectors were already cleared.
  await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, "CCCC3333"));
  // A tombstoned keyword revision belongs to nobody.
  await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, "DDDD4444"));
  await store.getKeywordIndexStore().removeItem(USER_LIBRARY, "DDDD4444");

  const totals = await store.getIndexedDocumentTotals(USER_LIBRARY);
  assert.equal(totals.semanticDocuments, 2);
  assert.equal(totals.keywordDocuments, 1, "the tombstoned one is not live");
  assert.equal(totals.totalDocuments, 3);
});

test("an empty index totals zero rather than failing", async () => {
  const { store } = await freshStore();
  assert.deepEqual(await store.getIndexedDocumentTotals(USER_LIBRARY), {
    semanticDocuments: 0,
    keywordDocuments: 0,
    totalDocuments: 0,
  });
});

test("compatibility counts observe either persistent index and clear to zero", async () => {
  const { store, sqlite } = await freshStore();
  assert.deepEqual(await store.getPersistentIndexCounts(), {
    semanticVectors: 0,
    keywordDocuments: 0,
    keywordChunks: 0,
  });

  await store
    .getKeywordIndexStore()
    .writeItem(PAPER(USER_LIBRARY, "KEYWORD1"));
  let counts = await store.getPersistentIndexCounts();
  assert.equal(counts.semanticVectors, 0);
  assert.equal(counts.keywordDocuments, 1);
  assert.ok(counts.keywordChunks > 0);

  addVector(sqlite, USER_LIBRARY, "VECTOR01");
  counts = await store.getPersistentIndexCounts();
  assert.equal(counts.semanticVectors, 1);
  assert.equal(counts.keywordDocuments, 1);

  await store.clearAll();
  assert.deepEqual(await store.getPersistentIndexCounts(), {
    semanticVectors: 0,
    keywordDocuments: 0,
    keywordChunks: 0,
  });
});

// ---------------------------------------------------------------------------
// 2. The vector index's own figures are scoped to one library too.
// ---------------------------------------------------------------------------

test("getStats(libraryID) counts one library, getStats() the whole file", async () => {
  const { store, sqlite } = await freshStore();
  addVector(sqlite, USER_LIBRARY, "AAAA1111", 0, "en");
  addVector(sqlite, USER_LIBRARY, "AAAA1111", 1, "zh");
  addVector(sqlite, GROUP_LIBRARY, "GGGG1111", 0, "en");
  addVector(sqlite, GROUP_LIBRARY, "GGGG2222", 0, "en");

  const user = await store.getStats(USER_LIBRARY);
  assert.equal(user.totalVectors, 2);
  assert.equal(user.totalItems, 1);
  assert.equal(user.zhVectors, 1);
  assert.equal(user.enVectors, 1);

  const group = await store.getStats(GROUP_LIBRARY);
  assert.equal(group.totalVectors, 2);
  assert.equal(group.totalItems, 2);

  const everything = await store.getStats();
  assert.equal(everything.totalVectors, 4);
  assert.equal(everything.totalItems, 3);
});

test("body coverage is scoped as well", async () => {
  const { store, sqlite } = await freshStore();
  addVector(sqlite, USER_LIBRARY, "AAAA1111");
  addVector(sqlite, GROUP_LIBRARY, "GGGG1111");
  addVector(sqlite, GROUP_LIBRARY, "GGGG2222");

  const user = await store.getStats(USER_LIBRARY);
  assert.equal(user.bodyCoverage.withBody, 1);
  const group = await store.getStats(GROUP_LIBRARY);
  assert.equal(group.bodyCoverage.withBody, 2);
});

// ---------------------------------------------------------------------------
// 3. Postings are this library's live postings.
// ---------------------------------------------------------------------------

/** Rows a raw whole-table count would report — the old implementation. */
const allPostings = (sqlite) =>
  Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM kw_postings`).get().n);

test("a second library's postings are excluded", async () => {
  const { store, sqlite } = await freshStore();
  await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, "AAAA1111"));
  await store
    .getKeywordIndexStore()
    .writeItem(PAPER(GROUP_LIBRARY, "GGGG1111", ["Entirely different body."]));

  const user = await store.getKeywordIndexReport(USER_LIBRARY);
  const group = await store.getKeywordIndexReport(GROUP_LIBRARY);

  assert.ok(user.postingCount > 0);
  assert.ok(group.postingCount > 0);
  assert.equal(
    user.postingCount + group.postingCount,
    allPostings(sqlite),
    "every posting belongs to exactly one library, and none is lost",
  );
  // Reverse verification: the whole-table count this replaced would report the
  // same (larger) number for both libraries.
  assert.notEqual(user.postingCount, allPostings(sqlite));
});

test("deleting one item drops its postings from the count immediately", async () => {
  const { store, sqlite } = await freshStore();
  await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, "AAAA1111"));
  await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, "BBBB2222"));
  const before = (await store.getKeywordIndexReport(USER_LIBRARY)).postingCount;

  await store.removeKeywordIndex("AAAA1111", USER_LIBRARY);

  const after = (await store.getKeywordIndexReport(USER_LIBRARY)).postingCount;
  assert.ok(
    after < before,
    `postings must fall on deletion (${before} -> ${after})`,
  );
  assert.equal(
    allPostings(sqlite),
    before,
    "the rows are still on disk until compaction — the count is about live documents",
  );

  // Compaction reclaims them without changing the reported figure.
  await store.compactKeywordIndex();
  assert.equal(
    (await store.getKeywordIndexReport(USER_LIBRARY)).postingCount,
    after,
    "compaction changes the disk, not the answer",
  );
  assert.equal(allPostings(sqlite), after);
});

test("re-indexing an item does not double-count its superseded revision", async () => {
  const { store } = await freshStore();
  await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, "AAAA1111"));
  const first = (await store.getKeywordIndexReport(USER_LIBRARY)).postingCount;
  await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, "AAAA1111"));
  const second = (await store.getKeywordIndexReport(USER_LIBRARY)).postingCount;
  assert.equal(second, first, "same document, same postings");
});

test("clearing one library leaves the other library's count intact", async () => {
  const { store } = await freshStore();
  await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, "AAAA1111"));
  await store
    .getKeywordIndexStore()
    .writeItem(PAPER(GROUP_LIBRARY, "GGGG1111", ["Entirely different body."]));
  const groupBefore = (await store.getKeywordIndexReport(GROUP_LIBRARY))
    .postingCount;

  await store.clearKeywordIndex(USER_LIBRARY);

  assert.equal((await store.getKeywordIndexReport(USER_LIBRARY)).postingCount, 0);
  assert.equal(
    (await store.getKeywordIndexReport(GROUP_LIBRARY)).postingCount,
    groupBefore,
  );
});

test("the memoised count is never served across a mutation", async () => {
  // Every path that can change a posting also changes the kw_docs signature the
  // memo is keyed on. This walks all four of them in sequence and demands a
  // fresh answer each time.
  const { store } = await freshStore();
  const keyword = store.getKeywordIndexStore();
  const count = async () =>
    (await store.getKeywordIndexReport(USER_LIBRARY)).postingCount;

  assert.equal(await count(), 0);
  await keyword.writeItem(PAPER(USER_LIBRARY, "AAAA1111"));
  const afterWrite = await count();
  assert.ok(afterWrite > 0, "write");

  await keyword.writeItem(PAPER(USER_LIBRARY, "BBBB2222", ["Another body."]));
  const afterSecond = await count();
  assert.ok(afterSecond > afterWrite, "second write");

  await keyword.removeItem(USER_LIBRARY, "BBBB2222");
  assert.equal(await count(), afterWrite, "removal");

  await keyword.compact();
  assert.equal(await count(), afterWrite, "compaction");

  await keyword.clear(USER_LIBRARY);
  assert.equal(await count(), 0, "clear");
});

// ---------------------------------------------------------------------------
// 4. Statistics follow the real index lifecycle.
// ---------------------------------------------------------------------------

test("single-item deletion updates both indexes and their union", async () => {
  const { store, sqlite } = await freshStore();
  for (const key of ["AAAA1111", "BBBB2222"]) {
    addVector(sqlite, USER_LIBRARY, key);
    await store.getKeywordIndexStore().writeItem(PAPER(USER_LIBRARY, key));
  }
  const beforePostings = (await store.getKeywordIndexReport(USER_LIBRARY))
    .postingCount;

  await store.deleteItemVectors("AAAA1111", USER_LIBRARY);

  assert.deepEqual(await store.getIndexedDocumentTotals(USER_LIBRARY), {
    semanticDocuments: 1,
    keywordDocuments: 1,
    totalDocuments: 1,
  });
  assert.ok(
    (await store.getKeywordIndexReport(USER_LIBRARY)).postingCount <
      beforePostings,
  );
});

test("full-library rebuild reset clears only that library before repopulation", async () => {
  const { store, sqlite } = await freshStore();
  addVector(sqlite, USER_LIBRARY, "OLD11111");
  await store
    .getKeywordIndexStore()
    .writeItem(PAPER(USER_LIBRARY, "OLD11111"));
  addVector(sqlite, GROUP_LIBRARY, "KEEP1111");
  await store
    .getKeywordIndexStore()
    .writeItem(PAPER(GROUP_LIBRARY, "KEEP1111"));
  sqlite
    .prepare(
      `INSERT INTO index_builds (build_id, library_id, scope, status, created_at) VALUES (?, ?, 'full-library', 'indexing', ?)`,
    )
    .run("rebuild-user", USER_LIBRARY, Math.floor(Date.now() / 1000));

  await store.clearLibraryForBuild("rebuild-user", USER_LIBRARY);
  assert.deepEqual(await store.getIndexedDocumentTotals(USER_LIBRARY), {
    semanticDocuments: 0,
    keywordDocuments: 0,
    totalDocuments: 0,
  });
  assert.deepEqual(await store.getIndexedDocumentTotals(GROUP_LIBRARY), {
    semanticDocuments: 1,
    keywordDocuments: 1,
    totalDocuments: 1,
  });

  addVector(sqlite, USER_LIBRARY, "NEW11111");
  await store
    .getKeywordIndexStore()
    .writeItem(PAPER(USER_LIBRARY, "NEW11111"));
  assert.deepEqual(await store.getIndexedDocumentTotals(USER_LIBRARY), {
    semanticDocuments: 1,
    keywordDocuments: 1,
    totalDocuments: 1,
  });
  assert.equal(
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM kw_docs WHERE library_id = ? AND item_key = 'OLD11111'`,
      )
      .get(USER_LIBRARY).n,
    0,
    "the rebuilt library cannot retain its old keyword document",
  );
});

test("delete-all makes every reported index count zero", async () => {
  const { store, sqlite } = await freshStore();
  addVector(sqlite, USER_LIBRARY, "AAAA1111");
  await store
    .getKeywordIndexStore()
    .writeItem(PAPER(USER_LIBRARY, "AAAA1111"));
  addVector(sqlite, GROUP_LIBRARY, "GGGG1111");
  await store
    .getKeywordIndexStore()
    .writeItem(PAPER(GROUP_LIBRARY, "GGGG1111"));

  await store.clearAll();

  for (const libraryID of [USER_LIBRARY, GROUP_LIBRARY]) {
    assert.deepEqual(await store.getIndexedDocumentTotals(libraryID), {
      semanticDocuments: 0,
      keywordDocuments: 0,
      totalDocuments: 0,
    });
    assert.equal(
      (await store.getKeywordIndexReport(libraryID)).postingCount,
      0,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. Each index's share of the database file.
// ---------------------------------------------------------------------------

/** The same figure computed independently, straight from dbstat. */
function pagesOf(sqlite, tables) {
  const list = tables.map((table) => `'${table}'`).join(",");
  return Number(
    sqlite
      .prepare(
        `SELECT COALESCE(SUM(d.pgsize), 0) AS bytes FROM dbstat AS d JOIN sqlite_master AS m ON m.name = d.name WHERE m.tbl_name IN (${list})`,
      )
      .get().bytes,
  );
}

test("each index reports the pages its own tables occupy", async () => {
  const { store, sqlite } = await freshStore();
  for (let index = 0; index < 40; index += 1) {
    const key = `KEY${String(index).padStart(5, "0")}`;
    addVector(sqlite, USER_LIBRARY, key);
    await store.getKeywordIndexStore().writeItem(
      PAPER(USER_LIBRARY, key, [
        `Passage ${index} about columnar grain growth and creep resistance.`,
      ]),
    );
  }

  const storage = await store.getIndexStorageBreakdown();
  assert.equal(storage.measured, true);
  assert.ok(storage.semanticBytes > 0);
  assert.ok(storage.keywordBytes > 0);
  assert.equal(
    storage.semanticBytes,
    pagesOf(sqlite, [
      "embeddings",
      "vectors_f32",
      "index_status",
      "index_failures",
      "index_builds",
      "index_build_targets",
    ]),
  );
  assert.equal(
    storage.keywordBytes,
    pagesOf(sqlite, ["kw_postings", "kw_docs", "kw_terms"]),
  );
  // Neither index may be handed the whole file, which is what any "just show
  // the file size twice" shortcut would produce.
  const pageBytes =
    Number(sqlite.prepare(`PRAGMA page_count`).get().page_count) *
    Number(sqlite.prepare(`PRAGMA page_size`).get().page_size);
  assert.ok(storage.semanticBytes < pageBytes);
  assert.ok(storage.keywordBytes < pageBytes);
});

test("the split reconciles exactly with the database's own page count", async () => {
  const { store, sqlite } = await freshStore();
  for (let index = 0; index < 25; index += 1) {
    const key = `KEY${String(index).padStart(5, "0")}`;
    addVector(sqlite, USER_LIBRARY, key);
    await store
      .getKeywordIndexStore()
      .writeItem(PAPER(USER_LIBRARY, key, [`Passage ${index} of body text.`]));
  }
  // Free pages, so the freelist term is not trivially zero.
  await store.getKeywordIndexStore().clear(USER_LIBRARY);
  sqlite.exec(`DELETE FROM embeddings`);

  const storage = await store.getIndexStorageBreakdown();
  const pageSize = Number(sqlite.prepare(`PRAGMA page_size`).get().page_size);
  const pageCount = Number(sqlite.prepare(`PRAGMA page_count`).get().page_count);
  assert.equal(
    storage.semanticBytes +
      storage.keywordBytes +
      storage.bookkeepingBytes +
      storage.freeBytes,
    pageSize * pageCount,
    "every page is attributed exactly once",
  );
});

test("deleting an index's rows shrinks that index's figure, not the other's", async () => {
  const { store, sqlite } = await freshStore();
  for (let index = 0; index < 40; index += 1) {
    const key = `KEY${String(index).padStart(5, "0")}`;
    addVector(sqlite, USER_LIBRARY, key);
    await store.getKeywordIndexStore().writeItem(
      PAPER(USER_LIBRARY, key, [
        `Passage ${index} about columnar grain growth and creep resistance.`,
      ]),
    );
  }
  const before = await store.getIndexStorageBreakdown();

  await store.getKeywordIndexStore().clear(USER_LIBRARY);
  sqlite.exec(`VACUUM`);
  const after = await store.getIndexStorageBreakdown();

  assert.ok(
    after.keywordBytes < before.keywordBytes,
    `keyword pages must fall (${before.keywordBytes} -> ${after.keywordBytes})`,
  );
  assert.equal(
    after.semanticBytes,
    before.semanticBytes,
    "the vector index was not touched",
  );
});

test("a SQLite build without dbstat reports unknown instead of a substitute", async () => {
  const { store } = await freshStore({
    onQuery: (sql) => {
      if (/\bdbstat\b/iu.test(sql)) {
        throw new Error("no such table: dbstat");
      }
    },
  });

  const storage = await store.getIndexStorageBreakdown();
  assert.equal(storage.measured, false);
  assert.equal(storage.semanticBytes, undefined);
  assert.equal(storage.keywordBytes, undefined);
});

// ---------------------------------------------------------------------------

tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zotero-lit-synapse-index-stats-"));
let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${error?.message ?? error}`);
  }
}
for (const sqlite of opened) {
  try {
    sqlite.close();
  } catch {
    // Already closed.
  }
}
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  // Windows may still hold a handle; the temp directory is disposable.
}
console.log(
  failures === 0
    ? `\n${tests.length} index-statistics tests passed`
    : `\n${failures} of ${tests.length} index-statistics tests FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
