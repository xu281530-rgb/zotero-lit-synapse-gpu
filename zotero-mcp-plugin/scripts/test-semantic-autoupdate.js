/**
 * Regression tests for the semantic auto-update pipeline.
 *
 * These are source-level and behavioural checks that run outside Zotero:
 * hooks.ts cannot be imported here (it pulls in the whole plugin runtime), so
 * the queue semantics are re-implemented from the same source text and the
 * structural guarantees are asserted against the file itself.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");

const hooksSource = read("src/hooks.ts");
const serviceSource = read("src/modules/semantic/semanticSearchService.ts");
const barrelSource = read("src/modules/semantic/index.ts");

// ---------------------------------------------------------------------------
// 1. An already-indexed item can be re-indexed after a modify
// ---------------------------------------------------------------------------

// The notifier must not drop modify events any more.
assert.doesNotMatch(
  hooksSource,
  /if \(event !== 'add' && event !== 'delete'\) return;/,
  "modify events must no longer be filtered out of the notifier",
);
assert.match(
  hooksSource,
  /event !== 'add' && event !== 'modify' && event !== 'delete'/,
  "the notifier must accept add, modify and delete",
);
assert.match(hooksSource, /queueModifiedItems\(numericIds\)/);
// modify is queued non-forced so an unchanged item costs only a timestamp check.
assert.match(
  hooksSource,
  /scheduleAutoUpdate\(item\.key, item\.libraryID, false\)/,
  "modified regular items must be queued non-forced",
);
// adds keep forcing: a freshly attached PDF must be re-read from disk.
assert.match(
  hooksSource,
  /scheduleAutoUpdate\(item\.key, item\.libraryID, true\)/,
  "added items must keep the forced path",
);

// buildIndex must let explicitly requested keys past the already-indexed filter,
// otherwise needsReindexByTimestamp is dead code for every indexed item.
const filterStart = serviceSource.indexOf("// Filter already indexed items");
const filterEnd = serviceSource.indexOf(
  "} else if (force && !fullLibraryRebuild) {",
  filterStart,
);
assert.ok(filterStart !== -1 && filterEnd > filterStart, "buildIndex filter block not found");
const filterBlock = serviceSource.slice(filterStart, filterEnd);
assert.match(
  filterBlock,
  /if \(itemKeysProvided\)/,
  "targeted itemKeys must bypass the getItemsToSkip filter",
);
const skipCallIndex = filterBlock.indexOf("getItemsToSkip");
const targetedIndex = filterBlock.indexOf("if (itemKeysProvided)");
assert.ok(
  targetedIndex !== -1 && targetedIndex < skipCallIndex,
  "the targeted branch must be checked before getItemsToSkip runs",
);
// The per-item timestamp gate must still exist and still be reachable.
assert.match(serviceSource, /needsReindexByTimestamp\(/);

// ---------------------------------------------------------------------------
// 2. A busy / not-ready / failing batch is not lost
// ---------------------------------------------------------------------------

// Model of the queue, mirroring hooks.ts.
function makeQueue() {
  const pending = new Map();
  let retries = 0;
  const MAX = 8;
  const add = (key, force) =>
    pending.set(key, (pending.get(key) ?? false) || force);
  const requeue = (batch) => {
    for (const [k, f] of batch) add(k, f);
    if (retries >= MAX) return "exhausted";
    retries += 1;
    return "retry-armed";
  };
  return { pending, add, requeue, reset: () => (retries = 0), get retries() { return retries; } };
}

// busy: the batch goes back untouched
{
  const q = makeQueue();
  q.add("1:AAA", false);
  q.add("1:BBB", true);
  const batch = new Map(q.pending);
  q.pending.clear();
  assert.equal(q.pending.size, 0, "batch is taken out while it is processed");
  assert.equal(q.requeue(batch), "retry-armed");
  assert.equal(q.pending.size, 2, "a busy build must put every key back");
  assert.equal(q.pending.get("1:BBB"), true, "the force flag must survive a requeue");
}

// force flags OR together and are never downgraded
{
  const q = makeQueue();
  q.add("1:AAA", false);
  const batch = new Map(q.pending);
  q.pending.clear();
  q.add("1:AAA", true); // a newer add arrives while the batch is in flight
  q.requeue(batch);
  assert.equal(q.pending.get("1:AAA"), true, "a queued force must not be downgraded by a requeue");
}

// retries are bounded, and exhausting them still keeps the keys
{
  const q = makeQueue();
  q.add("1:AAA", false);
  let outcome = "";
  for (let i = 0; i < 20; i++) {
    const batch = new Map(q.pending);
    q.pending.clear();
    outcome = q.requeue(batch);
  }
  assert.equal(outcome, "exhausted", "retries must be bounded, not infinite");
  assert.equal(q.pending.size, 1, "exhausted retries must still keep the work queued");
  q.reset();
  assert.equal(q.retries, 0, "new activity resets the backoff");
}

// Structural: the queue must not be cleared before the work succeeds.
assert.doesNotMatch(
  hooksSource,
  /const identitiesToUpdate = Array\.from\(pendingAutoUpdateKeys\);\s*\n\s*pendingAutoUpdateKeys\.clear\(\);/,
  "the old clear-up-front pattern must be gone",
);
assert.match(hooksSource, /function requeueAutoUpdates\(/);
for (const reason of [
  /requeueAutoUpdates\(batch, 'semantic service not ready'\)/,
  /requeueAutoUpdates\(batch, 'buildIndex reported busy'\)/,
  /requeueAutoUpdates\(batch, `buildIndex error/,
  /requeueAutoUpdates\(batch, `exception/,
  /requeueAutoUpdates\(deferred, 'another index build is in progress'\)/,
]) {
  assert.match(hooksSource, reason, `missing requeue path: ${reason}`);
}
// A non-retryable error must drop the batch instead of spinning forever.
assert.match(hooksSource, /result\.errorRetryable !== false/);
assert.match(hooksSource, /AUTO_UPDATE_MAX_RETRIES/);
// The periodic check drains leftovers so nothing is orphaned.
assert.match(hooksSource, /Draining \$\{pendingAutoUpdateKeys\.size\} queued auto-update keys/);

// ---------------------------------------------------------------------------
// 3. Shutdown no longer calls a missing export
// ---------------------------------------------------------------------------

assert.match(
  serviceSource,
  /export function resetSemanticSearchService\(\): void/,
  "the implementation must exist",
);
assert.match(
  barrelSource,
  /^\s*resetSemanticSearchService,$/m,
  "the barrel that onShutdown requires must re-export it",
);
// The shutdown path requires it from the barrel, so the two must agree.
assert.match(
  hooksSource,
  /const \{ resetSemanticSearchService \} = require\("\.\/modules\/semantic"\)/,
);
assert.match(hooksSource, /resetSemanticSearchService\(\);/);

// Simulate the destructure the way onShutdown does it, against the real
// export list, to prove it resolves to a function rather than undefined.
const exportedNames = barrelSource
  .slice(barrelSource.indexOf("export {"), barrelSource.indexOf("} from './semanticSearchService'"))
  .split(/[\n,]/)
  .map((line) => line.replace(/\/\/.*/, "").trim())
  .filter(Boolean);
assert.ok(
  exportedNames.includes("resetSemanticSearchService"),
  "resetSemanticSearchService must be in the semantic barrel export list",
);
// It must actually release the singleton, not just log.
const resetBody = serviceSource.slice(
  serviceSource.indexOf("export function resetSemanticSearchService"),
);
assert.match(resetBody, /abortIndex\(\)/);
assert.match(resetBody, /destroy\(\)/);
assert.match(resetBody, /semanticSearchInstance = null/);

console.log("Semantic auto-update regression tests passed");
