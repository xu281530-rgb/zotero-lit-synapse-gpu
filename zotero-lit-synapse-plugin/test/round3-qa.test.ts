/* Diagnostic expectations: the current defects should fail these tests. */
import { getVectorStore } from "../src/modules/semantic/vectorStore";
import { getEmbeddingService } from "../src/modules/semantic/embeddingService";
import { WikiStore } from "../src/modules/wiki/wikiStore";
import { WikiService } from "../src/modules/wiki/wikiService";
import { WikiReadingNoteStore, parseReadingNote, parseAppendOnlyReadingNote } from "../src/modules/wiki/wikiReadingNote";
import { readDocumentChunks } from "../src/modules/documentChunks";
import { WIKI_RECORD_SECTIONS } from "../src/modules/wiki/wikiRecordTemplate";

describe("Round 3 question-driven Wiki audit in real Zotero", function () {
  this.timeout(30000);
  let store: WikiStore;
  let service: WikiService;
  let item: any;
  let libraryID: number;
  let observed: any;
  const outcomes: any[] = [];
  let vector: any;
  let vectorDB: any;
  let originalVectorState: any;
  const notes = new WikiReadingNoteStore();
  const chunks = [
    { chunkId: 100, text: "The experimental procedure uses a directional furnace with controlled thermal gradients. The furnace requires a protective atmosphere to prevent oxidation." },
    { chunkId: 101, text: "At 120 MPa, the authors report a competing surface instability that reverses the interpretation of the stable interface." },
    { chunkId: 102, text: "The analysis excludes transient heating and does not establish applicability during rapid cooling." },
  ];
  const identity = { provider: "openai" as const, apiBase: "http://127.0.0.1:23125/round3-offline", model: "round3-offline", dimensions: 2, inputHash: "round3-qa-source", queryMode: false };
  const record = "The experimental procedure uses a directional furnace with controlled thermal gradients (chunk 0).";
  const interpretation = "The furnace requires a protective atmosphere to prevent oxidation (chunk 0).";
  let originalEmbed: any;
  let originalConfig: any;

  before(async function () {
    libraryID = Zotero.Libraries.userLibraryID;
    (globalThis as any).ztoolkit = { log: (...args: any[]) => Zotero.debug(args.map(String).join(" ")) };
    await persist();
    try {
      vector = getVectorStore();
      originalVectorState = Object.fromEntries(["db", "dbPath", "initialized", "initPromise", "keywordStore", "gpuBackend"].map((key) => [key, vector[key]]));
      const dbPath = PathUtils.join(Zotero.DataDirectory.dir, `round3-qa-vector-${Date.now()}.sqlite`);
      vectorDB = new Zotero.DBConnection(dbPath);
      Object.assign(vector, {
        db: vectorDB, dbPath, initialized: false, initPromise: null, keywordStore: null,
        gpuBackend: { registerProvider() {}, isEnabled: () => false, publishMutation: async () => undefined, fallback() {} },
      });
      // createTables also creates the persistent document revision triggers.
      await vector.createTables();
      vector.initialized = true;
      const embeddings: any = getEmbeddingService();
      originalEmbed = embeddings.embed;
      originalConfig = embeddings.getConfig;
      embeddings.getConfig = () => ({ model: "round3-offline" });
      embeddings.embed = async () => ({ embedding: new Float32Array([1, 0]), identity });
    } catch (error) {
      outcomes.push({ stage: "before", error: String(error), originalError: String((error as any)?.originalError ?? ""), stack: (error as any)?.stack });
      await persist();
      throw error;
    }
  });

  beforeEach(async function () {
    observed = {};
    const db = new Zotero.DBConnection(PathUtils.join(Zotero.DataDirectory.dir, `round3-qa-${Date.now()}.sqlite`));
    store = new WikiStore(db, vector);
    await store.initialize();
    service = new WikiService(store, notes);
    (service as any).pumpEmbeddingQueue = async () => undefined;
    service.links.onPaperRead = async () => undefined;
    item = new Zotero.Item("journalArticle");
    item.libraryID = libraryID;
    item.setField("title", `Round 3 QA audit ${Date.now()}`);
    await item.saveTx();
    await vector.replaceItemIndex({
      itemKey: item.key,
      libraryID,
      records: chunks.map((chunk) => ({ itemKey: item.key, libraryID, chunkId: chunk.chunkId, chunkText: chunk.text, vector: new Float32Array([1, 0]), language: "en", identity })),
      contentHash: "round3-qa-stable-body",
      contentLength: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      sourceKind: "body",
      itemModified: String(item.dateModified),
      attachmentModified: "round3-fixture",
      bodyRetrySignature: "round3-parser-v1",
    });
    await vector.setChunkSignature(item.key, "round3-chunker-v1", libraryID);
    observed.itemKey = item.key;
  });

  afterEach(async function () {
    const test: any = this.currentTest;
    outcomes.push({ title: test.title, state: test.state, observed, error: test.err ? String(test.err) : null, originalError: test.err?.originalError ? String(test.err.originalError) : null, stack: test.err?.stack });
    await persist();
    if (store) await store.close();
  });

  after(async function () {
    const embeddings: any = getEmbeddingService();
    if (originalEmbed) embeddings.embed = originalEmbed;
    if (originalConfig) embeddings.getConfig = originalConfig;
    if (originalVectorState) Object.assign(vector, originalVectorState);
    if (vectorDB) await vectorDB.closeDatabase();
  });

  async function persist() {
    await IOUtils.writeUTF8(PathUtils.join(Zotero.DataDirectory.dir, "round3-qa-results.json"), JSON.stringify(outcomes, null, 2));
  }

  async function read(ids: number[], readingRecord = record) {
    return service.updateReadingNote({ libraryID, itemKey: item.key, readChunkIds: ids, readingRecord, domain: "physical metallurgy", expertRole: "directional solidification specialist" });
  }

  async function inspect() {
    const sessions = await store.readingSessions();
    const session = await sessions.openForItem(libraryID, item.key);
    if (!session) return { session: null };
    const attachment = session.noteKey ? await Zotero.Items.getByLibraryAndKeyAsync(libraryID, session.noteKey) : null;
    const raw = attachment ? await notes.read(attachment) : null;
    return { session, coverage: await sessions.coverage(session.sessionId), pending: await sessions.pendingWikiChunks(session.sessionId), note: raw ? parseAppendOnlyReadingNote(parseReadingNote(raw).body) : null, noteMarkdown: raw };
  }

  it("refuses a QA record that declares three chunks but preserves only one", async function () {
    let error: any = null;
    try { observed.result = await read([100, 101, 102]); }
    catch (caught) { error = caught; observed.rejection = String(caught); observed.rejectionStack = (caught as any)?.stack; }
    observed.persisted = await inspect();
    assert.isNotNull(error, "Three chunks were counted as read although the note only contains chunk 0.");
    assert.equal(observed.persisted.coverage?.deliveredChunks ?? 0, 0);
  });

  it("refuses unchanged on a first reading with no earlier content to cover the chunks", async function () {
    let error: any = null;
    try { observed.result = await service.updateReadingNote({ libraryID, itemKey: item.key, readChunkIds: [100, 101, 102], unchanged: true, unchangedReason: "already known" }); }
    catch (caught) { error = caught; observed.rejection = String(caught); observed.rejectionStack = (caught as any)?.stack; }
    observed.persisted = await inspect();
    assert.isNotNull(error, "A first reading dropped the new 120 MPa measurement and was still counted as complete.");
    assert.equal(observed.persisted.coverage?.deliveredChunks ?? 0, 0);
  });

  it("keeps a new interpretation of a settled chunk pending for Wiki review", async function () {
    await read([100]);
    observed.firstCommit = await service.commit({ libraryID, userInitiated: true, operationId: `round3-qa-${item.key}`, actions: [{ action: "SKIP", itemKey: item.key, chunkIds: [100], reason: "The furnace description states the laboratory procedure and does not establish an independent mechanism or finding for the Wiki." }] });
    observed.secondReading = await read([100], interpretation);
    observed.persisted = await inspect();
    assert.equal(observed.persisted.note.records.length, 2);
    assert.isAbove(observed.secondReading.wikiDebt.count, 0, "A distinct new note record was accepted but no Wiki follow-up remains.");
  });

  it("records question retrieval from the same paper while its fulltext pass is incomplete", async function () {
    observed.briefing = await service.buildFromPaper({ libraryID, userRequested: true, itemKey: item.key, limit: 1 });
    await service.setReadingExpert({ libraryID, itemKey: item.key, persona: "A directional solidification researcher evaluating furnace experiments and scope of their findings", focus: ["experimental procedure", "limitations of interpretation"] });
    observed.fulltextPage = await service.buildFromPaper({ libraryID, userRequested: true, itemKey: item.key, limit: 1 });
    const firstPageSections = [record, `${record} ${interpretation}`, `${record} ${interpretation}`, "\u65e0\u3002", "The furnace procedure and its protective atmosphere are recorded here (chunk 0).", "\u65e0\u3002"];
    const firstPageRecord = WIKI_RECORD_SECTIONS.map((section, index) => `**${section.label}**\n${firstPageSections[index]}`).join("\n\n");
    observed.firstPageIntegration = await service.updateReadingNote({ libraryID, itemKey: item.key, readingRecord: firstPageRecord });
    assert.isTrue(observed.firstPageIntegration.integrated, "The first fulltext page must be recorded before changing to question retrieval.");
    observed.retrieved = await readDocumentChunks({ libraryID, itemKey: item.key, offset: 2, limit: 1 }, {
      getFullTextAvailability: async () => "indexed" as const,
      getTitle: async () => String(item.getField("title")),
      getChunks: (key: string, library: number) => vector.getChunksForItem(key, library),
      getPage: (key: string, library: number, offset: number, limit: number) => vector.getDocumentChunkPage(key, library, offset, limit),
    }, libraryID);
    const retrievedId = observed.retrieved.data[0].chunkId;
    let error: any = null;
    try { observed.questionReading = await read([retrievedId], "The analysis excludes transient heating and does not establish applicability during rapid cooling (chunk 2)."); }
    catch (caught) { error = caught; observed.rejection = String(caught); observed.rejectionStack = (caught as any)?.stack; }
    observed.persisted = await inspect();
    assert.isNull(error, "A real retrieved chunk is rejected because the earlier fulltext pass did not deliver it.");
  });
});
