/* eslint-env node */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { GPU_PROTOCOL_VERSION, GpuFrameDecoder, encodeGpuFrame } = await import(
  "../src/modules/semantic/gpuVectorProtocol.ts"
);
const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const databasePath =
  process.env.VECTOR_GPU_DATABASE ||
  "D:\\BaiduSyncdisk\\ZoteroFile\\zotero-mcp-vectors.sqlite";
const executable =
  process.env.VECTOR_GPU_EXE ||
  path.join(projectDirectory, "addon", "native", "gpu", "vector-gpu.exe");
const runtimeDirectory = path.dirname(executable);
const batchSize = 2048;
const queryCount = 10;
const topK = 20;

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)];
}

function statistics(values) {
  return {
    min: Math.min(...values),
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function parseIdentity(storageKey) {
  const match = /^(\d+):(.+)$/.exec(storageKey);
  return match
    ? { libraryID: Number(match[1]), itemKey: match[2] }
    : { libraryID: 1, itemKey: storageKey };
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

  request(type, fields = {}, payload = new Uint8Array(0), timeoutMs = 60000) {
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
        await this.request("shutdown", {}, new Uint8Array(0), 2000);
      } finally {
        this.child.stdin.end();
      }
    }
  }
}

function searchCpu(index, query) {
  let queryNormSquared = 0;
  for (let column = 0; column < index.dimensions; column++) {
    queryNormSquared += query[column] * query[column];
  }
  const heap = [];
  const siftUp = (start) => {
    let position = start;
    while (position > 0) {
      const parent = (position - 1) >> 1;
      if (heap[parent].score <= heap[position].score) break;
      [heap[parent], heap[position]] = [heap[position], heap[parent]];
      position = parent;
    }
  };
  const siftDown = () => {
    let position = 0;
    for (;;) {
      const left = position * 2 + 1;
      const right = left + 1;
      let smallest = position;
      if (left < heap.length && heap[left].score < heap[smallest].score) {
        smallest = left;
      }
      if (right < heap.length && heap[right].score < heap[smallest].score) {
        smallest = right;
      }
      if (smallest === position) break;
      [heap[position], heap[smallest]] = [heap[smallest], heap[position]];
      position = smallest;
    }
  };

  for (let row = 0; row < index.rows.length; row++) {
    if (index.rows[row].libraryID !== 1) continue;
    let dot = 0;
    let vectorNormSquared = 0;
    const vectorOffset = row * index.dimensions;
    for (let column = 0; column < index.dimensions; column++) {
      const value = index.vectors[vectorOffset + column];
      dot += query[column] * value;
      vectorNormSquared += value * value;
    }
    const denominator = Math.sqrt(queryNormSquared * vectorNormSquared);
    const result = {
      ...index.rows[row],
      score: denominator === 0 ? 0 : dot / denominator,
    };
    if (heap.length < topK) {
      heap.push(result);
      siftUp(heap.length - 1);
    } else if (result.score > heap[0].score) {
      heap[0] = result;
      siftDown();
    }
  }
  return heap.sort((left, right) => right.score - left.score);
}

function encodeBatch(index, start, end) {
  const payload = index.vectors.slice(
    start * index.dimensions,
    end * index.dimensions,
  );
  return {
    payload: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
    rows: index.rows.slice(start, end).map((row) => ({
      rowId: row.rowId,
      libraryID: row.libraryID,
      itemKey: row.itemKey,
      chunkId: row.chunkId,
      language: row.language,
      norm: row.norm,
    })),
  };
}

const databaseLoadStarted = performance.now();
const database = new DatabaseSync(databasePath, { readOnly: true });
const summary = database
  .prepare(
    "SELECT COUNT(*) AS total, MIN(dimensions) AS minDimensions, MAX(dimensions) AS maxDimensions, SUM(CASE WHEN vector_int8 IS NULL THEN 1 ELSE 0 END) AS missing FROM embeddings",
  )
  .get();
assert.equal(summary.missing, 0, "benchmark requires a complete Int8 index");
assert.equal(summary.minDimensions, summary.maxDimensions, "mixed dimensions");
const index = {
  dimensions: summary.minDimensions,
  rows: new Array(summary.total),
  vectors: new Int8Array(summary.total * summary.minDimensions),
};
let loaded = 0;
for (const row of database
  .prepare(
    "SELECT id, item_key, chunk_id, language, dimensions, vector_int8, vector_norm FROM embeddings ORDER BY id",
  )
  .iterate()) {
  const vector = Buffer.from(row.vector_int8, "base64");
  assert.equal(vector.length, index.dimensions);
  index.vectors.set(vector, loaded * index.dimensions);
  const identity = parseIdentity(row.item_key);
  index.rows[loaded] = {
    rowId: row.id,
    libraryID: identity.libraryID,
    itemKey: identity.itemKey,
    chunkId: row.chunk_id,
    language: row.language,
    norm: row.vector_norm,
  };
  loaded += 1;
}
database.close();
const databaseLoadMs = performance.now() - databaseLoadStarted;
assert.equal(loaded, summary.total);

const queries = Array.from({ length: queryCount }, (_, queryIndex) => {
  const row = Math.floor((queryIndex * index.rows.length) / queryCount);
  return index.vectors.slice(
    row * index.dimensions,
    (row + 1) * index.dimensions,
  );
});
const client = new GpuClient();

try {
  const startupStarted = performance.now();
  const hello = await client.request("hello", {
    expectedProtocol: GPU_PROTOCOL_VERSION,
  });
  const startupMs = performance.now() - startupStarted;

  const uploadStarted = performance.now();
  await client.request("snapshot.begin", {
    total: index.rows.length,
    dimensions: index.dimensions,
  });
  for (let start = 0; start < index.rows.length; start += batchSize) {
    const end = Math.min(index.rows.length, start + batchSize);
    const batch = encodeBatch(index, start, end);
    await client.request(
      "snapshot.batch",
      { dimensions: index.dimensions, rows: batch.rows },
      batch.payload,
    );
  }
  const committed = await client.request("snapshot.commit");
  const uploadMs = performance.now() - uploadStarted;
  assert.equal(committed.header.vectors, index.rows.length);

  searchCpu(index, queries[0]);
  await client.request(
    "search",
    {
      dimensions: index.dimensions,
      queryNorm: 1,
      topK,
      groupByItem: false,
      maxChunksPerItem: 3,
      language: "all",
      libraryID: 1,
      minScore: -1,
    },
    new Uint8Array(queries[0].buffer),
  );

  const cpuTimes = [];
  const gpuTimes = [];
  let maxScoreError = 0;
  for (const query of queries) {
    const cpuStarted = performance.now();
    const cpuResults = searchCpu(index, query);
    cpuTimes.push(performance.now() - cpuStarted);

    const gpuStarted = performance.now();
    const gpuFrame = await client.request(
      "search",
      {
        dimensions: index.dimensions,
        queryNorm: 1,
        topK,
        groupByItem: false,
        maxChunksPerItem: 3,
        language: "all",
        libraryID: 1,
        minScore: -1,
      },
      new Uint8Array(query.buffer, query.byteOffset, query.byteLength),
    );
    gpuTimes.push(performance.now() - gpuStarted);
    const gpuResults = gpuFrame.header.results;
    assert.deepEqual(
      gpuResults.map((row) => [row.libraryID, row.itemKey, row.chunkId]),
      cpuResults.map((row) => [row.libraryID, row.itemKey, row.chunkId]),
      "CPU and GPU TopK identities differ",
    );
    for (let index = 0; index < cpuResults.length; index++) {
      const error = Math.abs(cpuResults[index].score - gpuResults[index].score);
      maxScoreError = Math.max(maxScoreError, error);
      assert.ok(error <= 1e-6, `score error ${error} exceeds tolerance`);
    }
  }

  const cpu = statistics(cpuTimes);
  const gpu = statistics(gpuTimes);
  const report = {
    generatedAt: new Date().toISOString(),
    databasePath,
    device: hello.header.device,
    vectors: index.rows.length,
    dimensions: index.dimensions,
    queries: queryCount,
    topK,
    databaseLoadMs,
    startupMs,
    uploadMs,
    deviceBytes: committed.header.deviceBytes,
    maxScoreError,
    cpuMs: cpu,
    gpuMs: gpu,
    gpuToCpuRatio: gpu.avg / cpu.avg,
    acceptancePassed: gpu.avg <= cpu.avg * 0.5,
  };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(
    report.acceptancePassed,
    true,
    "GPU average latency must be no more than 50% of CPU",
  );
} finally {
  await client.close();
}
