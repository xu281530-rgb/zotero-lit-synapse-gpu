/* eslint-env node */

/**
 * Which reading note a record lands in.
 *
 * This is the whole decision behind multi-episode notes, and until it was
 * split out of `WikiService.routeReadingRecord` it had no tests at all - the
 * logic was wrapped around attachment listing, note parsing and an embedding
 * call, so nothing could reach it. The existing note tests cover naming,
 * episode-number parsing and "a concluded note stays closed"; none of them
 * touched the four branches, the unreadable-note fallback, or the rule that
 * similarity is measured against the CLOSEST note rather than the average.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { routeWithoutSimilarity, routeBySimilarity, routeFallback } =
  await import("../src/modules/wiki/wikiNoteRouting.ts");

const note = (name, { concluded = false, chunkIds = [], related = "" } = {}) => ({
  attachment: name,
  concluded,
  chunkIds: new Set(chunkIds),
  related,
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("the first record of a paper writes the paper's first note", () => {
  const route = routeWithoutSimilarity([], [1, 2]);
  assert.equal(route.write, true);
  assert.equal(route.startNewEpisode, false, "the first note is not an episode 2");
  assert.equal(route.attachment, null, "null means the session's own note");
});

test("an unreadable note never opens a new episode", () => {
  // The failure this guards is silent and total: a new episode written from an
  // empty body replaces the records already in that file with a single one, so
  // the append-only guarantee would be broken by the code meant to keep it.
  // Falling back to the ordinary append path lets the consistency check refuse
  // the write loudly instead.
  const route = routeWithoutSimilarity(
    [note("n1", { concluded: true, related: "prior account" })],
    [1],
    { unreadable: true },
  );
  assert.equal(route.startNewEpisode, false);
  assert.equal(route.write, true);
  assert.equal(route.attachment, null);
  assert.match(route.reason, /could not be read/);
});

test("an open note takes the record, whether or not it has seen the chunks", () => {
  // Not seen: the earliest open note that is missing any of them.
  const unseen = routeWithoutSimilarity(
    [note("n1", { chunkIds: [1] }), note("n2", { chunkIds: [1, 2, 3] })],
    [1, 2],
  );
  assert.equal(unseen.attachment, "n1");
  assert.equal(unseen.startNewEpisode, false);

  // Already seen: re-reading a passage and saying something further about it is
  // ordinary, and an unfinished note has nothing to protect. Leaving this case
  // out sent every re-read down the similarity branch and opened a note for it.
  const seen = routeWithoutSimilarity([note("n1", { chunkIds: [1, 2] })], [1, 2]);
  assert.equal(seen.attachment, "n1");
  assert.equal(seen.startNewEpisode, false);
  assert.equal(seen.similarity, null, "an open note costs no embedding");
});

test("an open note wins even when a concluded one is listed first", () => {
  const route = routeWithoutSimilarity(
    [
      note("done", { concluded: true, chunkIds: [1, 2], related: "prior" }),
      note("open", { chunkIds: [1, 2] }),
    ],
    [1, 2],
  );
  assert.equal(route.attachment, "open");
  assert.equal(route.write, true);
});

test("all notes concluded and none discusses these chunks: a new episode", () => {
  const route = routeWithoutSimilarity(
    [note("n1", { concluded: true, chunkIds: [40, 41] })],
    [1, 2],
  );
  assert.equal(route.startNewEpisode, true);
  assert.equal(route.write, true);
  assert.match(route.reason, /no note discusses/);
});

test("only the last case pays for an embedding", () => {
  // Everything settled without similarity returns a route; `null` is the one
  // answer that means "go and embed". Paying for it anywhere else would put a
  // network call on the ordinary append path.
  const needsEmbedding = routeWithoutSimilarity(
    [note("n1", { concluded: true, chunkIds: [1], related: "an account of chunk 1" })],
    [1],
  );
  assert.equal(needsEmbedding, null);
});

test("similarity decides only between restating and adding", () => {
  const threshold = 0.92;

  const restates = routeBySimilarity(0.97, threshold);
  assert.equal(restates.write, false, "a restatement is not written");
  assert.equal(restates.startNewEpisode, false);
  assert.equal(restates.similarity, 0.97);
  assert.match(restates.reason, /restates/);

  const adds = routeBySimilarity(0.4, threshold);
  assert.equal(adds.write, true);
  assert.equal(adds.startNewEpisode, true);
  assert.match(adds.reason, /differs from every note/);

  // Exactly at the threshold counts as a restatement, so the pref reads as
  // "this similar or more is the same reading".
  assert.equal(routeBySimilarity(threshold, threshold).write, false);
});

test("an unusable embedding writes rather than discards", () => {
  // The two failure directions are not equal. Writing an extra note costs a
  // duplicate; discarding on a comparison that never happened loses the text
  // permanently, while the ledger still books the chunks as read.
  for (const route of [routeBySimilarity(null, 0.92), routeFallback("comparison failed")]) {
    assert.equal(route.write, true);
    assert.equal(route.startNewEpisode, true);
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
