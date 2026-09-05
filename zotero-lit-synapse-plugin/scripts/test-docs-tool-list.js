/* eslint-env node */

/**
 * The READMEs are the third copy of the tool list, and they drifted like the
 * other two.
 *
 * Both files documented three `hybrid_search` features that were never
 * implemented — `candidateK`, `pagination.totalRelevantIsLowerBound` as a
 * candidate-pool signal, and `metadata.candidatePoolSaturated` — and omitted
 * eight tools that existed, including every collection-mutation tool. A
 * developer reading either one was told about parameters the server rejects.
 *
 * This test cannot check prose, but it can check the two things that actually
 * rot: the SET of tool names, and the presence of names that no longer exist.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(rootDir, "..");

const { buildToolCatalog, REMOVED_TOOL_REPLACEMENTS } = await import(
  "../src/modules/toolCatalog.ts"
);

const actual = buildToolCatalog().map((tool) => tool.name);
const removed = Object.keys(REMOVED_TOOL_REPLACEMENTS);

const READMES = ["README.md", "README-zh.md"];

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

function readDoc(file) {
  return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

/**
 * Names a README presents as tools: `#### \`name\`` headings, plus the bullet
 * form used for the collection-mutation group (`- \`name\` —` / `——`).
 */
function documentedNames(markdown) {
  const names = new Set();
  for (const match of markdown.matchAll(/^#### `([a-z_]+)`/gm)) {
    names.add(match[1]);
  }
  for (const match of markdown.matchAll(/^- `([a-z_]+)` (?:—|——)/gm)) {
    names.add(match[1]);
  }
  return names;
}

for (const file of READMES) {
  test(`${file} documents every tool the server serves`, () => {
    const documented = documentedNames(readDoc(file));
    const missing = actual.filter((name) => !documented.has(name));
    assert.deepEqual(
      missing,
      [],
      `${file} does not document: ${missing.join(", ")}`,
    );
  });

  test(`${file} documents no tool the server does not serve`, () => {
    const documented = [...documentedNames(readDoc(file))];
    const phantom = documented.filter((name) => !actual.includes(name));
    assert.deepEqual(
      phantom,
      [],
      `${file} documents tools that do not exist: ${phantom.join(", ")}`,
    );
  });

  test(`${file} does not present a removed tool as usable`, () => {
    const markdown = readDoc(file);
    for (const name of removed) {
      // Mentioning a removed name is fine and often useful — the migration
      // notes do it deliberately. Presenting it as a tool heading is not.
      assert.ok(
        !new RegExp(`^#### \`${name}\``, "m").test(markdown),
        `${file} still has a section header for the removed tool ${name}`,
      );
    }
  });

  test(`${file} does not document parameters that were never implemented`, () => {
    const markdown = readDoc(file);
    // These three were documented in detail, at length, and never existed.
    // Retrieval is exhaustive, so there is no candidate pool to saturate.
    for (const phantom of ["candidatePoolSaturated"]) {
      assert.ok(
        !markdown.includes(phantom),
        `${file} still documents the nonexistent ${phantom}`,
      );
    }
    // `candidateK` may appear only in the sentence that says it does not exist.
    const candidateKMentions = [
      ...markdown.matchAll(/candidateK/g),
    ].length;
    if (candidateKMentions > 0) {
      assert.ok(
        /no `candidateK`|没有 `candidateK`/.test(markdown),
        `${file} mentions candidateK without saying it does not exist`,
      );
      assert.equal(
        candidateKMentions,
        1,
        `${file} should mention candidateK once, only to deny it`,
      );
    }
  });
}

test("the catalog's own parameter names appear in at least one README", () => {
  // A weak but load-bearing check: the tools introduced in 1.9.0 must be
  // described somewhere, not merely listed.
  const english = readDoc("README.md");
  for (const marker of [
    "textSource.method",
    "chunkIndex",
    "directItemCount",
    "totalItemCount",
    "keyword_search",
    "get_document_chunks",
    "get_attachment_text",
    // write_item's `import` action and its three parameters were shipped and
    // never documented: both READMEs described the tool as create/reparent
    // only. These two names exist nowhere else in the catalog, so they are a
    // real check rather than a word that happens to appear in a code sample.
    "filePath",
    "parentItemKey",
  ]) {
    assert.ok(
      english.includes(marker),
      `README.md never mentions ${marker}`,
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
