/* eslint-env node */

/**
 * Drives `openWikiPanel` end to end over a fake Zotero window.
 *
 * The Wiki tab is created before its data is loaded, so anything the load
 * throws used to reject out of an un-awaited `void openWikiPanel(win)` and
 * leave the tab mounted with nothing in it - a blank page whose real cause was
 * visible only in the Debug Output. These tests pin both halves of the fix:
 * a healthy library renders its pages, and a failing storage layer renders a
 * failure card while still logging the untouched exception.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-panel-"));

// --- Fake DOM -------------------------------------------------------------

function createNode(tag) {
  const node = {
    tagName: tag,
    id: "",
    className: "",
    type: "",
    title: "",
    hidden: false,
    width: 0,
    height: 0,
    textContent: "",
    parent: null,
    children: [],
    listeners: new Map(),
    classList: {
      add(name) {
        node.className = `${node.className} ${name}`.trim();
      },
    },
    setAttribute() {},
    append(...kids) {
      for (const kid of kids) {
        kid.parent = node;
        node.children.push(kid);
      }
    },
    appendChild(kid) {
      node.append(kid);
      return kid;
    },
    replaceChildren(...kids) {
      node.children = [];
      node.append(...kids);
    },
    addEventListener(type, handler) {
      const existing = node.listeners.get(type) ?? [];
      existing.push(handler);
      node.listeners.set(type, existing);
    },
    remove() {
      if (!node.parent) return;
      node.parent.children = node.parent.children.filter(
        (child) => child !== node,
      );
      node.parent = null;
    },
    querySelector(selector) {
      const wanted = selector.replace(/^#/u, "");
      for (const child of node.children) {
        if (child.id === wanted) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    },
    getContext: () => null,
  };
  return node;
}

/** All text rendered under a node, in document order. */
function textOf(node) {
  return [node.textContent, ...node.children.map(textOf)].join(" ");
}

function findByClass(node, className) {
  const hit = node.className.split(/\s+/u).includes(className) ? [node] : [];
  return hit.concat(...node.children.map((child) => findByClass(child, className)));
}

// --- Fake Zotero ----------------------------------------------------------

/**
 * A row shaped like the ones `Zotero.DB.queryAsync` returns: a Proxy that
 * resolves column names through `getResultByName` and throws
 * `DB column '<name>' not found` for anything the query did not select.
 * Rendering the panel over plain objects would not reproduce the blank tab.
 */
function zoteroRow(columns) {
  const target = {
    getResultByName(name) {
      if (!Object.prototype.hasOwnProperty.call(columns, name)) {
        throw new Error(`no such column: ${name}`);
      }
      return columns[name];
    },
  };
  return new Proxy(target, {
    get(t, name) {
      if (name === "then") return undefined;
      try {
        return t.getResultByName(name);
      } catch {
        throw new Error(`DB column '${String(name)}' not found`);
      }
    },
    has(t, name) {
      try {
        return !!t.getResultByName(name);
      } catch {
        return false;
      }
    },
  });
}

function adapt(sqlite, failOn) {
  let depth = 0;
  return {
    async queryAsync(sql, params = []) {
      if (failOn && failOn.test(sql)) {
        throw new Error("the Wiki database could not be read");
      }
      const statement = sqlite.prepare(sql);
      const values = params.map((value) =>
        typeof value === "boolean" ? (value ? 1 : 0) : value,
      );
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) {
        return statement.all(...values).map(zoteroRow);
      }
      statement.run(...values);
      return [];
    },
    async valueQueryAsync(sql, params = []) {
      const row = sqlite.prepare(sql).get(...params);
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(fn) {
      if (depth > 0) return fn();
      depth += 1;
      sqlite.exec("BEGIN");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
}

const logged = [];
const loggedErrors = [];

globalThis.PathUtils = { join: (...parts) => parts.join("/") };
globalThis.IOUtils = { writeUTF8: async () => undefined };
globalThis.ztoolkit = {
  log: (...args) => logged.push(args),
};
// The panel reaches the store through getWikiStore(), which builds one from
// `new Zotero.DBConnection(path)`. Handing back our own adapter is what lets
// these tests drive the real singleton wiring rather than a stand-in.
let nextConnection = null;
globalThis.Zotero = {
  Libraries: { userLibraryID: 1 },
  DataDirectory: { dir: tempDir },
  logError: (error) => loggedErrors.push(error),
  DBConnection: function () {
    if (!nextConnection) throw new Error("no Wiki DB connection was staged");
    return nextConnection;
  },
};

const { WikiStore, resetWikiStore } = await import(
  "../src/modules/wiki/wikiStore.ts"
);
const { resetWikiService } = await import(
  "../src/modules/wiki/wikiService.ts"
);
const { openWikiPanel } = await import("../src/modules/wiki/wikiPanel.ts");
const { hashWikiText } = await import(
  "../src/modules/wiki/wikiCanonicalizer.ts"
);

/**
 * Point the Wiki singletons at `connection` for the next render.
 */
async function useConnection(connection) {
  await resetWikiStore();
  resetWikiService();
  nextConnection = connection;
}

function createWindow() {
  const containers = [];
  return {
    containers,
    document: {
      createElement: createNode,
      createXULElement: createNode,
      getElementById: () => null,
      documentElement: createNode("html"),
    },
    ZoteroPane: { getSelectedLibraryID: () => 1 },
    Zotero_Tabs: {
      add() {
        const container = createNode("box");
        containers.push(container);
        return { id: `wiki-tab-${containers.length}`, container };
      },
      select() {},
      close() {},
    },
  };
}

async function seed(sqlite) {
  const store = new WikiStore(adapt(sqlite));
  await store.initialize();
  await store.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "CREATE_PAGE",
        ref: "page:plain",
        // No primaryConcept - primary_concept_id is written as SQL NULL, the
        // exact shape that used to blank the tab.
        canonicalTitle: "Columnar band control",
      },
      {
        action: "ADD_CLAIM",
        pageId: "page:plain",
        ref: "claim:plain",
        claimText: "A slower pull rate widens the columnar band.",
        claimType: "mechanism",
        epistemicStatus: "provisional",
        coverageLevel: "chunk_local",
        confidence: 0.6,
        evidence: [
          {
            libraryID: 1,
            itemKey: "ITEMP001",
            chunkIdSnapshot: 1,
            chunkTextHash: await hashWikiText("A slower pull rate widens it."),
            sourceContentHash: "content-v1",
            sourceChunkSignature: "paragraph-v3:10:5",
            sourceResetGeneration: "reset-1",
            excerpt: "a slower pull rate widens the columnar band",
            evidenceRole: "SUPPORTS",
            readDepth: "chunk_local",
          },
        ],
      },
    ],
  });
  return store;
}

// --- A healthy library renders its pages ----------------------------------

{
  const sqlite = new DatabaseSync(path.join(tempDir, "ok.sqlite"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  await seed(sqlite);
  await useConnection(adapt(sqlite));
  const win = createWindow();

  await openWikiPanel(win);

  const container = win.containers[0];
  const panel = container.querySelector("#zotero-mcp-wiki-panel");
  assert.ok(panel, "a successful render must mount the Wiki panel");
  assert.ok(
    !panel.className.includes("zmp-wiki-panel-error"),
    "a successful render must not mount the failure card",
  );
  const rendered = textOf(panel);
  assert.match(
    rendered,
    /Columnar band control/u,
    "the page with a NULL primary concept must be listed",
  );
  assert.match(
    rendered,
    /A slower pull rate widens the columnar band\./u,
    "its claim must render",
  );
  assert.ok(
    container.querySelector("#zotero-mcp-wiki-pages"),
    "the page list must mount",
  );
  assert.equal(
    loggedErrors.length,
    0,
    "a successful render must not log an error",
  );
  sqlite.close();
}

// --- A failing load renders a failure card, not a blank tab ---------------

{
  const sqlite = new DatabaseSync(path.join(tempDir, "fail.sqlite"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  await seed(sqlite);
  // A connection whose page reads fail, standing in for any storage fault.
  await useConnection(adapt(sqlite, /FROM wiki_pages/u));
  const win = createWindow();

  await openWikiPanel(win);

  const container = win.containers[0];
  const panel = container.querySelector("#zotero-mcp-wiki-panel");
  assert.ok(panel, "a failing render must still mount something in the tab");
  assert.ok(
    panel.className.includes("zmp-wiki-panel-error"),
    "a failing render must mount the failure card",
  );
  const rendered = textOf(panel);
  assert.match(
    rendered,
    /知识库加载失败/u,
    "the tab must say the Wiki failed to load",
  );
  assert.match(
    rendered,
    /the Wiki database could not be read/u,
    "the failure card must show the underlying error, not hide it",
  );
  assert.ok(
    findByClass(panel, "zmp-wiki-error-detail").length === 1,
    "the failure card must carry the stack detail block",
  );
  assert.ok(
    textOf(panel).includes("重试"),
    "the failure card must offer a retry",
  );
  assert.equal(
    loggedErrors.length,
    1,
    "the untouched exception must reach Zotero.logError",
  );
  assert.match(
    String(loggedErrors[0].stack ?? loggedErrors[0]),
    /the Wiki database could not be read/u,
    "the logged exception must be the original error",
  );
  assert.ok(
    logged.some((entry) => String(entry[0]).includes("failed to render")),
    "the failure must also reach ztoolkit.log",
  );
  sqlite.close();
}

fs.rmSync(tempDir, { recursive: true, force: true });

console.log("wiki panel render tests passed");
