/* eslint-env node */

/**
 * "Timeout" must mean the request ENDS at the deadline — not that the code
 * looks at the clock once the underlying query finally comes back.
 *
 * The regression: `runLexicalSearch` awaited `Zotero.Search.search()` with no
 * deadline of any kind, and only consulted `deadlineAt` afterwards, between
 * candidate chunks. `keyword_search` then awaited that whole thing directly,
 * with `isCancelled: () => false`. So a slow library query ran for as long as
 * it wanted and the user's configured timeout described nothing at all.
 *
 * Two separate guarantees are needed, and the tests below keep them apart:
 *
 *   1. the request returns at the deadline, whatever the query does; and
 *   2. because Zotero's search cannot be cancelled, the abandoned query must
 *      not let a replacement start on top of it — otherwise repeated timeouts
 *      pile up background work that makes the next search slower still.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.ztoolkit = { log: () => {} };

const {
  KeywordSearchGate,
  KeywordSearchOverloadedError,
  isKeywordSearchOverloadedError,
} = await import("../src/modules/keywordSearchGate.ts");
const { isLexicalSearchTimeoutError, runLexicalSearch } = await import(
  "../src/modules/lexicalSearch.ts"
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpSource = fs.readFileSync(
  path.join(root, "src/modules/streamableMCPServer.ts"),
  "utf8",
);
const lexicalSource = fs.readFileSync(
  path.join(root, "src/modules/lexicalSearch.ts"),
  "utf8",
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyword = (text) => ({ text, weight: 1, origin: "ai" });

/**
 * A Zotero double whose item query takes `searchMs`, and which counts how many
 * of those queries have been started but not yet finished.
 */
function installZotero({ searchMs, ids = [1, 2, 3] }) {
  const state = { started: 0, running: 0, peakRunning: 0, finished: 0 };
  globalThis.Zotero = {
    Libraries: { userLibraryID: 1 },
    Search: class {
      addCondition() {}
      async search() {
        state.started++;
        state.running++;
        state.peakRunning = Math.max(state.peakRunning, state.running);
        try {
          await sleep(searchMs);
          return ids;
        } finally {
          state.running--;
          state.finished++;
        }
      }
    },
    Items: {
      getAsync: async (chunk) =>
        chunk.map((id) => ({
          id,
          key: `K${id}`,
          deleted: false,
          isRegularItem: () => true,
          getField: (field) => (field === "title" ? `Item ${id}` : ""),
          getCreators: () => [],
        })),
    },
  };
  return state;
}

// ============================================================================
// 1. The request really does end at the deadline.
// ============================================================================

{
  // The query takes 5s; the caller allows 300ms. Before the fix this call
  // returned after ~5s, because the deadline was only checked after `search()`
  // resolved.
  const state = installZotero({ searchMs: 5000 });
  const startedAt = Date.now();
  const deadlineMs = 300;

  await assert.rejects(
    () =>
      runLexicalSearch({
        keywords: [keyword("microtwinning")],
        libraryID: 1,
        deadlineAt: Date.now() + deadlineMs,
        onDeadline: "throw",
        gate: new KeywordSearchGate(),
      }),
    (error) => {
      assert.ok(
        isLexicalSearchTimeoutError(error),
        "the failure must be typed as a timeout, not as a generic error",
      );
      assert.match(error.message, /timed out/i);
      assert.match(
        error.message,
        /discarded/i,
        "the message must say the late result is thrown away",
      );
      return true;
    },
  );

  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < deadlineMs + 250,
    `the request must return at ~${deadlineMs}ms, not wait 5000ms for the query (took ${elapsed}ms)`,
  );
  assert.ok(
    elapsed >= deadlineMs - 50,
    `the request must not return before its deadline (took ${elapsed}ms)`,
  );

  // The query it abandoned is still running — that is the honest situation,
  // and precisely why the gate below exists.
  assert.equal(state.running, 1);
}

// ---- a deadline already in the past fails immediately ----

{
  installZotero({ searchMs: 5000 });
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      runLexicalSearch({
        keywords: [keyword("late")],
        libraryID: 1,
        deadlineAt: Date.now() - 1,
        onDeadline: "throw",
        gate: new KeywordSearchGate(),
      }),
    isLexicalSearchTimeoutError,
  );
  assert.ok(Date.now() - startedAt < 200, "an expired deadline must not wait");
}

// ---- a search that fits inside the deadline is unaffected ----

{
  installZotero({ searchMs: 20 });
  const outcome = await runLexicalSearch({
    keywords: [keyword("item")],
    libraryID: 1,
    deadlineAt: Date.now() + 3000,
    onDeadline: "throw",
    gate: new KeywordSearchGate(),
  });
  assert.equal(outcome.diagnostics.truncated, false);
  assert.equal(outcome.diagnostics.candidateIDs, 3);
  assert.ok(outcome.items.length > 0, "normal searches must still return rows");
}

// ---- with no deadline at all, nothing is imposed ----

{
  installZotero({ searchMs: 20 });
  const outcome = await runLexicalSearch({
    keywords: [keyword("item")],
    libraryID: 1,
    gate: new KeywordSearchGate(),
  });
  assert.equal(outcome.diagnostics.candidateIDs, 3);
}

// ---- hybrid keeps partial results; keyword_search does not ----

{
  // Both branches see the same expired scan deadline. hybrid fuses a partial
  // lexical ranking with a complete semantic one, so a subset is useful there;
  // a single-branch keyword_search has nothing to fuse with, and a subset is
  // indistinguishable from a complete short answer.
  assert.match(
    lexicalSource,
    /onDeadline\?: "truncate" \| "throw";/,
    "the two behaviours must be selectable",
  );
  const truncateDefault = /onDeadline = "truncate",/.test(lexicalSource);
  assert.ok(
    truncateDefault,
    "hybrid's historic truncate behaviour must remain the default",
  );
  assert.equal(
    lexicalSource.split('if (onDeadline === "throw" && isExpired(deadlineAt))')
      .length - 1,
    2,
    "both candidate loops must honour the throw mode",
  );
}

// ============================================================================
// 2. Abandoned queries must not accumulate.
// ============================================================================

{
  const gate = new KeywordSearchGate(2);
  const state = installZotero({ searchMs: 400 });

  // Five back-to-back searches, each giving up after 50ms.
  const attempts = [];
  for (let i = 0; i < 5; i++) {
    attempts.push(
      runLexicalSearch({
        keywords: [keyword(`q${i}`)],
        libraryID: 1,
        deadlineAt: Date.now() + 50,
        onDeadline: "throw",
        gate,
      }).then(
        () => "resolved",
        (error) =>
          isLexicalSearchTimeoutError(error)
            ? "timeout"
            : isKeywordSearchOverloadedError(error)
              ? "overloaded"
              : `other:${error.message}`,
      ),
    );
  }
  const outcomes = await Promise.all(attempts);

  assert.ok(
    outcomes.every(
      (outcome) => outcome === "timeout" || outcome === "overloaded",
    ),
    `every caller must get a clear answer, got ${JSON.stringify(outcomes)}`,
  );
  assert.ok(
    outcomes.includes("overloaded"),
    "past the backlog limit, a request must be refused rather than queued " +
      "behind queries that are already overrunning",
  );
  assert.equal(
    state.peakRunning,
    1,
    "THE PILE-UP: five timed-out searches must never leave five Zotero queries " +
      "running at once — the library is queried one at a time",
  );

  // Let the accepted queries drain, then confirm the gate is clean again.
  await sleep(1500);
  assert.equal(state.running, 0);
  assert.equal(
    gate.pending(1),
    0,
    "an idle library must end with an empty gate, not a growing chain",
  );

  // ...and a later search is served normally.
  installZotero({ searchMs: 10 });
  const recovered = await runLexicalSearch({
    keywords: [keyword("after the storm")],
    libraryID: 1,
    deadlineAt: Date.now() + 3000,
    onDeadline: "throw",
    gate,
  });
  assert.equal(recovered.diagnostics.candidateIDs, 3);
}

// ---- the slot is released by the QUERY settling, not by the caller giving up ----

{
  const gate = new KeywordSearchGate(2);
  let releaseFirst;
  const first = gate.run(1, () => new Promise((r) => (releaseFirst = r)));
  first.catch(() => undefined);

  let secondStarted = false;
  const second = gate.run(1, async () => {
    secondStarted = true;
    return "second";
  });

  await sleep(20);
  assert.equal(
    secondStarted,
    false,
    "the second query must not start while the first is still running, even " +
      "though nobody is waiting on the first any more",
  );

  releaseFirst("first");
  assert.equal(await second, "second");
  assert.equal(gate.pending(1), 0);
}

// ---- different libraries do not block each other ----

{
  const gate = new KeywordSearchGate(2);
  let releaseA;
  const a = gate.run(1, () => new Promise((r) => (releaseA = r)));
  a.catch(() => undefined);
  const b = await gate.run(2, async () => "library-2");
  assert.equal(
    b,
    "library-2",
    "serialisation is per library; an unrelated library must not be held up",
  );
  releaseA("done");
  await a;
}

// ---- a failing query still releases the slot ----

{
  const gate = new KeywordSearchGate(2);
  await assert.rejects(
    () =>
      gate.run(1, async () => {
        throw new Error("query blew up");
      }),
    /query blew up/,
  );
  assert.equal(gate.pending(1), 0);
  assert.equal(await gate.run(1, async () => "next"), "next");
}

// ---- the overload error explains itself ----

{
  const error = new KeywordSearchOverloadedError(1, 3);
  assert.ok(isKeywordSearchOverloadedError(error));
  assert.equal(error.libraryID, 1);
  assert.match(error.message, /cannot be cancelled/i);
  assert.match(error.message, /Retry|raise the keyword search timeout/i);
}

// ============================================================================
// 3. keyword_search is wired to enforce all of it.
// ============================================================================

{
  const start = mcpSource.indexOf("private async runSingleBranchSearch(");
  assert.ok(start > 0);
  const body = mcpSource.slice(start, start + 14000);

  assert.match(
    body,
    /await runWithTimeout\(\s*\n\s*\(\) =>\s*\n\s*runLexicalSearch\(\{/,
    "THE REGRESSION: keyword_search awaited runLexicalSearch directly, with no " +
      "hard timeout of any kind",
  );
  assert.match(
    body,
    /settings\.keywordSearchTimeoutMs,\s*\n\s*'Keyword search',/,
    "the outer bound must be the user's own configured timeout",
  );
  assert.match(
    body,
    /onDeadline: 'throw'/,
    "a single-branch keyword search must report a timeout, not a silent subset",
  );
  assert.ok(
    !/isCancelled: \(\) => false/.test(body),
    "the cancellation hook must actually be wired, not hard-coded to false",
  );
  assert.match(
    body,
    /keywordCancelled = true;/,
    "timing out must also stop the cooperative scan loops",
  );
  assert.match(
    body,
    /isLexicalSearchTimeoutError\(error\)\s*\|\|\s*isKeywordSearchGateError\(error\)/,
    "a timeout must be reported as a timeout, distinctly from an empty library",
  );
  assert.ok(
    body.indexOf("isKeywordSearchUnavailableError(error)") <
      body.indexOf("isLexicalSearchTimeoutError(error)"),
    "a database that stopped answering must be matched BEFORE the general " +
      "timeout branch: retrying a timeout at once is reasonable, retrying " +
      "this is not, so the two must not collapse into one message",
  );
  assert.match(
    body,
    /timedOut,/,
    "the response must carry a machine-readable timeout flag",
  );
}

console.log("keyword hard timeout: all assertions passed");
