/* eslint-env node */
/**
 * Choose the BM25F saturation constant by measurement rather than by taste.
 *
 * The promise being kept: turning on BM25F must not take away a document that
 * already clears the user's relevance floor. So the old scorer and the new one
 * are run over the SAME real-library candidate set, and the constant is picked
 * as the largest value for which nothing that used to pass stops passing.
 *
 * The fixture carries metadata only — no body text — which is exactly the case
 * where non-regression has to hold: body hits can only ADD score, so a
 * metadata-only comparison is the strict one.
 *
 *   node --experimental-strip-types --experimental-sqlite scripts/calibrate-bm25f-threshold.js
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
const {
  normalizeLexicalScore,
  rankLexicalCandidates,
  PROVIDED_KEYWORD_WEIGHT,
} = await import("../src/modules/hybridSearch.ts");
const { rankKeywordCandidates } = await import(
  "../src/modules/keyword/keywordRanker.ts"
);

globalThis.ztoolkit = { log: () => undefined };

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixturePath = path.join(
  rootDir,
  "scripts/fixtures/keyword-scoring-candidates.json",
);
const candidates = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const THRESHOLD = 0.6;
const LIBRARY = 1;

const QUERIES = {
  grade_single: ["FGH4096"],
  grade_multi: ["FGH4096", "superalloy", "hot deformation", "columnar grain"],
  grade_hyphen: ["Ti-6Al-4V"],
  chinese: ["定向凝固", "柱状晶", "高温合金"],
  chinese_long: ["柱状晶阵列", "定向凝固", "温度梯度", "热压成形"],
  rare_cet: ["columnar-to-equiaxed transition", "CET"],
  symbols: ["γ′", "Ni3Al"],
  bilingual_drx: ["dynamic recrystallization", "DRX", "动态再结晶"],
  broad: ["superalloy"],
  author: ["Yongquan Ning"],
  venue: ["Journal of Alloys and Compounds"],
};

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

// ---------------------------------------------------------------- build index

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bm25f-calib-"));
const sqlite = new DatabaseSync(path.join(tempDir, "calib.sqlite"));
const store = new KeywordIndexStore(adapt(sqlite));

const metadataByKey = new Map();
const buildStartedAt = Date.now();
for (const candidate of candidates) {
  const fields = candidate.fields ?? {};
  metadataByKey.set(candidate.key, {
    title: fields.title ?? "",
    abstract: fields.abstractNote ?? "",
    tags: fields.tags ?? "",
    publicationTitle: fields.publicationTitle ?? "",
    creator: fields.creator ?? "",
    extra: fields.extra ?? "",
  });
  await store.writeItem({
    libraryID: LIBRARY,
    itemKey: candidate.key,
    title: fields.title,
    abstract: fields.abstractNote,
    tags: fields.tags ? fields.tags.split(", ") : [],
    publicationTitle: fields.publicationTitle,
    creator: fields.creator,
    extra: fields.extra,
    chunks: [],
  });
}
const buildMs = Date.now() - buildStartedAt;
const stats = await store.statistics(LIBRARY);
const indexBytes = sqlite
  .prepare(
    "SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()",
  )
  .get().n;

console.log(
  `indexed ${stats.documentCount} metadata-only documents in ${buildMs}ms, ` +
    `index size ${(indexBytes / 1048576).toFixed(2)}MB`,
);
console.log(
  `average field lengths: ` +
    Object.entries(stats.averageLengths)
      .map(([field, value]) => `${field}=${value.toFixed(1)}`)
      .join(" "),
);

// ------------------------------------------------------------------- measure

const perQuery = [];
for (const [name, keywords] of Object.entries(QUERIES)) {
  const entries = keywords.map((text) => ({
    text,
    weight: PROVIDED_KEYWORD_WEIGHT,
    origin: "provided",
  }));

  const oldRanked = rankLexicalCandidates(candidates, entries, {});
  const oldPassing = new Map(
    oldRanked
      .map((item) => [item.key, normalizeLexicalScore(item.relevanceScore)])
      .filter(([, score]) => score >= THRESHOLD),
  );

  const startedAt = Date.now();
  // Metadata comes from the candidate set (whole library); body would come from
  // the index. The fixture is metadata-only, which is the strict case: body hits
  // can only ADD score, so a document that survives here survives with a body.
  const ranked = rankKeywordCandidates({
    probes: keywords.map((text) => ({ text, weight: 1 })),
    candidates,
    bodyContributions: new Map(),
    libraryDocumentCount: candidates.length,
  });
  const elapsedMs = Date.now() - startedAt;
  const rawByKey = new Map(
    ranked.map((item) => [item.key, item.relevanceScore]),
  );

  perQuery.push({
    name,
    keywords,
    oldPassing,
    rawByKey,
    outcome: { results: ranked },
    elapsedMs,
  });
}

console.log("\n=== old scorer vs new BM25F raw scores ===");
console.log(
  `${"query".padEnd(14)}${"oldPass".padStart(8)}${"newCand".padStart(8)}${"ms".padStart(6)}   min raw of the docs that used to pass`,
);
for (const entry of perQuery) {
  const rawOfPassing = [...entry.oldPassing.keys()]
    .map((key) => entry.rawByKey.get(key))
    .filter((value) => value !== undefined);
  const min = rawOfPassing.length ? Math.min(...rawOfPassing) : null;
  const missing = [...entry.oldPassing.keys()].filter(
    (key) => !entry.rawByKey.has(key),
  );
  console.log(
    `${entry.name.padEnd(14)}${String(entry.oldPassing.size).padStart(8)}` +
      `${String(entry.outcome.results.length).padStart(8)}` +
      `${String(entry.elapsedMs).padStart(6)}   ` +
      (min === null ? "—" : min.toFixed(4)) +
      (missing.length ? `   NOT RETRIEVED: ${missing.join(",")}` : ""),
  );
}

// ------------------------------------------------------- pick the constant

console.log("\n=== how many previously-passing documents survive, per K ===");
console.log(
  `${"K".padStart(6)}${"lost".padStart(7)}${"gained".padStart(8)}   ` +
    `(lost must be 0; larger K is stricter)`,
);
const rows = [];
for (const K of [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20]) {
  let lost = 0;
  let gained = 0;
  const lostKeys = [];
  for (const entry of perQuery) {
    const nowPassing = new Set(
      [...entry.rawByKey.entries()]
        .filter(([, raw]) => raw / (raw + K) >= THRESHOLD)
        .map(([key]) => key),
    );
    for (const key of entry.oldPassing.keys()) {
      if (!nowPassing.has(key)) {
        lost += 1;
        lostKeys.push(`${entry.name}/${key}`);
      }
    }
    for (const key of nowPassing) {
      if (!entry.oldPassing.has(key)) gained += 1;
    }
  }
  rows.push({ K, lost, gained, lostKeys });
  console.log(
    `${String(K).padStart(6)}${String(lost).padStart(7)}${String(gained).padStart(8)}` +
      (lost > 0 ? `   e.g. ${lostKeys.slice(0, 3).join(", ")}` : ""),
  );
}

const safe = rows.filter((row) => row.lost === 0);
const chosen = safe.length ? safe[safe.length - 1] : null;
console.log(
  chosen
    ? `\nlargest K with zero regressions: ${chosen.K} (adds ${chosen.gained} newly-passing documents)`
    : "\nno K avoids regressions — the normalisation shape itself needs revisiting",
);

try {
  sqlite.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  // Temp cleanup only.
}
