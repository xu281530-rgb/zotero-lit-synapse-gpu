/* eslint-env node */

/**
 * What a link dismissal actually records, and what has to happen when the
 * ground it stood on moves.
 *
 * Two failures from one measured run, both about a judgement outliving its
 * reason.
 *
 * The FIRST is a dismissal that stayed true-looking after the knowledge it
 * cited was deleted. A pair was dismissed with "the mechanisms here are
 * already covered by this page's continuous-recrystallisation Claim", which
 * was true when it was written. A Wiki data reset then removed every Page,
 * Claim and resolution - but deliberately KEPT the rejected signals, on the
 * argument that "these two passages only share boilerplate" survives a reset.
 * That argument holds for a judgement about the two excerpts. It does not hold
 * for a judgement about what the Wiki already knows, and the server cannot
 * tell the two apart by reading the sentence. The result was a pair whose two
 * papers went on to support two shared Claims, and whose highest-scoring
 * semantic signals in the whole library sat permanently dismissed.
 *
 * So: a reset returns rejected signals to pending (keeping what was said as
 * `prior_rejection`), and a commit whose Claim cites both sides of an
 * already-dismissed pair reopens that pair and flags it for review, without
 * rewriting what the earlier reader concluded.
 *
 * The SECOND is one reason copied onto a batch of unlike signals. One measured
 * dismissal covered three signals across three different chunk pairs and two
 * signal types with the reason "both sides are the journal's standard
 * competing-interest declaration" - true of exactly one of them. Another
 * covered six signals with a reason that named chunk 43 and chunk 40, which
 * was true of exactly one of them. The archive is then worse than empty: it
 * describes a different passage from the one it is filed against.
 *
 * Each block is named for the thing that has to be true:
 *
 *   1. A reset returns a dismissed pair to the queue, keeping what was said.
 *   2. A Claim citing both papers reopens a pair that was dismissed.
 *   3. A pair nothing contradicts stays dismissed.
 *   4. One reason may not cover several signals.
 *   5. Per-signal reasons land on their own signals.
 *   6. Each reason is held to the same standard as one.
 *   7. A single-signal dismissal still works the short way.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-link-settle-"));
const fake = createZoteroFake({ rootDir: tempDir });
fake.install();

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiLinkService, normalizeLinkDismissals } = await import(
  "../src/modules/wiki/wikiLinkService.ts"
);
const { LINK_ALGORITHM_VERSION } = await import(
  "../src/modules/wiki/wikiLinkScoring.ts"
);
const { hashWikiText } = await import(
  "../src/modules/wiki/wikiCanonicalizer.ts"
);

function adapt(sqlite) {
  let depth = 0;
  const normalize = (params) =>
    params.map((value) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
  return {
    async queryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const statement = sqlite.prepare(sql);
      const values = normalize(params);
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) {
        return statement.all(...values);
      }
      statement.run(...values);
      return [];
    },
    async valueQueryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const row = sqlite.prepare(sql).get(...normalize(params));
      return row ? Object.values(row)[0] : undefined;
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

const dbPath = path.join(tempDir, "zotero-lit-synapse-wiki.sqlite");
const sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");
const database = adapt(sqlite);
const store = new WikiStore(database);
await store.initialize();
const links = await store.links();
const linkService = new WikiLinkService(store);

const results = [];
async function block(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.stack ?? error.message}`);
  }
}

/**
 * The dismissal that started this, near enough to quote.
 *
 * It argues from the Wiki's state rather than from the two excerpts, which is
 * exactly the kind a reset invalidates and the kind nothing could detect by
 * reading it.
 */
const COVERED_ELSEWHERE =
  "两侧原文都在描述柱状晶高温合金中亚晶转动与位错累积导致的连续动态再结晶，" +
  "两篇文献在各自温区下的形核机理已分别被本页面既有的连续动态再结晶 Claim 所涵盖，无需单独建立跨篇关联。";

const BOILERPLATE_ONLY =
  "两侧原文均为学术期刊标准的无利益冲突声明格式化表述，与高温合金再结晶形核物理机制、" +
  "晶界动力学及微观组织演变完全无关，无法共同支撑任何一条学术 Claim。";

const MISORIENTATION_ONLY =
  "两侧分别给出取向差沿箭头的分布曲线，但一侧统计的是变形态柱状晶内部，" +
  "另一侧统计的是退火态枝晶间区域，测量对象与热历史都不同，无法合并为同一条 Claim 的证据。";

const signalInput = (overrides = {}) => ({
  signalType: "semantic",
  direction: "a_to_b",
  algorithmVersion: LINK_ALGORITHM_VERSION,
  sourceModel: "bge-m3",
  score: 0.85,
  a: { chunkIdSnapshot: 40, chunkTextHash: "a-40", excerpt: "A 侧原文段落" },
  b: { chunkIdSnapshot: 43, chunkTextHash: "b-43", excerpt: "B 侧原文段落" },
  ...overrides,
});

async function pairWithSignals(itemKeyA, itemKeyB, signals) {
  const linkId = await links.upsertCandidate({
    libraryID: 1,
    itemKeyA,
    itemKeyB,
    scoreAB: 0.64,
    scoreBA: 0.64,
    scoreSymmetric: 0.64,
  });
  await links.recordSignals({ linkId, signals, cap: 8 });
  const signalIds = sqlite
    .prepare(
      "SELECT signal_id FROM wiki_link_signals WHERE link_id = ? AND state = 'pending' ORDER BY signal_id",
    )
    .all(linkId)
    .map((row) => Number(row.signal_id));
  return { linkId, signalIds };
}

function candidateRow(linkId) {
  return sqlite
    .prepare("SELECT * FROM wiki_link_candidates WHERE link_id = ?")
    .get(linkId);
}

function signalRows(linkId) {
  return sqlite
    .prepare(
      "SELECT * FROM wiki_link_signals WHERE link_id = ? ORDER BY signal_id",
    )
    .all(linkId);
}

console.log("wiki link settlement");

// --- 1. A reset returns a dismissed pair to the queue -----------------------

await block("a Wiki reset puts a dismissed pair back in the queue", async () => {
  const { linkId, signalIds } = await pairWithSignals("AAAAAAAA", "BBBBBBBB", [
    signalInput(),
    signalInput({
      signalType: "lexical",
      score: 0.58,
      termSnapshot: "consume",
      a: { chunkIdSnapshot: 37, chunkTextHash: "a-37", excerpt: "A 词汇段" },
      b: { chunkIdSnapshot: 23, chunkTextHash: "b-23", excerpt: "B 词汇段" },
    }),
  ]);
  await linkService.resolveSignals({
    libraryID: 1,
    signalIds,
    resolutionType: "no_action",
    note: COVERED_ELSEWHERE,
    reasonBySignal: new Map(signalIds.map((id) => [id, COVERED_ELSEWHERE])),
  });
  // A `no_action` writes a resolution row, so `refreshStatus` reads the pair
  // as settled - `dismissed` is what it becomes only once a reset has removed
  // that row, which is exactly the state the real library was found in.
  assert.equal(candidateRow(linkId).status, "resolved");

  await store.clearAll();

  assert.equal(
    candidateRow(linkId).status,
    "open",
    "a reset deletes the knowledge a dismissal may have cited, so the pair has to be asked again",
  );
  for (const row of signalRows(linkId)) {
    assert.equal(row.state, "pending");
    assert.equal(row.settled_at, null);
    assert.equal(
      String(row.prior_rejection ?? ""),
      COVERED_ELSEWHERE,
      "what the earlier reader concluded is kept, so it is re-judged rather than re-derived",
    );
    assert.ok(
      !row.rejected_reason,
      "a pending signal must not still carry a rejection",
    );
  }
});

// --- 2 & 3. A Claim citing both sides contradicts the dismissal -------------

const CHUNK_TEXT =
  "Subgrain rotation accumulates misorientation until the boundary crosses fifteen degrees.";
const chunkHash = await hashWikiText(CHUNK_TEXT);

function evidenceFor(itemKey, chunkId) {
  return {
    libraryID: 1,
    itemKey,
    chunkIdSnapshot: chunkId,
    chunkTextHash: chunkHash,
    sourceContentHash: "content-v1",
    sourceChunkSignature: "paragraph-v3:1000:500",
    sourceResetGeneration: "reset-17",
    excerpt: "accumulates misorientation until the boundary crosses",
    evidenceRole: "SUPPORTS",
    readDepth: "section_read",
  };
}

await block("a Claim citing both papers reopens the pair", async () => {
  const { linkId, signalIds } = await pairWithSignals("CCCCCCCC", "DDDDDDDD", [
    signalInput(),
  ]);
  await linkService.resolveSignals({
    libraryID: 1,
    signalIds,
    resolutionType: "no_action",
    note: COVERED_ELSEWHERE,
    reasonBySignal: new Map(signalIds.map((id) => [id, COVERED_ELSEWHERE])),
  });
  assert.equal(candidateRow(linkId).status, "resolved");

  const commit = await store.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "CREATE_PAGE",
        ref: "page:cdrx",
        canonicalTitle: "Continuous dynamic recrystallisation",
      },
      {
        action: "ADD_CLAIM",
        ref: "claim:shared",
        pageId: "page:cdrx",
        claimText:
          "Subgrain rotation carries misorientation past the high-angle threshold in both alloys.",
        claimType: "mechanism",
        epistemicStatus: "corroborated",
        coverageLevel: "section_read",
        evidence: [evidenceFor("CCCCCCCC", 40), evidenceFor("DDDDDDDD", 43)],
      },
    ],
  });

  const reopened = await linkService.reopenContradictedDismissals({
    libraryID: 1,
    claimIds: commit.affectedClaimIds,
  });
  assert.equal(reopened.length, 1, "exactly the contradicted pair comes back");
  assert.equal(reopened[0].linkId, linkId);
  assert.equal(reopened[0].claimId, commit.refs["claim:shared"]);

  const candidate = candidateRow(linkId);
  assert.equal(candidate.status, "open");
  assert.ok(
    Number(candidate.reopened_at) > 0,
    "the pair records that it was reopened rather than never settled",
  );
  assert.match(
    String(candidate.reopened_reason),
    new RegExp(String(commit.refs["claim:shared"])),
    "the flag names the Claim that contradicted the dismissal",
  );
  const [signal] = signalRows(linkId);
  assert.equal(signal.state, "pending");
  assert.equal(
    String(signal.prior_rejection),
    COVERED_ELSEWHERE,
    "the original judgement is preserved, not rewritten",
  );
  const resolution = sqlite
    .prepare("SELECT * FROM wiki_link_resolutions WHERE link_id = ?")
    .get(linkId);
  assert.ok(resolution, "the audit row for the original dismissal is untouched");
  assert.equal(resolution.resolution_type, "no_action");
});

await block("evidence attached to an existing Claim reopens too", async () => {
  // The case the sweep actually exists for. The Claim is not written by the
  // commit that contradicts the dismissal - it was already there, and a second
  // paper's excerpt arrives on it later, which is when a pair somebody
  // dismissed turns out to share a Claim after all.
  const solo = await store.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "CREATE_PAGE",
        ref: "page:rotation",
        canonicalTitle: "Subgrain rotation thresholds",
      },
      {
        action: "ADD_CLAIM",
        ref: "claim:rotation",
        pageId: "page:rotation",
        claimText:
          "Accumulated misorientation crosses the high-angle threshold before a new grain is counted.",
        claimType: "mechanism",
        epistemicStatus: "supported",
        coverageLevel: "section_read",
        evidence: [evidenceFor("KKKKKKKK", 40)],
      },
    ],
  });
  const claimId = solo.refs["claim:rotation"];

  const { linkId, signalIds } = await pairWithSignals("KKKKKKKK", "LLLLLLLL", [
    signalInput(),
  ]);
  await linkService.resolveSignals({
    libraryID: 1,
    signalIds,
    resolutionType: "no_action",
    note: COVERED_ELSEWHERE,
    reasonBySignal: new Map(signalIds.map((id) => [id, COVERED_ELSEWHERE])),
  });

  const attached = await store.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "ATTACH_EVIDENCE",
        claimId,
        evidence: [evidenceFor("LLLLLLLL", 43)],
      },
    ],
  });
  assert.deepEqual(
    attached.evidenceChangedClaimIds,
    [claimId],
    "an ATTACH_EVIDENCE reports the Claim whose support it moved",
  );

  const reopened = await linkService.reopenContradictedDismissals({
    libraryID: 1,
    claimIds: [
      ...attached.affectedClaimIds,
      ...attached.evidenceChangedClaimIds,
    ],
  });
  assert.deepEqual(
    reopened.map((entry) => entry.linkId),
    [linkId],
  );
  assert.equal(candidateRow(linkId).status, "open");
});

await block("a pair nothing contradicts stays dismissed", async () => {
  const { linkId, signalIds } = await pairWithSignals("EEEEEEEE", "FFFFFFFF", [
    signalInput(),
  ]);
  await linkService.resolveSignals({
    libraryID: 1,
    signalIds,
    resolutionType: "no_action",
    note: BOILERPLATE_ONLY,
    reasonBySignal: new Map(signalIds.map((id) => [id, BOILERPLATE_ONLY])),
  });
  const claimIds = sqlite
    .prepare("SELECT claim_id FROM wiki_claims")
    .all()
    .map((row) => Number(row.claim_id));
  const reopened = await linkService.reopenContradictedDismissals({
    libraryID: 1,
    claimIds,
  });
  assert.equal(
    reopened.filter((entry) => entry.linkId === linkId).length,
    0,
    "a dismissal no Claim contradicts is left alone",
  );
  assert.equal(candidateRow(linkId).status, "resolved");
  assert.equal(signalRows(linkId)[0].state, "rejected");
});

// --- 4 to 7. One reason per signal ------------------------------------------

await block("one reason may not cover several signals", async () => {
  assert.equal(typeof normalizeLinkDismissals, "function");
  assert.throws(
    () =>
      normalizeLinkDismissals({
        action: "DISMISS_LINK_SIGNALS",
        signalIds: [11, 12, 13],
        reason: BOILERPLATE_ONLY,
      }),
    /one reason per signal|dismissals/iu,
    "a reason that describes one signal must not be filed against three",
  );
});

await block("per-signal reasons land on their own signals", async () => {
  const { linkId, signalIds } = await pairWithSignals("GGGGGGGG", "HHHHHHHH", [
    signalInput({
      a: {
        chunkIdSnapshot: 52,
        chunkTextHash: "a-52",
        excerpt: "## Declaration of Competing Interest",
      },
      b: {
        chunkIdSnapshot: 24,
        chunkTextHash: "b-24",
        excerpt: "## Declaration of competing interest",
      },
    }),
    signalInput({
      score: 0.7,
      a: {
        chunkIdSnapshot: 40,
        chunkTextHash: "a-40b",
        excerpt: "misorientation profiles are given in Fig. 9",
      },
      b: {
        chunkIdSnapshot: 14,
        chunkTextHash: "b-14",
        excerpt: "The accumulated misorientation profiles along the blue arrows",
      },
    }),
  ]);
  const [boilerplateSignal, misorientationSignal] = signalIds;
  const normalized = normalizeLinkDismissals({
    action: "DISMISS_LINK_SIGNALS",
    dismissals: [
      { signalId: boilerplateSignal, reason: BOILERPLATE_ONLY },
      { signalId: misorientationSignal, reason: MISORIENTATION_ONLY },
    ],
  });
  assert.equal(normalized.length, 2);

  await linkService.resolveSignals({
    libraryID: 1,
    signalIds: normalized.map((entry) => entry.signalId),
    resolutionType: "no_action",
    note: normalized.map((entry) => entry.reason).join("\n"),
    reasonBySignal: new Map(
      normalized.map((entry) => [entry.signalId, entry.reason]),
    ),
  });

  const rows = signalRows(linkId);
  const byId = new Map(rows.map((row) => [Number(row.signal_id), row]));
  assert.equal(
    String(byId.get(boilerplateSignal).rejected_reason),
    BOILERPLATE_ONLY,
  );
  assert.equal(
    String(byId.get(misorientationSignal).rejected_reason),
    MISORIENTATION_ONLY,
    "the misorientation signal must not be archived as a competing-interest declaration",
  );
  const resolution = sqlite
    .prepare("SELECT * FROM wiki_link_resolutions WHERE link_id = ?")
    .get(linkId);
  assert.ok(
    String(resolution.resolution_note).includes(BOILERPLATE_ONLY) &&
      String(resolution.resolution_note).includes(MISORIENTATION_ONLY),
    "the settlement row carries every reason it settled",
  );
});

await block("each reason is held to the same standard as one", async () => {
  assert.throws(
    () =>
      normalizeLinkDismissals({
        action: "DISMISS_LINK_SIGNALS",
        dismissals: [
          { signalId: 21, reason: BOILERPLATE_ONLY },
          { signalId: 22, reason: "不相关" },
        ],
      }),
    /assert|argue|不相关/iu,
    "a per-signal reason may not be the reflex answer",
  );
  assert.throws(
    () =>
      normalizeLinkDismissals({
        action: "DISMISS_LINK_SIGNALS",
        dismissals: [{ signalId: 23, reason: "两侧原文不同。" }],
      }),
    /characters|字/iu,
    "a per-signal reason may not be shorter than the floor",
  );
  assert.throws(
    () =>
      normalizeLinkDismissals({
        action: "DISMISS_LINK_SIGNALS",
        dismissals: [{ signalId: 24 }],
      }),
    /reason/iu,
    "a dismissal entry without a reason is refused",
  );
});

// --- 8. A reopened pair says why it is being asked again ---------------------

await block("a reopened pair carries what the last reader said", async () => {
  const { linkId, signalIds } = await pairWithSignals("IIIIIIII", "JJJJJJJJ", [
    signalInput(),
  ]);
  await linkService.resolveSignals({
    libraryID: 1,
    signalIds,
    resolutionType: "no_action",
    note: COVERED_ELSEWHERE,
    reasonBySignal: new Map(signalIds.map((id) => [id, COVERED_ELSEWHERE])),
  });
  await links.reopenRejected(linkId, "the Claim it said could not exist now does");

  const [view] = await linkService.pendingSignals({
    libraryID: 1,
    itemKey: "IIIIIIII",
  });
  assert.ok(view, "the reopened pair is offered again");
  assert.equal(view.linkId, linkId);
  assert.match(
    String(view.reopenedReason),
    /could not exist/u,
    "the pair says what changed, or the same answer comes back",
  );
  assert.deepEqual(
    view.priorDismissals,
    [{ signalId: signalIds[0], reason: COVERED_ELSEWHERE }],
    "and what the earlier reader concluded, to argue with rather than repeat",
  );
});

await block("a single-signal dismissal still works the short way", async () => {
  const normalized = normalizeLinkDismissals({
    action: "DISMISS_LINK_SIGNALS",
    signalIds: [31],
    reason: BOILERPLATE_ONLY,
  });
  assert.deepEqual(normalized, [{ signalId: 31, reason: BOILERPLATE_ONLY }]);
});

const failed = results.filter(([ok]) => !ok);
if (failed.length) {
  console.error(`\nwiki link settlement: ${failed.length} block(s) failed`);
  process.exitCode = 1;
} else {
  console.log("wiki link settlement: all blocks passed");
}
