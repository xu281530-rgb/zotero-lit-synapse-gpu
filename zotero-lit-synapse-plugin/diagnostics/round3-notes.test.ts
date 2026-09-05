import { WikiStore } from "../src/modules/wiki/wikiStore";
import { WikiService } from "../src/modules/wiki/wikiService";
import {
  WikiReadingNoteStore,
  parseReadingNote,
  parseAppendOnlyReadingNote,
  appendReadingRecord,
  appendMacroSummary,
} from "../src/modules/wiki/wikiReadingNote";
import {
  getVectorStore,
  VectorStore,
} from "../src/modules/semantic/vectorStore";
import { getEmbeddingService } from "../src/modules/semantic/embeddingService";

describe("Round 3 actual Zotero note lifecycle diagnostics", function () {
  this.timeout(30000);
  let db: any;
  let store: WikiStore;
  let libraryID: number;
  let vectorDB: any;
  let sharedVector: any;
  let vectorState: PropertyDescriptorMap | undefined;
  const observations: any[] = [];
  const notes = new WikiReadingNoteStore();
  const firstRecord =
    "The thermal gradient controls the orientation of the grain array (chunk 0).";
  const secondRecord =
    "The solidified array follows the imposed gradient direction (chunk 1).";
  const thirdRecord =
    "The imposed thermal direction aligns the observed grain array (chunk 2).";
  const summary =
    "Grain orientation responds to the thermal conditions imposed during solidification (chunk 0).";
  const body = (record = firstRecord) =>
    appendReadingRecord("", { chunkIds: [0], content: record });

  const save = async () =>
    IOUtils.writeUTF8(
      PathUtils.join(Zotero.DataDirectory.dir, "round3-notes-results.json"),
      JSON.stringify(
        {
          environment:
            "Actual isolated Zotero, native SQLite, real attachment files; controlled embedding response and explicitly reported failure/scheduling injection",
          observations,
        },
        null,
        2,
      ),
    );
  const observe = async (scenario: string, facts: any) => {
    observations.push({ scenario, ...facts });
    await save();
  };
  const makeService = (): any => {
    const service: any = new WikiService(store);
    service.pumpEmbeddingQueue = async () => undefined;
    service.links.onPaperRead = async () => undefined;
    return service;
  };
  const createPaper = async (title: string, count = 2): Promise<any> => {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = libraryID;
    item.setField("title", title);
    await item.saveTx();
    await getVectorStore().replaceItemIndex({
      libraryID,
      itemKey: item.key,
      contentHash: `round3-${item.key}`,
      contentLength: count * 90,
      sourceKind: "body",
      records: Array.from({ length: count }, (_, chunkId) => ({
        libraryID,
        itemKey: item.key,
        chunkId,
        chunkText:
          "The imposed thermal gradient controls the orientation of the solidified grain array.",
        language: "en",
        vector: new Float32Array([1, 0]),
      })),
    });
    return item;
  };
  const createSession = async (
    item: any,
    count = 2,
    mode: "qa" | "fulltext" = "qa",
  ) =>
    (await store.readingSessions()).startOrContinue({
      libraryID,
      itemKey: item.key,
      title: item.getField("title"),
      totalChunks: count,
      sourceVersion: await getVectorStore().getDocumentRevision(
        item.key,
        libraryID,
      ),
      mode,
    });
  const capture = async (work: () => Promise<any>) => {
    try {
      return { value: await work(), error: null };
    } catch (error) {
      return {
        value: null,
        error: String(error),
        originalError: String((error as any)?.originalError ?? ""),
      };
    }
  };

  beforeEach(async function () {
    libraryID = Zotero.Libraries.userLibraryID;
    (globalThis as any).ztoolkit = {
      log: (...args: any[]) => Zotero.debug(args.map(String).join(" ")),
    };
    db = new Zotero.DBConnection(
      PathUtils.join(
        Zotero.DataDirectory.dir,
        `round3-notes-${Date.now()}.sqlite`,
      ),
    );
    try {
      vectorDB = new Zotero.DBConnection(
        PathUtils.join(
          Zotero.DataDirectory.dir,
          `round3-note-vectors-${Date.now()}.sqlite`,
        ),
      );
      const dedicated: any = new VectorStore({
        registerProvider() {},
        isEnabled: () => false,
        publishMutation: async () => {},
        fallback() {},
      } as any);
      dedicated.db = vectorDB;
      // createTables installs the real version triggers; no plugin preference-based connection is opened.
      await dedicated.createTables();
      dedicated.initialized = true;
      sharedVector = getVectorStore();
      vectorState = Object.getOwnPropertyDescriptors(sharedVector);
      Object.assign(sharedVector, dedicated);
      store = new WikiStore(db, sharedVector);
      await store.initialize();
    } catch (error) {
      await observe("fixture_initialization", {
        error: String(error),
        originalError: String((error as any)?.originalError ?? ""),
      });
      throw error;
    }
  });

  afterEach(async function () {
    const current = this.currentTest as any;
    observations.push({
      test: current.title,
      state: current.state,
      error: current.err ? String(current.err) : null,
      originalError: String(current.err?.originalError ?? ""),
    });
    await save();
    await store?.close();
    if (vectorState) {
      Object.defineProperties(sharedVector, vectorState);
      vectorState = undefined;
    }
    await vectorDB?.closeDatabase();
  });

  it("must preserve a concluded note when a duplicate record is skipped", async function () {
    const item = await createPaper("Round 3 duplicate suppression", 1);
    const originalBody = appendMacroSummary(body(), summary);
    const attachment = await notes.ensureAttachment(item, originalBody);
    const sessions = await store.readingSessions();
    const prior = await createSession(item, 1, "fulltext");
    await sessions.setNoteKey(prior.sessionId, attachment.key);
    await db.queryAsync(
      "INSERT INTO wiki_reading_chunks (session_id, chunk_index, chunk_id, delivered_at, integrated_at) VALUES (?, 0, 0, 1, 1)",
      [prior.sessionId],
    );
    await db.queryAsync(
      "UPDATE wiki_reading_sessions SET final_synthesis_at = 1, concepts_recorded_at = 1, wiki_review_at = 1 WHERE session_id = ?",
      [prior.sessionId],
    );
    await sessions.close(prior.sessionId, "committed");
    const embedding: any = getEmbeddingService();
    const embed = embedding.embed;
    let calls = 0;
    embedding.embed = async () => {
      calls++;
      return {
        embedding: new Float32Array([1, 0]),
        identity: {
          model: "round3",
          apiBase: "controlled-local",
          provider: "openai",
          dimensions: 2,
        },
      };
    };
    let response: any;
    try {
      response = await capture(() =>
        makeService().updateReadingNote({
          libraryID,
          itemKey: item.key,
          readChunkIds: [0],
          readingRecord: firstRecord,
        }),
      );
    } finally {
      embedding.embed = embed;
    }
    const after = parseReadingNote((await notes.read(attachment))!);
    await observe("duplicate_skip", {
      itemKey: item.key,
      attachmentKey: attachment.key,
      response,
      controlledEmbeddingCalls: calls,
      priorSessionState: (await sessions.get(prior.sessionId))?.state,
      beforeBodyChars: originalBody.length,
      afterBodyChars: after.body.length,
      summaryRetained: after.body.includes(summary),
      diskStatus: after.metadata?.status,
    });
    assert.isNull(response.error);
    assert.equal(
      after.body,
      originalBody,
      "Skipping an incoming duplicate must leave existing note content intact",
    );
  });

  it("must keep another episode unchanged after appending to an older open note", async function () {
    const item = await createPaper("Round 3 attachment routing");
    const older = await notes.ensureAttachment(item, body());
    const latestBody = appendMacroSummary(
      body(
        "A separate interpretation is recorded in the later episode (chunk 0).",
      ),
      summary,
    );
    const latest = await notes.createNextAttachment(item, latestBody);
    const response = await capture(() =>
      makeService().updateReadingNote({
        libraryID,
        itemKey: item.key,
        readChunkIds: [1],
        readingRecord: secondRecord,
      }),
    );
    const afterOlder = parseReadingNote((await notes.read(older))!).body;
    const afterLatest = parseReadingNote((await notes.read(latest))!).body;
    const session = await (
      await store.readingSessions()
    ).openForItem(libraryID, item.key);
    await observe("older_episode", {
      itemKey: item.key,
      olderAttachmentKey: older.key,
      latestAttachmentKey: latest.key,
      response,
      finalSessionTarget: session?.noteKey,
      latestUnchanged: afterLatest === latestBody,
      latestEqualsOlder: afterLatest === afterOlder,
      latestSummaryRetained: afterLatest.includes(summary),
    });
    assert.isNull(response.error);
    assert.equal(
      afterLatest,
      latestBody,
      "Header refresh must keep the attachment chosen for the actual append",
    );
  });

  it("must retain both successfully submitted records when appends overlap", async function () {
    const item = await createPaper("Round 3 concurrent appends", 3);
    const attachment = await notes.ensureAttachment(item, body());
    const sessions = await store.readingSessions();
    const session = await createSession(item, 3);
    await sessions.setNoteKey(session.sessionId, attachment.key);
    await db.queryAsync(
      "INSERT INTO wiki_reading_chunks (session_id, chunk_index, chunk_id, delivered_at, integrated_at) VALUES (?, 0, 0, 1, 1)",
      [session.sessionId],
    );
    const service = makeService();
    const write = service.notes.write.bind(service.notes);
    let waiting = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = Promise.resolve();
    // Hold the first two saves until both callers prepared their append, then use real file writes.
    service.notes.write = async (...args: any[]) => {
      waiting++;
      if (waiting <= 2) {
        if (waiting === 2) release();
        await ready;
      }
      const saved = writes.then(() => write(...args));
      writes = saved.catch(() => undefined);
      return saved;
    };
    const responses = await Promise.all([
      capture(() =>
        service.updateReadingNote({
          libraryID,
          itemKey: item.key,
          readChunkIds: [1],
          readingRecord: secondRecord,
        }),
      ),
      capture(() =>
        service.updateReadingNote({
          libraryID,
          itemKey: item.key,
          readChunkIds: [2],
          readingRecord: thirdRecord,
        }),
      ),
    ]);
    const finalBody = parseReadingNote((await notes.read(attachment))!).body;
    const parsed = parseAppendOnlyReadingNote(finalBody);
    const coverage = await sessions.coverage(session.sessionId);
    await observe("concurrent_append", {
      itemKey: item.key,
      responses,
      ledgerDeliveredChunks: coverage.deliveredChunks,
      persistedRecordCount: parsed.records.length,
      expectedRecordCount: 3,
      firstNewRecordRetained: finalBody.includes(secondRecord),
      secondNewRecordRetained: finalBody.includes(thirdRecord),
    });
    assert.isTrue(
      finalBody.includes(secondRecord) && finalBody.includes(thirdRecord),
      "Both successful append contents must survive",
    );
    assert.equal(parsed.records.length, 3);
  });

  it("must resume summary bookkeeping after the file saved but the ledger failed", async function () {
    const item = await createPaper("Round 3 summary recovery", 1);
    const attachment = await notes.ensureAttachment(item, body());
    const session = await createSession(item, 1);
    const sessions = await store.readingSessions();
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
    const integration = sessions.recordIntegration;
    sessions.recordIntegration = async () => {
      throw new Error("Injected database failure after summary file write");
    };
    const options = {
      libraryID,
      itemKey: item.key,
      finalSynthesis: true,
      macroSummary: summary,
    };
    let first: any;
    try {
      first = await capture(() => makeService().updateReadingNote(options));
    } finally {
      sessions.recordIntegration = integration;
    }
    const retry = await capture(() => makeService().updateReadingNote(options));
    const finalSynthesisAt = (await sessions.get(session.sessionId))
      ?.finalSynthesisAt;
    await observe("summary_ledger_failure", {
      itemKey: item.key,
      first,
      retry,
      finalSynthesisAt,
      summaryOnDisk:
        parseAppendOnlyReadingNote(
          parseReadingNote((await notes.read(attachment))!).body,
        ).macroSummary !== null,
    });
    assert.isNull(
      retry.error,
      "The saved summary must support retrying its pending bookkeeping",
    );
    assert.isNotNull(finalSynthesisAt);
  });

  it("must preserve old note content when expert reset cannot read the attachment", async function () {
    const item = await createPaper("Round 3 expert reset read failure");
    const originalBody = body();
    const attachment = await notes.ensureAttachment(item, originalBody);
    const session = await createSession(item);
    const sessions = await store.readingSessions();
    await sessions.setNoteKey(session.sessionId, attachment.key);
    await sessions.setExpert(session.sessionId, {
      persona: "A temporary expert",
      focus: ["thermal gradient"],
      openScopeMandate: "all content",
      createdAt: Date.now(),
      provisional: true,
    });
    const service = makeService();
    const read = service.notes.read.bind(service.notes);
    let failures = 0;
    service.notes.read = async (...args: any[]) => {
      if (failures === 0) {
        failures++;
        return null;
      }
      return read(...args);
    };
    const response = await capture(() =>
      service.setReadingExpert({
        libraryID,
        itemKey: item.key,
        persona:
          "A materials scientist who studies thermal gradients and the orientation of directionally solidified grains.",
        focus: ["thermal gradient", "grain orientation"],
      }),
    );
    const after = parseReadingNote((await notes.read(attachment))!).body;
    await observe("expert_read_failure", {
      itemKey: item.key,
      response,
      injectedReadFailures: failures,
      beforeBodyChars: originalBody.length,
      afterBodyChars: after.length,
      contentUnchanged: after === originalBody,
    });
    assert.equal(
      after,
      originalBody,
      "An unreadable existing note must never become an empty successful write",
    );
  });

  it("must retry terminal note status after finishing a reading session", async function () {
    const item = await createPaper("Round 3 finish reading recovery");
    const session = await createSession(item);
    const initial = makeService();
    const written = await initial.writeNote(item, session, body(), "reading");
    const attachment = await notes.getByKey(libraryID, written.attachmentKey);
    initial.notes.write = async () => {
      throw new Error("Injected terminal note status write failure");
    };
    const options = {
      libraryID,
      itemKey: item.key,
      outcome: "skipped",
      note: "The relevant reading is already covered by the existing Wiki.",
    };
    const first = await capture(() => initial.finishReading(options));
    const retry = await capture(() => makeService().finishReading(options));
    const diskStatus = parseReadingNote((await notes.read(attachment))!)
      .metadata?.status;
    const state = (await (await store.readingSessions()).get(session.sessionId))
      ?.state;
    await observe("finish_status_failure", {
      itemKey: item.key,
      first,
      retry,
      sessionState: state,
      diskStatus,
    });
    assert.equal(
      diskStatus,
      "skipped",
      "A retry must complete the note status for the session already closed",
    );
  });
});
