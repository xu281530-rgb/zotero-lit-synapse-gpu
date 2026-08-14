/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.ztoolkit = { log: () => {} };

const { GpuVectorService, chooseGpuPrecision, estimateGpuIndexBytes } =
  await import("../src/modules/semantic/gpuVectorService.ts");

const response = (fields = {}) => ({
  header: {
    protocol: "vector-gpu/2",
    type: "response",
    requestId: "fake",
    ok: true,
    ...fields,
  },
  payload: new Uint8Array(0),
});

const int8Rows = [
  {
    rowId: 11,
    libraryID: 1,
    itemKey: "ITEM",
    chunkId: 0,
    language: "en",
    dimensions: 4,
    vector: new Int8Array([127, 0, 0, 0]),
  },
];
const float32Rows = [
  {
    ...int8Rows[0],
    vector: new Float32Array([1, 0, 0, 0]),
  },
];

assert.equal(
  chooseGpuPrecision({
    preference: "auto",
    snapshot: {
      total: 90_000,
      dimensions: 1024,
      float32Count: 90_000,
      int8Count: 90_000,
    },
    totalMemoryBytes: 8 * 1024 ** 3,
    freeMemoryBytes: 7 * 1024 ** 3,
  }),
  "float32",
  "auto prefers Float32 when the resident index and reserve fit",
);
assert.equal(
  chooseGpuPrecision({
    preference: "auto",
    snapshot: {
      total: 90_000,
      dimensions: 1024,
      float32Count: 90_000,
      int8Count: 90_000,
    },
    totalMemoryBytes: 1024 ** 3,
    freeMemoryBytes: 650 * 1024 ** 2,
  }),
  "int8",
  "auto falls back to Int8 when only the compact index fits",
);
assert.ok(
  estimateGpuIndexBytes(90_000, 1024, "float32") >
    estimateGpuIndexBytes(90_000, 1024, "int8"),
);

{
  let enabled = false;
  let extracts = 0;
  let stopped = 0;
  let service;
  let precision = "auto";
  let queuedDuringSnapshot = false;
  const commands = [];
  const process = {
    request: async (type, fields, payload) => {
      commands.push({ type, fields, payload: [...(payload || [])] });
      if (type === "snapshot.batch" && !queuedDuringSnapshot) {
        queuedDuringSnapshot = true;
        await service.publishMutation({
          kind: "itemChanged",
          libraryID: 1,
          itemKey: "ITEM",
        });
      }
      if (type === "hello") {
        return response({
          device: "RTX Test",
          totalMemoryBytes: 8 * 1024 ** 3,
          freeMemoryBytes: 7 * 1024 ** 3,
        });
      }
      if (type === "snapshot.commit") {
        return response({ vectors: 1, deviceBytes: 4096 });
      }
      if (type === "search") {
        return response({
          scanned: 1,
          results: [
            {
              libraryID: 1,
              itemKey: "ITEM",
              chunkId: 0,
              score: 1,
              rowId: 11,
              language: "en",
            },
          ],
        });
      }
      return response();
    },
    stop: async () => {
      stopped += 1;
    },
  };
  service = new GpuVectorService({
    readPreference: () => enabled,
    writePreference: (value) => {
      enabled = value;
    },
    readPrecision: () => precision,
    writePrecision: (value) => {
      precision = value;
    },
    assertPlatform: () => {},
    extractAssets: async () => {
      extracts += 1;
      return {
        directory: "C:\\gpu",
        executable: "C:\\gpu\\vector-gpu.exe",
        manifest: {},
      };
    },
    launchProcess: async () => process,
    notifyFallback: () => {},
  });
  service.registerProvider({
    getSnapshotInfo: async () => ({
      total: 1,
      dimensions: 4,
      float32Count: 1,
      int8Count: 1,
    }),
    readSnapshotBatch: async (afterRowId, _limit, selectedPrecision) =>
      afterRowId === 0
        ? selectedPrecision === "float32"
          ? float32Rows
          : int8Rows
        : [],
    readItems: async (_items, selectedPrecision) =>
      selectedPrecision === "float32" ? float32Rows : int8Rows,
  });

  await service.setEnabled(true);
  await service.setEnabled(true);
  assert.equal(
    extracts,
    1,
    "re-enabling an available session does not extract twice",
  );
  assert.deepEqual(
    commands.slice(0, 5).map((entry) => entry.type),
    [
      "hello",
      "snapshot.begin",
      "snapshot.batch",
      "snapshot.commit",
      "index.upsert",
    ],
    "snapshot-time mutations replay after commit",
  );
  assert.equal(service.getStatus().phase, "available");
  assert.equal(service.getStatus().precision, "float32");
  assert.equal(service.getStatus().backend, "gpu");
  assert.equal(service.getStatus().deviceBytes, 4096);
  assert.equal(commands[1].fields.precision, "float32");

  const stats = {};
  const result = await service.search({
    query: new Float32Array([1, 0, 0, 0]),
    topK: 5,
    groupByItem: true,
    maxChunksPerItem: 3,
    language: "all",
    minScore: 0,
    libraryID: 1,
    stats,
  });
  assert.equal(result[0].itemKey, "ITEM");
  assert.equal(result[0].chunkText, "");
  assert.equal(stats.scanned, 1);

  service.queuedMutations.push({
    kind: "itemChanged",
    libraryID: 1,
    itemKey: "STALE",
  });
  await service.shutdown();
  assert.equal(service.queuedMutations.length, 0);
  assert.equal(stopped, 1, "shutdown waits for the worker to release GPU memory");

  await service.setEnabled(false);
  assert.equal(stopped, 1);
  assert.equal(service.getStatus().phase, "disabled");
}

{
  let enabled = true;
  let precision = "auto";
  let launches = 0;
  const snapshotPrecisions = [];
  const service = new GpuVectorService({
    readPreference: () => enabled,
    writePreference: (value) => {
      enabled = value;
    },
    readPrecision: () => precision,
    writePrecision: (value) => {
      precision = value;
    },
    assertPlatform: () => {},
    extractAssets: async () => ({
      directory: "C:\\gpu",
      executable: "C:\\gpu\\vector-gpu.exe",
      manifest: {},
    }),
    launchProcess: async () => {
      launches += 1;
      return {
        request: async (type, fields) => {
          if (type === "hello") {
            return response({
              device: "RTX Test",
              totalMemoryBytes: 8 * 1024 ** 3,
              freeMemoryBytes: 7 * 1024 ** 3,
            });
          }
          if (type === "snapshot.begin")
            snapshotPrecisions.push(fields.precision);
          if (type === "snapshot.batch" && fields.precision === "float32") {
            throw Object.assign(
              new Error("cudaMalloc vectors: out of memory"),
              {
                code: "OUT_OF_MEMORY",
              },
            );
          }
          if (type === "snapshot.commit") return response({ vectors: 1 });
          return response();
        },
        stop: async () => {},
      };
    },
    notifyFallback: () => {},
  });
  service.registerProvider({
    getSnapshotInfo: async () => ({
      total: 1,
      dimensions: 4,
      float32Count: 1,
      int8Count: 1,
    }),
    readSnapshotBatch: async (afterRowId, _limit, selectedPrecision) =>
      afterRowId === 0
        ? selectedPrecision === "float32"
          ? float32Rows
          : int8Rows
        : [],
    readItems: async () => [],
  });
  await service.startIfEnabled();
  assert.equal(
    launches,
    2,
    "auto relaunches once after a Float32 allocation OOM",
  );
  assert.deepEqual(snapshotPrecisions, ["float32", "int8"]);
  assert.equal(service.getStatus().precision, "int8");
}

{
  let launches = 0;
  let notifications = 0;
  const loadedPrecisions = [];
  const service = new GpuVectorService({
    readPreference: () => true,
    writePreference: () => {},
    readPrecision: () => "auto",
    writePrecision: () => {},
    assertPlatform: () => {},
    extractAssets: async () => ({
      directory: "C:\\gpu",
      executable: "C:\\gpu\\vector-gpu.exe",
      manifest: {},
    }),
    launchProcess: async () => {
      launches += 1;
      const launch = launches;
      return {
        request: async (type, fields) => {
          if (type === "hello") {
            return response({
              device: "RTX Test",
              totalMemoryBytes: 8 * 1024 ** 3,
              freeMemoryBytes: 7 * 1024 ** 3,
            });
          }
          if (type === "snapshot.begin") {
            loadedPrecisions.push(fields.precision);
          }
          if (type === "snapshot.commit") return response({ vectors: 1 });
          if (type === "index.upsert" && launch === 1) {
            throw Object.assign(new Error("capacity growth OOM"), {
              code: "OUT_OF_MEMORY",
            });
          }
          return response();
        },
        stop: async () => {},
      };
    },
    notifyFallback: () => {
      notifications += 1;
    },
  });
  service.registerProvider({
    getSnapshotInfo: async () => ({
      total: 1,
      dimensions: 4,
      float32Count: 1,
      int8Count: 1,
    }),
    readSnapshotBatch: async (afterRowId, _limit, selectedPrecision) =>
      afterRowId === 0
        ? selectedPrecision === "float32"
          ? float32Rows
          : int8Rows
        : [],
    readItems: async (_identities, selectedPrecision) =>
      selectedPrecision === "float32" ? float32Rows : int8Rows,
  });
  await service.startIfEnabled();
  assert.equal(service.getStatus().precision, "float32");
  await service.publishMutation({
    kind: "itemChanged",
    libraryID: 1,
    itemKey: "A",
  });
  assert.equal(launches, 2, "incremental Float32 OOM relaunches the worker");
  assert.deepEqual(loadedPrecisions, ["float32", "int8"]);
  assert.equal(service.getStatus().phase, "available");
  assert.equal(service.getStatus().precision, "int8");
  assert.equal(notifications, 0, "successful Int8 retry must not report CPU fallback");
}

{
  let enabled = false;
  let notifications = 0;
  const service = new GpuVectorService({
    readPreference: () => enabled,
    writePreference: (value) => {
      enabled = value;
    },
    readPrecision: () => "float32",
    writePrecision: () => {},
    assertPlatform: () => {
      throw Object.assign(new Error("No NVIDIA device"), {
        code: "NO_CUDA_DEVICE",
      });
    },
    extractAssets: async () => {
      throw new Error("unreachable");
    },
    launchProcess: async () => {
      throw new Error("unreachable");
    },
    notifyFallback: () => {
      notifications += 1;
    },
  });
  service.registerProvider({
    getSnapshotInfo: async () => ({
      total: 0,
      dimensions: 0,
      float32Count: 0,
      int8Count: 0,
    }),
    readSnapshotBatch: async () => [],
    readItems: async () => [],
  });
  await assert.rejects(service.setEnabled(true), /No NVIDIA device/);
  assert.equal(enabled, true, "fallback keeps the preference enabled");
  assert.equal(service.isEnabled(), false, "the failed session is fused off");
  assert.equal(service.getStatus().phase, "fallback");
  assert.equal(service.getStatus().code, "NO_CUDA_DEVICE");
  assert.equal(service.getCpuFallbackPrecision(), "float32");
  assert.equal(notifications, 1);
}

console.log("GPU vector service tests passed");
