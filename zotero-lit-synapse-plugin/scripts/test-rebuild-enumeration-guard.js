/* eslint-env node */

/**
 * A full-library rebuild must never mistake a failed query for an empty library.
 *
 * The regression this pins down: `getItemsWithContent` caught every error and
 * returned `[]`. buildIndex then recorded an EMPTY target snapshot, called
 * `clearLibraryForBuild` — which deletes every vector for the library — found
 * nothing to index, and reported `completed`, because 0 succeeded of 0 total.
 * One transient `Zotero.Search.search()` failure therefore destroyed the whole
 * semantic index and said the rebuild had gone fine.
 *
 * So: enumeration either answers, or it fails the run before anything is
 * cleared.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const { enumerateLibraryItems, isItemEnumerationError, ItemEnumerationError } =
  await import("../src/modules/semantic/libraryEnumeration.ts");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceSource = fs.readFileSync(
  path.join(root, "src/modules/semantic/semanticSearchService.ts"),
  "utf8",
);

/** Install a Zotero test double whose search/getAsync behaviour is scripted. */
function withZotero({ search, getAsync }) {
  globalThis.Zotero = {
    Libraries: { userLibraryID: 1 },
    Search: class {
      constructor() {
        this.conditions = [];
      }
      addCondition(...args) {
        this.conditions.push(args);
      }
      search() {
        return search();
      }
    },
    Items: { getAsync },
  };
}

// ---- a rejected search is an error, never an empty library ----

{
  withZotero({
    search: async () => {
      throw new Error("database is locked");
    },
    getAsync: async () => [],
  });
  await assert.rejects(
    () => enumerateLibraryItems(1),
    (error) => {
      assert.ok(
        isItemEnumerationError(error),
        "a failed enumeration must be typed, so buildIndex can tell it apart",
      );
      assert.equal(error.libraryID, 1);
      assert.match(error.message, /database is locked/);
      assert.match(
        error.message,
        /left untouched/i,
        "the message must state that nothing was destroyed",
      );
      return true;
    },
  );
}

// ---- a non-array result is not an answer either ----

for (const bogus of [null, undefined, "12,13"]) {
  withZotero({ search: async () => bogus, getAsync: async () => [] });
  await assert.rejects(
    () => enumerateLibraryItems(1),
    isItemEnumerationError,
    `search() resolving to ${String(bogus)} must not be read as an empty library`,
  );
}

{
  withZotero({ search: async () => [7], getAsync: async () => undefined });
  await assert.rejects(
    () => enumerateLibraryItems(1),
    isItemEnumerationError,
    "getAsync returning nothing must not be read as an empty library",
  );
}

// ---- a genuinely empty library still enumerates successfully ----

{
  withZotero({ search: async () => [], getAsync: async () => [] });
  const items = await enumerateLibraryItems(1);
  assert.deepEqual(
    items,
    [],
    "an empty library is a legitimate answer and must not throw",
  );
}

{
  const expected = [{ key: "AAA" }, { key: "BBB" }];
  withZotero({ search: async () => [1, 2], getAsync: async () => expected });
  assert.deepEqual(await enumerateLibraryItems(1), expected);
}

// ---- the failure mode itself: nothing is cleared when enumeration fails ----

{
  // A miniature of buildIndex's destructive sequence. Under the old
  // swallow-to-[] behaviour every one of these steps ran against an empty
  // target list; under the fix none of them is reached.
  const performed = [];
  const rebuild = async (enumerate) => {
    let items;
    try {
      items = await enumerate();
    } catch (error) {
      if (!isItemEnumerationError(error)) throw error;
      return { status: "error", error: error.message };
    }
    performed.push(`createBuildSession(${items.length} targets)`);
    performed.push("clearLibraryForBuild");
    return {
      status: items.length === 0 ? "completed" : "indexing",
      total: items.length,
    };
  };

  withZotero({
    search: async () => {
      throw new Error("transient failure");
    },
    getAsync: async () => [],
  });
  const result = await rebuild(() => enumerateLibraryItems(1));

  assert.equal(
    result.status,
    "error",
    "a rebuild whose enumeration failed must report an error",
  );
  assert.deepEqual(
    performed,
    [],
    "NOTHING may run after a failed enumeration — least of all clearLibraryForBuild",
  );

  // And the shape of the old bug, so the assertion above cannot pass vacuously.
  const swallowing = async () => [];
  const oldResult = await rebuild(swallowing);
  assert.equal(
    oldResult.status,
    "completed",
    "sanity: swallowing the error is exactly what produced a bogus 'completed'",
  );
  assert.deepEqual(performed, [
    "createBuildSession(0 targets)",
    "clearLibraryForBuild",
  ]);
}

// ---- buildIndex orders the guard ahead of every destructive step ----

{
  const buildIndexStart = serviceSource.indexOf("async buildIndex(options: {");
  assert.ok(buildIndexStart > 0, "buildIndex must exist");
  const body = serviceSource.slice(buildIndexStart);

  const guardAt = body.indexOf("if (!isItemEnumerationError(error)) throw error;");
  const createSessionAt = body.indexOf("createNewBuildSession");
  const clearAt = body.indexOf("clearLibraryForBuild(");

  assert.ok(guardAt > 0, "buildIndex must handle a failed enumeration");
  assert.ok(createSessionAt > 0 && clearAt > 0);
  assert.ok(
    guardAt < createSessionAt && guardAt < clearAt,
    "the enumeration guard must come BEFORE the build session and the clear",
  );
  assert.match(
    body.slice(guardAt, guardAt + 900),
    /errorRetryable = true/,
    "nothing was destroyed, so the run is retryable",
  );
  assert.match(
    body.slice(guardAt, guardAt + 900),
    /return this\.indexProgress;/,
    "the guard must RETURN, not fall through into the rebuild",
  );
}

// getItemsWithContent must not have grown a catch that swallows again.
{
  const start = serviceSource.indexOf("private async getItemsWithContent(");
  assert.ok(start > 0);
  const body = serviceSource.slice(start, start + 600);
  assert.ok(
    !/return \[\];/.test(body),
    "getItemsWithContent must never return [] on failure",
  );
  assert.match(body, /enumerateLibraryItems\(libraryID\)/);
}

assert.ok(new ItemEnumerationError(3, new Error("x")) instanceof Error);

console.log("rebuild enumeration guard: all assertions passed");
