import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);
const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-round3-notes-"));
const fake = createZoteroFake({ rootDir });
fake.install();
fake.Zotero.Prefs = { get: () => undefined };
const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const {
  WikiReadingNoteStore,
  parseReadingNote,
  parseAppendOnlyReadingNote,
  appendReadingRecord,
  appendMacroSummary,
} = await import("../src/modules/wiki/wikiReadingNote.ts");
const { getVectorStore } = await import(
  "../src/modules/semantic/vectorStore.ts"
);
const { getEmbeddingService } = await import(
  "../src/modules/semantic/embeddingService.ts"
);
const chunks = new Map();
const vectors = getVectorStore();
vectors.initialize = async () => undefined;
vectors.getDocumentRevision = async () => "stable-round3";
vectors.getIndexStatus = async () => ({
  sourceKind: "body",
  contentHash: "stable",
});
vectors.getChunksForItem = async (key) => chunks.get(key) ?? [];
const embed = getEmbeddingService();
let controlledEmbeddingCalls = 0;
embed.embed = async () => {
  controlledEmbeddingCalls++;
  return {
    embedding: new Float32Array([1, 0]),
    identity: {
      model: "round3",
      apiBase: "controlled",
      provider: "openai",
      dimensions: 2,
    },
  };
};

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
const sqlite = new DatabaseSync(path.join(rootDir, "notes.sqlite"));
const db = adapt(sqlite);
const store = new WikiStore(db);
await store.initialize();
const sessions = await store.readingSessions();
const notes = new WikiReadingNoteStore();
function service() {
  const result = new WikiService(store);
  result.pumpEmbeddingQueue = async () => undefined;
  result.links.onPaperRead = async () => undefined;
  return result;
}
function paper(key, count = 2) {
  chunks.set(
    key,
    Array.from({ length: count }, (_, chunkId) => ({
      chunkId,
      text: "The imposed thermal gradient controls the orientation of the solidified grain array.",
      language: "en",
    })),
  );
  return fake.createPaper({ key, title: "Reading note lifecycle " + key });
}
const record =
  "The thermal gradient controls the orientation of the grain array (chunk 0).";
const record1 =
  "The solidified array follows the imposed gradient direction (chunk 1).";
const summary =
  "Grain orientation responds to the thermal conditions imposed during solidification (chunk 0).";
const body = (text = record, chunkId = 0) =>
  appendReadingRecord("", { chunkIds: [chunkId], content: text });
const outcomes = [];
async function audit(name, run) {
  try {
    outcomes.push({ name, confirmed: true, ...(await run()) });
  } catch (error) {
    outcomes.push({
      name,
      confirmed: false,
      error: String(error),
      stack: error.stack,
    });
    process.exitCode = 1;
  }
}

await audit(
  "duplicate record suppression erases a concluded note",
  async () => {
    const item = paper("NOTESKIP");
    const original = appendMacroSummary(body(), summary);
    const attachment = await notes.ensureAttachment(item, original);
    const result = await service().updateReadingNote({
      libraryID: 1,
      itemKey: item.key,
      readChunkIds: [0],
      readingRecord: record,
    });
    const after = parseReadingNote(await notes.read(attachment));
    assert.ok(result.readingNote.discarded);
    assert.equal(after.body, "");
    return {
      itemKey: item.key,
      returnedDiscarded: result.readingNote.discarded,
      beforeBodyChars: original.length,
      afterBodyChars: after.body.length,
      statusAfter: after.metadata.status,
      oldSummaryLost: !String(await notes.read(attachment)).includes(summary),
    };
  },
);

await audit(
  "refreshing a routed older episode overwrites the newest episode",
  async () => {
    const item = paper("NOTEROUT");
    const older = await notes.ensureAttachment(item, body());
    const originalLatest = appendMacroSummary(
      body(
        "A separate interpretation is recorded in the later episode (chunk 0).",
      ),
      summary,
    );
    const latest = await notes.createNextAttachment(item, originalLatest);
    const result = await service().updateReadingNote({
      libraryID: 1,
      itemKey: item.key,
      readChunkIds: [1],
      readingRecord: record1,
    });
    const afterOlder = parseReadingNote(await notes.read(older)).body;
    const afterLatest = parseReadingNote(await notes.read(latest)).body;
    assert.equal(result.readingNote.attachmentKey, older.key);
    assert.equal(afterLatest, afterOlder);
    assert.ok(!afterLatest.includes("A separate interpretation"));
    const session = await sessions.openForItem(1, item.key);
    return {
      requestedTarget: older.key,
      returnedTarget: result.readingNote.attachmentKey,
      finalSessionTarget: session.noteKey,
      latestAttachment: latest.key,
      latestWasReplacedWithOlderEpisode: true,
      latestSummaryLost: !afterLatest.includes(summary),
    };
  },
);

await audit(
  "saved macro summary cannot recover after its ledger write fails",
  async () => {
    const item = paper("NOTEFINA", 1);
    const attachment = await notes.ensureAttachment(item, body());
    const session = await sessions.startOrContinue({
      libraryID: 1,
      itemKey: item.key,
      title: item.getField("title"),
      totalChunks: 1,
      sourceVersion: "stable-round3",
      mode: "qa",
    });
    await sessions.setNoteKey(session.sessionId, attachment.key);
    await sessions.setExpert(session.sessionId, {
      persona:
        "A materials scientist studying directional solidification and grain orientation.",
      focus: ["grain array", "thermal gradient"],
      openScopeMandate: "all content",
      createdAt: Date.now(),
    });
    await db.queryAsync(
      "INSERT INTO wiki_reading_chunks (session_id, chunk_index, chunk_id, delivered_at, integrated_at) VALUES (?, 0, 0, 1, 1)",
      [session.sessionId],
    );
    const originalIntegration = sessions.recordIntegration.bind(sessions);
    sessions.recordIntegration = async () => {
      throw new Error("Injected database failure after file write");
    };
    const options = {
      libraryID: 1,
      itemKey: item.key,
      finalSynthesis: true,
      macroSummary: summary,
    };
    let firstError;
    try {
      await service().updateReadingNote(options);
    } catch (error) {
      firstError = String(error);
    }
    sessions.recordIntegration = originalIntegration;
    let retryError;
    try {
      await service().updateReadingNote(options);
    } catch (error) {
      retryError = String(error);
    }
    const after = parseAppendOnlyReadingNote(
      parseReadingNote(await notes.read(attachment)).body,
    );
    assert.match(firstError, /Injected database failure/);
    assert.match(retryError, /already has a macro summary/);
    assert.ok(after.macroSummary);
    assert.equal(
      (await sessions.get(session.sessionId)).finalSynthesisAt,
      null,
    );
    return {
      firstError,
      retryError,
      summaryPersisted: true,
      ledgerFinalSynthesisAt: null,
    };
  },
);

await audit(
  "concurrent successful note appends can lose one reading record",
  async () => {
    const item = paper("NOTECONC", 3);
    const attachment = await notes.ensureAttachment(item, body());
    const session = await sessions.startOrContinue({
      libraryID: 1,
      itemKey: item.key,
      title: item.getField("title"),
      totalChunks: 3,
      sourceVersion: "stable-round3",
      mode: "qa",
    });
    await sessions.setNoteKey(session.sessionId, attachment.key);
    await db.queryAsync(
      "INSERT INTO wiki_reading_chunks (session_id, chunk_index, chunk_id, delivered_at, integrated_at) VALUES (?, 0, 0, 1, 1)",
      [session.sessionId],
    );
    const target = service();
    const write = target.notes.write.bind(target.notes);
    let waiting = 0;
    let release;
    const bothReady = new Promise((resolve) => {
      release = resolve;
    });
    target.notes.write = async (...args) => {
      waiting++;
      if (waiting <= 2) {
        if (waiting === 2) release();
        await bothReady;
      }
      return write(...args);
    };
    const record2 =
      "The imposed thermal direction aligns the observed grain array (chunk 2).";
    const responses = await Promise.all([
      target.updateReadingNote({
        libraryID: 1,
        itemKey: item.key,
        readChunkIds: [1],
        readingRecord: record1,
      }),
      target.updateReadingNote({
        libraryID: 1,
        itemKey: item.key,
        readChunkIds: [2],
        readingRecord: record2,
      }),
    ]);
    const finalBody = parseReadingNote(await notes.read(attachment)).body;
    const parsed = parseAppendOnlyReadingNote(finalBody);
    const coverage = await sessions.coverage(session.sessionId);
    assert.ok(responses.every((result) => result.integrated));
    assert.equal(coverage.deliveredChunks, 3);
    assert.equal(parsed.records.length, 2);
    assert.ok(!finalBody.includes(record1) || !finalBody.includes(record2));
    return {
      bothCallsReportedIntegrated: true,
      ledgerDeliveredChunks: coverage.deliveredChunks,
      persistedRecordCount: parsed.records.length,
      expectedRecordCount: 3,
      firstNewRecordRetained: finalBody.includes(record1),
      secondNewRecordRetained: finalBody.includes(record2),
    };
  },
);

await audit(
  "expert reset treats a failed note read as an empty existing note",
  async () => {
    const item = paper("NOTEEXPE");
    const original = body();
    const attachment = await notes.ensureAttachment(item, original);
    const session = await sessions.startOrContinue({
      libraryID: 1,
      itemKey: item.key,
      title: item.getField("title"),
      totalChunks: 2,
      sourceVersion: "stable-round3",
      mode: "qa",
    });
    await sessions.setNoteKey(session.sessionId, attachment.key);
    await sessions.setExpert(session.sessionId, {
      persona: "A temporary expert",
      focus: ["thermal gradient"],
      createdAt: Date.now(),
      provisional: true,
    });
    const target = service();
    const read = target.notes.read.bind(target.notes);
    let failedRead = false;
    target.notes.read = async (...args) => {
      if (!failedRead) {
        failedRead = true;
        return null;
      }
      return read(...args);
    };
    const result = await target.setReadingExpert({
      libraryID: 1,
      itemKey: item.key,
      persona:
        "A materials scientist who studies thermal gradients and the orientation of directionally solidified grains.",
      focus: ["thermal gradient", "grain orientation"],
    });
    const after = parseReadingNote(await notes.read(attachment));
    assert.ok(result.readingNote);
    assert.equal(after.body, "");
    return {
      returnedSuccess: true,
      beforeBodyChars: original.length,
      afterBodyChars: after.body.length,
      injectedReadFailureCount: 1,
    };
  },
);

await audit(
  "finishReading cannot retry a failed terminal note status update",
  async () => {
    const item = paper("NOTECLOS");
    const session = await sessions.startOrContinue({
      libraryID: 1,
      itemKey: item.key,
      title: item.getField("title"),
      totalChunks: 2,
      sourceVersion: "stable-round3",
      mode: "qa",
    });
    const target = service();
    const written = await target.writeNote(item, session, body(), "reading");
    const attachment = await notes.getByKey(1, written.attachmentKey);
    target.notes.write = async () => {
      throw new Error("Injected terminal note write failure");
    };
    const options = {
      libraryID: 1,
      itemKey: item.key,
      outcome: "skipped",
      note: "The relevant reading is already covered by the existing Wiki.",
    };
    const first = await target.finishReading(options);
    const retry = await service().finishReading(options);
    const file = parseReadingNote(await notes.read(attachment));
    assert.equal(first.closed, true);
    assert.equal(first.noteStatusWrite.reason, "write_failed");
    assert.equal(retry.closed, false);
    assert.equal(file.metadata.status, "reading");
    return {
      firstClosed: first.closed,
      firstNoteStatusWrite: first.noteStatusWrite,
      retry,
      actualSessionState: (await sessions.get(session.sessionId)).state,
      diskNoteStatus: file.metadata.status,
    };
  },
);

const results = {
  environment:
    "Production note/reading modules, isolated SQLite and files, controlled index/embedding/failure dependencies; no production Zotero writes or external APIs",
  rootDir,
  controlledEmbeddingCalls,
  outcomes,
};
const resultPath = new URL(
  "../.scaffold/audit-round3-notes-results.json",
  import.meta.url,
);
fs.mkdirSync(new URL("../.scaffold/", import.meta.url), { recursive: true });
fs.writeFileSync(resultPath, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
sqlite.close();
