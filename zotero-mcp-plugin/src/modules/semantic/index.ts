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
  type SemanticSearchOptions,
  type SemanticSearchResult,
  type IndexProgress,
  type SemanticServiceStats
} from './semanticSearchService';

// Embedding service
export {
  EmbeddingService,
  getEmbeddingService,
  type EmbeddingResult,
  type BatchEmbeddingItem,
  type EmbeddingConfig,
  type EmbeddingServiceStatus
} from './embeddingService';

// Vector storage
export {
  VectorStore,
  getVectorStore,
  type VectorRecord,
  type QuantizedVector,
  type SearchResult,
  type IndexStatus,
  type VectorStoreStats
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
