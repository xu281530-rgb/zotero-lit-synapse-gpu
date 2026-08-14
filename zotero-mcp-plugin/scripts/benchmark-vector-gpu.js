/* eslint-env node */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
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
const { VectorStore } = await import(
  "../src/modules/semantic/vectorStore.ts"
);

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
const vectorCount = Number(process.env.VECTOR_GPU_COUNT || 90_000);
const dimensions = Number(process.env.VECTOR_GPU_DIMENSIONS || 1024);
const queryCount = Number(process.env.VECTOR_GPU_QUERIES || 20);
const warmupCount = 3;
const topK = 20;
const batchSize = 2048;
const timeoutMs = 120_000;
const scoreTolerance = 1e-4;

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[
    Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)
  ];
}

function statistics(values) {
  return {
    min: Math.min(...values),
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95: percentile(values, 0.95),
    max: Math.max(...values),
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
          pending.reject(
            Object.assign(new Error(String(frame.header.message)), {
              code: frame.header.code,
            }),
          );
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
    const requestId = `benchmark-${++this.sequence}`;
    const encoded = encodeGpuFrame(
      { protocol: GPU_PROTOCOL_VERSION, type, requestId, ...fields },
      payload,
    );
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
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

function createCpuVectorStore(index) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "zotero-mcp-vector-benchmark-"),
  );
  const databasePath = path.join(directory, "vectors.sqlite");
  const database = new DatabaseSync(databasePath);
  const started = performance.now();
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
    "INSERT INTO embeddings (item_key, chunk_id, vector, language, dimensions, vector_int8, vector_norm) VALUES (?, 0, ?, ?, ?, ?, ?)",
  );
  const insertFloat32 = database.prepare(
    "INSERT INTO vectors_f32 (item_key, chunk_id, vector) VALUES (?, 0, ?)",
  );
  database.exec("BEGIN");
  try {
    for (let row = 0; row < vectorCount; row++) {
      const start = row * dimensions;
      const float32 = index.float32.subarray(start, start + dimensions);
      const int8 = index.int8.subarray(start, start + dimensions);
      let normSquared = 0;
      for (const value of int8) normSquared += value * value;
      const itemKey = `ITEM-${row + 1}`;
      insertEmbedding.run(
        itemKey,
        new Uint8Array(0),
        row % 7 === 0 ? "zh" : "en",
        dimensions,
        new Uint8Array(int8.buffer, int8.byteOffset, int8.byteLength),
        Math.sqrt(normSquared),
      );
      insertFloat32.run(
        itemKey,
        new Uint8Array(
          float32.buffer,
          float32.byteOffset,
          float32.byteLength,
        ),
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  const adapter = {
    queryAsync: async (sql, params = [], options) => {
      const rows = database.prepare(sql).all(...params);
      if (typeof options?.onRow === "function") {
        for (const row of rows) options.onRow(row, () => {});
      }
      return rows;
    },
  };
  const backend = {
    isEnabled: () => false,
    getEffectivePrecision: () => "int8",
    getCpuFallbackPrecision: () => undefined,
    reportCpuPrecision: () => {},
    registerProvider: () => {},
    startIfEnabled: async () => {},
    search: async () => [],
    publishMutation: async () => {},
    fallback: () => {},
    setEnabled: async () => {},
    setPrecision: async () => {},
    shutdown: async () => {},
  };
  const store = new VectorStore(backend);
  store.db = adapter;
  store.initialized = true;
  return {
    store,
    loadMs: performance.now() - started,
    databaseBytes: statSync(databasePath).size,
    close: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function searchCpu(store, precision, query) {
  return store.searchCpu(
    query,
    {
      topK,
      groupByItem: false,
      includeChunkText: false,
      language: "all",
      minScore: -1,
      libraryID: 1,
    },
    precision,
  );
}

function queryAt(vectors, queryIndex) {
  const row = Math.floor((queryIndex * vectorCount) / queryCount);
  return vectors.subarray(row * dimensions, (row + 1) * dimensions);
}

function payloadView(view) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

async function uploadIndex(client, precision, vectors) {
  const started = performance.now();
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
        itemKey: `ITEM-${row + 1}`,
        chunkId: 0,
        language: row % 7 === 0 ? "zh" : "en",
      };
    });
    const slice = vectors.subarray(start * dimensions, end * dimensions);
    await client.request(
      "snapshot.batch",
      { precision, dimensions, rows },
      payloadView(slice),
    );
  }
  const committed = await client.request("snapshot.commit");
  assert.equal(committed.header.vectors, vectorCount);
  return {
    uploadMs: performance.now() - started,
    deviceBytes: Number(committed.header.deviceBytes),
  };
}

async function searchGpu(client, precision, query) {
  const frame = await client.request(
    "search",
    {
      precision,
      dimensions,
      topK,
      groupByItem: false,
      maxChunksPerItem: 3,
      language: "all",
      libraryID: 1,
      minScore: -1,
    },
    payloadView(query),
  );
  return frame.header.results;
}

function assertEquivalent(cpu, gpu, label) {
  const cpuIdentities = cpu.map((row) => [row.itemKey, row.chunkId]);
  const gpuIdentities = gpu.map((row) => [row.itemKey, row.chunkId]);
  const identity = (row) => `${row.itemKey}:${row.chunkId}`;
  const cpuByIdentity = new Map(cpu.map((row) => [identity(row), row]));
  const gpuByIdentity = new Map(gpu.map((row) => [identity(row), row]));
  if (JSON.stringify(cpuIdentities) !== JSON.stringify(gpuIdentities)) {
    const cpuSet = new Set(cpuIdentities.map((value) => value.join(":")));
    const gpuSet = new Set(gpuIdentities.map((value) => value.join(":")));
    assert.deepEqual(
      gpuSet,
      cpuSet,
      `${label} TopK differs outside a tied score boundary`,
    );
    for (let index = 0; index < cpu.length; index++) {
      if (identity(cpu[index]) === identity(gpu[index])) continue;
      const cpuScoreForGpuRow = cpuByIdentity.get(identity(gpu[index])).score;
      const gpuScoreForCpuRow = gpuByIdentity.get(identity(cpu[index])).score;
      assert.ok(
        Math.abs(cpu[index].score - cpuScoreForGpuRow) <= scoreTolerance ||
          Math.abs(gpu[index].score - gpuScoreForCpuRow) <= scoreTolerance,
        `${label} rank ${index + 1} changed outside a tied score boundary`,
      );
    }
  }
  let maxScoreError = 0;
  for (const cpuRow of cpu) {
    const gpuRow = gpuByIdentity.get(identity(cpuRow));
    maxScoreError = Math.max(
      maxScoreError,
      Math.abs(cpuRow.score - gpuRow.score),
    );
  }
  assert.ok(
    maxScoreError <= scoreTolerance,
    `${label} max score error ${maxScoreError} exceeds ${scoreTolerance}`,
  );
  return maxScoreError;
}

const generationStarted = performance.now();
const index = createIndex();
const generationMs = performance.now() - generationStarted;
const client = new GpuClient();
let cpuIndex;

try {
  cpuIndex = createCpuVectorStore(index);
  const startupStarted = performance.now();
  const hello = await client.request("hello", {
    expectedProtocol: GPU_PROTOCOL_VERSION,
  });
  const startupMs = performance.now() - startupStarted;

  const floatUpload = await uploadIndex(client, "float32", index.float32);
  for (let warmup = 0; warmup < warmupCount; warmup++) {
    const query = queryAt(index.float32, warmup % queryCount);
    await searchCpu(cpuIndex.store, "float32", query);
    await searchGpu(client, "float32", query);
  }

  const floatCpuTimes = [];
  const floatGpuTimes = [];
  const floatCpuResults = [];
  let maxFloat32Error = 0;
  for (let queryIndex = 0; queryIndex < queryCount; queryIndex++) {
    const query = queryAt(index.float32, queryIndex);
    let started = performance.now();
    const cpu = await searchCpu(cpuIndex.store, "float32", query);
    floatCpuTimes.push(performance.now() - started);
    floatCpuResults.push(cpu);
    started = performance.now();
    const gpu = await searchGpu(client, "float32", query);
    floatGpuTimes.push(performance.now() - started);
    maxFloat32Error = Math.max(
      maxFloat32Error,
      assertEquivalent(cpu, gpu, "Float32 CPU/GPU"),
    );
  }

  const int8Upload = await uploadIndex(client, "int8", index.int8);
  for (let warmup = 0; warmup < warmupCount; warmup++) {
    const query = queryAt(index.float32, warmup % queryCount);
    await searchCpu(cpuIndex.store, "int8", query);
    await searchGpu(
      client,
      "int8",
      queryAt(index.int8, warmup % queryCount),
    );
  }

  const int8CpuTimes = [];
  const int8GpuTimes = [];
  let maxInt8Error = 0;
  let recallTotal = 0;
  let scoreDriftTotal = 0;
  let scoreDriftCount = 0;
  for (let queryIndex = 0; queryIndex < queryCount; queryIndex++) {
    const query = queryAt(index.float32, queryIndex);
    let started = performance.now();
    const cpu = await searchCpu(cpuIndex.store, "int8", query);
    int8CpuTimes.push(performance.now() - started);
    started = performance.now();
    const gpu = await searchGpu(
      client,
      "int8",
      queryAt(index.int8, queryIndex),
    );
    int8GpuTimes.push(performance.now() - started);
    maxInt8Error = Math.max(
      maxInt8Error,
      assertEquivalent(cpu, gpu, "Int8 CPU/GPU"),
    );

    const floatResults = floatCpuResults[queryIndex];
    const floatByItem = new Map(
      floatResults.map((row) => [row.itemKey, row.score]),
    );
    const overlap = cpu.filter((row) => floatByItem.has(row.itemKey));
    recallTotal += overlap.length / topK;
    for (const row of overlap) {
      scoreDriftTotal += Math.abs(row.score - floatByItem.get(row.itemKey));
      scoreDriftCount += 1;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    seed: "0x5a17c9e3",
    device: hello.header.device,
    totalMemoryBytes: hello.header.totalMemoryBytes,
    freeMemoryBytesAtStart: hello.header.freeMemoryBytes,
    vectors: vectorCount,
    dimensions,
    warmups: warmupCount,
    queries: queryCount,
    topK,
    generationMs,
    cpuIndexLoadMs: cpuIndex.loadMs,
    cpuDatabaseBytes: cpuIndex.databaseBytes,
    startupMs,
    uploadMs: {
      float32: floatUpload.uploadMs,
      int8: int8Upload.uploadMs,
    },
    deviceBytes: {
      float32: floatUpload.deviceBytes,
      int8: int8Upload.deviceBytes,
    },
    latencyMs: {
      cpuFloat32: statistics(floatCpuTimes),
      gpuFloat32: statistics(floatGpuTimes),
      cpuInt8: statistics(int8CpuTimes),
      gpuInt8: statistics(int8GpuTimes),
    },
    correctness: {
      maxFloat32CpuGpuScoreError: maxFloat32Error,
      maxInt8CpuGpuScoreError: maxInt8Error,
      int8RecallAt20VsFloat32: recallTotal / queryCount,
      meanInt8ScoreDriftVsFloat32:
        scoreDriftCount === 0 ? null : scoreDriftTotal / scoreDriftCount,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.latencyMs.cpuFloat32.p95 < 8000);
  assert.ok(report.latencyMs.cpuInt8.p95 < 8000);
  assert.ok(report.latencyMs.gpuFloat32.p95 < 8000);
  assert.ok(report.latencyMs.gpuInt8.p95 < 8000);
} finally {
  cpuIndex?.close();
  await client.close();
}
