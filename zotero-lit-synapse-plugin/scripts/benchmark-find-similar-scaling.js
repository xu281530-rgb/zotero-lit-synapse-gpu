/* eslint-env node */

/**
 * How does a find_similar scan actually scale with the number of query chunks?
 *
 * The answer decides the tool's deadline. find_similar reuses the user's
 * vectorScanTimeoutMs — the budget for ONE full-library scan — so the only
 * honest way to set a multiplier is to measure what N query chunks really cost
 * on each execution path:
 *
 *   CPU: one pass over the database, N dot products per row. The SQL read and
 *        the Int8 decode are paid once, so cost(N) is expected to be
 *        sub-linear: a + b*N with a > 0.
 *   GPU: the vectors are resident on the device and the worker takes one query
 *        per request, so N queries are N independent full scans — expected to
 *        be very close to linear.
 *
 * Run:  npm run benchmark:find-similar-scaling
 * Env:  FS_VECTORS, FS_DIMENSIONS, FS_CHUNKS_PER_ITEM, FS_REPEATS,
 *       VECTOR_GPU_EXE, VECTOR_GPU_RUNTIME_DIR, FS_SKIP_GPU=1
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";

register("./ts-ext-hooks.mjs", import.meta.url);

const { GPU_PROTOCOL_VERSION, GpuFrameDecoder, encodeGpuFrame } = await import(
  "../src/modules/semantic/gpuVectorProtocol.ts"
);
globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };
const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const executable =
  process.env.VECTOR_GPU_EXE ||
  path.join(
    projectDirectory,
    "native",
    "vector-gpu",
    "build",
    "bin",
    "vector-gpu.exe",
  );
const runtimeDirectory =
  process.env.VECTOR_GPU_RUNTIME_DIR ||
  path.join(projectDirectory, ".cuda-toolkit", "12.6", "bin");

const vectorCount = Number(process.env.FS_VECTORS || 60_000);
const dimensions = Number(process.env.FS_DIMENSIONS || 1024);
const chunksPerItem = Number(process.env.FS_CHUNKS_PER_ITEM || 10);
const repeats = Number(process.env.FS_REPEATS || 3);
const QUERY_COUNTS = [1, 3, 5, 10, 20];
const batchSize = 2048;
const timeoutMs = 300_000;

const itemKeyFor = (row) => `ITEM-${Math.floor(row / chunksPerItem) + 1}`;
const chunkIdFor = (row) => row % chunksPerItem;

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function createIndex() {
  let state = 0x5a17c9e3;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
  const float32 = new Float32Array(vectorCount * dimensions);
  const int8 = new Int8Array(vectorCount * dimensions);
  for (let row = 0; row < vectorCount; row++) {
    const offset = row * dimensions;
    let maxAbs = 0;
    for (let column = 0; column < dimensions; column++) {
      const value = random() * 2 - 1;
      float32[offset + column] = value;
      maxAbs = Math.max(maxAbs, Math.abs(value));
    }
    const scale = maxAbs > 0 ? 127 / maxAbs : 1;
    for (let column = 0; column < dimensions; column++) {
      int8[offset + column] = Math.round(float32[offset + column] * scale);
    }
  }
  return { float32, int8 };
}

function createCpuStore(index, backend) {
  const directory = mkdtempSync(path.join(tmpdir(), "zotero-lit-synapse-fs-bench-"));
  const databasePath = path.join(directory, "vectors.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_key TEXT NOT NULL,
      chunk_id INTEGER NOT NULL,
      vector BLOB NOT NULL,
      language TEXT NOT NULL,
      chunk_text TEXT,
      dimensions INTEGER NOT NULL,
      vector_int8 BLOB,
      vector_scale REAL,
      vector_norm REAL,
      UNIQUE(item_key, chunk_id)
    );
    CREATE TABLE vectors_f32 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_key TEXT NOT NULL,
      chunk_id INTEGER NOT NULL,
      vector BLOB NOT NULL,
      UNIQUE(item_key, chunk_id)
    );
  `);
  const insertEmbedding = database.prepare(
    "INSERT INTO embeddings (item_key, chunk_id, vector, language, dimensions, vector_int8, vector_scale, vector_norm) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFloat32 = database.prepare(
    "INSERT INTO vectors_f32 (item_key, chunk_id, vector) VALUES (?, ?, ?)",
  );
  database.exec("BEGIN");
  for (let row = 0; row < vectorCount; row++) {
    const start = row * dimensions;
    const float32 = index.float32.subarray(start, start + dimensions);
    const int8 = index.int8.subarray(start, start + dimensions);
    let normSquared = 0;
    for (const value of int8) normSquared += value * value;
    let maxAbs = 0;
    for (const value of float32) maxAbs = Math.max(maxAbs, Math.abs(value));
    insertEmbedding.run(
      itemKeyFor(row),
      chunkIdFor(row),
      new Uint8Array(0),
      row % 7 === 0 ? "zh" : "en",
      dimensions,
      new Uint8Array(int8.buffer, int8.byteOffset, int8.byteLength),
      maxAbs > 0 ? 127 / maxAbs : 1,
      Math.sqrt(normSquared),
    );
    insertFloat32.run(
      itemKeyFor(row),
      chunkIdFor(row),
      new Uint8Array(float32.buffer, float32.byteOffset, float32.byteLength),
    );
  }
  database.exec("COMMIT");

  const store = new VectorStore(backend);
  store.db = {
    queryAsync: async (sql, params = [], options) => {
      const rows = database.prepare(sql).all(...params);
      if (typeof options?.onRow === "function") {
        for (const row of rows) options.onRow(row, () => {});
      }
      return rows;
    },
    valueQueryAsync: async (sql, params = []) => {
      const row = database.prepare(sql).get(...params);
      return row ? Object.values(row)[0] : undefined;
    },
  };
  store.initialized = true;
  return {
    store,
    close: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

class GpuClient {
  constructor() {
    this.decoder = new GpuFrameDecoder();
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = "";
    this.child = spawn(executable, ["--stdio"], {
      cwd: runtimeDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk) => {
      for (const frame of this.decoder.push(chunk)) {
        const pending = this.pending.get(frame.header.requestId);
        if (!pending) continue;
        this.pending.delete(frame.header.requestId);
        if (frame.header.ok === false) {
          pending.reject(new Error(String(frame.header.message)));
        } else {
          pending.resolve(frame);
        }
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      if (this.pending.size > 0) {
        this.rejectAll(
          new Error(`vector-gpu.exe exited (${code}): ${this.stderr.trim()}`),
        );
      }
    });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(type, fields = {}, payload = new Uint8Array(0)) {
    const requestId = `bench-${++this.sequence}`;
    const encoded = encodeGpuFrame(
      { protocol: GPU_PROTOCOL_VERSION, type, requestId, ...fields },
      payload,
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(encoded);
    });
  }

  async close() {
    if (this.child.exitCode === null) {
      try {
        await this.request("shutdown");
      } finally {
        this.child.stdin.end();
      }
    }
  }
}

/** A GpuVectorSearchBackend that forwards to the real worker process. */
function gpuBackendFor(client, precision) {
  return {
    enabled: false,
    isEnabled() {
      return this.enabled;
    },
    getEffectivePrecision: () => precision,
    getCpuFallbackPrecision: () => undefined,
    reportCpuPrecision: () => {},
    registerProvider: () => {},
    startIfEnabled: async () => {},
    search: async (request) => {
      const query =
        precision === "float32" ? request.query : quantize(request.query);
      let normSquared = 0;
      for (const value of query) normSquared += value * value;
      const frame = await client.request(
        "search",
        {
          dimensions: request.query.length,
          precision,
          queryNorm: Math.sqrt(normSquared),
          topK: request.topK,
          groupByItem: request.groupByItem,
          documentLimit: request.documentLimit,
          maxChunksPerItem: request.maxChunksPerItem,
          language: request.language,
          itemKeys: request.itemKeys,
          libraryID: request.libraryID ?? null,
          minScore: request.minScore,
        },
        new Uint8Array(query.buffer, query.byteOffset, query.byteLength),
      );
      if (request.stats) {
        request.stats.scanned = Number(frame.header.scanned ?? 0);
      }
      return frame.header.results.map((value) => ({
        libraryID: value.libraryID,
        itemKey: value.itemKey,
        chunkId: value.chunkId,
        score: value.score,
        rowId: value.rowId,
        language: value.language,
        chunkText: "",
      }));
    },
    publishMutation: async () => {},
    fallback: (error) => {
      throw error;
    },
    setEnabled: async () => {},
    setPrecision: async () => {},
    shutdown: async () => {},
  };
}

/** Same query quantisation the GPU service performs: Int8, one byte per dim. */
function quantize(vector) {
  let maxAbs = 0;
  for (const value of vector) maxAbs = Math.max(maxAbs, Math.abs(value));
  const scale = maxAbs > 0 ? 127 / maxAbs : 1;
  const quantized = new Int8Array(vector.length);
  for (let index = 0; index < vector.length; index++) {
    quantized[index] = Math.round(vector[index] * scale);
  }
  return quantized;
}

async function uploadIndex(client, precision, vectors) {
  await client.request("snapshot.begin", {
    precision,
    total: vectorCount,
    dimensions,
  });
  for (let start = 0; start < vectorCount; start += batchSize) {
    const end = Math.min(vectorCount, start + batchSize);
    const rows = Array.from({ length: end - start }, (_, localIndex) => {
      const row = start + localIndex;
      return {
        rowId: row + 1,
        libraryID: 1,
        itemKey: itemKeyFor(row),
        chunkId: chunkIdFor(row),
        language: row % 7 === 0 ? "zh" : "en",
      };
    });
    const slice = vectors.subarray(start * dimensions, end * dimensions);
    await client.request(
      "snapshot.batch",
      { precision, dimensions, rows },
      new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength),
    );
  }
  const committed = await client.request("snapshot.commit");
  assert.equal(committed.header.vectors, vectorCount);
}

function queriesFor(vectors, count) {
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor((index * vectorCount) / Math.max(1, count));
    return vectors.subarray(row * dimensions, (row + 1) * dimensions);
  });
}

async function timeMultiQuery(store, queries) {
  const started = performance.now();
  const matches = await store.searchMultiQuery(queries, {
    chunksPerQuery: 2,
    minChunkScore: -1,
    libraryID: 1,
    language: "all",
  });
  return { ms: performance.now() - started, documents: matches.length };
}

function report(label, baselineMs, rows) {
  console.log(`\n${label}`);
  console.log(
    "  queries   median ms   x(1 query)   x(single full scan)   docs",
  );
  for (const row of rows) {
    console.log(
      `  ${String(row.count).padStart(7)}   ${row.ms.toFixed(0).padStart(9)}   ${(
        row.ms / rows[0].ms
      )
        .toFixed(2)
        .padStart(
          10,
        )}   ${(row.ms / baselineMs).toFixed(2).padStart(19)}   ${String(
        row.documents,
      ).padStart(4)}`,
    );
  }
}

const index = createIndex();
console.log(
  `Index: ${vectorCount} chunks over ${Math.ceil(vectorCount / chunksPerItem)} documents, ${dimensions} dims, repeats=${repeats}`,
);

const results = {};
let client = null;
let cpuIndex = null;

try {
  const backend = { isEnabled: () => false };
  cpuIndex = createCpuStore(index, {
    ...gpuBackendFor(null, "int8"),
    isEnabled: () => false,
    search: async () => {
      throw new Error("GPU disabled for the CPU measurement");
    },
    ...backend,
  });
  const store = cpuIndex.store;

  // Baseline: ONE full-library scan through the same code hybrid_search uses.
  // This is what the user's vectorScanTimeoutMs is calibrated against.
  const singleQuery = queriesFor(index.float32, 1)[0];
  await store.search(singleQuery, {
    groupByItem: true,
    maxChunksPerItem: 3,
    includeChunkText: false,
    minScore: -1,
    libraryID: 1,
  });
  const baselineTimes = [];
  for (let run = 0; run < repeats; run++) {
    const started = performance.now();
    await store.search(singleQuery, {
      groupByItem: true,
      maxChunksPerItem: 3,
      includeChunkText: false,
      minScore: -1,
      libraryID: 1,
    });
    baselineTimes.push(performance.now() - started);
  }
  const cpuBaseline = median(baselineTimes);
  console.log(
    `\nCPU single full scan (search, groupByItem): ${cpuBaseline.toFixed(0)} ms`,
  );

  const cpuRows = [];
  for (const count of QUERY_COUNTS) {
    const queries = queriesFor(index.float32, count);
    await timeMultiQuery(store, queries.slice(0, 1));
    const times = [];
    let documents = 0;
    for (let run = 0; run < repeats; run++) {
      const measured = await timeMultiQuery(store, queries);
      times.push(measured.ms);
      documents = measured.documents;
    }
    cpuRows.push({ count, ms: median(times), documents });
  }
  results.cpu = { baseline: cpuBaseline, rows: cpuRows };
  report("CPU (Int8, single pass over the index)", cpuBaseline, cpuRows);

  if (process.env.FS_SKIP_GPU === "1" || !existsSync(executable)) {
    console.log(
      `\nGPU: skipped (${existsSync(executable) ? "FS_SKIP_GPU=1" : `no worker at ${executable}`})`,
    );
  } else {
    client = new GpuClient();
    await client.request("hello", { expectedProtocol: GPU_PROTOCOL_VERSION });
    await uploadIndex(client, "int8", index.int8);
    const gpuBackend = gpuBackendFor(client, "int8");
    gpuBackend.enabled = true;
    const gpuStore = new VectorStore(gpuBackend);
    gpuStore.db = store.db;
    gpuStore.initialized = true;

    const warmQuery = queriesFor(index.float32, 1);
    await gpuStore.searchMultiQuery(warmQuery, {
      chunksPerQuery: 2,
      minChunkScore: -1,
      libraryID: 1,
    });
    const gpuBaselineTimes = [];
    for (let run = 0; run < repeats; run++) {
      const started = performance.now();
      await gpuStore.search(warmQuery[0], {
        groupByItem: true,
        maxChunksPerItem: 3,
        includeChunkText: false,
        minScore: -1,
        libraryID: 1,
      });
      gpuBaselineTimes.push(performance.now() - started);
    }
    const gpuBaseline = median(gpuBaselineTimes);
    console.log(
      `\nGPU single full scan (search, groupByItem): ${gpuBaseline.toFixed(0)} ms`,
    );

    const gpuRows = [];
    for (const count of QUERY_COUNTS) {
      const queries = queriesFor(index.float32, count);
      const times = [];
      let documents = 0;
      for (let run = 0; run < repeats; run++) {
        const measured = await timeMultiQuery(gpuStore, queries);
        times.push(measured.ms);
        documents = measured.documents;
      }
      gpuRows.push({ count, ms: median(times), documents });
    }
    results.gpu = { baseline: gpuBaseline, rows: gpuRows };
    report("GPU (resident vectors, one scan per query)", gpuBaseline, gpuRows);
  }

  console.log("\nJSON:", JSON.stringify(results));
} finally {
  await client?.close();
  cpuIndex?.close();
}
