/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

// Every query below goes through Zotero's real parameter rules, not
// node:sqlite's permissive ones - see scripts/zotero-db-params.mjs.
const { parseQueryAndParams } = await import("./zotero-db-params.mjs");

// The reading-note half of a Wiki build writes a Markdown attachment onto the
// Zotero item, so the fake has to carry items, attachments and a filesystem.
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-store-"));
const fake = createZoteroFake({ rootDir: tempDir });
fake.install();

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { WikiEvidenceRelinker } = await import(
  "../src/modules/wiki/wikiEvidenceRelinker.ts"
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
  // 2.4.3: a title that names a known concept is no longer refused for being a
  // known name - concepts are independent records now and most of them will
  // never have a page. What still refuses it is the rule that matters: the
  // concept this title names ALREADY has a knowledge entry, so a second one
  // would fragment it.
  /already has active Wiki Page/iu,
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
  "unsupported",
  "a search-index reset must immediately recompute a pending-only Claim",
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
  pending: 0,
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
const statusBeforeSourceDeletion = claim?.epistemicStatus;

await store.markSourceDeleted(1, "ITEMA001");
claim = await store.getClaim(commit.refs["claim:boundary"]);
assert.equal(claim?.evidence[0].linkState, "source_deleted");
assert.equal(
  claim?.epistemicStatus,
  statusBeforeSourceDeletion,
  "deleting a Zotero source must not erase the historical Evidence or downgrade its Claim",
);

await store.markItemsPending("restore-20", 1, ["ITEMA001"]);
claim = await store.getClaim(commit.refs["claim:boundary"]);
assert.equal(
  claim?.evidence[0].linkState,
  "pending_relink",
  "an explicitly re-indexed restored source must leave source_deleted and re-enter relinking",
);
const restoredRelinker = new WikiEvidenceRelinker(store, {
  async sourceExists() {
    return true;
  },
  async getChunks() {
    return [
      {
        chunkId: 13,
        text: movedText,
        contentHash: "content-restored",
        chunkSignature: "paragraph-v3:900:300",
        resetGeneration: "restore-20",
      },
    ];
  },
});
assert.equal(
  (await restoredRelinker.relinkPending({ libraryID: 1 })).relinked,
  1,
);
claim = await store.getClaim(commit.refs["claim:boundary"]);
assert.equal(claim?.evidence[0].linkState, "valid");

const orderCommit = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "CREATE_PAGE",
      ref: "page:relink-order",
      canonicalTitle: "Relink ordering",
    },
    {
      action: "ADD_CLAIM",
      ref: "claim:relink-order",
      pageId: "page:relink-order",
      claimText: "Relink status depends on the final evidence set.",
      claimType: "condition",
      epistemicStatus: "supported",
      coverageLevel: "section_read",
      confidence: 0.8,
      evidence: [
        {
          libraryID: 1,
          itemKey: "ORDERSTALE",
          chunkIdSnapshot: 0,
          chunkTextHash: await hashWikiText("Evidence that will go stale."),
          sourceContentHash: "order-stale-v1",
          sourceChunkSignature: "paragraph-v3:1000:500",
          sourceResetGeneration: "reset-order-1",
          excerpt: "Evidence that will go stale.",
          evidenceRole: "SUPPORTS",
          readDepth: "section_read",
        },
        {
          libraryID: 1,
          itemKey: "ORDERVALID",
          chunkIdSnapshot: 0,
          chunkTextHash: await hashWikiText("Evidence that remains valid."),
          sourceContentHash: "order-valid-v1",
          sourceChunkSignature: "paragraph-v3:1000:500",
          sourceResetGeneration: "reset-order-1",
          excerpt: "Evidence that remains valid.",
          evidenceRole: "SUPPORTS",
          readDepth: "section_read",
        },
      ],
    },
  ],
});
await store.markItemsPending("content-rebuild", 1, [
  "ORDERSTALE",
  "ORDERVALID",
]);
const scopedRelinker = new WikiEvidenceRelinker(store, {
  async sourceExists() {
    return true;
  },
  async getChunks() {
    return [
      {
        chunkId: 4,
        text: "Evidence that remains valid.",
        contentHash: "order-valid-v2",
        chunkSignature: "paragraph-v3:1000:500",
        resetGeneration: "reset-order-2",
      },
    ];
  },
});
assert.deepEqual(
  await scopedRelinker.relinkPending({
    libraryID: 1,
    itemKeys: ["ORDERVALID"],
  }),
  {
    checked: 1,
    relinked: 1,
    pending: 0,
    stale: 0,
    sourceDeleted: 0,
  },
);
const scopedClaim = await store.getClaim(
  orderCommit.refs["claim:relink-order"],
);
assert.equal(
  scopedClaim?.evidence.find((row) => row.itemKey === "ORDERSTALE")?.linkState,
  "pending_relink",
  "an item omitted from successful build targets must remain pending",
);
assert.equal(scopedClaim?.epistemicStatus, "supported");

await store.markItemsPending("content-rebuild-2", 1, [
  "ORDERSTALE",
  "ORDERVALID",
]);
const orderRelinker = new WikiEvidenceRelinker(store, {
  async sourceExists() {
    return true;
  },
  async getChunks(_libraryID, itemKey) {
    if (itemKey === "ORDERSTALE") return [];
    return [
      {
        chunkId: 4,
        text: "Evidence that remains valid.",
        contentHash: "order-valid-v2",
        chunkSignature: "paragraph-v3:1000:500",
        resetGeneration: "reset-order-2",
      },
    ];
  },
});
assert.deepEqual(await orderRelinker.relinkPending({ libraryID: 1 }), {
  checked: 2,
  relinked: 1,
  pending: 1,
  stale: 0,
  sourceDeleted: 0,
});
assert.equal(
  (await store.getClaim(orderCommit.refs["claim:relink-order"]))
    ?.epistemicStatus,
  "supported",
  "Claim status must be derived after the whole relink batch, independent of Evidence order",
);
await store.markSourceDeleted(1, "ORDERSTALE");

const recoveryCommit = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "CREATE_PAGE",
      ref: "page:status-recovery",
      canonicalTitle: "Claim status recovery",
    },
    {
      action: "ADD_CLAIM",
      ref: "claim:status-recovery",
      pageId: "page:status-recovery",
      claimText: "Recovered evidence supports this claim again.",
      claimType: "condition",
      epistemicStatus: "supported",
      coverageLevel: "chunk_local",
      confidence: 0.8,
      evidence: [
        {
          libraryID: 1,
          itemKey: "RECOVERY1",
          chunkIdSnapshot: 0,
          chunkTextHash: await hashWikiText("Original recovery evidence."),
          sourceContentHash: "recovery-v1",
          sourceChunkSignature: "paragraph-v3:1000:500",
          sourceResetGeneration: "recovery-reset-1",
          excerpt: "Original recovery evidence.",
          evidenceRole: "SUPPORTS",
          readDepth: "chunk_local",
        },
      ],
    },
  ],
});
await store.markItemsPending("recovery-reset-2", 1, ["RECOVERY1"]);
assert.equal(
  (await store.getClaim(recoveryCommit.refs["claim:status-recovery"]))
    ?.epistemicStatus,
  "unsupported",
  "supported Claims must be recomputed when their Evidence becomes pending",
);
const noIndexRelinker = new WikiEvidenceRelinker(store, {
  async sourceExists() {
    return true;
  },
  async getChunks() {
    return [];
  },
});
const noIndexReport = await noIndexRelinker.relinkPending({ libraryID: 1 });
assert.equal(noIndexReport.stale, 0);
assert.equal(noIndexReport.pending, 1);
assert.equal(
  (await store.getClaim(recoveryCommit.refs["claim:status-recovery"]))
    ?.evidence[0].linkState,
  "pending_relink",
  "no indexed chunks means relinking is pending, not stale",
);
assert.equal(
  (await store.getClaim(recoveryCommit.refs["claim:status-recovery"]))
    ?.epistemicStatus,
  "unsupported",
  "a pending-only Claim stays recomputed when relinking has no body chunks",
);
assert.match(
  (await store.getPage(recoveryCommit.refs["page:status-recovery"]))?.summary ??
    "",
  /1 pending_relink.*deepest none/u,
  "the Page Summary must stay synchronized when relinking remains pending",
);
await store.markItemsPending("recovery-reset-metadata-only", 1, ["RECOVERY1"]);
const metadataOnlyRelinker = new WikiEvidenceRelinker(store, {
  async sourceExists() {
    return true;
  },
  async getChunks() {
    return [
      {
        chunkId: 0,
        text: "Title and abstract metadata only.",
        contentHash: "metadata-only",
        chunkSignature: "paragraph-v3:1000:500",
        resetGeneration: "recovery-reset-metadata-only",
      },
    ];
  },
  async indexReadyForRelink() {
    return false;
  },
});
assert.equal(
  (await metadataOnlyRelinker.relinkPending({ libraryID: 1 })).pending,
  1,
  "metadata-only indexed chunks must not authorize a stale verdict",
);

const missingEvidenceRelinker = new WikiEvidenceRelinker(store, {
  async sourceExists() {
    return true;
  },
  async getChunks() {
    return [
      {
        chunkId: 0,
        text: "A complete new index that no longer contains the old evidence.",
        contentHash: "recovery-v2",
        chunkSignature: "paragraph-v3:1000:500",
        resetGeneration: "recovery-reset-2",
      },
    ];
  },
});
assert.equal(
  (await missingEvidenceRelinker.relinkPending({ libraryID: 1 })).stale,
  1,
  "an unmatched Evidence becomes stale only after a non-empty new index exists",
);
assert.equal(
  (await store.getClaim(recoveryCommit.refs["claim:status-recovery"]))
    ?.epistemicStatus,
  "unsupported",
);

await store.markItemsPending("recovery-reset-3", 1, ["RECOVERY1"]);
const recoveredEvidenceRelinker = new WikiEvidenceRelinker(store, {
  async sourceExists() {
    return true;
  },
  async getChunks() {
    return [
      {
        chunkId: 7,
        text: "Original recovery evidence.",
        contentHash: "recovery-v3",
        chunkSignature: "paragraph-v3:1000:500",
        resetGeneration: "recovery-reset-3",
      },
    ];
  },
});
assert.equal(
  (await recoveredEvidenceRelinker.relinkPending({ libraryID: 1 })).relinked,
  1,
);
assert.equal(
  (await store.getClaim(recoveryCommit.refs["claim:status-recovery"]))
    ?.epistemicStatus,
  "supported",
  "Claim status must recover from unsupported when SUPPORTS Evidence becomes valid again",
);

const updateTarget = await store.getClaim(
  recoveryCommit.refs["claim:status-recovery"],
);
await assert.rejects(
  () =>
    store.commit({
      libraryID: 1,
      userInitiated: true,
      actions: [
        {
          action: "UPDATE_CLAIM",
          claimId: recoveryCommit.refs["claim:status-recovery"],
          expectedVersion: updateTarget.version,
          claimText: "This is materially different knowledge.",
        },
      ],
    }),
  /knowledge text.*Evidence/iu,
  "material Claim text changes require newly supplied Evidence",
);
await assert.rejects(
  () =>
    store.commit({
      libraryID: 1,
      userInitiated: true,
      actions: [
        {
          action: "UPDATE_CLAIM",
          claimId: recoveryCommit.refs["claim:status-recovery"],
          expectedVersion: updateTarget.version,
          claimType: "mechanism",
        },
      ],
    }),
  /knowledge text.*Evidence/iu,
  "a Claim type change is semantic content and requires Evidence too",
);
const evidencedUpdate = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "UPDATE_CLAIM",
      claimId: recoveryCommit.refs["claim:status-recovery"],
      expectedVersion: updateTarget.version,
      claimText: "This is materially different knowledge.",
      evidence: [
        {
          libraryID: 1,
          itemKey: "RECOVERY1",
          chunkIdSnapshot: 7,
          chunkTextHash: await hashWikiText("Original recovery evidence."),
          sourceContentHash: "recovery-v3",
          sourceChunkSignature: "paragraph-v3:1000:500",
          sourceResetGeneration: "recovery-reset-3",
          excerpt: "Original recovery evidence.",
          evidenceRole: "SUPPORTS",
          readDepth: "chunk_local",
        },
      ],
    },
  ],
});
assert.equal(evidencedUpdate.updatedClaims, 1);

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

const indexedChunks = new Map([
  ["META1", [{ chunkId: 0, text: "Metadata abstract evidence one." }]],
  ["META2", [{ chunkId: 0, text: "Metadata abstract evidence two." }]],
  [
    "UNKNOWN1",
    [{ chunkId: 0, text: "Legacy index evidence with unknown provenance." }],
  ],
  [
    "BODY1",
    [{ chunkId: 0, text: "Confirmed body evidence from the results section." }],
  ],
]);
const sourceKinds = new Map([
  ["META1", "metadata-only"],
  ["META2", "metadata-no-source"],
  ["UNKNOWN1", "legacy-source-on-demand"],
  ["BODY1", "body"],
]);
for (const itemKey of indexedChunks.keys()) {
  fake.createPaper({
    key: itemKey,
    title: `Indexed ${itemKey}`,
    abstract: `Abstract of ${itemKey}.`,
  });
}
const vectorStore = getVectorStore();
vectorStore.initialize = async () => {};
vectorStore.getChunksForItem = async (itemKey) =>
  indexedChunks.get(itemKey) ?? [];
vectorStore.getIndexStatus = async (itemKey) => ({
  contentHash: `content-${itemKey}`,
  sourceKind: sourceKinds.get(itemKey),
});
vectorStore.getCommittedResetGeneration = async () => "wiki-depth-reset";
const bodyAwareService = new WikiService(store);

for (const itemKey of ["META1", "META2", "UNKNOWN1"]) {
  await assert.rejects(
    () =>
      bodyAwareService.buildFromPaper({
        libraryID: 1,
        userRequested: true,
        itemKey,
      }),
    /only metadata.*body.*index|body.*not confirmed/iu,
    `${itemKey} must not pass wiki_build_from_paper as a full paper`,
  );
}
// includeAllChunks was removed: it returned a whole paper in one response.
await assert.rejects(
  () =>
    bodyAwareService.buildFromPaper({
      libraryID: 1,
      userRequested: true,
      itemKey: "BODY1",
      includeAllChunks: true,
    }),
  /includeAllChunks was removed/iu,
  "the unpaginated whole-paper read must be refused",
);
// The opening call is the expert briefing: metadata and abstract, no body.
const bodyBriefing = await bodyAwareService.buildFromPaper({
  libraryID: 1,
  userRequested: true,
  itemKey: "BODY1",
});
assert.equal(bodyBriefing.phase, "expert_briefing");
assert.deepEqual(bodyBriefing.chunks, []);
await bodyAwareService.setReadingExpert({
  libraryID: 1,
  itemKey: "BODY1",
  persona:
    "A thermal processing specialist reading for the conditions under which the reported cooling behaviour holds.",
  focus: ["the reported conditions", "what the results do not cover"],
});
const bodyBuild = await bodyAwareService.buildFromPaper({
  libraryID: 1,
  userRequested: true,
  itemKey: "BODY1",
});
assert.equal(bodyBuild.chunkCount, 1);
assert.equal(bodyBuild.pagination.totalChunks, 1);
assert.equal(bodyBuild.pagination.hasMore, false, "a 1-chunk paper is one page");
assert.equal(
  bodyBuild.pagination.coverageComplete,
  true,
  "and one page is full delivery",
);

// Delivery is not understanding: whole-paper depth also needs the pass over
// the whole reading note, which is a call the server watched happen.
await bodyAwareService.updateReadingNote({
  libraryID: 1,
  itemKey: "BODY1",
  finalSynthesis: true,
  markdown: [
    "# Confirmed body evidence",
    "",
    "## What the paper establishes",
    "The results section reports a cooling behaviour under stated conditions (chunk 0), and the paper is short enough that the single indexed passage carries all of it.",
    "",
    "## Scope and limits",
    "Nothing outside the reported condition range is demonstrated, and no independent replication is offered.",
  ].join(String.fromCharCode(10)),
});

const metadataDepthCommit = await bodyAwareService.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "ADD_CLAIM",
      ref: "claim:metadata-depth",
      pageId: commit.refs["page:cooling"],
      claimText: "Two abstracts report a metadata-level observation.",
      claimType: "consensus",
      epistemicStatus: "corroborated",
      coverageLevel: "cross_paper",
      confidence: 0.7,
      evidence: [
        {
          itemKey: "META1",
          excerpt: "Metadata abstract evidence one.",
          evidenceRole: "SUPPORTS",
          readDepth: "paper_reviewed",
        },
        {
          itemKey: "META2",
          excerpt: "Metadata abstract evidence two.",
          evidenceRole: "SUPPORTS",
          readDepth: "section_read",
        },
      ],
    },
  ],
});
const metadataDepthClaim = await store.getClaim(
  metadataDepthCommit.refs["claim:metadata-depth"],
);
assert.equal(metadataDepthClaim?.coverageLevel, "chunk_local");
assert.deepEqual(
  metadataDepthClaim?.evidence.map((row) => row.readDepth),
  ["chunk_local", "chunk_local"],
  "metadata and abstract Evidence must persist at chunk_local depth",
);

const bodyDepthCommit = await bodyAwareService.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "ADD_CLAIM",
      ref: "claim:body-depth",
      pageId: commit.refs["page:cooling"],
      claimText: "The indexed results section supports a body-level review.",
      claimType: "condition",
      epistemicStatus: "supported",
      coverageLevel: "paper_reviewed",
      confidence: 0.8,
      evidence: [
        {
          itemKey: "BODY1",
          excerpt: "Confirmed body evidence from the results section.",
          evidenceRole: "SUPPORTS",
          readDepth: "paper_reviewed",
        },
      ],
    },
  ],
});
const bodyDepthClaim = await store.getClaim(
  bodyDepthCommit.refs["claim:body-depth"],
);
assert.equal(bodyDepthClaim?.coverageLevel, "paper_reviewed");
assert.equal(bodyDepthClaim?.evidence[0].readDepth, "paper_reviewed");

await store.markItemsPending("body-commit-recovery", 1, ["BODY1"]);
assert.equal(
  (await store.getClaim(bodyDepthCommit.refs["claim:body-depth"]))
    ?.epistemicStatus,
  "unsupported",
);
await bodyAwareService.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "ATTACH_EVIDENCE",
      claimId: bodyDepthCommit.refs["claim:body-depth"],
      evidence: [
        {
          itemKey: "BODY1",
          excerpt: "Confirmed body evidence from the results section.",
          evidenceRole: "SUPPORTS",
          readDepth: "paper_reviewed",
        },
      ],
    },
  ],
});
assert.equal(
  (await store.getClaim(bodyDepthCommit.refs["claim:body-depth"]))
    ?.epistemicStatus,
  "supported",
  "wiki_commit must recompute a Claim when pending Evidence becomes valid",
);

sourceKinds.set("BODY1", "metadata-only");
await bodyAwareService.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "ATTACH_EVIDENCE",
      claimId: bodyDepthCommit.refs["claim:body-depth"],
      evidence: [
        {
          itemKey: "BODY1",
          excerpt: "Confirmed body evidence from the results section.",
          evidenceRole: "SUPPORTS",
          readDepth: "paper_reviewed",
        },
      ],
    },
  ],
});
assert.equal(
  (await store.getClaim(bodyDepthCommit.refs["claim:body-depth"]))?.evidence[0]
    .readDepth,
  "chunk_local",
  "a metadata-only UPSERT must lower an older paper_reviewed Evidence value",
);
sourceKinds.set("BODY1", "body");

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
  conceptTerms: 0,
  conceptTermSources: 0,
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
