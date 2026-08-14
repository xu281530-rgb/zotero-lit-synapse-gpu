/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  GpuVectorStatusController,
} = await import("../src/modules/semantic/gpuVectorStatus.ts");

const controller = new GpuVectorStatusController();
const observed = [];
const unsubscribe = controller.subscribe((status) => observed.push(status));

assert.deepEqual(controller.get(), { phase: "disabled" });
controller.set({ phase: "preparing" });
controller.set({ phase: "loading", loaded: 40, total: 100 });
controller.set({ phase: "available", vectors: 100, device: "RTX Test" });
controller.fallback("NO_CUDA_DEVICE", "No compatible CUDA device", true);

assert.deepEqual(controller.get(), {
  phase: "fallback",
  code: "NO_CUDA_DEVICE",
  reason: "No compatible CUDA device",
  preferenceEnabled: true,
});
assert.equal(observed.length, 5, "subscriber receives initial and every transition");

unsubscribe();
controller.set({ phase: "disabled" });
assert.equal(observed.length, 5, "unsubscribe stops status updates");

console.log("GPU vector status tests passed");
