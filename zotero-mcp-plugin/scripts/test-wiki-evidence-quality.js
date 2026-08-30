/* eslint-env node */

/**
 * What an Evidence excerpt has to be before a Claim may rest on it.
 *
 * Every other gate in the Wiki had a floor and this one did not: an excerpt
 * only had to be non-empty and appear somewhere in the paper. So the cheapest
 * route to ANY Claim was to quote a bare term out of a chunk that was
 * genuinely read. Every downstream check then passed, correctly: the words
 * really are in the paper, the passage really was read, the reading note
 * really cites it. Nothing checked that the quotation said anything, and the
 * evidence trail a later reader follows led to a word.
 *
 * The second half is provenance. When the named `chunkIdSnapshot` did not
 * contain the excerpt, the whole document was searched and the first match was
 * accepted SILENTLY - which made `wikiEvidenceDiagnostics`' own "the excerpt is
 * real; the chunkIdSnapshot is wrong. Resubmit it with chunkIdSnapshot N"
 * message unreachable from the only code path that could raise it. With a
 * short excerpt, "the first chunk that contains it" is a guess, and it was
 * being recorded as a fact.
 *
 * Real SQLite and real files, like the other reading suites: these guarantees
 * are about what ends up stored, and in-memory doubles cannot show that.
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-evidence-"));
const fake = createZoteroFake({ rootDir: tempDir });
fake.install();

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService, WIKI_EVIDENCE_MIN_EXCERPT_CHARS } = await import(
  "../src/modules/wiki/wikiService.ts"
);
const { getVectorStore } = await import(
  "../src/modules/semantic/vectorStore.ts"
);
const { getEmbeddingService } = await import(
  "../src/modules/semantic/embeddingService.ts"
);

// --- Fixtures -------------------------------------------------------------

/**
 * Six chunks that share one long sentence and differ only in their opening.
 *
 * That shape is the point. The shared sentence is a legitimate-looking, long
 * excerpt that identifies NOTHING - it is in every chunk - while the opening
 * identifies exactly one. Real papers do this constantly with method
 * boilerplate, figure captions and repeated definitions.
 */
const SHARED =
  "dynamic recrystallisation refines the grain structure above the critical strain.";

function chunksFor(key) {
  return Array.from({ length: 6 }, (_, i) => ({
    chunkId: 100 + i,
    text: `${key} passage ${i}: ${SHARED}`,
    language: "en",
  }));
}

/** One paper per test, so a refused commit's outstanding debt stays local. */
const PAPERS = [
  "EVID0001",
  "EVID0002",
  "EVID0003",
  "EVID0004",
  "EVID0005",
  "EVID0006",
  "EVID0007",
];
const indexedChunks = new Map(PAPERS.map((key) => [key, chunksFor(key)]));

for (const key of PAPERS) {
  fake.createPaper({
    key,
    title: `Paper ${key}`,
    abstract: `Abstract of ${key}: recrystallisation under hot deformation.`,
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
  sourceKind: "body",
});
vectorStore.getCommittedResetGeneration = async () => "reset-1";

const embeddingService = getEmbeddingService();
embeddingService.getConfig = () => ({ model: "test-embed-model" });
embeddingService.embed = async () => ({ embedding: new Float32Array([1, 0]) });

const dbPath = path.join(tempDir, "wiki.sqlite");
const sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");
const store = new WikiStore(adapt(sqlite));
await store.initialize();
const service = new WikiService(store);

// --- Helpers --------------------------------------------------------------

function note(key) {
  return [
    `# Recrystallisation in ${key}`,
    "",
    "## Research question",
    "How hot deformation changes the grain structure, and at what strain the change begins.",
    "",
    "## Materials and method",
    "A nickel-base alloy deformed on a Gleeble simulator, with grain size measured after quenching.",
    "",
    "## Findings",
    "Dynamic recrystallisation refines the grain structure once the critical strain is exceeded (chunk 100).",
    "The same refinement is reported at each measurement station of the series (chunk 101).",
    "",
    "## Scope and limits",
    "One alloy and one deformation path; nothing outside the reported strain range is demonstrated here.",
  ].join("\n");
}

/** Read chunks 0 and 1 of a paper, the way answering a question does. */
function read(key) {
  return service.updateReadingNote({
    libraryID: 1,
    itemKey: key,
    readChunkIds: [100, 101],
    domain: "physical metallurgy / hot deformation",
    expertRole: "recrystallisation specialist",
    markdown: note(key),
  });
}

function writeOffRest(key, owed) {
  return owed.length
    ? [
        {
          action: "SKIP",
          itemKey: key,
          chunkIds: owed,
          reason:
            "Those passages restate the same refinement at the same critical strain, and the Page " +
            "already carries it as a Claim with its own excerpt; they add no condition or parameter.",
        },
      ]
    : [];
}

/** Commit one Claim carrying one Evidence entry, and settle whatever is left. */
async function commitWith(key, evidence, title) {
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: title,
    proposedPageTitles: [title],
  });
  const sessions = await store.readingSessions();
  const open = await sessions.openForItem(1, key);
  const owed = open
    ? (await sessions.pendingWikiChunks(open.sessionId)).map((c) => c.chunkId)
    : [];
  const cited = Number(evidence.chunkIdSnapshot);
  // A question-driven write-up records terminology or declares it found none.
  // These blocks are about Evidence quality, so they declare.
  try {
    await service.recordConcepts({
      libraryID: 1,
      itemKey: key,
      concepts: [],
      noConceptsReason:
        `本轮读到的段落只用到库中已有的术语，没有引入新的领域概念，${key} 的既有条目已经覆盖这些说法。`,
    });
  } catch {
    // Not a question-driven session; no declaration is owed.
  }
  return service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: prepared.prepareToken,
    actions: [
      { action: "CREATE_PAGE", ref: "p", canonicalTitle: title },
      {
        action: "ADD_CLAIM",
        ref: "c",
        pageId: "p",
        claimText:
          `Dynamic recrystallisation refines the grain structure of ${key} above the critical strain.`,
        claimType: "mechanism",
        epistemicStatus: "provisional",
        coverageLevel: "chunk_local",
        confidence: 0.7,
        evidence: [evidence],
      },
      ...writeOffRest(
        key,
        owed.filter((id) => id !== cited),
      ),
    ],
  });
}

function evidence(overrides) {
  return {
    libraryID: 1,
    evidenceRole: "SUPPORTS",
    readDepth: "chunk_local",
    ...overrides,
  };
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// =========================================================================
// The floor
// =========================================================================

test("a bare term is refused, however genuinely it is in the paper", async () => {
  const key = "EVID0001";
  await read(key);
  // "refines the grain" really is in chunk 100, and chunk 100 really was read.
  // Every other gate in the system passes it; only this one does not.
  await assert.rejects(
    () =>
      commitWith(
        key,
        evidence({
          itemKey: key,
          chunkIdSnapshot: 100,
          excerpt: "refines the grain",
        }),
        "Recrystallisation onset",
      ),
    (error) => {
      assert.match(error.message, /17 characters/u);
      assert.match(error.message, /TERM rather than a passage/u);
      assert.match(
        error.message,
        new RegExp(`${WIKI_EVIDENCE_MIN_EXCERPT_CHARS} are needed`, "u"),
      );
      return true;
    },
  );
});

test("an excerpt exactly at the floor is accepted", async () => {
  const key = "EVID0002";
  await read(key);
  const excerpt = indexedChunks
    .get(key)[0]
    .text.slice(0, WIKI_EVIDENCE_MIN_EXCERPT_CHARS);
  assert.equal(excerpt.length, WIKI_EVIDENCE_MIN_EXCERPT_CHARS);
  const result = await commitWith(
    key,
    evidence({ itemKey: key, chunkIdSnapshot: 100, excerpt }),
    "Recrystallisation floor",
  );
  assert.equal(result.committed, true, JSON.stringify(result));
});

// =========================================================================
// Provenance
// =========================================================================

test("a correctly named chunk is recorded as given, with no complaint", async () => {
  const key = "EVID0003";
  await read(key);
  const result = await commitWith(
    key,
    evidence({
      itemKey: key,
      chunkIdSnapshot: 101,
      excerpt: `${key} passage 1: dynamic recrystallisation`,
    }),
    "Recrystallisation named",
  );
  assert.equal(result.committed, true, JSON.stringify(result));
  assert.ok(
    !result.warnings.some((w) => /does not contain the excerpt/u.test(w)),
    `no provenance warning was due: ${JSON.stringify(result.warnings)}`,
  );
});

test(
  "a wrong chunkIdSnapshot with ONE real home is corrected AND reported",
  async () => {
    const key = "EVID0004";
    await read(key);
    // The passage is unmistakably chunk 101; the caller said 100.
    const result = await commitWith(
      key,
      evidence({
        itemKey: key,
        chunkIdSnapshot: 100,
        excerpt: `${key} passage 1: dynamic recrystallisation`,
      }),
      "Recrystallisation misfiled",
    );
    assert.equal(result.committed, true, JSON.stringify(result));
    const warning = result.warnings.find((w) =>
      /does not contain the excerpt/u.test(w),
    );
    assert.ok(
      warning,
      `the silent correction must be reported: ${JSON.stringify(result.warnings)}`,
    );
    assert.match(warning, /submitted as chunk 100/u);
    assert.match(warning, /it is in chunk 101/u);
  },
);

test("an excerpt that identifies no single chunk is refused", async () => {
  const key = "EVID0005";
  await read(key);
  // Long, verbatim, and in all six chunks: exactly the shape that used to be
  // resolved by taking whichever came first.
  await assert.rejects(
    () =>
      commitWith(
        key,
        evidence({ itemKey: key, chunkIdSnapshot: 999, excerpt: SHARED }),
        "Recrystallisation ambiguous",
      ),
    (error) => {
      assert.match(error.message, /appears in 6 chunks/u);
      assert.match(error.message, /cannot be determined/u);
      assert.match(error.message, /guess recorded as a fact/u);
      return true;
    },
  );
});

test(
  "a repeated passage IS accepted when the caller names which chunk it read",
  async () => {
    const key = "EVID0006";
    await read(key);
    // Same excerpt as the refusal above. The difference is that chunk 100
    // carries it and the caller said so, which settles provenance.
    const result = await commitWith(
      key,
      evidence({ itemKey: key, chunkIdSnapshot: 100, excerpt: SHARED }),
      "Recrystallisation disambiguated",
    );
    assert.equal(result.committed, true, JSON.stringify(result));
  },
);

// =========================================================================
// The gate this must not have weakened
// =========================================================================

test("a long, unique excerpt from an UNREAD chunk is still refused", async () => {
  const key = "EVID0007";
  await read(key);
  await assert.rejects(
    () =>
      commitWith(
        key,
        evidence({
          itemKey: key,
          chunkIdSnapshot: 105,
          excerpt: `${key} passage 5: dynamic recrystallisation`,
        }),
        "Recrystallisation unread",
      ),
    /not recorded as read/u,
  );
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

sqlite.close();
fs.rmSync(tempDir, { recursive: true, force: true });

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
