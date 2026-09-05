/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");

const bytes = (vector) =>
  new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );

const vectorForScore = (score) =>
  bytes(new Float32Array([score, Math.sqrt(Math.max(0, 1 - score * score))]));

/** A row shaped like the mozIStorageRow Zotero passes to an onRow callback. */
const storageRow = (columns) => ({
  getResultByName(name) {
    if (!Object.prototype.hasOwnProperty.call(columns, name)) {
      throw new Error(`DB column '${name}' not found`);
    }
    return columns[name];
  },
});

function createStore(rows, { int8Count = 0, texts = new Map() } = {}) {
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
            ? [{
                dimensions: rows[0].dimensions,
                has_int8: rows[0].vector_int8 ? 1 : 0,
              }]
            : [];
        }
        if (sql.includes("SELECT e.id AS embedding_id")) {
          const ids = new Set(params);
          return rows
            .filter((row) => ids.has(row.id) && row.float32)
            .map((row) => ({ embedding_id: row.id, vector: row.float32 }));
        }
        if (sql.includes("SELECT id, chunk_text")) {
          return params.map((id) => ({
            id,
            chunk_text: texts.get(id) ?? `text-${id}`,
          }));
        }
        if (sql.includes("ORDER BY id LIMIT ? OFFSET ?")) {
          const limit = params.at(-2);
          const offset = params.at(-1);
          return rows.slice(offset, offset + limit).map((row) =>
            sql.includes("LEFT JOIN vectors_f32")
              ? { ...row, vector_f32: row.float32 }
              : row,
          );
        }
        throw new Error(`Unexpected query: ${sql}`);
      })();

      // Model Zotero faithfully: a SELECT given an onRow callback delivers raw
      // mozIStorageRows through it and resolves to undefined, and only the
      // path that RETURNS rows resolves column names as properties. A fake that
      // hands back plain objects either way makes named access work by accident
      // and cannot catch a reader that fails against the real database.
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

function bruteCosine(query, vector) {
  let dot = 0;
  let queryNorm = 0;
  let vectorNorm = 0;
  for (let index = 0; index < query.length; index += 1) {
    dot += query[index] * vector[index];
    queryNorm += query[index] * query[index];
    vectorNorm += vector[index] * vector[index];
  }
  return dot / Math.sqrt(queryNorm * vectorNorm);
}

const query = new Float32Array([1, 0]);

// Thousands of the highest chunks belonging to one paper must not crowd out
// the rest. More than 240 distinct documents remain available to fusion.
{
  const rows = [];
  let id = 1;
  for (let chunkId = 0; chunkId < 3000; chunkId += 1) {
    const score = 0.999 - chunkId * 0.000001;
    rows.push({
      id: id++,
      item_key: "HOT",
      chunk_id: chunkId,
      language: "en",
      dimensions: 2,
      float32: vectorForScore(score),
    });
  }
  for (let document = 0; document < 300; document += 1) {
    const score = 0.9 - document * 0.001;
    rows.push({
      id: id++,
      item_key: `DOC${String(document).padStart(3, "0")}`,
      chunk_id: 0,
      language: "en",
      dimensions: 2,
      float32: vectorForScore(score),
    });
  }

  const { store, calls } = createStore(rows);
  const results = await store.search(query, {
    groupByItem: true,
    maxChunksPerItem: 3,
    includeChunkText: false,
    minScore: -1,
  });
  const documents = new Set(results.map((row) => row.itemKey));
  assert.equal(documents.size, 301);
  assert.ok(documents.size > 240);
  assert.equal(results.filter((row) => row.itemKey === "HOT").length, 3);
  assert.ok(results.every((row) => row.chunkText === ""));

  const firstPass = calls.filter((call) =>
    call.sql.includes("ORDER BY id LIMIT ? OFFSET ?"),
  );
  assert.equal(firstPass.length, 1);
  assert.ok(firstPass.every((call) => !call.sql.includes("chunk_text")));
  assert.equal(calls.some((call) => call.sql.includes("SELECT id, chunk_text")), false);

  for (const result of results.filter((row) => row.itemKey !== "HOT").slice(0, 20)) {
    const source = rows.find((row) => row.id === result.rowId);
    const vector = new Float32Array(source.float32.buffer.slice(0));
    assert.ok(Math.abs(result.score - bruteCosine(query, vector)) < 1e-7);
  }

  // Hydration is a separate current-page operation: at most 20 documents and
  // their retained chunk references are fetched in one batch.
  const pageDocuments = [...documents].slice(0, 20);
  const pageRows = results.filter((row) => pageDocuments.includes(row.itemKey));
  const textCallsBefore = calls.length;
  const hydrated = await store.getChunkTextsByRowIDs(pageRows.map((row) => row.rowId));
  assert.equal(hydrated.size, pageRows.length);
  const textCalls = calls.slice(textCallsBefore).filter((call) => call.sql.includes("chunk_text"));
  assert.equal(textCalls.length, 1);
  assert.equal(textCalls[0].params.length, pageRows.length);
  assert.ok(new Set(pageRows.map((row) => row.itemKey)).size <= 20);
}

// With >=90% Int8 coverage, missing rows use one batched Float32 lookup rather
// than one query per chunk. Axis-aligned vectors make both paths exact.
{
  const rows = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    item_key: `MIX${index}`,
    chunk_id: 0,
    language: "en",
    dimensions: 2,
    vector_int8: index < 90 ? new Uint8Array([127, 0]) : null,
    vector_norm: index < 90 ? 127 : null,
    float32: bytes(new Float32Array([1, 0])),
  }));
  const { store, calls } = createStore(rows, { int8Count: 90 });
  const results = await store.search(query, {
    groupByItem: true,
    includeChunkText: false,
    minScore: -1,
  });
  assert.equal(new Set(results.map((row) => row.itemKey)).size, 100);
  assert.ok(results.every((row) => row.score === 1));
  const fallbacks = calls.filter((call) => call.sql.includes("embedding_id"));
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].params.length, 10);
}

// Complete Int8 coverage performs no Float32 lookup at all.
{
  const rows = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    item_key: `INT8${index}`,
    chunk_id: 0,
    language: "en",
    dimensions: 2,
    vector_int8: new Uint8Array([127, 0]),
    vector_norm: 127,
    float32: bytes(new Float32Array([1, 0])),
  }));
  const { store, calls } = createStore(rows, { int8Count: 100 });
  const results = await store.search(query, {
    groupByItem: true,
    includeChunkText: false,
    minScore: -1,
  });
  assert.equal(results.length, 100);
  assert.ok(results.every((row) => row.score === 1));
  assert.equal(calls.some((call) => call.sql.includes("embedding_id")), false);
}

// Standalone semantic retrieval hydrates only the documents it will return.
{
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: index + 1,
    item_key: `STANDALONE${index}`,
    chunk_id: 0,
    language: "en",
    dimensions: 2,
    float32: vectorForScore(0.99 - index * 0.01),
  }));
  const { store, calls } = createStore(rows);
  const results = await store.search(query, {
    groupByItem: true,
    documentLimit: 20,
    includeChunkText: true,
    minScore: -1,
  });
  assert.equal(new Set(results.map((row) => row.itemKey)).size, 20);
  const textCalls = calls.filter((call) => call.sql.includes("SELECT id, chunk_text"));
  assert.equal(textCalls.length, 1);
  assert.equal(textCalls[0].params.length, 20);
}

// Below the Int8 coverage threshold, Float32 vectors are joined once per scan
// batch. 50,001 chunks therefore require two vector reads, not 50,001 reads.
{
  const vector = bytes(new Float32Array([1, 0]));
  const rows = Array.from({ length: 50_001 }, (_, index) => ({
    id: index + 1,
    item_key: "LARGE",
    chunk_id: index,
    language: "en",
    dimensions: 2,
    float32: vector,
  }));
  const { store, calls } = createStore(rows);
  const results = await store.search(query, {
    groupByItem: true,
    maxChunksPerItem: 3,
    includeChunkText: false,
    minScore: -1,
  });
  assert.equal(results.length, 3);
  const scans = calls.filter((call) => call.sql.includes("LEFT JOIN vectors_f32"));
  assert.equal(scans.length, 2);
  assert.ok(scans.every((call) => !call.sql.includes("chunk_text")));
  assert.equal(
    calls.some((call) => /WHERE item_key = \? AND chunk_id = \?/.test(call.sql)),
    false,
  );
}

// An explicitly empty Collection scope returns immediately and cannot fall
// back to a full-Library scan.
{
  const { store, calls } = createStore([]);
  assert.deepEqual(await store.search(query, { itemKeys: [] }), []);
  assert.equal(calls.length, 0);
}

console.log("Vector search regression tests passed");
