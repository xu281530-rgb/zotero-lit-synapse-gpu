import { VectorStore } from "../src/modules/semantic/vectorStore";
import { SemanticSearchService } from "../src/modules/semantic/semanticSearchService";
import { WikiStore } from "../src/modules/wiki/wikiStore";
import { WikiRetriever } from "../src/modules/wiki/wikiRetriever";
import { WikiEvidenceRelinker } from "../src/modules/wiki/wikiEvidenceRelinker";
import { hashWikiText } from "../src/modules/wiki/wikiCanonicalizer";
import { readDocumentChunks } from "../src/modules/documentChunks";

describe("Round 2 source identity in real Zotero", function () {
  this.timeout(30000);
  let vector: any;
  let vectorDB: any;
  let wikiDB: any;
  let wiki: WikiStore;
  let libraryID: number;
  let vectorPath: string;
  let wikiPath: string;
  const outcomes: any[] = [];
  const original =
    "A higher thermal gradient suppresses interface instability.";
  const second = "A second paragraph with an astral character: \u{1F680}.";
  const itemKey = "ROUND2RD";
  const identity = {
    provider: "openai" as const,
    apiBase: "http://127.0.0.1:23125/audit/v1",
    model: "audit",
    dimensions: 2,
    requestedDimensions: 2,
    inputHash: "runtime-source-fixture",
    queryMode: false,
  };

  async function openStores() {
    vectorDB = new Zotero.DBConnection(vectorPath);
    vector = new VectorStore({
      registerProvider() {},
      isEnabled: () => false,
      publishMutation: async () => {},
      fallback() {},
    } as any);
    vector.db = vectorDB;
    await vector.createTables();
    vector.initialized = true;
    wikiDB = new Zotero.DBConnection(wikiPath);
    wiki = new WikiStore(wikiDB, vector);
    await wiki.initialize();
  }

  before(async function () {
    libraryID = Zotero.Libraries.userLibraryID;
    (globalThis as any).ztoolkit = {
      log: (...args: any[]) => Zotero.debug(args.map(String).join(" ")),
    };
    vectorPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      `round2-vector-${Date.now()}.sqlite`,
    );
    wikiPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      `round2-wiki-${Date.now()}.sqlite`,
    );
    await openStores();
  });

  afterEach(async function () {
    const test = this.currentTest as any;
    outcomes.push({
      title: test.title,
      state: test.state,
      error: test.err ? String(test.err) : null,
      stack: test.err?.stack,
    });
    await IOUtils.writeUTF8(
      PathUtils.join(Zotero.DataDirectory.dir, "round2-reading-results.json"),
      JSON.stringify(outcomes, null, 2),
    );
  });

  after(async function () {
    await wiki.close();
    await vectorDB.closeDatabase();
  });

  it("preserves reading and cursor on timestamp-only refresh, with exact document totals", async function () {
    await vector.replaceItemIndex({
      itemKey,
      libraryID,
      records: [original, second].map((chunkText, chunkId) => ({
        itemKey,
        libraryID,
        chunkId,
        chunkText,
        vector: new Float32Array([1, 0]),
        language: "en",
        identity,
      })),
      contentHash: "before",
      contentLength: original.length + second.length,
      sourceKind: "pdf",
      itemModified: "old",
      attachmentModified: "old",
      bodyRetrySignature: "parser-v1",
    });
    await vector.setChunkSignature(itemKey, "chunk-v1", libraryID);
    const sourceVersion = await vector.getDocumentRevision(itemKey, libraryID);
    const sessions = await wiki.readingSessions();
    const session = await sessions.startOrContinue({
      libraryID,
      itemKey,
      title: "Round 2 reading",
      totalChunks: 2,
      sourceVersion,
    });
    await sessions.recordDelivery(session.sessionId, [
      { chunkIndex: 0, chunkId: 0 },
    ]);
    const deps = {
      getFullTextAvailability: async () => "indexed" as const,
      getTitle: async () => "Round 2 reading",
      getChunks: (key: string, library: number) =>
        vector.getChunksForItem(key, library),
      getPage: (key: string, library: number, offset: number, limit: number) =>
        vector.getDocumentChunkPage(key, library, offset, limit),
    };
    const page = await readDocumentChunks(
      { libraryID, itemKey, limit: 1 },
      deps,
      libraryID,
    );
    assert.equal(page.metadata.totalChars, original.length + second.length);
    assert.equal(page.metadata.returnedChars, original.length);
    await vector.updateIndexStatus(
      itemKey,
      2,
      "before",
      "new",
      "new",
      libraryID,
      original.length + second.length,
      "pdf",
      "parser-v1",
    );
    assert.equal(
      await vector.getDocumentRevision(itemKey, libraryID),
      sourceVersion,
    );
    const next = await readDocumentChunks(
      { cursor: page.pagination.nextCursor },
      deps,
      libraryID,
    );
    assert.equal(next.data[0].text, second);
    await sessions.startOrContinue({
      libraryID,
      itemKey,
      title: "Round 2 reading",
      totalChunks: 2,
      sourceVersion,
    });
    assert.equal(
      (await sessions.coverage(session.sessionId)).deliveredChunks,
      1,
    );
    await vector.updateIndexStatus(
      itemKey,
      2,
      "before",
      "new",
      "new",
      libraryID,
      original.length + second.length,
      "pdf",
      "parser-v2",
    );
    assert.notEqual(
      await vector.getDocumentRevision(itemKey, libraryID),
      sourceVersion,
    );
  });

  it("blocks old valid evidence after direct reparse and reopening both SQLite databases", async function () {
    await wiki.synchronizeSourceChanges();
    await wiki.commit({
      libraryID,
      userInitiated: true,
      actions: [
        {
          action: "CREATE_PAGE",
          ref: "p",
          canonicalTitle: "Round 2 thermal gradient",
        },
        {
          action: "ADD_CLAIM",
          pageId: "p",
          claimText: original,
          claimType: "mechanism",
          epistemicStatus: "supported",
          coverageLevel: "paper_reviewed",
          confidence: 0.8,
          evidence: [
            {
              libraryID,
              itemKey,
              chunkIdSnapshot: 0,
              chunkTextHash: await hashWikiText(original),
              sourceContentHash: "before",
              sourceChunkSignature: "chunk-v1",
              sourceResetGeneration: "none",
              excerpt: original,
              evidenceRole: "SUPPORTS",
              readDepth: "paper_reviewed",
            },
          ],
        },
      ],
    });
    const service: any = Object.create(SemanticSearchService.prototype);
    Object.assign(service, {
      initialized: true,
      vectorStore: vector,
      embeddingService: {
        embedBatch: async (items: any[]) =>
          new Map(
            items.map(({ id }) => [
              id,
              { embedding: new Float32Array([1, 0]), language: "en", identity },
            ]),
          ),
      },
      extractItemContent: async () => ({
        text: "Revised measurements show no thermal gradient effect.",
        hasBody: true,
        hasBodySource: true,
        bodySources: ["pdf"],
        failedSources: [],
      }),
      textChunker: { chunk: (text: string) => [text] },
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
      key: itemKey,
      libraryID,
      dateModified: "changed",
      isRegularItem: () => true,
      getAttachments: () => [],
      getDisplayTitle: () => "Round 2 source",
      getField: () => "",
      getTags: () => [],
      getCreators: () => [],
    };
    await service.indexItemWithProcessor(item, null, true);
    assert.equal(
      await wikiDB.valueQueryAsync(
        "SELECT link_state FROM wiki_evidence LIMIT 1",
      ),
      "valid",
    );
    await wiki.close();
    await vectorDB.closeDatabase();
    await openStores();
    const result = await new WikiRetriever(wiki).search({
      libraryID,
      query: "thermal gradient",
    });
    assert.equal(result.documents.length, 0);
    const claims = await wiki.listClaimsByEvidenceSource(libraryID, itemKey);
    assert.equal(claims[0].evidence[0].linkState, "pending_relink");
    assert.equal(claims[0].evidence[0].readDepth, "chunk_local");
    const relinker = new WikiEvidenceRelinker(wiki, {
      sourceExists: async () => true,
      getChunks: async () =>
        (await vector.getChunksForItem(itemKey, libraryID)).map(
          (chunk: any) => ({
            ...chunk,
            contentHash: "after",
            chunkSignature: "chunk-v2",
            resetGeneration: "none",
          }),
        ),
    });
    assert.equal(
      (await relinker.relinkPending({ libraryID, itemKeys: [itemKey] }))
        .checked,
      1,
    );
    assert.equal(
      (
        await new WikiRetriever(wiki).search({
          libraryID,
          query: "thermal gradient",
        })
      ).documents.length,
      0,
    );
  });
});
