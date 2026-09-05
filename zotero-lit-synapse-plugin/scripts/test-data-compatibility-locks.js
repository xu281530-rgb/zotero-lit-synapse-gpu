/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { deriveDataCompatibilityLocks, deriveEmbeddingPreferenceLocks } =
  await import("../src/modules/dataCompatibilityLocks.ts");

const empty = {
  semanticVectors: 0,
  keywordDocuments: 0,
  keywordChunks: 0,
  wikiRows: 0,
  wikiClaimEmbeddings: 0,
};

assert.deepEqual(deriveDataCompatibilityLocks(empty), {
  chunkLocked: false,
  embeddingIdentityLocked: false,
});

for (const counts of [
  { ...empty, semanticVectors: 1 },
  { ...empty, keywordDocuments: 1 },
  { ...empty, keywordChunks: 1 },
  { ...empty, wikiRows: 1 },
]) {
  assert.equal(
    deriveDataCompatibilityLocks(counts).chunkLocked,
    true,
    "every persistent Chunk consumer must lock the Chunk settings",
  );
}

assert.equal(
  deriveDataCompatibilityLocks({ ...empty, semanticVectors: 1 })
    .embeddingIdentityLocked,
  true,
  "document vectors must lock the embedding identity",
);
assert.equal(
  deriveDataCompatibilityLocks({ ...empty, wikiClaimEmbeddings: 1 })
    .embeddingIdentityLocked,
  true,
  "Wiki Claim Embeddings must lock the embedding identity",
);
assert.equal(
  deriveDataCompatibilityLocks({ ...empty, keywordDocuments: 1 })
    .embeddingIdentityLocked,
  false,
  "a keyword-only index does not depend on the embedding space",
);

assert.deepEqual(deriveEmbeddingPreferenceLocks(true), {
  apiKey: false,
  apiBase: false,
  model: true,
  dimensions: true,
  detectedDimensions: true,
});
assert.deepEqual(deriveEmbeddingPreferenceLocks(false), {
  apiKey: false,
  apiBase: false,
  model: false,
  dimensions: false,
  detectedDimensions: false,
});

console.log("data compatibility lock tests passed");
