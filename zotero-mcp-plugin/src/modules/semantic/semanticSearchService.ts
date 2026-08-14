/**
 * Semantic Search Service for Zotero MCP Plugin
 *
 * Main service that orchestrates:
 * - Embedding generation (EmbeddingService)
 * - Vector storage and search (VectorStore)
 * - Text processing (TextChunker)
 * - Integration with existing Zotero services
 */

import { getEmbeddingService, EmbeddingService, EmbeddingAPIError, EmbeddingErrorType } from './embeddingService';
import {
  getVectorStore,
  VectorStore,
  type FailedIndexItem,
} from './vectorStore';
import { getTextChunker, TextChunker } from './textChunker';
import { TextFormatter } from '../textFormatter';
import { PDFProcessor } from '../pdfProcessor';
import {
  getMinerUService,
  getOriginalPDFAttachmentsForItem,
} from '../mineru';
import {
  getChunkingSignature,
  getHybridSearchSettings,
  invalidateStoredChunkingSignature,
  setStoredChunkingSignature,
  shouldRecordFullLibraryChunkingSignature,
} from '../hybridSearchSettings';
import { runIndexWorkQueue, type IndexWorkOutcome } from './indexBuildQueue';
import { groupFailedIndexItems } from './failedIndexRetry';

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

// Preference key for persisting index progress
const PREF_INDEX_PROGRESS = 'extensions.zotero.zotero-mcp-plugin.semantic.indexProgress';

/**
 * Body text longer than this is still indexed in full — it just takes a while,
 * so it is worth saying so in the log when an index run appears to stall.
 */
const HUGE_DOCUMENT_WARN_CHARS = 300000;

function warnIfHugeDocument(
  itemKey: string,
  length: number,
  source: string,
): void {
  if (length <= HUGE_DOCUMENT_WARN_CHARS) return;
  ztoolkit.log(
    `[SemanticSearch] ${itemKey}: ${source} body text is ${length} chars (>${HUGE_DOCUMENT_WARN_CHARS}). Indexing it completely, which will take noticeably longer and use more embedding quota for this item.`,
    'warn',
  );
}

// ============ Interfaces ============

export interface SemanticSearchOptions {
  topK?: number;              // Number of results
  exhaustive?: boolean;       // Return every distinct document
  includeChunkText?: boolean; // Hydrate text and metadata for returned rows
  minScore?: number;          // Minimum similarity threshold
  language?: 'zh' | 'en' | 'all' | 'auto';  // Language filter
  /**
   * Filled in by the search with how much of the index it actually touched.
   *
   * The caller needs it to report what narrowing the search to a set of
   * collections saved — a claim of "we only scanned the relevant part" is worth
   * nothing unless the number that proves it comes back with the results.
   */
  stats?: { chunksScanned?: number; chunksMatched?: number };
  itemKeys?: string[];        // Limit to specific items
  libraryID?: number;
  timeoutMs?: number;
  /** Deadline for vector scanning only; query embedding has its own timeout. */
  vectorScanTimeoutMs?: number;
  /**
   * Caller-owned cancellation. A timeout alone only stops the caller waiting;
   * the signal is what actually aborts the in-flight embedding request so
   * repeated queries cannot pile up background HTTP work.
   */
  signal?: AbortSignal;
}

export interface SemanticSearchResult {
  itemKey: string;
  libraryID: number;
  parentKey?: string;
  title: string;
  creators?: string;
  year?: number;
  itemType?: string;
  score: number;
  matchedChunks: Array<{
    chunkId: number;
    text: string;
    score: number;
    rowId?: number;
  }>;
}

export interface IndexProgress {
  total: number;
  processed: number;
  currentItem?: string;
  status: 'idle' | 'indexing' | 'paused' | 'completed' | 'failed' | 'error' | 'aborted' | 'busy';
  error?: string;
  errorType?: EmbeddingErrorType;  // Type of error for UI display
  errorRetryable?: boolean;        // Whether the error can be retried
  startTime?: number;
  estimatedRemaining?: number;
  failedCount?: number;            // Number of failed items
  skipped?: number;                // Items filtered out as already indexed
  indexed?: number;                // Items whose vectors were actually (re)written
  unchanged?: number;              // Items visited but left as-is (nothing changed)
  minerUFailures?: number;         // PDFs MinerU could not parse this run
  minerULastError?: string;        // Last MinerU error, for the notification
  minerUAttachments?: number;      // Markdown attachments written onto items this run
}

export interface SemanticServiceStats {
  indexStats: {
    totalVectors: number;
    totalItems: number;
    zhVectors: number;
    enVectors: number;
    cachedContentItems?: number;
    cachedContentSizeBytes?: number;
    dbSizeBytes?: number;
  };
  serviceStatus: {
    initialized: boolean;
    embeddingReady: boolean;
    fallbackMode: boolean;
  };
  indexProgress: IndexProgress;
}

// ============ Service Implementation ============

export class SemanticSearchService {
  private embeddingService: EmbeddingService;
  private vectorStore: VectorStore;
  private textChunker: TextChunker;

  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private indexProgress: IndexProgress = {
    total: 0,
    processed: 0,
    status: 'idle',
    failedCount: 0
  };

  // Pause/Resume control flags
  private _paused = false;
  private _aborted = false;
  private _pauseResolve: (() => void) | null = null;
  private _buildActive = false;
  /** Set for the duration of a forced build; read by extractItemContent */
  private _forceRun = false;
  private _activeBuildID: string | null = null;
  private _activeFullLibraryRebuild = false;

  // Error handling
  private _onErrorCallback?: (error: EmbeddingAPIError) => void;
  private _failedItems: Map<string, FailedIndexItem> = new Map();

  constructor() {
    ztoolkit.log(`[SemanticSearch] Constructor called`);
    this.embeddingService = getEmbeddingService();
    this.vectorStore = getVectorStore();
    this.textChunker = getTextChunker();
    ztoolkit.log(`[SemanticSearch] Obtained VectorStore instance`);
  }

  /**
   * Initialize the semantic search service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    const startTime = Date.now();
    ztoolkit.log('[SemanticSearch] Initializing...');

    try {
      // Load persisted index progress (for resuming after restart)
      this.loadIndexProgress();

      // Initialize vector store first (faster)
      await this.vectorStore.initialize();
      for (const failure of await this.vectorStore.getFailedItems()) {
        this._failedItems.set(
          `${failure.libraryID}:${failure.itemKey}`,
          failure,
        );
      }

      // Initialize embedding service (may take longer due to model loading)
      await this.embeddingService.initialize();

      this.initialized = true;
      const elapsed = Date.now() - startTime;
      ztoolkit.log(`[SemanticSearch] Initialized in ${elapsed}ms`);

    } catch (error) {
      ztoolkit.log(`[SemanticSearch] Initialization failed: ${error}`, 'error');
      throw error;
    }
  }

  /**
   * Load persisted index progress from preferences
   */
  private loadIndexProgress(): void {
    try {
      const progressJson = Zotero.Prefs.get(PREF_INDEX_PROGRESS, true);
      if (progressJson) {
        const saved = JSON.parse(String(progressJson));
        // Only restore if it was paused or indexing (not completed/idle)
        if (
          saved.status === 'paused' ||
          saved.status === 'indexing' ||
          saved.status === 'failed' ||
          saved.status === 'error'
        ) {
          this.indexProgress = {
            total: saved.total || 0,
            processed: saved.processed || 0,
            status: 'paused',  // Always show as paused after restart
            currentItem: saved.currentItem,
            startTime: saved.startTime,
            estimatedRemaining: saved.estimatedRemaining,
            failedCount: saved.failedCount || 0,
          };
          this._activeBuildID = saved.buildID || null;
          this._activeFullLibraryRebuild =
            saved.fullLibraryRebuild === true;
          this._paused = true;  // Mark as paused so it can be resumed
          ztoolkit.log(`[SemanticSearch] Restored paused index progress: ${this.indexProgress.processed}/${this.indexProgress.total}`);
        }
      }
    } catch (e) {
      ztoolkit.log(`[SemanticSearch] Failed to load index progress: ${e}`, 'warn');
    }
  }

  /**
   * Save index progress to preferences
   */
  private saveIndexProgress(): void {
    try {
      const toSave = {
        total: this.indexProgress.total,
        processed: this.indexProgress.processed,
        status: this.indexProgress.status,
        currentItem: this.indexProgress.currentItem,
        startTime: this.indexProgress.startTime,
        estimatedRemaining: this.indexProgress.estimatedRemaining,
        failedCount: this.indexProgress.failedCount ?? 0,
        buildID: this._activeBuildID,
        fullLibraryRebuild: this._activeFullLibraryRebuild,
      };
      Zotero.Prefs.set(PREF_INDEX_PROGRESS, JSON.stringify(toSave), true);
    } catch (e) {
      ztoolkit.log(`[SemanticSearch] Failed to save index progress: ${e}`, 'warn');
    }
  }

  /**
   * Clear persisted index progress
   */
  private clearSavedIndexProgress(): void {
    try {
      Zotero.Prefs.clear(PREF_INDEX_PROGRESS, true);
    } catch (e) {
      // Ignore errors
    }
  }

  // ============ Search Methods ============

  /**
   * Semantic search
   */
  async search(
    query: string,
    options: SemanticSearchOptions = {}
  ): Promise<SemanticSearchResult[]> {
    const startTime = Date.now();
    const {
      topK = 10,
      exhaustive = false,
      includeChunkText = true,
      minScore = 0.3,
      language = 'all',
      itemKeys,
      libraryID = Zotero.Libraries.userLibraryID,
      timeoutMs,
      vectorScanTimeoutMs,
      signal,
      stats,
    } = options;
    const deadlineAt = timeoutMs ? startTime + timeoutMs : undefined;
    // Own an internal controller even when the caller passed none, so the
    // deadline can abort the embedding request instead of orphaning it.
    const abortController =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const abortSearch = () => {
      try {
        abortController?.abort();
      } catch {
        // Aborting twice is harmless.
      }
    };
    if (signal) {
      if (signal.aborted) abortSearch();
      else signal.addEventListener('abort', abortSearch, { once: true });
    }
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      deadlineTimer = setTimeout(abortSearch, timeoutMs);
    }
    try {
      await this.initialize();
      if (deadlineAt && Date.now() >= deadlineAt) {
        throw new Error(`Semantic search timed out after ${timeoutMs}ms`);
      }
      ztoolkit.log(`[SemanticSearch] Searching: "${query.substring(0, 50)}..."`);

      try {
        // 1. Generate query embedding (isQuery=true for BGE instruction prefix)
        ztoolkit.log(`[SemanticSearch] Step 1: Generating query embedding...`);
        const embeddingStartedAt = Date.now();
        const queryEmbedding = await this.embeddingService.embed(
          query,
          'auto',
          true,
          { signal: abortController?.signal },
        );
        const embeddingMs = Date.now() - embeddingStartedAt;
        ztoolkit.log(
          `[SemanticSearch][Timing] embedding=${embeddingMs}ms libraryID=${libraryID}`,
        );
        if (deadlineAt && Date.now() >= deadlineAt) {
          throw new Error(`Semantic search timed out after ${timeoutMs}ms`);
        }
        ztoolkit.log(`[SemanticSearch] Query embedding: lang=${queryEmbedding.language}, dims=${queryEmbedding.dimensions}`);

        // 2. Vector search. "all" remains unfiltered; "auto" uses query language.
        const searchLanguage =
          language === 'auto' ? queryEmbedding.language : language;
        // Score chunks once, aggregate by document during the scan, and retain
        // lightweight references to each document's best evidence.
        const vectorStartedAt = Date.now();
        const vectorDeadlineAt =
          vectorScanTimeoutMs !== undefined
            ? Date.now() + vectorScanTimeoutMs
            : deadlineAt;
        const effectiveVectorDeadlineAt =
          deadlineAt !== undefined && vectorDeadlineAt !== undefined
            ? Math.min(deadlineAt, vectorDeadlineAt)
            : vectorDeadlineAt;
        let vectorScanMs = 0;
        let vectorResults: Awaited<
          ReturnType<typeof this.vectorStore.search>
        > = [];
        const scanStats: { scanned?: number } = {};
        let distinctItems = 0;
        try {
          vectorResults = await this.vectorStore.search(
            queryEmbedding.embedding,
            {
              groupByItem: true,
              documentLimit: exhaustive ? undefined : topK,
              maxChunksPerItem: 3,
              includeChunkText,
              language: searchLanguage,
              itemKeys,
              minScore,
              libraryID,
              deadlineAt: effectiveVectorDeadlineAt,
              signal: abortController?.signal,
              stats: scanStats,
            },
          );
          distinctItems = new Set(
            vectorResults.map(
              (result: any) => `${result.libraryID}:${result.itemKey}`,
            ),
          ).size;
          if (stats) {
            stats.chunksScanned = scanStats.scanned;
            stats.chunksMatched = vectorResults.length;
          }
        } finally {
          vectorScanMs = Date.now() - vectorStartedAt;
          ztoolkit.log(
            `[SemanticSearch][Timing] vectorScan=${vectorScanMs}ms libraryID=${libraryID}`,
          );
        }
        ztoolkit.log(
          `[SemanticSearch] Vector search returned ${vectorResults.length} chunk references -> ${distinctItems} distinct items`,
        );

        // 3. Aggregate by item
        const itemResultsMap = new Map<string, {
          itemKey: string;
          libraryID: number;
          chunks: Array<{ chunkId: number; text: string; score: number; rowId?: number }>;
          maxScore: number;
        }>();

        for (const result of vectorResults) {
          const identity = `${result.libraryID}:${result.itemKey}`;
          const existing = itemResultsMap.get(identity);
          if (existing) {
            existing.chunks.push({
              chunkId: result.chunkId,
              text: result.chunkText,
              score: result.score,
              rowId: result.rowId,
            });
            existing.maxScore = Math.max(existing.maxScore, result.score);
          } else {
            itemResultsMap.set(identity, {
              itemKey: result.itemKey,
              libraryID: result.libraryID,
              chunks: [{
                chunkId: result.chunkId,
                text: result.chunkText,
                score: result.score,
                rowId: result.rowId,
              }],
              maxScore: result.score
            });
          }
        }

        // 4. Pure semantic search (no hybrid)
        ztoolkit.log(`[SemanticSearch] Step 3: Aggregated into ${itemResultsMap.size} unique items`);

        let finalResults: SemanticSearchResult[] = Array.from(itemResultsMap.values())
          .sort((a, b) => b.maxScore - a.maxScore)
          .map(r => ({
            itemKey: r.itemKey,
            libraryID: r.libraryID,
            title: '',
            score: r.maxScore,
            matchedChunks: r.chunks.sort((a, b) => b.score - a.score).slice(0, 3)
          }));
        if (!exhaustive) finalResults = finalResults.slice(0, topK);

        if (includeChunkText) await this.fillItemMetadata(finalResults);

        const searchTime = Date.now() - startTime;
        ztoolkit.log(`[SemanticSearch] Found ${finalResults.length} results in ${searchTime}ms`);
        ztoolkit.log(
          `[SemanticSearch][Timing] embedding=${embeddingMs}ms vectorScan=${vectorScanMs}ms total=${searchTime}ms libraryID=${libraryID}`,
        );

        return finalResults;

      } catch (error) {
        ztoolkit.log(`[SemanticSearch] Search error: ${error}`, 'error');
        throw error;
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', abortSearch);
      // Nothing is waiting on this search any more; stop whatever still runs.
      abortSearch();
    }
  }

  /**
   * Chunk-level semantic search inside ONE document.
   *
   * Deliberately not `search()` with an itemKeys filter: that aggregates back
   * up to one row per item and keeps only three chunks, which is the opposite
   * of what a single-document deep dive needs. Everything else — the embedding
   * service, the vector store, the quantised scan, the language filter — is the
   * same code path the library-level search uses.
   */
  async searchItemChunks(
    query: string,
    options: {
      itemKey: string;
      libraryID?: number;
      topK: number;
      minScore?: number;
      language?: 'zh' | 'en' | 'all' | 'auto';
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<Array<{ chunkId: number; text: string; score: number }>> {
    const startTime = Date.now();
    const {
      itemKey,
      libraryID = Zotero.Libraries.userLibraryID,
      topK,
      // The vector-store cut-off stays generous: the fused threshold is what
      // decides relevance, and pre-filtering on the raw cosine here would drop
      // chunks that the keyword branch would have rescued.
      minScore = 0,
      language = 'all',
      timeoutMs,
      signal,
    } = options;
    const deadlineAt = timeoutMs ? startTime + timeoutMs : undefined;

    const abortController =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const abortSearch = () => {
      try {
        abortController?.abort();
      } catch {
        // Aborting twice is harmless.
      }
    };
    if (signal) {
      if (signal.aborted) abortSearch();
      else signal.addEventListener('abort', abortSearch, { once: true });
    }
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) deadlineTimer = setTimeout(abortSearch, timeoutMs);

    try {
      await this.initialize();
      if (deadlineAt && Date.now() >= deadlineAt) {
        throw new Error(`Semantic search timed out after ${timeoutMs}ms`);
      }

      const queryEmbedding = await this.embeddingService.embed(
        query,
        'auto',
        true,
        { signal: abortController?.signal },
      );
      if (deadlineAt && Date.now() >= deadlineAt) {
        throw new Error(`Semantic search timed out after ${timeoutMs}ms`);
      }

      const searchLanguage =
        language === 'auto' ? queryEmbedding.language : language;
      const vectorResults = await this.vectorStore.search(
        queryEmbedding.embedding,
        {
          topK,
          language: searchLanguage,
          itemKeys: [itemKey],
          minScore,
          libraryID,
          deadlineAt,
        },
      );

      ztoolkit.log(
        `[SemanticSearch] searchItemChunks(${itemKey}): ${vectorResults.length} chunks in ${Date.now() - startTime}ms`,
      );
      return vectorResults.map((result) => ({
        chunkId: result.chunkId,
        text: result.chunkText,
        score: result.score,
      }));
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', abortSearch);
      abortSearch();
    }
  }

  /** Every stored chunk of one document, in reading order. */
  async getItemChunks(
    itemKey: string,
    libraryID?: number,
  ): Promise<Array<{ chunkId: number; text: string; language: string }>> {
    await this.initialize();
    return this.vectorStore.getChunksForItem(itemKey, libraryID);
  }

  /** Hydrate only the chunk references carried by the page being returned. */
  async hydrateMatchedChunkTexts(
    results: Array<{ matchedChunks?: Array<{ rowId?: number; text?: string }> }>,
  ): Promise<void> {
    await this.initialize();
    const rowIDs = results.flatMap((result) =>
      (result.matchedChunks ?? [])
        .map((chunk) => chunk.rowId)
        .filter((rowID): rowID is number => typeof rowID === 'number'),
    );
    const texts = await this.vectorStore.getChunkTextsByRowIDs(rowIDs);
    for (const result of results) {
      for (const chunk of result.matchedChunks ?? []) {
        if (chunk.rowId !== undefined) {
          chunk.text = texts.get(chunk.rowId) ?? '';
        }
      }
    }
  }

  /**
   * Find similar items
   */
  async findSimilar(
    itemKey: string,
    options: {
      topK?: number;
      minScore?: number;
      libraryID?: number;
      timeoutMs?: number;
    } = {}
  ): Promise<SemanticSearchResult[]> {
    const startTime = Date.now();
    const deadlineAt = options.timeoutMs
      ? startTime + options.timeoutMs
      : undefined;
    await this.initialize();

    const {
      topK = 5,
      minScore = 0.3,
      libraryID = Zotero.Libraries.userLibraryID,
      timeoutMs,
    } = options;
    if (deadlineAt && Date.now() >= deadlineAt) {
      throw new Error(`Similarity search timed out after ${timeoutMs}ms`);
    }

    try {
      // Get item's vectors
      const itemVectors = await this.vectorStore.getItemVectors(itemKey, libraryID);

      if (itemVectors.length === 0) {
        ztoolkit.log(`[SemanticSearch] Item ${itemKey} not indexed`);
        return [];
      }

      // Use first chunk vector as query (or could average all)
      const queryVector = itemVectors[0].vector;

      // Search for similar
      const results = await this.vectorStore.search(queryVector, {
        topK: topK + 1,
        minScore,
        libraryID,
        deadlineAt,
      });

      // Filter out the source item and map results
      const filteredResults = results
        .filter(r => r.itemKey !== itemKey)
        .slice(0, topK)
        .map(r => ({
          itemKey: r.itemKey,
          libraryID: r.libraryID,
          title: '',
          score: r.score,
          matchedChunks: [{
            chunkId: r.chunkId,
            text: r.chunkText,
            score: r.score
          }]
        }));

      // Fill metadata
      await this.fillItemMetadata(filteredResults);

      return filteredResults;

    } catch (error) {
      ztoolkit.log(`[SemanticSearch] findSimilar error: ${error}`, 'error');
      throw error;
    }
  }

  // ============ Indexing Methods ============

  /**
   * Build or update the semantic index
   */
  async buildIndex(options: {
    itemKeys?: string[];
    libraryID?: number;
    rebuild?: boolean;
    /**
     * Index the given itemKeys even if they are already in index_status,
     * without clearing the whole store the way rebuild does. Used by every
     * path that targets specific items the user or the notifier just touched.
     */
    force?: boolean;
    onProgress?: (progress: IndexProgress) => void;
    resumeBuildID?: string;
    resumeFullLibraryRebuild?: boolean;
    frozenChunkSettings?: {
      target: number;
      tolerance: number;
      signature: string;
    };
  } = {}): Promise<IndexProgress> {
    await this.initialize();

    const itemKeysProvided = options.itemKeys !== undefined;
    const {
      itemKeys,
      libraryID = Zotero.Libraries.userLibraryID,
      rebuild = false,
      force = false,
      onProgress,
      resumeBuildID,
      resumeFullLibraryRebuild = false,
      frozenChunkSettings,
    } = options;

    if (this._buildActive) {
      ztoolkit.log('[SemanticSearch] buildIndex already running, ignoring duplicate call', 'warn');
      // Return a copy with a distinct status so callers can tell this apart
      // from a completed build and avoid showing bogus "completed" messages
      return { ...this.indexProgress, status: 'busy' };
    }
    this._buildActive = true;

    try {
      // Reset control flags
      this._paused = false;
      this._aborted = false;
      this._pauseResolve = null;
      // Only one build runs at a time (guarded by _buildActive), so a field is
      // enough to reach extractItemContent without threading force through
      // every call in between.
      this._forceRun = force;
      getMinerUService().resetRunStats();

      this.indexProgress = {
        total: 0,
        processed: 0,
        indexed: 0,
        unchanged: 0,
        failedCount: 0,
        status: 'indexing',
        startTime: Date.now()
      };

      const fullLibraryRebuild = rebuild && !itemKeysProvided;
      const targetedRebuild = rebuild && itemKeysProvided;
      const fullLibraryBuild =
        fullLibraryRebuild || resumeFullLibraryRebuild;
      const hybridSettings = getHybridSearchSettings();
      const chunkSettings = frozenChunkSettings ?? {
        target: hybridSettings.chunkTargetChars,
        tolerance: hybridSettings.chunkAppendToleranceChars,
        signature: getChunkingSignature(hybridSettings),
      };
      this.textChunker = new TextChunker({
        targetChunkSize: chunkSettings.target,
        appendToleranceSize: chunkSettings.tolerance,
      });

      // Only a true full-library rebuild may replace incompatible dimensions.
      if (!fullLibraryBuild) {
        const dimensionCheck = await this.checkDimensionCompatibility();
        if (!dimensionCheck.compatible) {
          ztoolkit.log(`[SemanticSearch] Dimension mismatch detected: stored=${dimensionCheck.storedDimensions}, current=${dimensionCheck.currentDimensions}`, 'warn');
          this.indexProgress.status = 'error';
          this.indexProgress.error = dimensionCheck.message;
          this.indexProgress.errorType = 'config';
          this.indexProgress.errorRetryable = false;
          onProgress?.(this.indexProgress);
          return this.indexProgress;
        }
      }

      // Get items to index
      let items: any[];
      if (itemKeysProvided) {
        items = [];
        for (const key of itemKeys ?? []) {
          const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
          items.push(item ?? { key, libraryID, __missing: true });
        }
      } else {
        items = await this.getItemsWithContent(libraryID);
      }

      const totalLibraryItems = items.length;
      ztoolkit.log(`[SemanticSearch] Library items fetched: ${totalLibraryItems}`);

      const buildID =
        resumeBuildID ??
        `${Date.now()}-${libraryID}-${Math.random().toString(36).slice(2, 10)}`;
      this._activeBuildID = buildID;
      this._activeFullLibraryRebuild = fullLibraryBuild;
      const createNewBuildSession = async () => {
        await this.vectorStore.createBuildSession(
          {
            buildID,
            libraryID,
            scope: fullLibraryRebuild
              ? 'full-library'
              : itemKeysProvided
                ? targetedRebuild
                  ? 'targeted'
                  : 'incremental'
                : 'incremental',
            status: 'indexing',
            chunkSignature: fullLibraryRebuild
              ? chunkSettings.signature
              : undefined,
            chunkTargetChars: fullLibraryRebuild
              ? chunkSettings.target
              : undefined,
            chunkAppendToleranceChars: fullLibraryRebuild
              ? chunkSettings.tolerance
              : undefined,
            createdAt: Date.now(),
          },
          items.map((item) => ({
            libraryID: item.libraryID ?? libraryID,
            itemKey: item.key,
          })),
        );
      };
      if (!resumeBuildID && fullLibraryRebuild) {
        await createNewBuildSession();
      }

      if (this._activeFullLibraryRebuild) {
        const existingSession = resumeBuildID
          ? await this.vectorStore.getBuildSession(buildID)
          : null;
        if (!existingSession?.resetCompleted) {
          // The target snapshot is durable before invalidation. The SQLite
          // clear and reset flag commit together, so recovery either performs
          // this once or sees that it has already committed.
          this.indexProgress.total = items.length;
          this.saveIndexProgress();
          invalidateStoredChunkingSignature(libraryID);
          await this.vectorStore.clearLibraryForBuild(buildID, libraryID);
          for (const [identity, failure] of this._failedItems) {
            if (failure.libraryID === libraryID) {
              this._failedItems.delete(identity);
            }
          }
          ztoolkit.log(
            `[SemanticSearch] Existing index data cleared for libraryID=${libraryID}`,
          );
        }
      }

      // Filter already indexed items (unless rebuild or an explicit force)
      if (targetedRebuild) {
        this.indexProgress.skipped = 0;
        ztoolkit.log(
          `[SemanticSearch] Targeted rebuild: ${itemKeys?.length ?? 0} items in libraryID=${libraryID} will be replaced atomically`,
        );
      } else if (!rebuild && !force) {
        if (itemKeysProvided) {
          // The caller named these items, so "already in index_status" is not a
          // reason to skip them — that filter is what made
          // needsReindexByTimestamp dead code for every indexed item: the item
          // was dropped here and indexItemWithProcessor never saw it, so an
          // edited title/abstract/attachment could never be picked up.
          // Let them through and rely on the per-item timestamp + content-hash
          // checks, which re-index only what actually changed. Nothing is
          // re-embedded when the timestamps match.
          this.indexProgress.skipped = 0;
          ztoolkit.log(`[SemanticSearch] Targeted incremental: ${items.length} requested items pass the index_status filter; per-item timestamp/hash checks decide what is re-indexed`);
        } else {
          const skipSet = await this.vectorStore.getItemsToSkip(libraryID);
          const indexedCount = skipSet.size;
          items = items.filter(item => !skipSet.has(item.key));
          this.indexProgress.skipped = totalLibraryItems - items.length;
          ztoolkit.log(`[SemanticSearch] Items: library=${totalLibraryItems}, indexed=${indexedCount}, toIndex=${items.length}, skipped=${this.indexProgress.skipped}`);
        }
      } else if (force && !fullLibraryRebuild) {
        this.indexProgress.skipped = 0;
        ztoolkit.log(`[SemanticSearch] Force mode: re-indexing all ${items.length} requested items, ignoring index_status`);
      } else if (fullLibraryRebuild) {
        this.indexProgress.skipped = 0;
      }

      if (!resumeBuildID && !fullLibraryRebuild) {
        await createNewBuildSession();
      }

      this.indexProgress.total = items.length;
      onProgress?.(this.indexProgress);

      if (items.length === 0) {
        this.indexProgress.minerUFailures = 0;
        this.indexProgress.minerUAttachments = 0;
        await this.reconcileFullLibraryBuildTargets(buildID, libraryID);
        const journal = await this.vectorStore.getBuildTargetSummary(buildID);
        if (this._activeFullLibraryRebuild) {
          this.indexProgress.total = journal.total;
          this.indexProgress.processed = journal.succeeded + journal.failed;
        }
        this.indexProgress.status =
          journal.succeeded === journal.total ? 'completed' : 'failed';
        this.indexProgress.failedCount = journal.failed;
        if (
          shouldRecordFullLibraryChunkingSignature({
            rebuild: this._activeFullLibraryRebuild,
            itemKeysProvided: false,
            status: this.indexProgress.status,
            processed: journal.succeeded,
            total: journal.total,
            failedCount: journal.failed,
          })
        ) {
          setStoredChunkingSignature(libraryID, chunkSettings.signature);
        }
        await this.vectorStore.updateBuildSessionStatus(
          buildID,
          this.indexProgress.status,
        );
        if (this.indexProgress.status === 'completed') {
          this.clearSavedIndexProgress();
        } else {
          this.saveIndexProgress();
        }
        return this.indexProgress;
      }

      ztoolkit.log(`[SemanticSearch] Indexing ${items.length} items...`);

      // Create a pool of PDFProcessors for true parallel processing
      const concurrency = 5;  // Process 5 items in parallel
      const processorPool: PDFProcessor[] = [];
      for (let p = 0; p < concurrency; p++) {
        processorPool.push(new PDFProcessor(ztoolkit));
      }
      ztoolkit.log(`[SemanticSearch] Created ${concurrency} PDFProcessor workers for parallel processing`);

      try {
        const queueResult = await runIndexWorkQueue({
          items,
          concurrency,
          isPaused: () => this._paused,
          isAborted: () => this._aborted,
          waitWhilePaused: async () => {
            onProgress?.(this.indexProgress);
            await this.waitWhilePaused();
            if (!this._aborted) {
              this.indexProgress.status = 'indexing';
              this.indexProgress.error = undefined;
              this.indexProgress.errorType = undefined;
              this.indexProgress.errorRetryable = undefined;
            }
          },
          processItem: async (item, workerIndex): Promise<IndexWorkOutcome> => {
            this.indexProgress.currentItem = item.key;
            if (item.__missing) {
              const error = new Error(
                `Item ${item.key} was not found in libraryID=${libraryID}`,
              );
              await this.recordFailedItem(item, error, 'unknown');
              return { status: 'failed', error };
            }
            try {
              return await this.indexItemWithProcessor(
                item,
                processorPool[workerIndex % processorPool.length],
                force || targetedRebuild,
              );
            } catch (error) {
              if (error instanceof EmbeddingAPIError) {
                if (error.type === 'paused') {
                  return { status: 'incomplete' };
                }
                const isGlobalError =
                  error.type === 'auth' ||
                  error.type === 'config' ||
                  error.type === 'network' ||
                  error.type === 'rate_limit' ||
                  error.type === 'server';
                if (isGlobalError) {
                  this.indexProgress.error = error.getUserMessage();
                  this.indexProgress.errorType = error.type;
                  this.indexProgress.errorRetryable = error.retryable;
                  this._paused = true;
                  this.indexProgress.status = 'paused';
                  await this.vectorStore.updateBuildSessionStatus(buildID, 'paused');
                  this.saveIndexProgress();
                  this._onErrorCallback?.(error);
                  onProgress?.(this.indexProgress);
                  return { status: 'incomplete' };
                }
                await this.recordFailedItem(item, error, error.type);
                return { status: 'failed', error };
              }
              await this.recordFailedItem(item, error, 'unknown');
              return { status: 'failed', error };
            }
          },
          onSettled: async (item, outcome) => {
            if (outcome.status !== 'succeeded') return;
            const identity = {
              libraryID: item.libraryID ?? libraryID,
              itemKey: item.key,
            };
            await this.vectorStore.updateBuildTarget(buildID, identity, 'succeeded');
            await this.vectorStore.clearFailedItems([identity]);
            this._failedItems.delete(`${identity.libraryID}:${identity.itemKey}`);
          },
          onProgress: (progress) => {
            this.indexProgress.processed = progress.processed;
            this.indexProgress.failedCount = progress.failedCount;
            const elapsed = Date.now() - (this.indexProgress.startTime || 0);
            if (progress.processed > 0) {
              this.indexProgress.estimatedRemaining =
                (elapsed / progress.processed) *
                (this.indexProgress.total - progress.processed);
            }
            this.saveIndexProgress();
            onProgress?.(this.indexProgress);
          },
        });
        this.indexProgress.processed = queueResult.processed;
        this.indexProgress.failedCount = queueResult.failedCount;
        this.indexProgress.status = queueResult.status;
      } finally {
        // Clean up all processors in the pool
        for (const processor of processorPool) {
          processor.terminate();
        }
        ztoolkit.log(`[SemanticSearch] Terminated ${processorPool.length} PDFProcessor workers`);
      }

      const minerUStats = getMinerUService().getRunStats();
      this.indexProgress.minerUFailures = minerUStats.failures;
      this.indexProgress.minerULastError = minerUStats.lastError;
      this.indexProgress.minerUAttachments = minerUStats.attachments;

      await this.reconcileFullLibraryBuildTargets(buildID, libraryID);
      const journal = await this.vectorStore.getBuildTargetSummary(buildID);
      if (this._activeFullLibraryRebuild) {
        this.indexProgress.total = journal.total;
        this.indexProgress.processed = Math.max(
          this.indexProgress.processed,
          journal.succeeded + journal.failed,
        );
        this.indexProgress.failedCount = Math.max(
          this.indexProgress.failedCount ?? 0,
          journal.failed,
        );
      }
      if (
        this.indexProgress.status === 'completed' &&
        journal.succeeded !== journal.total
      ) {
        this.indexProgress.status = 'failed';
        this.indexProgress.failedCount = Math.max(
          this.indexProgress.failedCount ?? 0,
          journal.failed,
        );
      }

      if (this.indexProgress.status === 'completed') {
        if (
          shouldRecordFullLibraryChunkingSignature({
            rebuild: this._activeFullLibraryRebuild,
            itemKeysProvided: false,
            status: this.indexProgress.status,
            processed: journal.succeeded,
            total: journal.total,
            failedCount: journal.failed,
          })
        ) {
          setStoredChunkingSignature(libraryID, chunkSettings.signature);
        }
        await this.vectorStore.updateBuildSessionStatus(buildID, 'completed');
        this.clearSavedIndexProgress();
      } else if (this.indexProgress.status === 'failed') {
        await this.vectorStore.updateBuildSessionStatus(buildID, 'failed');
        this.saveIndexProgress();
      } else if (this.indexProgress.status === 'aborted') {
        await this.vectorStore.updateBuildSessionStatus(buildID, 'aborted');
      }
      onProgress?.(this.indexProgress);

      ztoolkit.log(`[SemanticSearch] Indexing finished: ${this.indexProgress.processed} items, status=${this.indexProgress.status}`);
      return this.indexProgress;

    } catch (error) {
      this.indexProgress.status = 'error';
      this.indexProgress.error = String(error);
      if (this._activeBuildID) {
        try {
          await this.vectorStore.updateBuildSessionStatus(
            this._activeBuildID,
            'failed',
          );
        } catch (journalError) {
          ztoolkit.log(
            `[SemanticSearch] Could not mark build journal failed: ${journalError}`,
            'warn',
          );
        }
        this.saveIndexProgress();
      }
      ztoolkit.log(`[SemanticSearch] Indexing failed: ${error}`, 'error');
      throw error;
    } finally {
      this._buildActive = false;
      this._forceRun = false;
      this._activeBuildID = null;
      this._activeFullLibraryRebuild = false;
    }
  }

  /**
   * Index a single item (creates its own PDFProcessor)
   */
  async indexItem(item: any): Promise<void> {
    await this.indexItemWithProcessor(item, null);
  }

  /**
   * Index a single item with optional shared PDFProcessor
   *
   * @param force Re-read the item from disk even when nothing looks changed.
   *   The two fast paths below (timestamp match, cached extraction) exist to
   *   keep incremental builds cheap, but they answer "has the *item* changed?"
   *   and not "would extraction produce something different now?" — which is
   *   exactly what changes when MinerU is switched on, its options are edited,
   *   or a previous parse failed. A forced run is the user asking us to look
   *   again, so both fast paths must be off, otherwise the build reports
   *   "finished N/N" without ever opening a single PDF.
   */
  async indexItemWithProcessor(
    item: any,
    sharedProcessor: PDFProcessor | null,
    force: boolean = this._forceRun,
  ): Promise<IndexWorkOutcome> {
    const startTime = Date.now();
    const itemTitle = item.getDisplayTitle?.() || item.key;
    ztoolkit.log(`[SemanticSearch] indexItem() start: ${item.key} "${itemTitle.substring(0, 30)}..."`);

    // Get timestamps for fast change detection
    const itemModified = item.dateModified || '';
    let attachmentModified = '';

    // Get latest attachment modification time
    if (item.isRegularItem?.()) {
      const attachmentIds = item.getAttachments?.() || [];
      for (const attId of attachmentIds) {
        try {
          const att = await Zotero.Items.getAsync(attId);
          if (att?.dateModified && att.dateModified > attachmentModified) {
            attachmentModified = att.dateModified;
          }
        } catch (e) {
          // Skip failed attachments
        }
      }
    }

    // Fast check: if timestamps haven't changed, skip entirely (no content extraction needed)
    const needsCheckByTimestamp = await this.vectorStore.needsReindexByTimestamp(
      item.key, itemModified, attachmentModified, item.libraryID
    );
    if (!needsCheckByTimestamp && !force) {
      this.indexProgress.unchanged = (this.indexProgress.unchanged || 0) + 1;
      ztoolkit.log(`[SemanticSearch] indexItem() skip: timestamps unchanged for ${item.key}`);
      return { status: 'succeeded' };
    }
    if (!needsCheckByTimestamp && force) {
      ztoolkit.log(`[SemanticSearch] indexItem() force: timestamps unchanged for ${item.key}, re-extracting anyway`);
    }

    // Check for pause before content extraction
    if (this._paused || this._aborted) {
      ztoolkit.log(`[SemanticSearch] indexItem() paused/aborted before content extraction: ${item.key}`);
      return { status: 'incomplete' };
    }

    // Extract content (PDF extraction happens here)
    const content = await this.extractItemContent(item, sharedProcessor);
    if (!content.trim()) {
      await this.vectorStore.replaceItemIndex({
        itemKey: item.key,
        libraryID: item.libraryID,
        records: [],
        contentHash: 'empty',
        contentLength: 0,
        sourceKind: 'zotero-markdown-on-demand',
        itemModified,
        attachmentModified,
        buildID: this._activeBuildID ?? undefined,
      });
      ztoolkit.log(`[SemanticSearch] indexItem() skip: no content for ${item.key}, marked in index_status to avoid retry loop`);
      return { status: 'succeeded' };
    }
    ztoolkit.log(`[SemanticSearch] indexItem() extracted content: ${content.length} chars`);

    // Check for pause after content extraction (before embedding)
    if (this._paused || this._aborted) {
      ztoolkit.log(`[SemanticSearch] indexItem() paused/aborted after content extraction: ${item.key}`);
      return { status: 'incomplete' };
    }

    // Calculate content hash
    const contentHash = this.hashContent(content);

    // Check if content actually changed (compare with stored hash)
    const needsIndex = await this.vectorStore.needsReindex(
      item.key,
      contentHash,
      item.libraryID,
    );
    if (!needsIndex) {
      // Content hash unchanged, just update timestamps
      const status = await this.vectorStore.getIndexStatus(
        item.key,
        item.libraryID,
      );
      if (status) {
          await this.vectorStore.updateIndexStatus(
            item.key, status.chunkCount, contentHash, itemModified, attachmentModified,
            item.libraryID,
            content.length,
            'zotero-markdown-on-demand',
        );
      }
      this.indexProgress.unchanged = (this.indexProgress.unchanged || 0) + 1;
      ztoolkit.log(`[SemanticSearch] indexItem() skip: content unchanged, updated timestamps`);
      return { status: 'succeeded' };
    }

    // Chunk the content
    const chunks = this.textChunker.chunk(content);
    if (chunks.length === 0) {
      throw new Error(`No chunks generated for ${item.key}`);
    }
    ztoolkit.log(`[SemanticSearch] indexItem() chunked into ${chunks.length} chunks`);

    // Generate embeddings with pause check
    const batchItems = chunks.map((chunk, idx) => ({
      id: `${item.key}_${idx}`,
      text: chunk
    }));

    const embeddings = await this.embeddingService.embedBatch(batchItems, {
      onPauseCheck: () => this._paused || this._aborted
    });
    ztoolkit.log(`[SemanticSearch] indexItem() generated ${embeddings.size} embeddings`);

    if (this._paused || this._aborted) {
      return { status: 'incomplete' };
    }
    if (embeddings.size !== chunks.length) {
      throw new Error(
        `Incomplete embeddings for ${item.key}: ${embeddings.size}/${chunks.length}`,
      );
    }

    // Store vectors
    const records = chunks.map((chunk, idx) => {
      const embedding = embeddings.get(`${item.key}_${idx}`);
      if (!embedding) return null;

      return {
        itemKey: item.key,
        libraryID: item.libraryID,
        chunkId: idx,
        vector: embedding.embedding,
        language: embedding.language,
        chunkText: chunk  // Store full chunk (max ~450 chars from TextChunker)
      };
    }).filter(r => r !== null) as any[];

    await this.vectorStore.replaceItemIndex({
      itemKey: item.key,
      libraryID: item.libraryID,
      records,
      contentHash,
      contentLength: content.length,
      sourceKind: 'zotero-markdown-on-demand',
      itemModified,
      attachmentModified,
      buildID: this._activeBuildID ?? undefined,
    });

    this.indexProgress.indexed = (this.indexProgress.indexed || 0) + 1;

    const elapsed = Date.now() - startTime;
    if (records.length < chunks.length) {
      ztoolkit.log(`[SemanticSearch] indexItem() ${item.key}: ${chunks.length - records.length}/${chunks.length} chunks skipped (oversized)`, 'warn');
    }
    ztoolkit.log(`[SemanticSearch] indexItem() completed: ${item.key} (${records.length} vectors) in ${elapsed}ms`);
    return { status: 'succeeded' };
  }

  /**
   * Delete index for an item
   */
  async deleteItemIndex(itemKey: string, libraryID?: number): Promise<void> {
    await this.initialize();
    await this.vectorStore.deleteItemVectors(itemKey, libraryID);
    ztoolkit.log(`[SemanticSearch] Deleted index for item: ${itemKey} (libraryID=${libraryID ?? 'user'})`);
  }

  /**
   * Clear indexes. Pass a libraryID to clear only that library.
   */
  async clearIndex(libraryID?: number): Promise<void> {
    await this.initialize();
    await this.vectorStore.clear(libraryID);
    ztoolkit.log(`[SemanticSearch] Index cleared (libraryID=${libraryID ?? 'all'})`);
  }

  // ============ Status Methods ============

  /**
   * Get service statistics
   */
  async getStats(): Promise<SemanticServiceStats> {
    await this.initialize();

    const indexStats = await this.vectorStore.getStats();
    const embeddingStatus = this.embeddingService.getStatus();

    // Log comparison: library items vs indexed items
    try {
      const libraryItems = await this.getItemsWithContent();
      const indexedItems = await this.vectorStore.getIndexedItems();
      ztoolkit.log(`[SemanticSearch] Stats: libraryItems=${libraryItems.length}, indexedItems=${indexedItems.size}, vectors=${indexStats.totalVectors}, diff=${libraryItems.length - indexedItems.size}`);
    } catch (e) {
      // Non-critical, don't block stats
    }

    return {
      indexStats,
      serviceStatus: {
        initialized: this.initialized,
        embeddingReady: embeddingStatus.initialized,
        fallbackMode: this.embeddingService.isFallbackMode()
      },
      indexProgress: this.indexProgress
    };
  }

  /**
   * Get current index progress
   */
  getIndexProgress(): IndexProgress {
    return { ...this.indexProgress };
  }

  async resumeInterruptedBuild(
    onProgress?: (progress: IndexProgress) => void,
  ): Promise<IndexProgress> {
    await this.initialize();
    if (this._buildActive) {
      this.resumeIndex();
      return { ...this.indexProgress, status: 'busy' };
    }
    const session = await this.vectorStore.getResumableBuildSession();
    if (!session) {
      return {
        ...this.indexProgress,
        total: 0,
        processed: 0,
        failedCount: 0,
        status: 'completed',
      };
    }
    const targets = (await this.vectorStore.getBuildTargets(session.buildID))
      .filter((target) => target.state !== 'succeeded');
    this._paused = false;
    this.indexProgress.status = 'indexing';
    return this.buildIndex({
      itemKeys: targets.map((target) => target.itemKey),
      libraryID: session.libraryID,
      rebuild: false,
      force: session.scope === 'targeted',
      resumeBuildID: session.buildID,
      resumeFullLibraryRebuild: session.scope === 'full-library',
      frozenChunkSettings:
        session.chunkSignature &&
        session.chunkTargetChars !== undefined &&
        session.chunkAppendToleranceChars !== undefined
          ? {
              target: session.chunkTargetChars,
              tolerance: session.chunkAppendToleranceChars,
              signature: session.chunkSignature,
            }
          : undefined,
      onProgress,
    });
  }

  private async reconcileFullLibraryBuildTargets(
    buildID: string,
    libraryID: number,
  ): Promise<void> {
    if (!this._activeFullLibraryRebuild) return;
    const [currentItems, targets] = await Promise.all([
      this.getItemsWithContent(libraryID),
      this.vectorStore.getBuildTargets(buildID),
    ]);
    const known = new Set(
      targets.map((target) => `${target.libraryID}:${target.itemKey}`),
    );
    const missing = currentItems
      .map((item) => ({
        libraryID: item.libraryID ?? libraryID,
        itemKey: item.key,
      }))
      .filter(
        (identity) =>
          !known.has(`${identity.libraryID}:${identity.itemKey}`),
      );
    if (missing.length > 0) {
      await this.vectorStore.addBuildTargets(buildID, missing);
      ztoolkit.log(
        `[SemanticSearch] Full-Library reconciliation added ${missing.length} new pending targets`,
        'warn',
      );
    }
  }

  /**
   * Pause the indexing process
   */
  pauseIndex(): void {
    if (this.indexProgress.status === 'indexing') {
      this._paused = true;
      this.indexProgress.status = 'paused';
      this.saveIndexProgress();  // Persist paused state
      if (this._activeBuildID) {
        void this.vectorStore.updateBuildSessionStatus(
          this._activeBuildID,
          'paused',
        );
      }
      ztoolkit.log('[SemanticSearch] Index paused');
    }
  }

  /**
   * Resume the indexing process
   */
  resumeIndex(): void {
    if (this.indexProgress.status === 'paused' && this._paused) {
      this._paused = false;
      this.indexProgress.status = 'indexing';
      this.saveIndexProgress();  // Update persisted state
      if (this._pauseResolve) {
        this._pauseResolve();
        this._pauseResolve = null;
      }
      ztoolkit.log('[SemanticSearch] Index resumed');
    }
  }

  /**
   * Abort the indexing process
   */
  abortIndex(): void {
    if (this.indexProgress.status === 'indexing' || this.indexProgress.status === 'paused') {
      this._aborted = true;
      this._paused = false;
      this.indexProgress.status = 'aborted';
      this.clearSavedIndexProgress();  // Clear persisted state on abort
      if (this._activeBuildID) {
        void this.vectorStore.updateBuildSessionStatus(
          this._activeBuildID,
          'aborted',
        );
      }
      // Release pause lock if paused
      if (this._pauseResolve) {
        this._pauseResolve();
        this._pauseResolve = null;
      }
      ztoolkit.log('[SemanticSearch] Index aborted');
    }
  }

  /**
   * Check if indexing is paused
   */
  isPaused(): boolean {
    return this._paused;
  }

  /**
   * Whether a buildIndex run is currently in flight (including parked in a
   * paused state waiting for resume)
   */
  isBuildActive(): boolean {
    return this._buildActive;
  }

  /**
   * Set callback for indexing errors
   * Called when an error occurs during indexing (auto-pauses)
   */
  setOnIndexError(callback: (error: EmbeddingAPIError) => void): void {
    this._onErrorCallback = callback;
  }

  /**
   * Get failed items list
   */
  getFailedItems(): Array<{
    libraryID: number;
    itemKey: string;
    error: string;
    errorType: EmbeddingErrorType;
    timestamp: number;
    buildID?: string;
  }> {
    return Array.from(this._failedItems.values()).map((item) => ({
      ...item,
      errorType: item.errorType as EmbeddingErrorType,
    }));
  }

  /**
   * Clear failed items list
   */
  clearFailedItems(): void {
    this._failedItems.clear();
    this.indexProgress.failedCount = 0;
  }

  /** Record a Library-qualified failure in memory and in index_failures. */
  private async recordFailedItem(
    item: any,
    error: unknown,
    errorType: EmbeddingErrorType,
  ): Promise<void> {
    const failure: FailedIndexItem = {
      libraryID: item.libraryID ?? Zotero.Libraries.userLibraryID,
      itemKey: item.key,
      error:
        error instanceof EmbeddingAPIError
          ? error.getUserMessage()
          : error instanceof Error
            ? error.message
            : String(error),
      errorType,
      timestamp: Date.now(),
      buildID: this._activeBuildID ?? undefined,
    };
    this._failedItems.set(
      `${failure.libraryID}:${failure.itemKey}`,
      failure,
    );
    this.indexProgress.failedCount = this._failedItems.size;
    try {
      await this.vectorStore.recordFailedItem(failure);
    } catch (e) {
      ztoolkit.log(`[SemanticSearch] Could not persist failure marker for ${item.key}: ${e}`, 'warn');
    }
  }

  /**
   * Retry failed items (both in-memory failures from this session and
   * failure markers persisted by previous runs)
   */
  async retryFailedItems(onProgress?: (progress: IndexProgress) => void): Promise<IndexProgress> {
    await this.initialize();

    // Check BEFORE clearing failure markers: if another build is running,
    // buildIndex would reject the nested call after the bookkeeping was
    // already wiped, losing the failure records without retrying anything
    if (this._buildActive) {
      ztoolkit.log('[SemanticSearch] retryFailedItems: a build is already running', 'warn');
      return { ...this.indexProgress, status: 'busy' };
    }

    const failures = new Map<string, FailedIndexItem>();
    for (const failure of await this.vectorStore.getFailedItems()) {
      failures.set(`${failure.libraryID}:${failure.itemKey}`, failure);
    }
    for (const failure of this._failedItems.values()) {
      failures.set(`${failure.libraryID}:${failure.itemKey}`, failure);
    }
    if (failures.size === 0) {
      ztoolkit.log('[SemanticSearch] No failed items to retry');
      return { ...this.indexProgress, total: 0, processed: 0, failedCount: 0, status: 'completed' };
    }

    ztoolkit.log(`[SemanticSearch] Retrying ${failures.size} failed items`);

    const merged: IndexProgress = {
      total: 0,
      processed: 0,
      failedCount: 0,
      indexed: 0,
      unchanged: 0,
      status: 'completed',
    };
    for (const group of groupFailedIndexItems(failures.values())) {
      const first = group[0];
      const session = first.buildID
        ? await this.vectorStore.getBuildSession(first.buildID)
        : null;
      const result = await this.buildIndex({
        itemKeys: group.map((failure) => failure.itemKey),
        libraryID: first.libraryID,
        rebuild: false,
        force: true,
        resumeBuildID: session?.buildID,
        resumeFullLibraryRebuild: session?.scope === 'full-library',
        frozenChunkSettings:
          session?.chunkSignature &&
          session.chunkTargetChars !== undefined &&
          session.chunkAppendToleranceChars !== undefined
            ? {
                target: session.chunkTargetChars,
                tolerance: session.chunkAppendToleranceChars,
                signature: session.chunkSignature,
              }
            : undefined,
        onProgress,
      });
      merged.total += result.total;
      merged.processed += result.processed;
      merged.failedCount =
        (merged.failedCount ?? 0) + (result.failedCount ?? 0);
      merged.indexed = (merged.indexed ?? 0) + (result.indexed ?? 0);
      merged.unchanged =
        (merged.unchanged ?? 0) + (result.unchanged ?? 0);
      if (result.status !== 'completed') merged.status = result.status;
    }
    return merged;
  }

  /**
   * Wait while paused
   * Uses a while loop to handle race conditions where resume might be called
   * before the loop enters this function, or if the promise is resolved unexpectedly
   */
  private async waitWhilePaused(): Promise<void> {
    while (this._paused && !this._aborted) {
      await new Promise<void>(resolve => {
        this._pauseResolve = resolve;
      });
    }
  }

  /**
   * Check dimension compatibility between stored vectors and current embedding config
   * Returns an object indicating if they are compatible and details about the mismatch
   */
  async checkDimensionCompatibility(): Promise<{
    compatible: boolean;
    storedDimensions: number | null;
    currentDimensions: number | null;
    message?: string;
  }> {
    try {
      // Get stored dimensions from vector store
      const stats = await this.vectorStore.getStats();
      const storedDimensions = stats.storedDimensions || null;

      // If no stored vectors, any dimension is compatible
      if (!storedDimensions || stats.totalVectors === 0) {
        return {
          compatible: true,
          storedDimensions: null,
          currentDimensions: this.embeddingService.getActualDimensions()
        };
      }

      // Get current dimensions from embedding service
      const currentDimensions = this.embeddingService.getActualDimensions();

      // If we don't know current dimensions yet, we need to detect them first
      // This will happen on first API call, so we can't validate yet
      if (!currentDimensions) {
        return {
          compatible: true,
          storedDimensions,
          currentDimensions: null,
          message: 'Dimensions will be detected on first API call'
        };
      }

      // Check if dimensions match
      if (storedDimensions !== currentDimensions) {
        return {
          compatible: false,
          storedDimensions,
          currentDimensions,
          message: `维度不匹配: 已存储=${storedDimensions}, 当前配置=${currentDimensions}。请使用"重建索引"按钮清除旧数据后重新构建。 / Dimension mismatch: stored=${storedDimensions}, current=${currentDimensions}. Please use "Rebuild Index" to clear old data and rebuild.`
        };
      }

      return {
        compatible: true,
        storedDimensions,
        currentDimensions
      };
    } catch (error) {
      ztoolkit.log(`[SemanticSearch] Error checking dimension compatibility: ${error}`, 'warn');
      // If we can't check, assume compatible to avoid blocking
      return {
        compatible: true,
        storedDimensions: null,
        currentDimensions: null,
        message: 'Could not verify dimension compatibility'
      };
    }
  }

  /**
   * Check if service is ready
   */
  async isReady(): Promise<boolean> {
    try {
      await this.initialize();
      return await this.embeddingService.isReady();
    } catch {
      return false;
    }
  }

  // ============ Private Methods ============

  /**
   * Extract content from item for indexing
   * @param item The Zotero item
   * @param sharedProcessor Optional shared PDFProcessor for better performance
   */
  private async extractItemContent(item: any, sharedProcessor?: PDFProcessor | null): Promise<string> {
    const parts: string[] = [];
    ztoolkit.log(`[SemanticSearch] extractItemContent() start: ${item.key}, type=${item.itemType}`);

    try {
      // Title
      const title = item.getDisplayTitle?.() || item.getField?.('title');
      if (title) {
        parts.push(title);
        ztoolkit.log(`[SemanticSearch] extractItemContent() got title: "${title.substring(0, 50)}..."`);
      }

      // Abstract
      const abstract = item.getField?.('abstractNote');
      if (abstract) {
        parts.push(TextFormatter.htmlToText(abstract));
        ztoolkit.log(`[SemanticSearch] extractItemContent() got abstract: ${abstract.length} chars`);
      }

      // Get content from attachments (full text + annotations)
      if (item.isRegularItem?.()) {
        const attachmentIds = item.getAttachments?.() || [];
        const originalPDFs = await getOriginalPDFAttachmentsForItem(item);
        const originalPDFIds = new Set(originalPDFs.map((attachment) => attachment.id));
        ztoolkit.log(
          "[SemanticSearch] attachment selection: " +
            attachmentIds.length +
            " total, " +
            originalPDFIds.size +
            " original PDF",
        );
        let annotationCount = 0;
        let fullTextCount = 0;

        for (const attachmentId of attachmentIds) {
          try {
            const attachment = await Zotero.Items.getAsync(attachmentId);
            if (!attachment) continue;

            // Extract full text from PDF attachments using PDFProcessor
            if (
              attachment.isPDFAttachment?.() &&
              originalPDFIds.has(attachment.id)
            ) {
              try {
                const filePath = await attachment.getFilePathAsync?.();
                if (filePath) {
                  ztoolkit.log(`[SemanticSearch] extractItemContent() extracting PDF: ${filePath}`);

                  // MinerU 高精度解析优先：索引是批处理任务，允许阻塞等待解析。
                  // 未启用 / 解析失败时返回 null，自动落到下面的内置提取。
                  const minerUText = await getMinerUService().getIndexTextForAttachment(
                    attachment,
                    {
                      allowParse: true,
                      // A forced re-index is the user asking us to try again,
                      // so don't sit on a cached parse failure.
                      ignoreFailureCache: this._forceRun,
                    },
                  );
                  if (minerUText) {
                    // The complete body text is indexed. It used to be cut at
                    // 50k characters, which silently made everything past
                    // roughly the middle of a long paper unsearchable.
                    warnIfHugeDocument(item.key, minerUText.length, 'MinerU');
                    parts.push(minerUText);
                    fullTextCount++;
                    ztoolkit.log(`[SemanticSearch] extractItemContent() got MinerU text: ${minerUText.length} chars`);
                  } else {
                    // 回退：Zotero 内置 pdfWorker 提取
                    // Use shared processor if provided (much faster for batch processing)
                    const processor = sharedProcessor || new PDFProcessor(ztoolkit);
                    const shouldTerminate = !sharedProcessor;  // Only terminate if we created it
                    try {
                      const textContent = await processor.extractText(filePath);
                      if (textContent && textContent.length > 0) {
                        // Complete body text, same as the MinerU branch above.
                        warnIfHugeDocument(item.key, textContent.length, 'pdfWorker');
                        parts.push(textContent);
                        fullTextCount++;
                        ztoolkit.log(`[SemanticSearch] extractItemContent() got PDF text: ${textContent.length} chars`);
                      } else {
                        ztoolkit.log(`[SemanticSearch] extractItemContent() PDF extraction returned empty`);
                      }
                    } finally {
                      if (shouldTerminate) {
                        processor.terminate();
                      }
                    }
                  }
                } else {
                  ztoolkit.log(`[SemanticSearch] extractItemContent() no file path for attachment ${attachmentId}`);
                }
              } catch (pdfError) {
                ztoolkit.log(`[SemanticSearch] extractItemContent() PDF extraction failed: ${pdfError}`, 'warn');
              }
            }

            // Extract text from plain text attachments
            if (attachment.attachmentContentType === 'text/plain') {
              try {
                const filePath = await attachment.getFilePathAsync?.();
                if (filePath) {
                  const textContent = await Zotero.File.getContentsAsync(filePath);
                  if (textContent && textContent.length > 0) {
                    parts.push(textContent);
                    fullTextCount++;
                    ztoolkit.log(`[SemanticSearch] extractItemContent() got plain text: ${textContent.length} chars`);
                  }
                }
              } catch (e) {
                ztoolkit.log(`[SemanticSearch] extractItemContent() plain text extraction failed: ${e}`, 'warn');
              }
            }

            // Get annotations from PDF attachments
            if (
              attachment.isPDFAttachment?.() &&
              originalPDFIds.has(attachment.id)
            ) {
              const annotations = attachment.getAnnotations?.() || [];
              for (const ann of annotations) {
                const text = ann.annotationText;
                const comment = ann.annotationComment;
                if (text) {
                  parts.push(TextFormatter.htmlToText(text));
                  annotationCount++;
                }
                if (comment) {
                  parts.push(TextFormatter.htmlToText(comment));
                  annotationCount++;
                }
              }
            }
          } catch (e) {
            // Skip failed attachments
            ztoolkit.log(`[SemanticSearch] extractItemContent() attachment error: ${e}`, 'warn');
          }
        }

        if (fullTextCount > 0) {
          ztoolkit.log(`[SemanticSearch] extractItemContent() got ${fullTextCount} full text contents`);
        }
        if (annotationCount > 0) {
          ztoolkit.log(`[SemanticSearch] extractItemContent() got ${annotationCount} annotations`);
        }
      }

      // If it's an annotation item itself
      if (item.isAnnotation?.()) {
        const text = item.annotationText;
        const comment = item.annotationComment;
        if (text) parts.push(TextFormatter.htmlToText(text));
        if (comment) parts.push(TextFormatter.htmlToText(comment));
      }

      // Notes
      if (item.isNote?.()) {
        const noteText = item.getNote?.();
        if (noteText) parts.push(TextFormatter.htmlToText(noteText));
      }

    } catch (error) {
      ztoolkit.log(`[SemanticSearch] extractItemContent() error: ${error}`, 'warn');
    }

    const result = parts.join('\n\n');
    ztoolkit.log(`[SemanticSearch] extractItemContent() done: ${parts.length} parts, total ${result.length} chars`);
    return result;
  }

  /**
   * Fill in item metadata for search results
   */
  private async fillItemMetadata(results: SemanticSearchResult[]): Promise<void> {
    for (const result of results) {
      try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          result.libraryID,
          result.itemKey
        );

        if (item) {
          result.title = item.getDisplayTitle() || '';
          result.parentKey = item.parentItemKey || undefined;
          result.itemType = item.itemType || undefined;

          // Get creators
          const creators = item.getCreators?.() || [];
          if (creators.length > 0) {
            result.creators = creators
              .map((c: any) => c.lastName || c.name || '')
              .filter((n: string) => n)
              .join(', ');
          }

          // Get year
          const date = item.getField?.('date');
          if (date) {
            const yearMatch = String(date).match(/\d{4}/);
            if (yearMatch) {
              result.year = parseInt(yearMatch[0], 10);
            }
          }
        }
      } catch (e) {
        // Skip failed items
      }
    }
  }

  /**
   * Get items by keys
   */
  private async getItemsByKeys(
    keys: string[],
    libraryID: number = Zotero.Libraries.userLibraryID,
  ): Promise<any[]> {
    const items: any[] = [];
    for (const key of keys) {
      try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          libraryID,
          key
        );
        if (item) items.push(item);
      } catch (e) {
        // Skip failed items
      }
    }
    return items;
  }

  /**
   * Get all items with content (regular items with attachments)
   */
  private async getItemsWithContent(
    libraryID: number = Zotero.Libraries.userLibraryID,
  ): Promise<any[]> {
    try {
      // Get all regular items
      const search = new Zotero.Search();
      search.libraryID = libraryID;
      search.addCondition('itemType', 'isNot', 'attachment');
      search.addCondition('itemType', 'isNot', 'note');
      search.addCondition('itemType', 'isNot', 'annotation');

      const ids = await search.search();
      return Zotero.Items.getAsync(ids);
    } catch (error) {
      ztoolkit.log(`[SemanticSearch] Error getting items: ${error}`, 'warn');
      return [];
    }
  }

  /**
   * Hash content for change detection
   */
  private hashContent(content: string): string {
    // Simple hash using Zotero's utility
    try {
      return Zotero.Utilities.Internal.md5(content);
    } catch {
      // Fallback: simple hash
      let hash = 0;
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return hash.toString(16);
    }
  }

  /**
   * Destroy the service
   */
  destroy(): void {
    this.embeddingService.destroy();
    this.initialized = false;
    this.initPromise = null;
    ztoolkit.log('[SemanticSearch] Service destroyed');
  }
}

// Singleton instance
let semanticSearchInstance: SemanticSearchService | null = null;

export function getSemanticSearchService(): SemanticSearchService {
  if (!semanticSearchInstance) {
    ztoolkit.log(`[SemanticSearch] getSemanticSearchService() creating new singleton instance`);
    semanticSearchInstance = new SemanticSearchService();
  } else {
    ztoolkit.log(`[SemanticSearch] getSemanticSearchService() returning existing instance`);
  }
  return semanticSearchInstance;
}

/**
 * Reset the singleton instance (for shutdown cleanup)
 */
export function resetSemanticSearchService(): void {
  if (semanticSearchInstance) {
    semanticSearchInstance.abortIndex();
    semanticSearchInstance.destroy();
    semanticSearchInstance = null;
    ztoolkit.log('[SemanticSearch] Singleton instance reset');
  }
}
