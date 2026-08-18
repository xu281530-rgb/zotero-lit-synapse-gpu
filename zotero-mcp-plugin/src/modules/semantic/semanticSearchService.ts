/**
 * Semantic Search Service for Zotero MCP Plugin
 *
 * Main service that orchestrates:
 * - Embedding generation (EmbeddingService)
 * - Vector storage and search (VectorStore)
 * - Text processing (TextChunker)
 * - Integration with existing Zotero services
 */

import {
  getEmbeddingService,
  EmbeddingService,
  EmbeddingAPIError,
  // Type-only: importing it as a value makes the module unloadable by Node's
  // strip-only type stripping, which the regression tests run under.
  type EmbeddingErrorType,
} from './embeddingService';
import {
  getVectorStore,
  VectorStore,
  type FailedIndexItem,
  type IndexStorageBreakdown,
  type IndexedDocumentTotals,
} from './vectorStore';
import type { KeywordIndexReport } from '../keyword/keywordIndexStore';
import {
  MAX_SIMILAR_QUERY_CHUNKS,
  rankSimilarDocuments,
  SIMILAR_CHUNKS_PER_QUERY,
  type AggregatedSimilarDocument,
} from './similarDocumentAggregation';
import {
  resolveSimilarScanBudget,
  type SimilarScanBudget,
} from './similarScanBudget';
import { getTextChunker, TextChunker } from './textChunker';
import { TextFormatter } from '../textFormatter';
import { PDFProcessor } from '../pdfProcessor';
import {
  getMinerUService,
  getOriginalPDFAttachmentsForItem,
  markdownToIndexText,
} from '../mineru';
import {
  bodyIndexStateFromSourceKind,
  sourceKindForBodyState,
  type BodyIndexState,
} from './bodyIndexState';
import {
  getChunkingSignature,
  getHybridSearchSettings,
  invalidateStoredChunkingSignature,
  setStoredChunkingSignature,
  shouldRecordFullLibraryChunkingSignature,
} from '../hybridSearchSettings';
import { runIndexWorkQueue, type IndexWorkOutcome } from './indexBuildQueue';
import {
  ChunkOversizeDecisionGate,
  applyOversizeSkipToStatus,
  type ChunkTooLargeAsk,
  type ChunkTooLargeDecision,
  type ChunkTooLargeDecisionRequest,
} from './chunkOversizePolicy';
import { groupFailedIndexItems } from './failedIndexRetry';
import {
  enumerateLibraryItems,
  isItemEnumerationError,
} from './libraryEnumeration';
import {
  computeBodyExtractionSignature,
  decideBodyRetry,
} from './bodyRetryPolicy';
import { isIndexResetPending } from './indexRefreshQueue';

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

async function markWikiResetPending(
  buildID: string,
  libraryID: number,
): Promise<void> {
  try {
    const { getWikiStore } = await import('../wiki/wikiStore');
    await getWikiStore().markResetPending(`build:${buildID}`, libraryID);
  } catch (error) {
    ztoolkit.log(
      `[SemanticSearch] Could not mark Wiki Evidence pending_relink: ${error}`,
      'warn',
    );
  }
}

async function markWikiItemsPending(
  buildID: string,
  libraryID: number,
  itemKeys: string[],
): Promise<void> {
  try {
    const { getWikiStore } = await import('../wiki/wikiStore');
    await getWikiStore().markItemsPending(
      `build:${buildID}`,
      libraryID,
      itemKeys,
    );
  } catch (error) {
    ztoolkit.log(
      `[SemanticSearch] Could not mark item Wiki Evidence pending_relink: ${error}`,
      'warn',
    );
  }
}

function scheduleWikiReverify(libraryID: number): void {
  void import('../wiki/wikiService')
    .then(({ getWikiService }) => getWikiService().reverify(libraryID))
    .catch((error) =>
      ztoolkit.log(
        `[SemanticSearch] Wiki Evidence relink failed: ${error}`,
        'warn',
      ),
    );
}

// Preference key for persisting index progress
const PREF_INDEX_PROGRESS = 'extensions.zotero.zotero-mcp-plugin.semantic.indexProgress';

/**
 * Deadline for the query-embedding request during a search.
 *
 * Deliberately NOT user-configurable and deliberately separate from the
 * vector-scan timeout: embedding is a remote HTTP call whose latency has
 * nothing to do with how large the local index is, so folding it into the scan
 * budget would let a slow endpoint eat the time meant for scanning. It exists
 * so no search branch can ever wait forever.
 */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 30000;

/** Run `operation`, rejecting if it has not settled within `timeoutMs`. */
async function withDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Abort the in-flight work as well: rejecting only stops the caller
          // waiting, it does not stop the request burning quota in background.
          try {
            onTimeout?.();
          } catch {
            // Cancellation is best-effort.
          }
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

/**
 * Title MinerUService gives the Markdown files it writes: the source PDF's key
 * is embedded in it, which is how a Markdown attachment can be matched back to
 * the PDF it was generated from — including after that PDF has been deleted.
 */
const GENERATED_MARKDOWN_TITLE = /^MinerU Markdown \(([A-Z0-9]+)\)\.md$/i;

/** The key of the PDF a generated Markdown came from, or null if not one. */
function generatedMarkdownSourceKey(attachment: any): string | null {
  try {
    const title = String(attachment?.getField?.('title') || '');
    const match = GENERATED_MARKDOWN_TITLE.exec(title);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ============ Interfaces ============

/** What extractItemContent found, and where it found it. */
export interface ExtractedItemContent {
  /** Title + abstract + whatever body text was obtained. */
  text: string;
  /** At least one body source produced text. */
  hasBody: boolean;
  /** The item offers at least one candidate body source. */
  hasBodySource: boolean;
  /** Sources that produced text, for the log and the failure message. */
  bodySources: string[];
  /** Sources that were tried and produced nothing. */
  failedSources: string[];
}

/**
 * Classify one extraction result.
 *
 *  - `body`          the paper's body text is in the index
 *  - `metadata-only` a body source exists but nothing could be read from it;
 *                    only title/abstract were indexed. This is a FAILURE.
 *  - `no-source`     no body source exists at all (a bibliography-only
 *                    record). Expected, and not counted as a failure.
 */
export function classifyExtractedContent(
  extracted: ExtractedItemContent,
): 'body' | 'metadata-only' | 'no-source' {
  if (extracted.hasBody) return 'body';
  return extracted.hasBodySource ? 'metadata-only' : 'no-source';
}

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
  /** Deadline for vector scanning only; query embedding has its own timeout. */
  vectorScanTimeoutMs?: number;
  /**
   * Deadline for the query-embedding request. Defaults to
   * DEFAULT_EMBEDDING_TIMEOUT_MS — never unbounded, because the embedding
   * endpoint is a network call the vector-scan deadline does not cover.
   */
  embeddingTimeoutMs?: number;
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

/** What one multi-chunk similarity search produced, before pagination. */
export interface SimilarDocumentsResult {
  /** The document the query chunks were taken from. */
  itemKey: string;
  libraryID: number;
  queryChunkIds: number[];
  /** How many chunks that document has in total, for context. */
  totalChunksInItem: number;
  /** EVERY document above the threshold, ranked. Not capped, not paged. */
  ranked: AggregatedSimilarDocument[];
  /** Documents the scan found any evidence for, before the threshold. */
  candidateDocuments: number;
  discardedBelowThreshold: number;
  chunksScanned: number;
  scanMs: number;
  totalMs: number;
  /** The deadline this call actually ran under, and how it was derived. */
  budget: SimilarScanBudget;
}

export interface IndexProgress {
  total: number;
  processed: number;
  currentItem?: string;
  /**
   * 'incomplete' is a finished run that deliberately left documents out —
   * distinct from 'failed' (something went wrong) and from 'completed', which
   * is the only status allowed to record the full-library chunking signature.
   */
  status: 'idle' | 'indexing' | 'paused' | 'completed' | 'incomplete' | 'failed' | 'error' | 'aborted' | 'busy';
  error?: string;
  errorType?: EmbeddingErrorType;  // Type of error for UI display
  errorRetryable?: boolean;        // Whether the error can be retried
  startTime?: number;
  estimatedRemaining?: number;
  failedCount?: number;            // Number of failed items
  /**
   * Items that carry a PDF/Markdown/text body source but whose body could not
   * be read this run, so only title/abstract were indexed. A subset of
   * failedCount, broken out because it is the number the user can act on.
   */
  bodyFailures?: number;
  skipped?: number;                // Items filtered out as already indexed
  /**
   * Items left out this run because one of their chunks exceeded the embedding
   * endpoint's input length and the user chose to skip rather than stop. Also
   * counted in failedCount (they are recorded in index_failures so "retry
   * failed items" can pick them up once the chunk length is lowered), but
   * reported separately because "skipped on purpose" and "broke" are different
   * things to tell a user.
   */
  chunkOversizeSkipped?: number;
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
    /** How many indexed items really hold body text — see VectorStoreStats. */
    bodyCoverage?: {
      withBody: number;
      metadataOnly: number;
      noBodySource: number;
      unknown: number;
    };
  };
  /**
   * The body-keyword index's own counts, or undefined when they could not be
   * read. Never merged into `indexStats`: those are the vector index's numbers,
   * and folding two indexes into one bag is what made the keyword index a
   * hidden appendage in the first place.
   */
  keywordStats?: KeywordIndexReport;
  /**
   * Documents per index and their union, for the library the pane is showing.
   * The union is computed in the database; see IndexedDocumentTotals.
   */
  documentTotals: IndexedDocumentTotals;
  /** Physical page usage per index; whole-file, since pages have no library. */
  storage: IndexStorageBreakdown;
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
  private _activeIndexOperations = 0;
  /** Set for the duration of a forced build; read by extractItemContent */
  private _forceRun = false;
  private _activeBuildID: string | null = null;
  private _activeFullLibraryRebuild = false;
  private _databaseResetActive = false;

  // Error handling
  private _onErrorCallback?: (error: EmbeddingAPIError) => void;
  private _failedItems: Map<string, FailedIndexItem> = new Map();

  // Oversized-chunk handling: asked once per run, then applied silently.
  private _chunkOversizeGate = new ChunkOversizeDecisionGate();

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
            chunkOversizeSkipped: saved.chunkOversizeSkipped || 0,
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
        // Carried across a pause, and across a Zotero restart during one, so
        // the closing summary still names every document that was skipped.
        chunkOversizeSkipped: this.indexProgress.chunkOversizeSkipped ?? 0,
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
      vectorScanTimeoutMs,
      embeddingTimeoutMs = DEFAULT_EMBEDDING_TIMEOUT_MS,
      signal,
      stats,
    } = options;
    // Own an internal controller even when the caller passed none, so a
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
    try {
      await this.initialize();
      ztoolkit.log(`[SemanticSearch] Searching: "${query.substring(0, 50)}..."`);

      try {
        // 1. Generate query embedding (isQuery=true for BGE instruction prefix)
        ztoolkit.log(`[SemanticSearch] Step 1: Generating query embedding...`);
        const embeddingStartedAt = Date.now();
        // Bounded independently of the vector scan: a hung embedding endpoint
        // must not be able to stall the branch forever, and must not silently
        // consume the budget the scan was given.
        const queryEmbedding = await withDeadline(
          () =>
            this.embeddingService.embed(query, 'auto', true, {
              signal: abortController?.signal,
            }),
          embeddingTimeoutMs,
          'Query embedding',
          abortSearch,
        );
        const embeddingMs = Date.now() - embeddingStartedAt;
        ztoolkit.log(
          `[SemanticSearch][Timing] embedding=${embeddingMs}ms libraryID=${libraryID}`,
        );
        ztoolkit.log(`[SemanticSearch] Query embedding: lang=${queryEmbedding.language}, dims=${queryEmbedding.dimensions}`);

        // 2. Vector search. "all" remains unfiltered; "auto" uses query language.
        const searchLanguage =
          language === 'auto' ? queryEmbedding.language : language;
        // Score chunks once, aggregate by document during the scan, and retain
        // lightweight references to each document's best evidence.
        const vectorStartedAt = Date.now();
        // Measured from HERE, not from the start of the call: the embedding
        // above had its own budget, so the scan always gets the full amount the
        // user configured regardless of how slow the endpoint was.
        const effectiveVectorDeadlineAt =
          vectorScanTimeoutMs !== undefined
            ? Date.now() + vectorScanTimeoutMs
            : undefined;
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
      /** Deadline for scanning this document's chunks. */
      vectorScanTimeoutMs?: number;
      /** Deadline for the query-embedding request; never unbounded. */
      embeddingTimeoutMs?: number;
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
      vectorScanTimeoutMs,
      embeddingTimeoutMs = DEFAULT_EMBEDDING_TIMEOUT_MS,
      signal,
    } = options;
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
    // The scan deadline is armed only once embedding has returned, so a slow
    // embedding endpoint cannot consume the budget meant for scanning. Each
    // stage is bounded, so neither can run unbounded.
    let deadlineAt: number | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      await this.initialize();

      const queryEmbedding = await withDeadline(
        () =>
          this.embeddingService.embed(query, 'auto', true, {
            signal: abortController?.signal,
          }),
        embeddingTimeoutMs,
        'Query embedding',
        abortSearch,
      );

      if (vectorScanTimeoutMs) {
        deadlineAt = Date.now() + vectorScanTimeoutMs;
        deadlineTimer = setTimeout(abortSearch, vectorScanTimeoutMs);
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

  /**
   * Whether a scan would run on the GPU right now.
   *
   * Exposed so callers can size a deadline before searching: the two paths
   * scale differently with the number of query vectors.
   */
  isGpuSearchEnabled(): boolean {
    return this.vectorStore.isGpuSearchEnabled();
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
   * Find DOCUMENTS similar to a set of chunks taken from ONE document.
   *
   * The unit of the answer is the document, not the chunk. Chunk-level scores
   * are produced by the scan and are then aggregated per document, so the
   * result cannot be dominated by a single paper that happens to own many
   * high-scoring passages — the failure mode of the previous implementation,
   * which took the top-K chunks and de-duplicated them afterwards.
   *
   * No embedding request is made: the query vectors are the caller's own
   * chunks, already stored in the index, so the vector-scan budget is the whole
   * budget for this call.
   */
  async findSimilarByChunks(options: {
    itemKey: string;
    chunkIds: number[];
    libraryID?: number;
    /** Document-level relevance floor, on the same 0..1 scale as cosine. */
    minScore: number;
    language?: 'zh' | 'en' | 'all';
    chunksPerQuery?: number;
    /**
     * The user's budget for ONE full-library scan. It is scaled here by the
     * number of query chunks and the execution path — see resolveSimilarScanBudget.
     */
    vectorScanTimeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<SimilarDocumentsResult> {
    const startTime = Date.now();
    await this.initialize();

    const {
      itemKey,
      libraryID = Zotero.Libraries.userLibraryID,
      minScore,
      language = 'all',
      chunksPerQuery = SIMILAR_CHUNKS_PER_QUERY,
      signal,
    } = options;

    const requestedChunkIds: number[] = [];
    for (const raw of options.chunkIds) {
      const chunkId = Number(raw);
      if (!Number.isInteger(chunkId)) {
        throw new Error(`chunkIds must be integers; received ${String(raw)}`);
      }
      if (!requestedChunkIds.includes(chunkId)) requestedChunkIds.push(chunkId);
    }
    if (requestedChunkIds.length === 0) {
      throw new Error(
        'chunkIds must contain at least one chunk of the query document',
      );
    }
    if (requestedChunkIds.length > MAX_SIMILAR_QUERY_CHUNKS) {
      throw new Error(
        `Too many query chunks: ${requestedChunkIds.length}. At most ${MAX_SIMILAR_QUERY_CHUNKS} chunks of one document may be used as the query, because every additional chunk re-scores the whole index. Pick the passages that actually characterise the paper.`,
      );
    }

    // The stored vectors ARE the query. Reading them here also validates that
    // every requested chunk exists in THIS document: a chunkId is only unique
    // within one item, so a chunk borrowed from another paper simply does not
    // resolve here and must be reported rather than silently scored.
    const itemVectors = await this.vectorStore.getItemVectors(
      itemKey,
      libraryID,
    );
    if (itemVectors.length === 0) {
      throw new Error(
        `Item ${itemKey} has no indexed vectors, so it cannot be used as a similarity query. Build or refresh its semantic index (Zotero → item context menu → update index) and retry.`,
      );
    }

    const vectorByChunkId = new Map<number, Float32Array>();
    for (const chunk of itemVectors) {
      vectorByChunkId.set(chunk.chunkId, chunk.vector);
    }
    const missing = requestedChunkIds.filter((id) => !vectorByChunkId.has(id));
    if (missing.length > 0) {
      const known = itemVectors.map((chunk) => chunk.chunkId);
      throw new Error(
        `These chunkIds do not belong to item ${itemKey}: ${missing.join(', ')}. Valid chunkIds for this document run from ${known[0]} to ${known[known.length - 1]}. All query chunks must come from ONE document — take them from a single search_fulltext call on that item.`,
      );
    }

    const queryVectors = requestedChunkIds.map(
      (chunkId) => vectorByChunkId.get(chunkId) as Float32Array,
    );

    // The deadline is sized for THIS call: N query chunks on the path that will
    // actually run. Reusing the single-scan budget unchanged made a normal
    // 5-chunk query on the GPU (≈3.8 scans' worth of work) time out on a
    // setting calibrated for one scan.
    const budget = resolveSimilarScanBudget({
      queryChunkCount: requestedChunkIds.length,
      vectorScanTimeoutMs:
        options.vectorScanTimeoutMs ?? getHybridSearchSettings().vectorScanTimeoutMs,
      path: this.vectorStore.isGpuSearchEnabled() ? 'gpu' : 'cpu',
    });
    const deadlineAt = Date.now() + budget.timeoutMs;

    const scanStats: { scanned?: number; documents?: number } = {};
    const scanStartedAt = Date.now();
    const matches = await this.vectorStore.searchMultiQuery(queryVectors, {
      chunksPerQuery,
      language,
      libraryID,
      // The query document is excluded during the scan, so it can never take a
      // slot in its own result set.
      excludeItemKeys: [itemKey],
      // Keep every chunk, including negatively-scoring ones. A floor of 0 made
      // "this document has no second passage" and "this document's second
      // passage is unrelated" indistinguishable, and the aggregate then had a
      // single spike to average — which is exactly the case the top-2 average
      // exists to damp.
      minChunkScore: -1,
      deadlineAt,
      signal,
      stats: scanStats,
    });
    const scanMs = Date.now() - scanStartedAt;

    const { ranked, discardedBelowThreshold } = rankSimilarDocuments(matches, {
      minScore,
      chunksPerQuery,
    });

    ztoolkit.log(
      `[SemanticSearch] findSimilarByChunks(${itemKey}): queryChunks=${requestedChunkIds.length}, candidates=${matches.length}, above threshold=${ranked.length} (minScore=${minScore}), scanned=${scanStats.scanned ?? 0} chunks in ${scanMs}ms (budget=${budget.timeoutMs}ms = ${budget.multiplier.toFixed(2)}x ${budget.vectorScanTimeoutMs}ms on ${budget.path})`,
    );

    return {
      itemKey,
      libraryID,
      queryChunkIds: requestedChunkIds,
      totalChunksInItem: itemVectors.length,
      ranked,
      candidateDocuments: matches.length,
      discardedBelowThreshold,
      chunksScanned: scanStats.scanned ?? 0,
      scanMs,
      totalMs: Date.now() - startTime,
      budget,
    };
  }

  // ============ Indexing Methods ============

  /**
   * Build or update the search index
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

    if (this._databaseResetActive || isIndexResetPending()) {
      ztoolkit.log(
        '[SemanticSearch] buildIndex rejected while search index database reset cleanup is active',
        'warn',
      );
      return { ...this.indexProgress, status: 'busy' };
    }

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

    if (this.isBuildActive()) {
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

      // "Skip the rest of them too" is scoped to one run. Resuming a build
      // continues the same run, so the answer carries over; starting a new one
      // asks again, because by then the user may have changed the setting the
      // question was about.
      if (!resumeBuildID) this._chunkOversizeGate.reset();
      // Likewise the tally: a build that paused for an unrelated network error
      // and was resumed must still report every document it skipped before the
      // pause, or the closing summary silently under-counts.
      const carriedOversizeSkips = resumeBuildID
        ? this.indexProgress.chunkOversizeSkipped || 0
        : 0;

      this.indexProgress = {
        total: 0,
        processed: 0,
        indexed: 0,
        unchanged: 0,
        failedCount: 0,
        bodyFailures: 0,
        chunkOversizeSkipped: carriedOversizeSkips,
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
        // The destructive steps of a full-library rebuild (createBuildSession
        // with the target snapshot, then clearLibraryForBuild) are all
        // downstream of this line, and every one of them is validated against
        // `items`. So enumeration failing has to stop the run HERE, before any
        // of them runs — an unusable answer must never be allowed to present
        // itself as an empty library.
        try {
          items = await this.getItemsWithContent(libraryID);
        } catch (error) {
          if (!isItemEnumerationError(error)) throw error;
          ztoolkit.log(
            `[SemanticSearch] Aborting build: ${error.message}`,
            'error',
          );
          this.indexProgress.status = 'error';
          this.indexProgress.error = error.message;
          this.indexProgress.errorType = 'unknown';
          // Retryable: nothing was destroyed, and the query may well answer
          // next time. This is the whole point of stopping this early.
          this.indexProgress.errorRetryable = true;
          this.indexProgress.total = 0;
          this.indexProgress.processed = 0;
          onProgress?.(this.indexProgress);
          return this.indexProgress;
        }
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
          await markWikiResetPending(buildID, libraryID);
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

      if (itemKeysProvided && !this._activeFullLibraryRebuild) {
        await markWikiItemsPending(buildID, libraryID, itemKeys ?? []);
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
        // Reachable with skips: a run that skipped documents, paused for an
        // unrelated error and was then resumed can arrive here with nothing
        // left to do. The tally carried across the pause, so the verdict must
        // travel with it — otherwise this branch is the one place a run that
        // dropped documents could still be called 'completed'.
        this.indexProgress.status = applyOversizeSkipToStatus(
          this.indexProgress.status,
          this.indexProgress.chunkOversizeSkipped ?? 0,
        );
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
        // 'incomplete' is finished, like 'completed' — there is nothing to
        // resume into, so it must not leave a resumable record behind.
        if (
          this.indexProgress.status === 'completed' ||
          this.indexProgress.status === 'incomplete'
        ) {
          this.clearSavedIndexProgress();
        } else {
          this.saveIndexProgress();
        }
        if (this.indexProgress.status === 'completed') {
          scheduleWikiReverify(libraryID);
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
                // An oversized chunk is a settings problem wearing a single
                // document's clothes: chunk length is global, so the rest of
                // the queue's long papers are about to fail identically. It is
                // also the only failure where continuing anyway may be exactly
                // what the user wants, so it is the one failure we ask about
                // rather than decide for them.
                if (error.type === 'chunk_too_large') {
                  const decision = await this.resolveChunkTooLarge(item, error);
                  if (decision === 'skip') {
                    this.indexProgress.chunkOversizeSkipped =
                      (this.indexProgress.chunkOversizeSkipped || 0) + 1;
                    // Recorded as a failure as well as a skip, so lowering the
                    // chunk length and pressing "retry failed items" picks
                    // these up without rebuilding the whole library.
                    await this.recordFailedItem(item, error, error.type);
                    return { status: 'failed', error };
                  }
                  // Stop: end the run now rather than pausing. There is
                  // nothing to resume into — the setting has to change first,
                  // and changing it invalidates the chunks already built.
                  this.indexProgress.error = error.getUserMessage();
                  this.indexProgress.errorType = error.type;
                  this.indexProgress.errorRetryable = false;
                  this._aborted = true;
                  this.indexProgress.status = 'aborted';
                  await this.vectorStore.updateBuildSessionStatus(buildID, 'aborted');
                  this.saveIndexProgress();
                  this._onErrorCallback?.(error);
                  onProgress?.(this.indexProgress);
                  return { status: 'incomplete' };
                }

                // Errors that describe the run rather than this one item.
                // batch_too_many_inputs belongs here for the same reason as
                // auth or config: the request shape is wrong for this endpoint
                // and will be wrong for every remaining document. Pausing puts
                // the number the server named in front of the user now, and a
                // resume picks the new setting up on the next request — where
                // failing per-item meant the whole library failed with an
                // error that had stated its own fix hundreds of times.
                const isGlobalError =
                  error.type === 'auth' ||
                  error.type === 'config' ||
                  error.type === 'network' ||
                  error.type === 'rate_limit' ||
                  error.type === 'server' ||
                  error.type === 'batch_too_many_inputs';
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

      // A run that deliberately left documents out is neither a success nor a
      // malfunction. Naming it 'incomplete' keeps the two apart in the build
      // history, and — because only 'completed' may record it — guarantees the
      // full-library chunking signature is withheld, so the index is never
      // claimed to match the current chunk settings when part of it is absent.
      const withSkips = applyOversizeSkipToStatus(
        this.indexProgress.status,
        this.indexProgress.chunkOversizeSkipped ?? 0,
      );
      if (withSkips !== this.indexProgress.status) {
        ztoolkit.log(
          `[SemanticSearch] Build marked incomplete: ${this.indexProgress.chunkOversizeSkipped} item(s) skipped for oversized chunks`,
          'warn',
        );
        this.indexProgress.status = withSkips;
      }

      if (this.indexProgress.status === 'incomplete') {
        await this.vectorStore.updateBuildSessionStatus(buildID, 'incomplete');
        // The run is over — there is nothing to resume into, and the skipped
        // documents are reachable through the failed-items retry instead. So
        // the saved progress is cleared, exactly as for a clean completion.
        this.clearSavedIndexProgress();
      } else if (this.indexProgress.status === 'completed') {
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
      if (this.indexProgress.status === 'completed') {
        scheduleWikiReverify(libraryID);
      }
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
      // Reclaim the keyword postings of superseded revisions, in one pass at the
      // END of the build rather than per item. Deferring this is precisely what
      // makes a single-item update cheap, so doing it eagerly would give back
      // the saving it was designed to produce. Runs even after a failed or
      // aborted build: the tombstones exist either way.
      await this.vectorStore.compactKeywordIndex();
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
  /**
   * The extraction configuration in force right now, as a comparable string.
   *
   * Stamped onto every index_status row the build writes, so a later run can
   * distinguish "already attempted under these exact settings" from "the
   * settings have changed, so the outcome may differ now".
   */
  private getBodyExtractionSignature(): string {
    try {
      const config = getMinerUService().getConfig();
      return computeBodyExtractionSignature({
        minerUEnabled: config.enabled,
        minerUMode: config.mode,
        minerUBaseURL: config.baseURL,
        minerUModelVersion: config.modelVersion,
        minerULanguage: config.language,
        minerUEnableOCR: config.enableOCR,
        minerUEnableFormula: config.enableFormula,
        minerUEnableTable: config.enableTable,
        minerUTimeoutSeconds: config.timeoutSeconds,
        minerUMaxFileSizeMB: config.maxFileSizeMB,
        minerUApiToken: config.apiToken,
      });
    } catch (error) {
      // A signature we cannot compute must not pin items to "never retry".
      // Falling back to a constant leaves the backoff as the only pacing rule,
      // which still bounds the cost while keeping failed items reachable —
      // the safe direction, since the alternative is an item that silently
      // stays body-less forever.
      ztoolkit.log(
        `[SemanticSearch] Could not compute body extraction signature: ${error}`,
        'warn',
      );
      return '';
    }
  }

  async indexItemWithProcessor(
    item: any,
    sharedProcessor: PDFProcessor | null,
    force: boolean = this._forceRun,
  ): Promise<IndexWorkOutcome> {
    if (this._databaseResetActive || isIndexResetPending()) {
      throw new Error('Search index database reset cleanup is active');
    }
    this._activeIndexOperations += 1;
    try {
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
    // ...unless the stored row says this item has NO body text. `getItemsToSkip`
    // keeps 'metadata-only' and 'empty' rows eligible for another attempt
    // precisely so a repaired PDF or a MinerU settings change can be picked up
    // — but a PDF's mtime does not change when either of those happens, so the
    // timestamp shortcut used to swallow every one of those items and made the
    // exemption above unreachable outside an explicit forced retry.
    //
    // Paced rather than unconditional: re-extracting every permanently broken
    // PDF on every incremental pass would spend real time and MinerU quota for
    // an answer that cannot have changed. Items with a healthy body index are
    // not retry candidates at all, so nothing that is already indexed is
    // re-processed and the cost of a routine incremental build is unchanged.
    const bodyRetrySignature = this.getBodyExtractionSignature();
    let bodyRetry = false;
    if (!needsCheckByTimestamp && !force) {
      const storedStatusForRetry = await this.vectorStore.getIndexStatus(
        item.key,
        item.libraryID,
      );
      const decision = decideBodyRetry({
        status: storedStatusForRetry,
        currentSignature: bodyRetrySignature,
        now: Date.now(),
      });
      bodyRetry = decision.retry;
      if (bodyRetry) {
        ztoolkit.log(
          `[SemanticSearch] indexItem() ${item.key}: timestamps unchanged but the stored row has no body text ` +
            `(sourceKind=${storedStatusForRetry?.sourceKind}, hash=${storedStatusForRetry?.contentHash}); ` +
            `re-attempting extraction (${decision.reason})`,
        );
      }
    }
    if (!needsCheckByTimestamp && !force && !bodyRetry) {
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
    const extracted = await this.extractItemContent(item, sharedProcessor);
    const content = extracted.text;
    // Recorded on the index row, so every reader afterwards — search_fulltext,
    // the progress counters, the retry queue — can tell an indexed body from
    // an index that is only a title and an abstract.
    const bodyState = classifyExtractedContent(extracted);
    const sourceKind = sourceKindForBodyState(bodyState);
    if (bodyState === 'metadata-only') {
      ztoolkit.log(
        `[SemanticSearch] indexItem() ${item.key}: body text FAILED. Tried [${extracted.failedSources.join('; ')}]. ` +
          `Only title/abstract will be indexed and this item counts as a failure.`,
        'warn',
      );
    }
    if (!content.trim()) {
      await this.vectorStore.replaceItemIndex({
        itemKey: item.key,
        libraryID: item.libraryID,
        records: [],
        contentHash: 'empty',
        contentLength: 0,
        sourceKind,
        itemModified,
        attachmentModified,
        bodyRetrySignature,
      });
      // Recorded with no chunks: the item IS keyword-indexed, it simply has no
      // body. Leaving it absent would make every later pass treat it as pending.
      await this.writeKeywordIndexForItem(item, []);
      ztoolkit.log(`[SemanticSearch] indexItem() skip: no content for ${item.key}, marked in index_status to avoid retry loop`);
      return this.noteBodyExtractionOutcome(item, bodyState, extracted, { status: 'succeeded' });
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
    const storedStatus = await this.vectorStore.getIndexStatus(
      item.key,
      item.libraryID,
    );
    const storedBodyState = bodyIndexStateFromSourceKind(
      storedStatus?.sourceKind,
    );
    const needsIndex = await this.vectorStore.needsReindex(
      item.key,
      contentHash,
      item.libraryID,
    );
    // A body parse that has just failed must never leave the PREVIOUS body
    // vectors in place. The unchanged-hash shortcut below writes no vectors at
    // all, so taking it here would keep serving passages from a PDF we can no
    // longer read — and, worse, would let a completed full-library rebuild
    // record its chunking signature over chunks produced by the old rules.
    // Going the long way round replaces the whole item atomically
    // (replaceItemIndex deletes every embedding for the key first), so what
    // remains is exactly the title/abstract chunks this run produced.
    //
    // Only skipped when the stored row is already metadata-only: then there is
    // provably no body left to clear, and re-embedding a title and an abstract
    // on every incremental pass would burn quota for nothing.
    const mustClearStaleBody =
      bodyState === 'metadata-only' && storedBodyState !== 'metadata-only';
    if (!needsIndex && mustClearStaleBody) {
      ztoolkit.log(
        `[SemanticSearch] indexItem() ${item.key}: content hash unchanged but body text just failed ` +
          `(stored=${storedBodyState}); rewriting the index anyway so no stale body vectors survive`,
        'warn',
      );
    }
    if (!needsIndex && !mustClearStaleBody) {
      // Content hash unchanged, just update timestamps
      if (storedStatus) {
          await this.vectorStore.updateIndexStatus(
            item.key, storedStatus.chunkCount, contentHash, itemModified, attachmentModified,
            item.libraryID,
            content.length,
            sourceKind,
            // Records that this configuration has now been tried, so a
            // still-failing item waits out the backoff instead of being
            // re-extracted on every single incremental pass.
            bodyRetrySignature,
        );
      }
      // A forced run may be retrying a keyword write that failed after the
      // vectors committed. The shared content hash is therefore not evidence
      // that both indexes are complete. Rebuild only the cheap keyword side;
      // the existing vectors remain valid and no embedding quota is spent.
      if (force) {
        const unchangedChunks = this.textChunker.chunk(content);
        if (unchangedChunks.length === 0) {
          throw new Error(`No chunks generated for ${item.key}`);
        }
        await this.writeKeywordIndexForItem(item, unchangedChunks);
      }
      this.indexProgress.unchanged = (this.indexProgress.unchanged || 0) + 1;
      ztoolkit.log(`[SemanticSearch] indexItem() skip: content unchanged, updated timestamps`);
      return this.noteBodyExtractionOutcome(item, bodyState, extracted, { status: 'succeeded' });
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
      sourceKind,
      itemModified,
      attachmentModified,
      bodyRetrySignature,
    });

    // After the vectors, and outside their transaction: a keyword failure must
    // leave the successfully embedded vectors in place.
    await this.writeKeywordIndexForItem(item, chunks);

    this.indexProgress.indexed = (this.indexProgress.indexed || 0) + 1;

    const elapsed = Date.now() - startTime;
    ztoolkit.log(`[SemanticSearch] indexItem() completed: ${item.key} (${records.length} vectors, source=${sourceKind}) in ${elapsed}ms`);
    return this.noteBodyExtractionOutcome(item, bodyState, extracted, { status: 'succeeded' });
    } finally {
      this._activeIndexOperations = Math.max(
        0,
        this._activeIndexOperations - 1,
      );
    }
  }

  /**
   * Write this item's body-keyword index from the SAME chunks the vectors used.
   *
   * One parse, one chunking, both indexes — which is why this takes the chunk
   * array rather than re-deriving anything. Chunk numbers therefore agree with
   * the vector index, so a keyword hit in passage 12 is the same passage 12 that
   * `search_fulltext` and `get_document_chunks` return.
   *
   * A keyword failure propagates to the build queue. The vector write remains
   * committed, but the item is not complete until this second write succeeds.
   */
  private async writeKeywordIndexForItem(
    item: any,
    chunks: string[],
  ): Promise<void> {
    let tags: string[] = [];
    try {
      tags = (item.getTags?.() ?? []).map((tag: any) => tag.tag).filter(Boolean);
    } catch {
      tags = [];
    }
    let creator = '';
    try {
      creator = (item.getCreators?.() ?? [])
        .map((entry: any) => `${entry.firstName || ''} ${entry.lastName || ''}`.trim())
        .filter(Boolean)
        .join(', ');
    } catch {
      creator = '';
    }
    const field = (name: string): string => {
      try {
        const value = item.getField?.(name);
        return typeof value === 'string' ? value : '';
      } catch {
        return '';
      }
    };
    const outcome = await this.vectorStore.writeKeywordIndex({
      itemKey: item.key,
      libraryID: item.libraryID,
      title: item.getDisplayTitle?.() || field('title'),
      abstract: TextFormatter.htmlToText(field('abstractNote')),
      tags,
      publicationTitle: field('publicationTitle'),
      creator,
      extra: field('extra'),
      chunks,
    });
    if (!outcome.ok) {
      throw new Error(
        `Keyword index write failed for ${item.key}: ${outcome.error ?? 'unknown error'}`,
      );
    }
  }

  /**
   * Count "we could not read this paper's body" — as a content problem, not
   * as an indexing failure.
   *
   * These are two different kinds of bad, and conflating them was wrong in
   * both directions:
   *
   *  - A PDF that will not parse is a property of that file. The index itself
   *    is complete and correct: the item was visited, its stale body vectors
   *    were cleared, and its title/abstract were written under a source_kind
   *    that says plainly there is no body text. Nothing about the run is
   *    unreliable, so it must NOT fail the build and must NOT withhold the
   *    chunking signature — doing that left a permanent "chunk settings
   *    changed" warning on any library containing one broken PDF.
   *  - An embedding error, a database write error or an interrupted run mean
   *    the index may be incomplete or internally inconsistent. Those still
   *    throw, still land in index_failures, still fail the build and still
   *    withhold the signature. That path is untouched.
   *
   * Retryability does not come from index_failures here, it comes from the
   * row itself: source_kind='metadata-only' is excluded by getItemsToSkip, so
   * every later incremental build tries the body again, and it survives
   * restarts because it lives in the database rather than in a session's
   * failure list.
   */
  private noteBodyExtractionOutcome(
    item: any,
    bodyState: 'body' | 'metadata-only' | 'no-source',
    extracted: ExtractedItemContent,
    outcome: IndexWorkOutcome,
  ): IndexWorkOutcome {
    if (bodyState !== 'metadata-only') return outcome;
    if (outcome.status !== 'succeeded') return outcome;
    this.indexProgress.bodyFailures =
      (this.indexProgress.bodyFailures || 0) + 1;
    ztoolkit.log(
      `[SemanticSearch] indexItem() ${item.key}: counted as a body-text failure ` +
        `(bodyFailures=${this.indexProgress.bodyFailures}); the index row is complete and marked metadata-only, ` +
        `so the build is not failed. Tried: ${extracted.failedSources.join('; ') || 'no source produced text'}`,
      'warn',
    );
    return outcome;
  }

  /**
   * Whether one item's stored index actually holds its body text.
   *
   * The single question search_fulltext has to ask before it digs into a
   * document: without it, a paper indexed from its title and abstract alone
   * looks identical to one whose full text was parsed.
   */
  async getItemBodyIndexState(
    itemKey: string,
    libraryID?: number,
  ): Promise<BodyIndexState> {
    await this.initialize();
    const status = await this.vectorStore.getIndexStatus(itemKey, libraryID);
    if (!status) return 'missing';
    return bodyIndexStateFromSourceKind(status.sourceKind);
  }

  /**
   * The same question for a whole page of search results, in one query.
   *
   * Returned keyed `libraryID:itemKey`. An item with no index row is reported
   * as 'missing' rather than omitted, so the caller cannot mistake "not in the
   * map" for "has full text".
   */
  async getItemBodyIndexStates(
    identities: Array<{ itemKey: string; libraryID?: number }>,
  ): Promise<Map<string, BodyIndexState>> {
    const states = new Map<string, BodyIndexState>();
    if (identities.length === 0) return states;
    await this.initialize();
    const sourceKinds = await this.vectorStore.getSourceKinds(identities);
    for (const identity of identities) {
      const libraryID = identity.libraryID ?? Zotero.Libraries.userLibraryID;
      const mapKey = `${libraryID}:${identity.itemKey}`;
      states.set(
        mapKey,
        sourceKinds.has(mapKey)
          ? bodyIndexStateFromSourceKind(sourceKinds.get(mapKey))
          : 'missing',
      );
    }
    return states;
  }

  /**
   * Delete index for an item
   */
  async deleteItemIndex(itemKey: string, libraryID?: number): Promise<void> {
    // Deletion is local SQLite cleanup. It must not initialize or call the
    // Embedding service, especially when replaying a deleted item after restart.
    await this.vectorStore.initialize();
    // Drops BOTH indexes: deleteItemVectors removes the keyword postings too,
    // so direct callers and the persistent deletion queue get the same
    // guarantee without having to remember a second call.
    await this.vectorStore.deleteItemVectors(itemKey, libraryID);
    const effectiveLibraryID = libraryID ?? Zotero.Libraries.userLibraryID;
    this._failedItems.delete(`${effectiveLibraryID}:${itemKey}`);
    this.indexProgress.failedCount = this._failedItems.size;
    ztoolkit.log(`[SemanticSearch] Deleted index for item: ${itemKey} (libraryID=${libraryID ?? 'user'})`);
  }

  /**
   * Clear indexes. Pass a libraryID to clear only that library.
   */
  async clearIndex(libraryID?: number): Promise<void> {
    await this.initialize();
    // VectorStore.clear is the single atomic dual-index entry point.
    await this.vectorStore.clear(libraryID);
    ztoolkit.log(`[SemanticSearch] Index cleared (libraryID=${libraryID ?? 'all'})`);
  }

  // ============ Status Methods ============

  /**
   * Get service statistics
   */
  async getStats(): Promise<SemanticServiceStats> {
    await this.initialize();

    // One library for every figure below. Statistics that mixed a
    // whole-database vector count with a library-scoped keyword count could not
    // be added, subtracted or compared with each other at all.
    const libraryID = Zotero.Libraries.userLibraryID;

    const indexStats = await this.vectorStore.getStats(libraryID);
    // Both indexes, one call: the pane shows a combined total on top, and a
    // total assembled from two calls made at different moments would be a
    // number that was never simultaneously true.
    const keywordStats =
      await this.vectorStore.getKeywordIndexReport(libraryID);
    const documentTotals =
      await this.vectorStore.getIndexedDocumentTotals(libraryID);
    const storage = await this.vectorStore.getIndexStorageBreakdown();
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
      keywordStats,
      documentTotals,
      storage,
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
    return this._buildActive || this._activeIndexOperations > 0;
  }

  async beginDatabaseReset(): Promise<void> {
    if (this._databaseResetActive) {
      throw new Error('A search index database reset is already active');
    }
    this._databaseResetActive = true;
    if (this._buildActive) {
      this._aborted = true;
      this._paused = false;
      this.indexProgress.status = 'aborted';
      if (this._pauseResolve) {
        this._pauseResolve();
        this._pauseResolve = null;
      }
    }
    while (this.isBuildActive()) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  resetAfterDatabaseClear(): void {
    Zotero.Prefs.clear(PREF_INDEX_PROGRESS, true);
    const savedProgress = Zotero.Prefs.get(PREF_INDEX_PROGRESS, true);
    if (typeof savedProgress === 'string' && savedProgress.trim()) {
        throw new Error('Persisted search index progress could not be cleared');
    }
    this.embeddingService.clearQueryCache();
    this._failedItems.clear();
    this.indexProgress = {
      total: 0,
      processed: 0,
      status: 'idle',
      failedCount: 0,
      bodyFailures: 0,
    };
    this._paused = false;
    this._aborted = false;
    this._pauseResolve = null;
    this._forceRun = false;
    this._activeBuildID = null;
    this._activeFullLibraryRebuild = false;
  }

  endDatabaseReset(): void {
    this._databaseResetActive = false;
  }

  /**
   * Set callback for indexing errors
   * Called when an error occurs during indexing (auto-pauses)
   */
  setOnIndexError(callback: (error: EmbeddingAPIError) => void): void {
    this._onErrorCallback = callback;
  }

  /**
   * Set the handler that asks the user what to do about an oversized chunk.
   *
   * Registered by the preferences window, which is the only place that can put
   * a dialog on screen. When nothing is registered — a background auto-update,
   * an MCP-triggered build — there is nobody to ask, so the run stops. That is
   * the conservative half of the choice and matches what the plugin did before
   * this prompt existed.
   */
  setOnChunkTooLargeDecision(callback: ChunkTooLargeAsk): void {
    this._chunkOversizeGate.setAsk(callback);
  }

  /**
   * Decide what to do about an oversized chunk — asking at most once per run.
   *
   * Every later occurrence reuses the answer without a dialog, which is the
   * whole point: a library whose chunk length is too big for the model can
   * produce hundreds of these, and a prompt per document would be unusable.
   */
  private async resolveChunkTooLarge(
    item: any,
    error: EmbeddingAPIError,
  ): Promise<ChunkTooLargeDecision> {
    const request: ChunkTooLargeDecisionRequest = {
      itemKey: item.key,
      libraryID: item.libraryID ?? Zotero.Libraries.userLibraryID,
      title: this.safeItemTitle(item),
      message: error.getUserMessage(),
    };
    const decision = await this._chunkOversizeGate.decide(
      request,
      // A dialog that could not be shown must not be read as consent to drop
      // documents; the gate turns this into 'stop'.
      (promptError) =>
        ztoolkit.log(
          `[SemanticSearch] Oversized-chunk prompt failed, stopping: ${promptError}`,
          'warn',
        ),
    );
    ztoolkit.log(
      `[SemanticSearch] Oversized chunk on ${item.key}: '${decision}' applies to the rest of this run`,
      'warn',
    );
    return decision;
  }

  private safeItemTitle(item: any): string | undefined {
    try {
      const title = item?.getField?.('title');
      return typeof title === 'string' && title ? title : undefined;
    } catch {
      return undefined;
    }
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
    this.indexProgress.bodyFailures = 0;
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
   * Retry everything worth retrying: real indexing failures, and items whose
   * body text could not be read.
   *
   * The two come from different places on purpose. A real failure (embedding,
   * database, interruption) lives in index_failures. A failed body parse does
   * not — it is not an indexing failure and must not fail a build — so it is
   * recorded on the index row itself as source_kind='metadata-only'. Both are
   * durable across restarts, and both are things the user pressing "retry"
   * means to retry: their PDF may have been repaired, or MinerU switched on,
   * since the last run.
   */
  async retryFailedItems(onProgress?: (progress: IndexProgress) => void): Promise<IndexProgress> {
    await this.initialize();

    // Check BEFORE clearing failure markers: if another build is running,
    // buildIndex would reject the nested call after the bookkeeping was
    // already wiped, losing the failure records without retrying anything
    if (this.isBuildActive() || this._databaseResetActive) {
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

    // Items still stuck on metadata alone. They carry no buildID, so they
    // group by library only and never resume someone else's build session.
    const bodyRetries = (await this.vectorStore.getMetadataOnlyItems()).filter(
      (identity) => !failures.has(`${identity.libraryID}:${identity.itemKey}`),
    );

    if (failures.size === 0 && bodyRetries.length === 0) {
      ztoolkit.log('[SemanticSearch] No failed items to retry');
      return { ...this.indexProgress, total: 0, processed: 0, failedCount: 0, bodyFailures: 0, status: 'completed' };
    }

    ztoolkit.log(
      `[SemanticSearch] Retrying ${failures.size} failed items and ${bodyRetries.length} items whose body text failed`,
    );

    const merged: IndexProgress = {
      total: 0,
      processed: 0,
      failedCount: 0,
      bodyFailures: 0,
      indexed: 0,
      unchanged: 0,
      status: 'completed',
    };

    const batches: Array<{
      itemKeys: string[];
      libraryID: number;
      buildID?: string;
    }> = groupFailedIndexItems(failures.values()).map((group) => ({
      itemKeys: group.map((failure) => failure.itemKey),
      libraryID: group[0].libraryID,
      buildID: group[0].buildID,
    }));

    const bodyByLibrary = new Map<number, string[]>();
    for (const identity of bodyRetries) {
      const keys = bodyByLibrary.get(identity.libraryID) ?? [];
      keys.push(identity.itemKey);
      bodyByLibrary.set(identity.libraryID, keys);
    }
    for (const [libraryID, itemKeys] of bodyByLibrary) {
      batches.push({ itemKeys, libraryID });
    }

    for (const batch of batches) {
      const session = batch.buildID
        ? await this.vectorStore.getBuildSession(batch.buildID)
        : null;
      const result = await this.buildIndex({
        itemKeys: batch.itemKeys,
        libraryID: batch.libraryID,
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
      merged.bodyFailures =
        (merged.bodyFailures ?? 0) + (result.bodyFailures ?? 0);
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
   * Extract the text of one item for indexing, and report where it came from.
   *
   * The return value is deliberately not a bare string. A string cannot
   * distinguish "this paper's body text is in the index" from "every parser
   * failed and all we have is the title and abstract", and that distinction is
   * the whole point: the second case is an indexing FAILURE that used to be
   * reported as success, which in turn let search_fulltext dig into a document
   * that has no body text and hand back metadata as if it were evidence.
   *
   * Annotations and highlights are deliberately NOT part of this. The body
   * index is title + abstract + PDF/Markdown/plain-text/note body, nothing
   * else; Zotero's own annotation features and the separate annotation MCP
   * tools are untouched.
   *
   * @param item The Zotero item
   * @param sharedProcessor Optional shared PDFProcessor for better performance
   */
  private async extractItemContent(
    item: any,
    sharedProcessor?: PDFProcessor | null,
  ): Promise<ExtractedItemContent> {
    const parts: string[] = [];
    /**
     * Body texts already collected, so the same body cannot be added twice.
     *
     * The title-based de-duplication only recognises Markdown that MinerU named
     * `MinerU Markdown (KEY).md`; an attachment that lost that title — this
     * library has one called simply `full.md` — would still slip through. This is
     * the backstop, and it is content-based, so it holds whatever the attachment
     * is called and whatever MIME type it claims.
     */
    const bodyFingerprints = new Set<string>();
    /**
     * Add body text unless the identical text is already in `parts`.
     *
     * Returns whether it was added, so a caller can still record its source
     * honestly: "this attachment produced text" and "that text was new" are
     * different facts.
     */
    const addBodyPart = (text: string): boolean => {
      const fingerprint = text.trim();
      if (!fingerprint) return false;
      if (bodyFingerprints.has(fingerprint)) return false;
      bodyFingerprints.add(fingerprint);
      parts.push(text);
      return true;
    };
    /** Sources that could have produced body text, whether or not they did. */
    const attemptedSources: string[] = [];
    /** Sources that actually produced body text. */
    const bodySources: string[] = [];
    /** Sources that were tried and produced nothing. */
    const failedSources: string[] = [];
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

      // Body text from attachments
      if (item.isRegularItem?.()) {
        const attachmentIds = item.getAttachments?.() || [];
        const originalPDFs = await getOriginalPDFAttachmentsForItem(item);
        const originalPDFIds = new Set(originalPDFs.map((attachment) => attachment.id));

        // Collected first, then processed in a fixed order, so a Markdown
        // attachment can be skipped when the PDF it was generated from already
        // supplied the same text.
        const pdfAttachments: any[] = [];
        const markdownAttachments: any[] = [];
        const plainTextAttachments: any[] = [];
        /** Keys of every PDF still attached, and of the originals among them. */
        const presentPDFKeys = new Set<string>();
        const originalPDFKeys = new Set<string>();

        for (const attachmentId of attachmentIds) {
          try {
            const attachment = await Zotero.Items.getAsync(attachmentId);
            if (!attachment) continue;
            if (attachment.isPDFAttachment?.()) {
              presentPDFKeys.add(attachment.key);
              if (originalPDFIds.has(attachment.id)) {
                originalPDFKeys.add(attachment.key);
                pdfAttachments.push(attachment);
              }
              continue;
            }
            /*
             * Classify by extension as well as by MIME type.
             *
             * MinerU writes its Markdown as `full.md` with contentType
             * `text/plain`, so a MIME-only test dropped it into the plain-text
             * branch — which has no de-duplication against the PDF it was
             * generated from. The result was that every MinerU-processed paper
             * had its body indexed TWICE: measured on this library, one item held
             * 157 chunks of which only 91 were distinct, doubling both its term
             * frequencies and its document length and so distorting every
             * length-normalised score, on top of doubling the embedding spend.
             */
            const filename = String(
              attachment.attachmentFilename ||
                attachment.getFilePath?.() ||
                '',
            ).toLowerCase();
            const looksMarkdown =
              attachment.attachmentContentType === 'text/markdown' ||
              filename.endsWith('.md') ||
              filename.endsWith('.markdown');
            if (looksMarkdown) {
              markdownAttachments.push(attachment);
              continue;
            }
            if (attachment.attachmentContentType === 'text/plain') {
              plainTextAttachments.push(attachment);
            }
          } catch (e) {
            ztoolkit.log(`[SemanticSearch] extractItemContent() attachment error: ${e}`, 'warn');
          }
        }

        ztoolkit.log(
          `[SemanticSearch] attachment selection: ${attachmentIds.length} total, ` +
            `${pdfAttachments.length} original PDF, ${markdownAttachments.length} markdown, ` +
            `${plainTextAttachments.length} plain text`,
        );

        if (pdfAttachments.length === 0 && presentPDFKeys.size > 0) {
          // Every PDF on this item was filtered out as a generated duplicate.
          // The user still sees a PDF, so silently reporting "no body source"
          // would hide a real problem.
          attemptedSources.push('pdf:(all filtered as generated duplicates)');
          failedSources.push(
            `pdf: ${presentPDFKeys.size} attachment(s) present but none selected as the original PDF`,
          );
        }

        /** PDFs whose body text we already have; their .md is a duplicate. */
        const pdfKeysWithText = new Set<string>();

        for (const attachment of pdfAttachments) {
          const label = `pdf:${attachment.key}`;
          attemptedSources.push(label);
          try {
            const filePath = await attachment.getFilePathAsync?.();
            if (!filePath) {
              ztoolkit.log(`[SemanticSearch] extractItemContent() no file path for attachment ${attachment.key}`);
              failedSources.push(`${label} (file missing)`);
              continue;
            }
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
              addBodyPart(minerUText);
              pdfKeysWithText.add(attachment.key);
              bodySources.push(`${label} (MinerU)`);
              ztoolkit.log(`[SemanticSearch] extractItemContent() got MinerU text: ${minerUText.length} chars`);
              continue;
            }

            // 回退：Zotero 内置 pdfWorker 提取
            // Use shared processor if provided (much faster for batch processing)
            const processor = sharedProcessor || new PDFProcessor(ztoolkit);
            const shouldTerminate = !sharedProcessor;  // Only terminate if we created it
            try {
              const textContent = await processor.extractText(filePath);
              if (textContent && textContent.length > 0) {
                // Complete body text, same as the MinerU branch above.
                warnIfHugeDocument(item.key, textContent.length, 'pdfWorker');
                addBodyPart(textContent);
                pdfKeysWithText.add(attachment.key);
                bodySources.push(`${label} (pdfWorker)`);
                ztoolkit.log(`[SemanticSearch] extractItemContent() got PDF text: ${textContent.length} chars`);
              } else {
                ztoolkit.log(`[SemanticSearch] extractItemContent() PDF extraction returned empty`);
                failedSources.push(`${label} (MinerU and pdfWorker both returned nothing)`);
              }
            } finally {
              if (shouldTerminate) {
                processor.terminate();
              }
            }
          } catch (pdfError) {
            ztoolkit.log(`[SemanticSearch] extractItemContent() PDF extraction failed: ${pdfError}`, 'warn');
            failedSources.push(`${label} (${pdfError})`);
          }
        }

        // Markdown bodies. This is what keeps a paper searchable after its PDF
        // is deleted: the generated .md is still a complete body text, and it
        // is read directly here rather than through the PDF it came from,
        // which no longer exists to be stat'ed.
        for (const attachment of markdownAttachments) {
          const sourcePDFKey = generatedMarkdownSourceKey(attachment);
          if (sourcePDFKey && pdfKeysWithText.has(sourcePDFKey)) {
            // Same text we already took from the PDF itself.
            continue;
          }
          if (
            sourcePDFKey &&
            presentPDFKeys.has(sourcePDFKey) &&
            !originalPDFKeys.has(sourcePDFKey)
          ) {
            // Belongs to a translated/duplicate PDF the selection deliberately
            // ignores; indexing it would double the paper's body text.
            continue;
          }
          const label = `markdown:${attachment.key}`;
          attemptedSources.push(label);
          try {
            const filePath = await attachment.getFilePathAsync?.();
            if (!filePath) {
              failedSources.push(`${label} (file missing)`);
              continue;
            }
            const raw = await Zotero.File.getContentsAsync(filePath);
            const text = raw ? markdownToIndexText(String(raw)).trim() : '';
            if (text) {
              warnIfHugeDocument(item.key, text.length, 'Markdown attachment');
              addBodyPart(text);
              bodySources.push(label);
              ztoolkit.log(`[SemanticSearch] extractItemContent() got Markdown attachment text: ${text.length} chars`);
            } else {
              failedSources.push(`${label} (empty)`);
            }
          } catch (e) {
            ztoolkit.log(`[SemanticSearch] extractItemContent() markdown extraction failed: ${e}`, 'warn');
            failedSources.push(`${label} (${e})`);
          }
        }

        for (const attachment of plainTextAttachments) {
          const label = `text:${attachment.key}`;
          attemptedSources.push(label);
          try {
            const filePath = await attachment.getFilePathAsync?.();
            if (!filePath) {
              failedSources.push(`${label} (file missing)`);
              continue;
            }
            const textContent = await Zotero.File.getContentsAsync(filePath);
            if (textContent && textContent.length > 0) {
              addBodyPart(textContent);
              bodySources.push(label);
              ztoolkit.log(`[SemanticSearch] extractItemContent() got plain text: ${textContent.length} chars`);
            } else {
              failedSources.push(`${label} (empty)`);
            }
          } catch (e) {
            ztoolkit.log(`[SemanticSearch] extractItemContent() plain text extraction failed: ${e}`, 'warn');
            failedSources.push(`${label} (${e})`);
          }
        }
      }

      // Notes indexed on their own. Annotations are NOT indexed at all any
      // more — neither an annotation item itself nor the annotations hanging
      // off a PDF attachment.
      if (item.isNote?.()) {
        attemptedSources.push(`note:${item.key}`);
        const noteText = item.getNote?.();
        const text = noteText ? TextFormatter.htmlToText(noteText) : '';
        if (text.trim()) {
          addBodyPart(text);
          bodySources.push(`note:${item.key}`);
        } else {
          failedSources.push(`note:${item.key} (empty)`);
        }
      }

    } catch (error) {
      ztoolkit.log(`[SemanticSearch] extractItemContent() error: ${error}`, 'warn');
    }

    const result = parts.join('\n\n');
    ztoolkit.log(
      `[SemanticSearch] extractItemContent() done: ${parts.length} parts, total ${result.length} chars, ` +
        `bodySources=[${bodySources.join(', ')}], failedSources=[${failedSources.join(', ')}]`,
    );
    return {
      text: result,
      hasBody: bodySources.length > 0,
      hasBodySource: attemptedSources.length > 0,
      bodySources,
      failedSources,
    };
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
  /**
   * @throws {ItemEnumerationError} Never returns `[]` to mean "could not ask".
   *   buildIndex clears the library against this list, so a failed enumeration
   *   must abort the run rather than present itself as an empty library.
   */
  private async getItemsWithContent(
    libraryID: number = Zotero.Libraries.userLibraryID,
  ): Promise<any[]> {
    return enumerateLibraryItems(libraryID);
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
