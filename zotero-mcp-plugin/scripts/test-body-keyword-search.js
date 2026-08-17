/* eslint-env node */
/**
 * End-to-end body-keyword retrieval over a real SQLite index: postings ->
 * intersection -> verification -> BM25F -> one row per document.
 *
 *   node --experimental-strip-types --experimental-sqlite scripts/test-body-keyword-search.js
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { KeywordIndexStore } = await import(
  "../src/modules/keyword/keywordIndexStore.ts"
);
const { runBodyKeywordSearch } = await import(
  "../src/modules/keyword/bodyKeywordSearch.ts"
);

globalThis.ztoolkit = { log: () => undefined };

function adapt(sqlite) {
  let depth = 0;
  return {
    async queryAsync(sql, params = []) {
      const statement = sqlite.prepare(sql);
      if (/^\s*(select|pragma)/iu.test(sql)) return statement.all(...params);
      statement.run(...params);
      return [];
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

const LIBRARY = 1;

/**
 * Four papers chosen so each one isolates a behaviour under test:
 *   TITLEHIT  the query term is in the TITLE and once in the body
 *   BODYHIT   the same term appears many times but ONLY in the body
 *   DECOY     contains the query's bigrams but never the Chinese term itself
 *   ZHPAPER   a genuine Chinese match
 */
const PAPERS = [
  {
    itemKey: "TITLEHIT",
    title: "Hot deformation of FGH4096 superalloy",
    abstract: "A study of the FGH4096 alloy under compression.",
    tags: ["superalloy"],
    chunks: [
      "Hot deformation of FGH4096 superalloy",
      "A study of the FGH4096 alloy under compression.",
      "The FGH4096 samples were compressed at 1050 C.",
    ],
  },
  {
    itemKey: "BODYHIT",
    title: "Microstructure of a nickel base disc alloy",
    abstract: "Grain structure of a turbine disc material is reported.",
    tags: [],
    chunks: [
      "Microstructure of a nickel base disc alloy",
      "Grain structure of a turbine disc material is reported.",
      "The FGH4096 powder was consolidated by hot isostatic pressing. FGH4096 billets were then forged.",
      "FGH4096 exhibits a duplex grain structure. The FGH4096 grain size was measured.",
      "Comparison with FGH4096 shows the same trend for FGH4096 at all strain rates.",
    ],
  },
  {
    itemKey: "DECOYZH",
    title: "Ring shaped grains in cast alloys",
    abstract: "No columnar structures were produced.",
    tags: [],
    chunks: [
      "Ring shaped grains in cast alloys",
      "柱状组织与环状晶粒在本实验条件下分别出现在不同区域。",
    ],
  },
  {
    itemKey: "ZHPAPER",
    title: "定向凝固柱状晶组织演化",
    abstract: "研究温度梯度对柱状晶生长的影响。",
    tags: ["定向凝固"],
    chunks: [
      "定向凝固柱状晶组织演化",
      "研究温度梯度对柱状晶生长的影响。",
      "柱状晶阵列在高温度梯度下保持良好取向，柱状晶间距随梯度增大而减小。",
    ],
  },
];

/** Resolver backed by the same chunk texts the vector index would have stored. */
function makeResolver(papers) {
  const byKey = new Map(papers.map((paper) => [paper.itemKey, paper]));
  const calls = { chunkTexts: 0, metadataTexts: 0, pairsRequested: 0 };
  return {
    calls,
    async chunkTexts(libraryID, pairs) {
      calls.chunkTexts += 1;
      calls.pairsRequested += pairs.length;
      const out = new Map();
      for (const pair of pairs) {
        const text = byKey.get(pair.itemKey)?.chunks?.[pair.chunkId];
        if (text !== undefined)
          out.set(`${pair.itemKey}:${pair.chunkId}`, text);
      }
      return out;
    },
    async metadataTexts(libraryID, itemKeys) {
      calls.metadataTexts += 1;
      const out = new Map();
      for (const key of itemKeys) {
        const paper = byKey.get(key);
        if (!paper) continue;
        out.set(key, {
          title: paper.title ?? "",
          abstract: paper.abstract ?? "",
          tags: (paper.tags ?? []).join("\n"),
        });
      }
      return out;
    },
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let tempDir;
const opened = [];
async function seeded(papers = PAPERS) {
  const file = path.join(
    tempDir,
    `bk-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  const sqlite = new DatabaseSync(file);
  opened.push(sqlite);
  const store = new KeywordIndexStore(adapt(sqlite));
  for (const paper of papers) {
    await store.writeItem({ libraryID: LIBRARY, ...paper });
  }
  return { store, resolver: makeResolver(papers), sqlite };
}

const probe = (text, weight = 1) => ({ text, weight });

// -------------------------------------------------------------------------

test("a body-only term retrieves the paper metadata search cannot reach", async () => {
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("FGH4096")],
  });
  const keys = outcome.results.map((result) => result.itemKey);
  assert.ok(keys.includes("BODYHIT"), "the body-only paper must appear");
  assert.ok(keys.includes("TITLEHIT"));
});

test("a title hit outranks a body-only hit for the same term", async () => {
  // This is the ordering question the field weights exist to answer: BODYHIT
  // mentions FGH4096 six times in its body, TITLEHIT three times but one of them
  // in the title. The title must still win.
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("FGH4096")],
  });
  assert.equal(outcome.results[0].itemKey, "TITLEHIT");
  const bodyOnly = outcome.results.find((r) => r.itemKey === "BODYHIT");
  assert.ok(bodyOnly.score > 0, "but the body-only paper still scores");
  assert.ok(outcome.results[0].score > bodyOnly.score);
});

test("a body-only hit reports which fields it matched", async () => {
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("FGH4096")],
  });
  const bodyOnly = outcome.results.find((r) => r.itemKey === "BODYHIT");
  assert.deepEqual(bodyOnly.matchedFields, ["body"]);
  const titled = outcome.results.find((r) => r.itemKey === "TITLEHIT");
  assert.deepEqual(titled.matchedFields, ["title", "abstract", "body"]);
});

test("each document occupies exactly one row, with passages attached", async () => {
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("FGH4096")],
  });
  const keys = outcome.results.map((result) => result.itemKey);
  assert.equal(new Set(keys).size, keys.length, "no document appears twice");
  const bodyOnly = outcome.results.find((r) => r.itemKey === "BODYHIT");
  assert.ok(bodyOnly.evidence.length > 0, "passages are the evidence");
  assert.ok(bodyOnly.evidence.length <= 3, "capped");
  for (const chunk of bodyOnly.evidence) {
    assert.ok(typeof chunk.text === "string" && chunk.text.length > 0);
    assert.ok(chunk.text.includes("FGH4096"), "the passage really contains it");
  }
});

test("evidence passages come back in the paper's own chunk numbering", async () => {
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("FGH4096")],
  });
  const bodyOnly = outcome.results.find((r) => r.itemKey === "BODYHIT");
  for (const chunk of bodyOnly.evidence) {
    // Same numbers search_fulltext / get_document_chunks already expose.
    assert.equal(
      chunk.text,
      PAPERS.find((p) => p.itemKey === "BODYHIT").chunks[chunk.chunkId],
    );
  }
});

test("verification removes the Chinese false hit the bigram index allows", async () => {
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("柱状晶")],
  });
  const keys = outcome.results.map((result) => result.itemKey);
  assert.ok(keys.includes("ZHPAPER"), "the real match is kept");
  assert.ok(
    !keys.includes("DECOYZH"),
    "the paper containing 柱状 and 状晶 apart must be rejected",
  );
  assert.ok(
    outcome.diagnostics.rejectedByVerification > 0,
    "and the rejection must be reported",
  );
});

test("without verification that same decoy WOULD have matched", async () => {
  // Guards the premise of the whole design: the decoy really does satisfy the
  // bigram conjunction, so verification is doing work rather than decoration.
  const { store } = await seeded();
  const decoyPostings = await store.lookup(LIBRARY, "柱状");
  const secondPostings = await store.lookup(LIBRARY, "状晶");
  const live = await store.liveDocuments(LIBRARY);
  const docsOf = (postings) =>
    new Set(
      postings
        .filter((posting) => posting.field === "body")
        .map((posting) => live.get(posting.docId)?.itemKey),
    );
  const both = [...docsOf(decoyPostings)].filter((key) =>
    docsOf(secondPostings).has(key),
  );
  assert.ok(both.includes("DECOYZH"), "the decoy satisfies both bigrams");
});

test("a multi-word phrase is not satisfied by its words appearing apart", async () => {
  const papers = [
    {
      itemKey: "PHRASE01",
      title: "Alloy study",
      chunks: ["Alloy study", "The Inconel 718 alloy was solution treated."],
    },
    {
      itemKey: "PHRASE02",
      title: "Other study",
      chunks: ["Other study", "Inconel 625 was tested according to ISO 718."],
    },
  ];
  const { store, resolver } = await seeded(papers);
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("Inconel 718")],
  });
  assert.deepEqual(
    outcome.results.map((result) => result.itemKey),
    ["PHRASE01"],
  );
});

test("more distinct keywords matched beats one keyword repeated", async () => {
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("定向凝固"), probe("柱状晶"), probe("温度梯度")],
  });
  const zh = outcome.results.find((result) => result.itemKey === "ZHPAPER");
  assert.ok(zh, "the Chinese paper matches all three");
  assert.equal(zh.matchedKeywords.length, 3);
  assert.equal(zh.keywordCoverage, 1);
});

test("evidence passages are ordered by how many keywords they carry", async () => {
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("柱状晶"), probe("温度梯度")],
  });
  const zh = outcome.results.find((result) => result.itemKey === "ZHPAPER");
  const counts = zh.evidence.map((chunk) => chunk.matchedKeywords.length);
  assert.deepEqual(
    counts,
    [...counts].sort((a, b) => b - a),
    "most-covering passage first",
  );
  assert.equal(counts[0], 2, "chunk 2 carries both terms");
});

test("scope is applied before any text is read", async () => {
  const { store, resolver } = await seeded();
  const before = resolver.calls.pairsRequested;
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("FGH4096")],
    scopeItemKeys: new Set(["TITLEHIT"]),
  });
  assert.deepEqual(
    outcome.results.map((result) => result.itemKey),
    ["TITLEHIT"],
  );
  // Only the in-scope document's passages were ever requested.
  const requested = resolver.calls.pairsRequested - before;
  assert.ok(requested <= 3, `read ${requested} passages for one document`);
});

test("a probe the index cannot represent is reported, not silently ignored", async () => {
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("a"), probe("FGH4096")],
  });
  assert.equal(outcome.diagnostics.probesUnindexable, 1);
  assert.equal(outcome.diagnostics.probesPlanned, 1);
  assert.ok(outcome.results.length > 0, "the usable probe still works");
});

test("a zero-weight probe is skipped entirely", async () => {
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("FGH4096", 0)],
  });
  assert.equal(outcome.results.length, 0);
  assert.equal(outcome.diagnostics.probesPlanned, 0);
});

test("an empty index answers empty instead of failing", async () => {
  const { store, resolver } = await seeded([]);
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("FGH4096")],
  });
  assert.deepEqual(outcome.results, []);
  assert.equal(outcome.diagnostics.indexedDocuments, 0);
});

test("an expired deadline truncates and says so", async () => {
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("FGH4096")],
    deadlineAt: Date.now() - 1,
  });
  assert.equal(outcome.diagnostics.truncated, true);
  assert.deepEqual(outcome.results, []);
});

test("cancellation stops the lookup", async () => {
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("FGH4096")],
    isCancelled: () => true,
  });
  assert.equal(outcome.diagnostics.truncated, true);
});

test("a tombstoned document never appears in results", async () => {
  const { store, resolver } = await seeded();
  await store.removeItem(LIBRARY, "BODYHIT");
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("FGH4096")],
  });
  assert.ok(!outcome.results.some((result) => result.itemKey === "BODYHIT"));
  assert.ok(outcome.results.some((result) => result.itemKey === "TITLEHIT"));
});

test("gamma prime reaches a paper that only writes the symbol", async () => {
  const papers = [
    {
      itemKey: "GAMMA001",
      title: "Precipitate coarsening",
      chunks: [
        "Precipitate coarsening",
        "The γ′ precipitates coarsened during ageing, while γ remained stable.",
      ],
    },
  ];
  const { store, resolver } = await seeded(papers);
  for (const keyword of ["gamma prime", "γ′", "γ'"]) {
    const outcome = await runBodyKeywordSearch(store, resolver, {
      libraryID: LIBRARY,
      probes: [probe(keyword)],
    });
    assert.equal(
      outcome.results.length,
      1,
      `${keyword} should reach the paper`,
    );
  }
});

test("diagnostics account for the work done", async () => {
  const { store, resolver } = await seeded();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: [probe("柱状晶"), probe("FGH4096")],
  });
  const d = outcome.diagnostics;
  assert.equal(d.indexedDocuments, PAPERS.length);
  assert.equal(d.probesPlanned, 2);
  assert.ok(d.postingsRead > 0);
  assert.ok(d.candidateDocuments > 0);
  assert.ok(d.verifiedHits > 0);
  assert.ok(d.totalMs >= 0 && d.lookupMs >= 0 && d.verifyMs >= 0);
});

// -------------------------------------------------------------------------

tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-search-test-"));
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(
      `       ${String(error.message).split("\n").join("\n       ")}`,
    );
  }
}
for (const sqlite of opened) {
  try {
    sqlite.close();
  } catch {
    // Only the file lock matters.
  }
}
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch (error) {
  console.warn(`  note: could not remove ${tempDir}: ${error.code ?? error}`);
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
