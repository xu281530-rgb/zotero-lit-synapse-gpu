import { WikiStore } from "../src/modules/wiki/wikiStore";
import { WikiService } from "../src/modules/wiki/wikiService";
import {
  WikiReadingNoteStore,
  parseReadingNote,
} from "../src/modules/wiki/wikiReadingNote";
import { getVectorStore } from "../src/modules/semantic/vectorStore";

describe("Round 2 receipt recovery in real Zotero", function () {
  this.timeout(30000);
  let db: any;
  let store: WikiStore;
  let dbPath: string;
  let libraryID: number;
  const outcomes: any[] = [];

  beforeEach(async function () {
    libraryID = Zotero.Libraries.userLibraryID;
    dbPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      `round2-receipts-${Date.now()}.sqlite`,
    );
    db = new Zotero.DBConnection(dbPath);
    store = new WikiStore(db);
    await store.initialize();
  });

  afterEach(async function () {
    const test = this.currentTest as any;
    outcomes.push({
      title: test.title,
      state: test.state,
      error: test.err ? String(test.err) : null,
    });
    await IOUtils.writeUTF8(
      PathUtils.join(Zotero.DataDirectory.dir, "round2-receipts-results.json"),
      JSON.stringify(outcomes, null, 2),
    );
    await store.close();
  });

  const serviceFor = (target: WikiStore): any => {
    const service = new WikiService(target);
    (service as any).pumpEmbeddingQueue = async () => undefined;
    return service;
  };
  const reopen = async (): Promise<any> => {
    await store.close();
    db = new Zotero.DBConnection(dbPath);
    store = new WikiStore(db);
    await store.initialize();
    return serviceFor(store);
  };
  const paper = async (title: string): Promise<any> => {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = libraryID;
    item.setField("title", title);
    await item.saveTx();
    return item;
  };

  it("R04 retries the saved attachment on disk while a new fulltext session stays open", async function () {
    const oldPaper = await paper("Round 2 old reading");
    const newPaper = await paper("Round 2 new reading");
    const notes = new WikiReadingNoteStore();
    const oldNote = await notes.ensureAttachment(
      oldPaper,
      "Original old reading body.",
    );
    const laterEpisode = await notes.createNextAttachment(
      oldPaper,
      "A later note episode must remain unchanged.",
    );
    const newNote = await notes.ensureAttachment(
      newPaper,
      "New paper reading body.",
    );
    const sessions = await store.readingSessions();
    const old = await sessions.startOrContinue({
      libraryID,
      itemKey: oldPaper.key,
      title: "Old paper",
      totalChunks: 1,
      sourceVersion: await getVectorStore().getDocumentRevision(
        oldPaper.key,
        libraryID,
      ),
      mode: "fulltext",
    });
    await sessions.setNoteKey(old.sessionId, oldNote.key);
    await db.queryAsync(
      "UPDATE wiki_reading_sessions SET final_synthesis_at = 1, concepts_recorded_at = 1, wiki_review_at = 1 WHERE session_id = ?",
      [old.sessionId],
    );
    await db.queryAsync(
      "INSERT INTO wiki_reading_chunks (session_id, chunk_index, chunk_id, delivered_at) VALUES (?, 0, 22, 1)",
      [old.sessionId],
    );
    const initial = serviceFor(store);
    initial.notes.write = async () => {
      throw new Error("Injected temporary note file failure");
    };
    const committed = await initial.commit({
      libraryID,
      userInitiated: true,
      operationId: "round2-real-old-note",
      readingSessionId: old.sessionId,
      actions: [
        {
          action: "SKIP",
          reason: "All previously written evidence is already accounted for.",
        },
      ],
    });
    assert.equal(committed.committed, true);
    assert.equal(
      committed.postprocessing.steps["reading session"].state,
      "pending",
    );
    const newer = await sessions.startOrContinue({
      libraryID,
      itemKey: newPaper.key,
      title: "New paper",
      totalChunks: 2,
      sourceVersion: await getVectorStore().getDocumentRevision(
        newPaper.key,
        libraryID,
      ),
      mode: "fulltext",
    });
    await sessions.setNoteKey(newer.sessionId, newNote.key);
    const restarted = await reopen();
    const recovered = await restarted.commit({
      libraryID,
      userInitiated: true,
      operationId: committed.operationId,
      resume: true,
      actions: [],
    });
    assert.equal(recovered.postprocessing.state, "completed");
    assert.equal(recovered.readingSession.itemKey, oldPaper.key);
    assert.equal(
      recovered.readingSession.noteStatusWrite.attachmentKey,
      oldNote.key,
    );
    const written = parseReadingNote((await notes.read(oldNote))!);
    assert.equal(written.metadata?.status, "completed");
    assert.include(written.body, "Original old reading body.");
    assert.equal(
      await notes.read(laterEpisode),
      "A later note episode must remain unchanged.",
    );
    assert.equal(await notes.read(newNote), "New paper reading body.");
    assert.equal(
      (await (await store.readingSessions()).getOpen(libraryID))?.sessionId,
      newer.sessionId,
    );
    assert.equal(
      (await restarted.commitStatus(libraryID, committed.operationId)).status,
      "completed",
    );
  });

  it("R05 resumes legacy pending link work after an unrelated reading version changes", async function () {
    const sessions = await store.readingSessions();
    const unrelated = await sessions.startOrContinue({
      libraryID,
      itemKey: "R2UNRELA",
      title: "Unrelated",
      totalChunks: 1,
      sourceVersion: "old",
      mode: "qa",
    });
    const initial = serviceFor(store);
    initial.prepareTokens.set("round2-token", {
      libraryID,
      expiresAt: Date.now() + 60000,
      preparedPageTitles: new Set(["round 2 recovery"]),
    });
    initial.settleLinkSignals = async () => {
      throw new Error("Injected temporary link failure");
    };
    const committed = await initial.commit({
      libraryID,
      userInitiated: true,
      operationId: "round2-real-unrelated",
      prepareToken: "round2-token",
      actions: [{ action: "CREATE_PAGE", canonicalTitle: "Round 2 recovery" }],
    });
    const receipt = await store.getCommitOperation(
      libraryID,
      committed.operationId,
    );
    receipt.payload.sessions = [
      {
        sessionId: unrelated.sessionId,
        itemKey: unrelated.itemKey,
        sourceVersion: "old",
      },
    ];
    delete receipt.payload.dependencies;
    await db.queryAsync(
      "UPDATE wiki_commit_operations SET payload_json = ? WHERE library_id = ? AND operation_id = ?",
      [JSON.stringify(receipt.payload), libraryID, committed.operationId],
    );
    await sessions.startOrContinue({
      libraryID,
      itemKey: unrelated.itemKey,
      title: "Unrelated",
      totalChunks: 1,
      sourceVersion: "new",
      mode: "qa",
    });
    const restarted = await reopen();
    const recovered = await restarted.commit({
      libraryID,
      userInitiated: true,
      operationId: committed.operationId,
      resume: true,
      actions: [],
    });
    assert.equal(recovered.postprocessing.state, "completed");
    assert.equal(
      (await store.listPageTitles(libraryID)).filter(
        (entry: any) => entry.title === "Round 2 recovery",
      ).length,
      1,
    );
    assert.equal(
      (await (await store.readingSessions()).get(unrelated.sessionId))
        ?.sourceVersion,
      "new",
    );
  });

  it("R05 supersedes obsolete reading work when the index changes before the session refreshes", async function () {
    const vectors = getVectorStore();
    const itemKey = "R2RECEIP";
    const write = (text: string) =>
      vectors.replaceItemIndex({
        itemKey,
        libraryID,
        contentHash: text,
        contentLength: text.length,
        sourceKind: "pdf",
        records: [
          {
            itemKey,
            libraryID,
            chunkId: 22,
            chunkText: text,
            language: "en",
            vector: new Float32Array([1, 0]),
          },
        ],
      });
    await write("Original receipt test content.");
    const sourceVersion = await vectors.getDocumentRevision(itemKey, libraryID);
    const sessions = await store.readingSessions();
    const old = await sessions.startOrContinue({
      libraryID,
      itemKey,
      title: "Receipt source",
      totalChunks: 1,
      sourceVersion,
      mode: "fulltext",
    });
    await db.queryAsync(
      "INSERT INTO wiki_reading_chunks (session_id, chunk_index, chunk_id, delivered_at, owes_wiki) VALUES (?, 0, 22, 1, 1)",
      [old.sessionId],
    );
    const initial = serviceFor(store);
    initial.settleReadingSession = async () => {
      throw new Error("Injected temporary reading failure");
    };
    initial.settleLinkSignals = async () => {
      throw new Error("Injected temporary link failure");
    };
    const committed = await initial.commit({
      libraryID,
      userInitiated: true,
      operationId: "round2-real-changed",
      readingSessionId: old.sessionId,
      actions: [
        {
          action: "SKIP",
          reason:
            "Previously recorded evidence is retained without rewriting knowledge.",
        },
      ],
    });
    await write("Changed receipt test content.");
    assert.equal(
      (await sessions.get(old.sessionId))?.sourceVersion,
      sourceVersion,
    );
    const restarted = await reopen();
    const recovered = await restarted.commit({
      libraryID,
      userInitiated: true,
      operationId: committed.operationId,
      resume: true,
      actions: [],
    });
    assert.equal(
      recovered.postprocessing.steps["link settlement"].state,
      "completed",
    );
    assert.equal(
      recovered.postprocessing.steps["reading session"].state,
      "superseded",
    );
    assert.equal(recovered.postprocessing.state, "needs_review");
    assert.equal(
      (await restarted.commitStatus(libraryID, committed.operationId)).status,
      "postprocessing_needs_review",
    );
    const final = await reopen();
    const again = await final.commit({
      libraryID,
      userInitiated: true,
      operationId: committed.operationId,
      resume: true,
      actions: [],
    });
    assert.equal(again.postprocessing.state, "needs_review");
    assert.equal(
      (await (await store.readingSessions()).pendingWikiChunks(old.sessionId))
        .length,
      1,
    );
  });
});
