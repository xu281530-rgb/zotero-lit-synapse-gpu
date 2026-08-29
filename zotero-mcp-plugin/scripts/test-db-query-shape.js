/* eslint-env node */

/**
 * One rule about how this plugin is allowed to query Zotero's database.
 *
 * `Zotero.DBConnection.queryAsync` does not return a row array for every SELECT
 * it accepts. A SELECT with no FROM clause of its own - `SELECT (SELECT COUNT(*)
 * FROM t) AS a, (SELECT ...) AS b` - is valid SQLite and returns exactly one
 * row, but it came back as `undefined`, so the caller's `row[0]` threw
 *
 *     can't access property 0, row is undefined
 *
 * and every wiki_prepare_update failed, on every paper, for as long as that
 * build was installed. Nothing in the test suite could see it: the test double
 * is node:sqlite, which answers every SELECT with an array, so the code passed
 * locally and failed only against the real database.
 *
 * A test that mocked the failure would be a test of a guess about Zotero's
 * internals. This pins the thing actually established instead: every SELECT
 * that has ever worked here has a real FROM, and the one that did not is the
 * one that broke. Adding a FROM-less SELECT is therefore a change that has to
 * be made deliberately, against a real Zotero, rather than discovered by a
 * user thirty papers into a run.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Everything outside parentheses, so subqueries do not count as the outer one. */
function outerLevel(sql) {
  let depth = 0;
  let out = "";
  for (const character of sql) {
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (depth === 0) out += character;
  }
  return out;
}

const offenders = [];
for (const file of sourceFiles(SRC)) {
  const text = fs.readFileSync(file, "utf8");
  const pattern = /queryAsync\(\s*`(SELECT\b[\s\S]*?)`/giu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (/\bFROM\b/iu.test(outerLevel(match[1]))) continue;
    offenders.push({
      file: path.relative(process.cwd(), file),
      line: text.slice(0, match.index).split("\n").length,
      sql: match[1].replace(/\s+/gu, " ").slice(0, 80),
    });
  }
}

assert.deepEqual(
  offenders,
  [],
  offenders.length
    ? `queryAsync was given a SELECT with no top-level FROM. Zotero returned ` +
      `undefined for one of those and the caller's row[0] threw. Use ` +
      `valueQueryAsync for scalars, or give the query a real FROM:\n` +
      offenders
        .map((entry) => `  ${entry.file}:${entry.line}  ${entry.sql}…`)
        .join("\n")
    : "",
);

console.log(
  `db query shape: ${sourceFiles(SRC).length} source file(s) checked, no FROM-less SELECT passed to queryAsync`,
);
