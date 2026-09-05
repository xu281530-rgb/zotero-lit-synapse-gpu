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

// ---------------------------------------------------------------------------
// Resources. `instructions` lands in the client's system prompt, so it is paid
// for on every turn exactly like tools/list is. The five stages moved out of it
// into zotero://guide/workflow; what stays has to be short enough to be worth
// that placement AND still name the road out, or the guide is text nobody
// fetches.
// ---------------------------------------------------------------------------
const initialized = bodyOf(
  await server.handleMCPRequest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 900,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "1" } },
    }),
  ),
).result;

assert.ok(
  initialized.instructions.length < 2000,
  `instructions is ${initialized.instructions.length} chars and is re-sent every turn; ` +
    "stage-by-stage procedure belongs in zotero://guide/workflow",
);
for (const pointer of ["zotero://guide/workflow", "zotero://tool/"]) {
  assert.ok(
    initialized.instructions.includes(pointer),
    `instructions must name ${pointer}, or the detail it points at is never read`,
  );
}
assert.ok(
  initialized.capabilities.resources,
  "resources must be declared, now that they carry the workflow and the methods",
);

const resources = bodyOf(
  await server.handleMCPRequest(
    JSON.stringify({ jsonrpc: "2.0", id: 901, method: "resources/list" }),
  ),
).result.resources;
assert.ok(resources.length > 1, "resources/list still returns (almost) nothing");
assert.ok(
  resources.some((entry) => entry.uri === "zotero://guide/workflow"),
  "the workflow guide is not listed",
);

// Every listed resource must resolve; a listing that points at nothing is
// worse than an empty listing, because the caller spends a round trip finding
// out. This is what the old handler did - it declared the capability and
// returned [] - and resources/read was not routed at all.
for (const entry of resources) {
  const read = bodyOf(
    await server.handleMCPRequest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 902,
        method: "resources/read",
        params: { uri: entry.uri },
      }),
    ),
  );
  assert.ok(read.result, `${entry.uri} listed but did not resolve`);
  assert.equal(read.result.contents[0].uri, entry.uri);
  assert.ok(
    read.result.contents[0].text.length > 100,
    `${entry.uri} resolved to nothing worth fetching`,
  );
}

const workflow = bodyOf(
  await server.handleMCPRequest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 903,
      method: "resources/read",
      params: { uri: "zotero://guide/workflow" },
    }),
  ),
).result.contents[0].text;
// Moved verbatim: all five stages, and the closing rule that no tool returns a
// whole document, have to still be there.
for (const stage of ["STAGE 0", "STAGE 1", "STAGE 2", "STAGE 3", "STAGE 4"]) {
  assert.ok(workflow.includes(stage), `${stage} was lost moving the guide out`);
}
assert.ok(workflow.includes("BEYOND THE FUNNEL"));

const missing = bodyOf(
  await server.handleMCPRequest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 904,
      method: "resources/read",
      params: { uri: "zotero://guide/nope" },
    }),
  ),
);
assert.equal(missing.error.code, -32002);

assert.equal(
  Object.prototype.hasOwnProperty.call(server, "clientSessions"),
  false,
  "a stateless server must not retain unreachable client sessions",
);
assert.equal(server.getStatus().transport.sessionMode, "stateless");

console.log("MCP JSON-RPC validation and stateless transport tests passed");
