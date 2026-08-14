/* eslint-env node */

/**
 * Live check against a running Zotero MCP server (manual, not part of `npm test`).
 *
 *   node scripts/check-mcp-framing.mjs [port]
 *
 * It talks raw TCP so it controls exactly how the request bytes are split, which
 * is the thing that used to decide whether a call worked:
 *
 *  - a request whose body arrives in a second TCP write,
 *  - a request whose body is cut in the middle of a multi-byte character,
 *  - a request that dribbles in small fragments,
 *  - the same request repeated, to expose intermittency.
 *
 * `ping` is used as the payload carrier because the server ignores its params
 * and answers immediately, so what is measured is framing and nothing else.
 * Every response is also checked against its own Content-Length, which is how a
 * truncated (client-hanging) response shows up.
 */

import net from "node:net";

const HOST = "127.0.0.1";
const PORT = Number(process.argv[2] || 23120);
const CJK = "温度梯度对定向凝固柱状晶-等轴晶转变的影响，columnar-to-equiaxed transition。";

let nextId = 1;

/** A request whose response must come back containing non-ASCII text. */
function buildEchoRequest() {
  const body = Buffer.from(
    JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "温度梯度" }),
    "utf8",
  );
  const head = Buffer.from(
    "POST /mcp HTTP/1.1\r\n" +
      `Host: ${HOST}:${PORT}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${body.length}\r\n` +
      "Connection: close\r\n" +
      "\r\n",
    "ascii",
  );
  return Buffer.concat([head, body]);
}

function buildRequest(payloadChars) {
  const body = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "ping",
      params: { probe: CJK.repeat(payloadChars) },
    }),
    "utf8",
  );
  const head = Buffer.from(
    "POST /mcp HTTP/1.1\r\n" +
      `Host: ${HOST}:${PORT}\r\n` +
      "Content-Type: application/json\r\n" +
      "Accept: application/json, text/event-stream\r\n" +
      "MCP-Protocol-Version: 2025-06-18\r\n" +
      `Content-Length: ${body.length}\r\n` +
      "Connection: close\r\n" +
      "\r\n",
    "ascii",
  );
  return { head, body, full: Buffer.concat([head, body]) };
}

function send(label, chunks, gapMs = 5, expect = null) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port: PORT });
    const received = [];
    const startedAt = Date.now();
    socket.setTimeout(30000);

    socket.on("connect", async () => {
      for (const chunk of chunks) {
        socket.write(chunk);
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      }
    });
    socket.on("data", (data) => received.push(data));
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ label, verdict: "HANG", detail: "no complete response in 30s", ms: Date.now() - startedAt });
    });
    socket.on("error", (error) =>
      resolve({ label, verdict: "SOCKET", detail: error.code, ms: Date.now() - startedAt }),
    );
    socket.on("close", () => {
      const raw = Buffer.concat(received);
      const separator = raw.indexOf("\r\n\r\n");
      if (separator < 0) {
        resolve({ label, verdict: "NO RESPONSE", detail: `${raw.length} bytes`, ms: Date.now() - startedAt });
        return;
      }
      const head = raw.subarray(0, separator).toString("ascii");
      const body = raw.subarray(separator + 4);
      const declared = Number((/content-length:\s*(\d+)/i.exec(head) || [])[1]);
      const text = body.toString("utf8");

      let verdict;
      let detail = `${body.length}/${declared} body bytes`;
      if (declared !== body.length) {
        // Declared and delivered must agree, or the client waits for bytes
        // that never arrive (or reads a response that never ends).
        verdict = "TRUNCATED";
      } else if (text.includes("-32700")) {
        verdict = "PARSE ERROR";
      } else if (expect && !text.includes(expect)) {
        verdict = "BAD ENCODING";
        detail = `expected ${expect} in: ${text.slice(0, 90)}`;
      } else if (text.includes('"result"') || (expect && text.includes(expect))) {
        verdict = "OK";
      } else {
        verdict = "UNEXPECTED";
        detail = text.slice(0, 120);
      }
      resolve({ label, verdict, detail, ms: Date.now() - startedAt });
    });
  });
}

const results = [];

{
  const { full } = buildRequest(12);
  results.push(await send("whole request in one write", [full], 0));
}
{
  const { head, body } = buildRequest(12);
  results.push(await send("headers, then body", [head, body]));
}
{
  const { head, body } = buildRequest(12);
  const cut = body.indexOf(Buffer.from("温", "utf8")) + 1;
  results.push(await send("body cut inside a CJK character", [head, body.subarray(0, cut), body.subarray(cut)]));
}
{
  const { full } = buildRequest(12);
  const pieces = [];
  for (let i = 0; i < full.length; i += 37) pieces.push(full.subarray(i, i + 37));
  results.push(await send("37-byte fragments", pieces, 1));
}
for (let size of [1, 40, 400, 4000]) {
  const { full } = buildRequest(size);
  results.push(await send(`one write, ${full.length} byte request`, [full], 0));
}
for (let round = 1; round <= 10; round += 1) {
  const { head, body } = buildRequest(40);
  const cut = Math.floor(body.length / 2) + 1;
  results.push(await send(`repeat ${round}/10`, [head, body.subarray(0, cut), body.subarray(cut)]));
}

// The response itself carries non-ASCII: Content-Length is counted in UTF-8
// bytes and the body must be written as those same bytes, not re-encoded.
for (let round = 1; round <= 3; round += 1) {
  results.push(
    await send(`non-ASCII response ${round}/3`, [buildEchoRequest()], 0, "温度梯度"),
  );
}

let failed = 0;
for (const result of results) {
  if (result.verdict !== "OK") failed += 1;
  console.log(
    `${result.verdict.padEnd(12)} | ${String(result.ms).padStart(6)}ms | ${result.detail.padEnd(24)} | ${result.label}`,
  );
}

console.log(
  failed === 0
    ? `\nAll ${results.length} requests framed and answered correctly.`
    : `\n${failed} of ${results.length} requests failed.`,
);
process.exit(failed === 0 ? 0 : 1);
