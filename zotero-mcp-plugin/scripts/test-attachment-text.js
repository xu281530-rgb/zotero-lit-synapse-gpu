/* eslint-env node */

/**
 * Regression tests for `get_attachment_text` (src/modules/attachmentText.ts).
 *
 * Three properties are worth pinning, and each replaces a specific behaviour
 * of the `get_content` this tool succeeds:
 *
 *  - Windows page and never end mid-word, because a model reading a seam
 *    cannot tell a truncation artefact from the source text.
 *  - Attachment selection is automatic only when it is unambiguous, because
 *    reading the wrong attachment returns text that looks perfectly valid and
 *    belongs to a different document.
 *  - Every extraction path has a distinct name and an explanation, because
 *    "this table came from Zotero's flat text cache" and "this table came from
 *    Doc2X Markdown" are different claims about the same-looking output.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register("./ts-ext-hooks.mjs", import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  DEFAULT_ATTACHMENT_TEXT_WINDOW,
  MAX_ATTACHMENT_TEXT_WINDOW,
  WINDOW_BOUNDARY_SEARCH_CHARS,
  describeTextMethod,
  isEmptyTextMethod,
  resolveOffset,
  resolveWindowSize,
  selectAttachment,
  takeTextWindow,
} = await import("../src/modules/attachmentText.ts");
const {
  STANDARD_AGGREGATE_CONTENT_LIMITS,
  resolveAttachmentContentLimit,
} = await import("../src/modules/contentExtractionDefaults.ts");

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

function attachment(overrides = {}) {
  return {
    attachmentKey: overrides.attachmentKey ?? "PDF1",
    filename: overrides.filename ?? "paper.pdf",
    contentType: overrides.contentType ?? "application/pdf",
    hasExtractableText: overrides.hasExtractableText ?? true,
    isGeneratedMarkdown: overrides.isGeneratedMarkdown ?? false,
  };
}

test("window size is clamped into the allowed range", () => {
  assert.equal(resolveWindowSize(undefined), DEFAULT_ATTACHMENT_TEXT_WINDOW);
  assert.equal(resolveWindowSize(0), DEFAULT_ATTACHMENT_TEXT_WINDOW);
  assert.equal(resolveWindowSize("x"), DEFAULT_ATTACHMENT_TEXT_WINDOW);
  assert.equal(resolveWindowSize(500), 500);
  // No value returns the whole document, which is the point.
  assert.equal(resolveWindowSize(10 ** 9), MAX_ATTACHMENT_TEXT_WINDOW);
});

test("offset is clamped into the text", () => {
  assert.equal(resolveOffset(undefined, 100), 0);
  assert.equal(resolveOffset(-5, 100), 0);
  assert.equal(resolveOffset(40, 100), 40);
  assert.equal(resolveOffset(4000, 100), 100);
});

test("windows tile the text exactly once, in order", () => {
  const text = Array.from({ length: 60 }, (_, i) => `Sentence ${i}. `).join("");
  let offset = 0;
  let assembled = "";
  let windows = 0;

  for (;;) {
    const window = takeTextWindow(text, offset, 100);
    assembled += window.text;
    windows += 1;
    if (!window.hasMore) break;
    offset = window.nextOffset;
    assert.ok(windows < 200, "windowing did not terminate");
  }

  assert.equal(assembled, text, "reassembled text must equal the original");
  assert.ok(windows > 1, "the fixture must actually need several windows");
});

test("attachment extraction is complete before character-window paging", () => {
  assert.deepEqual(STANDARD_AGGREGATE_CONTENT_LIMITS, {
    maxContentLength: 3000,
    maxAttachments: 10,
    maxNotes: 15,
    includeWebpage: true,
  });
  assert.equal(resolveAttachmentContentLimit(false), 3000);
  assert.equal(resolveAttachmentContentLimit(true), -1);

  const server = fs.readFileSync(
    path.join(root, "src/modules/streamableMCPServer.ts"),
    "utf8",
  );
  const extractor = fs.readFileSync(
    path.join(root, "src/modules/unifiedContentExtractor.ts"),
    "utf8",
  );
  assert.match(
    server,
    /getAttachmentContent\(\s*attachment\.key,\s*\{ preserveOriginal: true \},\s*attachment\.libraryID/s,
  );
  for (const removed of [
    "MCPSettingsService",
    "getModeConfiguration",
    "IntelligentContentProcessor",
  ]) {
    assert.ok(!extractor.includes(removed), `extractor still uses ${removed}`);
  }
});

test("a window ends on a boundary rather than mid-word", () => {
  const text = "First paragraph here.\n\nSecond paragraph starts now and continues for a while.";
  // Cut inside "paragraph" of the second sentence.
  const window = takeTextWindow(text, 0, 30);
  assert.ok(window.endsOnBoundary);
  assert.ok(
    window.text.endsWith("\n") || /[.!?。！？；;]$/.test(window.text.trim()),
    `window ended mid-token: ${JSON.stringify(window.text.slice(-20))}`,
  );
});

test("the boundary search only ever moves the cut forward", () => {
  // Moving it back would return less than asked while hasMore is true, which
  // reads as "the text ran out" — and a caller that stops there loses the rest.
  const text = "x".repeat(5000);
  const window = takeTextWindow(text, 0, 1000);
  assert.ok(
    window.returnedChars >= 1000,
    `a boundaryless window must not shrink: got ${window.returnedChars}`,
  );
  assert.ok(
    window.returnedChars <= 1000 + WINDOW_BOUNDARY_SEARCH_CHARS,
    "and must not overrun the search budget",
  );
});

test("the last window reports no continuation", () => {
  const text = "short text";
  const window = takeTextWindow(text, 0, 1000);
  assert.equal(window.text, text);
  assert.equal(window.hasMore, false);
  assert.equal(window.nextOffset, undefined);
  assert.equal(window.totalChars, text.length);
});

test("an offset at or past the end yields an empty terminal window", () => {
  const window = takeTextWindow("abc", 3, 100);
  assert.equal(window.text, "");
  assert.equal(window.returnedChars, 0);
  assert.equal(window.hasMore, false);
});

test("one readable attachment is chosen automatically", () => {
  const result = selectAttachment([attachment()], undefined);
  assert.equal(result.kind, "selected");
  assert.equal(result.automatic, true);
  assert.equal(result.attachment.attachmentKey, "PDF1");
});

test("a generated Markdown sibling never makes the choice ambiguous", () => {
  // MinerU writes a .md alongside the PDF it parsed. Counting it would turn
  // every parsed one-PDF item into a two-candidate prompt for no reason, and
  // the two hold the same content anyway.
  const result = selectAttachment(
    [
      attachment(),
      attachment({
        attachmentKey: "MD1",
        filename: "paper.md",
        contentType: "text/markdown",
        isGeneratedMarkdown: true,
      }),
    ],
    undefined,
  );
  assert.equal(result.kind, "selected");
  assert.equal(result.attachment.attachmentKey, "PDF1");
});

test("two genuine candidates are never guessed between", () => {
  const result = selectAttachment(
    [
      attachment({ attachmentKey: "PDF1", filename: "preprint.pdf" }),
      attachment({ attachmentKey: "PDF2", filename: "published.pdf" }),
    ],
    undefined,
  );
  assert.equal(result.kind, "choose");
  assert.equal(result.candidates.length, 2);
});

test("an explicit key is honoured, and a wrong one is refused", () => {
  const list = [attachment(), attachment({ attachmentKey: "PDF2" })];
  const chosen = selectAttachment(list, "PDF2");
  assert.equal(chosen.kind, "selected");
  assert.equal(chosen.automatic, false);
  assert.equal(chosen.attachment.attachmentKey, "PDF2");

  const missing = selectAttachment(list, "NOPE");
  assert.equal(missing.kind, "not_found");
  assert.equal(missing.requestedKey, "NOPE");
});

test("an item with nothing readable says so instead of choosing", () => {
  assert.equal(selectAttachment([], undefined).kind, "none");
  assert.equal(
    selectAttachment(
      [attachment({ hasExtractableText: false, filename: "scan.png" })],
      undefined,
    ).kind,
    "none",
  );
});

test("every method has an explanation, and the lossy one warns", () => {
  const methods = [
    "doc2x",
    "mineru_cache",
    "mineru_attachment",
    "mineru",
    "markdown_attachment",
    "zotero_fulltext_cache",
    "pdf_processor",
    "pdf_processor_timeout",
    "html_parsing",
    "text_reading",
    "mineru_disabled",
    "mineru_on_demand_disabled",
    "mineru_failed",
    "mineru_error",
    "no_text",
  ];
  for (const method of methods) {
    const description = describeTextMethod(method);
    assert.ok(
      description && description.length > 20,
      `${method} has no usable description`,
    );
  }
  // The distinction that matters most: flat cache output has no layout, and
  // saying so is what stops a table being reconstructed from it.
  assert.match(describeTextMethod("zotero_fulltext_cache"), /NOT preserved/);
  assert.match(describeTextMethod("doc2x"), /publisher/);
});

test("the empty methods are exactly the ones with no text", () => {
  for (const method of [
    "mineru_disabled",
    "mineru_on_demand_disabled",
    "mineru_failed",
    "mineru_error",
    "pdf_processor_timeout",
    "no_text",
  ]) {
    assert.equal(isEmptyTextMethod(method), true, `${method} should be empty`);
  }
  for (const method of [
    "doc2x",
    "mineru_cache",
    "mineru_attachment",
    "mineru",
    "markdown_attachment",
    "zotero_fulltext_cache",
    "pdf_processor",
    "html_parsing",
    "text_reading",
  ]) {
    assert.equal(
      isEmptyTextMethod(method),
      false,
      `${method} produces text and must not be flagged empty`,
    );
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error.message}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
