/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");

function backend(enabled, search) {
  return {
    isEnabled: () => enabled,
    getEffectivePrecision: () => "float32",
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

console.log("GPU vector dispatch tests passed");
