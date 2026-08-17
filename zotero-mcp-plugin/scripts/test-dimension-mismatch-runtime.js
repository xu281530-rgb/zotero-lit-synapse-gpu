/* eslint-env node */

/**
 * The dimension-mismatch contract, exercised through the REAL scan code.
 *
 * The companion suite (`test-dimension-mismatch.js`) pins the reporting shape.
 * This one runs `VectorStore.search` and `VectorStore.searchMultiQuery`
 * themselves against a stubbed database, so the assertions are about what the
 * shipped code actually does rather than about what the source text says.
 *
 * The property: a query whose vector length differs from the stored vectors'
 * must raise a typed error on every path — CPU and GPU, single-query
 * (hybrid_search / semantic_search) and multi-query (find_similar) — and must
 * never come back as an empty, successful result set.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");
const { isVectorDimensionMismatchError } = await import(
  "../src/modules/semantic/dimensionMismatch.ts"
);

const STORED_DIMS = 2560;

/**
 * A store whose index holds `STORED_DIMS`-wide vectors.
 *
 * Only the metadata probe matters here: both scans read one row to learn the
 * stored width before they do any work, and that is where the check lives.
 */
function makeStore({ gpuEnabled = false, gpuSearch } = {}) {
  const gpuFallbacks = [];
  const gpuBackend = {
    isEnabled: () => gpuEnabled,
    registerProvider: () => {},
    startIfEnabled: async () => {},
    search: gpuSearch ?? (async () => []),
    publishMutation: async () => {},
    reportCpuPrecision: () => {},
    getEffectivePrecision: () => "int8",
    getCpuFallbackPrecision: () => "int8",
    fallback: (error) => gpuFallbacks.push(error),
  };

  const db = {
    executeTransaction: async (operation) => operation(),
    valueQueryAsync: async () => 0,
    queryAsync: async (sql, _params, options) => {
      if (sql.includes("SELECT dimensions,")) {
        const row = { dimensions: STORED_DIMS, has_int8: 1 };
        if (options?.onRow) {
          options.onRow(row, () => {});
          return undefined;
        }
        return [row];
      }
      if (options?.onRow) return undefined;
      return [];
    },
  };

  const store = new VectorStore(gpuBackend);
  store.initialized = true;
  store.db = db;
  return { store, gpuFallbacks };
}

const wrongWidthQuery = new Float32Array(1024).fill(0.1);
const rightWidthQuery = new Float32Array(STORED_DIMS).fill(0.1);

async function expectMismatch(run, label) {
  let threw = false;
  try {
    const result = await run();
    assert.fail(
      `${label}: expected a typed error, got ${JSON.stringify(result)} — ` +
        "returning [] is exactly the regression this test exists for",
    );
  } catch (error) {
    threw = true;
    assert.ok(
      isVectorDimensionMismatchError(error),
      `${label}: the failure must be a VectorDimensionMismatchError, got ${error}`,
    );
    assert.equal(error.storedDimensions, STORED_DIMS);
    assert.equal(error.queryDimensions, 1024);
    assert.match(error.message, /rebuild/i, `${label}: must name the remedy`);
  }
  assert.ok(threw);
}

// ---- CPU, single query: hybrid_search and semantic_search ----

{
  const { store } = makeStore();
  await expectMismatch(
    () =>
      store.search(wrongWidthQuery, {
        libraryID: 1,
        topK: 10,
        groupByItem: true,
      }),
    "CPU search()",
  );
}

// ---- CPU, multi query: find_similar ----

{
  const { store } = makeStore();
  await expectMismatch(
    () =>
      store.searchMultiQuery([wrongWidthQuery, wrongWidthQuery], {
        libraryID: 1,
      }),
    "CPU searchMultiQuery()",
  );
}

{
  // One bad vector among good ones still poisons the comparison, so it must
  // fail rather than quietly rank on the subset that happens to fit.
  const { store } = makeStore();
  await expectMismatch(
    () =>
      store.searchMultiQuery([rightWidthQuery, wrongWidthQuery], {
        libraryID: 1,
      }),
    "CPU searchMultiQuery() with a mixed batch",
  );
}

// ---- GPU: same error, and acceleration is NOT blamed for it ----

for (const [label, call] of [
  [
    "GPU search()",
    (store) =>
      store.search(wrongWidthQuery, {
        libraryID: 1,
        topK: 10,
        groupByItem: true,
      }),
  ],
  [
    "GPU searchMultiQuery()",
    (store) => store.searchMultiQuery([wrongWidthQuery], { libraryID: 1 }),
  ],
]) {
  const { store, gpuFallbacks } = makeStore({
    gpuEnabled: true,
    gpuSearch: async () => {
      const { VectorDimensionMismatchError } = await import(
        "../src/modules/semantic/dimensionMismatch.ts"
      );
      throw new VectorDimensionMismatchError(1024, STORED_DIMS);
    },
  });
  await expectMismatch(() => call(store), label);
  assert.deepEqual(
    gpuFallbacks,
    [],
    `${label}: an index/model mismatch is a configuration problem, so the GPU ` +
      "backend must not be marked failed and disabled for the session",
  );
}

// ---- a matching query is unaffected ----

{
  const { store } = makeStore();
  const results = await store.search(rightWidthQuery, {
    libraryID: 1,
    topK: 10,
    groupByItem: true,
  });
  assert.deepEqual(
    results,
    [],
    "a correctly sized query over an index with no matching rows must still " +
      "return an ordinary empty result, not an error",
  );
}

{
  const { store } = makeStore();
  assert.deepEqual(
    await store.searchMultiQuery([rightWidthQuery], { libraryID: 1 }),
    [],
  );
}

// ---- an index with no vectors at all is empty, not incompatible ----

{
  const { store } = makeStore();
  store.db.queryAsync = async (sql, _params, options) => {
    if (options?.onRow) return undefined;
    return [];
  };
  assert.deepEqual(
    await store.search(wrongWidthQuery, { libraryID: 1, topK: 10 }),
    [],
    "an empty index cannot be incompatible with anything — it must not throw",
  );
  assert.deepEqual(
    await store.searchMultiQuery([wrongWidthQuery], { libraryID: 1 }),
    [],
  );
}

console.log("dimension mismatch (runtime): all assertions passed");
