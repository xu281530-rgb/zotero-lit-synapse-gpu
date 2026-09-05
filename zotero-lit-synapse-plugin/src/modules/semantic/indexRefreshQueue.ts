/**
 * Persistent queue of index refreshes and deleted-item cleanup.
 *
 * MinerU 重新解析完成后，正文变了，这一条文献的向量必须重建。但那一刻语义服务
 * 可能还没初始化好，或者正在跑全库构建——以前这两种情况都是「记一条日志然后
 * 直接放弃」，于是新解析出来的正文永远进不了索引，检索还在用旧向量。
 *
 * 队列写在 preference 里，Zotero 重启也不丢。刷新任务复用同一个增量索引入口；
 * 永久删除任务复用原子的双索引删除入口，不会把已经不存在的条目送回构建流程。
 */

import { generateSecureIdentifier } from "../../utils/security";

declare const Zotero: any;
declare let ztoolkit: ZToolkit;

const QUEUE_PREF =
  "extensions.zotero.zotero-lit-synapse.semantic.pendingIndexRefresh";
const RESET_PREF =
  "extensions.zotero.zotero-lit-synapse.semantic.pendingIndexReset";
const LEGACY_QUEUE_INVALIDATED_PREF =
  "extensions.zotero.zotero-lit-synapse.semantic.pendingIndexRefreshInvalidated";

/** Refresh entries beyond this are dropped oldest-first; deletions are retained. */
const MAX_QUEUE_ENTRIES = 500;
/** After this many failed drains an entry is abandoned with a log line. */
const MAX_ATTEMPTS = 8;
/** How often the queue looks for a chance to drain. */
const DRAIN_INTERVAL_MS = 60_000;
/** Failed deletion cleanup backs off, but is never discarded. */
const DELETE_RETRY_MAX_MS = 10 * 60_000;

export type PendingIndexOperation = "refresh" | "delete";

export interface PendingIndexRefresh {
  libraryID: number;
  itemKey: string;
  /** Missing on legacy entries, which are refresh tasks. */
  operation?: PendingIndexOperation;
  queuedAt: number;
  attempts: number;
  reason: string;
  lastError?: string;
  nextAttemptAt?: number;
}

export type PendingIndexResetPhase = "preparing" | "database-cleared";

export interface PendingIndexResetState {
  phase: PendingIndexResetPhase;
  generation: string;
  /** An old boolean fence whose original commit phase cannot be recovered. */
  legacyAmbiguous?: boolean;
}

let drainTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;
let suspended = false;
const enqueuedDuringDrain = new Map<string, PendingIndexRefresh>();

function readQueue(): PendingIndexRefresh[] {
  try {
    const raw = Zotero.Prefs.get(QUEUE_PREF, true);
    if (!raw || typeof raw !== "string") return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry: any) =>
          entry &&
          typeof entry.itemKey === "string" &&
          typeof entry.libraryID === "number",
      )
      .map((entry: any) => ({
        ...entry,
        operation: entry.operation === "delete" ? "delete" : "refresh",
        queuedAt: Number(entry.queuedAt) || Date.now(),
        attempts: Number(entry.attempts) || 0,
      })) as PendingIndexRefresh[];
  } catch (error) {
    ztoolkit.log(`[IndexRefreshQueue] Failed to read queue: ${error}`, "warn");
    return [];
  }
}

function writeQueue(entries: PendingIndexRefresh[]): boolean {
  try {
    const deletions = entries.filter((entry) => entry.operation === "delete");
    const refreshes = entries.filter((entry) => entry.operation !== "delete");
    const refreshCapacity = Math.max(0, MAX_QUEUE_ENTRIES - deletions.length);
    const bounded = [
      ...deletions,
      ...refreshes.slice(Math.max(0, refreshes.length - refreshCapacity)),
    ];
    Zotero.Prefs.set(QUEUE_PREF, JSON.stringify(bounded), true);
    return true;
  } catch (error) {
    ztoolkit.log(`[IndexRefreshQueue] Failed to write queue: ${error}`, "warn");
    return false;
  }
}

function readIndexResetState(): PendingIndexResetState | null {
  const raw = Zotero.Prefs.get(RESET_PREF, true);
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (
        (parsed?.phase === "preparing" ||
          parsed?.phase === "database-cleared") &&
        typeof parsed.generation === "string" &&
        parsed.generation
      ) {
        return {
          phase: parsed.phase,
          generation: parsed.generation,
          legacyAmbiguous: parsed.legacyAmbiguous === true || undefined,
        };
      }
    } catch (error) {
      ztoolkit.log(
        `[IndexRefreshQueue] Failed to read persisted reset state: ${error}`,
        "error",
      );
    }
  }
  if (Zotero.Prefs.get(LEGACY_QUEUE_INVALIDATED_PREF, true) === true) {
    // The old boolean cannot prove that COMMIT happened. Treat it as preparing
    // so startup preserves the queue unless a matching SQLite marker exists.
    return {
      phase: "preparing",
      generation: "legacy-uncoordinated",
      legacyAmbiguous: true,
    };
  }
  return null;
}

function writeIndexResetState(state: PendingIndexResetState): void {
  Zotero.Prefs.set(RESET_PREF, JSON.stringify(state), true);
  const stored = readIndexResetState();
  if (
    stored?.phase !== state.phase ||
    stored.generation !== state.generation ||
    stored.legacyAmbiguous !== state.legacyAmbiguous
  ) {
    throw new Error("Index reset phase could not be persisted");
  }
  Zotero.Prefs.clear(LEGACY_QUEUE_INVALIDATED_PREF, true);
}

function clearIndexResetState(): void {
  Zotero.Prefs.clear(RESET_PREF, true);
  Zotero.Prefs.clear(LEGACY_QUEUE_INVALIDATED_PREF, true);
  if (readIndexResetState() !== null) {
    throw new Error("Index reset phase could not be cleared");
  }
}

function createResetGeneration(): string {
  return generateSecureIdentifier("reset-");
}

export function getIndexRefreshQueueResetState(): PendingIndexResetState | null {
  return readIndexResetState();
}

export function isIndexResetPending(): boolean {
  return readIndexResetState() !== null;
}

export function prepareIndexRefreshQueueReset(
  generation: string = createResetGeneration(),
): string {
  if (!generation) throw new Error("Index reset generation is required");
  const existing = readIndexResetState();
  if (existing && !existing.legacyAmbiguous) {
    throw new Error(
      `Index reset ${existing.generation} is still ${existing.phase}`,
    );
  }
  writeIndexResetState({
    phase: "preparing",
    generation,
    legacyAmbiguous: existing?.legacyAmbiguous || undefined,
  });
  suspended = true;
  stopIndexRefreshQueue();
  return generation;
}

export function markIndexRefreshQueueDatabaseCleared(
  generation: string,
): void {
  const existing = readIndexResetState();
  if (
    !existing ||
    existing.generation !== generation ||
    (existing.phase !== "preparing" &&
      existing.phase !== "database-cleared")
  ) {
    throw new Error(`Cannot commit unknown index reset generation ${generation}`);
  }
  writeIndexResetState({ phase: "database-cleared", generation });
}

export function cancelIndexRefreshQueueReset(generation: string): void {
  const existing = readIndexResetState();
  if (!existing) return;
  if (existing.generation !== generation || existing.phase !== "preparing") {
    throw new Error(
      `Cannot cancel index reset ${generation} after database commit`,
    );
  }
  const restoreLegacyFence = existing.legacyAmbiguous === true;
  if (restoreLegacyFence) {
    // Persist the old fence before removing the generation state so a crash
    // between preference writes never leaves the ambiguous queue executable.
    Zotero.Prefs.set(LEGACY_QUEUE_INVALIDATED_PREF, true, true);
    if (Zotero.Prefs.get(LEGACY_QUEUE_INVALIDATED_PREF, true) !== true) {
      throw new Error("Legacy reset safety fence could not be restored");
    }
    Zotero.Prefs.clear(RESET_PREF, true);
    if (typeof Zotero.Prefs.get(RESET_PREF, true) === "string") {
      throw new Error("Rolled-back reset generation could not be cleared");
    }
    return;
  }
  clearIndexResetState();
}

function identity(libraryID: number, itemKey: string): string {
  return `${libraryID}:${itemKey}`;
}

function rememberEnqueueDuringDrain(entry: PendingIndexRefresh): void {
  if (!draining) return;
  const key = identity(entry.libraryID, entry.itemKey);
  const existing = enqueuedDuringDrain.get(key);
  if (existing?.operation === "delete" && entry.operation !== "delete") {
    return;
  }
  enqueuedDuringDrain.set(key, entry);
}

function writeDrainResult(entries: PendingIndexRefresh[]): boolean {
  const merged = [...entries];
  for (const entry of enqueuedDuringDrain.values()) {
    const key = identity(entry.libraryID, entry.itemKey);
    const existingIndex = merged.findIndex(
      (candidate) =>
        identity(candidate.libraryID, candidate.itemKey) === key,
    );
    if (existingIndex < 0) {
      merged.push(entry);
    } else if (
      entry.operation === "delete" ||
      merged[existingIndex].operation !== "delete"
    ) {
      merged[existingIndex] = entry;
    }
  }
  const written = writeQueue(merged);
  if (written) enqueuedDuringDrain.clear();
  return written;
}

/**
 * Remember that this item needs re-indexing.
 *
 * Idempotent: queueing the same item twice keeps one entry and resets its
 * attempt counter, because the second call means the content changed again.
 */
export function enqueueIndexRefresh(
  libraryID: number,
  itemKey: string,
  reason: string,
): void {
  if (!itemKey || suspended || isIndexResetPending()) return;
  const entries = readQueue();
  const key = identity(libraryID, itemKey);
  const existingIndex = entries.findIndex(
    (entry) => identity(entry.libraryID, entry.itemKey) === key,
  );
  if (existingIndex >= 0 && entries[existingIndex].operation === "delete") {
    ztoolkit.log(
      `[IndexRefreshQueue] Ignoring refresh for ${key}: deletion cleanup is pending`,
    );
    return;
  }
  const entry: PendingIndexRefresh = {
    libraryID,
    itemKey,
    operation: "refresh",
    queuedAt: Date.now(),
    attempts: 0,
    reason,
  };
  if (existingIndex >= 0) entries[existingIndex] = entry;
  else entries.push(entry);
  if (writeQueue(entries)) rememberEnqueueDuringDrain(entry);
  ztoolkit.log(
    `[IndexRefreshQueue] Queued ${key} for later index refresh (${reason}); pending=${entries.length}`,
  );
}

/** Persist cleanup for an item Zotero has already permanently removed. */
export function enqueueIndexDeletion(
  libraryID: number,
  itemKey: string,
  reason: string,
): void {
  if (!itemKey) return;
  if (isIndexResetPending()) {
    ztoolkit.log(
      `[IndexRefreshQueue] Ignoring deletion enqueue for ${identity(libraryID, itemKey)} while a database reset is pending`,
      "warn",
    );
    return;
  }
  const entries = readQueue();
  const key = identity(libraryID, itemKey);
  const existingIndex = entries.findIndex(
    (entry) => identity(entry.libraryID, entry.itemKey) === key,
  );
  const entry: PendingIndexRefresh = {
    libraryID,
    itemKey,
    operation: "delete",
    queuedAt: Date.now(),
    attempts: 0,
    reason,
  };
  if (existingIndex >= 0) entries[existingIndex] = entry;
  else entries.push(entry);
  if (!writeQueue(entries)) {
    throw new Error(`Could not persist index deletion cleanup for ${key}`);
  }
  rememberEnqueueDuringDrain(entry);
  ztoolkit.log(
    `[IndexRefreshQueue] Persisted deletion cleanup for ${key} (${reason}); pending=${entries.length}`,
    "error",
  );
}

/**
 * Run one notifier cleanup, persisting the exact deletion task on failure.
 */
export async function deleteItemIndexWithRecovery(
  target: {
    deleteItemIndex?(itemKey: string, libraryID?: number): Promise<void>;
    deleteItemVectors?(itemKey: string, libraryID?: number): Promise<void>;
  },
  libraryID: number,
  itemKey: string,
  reason: string,
  options: { buildActive?: boolean } = {},
): Promise<boolean> {
  const requiresPostBuildCleanup = options.buildActive === true;
  if (requiresPostBuildCleanup) {
    // The build may already hold the deleted Zotero item in its work queue.
    // Persist first, then make a best-effort immediate deletion. Even when that
    // deletion commits, the durable task remains to remove a later write-back.
    enqueueIndexDeletion(libraryID, itemKey, reason);
    ztoolkit.log(
      `[IndexRefreshQueue] Persisted post-build deletion for ${identity(libraryID, itemKey)} while a build is active`,
    );
  }
  try {
    if (target.deleteItemIndex) {
      await target.deleteItemIndex(itemKey, libraryID);
    } else if (target.deleteItemVectors) {
      await target.deleteItemVectors(itemKey, libraryID);
    } else {
      throw new Error("Index deletion target has no delete operation");
    }
    return !requiresPostBuildCleanup;
  } catch (error) {
    if (!requiresPostBuildCleanup) {
      enqueueIndexDeletion(libraryID, itemKey, reason);
    }
    ztoolkit.log(
      `[IndexRefreshQueue] Index deletion failed for ${identity(libraryID, itemKey)}; cleanup persisted: ${error}`,
      "error",
    );
    return false;
  }
}

export function getPendingIndexRefreshCount(): number {
  return readQueue().length;
}

export function clearIndexRefreshQueue(): void {
  Zotero.Prefs.clear(QUEUE_PREF, true);
  const remaining = Zotero.Prefs.get(QUEUE_PREF, true);
  if (typeof remaining === "string" && remaining.trim()) {
    throw new Error("Persisted semantic refresh queue could not be cleared");
  }
  enqueuedDuringDrain.clear();
  clearIndexResetState();
}

function recoverDatabaseClearedQueue(): boolean {
  const state = readIndexResetState();
  if (!state) return true;
  if (state.phase !== "database-cleared") return false;
  suspended = true;
  stopIndexRefreshQueue();
  try {
    clearIndexRefreshQueue();
    ztoolkit.log(
      "[IndexRefreshQueue] Cleared the pre-reset queue after database reset finalization",
    );
    return true;
  } catch (error) {
    ztoolkit.log(
      `[IndexRefreshQueue] Database reset committed, but pre-reset queue cleanup is still pending: ${error}`,
      "error",
    );
    return false;
  }
}

async function readCommittedResetGeneration(
  resolver?: () => Promise<string | null>,
): Promise<string | null> {
  if (resolver) return resolver();
  const { getVectorStore } = await import("./vectorStore");
  return getVectorStore().getCommittedResetGeneration();
}

async function finalizeCommittedReset(
  finalizer?: () => Promise<unknown>,
): Promise<void> {
  if (finalizer) {
    await finalizer();
    return;
  }
  const { getVectorStore } = await import("./vectorStore");
  await getVectorStore().finalizeCommittedReset();
}

async function recoverIndexReset(
  resolver?: () => Promise<string | null>,
  finalizer?: () => Promise<unknown>,
): Promise<"none" | "recovered" | "pending"> {
  let state = readIndexResetState();
  if (!state) return "none";
  suspended = true;
  stopIndexRefreshQueue();

  if (state.phase === "preparing") {
    if (
      state.legacyAmbiguous &&
      state.generation === "legacy-uncoordinated"
    ) {
      ztoolkit.log(
        "[IndexRefreshQueue] Legacy reset fence is ambiguous; queue remains blocked until an explicit database reset completes",
        "error",
      );
      return "pending";
    }
    try {
      const committedGeneration = await readCommittedResetGeneration(resolver);
      if (committedGeneration === state.generation) {
        markIndexRefreshQueueDatabaseCleared(state.generation);
        state = { ...state, phase: "database-cleared" };
      } else {
        const preserveLegacyFence = state.legacyAmbiguous === true;
        cancelIndexRefreshQueueReset(state.generation);
        if (preserveLegacyFence) {
          ztoolkit.log(
            `[IndexRefreshQueue] Reset ${state.generation} did not commit; restored the legacy ambiguous fence and preserved the queue`,
            "error",
          );
          return "pending";
        }
        suspended = false;
        startIndexRefreshQueue();
        ztoolkit.log(
          `[IndexRefreshQueue] Reset ${state.generation} did not commit; preserved ${getPendingIndexRefreshCount()} queued task(s)`,
        );
        return "recovered";
      }
    } catch (error) {
      ztoolkit.log(
        `[IndexRefreshQueue] Could not resolve preparing reset ${state.generation}: ${error}`,
        "error",
      );
      return "pending";
    }
  }

  try {
    await finalizeCommittedReset(finalizer);
  } catch (error) {
    ztoolkit.log(
      `[IndexRefreshQueue] Post-commit reset finalization is still pending for ${state.generation}: ${error}`,
      "error",
    );
    return "pending";
  }
  return recoverDatabaseClearedQueue() ? "recovered" : "pending";
}

export type DrainOutcome =
  | "reset-pending"
  | "reset-recovered"
  | "disabled"
  | "empty"
  | "not-ready"
  | "build-active"
  | "busy"
  | "drained";

interface IndexQueueService {
  isBuildActive?(): boolean;
  isReady(): Promise<boolean>;
  deleteItemIndex(itemKey: string, libraryID?: number): Promise<void>;
  indexItemWithProcessor(
    item: any,
    onProgress: null,
    force: boolean,
  ): Promise<unknown>;
}

/**
 * Try to re-index everything waiting in the queue.
 *
 * Every "not now" outcome leaves the queue untouched, which is the whole point:
 * a refresh request is never thrown away, it just waits for a moment when the
 * semantic service can actually take it.
 */
export async function processIndexRefreshQueue(
  options: {
    service?: IndexQueueService;
    now?: number;
    getCommittedResetGeneration?: () => Promise<string | null>;
    finalizeCommittedReset?: () => Promise<unknown>;
  } = {},
): Promise<{
  outcome: DrainOutcome;
  processed: number;
  failed: number;
  remaining: number;
}> {
  const resetRecovery = await recoverIndexReset(
    options.getCommittedResetGeneration,
    options.finalizeCommittedReset,
  );
  if (resetRecovery !== "none") {
    if (resetRecovery === "recovered") {
      suspended = false;
      startIndexRefreshQueue();
    }
    return {
      outcome:
        resetRecovery === "recovered" ? "reset-recovered" : "reset-pending",
      processed: 0,
      failed: 0,
      remaining: readQueue().length,
    };
  }
  const entries = readQueue();
  if (entries.length === 0) {
    return { outcome: "empty", processed: 0, failed: 0, remaining: 0 };
  }
  if (draining) {
    return {
      outcome: "busy",
      processed: 0,
      failed: 0,
      remaining: entries.length,
    };
  }
  if (suspended) {
    return {
      outcome: "busy",
      processed: 0,
      failed: 0,
      remaining: entries.length,
    };
  }

  draining = true;
  try {
    const service = options.service ??
      (await import("./index")).getSemanticSearchService();
    // Cleanup and indexing must not race. A deleted item may already be held by
    // the active build, which could otherwise write it back after cleanup.
    if (service.isBuildActive?.()) {
      return {
        outcome: "build-active",
        processed: 0,
        failed: 0,
        remaining: entries.length,
      };
    }

    let processed = 0;
    let failed = 0;
    const survivors: PendingIndexRefresh[] = [];
    const now = options.now ?? Date.now();
    const refreshEntries: PendingIndexRefresh[] = [];

    // Deletions run first and do not require Zotero.Items or an Embedding API.
    for (const entry of entries) {
      if (entry.operation !== "delete") {
        refreshEntries.push(entry);
        continue;
      }
      if ((entry.nextAttemptAt ?? 0) > now) {
        survivors.push(entry);
        continue;
      }
      try {
        await service.deleteItemIndex(entry.itemKey, entry.libraryID);
        processed += 1;
        ztoolkit.log(
          `[IndexRefreshQueue] Deleted stale index for ${identity(entry.libraryID, entry.itemKey)}`,
        );
      } catch (error) {
        failed += 1;
        const attempts = (entry.attempts || 0) + 1;
        const retryDelay = Math.min(
          DRAIN_INTERVAL_MS * Math.pow(2, Math.min(attempts - 1, 20)),
          DELETE_RETRY_MAX_MS,
        );
        survivors.push({
          ...entry,
          operation: "delete",
          attempts,
          lastError: String(error),
          nextAttemptAt: now + retryDelay,
        });
        ztoolkit.log(
          `[IndexRefreshQueue] Deletion cleanup failed for ${identity(entry.libraryID, entry.itemKey)} (attempt ${attempts}); retry in ${Math.round(retryDelay / 1000)}s: ${error}`,
          "error",
        );
      }
    }

    if (refreshEntries.length === 0) {
      writeDrainResult(survivors);
      return {
        outcome: "drained",
        processed,
        failed,
        remaining: survivors.length,
      };
    }

    if (!(await service.isReady())) {
      writeDrainResult([...survivors, ...refreshEntries]);
      return {
        outcome: "not-ready",
        processed,
        failed,
        remaining: survivors.length + refreshEntries.length,
      };
    }

    for (const entry of refreshEntries) {
      try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          entry.libraryID,
          entry.itemKey,
        );
        if (!item || !item.isRegularItem?.()) {
          // Deleted or turned into something unindexable: drop it.
          ztoolkit.log(
            `[IndexRefreshQueue] Dropping ${identity(entry.libraryID, entry.itemKey)}: item no longer indexable`,
          );
          continue;
        }
        // force=true, exactly as the inline refresh did: without it the
        // timestamp fast path would decide nothing changed and keep the stale
        // PDF-worker vectors.
        await service.indexItemWithProcessor(item, null, true);
        processed += 1;
        ztoolkit.log(
          `[IndexRefreshQueue] Refreshed index for ${identity(entry.libraryID, entry.itemKey)} (queued ${new Date(entry.queuedAt).toISOString()})`,
        );
      } catch (error) {
        failed += 1;
        const attempts = (entry.attempts || 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          ztoolkit.log(
            `[IndexRefreshQueue] Giving up on ${identity(entry.libraryID, entry.itemKey)} after ${attempts} attempts: ${error}`,
            "warn",
          );
          continue;
        }
        survivors.push({
          ...entry,
          operation: "refresh",
          attempts,
          lastError: String(error),
        });
        ztoolkit.log(
          `[IndexRefreshQueue] Refresh failed for ${identity(entry.libraryID, entry.itemKey)} (attempt ${attempts}): ${error}`,
          "warn",
        );
      }
    }

    writeDrainResult(survivors);
    return {
      outcome: "drained",
      processed,
      failed,
      remaining: survivors.length,
    };
  } catch (error) {
    ztoolkit.log(`[IndexRefreshQueue] Drain aborted: ${error}`, "warn");
    return {
      outcome: "not-ready",
      processed: 0,
      failed: 0,
      remaining: readQueue().length,
    };
  } finally {
    draining = false;
  }
}

/**
 * Start the periodic drain. Safe to call twice; the timer is a singleton.
 * Called at plugin startup so anything queued before a restart is picked up.
 */
export function startIndexRefreshQueue(): void {
  if (drainTimer !== null) return;
  const resetState = readIndexResetState();
  if (resetState) {
    suspended = true;
    return;
  }
  suspended = false;
  drainTimer = setInterval(() => {
    void processIndexRefreshQueue().then((result) => {
      if (result.processed > 0 || result.failed > 0) {
        ztoolkit.log(
          `[IndexRefreshQueue] Drain: processed=${result.processed} failed=${result.failed} remaining=${result.remaining}`,
        );
      }
    });
  }, DRAIN_INTERVAL_MS);
  ztoolkit.log(
    `[IndexRefreshQueue] Started; ${getPendingIndexRefreshCount()} task(s) pending from earlier sessions`,
  );
}

export function stopIndexRefreshQueue(): void {
  if (drainTimer === null) return;
  clearInterval(drainTimer);
  drainTimer = null;
}

export async function suspendIndexRefreshQueue(): Promise<void> {
  suspended = true;
  stopIndexRefreshQueue();
  while (draining) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function resumeIndexRefreshQueue(): void {
  const resetState = readIndexResetState();
  if (resetState) return;
  suspended = false;
  startIndexRefreshQueue();
}
