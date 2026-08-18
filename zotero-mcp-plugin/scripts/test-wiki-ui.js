/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";

const panel = fs.readFileSync("src/modules/wiki/wikiPanel.ts", "utf8");
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

console.log("wiki UI contract tests passed");
