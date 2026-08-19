/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => undefined };

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { WikiEvidenceRelinker } = await import(
  "../src/modules/wiki/wikiEvidenceRelinker.ts"
);
const { hashWikiText } = await import(
  "../src/modules/wiki/wikiCanonicalizer.ts"
);

function adapt(sqlite) {
  let depth = 0;
  const normalize = (params) =>
    params.map((value) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
  return {
    async queryAsync(sql, params = []) {
      const statement = sqlite.prepare(sql);
      const values = normalize(params);
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) {
        return statement.all(...values);
      }
      statement.run(...values);
      return [];
    },
    async valueQueryAsync(sql, params = []) {
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-store-"));
const dbPath = path.join(tempDir, "zotero-mcp-wiki.sqlite");
let sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");
let store = new WikiStore(adapt(sqlite));
await store.initialize();

const expectedTables = [
  "wiki_aliases",
  "wiki_claim_embeddings",
  "wiki_claims",
  "wiki_concepts",
  "wiki_evidence",
  "wiki_pages",
  "wiki_relations",
];
const tables = sqlite
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wiki_%' ORDER BY name",
  )
  .all()
  .map((row) => row.name);
for (const table of expectedTables) {
  assert.ok(tables.includes(table), `schema should contain ${table}`);
}

const chunkText =
  "Rapid cooling refines the primary phase, but the effect weakens above the transition temperature.";
const chunkTextHash = await hashWikiText(chunkText);
const excerpt = "the effect weakens above the transition temperature";

const commit = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "CREATE_PAGE",
      ref: "page:cooling",
      primaryConceptRef: "concept:cooling",
      canonicalTitle: "Cooling-rate effects",
      summary: "Derived from claims and evidence.",
      primaryConcept: {
        canonicalName: "cooling rate",
        conceptType: "process_parameter",
        aliases: [
          { alias: "冷却速率", language: "zh", source: "ai", confidence: 0.96 },
          {
            alias: "cooling rate",
            language: "en",
            source: "canonical",
            confidence: 1,
          },
        ],
      },
    },
    {
      action: "ADD_CLAIM",
      pageId: "page:cooling",
      ref: "claim:boundary",
      claimText:
        "Cooling-rate refinement becomes weaker above the transition temperature.",
      claimType: "condition",
      epistemicStatus: "provisional",
      coverageLevel: "chunk_local",
      confidence: 0.72,
      evidence: [
        {
          libraryID: 1,
          itemKey: "ITEMA001",
          chunkIdSnapshot: 3,
          chunkTextHash,
          sourceContentHash: "content-v1",
          sourceChunkSignature: "paragraph-v3:1000:500",
          sourceResetGeneration: "reset-17",
          excerpt,
          evidenceRole: "SUPPORTS",
          readDepth: "chunk_local",
        },
      ],
    },
  ],
});

assert.equal(commit.createdPages, 1);
assert.equal(commit.createdClaims, 1);
assert.equal(commit.attachedEvidence, 1);
assert.ok(commit.refs["page:cooling"] > 0);
assert.ok(commit.refs["claim:boundary"] > 0);
assert.ok(commit.refs["concept:cooling"] > 0);

await assert.rejects(
  () =>
    store.commit({
      libraryID: 1,
      userInitiated: true,
      actions: [
        {
          action: "CREATE_PAGE",
          ref: "duplicate:ref",
          canonicalTitle: "Duplicate ref transaction",
        },
        {
          action: "ADD_CLAIM",
          ref: "duplicate:ref",
          pageId: "duplicate:ref",
          claimText: "A duplicate ref must not silently change its target.",
          claimType: "limitation",
          epistemicStatus: "provisional",
          coverageLevel: "chunk_local",
          confidence: 0.5,
          evidence: [],
        },
      ],
    }),
  /Duplicate Wiki commit ref/iu,
  "every controlled action must reject a ref already assigned in the commit",
);
assert.equal(
  Number(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM wiki_pages WHERE normalized_title = ?",
      )
      .get("duplicate ref transaction").count,
  ),
  0,
  "a duplicate ref must roll back the whole Wiki transaction",
);

const terminology = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "CREATE_PAGE",
      ref: "page:terminology",
      primaryConceptRef: "concept:terminology",
      canonicalTitle: "Terminology collision topic",
      primaryConcept: {
        canonicalName: "thermal boundary",
        aliases: [{ alias: "heat boundary", language: "en" }],
      },
    },
  ],
});
await assert.rejects(
  () =>
    store.updateConcept({
      libraryID: 1,
      conceptId: commit.refs["concept:cooling"],
      canonicalName: "heat boundary",
    }),
  /another Concept/iu,
  "a canonical rename must not take another Concept's alias",
);
await assert.rejects(
  () =>
    store.updateConcept({
      libraryID: 1,
      conceptId: commit.refs["concept:cooling"],
      addAliases: [{ alias: "thermal boundary", language: "en" }],
    }),
  /another Concept/iu,
  "a user alias must not take another Concept's canonical name",
);
assert.ok(terminology.refs["concept:terminology"] > 0);

await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "LINK_RELATION",
      sourceConceptId: commit.refs["concept:cooling"],
      predicate: "is bounded by",
      targetConceptId: terminology.refs["concept:terminology"],
      confidence: 0.8,
    },
  ],
});
await store.updateConcept({
  libraryID: 1,
  conceptId: commit.refs["concept:cooling"],
  canonicalName: "cooling rate response",
});
assert.match(
  (await store.getPage(terminology.refs["page:terminology"]))?.summary ?? "",
  /cooling rate response is bounded by thermal boundary/u,
  "canonical terminology edits must refresh every derived Relation summary",
);
assert.doesNotMatch(
  (await store.getPage(terminology.refs["page:terminology"]))?.summary ?? "",
  /Relations: cooling rate is bounded by/u,
);

const page = await store.getPage(commit.refs["page:cooling"]);
assert.equal(page?.canonicalTitle, "Cooling-rate effects");
assert.equal(page?.claims.length, 1);
assert.equal(page?.claims[0].evidence[0].linkState, "valid");
assert.equal(page?.claims[0].coverageLevel, "chunk_local");
assert.match(page?.summary ?? "", /Cooling-rate refinement/u);
assert.doesNotMatch(
  page?.summary ?? "",
  /Derived from claims and evidence/u,
  "Page Summary must be derived from authoritative Claims, not accepted as free AI text",
);

await assert.rejects(
  () =>
    store.commit({
      libraryID: 1,
      userInitiated: true,
      actions: [
        {
          action: "ADD_CLAIM",
          pageId: commit.refs["page:cooling"],
          claimText: "Local evidence cannot establish whole-paper coverage.",
          claimType: "limitation",
          epistemicStatus: "provisional",
          coverageLevel: "paper_reviewed",
          confidence: 0.4,
          evidence: [
            {
              libraryID: 1,
              itemKey: "ITEMA002",
              chunkIdSnapshot: 0,
              chunkTextHash,
              sourceContentHash: "content-v1",
              sourceChunkSignature: "paragraph-v3:1000:500",
              sourceResetGeneration: "reset-17",
              excerpt: "Local evidence cannot establish whole-paper coverage.",
              evidenceRole: "SUPPORTS",
              readDepth: "chunk_local",
            },
          ],
        },
      ],
    }),
  /coverageLevel.*read_depth/iu,
  "Claim coverage cannot exceed the Evidence read_depth submitted for it",
);

await assert.rejects(
  () =>
    store.commit({
      libraryID: 1,
      userInitiated: true,
      actions: [
        {
          action: "UPDATE_CLAIM",
          claimId: commit.refs["claim:boundary"],
          expectedVersion: page.claims[0].version,
          coverageLevel: "paper_reviewed",
          epistemicStatus: "corroborated",
        },
      ],
    }),
  /requires the Evidence used for this promotion/iu,
  "coverage or epistemic promotion must explicitly resubmit the Evidence used",
);

const promotedCoverage = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "UPDATE_CLAIM",
      claimId: commit.refs["claim:boundary"],
      expectedVersion: page.claims[0].version,
      coverageLevel: "paper_reviewed",
      evidence: [
        {
          libraryID: 1,
          itemKey: "ITEMA001",
          chunkIdSnapshot: 3,
          chunkTextHash,
          sourceContentHash: "content-v1",
          sourceChunkSignature: "paragraph-v3:1000:500",
          sourceResetGeneration: "reset-17",
          excerpt,
          evidenceRole: "SUPPORTS",
          readDepth: "paper_reviewed",
        },
      ],
    },
  ],
});
assert.equal(promotedCoverage.updatedClaims, 1);
assert.equal(
  (await store.getClaim(commit.refs["claim:boundary"]))?.evidence[0].readDepth,
  "paper_reviewed",
  "resubmitting duplicate Evidence at a deeper read_depth must update its authoritative record",
);

await assert.rejects(
  () =>
    store.commit({
      libraryID: 1,
      userInitiated: true,
      actions: [
        {
          action: "UPDATE_CLAIM",
          claimId: commit.refs["claim:boundary"],
          expectedVersion: page.claims[0].version + 1,
          coverageLevel: "cross_paper",
          evidence: [
            {
              libraryID: 1,
              itemKey: "ITEMA001",
              chunkIdSnapshot: 3,
              chunkTextHash,
              sourceContentHash: "content-v1",
              sourceChunkSignature: "paragraph-v3:1000:500",
              sourceResetGeneration: "reset-17",
              excerpt,
              evidenceRole: "SUPPORTS",
              readDepth: "cross_paper",
            },
          ],
        },
      ],
    }),
  /at least 2 distinct itemKey/iu,
  "cross_paper coverage requires Evidence from at least two documents",
);

const service = new WikiService(store);
await assert.rejects(
  () =>
    service.commit({
      libraryID: 1,
      userInitiated: true,
      actions: [{ action: "CREATE_PAGE", canonicalTitle: "Unprepared topic" }],
    }),
  /requires a current wiki_prepare_update token/iu,
  "the MCP-facing service must enforce prepare-before-create",
);
const preparedCreate = await service.prepareUpdate({
  libraryID: 1,
  query: "Prepared topic",
});
await assert.rejects(
  () =>
    service.commit({
      libraryID: 1,
      userInitiated: true,
      prepareToken: preparedCreate.prepareToken,
      actions: [
        { action: "CREATE_PAGE", canonicalTitle: "Unsearched other topic" },
      ],
    }),
  /prepared Page title/iu,
  "a prepare token must not authorize a different, unsearched Page title",
);
const preparedCommit = await service.commit({
  libraryID: 1,
  userInitiated: true,
  prepareToken: preparedCreate.prepareToken,
  actions: [{ action: "CREATE_PAGE", canonicalTitle: "Prepared topic" }],
});
assert.equal(preparedCommit.createdPages, 1);
const expiringPrepare = await service.prepareUpdate({
  libraryID: 1,
  query: "Expired preparation",
});
service.prepareTokens.get(expiringPrepare.prepareToken).expiresAt = 0;
await service.prepareUpdate({ libraryID: 1, query: "Fresh preparation" });
assert.equal(
  service.prepareTokens.has(expiringPrepare.prepareToken),
  false,
  "expired prepare tokens must be pruned during normal service use",
);

await store.markItemsPending("item-build-1", 1, ["NOT_THIS_ITEM"]);
assert.equal(
  (await store.getClaim(commit.refs["claim:boundary"]))?.evidence[0].linkState,
  "valid",
  "an item rebuild must not invalidate Evidence from other documents",
);
await store.markItemsPending("item-build-2", 1, ["ITEMA001"]);
assert.equal(
  (await store.getClaim(commit.refs["claim:boundary"]))?.evidence[0].linkState,
  "pending_relink",
  "an item rebuild must invalidate only that document's Evidence binding",
);

const restoreBeforeReset = new WikiEvidenceRelinker(store, {
  async getChunks() {
    return [
      {
        chunkId: 3,
        text: chunkText,
        contentHash: "content-v1",
        chunkSignature: "paragraph-v3:1000:500",
        resetGeneration: "item-build-2",
      },
    ];
  },
  async sourceExists() {
    return true;
  },
});
await restoreBeforeReset.relinkPending({ libraryID: 1 });

await assert.rejects(
  () =>
    store.commit({
      libraryID: 1,
      userInitiated: true,
      actions: [
        {
          action: "CREATE_PAGE",
          canonicalTitle: " cooling-rate effects ",
        },
      ],
    }),
  /already exists/iu,
  "canonicalized duplicate pages must be rejected",
);

await assert.rejects(
  () =>
    store.commit({
      libraryID: 1,
      userInitiated: true,
      actions: [
        {
          action: "CREATE_PAGE",
          canonicalTitle: "冷却速率",
        },
      ],
    }),
  /matches existing Concept, Alias, or Claim/iu,
  "a known alias must not fragment into a second Wiki Page",
);

await assert.rejects(
  () =>
    store.commit({
      libraryID: 1,
      userInitiated: true,
      actions: [
        {
          action: "CREATE_PAGE",
          canonicalTitle: "Thermal processing",
          primaryConcept: {
            canonicalName: "thermal processing",
            aliases: [{ alias: "冷却速率", language: "zh" }],
          },
        },
      ],
    }),
  /alias already resolves to another Concept/iu,
  "an alias may not ambiguously resolve to multiple Concepts",
);

await assert.rejects(
  () =>
    store.commit({
      libraryID: 1,
      userInitiated: true,
      actions: [
        { action: "CREATE_PAGE", ref: "p1", canonicalTitle: "A" },
        { action: "CREATE_PAGE", ref: "p2", canonicalTitle: "B" },
        { action: "CREATE_PAGE", ref: "p3", canonicalTitle: "C" },
      ],
    }),
  /at most 2/iu,
  "one commit may create no more than two pages",
);

await store.markResetPending("reset-18", 1);
let claim = await store.getClaim(commit.refs["claim:boundary"]);
assert.equal(claim?.evidence[0].linkState, "pending_relink");
assert.match(
  (await store.getPage(commit.refs["page:cooling"]))?.summary ?? "",
  /1 pending_relink/u,
  "derived Page Summary must track reset-induced Evidence state",
);
assert.equal(
  claim?.epistemicStatus,
  "provisional",
  "a search-index reset must not make a claim unsupported",
);

const exactRelinker = new WikiEvidenceRelinker(store, {
  async getChunks(libraryID, itemKey) {
    assert.equal(libraryID, 1);
    assert.equal(itemKey, "ITEMA001");
    return [
      {
        chunkId: 8,
        text: chunkText,
        contentHash: "content-v2",
        chunkSignature: "paragraph-v3:1000:500",
        resetGeneration: "reset-18",
      },
    ];
  },
  async sourceExists() {
    return true;
  },
});
const exactReport = await exactRelinker.relinkPending({ libraryID: 1 });
assert.deepEqual(exactReport, {
  checked: 1,
  relinked: 1,
  stale: 0,
  sourceDeleted: 0,
});
claim = await store.getClaim(commit.refs["claim:boundary"]);
assert.equal(claim?.evidence[0].chunkIdSnapshot, 8);
assert.equal(claim?.evidence[0].linkState, "valid");
assert.equal(claim?.evidence[0].sourceContentHash, "content-v2");
assert.match(
  (await store.getPage(commit.refs["page:cooling"]))?.summary ?? "",
  /1 valid/u,
  "derived Page Summary must refresh after Evidence relinking",
);

await store.markResetPending("reset-19", 1);
const movedText = `Context before. ${excerpt}. Additional context after.`;
const fuzzyRelinker = new WikiEvidenceRelinker(store, {
  async getChunks() {
    return [
      {
        chunkId: 11,
        text: movedText,
        contentHash: "content-v3",
        chunkSignature: "paragraph-v3:900:300",
        resetGeneration: "reset-19",
      },
    ];
  },
  async sourceExists() {
    return true;
  },
});
const fuzzyReport = await fuzzyRelinker.relinkPending({ libraryID: 1 });
assert.equal(
  fuzzyReport.relinked,
  1,
  "excerpt relocation should survive re-chunking",
);
claim = await store.getClaim(commit.refs["claim:boundary"]);
assert.equal(claim?.evidence[0].chunkIdSnapshot, 11);

await store.markSourceDeleted(1, "ITEMA001");
claim = await store.getClaim(commit.refs["claim:boundary"]);
assert.equal(claim?.evidence[0].linkState, "source_deleted");
assert.equal(
  claim?.epistemicStatus,
  "provisional",
  "deleting a Zotero source must not erase the historical Evidence or downgrade its Claim",
);

sqlite.close();
sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");
store = new WikiStore(adapt(sqlite));
await store.initialize();
assert.equal(
  (await store.getPage(commit.refs["page:cooling"]))?.claims.length,
  1,
  "Wiki data must survive closing and reopening its independent database",
);

const corroborated = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "CREATE_PAGE",
      ref: "page:historical",
      canonicalTitle: "Historical corroboration",
    },
    {
      action: "ADD_CLAIM",
      ref: "claim:historical",
      pageId: "page:historical",
      claimText: "Two independent papers corroborate the historical result.",
      claimType: "consensus",
      epistemicStatus: "corroborated",
      coverageLevel: "cross_paper",
      confidence: 0.95,
      evidence: [
        {
          libraryID: 1,
          itemKey: "HISTORY1",
          chunkIdSnapshot: 0,
          chunkTextHash,
          sourceContentHash: "history-content-1",
          sourceChunkSignature: "paragraph-v3:1000:500",
          sourceResetGeneration: "history-reset",
          excerpt: "First independent historical observation.",
          evidenceRole: "SUPPORTS",
          readDepth: "cross_paper",
        },
        {
          libraryID: 1,
          itemKey: "HISTORY2",
          chunkIdSnapshot: 0,
          chunkTextHash,
          sourceContentHash: "history-content-2",
          sourceChunkSignature: "paragraph-v3:1000:500",
          sourceResetGeneration: "history-reset",
          excerpt: "Second independent historical observation.",
          evidenceRole: "SUPPORTS",
          readDepth: "cross_paper",
        },
      ],
    },
  ],
});
await store.markSourceDeleted(1, "HISTORY1");
await store.markSourceDeleted(1, "HISTORY2");
assert.equal(
  (await store.getClaim(corroborated.refs["claim:historical"]))
    ?.epistemicStatus,
  "corroborated",
  "historical Evidence from deleted sources must not downgrade a corroborated Claim",
);

const claimEmbeddingTextHash = await hashWikiText(
  "Cooling-rate refinement becomes weaker above the transition temperature.",
);
await store.saveClaimEmbedding({
  claimId: commit.refs["claim:boundary"],
  vector: new Float32Array([1, 0, 0]),
  model: "embedding-model-a",
  textHash: claimEmbeddingTextHash,
});
await assert.rejects(
  () =>
    store.saveClaimEmbedding({
      claimId: commit.refs["claim:boundary"],
      vector: new Float32Array([1, 0, 0]),
      model: "embedding-model-b",
      textHash: claimEmbeddingTextHash,
    }),
  /different model or dimensions/iu,
  "Claim Embeddings must not mix model identities",
);
await assert.rejects(
  () =>
    store.saveClaimEmbedding({
      claimId: commit.refs["claim:boundary"],
      vector: new Float32Array([1, 0]),
      model: "embedding-model-a",
      textHash: claimEmbeddingTextHash,
    }),
  /different model or dimensions/iu,
  "Claim Embeddings must not mix vector dimensions",
);
const searchDbPath = path.join(tempDir, "zotero-mcp-semantic.sqlite");
const searchSqlite = new DatabaseSync(searchDbPath);
searchSqlite.exec(
  "CREATE TABLE embeddings (id INTEGER PRIMARY KEY); INSERT INTO embeddings VALUES (1)",
);

const beforeClear = await store.getStatus();
assert.equal(beforeClear.claimEmbeddings, 1);
const clearReport = await store.clearAll();
assert.ok(clearReport.deletedRows > 0);
assert.deepEqual(await store.getStatus(), {
  database: "zotero-mcp-wiki.sqlite",
  pages: 0,
  claims: 0,
  concepts: 0,
  aliases: 0,
  relations: 0,
  evidence: 0,
  claimEmbeddings: 0,
  pendingRelink: 0,
  validEvidence: 0,
  staleEvidence: 0,
  deletedSources: 0,
});
assert.equal(
  searchSqlite.prepare("SELECT COUNT(*) AS count FROM embeddings").get().count,
  1,
  "clearing Wiki persistence must not delete the independent search index",
);
searchSqlite.close();

sqlite.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log("wiki store tests passed");
