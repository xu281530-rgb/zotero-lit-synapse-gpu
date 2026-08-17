/* eslint-env node */

/**
 * An index that no longer matches the embedding model must be REPORTED, never
 * silently answered with zero results.
 *
 * The regression: both vector scans returned `[]` when the stored vectors and
 * the query vector disagreed on dimensionality. Every layer above read that as
 * "the semantic branch found nothing relevant", so `hybrid_search` produced a
 * pure keyword ranking with `degraded: false`, no warning, and
 * `semanticResultCount: 0` — indistinguishable from a healthy hybrid run over
 * a library that happens to hold nothing on the topic. Neither the AI client
 * nor the user had any way to learn that half the retrieval system was offline
 * or that the fix was to rebuild the index.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const {
  DIMENSION_MISMATCH_HINT,
  VectorDimensionMismatchError,
  isVectorDimensionMismatchError,
} = await import("../src/modules/semantic/dimensionMismatch.ts");
const { runHybridSearch } = await import("../src/modules/hybridSearch.ts");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectorStoreSource = fs.readFileSync(
  path.join(root, "src/modules/semantic/vectorStore.ts"),
  "utf8",
);
const gpuServiceSource = fs.readFileSync(
  path.join(root, "src/modules/semantic/gpuVectorService.ts"),
  "utf8",
);
const mcpSource = fs.readFileSync(
  path.join(root, "src/modules/streamableMCPServer.ts"),
  "utf8",
);

const keywordItem = (key, relevanceScore) => ({
  key,
  libraryID: 1,
  title: `Keyword ${key}`,
  relevanceScore,
});

// ---- the error type itself ----

{
  const error = new VectorDimensionMismatchError(1024, 2560);
  assert.ok(error instanceof Error);
  assert.equal(error.queryDimensions, 1024);
  assert.equal(error.storedDimensions, 2560);
  assert.ok(isVectorDimensionMismatchError(error));
  assert.ok(!isVectorDimensionMismatchError(new Error("something else")));
  assert.match(error.message, /1024/);
  assert.match(error.message, /2560/);
  assert.match(
    error.message,
    /rebuild/i,
    "the message must name the remedy, not just the symptom",
  );
  // Recognisable across a structuredClone / IPC boundary that drops prototypes.
  assert.ok(
    isVectorDimensionMismatchError({
      name: "VectorDimensionMismatchError",
      message: error.message,
    }),
  );
}

// ---- hybrid_search must not pass a keyword-only ranking off as hybrid ----

{
  const run = await runHybridSearch(
    {
      query: "microtwinning in superalloys",
      topK: 5,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
      keywordSearchTimeoutMs: 2000,
      semanticBranchTimeoutMs: 2000,
    },
    {
      keywordSearch: async () => [keywordItem("K1", 0.9), keywordItem("K2", 0.5)],
      semanticSearch: async () => {
        throw new VectorDimensionMismatchError(1024, 2560);
      },
    },
  );

  assert.equal(
    run.semanticIndexIncompatible,
    true,
    "the condition must be reported as its own machine-readable flag, not left " +
      "buried in prose a client is free to ignore",
  );
  assert.equal(
    run.degraded,
    true,
    "THE REGRESSION: this run used to come back degraded:false, exactly like a " +
      "clean hybrid search",
  );
  assert.equal(run.semanticResultCount, 0);
  assert.ok(
    run.warnings.some((warning) => /incompatible/i.test(warning)),
    "a warning must name the incompatibility",
  );
  assert.ok(
    run.warnings.some((warning) => /rebuild/i.test(warning)),
    "a warning must name the remedy",
  );
  assert.ok(
    run.warnings.some((warning) => warning.includes(DIMENSION_MISMATCH_HINT)),
    "the shared wording must be used, so every tool reports this identically",
  );
  assert.ok(
    run.warnings.some((warning) => /keyword branch ALONE/.test(warning)),
    "the caller must be told these rows are keyword-only",
  );
  // The keyword results still come back: this is a degradation, not an outage.
  assert.equal(run.results.length, 2);
}

// ---- a healthy run stays clean ----

{
  const run = await runHybridSearch(
    {
      query: "healthy",
      topK: 5,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
      keywordSearchTimeoutMs: 2000,
      semanticBranchTimeoutMs: 2000,
    },
    {
      keywordSearch: async () => [keywordItem("K1", 0.9)],
      semanticSearch: async () => [
        {
          itemKey: "S1",
          libraryID: 1,
          title: "Semantic S1",
          score: 0.8,
          matchedChunks: [{ chunkId: 1, text: "S1", score: 0.8 }],
        },
      ],
    },
  );
  assert.equal(run.semanticIndexIncompatible, false);
  assert.equal(run.degraded, false);
  assert.deepEqual(run.warnings, []);
}

// ---- a genuinely empty semantic branch is NOT an incompatibility ----

{
  const run = await runHybridSearch(
    {
      query: "nothing on this topic",
      topK: 5,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
      keywordSearchTimeoutMs: 2000,
      semanticBranchTimeoutMs: 2000,
    },
    {
      keywordSearch: async () => [keywordItem("K1", 0.9)],
      semanticSearch: async () => [],
    },
  );
  assert.equal(
    run.semanticIndexIncompatible,
    false,
    "an empty semantic branch that ran correctly must not be flagged",
  );
  assert.equal(run.degraded, false);
}

// ---- an unrelated semantic failure degrades but is not an incompatibility ----

{
  const run = await runHybridSearch(
    {
      query: "embedding endpoint down",
      topK: 5,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
      keywordSearchTimeoutMs: 2000,
      semanticBranchTimeoutMs: 2000,
    },
    {
      keywordSearch: async () => [keywordItem("K1", 0.9)],
      semanticSearch: async () => {
        throw new Error("connection refused");
      },
    },
  );
  assert.equal(run.degraded, true);
  assert.equal(
    run.semanticIndexIncompatible,
    false,
    "the flag means 'rebuild the index', so it must not fire for a network error",
  );
  assert.ok(
    !run.warnings.some((warning) => warning.includes(DIMENSION_MISMATCH_HINT)),
  );
}

// ---- every scan path throws instead of returning [] ----

{
  for (const marker of [
    "throw new VectorDimensionMismatchError(queryVector.length, storedDims);",
    "throw new VectorDimensionMismatchError(\n        mismatched[0].length,\n        storedDims,\n      );",
  ]) {
    assert.ok(
      vectorStoreSource.includes(marker),
      `the scan path must throw, not return []: ${marker.slice(0, 48)}`,
    );
  }

  // The old shape must be gone from both scans.
  const singleAt = vectorStoreSource.indexOf(
    "if (storedDims !== queryVector.length) {",
  );
  const multiAt = vectorStoreSource.indexOf(
    "const mismatched = queryVectors.filter(",
  );
  assert.ok(singleAt > 0 && multiAt > 0);
  assert.ok(
    !/return \[\];/.test(vectorStoreSource.slice(singleAt, singleAt + 400)),
    "the single-query scan must no longer answer a mismatch with []",
  );
  assert.ok(
    !/return \[\];/.test(vectorStoreSource.slice(multiAt, multiAt + 500)),
    "find_similar's multi-query scan must no longer answer a mismatch with []",
  );
}

// ---- CPU and GPU report it identically ----

{
  // A mismatch must not be swallowed by the GPU-to-CPU fallback, and must not
  // mark the GPU backend broken: it is a configuration problem, not a device
  // problem, and the CPU path would only reach the same check.
  const fallbackSites = vectorStoreSource.split(
    "if (isVectorDimensionMismatchError(error)) throw error;",
  ).length - 1;
  assert.equal(
    fallbackSites,
    2,
    "both the single-query and multi-query GPU fallbacks must re-throw it",
  );
  assert.match(
    gpuServiceSource,
    /this\.residentDimensions !== request\.query\.length/,
    "the GPU path must check dimensions before dispatch, like the CPU path",
  );
  assert.match(
    gpuServiceSource,
    /throw new VectorDimensionMismatchError\(/,
    "and raise the same typed error",
  );
}

// ---- the MCP surfaces expose it ----

{
  assert.match(
    mcpSource,
    /semanticIndexIncompatible: searchResult\.semanticIndexIncompatible/,
    "hybrid_search must publish the flag on its snapshot",
  );
  assert.match(
    mcpSource,
    /semanticStatus/,
    "the response must carry an explicit degraded/error status for the branch",
  );
  assert.match(
    mcpSource,
    /if \(isVectorDimensionMismatchError\(error\)\) \{\s*\n\s*throw new Error\(`\$\{error\.message\} \$\{DIMENSION_MISMATCH_HINT\}`\)/,
    "find_similar is pure semantic, so it must fail outright with the hint",
  );
}

console.log("dimension mismatch: all assertions passed");
