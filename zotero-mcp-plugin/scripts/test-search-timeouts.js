/**
 * Search timeout guarantees.
 *
 * The property under test is narrow and important: NO retrieval branch can wait
 * forever. The library-level tool always asked for exhaustive retrieval, and
 * `exhaustive` used to replace both branch deadlines with an unbounded await —
 * so in practice hybrid_search had no timeout at all. Exhaustiveness now lives
 * only where it means breadth (the semantic scan) and never touches a deadline.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const { DEFAULT_KEYWORD_SEARCH_TIMEOUT_MS, runHybridSearch } = await import(
  "../src/modules/hybridSearch.ts"
);
const {
  KEYWORD_BENCHMARK_RUNS,
  RECOMMENDED_TIMEOUT_FLOOR_MS,
  recommendTimeoutMs,
  summarizeDurations,
  timeRuns,
} = await import("../src/modules/semantic/vectorScanBenchmark.ts");
const { buildKeywordProfiles, runKeywordSearchBenchmark, tokenizeForProfiles } =
  await import("../src/modules/keywordSearchBenchmark.ts");

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const keywordItem = (key, relevanceScore) => ({
  key,
  libraryID: 1,
  title: `Keyword ${key}`,
  relevanceScore,
});
const semanticItem = (itemKey, score) => ({
  itemKey,
  libraryID: 1,
  title: `Semantic ${itemKey}`,
  score,
  matchedChunks: [{ chunkId: 1, text: itemKey, score }],
});
const never = () => new Promise(() => {});

// ---- every branch is bounded, whatever the caller asks for ----

{
  const startedAt = Date.now();
  const run = await runHybridSearch(
    {
      query: "keyword branch hang",
      topK: 2,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
      keywordSearchTimeoutMs: 40,
      semanticBranchTimeoutMs: 500,
    },
    {
      keywordSearch: never,
      semanticSearch: async () => [semanticItem("S", 0.9)],
    },
  );
  assert.ok(
    Date.now() - startedAt < 400,
    "the keyword branch must time out rather than wait for a hung search",
  );
  assert.equal(run.degraded, true);
  assert.match(run.warnings.join(" "), /timed out/i);
  assert.deepEqual(
    run.results.map((result) => result.itemKey),
    ["S"],
    "the branch that did finish must still produce results",
  );
}

{
  const startedAt = Date.now();
  const run = await runHybridSearch(
    {
      query: "semantic branch hang",
      topK: 2,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
      keywordSearchTimeoutMs: 500,
      semanticBranchTimeoutMs: 40,
    },
    {
      keywordSearch: async () => [keywordItem("K", 9)],
      semanticSearch: never,
    },
  );
  assert.ok(Date.now() - startedAt < 400);
  assert.equal(run.degraded, true);
  assert.deepEqual(
    run.results.map((result) => result.itemKey),
    ["K"],
  );
}

{
  // Both branches hung: the caller gets an error rather than hanging with it.
  const startedAt = Date.now();
  await assert.rejects(
    runHybridSearch(
      {
        query: "both branches hang",
        topK: 2,
        rrfK: 60,
        keywordWeight: 1,
        semanticWeight: 1,
        keywordSearchTimeoutMs: 40,
        semanticBranchTimeoutMs: 40,
      },
      { keywordSearch: never, semanticSearch: never },
    ),
    /timed out/i,
  );
  assert.ok(Date.now() - startedAt < 400);
}

{
  // A caller that passes no budget at all is still bounded by the default.
  let keywordCancelled = false;
  const run = await runHybridSearch(
    {
      query: "default budget",
      topK: 1,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 0,
    },
    {
      keywordSearch: async () => [keywordItem("K", 1)],
      cancelKeywordSearch: () => {
        keywordCancelled = true;
      },
      semanticSearch: never,
    },
  );
  assert.equal(run.results.length, 1);
  assert.equal(keywordCancelled, false);
  assert.equal(typeof DEFAULT_KEYWORD_SEARCH_TIMEOUT_MS, "number");
  assert.ok(DEFAULT_KEYWORD_SEARCH_TIMEOUT_MS > 0);
}

{
  // The timed-out branch must be cancelled, not merely abandoned: otherwise it
  // keeps loading items in the background after nothing is waiting for it.
  let cancelled = false;
  await runHybridSearch(
    {
      query: "cancel on timeout",
      topK: 1,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
      keywordSearchTimeoutMs: 30,
      semanticBranchTimeoutMs: 500,
    },
    {
      keywordSearch: never,
      cancelKeywordSearch: () => {
        cancelled = true;
      },
      semanticSearch: async () => [semanticItem("S", 0.5)],
    },
  );
  assert.equal(cancelled, true);
}

// ---- the removed knobs are really gone ----

const hybridSource = fs.readFileSync(
  path.join(rootDir, "src/modules/hybridSearch.ts"),
  "utf8",
);
assert.doesNotMatch(hybridSource, /DEFAULT_SEMANTIC_TIMEOUT_MS/);
assert.doesNotMatch(hybridSource, /DEFAULT_HYBRID_TIMEOUT_MS/);
assert.doesNotMatch(
  hybridSource,
  /options\.exhaustive\s*\?\s*settleOperation/,
  "exhaustive must never select an unbounded branch runner again",
);
assert.doesNotMatch(hybridSource, /settleOperation/);
// Fusion already returns every scored candidate in `ranked`, so an `exhaustive`
// option at this layer could only ever have meant "skip the deadlines".
assert.doesNotMatch(hybridSource, /exhaustive\?: boolean/);
assert.doesNotMatch(hybridSource, /options\.exhaustive/);

const deepDiveSource = fs.readFileSync(
  path.join(rootDir, "src/modules/documentDeepDive.ts"),
  "utf8",
);
assert.doesNotMatch(deepDiveSource, /semanticTimeoutMs|totalTimeoutMs/);

const semanticSource = fs.readFileSync(
  path.join(rootDir, "src/modules/semantic/semanticSearchService.ts"),
  "utf8",
);
// The embedding request is a network call the scan deadline does not cover, so
// it needs its own bound or the branch can still hang on a dead endpoint.
assert.match(semanticSource, /DEFAULT_EMBEDDING_TIMEOUT_MS/);
assert.match(
  semanticSource,
  /withDeadline\(\s*\(\)\s*=>\s*\n?\s*this\.embeddingService\.embed/,
);
assert.doesNotMatch(
  semanticSource,
  /timeoutMs\?: number;\s*\/\/ /,
  "the old whole-search timeout must not linger next to the new ones",
);

const serverSource = fs.readFileSync(
  path.join(rootDir, "src/modules/streamableMCPServer.ts"),
  "utf8",
);
assert.doesNotMatch(serverSource, /args\.timeoutMs/);
assert.match(
  serverSource,
  /keywordSearchTimeoutMs: settings\.keywordSearchTimeoutMs/,
);

// ---- recommendation formula ----

// Stable timings: the doubling term decides.
assert.equal(
  recommendTimeoutMs({ averageMs: 9800, maxMs: 10000 }),
  20000,
  "a stable workload should be doubled",
);
// Spiky timings: max + 3x(max - average) is larger and must win.
assert.equal(
  recommendTimeoutMs({ averageMs: 2000, maxMs: 10000 }),
  34000,
  "a spiky workload deserves more headroom than doubling",
);
// A tiny library must not be handed a timeout the first GC pause would blow.
assert.equal(
  recommendTimeoutMs({ averageMs: 30, maxMs: 40 }),
  RECOMMENDED_TIMEOUT_FLOOR_MS,
);
assert.equal(
  recommendTimeoutMs({ averageMs: 0, maxMs: 0 }),
  RECOMMENDED_TIMEOUT_FLOOR_MS,
);
// Fractions round up: a stored timeout is an integer number of milliseconds.
assert.equal(recommendTimeoutMs({ averageMs: 4000, maxMs: 4000.4 }, 100), 8001);
// A custom floor still applies.
assert.equal(recommendTimeoutMs({ averageMs: 1, maxMs: 1 }, 7000), 7000);

// ---- timing helpers ----

{
  const summary = summarizeDurations([30, 10, 20]);
  assert.equal(summary.minMs, 10);
  assert.equal(summary.maxMs, 30);
  assert.equal(summary.averageMs, 20);
  assert.deepEqual(summarizeDurations([]), {
    durationsMs: [],
    minMs: 0,
    averageMs: 0,
    maxMs: 0,
  });

  let clock = 0;
  let calls = 0;
  const sample = await timeRuns(
    async () => {
      calls += 1;
      clock += calls * 10;
    },
    3,
    () => clock,
  );
  assert.equal(calls, 3);
  assert.deepEqual(sample.durationsMs, [10, 20, 30]);
}

// ---- keyword probe profiles ----

{
  assert.deepEqual(tokenizeForProfiles("Alloy solidification 2024"), [
    "alloy",
    "solidification",
  ]);
  // CJK is emitted as bigrams: substring probes of one character match so
  // indiscriminately that they stop representing a real query.
  assert.deepEqual(tokenizeForProfiles("定向凝固"), ["定向", "向凝", "凝固"]);
  assert.deepEqual(tokenizeForProfiles(""), []);

  const documentFrequency = new Map();
  // 200 sampled documents: 3 very common terms, a mid band, and rare tails.
  documentFrequency.set("common-a", 190);
  documentFrequency.set("common-b", 180);
  documentFrequency.set("common-c", 170);
  for (let index = 0; index < 30; index += 1) {
    documentFrequency.set(`mid-${index}`, 4 + (index % 5));
  }
  for (let index = 0; index < 20; index += 1) {
    documentFrequency.set(`rare-${index}`, 1);
  }

  const profiles = buildKeywordProfiles(documentFrequency, 200);
  const byName = Object.fromEntries(
    profiles.map((profile) => [profile.name, profile]),
  );
  assert.deepEqual(Object.keys(byName).sort(), ["broad", "narrow", "typical"]);
  // The broad profile leads with the most-selective-in-reverse terms: the ones
  // that pull in nearly the whole library, which is the expensive case.
  assert.deepEqual(byName.broad.keywords.slice(0, 3), [
    "common-a",
    "common-b",
    "common-c",
  ]);
  assert.ok(byName.broad.keywords.length <= 16);
  // The typical profile must avoid both the whole-library terms and the tail.
  assert.ok(byName.typical.keywords.every((term) => term.startsWith("mid-")));
  assert.equal(byName.typical.keywords.length, 12);
  assert.ok(byName.narrow.keywords.every((term) => term.startsWith("rare-")));
  // Deterministic: the same library must produce the same workload twice.
  assert.deepEqual(buildKeywordProfiles(documentFrequency, 200), profiles);
  assert.deepEqual(buildKeywordProfiles(new Map(), 0), []);
}

// ---- keyword benchmark drives its recommendation from the WORST profile ----

{
  const searched = [];
  const result = await runKeywordSearchBenchmark(
    [
      { name: "broad", keywords: ["a", "b"] },
      { name: "typical", keywords: ["c"] },
      { name: "narrow", keywords: ["d"] },
    ],
    async (keywords) => {
      searched.push(keywords.join(","));
      return { candidateItems: keywords.length * 100 };
    },
    200,
    () => 0,
  );
  assert.equal(result.runsPerProfile, KEYWORD_BENCHMARK_RUNS);
  assert.equal(result.profiles.length, 3);
  assert.equal(
    searched.length,
    3 * KEYWORD_BENCHMARK_RUNS,
    "every profile must be run the configured number of times",
  );
  assert.deepEqual(
    result.profiles.map((profile) => profile.name),
    ["broad", "typical", "narrow"],
  );
  // Candidate counts come back so the result can show WHY a profile was slow.
  assert.equal(result.profiles[0].candidateItems, 200);
  assert.equal(result.profiles[1].candidateItems, 100);
  assert.equal(result.sampledItems, 200);
}

{
  // Explicit slow profile: the worst timing, not an average across profiles,
  // is what the timeout has to cover.
  let clock = 0;
  const cost = { slow: 100, fast: 1 };
  let currentProfile = "";
  const result = await runKeywordSearchBenchmark(
    [
      { name: "typical", keywords: ["fast"] },
      { name: "broad", keywords: ["slow"] },
    ],
    async (keywords) => {
      currentProfile = keywords[0];
      clock += cost[currentProfile];
    },
    50,
    () => clock,
  );
  assert.equal(result.worstProfile, "broad");
  assert.equal(result.worst.maxMs, 100);
  assert.equal(result.worst.minMs, 100);

  await assert.rejects(
    runKeywordSearchBenchmark([], async () => ({ candidateItems: 0 }), 0),
    /No keyword probes/,
  );
}

console.log("search timeout tests passed");
