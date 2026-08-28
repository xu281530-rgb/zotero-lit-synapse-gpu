/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  appendMacroSummary,
  appendReadingRecord,
  parseAppendOnlyReadingNote,
  WikiReadingNoteStore,
} = await import("../src/modules/wiki/wikiReadingNote.ts");

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("reading records are server-numbered and append-only", () => {
  const first = appendReadingRecord("", {
    chunkIds: [12, 13],
    content: "- The pressure may reach 50 MPa (chunk 12).",
  });
  const second = appendReadingRecord(first, {
    chunkIds: [14],
    content: "- Correction to record 1: the pressure is conditional (chunk 14).",
  });
  const parsed = parseAppendOnlyReadingNote(second);

  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].number, 1);
  assert.deepEqual(parsed.records[0].chunkIds, [12, 13]);
  assert.equal(parsed.records[1].number, 2);
  assert.match(second, /### 第 1 次 · chunk 12-13/u);
  assert.match(second, /### 第 2 次 · chunk 14/u);
  assert.ok(
    second.includes(first.trim()),
    "the exact earlier document is a prefix of the appended document",
  );
});

test("legacy notes stay byte-for-byte intact before new records", () => {
  const legacy = "# Old narrative\n\nA legacy paragraph (chunk 7).";
  const next = appendReadingRecord(legacy, {
    chunkIds: [20],
    content: "- A new observation (chunk 20).",
  });
  const parsed = parseAppendOnlyReadingNote(next);

  assert.equal(parsed.legacyBody, legacy);
  assert.ok(next.startsWith(legacy));
  assert.equal(parsed.records.length, 1);
});

test("no-new-content records may repeat without invented prose", () => {
  let body = appendReadingRecord("", {
    chunkIds: [30],
    content: "- 本次无新内容（参考文献）。",
  });
  body = appendReadingRecord(body, {
    chunkIds: [31],
    content: "- 本次无新内容（致谢）。",
  });

  const parsed = parseAppendOnlyReadingNote(body);
  assert.equal(parsed.records.length, 2);
  assert.ok(parsed.records.every((record) => record.noNewContent));
});

test("a distilled macro summary is appended after the immutable records", () => {
  let body = appendReadingRecord("", {
    chunkIds: [40],
    content: "- The method is proposed as a possible solution (chunk 40).",
  });
  body = appendReadingRecord(body, {
    chunkIds: [41],
    content: "- 本次无新内容（参考文献）。",
  });
  const beforeSummary = body;

  const summary =
    "The paper's core contribution is a proposed solution to the stated method problem (chunk 40).";
  body = appendMacroSummary(body, summary);
  const parsed = parseAppendOnlyReadingNote(body);

  assert.ok(body.startsWith(beforeSummary.trim()));
  assert.equal(parsed.macroSummary, summary);
  assert.throws(
    () => appendMacroSummary(body, summary),
    /already has|已有/u,
  );
});

test("all AI reading notes can be deleted across Zotero libraries", async () => {
  const erased = [];
  const contents = new Map();
  const unreadablePaths = new Set();
  const attachment = ({
    key,
    title,
    filename,
    parentItemID = 10,
    contentType = "text/markdown",
    content = "# User-authored note",
    unreadable = false,
  }) => {
    const filePath = `test://${key}.md`;
    contents.set(filePath, content);
    if (unreadable) unreadablePaths.add(filePath);
    return {
      key,
      parentItemID,
      attachmentContentType: contentType,
      isAttachment: () => true,
      getField: (field) => (field === "title" ? title : ""),
      attachmentFilename: filename,
      getFilePathAsync: async () => filePath,
      eraseTx: async () => erased.push(key),
    };
  };
  const titleMatched = attachment({
    key: "TITLE1",
    title: "Wiki Reading Note (PAPER1).md",
    filename: "renamed.md",
    content:
      "<!-- ZOTERO-MCP-WIKI-READING-NOTE: machine-maintained, do not edit -->\nAI note",
  });
  const filenameMatched = attachment({
    key: "FILE2",
    title: "Renamed by user",
    filename: "also-renamed.md",
    content:
      "<!-- ZOTERO-MCP-WIKI-READING-NOTE: machine-maintained, do not edit -->\nAI note",
  });
  const ordinaryMarkdown = attachment({
    key: "USER3",
    title: "My notes.md",
    filename: "my-notes.md",
  });
  const similarlyNamedMarkdown = attachment({
    key: "USER4",
    title: "Wiki Reading Note - personal.md",
    filename: "personal-reading-note.md",
  });
  const standaloneLookalike = attachment({
    key: "USER5",
    title: "Wiki Reading Note (PAPER5).md",
    filename: "zotero-mcp-reading-note-PAPER5.md",
    parentItemID: 0,
  });
  const pdfLookalike = attachment({
    key: "USER6",
    title: "Wiki Reading Note (PAPER6).md",
    filename: "zotero-mcp-reading-note-PAPER6.md",
    contentType: "application/pdf",
  });
  const exactNameCollision = attachment({
    key: "USER7",
    title: "Wiki Reading Note (PAPER7).md",
    filename: "zotero-mcp-reading-note-PAPER7.md",
  });
  const unreadableGeneratedNote = attachment({
    key: "BROKEN8",
    title: "Wiki Reading Note (PAPER8).md",
    filename: "zotero-mcp-reading-note-PAPER8.md",
    unreadable: true,
  });

  globalThis.Zotero = {
    Libraries: {
      getAll: () => [{ libraryID: 1 }, { id: 2 }],
      userLibraryID: 1,
    },
    Items: {
      getAll: async (libraryID) =>
        libraryID === 1
          ? [
              titleMatched,
              ordinaryMarkdown,
              similarlyNamedMarkdown,
              standaloneLookalike,
              pdfLookalike,
              exactNameCollision,
              unreadableGeneratedNote,
            ]
          : [202],
      getAsync: async (id) => (id === 202 ? filenameMatched : null),
    },
  };
  globalThis.IOUtils = {
    readUTF8: async (filePath) => {
      if (unreadablePaths.has(filePath)) throw new Error("unreadable");
      return contents.get(filePath);
    },
  };
  globalThis.ztoolkit = { log: () => undefined };

  const result = await new WikiReadingNoteStore().clearAllAttachments();

  assert.deepEqual(result, { removed: 2, failed: 1 });
  assert.deepEqual(erased, ["TITLE1", "FILE2"]);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  not ok  ${name}`);
    console.error(error);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
