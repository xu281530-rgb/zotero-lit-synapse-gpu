import { BasicExampleFactory } from "./modules/examples";
import { httpServer } from "./modules/httpServer"; // 使用单例导出
import { serverPreferences, SERVER_LISTENER_PREFS } from "./modules/serverPreferences";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { clearDeprecatedContentSettings } from "./modules/deprecatedContentSettings";
import { migrateFusedScoreThreshold } from "./modules/hybridSearchSettings";
import { registerSemanticIndexColumn, unregisterSemanticIndexColumn, refreshSemanticColumn } from "./modules/semanticIndexColumn";
import { getMinerUService } from "./modules/mineru";
import {
  groupItemKeysByLibrary,
  groupQueueKeysByLibrary,
  toLibraryQueueKey,
} from "./modules/libraryScope";
import { deleteItemIndexWithRecovery } from "./modules/semantic/indexRefreshQueue";
import {
  registerWikiPanel,
  unregisterWikiPanel,
} from "./modules/wiki/wikiPanel";
import { getWikiService } from "./modules/wiki/wikiService";

const PREF_SEMANTIC_AUTO_UPDATE = 'extensions.zotero.zotero-lit-synapse.semantic.autoUpdate';
const GENERATED_MINERU_MARKDOWN_TITLE =
  /^MinerU Markdown \(([A-Z0-9]+)\)\.md$/i;

function generatedMinerUSourceKey(value: any): string | null {
  const title =
    typeof value === "string" ? value : value?.getField?.("title") || "";
  return String(title).match(GENERATED_MINERU_MARKDOWN_TITLE)?.[1] || null;
}

// Store notifier ID for cleanup
let itemNotifierID: string | null = null;

// Debounce timer for auto-update
let autoUpdateDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_UPDATE_DEBOUNCE_MS = 5000; // Wait 5 seconds after last change before updating

// Queue of items to update, keyed by `<libraryID>:<itemKey>` so group-library
// items are never re-indexed against My Library's ID.
//
// The value records whether that key needs a *forced* re-extraction:
//   true  - an add / attachment landing: re-read the item from disk even if the
//           timestamps look unchanged (a freshly attached PDF is the point).
//   false - a plain `modify`: let needsReindexByTimestamp decide. Forcing here
//           would re-extract PDF text on every tag edit or sync-driven
//           dateModified bump, which is exactly the pointless churn we want to
//           avoid.
// Merging is OR-ed: once a key needs forcing in a batch, it keeps forcing.
const pendingAutoUpdateKeys = new Map<string, boolean>();

// Retry bookkeeping for auto-update batches that could not be processed yet
// (service not ready, another build in flight, transient failure).
let autoUpdateRetryTimer: ReturnType<typeof setTimeout> | null = null;
let autoUpdateRetryCount = 0;
const AUTO_UPDATE_RETRY_BASE_MS = 30 * 1000;
const AUTO_UPDATE_RETRY_MAX_MS = 10 * 60 * 1000;
/**
 * Cap on consecutive retry rounds. Hitting it stops the timer but deliberately
 * KEEPS the queued keys, so the next item event (or the periodic auto-index
 * check) picks them up instead of losing them. This is what bounds the retry
 * loop without ever discarding work.
 */
const AUTO_UPDATE_MAX_RETRIES = 8;

// Flag to prevent recursive auto-update during indexing
let isAutoIndexing = false;
let semanticAutoUpdatesSuspended = false;

// Auto index check interval (10 minutes)
const AUTO_INDEX_CHECK_INTERVAL_MS = 10 * 60 * 1000;
let autoIndexCheckTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Drains the Wiki claim-embedding queue.
 *
 * wiki_commit answers the caller as soon as its transaction is durable and
 * leaves the vectors to this. The queue is a table, so anything left behind by
 * a crash, a restart or an embedding outage is still there to be picked up -
 * which is the point: an empty queue is the same statement as "every Wiki
 * claim has a current vector".
 */
let wikiEmbeddingQueueTimer: ReturnType<typeof setInterval> | null = null;
const WIKI_EMBEDDING_QUEUE_INTERVAL_MS = 60_000;
let autoIndexInitialTimer: ReturnType<typeof setTimeout> | null = null;

// Track all setTimeout calls for cleanup on shutdown
const pendingTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();

// Global flag to prevent new async operations during shutdown
let isShuttingDown = false;

/**
 * Create a tracked setTimeout that will be cleaned up on shutdown
 */
export function trackedSetTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    pendingTimeouts.delete(timer);
    if (!isShuttingDown) {
      callback();
    }
  }, delay);
  pendingTimeouts.add(timer);
  return timer;
}

/**
 * Clear all pending tracked timeouts
 */
function clearAllPendingTimeouts(): void {
  for (const timer of pendingTimeouts) {
    clearTimeout(timer);
  }
  pendingTimeouts.clear();
  ztoolkit.log(`[MCP Plugin] All pending timeouts cleared`);
}

/**
 * Requeue a batch that could not be processed, and arrange another attempt.
 *
 * Keys are put back (OR-ing the force flag with anything queued meanwhile, so a
 * newer forced request is never downgraded) and a backoff timer is armed. The
 * batch is only ever dropped from the queue after it has actually been indexed.
 */
function requeueAutoUpdates(batch: Map<string, boolean>, reason: string): void {
  if (isShuttingDown || semanticAutoUpdatesSuspended) return;

  for (const [key, force] of batch) {
    pendingAutoUpdateKeys.set(key, (pendingAutoUpdateKeys.get(key) ?? false) || force);
  }

  if (autoUpdateRetryCount >= AUTO_UPDATE_MAX_RETRIES) {
    ztoolkit.log(
      `[MCP Plugin] Auto-update still blocked after ${autoUpdateRetryCount} retries (${reason}); ${pendingAutoUpdateKeys.size} keys stay queued for the next item event or periodic check`,
      'warn',
    );
    return;
  }

  autoUpdateRetryCount += 1;
  const delay = Math.min(
    AUTO_UPDATE_RETRY_BASE_MS * Math.pow(2, autoUpdateRetryCount - 1),
    AUTO_UPDATE_RETRY_MAX_MS,
  );

  // A single timer for the whole queue: re-arming replaces it, so repeated
  // failures cannot pile up overlapping retries.
  if (autoUpdateRetryTimer) clearTimeout(autoUpdateRetryTimer);
  autoUpdateRetryTimer = trackedSetTimeout(() => {
    autoUpdateRetryTimer = null;
    processPendingAutoUpdates();
  }, delay);

  ztoolkit.log(
    `[MCP Plugin] Auto-update deferred (${reason}); retry ${autoUpdateRetryCount}/${AUTO_UPDATE_MAX_RETRIES} in ${Math.round(delay / 1000)}s, ${pendingAutoUpdateKeys.size} keys still queued`,
  );
}

/**
 * Process pending auto-update items
 *
 * Keys are removed from the queue only after the corresponding build actually
 * ran. Previously the whole queue was cleared up front, so a service that was
 * not ready yet, a concurrent build ('busy'), or any thrown error silently
 * discarded every queued item and nothing ever re-indexed them.
 */
async function processPendingAutoUpdates() {
  if (isShuttingDown || semanticAutoUpdatesSuspended) return;
  if (pendingAutoUpdateKeys.size === 0) return;

  // Another build (periodic auto-index, or a user-triggered one) holds the
  // service. Keep the queue and come back rather than racing it into 'busy'.
  if (isAutoIndexing) {
    const deferred = new Map(pendingAutoUpdateKeys);
    pendingAutoUpdateKeys.clear();
    requeueAutoUpdates(deferred, 'another index build is in progress');
    return;
  }

  // Take the batch, but hold on to it: it goes back into the queue unless the
  // build for every library actually completes.
  const batch = new Map(pendingAutoUpdateKeys);
  pendingAutoUpdateKeys.clear();

  const forcedKeys: string[] = [];
  const incrementalKeys: string[] = [];
  for (const [key, force] of batch) {
    (force ? forcedKeys : incrementalKeys).push(key);
  }

  ztoolkit.log(`[MCP Plugin] Auto-updating search index for ${batch.size} items (forced=${forcedKeys.length}, incremental=${incrementalKeys.length})`);

  // Set flag to prevent recursive calls during indexing
  isAutoIndexing = true;

  try {
    const { getSemanticSearchService } = await import("./modules/semantic");
    const semanticService = getSemanticSearchService();

    // Check if service is ready
    const isReady = await semanticService.isReady();
    if (!isReady) {
      ztoolkit.log("[MCP Plugin] Semantic service not ready, deferring auto-update");
      requeueAutoUpdates(batch, 'semantic service not ready');
      return;
    }

    // One build per library and per force mode: buildIndex resolves keys with
    // getByLibraryAndKeyAsync, so a group item indexed under the user library
    // ID would simply not be found.
    //
    // forced=true keys were explicitly touched (added, or had an attachment
    // land on them), so they must bypass the extraction cache. forced=false
    // keys come from `modify`; buildIndex no longer drops targeted keys at the
    // index_status filter, so needsReindexByTimestamp decides whether anything
    // is actually re-embedded.
    const groups: Array<{ keys: string[]; force: boolean }> = [
      { keys: forcedKeys, force: true },
      { keys: incrementalKeys, force: false },
    ];

    for (const group of groups) {
      if (group.keys.length === 0) continue;
      const byLibrary = groupQueueKeysByLibrary(
        group.keys,
        Zotero.Libraries.userLibraryID,
      );
      for (const [libraryID, keysToUpdate] of byLibrary) {
        const result = await semanticService.buildIndex({
          itemKeys: keysToUpdate,
          libraryID,
          rebuild: false,  // Only add new indexes, don't clear existing data
          force: group.force,
          onProgress: (progress) => {
            ztoolkit.log(`[MCP Plugin] Auto-update progress (libraryID=${libraryID}, force=${group.force}): ${progress.processed}/${progress.total}`);
          }
        });

        if (result.status === 'busy') {
          // Someone else grabbed the service between our check and this call.
          requeueAutoUpdates(batch, 'buildIndex reported busy');
          return;
        }
        if (result.status === 'error' && result.errorRetryable !== false) {
          requeueAutoUpdates(batch, `buildIndex error: ${result.error || 'unknown'}`);
          return;
        }
        if (result.status === 'error') {
          // Non-retryable (e.g. embedding dimension mismatch): retrying cannot
          // help, so drop the batch instead of spinning on it forever.
          ztoolkit.log(`[MCP Plugin] Auto-update aborted, non-retryable error: ${result.error}`, 'error');
          autoUpdateRetryCount = 0;
          return;
        }
      }
    }

    // Everything ran: the batch is done and the backoff resets.
    autoUpdateRetryCount = 0;

    // Refresh semantic column to show updated status
    refreshSemanticColumn();
    ztoolkit.log(`[MCP Plugin] Auto-update completed for ${batch.size} items`);
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Auto-update failed: ${error}`, 'error');
    requeueAutoUpdates(batch, `exception: ${error}`);
  } finally {
    // Always reset the flag
    isAutoIndexing = false;
  }
}

/**
 * Schedule auto-update with debouncing
 *
 * @param force Re-extract even when timestamps look unchanged. True for adds
 *   and for attachments landing on an already-indexed parent; false for plain
 *   modifications, which must stay cheap.
 */
function scheduleAutoUpdate(itemKey: string, libraryID: number, force: boolean) {
  if (semanticAutoUpdatesSuspended) return;
  const queueKey = toLibraryQueueKey(itemKey, libraryID);
  pendingAutoUpdateKeys.set(
    queueKey,
    (pendingAutoUpdateKeys.get(queueKey) ?? false) || force,
  );

  // New activity: give the queue a fresh set of retries.
  autoUpdateRetryCount = 0;

  // Clear existing timer
  if (autoUpdateDebounceTimer) {
    clearTimeout(autoUpdateDebounceTimer);
  }

  // Set new timer
  autoUpdateDebounceTimer = setTimeout(() => {
    autoUpdateDebounceTimer = null;
    processPendingAutoUpdates();
  }, AUTO_UPDATE_DEBOUNCE_MS);
}

export function clearPendingSemanticAutoUpdates(): void {
  if (autoUpdateDebounceTimer) {
    clearTimeout(autoUpdateDebounceTimer);
    autoUpdateDebounceTimer = null;
  }
  if (autoUpdateRetryTimer) {
    clearTimeout(autoUpdateRetryTimer);
    pendingTimeouts.delete(autoUpdateRetryTimer);
    autoUpdateRetryTimer = null;
  }
  autoUpdateRetryCount = 0;
  pendingAutoUpdateKeys.clear();
}

export function suspendSemanticAutoUpdates(): void {
  semanticAutoUpdatesSuspended = true;
  clearPendingSemanticAutoUpdates();
}

export function resumeSemanticAutoUpdates(): void {
  clearPendingSemanticAutoUpdates();
  semanticAutoUpdatesSuspended = false;
}

/**
 * The parent of every child item this session has seen.
 *
 * A `delete` event arrives after the row is already gone, so the deleted PDF
 * can no longer be asked which paper it belonged to — and without that answer
 * the old code just removed vectors under the ATTACHMENT's key, which never
 * matched anything, leaving the deleted PDF's body text in the parent's index
 * forever. Zotero usually puts the parent key in the event's extraData, but
 * that is not guaranteed across versions, so every child item we observe is
 * remembered here as a second source for the same answer.
 */
const childParentMemory = new Map<
  number,
  {
    parentKey: string;
    libraryID: number;
    isAnnotation: boolean;
    isPDFAttachment: boolean;
    title: string;
    itemKey: string;
  }
>();
const CHILD_PARENT_MEMORY_LIMIT = 5000;

/** Attachments/notes seen in the trash, so restoring one forces a re-extract. */
const trashedChildren = new Set<number>();

function resolveParentKeyOf(item: any): string | null {
  return (
    item?.parentItem?.key ||
    (item?.parentItemKey as string | undefined) ||
    null
  );
}

function rememberChildParent(item: any): void {
  try {
    if (!item?.id || item.isRegularItem?.()) return;
    const parentKey = resolveParentKeyOf(item);
    if (!parentKey) return;
    if (
      !childParentMemory.has(item.id) &&
      childParentMemory.size >= CHILD_PARENT_MEMORY_LIMIT
    ) {
      const oldest = childParentMemory.keys().next();
      if (!oldest.done) childParentMemory.delete(oldest.value);
    }
    childParentMemory.set(item.id, {
      parentKey,
      libraryID: item.libraryID,
      isAnnotation: item.isAnnotation?.() === true,
      isPDFAttachment: item.isPDFAttachment?.() === true,
      title: item.getField?.("title") || "",
      itemKey: item.key || "",
    });
  } catch {
    // Remembering is best effort; extraData is the primary source.
  }
}

export function clearChildParentMemory(): void {
  childParentMemory.clear();
  trashedChildren.clear();
}

/**
 * Queue items touched by a `modify` or `trash` event.
 *
 * Resolves whatever Zotero reports (regular item, attachment, note) back to
 * the regular item that owns the index entry, then queues it. Nothing is
 * re-embedded unless needsReindexByTimestamp sees a changed item_modified /
 * attachment_modified stamp, so a tag edit or a sync touch that changes
 * nothing indexable costs a single timestamp comparison.
 *
 * Two things are deliberately different from before:
 *
 *  - Annotations are ignored outright. Highlights and comments no longer feed
 *    the body index, so adding, editing or deleting one must not schedule an
 *    index refresh. Zotero's own annotation features and the annotation MCP
 *    tools are untouched.
 *  - A child that has just been trashed is NOT skipped. Trashing a PDF removes
 *    it from getAttachments(), so the parent's body text really did change;
 *    it is queued forced, because the parent's own timestamps may not have
 *    moved at all and the timestamp fast path would otherwise skip it.
 */
async function queueModifiedItems(
  numericIds: number[],
  options: { trashed?: boolean } = {},
): Promise<void> {
  let items: any[] = [];
  try {
    items = Zotero.Items.get(numericIds) as any[];
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Could not resolve modified items: ${error}`, 'warn');
    return;
  }

  for (const item of items) {
    try {
      if (!item) continue;
      rememberChildParent(item);

      // Annotations never reach the body index any more.
      if (item.isAnnotation?.()) continue;

      if (item.isRegularItem?.()) {
        if (item.deleted || options.trashed) {
          if (options.trashed) {
            try {
              const { getWikiStore } = await import(
                "./modules/wiki/wikiStore"
              );
              await getWikiStore().markSourceDeleted(
                item.libraryID,
                item.key,
              );
            } catch (wikiError) {
              ztoolkit.log(
                `[MCP Plugin] Could not mark trashed Wiki Evidence source_deleted for ${item.key}: ${wikiError}`,
                "warn",
              );
            }
          }
          continue;
        }
        scheduleAutoUpdate(item.key, item.libraryID, false);
        continue;
      }

      const removedFromLibrary = options.trashed === true || item.deleted === true;
      const generatedSourceKey = generatedMinerUSourceKey(item);
      if (generatedSourceKey && removedFromLibrary) {
        if (!getMinerUService().consumeOwnReplacementDeletion(item.key)) {
          await getMinerUService().suppressAutomaticMarkdown(
            item.libraryID,
            generatedSourceKey,
          );
        }
      }
      // The Markdown attachments the indexer writes itself must never re-queue
      // their own parent — but a Markdown attachment leaving or returning to
      // the library genuinely changes the parent's body text.
      if (item.attachmentContentType === "text/markdown" && !removedFromLibrary) {
        if (item.id !== undefined && trashedChildren.delete(item.id)) {
          if (generatedSourceKey) {
            await getMinerUService().allowAutomaticMarkdown(
              item.libraryID,
              generatedSourceKey,
            );
          }
          const restoredParent = resolveParentKeyOf(item);
          if (restoredParent) {
            scheduleAutoUpdate(restoredParent, item.libraryID, true);
          }
        }
        continue;
      }

      // Attachments and notes contribute to the parent's indexed content, so
      // a change to them is a change to the parent.
      const parentKey = resolveParentKeyOf(item);
      if (!parentKey) continue;

      // A restore out of the trash brings its text back; force so the
      // timestamp fast path cannot decide "nothing changed".
      const restored =
        !removedFromLibrary &&
        item.id !== undefined &&
        trashedChildren.delete(item.id);
      if (removedFromLibrary && item.id !== undefined) {
        trashedChildren.add(item.id);
      }

      if (removedFromLibrary) {
        ztoolkit.log(
          `[MCP Plugin] Child ${item.key} trashed; rebuilding parent index ${parentKey}`,
        );
      }
      scheduleAutoUpdate(
        parentKey,
        item.libraryID,
        removedFromLibrary || restored,
      );
    } catch (error) {
      ztoolkit.log(`[MCP Plugin] Skipped modified item: ${error}`, 'warn');
    }
  }
}

/**
 * Persist generated-MinerU attachment deletion/restoration intent when index
 * scheduling is disabled or temporarily suspended.
 */
async function trackMinerUMarkdownLifecycle(
  numericIds: number[],
  event: string,
): Promise<void> {
  let items: any[] = [];
  try {
    items = Zotero.Items.get(numericIds) as any[];
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Could not resolve MinerU attachment lifecycle: ${error}`, "warn");
    return;
  }
  for (const item of items) {
    if (!item) continue;
    const sourceKey = generatedMinerUSourceKey(item);
    if (!sourceKey) continue;
    const removed = event === "trash" || item.deleted === true;
    if (removed) {
      if (!getMinerUService().consumeOwnReplacementDeletion(item.key)) {
        await getMinerUService().suppressAutomaticMarkdown(
          item.libraryID,
          sourceKey,
        );
      }
      if (item.id !== undefined) trashedChildren.add(item.id);
      continue;
    }
    const restored =
      event === "add" ||
      (item.id !== undefined && trashedChildren.delete(item.id));
    if (restored) {
      await getMinerUService().allowAutomaticMarkdown(
        item.libraryID,
        sourceKey,
      );
    }
  }
}

/**
 * Handle permanently erased items.
 *
 * A deleted PDF is not a deleted paper. Removing vectors under the deleted
 * item's own key is right for a top-level item and useless for an attachment:
 * the body text extracted from that PDF lives in the PARENT's index, under the
 * parent's key. So each erased item is first resolved to its owner:
 *
 *  - erased top-level item  -> delete its index
 *  - erased attachment/note -> rebuild the parent from whatever body sources
 *    are left. If a MinerU Markdown attachment survives the PDF, the parent
 *    keeps a real full-text index; if nothing is left, the rebuild replaces
 *    the old body vectors with a metadata-only index that is recorded as
 *    having no full text.
 *  - erased annotation      -> nothing, annotations no longer feed the index
 *  - erased item whose parent is gone too -> delete the parent's index
 */
async function handleItemsDeleted(itemIds: number[], extraData: any) {
  try {
    const { getSemanticSearchService } = await import("./modules/semantic");
    const semanticService = getSemanticSearchService();

    interface DeletedIdentity {
      itemKey?: string;
      libraryID?: number;
      parentKey: string | null;
      knownAnnotation: boolean;
      knownPDFAttachment: boolean;
      title: string;
    }

    const itemIdentities: DeletedIdentity[] = [];
    for (const id of itemIds) {
      const oldData = extraData?.[id];
      const remembered = childParentMemory.get(id);
      childParentMemory.delete(id);
      trashedChildren.delete(id);
      // Zotero has spelled the parent key differently across versions, and it
      // is absent entirely in some paths; the remembered map covers those.
      const parentKey =
        oldData?.parentItem ||
        oldData?.parentKey ||
        oldData?.parentItemKey ||
        remembered?.parentKey ||
        null;
      const itemKey = oldData?.key || undefined;
      if (!itemKey && !parentKey) continue;
      itemIdentities.push({
        itemKey,
        libraryID: oldData?.libraryID ?? remembered?.libraryID,
        parentKey,
        knownAnnotation: remembered?.isAnnotation === true,
        knownPDFAttachment:
          remembered?.isPDFAttachment === true ||
          oldData?.contentType === "application/pdf",
        title: oldData?.title || remembered?.title || "",
      });
    }

    if (itemIdentities.length === 0) {
      ztoolkit.log(`[MCP Plugin] No item keys found for deleted items, skipping index cleanup`);
      return;
    }

    ztoolkit.log(`[MCP Plugin] Cleaning up indexes for ${itemIdentities.length} deleted items`);

    for (const identity of itemIdentities) {
      const {
        itemKey,
        libraryID,
        parentKey,
        knownAnnotation,
        knownPDFAttachment,
        title,
      } = identity;
      try {
        if (!parentKey) {
          // Top-level item: its own index is the one that has to go.
          if (!itemKey) continue;
          const effectiveLibraryID =
            libraryID ?? Zotero.Libraries.userLibraryID;
          await getMinerUService().forgetAutomaticMarkdownStateForParent(
            effectiveLibraryID,
            itemKey,
          );
          try {
            const { getWikiStore } = await import("./modules/wiki/wikiStore");
            await getWikiStore().markSourceDeleted(effectiveLibraryID, itemKey);
          } catch (wikiError) {
            ztoolkit.log(
              `[MCP Plugin] Could not mark Wiki Evidence source_deleted for ${itemKey}: ${wikiError}`,
              "warn",
            );
          }
          const removed = await deleteItemIndexWithRecovery(
            semanticService,
            effectiveLibraryID,
            itemKey,
            "permanent-delete-notifier",
            {
              buildActive:
                isAutoIndexing || semanticService.isBuildActive(),
            },
          );
          if (removed) {
            ztoolkit.log(`[MCP Plugin] Deleted index for item: ${itemKey}`);
          }
          continue;
        }
        if (knownAnnotation) continue;

        const effectiveLibraryID =
          libraryID ?? Zotero.Libraries.userLibraryID;
        if (knownPDFAttachment && itemKey) {
          await getMinerUService().forgetAutomaticMarkdownState(
            effectiveLibraryID,
            itemKey,
          );
        }
        const generatedSourceKey = generatedMinerUSourceKey(title);
        if (
          generatedSourceKey &&
          !getMinerUService().consumeOwnReplacementDeletion(itemKey || "")
        ) {
          await getMinerUService().suppressAutomaticMarkdown(
            effectiveLibraryID,
            generatedSourceKey,
          );
        }
        const owner = await Zotero.Items.getByLibraryAndKeyAsync(
          effectiveLibraryID,
          parentKey,
        );
        if (!owner) {
          // The parent went with it: nothing to rebuild, only to remove.
          const removed = await deleteItemIndexWithRecovery(
            semanticService,
            effectiveLibraryID,
            parentKey,
            "deleted-child-parent-missing",
            {
              buildActive:
                isAutoIndexing || semanticService.isBuildActive(),
            },
          );
          if (removed) {
            ztoolkit.log(
              `[MCP Plugin] Parent ${parentKey} of deleted child is gone too; removed its index`,
            );
          }
          continue;
        }
        if (!owner.isRegularItem?.()) {
          // Only annotations hang off an attachment, and those no longer
          // affect the index.
          continue;
        }
        ztoolkit.log(
          `[MCP Plugin] Child ${itemKey ?? '(unknown)'} erased; rebuilding parent index ${owner.key}`,
        );
        // Forced: the parent's own timestamps may not have moved, and its body
        // text certainly has.
        scheduleAutoUpdate(owner.key, owner.libraryID, true);
      } catch (e) {
        ztoolkit.log(
          `[MCP Plugin] Could not clean up index for deleted item ${itemKey ?? parentKey}: ${e}`,
          'warn',
        );
      }
    }
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error handling deleted items: ${error}`, 'warn');
  }
}

/**
 * Register Zotero notifier to watch for item changes
 */
function registerItemNotifier() {
  // Check if auto-update is enabled
  const autoUpdateEnabled = Zotero.Prefs.get(PREF_SEMANTIC_AUTO_UPDATE, true);
  if (autoUpdateEnabled === undefined) {
    // Set default value if not set
    Zotero.Prefs.set(PREF_SEMANTIC_AUTO_UPDATE, false, true);
  }

  itemNotifierID = Zotero.Notifier.registerObserver({
    notify: async (event: string, type: string, ids: (string | number)[], extraData: any) => {
      // Don't process during shutdown
      if (isShuttingDown) return;

      // Only process item events
      if (type !== 'item') return;

      const numericIds = ids.map(id => typeof id === 'string' ? parseInt(id, 10) : id);

      // Permanent deletion is cleanup, not automatic refresh. It must survive
      // disabled refresh preferences and active builds; the recovery helper
      // persists it when immediate deletion would race the build.
      if (event === 'delete') {
        ztoolkit.log(`[MCP Plugin] Item notifier: event=${event}, type=${type}, ids=${ids.length}`);
        await handleItemsDeleted(numericIds, extraData);
        return;
      }

      // Automatic refresh remains optional; the search infrastructure itself
      // is always available.
      const enabled = Zotero.Prefs.get(PREF_SEMANTIC_AUTO_UPDATE, true);
      if (isAutoIndexing || !enabled) {
        if (event === 'add' || event === 'modify' || event === 'trash') {
          await trackMinerUMarkdownLifecycle(numericIds, event);
        }
        return;
      }

      // add / modify / trash / delete. `modify` used to be dropped outright,
      // which is why editing a title or abstract never reached the index, and
      // `trash` was never handled at all — which is why moving a PDF to the
      // trash (the normal way a PDF is removed) left its body text in the
      // parent's index. All four are safe: the queue is debounced, the
      // isAutoIndexing guard above still blocks events raised by our own
      // indexing, and modify-driven work is queued non-forced so an unchanged
      // item costs one timestamp comparison and nothing else.
      if (
        event !== 'add' &&
        event !== 'modify' &&
        event !== 'trash'
      ) {
        return;
      }

      ztoolkit.log(`[MCP Plugin] Item notifier: event=${event}, type=${type}, ids=${ids.length}`);

      if (event === 'add') {
        // For add events, schedule indexing for new items
        const items = Zotero.Items.get(numericIds);
        for (const item of items) {
          // Record the ownership now, while the row still exists: a later
          // delete event may not carry it.
          rememberChildParent(item);
          if (item.isRegularItem?.()) {
            scheduleAutoUpdate(item.key, item.libraryID, true);
            continue;
          }
          // A new highlight or comment does not change the body text.
          if (item.isAnnotation?.()) continue;
          // The Markdown attachments the indexer itself writes must not
          // re-queue their own parent. This guard is the only thing stopping
          // that loop: the import deliberately does NOT suppress the notifier,
          // because suppressing it is what keeps the new attachment invisible
          // in the items tree until a restart.
          if (item.attachmentContentType === "text/markdown") {
            const generatedSourceKey = generatedMinerUSourceKey(item);
            if (generatedSourceKey) {
              await getMinerUService().allowAutomaticMarkdown(
                item.libraryID,
                generatedSourceKey,
              );
            }
            continue;
          }
          // A PDF normally lands a few seconds after its parent, long after the
          // parent was indexed from metadata alone. Re-queue the parent so the
          // full text actually makes it into the index.
          const parentKey = resolveParentKeyOf(item);
          if (parentKey) {
            ztoolkit.log(`[MCP Plugin] Attachment added, re-queueing parent item: ${parentKey} (libraryID=${item.libraryID})`);
            // The attachment always lives in the same library as its parent.
            scheduleAutoUpdate(parentKey, item.libraryID, true);
          }
        }
      } else if (event === 'modify') {
        await queueModifiedItems(numericIds);
      } else if (event === 'trash') {
        // Zotero does not always pair a trash with a modify, so this branch
        // cannot rely on one arriving. It also cannot rely on item.deleted
        // being committed yet, hence the explicit flag.
        await queueModifiedItems(numericIds, { trashed: true });
      }
    }
  }, ['item'], 'zotero-lit-synapse-auto-update');

  ztoolkit.log(`[MCP Plugin] Item notifier registered: ${itemNotifierID}`);

  // Start periodic auto-index check (every 10 minutes)
  startAutoIndexCheck();
  startWikiEmbeddingQueueDrain();
}

/**
 * Start periodic auto-index check timer
 */
function startAutoIndexCheck() {
  // Clear existing timers if any
  if (autoIndexCheckTimer) {
    clearInterval(autoIndexCheckTimer);
    autoIndexCheckTimer = null;
  }
  if (autoIndexInitialTimer) {
    clearTimeout(autoIndexInitialTimer);
    autoIndexInitialTimer = null;
  }

  // Run first check after 30 seconds (let Zotero fully initialize)
  autoIndexInitialTimer = setTimeout(() => {
    autoIndexInitialTimer = null;
    triggerAutoIndexBuild();
  }, 30000);

  // Then run every 10 minutes
  autoIndexCheckTimer = setInterval(() => {
    triggerAutoIndexBuild();
  }, AUTO_INDEX_CHECK_INTERVAL_MS);

  ztoolkit.log(`[MCP Plugin] Auto-index check timer started (interval: ${AUTO_INDEX_CHECK_INTERVAL_MS / 1000}s)`);
}

function startWikiEmbeddingQueueDrain() {
  if (wikiEmbeddingQueueTimer) {
    clearInterval(wikiEmbeddingQueueTimer);
    wikiEmbeddingQueueTimer = null;
  }
  const pump = () => {
    void getWikiService()
      .pumpEmbeddingQueue()
      .catch((error: unknown) => {
        ztoolkit.log("[MCP Plugin] Wiki embedding queue drain failed", error);
      });
  };
  // One pass shortly after startup clears whatever the last session left.
  setTimeout(pump, 20000);
  wikiEmbeddingQueueTimer = setInterval(pump, WIKI_EMBEDDING_QUEUE_INTERVAL_MS);
  ztoolkit.log("[MCP Plugin] Wiki embedding queue drain started");
}

function stopWikiEmbeddingQueueDrain() {
  if (wikiEmbeddingQueueTimer) {
    clearInterval(wikiEmbeddingQueueTimer);
    wikiEmbeddingQueueTimer = null;
  }
}

/**
 * Stop periodic auto-index check timer
 */
function stopAutoIndexCheck() {
  if (autoIndexInitialTimer) {
    clearTimeout(autoIndexInitialTimer);
    autoIndexInitialTimer = null;
  }
  if (autoIndexCheckTimer) {
    clearInterval(autoIndexCheckTimer);
    autoIndexCheckTimer = null;
  }
  stopWikiEmbeddingQueueDrain();
  ztoolkit.log("[MCP Plugin] Auto-index check timers stopped");
}

/**
 * Trigger automatic index build for unindexed items (when auto-update is enabled)
 */
async function triggerAutoIndexBuild() {
  // Don't start new operations during shutdown
  if (isShuttingDown || semanticAutoUpdatesSuspended) return;

  // Don't start if already indexing
  if (isAutoIndexing) {
    ztoolkit.log("[MCP Plugin] Auto-indexing already in progress, skipping");
    return;
  }

  try {
    const enabled = Zotero.Prefs.get(PREF_SEMANTIC_AUTO_UPDATE, true);
    if (!enabled) {
      ztoolkit.log("[MCP Plugin] Auto-update disabled, skipping auto index check");
      return;
    }

    ztoolkit.log("[MCP Plugin] Periodic auto-index check...");

    // Drain anything the debounced path could not finish (service was not
    // ready, another build held the lock, retries were exhausted). Without
    // this those keys would sit in the queue until the next item event.
    if (pendingAutoUpdateKeys.size > 0 && !isAutoIndexing) {
      ztoolkit.log(`[MCP Plugin] Draining ${pendingAutoUpdateKeys.size} queued auto-update keys before the periodic check`);
      autoUpdateRetryCount = 0;
      await processPendingAutoUpdates();
      if (isShuttingDown) return;
    }

    const { getSemanticSearchService } = await import("./modules/semantic");
    const semanticService = getSemanticSearchService();

    // Check if service is ready (API configured)
    const isReady = await semanticService.isReady();
    if (!isReady) {
      ztoolkit.log("[MCP Plugin] Semantic service not ready (API not configured), skipping");
      return;
    }

    // Skip only when a build is actually in flight (running or parked in a
    // user-visible pause). A stale 'paused' status restored after a crash
    // must NOT block auto-indexing for the rest of the session.
    if (semanticService.isBuildActive()) {
      ztoolkit.log("[MCP Plugin] An index build is already in flight, skipping");
      return;
    }
    const stats = await semanticService.getStats();
    if (stats.indexProgress.status === 'indexing') {
      ztoolkit.log("[MCP Plugin] Indexing already in progress, skipping");
      return;
    }

    // Set flag to prevent recursive calls during indexing
    isAutoIndexing = true;

    // Start building index for unindexed items (rebuild=false means only index
    // new items). Scoped to My Library on purpose: group libraries are indexed
    // when the user touches them (notifier / menu commands), so a background
    // timer never silently spends embedding quota on someone else's library.
    ztoolkit.log("[MCP Plugin] Starting auto index build for unindexed items in My Library...");
    semanticService.buildIndex({
      libraryID: Zotero.Libraries.userLibraryID,
      rebuild: false,  // Only index items that haven't been indexed
      onProgress: (progress) => {
        if (progress.processed % 10 === 0) {
          ztoolkit.log(`[MCP Plugin] Auto index progress: ${progress.processed}/${progress.total}`);
        }
      }
    }).then((result) => {
      if (result.processed > 0) {
        ztoolkit.log(`[MCP Plugin] Auto index completed: ${result.processed}/${result.total} items`);
        refreshSemanticColumn();
      } else {
        ztoolkit.log("[MCP Plugin] Auto index check: no new items to index");
      }
    }).catch((error) => {
      ztoolkit.log(`[MCP Plugin] Auto index failed: ${error}`, 'error');
    }).finally(() => {
      // Always reset the flag
      isAutoIndexing = false;
    });

  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error in triggerAutoIndexBuild: ${error}`, 'error');
    isAutoIndexing = false;
  }
}

/**
 * Unregister item notifier
 */
function unregisterItemNotifier() {
  if (itemNotifierID) {
    Zotero.Notifier.unregisterObserver(itemNotifierID);
    ztoolkit.log(`[MCP Plugin] Item notifier unregistered: ${itemNotifierID}`);
    itemNotifierID = null;
  }

  // Nothing observes items any more, so the remembered child→parent mapping
  // can only go stale.
  clearChildParentMemory();

  // Stop auto-index check timer
  stopAutoIndexCheck();

  clearPendingSemanticAutoUpdates();
}

/** 触发服务器重新对齐的偏好全名集合。 */
const WATCHED_SERVER_PREFS = new Set<string>(
  Object.values(SERVER_LISTENER_PREFS),
);

/** 去抖句柄：连续修改端口/开关时只做一次重启。 */
let serverStateSyncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 把 HTTP 服务器的实际监听状态对齐到偏好设置。
 *
 * 幂等：已经按目标端口和目标绑定范围在跑就什么都不做，所以设置页里
 * 直接控制服务器的处理器与偏好 observer 同时触发也不会互相踩。
 */
function applyServerState(reason: string): void {
  if (isShuttingDown) return;

  try {
    const enabled = serverPreferences.isServerEnabled();

    if (!enabled) {
      if (httpServer.isServerRunning()) {
        httpServer.stop();
        ztoolkit.log(`[MCP Plugin] HTTP server stopped (${reason})`);
      }
      return;
    }

    const port = serverPreferences.getPort();
    if (!port || isNaN(port)) {
      ztoolkit.log(`[MCP Plugin] Skipping server sync, invalid port: ${port}`, "warn");
      return;
    }

    // allowRemote 决定 nsIServerSocket.init 的 loopbackOnly 参数，
    // 只有重新 init 才能换绑定地址，所以它和端口一样属于需要重启的变更。
    const loopbackOnly = !serverPreferences.isRemoteAccessAllowed();

    if (
      httpServer.isServerRunning() &&
      httpServer.getBoundPort() === port &&
      httpServer.isBoundLoopbackOnly() === loopbackOnly
    ) {
      ztoolkit.log(`[MCP Plugin] HTTP server already matches preferences (${reason})`);
      return;
    }

    if (httpServer.isServerRunning()) {
      httpServer.stop();
      ztoolkit.log(`[MCP Plugin] HTTP server stopped for rebind (${reason})`);
    }

    httpServer.start(port);
    ztoolkit.log(
      `[MCP Plugin] HTTP server listening on ${loopbackOnly ? "127.0.0.1" : "0.0.0.0"}:${port} (${reason})`,
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(`[MCP Plugin] Error applying server state (${reason}): ${err.message}`, "error");
  }
}

/**
 * 去抖调度状态对齐。设置页改端口时每敲一个字符都会写偏好，
 * 立即重启会反复占用/释放端口。
 */
function scheduleServerStateSync(reason: string): void {
  if (isShuttingDown) return;
  if (serverStateSyncTimer) clearTimeout(serverStateSyncTimer);
  serverStateSyncTimer = trackedSetTimeout(() => {
    serverStateSyncTimer = null;
    applyServerState(reason);
  }, 300);
}

async function onStartup() {
  // 进程诊断 - 检测当前运行在哪个进程中
  try {
    const runtime = (Cc as any)["@mozilla.org/xre/app-info;1"]?.getService((Ci as any).nsIXULRuntime);
    const processType = runtime?.processType;
    const processID = runtime?.processID;
    const processTypeNames: Record<number, string> = { 0: 'PARENT', 2: 'CONTENT', 4: 'GPU', 9: 'UTILITY' };
    ztoolkit.log(`[MCP Plugin] ======== STARTUP BEGIN ======== PID=${processID}, processType=${processType} (${processTypeNames[processType] || 'UNKNOWN'})`);
  } catch (e) {
    ztoolkit.log(`[MCP Plugin] ======== STARTUP BEGIN ======== (process info unavailable: ${e})`);
  }

  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  ztoolkit.log("[MCP Plugin] [STARTUP] Zotero initialization promises resolved");

  initLocale();

  try {
    await getMinerUService().migrateLegacyCaches();
    ztoolkit.log("[MCP Plugin] [STARTUP] MinerU structured-cache migration completed");
  } catch (error) {
    ztoolkit.log(
      `[MCP Plugin] [STARTUP] MinerU cache migration failed: ${error}`,
      "warn",
    );
  }

  clearDeprecatedContentSettings();

  // The single fused-score threshold was split into a keyword floor and a
  // semantic floor. A user who had tuned the old one keeps that tuning, on the
  // semantic side — the side where the number still means what it meant. Runs
  // once, guarded by its own flag, and does nothing at all to a user who never
  // moved the old value off its default.
  try {
    const migration = migrateFusedScoreThreshold();
    if (migration.migrated) {
      ztoolkit.log(
        `[MCP Plugin] [STARTUP] Carried the previous relevance threshold ${migration.value} over to hybrid.semanticMinScore; the keyword threshold starts at its measured recommendation.`,
      );
    }
  } catch (error) {
    // Never fatal: failing to migrate leaves both new thresholds at their
    // defaults, which is a working search, not a broken one.
    ztoolkit.log(`[MCP Plugin] [STARTUP] Threshold migration skipped: ${error}`, 'warn');
  }

  // Check if this is first installation and show config prompt
  checkFirstInstallation();

  // 启动HTTP服务器
  try {
    const port = serverPreferences.getPort();
    const enabled = serverPreferences.isServerEnabled();
    ztoolkit.log(`[MCP Plugin] [STARTUP] HTTP server config - enabled: ${enabled}, port: ${port}`);

    addon.data.httpServer = httpServer;

    if (enabled === false) {
      ztoolkit.log(`[MCP Plugin] [STARTUP] HTTP server disabled, skipping`);
    } else {
      if (!port || isNaN(port)) {
        throw new Error(`Invalid port value: ${port}`);
      }
      ztoolkit.log(`[MCP Plugin] [STARTUP] Starting HTTP server on port ${port}...`);
      httpServer.start(port);
      ztoolkit.log(`[MCP Plugin] [STARTUP] HTTP server started on port ${port}`);
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(`[MCP Plugin] [STARTUP] Failed to start HTTP server: ${err.message}`, "error");
  }

  // 监听偏好设置变化。回调只负责触发一次去抖的状态对齐，
  // 具体“该不该重启”交给 applyServerState 判断，避免与设置页里
  // 直接调用 start/stop 的逻辑互相打架。
  serverPreferences.addObserver((name) => {
    if (isShuttingDown) return; // 关闭时不处理偏好变化
    ztoolkit.log(`[MCP Plugin] Preference changed: ${name}`);
    if (!WATCHED_SERVER_PREFS.has(name)) return;
    scheduleServerStateSync(name);
  });

  BasicExampleFactory.registerPrefs();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
  ztoolkit.log("[MCP Plugin] [STARTUP] Main windows loaded");

  // Register item notifier for automatic search-index updates
  registerItemNotifier();
  ztoolkit.log("[MCP Plugin] [STARTUP] Item notifier registered");

  // Pick up index refreshes that were queued while the semantic service was
  // unavailable — including ones queued before the last restart.
  try {
    const { startIndexRefreshQueue, processIndexRefreshQueue } = await import(
      "./modules/semantic/indexRefreshQueue"
    );
    startIndexRefreshQueue();
    void processIndexRefreshQueue();
    ztoolkit.log("[MCP Plugin] [STARTUP] Index refresh queue started");
  } catch (error) {
    ztoolkit.log(
      `[MCP Plugin] [STARTUP] Failed to start index refresh queue: ${error}`,
      "error",
    );
  }

  addon.data.initialized = true;
  ztoolkit.log("[MCP Plugin] ======== STARTUP COMPLETE ========");
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Also load addon.ftl and preferences.ftl
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-addon.ftl`,
  );
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-preferences.ftl`,
  );

  // Register context menu for search indexing
  registerSemanticIndexMenu(win);

  // Persistent toolbar entry for the long-term LLM Wiki.
  registerWikiPanel(win);

  // Register search index status column
  registerSemanticIndexColumn();
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterSemanticIndexMenus(win);
  unregisterWikiPanel(win);
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  ztoolkit.log("[MCP Plugin] ======== SHUTDOWN START ========");

  // Set shutdown flag to prevent new async operations
  isShuttingDown = true;

  // Clear all pending timeouts immediately
  ztoolkit.log("[MCP Plugin] [SHUTDOWN 1/7] Clearing pending timeouts...");
  clearAllPendingTimeouts();
  ztoolkit.log("[MCP Plugin] [SHUTDOWN 1/7] Done");

  // 停止索引刷新队列的定时器（队列内容留在 preference 里，下次启动继续）
  try {
    const {
      stopIndexRefreshQueue,
    } = require("./modules/semantic/indexRefreshQueue");
    stopIndexRefreshQueue?.();
  } catch (error) {
    ztoolkit.log(
      `[MCP Plugin] [SHUTDOWN] Error stopping index refresh queue: ${error}`,
      "error",
    );
  }

  // 取消注册条目变化监听器
  try {
    ztoolkit.log("[MCP Plugin] [SHUTDOWN 2/7] Unregistering item notifier...");
    unregisterItemNotifier();
    ztoolkit.log("[MCP Plugin] [SHUTDOWN 2/7] Done");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(`[MCP Plugin] [SHUTDOWN 2/7] Error: ${err.message}`, "error");
  }

    // 注销搜索索引状态列
  try {
      ztoolkit.log("[MCP Plugin] [SHUTDOWN 3/7] Unregistering search index column...");
    unregisterSemanticIndexColumn();
    ztoolkit.log("[MCP Plugin] [SHUTDOWN 3/7] Done");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(`[MCP Plugin] [SHUTDOWN 3/7] Error: ${err.message}`, "error");
  }

  // 停止HTTP服务器 - 这是阻止进程退出的最可能原因
  try {
    ztoolkit.log(`[MCP Plugin] [SHUTDOWN 4/7] Stopping HTTP server (running: ${httpServer.isServerRunning()})...`);
    if (httpServer.isServerRunning()) {
      httpServer.stop();
    }
    ztoolkit.log(`[MCP Plugin] [SHUTDOWN 4/7] Done (running: ${httpServer.isServerRunning()})`);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(`[MCP Plugin] [SHUTDOWN 4/7] Error: ${err.message}`, "error");
  }

  // 停止语义搜索服务
  try {
    ztoolkit.log("[MCP Plugin] [SHUTDOWN 5/7] Stopping semantic search service...");
    // resetSemanticSearchService() 内部已经做了 abortIndex() + destroy() 并置空
    // 单例，且实例不存在时是 no-op——不必先 getSemanticSearchService()，
    // 否则关闭时反而会为了销毁而新建一个从未使用过的实例。
    const { resetSemanticSearchService } = require("./modules/semantic");
    resetSemanticSearchService();
    ztoolkit.log("[MCP Plugin] [SHUTDOWN 5/7] Done");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(`[MCP Plugin] [SHUTDOWN 5/7] Error: ${err.message}`, "error");
  }

  // 停止嵌入服务
  try {
    ztoolkit.log("[MCP Plugin] [SHUTDOWN 6/7] Stopping embedding service...");
    const { getEmbeddingService } = require("./modules/semantic/embeddingService");
    const embeddingService = getEmbeddingService();
    embeddingService.destroy();
    ztoolkit.log("[MCP Plugin] [SHUTDOWN 6/7] Done");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(`[MCP Plugin] [SHUTDOWN 6/7] Error: ${err.message}`, "error");
  }

  // 关闭向量存储数据库
  try {
    ztoolkit.log("[MCP Plugin] [SHUTDOWN 7/7] Closing vector store...");
    const { resetVectorStore } = require("./modules/semantic/vectorStore");
    resetVectorStore();
    ztoolkit.log("[MCP Plugin] [SHUTDOWN 7/7] Done");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(`[MCP Plugin] [SHUTDOWN 7/7] Error: ${err.message}`, "error");
  }

  // Remove context-menu DOM elements from every open window — leftover dead
  // listeners break the item right-click menu after disable (#69)
  try {
    ztoolkit.log("[MCP Plugin] [SHUTDOWN] Removing context menu elements...");
    for (const win of Zotero.getMainWindows()) {
      unregisterSemanticIndexMenus(win as unknown as Window);
      unregisterWikiPanel(win as unknown as Window);
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ztoolkit.log(`[MCP Plugin] [SHUTDOWN] Error removing menus: ${err.message}`, "error");
  }

  try {
    const { resetWikiStore } = require("./modules/wiki/wikiStore");
    void resetWikiStore();
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error closing Wiki database: ${error}`, "warn");
  }

  ztoolkit.log("[MCP Plugin] [SHUTDOWN] Unregistering server preferences...");
  serverPreferences.unregister();

  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];

  ztoolkit.log("[MCP Plugin] ======== SHUTDOWN COMPLETE ========");
}

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this funcion clear.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // You can add your code to the corresponding notify type
  ztoolkit.log(`[MCP Plugin] Zotero notification: ${event}/${type} (${Array.isArray(ids) ? ids.length : 0} ids)`);
}

/**
 * This function is just an example of dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this funcion clear.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Preferences event: ${type}`);
  
  switch (type) {
    case "load":
      ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Loading preference scripts...`);
      
      // 诊断设置面板加载环境
      try {
        if (data.window) {
          ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Preference window available`);
          
          // 检查当前偏好设置状态
          const currentEnabled = Zotero.Prefs.get("extensions.zotero.zotero-lit-synapse.mcp.server.enabled", true);
          const currentPort = Zotero.Prefs.get("extensions.zotero.zotero-lit-synapse.mcp.server.port", true);
          ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Current prefs at panel load - enabled: ${currentEnabled}, port: ${currentPort}`);
          
          // 检查preference元素是否存在
          trackedSetTimeout(() => {
            try {
              const doc = data.window.document;
              const enabledElement = doc?.querySelector('#zotero-prefpane-zotero-lit-synapse-mcp-server-enabled');
              const portElement = doc?.querySelector('#zotero-prefpane-zotero-lit-synapse-mcp-server-port');

              ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Preference elements - enabled: ${!!enabledElement}, port: ${!!portElement}`);

              if (enabledElement) {
                const hasChecked = enabledElement.hasAttribute('checked');
                ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Enabled checkbox state: ${hasChecked}`);
              }

            } catch (error) {
              ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Error checking preference elements: ${error}`, 'error');
            }
          }, 500);
          
        } else {
          ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] WARNING: No preference window in data`, 'error');
        }
      } catch (error) {
        ztoolkit.log(`===MCP=== [hooks.ts] [DIAGNOSTIC] Error in preference load diagnostic: ${error}`, 'error');
      }
      
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

/**
 * Check if this is the first installation and prompt user to configure
 */
function checkFirstInstallation() {
  try {
    const hasShownPrompt = Zotero.Prefs.get("extensions.zotero.zotero-lit-synapse.firstInstallPromptShown", false);
    if (!hasShownPrompt) {
      // Mark as shown immediately to prevent multiple prompts
      Zotero.Prefs.set("extensions.zotero.zotero-lit-synapse.firstInstallPromptShown", true);
      
      // Show prompt after a short delay to ensure UI is ready
      trackedSetTimeout(() => {
        showFirstInstallPrompt();
      }, 3000);
    }
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error checking first installation: ${error}`, "error");
  }
}

/**
 * Show first installation configuration prompt
 */
function showFirstInstallPrompt() {
  try {
    // Use bilingual text for first install prompt
    const title = "欢迎使用 Zotero LitSynapse / Welcome to Zotero LitSynapse";
    const promptText = "感谢安装 Zotero LitSynapse！为了开始使用，您需要为您的 AI 客户端生成配置文件。是否现在打开设置页面来生成配置？\n使用技巧请关注设置页面公众号。\n\nThank you for installing Zotero LitSynapse! To get started, you need to generate configuration files for your AI clients. Would you like to open the settings page now to generate configurations?";
    const openPrefsText = "打开设置 / Open Settings";
    const laterText = "稍后配置 / Configure Later";
    
    // Use a simple window confirm instead of Services.prompt for compatibility
    const message = `${title}\n\n${promptText}\n\n${openPrefsText} (OK) / ${laterText} (Cancel)`;
    
    const mainWindow = Zotero.getMainWindow();
    if (!mainWindow) {
      ztoolkit.log("[MCP Plugin] No main window available", "error");
      return;
    }
    
    const result = mainWindow.confirm(message);
    
    if (result) {
      // User chose to open preferences
      trackedSetTimeout(() => {
        openPreferencesWindow();
      }, 100);
    }
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error showing first install prompt: ${error}`, "error");
  }
}

/**
 * Open the preferences window
 */
function openPreferencesWindow() {
  try {
    const windowName = `${addon.data.config.addonRef}-preferences`;
    const existingWindow = Zotero.getMainWindow().ZoteroPane.openPreferences(null, windowName);
    
    if (existingWindow) {
      existingWindow.focus();
    }
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error opening preferences: ${error}`, "error");
    
    // Fallback: try to open standard preferences
    try {
      Zotero.getMainWindow().openPreferences();
    } catch (fallbackError) {
      ztoolkit.log(`[MCP Plugin] Fallback preferences open failed: ${fallbackError}`, "error");
    }
  }
}

const MCP_MENU_ELEMENT_IDS = [
  "zotero-lit-synapse-semantic-separator",
  "zotero-lit-synapse-semantic-menu",
  "zotero-lit-synapse-collection-semantic-separator",
  "zotero-lit-synapse-collection-semantic-menu",
];

/**
 * Remove all context-menu DOM elements this plugin added to a window.
 * Must run on disable/uninstall: leftover elements keep listeners into the
 * destroyed plugin sandbox and break Zotero's item context menu (#69).
 */
function unregisterSemanticIndexMenus(win: Window) {
  try {
    const doc = (win as any).document;
    if (!doc) return;
    for (const id of MCP_MENU_ELEMENT_IDS) {
      doc.getElementById(id)?.remove();
    }
  } catch (e) {
    // window may already be gone
  }
}

/**
 * Give a context-menu entry the plugin logo on its left.
 *
 * Zotero draws a menu icon from the element's own `list-style-image`, so an
 * inline style plus the `menu-iconic` / `menuitem-iconic` class is all that is
 * needed. We deliberately do NOT use the `zotero-custom-menu-item` class that
 * `Zotero.MenuManager` puts on its own entries: Zotero removes every element
 * carrying that class from a popup it refreshes unless the element also has one
 * of MenuManager's generated keys, which would delete our hand-built menus.
 */
function applyMenuIcon(elem: Element, tag: "menu" | "menuitem" = "menu") {
  try {
    elem.classList.add(tag === "menu" ? "menu-iconic" : "menuitem-iconic");
    // 48px source: Zotero renders the icon box at 16px, so it stays crisp on HiDPI
    const iconURL = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;
    (elem as unknown as HTMLElement).style.listStyleImage = `url("${iconURL}")`;
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Failed to apply menu icon: ${error}`, "error");
  }
}

/**
 * Register search index context menu
 */
function registerSemanticIndexMenu(win: _ZoteroTypes.MainWindow) {
  // Remove any leftovers first (re-enable / duplicate onMainWindowLoad calls)
  unregisterSemanticIndexMenus(win as unknown as Window);
  try {
    const doc = win.document;

    // Find the item context menu
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (!itemMenu) {
      ztoolkit.log("[MCP Plugin] Item menu not found, skipping context menu registration");
      return;
    }

    // Create menu separator
    const separator = doc.createXULElement("menuseparator");
    separator.id = "zotero-lit-synapse-semantic-separator";

    // Create parent menu
    const parentMenu = doc.createXULElement("menu");
    parentMenu.id = "zotero-lit-synapse-semantic-menu";
    parentMenu.setAttribute("label", getString("menu-semantic-index" as any) || "Update Index");
    applyMenuIcon(parentMenu);

    // Create popup for submenu
    const popup = doc.createXULElement("menupopup");
    popup.id = "zotero-lit-synapse-semantic-popup";

    // Create "Index Selected Items" menu item
    const indexSelectedItem = doc.createXULElement("menuitem");
    indexSelectedItem.id = "zotero-lit-synapse-index-selected";
    indexSelectedItem.setAttribute("label", getString("menu-semantic-index-selected" as any) || "Index Selected Items");
    indexSelectedItem.addEventListener("command", () => {
      handleIndexSelected(win);
    });

    // Create "Index All Items" menu item
    const indexAllItem = doc.createXULElement("menuitem");
    indexAllItem.id = "zotero-lit-synapse-index-all";
    indexAllItem.setAttribute("label", getString("menu-semantic-index-all" as any) || "Index All Items");
    indexAllItem.addEventListener("command", () => {
      handleIndexAll(win);
    });

    // Create "Clear Selected Items Index" menu item
    const clearSelectedItem = doc.createXULElement("menuitem");
    clearSelectedItem.id = "zotero-lit-synapse-clear-selected";
    clearSelectedItem.setAttribute("label", getString("menu-semantic-clear-selected" as any) || "Clear Selected Items Index");
    clearSelectedItem.addEventListener("command", () => {
      handleClearSelectedIndex(win);
    });

    // Assemble menu
    popup.appendChild(indexSelectedItem);
    popup.appendChild(indexAllItem);
    popup.appendChild(clearSelectedItem);
    parentMenu.appendChild(popup);

    // Add to item menu
    itemMenu.appendChild(separator);
    itemMenu.appendChild(parentMenu);

  ztoolkit.log("[MCP Plugin] Search index context menu registered");
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error registering context menu: ${error}`, "error");
  }

  // Also register collection context menu
  registerCollectionSemanticIndexMenu(win);
}

/**
 * Register search index context menu for collections
 */
function registerCollectionSemanticIndexMenu(win: _ZoteroTypes.MainWindow) {
  try {
    const doc = win.document;

    // Find the collection context menu
    const collectionMenu = doc.getElementById("zotero-collectionmenu");
    if (!collectionMenu) {
      ztoolkit.log("[MCP Plugin] Collection menu not found, skipping collection context menu registration");
      return;
    }

    // Create menu separator
    const separator = doc.createXULElement("menuseparator");
    separator.id = "zotero-lit-synapse-collection-semantic-separator";

    // Create parent menu
    const parentMenu = doc.createXULElement("menu");
    parentMenu.id = "zotero-lit-synapse-collection-semantic-menu";
    parentMenu.setAttribute("label", getString("menu-collection-semantic-index" as any) || "Index");
    applyMenuIcon(parentMenu);

    // Create popup for submenu
    const popup = doc.createXULElement("menupopup");
    popup.id = "zotero-lit-synapse-collection-semantic-popup";

    // Create "Build Index" menu item (incremental, only unindexed items)
    const buildIndexItem = doc.createXULElement("menuitem");
    buildIndexItem.id = "zotero-lit-synapse-collection-build-index";
    buildIndexItem.setAttribute("label", getString("menu-collection-build-index" as any) || "Build Index");
    buildIndexItem.addEventListener("command", () => {
      handleIndexCollection(win, false);
    });

    // Create "Rebuild Index" menu item (rebuild all items in collection)
    const rebuildIndexItem = doc.createXULElement("menuitem");
    rebuildIndexItem.id = "zotero-lit-synapse-collection-rebuild-index";
    rebuildIndexItem.setAttribute("label", getString("menu-collection-rebuild-index" as any) || "Rebuild Index");
    rebuildIndexItem.addEventListener("command", () => {
      handleIndexCollection(win, true);
    });

    // Create "Clear Index" menu item
    const clearIndexItem = doc.createXULElement("menuitem");
    clearIndexItem.id = "zotero-lit-synapse-collection-clear-index";
    clearIndexItem.setAttribute("label", getString("menu-collection-clear-index" as any) || "Clear Index");
    clearIndexItem.addEventListener("command", () => {
      handleClearCollectionIndex(win);
    });

    // Assemble menu
    popup.appendChild(buildIndexItem);
    popup.appendChild(rebuildIndexItem);
    popup.appendChild(clearIndexItem);
    parentMenu.appendChild(popup);

    // Add to collection menu
    collectionMenu.appendChild(separator);
    collectionMenu.appendChild(parentMenu);

  ztoolkit.log("[MCP Plugin] Collection search index context menu registered");
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error registering collection context menu: ${error}`, "error");
  }
}

/**
 * Recursively get all item IDs from a collection and its subcollections
 */
function getAllItemIDsFromCollection(collection: any): number[] {
  const itemIDs = new Set<number>();

  // Get direct child items
  const directItems = collection.getChildItems(true) || [];
  for (const id of directItems) {
    itemIDs.add(id);
  }

  // Recursively get items from subcollections
  const childCollectionIDs = collection.getChildCollections(true) || [];
  for (const childCollectionID of childCollectionIDs) {
    const childCollection = Zotero.Collections.get(childCollectionID);
    if (childCollection) {
      const childItems = getAllItemIDsFromCollection(childCollection);
      for (const id of childItems) {
        itemIDs.add(id);
      }
    }
  }

  return Array.from(itemIDs);
}

/**
 * Handle indexing a collection
 * @param rebuild If true, rebuild index for all items (even if already indexed)
 */
async function handleIndexCollection(win: _ZoteroTypes.MainWindow, rebuild: boolean = false) {
  try {
    const ZoteroPane = win.ZoteroPane;
    if (!ZoteroPane) {
      ztoolkit.log("[MCP Plugin] ZoteroPane not available", "error");
      return;
    }

    // Get selected collection
    const collection = ZoteroPane.getSelectedCollection?.();
    if (!collection) {
      ztoolkit.log("[MCP Plugin] No collection selected");
      showNotification(win, getString("menu-semantic-index-no-collection" as any) || "Please select a collection");
      return;
    }

    ztoolkit.log(`[MCP Plugin] ${rebuild ? 'Rebuilding' : 'Building'} index for collection: ${collection.name}`);

    // Get all items in the collection (including nested subcollections)
    const itemIDs = getAllItemIDsFromCollection(collection);
    if (!itemIDs || itemIDs.length === 0) {
      ztoolkit.log("[MCP Plugin] Collection has no items");
      showNotification(win, getString("menu-semantic-index-no-items" as any) || "Collection has no items");
      return;
    }

    // Convert IDs to item objects and filter for regular items
    const items = Zotero.Items.get(itemIDs);
    const itemKeys = items
      .filter((item: any) => item.isRegularItem?.())
      .map((item: any) => item.key);

    if (itemKeys.length === 0) {
      ztoolkit.log("[MCP Plugin] No regular items in collection");
      showNotification(win, getString("menu-semantic-index-no-items" as any) || "No indexable items in collection");
      return;
    }

    ztoolkit.log(`[MCP Plugin] ${rebuild ? 'Rebuilding' : 'Building'} index for ${itemKeys.length} items from collection "${collection.name}"`);

    // Import and use semantic search service
    const { getSemanticSearchService } = await import("./modules/semantic");
    const semanticService = getSemanticSearchService();
    await semanticService.initialize();

    // Live progress popup for the whole run
    const live = createLiveIndexProgress(
      win,
      `${getString("menu-semantic-index-started" as any) || "Indexing started"}: ${collection.name}`,
    );

    // Build index for collection items ("build" forces the selected items;
    // "rebuild" already clears everything first, so force would be redundant)
    semanticService.buildIndex({
      itemKeys,
      libraryID: collection.libraryID,
      rebuild,
      force: !rebuild,
      onProgress: (progress) => {
        live.onProgress(progress);
        ztoolkit.log(`[MCP Plugin] Index progress: ${progress.processed}/${progress.total}`);
      }
    }).then((result) => {
      live.finish();
      if (result.status === 'busy') {
        ztoolkit.log(`[MCP Plugin] Collection indexing skipped: another build is running`);
        showNotice(win, {
          type: "warning",
          title: getString("menu-semantic-index-busy" as any) || "An index build is already running, please wait for it to finish",
        });
        return;
      }
      ztoolkit.log(`[MCP Plugin] Collection indexing completed: ${result.processed}/${result.total} items, skipped=${result.skipped ?? 0}, minerUFailures=${result.minerUFailures ?? 0}`);
      // Refresh semantic column to show updated status
      refreshSemanticColumn();
      showNotice(win, describeIndexResult(result, collection.name));
    }).catch((error) => {
      live.finish();
      ztoolkit.log(`[MCP Plugin] Collection indexing failed: ${error}`, "error");
      // Refresh column anyway to show current status
      refreshSemanticColumn();
      // Show error notification
      const errorMsg = `${getString("menu-semantic-index-error" as any) || "Indexing failed"}: ${error.message || error}`;
      showNotification(win, errorMsg);
    });

  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error handling collection index: ${error}`, "error");
    showNotification(win, getString("menu-semantic-index-error" as any) || "Indexing failed");
  }
}

/**
 * Handle clearing index for a collection
 */
async function handleClearCollectionIndex(win: _ZoteroTypes.MainWindow) {
  try {
    const ZoteroPane = win.ZoteroPane;
    if (!ZoteroPane) {
      ztoolkit.log("[MCP Plugin] ZoteroPane not available", "error");
      return;
    }

    // Get selected collection
    const collection = ZoteroPane.getSelectedCollection?.();
    if (!collection) {
      ztoolkit.log("[MCP Plugin] No collection selected");
      showNotification(win, getString("menu-semantic-index-no-collection" as any) || "Please select a collection");
      return;
    }

    // Confirm before clearing
    const confirmMsg = getString("menu-collection-clear-confirm" as any) ||
    `Are you sure you want to clear the search index for "${collection.name}"?`;
    if (!win.confirm(confirmMsg)) {
      return;
    }

    ztoolkit.log(`[MCP Plugin] Clearing index for collection: ${collection.name}`);

    // Get all items in the collection (including nested subcollections)
    const itemIDs = getAllItemIDsFromCollection(collection);
    if (!itemIDs || itemIDs.length === 0) {
      ztoolkit.log("[MCP Plugin] Collection has no items");
      showNotification(win, getString("menu-semantic-index-no-items" as any) || "Collection has no items");
      return;
    }

    // Convert IDs to item objects and get keys
    const items = Zotero.Items.get(itemIDs);
    const regularItems = items.filter((item: any) =>
      item.isRegularItem?.(),
    );
    const itemKeys = regularItems.map((item: any) => item.key);

    if (itemKeys.length === 0) {
      ztoolkit.log("[MCP Plugin] No regular items in collection");
      return;
    }

    // Delete vectors for these items
    const { getVectorStore } = await import("./modules/semantic/vectorStore");
    const vectorStore = getVectorStore();
    await vectorStore.initialize();

    await vectorStore.deleteItemsVectors(itemKeys, collection.libraryID);
    const clearedCount = itemKeys.length;

    ztoolkit.log(`[MCP Plugin] Cleared index for ${clearedCount} items in collection "${collection.name}"`);

    // Refresh semantic column
    refreshSemanticColumn();

    // Show notification
    const message = `${getString("menu-collection-index-cleared" as any) || "Index cleared"}: ${collection.name} (${clearedCount})`;
    showNotification(win, message);

  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error clearing collection index: ${error}`, "error");
    showNotification(win, getString("menu-semantic-index-error" as any) || "Failed to clear index");
  }
}

/**
 * Handle clearing index for selected items
 */
async function handleClearSelectedIndex(win: _ZoteroTypes.MainWindow) {
  try {
    const ZoteroPane = win.ZoteroPane;
    if (!ZoteroPane) {
      ztoolkit.log("[MCP Plugin] ZoteroPane not available", "error");
      return;
    }

    const selectedItems = ZoteroPane.getSelectedItems();
    if (!selectedItems || selectedItems.length === 0) {
      ztoolkit.log("[MCP Plugin] No items selected");
      showNotice(win, {
        type: "warning",
        title: getString("notice-index-no-selection" as any) || "Nothing selected",
      });
      return;
    }

    // Selecting the PDF row instead of its parent is the natural thing to do
    // when you want that PDF re-read, so resolve attachments to their parent
    // item rather than silently dropping them. Identities carry the library so
    // a group-library selection is never indexed against My Library's ID.
    const selectedIdentities: Array<{ key: string; libraryID: number }> = [];
    for (const item of selectedItems as any[]) {
      const key = item.isRegularItem?.()
        ? item.key
        : item.parentItem?.key || (item.parentItemKey as string | undefined);
      if (key) {
        selectedIdentities.push({
          key,
          libraryID: item.libraryID ?? Zotero.Libraries.userLibraryID,
        });
      }
    }
    const keysByLibrary = groupItemKeysByLibrary(selectedIdentities);
    const itemKeys = Array.from(keysByLibrary.values()).flat();

    if (itemKeys.length === 0) {
      ztoolkit.log("[MCP Plugin] No indexable items in selection");
      showNotice(win, {
        type: "warning",
        title: getString("notice-index-no-eligible" as any) || "Nothing indexable in the selection",
        lines: [
          getString("notice-index-no-eligible-hint" as any) ||
            "Select a bibliography item, or an attachment that belongs to one.",
        ],
      });
      return;
    }

    // Confirm before clearing
    const confirmMsg = getString("menu-semantic-clear-selected-confirm" as any) ||
    `Are you sure you want to clear the search index for ${itemKeys.length} selected item(s)?`;
    if (!win.confirm(confirmMsg)) {
      return;
    }

    ztoolkit.log(`[MCP Plugin] Clearing index for ${itemKeys.length} selected items...`);

    // Delete vectors for these items, per library: storage keys are namespaced
    // by libraryID, so clearing without one silently misses group items.
    const { getVectorStore } = await import("./modules/semantic/vectorStore");
    const vectorStore = getVectorStore();
    await vectorStore.initialize();

    let clearedCount = 0;
    for (const [libraryID, keys] of keysByLibrary) {
      await vectorStore.deleteItemsVectors(keys, libraryID);
      clearedCount += keys.length;
    }

    ztoolkit.log(`[MCP Plugin] Cleared index for ${clearedCount} items`);

    // Refresh semantic column
    refreshSemanticColumn();

    // Show notification
    const message = `${getString("menu-semantic-clear-selected-done" as any) || "Index cleared for"} ${clearedCount} ${getString("menu-semantic-items" as any) || "items"}`;
    showNotification(win, message);

  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error clearing selected items index: ${error}`, "error");
    showNotification(win, getString("menu-semantic-index-error" as any) || "Failed to clear index");
  }
}

/**
 * Run one buildIndex per library and merge the per-library results into the
 * single summary the notice UI expects.
 *
 * A `busy` result short-circuits: another build already holds the lock, so the
 * remaining libraries would just be rejected too.
 */
async function runBuildsPerLibrary(
  semanticService: any,
  keysByLibrary: Map<number, string[]>,
  onProgress: (progress: any) => void,
): Promise<any> {
  const merged: any = {
    total: 0,
    processed: 0,
    indexed: 0,
    unchanged: 0,
    skipped: 0,
    failedCount: 0,
    bodyFailures: 0,
    minerUFailures: 0,
    minerUAttachments: 0,
    status: "completed",
  };

  for (const [libraryID, itemKeys] of keysByLibrary) {
    ztoolkit.log(`[MCP Plugin] Indexing ${itemKeys.length} items in libraryID=${libraryID}`);
    const result = await semanticService.buildIndex({
      itemKeys,
      libraryID,
      rebuild: false,
      force: true,
      onProgress,
    });
    if (result?.status === "busy") return result;
    merged.total += result?.total ?? 0;
    merged.processed += result?.processed ?? 0;
    merged.indexed += result?.indexed ?? 0;
    merged.unchanged += result?.unchanged ?? 0;
    merged.skipped += result?.skipped ?? 0;
    merged.failedCount += result?.failedCount ?? 0;
    merged.bodyFailures += result?.bodyFailures ?? 0;
    merged.minerUFailures += result?.minerUFailures ?? 0;
    merged.minerUAttachments += result?.minerUAttachments ?? 0;
    if (result?.status && result.status !== "completed") {
      merged.status = result.status;
      merged.error = result.error;
      merged.errorType = result.errorType;
    }
  }

  return merged;
}

/**
 * Handle indexing selected items
 */
async function handleIndexSelected(win: _ZoteroTypes.MainWindow) {
  try {
    const ZoteroPane = win.ZoteroPane;
    if (!ZoteroPane) {
      ztoolkit.log("[MCP Plugin] ZoteroPane not available", "error");
      return;
    }

    const selectedItems = ZoteroPane.getSelectedItems();
    if (!selectedItems || selectedItems.length === 0) {
      ztoolkit.log("[MCP Plugin] No items selected");
      showNotice(win, {
        type: "warning",
        title: getString("notice-index-no-selection" as any) || "Nothing selected",
      });
      return;
    }

    // Selecting the PDF row instead of its parent is the natural thing to do
    // when you want that PDF re-read, so resolve attachments to their parent
    // item rather than silently dropping them. Identities carry the library so
    // a group-library selection is never indexed against My Library's ID.
    const selectedIdentities: Array<{ key: string; libraryID: number }> = [];
    for (const item of selectedItems as any[]) {
      const key = item.isRegularItem?.()
        ? item.key
        : item.parentItem?.key || (item.parentItemKey as string | undefined);
      if (key) {
        selectedIdentities.push({
          key,
          libraryID: item.libraryID ?? Zotero.Libraries.userLibraryID,
        });
      }
    }
    const keysByLibrary = groupItemKeysByLibrary(selectedIdentities);
    const itemKeys = Array.from(keysByLibrary.values()).flat();

    if (itemKeys.length === 0) {
      ztoolkit.log("[MCP Plugin] No indexable items in selection");
      showNotice(win, {
        type: "warning",
        title: getString("notice-index-no-eligible" as any) || "Nothing indexable in the selection",
        lines: [
          getString("notice-index-no-eligible-hint" as any) ||
            "Select a bibliography item, or an attachment that belongs to one.",
        ],
      });
      return;
    }

    ztoolkit.log(`[MCP Plugin] Indexing ${itemKeys.length} selected items...`);

    // Import and use semantic search service
    const { getSemanticSearchService } = await import("./modules/semantic");
    const semanticService = getSemanticSearchService();
    await semanticService.initialize();

    // Live progress popup for the whole run
    const live = createLiveIndexProgress(
      win,
      getString("menu-semantic-index-started" as any) || "Indexing started",
    );

    // Build index for selected items. force: the user explicitly asked for
    // these items, so "already in index_status" must not silently skip them.
    // Selections can span libraries, and buildIndex resolves keys with
    // getByLibraryAndKeyAsync, so each library gets its own build.
    runBuildsPerLibrary(semanticService, keysByLibrary, (progress) => {
      live.onProgress(progress);
      ztoolkit.log(`[MCP Plugin] Index progress: ${progress.processed}/${progress.total}`);
    }).then((result) => {
      live.finish();
      if (result.status === 'busy') {
        ztoolkit.log(`[MCP Plugin] Indexing skipped: another build is running`);
        showNotice(win, {
          type: "warning",
          title: getString("menu-semantic-index-busy" as any) || "An index build is already running, please wait for it to finish",
        });
        return;
      }
      ztoolkit.log(`[MCP Plugin] Indexing completed: ${result.processed}/${result.total} items, skipped=${result.skipped ?? 0}, minerUFailures=${result.minerUFailures ?? 0}`);
      // Refresh semantic column to show updated status
      refreshSemanticColumn();
      showNotice(win, describeIndexResult(result));
    }).catch((error) => {
      live.finish();
      ztoolkit.log(`[MCP Plugin] Indexing failed: ${error}`, "error");
      // Refresh column anyway to show current status
      refreshSemanticColumn();
      showNotice(win, {
        type: "error",
        title: getString("menu-semantic-index-error" as any) || "Indexing failed",
        lines: [truncateEnd(String(error?.message || error), NOTICE_MAX_COLUMNS * 3)],
        sticky: true,
      });
    });

  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error handling index selected: ${error}`, "error");
    showNotification(win, getString("menu-semantic-index-error" as any) || "Indexing failed");
  }
}

/**
 * Handle indexing all items
 */
async function handleIndexAll(win: _ZoteroTypes.MainWindow) {
  try {
    // "All items" means the library currently open in the pane. Falling back
    // to userLibraryID would index My Library while the user is looking at a
    // group library and watching a progress popup that never touches it.
    const selectedLibraryID =
      (win.ZoteroPane as any)?.getSelectedLibraryID?.() ??
      Zotero.Libraries.userLibraryID;
    ztoolkit.log(`[MCP Plugin] Indexing all items in libraryID=${selectedLibraryID}...`);

    // Import and use semantic search service
    const { getSemanticSearchService } = await import("./modules/semantic");
    const semanticService = getSemanticSearchService();
    await semanticService.initialize();

    // Live progress popup for the whole run
    const live = createLiveIndexProgress(
      win,
      getString("menu-semantic-index-started" as any) || "Indexing started",
    );

    // Build index for all items in the selected library
    semanticService.buildIndex({
      libraryID: selectedLibraryID,
      rebuild: false,
      onProgress: (progress) => {
        live.onProgress(progress);
        ztoolkit.log(`[MCP Plugin] Index progress: ${progress.processed}/${progress.total}`);
      }
    }).then((result) => {
      live.finish();
      if (result.status === 'busy') {
        ztoolkit.log(`[MCP Plugin] Indexing skipped: another build is running`);
        showNotice(win, {
          type: "warning",
          title: getString("menu-semantic-index-busy" as any) || "An index build is already running, please wait for it to finish",
        });
        return;
      }
      ztoolkit.log(`[MCP Plugin] Indexing completed: ${result.processed}/${result.total} items, skipped=${result.skipped ?? 0}, minerUFailures=${result.minerUFailures ?? 0}`);
      // Refresh semantic column to show updated status
      refreshSemanticColumn();
      showNotice(win, describeIndexResult(result));
    }).catch((error) => {
      live.finish();
      ztoolkit.log(`[MCP Plugin] Indexing failed: ${error}`, "error");
      // Refresh column anyway to show current status
      refreshSemanticColumn();
      showNotice(win, {
        type: "error",
        title: getString("menu-semantic-index-error" as any) || "Indexing failed",
        lines: [truncateEnd(String(error?.message || error), NOTICE_MAX_COLUMNS * 3)],
        sticky: true,
      });
    });

  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error handling index all: ${error}`, "error");
    showNotification(win, getString("menu-semantic-index-error" as any) || "Indexing failed");
  }
}

/**
 * A progress popup that stays up for the whole build.
 *
 * MinerU parsing is a minutes-long remote call, and the old flow showed one
 * "started" toast and then nothing until the end. With no visible activity the
 * only reasonable conclusion was that nothing had happened — so this reports
 * both the item counter and which PDF is being parsed right now.
 */
interface LiveIndexProgress {
  onProgress: (progress: any) => void;
  finish: () => void;
}

function createLiveIndexProgress(
  win: _ZoteroTypes.MainWindow,
  headline: string,
): LiveIndexProgress {
  let progressWin: any = null;
  let counterEntry: any = null;
  let activityEntry: any = null;
  let closed = false;
  let lastCount = "";

  // A build runs several items in parallel, so more than one PDF can be in
  // MinerU at once; keep the whole set and surface the first one.
  const parsing = new Map<string, string>();

  const setActivity = (text: string) => {
    try {
      activityEntry?.setText(text);
    } catch (e) {
      /* ItemProgress.setText is not available on every Zotero build */
    }
  };

  try {
    progressWin = new Zotero.ProgressWindow({ closeOnClick: false });
    progressWin.changeHeadline("Zotero LitSynapse");
    counterEntry = new progressWin.ItemProgress(
      noticeIcon(),
      truncateEnd(headline, NOTICE_MAX_COLUMNS),
    );
    activityEntry = new progressWin.ItemProgress(
      noticeIcon(),
      truncateEnd(
        getString("notice-index-preparing" as any) || "Preparing…",
        NOTICE_MAX_COLUMNS,
      ),
    );
    progressWin.show();
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Live progress window unavailable: ${error}`, "warn");
  }

  const minerUListener = (event: any) => {
    if (closed) return;
    if (event.phase === "start") {
      parsing.set(event.attachmentKey, event.fileName);
    } else {
      parsing.delete(event.attachmentKey);
    }

    if (parsing.size > 0) {
      const [firstName] = Array.from(parsing.values());
      const label = getString("notice-index-parsing" as any) || "Parsing with MinerU";
      // The "+N" counter is fixed-width information; reserve its columns
      // before handing what is left to the file name.
      const more = parsing.size > 1 ? ` (+${parsing.size - 1})` : "";
      setActivity(
        fitLabelled(label, firstName, NOTICE_MAX_COLUMNS - displayWidth(more)) + more,
      );
    } else if (event.phase === "failed") {
      setActivity(
        fitLabelled(
          getString("notice-mineru-failed" as any) || "MinerU could not parse",
          event.fileName,
          NOTICE_MAX_COLUMNS,
        ),
      );
    } else {
  setActivity(
      truncateEnd(
        getString("notice-index-embedding" as any) || "Writing vectors…",
        NOTICE_MAX_COLUMNS,
      ),
    );
    }
  };

  try {
    getMinerUService().setProgressListener(minerUListener);
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Could not attach MinerU progress listener: ${error}`, "warn");
  }

  return {
    onProgress(progress: any) {
      if (closed) return;
      const total = progress?.total ?? 0;
      const processed = progress?.processed ?? 0;
      const count = `${processed}/${total}`;
      if (count === lastCount) return;
      lastCount = count;
      try {
        counterEntry?.setText(
          truncateEnd(`${headline} ${count}`, NOTICE_MAX_COLUMNS),
        );
        if (total > 0) {
          counterEntry?.setProgress(Math.min(100, Math.round((processed / total) * 100)));
        }
      } catch (e) {
        /* styling must never break the build */
      }
    },
    finish() {
      closed = true;
      try {
        getMinerUService().setProgressListener(null);
      } catch (e) {
        /* nothing to detach */
      }
      try {
        progressWin?.close();
      } catch (e) {
        /* already gone */
      }
    },
  };
}

/**
 * Zotero's ProgressWindow is a fixed-width panel and does not reflow what we
 * put in it: anything wider than the panel is simply cut off at the edge.
 * Everything below exists to make our own text fit before it gets there.
 *
 * The budget is in display columns, not characters — CJK glyphs are twice as
 * wide as latin ones, so a 40-character Chinese line is 80 columns and runs
 * off the panel even though `length` looks harmless.
 */
const NOTICE_MAX_COLUMNS = 40;
/** Cap the whole popup so a long error can't turn it into a wall of text */
const NOTICE_MAX_LINES = 8;

/** East Asian wide / fullwidth ranges — these occupy two columns */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of String(text || "")) {
    width += WIDE_CHAR.test(ch) ? 2 : 1;
  }
  return width;
}

/** Cut from the end, leaving room for the ellipsis */
function truncateEnd(value: string, maxColumns: number): string {
  const text = String(value || "");
  if (displayWidth(text) <= maxColumns) return text;
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = WIDE_CHAR.test(ch) ? 2 : 1;
    if (width + w > maxColumns - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

/**
 * Cut from the middle. File names are the case that matters: the tail carries
 * the extension and the disambiguating part, so keeping both ends beats
 * keeping a prefix that is identical across a dozen papers.
 */
function truncateMiddle(value: string, maxColumns: number): string {
  const text = String(value || "");
  if (displayWidth(text) <= maxColumns) return text;

  const budget = Math.max(2, maxColumns - 1);
  const headBudget = Math.ceil(budget / 2);
  const tailBudget = budget - headBudget;

  let head = "";
  let headWidth = 0;
  for (const ch of text) {
    const w = WIDE_CHAR.test(ch) ? 2 : 1;
    if (headWidth + w > headBudget) break;
    head += ch;
    headWidth += w;
  }

  const chars = Array.from(text);
  let tail = "";
  let tailWidth = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = WIDE_CHAR.test(chars[i]) ? 2 : 1;
    if (tailWidth + w > tailBudget) break;
    tail = chars[i] + tail;
    tailWidth += w;
  }

  return `${head}…${tail}`;
}

/**
 * Break a line into panel-width segments, preferring spaces so latin text
 * splits between words. CJK has no spaces, so it falls back to a hard cut —
 * which is fine, that is exactly how it would wrap anyway.
 */
function wrapToWidth(value: string, maxColumns: number): string[] {
  const text = String(value || "").trim();
  if (!text) return [];
  if (displayWidth(text) <= maxColumns) return [text];

  const segments: string[] = [];
  let current = "";
  let width = 0;

  for (const ch of text) {
    const w = WIDE_CHAR.test(ch) ? 2 : 1;
    if (width + w > maxColumns) {
      // Back up to the last space so we don't split a word mid-way
      const lastSpace = current.lastIndexOf(" ");
      if (lastSpace > maxColumns / 3) {
        segments.push(current.slice(0, lastSpace));
        current = current.slice(lastSpace + 1);
        width = displayWidth(current);
      } else {
        segments.push(current);
        current = "";
        width = 0;
      }
    }
    current += ch;
    width += w;
  }
  if (current.trim()) segments.push(current.trim());

  // A hard cut lands a stray character or two on a line of its own — a lone
  // "。" reads like a rendering bug. Pull text back from the previous segment
  // until the tail carries its weight. Only the previous segment shrinks, so
  // neither line can end up over budget.
  if (segments.length >= 2) {
    const lastIndex = segments.length - 1;
    if (displayWidth(segments[lastIndex]) <= 4) {
      const chars = Array.from(segments[lastIndex - 1]);
      let moved = segments[lastIndex];
      while (chars.length > 1 && displayWidth(moved) < 8) {
        moved = (chars.pop() as string) + moved;
      }
      segments[lastIndex - 1] = chars.join("");
      segments[lastIndex] = moved;
    }
  }

  return segments;
}

/** Fit "<label>: <value>" into one line by shrinking the value, not the label */
function fitLabelled(label: string, value: string, maxColumns: number): string {
  const prefix = `${label}: `;
  const room = maxColumns - displayWidth(prefix);
  if (room < 8) {
    // Pathological label — truncate the whole thing rather than emit garbage
    return truncateEnd(`${prefix}${value}`, maxColumns);
  }
  return `${prefix}${truncateMiddle(value, room)}`;
}

/**
 * Show a simple notification
 */
type NoticeType = "info" | "success" | "warning" | "error";

interface NoticeOptions {
  /** Drives the icon, the marker and how long the popup sticks around */
  type?: NoticeType;
  /** One-line summary — the part people actually read */
  title: string;
  /** Optional detail lines shown under the title */
  lines?: string[];
  /** Keep it open until clicked (used for outcomes worth reading) */
  sticky?: boolean;
}

/**
 * Resolved lazily: the `addon` global is installed by index.ts after this
 * module has been evaluated, so touching it at module scope would throw
 * during bootstrap startup.
 */
function noticeIcon(): string {
  return `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`;
}

/** Successes disappear quickly; problems stay long enough to be read. */
const NOTICE_DWELL_MS: Record<NoticeType, number> = {
  info: 3500,
  success: 4500,
  warning: 9000,
  error: 14000,
};

/** Warnings and errors stay on screen until dismissed */
function isProblemNotice(type: NoticeType): boolean {
  return type === "warning" || type === "error";
}

const NOTICE_MARK: Record<NoticeType, string> = {
  info: "",
  success: "✓ ",
  warning: "! ",
  error: "× ",
};

/**
 * Show a Zotero progress-window notification.
 *
 * The ProgressWindow API varies a little across Zotero versions, so every
 * embellishment is guarded — a styling failure must never swallow the message.
 */
function showNotice(win: _ZoteroTypes.MainWindow, options: NoticeOptions) {
  const type = options.type || "info";
  try {
    const progressWin = new Zotero.ProgressWindow({ closeOnClick: true });
    progressWin.changeHeadline("Zotero LitSynapse");

    let rendered = false;
    try {
      const entry = new progressWin.ItemProgress(
        noticeIcon(),
        truncateEnd(
          `${NOTICE_MARK[type]}${options.title}`,
          NOTICE_MAX_COLUMNS,
        ),
      );
      if (type === "error" || type === "warning") {
        entry.setError();
      } else {
        entry.setProgress(100);
      }
      rendered = true;
    } catch (e) {
      ztoolkit.log(`[MCP Plugin] ItemProgress unavailable, falling back: ${e}`, "warn");
    }
    if (!rendered) {
      progressWin.addDescription(
        truncateEnd(`${NOTICE_MARK[type]}${options.title}`, NOTICE_MAX_COLUMNS),
      );
    }

    let emitted = 0;
    for (const line of options.lines || []) {
      if (!line) continue;
      for (const segment of wrapToWidth(line, NOTICE_MAX_COLUMNS)) {
        if (emitted >= NOTICE_MAX_LINES) break;
        progressWin.addDescription(segment);
        emitted++;
      }
      if (emitted >= NOTICE_MAX_LINES) break;
    }

    progressWin.show();
    if (!options.sticky) {
      progressWin.startCloseTimer(NOTICE_DWELL_MS[type]);
    }
  } catch (error) {
    ztoolkit.log(`[MCP Plugin] Error showing notification: ${error}`, "warn");
  }
}

/** Plain informational popup — kept for the simple call sites */
function showNotification(win: _ZoteroTypes.MainWindow, message: string) {
  showNotice(win, { type: "info", title: message });
}

/**
 * Turn a finished build into something a human can act on. A bare "0/1" was
 * the most confusing thing the old notification did, so the reason behind a
 * zero is always spelled out.
 */
function describeIndexResult(result: any, prefix?: string): NoticeOptions {
  const processed = result?.processed ?? 0;
  const total = result?.total ?? 0;
  const skipped = result?.skipped ?? 0;
  const failed = result?.failedCount ?? 0;
  const minerUFailures = result?.minerUFailures ?? 0;
  const attachments = result?.minerUAttachments ?? 0;
  // "processed" only means the item was visited; an item can be visited and
  // left untouched because nothing changed. Report the two apart, otherwise a
  // run that wrote nothing still reads as a triumphant "N/N".
  const indexed = result?.indexed ?? 0;
  const unchanged = result?.unchanged ?? 0;
  const lines: string[] = [];
  const scope = prefix ? `${prefix} · ` : "";

  let type: NoticeType = "success";
  let title: string;

  if (result?.status === "failed") {
    type = "error";
    title = `${scope}${getString("menu-semantic-index-error" as any) || "Indexing failed"}: ${processed}/${total}`;
  } else if (total === 0 && skipped > 0) {
    type = "info";
    title = `${scope}${getString("notice-index-nothing-new" as any) || "Nothing new to index"}`;
    lines.push(`${getString("notice-index-skipped" as any) || "Already indexed, skipped"}: ${skipped}`);
  } else if (total === 0) {
    type = "info";
    title = `${scope}${getString("notice-index-nothing" as any) || "No indexable items found"}`;
  } else {
    title = `${scope}${getString("notice-index-done" as any) || "Indexing finished"}: ${processed}/${total}`;
    if (indexed > 0) {
      lines.push(`${getString("notice-index-written" as any) || "Vectors rewritten for"}: ${indexed}`);
    } else if (unchanged === 0) {
      // Nothing written AND nothing recognised as unchanged — the only case
      // where a zero is actually suspicious. "Unchanged" is a successful
      // outcome and must not be dressed up as a failure.
      type = "warning";
      lines.push(
        getString("notice-index-zero-hint" as any) ||
          "Nothing was written: no text could be extracted.",
      );
    }
    if (unchanged > 0) {
      lines.push(`${getString("notice-index-unchanged" as any) || "Already up to date"}: ${unchanged}`);
    }
    if (skipped > 0) {
      lines.push(`${getString("notice-index-skipped" as any) || "Already indexed, skipped"}: ${skipped}`);
    }
  }

  // Worth its own line: this is the file the user actually goes looking for
  if (attachments > 0) {
    lines.push(`${getString("notice-index-attached" as any) || "Markdown attached to items"}: ${attachments}`);
  }

  if (failed > 0) {
    type = "warning";
    lines.push(`${getString("notice-index-failed" as any) || "Failed items"}: ${failed}`);
  }

  // Reported apart from `failed` on purpose: the index itself is fine for
  // these items, their PDF is not. They did not fail the build, and they stay
  // queued for the next incremental pass, so the wording says what the user
  // can actually do about them.
  const bodyFailures = result?.bodyFailures ?? 0;
  if (bodyFailures > 0) {
    if (type === "success") type = "warning";
    lines.push(
      `${getString("notice-index-body-failed" as any) || "Indexed without full text (body parse failed)"}: ${bodyFailures} — ${
        getString("notice-index-body-failed-hint" as any) ||
        "title and abstract only; these are retried automatically and are excluded from full-text search"
      }`,
    );
  }

  if (minerUFailures > 0) {
    type = "warning";
    lines.push(
      `${getString("notice-mineru-failed" as any) || "MinerU could not parse"}: ${minerUFailures} — ${
        getString("notice-mineru-fallback" as any) || "fell back to built-in extraction"
      }`,
    );
    if (result?.minerULastError) {
      lines.push(truncateEnd(String(result.minerULastError), NOTICE_MAX_COLUMNS * 2));
    }
  }

  return { type, title, lines, sticky: isProblemNotice(type) };
}

export { getMinerUService };

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
