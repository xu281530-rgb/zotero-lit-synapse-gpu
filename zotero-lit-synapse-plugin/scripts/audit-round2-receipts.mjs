import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);
const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-receipt-review-"));
const fake = createZoteroFake({ rootDir });
fake.install();
fake.Zotero.Prefs = { get: () => undefined };
const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");

function adapt(sqlite) {
  let depth = 0;
  return {
    async queryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const statement = sqlite.prepare(sql);
      const values = params.map((x) => typeof x === "boolean" ? Number(x) : x);
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) return statement.all(...values);
      statement.run(...values);
      return [];
    },
    async valueQueryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const row = sqlite.prepare(sql).get(...params);
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(fn) {
      if (depth > 0) return fn();
      depth++;
      sqlite.exec("BEGIN");
      try { const result = await fn(); sqlite.exec("COMMIT"); return result; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      finally { depth--; }
    },
  };
}

const sqlite = new DatabaseSync(path.join(rootDir, "audit.sqlite"));
const db = adapt(sqlite);
const store = new WikiStore(db);
await store.initialize();
const sessions = await store.readingSessions();
const output = [];

// A real main commit saves a page, while one deliberately failed follow-up remains.
const unrelated = await sessions.startOrContinue({ libraryID: 1, itemKey: "UNRELATED", title: "Unrelated paper", totalChunks: 2, sourceVersion: "v1", mode: "qa" });
const service = new WikiService(store);
service.pumpEmbeddingQueue = async () => undefined;
service.prepareTokens.set("audit-prepared", { libraryID: 1, expiresAt: Date.now() + 60000, preparedPageTitles: new Set(["audit page"]) });
const originalSettle = service.settleLinkSignals.bind(service);
service.settleLinkSignals = async () => { throw new Error("Injected temporary link failure"); };
const first = await service.commit({ libraryID: 1, userInitiated: true, operationId: "audit-unrelated-state", prepareToken: "audit-prepared", actions: [{ action: "CREATE_PAGE", canonicalTitle: "Audit page" }] });
assert.equal(first.committed, true);
assert.equal(first.postprocessing.steps["link settlement"].state, "pending");
service.settleLinkSignals = originalSettle;
await sessions.startOrContinue({ libraryID: 1, itemKey: unrelated.itemKey, title: "Unrelated paper", totalChunks: 2, sourceVersion: "v2", mode: "qa" });
const restarted = new WikiService(new WikiStore(db));
restarted.pumpEmbeddingQueue = async () => undefined;
const resumed = await restarted.commit({ libraryID: 1, userInitiated: true, operationId: first.operationId, resume: true, actions: [] });
assert.equal(resumed.postprocessing.state, "pending");
assert.match(resumed.postprocessing.steps["link settlement"].error, /UNRELATED changed/);
output.push({ defect: "unrelated_reading_blocks_recovery", pageCreated: first.createdPages, resumedState: resumed.postprocessing.state, error: resumed.postprocessing.steps["link settlement"].error });

// Once A closes, a failed note update must still target A if the reader starts B.
const old = await sessions.startOrContinue({ libraryID: 2, itemKey: "OLDPAPER", title: "Old paper", totalChunks: 1, sourceVersion: "v1", mode: "fulltext" });
await db.queryAsync("UPDATE wiki_reading_sessions SET final_synthesis_at = 1, concepts_recorded_at = 1, wiki_review_at = 1 WHERE session_id = ?", [old.sessionId]);
await db.queryAsync("INSERT INTO wiki_reading_chunks (session_id, chunk_index, chunk_id, delivered_at) VALUES (?, 0, 22, 1)", [old.sessionId]);
const service2 = new WikiService(store);
service2.pumpEmbeddingQueue = async () => undefined;
let noteAttempts = 0;
service2.syncNoteStatus = async () => { noteAttempts++; return { updated: false, reason: "write_failed" }; };
const committed = await service2.commit({ libraryID: 2, userInitiated: true, operationId: "audit-old-note-status", readingSessionId: old.sessionId, actions: [{ action: "SKIP", reason: "All previously written evidence is already accounted for." }] });
assert.equal((await sessions.get(old.sessionId)).state, "committed");
assert.equal(committed.postprocessing.steps["reading session"].state, "pending");
await sessions.startOrContinue({ libraryID: 2, itemKey: "NEWPAPER", title: "New paper", totalChunks: 2, sourceVersion: "v1", mode: "fulltext" });
const restarted2 = new WikiService(new WikiStore(db));
restarted2.pumpEmbeddingQueue = async () => undefined;
restarted2.syncNoteStatus = async () => { noteAttempts++; return { updated: true }; };
const recovered = await restarted2.commit({ libraryID: 2, userInitiated: true, operationId: committed.operationId, resume: true, actions: [] });
assert.equal(recovered.postprocessing.state, "completed");
assert.equal(noteAttempts, 1);
assert.equal(recovered.readingSession.itemKey, "NEWPAPER");
output.push({ defect: "old_note_retry_marked_done_without_write", originalState: committed.postprocessing.state, resumedState: recovered.postprocessing.state, noteAttempts, returnedReadingItem: recovered.readingSession.itemKey, oldReadingItem: old.itemKey });

console.log(JSON.stringify({ environment: "Node SQLite + production WikiStore/WikiService, controlled failures, no production Zotero writes", output }, null, 2));
sqlite.close();
