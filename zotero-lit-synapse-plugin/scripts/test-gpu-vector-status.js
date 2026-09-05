/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { GpuVectorStatusController } = await import(
  "../src/modules/semantic/gpuVectorStatus.ts"
);

const controller = new GpuVectorStatusController();
const observed = [];
const unsubscribe = controller.subscribe((status) => observed.push(status));

assert.deepEqual(controller.get(), {
  phase: "disabled",
  backend: "cpu",
  precision: "int8",
});
controller.set({ phase: "preparing" });
controller.set({
  phase: "loading",
  loaded: 40,
  total: 100,
  precision: "float32",
});
controller.set({
  phase: "available",
  backend: "gpu",
  vectors: 100,
  device: "RTX Test",
  precision: "float32",
  deviceBytes: 409600,
});
controller.fallback(
  "NO_CUDA_DEVICE",
  "No compatible CUDA device",
  true,
  "float32",
);

assert.deepEqual(controller.get(), {
  phase: "fallback",
  backend: "cpu",
  precision: "float32",
  code: "NO_CUDA_DEVICE",
  reason: "No compatible CUDA device",
  preferenceEnabled: true,
});
assert.equal(
  observed.length,
  5,
  "subscriber receives initial and every transition",
);

unsubscribe();
controller.set({ phase: "disabled", backend: "cpu", precision: "float32" });
assert.equal(observed.length, 5, "unsubscribe stops status updates");

console.log("GPU vector status tests passed");
