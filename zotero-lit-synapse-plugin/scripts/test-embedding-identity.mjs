import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";

register("./ts-ext-hooks.mjs", import.meta.url);
globalThis.Zotero = {
  Libraries: { userLibraryID: 1 },
  Prefs: { get: () => undefined },
};
globalThis.ztoolkit = { log() {} };
const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiRetriever } = await import("../src/modules/wiki/wikiRetriever.ts");
const { hashWikiText } = await import(
  "../src/modules/wiki/wikiCanonicalizer.ts"
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
        const value = await fn();
        sqlite.exec("COMMIT");
        return value;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const identityA = {
  apiBase: "https://service-a.invalid/v1",
  provider: "openai",
  model: "shared-alias",
  dimensions: 2,
  requestedDimensions: 2,
  inputHash: "claim-input",
  queryMode: false,
};
const identityB = {
  ...identityA,
  apiBase: "https://service-b.invalid/v1",
  inputHash: "question-input",
  queryMode: true,
};
const db = new DatabaseSync(":memory:");
const store = new WikiStore(adapt(db));
await store.initialize();
const claimText = "Thermal gradients suppress interface instability.";
const result = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "CREATE_PAGE",
      ref: "p",
      canonicalTitle: "Solidification",
      primaryConcept: { canonicalName: "solidification" },
    },
    {
      action: "ADD_CLAIM",
      ref: "c",
      pageId: "p",
      claimText,
      claimType: "mechanism",
      epistemicStatus: "provisional",
      coverageLevel: "chunk_local",
      confidence: 0.8,
      evidence: [
        {
          libraryID: 1,
          itemKey: "PAPER001",
          chunkIdSnapshot: 0,
          chunkTextHash: await hashWikiText(claimText),
          sourceContentHash: "v1",
          sourceChunkSignature: "chunks-v1",
          sourceResetGeneration: "none",
          excerpt: claimText,
          evidenceRole: "SUPPORTS",
          readDepth: "chunk_local",
        },
      ],
    },
  ],
});
await store.saveClaimEmbedding({
  claimId: result.refs.c,
  vector: new Float32Array([1, 0]),
  model: identityA.model,
  identity: identityA,
  textHash: await hashWikiText(claimText),
});
const query = {
  libraryID: 1,
  query: "unrelatedxylophoneresearch",
  queryVector: new Float32Array([1, 0]),
  queryVectorModel: identityB.model,
  queryVectorIdentity: identityB,
  minScore: 0.9,
};
const mismatched = await new WikiRetriever(store).search(query);
assert.equal(
  mismatched.claims.length,
  0,
  "Another service's vector must not admit this claim",
);
assert.ok(
  mismatched.warnings?.length,
  "Excluded incompatible vectors must be reported",
);
const compatible = await new WikiRetriever(store).search({
  ...query,
  queryVectorIdentity: {
    ...identityA,
    inputHash: "different-question",
    queryMode: true,
  },
});
assert.equal(
  compatible.claims.length,
  1,
  "Input and query mode differ normally within one compatible space",
);
const reopened = new WikiStore(adapt(db));
const persistent = await new WikiRetriever(reopened).search(query);
assert.equal(
  persistent.claims.length,
  0,
  "Generating service identity survives reopening the store",
);
const conceptId = Number(
  db.prepare("SELECT concept_id FROM wiki_concepts LIMIT 1").get().concept_id,
);
await store.saveConceptEmbedding({
  conceptId,
  vector: new Float32Array([1, 0]),
  model: identityA.model,
  identity: identityA,
  textHash: "concept-text",
});
for (const identity of [identityB, undefined]) {
  const warnings = [];
  const options = { libraryID: 1, model: identityA.model, identity, warnings };
  const matches = await store.matchConcepts({
    ...options,
    probes: [
      { text: "unrelatedxylophoneresearch", vector: new Float32Array([1, 0]) },
    ],
  });
  assert.equal(
    matches[0].matches.length,
    0,
    "Unknown or foreign concept identity cannot produce a vector match",
  );
  assert.equal(
    (
      await store.pagesNearVectors({
        ...options,
        vectors: [new Float32Array([1, 0])],
      })
    ).length,
    0,
  );
  assert.equal(
    (
      await store.conceptNeighbourhood({
        ...options,
        seedConceptIds: [],
        seedVectors: [new Float32Array([1, 0])],
      })
    ).neighbours.length,
    0,
  );
  assert.ok(warnings.length, "Excluded concept/page vectors are observable");
}
const validOptions = {
  libraryID: 1,
  model: identityA.model,
  identity: { ...identityA, inputHash: "question", queryMode: true },
};
assert.equal(
  (
    await store.pagesNearVectors({
      ...validOptions,
      vectors: [new Float32Array([1, 0])],
    })
  ).length,
  1,
);
assert.equal(
  (
    await store.conceptNeighbourhood({
      ...validOptions,
      seedConceptIds: [],
      seedVectors: [new Float32Array([1, 0])],
    })
  ).neighbours.length,
  1,
);
db.exec(
  "DELETE FROM wiki_embedding_queue; DELETE FROM wiki_concept_embedding_queue",
);
await store.requeueIncompatibleEmbeddings(1, identityB);
assert.equal(
  Number(db.prepare("SELECT COUNT(*) AS n FROM wiki_embedding_queue").get().n),
  1,
);
assert.equal(
  Number(
    db.prepare("SELECT COUNT(*) AS n FROM wiki_concept_embedding_queue").get()
      .n,
  ),
  1,
);
db.exec(
  "UPDATE wiki_embedding_queue SET attempts = 3, next_attempt_at = 9999999999999",
);
await store.requeueIncompatibleEmbeddings(1, identityB);
assert.equal(
  Number(
    db.prepare("SELECT attempts FROM wiki_embedding_queue").get().attempts,
  ),
  3,
  "A repeated search does not erase recovery backoff",
);
const provenance = JSON.parse(
  db.prepare("SELECT embedding_identity FROM wiki_claim_embeddings").get()
    .embedding_identity,
);
assert.equal(provenance.inputHash, identityA.inputHash);
assert.equal(provenance.queryMode, false);
db.close();
console.log("Embedding identity persistence and Wiki comparison tests passed");
