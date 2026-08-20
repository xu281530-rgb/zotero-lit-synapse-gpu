/* eslint-env node */

/**
 * The "read one paper, write it up, move to the next" loop, end to end.
 *
 * Four defects made a real batch run fail: a whole 181-chunk paper came back in
 * one response and the client could not process it; `wiki_commit` waited on the
 * embedding service and blew a client deadline AFTER the database had already
 * committed; nothing stopped the model from opening paper after paper without
 * writing any of them; and `paper_reviewed` was believed simply because the
 * model said it. Each block below is named for the defect it guards.
 *
 * The suite drives WikiService the way the MCP handlers do, against a real
 * SQLite database, with the embedding backend under test control so the
 * durability ordering can be proven rather than timed.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => undefined };

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { getVectorStore } = await import("../src/modules/semantic/vectorStore.ts");
const { getEmbeddingService } = await import(
  "../src/modules/semantic/embeddingService.ts"
);
const { MAX_DOCUMENT_CHUNKS_PER_PAGE } = await import(
  "../src/modules/documentChunks.ts"
);

// --- Fixtures -------------------------------------------------------------

/** Matches the largest real item in the reference library. */
const LONG_PAPER_CHUNKS = 181;

function makeChunks(itemKey, count) {
  return Array.from({ length: count }, (_, i) => ({
    chunkId: 1000 + i,
    text: `${itemKey} passage ${i}: directional solidification narrows the columnar band at gradient G${i}.`,
    language: "en",
  }));
}

const indexedChunks = new Map([
  ["LONGPAPR", makeChunks("LONGPAPR", LONG_PAPER_CHUNKS)],
  ["SHORTPPR", makeChunks("SHORTPPR", 3)],
  ["PAPERB01", makeChunks("PAPERB01", 12)],
]);

function adapt(sqlite) {
  let depth = 0;
  return {
    async queryAsync(sql, params = []) {
      const statement = sqlite.prepare(sql);
      const values = params.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) return statement.all(...values);
      statement.run(...values);
      return [];
    },
    async valueQueryAsync(sql, params = []) {
      const row = sqlite.prepare(sql).get(...params);
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(fn) {
      if (depth > 0) return fn();
      depth += 1;
      sqlite.exec("BEGIN");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
}

globalThis.Zotero.Items = {
  async getByLibraryAndKeyAsync(libraryID, itemKey) {
    if (libraryID !== 1 || !indexedChunks.has(itemKey)) return null;
    return {
      key: itemKey,
      deleted: false,
      isRegularItem: () => true,
      getField: (f) => (f === "title" ? `Paper ${itemKey}` : ""),
    };
  },
};

const vectorStore = getVectorStore();
vectorStore.initialize = async () => {};
vectorStore.getChunksForItem = async (k) => indexedChunks.get(k) ?? [];
vectorStore.getIndexStatus = async (k) => ({
  contentHash: `content-${k}`,
  sourceKind: "body",
});
vectorStore.getCommittedResetGeneration = async () => "reset-1";

/**
 * Embedding backend under test control.
 *
 * `prepareUpdate` embeds the QUERY (isQuery true) before any commit; only the
 * CLAIM embedding (isQuery false) is the post-commit work whose ordering these
 * tests are about, so only that path is instrumented.
 */
let embed = { mode: "ok" };
const embeddingService = getEmbeddingService();
embeddingService.getConfig = () => ({ model: "test-embed-model" });
embeddingService.embed = async (_text, _language, isQuery) => {
  if (isQuery) return { embedding: new Float32Array([1, 0]) };
  embed.onEnter?.();
  if (embed.mode === "throw") throw new Error("embedding backend is down");
  if (embed.mode === "hang") await embed.release;
  return { embedding: new Float32Array([1, 0]) };
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-loop-"));
const dbPath = path.join(tempDir, "wiki.sqlite");
let sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");
let store = new WikiStore(adapt(sqlite));
await store.initialize();
let service = new WikiService(store);

const count = (sql, ...p) => Number(sqlite.prepare(sql).get(...p).n);

/** Read a paper to the end, following the cursor. Returns every page. */
async function readToEnd(itemKey, limit = 20) {
  const pages = [];
  let page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey,
    limit,
  });
  pages.push(page);
  while (page.pagination.hasMore) {
    page = await service.buildFromPaper({
      libraryID: 1,
      userRequested: true,
      cursor: page.pagination.nextCursor,
    });
    pages.push(page);
  }
  return pages;
}

async function commitClaim(options) {
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: options.title,
    proposedPageTitles: [options.title],
  });
  return service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: prepared.prepareToken,
    actions: [
      { action: "CREATE_PAGE", ref: "p", canonicalTitle: options.title },
      {
        action: "ADD_CLAIM",
        ref: "c",
        pageId: "p",
        claimText: options.claimText,
        claimType: "mechanism",
        epistemicStatus: "provisional",
        coverageLevel: options.coverageLevel ?? "chunk_local",
        confidence: 0.7,
        evidence: [
          {
            libraryID: 1,
            itemKey: options.itemKey,
            excerpt: `${options.itemKey} passage 0`,
            evidenceRole: "SUPPORTS",
            readDepth: options.readDepth ?? "chunk_local",
          },
        ],
      },
    ],
  });
}

// =========================================================================
// 1. Paged full-text reading
// =========================================================================

{
  // The unpaginated escape hatch is gone, and says what to do instead.
  await assert.rejects(
    () =>
      service.buildFromPaper({
        libraryID: 1,
        userRequested: true,
        itemKey: "LONGPAPR",
        includeAllChunks: true,
      }),
    /includeAllChunks was removed[\s\S]*nextCursor/iu,
    "includeAllChunks must be refused with the paged replacement spelled out",
  );

  const first = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "LONGPAPR",
    limit: 999,
  });
  assert.equal(
    first.chunks.length,
    MAX_DOCUMENT_CHUNKS_PER_PAGE,
    "an absurd limit is clamped to the same ceiling get_document_chunks uses",
  );
  assert.equal(first.pagination.totalChunks, LONG_PAPER_CHUNKS);
  assert.equal(first.pagination.offset, 0);
  assert.equal(first.pagination.range, `1-${MAX_DOCUMENT_CHUNKS_PER_PAGE}`);
  assert.equal(first.pagination.hasMore, true);
  assert.ok(first.pagination.nextCursor, "a resumable cursor is returned");
  assert.equal(first.pagination.deliveredChunks, MAX_DOCUMENT_CHUNKS_PER_PAGE);
  assert.equal(
    first.pagination.remainingChunks,
    LONG_PAPER_CHUNKS - MAX_DOCUMENT_CHUNKS_PER_PAGE,
  );
  assert.equal(first.pagination.coverageComplete, false);
  assert.equal(first.pagination.firstMissingChunkIndex, MAX_DOCUMENT_CHUNKS_PER_PAGE);

  // Chunk indexes are absolute and contiguous across pages.
  const second = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    cursor: first.pagination.nextCursor,
  });
  assert.equal(second.pagination.servedFromCursor, true);
  assert.equal(second.chunks[0].chunkIndex, MAX_DOCUMENT_CHUNKS_PER_PAGE);
  assert.equal(second.target.itemKey, "LONGPAPR", "the cursor names its paper");

  // A cursor and a conflicting itemKey is two questions at once.
  await assert.rejects(
    () =>
      service.buildFromPaper({
        libraryID: 1,
        userRequested: true,
        itemKey: "SHORTPPR",
        cursor: first.pagination.nextCursor,
      }),
    /cursor continues LONGPAPR but itemKey says SHORTPPR/iu,
  );

  await service.finishReading({ libraryID: 1, outcome: "skipped" });
}

// A short paper must still be cheap: one call, done.
{
  const page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "SHORTPPR",
  });
  assert.equal(page.chunks.length, 3);
  assert.equal(page.pagination.hasMore, false, "3 chunks is a single page");
  assert.equal(page.pagination.nextCursor, undefined);
  assert.equal(
    page.pagination.coverageComplete,
    true,
    "and reading it once is full coverage",
  );
  await service.finishReading({ libraryID: 1, outcome: "skipped" });
}

// =========================================================================
// 2. Interrupted reading resumes across a restart
// =========================================================================

{
  let page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "LONGPAPR",
    limit: 20,
  });
  page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    cursor: page.pagination.nextCursor,
  });
  assert.equal(page.pagination.deliveredChunks, 40);
  const resumeCursor = page.pagination.nextCursor;

  // Simulate Zotero restarting: brand-new store and service on the same file.
  sqlite.close();
  sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON");
  store = new WikiStore(adapt(sqlite));
  await store.initialize();
  service = new WikiService(store);

  const afterRestart = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    cursor: resumeCursor,
  });
  assert.equal(
    afterRestart.pagination.deliveredChunks,
    60,
    "reading progress survives a restart and keeps accumulating",
  );
  assert.equal(afterRestart.readingSession.state, "reading");
  assert.equal(
    afterRestart.pagination.offset,
    40,
    "and resumes at the chunk after the last one delivered",
  );
}

// =========================================================================
// 3. paper_reviewed requires proven delivery
// =========================================================================

{
  // LONGPAPR is 60/181 read at this point.
  const partial = await commitClaim({
    title: "Partial read page",
    itemKey: "LONGPAPR",
    claimText: "A partially read paper cannot support whole-paper depth.",
    coverageLevel: "paper_reviewed",
    readDepth: "paper_reviewed",
  });
  const partialClaim = await store.getClaim(partial.refs["c"]);
  assert.equal(
    partialClaim.evidence[0].readDepth,
    "section_read",
    "paper_reviewed is downgraded when the server has not delivered the paper",
  );
  assert.notEqual(partialClaim.coverageLevel, "paper_reviewed");
  assert.ok(
    partial.warnings.some((w) => /60 of 181 chunks delivered/iu.test(w)),
    "and the caller is told exactly how much was actually delivered",
  );

  // Now read it to the end and the same claim shape is honoured.
  await readToEnd("LONGPAPR");
  const full = await commitClaim({
    title: "Full read page",
    itemKey: "LONGPAPR",
    claimText: "A fully delivered paper supports whole-paper depth.",
    coverageLevel: "paper_reviewed",
    readDepth: "paper_reviewed",
  });
  const fullClaim = await store.getClaim(full.refs["c"]);
  assert.equal(
    fullClaim.evidence[0].readDepth,
    "paper_reviewed",
    "once every chunk has been delivered, paper_reviewed is accepted",
  );
  assert.equal(fullClaim.coverageLevel, "paper_reviewed");
  assert.equal(
    full.warnings.filter((w) => /read_depth/iu.test(w)).length,
    0,
    "and there is nothing to warn about",
  );
}

// =========================================================================
// 3b. A partial commit is a checkpoint, NOT the end of the paper
// =========================================================================

{
  // Fresh session on a paper we will deliberately not finish.
  let page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "LONGPAPR",
    limit: 20,
  });
  for (let i = 0; i < 2; i += 1) {
    page = await service.buildFromPaper({
      libraryID: 1,
      userRequested: true,
      cursor: page.pagination.nextCursor,
    });
  }
  assert.equal(page.pagination.deliveredChunks, 60);
  assert.equal(page.pagination.coverageComplete, false);

  // Commit what has been read. This must SUCCEED - partial evidence is real
  // evidence and must not be held hostage to finishing the paper.
  const partial = await commitClaim({
    title: "Checkpoint page",
    itemKey: "LONGPAPR",
    claimText: "Evidence read so far is worth committing before the paper ends.",
  });
  assert.equal(partial.committed, true, "a partial commit must still commit");
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_pages WHERE canonical_title = ?",
      "Checkpoint page"),
    1,
    "and its page is durable",
  );

  // ...but it must NOT end the paper.
  assert.equal(
    partial.readingSession.released,
    false,
    "a partial commit must not release the library",
  );
  assert.equal(partial.readingSession.state, "reading");
  assert.equal(partial.readingSession.coverageComplete, false);
  assert.equal(partial.readingSession.deliveredChunks, 60);
  assert.equal(partial.readingSession.totalChunks, LONG_PAPER_CHUNKS);
  assert.match(
    partial.readingSession.note,
    /is NOT finished[\s\S]*60 of 181/iu,
    "and the caller is told the paper is still open and why",
  );

  const sessions = await store.readingSessions();
  const stillOpen = await sessions.getOpen(1);
  assert.ok(stillOpen, "the session is still open after a partial commit");
  assert.equal(stillOpen.itemKey, "LONGPAPR");
  assert.equal(
    stillOpen.state,
    "reading",
    "and it is back in `reading`, which is what should happen next",
  );

  // The whole point: the next paper is still blocked.
  await assert.rejects(
    () =>
      service.buildFromPaper({
        libraryID: 1,
        userRequested: true,
        itemKey: "PAPERB01",
      }),
    /Paper LONGPAPR is still open[\s\S]*60 of 181[\s\S]*wiki_finish_reading/iu,
    "a partial commit must not let the next paper start",
  );

  // Passing readingSessionId explicitly must not be a way around the rule.
  const forced = await service.commit({
    libraryID: 1,
    userInitiated: true,
    readingSessionId: stillOpen.sessionId,
    actions: [
      {
        action: "ADD_CLAIM",
        ref: "c2",
        pageId: partial.refs["p"],
        claimText: "Naming the session must not close an unfinished paper.",
        claimType: "limitation",
        epistemicStatus: "provisional",
        coverageLevel: "chunk_local",
        confidence: 0.5,
        evidence: [
          {
            libraryID: 1,
            itemKey: "LONGPAPR",
            excerpt: "LONGPAPR passage 1",
            evidenceRole: "SUPPORTS",
            readDepth: "chunk_local",
          },
        ],
      },
    ],
  });
  assert.equal(forced.committed, true);
  assert.equal(
    forced.readingSession.released,
    false,
    "readingSessionId is not an override for incomplete coverage",
  );
  assert.ok(await sessions.getOpen(1), "the paper is still open");

  // Reading on to the end and committing DOES end it.
  await readToEnd("LONGPAPR");
  const finishing = await commitClaim({
    title: "Checkpoint completion page",
    itemKey: "LONGPAPR",
    claimText: "Finishing the paper is what releases the library.",
  });
  assert.equal(
    finishing.readingSession.released,
    true,
    "a commit on a fully delivered paper releases the library",
  );
  assert.equal(finishing.readingSession.state, "committed");
  assert.equal(finishing.readingSession.coverageComplete, true);
  assert.equal(
    await sessions.getOpen(1),
    null,
    "and nothing is left open",
  );

  // Which means the next paper can now start.
  await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPERB01",
  });
  await service.finishReading({ libraryID: 1, outcome: "skipped" });
}

// =========================================================================
// 3c. The explicit early exits still release an unfinished paper
// =========================================================================

for (const outcome of ["skipped", "failed"]) {
  let page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "LONGPAPR",
    limit: 20,
  });
  assert.equal(page.pagination.coverageComplete, false);

  const closed = await service.finishReading({
    libraryID: 1,
    itemKey: "LONGPAPR",
    outcome,
    note: `closed as ${outcome} partway through`,
  });
  assert.equal(closed.closed, true);
  assert.equal(closed.outcome, outcome);
  assert.ok(
    closed.chunksRead < closed.totalChunks,
    "the paper really was unfinished",
  );

  const next = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPERB01",
  });
  assert.equal(
    next.target.itemKey,
    "PAPERB01",
    `an explicit "${outcome}" must release the library even when unread`,
  );
  await service.finishReading({ libraryID: 1, outcome: "skipped" });
}

// =========================================================================
// 3d. A commit that does not cite the open paper leaves it open
// =========================================================================

{
  await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "LONGPAPR",
    limit: 20,
  });
  const elsewhere = await commitClaim({
    title: "Unrelated page",
    itemKey: "PAPERB01",
    claimText: "A claim about another paper must not close the open one.",
  });
  assert.equal(elsewhere.committed, true);
  assert.equal(elsewhere.readingSession.released, false);
  assert.equal(elsewhere.readingSession.itemKey, "LONGPAPR");
  assert.match(elsewhere.readingSession.note, /did not cite LONGPAPR/iu);
  const sessions = await store.readingSessions();
  assert.ok(await sessions.getOpen(1), "LONGPAPR stays open");
  await service.finishReading({ libraryID: 1, outcome: "skipped" });
}

// =========================================================================
// 3e. Partial commit -> finish reading -> commit again is idempotent
// =========================================================================

{
  const CLAIM_A = "Gradient G controls the width of the columnar band.";
  const CLAIM_B = "The transition temperature bounds that effect.";

  // Read 40 of 181 and commit claim A from what has been read.
  let page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "LONGPAPR",
    limit: 20,
  });
  page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    cursor: page.pagination.nextCursor,
  });
  assert.equal(page.pagination.coverageComplete, false);

  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: "Resume page",
    proposedPageTitles: ["Resume page"],
  });
  const partial = await service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: prepared.prepareToken,
    actions: [
      { action: "CREATE_PAGE", ref: "p", canonicalTitle: "Resume page" },
      {
        action: "ADD_CLAIM",
        ref: "a",
        pageId: "p",
        claimText: CLAIM_A,
        claimType: "mechanism",
        epistemicStatus: "provisional",
        coverageLevel: "paper_reviewed",
        confidence: 0.7,
        evidence: [
          {
            libraryID: 1,
            itemKey: "LONGPAPR",
            excerpt: "LONGPAPR passage 0",
            evidenceRole: "SUPPORTS",
            readDepth: "paper_reviewed",
          },
        ],
      },
    ],
  });
  const pageId = partial.refs["p"];
  const claimA = partial.refs["a"];
  assert.equal(partial.createdClaims, 1);
  assert.equal(partial.reusedClaims, 0);
  assert.equal(partial.readingSession.released, false);

  const claimsAfterPartial = count("SELECT COUNT(*) AS n FROM wiki_claims");
  const evidenceAfterPartial = count("SELECT COUNT(*) AS n FROM wiki_evidence");
  const partialClaim = await store.getClaim(claimA);
  assert.equal(
    partialClaim.evidence[0].readDepth,
    "section_read",
    "the partial read clamps the evidence depth",
  );

  // Finish reading, then submit the paper's claims - which naturally REPEATS
  // claim A and adds claim B.
  await readToEnd("LONGPAPR");
  const resumed = await service.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "ADD_CLAIM",
        ref: "a2",
        pageId,
        claimText: CLAIM_A,
        claimType: "mechanism",
        epistemicStatus: "provisional",
        coverageLevel: "paper_reviewed",
        confidence: 0.7,
        evidence: [
          {
            libraryID: 1,
            itemKey: "LONGPAPR",
            excerpt: "LONGPAPR passage 0",
            evidenceRole: "SUPPORTS",
            readDepth: "paper_reviewed",
          },
        ],
      },
      {
        action: "ADD_CLAIM",
        ref: "b",
        pageId,
        claimText: CLAIM_B,
        claimType: "condition",
        epistemicStatus: "provisional",
        coverageLevel: "paper_reviewed",
        confidence: 0.8,
        evidence: [
          {
            libraryID: 1,
            itemKey: "LONGPAPR",
            excerpt: "LONGPAPR passage 40",
            evidenceRole: "SUPPORTS",
            readDepth: "paper_reviewed",
          },
        ],
      },
    ],
  });

  // The repeat folds into the existing Claim; only the new one is created.
  assert.equal(resumed.createdClaims, 1, "only the genuinely new Claim is created");
  assert.equal(resumed.reusedClaims, 1, "the repeated Claim is reported as reused");
  assert.equal(
    resumed.refs["a2"],
    claimA,
    "the repeated Claim's ref resolves to the Claim that already exists",
  );
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_claims"),
    claimsAfterPartial + 1,
    "no duplicate Claim row",
  );
  assert.equal(
    count(
      "SELECT COUNT(*) AS n FROM wiki_claims WHERE page_id = ? AND normalized_claim_text = (SELECT normalized_claim_text FROM wiki_claims WHERE claim_id = ?)",
      pageId,
      claimA,
    ),
    1,
    "the repeated Claim exists exactly once",
  );
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_evidence"),
    evidenceAfterPartial + 1,
    "the repeated Evidence is upserted, not duplicated; only B's is new",
  );
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_evidence WHERE claim_id = ?", claimA),
    1,
    "claim A still has exactly one Evidence row",
  );

  // Re-attaching after full coverage raises the stored Evidence depth.
  const finalClaim = await store.getClaim(claimA);
  assert.equal(
    finalClaim.evidence[0].readDepth,
    "paper_reviewed",
    "the same Evidence upgrades to the now-provable depth instead of duplicating",
  );

  // The paper was fully read, so this commit ends it.
  assert.equal(resumed.readingSession.released, true);
  assert.equal(resumed.readingSession.state, "committed");

  // Submitting the very same commit a third time changes nothing at all.
  const claimsBefore = count("SELECT COUNT(*) AS n FROM wiki_claims");
  const evidenceBefore = count("SELECT COUNT(*) AS n FROM wiki_evidence");
  const third = await service.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "ADD_CLAIM",
        ref: "a3",
        pageId,
        claimText: CLAIM_A,
        claimType: "mechanism",
        epistemicStatus: "provisional",
        coverageLevel: "paper_reviewed",
        confidence: 0.7,
        evidence: [
          {
            libraryID: 1,
            itemKey: "LONGPAPR",
            excerpt: "LONGPAPR passage 0",
            evidenceRole: "SUPPORTS",
            readDepth: "paper_reviewed",
          },
        ],
      },
    ],
  });
  assert.equal(third.createdClaims, 0);
  assert.equal(third.reusedClaims, 1);
  assert.equal(third.attachedEvidence, 0, "no Evidence row is added again");
  assert.equal(count("SELECT COUNT(*) AS n FROM wiki_claims"), claimsBefore);
  assert.equal(count("SELECT COUNT(*) AS n FROM wiki_evidence"), evidenceBefore);

  // An equivalent Claim on a DIFFERENT Page is still refused: folding is a
  // re-submission rule, not permission to duplicate knowledge across Pages.
  const other = await service.prepareUpdate({
    libraryID: 1,
    query: "Other resume page",
    proposedPageTitles: ["Other resume page"],
  });
  await assert.rejects(
    () =>
      service.commit({
        libraryID: 1,
        userInitiated: true,
        prepareToken: other.prepareToken,
        actions: [
          { action: "CREATE_PAGE", ref: "p2", canonicalTitle: "Other resume page" },
          {
            action: "ADD_CLAIM",
            ref: "dup",
            pageId: "p2",
            claimText: CLAIM_A,
            claimType: "mechanism",
            epistemicStatus: "provisional",
            coverageLevel: "chunk_local",
            confidence: 0.7,
            evidence: [
              {
                libraryID: 1,
                itemKey: "LONGPAPR",
                excerpt: "LONGPAPR passage 0",
                evidenceRole: "SUPPORTS",
                readDepth: "chunk_local",
              },
            ],
          },
        ],
      }),
    /An equivalent Claim already exists/iu,
    "cross-Page duplication is still refused",
  );
}

// =========================================================================
// 3f. A transient read failure must not release the paper
// =========================================================================

{
  await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "LONGPAPR",
    limit: 20,
  });
  const sessions = await store.readingSessions();
  const before = await sessions.getOpen(1);
  assert.ok(before);
  const deliveredBefore = (await sessions.coverage(before.sessionId))
    .deliveredChunks;

  // A page read blows up the way a network or index hiccup would.
  const healthy = vectorStore.getChunksForItem;
  vectorStore.getChunksForItem = async () => {
    throw new Error("transient index read failure");
  };
  await assert.rejects(
    () =>
      service.buildFromPaper({
        libraryID: 1,
        userRequested: true,
        itemKey: "LONGPAPR",
        limit: 20,
      }),
    /transient index read failure/iu,
  );
  vectorStore.getChunksForItem = healthy;

  const after = await sessions.getOpen(1);
  assert.ok(after, "a failed page read must leave the session open");
  assert.equal(after.sessionId, before.sessionId, "and it is the same session");
  assert.notEqual(after.state, "failed", "it is NOT auto-failed");
  assert.equal(
    (await sessions.coverage(after.sessionId)).deliveredChunks,
    deliveredBefore,
    "and the delivery ledger is unchanged by the failure",
  );

  // The next paper is still blocked - the failure released nothing.
  await assert.rejects(
    () =>
      service.buildFromPaper({
        libraryID: 1,
        userRequested: true,
        itemKey: "PAPERB01",
      }),
    /Paper LONGPAPR is still open/iu,
    "a transient failure must not let the batch move on",
  );

  // Reading simply resumes.
  const resumed = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "LONGPAPR",
    limit: 20,
  });
  assert.ok(
    resumed.pagination.deliveredChunks >= deliveredBefore,
    "reading resumes with progress intact",
  );

  // `committed` cannot be asserted through the explicit exit.
  await assert.rejects(
    () =>
      service.finishReading({
        libraryID: 1,
        itemKey: "LONGPAPR",
        outcome: "committed",
      }),
    /only accepts "skipped" or "failed"/iu,
    "a paper cannot be declared committed without having been read and committed",
  );
  assert.ok(await sessions.getOpen(1), "and the rejected attempt changed nothing");

  // `failed` remains available as a deliberate, caller-made decision.
  const abandoned = await service.finishReading({
    libraryID: 1,
    itemKey: "LONGPAPR",
    outcome: "failed",
    note: "attachment is unreadable",
  });
  assert.equal(abandoned.outcome, "failed");
  assert.equal(await sessions.getOpen(1), null);
}

// =========================================================================
// 4. One paper at a time
// =========================================================================

{
  // The previous block's commit closed LONGPAPR. Open it again.
  await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "LONGPAPR",
    limit: 20,
  });

  await assert.rejects(
    () =>
      service.buildFromPaper({
        libraryID: 1,
        userRequested: true,
        itemKey: "PAPERB01",
      }),
    /Paper LONGPAPR is still open[\s\S]*wiki_finish_reading/iu,
    "starting paper B while A is open must be refused, naming A and the way out",
  );

  // Re-reading the SAME paper is not a conflict.
  const again = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "LONGPAPR",
    limit: 20,
  });
  assert.equal(again.target.itemKey, "LONGPAPR");

  // The read-but-do-not-write exit.
  const closed = await service.finishReading({
    libraryID: 1,
    itemKey: "LONGPAPR",
    outcome: "skipped",
    note: "not relevant to the question",
  });
  assert.equal(closed.closed, true);
  assert.equal(closed.outcome, "skipped");

  const paperB = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPERB01",
  });
  assert.equal(
    paperB.target.itemKey,
    "PAPERB01",
    "closing the open paper frees the library for the next one",
  );

  // Guarding with the wrong itemKey is refused rather than closing the wrong paper.
  await assert.rejects(
    () =>
      service.finishReading({
        libraryID: 1,
        itemKey: "LONGPAPR",
        outcome: "skipped",
      }),
    /The open paper is PAPERB01/iu,
  );
  await service.finishReading({ libraryID: 1, outcome: "skipped" });
}

// =========================================================================
// 5. Failure BEFORE the database commit leaves nothing behind
// =========================================================================

{
  // Settle any drain still in flight from earlier commits so the counts below
  // measure the rollback rather than the background queue.
  await service.pumpEmbeddingQueue({ limit: 1000 });
  const pages = count("SELECT COUNT(*) AS n FROM wiki_pages");
  const claims = count("SELECT COUNT(*) AS n FROM wiki_claims");
  await assert.rejects(
    () =>
      commitClaim({
        title: "Rollback probe",
        itemKey: "LONGPAPR",
        claimText: "",
      }),
    /Claim text must not be blank/iu,
  );
  assert.equal(count("SELECT COUNT(*) AS n FROM wiki_pages"), pages,
    "the CREATE_PAGE in the same transaction rolls back too");
  assert.equal(count("SELECT COUNT(*) AS n FROM wiki_claims"), claims);
  assert.equal(
    count(
      `SELECT COUNT(*) AS n FROM wiki_embedding_queue q
       LEFT JOIN wiki_claims c ON c.claim_id = q.claim_id
       WHERE c.claim_id IS NULL`,
    ),
    0,
    "and nothing is queued for a claim that was never written",
  );
}

// =========================================================================
// 6. DB committed, embedding fails -> committed, queued, later repaired
// =========================================================================

{
  embed = { mode: "throw" };
  const result = await commitClaim({
    title: "Embedding outage page",
    itemKey: "LONGPAPR",
    claimText: "An embedding outage must not lose the claim or its vector.",
  });
  const claimId = result.refs["c"];

  assert.equal(result.committed, true, "the write is reported as committed");
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_claims WHERE claim_id = ?", claimId),
    1,
  );
  assert.ok(
    result.embeddingPending >= 1,
    "and the caller is told a vector is still pending",
  );
  assert.match(result.embeddingNote, /committed and permanent/iu);

  // The drain kicked off by commit ran and failed; the row remains.
  await service.pumpEmbeddingQueue();
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_embedding_queue WHERE claim_id = ?", claimId),
    1,
    "the claim is remembered as still needing a vector",
  );
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_claim_embeddings WHERE claim_id = ?", claimId),
    0,
  );
  const attempts = count(
    "SELECT attempts AS n FROM wiki_embedding_queue WHERE claim_id = ?",
    claimId,
  );
  assert.ok(attempts >= 1, "the failure is counted for backoff");

  // Backend recovers. A drain that ignores backoff repairs it.
  embed = { mode: "ok" };
  const queue = await store.embeddingQueue();
  await queue.retryAll();
  const drained = await service.pumpEmbeddingQueue();
  assert.ok(drained.succeeded >= 1);
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_claim_embeddings WHERE claim_id = ?", claimId),
    1,
    "the vector is built once the backend recovers",
  );
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_embedding_queue WHERE claim_id = ?", claimId),
    0,
    "and the claim leaves the queue - an empty queue means every claim has a vector",
  );
}

// =========================================================================
// 7. DB committed, embedding slow -> commit returns anyway
// =========================================================================

{
  let release;
  let entered;
  const embeddingEntered = new Promise((r) => { entered = r; });
  embed = {
    mode: "hang",
    onEnter: entered,
    release: new Promise((r) => { release = r; }),
  };

  const started = Date.now();
  const result = await commitClaim({
    title: "Slow embedding page",
    itemKey: "LONGPAPR",
    claimText: "A slow embedding backend must not stall the commit response.",
  });

  assert.equal(
    result.committed,
    true,
    "commit returns while the embedding is still blocked - no client deadline can catch it mid-write",
  );
  assert.ok(
    Date.now() - started < 5000,
    "and it returns promptly rather than waiting on the backend",
  );
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_pages WHERE canonical_title = ?",
      "Slow embedding page"),
    1,
    "the write is durable at the moment the caller is answered",
  );
  assert.ok(result.embeddingPending >= 1);

  await embeddingEntered;
  release();
  await new Promise((r) => setImmediate(r));
  embed = { mode: "ok" };
}

// =========================================================================
// 8. Re-submitting the same commit does not duplicate anything
// =========================================================================

{
  await readToEnd("PAPERB01");
  const first = await commitClaim({
    title: "Idempotency page",
    itemKey: "PAPERB01",
    claimText: "Re-submitting a commit must not create a second claim.",
  });
  const claims = count("SELECT COUNT(*) AS n FROM wiki_claims");
  const evidence = count("SELECT COUNT(*) AS n FROM wiki_evidence");
  const pages = count("SELECT COUNT(*) AS n FROM wiki_pages");

  await assert.rejects(
    () =>
      commitClaim({
        title: "Idempotency page",
        itemKey: "PAPERB01",
        claimText: "Re-submitting a commit must not create a second claim.",
      }),
    /already exists/iu,
    "the retry is refused rather than duplicating",
  );
  assert.equal(count("SELECT COUNT(*) AS n FROM wiki_claims"), claims);
  assert.equal(count("SELECT COUNT(*) AS n FROM wiki_evidence"), evidence);
  assert.equal(count("SELECT COUNT(*) AS n FROM wiki_pages"), pages);
  assert.ok(first.refs["c"] > 0);

  // Re-attaching the same evidence to the SAME claim is an upsert, not a copy.
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: "Idempotency page",
  });
  void prepared;
  const reattach = await service.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "ATTACH_EVIDENCE",
        claimId: first.refs["c"],
        evidence: [
          {
            libraryID: 1,
            itemKey: "PAPERB01",
            excerpt: "PAPERB01 passage 0",
            evidenceRole: "SUPPORTS",
            readDepth: "chunk_local",
          },
        ],
      },
    ],
  });
  assert.equal(reattach.committed, true);
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_evidence"),
    evidence,
    "the same excerpt from the same source does not become a second Evidence row",
  );
}

// =========================================================================
// 9. Retrieval, ordering, Claim/Evidence semantics must not regress
// =========================================================================

{
  await service.pumpEmbeddingQueue({ limit: 100 });
  const found = await service.search({
    libraryID: 1,
    query: "columnar band",
    useVector: false,
  });
  assert.ok(Array.isArray(found.claims));
  const scores = found.claims.map((c) => c.score);
  assert.deepEqual(
    scores,
    [...scores].sort((a, b) => b - a),
    "Wiki retrieval stays sorted by descending score",
  );

  const pageIds = sqlite
    .prepare("SELECT page_id FROM wiki_pages WHERE status = 'active'")
    .all()
    .map((r) => r.page_id);
  assert.ok(pageIds.length >= 3);
  for (const pageId of pageIds) {
    const page = await store.getPage(pageId);
    assert.ok(page, "every committed page still loads");
    for (const claim of page.claims) {
      assert.ok(claim.claimText, "claims keep their text");
      for (const ev of claim.evidence) {
        assert.equal(ev.linkState, "valid");
        assert.ok(ev.excerpt, "evidence keeps its excerpt");
      }
    }
  }

  const status = await store.getStatus(1);
  assert.equal(Number(status.pages), pageIds.length);

  // Reading sessions are a complete, inspectable log.
  const sessions = await store.readingSessions();
  const log = await sessions.list(1);
  assert.ok(log.length >= 4, "every paper that was opened left a record");
  assert.equal(
    log.filter((s) => s.state === "reading" || s.state === "prepared").length,
    0,
    "and nothing is left open at the end of a clean run",
  );
  assert.ok(
    log.some((s) => s.state === "skipped"),
    "including the read-but-not-written outcome",
  );
  assert.ok(log.some((s) => s.state === "committed"));
}

sqlite.close();
fs.rmSync(tempDir, { recursive: true, force: true });

console.log("wiki build-loop tests passed");
