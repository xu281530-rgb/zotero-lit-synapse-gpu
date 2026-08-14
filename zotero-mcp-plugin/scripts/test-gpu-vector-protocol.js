/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  GPU_PROTOCOL_VERSION,
  MAX_GPU_HEADER_BYTES,
  GpuFrameDecoder,
  decodeGpuFrame,
  encodeGpuFrame,
} = await import("../src/modules/semantic/gpuVectorProtocol.ts");

const query = new Int8Array([127, -12, 0, 31]);
const encoded = encodeGpuFrame(
  {
    protocol: GPU_PROTOCOL_VERSION,
    type: "search",
    requestId: "request-7",
    topK: 20,
  },
  new Uint8Array(query.buffer),
);

const view = new DataView(
  encoded.buffer,
  encoded.byteOffset,
  encoded.byteLength,
);
const headerLength = view.getUint32(0, true);
assert.ok(headerLength > 0);
assert.equal(
  view.getUint32(4 + headerLength, true),
  query.byteLength,
  "payload length must follow the UTF-8 JSON header",
);

const decoded = decodeGpuFrame(encoded);
assert.deepEqual(decoded.header, {
  protocol: "vector-gpu/1",
  type: "search",
  requestId: "request-7",
  topK: 20,
});
assert.deepEqual([...new Int8Array(decoded.payload.buffer)], [...query]);

assert.throws(
  () =>
    encodeGpuFrame({
      protocol: GPU_PROTOCOL_VERSION,
      type: "x".repeat(MAX_GPU_HEADER_BYTES),
      requestId: "too-large",
    }),
  /header.*large/i,
);

const truncated = encoded.slice(0, encoded.length - 1);
assert.throws(() => decodeGpuFrame(truncated), /truncated/i);

const second = encodeGpuFrame({
  protocol: GPU_PROTOCOL_VERSION,
  type: "pong",
  requestId: "request-8",
});
const decoder = new GpuFrameDecoder();
const joined = new Uint8Array(encoded.length + second.length);
joined.set(encoded);
joined.set(second, encoded.length);
const received = [];
for (let offset = 0; offset < joined.length; offset += 3) {
  received.push(...decoder.push(joined.subarray(offset, offset + 3)));
}
assert.equal(received.length, 2, "fragmented and coalesced frames must decode");
assert.equal(received[0].header.requestId, "request-7");
assert.equal(received[1].header.type, "pong");
assert.equal(decoder.bufferedBytes, 0);

console.log("GPU vector protocol tests passed");
