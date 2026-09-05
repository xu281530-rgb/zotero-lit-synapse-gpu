/* eslint-env node */

/**
 * End-to-end check that a real index update refreshes the settings panel.
 *
 * The unit tests in test-gpu-vector-service.js drive a stubbed worker. This one
 * runs the shipped vector-gpu.exe on the actual GPU and asserts that every
 * incremental upsert, delete and rebuild pushes a fresh resident-vector count
 * plus a sync timestamp to the same subscription the preferences pane uses — the
 * path that previously left the panel showing the counts captured at snapshot
 * commit time until it was closed and reopened.
 *
 * Requires an NVIDIA GPU. Skips (exit 0) when the worker cannot start, so it
 * behaves on a CPU-only machine the way the plugin does.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.ztoolkit = { log: () => {} };

const { GPU_PROTOCOL_VERSION, GpuFrameDecoder, encodeGpuFrame } = await import(
  "../src/modules/semantic/gpuVectorProtocol.ts"
);
const { GpuVectorService } = await import(
  "../src/modules/semantic/gpuVectorService.ts"
);

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const executable =
  process.env.VECTOR_GPU_EXE ||
  path.join(projectDirectory, "addon", "native", "gpu", "vector-gpu.exe");
const runtimeDirectory =
  process.env.VECTOR_GPU_RUNTIME_DIR ||
  path.join(projectDirectory, "addon", "native", "gpu");

const LOCALES = ["en-US", "zh-CN", "de-DE", "es-ES", "fr-FR", "ja-JP"];

/** Minimal stdio client, the same framing the plugin's Subprocess pipe uses. */
class NativeWorker {
  constructor() {
    this.decoder = new GpuFrameDecoder();
    this.pending = new Map();
    this.nextRequestId = 1;
    this.stopped = false;
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
          request.reject(
            Object.assign(
              new Error(String(frame.header.message || "Native GPU error")),
              { code: frame.header.code },
            ),
          );
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

  request(type, fields = {}, payload = new Uint8Array(0), timeoutMs = 20000) {
    const requestId = `sync-refresh-${this.nextRequestId++}`;
    const frame = encodeGpuFrame(
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
      this.child.stdin.write(frame);
    });
  }

  async stop() {
    // The service stops the worker during shutdown and the test's cleanup runs
    // unconditionally, so a second stop must be a no-op rather than a write to
    // a closed pipe.
    if (this.stopped) return;
    this.stopped = true;
    if (this.child.exitCode === null) {
      try {
        await this.request("shutdown", {}, new Uint8Array(0), 5000);
      } catch {
        // A worker that already died needs no polite shutdown.
      } finally {
        this.child.stdin.end();
      }
    }
  }
}

const DIMENSIONS = 8;

/** A stand-in semantic index: the rows a real VectorStore would hand over. */
class FakeIndex {
  constructor() {
    this.rows = [];
    this.nextRowId = 1;
    for (let item = 0; item < 6; item++) {
      this.setItem(1, `ITEM${item}`, 4);
    }
  }

  setItem(libraryID, itemKey, chunkCount) {
    this.rows = this.rows.filter(
      (row) => !(row.libraryID === libraryID && row.itemKey === itemKey),
    );
    for (let chunk = 0; chunk < chunkCount; chunk++) {
      const vector = new Int8Array(DIMENSIONS);
      for (let index = 0; index < DIMENSIONS; index++) {
        vector[index] = ((this.nextRowId + index * 7) % 127) - 63 || 11;
      }
      this.rows.push({
        rowId: this.nextRowId++,
        libraryID,
        itemKey,
        chunkId: chunk,
        language: "en",
        dimensions: DIMENSIONS,
        vector,
      });
    }
    this.rows.sort((left, right) => left.rowId - right.rowId);
  }

  deleteItem(libraryID, itemKey) {
    this.rows = this.rows.filter(
      (row) => !(row.libraryID === libraryID && row.itemKey === itemKey),
    );
  }

  clearAll() {
    this.rows = [];
  }

  get total() {
    return this.rows.length;
  }
}

const index = new FakeIndex();
let worker = null;

const service = new GpuVectorService({
  readPreference: () => true,
  writePreference: () => {},
  readPrecision: () => "int8",
  writePrecision: () => {},
  assertPlatform: () => {},
  extractAssets: async () => ({
    directory: runtimeDirectory,
    executable,
    manifest: {},
  }),
  launchProcess: async () => {
    worker = new NativeWorker();
    return worker;
  },
  notifyFallback: () => {},
});

service.registerProvider({
  getSnapshotInfo: async () => ({
    total: index.total,
    dimensions: DIMENSIONS,
    float32Count: 0,
    int8Count: index.total,
  }),
  readSnapshotBatch: async (afterRowId, limit) =>
    index.rows.filter((row) => row.rowId > afterRowId).slice(0, limit),
  readItems: async (identities) =>
    index.rows.filter((row) =>
      identities.some(
        (identity) =>
          identity.libraryID === row.libraryID &&
          identity.itemKey === row.itemKey,
      ),
    ),
});

// Exactly what the preferences pane subscribes to.
const rendered = [];
service.subscribe((status) => rendered.push({ ...status }));

try {
  await service.startIfEnabled();
} catch (error) {
  console.log(
    `Skipping GPU sync refresh test: worker unavailable (${error?.code || error})`,
  );
  await worker?.stop();
  process.exit(0);
}

try {
  assert.equal(service.getStatus().phase, "available");
  assert.equal(
    service.getStatus().vectors,
    24,
    "the loaded snapshot reports every resident vector",
  );
  assert.equal(
    service.getStatus().lastSyncedAt,
    undefined,
    "an initial load is a load, not an incremental sync",
  );

  // Incremental update: one item grows from 4 chunks to 7.
  const beforeUpsert = rendered.length;
  index.setItem(1, "ITEM0", 7);
  await service.publishMutation({
    kind: "itemChanged",
    libraryID: 1,
    itemKey: "ITEM0",
  });
  assert.ok(
    rendered.length > beforeUpsert,
    "the panel subscription is notified without being reopened",
  );
  assert.equal(
    service.getStatus().vectors,
    index.total,
    "an incremental update republishes the resident count",
  );
  assert.equal(service.getStatus().vectors, 27);
  assert.ok(service.getStatus().deviceBytes > 0);
  const afterUpsertSyncedAt = service.getStatus().lastSyncedAt;
  assert.ok(
    typeof afterUpsertSyncedAt === "number",
    "an incremental update stamps a sync time",
  );

  // Delete.
  index.deleteItem(1, "ITEM1");
  await service.publishMutation({
    kind: "itemsDeleted",
    items: [{ libraryID: 1, itemKey: "ITEM1" }],
  });
  assert.equal(
    service.getStatus().vectors,
    index.total,
    "a delete republishes the resident count",
  );
  assert.equal(service.getStatus().vectors, 23);
  assert.ok(service.getStatus().lastSyncedAt >= afterUpsertSyncedAt);

  // Rebuild: everything is dropped before the fresh index is written.
  index.clearAll();
  await service.publishMutation({ kind: "allCleared" });
  assert.equal(
    service.getStatus().vectors,
    0,
    "a rebuild republishes the emptied count",
  );
  assert.equal(service.getStatus().phase, "available");

  // Searching after all of that must still work rather than throw.
  const results = await service.search({
    query: new Float32Array(DIMENSIONS).fill(0.5),
    topK: 5,
    groupByItem: false,
    maxChunksPerItem: 3,
    language: "all",
    minScore: -1,
    libraryID: 1,
  });
  assert.deepEqual(results, [], "an emptied index searches to nothing");

  const counts = rendered
    .filter((status) => status.phase === "available")
    .map((status) => status.vectors);
  assert.deepEqual(
    counts,
    [24, 27, 23, 0],
    "the panel sees each count in order instead of one stale number",
  );

  for (const locale of LOCALES) {
    const ftl = await readFile(
      path.join(projectDirectory, "addon", "locale", locale, "preferences.ftl"),
      "utf8",
    );
    assert.ok(
      /^pref-hybrid-gpu-status-synced = .*\{ \$time \}/m.test(ftl),
      `${locale} must translate the sync hint`,
    );
  }
} finally {
  await service.shutdown();
  await worker?.stop();
}

console.log("GPU vector sync refresh tests passed");
