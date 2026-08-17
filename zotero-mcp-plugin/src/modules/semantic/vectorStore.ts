/**
 * Vector Store for Semantic Search
 *
 * SQLite-based vector storage using Zotero's database infrastructure.
 * Stores embeddings as BLOBs and performs similarity search in memory.
 */

declare let Zotero: any;
declare let ztoolkit: ZToolkit;
declare let PathUtils: any;
declare let IOUtils: any;

import { bodyIndexStateFromSourceKind } from './bodyIndexState';
import {
  VectorDimensionMismatchError,
  isVectorDimensionMismatchError,
} from './dimensionMismatch';
import {
  runVectorScanBenchmark,
  type VectorScanBenchmarkResult,
} from './vectorScanBenchmark';
import {
  getGpuVectorService,
} from './gpuVectorService';
import type {
  GpuVectorDataProvider,
  GpuVectorIdentity,
  GpuVectorMutation,
  GpuVectorPrecision,
  GpuVectorSearchBackend,
  GpuVectorSearchRequest,
  GpuVectorSnapshotInfo,
  GpuVectorSnapshotRow,
} from './gpuVectorBackend';

/**
 * Make a streamed SQLite row readable by column name.
 *
 * Zotero's `queryAsync` only wraps rows in its name-resolving Proxy on the path
 * that RETURNS them (db.js: "the individual rows are Proxy objects that return
 * values from the underlying mozIStorageRows based on column names"). Supply an
 * `onRow` callback and two things change: the callback receives a raw
 * mozIStorageRow, and the function returns undefined instead of any rows. On a
 * raw row, `row.dimensions` is not the column — it is just a missing property —
 * so every mapper in this file silently produced rows of all-undefined values.
 *
 * This mirrors Zotero's own handler, which is what makes it correct: values come
 * from `getResultByName`, the sanctioned accessor. Rows that already resolve
 * names (the non-streaming path, and the plain objects used by tests) are passed
 * through untouched.
 *
 * A column the query did not select resolves to `undefined` rather than
 * throwing. That is deliberate: `mapScanRow` is shared by the Int8 and Float32
 * scan queries, which select different columns, and Zotero cancels the whole
 * query and rethrows if an onRow callback throws — so a strict lookup would
 * abort the scan instead of leaving one field empty.
 */
const STREAMED_ROW_HANDLER: ProxyHandler<any> = {
  get(target: any, name: string | symbol) {
    // Guard the await/thenable probe: without this a row would look like a
    // promise to any code that awaits it.
    if (typeof name !== 'string' || name === 'then') return undefined;
    try {
      return target.getResultByName(name);
    } catch {
      return undefined;
    }
  },
  has(target: any, name: string | symbol) {
    if (typeof name !== 'string') return false;
    try {
      target.getResultByName(name);
      return true;
    } catch {
      return false;
    }
  },
};

function wrapStreamedRow(row: any): any {
  if (!row || typeof row.getResultByName !== 'function') return row;
  return new Proxy(row, STREAMED_ROW_HANDLER);
}

export interface VectorRecord {
  itemKey: string;
  libraryID?: number;
  chunkId: number;
  vector: Float32Array;
  language: 'zh' | 'en';
  chunkText: string;
  metadata?: Record<string, any>;
}

// Int8 quantized vector for fast search
export interface QuantizedVector {
  int8Data: Int8Array;
  scale: number;
  norm: number;  // Pre-computed L2 norm for faster cosine similarity
}

export interface SearchResult {
  itemKey: string;
  libraryID: number;
  chunkId: number;
  score: number;
  chunkText: string;
  language: string;
  /** Internal database identity used for batched text hydration. */
  rowId?: number;
}

export interface VectorSearchOptions {
  topK?: number;
  /** Aggregate chunks by document and optionally cap distinct documents. */
  groupByItem?: boolean;
  documentLimit?: number;
  maxChunksPerItem?: number;
  includeChunkText?: boolean;
  language?: 'zh' | 'en' | 'all';
  itemKeys?: string[];
  minScore?: number;
  libraryID?: number;
  /**
   * Scan every stored vector regardless of which library it belongs to.
   *
   * Only the scan benchmark uses this: retrieval is always library-scoped.
   * Ignored when `itemKeys` is given, which is a narrower scope already.
   */
  allLibraries?: boolean;
  deadlineAt?: number;
  signal?: AbortSignal;
  /** Filled in with how many stored vectors this scan actually read. */
  stats?: { scanned?: number };
}

/** One chunk of a candidate document, scored against ONE query vector. */
export interface MultiQueryChunkHit {
  chunkId: number;
  score: number;
  rowId?: number;
}

/**
 * A candidate document's best chunks, kept separately per query vector.
 *
 * `perQuery[i]` belongs to `queryVectors[i]` and is sorted best-first. The
 * store deliberately stops here instead of collapsing the two dimensions into
 * one number: how a document's per-query evidence becomes one document score is
 * a ranking decision (see similarDocumentAggregation), not a storage one.
 */
export interface MultiQueryDocumentMatch {
  itemKey: string;
  libraryID: number;
  perQuery: MultiQueryChunkHit[][];
}

export interface MultiQuerySearchOptions {
  /** How many chunks to keep per document PER query vector. */
  chunksPerQuery?: number;
  language?: 'zh' | 'en' | 'all';
  itemKeys?: string[];
  /** Documents dropped from the result — normally the query document itself. */
  excludeItemKeys?: string[];
  /**
   * Chunk-level floor. Callers that aggregate per document should pass -1
   * (keep everything): a chunk omitted here is indistinguishable from a chunk
   * the document does not have, so any floor above the lowest possible cosine
   * silently changes what the aggregate means — see findSimilarByChunks.
   */
  minChunkScore?: number;
  libraryID?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
  stats?: { scanned?: number; documents?: number };
}

export interface IndexStatus {
  itemKey: string;
  indexedAt: number;
  chunkCount: number;
  contentHash: string;
  version: number;
  itemModified?: string;       // Item's dateModified for fast change detection
  attachmentModified?: string; // Latest attachment dateModified
  contentLength: number;
  sourceKind: string;
  /**
   * The body-extraction configuration in force at the last attempt. Read by
   * decideBodyRetry so that changing MinerU's settings re-opens items whose
   * body could not be parsed. NULL for rows predating the column.
   */
  bodyRetrySignature?: string | null;
}

export interface FailedIndexItem {
  libraryID: number;
  itemKey: string;
  errorType: string;
  error: string;
  timestamp: number;
  buildID?: string;
}

export type IndexBuildTargetState = 'pending' | 'succeeded' | 'failed';

export interface IndexBuildTarget {
  libraryID: number;
  itemKey: string;
  state: IndexBuildTargetState;
}

export interface IndexBuildSession {
  buildID: string;
  libraryID: number;
  scope: 'full-library' | 'targeted' | 'incremental';
  /**
   * 'incomplete' is a run that finished but deliberately left documents out
   * (an oversized chunk the user chose to skip). It is intentionally absent
   * from getResumableBuildSession's list: the run is over, and the skipped
   * documents are reachable through the failed-items retry instead.
   */
  status:
    | 'indexing'
    | 'paused'
    | 'failed'
    | 'aborted'
    | 'completed'
    | 'incomplete';
  chunkSignature?: string;
  chunkTargetChars?: number;
  chunkAppendToleranceChars?: number;
  createdAt: number;
  resetCompleted?: boolean;
}

export interface IndexBuildTargetSummary {
  total: number;
  pending: number;
  succeeded: number;
  failed: number;
}

export interface VectorStoreStats {
  totalVectors: number;
  totalItems: number;
  zhVectors: number;
  enVectors: number;
  dbSizeBytes?: number;
  // Content cache stats
  cachedContentItems: number;
  cachedContentSizeBytes: number;
  storageMode: 'on-demand';
  // Extended stats for detailed view
  storedDimensions?: number;        // Dimensions of stored vectors
  int8MigrationStatus?: {
    migrated: number;
    total: number;
    percent: number;
  };
  /**
   * How many indexed items actually hold body text, so "N items indexed" can
   * no longer hide a pile of items that are only a title and an abstract.
   */
  bodyCoverage?: {
    /** Body text (PDF / Markdown / text / note) is in the index. */
    withBody: number;
    /** A body source exists but could not be parsed — an indexing failure. */
    metadataOnly: number;
    /** No body source exists; metadata-only is expected for these. */
    noBodySource: number;
    /** Indexed before this was recorded; treated as "has body" until refreshed. */
    unknown: number;
  };
  dbPath?: string;                  // Path to database file
}

export const SEMANTIC_BUSINESS_TABLES = [
  'embeddings',
  'vectors_f32',
  'index_status',
  'index_failures',
  'index_build_targets',
  'index_builds',
] as const;

type SemanticBusinessTable = (typeof SEMANTIC_BUSINESS_TABLES)[number];
type SemanticBusinessCounts = Record<SemanticBusinessTable, number>;

export interface SemanticDatabaseClearReport {
  before: SemanticBusinessCounts;
  after: SemanticBusinessCounts;
  database: {
    path: string;
    beforeBytes?: number;
    afterBytes?: number;
    walBeforeBytes?: number;
    walAfterBytes?: number;
    shmBeforeBytes?: number;
    shmAfterBytes?: number;
    pageCountBefore: number;
    pageCountAfter: number;
    freelistBefore: number;
    freelistAfter: number;
  };
}

export interface SemanticLibraryDataCounts {
  chunkCount: number;
  float32VectorCount: number;
  indexedItemCount: number;
}

// Global instance counter for debugging
let vectorStoreInstanceCounter = 0;

export class VectorStore {
  private dbPath: string = '';
  private db: any = null;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  // In-memory cache for frequently accessed vectors
  private vectorCache: Map<string, Float32Array> = new Map();
  private cacheMaxSize: number = 1000;

  // Debug: instance ID for tracking multiple instances
  private instanceId: number;
  private readonly gpuBackend: GpuVectorSearchBackend;
  private readonly gpuDataProvider: GpuVectorDataProvider;

  constructor(gpuBackend: GpuVectorSearchBackend = getGpuVectorService()) {
    this.gpuBackend = gpuBackend;
    this.gpuDataProvider = {
      getSnapshotInfo: () => this.getGpuSnapshotInfo(),
      readSnapshotBatch: (afterRowId, limit, precision) =>
        this.readGpuSnapshotBatch(afterRowId, limit, precision),
      readItems: (identities, precision) =>
        this.readGpuItems(identities, precision),
    };
    this.gpuBackend.registerProvider(this.gpuDataProvider);
    this.instanceId = ++vectorStoreInstanceCounter;
    ztoolkit.log(`[VectorStore] Constructor called, instanceId=${this.instanceId}, total instances=${vectorStoreInstanceCounter}`);
  }

  private toStorageKey(itemKey: string, libraryID?: number): string {
    const effectiveLibraryID =
      libraryID ?? Zotero.Libraries.userLibraryID;
    return effectiveLibraryID === Zotero.Libraries.userLibraryID
      ? itemKey
      : `${effectiveLibraryID}:${itemKey}`;
  }

  private fromStorageKey(storageKey: string): {
    itemKey: string;
    libraryID: number;
  } {
    const match = storageKey.match(/^(\d+):(.+)$/);
    return match
      ? { libraryID: Number(match[1]), itemKey: match[2] }
      : {
          libraryID: Zotero.Libraries.userLibraryID,
          itemKey: storageKey,
        };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    try {
      // Get Zotero data directory
      const dataDir = Zotero.DataDirectory.dir;
      this.dbPath = PathUtils.join(dataDir, 'zotero-mcp-vectors.sqlite');

      ztoolkit.log(`[VectorStore] Initializing database: instanceId=${this.instanceId}, dbPath=${this.dbPath}`);

      // Create database connection
      this.db = new Zotero.DBConnection(this.dbPath);

      // Create tables
      await this.createTables();

      // Check database integrity
      const isHealthy = await this.checkAndRepairDatabase();
      if (!isHealthy) {
        // Database was recreated after corruption, re-create tables
        await this.createTables();
      }

      this.initialized = true;
      ztoolkit.log('[VectorStore] Initialized successfully');
      if (this.gpuBackend.isEnabled()) {
        void this.gpuBackend.startIfEnabled().catch(() => {
          // The backend records its own fallback state and user notification.
        });
      }
    } catch (error) {
      ztoolkit.log(`[VectorStore] Initialization failed: ${error}`, 'error');
      throw error;
    }
  }

  /**
   * Check database integrity and attempt repair if corrupted.
   * Returns true if database is healthy (or was successfully repaired in-place).
   * Returns false if database was recreated from scratch (tables need to be re-created).
   */
  private async checkAndRepairDatabase(): Promise<boolean> {
    try {
      // Quick integrity check on all tables
      const result = await this.db.valueQueryAsync(`PRAGMA integrity_check(1)`);
      if (result === 'ok') {
        ztoolkit.log('[VectorStore] Database integrity check passed');
        return true;
      }

      ztoolkit.log(`[VectorStore] Database integrity check FAILED: ${result}`, 'warn');

      // Step 1: Try REINDEX to fix index corruption (most common cause)
      try {
        ztoolkit.log('[VectorStore] Attempting repair via REINDEX...');
        await this.db.queryAsync(`REINDEX`);

        // Re-check after REINDEX
        const recheck = await this.db.valueQueryAsync(`PRAGMA integrity_check(1)`);
        if (recheck === 'ok') {
          ztoolkit.log('[VectorStore] Database repaired successfully via REINDEX');
          return true;
        }
        ztoolkit.log(`[VectorStore] REINDEX did not fix corruption: ${recheck}`, 'warn');
      } catch (reindexError) {
        ztoolkit.log(`[VectorStore] REINDEX failed: ${reindexError}`, 'warn');
      }

      // Step 2: Close corrupted db, backup and recreate
      ztoolkit.log('[VectorStore] Corruption cannot be repaired in-place, recreating database...');

      // Close current connection
      try {
        await this.db.closeDatabase();
      } catch (closeError) {
        ztoolkit.log(`[VectorStore] Error closing corrupted db: ${closeError}`, 'warn');
      }

      // Rename corrupted file as backup
      const backupPath = this.dbPath + '.corrupt.' + Date.now();
      try {
        await IOUtils.move(this.dbPath, backupPath);
        ztoolkit.log(`[VectorStore] Corrupted database backed up to: ${backupPath}`);
      } catch (moveError) {
        ztoolkit.log(`[VectorStore] Failed to backup corrupted db: ${moveError}`, 'warn');
        // Try to remove it directly
        try {
          await IOUtils.remove(this.dbPath);
        } catch (removeError) {
          ztoolkit.log(`[VectorStore] Failed to remove corrupted db: ${removeError}`, 'error');
          throw new Error(`Database is corrupted and cannot be removed: ${removeError}`);
        }
      }

      // Also remove WAL/SHM files if they exist
      for (const suffix of ['-wal', '-shm']) {
        try {
          await IOUtils.remove(this.dbPath + suffix);
        } catch (_) {
          // May not exist, ignore
        }
      }

      // Create fresh connection
      this.db = new Zotero.DBConnection(this.dbPath);
      ztoolkit.log('[VectorStore] Fresh database created after corruption recovery');

      // Notify user
      try {
        new ztoolkit.ProgressWindow("Zotero MCP Plugin", { closeOtherProgressWindows: false })
          .createLine({
            text: "检测到索引数据库损坏，已自动重建。旧文件已备份。\nCorrupted index database detected and rebuilt. Old file backed up.",
            type: "default",
          })
          .show();
      } catch (_) {
        // UI notification is non-critical
      }

      return false; // Tables need to be re-created
    } catch (error) {
      // integrity_check itself failed - likely severe corruption
      ztoolkit.log(`[VectorStore] Integrity check query failed: ${error}`, 'error');

      // Try the same backup-and-recreate approach
      try {
        try { await this.db.closeDatabase(); } catch (_) {
          // DB may not be open; closing is best effort before the file is moved.
        }

        const backupPath = this.dbPath + '.corrupt.' + Date.now();
        try {
          await IOUtils.move(this.dbPath, backupPath);
          ztoolkit.log(`[VectorStore] Severely corrupted database backed up to: ${backupPath}`);
        } catch (_) {
          await IOUtils.remove(this.dbPath);
        }

        for (const suffix of ['-wal', '-shm']) {
          try { await IOUtils.remove(this.dbPath + suffix); } catch (_) {
            // -wal/-shm may not exist; removal is best effort.
          }
        }

        this.db = new Zotero.DBConnection(this.dbPath);
        ztoolkit.log('[VectorStore] Fresh database created after severe corruption');

        try {
          new ztoolkit.ProgressWindow("Zotero MCP Plugin", { closeOtherProgressWindows: false })
            .createLine({
              text: "检测到索引数据库严重损坏，已自动重建。旧文件已备份。\nSeverely corrupted index database detected and rebuilt. Old file backed up.",
              type: "default",
            })
            .show();
        } catch (_) {
          // The rebuild notice is cosmetic; never let it mask the recovery result.
        }

        return false;
      } catch (recreateError) {
        ztoolkit.log(`[VectorStore] Failed to recreate database after corruption: ${recreateError}`, 'error');
        throw recreateError;
      }
    }
  }

  private async createTables(): Promise<void> {
    // Embeddings table
    // Note: vector column retains NOT NULL for backward compatibility with older schemas.
    // Float32 vectors are stored in separate vectors_f32 table. This column holds empty
    // blob x'' after migration. New inserts also write x'' here.
    await this.db.queryAsync(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_key TEXT NOT NULL,
        chunk_id INTEGER NOT NULL,
        vector BLOB NOT NULL,
        language TEXT NOT NULL CHECK(language IN ('zh', 'en')),
        chunk_text TEXT,
        dimensions INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(item_key, chunk_id)
      )
    `);

    // Index for faster lookups
    await this.db.queryAsync(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_item_key
      ON embeddings(item_key)
    `);

    await this.db.queryAsync(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_language
      ON embeddings(language)
    `);

    // Index status table - tracks indexing state and timestamps for change detection
    await this.db.queryAsync(`
      CREATE TABLE IF NOT EXISTS index_status (
        item_key TEXT PRIMARY KEY,
        indexed_at INTEGER NOT NULL,
        version INTEGER DEFAULT 1,
        chunk_count INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        item_modified TEXT,
        attachment_modified TEXT,
        content_length INTEGER NOT NULL DEFAULT 0,
        source_kind TEXT NOT NULL DEFAULT 'on-demand',
        body_retry_signature TEXT
      )
    `);

    await this.db.queryAsync(`
      CREATE TABLE IF NOT EXISTS index_failures (
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        error_type TEXT NOT NULL,
        error_message TEXT NOT NULL,
        failed_at INTEGER NOT NULL,
        build_id TEXT,
        PRIMARY KEY (library_id, item_key)
      )
    `);

    await this.db.queryAsync(`
      CREATE TABLE IF NOT EXISTS index_builds (
        build_id TEXT PRIMARY KEY,
        library_id INTEGER NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        chunk_signature TEXT,
        chunk_target_chars INTEGER,
        chunk_append_tolerance_chars INTEGER,
        created_at INTEGER NOT NULL,
        reset_completed INTEGER NOT NULL DEFAULT 0
      )
    `);

    try {
      await this.db.queryAsync(
        `ALTER TABLE index_builds ADD COLUMN reset_completed INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      // Column already exists.
    }

    await this.db.queryAsync(`
      CREATE TABLE IF NOT EXISTS index_build_targets (
        build_id TEXT NOT NULL,
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (build_id, library_id, item_key)
      )
    `);

    await this.migrateLegacyFailureMarkers();

    // Migrate existing tables - add new columns if they don't exist
    try {
      await this.db.queryAsync(`ALTER TABLE index_status ADD COLUMN item_modified TEXT`);
    } catch (e) {
      // Column already exists, ignore
    }
    try {
      await this.db.queryAsync(`ALTER TABLE index_status ADD COLUMN attachment_modified TEXT`);
    } catch (e) {
      // Column already exists, ignore
    }
    try {
      await this.db.queryAsync(
        `ALTER TABLE index_status ADD COLUMN content_length INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      // Column already exists.
    }
    try {
      await this.db.queryAsync(
        `ALTER TABLE index_status ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'on-demand'`,
      );
    } catch {
      // Column already exists.
    }
    // The extraction configuration in force when this row's body text was last
    // attempted. NULL on rows written before the column existed, which
    // decideBodyRetry reads as "unknown, so allow one retry".
    try {
      await this.db.queryAsync(
        `ALTER TABLE index_status ADD COLUMN body_retry_signature TEXT`,
      );
    } catch {
      // Column already exists.
    }

    // Migration: Add Int8 quantized vector columns for optimized search
    // vector_int8: Int8 quantized vector data (1 byte per dimension vs 4 bytes)
    // vector_scale: Scale factor for dequantization
    // vector_norm: Pre-computed L2 norm for fast cosine similarity
    try {
      await this.db.queryAsync(`ALTER TABLE embeddings ADD COLUMN vector_int8 BLOB`);
      ztoolkit.log('[VectorStore] Added vector_int8 column');
    } catch (e) {
      // Column already exists, ignore
    }
    try {
      await this.db.queryAsync(`ALTER TABLE embeddings ADD COLUMN vector_scale REAL`);
      ztoolkit.log('[VectorStore] Added vector_scale column');
    } catch (e) {
      // Column already exists, ignore
    }
    try {
      await this.db.queryAsync(`ALTER TABLE embeddings ADD COLUMN vector_norm REAL`);
      ztoolkit.log('[VectorStore] Added vector_norm column');
    } catch (e) {
      // Column already exists, ignore
    }

    const legacyContentCache = Number(
      await this.db.valueQueryAsync(
        `SELECT COUNT(*) FROM sqlite_master WHERE type = ? AND name = ?`,
        ['table', 'content_cache'],
      ),
    );
    if (legacyContentCache > 0) {
      await this.db.queryAsync(`
        UPDATE index_status
        SET content_length = COALESCE(
              (SELECT LENGTH(full_content)
               FROM content_cache
               WHERE content_cache.item_key = index_status.item_key),
              content_length
            ),
            source_kind = 'legacy-source-on-demand'
        WHERE EXISTS (
          SELECT 1 FROM content_cache
          WHERE content_cache.item_key = index_status.item_key
        )
      `);
      await this.db.queryAsync(`DROP TABLE content_cache`);
    }

    // Float32 backup table - stores float32 vectors separately for space efficiency
    // With 3072-dim vectors: int8(4KB) + float32(12KB) = 16.8KB per row in one table
    // causes each row to occupy an entire 32KB SQLite page (47% waste).
    // Splitting allows: int8 rows (~4.5KB, 7/page) + float32 rows (~12KB, 2/page)
    await this.db.queryAsync(`
      CREATE TABLE IF NOT EXISTS vectors_f32 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_key TEXT NOT NULL,
        chunk_id INTEGER NOT NULL,
        vector BLOB NOT NULL,
        UNIQUE(item_key, chunk_id)
      )
    `);

    await this.db.queryAsync(`
      CREATE INDEX IF NOT EXISTS idx_vectors_f32_item_key
      ON vectors_f32(item_key)
    `);

    // Migration: move float32 vectors from embeddings to vectors_f32
    await this.migrateFloat32ToSeparateTable();

    if (legacyContentCache > 0) {
      await this.db.queryAsync(`PRAGMA wal_checkpoint(TRUNCATE)`);
      await this.db.queryAsync(`VACUUM`);
      await this.db.queryAsync(`PRAGMA wal_checkpoint(TRUNCATE)`);
      ztoolkit.log(
        '[VectorStore] Removed legacy SQLite body copies and compacted database',
      );
    }

    ztoolkit.log('[VectorStore] Tables created/verified');
  }

  private async migrateLegacyFailureMarkers(): Promise<void> {
    const rows = await this.db.queryAsync(
      `SELECT item_key, content_hash FROM index_status WHERE content_hash LIKE ?`,
      ['failed:%'],
    );
    for (const row of rows || []) {
      const identity = this.fromStorageKey(String(row.item_key));
      const errorType = String(row.content_hash).slice('failed:'.length) || 'unknown';
      await this.db.queryAsync(
        `INSERT OR IGNORE INTO index_failures (library_id, item_key, error_type, error_message, failed_at) VALUES (?, ?, ?, ?, ?)`,
        [identity.libraryID, identity.itemKey, errorType, 'Legacy indexing failure', Date.now()],
      );
      await this.db.queryAsync(
        `DELETE FROM index_status WHERE item_key = ? AND content_hash LIKE ?`,
        [row.item_key, 'failed:%'],
      );
    }
  }

  /**
   * Migrate float32 vectors from embeddings.vector to vectors_f32 table.
   * Idempotent: uses LENGTH(vector) > 0 to skip already-migrated rows
   * (migrated rows have empty blob x'', not real vector data).
   * Batch-based: 500 rows per transaction to limit memory and WAL usage.
   */
  private async migrateFloat32ToSeparateTable(): Promise<void> {
    // Check if there are any float32 vectors still in the embeddings table
    // LENGTH(vector) > 0 distinguishes real vectors from empty blob placeholder x''
    const remaining = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM embeddings WHERE LENGTH(vector) > 0`
    );

    if (!remaining || remaining === 0) {
      return; // Nothing to migrate
    }

    ztoolkit.log(`[VectorStore] Migrating ${remaining} float32 vectors to vectors_f32 table...`);

    // Show progress notification
    try {
      new ztoolkit.ProgressWindow("Zotero MCP Plugin", { closeOtherProgressWindows: false })
        .createLine({
          text: `正在优化向量数据库结构，共 ${remaining} 条记录...\nOptimizing vector database structure, ${remaining} records...`,
          type: "default",
        })
        .show();
    } catch (_) {
      // The progress window is cosmetic; migration must proceed regardless.
    }

    // Use pure SQL to migrate blobs - avoids JS blob binding issues (NS_ERROR_UNEXPECTED)
    // INSERT OR IGNORE ensures idempotency for partial re-runs
    await this.db.queryAsync(`
      INSERT OR IGNORE INTO vectors_f32 (item_key, chunk_id, vector)
      SELECT item_key, chunk_id, vector FROM embeddings WHERE LENGTH(vector) > 0
    `);

    // Clear float32 data from embeddings (x'' satisfies NOT NULL constraint)
    await this.db.queryAsync(`
      UPDATE embeddings SET vector = x'' WHERE LENGTH(vector) > 0
    `);

    ztoolkit.log(`[VectorStore] Float32 migration completed: ${remaining} vectors moved to vectors_f32`);

    // VACUUM to reclaim freed space from cleared float32 blobs
    try {
      ztoolkit.log('[VectorStore] Running VACUUM after float32 migration...');
      await this.db.queryAsync(`VACUUM`);
      ztoolkit.log('[VectorStore] VACUUM completed');
    } catch (e) {
      ztoolkit.log(`[VectorStore] VACUUM failed (non-critical): ${e}`, 'warn');
    }
  }

  /**
   * Insert a single vector with Int8 quantization for optimized search.
   * Float32 vector is stored in vectors_f32 table; embeddings table gets empty blob placeholder.
   */
  async insertVector(record: VectorRecord): Promise<void> {
    await this.ensureInitialized();

    const storageKey = this.toStorageKey(record.itemKey, record.libraryID);
    ztoolkit.log(`[VectorStore] insertVector: ${storageKey}_${record.chunkId}, dims=${record.vector.length}, lang=${record.language}`);

    const vectorBlob = this.float32ArrayToBuffer(record.vector);

    // Pre-compute Int8 quantized vector and norm for optimized search
    const quantized = this.quantizeWithNorm(record.vector);
    // Encode Int8 data as base64 string for reliable SQLite storage
    const int8Base64 = this.int8ArrayToBase64(quantized.int8Data);

    await this.db.executeTransaction(async () => {
      // Write int8 + metadata to embeddings (vector column = empty blob placeholder)
      await this.db.queryAsync(`INSERT OR REPLACE INTO embeddings (item_key, chunk_id, vector, language, chunk_text, dimensions, vector_int8, vector_scale, vector_norm) VALUES (?, ?, x'', ?, ?, ?, ?, ?, ?)`, [
        storageKey,
        record.chunkId,
        record.language,
        record.chunkText || '',
        record.vector.length,
        int8Base64,
        quantized.scale,
        quantized.norm
      ]);

      // Write float32 vector to separate table
      await this.db.queryAsync(`INSERT OR REPLACE INTO vectors_f32 (item_key, chunk_id, vector) VALUES (?, ?, ?)`, [
        storageKey,
        record.chunkId,
        vectorBlob
      ]);
    });

    // Update cache
    const cacheKey = `${storageKey}_${record.chunkId}`;
    this.updateCache(cacheKey, record.vector);
    await this.publishGpuMutation({
      kind: 'itemChanged',
      libraryID: record.libraryID ?? Zotero.Libraries.userLibraryID,
      itemKey: record.itemKey,
    });
  }

  /**
   * Insert multiple vectors in a transaction with Int8 quantization.
   * Float32 vectors are stored in vectors_f32 table; embeddings table gets empty blob placeholder.
   */
  async insertVectorsBatch(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    await this.ensureInitialized();

    await this.db.executeTransaction(async () => {
      for (const record of records) {
        const storageKey = this.toStorageKey(record.itemKey, record.libraryID);
        const vectorBlob = this.float32ArrayToBuffer(record.vector);

        // Pre-compute Int8 quantized vector and norm for optimized search
        const quantized = this.quantizeWithNorm(record.vector);
        // Encode Int8 data as base64 string for reliable SQLite storage
        const int8Base64 = this.int8ArrayToBase64(quantized.int8Data);

        // Write int8 + metadata to embeddings (vector column = empty blob placeholder)
        await this.db.queryAsync(`INSERT OR REPLACE INTO embeddings (item_key, chunk_id, vector, language, chunk_text, dimensions, vector_int8, vector_scale, vector_norm) VALUES (?, ?, x'', ?, ?, ?, ?, ?, ?)`, [
          storageKey,
          record.chunkId,
          record.language,
          record.chunkText || '',
          record.vector.length,
          int8Base64,
          quantized.scale,
          quantized.norm
        ]);

        // Write float32 vector to separate table
        await this.db.queryAsync(`INSERT OR REPLACE INTO vectors_f32 (item_key, chunk_id, vector) VALUES (?, ?, ?)`, [
          storageKey,
          record.chunkId,
          vectorBlob
        ]);
      }
    });

    ztoolkit.log(`[VectorStore] Inserted ${records.length} vectors with Int8 quantization`);
    const changedItems = new Map<string, GpuVectorIdentity>();
    for (const record of records) {
      const identity = {
        libraryID: record.libraryID ?? Zotero.Libraries.userLibraryID,
        itemKey: record.itemKey,
      };
      changedItems.set(`${identity.libraryID}:${identity.itemKey}`, identity);
    }
    for (const identity of changedItems.values()) {
      await this.publishGpuMutation({ kind: 'itemChanged', ...identity });
    }
  }

  async replaceItemIndex(options: {
    itemKey: string;
    libraryID: number;
    records: VectorRecord[];
    contentHash: string;
    contentLength: number;
    sourceKind: string;
    itemModified?: string;
    attachmentModified?: string;
    /** Extraction settings this attempt ran under; see bodyRetryPolicy. */
    bodyRetrySignature?: string;
    buildID?: string;
  }): Promise<void> {
    await this.ensureInitialized();
    const storageKey = this.toStorageKey(options.itemKey, options.libraryID);

    await this.db.executeTransaction(async () => {
      await this.db.queryAsync(`DELETE FROM embeddings WHERE item_key = ?`, [storageKey]);
      await this.db.queryAsync(`DELETE FROM vectors_f32 WHERE item_key = ?`, [storageKey]);

      for (const record of options.records) {
        const vectorBlob = this.float32ArrayToBuffer(record.vector);
        const quantized = this.quantizeWithNorm(record.vector);
        const int8Base64 = this.int8ArrayToBase64(quantized.int8Data);
        await this.db.queryAsync(
          `INSERT OR REPLACE INTO embeddings (item_key, chunk_id, vector, language, chunk_text, dimensions, vector_int8, vector_scale, vector_norm) VALUES (?, ?, x'', ?, ?, ?, ?, ?, ?)`,
          [
            storageKey,
            record.chunkId,
            record.language,
            record.chunkText || '',
            record.vector.length,
            int8Base64,
            quantized.scale,
            quantized.norm,
          ],
        );
        await this.db.queryAsync(
          `INSERT OR REPLACE INTO vectors_f32 (item_key, chunk_id, vector) VALUES (?, ?, ?)`,
          [storageKey, record.chunkId, vectorBlob],
        );
      }

      await this.db.queryAsync(
        `INSERT OR REPLACE INTO index_status (item_key, indexed_at, version, chunk_count, content_hash, item_modified, attachment_modified, content_length, source_kind, body_retry_signature) VALUES (?, strftime('%s', 'now'), 2, ?, ?, ?, ?, ?, ?, ?)`,
        [
          storageKey,
          options.records.length,
          options.contentHash,
          options.itemModified || null,
          options.attachmentModified || null,
          options.contentLength,
          options.sourceKind,
          options.bodyRetrySignature ?? null,
        ],
      );
      await this.db.queryAsync(
        `DELETE FROM index_failures WHERE library_id = ? AND item_key = ?`,
        [options.libraryID, options.itemKey],
      );
      if (options.buildID) {
        await this.db.queryAsync(
          `UPDATE index_build_targets SET state = 'succeeded' WHERE build_id = ? AND library_id = ? AND item_key = ?`,
          [options.buildID, options.libraryID, options.itemKey],
        );
      }
    });

    for (const key of this.vectorCache.keys()) {
      if (key.startsWith(`${storageKey}_`)) this.vectorCache.delete(key);
    }
    for (const record of options.records) {
      this.updateCache(`${storageKey}_${record.chunkId}`, record.vector);
    }
    await this.publishGpuMutation({
      kind: 'itemChanged',
      libraryID: options.libraryID,
      itemKey: options.itemKey,
    });
  }

  /**
   * Pick any indexed vector to use as a benchmark query seed.
   *
   * Deliberately not scoped to a library and deliberately not dependent on the
   * Float32 table: real searches run on the Int8 column by default, so an index
   * whose `vectors_f32` rows are absent still searches perfectly well and must
   * still be benchmarkable. Float32 is preferred when present only because it
   * needs no dequantisation.
   */
  private async loadBenchmarkSeed(
    signal?: AbortSignal,
  ): Promise<Float32Array | null> {
    const float32Rows = await this.queryRowsCancellable(
      `SELECT e.dimensions, f.vector FROM embeddings e JOIN vectors_f32 f ON f.item_key = e.item_key AND f.chunk_id = e.chunk_id ORDER BY e.id LIMIT 1`,
      [],
      signal,
      undefined,
      (row: any) => ({ dimensions: row.dimensions, vector: row.vector }),
    );
    if (float32Rows.length && float32Rows[0].vector) {
      return this.bufferToFloat32Array(
        float32Rows[0].vector,
        Number(float32Rows[0].dimensions),
      );
    }

    const int8Rows = await this.queryRowsCancellable(
      `SELECT dimensions, vector_int8, vector_scale FROM embeddings WHERE vector_int8 IS NOT NULL ORDER BY id LIMIT 1`,
      [],
      signal,
      undefined,
      (row: any) => ({
        dimensions: row.dimensions,
        vectorInt8: row.vector_int8,
        scale: row.vector_scale,
      }),
    );
    if (int8Rows.length && int8Rows[0].vectorInt8) {
      const dimensions = Number(int8Rows[0].dimensions);
      const scale = Number(int8Rows[0].scale);
      if (Number.isFinite(dimensions) && Number.isFinite(scale) && scale !== 0) {
        return this.dequantizeFromInt8(
          this.bufferToInt8Array(int8Rows[0].vectorInt8, dimensions),
          scale,
        );
      }
    }

    return null;
  }

  /**
   * Benchmark the same read-only scan used by hybrid retrieval, over every
   * chunk currently in the index.
   *
   * One stored vector is the query seed, avoiding an embedding API request and
   * any need to read source document text.
   */
  async benchmarkLibraryScan(
    signal?: AbortSignal,
  ): Promise<VectorScanBenchmarkResult> {
    await this.ensureInitialized();
    const seed = await this.loadBenchmarkSeed(signal);
    if (!seed) {
      // Report what is actually in the tables. "No vectors are indexed" was
      // wrong often enough to be misleading: it also fired for an index that
      // was fully present but stored in a column this query did not read.
      const [embeddingCount, int8Count, float32Count] = await Promise.all([
        this.db.valueQueryAsync(`SELECT COUNT(*) FROM embeddings`),
        this.db.valueQueryAsync(
          `SELECT COUNT(*) FROM embeddings WHERE vector_int8 IS NOT NULL`,
        ),
        this.db.valueQueryAsync(`SELECT COUNT(*) FROM vectors_f32`),
      ]);
      throw new Error(
        `No usable seed vector found (embeddings=${Number(embeddingCount || 0)}, ` +
          `int8=${Number(int8Count || 0)}, float32=${Number(float32Count || 0)}). ` +
          `Build the semantic index before running the scan test.`,
      );
    }

    return runVectorScanBenchmark(() =>
      this.search(seed, {
        groupByItem: true,
        documentLimit: undefined,
        maxChunksPerItem: 3,
        includeChunkText: false,
        language: 'all',
        itemKeys: undefined,
        minScore: -1,
        // Every chunk in the index, not one library's worth: the test measures
        // the worst case the scan can be asked to do.
        allLibraries: true,
        signal,
      }),
    );
  }

  /** How many chunks the scan test would cover, for reporting coverage. */
  async getIndexedChunkTotal(): Promise<number> {
    await this.ensureInitialized();
    const total = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM embeddings`,
    );
    return Number(total || 0);
  }

  /**
   * Search for similar vectors using optimized Int8 chunked streaming
   *
   * Optimization strategy:
   * 1. Large batch size (50,000) to reduce I/O from 53 queries to ~6
   * 2. Int8 quantized vectors for ~4x faster integer arithmetic
   * 3. Pre-computed norms eliminate per-vector norm calculation
   * 4. Chunked streaming: load chunk → compute → release → next chunk
   *
   * Memory usage: ~150MB peak (50k vectors × 2560 dims × 1 byte + overhead)
   * Expected speedup: 150s → ~25s for 273k vectors
   */
  async search(
    queryVector: Float32Array,
    options: VectorSearchOptions = {},
  ): Promise<SearchResult[]> {
    if (!this.gpuBackend.isEnabled()) {
      return this.searchCpu(
        queryVector,
        options,
        this.gpuBackend.getCpuFallbackPrecision(),
      );
    }

    await this.ensureInitialized();
    this.throwIfVectorScanCancelled(options.signal, options.deadlineAt);
    if (options.itemKeys !== undefined && options.itemKeys.length === 0) {
      return [];
    }

    const request: GpuVectorSearchRequest = {
      query: queryVector,
      topK: options.topK ?? 10,
      groupByItem: options.groupByItem ?? false,
      documentLimit: options.documentLimit,
      maxChunksPerItem: options.maxChunksPerItem ?? 3,
      language: options.language ?? 'all',
      itemKeys: options.itemKeys,
      minScore: options.minScore ?? 0,
      // Undefined tells the worker to scan every resident row, which is what
      // keeps the GPU benchmark over the same chunks as the CPU one. itemKeys
      // is a narrower scope already, so it wins as it does on the CPU path.
      libraryID:
        options.allLibraries && options.itemKeys === undefined
          ? undefined
          : (options.libraryID ?? Zotero.Libraries.userLibraryID),
      timeoutMs:
        options.deadlineAt === undefined
          ? undefined
          : Math.max(0, options.deadlineAt - Date.now()),
      signal: options.signal,
      stats: options.stats,
    };

    try {
      let results = await this.gpuBackend.search(request);
      this.throwIfVectorScanCancelled(options.signal, options.deadlineAt);
      if (options.includeChunkText ?? true) {
        results = await this.hydrateSearchResultTexts(results);
      }
      return results;
    } catch (error) {
      if (options.signal?.aborted) {
        throw new Error('Vector scan cancelled');
      }
      // An index that no longer matches the embedding model is a
      // configuration problem, not a broken GPU backend. Retrying it on the
      // CPU would only reach the identical check one layer down, and marking
      // the GPU path as failed would disable acceleration for the rest of the
      // session over something the GPU did nothing wrong in. So it propagates
      // unchanged — CPU and GPU report this condition identically.
      if (isVectorDimensionMismatchError(error)) throw error;
      const fallbackPrecision = this.gpuBackend.getEffectivePrecision();
      this.gpuBackend.fallback(error);
      return this.searchCpu(queryVector, options, fallbackPrecision);
    }
  }

  private async searchCpu(
    queryVector: Float32Array,
    options: VectorSearchOptions = {},
    forcedPrecision?: GpuVectorPrecision,
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();

    const {
      topK = 10,
      groupByItem = false,
      documentLimit,
      maxChunksPerItem = 3,
      includeChunkText = true,
      language = 'all',
      itemKeys,
      minScore = 0,
      libraryID = Zotero.Libraries.userLibraryID,
      allLibraries = false,
      deadlineAt,
      signal,
      stats,
    } = options;
    const startTime = Date.now();

    // An explicitly empty scope means "search no documents". Treating it as
    // an omitted filter would turn an empty Collection into a full-library
    // scan.
    if (itemKeys !== undefined && itemKeys.length === 0) return [];

    ztoolkit.log(`[VectorStore] search() start: instanceId=${this.instanceId}, topK=${topK}, lang=${language}, minScore=${minScore}, queryDims=${queryVector.length}`);

    // Build query conditions
    const conditions: string[] = ['1=1'];
    const params: any[] = [];

    if (language !== 'all') {
      conditions.push('language = ?');
      params.push(language);
    }

    if (itemKeys !== undefined) {
      const storageKeys = itemKeys.map((key) =>
        this.toStorageKey(key, libraryID),
      );
      const placeholders = storageKeys.map(() => '?').join(',');
      conditions.push(`item_key IN (${placeholders})`);
      params.push(...storageKeys);
    } else if (allLibraries) {
      // No library predicate at all — every stored vector participates.
    } else if (libraryID === Zotero.Libraries.userLibraryID) {
      conditions.push("item_key NOT GLOB '[0-9]*:*'");
    } else {
      conditions.push('item_key GLOB ?');
      params.push(`${libraryID}:*`);
    }

    this.throwIfVectorScanCancelled(signal, deadlineAt);

    // Optimized batch size: 50,000 vectors per chunk
    // Memory: 50k × 2560 dims × 1 byte = ~128MB for Int8 data
    const BATCH_SIZE = 50000;
    let offset = 0;
    let totalScanned = 0;
    let batchCount = 0;

    const whereClause = conditions.join(' AND ');
    const metadataRows = await this.queryRowsCancellable(
      `SELECT dimensions, vector_int8 IS NOT NULL AS has_int8 FROM embeddings WHERE ${whereClause} ORDER BY id LIMIT 1`,
      params,
      signal,
      deadlineAt,
      (row: any) => ({
        dimensions: row.dimensions,
        has_int8: row.has_int8,
      }),
    );
    if (metadataRows.length === 0) {
      ztoolkit.log(`[VectorStore] search() no vectors found`);
      return [];
    }

    // Vectors of different dimensions cannot be compared, so there is no
    // ranking to produce. Returning [] here made that indistinguishable from
    // "nothing matched" and let hybrid_search pass off a keyword-only ranking
    // as a normal hybrid result. It throws so the branch fails visibly.
    const storedDims = Number(metadataRows[0].dimensions);
    if (storedDims !== queryVector.length) {
      ztoolkit.log(
        `[VectorStore] CRITICAL: Dimension mismatch! Query=${queryVector.length}, Stored=${storedDims}. You need to re-index with the current embedding model.`,
        'error',
      );
      throw new VectorDimensionMismatchError(queryVector.length, storedDims);
    }

    // New databases have Int8 data for every row. If the first row is from a
    // legacy database, scan through the Float32 table instead; mixed Int8
    // batches retain a batched Float32 fallback for individual missing rows.
    const useInt8 =
      forcedPrecision === 'float32'
        ? false
        : forcedPrecision === 'int8'
          ? true
          : Boolean(Number(metadataRows[0].has_int8));
    this.gpuBackend.reportCpuPrecision(useInt8 ? 'int8' : 'float32');

    ztoolkit.log(`[VectorStore] search() using ${useInt8 ? 'Int8 optimized' : 'Float32 fallback'} search`);

    // Pre-compute query vector data
    const queryQuantized = this.quantizeWithNorm(queryVector);
    const { normalized: normalizedQuery, norm: queryNorm } = this.prepareQueryVector(queryVector);

    if (queryNorm === 0) {
      ztoolkit.log(`[VectorStore] search() query vector has zero norm, returning empty results`);
      return [];
    }

    // Debug: log query vector info
    const querySample = queryVector.slice(0, 5);
    const queryInt8Sample = queryQuantized.int8Data.slice(0, 5);
    // Compute max abs safely (avoid spread operator stack overflow on large arrays)
    let queryMaxAbs = 0;
    for (let i = 0; i < queryVector.length; i++) {
      const abs = Math.abs(queryVector[i]);
      if (abs > queryMaxAbs) queryMaxAbs = abs;
    }
    ztoolkit.log(`[VectorStore] search() query: float32[0:5]=[${Array.from(querySample).map(v => v.toFixed(4))}], int8[0:5]=[${Array.from(queryInt8Sample)}], norm=${queryNorm.toFixed(4)}, scale=${queryMaxAbs > 0 ? (127 / queryMaxAbs).toFixed(4) : 'N/A'}`);


    // Min-heap for bounded chunk-level searches. Library-level retrieval uses
    // the document map below and therefore cannot let one document's many
    // chunks crowd other documents out.
    const minHeap: SearchResult[] = [];
    const documentChunks = new Map<string, SearchResult[]>();
    const siftUp = (start: number) => {
      let index = start;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (minHeap[parent].score <= minHeap[index].score) break;
        const swap = minHeap[parent];
        minHeap[parent] = minHeap[index];
        minHeap[index] = swap;
        index = parent;
      }
    };
    const siftDown = () => {
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < minHeap.length && minHeap[left].score < minHeap[smallest].score) {
          smallest = left;
        }
        if (
          right < minHeap.length &&
          minHeap[right].score < minHeap[smallest].score
        ) {
          smallest = right;
        }
        if (smallest === index) break;
        const swap = minHeap[smallest];
        minHeap[smallest] = minHeap[index];
        minHeap[index] = swap;
        index = smallest;
      }
    };

    // Track score statistics for debugging
    let scoreSum = 0;
    let scoreCount = 0;
    let scoreMax = -Infinity;
    let scoreMin = Infinity;
    let nanCount = 0;

    // Process in large batches (chunked streaming)
    for (;;) {
      this.throwIfVectorScanCancelled(signal, deadlineAt);
      batchCount++;
      const batchStartTime = Date.now();
      const batchParams = [...params, BATCH_SIZE, offset];

      // Select appropriate columns based on availability
      // Float32 vectors are in vectors_f32 table — only load when needed (fallback path)
      const selectCols = useInt8
        ? 'id, item_key, chunk_id, vector_int8, vector_scale, vector_norm, language, dimensions'
        : 'e.id, e.item_key, e.chunk_id, e.language, e.dimensions, f.vector AS vector_f32';

      // ORDER BY id is not decoration: the scan walks the table in LIMIT/OFFSET
      // batches, and SQLite guarantees no row order without it. Two runs of the
      // SAME query could therefore visit rows in different orders, so which of
      // several equally-scoring chunks survived the top-K cut varied run to run
      // — observed live as a document at 0.6001 appearing in one search and
      // vanishing from the next against an unchanged 0.60 threshold. Unordered
      // OFFSET paging can also skip or repeat rows outright if the order shifts
      // between batches. `id` is the INTEGER PRIMARY KEY, i.e. the rowid, so
      // this orders the walk without costing a sort.
      const mapScanRow = (row: any) => ({
        id: row.id,
        item_key: row.item_key,
        chunk_id: row.chunk_id,
        vector_int8: row.vector_int8,
        vector_scale: row.vector_scale,
        vector_norm: row.vector_norm,
        language: row.language,
        dimensions: row.dimensions,
        vector_f32: row.vector_f32,
      });
      const rows = useInt8
        ? await this.queryRowsCancellable(
            `SELECT ${selectCols} FROM embeddings WHERE ${whereClause} ORDER BY id LIMIT ? OFFSET ?`,
            batchParams,
            signal,
            deadlineAt,
            mapScanRow,
          )
        : await this.queryRowsCancellable(
            `SELECT ${selectCols} FROM (SELECT id, item_key, chunk_id, language, dimensions FROM embeddings WHERE ${whereClause} ORDER BY id LIMIT ? OFFSET ?) e LEFT JOIN vectors_f32 f ON f.item_key = e.item_key AND f.chunk_id = e.chunk_id ORDER BY e.id`,
            batchParams,
            signal,
            deadlineAt,
            mapScanRow,
          );

      if (!rows || rows.length === 0) {
        ztoolkit.log(`[VectorStore] search() batch ${batchCount} returned no rows at offset ${offset}`);
        break;
      }

      const ioTime = Date.now() - batchStartTime;
      const computeStartTime = Date.now();

      const decodedInt8 = new Map<number, Int8Array>();
      const fallbackRowIDs: number[] = [];
      if (useInt8) {
        for (const row of rows) {
          if (
            row.vector_int8 &&
            row.vector_norm &&
            row.dimensions === queryVector.length
          ) {
            try {
              const decoded = this.bufferToInt8Array(
                row.vector_int8,
                row.dimensions,
              );
              if (decoded.length === queryQuantized.int8Data.length) {
                decodedInt8.set(row.id, decoded);
                continue;
              }
            } catch {
              // Invalid Int8 data uses the batched Float32 fallback below.
            }
          }
          fallbackRowIDs.push(row.id);
        }
      }
      const float32Fallbacks = useInt8
        ? await this.getFloat32VectorsByEmbeddingIDs(
            fallbackRowIDs,
            signal,
            deadlineAt,
          )
        : new Map<number, any>();

      // Process this batch
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        if (rowIndex % 256 === 0) {
          this.throwIfVectorScanCancelled(signal, deadlineAt);
        }
        const row = rows[rowIndex];
        try {
          let score: number;

          // Check dimension match - query and stored must have same dimensions
          const queryDims = queryVector.length;
          const storedDims = row.dimensions;

          const storedInt8 = decodedInt8.get(row.id);
          if (storedInt8) {
            score = this.cosineSimilarityInt8WithNorm(
              queryQuantized.int8Data,
              queryQuantized.norm,
              storedInt8,
              row.vector_norm,
            );
          } else {
            const vectorBlob = useInt8
              ? float32Fallbacks.get(row.id)
              : row.vector_f32;
            if (!vectorBlob || queryDims !== storedDims) continue;
            const storedVector = this.bufferToFloat32Array(
              vectorBlob,
              row.dimensions,
            );
            score = this.cosineSimilarityWithNormalizedQuery(
              normalizedQuery,
              storedVector,
            );
          }

          totalScanned++;

          // Track score statistics for debugging
          if (isNaN(score)) {
            nanCount++;
          } else {
            scoreSum += score;
            scoreCount++;
            if (score > scoreMax) scoreMax = score;
            if (score < scoreMin) scoreMin = score;
          }

          if (score >= minScore) {
            const identity = this.fromStorageKey(row.item_key);
            const result: SearchResult = {
              itemKey: identity.itemKey,
              libraryID: identity.libraryID,
              chunkId: row.chunk_id,
              score,
              chunkText: '',
              language: row.language,
              rowId: row.id,
            };

            if (groupByItem) {
              const documentKey = `${result.libraryID}:${result.itemKey}`;
              const chunks = documentChunks.get(documentKey) ?? [];
              chunks.push(result);
              chunks.sort((a, b) => b.score - a.score);
              if (chunks.length > maxChunksPerItem) chunks.length = maxChunksPerItem;
              documentChunks.set(documentKey, chunks);
            } else {
              // Keep the K best chunks for a bounded single-document search.
              if (minHeap.length < topK) {
                minHeap.push(result);
                siftUp(minHeap.length - 1);
              } else if (score > minHeap[0].score) {
                minHeap[0] = result;
                siftDown();
              }
            }
          }
        } catch (e) {
          // Skip invalid vectors
        }
      }

      const computeTime = Date.now() - computeStartTime;
      offset += rows.length;

      ztoolkit.log(`[VectorStore] search() batch ${batchCount}: ${rows.length} vectors, IO=${ioTime}ms, compute=${computeTime}ms, scanned=${offset}`);
      if (rows.length < BATCH_SIZE) break;
    }

    if (stats) stats.scanned = totalScanned;

    // Rank documents by their best chunk. Keep the best three chunk references
    // per document so evidence can be hydrated only for a returned page.
    const rankedDocuments = Array.from(documentChunks.entries()).sort((a, b) => {
      const scoreDifference = b[1][0].score - a[1][0].score;
      return scoreDifference !== 0 ? scoreDifference : a[0].localeCompare(b[0]);
    });
    const selectedDocuments =
      documentLimit === undefined
        ? rankedDocuments
        : rankedDocuments.slice(0, documentLimit);
    let topResults = groupByItem
      ? selectedDocuments.flatMap(([, chunks]) => chunks)
      : minHeap.sort((a, b) => b.score - a.score);

    if (includeChunkText) {
      this.throwIfVectorScanCancelled(signal, deadlineAt);
      topResults = await this.hydrateSearchResultTexts(topResults);
    }

    const searchTime = Date.now() - startTime;
    const topScores = topResults.slice(0, 5).map(r => r.score.toFixed(3)).join(', ');
    ztoolkit.log(`[VectorStore] search() completed in ${searchTime}ms: ${totalScanned} vectors in ${batchCount} batches, returning ${topResults.length}`);

    // Log score statistics for debugging
    if (scoreCount > 0) {
      const avgScore = scoreSum / scoreCount;
      ztoolkit.log(`[VectorStore] search() score stats: min=${scoreMin.toFixed(4)}, max=${scoreMax.toFixed(4)}, avg=${avgScore.toFixed(4)}, NaN=${nanCount}`);
    } else if (nanCount > 0) {
      ztoolkit.log(`[VectorStore] search() WARNING: All ${nanCount} scores were NaN! Check dimension mismatch or data corruption.`);
    }

    if (topResults.length > 0) {
      ztoolkit.log(`[VectorStore] search() top scores: [${topScores}]`);
    }

    return topResults;
  }

  /**
   * Whether a search issued right now would run on the GPU.
   *
   * Callers that must size a deadline before searching need this: the two paths
   * scale differently with the number of query vectors (one shared pass on the
   * CPU, one resident-vector scan per query on the GPU).
   */
  isGpuSearchEnabled(): boolean {
    try {
      return this.gpuBackend.isEnabled();
    } catch {
      return false;
    }
  }

  /**
   * Score the index against SEVERAL query vectors in one pass, returning each
   * candidate document's best chunks per query vector.
   *
   * Why this exists as its own entry point rather than N calls to `search()`:
   * the expensive parts of a scan are the SQL read and the per-row Int8 decode,
   * and both are shared across query vectors. Calling `search()` five times
   * re-reads and re-decodes the whole index five times; this reads and decodes
   * once and does five dot products per row.
   *
   * Nothing is truncated at chunk level beyond `chunksPerQuery` per document,
   * so document-level ranking downstream sees every document the index holds
   * evidence for — which is what makes "the N most similar DOCUMENTS" a
   * question this can actually answer.
   */
  async searchMultiQuery(
    queryVectors: Float32Array[],
    options: MultiQuerySearchOptions = {},
  ): Promise<MultiQueryDocumentMatch[]> {
    if (queryVectors.length === 0) return [];
    if (options.itemKeys !== undefined && options.itemKeys.length === 0) {
      return [];
    }

    if (!this.gpuBackend.isEnabled()) {
      return this.searchMultiQueryCpu(
        queryVectors,
        options,
        this.gpuBackend.getCpuFallbackPrecision(),
      );
    }

    await this.ensureInitialized();
    this.throwIfVectorScanCancelled(options.signal, options.deadlineAt);
    try {
      return await this.searchMultiQueryGpu(queryVectors, options);
    } catch (error) {
      if (options.signal?.aborted) {
        throw new Error('Vector scan cancelled');
      }
      // As on the single-query path: an index that predates the current
      // embedding model is a configuration error, identical on both backends,
      // and must not be mistaken for a GPU malfunction.
      if (isVectorDimensionMismatchError(error)) throw error;
      const fallbackPrecision = this.gpuBackend.getEffectivePrecision();
      this.gpuBackend.fallback(error);
      return this.searchMultiQueryCpu(
        queryVectors,
        options,
        fallbackPrecision,
      );
    }
  }

  /**
   * GPU path: one resident-vector scan per query vector.
   *
   * The worker already returns per-document top chunks (`groupByItem`), which
   * is exactly the shape needed here, and the vectors stay resident on the
   * device between calls — so the repeated scans cost kernel time, not I/O.
   * The single-pass argument that shapes the CPU path does not apply.
   */
  private async searchMultiQueryGpu(
    queryVectors: Float32Array[],
    options: MultiQuerySearchOptions,
  ): Promise<MultiQueryDocumentMatch[]> {
    const chunksPerQuery = Math.max(1, Math.floor(options.chunksPerQuery ?? 2));
    const excluded = new Set(options.excludeItemKeys ?? []);
    const documents = new Map<string, MultiQueryDocumentMatch>();
    let scanned = 0;

    for (let queryIndex = 0; queryIndex < queryVectors.length; queryIndex++) {
      this.throwIfVectorScanCancelled(options.signal, options.deadlineAt);
      const scanStats: { scanned?: number } = {};
      const results = await this.gpuBackend.search({
        query: queryVectors[queryIndex],
        // Ignored by the worker when groupByItem is set; the document map is
        // what bounds the result there.
        topK: chunksPerQuery,
        groupByItem: true,
        // No document cap: cutting candidates here is the very truncation that
        // made the old find_similar return two papers when asked for twenty.
        documentLimit: undefined,
        maxChunksPerItem: chunksPerQuery,
        language: options.language ?? 'all',
        itemKeys: options.itemKeys,
        minScore: options.minChunkScore ?? 0,
        libraryID: options.libraryID ?? Zotero.Libraries.userLibraryID,
        timeoutMs:
          options.deadlineAt === undefined
            ? undefined
            : Math.max(0, options.deadlineAt - Date.now()),
        signal: options.signal,
        stats: scanStats,
      });
      scanned += scanStats.scanned ?? 0;

      for (const result of results) {
        if (excluded.has(result.itemKey)) continue;
        const documentKey = `${result.libraryID}:${result.itemKey}`;
        let entry = documents.get(documentKey);
        if (!entry) {
          entry = {
            itemKey: result.itemKey,
            libraryID: result.libraryID,
            perQuery: Array.from({ length: queryVectors.length }, () => []),
          };
          documents.set(documentKey, entry);
        }
        this.pushChunkHit(
          entry.perQuery[queryIndex],
          { chunkId: result.chunkId, score: result.score, rowId: result.rowId },
          chunksPerQuery,
        );
      }
    }

    if (options.stats) {
      options.stats.scanned = scanned;
      options.stats.documents = documents.size;
    }
    return Array.from(documents.values());
  }

  /** Keep a per-document, per-query list of the best chunks, best-first. */
  private pushChunkHit(
    hits: MultiQueryChunkHit[],
    hit: MultiQueryChunkHit,
    cap: number,
  ): void {
    if (hits.length >= cap && hit.score <= hits[hits.length - 1].score) return;
    hits.push(hit);
    hits.sort((a, b) => b.score - a.score);
    if (hits.length > cap) hits.length = cap;
  }

  private async searchMultiQueryCpu(
    queryVectors: Float32Array[],
    options: MultiQuerySearchOptions,
    forcedPrecision?: GpuVectorPrecision,
  ): Promise<MultiQueryDocumentMatch[]> {
    await this.ensureInitialized();

    const {
      chunksPerQuery = 2,
      language = 'all',
      itemKeys,
      excludeItemKeys,
      minChunkScore = 0,
      libraryID = Zotero.Libraries.userLibraryID,
      deadlineAt,
      signal,
      stats,
    } = options;
    const startTime = Date.now();
    const chunkCap = Math.max(1, Math.floor(chunksPerQuery));
    const excluded = new Set(excludeItemKeys ?? []);

    if (itemKeys !== undefined && itemKeys.length === 0) return [];

    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    if (language !== 'all') {
      conditions.push('language = ?');
      params.push(language);
    }
    if (itemKeys !== undefined) {
      const storageKeys = itemKeys.map((key) =>
        this.toStorageKey(key, libraryID),
      );
      conditions.push(
        `item_key IN (${storageKeys.map(() => '?').join(',')})`,
      );
      params.push(...storageKeys);
    } else if (libraryID === Zotero.Libraries.userLibraryID) {
      conditions.push("item_key NOT GLOB '[0-9]*:*'");
    } else {
      conditions.push('item_key GLOB ?');
      params.push(`${libraryID}:*`);
    }

    this.throwIfVectorScanCancelled(signal, deadlineAt);

    const whereClause = conditions.join(' AND ');
    const metadataRows = await this.queryRowsCancellable(
      `SELECT dimensions, vector_int8 IS NOT NULL AS has_int8 FROM embeddings WHERE ${whereClause} ORDER BY id LIMIT 1`,
      params,
      signal,
      deadlineAt,
      (row: any) => ({ dimensions: row.dimensions, has_int8: row.has_int8 }),
    );
    if (metadataRows.length === 0) return [];

    // Same contract as the single-query scan: find_similar must not report
    // "no similar documents" when what actually happened is that the index and
    // the embedding model no longer agree on a vector length.
    const storedDims = Number(metadataRows[0].dimensions);
    const mismatched = queryVectors.filter(
      (vector) => vector.length !== storedDims,
    );
    if (mismatched.length > 0) {
      ztoolkit.log(
        `[VectorStore] searchMultiQuery(): dimension mismatch, query=${mismatched[0].length}, stored=${storedDims}`,
        'error',
      );
      throw new VectorDimensionMismatchError(
        mismatched[0].length,
        storedDims,
      );
    }

    const useInt8 =
      forcedPrecision === 'float32'
        ? false
        : forcedPrecision === 'int8'
          ? true
          : Boolean(Number(metadataRows[0].has_int8));
    this.gpuBackend.reportCpuPrecision(useInt8 ? 'int8' : 'float32');

    // Every query vector is prepared once, not once per row.
    const preparedQueries = queryVectors.map((vector) => ({
      quantized: this.quantizeWithNorm(vector),
      ...this.prepareQueryVector(vector),
    }));
    if (preparedQueries.some((query) => query.norm === 0)) {
      ztoolkit.log(
        `[VectorStore] searchMultiQuery(): a query vector has zero norm`,
        'error',
      );
      return [];
    }

    const documents = new Map<string, MultiQueryDocumentMatch>();
    const BATCH_SIZE = 50000;
    let offset = 0;
    let totalScanned = 0;
    let batchCount = 0;

    for (;;) {
      this.throwIfVectorScanCancelled(signal, deadlineAt);
      batchCount++;
      const batchParams = [...params, BATCH_SIZE, offset];
      const selectCols = useInt8
        ? 'id, item_key, chunk_id, vector_int8, vector_scale, vector_norm, language, dimensions'
        : 'e.id, e.item_key, e.chunk_id, e.language, e.dimensions, f.vector AS vector_f32';
      const mapScanRow = (row: any) => ({
        id: row.id,
        item_key: row.item_key,
        chunk_id: row.chunk_id,
        vector_int8: row.vector_int8,
        vector_scale: row.vector_scale,
        vector_norm: row.vector_norm,
        language: row.language,
        dimensions: row.dimensions,
        vector_f32: row.vector_f32,
      });
      const rows = useInt8
        ? await this.queryRowsCancellable(
            `SELECT ${selectCols} FROM embeddings WHERE ${whereClause} ORDER BY id LIMIT ? OFFSET ?`,
            batchParams,
            signal,
            deadlineAt,
            mapScanRow,
          )
        : await this.queryRowsCancellable(
            `SELECT ${selectCols} FROM (SELECT id, item_key, chunk_id, language, dimensions FROM embeddings WHERE ${whereClause} ORDER BY id LIMIT ? OFFSET ?) e LEFT JOIN vectors_f32 f ON f.item_key = e.item_key AND f.chunk_id = e.chunk_id ORDER BY e.id`,
            batchParams,
            signal,
            deadlineAt,
            mapScanRow,
          );

      if (!rows || rows.length === 0) break;

      const decodedInt8 = new Map<number, Int8Array>();
      const fallbackRowIDs: number[] = [];
      if (useInt8) {
        for (const row of rows) {
          if (
            row.vector_int8 &&
            row.vector_norm &&
            row.dimensions === storedDims
          ) {
            try {
              const decoded = this.bufferToInt8Array(
                row.vector_int8,
                row.dimensions,
              );
              if (decoded.length === preparedQueries[0].quantized.int8Data.length) {
                decodedInt8.set(row.id, decoded);
                continue;
              }
            } catch {
              // Falls through to the batched Float32 fallback below.
            }
          }
          fallbackRowIDs.push(row.id);
        }
      }
      const float32Fallbacks = useInt8
        ? await this.getFloat32VectorsByEmbeddingIDs(
            fallbackRowIDs,
            signal,
            deadlineAt,
          )
        : new Map<number, any>();

      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        if (rowIndex % 256 === 0) {
          this.throwIfVectorScanCancelled(signal, deadlineAt);
        }
        const row = rows[rowIndex];
        try {
          const identity = this.fromStorageKey(row.item_key);
          const storedInt8 = decodedInt8.get(row.id);
          let storedFloat32: Float32Array | null = null;
          if (!storedInt8) {
            const vectorBlob = useInt8
              ? float32Fallbacks.get(row.id)
              : row.vector_f32;
            if (!vectorBlob || row.dimensions !== storedDims) continue;
            storedFloat32 = this.bufferToFloat32Array(
              vectorBlob,
              row.dimensions,
            );
          }
          totalScanned++;
          // The row is decoded once; only the dot products repeat per query.
          if (excluded.has(identity.itemKey)) continue;

          const documentKey = `${identity.libraryID}:${identity.itemKey}`;
          let entry: MultiQueryDocumentMatch | undefined;

          for (
            let queryIndex = 0;
            queryIndex < preparedQueries.length;
            queryIndex++
          ) {
            const query = preparedQueries[queryIndex];
            const score = storedInt8
              ? this.cosineSimilarityInt8WithNorm(
                  query.quantized.int8Data,
                  query.quantized.norm,
                  storedInt8,
                  row.vector_norm,
                )
              : this.cosineSimilarityWithNormalizedQuery(
                  query.normalized,
                  storedFloat32 as Float32Array,
                );
            if (isNaN(score) || score < minChunkScore) continue;

            if (!entry) {
              entry = documents.get(documentKey);
              if (!entry) {
                entry = {
                  itemKey: identity.itemKey,
                  libraryID: identity.libraryID,
                  perQuery: Array.from(
                    { length: preparedQueries.length },
                    () => [],
                  ),
                };
                documents.set(documentKey, entry);
              }
            }
            this.pushChunkHit(
              entry.perQuery[queryIndex],
              { chunkId: row.chunk_id, score, rowId: row.id },
              chunkCap,
            );
          }
        } catch {
          // Skip invalid vectors, exactly as the single-query scan does.
        }
      }

      offset += rows.length;
      if (rows.length < BATCH_SIZE) break;
    }

    if (stats) {
      stats.scanned = totalScanned;
      stats.documents = documents.size;
    }
    ztoolkit.log(
      `[VectorStore] searchMultiQuery() completed in ${Date.now() - startTime}ms: queries=${queryVectors.length}, scanned=${totalScanned} in ${batchCount} batches, documents=${documents.size}`,
    );
    return Array.from(documents.values());
  }

  private async getFloat32VectorsByEmbeddingIDs(
    rowIDs: number[],
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<Map<number, any>> {
    const vectors = new Map<number, any>();
    const unique = Array.from(new Set(rowIDs));
    for (let offset = 0; offset < unique.length; offset += 500) {
      const batch = unique.slice(offset, offset + 500);
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.queryRowsCancellable(
        `SELECT e.id AS embedding_id, f.vector FROM embeddings e JOIN vectors_f32 f ON f.item_key = e.item_key AND f.chunk_id = e.chunk_id WHERE e.id IN (${placeholders})`,
        batch,
        signal,
        deadlineAt,
        (row: any) => ({
          embedding_id: row.embedding_id,
          vector: row.vector,
        }),
      );
      for (const row of rows || []) {
        vectors.set(row.embedding_id, row.vector);
      }
    }
    return vectors;
  }

  private async getGpuSnapshotInfo(): Promise<GpuVectorSnapshotInfo> {
    await this.ensureInitialized();
    const rows = await this.db.queryAsync(
      `SELECT COUNT(*) AS total, MIN(dimensions) AS min_dimensions, MAX(dimensions) AS max_dimensions, SUM(CASE WHEN vector_int8 IS NOT NULL THEN 1 ELSE 0 END) AS int8_count, (SELECT COUNT(*) FROM vectors_f32) AS float32_count FROM embeddings`,
    );
    const row = rows?.[0] ?? {};
    const total = Number(row.total ?? 0);
    if (total === 0) {
      return { total: 0, dimensions: 0, float32Count: 0, int8Count: 0 };
    }
    const minDimensions = Number(row.min_dimensions);
    const maxDimensions = Number(row.max_dimensions);
    if (
      !Number.isInteger(minDimensions) ||
      minDimensions <= 0 ||
      minDimensions !== maxDimensions
    ) {
      throw Object.assign(
        new Error(
          'The semantic index contains mixed vector dimensions; rebuild the index before enabling GPU acceleration',
        ),
        { code: 'DIMENSION_MISMATCH' },
      );
    }
    return {
      total,
      dimensions: minDimensions,
      float32Count: Number(row.float32_count ?? 0),
      int8Count: Number(row.int8_count ?? 0),
    };
  }

  private mapGpuSnapshotRow(
    row: any,
    precision: GpuVectorPrecision,
  ): GpuVectorSnapshotRow {
    const identity = this.fromStorageKey(String(row.item_key));
    const dimensions = Number(row.dimensions);
    return {
      rowId: Number(row.id),
      libraryID: identity.libraryID,
      itemKey: identity.itemKey,
      chunkId: Number(row.chunk_id),
      language: row.language === 'zh' ? 'zh' : 'en',
      dimensions,
      vector:
        precision === 'float32'
          ? this.bufferToFloat32Array(row.vector_f32, dimensions)
          : this.bufferToInt8Array(row.vector_int8, dimensions),
    };
  }

  private async readGpuSnapshotBatch(
    afterRowId: number,
    limit: number,
    precision: GpuVectorPrecision,
  ): Promise<GpuVectorSnapshotRow[]> {
    await this.ensureInitialized();
    const rows =
      precision === 'float32'
        ? await this.db.queryAsync(
            `SELECT e.id, e.item_key, e.chunk_id, e.language, e.dimensions, f.vector AS vector_f32 FROM embeddings e JOIN vectors_f32 f ON f.item_key = e.item_key AND f.chunk_id = e.chunk_id WHERE e.id > ? ORDER BY e.id LIMIT ?`,
            [afterRowId, limit],
          )
        : await this.db.queryAsync(
            `SELECT id, item_key, chunk_id, language, dimensions, vector_int8 FROM embeddings WHERE id > ? ORDER BY id LIMIT ?`,
            [afterRowId, limit],
          );
    return (rows || []).map((row: any) =>
      this.mapGpuSnapshotRow(row, precision),
    );
  }

  private async readGpuItems(
    identities: GpuVectorIdentity[],
    precision: GpuVectorPrecision,
  ): Promise<GpuVectorSnapshotRow[]> {
    await this.ensureInitialized();
    const storageKeys = Array.from(
      new Set(
        identities.map((identity) =>
          this.toStorageKey(identity.itemKey, identity.libraryID),
        ),
      ),
    );
    const result: GpuVectorSnapshotRow[] = [];
    for (let offset = 0; offset < storageKeys.length; offset += 400) {
      const batch = storageKeys.slice(offset, offset + 400);
      const placeholders = batch.map(() => '?').join(',');
      const rows =
        precision === 'float32'
          ? await this.db.queryAsync(
              `SELECT e.id, e.item_key, e.chunk_id, e.language, e.dimensions, f.vector AS vector_f32 FROM embeddings e JOIN vectors_f32 f ON f.item_key = e.item_key AND f.chunk_id = e.chunk_id WHERE e.item_key IN (${placeholders}) ORDER BY e.id`,
              batch,
            )
          : await this.db.queryAsync(
              `SELECT id, item_key, chunk_id, language, dimensions, vector_int8 FROM embeddings WHERE item_key IN (${placeholders}) ORDER BY id`,
              batch,
            );
      result.push(
        ...(rows || []).map((row: any) =>
          this.mapGpuSnapshotRow(row, precision),
        ),
      );
    }
    return result;
  }

  private async publishGpuMutation(
    mutation: GpuVectorMutation,
  ): Promise<void> {
    if (!this.gpuBackend.isEnabled()) return;
    try {
      await this.gpuBackend.publishMutation(mutation);
    } catch (error) {
      this.gpuBackend.fallback(error);
    }
  }

  private throwIfVectorScanCancelled(
    signal?: AbortSignal,
    deadlineAt?: number,
  ): void {
    if (signal?.aborted) throw new Error('Vector scan cancelled');
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw new Error('Vector scan timed out');
    }
  }

  private async queryRowsCancellable<T>(
    sql: string,
    params: any[],
    signal: AbortSignal | undefined,
    deadlineAt: number | undefined,
    mapRow: (row: any) => T,
  ): Promise<T[]> {
    this.throwIfVectorScanCancelled(signal, deadlineAt);
    const streamedRows: T[] = [];
    let cancelQuery: (() => void) | null = null;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      try {
        cancelQuery?.();
      } catch {
        // The query may already have completed.
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const remaining =
      deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now());
    const deadlineTimer =
      remaining === undefined ? undefined : setTimeout(cancel, remaining);
    try {
      // For a SELECT with onRow, Zotero returns undefined and delivers every
      // row through the callback instead — so `streamedRows` is the only
      // source, and there is deliberately no second path to fall back to. An
      // empty result here means the query matched nothing, not that rows were
      // delivered somewhere this function forgot to look.
      await this.db.queryAsync(sql, params, {
        onRow: (row: any, sqliteCancel: any) => {
          cancelQuery = () => {
            if (typeof sqliteCancel === 'function') sqliteCancel();
            else sqliteCancel?.cancel?.();
          };
          if (
            cancelled ||
            signal?.aborted ||
            (deadlineAt !== undefined && Date.now() >= deadlineAt)
          ) {
            cancel();
            return;
          }
          streamedRows.push(mapRow(wrapStreamedRow(row)));
        },
      });
      this.throwIfVectorScanCancelled(signal, deadlineAt);
      if (cancelled) throw new Error('Vector scan cancelled');
      return streamedRows;
    } catch (error) {
      if (signal?.aborted || cancelled) {
        this.throwIfVectorScanCancelled(signal, deadlineAt);
        throw new Error('Vector scan cancelled');
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
  }

  async getChunkTextsByRowIDs(rowIDs: number[]): Promise<Map<number, string>> {
    await this.ensureInitialized();
    const texts = new Map<number, string>();
    const unique = Array.from(new Set(rowIDs));
    for (let offset = 0; offset < unique.length; offset += 500) {
      const batch = unique.slice(offset, offset + 500);
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db.queryAsync(
        `SELECT id, chunk_text FROM embeddings WHERE id IN (${placeholders})`,
        batch,
      );
      for (const row of rows || []) {
        texts.set(row.id, String(row.chunk_text || ''));
      }
    }
    return texts;
  }

  private async hydrateSearchResultTexts(
    results: SearchResult[],
  ): Promise<SearchResult[]> {
    const texts = await this.getChunkTextsByRowIDs(
      results
        .map((result) => result.rowId)
        .filter((rowID): rowID is number => typeof rowID === 'number'),
    );
    return results.map((result) => ({
      ...result,
      chunkText:
        result.rowId === undefined ? result.chunkText : texts.get(result.rowId) ?? '',
    }));
  }

  /**
   * Get all indexed item keys
   */
  /**
   * Keys the incremental build may skip: everything already in index_status
   * except items recorded as 'empty' and except items indexed from metadata
   * alone. An 'empty' row only means the item had no extractable content at
   * the time — typically because its PDF had not been attached yet — so it
   * must stay eligible for a retry. A 'metadata-only' row means the body text
   * FAILED to parse, which is exactly the case a later build should try again
   * (the PDF may have been repaired, MinerU switched on, or its options
   * changed). 'failed:%' markers are still skipped on purpose.
   */
  async getItemsToSkip(
    libraryID: number = Zotero.Libraries.userLibraryID,
  ): Promise<Set<string>> {
    await this.ensureInitialized();

    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(`SELECT item_key FROM index_status WHERE content_hash != 'empty' AND version >= 2 AND source_kind != 'metadata-only'`);

    if (!rows || rows.length === 0) {
      return new Set();
    }

    return new Set(
      rows
        .map((r: any) => this.fromStorageKey(r.item_key))
        .filter((identity: any) => identity.libraryID === libraryID)
        .map((identity: any) => identity.itemKey),
    );
  }

  /**
   * The stored source_kind of many items at once, keyed `libraryID:itemKey`.
   *
   * Batched because a search page asks about every row it is about to return,
   * and 20 single-row round trips on the hot path of every hybrid_search is
   * not a cost worth paying to learn one column.
   */
  async getSourceKinds(
    identities: Array<{ itemKey: string; libraryID?: number }>,
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (identities.length === 0) return found;
    await this.ensureInitialized();

    // Storage keys are namespaced by library outside My Library, so the
    // lookup has to go through the same mapping the writes used.
    const byStorageKey = new Map<string, string>();
    for (const identity of identities) {
      const libraryID = identity.libraryID ?? Zotero.Libraries.userLibraryID;
      byStorageKey.set(
        this.toStorageKey(identity.itemKey, libraryID),
        `${libraryID}:${identity.itemKey}`,
      );
    }

    const storageKeys = Array.from(byStorageKey.keys());
    const BATCH = 200;
    for (let offset = 0; offset < storageKeys.length; offset += BATCH) {
      const slice = storageKeys.slice(offset, offset + BATCH);
      const placeholders = slice.map(() => '?').join(',');
      const rows = await this.db.queryAsync(
        `SELECT item_key, source_kind FROM index_status WHERE item_key IN (${placeholders})`,
        slice,
      );
      for (const row of rows || []) {
        const identity = byStorageKey.get(String(row.item_key));
        if (identity) found.set(identity, String(row.source_kind || ''));
      }
    }
    return found;
  }

  /**
   * Items indexed from title/abstract alone because their body text failed.
   *
   * These are not in index_failures: a failed PDF parse is a content problem,
   * not an indexing failure, so it must not fail a build. The row itself is
   * the retry record — durable across restarts, and the same fact that
   * getItemsToSkip reads to keep them eligible for the next incremental pass.
   * This is what lets an explicit "retry" also reach them.
   */
  async getMetadataOnlyItems(
    libraryID?: number,
  ): Promise<Array<{ libraryID: number; itemKey: string }>> {
    await this.ensureInitialized();
    const rows = await this.db.queryAsync(
      `SELECT item_key FROM index_status WHERE source_kind = 'metadata-only'`,
    );
    return (rows || [])
      .map((row: any) => this.fromStorageKey(String(row.item_key)))
      .filter(
        (identity: any) =>
          libraryID === undefined || identity.libraryID === libraryID,
      );
  }

  async getIndexedItems(): Promise<Set<string>> {
    await this.ensureInitialized();

    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(`SELECT item_key FROM index_status`);

    // Zotero's queryAsync returns undefined when no rows found
    if (!rows || rows.length === 0) {
      return new Set();
    }

    return new Set(rows.map((r: any) => r.item_key));
  }

  /**
   * Get item keys that were actually indexed (excludes 'failed:<type>'
   * markers) — for UI display, unlike getIndexedItems which the build
   * filter uses to skip both indexed and known-failed items
   */
  async getSuccessfullyIndexedItems(): Promise<Set<string>> {
    await this.ensureInitialized();

    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(
      `SELECT item_key FROM index_status WHERE content_hash NOT LIKE ?`,
      ['failed:%'],
    );

    if (!rows || rows.length === 0) {
      return new Set();
    }

    return new Set(rows.map((r: any) => r.item_key));
  }

  async recordFailedItem(item: FailedIndexItem): Promise<void> {
    await this.ensureInitialized();
    await this.db.executeTransaction(async () => {
      await this.db.queryAsync(
        `INSERT OR REPLACE INTO index_failures (library_id, item_key, error_type, error_message, failed_at, build_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          item.libraryID,
          item.itemKey,
          item.errorType,
          item.error,
          item.timestamp,
          item.buildID ?? null,
        ],
      );
      if (item.buildID) {
        await this.db.queryAsync(
          `UPDATE index_build_targets SET state = 'failed' WHERE build_id = ? AND library_id = ? AND item_key = ?`,
          [item.buildID, item.libraryID, item.itemKey],
        );
      }
    });
  }

  async getFailedItems(): Promise<FailedIndexItem[]> {
    await this.ensureInitialized();
    const rows = await this.db.queryAsync(
      `SELECT library_id, item_key, error_type, error_message, failed_at, build_id FROM index_failures ORDER BY failed_at, library_id, item_key`,
    );
    return (rows || []).map((row: any) => ({
      libraryID: Number(row.library_id),
      itemKey: String(row.item_key),
      errorType: String(row.error_type),
      error: String(row.error_message),
      timestamp: Number(row.failed_at),
      buildID: row.build_id ? String(row.build_id) : undefined,
    }));
  }

  async clearFailedItems(
    identities?: Array<{ libraryID: number; itemKey: string }>,
  ): Promise<void> {
    await this.ensureInitialized();
    if (!identities) {
      await this.db.queryAsync(`DELETE FROM index_failures`);
      return;
    }
    for (const identity of identities) {
      await this.db.queryAsync(
        `DELETE FROM index_failures WHERE library_id = ? AND item_key = ?`,
        [identity.libraryID, identity.itemKey],
      );
    }
  }

  async createBuildSession(
    session: IndexBuildSession,
    targets: Array<{ libraryID: number; itemKey: string }>,
  ): Promise<void> {
    await this.ensureInitialized();
    await this.db.executeTransaction(async () => {
      await this.db.queryAsync(
        `INSERT OR REPLACE INTO index_builds (build_id, library_id, scope, status, chunk_signature, chunk_target_chars, chunk_append_tolerance_chars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.buildID,
          session.libraryID,
          session.scope,
          session.status,
          session.chunkSignature ?? null,
          session.chunkTargetChars ?? null,
          session.chunkAppendToleranceChars ?? null,
          session.createdAt,
        ],
      );
      await this.addBuildTargets(session.buildID, targets, false);
    });
  }

  async addBuildTargets(
    buildID: string,
    targets: Array<{ libraryID: number; itemKey: string }>,
    ensureInitialized: boolean = true,
  ): Promise<void> {
    if (ensureInitialized) await this.ensureInitialized();
    for (const target of targets) {
      await this.db.queryAsync(
        `INSERT OR REPLACE INTO index_build_targets (build_id, library_id, item_key, state) VALUES (?, ?, ?, ?)`,
        [buildID, target.libraryID, target.itemKey, 'pending'],
      );
    }
  }

  async getBuildTargets(buildID: string): Promise<IndexBuildTarget[]> {
    await this.ensureInitialized();
    const rows = await this.db.queryAsync(
      `SELECT library_id, item_key, state FROM index_build_targets WHERE build_id = ? ORDER BY library_id, item_key`,
      [buildID],
    );
    return (rows || []).map((row: any) => ({
      libraryID: Number(row.library_id),
      itemKey: String(row.item_key),
      state: row.state as IndexBuildTargetState,
    }));
  }

  async getBuildTargetSummary(
    buildID: string,
  ): Promise<IndexBuildTargetSummary> {
    const targets = await this.getBuildTargets(buildID);
    const summary: IndexBuildTargetSummary = {
      total: targets.length,
      pending: 0,
      succeeded: 0,
      failed: 0,
    };
    for (const target of targets) summary[target.state] += 1;
    return summary;
  }

  async updateBuildTarget(
    buildID: string,
    identity: { libraryID: number; itemKey: string },
    state: IndexBuildTargetState,
  ): Promise<void> {
    await this.ensureInitialized();
    await this.db.queryAsync(
      `UPDATE index_build_targets SET state = ? WHERE build_id = ? AND library_id = ? AND item_key = ?`,
      [state, buildID, identity.libraryID, identity.itemKey],
    );
  }

  async updateBuildSessionStatus(
    buildID: string,
    status: IndexBuildSession['status'],
  ): Promise<void> {
    await this.ensureInitialized();
    await this.db.queryAsync(
      `UPDATE index_builds SET status = ? WHERE build_id = ?`,
      [status, buildID],
    );
  }

  async getResumableBuildSession(): Promise<IndexBuildSession | null> {
    await this.ensureInitialized();
    const rows = await this.db.queryAsync(
      `SELECT build_id, library_id, scope, status, chunk_signature, chunk_target_chars, chunk_append_tolerance_chars, created_at, reset_completed FROM index_builds WHERE status IN ('indexing', 'paused', 'failed') ORDER BY created_at DESC LIMIT 1`,
    );
    if (!rows?.length) return null;
    const row = rows[0];
    return {
      buildID: String(row.build_id),
      libraryID: Number(row.library_id),
      scope: row.scope,
      status: row.status,
      chunkSignature: row.chunk_signature || undefined,
      chunkTargetChars: row.chunk_target_chars ?? undefined,
      chunkAppendToleranceChars:
        row.chunk_append_tolerance_chars ?? undefined,
      createdAt: Number(row.created_at),
      resetCompleted: Boolean(row.reset_completed),
    };
  }

  async getBuildSession(buildID: string): Promise<IndexBuildSession | null> {
    await this.ensureInitialized();
    const rows = await this.db.queryAsync(
      `SELECT build_id, library_id, scope, status, chunk_signature, chunk_target_chars, chunk_append_tolerance_chars, created_at, reset_completed FROM index_builds WHERE build_id = ?`,
      [buildID],
    );
    if (!rows?.length) return null;
    const row = rows[0];
    return {
      buildID: String(row.build_id),
      libraryID: Number(row.library_id),
      scope: row.scope,
      status: row.status,
      chunkSignature: row.chunk_signature || undefined,
      chunkTargetChars: row.chunk_target_chars ?? undefined,
      chunkAppendToleranceChars:
        row.chunk_append_tolerance_chars ?? undefined,
      createdAt: Number(row.created_at),
      resetCompleted: Boolean(row.reset_completed),
    };
  }

  /** Atomically clear one Library and record that this rebuild reset committed. */
  async clearLibraryForBuild(
    buildID: string,
    libraryID: number,
  ): Promise<void> {
    await this.ensureInitialized();
    const scope = this.libraryScopeClause(libraryID);
    await this.db.executeTransaction(async () => {
      await this.db.queryAsync(
        `DELETE FROM embeddings WHERE ${scope.clause}`,
        scope.params,
      );
      await this.db.queryAsync(
        `DELETE FROM vectors_f32 WHERE ${scope.clause}`,
        scope.params,
      );
      await this.db.queryAsync(
        `DELETE FROM index_status WHERE ${scope.clause}`,
        scope.params,
      );
      await this.db.queryAsync(
        `DELETE FROM index_failures WHERE library_id = ?`,
        [libraryID],
      );
      await this.db.queryAsync(
        `UPDATE index_builds SET reset_completed = 1 WHERE build_id = ?`,
        [buildID],
      );
    });

    for (const key of this.vectorCache.keys()) {
      const identity = this.fromStorageKey(key.slice(0, key.lastIndexOf('_')));
      if (identity.libraryID === libraryID) this.vectorCache.delete(key);
    }
    await this.publishGpuMutation({ kind: 'libraryCleared', libraryID });
  }

  /**
   * Get index status for an item
   */
  async getIndexStatus(itemKey: string, libraryID?: number): Promise<IndexStatus | null> {
    await this.ensureInitialized();

    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const storageKey = this.toStorageKey(itemKey, libraryID);
    const rows = await this.db.queryAsync(`SELECT item_key, indexed_at, version, chunk_count, content_hash, item_modified, attachment_modified, content_length, source_kind, body_retry_signature FROM index_status WHERE item_key = ?`, [storageKey]);

    // Zotero's queryAsync returns undefined when no rows found
    if (!rows || rows.length === 0) return null;

    const row = rows[0];
    return {
      itemKey,
      indexedAt: row.indexed_at,
      chunkCount: row.chunk_count,
      contentHash: row.content_hash,
      version: row.version,
      itemModified: row.item_modified,
      attachmentModified: row.attachment_modified,
      contentLength: Number(row.content_length || 0),
      sourceKind: String(row.source_kind || 'on-demand'),
      bodyRetrySignature:
        row.body_retry_signature === undefined ||
        row.body_retry_signature === null
          ? null
          : String(row.body_retry_signature),
    };
  }

  /**
   * Update index status for an item (with optional timestamps)
   */
  async updateIndexStatus(
    itemKey: string,
    chunkCount: number,
    contentHash: string,
    itemModified?: string,
    attachmentModified?: string,
    libraryID?: number,
    contentLength?: number,
    sourceKind?: string,
    bodyRetrySignature?: string,
  ): Promise<void> {
    await this.ensureInitialized();

    await this.db.queryAsync(`
      INSERT INTO index_status
      (item_key, indexed_at, version, chunk_count, content_hash, item_modified, attachment_modified, content_length, source_kind, body_retry_signature)
      VALUES (?, strftime('%s', 'now'), 2, ?, ?, ?, ?, COALESCE(?, 0), COALESCE(?, 'on-demand'), ?)
      ON CONFLICT(item_key) DO UPDATE SET
        indexed_at = excluded.indexed_at,
        version = excluded.version,
        chunk_count = excluded.chunk_count,
        content_hash = excluded.content_hash,
        item_modified = excluded.item_modified,
        attachment_modified = excluded.attachment_modified,
        content_length = COALESCE(?, index_status.content_length),
        source_kind = COALESCE(?, index_status.source_kind),
        body_retry_signature = COALESCE(?, index_status.body_retry_signature)
    `, [
      this.toStorageKey(itemKey, libraryID),
      chunkCount,
      contentHash,
      itemModified || null,
      attachmentModified || null,
      contentLength ?? null,
      sourceKind ?? null,
      bodyRetrySignature ?? null,
      contentLength ?? null,
      sourceKind ?? null,
      bodyRetrySignature ?? null,
    ]);
  }

  /**
   * Check if item needs re-indexing by timestamp (fast check, no content extraction needed)
   * Returns: true if needs reindex, false if timestamps unchanged
   */
  async needsReindexByTimestamp(
    itemKey: string,
    itemModified: string,
    attachmentModified: string,
    libraryID?: number,
  ): Promise<boolean> {
    const status = await this.getIndexStatus(itemKey, libraryID);

    // No existing index, needs indexing
    if (!status) return true;

    // Index schema older than v2, force re-index
    if (Number(status.version || 0) < 2) return true;

    // No stored timestamps (old data), needs re-check with content hash
    if (!status.itemModified || !status.attachmentModified) return true;

    // Compare timestamps
    if (status.itemModified !== itemModified) return true;
    if (status.attachmentModified !== attachmentModified) return true;

    // Timestamps unchanged, no need to reindex
    return false;
  }

  /**
   * Check if item needs re-indexing by content hash
   */
  async needsReindex(itemKey: string, contentHash: string, libraryID?: number): Promise<boolean> {
    const status = await this.getIndexStatus(itemKey, libraryID);
    if (!status) return true;
    return status.contentHash !== contentHash;
  }

  async listIndexedContentMetadata(
    libraryID: number = Zotero.Libraries.userLibraryID,
    limit = 20,
  ): Promise<{
    total: number;
    items: Array<{
      itemKey: string;
      libraryID: number;
      contentLength: number;
      hash: string;
      indexedAt: number;
      sourceKind: string;
    }>;
  }> {
    await this.ensureInitialized();
    const where =
      libraryID === Zotero.Libraries.userLibraryID
        ? "item_key NOT GLOB '[0-9]*:*'"
        : 'item_key GLOB ?';
    const params =
      libraryID === Zotero.Libraries.userLibraryID
        ? []
        : [`${libraryID}:*`];
    const total = Number(
      await this.db.valueQueryAsync(
        `SELECT COUNT(*) FROM index_status WHERE ${where}`,
        params,
      ),
    );
    const rows = await this.db.queryAsync(
      `SELECT item_key, indexed_at, content_hash, content_length, source_kind FROM index_status WHERE ${where} ORDER BY indexed_at DESC LIMIT ?`,
      [...params, limit],
    );
    return {
      total,
      items: (rows || []).map((row: any) => {
        const identity = this.fromStorageKey(String(row.item_key));
        return {
          itemKey: identity.itemKey,
          libraryID: identity.libraryID,
          contentLength: Number(row.content_length || 0),
          hash: String(row.content_hash || ''),
          indexedAt: Number(row.indexed_at || 0),
          sourceKind: String(row.source_kind || 'on-demand'),
        };
      }),
    };
  }

  /**
   * Delete vectors for an item
   * @param itemKey The item key to delete
   */
  async deleteItemVectors(itemKey: string, libraryID?: number): Promise<void> {
    await this.ensureInitialized();

    const storageKey = this.toStorageKey(itemKey, libraryID);
    await this.db.executeTransaction(async () => {
      await this.db.queryAsync(
        `DELETE FROM embeddings WHERE item_key = ?`,
        [storageKey]
      );
      await this.db.queryAsync(
        `DELETE FROM vectors_f32 WHERE item_key = ?`,
        [storageKey]
      );
      await this.db.queryAsync(
        `DELETE FROM index_status WHERE item_key = ?`,
        [storageKey]
      );
    });

    // Clear cache entries
    for (const key of this.vectorCache.keys()) {
      if (key.startsWith(`${storageKey}_`)) {
        this.vectorCache.delete(key);
      }
    }

    ztoolkit.log(`[VectorStore] Deleted vectors for item: ${itemKey}`);
    await this.publishGpuMutation({
      kind: 'itemsDeleted',
      items: [
        {
          libraryID: libraryID ?? Zotero.Libraries.userLibraryID,
          itemKey,
        },
      ],
    });
  }

  /** Delete only the requested items while preserving every other index row. */
  async deleteItemsVectors(
    itemKeys: string[],
    libraryID?: number,
  ): Promise<void> {
    await this.ensureInitialized();
    const storageKeys = Array.from(
      new Set(itemKeys.map((key) => this.toStorageKey(key, libraryID))),
    );
    if (storageKeys.length === 0) return;

    const batchSize = 500;
    await this.db.executeTransaction(async () => {
      for (let offset = 0; offset < storageKeys.length; offset += batchSize) {
        const batch = storageKeys.slice(offset, offset + batchSize);
        const placeholders = batch.map(() => '?').join(',');
        await this.db.queryAsync(
          `DELETE FROM embeddings WHERE item_key IN (${placeholders})`,
          batch,
        );
        await this.db.queryAsync(
          `DELETE FROM vectors_f32 WHERE item_key IN (${placeholders})`,
          batch,
        );
        await this.db.queryAsync(
          `DELETE FROM index_status WHERE item_key IN (${placeholders})`,
          batch,
        );
      }
    });

    for (const key of this.vectorCache.keys()) {
      if (storageKeys.some((storageKey) => key.startsWith(`${storageKey}_`))) {
        this.vectorCache.delete(key);
      }
    }
    ztoolkit.log(
      `[VectorStore] Deleted vectors for ${storageKeys.length} targeted items`,
    );
    await this.publishGpuMutation({
      kind: 'itemsDeleted',
      items: storageKeys.map((storageKey) => this.fromStorageKey(storageKey)),
    });
  }

  /**
   * SQL fragment + params selecting only the rows of one library.
   *
   * Storage keys are bare item keys for My Library and `<libraryID>:<key>`
   * for every other library, which is the same shape search() filters on.
   */
  private libraryScopeClause(libraryID: number): {
    clause: string;
    params: any[];
  } {
    return libraryID === Zotero.Libraries.userLibraryID
      ? { clause: "item_key NOT GLOB '[0-9]*:*'", params: [] }
      : { clause: 'item_key GLOB ?', params: [`${libraryID}:*`] };
  }

  async getLibraryDataCounts(
    libraryID: number,
  ): Promise<SemanticLibraryDataCounts> {
    await this.ensureInitialized();
    const scope = this.libraryScopeClause(libraryID);
    const [chunkCount, float32VectorCount, indexedItemCount] =
      await Promise.all([
        this.db.valueQueryAsync(
          `SELECT COUNT(*) FROM embeddings WHERE ${scope.clause}`,
          scope.params,
        ),
        this.db.valueQueryAsync(
          `SELECT COUNT(*) FROM vectors_f32 WHERE ${scope.clause}`,
          scope.params,
        ),
        this.db.valueQueryAsync(
          `SELECT COUNT(*) FROM index_status WHERE ${scope.clause}`,
          scope.params,
        ),
      ]);
    return {
      chunkCount: Number(chunkCount || 0),
      float32VectorCount: Number(float32VectorCount || 0),
      indexedItemCount: Number(indexedItemCount || 0),
    };
  }

  /**
   * Clear vectors and index status.
   *
   * @param libraryID Restrict the wipe to one library. A rebuild of a group
   *   library must not delete My Library's index, and vice versa, so every
   *   rebuild path passes the library it is actually rebuilding.
   */
  async clear(libraryID?: number): Promise<void> {
    await this.ensureInitialized();

    // Log which database we're clearing
    ztoolkit.log(`[VectorStore] clear() called on instanceId=${this.instanceId}, dbPath=${this.dbPath}, libraryID=${libraryID ?? 'all'}`);

    const scope =
      libraryID === undefined ? null : this.libraryScopeClause(libraryID);
    const where = scope ? ` WHERE ${scope.clause}` : '';
    const params = scope ? scope.params : [];

    // Get counts before deletion for logging
    const beforeEmbeddings = await this.db.valueQueryAsync(`SELECT COUNT(*) FROM embeddings${where}`, params);
    const beforeIndex = await this.db.valueQueryAsync(`SELECT COUNT(*) FROM index_status${where}`, params);
    ztoolkit.log(`[VectorStore] clear() starting: embeddings=${beforeEmbeddings}, index_status=${beforeIndex}`);

    // Execute DELETE statements directly (not in transaction to ensure immediate effect)
    await this.db.queryAsync(`DELETE FROM embeddings${where}`, params);
    await this.db.queryAsync(`DELETE FROM vectors_f32${where}`, params);
    await this.db.queryAsync(`DELETE FROM index_status${where}`, params);

    // Verify deletion
    const afterEmbeddings = await this.db.valueQueryAsync(`SELECT COUNT(*) FROM embeddings${where}`, params);
    const afterF32 = await this.db.valueQueryAsync(`SELECT COUNT(*) FROM vectors_f32${where}`, params);
    const afterIndex = await this.db.valueQueryAsync(`SELECT COUNT(*) FROM index_status${where}`, params);
    ztoolkit.log(`[VectorStore] clear() completed: embeddings=${afterEmbeddings}, vectors_f32=${afterF32}, index_status=${afterIndex}`);

    if (afterEmbeddings > 0 || afterF32 > 0 || afterIndex > 0) {
      ztoolkit.log(`[VectorStore] WARNING: clear() did not fully delete data! Retrying...`, 'warn');
      // Retry with explicit SQL
      const retryWhere = scope ? ` WHERE ${scope.clause}` : ' WHERE 1=1';
      await this.db.queryAsync(`DELETE FROM embeddings${retryWhere}`, params);
      await this.db.queryAsync(`DELETE FROM vectors_f32${retryWhere}`, params);
      await this.db.queryAsync(`DELETE FROM index_status${retryWhere}`, params);

      const finalEmbeddings = await this.db.valueQueryAsync(`SELECT COUNT(*) FROM embeddings${where}`, params);
      const finalIndex = await this.db.valueQueryAsync(`SELECT COUNT(*) FROM index_status${where}`, params);
      ztoolkit.log(`[VectorStore] clear() retry result: embeddings=${finalEmbeddings}, index_status=${finalIndex}`);
    }

    this.vectorCache.clear();
    // VACUUM to reclaim disk space (DELETE only marks pages as free)
    try {
      ztoolkit.log(`[VectorStore] Running VACUUM to reclaim disk space...`);
      await this.db.queryAsync(`VACUUM`);
      ztoolkit.log(`[VectorStore] VACUUM completed`);
    } catch (vacuumError) {
      ztoolkit.log(`[VectorStore] VACUUM failed (non-critical): ${vacuumError}`, 'warn');
    }
    await this.publishGpuMutation(
      libraryID === undefined
        ? { kind: 'allCleared' }
        : { kind: 'libraryCleared', libraryID },
    );
  }

  private async countSemanticBusinessRows(): Promise<SemanticBusinessCounts> {
    const counts = {} as SemanticBusinessCounts;
    for (const table of SEMANTIC_BUSINESS_TABLES) {
      counts[table] = Number(
        await this.db.valueQueryAsync(`SELECT COUNT(*) FROM ${table}`),
      );
    }
    return counts;
  }

  private readDatabaseFileSize(path: string): number | undefined {
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      return file.exists() ? Number(file.fileSize) : 0;
    } catch {
      return undefined;
    }
  }

  /**
   * Remove every semantic business row while preserving schema and migration
   * metadata. Success means the logical and physical postconditions were both
   * verified; callers must surface any rejection instead of claiming success.
   */
  async clearAll(): Promise<SemanticDatabaseClearReport> {
    await this.ensureInitialized();

    const before = await this.countSemanticBusinessRows();
    const beforeBytes = this.readDatabaseFileSize(this.dbPath);
    const walBeforeBytes = this.readDatabaseFileSize(`${this.dbPath}-wal`);
    const shmBeforeBytes = this.readDatabaseFileSize(`${this.dbPath}-shm`);
    const pageCountBefore = Number(
      await this.db.valueQueryAsync(`PRAGMA page_count`),
    );
    const freelistBefore = Number(
      await this.db.valueQueryAsync(`PRAGMA freelist_count`),
    );
    ztoolkit.log(
      `[VectorStore] clearAll() starting: ${SEMANTIC_BUSINESS_TABLES.map((table) => `${table}=${before[table]}`).join(', ')}`,
    );

    await this.db.executeTransaction(async () => {
      for (const table of SEMANTIC_BUSINESS_TABLES) {
        await this.db.queryAsync(`DELETE FROM ${table}`);
      }
      await this.db.queryAsync(
        `DELETE FROM sqlite_sequence WHERE name IN (?, ?)`,
        ['embeddings', 'vectors_f32'],
      );
    });

    this.vectorCache.clear();
    await this.gpuBackend.shutdown();

    await this.db.queryAsync(`PRAGMA wal_checkpoint(TRUNCATE)`);
    await this.db.queryAsync(`VACUUM`);
    await this.db.queryAsync(`PRAGMA wal_checkpoint(TRUNCATE)`);

    const after = await this.countSemanticBusinessRows();
    const pageCountAfter = Number(
      await this.db.valueQueryAsync(`PRAGMA page_count`),
    );
    const freelistAfter = Number(
      await this.db.valueQueryAsync(`PRAGMA freelist_count`),
    );
    const afterBytes = this.readDatabaseFileSize(this.dbPath);
    const walAfterBytes = this.readDatabaseFileSize(`${this.dbPath}-wal`);
    const shmAfterBytes = this.readDatabaseFileSize(`${this.dbPath}-shm`);

    const remaining = SEMANTIC_BUSINESS_TABLES.filter(
      (table) => after[table] !== 0,
    );
    if (remaining.length > 0) {
      throw new Error(
        `Semantic database reset left business rows: ${remaining.map((table) => `${table}=${after[table]}`).join(', ')}`,
      );
    }
    if (freelistAfter !== 0) {
      throw new Error(
        `Semantic database VACUUM left ${freelistAfter} free pages`,
      );
    }
    if (walAfterBytes !== undefined && walAfterBytes !== 0) {
      throw new Error(
        `Semantic database WAL was not truncated (${walAfterBytes} bytes remain)`,
      );
    }
    const rowsBefore = SEMANTIC_BUSINESS_TABLES.reduce(
      (sum, table) => sum + before[table],
      0,
    );
    if (
      rowsBefore > 0 &&
      beforeBytes !== undefined &&
      afterBytes !== undefined &&
      afterBytes >= beforeBytes
    ) {
      throw new Error(
        `Semantic database did not physically shrink (${beforeBytes} -> ${afterBytes} bytes)`,
      );
    }

    const report: SemanticDatabaseClearReport = {
      before,
      after,
      database: {
        path: this.dbPath,
        beforeBytes,
        afterBytes,
        walBeforeBytes,
        walAfterBytes,
        shmBeforeBytes,
        shmAfterBytes,
        pageCountBefore,
        pageCountAfter,
        freelistBefore,
        freelistAfter,
      },
    };
    ztoolkit.log(
      `[VectorStore] clearAll() verified: db=${beforeBytes ?? 'unknown'} -> ${afterBytes ?? 'unknown'} bytes, pages=${pageCountBefore} -> ${pageCountAfter}`,
    );
    return report;
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<VectorStoreStats> {
    await this.ensureInitialized();

    ztoolkit.log(`[VectorStore] getStats() called: instanceId=${this.instanceId}, dbPath=${this.dbPath}`);

    const total = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM embeddings`
    );
    const items = await this.db.valueQueryAsync(
      `SELECT COUNT(DISTINCT item_key) FROM embeddings`
    );
    const zh = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM embeddings WHERE language = 'zh'`
    );
    const en = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM embeddings WHERE language = 'en'`
    );

    // Get stored dimensions (from first vector)
    let storedDimensions: number | undefined;
    const dimsRow = await this.db.queryAsync(`SELECT dimensions FROM embeddings LIMIT 1`);
    if (dimsRow && dimsRow.length > 0) {
      storedDimensions = dimsRow[0].dimensions;
    }

    // Int8 migration status
    const int8Count = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM embeddings WHERE vector_int8 IS NOT NULL`
    );
    const int8MigrationStatus = total > 0 ? {
      migrated: int8Count || 0,
      total: total || 0,
      percent: Math.round(((int8Count || 0) / total) * 100)
    } : undefined;

    // Float32 table migration status
    const f32Count = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM vectors_f32`
    );
    const f32Unmigrated = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM embeddings WHERE LENGTH(vector) > 0`
    );
    if (f32Unmigrated > 0) {
      ztoolkit.log(`[VectorStore] Stats: ${f32Unmigrated} vectors still in embeddings.vector (not yet migrated to vectors_f32)`, 'warn');
    }

    // Get database file size
    let dbSizeBytes: number | undefined;
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(this.dbPath);
      if (file.exists()) {
        dbSizeBytes = file.fileSize;
      }
    } catch (e) {
      // Ignore file size errors
    }

    // index_status table count (may differ from embeddings DISTINCT count)
    const indexStatusCount = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM index_status`
    );
    if (indexStatusCount !== items) {
      ztoolkit.log(`[VectorStore] Stats mismatch: index_status=${indexStatusCount}, embeddings(DISTINCT item_key)=${items}. Some items may have index_status but no embeddings.`, 'warn');
    }

    // How much of the index is real body text rather than title+abstract.
    const bodyCoverage = {
      withBody: 0,
      metadataOnly: 0,
      noBodySource: 0,
      unknown: 0,
    };
    try {
      const coverageRows = await this.db.queryAsync(
        `SELECT source_kind, COUNT(*) AS n FROM index_status GROUP BY source_kind`,
      );
      for (const row of coverageRows || []) {
        const count = Number(row.n) || 0;
        switch (bodyIndexStateFromSourceKind(String(row.source_kind || ''))) {
          case 'body':
            bodyCoverage.withBody += count;
            break;
          case 'metadata-only':
            bodyCoverage.metadataOnly += count;
            break;
          case 'no-source':
            bodyCoverage.noBodySource += count;
            break;
          default:
            bodyCoverage.unknown += count;
        }
      }
    } catch (e) {
      ztoolkit.log(`[VectorStore] Could not compute body coverage: ${e}`, 'warn');
    }

    return {
      totalVectors: total || 0,
      totalItems: items || 0,
      zhVectors: zh || 0,
      enVectors: en || 0,
      cachedContentItems: 0,
      cachedContentSizeBytes: 0,
      storageMode: 'on-demand',
      storedDimensions,
      int8MigrationStatus,
      bodyCoverage,
      dbSizeBytes,
      dbPath: this.dbPath
    };
  }

  /**
   * Get the stored vectors of one item's chunks (for find_similar).
   *
   * Float32 is preferred because it needs no dequantisation, but it is NOT
   * required: an index built (or migrated) with Int8 only has no `vectors_f32`
   * rows at all, and searches on it work perfectly well. Reading Float32 alone
   * made find_similar report such an item as "not indexed" while every other
   * search found it.
   */
  async getItemVectors(itemKey: string, libraryID?: number): Promise<Array<{
    chunkId: number;
    vector: Float32Array;
    language: string;
  }>> {
    await this.ensureInitialized();

    // Get dimensions and language from embeddings table
    const storageKey = this.toStorageKey(itemKey, libraryID);
    const metaRows = await this.db.queryAsync(`SELECT chunk_id, language, dimensions, vector_int8, vector_scale FROM embeddings WHERE item_key = ? ORDER BY chunk_id`, [storageKey]);

    if (!metaRows || metaRows.length === 0) {
      return [];
    }

    // Get float32 vectors from vectors_f32 table
    const vecRows = await this.db.queryAsync(`SELECT chunk_id, vector FROM vectors_f32 WHERE item_key = ? ORDER BY chunk_id`, [storageKey]);

    // Build a map of chunk_id -> vector blob for fast lookup
    const vecMap = new Map<number, any>();
    if (vecRows && vecRows.length > 0) {
      for (const vr of vecRows) {
        vecMap.set(vr.chunk_id, vr.vector);
      }
    }

    const results: Array<{ chunkId: number; vector: Float32Array; language: string }> = [];
    for (const row of metaRows) {
      const dimensions = Number(row.dimensions);
      const vecBlob = vecMap.get(row.chunk_id);
      let vector: Float32Array | null = null;
      if (vecBlob) {
        try {
          vector = this.bufferToFloat32Array(vecBlob, dimensions);
        } catch {
          vector = null;
        }
      }
      if (!vector && row.vector_int8) {
        const scale = Number(row.vector_scale);
        if (Number.isFinite(dimensions) && Number.isFinite(scale) && scale !== 0) {
          try {
            vector = this.dequantizeFromInt8(
              this.bufferToInt8Array(row.vector_int8, dimensions),
              scale,
            );
          } catch {
            vector = null;
          }
        }
      }
      if (vector) {
        results.push({
          chunkId: row.chunk_id,
          vector,
          language: row.language
        });
      }
    }

    return results;
  }

  /**
   * Get chunk texts for items (without vectors, for filling keyword search results)
   */
  async getItemChunks(itemKeys: string[]): Promise<Map<string, Array<{
    chunkId: number;
    text: string;
    language: string;
  }>>> {
    await this.ensureInitialized();

    const result = new Map<string, Array<{ chunkId: number; text: string; language: string }>>();

    if (itemKeys.length === 0) return result;

    const placeholders = itemKeys.map(() => '?').join(',');
    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(`SELECT item_key, chunk_id, chunk_text, language FROM embeddings WHERE item_key IN (${placeholders}) ORDER BY item_key, chunk_id`, itemKeys);

    if (!rows || rows.length === 0) {
      return result;
    }

    for (const row of rows) {
      const chunks = result.get(row.item_key) || [];
      chunks.push({
        chunkId: row.chunk_id,
        text: row.chunk_text || '',
        language: row.language
      });
      result.set(row.item_key, chunks);
    }

    return result;
  }

  /**
   * All stored chunks of ONE item, in chunk_id order.
   *
   * Unlike {@link getItemChunks} this resolves the group-library storage key,
   * so it works for items outside the user library. Ordered because the
   * document-level deep dive treats chunk ids as reading order when it expands
   * context around a hit.
   */
  async getChunksForItem(itemKey: string, libraryID?: number): Promise<Array<{
    chunkId: number;
    text: string;
    language: string;
  }>> {
    await this.ensureInitialized();

    const storageKey = this.toStorageKey(itemKey, libraryID);
    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(`SELECT chunk_id, chunk_text, language FROM embeddings WHERE item_key = ? ORDER BY chunk_id`, [storageKey]);

    if (!rows || rows.length === 0) return [];

    return rows.map((row: any) => ({
      chunkId: row.chunk_id,
      text: row.chunk_text || '',
      language: row.language,
    }));
  }

  // ============ Utility Methods ============

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Convert Float32Array to buffer for storage
   */
  private float32ArrayToBuffer(arr: Float32Array): Uint8Array {
    return new Uint8Array(arr.buffer.slice(
      arr.byteOffset,
      arr.byteOffset + arr.byteLength
    ));
  }

  /**
   * Convert Int8Array to base64 string for reliable SQLite storage
   */
  private int8ArrayToBase64(arr: Int8Array): string {
    // Convert signed Int8 to unsigned bytes, then to base64
    const uint8 = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      uint8[i] = arr[i] & 0xFF;
    }
    // Use btoa with binary string
    let binary = '';
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert base64 string back to Int8Array
   */
  private base64ToInt8Array(base64: string, dimensions: number): Int8Array {
    const binary = atob(base64);
    const int8 = new Int8Array(dimensions);
    for (let i = 0; i < dimensions && i < binary.length; i++) {
      // Convert unsigned byte back to signed Int8
      const unsigned = binary.charCodeAt(i);
      int8[i] = unsigned > 127 ? unsigned - 256 : unsigned;
    }
    return int8;
  }

  /**
   * Convert buffer or base64 string to Int8Array
   */
  private bufferToInt8Array(buffer: any, dimensions: number): Int8Array {
    // Handle base64 string format (new storage format)
    if (typeof buffer === 'string') {
      return this.base64ToInt8Array(buffer, dimensions);
    }

    // Handle binary blob formats (legacy)
    let uint8Array: Uint8Array;

    if (buffer instanceof Uint8Array) {
      uint8Array = buffer;
    } else if (buffer instanceof ArrayBuffer) {
      uint8Array = new Uint8Array(buffer);
    } else if (typeof buffer === 'object' && buffer.buffer) {
      uint8Array = new Uint8Array(buffer.buffer);
    } else {
      uint8Array = new Uint8Array(buffer);
    }

    // Create Int8Array view
    return new Int8Array(uint8Array.buffer, uint8Array.byteOffset, dimensions);
  }

  /**
   * Convert buffer back to Float32Array
   */
  private bufferToFloat32Array(buffer: any, dimensions: number): Float32Array {
    // Handle different buffer formats from SQLite
    let uint8Array: Uint8Array;

    if (buffer instanceof Uint8Array) {
      uint8Array = buffer;
    } else if (buffer instanceof ArrayBuffer) {
      uint8Array = new Uint8Array(buffer);
    } else if (typeof buffer === 'object' && buffer.buffer) {
      uint8Array = new Uint8Array(buffer.buffer);
    } else {
      // Try to convert from array-like object
      uint8Array = new Uint8Array(buffer);
    }

    // Create properly aligned Float32Array
    const alignedBuffer = new ArrayBuffer(dimensions * 4);
    const alignedView = new Uint8Array(alignedBuffer);
    alignedView.set(uint8Array.slice(0, dimensions * 4));

    return new Float32Array(alignedBuffer);
  }

  // ============ Int8 Quantization Methods ============

  /**
   * Quantize Float32Array to Int8Array with scale factor
   * Uses symmetric quantization: int8_val = round(float_val * scale)
   * Scale is chosen so that max(|float_val|) maps to 127
   * @returns { quantized: Int8Array, scale: number }
   */
  private quantizeToInt8(vector: Float32Array): { quantized: Int8Array; scale: number } {
    const len = vector.length;

    // Find max absolute value for scaling
    let maxAbs = 0;
    for (let i = 0; i < len; i++) {
      const abs = Math.abs(vector[i]);
      if (abs > maxAbs) maxAbs = abs;
    }

    // Compute scale factor (avoid division by zero)
    const scale = maxAbs > 0 ? 127 / maxAbs : 1;

    // Quantize
    const quantized = new Int8Array(len);
    for (let i = 0; i < len; i++) {
      quantized[i] = Math.round(vector[i] * scale);
    }

    return { quantized, scale };
  }

  /**
   * Quantize vector to Int8 with pre-computed L2 norm for optimized search
   * This is used during indexing to pre-compute everything needed for fast similarity
   */
  private quantizeWithNorm(vector: Float32Array): QuantizedVector {
    const len = vector.length;

    // Compute L2 norm
    let normSq = 0;
    let maxAbs = 0;
    for (let i = 0; i < len; i++) {
      normSq += vector[i] * vector[i];
      const abs = Math.abs(vector[i]);
      if (abs > maxAbs) maxAbs = abs;
    }
    const norm = Math.sqrt(normSq);

    // Compute scale factor for Int8 quantization
    const scale = maxAbs > 0 ? 127 / maxAbs : 1;

    // Quantize
    const int8Data = new Int8Array(len);
    for (let i = 0; i < len; i++) {
      int8Data[i] = Math.round(vector[i] * scale);
    }

    return { int8Data, scale, norm };
  }

  /**
   * Dequantize Int8Array back to Float32Array
   */
  private dequantizeFromInt8(quantized: Int8Array, scale: number): Float32Array {
    const len = quantized.length;
    const vector = new Float32Array(len);

    for (let i = 0; i < len; i++) {
      vector[i] = quantized[i] / scale;
    }

    return vector;
  }

  /**
   * Fast cosine similarity using Int8 quantized vectors
   * Uses integer arithmetic for dot product, then converts to float for final result
   * ~4x faster than float comparison with ~99% accuracy
   * Note: Scale factors are not used in cosine similarity as they cancel out
   */
  private cosineSimilarityInt8(
    queryInt8: Int8Array,
    _queryScale: number,
    storedInt8: Int8Array,
    _storedScale: number
  ): number {
    const len = queryInt8.length;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    // Loop unrolling for integer arithmetic
    const unrollEnd = len - (len % 8);
    let i = 0;

    for (; i < unrollEnd; i += 8) {
      const a0 = queryInt8[i], a1 = queryInt8[i+1], a2 = queryInt8[i+2], a3 = queryInt8[i+3];
      const a4 = queryInt8[i+4], a5 = queryInt8[i+5], a6 = queryInt8[i+6], a7 = queryInt8[i+7];
      const b0 = storedInt8[i], b1 = storedInt8[i+1], b2 = storedInt8[i+2], b3 = storedInt8[i+3];
      const b4 = storedInt8[i+4], b5 = storedInt8[i+5], b6 = storedInt8[i+6], b7 = storedInt8[i+7];

      dotProduct += a0*b0 + a1*b1 + a2*b2 + a3*b3 + a4*b4 + a5*b5 + a6*b6 + a7*b7;
      normA += a0*a0 + a1*a1 + a2*a2 + a3*a3 + a4*a4 + a5*a5 + a6*a6 + a7*a7;
      normB += b0*b0 + b1*b1 + b2*b2 + b3*b3 + b4*b4 + b5*b5 + b6*b6 + b7*b7;
    }

    // Handle remaining elements
    for (; i < len; i++) {
      dotProduct += queryInt8[i] * storedInt8[i];
      normA += queryInt8[i] * queryInt8[i];
      normB += storedInt8[i] * storedInt8[i];
    }

    // Convert to float and compute final similarity
    // The scale factors cancel out in cosine similarity
    const magnitude = Math.sqrt(normA * normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Optimized Int8 cosine similarity - single pass computation
   *
   * Cosine similarity is scale-invariant: cos(a,b) = cos(k*a, m*b) for any k,m > 0
   * Therefore Int8 quantized cosine ≈ Float32 cosine with ~99% accuracy.
   *
   * This version computes dot product and norms in a single pass with loop unrolling
   * for maximum performance.
   */
  private cosineSimilarityInt8WithNorm(
    queryInt8: Int8Array,
    _queryNorm: number,  // Not used - we compute Int8 norm directly
    storedInt8: Int8Array,
    _storedNorm: number  // Not used - we compute Int8 norm directly
  ): number {
    const len = queryInt8.length;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    // Single pass: compute dot product and both norms together with loop unrolling
    const unrollEnd = len - (len % 8);
    let i = 0;

    for (; i < unrollEnd; i += 8) {
      const a0 = queryInt8[i], a1 = queryInt8[i+1], a2 = queryInt8[i+2], a3 = queryInt8[i+3];
      const a4 = queryInt8[i+4], a5 = queryInt8[i+5], a6 = queryInt8[i+6], a7 = queryInt8[i+7];
      const b0 = storedInt8[i], b1 = storedInt8[i+1], b2 = storedInt8[i+2], b3 = storedInt8[i+3];
      const b4 = storedInt8[i+4], b5 = storedInt8[i+5], b6 = storedInt8[i+6], b7 = storedInt8[i+7];

      dotProduct += a0*b0 + a1*b1 + a2*b2 + a3*b3 + a4*b4 + a5*b5 + a6*b6 + a7*b7;
      normA += a0*a0 + a1*a1 + a2*a2 + a3*a3 + a4*a4 + a5*a5 + a6*a6 + a7*a7;
      normB += b0*b0 + b1*b1 + b2*b2 + b3*b3 + b4*b4 + b5*b5 + b6*b6 + b7*b7;
    }

    // Handle remaining elements
    for (; i < len; i++) {
      const a = queryInt8[i];
      const b = storedInt8[i];
      dotProduct += a * b;
      normA += a * a;
      normB += b * b;
    }

    const magnitude = Math.sqrt(normA * normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Convert Float32Array to Int8Array buffer for storage (with scale prepended)
   * Format: [scale as Float32 (4 bytes)] + [Int8 values (n bytes)]
   */
  private float32ArrayToInt8Buffer(arr: Float32Array): Uint8Array {
    const { quantized, scale } = this.quantizeToInt8(arr);

    // Create buffer: 4 bytes for scale + n bytes for Int8 values
    const buffer = new Uint8Array(4 + quantized.length);

    // Write scale as Float32 at the beginning
    const scaleView = new DataView(buffer.buffer);
    scaleView.setFloat32(0, scale, true); // little-endian

    // Copy Int8 values
    buffer.set(new Uint8Array(quantized.buffer), 4);

    return buffer;
  }

  /**
   * Convert Int8 buffer back to Float32Array
   */
  private int8BufferToFloat32Array(buffer: Uint8Array, dimensions: number): Float32Array {
    // Read scale from first 4 bytes
    const scaleView = new DataView(buffer.buffer, buffer.byteOffset, 4);
    const scale = scaleView.getFloat32(0, true);

    // Read Int8 values
    const quantized = new Int8Array(buffer.buffer, buffer.byteOffset + 4, dimensions);

    return this.dequantizeFromInt8(quantized, scale);
  }

  /**
   * Calculate cosine similarity between two vectors
   * Optimized version with loop unrolling for better performance
   */
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    const len = a.length;
    if (len !== b.length) {
      throw new Error(`Vector dimension mismatch: ${len} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    // Loop unrolling: process 8 elements at a time for better CPU pipelining
    const unrollEnd = len - (len % 8);
    let i = 0;

    for (; i < unrollEnd; i += 8) {
      const a0 = a[i], a1 = a[i+1], a2 = a[i+2], a3 = a[i+3];
      const a4 = a[i+4], a5 = a[i+5], a6 = a[i+6], a7 = a[i+7];
      const b0 = b[i], b1 = b[i+1], b2 = b[i+2], b3 = b[i+3];
      const b4 = b[i+4], b5 = b[i+5], b6 = b[i+6], b7 = b[i+7];

      dotProduct += a0*b0 + a1*b1 + a2*b2 + a3*b3 + a4*b4 + a5*b5 + a6*b6 + a7*b7;
      normA += a0*a0 + a1*a1 + a2*a2 + a3*a3 + a4*a4 + a5*a5 + a6*a6 + a7*a7;
      normB += b0*b0 + b1*b1 + b2*b2 + b3*b3 + b4*b4 + b5*b5 + b6*b6 + b7*b7;
    }

    // Handle remaining elements
    for (; i < len; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA * normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Cosine similarity with pre-normalized query vector
   * Only computes norm for the stored vector, saving ~33% computation
   * @param normalizedQuery - Pre-normalized query vector (norm = 1)
   * @param storedVector - Stored vector (may not be normalized)
   */
  private cosineSimilarityWithNormalizedQuery(normalizedQuery: Float32Array, storedVector: Float32Array): number {
    const len = normalizedQuery.length;
    let dotProduct = 0;
    let normB = 0;

    // Loop unrolling: process 8 elements at a time
    const unrollEnd = len - (len % 8);
    let i = 0;

    for (; i < unrollEnd; i += 8) {
      const a0 = normalizedQuery[i], a1 = normalizedQuery[i+1], a2 = normalizedQuery[i+2], a3 = normalizedQuery[i+3];
      const a4 = normalizedQuery[i+4], a5 = normalizedQuery[i+5], a6 = normalizedQuery[i+6], a7 = normalizedQuery[i+7];
      const b0 = storedVector[i], b1 = storedVector[i+1], b2 = storedVector[i+2], b3 = storedVector[i+3];
      const b4 = storedVector[i+4], b5 = storedVector[i+5], b6 = storedVector[i+6], b7 = storedVector[i+7];

      dotProduct += a0*b0 + a1*b1 + a2*b2 + a3*b3 + a4*b4 + a5*b5 + a6*b6 + a7*b7;
      normB += b0*b0 + b1*b1 + b2*b2 + b3*b3 + b4*b4 + b5*b5 + b6*b6 + b7*b7;
    }

    // Handle remaining elements
    for (; i < len; i++) {
      dotProduct += normalizedQuery[i] * storedVector[i];
      normB += storedVector[i] * storedVector[i];
    }

    const magnitude = Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Pre-compute query vector norm for batch comparisons
   * Returns: { normalizedQuery, queryNorm }
   */
  private prepareQueryVector(queryVector: Float32Array): { normalized: Float32Array; norm: number } {
    const len = queryVector.length;
    let normSq = 0;

    for (let i = 0; i < len; i++) {
      normSq += queryVector[i] * queryVector[i];
    }

    const norm = Math.sqrt(normSq);
    if (norm === 0) {
      return { normalized: queryVector, norm: 0 };
    }

    // Normalize the query vector
    const normalized = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      normalized[i] = queryVector[i] / norm;
    }

    return { normalized, norm };
  }

  /**
   * Update LRU cache
   */
  private updateCache(key: string, vector: Float32Array): void {
    // Simple LRU: remove oldest when cache is full
    if (this.vectorCache.size >= this.cacheMaxSize) {
      const firstKey = this.vectorCache.keys().next().value;
      if (firstKey) {
        this.vectorCache.delete(firstKey);
      }
    }
    this.vectorCache.set(key, vector);
  }

  /**
   * Migrate existing vectors to Int8 format
   * Call this to enable optimized search on existing indexed data
   * @returns Number of vectors migrated
   */
  async migrateToInt8(onProgress?: (processed: number, total: number) => void): Promise<number> {
    await this.ensureInitialized();

    // Count vectors needing migration
    const totalCount = await this.db.valueQueryAsync(`SELECT COUNT(*) FROM embeddings WHERE vector_int8 IS NULL`);

    if (!totalCount || totalCount === 0) {
      ztoolkit.log('[VectorStore] No vectors need Int8 migration');
      return 0;
    }

    ztoolkit.log(`[VectorStore] Migrating ${totalCount} vectors to Int8 format...`);

    // Self-test: verify base64 encoding/decoding works correctly
    const testVector = new Float32Array([0.1, -0.5, 0.9, -0.1, 0.0, 0.123, -0.999, 0.5]);
    const testQuantized = this.quantizeWithNorm(testVector);
    const testBase64 = this.int8ArrayToBase64(testQuantized.int8Data);
    const testDecoded = this.base64ToInt8Array(testBase64, testVector.length);
    let testMatch = true;
    for (let i = 0; i < testVector.length; i++) {
      if (testQuantized.int8Data[i] !== testDecoded[i]) {
        testMatch = false;
        ztoolkit.log(`[VectorStore] SELF-TEST FAILED at index ${i}: original=${testQuantized.int8Data[i]}, decoded=${testDecoded[i]}`);
      }
    }
    ztoolkit.log(`[VectorStore] Base64 self-test: ${testMatch ? 'PASSED' : 'FAILED'}`);
    ztoolkit.log(`[VectorStore] Test data: original=[${Array.from(testQuantized.int8Data)}], decoded=[${Array.from(testDecoded)}], base64Len=${testBase64.length}`);

    const BATCH_SIZE = 100; // Smaller batch size for migration
    let processed = 0;
    let migrated = 0;

    while (processed < totalCount) {
      // Fetch batch of embeddings without Int8 data
      const rows = await this.db.queryAsync(`SELECT e.id, e.item_key, e.chunk_id, e.dimensions FROM embeddings e WHERE e.vector_int8 IS NULL LIMIT ?`, [BATCH_SIZE]);

      if (!rows || rows.length === 0) break;

      // Process each vector individually (not in transaction to avoid blob serialization issues)
      for (const row of rows) {
        try {
          // Read float32 vector from vectors_f32 table
          const f32Row = await this.db.queryAsync(`SELECT vector FROM vectors_f32 WHERE item_key = ? AND chunk_id = ?`, [row.item_key, row.chunk_id]);

          if (!f32Row || f32Row.length === 0) {
            ztoolkit.log(`[VectorStore] No float32 vector found for item_key=${row.item_key}, chunk_id=${row.chunk_id}, skipping`, 'warn');
            processed++;
            continue;
          }

          const vector = this.bufferToFloat32Array(f32Row[0].vector, row.dimensions);
          const quantized = this.quantizeWithNorm(vector);

          // Encode Int8 data as base64 string for reliable SQLite storage
          // Zotero's SQLite binding serializes Uint8Array as JSON object which fails
          const int8Base64 = this.int8ArrayToBase64(quantized.int8Data);

          // Log first 3 vectors being migrated
          if (migrated < 3) {
            const sampleFloat32 = vector.slice(0, 5);
            const sampleInt8 = quantized.int8Data.slice(0, 5);
            ztoolkit.log(`[VectorStore] Migration sample ${migrated}: id=${row.id}, dims=${row.dimensions}`);
            ztoolkit.log(`  Float32[0:5]=[${Array.from(sampleFloat32).map(v => v.toFixed(4))}]`);
            ztoolkit.log(`  Int8[0:5]=[${Array.from(sampleInt8)}], scale=${quantized.scale.toFixed(4)}, norm=${quantized.norm.toFixed(4)}`);
            ztoolkit.log(`  base64Len=${int8Base64.length}, expected=${Math.ceil(row.dimensions * 4 / 3)}`);
          }

          await this.db.queryAsync(`UPDATE embeddings SET vector_int8 = ?, vector_scale = ?, vector_norm = ? WHERE id = ?`, [
            int8Base64,
            quantized.scale,
            quantized.norm,
            row.id
          ]);

          migrated++;
        } catch (e) {
          ztoolkit.log(`[VectorStore] Failed to migrate vector id=${row.id}: ${e}`, 'warn');
        }
        processed++;
      }

      onProgress?.(processed, totalCount);

      if (migrated % 5000 === 0 && migrated > 0) {
        ztoolkit.log(`[VectorStore] Migration progress: ${migrated}/${totalCount} migrated`);
      }

      // Small delay to prevent blocking
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    ztoolkit.log(`[VectorStore] Migration completed: ${migrated} vectors converted to Int8`);

    // Verification: read back a few vectors and verify the Int8 data
    ztoolkit.log(`[VectorStore] Verifying migrated data...`);
    const verifyRows = await this.db.queryAsync(`SELECT e.id, e.item_key, e.chunk_id, e.vector_int8, e.dimensions, e.vector_scale, e.vector_norm FROM embeddings e WHERE e.vector_int8 IS NOT NULL LIMIT 3`);
    if (verifyRows && verifyRows.length > 0) {
      for (let i = 0; i < verifyRows.length; i++) {
        const vRow = verifyRows[i];
        const storedInt8 = this.bufferToInt8Array(vRow.vector_int8, vRow.dimensions);

        // Load original float32 from vectors_f32 for comparison
        const origF32Row = await this.db.queryAsync(`SELECT vector FROM vectors_f32 WHERE item_key = ? AND chunk_id = ?`, [vRow.item_key, vRow.chunk_id]);
        if (origF32Row && origF32Row.length > 0) {
          const originalVector = this.bufferToFloat32Array(origF32Row[0].vector, vRow.dimensions);
          const reQuantized = this.quantizeWithNorm(originalVector);

          // Check if stored Int8 matches re-quantized Int8
          let matchCount = 0;
          for (let j = 0; j < vRow.dimensions; j++) {
            if (storedInt8[j] === reQuantized.int8Data[j]) matchCount++;
          }

          ztoolkit.log(`[VectorStore] Verify ${i}: id=${vRow.id}, dims=${vRow.dimensions}`);
          ztoolkit.log(`  Stored Int8[0:5]=[${Array.from(storedInt8.slice(0, 5))}]`);
          ztoolkit.log(`  Expected Int8[0:5]=[${Array.from(reQuantized.int8Data.slice(0, 5))}]`);
          ztoolkit.log(`  Match: ${matchCount}/${vRow.dimensions} (${(matchCount / vRow.dimensions * 100).toFixed(1)}%)`);
        }
      }
    }

    return migrated;
  }

  /**
   * Check if Int8 migration is needed
   */
  async needsInt8Migration(): Promise<{ needed: boolean; count: number; total: number }> {
    await this.ensureInitialized();

    const total = await this.db.valueQueryAsync(`SELECT COUNT(*) FROM embeddings`) || 0;
    const withInt8 = await this.db.valueQueryAsync(`SELECT COUNT(*) FROM embeddings WHERE vector_int8 IS NOT NULL`) || 0;
    const needsMigration = total - withInt8;

    return {
      needed: needsMigration > 0,
      count: needsMigration,
      total
    };
  }

  /**
   * Close database connection
   * This method releases references synchronously and closes DB asynchronously
   * to ensure shutdown doesn't hang on pending async operations.
   */
  close(): void {
    const db = this.db;

    // Release references synchronously to prevent memory leaks
    this.db = null;
    this.initialized = false;
    this.initPromise = null;
    this.vectorCache.clear();
    void this.gpuBackend.shutdown();

    // Close database asynchronously (fire and forget)
    if (db) {
      try {
        db.closeDatabase().then(() => {
          ztoolkit.log('[VectorStore] Database closed successfully');
        }).catch((e: any) => {
          ztoolkit.log(`[VectorStore] Error closing database: ${e}`, 'warn');
        });
      } catch (e) {
        ztoolkit.log(`[VectorStore] Error initiating database close: ${e}`, 'warn');
      }
    }

    ztoolkit.log('[VectorStore] Database references released');
  }
}

// Singleton instance
let vectorStoreInstance: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (!vectorStoreInstance) {
    ztoolkit.log(`[VectorStore] getVectorStore() creating new singleton instance`);
    vectorStoreInstance = new VectorStore();
  } else {
    ztoolkit.log(`[VectorStore] getVectorStore() returning existing instance, instanceId=${(vectorStoreInstance as any).instanceId}`);
  }
  return vectorStoreInstance;
}

/**
 * Reset the singleton instance (for shutdown cleanup)
 */
export function resetVectorStore(): void {
  if (vectorStoreInstance) {
    vectorStoreInstance.close();
    vectorStoreInstance = null;
  }
  ztoolkit.log('[VectorStore] Singleton instance reset');
}
