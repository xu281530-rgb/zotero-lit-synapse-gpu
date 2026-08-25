/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zmp-mineru-structured-"));
const items = new Map();
const preferences = new Map();
let nextItemID = 100;
let imports = 0;

globalThis.PathUtils = {
  join: (...parts) => path.join(...parts),
  parent: (value) => path.dirname(value),
};
globalThis.IOUtils = {
  read: (value) => fs.readFile(value),
  readUTF8: (value) => fs.readFile(value, "utf8"),
  writeUTF8: async (value, content) => {
    await fs.mkdir(path.dirname(value), { recursive: true });
    await fs.writeFile(value, content, "utf8");
  },
  makeDirectory: (value) => fs.mkdir(value, { recursive: true }),
  remove: (value, options = {}) =>
    fs.rm(value, {
      recursive: options.recursive === true,
      force: options.ignoreAbsent === true,
    }),
  getChildren: async (value) =>
    (await fs.readdir(value)).map((name) => path.join(value, name)),
  stat: async (value) => {
    const stat = await fs.stat(value);
    return { size: stat.size, lastModified: stat.mtimeMs };
  },
};
globalThis.ztoolkit = { log: () => {} };
globalThis.Zotero = {
  DataDirectory: { dir: tempDir },
  Libraries: { userLibraryID: 1 },
  Prefs: { get: (key) => preferences.get(key) },
  Items: {
    getAsync: async (id) => items.get(id) || null,
    getByLibraryAndKeyAsync: async (_libraryID, key) =>
      [...items.values()].find((item) => item.key === key) || null,
  },
  Attachments: {
    importFromFile: async ({ file, parentItemID, title, contentType }) => {
      imports += 1;
      const id = nextItemID++;
      const key = `NEWMD${id}`;
      const target = path.join(tempDir, "storage", key, "paper.md");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file, target);
      const item = markdownItem({ id, key, parentItemID, title, target, contentType });
      items.set(id, item);
      items.get(parentItemID).attachmentIDs.push(id);
      return item;
    },
  },
};

function markdownItem({ id, key, parentItemID, title, target, contentType = "text/markdown" }) {
  return {
    id,
    key,
    libraryID: 1,
    parentItemID,
    attachmentContentType: contentType,
    isAttachment: () => true,
    getField: (name) => (name === "title" ? title : ""),
    setField: (_name, value) => {
      title = value;
    },
    saveTx: async () => {},
    getFilePathAsync: async () => target,
    eraseTx: async () => {
      items.delete(id);
      const parent = items.get(parentItemID);
      parent.attachmentIDs = parent.attachmentIDs.filter((childID) => childID !== id);
    },
  };
}

function parentItem(id, key) {
  return {
    id,
    key,
    libraryID: 1,
    attachmentIDs: [],
    getAttachments() {
      return [...this.attachmentIDs];
    },
    getNotes: () => [],
  };
}

async function writeStructuredCache(pdf, markdownAttachmentKey = undefined) {
  const info = await fs.stat(await pdf.getFilePathAsync());
  const dir = path.join(tempDir, "zotero-mcp", "mineru", pdf.key);
  const rawDir = path.join(dir, "raw");
  await fs.mkdir(rawDir, { recursive: true });
  const structured = [[
    {
      type: "title",
      bbox: [1, 2, 3, 4],
      content: { level: 1, title_content: [{ type: "text", content: "New Canonical Title" }] },
    },
    {
      type: "paragraph",
      bbox: [1, 5, 3, 6],
      content: { paragraph_content: [{ type: "text", content: "UNIQUE_STRUCTURED_BODY_8127" }] },
    },
  ]];
  await fs.writeFile(
    path.join(rawDir, "content_list_v2.json"),
    JSON.stringify(structured),
  );
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({
      version: 2,
      attachmentKey: pdf.key,
      libraryID: 1,
      fileName: `${pdf.key}.pdf`,
      fileSize: info.size,
      fileMTime: info.mtimeMs,
      signature: "v2|cloud|vlm|ch|noocr|formula|table",
      parsedAt: new Date(0).toISOString(),
      markdownLength: 12,
      assemblerVersion: 0,
      generatedAttachmentKey: markdownAttachmentKey,
    }),
  );
}

const { ASSEMBLER_VERSION } = await import(
  "../src/modules/mineru/structuredDocumentAssembler.ts"
);
const { MinerUService } = await import("../src/modules/mineru/minerUService.ts");
const service = new MinerUService();

const parent = parentItem(1, "PARENT1");
items.set(parent.id, parent);
const pdfPath = path.join(tempDir, "paper.pdf");
await fs.writeFile(pdfPath, "PDF fixture");
const pdf = {
  id: 2,
  key: "PDFKEY1",
  libraryID: 1,
  parentItemID: parent.id,
  attachmentFilename: "paper.pdf",
  isPDFAttachment: () => true,
  getFilePathAsync: async () => pdfPath,
};
items.set(pdf.id, pdf);
parent.attachmentIDs.push(pdf.id);

const oldMDPath = path.join(tempDir, "old.md");
await fs.writeFile(oldMDPath, "# Old MinerU Markdown");
const oldMD = markdownItem({
  id: 3,
  key: "OLDMD1",
  parentItemID: parent.id,
  title: "MinerU Markdown (PDFKEY1).md",
  target: oldMDPath,
});
items.set(oldMD.id, oldMD);
parent.attachmentIDs.push(oldMD.id);
await writeStructuredCache(pdf, oldMD.key);

let changed = 0;
const upgraded = await service.getMarkdownForAttachment(pdf, {
  allowParse: false,
  ignoreEnabled: true,
  onAttachmentChanged: () => {
    changed += 1;
  },
});
assert.equal(
  upgraded,
  "# New Canonical Title\n\nUNIQUE_STRUCTURED_BODY_8127",
  "the service returns the bytes read back from the Zotero Markdown attachment",
);
assert.equal(imports, 1);
assert.equal(changed, 1);
assert.equal(parent.attachmentIDs.length, 2, "one PDF and one replacement MD remain");
const upgradedMeta = JSON.parse(
  await fs.readFile(
    path.join(tempDir, "zotero-mcp", "mineru", pdf.key, "meta.json"),
    "utf8",
  ),
);
assert.equal(
  upgradedMeta.assemblerVersion,
  ASSEMBLER_VERSION,
  "an assembler-only upgrade records the new version without parsing the PDF",
);

const parentFailedUpgrade = parentItem(30, "PARENTFAILED");
items.set(parentFailedUpgrade.id, parentFailedUpgrade);
const failedPDFPath = path.join(tempDir, "failed-upgrade.pdf");
await fs.writeFile(failedPDFPath, "failed upgrade PDF fixture");
const failedUpgradePDF = {
  id: 31,
  key: "PDFFAIL1",
  libraryID: 1,
  parentItemID: parentFailedUpgrade.id,
  attachmentFilename: "failed-upgrade.pdf",
  isPDFAttachment: () => true,
  getFilePathAsync: async () => failedPDFPath,
};
items.set(failedUpgradePDF.id, failedUpgradePDF);
parentFailedUpgrade.attachmentIDs.push(failedUpgradePDF.id);
const preservedMDPath = path.join(tempDir, "preserved.md");
await fs.writeFile(preservedMDPath, "# Preserve this attachment on import failure");
const preservedMD = markdownItem({
  id: 32,
  key: "PRESERVEMD",
  parentItemID: parentFailedUpgrade.id,
  title: "MinerU Markdown (PDFFAIL1).md",
  target: preservedMDPath,
});
items.set(preservedMD.id, preservedMD);
parentFailedUpgrade.attachmentIDs.push(preservedMD.id);
await writeStructuredCache(failedUpgradePDF, preservedMD.key);
const successfulImport = globalThis.Zotero.Attachments.importFromFile;
globalThis.Zotero.Attachments.importFromFile = async () => {
  const id = nextItemID++;
  const broken = markdownItem({
    id,
    key: `BROKEN${id}`,
    parentItemID: parentFailedUpgrade.id,
    title: "MinerU Markdown (PDFFAIL1).md",
    target: path.join(tempDir, "missing-imported.md"),
  });
  items.set(id, broken);
  parentFailedUpgrade.attachmentIDs.push(id);
  return broken;
};
try {
  assert.equal(
    await service.getMarkdownForAttachment(failedUpgradePDF, {
      allowParse: false,
      ignoreEnabled: true,
    }),
    null,
  );
  assert.ok(
    parentFailedUpgrade.attachmentIDs.includes(preservedMD.id),
    "a failed replacement keeps the previous Zotero Markdown attachment",
  );
  assert.equal(items.get(preservedMD.id), preservedMD);
  assert.equal(
    parentFailedUpgrade.attachmentIDs.length,
    2,
    "an unreadable newly imported attachment is removed instead of accumulating",
  );
} finally {
  globalThis.Zotero.Attachments.importFromFile = successfulImport;
}

const parentAttachmentOnly = parentItem(40, "PARENTATTACHMENTONLY");
items.set(parentAttachmentOnly.id, parentAttachmentOnly);
const attachmentOnlyPDFPath = path.join(tempDir, "attachment-only.pdf");
await fs.writeFile(attachmentOnlyPDFPath, "attachment only PDF fixture");
const attachmentOnlyPDF = {
  id: 41,
  key: "PDFONLY1",
  libraryID: 1,
  parentItemID: parentAttachmentOnly.id,
  attachmentFilename: "attachment-only.pdf",
  isPDFAttachment: () => true,
  getFilePathAsync: async () => attachmentOnlyPDFPath,
};
items.set(attachmentOnlyPDF.id, attachmentOnlyPDF);
parentAttachmentOnly.attachmentIDs.push(attachmentOnlyPDF.id);
const attachmentOnlyMDPath = path.join(tempDir, "attachment-only.md");
await fs.writeFile(attachmentOnlyMDPath, "# Existing attachment without JSON cache");
const attachmentOnlyMD = markdownItem({
  id: 42,
  key: "ONLYMD01",
  parentItemID: parentAttachmentOnly.id,
  title: "MinerU Markdown (PDFONLY1).md",
  target: attachmentOnlyMDPath,
});
items.set(attachmentOnlyMD.id, attachmentOnlyMD);
parentAttachmentOnly.attachmentIDs.push(attachmentOnlyMD.id);
assert.equal(
  await service.hasFreshMarkdownForAttachment(attachmentOnlyPDF),
  false,
  "freshness requires valid structured JSON as well as the Zotero MD",
);
assert.equal(
  await service.getMarkdownForAttachment(attachmentOnlyPDF, {
    allowParse: false,
    ignoreEnabled: true,
  }),
  null,
  "a generated MD without its authoritative structured cache is not reusable",
);
assert.equal(
  await service.getMarkdownForAttachment(attachmentOnlyPDF, {
    allowParse: false,
    ignoreEnabled: true,
    restoreMissingMarkdown: true,
  }),
  "# Existing attachment without JSON cache",
  "an index build reads an existing canonical MD before considering cache recovery",
);

preferences.set("extensions.zotero.zotero-mcp-plugin.mineru.language", "en");
assert.equal(
  await service.getMarkdownForAttachment(pdf, {
    allowParse: false,
    ignoreEnabled: true,
  }),
  null,
  "changing parser settings invalidates structured cache reuse",
);
preferences.delete("extensions.zotero.zotero-mcp-plugin.mineru.language");

const parent2 = parentItem(10, "PARENT2");
items.set(parent2.id, parent2);
const pdfPath2 = path.join(tempDir, "paper2.pdf");
await fs.writeFile(pdfPath2, "second PDF fixture");
const pdf2 = {
  id: 11,
  key: "PDFKEY2",
  libraryID: 1,
  parentItemID: parent2.id,
  attachmentFilename: "paper2.pdf",
  isPDFAttachment: () => true,
  getFilePathAsync: async () => pdfPath2,
};
items.set(pdf2.id, pdf2);
parent2.attachmentIDs.push(pdf2.id);
await writeStructuredCache(pdf2);
await service.suppressAutomaticMarkdown(1, pdf2.key);
assert.equal(await service.isAutomaticMarkdownSuppressed(pdf2), true);

const restoredFromStructuredCache = await service.getMarkdownForAttachment(pdf2, {
  allowParse: false,
  ignoreEnabled: true,
  restoreMissingMarkdown: true,
});
assert.equal(
  restoredFromStructuredCache,
  "# New Canonical Title\n\nUNIQUE_STRUCTURED_BODY_8127",
  "an index build restores a missing Markdown attachment from structured JSON",
);
assert.equal(imports, 2, "cache recovery imports one new Zotero Markdown attachment");
assert.equal(parent2.attachmentIDs.length, 2, "the recovered MD is attached beside the PDF");
assert.equal(
  await service.isAutomaticMarkdownSuppressed(pdf2),
  false,
  "successful index recovery clears the prior deletion suppression",
);

preferences.set("extensions.zotero.zotero-mcp-plugin.mineru.mode", "local");
preferences.set(
  "extensions.zotero.zotero-mcp-plugin.mineru.baseURL",
  "http://127.0.0.1:18101",
);
const invalidParent = parentItem(60, "PARENTINVALID");
items.set(invalidParent.id, invalidParent);
const invalidPDFPath = path.join(tempDir, "invalid-cache.pdf");
await fs.writeFile(invalidPDFPath, "invalid cache PDF fixture");
const invalidPDF = {
  id: 61,
  key: "INVALIDJSON1",
  libraryID: 1,
  parentItemID: invalidParent.id,
  attachmentFilename: "invalid-cache.pdf",
  isPDFAttachment: () => true,
  getFilePathAsync: async () => invalidPDFPath,
};
items.set(invalidPDF.id, invalidPDF);
invalidParent.attachmentIDs.push(invalidPDF.id);
await writeStructuredCache(invalidPDF);
const invalidCacheDir = path.join(
  tempDir,
  "zotero-mcp",
  "mineru",
  invalidPDF.key,
);
const invalidMetaPath = path.join(invalidCacheDir, "meta.json");
const invalidMeta = JSON.parse(await fs.readFile(invalidMetaPath, "utf8"));
invalidMeta.signature = "v2|local|vlm|ch|noocr|formula|table";
await fs.writeFile(invalidMetaPath, JSON.stringify(invalidMeta));
await fs.writeFile(
  path.join(invalidCacheDir, "raw", "content_list_v2.json"),
  "{broken",
);
await fs.writeFile(
  path.join(invalidCacheDir, "obsolete-cache-marker.txt"),
  "must be removed before reparsing",
);
await service.suppressAutomaticMarkdown(1, invalidPDF.key);

let minerURequests = 0;
const fetchBeforeRecovery = globalThis.fetch;
globalThis.fetch = async () => {
  minerURequests += 1;
  return new Response(
    JSON.stringify({
      content_list_v2: [[
        {
          type: "title",
          content: {
            level: 1,
            title_content: [{ type: "text", content: "Reparsed Title" }],
          },
        },
        {
          type: "paragraph",
          content: {
            paragraph_content: [{
              type: "text",
              content: "REPARSED_AFTER_INVALID_CACHE_4419",
            }],
          },
        },
      ]],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
try {
  assert.equal(
    await service.getMarkdownForAttachment(invalidPDF, {
      allowParse: true,
      ignoreEnabled: true,
      ignoreFailureCache: true,
      restoreMissingMarkdown: true,
    }),
    "# Reparsed Title\n\nREPARSED_AFTER_INVALID_CACHE_4419",
    "an index build reparses a PDF whose structured cache is damaged",
  );
} finally {
  globalThis.fetch = fetchBeforeRecovery;
}
assert.equal(minerURequests, 1, "damaged structured cache triggers one MinerU request");
await assert.rejects(
  fs.access(path.join(invalidCacheDir, "obsolete-cache-marker.txt")),
  undefined,
  "the damaged per-PDF cache directory is removed before MinerU reparses it",
);
assert.equal(
  await service.isAutomaticMarkdownSuppressed(invalidPDF),
  false,
  "successful reparsing clears the prior deletion suppression",
);

const missingParent = parentItem(70, "PARENTMISSING");
items.set(missingParent.id, missingParent);
const missingPDFPath = path.join(tempDir, "missing-cache.pdf");
await fs.writeFile(missingPDFPath, "missing cache PDF fixture");
const missingPDF = {
  id: 71,
  key: "MISSINGCACHE1",
  libraryID: 1,
  parentItemID: missingParent.id,
  attachmentFilename: "missing-cache.pdf",
  isPDFAttachment: () => true,
  getFilePathAsync: async () => missingPDFPath,
};
items.set(missingPDF.id, missingPDF);
missingParent.attachmentIDs.push(missingPDF.id);
await service.suppressAutomaticMarkdown(1, missingPDF.key);
let missingCacheRequests = 0;
globalThis.fetch = async () => {
  missingCacheRequests += 1;
  return new Response(
    JSON.stringify({
      content_list_v2: [[{
        type: "paragraph",
        content: {
          paragraph_content: [{
            type: "text",
            content: "PARSED_WITHOUT_PRIOR_CACHE_9934",
          }],
        },
      }]],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
try {
  assert.equal(
    await service.getMarkdownForAttachment(missingPDF, {
      allowParse: true,
      ignoreEnabled: true,
      ignoreFailureCache: true,
      restoreMissingMarkdown: true,
    }),
    "PARSED_WITHOUT_PRIOR_CACHE_9934",
    "an index build calls MinerU when neither Markdown nor structured cache exists",
  );
} finally {
  globalThis.fetch = fetchBeforeRecovery;
}
assert.equal(missingCacheRequests, 1);
assert.equal(await service.isAutomaticMarkdownSuppressed(missingPDF), false);
await fs.access(
  path.join(
    tempDir,
    "zotero-mcp",
    "mineru",
    missingPDF.key,
    "raw",
    "content_list_v2.json",
  ),
);

preferences.delete("extensions.zotero.zotero-mcp-plugin.mineru.mode");
preferences.delete("extensions.zotero.zotero-mcp-plugin.mineru.baseURL");
await service.suppressAutomaticMarkdown(1, pdf2.key);
assert.equal(await service.isAutomaticMarkdownSuppressed(pdf2), true);
await service.forgetAutomaticMarkdownStateForParent(1, parent2.key);
assert.equal(
  await service.isAutomaticMarkdownSuppressed(pdf2),
  false,
  "permanently deleting the parent can remove all child-PDF suppression state",
);

const legacyDir = path.join(tempDir, "zotero-mcp", "mineru", "LEGACY1");
const legacyRawDir = path.join(legacyDir, "raw");
await fs.mkdir(legacyRawDir, { recursive: true });
await fs.writeFile(
  path.join(legacyDir, "meta.json"),
  JSON.stringify({
    version: 1,
    attachmentKey: "LEGACY1",
    libraryID: 1,
    fileName: "legacy.pdf",
    fileSize: 10,
    fileMTime: 20,
    signature: "legacy",
    parsedAt: new Date(0).toISOString(),
    markdownLength: 99,
  }),
);
await fs.writeFile(
  path.join(legacyRawDir, "content_list_v2.json"),
  JSON.stringify([[{
    type: "paragraph",
    content: { paragraph_content: [{ type: "text", content: "Migrated body" }] },
  }]]),
);
await fs.writeFile(path.join(legacyDir, "full.md"), "legacy markdown");
await fs.writeFile(path.join(legacyDir, "parse.json"), JSON.stringify({ markdown: "copy" }));
await fs.writeFile(path.join(legacyRawDir, "legacy.md"), "raw markdown copy");
await fs.writeFile(
  path.join(legacyDir, "translation-cache.json"),
  JSON.stringify({ sourceHash: "old", translations: [] }),
);

const damagedDir = path.join(tempDir, "zotero-mcp", "mineru", "DAMAGED1");
const damagedRawDir = path.join(damagedDir, "raw");
await fs.mkdir(damagedRawDir, { recursive: true });
await fs.writeFile(
  path.join(damagedDir, "meta.json"),
  JSON.stringify({
    version: 1,
    attachmentKey: "DAMAGED1",
    libraryID: 1,
    fileName: "damaged.pdf",
    fileSize: 10,
    fileMTime: 20,
    signature: "legacy",
    parsedAt: new Date(0).toISOString(),
    markdownLength: 99,
  }),
);
await fs.writeFile(path.join(damagedRawDir, "content_list_v2.json"), "{broken");
await fs.writeFile(path.join(damagedRawDir, "legacy.md"), "must be removed");
await fs.writeFile(path.join(damagedDir, "full.md"), "must be removed");

await service.migrateLegacyCaches();
const migratedJSONNames = await fs.readdir(legacyRawDir);
assert.ok(
  migratedJSONNames.some((name) => /content_list_v2\.json$/i.test(name)),
  "migration retains the structured JSON artifact",
);
await assert.rejects(fs.access(path.join(legacyDir, "full.md")));
await assert.rejects(fs.access(path.join(legacyDir, "parse.json")));
await assert.rejects(fs.access(path.join(legacyRawDir, "legacy.md")));
assert.equal(
  await fs.readFile(path.join(legacyDir, "translation-cache.json"), "utf8").then(() => true),
  true,
  "migration retains the existing translation cache for hash/version validation",
);
const migratedMeta = JSON.parse(await fs.readFile(path.join(legacyDir, "meta.json"), "utf8"));
assert.equal(migratedMeta.version, 2);
assert.equal(migratedMeta.structuredFormat, "content_list_v2");

assert.equal(
  await fs.readFile(path.join(damagedRawDir, "content_list_v2.json"), "utf8"),
  "{broken",
  "damaged JSON remains available for diagnosis or an explicit retry",
);
await assert.rejects(fs.access(path.join(damagedRawDir, "legacy.md")));
await assert.rejects(fs.access(path.join(damagedDir, "full.md")));
const damagedMeta = JSON.parse(await fs.readFile(path.join(damagedDir, "meta.json"), "utf8"));
assert.match(damagedMeta.error, /invalid/i);

const longParent = parentItem(50, "PARENTLONG");
items.set(longParent.id, longParent);
const longPDFPath = path.join(tempDir, "long-cache.pdf");
await fs.writeFile(longPDFPath, "long cache PDF fixture");
const longPDF = {
  id: 51,
  key: "LONGJSON1",
  libraryID: 1,
  parentItemID: longParent.id,
  attachmentFilename: "long-cache.pdf",
  isPDFAttachment: () => true,
  getFilePathAsync: async () => longPDFPath,
};
items.set(longPDF.id, longPDF);
longParent.attachmentIDs.push(longPDF.id);
const longMDPath = path.join(tempDir, "long-old.md");
await fs.writeFile(longMDPath, "# Old long-name cache Markdown");
const longMD = markdownItem({
  id: 52,
  key: "LONGMD01",
  parentItemID: longParent.id,
  title: "MinerU Markdown (LONGJSON1).md",
  target: longMDPath,
});
items.set(longMD.id, longMD);
longParent.attachmentIDs.push(longMD.id);
const longInfo = await fs.stat(longPDFPath);
const longDir = path.join(tempDir, "zotero-mcp", "mineru", longPDF.key);
const longRawDir = path.join(longDir, "raw");
await fs.mkdir(longRawDir, { recursive: true });
await fs.writeFile(
  path.join(longRawDir, `${"a".repeat(210)}_content_list_v2.json`),
  JSON.stringify([[
    {
      type: "paragraph",
      content: { paragraph_content: [{ type: "text", content: "Migrated long-name body" }] },
    },
  ]]),
);
await fs.writeFile(
  path.join(longDir, "meta.json"),
  JSON.stringify({
    version: 1,
    attachmentKey: longPDF.key,
    libraryID: 1,
    fileName: "long-cache.pdf",
    fileSize: longInfo.size,
    fileMTime: longInfo.mtimeMs,
    signature: "legacy",
    parsedAt: new Date(0).toISOString(),
    markdownLength: 1,
  }),
);
await service.migrateLegacyCaches();
assert.equal(
  await service.getMarkdownForAttachment(longPDF, {
    allowParse: false,
    ignoreEnabled: true,
  }),
  "Migrated long-name body",
  "long MinerU JSON names remain selectable after cache migration and disk reread",
);
assert.ok(
  (await fs.readdir(longRawDir)).some((name) =>
    name.endsWith("_content_list_v2.json"),
  ),
  "cache filenames preserve the structured source suffix",
);

const stableMetaPath = path.join(tempDir, "zotero-mcp", "mineru", pdf.key, "meta.json");
const stableBefore = JSON.parse(await fs.readFile(stableMetaPath, "utf8"));
await service.migrateLegacyCaches();
const stableAfter = JSON.parse(await fs.readFile(stableMetaPath, "utf8"));
assert.equal(
  stableAfter.assemblerVersion,
  stableBefore.assemblerVersion,
  "re-running startup migration does not downgrade a current cache",
);
assert.equal(stableAfter.generatedAttachmentKey, stableBefore.generatedAttachmentKey);

preferences.set("extensions.zotero.zotero-mcp-plugin.mineru.mode", "local");
preferences.set(
  "extensions.zotero.zotero-mcp-plugin.mineru.baseURL",
  "http://127.0.0.1:18101",
);
const parent3 = parentItem(20, "PARENT3");
items.set(parent3.id, parent3);
const pdfPath3 = path.join(tempDir, "paper3.pdf");
await fs.writeFile(pdfPath3, "third PDF fixture");
const pdf3 = {
  id: 21,
  key: "PDFKEY3",
  libraryID: 1,
  parentItemID: parent3.id,
  attachmentFilename: "paper3.pdf",
  isPDFAttachment: () => true,
  getFilePathAsync: async () => pdfPath3,
};
items.set(pdf3.id, pdf3);
parent3.attachmentIDs.push(pdf3.id);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      content_list_v2: "{broken",
      content_list: [{ type: "text", text: "legacy fallback is forbidden" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
try {
  service.resetRunStats();
  await assert.rejects(
    service.getMarkdownForAttachment(pdf3, {
      allowParse: true,
      ignoreEnabled: true,
      force: true,
      userInitiated: true,
    }),
    /content_list_v2 JSON is invalid/i,
    "an explicit Reader parse reports the structured-data failure without fallback",
  );
  service.recordIndexFallback(
    pdf3,
    "built-in PDF extraction was used after MinerU failed",
  );
  service.recordIndexFallback(
    pdf3,
    "duplicate fallback for the same PDF must not be counted twice",
  );
  const failureStats = service.getRunStats();
  assert.equal(failureStats.failures, 1);
  assert.match(failureStats.lastError, /content_list_v2 JSON is invalid/i);
} finally {
  globalThis.fetch = originalFetch;
}

await fs.rm(tempDir, { recursive: true, force: true });
console.log("MinerU structured service tests passed");
