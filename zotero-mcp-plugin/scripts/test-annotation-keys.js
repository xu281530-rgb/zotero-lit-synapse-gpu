/* eslint-env node */

/**
 * The search_annotations -> get_annotations chain.
 *
 * A mark lives three levels down: annotation -> attachment -> document. The
 * row used to report a single `parentKey`, which was the ATTACHMENT key for a
 * highlight and the ITEM key for a note. One name, two meanings.
 *
 * The consequence was silent and specific. search_annotations found a
 * highlight and reported parentKey: "32MBWFLW"; feeding that to
 * get_annotations(itemKeys) -- the documented way to read the rest of that
 * paper's marks -- matched nothing, because "32MBWFLW" is a PDF, not a paper.
 * The call succeeded and returned zero marks, which reads as "this paper has
 * no highlights" rather than as "you were handed the wrong kind of key".
 *
 * These tests pin the three keys apart and pin the hand-off between the two
 * tools, which is the part no single-tool test can see.
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

const { resolveAnnotationKeys } = await import(
  "../src/modules/annotationKeys.ts"
);
const { resolveAnnotationItemKeys } = await import(
  "../src/modules/smartAnnotationExtractor.ts"
);
const { buildToolCatalog } = await import("../src/modules/toolCatalog.ts");

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// The shape of the live library this was reproduced against: a paper, its
// PDF, and a highlight on that PDF. All three keys differ.
const PAPER = "JHLXMYI6";
const PDF = "32MBWFLW";
const MARK = "ANNOT001";

test("a highlight reports the document, the PDF and itself separately", () => {
  const keys = resolveAnnotationKeys({
    ownKey: MARK,
    attachmentKey: PDF,
    attachmentParentKey: PAPER,
  });
  assert.deepEqual(keys, {
    annotationKey: MARK,
    attachmentKey: PDF,
    sourceItemKey: PAPER,
  });
});

test("the document key is not the attachment key", () => {
  // The whole bug in one assertion: the old `parentKey` held the second of
  // these while every document-level tool needed the first.
  const keys = resolveAnnotationKeys({
    ownKey: MARK,
    attachmentKey: PDF,
    attachmentParentKey: PAPER,
  });
  assert.notEqual(keys.sourceItemKey, keys.attachmentKey);
  assert.notEqual(keys.sourceItemKey, keys.annotationKey);
});

test("a search hit can be read straight back by get_annotations", () => {
  // The hand-off the two tools exist to support: search finds a mark without
  // knowing its paper, then the paper's other marks are read in full.
  const hit = resolveAnnotationKeys({
    ownKey: MARK,
    attachmentKey: PDF,
    attachmentParentKey: PAPER,
  });

  // get_annotations resolves its `itemKeys` through this, so passing the hit's
  // sourceItemKey through it is the actual call path, not a stand-in.
  const requested = resolveAnnotationItemKeys({
    itemKeys: [hit.sourceItemKey],
  });
  assert.deepEqual(requested, [PAPER]);

  // And the field that used to be handed over would have asked for the PDF.
  const wrong = resolveAnnotationItemKeys({ itemKeys: [hit.attachmentKey] });
  assert.deepEqual(wrong, [PDF]);
  assert.notDeepEqual(wrong, requested);
});

test("marks from several papers stay attributable", () => {
  const rows = [
    { ownKey: "M1", attachmentKey: "PDF_A", attachmentParentKey: "PAPER_A" },
    { ownKey: "M2", attachmentKey: "PDF_B", attachmentParentKey: "PAPER_B" },
    { ownKey: "M3", attachmentKey: "PDF_A", attachmentParentKey: "PAPER_A" },
  ].map(resolveAnnotationKeys);

  assert.deepEqual(
    rows.map((row) => row.sourceItemKey),
    ["PAPER_A", "PAPER_B", "PAPER_A"],
  );
  // Two marks on one PDF must not collapse into one document, and one paper
  // with two PDFs must not split into two.
  assert.equal(new Set(rows.map((row) => row.sourceItemKey)).size, 2);
});

test("a note has no attachment and belongs to its document", () => {
  const keys = resolveAnnotationKeys({
    ownKey: "NOTE001",
    noteParentKey: PAPER,
  });
  assert.deepEqual(keys, {
    annotationKey: "NOTE001",
    sourceItemKey: PAPER,
  });
  assert.equal("attachmentKey" in keys, false);
});

test("a standalone note has no document, and says so", () => {
  // This was briefly the note's OWN key, on the reasoning that a top-level
  // note is an item in its own right. Against the live library that
  // reproduced the original bug exactly: get_annotations(itemKeys: [thatKey])
  // returned 0 marks with mode "empty", and get_document_chunks answered that
  // the note "has a text attachment but is not in the semantic index yet".
  // A key every document-level tool rejects is not a document key.
  const keys = resolveAnnotationKeys({
    ownKey: "NOTE002",
    noteParentKey: false,
  });
  assert.equal(keys.sourceItemKey, null);
  assert.equal(keys.noSourceItemReason, "standalone_note");
  // The row is still identifiable and still readable.
  assert.equal(keys.annotationKey, "NOTE002");
});

test("a mark on a standalone PDF has no document either", () => {
  // Zotero allows an attachment with no parent item. The attachment key is
  // still reported, because get_attachment_text can use it -- but it is not
  // offered as a document key.
  const keys = resolveAnnotationKeys({
    ownKey: MARK,
    attachmentKey: PDF,
    attachmentParentKey: false,
  });
  assert.equal(keys.sourceItemKey, null);
  assert.equal(keys.noSourceItemReason, "standalone_attachment");
  assert.equal(keys.attachmentKey, PDF);
});

test("sourceItemKey is a document key or null, never a stand-in", () => {
  // Every shape the hierarchy can present, including the degenerate ones. The
  // failure this guards against is a plausible-looking substitute, which is
  // worse than null because a caller will try to use it.
  const shapes = [
    [{ ownKey: "X" }, "standalone_note"],
    [
      { ownKey: "X", attachmentKey: null, attachmentParentKey: null },
      "standalone_note",
    ],
    [{ ownKey: "X", noteParentKey: null }, "standalone_note"],
    [
      { ownKey: "X", attachmentKey: "A", attachmentParentKey: false },
      "standalone_attachment",
    ],
  ];
  for (const [shape, reason] of shapes) {
    const keys = resolveAnnotationKeys(shape);
    assert.equal(
      keys.sourceItemKey,
      null,
      `sourceItemKey invented a value for ${JSON.stringify(shape)}`,
    );
    assert.equal(keys.noSourceItemReason, reason);
    assert.notEqual(keys.sourceItemKey, keys.annotationKey);
  }
});

test("a reason is present exactly when there is no document", () => {
  const withDocument = resolveAnnotationKeys({
    ownKey: MARK,
    attachmentKey: PDF,
    attachmentParentKey: PAPER,
  });
  assert.equal("noSourceItemReason" in withDocument, false);

  const without = resolveAnnotationKeys({ ownKey: MARK });
  assert.equal(without.sourceItemKey, null);
  assert.ok(without.noSourceItemReason);
});

test("the ambiguous parentKey is gone from annotation rows", () => {
  // Two meanings behind one name is the defect itself, so the field is not
  // kept as a deprecated alias -- a caller reading it would still be wrong
  // half the time.
  for (const file of [
    "src/modules/annotationService.ts",
    "src/modules/smartAnnotationExtractor.ts",
  ]) {
    const source = fs.readFileSync(path.join(rootDir, file), "utf8");
    assert.ok(
      !/^\s*parentKey[?]?:/m.test(source),
      `${file} still declares or emits parentKey on an annotation row`,
    );
  }
});

test("both annotation tools resolve their keys through one place", () => {
  // Notes and highlights arrive by different code paths; each inventing its
  // own answer is how they diverged in the first place.
  const service = fs.readFileSync(
    path.join(rootDir, "src/modules/annotationService.ts"),
    "utf8",
  );
  const uses = [...service.matchAll(/resolveAnnotationKeys\(/g)].length;
  assert.ok(
    uses >= 2,
    `expected the note path and the annotation path to both use resolveAnnotationKeys, found ${uses} call(s)`,
  );
});

test("the schemas tell the model which key to continue with", () => {
  // A correct field the description never mentions is a field the model will
  // not use; it will reach for whatever key it recognises.
  const catalog = buildToolCatalog();
  for (const name of ["search_annotations", "get_annotations"]) {
    const tool = catalog.find((entry) => entry.name === name);
    assert.ok(tool, `${name} missing from the catalog`);
    assert.ok(
      tool.description.includes("sourceItemKey"),
      `${name} never tells the caller that sourceItemKey is the document key`,
    );
    assert.ok(
      !/\bparentKey\b/.test(tool.description),
      `${name} still advertises the removed parentKey`,
    );
    assert.ok(
      tool.inputSchema.properties.itemKeys.description.includes(
        "sourceItemKey",
      ),
      `${name}'s itemKeys does not say which key it expects`,
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
