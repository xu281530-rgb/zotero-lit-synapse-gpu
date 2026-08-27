/* eslint-env node */

/**
 * Empty note content is a VALUE, not a missing parameter.
 *
 * The dispatch tested `!args.content`, so `write_note(action: "update",
 * content: "")` came back as "action and content are required" — the message
 * for a parameter that was never sent. Emptying a note was therefore not
 * expressible at all, and the schema never said content had to be non-empty,
 * so the refusal read as a bug rather than a rule.
 *
 * It is now a value, but only `update` accepts it, because only there does it
 * mean anything. These tests pin both halves: the erase works and says what it
 * erased, and the two actions where empty content can only be a caller bug
 * still refuse it.
 */

import assert from "node:assert/strict";
import { build } from "esbuild";

const PREFS = {
  "extensions.zotero.zotero-mcp-plugin.write.enabled": true,
  // Left ON for one test below, which reads the summary the user would see.
  "extensions.zotero.zotero-mcp-plugin.write.confirmBeforeMutation": false,
};

let notes = new Map();
let saved = [];
/** The text of the last confirmation dialog, when one was shown. */
let lastPrompt = null;

class FakeNote {
  constructor(key, html) {
    this.key = key;
    this.id = key.charCodeAt(0);
    this.itemType = "note";
    this.libraryID = 1;
    this._note = html;
    this.tags = [];
    this.dateAdded = "2026-01-01 00:00:00";
    this.dateModified = "2026-01-02 00:00:00";
    this.parentKey = undefined;
  }

  getNote() {
    return this._note;
  }

  setNote(html) {
    this._note = html;
  }

  addTag(tag) {
    this.tags.push({ tag });
  }

  getTags() {
    return this.tags;
  }

  isNote() {
    return true;
  }

  isAttachment() {
    return false;
  }

  isAnnotation() {
    return false;
  }

  isRegularItem() {
    return false;
  }

  async saveTx() {
    saved.push({ key: this.key, note: this._note });
    notes.set(this.key, this);
    return true;
  }

  async save() {
    return this.saveTx();
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
  Item: class {
    constructor(itemType) {
      Object.assign(this, new FakeNote(`NEW${notes.size + 1}`, ""));
      this.itemType = itemType;
    }
  },
  Items: {
    getByLibraryAndKeyAsync: async (_libraryID, key) => notes.get(key) ?? false,
  },
  DB: { executeTransaction: async (fn) => fn() },
  getMainWindow: () => ({}),
  logError: () => {},
  debug: () => {},
};
// The plugin builds notes with `new Zotero.Item('note')` and then calls the
// prototype methods, so the class above has to carry them.
Object.setPrototypeOf(globalThis.Zotero.Item.prototype, FakeNote.prototype);

globalThis.ztoolkit = { log: () => {} };
globalThis.Cc = {};
globalThis.Ci = {};
globalThis.Services = {
  uuid: { generateUUID: () => "{00000000-0000-0000-0000-000000000000}" },
  prompt: {
    confirm: (_win, _title, text) => {
      lastPrompt = text;
      return true;
    },
  },
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
  return {
    result: JSON.parse(body.result.content[0].text),
    isError: body.result.isError === true,
  };
}

function writeNote(args) {
  return callTool("write_note", args);
}

function reset() {
  notes = new Map();
  saved = [];
  lastPrompt = null;
  PREFS["extensions.zotero.zotero-mcp-plugin.write.confirmBeforeMutation"] =
    false;
  notes.set("NOTE0001", new FakeNote("NOTE0001", "<p>Existing reading note</p>"));
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

await test("update with an empty string CLEARS the note", async () => {
  const before = notes.get("NOTE0001").getNote().length;
  const { result, error } = await writeNote({
    action: "update",
    noteKey: "NOTE0001",
    content: "",
  });
  assert.equal(error, undefined, `unexpected error: ${error}`);
  assert.equal(result.success, true);
  assert.equal(notes.get("NOTE0001").getNote(), "", "the note must be empty");
  assert.equal(result.data.cleared, true);
  assert.equal(result.data.previousContentLength, before);
  assert.match(
    result.metadata.message,
    /CLEARED/,
    "the receipt must say an erase happened, not 'updated successfully'",
  );
});

await test("whitespace-only content clears too, and says so", async () => {
  const { result, error } = await writeNote({
    action: "update",
    noteKey: "NOTE0001",
    content: "   \n  ",
  });
  assert.equal(error, undefined, `unexpected error: ${error}`);
  assert.equal(result.data.cleared, true, "whitespace reduces to empty HTML");
  assert.equal(notes.get("NOTE0001").getNote(), "");
});

await test("a normal update is not reported as a clear", async () => {
  const { result } = await writeNote({
    action: "update",
    noteKey: "NOTE0001",
    content: "New body",
  });
  assert.equal(result.data.cleared, undefined);
  assert.match(result.metadata.message, /updated successfully/);
});

await test("omitting content is still an error, and says which", async () => {
  const { result, error } = await writeNote({
    action: "update",
    noteKey: "NOTE0001",
  });
  assert.equal(result, undefined);
  assert.match(error, /content is required/);
  assert.match(error, /Received nothing/);
  assert.equal(
    notes.get("NOTE0001").getNote(),
    "<p>Existing reading note</p>",
    "nothing may be written",
  );
});

await test("a non-string content is refused before anything is written", async () => {
  const { result, error } = await writeNote({
    action: "update",
    noteKey: "NOTE0001",
    content: 42,
  });
  assert.equal(result, undefined);
  assert.match(error, /must be a string/);
  assert.equal(saved.length, 0);
});

await test("create refuses empty content", async () => {
  const { result, error, isError } = await writeNote({
    action: "create",
    content: "",
  });
  assert.equal(error, undefined);
  assert.equal(isError, true, "a rejected write must be an MCP tool error");
  assert.equal(result.success, false);
  assert.match(result.error, /nothing to create/);
  assert.equal(saved.length, 0, "no empty note may be left in the library");
});

await test("append refuses empty content", async () => {
  const { result, error, isError } = await writeNote({
    action: "append",
    noteKey: "NOTE0001",
    content: "",
  });
  assert.equal(error, undefined);
  assert.equal(isError, true, "a rejected write must be an MCP tool error");
  assert.equal(result.success, false);
  assert.match(result.error, /nothing to append/);
  assert.equal(saved.length, 0);
});

await test("a missing abstract is a real tool failure", async () => {
  const { result, error } = await callTool("get_item_abstract", {
    itemKey: "MISSING1",
  });
  assert.equal(
    result,
    undefined,
    "an HTTP 404 must not be wrapped as a successful tool result",
  );
  assert.match(error, /Item with key MISSING1 not found/);
});

await test("the confirmation dialog says an update will CLEAR the note", async () => {
  PREFS["extensions.zotero.zotero-mcp-plugin.write.confirmBeforeMutation"] =
    true;
  await writeNote({ action: "update", noteKey: "NOTE0001", content: "" });
  assert.match(
    lastPrompt,
    /CLEARS THE NOTE/,
    "an erase must not look like an ordinary rewrite in the prompt",
  );
});

await test("the confirmation dialog does NOT say that for a real rewrite", async () => {
  PREFS["extensions.zotero.zotero-mcp-plugin.write.confirmBeforeMutation"] =
    true;
  await writeNote({
    action: "update",
    noteKey: "NOTE0001",
    content: "Rewritten",
  });
  assert.doesNotMatch(lastPrompt, /CLEARS THE NOTE/);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
