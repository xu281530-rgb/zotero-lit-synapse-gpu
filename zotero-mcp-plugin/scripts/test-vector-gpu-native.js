/* eslint-env node */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { GPU_PROTOCOL_VERSION, GpuFrameDecoder, encodeGpuFrame } = await import(
  "../src/modules/semantic/gpuVectorProtocol.ts"
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

class NativeGpuClient {
  constructor() {
    this.decoder = new GpuFrameDecoder();
    this.pending = new Map();
    this.nextRequestId = 1;
    this.stderr = "";
    this.child = spawn(executable, ["--stdio"], {
      cwd: runtimeDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk) => {
      for (const frame of this.decoder.push(chunk)) {
        const request = this.pending.get(frame.header.requestId);
        if (!request) continue;
        this.pending.delete(frame.header.requestId);
        if (frame.header.ok === false) {
          const error = Object.assign(
            new Error(String(frame.header.message || "Native GPU error")),
            { code: frame.header.code },
          );
          request.reject(error);
        } else {
          request.resolve(frame);
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
          new Error(
            `vector-gpu.exe exited with code ${code}: ${this.stderr.trim()}`,
          ),
        );
      }
    });
  }

  rejectAll(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  request(type, fields = {}, payload = new Uint8Array(0)) {
    const requestId = `native-test-${this.nextRequestId++}`;
    const frame = encodeGpuFrame(
      { protocol: GPU_PROTOCOL_VERSION, type, requestId, ...fields },
      payload,
    );
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 15000);
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
      this.child.stdin.write(frame);
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

function encodeRows(rows) {
  const dimensions = rows[0]?.vector.length ?? 0;
  const payload = new Uint8Array(rows.length * dimensions);
  const metadata = rows.map((row, index) => {
    payload.set(new Uint8Array(row.vector.buffer), index * dimensions);
    return {
      rowId: row.rowId,
      libraryID: row.libraryID,
      itemKey: row.itemKey,
      chunkId: row.chunkId,
      language: row.language,
      norm: row.norm,
    };
  });
  return { dimensions, rows: metadata, payload };
}

function cosineInt8(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

const vectors = [
  {
    rowId: 1,
    libraryID: 1,
    itemKey: "DUP",
    chunkId: 0,
    language: "en",
    norm: 1,
    vector: new Int8Array([127, 0, 0, 0]),
  },
  {
    rowId: 2,
    libraryID: 2,
    itemKey: "DUP",
    chunkId: 0,
    language: "en",
    norm: 1,
    vector: new Int8Array([-127, 0, 0, 0]),
  },
  {
    rowId: 3,
    libraryID: 1,
    itemKey: "DOC",
    chunkId: 0,
    language: "en",
    norm: Math.SQRT2,
    vector: new Int8Array([127, 127, 0, 0]),
  },
  {
    rowId: 4,
    libraryID: 1,
    itemKey: "DOC",
    chunkId: 1,
    language: "zh",
    norm: 1,
    vector: new Int8Array([0, 127, 0, 0]),
  },
  {
    rowId: 5,
    libraryID: 1,
    itemKey: "TIE_A",
    chunkId: 0,
    language: "en",
    norm: Math.SQRT2,
    vector: new Int8Array([64, 64, 0, 0]),
  },
  {
    rowId: 6,
    libraryID: 1,
    itemKey: "TIE_B",
    chunkId: 0,
    language: "en",
    norm: Math.SQRT2,
    vector: new Int8Array([64, 64, 0, 0]),
  },
];
const query = new Int8Array([127, 0, 0, 0]);
const client = new NativeGpuClient();

try {
  const hello = await client.request("hello", {
    expectedProtocol: GPU_PROTOCOL_VERSION,
  });
  assert.equal(hello.header.protocolVersion, GPU_PROTOCOL_VERSION);
  assert.equal(typeof hello.header.device, "string");

  const snapshot = encodeRows(vectors);
  await client.request("snapshot.begin", {
    total: vectors.length,
    dimensions: snapshot.dimensions,
  });
  await client.request(
    "snapshot.batch",
    { dimensions: snapshot.dimensions, rows: snapshot.rows },
    snapshot.payload,
  );
  const committed = await client.request("snapshot.commit");
  assert.equal(committed.header.vectors, vectors.length);
  assert.ok(committed.header.deviceBytes > 0);

  const searched = await client.request(
    "search",
    {
      dimensions: query.length,
      queryNorm: 1,
      topK: 10,
      groupByItem: false,
      maxChunksPerItem: 3,
      language: "all",
      libraryID: 1,
      minScore: -1,
    },
    new Uint8Array(query.buffer),
  );
  assert.equal(searched.header.scanned, 5);
  assert.deepEqual(
    searched.header.results.map((row) => [
      row.libraryID,
      row.itemKey,
      row.chunkId,
      row.rowId,
      row.language,
    ]),
    [
      [1, "DUP", 0, 1, "en"],
      [1, "TIE_A", 0, 5, "en"],
      [1, "DOC", 0, 3, "en"],
      [1, "TIE_B", 0, 6, "en"],
      [1, "DOC", 1, 4, "zh"],
    ],
    "native top-K ordering and location fields must match the CPU scan",
  );
  for (const result of searched.header.results) {
    const source = vectors.find((row) => row.rowId === result.rowId);
    assert.ok(source);
    assert.ok(
      Math.abs(result.score - cosineInt8(query, source.vector)) <= 1e-6,
      `row ${result.rowId} score must use the CPU Int8 cosine formula`,
    );
  }

  const grouped = await client.request(
    "search",
    {
      dimensions: query.length,
      queryNorm: 1,
      topK: 100,
      groupByItem: true,
      documentLimit: 2,
      maxChunksPerItem: 2,
      language: "all",
      libraryID: 1,
      minScore: -1,
    },
    new Uint8Array(query.buffer),
  );
  assert.deepEqual(
    grouped.header.results.map((row) => row.itemKey),
    ["DUP", "DOC", "DOC"],
  );

  const replacement = encodeRows([
    {
      rowId: 10,
      libraryID: 1,
      itemKey: "DOC",
      chunkId: 9,
      language: "en",
      norm: 1,
      vector: new Int8Array([-127, 0, 0, 0]),
    },
  ]);
  await client.request(
    "index.upsert",
    {
      dimensions: replacement.dimensions,
      item: { libraryID: 1, itemKey: "DOC" },
      rows: replacement.rows,
    },
    replacement.payload,
  );
  const replaced = await client.request(
    "search",
    {
      dimensions: query.length,
      queryNorm: 1,
      topK: 10,
      groupByItem: false,
      maxChunksPerItem: 3,
      language: "all",
      itemKeys: ["DOC"],
      libraryID: 1,
      minScore: -1,
    },
    new Uint8Array(query.buffer),
  );
  assert.deepEqual(
    replaced.header.results.map((row) => [row.chunkId, row.score]),
    [[9, -1]],
  );

  await client.request("index.delete", {
    items: [{ libraryID: 1, itemKey: "DUP" }],
  });
  const otherLibrary = await client.request(
    "search",
    {
      dimensions: query.length,
      queryNorm: 1,
      topK: 10,
      groupByItem: false,
      maxChunksPerItem: 3,
      language: "all",
      itemKeys: ["DUP"],
      libraryID: 2,
      minScore: -1,
    },
    new Uint8Array(query.buffer),
  );
  assert.deepEqual(
    otherLibrary.header.results.map((row) => [row.libraryID, row.itemKey]),
    [[2, "DUP"]],
    "deleting one library must preserve an identical item key in another",
  );

  await client.request("index.clear", { libraryID: 1 });
  const cleared = await client.request(
    "search",
    {
      dimensions: query.length,
      queryNorm: 1,
      topK: 10,
      groupByItem: false,
      maxChunksPerItem: 3,
      language: "all",
      libraryID: 1,
      minScore: -1,
    },
    new Uint8Array(query.buffer),
  );
  assert.deepEqual(cleared.header.results, []);
} finally {
  await client.close();
}

console.log("Native GPU vector protocol and consistency tests passed");
