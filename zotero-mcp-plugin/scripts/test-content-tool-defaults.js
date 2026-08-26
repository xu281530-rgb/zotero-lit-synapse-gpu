/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register("./ts-ext-hooks.mjs", import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  SEARCH_LIBRARY_DEFAULT_LIMIT,
  COLLECTIONS_DEFAULT_LIMIT,
  STANDARD_ITEM_DETAIL_FIELDS,
  prepareFixedContentToolArgs,
} = await import("../src/modules/contentToolDefaults.ts");

assert.equal(SEARCH_LIBRARY_DEFAULT_LIMIT, 200);
assert.equal(COLLECTIONS_DEFAULT_LIMIT, 100);

const legacy = {
  q: "graph",
  mode: "complete",
  detail: "minimal",
  outputMode: "preview",
  maxTokens: 1,
};
assert.deepEqual(
  prepareFixedContentToolArgs(legacy, SEARCH_LIBRARY_DEFAULT_LIMIT),
  prepareFixedContentToolArgs({ q: "graph" }, SEARCH_LIBRARY_DEFAULT_LIMIT),
);
assert.deepEqual(
  prepareFixedContentToolArgs({ q: "graph", limit: 7 }, 200),
  { q: "graph", limit: 7 },
);
assert.deepEqual(
  prepareFixedContentToolArgs({ limit: 0 }, 200),
  { limit: 0 },
  "an explicit limit must remain the handler's validation concern",
);

assert.deepEqual(STANDARD_ITEM_DETAIL_FIELDS, [
  "key",
  "title",
  "creators",
  "date",
  "itemType",
  "publicationTitle",
  "volume",
  "issue",
  "pages",
  "DOI",
  "url",
  "language",
  "tags",
  "hasAbstract",
  "noteCount",
  "attachments",
  "collections",
]);

const serverSource = fs.readFileSync(
  path.join(root, "src/modules/streamableMCPServer.ts"),
  "utf8",
);
for (const removed of [
  "getSearchModeConfiguration",
  "getCollectionModeConfiguration",
  "getItemDetailsModeConfiguration",
  "resolveItemDetailsMode",
  "appliedModeConfig",
]) {
  assert.ok(!serverSource.includes(removed), `server still contains ${removed}`);
}

console.log("fixed content-tool defaults and legacy input compatibility passed");
