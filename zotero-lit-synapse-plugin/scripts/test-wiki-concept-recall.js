/* eslint-env node */

/**
 * Concept vectors, and the paper-shaped recall built on them.
 *
 * Each block is named for the failure it exists to prevent:
 *
 *   1. The text a concept embeds as depends on the order rows came back in,
 *      so its hash flips and every resync re-embeds the whole library.
 *   2. A concept is created and nothing ever gives it a vector.
 *   3. A concept that existed before this table did never gets one.
 *   4. A concept is renamed or rewritten and keeps the vector of its old
 *      text - recall keeps working and is quietly wrong.
 *   5. A concept whose embedding backend is failing has its backoff reset
 *      every resync, so it never reaches "exhausted" and is never reported.
 *   6. Duplicate detection misses a near-synonym under another name - the
 *      failure that made lexical matching insufficient in the first place.
 *   7. The neighbourhood returns the paper's own concepts as its neighbours,
 *      or hubs that are already in it, so the budget is spent on nothing.
 *   8. Relations are returned for concepts the response never mentioned.
 *   9. The skeleton enumerates every concept in the library again, which is
 *      the cost this whole design exists to remove.
 *  10. "Unchanged" is returned when the Wiki has in fact changed.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-recall-"));
const fake = createZoteroFake({ rootDir: tempDir });
fake.install();

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { getEmbeddingService } = await import(
  "../src/modules/semantic/embeddingService.ts"
);
const { conceptEmbeddingText } = await import(
  "../src/modules/wiki/wikiConceptEmbedding.ts"
);
const { hashWikiText } = await import(
  "../src/modules/wiki/wikiCanonicalizer.ts"
);
const { getVectorStore } = await import(
  "../src/modules/semantic/vectorStore.ts"
);

function adapt(sqlite) {
  let depth = 0;
  const normalize = (params) =>
    params.map((value) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
  return {
    async queryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const statement = sqlite.prepare(sql);
      const values = normalize(params);
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) {
        return statement.all(...values);
      }
      statement.run(...values);
      return [];
    },
    async valueQueryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const row = sqlite.prepare(sql).get(...normalize(params));
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(fn) {
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

/*
 * A character-overlap embedding.
 *
 * Not a toy stand-in for "some vector": these tests assert that a near-synonym
 * is FOUND, and that only holds if the fake has the property the real model
 * has - that texts sharing most of their content land near each other. Bag of
 * characters over a fixed vocabulary gives exactly that, deterministically,
 * with `界面换热系数` and `界面传热系数` differing in one dimension of six.
 * Characters outside the vocabulary land in a small hashed tail so that two
 * unrelated terms do not collapse onto the same point.
 */
const VOCAB = Array.from("界面换热传导系数晶粒细化压力铸造挤理论溶质扩散强度");
const TAIL = 8;
function fakeVector(text) {
  const vector = new Float32Array(VOCAB.length + TAIL);
  for (const character of String(text)) {
    const index = VOCAB.indexOf(character);
    if (index >= 0) vector[index] += 1;
    else vector[VOCAB.length + (character.codePointAt(0) % TAIL)] += 0.25;
  }
  let sum = 0;
  for (const value of vector) sum += value;
  if (!sum) vector[0] = 0.001;
  return vector;
}

let embedMode = "ok";
const embeddingService = getEmbeddingService();
embeddingService.getConfig = () => ({ model: "test-embed-model" });
embeddingService.embed = async (text) => {
  if (embedMode === "throw") throw new Error("embedding backend is down");
  return { embedding: fakeVector(text) };
};

fake.createPaper({ key: "PAPERONE", title: "Squeeze casting of Al-Zn-Mg-Cu" });
fake.createPaper({ key: "PAPERTWO", title: "凝固前沿的溶质输运" });

const vectorStore = getVectorStore();
vectorStore.initialize = async () => {};
vectorStore.getChunksForItem = async () => [];
vectorStore.getIndexStatus = async (key) => ({
  contentHash: `content-${key}`,
  sourceKind: "body",
});
vectorStore.getCommittedResetGeneration = async () => "reset-1";

const dbPath = path.join(tempDir, "wiki.sqlite");
let sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");
let store = new WikiStore(adapt(sqlite));
await store.initialize();
let service = new WikiService(store);

const LIBRARY = 1;
let passed = 0;
async function block(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const rows = (sql, ...params) => sqlite.prepare(sql).all(...params);
const one = (sql, ...params) => sqlite.prepare(sql).get(...params);
const conceptIdOf = (name) =>
  one("SELECT concept_id FROM wiki_concepts WHERE canonical_name = ?", name)
    ?.concept_id;

// --- 0. The empty Wiki -----------------------------------------------------

await block("an empty Wiki has a revision and a skeleton", async () => {
  /*
   * The first paper of a library is written up against nothing: no pages, no
   * concepts, no relations, and MAX() over an empty table is NULL rather than
   * a number. Every one of those is a boundary the write-up crosses exactly
   * once, on the run where a mistake is least likely to be noticed.
   */
  const revision = await store.wikiRevision(LIBRARY);
  assert.equal(typeof revision, "string");
  assert.ok(revision.length, "an empty Wiki still has to have a revision");
  assert.ok(
    !/NaN|undefined|null/u.test(revision),
    `NULL aggregates must not leak into the revision: ${revision}`,
  );
  const neighbourhood = await store.conceptNeighbourhood({
    libraryID: LIBRARY,
    seedConceptIds: [],
    model: "test-embed-model",
  });
  assert.deepEqual(neighbourhood.seeds, []);
  assert.deepEqual(neighbourhood.neighbours, []);
  assert.deepEqual(neighbourhood.relations, []);
  assert.equal(neighbourhood.conceptCount, 0);
  assert.deepEqual(
    await store.matchConcepts({
      libraryID: LIBRARY,
      probes: [{ text: "挤压铸造", vector: fakeVector("挤压铸造") }],
      model: "test-embed-model",
    }),
    [{ probe: "挤压铸造", matches: [] }],
  );
});

// --- 1. The text a concept embeds as --------------------------------------

await block("the embedding text does not depend on row order", async () => {
  const forward = conceptEmbeddingText({
    canonicalName: "界面换热系数",
    conceptType: "property",
    description: "表征铸件与模具接触界面处传热能力的参数。",
    aliases: ["IHTC", "interfacial heat transfer coefficient"],
  });
  const reversed = conceptEmbeddingText({
    canonicalName: "界面换热系数",
    conceptType: "property",
    description: "表征铸件与模具接触界面处传热能力的参数。",
    aliases: ["interfacial heat transfer coefficient", "IHTC"],
  });
  assert.equal(
    forward,
    reversed,
    "an unsorted alias join would re-queue the library on every resync",
  );
  assert.ok(
    forward.startsWith("界面换热系数"),
    "the canonical name leads; an incidental English alias must not",
  );
  assert.match(forward, /IHTC/u, "aliases are in, or cross-language dedup dies");
  assert.match(forward, /传热能力/u, "so is the description, or relatedness dies");

  // The default type carries no information and would only add noise.
  assert.equal(
    conceptEmbeddingText({ canonicalName: "位错", conceptType: "concept" }),
    "位错",
  );
  // A duplicate alias must not be embedded twice.
  assert.equal(
    conceptEmbeddingText({ canonicalName: "位错", aliases: ["位错", "位错"] }),
    "位错",
  );
});

// --- 2. Every concept gets a vector ---------------------------------------

await block("creating a concept queues it, and a drain gives it a vector", async () => {
  await service.recordConcepts({
    libraryID: LIBRARY,
    concepts: [
      {
        primaryTerm: { zh: "界面换热系数", en: "interfacial heat transfer coefficient", abbr: "IHTC" },
        conceptType: "property",
        description: "表征铸件与模具接触界面处传热能力的参数。",
        sources: [{ itemKey: "PAPERONE" }],
      },
      {
        primaryTerm: { zh: "挤压铸造", en: "squeeze casting" },
        conceptType: "technique",
        description: "在压力下完成凝固结晶的近净成形工艺。",
        sources: [{ itemKey: "PAPERONE" }],
      },
      {
        primaryTerm: { zh: "晶粒细化", en: "grain refinement" },
        conceptType: "phenomenon",
        description: "初生晶粒由粗大枝晶转变为细小等轴晶。",
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  const queue = await store.conceptEmbeddingQueue();
  assert.equal(
    await queue.pendingCount(),
    3,
    "a concept nobody embedded is a concept recall cannot reach",
  );
  await service.pumpEmbeddingQueue({ limit: 100 });
  assert.equal(await queue.pendingCount(), 0, "the drain must empty the queue");
  assert.equal(
    rows("SELECT concept_id FROM wiki_concept_embeddings").length,
    3,
  );
  const stored = one(
    "SELECT dimensions, model FROM wiki_concept_embeddings LIMIT 1",
  );
  assert.equal(stored.model, "test-embed-model");
  assert.equal(stored.dimensions, VOCAB.length + TAIL);
});

// --- 3. Concepts that predate the table -----------------------------------

await block("a concept written before vectors existed is backfilled", async () => {
  sqlite
    .prepare(
      `INSERT INTO wiki_concepts
         (library_id, canonical_name, normalized_name, concept_type, description)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(LIBRARY, "旧概念", "旧概念", "concept", "在向量表存在之前写入的。");
  // Reopening is what a Zotero restart does, and it is where the backfill runs.
  const reopened = new WikiStore(adapt(sqlite));
  await reopened.initialize();
  const queue = await reopened.conceptEmbeddingQueue();
  assert.equal(
    await queue.pendingCount(),
    1,
    "the backfill is the repair path, not a one-shot migration",
  );
  await new WikiService(reopened).pumpEmbeddingQueue({ limit: 100 });
  assert.equal(await queue.pendingCount(), 0);
});

// --- 4 & 5. Staleness, and what resync must NOT touch ----------------------

await block("a rewritten concept is re-embedded; a failing one keeps its backoff", async () => {
  const id = conceptIdOf("晶粒细化");
  sqlite
    .prepare("UPDATE wiki_concepts SET description = ? WHERE concept_id = ?")
    .run("初生晶粒尺寸从 273 µm 降至 101 µm。", id);
  const { requeued } = await store.resyncConceptEmbeddings(LIBRARY);
  assert.equal(
    requeued,
    1,
    "found by comparing hashes, not by having been reported",
  );
  const queue = await store.conceptEmbeddingQueue();
  assert.deepEqual(
    (await queue.list()).map((row) => row.id),
    [id],
  );

  // An enqueue resets the backoff, so neither of these may be re-queued: the
  // one already in the queue has been noticed, and the one with no vector is
  // the schema backfill's job. Re-queuing either erases the record of how many
  // times the backend already refused it, and it never reaches "exhausted".
  sqlite
    .prepare("DELETE FROM wiki_concept_embeddings WHERE concept_id = ?")
    .run(conceptIdOf("挤压铸造"));
  const second = await store.resyncConceptEmbeddings(LIBRARY);
  assert.equal(
    second.requeued,
    0,
    "resync means stale-and-unnoticed, not missing and not already queued",
  );
  const stillQueued = await queue.list();
  assert.deepEqual(
    stillQueued.map((row) => row.id),
    [id],
    "the second resync must not have added the vector-less concept",
  );
  assert.equal(
    stillQueued[0].attempts,
    0,
    "and must not have disturbed the row that was already there",
  );

  await service.pumpEmbeddingQueue({ limit: 100 });
  const refreshed = one(
    "SELECT text_hash FROM wiki_concept_embeddings WHERE concept_id = ?",
    id,
  );
  assert.equal(
    refreshed.text_hash,
    await hashWikiText(
      conceptEmbeddingText({
        canonicalName: "晶粒细化",
        conceptType: "phenomenon",
        description: "初生晶粒尺寸从 273 µm 降至 101 µm。",
        aliases: ["grain refinement"],
      }),
    ),
    "the stored hash is what future staleness checks compare against",
  );
  assert.equal(await (await store.resyncConceptEmbeddings(LIBRARY)).requeued, 0);
});

// --- 5b. A foreign embedding space ----------------------------------------

await block("a vector from another model is discarded, not enthroned", async () => {
  /*
   * This is the failure that cost a 30-paper run its entire concept recall.
   * `getConfig().model` returns the DEFAULT until `embed()` has initialized the
   * service, and the model name was read BEFORE the embedding - so one concept
   * was stamped `text-embedding-3-small` while its vector came from the
   * configured model. The identity guard then rejected all 118 others as
   * foreign, they exhausted their retries, and the Wiki went on reporting
   * itself healthy while every neighbourhood came back empty.
   *
   * Two things have to hold now: the stale row must not block the write, and
   * it must be re-queued rather than left as a vector nobody can use.
   */
  const victim = conceptIdOf("挤压铸造");
  sqlite
    .prepare(
      `INSERT INTO wiki_concept_embeddings
         (concept_id, embedding, dimensions, model, text_hash, updated_at)
       VALUES (?, ?, ?, 'text-embedding-3-small', 'stale', ?)
       ON CONFLICT(concept_id) DO UPDATE SET model = excluded.model,
         text_hash = excluded.text_hash`,
    )
    .run(
      victim,
      Buffer.from(new Float32Array(VOCAB.length + TAIL).buffer),
      VOCAB.length + TAIL,
      Date.now(),
    );

  const other = conceptIdOf("界面换热系数");
  await store.saveConceptEmbedding({
    conceptId: other,
    vector: fakeVector("界面换热系数"),
    model: "test-embed-model",
    textHash: "whatever",
  });

  const spaces = rows(
    "SELECT DISTINCT model FROM wiki_concept_embeddings",
  ).map((row) => row.model);
  assert.deepEqual(
    spaces,
    ["test-embed-model"],
    "one foreign row must not survive to reject every future write",
  );
  const queue = await store.conceptEmbeddingQueue();
  assert.ok(
    (await queue.list()).some((row) => row.id === victim),
    "the concept whose vector was discarded has to be re-queued for the new space",
  );
  await service.pumpEmbeddingQueue({ limit: 100 });
  assert.equal(await queue.pendingCount(), 0);
});

// --- 6. Duplicate detection -----------------------------------------------

await block("a near-synonym under another name is caught", async () => {
  const probe = "界面传热系数";
  const [result] = await store.matchConcepts({
    libraryID: LIBRARY,
    probes: [{ text: probe, vector: fakeVector(probe) }],
    model: "test-embed-model",
    limit: 5,
  });
  assert.equal(result.probe, probe);
  const top = result.matches[0];
  assert.equal(
    top.name,
    "界面换热系数",
    "one character apart, normalizing differently, and the same concept",
  );
  assert.equal(top.matchedBy, "vector", "lexical matching cannot see this");
  /*
   * Ranking, not an absolute threshold. The probe is a bare name and the
   * stored vector is a whole record - name, aliases, type and description -
   * so the cosine between them is diluted by construction and a number like
   * 0.5 here does not mean "half a match". What has to hold is separation:
   * the near-synonym must stand clearly above the unrelated entries it is
   * being ranked against, because that ordering is what the write-up reads.
   */
  const unrelated = result.matches.find((match) => match.name === "晶粒细化");
  assert.ok(unrelated, "the fixture must contain something to be separated from");
  assert.ok(
    top.score > unrelated.score * 1.5,
    `near-synonym ${top.score} must stand clear of unrelated ${unrelated.score}`,
  );
});

await block("an exact alias is reported as certain, ahead of any guess", async () => {
  const [result] = await store.matchConcepts({
    libraryID: LIBRARY,
    probes: [{ text: "IHTC", vector: fakeVector("IHTC") }],
    model: "test-embed-model",
    limit: 5,
  });
  const top = result.matches[0];
  assert.equal(top.name, "界面换热系数");
  assert.equal(top.matchedBy, "name");
  assert.equal(top.score, 1, "a name hit is not a similarity");
  assert.equal(
    result.matches.filter((match) => match.name === top.name).length,
    1,
    "the certain hit must not also appear as a vector guess",
  );
});

await block("without vectors the check degrades to names, it does not fail", async () => {
  const [result] = await store.matchConcepts({
    libraryID: LIBRARY,
    probes: [{ text: "IHTC", vector: null }],
    model: "test-embed-model",
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].matchedBy, "name");
});

// --- 7 & 8. The neighbourhood ---------------------------------------------

await block("the neighbourhood is bounded by the paper, not the library", async () => {
  // A second paper's concepts, one of them related to the first paper's.
  await service.recordConcepts({
    libraryID: LIBRARY,
    concepts: [
      {
        primaryTerm: { zh: "溶质扩散", en: "solute diffusion" },
        conceptType: "phenomenon",
        description: "固液界面前沿的溶质输运。",
        sources: [{ itemKey: "PAPERTWO" }],
      },
      {
        primaryTerm: { zh: "抗拉强度", en: "ultimate tensile strength" },
        conceptType: "property",
        description: "材料断裂前所能承受的最大应力。",
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  await service.pumpEmbeddingQueue({ limit: 100 });

  const squeeze = conceptIdOf("挤压铸造");
  const refinement = conceptIdOf("晶粒细化");
  const strength = conceptIdOf("抗拉强度");
  const now = Date.now();
  const relate = (source, target, predicate) =>
    sqlite
      .prepare(
        `INSERT INTO wiki_relations
           (source_concept_id, predicate, normalized_predicate, target_concept_id,
            confidence, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(source, predicate, predicate, target, now);
  relate(squeeze, refinement, "refines");
  relate(squeeze, strength, "raises");

  const seeds = await store.conceptIdsForItem(LIBRARY, "PAPERONE");
  assert.equal(
    seeds.length,
    3,
    "the paper's own concepts come from the term sources, not from the model",
  );

  const neighbourhood = await store.conceptNeighbourhood({
    libraryID: LIBRARY,
    seedConceptIds: seeds,
    model: "test-embed-model",
    limit: 10,
    hubLimit: 3,
  });

  const names = (list) => list.map((entry) => entry.name).sort();
  assert.deepEqual(names(neighbourhood.seeds), [
    "挤压铸造",
    "晶粒细化",
    "界面换热系数",
  ]);
  for (const seed of neighbourhood.seeds) {
    assert.ok(
      !neighbourhood.neighbours.some((n) => n.name === seed.name),
      `${seed.name} is the paper's own; returning it as a neighbour wastes budget`,
    );
    assert.ok(!neighbourhood.hubs.some((h) => h.name === seed.name));
  }
  assert.ok(
    neighbourhood.neighbours.length > 0,
    "a paper with no visible neighbourhood cannot propose a relation",
  );
  assert.ok(
    neighbourhood.neighbours.every((entry) => entry.score > 0),
    "an unscored entry is padding",
  );
  assert.deepEqual(
    neighbourhood.neighbours.map((entry) => entry.score),
    [...neighbourhood.neighbours.map((entry) => entry.score)].sort(
      (a, b) => b - a,
    ),
    "nearest first, or a truncated list drops the best matches",
  );
  assert.equal(neighbourhood.conceptCount, 6);
  assert.equal(neighbourhood.pendingVectors, 0);

  // 抗拉强度 is one relation from a seed. Whether it also scores as a
  // neighbour or not, it must be reachable - that is what `related` is for.
  const reachable = [
    ...names(neighbourhood.neighbours),
    ...names(neighbourhood.related),
  ];
  assert.ok(
    reachable.includes("抗拉强度"),
    "a concept the Wiki already links to this paper must never be invisible",
  );

  // Relations are restricted to what the response actually named.
  const mentioned = new Set([
    ...names(neighbourhood.seeds),
    ...reachable,
    ...names(neighbourhood.hubs),
  ]);
  for (const relation of neighbourhood.relations) {
    const [source, , target] = relation.split(/ --| --> |--> /u);
    for (const end of relation.split(/ --.*?--> /u)) {
      assert.ok(
        mentioned.has(end.trim()),
        `relation "${relation}" names ${end.trim()}, which the response never showed`,
      );
    }
    assert.ok(source && target !== undefined);
  }
  assert.ok(
    neighbourhood.relations.some((line) => /挤压铸造 --refines--> 晶粒细化/u.test(line)),
    "relations among the in-scope set must still be present",
  );
});

// --- 9 & 10. The skeleton and its revision --------------------------------

await block("the revision moves only when the Wiki does", async () => {
  const first = await store.wikiRevision(LIBRARY);
  assert.equal(
    first,
    await store.wikiRevision(LIBRARY),
    "an unstable revision would defeat the whole point of caching on it",
  );
  await service.recordConcepts({
    libraryID: LIBRARY,
    concepts: [
      {
        primaryTerm: { zh: "凝固压力", en: "solidification pressure" },
        conceptType: "process_parameter",
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  const afterAdd = await store.wikiRevision(LIBRARY);
  assert.notEqual(afterAdd, first, "a new concept must move it");

  sqlite
    .prepare("UPDATE wiki_concepts SET normalized_name = ? WHERE concept_id = ?")
    .run("凝固压力x", conceptIdOf("凝固压力"));
  assert.notEqual(
    await store.wikiRevision(LIBRARY),
    afterAdd,
    "a rename moves nothing countable; the name fingerprint has to catch it",
  );
});

await block("the skeleton is a neighbourhood, and repeats say so", async () => {
  const prepared = await service.prepareUpdate({
    libraryID: LIBRARY,
    itemKey: "PAPERONE",
    query: "挤压铸造对晶粒细化的影响",
  });
  const skeleton = prepared.wikiSkeleton;
  assert.ok(skeleton, "prepare_update must still carry a skeleton");
  assert.equal(
    skeleton.concepts,
    undefined,
    "enumerating every concept is the cost this design removes",
  );
  assert.ok(Array.isArray(skeleton.pages), "the page list stays complete");
  assert.equal(typeof skeleton.conceptCount, "number");
  assert.ok(
    Array.isArray(skeleton.duplicateCandidates),
    "the write-up has to be able to see what it may be repeating",
  );
  assert.deepEqual(
    [...skeleton.paperConcepts].sort(),
    ["挤压铸造", "晶粒细化", "界面换热系数"],
    "seeded from the paper's own recorded terms",
  );
  assert.ok(Array.isArray(skeleton.nearbyConcepts));
  assert.ok(Array.isArray(skeleton.hubConcepts));
  assert.ok(typeof skeleton.revision === "string" && skeleton.revision.length);
  for (const entry of skeleton.nearbyConcepts) {
    assert.ok(
      entry.description.length <= 120,
      "descriptions stay capped; that cap is most of the per-entry cost",
    );
  }

  const again = await service.prepareUpdate({
    libraryID: LIBRARY,
    itemKey: "PAPERONE",
    query: "挤压铸造对晶粒细化的影响",
  });
  assert.equal(
    again.wikiSkeleton.unchanged,
    true,
    "the same structure sent twice in one conversation is pure waste",
  );
  assert.equal(again.wikiSkeleton.revision, skeleton.revision);
  assert.equal(again.wikiSkeleton.pages, undefined);

  const forced = await service.prepareUpdate({
    libraryID: LIBRARY,
    itemKey: "PAPERONE",
    query: "挤压铸造对晶粒细化的影响",
    refreshSkeleton: true,
  });
  assert.ok(
    Array.isArray(forced.wikiSkeleton.pages),
    "a caller that does not have the skeleton must have a way to get it",
  );

  // And a real change must break the cache.
  await service.recordConcepts({
    libraryID: LIBRARY,
    concepts: [
      {
        primaryTerm: { zh: "缩孔", en: "shrinkage porosity" },
        conceptType: "phenomenon",
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  const afterChange = await service.prepareUpdate({
    libraryID: LIBRARY,
    itemKey: "PAPERONE",
    query: "挤压铸造对晶粒细化的影响",
  });
  assert.notEqual(
    afterChange.wikiSkeleton.unchanged,
    true,
    "returning 'unchanged' after a change is the one thing this must never do",
  );
});

await block("an embedding outage degrades the skeleton, it does not block it", async () => {
  embedMode = "throw";
  try {
    const prepared = await service.prepareUpdate({
      libraryID: LIBRARY,
      itemKey: "PAPERONE",
      query: "缩孔与应力集中",
      refreshSkeleton: true,
    });
    const skeleton = prepared.wikiSkeleton;
    assert.ok(
      skeleton.warnings?.some((warning) => /字面匹配/u.test(warning)),
      "a silently weaker duplicate check is worse than a stated one",
    );
    assert.ok(Array.isArray(skeleton.pages), "the rest of it still arrives");
  } finally {
    embedMode = "ok";
  }
});

// --- 5c. Concept names that are really paper titles ------------------------

await block("a paper-shaped concept name is flagged, never refused", async () => {
  /*
   * Thirty papers produced 119 concepts and not one was used by a second
   * paper, because the names were this-paper-only compounds. There is no
   * string test for "is this a term of the field" - the property lives in
   * whether another paper would use the name - so this warns and writes.
   */
  const recorded = await service.recordConcepts({
    libraryID: LIBRARY,
    concepts: [
      {
        primaryTerm: { zh: "增材修复熔池柱状晶外延生长与CET抑制" },
        conceptType: "phenomenon",
        sources: [{ itemKey: "PAPERTWO" }],
      },
      {
        primaryTerm: { zh: "位错锁高温阻碍效应", en: "Lomer-Cottrell lock" },
        conceptType: "mechanism",
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  assert.ok(recorded.written, "a long name is still recorded, not rejected");
  assert.deepEqual(
    recorded.conceptNamesToReview?.names,
    ["增材修复熔池柱状晶外延生长与CET抑制"],
    "the paper-shaped one is raised and the real term is left alone",
  );
  assert.match(recorded.conceptNamesToReview.note, /领域术语/u);

  const { conceptNameUnits } = await import(
    "../src/modules/wiki/wikiConceptTerms.ts"
  );
  assert.ok(
    conceptNameUnits("Lomer-Cottrell位错锁高温阻碍效应") <
      conceptNameUnits("柱状晶长度调控二冷优化技术"),
    "a Latin run counts as one unit, or every foreign term is flagged and every compound cleared",
  );
});

await block("existing pages are ranked as extension candidates", async () => {
  /*
   * Thirty papers were written up with the complete page list in every
   * response and produced thirty pages, each backed by one paper. A list of
   * titles is the raw material for "which page does this belong on", not an
   * answer to it. Pages have no vector of their own - primary_concept_id was
   * null for all thirty - so they are reached through their Claims, which do.
   */
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO wiki_pages (library_id, canonical_title, normalized_title,
         summary, status, created_at, updated_at, version)
       VALUES (?, ?, ?, '', 'active', ?, ?, 1)`,
    )
    .run(LIBRARY, "压力对凝固组织的调控", "压力对凝固组织的调控", now, now);
  const pageId = one("SELECT last_insert_rowid() id").id;
  sqlite
    .prepare(
      `INSERT INTO wiki_claims (page_id, claim_text, normalized_claim_text,
         claim_type, epistemic_status, coverage_level, confidence,
         created_at, updated_at, version)
       VALUES (?, ?, ?, 'mechanism', 'supported', 'section_read', 1, ?, ?, 1)`,
    )
    .run(
      pageId,
      "挤压铸造压力使初生晶粒由粗大枝晶转变为细小等轴晶。",
      "挤压铸造压力使初生晶粒由粗大枝晶转变为细小等轴晶。",
      now,
      now,
    );
  const claimId = one("SELECT last_insert_rowid() id").id;
  const queue = await store.embeddingQueue();
  await queue.enqueue(claimId, "挤压铸造压力使初生晶粒由粗大枝晶转变为细小等轴晶。");
  await service.pumpEmbeddingQueue({ limit: 100 });

  const near = await store.pagesNearVectors({
    libraryID: LIBRARY,
    vectors: [fakeVector("挤压铸造晶粒细化")],
    model: "test-embed-model",
  });
  assert.equal(near.length, 1);
  assert.equal(near[0].title, "压力对凝固组织的调控");
  assert.ok(near[0].score > 0, "an unscored candidate is not a candidate");
  assert.ok(
    near[0].nearestClaim.includes("等轴晶"),
    "the reason a page is a candidate has to travel with it",
  );

  assert.deepEqual(
    await store.pagesNearVectors({
      libraryID: LIBRARY,
      vectors: [],
      model: "test-embed-model",
    }),
    [],
    "no probe is not a reason to recommend every page",
  );
});

console.log(`\n${passed} concept-recall blocks passed`);
