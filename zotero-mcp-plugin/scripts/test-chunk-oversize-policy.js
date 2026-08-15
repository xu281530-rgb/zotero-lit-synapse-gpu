/* eslint-env node */

/**
 * Tests for what an index build does about a chunk that is too long to embed.
 *
 * The behaviour under test is a promise made to the user twice over: they are
 * asked exactly once what to do, and whichever answer they give, the plugin
 * afterwards tells the truth about what is in the index. The second half is
 * the one worth being strict about — a rebuild that quietly dropped documents
 * and then recorded "this library matches the current chunk settings" would
 * make every later incremental build skip the very papers that are missing.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const {
  ChunkOversizeDecisionGate,
  applyOversizeSkipToStatus,
  summarizeRun,
} = await import("../src/modules/semantic/chunkOversizePolicy.ts");
const { shouldRecordFullLibraryChunkingSignature } = await import(
  "../src/modules/hybridSearchSettings.ts"
);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");

const request = (itemKey = "AAAA1111") => ({
  itemKey,
  libraryID: 1,
  title: "A very long paper",
  message: "single chunk too large",
});

async function run(name, fn) {
  try {
    await fn();
  } catch (error) {
    console.error(`FAILED: ${name}`);
    throw error;
  }
  console.log(`ok - ${name}`);
}

// ===========================================================================
// 1. The prompt happens once per run
// ===========================================================================

await run("five concurrent workers produce exactly one dialog", async () => {
  // Five items are indexed in parallel, so five of them can hit an oversized
  // chunk before any answer exists. Stacking five modal dialogs on a user
  // midway through a library rebuild is not a recoverable situation.
  let release;
  const shown = new Promise((resolve) => {
    release = resolve;
  });
  let asks = 0;
  const gate = new ChunkOversizeDecisionGate();
  gate.setAsk(async () => {
    asks += 1;
    await shown;
    return "skip";
  });

  const answers = Promise.all(
    ["A", "B", "C", "D", "E"].map((key) => gate.decide(request(key))),
  );
  // Let every worker reach the gate before the dialog resolves.
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();

  assert.deepEqual(await answers, ["skip", "skip", "skip", "skip", "skip"]);
  assert.equal(asks, 1, "the user must be asked once, not five times");
  assert.equal(gate.promptCount(), 1);
});

await run("the answer is reused for the rest of the run", async () => {
  let asks = 0;
  const gate = new ChunkOversizeDecisionGate();
  gate.setAsk(async () => {
    asks += 1;
    return "skip";
  });

  for (let i = 0; i < 50; i++) {
    assert.equal(await gate.decide(request(`K${i}`)), "skip");
  }
  assert.equal(asks, 1, "a library full of oversized chunks must not re-prompt");
});

await run("'stop' is also remembered, so it does not re-prompt either", async () => {
  let asks = 0;
  const gate = new ChunkOversizeDecisionGate();
  gate.setAsk(async () => {
    asks += 1;
    return "stop";
  });

  assert.equal(await gate.decide(request("A")), "stop");
  assert.equal(await gate.decide(request("B")), "stop");
  assert.equal(asks, 1);
  assert.equal(gate.current(), "stop");
});

await run("a new run asks again, a resumed run does not", async () => {
  let asks = 0;
  const gate = new ChunkOversizeDecisionGate();
  gate.setAsk(async () => {
    asks += 1;
    return "skip";
  });

  await gate.decide(request("A"));
  assert.equal(asks, 1);

  // A resume keeps the answer: it is the same run continuing.
  await gate.decide(request("B"));
  assert.equal(asks, 1);
  assert.equal(gate.current(), "skip");

  // A new build resets it: by then the user may have changed the very setting
  // the question was about, so the old answer no longer describes anything.
  gate.reset();
  assert.equal(gate.current(), null);
  assert.equal(gate.promptCount(), 0);
  await gate.decide(request("C"));
  assert.equal(asks, 2);
});

// ---------------------------------------------------------------------------
// Not being able to ask is never consent to drop documents
// ---------------------------------------------------------------------------

await run("no handler registered means stop, not skip", async () => {
  // Background auto-updates and MCP-triggered builds have no window to put a
  // dialog in. Defaulting to 'skip' there would silently thin the index.
  const gate = new ChunkOversizeDecisionGate();
  assert.equal(gate.hasAsk(), false);
  assert.equal(await gate.decide(request()), "stop");
});

await run("a prompt that throws means stop", async () => {
  const seen = [];
  const gate = new ChunkOversizeDecisionGate();
  gate.setAsk(async () => {
    throw new Error("no window available");
  });
  assert.equal(await gate.decide(request(), (e) => seen.push(String(e))), "stop");
  assert.equal(seen.length, 1);
  assert.match(seen[0], /no window available/);
});

await run("an unrecognised answer is treated as stop", async () => {
  const gate = new ChunkOversizeDecisionGate();
  gate.setAsk(async () => "maybe");
  assert.equal(await gate.decide(request()), "stop");
});

await run("the request names the item so the dialog is actionable", async () => {
  let received = null;
  const gate = new ChunkOversizeDecisionGate();
  gate.setAsk(async (req) => {
    received = req;
    return "skip";
  });
  await gate.decide(request("ZZZZ9999"));
  assert.equal(received.itemKey, "ZZZZ9999");
  assert.equal(received.title, "A very long paper");
  assert.match(received.message, /too large/);
});

// ===========================================================================
// 2. A run that skipped documents is marked incomplete
// ===========================================================================

await run("skipping turns a finished run into 'incomplete'", () => {
  assert.equal(applyOversizeSkipToStatus("completed", 3), "incomplete");
  assert.equal(applyOversizeSkipToStatus("failed", 3), "incomplete");

  // No skips: the status is whatever it already was.
  assert.equal(applyOversizeSkipToStatus("completed", 0), "completed");
  assert.equal(applyOversizeSkipToStatus("failed", 0), "failed");

  // A run the user stopped is already the more specific fact; overwriting it
  // would hide why the run ended.
  assert.equal(applyOversizeSkipToStatus("aborted", 3), "aborted");
});

await run("'incomplete' can never record the full-library chunk signature", () => {
  // This is the guarantee that matters most. The signature means "the stored
  // index was built with these chunk settings"; recording it after silently
  // omitting documents would make every later incremental build believe the
  // missing papers are already covered.
  const base = {
    rebuild: true,
    itemKeysProvided: false,
    processed: 100,
    total: 100,
    failedCount: 0,
  };
  assert.equal(
    shouldRecordFullLibraryChunkingSignature({ ...base, status: "completed" }),
    true,
    "a clean full rebuild still records the signature",
  );
  for (const status of ["incomplete", "failed", "aborted", "paused", "indexing"]) {
    assert.equal(
      shouldRecordFullLibraryChunkingSignature({ ...base, status }),
      false,
      `status '${status}' must not record the signature`,
    );
  }

  // And the realistic shape: skipped items are counted as failures too, so
  // even the pre-existing failedCount gate refuses independently.
  assert.equal(
    shouldRecordFullLibraryChunkingSignature({
      ...base,
      status: "completed",
      failedCount: 3,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// The closing summary
// ---------------------------------------------------------------------------

await run("the summary separates skipped from genuinely failed", () => {
  // 100 processed, 5 recorded failures of which 3 are deliberate skips.
  assert.deepEqual(
    summarizeRun({ processed: 100, failedCount: 5, chunkOversizeSkipped: 3 }),
    { indexed: 95, skipped: 3, otherFailures: 2 },
  );

  // The pure case the user asked to see: N indexed, M skipped, nothing broken.
  assert.deepEqual(
    summarizeRun({ processed: 42, failedCount: 3, chunkOversizeSkipped: 3 }),
    { indexed: 39, skipped: 3, otherFailures: 0 },
  );

  // A clean run reports nothing to act on.
  assert.deepEqual(summarizeRun({ processed: 10, failedCount: 0 }), {
    indexed: 10,
    skipped: 0,
    otherFailures: 0,
  });

  // Missing fields and impossible combinations must not produce negatives.
  assert.deepEqual(summarizeRun({}), {
    indexed: 0,
    skipped: 0,
    otherFailures: 0,
  });
  assert.deepEqual(
    summarizeRun({ processed: 1, failedCount: 5, chunkOversizeSkipped: 9 }),
    { indexed: 0, skipped: 9, otherFailures: 0 },
  );
});

// ===========================================================================
// 3. How the build wires it up
// ===========================================================================

const serviceSource = read("src/modules/semantic/semanticSearchService.ts");
const prefsSource = read("src/modules/preferenceScript.ts");
const storeSource = read("src/modules/semantic/vectorStore.ts");

await run("an oversized chunk is asked about, not decided silently", () => {
  assert.match(
    serviceSource,
    /error\.type === 'chunk_too_large'[\s\S]{0,200}resolveChunkTooLarge\(item, error\)/,
    "the build must consult the user's decision",
  );
  // It must no longer be handled by the blanket pause-everything branch.
  const globalBlock = serviceSource.slice(
    serviceSource.indexOf("const isGlobalError ="),
    serviceSource.indexOf("const isGlobalError =") + 400,
  );
  assert.doesNotMatch(
    globalBlock,
    /chunk_too_large/,
    "chunk_too_large must be handled by the prompt, not by isGlobalError",
  );
});

await run("skip records the item so it can be retried later", () => {
  assert.match(
    serviceSource,
    /if \(decision === 'skip'\)[\s\S]{0,600}chunkOversizeSkipped[\s\S]{0,600}recordFailedItem\(item, error, error\.type\)[\s\S]{0,200}return \{ status: 'failed', error \}/,
    "a skipped item must be tallied, persisted as a failure, and end the item",
  );
});

await run("stop ends the run immediately", () => {
  const stopBlock = serviceSource.slice(
    serviceSource.indexOf("if (error.type === 'chunk_too_large')"),
    serviceSource.indexOf("// Errors that describe the run rather than"),
  );
  assert.match(stopBlock, /this\._aborted = true/, "stop must abort the run");
  assert.match(
    stopBlock,
    /updateBuildSessionStatus\(buildID, 'aborted'\)/,
    "the build journal must record that the run ended",
  );
  assert.match(
    stopBlock,
    /_onErrorCallback\?\.\(error\)/,
    "the user must be told why it stopped",
  );
  assert.doesNotMatch(
    stopBlock,
    /this\._paused = true/,
    "stop must not park the build as resumable - the setting has to change first",
  );
});

await run("every signature gate is preceded by the 'incomplete' override", () => {
  // buildIndex can finish down two paths — the ordinary one, and the
  // zero-items early return that a resumed run lands on when nothing is left.
  // BOTH write the chunking signature, so both must first downgrade a run
  // that skipped documents. Checking only one leaves the other as the single
  // place a thinned index can still be declared complete.
  const indicesOf = (needle) => {
    const found = [];
    for (let at = serviceSource.indexOf(needle); at !== -1; ) {
      found.push(at);
      at = serviceSource.indexOf(needle, at + 1);
    }
    return found;
  };

  // The trailing "(" keeps this to call sites; the import names it bare.
  const overrides = indicesOf("applyOversizeSkipToStatus(");
  const gates = indicesOf("shouldRecordFullLibraryChunkingSignature({");

  assert.equal(gates.length, 2, "buildIndex has exactly two signature gates");
  assert.equal(
    overrides.length,
    2,
    `expected one override per gate, found ${overrides.length}`,
  );
  // Interleaved — override, gate, override, gate — which pins each gate to its
  // own override rather than letting a single one at the top of the function
  // appear to cover both.
  assert.ok(
    overrides[0] < gates[0] && gates[0] < overrides[1] && overrides[1] < gates[1],
    `expected override/gate interleaving, got overrides=${overrides} gates=${gates}`,
  );
});

await run("'incomplete' is a real, non-resumable build status", () => {
  assert.match(
    storeSource,
    /\|\s*'incomplete'/,
    "the build session type must know the status",
  );
  const resumable = storeSource.slice(
    storeSource.indexOf("async getResumableBuildSession("),
    storeSource.indexOf("async getResumableBuildSession(") + 600,
  );
  assert.match(resumable, /status IN \('indexing', 'paused', 'failed'\)/);
  assert.doesNotMatch(
    resumable,
    /incomplete/,
    "an incomplete run is finished; it must not be offered for resume",
  );

  // Nor may it be restored as a paused build after a restart.
  const restore = serviceSource.slice(
    serviceSource.indexOf("private loadIndexProgress()"),
    serviceSource.indexOf("private loadIndexProgress()") + 900,
  );
  assert.doesNotMatch(restore, /'incomplete'/);
});

await run("the dialog offers two labelled choices and defaults to stop", () => {
  const dialog = prefsSource.slice(prefsSource.indexOf("function askChunkTooLarge("));
  assert.match(dialog, /confirmEx/, "two custom-labelled buttons");
  assert.match(dialog, /pref-semantic-chunk-oversize-skip/);
  assert.match(dialog, /pref-semantic-chunk-oversize-stop/);
  assert.match(
    dialog,
    /pressed === 0 \? "skip" : "stop"/,
    "the first button is the skip button",
  );
  assert.match(dialog, /win\.confirm\(fallback\)/, "a plain-confirm fallback exists");
  assert.match(
    dialog,
    /return "stop";\s*\n\s*\}/,
    "every path that cannot ask must end in stop",
  );
});

await run("every locale carries the new strings", () => {
  const keys = [
    "pref-semantic-index-error-chunk-too-large",
    "pref-semantic-chunk-oversize-title",
    "pref-semantic-chunk-oversize-skip",
    "pref-semantic-chunk-oversize-stop",
    "pref-semantic-chunk-oversize-item",
    "pref-semantic-chunk-oversize-explain",
    "pref-semantic-index-incomplete",
    "pref-semantic-index-incomplete-hint",
    "pref-semantic-index-indexed-items",
    "pref-semantic-index-skipped-oversize",
    "pref-semantic-stats-status-incomplete",
  ];
  const locales = fs
    .readdirSync(path.join(rootDir, "addon/locale"))
    .filter((entry) =>
      fs.existsSync(path.join(rootDir, "addon/locale", entry, "preferences.ftl")),
    );
  assert.ok(locales.length >= 6, `expected the full locale set, saw ${locales}`);
  for (const locale of locales) {
    const ftl = read(`addon/locale/${locale}/preferences.ftl`);
    for (const key of keys) {
      assert.match(
        ftl,
        new RegExp(`^${key} = \\S`, "m"),
        `${locale} is missing ${key}`,
      );
    }
  }
});

await run("the stop path tells the user how to fix it", () => {
  const zh = read("addon/locale/zh-CN/preferences.ftl");
  assert.match(
    zh,
    /pref-semantic-index-error-chunk-too-large = 单个 Chunk 已超过当前向量模型\/API允许的输入长度，请降低 Chunk 长度或更换支持更长输入的向量模型。/,
  );
  assert.match(zh, /pref-semantic-index-incomplete-hint = .*降低 Chunk 长度.*更换支持更长输入的向量模型/);
});

console.log("\nAll chunk-oversize policy tests passed.");
