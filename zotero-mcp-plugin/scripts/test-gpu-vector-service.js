/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.ztoolkit = { log: () => {} };

const { GpuVectorService } = await import(
  "../src/modules/semantic/gpuVectorService.ts"
);

const response = (fields = {}) => ({
  header: {
    protocol: "vector-gpu/1",
    type: "response",
    requestId: "fake",
    ok: true,
    ...fields,
  },
  payload: new Uint8Array(0),
});

const rows = [{
  rowId: 11,
  libraryID: 1,
  itemKey: "ITEM",
  chunkId: 0,
  language: "en",
  dimensions: 4,
  norm: 127,
  vector: new Int8Array([127, 0, 0, 0]),
}];

{
  let enabled = false;
  let extracts = 0;
  let stopped = 0;
  let service;
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
      if (type === "hello") return response({ device: "RTX Test" });
      if (type === "snapshot.commit") return response({ vectors: 1 });
      if (type === "search") {
        return response({
          scanned: 1,
          results: [{
            libraryID: 1,
            itemKey: "ITEM",
            chunkId: 0,
            score: 1,
            rowId: 11,
            language: "en",
          }],
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
    getSnapshotInfo: async () => ({ total: 1, dimensions: 4 }),
    readSnapshotBatch: async (afterRowId) => afterRowId === 0 ? rows : [],
    readItems: async () => rows,
  });

  await service.setEnabled(true);
  await service.setEnabled(true);
  assert.equal(extracts, 1, "re-enabling an available session does not extract twice");
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

  const stats = {};
  const result = await service.search({
    query: new Int8Array([127, 0, 0, 0]),
    queryNorm: 127,
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

  await service.setEnabled(false);
  assert.equal(stopped, 1);
  assert.equal(service.getStatus().phase, "disabled");
}

{
  let enabled = false;
  let notifications = 0;
  const service = new GpuVectorService({
    readPreference: () => enabled,
    writePreference: (value) => {
      enabled = value;
    },
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
    getSnapshotInfo: async () => ({ total: 0, dimensions: 0 }),
    readSnapshotBatch: async () => [],
    readItems: async () => [],
  });
  await assert.rejects(service.setEnabled(true), /No NVIDIA device/);
  assert.equal(enabled, true, "fallback keeps the preference enabled");
  assert.equal(service.isEnabled(), false, "the failed session is fused off");
  assert.equal(service.getStatus().phase, "fallback");
  assert.equal(service.getStatus().code, "NO_CUDA_DEVICE");
  assert.equal(notifications, 1);
}

console.log("GPU vector service tests passed");
