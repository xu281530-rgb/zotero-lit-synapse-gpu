import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);
const preferences = new Map();
globalThis.Zotero = {
  Libraries: { userLibraryID: 1 },
  Prefs: {
    get: (key) => preferences.get(key),
    set: (key, value) => preferences.set(key, value),
    clear: (key) => preferences.delete(key),
  },
  Items: { getAsync: async () => null },
};
globalThis.ztoolkit = { log() {} };
const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");
const { SemanticSearchService } = await import("../src/modules/semantic/semanticSearchService.ts");
const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiRetriever } = await import("../src/modules/wiki/wikiRetriever.ts");
const { WikiEvidenceRelinker } = await import("../src/modules/wiki/wikiEvidenceRelinker.ts");
const { hashWikiText } = await import("../src/modules/wiki/wikiCanonicalizer.ts");
const { readDocumentChunks } = await import("../src/modules/documentChunks.ts");

function adapt(sqlite) {
  let depth = 0;
  return {
    async queryAsync(sql, params = []) {
      const statement = sqlite.prepare(sql);
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) return statement.all(...params);
      statement.run(...params);
      return [];
    },
    async valueQueryAsync(sql, params = []) {
      const row = sqlite.prepare(sql).get(...params);
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(fn) {
      if (depth) return fn();
      depth++;
      sqlite.exec("BEGIN");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally { depth--; }
    },
  };
}

const vectorDB = new DatabaseSync(":memory:");
const wikiDB = new DatabaseSync(":memory:");
const vector = new VectorStore({ registerProvider() {}, isEnabled: () => false, publishMutation: async () => {}, fallback() {} });
vector.db = adapt(vectorDB);
await vector.createTables();
vector.initialized = true;
const wiki = new WikiStore(adapt(wikiDB));
await wiki.initialize();
const sessions = await wiki.readingSessions();
const original = "A higher thermal gradient suppresses interface instability.";
vectorDB.prepare("INSERT INTO embeddings(item_key, chunk_id, vector, language, chunk_text, dimensions) VALUES (?, 0, x'', 'en', ?, 2)").run("PAPER001", original);
vectorDB.prepare("INSERT INTO embeddings(item_key, chunk_id, vector, language, chunk_text, dimensions) VALUES (?, 1, x'', 'en', ?, 2)").run("PAPER001", "Second paragraph with unchanged text.");
await vector.updateIndexStatus("PAPER001", 2, "content-v1", "old", "old", 1, original.length, "pdf", "parser-v1");
await vector.setChunkSignature("PAPER001", "chunk-v1", 1);
const versionBefore = await vector.getDocumentRevision("PAPER001", 1);
const session = await sessions.startOrContinue({ libraryID: 1, itemKey: "PAPER001", title: "Audit", totalChunks: 2, sourceVersion: versionBefore });
await sessions.recordDelivery(session.sessionId, [{ chunkIndex: 0, chunkId: 0 }]);
const chunksDeps = {
  userLibraryID: 1,
  getFullTextAvailability: async () => "indexed",
  getTitle: async () => "Audit",
  getChunks: (key, libraryID) => vector.getChunksForItem(key, libraryID),
  getPage: (key, libraryID, offset, limit) => vector.getDocumentChunkPage(key, libraryID, offset, limit),
};
const page = await readDocumentChunks({ itemKey: "PAPER001", limit: 1 }, chunksDeps, 1);
await vector.updateIndexStatus("PAPER001", 2, "content-v1", "new", "new", 1, original.length, "pdf", "parser-v1");
const versionAfter = await vector.getDocumentRevision("PAPER001", 1);
assert.notEqual(versionBefore, versionAfter);
let cursorError = "";
try { await readDocumentChunks({ cursor: page.pagination.nextCursor }, chunksDeps, 1); }
catch (error) { cursorError = error.message; }
assert.match(cursorError, /changed/i);
await sessions.startOrContinue({ libraryID: 1, itemKey: "PAPER001", title: "Audit", totalChunks: 2, sourceVersion: versionAfter });
assert.equal((await sessions.coverage(session.sessionId)).deliveredChunks, 0);
console.log(JSON.stringify({ test: "unchanged_timestamp_refresh", revisionChanged: true, cursorError, deliveredBefore: 1, deliveredAfter: 0, pageTotalChars: page.metadata.totalChars, actualTotalChars: original.length + "Second paragraph with unchanged text.".length }));

await wiki.commit({ libraryID: 1, userInitiated: true, actions: [
  { action: "CREATE_PAGE", ref: "p", canonicalTitle: "Thermal gradient", primaryConcept: { canonicalName: "thermal gradient" } },
  { action: "ADD_CLAIM", pageId: "p", claimText: original, claimType: "mechanism", epistemicStatus: "supported", coverageLevel: "paper_reviewed", confidence: 0.9, evidence: [{ libraryID: 1, itemKey: "PAPER001", chunkIdSnapshot: 0, chunkTextHash: await hashWikiText(original), sourceContentHash: "content-v1", sourceChunkSignature: "chunk-v1", sourceResetGeneration: "none", excerpt: original, evidenceRole: "SUPPORTS", readDepth: "paper_reviewed" }] },
] });

const service = Object.create(SemanticSearchService.prototype);
Object.assign(service, {
  initialized: true, vectorStore: vector,
  embeddingService: { embedBatch: async (items) => new Map(items.map(({ id }) => [id, { embedding: new Float32Array([1, 0]), language: "en" }])) },
  extractItemContent: async () => ({ text: "The revised measurements show no thermal gradient effect.", hasBody: true, hasBodySource: true, bodySources: ["pdf"], failedSources: [] }),
  textChunker: { chunk: (text) => [text] },
  indexProgress: { total: 0, processed: 0, status: "idle", failedCount: 0 },
  _failedItems: new Map(), _wikiBodyReadyItemKeys: new Set(), _activeIndexOperations: 0,
  _paused: false, _aborted: false, _buildActive: false, _forceRun: false,
  _activeBuildID: null, _activeFullLibraryRebuild: false, _databaseResetActive: false,
});
const item = { key: "PAPER001", libraryID: 1, dateModified: "changed", isRegularItem: () => true, getAttachments: () => [], getDisplayTitle: () => "Audit", getField: () => "", getTags: () => [], getCreators: () => [] };
await service.indexItemWithProcessor(item, null, true);
const currentChunks = await vector.getChunksForItem("PAPER001", 1);
assert.ok(currentChunks.every((chunk) => !chunk.text.includes(original)));
const relinker = new WikiEvidenceRelinker(wiki, { sourceExists: async () => true, getChunks: async () => currentChunks.map((chunk) => ({ ...chunk, contentHash: "content-v2", chunkSignature: "chunk-v1", resetGeneration: "none" })) });
const reverify = await relinker.relinkPending({ libraryID: 1, itemKeys: ["PAPER001"] });
const result = await new WikiRetriever(wiki).search({ libraryID: 1, query: "thermal gradient" });
assert.equal(reverify.checked, 0);
assert.equal(result.documents[0].readDepth, "paper_reviewed");
assert.equal(result.documents[0].wikiClaims[0].evidence[0].linkState, "valid");
console.log(JSON.stringify({ test: "direct_reparse_keeps_old_evidence", currentText: currentChunks.map((chunk) => chunk.text), returnedClaim: result.documents[0].wikiClaims[0].claimText, returnedDepth: result.documents[0].readDepth, evidenceState: result.documents[0].wikiClaims[0].evidence[0].linkState, reverifyChecked: reverify.checked }));
vectorDB.close();
wikiDB.close();
