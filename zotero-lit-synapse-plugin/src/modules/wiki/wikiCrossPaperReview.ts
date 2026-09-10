import type { WikiDatabase, WikiClaimRecord } from "./wikiTypes";
import { rowColumn } from "./wikiRow";
import { mapWikiEvidenceRow } from "./wikiDto";
import {
  boundPreparedContext,
  pagePreparedContext,
  type WikiPreparedContext,
} from "./wikiPreparedContext";
import { hashWikiText, normalizeWikiText } from "./wikiCanonicalizer";
import {
  CLAIM_RELATION_TYPES,
  CROSS_PAPER_PROTOCOL_VERSION,
  type CrossPaperReviewInput,
  type MissingTargetSelection,
  type CrossPaperOutcome,
  type ReviewEvidenceBinding,
  type EvidenceAssessmentInput,
} from "./wikiReviewTypes";

const col = (row: any, name: string): any =>
  rowColumn(
    row,
    name,
    name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
  );

export async function ensureCrossPaperSchema(db: WikiDatabase): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS wiki_cross_paper_tasks (
      task_id INTEGER PRIMARY KEY AUTOINCREMENT, library_id INTEGER NOT NULL,
      current_item_key TEXT NOT NULL, related_item_key TEXT NOT NULL,
      link_id INTEGER NOT NULL, topic TEXT NOT NULL, reading_revision TEXT NOT NULL,
      revision TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','reviewed','deferred','superseded')),
      current_review_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(library_id,current_item_key,related_item_key,topic))`,
    `CREATE TABLE IF NOT EXISTS wiki_cross_paper_reviews (
      review_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
      operation_id TEXT NOT NULL, supersedes INTEGER, input_json TEXT NOT NULL,
      result_json TEXT NOT NULL, dependencies_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS wiki_claim_relations (
      relation_id INTEGER PRIMARY KEY AUTOINCREMENT, library_id INTEGER NOT NULL,
      source_claim_id INTEGER NOT NULL, target_claim_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL, dimension TEXT NOT NULL, conditions TEXT NOT NULL,
      statement TEXT NOT NULL, evidence_json TEXT NOT NULL, dependencies_json TEXT NOT NULL,
      task_id INTEGER NOT NULL, review_id INTEGER NOT NULL, identity TEXT NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(library_id,identity,review_id))`,
    `CREATE TABLE IF NOT EXISTS wiki_evidence_assessments (
      assessment_id INTEGER PRIMARY KEY AUTOINCREMENT, library_id INTEGER NOT NULL,
      claim_id INTEGER NOT NULL, assessment_json TEXT NOT NULL,
      dependencies_json TEXT NOT NULL, operation_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS wiki_legacy_review_audit (
      resolution_id INTEGER PRIMARY KEY, validity TEXT NOT NULL, reasons_json TEXT NOT NULL,
      audited_at INTEGER NOT NULL, protocol_version INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_wiki_review_task_source ON wiki_cross_paper_tasks(library_id,current_item_key,state)`,
    `CREATE INDEX IF NOT EXISTS idx_wiki_review_history ON wiki_cross_paper_reviews(task_id,review_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wiki_claim_relation_source ON wiki_claim_relations(source_claim_id,target_claim_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wiki_assessment_claim ON wiki_evidence_assessments(claim_id,assessment_id)`,
  ];
  for (const sql of statements) await db.queryAsync(sql);
}

function requiredText(value: unknown, name: string): string {
  const text = normalizeWikiText(String(value ?? ""));
  if (!text)
    throw new Error(
      `${name} must explain the specific knowledge and evidence.`,
    );
  return text;
}

function resolveId(
  value: number | string | undefined,
  refs: Record<string, number>,
): number {
  const id = typeof value === "string" ? (refs[value] ?? Number(value)) : value;
  if (!Number.isSafeInteger(id) || Number(id) < 1)
    throw new Error(`Invalid knowledge reference: ${value}`);
  return Number(id);
}

export function claimDependency(claim: any): string {
  return JSON.stringify({
    id: claim.claimId,
    version: claim.version,
    text: claim.claimText,
    pageId: claim.pageId,
    evidence: (claim.evidence ?? [])
      .map((e: any) => [
        e.evidenceId,
        e.itemKey,
        e.excerptHash,
        e.evidenceRole,
        e.linkState,
        e.readDepth,
        e.sourceContentHash,
        e.sourceChunkSignature,
        e.sourceResetGeneration,
      ])
      .sort((a: any[], b: any[]) => a[0] - b[0]),
  });
}

/** Owns review snapshots and their bindings; it never asks an LLM to judge a relation. */
export class WikiCrossPaperReview {
  private db: WikiDatabase;
  private checkSources: () => Promise<void>;
  constructor(
    db: WikiDatabase,
    checkSources: () => Promise<void> = async () => {},
  ) {
    this.db = db;
    this.checkSources = checkSources;
  }

  async claim(claimId: number, libraryID?: number): Promise<any | null> {
    await this.checkSources();
    const rows = await this.db.queryAsync(
      `SELECT c.*,p.library_id,p.canonical_title,p.primary_concept_id
      FROM wiki_claims c JOIN wiki_pages p ON p.page_id=c.page_id WHERE c.claim_id=?`,
      [claimId],
    );
    if (
      !rows.length ||
      (libraryID !== undefined &&
        Number(col(rows[0], "library_id")) !== libraryID)
    )
      return null;
    const r = rows[0];
    const evidence = await this.db.queryAsync(
      "SELECT * FROM wiki_evidence WHERE claim_id=? ORDER BY evidence_id",
      [claimId],
    );
    await this.checkSources();
    return {
      claimId,
      pageId: Number(col(r, "page_id")),
      libraryID: Number(col(r, "library_id")),
      pageTitle: String(col(r, "canonical_title")),
      primaryConceptId: col(r, "primary_concept_id"),
      claimText: String(col(r, "claim_text")),
      claimType: String(col(r, "claim_type")),
      version: Number(col(r, "version")),
      evidence: evidence.map(mapWikiEvidenceRow),
    };
  }

  private async claimsFor(libraryID: number, itemKey: string): Promise<any[]> {
    const rows = await this.db.queryAsync(
      `SELECT DISTINCT c.claim_id FROM wiki_claims c
      JOIN wiki_pages p ON p.page_id=c.page_id JOIN wiki_evidence e ON e.claim_id=c.claim_id
      WHERE p.library_id=? AND e.library_id=? AND e.item_key=? ORDER BY c.claim_id`,
      [libraryID, libraryID, itemKey],
    );
    const claims = [];
    for (const r of rows) {
      const claim = await this.claim(Number(col(r, "claim_id")), libraryID);
      if (claim) claims.push(claim);
    }
    return claims;
  }

  private mapTask(r: any): any {
    return {
      taskId: Number(col(r, "task_id")),
      libraryID: Number(col(r, "library_id")),
      currentItemKey: String(col(r, "current_item_key")),
      relatedItemKey: String(col(r, "related_item_key")),
      linkId: Number(col(r, "link_id")),
      topic: String(col(r, "topic")),
      readingRevision: String(col(r, "reading_revision")),
      revision: String(col(r, "revision")),
      state: String(col(r, "state")),
      currentReviewId:
        col(r, "current_review_id") == null
          ? null
          : Number(col(r, "current_review_id")),
      ...JSON.parse(String(col(r, "snapshot_json"))),
    };
  }

  async task(taskId: number, libraryID: number): Promise<any | null> {
    const rows = await this.db.queryAsync(
      "SELECT * FROM wiki_cross_paper_tasks WHERE task_id=? AND library_id=?",
      [taskId, libraryID],
    );
    return rows.length ? this.mapTask(rows[0]) : null;
  }

  /** Only prepare/commit writes task state; graph and history reads remain observational. */
  async prepare(options: {
    libraryID: number;
    itemKey: string;
    topic: string;
    readingRevision?: string;
    relatedItemKeys?: string[];
  }): Promise<any[]> {
    const { libraryID, itemKey } = options;
    const pairs = await this.db.queryAsync(
      `SELECT * FROM wiki_link_candidates
      WHERE library_id=? AND (a_item_key=? OR b_item_key=?) AND status NOT IN ('source_deleted','stale') ORDER BY link_id`,
      [libraryID, itemKey, itemKey],
    );
    const tasks = [];
    for (const p of pairs) {
      const linkId = Number(col(p, "link_id"));
      const relatedItemKey =
        String(col(p, "a_item_key")) === itemKey
          ? String(col(p, "b_item_key"))
          : String(col(p, "a_item_key"));
      if (
        options.relatedItemKeys &&
        !options.relatedItemKeys.includes(relatedItemKey)
      )
        continue;
      const signals = await this.db.queryAsync(
        `SELECT signal_id,signal_type,term_snapshot,algorithm_version,
        a_excerpt,b_excerpt,state FROM wiki_link_signals WHERE link_id=? AND state!='stale' ORDER BY signal_id`,
        [linkId],
      );
      if (!signals.length) continue;
      const discoveryBasis = signals.map((s) => ({
        signalId: Number(col(s, "signal_id")),
        type: String(col(s, "signal_type")),
        term: String(col(s, "term_snapshot") ?? ""),
        algorithm: String(col(s, "algorithm_version")),
        aExcerpt: String(col(s, "a_excerpt") ?? ""),
        bExcerpt: String(col(s, "b_excerpt") ?? ""),
      }));
      const targets = await this.claimsFor(libraryID, relatedItemKey);
      const words = new Set(
        (options.topic + " " + discoveryBasis.map((s) => s.term).join(" "))
          .toLowerCase()
          .match(/[a-z0-9-]{3,}|[\u3400-\u9fff]{2,}/g) ?? [],
      );
      const targetClaims = targets
        .map((claim) => {
          const matched = [...words].filter((w) =>
            (claim.claimText + " " + claim.pageTitle).toLowerCase().includes(w),
          );
          return {
            ...claim,
            dependency: claimDependency(claim),
            suggested: matched.length > 0,
            selectionBasis: matched.length
              ? `Topic matches: ${matched.join(", ")}`
              : "Candidate paper knowledge; reader must select or explain exclusion.",
          };
        })
        .sort(
          (a, b) =>
            Number(b.suggested) - Number(a.suggested) || a.claimId - b.claimId,
        );
      const snapshot = {
        signalIds: discoveryBasis.map((s) => s.signalId),
        discoveryBasis,
        targetClaims,
        recallStatus: "complete",
        targetCount: targetClaims.length,
        gap: targetClaims.length
          ? null
          : "The related paper has no Wiki claims yet.",
      };
      const readingRevision = options.readingRevision ?? "";
      const baseRevision = await hashWikiText(
        JSON.stringify({
          readingRevision,
          signals: discoveryBasis,
          targets: targetClaims
            .map((c) => [c.claimId, c.dependency])
            .sort((a, b) => Number(a[0]) - Number(b[0])),
        }),
      );
      const existing = await this.db.queryAsync(
        `SELECT * FROM wiki_cross_paper_tasks WHERE library_id=?
        AND current_item_key=? AND related_item_key=? AND topic=?`,
        [libraryID, itemKey, relatedItemKey, options.topic],
      );
      let previous: any = existing.length ? this.mapTask(existing[0]) : null;
      const revision = await hashWikiText(
        `${baseRevision}:${previous?.currentReviewId ?? 0}`,
      );
      let state = previous?.state ?? "pending";
      let latest: any = null;
      if (previous?.currentReviewId)
        latest = await this.review(previous.currentReviewId);
      const noiseOnly = latest?.input?.outcomes?.every(
        (o: any) => o.outcome === "noise",
      );
      const sameDiscovery =
        previous &&
        JSON.stringify(previous.discoveryBasis) ===
          JSON.stringify(discoveryBasis);
      if (
        previous &&
        previous.revision !== revision &&
        !(noiseOnly && sameDiscovery)
      )
        state = "pending";
      if (
        latest &&
        !noiseOnly &&
        !(await this.dependenciesValid(latest.dependencies))
      )
        state = "pending";
      const now = Date.now();
      await this.db.queryAsync(
        `INSERT INTO wiki_cross_paper_tasks
        (library_id,current_item_key,related_item_key,link_id,topic,reading_revision,revision,snapshot_json,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(library_id,current_item_key,related_item_key,topic)
        DO UPDATE SET reading_revision=excluded.reading_revision,revision=excluded.revision,
        snapshot_json=excluded.snapshot_json,state=excluded.state,updated_at=excluded.updated_at`,
        [
          libraryID,
          itemKey,
          relatedItemKey,
          linkId,
          options.topic,
          readingRevision,
          revision,
          JSON.stringify(snapshot),
          state,
          now,
          now,
        ],
      );
      const row = await this.db.queryAsync(
        `SELECT * FROM wiki_cross_paper_tasks WHERE library_id=? AND current_item_key=? AND related_item_key=? AND topic=?`,
        [libraryID, itemKey, relatedItemKey, options.topic],
      );
      const task = this.mapTask(row[0]);
      // `pending` says the task has not been reviewed against the current
      // revision. It is NOT an obligation: cross-paper review deepens the Wiki,
      // it does not gate writing this paper's own knowledge down, and shipping
      // it as `required: true` made a 47-chunk paper wait on 37 Claims from
      // three unrelated papers. `wiki_commit` reads `pending` and reports the
      // count; nothing throws on it.
      task.pending = state === "pending";
      task.required = false;
      task.previousReview = latest;
      task.changedTargetIds = targetClaims
        .filter(
          (c) =>
            !previous?.targetClaims?.some(
              (old: any) =>
                old.claimId === c.claimId && old.dependency === c.dependency,
            ),
        )
        .map((c) => c.claimId);
      tasks.push(task);
    }
    return tasks;
  }

  async validateSnapshots(
    libraryID: number,
    inputs: CrossPaperReviewInput[],
  ): Promise<void> {
    const seen = new Set<number>();
    for (const input of inputs) {
      if (seen.has(input.taskId))
        throw new Error(`Duplicate cross-paper task ${input.taskId}`);
      seen.add(input.taskId);
      const task = await this.task(input.taskId, libraryID);
      if (!task || task.revision !== input.expectedRevision)
        throw new Error(
          `Cross-paper task ${input.taskId} changed; prepare it again.`,
        );
      for (const old of task.targetClaims) {
        const current = await this.claim(old.claimId, libraryID);
        if (!current || claimDependency(current) !== old.dependency)
          throw new Error(
            `Claim ${old.claimId} changed; re-review the affected target in task ${task.taskId}.`,
          );
      }
    }
  }

  async missingTargetDeferrals(
    libraryID: number,
    selections: MissingTargetSelection[],
    explicit: CrossPaperReviewInput[] = [],
  ): Promise<CrossPaperReviewInput[]> {
    if (!Array.isArray(selections) || !Array.isArray(explicit))
      throw new Error(
        "deferMissingTargets and crossPaperReview must be arrays.",
      );
    const seen = new Set(explicit.map((input) => input.taskId));
    const result = [...explicit];
    for (const selection of selections) {
      if (
        !Number.isSafeInteger(selection?.taskId) ||
        selection.taskId < 1 ||
        typeof selection.expectedRevision !== "string" ||
        !selection.expectedRevision
      )
        throw new Error(
          "Each deferred task requires taskId and expectedRevision.",
        );
      if (seen.has(selection.taskId))
        throw new Error(`Duplicate cross-paper task ${selection.taskId}`);
      seen.add(selection.taskId);
      const task = await this.task(selection.taskId, libraryID);
      if (!task || task.revision !== selection.expectedRevision)
        throw new Error(
          `Cross-paper task ${selection.taskId} changed or belongs to another library; prepare it again.`,
        );
      if (
        task.targetClaims.length ||
        (await this.claimsFor(libraryID, task.relatedItemKey)).length
      )
        throw new Error(
          `Task ${task.taskId} has target knowledge to review; it cannot use missing-target deferral.`,
        );
      result.push({
        taskId: task.taskId,
        expectedRevision: task.revision,
        reviewedTargets: [],
        outcomes: [
          {
            outcome: "deferred",
            targetClaimIds: [],
            evidenceBindings: [],
            basis:
              "The reader selected this task for deferral because the related paper has no Wiki Claims available for comparison.",
            gap: `${task.relatedItemKey} has no Wiki Claims yet.`,
            trigger: "target_knowledge_changed",
          },
        ],
      });
    }
    return result;
  }

  private async bindings(
    libraryID: number,
    entries: ReviewEvidenceBinding[],
    refs: Record<string, number>,
  ): Promise<any[]> {
    const found: any[] = [];
    for (const entry of entries ?? []) {
      const claim = await this.claim(resolveId(entry.claimId, refs), libraryID);
      if (!claim)
        throw new Error(
          "Evidence binding Claim does not belong to this library.",
        );
      const matching = claim.evidence.filter((e: any) =>
        entry.evidenceId != null
          ? e.evidenceId === entry.evidenceId
          : entry.itemKey === e.itemKey &&
            normalizeWikiText(String(entry.excerpt ?? "")) ===
              normalizeWikiText(e.excerpt),
      );
      if (matching.length !== 1 || matching[0].linkState !== "valid")
        throw new Error(
          `Claim ${claim.claimId} needs one exact, currently valid Evidence binding.`,
        );
      const e = matching[0];
      if (!found.some((v) => v.evidenceId === e.evidenceId))
        found.push({ ...e });
    }
    return found;
  }

  private async dependencies(ids: number[], libraryID: number): Promise<any[]> {
    const result = [];
    for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
      const claim = await this.claim(id, libraryID);
      if (!claim)
        throw new Error(
          `Claim ${id} is missing or belongs to another library.`,
        );
      result.push({
        claimId: id,
        libraryID,
        dependency: claimDependency(claim),
      });
    }
    return result;
  }

  async dependenciesValid(dependencies: any[]): Promise<boolean> {
    for (const d of dependencies) {
      if (d.kind === "concept_relation") {
        if (
          JSON.stringify(
            await this.conceptDependency(
              d.relationId,
              d.libraryID,
              d.sourceIds,
            ),
          ) !== JSON.stringify(d.snapshot)
        )
          return false;
        continue;
      }
      const claim = await this.claim(d.claimId, d.libraryID);
      if (!claim || claimDependency(claim) !== d.dependency) return false;
    }
    return true;
  }

  async commit(
    libraryID: number,
    operationId: string,
    inputs: CrossPaperReviewInput[],
    refs: Record<string, number>,
  ): Promise<any[]> {
    const results = [];
    for (const input of inputs) {
      const task = await this.task(input.taskId, libraryID);
      if (!task) throw new Error(`Unknown cross-paper task ${input.taskId}`);
      if (
        !task.targetClaims.length &&
        (await this.claimsFor(libraryID, task.relatedItemKey)).length
      )
        throw new Error(
          `Task ${task.taskId} target knowledge changed; prepare and review the new Claims.`,
        );
      const targetIds = new Set<number>(
        task.targetClaims.map((c: any) => c.claimId),
      );
      const dispositions = new Map<number, string>();
      for (const v of input.reviewedTargets ?? []) {
        const old = task.targetClaims.find((c: any) => c.claimId === v.claimId);
        if (
          !old ||
          old.version !== v.version ||
          dispositions.has(v.claimId) ||
          !["reviewed", "excluded", "deferred"].includes(v.disposition)
        )
          throw new Error(`Invalid target disposition for Claim ${v.claimId}`);
        requiredText(v.basis, "Target basis");
        dispositions.set(v.claimId, v.disposition);
      }
      if (dispositions.size !== targetIds.size)
        throw new Error(
          `Task ${task.taskId} requires a review, exclusion reason or explicit deferral for every target.`,
        );
      if (!input.outcomes?.length)
        throw new Error(`Task ${task.taskId} needs a concrete outcome.`);
      const normalized: any[] = [];
      const covered = new Set<number>();
      const dependencyIds: number[] = [];
      const conceptDependencies: any[] = [];
      for (const outcome of input.outcomes) {
        requiredText(outcome.basis, "Outcome basis");
        for (const id of outcome.targetClaimIds ?? []) {
          if (!targetIds.has(id))
            throw new Error(
              `Outcome references Claim ${id} outside task ${task.taskId}`,
            );
          covered.add(id);
        }
        const bindings = await this.bindings(
          libraryID,
          outcome.evidenceBindings,
          refs,
        );
        const resultIds = (outcome.resultRefs?.claimIds ?? []).map((id) =>
          resolveId(id, refs),
        );
        const ids = [
          ...new Set([...resultIds, ...bindings.map((e) => e.claimId)]),
        ];
        let relation: any = null;
        if (["noise", "deferred", "no_relation"].includes(outcome.outcome)) {
          if (outcome.relation || resultIds.length)
            throw new Error(
              "A non-knowledge outcome cannot claim a written knowledge result.",
            );
          if (outcome.outcome === "deferred") {
            requiredText(outcome.gap, "Deferral gap");
            if (
              ![
                "target_knowledge_changed",
                "source_restored",
                "new_evidence",
              ].includes(outcome.trigger ?? "")
            )
              throw new Error(
                "A deferred review needs a specific re-review trigger.",
              );
          }
          if (
            outcome.outcome === "no_relation" &&
            (!outcome.targetClaimIds?.length ||
              !bindings.some((e) => e.itemKey === task.relatedItemKey))
          )
            throw new Error(
              "No relation requires reviewed old knowledge and its evidence; missing Wiki knowledge must be deferred.",
            );
          if (outcome.outcome === "no_relation")
            for (const id of outcome.targetClaimIds) {
              if (
                dispositions.get(id) !== "reviewed" ||
                !bindings.some(
                  (e) => e.claimId === id && e.itemKey === task.relatedItemKey,
                )
              )
                throw new Error(
                  `No relation must bind each reviewed target Claim ${id}, not unrelated evidence.`,
                );
            }
        } else {
          if (!outcome.targetClaimIds?.length)
            throw new Error(
              "A knowledge outcome must name the old target it compared.",
            );
          for (const id of outcome.targetClaimIds) {
            if (
              dispositions.get(id) !== "reviewed" ||
              !bindings.some(
                (e) => e.claimId === id && e.itemKey === task.relatedItemKey,
              )
            )
              throw new Error(
                `Outcome must bind the reviewed old Claim ${id} and its source Evidence.`,
              );
          }
          if (
            !bindings.some((e) => e.itemKey === task.currentItemKey) ||
            !bindings.some((e) => e.itemKey === task.relatedItemKey)
          )
            throw new Error(
              "A knowledge relation needs explicit valid Evidence from both papers.",
            );
          if (
            outcome.outcome === "shared_claim" ||
            outcome.outcome === "conflict"
          ) {
            if (resultIds.length !== 1)
              throw new Error(
                "Shared support/conflict requires exactly one result Claim.",
              );
            const has = (key: string, role: string) =>
              bindings.some(
                (e) =>
                  e.claimId === resultIds[0] &&
                  e.itemKey === key &&
                  e.evidenceRole === role,
              );
            if (
              outcome.outcome === "shared_claim" &&
              !(
                has(task.currentItemKey, "SUPPORTS") &&
                has(task.relatedItemKey, "SUPPORTS")
              )
            )
              throw new Error(
                "Shared support requires both papers' valid SUPPORTS on the same result Claim.",
              );
            if (
              outcome.outcome === "conflict" &&
              !(
                (has(task.currentItemKey, "SUPPORTS") &&
                  has(task.relatedItemKey, "CONTRADICTS")) ||
                (has(task.relatedItemKey, "SUPPORTS") &&
                  has(task.currentItemKey, "CONTRADICTS"))
              )
            )
              throw new Error(
                "Conflict requires opposing evidence roles on the same Claim.",
              );
          } else if (outcome.outcome === "same_page") {
            const pageId = resolveId(outcome.resultRefs?.pageId, refs);
            if (resultIds.length !== 2 || resultIds[0] === resultIds[1])
              throw new Error("Same-page review requires two distinct Claims.");
            const pair = await Promise.all(
              resultIds.map((id) => this.claim(id, libraryID)),
            );
            if (
              pair.some((c) => !c || c.pageId !== pageId) ||
              !resultIds.some((id) => outcome.targetClaimIds.includes(id)) ||
              !bindings.some(
                (e) =>
                  resultIds.includes(e.claimId) &&
                  e.itemKey === task.currentItemKey &&
                  e.evidenceRole !== "CONTRADICTS",
              )
            )
              throw new Error(
                "Same-page Claims must bind this task's old and new knowledge on the named page.",
              );
          } else if (outcome.outcome === "concept_relation") {
            const relationId = resolveId(outcome.resultRefs?.relationId, refs);
            const snapshot = await this.conceptDependency(
              relationId,
              libraryID,
              outcome.conceptSourceIds ?? [],
            );
            if (!snapshot)
              throw new Error(
                "Concept relation needs selected term sources on its own endpoints in this library.",
              );
            const from = (conceptId: number, key: string) =>
              snapshot.sources.some(
                (s: any) =>
                  s.conceptId === conceptId &&
                  s.itemKey === key &&
                  bindings.some(
                    (e) => e.itemKey === key && e.chunkIdSnapshot === s.chunkId,
                  ),
              );
            if (
              !(
                (from(snapshot.sourceConceptId, task.currentItemKey) &&
                  from(snapshot.targetConceptId, task.relatedItemKey)) ||
                (from(snapshot.targetConceptId, task.currentItemKey) &&
                  from(snapshot.sourceConceptId, task.relatedItemKey))
              )
            )
              throw new Error(
                "Concept endpoint sources must bind the compared passages of both papers.",
              );
            conceptDependencies.push({
              kind: "concept_relation",
              relationId,
              libraryID,
              sourceIds: outcome.conceptSourceIds,
              snapshot,
            });
          } else if (
            (CLAIM_RELATION_TYPES as readonly string[]).includes(
              outcome.outcome,
            )
          ) {
            if (!outcome.relation)
              throw new Error(
                "A Claim relation needs its endpoints, comparison dimension, conditions and statement.",
              );
            let source = resolveId(outcome.relation.sourceClaimId, refs),
              target = resolveId(outcome.relation.targetClaimId, refs);
            if (
              source === target ||
              ![source, target].some((id) =>
                outcome.targetClaimIds.includes(id),
              )
            )
              throw new Error(
                "Claim relation needs distinct endpoints including the reviewed target.",
              );
            if (
              ![source, target].every((id) =>
                bindings.some((e) => e.claimId === id),
              )
            )
              throw new Error(
                "Each relation endpoint needs its own selected evidence.",
              );
            const from = (id: number, key: string) =>
              bindings.some((e) => e.claimId === id && e.itemKey === key);
            if (
              !(
                (from(source, task.currentItemKey) &&
                  from(target, task.relatedItemKey)) ||
                (from(target, task.currentItemKey) &&
                  from(source, task.relatedItemKey))
              )
            )
              throw new Error(
                "Relation endpoints must bind one Claim from each compared paper, not a third Claim.",
              );
            if (outcome.outcome === "compares_with" && source > target)
              [source, target] = [target, source];
            relation = {
              sourceClaimId: source,
              targetClaimId: target,
              type: outcome.outcome,
              dimension: requiredText(
                outcome.relation.dimension,
                "Comparison dimension",
              ),
              conditions: requiredText(
                outcome.relation.conditions,
                "Comparison conditions (or explain why not applicable)",
              ),
              statement: requiredText(
                outcome.relation.statement,
                "Relation statement",
              ),
            };
            ids.push(source, target);
          } else
            throw new Error(`Unknown cross-paper outcome: ${outcome.outcome}`);
        }
        dependencyIds.push(...ids, ...outcome.targetClaimIds);
        normalized.push({
          ...outcome,
          evidenceBindings: bindings,
          resultRefs: { ...outcome.resultRefs, claimIds: resultIds },
          relation,
        });
      }
      for (const [id, disposition] of dispositions) {
        if (disposition !== "excluded" && !covered.has(id))
          throw new Error(`Claim ${id} has no outcome.`);
        if (
          disposition === "deferred" &&
          !input.outcomes.some(
            (o) => o.outcome === "deferred" && o.targetClaimIds.includes(id),
          )
        )
          throw new Error(`Deferred Claim ${id} needs its own knowledge gap.`);
      }
      if (
        !targetIds.size &&
        input.outcomes.some((o) => !["noise", "deferred"].includes(o.outcome))
      )
        throw new Error(
          "A paper without Wiki targets must be deferred or screened as discovery noise.",
        );
      const dependencies = [
        ...(await this.dependencies(dependencyIds, libraryID)),
        ...conceptDependencies,
      ];
      await this.db.queryAsync(
        `INSERT INTO wiki_cross_paper_reviews(task_id,operation_id,supersedes,input_json,result_json,dependencies_json,created_at)
        VALUES (?,?,?,?,?,?,?)`,
        [
          task.taskId,
          operationId,
          task.currentReviewId,
          JSON.stringify(input),
          JSON.stringify(normalized),
          JSON.stringify(dependencies),
          Date.now(),
        ],
      );
      const reviewId = Number(
        await this.db.valueQueryAsync("SELECT last_insert_rowid()"),
      );
      for (const o of normalized)
        if (o.relation) {
          const r = o.relation;
          const identity = await hashWikiText(JSON.stringify(r));
          await this.db.queryAsync(
            `INSERT INTO wiki_claim_relations(library_id,source_claim_id,target_claim_id,relation_type,dimension,conditions,statement,
          evidence_json,dependencies_json,task_id,review_id,identity,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              libraryID,
              r.sourceClaimId,
              r.targetClaimId,
              r.type,
              r.dimension,
              r.conditions,
              r.statement,
              JSON.stringify(o.evidenceBindings),
              JSON.stringify(
                await this.dependencies(
                  [r.sourceClaimId, r.targetClaimId],
                  libraryID,
                ),
              ),
              task.taskId,
              reviewId,
              identity,
              Date.now(),
            ],
          );
          o.claimRelationId = Number(
            await this.db.valueQueryAsync("SELECT last_insert_rowid()"),
          );
        }
      await this.db.queryAsync(
        "UPDATE wiki_cross_paper_reviews SET result_json=? WHERE review_id=?",
        [JSON.stringify(normalized), reviewId],
      );
      const state = input.outcomes.some((o) => o.outcome === "deferred")
        ? "deferred"
        : "reviewed";
      // Snapshot the resulting target state so our own evidence attachment does not reopen this review.
      const targetClaims = [];
      for (const old of task.targetClaims) {
        const c = await this.claim(old.claimId, libraryID);
        if (c)
          targetClaims.push({ ...old, ...c, dependency: claimDependency(c) });
      }
      const snapshot = {
        signalIds: task.signalIds,
        discoveryBasis: task.discoveryBasis,
        targetClaims,
        recallStatus: "complete",
        targetCount: targetClaims.length,
        gap: task.gap,
      };
      const baseRevision = await hashWikiText(
        JSON.stringify({
          readingRevision: task.readingRevision,
          signals: task.discoveryBasis,
          targets: targetClaims
            .map((c) => [c.claimId, c.dependency])
            .sort((a, b) => Number(a[0]) - Number(b[0])),
        }),
      );
      const revision = await hashWikiText(`${baseRevision}:${reviewId}`);
      await this.db.queryAsync(
        "UPDATE wiki_cross_paper_tasks SET state=?,current_review_id=?,snapshot_json=?,revision=?,updated_at=? WHERE task_id=?",
        [
          state,
          reviewId,
          JSON.stringify(snapshot),
          revision,
          Date.now(),
          task.taskId,
        ],
      );
      if (task.topic === "fulltext")
        await this.db.queryAsync(
          `UPDATE wiki_cross_paper_tasks SET state='superseded',
        snapshot_json=json_set(snapshot_json,'$.supersededByTaskId',?),updated_at=?
        WHERE library_id=? AND current_item_key=? AND related_item_key=? AND topic!='fulltext' AND state IN ('pending','deferred')`,
          [
            task.taskId,
            Date.now(),
            libraryID,
            task.currentItemKey,
            task.relatedItemKey,
          ],
        );
      // Preserve legacy resolution rows. New protocol owns their superseding review.
      for (const signalId of task.signalIds) {
        await this.db.queryAsync(
          "UPDATE wiki_link_signals SET state=?,settled_at=? WHERE signal_id=? AND link_id=? AND state!='stale'",
          [
            input.outcomes.every(
              (o) => o.outcome === "noise" || o.outcome === "no_relation",
            )
              ? "rejected"
              : "accepted",
            Date.now(),
            signalId,
            task.linkId,
          ],
        );
      }
      await this.db.queryAsync(
        "UPDATE wiki_link_candidates SET status=?,reviewed_at=? WHERE link_id=?",
        [
          state === "reviewed" &&
          input.outcomes.every(
            (o) => o.outcome === "noise" || o.outcome === "no_relation",
          )
            ? "dismissed"
            : "resolved",
          Date.now(),
          task.linkId,
        ],
      );
      results.push({
        taskId: task.taskId,
        reviewId,
        state,
        outcomes: normalized,
      });
    }
    return results;
  }

  async review(reviewId: number): Promise<any | null> {
    const rows = await this.db.queryAsync(
      "SELECT * FROM wiki_cross_paper_reviews WHERE review_id=?",
      [reviewId],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      reviewId,
      taskId: Number(col(r, "task_id")),
      operationId: String(col(r, "operation_id")),
      supersedes: col(r, "supersedes"),
      input: JSON.parse(String(col(r, "input_json"))),
      outcomes: JSON.parse(String(col(r, "result_json"))),
      dependencies: JSON.parse(String(col(r, "dependencies_json"))),
      createdAt: Number(col(r, "created_at")),
    };
  }

  private async conceptDependency(
    relationId: number,
    libraryID: number,
    sourceIds: number[],
  ): Promise<any | null> {
    const rows = await this.db.queryAsync(
      `SELECT r.* FROM wiki_relations r JOIN wiki_concepts a ON a.concept_id=r.source_concept_id
      JOIN wiki_concepts b ON b.concept_id=r.target_concept_id WHERE r.relation_id=? AND a.library_id=? AND b.library_id=?`,
      [relationId, libraryID, libraryID],
    );
    if (!rows.length || !sourceIds.length) return null;
    const r = rows[0],
      sourceConceptId = Number(col(r, "source_concept_id")),
      targetConceptId = Number(col(r, "target_concept_id"));
    const sources = [];
    for (const sourceId of [...new Set(sourceIds)].sort((a, b) => a - b)) {
      const rows = await this.db.queryAsync(
        `SELECT s.*,t.concept_id FROM wiki_concept_term_sources s JOIN wiki_concept_terms t ON t.term_id=s.term_id
        WHERE s.source_id=? AND s.library_id=?`,
        [sourceId, libraryID],
      );
      if (!rows.length) return null;
      const s = rows[0],
        conceptId = Number(col(s, "concept_id"));
      if (
        ![sourceConceptId, targetConceptId].includes(conceptId) ||
        col(s, "chunk_id_snapshot") == null ||
        !String(col(s, "excerpt")).trim()
      )
        return null;
      sources.push({
        sourceId,
        conceptId,
        itemKey: String(col(s, "item_key")),
        chunkId: Number(col(s, "chunk_id_snapshot")),
        excerpt: String(col(s, "excerpt")),
      });
    }
    return {
      relationId,
      sourceConceptId,
      targetConceptId,
      predicate: String(col(r, "predicate")),
      sources,
    };
  }

  async list(options: {
    libraryID?: number;
    itemKey?: string;
    relatedItemKey?: string;
    taskId?: number;
    signalId?: number;
    operationId?: string;
    offset?: number;
    limit?: number;
  }): Promise<any> {
    const where: string[] = [],
      params: unknown[] = [];
    if (options.libraryID !== undefined) {
      where.push("t.library_id=?");
      params.push(options.libraryID);
    }
    if (options.itemKey) {
      where.push("(t.current_item_key=? OR t.related_item_key=?)");
      params.push(options.itemKey, options.itemKey);
    }
    if (options.relatedItemKey) {
      where.push("(t.current_item_key=? OR t.related_item_key=?)");
      params.push(options.relatedItemKey, options.relatedItemKey);
    }
    if (options.taskId) {
      where.push("t.task_id=?");
      params.push(options.taskId);
    }
    if (options.signalId) {
      where.push(
        "EXISTS (SELECT 1 FROM json_each(t.snapshot_json,'$.signalIds') j WHERE j.value=?)",
      );
      params.push(options.signalId);
    }
    if (options.operationId) {
      where.push(
        "EXISTS (SELECT 1 FROM wiki_cross_paper_reviews r WHERE r.task_id=t.task_id AND r.operation_id=?)",
      );
      params.push(options.operationId);
    }
    const offset = options.offset ?? 0,
      limit = options.limit ?? 10;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error(
        "Review pagination requires offset >= 0 and limit 1..50.",
      );
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const total = Number(
      await this.db.valueQueryAsync(
        "SELECT COUNT(*) FROM wiki_cross_paper_tasks t" + clause,
        params,
      ),
    );
    const rows = await this.db.queryAsync(
      "SELECT t.* FROM wiki_cross_paper_tasks t" +
        clause +
        " ORDER BY t.task_id LIMIT ? OFFSET ?",
      [...params, limit, offset],
    );
    const items = [];
    for (const r of rows) {
      const task = this.mapTask(r);
      const history = await this.db.queryAsync(
        "SELECT review_id FROM wiki_cross_paper_reviews WHERE task_id=? ORDER BY review_id DESC",
        [task.taskId],
      );
      const latest = task.currentReviewId
        ? await this.review(task.currentReviewId)
        : null;
      const valid = latest
        ? await this.dependenciesValid(latest.dependencies)
        : false;
      items.push({
        ...task,
        validity: !latest
          ? "unreviewed"
          : valid && task.state !== "pending"
            ? "valid"
            : "needs_revalidation",
        latestReview: latest,
        historyReviewIds: history.map((h) => Number(col(h, "review_id"))),
      });
    }
    return {
      protocolVersion: CROSS_PAPER_PROTOCOL_VERSION,
      total,
      items,
      nextOffset: offset + items.length < total ? offset + items.length : null,
    };
  }

  async relations(libraryID?: number, claimId?: number): Promise<any[]> {
    const where: string[] = [],
      params: unknown[] = [];
    if (libraryID !== undefined) {
      where.push("r.library_id=?");
      params.push(libraryID);
    }
    if (claimId !== undefined) {
      where.push("(r.source_claim_id=? OR r.target_claim_id=?)");
      params.push(claimId, claimId);
    }
    const rows = await this.db.queryAsync(
      `SELECT r.*,t.current_review_id,t.state FROM wiki_claim_relations r
      LEFT JOIN wiki_cross_paper_tasks t ON t.task_id=r.task_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY r.relation_id`,
      params,
    );
    const result = [];
    for (const row of rows) {
      const dependencies = JSON.parse(String(col(row, "dependencies_json")));
      const current =
        Number(col(row, "current_review_id")) === Number(col(row, "review_id"));
      const valid =
        current &&
        String(col(row, "state")) !== "pending" &&
        (await this.dependenciesValid(dependencies));
      result.push({
        relationId: Number(col(row, "relation_id")),
        sourceClaimId: Number(col(row, "source_claim_id")),
        targetClaimId: Number(col(row, "target_claim_id")),
        relationType: String(col(row, "relation_type")),
        dimension: String(col(row, "dimension")),
        conditions: String(col(row, "conditions")),
        statement: String(col(row, "statement")),
        evidenceBindings: JSON.parse(String(col(row, "evidence_json"))),
        taskId: Number(col(row, "task_id")),
        reviewId: Number(col(row, "review_id")),
        validity: !current
          ? "superseded"
          : valid
            ? "valid"
            : "needs_revalidation",
        createdAt: Number(col(row, "created_at")),
      });
    }
    return result;
  }

  async assess(
    libraryID: number,
    operationId: string,
    inputs: EvidenceAssessmentInput[],
    refs: Record<string, number>,
  ): Promise<void> {
    for (const input of inputs) {
      const claimId = resolveId(input.claimId, refs),
        claim = await this.claim(claimId, libraryID);
      if (!claim || claim.version !== input.expectedVersion)
        throw new Error(`Claim ${claimId} assessment version changed.`);
      requiredText(input.basis, "Assessment basis");
      if (
        !["complete", "partial", "overstated", "unverified"].includes(
          input.supportCompleteness,
        ) ||
        !["explicit", "incomplete", "not_applicable", "unverified"].includes(
          input.conditionCompleteness,
        ) ||
        !["verified_independent", "same_study", "unknown"].includes(
          input.independence,
        ) ||
        !Array.isArray(input.basisTypes) ||
        input.basisTypes.some(
          (t) =>
            ![
              "simulation",
              "experiment",
              "theory",
              "assumption",
              "secondary_citation",
            ].includes(t),
        )
      )
        throw new Error("Invalid evidence assessment categories.");
      const bindings = await this.bindings(
        libraryID,
        input.evidenceBindings,
        refs,
      );
      if (!bindings.length || bindings.some((e) => e.claimId !== claimId))
        throw new Error("Assessment must bind this Claim's evidence.");
      if (input.independence !== "unknown") {
        const boundKeys = new Set(bindings.map((e) => e.itemKey));
        const groups = input.studyGroups ?? [];
        const keys = groups.flatMap((g) => g.itemKeys);
        if (
          !groups.length ||
          groups.some((g) => !g.itemKeys.length || !g.basis?.trim()) ||
          new Set(keys).size !== keys.length ||
          keys.some((k) => !boundKeys.has(k)) ||
          [...boundKeys].some((k) => !keys.includes(k)) ||
          (input.independence === "verified_independent" &&
            groups.length < 2) ||
          (input.independence === "same_study" &&
            (groups.length !== 1 || keys.length < 2))
        )
          throw new Error(
            "Source independence requires evidence-bound study groups and reasons.",
          );
      }
      await this.db.queryAsync(
        `INSERT INTO wiki_evidence_assessments(library_id,claim_id,assessment_json,dependencies_json,operation_id,created_at)
        VALUES (?,?,?,?,?,?)`,
        [
          libraryID,
          claimId,
          JSON.stringify({ ...input, claimId, evidenceBindings: bindings }),
          JSON.stringify(await this.dependencies([claimId], libraryID)),
          operationId,
          Date.now(),
        ],
      );
    }
  }

  async assessment(claimId: number): Promise<any | null> {
    const rows = await this.db.queryAsync(
      "SELECT * FROM wiki_evidence_assessments WHERE claim_id=? ORDER BY assessment_id DESC LIMIT 1",
      [claimId],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      ...JSON.parse(String(col(r, "assessment_json"))),
      assessmentId: Number(col(r, "assessment_id")),
      validity: (await this.dependenciesValid(
        JSON.parse(String(col(r, "dependencies_json"))),
      ))
        ? "valid"
        : "needs_revalidation",
    };
  }

  async refreshAffected(
    libraryID: number,
    exceptTaskIds: number[] = [],
  ): Promise<void> {
    const rows = await this.db.queryAsync(
      "SELECT * FROM wiki_cross_paper_tasks WHERE library_id=? AND state IN ('reviewed','deferred')",
      [libraryID],
    );
    for (const row of rows) {
      const task = this.mapTask(row);
      if (exceptTaskIds.includes(task.taskId)) continue;
      const latest = task.currentReviewId
        ? await this.review(task.currentReviewId)
        : null;
      if (latest?.input.outcomes.every((o: any) => o.outcome === "noise"))
        continue;
      const current = await this.claimsFor(libraryID, task.relatedItemKey);
      const old = new Map(
        task.targetClaims.map((c: any) => [c.claimId, c.dependency]),
      );
      const changed =
        current.length !== old.size ||
        current.some((c) => old.get(c.claimId) !== claimDependency(c));
      if (
        changed ||
        (latest && !(await this.dependenciesValid(latest.dependencies)))
      ) {
        await this.db.queryAsync(
          "UPDATE wiki_cross_paper_tasks SET state='pending',updated_at=? WHERE task_id=?",
          [Date.now(), task.taskId],
        );
      }
    }
  }

  async pendingForItem(libraryID: number, itemKey: string): Promise<number[]> {
    const rows = await this.db.queryAsync(
      "SELECT task_id FROM wiki_cross_paper_tasks WHERE library_id=? AND current_item_key=? AND state='pending' ORDER BY task_id",
      [libraryID, itemKey],
    );
    return rows.map((r) => Number(col(r, "task_id")));
  }

  async libraryIDs(): Promise<number[]> {
    const rows = await this.db.queryAsync(
      "SELECT library_id FROM wiki_pages UNION SELECT library_id FROM wiki_link_candidates UNION SELECT library_id FROM wiki_link_scan_queue ORDER BY library_id",
    );
    return rows.map((r) => Number(col(r, "library_id")));
  }

  async auditLegacy(libraryID?: number, persist = false): Promise<any[]> {
    const rows = await this.db.queryAsync(
      `SELECT r.*,c.library_id,c.a_item_key,c.b_item_key FROM wiki_link_resolutions r
      JOIN wiki_link_candidates c ON c.link_id=r.link_id ${libraryID === undefined ? "" : "WHERE c.library_id=?"} ORDER BY r.resolution_id`,
      libraryID === undefined ? [] : [libraryID],
    );
    const items = [];
    for (const r of rows) {
      const id = Number(col(r, "resolution_id")),
        lib = Number(col(r, "library_id")),
        type = String(col(r, "resolution_type"));
      const a = String(col(r, "a_item_key")),
        b = String(col(r, "b_item_key")),
        reasons: string[] = [];
      if (type === "shared_claim" || type === "conflict") {
        const claim = await this.claim(Number(col(r, "claim_id")), lib);
        const has = (key: string, role: string) =>
          claim?.evidence.some(
            (e: any) =>
              e.linkState === "valid" &&
              e.itemKey === key &&
              e.evidenceRole === role,
          );
        if (!claim)
          reasons.push("Referenced Claim is missing or outside the library.");
        else if (
          type === "shared_claim" &&
          !(has(a, "SUPPORTS") && has(b, "SUPPORTS"))
        )
          reasons.push("Shared support lacks valid SUPPORTS from both papers.");
        else if (
          type === "conflict" &&
          !(
            (has(a, "SUPPORTS") && has(b, "CONTRADICTS")) ||
            (has(b, "SUPPORTS") && has(a, "CONTRADICTS"))
          )
        )
          reasons.push(
            "Conflict lacks opposing evidence roles from the two papers.",
          );
      } else if (type === "same_page") {
        const pageId = Number(col(r, "page_id"));
        const page = await this.db.valueQueryAsync(
          "SELECT page_id FROM wiki_pages WHERE page_id=? AND library_id=?",
          [pageId, lib],
        );
        if (!page)
          reasons.push("Referenced Page is missing or outside the library.");
        const ids = JSON.parse(String(col(r, "claim_ids_json") ?? "[]"));
        for (const id of ids) {
          const claim = await this.claim(id, lib);
          if (
            !claim ||
            claim.pageId !== pageId ||
            !claim.evidence.some(
              (e: any) => e.linkState === "valid" && [a, b].includes(e.itemKey),
            )
          )
            reasons.push(`Claim ${id} dependency is invalid.`);
        }
      } else if (type === "concept_relation") {
        const relation = await this.db.valueQueryAsync(
          `SELECT r.relation_id FROM wiki_relations r JOIN wiki_concepts c ON c.concept_id=r.source_concept_id WHERE r.relation_id=? AND c.library_id=?`,
          [Number(col(r, "relation_id")), lib],
        );
        if (!relation) reasons.push("Referenced Concept relation is missing.");
      }
      const validity = reasons.length
        ? "needs_revalidation"
        : "legacy_unverified";
      if (persist)
        await this.db.queryAsync(
          `INSERT INTO wiki_legacy_review_audit(resolution_id,validity,reasons_json,audited_at,protocol_version)
        VALUES (?,?,?,?,?) ON CONFLICT(resolution_id) DO UPDATE SET validity=excluded.validity,reasons_json=excluded.reasons_json,audited_at=excluded.audited_at,protocol_version=excluded.protocol_version`,
          [
            id,
            validity,
            JSON.stringify(reasons),
            Date.now(),
            CROSS_PAPER_PROTOCOL_VERSION,
          ],
        );
      items.push({
        resolutionId: id,
        libraryID: lib,
        linkId: Number(col(r, "link_id")),
        aItemKey: a,
        bItemKey: b,
        resolutionType: type,
        claimId: col(r, "claim_id"),
        pageId: col(r, "page_id"),
        claimIds: JSON.parse(String(col(r, "claim_ids_json") ?? "[]")),
        originalNote: String(col(r, "resolution_note")),
        validity,
        reasons,
      });
    }
    return items;
  }

  async statistics(libraryID?: number): Promise<any> {
    const rows = await this.db.queryAsync(
      `SELECT state,COUNT(*) AS n FROM wiki_cross_paper_tasks ${libraryID === undefined ? "" : "WHERE library_id=?"} GROUP BY state`,
      libraryID === undefined ? [] : [libraryID],
    );
    const taskStates = Object.fromEntries(
      rows.map((r) => [String(col(r, "state")), Number(col(r, "n"))]),
    );
    const relations = await this.relations(libraryID),
      legacy = await this.auditLegacy(libraryID);
    return {
      crossPaperProtocolVersion: CROSS_PAPER_PROTOCOL_VERSION,
      crossPaperTasksByState: taskStates,
      claimRelationsValid: relations.filter((r) => r.validity === "valid")
        .length,
      claimRelationsNeedsRevalidation: relations.filter(
        (r) => r.validity === "needs_revalidation",
      ).length,
      legacyResolutions: legacy.length,
      legacyResolutionDefects: legacy.filter(
        (r) => r.validity === "needs_revalidation",
      ).length,
    };
  }

  async read(options: any): Promise<any> {
    const libraryID = options.libraryID;
    if (options.section) {
      const task = await this.task(resolveId(options.taskId, {}), libraryID);
      if (!task)
        throw new Error("Review task does not belong to this library.");
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== task.revision
      )
        throw Object.assign(
          new Error(
            "Review task revision changed; restart paging from the current task revision.",
          ),
          { code: "REVIEW_REVISION_CHANGED" },
        );
      const review = options.reviewId
        ? await this.review(options.reviewId)
        : task.currentReviewId
          ? await this.review(task.currentReviewId)
          : null;
      if (review && review.taskId !== task.taskId)
        throw new Error("Review revision belongs to another task.");
      let entries: any[];
      if (options.section === "targets") entries = task.targetClaims;
      else if (options.section === "discovery") entries = task.discoveryBasis;
      else if (options.section === "outcomes") entries = review?.outcomes ?? [];
      else if (options.section === "verdicts")
        entries = review?.input.reviewedTargets ?? [];
      else if (options.section === "history") {
        const rows = await this.db.queryAsync(
          "SELECT review_id,operation_id,supersedes,created_at FROM wiki_cross_paper_reviews WHERE task_id=? ORDER BY review_id DESC",
          [task.taskId],
        );
        entries = rows.map((r) => ({
          reviewId: Number(col(r, "review_id")),
          operationId: String(col(r, "operation_id")),
          supersedes: col(r, "supersedes"),
          createdAt: Number(col(r, "created_at")),
        }));
      } else throw new Error("Unknown review section.");
      const context = boundPreparedContext({
        crossPaperTasks: entries,
      } as WikiPreparedContext);
      return {
        taskId: task.taskId,
        revision: task.revision,
        reviewId: review?.reviewId ?? null,
        ...pagePreparedContext(
          context,
          "crossPaperTasks",
          options.offset,
          options.limit,
        ),
      };
    }
    const page = await this.list(options);
    return {
      ...page,
      items: page.items.map((t: any) => ({
        taskId: t.taskId,
        libraryID: t.libraryID,
        currentItemKey: t.currentItemKey,
        relatedItemKey: t.relatedItemKey,
        topic: t.topic,
        revision: t.revision,
        readingRevision: t.readingRevision,
        state: t.state,
        validity: t.validity,
        targetCount: t.targetCount,
        signalIds: t.signalIds,
        currentReviewId: t.currentReviewId,
        historyCount: t.historyReviewIds.length,
        gap: t.gap,
        sections: ["targets", "discovery", "outcomes", "verdicts", "history"],
      })),
    };
  }
}
