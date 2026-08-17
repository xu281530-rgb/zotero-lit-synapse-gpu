/* eslint-env node */
/**
 * Score the SAME real-library candidate set with the keyword scorer and report
 * every document's raw score, normalised score and pass/fail at a threshold.
 *
 * This exists to make one promise testable: adding body-keyword retrieval must
 * not take away a document that already passes the user's relevance floor. Run
 * it before a scoring change to write a baseline, and after to diff against it.
 *
 *   node --experimental-strip-types scripts/compare-keyword-scoring.js --write <file>
 *   node --experimental-strip-types scripts/compare-keyword-scoring.js --against <file>
 *
 * The candidate fixture is built from the user's own Zotero metadata; pass its
 * path with --fixture (default: scripts/fixtures/keyword-scoring-candidates.json).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

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

const fixturePath = path.resolve(
  rootDir,
  arg("--fixture", "scripts/fixtures/keyword-scoring-candidates.json"),
);
const writePath = arg("--write", null);
const againstPath = arg("--against", null);
const threshold = Number(arg("--threshold", "0.6"));

if (!fs.existsSync(fixturePath)) {
  console.error(`Candidate fixture not found: ${fixturePath}`);
  console.error(
    "Build it from the real library first, or pass --fixture <path>.",
  );
  process.exit(2);
}

const candidates = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

/**
 * Query set spanning what the feature has to get right: Chinese and English
 * terms, a rare term of art, exact material grades, symbol-bearing phase names,
 * and a term that only ever occurs in body text.
 */
const QUERIES = {
  grade_single: ["FGH4096"],
  grade_multi: ["FGH4096", "superalloy", "hot deformation", "columnar grain"],
  grade_hyphen: ["Ti-6Al-4V"],
  body_only: ["GH4169"],
  chinese: ["定向凝固", "柱状晶", "高温合金"],
  chinese_long: ["柱状晶阵列", "定向凝固", "温度梯度", "热压成形"],
  rare_cet: ["columnar-to-equiaxed transition", "CET"],
  symbols: ["γ′", "Ni3Al"],
  bilingual_drx: ["dynamic recrystallization", "DRX", "动态再结晶"],
  broad: ["superalloy"],
};

function scoreQuery(keywords) {
  const startedAt = process.hrtime.bigint();
  // Metadata only, no body contributions: the strict comparison, because body
  // evidence can only ADD score. A document that keeps passing here keeps
  // passing once its body is indexed too.
  const ranked = rankKeywordCandidates({
    probes: keywords.map((text) => ({ text, weight: 1 })),
    candidates,
    bodyContributions: new Map(),
    libraryDocumentCount: candidates.length,
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const rows = ranked.map((item) => ({
    key: item.key,
    title: (item.title || "").slice(0, 60),
    raw: Number((item.relevanceScore ?? 0).toFixed(6)),
    normalized: Number((item.normalizedScore ?? 0).toFixed(6)),
    matchedKeywords: item.matchedKeywords ?? [],
    matchedFields: item.matchedFields ?? [],
  }));
  return {
    candidates: ranked.length,
    passing: rows.filter((row) => row.normalized >= threshold).length,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    rows,
  };
}

const report = {
  threshold,
  fixture: path.relative(rootDir, fixturePath),
  queries: {},
};
for (const [name, keywords] of Object.entries(QUERIES)) {
  report.queries[name] = { keywords, ...scoreQuery(keywords) };
}

console.log(`fixture: ${report.fixture} (${candidates.length} candidates)`);
console.log(`threshold: ${threshold}\n`);
console.log(
  `${"query".padEnd(15)}${"cands".padStart(6)}${"pass".padStart(6)}${"ms".padStart(8)}   top passing (normalized)`,
);
for (const [name, result] of Object.entries(report.queries)) {
  const top = result.rows
    .filter((row) => row.normalized >= threshold)
    .slice(0, 3)
    .map((row) => `${row.normalized.toFixed(4)} ${row.title.slice(0, 30)}`)
    .join(" | ");
  console.log(
    `${name.padEnd(15)}${String(result.candidates).padStart(6)}${String(result.passing).padStart(6)}${result.elapsedMs.toFixed(2).padStart(8)}   ${top || "—"}`,
  );
}

if (writePath) {
  const target = path.resolve(rootDir, writePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nbaseline written: ${path.relative(rootDir, target)}`);
}

if (againstPath) {
  const target = path.resolve(rootDir, againstPath);
  const before = JSON.parse(fs.readFileSync(target, "utf8"));
  let regressions = 0;
  let gains = 0;
  console.log(`\n=== diff against ${path.relative(rootDir, target)} ===`);
  for (const [name, after] of Object.entries(report.queries)) {
    const prior = before.queries?.[name];
    if (!prior) continue;
    const priorPassing = new Map(
      prior.rows
        .filter((r) => r.normalized >= before.threshold)
        .map((r) => [r.key, r.normalized]),
    );
    const nowPassing = new Map(
      after.rows
        .filter((r) => r.normalized >= threshold)
        .map((r) => [r.key, r.normalized]),
    );
    const lost = [...priorPassing.keys()].filter((key) => !nowPassing.has(key));
    const added = [...nowPassing.keys()].filter(
      (key) => !priorPassing.has(key),
    );
    regressions += lost.length;
    gains += added.length;
    console.log(
      `${name.padEnd(15)} pass ${String(priorPassing.size).padStart(3)} -> ${String(nowPassing.size).padEnd(3)}` +
        `  lost=${lost.length} gained=${added.length}` +
        (lost.length ? `  LOST: ${lost.join(",")}` : ""),
    );
  }
  console.log(
    `\ntotal documents that STOPPED passing: ${regressions}  (must be 0)\n` +
      `total documents that STARTED passing: ${gains}`,
  );
  if (regressions > 0) process.exitCode = 1;
}
