/* eslint-env node */

/**
 * What the knowledge graph's colour and size actually encode.
 *
 * Both were reported from a real library and both were saying something the
 * data did not support:
 *
 *   1. Every node the same colour. Colour was the index of the Page a document
 *      contributed most Claims to, and one of this system's own goals is to
 *      stop writers opening a Page per paper. Once that worked, the library
 *      held ONE Page, every node took group 0, and the channel went constant.
 *   2. Wildly different sizes for nearly equal documents. Size stretched the
 *      observed range across the whole radius scale, so on weights of 2, 3, 3
 *      and 2 a one-Claim difference became 4.2x the radius - about 18x the ink.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { assignDocumentGroups } = await import(
  "../src/modules/wiki/wikiGraphGroups.ts"
);

const results = [];
function block(name, fn) {
  try {
    fn();
    results.push([true, name]);
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message}`);
  }
}

// The measured library: four papers, four Claims, ONE Page.
const REAL = [
  { itemKey: "4V3CP6BB", claimIds: [334, 335] },
  { itemKey: "BRF2ZXMX", claimIds: [333, 334, 336] },
  { itemKey: "EMWXIG66", claimIds: [333, 334, 335] },
  { itemKey: "P7ARF6XI", claimIds: [333, 336] },
];

block("one Page no longer means one colour", () => {
  const groups = assignDocumentGroups(REAL);
  assert.equal(groups.size, 4);
  assert.ok(
    new Set(groups.values()).size > 1,
    "the whole point: a single-Page Wiki still separates its documents",
  );
});

block("colour groups the papers that carry the same distinctive Claim", () => {
  // Claim reach: 333 -> 3 papers, 334 -> 3, 335 -> 2, 336 -> 2. The rarest
  // Claim each paper supports is what makes it distinctive, so the two papers
  // carrying 335 share a colour and the two carrying 336 share another.
  const groups = assignDocumentGroups(REAL);
  assert.equal(
    groups.get("4V3CP6BB"),
    groups.get("EMWXIG66"),
    "both carry Claim 335, the low-stacking-fault-energy one",
  );
  assert.equal(
    groups.get("BRF2ZXMX"),
    groups.get("P7ARF6XI"),
    "both carry Claim 336, the orientation-anisotropy one",
  );
  assert.notEqual(
    groups.get("4V3CP6BB"),
    groups.get("BRF2ZXMX"),
    "and the two pairs are told apart",
  );
});

block("the most SUPPORTED claim would not have separated them", () => {
  // Why "rarest" rather than "commonest": the Claim the most papers support is
  // by construction the one that discriminates between them least. Picking it
  // would put three of these four in one colour and undo the fix.
  const byCommonest = new Map();
  const reach = new Map();
  for (const document of REAL) {
    for (const claimId of document.claimIds) {
      reach.set(claimId, (reach.get(claimId) ?? 0) + 1);
    }
  }
  for (const document of REAL) {
    let best = null;
    for (const claimId of document.claimIds) {
      if (best === null || reach.get(claimId) > reach.get(best)) best = claimId;
    }
    byCommonest.set(document.itemKey, best);
  }
  assert.equal(
    new Set(byCommonest.values()).size,
    2,
    "commonest-claim colouring collapses these four papers into two",
  );
  assert.equal(
    new Set(assignDocumentGroups(REAL).values()).size,
    2,
    "rarest-claim colouring also gives two, but they are the MEANINGFUL two",
  );
  // The difference is which papers land together.
  assert.notEqual(
    byCommonest.get("4V3CP6BB"),
    byCommonest.get("EMWXIG66"),
    "commonest-claim splits the two micro-twin papers apart",
  );
});

block("the grouping is stable and does not depend on database ids", () => {
  const groups = assignDocumentGroups(REAL);
  // Same shape, ids shifted by a thousand: a library restored from a backup
  // must not repaint itself.
  const shifted = REAL.map((document) => ({
    itemKey: document.itemKey,
    claimIds: document.claimIds.map((id) => id + 1000),
  }));
  assert.deepEqual(
    Array.from(assignDocumentGroups(shifted)),
    Array.from(groups),
    "group is the claim's POSITION, never its id",
  );
  // And it is deterministic across repeated calls.
  assert.deepEqual(
    Array.from(assignDocumentGroups(REAL)),
    Array.from(groups),
  );
});

block("a document with no Claims is group 0", () => {
  const groups = assignDocumentGroups([
    ...REAL,
    { itemKey: "GHOSTDOC", claimIds: [] },
  ]);
  assert.equal(
    groups.get("GHOSTDOC"),
    0,
    "a ghost is drawn as an outline; its colour carries nothing",
  );
});

block("an empty library groups nothing rather than throwing", () => {
  assert.equal(assignDocumentGroups([]).size, 0);
});

// --- Size ------------------------------------------------------------------
//
// The renderer's own arithmetic, restated: area proportional to the Claim
// count, anchored at one Claim rather than at the smallest node present.

function radius(weight, maxWeight, rMin = 5, rMax = 21) {
  const low = 1;
  const high = Math.sqrt(Math.max(1, maxWeight));
  if (high - low < 1e-9) return rMin + (rMax - rMin) * 0.5;
  const normalized = Math.min(
    1,
    Math.max(0, (Math.sqrt(Math.max(1, weight)) - low) / (high - low)),
  );
  return rMin + (rMax - rMin) * normalized;
}

block("a one-Claim difference is no longer a fourfold difference", () => {
  // The reported case: weights 2, 3, 3, 2.
  const small = radius(2, 3);
  const large = radius(3, 3);
  const oldSmall = 5; // min-max stretch put the smallest at the floor
  const oldLarge = 21; // and the largest at the ceiling, whatever the numbers
  assert.equal(oldLarge / oldSmall, 4.2, "what it used to do");
  assert.ok(
    large / small < 1.6,
    `2 vs 3 Claims should be a modest difference, got ${(large / small).toFixed(2)}x`,
  );
  assert.ok(small > 12, "and the smaller node is not reduced to a dot");
});

block("area, not radius, carries the count", () => {
  // Four Claims against one is four times the ink, not four times the width.
  const one = radius(1, 4);
  const four = radius(4, 4);
  assert.equal(one, 5, "one Claim sits at the floor of the scale");
  assert.equal(four, 21, "the most-cited document sits at the ceiling");
  const two = radius(2, 4);
  // sqrt spacing: 2 sits closer to 4 than a linear scale would place it.
  const linear = 5 + 16 * ((2 - 1) / (4 - 1));
  assert.ok(
    two > linear,
    `sqrt scaling should place 2 above the linear ${linear.toFixed(1)}, got ${two.toFixed(1)}`,
  );
});

block("equal counts draw equal nodes, and never a field of dots", () => {
  // Every document citing the same number of Claims is a real answer, and the
  // picture should say "these are alike" rather than "these are all tiny" -
  // which is what the old min-max stretch did, pinning every node to the floor.
  //
  // The scale runs from one Claim to the most any document has, so a graph
  // where everything cites three sits at the ceiling. A graph where everything
  // cites one has no scale at all, and takes the middle.
  assert.equal(radius(3, 3), 21, "all equal at the top of the scale");
  assert.equal(radius(2, 2), 21);
  assert.equal(radius(1, 1), 13, "no range to speak of: the middle");
  assert.notEqual(radius(3, 3), 5, "never the floor - that was the bug");
});

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
