/* eslint-env node */

/**
 * The shared-concept edges: pairing, rarity weighting, and the guard that
 * stops one ubiquitous term from drawing a complete graph.
 *
 * Pure arithmetic over the concept-source projection, so it runs without a
 * window, a database or a Zotero. The failures it pins down:
 *
 *   1. A concept behind two papers draws no edge, and the graph stays a set
 *      of islands even though the database records the connection.
 *   2. Every concept weighs the same, so three ubiquitous terms outrank one
 *      that only these two papers use.
 *   3. One term every paper mentions expands into K-n and the graph becomes
 *      unreadable at exactly the library size where it starts to matter.
 *   4. A shared-concept line is drawn on top of a shared-claim one, so a pair
 *      of papers ends up with two parallel edges.
 *   5. An edge is drawn with no label - "共享概念" alone tells the reader
 *      nothing they can act on.
 *   6. Σ idf is passed to the renderer raw, so a concept edge is drawn thicker
 *      than a shared claim.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  buildConceptEdges,
  conceptEdgeLabel,
  conceptEdgeStrength,
  conceptPairKey,
} = await import("../src/modules/wiki/wikiConceptEdges.ts");

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

/** A concept behind `itemKeys`, with the idf a library of N documents gives. */
function concept(conceptId, name, itemKeys, documentCount) {
  const df = itemKeys.length;
  return {
    conceptId,
    name,
    df,
    idf: Math.log((documentCount + 1) / (df + 1)),
    itemKeys,
  };
}

const ALL = (...keys) => new Set(keys);

block("two papers behind one concept make one edge", () => {
  const edges = buildConceptEdges([concept(1, "位错锁", ["A", "B"], 4)], {
    visibleDocuments: ALL("A", "B", "C", "D"),
    cliqueLimit: 40,
  });
  assert.equal(edges.length, 1);
  assert.deepEqual([edges[0].a, edges[0].b], ["A", "B"]);
  assert.equal(edges[0].concepts.length, 1);
});

block("a concept behind one paper connects nothing", () => {
  const edges = buildConceptEdges([concept(1, "CET", ["A"], 4)], {
    visibleDocuments: ALL("A", "B"),
    cliqueLimit: 40,
  });
  assert.deepEqual(edges, []);
});

block("a source outside the graph is not paired against", () => {
  // D was never written up, so it has no node. An edge to it would point at
  // nothing; the pair A-D must simply not exist.
  const edges = buildConceptEdges([concept(1, "再结晶", ["A", "D"], 4)], {
    visibleDocuments: ALL("A", "B", "C"),
    cliqueLimit: 40,
  });
  assert.deepEqual(edges, []);
});

block("one rare term outweighs three ubiquitous ones", () => {
  // A-B share one term two of five papers use. A-C share three terms that all
  // five use. The edge that says something has to come first.
  const documentCount = 5;
  const edges = buildConceptEdges(
    [
      concept(1, "Lomer-Cottrell 位错锁", ["A", "B"], documentCount),
      concept(2, "再结晶", ["A", "C", "D", "E", "B"], documentCount),
      concept(3, "晶粒", ["A", "C", "D", "E", "B"], documentCount),
      concept(4, "热变形", ["A", "C", "D", "E", "B"], documentCount),
    ],
    { visibleDocuments: ALL("A", "B", "C", "D", "E"), cliqueLimit: 40 },
  );
  const ab = edges.find((edge) => edge.a === "A" && edge.b === "B");
  const ac = edges.find((edge) => edge.a === "A" && edge.b === "C");
  assert.ok(
    ab.score > ac.score,
    `one rare term (${ab.score.toFixed(3)}) must outweigh three common ones (${ac.score.toFixed(3)})`,
  );
  assert.equal(
    edges[0],
    ab,
    "and the ranking the caller sees has to agree with that",
  );
  assert.equal(
    ab.concepts[0].name,
    "Lomer-Cottrell 位错锁",
    "rarest first inside the edge too, so the label names what discriminates",
  );
});

block("one ubiquitous term does not draw a complete graph", () => {
  // The acceptance criterion in its own words: 高频概念不会无差别生成 K₅ 完全图.
  const keys = ["A", "B", "C", "D", "E"];
  const everywhere = concept(1, "再结晶", keys, 5);
  const unguarded = buildConceptEdges([everywhere], {
    visibleDocuments: ALL(...keys),
    cliqueLimit: 40,
  });
  assert.equal(
    unguarded.length,
    10,
    "without a guard one term really does propose every pair — C(5,2)",
  );
  const guarded = buildConceptEdges([everywhere], {
    visibleDocuments: ALL(...keys),
    cliqueLimit: 4,
  });
  assert.deepEqual(
    guarded,
    [],
    "above the limit a concept contributes its df and nothing else",
  );
});

block("the guard is combinatorial, not a rarity judgement", () => {
  const keys = ["A", "B", "C", "D", "E"];
  const edges = buildConceptEdges(
    [
      concept(1, "再结晶", keys, 5),
      concept(2, "位错锁", ["A", "B"], 5),
    ],
    { visibleDocuments: ALL(...keys), cliqueLimit: 4 },
  );
  // The rare term still draws its edge; only the hub stopped pairing.
  assert.equal(edges.length, 1);
  assert.deepEqual(
    edges[0].concepts.map((c) => c.name),
    ["位错锁"],
  );
});

block("a pair that already has a stronger edge gets no second line", () => {
  const edges = buildConceptEdges(
    [concept(1, "位错锁", ["A", "B", "C"], 4)],
    {
      visibleDocuments: ALL("A", "B", "C"),
      excludedPairs: new Set([conceptPairKey("B", "A")]),
      cliqueLimit: 40,
    },
  );
  assert.equal(edges.length, 2, "A-C and B-C survive; A-B is already drawn");
  assert.ok(
    !edges.some((edge) => edge.a === "A" && edge.b === "B"),
    "one pair, one line",
  );
});

block("the pair key is undirected", () => {
  assert.equal(conceptPairKey("B", "A"), conceptPairKey("A", "B"));
  const edges = buildConceptEdges([concept(1, "位错锁", ["B", "A"], 4)], {
    visibleDocuments: ALL("A", "B"),
    cliqueLimit: 40,
  });
  assert.deepEqual(
    [edges[0].a, edges[0].b],
    ["A", "B"],
    "however the sources were ordered, the edge is normalised",
  );
});

block("a label names the rarest concepts and counts the rest", () => {
  const [edge] = buildConceptEdges(
    [
      concept(1, "位错锁", ["A", "B"], 9),
      concept(2, "孪晶", ["A", "B", "C"], 9),
      concept(3, "再结晶", ["A", "B", "C", "D"], 9),
      concept(4, "晶粒", ["A", "B", "C", "D", "E"], 9),
    ],
    { visibleDocuments: ALL("A", "B", "C", "D", "E"), cliqueLimit: 40 },
  );
  assert.equal(conceptEdgeLabel(edge, 3), "共享概念：位错锁、孪晶、再结晶 等 4 个");
  assert.equal(conceptEdgeLabel(edge, 4), "共享概念：位错锁、孪晶、再结晶、晶粒");
});

block("an edge with no nameable concept has no label", () => {
  const edge = { a: "A", b: "B", score: 1, concepts: [{ conceptId: 1, name: "", df: 2, idf: 1 }] };
  assert.equal(
    conceptEdgeLabel(edge, 3),
    "",
    "an unlabelled line is one the reader cannot act on; the caller drops it",
  );
});

block("Σ idf is mapped onto the width scale, not passed through", () => {
  // A shared claim arrives as a count: two claims is strength 2. The widest
  // concept edge has to stay under that.
  assert.equal(conceptEdgeStrength(0), 1);
  assert.equal(conceptEdgeStrength(-1), 1);
  assert.equal(conceptEdgeStrength(Number.NaN), 1);
  assert.ok(Math.abs(conceptEdgeStrength(0.5) - 1.5) < 1e-9);
  assert.equal(
    conceptEdgeStrength(40),
    3,
    "forty shared terms must not draw a line wider than three shared claims",
  );
});

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
