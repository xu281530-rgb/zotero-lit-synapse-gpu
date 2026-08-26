/* eslint-env node */

/**
 * Merging is the only operation in this plugin that destroys a record, so the
 * two things worth pinning are which copy survives and when the batch refuses
 * to run at all.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { planItemMerge, scoreMetadataCompleteness } = await import(
  "../src/modules/itemMergePlan.ts"
);

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

function record(itemKey, overrides = {}) {
  return {
    itemKey,
    found: true,
    title: `Paper ${itemKey}`,
    itemType: "journalArticle",
    isChildItem: false,
    inTrash: false,
    fields: {},
    creatorCount: 1,
    attachmentCount: 0,
    collections: [],
    dateAdded: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function filed(...paths) {
  return paths.map((path) => ({
    collectionKey: path,
    name: path,
    path,
  }));
}

test("the record with a DOI and an abstract wins", () => {
  const result = planItemMerge([
    {
      candidates: [
        record("THIN"),
        record("FULL", {
          fields: { DOI: "10.1/x", abstractNote: "...", publicationTitle: "Acta" },
        }),
      ],
    },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.groups[0].masterItemKey, "FULL");
  assert.match(result.groups[0].chosenBecause, /DOI/);
});

test("attachments cannot outweigh real metadata", () => {
  const result = planItemMerge([
    {
      candidates: [
        record("PDFS", { attachmentCount: 9 }),
        record("META", { fields: { DOI: "10.1/x", abstractNote: "..." } }),
      ],
    },
  ]);
  assert.equal(result.ok, true);
  assert.equal(
    result.groups[0].masterItemKey,
    "META",
    "a copy that accumulated duplicate PDFs must not beat the citable record",
  );
});

test("a tie falls to the most widely filed, then the earliest added", () => {
  const tieBreakByFiling = planItemMerge([
    {
      candidates: [
        record("A", { collections: filed("X") }),
        record("B", { collections: filed("X", "Y", "Z") }),
      ],
    },
  ]);
  assert.equal(tieBreakByFiling.groups[0].masterItemKey, "B");

  const tieBreakByAge = planItemMerge([
    {
      candidates: [
        record("NEW", { dateAdded: "2025-06-01T00:00:00Z" }),
        record("OLD", { dateAdded: "2020-01-01T00:00:00Z" }),
      ],
    },
  ]);
  assert.equal(tieBreakByAge.groups[0].masterItemKey, "OLD");
  assert.match(tieBreakByAge.groups[0].chosenBecause, /tied/);
});

test("the same batch always plans the same way", () => {
  const build = () => [
    { candidates: [record("A"), record("B"), record("C")] },
  ];
  const first = planItemMerge(build());
  const second = planItemMerge(build());
  assert.equal(first.groups[0].masterItemKey, second.groups[0].masterItemKey);
});

test("an explicit master overrides the scoring", () => {
  const result = planItemMerge([
    {
      masterItemKey: "THIN",
      candidates: [
        record("THIN"),
        record("FULL", { fields: { DOI: "10.1/x", abstractNote: "..." } }),
      ],
    },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.groups[0].masterItemKey, "THIN");
  assert.match(result.groups[0].chosenBecause, /caller/);
});

test("a master that is not in its own group rejects the batch", () => {
  const result = planItemMerge([
    { masterItemKey: "ELSEWHERE", candidates: [record("A"), record("B")] },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].itemKey, "ELSEWHERE");
});

test("the plan says what the survivor inherits", () => {
  const result = planItemMerge([
    {
      candidates: [
        record("MASTER", {
          fields: { DOI: "10.1/x" },
          collections: filed("综述"),
        }),
        record("DUP1", { attachmentCount: 1, collections: filed("大论文") }),
        record("DUP2", { attachmentCount: 2, collections: filed("综述", "AI") }),
      ],
    },
  ]);
  assert.equal(result.ok, true);
  const plan = result.groups[0];
  assert.equal(plan.masterItemKey, "MASTER");
  assert.equal(plan.attachmentsMoved, 3);
  assert.deepEqual(
    plan.collectionsGained,
    ["AI", "大论文"],
    "a collection the survivor already has is not a gain",
  );
  assert.equal(result.summary.itemsTrashed, 2);
});

test("mixed item types reject the batch, because Zotero cannot merge them", () => {
  const result = planItemMerge([
    {
      candidates: [
        record("A", { itemType: "journalArticle" }),
        record("B", { itemType: "preprint" }),
      ],
    },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.problems[0].reason, /same type/);
});

test("a missing, trashed or child record rejects the batch", () => {
  for (const [label, bad] of [
    ["missing", { itemKey: "GONE", found: false }],
    ["trashed", record("DEAD", { inTrash: true })],
    ["child", record("KID", { isChildItem: true })],
  ]) {
    const result = planItemMerge([
      { candidates: [record("A"), record("B"), bad] },
    ]);
    assert.equal(result.ok, false, `${label} must reject`);
    assert.equal(result.groups, undefined);
  }
});

test("a group of fewer than two distinct items is refused", () => {
  const lonely = planItemMerge([{ candidates: [record("A")] }]);
  assert.equal(lonely.ok, false);
  assert.match(lonely.problems[0].reason, /at least two/);

  const repeated = planItemMerge([{ candidates: [record("A"), record("A")] }]);
  assert.equal(
    repeated.ok,
    false,
    "the same key twice is one item, not a duplicate pair",
  );
});

test("one record cannot be merged into two different survivors", () => {
  const result = planItemMerge([
    { candidates: [record("A"), record("SHARED")] },
    { candidates: [record("B"), record("SHARED")] },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.problems[0].reason, /group 1/);
});

test("one bad group rejects the good ones with it, and says how many", () => {
  const result = planItemMerge([
    { candidates: [record("A"), record("B")] },
    { candidates: [record("C"), record("D")] },
    { candidates: [record("E"), { itemKey: "GONE", found: false }] },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.wouldHaveMerged, 2);
});

test("scoring counts an empty field as absent", () => {
  const blank = scoreMetadataCompleteness(
    record("A", { fields: { DOI: "   ", abstractNote: "" }, creatorCount: 0 }),
  );
  assert.equal(blank.total, 0);
  assert.deepEqual(blank.has, []);
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} passed`);
if (failures > 0) process.exit(1);
