/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  closeWikiTab,
  isCurrentWikiTabRender,
  openWikiTab,
} from "../src/modules/wiki/wikiTabManager.ts";

const panel = fs.readFileSync("src/modules/wiki/wikiPanel.ts", "utf8");
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

for (const behavior of [
  "updateConcept",
  "mergePages",
  "deleteClaim",
  "exportMarkdown",
  "selectItem",
  "getChunksForItem",
  "getDocumentGraph",
]) {
  assert.ok(panel.includes(behavior), `Wiki UI must expose ${behavior}`);
}

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
  ".zmp-wiki-alias-chip",
  ".zmp-wiki-graph-toolbar",
  ".zmp-wiki-graph-tooltip",
  ".zmp-wiki-section-title",
]) {
  assert.ok(css.includes(rule), `the Wiki stylesheet must style ${rule}`);
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
});
assert.equal(tabCalls.added.length, 1);
assert.equal(tabCalls.added[0].select, true);
assert.deepEqual(tabCalls.added[0].data, {});
assert.equal(isCurrentWikiTabRender(firstRender), true);

const refreshedRender = openWikiTab(fakeWindow, {
  type: "zotero-mcp-wiki",
  title: "LLM 知识库",
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
  "setVisibleKinds",
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
for (const kind of ["page", "claim", "evidence"]) {
  assert.match(
    graph3D,
    new RegExp(`^\\s*${kind}: `, "mu"),
    `the space must distinguish ${kind} nodes`,
  );
}
for (const relation of ["supports", "contradicts", "related", "structure"]) {
  assert.ok(
    graph3D.includes(`${relation}:`),
    `relations must be coloured by ${relation}`,
  );
}
for (const control of ["重置视角", "自动旋转", "页面", "论断", "证据"]) {
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
  "编辑术语",
  "添加别名",
  "合并页面",
  "删除论断",
  "暂无已保存的长期 Wiki 知识",
]) {
  assert.ok(
    panel.includes(label),
    `Wiki UI must expose Chinese label: ${label}`,
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
