/* eslint-env node */

/**
 * Deep reading of one paper: expert, note, integration gate, recovery.
 *
 * The flow this suite guards is the one that replaced "page to the end, then
 * summarise whatever survived in context". Each block is named for the failure
 * it exists to prevent:
 *
 *   1. Chunks are a transport unit, so the note may not be organised by them.
 *   2. A batch that arrives is a batch that must be folded in, not appended.
 *   3. Later text corrects earlier text by rewriting it, not by contradicting
 *      it three headings further down.
 *   4. A restart, a dropped connection or a context compaction must cost the
 *      reading nothing: the note is on disk and reading resumes mid-paper.
 *   5. The progress in the note is the database's, not the model's.
 *   6. Delivery is not understanding, so whole-paper depth needs both.
 *   7. The note is reading memory. Evidence still comes from real chunks.
 *
 * Everything runs against a real SQLite database and a real temp filesystem,
 * because two of the guarantees - atomic rewrite, survives a restart - are not
 * observable against in-memory doubles.
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-reading-note-"));
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
const {
  isWikiReadingNoteAttachment,
  parseReadingNote,
  assertHolisticBody,
  formatChunkRanges,
  WIKI_EXPERT_OPEN_SCOPE_MANDATE,
} = await import("../src/modules/wiki/wikiReadingNote.ts");

// --- Fixtures -------------------------------------------------------------

const PAGE = 8;

/**
 * A paper whose late sections overturn an early number.
 *
 * The correction is the point: chunk 26 retracts the threshold stated in
 * chunk 2, so a note that merely accumulated pages would end up asserting both
 * 12 K/mm and 8 K/mm, in that order, and be internally false.
 */
function deepReadChunks() {
  const chunks = [];
  for (let i = 0; i < 32; i += 1) {
    let text;
    if (i === 2) {
      text = `Section 2.1 reports that a thermal gradient of 12 K/mm marks the columnar-to-equiaxed transition in the Ni-base alloy studied here.`;
    } else if (i === 10) {
      text = `Section 3.2 describes the two-stage schedule: directional solidification at 4 mm/min under an imposed gradient, followed by rapid hot pressing at 1180 C and 45 MPa for 90 s.`;
    } else if (i === 26) {
      text = `Section 5.3 shows the earlier 12 K/mm threshold was an artefact of thermocouple lag; after correction the transition occurs at 8 K/mm, which also reconciles the disagreement with Ref. 14.`;
    } else {
      text = `DEEPREAD passage ${i}: columnar array growth measurements at station ${i} of the directional solidification rig.`;
    }
    chunks.push({ chunkId: 5000 + i, text, language: "en" });
  }
  return chunks;
}

const indexedChunks = new Map([
  ["DEEPREAD", deepReadChunks()],
  [
    "SHORTONE",
    Array.from({ length: 6 }, (_, i) => ({
      chunkId: 7000 + i,
      text: `SHORTONE passage ${i}: brief note on hot-press dwell time.`,
      language: "en",
    })),
  ],
  [
    "RESUMEPR",
    Array.from({ length: 24 }, (_, i) => ({
      chunkId: 8000 + i,
      text: `RESUMEPR passage ${i}: calibration of the pyrometer against the embedded thermocouples.`,
      language: "en",
    })),
  ],
]);

fake.createPaper({
  key: "DEEPREAD",
  title: "Two-stage forming of columnar grain arrays",
  abstract:
    "We report a two-stage process combining directional solidification with rapid hot pressing, and characterise the columnar-to-equiaxed transition under an imposed thermal gradient.",
  fields: { DOI: "10.1000/deepread", publicationTitle: "Acta Test" },
  creators: [{ lastName: "Xu", firstName: "L" }],
});
fake.createPaper({
  key: "SHORTONE",
  title: "Hot press dwell time",
  abstract: "A short communication on dwell time.",
});
fake.createPaper({
  key: "RESUMEPR",
  title: "Pyrometer calibration for solidification rigs",
  abstract: "Calibration procedure and its uncertainty budget.",
});

/**
 * Wrap a SQLite handle as a WikiDatabase.
 *
 * `handle.open` is honoured on every call because this suite kills a database
 * mid-flight to simulate a restart, and background work the service fired and
 * forgot - the embedding queue drain - can still be holding the old handle. A
 * real process death takes those tasks with it; here they have to be told the
 * database is gone instead of crashing the run.
 */
function adapt(sqlite, handle) {
  let depth = 0;
  return {
    async queryAsync(rawSql, rawParams = []) {
      if (!handle.open) return [];
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
      if (!handle.open) return undefined;
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const row = sqlite.prepare(sql).get(...params);
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(fn) {
      if (!handle.open) return undefined;
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
  sourceKind: "body",
});
vectorStore.getCommittedResetGeneration = async () => "reset-1";

const embeddingService = getEmbeddingService();
embeddingService.getConfig = () => ({ model: "test-embed-model" });
embeddingService.embed = async () => ({ embedding: new Float32Array([1, 0]) });

const dbPath = path.join(tempDir, "wiki.sqlite");
let sqlite = new DatabaseSync(dbPath);
let handle = { open: true };
sqlite.exec("PRAGMA foreign_keys = ON");
let store = new WikiStore(adapt(sqlite, handle));
await store.initialize();
let service = new WikiService(store);

// --- Helpers --------------------------------------------------------------

const EXPERT = {
  persona:
    "A physical metallurgist specialising in directional solidification of nickel-base superalloys, familiar with columnar-to-equiaxed transition criteria and with hot-press consolidation schedules.",
  focus: [
    "the complete two-stage process chain and its parameters",
    "the criterion and numerical threshold for the columnar-to-equiaxed transition",
    "how the thermal gradient is measured and corrected",
  ],
};

const REVIEW = {
  pages: "The existing Page covers this subject; nothing to add or retitle.",
  claims:
    "The corrected 8 K/mm threshold supersedes the claim written from section 2.1.",
  evidence:
    "The superseded claim is thin and gets the corrected excerpt attached at paper depth.",
  concepts:
    "CET and equiaxed grain are already held; no duplicates and nothing to correct.",
  relations:
    "No relation between stored concepts is drawn or withdrawn by this paper.",
};

/** A note body long enough to be a reading and shaped like one. */
function noteBody(sections) {
  return [
    "# Two-stage forming of columnar grain arrays",
    "",
    "## Research question",
    "Whether an imposed thermal gradient during directional solidification, followed by rapid hot pressing, can fix a columnar grain array without losing its alignment (chunk 0).",
    "",
    "## Materials and apparatus",
    "A nickel-base superalloy processed on a directional solidification rig instrumented with embedded thermocouples and a pyrometer (chunk 1).",
    "",
    ...sections,
    "",
    "## Scope and limits",
    "Findings are established for one alloy and one rig geometry; transfer to other section thicknesses is not demonstrated in this paper (chunk 1).",
  ].join("\n");
}

async function readNoteFromDisk(itemKey) {
  const item = await fake.Zotero.Items.getByLibraryAndKeyAsync(1, itemKey);
  const ids = item.getAttachments();
  for (const id of ids) {
    const attachment = await fake.Zotero.Items.getAsync(id);
    if (isWikiReadingNoteAttachment(attachment)) {
      return {
        attachment,
        raw: fs.readFileSync(attachment.getFilePath(), "utf8"),
      };
    }
  }
  return null;
}

const tests = [];
function block(name, fn) {
  tests.push([name, fn]);
}

// =========================================================================
// 1. The expert comes first, and the first call carries no body text
// =========================================================================

block("metadata and abstract come back before any chunk does", async () => {
  const opening = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "DEEPREAD",
    limit: PAGE,
  });
  assert.equal(opening.phase, "expert_briefing");
  assert.deepEqual(opening.chunks, [], "no body text before the expert exists");
  assert.equal(opening.pagination.blocked, "expert_required");
  assert.equal(opening.pagination.deliveredChunks, 0);
  assert.ok(
    !("nextCursor" in opening.pagination),
    "there is nothing to continue yet",
  );
  assert.equal(opening.metadata.title, "Two-stage forming of columnar grain arrays");
  assert.ok(
    opening.metadata.abstract.includes("columnar-to-equiaxed"),
    "the abstract is what the expert is generated from",
  );
  assert.equal(opening.metadata.doi, "10.1000/deepread");
  assert.match(opening.nextStep, /wiki_set_reading_expert/u);

  // A second opening call must not have started delivering behind our back.
  const again = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "DEEPREAD",
  });
  assert.equal(again.phase, "expert_briefing");
  assert.equal(again.pagination.deliveredChunks, 0);
});

block("the note cannot be written before there is a reader", async () => {
  await assert.rejects(
    () =>
      service.updateReadingNote({
        libraryID: 1,
        markdown: noteBody(["## Method", "..."]),
      }),
    /no expert profile yet/iu,
  );
});

block("an expert is validated, pinned open-scope, and created once", async () => {
  await assert.rejects(
    () =>
      service.setReadingExpert({ libraryID: 1, persona: "metallurgist", focus: EXPERT.focus }),
    /at least 20 characters/iu,
    "a one-word persona is not a reader",
  );
  await assert.rejects(
    () =>
      service.setReadingExpert({
        libraryID: 1,
        persona: EXPERT.persona,
        focus: ["only one thing"],
      }),
    /2 to 8/u,
  );

  const created = await service.setReadingExpert({
    libraryID: 1,
    itemKey: "DEEPREAD",
    ...EXPERT,
  });
  assert.equal(created.expert.persona, EXPERT.persona);
  assert.equal(
    created.expert.openScopeMandate,
    WIKI_EXPERT_OPEN_SCOPE_MANDATE,
    "the anti-confirmation-bias mandate is attached by the server, not proposed by the model",
  );
  assert.ok(created.readingNote.attachmentKey, "the note attachment exists");

  const onDisk = await readNoteFromDisk("DEEPREAD");
  assert.ok(onDisk, "the note is a real file on the Zotero item");
  const parsed = parseReadingNote(onDisk.raw);
  assert.equal(parsed.metadata.status, "reading");
  assert.equal(parsed.metadata.paperKey, "DEEPREAD");
  assert.equal(parsed.metadata.totalChunks, 32);
  assert.equal(parsed.metadata.nextChunk, 0);
  assert.equal(parsed.metadata.expert.persona, EXPERT.persona);
  assert.ok(
    parsed.metadata.abstract.includes("two-stage process"),
    "the abstract is kept in the note so a resume does not need the item again",
  );

  await assert.rejects(
    () => service.setReadingExpert({ libraryID: 1, ...EXPERT }),
    /already has its expert profile/iu,
    "one expert per paper: a second one would read the paper as someone else",
  );
});

// =========================================================================
// 2. A note organised by delivery batch is refused
// =========================================================================

block("delivery-shaped notes are refused, prose about chunks is not", () => {
  const shapes = [
    "## Chunks 0-7: new concepts",
    "### New in this batch",
    "## 本页新增知识",
    "**Chunk 12 summary**",
    "## Pages 8-15",
  ];
  for (const heading of shapes) {
    assert.throws(
      () => assertHolisticBody(`${heading}\n\nSomething about the paper.`),
      /organised by delivery batch/iu,
      `${heading} must be refused`,
    );
  }
  // Narrow on purpose: the same words in prose are a legitimate observation.
  assertHolisticBody(
    "## Method\n\nTable 3 is split across a chunk boundary, so its caption is read with the following passage.",
  );
  // And a fenced code block is not a heading.
  assertHolisticBody(
    "## Method\n\n```\n# Chunks 0-7\n```\n\nThe listing above is from the paper's own appendix.",
  );
});

block("the first batch arrives and must be integrated as a whole", async () => {
  const first = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "DEEPREAD",
    limit: PAGE,
  });
  assert.equal(first.phase, "reading");
  assert.equal(first.chunks.length, PAGE);
  assert.equal(first.chunks[0].chunkIndex, 0);
  assert.equal(first.readingNote.integrationDebt, 1);
  assert.equal(first.readingNote.maxOutstandingBatches, 1);
  assert.ok(
    "markdown" in first.readingNote,
    "a call without a cursor is what resuming looks like, so the note comes back with it",
  );
  assert.equal(first.expert.persona, EXPERT.persona);

  await assert.rejects(
    () => service.updateReadingNote({ libraryID: 1, markdown: "Read it. Fine." }),
    /cites no chunk/iu,
    "the character quota is gone, but provenance is still mandatory",
  );
  await assert.rejects(
    () => service.updateReadingNote({ libraryID: 1 }),
    /readingRecord is required/iu,
  );

  const integrated = await service.updateReadingNote({
    libraryID: 1,
    itemKey: "DEEPREAD",
    markdown: noteBody([
      "## Columnar-to-equiaxed transition",
      "The paper places the transition at a thermal gradient of 12 K/mm for this alloy (chunk 2).",
    ]),
  });
  assert.equal(integrated.integrated, true);
  assert.equal(integrated.readingSession.integrationDebt, 0);
  assert.equal(integrated.readingNote.status, "reading");
});

// =========================================================================
// 3. Progress in the note is the ledger's, never the model's
// =========================================================================

block("the machine block tracks the ledger and ignores forgery", async () => {
  const forged = [
    "<!-- ZOTERO-MCP-WIKI-READING-NOTE: machine-maintained, do not edit -->",
    "",
    "```json",
    JSON.stringify({
      paperKey: "DEEPREAD",
      status: "completed",
      totalChunks: 32,
      nextChunk: null,
      coverage: { deliveredChunks: 32, totalChunks: 32, complete: true },
    }),
    "```",
    "",
    "<!-- /ZOTERO-MCP-WIKI-READING-NOTE -->",
    "",
    noteBody([
      "## Columnar-to-equiaxed transition",
      "The paper places the transition at a thermal gradient of 12 K/mm for this alloy (chunk 2).",
    ]),
  ].join("\n");

  // Debt is 0, so this integration is a plain rewrite of the same batch.
  await service.updateReadingNote({ libraryID: 1, markdown: forged });

  const parsed = parseReadingNote((await readNoteFromDisk("DEEPREAD")).raw);
  assert.equal(parsed.metadata.status, "reading", "status comes from the ledger");
  assert.equal(parsed.metadata.coverage.complete, false);
  assert.equal(parsed.metadata.coverage.deliveredChunks, 8);
  assert.equal(parsed.metadata.readChunks, "0-7");
  assert.equal(parsed.metadata.nextChunk, 8);
  assert.equal(parsed.metadata.coverage.integratedChunks, 8);
  assert.ok(
    !parsed.body.includes('"status": "completed"'),
    "the forged block is stripped from the body rather than kept as text",
  );
});

block("chunk ranges are compact and gap-aware", () => {
  assert.equal(formatChunkRanges([0, 1, 2, 3]), "0-3");
  assert.equal(formatChunkRanges([0, 1, 5, 6, 7, 9]), "0-1,5-7,9");
  assert.equal(formatChunkRanges([]), "");
});

// =========================================================================
// 4. The integration gate: one batch of slack, and re-reading is free
// =========================================================================

block("one outstanding batch stops new paging but not re-reading", async () => {
  const second = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "DEEPREAD",
    offset: 8,
    limit: PAGE,
  });
  assert.equal(second.readingNote.integrationDebt, 1, "one batch behind is allowed");

  await assert.rejects(
    () =>
      service.buildFromPaper({
        libraryID: 1,
        userRequested: true,
        cursor: second.pagination.nextCursor,
      }),
    (error) =>
      error.name === "WikiReadingIntegrationRequired" &&
      /1 batch of DEEPREAD has been delivered/u.test(error.message) &&
      error.details.integrationDebt === 1,
    "a second outstanding batch is refused, naming the existing debt",
  );

  // Re-reading text already delivered is how Evidence gets checked against the
  // source. It must not be charged against the gate.
  const reread = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "DEEPREAD",
    offset: 0,
    limit: 4,
  });
  assert.equal(reread.chunks[0].chunkIndex, 0);
  assert.equal(
    reread.readingNote.integrationDebt,
    1,
    "a re-read adds no debt of its own",
  );

  // Rewriting the whole note clears the one allowed outstanding batch.
  const caughtUp = await service.updateReadingNote({
    libraryID: 1,
    markdown: noteBody([
      "## Process chain",
      "Directional solidification at 4 mm/min under an imposed gradient, then rapid hot pressing at 1180 C and 45 MPa for 90 s (chunk 10).",
      "",
      "## Columnar-to-equiaxed transition",
      "The paper places the transition at a thermal gradient of 12 K/mm for this alloy (chunk 2).",
    ]),
  });
  assert.equal(caughtUp.readingSession.integrationDebt, 0);

  const third = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    cursor: second.pagination.nextCursor,
  });
  assert.equal(third.chunks[0].chunkIndex, 16);
  assert.equal(third.readingNote.integrationDebt, 1);
  assert.ok(
    !("markdown" in third.readingNote),
    "while paging the model already holds the note, so it is not resent",
  );
  await service.updateReadingNote({
    libraryID: 1,
    markdown: noteBody([
      "## Process chain",
      "Directional solidification at 4 mm/min under an imposed gradient, then rapid hot pressing at 1180 C and 45 MPa for 90 s (chunk 10).",
      "",
      "## Columnar-to-equiaxed transition",
      "The paper places the transition at a thermal gradient of 12 K/mm for this alloy (chunk 2).",
    ]),
  });

  const fourth = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "DEEPREAD",
    offset: 24,
    limit: PAGE,
  });
  assert.equal(fourth.chunks[0].chunkIndex, 24);
  assert.equal(fourth.pagination.coverageComplete, true);
});

block('"unchanged" records real empty batches without a frequency quota', async () => {
  // Everything is delivered, so this integration covers the last batch.
  await assert.rejects(
    () => service.updateReadingNote({ libraryID: 1, unchanged: true }),
    /unchangedReason is required/iu,
  );
  const skipped = await service.updateReadingNote({
    libraryID: 1,
    unchanged: true,
    unchangedReason: "参考文献与致谢",
  });
  assert.equal(skipped.unchanged, true);
  const skippedAgain = await service.updateReadingNote({
    libraryID: 1,
    unchanged: true,
    unchangedReason:
      "This retry still covers only references and acknowledgements, so there is no factual addition to record.",
  });
  assert.equal(skippedAgain.unchanged, true);
});

// =========================================================================
// 5. Later text corrects earlier text by rewriting it
// =========================================================================

block("a retraction in section 5 rewrites what section 2 said", async () => {
  const before = parseReadingNote((await readNoteFromDisk("DEEPREAD")).raw).body;
  assert.ok(
    before.includes("12 K/mm"),
    "the note currently carries the paper's own preliminary number",
  );

  await service.updateReadingNote({
    libraryID: 1,
    markdown: noteBody([
      "## Process chain",
      "Directional solidification at 4 mm/min under an imposed gradient, then rapid hot pressing at 1180 C and 45 MPa for 90 s (chunk 10).",
      "",
      "## Columnar-to-equiaxed transition",
      "The transition occurs at a thermal gradient of 8 K/mm (chunk 26). The value of 12 K/mm stated in section 2.1 (chunk 2) is superseded: it came from an uncorrected thermocouple lag, and the corrected figure reconciles this paper with Ref. 14 (chunk 26).",
    ]),
  });

  const after = parseReadingNote((await readNoteFromDisk("DEEPREAD")).raw).body;
  assert.ok(after.includes("8 K/mm"), "the corrected value is what the note asserts");
  assert.ok(
    /places the transition at a thermal gradient of 12 K\/mm/u.test(after),
    "the earlier record is retained exactly",
  );
  assert.ok(
    /superseded/u.test(after),
    "the correction is explained where the claim lives, not in a batch log",
  );
  assert.match(after, /### 第 \d+ 次 · chunk/u);
});

// =========================================================================
// 6. Delivery is not understanding
// =========================================================================

block("the write-up waits for the whole-paper pass", async () => {
  await assert.rejects(
    () =>
      service.prepareUpdate({
        libraryID: 1,
        query: "columnar array",
        proposedPageTitles: ["Columnar array forming"],
      }),
    /macro summary has not been appended/iu,
    "every chunk delivered is the moment the final pass is owed, not the moment claims start",
  );

  // 2.4.4 staging remains cheap and reversible, but its final write belongs
  // after the whole-paper synthesis. An early final must neither drain what
  // was staged nor ask the user to confirm a permanent concept write.
  let confirmations = 0;
  const staged = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: { zh: "等轴晶", en: "equiaxed grain" },
      },
    ],
    confirmWrite: async () => {
      confirmations += 1;
    },
  });
  assert.equal(staged.written, false, "a mid-reading call must not write");
  assert.equal(staged.totalStaged, 1);
  assert.equal(confirmations, 0, "and must not ask the user anything");
  await assert.rejects(
    () =>
      service.recordConcepts({
        libraryID: 1,
        final: true,
        concepts: [
          {
            primaryTerm: {
              zh: "柱状晶到等轴晶转变",
              en: "columnar-to-equiaxed transition",
              abbr: "CET",
            },
          },
        ],
        confirmWrite: async () => {
          confirmations += 1;
        },
      }),
    /whole-paper synthesis.*Nothing was written/iu,
    "concepts final is refused before finalSynthesis",
  );
  assert.equal(confirmations, 0, "an invalid final asks for no confirmation");
  assert.equal(
    (await service.listConcepts(1)).some(
      (concept) => concept.displayName === "等轴晶",
    ),
    false,
    "neither the staged nor early-final term reached the concept library",
  );

  // The whole-paper pass is the one call whose sentences are checked against
  // the chunks they cite. This first attempt reaches in the two ways a good
  // reading still reaches: it strengthens a schedule the paper states plainly
  // into a claim about what the schedule guarantees, and it fuses the
  // correction with the reconciliation into one sentence that neither chunk
  // asserts on its own.
  const drifted = () =>
    service.updateReadingNote({
      libraryID: 1,
      finalSynthesis: true,
      markdown: noteBody([
        "## Process chain",
        "Directional solidification at 4 mm/min under an imposed gradient, then rapid hot pressing at 1180 C and 45 MPa for 90 s, completely eliminating equiaxed nucleation (chunk 10).",
        "",
        "## Columnar-to-equiaxed transition",
        "The corrected 8 K/mm threshold proves that the thermocouple lag reported in section 2.1 always causes the disagreement with Ref. 14 (chunk 2, chunk 26).",
      ]),
    });

  const refusal = await drifted().then(
    () => null,
    (error) => error,
  );
  assert.ok(refusal, "a synthesis that reaches past its chunks is not written");
  assert.equal(refusal.name, "WikiSynthesisAuditRequired");
  assert.match(refusal.message, /eliminating/u, "the offending sentence is quoted back");
  assert.match(refusal.message, /absolute-language/u, "and the reason is named");
  assert.match(refusal.message, /multi-chunk-fusion/u);
  assert.match(refusal.message, /synthesisAudit/u, "with the way to answer it");
  assert.equal(
    parseReadingNote((await readNoteFromDisk("DEEPREAD")).raw).metadata.coverage
      .finalSynthesis,
    false,
    "nothing is written on a refused synthesis, so the ledger cannot claim one",
  );

  // Answering it with a quotation that is not in the chunk is refused too:
  // being nearly right is exactly the case worth catching.
  const forged = await service
    .updateReadingNote({
      libraryID: 1,
      finalSynthesis: true,
      markdown: noteBody([
        "## Process chain",
        "Directional solidification at 4 mm/min under an imposed gradient, then rapid hot pressing at 1180 C and 45 MPa for 90 s, completely eliminating equiaxed nucleation (chunk 10).",
        "",
        "## Columnar-to-equiaxed transition",
        "The corrected 8 K/mm threshold proves that the thermocouple lag reported in section 2.1 always causes the disagreement with Ref. 14 (chunk 2, chunk 26).",
      ]),
      synthesisAudit: [
        {
          sentence:
            "Directional solidification at 4 mm/min under an imposed gradient, then rapid hot pressing at 1180 C and 45 MPa for 90 s, completely eliminating equiaxed nucleation (chunk 10).",
          support: [
            {
              chunkId: 10,
              quote:
                "directional solidification at 4 mm/min under an imposed gradient, completely eliminating equiaxed nucleation",
            },
          ],
        },
      ],
    })
    .then(
      () => null,
      (error) => error,
    );
  assert.ok(forged, "an invented quotation does not close the gate");
  assert.match(forged.message, /character for character/u);

  // The cheap way out, and the right one: write the sentences at the strength
  // the paper used, and split the fusion into the two facts it was made of.
  // Nothing then needs quoting at all.
  const finalPass = await service.updateReadingNote({
    libraryID: 1,
    finalSynthesis: true,
    markdown: noteBody([
      "## Process chain",
      "Directional solidification at 4 mm/min under an imposed gradient, followed by rapid hot pressing at 1180 C and 45 MPa for 90 s (chunk 10).",
      "",
      "## Columnar-to-equiaxed transition",
      "Section 2.1 reported the transition at a thermal gradient of 12 K/mm (chunk 2).",
      "",
      "## Validation and contribution",
      "After correction for thermocouple lag the transition occurs at 8 K/mm, which also reconciles the disagreement with Ref. 14 (chunk 26).",
    ]),
  });
  assert.equal(finalPass.finalSynthesis, true);
  assert.equal(finalPass.readingNote.status, "synthesized");
  assert.match(finalPass.nextStep, /wiki_record_concepts/iu);
  assert.ok(
    finalPass.nextStep.indexOf("wiki_record_concepts") <
      finalPass.nextStep.indexOf("wiki_prepare_update"),
    "the final synthesis must lead to terminology before Wiki Review and prepare",
  );
  assert.match(finalPass.nextStep, /five|five-axis|pages.*claims.*evidence.*concepts.*relations/iu);

  const parsed = parseReadingNote((await readNoteFromDisk("DEEPREAD")).raw);
  assert.equal(parsed.metadata.coverage.finalSynthesis, true);
  assert.equal(parsed.metadata.nextChunk, null);

  // The Wiki review is last: it is invalid until the independent terminology
  // pass has also looked at the finished paper. A rejected early answer must
  // not be kept and silently reused after that pass happens.
  await assert.rejects(
    () =>
      service.prepareUpdate({
        libraryID: 1,
        query: "Columnar array forming",
        proposedPageTitles: ["Columnar array forming"],
        wikiReview: REVIEW,
      }),
    /concepts have not been reviewed as a whole/iu,
    "a review submitted before concepts final is explicitly rejected",
  );
  const afterEarlyReview = await service.getReadingNote({ libraryID: 1 });
  assert.equal(
    afterEarlyReview.progress.wikiReviewRecorded,
    false,
    "the rejected review leaves wikiReviewAt empty rather than banking it",
  );

  // 2.4.3: the synthesis pass is no longer the last gate. A paper that has
  // been read whole also owes one deliberate review of the terminology it
  // established, so the concept library is built from reading rather than
  // from whatever CREATE_PAGE happened to name.
  await assert.rejects(
    () =>
      service.prepareUpdate({
        libraryID: 1,
        query: "Columnar array forming",
        proposedPageTitles: ["Columnar array forming"],
      }),
    /concepts have not been reviewed as a whole/iu,
    "a synthesised paper still owes its whole-paper concept pass",
  );

  // The valid final write now consumes what remained staged, once.
  assert.equal(
    (await service.listConcepts(1)).some(
      (concept) => concept.displayName === "等轴晶",
    ),
    false,
    "nothing staged has reached the concept library yet",
  );

  const conceptPass = await service.recordConcepts({
    libraryID: 1,
    final: true,
    concepts: [
      {
        primaryTerm: {
          zh: "柱状晶到等轴晶转变",
          en: "columnar-to-equiaxed transition",
          abbr: "CET",
        },
      },
    ],
    confirmWrite: async () => {
      confirmations += 1;
    },
  });
  assert.equal(
    confirmations,
    1,
    "one paper, one confirmation - not one per batch",
  );
  assert.equal(conceptPass.fromStaging, 1, "the staged candidate is written too");
  assert.equal(conceptPass.createdConcepts, 2);
  assert.ok(
    (await service.listConcepts(1)).some(
      (concept) => concept.displayName === "等轴晶",
    ),
    "what was staged while reading is in the library after the final pass",
  );
  assert.equal(
    conceptPass.readingSession.conceptPassRecorded,
    true,
    "the pass is recorded against the open paper, not merely stored as terms",
  );

  // 2.5.0: the synthesis and the concept pass both look at the PAPER. Neither
  // looks at the Wiki, which has been growing incrementally the whole time and
  // has therefore drifted - a Claim written from an early chunk that a late one
  // bounds, two Concepts written turns apart that are one, a relation that no
  // longer holds. The last gate is one pass over all five axes of what is
  // already stored, with the finished paper in hand.
  await assert.rejects(
    () =>
      service.prepareUpdate({
        libraryID: 1,
        query: "Columnar array forming",
        proposedPageTitles: ["Columnar array forming"],
      }),
    /review the WHOLE Wiki against the finished paper/iu,
    "a read and named paper still owes one pass over the Wiki it has been building",
  );

  // Silence on an axis is not an answer: it cannot be told from not looking.
  await assert.rejects(
    () =>
      service.prepareUpdate({
        libraryID: 1,
        query: "Columnar array forming",
        proposedPageTitles: ["Columnar array forming"],
        wikiReview: {
          pages: "The existing Page covers this; nothing to add or retitle.",
          claims: "The corrected 8 K/mm threshold supersedes the claim written from section 2.1.",
          evidence: "",
          concepts: "CET and equiaxed grain are already held; nothing to merge.",
          relations: "No relation to draw or withdraw from this paper.",
        },
      }),
    /missing a real answer for: evidence/iu,
    "every axis has to be answered, and an empty one is named",
  );

  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: "Columnar array forming",
    proposedPageTitles: ["Columnar array forming"],
    wikiReview: REVIEW,
  });
  assert.ok(prepared.prepareToken, "with all three passes done, the write-up may start");
  assert.equal(
    prepared.readingSession.wikiReviewRecorded,
    true,
    "and the review is recorded against the paper, not merely validated",
  );

  // Recorded, so a retry after a validation error does not have to re-answer.
  const again = await service.prepareUpdate({
    libraryID: 1,
    query: "Columnar array forming",
    proposedPageTitles: ["Columnar array forming"],
  });
  assert.ok(again.prepareToken, "the review is asked for once per paper, not once per call");
});

block("finalSynthesis is refused before the paper has been delivered", async () => {
  // A different paper, opened only far enough to have an expert.
  const other = new WikiService(store);
  await assert.rejects(
    () =>
      other.updateReadingNote({
        libraryID: 1,
        itemKey: "SHORTONE",
        finalSynthesis: true,
        markdown: noteBody(["## Anything", "..."]),
      }),
    /The open paper is DEEPREAD/u,
    "the guard names which paper is actually open",
  );
});

// =========================================================================
// 7. Evidence still comes from the paper, never from the note
// =========================================================================

block("an excerpt that exists only in the note is refused", async () => {
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: "Columnar array forming",
    proposedPageTitles: ["Columnar array forming"],
  });
  await assert.rejects(
    () =>
      service.commit({
        libraryID: 1,
        userInitiated: true,
        prepareToken: prepared.prepareToken,
        actions: [
          { action: "CREATE_PAGE", ref: "p", canonicalTitle: "Columnar array forming" },
          {
            action: "ADD_CLAIM",
            ref: "c",
            pageId: "p",
            claimText:
              "The columnar-to-equiaxed transition occurs at 8 K/mm once thermocouple lag is corrected.",
            claimType: "mechanism",
            epistemicStatus: "supported",
            coverageLevel: "paper_reviewed",
            confidence: 0.8,
            evidence: [
              {
                libraryID: 1,
                itemKey: "DEEPREAD",
                // This sentence is the model's own summary. It is nowhere in
                // the paper, which is exactly why it must not become Evidence.
                excerpt:
                  "The uncorrected 12 K/mm reported in section 2.1 is superseded.",
                evidenceRole: "SUPPORTS",
                readDepth: "paper_reviewed",
              },
            ],
          },
        ],
      }),
    /could not be verified in DEEPREAD's indexed chunks/u,
    "the note is reading memory; it is not a source",
  );
});

block("an excerpt quoted from the chunk is accepted at whole-paper depth", async () => {
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: "Columnar array forming",
    proposedPageTitles: ["Columnar array forming"],
  });
  const committed = await service.commit(
    {
      libraryID: 1,
      userInitiated: true,
      prepareToken: prepared.prepareToken,
      actions: [
        { action: "CREATE_PAGE", ref: "p", canonicalTitle: "Columnar array forming" },
        {
          action: "ADD_CLAIM",
          ref: "c",
          pageId: "p",
          claimText:
            "The columnar-to-equiaxed transition occurs at 8 K/mm once thermocouple lag is corrected.",
          claimType: "mechanism",
          epistemicStatus: "supported",
          coverageLevel: "paper_reviewed",
          confidence: 0.8,
          evidence: [
            {
              libraryID: 1,
              itemKey: "DEEPREAD",
              excerpt: "after correction the transition occurs at 8 K/mm",
              evidenceRole: "SUPPORTS",
              readDepth: "paper_reviewed",
            },
          ],
        },
      ],
    },
    { authorizeNoteStatusWrite: async () => false },
  );
  assert.equal(committed.committed, true);
  assert.deepEqual(
    committed.warnings,
    [],
    "delivery complete AND synthesised, so paper_reviewed stands unclamped",
  );

  const evidence = sqlite
    .prepare(
      "SELECT read_depth, chunk_id_snapshot, excerpt FROM wiki_evidence WHERE item_key = ?",
    )
    .all("DEEPREAD");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].read_depth, "paper_reviewed");
  assert.equal(
    evidence[0].chunk_id_snapshot,
    5026,
    "Evidence points at the real chunk the sentence was read in, not at the note",
  );

  // The Wiki commit and session close are independent of Zotero write
  // permission. The note stays synthesised when its status write is denied.
  const parsed = parseReadingNote((await readNoteFromDisk("DEEPREAD")).raw);
  assert.equal(parsed.metadata.status, "synthesized");
  assert.equal(committed.readingSession.state, "committed");
  assert.equal(committed.readingSession.released, true);
  assert.equal(committed.readingSession.noteStatusWrite.updated, false);
  assert.equal(committed.readingSession.noteStatusWrite.reason, "not_authorized");
});

block("delivery without the whole-paper pass is still only section_read", async () => {
  // SHORTONE is read to the very end but never synthesised, then closed.
  await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "SHORTONE",
  });
  await service.setReadingExpert({
    libraryID: 1,
    persona:
      "A process metallurgist who evaluates hot-press dwell schedules for consolidation of pre-formed arrays.",
    focus: ["dwell time and its justification", "what is left unmeasured"],
  });
  const page = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "SHORTONE",
  });
  assert.equal(page.pagination.coverageComplete, true, "six chunks fit in one page");
  const finished = await service.finishReading(
    {
      libraryID: 1,
      itemKey: "SHORTONE",
      outcome: "skipped",
      note: "Read in full but too thin for a page of its own.",
    },
    { authorizeNoteStatusWrite: async () => false },
  );
  assert.equal(finished.closed, true, "the Wiki reading state still closes");
  assert.equal(finished.noteStatusWrite.reason, "not_authorized");

  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: "Hot press dwell",
    proposedPageTitles: ["Hot press dwell"],
  });
  const committed = await service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: prepared.prepareToken,
    actions: [
      { action: "CREATE_PAGE", ref: "p", canonicalTitle: "Hot press dwell" },
      {
        action: "ADD_CLAIM",
        ref: "c",
        pageId: "p",
        claimText: "Dwell time is reported for one alloy only.",
        claimType: "limitation",
        epistemicStatus: "provisional",
        coverageLevel: "paper_reviewed",
        confidence: 0.6,
        evidence: [
          {
            libraryID: 1,
            itemKey: "SHORTONE",
            // Names its chunk and quotes enough of it to identify one: the
            // bare phrase occurs in all six chunks of this fixture.
            chunkIdSnapshot: 7000,
            excerpt: "SHORTONE passage 0: brief note on hot-press dwell time.",
            evidenceRole: "SUPPORTS",
            readDepth: "paper_reviewed",
          },
        ],
      },
    ],
  });
  assert.ok(
    committed.warnings.some((warning) =>
      /no whole-paper synthesis of the reading note/u.test(warning),
    ),
    "the warning says which of the two conditions was missing",
  );
  const depth = sqlite
    .prepare("SELECT read_depth FROM wiki_evidence WHERE item_key = ?")
    .get("SHORTONE").read_depth;
  assert.equal(depth, "section_read");

  // The Zotero note is unchanged because its status write was not authorized.
  const parsed = parseReadingNote((await readNoteFromDisk("SHORTONE")).raw);
  assert.equal(parsed.metadata.status, "reading");
});

// =========================================================================
// 8. A torn write must cost one batch, never the whole reading
// =========================================================================

block("a crash between the temp write and the rename leaves the note intact", async () => {
  await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "RESUMEPR",
  });
  await service.setReadingExpert({
    libraryID: 1,
    persona:
      "An instrumentation specialist who calibrates optical pyrometers against embedded thermocouples in solidification rigs.",
    focus: ["the calibration procedure end to end", "the uncertainty budget"],
  });
  await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "RESUMEPR",
    limit: PAGE,
  });
  const good = noteBody([
    "## Calibration procedure",
    "The pyrometer is referenced against embedded thermocouples at three plateau temperatures before each run.",
  ]);
  await service.updateReadingNote({ libraryID: 1, markdown: good });
  const before = fs.readFileSync(
    (await readNoteFromDisk("RESUMEPR")).attachment.getFilePath(),
    "utf8",
  );

  fake.control.crashNextWriteBeforeRename = new Error("simulated power loss");
  await assert.rejects(
    () =>
      service.updateReadingNote({
        libraryID: 1,
        markdown: noteBody([
          "## Calibration procedure",
          "Rewritten with the uncertainty budget folded in.",
        ]),
      }),
    /simulated power loss/u,
  );
  const after = fs.readFileSync(
    (await readNoteFromDisk("RESUMEPR")).attachment.getFilePath(),
    "utf8",
  );
  assert.equal(
    after,
    before,
    "the previous version survives: a document rewritten whole cannot be half-written",
  );

  // And the retry lands normally.
  const retried = await service.updateReadingNote({
    libraryID: 1,
    markdown: noteBody([
      "## Calibration procedure",
      "Rewritten with the uncertainty budget folded in.",
    ]),
  });
  assert.equal(retried.integrated, true);
});

// =========================================================================
// 9. Recovery: a restart costs the reading nothing
// =========================================================================

block("a fresh process resumes mid-paper from the note on disk", async () => {
  // Read one more batch of RESUMEPR so the resume point is not a page boundary
  // that could be guessed.
  await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "RESUMEPR",
    offset: 8,
    limit: 5,
  });
  await service.updateReadingNote({
    libraryID: 1,
    markdown: noteBody([
      "## Calibration procedure",
      "Referenced against embedded thermocouples at three plateau temperatures, with drift checked between runs.",
      "",
      "## Uncertainty budget",
      "Dominated by emissivity uncertainty rather than by detector noise.",
    ]),
  });

  // Everything in memory goes away: new database handle, new store, new
  // service. The Zotero item and its attachment file are all that carry over.
  handle.open = false;
  sqlite.close();
  sqlite = new DatabaseSync(dbPath);
  handle = { open: true };
  sqlite.exec("PRAGMA foreign_keys = ON");
  store = new WikiStore(adapt(sqlite, handle));
  await store.initialize();
  service = new WikiService(store);

  const recovered = await service.getReadingNote({ libraryID: 1 });
  assert.equal(recovered.found, true);
  assert.equal(recovered.itemKey, "RESUMEPR");
  assert.equal(recovered.progress.deliveredChunks, 13);
  assert.equal(recovered.progress.nextChunk, 13, "resume point, not zero");
  assert.equal(recovered.progress.coverageComplete, false);
  assert.equal(recovered.progress.finalSynthesisDone, false);
  assert.ok(
    recovered.expert.persona.includes("pyrometer"),
    "the expert survives the restart with the paper",
  );
  assert.ok(
    recovered.readingNote.markdown.includes("Uncertainty budget"),
    "the understanding survives the restart, not just the page number",
  );
  assert.match(recovered.nextStep, /Resume reading at chunk index 13/u);

  const continued = await service.buildFromPaper({
    libraryID: 1,
    userRequested: true,
    itemKey: "RESUMEPR",
    offset: recovered.progress.nextChunk,
    limit: PAGE,
  });
  assert.equal(continued.chunks[0].chunkIndex, 13, "reading continues, it does not restart");
  assert.equal(
    continued.pagination.deliveredChunks,
    21,
    "the ledger kept everything that had been delivered before the restart",
  );
  assert.ok(
    continued.readingNote.markdown.includes("Uncertainty budget"),
    "resuming hands the note back without being asked",
  );
});

block("the note reports a paper that is already finished", async () => {
  const finished = await service.getReadingNote({
    libraryID: 1,
    itemKey: "DEEPREAD",
  });
  assert.equal(finished.found, true);
  assert.equal(finished.readingSession.state, "committed");
  assert.equal(finished.progress.coverageComplete, true);
  assert.equal(finished.progress.finalSynthesisDone, true);
  assert.ok(finished.readingNote.markdown.includes("8 K/mm"));

  const never = await service.getReadingNote({
    libraryID: 1,
    itemKey: "NOSUCHIT",
  });
  assert.equal(never.found, false);
});

// =========================================================================
// 10. The note must never be indexed as if it were the paper
// =========================================================================

block("the reading note is identifiable, and the indexer skips it", async () => {
  const { attachment } = await readNoteFromDisk("DEEPREAD");
  assert.ok(
    isWikiReadingNoteAttachment(attachment),
    "identity is checkable without the database",
  );
  const ordinary = fake.createAttachment({
    parent: await fake.Zotero.Items.getByLibraryAndKeyAsync(1, "DEEPREAD"),
    title: "MinerU Markdown (ABCD1234).md",
    filePath: path.join(tempDir, "full.md"),
  });
  assert.equal(
    isWikiReadingNoteAttachment(ordinary),
    false,
    "a generated body Markdown is still a body source",
  );
  assert.equal(isWikiReadingNoteAttachment(null), false);

  // Both indexing entry points have to consult it: the content extractor,
  // which would otherwise index the model's summary as the paper's text, and
  // the staleness check, which would otherwise re-index the whole item after
  // every batch because the note's mtime just moved.
  const indexer = fs.readFileSync(
    new URL("../src/modules/semantic/semanticSearchService.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    indexer,
    /if \(isWikiReadingNoteAttachment\(attachment\)\) continue;/u,
    "extractItemContent must skip the reading note before classifying it",
  );
  assert.match(
    indexer,
    /if \(att && isWikiReadingNoteAttachment\(att\)\) continue;/u,
    "the attachment-mtime scan must ignore the reading note",
  );
});

// --- Run ------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${error?.message}`);
    if (process.env.VERBOSE) console.error(error);
  }
}

await service.pumpEmbeddingQueue();
handle.open = false;
sqlite.close();
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  // Windows sometimes holds the SQLite file briefly; a temp dir is disposable.
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
