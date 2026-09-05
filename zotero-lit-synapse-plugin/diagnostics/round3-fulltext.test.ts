import { WikiStore } from "../src/modules/wiki/wikiStore";
import { WikiService } from "../src/modules/wiki/wikiService";
import { getVectorStore } from "../src/modules/semantic/vectorStore";
import { getEmbeddingService } from "../src/modules/semantic/embeddingService";
import { hashWikiText } from "../src/modules/wiki/wikiCanonicalizer";

describe("Round 3 full-text Wiki diagnostic in real Zotero", function () {
  this.timeout(30000);
  let db: any;
  let vectorDB: any;
  let vector: any;
  let originalVector: any;
  let store: WikiStore;
  let service: any;
  let sessions: any;
  let libraryID: number;
  let observed: any;
  let originalEmbed: any;
  let originalGetConfig: any;
  const outcomes: any[] = [];
  const source = "Directional solidification is discussed for the stations represented in these passages.";
  const identity = {
    model: "audit-round3", apiBase: "fixture", provider: "openai" as const,
    dimensions: 2,
  };

  beforeEach(async function () {
    observed = {};
    libraryID = Zotero.Libraries.userLibraryID;
    (globalThis as any).ztoolkit = { log: (...args: any[]) => Zotero.debug(args.map(String).join(" ")) };
    vector = getVectorStore();
    originalVector = {
      db: vector.db, dbPath: vector.dbPath, initialized: vector.initialized,
      initPromise: vector.initPromise, gpuBackend: vector.gpuBackend,
      vectorCache: vector.vectorCache, keywordStore: vector.keywordStore,
    };
    const vectorPath = PathUtils.join(Zotero.DataDirectory.dir, `round3-fulltext-vector-${Date.now()}.sqlite`);
    vectorDB = new Zotero.DBConnection(vectorPath);
    vector.db = vectorDB;
    vector.dbPath = vectorPath;
    vector.initialized = false;
    vector.initPromise = null;
    vector.vectorCache = new Map();
    vector.keywordStore = null;
    vector.gpuBackend = { registerProvider() {}, isEnabled: () => false, publishMutation: async () => {}, fallback() {} };
    await vector.createTables();
    vector.initialized = true;
    db = new Zotero.DBConnection(PathUtils.join(Zotero.DataDirectory.dir, `round3-fulltext-${Date.now()}.sqlite`));
    store = new WikiStore(db, vector);
    await store.initialize();
    sessions = await store.readingSessions();
    service = new WikiService(store);
    service.pumpEmbeddingQueue = async () => undefined;
    service.links.onPaperRead = async () => undefined;
    const embedding = getEmbeddingService();
    originalEmbed = embedding.embed;
    originalGetConfig = embedding.getConfig;
    embedding.getConfig = () => ({ model: identity.model }) as any;
    embedding.embed = async () => ({ embedding: new Float32Array([1, 0]), identity }) as any;
  });

  afterEach(async function () {
    const test = this.currentTest as any;
    outcomes.push({ title: test.title, state: test.state, observed,
      error: test.err ? String(test.err) : null, stack: test.err?.stack });
    await IOUtils.writeUTF8(PathUtils.join(Zotero.DataDirectory.dir, "round3-fulltext-results.json"), JSON.stringify(outcomes, null, 2));
    getEmbeddingService().embed = originalEmbed;
    getEmbeddingService().getConfig = originalGetConfig;
    await store.close();
    await vectorDB.closeDatabase();
    Object.assign(vector, originalVector);
  });

  function diagnostic(title: string, work: () => Promise<void>) {
    it(title, async function () {
      try { await work(); }
      catch (error) {
        observed.caughtError = { message: String(error), stack: (error as any)?.stack, originalError: String((error as any)?.originalError ?? "") };
        throw error;
      }
    });
  }

  function record(indexes: number[]) {
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
  function summary() {
    return [
      "## 本篇讲了什么", "这篇论文讨论定向凝固，关注站位序列上的组织演变。因此它的结论也按站位顺序给出。", "",
      "## 研究对象与材料", "合成夹具，未给出材料牌号，所以材料特征无从判断。样品范围同样只能按站位编号描述。", "",
      "## 核心方法", "论文以定向凝固站位序列作为核心研究方法（chunk 0）。", "",
      "## 主要结果", "夹具未给出结果数据，因此没有可比较的测量值。趋势只能从站位序列本身推断。", "",
      "## 机理解释", "夹具未给出机理，因果链留待原文补充。可以确定的只有站位之间的先后关系。", "",
      "## 结论", "夹具未给出结论，因此这一节不作断言。贡献部分同样只能留空。", "",
      "## 边界与局限", "作者未讨论适用范围，也没有给出对照。因此边界只能视为未知。",
    ].join("\n");
  }
  const axes = {
    pages: "The existing thematic Page already covers the processing subject without another Page.",
    claims: "The paper was reviewed against every existing Claim, and each finding is explicitly recorded below.",
    evidence: "Each existing quotation was checked against the actual indexed text and reading ledger.",
    concepts: "The paper uses familiar terminology and introduces no independent concept requiring a new entry.",
    relations: "The source establishes no additional relation between concepts already held in the Wiki.",
  };

  async function open(title: string, texts: string[], limit: number) {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = libraryID;
    item.setField("title", title);
    item.setField("abstractNote", "Directional solidification of columnar arrays.");
    await item.saveTx();
    await getVectorStore().replaceItemIndex({
      itemKey: item.key, libraryID,
      records: texts.map((chunkText, chunkId) => ({ itemKey: item.key, libraryID, chunkId, chunkText, vector: new Float32Array([1, 0]), language: "en", identity })),
      contentHash: await hashWikiText(texts.join("\n")),
      contentLength: texts.reduce((total, text) => total + text.length, 0),
      sourceKind: "body", itemModified: "round3", attachmentModified: "round3", bodyRetrySignature: "round3-parser",
    });
    await vector.setChunkSignature(item.key, "round3-chunker", libraryID);
    observed.itemKey = item.key;
    const indexed = await vector.getIndexStatus(item.key, libraryID);
    observed.indexFixture = { sourceKind: indexed?.sourceKind, chunkCount: indexed?.chunkCount };
    assert.equal(indexed?.sourceKind, "body", "The runtime fixture must have a confirmed body index.");
    assert.equal(indexed?.chunkCount, texts.length, "The runtime fixture must persist every source chunk.");
    const briefing = await service.buildFromPaper({ libraryID, userRequested: true, itemKey: item.key, limit });
    await service.setReadingExpert({ libraryID, itemKey: item.key,
      persona: "A solidification metallurgist who evaluates columnar grain array processing and the conditions under which the columnar band collapses.",
      focus: ["the process chain and its parameters", "the criterion for the columnar-to-equiaxed transition"],
    });
    const page = await service.buildFromPaper({ libraryID, userRequested: true, itemKey: item.key, limit });
    return { item, sessionId: briefing.readingSession.sessionId, page };
  }
  async function finalPass(itemKey: string) {
    const synthesis = await service.updateReadingNote({ libraryID, itemKey, finalSynthesis: true, macroSummary: summary() });
    await service.recordConcepts({ libraryID, itemKey, final: true, concepts: [], noConceptsReason: "This controlled paper introduces no terminology beyond the established processing field." });
    return synthesis;
  }

  diagnostic("a partial fulltext record must not silently integrate every delivered passage", async () => {
    const { item, sessionId, page } = await open("Round 3 partial fulltext integration", [source, "The sample fractures at a tensile stress of 120 MPa.", "Rapid cooling produced severe cracks and invalidated the proposed processing route.", source], 3);
    let rejected: string | null = null;
    try {
      await service.updateReadingNote({ libraryID, itemKey: item.key, readChunkIds: [0], readingRecord: record([0]) });
    } catch (error) { rejected = String(error); }
    const current = await sessions.get(sessionId);
    const pending = await sessions.pendingIntegrationIndexes(sessionId);
    const note = await service.getReadingNote({ libraryID, itemKey: item.key });
    let next: any;
    try { next = await service.buildFromPaper({ libraryID, userRequested: true, cursor: page.pagination.nextCursor }); }
    catch (error) { next = { error: String(error) }; }
    observed = { ...observed, rejected, delivered: page.chunks, integratedChunks: current.integratedChunks, pendingIntegration: pending, note, next };
    assert.isTrue(Boolean(rejected) || (current.integratedChunks === 1 && pending.includes(1) && pending.includes(2)), "Omitted chunks must be rejected or remain unintegrated; they cannot be silently marked complete.");
  });

  diagnostic("the final synthesis must not close a paper whose final page has no reading record", async () => {
    const { item, sessionId, page } = await open("Round 3 omitted final page", [source, "The sample fractures at a tensile stress of 120 MPa, which invalidates the proposed processing route."], 1);
    await service.updateReadingNote({ libraryID, itemKey: item.key, readingRecord: record([0]) });
    await service.buildFromPaper({ libraryID, userRequested: true, cursor: page.pagination.nextCursor });
    const before = await sessions.get(sessionId);
    let rejected: string | null = null;
    let result: any;
    try { result = await finalPass(item.key); }
    catch (error) { rejected = String(error); }
    const after = await sessions.get(sessionId);
    const pending = await sessions.pendingIntegrationIndexes(sessionId);
    let committed: any;
    if (!rejected) {
      const prepared = await service.prepareUpdate({ libraryID, itemKey: item.key, query: "Station processing", wikiReview: { ...axes, claimVerdicts: [] } });
      committed = await service.commit({ libraryID, userInitiated: true, operationId: `last-page-${item.key}`, prepareToken: prepared.prepareToken, readingSessionId: sessionId, actions: [{ action: "SKIP", itemKey: item.key, chunkIds: [0, 1], reason: "The supplied station-processing descriptions repeat the same method without a parameter, contrast, measurement, or separate result to add to the thematic Wiki." }] });
    }
    observed = { ...observed, rejected, before, after, pendingIntegration: pending, synthesisAccepted: result?.integrated, committed, note: await service.getReadingNote({ libraryID, itemKey: item.key }) };
    assert.isTrue(Boolean(rejected), "A final page still pending note integration must block final synthesis.");
  });

  diagnostic("an unsupported review must not leave its only Claim supported and normally retrievable", async () => {
    const { item, sessionId } = await open("Round 3 unsupported Claim reconciliation", [source], 1);
    await service.updateReadingNote({ libraryID, itemKey: item.key, readingRecord: record([0]) });
    const status = await getVectorStore().getIndexStatus(item.key, libraryID);
    const seeded = await store.commit({ libraryID, userInitiated: true, actions: [
      { action: "CREATE_PAGE", ref: "p", canonicalTitle: "Station processing" },
      { action: "ADD_CLAIM", ref: "c", pageId: "p", claimText: "Directional solidification guarantees every station has superior mechanical strength.", claimType: "mechanism", epistemicStatus: "supported", coverageLevel: "chunk_local", confidence: 0.9, evidence: [{ libraryID, itemKey: item.key, chunkIdSnapshot: 0, chunkTextHash: await hashWikiText(source), sourceContentHash: status?.contentHash ?? "", sourceChunkSignature: status?.chunkSignature ?? "round3-chunker", sourceResetGeneration: (await getVectorStore().getCommittedResetGeneration()) || "none", excerpt: source, evidenceRole: "SUPPORTS", readDepth: "chunk_local" }] },
    ] });
    const claimId = seeded.refs.c;
    observed.seedBeforeReverify = await store.getClaim(claimId);
    observed.seedReverification = await service.reverify(libraryID, [item.key]);
    const readyClaim = await store.getClaim(claimId);
    observed.seedReadyForReview = readyClaim;
    assert.equal(readyClaim?.epistemicStatus, "supported", "The review fixture must start with a supported Claim after real source reverification.");
    assert.equal(readyClaim?.evidence.length, 1, "The review fixture must have only one source of support.");
    assert.equal(readyClaim?.evidence[0].linkState, "valid", "The review fixture must have valid current source evidence before review.");
    await finalPass(item.key);
    const prepared = await service.prepareUpdate({ libraryID, itemKey: item.key, query: "Station processing", wikiReview: { ...axes, claimVerdicts: [{ claimId, verdict: "unsupported", basis: "The complete paper describes processing stations but never measures mechanical strength, so this claim has no evidentiary support." }] } });
    let rejected: string | null = null;
    let committed: any;
    try {
      committed = await service.commit({ libraryID, userInitiated: true, operationId: `unsupported-${item.key}`, prepareToken: prepared.prepareToken, readingSessionId: sessionId, actions: [{ action: "SKIP", itemKey: item.key, chunkIds: [0], reason: "This passage repeats the station-processing description already quoted in the existing thematic Page, without adding another parameter or observation." }] });
    } catch (error) { rejected = String(error); }
    const claim = await store.getClaim(claimId);
    const result = await service.search({ libraryID, query: "mechanical strength", useVector: false });
    observed = { ...observed, rejected, committed, claim, retrieval: result.claims, review: prepared.wikiReconciliation };
    assert.isTrue(Boolean(rejected) || claim?.epistemicStatus !== "supported", "A sole-source Claim explicitly found unsupported must require reconciliation or lose supported status.");
  });
});
