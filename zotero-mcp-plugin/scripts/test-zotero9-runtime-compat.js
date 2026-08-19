/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const toolkitDirectory = "node_modules/zotero-plugin-toolkit/dist";
const toolkitSource = fs
  .readdirSync(toolkitDirectory)
  .filter((name) => name.endsWith(".js"))
  .map((name) => fs.readFileSync(path.join(toolkitDirectory, name), "utf8"))
  .join("\n");

assert.match(
  toolkitSource,
  /ChromeUtils\.importESModule\(/u,
  "Zotero 9 runtime dependencies must use ChromeUtils.importESModule()",
);
assert.doesNotMatch(
  toolkitSource,
  /ChromeUtils\.import\(/u,
  "Zotero 9 runtime dependencies must not call removed ChromeUtils.import()",
);

console.log("Zotero 9 runtime compatibility tests passed");
