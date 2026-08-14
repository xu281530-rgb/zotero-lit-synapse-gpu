/* eslint-env node */

/**
 * Regression tests for the byte-level HTTP read/write loops
 * (readHttpRequest / writeAllBytes in src/modules/httpFraming.ts).
 *
 * Both loops talk to a Gecko socket through a non-blocking pipe, and both used
 * to trust that one call did the whole job:
 *
 *  - the reader decoded while it framed, so a CJK character split across two
 *    TCP segments produced zero characters and was mistaken for EOF — the
 *    truncated body then came back as `-32700 Parse error`;
 *  - the writer ignored the byte count returned by write(), so any response
 *    larger than the pipe buffer was silently cut short and the client sat
 *    waiting for the bytes Content-Length had promised.
 *
 * The fakes below reproduce exactly those two behaviours.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  NS_BASE_STREAM_WOULD_BLOCK,
  analyzeRequest,
  readHttpRequest,
  utf8Decode,
  utf8Encode,
  writeAllBytes,
} = await import("../src/modules/httpFraming.ts");

const LIMITS = {
  idleTimeoutMs: 500,
  totalTimeoutMs: 3000,
  maxBytes: 4 * 1024 * 1024,
  pollIntervalMs: 1,
};

/**
 * A socket that hands over `segments` one at a time, with a tick of nothing in
 * between — i.e. a request spread over several TCP segments.
 */
function fakeSocket(segments, { closeAtEnd = true } = {}) {
  let pending = "";
  let index = 0;
  let starve = false;
  let closed = false;

  const pump = () => {
    if (pending.length > 0) return;
    if (index >= segments.length) {
      if (closeAtEnd) closed = true;
      return;
    }
    // Every other poll returns nothing, so the loop has to wait rather than
    // assume "no bytes right now" means "no bytes ever".
    starve = !starve;
    if (starve) return;
    pending = segments[index];
    index += 1;
  };

  return {
    input: {
      available() {
        pump();
        if (pending.length === 0 && closed) {
          const error = new Error("NS_BASE_STREAM_CLOSED");
          error.result = 0x80470002;
          throw error;
        }
        return pending.length;
      },
    },
    sin: {
      read(count) {
        if (pending.length === 0) {
          const error = new Error("NS_BASE_STREAM_WOULD_BLOCK");
          error.result = NS_BASE_STREAM_WOULD_BLOCK;
          throw error;
        }
        const chunk = pending.slice(0, count);
        pending = pending.slice(count);
        return chunk;
      },
    },
  };
}

function buildPost(bodyText) {
  const body = utf8Encode(bodyText);
  return (
    "POST /mcp HTTP/1.1\r\n" +
    "Host: 127.0.0.1:23120\r\n" +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${body.length}\r\n` +
    "\r\n" +
    body
  );
}

// A realistic hybrid_search call: bilingual keywords, so the body is full of
// multi-byte characters and is longer in bytes than in characters.
const toolCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: {
    name: "hybrid_search",
    arguments: {
      query:
        "Effects of temperature gradient on columnar-to-equiaxed transition / 温度梯度对定向凝固柱状晶-等轴晶转变的影响",
      keywords: [
        "温度梯度",
        "定向凝固",
        "柱状晶-等轴晶转变",
        "凝固速率",
        "temperature gradient",
        "directional solidification",
        "columnar-to-equiaxed transition",
      ],
      domain: "materials science",
      expertRole: "solidification specialist",
    },
  },
});

const request = buildPost(toolCall);
const bodyStart = request.indexOf("\r\n\r\n") + 4;

// ---------------------------------------------------------------------------
// 1. Split at every single byte offset, including inside multi-byte
//    characters. Every split must still yield the complete request, exactly
//    once.
// ---------------------------------------------------------------------------
for (let split = 1; split < request.length; split += 1) {
  const socket = fakeSocket([
    request.substring(0, split),
    request.substring(split),
  ]);
  const { frame, outcome } = await readHttpRequest(
    socket.input,
    socket.sin,
    LIMITS,
  );
  assert.equal(outcome, "complete", `split at byte ${split} must read complete`);
  assert.equal(
    utf8Decode(frame.body),
    toolCall,
    `split at byte ${split} must preserve the body byte for byte`,
  );
  assert.deepEqual(JSON.parse(utf8Decode(frame.body)).params.name, "hybrid_search");
}

// The specific case that used to fail: the split lands between the bytes of a
// single CJK character in the body.
const cjkOffset = bodyStart + utf8Encode(toolCall).indexOf(utf8Encode("温"));
for (const offset of [cjkOffset + 1, cjkOffset + 2]) {
  const socket = fakeSocket([
    request.substring(0, offset),
    request.substring(offset),
  ]);
  const { frame, outcome } = await readHttpRequest(socket.input, socket.sin, LIMITS);
  assert.equal(outcome, "complete");
  assert.equal(utf8Decode(frame.body), toolCall);
}

// ---------------------------------------------------------------------------
// 2. Byte-at-a-time delivery (worst case fragmentation).
// ---------------------------------------------------------------------------
const dripped = fakeSocket(Array.from(request));
const drip = await readHttpRequest(dripped.input, dripped.sin, {
  ...LIMITS,
  // Two polls per byte at ~1ms each: generous total budget, tight idle budget.
  totalTimeoutMs: 60000,
});
assert.equal(drip.outcome, "complete");
assert.equal(utf8Decode(drip.frame.body), toolCall);

// ---------------------------------------------------------------------------
// 3. A body that never finishes arriving is reported as incomplete — it is
//    never handed to JSON.parse as if it were whole.
// ---------------------------------------------------------------------------
const truncated = fakeSocket([request.substring(0, request.length - 12)]);
const cut = await readHttpRequest(truncated.input, truncated.sin, LIMITS);
assert.equal(cut.outcome, "incomplete");
assert.equal(cut.frame.bodyComplete, false);
assert.equal(cut.frame.body, "");

// A client that connects and sends nothing is an empty probe, not an error.
const idle = fakeSocket([], { closeAtEnd: false });
const probe = await readHttpRequest(idle.input, idle.sin, {
  ...LIMITS,
  idleTimeoutMs: 30,
});
assert.equal(probe.outcome, "empty");

// An oversized request stops at the limit instead of growing without bound.
const huge = fakeSocket([
  "POST /mcp HTTP/1.1\r\nContent-Length: 999999\r\n\r\n" + "x".repeat(5000),
]);
const capped = await readHttpRequest(huge.input, huge.sin, {
  ...LIMITS,
  maxBytes: 2048,
});
assert.equal(capped.outcome, "too-large");

// ---------------------------------------------------------------------------
// 4. Writing: a pipe that accepts only part of each write must still receive
//    every byte, in order.
// ---------------------------------------------------------------------------
function fakePipe({ capacityPerWrite, blockEvery = 0 }) {
  let sink = "";
  let calls = 0;
  return {
    get written() {
      return sink;
    },
    get calls() {
      return calls;
    },
    write(data, count) {
      calls += 1;
      assert.equal(
        count,
        data.length,
        "the declared count must match the slice length",
      );
      if (blockEvery && calls % blockEvery === 0) {
        // Pipe is full right now, exactly like a non-blocking nsIOutputStream.
        const error = new Error("NS_BASE_STREAM_WOULD_BLOCK");
        error.result = NS_BASE_STREAM_WOULD_BLOCK;
        throw error;
      }
      const accepted = Math.min(capacityPerWrite, data.length);
      sink += data.slice(0, accepted);
      return accepted;
    },
  };
}

// A large hybrid_search result: 400 KB of CJK, far past a socket pipe buffer.
const bigResult = JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  result: { content: [{ type: "text", text: "定向凝固柱状晶转变研究摘要。".repeat(12000) }] },
});
const bigBytes = utf8Encode(bigResult);
assert.ok(bigBytes.length > 300 * 1024, "the payload must exceed a pipe buffer");

const responseHead =
  "HTTP/1.1 200 OK\r\n" +
  "Content-Type: application/json; charset=utf-8\r\n" +
  "Connection: close\r\n" +
  `Content-Length: ${bigBytes.length}\r\n` +
  "\r\n";

const pipe = fakePipe({ capacityPerWrite: 1500, blockEvery: 7 });
const written = await writeAllBytes(
  pipe,
  responseHead + bigBytes,
  Date.now() + 20000,
  32 * 1024,
);

assert.equal(written, responseHead.length + bigBytes.length);
assert.equal(pipe.written.length, written, "every byte must reach the socket");
assert.equal(pipe.written, responseHead + bigBytes, "bytes must arrive in order");

// The client parses what it received using the advertised Content-Length —
// this is the check that used to fail and leave the client waiting forever.
const receivedBody = pipe.written.slice(pipe.written.indexOf("\r\n\r\n") + 4);
assert.equal(receivedBody.length, bigBytes.length);
assert.equal(JSON.parse(utf8Decode(receivedBody)).id, 7);

// A pipe that never drains must fail loudly rather than hang forever.
const stuck = fakePipe({ capacityPerWrite: 0 });
await assert.rejects(
  () => writeAllBytes(stuck, "abc", Date.now() + 50),
  /Response write timed out/,
);

// ---------------------------------------------------------------------------
// 5. One client call is framed as exactly one request — no double dispatch.
// ---------------------------------------------------------------------------
const twice = fakeSocket([request + request]);
const first = await readHttpRequest(twice.input, twice.sin, LIMITS);
assert.equal(first.outcome, "complete");
assert.equal(utf8Decode(first.frame.body), toolCall);
assert.equal(
  first.frame.trailingBytes,
  request.length,
  "the second pipelined request must be reported, not merged into the first",
);
assert.equal(
  analyzeRequest(first.raw.substring(0, first.frame.bodyStart + first.frame.contentLength))
    .bodyComplete,
  true,
);

console.log("HTTP transport read/write regression tests passed");
