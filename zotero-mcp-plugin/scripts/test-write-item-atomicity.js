/* eslint-env node */

/**
 * `write_item(action: "create")` writes everything or nothing.
 *
 * It used to save the new item with `saveTx()` and then re-parent each
 * attachment with its own `saveTx()`. Three separate transactions meant
 * "failed" did not mean "nothing happened": an attachment that could not be
 * saved left the new item standing in the library, and with several
 * attachments some were moved and some were not. The response said
 * `success: false` and named none of it, so the obvious next move — retry the
 * same create — produced a SECOND copy of the item.
 *
 * These tests drive the real `tools/call` entry point against a fake Zotero
 * whose transaction actually rolls back, which is the layer the write tools
 * had no coverage at all.
 */

import assert from "node:assert/strict";
import { build } from "esbuild";

const PREFS = {
  "extensions.zotero.zotero-mcp-plugin.write.enabled": true,
  // No Zotero window in a test process, so the confirmation gate has to be
  // off; it is exercised separately by its own dialog logic.
  "extensions.zotero.zotero-mcp-plugin.write.confirmBeforeMutation": false,
};

/** Every item the fake library has actually committed. */
let committed = new Map();
/** Saves attempted inside the current transaction, undone on rollback. */
let pending = [];
let keyCounter = 0;
let idCounter = 0;
/** Attachment keys whose save() must throw, to simulate a mid-batch failure. */
let failingAttachmentKeys = new Set();

class FakeItem {
  constructor(itemType) {
    this.itemType = itemType;
    this.fields = {};
    this.creators = [];
    this.tags = [];
    this.libraryID = 1;
    this.dateAdded = "2026-08-26 00:00:00";
    this._key = null;
    this._id = null;
    this.parentKey = undefined;
    this._isAttachment = false;
  }

  get key() {
    return this._key;
  }

  get id() {
    return this._id;
  }

  setField(name, value) {
    if (name === "notAField") throw new Error(`Invalid field ${name}`);
    this.fields[name] = value;
  }

  getField(name) {
    return this.fields[name] ?? "";
  }

  setCreators(creators) {
    this.creators = creators;
  }

  addTag(tag) {
    this.tags.push(tag);
  }

  isAttachment() {
    return this._isAttachment;
  }

  isNote() {
    return false;
  }

  isRegularItem() {
    return !this._isAttachment;
  }

  async save() {
    if (this._isAttachment && failingAttachmentKeys.has(this._key)) {
      throw new Error(`Simulated save failure for ${this._key}`);
    }
    if (!this._key) this._key = `NEW${++keyCounter}`;
    if (!this._id) this._id = ++idCounter;
    const previous = committed.has(this._key)
      ? { ...committed.get(this._key) }
      : null;
    pending.push({ key: this._key, previous });
    committed.set(this._key, {
      key: this._key,
      itemType: this.itemType,
      parentKey: this.parentKey,
    });
    return true;
  }

  async saveTx() {
    return this.save();
  }
}

function makeAttachment(key) {
  const attachment = new FakeItem("attachment");
  attachment._isAttachment = true;
  attachment._key = key;
  attachment._id = ++idCounter;
  committed.set(key, { key, itemType: "attachment", parentKey: undefined });
  return attachment;
}

/** The library as it exists before any tool call in a given test. */
let library = new Map();

globalThis.Zotero = {
  DataDirectory: { dir: "" },
  Prefs: {
    get: (name) => PREFS[name],
    set: () => {},
    registerObserver: () => Symbol("observer"),
    unregisterObserver: () => {},
  },
  Libraries: { userLibraryID: 1 },
  Item: FakeItem,
  Items: {
    getByLibraryAndKeyAsync: async (_libraryID, key) => library.get(key) ?? false,
  },
  DB: {
    // A real transaction: anything saved inside it is undone when the body
    // throws. This is the whole point of the test - a fake that just runs the
    // callback would pass even for the broken three-transaction version.
    executeTransaction: async (fn) => {
      pending = [];
      try {
        const result = await fn();
        pending = [];
        return result;
      } catch (error) {
        for (const entry of pending.reverse()) {
          if (entry.previous) committed.set(entry.key, entry.previous);
          else committed.delete(entry.key);
        }
        pending = [];
        throw error;
      }
    },
  },
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

async function callWriteItem(args) {
  const response = await server.handleMCPRequest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "write_item", arguments: args },
    }),
  );
  const body = JSON.parse(response.body);
  if (body.error) return { rpcError: body.error };
  return JSON.parse(body.result.content[0].text);
}

function reset() {
  committed = new Map();
  pending = [];
  library = new Map();
  failingAttachmentKeys = new Set();
  keyCounter = 0;
  idCounter = 0;
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

await test("a create with no attachments commits the item", async () => {
  const result = await callWriteItem({
    action: "create",
    itemType: "journalArticle",
    fields: { title: "Directional solidification" },
  });
  assert.equal(result.success, true);
  assert.equal(committed.size, 1, "exactly one item should be committed");
  assert.equal(result.data.reparentedAttachments.length, 0);
});

await test("a create re-parents every attachment it was given", async () => {
  const one = makeAttachment("ATT00001");
  const two = makeAttachment("ATT00002");
  library.set("ATT00001", one);
  library.set("ATT00002", two);

  const result = await callWriteItem({
    action: "create",
    itemType: "journalArticle",
    fields: { title: "Two PDFs" },
    attachmentKeys: ["ATT00001", "ATT00002"],
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.data.reparentedAttachments, ["ATT00001", "ATT00002"]);
  const newKey = result.data.itemKey;
  assert.equal(committed.get("ATT00001").parentKey, newKey);
  assert.equal(committed.get("ATT00002").parentKey, newKey);
});

await test(
  "a failing attachment rolls the NEW ITEM back, so a retry cannot duplicate it",
  async () => {
    const good = makeAttachment("ATT00001");
    const bad = makeAttachment("ATT00002");
    library.set("ATT00001", good);
    library.set("ATT00002", bad);
    failingAttachmentKeys.add("ATT00002");

    const before = committed.size;
    const result = await callWriteItem({
      action: "create",
      itemType: "journalArticle",
      fields: { title: "Half-written" },
      attachmentKeys: ["ATT00001", "ATT00002"],
    });

    assert.equal(result.success, false, "the call must report failure");
    // The assertion the old three-transaction version failed: the item was
    // already committed by the time the attachment blew up.
    assert.equal(
      committed.size,
      before,
      "the new item must not survive the failure - this is the duplicate-on-retry bug",
    );
    assert.equal(
      committed.get("ATT00001").parentKey,
      undefined,
      "the attachment saved before the failure must be rolled back too",
    );
    assert.equal(
      result.applied,
      false,
      "the receipt must say nothing was applied",
    );
    assert.match(
      result.note,
      /wrote nothing at all/,
      "the receipt must say a retry is safe",
    );
  },
);

await test(
  "an attachmentKey that is not an attachment is reported, not silently dropped",
  async () => {
    const notAnAttachment = new FakeItem("journalArticle");
    notAnAttachment._key = "REG00001";
    library.set("REG00001", notAnAttachment);
    const real = makeAttachment("ATT00001");
    library.set("ATT00001", real);

    const result = await callWriteItem({
      action: "create",
      itemType: "journalArticle",
      fields: { title: "One good, one wrong" },
      attachmentKeys: ["ATT00001", "REG00001", "MISSING1"],
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.data.reparentedAttachments, ["ATT00001"]);
    assert.equal(result.data.skippedAttachments.length, 2);
    const reasons = Object.fromEntries(
      result.data.skippedAttachments.map((entry) => [entry.key, entry.reason]),
    );
    assert.match(reasons.REG00001, /not an attachment/);
    assert.match(reasons.MISSING1, /not found/);
    assert.match(
      result.metadata.message,
      /SKIPPED/,
      "the human-readable message must name the skipped keys too",
    );
  },
);

await test("a bad field aborts before anything is written", async () => {
  const result = await callWriteItem({
    action: "create",
    itemType: "journalArticle",
    fields: { notAField: "x" },
  });
  assert.equal(result.success, false);
  assert.equal(committed.size, 0, "no item may be committed");
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
