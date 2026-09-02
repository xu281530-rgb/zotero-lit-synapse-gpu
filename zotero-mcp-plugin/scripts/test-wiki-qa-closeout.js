/* eslint-env node */

/**
 * Ending a question-driven reading: the state, and the migration that adds it.
 *
 * Six `qa` sessions in a real library sat in `prepared`/`reading` forever.
 * They owed the Wiki nothing - every chunk they had read had already been
 * settled by an earlier full-text pass - so `listPendingWiki` never returned
 * them, the "reading that has still not reached the Wiki" warning never fired
 * once in the library's whole history, and the two papers that produced no
 * Evidence left no trace anywhere that they had been consulted at all.
 *
 * They stayed open because neither existing ending fitted. `committed` means
 * the whole paper was delivered, which a question never does. `skipped` means
 * the reading was abandoned, which is a false report of a reading that was
 * used. So `answered` was added - and adding a value to a CHECK constraint in
 * SQLite means rebuilding the table, over a table with a cascading child.
 *
 * The blocks:
 *
 *   1. The rebuild keeps every session row.
 *   2. The rebuild keeps every CHUNK row - the cascade is the danger.
 *   3. After it, `answered` is a value the table accepts.
 *   4. A full-text session is never closed this way.
 *   5. `answered` reading counts as settled for a later session of the same
 *      paper, which is the memory these sessions exist to keep.
 *   6. `answered` cannot be asserted from outside.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-qa-closeout-"));
const fake = createZoteroFake({ rootDir: tempDir });
fake.install();

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { WIKI_SCHEMA_VERSION } = await import(
  "../src/modules/wiki/wikiSchema.ts"
);

function adapt(sqlite) {
  let depth = 0;
  const normalize = (params) =>
    params.map((value) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
  return {
    async queryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const statement = sqlite.prepare(sql);
      const values = normalize(params);
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) {
        return statement.all(...values);
      }
      statement.run(...values);
      return [];
    },
    async valueQueryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const row = sqlite.prepare(sql).get(...normalize(params));
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

const results = [];
async function block(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.stack ?? error.message}`);
  }
}

console.log("wiki qa closeout");

// --- A database written by 2.7.7, with reading already in it ----------------

const dbPath = path.join(tempDir, "zotero-mcp-wiki.sqlite");
const sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");

// The shape these tables had before any of the later columns were added, so
// the upgrade path this exercises is the real one: the ALTER loop fills the
// columns in, and only then does the CHECK rebuild run.
sqlite.exec(`
  CREATE TABLE wiki_reading_sessions (
    session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL,
    item_key TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    total_chunks INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reading','prepared','committed','skipped','failed')),
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    note TEXT NOT NULL DEFAULT ''
  )
`);
sqlite.exec(`
  CREATE TABLE wiki_reading_chunks (
    session_id INTEGER NOT NULL REFERENCES wiki_reading_sessions(session_id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_id INTEGER NOT NULL,
    delivered_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, chunk_index)
  )
`);

// Only one of them is open, because that is all a pre-2.5.0 database could
// have: `mode` did not exist yet, so every session was a full-text read and
// the library's one reading slot allowed exactly one at a time.
const legacySessions = [
  [1, "BRF2ZXMX", "Columnar superalloy DRX", 55, "prepared"],
  [1, "J79AAQHR", "Sub-solvus annealing", 67, "committed"],
  [1, "GB2TEG5M", "A paper read end to end", 94, "committed"],
];
for (const [libraryID, itemKey, title, totalChunks, state] of legacySessions) {
  sqlite
    .prepare(
      `INSERT INTO wiki_reading_sessions
         (library_id, item_key, title, total_chunks, state, started_at, updated_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(libraryID, itemKey, title, totalChunks, state, 1000, 2000, "");
}
// One chunk ledger row per session, plus a fat one: DROP TABLE on the parent
// with foreign keys still enabled would cascade and take all of these.
let ledgerRows = 0;
for (let sessionId = 1; sessionId <= 3; sessionId += 1) {
  for (let index = 0; index < 12; index += 1) {
    sqlite
      .prepare(
        `INSERT INTO wiki_reading_chunks
           (session_id, chunk_index, chunk_id, delivered_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, index, 1000 + index, 3000);
    ledgerRows += 1;
  }
}

const store = new WikiStore(adapt(sqlite));
await store.initialize();
const sessions = await store.readingSessions();

// --- 1 to 3. The rebuild -----------------------------------------------------

await block("the rebuild keeps every session row", async () => {
  const rows = sqlite
    .prepare("SELECT * FROM wiki_reading_sessions ORDER BY session_id")
    .all();
  assert.equal(rows.length, legacySessions.length);
  assert.deepEqual(
    rows.map((row) => [row.item_key, row.state, Number(row.total_chunks)]),
    legacySessions.map(([, itemKey, , totalChunks, state]) => [
      itemKey,
      state,
      totalChunks,
    ]),
  );
  assert.equal(
    Number(
      sqlite
        .prepare(
          "SELECT seq FROM sqlite_sequence WHERE name = 'wiki_reading_sessions'",
        )
        .get().seq,
    ),
    3,
    "the id counter survives, so a new session cannot reuse a closed one's id",
  );
  assert.equal(
    Number(sqlite.prepare("PRAGMA user_version").get().user_version),
    WIKI_SCHEMA_VERSION,
  );
});

await block("the rebuild keeps every chunk ledger row", async () => {
  assert.equal(
    Number(
      sqlite.prepare("SELECT COUNT(*) AS n FROM wiki_reading_chunks").get().n,
    ),
    ledgerRows,
    "dropping the parent table with foreign keys on would cascade all of these away",
  );
  // And the child still points at the rebuilt parent rather than a ghost.
  assert.equal(
    sqlite.prepare("PRAGMA foreign_key_check").all().length,
    0,
    "no dangling references after the rename",
  );
  assert.equal(
    Number(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys),
    1,
    "foreign keys are back on after the rebuild",
  );
});

await block("answered is a state the table accepts", async () => {
  await sessions.close(1, "answered", "closed by a commit");
  const row = sqlite
    .prepare("SELECT state, closed_at FROM wiki_reading_sessions WHERE session_id = 1")
    .get();
  assert.equal(row.state, "answered");
  assert.ok(Number(row.closed_at) > 0);
  assert.throws(
    () =>
      sqlite
        .prepare(
          "UPDATE wiki_reading_sessions SET state = 'nonsense' WHERE session_id = 1",
        )
        .run(),
    /CHECK/iu,
    "the rebuilt constraint still refuses everything else",
  );
});

// --- 4. Scope of the automatic close ----------------------------------------

await block("a full-text session is never closed this way", async () => {
  // Session 2 owes nothing (its chunks predate `owes_wiki`, so they default to
  // 0) and is open, which is the whole condition - except that it is not a
  // question-driven session.
  sqlite
    .prepare(
      "UPDATE wiki_reading_sessions SET mode = 'fulltext', state = 'reading' WHERE session_id = 2",
    )
    .run();
  let settleable = await sessions.listSettledQuestionSessions(1);
  assert.deepEqual(
    settleable.map((session) => session.sessionId),
    [],
    "a full-text read is finished by finishing the paper, never by a commit",
  );

  sqlite
    .prepare("UPDATE wiki_reading_sessions SET mode = 'qa' WHERE session_id = 2")
    .run();
  settleable = await sessions.listSettledQuestionSessions(1);
  assert.deepEqual(
    settleable.map((session) => session.sessionId),
    [2],
    "the same session in question-driven mode is settleable",
  );

  // A chunk it still owes takes it straight back out.
  sqlite
    .prepare(
      "UPDATE wiki_reading_chunks SET owes_wiki = 1, settled_at = NULL WHERE session_id = 2 AND chunk_index = 0",
    )
    .run();
  settleable = await sessions.listSettledQuestionSessions(1);
  assert.deepEqual(
    settleable.map((session) => session.sessionId),
    [],
    "a session in debt is reported by listPendingWiki, not closed",
  );
});

// --- 5. The memory an ended session still carries ---------------------------

await block("answered reading is not charged again by a later session", async () => {
  // Two sessions for one paper, the earlier one ended as `answered`. This is
  // the cross-session rule the close must not break: chunk 7 of ANSWPAPR was
  // read and accounted for, so reading it again owes nothing.
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO wiki_reading_sessions
         (library_id, item_key, title, total_chunks, state, started_at, updated_at, mode, closed_at)
       VALUES (1, 'ANSWPAPR', 'Answered earlier', 30, 'answered', ?, ?, 'qa', ?)`,
    )
    .run(now, now, now);
  const earlier = Number(sqlite.prepare("SELECT last_insert_rowid() AS id").get().id);
  sqlite
    .prepare(
      `INSERT INTO wiki_reading_chunks
         (session_id, chunk_index, chunk_id, delivered_at, owes_wiki)
       VALUES (?, 7, 907, ?, 0)`,
    )
    .run(earlier, now);
  sqlite
    .prepare(
      `INSERT INTO wiki_reading_sessions
         (library_id, item_key, title, total_chunks, state, started_at, updated_at, mode)
       VALUES (1, 'ANSWPAPR', 'Answered earlier', 30, 'reading', ?, ?, 'qa')`,
    )
    .run(now, now);
  const later = Number(sqlite.prepare("SELECT last_insert_rowid() AS id").get().id);

  const documentChunks = Array.from({ length: 30 }, (_, index) => ({
    chunkId: 900 + index,
  }));
  const booked = await sessions.recordReadChunkIds(later, [907, 908], documentChunks);
  assert.deepEqual(booked.newIndexes, [7, 8]);
  const owed = sqlite
    .prepare(
      "SELECT chunk_index, owes_wiki FROM wiki_reading_chunks WHERE session_id = ? ORDER BY chunk_index",
    )
    .all(later);
  assert.deepEqual(
    owed.map((row) => [Number(row.chunk_index), Number(row.owes_wiki)]),
    [
      [7, 0],
      [8, 1],
    ],
    "a passage an answered session already accounted for is read again for free; a new one is not",
  );
});

// --- 6. Nobody may assert it --------------------------------------------------

await block("answered cannot be asserted from outside", async () => {
  const service = new WikiService(store);
  await assert.rejects(
    () => service.finishReading({ libraryID: 1, outcome: "answered" }),
    /only accepts "skipped" or "failed"/iu,
    'a caller declaring "answered" could close a session that still owed the Wiki',
  );
});

const failed = results.filter(([ok]) => !ok);
if (failed.length) {
  console.error(`\nwiki qa closeout: ${failed.length} block(s) failed`);
  process.exitCode = 1;
} else {
  console.log("wiki qa closeout: all blocks passed");
}
