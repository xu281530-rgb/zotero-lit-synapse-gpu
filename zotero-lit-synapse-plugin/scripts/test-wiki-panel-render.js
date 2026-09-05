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
    attributes: new Map(),
    style: {},
    classList: {
      add(...names) {
        const present = new Set(node.className.split(/\s+/u).filter(Boolean));
        for (const name of names) present.add(name);
        node.className = Array.from(present).join(" ");
      },
      remove(...names) {
        const gone = new Set(names);
        node.className = node.className
          .split(/\s+/u)
          .filter((name) => name && !gone.has(name))
          .join(" ");
      },
      contains(name) {
        return node.className.split(/\s+/u).includes(name);
      },
    },
    setAttribute(name, value) {
      node.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return node.attributes.get(name) ?? null;
    },
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
    contains(other) {
      if (other === node) return true;
      return node.children.some((child) => child.contains(other));
    },
    focus() {},
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

/**
 * Fire every handler registered for `type`, awaiting async ones.
 *
 * `detail` carries whatever the handler reads off the event - `clientX` and
 * `button` for the drawer's drag gesture, `target` for the dismiss handlers.
 * There is no bubbling here, which is deliberate: a listener that only works
 * because an ancestor caught the event would not be pinned by these tests.
 */
async function fire(node, type, detail = {}) {
  const event = {
    target: node,
    button: 0,
    stopPropagation() {},
    preventDefault() {},
    ...detail,
  };
  for (const handler of node.listeners.get(type) ?? []) await handler(event);
}

/** Drag `entry` horizontally by `dx` pixels and release. */
async function drag(entry, dx) {
  await fire(entry, "mousedown", { clientX: 200, button: 0 });
  await fire(entry, "mousemove", { clientX: 200 + dx });
  await fire(entry, "mouseup", { clientX: 200 + dx });
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
const { openWikiPanel, registerWikiPanel } = await import(
  "../src/modules/wiki/wikiPanel.ts"
);
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

// --- The toolbar entry follows the plugin load order -----------------------

{
  const win = createWindow();
  const toolbar = createNode("toolbar");
  for (const id of ["other-plugin-one", "other-plugin-two"]) {
    const button = createNode("toolbarbutton");
    button.id = id;
    toolbar.appendChild(button);
  }
  win.document.getElementById = (id) =>
    id === "zotero-toolbar" ? toolbar : null;

  registerWikiPanel(win);

  assert.deepEqual(
    toolbar.children.map((child) => child.id),
    ["other-plugin-one", "other-plugin-two", "zotero-lit-synapse-wiki-button"],
    "the MCP icon is appended after plugins loaded before it",
  );
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
  const panel = container.querySelector("#zotero-lit-synapse-wiki-panel");
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
    container.querySelector("#zotero-lit-synapse-wiki-pages"),
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
  const panel = container.querySelector("#zotero-lit-synapse-wiki-panel");
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

// --- A crowded page keeps every claim in its own card ---------------------

/**
 * The complaint the reading column was rebuilt for: with twenty-odd claims the
 * old markup ran them together against one shared rule, so long passages read
 * as a single collapsed block. These assertions pin the structure that fixes
 * it - one card per claim, the claim text in its own element, and the delete
 * control as a sibling of the body rather than inside it, so it can never sit
 * on top of the prose.
 */
async function seedCrowded(sqlite) {
  const store = new WikiStore(adapt(sqlite));
  await store.initialize();
  const actions = [
    {
      action: "CREATE_PAGE",
      ref: "page:ds",
      canonicalTitle: "定向凝固与固态相变控制柱状晶技术",
      primaryConcept: {
        canonicalName: "定向凝固",
        aliases: [
          { alias: "DS", language: "en" },
          { alias: "Directional Solidification", language: "en" },
        ],
      },
    },
    { action: "CREATE_PAGE", ref: "page:other", canonicalTitle: "快速热压定型" },
  ];
  for (let index = 0; index < 24; index += 1) {
    actions.push({
      action: "ADD_CLAIM",
      pageId: "page:ds",
      ref: `claim:ds${index}`,
      claimText:
        `机制 ${index}：定向凝固热处理中，抽拉速率与温度梯度的比值决定固液界面形态，` +
        "比值越低界面越趋于平面，柱状晶带随之展宽，这一段刻意写得很长以验证长文本会撑高卡片而不是彼此重叠。",
      claimType: "mechanism",
      epistemicStatus: "provisional",
      coverageLevel: "chunk_local",
      confidence: 0.6,
      evidence: [
        {
          libraryID: 1,
          itemKey: `ITEMD${String(index).padStart(3, "0")}`,
          chunkIdSnapshot: index + 1,
          chunkTextHash: await hashWikiText(`chunk-${index}`),
          sourceContentHash: `content-${index}`,
          sourceChunkSignature: `paragraph-v3:${index}:5`,
          sourceResetGeneration: "reset-1",
          excerpt: `当前抽拉速率过慢，柱状晶带展宽 ${index} 微米。`,
          evidenceRole: index % 5 === 0 ? "CONTRADICTS" : "SUPPORTS",
          readDepth: "chunk_local",
        },
        {
          libraryID: 1,
          itemKey: "ITEMSHARED",
          chunkIdSnapshot: 900 + index,
          chunkTextHash: await hashWikiText(`shared-${index}`),
          sourceContentHash: "content-shared",
          sourceChunkSignature: `paragraph-v3:${900 + index}:2`,
          sourceResetGeneration: "reset-1",
          excerpt: `跨论文对照片段 ${index}。`,
          evidenceRole: "QUALIFIES",
          readDepth: "section_read",
        },
      ],
    });
  }
  actions.push({
    action: "ADD_CLAIM",
    pageId: "page:other",
    ref: "claim:other",
    claimText: "热压定型阶段的保压时间决定残余应力水平。",
    claimType: "condition",
    epistemicStatus: "supported",
    coverageLevel: "section_read",
    confidence: 0.8,
    evidence: [
      {
        libraryID: 1,
        itemKey: "ITEMHOT001",
        chunkIdSnapshot: 7,
        chunkTextHash: await hashWikiText("hot-press"),
        sourceContentHash: "content-hot",
        sourceChunkSignature: "paragraph-v3:7:1",
        sourceResetGeneration: "reset-1",
        excerpt: "保压 30 分钟后残余应力下降。",
        evidenceRole: "SUPPORTS",
        readDepth: "section_read",
      },
    ],
  });
  await store.commit({ libraryID: 1, userInitiated: true, actions });
  return store;
}

{
  const sqlite = new DatabaseSync(path.join(tempDir, "crowded.sqlite"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  await seedCrowded(sqlite);
  await useConnection(adapt(sqlite));
  const win = createWindow();

  await openWikiPanel(win);

  const panel = win.containers[0].querySelector("#zotero-lit-synapse-wiki-panel");
  const entries = findByClass(panel, "zmp-wiki-page-entry");
  assert.equal(entries.length, 2, "every page must appear in the index");
  const activeEntries = entries.filter((entry) =>
    entry.classList.contains("is-active"),
  );
  assert.equal(
    activeEntries.length,
    1,
    "exactly one index entry may carry the active state",
  );
  assert.equal(
    activeEntries[0].getAttribute("aria-current"),
    "true",
    "the active entry must announce itself to assistive technology",
  );

  // Pages are listed most-recently-updated first, so pick the crowded one by
  // name rather than by position.
  const crowded = entries.find((entry) =>
    textOf(entry).includes("定向凝固与固态相变控制柱状晶技术"),
  );
  const sparse = entries.find((entry) => entry !== crowded);
  await fire(crowded, "click");
  assert.ok(
    crowded.classList.contains("is-active"),
    "opening a page must mark its index entry active",
  );
  assert.equal(
    entries.filter((entry) => entry.classList.contains("is-active")).length,
    1,
    "only one index entry may be active at a time",
  );

  const cards = findByClass(panel, "zmp-wiki-claim");
  assert.equal(cards.length, 24, "each claim must render as its own card");
  for (const card of cards) {
    assert.equal(
      findByClass(card, "zmp-wiki-claim-text").length,
      1,
      "a claim card carries exactly one text block",
    );
    assert.equal(
      findByClass(card, "zmp-wiki-claim").length,
      1,
      "claim cards must be siblings, never nested inside one another",
    );
    const [open] = findByClass(card, "zmp-wiki-claim-open");
    const [remove] = findByClass(card, "zmp-wiki-claim-remove");
    assert.ok(open && remove, "a claim card carries a body and a delete action");
    assert.equal(
      findByClass(open, "zmp-wiki-claim-remove").length,
      0,
      "the delete control must sit beside the prose, not inside it",
    );
    assert.equal(remove.title, "删除论断");
  }
  const rendered = textOf(panel);
  assert.match(
    rendered,
    /这一段刻意写得很长以验证长文本会撑高卡片而不是彼此重叠。/u,
    "long claim text must render in full rather than being truncated",
  );
  assert.equal(
    findByClass(panel, "zmp-wiki-summary-card").length,
    1,
    "the summary must sit in its own paper card",
  );
  for (const heading of ["知识摘要", "术语与别名", "核心知识", "知识条目"]) {
    assert.ok(rendered.includes(heading), `the document must announce ${heading}`);
  }
  // 2.4.3: the page renders the STRUCTURED terms, not a row of alias chips.
  // The seeded concept is 定向凝固 with a bare "DS" and an English full name,
  // which the migration reads as one primary term carrying the Chinese name
  // and the abbreviation, plus one alias term carrying the English name.
  const termRows = findByClass(panel, "zmp-wiki-term-row-cells");
  assert.equal(termRows.length, 2, "every term group must get its own row");
  assert.ok(
    termRows[0].className.includes("is-primary"),
    "the primary term must be the first row",
  );
  const primaryText = textOf(termRows[0]);
  assert.match(primaryText, /定向凝固/u);
  assert.match(primaryText, /DS/u, "a bare abbreviation completes the primary term");
  assert.match(
    textOf(termRows[1]),
    /Directional Solidification/u,
    "the English full name must survive as its own alias term",
  );
  for (const heading of ["序号", "中文术语", "英文术语", "简称"]) {
    assert.ok(
      textOf(panel).includes(heading),
      `the term table must announce ${heading}`,
    );
  }
  // 2.4.4: the entry view uses the same tintable cells as the terminology
  // view, so a reader does not have to switch views to see which of a term's
  // names a paper actually vouches for. These names were typed into
  // CREATE_PAGE by the model rather than quoted from a paper, so they are
  // marked as the model's - the one thing that must never happen is a name
  // nobody read in a paper being painted as if a paper had stated it.
  const termCells = findByClass(panel, "zmp-wiki-term-cell");
  assert.equal(termCells.length, 6, "three name columns for each of two terms");
  const filled = termCells.filter((cell) => textOf(cell).trim() !== "—");
  assert.ok(filled.length >= 3, "the seeded terms fill several cells");
  assert.ok(
    filled.every((cell) => cell.className.includes("origin-ai")),
    "a name the model supplied must not be tinted as the paper's own words",
  );
  assert.ok(
    termCells.every((cell) => !cell.className.includes("origin-literature")),
    "nothing here was quoted from a document",
  );

  // Clicking a claim opens its evidence and moves the active marker.
  await fire(findByClass(cards[3], "zmp-wiki-claim-open")[0], "click");
  assert.ok(
    cards[3].classList.contains("is-active"),
    "the opened claim must be marked active",
  );
  const evidencePane = win.containers[0].querySelector(
    "#zotero-lit-synapse-wiki-evidence",
  );
  assert.equal(
    findByClass(evidencePane, "zmp-wiki-evidence-row").length,
    2,
    "the evidence rail must list every evidence record of the claim",
  );
  assert.equal(
    findByClass(evidencePane, "zmp-wiki-evidence-head").length,
    1,
    "the evidence rail must keep its pinned heading",
  );
  await fire(findByClass(cards[5], "zmp-wiki-claim-open")[0], "click");
  assert.ok(
    !cards[3].classList.contains("is-active"),
    "only one claim may be active at a time",
  );
  assert.ok(cards[5].classList.contains("is-active"));

  // Switching pages moves the index selection and swaps the reading column.
  await fire(sparse, "click");
  assert.ok(
    sparse.classList.contains("is-active"),
    "the newly opened page must become the active index entry",
  );
  assert.ok(
    !crowded.classList.contains("is-active"),
    "the previously open page must lose the active state",
  );
  assert.equal(
    findByClass(panel, "zmp-wiki-claim").length,
    1,
    "the reading column must show only the newly opened page",
  );
  assert.equal(
    loggedErrors.length,
    1,
    "the crowded render must not add an error to the log",
  );
  sqlite.close();
}

// --- The delete drawer: hidden at rest, dragged open, confirmed -----------

/**
 * Deleting a knowledge entry is permanent, so the index must not put a delete
 * control anywhere a stray click can reach. These tests drive the gesture the
 * panel actually implements: the drawer is invisible and unclickable until an
 * entry is dragged far enough to the left, a short drag springs back, a click
 * anywhere else puts it away, and the icon opens a confirmation that reads out
 * what is about to be destroyed before anything is written.
 */

/** Wait until `read()` returns something truthy, or give up. */
async function settleFor(read, what) {
  for (let tick = 0; tick < 50; tick += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

{
  const sqlite = new DatabaseSync(path.join(tempDir, "drawer.sqlite"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  await seedCrowded(sqlite);
  await useConnection(adapt(sqlite));
  const win = createWindow();
  const errorsBefore = loggedErrors.length;

  await openWikiPanel(win);
  const container = win.containers[0];
  let panel = container.querySelector("#zotero-lit-synapse-wiki-panel");

  const rows = findByClass(panel, "zmp-wiki-page-row");
  assert.equal(rows.length, 2, "every index entry must sit in a drawer row");
  for (const row of rows) {
    assert.equal(
      findByClass(row, "zmp-wiki-page-delete").length,
      1,
      "each row must carry exactly one delete control",
    );
    assert.ok(
      !row.classList.contains("is-drawer-open"),
      "no drawer may be open when the panel first renders",
    );
  }

  const target = rows.find((row) =>
    textOf(row).includes("定向凝固与固态相变控制柱状晶技术"),
  );
  const [targetEntry] = findByClass(target, "zmp-wiki-page-entry");
  const [targetDelete] = findByClass(target, "zmp-wiki-page-delete");

  // A short drag is a click that wandered: it must spring back.
  await drag(targetEntry, -12);
  assert.ok(
    !target.classList.contains("is-drawer-open"),
    "a drag shorter than the threshold must not open the drawer",
  );

  // A real drag left opens it, and only it.
  await drag(targetEntry, -60);
  assert.ok(
    target.classList.contains("is-drawer-open"),
    "dragging an entry left must open its drawer",
  );
  assert.equal(
    rows.filter((row) => row.classList.contains("is-drawer-open")).length,
    1,
    "at most one drawer may be open at a time",
  );

  // A click anywhere else in the panel puts it back.
  await fire(panel, "mousedown", { target: panel });
  assert.ok(
    !target.classList.contains("is-drawer-open"),
    "clicking elsewhere must close the drawer",
  );
  assert.equal(
    targetEntry.style.transform,
    "",
    "and must slide the entry back to its resting position",
  );

  // The keyboard reaches the same drawer, and only the drawer.
  await fire(targetEntry, "keydown", { key: "Delete" });
  assert.ok(
    target.classList.contains("is-drawer-open"),
    "Delete on a focused entry must open its drawer",
  );
  assert.equal(
    findByClass(panel, "zmp-wiki-modal").length,
    0,
    "and must not skip straight to the confirmation",
  );
  await fire(panel, "mousedown", { target: panel });

  // --- The confirmation reads out what will be destroyed -------------------
  await drag(targetEntry, -60);
  let pending = fire(targetDelete, "click");
  let dialog = await settleFor(
    () => findByClass(panel, "zmp-wiki-modal")[0],
    "the delete confirmation",
  );
  const dialogText = textOf(dialog);
  assert.match(
    dialogText,
    /定向凝固与固态相变控制柱状晶技术/u,
    "the confirmation must name the entry being deleted",
  );
  assert.match(dialogText, /24 条/u, "and count its claims");
  assert.match(dialogText, /48 条/u, "and count its evidence");
  assert.match(
    dialogText,
    /删除后不可恢复/u,
    "and say plainly that this cannot be undone",
  );
  assert.ok(
    dialogText.includes("取消") && dialogText.includes("永久删除"),
    "and offer both a way out and the destructive choice",
  );

  // Cancelling must write nothing.
  const [cancel, confirm] = findByClass(dialog, "zmp-wiki-command").filter(
    (node) => node.textContent === "取消" || node.textContent === "永久删除",
  );
  assert.equal(cancel.textContent, "取消");
  assert.equal(confirm.textContent, "永久删除");
  await fire(cancel, "click");
  await pending;
  assert.equal(
    findByClass(panel, "zmp-wiki-modal").length,
    0,
    "cancelling must take the dialog down",
  );
  assert.equal(
    Number(
      Object.values(
        sqlite.prepare("SELECT COUNT(*) FROM wiki_pages").get(),
      )[0],
    ),
    2,
    "cancelling must delete nothing",
  );

  // Confirming deletes the entry and re-renders the index without it.
  await drag(targetEntry, -60);
  pending = fire(targetDelete, "click");
  dialog = await settleFor(
    () => findByClass(panel, "zmp-wiki-modal")[0],
    "the delete confirmation",
  );
  const [, destroy] = findByClass(dialog, "zmp-wiki-command").filter(
    (node) => node.textContent === "取消" || node.textContent === "永久删除",
  );
  await fire(destroy, "click");
  await pending;

  panel = container.querySelector("#zotero-lit-synapse-wiki-panel");
  const remaining = findByClass(panel, "zmp-wiki-page-entry");
  assert.equal(
    remaining.length,
    1,
    "the deleted entry must be gone from the index",
  );
  assert.ok(
    !textOf(panel).includes("定向凝固与固态相变控制柱状晶技术"),
    "and its title must not be anywhere in the panel",
  );
  for (const [table, expected] of [
    ["wiki_pages", 1],
    ["wiki_claims", 1],
    ["wiki_evidence", 1],
  ]) {
    assert.equal(
      Number(
        Object.values(
          sqlite.prepare(`SELECT COUNT(*) FROM ${table}`).get(),
        )[0],
      ),
      expected,
      `${table} must keep only the surviving page's rows`,
    );
  }
  assert.equal(
    loggedErrors.length,
    errorsBefore,
    "deleting through the panel must not log an error",
  );
  sqlite.close();
}

// --- A delete that fails must say so, and change nothing ------------------

{
  const sqlite = new DatabaseSync(path.join(tempDir, "delete-fail.sqlite"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  await seed(sqlite);
  // Reads succeed - the panel renders and the confirmation can count rows -
  // but the delete itself faults, exactly as a locked database would.
  await useConnection(adapt(sqlite, /^\s*DELETE FROM wiki_claims/u));
  const win = createWindow();
  const alerts = [];
  win.alert = (message) => alerts.push(String(message));
  const errorsBefore = loggedErrors.length;

  await openWikiPanel(win);
  const panel = win.containers[0].querySelector("#zotero-lit-synapse-wiki-panel");
  const [row] = findByClass(panel, "zmp-wiki-page-row");
  const [entry] = findByClass(row, "zmp-wiki-page-entry");
  const [remove] = findByClass(row, "zmp-wiki-page-delete");

  await drag(entry, -60);
  const pending = fire(remove, "click");
  const dialog = await settleFor(
    () => findByClass(panel, "zmp-wiki-modal")[0],
    "the delete confirmation",
  );
  const [, destroy] = findByClass(dialog, "zmp-wiki-command").filter(
    (node) => node.textContent === "取消" || node.textContent === "永久删除",
  );
  await fire(destroy, "click");
  await pending;

  assert.equal(alerts.length, 1, "a failed delete must be reported to the user");
  assert.match(
    alerts[0],
    /删除失败，知识库未发生任何改动/u,
    "and must say the Wiki was left untouched",
  );
  assert.equal(
    loggedErrors.length,
    errorsBefore + 1,
    "and the untouched exception must still reach Zotero.logError",
  );
  assert.equal(
    Number(
      Object.values(sqlite.prepare("SELECT COUNT(*) FROM wiki_pages").get())[0],
    ),
    1,
    "and the page must still be there",
  );
  assert.equal(
    Number(
      Object.values(sqlite.prepare("SELECT COUNT(*) FROM wiki_claims").get())[0],
    ),
    1,
    "with its claim",
  );
  sqlite.close();
}

// --- Markdown export: save, overwrite, cancel -----------------------------

/**
 * The export button, driven through a stand-in for Zotero's file picker.
 *
 * The picker is reached with
 * `ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs")`,
 * so staging a module here exercises the real lookup rather than a seam added
 * for testing. The three outcomes are the ones that were conflated before:
 * a plain save, an overwrite - which the picker reports as `returnReplace`,
 * never as `returnOK` - and a cancel, which must write nothing, copy nothing
 * and say nothing.
 */
{
  const sqlite = new DatabaseSync(path.join(tempDir, "export.sqlite"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  await seed(sqlite);
  await useConnection(adapt(sqlite));
  const win = createWindow();
  const alerts = [];
  win.alert = (message) => alerts.push(String(message));

  // The staged picker. `outcome` is what show() reports; `file` is the path
  // it hands back, exactly as Zotero's module does - a string, never nsIFile.
  const picker = {
    outcome: 0,
    modeSave: 1,
    returnOK: 0,
    returnCancel: 1,
    returnReplace: 2,
    file: "",
    initArgs: null,
    filters: [],
    defaultString: "",
    defaultExtension: "",
    init(...args) {
      this.initArgs = args;
    },
    appendFilter(...args) {
      this.filters.push(args);
    },
    async show() {
      return this.outcome;
    },
  };
  globalThis.ChromeUtils = {
    importESModule(url) {
      assert.equal(
        url,
        "chrome://zotero/content/modules/filePicker.mjs",
        "the export must load Zotero 9's own file picker module",
      );
      return { FilePicker: function () { return picker; } };
    },
  };
  const written = [];
  globalThis.IOUtils = {
    writeUTF8: async (target, text) => {
      written.push([target, text]);
    },
  };
  const copied = [];
  globalThis.Zotero.Utilities = {
    Internal: { copyTextToClipboard: (text) => copied.push(String(text)) },
  };

  await openWikiPanel(win);
  const panel = win.containers[0].querySelector("#zotero-lit-synapse-wiki-panel");
  const exportButton = findByClass(panel, "zmp-wiki-command").find(
    (node) => node.textContent === "导出",
  );
  assert.ok(exportButton, "the panel must offer an export command");

  // The export runs from a fire-and-forget click handler, so let it finish.
  const exportOnce = async () => {
    await fire(exportButton, "click");
    for (let tick = 0; tick < 50; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  // --- 1. A plain save ----------------------------------------------------
  picker.outcome = picker.returnOK;
  picker.file = path.join(tempDir, "wiki-export.md");
  await exportOnce();
  assert.equal(written.length, 1, "accepting the dialog must write the file");
  assert.equal(written[0][0], picker.file, "to the path the user picked");
  assert.match(
    written[0][1],
    /^# Zotero LLM Wiki/u,
    "with the rendered Wiki Markdown",
  );
  assert.match(
    written[0][1],
    /Columnar band control/u,
    "which must contain the library's page",
  );
  assert.deepEqual(copied, [], "a successful save must not touch the clipboard");
  assert.deepEqual(alerts, [], "and must not interrupt the user");
  assert.equal(
    picker.initArgs?.[2],
    picker.modeSave,
    "the dialog must open in save mode",
  );
  assert.equal(
    picker.defaultExtension,
    "md",
    "a bare filename must still land as .md",
  );
  assert.deepEqual(picker.filters, [["Markdown 文档", "*.md"]]);

  // --- 2. Overwriting an existing file ------------------------------------
  // The picker reports an acknowledged overwrite as returnReplace. Checking
  // only returnOK is what used to make "save over the file I exported last
  // week" do nothing at all.
  picker.outcome = picker.returnReplace;
  picker.file = path.join(tempDir, "wiki-export.md");
  await exportOnce();
  assert.equal(written.length, 2, "an accepted overwrite must write the file");
  assert.equal(written[1][0], picker.file);
  assert.deepEqual(copied, [], "an overwrite must not touch the clipboard");
  assert.deepEqual(alerts, [], "and must not interrupt the user");

  // --- 3. Cancelling ------------------------------------------------------
  // Cancelling is an answer, not a fault.
  picker.outcome = picker.returnCancel;
  await exportOnce();
  assert.equal(written.length, 2, "cancelling must write nothing");
  assert.deepEqual(copied, [], "cancelling must not copy to the clipboard");
  assert.deepEqual(
    alerts,
    [],
    "cancelling must not claim the save dialog was unavailable",
  );

  // --- 4. A picker that genuinely cannot be loaded ------------------------
  // The one case the clipboard fallback is for.
  globalThis.ChromeUtils = {
    importESModule() {
      throw new Error("filePicker.mjs is unavailable");
    },
  };
  await exportOnce();
  assert.equal(written.length, 2, "a missing picker must write no file");
  assert.equal(copied.length, 1, "it must fall back to the clipboard");
  assert.match(copied[0], /^# Zotero LLM Wiki/u);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /保存对话框不可用/u);

  // --- 5. A write that fails is reported, not papered over ----------------
  globalThis.ChromeUtils = {
    importESModule: () => ({ FilePicker: function () { return picker; } }),
  };
  globalThis.IOUtils = {
    writeUTF8: async () => {
      throw new Error("拒绝访问");
    },
  };
  picker.outcome = picker.returnOK;
  picker.file = path.join(tempDir, "read-only.md");
  await exportOnce();
  assert.equal(copied.length, 1, "a failed write must not silently copy");
  assert.equal(alerts.length, 2);
  assert.match(
    alerts[1],
    /导出失败，文件未写入：拒绝访问/u,
    "the user must be told the save failed, and why",
  );
  assert.match(alerts[1], /read-only\.md/u, "and where it was going");

  globalThis.IOUtils = { writeUTF8: async () => undefined };
  sqlite.close();
}

fs.rmSync(tempDir, { recursive: true, force: true });

console.log("wiki panel render tests passed");
