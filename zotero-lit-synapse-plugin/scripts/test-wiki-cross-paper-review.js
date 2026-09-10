import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
register("./ts-ext-hooks.mjs", import.meta.url);
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");
const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-cross-review-"));
createZoteroFake({ rootDir: root }).install();
const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { evidenceOverview, selectSummaryClaims } = await import(
  "../src/modules/wiki/wikiEvidenceOverview.ts"
);
const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys=ON");
let depth = 0,
  sequence = 0;
const db = {
  async queryAsync(raw, params = []) {
    const [sql, values] = parseQueryAndParams(raw, params);
    const s = sqlite.prepare(sql);
    return /^\s*(SELECT|PRAGMA|WITH)/i.test(sql)
      ? s.all(...values)
      : (s.run(...values), []);
  },
  async valueQueryAsync(raw, params = []) {
    const [sql, values] = parseQueryAndParams(raw, params);
    const r = sqlite.prepare(sql).get(...values);
    return r && Object.values(r)[0];
  },
  async executeTransaction(fn) {
    if (depth) return fn();
    depth++;
    sqlite.exec("BEGIN");
    try {
      const value = await fn();
      sqlite.exec("COMMIT");
      return value;
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    } finally {
      depth--;
    }
  },
};
const store = new WikiStore(db);
await store.initialize();
const reviews = await store.crossPaperReviews(),
  links = await store.links();
const evidence = (
  itemKey,
  excerpt = `Paper ${itemKey} explicitly reports this numerical method under the stated manufacturing conditions.`,
) => ({
  libraryID: 1,
  itemKey,
  chunkIdSnapshot: 1,
  chunkTextHash: "chunk",
  sourceContentHash: "content",
  sourceChunkSignature: "signature",
  sourceResetGeneration: "reset",
  excerpt,
  evidenceRole: "SUPPORTS",
  readDepth: "section_read",
});
const commit = (actions, crossPaperReview = [], extra = {}) =>
  store.commit({
    libraryID: 1,
    userInitiated: true,
    actions,
    crossPaperReview,
    ...extra,
  });
const page = (
  await commit([
    { action: "CREATE_PAGE", canonicalTitle: "Fibre paths", ref: "p" },
  ])
).refs.p;
const add = (ref, key, text = `Finding ${++sequence}: ${ref}`) => ({
  action: "ADD_CLAIM",
  ref,
  pageId: page,
  claimText: text,
  claimType: "model",
  epistemicStatus: "supported",
  coverageLevel: "section_read",
  evidence: [evidence(key)],
});
const seed = await commit([
  add(
    "old",
    "PAPER_A",
    "Stress aligned paths with no manufacturing constraint.",
  ),
  add("other", "PAPER_A", "Independent thermal boundary condition."),
]);
const old = seed.refs.old;
async function pair(a, b) {
  const [left, right] = [a, b].sort();
  const linkId = await links.upsertCandidate({
    libraryID: 1,
    itemKeyA: left,
    itemKeyB: right,
    scoreAB: 0.9,
    scoreBA: 0.9,
    scoreSymmetric: 0.9,
  });
  await links.recordSignals({
    linkId,
    cap: 10,
    signals: [
      {
        signalType: "semantic",
        direction: "a_to_b",
        algorithmVersion: "test",
        score: 0.9,
        a: {
          chunkIdSnapshot: 1,
          chunkTextHash: "a",
          excerpt: "Stress aligned fibre paths.",
        },
        b: {
          chunkIdSnapshot: 2,
          chunkTextHash: "b",
          excerpt: "Paths with turning and spacing constraints.",
        },
      },
    ],
  });
  return linkId;
}
await pair("PAPER_A", "PAPER_B");
const prepare = (key = "PAPER_B") =>
  reviews.prepare({
    libraryID: 1,
    itemKey: key,
    topic: "stress paths",
    readingRevision: "source-1",
  });
let task = (await prepare())[0];
const draft = (task, outcome) => ({
  taskId: task.taskId,
  expectedRevision: task.revision,
  reviewedTargets: task.targetClaims.map((c) => ({
    claimId: c.claimId,
    version: c.version,
    disposition: c.claimId === old ? "reviewed" : "excluded",
    basis:
      c.claimId === old
        ? "Compare path construction and manufacturing assumptions."
        : "Thermal boundary conditions are outside this method comparison.",
  })),
  outcomes: [outcome],
});
const compare = {
  outcome: "compares_with",
  targetClaimIds: [old],
  basis:
    "Both describe fibre paths, but the second includes explicit turning and spacing restrictions.",
  evidenceBindings: [
    {
      claimId: old,
      evidenceId: (await store.getClaim(old)).evidence[0].evidenceId,
    },
    {
      claimId: "new",
      itemKey: "PAPER_B",
      excerpt: evidence("PAPER_B").excerpt,
    },
  ],
  relation: {
    sourceClaimId: "new",
    targetClaimId: old,
    dimension: "Manufacturing constraints",
    conditions:
      "Numerical path construction; experimental validation is not asserted.",
    statement:
      "The second model includes turning and spacing constraints absent from the first numerical baseline.",
  },
};
let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`PASS ${name}`);
  passed++;
}
try {
  await test("a new paper with no old Evidence still receives complete old Wiki targets", async () => {
    // Unreviewed, and advisory: `required` is false by design so an unrelated
    // paper's Claims cannot block writing this one down. See
    // `ensureCommitReviewTasks`.
    assert.equal(task.pending, true);
    assert.equal(task.required, false);
    assert.equal(task.targetClaims.length, 2);
    assert.equal(
      (await store.listClaimsByEvidenceSource(1, "PAPER_B")).length,
      0,
    );
  });
  await test("missing target decisions reject and roll back new knowledge", async () => {
    const bad = draft(task, compare);
    bad.reviewedTargets = [];
    const count = sqlite.prepare("SELECT count(*) n FROM wiki_claims").get().n;
    await assert.rejects(
      commit([add("new", "PAPER_B")], [bad]),
      /every target/,
    );
    assert.equal(
      sqlite.prepare("SELECT count(*) n FROM wiki_claims").get().n,
      count,
    );
  });
  await test("an unsupported shared outcome cannot close candidates or preserve partial writes", async () => {
    const bad = {
      ...compare,
      outcome: "shared_claim",
      relation: undefined,
      resultRefs: { claimIds: [old] },
    };
    await assert.rejects(
      commit([add("new", "PAPER_B")], [draft(task, bad)]),
      /SUPPORTS/,
    );
    assert.equal((await links.getSignal(task.signalIds[0])).state, "pending");
  });
  let result;
  await test("comparison and explicit exclusions persist atomically without rereading the old chunk", async () => {
    result = await commit([add("new", "PAPER_B")], [draft(task, compare)]);
    assert.equal(result.crossPaperReviews[0].state, "reviewed");
    const relations = await reviews.relations(1);
    assert.equal(relations.length, 1);
    assert.equal(relations[0].validity, "valid");
    assert.equal(relations[0].evidenceBindings.length, 2);
    assert.equal(
      (await store.getClaim(old)).evidenceOverview.supportingSources,
      1,
    );
  });
  await test("reprepare and history reads preserve a finished review without writes on read", async () => {
    task = (await prepare())[0];
    assert.equal(task.required, false);
    const before = sqlite.prepare("SELECT total_changes() n").get().n;
    const history = await reviews.list({ libraryID: 1, taskId: task.taskId });
    await reviews.relations(1);
    assert.equal(
      history.items[0].latestReview.input.reviewedTargets[1].disposition,
      "excluded",
    );
    assert.equal(sqlite.prepare("SELECT total_changes() n").get().n, before);
  });
  await test("unrelated paper knowledge does not reopen this pair", async () => {
    await commit([add("unrelated", "PAPER_C")]);
    assert.equal((await reviews.task(task.taskId, 1)).state, "reviewed");
  });
  await test("competing decisions must observe the preceding review revision", async () => {
    const decision = draft(task, {
      outcome: "no_relation",
      targetClaimIds: [old],
      basis: "This focused review does not claim a shared proposition.",
      evidenceBindings: [compare.evidenceBindings[0]],
    });
    await commit([], [decision]);
    await assert.rejects(commit([], [decision]), /changed/);
    task = (await prepare())[0];
  });
  await test("negative conclusions require the named target evidence", async () => {
    const wrong = {
      outcome: "no_relation",
      targetClaimIds: [old],
      basis: "No common proposition in the selected topic.",
      evidenceBindings: [
        {
          claimId: seed.refs.other,
          evidenceId: (await store.getClaim(seed.refs.other)).evidence[0]
            .evidenceId,
        },
      ],
    };
    await assert.rejects(
      commit([], [draft(task, wrong)]),
      /each reviewed target/,
    );
  });
  await test("current-paper evidence on a third Claim cannot justify old-only relation endpoints", async () => {
    const wrong = {
      ...compare,
      evidenceBindings: [
        compare.evidenceBindings[0],
        {
          claimId: seed.refs.other,
          evidenceId: (await store.getClaim(seed.refs.other)).evidence[0]
            .evidenceId,
        },
        {
          claimId: result.refs.new,
          evidenceId: (await store.getClaim(result.refs.new)).evidence[0]
            .evidenceId,
        },
      ],
      relation: { ...compare.relation, sourceClaimId: seed.refs.other },
    };
    await assert.rejects(
      commit([], [draft(task, wrong)]),
      /one Claim from each/,
    );
  });
  await test("concept outcomes cannot point at an arbitrary library relation", async () => {
    const wrong = {
      ...compare,
      outcome: "concept_relation",
      relation: undefined,
      resultRefs: { relationId: 999 },
      evidenceBindings: [
        compare.evidenceBindings[0],
        {
          claimId: result.refs.new,
          evidenceId: (await store.getClaim(result.refs.new)).evidence[0]
            .evidenceId,
        },
      ],
    };
    await assert.rejects(commit([], [draft(task, wrong)]), /term sources/);
  });
  await test("bound Concept endpoints persist and become invalid when their source changes", async () => {
    const concepts = await store.concepts();
    const created = await concepts.record({
      libraryID: 1,
      entities: [
        {
          primaryTerm: { en: "stress alignment" },
          sources: [evidence("PAPER_A")],
        },
        {
          primaryTerm: { en: "turning constraint" },
          sources: [evidence("PAPER_B")],
        },
      ],
    });
    const linked = await commit([
      {
        action: "LINK_RELATION",
        ref: "relation",
        sourceConceptId: created.conceptIds[0],
        targetConceptId: created.conceptIds[1],
        predicate: "compares_with",
        confidence: 0.5,
      },
    ]);
    const sourceIds = sqlite
      .prepare(
        "SELECT source_id FROM wiki_concept_term_sources ORDER BY source_id",
      )
      .all()
      .map((r) => r.source_id);
    task = (await prepare())[0];
    await commit(
      [],
      [
        draft(task, {
          outcome: "concept_relation",
          targetClaimIds: [old],
          basis:
            "Compare the two sourced terms without asserting shared support.",
          conceptSourceIds: sourceIds,
          resultRefs: { relationId: linked.refs.relation },
          evidenceBindings: [
            compare.evidenceBindings[0],
            {
              claimId: result.refs.new,
              evidenceId: (await store.getClaim(result.refs.new)).evidence[0]
                .evidenceId,
            },
          ],
        }),
      ],
    );
    assert.equal(
      (await reviews.list({ libraryID: 1, taskId: task.taskId })).items[0]
        .validity,
      "valid",
    );
    sqlite
      .prepare(
        "UPDATE wiki_concept_term_sources SET excerpt=? WHERE source_id=?",
      )
      .run("A corrected term passage.", sourceIds[0]);
    assert.equal(
      (await reviews.list({ libraryID: 1, taskId: task.taskId })).items[0]
        .validity,
      "needs_revalidation",
    );
    task = (await prepare())[0];
  });
  await test("a new Store recovers every target through durable pagination", async () => {
    const recovered = await new WikiStore(db).crossPaperReviews();
    const ids = [];
    let offset = 0;
    do {
      const page = await recovered.read({
        libraryID: 1,
        taskId: task.taskId,
        section: "targets",
        limit: 1,
        offset,
      });
      ids.push(...page.items.map((c) => c.claimId));
      offset = page.pagination.nextOffset;
    } while (offset !== null);
    assert.deepEqual(
      ids.sort((a, b) => a - b),
      task.targetClaims.map((c) => c.claimId).sort((a, b) => a - b),
    );
  });
  await test("full-text review supersedes earlier question work and retains its history", async () => {
    await pair("PAPER_H", "PAPER_I");
    const question = (
      await reviews.prepare({
        libraryID: 1,
        itemKey: "PAPER_H",
        topic: "specific question",
      })
    )[0];
    const full = (
      await reviews.prepare({
        libraryID: 1,
        itemKey: "PAPER_H",
        topic: "fulltext",
      })
    )[0];
    await commit(
      [],
      [
        {
          taskId: full.taskId,
          expectedRevision: full.revision,
          reviewedTargets: [],
          outcomes: [
            {
              outcome: "deferred",
              targetClaimIds: [],
              evidenceBindings: [],
              basis:
                "The full reading still lacks Wiki knowledge for the related paper.",
              gap: "PAPER_I needs source-backed claims.",
              trigger: "target_knowledge_changed",
            },
          ],
        },
      ],
    );
    assert.equal((await reviews.task(question.taskId, 1)).state, "superseded");
    assert.deepEqual(await reviews.pendingForItem(1, "PAPER_H"), []);
    assert.equal(
      (
        await reviews.read({
          libraryID: 1,
          taskId: full.taskId,
          section: "history",
        })
      ).items.length,
      1,
    );
  });
  await test("dependent Claim changes invalidate the relation and reject the old review revision", async () => {
    await commit([
      {
        action: "UPDATE_CLAIM",
        claimId: old,
        expectedVersion: (await store.getClaim(old)).version,
        claimText: "Revised stress-aligned numerical path construction.",
        evidence: [evidence("PAPER_A")],
      },
    ]);
    assert.notEqual((await reviews.relations(1))[0].validity, "valid");
    await assert.rejects(
      commit(
        [],
        [
          draft(task, {
            ...compare,
            evidenceBindings: [
              compare.evidenceBindings[0],
              {
                claimId: result.refs.new,
                evidenceId: (await store.getClaim(result.refs.new)).evidence[0]
                  .evidenceId,
              },
            ],
            relation: { ...compare.relation, sourceClaimId: result.refs.new },
          }),
        ],
      ),
      /changed/,
    );
  });
  await test("deferred knowledge gaps reopen after the missing paper receives a Claim", async () => {
    await pair("PAPER_D", "PAPER_E");
    const t = (await prepare("PAPER_D"))[0];
    assert.equal(t.targetClaims.length, 0);
    await commit(
      [],
      [
        {
          taskId: t.taskId,
          expectedRevision: t.revision,
          reviewedTargets: [],
          outcomes: [
            {
              outcome: "deferred",
              targetClaimIds: [],
              basis: "The candidate has no old Wiki knowledge to compare.",
              gap: "PAPER_E needs a source-backed Wiki claim.",
              trigger: "target_knowledge_changed",
              evidenceBindings: [],
            },
          ],
        },
      ],
    );
    assert.equal((await reviews.task(t.taskId, 1)).state, "deferred");
    await commit([add("later", "PAPER_E")]);
    assert.equal((await reviews.task(t.taskId, 1)).state, "pending");
  });
  await test("absence of Wiki knowledge cannot be concluded as no relation", async () => {
    await pair("PAPER_F", "PAPER_G");
    const t = (await prepare("PAPER_F"))[0];
    await assert.rejects(
      commit(
        [],
        [
          {
            taskId: t.taskId,
            expectedRevision: t.revision,
            reviewedTargets: [],
            outcomes: [
              {
                outcome: "no_relation",
                targetClaimIds: [],
                basis: "No knowledge exists.",
                evidenceBindings: [],
              },
            ],
          },
        ],
      ),
      /No relation/,
    );
  });
  await test("selected empty tasks defer as one batch and unselected tasks stay pending", async () => {
    for (const target of ["BATCH_A", "BATCH_B", "BATCH_C"])
      await pair("BATCH_SOURCE", target);
    const tasks = await prepare("BATCH_SOURCE");
    const selected = tasks
      .slice(0, 2)
      .map((t) => ({ taskId: t.taskId, expectedRevision: t.revision }));
    const expanded = await reviews.missingTargetDeferrals(1, selected, []);
    assert.equal(expanded.length, 2);
    assert.ok(expanded.every((r) => r.outcomes[0].outcome === "deferred"));
    assert.ok(
      (await reviews.task(tasks[0].taskId, 1)).state === "pending",
      "expansion itself must not write",
    );
    await commit([], expanded);
    assert.equal((await reviews.task(tasks[0].taskId, 1)).state, "deferred");
    assert.equal((await reviews.task(tasks[1].taskId, 1)).state, "deferred");
    assert.equal((await reviews.task(tasks[2].taskId, 1)).state, "pending");
    const currentSelection = {
      ...selected[0],
      expectedRevision: (await reviews.task(selected[0].taskId, 1)).revision,
    };
    await assert.rejects(
      reviews.missingTargetDeferrals(
        1,
        [currentSelection, currentSelection],
        [],
      ),
      /Duplicate/,
    );
    await assert.rejects(
      reviews.missingTargetDeferrals(
        1,
        [{ ...selected[0], expectedRevision: "old" }],
        [],
      ),
      /changed/,
    );
    await assert.rejects(
      reviews.missingTargetDeferrals(2, [selected[0]], []),
      /changed|library/,
    );
    await assert.rejects(
      reviews.missingTargetDeferrals(1, [selected[0]], [expanded[0]]),
      /Duplicate/,
    );
    const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
    const service = new WikiService(store);
    const input = {
      libraryID: 1,
      userInitiated: true,
      operationId: "batch_missing_001",
      actions: [],
      checkpoint: true,
      deferMissingTargets: [
        { taskId: tasks[2].taskId, expectedRevision: tasks[2].revision },
      ],
    };
    const first = await service.commit(input);
    const retry = await new WikiService(store).commit(input);
    assert.deepEqual(retry, JSON.parse(JSON.stringify(first)));
    assert.equal((await reviews.task(tasks[2].taskId, 1)).state, "deferred");
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM wiki_cross_paper_reviews WHERE operation_id=?",
        )
        .get(input.operationId).n,
      1,
    );
  });
  await test("batch deferral rejects new target knowledge and rolls back a conflicting commit", async () => {
    await pair("BATCH_NEW", "BATCH_TARGET");
    const task = (await prepare("BATCH_NEW"))[0];
    const selected = [{ taskId: task.taskId, expectedRevision: task.revision }];
    const expanded = await reviews.missingTargetDeferrals(1, selected, []);
    const before = sqlite
      .prepare("SELECT COUNT(*) AS n FROM wiki_claims")
      .get().n;
    await assert.rejects(
      commit([add("new_target", "BATCH_TARGET")], expanded),
      /changed|target knowledge/,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM wiki_claims").get().n,
      before,
    );
    await commit([add("later_target", "BATCH_TARGET")]);
    await assert.rejects(
      reviews.missingTargetDeferrals(1, selected, []),
      /changed|target knowledge/,
    );
    await assert.rejects(
      reviews.read({
        libraryID: 1,
        taskId: task.taskId,
        section: "targets",
        expectedRevision: "obsolete",
      }),
      /revision|changed/i,
    );
  });
  await test("archived evidence is distinct from currently accessible support", async () => {
    const c = await store.getClaim(old);
    const summary = evidenceOverview({
      ...c,
      evidence: c.evidence.map((e) => ({ ...e, linkState: "source_deleted" })),
    });
    assert.equal(summary.supportingSources, 0);
    assert.equal(summary.historicalSupportingSources, 1);
    assert.equal(summary.sources[0].readDepth, null);
    assert.equal(summary.supportCompleteness, "unverified");
  });
  await test("same-score summaries cover sources and limits with a stable selection", async () => {
    const claims = Array.from({ length: 9 }, (_, i) => ({
      claimId: i + 1,
      version: 1,
      claimText: `Different claim ${i}`,
      claimType: i === 7 ? "limitation" : "model",
      confidence: 0.66,
      evidence: [evidence(i < 4 ? "A" : "B")],
    }));
    for (const c of claims) for (const e of c.evidence) e.linkState = "valid";
    const chosen = selectSummaryClaims(claims);
    assert.ok(chosen.some((c) => c.claimId === 8));
    assert.equal(
      new Set(chosen.flatMap((c) => c.evidence.map((e) => e.itemKey))).size,
      2,
    );
    assert.deepEqual(selectSummaryClaims(claims.slice().reverse()), chosen);
  });
  await test("a source event during commit rolls back without acknowledging its outbox", async () => {
    let revision = "before",
      changes = [],
      acks = 0;
    const tracked = new WikiStore(db, {
      getWikiSourceRevision: async () => revision,
      listPendingWikiSourceChanges: async () => changes,
      acknowledgeWikiSourceChange: async () => {
        acks++;
        changes = [];
      },
      getDocumentRevision: async () => revision,
    });
    const count = sqlite.prepare("SELECT count(*) n FROM wiki_claims").get().n;
    await assert.rejects(
      tracked.commit(
        {
          libraryID: 1,
          userInitiated: true,
          actions: [add("racing", "PAPER_C")],
        },
        {
          operationId: "source-race",
          inputHash: "race",
          payload: {},
          beforeCommit: async () => {
            revision = "after";
            changes = [{ libraryID: 1, itemKey: "PAPER_C" }];
            await tracked.crossPaperReviews();
          },
        },
      ),
      /sources changed/,
    );
    assert.equal(acks, 0);
    assert.equal(changes.length, 1);
    assert.equal(
      sqlite.prepare("SELECT count(*) n FROM wiki_claims").get().n,
      count,
    );
    assert.equal(await tracked.getCommitOperation(1, "source-race"), null);
    await tracked.synchronizeSourceChanges();
    assert.equal(acks, 1);
  });
  await test("a source reindex invalidates evidence before a review-only commit", async () => {
    task = (await prepare())[0];
    let changes = [{ libraryID: 1, itemKey: "PAPER_A" }];
    const tracked = new WikiStore(db, {
      getWikiSourceRevision: async () => "reindexed",
      listPendingWikiSourceChanges: async () => changes,
      acknowledgeWikiSourceChange: async () => {
        changes = [];
      },
      getDocumentRevision: async () => "reindexed",
    });
    await assert.rejects(
      tracked.commit({
        libraryID: 1,
        userInitiated: true,
        actions: [],
        crossPaperReview: [
          draft(task, {
            outcome: "no_relation",
            targetClaimIds: [old],
            basis: "Review the old target.",
            evidenceBindings: [compare.evidenceBindings[0]],
          }),
        ],
      }),
      /changed/,
    );
    assert.equal(
      sqlite
        .prepare("SELECT link_state FROM wiki_evidence WHERE evidence_id=?")
        .get(compare.evidenceBindings[0].evidenceId).link_state,
      "pending_relink",
    );
  });
  console.log(`${passed} cross-paper review tests passed`);
} finally {
  sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
}
