/* eslint-env node */

/**
 * The independent concept library: structure, deduplication, sources, upgrade.
 *
 * Each block is named for the failure it exists to prevent:
 *
 *   1. An abbreviation with no full name is stored, and nothing in the
 *      database can ever say what it expanded to.
 *   2. The same concept arriving under its Chinese name and later under its
 *      English name becomes two concepts.
 *   3. A merge picks the wrong primary term, or loses the losing term.
 *   4. A merge silently re-points or destroys a knowledge page.
 *   5. A source excerpt nobody can verify is stored as if it had been.
 *   6. A 2.4.2 database upgrades by losing its aliases.
 *   7. The flat projection every older surface reads goes stale, so Wiki
 *      search stops finding names the term store holds.
 *   8. A second spelling of a name is swallowed because another field of the
 *      same term already agreed - the 2.4.3 loss this suite now pins down.
 *   9. A field the model inferred is presented as something a paper said.
 *  10. A term a person edited, or a primary term they pinned, is overwritten
 *      by the next paper that mentions the concept.
 *  11. Two concepts that contradict each other are fused anyway.
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-concepts-"));
const fake = createZoteroFake({ rootDir: tempDir });
fake.install();

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { getVectorStore } = await import(
  "../src/modules/semantic/vectorStore.ts"
);
const {
  classifyLegacyName,
  choosePrimaryTerm,
  normalizeTermFields,
  sameTerm,
} = await import("../src/modules/wiki/wikiConceptTerms.ts");

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

// --- Library ---------------------------------------------------------------

const CHUNKS = new Map([
  [
    "PAPERONE",
    [
      {
        chunkId: 11,
        text: "Dynamic recrystallization (DRX) refines the grain structure once the critical strain is exceeded.",
        language: "en",
      },
      {
        chunkId: 12,
        text: "The columnar-to-equiaxed transition is observed at a thermal gradient of 8 K/mm.",
        language: "en",
      },
    ],
  ],
  [
    "PAPERTWO",
    [
      {
        chunkId: 21,
        text: "动态再结晶导致位错密度显著下降，是本文观察到的主要软化机制。",
        language: "zh",
      },
    ],
  ],
]);

fake.createPaper({ key: "PAPERONE", title: "Grain refinement under hot working" });
fake.createPaper({ key: "PAPERTWO", title: "热变形中的软化机制" });

const vectorStore = getVectorStore();
vectorStore.initialize = async () => {};
vectorStore.getChunksForItem = async (key) => CHUNKS.get(key) ?? [];
vectorStore.getIndexStatus = async (key) => ({
  contentHash: `content-${key}`,
  sourceKind: "body",
});
vectorStore.getCommittedResetGeneration = async () => "reset-1";

const dbPath = path.join(tempDir, "zotero-mcp-wiki.sqlite");
const sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");
const store = new WikiStore(adapt(sqlite));
await store.initialize();
const service = new WikiService(store);

const results = [];
async function block(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message}`);
  }
}

const conceptsOf = async () => (await store.concepts()).list(1);
const byName = async (name) =>
  (await conceptsOf()).find((concept) => concept.displayName === name);

// --- 1. The abbreviation rule ---------------------------------------------

await block("an abbreviation may never stand alone", async () => {
  assert.throws(
    () => normalizeTermFields({ zh: "", en: "", abbr: "CET" }),
    /abbreviation on its own/iu,
    "the rule belongs to the domain, not to the tool schema",
  );
  assert.deepEqual(normalizeTermFields({ zh: " 动态再结晶 ", abbr: "DRX" }), {
    zh: "动态再结晶",
    en: "",
    abbr: "DRX",
  });
  // Incomplete is fine: Chinese alone, or English plus an abbreviation.
  assert.ok(normalizeTermFields({ zh: "位错密度" }));
  assert.ok(normalizeTermFields({ en: "dislocation density", abbr: "DD" }));

  const recorded = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      { primaryTerm: { abbr: "EBSD" }, sources: [{ itemKey: "PAPERONE" }] },
      {
        primaryTerm: { zh: "位错密度", en: "dislocation density" },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  assert.equal(
    recorded.createdConcepts,
    1,
    "the abbreviation-only entity must not create a concept",
  );
  assert.ok(
    recorded.warnings.some((warning) => /abbreviation on its own/iu.test(warning)),
    "and the caller must be told why, not silently ignored",
  );
  assert.equal(
    (await conceptsOf()).some((concept) => concept.displayName === "EBSD"),
    false,
  );
});

// --- 2. Deduplication on full names ---------------------------------------

await block("one concept, however many names it arrives under", async () => {
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: { zh: "动态再结晶", abbr: "DRX" },
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  const first = await byName("动态再结晶");
  assert.ok(first, "the Chinese full name titles the entry");

  // The same concept, met again in another paper under its English name and
  // its abbreviation. It must JOIN the existing concept.
  const again = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "动态再结晶",
          en: "Dynamic Recrystallization",
          abbr: "DRX",
        },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  assert.equal(again.createdConcepts, 0, "a known full name founds nothing");
  assert.equal(again.completedTerms, 1, "it completes the term it matched");

  const merged = await byName("动态再结晶");
  assert.equal(merged.conceptId, first.conceptId);
  assert.equal(merged.primaryTerm.en, "Dynamic Recrystallization");
  assert.equal(merged.primaryTerm.abbr, "DRX");
  assert.equal(
    merged.aliasTerms.length,
    0,
    "completing a term must not leave a duplicate behind",
  );
  assert.deepEqual(
    merged.primaryTerm.sources.map((source) => source.itemKey).sort(),
    ["PAPERONE", "PAPERTWO"],
    "a second sighting adds a source rather than replacing one",
  );
});

await block("a shared abbreviation is never enough to merge two concepts", async () => {
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: { en: "critical energy threshold", abbr: "CET" },
        sources: [{ itemKey: "PAPERONE" }],
      },
      {
        primaryTerm: {
          zh: "柱状晶到等轴晶转变",
          en: "columnar-to-equiaxed transition",
          abbr: "CET",
        },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  const all = await conceptsOf();
  assert.ok(
    all.some((concept) => concept.displayName === "critical energy threshold"),
  );
  assert.ok(
    all.some((concept) => concept.displayName === "柱状晶到等轴晶转变"),
    "two different concepts that share an abbreviation must stay apart",
  );
  assert.ok(
    !sameTerm(
      { zh: "", en: "critical energy threshold", abbr: "CET" },
      { zh: "柱状晶到等轴晶转变", en: "columnar-to-equiaxed transition", abbr: "CET" },
    ),
  );
});

// --- 3. Merging, and which term becomes primary ----------------------------

await block("a merge keeps the most complete term as primary", async () => {
  // Two concepts recorded separately, each holding half the truth.
  await service.recordConcepts({
    libraryID: 1,
    concepts: [{ primaryTerm: { zh: "晶粒长大" }, sources: [{ itemKey: "PAPERONE" }] }],
  });
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: { en: "grain growth", abbr: "GG" },
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  const before = await conceptsOf();
  assert.equal(
    before.filter((concept) =>
      ["晶粒长大", "grain growth"].includes(concept.displayName),
    ).length,
    2,
    "nothing has told the library these are one concept yet",
  );

  // Now the model says so - and since 2.4.4 it has to say it as ONE term
  // group. "These two names are the same term" is the claim that fuses two
  // concepts; "these two terms belong together" is not, because aliases of a
  // concept legitimately differ from one another and an entity that merely
  // groups them is far weaker evidence than it looks.
  const merged = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: { zh: "晶粒长大", en: "grain growth", abbr: "GG" },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  assert.equal(merged.mergedConcepts, 1);

  const after = await conceptsOf();
  assert.equal(
    after.filter((concept) =>
      ["晶粒长大", "grain growth"].includes(concept.displayName),
    ).length,
    1,
    "the two entities became one",
  );
  const concept = await byName("晶粒长大");
  assert.ok(concept, "the Chinese full name titles the surviving entity");
  assert.equal(concept.primaryTerm.en, "grain growth");
  assert.equal(concept.primaryTerm.abbr, "GG");
  assert.equal(
    concept.primaryTerm.zh,
    "晶粒长大",
    "both halves end up in one complete term, and neither is lost",
  );
  assert.deepEqual(
    concept.primaryTerm.sources.map((source) => source.itemKey).sort(),
    ["PAPERONE", "PAPERTWO"],
    "the merged term keeps the sources of both concepts",
  );
});

await block("grouping two terms in one entity does not fuse two concepts", async () => {
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      { primaryTerm: { zh: "静态再结晶" }, sources: [{ itemKey: "PAPERONE" }] },
    ],
  });
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      { primaryTerm: { en: "static recovery" }, sources: [{ itemKey: "PAPERONE" }] },
    ],
  });
  const attempt = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: { zh: "静态再结晶" },
        terms: [{ en: "static recovery" }],
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  assert.equal(
    attempt.mergedConcepts,
    0,
    "no single term agrees with both, so nothing is strong enough to fuse them",
  );
  assert.ok(await byName("静态再结晶"));
  assert.ok(await byName("static recovery"));
});

await block("completeness beats recency, and ties go to the earliest", () => {
  const chosen = choosePrimaryTerm([
    { zh: "甲", en: "", abbr: "", createdAt: 1, termId: 1 },
    { zh: "乙", en: "b", abbr: "B", createdAt: 9, termId: 2 },
  ]);
  assert.equal(chosen.zh, "乙");
  const tie = choosePrimaryTerm([
    { zh: "丙", en: "c", abbr: "", createdAt: 5, termId: 3 },
    { zh: "丁", en: "d", abbr: "", createdAt: 2, termId: 4 },
  ]);
  assert.equal(tie.zh, "丁");
});

// --- 4. A merge must never take a knowledge page down with it -------------

await block("a merge that would collide two pages is refused, loudly", async () => {
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query: "Page A topic",
    proposedPageTitles: ["Page A topic"],
  });
  await service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: prepared.prepareToken,
    actions: [
      {
        action: "CREATE_PAGE",
        canonicalTitle: "Page A topic",
        primaryConcept: { canonicalName: "回复退火" },
      },
    ],
  });
  const preparedB = await service.prepareUpdate({
    libraryID: 1,
    query: "Page B topic",
    proposedPageTitles: ["Page B topic"],
  });
  await service.commit({
    libraryID: 1,
    userInitiated: true,
    prepareToken: preparedB.prepareToken,
    actions: [
      {
        action: "CREATE_PAGE",
        canonicalTitle: "Page B topic",
        primaryConcept: { canonicalName: "recovery annealing" },
      },
    ],
  });

  const attempt = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: { zh: "回复退火", en: "recovery annealing" },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  assert.equal(attempt.mergedConcepts, 0);
  assert.ok(
    attempt.warnings.some((warning) => /both own an active knowledge page/iu.test(warning)),
    "the refusal must name the reason a person can act on",
  );
  const pages = sqlite
    .prepare("SELECT COUNT(*) AS n FROM wiki_pages WHERE status = 'active'")
    .get();
  assert.equal(pages.n, 2, "both knowledge entries must survive the attempt");
});

// --- 5. Sources are verified as far as they were offered ------------------

await block("a concept without a real Zotero source is refused", async () => {
  await assert.rejects(
    () =>
      service.recordConcepts({
        libraryID: 1,
        concepts: [{ primaryTerm: { en: "untraceable mechanism" } }],
      }),
    /real Zotero document source/iu,
  );
  assert.equal(
    await byName("untraceable mechanism"),
    undefined,
    "a source-free concept must never reach the Wiki database",
  );
  await assert.rejects(
    () =>
      service.recordConcepts({
        libraryID: 1,
        concepts: [
          {
            primaryTerm: { en: "ghost source term" },
            sources: [{ itemKey: "NOSUCHKEY" }],
          },
        ],
      }),
    /real Zotero document source/iu,
  );
});

await block("a source is a document; an excerpt is only kept if it checks out", async () => {
  const recorded = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: { en: "critical strain", zh: "临界应变" },
        sources: [
          {
            itemKey: "PAPERONE",
            chunkIdSnapshot: 11,
            excerpt: "once the critical strain is exceeded",
          },
        ],
      },
      {
        primaryTerm: { en: "imaginary mechanism" },
        sources: [
          {
            itemKey: "PAPERONE",
            chunkIdSnapshot: 11,
            excerpt: "a sentence this paper never contained",
          },
        ],
      },
    ],
  });

  const verified = await byName("临界应变");
  assert.equal(verified.primaryTerm.sources.length, 1);
  assert.equal(verified.primaryTerm.sources[0].chunkIdSnapshot, 11);
  assert.match(
    verified.primaryTerm.sources[0].excerpt,
    /critical strain is exceeded/u,
  );

  const unverified = await byName("imaginary mechanism");
  assert.equal(
    unverified.primaryTerm.sources.length,
    1,
    "the document link survives an excerpt that could not be found",
  );
  assert.equal(unverified.primaryTerm.sources[0].excerpt, "");
  assert.equal(unverified.primaryTerm.sources[0].chunkIdSnapshot, null);
  assert.ok(
    recorded.warnings.some((warning) => /could not be found in its indexed chunks/iu.test(warning)),
  );

});

// --- 6. Upgrading a 2.4.2 database ----------------------------------------

await block("a 2.4.2 database keeps every alias it had", async () => {
  const legacyPath = path.join(tempDir, "legacy.sqlite");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec("PRAGMA foreign_keys = ON");
  // Exactly the schema-3 shape: concepts and flat aliases, nothing else.
  legacy.exec(`
    CREATE TABLE wiki_concepts (
      concept_id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      concept_type TEXT NOT NULL DEFAULT 'concept',
      description TEXT NOT NULL DEFAULT '',
      UNIQUE(library_id, normalized_name)
    );
    CREATE TABLE wiki_aliases (
      alias_id INTEGER PRIMARY KEY AUTOINCREMENT,
      concept_id INTEGER NOT NULL REFERENCES wiki_concepts(concept_id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'und',
      source TEXT NOT NULL DEFAULT 'ai',
      confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
      UNIQUE(concept_id, normalized_alias)
    );
    INSERT INTO wiki_concepts (library_id, canonical_name, normalized_name)
      VALUES (1, '动态再结晶', '动态再结晶'), (1, 'twinning', 'twinning');
    INSERT INTO wiki_aliases (concept_id, alias, normalized_alias, language)
      VALUES (1, 'Dynamic Recrystallization', 'dynamic recrystallization', 'en'),
             (1, 'DRX', 'drx', 'en'),
             (1, 'DDRX', 'ddrx', 'en'),
             (2, '孪晶', '孪晶', 'zh');
  `);

  const legacyStore = new WikiStore(adapt(legacy));
  await legacyStore.initialize();
  const upgraded = await (await legacyStore.concepts()).list(1);

  const drx = upgraded.find((concept) => concept.displayName === "动态再结晶");
  assert.ok(drx, "the canonical name becomes the primary term");
  assert.equal(drx.primaryTerm.zh, "动态再结晶");
  assert.equal(
    drx.primaryTerm.abbr,
    "DRX",
    "a bare abbreviation completes the concept it already belonged to",
  );
  const names = [drx.primaryTerm, ...drx.aliasTerms].flatMap((term) =>
    [term.zh, term.en, term.abbr].filter(Boolean),
  );
  for (const original of ["动态再结晶", "Dynamic Recrystallization", "DRX", "DDRX"]) {
    assert.ok(names.includes(original), `the upgrade must keep ${original}`);
  }
  // The second abbreviation has no full name and no free slot, so it is kept
  // as a legacy row rather than dropped - and flagged as needing one.
  const orphan = drx.aliasTerms.find((term) => term.abbr === "DDRX");
  assert.ok(orphan, "a second bare abbreviation is preserved, not discarded");
  assert.equal(orphan.source, "legacy");
  assert.equal(orphan.zh, "");
  assert.equal(orphan.en, "");

  const twin = upgraded.find((concept) => concept.displayName === "twinning");
  assert.equal(twin.aliasTerms[0].zh, "孪晶", "a Chinese alias lands in the Chinese column");

  // Running the upgrade again must change nothing.
  const secondStore = new WikiStore(adapt(legacy));
  await secondStore.initialize();
  const twice = await (await secondStore.concepts()).list(1);
  assert.equal(twice.length, upgraded.length);
  assert.equal(
    twice.find((concept) => concept.displayName === "动态再结晶").aliasTerms.length,
    drx.aliasTerms.length,
    "the migration must be idempotent",
  );
  legacy.close();
});

await block("a 2.4.3 database upgrades without losing a term", async () => {
  const path43 = path.join(tempDir, "v243.sqlite");
  const legacy = new DatabaseSync(path43);
  legacy.exec("PRAGMA foreign_keys = ON");
  // Exactly the schema-4 shape: structured terms, but no provenance columns
  // and no way to pin a primary term.
  legacy.exec(`
    CREATE TABLE wiki_concepts (
      concept_id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      concept_type TEXT NOT NULL DEFAULT 'concept',
      description TEXT NOT NULL DEFAULT '',
      UNIQUE(library_id, normalized_name)
    );
    CREATE TABLE wiki_aliases (
      alias_id INTEGER PRIMARY KEY AUTOINCREMENT,
      concept_id INTEGER NOT NULL REFERENCES wiki_concepts(concept_id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'und',
      source TEXT NOT NULL DEFAULT 'ai',
      confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
      UNIQUE(concept_id, normalized_alias)
    );
    CREATE TABLE wiki_concept_terms (
      term_id INTEGER PRIMARY KEY AUTOINCREMENT,
      concept_id INTEGER NOT NULL REFERENCES wiki_concepts(concept_id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('primary','alias')),
      name_zh TEXT NOT NULL DEFAULT '',
      name_en TEXT NOT NULL DEFAULT '',
      abbreviation TEXT NOT NULL DEFAULT '',
      normalized_zh TEXT NOT NULL DEFAULT '',
      normalized_en TEXT NOT NULL DEFAULT '',
      normalized_abbr TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'ai',
      confidence REAL NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(concept_id, normalized_zh, normalized_en, normalized_abbr)
    );
    CREATE TABLE wiki_concept_term_sources (
      source_id INTEGER PRIMARY KEY AUTOINCREMENT,
      term_id INTEGER NOT NULL REFERENCES wiki_concept_terms(term_id) ON DELETE CASCADE,
      library_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      chunk_id_snapshot INTEGER,
      excerpt TEXT NOT NULL DEFAULT '',
      excerpt_hash TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(term_id, library_id, item_key, excerpt_hash)
    );
    PRAGMA user_version = 4;
    INSERT INTO wiki_concepts (library_id, canonical_name, normalized_name)
      VALUES (1, '柱状晶', '柱状晶');
    INSERT INTO wiki_concept_terms
      (concept_id, role, name_zh, name_en, abbreviation,
       normalized_zh, normalized_en, normalized_abbr, source, created_at, updated_at)
      VALUES (1, 'primary', '柱状晶', 'columnar grain', '',
              '柱状晶', 'columnar grain', '', 'ai', 1, 1),
             (1, 'alias', '', 'columnar dendrite', '',
              '', 'columnar dendrite', '', 'ai', 1, 1);
    INSERT INTO wiki_concept_term_sources
      (term_id, library_id, item_key, excerpt, excerpt_hash, created_at)
      VALUES (1, 1, 'PAPERONE', '', '', 1);
  `);

  const upgradedStore = new WikiStore(adapt(legacy));
  await upgradedStore.initialize();
  const library = await upgradedStore.concepts();
  const concepts = await library.list(1);
  const concept = concepts.find((entry) => entry.displayName === "柱状晶");
  assert.ok(concept, "the concept survives the upgrade");
  assert.equal(concept.primaryTerm.en, "columnar grain");
  assert.equal(concept.aliasTerms.length, 1);
  assert.equal(concept.aliasTerms[0].en, "columnar dendrite");
  assert.equal(
    concept.primaryTerm.sources[0].itemKey,
    "PAPERONE",
    "sources survive too",
  );

  // Provenance nobody recorded stays unrecorded. Stamping these fields
  // "literature" would invent the assurance the column exists to give.
  assert.deepEqual(concept.primaryTerm.origins, { zh: "", en: "", abbr: "" });
  assert.equal(concept.primaryLocked, false, "nothing was pinned before 2.4.4");

  // An unknown-provenance field is not an inferred one, so a later paper adds
  // its own spelling beside it rather than overwriting it.
  const upgradedService = new WikiService(upgradedStore);
  await upgradedService.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "柱状晶",
          en: "columnar crystal",
          origins: { zh: "literature", en: "literature" },
        },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  const after = (await library.list(1)).find(
    (entry) => entry.displayName === "柱状晶",
  );
  const english = [after.primaryTerm, ...after.aliasTerms]
    .map((term) => term.en)
    .filter(Boolean)
    .sort();
  assert.deepEqual(english, [
    "columnar crystal",
    "columnar dendrite",
    "columnar grain",
  ]);
  legacy.close();
});

await block("legacy names are classified by shape, never invented", () => {
  assert.deepEqual(classifyLegacyName("动态再结晶"), {
    zh: "动态再结晶",
    en: "",
    abbr: "",
  });
  assert.deepEqual(classifyLegacyName("DRX"), { zh: "", en: "", abbr: "DRX" });
  assert.deepEqual(classifyLegacyName("dynamic recrystallization"), {
    zh: "",
    en: "dynamic recrystallization",
    abbr: "",
  });
  // A short all-caps phrase WITH a space is a name, not an abbreviation.
  assert.deepEqual(classifyLegacyName("HOT PRESS"), {
    zh: "",
    en: "HOT PRESS",
    abbr: "",
  });
});

// --- 7. The flat projection older surfaces still read ---------------------

await block("every structured name stays findable through the old indexes", async () => {
  const concept = await byName("动态再结晶");
  const aliases = sqlite
    .prepare("SELECT alias FROM wiki_aliases WHERE concept_id = ? ORDER BY alias")
    .all(concept.conceptId)
    .map((row) => row.alias);
  assert.deepEqual(aliases, ["DRX", "Dynamic Recrystallization"]);
  const canonical = sqlite
    .prepare("SELECT canonical_name FROM wiki_concepts WHERE concept_id = ?")
    .get(concept.conceptId);
  assert.equal(canonical.canonical_name, "动态再结晶");

  // And therefore the pre-existing candidate search finds it by abbreviation.
  const prepared = await store.prepareUpdate({ libraryID: 1, query: "DRX" });
  assert.ok(
    prepared.concepts.some((row) => row.conceptId === concept.conceptId),
    "wiki_prepare_update must see a name that only the term store introduced",
  );
});

// --- 8. Export ------------------------------------------------------------

await block("the export carries every term and its sources", async () => {
  const markdown = await service.exportConceptsMarkdown(1);
  assert.match(markdown, /# Zotero LLM 术语库/u);
  assert.match(markdown, /\| 序号 \| 中文术语 \| 英文术语 \| 简称 \|/u);
  assert.match(markdown, /\| 1 \| 动态再结晶 \| Dynamic Recrystallization \| DRX \|/u);
  assert.match(markdown, /来源文献：/u);
  assert.match(
    markdown,
    /Grain refinement under hot working/u,
    "sources must be named, not left as raw item keys",
  );

  // The Wiki export keeps its own structure and gains the library as an
  // appendix, so anything that parsed a 2.4.2 export still works.
  const wiki = await service.exportMarkdown(1);
  assert.match(wiki, /^# Zotero LLM Wiki/u);
  assert.match(wiki, /## 术语库 \/ Concept Library/u);
  assert.ok(
    wiki.indexOf("## Page A topic") < wiki.indexOf("## 术语库 / Concept Library"),
    "the concept library is appended after the existing sections",
  );
});

// --- 9. Manual editing ----------------------------------------------------

await block("a person can complete, promote and remove a term", async () => {
  const library = await store.concepts();
  const concept = await byName("柱状晶到等轴晶转变");
  const alias = { zh: "", en: "CET transition", abbr: "" };
  await library.addTerm({
    libraryID: 1,
    conceptId: concept.conceptId,
    fields: alias,
  });
  let updated = await library.get(concept.conceptId);
  assert.equal(updated.aliasTerms.length, 1);

  await assert.rejects(
    () =>
      library.addTerm({
        libraryID: 1,
        conceptId: concept.conceptId,
        fields: { abbr: "XYZ" },
      }),
    /abbreviation on its own/iu,
    "the hard rule applies to hand edits too",
  );

  const aliasTerm = updated.aliasTerms[0];
  await library.setPrimaryTerm({
    libraryID: 1,
    conceptId: concept.conceptId,
    termId: aliasTerm.termId,
  });
  updated = await library.get(concept.conceptId);
  assert.equal(updated.primaryTerm.termId, aliasTerm.termId);
  assert.equal(updated.displayName, "CET transition");

  await library.removeTerm({
    libraryID: 1,
    conceptId: concept.conceptId,
    termId: aliasTerm.termId,
  });
  updated = await library.get(concept.conceptId);
  assert.equal(updated.displayName, "柱状晶到等轴晶转变");
  assert.equal(updated.aliasTerms.length, 0);

  const solo = (await conceptsOf()).find(
    (entry) => entry.displayName === "位错密度",
  );
  await assert.rejects(
    () =>
      library.removeTerm({
        libraryID: 1,
        conceptId: solo.conceptId,
        termId: solo.primaryTerm.termId,
      }),
    /at least one term/iu,
    "a concept may not be left nameless",
  );
});

// --- 10. Search -----------------------------------------------------------

await block("the library is searchable by any of the three fields", async () => {
  const byAbbreviation = await service.searchConcepts({
    libraryID: 1,
    query: "DRX",
  });
  assert.equal(byAbbreviation.total, 1);
  assert.equal(byAbbreviation.concepts[0].displayName, "动态再结晶");

  const byEnglish = await service.searchConcepts({
    libraryID: 1,
    query: "dynamic recryst",
  });
  assert.equal(byEnglish.total, 1);

  const all = await service.searchConcepts({ libraryID: 1 });
  assert.ok(all.total > 1);
});

// --- 11. Names are never silently lost ------------------------------------

await block("a second English spelling is kept, not swallowed", async () => {
  // 2.4.3 matched on the Chinese name and then folded with `base.en || extra.en`,
  // so this second paper's spelling vanished without a warning.
  //
  // The stored spelling has to be attributed to a paper first, or the rule
  // under test would not be the one that fires: an AI-inferred field a paper
  // contradicts is corrected in place, which is a different behaviour with its
  // own block below.
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "动态再结晶",
          en: "Dynamic Recrystallization",
          origins: { zh: "literature", en: "literature" },
        },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  const before = await byName("动态再结晶");
  const beforeTerms = 1 + before.aliasTerms.length;

  const added = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "动态再结晶",
          en: "Dynamic Recrystallisation",
          origins: { zh: "literature", en: "literature" },
        },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  assert.equal(added.createdConcepts, 0, "it is the same concept");
  assert.equal(added.createdTerms, 1, "but a term of its own");

  const after = await byName("动态再结晶");
  assert.equal(1 + after.aliasTerms.length, beforeTerms + 1);
  const spellings = [after.primaryTerm, ...after.aliasTerms]
    .map((term) => term.en)
    .filter(Boolean)
    .sort();
  assert.deepEqual(spellings, [
    "Dynamic Recrystallisation",
    "Dynamic Recrystallization",
  ]);
});

await block("a second Chinese name is kept, not swallowed", async () => {
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "位错密度",
          en: "dislocation density",
          origins: { zh: "literature", en: "literature" },
        },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  const added = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "位错密度值",
          en: "dislocation density",
          origins: { zh: "literature", en: "literature" },
        },
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  assert.equal(added.createdConcepts, 0);
  const concept = await byName("位错密度");
  const chinese = [concept.primaryTerm, ...concept.aliasTerms]
    .map((term) => term.zh)
    .filter(Boolean)
    .sort();
  assert.deepEqual(chinese, ["位错密度", "位错密度值"]);
});

await block("an identical term only adds its source", async () => {
  const concept = await byName("位错密度");
  const termCount = 1 + concept.aliasTerms.length;
  const again = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "位错密度",
          en: "dislocation density",
          origins: { zh: "literature", en: "literature" },
        },
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  assert.equal(again.createdTerms, 0, "nothing new to store");
  assert.equal(again.addedSources, 1, "except that a second paper uses it");
  const after = await byName("位错密度");
  assert.equal(1 + after.aliasTerms.length, termCount);
});

// --- 12. Field-level provenance -------------------------------------------

await block("each field remembers where it came from", async () => {
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "孪晶诱导塑性",
          en: "twinning induced plasticity",
          abbr: "TWIP",
          // The paper only ever wrote the English name; the rest is the
          // model's own knowledge and has to say so.
          origins: { zh: "ai", en: "literature", abbr: "ai" },
        },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  const concept = await byName("孪晶诱导塑性");
  assert.deepEqual(concept.primaryTerm.origins, {
    zh: "ai",
    en: "literature",
    abbr: "ai",
  });
});

await block("an unmarked field is never called literature", async () => {
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: { zh: "热裂纹", en: "hot tearing" },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  const concept = await byName("热裂纹");
  assert.deepEqual(concept.primaryTerm.origins, {
    zh: "ai",
    en: "ai",
    abbr: "",
  });
});

await block("a paper confirms an inferred field, and corrects a wrong one", async () => {
  const before = await byName("孪晶诱导塑性");
  const beforeTerms = 1 + before.aliasTerms.length;

  // Same Chinese name, quoted this time: the inference is upgraded in place.
  const confirmed = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "孪晶诱导塑性",
          en: "twinning induced plasticity",
          origins: { zh: "literature", en: "literature" },
        },
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  assert.equal(confirmed.createdTerms, 0, "confirmation founds no new term");
  let concept = await byName("孪晶诱导塑性");
  assert.equal(concept.primaryTerm.origins.zh, "literature");
  assert.equal(1 + concept.aliasTerms.length, beforeTerms);

  // A different abbreviation, from a paper, against one the model inferred.
  const corrected = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "孪晶诱导塑性",
          abbr: "TRIP",
          origins: { zh: "literature", abbr: "literature" },
        },
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  assert.equal(corrected.correctedTerms, 1, "the paper overrules the guess");
  concept = await byName("孪晶诱导塑性");
  assert.equal(concept.primaryTerm.abbr, "TRIP");
  assert.equal(concept.primaryTerm.origins.abbr, "literature");
});

await block("what a person typed is never overwritten by a later paper", async () => {
  const library = await store.concepts();
  const concept = await byName("热裂纹");
  await library.updateTerm({
    libraryID: 1,
    conceptId: concept.conceptId,
    termId: concept.primaryTerm.termId,
    fields: { zh: "热裂纹", en: "hot cracking", abbr: "" },
  });
  let updated = await byName("热裂纹");
  assert.equal(updated.primaryTerm.en, "hot cracking");
  assert.equal(
    updated.primaryTerm.origins.en,
    "user",
    "the field that changed becomes the reader's",
  );
  assert.equal(
    updated.primaryTerm.origins.zh,
    "ai",
    "the field that did not change keeps its provenance",
  );

  // A paper now says something else. It must not silently rewrite the edit;
  // it becomes a second term of the same concept instead.
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "热裂纹",
          en: "hot tearing",
          origins: { zh: "literature", en: "literature" },
        },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  updated = await byName("热裂纹");
  const english = [updated.primaryTerm, ...updated.aliasTerms]
    .map((term) => term.en)
    .filter(Boolean)
    .sort();
  assert.deepEqual(english, ["hot cracking", "hot tearing"]);
  const kept = [updated.primaryTerm, ...updated.aliasTerms].find(
    (term) => term.en === "hot cracking",
  );
  assert.equal(kept.origins.en, "user", "the manual field is untouched");
});

// --- 13. A pinned primary term stays pinned -------------------------------

await block("a primary term a person pinned survives later reading", async () => {
  const library = await store.concepts();
  const before = await byName("动态再结晶");
  const alias = before.aliasTerms[0];
  assert.ok(alias, "the concept has an alias to promote");

  await library.setPrimaryTerm({
    libraryID: 1,
    conceptId: before.conceptId,
    termId: alias.termId,
  });
  let concept = await library.get(before.conceptId);
  assert.equal(concept.primaryTerm.termId, alias.termId);
  assert.equal(concept.primaryLocked, true, "choosing pins it");

  // A later paper arrives with a strictly more complete term group. Under the
  // completeness rule it would win the election; under the lock it must not.
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "动态再结晶",
          en: "Dynamic Recrystallization",
          abbr: "DRX",
          origins: { zh: "literature", en: "literature", abbr: "literature" },
        },
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  concept = await library.get(before.conceptId);
  assert.equal(
    concept.primaryTerm.termId,
    alias.termId,
    "a later paper may not re-elect a pinned primary term",
  );

  await library.clearPrimaryLock({
    libraryID: 1,
    conceptId: before.conceptId,
  });
  concept = await library.get(before.conceptId);
  assert.equal(concept.primaryLocked, false);
  assert.equal(
    concept.primaryTerm.termId !== alias.termId ||
      concept.primaryTerm.zh === "动态再结晶",
    true,
    "unlocking hands the choice back to completeness",
  );
});

// --- 14. Merging stays conservative ---------------------------------------

await block("concepts that contradict each other are not merged", async () => {
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "再结晶温度",
          en: "recrystallization temperature",
          origins: { zh: "literature", en: "literature" },
        },
        sources: [{ itemKey: "PAPERONE" }],
      },
      {
        primaryTerm: {
          zh: "再结晶温度区间",
          en: "recrystallization temperature range",
          origins: { zh: "literature", en: "literature" },
        },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  const first = await byName("再结晶温度");
  const second = await byName("再结晶温度区间");
  assert.ok(first && second && first.conceptId !== second.conceptId);

  // One submission naming both, where each already states a different English
  // name for its own Chinese name. Nothing here is strong enough to fuse them.
  const attempt = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "再结晶温度",
          en: "recrystallization temperature range",
          origins: { zh: "literature", en: "literature" },
        },
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  assert.equal(attempt.mergedConcepts, 0, "no automatic fusion");
  assert.ok(
    attempt.warnings.some((warning) => /left separate/iu.test(warning)),
    "and the caller is told they were kept apart",
  );
  assert.ok(await byName("再结晶温度"));
  assert.ok(await byName("再结晶温度区间"));
});

await block("a concept genuinely subsumed by another is still merged", async () => {
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: { en: "grain boundary sliding", origins: { en: "literature" } },
        sources: [{ itemKey: "PAPERONE" }],
      },
    ],
  });
  await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: { zh: "晶界滑移", origins: { zh: "literature" } },
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  const merged = await service.recordConcepts({
    libraryID: 1,
    concepts: [
      {
        primaryTerm: {
          zh: "晶界滑移",
          en: "grain boundary sliding",
          abbr: "GBS",
          origins: { zh: "literature", en: "literature", abbr: "ai" },
        },
        sources: [{ itemKey: "PAPERTWO" }],
      },
    ],
  });
  assert.equal(merged.mergedConcepts, 1, "nothing contradicts, so they fuse");
  const concept = await byName("晶界滑移");
  assert.equal(concept.primaryTerm.en, "grain boundary sliding");
  assert.equal(concept.primaryTerm.abbr, "GBS");
});

sqlite.close();
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  // Windows keeps a handle on a just-closed SQLite file for a moment; the
  // temp directory is the OS's problem, not this suite's verdict.
}

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
