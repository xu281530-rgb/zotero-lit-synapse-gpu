/* eslint-env node */

import assert from "node:assert/strict";
import { build } from "esbuild";

globalThis.Zotero = {
  DataDirectory: { dir: "" },
  Prefs: {
    get: () => false,
    set: () => {},
    registerObserver: () => Symbol("observer"),
    unregisterObserver: () => {},
  },
  debug: () => {},
};
const capturedLogs = [];
globalThis.ztoolkit = {
  log: (message) => capturedLogs.push(String(message)),
};
globalThis.Cc = {};
globalThis.Ci = {};
globalThis.Services = {
  uuid: { generateUUID: () => "{00000000-0000-0000-0000-000000000000}" },
};

const bundled = await build({
  entryPoints: ["src/modules/streamableMCPServer.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  loader: { ".json": "json" },
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(
  bundled.outputFiles[0].text,
).toString("base64")}`;
const { StreamableMCPServer } = await import(moduleUrl);

function bodyOf(response) {
  return response.body ? JSON.parse(response.body) : null;
}

const server = new StreamableMCPServer();

const privateParseMarker = "PRIVATE_PARSE_MARKER";
const parseFailure = await server.handleMCPRequest(
  `{"secret":${privateParseMarker}}`,
);
assert.equal(parseFailure.status, 400);
assert.equal(bodyOf(parseFailure).error.code, -32700);
assert.doesNotMatch(
  capturedLogs.join("\n"),
  /PRIVATE_/,
  "JSON parser diagnostics must not reintroduce request-body content",
);
assert.match(
  capturedLogs.at(-1),
  /^\[StreamableMCP\] #0 Parse error: invalid JSON \(body \d+ chars; content omitted\)$/,
  "parse diagnostics must be stable across JavaScript runtimes",
);

const valid = await server.handleMCPRequest(
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
);
assert.equal(valid.status, 200);
assert.deepEqual(bodyOf(valid), { jsonrpc: "2.0", id: 1, result: {} });

const nullId = await server.handleMCPRequest(
  JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }),
);
assert.equal(nullId.status, 200);
assert.deepEqual(bodyOf(nullId), { jsonrpc: "2.0", id: null, result: {} });

for (const request of [
  { id: 2, method: "ping" },
  { jsonrpc: "1.0", id: 3, method: "ping" },
  { jsonrpc: 2, id: 4, method: "ping" },
  { jsonrpc: "2.0", id: { invalid: true }, method: "ping" },
  { jsonrpc: "2.0", id: false, method: "ping" },
]) {
  const response = await server.handleMCPRequest(JSON.stringify(request));
  assert.equal(response.status, 400, JSON.stringify(request));
  assert.equal(bodyOf(response).error.code, -32600, JSON.stringify(request));
  assert.equal(bodyOf(response).id, null, JSON.stringify(request));
}

const notification = await server.handleMCPRequest(
  JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }),
);
assert.equal(notification.status, 202);
assert.equal(notification.body, "");

for (let index = 0; index < 100; index += 1) {
  const response = await server.handleMCPRequest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1000 + index,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "protocol-test", version: "1" },
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers["Mcp-Session-Id"], undefined);
}

assert.equal(
  Object.prototype.hasOwnProperty.call(server, "clientSessions"),
  false,
  "a stateless server must not retain unreachable client sessions",
);
assert.equal(server.getStatus().transport.sessionMode, "stateless");

console.log("MCP JSON-RPC validation and stateless transport tests passed");
