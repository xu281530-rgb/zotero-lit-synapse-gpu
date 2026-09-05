/* eslint-env node */

/**
 * A key that names the wrong kind of thing must fail loudly.
 *
 * All Zotero keys look alike, so nothing about `W5ZLUXHV` says it is a PDF
 * rather than a paper. Both failures below were found by calling the live
 * server, not by reading the code, because both LOOKED like success:
 *
 *  - get_item_details("W5ZLUXHV") returned 200 with itemType "attachment" and
 *    the PDF's filename as the title. A caller gets a bibliographic record for
 *    a paper called "2020-Statistical-Numerical_Model_...pdf".
 *  - get_document_chunks("2YNJQJ9U"), a note, answered that the item "has a
 *    text attachment but is not in the semantic index yet". A note has no
 *    attachment, and building the index can never make that call work, so the
 *    suggested fix leads nowhere.
 *
 * The message has to say what the key actually names AND which key to use
 * instead, or the caller has no way forward.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const { describeNonDocumentKey } = await import(
  "../src/modules/itemKeyKind.ts"
);

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

const DOCUMENT_TOOLS = [
  "get_item_details",
  "get_document_chunks",
  "search_fulltext",
];

test("a real document key is not refused", () => {
  for (const tool of DOCUMENT_TOOLS) {
    assert.equal(
      describeNonDocumentKey({ key: "KHRKFKB4", kind: "regular" }, tool),
      null,
    );
  }
});

test("an attachment key is refused and the document named", () => {
  const message = describeNonDocumentKey(
    { key: "W5ZLUXHV", kind: "attachment", parentItemKey: "KHRKFKB4" },
    "get_item_details",
  );
  assert.ok(message);
  assert.match(message, /W5ZLUXHV/);
  assert.match(message, /attachment/);
  // Without the parent key the caller is stuck holding a key they cannot use.
  assert.match(message, /KHRKFKB4/);
  assert.match(message, /get_item_details/);
});

test("a note key is refused and pointed at the tool that reads notes", () => {
  const message = describeNonDocumentKey(
    { key: "2YNJQJ9U", kind: "note" },
    "get_document_chunks",
  );
  assert.ok(message);
  assert.match(message, /get_annotations/);
  // The old message blamed the semantic index for a note, sending the caller
  // to build an index that cannot help.
  assert.ok(
    !/semantic index/i.test(message),
    "the refusal still blames the index for something that is not a document",
  );
  assert.ok(
    !/text attachment/i.test(message),
    "the refusal still claims a note has an attachment",
  );
});

test("a child note names the document it was filed under", () => {
  const message = describeNonDocumentKey(
    { key: "7JEIPJEX", kind: "note", parentItemKey: "F3TZS8WU" },
    "search_fulltext",
  );
  assert.match(message, /F3TZS8WU/);
  assert.match(message, /search_fulltext/);
});

test("a standalone container says there is nothing above it", () => {
  // Silence here would read as "the lookup failed", inviting a retry.
  const note = describeNonDocumentKey({ key: "LZKYB2Q7", kind: "note" }, "x");
  assert.match(note, /no document|belongs to no document|nothing further up/i);

  const attachment = describeNonDocumentKey(
    { key: "AAAA1111", kind: "attachment" },
    "x",
  );
  assert.match(attachment, /standalone|no document/i);
  assert.match(attachment, /get_attachment_text/);
});

test("an annotation key is refused and pointed at annotationIds", () => {
  const message = describeNonDocumentKey(
    { key: "3UDCAPN7", kind: "annotation", parentItemKey: "W5ZLUXHV" },
    "get_item_details",
  );
  assert.match(message, /annotationIds/);
  assert.match(message, /get_annotations/);
});

test("every refusal names the tool that was called", () => {
  // A generic message leaves the caller guessing which of several calls in
  // flight was the bad one.
  for (const kind of ["attachment", "note", "annotation"]) {
    for (const tool of DOCUMENT_TOOLS) {
      const message = describeNonDocumentKey({ key: "K", kind }, tool);
      assert.ok(message.includes(tool), `${kind}/${tool} message is generic`);
    }
  }
});

test("the three document-level tools all apply the guard", () => {
  // The guard is only as good as its call sites, and the type system cannot
  // require one.
  const source = fs.readFileSync(
    path.join(rootDir, "src/modules/streamableMCPServer.ts"),
    "utf8",
  );
  for (const tool of DOCUMENT_TOOLS) {
    assert.match(
      source,
      new RegExp(`assertDocumentKey\\([\\s\\S]{0,240}'${tool}'`),
      `${tool} does not check the kind of key it was handed`,
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
