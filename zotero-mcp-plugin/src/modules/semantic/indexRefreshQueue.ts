/**
 * Persistent queue of items whose vector index must be refreshed.
 *
 * MinerU 重新解析完成后，正文变了，这一条文献的向量必须重建。但那一刻语义服务
 * 可能还没初始化好，或者正在跑全库构建——以前这两种情况都是「记一条日志然后
 * 直接放弃」，于是新解析出来的正文永远进不了索引，检索还在用旧向量。
 *
 * 现在改成入队：队列写在 preference 里，Zotero 重启也不丢；服务就绪且没有构建
 * 在跑的时候，由这里统一补跑，复用的是同一个增量索引入口
 * (`indexItemWithProcessor(item, null, true)`)，不存在第二套索引逻辑。
 */

declare const Zotero: any;
declare let ztoolkit: ZToolkit;

const QUEUE_PREF =
  "extensions.zotero.zotero-mcp-plugin.semantic.pendingIndexRefresh";
const SEMANTIC_ENABLED_PREF =
  "extensions.zotero.zotero-mcp-plugin.semantic.enabled";

/** Entries beyond this are dropped oldest-first; a runaway queue helps nobody. */
const MAX_QUEUE_ENTRIES = 500;
/** After this many failed drains an entry is abandoned with a log line. */
const MAX_ATTEMPTS = 8;
/** How often the queue looks for a chance to drain. */
const DRAIN_INTERVAL_MS = 60_000;

export interface PendingIndexRefresh {
  libraryID: number;
  itemKey: string;
  queuedAt: number;
  attempts: number;
  reason: string;
  lastError?: string;
}

let drainTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;
let suspended = false;

function readQueue(): PendingIndexRefresh[] {
  try {
    const raw = Zotero.Prefs.get(QUEUE_PREF, true);
    if (!raw || typeof raw !== "string") return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry: any) =>
        entry &&
        typeof entry.itemKey === "string" &&
        typeof entry.libraryID === "number",
    ) as PendingIndexRefresh[];
  } catch (error) {
    ztoolkit.log(`[IndexRefreshQueue] Failed to read queue: ${error}`, "warn");
    return [];
  }
}

function writeQueue(entries: PendingIndexRefresh[]): void {
  try {
    const bounded =
      entries.length > MAX_QUEUE_ENTRIES
        ? entries.slice(entries.length - MAX_QUEUE_ENTRIES)
        : entries;
    Zotero.Prefs.set(QUEUE_PREF, JSON.stringify(bounded), true);
  } catch (error) {
    ztoolkit.log(`[IndexRefreshQueue] Failed to write queue: ${error}`, "warn");
  }
}

function identity(libraryID: number, itemKey: string): string {
  return `${libraryID}:${itemKey}`;
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
  if (!itemKey || suspended) return;
  const entries = readQueue();
  const key = identity(libraryID, itemKey);
  const existingIndex = entries.findIndex(
    (entry) => identity(entry.libraryID, entry.itemKey) === key,
  );
  const entry: PendingIndexRefresh = {
    libraryID,
    itemKey,
    queuedAt: Date.now(),
    attempts: 0,
    reason,
  };
  if (existingIndex >= 0) entries[existingIndex] = entry;
  else entries.push(entry);
  writeQueue(entries);
  ztoolkit.log(
    `[IndexRefreshQueue] Queued ${key} for later index refresh (${reason}); pending=${entries.length}`,
  );
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
}

export type DrainOutcome =
  | "disabled"
  | "empty"
  | "not-ready"
  | "build-active"
  | "busy"
  | "drained";

/**
 * Try to re-index everything waiting in the queue.
 *
 * Every "not now" outcome leaves the queue untouched, which is the whole point:
 * a refresh request is never thrown away, it just waits for a moment when the
 * semantic service can actually take it.
 */
export async function processIndexRefreshQueue(): Promise<{
  outcome: DrainOutcome;
  processed: number;
  failed: number;
  remaining: number;
}> {
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

  if (Zotero.Prefs.get(SEMANTIC_ENABLED_PREF, true) === false) {
    // Keep the queue: the user may switch semantic search back on later, and
    // the pending body text is still the newer one.
    return {
      outcome: "disabled",
      processed: 0,
      failed: 0,
      remaining: entries.length,
    };
  }

  draining = true;
  try {
    const { getSemanticSearchService } = await import("./index");
    const service = getSemanticSearchService();

    if (!(await service.isReady())) {
      return {
        outcome: "not-ready",
        processed: 0,
        failed: 0,
        remaining: entries.length,
      };
    }
    // A full build is walking the same items with the same MinerU cache; let it
    // finish rather than fighting it for the embedding rate limit.
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

    for (const entry of entries) {
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
          attempts,
          lastError: String(error),
        });
        ztoolkit.log(
          `[IndexRefreshQueue] Refresh failed for ${identity(entry.libraryID, entry.itemKey)} (attempt ${attempts}): ${error}`,
          "warn",
        );
      }
    }

    writeQueue(survivors);
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
    `[IndexRefreshQueue] Started; ${getPendingIndexRefreshCount()} refresh(es) pending from earlier sessions`,
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
  suspended = false;
  startIndexRefreshQueue();
}
