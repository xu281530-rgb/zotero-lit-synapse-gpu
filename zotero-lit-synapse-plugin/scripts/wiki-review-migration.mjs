import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { register } from "node:module";
register("./ts-ext-hooks.mjs", import.meta.url);
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");
const args = process.argv.slice(2);
const arg = (key) => args[args.indexOf(key) + 1];
if (!args.includes("--source") || !args.includes("--output"))
  throw new Error(
    "Use --source sqlite --output artifact-directory [--apply]. Without --apply only the working copy changes.",
  );
const source = path.resolve(arg("--source")),
  output = path.resolve(arg("--output"));
fs.mkdirSync(output, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(output, `wiki-before-${stamp}.sqlite`);
const reader = new DatabaseSync(source, { readOnly: true });
await backup(reader, backupPath);
reader.close();
const apply = args.includes("--apply");
const working = apply
  ? source
  : path.join(output, `wiki-reviewed-${stamp}.sqlite`);
if (!apply) fs.copyFileSync(backupPath, working);
createZoteroFake({ rootDir: output }).install();
const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const sqlite = new DatabaseSync(working);
sqlite.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON");
let depth = 0;
const db = {
  async queryAsync(sql, params = []) {
    const stmt = sqlite.prepare(sql);
    return /^\s*(SELECT|PRAGMA|WITH)/i.test(sql)
      ? stmt.all(...params)
      : (stmt.run(...params), []);
  },
  async valueQueryAsync(sql, params = []) {
    const r = sqlite.prepare(sql).get(...params);
    return r && Object.values(r)[0];
  },
  async executeTransaction(fn) {
    if (depth) return fn();
    depth++;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const r = await fn();
      sqlite.exec("COMMIT");
      return r;
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    } finally {
      depth--;
    }
  },
};
const store = new WikiStore(db);
const manifest = JSON.parse(
  fs.readFileSync(
    new URL("./wiki-legacy-review-20260906.json", import.meta.url),
    "utf8",
  ),
);
const operationId = "legacy_wiki_review_20260906_v1";
try {
  // Schema and derived summary migration precede the idempotent semantic review transaction.
  await store.initialize();
  const reviews = await store.crossPaperReviews();
  const original = sqlite
    .prepare("SELECT * FROM wiki_link_resolutions ORDER BY resolution_id")
    .all();
  const existing = await store.getCommitOperation(
    manifest.libraryID,
    operationId,
  );
  let results = [];
  if (!existing)
    await db.executeTransaction(async () => {
      await reviews.auditLegacy(manifest.libraryID, true);
      const prepared = new Map();
      for (const pair of manifest.pairs) {
        const relatedItemKeys = sqlite
          .prepare(
            `SELECT DISTINCT CASE WHEN c.a_item_key=? THEN c.b_item_key ELSE c.a_item_key END AS other
        FROM wiki_link_candidates c JOIN wiki_link_resolutions r USING(link_id) WHERE c.library_id=? AND (c.a_item_key=? OR c.b_item_key=?)`,
          )
          .all(
            pair.currentItemKey,
            manifest.libraryID,
            pair.currentItemKey,
            pair.currentItemKey,
          )
          .map((r) => r.other)
          .filter(
            (other) =>
              !manifest.pairs.some(
                (p) =>
                  p.currentItemKey === other &&
                  p.relatedItemKey === pair.currentItemKey,
              ),
          );
        if (!prepared.has(pair.currentItemKey))
          prepared.set(
            pair.currentItemKey,
            await reviews.prepare({
              libraryID: manifest.libraryID,
              itemKey: pair.currentItemKey,
              topic: manifest.scope,
              readingRevision: "legacy-evidence-review-20260906",
              relatedItemKeys,
            }),
          );
      }
      const inputs = [];
      for (const [itemKey, tasks] of prepared) {
        for (const task of tasks) {
          const pair = manifest.pairs.find(
            (p) =>
              p.currentItemKey === itemKey &&
              p.relatedItemKey === task.relatedItemKey,
          );
          // Only known historical settlements are semantically repaired by this manifest.
          const hadLegacy = original.some((r) => r.link_id === task.linkId);
          if (!hadLegacy) continue;
          if (!pair) {
            if (task.targetClaims.length)
              throw new Error(
                `Unreviewed existing Wiki targets for ${itemKey}/${task.relatedItemKey}; update the manifest.`,
              );
            inputs.push({
              taskId: task.taskId,
              expectedRevision: task.revision,
              reviewedTargets: [],
              outcomes: [
                {
                  outcome: "deferred",
                  targetClaimIds: [],
                  evidenceBindings: [],
                  basis:
                    "旧决议无法替代知识核验：相关论文尚无 Wiki Claim，当前不能据此确认无关系。",
                  gap: `等待 ${task.relatedItemKey} 建立与路径、制造条件相关的 Wiki 知识。`,
                  trigger: "target_knowledge_changed",
                },
              ],
            });
            continue;
          }
          const selected = new Set(pair.comparisons.map((c) => c.old));
          const outcomes = [];
          for (const comparison of pair.comparisons) {
            const old = await reviews.claim(comparison.old, manifest.libraryID),
              current = await reviews.claim(
                comparison.current,
                manifest.libraryID,
              );
            if (
              !old ||
              !current ||
              !old.evidence.some((e) => e.itemKey === pair.relatedItemKey) ||
              !current.evidence.some((e) => e.itemKey === pair.currentItemKey)
            )
              throw new Error("Manifest source attribution changed.");
            outcomes.push({
              outcome: "compares_with",
              targetClaimIds: [comparison.old],
              basis: comparison.statement,
              evidenceBindings: [
                ...comparison.oldEvidence.map((evidenceId) => ({
                  claimId: comparison.old,
                  evidenceId,
                })),
                ...comparison.currentEvidence.map((evidenceId) => ({
                  claimId: comparison.current,
                  evidenceId,
                })),
              ],
              relation: {
                sourceClaimId: comparison.current,
                targetClaimId: comparison.old,
                dimension: comparison.dimension,
                conditions:
                  "仅比较各论文已保存摘录所述的方法步骤、假设或制造条件；不等同算例、材料体系、载荷或硬件，不推断直接学术继承。",
                statement: comparison.statement,
              },
            });
          }
          inputs.push({
            taskId: task.taskId,
            expectedRevision: task.revision,
            reviewedTargets: task.targetClaims.map((c) => ({
              claimId: c.claimId,
              version: c.version,
              disposition: selected.has(c.claimId) ? "reviewed" : "excluded",
              basis: selected.has(c.claimId)
                ? `已对照绑定原始 Evidence 比较「${c.claimText}」，结果保留两文独立归属。`
                : `本次核验聚焦应力场、路径提取和制造条件。论断 ${c.claimId}「${c.claimText}」的具体定义、分层步骤、性能算例或失效机理不用于本次所选流程比较；未统一实验条件，不由其数值推断跨论文支持或冲突。`,
            })),
            outcomes,
          });
        }
      }
      const input = {
        libraryID: manifest.libraryID,
        userInitiated: true,
        operationId,
        actions: [],
        crossPaperReview: inputs,
      };
      const result = await store.commit(input, {
        operationId,
        inputHash: JSON.stringify(manifest),
        payload: { input, manifest, backupPath },
        beforeCommit: async () => {},
      });
      results = result.crossPaperReviews;
    });
  const legacyUnchanged =
    JSON.stringify(original) ===
    JSON.stringify(
      sqlite
        .prepare("SELECT * FROM wiki_link_resolutions ORDER BY resolution_id")
        .all(),
    );
  if (!legacyUnchanged) throw new Error("Original legacy decisions changed.");
  const report = {
    appliedToLive: apply,
    source,
    working,
    backupPath,
    operationId,
    replayed: Boolean(existing),
    legacyUnchanged,
    integrity: sqlite.prepare("PRAGMA integrity_check").get(),
    foreignKeyErrors: sqlite.prepare("PRAGMA foreign_key_check").all(),
    stats: await reviews.statistics(manifest.libraryID),
    legacyAudit: await reviews.auditLegacy(manifest.libraryID),
    results,
  };
  const reportPath = path.join(output, `review-report-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        reportPath,
        working,
        backupPath,
        appliedToLive: apply,
        replayed: report.replayed,
        stats: report.stats,
        legacyUnchanged,
      },
      null,
      2,
    ),
  );
} finally {
  sqlite.close();
}
