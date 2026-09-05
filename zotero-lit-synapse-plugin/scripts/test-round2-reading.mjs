import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const { getSemanticSearchService } = await import(
  "../src/modules/semantic/semanticSearchService.ts"
);
const { refreshParentSemanticIndex } = await import(
  "../src/modules/pdfTextSource.ts"
);
const { enqueueIndexRefresh, processIndexRefreshQueue } = await import(
  "../src/modules/semantic/indexRefreshQueue.ts"
);
const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiRetriever } = await import("../src/modules/wiki/wikiRetriever.ts");
const { WikiEvidenceRelinker } = await import(
  "../src/modules/wiki/wikiEvidenceRelinker.ts"
);
const { hashWikiText } = await import(
  "../src/modules/wiki/wikiCanonicalizer.ts"
);
const { readDocumentChunks } = await import("../src/modules/documentChunks.ts");

function adapt(sqlite, queries = []) {
  let depth = 0;
  return {
    async queryAsync(sql, params = []) {
      queries.push(sql);
      const statement = sqlite.prepare(sql);
      if (/^\s*(select|pragma|with)\b/iu.test(sql))
        return statement.all(...params);
      statement.run(...params);
      return [];
    },
    async valueQueryAsync(sql, params = []) {
      queries.push(sql);
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
      } finally {
        depth--;
      }
    },
  };
}

const directory = await mkdtemp(join(tmpdir(), "litsynapse-reading-"));
let vectorDB;
let wikiDB;
const failures = [];
try {
  const queries = [];
  vectorDB = new DatabaseSync(join(directory, "vector.sqlite"));
  wikiDB = new DatabaseSync(join(directory, "wiki.sqlite"));
  let vector = new VectorStore({
    registerProvider() {},
    isEnabled: () => false,
    publishMutation: async () => {},
    fallback() {},
  });
  vector.db = adapt(vectorDB, queries);
  await vector.createTables();
  vector.initialized = true;
  let wiki = new WikiStore(adapt(wikiDB), vector);
  await wiki.initialize();
  const sessions = await wiki.readingSessions();
  const original =
    "A higher thermal gradient suppresses interface instability.";
  const second = "Second paragraph with unchanged text.";
  vectorDB
    .prepare(
      "INSERT INTO embeddings(item_key, chunk_id, vector, language, chunk_text, dimensions) VALUES (?, 0, x'', 'en', ?, 2)",
    )
    .run("PAPER001", original);
  vectorDB
    .prepare(
      "INSERT INTO embeddings(item_key, chunk_id, vector, language, chunk_text, dimensions) VALUES (?, 1, x'', 'en', ?, 2)",
    )
    .run("PAPER001", second);
  await vector.updateIndexStatus(
    "PAPER001",
    2,
    "content-v1",
    "old",
    "old",
    1,
    original.length,
    "pdf",
    "parser-v1",
  );
  await vector.setChunkSignature("PAPER001", "chunk-v1", 1);
  const versionBefore = await vector.getDocumentRevision("PAPER001", 1);
  const session = await sessions.startOrContinue({
    libraryID: 1,
    itemKey: "PAPER001",
    title: "Audit",
    totalChunks: 2,
    sourceVersion: versionBefore,
  });
  await sessions.recordDelivery(session.sessionId, [
    { chunkIndex: 0, chunkId: 0 },
  ]);
  const deps = {
    userLibraryID: 1,
    getFullTextAvailability: async () => "indexed",
    getTitle: async () => "Audit",
    getChunks: (key, libraryID) => vector.getChunksForItem(key, libraryID),
    getPage: (key, libraryID, offset, limit) =>
      vector.getDocumentChunkPage(key, libraryID, offset, limit),
  };
  async function check(name, fn) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  queries.length = 0;
  const page = await readDocumentChunks(
    { itemKey: "PAPER001", limit: 1 },
    deps,
    1,
  );
  await check(
    "R09 document totals survive page slicing without full-text scan",
    async () => {
      assert.equal(page.metadata.totalChars, original.length + second.length);
      assert.equal(page.metadata.returnedChars, original.length);
      assert.equal(
        queries.filter((sql) =>
          /SELECT.*chunk_text.*FROM embeddings/iu.test(sql),
        ).length,
        1,
      );
      assert.ok(
        queries
          .filter((sql) => /SELECT.*chunk_text.*FROM embeddings/iu.test(sql))
          .every((sql) => /LIMIT/iu.test(sql)),
      );
    },
  );
  await vector.updateIndexStatus(
    "PAPER001",
    2,
    "content-v1",
    "new",
    "new",
    1,
    original.length,
    "pdf",
    "parser-v1",
  );
  const versionAfter = await vector.getDocumentRevision("PAPER001", 1);
  await check(
    "R03 timestamp refresh preserves cursor and delivered reading",
    async () => {
      assert.equal(versionAfter, versionBefore);
      const next = await readDocumentChunks(
        { cursor: page.pagination.nextCursor },
        deps,
        1,
      );
      assert.equal(next.data[0].text, second);
      await sessions.startOrContinue({
        libraryID: 1,
        itemKey: "PAPER001",
        title: "Audit",
        totalChunks: 2,
        sourceVersion: versionAfter,
      });
      assert.equal(
        (await sessions.coverage(session.sessionId)).deliveredChunks,
        1,
      );
    },
  );
  await check(
    "R03 changed parser and chunk rules still invalidate old cursors",
    async () => {
      await vector.updateIndexStatus(
        "PAPER001",
        2,
        "content-v1",
        "new",
        "new",
        1,
        original.length,
        "pdf",
        "parser-v2",
      );
      assert.notEqual(
        await vector.getDocumentRevision("PAPER001", 1),
        versionAfter,
      );
      await assert.rejects(
        readDocumentChunks({ cursor: page.pagination.nextCursor }, deps, 1),
        /changed/i,
      );
      const parserRevision = await vector.getDocumentRevision("PAPER001", 1);
      await vector.setChunkSignature("PAPER001", "chunk-v2", 1);
      assert.notEqual(
        await vector.getDocumentRevision("PAPER001", 1),
        parserRevision,
      );
    },
  );
  if (wiki.synchronizeSourceChanges) await wiki.synchronizeSourceChanges();
  await wiki.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "CREATE_PAGE",
        ref: "p",
        canonicalTitle: "Thermal gradient",
        primaryConcept: { canonicalName: "thermal gradient" },
      },
      {
        action: "ADD_CLAIM",
        pageId: "p",
        claimText: original,
        claimType: "mechanism",
        epistemicStatus: "supported",
        coverageLevel: "paper_reviewed",
        confidence: 0.9,
        evidence: [
          {
            libraryID: 1,
            itemKey: "PAPER001",
            chunkIdSnapshot: 0,
            chunkTextHash: await hashWikiText(original),
            sourceContentHash: "content-v1",
            sourceChunkSignature: "chunk-v2",
            sourceResetGeneration: "none",
            excerpt: original,
            evidenceRole: "SUPPORTS",
            readDepth: "paper_reviewed",
          },
        ],
      },
    ],
  });
  const service = getSemanticSearchService();
  Object.assign(service, {
    initialized: true,
    vectorStore: vector,
    embeddingService: {
      isReady: async () => true,
      embedBatch: async (items) =>
        new Map(
          items.map(({ id }) => [
            id,
            {
              embedding: new Float32Array([1, 0]),
              language: "en",
              identity: {
                model: "audit",
                apiBase: "http://audit.invalid",
                provider: "openai",
                dimensions: 2,
                requestedDimensions: 2,
                inputHash: id,
                queryMode: false,
              },
            },
          ]),
        ),
    },
    extractItemContent: async () => ({
      text: "The revised measurements show no thermal gradient effect.",
      hasBody: true,
      hasBodySource: true,
      bodySources: ["pdf"],
      failedSources: [],
    }),
    textChunker: { chunk: (text) => [text] },
    indexProgress: { total: 0, processed: 0, status: "idle", failedCount: 0 },
    _failedItems: new Map(),
    _wikiBodyReadyItemKeys: new Set(),
    _activeIndexOperations: 0,
    _paused: false,
    _aborted: false,
    _buildActive: false,
    _forceRun: false,
    _activeBuildID: null,
    _activeFullLibraryRebuild: false,
    _databaseResetActive: false,
  });
  const item = {
    key: "PAPER001",
    libraryID: 1,
    dateModified: "changed",
    isRegularItem: () => true,
    getAttachments: () => [],
    getDisplayTitle: () => "Audit",
    getField: () => "",
    getTags: () => [],
    getCreators: () => [],
  };
  globalThis.Zotero.Items.getAsync = async () => item;
  globalThis.Zotero.Items.getByLibraryAndKeyAsync = async () => item;
  await service.indexItemWithProcessor(item, null, true);
  assert.equal(
    wikiDB.prepare("SELECT link_state FROM wiki_evidence").get().link_state,
    "valid",
    "fixture stops before any cross-database callback",
  );
  vectorDB.close();
  wikiDB.close();
  vectorDB = new DatabaseSync(join(directory, "vector.sqlite"));
  wikiDB = new DatabaseSync(join(directory, "wiki.sqlite"));
  vector = new VectorStore({
    registerProvider() {},
    isEnabled: () => false,
    publishMutation: async () => {},
    fallback() {},
  });
  vector.db = adapt(vectorDB, queries);
  await vector.createTables();
  vector.initialized = true;
  service.vectorStore = vector;
  wiki = new WikiStore(adapt(wikiDB), vector);
  await check(
    "R01 direct reparse is guarded before any best-effort Wiki callback",
    async () => {
      const result = await new WikiRetriever(wiki).search({
        libraryID: 1,
        query: "thermal gradient",
      });
      assert.equal(result.documents.length, 0);
      const claims = await wiki.listClaimsByEvidenceSource(1, "PAPER001");
      assert.equal(claims[0].evidence[0].linkState, "pending_relink");
      assert.equal(claims[0].evidence[0].readDepth, "chunk_local");
    },
  );
  wikiDB.close();
  wikiDB = new DatabaseSync(join(directory, "wiki.sqlite"));
  wiki = new WikiStore(adapt(wikiDB), vector);
  await check(
    "R01 persistent invalidation survives reopen and is reverified",
    async () => {
      const currentChunks = await vector.getChunksForItem("PAPER001", 1);
      const relinker = new WikiEvidenceRelinker(wiki, {
        sourceExists: async () => true,
        getChunks: async () =>
          currentChunks.map((chunk) => ({
            ...chunk,
            contentHash: "content-v2",
            chunkSignature: "chunk-v2",
            resetGeneration: "none",
          })),
      });
      const reverify = await relinker.relinkPending({
        libraryID: 1,
        itemKeys: ["PAPER001"],
      });
      assert.equal(reverify.checked, 1);
      assert.equal(
        (
          await new WikiRetriever(wiki).search({
            libraryID: 1,
            query: "thermal gradient",
          })
        ).documents.length,
        0,
      );
    },
  );
  for (const entry of ["manual", "parser", "refresh-queue"]) {
    await check(
      `R01 ${entry} entry persists invalidation before Wiki handling`,
      async () => {
        await vector.replaceItemIndex({
          itemKey: item.key,
          libraryID: 1,
          records: [
            {
              itemKey: item.key,
              libraryID: 1,
              chunkId: 0,
              chunkText: original,
              vector: new Float32Array([1, 0]),
              language: "en",
            },
          ],
          contentHash: "original",
          contentLength: original.length,
          sourceKind: "pdf",
          itemModified: "before",
          attachmentModified: "before",
        });
        await wiki.synchronizeSourceChanges();
        wikiDB
          .prepare(
            "UPDATE wiki_evidence SET link_state='valid', read_depth='paper_reviewed'",
          )
          .run();
        if (entry === "manual") await service.indexItem(item);
        if (entry === "parser")
          await refreshParentSemanticIndex({ parentItemID: 7 });
        if (entry === "refresh-queue") {
          enqueueIndexRefresh(1, item.key, "audit");
          const drained = await processIndexRefreshQueue({
            service,
            getCommittedResetGeneration: async () => null,
          });
          assert.equal(drained.processed, 1);
        }
        assert.ok(
          (await vector.listPendingWikiSourceChanges()).some(
            (change) => change.itemKey === item.key,
          ),
        );
        assert.equal(
          (
            await new WikiRetriever(wiki).search({
              libraryID: 1,
              query: "thermal gradient",
            })
          ).documents.length,
          0,
        );
      },
    );
  }
  await check(
    "R01 failed invalidation is not acknowledged and blocks stale reads",
    async () => {
      await vector.setChunkSignature(item.key, "fault-pending", 1);
      wikiDB
        .prepare(
          "UPDATE wiki_evidence SET link_state='valid', read_depth='paper_reviewed'",
        )
        .run();
      const faultDB = adapt(wikiDB);
      const originalQuery = faultDB.queryAsync;
      faultDB.queryAsync = async (sql, params) => {
        if (
          sql.startsWith(
            "UPDATE wiki_evidence SET link_state = 'pending_relink'",
          )
        )
          throw new Error("audit failed Wiki write");
        return originalQuery(sql, params);
      };
      const failedWiki = new WikiStore(faultDB, vector);
      await assert.rejects(
        new WikiRetriever(failedWiki).search({
          libraryID: 1,
          query: "thermal gradient",
        }),
        /audit failed/,
      );
      assert.ok(
        (await vector.listPendingWikiSourceChanges()).some(
          (change) => change.itemKey === item.key,
        ),
      );
      assert.equal(
        (
          await new WikiRetriever(wiki).search({
            libraryID: 1,
            query: "thermal gradient",
          })
        ).documents.length,
        0,
      );
    },
  );
  await check(
    "R01 index mutation during snapshot rejects the old snapshot",
    async () => {
      const racingDB = adapt(wikiDB);
      const originalQuery = racingDB.queryAsync;
      let changed = false;
      racingDB.queryAsync = async (sql, params) => {
        const rows = await originalQuery(sql, params);
        if (
          !changed &&
          sql.startsWith("SELECT e.* FROM wiki_evidence e JOIN wiki_claims")
        ) {
          changed = true;
          await vector.setChunkSignature(item.key, "concurrent-source", 1);
        }
        return rows;
      };
      await assert.rejects(
        new WikiRetriever(new WikiStore(racingDB, vector)).search({
          libraryID: 1,
          query: "thermal gradient",
        }),
        /sources changed/,
      );
    },
  );
  assert.equal(failures.length, 0, failures.join(", "));
} finally {
  vectorDB?.close();
  wikiDB?.close();
  await rm(directory, { recursive: true, force: true });
}
