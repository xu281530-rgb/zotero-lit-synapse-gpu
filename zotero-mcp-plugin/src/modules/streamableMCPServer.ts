import {
  handleGetLibraries,
  handleSearchLibraries,
  handleSearch,
  handleGetItem,
  handleGetCollections,
  handleSearchCollections,
  handleGetCollectionDetails,
  handleGetCollectionItems,
  handleGetItemAbstract,
  handleCreateCollection,
  handleUpdateCollection,
  handleDeleteCollection,
  handleAddItemsToCollection,
  handleRemoveItemsFromCollection,
  handleMoveItemsToCollection,
  handleMergeItems,
} from './apiHandlers';
import { describeNonDocumentKey, type ItemKeyKind } from './itemKeyKind';
import { DEFAULT_FIELD_PARAMETERS } from './keyword/bm25f';
import { UnifiedContentExtractor } from './unifiedContentExtractor';
import { SmartAnnotationExtractor } from './smartAnnotationExtractor';
import {
  filterToolCatalog,
  REMOVED_TOOL_REPLACEMENTS,
  WIKI_TOOL_NAMES,
  type ToolDefinition,
} from './toolCatalog';
import {
  describeTextMethod,
  isEmptyTextMethod,
  selectAttachment,
  takeTextWindow,
  type AttachmentSummary,
  type AttachmentTextMethod,
} from './attachmentText';
import {
  DocumentChunksError,
  readDocumentChunks,
  type DocumentChunksDeps,
} from './documentChunks';
import {
  browseCollection,
  CollectionBrowserError,
  type BrowsedItem,
  type CollectionBrowserDeps,
  type CollectionNode,
} from './collectionBrowser';
import { describeItemCollections } from './itemFormatter';
import {
  COLLECTIONS_DEFAULT_LIMIT,
  prepareFixedContentToolArgs,
  SEARCH_LIBRARY_DEFAULT_LIMIT,
  STANDARD_ITEM_DETAIL_FIELDS,
} from './contentToolDefaults';
import {
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  describeFullTextAvailability,
  describePageFullTextGaps,
  buildSearchIndex,
  emptyFullTextCoverage,
  fullTextAvailabilityFromState,
  getSemanticSearchService,
  getVectorStore,
  type BodyIndexState,
  type FullTextAvailability,
  type FullTextCoverage,
  MAX_SIMILAR_QUERY_CHUNKS,
  resolveSimilarScanBudget,
  SemanticSearchService,
  SIMILAR_CHUNKS_PER_QUERY,
  SIMILAR_MAX_WEIGHT,
  SIMILAR_MEAN_WEIGHT,
} from './semantic';
import {
  HYBRID_KEYWORD_COVERAGE_BONUS,
  LEXICAL_FIELD_WEIGHTS,
  MAX_HYBRID_KEYWORDS,
  MAX_SUPPLIED_KEYWORDS,
  normalizeLexicalScore,
  normalizeSemanticScore,
  resolveHybridKeywords,
  resolveKeywordProvenance,
  runHybridSearch,
  runWithTimeout,
  type HybridSearchOptions,
  type KeywordSearchItem,
  type SemanticSearchItem,
} from './hybridSearch';
import {
  DIMENSION_MISMATCH_HINT,
  isVectorDimensionMismatchError,
} from './semantic/dimensionMismatch';
import {
  getHybridSearchSettings,
  resolveResultCap,
  resolveScoreFloor,
} from './hybridSearchSettings';
import { expandChunkContext, runDocumentDeepDive } from './documentDeepDive';
import { isLexicalSearchTimeoutError, runLexicalSearch } from './lexicalSearch';
import {
  isKeywordSearchGateError,
  isKeywordSearchUnavailableError,
} from './keywordSearchGate';
import {
  HYBRID_EVIDENCE_CHUNKS,
  detectDocumentLanguage,
  projectHybridCandidate,
  roundScore,
  truncateEvidence,
} from './hybridCandidates';
import {
  CursorError,
  detachPageWindow,
  HYBRID_PAGE_IDENTITY,
  HybridSearchPageStore,
  KEYWORD_PAGE_IDENTITY,
  SEMANTIC_PAGE_IDENTITY,
  SIMILAR_PAGE_IDENTITY,
  windowOf,
} from './hybridSearchPages';
import { resolveCollectionScope } from './collectionScope';
import type { CollectionScope } from './collectionScope';
import type {
  FingerprintClaim,
  PageWindow,
  SearchFingerprint,
} from './hybridSearchPages';
import {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
} from './mcpTransport';
import {
  describePrivateText,
  sanitizeForPrivacy,
  scrubPathFields,
} from '../utils/privacy';
import { config } from '../../package.json';
import { getWikiService } from './wiki/wikiService';
import { getWikiSettings } from './wiki/wikiSettings';

export interface MCPRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface MCPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

function invalidMCPRequestMessage(value: unknown): string | null {
  if (Array.isArray(value)) {
    return 'Invalid Request: batch requests are not supported';
  }
  if (!value || typeof value !== 'object') return 'Invalid Request';

  const request = value as Record<string, unknown>;
  if (request.jsonrpc !== '2.0') {
    return 'Invalid Request: jsonrpc must be "2.0"';
  }
  if (typeof request.method !== 'string' || !request.method.trim()) {
    return 'Invalid Request: method is required';
  }
  if (Object.prototype.hasOwnProperty.call(request, 'id')) {
    const id = request.id;
    if (
      id !== null &&
      typeof id !== 'string' &&
      typeof id !== 'number'
    ) {
      return 'Invalid Request: id must be a string, number, or null';
    }
  }
  return null;
}

const PREF_WRITE_ENABLED = 'extensions.zotero.zotero-mcp-plugin.write.enabled';
const PREF_WRITE_CONFIRM =
  'extensions.zotero.zotero-mcp-plugin.write.confirmBeforeMutation';
const PREF_ALLOW_FILE_IMPORT =
  'extensions.zotero.zotero-mcp-plugin.write.allowFileImport';

/**
 * 所有会改动 Zotero 数据的工具。
 *
 * 之前 tools/list 只隐藏了 write_* 四个工具，collection 的增删改和成员
 * 增删照样对外可见，客户端会以为可以调用；调用层虽然拦得住，但工具清单
 * 与实际权限不一致本身就是缺陷。
 */
export const MUTATING_TOOL_NAMES = new Set<string>([
  'write_note',
  'write_tag',
  'write_metadata',
  'write_item',
  'create_collection',
  'update_collection',
  'delete_collection',
  'add_items_to_collection',
  'remove_items_from_collection',
  'move_items_to_collection',
  'merge_items',
  'wiki_set_reading_expert',
  'wiki_update_reading_note',
]);

/**
 * Write handlers that return a structured receipt even when execution fails.
 *
 * Keeping the receipt is useful -- it can explain whether a transaction wrote
 * nothing and whether a retry is safe -- but it still has to be marked as an
 * MCP tool error. Without `isError`, clients see a completed call and may run
 * the next mutation even though this one returned `success:false`.
 */
const STRUCTURED_WRITE_TOOL_NAMES = new Set<string>([
  'write_note',
  'write_tag',
  'write_metadata',
  'write_item',
]);

function isFailedStructuredWrite(toolName: string, result: any): boolean {
  return (
    STRUCTURED_WRITE_TOOL_NAMES.has(toolName) &&
    result !== null &&
    typeof result === 'object' &&
    result.success === false
  );
}

/**
 * A call that inspects a mutation instead of performing one.
 *
 * `move_items_to_collection` with `dryRun` runs the same preflight and returns
 * the same plan, but writes nothing, so asking the user to approve it would be
 * asking them to approve nothing — and training them to click through the
 * prompt that guards the real write. It still requires write operations to be
 * ENABLED: previewing a capability the server would refuse to exercise is a
 * misleading answer.
 */
function isMutationPreview(toolName: string, args: any): boolean {
  return (
    (toolName === 'move_items_to_collection' ||
      toolName === 'merge_items') &&
    args?.dryRun === true
  );
}

/**
 * Trim a fused row to what a cached page can ever need.
 *
 * A cached ranking holds every document above the threshold, and each one
 * arrives carrying up to three full passages. Only the first two, truncated,
 * are ever shown, so keeping the rest would be holding a slice of the library's
 * text in memory for the duration of a paging session.
 */
function trimCachedEvidence(row: Record<string, any>): Record<string, any> {
  // Body-keyword evidence is trimmed for the same reason semantic evidence is:
  // a cached ranking can hold hundreds of rows for 15 minutes, and each raw
  // passage is a full chunk. The projection would truncate these anyway, so
  // storing them untrimmed only costs memory nobody reads.
  if (Array.isArray(row.bodyEvidence)) {
    row.bodyEvidence = row.bodyEvidence
      .slice(0, HYBRID_EVIDENCE_CHUNKS)
      .map((chunk: any) => ({
        chunkId: chunk?.chunkId,
        matchedKeywords: chunk?.matchedKeywords,
        occurrences: chunk?.occurrences,
        ...(chunk?.text ? { text: truncateEvidence(String(chunk.text)) } : {}),
      }));
  }
  if (!Array.isArray(row.matchedChunks)) return row;
  row.matchedChunks = row.matchedChunks
    .slice(0, HYBRID_EVIDENCE_CHUNKS)
    .map((chunk: any) => ({
      chunkId: chunk?.chunkId,
      rowId: chunk?.rowId,
      score: chunk?.score,
      text: truncateEvidence(String(chunk?.text || '')),
    }));
  return row;
}

/**
 * Everything about one hybrid_search that does not change between its pages.
 *
 * Held so page 2 can be answered from the stored ranking: re-running the search
 * would re-rank, and a re-ranked page 2 can duplicate, skip or reorder what page
 * 1 already showed.
 */
/**
 * A stable identity for what a search was allowed to look at.
 *
 * Two searches over different collections are different result sets, so paging
 * from one into the other would silently splice them together.
 */
function describeScope(scope: CollectionScope): string {
  if (scope.searchScope === 'library') return 'library';
  return `collections:${scope.collections
    .map((c) => c.key)
    .sort()
    .join(',')}`;
}

/** Everything about one find_similar run that stays the same across its pages. */
interface SimilarSearchSnapshot {
  itemKey: string;
  libraryID: number;
  queryChunkIds: number[];
  appliedMinScore: number;
  metadata: Record<string, any>;
}

interface HybridSearchSnapshot {
  query: string;
  keywords: string[];
  keywordSource: string;
  degraded: boolean;
  warning: string | null;
  fallbackReason?: string;
  retryBudgetNote: string;
  /**
   * The single relevance floor of a single-branch tool (semantic_search,
   * keyword_search, find_similar). hybrid_search and search_fulltext leave it
   * at 0 and carry the two fields below instead: they gate two differently
   * scaled branches independently, so there is no one number to put here.
   */
  appliedMinScore: number;
  appliedKeywordMinScore?: number;
  appliedSemanticMinScore?: number;
  appliedWikiMinScore?: number;
  libraryID: number;
  /** True when a retrieval branch failed or timed out during this search. */
  branchFailed: boolean;
  /**
   * The semantic branch is offline because the stored vectors were produced by
   * a different embedding model than the one configured now. Carried on the
   * snapshot so every page of the result — not just the first — states that
   * these rows are keyword-only and that the fix is a rebuild.
   */
  semanticIndexIncompatible?: boolean;
  metadata: Record<string, any>;
}

const WRITE_DISABLED_MESSAGE =
  'Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.';

export function isWriteEnabled(): boolean {
  try {
    return Zotero.Prefs.get(PREF_WRITE_ENABLED, true) === true;
  } catch {
    return false;
  }
}

function assertWriteEnabled(toolName: string): void {
  if (!isWriteEnabled()) {
    ztoolkit.log(
      `[StreamableMCP] Blocked ${toolName}: write operations disabled`,
      'warn',
    );
    throw new Error(WRITE_DISABLED_MESSAGE);
  }
}

/** `write.allowFileImport` 是否允许从任意本机路径导入文件。默认不允许。 */
export function isFileImportAllowed(): boolean {
  try {
    return Zotero.Prefs.get(PREF_ALLOW_FILE_IMPORT, true) === true;
  } catch {
    return false;
  }
}

function isMutationConfirmationRequired(): boolean {
  try {
    // 偏好缺失时按开启处理，与 addon/prefs.js 的默认值 true 一致：
    // 确认框宁可多弹，也不能因为读不到偏好而静默放行写操作。
    return Zotero.Prefs.get(PREF_WRITE_CONFIRM, true) !== false;
  } catch {
    return true;
  }
}

/**
 * 为确认框生成一句人类可读的操作摘要，尽量不泄漏大段内容。
 *
 * 摘要里必须出现真实的破坏范围，而不只是工具名和键。`delete_collection`
 * 带上 deleteItems=true 时不只是删掉一个分类文件夹，还会把里面的条目一并
 * 送进回收站；摘要以前完全不提这件事，用户看到的确认框和一个“只删文件夹”
 * 的确认框长得一模一样。
 */
function describeMutation(toolName: string, args: any): string {
  const parts: string[] = [];
  if (args?.action) parts.push(`action: ${String(args.action)}`);
  if (args?.itemKey) parts.push(`item: ${String(args.itemKey)}`);
  if (args?.noteKey) parts.push(`note: ${String(args.noteKey)}`);
  if (args?.parentKey) parts.push(`parent: ${String(args.parentKey)}`);
  if (args?.collectionKey)
    parts.push(`collection: ${String(args.collectionKey)}`);
  if (args?.toCollectionKey)
    parts.push(`into collection: ${String(args.toCollectionKey)}`);
  if (args?.name) parts.push(`name: ${String(args.name)}`);
  if (Array.isArray(args?.itemKeys))
    parts.push(`items: ${args.itemKeys.length}`);
  if (Array.isArray(args?.tags)) parts.push(`tags: ${args.tags.length}`);
  if (toolName === 'delete_collection') {
    parts.push(
      args?.deleteItems === true
        ? 'ALSO SENDS EVERY ITEM IN THIS COLLECTION TO THE TRASH (deleteItems: true)'
        : 'items stay in the library (deleteItems: false)',
    );
  }
  // An update whose content is empty is an ERASE, and the prompt for it used
  // to be indistinguishable from the prompt for a rewrite.
  if (
    toolName === 'write_note' &&
    args?.action === 'update' &&
    typeof args?.content === 'string' &&
    args.content.trim().length === 0
  ) {
    parts.push("CLEARS THE NOTE — its current content is erased");
  }
  return parts.length > 0 ? parts.join(', ') : 'no additional parameters';
}

/**
 * `write.confirmBeforeMutation` 的实际执行点。
 *
 * 之前这个偏好只存在于设置页，勾不勾都不影响任何写操作。这里在真正落库前
 * 弹一个模态确认框；用户拒绝或没有可用主窗口时抛错，让工具调用失败而不是
 * 无声地改库。
 */
async function assertMutationConfirmed(
  toolName: string,
  args: any,
): Promise<void> {
  if (!isMutationConfirmationRequired()) return;

  let win: any = null;
  try {
    win = Zotero.getMainWindow();
  } catch {
    win = null;
  }

  if (!win) {
    // 没有窗口就没法征求同意，此时放行等于绕过该设置。
    throw new Error(
      `Confirmation is required before write operations (write.confirmBeforeMutation), but no Zotero window is available to ask. Bring Zotero to the foreground and retry, or turn the setting off.`,
    );
  }

  let approved = false;
  try {
    approved = Services.prompt.confirm(
      win,
      'Zotero MCP Plugin',
      `An MCP client is requesting to modify your Zotero library.

Tool: ${toolName}
${describeMutation(toolName, args)}

Allow this change?`,
    );
  } catch (error) {
    ztoolkit.log(
      `[StreamableMCP] Mutation confirmation dialog failed: ${error}`,
      'error',
    );
    throw new Error(
      `Could not display the write confirmation dialog required by write.confirmBeforeMutation: ${error}`,
    );
  }

  if (!approved) {
    ztoolkit.log(`[StreamableMCP] User declined mutation: ${toolName}`, 'warn');
    throw new Error(`The user declined the requested ${toolName} operation.`);
  }
}

async function authorizeZoteroWrite(
  toolName: string,
  args: any,
): Promise<true> {
  assertWriteEnabled(toolName);
  await assertMutationConfirmed(toolName, args);
  return true;
}

async function assertWikiCommitConfirmed(args: any): Promise<void> {
  const settings = getWikiSettings();
  if (!settings.enabled)
    throw new Error('LLM Wiki is disabled in plugin preferences.');
  if (settings.autoWrite && settings.writeMode === 'auto') return;
  const win = Zotero.getMainWindow?.();
  if (!win) {
    throw new Error(
      'Wiki confirmation is required, but no Zotero window is available.',
    );
  }
  const approved = Services.prompt.confirm(
    win as any,
    'Zotero MCP LLM Wiki',
    `An MCP client wants to update the independent long-term Wiki database.\n\nControlled actions: ${Array.isArray(args?.actions) ? args.actions.length : 0}\nThis does not modify Zotero items.\n\nAllow this Wiki update?`,
  );
  if (!approved) throw new Error('The user declined the Wiki database update.');
}

function assertWikiEnabled(): void {
  if (!getWikiSettings().enabled)
    throw new Error('LLM Wiki is disabled in plugin preferences.');
}

/**
 * `write_tag` 的 tags 参数必须是字符串数组，且在任何改动发生前就验完。
 *
 * 目录声明的是 array of string，但入口只判断了真值。传成字符串时
 * `for (const tag of tags)` 会逐字符迭代，于是 action "set" 会先删光旧标签，
 * 再写入一串单字符标签 —— 破坏已经发生，工具却返回成功。所以这里在调用
 * 处理器之前就拒绝，而不是留给 Zotero 去发现。
 */
function assertTagArray(tags: unknown): asserts tags is string[] {
  if (!Array.isArray(tags)) {
    throw new Error(
      `tags must be an ARRAY of strings, e.g. ["方法", "待验证"]. Received ${typeof tags}: ${JSON.stringify(tags)}. A bare string is iterated character by character, which with action "set" would replace every existing tag with one tag per character.`,
    );
  }
  for (const tag of tags) {
    if (typeof tag !== 'string' || !tag.trim()) {
      throw new Error(
        `Every entry of tags must be a non-empty string. Received: ${JSON.stringify(tags)}`,
      );
    }
  }
}

/** Validate the complete write_metadata payload before confirmation or save. */
function assertWriteMetadataArgs(args: any): void {
  if (typeof args?.itemKey !== 'string' || !args.itemKey.trim()) {
    throw new Error('itemKey is required and must be a non-empty string');
  }

  const hasFields = Object.prototype.hasOwnProperty.call(args, 'fields');
  const hasCreators = Object.prototype.hasOwnProperty.call(args, 'creators');
  if (!hasFields && !hasCreators) {
    throw new Error('At least one of fields or creators is required');
  }

  let fieldCount = 0;
  if (hasFields) {
    if (
      args.fields === null ||
      typeof args.fields !== 'object' ||
      Array.isArray(args.fields)
    ) {
      throw new Error('fields must be an object whose values are strings');
    }
    const entries = Object.entries(args.fields);
    fieldCount = entries.length;
    for (const [fieldName, value] of entries) {
      if (typeof value !== 'string') {
        throw new Error(
          `fields.${fieldName} must be a string. Received ${typeof value}: ${JSON.stringify(value)}`,
        );
      }
    }
  }

  if (hasCreators) {
    if (!Array.isArray(args.creators)) {
      throw new Error('creators must be an array of creator objects');
    }
    args.creators.forEach((creator: any, index: number) => {
      if (
        creator === null ||
        typeof creator !== 'object' ||
        Array.isArray(creator)
      ) {
        throw new Error(`creators[${index}] must be an object`);
      }
      if (
        typeof creator.creatorType !== 'string' ||
        !creator.creatorType.trim()
      ) {
        throw new Error(
          `creators[${index}].creatorType is required and must be a non-empty string`,
        );
      }
      for (const nameField of ['firstName', 'lastName', 'name']) {
        if (
          creator[nameField] !== undefined &&
          typeof creator[nameField] !== 'string'
        ) {
          throw new Error(
            `creators[${index}].${nameField} must be a string when provided`,
          );
        }
      }
    });
  }

  // An empty creators array is meaningful: it clears the current creator list.
  if (fieldCount === 0 && !hasCreators) {
    throw new Error(
      'fields must contain at least one field when creators is not provided',
    );
  }
}

/**
 * The same consent gate as a Wiki commit, for a concept-library write.
 *
 * Recording concepts writes to the same independent Wiki database, so it
 * honours the same preference rather than quietly bypassing it. The dialog
 * says what is being written - terminology, not claims - because a user who
 * sees a prompt every few minutes deserves to know which kind of write it is.
 *
 * Passed to the service as a callback rather than run before it, because only
 * the service knows whether this call actually writes. A mid-reading call is
 * staged on the reading session and asks nothing; the one whole-paper pass
 * that commits the lot raises exactly one dialog. That is the difference
 * between a prompt per batch and a prompt per paper.
 */
async function assertWikiConceptWriteConfirmed(count: number): Promise<void> {
  const settings = getWikiSettings();
  if (!settings.enabled)
    throw new Error('LLM Wiki is disabled in plugin preferences.');
  if (settings.autoWrite && settings.writeMode === 'auto') return;
  const win = Zotero.getMainWindow?.();
  if (!win) {
    throw new Error(
      'Wiki confirmation is required, but no Zotero window is available.',
    );
  }
  const approved = Services.prompt.confirm(
    win as any,
    'Zotero MCP LLM Wiki',
    `An MCP client has finished reading a paper and wants to record ${count} concept(s) in the independent Wiki terminology library.\n\nThis stores terms and their source documents. It does not modify Zotero items.\n\nAllow this terminology update?`,
  );
  if (!approved) throw new Error('The user declined the Wiki terminology update.');
}

/**
 * Streamable HTTP-based MCP Server integrated into Zotero Plugin
 *
 * This provides a complete MCP (Model Context Protocol) server implementation
 * that runs directly within the Zotero plugin. AI clients can connect using
 * streamable HTTP requests for real-time bidirectional communication.
 *
 * Architecture: AI Client (streamable HTTP) ↔ Zotero Plugin (integrated MCP server)
 */
export class StreamableMCPServer {
  private isInitialized: boolean = false;
  private serverInfo = {
    name: 'zotero-integrated-mcp',
    // 与 manifest.json / 设置页脚同源，避免三处版本号各说各话。
    version: config.addonVersion,
  };
  /**
   * Paging state for hybrid_search: one entry per recent search, holding the
   * complete list of documents that cleared the relevance threshold. Page 2
   * is a window onto that list, never a second search.
   */
  private hybridPages = new HybridSearchPageStore<
    Record<string, any>,
    HybridSearchSnapshot
  >();
  /**
   * Paging state for find_similar — deliberately a SEPARATE store from
   * hybrid_search's.
   *
   * Both keep only the few most recent searches, and the two tools are meant to
   * be used together (find candidates, dig into one, look for more like it).
   * Sharing one table would let a hybrid_search evict the similarity ranking the
   * AI was halfway through paging, and vice versa.
   */
  private similarPages = new HybridSearchPageStore<
    Record<string, any>,
    SimilarSearchSnapshot
  >(undefined, undefined, undefined, SIMILAR_PAGE_IDENTITY);
  /**
   * Paging state for semantic_search and keyword_search — one store each, for
   * the same reason find_similar has its own.
   *
   * The intended chain is keyword_search (coarse) then semantic_search (fine)
   * over the shortlist, so both are live at once by design. A shared table
   * would let the fine search evict the coarse ranking the caller is still
   * paging through, and the cursor prefixes keep the four tools' cursors from
   * being accepted by each other.
   */
  private semanticPages = new HybridSearchPageStore<
    Record<string, any>,
    HybridSearchSnapshot
  >(undefined, undefined, undefined, SEMANTIC_PAGE_IDENTITY);
  private keywordPages = new HybridSearchPageStore<
    Record<string, any>,
    HybridSearchSnapshot
  >(undefined, undefined, undefined, KEYWORD_PAGE_IDENTITY);

  constructor() {
    // No initialization needed - using direct function calls
  }

  clearSemanticState(): void {
    this.hybridPages.clear();
    this.similarPages.clear();
    this.semanticPages.clear();
    this.keywordPages.clear();
    if (
      this.hybridPages.size !== 0 ||
      this.similarPages.size !== 0 ||
      this.semanticPages.size !== 0 ||
      this.keywordPages.size !== 0
    ) {
      throw new Error('Semantic pagination state could not be cleared');
    }
  }

  /**
   * Handle incoming MCP requests and return HTTP response
   */
  async handleMCPRequest(
    requestBody: string,
    requestId = 0,
  ): Promise<{
    status: number;
    statusText: string;
    headers: any;
    body: string;
  }> {
    let parsedRequest: unknown;

    try {
      parsedRequest = JSON.parse(requestBody);
    } catch {
      // 走到这里说明收到的确实不是合法 JSON。只记录长度，足以结合
      // httpServer 的分帧日志判断请求体是否截断，同时避免泄露请求内容。
      ztoolkit.log(
        `[StreamableMCP] #${requestId} Parse error: invalid JSON (body ${describePrivateText(requestBody)})`,
        'error',
      );

      const errorResponse: MCPResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      };

      return {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: this.serializeResponse(errorResponse),
      };
    }

    try {
      const invalidMessage = invalidMCPRequestMessage(parsedRequest);
      if (invalidMessage) {
        const invalidRequest = this.createError(
          null,
          -32600,
          invalidMessage,
        );
        return {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: this.serializeResponse(invalidRequest),
        };
      }

      const request = parsedRequest as MCPRequest;

      ztoolkit.log(
        `[StreamableMCP] #${requestId} received method=${request.method} id=${JSON.stringify(request.id ?? null)}`,
      );

      const response = await this.processRequest(request);

      if (response === null) {
        return {
          status: 202,
          statusText: 'Accepted',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: '',
        };
      }

      const status = this.getHttpStatusForResponse(response);
      ztoolkit.log(
        `[StreamableMCP] #${requestId} responding to ${request.method} id=${JSON.stringify(response.id ?? null)} status=${status}${response.error ? ` error=${response.error.code}` : ''}`,
      );
      return {
        status,
        statusText: status === 400 ? 'Bad Request' : 'OK',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: this.serializeResponse(response),
      };
    } catch (error) {
      ztoolkit.log(
        `[StreamableMCP] #${requestId} Error handling request: ${error}`,
        'error',
      );

      const errorResponse: MCPResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: 'Internal error',
        },
      };

      return {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: this.serializeResponse(errorResponse),
      };
    }
  }

  /**
   * Process individual MCP requests
   */
  private async processRequest(
    request: MCPRequest,
  ): Promise<MCPResponse | null> {
    const isNotification = this.isNotificationRequest(request);

    if (isNotification) {
      switch (request.method) {
        case 'initialized':
        case 'notifications/initialized':
          this.isInitialized = true;
          ztoolkit.log('[StreamableMCP] Client initialized (notification)');
          return null;
        default:
          if (request.method.startsWith('notifications/')) {
            ztoolkit.log(
              `[StreamableMCP] Ignoring unsupported notification: ${request.method}`,
            );
            return null;
          }
          return this.createError(
            null,
            -32600,
            `Invalid Request: id is required for method ${request.method}`,
          );
      }
    }

    try {
      switch (request.method) {
        case 'initialize':
          return this.handleInitialize(request);

        case 'initialized':
        case 'notifications/initialized':
          this.isInitialized = true;
          ztoolkit.log('[StreamableMCP] Client initialized');
          return this.createResponse(request.id ?? null, { success: true });

        case 'tools/list':
          return this.handleToolsList(request);

        case 'tools/call':
          return await this.handleToolCall(request);

        case 'resources/list':
          return this.handleResourcesList(request);

        case 'prompts/list':
          return this.handlePromptsList(request);

        case 'ping':
          return this.handlePing(request);

        default:
          return this.createError(
            request.id ?? null,
            -32601,
            `Method not found: ${request.method}`,
          );
      }
    } catch (error) {
      ztoolkit.log(
        `[StreamableMCP] Error processing ${request.method}: ${error}`,
      );
      return this.createError(request.id ?? null, -32603, 'Internal error');
    }
  }

  private handleInitialize(request: MCPRequest): MCPResponse {
    // 协议版本协商，遵循 MCP lifecycle：
    // - 请求的版本受支持 -> 回同一版本；
    // - 不受支持 -> 回服务器最新支持版本，由客户端决定继续还是断开。
    //   这是协商而非错误，所以 initialize 不会因版本不匹配而失败。
    // - 缺失 -> 按服务器最新支持版本处理。
    // 只有 protocolVersion 类型非法（不是字符串）才算 invalid params。
    const requestedVersion = request.params?.protocolVersion;
    if (
      requestedVersion !== undefined &&
      typeof requestedVersion !== 'string'
    ) {
      return this.createError(
        request.id ?? null,
        -32602,
        'Invalid params: protocolVersion must be a string',
        { supported: SUPPORTED_MCP_PROTOCOL_VERSIONS },
      );
    }

    const negotiatedVersion = negotiateProtocolVersion(requestedVersion);
    if (
      requestedVersion !== undefined &&
      negotiatedVersion !== requestedVersion
    ) {
      ztoolkit.log(
        `[StreamableMCP] Client requested unsupported protocol version ${requestedVersion}; offering ${negotiatedVersion} instead`,
        'warn',
      );
    }

    // This transport is deliberately stateless. Streamable HTTP permits a
    // server to omit Mcp-Session-Id; retaining an unreachable ID per reconnect
    // only leaks memory and gives clients no capability in return.
    const clientInfo = request.params?.clientInfo || {};

    ztoolkit.log(
      `[StreamableMCP] Stateless client initialized: ${clientInfo.name || 'unknown'}, protocol: ${negotiatedVersion}`,
    );

    // Create standard MCP initialize response (no custom fields)
    return this.createResponse(request.id ?? null, {
      protocolVersion: negotiatedVersion,
      capabilities: {
        tools: {
          // 本实现从不发送 notifications/tools/list_changed，
          // 声明 true 会让客户端一直等一个永远不会到来的通知。
          listChanged: false,
        },
        logging: {},
        prompts: {},
        resources: {},
      },
      serverInfo: this.serverInfo,
      instructions: `This server retrieves literature through a funnel and never calls an LLM of its own, so YOU are the query-understanding stage at EVERY step. Each stage looks at fewer documents in more depth: many candidates -> a few abstracts you chose to read -> passages from one paper.

如果说明要求使用的工具在当前 MCP 工具列表中不存在，请提示用户到 Zotero MCP 设置中启用对应功能，不要尝试调用不存在的工具。

STAGE 0 - decide where to look (get_collections, only when it helps):
0. When the question is plainly confined to part of the user's library, call get_collections first and read their real folder names, then pass the relevant ones to hybrid_search as collectionKeys. The scope is applied before scoring, so it removes work rather than filtering results. Decide per collection: include what the user named, include what obviously relates to the question, exclude only what obviously does not, and INCLUDE anything whose subject you cannot determine — "待读", "综述", "课题资料", "论文写作" and similar names say nothing about content and frequently hold the most relevant papers. If most names are opaque to you, or the question spans fields, skip this stage entirely and search the whole library. Scanning extra documents costs a little time; missing one costs the user the paper.

STAGE 1 - find candidates (hybrid_search):
1. Identify which discipline and sub-field the user's question belongs to, and adopt that field's expert role.
2. From that expert perspective, write ONE natural-language semantic query stating the real research intent, plus professional keywords: terms of art, synonyms, abbreviations and mechanism words, in BOTH Chinese and English regardless of the language the user asked in - the library is bilingual and this stage searches all of it. Declare the field in the domain argument and the perspective in the expertRole argument - without both, the call is reported as keywordSource "fallback" even if your keywords were good.
3. Call hybrid_search. It runs keyword retrieval and vector semantic retrieval over the whole library, filters EACH on its own scale against its own user threshold (normalised BM25F for keyword, cosine for semantic), and unions the survivors. The keyword branch covers the metadata of the whole library AND the body text of every document in the keyword index, so a paper whose title and abstract say nothing can still be retrieved on its body; body coverage is only what has been indexed, and metadata.bodyKeywords reports how much that is. Clearing either threshold is enough: one branch can admit a document but never veto it, so a paper the keywords miss still comes back when the embedding rates it.
4. The union is ranked by weighted Reciprocal Rank Fusion over each document's rank within each branch that admitted it. The score on each row IS that RRF value - a position, not a relevance, and not comparable to 0.6 or to another search's scores. For "how relevant is this", read normalizedKeywordScore and normalizedSemanticScore; a missing one means that branch did not admit the document, not that it scored zero. Never re-sort the rows. The response carries ONE PAGE of the ranking - topK is the page size, a CEILING and never a target. If nothing comes back, both thresholds rejected everything and the library has nothing relevant.
5. The pagination block tells you the whole picture: appliedKeywordMinScore and appliedSemanticMinScore (the two floors that were applied), totalRelevant (how many documents at least one branch admitted), returned, hasMore, nextCursor. Gating happens before paging, so no page can contain a document both branches rejected and a short final page is never padded. When hasMore is true and the bottom of the page still looks relevant - or the user asked for a comprehensive sweep or a literature review - call hybrid_search again with cursor set to nextCursor and every other argument unchanged; that windows the SAME ranking instead of searching again, so pages never duplicate, drop or reorder documents. Changing query, keywords, domain, expertRole, minKeywordScore or minSemanticScore alongside a cursor is rejected: that is a new search, so start one. Never lower either floor to fill a page, and do not page through everything by reflex - stop when the question is answered.
6. What comes back per document is a LIGHTWEIGHT candidate row: title, creators, year, venue, the language the document is written in, the RRF score plus each branch's own 0-1 relevance, which of your keywords and which fields matched, a short snippet from its best-matching passages, and — for a document matched in its body text — bodyEvidence naming the passages that carried your terms. When matchedFields is only ["body"], that evidence is the sole reason the row is there, so read it before judging. Abstracts are deliberately NOT included - they are still searched server-side, they are just not shipped back, because most candidates never need to be read.

STAGE 2 - triage, and read an abstract only where you need one (get_item_abstract):
7. Judge each candidate from its stage-1 row alone: title, rank, the two branch relevances, which keywords hit which fields, and the evidence snippet. When that is already enough to see a paper is off-topic, discard it and never fetch its abstract.
8. Only for a candidate you are seriously considering going deeper on, call get_item_abstract with that ONE itemKey. It is an on-demand tool, NOT a batch step that follows hybrid_search: if 3 of 20 candidates are worth pursuing, you fetch 3 abstracts, not 20.
9. If the user only asked which literature is relevant, answer from the stage-1 rows plus at most a few abstracts, and stop here.

STAGE 3 - dig into one paper (search_fulltext, one document per call):
10. Having read that paper's abstract, redo the expert judgement FOR THAT PAPER from "user question + this paper's title + its abstract + its stage-1 evidence": identify its study object, material system, experimental method, variables, mechanism, terminology and abbreviations.
11. Re-fit domain and expertRole to what THIS paper actually is. They may well differ from stage 1 and should: a library-level "materials science / solidification metallurgy" becomes "physical metallurgy / crystal plasticity and deformation mechanisms" once the abstract shows the paper is really about dislocations, stacking faults and micro-twinning. Decide that from the abstract you just read; never carry the stage-1 pair over out of inertia.
12. Write query and keywords SPECIFIC TO THAT PAPER, and write the keywords in the LANGUAGE THAT PAPER IS WRITTEN IN - one language, not both. This stage searches inside a single document, so probes in the other language match nothing and only dilute the ranking. The candidate row carries a language hint and the abstract confirms it; a Chinese paper takes Chinese terms of art, an English paper takes English ones. Keep the query itself bilingual only if the paper itself mixes languages.
13. Call search_fulltext with that one itemKey, plus the re-fitted domain and expertRole. It runs keyword matching and semantic retrieval across that paper's passages and applies EXACTLY the same rule one level down - the same two user thresholds, each on its own branch, union of the survivors, weighted RRF over within-branch ranks - and returns at most the user's configured number of passages.
14. Read those passages. If the evidence answers the question, STOP. Only if a passage is missing its cause, its consequence, its experimental conditions or its mechanism context, call search_fulltext again with chunkIds set to that passage's chunkId to pull in its immediate neighbours, within the user's radius limit. Never request neighbouring text by default.

STAGE 4 - keep what you just learned (wiki_update_reading_note, then wiki_prepare_update + wiki_commit):
15. Answer the user first. Then, for EACH paper whose passages you genuinely read and used, call wiki_update_reading_note with that paper's itemKey, readChunkIds listing the chunkId of every passage you actually used, the same domain and expertRole you searched it with, and the paper's WHOLE reading note rewritten to include what you have just understood. Three papers read means three calls. The note lives on the Zotero item and is that paper's long-term memory across every question ever asked of it - so extend and reorganise it, never replace it with a shorter summary, and cite the chunk number beside every fact in the prose so the trail back to the source survives.
16. List only what you READ. Retrieval returning a passage is not reading it: a chunk you skimmed past, or that turned out to be about something else, is not in readChunkIds. The server counts what you declare and will stand behind exactly that. Re-listing a chunk you had already read is free and never double-counted.
17. Then update the Wiki from those notes, in that order, every time reading actually added something: wiki_prepare_update, then wiki_commit. Extend the Page, Claim, Concept and relations that already exist rather than creating parallel ones beside them, and quote every Evidence excerpt from the paper's own chunks - never from the note, which is your memory of the paper rather than the paper. Evidence from this kind of reading is chunk_local or section_read; paper_reviewed belongs to a full-text read alone.
18. A turn that read nothing new - the answer came from what was already understood, or nothing retrieved was relevant - skips both calls. Say so and move on. What is NOT optional is the order: a paper whose last reading is still only in its note refuses to be read again until a commit cites it, because a conversation that improves ten notes and writes no Claims has left nothing behind.
19. Reading a paper END TO END is a different act and a different tool: wiki_build_from_paper, only on explicit user request. It continues this same note and this same chunk ledger, asks only for what questions never reached, and is the only path to the whole-paper synthesis that whole-paper depth requires. Its completion order is fixed: wiki_build_from_paper until coverage is complete -> wiki_update_reading_note with finalSynthesis true -> wiki_record_concepts with final true -> wiki_prepare_update with the five-axis Wiki Review covering pages, claims, evidence, concepts and relations -> wiki_commit. The finalSynthesis call is checked sentence by sentence against the chunks each sentence cites before the note is written: keep every sentence at the strength its source used, keep the paper's limits and difficulties in, and let a sentence cite only the chunks that carry it on their own. A sentence that reaches has to be answered with a verbatim quotation from each chunk it names, or rewritten.

Around 5-12 keywords is the recommendation, 1 to ${MAX_HYBRID_KEYWORDS} is accepted, at both stage 1 and stage 3. If you omit keywords the server falls back to mechanical tokenization, returns keywordSource "fallback" with degraded: true, and you should redo that call ONCE with proper terms. Never perform unscoped whole-library full-text search.
BEYOND THE FUNNEL - the other tools, and when each one is the right call:
- keyword_search: lexical-only retrieval, no embeddings. It covers the metadata of the whole library plus the body text of every document in the keyword index, and a body-only hit is returned with bodyEvidence explaining it. Use it for an exact term you must not miss, or as a COARSE FILTER whose itemKeys you then hand to semantic_search for a fine pass over just that shortlist. Its score is a real 0-1 relevance (one branch, nothing to fuse), unlike hybrid_search's rank-fusion score - never compare the two.
- semantic_search: embedding-only retrieval. Use it for a concept whose vocabulary you cannot pin down, or as the fine pass over a keyword_search shortlist. Both accept collectionKeys and itemKeys, both page with nextCursor, and both return the SAME row shape as hybrid_search - including fullText, which you must read before you read any snippet.
- get_item_details: bibliographic metadata for citing a paper. It never returns abstract text, note bodies, annotation text or full text.
- get_annotations / search_annotations: YOUR OWN marks - PDF highlights, comments, and notes you typed in Zotero. get_annotations reads documents you name (itemKeys takes several); search_annotations finds marks when you do not know which document holds them. Everything they return is the user's own reading, never the paper's words: quote it verbatim and attribute it to the user.
- get_attachment_text: the text of ONE attachment, in character windows, with textSource.method naming where it came from (doc2x, mineru, zotero_fulltext_cache, ...). Text from Zotero's flat cache has no layout - never rebuild a table from it.
- get_document_chunks: read one paper's indexed body straight through, in order, a few chunks per page. Use it when the question is about the whole argument; use search_fulltext when it is about one fact. What you read here counts as reading too - pass those chunkIds to wiki_update_reading_note like any others.
- wiki_get_reading_note: what is already understood about one paper, before you read any more of it. Call it when a question lands on a paper the library has read before - the answer may already be in the note, and if it is not, the note is what you are about to extend rather than rewrite.
- get_collection_items: browse the library one level at a time, like a file manager - the subfolders here and the documents filed here, with counts on each subfolder so you can choose where to descend. This is navigation. If the user is asking about a TOPIC, stop browsing and search.
Nothing in this server returns a whole document in one response. Every reading tool pages, and continuing to page is a decision you make each time, not a default.`,
    });
  }

  private handleResourcesList(request: MCPRequest): MCPResponse {
    // Return empty resources list - we don't currently support resources
    return this.createResponse(request.id ?? null, { resources: [] });
  }

  private handlePromptsList(request: MCPRequest): MCPResponse {
    // Return empty prompts list - we don't currently support prompts
    return this.createResponse(request.id ?? null, { prompts: [] });
  }

  private handlePing(request: MCPRequest): MCPResponse {
    // Standard MCP ping response - just return empty result
    return this.createResponse(request.id ?? null, {});
  }

  private getHttpStatusForResponse(response: MCPResponse): number {
    if (!response.error) {
      return 200;
    }

    // Align transport status for structural request errors.
    if (response.error.code === -32600 || response.error.code === -32700) {
      return 400;
    }

    return 200;
  }

  private handleToolsList(request: MCPRequest): MCPResponse {
    return this.createResponse(request.id ?? null, {
      tools: this.getAvailableTools(),
    });
  }

  /**
   * The tools this server actually serves right now, after the same pref
   * filtering tools/list applies.
   *
   * The definitions themselves live in `toolCatalog.ts` and are shared with
   * the HTTP `/capabilities` endpoint. They used to be written out three
   * times — here, in `getStatus()`, and in `httpServer.getCapabilities()` —
   * and every copy drifted from the others in its own direction: getStatus()
   * under-reported by six and was blind to both prefs below (so with write
   * disabled it still advertised the write_* tools that tools/list was
   * hiding), and /capabilities was still advertising five tools that had
   * ceased to exist while missing eleven that had not. One source, all three
   * callers, and `scripts/test-tool-catalog.js` fails if they diverge again.
   */
  private getAvailableTools(): ToolDefinition[] {
    return filterToolCatalog({
      wikiEnabled: getWikiSettings().enabled,
      writeEnabled: isWriteEnabled(),
      mutatingToolNames: MUTATING_TOOL_NAMES,
    });
  }

  private async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const { name, arguments: args } = request.params;

    try {
      // 统一的 Wiki 开关闸门。
      //
      // `wiki.enabled=false` 过去只从 tools/list 里把 Wiki 工具隐藏掉，调用
      // 分派层没有再检查一次；只有 wiki_record_concepts 和 wiki_commit 自己
      // 显式检查。一个缓存了旧工具清单的客户端因此仍能直接调用
      // wiki_build_from_paper / wiki_set_reading_expert /
      // wiki_update_reading_note，而后两个会真的在 Zotero 条目下创建或改写
      // Markdown 阅读笔记附件。隐藏名字不是权限。
      if (WIKI_TOOL_NAMES.has(name)) {
        assertWikiEnabled();
      }

      // Reject malformed metadata before asking the user to approve a write.
      // The schema guides clients but is not a security boundary: callers can
      // still send arbitrary JSON to tools/call.
      if (name === 'write_metadata') {
        assertWriteMetadataArgs(args);
      }

      // 统一的写入闸门：任何会改动 Zotero 数据的工具都先过这里。
      // 每个 case 内原有的 write.enabled 检查保留，作为二次校验。
      if (MUTATING_TOOL_NAMES.has(name)) {
        assertWriteEnabled(name);
        if (!isMutationPreview(name, args)) {
          await assertMutationConfirmed(name, args);
        }
      }

      let result;

      switch (name) {
        case 'get_libraries':
          result = await this.callGetLibraries(args);
          break;

        case 'search_libraries':
          if (!args?.q) {
            throw new Error('q is required');
          }
          result = await this.callSearchLibraries(args);
          break;

        case 'search_library':
          if (args?.fulltext) {
            throw new Error(
              'search_library.fulltext is disabled. Use hybrid_search first, then search_fulltext with one matched itemKey at a time',
            );
          }
          result = await this.callSearchLibrary(args);
          break;

        case 'hybrid_search':
          // A cursor already names the search it continues, so the query is
          // required only when starting a new one.
          if (
            (typeof args?.cursor !== 'string' || !args.cursor.trim()) &&
            (typeof args?.query !== 'string' || !args.query.trim())
          ) {
            throw new Error(
              'query is required (or pass cursor to continue a previous hybrid_search)',
            );
          }
          result = await this.callHybridSearch(args);
          break;

        case 'search_annotations':
          // q is optional when colors or tags filters are provided
          if (!args?.q && !args?.colors && !args?.tags) {
            throw new Error(
              'Either q (query), colors, or tags filter is required',
            );
          }
          result = await this.callSearchAnnotations(args);
          break;

        case 'get_item_details':
          if (!args?.itemKey) {
            throw new Error('itemKey is required');
          }
          result = await this.callGetItemDetails(args);
          break;

        case 'get_annotations':
          if (
            !args?.itemKey &&
            !(Array.isArray(args?.itemKeys) && args.itemKeys.length > 0) &&
            !args?.annotationId &&
            !args?.annotationIds
          ) {
            throw new Error(
              'One of itemKeys, itemKey, annotationId or annotationIds is required',
            );
          }
          result = await this.callGetAnnotations(args);
          break;

        case 'get_attachment_text':
          if (!args?.itemKey) {
            throw new Error(
              "itemKey is required. Call with itemKey alone to see the item's attachments, then again with the attachmentKey you want to read.",
            );
          }
          result = await this.callGetAttachmentText(args);
          break;

        case 'get_collections':
          result = await this.callGetCollections(args);
          break;

        case 'search_collections':
          result = await this.callSearchCollections(args);
          break;

        case 'get_collection_details':
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          result = await this.callGetCollectionDetails(args);
          break;

        // Browsing: no collectionKey means "the top level of the library",
        // which is where a caller with no keys in hand has to start.
        case 'get_collection_items':
          result = await this.callGetCollectionItems(args);
          break;

        case 'create_collection': {
          const writeEnabledCC = Zotero.Prefs.get(
            'extensions.zotero.zotero-mcp-plugin.write.enabled',
            true,
          );
          if (writeEnabledCC !== true) {
            throw new Error(
              'Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.',
            );
          }
          if (!args?.name) {
            throw new Error('name is required');
          }
          result = await this.callCreateCollection(args);
          break;
        }

        case 'update_collection': {
          const writeEnabledUC = Zotero.Prefs.get(
            'extensions.zotero.zotero-mcp-plugin.write.enabled',
            true,
          );
          if (writeEnabledUC !== true) {
            throw new Error(
              'Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.',
            );
          }
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          result = await this.callUpdateCollection(args);
          break;
        }

        case 'delete_collection': {
          const writeEnabledDC = Zotero.Prefs.get(
            'extensions.zotero.zotero-mcp-plugin.write.enabled',
            true,
          );
          if (writeEnabledDC !== true) {
            throw new Error(
              'Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.',
            );
          }
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          result = await this.callDeleteCollection(args);
          break;
        }

        case 'add_items_to_collection': {
          const writeEnabledAI = Zotero.Prefs.get(
            'extensions.zotero.zotero-mcp-plugin.write.enabled',
            true,
          );
          if (writeEnabledAI !== true) {
            throw new Error(
              'Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.',
            );
          }
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          const addKeys = this.coerceStringArray(args?.itemKeys);
          if (!addKeys || addKeys.length === 0) {
            throw new Error(
              `itemKeys array is required, e.g. ["ABCD1234"]. Received: ${JSON.stringify(args?.itemKeys)}`,
            );
          }
          result = await this.callAddItemsToCollection({
            ...args,
            itemKeys: addKeys,
          });
          break;
        }

        case 'remove_items_from_collection': {
          const writeEnabledRI = Zotero.Prefs.get(
            'extensions.zotero.zotero-mcp-plugin.write.enabled',
            true,
          );
          if (writeEnabledRI !== true) {
            throw new Error(
              'Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.',
            );
          }
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          const removeKeys = this.coerceStringArray(args?.itemKeys);
          if (!removeKeys || removeKeys.length === 0) {
            throw new Error(
              `itemKeys array is required, e.g. ["ABCD1234"]. Received: ${JSON.stringify(args?.itemKeys)}`,
            );
          }
          result = await this.callRemoveItemsFromCollection({
            ...args,
            itemKeys: removeKeys,
          });
          break;
        }

        case 'move_items_to_collection': {
          if (!args?.toCollectionKey) {
            throw new Error(
              'toCollectionKey is required: the collection these items should end up in.',
            );
          }
          const moveKeys = this.coerceStringArray(args?.itemKeys);
          if (!moveKeys || moveKeys.length === 0) {
            throw new Error(
              `itemKeys array is required, e.g. ["ABCD1234"]. Received: ${JSON.stringify(args?.itemKeys)}`,
            );
          }
          result = await this.callMoveItemsToCollection({
            ...args,
            itemKeys: moveKeys,
          });
          break;
        }

        case 'merge_items': {
          if (!Array.isArray(args?.groups) || args.groups.length === 0) {
            throw new Error(
              'groups is required: an array of { itemKeys, masterItemKey? }, one entry per set of duplicates.',
            );
          }
          result = await this.callMergeItems(args);
          break;
        }

        case 'search_fulltext': {
          // One document per call: the deep dive has to be re-thought for each
          // paper, and a list of keys is exactly how a caller ends up sending
          // one generic query to all of them.
          const deepDiveKey =
            typeof args?.itemKey === 'string' && args.itemKey.trim()
              ? args.itemKey.trim()
              : null;
          const legacyKeys = this.coerceStringArray(args?.itemKeys);
          let fulltextArgs = args;
          if (!deepDiveKey) {
            if (legacyKeys && legacyKeys.length === 1) {
              fulltextArgs = { ...args, itemKey: legacyKeys[0] };
            } else if (legacyKeys && legacyKeys.length > 1) {
              throw new Error(
                'search_fulltext digs into ONE document per call. Pass a single itemKey, re-derive query and keywords for that specific paper, then call again for the next one.',
              );
            } else {
              throw new Error(
                'itemKey from hybrid_search is required; whole-library full-text scanning is disabled',
              );
            }
          }
          // Same guard as get_document_chunks: a note key here produced
          // "has no indexed full text", which invites the caller to build an
          // index that can never make a note searchable as a document.
          await this.assertDocumentKey(
            fulltextArgs.itemKey,
            fulltextArgs.libraryID,
            'search_fulltext',
          );
          result = await this.callSearchFulltext(fulltextArgs);
          break;
        }

        case 'get_item_abstract':
          if (!args?.itemKey) {
            throw new Error('itemKey is required');
          }
          result = await this.callGetItemAbstract(args);
          break;

        case 'wiki_prepare_update': {
          if (!args?.query?.trim()) throw new Error('query is required');
          const libraryID = args.libraryID ?? Zotero.Libraries.userLibraryID;
          result = await getWikiService().prepareUpdate({
            libraryID,
            query: args.query,
            limit: args.limit,
            proposedPageTitles: this.coerceStringArray(args.proposedPageTitles),
            wikiReview:
              args.wikiReview && typeof args.wikiReview === 'object'
                ? args.wikiReview
                : undefined,
          });
          break;
        }
        case 'wiki_commit': {
          await assertWikiCommitConfirmed(args);
          const libraryID = args.libraryID ?? Zotero.Libraries.userLibraryID;
          result = await getWikiService().commit(
            {
              libraryID,
              userInitiated: true,
              prepareToken: args.prepareToken,
              readingSessionId: Number.isInteger(args.readingSessionId)
                ? args.readingSessionId
                : undefined,
              actions: args.actions,
            },
            {
              authorizeNoteStatusWrite: () =>
                authorizeZoteroWrite('wiki_commit', args),
            },
          );
          break;
        }
        case 'wiki_search': {
          if (!args?.query?.trim()) throw new Error('query is required');
          const libraryID = args.libraryID ?? Zotero.Libraries.userLibraryID;
          result = await getWikiService().search({
            libraryID,
            query: args.query,
            keywords: this.coerceStringArray(args.keywords),
            itemKeys:
              args.itemKeys === undefined
                ? undefined
                : this.coerceStringArray(args.itemKeys),
            minScore: args.minScore,
            limit: args.limit,
          });
          break;
        }
        case 'wiki_get_page':
          if (!Number.isInteger(args?.pageId))
            throw new Error('pageId is required');
          result = await getWikiService().getPage(args.pageId);
          break;
        case 'wiki_get_claim':
          if (!Number.isInteger(args?.claimId))
            throw new Error('claimId is required');
          result = await getWikiService().getStore().getClaim(args.claimId);
          break;
        case 'wiki_status':
          result = await getWikiService().getStore().getStatus(args?.libraryID);
          break;
        case 'wiki_export':
          result = await getWikiService().exportMarkdown(
            args?.libraryID ?? Zotero.Libraries.userLibraryID,
          );
          break;
        case 'wiki_record_concepts': {
          assertWikiEnabled();
          const libraryID = args?.libraryID ?? Zotero.Libraries.userLibraryID;
          result = await getWikiService().recordConcepts({
            libraryID,
            itemKey: args?.itemKey,
            final: args?.final === true,
            noConceptsReason: args?.noConceptsReason,
            concepts: Array.isArray(args?.concepts) ? args.concepts : [],
            confirmWrite: (count: number) =>
              assertWikiConceptWriteConfirmed(count),
          });
          break;
        }
        case 'wiki_list_concepts': {
          const libraryID = args?.libraryID ?? Zotero.Libraries.userLibraryID;
          result = await getWikiService().searchConcepts({
            libraryID,
            query: args?.query,
            limit: args?.limit,
          });
          break;
        }
        case 'wiki_export_concepts':
          result = await getWikiService().exportConceptsMarkdown(
            args?.libraryID ?? Zotero.Libraries.userLibraryID,
          );
          break;
        case 'wiki_reverify':
          result = await getWikiService().reverify(args?.libraryID);
          break;
        case 'wiki_build_from_paper':
          result = await getWikiService().buildFromPaper({
            libraryID: args?.libraryID ?? Zotero.Libraries.userLibraryID,
            userRequested: args?.userRequested === true,
            itemKey: args?.itemKey,
            doi: args?.doi,
            url: args?.url,
            title: args?.title,
            cursor: args?.cursor,
            offset: args?.offset,
            limit: args?.limit,
            includeAllChunks: args?.includeAllChunks === true,
            includeReadingNote:
              typeof args?.includeReadingNote === 'boolean'
                ? args.includeReadingNote
                : undefined,
          });
          break;
        case 'wiki_set_reading_expert':
          result = await getWikiService().setReadingExpert({
            libraryID: args?.libraryID ?? Zotero.Libraries.userLibraryID,
            itemKey: args?.itemKey,
            persona: args?.persona,
            focus: this.coerceStringArray(args?.focus) ?? [],
          });
          break;
        case 'wiki_update_reading_note':
          result = await getWikiService().updateReadingNote({
            libraryID: args?.libraryID ?? Zotero.Libraries.userLibraryID,
            itemKey: args?.itemKey,
            markdown: args?.markdown,
            unchanged: args?.unchanged === true,
            unchangedReason: args?.unchangedReason,
            finalSynthesis: args?.finalSynthesis === true,
            // Proof for the sentences the synthesis gate flagged. Coerced
            // rather than passed through: it arrives as free-form JSON from a
            // model, and a malformed entry should be reported as an audit
            // problem naming the sentence, not as a TypeError.
            synthesisAudit: this.coerceSynthesisAudit(args?.synthesisAudit),
            // The presence of readChunkIds is what selects the question-driven
            // path, so an empty array must not be mistaken for one: a caller
            // that read nothing new is on the full-text path, where a batch was
            // already booked when it was handed over.
            readChunkIds: this.coerceChunkIds(args?.readChunkIds),
            domain: args?.domain,
            expertRole: args?.expertRole,
          });
          break;
        case 'wiki_get_reading_note':
          result = await getWikiService().getReadingNote({
            libraryID: args?.libraryID ?? Zotero.Libraries.userLibraryID,
            itemKey: args?.itemKey,
            includeMarkdown: args?.includeMarkdown !== false,
          });
          break;
        case 'wiki_finish_reading': {
          const outcome = args?.outcome;
          if (outcome !== 'skipped' && outcome !== 'failed') {
            throw new Error(
              'outcome must be "skipped" (read but not written up) or "failed" (reading could not be completed). A paper written up with wiki_commit closes itself.',
            );
          }
          result = await getWikiService().finishReading(
            {
              libraryID: args?.libraryID ?? Zotero.Libraries.userLibraryID,
              itemKey: args?.itemKey,
              outcome,
              note: args?.note,
            },
            {
              authorizeNoteStatusWrite: () =>
                authorizeZoteroWrite('wiki_finish_reading', args),
            },
          );
          break;
        }

        // Semantic Search Tools
        case 'semantic_search':
        case 'keyword_search':
        case 'get_document_chunks':
        case 'find_similar':
        case 'semantic_status':
        case 'build_search_index': {
          if (name === 'build_search_index') {
            const libraryID =
              args?.libraryID ?? Zotero.Libraries.userLibraryID;
            const itemKeys = this.coerceStringArray(args?.itemKeys) ?? [];
            const semanticService = getSemanticSearchService();
            const vectorStore = getVectorStore();
            result = await buildSearchIndex(
              { libraryID, itemKeys },
              {
                buildIndex: (options) =>
                  semanticService.buildIndex(options),
                getIndexStatus: (itemKey, sourceLibraryID) =>
                  vectorStore.getIndexStatus(itemKey, sourceLibraryID),
                getKeywordItemKeys: async (sourceLibraryID) => {
                  await vectorStore.initialize();
                  return vectorStore
                    .getKeywordIndexStore()
                    .indexedItemKeys(sourceLibraryID);
                },
                getFailedItems: () => vectorStore.getFailedItems(),
              },
            );
          } else if (name === 'semantic_search') {
            // A cursor names the search it continues, so the query is required
            // only when starting a new one.
            if (
              (typeof args?.cursor !== 'string' || !args.cursor.trim()) &&
              (typeof args?.query !== 'string' || !args.query.trim())
            ) {
              throw new Error(
                'query is required (or pass cursor to continue a previous semantic_search)',
              );
            }
            result = await this.callSemanticSearch(args);
          } else if (name === 'keyword_search') {
            const continuingKeyword =
              typeof args?.cursor === 'string' && args.cursor.trim().length > 0;
            if (
              !continuingKeyword &&
              !(Array.isArray(args?.keywords) && args.keywords.length > 0) &&
              (typeof args?.query !== 'string' || !args.query.trim())
            ) {
              throw new Error(
                'keywords is required: pass the bilingual domain terms to match (or pass cursor to continue a previous keyword_search). A query alone is only used to derive mechanical fallback probes.',
              );
            }
            result = await this.callKeywordSearch(args);
          } else if (name === 'get_document_chunks') {
            result = await this.callGetDocumentChunks(args);
          } else if (name === 'find_similar') {
            // A cursor names the search it continues, so the query chunks are
            // required only when starting a new one.
            const continuing =
              typeof args?.cursor === 'string' && args.cursor.trim().length > 0;
            if (!continuing) {
              if (!args?.itemKey) {
                throw new Error(
                  'itemKey is required (or pass cursor to continue a previous find_similar)',
                );
              }
              if (
                !Array.isArray(args?.chunkIds) ||
                args.chunkIds.length === 0
              ) {
                throw new Error(
                  'chunkIds is required: pick the representative passages of this paper with search_fulltext first, then pass their chunkIds here. find_similar does not choose them for you.',
                );
              }
            }
            result = await this.callFindSimilar(args);
          } else {
            result = await this.callSemanticStatus();
          }
          break;
        }

        // Write Tools
        case 'write_note': {
          const writeEnabled = Zotero.Prefs.get(
            'extensions.zotero.zotero-mcp-plugin.write.enabled',
            true,
          );
          if (writeEnabled !== true) {
            throw new Error(
              'Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.',
            );
          }
          if (!args?.action) {
            throw new Error('action is required');
          }
          // `!args.content` conflated "you did not pass content" with "you
          // passed an empty note", and the second one is a real request: it is
          // the only way to say "empty this note". Missing is missing; empty
          // is a value, and which actions accept it is callWriteNote's rule.
          if (typeof args.content !== 'string') {
            throw new Error(
              `content is required and must be a string. Received ${args.content === undefined ? 'nothing' : typeof args.content}. To ERASE a note's content, pass an empty string with action "update" — that is a deliberate clear, and it is not the same as leaving the parameter out.`,
            );
          }
          result = await this.callWriteNote(args);
          break;
        }

        case 'write_tag': {
          const writeEnabled2 = Zotero.Prefs.get(
            'extensions.zotero.zotero-mcp-plugin.write.enabled',
            true,
          );
          if (writeEnabled2 !== true) {
            throw new Error(
              'Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.',
            );
          }
          if (!args?.action || !args?.itemKey || !args?.tags) {
            throw new Error('action, itemKey, and tags are required');
          }
          // `tags` 必须真的是字符串数组。JavaScript 会把字符串当成可迭代的
          // 字符序列，所以 tags: "AI" 配上 action "set" 的实际效果是：先删掉
          // 条目上全部旧标签，再加上 "A" 和 "I" 两个单字符标签，最后照样返回
          // success:true。一次格式不对的调用就能清空一个条目的标签。
          assertTagArray(args.tags);
          result = await this.callWriteTag(args);
          break;
        }

        case 'write_metadata': {
          const writeEnabled3 = Zotero.Prefs.get(
            'extensions.zotero.zotero-mcp-plugin.write.enabled',
            true,
          );
          if (writeEnabled3 !== true) {
            throw new Error(
              'Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.',
            );
          }
          result = await this.callWriteMetadata(args);
          break;
        }

        case 'write_item': {
          const writeEnabled4 = Zotero.Prefs.get(
            'extensions.zotero.zotero-mcp-plugin.write.enabled',
            true,
          );
          if (writeEnabled4 !== true) {
            throw new Error(
              'Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.',
            );
          }
          if (!args?.action) {
            throw new Error('action is required');
          }
          result = await this.callWriteItem(args);
          break;
        }

        default: {
          // A stale client still holding a removed tool name gets the
          // replacement, not a shrug. "Unknown tool" would make a capable
          // model retry variations of a name that will never work again;
          // naming the successor gets it back on the funnel in one turn.
          const replacement = REMOVED_TOOL_REPLACEMENTS[name];
          if (replacement) throw new Error(replacement);
          throw new Error(`Unknown tool: ${name}`);
        }
      }

      // 结构化路径字段必须在序列化成 content[0].text 之前清掉——
      // 一旦变成字符串，按字段名清空就无从下手。字符串里的绝对路径
      // 由 handleMCPRequest 的出口统一脱敏，不在这里重复扫描大文本。
      result = scrubPathFields(result);

      // Wrap result in MCP content format with proper text type.
      // Keep large results compact: the HTTP layer writes the body in a
      // single synchronous call, so avoid inflating multi-MB payloads.
      const compactJson = JSON.stringify(result);
      return this.createResponse(request.id ?? null, {
        content: [
          {
            type: 'text',
            text:
              compactJson.length > 100000
                ? compactJson
                : JSON.stringify(result, null, 2),
          },
        ],
        ...(isFailedStructuredWrite(name, result) ? { isError: true } : {}),
      });
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Tool call error for ${name}: ${error}`);
      return this.createError(
        request.id ?? null,
        -32603,
        `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async callGetLibraries(args: any): Promise<any> {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(args || {})) {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    }

    const response = await handleGetLibraries(queryParams);
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  private async callSearchLibraries(args: any): Promise<any> {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(args || {})) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    const response = await handleSearchLibraries(searchParams);
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  private async callSearchLibrary(args: any): Promise<any> {
    const processedArgs = prepareFixedContentToolArgs(
      args,
      SEARCH_LIBRARY_DEFAULT_LIMIT,
    );

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(processedArgs)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }

    const SEARCH_TIMEOUT_MS = 25000; // 25 秒超时，低于 keepAlive 的 30 秒
    const searchPromise = handleSearch(searchParams);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              'Search timed out after 25 seconds. Try narrowing your query or reducing the limit.',
            ),
          ),
        SEARCH_TIMEOUT_MS,
      );
    });
    const response = await Promise.race([searchPromise, timeoutPromise]);
    const result = response.body ? JSON.parse(response.body) : response;
    if (response.status < 200 || response.status >= 300 || result?.error) {
      throw new Error(
        result?.error ||
          `Keyword metadata search failed with HTTP ${response.status}`,
      );
    }

    if (result && typeof result === 'object') {
      // Remove any unwanted content array if it's empty
      if (Array.isArray(result.content) && result.content.length === 0) {
        delete result.content;
      }
    }

    return result;
  }

  private async callHybridSearch(args: any): Promise<any> {
    // The user's preferences are ceilings, not defaults: the caller may ask for
    // fewer documents or a stricter threshold, never for more or looser.
    const settings = getHybridSearchSettings();
    const wikiSettings = getWikiSettings();
    const documentCap = resolveResultCap(args.topK, settings.maxDocuments);
    // Two independent floors, each on its own branch's scale. resolveScoreFloor
    // enforces the same "the caller may only be stricter" rule on both, so an
    // AI can tighten one branch for one search but can never loosen either.
    const keywordFloor = resolveScoreFloor(
      args.minKeywordScore,
      settings.keywordMinScore,
    );
    const semanticFloor = resolveScoreFloor(
      args.minSemanticScore,
      settings.semanticMinScore,
    );
    const wikiFloor = resolveScoreFloor(
      args.wikiMinScore,
      wikiSettings.minScore,
    );
    // topK is only the page size; retrieval enumerates every available match.
    const topK = documentCap.value;
    const language = args.language ?? 'all';
    const libraryID = args.libraryID ?? Zotero.Libraries.userLibraryID;

    // CONTINUATION: a cursor names one already-ranked, already-thresholded
    // result set. Serve the next window of it and return; running the search
    // again here is exactly what would make page 2 disagree with page 1.
    const cursor =
      typeof args.cursor === 'string' && args.cursor.trim()
        ? args.cursor.trim()
        : null;
    if (cursor) {
      return await this.continueHybridSearch(args, cursor, {
        // Only an explicit topK re-sizes a page. Omitting it must inherit the
        // size page 1 used, not silently fall back to the user's maximum: a
        // caller that asked for 5 and then just followed the cursor was being
        // handed 20.
        requestedPageSize: args.topK === undefined ? undefined : topK,
        keywordFloor: keywordFloor.value,
        semanticFloor: semanticFloor.value,
        wikiFloor: wikiFloor.value,
        language,
        libraryID,
      });
    }

    this.validateSearchParameters({
      query: args.query,
      topK,
      minScore: Math.min(keywordFloor.value, semanticFloor.value),
      language,
      libraryID,
    });

    // Collection scope is resolved to item keys BEFORE either branch runs, so
    // both of them narrow their candidates instead of scoring the library and
    // discarding afterwards.
    const uncertainCollections = Array.isArray(args.uncertainCollectionKeys)
      ? args.uncertainCollectionKeys
          .map((key: unknown) => String(key))
          .filter(Boolean)
      : [];
    const scope = this.resolveHybridScope(args.collectionKeys, libraryID);
    const scopeItemKeys =
      scope.searchScope === 'collections'
        ? new Set<string>(scope.itemKeys)
        : undefined;
    // The caller supplies bilingual keywords; when it does not we derive probes
    // from the query, which can only cover the language the user typed in.
    const {
      keywords: lexicalKeywords,
      entries: lexicalKeywordEntries,
      source: probeSource,
    } = resolveHybridKeywords(args.query, args.keywords);
    // 'ai' is only claimed when the caller both supplied its own probes AND
    // named the field and expert role it reasoned from; everything else is
    // mechanical fallback and is reported as such.
    const provenance = resolveKeywordProvenance({
      probeSource,
      keywordsArgumentPresent:
        args.keywords !== undefined && args.keywords !== null,
      domain: args.domain,
      expertRole: args.expertRole,
    });
    const options: HybridSearchOptions = {
      keywords: lexicalKeywords,
      topK,
      rrfK: args.rrfK ?? 60,
      // The RRF weights default to the user's setting rather than to a
      // hard-coded 1: the pane calls them "关键词/语义 RRF 权重" and a preference
      // an argument default silently overrides is not a preference.
      keywordWeight: args.keywordWeight ?? settings.keywordRrfWeight,
      semanticWeight: args.semanticWeight ?? settings.semanticRrfWeight,
      wikiWeight: wikiSettings.enabled ? wikiSettings.rrfWeight : 0,
      wikiMinScore: wikiFloor.value,
      wikiShadowMode: wikiSettings.enabled && wikiSettings.shadowMode,
      wikiSearchTimeoutMs: wikiSettings.searchTimeoutMs,
      keywordMinScore: keywordFloor.value,
      semanticMinScore: semanticFloor.value,
      keywordSearchTimeoutMs: settings.keywordSearchTimeoutMs,
      // Backstop for the fusion layer. The semantic branch's real budget is the
      // embedding timeout plus the vector-scan timeout, enforced inside the
      // service; this only catches a dependency that never settles at all.
      semanticBranchTimeoutMs:
        settings.vectorScanTimeoutMs + DEFAULT_EMBEDDING_TIMEOUT_MS,
    };
    // The lexical scan degrades to partial results slightly before the branch's
    // hard deadline, so an overrun returns the candidates it managed to rank
    // instead of nothing. The hard deadline still fires when the candidate-ID
    // query itself never comes back, which is the case no soft check can reach.
    const lexicalStartedAt = Date.now();
    const lexicalDeadlineAt =
      lexicalStartedAt +
      Math.max(1, Math.floor(settings.keywordSearchTimeoutMs * 0.9));
    // Both branches must be able to stop, not just be stopped waiting for:
    // an abandoned embedding request or library scan would otherwise keep
    // burning time (and API quota) after the hybrid deadline has passed.
    const semanticAbort =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    // Filled in by the vector scan so the response can report how much work
    // the collection scope actually saved.
    const semanticScanStats: {
      chunksScanned?: number;
      chunksMatched?: number;
    } = {};
    let lexicalCancelled = false;
    let lexicalDiagnostics:
      | Awaited<ReturnType<typeof runLexicalSearch>>['diagnostics']
      | null = null;

    const searchResult = await runHybridSearch(
      { ...options, query: args.query },
      {
        keywordSearch: async (): Promise<KeywordSearchItem[]> => {
          // One pass: candidates are selected once and every keyword is
          // matched during that same traversal, instead of running K separate
          // Zotero searches that used to overrun the hybrid deadline.
          const outcome = await runLexicalSearch({
            keywords: lexicalKeywordEntries,
            libraryID,
            scopeItemKeys,
            deadlineAt: lexicalDeadlineAt,
            isCancelled: () => lexicalCancelled,
          });
          lexicalDiagnostics = outcome.diagnostics;
          ztoolkit.log(
            `[StreamableMCP][Lexical] strategy=${outcome.diagnostics.strategy} candidates=${outcome.diagnostics.candidateIDs} scanned=${outcome.diagnostics.scannedItems} truncated=${outcome.diagnostics.truncated} search=${outcome.diagnostics.searchMs}ms scan=${outcome.diagnostics.scanMs}ms rank=${outcome.diagnostics.rankMs}ms total=${outcome.diagnostics.totalMs}ms keywords=${lexicalKeywordEntries.length}`,
          );
          return outcome.items;
        },
        cancelKeywordSearch: () => {
          lexicalCancelled = true;
        },
        semanticSearch: async (): Promise<SemanticSearchItem[]> => {
          const semanticService = getSemanticSearchService();
          return semanticService.search(args.query, {
            exhaustive: true,
            includeChunkText: false,
            // The branch thresholds in the fusion layer are the only relevance
            // filter. Scoring everything here and gating there is what lets a
            // document the keyword branch rejected still be admitted on its
            // semantic score alone.
            minScore: -1,
            language,
            libraryID,
            // Restricting the vector scan itself: the SQL only reads chunks
            // belonging to these items, so out-of-scope chunks are never
            // dequantised and never have a similarity computed for them.
            itemKeys:
              scope.searchScope === 'collections' ? scope.itemKeys : undefined,
            vectorScanTimeoutMs: settings.vectorScanTimeoutMs,
            signal: semanticAbort?.signal,
            stats: semanticScanStats,
          });
        },
        cancelSemanticSearch: () => {
          semanticAbort?.abort();
        },
        ...(wikiSettings.enabled
          ? {
              wikiSearch: async () => {
                const wiki = await getWikiService().search({
                  libraryID,
                  query: args.query,
                  keywords: lexicalKeywords,
                  itemKeys:
                    scope.searchScope === 'collections'
                      ? scope.itemKeys
                      : undefined,
                  minScore: 0,
                  limit: null,
                });
                return wiki.documents;
              },
            }
          : {}),
      },
    );
    // Nothing else is waiting on these branches once fusion is done.
    lexicalCancelled = true;
    semanticAbort?.abort();

    const diagnostics = lexicalDiagnostics as
      | Awaited<ReturnType<typeof runLexicalSearch>>['diagnostics']
      | null;
    ztoolkit.log(
      `[StreamableMCP][HybridTiming] lexical=${searchResult.timings.keywordMs}ms semantic=${searchResult.timings.semanticMs}ms rrf=${searchResult.timings.rrfMs}ms total=${searchResult.timings.totalMs}ms keywords=${lexicalKeywords.length}(probe=${probeSource},source=${provenance.keywordSource}) lexicalCandidates=${diagnostics?.candidateIDs ?? 0} lexicalScanned=${diagnostics?.scannedItems ?? 0} libraryID=${libraryID}`,
    );

    // `ai` is claimed only when the caller both supplied its own probes and
    // declared the field and expert role it reasoned from — the two things the
    // server can actually observe. Everything else is `fallback`, including a
    // keyword list that arrived with no declaration behind it.
    const keywordOrigin = provenance.keywordSource;
    const fallbackReason = provenance.reason;
    // One retry is enough to fix this: the caller either produces domain
    // keywords on the second attempt or it never will. Cap it explicitly so
    // the instruction cannot be read as "keep retrying until it is clean".
    const retryBudgetNote =
      'Retry at most once: if you have already retried this search, use these results as they are rather than calling hybrid_search again.';
    const fallbackWarning =
      keywordOrigin === 'fallback'
        ? provenance.probeOrigin === 'derived'
          ? `warning: Keywords were generated by mechanical fallback tokenization, not by AI/domain-expert analysis; retrieval quality may be lower. ${fallbackReason} The lexical branch only covers the language the query was written in. Redo this search once with a domain-expert keyword set: identify the sub-field, adopt its expert perspective, and pass bilingual Chinese and English terms of art, translations, synonyms and abbreviations as a non-empty array of trimmed strings, together with domain and expertRole. Around 5-12 keywords is the recommended amount, and any number from 1 to ${MAX_HYBRID_KEYWORDS} is accepted. ${retryBudgetNote} These results are usable in the meantime: the ranking below is real, only the lexical probes were mechanical.`
          : `warning: ${fallbackReason} The ranking below is real and your keywords were used, but the call cannot be recorded as domain-expert retrieval. Redo it once with domain and expertRole naming the discipline and the specialist perspective you adopted. ${retryBudgetNote}`
        : null;

    const hybridWarnings = [...searchResult.warnings];
    if (fallbackWarning) {
      // Front of the list: it describes the input, so it outranks branch-level
      // notes about what happened during retrieval.
      hybridWarnings.unshift(fallbackWarning);
    }
    if (diagnostics?.failedKeywords.length) {
      hybridWarnings.push(
        `Keyword probes failed and were skipped: ${diagnostics.failedKeywords.join(', ')}`,
      );
    }
    if (diagnostics?.truncated) {
      hybridWarnings.push(
        'The lexical scan was cancelled before every matching item could be scored, so this ranking is incomplete.',
      );
    }
    if (documentCap.clamped) {
      hybridWarnings.push(
        `Requested topK exceeded the user's maximum page size of ${settings.maxDocuments}; capped at ${topK}. Documents past this page are not lost — page on with nextCursor.`,
      );
    }
    if (keywordFloor.clamped) {
      hybridWarnings.push(
        `Requested minKeywordScore was below the user's keyword relevance threshold; raised to ${keywordFloor.value}.`,
      );
    }
    if (semanticFloor.clamped) {
      hybridWarnings.push(
        `Requested minSemanticScore was below the user's semantic relevance threshold; raised to ${semanticFloor.value}.`,
      );
    }
    if (scope.fellBackToLibrary) {
      hybridWarnings.push(
        `Collection scope was not applied: ${scope.fallbackReason} Results below cover the whole library, which is wider than requested — never narrower.`,
      );
    } else if (scope.missing.length > 0) {
      hybridWarnings.push(
        `Ignored ${scope.missing.length} unknown collection key(s): ${scope.missing.join(', ')}. The search used the ${scope.collections.length} collection(s) that do exist; re-check the keys against get_collections if something is missing from the results.`,
      );
    }

    // degraded means "do not read these results as a clean run": a mechanical
    // or unverified keyword set, a failed/timed-out branch, a truncated
    // candidate set or skipped probes all qualify.
    const degraded =
      searchResult.degraded ||
      keywordOrigin === 'fallback' ||
      Boolean(diagnostics?.truncated) ||
      Boolean(diagnostics?.failedKeywords.length);

    // The paged-over list is the FULL set of documents that cleared the
    // threshold — the ordering and the filtering both already happened inside
    // fusion. Paging can therefore never reach below the threshold, and never
    // needs to relax it to fill a page.
    const ranked = searchResult.ranked.map(trimCachedEvidence);

    const snapshot: HybridSearchSnapshot = {
      query: args.query,
      keywords: lexicalKeywords,
      keywordSource: keywordOrigin,
      degraded,
      warning: fallbackWarning,
      fallbackReason: fallbackReason ?? undefined,
      retryBudgetNote,
      appliedMinScore: 0,
      appliedKeywordMinScore: searchResult.appliedKeywordMinScore,
      appliedSemanticMinScore: searchResult.appliedSemanticMinScore,
      appliedWikiMinScore: wikiFloor.value,
      libraryID,
      // searchResult.warnings carries branch-level failures ("Semantic search
      // unavailable: ..."). An empty result set means something completely
      // different depending on this flag, so it has to travel with the page.
      branchFailed: searchResult.warnings.length > 0,
      semanticIndexIncompatible: searchResult.semanticIndexIncompatible,
      metadata: {
        searchMode: 'hybrid',
        keywordSearchUnavailable: searchResult.keywordSearchUnavailable,
        keywordStatus: searchResult.keywordSearchUnavailable
          ? 'unavailable'
          : searchResult.warnings.some((warning) =>
                warning.startsWith('Keyword metadata search unavailable'),
              )
            ? 'degraded'
            : 'ok',
        fusion: 'independent_thresholds_weighted_rrf',
        fusionNote:
          wikiSettings.enabled && wikiSettings.shadowMode
            ? 'Keyword and semantic branches keep their existing independent thresholds and Weighted RRF ranking. The Wiki route was independently filtered by normalizedWikiScore and measured in Shadow Mode, so it did not create, remove, or reorder any result. Wiki evidenceConfidence, readDepth and epistemicStatus are reliability fields and were not multiplied into relevance.'
            : 'Each route was filtered on its OWN relevance scale and survivors were unioned. Ranking is Weighted RRF: keywordWeight/(rrfK + keywordRank) + semanticWeight/(rrfK + semanticRank) + wikiWeight/(rrfK + wikiRank), with an absent route contributing zero. normalizedWikiScore is relevance; evidenceConfidence, readDepth and epistemicStatus remain separate reliability fields.',
        keywordSource: keywordOrigin,
        keywordProbeOrigin: provenance.probeOrigin,
        keywordFallbackReason: fallbackReason ?? undefined,
        declaredDomain: provenance.domain ?? undefined,
        declaredExpertRole: provenance.expertRole ?? undefined,
        keywordCount: lexicalKeywords.length,
        keywordWeights: lexicalKeywordEntries.map((entry) => ({
          keyword: entry.text,
          weight: entry.weight,
          origin: entry.origin,
        })),
        // What the search was allowed to look at, and what that cost.
        searchScope: scope.searchScope,
        scopeCollections: scope.collections,
        scopeUncertainCollections: uncertainCollections,
        scopeItemCount:
          scope.searchScope === 'collections' ? scope.itemKeys.length : null,
        scopeMissingCollections: scope.missing,
        scopeSubcollectionsIncluded: scope.subcollectionsIncluded,
        scopeFellBackToLibrary: scope.fellBackToLibrary,
        scopeFallbackReason: scope.fallbackReason ?? undefined,
        chunksScanned: semanticScanStats.chunksScanned ?? null,
        lexicalOutOfScope: diagnostics?.outOfScope ?? 0,
        lexicalStrategy: diagnostics?.strategy,
        lexicalCandidateCount: diagnostics?.candidateIDs ?? 0,
        lexicalScannedCount: diagnostics?.scannedItems ?? 0,
        lexicalTruncated: diagnostics?.truncated ?? false,
        failedKeywords: diagnostics?.failedKeywords ?? [],
        keywordCoverageBonus: HYBRID_KEYWORD_COVERAGE_BONUS,
        // BM25F per-field weights and length-normalisation strengths, which is
        // what the keyword branch now scores with. Reported so a caller can see
        // why a title hit outranks a body hit rather than having to guess.
        keywordFieldParameters: DEFAULT_FIELD_PARAMETERS,
        bodyKeywords: diagnostics?.body ?? null,
        language,
        rrfK: options.rrfK,
        keywordWeight: options.keywordWeight,
        semanticWeight: options.semanticWeight,
        wikiEnabled: wikiSettings.enabled,
        wikiShadowMode: wikiSettings.enabled && wikiSettings.shadowMode,
        wikiMinScore: wikiFloor.value,
        userWikiMinScore: wikiSettings.minScore,
        wikiWeight: wikiSettings.rrfWeight,
        wikiSearchTimeoutMs: wikiSettings.searchTimeoutMs,
        appliedKeywordMinScore: searchResult.appliedKeywordMinScore,
        appliedSemanticMinScore: searchResult.appliedSemanticMinScore,
        userKeywordMinScore: settings.keywordMinScore,
        userSemanticMinScore: settings.semanticMinScore,
        appliedPageSize: topK,
        userMaxDocuments: settings.maxDocuments,
        // Rejected by BOTH branches — the only way a retrieved document can be
        // dropped now that either threshold on its own is enough to admit it.
        discardedBelowThreshold: searchResult.discardedBelowThreshold,
        keywordResultCount: searchResult.keywordResultCount,
        semanticResultCount: searchResult.semanticResultCount,
        keywordAdmittedCount: searchResult.keywordAdmittedCount,
        semanticAdmittedCount: searchResult.semanticAdmittedCount,
        wikiResultCount: searchResult.wikiResultCount,
        wikiAdmittedCount: searchResult.wikiAdmittedCount,
        wikiCandidateItemKeys: searchResult.wikiCandidateItemKeys,
        wikiNovelDocumentCount: searchResult.wikiNovelDocumentCount,
        wikiKeywordOverlapCount: searchResult.wikiKeywordOverlapCount,
        wikiSemanticOverlapCount: searchResult.wikiSemanticOverlapCount,
        degraded,
        // A machine-readable form of the warning above: "the semantic half of
        // this search produced nothing and cannot produce anything until the
        // index is rebuilt", which prose alone leaves a client free to miss.
        semanticIndexIncompatible: searchResult.semanticIndexIncompatible,
        semanticStatus: searchResult.semanticIndexIncompatible
          ? 'error'
          : searchResult.warnings.some((warning) =>
                warning.startsWith('Semantic search unavailable'),
              )
            ? 'degraded'
            : 'ok',
        warnings: hybridWarnings,
        timings: {
          lexicalMs: searchResult.timings.keywordMs,
          semanticMs: searchResult.timings.semanticMs,
          wikiMs: searchResult.timings.wikiMs,
          rrfMs: searchResult.timings.rrfMs,
          totalMs: searchResult.timings.totalMs,
          lexicalBreakdown: diagnostics
            ? {
                searchMs: diagnostics.searchMs,
                scanMs: diagnostics.scanMs,
                rankMs: diagnostics.rankMs,
              }
            : undefined,
        },
        fulltextScanned: false,
      },
    };

    const fingerprint: SearchFingerprint = {
      query: args.query,
      keywords: lexicalKeywords,
      domain: args.domain,
      expertRole: args.expertRole,
      // Single-branch tools key their cursor on one floor; this tool has two,
      // and either one changing is a different ranking.
      appliedMinScore: 0,
      appliedKeywordMinScore: searchResult.appliedKeywordMinScore,
      appliedSemanticMinScore: searchResult.appliedSemanticMinScore,
      appliedWikiMinScore: wikiFloor.value,
      wikiPreferenceMinScore: wikiSettings.minScore,
      language,
      libraryID,
      rrfK: options.rrfK,
      keywordWeight: options.keywordWeight,
      semanticWeight: options.semanticWeight,
      wikiWeight: options.wikiWeight,
      wikiEnabled: wikiSettings.enabled,
      wikiShadowMode: wikiSettings.enabled && wikiSettings.shadowMode,
      pageSize: topK,
      scope: describeScope(scope),
    };
    // Only worth remembering when there is a page 2 to remember it for.
    const searchId =
      ranked.length > topK
        ? this.hybridPages.create(fingerprint, ranked, snapshot)
        : 'single-page';

    const window = detachPageWindow(
      // Stated rather than defaulted. windowOf falls back to exactly this
      // identity, so hybrid_search was correct only by coincidence — and that
      // coincidence is what hid the bug in the tools whose identity differs.
      windowOf<Record<string, any>>(
        ranked,
        0,
        topK,
        searchId,
        HYBRID_PAGE_IDENTITY,
      ),
    );
    const fullTextCoverage = await this.enrichHybridResults(
      window.rows,
      libraryID,
    );

    return this.buildHybridSearchResponse(
      snapshot,
      window,
      topK,
      false,
      fullTextCoverage,
    );
  }

  /**
   * Turn the caller's collection keys into a concrete item scope.
   *
   * Reads the collection tree straight out of Zotero and hands the pure
   * resolver an accessor, so the walking, de-duplication and every
   * fall-back-to-the-whole-library rule stay testable without Zotero.
   */
  private resolveHybridScope(
    collectionKeys: unknown,
    libraryID: number,
  ): CollectionScope {
    const cache = new Map<string, any>();
    const load = (key: string): any => {
      if (cache.has(key)) return cache.get(key);
      let collection: any = null;
      try {
        collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
      } catch (error) {
        ztoolkit.log(
          `[StreamableMCP] Could not load collection ${key}: ${error}`,
          'warn',
        );
      }
      cache.set(key, collection || null);
      return collection || null;
    };

    const scope = resolveCollectionScope(collectionKeys, {
      getCollection: (key) => {
        const collection = load(key);
        if (!collection) return null;
        let childCollectionKeys: string[] = [];
        let itemKeys: string[] = [];
        try {
          const childIDs = collection.getChildCollections(true, false) || [];
          childCollectionKeys = (
            Zotero.Collections.get(childIDs) as unknown as any[]
          )
            .map((child: any) => child?.key)
            .filter(Boolean);
        } catch {
          // A collection with no children throws in some Zotero versions;
          // treat it as a leaf rather than failing the whole search.
        }
        try {
          const itemIDs = collection.getChildItems(true) || [];
          itemKeys = (Zotero.Items.get(itemIDs) as unknown as any[])
            .filter((item: any) => item && !item.deleted)
            .map((item: any) => item.key)
            .filter(Boolean);
        } catch (error) {
          ztoolkit.log(
            `[StreamableMCP] Could not read items of collection ${key}: ${error}`,
            'warn',
          );
        }
        return {
          key: collection.key,
          name: collection.name || collection.key,
          childCollectionKeys,
          itemKeys,
        };
      },
    });

    ztoolkit.log(
      `[StreamableMCP][Scope] searchScope=${scope.searchScope} collections=${scope.collections.length} items=${scope.itemKeys.length} missing=${scope.missing.length} subcollections=${scope.subcollectionsIncluded} fallback=${scope.fellBackToLibrary}${scope.fallbackReason ? ` (${scope.fallbackReason})` : ''}`,
    );
    return scope;
  }

  /**
   * Serve the next page of a search that already ran.
   *
   * Nothing is retrieved, scored or re-ordered here: the stored list was
   * ranked and threshold-filtered once, and every page is a window onto that
   * one list. That is what makes page 2 continuous with page 1 rather than a
   * second opinion about the same query.
   */
  private async continueHybridSearch(
    args: any,
    cursor: string,
    request: {
      requestedPageSize: number | undefined;
      keywordFloor: number;
      semanticFloor: number;
      wikiFloor: number;
      language: string;
      libraryID: number;
    },
  ): Promise<any> {
    // Only arguments the caller actually re-sent are checked. Omitting one
    // means "unchanged"; re-sending a different one means this is a different
    // search, and continuing the old cursor would answer the new question with
    // the old ranking.
    const claim: FingerprintClaim = {};
    const currentWikiSettings = getWikiSettings();
    claim.wikiPreferenceMinScore = currentWikiSettings.minScore;
    claim.wikiWeight = currentWikiSettings.rrfWeight;
    claim.wikiEnabled = currentWikiSettings.enabled;
    claim.wikiShadowMode = currentWikiSettings.shadowMode;
    if (typeof args.query === 'string' && args.query.trim()) {
      claim.query = args.query;
    }
    if (Array.isArray(args.keywords) && args.keywords.length > 0) {
      claim.keywords = resolveHybridKeywords(
        typeof args.query === 'string' ? args.query : '',
        args.keywords,
      ).keywords;
    }
    if (args.domain !== undefined) claim.domain = String(args.domain);
    if (args.expertRole !== undefined) {
      claim.expertRole = String(args.expertRole);
    }
    if (args.minKeywordScore !== undefined) {
      claim.appliedKeywordMinScore = request.keywordFloor;
    }
    if (args.minSemanticScore !== undefined) {
      claim.appliedSemanticMinScore = request.semanticFloor;
    }
    if (args.wikiMinScore !== undefined) {
      claim.appliedWikiMinScore = request.wikiFloor;
    }
    if (args.language !== undefined) claim.language = request.language;
    if (args.libraryID !== undefined) claim.libraryID = request.libraryID;
    // Retrieval knobs cannot take effect on a stored ranking, so accepting them
    // silently would be answering a different question than the one asked.
    if (args.rrfK !== undefined) claim.rrfK = Number(args.rrfK);
    if (args.keywordWeight !== undefined) {
      claim.keywordWeight = Number(args.keywordWeight);
    }
    if (args.semanticWeight !== undefined) {
      claim.semanticWeight = Number(args.semanticWeight);
    }
    // Wiki knobs are preference-owned in v2 shadow mode. A cursor remains tied
    // to the exact Wiki state captured on page 1 even though clients cannot
    // override these values per call.
    if (args.collectionKeys !== undefined) {
      claim.scope = describeScope(
        this.resolveHybridScope(args.collectionKeys, request.libraryID),
      );
    }

    const { state, window: cachedWindow } = this.hybridPages.read(
      cursor,
      claim,
      request.requestedPageSize,
    );
    const window = detachPageWindow(cachedWindow);
    const pageSize = request.requestedPageSize ?? state.fingerprint.pageSize;

    const fullTextCoverage = await this.enrichHybridResults(
      window.rows,
      state.fingerprint.libraryID,
    );

    ztoolkit.log(
      `[StreamableMCP][HybridPage] cursor page offset=${window.offset} returned=${window.returned} total=${window.totalRelevant} hasMore=${window.hasMore}`,
    );

    return this.buildHybridSearchResponse(
      state.meta,
      window,
      pageSize,
      true,
      fullTextCoverage,
    );
  }

  /**
   * Assemble one page's response.
   *
   * Page 1 and page N are built by the same code from the same snapshot, so
   * the caller sees one search described one way, with only the window moving.
   */
  private buildHybridSearchResponse(
    snapshot: HybridSearchSnapshot,
    window: PageWindow<Record<string, any>>,
    pageSize: number,
    fromCursor: boolean,
    fullTextCoverage?: FullTextCoverage,
  ): any {
    const first = window.totalRelevant === 0 ? 0 : window.offset + 1;
    const last = window.offset + window.returned;
    const range = window.totalRelevant === 0 ? 'none' : `${first}-${last}`;

    // Counted per page, not per search: which documents lack full text depends
    // on which rows this page actually returned, so this cannot live in the
    // cached snapshot that paging replays.
    const fullTextWarning = fullTextCoverage
      ? describePageFullTextGaps(fullTextCoverage)
      : undefined;
    const warnings = fullTextWarning
      ? [...(snapshot.metadata.warnings ?? []), fullTextWarning]
      : snapshot.metadata.warnings;

    return {
      mode: 'hybrid',
      query: snapshot.query,
      keywords: snapshot.keywords,
      keywordSource: snapshot.keywordSource,
      degraded: snapshot.degraded,
      ...(snapshot.warning ? { warning: snapshot.warning } : {}),
      pagination: {
        // The two floors these results were gated by, one per branch. Paging
        // never moves either. A document is here because at least one of them
        // admitted it, so there is no single number to report and none is
        // invented.
        appliedKeywordMinScore: snapshot.appliedKeywordMinScore,
        appliedSemanticMinScore: snapshot.appliedSemanticMinScore,
        appliedWikiMinScore: snapshot.appliedWikiMinScore,
        // Documents at least one branch admitted in this search — NOT the raw
        // candidate count, and NOT capped by the page size.
        totalRelevant: window.totalRelevant,
        // A failed branch makes this a lower bound; clean exhaustive retrieval
        // makes it exact.
        totalRelevantIsLowerBound: snapshot.branchFailed,
        /** A branch failed or timed out: the ranking is incomplete. */
        degradedRetrieval: snapshot.branchFailed,
        returned: window.returned,
        offset: window.offset,
        range,
        pageSize,
        hasMore: window.hasMore,
        ...(window.nextCursor ? { nextCursor: window.nextCursor } : {}),
        servedFromCursor: fromCursor,
      },
      data: window.rows.map(projectHybridCandidate),
      metadata: {
        ...snapshot.metadata,
        warnings,
        // Exactly the five values a row's `fullText` can take, counted over
        // the rows THIS page returned. `unknown` is reported as itself: an
        // index written before the distinction existed is not evidence of
        // full text, and folding it into `indexed` would overstate coverage.
        fullTextCoverage,
        extractedAt: new Date().toISOString(),
        resultCount: window.returned,
        totalRelevant: window.totalRelevant,
        servedFromCursor: fromCursor,
        nextStep: this.hybridNextStep(snapshot, window, range, fullTextWarning),
      },
    };
  }

  private hybridNextStep(
    snapshot: HybridSearchSnapshot,
    window: PageWindow<Record<string, any>>,
    range: string,
    fullTextWarning?: string,
  ): string {
    if (snapshot.keywordSource === 'fallback') {
      return `This call is not recorded as domain-expert retrieval (${snapshot.fallbackReason}). Redo hybrid_search once with bilingual domain-expert keywords plus domain and expertRole, then work from that ranking. ${snapshot.retryBudgetNote} Triage the rows before fetching anything: get_item_abstract only for a candidate you are seriously considering, then search_fulltext on that one document.`;
    }
    if (window.totalRelevant === 0) {
      // "Nothing matched" and "retrieval broke" look identical from here, and
      // telling the user their library has nothing on the topic when in fact a
      // branch timed out is a false negative delivered with full confidence.
      if (snapshot.branchFailed) {
        return `NO RESULTS, BUT THIS SEARCH WAS DEGRADED: a retrieval branch failed or was cancelled (see metadata.warnings), so this is NOT evidence that the library lacks relevant work. Retry the search and only report an empty library if a clean, non-degraded search also comes back empty.`;
      }
      return `Nothing in the library cleared either relevance threshold (keyword ${snapshot.appliedKeywordMinScore}, semantic ${snapshot.appliedSemanticMinScore}). A document only had to clear ONE of them to appear, so this is a genuinely empty result rather than one branch being strict. Say so rather than reporting weak matches; the thresholds are the user's settings and are not negotiable from here.`;
    }

    const funnel =
      'These are candidates at least one branch admitted, in weighted-RRF order, as lightweight rows: title, creators, year, venue, language, the RRF score (a rank-consensus number, NOT a relevance - use normalizedKeywordScore and normalizedSemanticScore for that, and note that a missing one means that branch did not admit the document rather than that it scored zero), which keywords matched which fields, a short evidence snippet, and fullText — whether that document actually has body text in the index, one of: indexed (real full text), parse_failed (a PDF/Markdown exists but could not be parsed), no_source (no PDF/Markdown/text attachment at all), not_indexed (has a body source but is not in the semantic index yet), unknown (indexed before this was recorded). Read fullText before you read matchedChunks. "indexed" is the only value whose snippets are confirmed body text. For "parse_failed", "no_source" and "not_indexed" the document was indexed from its title and abstract alone, the snippets are that metadata rather than passages from the paper, and search_fulltext will refuse it. For "unknown" the document predates this record: search_fulltext still works, but whether its passages are body text or just an abstract was never established, so do not cite them as the paper\'s content without checking. Every row that is not "indexed" carries a fullTextNote saying what to do about it. metadata.fullTextCoverage counts this page by those same five values, and the five counts add up to the rows returned. Abstracts are NOT included - they were searched, they are just not shipped back. Triage from these rows first. For a paper you are seriously considering going deeper on - and only for those - call get_item_abstract with that one itemKey; a page of 20 candidates does not mean 20 abstracts. After reading an abstract, re-fit domain and expertRole to what THAT paper actually studies, write a query and keywords from its own subject matter in the language it is written in (one language, not both), and call search_fulltext with its single itemKey.';

    const paging = window.hasMore
      ? ` PAGING: ${window.totalRelevant} documents cleared the threshold and you are seeing ${range}. If the bottom of this page is still relevant, or the user asked for a comprehensive sweep or a literature review, call hybrid_search again with cursor="${window.nextCursor}" and change nothing else - same query, keywords, domain, expertRole, minKeywordScore and minSemanticScore - to get the next page of the SAME ranking. Do not page by reflex: if this page already answers the question, stop here.`
      : ` PAGING: ${range} of ${window.totalRelevant} - this is the last page of the ranking.`;

    const degradedNote = snapshot.branchFailed
      ? ` DEGRADED: a retrieval branch failed or timed out during this search (see metadata.warnings), so this ranking is incomplete — treat a thin result list as a retrieval problem, not as a fact about the library.`
      : '';

    const bound = window.hasMore
      ? ''
      : " These are all the documents above the threshold. Do not lower minScore to find more; the threshold is the user's setting.";

    // Placed in nextStep as well as in warnings: this one changes what the
    // caller may do with specific rows, so it belongs in the instruction it is
    // about to follow, not only in a list it may skim.
    const fullTextNote = fullTextWarning
      ? ` FULL TEXT: ${fullTextWarning}`
      : '';

    return funnel + paging + bound + degradedNote + fullTextNote;
  }

  /**
   * Fill in the metadata a fused match needs before it can be triaged.
   *
   * The lexical branch carries item type, creators, year and DOI already and
   * the semantic branch carries the matched chunks, but a match found by only
   * one of the two is missing whatever the other would have supplied.
   *
   * The abstract is deliberately NOT attached. It stays part of retrieval -
   * the lexical branch searches abstractNote and the semantic index is built
   * from document text - it is simply not shipped back, because shipping 20
   * abstracts to decide on 3 papers is most of the response for none of the
   * decision. What is recorded instead is whether an abstract exists and how
   * long it is, so the caller knows what get_item_abstract would return, plus
   * the language the document is written in, which is what stage-3 keywords
   * have to be written in.
   */
  /**
   * Mark every row on a page with whether that document has indexed body text.
   *
   * This is the earliest point the distinction can be made visible, and making
   * it visible here is the whole point: refusing at search_fulltext is correct
   * but happens after the candidate row has already been read. A paper whose
   * PDF failed to parse produces a row that is identical to a real one — same
   * fused score, same `matchedBy: "semantic"`, same `matchedChunks` — except
   * that those chunks are its title and abstract. Without this field there is
   * nothing in the response that could tell the two apart, so an abstract can
   * be quoted as if it were the paper's results.
   *
   * One batched query per page; rows are annotated in place.
   */
  private async annotateFullTextAvailability(
    results: Array<Record<string, any>>,
    defaultLibraryID: number,
  ): Promise<FullTextCoverage> {
    const coverage = emptyFullTextCoverage();
    if (results.length === 0) return coverage;

    let states: Map<string, BodyIndexState> | null = null;
    try {
      states = await getSemanticSearchService().getItemBodyIndexStates(
        results.map((result) => ({
          itemKey: result.itemKey,
          libraryID: result.libraryID ?? defaultLibraryID,
        })),
      );
    } catch (error) {
      // A lookup failure must not silently claim every row has full text.
      // 'unknown' is the honest answer to "we could not find out", and it is
      // counted as 'unknown' rather than quietly disappearing.
      ztoolkit.log(
        `[StreamableMCP] Could not resolve full-text availability for this page: ${error}`,
        'warn',
      );
    }

    // Every row is annotated and counted exactly once, on both the success and
    // the failure path, so the five counts always sum to the rows returned.
    for (const result of results) {
      const libraryID = result.libraryID ?? defaultLibraryID;
      const availability: FullTextAvailability = states
        ? fullTextAvailabilityFromState(
            states.get(`${libraryID}:${result.itemKey}`) ?? 'missing',
          )
        : 'unknown';
      result.fullText = availability;
      const note = describeFullTextAvailability(availability);
      if (note) result.fullTextNote = note;
      coverage[availability] += 1;
    }
    return coverage;
  }

  private async enrichHybridResults(
    results: Array<Record<string, any>>,
    defaultLibraryID: number,
  ): Promise<FullTextCoverage> {
    await getSemanticSearchService().hydrateMatchedChunkTexts(results);
    const fullTextCoverage = await this.annotateFullTextAvailability(
      results,
      defaultLibraryID,
    );
    for (const result of results) {
      try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          result.libraryID ?? defaultLibraryID,
          result.itemKey,
        );
        if (!item) continue;
        if (!result.title) {
          result.title =
            item.getDisplayTitle?.() || item.getField?.('title') || '';
        }
        if (!result.itemType) result.itemType = item.itemType;
        if (!result.date) {
          const date = item.getField?.('date') || '';
          result.date = String(date).match(/\d{4}/)?.[0] || '';
        }
        if (!result.creators) {
          try {
            result.creators = item
              .getCreators()
              .map((creator: any) =>
                `${creator.firstName || ''} ${creator.lastName || ''}`.trim(),
              )
              .filter(Boolean)
              .join(', ');
          } catch {
            // Creator lookup is best-effort; the match itself still stands.
          }
        }
        // Abstract: recorded as availability only, never as content.
        const abstract = String(item.getField?.('abstractNote') || '');
        delete result.abstract;
        result.hasAbstract = abstract.length > 0;
        result.abstractChars = abstract.length;
        if (!result.language) {
          result.language = detectDocumentLanguage(
            String(item.getField?.('language') || ''),
            [
              result.title,
              abstract,
              ...(result.matchedChunks || []).map(
                (chunk: any) => chunk?.text || '',
              ),
            ],
          );
        }
      } catch (error) {
        ztoolkit.log(
          `[StreamableMCP] Could not enrich hybrid result ${result.itemKey}: ${error}`,
          'warn',
        );
      }
    }
    return fullTextCoverage;
  }

  private validateSearchParameters(params: {
    query?: unknown;
    topK: unknown;
    minScore: unknown;
    language?: unknown;
    libraryID: unknown;
    timeoutMs?: unknown;
  }): void {
    if (
      params.query !== undefined &&
      (typeof params.query !== 'string' || !params.query.trim())
    ) {
      throw new Error('query must not be blank');
    }
    if (
      !Number.isInteger(params.topK) ||
      Number(params.topK) < 1 ||
      Number(params.topK) > 20
    ) {
      throw new Error('topK must be an integer between 1 and 20');
    }
    if (
      typeof params.minScore !== 'number' ||
      !Number.isFinite(params.minScore) ||
      params.minScore < 0 ||
      params.minScore > 1
    ) {
      throw new Error('minScore must be a finite number between 0 and 1');
    }
    if (
      params.language !== undefined &&
      !['zh', 'en', 'all', 'auto'].includes(String(params.language))
    ) {
      throw new Error('language must be one of zh, en, all, or auto');
    }
    if (!Number.isInteger(params.libraryID) || Number(params.libraryID) <= 0) {
      throw new Error('libraryID must be a positive integer');
    }
    if (
      params.timeoutMs !== undefined &&
      (typeof params.timeoutMs !== 'number' ||
        !Number.isFinite(params.timeoutMs) ||
        params.timeoutMs < 1)
    ) {
      throw new Error('timeoutMs must be a positive finite number');
    }
  }

  private async callSearchAnnotations(args: any): Promise<any> {
    const extractor = new SmartAnnotationExtractor();
    const { q, ...options } = args;
    const result = await extractor.searchAnnotations(q, options);
    return result;
  }

  /**
   * `get_item_details`: bibliographic metadata, and deliberately nothing else.
   *
   * This used to hand back the abstract and every note's full HTML body,
   * because `formatItem`'s default field list included `abstractNote` and
   * `notes` and nothing filtered them out. A model asking "what is this paper,
   * so I can cite it" was therefore given the paper's abstract and the user's
   * private reading notes in the same object, with no marker saying which was
   * whose. Both now have tools that return them on purpose — get_item_abstract
   * and get_annotations — and this one reports only whether they exist.
   */
  /**
   * Refuse a key that names something other than a document.
   *
   * Every Zotero key looks alike, so a caller holding an attachment key or a
   * note key has no way to know it is the wrong kind until a tool tells them.
   * Both failures observed live were silent: get_item_details returned the PDF
   * as though it were a paper, and get_document_chunks blamed a missing index
   * for a note that has no attachment to index. Saying what the key actually
   * names, and naming the document above it, turns a dead end into one more
   * call.
   */
  private async assertDocumentKey(
    itemKey: string,
    libraryID: number | undefined,
    tool: string,
  ): Promise<void> {
    if (!itemKey) return;
    const resolvedLibraryID = libraryID ?? Zotero.Libraries.userLibraryID;
    let item: any = null;
    try {
      item = await Zotero.Items.getByLibraryAndKeyAsync(
        resolvedLibraryID,
        itemKey,
      );
    } catch {
      return; // Missing keys are the existing handlers' error to report.
    }
    if (!item) return;

    let kind: ItemKeyKind = 'regular';
    if (item.isAnnotation?.()) kind = 'annotation';
    else if (item.isNote?.()) kind = 'note';
    else if (item.isAttachment?.()) kind = 'attachment';
    if (kind === 'regular') return;

    const refusal = describeNonDocumentKey(
      { key: itemKey, kind, parentItemKey: item.parentKey || undefined },
      tool,
    );
    if (refusal) throw new Error(refusal);
  }

  private async callGetItemDetails(args: any): Promise<any> {
    const { itemKey, libraryID } = args;
    // An attachment key used to sail straight through here and come back as a
    // record whose title was the PDF's filename.
    await this.assertDocumentKey(itemKey, libraryID, 'get_item_details');
    const { handleGetItem } = await import('./apiHandlers');

    const queryParams = new URLSearchParams();
    if (libraryID !== undefined && libraryID !== null) {
      queryParams.append('libraryID', String(libraryID));
    }
    queryParams.append('fields', STANDARD_ITEM_DETAIL_FIELDS.join(','));

    const response = await handleGetItem({ 1: itemKey }, queryParams);
    const result = response.body ? JSON.parse(response.body) : response;

    if (!result || typeof result !== 'object' || result.error) {
      return result;
    }

    // The unified five-value status, not the per-attachment extension guess.
    // `hasFulltext` claimed full text for any file whose name ended in .pdf,
    // including PDFs that had never parsed, so a caller could not tell a
    // readable paper from an unreadable one.
    const resolvedLibraryID =
      typeof result.libraryID === 'number'
        ? result.libraryID
        : (libraryID ?? Zotero.Libraries.userLibraryID);
    const probe: Array<Record<string, any>> = [
      { itemKey: result.key ?? itemKey, libraryID: resolvedLibraryID },
    ];
    await this.annotateFullTextAvailability(probe, resolvedLibraryID);
    result.fullText = probe[0].fullText;
    if (probe[0].fullTextNote) result.fullTextNote = probe[0].fullTextNote;

    result.metadata = {
      ...result.metadata,
      returnedFields: [...STANDARD_ITEM_DETAIL_FIELDS],
      contentPolicy:
        'Metadata only. Abstract text, note bodies, annotation text, attachment text and chunks are never returned here: use get_item_abstract, get_annotations, get_attachment_text and get_document_chunks respectively. hasAbstract/abstractChars say what get_item_abstract would return without returning it.',
      extractedAt: new Date().toISOString(),
    };

    return result;
  }

  private async callGetAnnotations(args: any): Promise<any> {
    const extractor = new SmartAnnotationExtractor();
    const result = await extractor.getAnnotations(args);
    return result;
  }

  /**
   * `get_attachment_text`: one attachment, one window, one named source.
   *
   * The Zotero-facing half of the tool. Attachment selection, window slicing
   * and the source vocabulary all live in `attachmentText.ts` so they can be
   * tested without Zotero; what happens here is the part that needs a real
   * library: enumerating attachments and pulling the text out of one.
   */
  private async callGetAttachmentText(args: any): Promise<any> {
    const libraryID = args.libraryID ?? Zotero.Libraries.userLibraryID;
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
      libraryID,
      args.itemKey,
    );
    if (!item) {
      throw new Error(
        `Item ${args.itemKey} not found in library ${libraryID}.`,
      );
    }
    if (item.isAttachment?.()) {
      throw new Error(
        `${args.itemKey} is itself an attachment. Pass the parent item as itemKey and this key as attachmentKey.`,
      );
    }

    const { isGeneratedMarkdownAttachment } = await import('./pdfTextSource');
    const summaries: AttachmentSummary[] = [];
    for (const attachmentID of item.getAttachments?.(false) ?? []) {
      try {
        const attachment = Zotero.Items.get(attachmentID);
        if (!attachment?.isAttachment?.()) continue;
        summaries.push({
          attachmentKey: attachment.key,
          title: String(attachment.getField?.('title') || '') || undefined,
          filename: attachment.attachmentFilename || undefined,
          contentType: attachment.attachmentContentType || undefined,
          sizeBytes: undefined,
          hasExtractableText: this.attachmentCanYieldText(attachment),
          isGeneratedMarkdown: isGeneratedMarkdownAttachment(attachment),
        });
      } catch (error) {
        ztoolkit.log(
          `[StreamableMCP] Could not inspect attachment ${attachmentID}: ${error}`,
          'warn',
        );
      }
    }

    const selection = selectAttachment(summaries, args.attachmentKey);
    const identity = {
      itemKey: item.key,
      libraryID,
      title: item.getDisplayTitle?.() || item.getField?.('title') || '',
    };

    if (selection.kind === 'not_found') {
      throw new Error(
        `Attachment ${selection.requestedKey} does not belong to item ${item.key}. Call get_attachment_text with itemKey alone to list this item's attachments.`,
      );
    }
    if (selection.kind === 'none') {
      return {
        ...identity,
        attachments: summaries,
        text: null,
        textSource: {
          method: 'no_text' as AttachmentTextMethod,
          description: describeTextMethod('no_text'),
        },
        metadata: {
          extractedAt: new Date().toISOString(),
          nextStep: summaries.length
            ? "None of this item's attachments can yield text (they are images, or unsupported file types). Read the abstract with get_item_abstract instead, and tell the user the full text is not readable from their library."
            : 'This item has no attachments at all, so there is no text to read. Use get_item_details and get_item_abstract, and tell the user the full text is not in their library.',
        },
      };
    }
    if (selection.kind === 'choose') {
      return {
        ...identity,
        attachments: summaries,
        text: null,
        metadata: {
          extractedAt: new Date().toISOString(),
          nextStep: `This item has ${selection.candidates.length} attachments that could yield text, so none was chosen for you — reading the wrong one returns text that looks entirely valid and belongs to a different document. Call get_attachment_text again with the attachmentKey you want: ${selection.candidates
            .map(
              (candidate) =>
                `${candidate.attachmentKey} (${candidate.filename || candidate.title || 'untitled'})`,
            )
            .join(', ')}.`,
        },
      };
    }

    const attachment: any = await Zotero.Items.getByLibraryAndKeyAsync(
      libraryID,
      selection.attachment.attachmentKey,
    );
    if (!attachment) {
      throw new Error(
        `Attachment ${selection.attachment.attachmentKey} could not be loaded from library ${libraryID}.`,
      );
    }
    const extracted = await this.extractAttachmentText(attachment);
    const window = takeTextWindow(extracted.text, args.offset, args.limit);
    const empty = isEmptyTextMethod(extracted.method);

    return {
      ...identity,
      attachment: {
        ...selection.attachment,
        selectedAutomatically: selection.automatic,
      },
      attachments: summaries,
      textSource: {
        method: extracted.method,
        description: describeTextMethod(extracted.method),
      },
      pagination: {
        totalChars: window.totalChars,
        returnedChars: window.returnedChars,
        offset: window.offset,
        hasMore: window.hasMore,
        ...(window.nextOffset !== undefined
          ? { nextOffset: window.nextOffset }
          : {}),
        endsOnBoundary: window.endsOnBoundary,
      },
      text: empty ? null : window.text,
      metadata: {
        extractedAt: new Date().toISOString(),
        nextStep: empty
          ? `${describeTextMethod(extracted.method)} No text was returned. Do not retry this call unchanged.`
          : window.hasMore
            ? `Characters ${window.offset}-${window.offset + window.returnedChars} of ${window.totalChars}. Continue with offset=${window.nextOffset}. Stop as soon as the text stops answering the question. To search inside this paper instead of reading on, call search_fulltext with itemKey "${item.key}"; to read the indexed body with stable chunk ids, call get_document_chunks.`
            : `That is the end of this attachment's text (${window.totalChars} characters total).`,
      },
    };
  }

  /** Whether this file type could yield text at all. Not a claim we have it. */
  private attachmentCanYieldText(attachment: any): boolean {
    try {
      const contentType = String(attachment.attachmentContentType || '');
      const filename = String(
        attachment.attachmentFilename || '',
      ).toLowerCase();
      if (contentType.includes('pdf') || filename.endsWith('.pdf')) return true;
      if (contentType.includes('html') || contentType.startsWith('text/')) {
        return true;
      }
      return ['.txt', '.md', '.markdown', '.htm', '.html', '.xml'].some((ext) =>
        filename.endsWith(ext),
      );
    } catch {
      return false;
    }
  }

  /**
   * Pull text out of one attachment and say which path produced it.
   *
   * The order is the same one search_fulltext's indexer uses, so the two tools
   * never disagree about what a document's text is: Doc2X/MinerU Markdown
   * first, then Zotero's own flat extract, then the bundled PDF worker.
   */
  private async extractAttachmentText(
    attachment: any,
  ): Promise<{ text: string; method: AttachmentTextMethod }> {
    const contentType = String(attachment?.attachmentContentType || '');
    const filename = String(attachment?.attachmentFilename || '').toLowerCase();
    const isPDF = contentType.includes('pdf') || filename.endsWith('.pdf');

    if (isPDF) {
      const { getPDFTextFromMarkdown } = await import('./pdfTextSource');
      const markdown = await getPDFTextFromMarkdown(attachment);
      if (markdown.text) {
        return {
          text: markdown.text,
          method: markdown.method as AttachmentTextMethod,
        };
      }

      try {
        // Not in zotero-types, but present at runtime — the same call
        // UnifiedContentExtractor has always used for this fallback.
        const fulltext = Zotero.Fulltext as any;
        if (fulltext?.getItemContent) {
          const cached = await fulltext.getItemContent(attachment.id);
          if (cached?.content && String(cached.content).trim()) {
            const { TextFormatter } = await import('./textFormatter');
            return {
              text: TextFormatter.formatPDFText(String(cached.content)),
              method: 'zotero_fulltext_cache',
            };
          }
        }
      } catch (error) {
        ztoolkit.log(
          `[StreamableMCP] Zotero full-text cache unavailable for ${attachment.key}: ${error}`,
          'warn',
        );
      }

      // Nothing produced text. The MinerU method already says why (disabled,
      // on-demand disabled, failed), which is more useful than a generic
      // "no text", so it is carried through rather than flattened.
      return { text: '', method: markdown.method as AttachmentTextMethod };
    }

    const extractor = new UnifiedContentExtractor();
    const processed = await extractor.getAttachmentContent(
      attachment.key,
      { preserveOriginal: true },
      attachment.libraryID,
    );
    const text = String(processed?.content || '');
    if (!text.trim()) return { text: '', method: 'no_text' };
    const method = String(processed?.extractionMethod || '');
    if (method === 'html_parsing') return { text, method: 'html_parsing' };
    if (filename.endsWith('.md') || filename.endsWith('.markdown')) {
      return { text, method: 'markdown_attachment' };
    }
    return { text, method: 'text_reading' };
  }

  /**
   * `get_document_chunks`: one page of a document's indexed body, in order.
   */
  private async callGetDocumentChunks(args: any): Promise<any> {
    const defaultLibraryID = Zotero.Libraries.userLibraryID;
    const deps: DocumentChunksDeps = {
      getChunks: async (itemKey, libraryID) => {
        const { getVectorStore } = await import('./semantic/vectorStore');
        return getVectorStore().getChunksForItem(itemKey, libraryID);
      },
      getFullTextAvailability: async (itemKey, libraryID) => {
        const rows: Array<Record<string, any>> = [{ itemKey, libraryID }];
        await this.annotateFullTextAvailability(rows, libraryID);
        return rows[0].fullText as FullTextAvailability;
      },
      getTitle: async (itemKey, libraryID) => {
        try {
          const item = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            itemKey,
          );
          return item
            ? item.getDisplayTitle?.() || item.getField?.('title') || undefined
            : undefined;
        } catch {
          return undefined;
        }
      },
    };

    // The five-state availability vocabulary describes documents, so for a
    // note it produced `not_indexed` and a message about a text attachment
    // that does not exist. Rule the wrong KIND of key out before asking about
    // its index state.
    await this.assertDocumentKey(
      typeof args?.itemKey === 'string' ? args.itemKey.trim() : '',
      args?.libraryID,
      'get_document_chunks',
    );

    try {
      return await readDocumentChunks(args ?? {}, deps, defaultLibraryID);
    } catch (error) {
      if (error instanceof DocumentChunksError) {
        throw new Error(error.message);
      }
      throw error;
    }
  }

  /**
   * Turn a handler's error status into a real tool error.
   *
   * These wrappers parsed the body and returned it whatever the status was, so
   * a refusal came back as a SUCCESSFUL tool result that happened to contain an
   * `error` string. Over MCP that is a protocol-level lie: the client sees a
   * completed call. Every other refusal in this server throws -- removed tool
   * names, get_document_chunks on an unindexed document -- and these now do
   * too.
   */
  private unwrapHandlerResult(response: any, result: any): any {
    const status = typeof response?.status === 'number' ? response.status : 200;
    if (status >= 400) {
      throw new Error(
        (result && typeof result === 'object' && result.error) ||
          `Request failed with status ${status}`,
      );
    }
    if (
      result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      result.error
    ) {
      throw new Error(result.error);
    }
    return result;
  }

  private async callGetCollections(args: any): Promise<any> {
    const processedArgs = prepareFixedContentToolArgs(
      args,
      COLLECTIONS_DEFAULT_LIMIT,
    );

    const collectionParams = new URLSearchParams();
    for (const [key, value] of Object.entries(processedArgs)) {
      if (value !== undefined && value !== null) {
        collectionParams.append(key, String(value));
      }
    }

    const response = await handleGetCollections(collectionParams);
    const result = this.unwrapHandlerResult(
      response,
      response.body ? JSON.parse(response.body) : response,
    );

    return result;
  }

  private async callSearchCollections(args: any): Promise<any> {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(args || {})) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    const response = await handleSearchCollections(searchParams);
    return this.unwrapHandlerResult(
      response,
      response.body ? JSON.parse(response.body) : response,
    );
  }

  private async callGetCollectionDetails(args: any): Promise<any> {
    const { collectionKey, ...otherArgs } = args;
    const detailParams = new URLSearchParams();
    for (const [key, value] of Object.entries(otherArgs)) {
      if (value !== undefined && value !== null) {
        detailParams.append(key, String(value));
      }
    }
    const response = await handleGetCollectionDetails(
      { 1: collectionKey },
      detailParams,
    );
    return this.unwrapHandlerResult(
      response,
      response.body ? JSON.parse(response.body) : response,
    );
  }

  /**
   * `get_collection_items`: one level of the library, like a file manager.
   *
   * The walking, counting, path resolution and paging live in
   * `collectionBrowser.ts` behind injected accessors; this method is the
   * Zotero adapter for them, plus a small cache so a level with twenty
   * subcollections does not re-read the same nodes while counting descendants.
   */
  private async callGetCollectionItems(args: any): Promise<any> {
    const libraryID = args?.libraryID ?? Zotero.Libraries.userLibraryID;
    const nodes = new Map<string, CollectionNode | null>();

    const loadNode = (key: string): CollectionNode | null => {
      if (nodes.has(key)) return nodes.get(key) ?? null;
      let node: CollectionNode | null = null;
      try {
        const collection = Zotero.Collections.getByLibraryAndKey(
          libraryID,
          key,
        );
        if (collection) {
          let childCollectionKeys: string[] = [];
          let itemKeys: string[] = [];
          try {
            const childIDs = collection.getChildCollections(true, false) || [];
            childCollectionKeys = (
              Zotero.Collections.get(childIDs) as unknown as any[]
            )
              .map((child: any) => child?.key)
              .filter(Boolean);
          } catch {
            // Some Zotero versions throw on a leaf collection rather than
            // returning an empty list. A leaf is a valid answer, not a failure.
          }
          try {
            // getChildItems(false) is DIRECT children only, which is the whole
            // point of browsing one level at a time.
            const childItems = (collection.getChildItems(false) || []) as any[];
            itemKeys = childItems
              .filter(
                (item: any) =>
                  item &&
                  !item.deleted &&
                  !item.isNote?.() &&
                  !item.isAttachment?.(),
              )
              .map((item: any) => item.key)
              .filter(Boolean);
          } catch (error) {
            ztoolkit.log(
              `[StreamableMCP] Could not read items of collection ${key}: ${error}`,
              'warn',
            );
          }
          node = {
            key: collection.key,
            name: collection.name || collection.key,
            parentKey: collection.parentKey || null,
            childCollectionKeys,
            itemKeys,
          };
        }
      } catch (error) {
        ztoolkit.log(
          `[StreamableMCP] Could not load collection ${key}: ${error}`,
          'warn',
        );
      }
      nodes.set(key, node);
      return node;
    };

    const deps: CollectionBrowserDeps = {
      getCollection: loadNode,
      getTopLevelCollectionKeys: () => {
        try {
          return (
            Zotero.Collections.getByLibrary(libraryID) as unknown as any[]
          )
            .map((collection: any) => collection?.key)
            .filter(Boolean);
        } catch (error) {
          ztoolkit.log(
            `[StreamableMCP] Could not list top-level collections: ${error}`,
            'warn',
          );
          return [];
        }
      },
      getUnfiledItemKeys: async () => {
        try {
          const search = new Zotero.Search();
          (search as any).libraryID = libraryID;
          search.addCondition('unfiled', 'true');
          search.addCondition('noChildren', 'true');
          // `search()` is async. Reading it synchronously produced a Promise
          // that the Array.isArray guard below discarded without complaint,
          // so this accessor returned [] for every library and the root level
          // claimed no unfiled items even when there were several.
          const ids = await (search as any).search?.();
          const resolved = Array.isArray(ids) ? ids : [];
          return (Zotero.Items.get(resolved) as unknown as any[])
            .filter((item: any) => item && !item.deleted)
            .map((item: any) => item.key)
            .filter(Boolean);
        } catch (error) {
          // Unfiled items are a convenience at the root, not the point of the
          // call: a library whose search condition is unavailable still gets a
          // usable listing of its top-level folders.
          ztoolkit.log(
            `[StreamableMCP] Could not resolve unfiled items: ${error}`,
            'warn',
          );
          return [];
        }
      },
      describeItems: async (itemKeys, currentCollectionKey) => {
        const rows: BrowsedItem[] = [];
        for (const itemKey of itemKeys) {
          try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(
              libraryID,
              itemKey,
            );
            if (!item) continue;
            // Only the OTHER folders: repeating the one being browsed on every
            // row would be noise, while its absence is what makes a
            // cross-filed document stand out in a listing.
            const alsoIn = describeItemCollections(item).filter(
              (entry) => entry.collectionKey !== currentCollectionKey,
            );
            rows.push({
              itemKey: item.key,
              title:
                item.getDisplayTitle?.() ||
                item.getField?.('title') ||
                '(no title)',
              creators:
                item
                  .getCreators?.()
                  .map((creator: any) =>
                    `${creator.firstName || ''} ${creator.lastName || ''}`.trim(),
                  )
                  .filter(Boolean)
                  .join(', ') || undefined,
              year:
                String(item.getField?.('date') || '').match(/\d{4}/)?.[0] ||
                undefined,
              itemType: item.itemType,
              publicationTitle:
                String(item.getField?.('publicationTitle') || '') || undefined,
              DOI: String(item.getField?.('DOI') || '') || undefined,
              ...(alsoIn.length > 0 ? { alsoIn } : {}),
            });
          } catch (error) {
            ztoolkit.log(
              `[StreamableMCP] Could not describe item ${itemKey}: ${error}`,
              'warn',
            );
          }
        }
        return rows;
      },
      getLibraryName: () => {
        try {
          const library = Zotero.Libraries.get(libraryID) as any;
          return library?.name || 'My Library';
        } catch {
          return 'My Library';
        }
      },
    };

    try {
      return await browseCollection(args ?? {}, deps, libraryID);
    } catch (error) {
      if (error instanceof CollectionBrowserError) {
        const detail = error.candidates
          ? ` Candidates: ${error.candidates
              .map(
                (candidate) => `${candidate.collectionKey} (${candidate.path})`,
              )
              .join('; ')}.`
          : '';
        throw new Error(`${error.message}${detail}`);
      }
      throw error;
    }
  }

  // The five collection-mutation wrappers below go through
  // `unwrapHandlerResult` for the same reason the read wrappers do: their
  // handlers answer "collection not found" with HTTP 404 and a body of
  // `{ error }`, and returning that body verbatim turned a refusal into a
  // SUCCESSFUL tool result whose text happened to mention an error. A client,
  // an auto-retry loop or a workflow engine then carried on as though the
  // collection existed. Successful paths (200/201) are untouched.
  private async callCreateCollection(args: any): Promise<any> {
    const response = await handleCreateCollection({
      libraryID: args.libraryID,
      name: args.name,
      parentCollection: args.parentCollection,
    });
    return this.unwrapHandlerResult(
      response,
      response.body ? JSON.parse(response.body) : response,
    );
  }

  private async callUpdateCollection(args: any): Promise<any> {
    const { collectionKey, ...body } = args;
    const response = await handleUpdateCollection({ 1: collectionKey }, body);
    return this.unwrapHandlerResult(
      response,
      response.body ? JSON.parse(response.body) : response,
    );
  }

  private async callDeleteCollection(args: any): Promise<any> {
    const { collectionKey, ...body } = args;
    const response = await handleDeleteCollection({ 1: collectionKey }, body);
    return this.unwrapHandlerResult(
      response,
      response.body ? JSON.parse(response.body) : response,
    );
  }

  /**
   * Accept arrays that some MCP clients serialize as strings, e.g.
   * '["KEY1","KEY2"]' or 'KEY1,KEY2' (#71).
   */
  /**
   * Chunk ids from a tool call, as numbers.
   *
   * Returns undefined for anything empty so the caller can test presence
   * rather than length: `readChunkIds` is a MODE selector, and `[]` means "no
   * question-driven reading here", not "a question that read nothing".
   * Non-numeric entries are dropped here so the service reports the real
   * problem - ids that are not passages of this paper - rather than NaN.
   */
  private coerceChunkIds(value: unknown): number[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const ids = value
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry) && entry >= 0)
      .map((entry) => Math.floor(entry));
    return ids.length ? ids : undefined;
  }

  /**
   * Normalise the synthesis audit a model sends back.
   *
   * Shape only - nothing here decides whether a quotation supports anything;
   * that is `verifySynthesisAudit`, against the real chunk text. Malformed
   * entries are kept rather than dropped so the verifier can name them in its
   * refusal: a silently discarded entry reads to the model as "I sent it and
   * it was ignored", which is the one failure mode it cannot debug.
   *
   * A JSON string is accepted as well as an array, because clients that
   * serialise nested tool arguments are common enough that refusing them would
   * look like the gate itself was broken.
   */
  private coerceSynthesisAudit(value: unknown): any[] | undefined {
    let raw = value;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        return undefined;
      }
    }
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    return raw.map((entry: any) => ({
      sentence: String(entry?.sentence ?? ''),
      support: Array.isArray(entry?.support)
        ? entry.support.map((item: any) => ({
            chunkId: Number(item?.chunkId),
            quote: String(item?.quote ?? ''),
          }))
        : [],
    }));
  }

  private coerceStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
      return value.map(String);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return parsed.map(String);
        } catch {
          // fall through to comma-split
        }
      }
      if (trimmed.length > 0) {
        return trimmed
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
    return undefined;
  }

  private async callAddItemsToCollection(args: any): Promise<any> {
    const { collectionKey, itemKeys, libraryID } = args;
    const response = await handleAddItemsToCollection(
      { 1: collectionKey },
      { itemKeys, libraryID },
    );
    return this.unwrapHandlerResult(
      response,
      response.body ? JSON.parse(response.body) : response,
    );
  }

  private async callRemoveItemsFromCollection(args: any): Promise<any> {
    const { collectionKey, itemKeys, libraryID } = args;
    const response = await handleRemoveItemsFromCollection(
      { 1: collectionKey },
      { itemKeys, libraryID },
    );
    return this.unwrapHandlerResult(
      response,
      response.body ? JSON.parse(response.body) : response,
    );
  }

  /**
   * A rejected preflight is a FAILED tool call, and it still has to say why.
   *
   * These two tools answer a rejected batch with HTTP 422 and a body that
   * names every offending key. Returning that body verbatim made the call a
   * SUCCESSFUL MCP result that happened to contain the word "rejected": a
   * model usually read it, but a client, an auto-retry loop or a workflow
   * engine did not, and moved on as though the library had been reorganised.
   *
   * Throwing is the fix, but throwing a bare sentence would trade one failure
   * for another - the useful half of a rejected preflight IS the list of keys,
   * and the tool descriptions promise it. So the lists are folded into the
   * error message, the same way CollectionBrowserError folds its ambiguous
   * path candidates in.
   *
   * 207 is deliberately NOT an error: merge_items applies each group
   * atomically, so a partial batch has really merged the groups it names and
   * the receipt is the answer. Only 4xx/5xx, where nothing was written, throw.
   */
  private assertBatchPreflightPassed(
    response: any,
    result: any,
    toolName: string,
    detail: string[],
  ): void {
    const status = typeof response?.status === 'number' ? response.status : 200;
    if (status < 400) return;
    const headline =
      (result && typeof result === 'object' && result.error) ||
      `${toolName} failed with HTTP ${status}`;
    throw new Error([headline, ...detail.filter(Boolean)].join(' '));
  }

  private async callMergeItems(args: any): Promise<any> {
    const { groups, libraryID, dryRun } = args;
    const response = await handleMergeItems({
      groups: (groups as any[]).map((group: any) => ({
        itemKeys: this.coerceStringArray(group?.itemKeys) ?? [],
        masterItemKey: group?.masterItemKey,
      })),
      libraryID,
      dryRun: dryRun === true,
    });
    const result = response.body ? JSON.parse(response.body) : response;
    this.assertBatchPreflightPassed(response, result, 'merge_items', [
      Array.isArray(result?.problems) && result.problems.length > 0
        ? `Problems: ${result.problems
            .map(
              (problem: any) =>
                `group ${Number(problem?.groupIndex ?? 0) + 1}${problem?.itemKey ? ` / ${problem.itemKey}` : ''}: ${problem?.reason ?? 'rejected'}`,
            )
            .join('; ')}.`
        : '',
      typeof result?.wouldHaveMerged === 'number'
        ? `${result.wouldHaveMerged} group(s) would have merged; none did.`
        : '',
    ]);
    return result;
  }

  private async callMoveItemsToCollection(args: any): Promise<any> {
    const { toCollectionKey, itemKeys, libraryID, dryRun } = args;
    const response = await handleMoveItemsToCollection(
      { 1: toCollectionKey },
      { itemKeys, libraryID, dryRun: dryRun === true },
    );
    const result = response.body ? JSON.parse(response.body) : response;
    this.assertBatchPreflightPassed(
      response,
      result,
      'move_items_to_collection',
      [
        Array.isArray(result?.notFound) && result.notFound.length > 0
          ? `No such item: ${result.notFound.join(', ')}.`
          : '',
        Array.isArray(result?.notFilable) && result.notFilable.length > 0
          ? `Cannot be filed in a collection: ${result.notFilable
              .map(
                (entry: any) =>
                  `${entry?.itemKey} (${entry?.reason ?? 'not filable'})`,
              )
              .join('; ')}.`
          : '',
        typeof result?.wouldHaveMoved === 'number'
          ? `${result.wouldHaveMoved} of the keys you passed were movable; none moved.`
          : '',
      ],
    );
    return result;
  }

  /**
   * Document-level hybrid search, plus the neighbour-expansion mode.
   *
   * Both delegate to documentDeepDive, which is built on the same hybrid
   * primitives as hybrid_search: there is no second retrieval stack here, only
   * a different candidate set (this paper's chunks instead of the library).
   */
  private async callSearchFulltext(args: any): Promise<any> {
    // Context-expansion mode: no query, no ranking, just neighbours.
    if (Array.isArray(args?.chunkIds) && args.chunkIds.length > 0) {
      return expandChunkContext({
        itemKey: args.itemKey,
        libraryID: args.libraryID,
        chunkIds: args.chunkIds,
        radius: args.neighborRadius,
      });
    }

    if (typeof args?.query !== 'string' || !args.query.trim()) {
      // `q` was the old parameter name; accept it so an existing client still
      // gets a working call rather than a cryptic failure. Nothing else from
      // the old keyword-context interface survives.
      if (typeof args?.q === 'string' && args.q.trim()) {
        args = { ...args, query: args.q };
      } else {
        throw new Error(
          "query is required: write a natural-language sentence describing what you need from THIS paper, derived from the user question plus this paper's abstract (get_item_abstract) and the evidence you already have, written in the language this paper is written in.",
        );
      }
    }

    return runDocumentDeepDive({
      itemKey: args.itemKey,
      libraryID: args.libraryID,
      query: args.query,
      keywords: args.keywords,
      domain: args.domain,
      expertRole: args.expertRole,
      maxChunks: args.maxChunks,
      minKeywordScore: args.minKeywordScore,
      minSemanticScore: args.minSemanticScore,
    });
  }

  private async callGetItemAbstract(args: any): Promise<any> {
    const { itemKey, ...otherArgs } = args;
    const abstractParams = new URLSearchParams();
    for (const [key, value] of Object.entries(otherArgs)) {
      if (value !== undefined && value !== null) {
        abstractParams.append(key, String(value));
      }
    }
    const response = await handleGetItemAbstract(
      { 1: itemKey },
      abstractParams,
    );
    const contentType = response.headers?.['Content-Type'] || '';
    if (contentType.startsWith('text/plain')) {
      // format=text returns a plain-text body that must not be JSON.parsed
      return response.body;
    }
    const result = response.body ? JSON.parse(response.body) : response;
    return this.unwrapHandlerResult(response, result);
  }

  // ============ Single-branch retrieval (semantic_search, keyword_search) ==

  /**
   * `semantic_search` and `keyword_search` are ONE pipeline with one branch
   * swapped out.
   *
   * Before this, `semantic_search` was the last tool still on the pre-funnel
   * architecture: hard-coded `topK = 10` and `minScore = 0.3` that ignored the
   * user's own relevance threshold and page size, no cursor, no collection or
   * item scoping, and rows that shipped raw untruncated chunk text — in a real
   * library that meant whole reference lists came back as "evidence". A model
   * could not tell a semantic hit on a paper's body from a hit on its title,
   * because the unified `fullText` status was never attached.
   *
   * Writing `keyword_search` as a third copy of all that would have been the
   * obvious mistake, so instead both tools resolve the same scope, run ONE
   * branch, fuse through the same normaliser, apply the same threshold, cache
   * the same ranking and project the same rows. `hybrid_search` still owns the
   * two-branch path; what it shares with these two is the layer below —
   * `runLexicalSearch`, `SemanticSearchService.search`, `HybridSearchPageStore`
   * and `projectHybridCandidate` — so there is exactly one implementation of
   * each retrieval algorithm in the plugin, not three.
   */
  private async runSingleBranchSearch(
    branch: 'semantic' | 'keyword',
    args: any,
  ): Promise<any> {
    const toolName =
      branch === 'semantic' ? 'semantic_search' : 'keyword_search';
    const settings = getHybridSearchSettings();
    const documentCap = resolveResultCap(args.topK, settings.maxDocuments);
    // Each single-branch tool inherits the threshold of the branch it IS. The
    // old shared floor was one number applied to two different scales; now that
    // hybrid_search keeps them apart, keyword_search must follow the keyword
    // setting and semantic_search the semantic one, or the same document would
    // be judged differently depending on which tool retrieved it.
    const scoreFloor = resolveScoreFloor(
      args.minScore,
      branch === 'semantic'
        ? settings.semanticMinScore
        : settings.keywordMinScore,
    );
    const topK = documentCap.value;
    const language = branch === 'semantic' ? (args.language ?? 'all') : 'all';
    const libraryID = args.libraryID ?? Zotero.Libraries.userLibraryID;
    const store =
      branch === 'semantic' ? this.semanticPages : this.keywordPages;
    const pageIdentity =
      branch === 'semantic' ? SEMANTIC_PAGE_IDENTITY : KEYWORD_PAGE_IDENTITY;

    const cursor =
      typeof args.cursor === 'string' && args.cursor.trim()
        ? args.cursor.trim()
        : null;
    if (cursor) {
      return await this.continueSingleBranchSearch(branch, args, cursor, {
        requestedPageSize: args.topK === undefined ? undefined : topK,
        scoreFloor: scoreFloor.value,
        language,
        libraryID,
      });
    }

    // Two scopes, intersected. collectionKeys answers "which part of the
    // library", itemKeys answers "which shortlist" — the coarse-filter output
    // of a previous keyword_search — and a caller may reasonably want both.
    const scope = this.resolveHybridScope(args.collectionKeys, libraryID);
    const explicitItemKeys = this.coerceStringArray(args.itemKeys);
    const scopeItemKeys = this.intersectScopes(scope, explicitItemKeys);

    const {
      keywords: lexicalKeywords,
      entries: lexicalKeywordEntries,
      source: probeSource,
    } = resolveHybridKeywords(
      typeof args.query === 'string' ? args.query : '',
      args.keywords,
    );
    const provenance = resolveKeywordProvenance({
      probeSource,
      keywordsArgumentPresent:
        args.keywords !== undefined && args.keywords !== null,
      domain: args.domain,
      expertRole: args.expertRole,
    });

    this.validateSearchParameters({
      query: branch === 'semantic' ? args.query : undefined,
      topK,
      minScore: scoreFloor.value,
      language,
      libraryID,
    });

    const warnings: string[] = [];
    const semanticScanStats: {
      chunksScanned?: number;
      chunksMatched?: number;
    } = {};
    let branchFailed = false;
    let semanticIndexIncompatible = false;
    let timedOut = false;
    let keywordSearchUnavailable = false;
    let retryAfterMs = 0;
    let lexicalDiagnostics:
      | Awaited<ReturnType<typeof runLexicalSearch>>['diagnostics']
      | null = null;
    let rows: Array<Record<string, any>> = [];
    const startedAt = Date.now();

    try {
      if (branch === 'semantic') {
        const semanticService = getSemanticSearchService();
        const abort =
          typeof AbortController !== 'undefined' ? new AbortController() : null;
        const matches = await runWithTimeout(
          () =>
            semanticService.search(args.query, {
              exhaustive: true,
              includeChunkText: false,
              // The fused threshold below is the only relevance filter, exactly
              // as in hybrid_search. Filtering twice, at two different scales,
              // is how a document could clear the user's threshold and still be
              // dropped before it ever reached it.
              minScore: -1,
              language,
              libraryID,
              itemKeys: scopeItemKeys,
              vectorScanTimeoutMs: settings.vectorScanTimeoutMs,
              signal: abort?.signal,
              stats: semanticScanStats,
            }),
          settings.vectorScanTimeoutMs + DEFAULT_EMBEDDING_TIMEOUT_MS,
          'Semantic search',
        ).finally(() => abort?.abort());
        rows = this.normaliseSingleBranchRows(matches, 'semantic');
      } else {
        // The user's setting is a promise about when THIS request ends, so it
        // is enforced twice over. runLexicalSearch now races Zotero's own
        // (uncancellable) query against the inner deadline, and runWithTimeout
        // is the outer guarantee that covers everything else in the branch.
        // Previously neither existed on this path: the deadline was only ever
        // consulted between chunks, AFTER `Zotero.Search.search()` had already
        // returned, so keyword_search had no upper bound at all.
        const deadlineAt =
          startedAt +
          Math.max(1, Math.floor(settings.keywordSearchTimeoutMs * 0.9));
        let keywordCancelled = false;
        const outcome = await runWithTimeout(
          () =>
            runLexicalSearch({
              keywords: lexicalKeywordEntries,
              libraryID,
              scopeItemKeys: scopeItemKeys ? new Set(scopeItemKeys) : undefined,
              deadlineAt,
              isCancelled: () => keywordCancelled,
              // No second branch to make up the difference here: past the
              // deadline the caller gets a timeout, not a silent subset that
              // reads like a complete answer.
              onDeadline: 'throw',
            }),
          settings.keywordSearchTimeoutMs,
          'Keyword search',
          () => {
            keywordCancelled = true;
          },
        );
        lexicalDiagnostics = outcome.diagnostics;
        rows = this.normaliseSingleBranchRows(outcome.items, 'keyword');
        if (outcome.diagnostics.failedKeywords.length) {
          warnings.push(
            `Keyword probes failed and were skipped: ${outcome.diagnostics.failedKeywords.join(', ')}`,
          );
        }
        if (outcome.diagnostics.truncated) {
          warnings.push(
            'The lexical scan was cancelled before every matching item could be scored, so this ranking is incomplete.',
          );
        }
      }
    } catch (error) {
      // A failed branch is not an empty library, and the two must never look
      // the same: reporting "nothing relevant" after a timeout is a false
      // negative delivered with full confidence.
      branchFailed = true;
      if (isKeywordSearchUnavailableError(error)) {
        // A distinct state from a timeout: Zotero's database stopped answering
        // an EARLIER query, and because its search API cannot be cancelled the
        // gate is refusing to create more until a probe proves it recovered.
        // Saying "timed out" here would invite the client to retry immediately,
        // which is exactly what must not happen.
        timedOut = true;
        keywordSearchUnavailable = true;
        retryAfterMs = error.retryAfterMs;
        warnings.push(
          `Keyword retrieval is temporarily unavailable: ${error.message} Do NOT read this as an empty library — retry after about ${Math.ceil(error.retryAfterMs / 1000)}s, or use semantic_search in the meantime.`,
        );
      } else if (
        isLexicalSearchTimeoutError(error) ||
        isKeywordSearchGateError(error)
      ) {
        // Named explicitly so a client can tell "we ran out of time" from "we
        // looked and found nothing" — the two used to be the same response.
        timedOut = true;
        warnings.push(
          `Keyword retrieval timed out after ${settings.keywordSearchTimeoutMs}ms and was ended at the deadline; any late result was discarded. This is NOT evidence that the library lacks matching work — narrow the scope, use fewer keywords, or raise the keyword search timeout, then retry. Detail: ${error instanceof Error ? error.message : String(error)}`,
        );
      } else if (isVectorDimensionMismatchError(error)) {
        // semantic_search has no second branch to fall back to, so this is a
        // total failure of the tool, not a partial degradation. Say so in the
        // shared wording rather than letting it read as "no matches".
        semanticIndexIncompatible = true;
        warnings.push(
          `Semantic retrieval failed: ${error.message} ${DIMENSION_MISMATCH_HINT}`,
        );
      } else {
        warnings.push(
          `${branch === 'semantic' ? 'Semantic' : 'Keyword'} retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      ztoolkit.log(
        `[StreamableMCP] ${toolName} branch failed: ${error}`,
        'error',
      );
    }

    const beforeThreshold = rows.length;
    const ranked = rows
      .filter((row) => row.score >= scoreFloor.value)
      .sort(
        (a, b) =>
          b.score - a.score ||
          String(a.itemKey).localeCompare(String(b.itemKey)),
      )
      // Same trim hybrid_search applies before caching: keyword_search's pages
      // live in the same store for the same 15 minutes, and its rows now carry
      // body-passage evidence too. Ordering is already decided above, so this
      // only reshapes evidence — it cannot move a row.
      .map(trimCachedEvidence);
    const discardedBelowThreshold = beforeThreshold - ranked.length;

    if (documentCap.clamped) {
      warnings.push(
        `Requested topK exceeded the user's maximum page size of ${settings.maxDocuments}; capped at ${topK}. Documents past this page are not lost — page on with nextCursor.`,
      );
    }
    if (scoreFloor.clamped) {
      warnings.push(
        `Requested minScore was below the user's relevance threshold; raised to ${scoreFloor.value}.`,
      );
    }
    if (scope.fellBackToLibrary) {
      warnings.push(
        `Collection scope was not applied: ${scope.fallbackReason} Results below cover the whole library, which is wider than requested — never narrower.`,
      );
    } else if (scope.missing.length > 0) {
      warnings.push(
        `Ignored ${scope.missing.length} unknown collection key(s): ${scope.missing.join(', ')}.`,
      );
    }

    const keywordOrigin =
      branch === 'keyword' ? provenance.keywordSource : 'n/a';
    const fallbackWarning =
      branch === 'keyword' && keywordOrigin === 'fallback'
        ? `warning: ${provenance.reason} Redo this search once with a domain-expert keyword set — bilingual Chinese and English terms of art, translations, synonyms and abbreviations — together with domain and expertRole. Retry at most once; if you have already retried, use these results as they are.`
        : null;
    if (fallbackWarning) warnings.unshift(fallbackWarning);

    const degraded =
      branchFailed ||
      (branch === 'keyword' && keywordOrigin === 'fallback') ||
      Boolean(lexicalDiagnostics?.truncated) ||
      Boolean(lexicalDiagnostics?.failedKeywords.length);

    const snapshot: HybridSearchSnapshot = {
      query: branch === 'semantic' ? String(args.query ?? '') : '',
      keywords: branch === 'keyword' ? lexicalKeywords : [],
      keywordSource: keywordOrigin,
      degraded,
      warning: fallbackWarning,
      fallbackReason: provenance.reason ?? undefined,
      retryBudgetNote:
        'Retry at most once: if you have already retried this search, use these results as they are.',
      appliedMinScore: scoreFloor.value,
      libraryID,
      branchFailed,
      semanticIndexIncompatible,
      metadata: {
        timedOut,
        keywordSearchUnavailable,
        retryAfterMs: retryAfterMs || undefined,
        semanticIndexIncompatible,
        semanticStatus:
          branch !== 'semantic' ? 'n/a' : branchFailed ? 'error' : 'ok',
        searchMode: branch,
        tool: toolName,
        fusion: 'single_branch',
        keywordSource: keywordOrigin,
        declaredDomain: provenance.domain ?? undefined,
        declaredExpertRole: provenance.expertRole ?? undefined,
        ...(branch === 'keyword'
          ? {
              keywordCount: lexicalKeywords.length,
              lexicalStrategy: lexicalDiagnostics?.strategy,
              lexicalCandidateCount: lexicalDiagnostics?.candidateIDs ?? 0,
              lexicalScannedCount: lexicalDiagnostics?.scannedItems ?? 0,
              lexicalTruncated: lexicalDiagnostics?.truncated ?? false,
              failedKeywords: lexicalDiagnostics?.failedKeywords ?? [],
              keywordFieldParameters: DEFAULT_FIELD_PARAMETERS,
              bodyKeywords: lexicalDiagnostics?.body ?? null,
            }
          : {
              language,
              chunksScanned: semanticScanStats.chunksScanned ?? null,
            }),
        searchScope: scope.searchScope,
        scopeCollections: scope.collections,
        scopeItemCount: scopeItemKeys ? scopeItemKeys.length : null,
        scopeMissingCollections: scope.missing,
        scopeSubcollectionsIncluded: scope.subcollectionsIncluded,
        scopeFellBackToLibrary: scope.fellBackToLibrary,
        scopeRestrictedToItemKeys: Boolean(explicitItemKeys?.length),
        appliedMinScore: scoreFloor.value,
        userMinScore:
          branch === 'semantic'
            ? settings.semanticMinScore
            : settings.keywordMinScore,
        appliedPageSize: topK,
        userMaxDocuments: settings.maxDocuments,
        discardedBelowThreshold,
        degraded,
        warnings,
        timings: { totalMs: Date.now() - startedAt },
        fulltextScanned: false,
      },
    };

    const fingerprint: SearchFingerprint = {
      query: snapshot.query,
      keywords: snapshot.keywords,
      domain: args.domain,
      expertRole: args.expertRole,
      appliedMinScore: scoreFloor.value,
      language,
      libraryID,
      rrfK: 0,
      keywordWeight: branch === 'keyword' ? 1 : 0,
      semanticWeight: branch === 'semantic' ? 1 : 0,
      pageSize: topK,
      scope: this.describeSingleBranchScope(scope, explicitItemKeys),
    };
    const searchId =
      ranked.length > topK
        ? store.create(fingerprint, ranked, snapshot)
        : 'single-page';

    const window = detachPageWindow(
      // windowOf defaults to the hybrid cursor prefix, so the identity has to
      // be passed explicitly or page 1 emits a cursor this tool's own store
      // will refuse on page 2.
      windowOf<Record<string, any>>(ranked, 0, topK, searchId, pageIdentity),
    );
    const fullTextCoverage = await this.enrichHybridResults(
      window.rows,
      libraryID,
    );

    ztoolkit.log(
      `[StreamableMCP][${toolName}] scope=${scope.searchScope} scopeItems=${scopeItemKeys?.length ?? 'all'} candidates=${beforeThreshold} relevant=${ranked.length} returned=${window.returned} degraded=${degraded} ${Date.now() - startedAt}ms`,
    );

    return this.buildSingleBranchResponse(
      branch,
      snapshot,
      window,
      topK,
      false,
      fullTextCoverage,
    );
  }

  /** Serve the next window of a stored single-branch ranking. */
  private async continueSingleBranchSearch(
    branch: 'semantic' | 'keyword',
    args: any,
    cursor: string,
    request: {
      requestedPageSize: number | undefined;
      scoreFloor: number;
      language: string;
      libraryID: number;
    },
  ): Promise<any> {
    const store =
      branch === 'semantic' ? this.semanticPages : this.keywordPages;

    // Only what the caller actually re-sent is checked. Omitting an argument
    // means "unchanged"; re-sending a different one means this is a different
    // question, and answering it from the old ranking would be wrong quietly.
    const claim: FingerprintClaim = {};
    if (branch === 'semantic') {
      if (typeof args.query === 'string' && args.query.trim()) {
        claim.query = args.query;
      }
      if (args.language !== undefined) claim.language = request.language;
    } else if (Array.isArray(args.keywords) && args.keywords.length > 0) {
      claim.keywords = resolveHybridKeywords(
        typeof args.query === 'string' ? args.query : '',
        args.keywords,
      ).keywords;
    }
    if (args.domain !== undefined) claim.domain = String(args.domain);
    if (args.expertRole !== undefined) {
      claim.expertRole = String(args.expertRole);
    }
    if (args.minScore !== undefined) claim.appliedMinScore = request.scoreFloor;
    if (args.libraryID !== undefined) claim.libraryID = request.libraryID;
    if (args.collectionKeys !== undefined || args.itemKeys !== undefined) {
      claim.scope = this.describeSingleBranchScope(
        this.resolveHybridScope(args.collectionKeys, request.libraryID),
        this.coerceStringArray(args.itemKeys),
      );
    }

    const { state, window: cachedWindow } = store.read(
      cursor,
      claim,
      request.requestedPageSize,
    );
    const window = detachPageWindow(cachedWindow);
    const pageSize = request.requestedPageSize ?? state.fingerprint.pageSize;
    const fullTextCoverage = await this.enrichHybridResults(
      window.rows,
      state.fingerprint.libraryID,
    );

    return this.buildSingleBranchResponse(
      branch,
      state.meta,
      window,
      pageSize,
      true,
      fullTextCoverage,
    );
  }

  /**
   * Put both branches' hits on one 0-1 scale and one row shape.
   *
   * The lexical branch scores on an unbounded relevance scale and the semantic
   * branch on cosine similarity; `normalizeLexicalScore` and
   * `normalizeSemanticScore` are the same functions hybrid_search's fusion
   * applies before thresholding, so a 0.62 from keyword_search is a 0.62 on
   * hybrid_search's KEYWORD scale and a 0.62 from semantic_search is a 0.62 on
   * its SEMANTIC scale. Those two are no longer pretended to be one number —
   * which is why each of these tools now inherits the threshold belonging to
   * its own branch rather than a shared one.
   */
  private normaliseSingleBranchRows(
    matches: any[],
    branch: 'semantic' | 'keyword',
  ): Array<Record<string, any>> {
    return (matches ?? []).map((match: any) => {
      if (branch === 'semantic') {
        const normalized = normalizeSemanticScore(match.score);
        // One branch, so there is nothing to fuse: the score IS the branch's
        // own normalised relevance, and unlike hybrid_search's RRF score it
        // stays a relevance the user's threshold can meaningfully be compared
        // against.
        const score = normalized;
        return {
          itemKey: match.itemKey,
          libraryID: match.libraryID,
          title: match.title,
          creators: match.creators,
          date: match.year ?? match.date,
          itemType: match.itemType,
          publicationTitle: match.publicationTitle,
          DOI: match.DOI,
          score,
          normalizedSemanticScore: normalized,
          semanticScore: match.score,
          semanticRank: 0,
          matchedChunks: match.matchedChunks,
        };
      }
      const normalized = normalizeLexicalScore(match.relevanceScore);
      return {
        itemKey: match.key ?? match.itemKey,
        libraryID: match.libraryID,
        title: match.title,
        creators: match.creators,
        date: match.date ?? match.year,
        itemType: match.itemType,
        publicationTitle: match.publicationTitle,
        DOI: match.DOI,
        score: normalized,
        normalizedKeywordScore: normalized,
        keywordScore: match.relevanceScore,
        keywordRank: 0,
        matchedKeywords: match.matchedKeywords,
        matchedFields: match.matchedFields,
        // The keyword branch searches indexed BODY text as well as metadata, so
        // a document can be here with matchedFields: ["body"] and nothing in its
        // title, abstract or tags. The ranker already computed which passages
        // carried the hit; dropping it here left the caller looking at a row
        // whose recall reason was invisible. Carried through unchanged — it is
        // evidence, not a score, and nothing downstream ranks on it.
        bodyEvidence: match.bodyEvidence,
      };
    });
  }

  /**
   * Intersect the collection scope with an explicit itemKeys shortlist.
   *
   * Returns undefined for "the whole library". An explicit shortlist that
   * shares nothing with the collection scope yields an EMPTY array rather than
   * undefined, because the honest answer to "search these five papers inside
   * that folder, which contains none of them" is no results — falling back to
   * the whole library there would answer a question nobody asked.
   */
  private intersectScopes(
    scope: CollectionScope,
    explicitItemKeys: string[] | undefined,
  ): string[] | undefined {
    const scoped =
      scope.searchScope === 'collections' ? scope.itemKeys : undefined;
    if (!explicitItemKeys || explicitItemKeys.length === 0) return scoped;
    if (!scoped) return explicitItemKeys;
    const allowed = new Set(scoped);
    return explicitItemKeys.filter((key) => allowed.has(key));
  }

  private describeSingleBranchScope(
    scope: CollectionScope,
    explicitItemKeys: string[] | undefined,
  ): string {
    const base = describeScope(scope);
    if (!explicitItemKeys || explicitItemKeys.length === 0) return base;
    return `${base}|items:${[...explicitItemKeys].sort().join(',')}`;
  }

  private buildSingleBranchResponse(
    branch: 'semantic' | 'keyword',
    snapshot: HybridSearchSnapshot,
    window: PageWindow<Record<string, any>>,
    pageSize: number,
    fromCursor: boolean,
    fullTextCoverage?: FullTextCoverage,
  ): any {
    const first = window.totalRelevant === 0 ? 0 : window.offset + 1;
    const last = window.offset + window.returned;
    const range = window.totalRelevant === 0 ? 'none' : `${first}-${last}`;
    const fullTextWarning = fullTextCoverage
      ? describePageFullTextGaps(fullTextCoverage)
      : undefined;
    const warnings = fullTextWarning
      ? [...(snapshot.metadata.warnings ?? []), fullTextWarning]
      : snapshot.metadata.warnings;
    const toolName =
      branch === 'semantic' ? 'semantic_search' : 'keyword_search';

    return {
      mode: branch,
      ...(branch === 'semantic'
        ? { query: snapshot.query }
        : {
            keywords: snapshot.keywords,
            keywordSource: snapshot.keywordSource,
          }),
      degraded: snapshot.degraded,
      ...(snapshot.warning ? { warning: snapshot.warning } : {}),
      pagination: {
        appliedMinScore: snapshot.appliedMinScore,
        totalRelevant: window.totalRelevant,
        totalRelevantIsLowerBound: snapshot.branchFailed,
        degradedRetrieval: snapshot.branchFailed,
        returned: window.returned,
        offset: window.offset,
        range,
        pageSize,
        hasMore: window.hasMore,
        ...(window.nextCursor ? { nextCursor: window.nextCursor } : {}),
        servedFromCursor: fromCursor,
      },
      data: window.rows.map(projectHybridCandidate),
      metadata: {
        ...snapshot.metadata,
        warnings,
        fullTextCoverage,
        extractedAt: new Date().toISOString(),
        resultCount: window.returned,
        totalRelevant: window.totalRelevant,
        servedFromCursor: fromCursor,
        nextStep: this.singleBranchNextStep(
          toolName,
          branch,
          snapshot,
          window,
          range,
          fullTextWarning,
        ),
      },
    };
  }

  private singleBranchNextStep(
    toolName: string,
    branch: 'semantic' | 'keyword',
    snapshot: HybridSearchSnapshot,
    window: PageWindow<Record<string, any>>,
    range: string,
    fullTextWarning?: string,
  ): string {
    if (window.totalRelevant === 0) {
      if (snapshot.branchFailed) {
        return `NO RESULTS, BUT THIS SEARCH WAS DEGRADED: retrieval failed or was cancelled (see metadata.warnings), so this is NOT evidence that the library lacks relevant work. Retry before reporting an empty library.`;
      }
      return `Nothing reached the relevance threshold of ${snapshot.appliedMinScore}. ${
        branch === 'keyword'
          ? 'A keyword-only search fails when the library uses different surface terms than you did — try hybrid_search, whose semantic branch does not depend on matching the exact words.'
          : 'A semantic-only search can miss a paper that names the concept in unusual words — try hybrid_search, whose keyword branch matches surface terms directly.'
      } Do not lower minScore to force results; the threshold is the user's setting.`;
    }

    const rows =
      branch === 'keyword'
        ? 'These rows come from LEXICAL matching only: nothing here was judged semantically, so a paper about the same idea in different words is absent by construction.'
        : 'These rows come from EMBEDDING similarity only: nothing here was matched on your literal terms, so a paper that names your exact keyword may rank below one that never uses it.';

    const chain =
      branch === 'keyword'
        ? ' To ask a conceptual question of exactly this shortlist, pass these itemKeys to semantic_search as itemKeys.'
        : '';

    const funnel =
      ' Read fullText on each row before you read its evidence snippets: "indexed" is the only value whose snippets are confirmed body text; for "parse_failed", "no_source" and "not_indexed" the document was indexed from its title and abstract alone, so the snippets are that metadata rather than passages from the paper. Abstracts are NOT included — fetch one with get_item_abstract only for a candidate you are seriously considering, then dig into that single paper with search_fulltext.';

    const paging = window.hasMore
      ? ` PAGING: ${window.totalRelevant} documents cleared the threshold and you are seeing ${range}. Call ${toolName} again with cursor set to "${window.nextCursor}" and nothing else changed for the next page of the SAME ranking.`
      : ` PAGING: ${range} of ${window.totalRelevant} — this is the last page.`;

    const degradedNote = snapshot.branchFailed
      ? ' DEGRADED: retrieval failed or timed out during this search, so treat a thin result list as a retrieval problem, not as a fact about the library.'
      : '';

    const fullTextNote = fullTextWarning
      ? ` FULL TEXT: ${fullTextWarning}`
      : '';

    return rows + chain + funnel + paging + degradedNote + fullTextNote;
  }

  private async callSemanticSearch(args: any): Promise<any> {
    return await this.runSingleBranchSearch('semantic', args);
  }

  private async callKeywordSearch(args: any): Promise<any> {
    return await this.runSingleBranchSearch('keyword', args);
  }

  /**
   * Multi-chunk, document-level similarity search.
   *
   * The order of operations is the point, and it mirrors hybrid_search:
   *
   *   scan whole index with every query chunk -> aggregate chunk scores into
   *   ONE score per document -> apply the user's threshold -> rank -> page
   *
   * Aggregating before truncating is what makes "the documents most similar to
   * this paper" answerable. The previous implementation kept the top-K CHUNKS
   * and de-duplicated them into documents afterwards, so a single paper with
   * many strong passages could consume the entire result set.
   */
  private async callFindSimilar(args: any): Promise<any> {
    try {
      const settings = getHybridSearchSettings();
      const pageCap = resolveResultCap(args.topK, settings.maxDocuments);
      // find_similar scores documents by cosine similarity between chunk
      // vectors, so its floor is the semantic one — the same scale, the same
      // setting.
      const scoreFloor = resolveScoreFloor(
        args.minScore,
        settings.semanticMinScore,
      );
      const libraryID = args.libraryID ?? Zotero.Libraries.userLibraryID;

      const cursor =
        typeof args.cursor === 'string' && args.cursor.trim()
          ? args.cursor.trim()
          : null;
      if (cursor) {
        return this.continueFindSimilar(args, cursor, {
          requestedPageSize:
            args.topK === undefined ? undefined : pageCap.value,
          scoreFloor: scoreFloor.value,
          libraryID,
        });
      }

      this.validateSearchParameters({
        topK: pageCap.value,
        minScore: scoreFloor.value,
        libraryID,
      });

      const chunkIds = (Array.isArray(args.chunkIds) ? args.chunkIds : []).map(
        (value: unknown) => Number(value),
      );
      const vectorScanTimeoutMs = settings.vectorScanTimeoutMs;
      const semanticService = getSemanticSearchService();

      // The scan sizes its own deadline from the same model (query count x
      // execution path); this outer backstop must be derived from it too, or it
      // would fire first and turn a legitimate multi-chunk scan into a timeout.
      // Unique ids only, exactly as the service counts them.
      const backstop = resolveSimilarScanBudget({
        queryChunkCount: new Set(chunkIds).size || 1,
        vectorScanTimeoutMs,
        path: semanticService.isGpuSearchEnabled() ? 'gpu' : 'cpu',
      });

      const outcome = await runWithTimeout(
        () =>
          semanticService.findSimilarByChunks({
            itemKey: String(args.itemKey),
            chunkIds,
            libraryID,
            minScore: scoreFloor.value,
            vectorScanTimeoutMs,
          }),
        // Backstop only; the scan carries its own deadline internally.
        backstop.timeoutMs + 5000,
        'Similarity search',
      );

      const warnings: string[] = [];
      if (pageCap.clamped) {
        warnings.push(
          `Requested page size exceeded the user's maximum of ${settings.maxDocuments}; capped at ${pageCap.value}. No qualifying document is lost — page on with nextCursor.`,
        );
      }
      if (scoreFloor.clamped) {
        warnings.push(
          `Requested minScore was below the user's relevance threshold; raised to ${scoreFloor.value}.`,
        );
      }

      const ranked: Array<Record<string, any>> = outcome.ranked.map(
        (document) => ({
          itemKey: document.itemKey,
          libraryID: document.libraryID,
          score: roundScore(document.score),
          bestChunkScore: roundScore(document.bestChunkScore),
          matchedQueryChunks: document.matchedQueryChunks,
          perQueryScores: document.perQueryScores.map(roundScore),
          // Evidence coordinates only: the passages themselves are read with
          // search_fulltext on the candidate, one paper at a time.
          matchedChunkIds: document.evidence.map((hit) => hit.chunkId),
          matchedChunkScores: document.evidence.map((hit) =>
            roundScore(hit.score),
          ),
        }),
      );

      const snapshot: SimilarSearchSnapshot = {
        itemKey: outcome.itemKey,
        libraryID: outcome.libraryID,
        queryChunkIds: outcome.queryChunkIds,
        appliedMinScore: scoreFloor.value,
        metadata: {
          searchMode: 'similar_documents',
          scoring: 'pure_semantic_document_aggregate',
          aggregation: {
            chunksPerQueryChunk: SIMILAR_CHUNKS_PER_QUERY,
            meanWeight: SIMILAR_MEAN_WEIGHT,
            maxWeight: SIMILAR_MAX_WEIGHT,
            formula:
              "documentScore = (meanWeight * mean_i(s_i) + maxWeight * max_i(s_i)) / (meanWeight + maxWeight), where s_i is the mean of this document's two best chunk cosines against query chunk i (0 when it has none)",
          },
          queryItemKey: outcome.itemKey,
          queryChunkIds: outcome.queryChunkIds,
          queryChunkCount: outcome.queryChunkIds.length,
          totalChunksInQueryItem: outcome.totalChunksInItem,
          candidateDocuments: outcome.candidateDocuments,
          discardedBelowThreshold: outcome.discardedBelowThreshold,
          chunksScanned: outcome.chunksScanned,
          appliedMinScore: scoreFloor.value,
          userMinScore: settings.semanticMinScore,
          appliedPageSize: pageCap.value,
          userMaxDocuments: settings.maxDocuments,
          gpuAcceleration: settings.gpuAccelerationEnabled,
          // The deadline this call ran under, and how it was derived from the
          // user's single-scan setting. Reported so a timeout can be read as
          // "the library is bigger than the configured scan budget" rather than
          // as an unexplained failure.
          scanBudget: {
            appliedTimeoutMs: outcome.budget.timeoutMs,
            multiplier: Number(outcome.budget.multiplier.toFixed(2)),
            executionPath: outcome.budget.path,
            userVectorScanTimeoutMs: outcome.budget.vectorScanTimeoutMs,
            queryChunkCount: outcome.budget.queryChunkCount,
            capped: outcome.budget.capped,
          },
          warnings,
          timings: { scanMs: outcome.scanMs, totalMs: outcome.totalMs },
        },
      };

      const fingerprint: SearchFingerprint = {
        // The query identity is the source document plus the chunks chosen from
        // it: change either and this is a different ranking, not another page.
        query: `${outcome.libraryID}:${outcome.itemKey}`,
        keywords: outcome.queryChunkIds.map(String),
        appliedMinScore: scoreFloor.value,
        language: 'all',
        libraryID: outcome.libraryID,
        rrfK: 0,
        keywordWeight: 0,
        semanticWeight: 1,
        pageSize: pageCap.value,
        scope: 'library',
      };
      const searchId =
        ranked.length > pageCap.value
          ? this.similarPages.create(fingerprint, ranked, snapshot)
          : 'single-page';

      const window = detachPageWindow(
        // The identity is REQUIRED here. windowOf defaults to the hybrid
        // prefix, so omitting it made page 1 hand back an "hs1_..." cursor
        // that similarPages.read() — which decodes with "fs1_" — then rejected
        // as malformed. Page 1 looked perfect and page 2 was unreachable.
        windowOf<Record<string, any>>(
          ranked,
          0,
          pageCap.value,
          searchId,
          SIMILAR_PAGE_IDENTITY,
        ),
      );
      await this.enrichSimilarResults(window.rows, outcome.libraryID);

      return this.buildFindSimilarResponse(
        snapshot,
        window,
        pageCap.value,
        false,
      );
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Find similar error: ${error}`, 'error');
      // find_similar is pure semantic — there is no second branch to degrade
      // into, so an index/model mismatch fails the call outright. It is
      // re-thrown with the shared hint so the remedy reads the same here as it
      // does from hybrid_search and semantic_search.
      if (isVectorDimensionMismatchError(error)) {
        throw new Error(`${error.message} ${DIMENSION_MISMATCH_HINT}`);
      }
      throw error;
    }
  }

  /**
   * Serve the next page of a similarity search that already ran.
   *
   * Nothing is re-scanned or re-ranked: the stored list was aggregated and
   * threshold-filtered once, and a page is a window onto it.
   */
  private async continueFindSimilar(
    args: any,
    cursor: string,
    request: {
      requestedPageSize: number | undefined;
      scoreFloor: number;
      libraryID: number;
    },
  ): Promise<any> {
    // Only what the caller re-sent is checked; omitting an argument means
    // "unchanged", re-sending a different one means this is another search.
    const claim: FingerprintClaim = {};
    if (typeof args.itemKey === 'string' && args.itemKey.trim()) {
      claim.query = `${request.libraryID}:${args.itemKey.trim()}`;
    }
    if (Array.isArray(args.chunkIds) && args.chunkIds.length > 0) {
      const seen: number[] = [];
      for (const raw of args.chunkIds) {
        const chunkId = Number(raw);
        if (!seen.includes(chunkId)) seen.push(chunkId);
      }
      claim.keywords = seen.map(String);
    }
    if (args.minScore !== undefined) claim.appliedMinScore = request.scoreFloor;
    if (args.libraryID !== undefined) claim.libraryID = request.libraryID;

    const { state, window: cachedWindow } = this.similarPages.read(
      cursor,
      claim,
      request.requestedPageSize,
    );
    const window = detachPageWindow(cachedWindow);
    const pageSize = request.requestedPageSize ?? state.fingerprint.pageSize;

    await this.enrichSimilarResults(window.rows, state.fingerprint.libraryID);

    ztoolkit.log(
      `[StreamableMCP][SimilarPage] cursor page offset=${window.offset} returned=${window.returned} total=${window.totalRelevant} hasMore=${window.hasMore}`,
    );

    return this.buildFindSimilarResponse(state.meta, window, pageSize, true);
  }

  /** Page 1 and page N are described identically; only the window moves. */
  private buildFindSimilarResponse(
    snapshot: SimilarSearchSnapshot,
    window: PageWindow<Record<string, any>>,
    pageSize: number,
    fromCursor: boolean,
  ): any {
    const first = window.totalRelevant === 0 ? 0 : window.offset + 1;
    const last = window.offset + window.returned;
    const range = window.totalRelevant === 0 ? 'none' : `${first}-${last}`;

    const nextStep =
      window.totalRelevant === 0
        ? 'No document in the library reached the relevance threshold against these passages. Do not lower the threshold: either pick chunks that characterise this paper more specifically, or accept that the library holds nothing close to it.'
        : window.hasMore
          ? 'Read this page first. To see more qualifying documents, call find_similar again with cursor set to nextCursor and nothing else changed. To go deeper on one of these, call get_item_abstract and then search_fulltext on its itemKey.'
          : 'This is every document above the threshold. Go deeper on the ones worth it with get_item_abstract and search_fulltext on their itemKey.';

    return {
      mode: 'similar_documents',
      queryItemKey: snapshot.itemKey,
      queryChunkIds: snapshot.queryChunkIds,
      pagination: {
        appliedMinScore: snapshot.appliedMinScore,
        // Documents above the threshold in this search — not capped by the page
        // size, and not a candidate count.
        totalRelevant: window.totalRelevant,
        returned: window.returned,
        offset: window.offset,
        range,
        pageSize,
        hasMore: window.hasMore,
        ...(window.nextCursor ? { nextCursor: window.nextCursor } : {}),
        servedFromCursor: fromCursor,
      },
      data: window.rows,
      metadata: {
        ...snapshot.metadata,
        extractedAt: new Date().toISOString(),
        resultCount: window.returned,
        totalRelevant: window.totalRelevant,
        servedFromCursor: fromCursor,
        nextStep,
      },
    };
  }

  /**
   * Fill in identity for one page of similarity results.
   *
   * Deliberately not enrichHybridResults: there is no chunk text to hydrate
   * here, and pulling passages in for 20 documents at a time is exactly the
   * cost this tool avoids by returning chunk coordinates instead.
   */
  private async enrichSimilarResults(
    results: Array<Record<string, any>>,
    defaultLibraryID: number,
  ): Promise<void> {
    // Same reason as the hybrid page: a document indexed from metadata alone
    // ranks and reads exactly like one with full text, and find_similar is
    // also a triage stage whose rows get acted on before search_fulltext is
    // ever called.
    await this.annotateFullTextAvailability(results, defaultLibraryID);
    for (const result of results) {
      try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          result.libraryID ?? defaultLibraryID,
          result.itemKey,
        );
        if (!item) continue;
        result.title =
          item.getDisplayTitle?.() || item.getField?.('title') || '';
        result.itemType = item.itemType;
        const date = item.getField?.('date') || '';
        result.date = String(date).match(/\d{4}/)?.[0] || '';
        try {
          result.creators = item
            .getCreators()
            .map((creator: any) =>
              `${creator.firstName || ''} ${creator.lastName || ''}`.trim(),
            )
            .filter(Boolean)
            .join(', ');
        } catch {
          // Creator lookup is best-effort; the match itself still stands.
        }
        const abstract = String(item.getField?.('abstractNote') || '');
        result.hasAbstract = abstract.length > 0;
        result.abstractChars = abstract.length;
        result.language = detectDocumentLanguage(
          String(item.getField?.('language') || ''),
          [result.title, abstract],
        );
      } catch (error) {
        ztoolkit.log(
          `[StreamableMCP] Could not enrich similar result ${result.itemKey}: ${error}`,
          'warn',
        );
      }
    }
  }

  private async callSemanticStatus(): Promise<any> {
    try {
      const semanticService = getSemanticSearchService();
      const isReady = await semanticService.isReady();
      const stats = isReady ? await semanticService.getStats() : null;
      const progress = semanticService.getIndexProgress();

      // Check Int8 migration status
      let int8Status = null;
      try {
        const { getVectorStore } = await import('./semantic/vectorStore');
        const vectorStore = getVectorStore();
        await vectorStore.initialize();
        int8Status = await vectorStore.needsInt8Migration();
      } catch (e) {
        // Ignore if vector store not available
      }

      let message = !isReady
        ? 'Semantic search service not initialized'
        : stats?.serviceStatus.fallbackMode
          ? 'Running in fallback mode (API not configured)'
          : `Semantic search ready with ${stats?.indexStats.totalItems || 0} indexed items`;

      // Report the Int8 coverage gap, and point at something that exists.
      //
      // This used to tell the caller to run an Int8 migration tool. No such
      // MCP tool has ever been exposed here, so the only thing that advice
      // could produce was a failed tool call and a confused retry loop. The
      // conversion is not something an MCP client can trigger at all: it
      // belongs to the user, in Zotero, and re-indexing performs it because
      // every vector written today is quantised on the way in.
      if (int8Status?.needed) {
        message += `. NOTE: ${int8Status.count}/${int8Status.total} stored vectors predate Int8 quantisation, so searches over them run on the slower Float32 path. This is not something you can fix from here and it does not affect result quality — searches work normally. If the user asks about it, tell them to rebuild the semantic index from Zotero → Preferences → Zotero MCP Plugin → Search; newly indexed vectors are always quantised.`;
      }

      // "Indexed" is not the same as "has full text": say how many indexed
      // items are only a title and an abstract, so this number cannot be read
      // as full-text coverage.
      const coverage = stats?.indexStats?.bodyCoverage;
      if (coverage && coverage.metadataOnly > 0) {
        message += `. Of these, ${coverage.metadataOnly} item(s) hold ONLY title and abstract because their PDF/Markdown body could not be parsed — search_fulltext refuses those items rather than returning metadata as evidence. Tell the user to check those PDFs and rebuild their index.`;
      }

      return {
        ready: isReady,
        initialized: stats?.serviceStatus.initialized || false,
        fallbackMode: stats?.serviceStatus.fallbackMode || false,
        indexProgress: progress,
        indexStats: stats?.indexStats || null,
        bodyCoverage: coverage ?? null,
        int8Migration: int8Status,
        message,
      };
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Semantic status error: ${error}`, 'error');
      return {
        ready: false,
        error: String(error),
      };
    }
  }

  // callFulltextDatabase used to live here, dispatching the `fulltext_database`
  // tool's four actions. Two of them (list, stats) were index administration
  // and had no place in a retrieval interface; a third (get) returned an
  // entire document in one unpaginated response, which is the one thing this
  // server's whole funnel exists to prevent. The reading half now lives in
  // `get_document_chunks`, and FulltextDatabaseService remains available to
  // the preferences UI, which is where index maintenance belongs.

  /**
   * Convert Markdown content to HTML suitable for Zotero notes.
   * Auto-detects if content is already HTML and skips conversion.
   */
  private markdownToNoteHtml(markdown: string): string {
    if (!markdown || typeof markdown !== 'string') return '';

    // Detect if content is already HTML
    const trimmed = markdown.trim();
    if (trimmed.startsWith('<') && /<\/.+>/.test(trimmed)) {
      return markdown;
    }

    let html = markdown;

    // Escape HTML entities
    html = html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Headings (process longest first)
    html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Bold + italic, bold, italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Horizontal rules
    html = html.replace(/^---+$/gm, '<hr/>');

    // Unordered lists (block)
    html = html.replace(/(?:^[-*+]\s+.+$\n?)+/gm, (match) => {
      const items = match
        .trim()
        .split('\n')
        .map((line: string) => {
          const content = line.replace(/^[-*+]\s+/, '');
          return `<li>${content}</li>`;
        })
        .join('');
      return `<ul>${items}</ul>\n`;
    });

    // Ordered lists (block)
    html = html.replace(/(?:^\d+\.\s+.+$\n?)+/gm, (match) => {
      const items = match
        .trim()
        .split('\n')
        .map((line: string) => {
          const content = line.replace(/^\d+\.\s+/, '');
          return `<li>${content}</li>`;
        })
        .join('');
      return `<ol>${items}</ol>\n`;
    });

    // Paragraphs: split by double newline, wrap plain text blocks in <p>
    const blocks = html.split(/\n\n+/);
    html = blocks
      .map((block: string) => {
        block = block.trim();
        if (!block) return '';
        if (/^<(h[1-6]|ul|ol|li|blockquote|hr|div|p|pre|table)/i.test(block)) {
          return block;
        }
        block = block.replace(/\n/g, '<br/>');
        return `<p>${block}</p>`;
      })
      .filter(Boolean)
      .join('\n');

    return html;
  }

  /**
   * Handle write_note tool calls: create, update, append notes
   *
   * EMPTY CONTENT MEANS ONE THING, AND ONLY FOR ONE ACTION. Emptying a note is
   * a real thing a user asks for, and it used to be impossible to express: the
   * dispatch tested `!args.content`, so `""` came back as "action and content
   * are required" — the message for a parameter that was never sent. The tool
   * schema never said content had to be non-empty, so the refusal looked like
   * a bug rather than a rule.
   *
   * It is now a value rather than an omission, but only `update` accepts it,
   * because only there does it mean something. Empty content on `create` would
   * leave an empty note in the library and on `append` would change nothing at
   * all; in both cases the only realistic way to arrive there is a caller
   * whose content generation came back empty, and failing loudly is the
   * useful answer. Whitespace-only counts as empty, because that is what
   * markdownToNoteHtml already reduces it to.
   */
  private async callWriteNote(args: any): Promise<any> {
    const {
      action,
      parentKey,
      noteKey,
      content,
      tags,
      libraryID = Zotero.Libraries.userLibraryID,
    } = args;

    try {
      const htmlContent = this.markdownToNoteHtml(content);
      const isEmptyContent =
        typeof content !== 'string' || content.trim().length === 0;

      switch (action) {
        case 'create': {
          if (isEmptyContent) {
            throw new Error(
              'content is empty, so there is nothing to create. An empty string is only meaningful with action "update", where it erases an existing note. If your content generation returned nothing, that is the problem to fix.',
            );
          }
          const note = new Zotero.Item('note');
          note.libraryID = libraryID;

          if (parentKey) {
            const parentItem = await Zotero.Items.getByLibraryAndKeyAsync(
              libraryID,
              parentKey,
            );
            if (!parentItem) {
              throw new Error(
                `Parent item not found in library ${libraryID}: ${parentKey}`,
              );
            }
            if (parentItem.isNote()) {
              throw new Error('Cannot attach a note to another note');
            }
            if (parentItem.isAttachment()) {
              throw new Error('Cannot attach a note to an attachment');
            }
            note.parentKey = parentKey;
          }

          note.setNote(htmlContent);

          if (tags && Array.isArray(tags)) {
            for (const tag of tags) {
              note.addTag(tag, 0);
            }
          }

          await note.saveTx();

          ztoolkit.log(
            `[StreamableMCP] Created note ${note.key}${parentKey ? ' attached to ' + parentKey : ' (standalone)'}`,
          );

          return {
            action: 'create',
            success: true,
            data: {
              noteKey: note.key,
              parentKey: parentKey || null,
              type: parentKey ? 'child' : 'standalone',
              contentPreview: content.substring(0, 200),
              contentLength: content.length,
              tags: tags || [],
              dateCreated: note.dateAdded,
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Note created successfully (key: ${note.key})`,
            },
          };
        }

        case 'update': {
          if (!noteKey) {
            throw new Error('noteKey is required for update action');
          }

          const existingNote = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            noteKey,
          );
          if (!existingNote) {
            throw new Error(
              `Note not found in library ${libraryID}: ${noteKey}`,
            );
          }
          if (!existingNote.isNote()) {
            throw new Error(`Item ${noteKey} is not a note`);
          }

          // What was there before, so the receipt can say what an erase
          // actually erased. A caller that cleared a note by mistake needs to
          // learn it from the answer, not from the note later looking empty.
          const previousLength = (existingNote.getNote() || '').length;

          existingNote.setNote(htmlContent);

          if (tags && Array.isArray(tags)) {
            for (const tag of tags) {
              existingNote.addTag(tag, 0);
            }
          }

          await existingNote.saveTx();

          ztoolkit.log(
            `[StreamableMCP] ${isEmptyContent ? 'Cleared' : 'Updated'} note ${noteKey} (was ${previousLength} chars)`,
          );

          return {
            action: 'update',
            success: true,
            data: {
              noteKey,
              contentPreview: content.substring(0, 200),
              contentLength: content.length,
              ...(isEmptyContent
                ? { cleared: true, previousContentLength: previousLength }
                : {}),
              tags: existingNote.getTags().map((t: any) => t.tag),
              dateModified: existingNote.dateModified,
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: isEmptyContent
                ? `Note ${noteKey} CLEARED: ${previousLength} characters of content were erased. The note itself still exists; delete it in Zotero if it should be gone entirely.`
                : `Note ${noteKey} updated successfully`,
            },
          };
        }

        case 'append': {
          if (!noteKey) {
            throw new Error('noteKey is required for append action');
          }
          if (isEmptyContent) {
            throw new Error(
              'content is empty, so there is nothing to append and the note would be saved unchanged. An empty string is only meaningful with action "update", where it erases the note.',
            );
          }

          const existingNote = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            noteKey,
          );
          if (!existingNote) {
            throw new Error(
              `Note not found in library ${libraryID}: ${noteKey}`,
            );
          }
          if (!existingNote.isNote()) {
            throw new Error(`Item ${noteKey} is not a note`);
          }

          const currentHtml = existingNote.getNote() || '';
          const appendedHtml = currentHtml + htmlContent;
          existingNote.setNote(appendedHtml);

          if (tags && Array.isArray(tags)) {
            for (const tag of tags) {
              existingNote.addTag(tag, 0);
            }
          }

          await existingNote.saveTx();

          ztoolkit.log(`[StreamableMCP] Appended to note ${noteKey}`);

          return {
            action: 'append',
            success: true,
            data: {
              noteKey,
              appendedContentPreview: content.substring(0, 200),
              appendedContentLength: content.length,
              totalContentLength: appendedHtml.length,
              tags: existingNote.getTags().map((t: any) => t.tag),
              dateModified: existingNote.dateModified,
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Content appended to note ${noteKey} successfully`,
            },
          };
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Use create, update, or append.`,
          );
      }
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Write note error: ${error}`, 'error');
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Handle write_tag tool calls: add, remove, set tags on items
   */
  private async callWriteTag(args: any): Promise<any> {
    const {
      action,
      itemKey,
      tags,
      libraryID = Zotero.Libraries.userLibraryID,
    } = args;

    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        libraryID,
        itemKey,
      );
      if (!item) {
        throw new Error(`Item not found in library ${libraryID}: ${itemKey}`);
      }

      const beforeTags = item.getTags().map((t: any) => t.tag);

      switch (action) {
        case 'add': {
          for (const tag of tags) {
            item.addTag(tag, 0);
          }
          break;
        }

        case 'remove': {
          for (const tag of tags) {
            item.removeTag(tag);
          }
          break;
        }

        case 'set': {
          // Remove all existing tags
          for (const existing of beforeTags) {
            item.removeTag(existing);
          }
          // Add new tags
          for (const tag of tags) {
            item.addTag(tag, 0);
          }
          break;
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Use add, remove, or set.`,
          );
      }

      await item.saveTx();

      const afterTags = item.getTags().map((t: any) => t.tag);

      ztoolkit.log(
        `[StreamableMCP] write_tag ${action} on ${itemKey}: [${beforeTags.join(', ')}] -> [${afterTags.join(', ')}]`,
      );

      return {
        action,
        success: true,
        data: {
          itemKey,
          beforeTags,
          afterTags,
          tagsModified: tags,
        },
        metadata: {
          extractedAt: new Date().toISOString(),
          message: `Tags ${action === 'add' ? 'added to' : action === 'remove' ? 'removed from' : 'set on'} item ${itemKey}`,
        },
      };
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Write tag error: ${error}`, 'error');
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Handle write_metadata tool calls: update fields and creators on items
   */
  private async callWriteMetadata(args: any): Promise<any> {
    const {
      itemKey,
      fields,
      creators,
      libraryID = Zotero.Libraries.userLibraryID,
    } = args;

    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        libraryID,
        itemKey,
      );
      if (!item) {
        throw new Error(`Item not found in library ${libraryID}: ${itemKey}`);
      }
      if (!item.isRegularItem()) {
        throw new Error(
          `Item ${itemKey} is not a regular item (it is a ${item.itemType}). Use write_note for notes.`,
        );
      }

      const updatedFields: Record<string, { before: string; after: string }> =
        {};
      let creatorsUpdated = false;
      let beforeCreators: any[] = [];
      let afterCreators: any[] = [];

      // Update fields
      if (fields && typeof fields === 'object') {
        for (const [fieldName, value] of Object.entries(fields)) {
          try {
            const before = String(item.getField(fieldName) || '');
            item.setField(fieldName, String(value));
            updatedFields[fieldName] = { before, after: String(value) };
          } catch (fieldError) {
            throw new Error(
              `Failed to set field "${fieldName}": ${fieldError}`,
            );
          }
        }
      }

      // Update creators
      if (creators && Array.isArray(creators)) {
        beforeCreators = item.getCreators().map((c: any) => ({
          creatorType: Zotero.CreatorTypes.getName(c.creatorTypeID),
          firstName: c.firstName,
          lastName: c.lastName,
        }));

        item.setCreators(
          creators.map((c: any) => {
            const creatorData: any = {
              creatorType: c.creatorType || 'author',
            };
            if (c.name) {
              // Organization / single-field name
              creatorData.name = c.name;
            } else {
              creatorData.firstName = c.firstName || '';
              creatorData.lastName = c.lastName || '';
            }
            return creatorData;
          }),
        );

        creatorsUpdated = true;
        afterCreators = creators;
      }

      await item.saveTx();

      ztoolkit.log(
        `[StreamableMCP] Updated metadata on ${itemKey}: fields=[${Object.keys(updatedFields).join(', ')}], creators=${creatorsUpdated}`,
      );

      return {
        success: true,
        data: {
          itemKey,
          updatedFields,
          creatorsUpdated,
          ...(creatorsUpdated ? { beforeCreators, afterCreators } : {}),
        },
        metadata: {
          extractedAt: new Date().toISOString(),
          message: `Metadata updated on item ${itemKey}`,
        },
      };
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Write metadata error: ${error}`, 'error');
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Handle write_item tool calls: create items, reparent attachments, and import files
   */
  private async callWriteItem(args: any): Promise<any> {
    const {
      action,
      itemType,
      fields,
      creators,
      tags,
      attachmentKeys,
      parentKey,
      filePath,
      parentItemKey,
      title,
      libraryID = Zotero.Libraries.userLibraryID,
    } = args;

    try {
      switch (action) {
        case 'create': {
          if (!itemType) {
            throw new Error(
              'itemType is required for create action (e.g., journalArticle, book, conferencePaper)',
            );
          }

          // Create new item
          const item = new Zotero.Item(itemType);
          item.libraryID = libraryID;

          // Set fields
          if (fields && typeof fields === 'object') {
            for (const [fieldName, value] of Object.entries(fields)) {
              try {
                item.setField(fieldName, String(value));
              } catch (fieldError) {
                throw new Error(
                  `Failed to set field "${fieldName}": ${fieldError}`,
                );
              }
            }
          }

          // Set creators
          if (creators && Array.isArray(creators)) {
            item.setCreators(
              creators.map((c: any) => {
                const creatorData: any = {
                  creatorType: c.creatorType || 'author',
                };
                if (c.name) {
                  creatorData.name = c.name;
                } else {
                  creatorData.firstName = c.firstName || '';
                  creatorData.lastName = c.lastName || '';
                }
                return creatorData;
              }),
            );
          }

          // Add tags
          if (tags && Array.isArray(tags)) {
            for (const tag of tags) {
              item.addTag(tag, 0);
            }
          }

          // --- PREFLIGHT: resolve every attachment key before anything is
          // written. Read-only, and deliberately outside the transaction: a
          // lookup that has to hit the database from inside one would be
          // deciding what to write while already half-writing it.
          //
          // A key that names nothing, or names something that is not an
          // attachment, is reported rather than fatal — it costs the caller
          // one `write_item(action: "reparent")` to fix, and aborting the
          // whole creation over it would throw away metadata that is
          // perfectly good. What it must never do is vanish: the response
          // used to say "Item created, 2 attachment(s) attached" for a call
          // that passed three, and the log is not part of the answer.
          const reparentTargets: Array<{ key: string; attachment: any }> = [];
          const skippedAttachments: Array<{ key: string; reason: string }> = [];
          if (attachmentKeys && Array.isArray(attachmentKeys)) {
            for (const attKey of attachmentKeys) {
              const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
                libraryID,
                attKey,
              );
              if (!attachment) {
                ztoolkit.log(
                  `[StreamableMCP] Attachment not found in library ${libraryID}: ${attKey}`,
                  'warn',
                );
                skippedAttachments.push({
                  key: attKey,
                  reason: `not found in library ${libraryID}`,
                });
                continue;
              }
              if (!attachment.isAttachment()) {
                ztoolkit.log(
                  `[StreamableMCP] Item ${attKey} is not an attachment (type: ${attachment.itemType}), skipping`,
                  'warn',
                );
                skippedAttachments.push({
                  key: attKey,
                  reason: `not an attachment (itemType: ${attachment.itemType})`,
                });
                continue;
              }
              reparentTargets.push({ key: attKey, attachment });
            }
          }

          // --- COMMIT: the new item and every re-parenting in ONE
          // transaction.
          //
          // This used to be `item.saveTx()` followed by one `saveTx()` per
          // attachment, so "failed" did not mean "nothing happened". An
          // attachment that failed to save left the new item standing, and
          // several attachments meant some were moved and some were not — a
          // state the response never described. The caller or the model then
          // retried the same create and got a SECOND copy of the item, which
          // is how a fix for a failure became a duplicate record.
          //
          // With one transaction a failure rolls the item back too, so
          // retrying is safe and cannot duplicate anything.
          await Zotero.DB.executeTransaction(async () => {
            await item.save();
            for (const target of reparentTargets) {
              target.attachment.parentKey = item.key;
              await target.attachment.save();
            }
          });

          const reparentedAttachments = reparentTargets.map(
            (target) => target.key,
          );

          ztoolkit.log(
            `[StreamableMCP] Created item ${item.key} (type: ${itemType}) with ${reparentedAttachments.length} re-parented attachment(s)${skippedAttachments.length > 0 ? `, ${skippedAttachments.length} skipped` : ''}`,
          );

          return {
            action: 'create',
            success: true,
            data: {
              itemKey: item.key,
              itemType,
              title: fields?.title || '',
              creatorsCount: creators?.length || 0,
              tagsCount: tags?.length || 0,
              reparentedAttachments,
              ...(skippedAttachments.length > 0 ? { skippedAttachments } : {}),
              dateCreated: item.dateAdded,
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Item created (key: ${item.key}, type: ${itemType})${reparentedAttachments.length > 0 ? `, ${reparentedAttachments.length} attachment(s) attached` : ''}${skippedAttachments.length > 0 ? `, ${skippedAttachments.length} attachmentKey(s) SKIPPED: ${skippedAttachments.map((entry) => `${entry.key} (${entry.reason})`).join('; ')}` : ''}`,
            },
          };
        }

        case 'reparent': {
          if (
            !attachmentKeys ||
            !Array.isArray(attachmentKeys) ||
            attachmentKeys.length === 0
          ) {
            throw new Error('attachmentKeys is required for reparent action');
          }
          if (!parentKey) {
            throw new Error('parentKey is required for reparent action');
          }

          // Verify parent exists
          const parentItem = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            parentKey,
          );
          if (!parentItem) {
            throw new Error(
              `Parent item not found in library ${libraryID}: ${parentKey}`,
            );
          }
          if (!parentItem.isRegularItem()) {
            throw new Error(
              `Parent ${parentKey} is not a regular item (type: ${parentItem.itemType})`,
            );
          }

          const results: Array<{
            key: string;
            success: boolean;
            error?: string;
          }> = [];
          for (const attKey of attachmentKeys) {
            try {
              const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
                libraryID,
                attKey,
              );
              if (!attachment) {
                results.push({
                  key: attKey,
                  success: false,
                  error: `Not found in library ${libraryID}`,
                });
                continue;
              }
              if (!attachment.isAttachment() && !attachment.isNote()) {
                results.push({
                  key: attKey,
                  success: false,
                  error: `Not an attachment or note (type: ${attachment.itemType})`,
                });
                continue;
              }
              attachment.parentKey = parentKey;
              await attachment.saveTx();
              results.push({ key: attKey, success: true });
              ztoolkit.log(
                `[StreamableMCP] Re-parented ${attKey} under ${parentKey}`,
              );
            } catch (attError) {
              results.push({
                key: attKey,
                success: false,
                error: String(attError),
              });
            }
          }

          const successCount = results.filter((r) => r.success).length;

          return {
            action: 'reparent',
            success: successCount > 0,
            data: {
              parentKey,
              results,
              successCount,
              totalCount: attachmentKeys.length,
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Re-parented ${successCount}/${attachmentKeys.length} item(s) under ${parentKey}`,
            },
          };
        }

        case 'import': {
          // write.allowFileImport 之前只是个设置页开关，这里才真正生效：
          // 关闭时不允许任何 MCP 调用把本机任意路径的文件拉进库里。
          if (!isFileImportAllowed()) {
            throw new Error(
              'File import from local paths is disabled. Enable "Allow File Import" in the Zotero MCP Plugin preferences to use write_item action "import".',
            );
          }
          if (!filePath || typeof filePath !== 'string') {
            throw new Error(
              'filePath is required for import action (absolute path to the file)',
            );
          }
          const importParentKey = parentItemKey || parentKey;
          if (!importParentKey) {
            throw new Error('parentItemKey is required for import action');
          }
          if (!(await IOUtils.exists(filePath))) {
            throw new Error(`File not found: ${filePath}`);
          }

          // Verify parent exists
          const parentItem = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            importParentKey,
          );
          if (!parentItem) {
            throw new Error(
              `Parent item not found in library ${libraryID}: ${importParentKey}`,
            );
          }
          if (!parentItem.isRegularItem()) {
            throw new Error(
              `Parent ${importParentKey} is not a regular item (type: ${parentItem.itemType}), cannot attach files`,
            );
          }

          // Import file as attachment
          const attachment = await Zotero.Attachments.importFromFile({
            file: filePath,
            parentItemID: parentItem.id,
            title:
              title || filePath.split(/[\\/]/).pop() || 'Imported Attachment',
          });

          ztoolkit.log(
            `[StreamableMCP] Imported file as attachment ${attachment.key} under ${importParentKey}`,
          );

          return {
            action: 'import',
            success: true,
            data: {
              attachmentKey: attachment.key,
              parentItemKey: importParentKey,
              filePath,
              title: attachment.getField('title'),
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `File imported as attachment (key: ${attachment.key}) under parent ${importParentKey}`,
            },
          };
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Use create, reparent, or import.`,
          );
      }
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Write item error: ${error}`, 'error');
      return {
        action,
        success: false,
        error: String(error),
        // Only `create` can promise this, and it can promise it absolutely:
        // the item and every re-parenting share one transaction. Saying so is
        // what makes a retry safe — the previous behaviour left the new item
        // behind on failure, so retrying produced a duplicate.
        ...(action === 'create'
          ? {
              applied: false,
              note: 'The item and its attachment re-parenting run in a single transaction, so this failure wrote nothing at all. No item was created; it is safe to fix the arguments and call again.',
            }
          : {}),
      };
    }
  }

  /**
   * Format tool result for MCP response with intelligent content type detection
   */
  private formatToolResult(result: any, toolName: string, args: any): any {
    // Check if client explicitly requested text format
    const requestedTextFormat = args?.format === 'text';

    // If result is already a string (text format), wrap it in MCP content format
    if (typeof result === 'string') {
      return {
        content: [
          {
            type: 'text',
            text: result,
          },
        ],
        isError: false,
      };
    }

    // For structured data, provide both JSON and formatted options
    if (typeof result === 'object' && result !== null) {
      // If explicitly requested text format, convert to readable text
      if (requestedTextFormat) {
        return {
          content: [
            {
              type: 'text',
              text: this.formatObjectAsText(result, toolName),
            },
          ],
          isError: false,
        };
      }

      // Default: provide structured JSON with formatted preview
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: false,
        // Include raw structured data for programmatic access
        _structuredData: result,
        _contentType: 'application/json',
      };
    }

    // Fallback for other types
    return {
      content: [
        {
          type: 'text',
          text: String(result),
        },
      ],
      isError: false,
    };
  }

  /**
   * Format object as human-readable text based on tool type
   */
  private formatObjectAsText(obj: any, toolName: string): string {
    switch (toolName) {
      case 'search_library':
        return this.formatSearchResultsAsText(obj);
      case 'get_annotations':
        return this.formatAnnotationsAsText(obj);
      default:
        return JSON.stringify(obj, null, 2);
    }
  }

  private formatSearchResultsAsText(searchResult: any): string {
    if (!searchResult.results || !Array.isArray(searchResult.results)) {
      return JSON.stringify(searchResult, null, 2);
    }

    const parts = [`SEARCH RESULTS (${searchResult.results.length} items):\n`];

    searchResult.results.forEach((item: any, index: number) => {
      parts.push(`${index + 1}. ${item.title || 'Untitled'}`);
      if (item.creators && item.creators.length > 0) {
        parts.push(
          `   Authors: ${item.creators.map((c: any) => c.name || `${c.firstName} ${c.lastName}`).join(', ')}`,
        );
      }
      if (item.date) {
        parts.push(`   Date: ${item.date}`);
      }
      if (item.itemKey) {
        parts.push(`   Key: ${item.itemKey}`);
      }
      parts.push('');
    });

    return parts.join('\n');
  }

  private formatAnnotationsAsText(annotationResult: any): string {
    if (!annotationResult.data || !Array.isArray(annotationResult.data)) {
      return JSON.stringify(annotationResult, null, 2);
    }

    const parts = [`ANNOTATIONS (${annotationResult.data.length} items):\n`];

    annotationResult.data.forEach((ann: any, index: number) => {
      parts.push(`${index + 1}. [${ann.type.toUpperCase()}] ${ann.content}`);
      if (ann.page) {
        parts.push(`   Page: ${ann.page}`);
      }
      if (ann.dateModified) {
        parts.push(`   Modified: ${ann.dateModified}`);
      }
      parts.push('');
    });

    return parts.join('\n');
  }

  /**
   * MCP 响应的唯一序列化出口。
   *
   * 所有分支（result、error.message、error.data、通知的空体）都必须经过这里，
   * 否则 privacy sanitizer 会被绕过。tools/call 抛出的异常信息里常带用户传入的
   * 文件路径（例如 write_item 的 "File not found: ..."），只清 result 是不够的。
   */
  private serializeResponse(response: MCPResponse): string {
    return JSON.stringify(sanitizeForPrivacy(response));
  }

  private createResponse(id: string | number | null, result: any): MCPResponse {
    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  }

  private createError(
    id: string | number | null,
    code: number,
    message: string,
    data?: any,
  ): MCPResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    };
  }

  private isNotificationRequest(request: MCPRequest): boolean {
    return (
      !Object.prototype.hasOwnProperty.call(request, 'id') ||
      request.id === undefined
    );
  }

  /**
   * Get server status and capabilities
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      serverInfo: this.serverInfo,
      protocolVersion: MCP_PROTOCOL_VERSION,
      // 与 initialize 协商和 HTTP MCP-Protocol-Version 校验用的是同一份列表。
      supportedProtocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
      supportedMethods: [
        'initialize',
        'initialized',
        'notifications/initialized',
        'tools/list',
        'tools/call',
        'resources/list',
        'prompts/list',
        'ping',
      ],
      // Derived from the same builder tools/list uses, so this can never
      // drift from what the server actually serves, and it follows the
      // semantic/write prefs instead of ignoring them.
      availableTools: this.getAvailableTools().map((t: any) => t.name),
      transport: {
        type: 'streamable-http',
        sessionMode: 'stateless',
        keepAliveSupported: false,
        maxConnections: 100,
      },
    };
  }

}
