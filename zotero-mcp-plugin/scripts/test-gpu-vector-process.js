/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { decodeGpuFrame, encodeGpuFrame } = await import(
  "../src/modules/semantic/gpuVectorProtocol.ts"
);

class FragmentedPipe {
  constructor() {
    this.bytes = [];
    this.waiters = [];
  }

  enqueue(bytes) {
    this.bytes.push(...bytes);
    this.flush();
  }

  flush() {
    while (this.bytes.length > 0 && this.waiters.length > 0) {
      const resolve = this.waiters.shift();
      resolve(Uint8Array.of(this.bytes.shift()).buffer);
    }
  }

  read() {
    if (this.bytes.length > 0) {
      return Promise.resolve(Uint8Array.of(this.bytes.shift()).buffer);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async close() {}
}

const stdout = new FragmentedPipe();
let launchOptions;
let killed = 0;
const handle = {
  pid: 123,
  stdout,
  stderr: new FragmentedPipe(),
  stdin: {
    async write(bytes) {
      const request = decodeGpuFrame(
        new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );
      stdout.enqueue(
        encodeGpuFrame({
          protocol: "vector-gpu/1",
          type: `${request.header.type}.result`,
          requestId: request.header.requestId,
          ok: true,
          echoed: request.header.value,
        }),
      );
    },
    async close() {},
  },
  wait: () => new Promise(() => {}),
  async kill() {
    killed += 1;
    return { exitCode: 0 };
  },
};

globalThis.ChromeUtils = {
  importESModule: () => ({
    Subprocess: {
      getEnvironment: () => ({
        SYSTEMROOT: "C:\\Windows",
        WINDIR: "C:\\Windows",
        TEMP: "C:\\Temp",
        TMP: "C:\\Temp",
      }),
      call: async (options) => {
        launchOptions = options;
        return handle;
      },
    },
  }),
};

const { GpuVectorProcess } = await import(
  "../src/modules/semantic/gpuVectorProcess.ts"
);
const process = await GpuVectorProcess.launch({
  executable: "C:\\plugin-data\\gpu\\vector-gpu.exe",
  workdir: "C:\\plugin-data\\gpu",
});
assert.equal(launchOptions.command, "C:\\plugin-data\\gpu\\vector-gpu.exe");
assert.equal(launchOptions.workdir, "C:\\plugin-data\\gpu");
assert.equal(launchOptions.environment.PATH, "C:\\plugin-data\\gpu");
assert.equal(launchOptions.environmentAppend, false);

const response = await process.request("ping", { value: 42 }, undefined, 1000);
assert.equal(response.header.echoed, 42);
await process.stop();
assert.equal(killed, 1);

console.log("GPU vector process tests passed");
