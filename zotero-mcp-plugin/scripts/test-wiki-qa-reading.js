/* eslint-env node */

/**
 * Question-driven reading: the incremental path, and how it meets the
 * full-text one.
 *
 * The failure this exists to prevent is a conversation that leaves nothing
 * behind. A user asks twenty questions, the model retrieves passages from a
 * dozen papers, answers every question well, and at the end the library knows
 * exactly what it knew at the start - because reading that is not written down
 * is reading that did not happen. `wiki_build_from_paper` already solved this
 * for the one case where somebody sits down to read a paper end to end. This
 * suite is about the other ninety percent.
 *
 * Each block is named for the thing that has to be true, in the order the
 * requirements were stated:
 *
 *   1. Scattered chunks accumulate as a real SET, and re-reading is free.
 *   2. The note comes first and the Wiki second, and that order is enforced
 *      rather than requested.
 *   3. Twenty questions make the note fuller, never shorter.
 *   4. Evidence always resolves to a chunk somebody actually read.
 *   5. Question-driven coverage never becomes `paper_reviewed`, however
 *      complete it gets.
 *   6. A full-text read CONTINUES what the questions read - same session, same
 *      note, same ledger - and only asks for the rest.
 *   7. One question may read several papers at once; the full-text lock does
 *      not apply to it and is not weakened by it.
 *
 * Real SQLite, real files on disk: the note is an attachment and the ledger is
 * a table, and neither guarantee is observable against in-memory doubles.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-qa-"));
const fake = createZoteroFake({ rootDir: tempDir });
fake.install();

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { getVectorStore } = await import(
  "../src/modules/semantic/vectorStore.ts"
);
const { getEmbeddingService } = await import(
  "../src/modules/semantic/embeddingService.ts"
);
const { parseReadingNote, parseAppendOnlyReadingNote, formatCoverageMap } = await import(
  "../src/modules/wiki/wikiReadingNote.ts"
);
const { auditSynthesis } = await import(
  "../src/modules/wiki/wikiSynthesisAudit.ts"
);

// --- Fixtures -------------------------------------------------------------

/** Long enough that scattered reading is visibly scattered. */
const LONG = 80;
const SHORT = 6;
/** Small enough that one page finishes it, for the close-condition blocks. */
const TINY = 8;

/**
 * Chunk text WITHOUT measured values, deliberately.
 *
 * This suite is about session mechanics - which slot a paper occupies, whose
 * chunks a record may cite, when a debt is settled - and every record in it
 * would otherwise also have to transcribe two measurements per chunk to
 * satisfy the value-landing rule, which is tested against real paper text in
 * test-wiki-record-template.js. Stations stay numbered because a bare ordinal
 * is not a measurement; the millimetres and the gradient are what leave.
 */
function chunksFor(key, count, base) {
  return Array.from({ length: count }, (_, i) => ({
    chunkId: base + i,
    text:
      `${key} passage ${i}: the melt-pool depth at station ${i} is reported ` +
      `under the imposed gradient described for that station.`,
    language: "en",
  }));
}

const indexedChunks = new Map([
  ["PAPERONE", chunksFor("PAPERONE", LONG, 1000)],
  ["PAPERTWO", chunksFor("PAPERTWO", LONG, 2000)],
  ["PAPRTHRE", chunksFor("PAPRTHRE", SHORT, 3000)],
  ["ABSTONLY", chunksFor("ABSTONLY", 2, 4000)],
  ["PAPERFIV", chunksFor("PAPERFIV", TINY, 5000)],
  ["HOLEPAPR", chunksFor("HOLEPAPR", SHORT, 6000)],
  ["AUDITPAP", chunksFor("AUDITPAP", 2, 7000)],
  ["QASUMMRY", chunksFor("QASUMMRY", 2, 8000)],
]);

for (const key of indexedChunks.keys()) {
  fake.createPaper({
    key,
    title: `Paper ${key}`,
    abstract: `Abstract of ${key}: melt-pool geometry under imposed thermal gradients.`,
  });
}

function adapt(sqlite) {
  let depth = 0;
  return {
    async queryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const statement = sqlite.prepare(sql);
      const values = params.map((v) =>
        typeof v === "boolean" ? (v ? 1 : 0) : v,
      );
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) {
        return statement.all(...values);
      }
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

const vectorStore = getVectorStore();
vectorStore.initialize = async () => {};
vectorStore.getChunksForItem = async (k) => indexedChunks.get(k) ?? [];
vectorStore.getIndexStatus = async (k) => ({
  contentHash: `content-${k}`,
  // ABSTONLY has no body: reading it is not a thing that can happen.
  sourceKind: k === "ABSTONLY" ? "abstract" : "body",
});
vectorStore.getCommittedResetGeneration = async () => "reset-1";

const embeddingService = getEmbeddingService();
embeddingService.getConfig = () => ({ model: "test-embed-model" });
embeddingService.embed = async () => ({ embedding: new Float32Array([1, 0]) });

const dbPath = path.join(tempDir, "wiki.sqlite");
const sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");
const database = adapt(sqlite);
const store = new WikiStore(database);
await store.initialize();
const service = new WikiService(store);

// --- Helpers --------------------------------------------------------------

/**
 * A note that satisfies every shape rule, parameterised by what it says.
 *
 * `facts` are the accumulating lines. The point of passing them in is that
 * several blocks below check that facts recorded early SURVIVE later rewrites,
 * which only means something if the caller controls what is in the document.
 */
/**
 * A record body in the five sections a full-text record has to arrive in.
 *
 * Question-driven records are not held to the template, but they may use it,
 * and having ONE shape here keeps the fixtures honest: a block that reads by
 * question and later resumes as a full-text pass writes the same way through
 * both, which is exactly the transition several blocks below exercise.
 *
 * The framing lines stay deliberately uncited. This note is written by
 * questions, so its standing header cannot cite chunk 0 - most turns have
 * never been given chunk 0, and a citation the reading cannot resolve is
 * refused. The facts, and their citations, live in 测到了什么.
 */
/** One accounting line naming every chunk the text already cites. */
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

function note(facts) {
  return [
    "# Melt-pool geometry under imposed thermal gradients",
    "",
    "**阅读总结**",
    "How melt-pool depth responds to the imposed thermal gradient, and where that response stops being linear.",
    "",
    "**方法**",
    "A nickel-base superalloy on a directional solidification rig, with depth measured at numbered stations.",
    "",
    "**结果与结论**",
    ...facts,
    "",
    "**概念与术语**",
    "无。",
    "",
    "**本批覆盖**",
    accountFor(facts.join(" ")),
    "",
    "**存疑与未交代**",
    "One alloy and one rig geometry; nothing outside the reported gradient range is demonstrated by this work.",
  ].join("\n");
}

/** chunkId for a given index of a given paper, the way a tool would report it. */
function chunkId(key, index) {
  return indexedChunks.get(key)[index].chunkId;
}

function synthesisAuditFor(key, body) {
  const chunks = indexedChunks.get(key);
  const auditChunks = chunks.flatMap((chunk, index) => [
    { chunkId: index, text: chunk.text },
    { chunkId: chunk.chunkId, text: chunk.text },
  ]);
  return auditSynthesis(body, { chunks: auditChunks }).map((flag) => ({
    sentence: flag.sentence,
    support: flag.citedChunks.map((address) => ({
      chunkId: address,
      quote:
        (chunks[address] ?? chunks.find((chunk) => chunk.chunkId === address))
          .text,
    })),
  }));
}

/** One turn of question-driven reading: read these chunks, rewrite the note. */
function readByQuestion(key, indexes, facts, extra = {}) {
  const body = note(facts);
  return service.updateReadingNote({
    libraryID: 1,
    itemKey: key,
    readChunkIds: indexes.map((i) => chunkId(key, i)),
    domain: "physical metallurgy / directional solidification",
    expertRole: "solidification processing specialist",
    markdown: body,
    synthesisAudit: synthesisAuditFor(key, body),
    ...extra,
  });
}

/**
 * One fact line accounting for every chunk a page delivered.
 *
 * A record now has to answer for its whole batch, so a fixture that writes
 * the same five sentences whatever arrived is testing a call the server no
 * longer accepts. The list form matters: coverage expands `chunk 5、6、9` into
 * all three, while the overstatement audit reads one number out of it and
 * sees a single-chunk sentence, so accounting for a page does not cost a
 * multi-chunk-fusion justification.
 */
/**
 * The pending-Wiki rows for ONE paper.
 *
 * Since a full-text page owes the Wiki per chunk, a paper this suite left open
 * mid-read shows up in every later commit's `stillPending`. That is correct
 * and is its own block's business; a block asking about PAPERTWO's
 * question-driven debt should not have to restate PAPERONE's reading state.
 */
function pendingFor(result, itemKey) {
  return (result.questionReading?.stillPending ?? []).filter(
    (row) => row.itemKey === itemKey,
  );
}

function coversPage(page) {
  const indexes = page.chunks.map((row) => row.chunkIndex);
  if (!indexes.length) return [];
  return [
    `本批其余各站是同一条深度序列上的读数，无独立数据（chunk ${indexes.join("、")}）。`,
  ];
}

function updateLegacyNote(key, facts, extra = {}) {
  const body = note(facts);
  return service.updateReadingNote({
    libraryID: 1,
    itemKey: key,
    markdown: body,
    synthesisAudit: synthesisAuditFor(key, body),
    ...extra,
  });
}

/**
 * A write-off reason with enough substance to pass the argue-don't-assert
 * check, for chunks these blocks are not really about.
 */
function writeOffReason(what) {
  return (
    `Those passages restate ${what} at the same stated values, and the Page already carries it as a ` +
    "Claim with its own excerpt; they add no condition, parameter or mechanism beyond what is stored."
  );
}

/** Every chunk of `key` still owing the Wiki, as a SKIP that writes them off. */
async function settleRest(key, what = "the depth-versus-station series") {
  const sessions = await store.readingSessions();
  const open = await sessions.openForItem(1, key);
  if (!open) return [];
  const owed = await sessions.pendingWikiChunks(open.sessionId);
  if (!owed.length) return [];
  return [
    {
      action: "SKIP",
      itemKey: key,
      chunkIds: owed.map((chunk) => chunk.chunkId),
      reason: writeOffReason(what),
    },
  ];
}

/**
 * The write-up that discharges the debt those turns incurred.
 *
 * `settle` names the papers whose remaining chunks should be written off, which
 * is what a real caller does once it has decided the rest of what it read adds
 * nothing: the Claim carries the chunk that mattered, and a SKIP accounts for
 * the others. Blocks that are ABOUT the settlement pass their own actions.
 */
async function writeUp(options) {
  const reviewItemKey = options.wikiReview
    ? (options.itemKey ?? options.evidence?.[0]?.itemKey)
    : undefined;
  const wikiReview = options.wikiReview
    ? {
        ...options.wikiReview,
        claimVerdicts: reviewItemKey
          ? (await store.listClaimsByEvidenceSource(1, reviewItemKey)).map(
              (claim) => ({
                claimId: claim.claimId,
                verdict: "confirmed",
                basis:
                  "The complete paper supports this Claim at the wording and scope currently stored.",
              }),
            )
          : [],
      }
    : undefined;
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    ...(reviewItemKey ? { itemKey: reviewItemKey } : {}),
    query: options.title,
    proposedPageTitles: [options.title],
    ...(wikiReview ? { wikiReview } : {}),
  });
  // By default, write off whatever the cited papers still owe. That is what a
  // caller does in practice - the Claim carries the chunk that mattered and a
  // SKIP accounts for the rest - and it keeps the blocks below about their own
  // subject. `settle: false` opts out, for the blocks that ARE about a debt
  // being left standing.
  const settle =
    options.settle === false
      ? []
      : (options.settle ??
        [...new Set((options.evidence ?? []).map((row) => row.itemKey))]);
  const skips = [];
  for (const key of settle) {
    skips.push(...(await settleRest(key)));
  }
  const result = await service.commit({
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
        evidence: options.evidence,
      },
      ...skips,
      ...(options.extraActions ?? []),
    ],
  });
  return { prepared, result };
}

/** Evidence quoting one real chunk of one paper. */
function evidenceFrom(key, index, readDepth = "section_read") {
  const chunk = indexedChunks.get(key)[index];
  return {
    libraryID: 1,
    itemKey: key,
    chunkIdSnapshot: chunk.chunkId,
    excerpt: chunk.text.slice(0, 60),
    evidenceRole: "SUPPORTS",
    readDepth,
  };
}

async function noteOnDisk(key) {
  const item = await fake.Zotero.Items.getByLibraryAndKeyAsync(1, key);
  const { isWikiReadingNoteAttachment } = await import(
    "../src/modules/wiki/wikiReadingNote.ts"
  );
  for (const id of item.getAttachments()) {
    const attachment = await fake.Zotero.Items.getAsync(id);
    if (isWikiReadingNoteAttachment(attachment)) {
      return fs.readFileSync(attachment.getFilePath(), "utf8");
    }
  }
  return null;
}

const tests = [];
function block(name, fn) {
  tests.push([name, fn]);
}

// =========================================================================
// 1. Scattered chunks accumulate as a set
// =========================================================================

block("random chunks accumulate, and repeats never inflate coverage", async () => {
  const first = await readByQuestion(
    "PAPERONE",
    [7, 8, 42],
    [
      "Depth rises roughly linearly with station number over the early traverse (chunk 7, chunk 8).",
      "At station 42 the response has flattened noticeably (chunk 42).",
    ],
  );
  assert.deepEqual(first.reading.newChunks, [7, 8, 42]);
  assert.equal(first.reading.deliveredChunks, 3);
  assert.equal(first.reading.totalChunks, LONG);
  assert.equal(first.reading.coverageComplete, false);

  await writeUp({
    title: "Melt-pool depth response",
    claimText: "Melt-pool depth rises with station number and then flattens.",
    evidence: [evidenceFrom("PAPERONE", 7)],
  });

  // A second question overlaps the first. 42 is read again; only 15 and 70 are
  // new, and the union is what the ledger holds.
  const second = await readByQuestion(
    "PAPERONE",
    [15, 42, 70],
    [
      "Depth rises roughly linearly with station number over the early traverse (chunk 7, chunk 8).",
      "The linear stretch persists at least to station 15 (chunk 15).",
      "At station 42 the response has flattened noticeably (chunk 42).",
      "By station 70 the depth is essentially constant (chunk 70).",
    ],
  );
  assert.deepEqual(second.reading.newChunks, [15, 70]);
  assert.deepEqual(second.reading.alreadyReadChunks, [42]);
  assert.equal(
    second.reading.deliveredChunks,
    5,
    "{7,8,42} then {15,42,70} is five distinct chunks, not six",
  );
  assert.equal(second.reading.readChunkRanges, "7-8,15,42,70");

  // Naming the same chunk twice inside ONE call is the same duplicate.
  await writeUp({
    title: "Melt-pool depth plateau",
    claimText: "The depth response flattens beyond the mid traverse.",
    evidence: [evidenceFrom("PAPERONE", 70)],
  });
  const third = await readByQuestion(
    "PAPERONE",
    [70, 70, 70, 71],
    [
      "Depth rises roughly linearly with station number over the early traverse (chunk 7, chunk 8).",
      "The linear stretch persists at least to station 15 (chunk 15).",
      "At station 42 the response has flattened noticeably (chunk 42).",
      "By station 70 the depth is essentially constant, and station 71 confirms it (chunk 70, chunk 71).",
    ],
  );
  assert.deepEqual(third.reading.newChunks, [71]);
  assert.equal(third.reading.deliveredChunks, 6);

  await writeUp({
    title: "Melt-pool plateau extent",
    claimText: "The plateau extends past station 71.",
    evidence: [evidenceFrom("PAPERONE", 71)],
  });
});

block("the note shows what has been read as filled and hollow squares", async () => {
  const raw = await noteOnDisk("PAPERONE");
  const parsed = parseReadingNote(raw);
  assert.equal(parsed.metadata.totalChunks, LONG);
  assert.equal(parsed.metadata.readChunks, "7-8,15,42,70-71");
  assert.equal(parsed.metadata.mode, "qa");

  const map = parsed.metadata.coverageMap;
  assert.equal(map.length, LONG, "80 chunks is under the cap: one cell each");
  assert.equal([...map].filter((cell) => cell === "■").length, 6);
  assert.equal([...map].filter((cell) => cell === "□").length, LONG - 6);
  assert.equal(map[7], "■");
  assert.equal(map[9], "□");

  // The map is in the file a person opens, not only in the JSON.
  assert.ok(raw.includes(map), "the bar is rendered into the document itself");
  assert.ok(/6 of 80 chunks read/u.test(raw));

  // Above the cap the bar is compressed rather than wrapped, and a partly-read
  // cell is drawn as a third state instead of being rounded either way.
  const wide = formatCoverageMap([0, 1, 2, 500], 400);
  assert.equal(wide.length, 100);
  assert.equal(wide[0], "◧", "one cell spans four chunks, three of them read");
  assert.equal(wide[1], "□");
});

// =========================================================================
// 2. The note comes first, and the Wiki second
// =========================================================================

block("a paper whose reading never reached the Wiki refuses to be read again", async () => {
  await readByQuestion(
    "PAPERTWO",
    [3, 4],
    ["The early stations behave as PAPERONE's do (chunk 3, chunk 4)."],
  );

  await assert.rejects(
    () =>
      readByQuestion(
        "PAPERTWO",
        [9],
        [
          "The early stations behave as PAPERONE's do (chunk 3, chunk 4).",
          "Station 9 continues the trend (chunk 9).",
        ],
      ),
    /are in its reading note but not yet in the Wiki/u,
    "the note may run one turn ahead of the Wiki, never two",
  );

  // Committing something that cites the paper discharges it.
  const { result } = await writeUp({
    title: "Early station behaviour",
    claimText: "Early stations show the same depth trend across both papers.",
    evidence: [evidenceFrom("PAPERTWO", 3)],
  });
  assert.deepEqual(result.questionReading.clearedPapers, ["PAPERTWO"]);

  const resumed = await readByQuestion(
    "PAPERTWO",
    [9],
    [
      "The early stations behave as PAPERONE's do (chunk 3, chunk 4).",
      "Station 9 continues the trend (chunk 9).",
    ],
  );
  assert.deepEqual(resumed.reading.newChunks, [9]);
});

block("a commit that ignores a paper leaves that paper's debt standing", async () => {
  // PAPERTWO owes chunk 9. A commit citing only PAPERONE must not clear it.
  const { result } = await writeUp({
    title: "Gradient range",
    claimText: "The imposed gradient cycles across the reported range.",
    evidence: [evidenceFrom("PAPERONE", 15)],
  });
  // PAPERONE owed nothing going in - its own reading was settled in full - so
  // there is nothing of it to clear, and citing it buys PAPERTWO nothing.
  assert.deepEqual(result.questionReading.clearedPapers, []);
  assert.deepEqual(result.questionReading.stillPending, [
    {
      itemKey: "PAPERTWO",
      pendingChunkIds: [chunkId("PAPERTWO", 9)],
      pendingChunks: 1,
    },
  ]);
  assert.match(result.questionReading.note, /PAPERTWO chunk\(s\) 2009/u);

  await writeUp({
    title: "Station nine",
    claimText: "Station 9 lies on the linear stretch.",
    evidence: [evidenceFrom("PAPERTWO", 9)],
  });
});

// =========================================================================
// 3. A short reading is still a real reading
// =========================================================================

block("a short reading record is accepted without a production quota", async () => {
  const full = [
    "The linear stretch persists at least to station 15 (chunk 15).",
    "At station 42 the response has flattened noticeably (chunk 42).",
    "By station 70 the depth is essentially constant, and station 71 confirms it (chunk 70, chunk 71).",
    "The imposed gradient cycles between 8 and 14 K/mm along the traverse, which is why the depth series is not monotonic in the raw data (chunk 7, chunk 8).",
  ];
  await readByQuestion("PAPERONE", [30], [...full, "Station 30 sits mid-plateau (chunk 30)."]);
  await writeUp({
    title: "Mid plateau",
    claimText: "Station 30 sits on the plateau.",
    evidence: [evidenceFrom("PAPERONE", 30)],
  });

  const kept = await readByQuestion("PAPERONE", [31], [
    "Depth rises then flattens (chunk 31).",
  ]);
  assert.deepEqual(kept.reading.newChunks, [31]);
  await writeUp({
    title: "Plateau onset",
    claimText: "The plateau begins near station 20.",
    evidence: [evidenceFrom("PAPERONE", 31)],
  });
});

block("a note without chunk citations cannot be saved at all", async () => {
  await assert.rejects(
    () =>
      service.updateReadingNote({
        libraryID: 1,
        itemKey: "PAPRTHRE",
        readChunkIds: [chunkId("PAPRTHRE", 0)],
        domain: "physical metallurgy",
        expertRole: "solidification specialist",
        markdown: [
          "# Dwell time",
          "",
          "## Research question",
          "Whether the hot-press dwell time changes the retained texture of the columnar array in any measurable way.",
          "",
          "## Findings",
          "Dwell time above ninety seconds makes no measurable difference to the retained texture, and the paper says so plainly.",
          "",
          "## Scope and limits",
          "A single alloy and a single press geometry, with no independent replication offered anywhere in the text.",
        ].join("\n"),
      }),
    /cites no chunk/u,
    "a fact with no chunk number is a fact that can never become Evidence",
  );
});

block("each new reading record is audited against this turn's chunks", async () => {
  await assert.rejects(
    () =>
      service.updateReadingNote({
        libraryID: 1,
        itemKey: "AUDITPAP",
        readChunkIds: [chunkId("AUDITPAP", 0)],
        domain: "physical metallurgy",
        expertRole: "solidification specialist",
        readingRecord:
          "The method completely eliminates every melt-pool depth error (chunk 0).",
      }),
    (error) =>
      error.name === "WikiSynthesisAuditRequired" &&
      /absolute-language/u.test(error.message),
  );
  await assert.rejects(
    () =>
      service.updateReadingNote({
        libraryID: 1,
        itemKey: "AUDITPAP",
        readChunkIds: [chunkId("AUDITPAP", 0)],
        domain: "physical metallurgy",
        expertRole: "solidification specialist",
        markdown:
          "The method completely eliminates every melt-pool depth error (chunk 0).",
      }),
    (error) =>
      error.name === "WikiSynthesisAuditRequired" &&
      /absolute-language/u.test(error.message),
    "the deprecated markdown alias must pass through the same audit",
  );

  const sessions = await store.readingSessions();
  const rejected = await sessions.openForItem(1, "AUDITPAP");
  assert.equal(
    (await sessions.coverage(rejected.sessionId)).deliveredChunks,
    0,
    "a rejected record books no reading",
  );

  const accepted = await service.updateReadingNote({
    libraryID: 1,
    itemKey: "AUDITPAP",
    readChunkIds: [chunkId("AUDITPAP", 0)],
    domain: "physical metallurgy",
    expertRole: "solidification specialist",
    readingRecord:
      "The paper reports melt-pool depth under an imposed gradient at the first station (chunk 0).",
  });
  assert.deepEqual(accepted.reading.newChunks, [0]);
  await service.finishReading({
    libraryID: 1,
    itemKey: "AUDITPAP",
    outcome: "skipped",
  });
});

/**
 * Wrap a fixture body in the five sections a FULL-TEXT record must arrive in.
 *
 * Question-driven records are exempt from the template - they answer for two
 * or three passages, not a page - so only the full-text fixtures below use
 * this.
 */
/** The seven sections a full-text macro summary must arrive in. */
function macroTemplated(body) {
  return [
    "## 本篇讲了什么",
    "这篇短通讯测量了给定热梯度下的熔池深度（chunk 0）。测量按编号站位逐个进行（chunk 0）。",
    "",
    "## 研究对象与材料",
    "镍基高温合金，在定向凝固台架上按编号站位测深（chunk 0）。样品范围仅限该台架（chunk 0）。",
    "",
    "## 核心方法",
    "夹具未给出更多方法细节（chunk 0）。表征手段留待原文补充（chunk 0）。",
    "",
    "## 主要结果",
    body,
    "",
    "## 机理解释",
    "夹具未给出机理（chunk 0）。因果链留待原文补充（chunk 0）。",
    "",
    "## 结论",
    "夹具未给出结论（chunk 0）。贡献部分同样留空（chunk 0）。",
    "",
    "## 边界与局限",
    "作者未讨论适用范围（chunk 0）。也没有给出对照（chunk 0）。",
  ].join(String.fromCharCode(10));
}

function templated(body) {
  return [
    "**阅读总结**",
    "本批讲的是熔池深度。",
    "",
    "**方法**",
    body,
    "",
    "**结果与结论**",
    "本批无结果数据。",
    "",
    "**概念与术语**",
    "无。",
    "",
    "**本批覆盖**",
    accountFor(body),
    "",
    "**存疑与未交代**",
    "无。",
  ].join(String.fromCharCode(10));
}

block("complete question reading can append a macro summary after expert reset", async () => {
  await service.updateReadingNote({
    libraryID: 1,
    itemKey: "QASUMMRY",
    readChunkIds: [chunkId("QASUMMRY", 0)],
    domain: "physical metallurgy",
    expertRole: "solidification specialist",
    readingRecord:
      "The paper reports melt-pool depth under an imposed gradient at the first station (chunk 0).",
  });
  const firstWrite = await writeUp({
    title: "QA summary station one",
    claimText: "The first station has a reported melt-pool depth.",
    evidence: [evidenceFrom("QASUMMRY", 0)],
  });
  await service.updateReadingNote({
    libraryID: 1,
    itemKey: "QASUMMRY",
    readChunkIds: [chunkId("QASUMMRY", 1)],
    domain: "physical metallurgy",
    expertRole: "solidification specialist",
    readingRecord:
      "The paper also reports melt-pool depth under an imposed gradient at the second station (chunk 1).",
  });
  const secondWrite = await writeUp({
    title: "QA summary station two",
    claimText: "The second station has a reported melt-pool depth.",
    evidence: [evidenceFrom("QASUMMRY", 1)],
  });

  await service.setReadingExpert({
    libraryID: 1,
    itemKey: "QASUMMRY",
    persona:
      "A solidification metallurgist reassessing the complete short paper from its abstract before synthesis.",
    focus: ["the imposed-gradient conditions", "the station-to-station comparison"],
  });
  const coreSummary =
    "The paper's core method compares melt-pool depth across two stations under an imposed gradient (chunk 0, chunk 1).";
  const summarised = await service.updateReadingNote({
    libraryID: 1,
    itemKey: "QASUMMRY",
    finalSynthesis: true,
    macroSummary: coreSummary,
    synthesisAudit: synthesisAuditFor("QASUMMRY", coreSummary),
  });

  assert.equal(summarised.mode, "qa");
  assert.equal(summarised.finalSynthesis, true);
  assert.equal(summarised.wikiReconciliation.readingRecords.length, 2);
  assert.deepEqual(
    summarised.wikiReconciliation.claims.map((claim) => claim.claimId).sort(),
    [firstWrite.result.refs.c, secondWrite.result.refs.c].sort(),
    "Claims are recalled by this paper's Evidence even when Page titles and query terms differ",
  );

  await service.recordConcepts({
    libraryID: 1,
    itemKey: "QASUMMRY",
    final: true,
    concepts: [],
    noConceptsReason: "The short paper introduces no terminology beyond existing library concepts.",
    confirmWrite: async () => {},
  });
  const firstClaim = await store.getClaim(firstWrite.result.refs.c);
  const secondClaim = await store.getClaim(secondWrite.result.refs.c);
  const replacement =
    "The first station has a reported melt-pool depth under the paper's imposed-gradient condition.";
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    itemKey: "QASUMMRY",
    query: "a deliberately unrelated query",
    wikiReview: {
      pages: "Both existing station Pages remain separate and need no title changes.",
      claims: "The first Claim is overstated and the second is factually contradicted.",
      evidence: "Both decisions are grounded in the passages from their respective stations.",
      concepts: "No concept needs adding, correcting, merging or removing for this paper.",
      relations: "No stored relation is added or withdrawn by the completed short paper.",
      claimVerdicts: [
        {
          claimId: firstClaim.claimId,
          verdict: "overstated",
          basis:
            "The stored wording omits the imposed-gradient condition attached to the reported measurement.",
          previousClaimText: firstClaim.claimText,
          replacementClaimText: replacement,
        },
        {
          claimId: secondClaim.claimId,
          verdict: "contradicted",
          basis:
            "The completed reading conflicts with the stored factual interpretation and requires human review.",
        },
      ],
    },
  });
  assert.deepEqual(
    prepared.wikiReconciliation.requiredClaimActions.map((row) => row.action),
    ["UPDATE_CLAIM", "MARK_CONFLICT"],
  );
  await assert.rejects(
    () =>
      service.commit({
        libraryID: 1,
        userInitiated: true,
        prepareToken: prepared.prepareToken,
        actions: [],
      }),
    /UPDATE_CLAIM.*MARK_CONFLICT/s,
    "reviewed reconciliation actions cannot be omitted from commit",
  );
  await service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: prepared.prepareToken,
    actions: [
      {
        action: "UPDATE_CLAIM",
        claimId: firstClaim.claimId,
        expectedVersion: firstClaim.version,
        claimText: replacement,
        evidence: [evidenceFrom("QASUMMRY", 0)],
      },
      {
        action: "MARK_CONFLICT",
        claimId: secondClaim.claimId,
        evidence: [
          {
            ...evidenceFrom("QASUMMRY", 1),
            evidenceRole: "CONTRADICTS",
          },
        ],
      },
    ],
  });
  assert.equal((await store.getClaim(firstClaim.claimId)).claimText, replacement);
  assert.equal(
    (await store.getClaim(secondClaim.claimId)).epistemicStatus,
    "disputed",
  );
  await service.finishReading({
    libraryID: 1,
    itemKey: "QASUMMRY",
    outcome: "skipped",
  });
});

// =========================================================================
// 4. Evidence resolves to something somebody read
// =========================================================================

block("evidence from an unread chunk is refused, naming the chunk", async () => {
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: "Unread evidence",
    proposedPageTitles: ["Unread evidence"],
  });
  await assert.rejects(
    () =>
      service.commit({
        libraryID: 1,
        userInitiated: true,
        prepareToken: prepared.prepareToken,
        actions: [
          { action: "CREATE_PAGE", ref: "p", canonicalTitle: "Unread evidence" },
          {
            action: "ADD_CLAIM",
            ref: "c",
            pageId: "p",
            claimText: "Something from a passage nobody looked at.",
            claimType: "mechanism",
            epistemicStatus: "provisional",
            coverageLevel: "chunk_local",
            confidence: 0.5,
            // Chunk 60 is genuinely in the paper and has genuinely never been
            // read: retrieval could have returned it, and that is not reading.
            evidence: [evidenceFrom("PAPERONE", 60, "chunk_local")],
          },
        ],
      }),
    (error) =>
      /quotes chunk 1060, which is not recorded as read/u.test(error.message) &&
      /readChunkIds including 1060/u.test(error.message),
    "the excerpt is real; the reading of it is what is missing",
  );
});

// =========================================================================
// 5. Question-driven coverage is never whole-paper depth
// =========================================================================

block("reading every chunk by question still is not paper_reviewed", async () => {
  // PAPRTHRE is six chunks. Answer one question that reads all of them.
  const all = await readByQuestion(
    "PAPRTHRE",
    [0, 1, 2, 3, 4, 5],
    [
      "Every station of this short paper reports the same depth to within the stated uncertainty (chunk 0, chunk 1, chunk 2, chunk 3, chunk 4, chunk 5).",
    ],
  );
  assert.equal(all.reading.coverageComplete, true, "delivery IS complete");
  assert.equal(all.reading.coveragePercent, 100);
  assert.equal(all.readDepthCeiling, "section_read");

  // Complete QA coverage is eligible for a macro summary, but the provisional
  // retrieval persona must first be reset from the abstract.
  await assert.rejects(
    () =>
      service.updateReadingNote({
        libraryID: 1,
        itemKey: "PAPRTHRE",
        finalSynthesis: true,
        markdown: note(["Everything agrees (chunk 0)."]),
      }),
    /provisional expert.*metadata and abstract/iu,
    "complete coverage by question still needs a deliberate final expert",
  );

  // And a commit asking for paper_reviewed is clamped and told why.
  const { result } = await writeUp({
    title: "Uniform depth",
    claimText: "Depth is uniform along the traverse in this short paper.",
    coverageLevel: "paper_reviewed",
    evidence: [evidenceFrom("PAPRTHRE", 0, "paper_reviewed")],
  });
  assert.ok(
    result.warnings.some((warning) =>
      /read by answering questions, which is not a full-text reading/u.test(
        warning,
      ),
    ),
    "the clamp explains itself rather than silently downgrading",
  );
  const claim = await store.getClaim(result.refs.c);
  const depths = (claim?.evidence ?? []).map((row) => row.readDepth);
  assert.deepEqual(depths, ["section_read"]);
});

// =========================================================================
// 6. The full-text read continues what the questions read
// =========================================================================

block("a full-text read inherits the chunks and the note the questions left", async () => {
  const opened = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPRTHRE",
  });
  assert.equal(opened.phase, "expert_briefing");
  assert.equal(
    opened.carriedOverFromQuestionAnswering.chunksAlreadyRead,
    SHORT,
    "the whole paper was already read by question, and the read says so",
  );
  assert.equal(
    opened.pagination.deliveredChunks,
    SHORT,
    "the briefing reports real coverage, not zero",
  );

  // The provisional reader a question assembled is replaceable; a considered
  // one is still asked for before a full-text pass.
  await service.setReadingExpert({
    libraryID: 1,
    itemKey: "PAPRTHRE",
    persona:
      "A solidification metallurgist reading this short communication in full to settle whether its uniform-depth result holds outside the reported gradient range.",
    focus: ["the uncertainty budget", "the gradient range actually covered"],
  });

  const page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPRTHRE",
  });
  assert.equal(page.phase, "reading");
  assert.equal(
    page.chunks.length,
    0,
    "nothing is left to deliver: paging skips what the questions already read",
  );
  assert.equal(page.pagination.coverageComplete, true);
  assert.ok(
    page.readingNote.bodyChars > 0,
    "and it is the SAME note, not a fresh one",
  );

  // Now - and only now - the synthesis is available. It is also the one call
  // whose sentences are checked against the chunks, and this note has the
  // shape that check exists for: one sentence generalising across every chunk
  // of the paper. Sent without proof it is refused, and nothing is written.
  const acrossEveryChunk =
    "Every station of this short paper reports the same depth to within the stated uncertainty (chunk 0, chunk 1, chunk 2, chunk 3, chunk 4, chunk 5).";
  const bounded =
    "Read as a whole the paper is a single-condition confirmation, bounded by the one gradient range it covers (chunk 0).";
  // A full-text macro summary arrives in the seven-section template, so the
  // two sentences under test sit in it rather than in the free-form note
  // shape the question path still uses.
  const synthesisNote = () =>
    macroTemplated([acrossEveryChunk, bounded].join(String.fromCharCode(10, 10)));

  const refused = await service
    .updateReadingNote({
      libraryID: 1,
      itemKey: "PAPRTHRE",
      finalSynthesis: true,
      markdown: synthesisNote(),
    })
    .then(
      () => null,
      (error) => error,
    );
  assert.ok(refused, "a generalisation across six chunks is not written unproved");
  assert.equal(refused.name, "WikiSynthesisAuditRequired");
  assert.match(refused.message, /multi-chunk-fusion/u);

  // Proved, one quotation per cited chunk, copied verbatim out of each.
  const synthesised = await service.updateReadingNote({
    libraryID: 1,
    itemKey: "PAPRTHRE",
    finalSynthesis: true,
    markdown: synthesisNote(),
    synthesisAudit: [
      {
        sentence: acrossEveryChunk,
        support: Array.from({ length: 6 }, (_, i) => ({
          chunkId: i,
          quote: indexedChunks.get("PAPRTHRE")[i].text.slice(21),
        })),
      },
    ],
  });
  assert.equal(synthesised.finalSynthesis, true);
});

block("failed final concept writes preserve staged data until retry", async () => {
  const sessions = await store.readingSessions();
  await assert.rejects(
    () =>
      service.recordConcepts({
        libraryID: 1,
        itemKey: "PAPRTHRE",
        concepts: [{ primaryTerm: { abbr: "MPD" } }],
      }),
    /staged concept batch is invalid.*Nothing was staged/iu,
  );
  await assert.rejects(
    () =>
      service.recordConcepts({
        libraryID: 1,
        itemKey: "PAPRTHRE",
        concepts: [
          {
            primaryTerm: { en: "invalid staged source" },
            sources: [{ itemKey: "NOTFOUND" }],
          },
        ],
      }),
    /NOTFOUND is not a Zotero document.*Nothing was staged/iu,
  );
  assert.equal(
    (await sessions.openForItem(1, "PAPRTHRE")).stagedConcepts.length,
    0,
    "invalid staging is atomic and a corrected call can retry directly",
  );

  await service.recordConcepts({
    libraryID: 1,
    itemKey: "PAPRTHRE",
    concepts: [
      {
        primaryTerm: { en: "melt-pool depth" },
        sources: [{ itemKey: "PAPRTHRE" }],
      },
    ],
  });

  await assert.rejects(
    () =>
      service.recordConcepts({
        libraryID: 1,
        itemKey: "PAPRTHRE",
        final: true,
        concepts: [],
        confirmWrite: async () => {
          throw new Error("user cancelled concept confirmation");
        },
      }),
    /user cancelled concept confirmation/u,
  );
  const assertConceptRetryState = async () => {
    const session = await sessions.openForItem(1, "PAPRTHRE");
    assert.equal(session.stagedConcepts.length, 1);
    assert.equal(session.conceptsRecordedAt, null);
  };
  await assertConceptRetryState();

  await assert.rejects(
    () =>
      service.recordConcepts({
        libraryID: 1,
        itemKey: "PAPRTHRE",
        final: true,
        concepts: [{ primaryTerm: { abbr: "MPD" } }],
        confirmWrite: async () => {},
      }),
    /abbreviation on its own.*staged concepts remain staged/iu,
  );
  await assertConceptRetryState();

  await assert.rejects(
    () =>
      service.recordConcepts({
        libraryID: 1,
        itemKey: "PAPRTHRE",
        final: true,
        concepts: [
          {
            primaryTerm: { en: "invalid-source concept" },
            sources: [{ itemKey: "NOTFOUND" }],
          },
        ],
        confirmWrite: async () => {},
      }),
    /NOTFOUND is not a Zotero document.*staged concepts remain staged/iu,
  );
  await assertConceptRetryState();

  const queryAsync = database.queryAsync;
  database.queryAsync = async (sql, params) => {
    if (/^\s*INSERT INTO wiki_concepts\b/iu.test(sql)) {
      throw new Error("concept database write failed");
    }
    return queryAsync(sql, params);
  };
  try {
    await assert.rejects(
      () =>
        service.recordConcepts({
          libraryID: 1,
          itemKey: "PAPRTHRE",
          final: true,
          concepts: [],
          confirmWrite: async () => {},
        }),
      /concept database write failed/u,
    );
  } finally {
    database.queryAsync = queryAsync;
  }
  await assertConceptRetryState();
  assert.equal(
    sqlite
      .prepare("SELECT COUNT(*) AS count FROM wiki_concepts WHERE canonical_name = ?")
      .get("melt-pool depth").count,
    0,
    "the failed concept transaction must leave no partial concept row",
  );

  await assert.rejects(
    () =>
      service.recordConcepts({
        libraryID: 1,
        itemKey: "PAPRTHRE",
        final: true,
        concepts: [],
        confirmWrite: async () => {
          await service.recordConcepts({
            libraryID: 1,
            itemKey: "PAPRTHRE",
            concepts: [
              {
                primaryTerm: { en: "thermal gradient" },
                sources: [{ itemKey: "PAPRTHRE" }],
              },
            ],
          });
        },
      }),
    /Staged concepts changed.*Nothing was written or marked complete/iu,
  );
  const afterConcurrentStage = await sessions.openForItem(1, "PAPRTHRE");
  assert.equal(afterConcurrentStage.stagedConcepts.length, 2);
  assert.equal(afterConcurrentStage.conceptsRecordedAt, null);
  for (const name of ["melt-pool depth", "thermal gradient"]) {
    assert.equal(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM wiki_concepts WHERE canonical_name = ?")
        .get(name).count,
      0,
      `the stale final snapshot must roll back ${name}`,
    );
  }

  await service.recordConcepts({
    libraryID: 1,
    itemKey: "PAPRTHRE",
    final: true,
    concepts: [],
    noConceptsReason: "nothing beyond what the library already holds",
    confirmWrite: async () => {},
  });
  const afterRetry = await sessions.openForItem(1, "PAPRTHRE");
  assert.equal(afterRetry.stagedConcepts.length, 0);
  assert.notEqual(afterRetry.conceptsRecordedAt, null);
  assert.equal(
    sqlite
      .prepare("SELECT COUNT(*) AS count FROM wiki_concepts WHERE canonical_name = ?")
      .get("melt-pool depth").count,
    1,
    "a successful retry writes the staged concept exactly once",
  );
  assert.equal(
    sqlite
      .prepare("SELECT COUNT(*) AS count FROM wiki_concepts WHERE canonical_name = ?")
      .get("thermal gradient").count,
    1,
    "a successful retry also writes the concept staged during the failed final",
  );
});

block("only after the whole-Wiki review does the write-up start", async () => {
  await assert.rejects(
    () =>
      service.prepareUpdate({
        libraryID: 1,
        query: "Uniform depth",
        proposedPageTitles: ["Uniform depth"],
      }),
    /review the WHOLE Wiki against the finished paper/u,
    "the terminology pass is not the review; it is one axis of it",
  );

  const { result } = await writeUp({
    title: "Uniform depth confirmed",
    claimText: "Depth uniformity holds across the reported gradient range.",
    coverageLevel: "paper_reviewed",
    evidence: [evidenceFrom("PAPRTHRE", 2, "paper_reviewed")],
    wikiReview: {
      pages: "The Uniform depth Page already covers this; it is extended rather than duplicated.",
      claims: "The earlier section_read claim is confirmed and now carries full-paper evidence.",
      evidence: "The claim was thin on evidence; the completed read attaches a second excerpt.",
      concepts: "No new terminology: melt-pool depth and imposed gradient are already held.",
      relations: "No relation between stored concepts is added or withdrawn by this paper.",
    },
  });
  assert.equal(
    result.readingSession.state,
    "committed",
    "a full-text read that is committed closes and frees the library",
  );
  assert.ok(
    !result.warnings.some((w) => /not a full-text reading/u.test(w)),
    "and paper_reviewed is honoured now that the paper really was read whole",
  );
});

// =========================================================================
// 7. One question, several papers; and the lock that still holds
// =========================================================================

block("questions read several papers at once; the full-text slot is not taken", async () => {
  const one = await readByQuestion("PAPERONE", [50], [
    "The linear stretch persists at least to station 15 (chunk 15).",
    "At station 42 the response has flattened noticeably (chunk 42).",
    "By station 70 the depth is essentially constant, and station 71 confirms it (chunk 70, chunk 71).",
    "The imposed gradient cycles between 8 and 14 K/mm along the traverse (chunk 7, chunk 8).",
    "Station 30 sits mid-plateau, and station 31 with it (chunk 30, chunk 31).",
    "Station 50 is squarely on the plateau (chunk 50).",
  ]);
  const two = await readByQuestion("PAPERTWO", [50], [
    "The early stations behave as PAPERONE's do (chunk 3, chunk 4).",
    "Station 9 continues the trend (chunk 9).",
    "Station 50 shows the same plateau PAPERONE reaches (chunk 50).",
  ]);
  assert.equal(one.mode, "qa");
  assert.equal(two.mode, "qa");

  // Both are open at once, which the old exclusive index made impossible.
  const sessions = await store.readingSessions();
  const open = await sessions.listOpen(1);
  const keys = open.map((session) => session.itemKey).sort();
  assert.deepEqual(keys, ["PAPERONE", "PAPERTWO"]);
  assert.equal(
    await sessions.getOpen(1),
    null,
    "and neither of them holds the full-text slot",
  );

  // One commit writes both up.
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: "Shared plateau",
    proposedPageTitles: ["Shared plateau"],
  });
  assert.deepEqual(
    prepared.pendingWikiWriteUp.map((row) => row.itemKey).sort(),
    ["PAPERONE", "PAPERTWO"],
    "prepare names every paper whose note is ahead of the Wiki",
  );
  const result = await service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: prepared.prepareToken,
    actions: [
      { action: "CREATE_PAGE", ref: "p", canonicalTitle: "Shared plateau" },
      {
        action: "ADD_CLAIM",
        ref: "c",
        pageId: "p",
        claimText: "Both papers reach a depth plateau by station 50.",
        claimType: "comparison",
        epistemicStatus: "provisional",
        coverageLevel: "chunk_local",
        confidence: 0.7,
        evidence: [evidenceFrom("PAPERONE", 50), evidenceFrom("PAPERTWO", 50)],
      },
    ],
  });
  assert.deepEqual(
    result.questionReading.clearedPapers.sort(),
    ["PAPERONE", "PAPERTWO"],
  );
  assert.deepEqual(result.questionReading.stillPending, []);
});

block("the full-text slot still admits one paper, and says so usefully", async () => {
  const opened = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPERONE",
  });
  assert.equal(opened.phase, "expert_briefing");
  await service.setReadingExpert({
    libraryID: 1,
    itemKey: "PAPERONE",
    persona:
      "A solidification metallurgist reading this paper end to end to establish where the depth response stops being linear and why.",
    focus: ["the plateau onset", "the gradient correction"],
  });

  await assert.rejects(
    () =>
      service.buildFromPaper({
        libraryID: 1,
        userRequested: true,
        itemKey: "PAPERTWO",
      }),
    (error) =>
      error.name === "WikiReadingSessionConflict" &&
      /Answering a QUESTION about PAPERTWO is not blocked by this/u.test(
        error.message,
      ),
    "one full-text read at a time, and the refusal names the way round it",
  );

  // The way round it works: PAPERTWO can still be read by question.
  const stillReadable = await readByQuestion("PAPERTWO", [51], [
    "The early stations behave as PAPERONE's do (chunk 3, chunk 4).",
    "Station 9 continues the trend (chunk 9).",
    "Station 50 shows the same plateau PAPERONE reaches, and 51 with it (chunk 50, chunk 51).",
  ]);
  assert.deepEqual(stillReadable.reading.newChunks, [51]);

  // Paging PAPERONE resumes past what the questions already read.
  const page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPERONE",
    limit: 5,
  });
  assert.equal(
    page.chunks[0].chunkIndex,
    0,
    "chunk 0 was never read by any question, so that is where it starts",
  );
  assert.equal(
    page.carriedOverFromQuestionAnswering.chunksAlreadyRead,
    9,
    "and the read knows how much it inherited",
  );
  assert.equal(page.pagination.readChunkRanges, "0-4,7-8,15,30-31,42,50,70-71");
  assert.match(page.pagination.unreadChunkRanges, /^5-6,9-14,16-29/u);
  await updateLegacyNote("PAPERONE", [
      "The imposed gradient cycles between 8 and 14 K/mm along the traverse (chunk 7, chunk 8).",
      "The linear stretch persists at least to station 15 (chunk 15).",
      "At station 42 the response has flattened noticeably (chunk 42).",
      "By station 70 the depth is essentially constant, and 71 confirms it (chunk 70, chunk 71).",
      "Stations 30, 31 and 50 sit on the plateau (chunk 30, chunk 31, chunk 50).",
      "The opening full-text batch establishes the rig geometry and initial traverse response (chunk 0, chunk 1, chunk 2, chunk 3, chunk 4).",
    ]);

  // That page owes the Wiki per chunk, the same as a question's passages do.
  // Settle it here so the blocks below are testing their own subject rather
  // than this one's leftovers - and so the debt this suite is about stays
  // legible.
  const openedPrepare = await service.prepareUpdate({
    libraryID: 1,
    query: "Opening traverse",
    proposedPageTitles: ["Opening traverse"],
  });
  await service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: openedPrepare.prepareToken,
    actions: [
      {
        action: "SKIP",
        itemKey: "PAPERONE",
        chunkIds: [0, 1, 2, 3, 4].map((index) => chunkId("PAPERONE", index)),
        reason: writeOffReason(
          "the opening stations of the traverse, which repeat the rig description already held",
        ),
      },
    ],
  });
});

// =========================================================================
// 8. Things that are not reading
// =========================================================================

block("a body-less paper cannot be read, and chunk ids are checked", async () => {
  // Clear PAPERTWO's outstanding debt first: the note-before-Wiki gate is
  // checked before the chunk ids are, and this block is about the ids.
  await writeUp({
    title: "Station fifty-one",
    claimText: "Station 51 is on the plateau in the second paper too.",
    evidence: [evidenceFrom("PAPERTWO", 51)],
  });

  await assert.rejects(
    () =>
      readByQuestion("ABSTONLY", [0], [
        "Something from an abstract (chunk 0).",
      ]),
    /holds only metadata\/abstract chunks/u,
    "reading a paper means reading its body",
  );

  await assert.rejects(
    () =>
      service.updateReadingNote({
        libraryID: 1,
        itemKey: "PAPERTWO",
        // A chunkId belonging to PAPERONE, and a bare index mistaken for an id.
        readChunkIds: [chunkId("PAPERONE", 3), 4],
        markdown: note(["Anything at all (chunk 3)."]),
      }),
    /are not passages of PAPERTWO: 1003, 4/u,
    "an id from the wrong paper is reported rather than counted as reading",
  );
});

// =========================================================================
// 9. The debt is settled chunk by chunk, not paper by paper
// =========================================================================

block("one Claim settles the chunk it quotes, and only that chunk", async () => {
  // The exact shape of the bug this block exists for: five chunks read, one
  // Claim written, and every one of the five recorded as written up.
  const read = await readByQuestion(
    "PAPERTWO",
    [10, 11, 35, 48, 60],
    [
      "The early stations behave as PAPERONE's do (chunk 3, chunk 4).",
      "Station 9 continues the trend (chunk 9).",
      "Station 50 shows the same plateau PAPERONE reaches, and 51 with it (chunk 50, chunk 51).",
      "Depth at stations 10 and 11 is equal to within the stated uncertainty (chunk 10, chunk 11).",
      "Station 35 is where the series first departs from linear (chunk 35).",
      "Stations 48 and 60 are both on the plateau (chunk 48, chunk 60).",
    ],
  );
  assert.deepEqual(read.wikiDebt.chunkIndexes, [10, 11, 35, 48, 60]);

  const { result } = await writeUp({
    title: "Departure from linearity",
    claimText: "The depth series first departs from linear near station 35.",
    evidence: [evidenceFrom("PAPERTWO", 35)],
    settle: false,
  });
  assert.deepEqual(result.questionReading.settledByEvidence, [
    { itemKey: "PAPERTWO", chunkIds: [chunkId("PAPERTWO", 35)] },
  ]);
  assert.deepEqual(result.questionReading.clearedPapers, []);
  assert.deepEqual(pendingFor(result, "PAPERTWO"), [
    {
      itemKey: "PAPERTWO",
      pendingChunkIds: [10, 11, 48, 60].map((i) => chunkId("PAPERTWO", i)),
      pendingChunks: 4,
    },
  ]);

  // And the paper is still closed to further reading, naming what it owes.
  await assert.rejects(
    () =>
      readByQuestion("PAPERTWO", [61], [
        "Station 61 is on the plateau too (chunk 61).",
      ]),
    (error) =>
      /are in its reading note but not yet in the Wiki/u.test(error.message) &&
      /2010, 2011, 2048, 2060/u.test(error.message),
    "the refusal names the outstanding chunks rather than a count",
  );
});

block("a write-off settles the rest, but only if it argues", async () => {
  const owed = [10, 11, 48, 60].map((i) => chunkId("PAPERTWO", i));

  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: "Plateau extent",
    proposedPageTitles: ["Plateau extent"],
  });
  assert.deepEqual(
    prepared.pendingWikiWriteUp,
    [{ itemKey: "PAPERTWO", mode: "qa", pendingChunkIds: owed, pendingChunks: 4 }],
    "prepare names the chunk ids the write-up has to account for",
  );

  const commitWith = (skip) =>
    service.commit({
      libraryID: 1,
      userInitiated: true,
      prepareToken: prepared.prepareToken,
      actions: [
        { action: "CREATE_PAGE", ref: "p", canonicalTitle: "Plateau extent" },
        {
          action: "ADD_CLAIM",
          ref: "c",
          pageId: "p",
          claimText: "The plateau covers stations 48 through 60.",
          claimType: "mechanism",
          epistemicStatus: "provisional",
          coverageLevel: "chunk_local",
          confidence: 0.7,
          evidence: [evidenceFrom("PAPERTWO", 48)],
        },
        skip,
      ],
    });

  // "Nothing new" is exactly what a reader who read nothing would write.
  await assert.rejects(
    () =>
      commitWith({
        action: "SKIP",
        itemKey: "PAPERTWO",
        chunkIds: [chunkId("PAPERTWO", 10)],
        reason: "no new knowledge",
      }),
    /asserts rather than argues/u,
    "a reason that only asserts is refused",
  );

  // Not the reflex answer, but still too short to be an argument.
  await assert.rejects(
    () =>
      commitWith({
        action: "SKIP",
        itemKey: "PAPERTWO",
        chunkIds: [chunkId("PAPERTWO", 10)],
        reason: "Covered by the plateau claim.",
      }),
    /needs a reason of at least 40 characters/u,
    "and so is one too short to contain an argument",
  );

  // A chunk that owes nothing cannot be written off.
  await assert.rejects(
    () =>
      commitWith({
        action: "SKIP",
        itemKey: "PAPERTWO",
        chunkIds: [chunkId("PAPERTWO", 35)],
        reason: writeOffReason("the departure from linearity"),
      }),
    /do not owe the Wiki anything/u,
    "chunk 35 was settled by its own Claim already",
  );

  // Nothing above was written: a refused write-off fails the whole commit.
  const sessions = await store.readingSessions();
  const stillOpen = await sessions.openForItem(1, "PAPERTWO");
  assert.equal(
    (await sessions.pendingWikiChunks(stillOpen.sessionId)).length,
    4,
    "a refused write-off leaves the debt exactly as it was",
  );

  const result = await commitWith({
    action: "SKIP",
    itemKey: "PAPERTWO",
    chunkIds: [10, 11, 60].map((i) => chunkId("PAPERTWO", i)),
    reason:
      "Stations 10, 11 and 60 restate the depth-versus-station series at values the Plateau extent " +
      "Page already carries, and add no condition, parameter or mechanism beyond the claim just written.",
  });
  assert.deepEqual(result.questionReading.clearedPapers, ["PAPERTWO"]);
  assert.equal(result.questionReading.settledAsNoUpdate.length, 1);
  assert.deepEqual(
    result.questionReading.settledAsNoUpdate[0].chunkIds,
    [10, 11, 60].map((i) => chunkId("PAPERTWO", i)),
  );

  // The judgement is kept, not merely honoured once.
  const declarations = await sessions.noUpdateDeclarations(
    stillOpen.sessionId,
  );
  const mine = declarations.find((entry) =>
    /Plateau extent/u.test(entry.reason),
  );
  assert.ok(mine, "the reason is stored, not just accepted and dropped");
  assert.deepEqual(mine.chunkIndexes, [10, 11, 60]);
  assert.ok(
    declarations.every((entry) => entry.reason.length >= 40),
    "and every write-off ever accepted carries a real reason",
  );

  // Settled in full, so the paper opens to questions again.
  const resumed = await readByQuestion("PAPERTWO", [61], [
    "The early stations behave as PAPERONE's do (chunk 3, chunk 4).",
    "Station 9 continues the trend (chunk 9).",
    "Station 50 shows the same plateau PAPERONE reaches, and 51 with it (chunk 50, chunk 51).",
    "Depth at stations 10 and 11 is equal to within the stated uncertainty (chunk 10, chunk 11).",
    "Station 35 is where the series first departs from linear (chunk 35).",
    "Stations 48, 60 and 61 are all on the plateau (chunk 48, chunk 60, chunk 61).",
  ]);
  assert.deepEqual(resumed.reading.newChunks, [61]);
  await writeUp({
    title: "Plateau at sixty-one",
    claimText: "Station 61 is on the plateau.",
    evidence: [evidenceFrom("PAPERTWO", 61)],
  });
});

block("a whole turn may be written off, and re-reading is never charged", async () => {
  await readByQuestion("PAPERTWO", [70, 71], [
    "The early stations behave as PAPERONE's do (chunk 3, chunk 4).",
    "Station 9 continues the trend (chunk 9).",
    "Station 50 shows the same plateau PAPERONE reaches, and 51 with it (chunk 50, chunk 51).",
    "Depth at stations 10 and 11 is equal to within the stated uncertainty (chunk 10, chunk 11).",
    "Station 35 is where the series first departs from linear (chunk 35).",
    "Stations 48, 60 and 61 are all on the plateau (chunk 48, chunk 60, chunk 61).",
    "Stations 70 and 71 repeat the plateau reading at the same values (chunk 70, chunk 71).",
  ]);

  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: "Plateau at sixty-one",
    proposedPageTitles: ["Plateau at sixty-one"],
  });
  // No Claim at all: the whole turn established nothing the Wiki lacked. That
  // is allowed, and it is the reason - not the absence of a Claim - that has
  // to carry the weight.
  const result = await service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: prepared.prepareToken,
    actions: [
      {
        action: "SKIP",
        itemKey: "PAPERTWO",
        chunkIds: [70, 71].map((i) => chunkId("PAPERTWO", i)),
        reason:
          "Stations 70 and 71 repeat the plateau depth at the same values already stored for stations " +
          "48 to 61, and introduce no new condition, parameter, mechanism or terminology.",
      },
    ],
  });
  assert.deepEqual(result.questionReading.clearedPapers, ["PAPERTWO"]);

  // Re-reading a chunk to check a quotation owes nothing: it is not new
  // knowledge, and charging it would mean no paper could be quoted twice
  // without a Claim in between.
  const reread = await readByQuestion("PAPERTWO", [70], [
    "The early stations behave as PAPERONE's do (chunk 3, chunk 4).",
    "Station 9 continues the trend (chunk 9).",
    "Station 50 shows the same plateau PAPERONE reaches, and 51 with it (chunk 50, chunk 51).",
    "Depth at stations 10 and 11 is equal to within the stated uncertainty (chunk 10, chunk 11).",
    "Station 35 is where the series first departs from linear (chunk 35).",
    "Stations 48, 60 and 61 are all on the plateau (chunk 48, chunk 60, chunk 61).",
    "Stations 70 and 71 repeat the plateau reading at the same values, checked again (chunk 70, chunk 71).",
  ]);
  assert.deepEqual(reread.reading.newChunks, []);
  assert.deepEqual(reread.reading.alreadyReadChunks, [70]);
  assert.equal(reread.wikiDebt.count, 0, "a re-read incurs no debt");
});

// =========================================================================
// 10. A full-text read never re-delivers what a question already read
// =========================================================================

block("paging over holes converges rather than stalling", async () => {
  // PAPERONE was read scattershot by every block above. Page it to the end and
  // check that the reading terminates with real full coverage rather than
  // looping on an empty page or declaring itself done with holes left.
  const sessions = await store.readingSessions();
  const before = await sessions.coverageForItem(1, "PAPERONE");
  assert.ok(before.deliveredChunks > 0 && !before.complete, "holes to close");

  // PAPERONE is already open for full-text reading, with its expert, from the
  // block above; this continues that read rather than starting a second one.
  let page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPERONE",
    limit: 12,
  });
  const seen = [...page.chunks.map((row) => row.chunkIndex)];
  let guard = 0;
  while (page.pagination.hasMore) {
    assert.ok((guard += 1) < 40, "paging must terminate");
    await updateLegacyNote("PAPERONE", [
        "The imposed gradient cycles between 8 and 14 K/mm along the traverse (chunk 7, chunk 8).",
        "The linear stretch persists at least to station 15 (chunk 15).",
        "At station 42 the response has flattened noticeably (chunk 42).",
        "By station 70 the depth is essentially constant, and 71 confirms it (chunk 70, chunk 71).",
        "Stations 30, 31 and 50 sit on the plateau (chunk 30, chunk 31, chunk 50).",
        `Reading the traverse through confirms one continuous series across all ${LONG} stations.`,
        ...coversPage(page),
      ]);
    page = await service.buildFromPaper({
      libraryID: 1,
      userRequested: true,
      cursor: page.pagination.nextCursor,
    });
    seen.push(...page.chunks.map((row) => row.chunkIndex));
  }
  assert.equal(
    new Set(seen).size,
    seen.length,
    "no chunk is delivered twice across the whole pass",
  );
  const after = await sessions.coverageForItem(1, "PAPERONE");
  assert.equal(after.complete, true, "and the paper really is fully covered");
  assert.equal(after.deliveredChunks, LONG);
  assert.equal(
    seen.length,
    LONG - before.deliveredChunks,
    "exactly the chunks the questions had not reached, and no more",
  );

  // Release the full-text slot for the blocks below.
  await service.finishReading({
    libraryID: 1,
    itemKey: "PAPERONE",
    outcome: "skipped",
  });
});

block("paging walks the unread chunks, wherever the holes are", async () => {
  // Scattered reading, deliberately not a prefix: {1, 3} of a six-chunk paper.
  // The note cites only what this question was actually shown. Citing chunks
  // 0, 2, 4 and 5 here would be the failure the citation rule catches: a
  // reading that has seen two chunks of six cannot have taken anything from
  // the other four, and a number that resolves to nothing is worse than none.
  await readByQuestion("HOLEPAPR", [1, 3], [
    "Stations 1 and 3 report the same depth to within the stated uncertainty (chunk 1, chunk 3).",
    "What the two stations have in common is the single gradient condition they were measured under (chunk 1).",
    "Whether the remaining stations agree is not established by this reading (chunk 3).",
  ]);
  await writeUp({
    title: "Short paper agreement",
    claimText: "Stations 1 and 3 agree in the short communication.",
    evidence: [evidenceFrom("HOLEPAPR", 1)],
  });

  await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "HOLEPAPR",
  });
  await service.setReadingExpert({
    libraryID: 1,
    itemKey: "HOLEPAPR",
    persona:
      "A solidification metallurgist reading this short communication end to end for its uncertainty budget.",
    focus: ["the uncertainty budget", "the gradient range covered"],
  });

  const page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "HOLEPAPR",
    limit: 6,
  });
  assert.deepEqual(
    page.chunks.map((row) => row.chunkIndex),
    [0, 2, 4, 5],
    "1 and 3 are already read, so the page is the four that are not",
  );
  assert.deepEqual(page.pagination.skippedAlreadyReadChunkIndexes, [1, 3]);
  assert.match(page.pagination.skippedNote, /already been read/u);
  assert.equal(
    page.pagination.coverageComplete,
    true,
    "and that one page completes the paper",
  );
  assert.equal(page.pagination.hasMore, false);

  await assert.rejects(
    () =>
      service.updateReadingNote({
        libraryID: 1,
        itemKey: "HOLEPAPR",
        readingRecord: templated(
          "- Chunk 3 discusses melt-pool depth at its station (chunk 3).",
        ),
      }),
    /cannot resolve|not been delivered/iu,
    "a QA chunk already integrated into the note is not a source for the new full-text record",
  );

  await service.updateReadingNote({
    libraryID: 1,
    itemKey: "HOLEPAPR",
    readingRecord: templated(
      "- The earlier holes report melt-pool depth under imposed gradients (chunk 0、2、4、5).",
    ),
  });
  const records = parseAppendOnlyReadingNote(
    parseReadingNote(await noteOnDisk("HOLEPAPR")).body,
  ).records;
  assert.deepEqual(
    records.at(-1).chunkIds,
    [0, 2, 4, 5],
    "the record names exactly the chunks delivered since the previous integration",
  );

  // Asking for a skipped chunk by offset still delivers it: this is how an
  // excerpt gets checked against its source before it becomes Evidence.
  const reread = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "HOLEPAPR",
    offset: 3,
    limit: 1,
  });
  assert.deepEqual(reread.chunks.map((row) => row.chunkIndex), [3]);
  assert.equal(
    reread.pagination.skippedAlreadyReadChunkIndexes,
    undefined,
    "an explicit offset takes the plain slice it asked for",
  );

  // Release the slot for the block below.
  await service.finishReading({
    libraryID: 1,
    itemKey: "HOLEPAPR",
    outcome: "skipped",
  });
});

// =========================================================================
// 11. The whole-Wiki review cannot be banked before there is a paper to review
// =========================================================================

block("the final review is refused, and not stored, on an unfinished paper", async () => {
  const REVIEW = {
    pages: "Nothing to change; the existing Page already covers this subject.",
    claims: "Nothing to merge or correct among the claims already stored here.",
    evidence: "Evidence already attached is sufficient for every stored claim.",
    concepts: "No terminology beyond what the concept library already holds.",
    relations: "No relation between stored concepts is added or withdrawn.",
  };

  await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPERTWO",
  });
  await service.setReadingExpert({
    libraryID: 1,
    itemKey: "PAPERTWO",
    persona:
      "A solidification metallurgist reading this paper end to end to establish where the plateau begins.",
    focus: ["the plateau onset", "the uncertainty budget"],
  });
  const page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPERTWO",
    limit: 5,
  });
  assert.equal(page.pagination.coverageComplete, false);

  await assert.rejects(
    () =>
      service.prepareUpdate({
        libraryID: 1,
        query: "Premature review",
        proposedPageTitles: ["Premature review"],
        wikiReview: REVIEW,
      }),
    (error) =>
      /LAST pass over a finished paper/u.test(error.message) &&
      /Nothing was recorded/u.test(error.message),
    "reviewing the Wiki against half a paper is not the final pass",
  );

  const sessions = await store.readingSessions();
  const open = await sessions.openForItem(1, "PAPERTWO");
  assert.equal(
    open.wikiReviewAt,
    null,
    "and the refusal really did store nothing - otherwise the gate is bypassed forever",
  );

  // A checkpoint commit partway through is still allowed; it just carries no
  // review. This is the ability the refusal must not have cost.
  await updateLegacyNote("PAPERTWO", [
      "The early stations behave as PAPERONE's do (chunk 3, chunk 4).",
      "Station 9 continues the trend (chunk 9).",
      "Station 50 shows the same plateau PAPERONE reaches, and 51 with it (chunk 50, chunk 51).",
      "Depth at stations 10 and 11 is equal to within the stated uncertainty (chunk 10, chunk 11).",
      "Station 35 is where the series first departs from linear (chunk 35).",
      "Stations 48, 60 and 61 are all on the plateau (chunk 48, chunk 60, chunk 61).",
      "Stations 70 and 71 repeat the plateau reading at the same values (chunk 70, chunk 71).",
      "The opening pages set out the rig geometry and the traverse stations (chunk 0, chunk 2).",
      ...coversPage(page),
    ]);
  const checkpoint = await service.prepareUpdate({
    libraryID: 1,
    query: "Rig geometry",
    proposedPageTitles: ["Rig geometry"],
  });
  assert.ok(
    checkpoint.prepareToken,
    "committing what has been read so far must survive the new refusal",
  );

  await service.finishReading({
    libraryID: 1,
    itemKey: "PAPERTWO",
    outcome: "skipped",
  });
});

// =========================================================================
// 12. A chunk is read because its content reached the note, not before
// =========================================================================

block("a note that fails to save records no reading at all", async () => {
  const sessions = await store.readingSessions();
  const notes = service.notes;
  const realWrite = notes.write.bind(notes);

  const body = note([
    "Station 2 reports melt-pool depth under its imposed gradient (chunk 2).",
    "Station 3 reports melt-pool depth under its imposed gradient (chunk 3).",
  ]);

  notes.write = async () => {
    throw new Error("simulated disk failure");
  };
  await assert.rejects(
    () =>
      service.updateReadingNote({
        libraryID: 1,
        itemKey: "PAPERFIV",
        readChunkIds: [2, 3].map((i) => chunkId("PAPERFIV", i)),
        domain: "physical metallurgy",
        expertRole: "solidification specialist",
        markdown: body,
      }),
    /simulated disk failure/u,
    "the failure surfaces rather than being swallowed",
  );
  notes.write = realWrite;

  // Nothing moved. This is the whole point: a chunk counts as read because its
  // content reached the note, so a note that never saved cannot have made
  // anything read - not the coverage, not the ledger, not the Wiki debt.
  const opened = await sessions.openForItem(1, "PAPERFIV");
  if (opened) {
    const coverage = await sessions.coverage(opened.sessionId);
    assert.equal(coverage.deliveredChunks, 0, "no chunk was recorded as read");
    assert.equal(
      (await sessions.pendingWikiChunks(opened.sessionId)).length,
      0,
      "and none of them owes the Wiki anything",
    );
    assert.equal(opened.integratedChunks, 0);
  }

  // Retrying the same call once the disk is healthy just works.
  const retried = await service.updateReadingNote({
    libraryID: 1,
    itemKey: "PAPERFIV",
    readChunkIds: [2, 3].map((i) => chunkId("PAPERFIV", i)),
    domain: "physical metallurgy",
    expertRole: "solidification specialist",
    markdown: body,
  });
  assert.deepEqual(retried.reading.newChunks, [2, 3]);
  assert.deepEqual(retried.wikiDebt.chunkIndexes, [2, 3]);

  // And the content really is on disk, not merely reported as saved.
  const raw = await noteOnDisk("PAPERFIV");
  assert.match(parseReadingNote(raw).body, /chunk 2/u);
  assert.match(parseReadingNote(raw).body, /chunk 3/u);
  const after = await sessions.openForItem(1, "PAPERFIV");
  assert.equal((await sessions.coverage(after.sessionId)).deliveredChunks, 2);
});

block("a full-text integration that fails to save records nothing either", async () => {
  const sessions = await store.readingSessions();
  const notes = service.notes;
  const realWrite = notes.write.bind(notes);

  // Write up chunk 2 but deliberately NOT chunk 3: the next block is about
  // that leftover surviving the promotion to a full-text read.
  await writeUp({
    title: "Linear rise",
    claimText: "Depth rises linearly with the imposed gradient early on.",
    evidence: [evidenceFrom("PAPERFIV", 2)],
    settle: false,
  });

  await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPERFIV",
  });
  await service.setReadingExpert({
    libraryID: 1,
    itemKey: "PAPERFIV",
    persona:
      "A solidification metallurgist reading this paper end to end to establish the depth response over the whole traverse.",
    focus: ["the depth response", "the gradient range covered"],
  });
  const page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPERFIV",
    limit: TINY,
  });
  assert.equal(page.pagination.coverageComplete, true);

  const session = await sessions.openForItem(1, "PAPERFIV");
  const integratedBefore = session.integratedChunks;

  // Written so the synthesis gate passes: what is under test here is what a
  // DISK failure leaves behind, and a note refused before it is ever written
  // would never reach the failing write at all.
  const whole = macroTemplated(
    [
      "Station 2 reports a melt-pool depth measured under the imposed gradient stated for that station (chunk 2).",
      "Station 3 reports its depth measured under the gradient stated for that station as well (chunk 3).",
      "The traverse is covered station by station, with its own stated gradient (chunk 0).",
    ].join(String.fromCharCode(10, 10)),
  );
  notes.write = async () => {
    throw new Error("simulated disk failure");
  };
  await assert.rejects(
    () =>
      service.updateReadingNote({
        libraryID: 1,
        itemKey: "PAPERFIV",
        finalSynthesis: true,
        markdown: whole,
      }),
    /simulated disk failure/u,
  );
  notes.write = realWrite;

  const stillOpen = await sessions.openForItem(1, "PAPERFIV");
  assert.equal(
    stillOpen.finalSynthesisAt,
    null,
    "a synthesis recorded against a note that never saved would let paper_reviewed rest on a file that does not exist",
  );
  assert.equal(stillOpen.integratedChunks, integratedBefore);

  const done = await service.updateReadingNote({
    libraryID: 1,
    itemKey: "PAPERFIV",
    finalSynthesis: true,
    markdown: whole,
  });
  assert.equal(done.finalSynthesis, true);
  assert.match(
    parseReadingNote(await noteOnDisk("PAPERFIV")).body,
    /The traverse is covered station by station/u,
  );
});

// =========================================================================
// 13. A paper is not finished until all four things are true
// =========================================================================

/** Set by the block below, reused by the one after it. */
let wholeTraversePageId;

block("a QA debt carried into a full-text read still has to be settled", async () => {
  const sessions = await store.readingSessions();

  // Chunk 3 was read by the question above and never written up: the Claim
  // cited chunk 2 and the write-off covered nothing else. Check that this
  // survived the promotion rather than being lost with the mode change.
  const session = await sessions.openForItem(1, "PAPERFIV");
  assert.equal(session.mode, "fulltext");
  const owed = await sessions.pendingWikiChunks(session.sessionId);
  // The full-text pages this session has since been handed owe the Wiki too,
  // so the question-era chunk is no longer the ONLY debt - what matters here
  // is that it survived the promotion rather than being dropped with the mode
  // change, which is what it used to do.
  assert.ok(
    owed.map((chunk) => chunk.chunkId).includes(chunkId("PAPERFIV", 3)),
    "the question-era debt is carried into the full-text read, not dropped",
  );

  await service.recordConcepts({
    libraryID: 1,
    itemKey: "PAPERFIV",
    final: true,
    concepts: [],
    noConceptsReason: "nothing beyond what the concept library already holds",
    confirmWrite: async () => {},
  });

  // Everything else done, one question-era chunk still owing.
  const paperFiveClaims = await store.listClaimsByEvidenceSource(1, "PAPERFIV");
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    itemKey: "PAPERFIV",
    query: "Whole traverse",
    proposedPageTitles: ["Whole traverse"],
    wikiReview: {
      pages: "The Linear rise Page covers this; it is extended rather than duplicated.",
      claims: "The early claim is confirmed by the rest of the traverse and needs no correction.",
      evidence: "The claim is thin; the completed read attaches a second excerpt at full depth.",
      concepts: "No terminology beyond what the concept library already holds anywhere.",
      relations: "No relation between stored concepts is added or withdrawn by this paper.",
      claimVerdicts: paperFiveClaims.map((claim) => ({
        claimId: claim.claimId,
        verdict: "confirmed",
        basis:
          "The complete paper supports this Claim at the wording and scope currently stored.",
      })),
    },
  });
  const blocked = await service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: prepared.prepareToken,
    actions: [
      { action: "CREATE_PAGE", ref: "p", canonicalTitle: "Whole traverse" },
      {
        action: "ADD_CLAIM",
        ref: "c",
        pageId: "p",
        claimText: "The depth rise continues across the whole traverse.",
        claimType: "mechanism",
        epistemicStatus: "provisional",
        coverageLevel: "paper_reviewed",
        confidence: 0.8,
        evidence: [evidenceFrom("PAPERFIV", 6, "paper_reviewed")],
      },
    ],
  });
  assert.equal(
    blocked.readingSession.state,
    "reading",
    "a paper still owing the Wiki is not finished, however completely it was read",
  );
  assert.equal(blocked.readingSession.released, false);
  assert.ok(
    blocked.readingSession.outstandingQuestionChunkIds.includes(
      chunkId("PAPERFIV", 3),
    ),
    "the chunk a question read and never wrote up is named among what is owed",
  );
  assert.match(blocked.readingSession.note, /5003/u);

  // The Claim itself is committed and permanent; only the closure was refused.
  assert.equal(blocked.committed, true);
  wholeTraversePageId = blocked.refs.p;
  const claim = await store.getClaim(blocked.refs.c);
  assert.equal(claim.evidence[0].readDepth, "paper_reviewed");

  // And the debt is STILL VISIBLE, which is the thing that used to be lost.
  assert.deepEqual(
    (await sessions.listPendingWiki(1)).map((entry) => entry.session.itemKey),
    ["PAPERFIV"],
  );

  // Settle it, and the same commit shape now closes the paper.
  const closing = await service.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "SKIP",
        itemKey: "PAPERFIV",
        // Every delivered chunk owes now, not only the one a question read
        // and left behind, so closing the paper means answering for all of
        // them - which is the whole point of the change and is what a real
        // write-up does with one SKIP and one reason.
        chunkIds: (await sessions.pendingWikiChunks(session.sessionId)).map(
          (chunk) => chunk.chunkId,
        ),
        reason:
          "These stations restate the same linear rise the Whole traverse claim already carries, at the " +
          "same values, and add no condition, parameter or mechanism beyond it.",
      },
    ],
  });
  assert.equal(closing.readingSession.state, "committed");
  assert.equal(closing.readingSession.released, true);
  assert.deepEqual(await sessions.listPendingWiki(1), []);
});

block("the three whole-paper passes are checked where committed is written", async () => {
  const sessions = await store.readingSessions();

  // Read the paper again, in full and from scratch, doing NONE of the three
  // passes. A commit with no CREATE_PAGE never goes through
  // wiki_prepare_update, so it answers none of that call's gates - which is
  // why they are checked here too, where "committed" is actually written.
  await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPERFIV",
  });
  await service.setReadingExpert({
    libraryID: 1,
    itemKey: "PAPERFIV",
    persona:
      "A solidification metallurgist re-reading this paper end to end to check the traverse against the stored claims.",
    focus: ["the depth response", "the reported uncertainty"],
  });
  const page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "PAPERFIV",
    limit: TINY,
  });
  assert.equal(page.pagination.coverageComplete, true, "every chunk delivered");

  const fresh = await sessions.openForItem(1, "PAPERFIV");
  assert.equal(fresh.finalSynthesisAt, null);
  assert.equal(fresh.conceptsRecordedAt, null);
  assert.equal(fresh.wikiReviewAt, null);
  assert.equal(
    (await sessions.pendingWikiChunks(fresh.sessionId)).length,
    TINY,
    "and a full-text read now owes the Wiki per chunk, exactly as a question does — " +
      "a paper read end to end used to produce four Claims resting on four chunks " +
      "with nothing anywhere asking about the rest",
  );

  const bypass = await service.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "ADD_CLAIM",
        ref: "c",
        pageId: wholeTraversePageId,
        claimText: "The traverse shows no departure from the linear rise.",
        claimType: "mechanism",
        epistemicStatus: "provisional",
        coverageLevel: "chunk_local",
        confidence: 0.6,
        evidence: [evidenceFrom("PAPERFIV", 5, "chunk_local")],
      },
    ],
  });
  assert.equal(bypass.committed, true, "the Claim itself is written");
  assert.equal(
    bypass.readingSession.state,
    "reading",
    "but delivery alone does not finish a paper, even on a path that skips prepare",
  );
  assert.equal(bypass.readingSession.released, false);
  for (const owed of [
    /finalSynthesis true/u,
    /wiki_record_concepts once with final true/u,
    /wikiReview answering pages, claims, evidence, concepts and relations/u,
  ]) {
    assert.match(bypass.readingSession.note, owed);
  }

  await service.finishReading({
    libraryID: 1,
    itemKey: "PAPERFIV",
    outcome: "skipped",
  });
});

// --- Runner ---------------------------------------------------------------

let passed = 0;
const failures = [];
for (const [name, fn] of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push([name, error]);
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message}`);
  }
}
console.log(`\n${passed}/${tests.length} passed`);
if (failures.length) process.exit(1);
