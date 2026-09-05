/* eslint-env node */
/**
 * Build the body-keyword index from REAL stored chunks and measure it.
 *
 * Reads the passages the vector index actually holds — the same text production
 * would hand the keyword index — so build time, index size and query latency are
 * measured on this library rather than estimated.
 *
 *   node --experimental-strip-types --experimental-sqlite \
 *     scripts/benchmark-keyword-index.js --vectors <path to zotero-lit-synapse-vectors.sqlite copy>
 *
 * Never point it at the live database: pass a COPY. It only reads, but Zotero
 * holds a write lock while running.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { KeywordIndexStore } = await import(
  "../src/modules/keyword/keywordIndexStore.ts"
);
const { runBodyKeywordSearch } = await import(
  "../src/modules/keyword/bodyKeywordSearch.ts"
);
const { normalizeBm25fScore } = await import("../src/modules/keyword/bm25f.ts");
const { rankKeywordCandidates } = await import(
  "../src/modules/keyword/keywordRanker.ts"
);

globalThis.ztoolkit = { log: () => undefined };

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const vectorsPath = arg("--vectors", null);
const dedupe = !process.argv.includes("--keep-duplicate-bodies");
if (!vectorsPath || !fs.existsSync(vectorsPath)) {
  console.error("Pass --vectors <path to a COPY of zotero-lit-synapse-vectors.sqlite>");
  process.exit(2);
}

const LIBRARY = 1;
const THRESHOLD = 0.6;

function adapt(sqlite) {
  let depth = 0;
  return {
    async queryAsync(sql, params = []) {
      const statement = sqlite.prepare(sql);
      if (/^\s*(select|pragma)/iu.test(sql)) return statement.all(...params);
      statement.run(...params);
      return [];
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

// ------------------------------------------------- read the real stored chunks

const vectors = new DatabaseSync(
  `file:${vectorsPath.replace(/\\/g, "/")}?mode=ro`,
);
const chunkRows = vectors
  .prepare(
    "SELECT item_key, chunk_id, chunk_text FROM embeddings ORDER BY item_key, chunk_id",
  )
  .all();

const chunksByItem = new Map();
for (const row of chunkRows) {
  // Storage keys carry a library prefix only for non-user libraries.
  const itemKey = String(row.item_key).includes(":")
    ? String(row.item_key).split(":").slice(1).join(":")
    : String(row.item_key);
  if (!chunksByItem.has(itemKey)) chunksByItem.set(itemKey, []);
  chunksByItem.get(itemKey)[Number(row.chunk_id)] = row.chunk_text ?? "";
}

let duplicateChunks = 0;
if (dedupe) {
  // The extraction bug indexes some bodies twice (a MinerU full.md typed
  // text/plain bypasses the markdown de-duplication). A duplicated body doubles
  // every term frequency AND the document length, so BM25F would be measured on
  // statistics production should not have.
  for (const [itemKey, chunks] of chunksByItem) {
    const seen = new Set();
    const kept = [];
    chunks.forEach((text, index) => {
      const fingerprint = (text ?? "").trim();
      if (fingerprint && seen.has(fingerprint)) {
        duplicateChunks += 1;
        kept[index] = "";
        return;
      }
      if (fingerprint) seen.add(fingerprint);
      kept[index] = text ?? "";
    });
    chunksByItem.set(itemKey, kept);
  }
}

const fixturePath = path.join(
  rootDir,
  "scripts/fixtures/keyword-scoring-candidates.json",
);
const metadataByKey = new Map();
if (fs.existsSync(fixturePath)) {
  for (const candidate of JSON.parse(fs.readFileSync(fixturePath, "utf8"))) {
    const fields = candidate.fields ?? {};
    metadataByKey.set(candidate.key, {
      title: fields.title ?? "",
      abstract: fields.abstractNote ?? "",
      tags: fields.tags ?? "",
      publicationTitle: fields.publicationTitle ?? "",
      creator: fields.creator ?? "",
      extra: fields.extra ?? "",
    });
  }
}

const totalChunkChars = [...chunksByItem.values()]
  .flat()
  .reduce((sum, text) => sum + (text?.length ?? 0), 0);
console.log(
  `source: ${chunksByItem.size} documents, ${chunkRows.length} stored chunks, ` +
    `${(totalChunkChars / 1e6).toFixed(2)}M chars` +
    (dedupe
      ? `, ${duplicateChunks} duplicate chunks excluded`
      : ", duplicates kept"),
);

// ------------------------------------------------------------------ build

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kw-bench-"));
const indexPath = path.join(tempDir, "keyword.sqlite");
const sqlite = new DatabaseSync(indexPath);
const store = new KeywordIndexStore(adapt(sqlite));

let totalPostings = 0;
const perItemMs = [];
const buildStartedAt = Date.now();
for (const [itemKey, chunks] of chunksByItem) {
  const metadata = metadataByKey.get(itemKey) ?? {};
  const startedAt = Date.now();
  const result = await store.writeItem({
    libraryID: LIBRARY,
    itemKey,
    title: metadata.title,
    abstract: metadata.abstract,
    tags: metadata.tags ? metadata.tags.split(", ") : [],
    publicationTitle: metadata.publicationTitle,
    creator: metadata.creator,
    extra: metadata.extra,
    chunks: chunks.map((text) => text ?? ""),
  });
  perItemMs.push(Date.now() - startedAt);
  totalPostings += result.postings;
}
const buildMs = Date.now() - buildStartedAt;
sqlite.exec("VACUUM");

const indexBytes = fs.statSync(indexPath).size;
const stats = await store.statistics(LIBRARY);
const termCount = sqlite.prepare("SELECT COUNT(*) AS n FROM kw_terms").get().n;

perItemMs.sort((a, b) => a - b);
console.log(
  `\nbuild: ${buildMs}ms total, ${(buildMs / chunksByItem.size).toFixed(0)}ms/document ` +
    `(median ${perItemMs[Math.floor(perItemMs.length / 2)]}ms, max ${perItemMs[perItemMs.length - 1]}ms)`,
);
console.log(
  `index: ${(indexBytes / 1048576).toFixed(2)}MB, ${termCount} terms, ${totalPostings} postings ` +
    `(${(indexBytes / Math.max(1, totalPostings)).toFixed(1)} bytes/posting)`,
);
console.log(
  `average field lengths: ` +
    Object.entries(stats.averageLengths)
      .map(([field, value]) => `${field}=${value.toFixed(1)}`)
      .join(" "),
);

// ------------------------------------------------------------------- query

const resolver = {
  async chunkTexts(libraryID, pairs) {
    const out = new Map();
    for (const pair of pairs) {
      const text = chunksByItem.get(pair.itemKey)?.[pair.chunkId];
      if (text !== undefined) out.set(`${pair.itemKey}:${pair.chunkId}`, text);
    }
    return out;
  },
  async metadataTexts(libraryID, itemKeys) {
    const out = new Map();
    for (const key of itemKeys) {
      const metadata = metadataByKey.get(key);
      if (metadata) out.set(key, metadata);
    }
    return out;
  },
};

/** The behaviours the feature was specified to deliver, one query each. */
const BATTERY = [
  // Body-only terms: present in real body prose of 7-8 papers, in the metadata
  // of none. These are the cases metadata search structurally cannot answer.
  ["body-only term", ["dislocation-free"]],
  ["body-only term 2", ["subgrains"]],
  // Present ONLY inside reference-list entries in this library, so the correct
  // answer is nothing — the bibliography is deliberately not indexed.
  ["references-only term", ["GH4169"]],
  // Present only under an "Acknowledgments" heading, which is stripped.
  ["boilerplate-only term", ["acknowledgments"]],
  ["grade in title+body", ["FGH4096"]],
  ["hyphenated grade", ["Ti-6Al-4V"]],
  ["solid spelling of it", ["Ti6Al4V"]],
  ["symbol phase name", ["γ′"]],
  ["spelled phase name", ["gamma prime"]],
  ["rare term of art", ["columnar-to-equiaxed transition"]],
  ["abbreviation", ["DRX"]],
  ["chemical formula", ["Ni3Al"]],
  ["Chinese 4-char term", ["定向凝固"]],
  ["Chinese 3-char term", ["柱状晶"]],
  ["Chinese long term", ["柱状晶阵列"]],
  ["multi-word phrase", ["dynamic recrystallization"]],
  [
    "bilingual set",
    ["定向凝固", "柱状晶", "directional solidification", "columnar grain"],
  ],
  ["broad word", ["superalloy"]],
];

console.log(`\n=== query battery (threshold ${THRESHOLD}) ===`);
console.log(
  `${"case".padEnd(23)}${"docs".padStart(5)}${"pass".padStart(6)}${"ms".padStart(6)}` +
    `${"rejct".padStart(7)}   top result (normalized)`,
);
const latencies = [];
for (const [label, keywords] of BATTERY) {
  const startedAt = process.hrtime.bigint();
  const outcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes: keywords.map((text) => ({ text, weight: 1 })),
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  latencies.push(elapsedMs);
  const passing = outcome.results.filter(
    (result) => normalizeBm25fScore(result.score) >= THRESHOLD,
  );
  const top = outcome.results[0];
  console.log(
    `${label.padEnd(23)}${String(outcome.results.length).padStart(5)}` +
      `${String(passing.length).padStart(6)}${elapsedMs.toFixed(1).padStart(6)}` +
      `${String(outcome.diagnostics.rejectedByVerification).padStart(7)}   ` +
      (top
        ? `${normalizeBm25fScore(top.score).toFixed(4)} ${top.itemKey} [${top.matchedFields.join("+")}]`
        : "—"),
  );
}
latencies.sort((a, b) => a - b);
console.log(
  `\nlatency: median ${latencies[Math.floor(latencies.length / 2)].toFixed(1)}ms, ` +
    `max ${latencies[latencies.length - 1].toFixed(1)}ms`,
);

// ------------------------------------------- title vs body ordering, in detail

console.log(`\n=== title hit vs body hit, same term (FGH4096) ===`);
const ordering = await runBodyKeywordSearch(store, resolver, {
  libraryID: LIBRARY,
  probes: [{ text: "FGH4096", weight: 1 }],
});
for (const result of ordering.results.slice(0, 8)) {
  const title = (metadataByKey.get(result.itemKey)?.title ?? "").slice(0, 46);
  console.log(
    `  ${normalizeBm25fScore(result.score).toFixed(4)}  ` +
      `${result.matchedFields.join("+").padEnd(30)} ${result.itemKey}  ${title}`,
  );
}

console.log(`\n=== body-only term (GH4169): where the evidence comes from ===`);
const bodyOnly = await runBodyKeywordSearch(store, resolver, {
  libraryID: LIBRARY,
  probes: [{ text: "dislocation-free", weight: 1 }],
});
for (const result of bodyOnly.results.slice(0, 5)) {
  console.log(
    `  ${normalizeBm25fScore(result.score).toFixed(4)}  ${result.itemKey}  ` +
      `fields=${result.matchedFields.join("+")}  chunks=${result.evidence
        .map((chunk) => chunk.chunkId)
        .join(",")}`,
  );
  const first = result.evidence[0];
  if (first?.text) {
    const at = first.text.toLowerCase().indexOf("dislocation-free");
    console.log(
      `           …${first.text.slice(Math.max(0, at - 55), at + 55).replace(/\s+/g, " ")}…`,
    );
  }
}

// ------------------------------------------- production-equivalent scoring
//
// The battery above exercises the BODY half alone, over the 26 indexed papers.
// That is the right way to see what the index can find, but its scores are NOT
// the ones a user sees: in production the metadata fields are scored from the
// live items over the WHOLE library, and idf uses the library's document count.
// With 26 documents idf collapses (df=3 gives 2.04 where 931 documents give
// 5.58), so the "pass" column above understates every score. This section runs
// the combined ranker the way hybrid_search does.

const candidatesForRanking = JSON.parse(
  fs.readFileSync(fixturePath, "utf8"),
).map((candidate) => ({
  key: candidate.key,
  libraryID: candidate.libraryID,
  title: candidate.title,
  fields: candidate.fields,
  metadata: candidate.metadata,
}));
const libraryDocumentCount = candidatesForRanking.length;

// Library-level metadata averages, from the same provider production uses.
const { LibraryFieldStats } = await import(
  "../src/modules/keyword/libraryFieldStats.ts"
);
const libraryAverages = (
  await new LibraryFieldStats({
    async signature() {
      return `fixture:${libraryDocumentCount}`;
    },
    async readFields() {
      return candidatesForRanking.map((candidate) => candidate.fields ?? {});
    },
  }).get(LIBRARY)
).averageLengths;

console.log(
  `
=== combined ranker, as hybrid_search runs it ` +
    `(N=${libraryDocumentCount} library documents, body index=${chunksByItem.size}) ===`,
);
console.log(
  `${"case".padEnd(23)}${"docs".padStart(5)}${"pass".padStart(6)}${"bodyOnly".padStart(9)}${"ms".padStart(6)}   top result`,
);

for (const [label, keywords] of BATTERY) {
  const probes = keywords.map((text) => ({ text, weight: 1 }));
  const startedAt = process.hrtime.bigint();
  const bodyOutcome = await runBodyKeywordSearch(store, resolver, {
    libraryID: LIBRARY,
    probes,
    includeFields: ["body"],
  });
  const bodyContributions = new Map(
    bodyOutcome.results.map((result) => [
      result.itemKey,
      {
        itemKey: result.itemKey,
        frequencies: result.bodyFrequencies,
        bodyLength: result.bodyLength,
        evidence: result.evidence,
      },
    ]),
  );
  const ranked = rankKeywordCandidates({
    probes,
    candidates: candidatesForRanking,
    bodyContributions,
    libraryDocumentCount,
    // The body collection is the indexed subset, not the library: that is the
    // whole point of the per-regime IDF.
    bodyDocumentCount: stats.documentCount,
    averageFieldLengths: libraryAverages,
    averageBodyLength: stats.averageLengths.body,
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const passing = ranked.filter((item) => item.normalizedScore >= THRESHOLD);
  const metadataOnlyKeys = new Set(
    ranked
      .filter((item) => !item.matchedFields.includes("body"))
      .map((item) => item.key),
  );
  const bodyOnly = ranked.filter(
    (item) =>
      item.matchedFields.length === 1 && item.matchedFields[0] === "body",
  ).length;
  void metadataOnlyKeys;
  const top = ranked[0];
  console.log(
    `${label.padEnd(23)}${String(ranked.length).padStart(5)}` +
      `${String(passing.length).padStart(6)}${String(bodyOnly).padStart(9)}` +
      `${elapsedMs.toFixed(1).padStart(6)}   ` +
      (top
        ? `${top.normalizedScore.toFixed(4)} [${top.matchedFields.join("+")}] ${(top.title || top.key).slice(0, 40)}`
        : "—"),
  );
}

try {
  vectors.close();
  sqlite.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  // Temp cleanup only.
}
