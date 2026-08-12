/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FALLBACK_NGRAM_WEIGHT,
  FALLBACK_OFFSET_NGRAM_WEIGHT,
  FALLBACK_TOKEN_WEIGHT,
  MAX_HYBRID_KEYWORDS,
  PROVIDED_KEYWORD_WEIGHT,
  buildFallbackKeywordEntries,
  buildFallbackKeywords,
  fuseHybridSearchResults,
  normalizeKeywords,
  rankLexicalCandidates,
  resolveHybridKeywords,
  runHybridSearch,
} from "../src/modules/hybridSearch.ts";
import { groupItemKeysByLibrary } from "../src/modules/libraryScope.ts";
import {
  MCP_PROTOCOL_VERSION,
  getMCPMethodResponse,
} from "../src/modules/mcpTransport.ts";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function keywordItem(key, relevanceScore, libraryID = 1) {
  return { key, libraryID, title: `Keyword ${key}`, relevanceScore };
}

function semanticItem(itemKey, score, libraryID = 1) {
  return {
    itemKey,
    libraryID,
    title: `Semantic ${itemKey}`,
    score,
    matchedChunks: [{ chunkId: 1, text: itemKey, score }],
  };
}

const fused = fuseHybridSearchResults(
  [keywordItem("A", 9), keywordItem("B", 7), keywordItem("C", 5)],
  [semanticItem("B", 0.9), semanticItem("C", 0.8), semanticItem("D", 0.7)],
  { topK: 4, rrfK: 60, keywordWeight: 1, semanticWeight: 1 },
);

assert.deepEqual(
  fused.map((result) => result.itemKey),
  ["B", "C", "A", "D"],
  "items present in both ranked lists should lead the fused results",
);
assert.equal(fused[0].keywordRank, 2);
assert.equal(fused[0].semanticRank, 1);
assert.equal(fused[0].keywordScore, 7);
assert.equal(fused[0].semanticScore, 0.9);
assert.deepEqual(fused[0].matchedChunks, [
  { chunkId: 1, text: "B", score: 0.9 },
]);
assert.equal(fused[2].semanticRank, undefined);
assert.equal(fused[3].keywordRank, undefined);

const sameKeyAcrossLibraries = fuseHybridSearchResults(
  [keywordItem("SAME", 9, 1)],
  [semanticItem("SAME", 0.9, 2)],
  { topK: 2, rrfK: 60, keywordWeight: 1, semanticWeight: 1 },
);
assert.equal(sameKeyAcrossLibraries.length, 2);
assert.deepEqual(
  sameKeyAcrossLibraries.map((result) => result.libraryID).sort(),
  [1, 2],
  "libraryID + itemKey must be the hybrid candidate identity",
);

const semanticWeighted = fuseHybridSearchResults(
  [keywordItem("A", 9), keywordItem("B", 7)],
  [semanticItem("B", 0.9), semanticItem("A", 0.8)],
  { topK: 2, rrfK: 60, keywordWeight: 0, semanticWeight: 1 },
);
assert.deepEqual(
  semanticWeighted.map((result) => result.itemKey),
  ["B", "A"],
  "zero keyword weight should preserve semantic ordering",
);
assert.ok(
  semanticWeighted.every((result) => result.semanticRank !== undefined),
  "zero keyword weight should exclude keyword-only candidates",
);

const semanticOnlyRun = await runHybridSearch(
  {
    query: "semantic only",
    topK: 2,
    candidateK: 4,
    rrfK: 60,
    keywordWeight: 0,
    semanticWeight: 1,
  },
  {
    keywordSearch: async () => {
      throw new Error("disabled keyword branch executed");
    },
    semanticSearch: async () => [semanticItem("A", 0.9)],
  },
);
assert.equal(semanticOnlyRun.degraded, false);
assert.equal(semanticOnlyRun.keywordResultCount, 0);
assert.deepEqual(
  semanticOnlyRun.results.map((result) => result.itemKey),
  ["A"],
);

const degraded = await runHybridSearch(
  {
    query: "columnar grains",
    topK: 2,
    candidateK: 4,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
  },
  {
    keywordSearch: async () => [keywordItem("A", 9), keywordItem("B", 7)],
    semanticSearch: async () => {
      throw new Error("semantic index unavailable");
    },
  },
);

assert.equal(degraded.degraded, true);
assert.equal(degraded.keywordResultCount, 2);
assert.equal(degraded.semanticResultCount, 0);
assert.deepEqual(
  degraded.results.map((result) => result.itemKey),
  ["A", "B"],
);
assert.match(degraded.warnings[0], /semantic/i);

const timeoutStartedAt = Date.now();
const timedOutSemantic = await runHybridSearch(
  {
    query: "bounded semantic search",
    topK: 2,
    candidateK: 4,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
    semanticTimeoutMs: 25,
    totalTimeoutMs: 100,
  },
  {
    keywordSearch: async () => [keywordItem("A", 9)],
    semanticSearch: () => new Promise(() => {}),
  },
);
assert.ok(Date.now() - timeoutStartedAt < 500);
assert.equal(timedOutSemantic.degraded, true);
assert.deepEqual(
  timedOutSemantic.results.map((result) => result.itemKey),
  ["A"],
);
assert.match(timedOutSemantic.warnings.join(" "), /timed out/i);
assert.ok(timedOutSemantic.timings.semanticMs >= 20);
assert.ok(timedOutSemantic.timings.totalMs < 500);

await assert.rejects(
  runHybridSearch(
    {
      query: "   ",
      topK: 2,
      candidateK: 4,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
    },
    {
      keywordSearch: async () => [],
      semanticSearch: async () => [],
    },
  ),
  /query must not be blank/i,
);

// ---- bilingual keyword handling ----

assert.deepEqual(
  normalizeKeywords([
    "  温度梯度 ",
    "temperature gradient",
    "Temperature Gradient",
    "",
    "定向凝固",
  ]),
  ["温度梯度", "temperature gradient", "定向凝固"],
  "keywords should be trimmed, blank-filtered and case-insensitively deduped without dropping either script",
);

// The tool description and JSON schema both advertise a 16-keyword ceiling, so
// an over-long list must be rejected loudly rather than half-searched silently.
assert.equal(
  normalizeKeywords(
    Array.from({ length: MAX_HYBRID_KEYWORDS }, (_, index) => `kw${index}`),
  ).length,
  MAX_HYBRID_KEYWORDS,
  "keyword probes must stay bounded",
);
assert.throws(
  () => normalizeKeywords(Array.from({ length: 30 }, (_, i) => `kw${i}`)),
  /at most 16 entries/i,
  "keywords beyond the advertised cap must be rejected, not silently dropped",
);
assert.deepEqual(normalizeKeywords(undefined), []);
assert.throws(() => normalizeKeywords("温度梯度"), /array of strings/i);
assert.throws(() => normalizeKeywords([1, 2]), /array of strings/i);
assert.throws(
  () => normalizeKeywords(Array.from({ length: 40 }, (_, i) => `k${i}`)),
  /at most 16 entries/i,
);
assert.throws(() => normalizeKeywords(["x".repeat(200)]), /at most 120/i);

const provided = resolveHybridKeywords("温度梯度如何影响定向凝固？", [
  "温度梯度",
  "temperature gradient",
]);
assert.equal(provided.source, "provided");
assert.deepEqual(provided.keywords, ["温度梯度", "temperature gradient"]);

// A Han sentence has no spaces, so plain tokenisation yields one unusable run.
// The fallback must break it into term-sized probes instead.
const chineseFallback = resolveHybridKeywords(
  "温度梯度如何影响定向凝固中的柱状晶转变？",
);
assert.equal(chineseFallback.source, "fallback");
assert.ok(
  chineseFallback.keywords.length > 1,
  "Chinese queries must not collapse into a single unmatchable token",
);
assert.ok(
  chineseFallback.keywords.every((keyword) => keyword.length <= 6),
  "Chinese fallback probes should be term-sized, not whole sentences",
);
for (const expected of ["温度", "梯度", "定向", "凝固", "柱状"]) {
  assert.ok(
    chineseFallback.keywords.includes(expected),
    `Chinese fallback should recover the term ${expected}`,
  );
}
assert.ok(
  chineseFallback.keywords.every((keyword) => !keyword.includes("的")),
  "Han function words should not become probes",
);

const englishFallback = buildFallbackKeywords(
  "How does the temperature gradient affect columnar transition?",
);
assert.ok(englishFallback.includes("temperature"));
assert.ok(englishFallback.includes("gradient"));
assert.ok(
  !englishFallback.includes("how") && !englishFallback.includes("the"),
  "English stopwords should not become probes",
);
assert.ok(englishFallback.length <= MAX_HYBRID_KEYWORDS);

// Mixed-language queries must keep probes from both scripts.
const mixedFallback = buildFallbackKeywords(
  "定向凝固 directional solidification 综述",
);
assert.ok(mixedFallback.some((keyword) => /\p{Script=Han}/u.test(keyword)));
assert.ok(mixedFallback.includes("directional"));
assert.ok(mixedFallback.includes("solidification"));

assert.deepEqual(buildFallbackKeywords("Zn"), ["zn"]);

// Invalid keywords must be rejected by the shared option validation.
await assert.rejects(
  runHybridSearch(
    {
      query: "keyword validation",
      keywords: ["ok", 5],
      topK: 2,
      candidateK: 4,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
    },
    {
      keywordSearch: async () => [],
      semanticSearch: async () => [],
    },
  ),
  /array of strings/i,
);

// Valid keywords must not disturb the existing fusion contract.
const keywordRun = await runHybridSearch(
  {
    query:
      "Effects of temperature gradient on columnar-to-equiaxed transition / 温度梯度的影响",
    keywords: ["温度梯度", "temperature gradient", "CET"],
    topK: 2,
    candidateK: 4,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
  },
  {
    keywordSearch: async () => [
      {
        ...keywordItem("A", 3.4),
        matchedKeywords: ["温度梯度", "temperature gradient"],
        matchedFields: ["title", "abstractNote"],
      },
    ],
    semanticSearch: async () => [semanticItem("A", 0.88)],
  },
);
assert.equal(keywordRun.degraded, false);
assert.deepEqual(keywordRun.results[0].matchedKeywords, [
  "温度梯度",
  "temperature gradient",
]);
assert.deepEqual(keywordRun.results[0].matchedFields, [
  "title",
  "abstractNote",
]);

const getMCPResponse = getMCPMethodResponse("GET", true);
assert.equal(getMCPResponse.status, 405);
assert.equal(getMCPResponse.headers.Allow, "POST");
assert.equal(MCP_PROTOCOL_VERSION, "2025-06-18");

const serverSource = fs.readFileSync(
  path.join(rootDir, "src/modules/streamableMCPServer.ts"),
  "utf8",
);
assert.match(serverSource, /name:\s*['"]hybrid_search['"]/);
assert.match(serverSource, /case\s+['"]hybrid_search['"]/);
assert.match(serverSource, /callHybridSearch\(/);
assert.ok(
  serverSource.indexOf("name: 'hybrid_search'") <
    serverSource.indexOf("name: 'get_libraries'"),
  "hybrid_search should be listed before other tools",
);
assert.match(serverSource, /required:\s*\[['"]q['"],\s*['"]itemKeys['"]\]/);
// hybrid_search must advertise the bilingual keyword contract to calling AIs.
assert.match(serverSource, /keywords:\s*\{\s*\n\s*type:\s*'array'/);
assert.match(serverSource, /resolveHybridKeywords\(args\.query,\s*args\.keywords\)/);
assert.match(serverSource, /Chinese AND English/);
assert.match(serverSource, /columnar-to-equiaxed transition/);
assert.match(serverSource, /HYBRID_KEYWORD_COVERAGE_BONUS/);
// language must stay unfiltered by default so retrieval remains cross-lingual.
assert.match(serverSource, /const language = args\.language \?\? 'all';/);
assert.match(serverSource, /whole-library full-text scanning is disabled/);
assert.doesNotMatch(serverSource, /protocolVersion:\s*['"]2024-11-05['"]/);

// ---- MCP protocol version negotiation ----

const transportSource = fs.readFileSync(
  path.join(rootDir, "src/modules/mcpTransport.ts"),
  "utf8",
);
// 2024-11-05 defines the HTTP+SSE two-endpoint transport, which this plugin
// never implemented (single POST /mcp; GET /mcp answers 405). Advertising it
// would promise a transport that does not exist.
const supportedBlock = transportSource.slice(
  transportSource.indexOf("SUPPORTED_MCP_PROTOCOL_VERSIONS = ["),
  transportSource.indexOf("] as const;"),
);
assert.doesNotMatch(
  supportedBlock,
  /2024-11-05/,
  "2024-11-05 must not be advertised as a supported Streamable HTTP version",
);
assert.match(supportedBlock, /MCP_PROTOCOL_VERSION/);
assert.match(supportedBlock, /2025-03-26/);
// The header fallback version must itself be a supported version.
assert.match(
  transportSource,
  /MCP_DEFAULT_NEGOTIATED_VERSION = "2025-03-26"/,
);
assert.match(transportSource, /export function negotiateProtocolVersion/);
// The HTTP header check stays strict (400) even though initialize negotiates.
assert.match(transportSource, /status: 400/);

// initialize must negotiate, not reject: an unsupported version has to come
// back as a server-supported version so the client can decide what to do.
const initBlock = serverSource.slice(
  serverSource.indexOf("private handleInitialize"),
  serverSource.indexOf("private generateSessionId"),
);
assert.match(initBlock, /negotiateProtocolVersion\(requestedVersion\)/);
assert.match(initBlock, /protocolVersion: negotiatedVersion/);
assert.doesNotMatch(
  initBlock,
  /Unsupported protocol version/,
  "initialize must not fail the request on an unsupported protocol version",
);
// Only a malformed (non-string) protocolVersion is an invalid-params error.
assert.match(initBlock, /protocolVersion must be a string/);
// tools.listChanged must stay false while no list_changed notification is sent.
assert.match(initBlock, /listChanged: false/);

// ---- privacy sanitizer closes every MCP response exit ----

const handleBlock = serverSource.slice(
  serverSource.indexOf("async handleMCPRequest"),
  serverSource.indexOf("private async processRequest"),
);
assert.doesNotMatch(
  handleBlock,
  /body: JSON\.stringify\(/,
  "every MCP response body must go through serializeResponse, not raw JSON.stringify",
);
assert.match(serverSource, /private serializeResponse\(/);
assert.match(serverSource, /return JSON\.stringify\(sanitizeForPrivacy\(response\)\)/);
// tools/call still needs the structural pass before the result is stringified.
assert.match(serverSource, /result = scrubPathFields\(result\)/);

const httpServerSource = fs.readFileSync(
  path.join(rootDir, "src/modules/httpServer.ts"),
  "utf8",
);
// Error bodies and status/test endpoints are separate exits from the MCP layer.
assert.match(
  httpServerSource,
  /const errorBody = JSON\.stringify\(sanitizeForPrivacy\(/,
);
assert.match(
  httpServerSource,
  /JSON\.stringify\(sanitizeForPrivacy\(this\.mcpServer\.getStatus\(\)\)\)/,
);

const searchEngineSource = fs.readFileSync(
  path.join(rootDir, "src/modules/searchEngine.ts"),
  "utf8",
);
assert.match(searchEngineSource, /quicksearch-fields/);
assert.doesNotMatch(searchEngineSource, /quicksearch-everything/);
assert.match(searchEngineSource, /search_library\.fulltext is disabled/);

const vectorStoreSource = fs.readFileSync(
  path.join(rootDir, "src/modules/semantic/vectorStore.ts"),
  "utf8",
);
assert.match(vectorStoreSource, /item_key IN \(\$\{placeholders\}\)/);

const fulltextServiceSource = fs.readFileSync(
  path.join(rootDir, "src/modules/fulltextService.ts"),
  "utf8",
);
assert.doesNotMatch(
  fulltextServiceSource,
  /Zotero\.Items\.getAll\(libraryID\)/,
);

await assert.rejects(
  runHybridSearch(
    {
      query: "unavailable",
      topK: 2,
      candidateK: 4,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
    },
    {
      keywordSearch: async () => {
        throw new Error("keyword unavailable");
      },
      semanticSearch: async () => {
        throw new Error("semantic unavailable");
      },
    },
  ),
  /Hybrid search failed/,
);

// ---- single-pass lexical ranking ----

function lexicalDoc(key, fields) {
  return { key, libraryID: 1, title: fields.title || "", fields };
}

const providedKeyword = (text) => ({
  text,
  weight: PROVIDED_KEYWORD_WEIGHT,
  origin: "provided",
});

// A broad word that matches almost the whole library must not be able to
// outrank a discriminative phrase just because it hit a title.
const broadPool = Array.from({ length: 40 }, (_, index) =>
  lexicalDoc(`BROAD${String(index).padStart(2, "0")}`, {
    title: `Grain growth study ${index}`,
    abstractNote: "Grain growth kinetics during casting.",
  }),
);
const specificDoc = lexicalDoc("RARE", {
  title: "Columnar-to-equiaxed transition analysis",
  abstractNote: "Transition mechanisms in directional castings.",
});
const specificityRanking = rankLexicalCandidates(
  [...broadPool, specificDoc],
  [providedKeyword("growth"), providedKeyword("columnar-to-equiaxed transition")],
  { candidateK: 10 },
);
assert.equal(
  specificityRanking[0].key,
  "RARE",
  "a discriminative phrase must outrank a term matching most of the pool",
);

// Coverage: matching several distinct keywords beats one strong single hit.
const coverageRanking = rankLexicalCandidates(
  [
    lexicalDoc("MANY", {
      title: "Temperature gradient in directional solidification",
      abstractNote: "Columnar-to-equiaxed transition of the alloy.",
    }),
    lexicalDoc("ONE", {
      title:
        "Temperature gradient, temperature gradient and more temperature gradient",
      abstractNote: "Temperature gradient everywhere.",
    }),
  ],
  [
    providedKeyword("temperature gradient"),
    providedKeyword("directional solidification"),
    providedKeyword("columnar-to-equiaxed transition"),
  ],
  { candidateK: 5 },
);
assert.equal(coverageRanking[0].key, "MANY");
assert.deepEqual(coverageRanking[0].matchedKeywords, [
  "temperature gradient",
  "directional solidification",
  "columnar-to-equiaxed transition",
]);
assert.deepEqual(coverageRanking[0].matchedFields.sort(), [
  "abstractNote",
  "title",
]);
assert.equal(coverageRanking[0].keywordCoverage, 1);

// Field weighting: the same term is worth more in a title than in `extra`.
const fieldRanking = rankLexicalCandidates(
  [
    lexicalDoc("EXTRA", { extra: "cellular automaton", title: "Unrelated" }),
    lexicalDoc("TITLE", { title: "Cellular automaton model of solidification" }),
  ],
  [providedKeyword("cellular automaton")],
  { candidateK: 5 },
);
assert.equal(fieldRanking[0].key, "TITLE");

// Latin keywords need a word boundary: "CET" inside "faucet" is noise.
const boundaryRanking = rankLexicalCandidates(
  [
    lexicalDoc("WORD", { title: "CET during rapid solidification" }),
    lexicalDoc("INSIDE", { title: "Faucet corrosion in cast alloys" }),
  ],
  [providedKeyword("cet")],
  { candidateK: 5 },
);
assert.equal(boundaryRanking[0].key, "WORD");
assert.ok(
  boundaryRanking[0].relevanceScore > boundaryRanking[1].relevanceScore,
  "a whole-word hit must score above a substring hit",
);

// Fallback n-grams may keep recall but must never outweigh a real keyword.
const weightRanking = rankLexicalCandidates(
  [
    lexicalDoc("NGRAM", { title: "凝固过程研究" }),
    lexicalDoc("TOKEN", { title: "温度梯度研究" }),
  ],
  [
    { text: "凝固", weight: FALLBACK_NGRAM_WEIGHT, origin: "ngram" },
    { text: "温度梯度", weight: FALLBACK_TOKEN_WEIGHT, origin: "token" },
  ],
  { candidateK: 5 },
);
assert.equal(
  weightRanking[0].key,
  "TOKEN",
  "a low-weight fallback n-gram must not outrank a full-weight probe",
);

// Non-matching candidates are dropped and candidateK is honoured.
assert.equal(
  rankLexicalCandidates(
    [lexicalDoc("A", { title: "irrelevant" })],
    [providedKeyword("solidification")],
    { candidateK: 5 },
  ).length,
  0,
);
assert.equal(
  rankLexicalCandidates(broadPool, [providedKeyword("growth")], {
    candidateK: 3,
  }).length,
  3,
);
assert.deepEqual(rankLexicalCandidates([], [providedKeyword("x")], {
  candidateK: 3,
}), []);

// Ranking must be deterministic for identical candidates.
const tied = rankLexicalCandidates(
  [
    lexicalDoc("ZZZ", { title: "growth" }),
    lexicalDoc("AAA", { title: "growth" }),
  ],
  [providedKeyword("growth")],
  { candidateK: 5 },
);
assert.deepEqual(
  tied.map((entry) => entry.key),
  ["AAA", "ZZZ"],
);

// ---- weighted keyword entries ----

const providedEntries = resolveHybridKeywords("查询", ["温度梯度", "CET"]);
assert.deepEqual(
  providedEntries.entries.map((entry) => entry.weight),
  [PROVIDED_KEYWORD_WEIGHT, PROVIDED_KEYWORD_WEIGHT],
);
assert.ok(
  providedEntries.entries.every((entry) => entry.origin === "provided"),
);

const fallbackEntries = buildFallbackKeywordEntries(
  "温度梯度如何影响定向凝固中的柱状晶转变？",
);
assert.ok(
  fallbackEntries.some(
    (entry) => entry.origin === "token" && entry.text === "温度梯度",
  ),
  "splitting on Han function words must keep whole terms intact",
);
assert.ok(
  fallbackEntries
    .filter((entry) => entry.origin === "ngram")
    .every((entry) => entry.weight <= FALLBACK_NGRAM_WEIGHT),
  "n-gram probes must stay below full keyword weight",
);
assert.ok(
  fallbackEntries.every((entry) => entry.weight <= FALLBACK_TOKEN_WEIGHT),
  "no fallback probe may reach the trust level of a supplied keyword",
);
// 度梯 / 响定 / 向凝 are boundary-straddling noise: allowed, but demoted below
// the aligned bigrams that reconstruct real terms.
for (const noise of ["度梯", "响定", "向凝"]) {
  const entry = fallbackEntries.find((item) => item.text === noise);
  if (entry) {
    assert.ok(
      entry.weight <= FALLBACK_OFFSET_NGRAM_WEIGHT,
      `${noise} straddles a term boundary and must carry the lowest weight`,
    );
  }
}
const englishEntries = buildFallbackKeywordEntries(
  "How does the temperature gradient affect columnar transition?",
);
assert.ok(englishEntries.every((entry) => entry.origin === "token"));

// ---- timeout cancellation ----

let semanticCancelled = false;
let keywordCancelled = false;
const cancelledRun = await runHybridSearch(
  {
    query: "cancellation",
    topK: 2,
    candidateK: 4,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
    semanticTimeoutMs: 25,
    totalTimeoutMs: 80,
  },
  {
    keywordSearch: async () => [keywordItem("A", 9)],
    semanticSearch: () => new Promise(() => {}),
    cancelKeywordSearch: () => {
      keywordCancelled = true;
    },
    cancelSemanticSearch: () => {
      semanticCancelled = true;
    },
  },
);
assert.equal(
  semanticCancelled,
  true,
  "a timed-out semantic branch must be cancelled, not just abandoned",
);
assert.equal(keywordCancelled, false);
assert.equal(cancelledRun.degraded, true);

// A throwing canceller must not swallow the timeout error.
const throwingCancel = await runHybridSearch(
  {
    query: "canceller failure",
    topK: 1,
    candidateK: 2,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
    semanticTimeoutMs: 20,
    totalTimeoutMs: 80,
  },
  {
    keywordSearch: async () => [keywordItem("A", 9)],
    semanticSearch: () => new Promise(() => {}),
    cancelSemanticSearch: () => {
      throw new Error("canceller exploded");
    },
  },
);
assert.match(throwingCancel.warnings.join(" "), /timed out/i);

// ---- single-pass lexical wiring ----

const lexicalSource = fs.readFileSync(
  path.join(rootDir, "src/modules/lexicalSearch.ts"),
  "utf8",
);
// One OR-ed Zotero search for all keywords, not one search per keyword.
assert.match(lexicalSource, /addCondition\("joinMode", "any"\)/);
assert.match(lexicalSource, /rankLexicalCandidates\(/);
assert.match(lexicalSource, /deadlineAt/);
assert.match(lexicalSource, /isCancelled\?\.\(\)/);

const hybridBranch = serverSource.slice(
  serverSource.indexOf("private async callHybridSearch"),
  serverSource.indexOf("private validateSearchParameters"),
);
assert.match(hybridBranch, /runLexicalSearch\(/);
assert.doesNotMatch(
  hybridBranch,
  /callSearchLibrary\(/,
  "the lexical branch must no longer issue one search_library call per keyword",
);
assert.doesNotMatch(
  hybridBranch,
  /lexicalKeywords\.map\(/,
  "keywords must be matched in a single pass, not mapped to K probes",
);
assert.match(hybridBranch, /cancelKeywordSearch:/);
assert.match(hybridBranch, /cancelSemanticSearch:/);
assert.match(hybridBranch, /signal: semanticAbort\?\.signal/);
// Timing log must report every stage of the fusion.
assert.match(
  hybridBranch,
  /HybridTiming\] lexical=\$\{searchResult\.timings\.keywordMs\}ms semantic=\$\{searchResult\.timings\.semanticMs\}ms rrf=\$\{searchResult\.timings\.rrfMs\}ms total=\$\{searchResult\.timings\.totalMs\}ms/,
);
assert.match(hybridBranch, /Lexical\] strategy=/);
assert.match(hybridBranch, /language,\n\s+libraryID,/);

// ---- embedding cancellation reaches the HTTP layer ----

const embeddingSource = fs.readFileSync(
  path.join(rootDir, "src/modules/semantic/embeddingService.ts"),
  "utf8",
);
assert.match(embeddingSource, /cancellerReceiver:/);
assert.match(embeddingSource, /signal\?\.aborted/);
assert.match(embeddingSource, /options\?\.signal/);

const semanticServiceSource = fs.readFileSync(
  path.join(rootDir, "src/modules/semantic/semanticSearchService.ts"),
  "utf8",
);
assert.match(semanticServiceSource, /signal\?: AbortSignal/);
assert.match(semanticServiceSource, /signal: abortController\?\.signal/);
assert.match(semanticServiceSource, /deadlineTimer = setTimeout\(abortSearch/);

// ---- group library index lifecycle ----

assert.match(
  vectorStoreSource,
  /async clear\(libraryID\?: number\): Promise<void>/,
  "clear() must be able to scope to one library so a rebuild cannot wipe others",
);
assert.match(vectorStoreSource, /libraryScopeClause\(libraryID: number\)/);
assert.match(vectorStoreSource, /DELETE FROM embeddings\$\{where\}/);
assert.match(semanticServiceSource, /this\.vectorStore\.clear\(libraryID\)/);

const hooksSource = fs.readFileSync(
  path.join(rootDir, "src/hooks.ts"),
  "utf8",
);
// scheduleAutoUpdate gained a `force` flag (adds force a re-extraction, plain
// modifications do not); the library-scoping contract these guard is unchanged:
// every call must still pass the item's own libraryID, never an implied one.
assert.match(
  hooksSource,
  /scheduleAutoUpdate\(itemKey: string, libraryID: number, force: boolean\)/,
);
assert.match(hooksSource, /scheduleAutoUpdate\(item\.key, item\.libraryID, (?:true|false)\)/);
assert.match(hooksSource, /scheduleAutoUpdate\(parentKey, item\.libraryID, (?:true|false)\)/);
assert.doesNotMatch(
  hooksSource,
  /scheduleAutoUpdate\([^)]*\bZotero\.Libraries\.userLibraryID\)/,
  "auto-update must never fall back to My Library for an item of unknown library",
);
assert.match(hooksSource, /groupQueueKeysByLibrary\(/);
assert.match(hooksSource, /runBuildsPerLibrary\(/);
assert.match(hooksSource, /deleteItemVectors\(itemKey, false, libraryID\)/);
assert.match(hooksSource, /libraryID: selectedLibraryID/);
assert.match(hooksSource, /libraryID: Zotero\.Libraries\.userLibraryID,\n\s+rebuild: false/);
assert.doesNotMatch(
  hooksSource,
  /semanticService\.buildIndex\(\{\n\s+itemKeys,\n\s+rebuild:/,
  "item builds must always carry the library the keys belong to",
);

const columnSource = fs.readFileSync(
  path.join(rootDir, "src/modules/semanticIndexColumn.ts"),
  "utf8",
);
assert.match(columnSource, /getItemIndexStatus\(item\.key, item\.libraryID\)/);
assert.match(columnSource, /indexedItemsCache\.has\(storageKey\)/);

// groupItemKeysByLibrary must split a mixed selection and dedupe within it.
const groupedSelection = groupItemKeysByLibrary([
  { key: "AAA", libraryID: 1 },
  { key: "BBB", libraryID: 1 },
  { key: "AAA", libraryID: 1 },
  { key: "CCC", libraryID: 7 },
]);
assert.deepEqual(Array.from(groupedSelection.keys()), [1, 7]);
assert.deepEqual(groupedSelection.get(1), ["AAA", "BBB"]);
assert.deepEqual(groupedSelection.get(7), ["CCC"]);


console.log("Hybrid search regression tests passed");
