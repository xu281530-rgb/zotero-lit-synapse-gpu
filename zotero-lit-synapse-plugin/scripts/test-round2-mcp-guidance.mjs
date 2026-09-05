import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";

let lookup;
globalThis.Zotero = {
  DataDirectory: { dir: "" },
  Libraries: { userLibraryID: 1 },
  Items: { getByLibraryAndKeyAsync: (...args) => lookup(...args) },
  Prefs: {
    get: () => false,
    set: () => {},
    registerObserver: () => Symbol("observer"),
    unregisterObserver: () => {},
  },
  debug: () => {},
};
globalThis.ztoolkit = { log: () => {} };
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
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`;
const { StreamableMCPServer } = await import(moduleUrl);
const server = new StreamableMCPServer();
let availability = "not_indexed";
let availabilityCalls = 0;
server.annotateFullTextAvailability = async (rows) => {
  availabilityCalls++;
  for (const row of rows) row.fullText = availability;
};
let requestID = 0;
async function rpc(method, params) {
  const response = await server.handleMCPRequest(
    JSON.stringify({ jsonrpc: "2.0", id: ++requestID, method, params }),
  );
  return JSON.parse(response.body);
}
async function documentError(args) {
  const response = await rpc("tools/call", {
    name: "get_document_chunks",
    arguments: args,
  });
  assert.equal(
    response.error,
    undefined,
    "a document lookup failure remains a tool execution error",
  );
  assert.equal(response.result.isError, true);
  return response.result.content.map((part) => part.text || "").join("\n");
}
const cursorFor = (key, libraryID) =>
  Buffer.from(
    JSON.stringify({ k: key, l: libraryID, o: 1, s: 1, r: "revision" }),
  ).toString("base64");

test("missing document reports its library and key without claiming a text attachment", async () => {
  lookup = async () => false;
  availabilityCalls = 0;
  const message = await documentError({ itemKey: "ZZZZZZZZ", libraryID: 1 });
  assert.match(message, /not found/iu);
  assert.match(message, /ZZZZZZZZ/);
  assert.match(message, /library 1/iu);
  assert.match(message, /itemKey.*libraryID|libraryID.*itemKey/u);
  assert.doesNotMatch(
    message,
    /has a text attachment|build\/refresh|rebuild/iu,
  );
  assert.equal(availabilityCalls, 0);
});

test("cursor-only reading validates the cursor's document in its original library", async () => {
  const lookups = [];
  lookup = async (libraryID, key) => {
    lookups.push({ libraryID, key });
    return false;
  };
  availabilityCalls = 0;
  const message = await documentError({ cursor: cursorFor("OTHERKEY", 4) });
  assert.match(message, /not found/iu);
  assert.match(message, /library 4/iu);
  assert.deepEqual(lookups, [{ libraryID: 4, key: "OTHERKEY" }]);
  assert.equal(availabilityCalls, 0);
});

test("cursor validation rejects attachment and note keys using the actual cursor identity", async () => {
  for (const kind of ["Attachment", "Note"]) {
    lookup = async () => ({ [`is${kind}`]: () => true, parentKey: "PARENT01" });
    const message = await documentError({ cursor: cursorFor("CHILD001", 3) });
    assert.match(message, new RegExp(kind, "iu"));
    assert.match(message, /PARENT01/);
    assert.doesNotMatch(
      message,
      /has a text attachment|not in the semantic index/iu,
    );
  }
});

test("lookup errors remain lookup errors instead of inventing an index state", async () => {
  lookup = async () => {
    throw new Error("Item database temporarily unavailable");
  };
  availabilityCalls = 0;
  const message = await documentError({ itemKey: "PAPER001" });
  assert.match(message, /Item database temporarily unavailable/);
  assert.doesNotMatch(
    message,
    /has a text attachment|not in the semantic index/iu,
  );
  assert.equal(availabilityCalls, 0);
});

test("existing papers keep distinct missing source, parse failure and unindexed guidance", async () => {
  lookup = async () => ({ isRegularItem: () => true });
  for (const [state, explanation] of [
    ["no_source", /has no PDF.*attachment/iu],
    ["parse_failed", /could not be parsed/iu],
    ["not_indexed", /not in the semantic index/iu],
  ]) {
    availability = state;
    const message = await documentError({ itemKey: "PAPER001" });
    assert.match(message, explanation);
    assert.doesNotMatch(message, /not found/iu);
  }
});

test("method resource identifies skipped shadow diagnostics as unmeasured, not zero hits", async () => {
  const response = await rpc("resources/read", {
    uri: "zotero://tool/hybrid_search",
  });
  assert.equal(response.error, undefined);
  const method = response.result.contents.map((part) => part.text).join("\n");
  assert.match(method, /skipped_shadow/);
  assert.match(method, /not measured|unmeasured|not collected/iu);
  assert.match(method, /null/iu);
  assert.match(method, /zero hits/iu);
  assert.doesNotMatch(method, /where it is measured and changes nothing/iu);
});
