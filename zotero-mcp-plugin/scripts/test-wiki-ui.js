/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  closeWikiTab,
  isCurrentWikiTabRender,
  openWikiTab,
} from "../src/modules/wiki/wikiTabManager.ts";

const panel = fs.readFileSync("src/modules/wiki/wikiPanel.ts", "utf8");
const termsView = fs.readFileSync(
  "src/modules/wiki/wikiTermsView.ts",
  "utf8",
);
const tabManager = fs.readFileSync(
  "src/modules/wiki/wikiTabManager.ts",
  "utf8",
);
const wikiTypes = fs.readFileSync("src/modules/wiki/wikiTypes.ts", "utf8");
const hooks = fs.readFileSync("src/hooks.ts", "utf8");
const css = fs.readFileSync("addon/content/wikiPanel.css", "utf8");
const preferences = fs.readFileSync("addon/content/preferences.xhtml", "utf8");
const defaults = fs.readFileSync("addon/prefs.js", "utf8");

for (const id of [
  "zotero-mcp-wiki-button",
  "zotero-mcp-wiki-panel",
  "zotero-mcp-wiki-pages",
  "zotero-mcp-wiki-claims",
  "zotero-mcp-wiki-evidence",
  "zotero-mcp-wiki-graph",
]) {
  assert.ok(panel.includes(id), `Wiki UI must define ${id}`);
}

for (const id of [
  "zotero-mcp-wiki-terms-list",
  "zotero-mcp-wiki-terms-detail",
]) {
  assert.ok(termsView.includes(id), `the terminology view must define ${id}`);
}

for (const behavior of [
  "deletePage",
  "describePageDeletion",
  "deleteClaim",
  "exportMarkdown",
  "exportConceptsMarkdown",
  "listConcepts",
  "jumpToItem",
  "getDocumentGraph",
]) {
  assert.ok(panel.includes(behavior), `Wiki UI must expose ${behavior}`);
}

// The shared DOM vocabulary both views build from.
const dom = fs.readFileSync("src/modules/wiki/wikiDom.ts", "utf8");
assert.ok(dom.includes("selectItem"), "jumping to a Zotero item must survive");

// Terminology editing lives in the terminology view, and it edits STRUCTURED
// terms - not the flat alias strings the 2.4.2 panel could reach.
for (const behavior of [
  "updateTerm",
  "addTerm",
  "removeTerm",
  "setPrimaryTerm",
  "getChunksForItem",
  "jumpToItem",
]) {
  assert.ok(
    termsView.includes(behavior),
    `the terminology view must expose ${behavior}`,
  );
}

// The four header controls, in the order the user asked for them.
const headerOrder = ["知识条目", "知识图谱", "术语库", "导出", "刷新"].map(
  (label) => panel.indexOf(`"${label}"`),
);
for (const [index, position] of headerOrder.entries()) {
  assert.ok(position > 0, `the header must offer ${index}`);
}

// Page merging is gone: no entry point, no call, no leftover label.
for (const removed of [/mergePages/u, /合并页面/u, /目标 Wiki 页面 ID/u]) {
  assert.doesNotMatch(
    panel,
    removed,
    "the Wiki panel must not offer page merging any more",
  );
}

// The delete drawer must stay a deliberate gesture. These pin the parts that
// make it one: a hidden, unclickable drawer at rest, revealed only by the
// `is-drawer-open` state the drag sets - never by hovering - and a confirmation
// dialog between the icon and the delete.
for (const piece of [
  "zmp-wiki-page-row",
  "zmp-wiki-page-drawer",
  "zmp-wiki-page-delete",
  "is-drawer-open",
  "zmp-wiki-modal-overlay",
  "zmp-wiki-modal-warning",
  "confirmPageDeletion",
]) {
  assert.ok(panel.includes(piece), `the delete drawer must define ${piece}`);
}
for (const gesture of [/mousedown/u, /mousemove/u, /mouseup/u, /mouseleave/u]) {
  assert.match(
    panel,
    gesture,
    "the drawer must open by dragging, so it must track the pointer",
  );
}
const drawerCss = css.slice(
  css.indexOf(".zmp-wiki-page-drawer {"),
  css.indexOf(".zmp-wiki-page-delete {"),
);
assert.match(drawerCss, /opacity:\s*0;/u, "the drawer must be hidden at rest");
assert.match(
  drawerCss,
  /pointer-events:\s*none;/u,
  "the hidden drawer must not be clickable",
);
assert.doesNotMatch(
  css,
  /\.zmp-wiki-page-(row|entry):hover[^{]*\{[^}]*opacity:\s*1/u,
  "the delete control must never appear on hover - that is the misclick",
);

// Markdown export must go through Zotero 9's file picker module. There is no
// `Zotero.FilePicker`: constructing one throws on every call, which is what
// used to make "保存对话框不可用" the only outcome the export button had.
assert.match(
  panel,
  /chrome:\/\/zotero\/content\/modules\/filePicker\.mjs/u,
  "the Wiki export must load FilePicker from Zotero's own module",
);
assert.match(
  panel,
  /ChromeUtils\.importESModule\(/u,
  "and must import it the way Zotero and this plugin's other pickers do",
);
assert.doesNotMatch(
  panel,
  /new Zotero\.FilePicker\(/u,
  "Zotero.FilePicker does not exist in Zotero 9",
);
// A save dialog reports an accepted overwrite as returnReplace, never as
// returnOK, so a flow that only checks returnOK discards every overwrite.
assert.match(
  panel,
  /picker\.returnOK && result !== picker\.returnReplace/u,
  "an accepted overwrite must count as a save",
);
assert.match(
  panel,
  /picker\.defaultExtension = "md"/u,
  "a bare filename must still be saved as .md",
);

assert.match(hooks, /registerWikiPanel/u);
assert.match(hooks, /unregisterWikiPanel/u);
assert.match(css, /#zotero-mcp-wiki-panel/u);
assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/u);
assert.match(
  panel,
  /wikiPanel\.css\?version=\$\{config\.addonVersion\}/u,
  "Wiki stylesheet URL must change with the add-on version",
);

for (const tabBehavior of [
  /Zotero_Tabs\.add/u,
  /Zotero_Tabs\.select/u,
  /Zotero_Tabs\.close/u,
  /onClose/u,
]) {
  assert.match(
    tabManager,
    tabBehavior,
    "Wiki UI must use Zotero's native tab lifecycle",
  );
}
assert.doesNotMatch(
  panel,
  /documentElement!\.appendChild\(panel\)/u,
  "Wiki content must mount in the native Zotero tab container",
);
assert.doesNotMatch(css, /position:\s*fixed/u);

// A Wiki load that throws must not leave the tab blank: the render is wrapped,
// the exception is logged untouched, and the tab shows what went wrong.
assert.match(
  panel,
  /await renderWikiPanelContent\(win, render\);/u,
  "the Wiki render must run inside a failure boundary",
);
assert.match(
  panel,
  /renderWikiPanelFailure\(win, render, error\)/u,
  "a failed Wiki render must mount the failure card",
);
assert.match(
  panel,
  /Zotero\.logError\?\.\(error\)/u,
  "a failed Wiki render must report the exception to Zotero",
);
assert.match(
  panel,
  /ztoolkit\.log\("\[wiki\] failed to render the Wiki panel", error\)/u,
  "a failed Wiki render must log the exception",
);
for (const failureText of ["知识库加载失败", "重试", "zmp-wiki-error-detail"]) {
  assert.ok(
    panel.includes(failureText),
    `Wiki failure card must expose: ${failureText}`,
  );
}
assert.match(
  css,
  /\.zmp-wiki-error\b/u,
  "the Wiki failure card must be styled",
);
assert.doesNotMatch(
  panel,
  /catch\s*\{\s*\}/u,
  "the Wiki panel must never swallow an error silently",
);

// --- The paper design system --------------------------------------------
// Every region reads its colours and type from one token set, so a change to
// the palette cannot leave one column on an older scheme.

for (const token of [
  "--wiki-paper",
  "--wiki-paper-alt",
  "--wiki-border",
  "--wiki-shadow",
  "--wiki-radius",
  "--wiki-font-hei",
  "--wiki-font-kai",
  "--wiki-font-song",
  "--wiki-font-serif-en",
]) {
  assert.ok(css.includes(`${token}:`), `the Wiki must define ${token}`);
}

// Latin glyphs come from Times New Roman and CJK falls through to the family
// behind it, which only works if Times New Roman leads every mixed stack.
for (const stack of ["--wiki-font-hei", "--wiki-font-kai", "--wiki-font-song"]) {
  assert.match(
    css,
    new RegExp(`${stack}:\\s*\\n?\\s*"Times New Roman"`, "u"),
    `${stack} must put Times New Roman ahead of its Chinese family`,
  );
}
assert.match(css, /--wiki-font-hei:[^;]*Microsoft YaHei/su);
assert.match(css, /--wiki-font-kai:[^;]*KaiTi/su);
assert.match(css, /--wiki-font-song:[^;]*SimSun/su);

for (const rule of [
  ".zmp-wiki-summary-card",
  ".zmp-wiki-claim-list",
  ".zmp-wiki-claim-open",
  ".zmp-wiki-claim-remove",
  ".zmp-wiki-page-entry.is-active",
  ".zmp-wiki-evidence-head",
  ".zmp-wiki-term-table",
  ".zmp-wiki-terms-pane",
  ".zmp-wiki-terms-search",
  ".zmp-wiki-term-legend",
  ".zmp-wiki-term-lock",
  ".zmp-wiki-term-cell.origin-literature",
  ".zmp-wiki-term-cell.origin-ai",
  ".zmp-wiki-term-cell.origin-user",
  ".zmp-wiki-graph-toolbar",
  ".zmp-wiki-graph-tooltip",
  ".zmp-wiki-section-title",
]) {
  assert.ok(css.includes(rule), `the Wiki stylesheet must style ${rule}`);
}

// Gecko lays a <button>'s children out in an anonymous XUL box that does not
// grow to fit them, so a button holding two rows renders one row tall and
// spills the rest over whatever follows. Blink grows the button, so this only
// ever breaks inside Zotero - which is exactly how it shipped twice. The rule
// that prevents a third time: a <button> here never wraps, and anything that
// wraps is a div with button semantics.
assert.match(
  dom,
  /export function clickable\(/u,
  "the panel must provide a non-button clickable for multi-row controls",
);
assert.match(
  dom,
  /node\.setAttribute\("role", "button"\)/u,
  "a div used as a control must announce itself as a button",
);
assert.match(
  dom,
  /node\.setAttribute\("tabindex", "0"\)/u,
  "a div used as a control must be reachable by keyboard",
);
assert.match(
  dom,
  /key !== "Enter" && key !== " "/u,
  "a div used as a control must activate on Enter and Space",
);

// The two controls that hold more than one row must not be <button>s.
for (const name of ["zmp-wiki-page-entry", "zmp-wiki-claim-open"]) {
  assert.match(
    panel,
    new RegExp(`clickable\\(\\s*\\n?\\s*doc,\\s*\\n?\\s*"${name}"`, "u"),
    `${name} wraps onto several rows, so it must be a div, not a <button>`,
  );
  assert.doesNotMatch(
    panel,
    new RegExp(`"button",\\s*\\n?\\s*"${name}"`, "u"),
    `${name} must never be rebuilt as a <button>`,
  );
}
// Long claim text in the graph rail wraps too, so it uses the block variant.
assert.match(
  dom,
  /export function commandBlock\(/u,
  "a wrapping command must have a non-button form",
);
assert.match(
  css,
  /\.zmp-wiki-command\.is-block\s*\{[^}]*white-space:\s*normal/su,
  "the block command is the only command allowed to wrap",
);
// Every real button is pinned to one line.
for (const name of [
  "zmp-wiki-command",
  "zmp-wiki-alias-chip",
]) {
  assert.match(
    css,
    new RegExp(`^\\.${name}\\s*\\{[^}]*white-space:\\s*nowrap`, "msu"),
    `.${name} is a <button>; it must not wrap, or Gecko will collapse it`,
  );
}

// Claims must never collapse into one another: each card is spaced, wraps its
// own text, and has no fixed height to clip it.
assert.match(
  css,
  /\.zmp-wiki-claim-list\s*\{[^}]*gap:\s*10px/su,
  "claim cards must keep a gap between them",
);
assert.match(
  css,
  /\.zmp-wiki-claim-text\s*\{[^}]*line-height:\s*1\.7/su,
  "claim prose must be set with reading line height",
);
// The card, its body and its prose grow with the text; only the small delete
// square is allowed a fixed size.
for (const rule of [
  "\\.zmp-wiki-claim",
  "\\.zmp-wiki-claim-open",
  "\\.zmp-wiki-claim-text",
]) {
  assert.doesNotMatch(
    css,
    new RegExp(`^${rule}\\s*\\{[^}]*(?<![-a-z])(?:max-)?height:`, "msu"),
    `${rule} must not pin a height that could clip its text`,
  );
}
// Every column scrolls on its own and none may widen the tab.
assert.match(
  css,
  /\.zmp-wiki-pages,\s*\.zmp-wiki-claims,\s*\.zmp-wiki-evidence\s*\{[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/su,
  "each column must scroll vertically on its own without widening the tab",
);
assert.match(
  css,
  /overflow-wrap:\s*anywhere/u,
  "long unbroken strings must wrap rather than stretch a column",
);
assert.match(
  css,
  /grid-template-columns:\s*\n?\s*clamp\(240px, 21%, 280px\)\s*\n?\s*minmax\(0, 1fr\)\s*\n?\s*clamp\(320px, 26%, 380px\)/u,
  "the three columns must use bounded side rails and a flexible middle",
);

assert.doesNotMatch(css, /z-index:\s*2147483000/u);
assert.match(
  css,
  /\.zotero-mcp-wiki-toolbarbutton\s+\.toolbarbutton-icon\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;/su,
  "Wiki toolbar icon must render at 30 by 30 pixels",
);
assert.match(
  css,
  /\.zotero-mcp-wiki-toolbarbutton\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/su,
  "Wiki toolbar button must contain the enlarged icon without clipping",
);
assert.match(panel, /zotero-tb-button zotero-mcp-wiki-toolbarbutton/u);
assert.match(
  panel,
  /entry\.addEventListener\("click", \(\) => void openWikiPanel\(win\)\)/u,
  "Wiki toolbar click must open the native Zotero tab",
);

const tabCalls = {
  added: [],
  selected: [],
  closed: [],
};
const closeHandlers = [];
const fakeWindow = {
  Zotero_Tabs: {
    add(options) {
      tabCalls.added.push(options);
      closeHandlers.push(options.onClose);
      const id = `wiki-tab-${tabCalls.added.length}`;
      return {
        id,
        container: {
          classList: { add() {} },
          setAttribute() {},
        },
      };
    },
    select(id) {
      tabCalls.selected.push(id);
    },
    close(id) {
      tabCalls.closed.push(id);
    },
  },
};

const firstRender = openWikiTab(fakeWindow, {
  type: "zotero-mcp-wiki",
  title: "LLM 知识库",
  icon: "zotero-mcp-wiki",
});
assert.equal(tabCalls.added.length, 1);
assert.equal(tabCalls.added[0].select, true);
assert.deepEqual(tabCalls.added[0].data, { icon: "zotero-mcp-wiki" });
assert.equal(isCurrentWikiTabRender(firstRender), true);

const refreshedRender = openWikiTab(fakeWindow, {
  type: "zotero-mcp-wiki",
  title: "LLM 知识库",
  icon: "zotero-mcp-wiki",
});
assert.deepEqual(tabCalls.selected, ["wiki-tab-1"]);
assert.equal(refreshedRender.tab, firstRender.tab);
assert.equal(isCurrentWikiTabRender(firstRender), false);
assert.equal(isCurrentWikiTabRender(refreshedRender), true);

closeHandlers[0]();
assert.equal(isCurrentWikiTabRender(refreshedRender), false);
const reopenedRender = openWikiTab(fakeWindow, {
  type: "zotero-mcp-wiki",
  title: "LLM 知识库",
});
assert.equal(tabCalls.added.length, 2);
closeWikiTab(fakeWindow);
assert.deepEqual(tabCalls.closed, ["wiki-tab-2"]);
assert.equal(isCurrentWikiTabRender(reopenedRender), false);

// --- The 3D knowledge space ----------------------------------------------

const graph3D = fs.readFileSync("src/modules/wiki/graph3D.ts", "utf8");
assert.match(
  panel,
  /import \{\s*\n?\s*createGraph3D/u,
  "the Wiki panel must render its graph through the 3D renderer",
);
for (const capability of [
  "GraphMode",
  "setVisibleLinkStyles",
  "setShowIsolated",
  "resetView",
  "setAutoRotate",
  "requestAnimationFrame",
  "quadraticCurveTo",
]) {
  assert.ok(
    graph3D.includes(capability),
    `the knowledge space must provide ${capability}`,
  );
}
// A real z axis, not a restyled plane: nodes carry depth and the camera
// projects it.
assert.match(graph3D, /\bz:\s*number;/u, "graph nodes must carry a z axis");
assert.match(
  graph3D,
  /const depth = Math\.max\(60, cameraDistance - z2 \* depthScale\)/u,
  "the camera must divide by depth, which is what makes the view perspective",
);

// One node is one document, and a link is a relation between two documents.
// Both must be selectable: "what do these two papers conclude in common" is a
// question about the link, and answering it is the whole point of drawing one.
assert.ok(
  graph3D.includes("onSelectNode") && graph3D.includes("onSelectLink"),
  "both documents and relations must report selections back to the panel",
);
assert.match(
  graph3D,
  /function pickLink\(/u,
  "relations must be hit-tested, or a link cannot be opened",
);
assert.match(
  graph3D,
  /function distanceToCurve\(/u,
  "a curved relation needs curve-aware hit testing, not a straight-line test",
);
for (const style of ["solid", "dashed"]) {
  assert.ok(
    graph3D.includes(`"${style}"`),
    `relations must distinguish the ${style} kind`,
  );
}
assert.ok(
  panel.includes("getDocumentGraph") && panel.includes("claimIds"),
  "the shared claims a relation is made of must come from the document graph",
);
assert.ok(
  panel.includes("item:"),
  "graph nodes must be keyed by Zotero item, because a node is a document",
);
for (const control of ["重置视角", "自动旋转", "共享论断", "同一条目", "孤立文献"]) {
  assert.ok(
    panel.includes(control),
    `the graph toolbar must expose: ${control}`,
  );
}
assert.doesNotMatch(
  graph3D,
  /from "three"/u,
  "the knowledge space must stay dependency free",
);

for (const label of [
  "LLM 知识库",
  "刷新",
  "导出",
  "知识图谱",
  "打开文献",
  "查看片段",
  "术语库",
  "知识条目",
  "在术语库中编辑",
  "删除知识条目",
  "永久删除",
  "删除后不可恢复",
  "删除论断",
  "暂无已保存的长期 Wiki 知识",
]) {
  assert.ok(
    panel.includes(label),
    `Wiki UI must expose Chinese label: ${label}`,
  );
}

// The terminology view speaks for itself: the four column headings of the
// term table, the controls that edit a structured term group, the search box
// over all three name columns, and the legend that says what the cell tints
// mean. The tints are the only place a reader learns which half of a row a
// paper actually vouches for, so an unlabelled colour would be worse than no
// colour at all.
for (const label of [
  "序号",
  "中文术语",
  "英文术语",
  "简称",
  "添加术语",
  "设为主术语",
  "解除锁定",
  "已锁定",
  "文献原文",
  "AI 补全",
  "人工修改",
  "搜索中文 / 英文 / 简称",
  "来源文献",
  "打开文献",
  "查看片段",
]) {
  assert.ok(
    termsView.includes(label),
    `the terminology view must expose Chinese label: ${label}`,
  );
}

for (const label of [
  "定义",
  "机制",
  "模型",
  "条件",
  "比较",
  "局限",
  "共识",
  "冲突",
  "暂定",
  "已支持",
  "已交叉印证",
  "有争议",
  "未支持",
  "局部片段",
  "已读章节",
  "已审阅全文",
  "跨论文",
  "部分",
  "不完整",
  "支持",
  "反驳",
  "限定",
  "示例",
  "有效",
  "等待重连",
  "已失效",
  "源文献已删除",
]) {
  assert.ok(
    panel.includes(label),
    `Wiki enum must have Chinese label: ${label}`,
  );
}

for (const enumValue of [
  "definition",
  "mechanism",
  "model",
  "condition",
  "comparison",
  "limitation",
  "consensus",
  "conflict",
  "provisional",
  "supported",
  "corroborated",
  "disputed",
  "unsupported",
  "chunk_local",
  "section_read",
  "paper_reviewed",
  "cross_paper",
  "partial",
  "incomplete",
  "SUPPORTS",
  "CONTRADICTS",
  "QUALIFIES",
  "EXAMPLE",
  "valid",
  "pending_relink",
  "stale",
  "source_deleted",
]) {
  assert.ok(
    wikiTypes.includes(`"${enumValue}"`),
    `Missing Wiki enum: ${enumValue}`,
  );
}
for (const setting of [
  "wiki.enabled",
  "wiki.autoWrite",
  "wiki.writeMode",
  "wiki.shadowMode",
  "wiki.minScore",
  "wiki.rrfWeight",
  "wiki.searchTimeoutMs",
]) {
  assert.ok(defaults.includes(setting), `defaults must declare ${setting}`);
  assert.ok(
    preferences.includes(setting),
    `preferences UI must expose ${setting}`,
  );
}

for (const id of [
  "clear-wiki-data-button",
  "wiki-data-statistics",
  "hybrid-chunk-lock-message",
  "embedding-identity-lock-message",
]) {
  assert.ok(preferences.includes(id), `preferences UI must define ${id}`);
}

const preferenceScript = fs.readFileSync(
  "src/modules/preferenceScript.ts",
  "utf8",
);
assert.match(preferenceScript, /clearAll\(\)/u);
assert.match(preferenceScript, /chunkLocked/u);
assert.match(preferenceScript, /embeddingIdentityLocked/u);
assert.doesNotMatch(
  preferenceScript,
  /apiKeyInput\.disabled\s*=\s*[^f]/u,
  "API Key must remain editable when the embedding identity is locked",
);

console.log("wiki UI contract tests passed");
