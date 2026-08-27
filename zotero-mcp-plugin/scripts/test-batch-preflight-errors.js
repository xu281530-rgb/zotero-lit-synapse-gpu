/* eslint-env node */

/**
 * A rejected batch is a FAILED tool call, and it still names the offending keys.
 *
 * `move_items_to_collection` and `merge_items` answer a rejected preflight
 * with HTTP 422 and a body listing exactly what was wrong. The MCP wrappers
 * used to parse that body and return it, so the call came back as a
 * SUCCESSFUL tool result that happened to contain the word "rejected" - and a
 * client, an auto-retry loop or a workflow engine carried on as though the
 * library had been reorganised.
 *
 * These tests pin both halves of the fix: the call fails, AND the failure
 * still carries the list, because a bare "rejected" would trade one broken
 * answer for another.
 *
 * They also pin what must NOT become an error: merge_items' HTTP 207, where
 * each group is atomic and the earlier groups really did merge.
 */

import assert from "node:assert/strict";
import { build } from "esbuild";

const PREFS = {
  "extensions.zotero.zotero-mcp-plugin.write.enabled": true,
  "extensions.zotero.zotero-mcp-plugin.write.confirmBeforeMutation": false,
};

let items = new Map();
let collections = new Map();
/** Master keys whose Zotero.Items.merge() must throw, for the 207 case. */
let failingMerges = new Set();
let mergeCalls = [];
let addedTo = [];
let removedFrom = [];

class FakeCollection {
  constructor(key, name, parentKey = false) {
    this.key = key;
    this.name = name;
    this.parentKey = parentKey;
    this.libraryID = 1;
    this.id = key.charCodeAt(0);
  }

  async addItems(ids) {
    addedTo.push({ collection: this.key, ids });
  }

  async removeItems(ids) {
    removedFrom.push({ collection: this.key, ids });
  }
}

class FakeItem {
  constructor(key, options = {}) {
    this.key = key;
    this.id = options.id ?? key.charCodeAt(0);
    this.itemType = options.itemType ?? "journalArticle";
    this.deleted = options.deleted ?? false;
    this.parentItemID = options.parentItemID ?? null;
    this.dateAdded = options.dateAdded ?? "2026-01-01 00:00:00";
    this.fields = options.fields ?? { title: `Paper ${key}` };
    this.collectionKeys = options.collections ?? [];
  }

  getField(name) {
    return this.fields[name] ?? "";
  }

  getCreators() {
    return [];
  }

  getAttachments() {
    return [];
  }

  getCollections() {
    return this.collectionKeys.map((key) => collections.get(key)?.id);
  }

  isAttachment() {
    return false;
  }

  isNote() {
    return false;
  }

  isAnnotation() {
    return false;
  }

  isRegularItem() {
    return true;
  }
}

globalThis.Zotero = {
  DataDirectory: { dir: "" },
  Prefs: {
    get: (name) => PREFS[name],
    set: () => {},
    registerObserver: () => Symbol("observer"),
    unregisterObserver: () => {},
  },
  Libraries: { userLibraryID: 1 },
  Items: {
    getByLibraryAndKeyAsync: async (_libraryID, key) => items.get(key) ?? false,
    get: (ids) =>
      (Array.isArray(ids) ? ids : [ids])
        .map((id) => [...items.values()].find((item) => item.id === id))
        .filter(Boolean),
    merge: async (master, others) => {
      if (failingMerges.has(master.key)) {
        throw new Error(`Simulated merge failure for ${master.key}`);
      }
      mergeCalls.push({
        master: master.key,
        others: others.map((item) => item.key),
      });
    },
  },
  Collections: {
    getByLibraryAndKeyAsync: async (_libraryID, key) =>
      collections.get(key) ?? false,
    getByLibraryAndKey: (_libraryID, key) => collections.get(key) ?? false,
    get: (ids) =>
      (Array.isArray(ids) ? ids : [ids])
        .map((id) => [...collections.values()].find((c) => c.id === id))
        .filter(Boolean),
  },
  DB: { executeTransaction: async (fn) => fn() },
  getMainWindow: () => null,
  logError: () => {},
  debug: () => {},
};
globalThis.ztoolkit = { log: () => {} };
globalThis.Cc = {};
globalThis.Ci = {};
globalThis.Services = {
  uuid: { generateUUID: () => "{00000000-0000-0000-0000-000000000000}" },
  prompt: { confirm: () => true },
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

const server = new StreamableMCPServer();

/** Returns { error } for a failed tool call, { result } for a successful one. */
async function callTool(name, args) {
  const response = await server.handleMCPRequest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  );
  const body = JSON.parse(response.body);
  if (body.error) return { error: body.error.message };
  return { result: JSON.parse(body.result.content[0].text) };
}

function reset() {
  items = new Map();
  collections = new Map();
  failingMerges = new Set();
  mergeCalls = [];
  addedTo = [];
  removedFrom = [];
  collections.set("TARGET01", new FakeCollection("TARGET01", "Solidification"));
  collections.set("SOURCE01", new FakeCollection("SOURCE01", "Inbox"));
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    reset();
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
    failed += 1;
  }
}

// ---------------------------------------------------------------- move ----

await test("a move whose preflight passes is a successful tool result", async () => {
  items.set("ITEM0001", new FakeItem("ITEM0001", { collections: ["SOURCE01"] }));
  const { result, error } = await callTool("move_items_to_collection", {
    toCollectionKey: "TARGET01",
    itemKeys: ["ITEM0001"],
  });
  assert.equal(error, undefined, `unexpected error: ${error}`);
  assert.equal(result.applied, true);
  assert.equal(addedTo.length, 1);
  assert.equal(removedFrom.length, 1);
});

await test("a move with a missing key FAILS the tool call", async () => {
  items.set("ITEM0001", new FakeItem("ITEM0001"));
  const { result, error } = await callTool("move_items_to_collection", {
    toCollectionKey: "TARGET01",
    itemKeys: ["ITEM0001", "GONE0001"],
  });
  assert.equal(
    result,
    undefined,
    "a rejected preflight must not come back as a successful result",
  );
  assert.match(error, /rejected before anything was written/);
  assert.match(error, /GONE0001/, "the error must name the offending key");
  assert.equal(addedTo.length, 0, "nothing may be written");
});

await test("a move rejected for a child item explains why", async () => {
  items.set("ITEM0001", new FakeItem("ITEM0001"));
  items.set("CHILD001", new FakeItem("CHILD001", { parentItemID: 42 }));
  const { error } = await callTool("move_items_to_collection", {
    toCollectionKey: "TARGET01",
    itemKeys: ["ITEM0001", "CHILD001"],
  });
  assert.match(error, /CHILD001/);
  assert.match(error, /Cannot be filed in a collection/);
  assert.match(
    error,
    /1 of the keys you passed were movable; none moved/,
    "the error must say how much the caller is losing",
  );
});

await test("a dry run that fails preflight fails the same way", async () => {
  items.set("ITEM0001", new FakeItem("ITEM0001"));
  const { result, error } = await callTool("move_items_to_collection", {
    toCollectionKey: "TARGET01",
    itemKeys: ["ITEM0001", "GONE0001"],
    dryRun: true,
  });
  assert.equal(result, undefined);
  assert.match(error, /GONE0001/);
});

await test("a missing target collection FAILS the tool call", async () => {
  items.set("ITEM0001", new FakeItem("ITEM0001"));
  const { result, error } = await callTool("move_items_to_collection", {
    toCollectionKey: "NOSUCH01",
    itemKeys: ["ITEM0001"],
  });
  assert.equal(result, undefined);
  assert.match(error, /NOSUCH01/);
});

// --------------------------------------------------------------- merge ----

await test("a merge whose preflight passes is a successful tool result", async () => {
  items.set("ITEM0001", new FakeItem("ITEM0001", { fields: { title: "A", DOI: "10.1/x" } }));
  items.set("ITEM0002", new FakeItem("ITEM0002", { fields: { title: "A" } }));
  const { result, error } = await callTool("merge_items", {
    groups: [{ itemKeys: ["ITEM0001", "ITEM0002"] }],
  });
  assert.equal(error, undefined, `unexpected error: ${error}`);
  assert.equal(result.applied, true);
  assert.equal(mergeCalls.length, 1);
});

await test("a merge group with a missing key FAILS the tool call", async () => {
  items.set("ITEM0001", new FakeItem("ITEM0001"));
  const { result, error } = await callTool("merge_items", {
    groups: [{ itemKeys: ["ITEM0001", "GONE0001"] }],
  });
  assert.equal(
    result,
    undefined,
    "a rejected preflight must not come back as a successful result",
  );
  assert.match(error, /rejected before anything was written/);
  assert.match(error, /GONE0001/, "the error must name the offending key");
  assert.match(error, /group 1/, "the error must say which group");
  assert.equal(mergeCalls.length, 0, "nothing may be merged");
});

await test("a merge group of mixed item types FAILS and says so", async () => {
  items.set("ITEM0001", new FakeItem("ITEM0001", { itemType: "journalArticle" }));
  items.set("ITEM0002", new FakeItem("ITEM0002", { itemType: "book" }));
  const { result, error } = await callTool("merge_items", {
    groups: [{ itemKeys: ["ITEM0001", "ITEM0002"] }],
  });
  assert.equal(result, undefined);
  assert.match(error, /group 1/);
  assert.equal(mergeCalls.length, 0);
});

await test(
  "a PARTIAL merge stays a result, because earlier groups really merged",
  async () => {
    items.set("ITEM0001", new FakeItem("ITEM0001", { fields: { title: "A", DOI: "10.1/a" } }));
    items.set("ITEM0002", new FakeItem("ITEM0002", { fields: { title: "A" } }));
    items.set("ITEM0003", new FakeItem("ITEM0003", { fields: { title: "B", DOI: "10.1/b" } }));
    items.set("ITEM0004", new FakeItem("ITEM0004", { fields: { title: "B" } }));
    failingMerges.add("ITEM0003");

    const { result, error } = await callTool("merge_items", {
      groups: [
        { itemKeys: ["ITEM0001", "ITEM0002"], masterItemKey: "ITEM0001" },
        { itemKeys: ["ITEM0003", "ITEM0004"], masterItemKey: "ITEM0003" },
      ],
    });

    assert.equal(
      error,
      undefined,
      "207 must NOT become a tool error - the first group was really merged",
    );
    assert.equal(result.applied, "partial");
    assert.deepEqual(result.mergedGroups, ["ITEM0001"]);
    assert.equal(result.stoppedAt.masterItemKey, "ITEM0003");
    assert.equal(mergeCalls.length, 1);
  },
);

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
