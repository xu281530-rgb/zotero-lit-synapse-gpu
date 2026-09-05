/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  appendMacroSummary,
  appendReadingRecord,
  parseAppendOnlyReadingNote,
  readingNoteAttachmentTitle,
  readingNoteEpisode,
  readingNoteFileName,
  WikiReadingNoteStore,
} = await import("../src/modules/wiki/wikiReadingNote.ts");

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("a concluded note stays closed, so a later episode needs its own file", () => {
  // The invariant: 全文总结 synthesises every record above it, so no record
  // may follow. That is right, and it is also why a paper read through once
  // could never record question-driven reading again - measured across three
  // real runs on four papers, not one such read was ever recorded. The fix is
  // a second note, NOT a relaxation of this rule, so the rule must still hold.
  const first = appendReadingRecord("", {
    chunkIds: [3],
    content: "- The traverse begins at station 3 (chunk 3).",
  });
  const concluded = appendMacroSummary(first, "The paper reports a traverse.");
  assert.throws(
    () =>
      appendReadingRecord(concluded, {
        chunkIds: [4],
        content: "- A later question reaches station 4 (chunk 4).",
      }),
    /already has a macro summary/u,
    "appending after the summary would make it describe records it never saw",
  );
  // And the second note is an ordinary note: same format, numbered from one.
  const second = appendReadingRecord("", {
    chunkIds: [4],
    content: "- A later question reaches station 4 (chunk 4).",
  });
  const parsed = parseAppendOnlyReadingNote(second);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].number, 1, "a new episode counts from one");
  assert.deepEqual(parsed.records[0].chunkIds, [4]);
  assert.equal(parsed.macroSummary, null);
});

test("episode one keeps the original name; later ones are numbered", () => {
  // Episode 1 must not be renamed, or every note already on disk would have
  // to be migrated to keep being found.
  assert.equal(
    readingNoteAttachmentTitle("ABCD1234"),
    "Wiki Reading Note (ABCD1234).md",
  );
  assert.equal(
    readingNoteAttachmentTitle("ABCD1234", 1),
    "Wiki Reading Note (ABCD1234).md",
  );
  assert.equal(
    readingNoteAttachmentTitle("ABCD1234", 2),
    "Wiki Reading Note (ABCD1234) #2.md",
  );
  assert.notEqual(
    readingNoteFileName("ABCD1234", 2),
    readingNoteFileName("ABCD1234", 1),
    "two episodes cannot share a staging filename",
  );

  const titled = (title) => ({ getField: () => title });
  assert.equal(readingNoteEpisode(titled("Wiki Reading Note (ABCD1234).md")), 1);
  assert.equal(
    readingNoteEpisode(titled("Wiki Reading Note (ABCD1234) #2.md")),
    2,
  );
  assert.equal(
    readingNoteEpisode(titled("Wiki Reading Note (ABCD1234) #11.md")),
    11,
  );
  // Anything unparseable is episode 1, never a crash and never a higher
  // number that would push a real note out of last place.
  assert.equal(readingNoteEpisode({}), 1);
  assert.equal(readingNoteEpisode(titled("")), 1);

  // A user who renames the attachment in Zotero must not renumber the note.
  // The title is the half people edit; the filename is the durable one, and
  // reading the number off it is what stops a renamed episode 3 reporting as
  // episode 1 - which would make the next note collide with a file that
  // already exists.
  const renamed = {
    getField: (field) => (field === "title" ? "my notes on the twinning paper" : ""),
    attachmentFilename: "wiki-reading-note-ABCD1234-3.md",
  };
  assert.equal(readingNoteEpisode(renamed), 3, "the filename still names the episode");

  // Episode 1's filename carries no suffix, and must not be read as one.
  assert.equal(
    readingNoteEpisode({
      getField: () => "renamed too",
      attachmentFilename: "wiki-reading-note-ABCD1234.md",
    }),
    1,
  );
});

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
      "<!-- ZOTERO-LIT-SYNAPSE-WIKI-READING-NOTE: machine-maintained, do not edit -->\nAI note",
  });
  const filenameMatched = attachment({
    key: "FILE2",
    title: "Renamed by user",
    filename: "also-renamed.md",
    content:
      "<!-- ZOTERO-LIT-SYNAPSE-WIKI-READING-NOTE: machine-maintained, do not edit -->\nAI note",
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
    filename: "zotero-lit-synapse-reading-note-PAPER5.md",
    parentItemID: 0,
  });
  const pdfLookalike = attachment({
    key: "USER6",
    title: "Wiki Reading Note (PAPER6).md",
    filename: "zotero-lit-synapse-reading-note-PAPER6.md",
    contentType: "application/pdf",
  });
  const exactNameCollision = attachment({
    key: "USER7",
    title: "Wiki Reading Note (PAPER7).md",
    filename: "zotero-lit-synapse-reading-note-PAPER7.md",
  });
  const unreadableGeneratedNote = attachment({
    key: "BROKEN8",
    title: "Wiki Reading Note (PAPER8).md",
    filename: "zotero-lit-synapse-reading-note-PAPER8.md",
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
