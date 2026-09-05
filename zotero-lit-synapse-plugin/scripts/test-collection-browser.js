/* eslint-env node */

/**
 * Regression tests for `get_collection_items` (src/modules/collectionBrowser.ts).
 *
 * The contract under test is "one level at a time, cheaply":
 *
 *  - Only the CURRENT level's subfolders and directly-filed documents come
 *    back — never the whole tree, which is what get_collections(recursive)
 *    used to do and what made browsing a large library impossible. That
 *    parameter has since been removed outright rather than left as a
 *    second way to do the same thing.
 *  - Each subfolder carries enough counts to choose where to descend without
 *    opening it, and totalItemCount de-duplicates, because a document filed in
 *    both a parent and its child is one document.
 *  - Document rows are identity only. A directory listing that carries
 *    abstracts and note bodies, as this did, cannot be walked.
 *  - A path that does not identify exactly one folder is an error with the
 *    candidate keys attached, never a guess.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  DEFAULT_BROWSE_PAGE_SIZE,
  MAX_BROWSE_PAGE_SIZE,
  CollectionBrowserError,
  browseCollection,
  buildPath,
  resolveBrowsePageSize,
  resolvePath,
} = await import("../src/modules/collectionBrowser.ts");

const LIBRARY = 1;

/**
 * A small library:
 *
 *   My Library
 *   ├── Materials            (2 direct: M1, M2)
 *   │   ├── Solidification   (2 direct: S1, M1 — M1 is ALSO in Materials)
 *   │   │   └── CET          (1 direct: C1)
 *   │   └── Coatings         (0 direct)
 *   └── Methods              (1 direct: X1)
 *   unfiled: U1
 */
function makeDeps(overrides = {}) {
  const nodes = {
    MAT: {
      key: "MAT",
      name: "Materials",
      parentKey: null,
      childCollectionKeys: ["SOL", "COA"],
      itemKeys: ["M1", "M2"],
    },
    SOL: {
      key: "SOL",
      name: "Solidification",
      parentKey: "MAT",
      childCollectionKeys: ["CET"],
      // M1 is filed in both MAT and SOL: one document, two filing entries.
      itemKeys: ["S1", "M1"],
    },
    CET: {
      key: "CET",
      name: "CET",
      parentKey: "SOL",
      childCollectionKeys: [],
      itemKeys: ["C1"],
    },
    COA: {
      key: "COA",
      name: "Coatings",
      parentKey: "MAT",
      childCollectionKeys: [],
      itemKeys: [],
    },
    MET: {
      key: "MET",
      name: "Methods",
      parentKey: null,
      childCollectionKeys: [],
      itemKeys: ["X1"],
    },
    ...(overrides.extraNodes ?? {}),
  };

  return {
    getCollection: (key) => nodes[key] ?? null,
    getTopLevelCollectionKeys: () => overrides.topLevel ?? ["MAT", "MET"],
    getUnfiledItemKeys: () => overrides.unfiled ?? ["U1"],
    describeItems: async (keys) =>
      keys.map((key) => ({
        itemKey: key,
        title: `Title of ${key}`,
        creators: "A. Author",
        year: "2021",
        itemType: "journalArticle",
      })),
    getLibraryName: () => "My Library",
  };
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("page size is clamped", () => {
  assert.equal(resolveBrowsePageSize(undefined), DEFAULT_BROWSE_PAGE_SIZE);
  assert.equal(resolveBrowsePageSize(0), DEFAULT_BROWSE_PAGE_SIZE);
  assert.equal(resolveBrowsePageSize(10), 10);
  assert.equal(resolveBrowsePageSize(100000), MAX_BROWSE_PAGE_SIZE);
});

test("an async unfiled-items accessor is awaited, not discarded", async () => {
  // Zotero resolves unfiled items with `Zotero.Search.search()`, which is
  // async. The adapter used to read it synchronously; `Array.isArray` then
  // rejected the Promise without complaint and the root reported an empty
  // library for every user who had unfiled items.
  const deps = makeDeps({});
  deps.getUnfiledItemKeys = async () => ["U1", "U2"];
  const result = await browseCollection({}, deps, 1);
  assert.equal(
    result.itemPagination.total,
    2,
    "a promised list of unfiled items must be awaited, not treated as empty",
  );
  assert.deepEqual(
    result.items.map((row) => row.itemKey),
    ["U1", "U2"],
  );
});

test("no collectionKey lists the library root", async () => {
  const deps = makeDeps();
  const result = await browseCollection({}, deps, LIBRARY);

  assert.equal(result.location.level, "library");
  assert.equal(result.location.collectionKey, null);
  assert.equal(result.location.path, "My Library");
  assert.deepEqual(
    result.subcollections.map((c) => c.collectionKey),
    ["MAT", "MET"],
  );
  // At the root, "filed directly here" means filed in no collection at all.
  // Listing every item in the library would make the root the one level that
  // cannot be browsed.
  assert.deepEqual(
    result.items.map((i) => i.itemKey),
    ["U1"],
  );
});

test("descending shows only that level", async () => {
  const deps = makeDeps();
  const result = await browseCollection(
    { collectionKey: "MAT" },
    deps,
    LIBRARY,
  );

  assert.equal(result.location.collectionKey, "MAT");
  assert.equal(result.location.path, "My Library/Materials");
  assert.equal(result.parent.collectionKey, null);

  // Its children, not its grandchildren: CET is under SOL and must not appear.
  assert.deepEqual(result.subcollections.map((c) => c.collectionKey).sort(), [
    "COA",
    "SOL",
  ]);
  // Its own items, not its descendants': S1, C1 and M1-via-SOL stay below.
  assert.deepEqual(result.items.map((i) => i.itemKey).sort(), ["M1", "M2"]);
  assert.equal(result.metadata.itemsAreDirectChildrenOnly, true);
});

test("counts let you choose where to descend without opening anything", async () => {
  const deps = makeDeps();
  const result = await browseCollection(
    { collectionKey: "MAT" },
    deps,
    LIBRARY,
  );
  const byKey = Object.fromEntries(
    result.subcollections.map((c) => [c.collectionKey, c]),
  );

  // Solidification: S1 + M1 directly, plus C1 below.
  assert.equal(byKey.SOL.directItemCount, 2);
  assert.equal(byKey.SOL.totalItemCount, 3);
  assert.equal(byKey.SOL.hasChildren, true);

  // Coatings is genuinely empty, and says so in both numbers — that is what
  // distinguishes it from a container whose documents live further down.
  assert.equal(byKey.COA.directItemCount, 0);
  assert.equal(byKey.COA.totalItemCount, 0);
  assert.equal(byKey.COA.hasChildren, false);
});

test("totalItemCount counts documents, not filing entries", async () => {
  const deps = makeDeps();
  const root = await browseCollection({}, deps, LIBRARY);
  const materials = root.subcollections.find((c) => c.collectionKey === "MAT");

  // M1, M2 (in MAT) + S1, M1 (in SOL) + C1 (in CET) = 4 distinct documents.
  // Summing children's totals would say 5 and would be wrong: M1 is one paper
  // filed twice, and a caller sizing up a folder needs "papers you would find
  // under here", not "filing entries".
  assert.equal(materials.directItemCount, 2);
  assert.equal(materials.totalItemCount, 4);
});

test("document rows carry identity and nothing else", async () => {
  const deps = makeDeps();
  const result = await browseCollection(
    { collectionKey: "MET" },
    deps,
    LIBRARY,
  );
  const row = result.items[0];
  const allowed = new Set([
    "itemKey",
    "title",
    "creators",
    "year",
    "itemType",
    "publicationTitle",
    "DOI",
  ]);
  for (const key of Object.keys(row)) {
    assert.ok(allowed.has(key), `browse row leaked the field "${key}"`);
  }
  for (const forbidden of ["abstractNote", "notes", "attachments", "path"]) {
    assert.ok(!(forbidden in row), `browse row must not carry ${forbidden}`);
  }
});

test("a level with many documents pages", async () => {
  const many = Array.from({ length: 130 }, (_, i) => `I${i}`);
  const deps = makeDeps({
    extraNodes: {
      BIG: {
        key: "BIG",
        name: "Big",
        parentKey: null,
        childCollectionKeys: [],
        itemKeys: many,
      },
    },
    topLevel: ["BIG"],
  });

  const first = await browseCollection({ collectionKey: "BIG" }, deps, LIBRARY);
  assert.equal(first.itemPagination.total, 130);
  assert.equal(first.itemPagination.returned, DEFAULT_BROWSE_PAGE_SIZE);
  assert.equal(first.itemPagination.hasMore, true);
  assert.equal(first.itemPagination.nextOffset, DEFAULT_BROWSE_PAGE_SIZE);

  const seen = [...first.items.map((i) => i.itemKey)];
  let offset = first.itemPagination.nextOffset;
  for (;;) {
    const page = await browseCollection(
      { collectionKey: "BIG", offset },
      deps,
      LIBRARY,
    );
    seen.push(...page.items.map((i) => i.itemKey));
    if (!page.itemPagination.hasMore) break;
    offset = page.itemPagination.nextOffset;
  }
  assert.deepEqual(seen, many, "paging must cover the level exactly once");
});

test("a path resolves to a collectionKey", async () => {
  const deps = makeDeps();
  assert.equal(resolvePath("Materials/Solidification/CET", deps), "CET");
  // The library name is optional, because this tool prints paths WITH it.
  assert.equal(resolvePath("My Library/Materials/Coatings", deps), "COA");
  assert.equal(
    resolvePath("materials", deps),
    "MAT",
    "matching is case-insensitive",
  );

  const result = await browseCollection(
    { path: "Materials/Solidification" },
    deps,
    LIBRARY,
  );
  // The response answers in keys, whatever the input was.
  assert.equal(result.location.collectionKey, "SOL");
  assert.equal(result.location.path, "My Library/Materials/Solidification");
});

test("an unknown path segment fails without guessing", () => {
  const deps = makeDeps();
  assert.throws(
    () => resolvePath("Materials/Nonexistent", deps),
    (error) => {
      assert.ok(error instanceof CollectionBrowserError);
      assert.match(error.message, /No collection named "Nonexistent"/);
      return true;
    },
  );
});

test("an ambiguous path fails and hands back the candidate keys", () => {
  // Two sibling folders may legitimately share a name. Picking one silently
  // would list the wrong folder's contents while looking entirely successful.
  const deps = makeDeps({
    extraNodes: {
      DUP1: {
        key: "DUP1",
        name: "Notes",
        parentKey: null,
        childCollectionKeys: [],
        itemKeys: [],
      },
      DUP2: {
        key: "DUP2",
        name: "Notes",
        parentKey: null,
        childCollectionKeys: [],
        itemKeys: [],
      },
    },
    topLevel: ["DUP1", "DUP2"],
  });

  assert.throws(
    () => resolvePath("Notes", deps),
    (error) => {
      assert.ok(error instanceof CollectionBrowserError);
      assert.match(error.message, /matches 2 sibling collections/);
      assert.deepEqual(error.candidates.map((c) => c.collectionKey).sort(), [
        "DUP1",
        "DUP2",
      ]);
      return true;
    },
  );
});

test("collectionKey wins over path when both are given", async () => {
  const deps = makeDeps();
  const result = await browseCollection(
    { collectionKey: "MET", path: "Materials" },
    deps,
    LIBRARY,
  );
  assert.equal(result.location.collectionKey, "MET");
});

test("an unknown collectionKey fails with somewhere to go next", async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => browseCollection({ collectionKey: "GHOST" }, deps, LIBRARY),
    (error) => {
      assert.ok(error instanceof CollectionBrowserError);
      assert.match(error.message, /does not exist/);
      assert.match(error.message, /get_collection_items|get_collections/);
      return true;
    },
  );
});

test("buildPath walks to the library root", () => {
  const deps = makeDeps();
  assert.equal(
    buildPath("CET", deps).path,
    "My Library/Materials/Solidification/CET",
  );
  assert.deepEqual(buildPath("CET", deps).segments, [
    "Materials",
    "Solidification",
    "CET",
  ]);
});

test("a cycle in the tree terminates instead of hanging", () => {
  // Zotero should never produce one, but a corrupt database can, and a
  // browser that hangs on it is worse than one that returns a short path.
  const deps = makeDeps({
    extraNodes: {
      A: {
        key: "A",
        name: "A",
        parentKey: "B",
        childCollectionKeys: ["B"],
        itemKeys: [],
      },
      B: {
        key: "B",
        name: "B",
        parentKey: "A",
        childCollectionKeys: ["A"],
        itemKeys: [],
      },
    },
    topLevel: ["A"],
  });
  const path = buildPath("A", deps);
  assert.ok(path.path.startsWith("My Library"));
  assert.ok(path.segments.length <= 3);
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
