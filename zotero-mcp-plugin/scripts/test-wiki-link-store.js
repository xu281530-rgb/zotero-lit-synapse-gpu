/* eslint-env node */

/**
 * The cross-paper link tables: the pair container, its signals, its
 * resolutions, and the state machine that connects them.
 *
 * The failures each block pins down:
 *
 *   1. A pair discovered from B becomes a second row from the one discovered
 *      from A, so one relationship is stored twice with opposite directions.
 *   2. A rescan doubles every signal, because nothing recognises that the same
 *      finding has been computed again.
 *   3. One pair is forced into ONE relationship, so rejecting a piece of
 *      boilerplate deletes the real connection beside it.
 *   4. A signal somebody settled is settled again, recording two different
 *      conclusions about one finding.
 *   5. The pair's status is maintained by hand and drifts out of agreement
 *      with the signals beneath it.
 *   6. A stale signal is still offered as settleable debt, so a reader is
 *      asked to reconcile a chunk id that now points at different words.
 *   7. A deleted paper leaves its pairs looking like live debt.
 *   8. The per-type cap is applied per scan rather than per pair, so a scan
 *      run in two halves keeps six of a three-signal budget.
 *   9. A scan queue that a restart orphaned never runs again.
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-link-store-"));
const fake = createZoteroFake({ rootDir: tempDir });
fake.install();

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { LINK_ALGORITHM_VERSION } = await import(
  "../src/modules/wiki/wikiLinkScoring.ts"
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

const dbPath = path.join(tempDir, "zotero-mcp-wiki.sqlite");
const sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");
const store = new WikiStore(adapt(sqlite));
await store.initialize();
const links = await store.links();

const results = [];
async function block(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message}`);
  }
}

const semantic = (overrides = {}) => ({
  signalType: "semantic",
  direction: "a_to_b",
  algorithmVersion: LINK_ALGORITHM_VERSION,
  sourceModel: "bge-m3",
  score: 0.7,
  a: { chunkIdSnapshot: 11, chunkTextHash: "a-11", excerpt: "A 的段落" },
  b: { chunkIdSnapshot: 21, chunkTextHash: "b-21", excerpt: "B 的段落" },
  ...overrides,
});

// --- 1. One pair, one row --------------------------------------------------

await block("a pair is one row whichever side discovered it", async () => {
  const fromA = await links.upsertCandidate({
    libraryID: 1,
    itemKeyA: "AAAA",
    itemKeyB: "BBBB",
    scoreAB: 0.8,
    scoreBA: 0.4,
    scoreSymmetric: 0.566,
  });
  const fromB = await links.upsertCandidate({
    libraryID: 1,
    // Discovered later from B: the query side is now B, so its forward score
    // is the pair's score_ba. Getting this backwards is the bug.
    itemKeyA: "BBBB",
    itemKeyB: "AAAA",
    scoreAB: 0.45,
  });
  assert.equal(fromA, fromB, "one pair, one link_id");
  const candidate = await links.getCandidate(fromA);
  assert.equal(candidate.aItemKey, "AAAA");
  assert.equal(candidate.bItemKey, "BBBB");
  assert.equal(candidate.scoreAB, 0.8, "A's forward score is untouched");
  assert.equal(
    candidate.scoreBA,
    0.45,
    "B's forward score lands on score_ba, not on score_ab",
  );
});

await block("a pair of one document with itself is refused", async () => {
  await assert.rejects(
    links.upsertCandidate({ libraryID: 1, itemKeyA: "AAAA", itemKeyB: "AAAA" }),
    /two different documents/u,
  );
});

// --- 2. Deduplication ------------------------------------------------------

let linkId = 0;

await block("the same finding computed twice is one signal", async () => {
  linkId = await links.upsertCandidate({
    libraryID: 1,
    itemKeyA: "AAAA",
    itemKeyB: "BBBB",
  });
  const first = await links.recordSignals({
    linkId,
    signals: [semantic()],
    cap: 3,
  });
  assert.equal(first.written, 1);
  // A rescan of unchanged text, scoring slightly differently as scans do.
  const second = await links.recordSignals({
    linkId,
    signals: [semantic({ score: 0.71 })],
    cap: 3,
  });
  assert.equal(second.written, 0, "the fingerprint ignores the score");
});

await block("a reindexed passage produces a NEW signal", async () => {
  const written = await links.recordSignals({
    linkId,
    signals: [semantic({ a: { chunkIdSnapshot: 11, chunkTextHash: "a-11-v2", excerpt: "A 的段落" } })],
    cap: 3,
  });
  assert.equal(
    written.written,
    1,
    "silently reusing the old chunk id under new text is the failure this prevents",
  );
});

// --- 8. The cap ------------------------------------------------------------

await block("the per-type cap is per pair, not per scan", async () => {
  // Two scans of three signals each. A cap applied per call keeps six.
  for (const half of [0, 1]) {
    await links.recordSignals({
      linkId,
      cap: 3,
      signals: [0, 1, 2].map((index) =>
        semantic({
          score: 0.5 + half * 0.1 + index * 0.01,
          a: {
            chunkIdSnapshot: 100 + half * 10 + index,
            chunkTextHash: `a-${half}-${index}`,
            excerpt: `段落 ${half}-${index}`,
          },
        }),
      ),
    });
  }
  const pending = await links.pendingSignalsForItem({
    libraryID: 1,
    itemKey: "AAAA",
    limit: 50,
  });
  const semanticPending = pending.filter(
    (signal) => signal.signalType === "semantic",
  );
  assert.equal(semanticPending.length, 3, "three, not six");
  // And the three kept are the best three across BOTH halves.
  const scores = semanticPending.map((signal) => signal.score).sort((a, b) => b - a);
  assert.ok(scores[2] >= 0.6, `kept the strongest, got ${scores.join(", ")}`);
});

// --- 3-4. Several conclusions per pair -------------------------------------

await block("one pair holds several conclusions at once", async () => {
  const pairId = await links.upsertCandidate({
    libraryID: 1,
    itemKeyA: "CCCC",
    itemKeyB: "DDDD",
    scoreSymmetric: 0.6,
  });
  await links.recordSignals({
    linkId: pairId,
    cap: 3,
    signals: [
      semantic({ a: { chunkTextHash: "c-1", chunkIdSnapshot: 1, excerpt: "机制" }, b: { chunkTextHash: "d-1", chunkIdSnapshot: 2, excerpt: "机制" } }),
      semantic({ a: { chunkTextHash: "c-2", chunkIdSnapshot: 3, excerpt: "矛盾" }, b: { chunkTextHash: "d-2", chunkIdSnapshot: 4, excerpt: "矛盾" } }),
      semantic({ a: { chunkTextHash: "c-3", chunkIdSnapshot: 5, excerpt: "制样套话" }, b: { chunkTextHash: "d-3", chunkIdSnapshot: 6, excerpt: "制样套话" } }),
    ],
  });
  const pending = await links.pendingSignalsForItem({
    libraryID: 1,
    itemKey: "CCCC",
    limit: 50,
  });
  assert.equal(pending.length, 3);
  const [mechanism, conflict, boilerplate] = pending;

  await links.recordResolution({
    linkId: pairId,
    resolutionType: "shared_claim",
    signalIds: [mechanism.signalId],
    claimId: 7,
    note: "Both papers support one Claim about the mechanism.",
  });
  await links.recordResolution({
    linkId: pairId,
    resolutionType: "conflict",
    signalIds: [conflict.signalId],
    claimId: 8,
    note: "They disagree under comparable conditions.",
  });
  await links.rejectSignals(
    [boilerplate.signalId],
    "Only shared sample-preparation wording; no comparable condition or result.",
  );

  const resolutions = await links.resolutionsFor(pairId);
  assert.equal(resolutions.length, 2, "a second conclusion must not overwrite the first");
  assert.deepEqual(
    resolutions.map((row) => row.resolutionType).sort(),
    ["conflict", "shared_claim"],
  );
  // And rejecting the boilerplate left the other two standing.
  const settled = await links.getSignal(boilerplate.signalId);
  assert.equal(settled.state, "rejected");
  assert.ok(settled.rejectedReason.length > 20, "the reason is kept forever");
  assert.equal((await links.getSignal(mechanism.signalId)).state, "accepted");
});

await block("a settled signal cannot be settled twice", async () => {
  const pending = await links.pendingSignalsForItem({
    libraryID: 1,
    itemKey: "AAAA",
    limit: 1,
  });
  const target = pending[0];
  assert.equal(await links.acceptSignals([target.signalId]), 1);
  assert.equal(
    await links.acceptSignals([target.signalId]),
    0,
    "the second attempt settles nothing rather than recording a second verdict",
  );
});

// --- 5. The derived status -------------------------------------------------

await block("status is derived, never asserted", async () => {
  const pairId = await links.upsertCandidate({
    libraryID: 1,
    itemKeyA: "EEEE",
    itemKeyB: "FFFF",
  });
  assert.equal(
    (await links.getCandidate(pairId)).status,
    "open",
    "a container awaiting its first scan owes a scan, not a decision",
  );
  await links.recordSignals({
    linkId: pairId,
    cap: 3,
    signals: [semantic({ a: { chunkTextHash: "e-1", chunkIdSnapshot: 1, excerpt: "x" }, b: { chunkTextHash: "f-1", chunkIdSnapshot: 2, excerpt: "y" } })],
  });
  assert.equal((await links.getCandidate(pairId)).status, "open");

  const [signal] = await links.pendingSignalsForItem({
    libraryID: 1,
    itemKey: "EEEE",
    limit: 5,
  });
  await links.rejectSignals([signal.signalId], "Only method boilerplate in common.");
  assert.equal(
    (await links.getCandidate(pairId)).status,
    "dismissed",
    "everything rejected and nothing written",
  );

  // A NEW pending signal reopens a dismissed pair: a later scan found
  // something the earlier rejection was not about.
  await links.recordSignals({
    linkId: pairId,
    cap: 3,
    signals: [semantic({ a: { chunkTextHash: "e-2", chunkIdSnapshot: 3, excerpt: "新" }, b: { chunkTextHash: "f-2", chunkIdSnapshot: 4, excerpt: "新" } })],
  });
  assert.equal((await links.getCandidate(pairId)).status, "open");

  const [reopened] = await links.pendingSignalsForItem({
    libraryID: 1,
    itemKey: "EEEE",
    limit: 5,
  });
  await links.recordResolution({
    linkId: pairId,
    resolutionType: "same_page",
    signalIds: [reopened.signalId],
    note: "Both belong under one entry as separate Claims.",
  });
  assert.equal((await links.getCandidate(pairId)).status, "resolved");
});

// --- 6-7. Invalidation -----------------------------------------------------

await block("a stale signal stops being debt", async () => {
  const pairId = await links.upsertCandidate({
    libraryID: 1,
    itemKeyA: "GGGG",
    itemKeyB: "HHHH",
  });
  await links.recordSignals({
    linkId: pairId,
    cap: 3,
    signals: [semantic({ a: { chunkTextHash: "g-1", chunkIdSnapshot: 1, excerpt: "旧" }, b: { chunkTextHash: "h-1", chunkIdSnapshot: 2, excerpt: "旧" } })],
  });
  const [signal] = await links.pendingSignalsForItem({
    libraryID: 1,
    itemKey: "GGGG",
    limit: 5,
  });
  assert.equal(await links.markSignalsStale([signal.signalId]), 1);
  assert.equal(
    (await links.pendingSignalsForItem({ libraryID: 1, itemKey: "GGGG", limit: 5 })).length,
    0,
    "a stale signal is not offered for settlement",
  );
  assert.equal((await links.getCandidate(pairId)).status, "stale");
  // Relocation moves the anchor without inventing a new excerpt.
  await links.markSignalsStale([signal.signalId]);
  const stale = await links.getSignal(signal.signalId);
  assert.equal(stale.state, "stale");
  assert.equal(stale.a.excerpt, "旧", "the excerpt records what was compared");
});

await block("a settled signal is history and does not go stale", async () => {
  const pairId = await links.upsertCandidate({
    libraryID: 1,
    itemKeyA: "IIII",
    itemKeyB: "JJJJ",
  });
  await links.recordSignals({
    linkId: pairId,
    cap: 3,
    signals: [semantic({ a: { chunkTextHash: "i-1", chunkIdSnapshot: 1, excerpt: "q" }, b: { chunkTextHash: "j-1", chunkIdSnapshot: 2, excerpt: "r" } })],
  });
  const [signal] = await links.pendingSignalsForItem({
    libraryID: 1,
    itemKey: "IIII",
    limit: 5,
  });
  await links.acceptSignals([signal.signalId]);
  assert.equal(
    await links.markSignalsStale([signal.signalId]),
    0,
    "an accepted signal already produced a Claim; its provenance is the Evidence relinker's job",
  );
});

await block("a deleted paper stops owing anything", async () => {
  const pairId = await links.upsertCandidate({
    libraryID: 1,
    itemKeyA: "KKKK",
    itemKeyB: "LLLL",
  });
  await links.recordSignals({
    linkId: pairId,
    cap: 3,
    signals: [semantic({ a: { chunkTextHash: "k-1", chunkIdSnapshot: 1, excerpt: "s" }, b: { chunkTextHash: "l-1", chunkIdSnapshot: 2, excerpt: "t" } })],
  });
  assert.equal(await links.markSourceDeleted(1, "LLLL"), 1);
  assert.equal((await links.getCandidate(pairId)).status, "source_deleted");
  assert.equal(
    (await links.pendingSignalsForItem({ libraryID: 1, itemKey: "KKKK", limit: 5 })).length,
    0,
  );
  // Restoring the paper does not silently resurrect the old finding: the pair
  // goes back to needing a scan, not back to being debt.
  await links.clearSourceDeleted(1, "LLLL");
  const restored = await links.getCandidate(pairId);
  assert.notEqual(restored.status, "source_deleted");
  assert.notEqual(restored.status, "open");
});

// --- 9. The scan queue -----------------------------------------------------

await block("queueing is idempotent and survives a restart", async () => {
  assert.equal(
    await links.enqueueScan({ libraryID: 1, itemKey: "AAAA", reason: "read" }),
    true,
  );
  assert.equal(
    await links.enqueueScan({ libraryID: 1, itemKey: "AAAA", reason: "read again" }),
    false,
    "a paper read four times in a session enqueues once",
  );
  const claimed = await links.claimNextScan();
  assert.equal(claimed.itemKey, "AAAA");
  assert.equal(claimed.state, "running");
  assert.equal(await links.claimNextScan(), null, "and only one worker gets it");

  // A crash leaves it 'running' forever unless something re-arms it.
  assert.equal(await links.requeueOrphanedScans(), 1);
  const again = await links.claimNextScan();
  assert.equal(again.itemKey, "AAAA");
  await links.finishScan({
    libraryID: 1,
    itemKey: "AAAA",
    contentHash: "hash",
    chunkSignature: "sig",
    resetGeneration: "gen",
    selectorVersion: "repr-v1",
    algorithmVersion: LINK_ALGORITHM_VERSION,
    embeddingModel: "bge-m3",
    candidatesWritten: 2,
    signalsWritten: 5,
  });
  const record = await links.scanRecord(1, "AAAA");
  assert.equal(record.state, "done");
  assert.equal(record.signalsWritten, 5);
  assert.equal(
    await links.enqueueScan({ libraryID: 1, itemKey: "AAAA", reason: "again" }),
    false,
    "an ordinary re-read does not rescan a finished paper",
  );
  assert.equal(
    await links.enqueueScan({
      libraryID: 1,
      itemKey: "AAAA",
      reason: "model changed",
      force: true,
    }),
    true,
    "but an explicit rescan does",
  );
});

await block("a failing scan backs off, then stops without vanishing", async () => {
  await links.enqueueScan({ libraryID: 1, itemKey: "ZZZZ", reason: "read" });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claimed = await links.claimNextScan(Date.now() + 3_600_000);
    if (!claimed) break;
    // Other papers may be queued from earlier blocks; retire them so the
    // backoff being measured is this one's.
    if (claimed.itemKey !== "ZZZZ") {
      await links.finishScan({
        libraryID: claimed.libraryID,
        itemKey: claimed.itemKey,
        contentHash: "",
        chunkSignature: "",
        resetGeneration: "",
        selectorVersion: "",
        algorithmVersion: "",
        embeddingModel: "",
        candidatesWritten: 0,
        signalsWritten: 0,
      });
      continue;
    }
    await links.failScan({
      libraryID: 1,
      itemKey: "ZZZZ",
      error: "no vectors",
      retryDelayMs: 0,
      maxAttempts: 3,
    });
  }
  const record = await links.scanRecord(1, "ZZZZ");
  assert.equal(record.state, "failed");
  assert.ok(record.lastError.includes("no vectors"));
  assert.ok(
    record.attempts >= 3,
    "the row stays as the record that this paper has no candidates and why",
  );
});

// --- Reporting -------------------------------------------------------------

await block("statistics separate the three discovery paths", async () => {
  const stats = await links.statistics(1);
  assert.ok(stats.linkCandidates > 0);
  assert.equal(
    stats.linkSignalsPending + stats.linkSignalsAccepted +
      stats.linkSignalsRejected + stats.linkSignalsStale,
    Object.values(stats.linkSignalsByType).reduce((sum, n) => sum + n, 0),
    "every signal is counted exactly once",
  );
  assert.ok("semantic" in stats.linkPendingByType);
  assert.ok("lexical" in stats.linkRejectedByType);
  assert.ok("concept" in stats.linkSignalsByType);
  assert.ok(
    stats.linkRejectedRate >= 0 && stats.linkRejectedRate <= 1,
    "the guard against a reader who dismisses everything",
  );
  assert.equal(
    stats.linkSignalsMandatory,
    0,
    "nothing is mandatory until the caller supplies the ledger check",
  );
  assert.equal(stats.linkScanFailed, 1);
});

await block("a Wiki reset removes the link layer too", async () => {
  await store.clearAll();
  const stats = await links.statistics(1);
  assert.equal(stats.linkCandidates, 0);
  assert.equal(stats.linkSignalsPending, 0);
  assert.equal(
    stats.linkScanQueued + stats.linkScanDone + stats.linkScanFailed,
    0,
    "candidates describe pairs of papers the Wiki no longer knows anything about",
  );
});

sqlite.close();
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  // Windows keeps a handle on a just-closed SQLite file for a moment.
}

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
