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
const { WikiRetriever } = await import("../src/modules/wiki/wikiRetriever.ts");
const { renderWikiMarkdown } = await import(
  "../src/modules/wiki/wikiRenderer.ts"
);
const { hashWikiText } = await import(
  "../src/modules/wiki/wikiCanonicalizer.ts"
);
const { fuseHybridSearchResultsDetailed, runHybridSearch } = await import(
  "../src/modules/hybridSearch.ts"
);

function adapt(sqlite) {
  return {
    async queryAsync(sql, params = []) {
      const statement = sqlite.prepare(sql);
      if (/^\s*(select|pragma|with)\b/iu.test(sql))
        return statement.all(...params);
      statement.run(...params);
      return [];
    },
    async valueQueryAsync(sql, params = []) {
      const row = sqlite.prepare(sql).get(...params);
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(fn) {
      sqlite.exec("BEGIN");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-retrieval-"));
const sqlite = new DatabaseSync(path.join(dir, "zotero-mcp-wiki.sqlite"));
sqlite.exec("PRAGMA foreign_keys = ON");
const store = new WikiStore(adapt(sqlite));
await store.initialize();

async function evidence(
  itemKey,
  text,
  role = "SUPPORTS",
  depth = "chunk_local",
) {
  return {
    libraryID: 1,
    itemKey,
    chunkIdSnapshot: 0,
    chunkTextHash: await hashWikiText(text),
    sourceContentHash: `content-${itemKey}`,
    sourceChunkSignature: "paragraph-v3:1000:500",
    sourceResetGeneration: "reset-1",
    excerpt: text,
    evidenceRole: role,
    readDepth: depth,
  };
}

const committed = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "CREATE_PAGE",
      ref: "page:solidification",
      primaryConceptRef: "concept:solidification",
      canonicalTitle: "Directional solidification",
      primaryConcept: {
        canonicalName: "directional solidification",
        conceptType: "process",
        aliases: [
          { alias: "定向凝固", language: "zh", confidence: 1 },
          { alias: "DS", language: "en", confidence: 0.8 },
        ],
      },
    },
    {
      action: "ADD_CLAIM",
      ref: "claim:gradient",
      pageId: "page:solidification",
      claimText: "A higher thermal gradient suppresses interface instability.",
      claimType: "mechanism",
      epistemicStatus: "provisional",
      coverageLevel: "chunk_local",
      confidence: 0.35,
      evidence: [
        await evidence(
          "PAPER001",
          "A higher thermal gradient suppresses interface instability.",
        ),
      ],
    },
  ],
});

const convectionCommitted = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "CREATE_PAGE",
      ref: "page:convection",
      primaryConceptRef: "concept:convection",
      canonicalTitle: "Solutal convection",
      primaryConcept: {
        canonicalName: "solutal convection",
        aliases: [{ alias: "溶质对流", language: "zh", confidence: 1 }],
      },
    },
    {
      action: "ADD_CLAIM",
      ref: "claim:convection",
      pageId: "page:convection",
      claimText: "Solutal convection perturbs the solidification front.",
      claimType: "mechanism",
      epistemicStatus: "disputed",
      coverageLevel: "cross_paper",
      confidence: 0.95,
      evidence: [
        await evidence(
          "PAPER002",
          "Solutal convection perturbs the solidification front.",
          "SUPPORTS",
          "cross_paper",
        ),
        await evidence(
          "OUTSIDE1",
          "Independent evidence for solutal convection.",
          "CONTRADICTS",
          "paper_reviewed",
        ),
      ],
    },
  ],
});

await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "LINK_RELATION",
      sourceConceptId: committed.refs["concept:solidification"],
      predicate: "is perturbed by",
      targetConceptId: convectionCommitted.refs["concept:convection"],
      confidence: 0.84,
    },
  ],
});

const summarizedSolidificationPage = await store.getPage(
  committed.refs["page:solidification"],
);
assert.match(
  summarizedSolidificationPage?.summary ?? "",
  /Evidence: 1 SUPPORTS \(1 valid; deepest chunk_local\)\./u,
  "Page Summary must derive Evidence role, binding state, and read depth",
);
assert.match(
  summarizedSolidificationPage?.summary ?? "",
  /Relations: directional solidification is perturbed by solutal convection\./u,
  "Page Summary must derive relations connected to the primary Concept",
);

const markdownSnapshot = await store.getRetrievalSnapshot(1);
const markdown = renderWikiMarkdown(await store.listPages(1), markdownSnapshot);
assert.match(markdown, /Concept: directional solidification/u);
assert.match(markdown, /Aliases:.*定向凝固/u);
assert.match(
  markdown,
  /directional solidification is perturbed by solutal convection/u,
);

const prepared = await store.prepareUpdate({
  libraryID: 1,
  query: "定向凝固",
  limit: 10,
});
assert.equal(prepared.pages[0].pageId, committed.refs["page:solidification"]);
assert.equal(prepared.concepts[0].canonicalName, "directional solidification");

const retriever = new WikiRetriever(store);
const lowConfidenceDirect = await retriever.search({
  libraryID: 1,
  query: "定向凝固 thermal gradient interface instability",
  keywords: ["thermal gradient", "interface instability"],
  minScore: 0,
  limit: 20,
});
assert.equal(
  lowConfidenceDirect.claims[0].claimId,
  committed.refs["claim:gradient"],
);
assert.ok(lowConfidenceDirect.claims[0].normalizedWikiScore > 0.8);
assert.equal(lowConfidenceDirect.claims[0].evidenceConfidence, 0.35);
assert.equal(lowConfidenceDirect.claims[0].readDepth, "chunk_local");
assert.ok(
  lowConfidenceDirect.claims[0].normalizedWikiScore >
    lowConfidenceDirect.claims[0].evidenceConfidence,
  "weak evidence must not be misreported as low query relevance",
);

const gradientClaimText =
  "A higher thermal gradient suppresses interface instability.";
const gradientClaimHash = await hashWikiText(gradientClaimText);
await store.saveClaimEmbedding({
  claimId: committed.refs["claim:gradient"],
  vector: new Float32Array([1, 0]),
  model: "embedding-model-a",
  textHash: gradientClaimHash,
});

async function embeddingOnlySearch() {
  return retriever.search({
    libraryID: 1,
    query: "orthogonal vector-only lookup",
    queryVector: new Float32Array([1, 0]),
    queryVectorModel: "embedding-model-a",
    minScore: 0.9,
    limit: 20,
  });
}

assert.deepEqual(
  (await embeddingOnlySearch()).claims.map((claim) => claim.claimId),
  [committed.refs["claim:gradient"]],
  "a compatible Claim Embedding must participate in Wiki scoring",
);

sqlite
  .prepare("UPDATE wiki_claim_embeddings SET text_hash = ? WHERE claim_id = ?")
  .run("stale-claim-text", committed.refs["claim:gradient"]);
assert.deepEqual(
  (await embeddingOnlySearch()).claims,
  [],
  "a Claim Embedding for stale Claim text must be ignored during retrieval",
);

sqlite
  .prepare(
    "UPDATE wiki_claim_embeddings SET text_hash = ?, model = ? WHERE claim_id = ?",
  )
  .run(
    gradientClaimHash,
    "embedding-model-b",
    committed.refs["claim:gradient"],
  );
assert.deepEqual(
  (await embeddingOnlySearch()).claims,
  [],
  "a Claim Embedding from another model must be ignored during retrieval",
);

sqlite
  .prepare(
    "UPDATE wiki_claim_embeddings SET model = ?, dimensions = ? WHERE claim_id = ?",
  )
  .run("embedding-model-a", 3, committed.refs["claim:gradient"]);
assert.deepEqual(
  (await embeddingOnlySearch()).claims,
  [],
  "a Claim Embedding with incompatible dimensions must be ignored without decoding its blob",
);

sqlite
  .prepare("UPDATE wiki_claim_embeddings SET dimensions = ? WHERE claim_id = ?")
  .run(2, committed.refs["claim:gradient"]);

const relationPredicateDirect = await retriever.search({
  libraryID: 1,
  query: "is perturbed by",
  minScore: 0,
  limit: 20,
});
assert.deepEqual(
  relationPredicateDirect.claims.map((claim) => claim.claimId).sort(),
  [
    committed.refs["claim:gradient"],
    convectionCommitted.refs["claim:convection"],
  ].sort(),
  "a direct Relation predicate match must retrieve Claims at both endpoints",
);
assert.deepEqual(
  relationPredicateDirect.documents.map((row) => row.itemKey).sort(),
  ["OUTSIDE1", "PAPER001", "PAPER002"],
  "a Relation predicate match must resolve endpoint Evidence back to documents",
);
assert.equal(relationPredicateDirect.relations.length, 1);
assert.equal(relationPredicateDirect.relations[0].predicate, "is perturbed by");

const graph = await store.getDocumentGraph(1);
const evidenceEdge = graph.edges.find(
  (edge) => edge.source === "OUTSIDE1" && edge.target === "PAPER002",
);
assert.ok(evidenceEdge?.relations.includes("SUPPORTS"));
assert.ok(evidenceEdge?.relations.includes("CONTRADICTS"));
assert.ok(
  evidenceEdge?.relations.some(
    (relation) =>
      relation.includes("SUPPORTS<->CONTRADICTS") ||
      relation.includes("CONTRADICTS<->SUPPORTS"),
  ),
  "document graph edges must expose cross-paper support/conflict knowledge",
);

const scoped = await retriever.search({
  libraryID: 1,
  query: "溶质对流 solidification front",
  itemKeys: ["PAPER002"],
  minScore: 0,
  limit: 20,
});
assert.deepEqual(
  scoped.documents.map((row) => row.itemKey),
  ["PAPER002"],
);
assert.ok(
  scoped.documents.every((row) => row.itemKey !== "OUTSIDE1"),
  "Wiki Evidence must be filtered through the final item scope",
);
assert.ok(
  scoped.claims.every((claim) =>
    claim.evidence.every((row) => row.item_key === "PAPER002"),
  ),
  "scoped Claim results must not expose Evidence outside itemKeys",
);

const verificationPage = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "CREATE_PAGE",
      ref: "page:verification-boundary",
      canonicalTitle: "Evidence verification boundary",
    },
    {
      action: "ADD_CLAIM",
      ref: "claim:verification-boundary",
      pageId: "page:verification-boundary",
      claimText: "Verification boundary evidence has mixed link states.",
      claimType: "condition",
      epistemicStatus: "supported",
      coverageLevel: "cross_paper",
      confidence: 0.9,
      evidence: [
        await evidence(
          "VERIFIEDDOC",
          "Verified local evidence for the boundary.",
          "SUPPORTS",
          "chunk_local",
        ),
        await evidence(
          "PENDINGDEEP",
          "Pending cross-paper evidence for the boundary.",
          "SUPPORTS",
          "cross_paper",
        ),
      ],
    },
  ],
});
await store.markItemsPending("content-rebuild", 1, ["PENDINGDEEP"]);
const mixedVerification = await retriever.search({
  libraryID: 1,
  query: "verification boundary mixed link states",
  minScore: 0,
  limit: 20,
});
const mixedClaim = mixedVerification.claims.find(
  (claim) =>
    claim.claimId === verificationPage.refs["claim:verification-boundary"],
);
assert.ok(mixedClaim, "the mixed-state Claim must remain visible");
assert.ok(
  mixedClaim.evidence.some((row) => row.link_state === "pending_relink"),
  "pending Evidence remains visible for explicit re-verification",
);
assert.equal(
  mixedClaim.readDepth,
  "chunk_local",
  "pending Evidence must not elevate verified readDepth",
);
assert.deepEqual(
  mixedVerification.documents
    .filter((row) =>
      row.wikiClaims.some((claim) => claim.claimId === mixedClaim.claimId),
    )
    .map((row) => row.itemKey),
  ["VERIFIEDDOC"],
  "pending Evidence must not create a live document candidate",
);

const massPages = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "CREATE_PAGE",
      ref: "page:claim-hog",
      canonicalTitle: "Dominant material phenomenon",
    },
    {
      action: "CREATE_PAGE",
      ref: "page:other-document",
      canonicalTitle: "Secondary observations",
    },
  ],
});
await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    ...(await Promise.all(
      Array.from({ length: 120 }, async (_, index) => ({
        action: "ADD_CLAIM",
        pageId: massPages.refs["page:claim-hog"],
        claimText: `Dominant material phenomenon repeated finding ${index}.`,
        claimType: "mechanism",
        epistemicStatus: "supported",
        coverageLevel: "chunk_local",
        confidence: 0.9,
        evidence: [
          await evidence(
            "CLAIMHOG",
            `Dominant material phenomenon repeated evidence ${index}.`,
          ),
        ],
      })),
    )),
    {
      action: "ADD_CLAIM",
      pageId: massPages.refs["page:other-document"],
      claimText: "Dominant material changes behavior under other conditions.",
      claimType: "condition",
      epistemicStatus: "supported",
      coverageLevel: "chunk_local",
      confidence: 0.8,
      evidence: [
        await evidence(
          "OTHERDOC",
          "Dominant material changes behavior under other conditions.",
        ),
      ],
    },
  ],
});

const documentLimited = await retriever.search({
  libraryID: 1,
  query: "dominant material phenomenon",
  minScore: 0.5,
  limit: 2,
});
assert.ok(
  documentLimited.claims.length > 100,
  "limit must not truncate qualified Claims before document aggregation",
);
assert.deepEqual(
  documentLimited.documents.map((row) => row.itemKey),
  ["CLAIMHOG", "OTHERDOC"],
  "many high-scoring Claims from one paper must not evict another relevant paper",
);
assert.equal(
  documentLimited.documents[0].wikiClaims.length,
  120,
  "all Claims for one document must aggregate into one document candidate",
);

const scopeBeforeRanking = await retriever.search({
  libraryID: 1,
  query: "dominant material phenomenon",
  itemKeys: ["OTHERDOC"],
  minScore: 0.5,
  limit: 1,
});
assert.deepEqual(
  scopeBeforeRanking.documents.map((row) => row.itemKey),
  ["OTHERDOC"],
);
assert.ok(
  scopeBeforeRanking.claims.every((claim) =>
    claim.evidence.some((row) => row.item_key === "OTHERDOC"),
  ),
  "itemKeys must constrain eligible Claims before Wiki scoring and ranking",
);

const unscoped = await retriever.search({
  libraryID: 1,
  query: "dominant material phenomenon",
  minScore: 0.5,
  limit: 10,
});
assert.deepEqual(
  unscoped.documents.map((row) => row.itemKey),
  ["CLAIMHOG", "OTHERDOC"],
  "a whole-library Wiki search must not inherit an itemKeys filter",
);

await store.markItemsPending("content-rebuild", 1, ["CLAIMHOG"]);
const pendingSearch = await retriever.search({
  libraryID: 1,
  query: "dominant material phenomenon",
  minScore: 0.5,
  limit: 10,
});
assert.ok(
  pendingSearch.claims.some((claim) =>
    claim.evidence.some((row) => row.link_state === "pending_relink"),
  ),
  "pending_relink Evidence remains visible and explicitly marked",
);
assert.ok(
  pendingSearch.documents.every((row) => row.itemKey !== "CLAIMHOG"),
  "pending_relink Evidence must not produce a verified document candidate",
);
assert.ok(
  (await store.getDocumentGraph(1)).nodes.every(
    (node) => node.itemKey !== "CLAIMHOG",
  ),
  "pending_relink Evidence must not act as a verified edge in the document graph",
);

await store.markSourceDeleted(1, "OUTSIDE1");
const historicalSearch = await retriever.search({
  libraryID: 1,
  query: "solutal convection",
  minScore: 0,
  limit: 10,
});
assert.ok(
  historicalSearch.claims.some((claim) =>
    claim.evidence.some((row) => row.link_state === "source_deleted"),
  ),
  "source_deleted Evidence must remain part of the long-term Wiki Claim",
);
assert.ok(
  historicalSearch.documents.every((row) => row.itemKey !== "OUTSIDE1"),
  "a deleted Zotero item cannot be returned as a live document candidate",
);

const documentLevelFusion = fuseHybridSearchResultsDetailed(
  [],
  [],
  documentLimited.documents,
  {
    topK: 2,
    rrfK: 60,
    keywordWeight: 0,
    semanticWeight: 0,
    wikiWeight: 1,
    wikiMinScore: 0,
    wikiShadowMode: false,
  },
);
assert.deepEqual(
  documentLevelFusion.ranked.map((row) => row.itemKey),
  ["CLAIMHOG", "OTHERDOC"],
  "Wiki must enter hybrid RRF as one candidate per distinct document",
);

const activeFusion = fuseHybridSearchResultsDetailed(
  [{ key: "KW", libraryID: 1, relevanceScore: 0.9 }],
  [{ itemKey: "SEM", libraryID: 1, score: 0.8 }],
  [
    {
      itemKey: "WIKI",
      libraryID: 1,
      normalizedWikiScore: 0.95,
      evidenceConfidence: 0.2,
      readDepth: "chunk_local",
      epistemicStatus: "provisional",
    },
  ],
  {
    topK: 10,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
    wikiWeight: 0.5,
    keywordMinScore: 0,
    semanticMinScore: 0,
    wikiMinScore: 0.5,
    wikiShadowMode: false,
  },
);
assert.equal(activeFusion.ranked.length, 3);
assert.equal(activeFusion.appliedWikiMinScore, 0.5);
assert.equal(
  activeFusion.ranked.find((row) => row.itemKey === "WIKI")?.wikiRank,
  1,
);
assert.equal(
  activeFusion.ranked.find((row) => row.itemKey === "WIKI")?.score,
  0.5 / 61,
  "Wiki contributes through rank-based Weighted RRF, not its raw relevance",
);

const baseline = fuseHybridSearchResultsDetailed(
  [{ key: "A", libraryID: 1, relevanceScore: 0.8 }],
  [{ itemKey: "B", libraryID: 1, score: 0.8 }],
  { topK: 10, rrfK: 60, keywordWeight: 1, semanticWeight: 1 },
);
const shadow = await runHybridSearch(
  {
    query: "query",
    topK: 10,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
    wikiWeight: 0.5,
    wikiMinScore: 0,
    wikiSearchTimeoutMs: 1000,
    wikiShadowMode: true,
  },
  {
    keywordSearch: async () => [
      { key: "A", libraryID: 1, relevanceScore: 0.8 },
    ],
    semanticSearch: async () => [{ itemKey: "B", libraryID: 1, score: 0.8 }],
    wikiSearch: async () => [
      {
        itemKey: "W",
        libraryID: 1,
        normalizedWikiScore: 1,
        evidenceConfidence: 1,
        readDepth: "cross_paper",
        epistemicStatus: "corroborated",
      },
    ],
  },
);
assert.deepEqual(
  shadow.ranked.map(({ itemKey, score }) => ({ itemKey, score })),
  baseline.ranked.map(({ itemKey, score }) => ({ itemKey, score })),
  "Shadow Mode must not alter the existing Keyword + Semantic ranking",
);
assert.equal(shadow.wikiResultCount, 1);
assert.equal(shadow.wikiAdmittedCount, 1);
assert.equal(shadow.wikiShadowMode, true);
assert.deepEqual(shadow.wikiCandidateItemKeys, ["W"]);
assert.equal(shadow.wikiNovelDocumentCount, 1);
assert.equal(shadow.wikiKeywordOverlapCount, 0);
assert.equal(shadow.wikiSemanticOverlapCount, 0);

const timedOutWiki = await runHybridSearch(
  {
    query: "query",
    topK: 10,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
    wikiWeight: 0,
    wikiMinScore: 0,
    wikiSearchTimeoutMs: 20,
    wikiShadowMode: true,
  },
  {
    keywordSearch: async () => [
      { key: "A", libraryID: 1, relevanceScore: 0.8 },
    ],
    semanticSearch: async () => [{ itemKey: "B", libraryID: 1, score: 0.8 }],
    wikiSearch: async () => new Promise(() => undefined),
  },
);
assert.deepEqual(
  timedOutWiki.ranked.map(({ itemKey }) => itemKey),
  baseline.ranked.map(({ itemKey }) => itemKey),
  "Wiki timeout must fall back to the existing two routes",
);
assert.ok(
  timedOutWiki.warnings.some((warning) =>
    warning.includes("Wiki search unavailable"),
  ),
);

sqlite.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("wiki retrieval tests passed");
