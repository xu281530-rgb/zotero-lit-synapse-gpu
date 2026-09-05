/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register("./ts-ext-hooks.mjs", import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const retiredKeys = [
  "ai.maxTokens",
  "content.mode",
  "custom.maxContentLength",
  "custom.maxAttachments",
  "custom.maxNotes",
  "custom.keywordCount",
  "custom.smartTruncateLength",
  "custom.searchItemLimit",
  "custom.maxAnnotationsPerRequest",
  "custom.includeWebpage",
  "custom.enableCompression",
  "ui.includeMetadata",
  "text.preserveFormatting",
  "text.preserveHeadings",
  "text.preserveLists",
  "text.preserveEmphasis",
];

const cleared = [];
const values = new Map();
for (const key of retiredKeys) {
  values.set(`extensions.zotero.zotero-lit-synapse.${key}`, "old-value");
}
for (const key of [
  "mcp.server.port",
  "write.enabled",
  "hybrid.maxDocuments",
  "embedding.apiBase",
  "wiki.enabled",
]) {
  values.set(`extensions.zotero.zotero-lit-synapse.${key}`, `keep-${key}`);
}

globalThis.ztoolkit = { log: () => {} };
globalThis.Zotero = {
  Prefs: {
    clear(key, global) {
      assert.equal(global, true);
      cleared.push(key);
      values.delete(key);
    },
  },
};

const { clearDeprecatedContentSettings, DEPRECATED_CONTENT_PREF_KEYS } =
  await import("../src/modules/deprecatedContentSettings.ts");

assert.deepEqual(DEPRECATED_CONTENT_PREF_KEYS, retiredKeys);
clearDeprecatedContentSettings();
assert.deepEqual(
  cleared,
  retiredKeys.map((key) => `extensions.zotero.zotero-lit-synapse.${key}`),
);
for (const key of retiredKeys) {
  assert.equal(
    values.has(`extensions.zotero.zotero-lit-synapse.${key}`),
    false,
  );
}
for (const key of [
  "mcp.server.port",
  "write.enabled",
  "hybrid.maxDocuments",
  "embedding.apiBase",
  "wiki.enabled",
]) {
  assert.equal(
    values.get(`extensions.zotero.zotero-lit-synapse.${key}`),
    `keep-${key}`,
  );
}

const filesWithoutRetiredSettings = [
  "addon/content/preferences.xhtml",
  "addon/prefs.js",
  "typings/prefs.d.ts",
  "typings/i10n.d.ts",
  ...fs
    .readdirSync(path.join(root, "addon/locale"))
    .map((locale) => `addon/locale/${locale}/preferences.ftl`),
];

const retiredUiIds = [
  "pref-mcp-settings-title",
  "pref-mcp-settings-description",
  "pref-section-content-desc",
  "pref-max-tokens-label",
  "pref-content-mode-label",
  "pref-mode-minimal",
  "pref-mode-preview",
  "pref-mode-standard",
  "pref-mode-complete",
  "pref-mode-custom",
  "pref-custom-settings-title",
  "pref-custom-settings-hint",
  "pref-content-length-label",
  "pref-max-attachments-label",
  "pref-max-notes-label",
  "pref-keyword-count-label",
  "pref-truncate-length-label",
  "pref-search-limit-label",
  "pref-max-annotations-label",
  "pref-include-webpage-label",
  "pref-include-webpage-text",
  "pref-enable-compression-label",
  "pref-enable-compression-text",
  "pref-include-metadata-label",
  "pref-include-metadata-text",
  "pref-include-metadata-sub",
];

for (const relativePath of filesWithoutRetiredSettings) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  for (const key of retiredKeys.slice(0, 12)) {
    assert.ok(!source.includes(key), `${relativePath} still declares ${key}`);
  }
  for (const id of retiredUiIds) {
    assert.ok(!source.includes(id), `${relativePath} still declares ${id}`);
  }
}

console.log("deprecated content settings migration and UI cleanup passed");
