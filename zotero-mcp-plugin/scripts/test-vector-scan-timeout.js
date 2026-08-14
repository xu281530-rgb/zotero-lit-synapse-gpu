/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const { runVectorScanBenchmark } = await import(
  "../src/modules/semantic/vectorScanBenchmark.ts"
);
const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const vectorBytes = (vector) =>
  new Uint8Array(
    vector.buffer.slice(
      vector.byteOffset,
      vector.byteOffset + vector.byteLength,
    ),
  );

// The benchmark is a fixed ten-run, serial operation. The clock values are
// independent known inputs, so the expected statistics are not recomputed by
// the implementation under test.
{
  const clock = [
    0, 2, 10, 14, 20, 26, 30, 38, 40, 50, 60, 72, 80, 94, 100, 116, 120, 138,
    140, 160,
  ];
  let clockIndex = 0;
  let active = 0;
  let maxActive = 0;
  let scans = 0;
  const result = await runVectorScanBenchmark(
    async () => {
      scans += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    },
    () => clock[clockIndex++],
  );

  assert.equal(scans, 10);
  assert.equal(maxActive, 1);
  assert.deepEqual(result.durationsMs, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  assert.equal(result.minMs, 2);
  assert.equal(result.averageMs, 11);
  assert.equal(result.maxMs, 20);
}

// The Preferences control uses the public read-only benchmark and only saves
// its ceiling after a successful run.
{
  const preferenceSource = fs.readFileSync(
    path.join(root, "src/modules/preferenceScript.ts"),
    "utf8",
  );
  const xhtml = fs.readFileSync(
    path.join(root, "addon/content/preferences.xhtml"),
    "utf8",
  );
  assert.match(
    xhtml,
    /id="zotero-prefpane-__addonRef__-hybrid-search-timeout"/,
  );
  assert.match(xhtml, /id="hybrid-scan-benchmark-button"/);
  assert.match(xhtml, /id="hybrid-scan-benchmark-result"/);
  assert.match(
    preferenceSource,
    /benchmarkLibraryScan\(\s*Zotero\.Libraries\.userLibraryID/,
  );
  assert.match(preferenceSource, /setSearchTimeoutMs\(result\.maxMs\)/);
  assert.match(preferenceSource, /benchmarkButton\.disabled = true/);
  assert.match(
    preferenceSource,
    /finally[\s\S]*?benchmarkButton\.disabled = false/,
  );
}

// The Preferences benchmark obtains one vector seed, then invokes the exact
// read-only full-Library search path ten times without hydrating chunk text.
{
  const sqlCalls = [];
  const db = {
    queryAsync: async (sql) => {
      sqlCalls.push(sql);
      if (sql.includes("JOIN vectors_f32")) {
        return [
          { dimensions: 2, vector: vectorBytes(new Float32Array([1, 0])) },
        ];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const store = new VectorStore();
  store.initialized = true;
  store.db = db;
  const scanOptions = [];
  store.search = async (_seed, options) => {
    scanOptions.push(options);
    return [];
  };

  const result = await store.benchmarkLibraryScan(1);
  assert.equal(result.runs, 10);
  assert.equal(scanOptions.length, 10);
  assert.ok(
    scanOptions.every(
      (options) =>
        options.libraryID === 1 &&
        options.groupByItem === true &&
        options.documentLimit === undefined &&
        options.includeChunkText === false &&
        options.itemKeys === undefined,
    ),
  );
  assert.ok(
    sqlCalls.every((sql) => !/chunk_text|INSERT|UPDATE|DELETE/i.test(sql)),
  );
}

// Cancellation must reach the live SQLite row callback. Once search rejects,
// the mocked reader is cancelled and cannot continue producing background
// rows.
{
  let cancelCalls = 0;
  let emittedRows = 0;
  let completedInBackground = false;
  const db = {
    valueQueryAsync: async (sql) => {
      if (sql.includes("vector_int8 IS NOT NULL")) return 0;
      if (sql.includes("COUNT(*) FROM embeddings")) return 2;
      throw new Error(`Unexpected value query: ${sql}`);
    },
    queryAsync: async (sql, _params = [], options = {}) => {
      void _params;
      if (sql.includes("SELECT dimensions, vector_int8 IS NOT NULL")) {
        return [{ dimensions: 2, has_int8: 0 }];
      }
      if (!sql.includes("ORDER BY id LIMIT ? OFFSET ?")) {
        throw new Error(`Unexpected query: ${sql}`);
      }

      return new Promise((resolve) => {
        let cancelled = false;
        const cancel = () => {
          cancelCalls += 1;
          cancelled = true;
          resolve([]);
        };
        const emit = (id) => {
          if (cancelled) return;
          emittedRows += 1;
          options.onRow?.(
            {
              id,
              item_key: `ITEM${id}`,
              chunk_id: 0,
              language: "en",
              dimensions: 2,
              vector_f32: new Uint8Array(new Float32Array([1, 0]).buffer),
            },
            cancel,
          );
        };
        setTimeout(() => emit(1), 5);
        setTimeout(() => emit(2), 25);
        setTimeout(() => {
          if (!cancelled) {
            completedInBackground = true;
            resolve([]);
          }
        }, 45);
      });
    },
  };
  const store = new VectorStore();
  store.initialized = true;
  store.db = db;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 12);

  await assert.rejects(
    store.search(new Float32Array([1, 0]), {
      groupByItem: true,
      includeChunkText: false,
      minScore: -1,
      signal: controller.signal,
    }),
    /cancelled|aborted/i,
  );
  const rowsAtRejection = emittedRows;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(cancelCalls >= 1, "the active SQLite query must be cancelled");
  assert.equal(emittedRows, rowsAtRejection);
  assert.equal(completedInBackground, false);
}

console.log("Vector scan timeout and benchmark regression tests passed");
