/**
 * Semantic Search Module
 *
 * Exports all semantic search components for use in the Zotero MCP Plugin.
 */

// Core services
export {
  SemanticSearchService,
  getSemanticSearchService,
  // onShutdown 通过这个 barrel require 该函数来释放单例。之前它只在
  // semanticSearchService.ts 里 export、没有在这里转出，require destructure
  // 得到的是 undefined，关闭时抛 TypeError，单例因此从未被置空——
  // 禁用/重新启用插件会继续用上一份已 destroy 的实例。
  resetSemanticSearchService,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  classifyExtractedContent,
  type ExtractedItemContent,
  type SemanticSearchOptions,
  type SemanticSearchResult,
  type SimilarDocumentsResult,
  type IndexProgress,
  type SemanticServiceStats
} from './semanticSearchService';

// Oversized-chunk policy
export {
  ChunkOversizeDecisionGate,
  applyOversizeSkipToStatus,
  summarizeRun,
  type BuildRunStatus,
  type ChunkTooLargeAsk,
  type ChunkTooLargeDecision,
  type ChunkTooLargeDecisionRequest,
  type RunTally
} from './chunkOversizePolicy';

// Whether a stored index actually holds body text, or only metadata
export {
  bodyIndexStateFromSourceKind,
  describeFullTextAvailability,
  describeMissingBodyText,
  describePageFullTextGaps,
  emptyFullTextCoverage,
  fullTextAvailabilityFromState,
  fullTextCoverageTotal,
  hasBodyText,
  isBodyExtractionFailure,
  rowHasBodyText,
  sourceKindForBodyState,
  FULL_TEXT_AVAILABILITIES,
  INDEX_SOURCE_BODY,
  INDEX_SOURCE_METADATA_ONLY,
  INDEX_SOURCE_NO_BODY_SOURCE,
  LEGACY_SOURCE_KINDS,
  type BodyIndexState,
  type FullTextAvailability,
  type FullTextCoverage
} from './bodyIndexState';

// Scan budget for multi-chunk similarity search
export {
  resolveSimilarScanBudget,
  SIMILAR_SCAN_BUDGET_CEILING_MS,
  SIMILAR_SCAN_BUDGET_MODEL,
  type SimilarScanBudget,
  type SimilarScanPath
} from './similarScanBudget';

// Document-level aggregation for multi-chunk similarity search
export {
  aggregateSimilarDocument,
  rankSimilarDocuments,
  MAX_SIMILAR_QUERY_CHUNKS,
  SIMILAR_CHUNKS_PER_QUERY,
  SIMILAR_MAX_WEIGHT,
  SIMILAR_MEAN_WEIGHT,
  type AggregatedSimilarDocument,
  type SimilarDocumentMatch
} from './similarDocumentAggregation';

// Embedding service
export {
  EmbeddingService,
  getEmbeddingService,
  type EmbeddingResult,
  type BatchEmbeddingItem,
  type EmbeddingConfig,
  type EmbeddingServiceStatus,
  EmbeddingAPIError,
  SINGLE_CHUNK_TOO_LARGE_MESSAGE,
  type EmbeddingErrorType
} from './embeddingService';

// Adaptive embedding batch capacity
export {
  capacityBudget,
  capacityKey,
  createCapacityState,
  normalizeCapacityState,
  packBatch,
  parseCapacityRecords,
  recordCapacityLengthFailure,
  recordCapacitySuccess,
  totalChars,
  writeCapacityRecord,
  CAPACITY_CONVERGE_ABS_CHARS,
  CAPACITY_CONVERGE_REL,
  CAPACITY_STORE_MAX_ENTRIES,
  type BatchCapacityState,
  type CapacityRecords
} from './batchCapacity';

// Vector storage
export {
  VectorStore,
  getVectorStore,
  type VectorRecord,
  type QuantizedVector,
  type SearchResult,
  type IndexStatus,
  type VectorStoreStats,
  type MultiQueryChunkHit,
  type MultiQueryDocumentMatch,
  type MultiQuerySearchOptions
} from './vectorStore';

// Text processing
export {
  TextChunker,
  getTextChunker,
  resetTextChunker,
  TextQualityPreprocessor,
  type ChunkerOptions,
  type TextChunk,
  type SemanticChunk
} from './textChunker';
