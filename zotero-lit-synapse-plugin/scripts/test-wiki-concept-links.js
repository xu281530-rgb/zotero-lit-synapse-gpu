/* eslint-env node */

/**
 * Cross-paper connection, phase 0: concept sources that actually land, and the
 * document edges they support.
 *
 * The state this suite exists to prevent is the one the reference library was
 * observed in: five papers written up, twenty concepts, twenty concept-term
 * sources - one apiece - and a knowledge graph of five isolated nodes. Nothing
 * was broken. Every term a question-driven read recognised had been STAGED on
 * a reading session that never closes, because staging is drained only by the
 * whole-paper pass and a question never reaches one.
 *
 * Each block is named for the failure it pins down:
 *
 *   1. A source submitted during question-driven reading is staged and never
 *      written, so the concept keeps connecting one document.
 *   2. The attach door is used to found, rename, complete or merge a concept
 *      without the confirmation the ordinary write raises.
 *   3. A source is attached for a passage nobody read, or for a quotation that
 *      is not in the chunk it names, or for a different paper entirely.
 *   4. A concept behind two papers still produces no document edge.
 *   5. One ubiquitous term draws a complete graph.
 *   6. wiki_status reports growth that says nothing about connection.
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-links-"));
const fake = createZoteroFake({ rootDir: tempDir });
fake.install();

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { getVectorStore } = await import(
  "../src/modules/semantic/vectorStore.ts"
);

function adapt(sqlite) {
  let depth = 0;
  const normalize = (params) =>
    params.map((value) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
  return {
    async queryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const statement = sqlite.prepare(sql);
      const values = normalize(params);
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) {
        return statement.all(...values);
      }
      statement.run(...values);
      return [];
    },
    async valueQueryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const row = sqlite.prepare(sql).get(...normalize(params));
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

// --- Library ---------------------------------------------------------------
//
// Four papers. Three of them discuss dynamic recrystallization, which is the
// ubiquitous term; only two discuss the Lomer-Cottrell lock, which is the rare
// one. That asymmetry is the point of the IDF blocks below.

const CHUNKS = new Map([
  [
    "PAPERONE",
    [
      {
        chunkId: 11,
        text: "动态再结晶在临界应变之后细化了晶粒组织，是本文观察到的主要软化机制。",
        language: "zh",
      },
      {
        chunkId: 12,
        text: "Lomer-Cottrell 位错锁的形成抑制了后续的位错滑移，从而提高了加工硬化率。",
        language: "zh",
      },
    ],
  ],
  [
    "PAPERTWO",
    [
      {
        chunkId: 21,
        text: "热压缩过程中动态再结晶导致位错密度显著下降，流变应力出现明显软化。",
        language: "zh",
      },
      {
        chunkId: 22,
        text: "透射电镜观察表明 Lomer-Cottrell 位错锁广泛存在于变形基体之中。",
        language: "zh",
      },
    ],
  ],
  [
    "PAPRTHRE",
    [
      {
        chunkId: 31,
        text: "本文同样记录到动态再结晶，但其形核位置集中在原始晶界附近。",
        language: "zh",
      },
    ],
  ],
  [
    "PAPERFOR",
    [
      {
        chunkId: 41,
        text: "柱状晶向等轴晶转变发生在 8 K/mm 的温度梯度条件下。",
        language: "zh",
      },
    ],
  ],
]);

for (const [key, title] of [
  ["PAPERONE", "热变形中的晶粒细化"],
  ["PAPERTWO", "热压缩软化机制研究"],
  ["PAPRTHRE", "再结晶形核位置分析"],
  ["PAPERFOR", "定向凝固组织转变"],
]) {
  fake.createPaper({ key, title });
}

const vectorStore = getVectorStore();
// These fixtures keep one stationary source; revision changes are tested in Zotero.
vectorStore.getDocumentRevision = async () => "";
vectorStore.initialize = async () => {};
vectorStore.getChunksForItem = async (key) => CHUNKS.get(key) ?? [];
vectorStore.getIndexStatus = async (key) => ({
  contentHash: `content-${key}`,
  sourceKind: "body",
});
vectorStore.getCommittedResetGeneration = async () => "reset-1";

const dbPath = path.join(tempDir, "zotero-lit-synapse-wiki.sqlite");
const sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");
const store = new WikiStore(adapt(sqlite));
await store.initialize();
const service = new WikiService(store);

const results = [];
async function block(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message}`);
  }
}

/** Put chunks into a paper's reading ledger, as a question-driven read does. */
async function readChunks(itemKey, chunkIds) {
  const sessions = await store.readingSessions();
  const documentChunks = CHUNKS.get(itemKey);
  const session = await sessions.startOrContinue({
    libraryID: 1,
    itemKey,
    title: itemKey,
    totalChunks: documentChunks.length,
    mode: "qa",
  });
  await sessions.recordReadChunkIds(session.sessionId, chunkIds, documentChunks);
  return session;
}

const conceptsOf = async () => (await store.concepts()).list(1);
const byName = async (name) =>
  (await conceptsOf()).find((concept) => concept.displayName === name);
const sourceDocumentsOf = async (conceptId) => {
  const concept = (await conceptsOf()).find(
    (entity) => entity.conceptId === conceptId,
  );
  const keys = new Set();
  for (const term of [concept.primaryTerm, ...concept.aliasTerms]) {
    for (const source of term?.sources ?? []) keys.add(source.itemKey);
  }
  return keys;
};

// --- 1. The staging trap ---------------------------------------------------

await block(
  "a question-driven read cannot record a concept source by staging it",
  async () => {
    await readChunks("PAPERONE", [11, 12]);
    const staged = await service.recordConcepts({
      libraryID: 1,
      itemKey: "PAPERONE",
      concepts: [
        {
          primaryTerm: {
            zh: "动态再结晶",
            en: "Dynamic Recrystallization",
            abbr: "DRX",
          },
          sources: [
            {
              itemKey: "PAPERONE",
              chunkIdSnapshot: 11,
              excerpt: "动态再结晶在临界应变之后细化了晶粒组织",
            },
          ],
        },
      ],
    });
    assert.equal(staged.written, false, "a named concept is still staged");
    assert.equal(staged.staged, 1);
    assert.equal(
      (await conceptsOf()).length,
      0,
      "staging must not reach the concept tables — this is the trap, not a bug",
    );
  },
);

// The concept has to exist before it can be attached to, so found it the
// ordinary way: this is what a full-text read's final pass does.
await block("the ordinary write still founds concepts", async () => {
  const written = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "动态再结晶",
          en: "Dynamic Recrystallization",
          abbr: "DRX",
        },
        sources: [
          {
            itemKey: "PAPERONE",
            chunkIdSnapshot: 11,
            excerpt: "动态再结晶在临界应变之后细化了晶粒组织",
          },
        ],
      },
      {
        primaryTerm: { zh: "Lomer-Cottrell 位错锁", en: "Lomer-Cottrell lock" },
        sources: [
          {
            itemKey: "PAPERONE",
            chunkIdSnapshot: 12,
            excerpt: "Lomer-Cottrell 位错锁的形成抑制了后续的位错滑移",
          },
        ],
      },
      {
        primaryTerm: { zh: "柱状晶向等轴晶转变", en: "columnar-to-equiaxed transition", abbr: "CET" },
        sources: [{ itemKey: "PAPERFOR" }],
      },
    ],
  });
  assert.equal(written.written, true);
  assert.equal(written.createdConcepts, 3);
});

// --- 2. Attaching a second document ----------------------------------------

await block(
  "conceptId with sources alone writes immediately, without staging",
  async () => {
    await readChunks("PAPERTWO", [21, 22]);
    const drx = await byName("动态再结晶");
    const attached = await service.recordConcepts({
      libraryID: 1,
      itemKey: "PAPERTWO",
      concepts: [
        {
          conceptId: drx.conceptId,
          sources: [
            {
              itemKey: "PAPERTWO",
              chunkIdSnapshot: 21,
              excerpt: "动态再结晶导致位错密度显著下降",
            },
          ],
        },
      ],
    });
    assert.equal(attached.added, 1, "the source landed on this call");
    assert.equal(
      attached.staged,
      0,
      "an attachment is not counted as staged, because it was not staged",
    );
    assert.deepEqual(
      await sourceDocumentsOf(drx.conceptId),
      new Set(["PAPERONE", "PAPERTWO"]),
      "the concept now connects two documents",
    );
    assert.equal(
      attached.attachedConcepts[0].displayName,
      "动态再结晶",
      "the response names what it attached to, not just an id",
    );
  },
);

await block("an attachment carries the write path that proves it ran", async () => {
  const row = sqlite
    .prepare(
      "SELECT COUNT(*) AS n FROM wiki_concept_term_sources WHERE write_path = 'attach'",
    )
    .get();
  assert.equal(row.n, 1);
});

await block("re-attaching the same quotation adds nothing twice", async () => {
  const drx = await byName("动态再结晶");
  const again = await service.recordConcepts({
    libraryID: 1,
    itemKey: "PAPERTWO",
    concepts: [
      {
        conceptId: drx.conceptId,
        sources: [
          {
            itemKey: "PAPERTWO",
            chunkIdSnapshot: 21,
            excerpt: "动态再结晶导致位错密度显著下降",
          },
        ],
      },
    ],
  });
  assert.equal(again.added, 0);
  assert.ok(
    again.warnings.some((line) => /already recorded/u.test(line)),
    "silence would read as success",
  );
});

// --- 3. What the attach door refuses ---------------------------------------

await block("the attach door cannot name, found or rename anything", async () => {
  const drx = await byName("动态再结晶");
  for (const naming of [
    { primaryTerm: { zh: "动态回复", en: "dynamic recovery" } },
    { terms: [{ zh: "再结晶", en: "recrystallization" }] },
    { description: "本文重新定义的机制" },
    { conceptType: "mechanism" },
  ]) {
    await assert.rejects(
      service.recordConcepts({
        libraryID: 1,
        itemKey: "PAPERTWO",
        concepts: [
          {
            conceptId: drx.conceptId,
            ...naming,
            sources: [
              {
                itemKey: "PAPERTWO",
                chunkIdSnapshot: 21,
                excerpt: "动态再结晶导致位错密度显著下降",
              },
            ],
          },
        ],
      }),
      /cannot carry/u,
      `${Object.keys(naming)[0]} must be refused at the attach door`,
    );
  }
});

await block("a passage nobody read cannot become a concept source", async () => {
  const drx = await byName("动态再结晶");
  // PAPRTHRE chunk 31 exists and really contains this sentence — it has just
  // never been delivered to anyone. That is the whole distinction.
  await assert.rejects(
    service.recordConcepts({
      libraryID: 1,
      itemKey: "PAPRTHRE",
      concepts: [
        {
          conceptId: drx.conceptId,
          sources: [
            {
              itemKey: "PAPRTHRE",
              chunkIdSnapshot: 31,
              excerpt: "本文同样记录到动态再结晶",
            },
          ],
        },
      ],
    }),
    /reading ledger/u,
  );
});

await block("a quotation must be in the chunk it names", async () => {
  const drx = await byName("动态再结晶");
  await assert.rejects(
    service.recordConcepts({
      libraryID: 1,
      itemKey: "PAPERTWO",
      concepts: [
        {
          conceptId: drx.conceptId,
          sources: [
            {
              // The sentence is real, but it is chunk 22's, not chunk 21's.
              itemKey: "PAPERTWO",
              chunkIdSnapshot: 21,
              excerpt: "透射电镜观察表明 Lomer-Cottrell 位错锁广泛存在",
            },
          ],
        },
      ],
    }),
    /not found in chunk 21/u,
  );
});

await block("an attachment may only name the paper being read", async () => {
  const drx = await byName("动态再结晶");
  await assert.rejects(
    service.recordConcepts({
      libraryID: 1,
      itemKey: "PAPERTWO",
      concepts: [
        {
          conceptId: drx.conceptId,
          sources: [
            {
              itemKey: "PAPERONE",
              chunkIdSnapshot: 11,
              excerpt: "动态再结晶在临界应变之后细化了晶粒组织",
            },
          ],
        },
      ],
    }),
    /only be attached for the paper being read/u,
  );
});

await block("a bad entry in a batch writes none of the batch", async () => {
  const drx = await byName("动态再结晶");
  const lock = await byName("Lomer-Cottrell 位错锁");
  const before = await sourceDocumentsOf(lock.conceptId);
  await assert.rejects(
    service.recordConcepts({
      libraryID: 1,
      itemKey: "PAPERTWO",
      concepts: [
        {
          conceptId: lock.conceptId,
          sources: [
            {
              itemKey: "PAPERTWO",
              chunkIdSnapshot: 22,
              excerpt: "透射电镜观察表明 Lomer-Cottrell 位错锁广泛存在",
            },
          ],
        },
        { conceptId: drx.conceptId, sources: [] },
      ],
    }),
    /records nothing/u,
  );
  assert.deepEqual(
    await sourceDocumentsOf(lock.conceptId),
    before,
    "the valid half of a refused batch must not have landed",
  );
});

await block("a concept from another library is not reachable", async () => {
  const drx = await byName("动态再结晶");
  const library = await store.concepts();
  // Asserted against the concept library rather than through the service,
  // because the service refuses a cross-library call one check earlier - the
  // reading ledger is per library too. Both refusals are correct; this one is
  // the backstop, and it is the one that would still hold if a future caller
  // reached the library some other way.
  await assert.rejects(
    library.attachExistingSources({
      libraryID: 2,
      conceptId: drx.conceptId,
      sources: [
        {
          libraryID: 2,
          itemKey: "PAPERTWO",
          chunkIdSnapshot: 21,
          excerpt: "动态再结晶导致位错密度显著下降",
        },
      ],
    }),
    /belongs to library 1/u,
  );
  await assert.rejects(
    library.attachExistingSources({
      libraryID: 1,
      conceptId: 99999,
      sources: [],
    }),
    /does not exist/u,
  );
});

// --- 4. Concepts become document edges -------------------------------------

await block("the rare concept and the common one are both attached", async () => {
  const lock = await byName("Lomer-Cottrell 位错锁");
  const drx = await byName("动态再结晶");
  await service.recordConcepts({
    libraryID: 1,
    itemKey: "PAPERTWO",
    concepts: [
      {
        conceptId: lock.conceptId,
        sources: [
          {
            itemKey: "PAPERTWO",
            chunkIdSnapshot: 22,
            excerpt: "透射电镜观察表明 Lomer-Cottrell 位错锁广泛存在",
          },
        ],
      },
    ],
  });
  await readChunks("PAPRTHRE", [31]);
  await service.recordConcepts({
    libraryID: 1,
    itemKey: "PAPRTHRE",
    concepts: [
      {
        conceptId: drx.conceptId,
        sources: [
          {
            itemKey: "PAPRTHRE",
            chunkIdSnapshot: 31,
            excerpt: "本文同样记录到动态再结晶",
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    await sourceDocumentsOf(drx.conceptId),
    new Set(["PAPERONE", "PAPERTWO", "PAPRTHRE"]),
  );
  assert.deepEqual(
    await sourceDocumentsOf(lock.conceptId),
    new Set(["PAPERONE", "PAPERTWO"]),
  );
});

await block("shared concepts project onto documents, weighted by rarity", async () => {
  const projection = await store.getConceptDocumentSources(1);
  assert.equal(
    projection.documentCount,
    4,
    "N is the documents with concept sources, not the size of the Zotero library",
  );
  const drx = projection.concepts.find(
    (concept) => concept.name === "动态再结晶",
  );
  const lock = projection.concepts.find((concept) =>
    concept.name.startsWith("Lomer-Cottrell"),
  );
  const cet = projection.concepts.find((concept) =>
    concept.name.includes("柱状晶"),
  );
  assert.equal(drx.df, 3);
  assert.equal(lock.df, 2);
  assert.equal(cet.df, 1);
  assert.ok(
    lock.idf > drx.idf,
    "a term two papers share must outweigh one three papers share",
  );
  assert.equal(
    projection.concepts[0].name,
    cet.name,
    "rarest first, so a caller that truncates keeps what discriminates",
  );
  // The arithmetic itself, so a later change to the formula is a decision
  // rather than a drift: idf = log((N + 1) / (df + 1)), N = 4.
  assert.ok(Math.abs(drx.idf - Math.log(5 / 4)) < 1e-9);
  assert.ok(Math.abs(lock.idf - Math.log(5 / 3)) < 1e-9);
});

await block("a concept sourced from one paper connects nothing", async () => {
  const projection = await store.getConceptDocumentSources(1);
  const cet = projection.concepts.find((concept) =>
    concept.name.includes("柱状晶"),
  );
  assert.equal(cet.itemKeys.length, 1);
  // The pairing is the panel's, but the fact it rests on is here: one itemKey
  // yields no pair, whatever the caller does with it.
  assert.equal(cet.itemKeys.length < 2, true);
});

// --- 5. wiki_status says whether any of this connected anything -------------

await block("status counts connection, not growth", async () => {
  const status = await store.getStatus(1);
  assert.equal(
    status.conceptsWithMultipleSources,
    2,
    "DRX and the Lomer-Cottrell lock; CET is behind one paper",
  );
  assert.equal(
    status.conceptSourceDocumentPairs,
    3,
    "DRX pairs ONE-TWO, ONE-THREE, TWO-THREE; the lock re-proposes ONE-TWO",
  );
  assert.equal(
    status.conceptSourceOnlyWrites,
    3,
    "every source that arrived through the attach door",
  );
  assert.ok(
    status.conceptTermSources > status.conceptTerms,
    "the phase-0 acceptance criterion: sources must outgrow terms",
  );
});

sqlite.close();
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  // Windows keeps a handle on a just-closed SQLite file for a moment; the
  // temp directory is the OS's problem, not this suite's verdict.
}

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
