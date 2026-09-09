import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");
const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-feedback-links-"));
const fake = createZoteroFake({ rootDir: root });
fake.install();
const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { getWikiLinkSettings } = await import(
  "../src/modules/wiki/wikiLinkSettings.ts"
);
const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
let depth = 0;
const database = {
  async queryAsync(raw, params = []) {
    const [sql, values] = parseQueryAndParams(raw, params);
    const stmt = sqlite.prepare(sql);
    const bound = values.map((value) =>
      typeof value === "boolean" ? Number(value) : value,
    );
    if (/^\s*(select|pragma|with)/i.test(sql)) return stmt.all(...bound);
    stmt.run(...bound);
    return [];
  },
  async valueQueryAsync(raw, params = []) {
    const [sql, values] = parseQueryAndParams(raw, params);
    const row = sqlite.prepare(sql).get(...values);
    return row && Object.values(row)[0];
  },
  async executeTransaction(fn) {
    if (depth) return fn();
    depth++;
    sqlite.exec("BEGIN");
    try {
      const value = await fn();
      sqlite.exec("COMMIT");
      return value;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      depth--;
    }
  },
};
const store = new WikiStore(database);
await store.initialize();
const service = new WikiService(store);
const runner = new WikiService(store);
runner.links.chunkIsRead = async () => true;
// Indexed-source hydration is covered separately; exercise the real commit,
// transaction, recovery receipt and reading gates with prepared evidence.
runner.hydrateActions = async (actions) => ({ actions, warnings: [] });
runner.pumpEmbeddingQueue = async () => {};
const links = await store.links();
service.links.chunkIsRead = async () => true;
let sequence = 0;
let failed = 0;
const reason =
  "Both passages describe different experimental constraints and remain separate findings under this shared topic.";
const evidence = (itemKey, role = "SUPPORTS") => ({
  libraryID: 1,
  itemKey,
  chunkIdSnapshot: 1,
  chunkTextHash: `hash-${itemKey}`,
  sourceContentHash: "content",
  sourceChunkSignature: "chunks",
  sourceResetGeneration: "reset",
  excerpt: `The original experimental result reported by paper ${itemKey} under its specified conditions.`,
  evidenceRole: role,
  readDepth: "section_read",
});
const seed = await store.commit({
  libraryID: 1,
  userInitiated: true,
  actions: [
    {
      action: "CREATE_PAGE",
      canonicalTitle: "Stress-guided paths",
      ref: "page",
    },
  ],
});
const pageId = seed.refs.page;
function claim(ref, sources) {
  return {
    action: "ADD_CLAIM",
    ref,
    pageId,
    claimText: `Finding ${++sequence}: ${ref}`,
    claimType: "condition",
    epistemicStatus: "supported",
    coverageLevel: "section_read",
    evidence: sources.map((source) => evidence(source)),
  };
}
async function signal(a = "PAPER_A", b = "PAPER_B", score = 0.85) {
  const linkId = await links.upsertCandidate({
    libraryID: 1,
    itemKeyA: a,
    itemKeyB: b,
    scoreAB: score,
    scoreBA: score,
    scoreSymmetric: score,
  });
  await links.recordSignals({
    linkId,
    cap: 20,
    signals: [
      {
        signalType: "semantic",
        direction: "a_to_b",
        algorithmVersion: "test",
        score,
        a: {
          chunkIdSnapshot: ++sequence,
          chunkTextHash: `a-${sequence}`,
          excerpt: `The first paper describes constraint ${sequence}.`,
        },
        b: {
          chunkIdSnapshot: ++sequence,
          chunkTextHash: `b-${sequence}`,
          excerpt: `The second paper describes constraint ${sequence}.`,
        },
      },
    ],
  });
  return (await links.pendingSignalsForRelink(1))
    .filter((entry) => entry.linkId === linkId)
    .at(-1);
}
async function commit(actions) {
  const input = { libraryID: 1, userInitiated: true, actions };
  return store.commit(input, {
    operationId: `feedback-${++sequence}`,
    inputHash: "test",
    payload: {},
    beforeCommit: async (result) => {
      result.linkSettlement = await service.settleLinkSignals(
        input,
        actions,
        result,
      );
    },
  });
}
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}
try {
  await test("mandatory settlement is enabled by default", () =>
    assert.equal(getWikiLinkSettings().mandatorySettlement, true));
  await test("a single-source shared claim rolls back knowledge and settlement", async () => {
    const found = await signal();
    const action = {
      ...claim("invalid", ["PAPER_B"]),
      resolvesSignalIds: [found.signalId],
    };
    const before = sqlite.prepare("SELECT count(*) n FROM wiki_claims").get().n;
    await assert.rejects(commit([action]), /both|SUPPORTS|support/i);
    assert.equal(
      sqlite.prepare("SELECT count(*) n FROM wiki_claims").get().n,
      before,
    );
    assert.equal((await links.getSignal(found.signalId)).state, "pending");
  });
  await test("evidence attached later in the same transaction completes shared support", async () => {
    const found = await signal("LATER_A", "LATER_B");
    const result = await commit([
      { ...claim("shared", ["LATER_A"]), resolvesSignalIds: [found.signalId] },
      {
        action: "ATTACH_EVIDENCE",
        claimId: "shared",
        evidence: [evidence("LATER_B")],
      },
    ]);
    assert.equal(
      result.linkSettlement.decisions[0].resolutionType,
      "shared_claim",
    );
    assert.equal((await links.getSignal(found.signalId)).state, "accepted");
  });
  await test("existing evidence is counted when only the second paper is attached", async () => {
    const first = await commit([claim("existing", ["EXIST_A"])]);
    const found = await signal("EXIST_A", "EXIST_B");
    await commit([
      {
        action: "ATTACH_EVIDENCE",
        claimId: first.refs.existing,
        evidence: [evidence("EXIST_B")],
        resolvesSignalIds: [found.signalId],
      },
    ]);
    assert.equal((await links.getSignal(found.signalId)).state, "accepted");
  });
  await test("distinct claims on an existing page retain both ids", async () => {
    const found = await signal("DIST_A", "DIST_B");
    const result = await commit([
      claim("first", ["DIST_A"]),
      claim("second", ["DIST_B"]),
      {
        action: "RESOLVE_LINK_SIGNAL",
        signalId: found.signalId,
        resolutionType: "same_page",
        pageId,
        claimIds: ["first", "second"],
        reason,
      },
    ]);
    const resolutions = await links.resolutionsFor(found.linkId);
    assert.deepEqual(resolutions.at(-1).claimIds, [
      result.refs.first,
      result.refs.second,
    ]);
    assert.deepEqual(result.linkSettlement.decisions[0].claimIds, [
      result.refs.first,
      result.refs.second,
    ]);
  });
  await test("a reasoned no-action decision requires no invented claim", async () => {
    const found = await signal("NONE_A", "NONE_B");
    const result = await commit([
      {
        action: "RESOLVE_LINK_SIGNAL",
        signalId: found.signalId,
        resolutionType: "no_action",
        reason,
      },
    ]);
    assert.equal(result.createdClaims, 0);
    assert.equal((await links.getSignal(found.signalId)).state, "rejected");
  });
  await test("duplicate decisions roll back all outcomes", async () => {
    const found = await signal("DUPE_A", "DUPE_B");
    const action = {
      action: "RESOLVE_LINK_SIGNAL",
      signalId: found.signalId,
      resolutionType: "no_action",
      reason,
    };
    await assert.rejects(
      commit([action, action]),
      /once|twice|duplicate|already/i,
    );
    assert.equal((await links.getSignal(found.signalId)).state, "pending");
  });
  await test("unread and below-threshold candidates do not block completion", async () => {
    const found = await signal("READ_A", "READ_B");
    service.links.chunkIsRead = async (_library, key) => key !== "READ_B";
    assert.deepEqual(
      await service.links.unsettledMandatory({
        libraryID: 1,
        itemKeys: new Set(["READ_A"]),
        settledSignalIds: new Set(),
      }),
      [],
    );
    service.links.chunkIsRead = async () => true;
    assert.equal(
      (
        await service.links.unsettledMandatory({
          libraryID: 1,
          itemKeys: new Set(["READ_A"]),
          settledSignalIds: new Set(),
        })
      )[0].signalId,
      found.signalId,
    );
    await signal("LOW_A", "LOW_B", 0.1);
    assert.deepEqual(
      await service.links.unsettledMandatory({
        libraryID: 1,
        itemKeys: new Set(["LOW_A"]),
        settledSignalIds: new Set(),
      }),
      [],
    );
  });
  await test("all mandatory signals remain visible outside the current chunk filter", async () => {
    const found = await signal("VISIBLE_A", "VISIBLE_B");
    const views = await service.links.pendingSignals({
      libraryID: 1,
      itemKey: "VISIBLE_A",
      chunkIds: [999999],
    });
    assert.ok(
      views
        .flatMap((view) => view.signals)
        .some(
          (entry) => entry.signalId === found.signalId && entry.mustResolve,
        ),
    );
  });
  await test("a conflict needs opposing evidence and is never stored as shared support", async () => {
    const found = await signal("CONFLICT_A", "CONFLICT_B");
    const first = await commit([claim("disputed", ["CONFLICT_A"])]);
    const result = await commit([
      {
        action: "MARK_CONFLICT",
        claimId: first.refs.disputed,
        evidence: [evidence("CONFLICT_B", "CONTRADICTS")],
      },
      {
        action: "RESOLVE_LINK_SIGNAL",
        signalId: found.signalId,
        resolutionType: "conflict",
        claimId: first.refs.disputed,
        reason,
      },
    ]);
    assert.equal(result.linkSettlement.decisions[0].resolutionType, "conflict");
    const another = await signal("CONFLICT_A", "CONFLICT_B");
    await assert.rejects(
      commit([
        {
          action: "RESOLVE_LINK_SIGNAL",
          signalId: another.signalId,
          resolutionType: "shared_claim",
          claimId: first.refs.disputed,
          reason,
        },
      ]),
      /SUPPORTS/,
    );
  });
  await test("a concept relation must exist and have passage sources from both papers", async () => {
    const found = await signal("CONCEPT_A", "CONCEPT_B");
    const concepts = await store.concepts();
    const created = await concepts.record({
      libraryID: 1,
      entities: [
        {
          primaryTerm: { en: "Stress alignment field" },
          sources: [
            {
              itemKey: "CONCEPT_A",
              libraryID: 1,
              chunkIdSnapshot: 1,
              excerpt:
                "Stress alignment field guides continuous fiber trajectories.",
            },
          ],
        },
        {
          primaryTerm: { en: "Manufacturing constraint" },
          sources: [
            {
              itemKey: "CONCEPT_B",
              libraryID: 1,
              chunkIdSnapshot: 1,
              excerpt:
                "Manufacturing constraint bounds continuous fiber trajectories.",
            },
          ],
        },
      ],
    });
    const result = await commit([
      {
        action: "LINK_RELATION",
        ref: "edge",
        sourceConceptId: created.conceptIds[0],
        targetConceptId: created.conceptIds[1],
        predicate: "bounded by",
        confidence: 0.9,
      },
      {
        action: "RESOLVE_LINK_SIGNAL",
        signalId: found.signalId,
        resolutionType: "concept_relation",
        relationId: "edge",
        reason,
      },
    ]);
    assert.equal(
      result.linkSettlement.decisions[0].relationId,
      result.refs.edge,
    );
    const unrelated = await signal("UNRELATED_A", "UNRELATED_B");
    await assert.rejects(
      commit([
        {
          action: "RESOLVE_LINK_SIGNAL",
          signalId: unrelated.signalId,
          resolutionType: "concept_relation",
          relationId: result.refs.edge,
          reason,
        },
      ]),
      /source passages/,
    );
  });
  await test("stale evidence and cross-library claims cannot settle a signal", async () => {
    const found = await signal("STALE_A", "STALE_B");
    const written = await commit([claim("stale", ["STALE_A", "STALE_B"])]);
    sqlite
      .prepare(
        "UPDATE wiki_evidence SET link_state = 'stale' WHERE claim_id = ? AND item_key = ?",
      )
      .run(written.refs.stale, "STALE_B");
    await assert.rejects(
      commit([
        {
          action: "RESOLVE_LINK_SIGNAL",
          signalId: found.signalId,
          resolutionType: "shared_claim",
          claimId: written.refs.stale,
          reason,
        },
      ]),
      /SUPPORTS/,
    );
    await assert.rejects(
      service.links.resolveSignals({
        libraryID: 2,
        signalIds: [found.signalId],
        resolutionType: "shared_claim",
        claimId: written.refs.stale,
        note: reason,
      }),
      /belongs to library/,
    );
    await assert.rejects(store.linkClaim(written.refs.stale, 2), /library/);
  });
  await test("service rollback permits the same operation to retry with corrected evidence", async () => {
    const found = await signal("RETRY_A", "RETRY_B");
    const action = {
      ...claim("retry", ["RETRY_A"]),
      resolvesSignalIds: [found.signalId],
    };
    const input = {
      libraryID: 1,
      operationId: "feedback-service-retry",
      userInitiated: true,
      actions: [action],
    };
    const before = sqlite.prepare("SELECT count(*) n FROM wiki_claims").get().n;
    await assert.rejects(runner.commit(input), /SUPPORTS/);
    assert.equal(
      (await runner.commitStatus(1, input.operationId)).committed,
      false,
    );
    assert.equal(
      sqlite.prepare("SELECT count(*) n FROM wiki_claims").get().n,
      before,
    );
    action.evidence.push(evidence("RETRY_B"));
    const result = await runner.commit(input);
    assert.equal(result.committed, true);
    const replay = await runner.commit({ ...input, resume: true, actions: [] });
    assert.deepEqual(
      replay.linkSettlement,
      JSON.parse(JSON.stringify(result.linkSettlement)),
    );
    assert.equal((await links.resolutionsFor(found.linkId)).length, 1);
  });
  await test("the completion gate requires durable cross-paper review and accepts explicit missing-knowledge deferral", async () => {
    const found = await signal("FINAL_A", "FINAL_B");
    fake.createPaper({ key: "FINAL_A", title: "The final paper" });
    const sessions = await store.readingSessions();
    const session = await sessions.startOrContinue({
      libraryID: 1,
      itemKey: "FINAL_A",
      title: "The final paper",
      totalChunks: 1,
    });
    await sessions.recordDelivery(session.sessionId, [
      { chunkIndex: 0, chunkId: 1 },
    ]);
    await sessions.recordIntegration(session.sessionId, {
      unchanged: false,
      integratedIndexes: [0],
      finalSynthesis: false,
    });
    await sessions.recordIntegration(session.sessionId, {
      unchanged: false,
      integratedIndexes: [],
      finalSynthesis: true,
    });
    await sessions.settleWikiChunks(
      session.sessionId,
      [1],
      "no_update",
      reason,
    );
    sqlite
      .prepare(
        "UPDATE wiki_reading_sessions SET concepts_recorded_at = 1, wiki_review_at = 1, wiki_review = ? WHERE session_id = ?",
      )
      .run(
        JSON.stringify({
          pages: reason,
          claims: reason,
          evidence: reason,
          concepts: reason,
          relations: reason,
          claimVerdicts: [],
        }),
        session.sessionId,
      );
    const blocked = await runner.settleReadingSession(
      { libraryID: 1, readingSessionId: session.sessionId },
      [],
      new Set(),
    );
    assert.equal(blocked.released, false);
    assert.match(blocked.note, /individual decisions/);
    await assert.rejects(
      runner.assertSkippedLinksDecided(1, "FINAL_A", "skipped"),
      /RESOLVE_LINK_SIGNAL/,
    );
    await assert.rejects(
      runner.commit({
        libraryID: 1,
        operationId: "feedback-final-missing",
        actions: [],
      }),
      /Cross-paper Wiki review/,
    );
    const checkpoint = await runner.commit({
      libraryID: 1, operationId: "feedback-final-checkpoint", userInitiated: true,
      readingSessionId: session.sessionId, checkpoint: true,
      actions: [claim("checkpoint finding", ["FINAL_A"])],
    });
    assert.equal(checkpoint.createdClaims, 1);
    assert.notEqual((await sessions.get(session.sessionId)).state, "committed");
    assert.equal((await links.getSignal(found.signalId)).state, "pending");
    await signal("FINAL_B", "THIRD_C");
    const reviewStore = await store.crossPaperReviews();
    const task = (await reviewStore.prepare({ libraryID: 1, itemKey: "FINAL_A", topic: "fulltext", readingRevision: "" }))[0];
    const result = await runner.commit({
      libraryID: 1,
      operationId: "feedback-final-decided",
      userInitiated: true,
      actions: [],
      crossPaperReview: [{ taskId: task.taskId, expectedRevision: task.revision, reviewedTargets: [], outcomes: [{
        outcome: "deferred", targetClaimIds: [], evidenceBindings: [], basis: "The related paper has no Wiki knowledge available for this comparison.",
        gap: "FINAL_B needs source-backed Wiki claims.", trigger: "target_knowledge_changed",
      }] }],
    });
    assert.equal(result.readingSession.released, true);
    assert.equal((await sessions.get(session.sessionId)).state, "committed");
    assert.equal(result.createdClaims, 0);
  });
  await test("an unrelated SKIP cannot masquerade as a signal decision", async () => {
    const found = await signal("BAD_SKIP_A", "BAD_SKIP_B");
    await assert.rejects(
      runner.assertLinkSignalsAnswered({
        libraryID: 1,
        actions: [
          { action: "SKIP", resolvesSignalIds: [found.signalId], reason },
        ],
      }),
      /cannot carry/,
    );
  });
} finally {
  sqlite.close();
  assert.ok(
    path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep),
  );
  fs.rmSync(root, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
