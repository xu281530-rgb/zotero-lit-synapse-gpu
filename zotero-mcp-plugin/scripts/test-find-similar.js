/* eslint-env node */

/**
 * Regression tests for find_similar — multi-chunk, document-level similarity.
 *
 * The invariant under test is the order of operations:
 *
 *   scan the whole index with EVERY query chunk
 *     -> aggregate chunk scores into ONE score per document
 *     -> apply the user's threshold
 *     -> rank
 *     -> page
 *
 * Everything the old implementation got wrong follows from doing this in the
 * wrong order. It scored ONE chunk of the source paper, kept the top-K CHUNKS,
 * and de-duplicated them into documents afterwards — so a single paper owning
 * several strong passages could take the whole result set, and "find 20 similar
 * papers" could return two.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("./find-similar-hooks.mjs", import.meta.url);

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const {
  aggregateSimilarDocument,
  rankSimilarDocuments,
  MAX_SIMILAR_QUERY_CHUNKS,
  SIMILAR_CHUNKS_PER_QUERY,
  SIMILAR_MAX_WEIGHT,
  SIMILAR_MEAN_WEIGHT,
} = await import("../src/modules/semantic/similarDocumentAggregation.ts");
const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");
const { SemanticSearchService } = await import(
  "../src/modules/semantic/semanticSearchService.ts"
);
const {
  HybridSearchPageStore,
  CursorError,
  windowOf,
  HYBRID_PAGE_IDENTITY,
  SIMILAR_PAGE_IDENTITY,
} = await import("../src/modules/hybridSearchPages.ts");
const {
  resolveSimilarScanBudget,
  SIMILAR_SCAN_BUDGET_CEILING_MS,
  SIMILAR_SCAN_BUDGET_MODEL,
} = await import("../src/modules/semantic/similarScanBudget.ts");

// ============ 1. Document-level aggregation ============

const doc = (itemKey, perQuery) => ({ itemKey, libraryID: 1, perQuery });
const hits = (...scores) =>
  scores.map((score, index) => ({ chunkId: index, score }));

// The published formula is what the tool documents to the AI, so it is checked
// literally rather than by property.
{
  const aggregated = aggregateSimilarDocument(
    doc("D", [hits(0.8, 0.6), hits(0.7, 0.5)]),
  );
  const s = [0.7, 0.6];
  const expected =
    (SIMILAR_MEAN_WEIGHT * ((s[0] + s[1]) / 2) +
      SIMILAR_MAX_WEIGHT * Math.max(...s)) /
    (SIMILAR_MEAN_WEIGHT + SIMILAR_MAX_WEIGHT);
  assert.ok(Math.abs(aggregated.score - expected) < 1e-12);
  assert.deepEqual(aggregated.perQueryScores, s);
  assert.equal(aggregated.matchedQueryChunks, 2);
  assert.equal(aggregated.bestChunkScore, 0.8);
  assert.equal(SIMILAR_CHUNKS_PER_QUERY, 2);
}

// One accidentally-brilliant passage must not carry a whole paper. SPIKE owns
// the single highest chunk in the comparison (0.95) and still loses to BROAD,
// which is consistently relevant across its passages.
{
  const spike = aggregateSimilarDocument(
    doc("SPIKE", [hits(0.95, 0.4), hits(0.95, 0.4), hits(0.95, 0.4)]),
  );
  const broad = aggregateSimilarDocument(
    doc("BROAD", [hits(0.72, 0.68), hits(0.72, 0.68), hits(0.72, 0.68)]),
  );
  assert.ok(spike.bestChunkScore > broad.bestChunkScore);
  assert.ok(broad.score > spike.score);
  // ...and taking only the best chunk per query would have inverted it, which
  // is what makes the top-2 average load-bearing rather than decoration.
  const bestOnly = (document) =>
    Math.max(...document.perQuery.map((query) => query[0].score));
  assert.ok(
    bestOnly(doc("SPIKE", [hits(0.95, 0.4)])) >
      bestOnly(doc("BROAD", [hits(0.72, 0.68)])),
  );
}

// A document that answers only one of the facets the caller supplied scores as
// a partial match, not as a match. Unmatched query chunks count as 0.
{
  const narrow = aggregateSimilarDocument(
    doc("NARROW", [hits(0.9, 0.9), [], []]),
  );
  assert.deepEqual(narrow.perQueryScores, [0.9, 0, 0]);
  assert.equal(narrow.matchedQueryChunks, 1);
  assert.ok(Math.abs(narrow.score - 0.45) < 1e-12);
  // Below the default 0.6 threshold: it is reported as a candidate, not a hit.
  assert.ok(narrow.score < 0.6);
}

// The aggregate lives on the same 0..1 scale as a raw cosine, which is what
// lets the user's relevance threshold be applied to it unchanged. Means and
// maxima of values in [0,1] cannot leave [0,1], and the extremes are exact.
{
  const perfect = aggregateSimilarDocument(
    doc("PERFECT", [hits(1, 1), hits(1, 1)]),
  );
  assert.equal(perfect.score, 1);
  const negative = aggregateSimilarDocument(
    doc("NEG", [hits(-0.4, -0.9), hits(-0.2)]),
  );
  assert.equal(negative.score, 0);
  for (let trial = 0; trial < 200; trial += 1) {
    const random = () =>
      Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () =>
        Math.random(),
      );
    const sample = aggregateSimilarDocument(
      doc("R", [hits(...random()), hits(...random()), hits(...random())]),
    );
    assert.ok(sample.score >= 0 && sample.score <= 1);
    assert.ok(sample.score <= sample.bestChunkScore + 1e-12);
  }
}

// Ranking: threshold filtering, source exclusion, and an order that does not
// drift between calls (pagination reads the same list twice).
{
  const { ranked, discardedBelowThreshold } = rankSimilarDocuments(
    [
      doc("SELF", [hits(1, 1), hits(1, 1)]),
      doc("HIGH", [hits(0.9, 0.85), hits(0.88, 0.8)]),
      doc("MID", [hits(0.7, 0.7), hits(0.7, 0.7)]),
      doc("LOW", [hits(0.3, 0.2), hits(0.25)]),
      doc("TIE", [hits(0.7, 0.7), hits(0.7, 0.7)]),
    ],
    { minScore: 0.6, excludeItemKeys: [{ libraryID: 1, itemKey: "SELF" }] },
  );
  assert.deepEqual(
    ranked.map((row) => row.itemKey),
    ["HIGH", "MID", "TIE"],
  );
  assert.equal(discardedBelowThreshold, 1);
  assert.ok(ranked.every((row) => row.score >= 0.6));
  const again = rankSimilarDocuments(
    [
      doc("TIE", [hits(0.7, 0.7), hits(0.7, 0.7)]),
      doc("MID", [hits(0.7, 0.7), hits(0.7, 0.7)]),
      doc("HIGH", [hits(0.9, 0.85), hits(0.88, 0.8)]),
    ],
    { minScore: 0.6 },
  );
  assert.deepEqual(
    again.ranked.map((row) => row.itemKey),
    ranked.map((row) => row.itemKey),
  );
}

// ============ 2. Multi-query vector scan (CPU path) ============

const bytes = (vector) =>
  new Uint8Array(
    vector.buffer.slice(
      vector.byteOffset,
      vector.byteOffset + vector.byteLength,
    ),
  );

/** A 2-D unit vector at `angle`; cosine against [1,0] is cos(angle). */
const vectorAt = (angle) =>
  bytes(new Float32Array([Math.cos(angle), Math.sin(angle)]));

const storageRow = (columns) => ({
  getResultByName(name) {
    if (!Object.prototype.hasOwnProperty.call(columns, name)) {
      throw new Error(`DB column '${name}' not found`);
    }
    return columns[name];
  },
});

function createStore(rows, { int8Count = 0, itemVectors = new Map() } = {}) {
  const calls = [];
  const db = {
    valueQueryAsync: async (sql, params = []) => {
      calls.push({ kind: "value", sql, params });
      if (sql.includes("vector_int8 IS NOT NULL")) return int8Count;
      if (sql.includes("COUNT(*) FROM embeddings")) return rows.length;
      throw new Error(`Unexpected value query: ${sql}`);
    },
    queryAsync: async (sql, params = [], options = {}) => {
      calls.push({ kind: "query", sql, params });
      const resultRows = (() => {
        if (sql.includes("SELECT dimensions, vector_int8 IS NOT NULL")) {
          return rows.length
            ? [
                {
                  dimensions: rows[0].dimensions,
                  has_int8: rows[0].vector_int8 ? 1 : 0,
                },
              ]
            : [];
        }
        if (sql.includes("SELECT e.id AS embedding_id")) {
          const ids = new Set(params);
          return rows
            .filter((row) => ids.has(row.id) && row.float32)
            .map((row) => ({ embedding_id: row.id, vector: row.float32 }));
        }
        if (sql.startsWith("SELECT chunk_id, language, dimensions")) {
          return (itemVectors.get(params[0]) ?? []).map((row) => ({
            chunk_id: row.chunk_id,
            language: "en",
            dimensions: 2,
            vector_int8: row.vector_int8 ?? null,
            vector_scale: row.vector_scale ?? null,
          }));
        }
        if (sql.startsWith("SELECT chunk_id, vector FROM vectors_f32")) {
          return (itemVectors.get(params[0]) ?? [])
            .filter((row) => row.float32)
            .map((row) => ({ chunk_id: row.chunk_id, vector: row.float32 }));
        }
        if (sql.includes("ORDER BY id LIMIT ? OFFSET ?")) {
          const limit = params.at(-2);
          const offset = params.at(-1);
          return rows
            .slice(offset, offset + limit)
            .map((row) =>
              sql.includes("LEFT JOIN vectors_f32")
                ? { ...row, vector_f32: row.float32 }
                : row,
            );
        }
        throw new Error(`Unexpected query: ${sql}`);
      })();

      if (options && options.onRow) {
        for (const row of resultRows) options.onRow(storageRow(row), () => {});
        return undefined;
      }
      return resultRows;
    },
  };
  const store = new VectorStore();
  store.initialized = true;
  store.db = db;
  return { store, calls };
}

const QUERY_A = new Float32Array([1, 0]);
const QUERY_B = new Float32Array([0, 1]);

// The regression that started all this: one paper holding thousands of the
// best chunks must not be able to crowd every other document out. Aggregation
// happens per document, so all 300 other papers survive the scan.
{
  const rows = [];
  let id = 1;
  for (let chunkId = 0; chunkId < 2000; chunkId += 1) {
    rows.push({
      id: id++,
      item_key: "HOT",
      chunk_id: chunkId,
      language: "en",
      dimensions: 2,
      float32: vectorAt(0.001),
    });
  }
  for (let document = 0; document < 300; document += 1) {
    for (let chunkId = 0; chunkId < 2; chunkId += 1) {
      rows.push({
        id: id++,
        item_key: `DOC${String(document).padStart(3, "0")}`,
        chunk_id: chunkId,
        language: "en",
        dimensions: 2,
        float32: vectorAt(0.3 + document * 0.001 + chunkId * 0.01),
      });
    }
  }

  const { store, calls } = createStore(rows);
  const stats = {};
  const matches = await store.searchMultiQuery([QUERY_A, QUERY_B], {
    chunksPerQuery: 2,
    stats,
  });

  assert.equal(matches.length, 301);
  assert.equal(stats.documents, 301);
  assert.equal(stats.scanned, rows.length);
  // Two query vectors, ONE pass over the index: the SQL read and the per-row
  // decode are shared, which is the whole reason this is not two search()
  // calls.
  const scans = calls.filter((call) =>
    call.sql.includes("ORDER BY id LIMIT ? OFFSET ?"),
  );
  assert.equal(scans.length, 1);

  for (const match of matches) {
    assert.equal(match.perQuery.length, 2);
    for (const perQuery of match.perQuery) {
      assert.ok(perQuery.length <= 2);
      for (let index = 1; index < perQuery.length; index += 1) {
        assert.ok(perQuery[index - 1].score >= perQuery[index].score);
      }
    }
  }
  const hot = matches.find((match) => match.itemKey === "HOT");
  assert.equal(hot.perQuery[0].length, 2);
  assert.ok(Math.abs(hot.perQuery[0][0].score - Math.cos(0.001)) < 1e-6);
  // Query B is the orthogonal axis, so the same chunks score sin(angle).
  assert.ok(Math.abs(hot.perQuery[1][0].score - Math.sin(0.001)) < 1e-6);
}

// A document whose OTHER passages are unrelated must still contribute those
// passages, so the top-2 average has something to average against. With a floor
// of 0 the negative ones were dropped and a single spike stood alone — the
// exact case the average exists to damp.
{
  const rows = [
    // One strongly matching passage, one pointing the other way.
    { itemKey: "SPIKE", angles: [0.05, Math.PI * 0.8] },
    // A genuinely short document: one passage is all it has.
    { itemKey: "SHORT", angles: [0.05] },
    // Consistently related throughout.
    { itemKey: "BROAD", angles: [0.6, 0.65] },
  ].flatMap((document, documentIndex) =>
    document.angles.map((angle, chunkId) => ({
      id: documentIndex * 10 + chunkId + 1,
      item_key: document.itemKey,
      chunk_id: chunkId,
      language: "en",
      dimensions: 2,
      float32: vectorAt(angle),
    })),
  );
  const { store } = createStore(rows);
  const matches = await store.searchMultiQuery([QUERY_A], {
    chunksPerQuery: 2,
    minChunkScore: -1,
  });
  const byKey = new Map(matches.map((match) => [match.itemKey, match]));

  // The unrelated passage is present, with its real (negative) score.
  assert.equal(byKey.get("SPIKE").perQuery[0].length, 2);
  assert.ok(byKey.get("SPIKE").perQuery[0][1].score < 0);
  // A one-passage document is not padded with a phantom second passage.
  assert.equal(byKey.get("SHORT").perQuery[0].length, 1);

  const spike = aggregateSimilarDocument(byKey.get("SPIKE"));
  const short = aggregateSimilarDocument(byKey.get("SHORT"));
  const broad = aggregateSimilarDocument(byKey.get("BROAD"));

  // Same best passage, opposite verdicts: the long document is judged on two
  // passages, the short one on everything it has.
  assert.ok(Math.abs(spike.bestChunkScore - short.bestChunkScore) < 1e-6);
  assert.ok(short.score > spike.score * 1.9);
  assert.ok(broad.score > spike.score);
  // The negative passage is floored at 0 rather than subtracting from the doc.
  assert.ok(spike.score >= spike.bestChunkScore / 2 - 1e-9);
  assert.ok(spike.evidence.every((hit) => hit.score >= 0));
}

// The query document is dropped during the scan, so it can never occupy a slot
// in its own result set.
{
  const rows = ["SRC", "OTHER"].flatMap((itemKey, itemIndex) =>
    Array.from({ length: 3 }, (_, chunkId) => ({
      id: itemIndex * 3 + chunkId + 1,
      item_key: itemKey,
      chunk_id: chunkId,
      language: "en",
      dimensions: 2,
      float32: vectorAt(0.01 * chunkId),
    })),
  );
  const { store } = createStore(rows);
  const matches = await store.searchMultiQuery([QUERY_A], {
    excludeItemKeys: ["SRC"],
  });
  assert.deepEqual(
    matches.map((match) => match.itemKey),
    ["OTHER"],
  );
}

// Int8 storage is decoded once per row and reused by every query vector.
{
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    item_key: `INT8${index % 8}`,
    chunk_id: Math.floor(index / 8),
    language: "en",
    dimensions: 2,
    vector_int8: new Uint8Array([127, 0]),
    vector_norm: 127,
    float32: bytes(new Float32Array([1, 0])),
  }));
  const { store, calls } = createStore(rows, { int8Count: rows.length });
  const matches = await store.searchMultiQuery([QUERY_A, QUERY_A], {
    chunksPerQuery: 2,
  });
  assert.equal(matches.length, 8);
  assert.ok(
    matches.every((match) =>
      match.perQuery.every((perQuery) =>
        perQuery.every((hit) => Math.abs(hit.score - 1) < 1e-6),
      ),
    ),
  );
  assert.equal(
    calls.some((call) => call.sql.includes("embedding_id")),
    false,
  );
}

// An explicitly empty scope means "search nothing" and must not widen into a
// full-library scan.
{
  const { store, calls } = createStore([]);
  assert.deepEqual(
    await store.searchMultiQuery([QUERY_A], { itemKeys: [] }),
    [],
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await store.searchMultiQuery([], {}), []);
}

// An Int8-only index has no vectors_f32 rows at all. Reading the query
// document's vectors must still work: every other search on such an index does.
{
  const int8 = new Int8Array([127, 0]);
  const itemVectors = new Map([
    [
      "SRC",
      [
        {
          chunk_id: 0,
          vector_int8: new Uint8Array(int8.buffer.slice(0)),
          vector_scale: 127,
          float32: null,
        },
        {
          chunk_id: 1,
          vector_int8: new Uint8Array(int8.buffer.slice(0)),
          vector_scale: 127,
          float32: null,
        },
      ],
    ],
  ]);
  const { store } = createStore([], { itemVectors });
  const vectors = await store.getItemVectors("SRC", 1);
  assert.equal(vectors.length, 2);
  assert.ok(Math.abs(vectors[0].vector[0] - 1) < 1e-6);
  assert.equal(vectors[0].vector[1], 0);
}

// ============ 2b. Multi-query scan (GPU path) ============

/**
 * The GPU worker keeps the vectors resident and already returns per-document
 * top chunks, so the GPU path issues one scan per query vector and merges them.
 * What must hold is the request shape (no document cap, grouped by item) and
 * that a worker failure degrades to the CPU scan rather than to no results.
 */
function fakeGpuBackend({ results, failOn = -1 }) {
  const requests = [];
  return {
    requests,
    isEnabled: () => true,
    getEffectivePrecision: () => "int8",
    getCpuFallbackPrecision: () => undefined,
    reportCpuPrecision: () => {},
    registerProvider: () => {},
    startIfEnabled: async () => {},
    search: async (request) => {
      requests.push(request);
      if (requests.length - 1 === failOn) throw new Error("gpu worker died");
      if (request.stats) request.stats.scanned = 100;
      return results[requests.length - 1] ?? [];
    },
    publishMutation: async () => {},
    fallback: () => {},
    setEnabled: async () => {},
    setPrecision: async () => {},
    shutdown: async () => {},
  };
}

const gpuHit = (itemKey, chunkId, score) => ({
  libraryID: 1,
  itemKey,
  chunkId,
  score,
  chunkText: "",
  language: "en",
  rowId: chunkId,
});

{
  const backend = fakeGpuBackend({
    results: [
      [gpuHit("A", 0, 0.9), gpuHit("A", 1, 0.8), gpuHit("SRC", 0, 1)],
      [gpuHit("A", 2, 0.7), gpuHit("B", 0, 0.75)],
    ],
  });
  const store = new VectorStore(backend);
  store.initialized = true;
  const stats = {};
  const matches = await store.searchMultiQuery([QUERY_A, QUERY_B], {
    chunksPerQuery: 2,
    excludeItemKeys: ["SRC"],
    libraryID: 1,
    stats,
  });

  assert.equal(backend.requests.length, 2);
  for (const request of backend.requests) {
    assert.equal(request.groupByItem, true);
    // A document cap here is the truncation this tool exists to avoid.
    assert.equal(request.documentLimit, undefined);
    assert.equal(request.maxChunksPerItem, 2);
    assert.equal(request.minScore, 0);
    assert.equal(request.libraryID, 1);
  }
  assert.deepEqual(matches.map((match) => match.itemKey).sort(), ["A", "B"]);
  const a = matches.find((match) => match.itemKey === "A");
  assert.deepEqual(
    a.perQuery[0].map((hit) => hit.chunkId),
    [0, 1],
  );
  assert.deepEqual(
    a.perQuery[1].map((hit) => hit.chunkId),
    [2],
  );
  const b = matches.find((match) => match.itemKey === "B");
  assert.equal(b.perQuery[0].length, 0);
  assert.equal(b.perQuery[1].length, 1);
  assert.equal(stats.scanned, 200);
  assert.equal(stats.documents, 2);
}

// A GPU failure falls back to the CPU scan and still answers.
{
  const backend = fakeGpuBackend({ results: [], failOn: 0 });
  const rows = Array.from({ length: 4 }, (_, index) => ({
    id: index + 1,
    item_key: `CPU${index % 2}`,
    chunk_id: Math.floor(index / 2),
    language: "en",
    dimensions: 2,
    float32: vectorAt(0.02 * index),
  }));
  const { store } = createStore(rows);
  // Same store, but with an enabled backend that fails on first use.
  store.gpuBackend = backend;
  const matches = await store.searchMultiQuery([QUERY_A], {});
  assert.deepEqual(matches.map((match) => match.itemKey).sort(), [
    "CPU0",
    "CPU1",
  ]);
  assert.equal(backend.requests.length, 1);
}

// ============ 3. Service: validation and wiring ============

function fakeService({ itemVectors, matches, gpu = false }) {
  const service = Object.create(SemanticSearchService.prototype);
  const seen = {};
  service.initialize = async () => {};
  service.vectorStore = {
    isGpuSearchEnabled: () => gpu,
    getItemVectors: async (itemKey) => itemVectors.get(itemKey) ?? [],
    searchMultiQuery: async (queryVectors, options) => {
      seen.queryVectors = queryVectors;
      seen.options = options;
      if (options.stats) {
        options.stats.scanned = 4242;
        options.stats.documents = matches.length;
      }
      return matches;
    },
  };
  return { service, seen };
}

const SRC_VECTORS = Array.from({ length: 6 }, (_, chunkId) => ({
  chunkId,
  vector: new Float32Array([Math.cos(chunkId), Math.sin(chunkId)]),
  language: "en",
}));

// Happy path: query vectors come from the stored chunks (no embedding call),
// the source document is excluded by the scan, and the result is documents.
{
  const { service, seen } = fakeService({
    itemVectors: new Map([["SRC", SRC_VECTORS]]),
    matches: [
      doc("HIGH", [hits(0.9, 0.85), hits(0.88, 0.86), hits(0.9, 0.9)]),
      doc("MID", [hits(0.66, 0.64), hits(0.65, 0.63), hits(0.66, 0.62)]),
      doc("LOW", [hits(0.9, 0.9), [], []]),
    ],
  });
  const outcome = await service.findSimilarByChunks({
    itemKey: "SRC",
    chunkIds: [1, 3, 5],
    libraryID: 1,
    minScore: 0.6,
    vectorScanTimeoutMs: 8000,
  });

  assert.deepEqual(outcome.queryChunkIds, [1, 3, 5]);
  assert.equal(outcome.totalChunksInItem, 6);
  assert.equal(seen.queryVectors.length, 3);
  assert.deepEqual(Array.from(seen.queryVectors[0]), [
    Math.fround(Math.cos(1)),
    Math.fround(Math.sin(1)),
  ]);
  assert.deepEqual(seen.options.excludeItemKeys, ["SRC"]);
  // Every chunk is kept, negative cosines included: a dropped chunk is
  // indistinguishable from an absent one, and the top-2 average would then be
  // averaging a single spike with nothing.
  assert.equal(seen.options.minChunkScore, -1);
  // The deadline is the user's single-scan budget scaled for 3 query chunks on
  // the CPU path, not the raw setting.
  const expectedCpu = resolveSimilarScanBudget({
    queryChunkCount: 3,
    vectorScanTimeoutMs: 8000,
    path: "cpu",
  });
  assert.equal(outcome.budget.timeoutMs, expectedCpu.timeoutMs);
  assert.equal(outcome.budget.path, "cpu");
  assert.ok(outcome.budget.timeoutMs > 8000);
  assert.ok(seen.options.deadlineAt > Date.now());

  assert.deepEqual(
    outcome.ranked.map((row) => row.itemKey),
    ["HIGH", "MID"],
  );
  assert.equal(outcome.discardedBelowThreshold, 1);
  assert.equal(outcome.candidateDocuments, 3);
  assert.equal(outcome.chunksScanned, 4242);
  assert.ok(outcome.ranked[0].score > outcome.ranked[1].score);
}

// Chunks that do not belong to the named document are refused, with the valid
// range named — a chunkId is only unique inside its own document, so a borrowed
// id would otherwise mean a different passage entirely.
{
  const { service } = fakeService({
    itemVectors: new Map([["SRC", SRC_VECTORS]]),
    matches: [],
  });
  await assert.rejects(
    service.findSimilarByChunks({
      itemKey: "SRC",
      chunkIds: [1, 99],
      minScore: 0.6,
    }),
    /do not belong to item SRC.*99.*0 to 5/s,
  );
  await assert.rejects(
    service.findSimilarByChunks({
      itemKey: "SRC",
      chunkIds: [1.5],
      minScore: 0.6,
    }),
    /must be integers/,
  );
  await assert.rejects(
    service.findSimilarByChunks({
      itemKey: "SRC",
      chunkIds: [],
      minScore: 0.6,
    }),
    /at least one chunk/,
  );
  await assert.rejects(
    service.findSimilarByChunks({
      itemKey: "SRC",
      chunkIds: Array.from(
        { length: MAX_SIMILAR_QUERY_CHUNKS + 1 },
        (_, index) => index,
      ),
      minScore: 0.6,
    }),
    /Too many query chunks/,
  );
  await assert.rejects(
    service.findSimilarByChunks({
      itemKey: "UNINDEXED",
      chunkIds: [0],
      minScore: 0.6,
    }),
    /no indexed vectors/,
  );
}

// Duplicate ids are one query chunk, not two: the same vector twice would
// double that facet's weight in the mean.
{
  const { service, seen } = fakeService({
    itemVectors: new Map([["SRC", SRC_VECTORS]]),
    matches: [],
  });
  const outcome = await service.findSimilarByChunks({
    itemKey: "SRC",
    chunkIds: [2, 2, 4],
    minScore: 0.6,
  });
  assert.deepEqual(outcome.queryChunkIds, [2, 4]);
  assert.equal(seen.queryVectors.length, 2);
}

// The execution path decides the deadline, because the two paths scale
// differently: the same query on the GPU gets a bigger budget than on the CPU.
{
  const onGpu = fakeService({
    itemVectors: new Map([["SRC", SRC_VECTORS]]),
    matches: [],
    gpu: true,
  });
  const gpuOutcome = await onGpu.service.findSimilarByChunks({
    itemKey: "SRC",
    chunkIds: [0, 1, 2, 3, 4],
    minScore: 0.6,
    vectorScanTimeoutMs: 8000,
  });
  assert.equal(gpuOutcome.budget.path, "gpu");
  const cpuEquivalent = resolveSimilarScanBudget({
    queryChunkCount: 5,
    vectorScanTimeoutMs: 8000,
    path: "cpu",
  });
  assert.ok(gpuOutcome.budget.timeoutMs > cpuEquivalent.timeoutMs);
}

// ============ 3b. The scan budget model ============

/**
 * The multipliers are calibrated against real measurements recorded in the
 * model itself (scripts/benchmark-find-similar-scaling.js). These assertions
 * are what stop the constants from drifting away from the data they came from.
 */
{
  for (const path of ["cpu", "gpu"]) {
    const model = SIMILAR_SCAN_BUDGET_MODEL[path];
    for (const [count, measured] of Object.entries(model.measured)) {
      const budget = resolveSimilarScanBudget({
        queryChunkCount: Number(count),
        vectorScanTimeoutMs: 8000,
        path,
      });
      // Above what was measured — otherwise a normal query times out...
      assert.ok(
        budget.multiplier > measured * 1.1,
        `${path} N=${count}: multiplier ${budget.multiplier} leaves no margin over the measured ${measured}`,
      );
      // ...but not so far above that a genuinely stuck scan waits forever.
      assert.ok(
        budget.multiplier < measured * 2.5,
        `${path} N=${count}: multiplier ${budget.multiplier} is far beyond the measured ${measured}`,
      );
    }
  }

  // The CPU path shares its database read across queries, so its cost per extra
  // chunk must stay well below the GPU's independent full scans. This is the
  // measured difference in shape, not a preference.
  const cpu20 = resolveSimilarScanBudget({
    queryChunkCount: 20,
    vectorScanTimeoutMs: 8000,
    path: "cpu",
  });
  const gpu20 = resolveSimilarScanBudget({
    queryChunkCount: 20,
    vectorScanTimeoutMs: 8000,
    path: "gpu",
  });
  assert.ok(gpu20.multiplier > cpu20.multiplier * 2);
  // Neither path may collapse to "N times the single-scan budget"...
  assert.ok(cpu20.multiplier < 20);
  // ...nor to a constant that ignores the query count.
  for (const path of ["cpu", "gpu"]) {
    let previous = 0;
    for (const count of [1, 3, 5, 10, 20]) {
      const budget = resolveSimilarScanBudget({
        queryChunkCount: count,
        vectorScanTimeoutMs: 8000,
        path,
      });
      assert.ok(budget.multiplier > previous, `${path} must grow with N`);
      previous = budget.multiplier;
    }
  }

  // The user's setting is the only absolute quantity: doubling it doubles the
  // budget, so tuning vectorScanTimeoutMs still controls this tool.
  const single = resolveSimilarScanBudget({
    queryChunkCount: 5,
    vectorScanTimeoutMs: 8000,
    path: "cpu",
  });
  const doubled = resolveSimilarScanBudget({
    queryChunkCount: 5,
    vectorScanTimeoutMs: 16000,
    path: "cpu",
  });
  assert.equal(doubled.timeoutMs, single.timeoutMs * 2);
  assert.equal(doubled.multiplier, single.multiplier);

  // An extreme user setting cannot turn into a multi-hour deadline.
  const extreme = resolveSimilarScanBudget({
    queryChunkCount: 20,
    vectorScanTimeoutMs: 3600000,
    path: "gpu",
  });
  assert.equal(extreme.timeoutMs, SIMILAR_SCAN_BUDGET_CEILING_MS);
  assert.equal(extreme.capped, true);
  // At the default setting the ceiling never binds.
  assert.equal(
    resolveSimilarScanBudget({
      queryChunkCount: 20,
      vectorScanTimeoutMs: 8000,
      path: "gpu",
    }).capped,
    false,
  );
  // Garbage in still yields a usable deadline rather than NaN.
  const degenerate = resolveSimilarScanBudget({
    queryChunkCount: 0,
    vectorScanTimeoutMs: 0,
    path: "cpu",
  });
  assert.ok(Number.isFinite(degenerate.timeoutMs) && degenerate.timeoutMs >= 1);
}

// ============ 4. Pagination over the ranked documents ============

const SIMILAR_FINGERPRINT = {
  query: "1:SRC",
  keywords: ["1", "3", "5"],
  appliedMinScore: 0.6,
  language: "all",
  libraryID: 1,
  rrfK: 0,
  keywordWeight: 0,
  semanticWeight: 1,
  pageSize: 20,
  scope: "library",
};

{
  const ranked = Array.from({ length: 45 }, (_, index) => ({
    itemKey: `SIM${String(index).padStart(2, "0")}`,
    libraryID: 1,
    score: 0.95 - index * 0.005,
  }));
  const store = new HybridSearchPageStore(
    undefined,
    undefined,
    undefined,
    SIMILAR_PAGE_IDENTITY,
  );
  const searchId = store.create(SIMILAR_FINGERPRINT, ranked, {
    itemKey: "SRC",
  });

  // Page size is capped at 20 documents even when a larger one is asked for,
  // and the qualifying total is reported in full regardless.
  const page1 = windowOf(ranked, 0, 100, searchId, SIMILAR_PAGE_IDENTITY);
  assert.equal(page1.returned, 20);
  assert.equal(page1.totalRelevant, 45);
  assert.equal(page1.hasMore, true);

  const page2 = store.read(page1.nextCursor, {}, undefined).window;
  assert.equal(page2.offset, 20);
  assert.equal(page2.returned, 20);
  assert.equal(page2.hasMore, true);
  const page3 = store.read(page2.nextCursor, {}, undefined).window;
  assert.equal(page3.offset, 40);
  assert.equal(page3.returned, 5);
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextCursor, undefined);

  // Every qualifying document is seen exactly once across the pages: paging is
  // a window onto one finished list, not three searches.
  const seen = [...page1.rows, ...page2.rows, ...page3.rows].map(
    (row) => row.itemKey,
  );
  assert.equal(new Set(seen).size, 45);
  assert.deepEqual(
    seen,
    ranked.map((row) => row.itemKey),
  );

  // Re-reading the same cursor returns the same page, so a retry neither skips
  // nor duplicates documents.
  assert.deepEqual(
    store.read(page1.nextCursor, {}, undefined).window.rows,
    page2.rows,
  );

  // Changing the query chunks means a different ranking, so the old cursor must
  // fail loudly instead of paging into a list that answers another question.
  assert.throws(
    () => store.read(page1.nextCursor, { keywords: ["1", "3", "9"] }),
    CursorError,
  );
  assert.throws(
    () => store.read(page1.nextCursor, { query: "1:OTHER" }),
    CursorError,
  );
  assert.throws(
    () => store.read(page1.nextCursor, { appliedMinScore: 0.8 }),
    CursorError,
  );
}

// ============ 4b. Whose cursor is it? ============

/**
 * find_similar reuses hybrid_search's pagination machinery, and the machinery
 * used to name hybrid_search in every failure message. An AI told to "run
 * hybrid_search again" after a find_similar cursor expired would do exactly
 * that — and get a keyword+semantic ranking of the library instead of the
 * documents similar to its paper. The tool that owns the ranking must be the
 * tool the error names.
 */
{
  const clock = { now: 0 };
  const similar = new HybridSearchPageStore(
    () => clock.now,
    1000,
    2,
    SIMILAR_PAGE_IDENTITY,
  );
  const hybrid = new HybridSearchPageStore(() => clock.now, 1000, 2);

  const ranked = [{ itemKey: "A" }, { itemKey: "B" }];
  const similarId = similar.create(SIMILAR_FINGERPRINT, ranked, {});
  const hybridId = hybrid.create(SIMILAR_FINGERPRINT, ranked, {});
  const similarCursor = windowOf(
    ranked,
    0,
    1,
    similarId,
    SIMILAR_PAGE_IDENTITY,
  ).nextCursor;
  const hybridCursor = windowOf(ranked, 0, 1, hybridId).nextCursor;

  // Cursors are tagged by tool, so one tool's cursor cannot be replayed by the
  // other and quietly page through the wrong list.
  assert.ok(similarCursor.startsWith("fs1_"));
  assert.ok(hybridCursor.startsWith("hs1_"));
  assert.throws(
    () => similar.read(hybridCursor, {}),
    (error) =>
      error instanceof CursorError && /Malformed cursor/.test(error.message),
  );
  assert.throws(
    () => hybrid.read(similarCursor, {}),
    (error) =>
      error instanceof CursorError && /Malformed cursor/.test(error.message),
  );

  // Expiry names find_similar...
  clock.now = 5000;
  assert.throws(
    () => similar.read(similarCursor, {}),
    (error) =>
      error instanceof CursorError &&
      /Run find_similar again/.test(error.message) &&
      !/hybrid_search/.test(error.message),
  );
  // ...and so does a changed argument.
  clock.now = 0;
  const freshId = similar.create(SIMILAR_FINGERPRINT, ranked, {});
  const freshCursor = windowOf(
    ranked,
    0,
    1,
    freshId,
    SIMILAR_PAGE_IDENTITY,
  ).nextCursor;
  assert.throws(
    () => similar.read(freshCursor, { appliedMinScore: 0.9 }),
    (error) =>
      error instanceof CursorError &&
      /run find_similar again/.test(error.message) &&
      !/hybrid_search/.test(error.message),
  );
  assert.throws(
    () => similar.read("fs1_nonexistent_0", {}),
    (error) =>
      error instanceof CursorError &&
      /find_similar/.test(error.message) &&
      !/hybrid_search/.test(error.message),
  );

  // hybrid_search's own messages are untouched.
  clock.now = 5000;
  assert.throws(
    () => hybrid.read(hybridCursor, {}),
    (error) =>
      error instanceof CursorError &&
      /Run hybrid_search again/.test(error.message) &&
      !/find_similar/.test(error.message),
  );
  assert.equal(HYBRID_PAGE_IDENTITY.toolName, "hybrid_search");
  assert.equal(HYBRID_PAGE_IDENTITY.cursorPrefix, "hs1");
}

// ============ 5. The MCP tool contract ============

/**
 * The tool layer is checked at source level, as hybrid_search's contract is:
 * it needs a live Zotero to run, but what it PROMISES the calling AI is a
 * property of the file and is exactly the part that must not silently rot.
 */
{
  const serverSource = fs.readFileSync(
    path.join(rootDir, "src/modules/streamableMCPServer.ts"),
    "utf8",
  );
  const toolBlock = serverSource.slice(
    serverSource.indexOf("name: 'find_similar'"),
    serverSource.indexOf("name: 'semantic_status'"),
  );

  // The call chain the AI is told to follow.
  assert.match(toolBlock, /chunkIds:\s*\{/);
  assert.match(toolBlock, /search_fulltext/);
  assert.match(toolBlock, /representative/i);
  assert.match(toolBlock, /cursor:\s*\{/);
  assert.match(toolBlock, /MAX_SIMILAR_QUERY_CHUNKS/);
  // Passages are read with search_fulltext, not shipped with 20 rows at once.
  assert.match(toolBlock, /no passage text/i);
  // The old contract promised a fixed handful of chunk-level hits.
  assert.doesNotMatch(toolBlock, /Number of similar items to return/);
  assert.doesNotMatch(toolBlock, /default:\s*5/);

  // Threshold and page size come from the user's settings, as everywhere else.
  const handler = serverSource.slice(
    serverSource.indexOf("private async callFindSimilar"),
    serverSource.indexOf("private async continueFindSimilar"),
  );
  assert.match(
    handler,
    /resolveScoreFloor\(args\.minScore, settings\.minScore\)/,
  );
  assert.match(
    handler,
    /resolveResultCap\(args\.topK, settings\.maxDocuments\)/,
  );
  assert.match(handler, /findSimilarByChunks\(/);
  assert.match(handler, /this\.similarPages\.create\(/);
  assert.match(handler, /windowOf</);
  // The outer backstop is derived from the same scaled budget the scan uses.
  // A backstop built from the raw single-scan setting fires first and reports a
  // timeout the scan itself never hit.
  assert.match(handler, /resolveSimilarScanBudget\(/);
  assert.doesNotMatch(handler, /vectorScanTimeoutMs \+ 5000/);
  // find_similar's paging state must be tagged as its own tool.
  assert.match(serverSource, /SIMILAR_PAGE_IDENTITY/);
  // Paging must not re-run the scan.
  const continuation = serverSource.slice(
    serverSource.indexOf("private async continueFindSimilar"),
    serverSource.indexOf("private buildFindSimilarResponse"),
  );
  assert.match(continuation, /this\.similarPages\.read\(/);
  assert.doesNotMatch(continuation, /findSimilarByChunks/);

  // The old single-vector entry point must be gone, not merely unused.
  assert.doesNotMatch(serverSource, /semanticService\.findSimilar\(/);
  const serviceSource = fs.readFileSync(
    path.join(rootDir, "src/modules/semantic/semanticSearchService.ts"),
    "utf8",
  );
  assert.doesNotMatch(serviceSource, /async findSimilar\(/);
  assert.match(serviceSource, /async findSimilarByChunks\(/);
  // Its defining bug: one chunk of the source document stood in for the paper.
  assert.doesNotMatch(serviceSource, /Use first chunk vector as query/);

  // semantic_status must not send the AI after a tool that does not exist.
  // "Run migrate_int8 to optimize" named an MCP tool this server has never
  // exposed; the only possible outcome was a failed call and a retry loop.
  const toolNames = [
    ...serverSource.matchAll(/name:\s*'([a-z_]+)',\s*\n\s*description/g),
  ].map((match) => match[1]);
  assert.ok(toolNames.includes("semantic_status"));
  assert.ok(!toolNames.includes("migrate_int8"));
  for (const file of [
    "src/modules/streamableMCPServer.ts",
    "src/modules/apiHandlers.ts",
    "src/modules/httpServer.ts",
  ]) {
    const source = fs.readFileSync(path.join(rootDir, file), "utf8");
    assert.doesNotMatch(
      source,
      /Run migrate_int8/,
      `${file} still advertises a migrate_int8 tool`,
    );
  }
  const statusBlock = serverSource.slice(
    serverSource.indexOf("private async callSemanticStatus"),
    serverSource.indexOf("private async callFulltextDatabase"),
  );
  assert.match(statusBlock, /int8Status\?\.needed/);
  // What replaces it has to be something that actually exists.
  assert.match(statusBlock, /rebuild the semantic index/i);
}

console.log("find_similar regression tests passed");
