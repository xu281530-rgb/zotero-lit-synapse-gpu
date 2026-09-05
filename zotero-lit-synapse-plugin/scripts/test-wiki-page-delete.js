/* eslint-env node */

/**
 * Deleting one Wiki knowledge entry, end to end.
 *
 * A page is not one row. It owns claims, those claims own evidence, embeddings
 * and queued embedding work, and - when no other page shares it - a concept
 * that in turn owns aliases and relations. `wiki_aliases` and `wiki_relations`
 * hang off `wiki_concepts` rather than off `wiki_pages`, which is the trap
 * this suite exists for: a delete that follows the concept blindly strips
 * another knowledge entry of its terminology, and a delete that ignores it
 * leaves orphan rows behind for ever.
 *
 * So these tests pin five things:
 *   1. a full page - claims, evidence, alias, relation, embedding, queue entry
 *      - leaves nothing behind anywhere, and stays gone across a reopen of the
 *      database file (the "restart Zotero" case);
 *   2. every other page in the library survives untouched;
 *   3. a shared concept is kept, with its aliases and relations intact;
 *   4. rows that belong to some other id - including pre-existing debris - are
 *      left exactly as they were, because a delete is not a repair tool;
 *   5. a database fault at any step rolls the whole delete back, leaving no
 *      half-deleted state.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { parseQueryAndParams } = await import("./zotero-db-params.mjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-delete-"));

globalThis.PathUtils = { join: (...parts) => parts.join("/") };
globalThis.Zotero = {
  Libraries: { userLibraryID: 1 },
  DataDirectory: { dir: tempDir },
  logError: () => undefined,
};
globalThis.ztoolkit = { log: () => undefined };

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiRetriever } = await import("../src/modules/wiki/wikiRetriever.ts");
const { hashWikiText } = await import(
  "../src/modules/wiki/wikiCanonicalizer.ts"
);

/**
 * A Wiki database adapter over node:sqlite.
 *
 * `failOn` makes one statement throw, which is how the rollback case simulates
 * a fault partway through the delete. Everything else goes through Zotero's
 * real parameter rules, so a statement that would throw inside Zotero throws
 * here too.
 */
function adapt(sqlite, failOn) {
  let depth = 0;
  const normalize = (params) =>
    params.map((value) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
  return {
    async queryAsync(rawSql, rawParams = []) {
      if (failOn && failOn.test(rawSql)) {
        throw new Error("simulated Wiki database fault");
      }
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
      if (failOn && failOn.test(rawSql)) {
        throw new Error("simulated Wiki database fault");
      }
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

const count = (sqlite, sql, ...params) =>
  Number(Object.values(sqlite.prepare(sql).get(...params))[0]);

/** Every persistent Wiki table, counted. The shape a rollback must restore. */
function census(sqlite) {
  const totals = {};
  for (const table of [
    "wiki_pages",
    "wiki_claims",
    "wiki_evidence",
    "wiki_claim_embeddings",
    "wiki_embedding_queue",
    "wiki_concepts",
    "wiki_aliases",
    "wiki_relations",
  ]) {
    totals[table] = count(sqlite, `SELECT COUNT(*) FROM ${table}`);
  }
  return totals;
}

/**
 * Two knowledge entries, wired to each other.
 *
 * "定向凝固" carries the full structure a delete has to unwind: a concept with
 * two aliases, two claims, three evidence records across two documents, a
 * claim embedding, a queued embedding, and a relation to the second page's
 * concept. "快速热压" is the bystander - it must come through untouched apart
 * from losing the relation whose other end no longer exists.
 */
async function seed(sqlite) {
  const store = new WikiStore(adapt(sqlite));
  await store.initialize();
  const evidence = async (itemKey, chunkId, excerpt, role, depth) => ({
    libraryID: 1,
    itemKey,
    chunkIdSnapshot: chunkId,
    chunkTextHash: await hashWikiText(`chunk-${itemKey}-${chunkId}`),
    sourceContentHash: `content-${itemKey}`,
    sourceChunkSignature: `paragraph-v3:${chunkId}:2`,
    sourceResetGeneration: "reset-1",
    excerpt,
    evidenceRole: role,
    readDepth: depth,
  });
  const result = await store.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "CREATE_PAGE",
        ref: "page:ds",
        canonicalTitle: "定向凝固控制柱状晶",
        primaryConceptRef: "concept:ds",
        primaryConcept: {
          canonicalName: "定向凝固",
          aliases: [
            { alias: "DS", language: "en" },
            { alias: "Directional Solidification", language: "en" },
          ],
        },
      },
      {
        action: "CREATE_PAGE",
        ref: "page:hot",
        canonicalTitle: "快速热压定型",
        primaryConceptRef: "concept:hot",
        primaryConcept: { canonicalName: "快速热压" },
      },
      {
        action: "ADD_CLAIM",
        pageId: "page:ds",
        ref: "claim:ds1",
        claimText: "抽拉速率越低，柱状晶带越宽。",
        claimType: "mechanism",
        epistemicStatus: "provisional",
        coverageLevel: "chunk_local",
        confidence: 0.6,
        evidence: [
          await evidence(
            "ITEMDS001",
            1,
            "抽拉速率降低后柱状晶带展宽。",
            "SUPPORTS",
            "chunk_local",
          ),
          await evidence(
            "ITEMDS002",
            2,
            "同一体系下观察到相同趋势。",
            "SUPPORTS",
            "section_read",
          ),
        ],
      },
      {
        action: "ADD_CLAIM",
        pageId: "page:ds",
        ref: "claim:ds2",
        claimText: "温度梯度决定固液界面形态。",
        claimType: "definition",
        epistemicStatus: "provisional",
        coverageLevel: "chunk_local",
        confidence: 0.5,
        evidence: [
          await evidence(
            "ITEMDS001",
            3,
            "界面形态随温度梯度变化。",
            "QUALIFIES",
            "chunk_local",
          ),
        ],
      },
      {
        action: "ADD_CLAIM",
        pageId: "page:hot",
        ref: "claim:hot1",
        claimText: "保压时间决定残余应力水平。",
        claimType: "condition",
        epistemicStatus: "provisional",
        coverageLevel: "chunk_local",
        confidence: 0.7,
        evidence: [
          await evidence(
            "ITEMHOT001",
            1,
            "保压 30 分钟后残余应力下降。",
            "SUPPORTS",
            "chunk_local",
          ),
        ],
      },
      {
        action: "LINK_RELATION",
        sourceConceptId: "concept:ds",
        predicate: "先于",
        targetConceptId: "concept:hot",
        confidence: 0.8,
      },
    ],
  });
  return { store, refs: result.refs };
}

/** Resolve the concept ref names `commit` assigns, which vary by action. */
function conceptIdOf(sqlite, name) {
  const row = sqlite
    .prepare("SELECT concept_id FROM wiki_concepts WHERE canonical_name = ?")
    .get(name);
  return row ? Number(row.concept_id) : null;
}

function pageIdOf(sqlite, title) {
  const row = sqlite
    .prepare("SELECT page_id FROM wiki_pages WHERE canonical_title = ?")
    .get(title);
  return row ? Number(row.page_id) : null;
}

// ==========================================================================
// 1. A full page leaves nothing behind, and stays gone across a restart
// ==========================================================================

const dbPath = path.join(tempDir, "delete.sqlite");
{
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON");
  const { store } = await seed(sqlite);

  const dsPage = pageIdOf(sqlite, "定向凝固控制柱状晶");
  const hotPage = pageIdOf(sqlite, "快速热压定型");
  const dsConcept = conceptIdOf(sqlite, "定向凝固");

  // A claim embedding, so the vector index has something to lose too. The
  // queue rows are already there: `commit` enqueues every claim it writes.
  const dsClaims = sqlite
    .prepare("SELECT claim_id, claim_text FROM wiki_claims WHERE page_id = ?")
    .all(dsPage);
  assert.equal(dsClaims.length, 2, "the page under test must own two claims");
  await store.saveClaimEmbedding({
    claimId: Number(dsClaims[0].claim_id),
    vector: Float32Array.from([0.1, 0.2, 0.3, 0.4]),
    model: "test-model",
    textHash: await hashWikiText(String(dsClaims[0].claim_text)),
  });
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_claim_embeddings"),
    1,
    "the embedding must exist before the delete",
  );
  assert.ok(
    count(sqlite, "SELECT COUNT(*) FROM wiki_embedding_queue") >= 3,
    "every committed claim must be queued for embedding before the delete",
  );
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_aliases WHERE concept_id = ?", dsConcept),
    2,
    "the concept must carry both aliases before the delete",
  );
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_relations"),
    1,
    "the two concepts must be related before the delete",
  );

  // --- The preview must describe the delete that will actually run ---------
  const preview = await store.describePageDeletion(dsPage, 1);
  assert.equal(preview.canonicalTitle, "定向凝固控制柱状晶");
  assert.equal(preview.claims, 2, "the preview must count the page's claims");
  assert.equal(preview.evidence, 3, "the preview must count every evidence row");
  assert.equal(preview.concepts, 1, "the unshared concept is in scope");
  assert.equal(preview.aliases, 2);
  assert.equal(preview.relations, 1);
  assert.equal(preview.claimEmbeddings, 1);
  assert.equal(preview.queuedEmbeddings, 2);
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_pages"),
    2,
    "describing a deletion must not delete anything",
  );

  // --- The delete itself ---------------------------------------------------
  const removed = await store.deletePage(dsPage, 1);
  assert.deepEqual(
    {
      claims: removed.claims,
      evidence: removed.evidence,
      concepts: removed.concepts,
      aliases: removed.aliases,
      relations: removed.relations,
    },
    { claims: 2, evidence: 3, concepts: 1, aliases: 2, relations: 1 },
    "the report must match what the preview promised",
  );

  // --- Nothing anywhere may still refer to the page -----------------------
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_pages WHERE page_id = ?", dsPage),
    0,
    "the page row must be gone",
  );
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_claims WHERE page_id = ?", dsPage),
    0,
    "its claims must be gone",
  );
  for (const claim of dsClaims) {
    const claimId = Number(claim.claim_id);
    for (const table of [
      "wiki_claims",
      "wiki_evidence",
      "wiki_claim_embeddings",
      "wiki_embedding_queue",
    ]) {
      assert.equal(
        count(sqlite, `SELECT COUNT(*) FROM ${table} WHERE claim_id = ?`, claimId),
        0,
        `${table} must keep no row for deleted claim ${claimId}`,
      );
    }
  }
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_concepts WHERE concept_id = ?", dsConcept),
    0,
    "the unshared concept must be gone",
  );
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_aliases WHERE concept_id = ?", dsConcept),
    0,
    "its aliases must be gone",
  );
  assert.equal(
    count(
      sqlite,
      "SELECT COUNT(*) FROM wiki_relations WHERE source_concept_id = ? OR target_concept_id = ?",
      dsConcept,
      dsConcept,
    ),
    0,
    "every relation ending on it must be gone",
  );

  // --- The delete must not CREATE orphans of its own ----------------------
  // Note what this does not say: nothing here claims the database holds no
  // orphans at all. Pre-existing debris is none of this operation's business,
  // and the bystander test below pins that it is left strictly alone.
  for (const [table, predicate] of [
    ["wiki_claims", "page_id NOT IN (SELECT page_id FROM wiki_pages)"],
    ["wiki_evidence", "claim_id NOT IN (SELECT claim_id FROM wiki_claims)"],
    [
      "wiki_claim_embeddings",
      "claim_id NOT IN (SELECT claim_id FROM wiki_claims)",
    ],
    [
      "wiki_embedding_queue",
      "claim_id NOT IN (SELECT claim_id FROM wiki_claims)",
    ],
    ["wiki_aliases", "concept_id NOT IN (SELECT concept_id FROM wiki_concepts)"],
    [
      "wiki_relations",
      "source_concept_id NOT IN (SELECT concept_id FROM wiki_concepts) OR target_concept_id NOT IN (SELECT concept_id FROM wiki_concepts)",
    ],
  ]) {
    assert.equal(
      count(sqlite, `SELECT COUNT(*) FROM ${table} WHERE ${predicate}`),
      0,
      `${table} must gain no orphan rows from the delete`,
    );
  }

  // --- Retrieval must not be able to find it any more ----------------------
  const retriever = new WikiRetriever(store);
  const hits = await retriever.search({
    libraryID: 1,
    query: "抽拉速率 柱状晶 定向凝固 温度梯度",
    limit: 50,
  });
  assert.equal(
    hits.claims.filter((claim) => claim.pageId === dsPage).length,
    0,
    "retrieval must return no claim of the deleted page",
  );
  assert.equal(
    hits.documents.filter((doc) =>
      String(doc.itemKey).startsWith("ITEMDS"),
    ).length,
    0,
    "retrieval must not surface documents that only the deleted page cited",
  );
  assert.deepEqual(
    (await store.listPages(1)).map((page) => page.pageId),
    [hotPage],
    "the index must list only the surviving page",
  );
  assert.equal(await store.getPage(dsPage), null);

  // --- The bystander page must be intact ----------------------------------
  const survivor = await store.getPage(hotPage);
  assert.equal(survivor.canonicalTitle, "快速热压定型");
  assert.equal(
    survivor.claims.length,
    1,
    "the other knowledge entry must keep its claim",
  );
  assert.equal(
    survivor.claims[0].evidence.length,
    1,
    "and its evidence",
  );
  assert.ok(
    conceptIdOf(sqlite, "快速热压"),
    "and its concept, which was the other end of the deleted relation",
  );
  assert.doesNotMatch(
    survivor.summary,
    /定向凝固/u,
    "its summary must not quote a relation that no longer exists",
  );
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_embedding_queue"),
    1,
    "only the surviving page's claim may still be queued for embedding",
  );

  // --- The counters the panel and wiki_status read -------------------------
  const status = await store.getStatus(1);
  assert.equal(status.pages, 1);
  assert.equal(status.claims, 1);
  assert.equal(status.evidence, 1);

  sqlite.close();
}

// --- Restarting Zotero must not bring it back ------------------------------
{
  // A fresh connection over the same file is what a restart looks like from
  // the store's side: no in-memory state survives, only what was committed.
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON");
  const store = new WikiStore(adapt(sqlite));
  await store.initialize();
  const pages = await store.listPages(1);
  assert.deepEqual(
    pages.map((page) => page.canonicalTitle),
    ["快速热压定型"],
    "after a restart the deleted entry must still be gone",
  );
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_concepts WHERE canonical_name = ?", "定向凝固"),
    0,
    "and so must its concept",
  );
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_evidence"),
    1,
    "and so must its evidence",
  );
  sqlite.close();
}

// ==========================================================================
// 2. A concept another page still uses is left alone
// ==========================================================================

{
  const sqlite = new DatabaseSync(path.join(tempDir, "shared.sqlite"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  const { store } = await seed(sqlite);
  const dsPage = pageIdOf(sqlite, "定向凝固控制柱状晶");
  const dsConcept = conceptIdOf(sqlite, "定向凝固");

  // A second page on the same concept. Pages are unique by title, not by
  // concept, so this is a state the store can genuinely reach.
  sqlite
    .prepare(
      `INSERT INTO wiki_pages
       (library_id, canonical_title, normalized_title, summary,
        primary_concept_id, status, created_at, updated_at, version)
       VALUES (1, '定向凝固工艺窗口', '定向凝固工艺窗口', '', ?, 'active', ?, ?, 1)`,
    )
    .run(dsConcept, Date.now(), Date.now());

  const preview = await store.describePageDeletion(dsPage, 1);
  assert.equal(
    preview.concepts,
    0,
    "a concept another page uses must not be in scope",
  );
  assert.equal(preview.aliases, 0, "nor its aliases");
  assert.equal(preview.relations, 0, "nor the relations that end on it");

  await store.deletePage(dsPage, 1);

  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_concepts WHERE concept_id = ?", dsConcept),
    1,
    "the shared concept must survive",
  );
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_aliases WHERE concept_id = ?", dsConcept),
    2,
    "with both of its aliases",
  );
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_relations"),
    1,
    "and with the relation the other page still depends on",
  );
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_pages"),
    2,
    "only the requested page may be removed",
  );
  assert.equal(
    count(
      sqlite,
      "SELECT COUNT(*) FROM wiki_pages WHERE canonical_title = ? AND primary_concept_id = ?",
      "定向凝固工艺窗口",
      dsConcept,
    ),
    1,
    "the page that shares the concept must still be bound to it",
  );
  sqlite.close();
}

// ==========================================================================
// 3. Rows that belong to nothing are none of this delete's business
// ==========================================================================

/**
 * Deleting one entry must not rewrite unrelated history.
 *
 * An earlier version of `deletePage` ran a database-wide orphan sweep inside
 * its transaction, on the theory that debris is debris. The effect was that
 * deleting entry A silently destroyed rows that had nothing to do with A -
 * including evidence parked in `pending_relink` waiting for an index rebuild,
 * and queue entries mid-flight. The scope of the operation stopped being
 * predictable from what the user asked for, and the destruction was invisible.
 *
 * So this seeds debris that is provably unrelated to the page being deleted -
 * every row points at an id that does not exist and never did - and requires
 * every last one of it to survive. Repairing such rows is a maintenance action
 * a user invokes deliberately; it is not a side effect of a delete.
 */
{
  const sqlite = new DatabaseSync(path.join(tempDir, "bystander.sqlite"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  const { store } = await seed(sqlite);
  const dsPage = pageIdOf(sqlite, "定向凝固控制柱状晶");

  // Written with foreign keys off, which is exactly how a build that never ran
  // the pragma - or a half-finished restore - leaves rows like these behind.
  sqlite.exec("PRAGMA foreign_keys = OFF");
  sqlite
    .prepare(
      `INSERT INTO wiki_evidence
       (claim_id, library_id, item_key, chunk_id_snapshot, chunk_text_hash,
        source_content_hash, source_chunk_signature, source_reset_generation,
        excerpt_hash, excerpt, evidence_role, read_depth, link_state, created_at)
       VALUES (99901, 1, 'GHOSTITEM', 1, 'h', 'h', 's', 'r', 'eh',
               '等待重建索引后重连的证据', 'SUPPORTS', 'chunk_local',
               'pending_relink', ?)`,
    )
    .run(Date.now());
  sqlite
    .prepare(
      `INSERT INTO wiki_claim_embeddings
       (claim_id, embedding, dimensions, model, text_hash, updated_at)
       VALUES (99902, ?, 4, 'ghost-model', 'h', ?)`,
    )
    .run(new Uint8Array(16), Date.now());
  sqlite
    .prepare(
      `INSERT INTO wiki_embedding_queue
       (claim_id, text_hash, attempts, last_error, enqueued_at, next_attempt_at)
       VALUES (99903, 'h', 0, '', ?, ?)`,
    )
    .run(Date.now(), Date.now());
  sqlite
    .prepare(
      `INSERT INTO wiki_claims
       (claim_id, page_id, claim_text, normalized_claim_text, claim_type,
        epistemic_status, coverage_level, confidence, created_at, updated_at, version)
       VALUES (99904, 99900, '孤儿论断', '孤儿论断', 'mechanism', 'provisional',
               'chunk_local', 0.5, ?, ?, 1)`,
    )
    .run(Date.now(), Date.now());
  sqlite
    .prepare(
      `INSERT INTO wiki_aliases
       (concept_id, alias, normalized_alias, language, source, confidence)
       VALUES (99905, '孤儿别名', '孤儿别名', 'und', 'ai', 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO wiki_relations
       (source_concept_id, predicate, normalized_predicate, target_concept_id,
        confidence, created_at)
       VALUES (99906, '孤儿关系', '孤儿关系', 99907, 0.5, ?)`,
    )
    .run(Date.now());
  sqlite.exec("PRAGMA foreign_keys = ON");

  /** The debris, counted one row at a time so a survivor is identifiable. */
  const debris = () => ({
    evidence: count(
      sqlite,
      "SELECT COUNT(*) FROM wiki_evidence WHERE claim_id = 99901",
    ),
    embedding: count(
      sqlite,
      "SELECT COUNT(*) FROM wiki_claim_embeddings WHERE claim_id = 99902",
    ),
    queued: count(
      sqlite,
      "SELECT COUNT(*) FROM wiki_embedding_queue WHERE claim_id = 99903",
    ),
    claim: count(
      sqlite,
      "SELECT COUNT(*) FROM wiki_claims WHERE claim_id = 99904",
    ),
    alias: count(
      sqlite,
      "SELECT COUNT(*) FROM wiki_aliases WHERE concept_id = 99905",
    ),
    relation: count(
      sqlite,
      "SELECT COUNT(*) FROM wiki_relations WHERE source_concept_id = 99906",
    ),
  });
  const before = debris();
  assert.deepEqual(
    before,
    {
      evidence: 1,
      embedding: 1,
      queued: 1,
      claim: 1,
      alias: 1,
      relation: 1,
    },
    "the unrelated debris must be in place before the delete",
  );

  const removed = await store.deletePage(dsPage, 1);
  assert.equal(removed.pageId, dsPage, "the requested page must be deleted");
  assert.equal(
    count(sqlite, "SELECT COUNT(*) FROM wiki_pages WHERE page_id = ?", dsPage),
    0,
    "the requested page must really be gone",
  );

  assert.deepEqual(
    debris(),
    before,
    "deleting one entry must not touch rows that belong to another id",
  );
  // The pending_relink row is called out on its own: it is the one that looks
  // most like debris and is most likely to be real work in progress.
  assert.equal(
    count(
      sqlite,
      "SELECT COUNT(*) FROM wiki_evidence WHERE claim_id = 99901 AND link_state = 'pending_relink'",
    ),
    1,
    "evidence waiting to be relinked must survive an unrelated page delete",
  );
  sqlite.close();
}

// ==========================================================================
// 4. A fault partway through rolls the whole delete back
// ==========================================================================

/**
 * Each of these is a statement the delete issues, in order. Failing at each in
 * turn is what proves there is no step after which the page is partly gone:
 * the census before and after must be identical every time.
 */
const faults = [
  [/DELETE FROM wiki_embedding_queue/u, "the embedding queue"],
  [/DELETE FROM wiki_claim_embeddings/u, "the claim embeddings"],
  [/DELETE FROM wiki_evidence/u, "the evidence"],
  [/DELETE FROM wiki_claims/u, "the claims"],
  [/DELETE FROM wiki_pages/u, "the page row"],
  [/DELETE FROM wiki_relations/u, "the relations"],
  [/DELETE FROM wiki_aliases/u, "the aliases"],
  [/DELETE FROM wiki_concepts/u, "the concept"],
  [/UPDATE wiki_pages SET summary/u, "the neighbour summary refresh"],
];

for (const [index, [failOn, what]] of faults.entries()) {
  const sqlite = new DatabaseSync(
    path.join(tempDir, `rollback-${index}.sqlite`),
  );
  sqlite.exec("PRAGMA foreign_keys = ON");
  await seed(sqlite);
  const dsPage = pageIdOf(sqlite, "定向凝固控制柱状晶");
  const before = census(sqlite);

  // A second store over a connection that fails the chosen statement.
  const failing = new WikiStore(adapt(sqlite, failOn));
  await failing.initialize();
  await assert.rejects(
    () => failing.deletePage(dsPage, 1),
    /simulated Wiki database fault/u,
    `a fault while deleting ${what} must reject`,
  );

  assert.deepEqual(
    census(sqlite),
    before,
    `a fault while deleting ${what} must roll the whole delete back`,
  );
  // Not merely the same totals - the same page, still readable in full.
  const store = new WikiStore(adapt(sqlite));
  await store.initialize();
  const page = await store.getPage(dsPage);
  assert.ok(page, `${what}: the page must still exist after the rollback`);
  assert.equal(
    page.claims.length,
    2,
    `${what}: its claims must still be there`,
  );
  assert.equal(
    page.claims.reduce((total, claim) => total + claim.evidence.length, 0),
    3,
    `${what}: its evidence must still be there`,
  );
  sqlite.close();
}

// A verification failure must roll back too: a delete that cannot prove the
// page is gone is not allowed to commit a partial one.
{
  const sqlite = new DatabaseSync(path.join(tempDir, "residue.sqlite"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  await seed(sqlite);
  const dsPage = pageIdOf(sqlite, "定向凝固控制柱状晶");
  const before = census(sqlite);

  // A connection whose page delete quietly does nothing, standing in for any
  // storage fault that reports success without writing.
  const inner = adapt(sqlite);
  const silent = {
    ...inner,
    async queryAsync(sql, params) {
      if (/^\s*DELETE FROM wiki_pages\b/u.test(sql)) return [];
      return inner.queryAsync(sql, params);
    },
  };
  const store = new WikiStore(silent);
  await store.initialize();
  await assert.rejects(
    () => store.deletePage(dsPage, 1),
    /left referencing rows behind/u,
    "a delete that left the page row behind must refuse to commit",
  );
  assert.deepEqual(
    census(sqlite),
    before,
    "and it must leave the database exactly as it found it",
  );
  sqlite.close();
}

fs.rmSync(tempDir, { recursive: true, force: true });

console.log("wiki page delete tests passed");
