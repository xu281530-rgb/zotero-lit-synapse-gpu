/* eslint-env node */

/**
 * Regression tests for HTTP request framing (src/modules/httpFraming.ts).
 *
 * These cover the failure that made `hybrid_search` return
 * `-32700 Parse error` at random: the request body was framed while it was
 * still being decoded, so a multi-byte character split across two TCP segments
 * could make the reader believe the request had ended, and JSON.parse then got
 * a truncated body.
 *
 * The rule under test is simple and absolute: a body is only ever handed out
 * once its byte count matches Content-Length (or the chunked terminator has
 * arrived), no matter how the bytes were sliced on the way in.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { analyzeRequest, decodeChunkedBody, utf8Decode, utf8Encode } =
  await import("../src/modules/httpFraming.ts");

/** Build a POST exactly as an MCP client sends it, in raw bytes. */
function buildPost(bodyText, extraHeaders = "") {
  const body = utf8Encode(bodyText);
  return (
    "POST /mcp HTTP/1.1\r\n" +
    "Host: 127.0.0.1:23120\r\n" +
    "Content-Type: application/json\r\n" +
    "Accept: application/json, text/event-stream\r\n" +
    extraHeaders +
    `Content-Length: ${body.length}\r\n` +
    "\r\n" +
    body
  );
}

// ---------------------------------------------------------------------------
// 1. UTF-8 round trip: Content-Length is counted in bytes, not characters.
// ---------------------------------------------------------------------------
const cjk = '{"query":"温度梯度对定向凝固柱状晶转变的影响","keywords":["柱状晶"]}';
const encoded = utf8Encode(cjk);
assert.equal(utf8Decode(encoded), cjk, "UTF-8 round trip must be lossless");
assert.equal(
  encoded.length,
  Buffer.byteLength(cjk, "utf8"),
  "encoded length must equal the UTF-8 byte length",
);
assert.ok(
  encoded.length > cjk.length,
  "the CJK body must be longer in bytes than in characters — that gap is what broke the old reader",
);
assert.ok(
  Array.from(encoded).every((char) => char.charCodeAt(0) <= 0xff),
  "the encoded form must be a byte string (1 char = 1 byte)",
);

// ---------------------------------------------------------------------------
// 2. A request that arrived in one piece is complete.
// ---------------------------------------------------------------------------
const whole = buildPost(cjk);
const wholeFrame = analyzeRequest(whole);
assert.equal(wholeFrame.headersComplete, true);
assert.equal(wholeFrame.requestLine, "POST /mcp HTTP/1.1");
assert.equal(wholeFrame.contentLength, encoded.length);
assert.equal(wholeFrame.bodyComplete, true);
assert.equal(utf8Decode(wholeFrame.body), cjk);
assert.equal(wholeFrame.trailingBytes, 0);
assert.equal(wholeFrame.headers.get("content-type"), "application/json");

// ---------------------------------------------------------------------------
// 3. THE REGRESSION: every possible split point must be handled.
//
// The reader appends bytes and re-frames after each chunk. At no split may a
// partial request be reported as complete, and once the last byte arrives the
// body must decode back to exactly what the client sent.
// ---------------------------------------------------------------------------
for (let split = 1; split < whole.length; split += 1) {
  const first = whole.substring(0, split);
  const partial = analyzeRequest(first);
  assert.ok(
    !(partial.headersComplete && partial.bodyComplete),
    `a request truncated at byte ${split} must never be reported as complete`,
  );
  assert.equal(
    partial.body,
    "",
    `an incomplete request must not hand out a body (split at ${split})`,
  );

  const finished = analyzeRequest(first + whole.substring(split));
  assert.equal(finished.bodyComplete, true);
  assert.equal(
    utf8Decode(finished.body),
    cjk,
    `body must survive a split at byte ${split}`,
  );
}

// A split that lands in the middle of a multi-byte character is the exact case
// that used to decode to zero characters and be mistaken for EOF.
const bodyStart = whole.indexOf("\r\n\r\n") + 4;
const midChar = bodyStart + encoded.indexOf(utf8Encode("温")) + 1;
assert.equal(analyzeRequest(whole.substring(0, midChar)).bodyComplete, false);
assert.equal(
  utf8Decode(analyzeRequest(whole).body),
  cjk,
  "the full request must still decode after a mid-character split",
);

// ---------------------------------------------------------------------------
// 4. Only this request's bytes are consumed; extras are reported, not eaten.
// ---------------------------------------------------------------------------
const pipelined = analyzeRequest(whole + "POST /mcp HTTP/1.1\r\n");
assert.equal(pipelined.bodyComplete, true);
assert.equal(utf8Decode(pipelined.body), cjk);
assert.equal(pipelined.trailingBytes, 20);

// ---------------------------------------------------------------------------
// 5. Requests without a body, and empty bodies.
// ---------------------------------------------------------------------------
const get = analyzeRequest("GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
assert.equal(get.bodyComplete, true);
assert.equal(get.expectsBody, false);
assert.equal(get.body, "");

const emptyBody = analyzeRequest(buildPost(""));
assert.equal(emptyBody.contentLength, 0);
assert.equal(emptyBody.expectsBody, false);
assert.equal(emptyBody.bodyComplete, true);

// ---------------------------------------------------------------------------
// 6. Malformed framing is reported as an error instead of being guessed at.
// ---------------------------------------------------------------------------
const badLength = analyzeRequest(
  "POST /mcp HTTP/1.1\r\nContent-Length: abc\r\n\r\n{}",
);
assert.match(badLength.error ?? "", /invalid Content-Length/);

const conflicting = analyzeRequest(
  "POST /mcp HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 5\r\n\r\n{}",
);
assert.match(conflicting.error ?? "", /conflicting Content-Length/);

const badEncoding = analyzeRequest(
  "POST /mcp HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n",
);
assert.match(badEncoding.error ?? "", /unsupported Transfer-Encoding/);

// ---------------------------------------------------------------------------
// 7. chunked bodies are decoded, not fed to JSON.parse with their framing.
// ---------------------------------------------------------------------------
const chunkBody = utf8Encode('{"jsonrpc":"2.0","method":"ping","id":1}');
const chunkedRaw =
  "POST /mcp HTTP/1.1\r\n" +
  "Transfer-Encoding: chunked\r\n" +
  "\r\n" +
  `${chunkBody.length.toString(16)}\r\n${chunkBody}\r\n` +
  "0\r\n\r\n";
const chunked = analyzeRequest(chunkedRaw);
assert.equal(chunked.chunked, true);
assert.equal(chunked.bodyComplete, true);
assert.equal(utf8Decode(chunked.body), utf8Decode(chunkBody));
assert.equal(chunked.trailingBytes, 0);

// A chunked request still arriving is incomplete, never complete-with-garbage.
for (let split = chunkedRaw.indexOf("\r\n\r\n") + 4; split < chunkedRaw.length; split += 1) {
  const partial = analyzeRequest(chunkedRaw.substring(0, split));
  assert.equal(
    partial.bodyComplete,
    false,
    `chunked body truncated at ${split} must not be reported complete`,
  );
}

// Multi-chunk plus trailers.
const multi = decodeChunkedBody("3\r\nabc\r\n2\r\nde\r\n0\r\nX-T: 1\r\n\r\n", 0);
assert.equal(multi.complete, true);
assert.equal(multi.body, "abcde");

console.log("HTTP request framing regression tests passed");
