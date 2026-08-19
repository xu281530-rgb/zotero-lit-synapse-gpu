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
assert.doesNotMatch(css, /z-index:\s*2147483000/u);
assert.match(
  css,
  /\.zotero-mcp-wiki-toolbarbutton\s+\.toolbarbutton-icon\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/su,
  "Wiki toolbar icon must render at 16 by 16 pixels",
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
