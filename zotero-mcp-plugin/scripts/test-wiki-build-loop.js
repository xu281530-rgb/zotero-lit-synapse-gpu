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

// Every query below goes through Zotero's real parameter rules, not
// node:sqlite's permissive ones - see scripts/zotero-db-params.mjs.
const { parseQueryAndParams, placeholderVisibility } = await import(
  "./zotero-db-params.mjs",
);

// The reading note is a file on a Zotero item, so the fake has to be able to
// hold one: attachments, IOUtils and a real temp directory. See
// ./wiki-reading-fixtures.mjs.
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-loop-"));
const fake = createZoteroFake({ rootDir: tempDir });
fake.install();

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
    async queryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const statement = sqlite.prepare(sql);
      const values = params.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) return statement.all(...values);
      statement.run(...values);
      return [];
    },
    async valueQueryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
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

for (const itemKey of indexedChunks.keys()) {
  fake.createPaper({
    key: itemKey,
    title: `Paper ${itemKey}`,
    abstract: `Abstract of paper ${itemKey}: directional solidification of columnar arrays.`,
  });
}

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

const dbPath = path.join(tempDir, "wiki.sqlite");
let sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");
let store = new WikiStore(adapt(sqlite));
await store.initialize();
let service = new WikiService(store);

const count = (sql, ...p) => Number(sqlite.prepare(sql).get(...p).n);

/**
 * Wrap a fixture body in the five sections a record now has to arrive in.
 *
 * The template is enforced at the write, so a fixture that skips it is
 * testing a call the server no longer accepts. Everything specific to a test
 * stays in `body`; the four remaining sections carry the honest answer for a
 * synthetic chunk, which is that it has no data and no terminology.
 */
function templated(body) {
  return [
    "**一句话**",
    "本批讲的是定向凝固。",
    "",
    "**做了什么**",
    body,
    "",
    "**测到了什么**",
    "本批无结果数据。",
    "",
    "**概念与术语**",
    "无。",
    "",
    // Chunk accounting has its own slot now, and coverage is counted there:
    // the content slots stopped having to name chunks so they could stop
    // being a chunk index. Derived from the body so every fixture stays
    // self-consistent without touching its call site.
    "**本批覆盖**",
    accountFor(body),
    "",
    "**存疑与未交代**",
    "无。",
  ].join("\n");
}

/** One accounting line naming every chunk the body already cites. */
function accountFor(text) {
  const spans = [
    ...new Set(
      [
        ...String(text).matchAll(
          /(?:chunks?)[ ]*#?[ ]*[0-9]+(?:[ ]*(?:[-–—]|、|,|，)[ ]*[0-9]+)*/gu,
        ),
      ].map((match) => match[0]),
    ),
  ];
  // One group per LINE. Fusing several separately cited runs into one sentence
  // makes the overstatement audit read it as a multi-chunk assertion and ask
  // for a quotation per chunk, which an accounting line can never give.
  return spans.length
    ? spans
        .map((span) => "本批涉及 " + span + "。")
        .join(String.fromCharCode(10))
    : "无。";
}

/** Every page delivered for an item, across all reads of it. */
const pagesByItem = new Map();

/**
 * How a record names the chunks its page delivered.
 *
 * Written as a RUN rather than one bracket per chunk, and the difference
 * matters to two readers at once. Coverage expands `chunk 4-11` into all eight
 * and is satisfied; the overstatement audit reads one number out of it and
 * sees a single-chunk sentence, so a span stays cheap while genuinely fusing
 * eight separately cited chunks into one assertion stays expensive. That
 * asymmetry is the whole reason grouped citations are allowed.
 */
function citationFor(page) {
  const indexes = page.chunks.map((chunk) => chunk.chunkIndex);
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  if (indexes.length === 1) return `chunk ${first}`;
  // A page that walked over already-read chunks is not a run, and writing it
  // as one would drop the chunks in the holes.
  return indexes.every((index, step) => index === first + step)
    ? `chunk ${first}-${last}`
    : `chunk ${indexes.join("、")}`;
}

function recordForPage(page) {
  return templated(
    `Directional solidification is discussed for the stations represented in these passages (${citationFor(page)}).`,
  );
}

/**
 * A whole-paper synthesis that reaches every record without being pasted.
 *
 * Two rules meet here and have to be satisfiable together: the summary must
 * cite something from every substantive record, and it must not repeat the
 * records verbatim. Citing each page in the summary's own words does both,
 * which is the point - coverage is checked by citation, never by wording.
 */
function summaryForPaper(itemKey) {
  const pages = (pagesByItem.get(itemKey) ?? []).filter(
    (page) => page.chunks.length > 0,
  );
  const method = pages.length
    ? pages
        .map(
          (page) =>
            `论文以定向凝固站位序列作为核心研究方法（${citationFor(page)}）。`,
        )
        .join("\n\n")
    : "夹具未给出方法细节。";
  return [
    "## 本篇讲了什么",
    "这篇论文讨论定向凝固。",
    "",
    "## 研究对象与材料",
    "合成夹具，未给出材料牌号。",
    "",
    "## 核心方法",
    method,
    "",
    "## 主要结果",
    "夹具未给出结果数据。",
    "",
    "## 机理解释",
    "夹具未给出机理。",
    "",
    "## 结论",
    "夹具未给出结论。",
    "",
    "## 边界与局限",
    "作者未讨论。",
  ].join("\n");
}

/** Give the open paper the one expert it needs before body text will flow. */
async function grantExpert(itemKey) {
  return service.setReadingExpert({
    libraryID: 1,
    itemKey,
    persona:
      "A solidification metallurgist who evaluates columnar grain array processing and the conditions under which the columnar band collapses.",
    focus: [
      "the process chain and its parameters",
      "the criterion for the columnar-to-equiaxed transition",
    ],
  });
}

/** Keep independent blocks independent when they reuse the same paper key. */
async function resetClosedFixtureNote(itemKey) {
  const sessions = await store.readingSessions();
  if (await sessions.openForItem(1, itemKey)) return;
  const paper = await fake.Zotero.Items.getByLibraryAndKeyAsync(1, itemKey);
  for (let index = paper._attachmentIds.length - 1; index >= 0; index -= 1) {
    const attachment = fake.Zotero.Items.get(paper._attachmentIds[index]);
    if (String(attachment?.getField?.("title") ?? "").startsWith("Wiki Reading Note")) {
      paper._attachmentIds.splice(index, 1);
    }
  }
}

/**
 * Deliver one page and fold it into the reading note, the way a reader does.
 *
 * Every block below that reads body text goes through this, so none of them
 * has to restate the two-phase opening or the integration gate. A first call
 * lands in the expert phase and is retried once the expert exists.
 */
async function read(args) {
  if (args.itemKey) await resetClosedFixtureNote(args.itemKey);
  const page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    ...args,
  });
  if (page.phase === "expert_briefing") {
    await grantExpert(page.target.itemKey);
    return read(args);
  }
  await service.updateReadingNote({
    libraryID: 1,
    itemKey: page.target.itemKey,
    readingRecord: recordForPage(page),
  });
  // Keep every page available to the final synthesis, including pages read
  // before a later call resumed the paper. The macro summary can then distil
  // the complete paper without reproducing each record.
  const key = page.target.itemKey;
  if (!pagesByItem.has(key)) pagesByItem.set(key, []);
  pagesByItem.get(key).push(page);
  return page;
}

/** Read a paper to the end, then do the whole-paper pass. Returns every page. */
async function readToEnd(itemKey, limit = 20) {
  const pages = [];
  let page = await read({ itemKey, limit });
  pages.push(page);
  while (page.pagination.hasMore) {
    page = await read({ cursor: page.pagination.nextCursor });
    pages.push(page);
  }
  await service.updateReadingNote({
    libraryID: 1,
    itemKey,
    finalSynthesis: true,
    macroSummary: summaryForPaper(itemKey),
  });
  // 2.4.3: a fully delivered paper also owes one deliberate pass over the
  // terminology it established before its claims may be written up. Most
  // papers introduce nothing new, which is what this answer says.
  await service.recordConcepts({
    libraryID: 1,
    itemKey,
    final: true,
    concepts: [],
    noConceptsReason: "fixture paper: no terminology beyond what is already held",
  });
  // 2.5.1: and one pass over the Wiki itself. A commit is what CLOSES a paper,
  // so all three passes are checked where "committed" is written, not only at
  // wiki_prepare_update - otherwise an ADD_CLAIM-only commit, which never has
  // to go through prepare, closes a paper that answered none of them. Reading
  // a paper to the end therefore means doing the review too.
  await service.prepareUpdate({
    libraryID: 1,
    itemKey,
    query: itemKey,
    proposedPageTitles: [itemKey],
    wikiReview: await reviewFor(itemKey),
  });
  return pages;
}

/**
 * The whole-Wiki review a completed full-text read owes before the write-up.
 *
 * The blocks below are about paging, sessions and commits rather than about
 * the review itself, which is tested in test-wiki-qa-reading.js.
 */
const WIKI_REVIEW = {
  pages: "The existing Page covers this subject; no new Page and no retitling needed.",
  claims: "One Claim to add; nothing already stored is contradicted or superseded by it.",
  evidence: "Evidence for the new Claim is quoted from a chunk delivered in this read.",
  concepts: "No terminology beyond what the concept library already holds; nothing to merge.",
  relations: "No relation to draw or withdraw: this paper links no two concepts already stored.",
};

async function reviewFor(itemKey) {
  const claims = await store.listClaimsByEvidenceSource(1, itemKey);
  return {
    ...WIKI_REVIEW,
    claimVerdicts: claims.map((claim) => ({
      claimId: claim.claimId,
      verdict: "confirmed",
      basis:
        "The completed fixture paper supports this Claim at its currently stored wording and scope.",
    })),
  };
}

/**
 * Prepare, sending the whole-Wiki review only when the paper is ready for it.
 *
 * Mirrors what a caller actually has to do: the review is refused outright on
 * an unfinished paper - reviewing the Wiki against half a paper would then
 * count as the final pass and never be asked for again - so a mid-read
 * checkpoint commit sends no review, and the gate at the end asks for one by
 * name. Driving it off the refusal rather than off a flag means these blocks
 * also prove the two messages are distinguishable.
 */
async function prepareFor(title, itemKey) {
  try {
    return await service.prepareUpdate({
      libraryID: 1,
      itemKey,
      query: title,
      proposedPageTitles: [title],
    });
  } catch (error) {
    if (!/review the WHOLE Wiki against the finished paper/iu.test(error.message)) {
      throw error;
    }
    return service.prepareUpdate({
      libraryID: 1,
      itemKey,
      query: title,
      proposedPageTitles: [title],
      wikiReview: await reviewFor(itemKey),
    });
  }
}

/**
 * Answer for every chunk this reading was handed but did not quote.
 *
 * A full-text page owes the Wiki per chunk now, so a commit that quotes one
 * passage and says nothing about the other hundred and eighty leaves the paper
 * open. One SKIP with one reason is how a run of routine passages is settled
 * honestly; this is the shape a real write-up takes, so the fixtures use it
 * rather than pretending the debt is not there.
 */
async function writeOffRest(itemKey, quotedChunkIds = []) {
  const sessions = await store.readingSessions();
  const open = await sessions.openForItem(1, itemKey);
  if (!open) return [];
  const owed = await sessions.pendingWikiChunks(open.sessionId);
  const quoted = new Set(quotedChunkIds.map(Number));
  const chunkIds = owed
    .map((chunk) => chunk.chunkId)
    .filter((chunkId) => !quoted.has(chunkId));
  if (!chunkIds.length) return [];
  return [
    {
      action: "SKIP",
      itemKey,
      chunkIds,
      reason:
        "These passages are the successive station readings of one traverse: they repeat the same measurement at the next station without stating a condition, a threshold or a mechanism of their own, so what they establish is already held by the Claim quoted above.",
    },
  ];
}

async function commitClaim(options) {
  const prepared = await prepareFor(options.title, options.itemKey);
  return service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: prepared.prepareToken,
    actions: [
      ...(options.settleRest === false
        ? []
        : await writeOffRest(options.itemKey)),
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
            excerpt: `${options.itemKey} passage 0: directional solidification`,
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

  // The opening call carries metadata and no body text: the expert who will
  // read the paper is decided before the paper is read.
  const briefing = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "LONGPAPR",
    limit: 999,
  });
  assert.equal(briefing.phase, "expert_briefing");
  assert.deepEqual(briefing.chunks, []);
  assert.ok(briefing.metadata.abstract, "the abstract is what the expert is built from");

  const first = await read({ itemKey: "LONGPAPR", limit: 999 });
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
  const page = await read({ itemKey: "SHORTPPR" });
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
  let page = await read({ itemKey: "LONGPAPR", limit: 20 });
  page = await read({ cursor: page.pagination.nextCursor });
  assert.equal(page.pagination.deliveredChunks, 40);
  const resumeCursor = page.pagination.nextCursor;

  // Simulate Zotero restarting: brand-new store and service on the same file.
  sqlite.close();
  sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON");
  store = new WikiStore(adapt(sqlite));
  await store.initialize();
  service = new WikiService(store);

  const afterRestart = await read({ cursor: resumeCursor });
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
  let page = await read({ itemKey: "LONGPAPR", limit: 20 });
  for (let i = 0; i < 2; i += 1) {
    page = await read({ cursor: page.pagination.nextCursor });
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
            excerpt: "LONGPAPR passage 1: directional solidification",
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
  await read({ itemKey: "PAPERB01" });
  await service.finishReading({ libraryID: 1, outcome: "skipped" });
}

// =========================================================================
// 3c. The explicit early exits still release an unfinished paper
// =========================================================================

for (const outcome of ["skipped", "failed"]) {
  const page = await read({ itemKey: "LONGPAPR", limit: 20 });
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

  const next = await read({ itemKey: "PAPERB01" });
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
  await read({ itemKey: "LONGPAPR", limit: 20 });
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
  let page = await read({ itemKey: "LONGPAPR", limit: 20 });
  page = await read({ cursor: page.pagination.nextCursor });
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
            excerpt: "LONGPAPR passage 0: directional solidification",
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
      // The paper is fully delivered now, so this is the commit that ends it -
      // which it can only do once every delivered chunk has been answered for.
      ...(await writeOffRest("LONGPAPR")),
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
            excerpt: "LONGPAPR passage 0: directional solidification",
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
            excerpt: "LONGPAPR passage 40: directional solidification",
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
            excerpt: "LONGPAPR passage 0: directional solidification",
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
                excerpt: "LONGPAPR passage 0: directional solidification",
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
  await read({ itemKey: "LONGPAPR", limit: 20 });
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
  const resumed = await read({ itemKey: "LONGPAPR", limit: 20 });
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
// 3g. Evidence depth control parameter, and Zotero's real binding rules
// =========================================================================

{
  // The statement that used to throw. Its control placeholder sits after WHEN,
  // where Zotero's NULL rewriter cannot see it, so it must never be bound null.
  const evidenceInsert = fs
    .readFileSync("src/modules/wiki/wikiStore.ts", "utf8")
    .match(/INSERT INTO wiki_evidence[\s\S]*?last_verified_at = excluded\.last_verified_at/u)[0];
  const visibility = placeholderVisibility(evidenceInsert);
  assert.ok(
    visibility.invisible >= 1,
    "the read_depth control placeholder is invisible to Zotero's NULL rewriter",
  );
  assert.throws(
    () =>
      parseQueryAndParams(evidenceInsert, [
        ...Array.from({ length: visibility.total - 1 }, () => 1),
        null,
      ]),
    /Null parameter provided for a query without placeholders/u,
    "binding null at that placeholder is exactly the reported failure",
  );
  assert.doesNotThrow(
    () =>
      parseQueryAndParams(evidenceInsert, [
        ...Array.from({ length: visibility.total - 1 }, () => 1),
        0,
      ]),
    "an explicit 0 binds cleanly",
  );

  // --- Full-text Evidence: no ceiling. This is the case that failed. ---
  await readToEnd("SHORTPPR");
  const fullText = await commitClaim({
    title: "Depth control full text",
    itemKey: "SHORTPPR",
    claimText: "Fully read evidence commits without a null control parameter.",
    coverageLevel: "paper_reviewed",
    readDepth: "paper_reviewed",
  });
  const fullClaim = await store.getClaim(fullText.refs["c"]);
  assert.equal(
    fullClaim.evidence[0].readDepth,
    "paper_reviewed",
    "a fully read paper stores full depth",
  );

  // --- Depth only ever rises on re-attach when there is no ceiling ---
  const claimId = fullText.refs["c"];
  await service.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "ATTACH_EVIDENCE",
        claimId,
        evidence: [
          {
            libraryID: 1,
            itemKey: "SHORTPPR",
            excerpt: "SHORTPPR passage 0: directional solidification",
            evidenceRole: "SUPPORTS",
            readDepth: "chunk_local",
          },
        ],
      },
    ],
  });
  const afterLower = await store.getClaim(claimId);
  assert.equal(
    afterLower.evidence[0].readDepth,
    "paper_reviewed",
    "re-attaching shallower Evidence must NOT lower the stored depth",
  );
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_evidence WHERE claim_id = ?", claimId),
    1,
    "and it upserts rather than duplicating",
  );

  // --- A server-imposed ceiling DOES force the depth down ---
  // bodyState leaves 'body', so hydrateEvidence sets readDepthCeiling and the
  // control parameter becomes 1.
  const healthyStatus = vectorStore.getIndexStatus;
  vectorStore.getIndexStatus = async (k) => ({
    contentHash: `content-${k}`,
    sourceKind: "metadata-only",
  });
  await service.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "ATTACH_EVIDENCE",
        claimId,
        evidence: [
          {
            libraryID: 1,
            itemKey: "SHORTPPR",
            excerpt: "SHORTPPR passage 0: directional solidification",
            evidenceRole: "SUPPORTS",
            readDepth: "paper_reviewed",
          },
        ],
      },
    ],
  });
  vectorStore.getIndexStatus = healthyStatus;

  const afterCeiling = await store.getClaim(claimId);
  assert.equal(
    afterCeiling.evidence[0].readDepth,
    "chunk_local",
    "a server-imposed ceiling must force the stored depth back down",
  );
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_evidence WHERE claim_id = ?", claimId),
    1,
    "still one Evidence row",
  );

  await service.finishReading({ libraryID: 1, outcome: "skipped" }).catch(() => {});
}

// =========================================================================
// 3h. A prepareToken survives a failure that wrote nothing
// =========================================================================

{
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: "Token retry page",
    proposedPageTitles: ["Token retry page"],
  });
  const token = prepared.prepareToken;
  const pagesBefore = count("SELECT COUNT(*) AS n FROM wiki_pages");

  const actionsFor = (claimText) => [
    { action: "CREATE_PAGE", ref: "p", canonicalTitle: "Token retry page" },
    {
      action: "ADD_CLAIM",
      ref: "c",
      pageId: "p",
      claimText,
      claimType: "mechanism",
      epistemicStatus: "provisional",
      coverageLevel: "chunk_local",
      confidence: 0.6,
      evidence: [
        {
          libraryID: 1,
          itemKey: "PAPERB01",
          excerpt: "PAPERB01 passage 0: directional solidification",
          evidenceRole: "SUPPORTS",
          readDepth: "chunk_local",
        },
      ],
    },
  ];

  // A failure inside the transaction: nothing is written.
  await assert.rejects(
    () =>
      service.commit({
        libraryID: 1,
        userInitiated: true,
        prepareToken: token,
        actions: actionsFor(""),
      }),
    /Claim text must not be blank/iu,
  );
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_pages"),
    pagesBefore,
    "the failed attempt wrote nothing",
  );

  // The SAME token still works - no second wiki_prepare_update required.
  const retried = await service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: token,
    actions: actionsFor("A transient failure must not burn the prepare token."),
  });
  assert.equal(retried.committed, true, "the token survives a failed attempt");
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_pages"),
    pagesBefore + 1,
    "and the retry writes exactly one Page",
  );

  // But a SUCCESSFUL commit spends it: it cannot be replayed.
  await assert.rejects(
    () =>
      service.commit({
        libraryID: 1,
        userInitiated: true,
        prepareToken: token,
        actions: [
          {
            action: "CREATE_PAGE",
            ref: "p2",
            canonicalTitle: "Token retry page",
          },
        ],
      }),
    /requires a current wiki_prepare_update token/iu,
    "a spent token cannot be replayed into a second write",
  );
  assert.equal(
    count("SELECT COUNT(*) AS n FROM wiki_pages"),
    pagesBefore + 1,
    "so no duplicate Page is created",
  );

  await service.finishReading({ libraryID: 1, outcome: "skipped" }).catch(() => {});
}

// =========================================================================
// 4. One paper at a time
// =========================================================================

{
  // The previous block's commit closed LONGPAPR. Open it again.
  await read({ itemKey: "LONGPAPR", limit: 20 });

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
  const again = await read({ itemKey: "LONGPAPR", limit: 20 });
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

  const paperB = await read({ itemKey: "PAPERB01" });
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
            excerpt: "PAPERB01 passage 0: directional solidification",
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
