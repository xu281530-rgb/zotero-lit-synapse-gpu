/* eslint-env node */

/**
 * `write_metadata` rejects malformed or empty updates before saving anything.
 *
 * Tool schemas describe the ideal client payload, but the server still has to
 * defend its own write boundary. A client can send creators as a bare string;
 * the old handler silently ignored it, saved the unchanged item, and answered
 * "Metadata updated" with success:true.
 */

import assert from "node:assert/strict";
import { build } from "esbuild";

const PREFS = {
  "extensions.zotero.zotero-lit-synapse.write.enabled": true,
  "extensions.zotero.zotero-lit-synapse.write.confirmBeforeMutation": false,
};

let saveCount = 0;

class FakeItem {
  constructor() {
    this.key = "ITEM0001";
    this.itemType = "journalArticle";
    this.fields = { title: "Before" };
    this.creators = [
      { creatorTypeID: 1, firstName: "Old", lastName: "Author" },
    ];
  }

  isRegularItem() {
    return true;
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

  getField(name) {
    return this.fields[name] ?? "";
  }

  setField(name, value) {
    this.fields[name] = value;
  }

  getCreators() {
    return this.creators;
  }

  setCreators(creators) {
    this.creators = creators;
  }

  clone() {
    const copy = new FakeItem();
    copy.fields = { ...this.fields };
    copy.creators = this.creators.map((creator) => ({ ...creator }));
    return copy;
  }

  async saveTx() {
    saveCount += 1;
  }
}

let item = new FakeItem();

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
    getByLibraryAndKeyAsync: async (_libraryID, key) =>
      key === item.key ? item : false,
  },
  CreatorTypes: { getName: () => "author" },
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

async function writeMetadata(args) {
  const response = await server.handleMCPRequest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "write_metadata", arguments: args },
    }),
  );
  const body = JSON.parse(response.body);
  assert.equal(body.error, undefined, "tool failures must not be protocol errors");
  if (body.result.isError && body.result.content[0].text.startsWith("Error executing ")) {
    return { error: body.result.content[0].text, isError: true };
  }
  return {
    result: JSON.parse(body.result.content[0].text),
    isError: body.result.isError === true,
  };
}

function reset() {
  item = new FakeItem();
  saveCount = 0;
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

await test("a creators string is rejected before save", async () => {
  const { result, error } = await writeMetadata({
    itemKey: "ITEM0001",
    creators: "Ada Lovelace",
  });
  assert.equal(result, undefined);
  assert.match(error, /creators must be an array/);
  assert.equal(saveCount, 0);
});

await test("an empty fields object is not reported as an update", async () => {
  const { result, error } = await writeMetadata({
    itemKey: "ITEM0001",
    fields: {},
  });
  assert.equal(result, undefined);
  assert.match(error, /at least one field/);
  assert.equal(saveCount, 0);
});

await test("field values must be strings", async () => {
  const { result, error } = await writeMetadata({
    itemKey: "ITEM0001",
    fields: { DOI: null },
  });
  assert.equal(result, undefined);
  assert.match(error, /fields\.DOI must be a string/);
  assert.equal(saveCount, 0);
});

await test("creator entries require a creatorType", async () => {
  const { result, error } = await writeMetadata({
    itemKey: "ITEM0001",
    creators: [{ firstName: "Ada", lastName: "Lovelace" }],
  });
  assert.equal(result, undefined);
  assert.match(error, /creators\[0\]\.creatorType/);
  assert.equal(saveCount, 0);
});

await test("an empty creators array intentionally clears creators", async () => {
  const { result, error, isError } = await writeMetadata({
    itemKey: "ITEM0001",
    creators: [],
  });
  assert.equal(error, undefined);
  assert.equal(isError, false);
  assert.equal(result.success, true);
  assert.equal(result.data.creatorsUpdated, true);
  assert.deepEqual(item.creators, []);
  assert.equal(saveCount, 1);
});

await test("valid string fields are updated", async () => {
  const { result, error, isError } = await writeMetadata({
    itemKey: "ITEM0001",
    fields: { title: "After", DOI: "10.1000/test" },
  });
  assert.equal(error, undefined);
  assert.equal(isError, false);
  assert.equal(result.success, true);
  assert.equal(item.fields.title, "After");
  assert.equal(item.fields.DOI, "10.1000/test");
  assert.equal(saveCount, 1);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
