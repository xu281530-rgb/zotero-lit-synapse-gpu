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

/**
 * A row shaped like the one Zotero actually hands to an `onRow` callback.
 *
 * Zotero only wraps rows in its name-resolving Proxy on the path that RETURNS
 * them; an onRow callback receives the raw mozIStorageRow, whose columns are
 * reachable ONLY through getResultByName. Modelling rows as plain objects — as
 * these tests used to — makes named property access work by accident and hides
 * the exact defect that silently emptied every streamed query.
 */
const storageRow = (columns) => ({
  getResultByName(name) {
    if (!Object.prototype.hasOwnProperty.call(columns, name)) {
      throw new Error(`DB column '${name}' not found`);
    }
    return columns[name];
  },
});

/**
 * Stand-in for Zotero's queryAsync SELECT behaviour: rows are delivered through
 * onRow one at a time, and the call itself resolves to undefined rather than to
 * the rows. Anything that only works when queryAsync returns rows is therefore
 * broken against the real database.
 */
const selectViaOnRow = (rows, options) => {
  for (const row of rows) options?.onRow?.(row, () => {});
  return undefined;
};

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
  // The second, independently editable box: keyword search has its own budget.
  assert.match(
    xhtml,
    /id="zotero-prefpane-__addonRef__-hybrid-keyword-search-timeout"/,
  );
  assert.match(
    xhtml,
    /preference="extensions\.zotero\.__addonRef__\.hybrid\.keywordSearchTimeoutMs"/,
  );
  assert.match(xhtml, /id="hybrid-scan-benchmark-button"/);
  assert.match(xhtml, /id="hybrid-scan-benchmark-result"/);
  // Every chunk in the index, not one library's worth.
  assert.match(preferenceSource, /benchmarkLibraryScan\(\)/);
  // Both timeouts are measured and recommended by the one button.
  assert.match(
    preferenceSource,
    /setVectorScanTimeoutMs\(\s*recommendTimeoutMs\(vectorResult\)/,
  );
  assert.match(
    preferenceSource,
    /setKeywordSearchTimeoutMs\(\s*recommendTimeoutMs\(keywordResult\.worst\)/,
  );
  assert.match(preferenceSource, /runKeywordSearchBenchmark\(/);
  assert.match(preferenceSource, /sampleLibraryTerms\(/);
  // The raw maximum must never be stored directly: it leaves zero headroom.
  assert.doesNotMatch(preferenceSource, /setSearchTimeoutMs\(result\.maxMs\)/);
  assert.match(preferenceSource, /benchmarkButton\.disabled = true/);
  assert.match(
    preferenceSource,
    /finally[\s\S]*?benchmarkButton\.disabled = false/,
  );
}

// ---- streamed rows must be readable by column name ----
//
// This is the contract every mapper in vectorStore.ts depends on. Zotero wraps
// rows in a name-resolving Proxy only on the path that RETURNS them; rows handed
// to an onRow callback are raw mozIStorageRows that answer getResultByName and
// nothing else. When that was not handled, every streamed query produced rows of
// all-undefined values — the vector scan read no dimensions and silently
// returned zero results, and the scan benchmark reported a fully populated index
// as having no usable seed vector.
{
  const store = new VectorStore();
  store.initialized = true;
  store.db = {
    queryAsync: async (_sql, _params, options = {}) =>
      selectViaOnRow(
        [storageRow({ dimensions: 1024, vector_scale: 1062.84, id: 7 })],
        options ?? {},
      ),
  };

  const rows = await store.queryRowsCancellable(
    "SELECT dimensions, vector_scale, id FROM embeddings LIMIT 1",
    [],
    undefined,
    undefined,
    (row) => ({
      dimensions: row.dimensions,
      scale: row.vector_scale,
      id: row.id,
      // A column this query did not select. It must read as undefined rather
      // than throw: mapScanRow is shared by the Int8 and Float32 scan queries,
      // which select different columns, and Zotero cancels the whole query and
      // rethrows if an onRow callback throws.
      absent: row.vector_int8,
    }),
  );

  assert.deepEqual(rows, [
    { dimensions: 1024, scale: 1062.84, id: 7, absent: undefined },
  ]);
}

// A SELECT with onRow resolves to undefined in Zotero — rows arrive only through
// the callback. Nothing may depend on queryAsync returning them.
{
  const store = new VectorStore();
  store.initialized = true;
  store.db = {
    queryAsync: async () => [
      { dimensions: 2, vector: vectorBytes(new Float32Array([1, 0])) },
    ],
  };
  const rows = await store.queryRowsCancellable(
    "SELECT dimensions FROM embeddings LIMIT 1",
    [],
    undefined,
    undefined,
    (row) => ({ dimensions: row.dimensions }),
  );
  assert.deepEqual(
    rows,
    [],
    "rows returned instead of streamed must not be silently consumed: the real database never returns them",
  );
}

// The Preferences benchmark obtains one vector seed, then invokes the exact
// read-only full-Library search path ten times without hydrating chunk text.
{
  const sqlCalls = [];
  const db = {
    queryAsync: async (sql, _params = [], options = {}) => {
      void _params;
      sqlCalls.push(sql);
      if (sql.includes("JOIN vectors_f32")) {
        return selectViaOnRow(
          [
            storageRow({
              dimensions: 2,
              vector: vectorBytes(new Float32Array([1, 0])),
            }),
          ],
          options,
        );
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

  const result = await store.benchmarkLibraryScan();
  assert.equal(result.runs, 10);
  assert.equal(scanOptions.length, 10);
  assert.ok(
    scanOptions.every(
      (options) =>
        options.allLibraries === true &&
        options.groupByItem === true &&
        options.documentLimit === undefined &&
        options.includeChunkText === false &&
        options.itemKeys === undefined,
    ),
  );
  // The seed query must not be library-scoped either: an index built under one
  // library used to make the button fail with "No vectors are indexed".
  assert.ok(
    sqlCalls.every((sql) => !/NOT GLOB|item_key GLOB/.test(sql)),
    "the benchmark seed must not be restricted to a single library",
  );
  assert.ok(
    sqlCalls.every((sql) => !/chunk_text|INSERT|UPDATE|DELETE/i.test(sql)),
  );
}

// An index with no Float32 rows still searches — real scans run on the Int8
// column — so the benchmark must seed from Int8 rather than reporting that
// nothing is indexed.
{
  const store = new VectorStore();
  store.initialized = true;
  const int8 = new Int8Array([127, 0]);
  store.db = {
    queryAsync: async (sql, _params = [], options = {}) => {
      void _params;
      if (sql.includes("JOIN vectors_f32")) return selectViaOnRow([], options);
      if (sql.includes("vector_int8 IS NOT NULL")) {
        return selectViaOnRow(
          [
            storageRow({
              dimensions: 2,
              vector_int8: new Uint8Array(
                int8.buffer.slice(
                  int8.byteOffset,
                  int8.byteOffset + int8.byteLength,
                ),
              ),
              vector_scale: 127,
            }),
          ],
          options,
        );
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  let seedSeen = null;
  store.search = async (seed) => {
    seedSeen = seed;
    return [];
  };
  const result = await store.benchmarkLibraryScan();
  assert.equal(result.runs, 10);
  assert.ok(seedSeen instanceof Float32Array);
  assert.equal(seedSeen.length, 2);
  assert.equal(seedSeen[0], 1);
}

// With nothing indexed at all, the error must report the real table counts so
// a failure is diagnosable instead of just "No vectors are indexed".
{
  const store = new VectorStore();
  store.initialized = true;
  store.db = {
    queryAsync: async (_sql, _params, options = {}) =>
      selectViaOnRow([], options ?? {}),
    valueQueryAsync: async (sql) => {
      if (sql.includes("vector_int8 IS NOT NULL")) return 0;
      if (sql.includes("FROM vectors_f32")) return 0;
      if (sql.includes("FROM embeddings")) return 7;
      throw new Error(`Unexpected value query: ${sql}`);
    },
  };
  await assert.rejects(
    store.benchmarkLibraryScan(),
    /embeddings=7.*int8=0.*float32=0/s,
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
        return selectViaOnRow(
          [storageRow({ dimensions: 2, has_int8: 0 })],
          options,
        );
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
            storageRow({
              id,
              item_key: `ITEM${id}`,
              chunk_id: 0,
              language: "en",
              dimensions: 2,
              vector_f32: new Uint8Array(new Float32Array([1, 0]).buffer),
            }),
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
