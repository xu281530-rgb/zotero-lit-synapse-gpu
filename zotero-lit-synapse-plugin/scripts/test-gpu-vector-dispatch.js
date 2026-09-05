/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");

function backend(enabled, search, fallbackPrecision) {
  return {
    isEnabled: () => enabled,
    getEffectivePrecision: () => "float32",
    getCpuFallbackPrecision: () => fallbackPrecision,
    reportCpuPrecision: () => {},
    registerProvider: () => {},
    startIfEnabled: async () => {},
    search,
    publishMutation: async () => {},
    fallback: () => {},
    setEnabled: async () => {},
    setPrecision: async () => {},
    shutdown: async () => {},
  };
}

const query = new Float32Array([1, 0]);
const gpuResult = [
  {
    libraryID: 1,
    itemKey: "GPU",
    chunkId: 3,
    score: 0.9,
    chunkText: "",
    language: "en",
    rowId: 7,
  },
];

{
  let forcedPrecision;
  const store = new VectorStore(
    backend(false, async () => gpuResult, "float32"),
  );
  store.initialized = true;
  store.searchCpu = async (_query, _options, precision) => {
    forcedPrecision = precision;
    return [{ ...gpuResult[0], itemKey: "CPU-FLOAT32-FALLBACK" }];
  };
  const result = await store.search(query);
  assert.equal(result[0].itemKey, "CPU-FLOAT32-FALLBACK");
  assert.equal(
    forcedPrecision,
    "float32",
    "a failed Float32 GPU session must keep using CPU Float32 on later queries",
  );
}

{
  let cpuCalls = 0;
  let gpuCalls = 0;
  const store = new VectorStore(
    backend(false, async () => {
      gpuCalls += 1;
      return gpuResult;
    }),
  );
  store.initialized = true;
  store.searchCpu = async () => {
    cpuCalls += 1;
    return [{ ...gpuResult[0], itemKey: "CPU" }];
  };
  const result = await store.search(query);
  assert.equal(result[0].itemKey, "CPU");
  assert.equal(cpuCalls, 1);
  assert.equal(gpuCalls, 0, "disabled GPU must not touch the GPU backend");
}

{
  let cpuCalls = 0;
  const store = new VectorStore(backend(true, async () => gpuResult));
  store.initialized = true;
  store.searchCpu = async () => {
    cpuCalls += 1;
    return [];
  };
  const result = await store.search(query, { includeChunkText: false });
  assert.deepEqual(result, gpuResult);
  assert.equal(cpuCalls, 0);
}

{
  let cpuCalls = 0;
  let fallbackCalls = 0;
  const failed = backend(true, async () => {
    throw Object.assign(new Error("CUDA process exited"), {
      code: "PROCESS_EXITED",
    });
  });
  failed.fallback = () => {
    fallbackCalls += 1;
  };
  const store = new VectorStore(failed);
  store.initialized = true;
  store.searchCpu = async () => {
    cpuCalls += 1;
    return [{ ...gpuResult[0], itemKey: "CPU-FALLBACK" }];
  };
  const result = await store.search(query);
  assert.equal(result[0].itemKey, "CPU-FALLBACK");
  assert.equal(cpuCalls, 1);
  assert.equal(fallbackCalls, 1);
}

{
  let cpuCalls = 0;
  const controller = new AbortController();
  controller.abort();
  const store = new VectorStore(backend(true, async () => gpuResult));
  store.initialized = true;
  store.searchCpu = async () => {
    cpuCalls += 1;
    return [];
  };
  await assert.rejects(
    store.search(query, { signal: controller.signal }),
    /cancelled/i,
  );
  assert.equal(cpuCalls, 0, "cancellation must not trigger a CPU rescan");
}

// ---- the scan benchmark must cover the same chunks on GPU and CPU ----
//
// The GPU worker filters by library_id when it is given one. If the benchmark
// asked the GPU for one library while the CPU path scanned everything, the two
// would measure different amounts of work and the recommended timeout would be
// wrong for whichever path the user actually runs on.
{
  let gpuRequest = null;
  const store = new VectorStore(
    backend(true, async (request) => {
      gpuRequest = request;
      return gpuResult;
    }),
  );
  store.initialized = true;
  store.hydrateSearchResultTexts = async (rows) => rows;
  await store.search(query, { allLibraries: true, includeChunkText: false });
  assert.equal(
    gpuRequest.libraryID,
    undefined,
    "allLibraries must reach the GPU worker as an absent library filter",
  );
}

{
  // Ordinary retrieval keeps its library scope: only the benchmark is global.
  let gpuRequest = null;
  const store = new VectorStore(
    backend(true, async (request) => {
      gpuRequest = request;
      return gpuResult;
    }),
  );
  store.initialized = true;
  store.hydrateSearchResultTexts = async (rows) => rows;
  await store.search(query, { libraryID: 5, includeChunkText: false });
  assert.equal(gpuRequest.libraryID, 5);

  await store.search(query, { includeChunkText: false });
  assert.equal(gpuRequest.libraryID, 1, "the user library is the default scope");
}

{
  // itemKeys is narrower than a library, so it must still win over allLibraries
  // exactly as it does on the CPU path.
  let gpuRequest = null;
  const store = new VectorStore(
    backend(true, async (request) => {
      gpuRequest = request;
      return gpuResult;
    }),
  );
  store.initialized = true;
  store.hydrateSearchResultTexts = async (rows) => rows;
  await store.search(query, {
    allLibraries: true,
    itemKeys: ["AAAA1111"],
    libraryID: 5,
    includeChunkText: false,
  });
  assert.equal(gpuRequest.libraryID, 5);
  assert.deepEqual(gpuRequest.itemKeys, ["AAAA1111"]);
}

{
  // A GPU failure during the benchmark falls back to CPU — and the fallback
  // must inherit the same global scope, or the measurement silently narrows.
  let cpuOptions = null;
  const store = new VectorStore(
    backend(true, async () => {
      throw new Error("gpu exploded");
    }),
  );
  store.initialized = true;
  store.searchCpu = async (_query, options) => {
    cpuOptions = options;
    return [];
  };
  await store.search(query, { allLibraries: true, includeChunkText: false });
  assert.equal(cpuOptions.allLibraries, true);
}

console.log("GPU vector dispatch tests passed");
