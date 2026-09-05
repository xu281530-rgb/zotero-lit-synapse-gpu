import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);
const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");
const rootDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "synapse-receipt-regression-"),
);
const fake = createZoteroFake({ rootDir });
fake.install();
fake.Zotero.Prefs = { get: () => undefined };
const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { getVectorStore } = await import(
  "../src/modules/semantic/vectorStore.ts"
);
const revisions = new Map();
getVectorStore().getDocumentRevision = async (itemKey, libraryID) =>
  revisions.get(`${libraryID}:${itemKey}`) ?? "";

function adapt(sqlite) {
  let depth = 0;
  return {
    async queryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const statement = sqlite.prepare(sql);
      const values = params.map((x) =>
        typeof x === "boolean" ? Number(x) : x,
      );
      if (/^\s*(select|pragma|with)\b/iu.test(sql))
        return statement.all(...values);
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
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
  };
}

const sqlite = new DatabaseSync(path.join(rootDir, "regressions.sqlite"));
const db = adapt(sqlite);
const store = new WikiStore(db);
await store.initialize();
const sessions = await store.readingSessions();
const outcomes = [];
async function check(name, work) {
  try {
    await work();
    outcomes.push({ name, passed: true });
  } catch (error) {
    outcomes.push({ name, passed: false, error: String(error) });
  }
}
function createService() {
  const service = new WikiService(new WikiStore(db));
  service.pumpEmbeddingQueue = async () => undefined;
  return service;
}
async function start(libraryID, itemKey, mode = "qa", sourceVersion = "v1") {
  revisions.set(`${libraryID}:${itemKey}`, sourceVersion);
  return sessions.startOrContinue({
    libraryID,
    itemKey,
    title: itemKey,
    totalChunks: 1,
    sourceVersion,
    mode,
  });
}
async function makeReady(session) {
  await db.queryAsync(
    "UPDATE wiki_reading_sessions SET final_synthesis_at = 1, concepts_recorded_at = 1, wiki_review_at = 1 WHERE session_id = ?",
    [session.sessionId],
  );
  await db.queryAsync(
    "INSERT INTO wiki_reading_chunks (session_id, chunk_index, chunk_id, delivered_at, integrated_at) VALUES (?, 0, 22, 1, 1)",
    [session.sessionId],
  );
}

await check(
  "R05: unrelated reading cannot block recovery, including legacy receipts",
  async () => {
    const unrelated = await start(1, "UNRELATED");
    const service = createService();
    service.prepareTokens.set("prepared", {
      libraryID: 1,
      expiresAt: Date.now() + 60000,
      preparedPageTitles: new Set(["audit page"]),
    });
    service.settleLinkSignals = async () => {
      throw new Error("Injected temporary link failure");
    };
    const first = await service.commit({
      libraryID: 1,
      userInitiated: true,
      operationId: "test-unrelated-state",
      prepareToken: "prepared",
      actions: [{ action: "CREATE_PAGE", canonicalTitle: "Audit page" }],
    });
    assert.equal(first.committed, true);
    assert.equal(
      first.postprocessing.steps["link settlement"].state,
      "pending",
    );
    const receipt = await store.getCommitOperation(1, first.operationId);
    // Old installations saved every open session. Recovery must filter these too.
    receipt.payload.sessions = [
      {
        sessionId: unrelated.sessionId,
        itemKey: unrelated.itemKey,
        sourceVersion: "v1",
      },
    ];
    delete receipt.payload.dependencies;
    await db.queryAsync(
      "UPDATE wiki_commit_operations SET payload_json = ? WHERE library_id = ? AND operation_id = ?",
      [JSON.stringify(receipt.payload), 1, first.operationId],
    );
    await start(1, unrelated.itemKey, "qa", "v2");
    const restarted = createService();
    const resumed = await restarted.commit({
      libraryID: 1,
      userInitiated: true,
      operationId: first.operationId,
      resume: true,
      actions: [],
    });
    assert.equal(resumed.postprocessing.state, "completed");
    assert.equal(
      (await restarted.commitStatus(1, first.operationId)).status,
      "completed",
    );
    assert.equal(
      Number(
        await db.valueQueryAsync(
          "SELECT COUNT(*) FROM wiki_pages WHERE library_id = 1",
        ),
      ),
      1,
    );
    assert.equal((await sessions.get(unrelated.sessionId)).sourceVersion, "v2");
  },
);

await check(
  "R04: retry the original note while another fulltext paper is open",
  async () => {
    const old = await start(2, "OLDPAPER", "fulltext");
    await sessions.setNoteKey(old.sessionId, "OLDNOTE");
    await makeReady(old);
    const service = createService();
    const targets = [];
    service.syncNoteStatus = async (session) => {
      targets.push({ itemKey: session.itemKey, noteKey: session.noteKey });
      return { updated: false, reason: "write_failed" };
    };
    const first = await service.commit({
      libraryID: 2,
      userInitiated: true,
      operationId: "test-old-note-status",
      readingSessionId: old.sessionId,
      actions: [
        {
          action: "SKIP",
          reason: "All previously written evidence is already accounted for.",
        },
      ],
    });
    assert.equal((await sessions.get(old.sessionId)).state, "committed");
    assert.equal(
      first.postprocessing.steps["reading session"].state,
      "pending",
    );
    const newer = await start(2, "NEWPAPER", "fulltext");
    const restarted = createService();
    restarted.syncNoteStatus = async (session) => {
      targets.push({ itemKey: session.itemKey, noteKey: session.noteKey });
      return {
        updated: true,
        attachmentKey: session.noteKey,
        status: "completed",
      };
    };
    const resumed = await restarted.commit({
      libraryID: 2,
      userInitiated: true,
      operationId: first.operationId,
      resume: true,
      actions: [],
    });
    assert.equal(resumed.postprocessing.state, "completed");
    assert.deepEqual(targets, [
      { itemKey: "OLDPAPER", noteKey: "OLDNOTE" },
      { itemKey: "OLDPAPER", noteKey: "OLDNOTE" },
    ]);
    assert.equal(resumed.readingSession.itemKey, "OLDPAPER");
    assert.equal(
      (await restarted.commitStatus(2, first.operationId)).response
        .readingSession.itemKey,
      "OLDPAPER",
    );
    assert.equal((await sessions.getOpen(2)).sessionId, newer.sessionId);
    assert.equal((await sessions.get(newer.sessionId)).state, "reading");
  },
);

await check(
  "R05: relevant version conflict is durable and independent stages finish",
  async () => {
    const paper = await start(3, "RELEVANT", "fulltext");
    const service = createService();
    service.settleReadingSession = async () => {
      throw new Error("Injected session failure");
    };
    service.settleLinkSignals = async () => {
      throw new Error("Injected link failure");
    };
    const first = await service.commit({
      libraryID: 3,
      userInitiated: true,
      operationId: "test-relevant-conflict",
      readingSessionId: paper.sessionId,
      actions: [
        {
          action: "SKIP",
          reason: "Previously written evidence is already accounted for.",
        },
      ],
    });
    assert.equal(
      first.postprocessing.steps["reading session"].state,
      "pending",
    );
    await start(3, paper.itemKey, "fulltext", "v2");
    await db.queryAsync(
      "INSERT INTO wiki_reading_chunks (session_id, chunk_index, chunk_id, delivered_at, owes_wiki) VALUES (?, 0, 23, 1, 1)",
      [paper.sessionId],
    );
    const restarted = createService();
    const resumed = await restarted.commit({
      libraryID: 3,
      userInitiated: true,
      operationId: first.operationId,
      resume: true,
      actions: [],
    });
    assert.equal(
      resumed.postprocessing.steps["link settlement"].state,
      "completed",
    );
    assert.equal(
      resumed.postprocessing.steps["reading session"].state,
      "superseded",
    );
    assert.equal(resumed.postprocessing.state, "needs_review");
    const status = await createService().commitStatus(3, first.operationId);
    assert.equal(status.status, "postprocessing_needs_review");
    assert.match(status.nextStep, /review/i);
    assert.deepEqual(
      (await sessions.pendingWikiChunks(paper.sessionId)).map(
        (chunk) => chunk.chunkId,
      ),
      [23],
    );
    const again = await createService().commit({
      libraryID: 3,
      userInitiated: true,
      operationId: first.operationId,
      resume: true,
      actions: [],
    });
    assert.equal(again.postprocessing.state, "needs_review");
    assert.equal((await sessions.get(paper.sessionId)).state, "reading");
  },
);

await check(
  "R05: old question settlement never clears new-version debt",
  async () => {
    const paper = await start(4, "QUESTION");
    const owe = () =>
      db.queryAsync(
        "INSERT INTO wiki_reading_chunks (session_id, chunk_index, chunk_id, delivered_at, owes_wiki) VALUES (?, 0, 22, 1, 1)",
        [paper.sessionId],
      );
    await owe();
    const service = createService();
    service.settleQuestionReading = async () => {
      throw new Error("Injected question settlement failure");
    };
    const first = await service.commit({
      libraryID: 4,
      userInitiated: true,
      operationId: "test-question-conflict",
      actions: [
        {
          action: "SKIP",
          itemKey: paper.itemKey,
          chunkIds: [22],
          reason:
            "The quoted passage repeats the threshold already retained in the existing thermal-gradient Claim without adding a further condition.",
        },
      ],
    });
    assert.equal(
      first.postprocessing.steps["question reading settlement"].state,
      "pending",
    );
    await start(4, paper.itemKey, "qa", "v2");
    await owe();
    const resumed = await createService().commit({
      libraryID: 4,
      userInitiated: true,
      operationId: first.operationId,
      resume: true,
      actions: [],
    });
    assert.equal(
      resumed.postprocessing.steps["question reading settlement"].state,
      "superseded",
    );
    assert.deepEqual(
      (await sessions.pendingWikiChunks(paper.sessionId)).map(
        (entry) => entry.chunkId,
      ),
      [22],
    );
    assert.equal((await sessions.get(paper.sessionId)).state, "reading");
  },
);

console.log(JSON.stringify({ outcomes }, null, 2));
sqlite.close();
if (outcomes.some((entry) => !entry.passed)) process.exitCode = 1;
