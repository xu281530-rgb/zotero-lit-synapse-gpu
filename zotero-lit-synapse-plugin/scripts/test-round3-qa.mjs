/* eslint-env node */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);
const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-round3-qa-"));
const fake = createZoteroFake({ rootDir });
fake.install();
const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { getVectorStore } = await import("../src/modules/semantic/vectorStore.ts");
const { getEmbeddingService } = await import("../src/modules/semantic/embeddingService.ts");
const { parseReadingNote, parseAppendOnlyReadingNote } = await import("../src/modules/wiki/wikiReadingNote.ts");

const chunks = [
  { chunkId: 100, text: "The experimental procedure uses a directional furnace with controlled thermal gradients. The furnace requires a protective atmosphere to prevent oxidation.", language: "en" },
  { chunkId: 101, text: "The authors report a competing surface instability that reverses the interpretation of the stable interface.", language: "en" },
  { chunkId: 102, text: "The analysis excludes transient heating and does not establish applicability during rapid cooling.", language: "en" },
];
for (const key of ["MISSCOVR", "REREADQA", "RETRYSKP", "EMPTYQA1", "FULLQA01"]) fake.createPaper({ key });
const vectorStore = getVectorStore();
vectorStore.initialize = async () => {};
vectorStore.getDocumentRevision = async () => "round3-stable-source";
vectorStore.getChunksForItem = async (key) => key === "EMPTYQA1"
  ? chunks.map((chunk, index) => index === 1 ? { ...chunk, text: "The sample fractures at 120 MPa." } : chunk) : chunks;
vectorStore.getIndexStatus = async () => ({ sourceKind: "body", contentHash: "round3-stable-source" });
vectorStore.getCommittedResetGeneration = async () => "round3-reset";
const embeddings = getEmbeddingService();
embeddings.getConfig = () => ({ model: "round3-offline" });
embeddings.embed = async () => ({ embedding: new Float32Array([1, 0]), identity: { model: "round3-offline", apiBase: "http://offline.invalid", provider: "openai", dimensions: 2 } });
const sqlite = new DatabaseSync(path.join(rootDir, "wiki.sqlite"));
sqlite.exec("PRAGMA foreign_keys = ON");
let depth = 0;
const db = {
  async queryAsync(rawSql, rawParams = []) {
    const [sql, params] = parseQueryAndParams(rawSql, rawParams);
    const statement = sqlite.prepare(sql);
    const values = params.map(v => typeof v === "boolean" ? Number(v) : v);
    if (/^\s*(select|pragma|with)\b/iu.test(sql)) return statement.all(...values);
    statement.run(...values);
    return [];
  },
  async valueQueryAsync(sql, params = []) {
    const rows = await this.queryAsync(sql, params);
    return rows[0] ? Object.values(rows[0])[0] : undefined;
  },
  async executeTransaction(fn) {
    if (depth) return fn();
    depth++;
    sqlite.exec("BEGIN");
    try { const result = await fn(); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    finally { depth--; }
  },
};
const store = new WikiStore(db);
await store.initialize();
const service = new WikiService(store);
const sessions = await store.readingSessions();
const record = "The experimental procedure uses a directional furnace with controlled thermal gradients (chunk 0).";
const reread = "The furnace requires a protective atmosphere to prevent oxidation (chunk 0).";
async function read(itemKey, readChunkIds, readingRecord = record) {
  return service.updateReadingNote({ libraryID: 1, itemKey, readChunkIds, readingRecord, domain: "physical metallurgy", expertRole: "directional solidification specialist" });
}
async function note(itemKey) {
  const s = await sessions.openForItem(1, itemKey);
  const attachment = await fake.Zotero.Items.getByLibraryAndKeyAsync(1, s.noteKey);
  return parseAppendOnlyReadingNote(parseReadingNote(fs.readFileSync(attachment.getFilePath(), "utf8")).body);
}
const results = [];

await assert.rejects(read("MISSCOVR", [100, 101, 102]), /未被交代/);
assert.equal((await sessions.coverage((await sessions.openForItem(1, "MISSCOVR")).sessionId)).deliveredChunks, 0);
results.push({ passed: "Q01 missing chunks rejected before recording progress" });
await assert.rejects(service.updateReadingNote({ libraryID: 1, itemKey: "EMPTYQA1", readChunkIds: [100, 101, 102], unchanged: true, unchangedReason: "already known" }), /120/);
await assert.rejects(read("EMPTYQA1", [101], "The sample fractures during loading (chunk 1)."), /120/);
results.push({ passed: "Q01 unchanged and normal records cannot omit new measurements" });

await read("REREADQA", [100]);
const firstCommit = await service.commit({ libraryID: 1, userInitiated: true, operationId: "round3-initial-settlement", actions: [{ action: "SKIP", itemKey: "REREADQA", chunkIds: [100], reason: "The furnace description states the laboratory procedure and does not establish an independent mechanism or finding for the Wiki." }] });
const closed = await sessions.openForItem(1, "REREADQA");
assert.equal(closed.state, "answered");
const secondRead = await read("REREADQA", [100], reread);
const secondNote = await note("REREADQA");
assert.equal(secondNote.records.length, 2);
assert.equal(secondRead.wikiDebt.count, 1);
assert.match(secondRead.nextStep, /Wiki/);
results.push({ finding: "new_interpretation_of_old_chunk_has_no_wiki_debt", initialCommit: firstCommit.committed, newRecord: reread, recordCount: secondNote.records.length, wikiDebt: secondRead.wikiDebt, nextStep: secondRead.nextStep });

const briefing = await service.buildFromPaper({ libraryID: 1, userRequested: true, itemKey: "FULLQA01", limit: 1 });
assert.equal(briefing.phase, "expert_briefing");
await service.setReadingExpert({ libraryID: 1, itemKey: "FULLQA01", persona: "A directional solidification researcher evaluating furnace experiments and scope of their findings", focus: ["experimental procedure", "limitations of interpretation"] });
const page = await service.buildFromPaper({ libraryID: 1, userRequested: true, itemKey: "FULLQA01", limit: 1 });
assert.equal(page.chunks.length, 1);
let questionError = null;
try { await read("FULLQA01", [102], "The analysis excludes transient heating and does not establish applicability during rapid cooling (chunk 2)."); }
catch (error) { questionError = error.message; }
assert.equal(questionError, null);
assert.deepEqual(await sessions.pendingIntegrationIndexes(briefing.readingSession.sessionId), [0]);
assert.equal((await sessions.get(briefing.readingSession.sessionId)).integratedBatches, 0);
results.push({ finding: "qa_read_on_paper_open_for_fulltext_rejects_valid_retrieved_chunk", priorFulltextChunk: page.chunks[0].chunkId, attemptedQuestionChunk: 102, error: questionError });

console.log(JSON.stringify({ rootDir, results }, null, 2));
sqlite.close();
