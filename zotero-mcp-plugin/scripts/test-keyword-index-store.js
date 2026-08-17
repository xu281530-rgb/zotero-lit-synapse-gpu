/* eslint-env node */
/**
 * Drives KeywordIndexStore against a REAL SQLite database.
 *
 * Not a mock: the schema uses WITHOUT ROWID, a partial unique index and an
 * arithmetic slot key, and a fake would let all three be wrong. Run with
 *   node --experimental-strip-types --experimental-sqlite scripts/test-keyword-index-store.js
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  CHUNK_STRIDE,
  KeywordIndexStore,
  chunkIdFromSlot,
  docIdFromSlot,
  slotFor,
} = await import("../src/modules/keyword/keywordIndexStore.ts");

globalThis.ztoolkit = { log: () => undefined };

/** Adapt node:sqlite to the two methods the store uses. */
function adapt(sqlite) {
  let depth = 0;
  return {
    async queryAsync(sql, params = []) {
      const statement = sqlite.prepare(sql);
      const normalised = params.map((value) =>
        typeof value === "boolean" ? (value ? 1 : 0) : value,
      );
      if (/^\s*(select|pragma)/iu.test(sql)) {
        return statement.all(...normalised);
      }
      statement.run(...normalised);
      return [];
    },
    async executeTransaction(fn) {
      // Nested transactions are what Zotero's own executeTransaction allows, so
      // the adapter must allow them too or the tests would pass on a shape
      // production never sees.
      if (depth > 0) return fn();
      depth += 1;
      sqlite.exec("BEGIN");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let tempDir;
/** Every database opened, so Windows can actually delete the directory. */
const opened = [];
function freshStore() {
  const file = path.join(
    tempDir,
    `kw-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  const sqlite = new DatabaseSync(file);
  opened.push(sqlite);
  return { store: new KeywordIndexStore(adapt(sqlite)), sqlite, file };
}

const LIBRARY = 1;

const PAPER_EN = {
  libraryID: LIBRARY,
  itemKey: "AAAA1111",
  title: "Hot deformation of FGH4096 superalloy with columnar grains",
  abstract:
    "The FGH4096 powder metallurgy superalloy was compressed at high temperature.",
  tags: ["superalloy", "hot deformation"],
  chunks: [
    "Hot deformation of FGH4096 superalloy with columnar grains",
    "The FGH4096 powder metallurgy superalloy was compressed.",
    "Dynamic recrystallisation of GH4169 was compared with Ti–6Al–4V behaviour.",
    "The γ′ precipitate coarsened during ageing at 800 °C.",
    "[1] R.C. Reed, The Superalloys, Cambridge (2006).\n[2] Y. Ning, Flow behaviour, Mater. Sci. Eng. A 531 (2012) 91.\n[3] W. Liu, Hot work, J. Alloys Compd. 938 (2023) 168.",
  ],
};

const PAPER_ZH = {
  libraryID: LIBRARY,
  itemKey: "BBBB2222",
  title: "定向凝固高温合金柱状晶组织演化",
  abstract: "研究了温度梯度对柱状晶阵列生长的影响。",
  tags: ["定向凝固"],
  chunks: [
    "定向凝固高温合金柱状晶组织演化",
    "研究了温度梯度对柱状晶阵列生长的影响。",
    "柱状组织与环状晶粒在此条件下并未相邻出现。",
  ],
};

// -------------------------------------------------------------------------

test("an item's fields and body chunks become postings", async () => {
  const { store } = freshStore();
  const result = await store.writeItem(PAPER_EN);
  assert.ok(result.docId > 0);
  assert.ok(result.postings > 0);
  assert.equal(result.lengths.title > 0, true);
  assert.equal(result.lengths.abstract > 0, true);
  assert.equal(result.lengths.tags > 0, true);
  assert.equal(result.lengths.body > 0, true);
});

test("the reference-list chunk is skipped, so its citations are unsearchable", async () => {
  const { store } = freshStore();
  const result = await store.writeItem(PAPER_EN);
  assert.equal(result.skippedChunks, 1, "the bibliography chunk");
  assert.equal(result.indexedChunks, 4);
  // "cambridge" only ever appears in the reference list.
  assert.deepEqual(await store.lookup(LIBRARY, "cambridge"), []);
  // A term from the real body is still there.
  assert.ok((await store.lookup(LIBRARY, "fgh4096")).length > 0);
});

test("a body-only term is retrievable, which metadata search cannot do", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER_EN);
  // GH4169 appears in no title, abstract or tag — only in a passage.
  const postings = await store.lookup(LIBRARY, "GH4169");
  assert.ok(postings.length > 0, "must be found");
  assert.ok(
    postings.every((posting) => posting.field === "body"),
    "and only in the body field",
  );
  assert.equal(postings[0].chunkId, 2, "traced back to the right passage");
});

test("a chunk hit carries the chunk number the other tools already use", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER_EN);
  const postings = await store.lookup(LIBRARY, "γ′");
  assert.ok(postings.length > 0, "prime-bearing phase name is indexed");
  assert.equal(postings[0].chunkId, 3);
});

test("an en-dashed grade in the text is found by the hyphen a user types", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER_EN);
  // The chunk contains Ti–6Al–4V (EN DASH); all three spellings must reach it.
  for (const spelling of ["Ti-6Al-4V", "Ti–6Al–4V", "ti6al4v"]) {
    assert.ok(
      (await store.lookup(LIBRARY, spelling)).length > 0,
      `not found: ${spelling}`,
    );
  }
});

test("field weights come from separate postings per field", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER_EN);
  const fields = new Set(
    (await store.lookup(LIBRARY, "fgh4096")).map((posting) => posting.field),
  );
  assert.ok(fields.has("title"));
  assert.ok(fields.has("abstract"));
  assert.ok(fields.has("body"));
  assert.ok(!fields.has("tags"), "the grade is not a tag on this item");
});

test("Chinese terms are retrievable through the bigram conjunction", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER_ZH);
  const { lookupKeyword } = await import(
    "../src/modules/keyword/keywordIndexStore.ts"
  );
  const found = await lookupKeyword(store, LIBRARY, "柱状晶");
  assert.equal(found.plan.requiresVerification, true);
  for (const term of found.plan.terms) {
    assert.ok(found.byTerm.get(term)?.length > 0, `missing postings: ${term}`);
  }
});

test("re-indexing replaces, and never leaves two live rows for one item", async () => {
  const { store } = freshStore();
  const first = await store.writeItem(PAPER_EN);
  const second = await store.writeItem({
    ...PAPER_EN,
    title: "Completely different title about titanium",
    abstract: "Nothing about superalloys any more.",
    chunks: ["Titanium alloys were studied instead."],
  });
  assert.notEqual(second.docId, first.docId, "a new revision gets a new id");

  const live = await store.liveDocuments(LIBRARY);
  assert.equal(live.size, 1, "exactly one live document");
  assert.equal(live.get(second.docId)?.itemKey, PAPER_EN.itemKey);

  // The old revision's postings are still on disk but unreachable, because a
  // query only follows live documents. Compaction is what reclaims them.
  const stale = await store.lookup(LIBRARY, "fgh4096");
  const liveHits = stale.filter((posting) => live.has(posting.docId));
  assert.equal(liveHits.length, 0, "no LIVE document mentions it any more");
});

test("compaction reclaims tombstoned postings and drops orphaned terms", async () => {
  const { store, sqlite } = freshStore();
  await store.writeItem(PAPER_EN);
  await store.writeItem({ ...PAPER_EN, chunks: ["Only this now."] });
  const before = sqlite
    .prepare("SELECT COUNT(*) AS n FROM kw_postings")
    .get().n;
  const result = await store.compact();
  const after = sqlite.prepare("SELECT COUNT(*) AS n FROM kw_postings").get().n;
  assert.equal(result.removedDocuments, 1);
  assert.ok(after < before, `${after} should be below ${before}`);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM kw_docs WHERE alive = 0").get().n,
    0,
  );
  // Every surviving term still has at least one posting.
  const orphans = sqlite
    .prepare(
      "SELECT COUNT(*) AS n FROM kw_terms WHERE term_id NOT IN (SELECT term_id FROM kw_postings)",
    )
    .get().n;
  assert.equal(orphans, 0);
  // And the index still answers.
  assert.ok((await store.lookup(LIBRARY, "only")).length > 0);
});

test("compaction cannot touch a live document's postings", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER_EN);
  await store.writeItem(PAPER_ZH);
  await store.removeItem(LIBRARY, PAPER_ZH.itemKey);
  await store.compact();
  assert.ok((await store.lookup(LIBRARY, "fgh4096")).length > 0, "EN kept");
  assert.deepEqual(await store.lookup(LIBRARY, "定向"), [], "ZH gone");
});

test("removing an item takes it out of the live set", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER_EN);
  assert.equal(await store.removeItem(LIBRARY, PAPER_EN.itemKey), true);
  assert.equal(await store.removeItem(LIBRARY, PAPER_EN.itemKey), false);
  assert.equal((await store.indexedItemKeys(LIBRARY)).size, 0);
});

test("libraries are isolated: one library's terms never resolve in another", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER_EN);
  await store.writeItem({ ...PAPER_ZH, libraryID: 5 });
  assert.ok((await store.lookup(1, "fgh4096")).length > 0);
  assert.deepEqual(
    await store.lookup(5, "fgh4096"),
    [],
    "not visible in lib 5",
  );
  assert.deepEqual(await store.lookup(1, "定向"), [], "not visible in lib 1");
  assert.deepEqual([...(await store.indexedItemKeys(5))], [PAPER_ZH.itemKey]);
});

test("clearing one library leaves the other intact", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER_EN);
  await store.writeItem({ ...PAPER_ZH, libraryID: 5 });
  await store.clear(1);
  assert.equal((await store.indexedItemKeys(1)).size, 0);
  assert.equal((await store.indexedItemKeys(5)).size, 1);
  assert.ok((await store.lookup(5, "定向")).length > 0);
});

test("statistics report per-field averages, which is what BM25F normalises by", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER_EN);
  await store.writeItem(PAPER_ZH);
  const stats = await store.statistics(LIBRARY);
  assert.equal(stats.documentCount, 2);
  for (const field of ["title", "abstract", "tags", "body"]) {
    assert.ok(
      stats.averageLengths[field] > 0,
      `${field} average should be positive`,
    );
  }
  assert.ok(
    stats.averageLengths.body > stats.averageLengths.title,
    "bodies are longer than titles",
  );
});

test("statistics on an empty index are zero, not NaN", async () => {
  const { store } = freshStore();
  const stats = await store.statistics(LIBRARY);
  assert.equal(stats.documentCount, 0);
  for (const value of Object.values(stats.averageLengths)) {
    assert.equal(value, 0);
    assert.ok(Number.isFinite(value));
  }
});

test("a term nothing contains short-circuits the conjunction", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER_EN);
  const { planQueryTerm } = await import(
    "../src/modules/keyword/scientificTokenizer.ts"
  );
  const plan = planQueryTerm("龘龘龘");
  const result = await store.lookupPlan(LIBRARY, plan);
  assert.equal(
    result.truncated,
    false,
    "an empty answer is not a truncated one",
  );
  assert.ok([...result.byTerm.values()].some((list) => list.length === 0));
});

test("the row budget truncates instead of reading the whole corpus", async () => {
  const { store } = freshStore();
  await store.writeItem(PAPER_EN);
  const { planQueryTerm } = await import(
    "../src/modules/keyword/scientificTokenizer.ts"
  );
  const plan = planQueryTerm("superalloy");
  const result = await store.lookupPlan(LIBRARY, plan, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.byTerm.size, 0);
});

test("slot packing round-trips and is monotone in the document id", async () => {
  for (const [docId, chunkId] of [
    [1, 0],
    [1, 195],
    [12345, 4095],
    [999999, CHUNK_STRIDE - 1],
  ]) {
    const slot = slotFor(docId, chunkId);
    assert.ok(Number.isSafeInteger(slot), `slot not exact for ${docId}`);
    assert.equal(docIdFromSlot(slot), docId);
    assert.equal(chunkIdFromSlot(slot), chunkId);
  }
  assert.ok(
    slotFor(2, 0) > slotFor(1, CHUNK_STRIDE - 1),
    "documents do not overlap",
  );
});

test("an item with no indexable content still records a document row", async () => {
  const { store } = freshStore();
  const result = await store.writeItem({
    libraryID: LIBRARY,
    itemKey: "EMPTY001",
    chunks: ["![](images/deadbeefdeadbeefdeadbeef.jpg)"],
  });
  assert.ok(result.docId > 0, "presence must be recorded");
  assert.equal(result.indexedChunks, 0);
  assert.equal(result.lengths.body, 0);
  // Recording it is what stops the build retrying the same unusable item forever.
  assert.equal((await store.indexedItemKeys(LIBRARY)).size, 1);
});

// -------------------------------------------------------------------------

tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kw-index-test-"));
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(
      `       ${String(error.message).split("\n").join("\n       ")}`,
    );
  }
}
for (const sqlite of opened) {
  try {
    sqlite.close();
  } catch {
    // Already closed; the only thing that matters is releasing the file lock.
  }
}
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch (error) {
  // A leftover temp file must never turn a passing suite into a failing one.
  console.warn(`  note: could not remove ${tempDir}: ${error.code ?? error}`);
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
