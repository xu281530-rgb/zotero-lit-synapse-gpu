import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);
const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-round3-fulltext-"));
const fake = createZoteroFake({ rootDir });
fake.install();
fake.Zotero.Prefs = { get: () => undefined };
const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { getVectorStore } = await import("../src/modules/semantic/vectorStore.ts");
const { getEmbeddingService } = await import("../src/modules/semantic/embeddingService.ts");
const chunksByKey = new Map();
const revisions = new Map();
const vector = getVectorStore();
vector.initialize = async () => {};
vector.getDocumentRevision = async (key) => revisions.get(key) ?? "version-1";
vector.getChunksForItem = async (key) => chunksByKey.get(key) ?? [];
vector.getIndexStatus = async (key) => ({ contentHash: `hash-${key}`, sourceKind: "body" });
vector.getCommittedResetGeneration = async () => "reset-1";
const embedding = getEmbeddingService();
embedding.getConfig = () => ({ model: "audit-round3" });
embedding.embed = async () => ({
  embedding: new Float32Array([1, 0]),
  identity: { model: "audit-round3", apiBase: "fixture", provider: "openai", dimensions: 2 },
});

function adapt(sqlite) {
  let depth = 0;
  return {
    async queryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const statement = sqlite.prepare(sql);
      const values = params.map((value) => typeof value === "boolean" ? Number(value) : value);
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) return statement.all(...values);
      statement.run(...values);
      return [];
    },
    async valueQueryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const row = sqlite.prepare(sql).get(...params);
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(work) {
      if (depth > 0) return work();
      depth++;
      sqlite.exec("BEGIN");
      try {
        const result = await work();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally { depth--; }
    },
  };
}

const sqlite = new DatabaseSync(path.join(rootDir, "wiki.sqlite"));
const db = adapt(sqlite);
const store = new WikiStore(db);
await store.initialize();
const sessions = await store.readingSessions();
const service = new WikiService(store);
service.pumpEmbeddingQueue = async () => undefined;
service.links.onPaperRead = async () => undefined;
const observations = [];
async function observe(name, work) {
  try { observations.push({ name, reproduced: true, ...(await work()) }); }
  catch (error) { observations.push({ name, reproduced: false, error: String(error), stack: error.stack }); }
}

function record(indexes) {
  const citation = indexes.length === 1 ? `chunk ${indexes[0]}` : `chunks ${indexes.join(", ")}`;
  return [
    "**阅读总结**", "本批讲的是定向凝固。", "",
    "**方法**", `Directional solidification is discussed for the stations represented in these passages (${citation}).`, "",
    "**结果与结论**", "本批无结果数据。", "",
    "**概念与术语**", "无。", "",
    "**本批覆盖**", `本批涉及 ${citation}。`, "",
    "**存疑与未交代**", "无。",
  ].join("\n");
}
function summary(index = 0) {
  return [
    "## 本篇讲了什么", "这篇论文讨论定向凝固，关注站位序列上的组织演变。因此它的结论也按站位顺序给出。", "",
    "## 研究对象与材料", "合成夹具，未给出材料牌号，所以材料特征无从判断。样品范围同样只能按站位编号描述。", "",
    "## 核心方法", `论文以定向凝固站位序列作为核心研究方法（chunk ${index}）。`, "",
    "## 主要结果", "夹具未给出结果数据，因此没有可比较的测量值。趋势只能从站位序列本身推断。", "",
    "## 机理解释", "夹具未给出机理，因果链留待原文补充。可以确定的只有站位之间的先后关系。", "",
    "## 结论", "夹具未给出结论，因此这一节不作断言。贡献部分同样只能留空。", "",
    "## 边界与局限", "作者未讨论适用范围，也没有给出对照。因此边界只能视为未知。",
  ].join("\n");
}
async function open(libraryID, key, count, limit = count, texts = []) {
  fake.createPaper({ libraryID, key, title: `Paper ${key}`, abstract: "Directional solidification of columnar arrays." });
  chunksByKey.set(key, Array.from({ length: count }, (_, index) => ({
    chunkId: 1000 + index,
    text: texts[index] ?? "Directional solidification is discussed for the stations represented in these passages.",
    language: "en",
  })));
  const briefing = await service.buildFromPaper({ libraryID, userRequested: true, itemKey: key, limit });
  await service.setReadingExpert({
    libraryID, itemKey: key,
    persona: "A solidification metallurgist who evaluates columnar grain array processing and the conditions under which the columnar band collapses.",
    focus: ["the process chain and its parameters", "the criterion for the columnar-to-equiaxed transition"],
  });
  const page = await service.buildFromPaper({ libraryID, userRequested: true, itemKey: key, limit });
  return { sessionId: briefing.readingSession.sessionId, page };
}
async function finalPass(libraryID, itemKey) {
  const synthesis = await service.updateReadingNote({ libraryID, itemKey, finalSynthesis: true, macroSummary: summary() });
  await service.recordConcepts({ libraryID, itemKey, final: true, concepts: [], noConceptsReason: "This controlled paper introduces no terminology beyond the established processing field." });
  return synthesis;
}
const axes = {
  pages: "The established thematic Page already covers the processing subject without another Page.",
  claims: "The paper was reviewed against every existing Claim, and each finding is explicitly recorded below.",
  evidence: "Each existing quotation was checked against the paper's actual indexed text and reading ledger.",
  concepts: "The paper uses familiar terminology and introduces no independent concept requiring a new entry.",
  relations: "The source establishes no additional relation between concepts already held in the Wiki.",
};

await observe("fulltext partial readChunkIds silently integrates omitted passages", async () => {
  const { sessionId, page } = await open(31, "PARTIAL1", 4, 3, [undefined, "The sample fractures at a tensile stress of 120 MPa.", "Rapid cooling produced severe cracks and invalidated the proposed processing route."]);
  const updated = await service.updateReadingNote({ libraryID: 31, itemKey: "PARTIAL1", readChunkIds: [1000], readingRecord: record([1000]) });
  const session = await sessions.get(sessionId);
  const pending = await sessions.pendingIntegrationIndexes(sessionId);
  const saved = await service.getReadingNote({ libraryID: 31, itemKey: "PARTIAL1" });
  const next = await service.buildFromPaper({ libraryID: 31, userRequested: true, cursor: page.pagination.nextCursor });
  assert.equal(session.integratedChunks, 3);
  assert.deepEqual(pending, []);
  assert.equal(next.chunks[0].chunkIndex, 3);
  return { delivered: page.chunks.map((chunk) => chunk.chunkId), requestedReadChunkIds: [1000], recordedIntegratedChunks: session.integratedChunks, pendingIntegration: pending, updateIntegrationDebt: updated.readingSession.integrationDebt, nextPage: next.chunks.map((chunk) => chunk.chunkId), note: saved };
});

await observe("unsupported review leaves supported Claim retrievable after completed reading", async () => {
  const { sessionId } = await open(32, "UNSUPPR1", 1);
  await service.updateReadingNote({ libraryID: 32, itemKey: "UNSUPPR1", readingRecord: record([0]) });
  // A Claim written during an earlier question is valid fixture state at the start of a full-paper review.
  const seeded = await store.commit({ libraryID: 32, userInitiated: true, actions: [
    { action: "CREATE_PAGE", ref: "p", canonicalTitle: "Station processing" },
    { action: "ADD_CLAIM", ref: "c", pageId: "p", claimText: "Directional solidification guarantees every station has superior mechanical strength.", claimType: "mechanism", epistemicStatus: "supported", coverageLevel: "chunk_local", confidence: 0.9, evidence: [{ libraryID: 32, itemKey: "UNSUPPR1", chunkIdSnapshot: 1000, chunkTextHash: "chunk-hash", sourceContentHash: "hash-UNSUPPR1", sourceChunkSignature: "chunk-signature", sourceResetGeneration: "reset-1", excerpt: "Directional solidification is discussed for the stations represented in these passages.", evidenceRole: "SUPPORTS", readDepth: "chunk_local" }] },
  ] });
  const claimId = seeded.refs.c;
  await finalPass(32, "UNSUPPR1");
  const review = await service.prepareUpdate({ libraryID: 32, itemKey: "UNSUPPR1", query: "Station processing", wikiReview: { ...axes, claimVerdicts: [{ claimId, verdict: "unsupported", basis: "The complete paper describes processing stations but never measures mechanical strength, so this claim has no evidentiary support." }] } });
  const committed = await service.commit({ libraryID: 32, userInitiated: true, operationId: "unsupported-review", prepareToken: review.prepareToken, readingSessionId: sessionId, actions: [{ action: "SKIP", itemKey: "UNSUPPR1", chunkIds: [1000], reason: "This passage repeats the station-processing description already quoted in the existing thematic Page, without adding another parameter or observation." }] });
  const claim = await store.getClaim(claimId);
  const result = await service.search({ libraryID: 32, query: "mechanical strength", useVector: false });
  assert.equal(committed.readingSession.state, "committed");
  assert.equal(claim.epistemicStatus, "supported");
  assert.ok(result.claims.some((entry) => entry.claimId === claimId));
  return { claimId, verdict: "unsupported", completedState: committed.readingSession.state, storedClaimStatus: claim.epistemicStatus, storedClaim: claim.claimText, retrieval: result.claims };
});

await observe("unintegrated final page may be skipped by final synthesis", async () => {
  const { sessionId, page } = await open(34, "LASTPAGE", 2, 1, [undefined, "The sample fractures at a tensile stress of 120 MPa, which invalidates the proposed processing route."]);
  await service.updateReadingNote({ libraryID: 34, itemKey: "LASTPAGE", readingRecord: record([0]) });
  await service.buildFromPaper({ libraryID: 34, userRequested: true, cursor: page.pagination.nextCursor });
  const before = await sessions.get(sessionId);
  const synthesized = await finalPass(34, "LASTPAGE");
  const after = await sessions.get(sessionId);
  const pending = await sessions.pendingIntegrationIndexes(sessionId);
  const prepared = await service.prepareUpdate({ libraryID: 34, itemKey: "LASTPAGE", query: "Station processing", wikiReview: { ...axes, claimVerdicts: [] } });
  const committed = await service.commit({ libraryID: 34, userInitiated: true, operationId: "last-page-omission", prepareToken: prepared.prepareToken, readingSessionId: sessionId, actions: [{ action: "SKIP", itemKey: "LASTPAGE", chunkIds: [1000, 1001], reason: "The supplied station-processing descriptions repeat the same method without a parameter, contrast, measurement, or separate result to add to the thematic Wiki." }] });
  assert.equal(before.deliveredBatches - before.integratedBatches, 1);
  assert.equal(after.integratedChunks, 1);
  assert.equal(after.deliveredBatches - after.integratedBatches, 0);
  assert.equal(committed.readingSession.state, "committed");
  return { before: { deliveredBatches: before.deliveredBatches, integratedBatches: before.integratedBatches }, after: { deliveredBatches: after.deliveredBatches, integratedBatches: after.integratedBatches, integratedChunks: after.integratedChunks }, pendingIntegrationIndexes: pending, synthesisAccepted: synthesized.integrated, completedState: committed.readingSession.state };
});

console.log(JSON.stringify({ rootDir, observations }, null, 2));
sqlite.close();
if (observations.some((entry) => !entry.reproduced)) process.exitCode = 1;
