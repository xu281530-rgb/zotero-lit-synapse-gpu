/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL(
    "../addon/mark-reader/content/scripts/zotero-mark-reader.js",
    import.meta.url,
  ),
  "utf8",
);
assert.doesNotMatch(source, /readSavedRawFiles|full\.md/);

const context = {
  console,
  process: { env: { ZMR_TEST: "1" } },
  Zotero: { debug() {}, logError() {}, Prefs: { get: () => undefined } },
  Services: {},
  IOUtils: {},
  PathUtils: {},
  Components: { classes: {}, interfaces: {} },
  ZoteroMarkReader: undefined,
};
vm.runInNewContext(source, context, { filename: "zotero-mark-reader.js" });
const normalize = context.ZoteroMarkReader?.__test?.normalizeMinerUResult;
assert.equal(typeof normalize, "function");

const attachment = { id: 7, key: "PDFKEY01" };
const input = {
  markdown: "# Paper\n\nReader text.",
  rawFiles: {},
  blocks: [
    {
      type: "paragraph",
      pageIndex: 0,
      bbox: [1, 2, 3, 4],
      markdown: "Reader text.",
    },
  ],
  structuredHash: "STRUCTURED-HASH",
};
const versionOne = normalize({ ...input, assemblerVersion: 1 }, attachment);
const versionOneAgain = normalize(
  { ...input, assemblerVersion: 1 },
  attachment,
);
const versionTwo = normalize({ ...input, assemblerVersion: 2 }, attachment);
assert.equal(versionOne.sourceHash, versionOneAgain.sourceHash);
assert.notEqual(
  versionOne.sourceHash,
  versionTwo.sourceHash,
  "an assembler upgrade invalidates Reader translations without reparsing PDF",
);
assert.equal(versionTwo.mineru.assemblerVersion, 2);
assert.equal(versionTwo.blocks[0].sourceHash, versionTwo.sourceHash);

console.log("MinerU Reader structured-cache tests passed");
