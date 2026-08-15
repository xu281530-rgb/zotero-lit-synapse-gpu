import {
  handleGetLibraries,
  handleSearchLibraries,
  handleSearch,
  handleGetItem,
  handleGetCollections,
  handleSearchCollections,
  handleGetCollectionDetails,
  handleGetCollectionItems,
  handleGetSubcollections,
  handleGetItemAbstract,
  handleCreateCollection,
  handleUpdateCollection,
  handleDeleteCollection,
  handleAddItemsToCollection,
  handleRemoveItemsFromCollection,
} from './apiHandlers';
import { UnifiedContentExtractor } from './unifiedContentExtractor';
import { SmartAnnotationExtractor } from './smartAnnotationExtractor';
import { MCPSettingsService } from './mcpSettingsService';
import {
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  describeFullTextAvailability,
  describePageFullTextGaps,
  emptyFullTextCoverage,
  fullTextAvailabilityFromState,
  getSemanticSearchService,
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
  resolveHybridKeywords,
  resolveKeywordProvenance,
  runHybridSearch,
  runWithTimeout,
  type HybridSearchOptions,
  type KeywordSearchItem,
  type SemanticSearchItem,
} from './hybridSearch';
import {
  getHybridSearchSettings,
  resolveResultCap,
  resolveScoreFloor,
} from './hybridSearchSettings';
import { expandChunkContext, runDocumentDeepDive } from './documentDeepDive';
import { runLexicalSearch } from './lexicalSearch';
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
  HybridSearchPageStore,
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
import { sanitizeForPrivacy, scrubPathFields } from '../utils/privacy';
import { config } from '../../package.json';

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
  sessionId?: string;
}

export interface MCPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

const PREF_WRITE_ENABLED = 'extensions.zotero.zotero-mcp-plugin.write.enabled';
const PREF_WRITE_CONFIRM = 'extensions.zotero.zotero-mcp-plugin.write.confirmBeforeMutation';
const PREF_ALLOW_FILE_IMPORT = 'extensions.zotero.zotero-mcp-plugin.write.allowFileImport';

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
]);


/**
 * Trim a fused row to what a cached page can ever need.
 *
 * A cached ranking holds every document above the threshold, and each one
 * arrives carrying up to three full passages. Only the first two, truncated,
 * are ever shown, so keeping the rest would be holding a slice of the library's
 * text in memory for the duration of a paging session.
 */
function trimCachedEvidence(row: Record<string, any>): Record<string, any> {
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
  return `collections:${scope.collections.map((c) => c.key).sort().join(',')}`;
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
  appliedMinScore: number;
  libraryID: number;
  /** True when a retrieval branch failed or timed out during this search. */
  branchFailed: boolean;
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
    ztoolkit.log(`[StreamableMCP] Blocked ${toolName}: write operations disabled`, 'warn');
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

/** 为确认框生成一句人类可读的操作摘要，尽量不泄漏大段内容。 */
function describeMutation(toolName: string, args: any): string {
  const parts: string[] = [];
  if (args?.action) parts.push(`action: ${String(args.action)}`);
  if (args?.itemKey) parts.push(`item: ${String(args.itemKey)}`);
  if (args?.noteKey) parts.push(`note: ${String(args.noteKey)}`);
  if (args?.parentKey) parts.push(`parent: ${String(args.parentKey)}`);
  if (args?.collectionKey) parts.push(`collection: ${String(args.collectionKey)}`);
  if (args?.name) parts.push(`name: ${String(args.name)}`);
  if (Array.isArray(args?.itemKeys)) parts.push(`items: ${args.itemKeys.length}`);
  if (Array.isArray(args?.tags)) parts.push(`tags: ${args.tags.length}`);
  return parts.length > 0 ? parts.join(', ') : 'no additional parameters';
}

/**
 * `write.confirmBeforeMutation` 的实际执行点。
 *
 * 之前这个偏好只存在于设置页，勾不勾都不影响任何写操作。这里在真正落库前
 * 弹一个模态确认框；用户拒绝或没有可用主窗口时抛错，让工具调用失败而不是
 * 无声地改库。
 */
async function assertMutationConfirmed(toolName: string, args: any): Promise<void> {
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
    ztoolkit.log(`[StreamableMCP] Mutation confirmation dialog failed: ${error}`, 'error');
    throw new Error(
      `Could not display the write confirmation dialog required by write.confirmBeforeMutation: ${error}`,
    );
  }

  if (!approved) {
    ztoolkit.log(`[StreamableMCP] User declined mutation: ${toolName}`, 'warn');
    throw new Error(`The user declined the requested ${toolName} operation.`);
  }
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
  private clientSessions: Map<string, { initTime: Date; lastActivity: Date; clientInfo?: any }> = new Map();
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

  constructor() {
    // No initialization needed - using direct function calls
  }

  clearSemanticState(): void {
    this.hybridPages.clear();
    this.similarPages.clear();
    if (this.hybridPages.size !== 0 || this.similarPages.size !== 0) {
      throw new Error('Semantic pagination state could not be cleared');
    }
  }

  /**
   * Handle incoming MCP requests and return HTTP response
   */
  async handleMCPRequest(
    requestBody: string,
    requestId = 0,
  ): Promise<{ status: number; statusText: string; headers: any; body: string }> {
    let parsedRequest: unknown;

    try {
      parsedRequest = JSON.parse(requestBody);
    } catch (error) {
      // 走到这里说明收到的确实不是合法 JSON。把长度和首尾片段一起记下来，
      // 才能区分「客户端发了坏数据」和「传输层把请求体截断了」——后者是
      // 之前 -32700 的真正来源，现在由 httpServer 在分帧阶段就拦下。
      const head = requestBody.slice(0, 60).replace(/\s+/g, ' ');
      const tail = requestBody.slice(-30).replace(/\s+/g, ' ');
      ztoolkit.log(
        `[StreamableMCP] #${requestId} Parse error: ${error} (body ${requestBody.length} chars, head="${head}", tail="${tail}")`,
        'error',
      );

      const errorResponse: MCPResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error'
        }
      };

      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: this.serializeResponse(errorResponse)
      };
    }

    try {
      if (Array.isArray(parsedRequest)) {
        const batchError = this.createError(null, -32600, 'Invalid Request: batch requests are not supported');
        return {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: this.serializeResponse(batchError)
        };
      }

      if (!parsedRequest || typeof parsedRequest !== 'object') {
        const invalidRequest = this.createError(null, -32600, 'Invalid Request');
        return {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: this.serializeResponse(invalidRequest)
        };
      }

      const request = parsedRequest as MCPRequest;
      if (typeof request.method !== 'string' || !request.method.trim()) {
        const invalidRequest = this.createError(null, -32600, 'Invalid Request: method is required');
        return {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: this.serializeResponse(invalidRequest)
        };
      }

      ztoolkit.log(
        `[StreamableMCP] #${requestId} received method=${request.method} id=${JSON.stringify(request.id ?? null)}`,
      );

      const response = await this.processRequest(request);

      if (response === null) {
        return {
          status: 202,
          statusText: "Accepted",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: ''
        };
      }

      const status = this.getHttpStatusForResponse(response);
      ztoolkit.log(
        `[StreamableMCP] #${requestId} responding to ${request.method} id=${JSON.stringify(response.id ?? null)} status=${status}${response.error ? ` error=${response.error.code}` : ''}`,
      );
      return {
        status,
        statusText: status === 400 ? "Bad Request" : "OK",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: this.serializeResponse(response)
      };
      
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] #${requestId} Error handling request: ${error}`, 'error');

      const errorResponse: MCPResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: 'Internal error'
        }
      };
      
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: this.serializeResponse(errorResponse)
      };
    }
  }

  /**
   * Process individual MCP requests
   */
  private async processRequest(request: MCPRequest): Promise<MCPResponse | null> {
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
            ztoolkit.log(`[StreamableMCP] Ignoring unsupported notification: ${request.method}`);
            return null;
          }
          return this.createError(null, -32600, `Invalid Request: id is required for method ${request.method}`);
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
          return this.createError(request.id ?? null, -32601, `Method not found: ${request.method}`);
      }
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Error processing ${request.method}: ${error}`);
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
    if (requestedVersion !== undefined && typeof requestedVersion !== 'string') {
      return this.createError(
        request.id ?? null,
        -32602,
        'Invalid params: protocolVersion must be a string',
        { supported: SUPPORTED_MCP_PROTOCOL_VERSIONS },
      );
    }

    const negotiatedVersion = negotiateProtocolVersion(requestedVersion);
    if (requestedVersion !== undefined && negotiatedVersion !== requestedVersion) {
      ztoolkit.log(
        `[StreamableMCP] Client requested unsupported protocol version ${requestedVersion}; offering ${negotiatedVersion} instead`,
        'warn',
      );
    }

    // Extract client info from initialize request
    const clientInfo = request.params?.clientInfo || {};
    const sessionId = this.generateSessionId();
    
    // Store session info
    this.clientSessions.set(sessionId, {
      initTime: new Date(),
      lastActivity: new Date(),
      clientInfo
    });
    
    ztoolkit.log(`[StreamableMCP] Client initialized with session: ${sessionId}, client: ${clientInfo.name || 'unknown'}, protocol: ${negotiatedVersion}`);
    
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

STAGE 0 - decide where to look (get_collections, only when it helps):
0. When the question is plainly confined to part of the user's library, call get_collections first and read their real folder names, then pass the relevant ones to hybrid_search as collectionKeys. The scope is applied before scoring, so it removes work rather than filtering results. Decide per collection: include what the user named, include what obviously relates to the question, exclude only what obviously does not, and INCLUDE anything whose subject you cannot determine — "待读", "综述", "课题资料", "论文写作" and similar names say nothing about content and frequently hold the most relevant papers. If most names are opaque to you, or the question spans fields, skip this stage entirely and search the whole library. Scanning extra documents costs a little time; missing one costs the user the paper.

STAGE 1 - find candidates (hybrid_search):
1. Identify which discipline and sub-field the user's question belongs to, and adopt that field's expert role.
2. From that expert perspective, write ONE natural-language semantic query stating the real research intent, plus professional keywords: terms of art, synonyms, abbreviations and mechanism words, in BOTH Chinese and English regardless of the language the user asked in - the library is bilingual and this stage searches all of it. Declare the field in the domain argument and the perspective in the expertRole argument - without both, the call is reported as keywordSource "fallback" even if your keywords were good.
3. Call hybrid_search. It runs metadata keyword retrieval and vector semantic retrieval over the whole library and fuses them into one normalized 0-1 relevance score.
4. Documents below the user's relevance threshold are discarded by the server. What survives is ranked, and the response carries ONE PAGE of that ranking - topK is the page size, a CEILING and never a target. If nothing comes back, say the library has nothing relevant.
5. The pagination block tells you the whole picture: appliedMinScore (the floor that was applied), totalRelevant (how many documents cleared it), returned, hasMore, nextCursor. Filtering happens before paging, so no page can contain a document below the threshold and a short final page is never padded. When hasMore is true and the bottom of the page still looks relevant - or the user asked for a comprehensive sweep or a literature review - call hybrid_search again with cursor set to nextCursor and every other argument unchanged; that windows the SAME ranking instead of searching again, so pages never duplicate, drop or reorder documents. Changing query, keywords, domain, expertRole or minScore alongside a cursor is rejected: that is a new search, so start one. Never lower minScore to fill a page, and do not page through everything by reflex - stop when the question is answered.
6. What comes back per document is a LIGHTWEIGHT candidate row: title, creators, year, venue, the language the document is written in, the fused score, which of your keywords and which fields matched, and a short snippet from its best-matching passages. Abstracts are deliberately NOT included - they are still searched server-side, they are just not shipped back, because most candidates never need to be read.

STAGE 2 - triage, and read an abstract only where you need one (get_item_abstract):
7. Judge each candidate from its stage-1 row alone: title, rank, fused score, which keywords hit which fields, and the evidence snippet. When that is already enough to see a paper is off-topic, discard it and never fetch its abstract.
8. Only for a candidate you are seriously considering going deeper on, call get_item_abstract with that ONE itemKey. It is an on-demand tool, NOT a batch step that follows hybrid_search: if 3 of 20 candidates are worth pursuing, you fetch 3 abstracts, not 20.
9. If the user only asked which literature is relevant, answer from the stage-1 rows plus at most a few abstracts, and stop here.

STAGE 3 - dig into one paper (search_fulltext, one document per call):
10. Having read that paper's abstract, redo the expert judgement FOR THAT PAPER from "user question + this paper's title + its abstract + its stage-1 evidence": identify its study object, material system, experimental method, variables, mechanism, terminology and abbreviations.
11. Re-fit domain and expertRole to what THIS paper actually is. They may well differ from stage 1 and should: a library-level "materials science / solidification metallurgy" becomes "physical metallurgy / crystal plasticity and deformation mechanisms" once the abstract shows the paper is really about dislocations, stacking faults and micro-twinning. Decide that from the abstract you just read; never carry the stage-1 pair over out of inertia.
12. Write query and keywords SPECIFIC TO THAT PAPER, and write the keywords in the LANGUAGE THAT PAPER IS WRITTEN IN - one language, not both. This stage searches inside a single document, so probes in the other language match nothing and only dilute the ranking. The candidate row carries a language hint and the abstract confirms it; a Chinese paper takes Chinese terms of art, an English paper takes English ones. Keep the query itself bilingual only if the paper itself mixes languages.
13. Call search_fulltext with that one itemKey, plus the re-fitted domain and expertRole. It runs keyword matching and semantic retrieval across that paper's passages, fuses them with the same scoring, discards passages below the threshold and returns at most the user's configured number of passages.
14. Read those passages. If the evidence answers the question, STOP. Only if a passage is missing its cause, its consequence, its experimental conditions or its mechanism context, call search_fulltext again with chunkIds set to that passage's chunkId to pull in its immediate neighbours, within the user's radius limit. Never request neighbouring text by default.

Around 5-12 keywords is the recommendation, 1 to ${MAX_HYBRID_KEYWORDS} is accepted, at both stage 1 and stage 3. If you omit keywords the server falls back to mechanical tokenization, returns keywordSource "fallback" with degraded: true, and you should redo that call ONCE with proper terms. Never perform unscoped whole-library full-text search.`,
    });
  }

  private generateSessionId(): string {
    return 'mcp-session-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 9);
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
    return this.createResponse(request.id ?? null, { tools: this.getAvailableTools() });
  }

  /**
   * The tools this server actually serves right now, after the same pref
   * filtering tools/list applies.
   *
   * getStatus() used to carry a second, hand-written copy of this list. It
   * drifted — the collection tools were added here and never there, so
   * /mcp/status under-reported by six — and it was blind to both prefs below,
   * which is the worse half: with write disabled it still advertised the
   * write_* tools that tools/list was hiding, i.e. it claimed capabilities the
   * server would refuse. One source of truth, both callers.
   */
  private getAvailableTools(): any[] {
    const tools = [
      {
        name: 'hybrid_search',
        description: [
          'DEFAULT FIRST STEP for locating literature. Runs Zotero metadata/field keyword retrieval and semantic vector retrieval in parallel, then fuses them into one normalized 0-1 relevance score: each branch is normalised on its own scale, the stronger branch sets the score, and the weaker branch adds a bounded agreement bonus, so corroboration can only lift a document and never dilute it. Reciprocal Rank Fusion is computed too, but only as the tie-break between candidates whose fused scores are equal — rrfK tunes that tie-break, not the ranking. It does not scan full document text.',
          '',
          'The library is bilingual, so every call must retrieve Chinese AND English literature, no matter which language the user asked in. Do NOT translate the question into a single language and do NOT restrict the search to the language of the question. You (the calling AI) are responsible for the query rewrite: this tool never calls an LLM of its own.',
          '',
          'BEFORE writing any argument, run this analysis on the user question — it is the difference between a good and a useless search, and no part of it happens server-side:',
          'A. Classify the question: which discipline, and which specific sub-field or research direction inside it?',
          'B. Adopt that expert role for the rest of this call — reason as a specialist in that sub-field would, using the vocabulary of its literature.',
          'C. Determine the real research intent: which mechanism, property, process, material system or quantitative relationship is actually being asked about, including what the user implied but did not say.',
          'D. Only then derive query and keywords FROM that domain analysis, not from the surface wording of the question.',
          '',
          'Build the arguments like this:',
          '1. query — one complete natural-language sentence expressing the real information need as an expert in that field would state it, used verbatim as the embedding input for cross-lingual semantic search. Do not reduce it to loose tokens. Writing it as an English phrasing followed by " / " and the Chinese phrasing is recommended, so the embedding sees both surface forms.',
          `2. keywords — the terms a specialist in that sub-field would actually search on, covering BOTH Chinese and English: the core concepts, the mechanism and governing variables behind the question, standard technical translations, accepted synonyms and variant phrasings, the field's abbreviations, and closely coupled concepts with a clear professional link to the intent. For best results, providing about 5-12 relevant Chinese and/or English keywords is recommended; this is guidance, not a constraint — any number from 1 to ${MAX_HYBRID_KEYWORDS} is accepted. All of them are matched in a single pass over the candidate records (title, abstract, creator, publication title, tags), then scored by term specificity, field weight and how many distinct keywords each record matched, so short exact terms work far better than long sentences.`,
          '3. Do NOT pad the list. Every keyword must be defensible as a term of art tied to the research intent; generic, weakly related or category-level words dilute keyword-coverage scoring and push the right papers down the ranking.',
          '',
          'Worked example — user asks "温度梯度如何影响定向凝固中的柱状晶转变？":',
          '  A/B/C: materials science → solidification / microstructure formation; reasoning as a solidification specialist, the real intent is how the thermal gradient G, together with the growth rate R, governs the columnar-to-equiaxed transition — i.e. G-R processing maps and nucleation ahead of the growth front.',
          '  query: "Effects of temperature gradient on columnar-to-equiaxed transition during directional solidification / 温度梯度对定向凝固柱状晶-等轴晶转变的影响"',
          '  keywords: ["温度梯度", "定向凝固", "柱状晶", "等轴晶", "柱状晶-等轴晶转变", "凝固速率", "temperature gradient", "directional solidification", "columnar grain", "equiaxed grain", "columnar-to-equiaxed transition", "CET", "growth rate"]',
          '  Note what came from domain knowledge rather than from the question: the CET abbreviation, growth rate / 凝固速率 as the co-governing variable, and the columnar/equiaxed grain pair. Note also what was left out: "材料", "实验", "influence factors" — true of the question but too generic to discriminate between papers.',
          '',
          'If you do not pass keywords - or pass an array that is empty after blank entries are trimmed - the server falls back to mechanically tokenizing the query, returns keywordSource "fallback", a keywordFallbackReason naming which of the two happened, and a warning stating the keywords were NOT produced by domain-expert analysis. That path exists only so the call still runs, and it does return a real ranking. Redo the search ONCE with proper keywords; if you have already retried, keep the results rather than calling a third time.',
          '',
          'Leave language at its "all" default so retrieval stays genuinely cross-lingual; the other language values only narrow recall.',
          '',
          'SCORING: both branches are normalized to 0-1 and fused into one relevance score by taking the stronger branch and adding a bounded share of the weaker one, so a second, weaker hit can never push a document below what it scored on its own. Documents below the user-configured threshold are discarded by the server, and at most the user-configured number of documents is returned. That number is an upper bound, NOT a target: a weakly related paper is never added to make the list longer.',
          '',
          'WHAT YOU GET BACK: a LIGHTWEIGHT candidate row per surviving document — itemKey, title, creators, year, venue, the language it is written in, the fused score, which of your keywords matched which fields, and a short snippet from its best-matching passages. That is a shortlist to triage, not a reading pile.',
          '',
          'ABSTRACTS ARE NOT RETURNED, on purpose. They are still indexed, still searched by the keyword branch, and still part of what produced this ranking — they are simply not shipped back, because most candidates never need to be read in full. Judge each row from its title, score, matched keywords and snippet. Only for a paper you are seriously considering going deeper on, call get_item_abstract with that one itemKey. Reading every candidate\'s abstract is the exact behaviour this design removes: 20 candidates does not mean 20 abstracts.',
          '',
          'SCOPE: by default this searches the entire library. When the user question is clearly confined to part of their collection, call get_collections FIRST, read the real folder names, and pass the relevant ones as collectionKeys — the scope is applied before scoring, so it cuts the work rather than filtering the results afterwards. Judge each collection by what it plainly is: include what the user named, include what obviously relates, exclude only what obviously does not, and INCLUDE anything you cannot classify. Personal folder names carry no subject information — "待读", "综述", "课题资料", "论文写作" — yet often hold exactly the papers that matter, so uncertainty means include, never exclude. When most of the structure is opaque to you, or the question spans several fields, skip collectionKeys and search everything: a scope that misses a paper is a worse outcome than a scan that costs a little more.',
          '',
          'PAGING: topK is the size of ONE page, not the depth of the search. The response carries a pagination block: appliedMinScore (the floor these results passed), totalRelevant (how many documents cleared that floor — often more than one page), returned, hasMore and nextCursor. Filtering happens BEFORE paging, so a later page can never contain a document below the threshold, and a short last page is never padded out. To read further, call hybrid_search again with cursor set to nextCursor and everything else unchanged; that returns the next window of the SAME ranking rather than a fresh search. Page on when the bottom of a page is still relevant, or when the user asked for a comprehensive sweep or a literature review — not by reflex. Never lower minScore to make more results appear.',
          '',
          'THEN: having read one paper\'s abstract, redo the expert analysis for THAT paper — re-fit domain and expertRole to what it actually studies, write a query and keywords out of its own subject matter, in the language that paper is written in — and call search_fulltext with its single itemKey. Answer from the stage-1 rows alone when the user only asks which literature is relevant.',
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Complete natural-language sentence describing the information need as a specialist in the question\'s sub-field would state it, written after you have classified the discipline and worked out the real research intent. Embedded as-is for cross-lingual semantic search, so it must read as prose, not a token list. Include both an English and a Chinese phrasing (separated by " / ") so the embedding covers both.'
            },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: MAX_SUPPLIED_KEYWORDS,
              description: `Lexical probes for the keyword branch, derived from your domain analysis of the question rather than from its wording: the core concepts and mechanism, precise Chinese AND English terms of art, standard technical translations, accepted synonyms, field abbreviations, and closely coupled concepts with a clear professional link to the research intent. For best results, it is recommended to provide 5-12 relevant Chinese and/or English keywords. Fewer or more keywords are still allowed within the implemented input limit of 1 to ${MAX_HYBRID_KEYWORDS} entries. Always supply both scripts regardless of the language the user asked in. Do not pad with generic or weakly related words — keyword coverage is part of the score, so filler actively hurts ranking. All keywords are matched together in one pass over title, abstract, creator, publicationTitle and tags, and ranked by term specificity, field weight and keyword coverage, so a broad word cannot outrank a discriminative phrase. Omitting this makes the server fall back to mechanically splitting the query: it can only probe the language the user typed in, is scored at a lower weight, and the response is flagged with keywordSource "fallback" plus an explicit warning.`
            },
            domain: {
              type: 'string',
              description: 'The discipline and specific sub-field you classified the question into before writing the query, e.g. "materials science / solidification microstructure". Required, together with expertRole, for the call to be recorded as domain-expert retrieval; without both, the response comes back with keywordSource "fallback" and degraded: true even when your keywords were good.'
            },
            expertRole: {
              type: 'string',
              description: 'The expert perspective you adopted for this call, e.g. "solidification processing specialist". Required together with domain.'
            },
            topK: {
              type: 'number',
              description: 'PAGE SIZE: how many documents one response carries. The user configures the real maximum; this can only ask for FEWER. It is a ceiling and never a quota to fill — and it no longer decides how far the ranking goes, because anything past it is reachable through cursor rather than lost.'
            },
            collectionKeys: {
              type: 'array',
              items: { type: 'string' },
              description: 'Restrict the search to these Zotero collections (keys from get_collections), their subcollections included. The restriction is applied BEFORE scoring: the keyword branch only reads items inside the scope and the vector scan only computes similarity for their chunks, so this is a real reduction in work rather than a filter over whole-library results. Omit it to search everything. SELECTION RULE — include a collection when the user named it, when its subject plainly relates to the question, AND when you cannot tell what it contains: names like "综述", "待读", "课题资料", "论文写作", "New Folder" carry no subject information but routinely hold the most relevant papers, so they belong IN the scope. Exclude only what is plainly unrelated. If most collections are unreadable to you, or the question spans fields, omit this argument and search the whole library. Missing a paper is a worse failure than scanning extra ones.'
            },
            uncertainCollectionKeys: {
              type: 'array',
              items: { type: 'string' },
              description: 'Of the collectionKeys you passed, which ones you included because you could NOT judge their subject rather than because you judged them relevant. Declaring them changes nothing about the search; it is reported back in metadata so the user can see which parts of the scope were guesses. Leave it out when every choice was a judgement.'
            },
            cursor: {
              type: 'string',
              description: 'Continue a previous hybrid_search: pass the nextCursor it returned, exactly as given. The cursor names one already-ranked, already-threshold-filtered result set, and returns the next page of THAT set — it does not re-run retrieval, so pages cannot duplicate, drop or reorder documents. Send it with query, keywords, domain, expertRole and minScore either unchanged or omitted; changing any of them is a different search and is rejected. Omit cursor to start a new search.'
            },
            minScore: {
              type: 'number',
              description: 'Relevance floor 0-1 applied to the fused score. May only be STRICTER than the user setting; a lower value is raised back to the user threshold. Documents below it are discarded and are never padded back in.'
            },
            language: {
              type: 'string',
              enum: ['zh', 'en', 'all', 'auto'],
              description: 'Semantic branch language filter. Keep the "all" default for genuinely cross-lingual recall; "zh"/"en" restrict the index to that language and "auto" restricts it to the detected query language, both of which drop literature written in the other language. Only set this when the user explicitly asks for one language.'
            },
            rrfK: {
              type: 'number',
              description: 'Rank constant for the Reciprocal Rank Fusion TIE-BREAK (default: 60). Ranking is decided by the fused 0-1 relevance score; RRF only orders candidates whose fused scores are equal, so changing this rarely changes anything.'
            },
            keywordWeight: {
              type: 'number',
              description: 'Non-negative keyword branch weight (default: 1)'
            },
            semanticWeight: {
              type: 'number',
              description: 'Non-negative semantic branch weight (default: 1)'
            },
            libraryID: {
              type: 'number',
              description: 'Zotero library ID used by both keyword and semantic retrieval'
            },
          },
          required: ['query']
        }
      },
      {
        name: 'get_libraries',
        description: 'List all Zotero libraries available in the current client. Returns minimal library metadata for each library as a paginated array.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum results to return' },
            offset: { type: 'number', description: 'Pagination offset' },
          },
        },
      },
      {
        name: 'search_library',
        description: 'Structured Zotero metadata/field search for explicit title, author, year, item type, or other field constraints. For general literature discovery, use hybrid_search first. Attachment full-text search is not available through this tool. To find standalone PDFs without metadata, use itemType="attachment" with includeAttachments="true".',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            q: { type: 'string', description: 'General search query' },
            title: { type: 'string', description: 'Title search' },
            titleOperator: {
              type: 'string',
              enum: ['contains', 'exact', 'startsWith', 'endsWith', 'regex'],
              description: 'Title search operator'
            },
            yearRange: { type: 'string', description: 'Year range (e.g., "2020-2023")' },
            itemType: {
              type: 'string',
              description: 'Filter by item type (e.g., "attachment" to list standalone files like PDFs imported without metadata, "journalArticle", "book", etc.)'
            },
            includeAttachments: {
              type: 'string',
              enum: ['true', 'false'],
              description: 'Include standalone attachment items (e.g., PDFs without parent item) in results. Must be "true" when itemType is "attachment". Default: false.'
            },
            mode: {
              type: 'string',
              enum: ['minimal', 'preview', 'standard', 'complete'],
              description: 'Processing mode: minimal (30 results), preview (100), standard (adaptive), complete (500+). Uses user default if not specified.'
            },
            relevanceScoring: { type: 'boolean', description: 'Enable relevance scoring' },
            sort: {
              type: 'string',
              enum: ['relevance', 'date', 'title', 'year'],
              description: 'Sort order'
            },
            limit: { type: 'number', description: 'Maximum results to return (overrides mode default)' },
            offset: { type: 'number', description: 'Pagination offset' },
          },
        },
      },
      {
        name: 'search_libraries',
        description: 'Search libraries by name',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Library name search query' },
            limit: { type: 'number', description: 'Maximum results to return' },
            offset: { type: 'number', description: 'Pagination offset' },
          },
          required: ['q'],
        },
      },
      {
        name: 'search_annotations',
        description: 'Search and filter annotations (highlights, notes, comments) by query, colors, or tags. Returns user\'s personal research notes with relevance scoring. Preserve exact wording when quoting.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            q: { type: 'string', description: 'Search query (optional if colors or tags provided)' },
            itemKeys: {
              type: 'array',
              items: { type: 'string' },
              description: 'Limit search to specific items'
            },
            types: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['note', 'highlight', 'annotation', 'ink', 'text', 'image']
              },
              description: 'Types of annotations to search'
            },
            colors: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by colors. Use hex codes (#ffd400) or names (yellow, red, green, blue, purple, orange). Common mappings: yellow=question, red=error/important, green=agree, blue=info, purple=definition'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by tags attached to annotations'
            },
            mode: {
              type: 'string',
              enum: ['standard', 'preview', 'complete', 'minimal'],
              description: 'Content processing mode (uses user setting default if not specified)'
            },
            maxTokens: {
              type: 'number',
              description: 'Token budget (uses user setting default if not specified)'
            },
            minRelevance: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              default: 0.1,
              description: 'Minimum relevance threshold (only applies when q is provided)'
            },
            limit: { type: 'number', default: 15, description: 'Maximum results' },
            offset: { type: 'number', default: 0, description: 'Pagination offset' }
          },
          description: 'Requires at least one of: q (query), colors, or tags'
        },
      },
      {
        name: 'get_item_details',
        description: 'Get detailed bibliographic metadata for a specific item (title, authors, dates, identifiers, attachments, notes, tags). Use get_content for full text. Suitable for generating citations and references.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            itemKey: { type: 'string', description: 'Unique item key' },
            mode: {
              type: 'string',
              enum: ['minimal', 'preview', 'standard', 'complete'],
              description: 'Processing mode: minimal (basic info), preview (key fields), standard (comprehensive), complete (all fields). Uses user default if not specified.'
            },
          },
          required: ['itemKey'],
        },
      },
      {
        name: 'get_annotations',
        description: 'Get annotations and notes for specific items with color/tag filtering. REQUIRED: provide one of itemKey, annotationId, or annotationIds (use search_library first to find the itemKey; use search_annotations to search by colors/tags across the library). Returns user\'s personal highlights and comments from PDFs. Preserve exact wording when quoting.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            itemKey: { type: 'string', description: 'Get all annotations for this item' },
            annotationId: { type: 'string', description: 'Get specific annotation by ID' },
            annotationIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Get multiple annotations by IDs'
            },
            types: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['note', 'highlight', 'annotation', 'ink', 'text', 'image']
              },
              default: ['note', 'highlight', 'annotation'],
              description: 'Types of annotations to include'
            },
            colors: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by colors. Use hex codes (#ffd400) or names (yellow, red, green, blue, purple, orange). Example: ["yellow", "red"] to get question and error annotations'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by tags attached to annotations'
            },
            mode: {
              type: 'string',
              enum: ['standard', 'preview', 'complete', 'minimal'],
              description: 'Content processing mode (uses user setting default if not specified)'
            },
            maxTokens: {
              type: 'number',
              description: 'Token budget (uses user setting default if not specified)'
            },
            limit: { type: 'number', default: 20, description: 'Maximum results' },
            offset: { type: 'number', default: 0, description: 'Pagination offset' }
          },
          description: 'Requires either itemKey, annotationId, or annotationIds parameter'
        },
      },
      {
        name: 'get_content',
        description: 'Get full-text content from PDFs, attachments, notes, and abstracts. May contain OCR artifacts. When user asks for complete text, provide it without summarization.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            itemKey: { type: 'string', description: 'Item key to get all content from this item' },
            attachmentKey: { type: 'string', description: 'Attachment key to get content from specific attachment' },
            mode: {
              type: 'string',
              enum: ['minimal', 'preview', 'standard', 'complete'],
              description: 'Content processing mode: minimal (500 chars, fastest), preview (1.5K chars, quick scan), standard (3K chars, balanced), complete (unlimited, complete content). Uses user default if not specified.'
            },
            include: {
              type: 'object',
              properties: {
                pdf: { type: 'boolean', default: true, description: 'Include PDF attachments content' },
                attachments: { type: 'boolean', default: true, description: 'Include other attachments content' },
                notes: { type: 'boolean', default: true, description: 'Include notes content' },
                abstract: { type: 'boolean', default: true, description: 'Include abstract' },
                webpage: { type: 'boolean', default: false, description: 'Include webpage snapshots (auto-enabled in standard/complete modes)' }
              },
              description: 'Content types to include (only applies to itemKey)'
            },
            contentControl: {
              type: 'object',
              properties: {
                preserveOriginal: { type: 'boolean', default: true, description: 'Always preserve original text structure when processing' },
                allowExtended: { type: 'boolean', default: false, description: 'Allow retrieving more content than mode default when important' },
                expandIfImportant: { type: 'boolean', default: false, description: 'Expand content length for high-importance content' },
                maxContentLength: { type: 'number', description: 'Override maximum content length for this request' },
                prioritizeCompleteness: { type: 'boolean', default: false, description: 'Prioritize complete sentences/paragraphs over strict length limits' },
                standardExpansion: {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean', default: false, description: 'Enable standard content expansion' },
                    trigger: { 
                      type: 'string', 
                      enum: ['high_importance', 'user_query', 'context_needed'],
                      default: 'high_importance',
                      description: 'Trigger condition for standard expansion'
                    },
                    maxExpansionRatio: { type: 'number', default: 2.0, minimum: 1.0, maximum: 10.0, description: 'Maximum expansion ratio (1.0 = no expansion, 2.0 = double)' }
                  },
                  description: 'Smart expansion configuration'
                }
              },
              description: 'Advanced content control parameters to override mode defaults'
            },
            format: { 
              type: 'string', 
              enum: ['json', 'text'],
              default: 'json',
              description: 'Output format: json (structured with metadata) or text (plain text)' 
            }
          },
          description: 'Requires either itemKey or attachmentKey parameter'
        },
      },
      {
        name: 'get_collections',
        description: 'Get collections in the library. By default returns a flat, paginated list of top-level collections. Use recursive=true to retrieve the complete nested collection tree (all levels) in one call. Use parentCollection to scope to a specific parent\'s direct children.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            mode: {
              type: 'string',
              enum: ['minimal', 'preview', 'standard', 'complete'],
              description: 'Processing mode: minimal (20 collections), preview (50), standard (100), complete (500+). Uses user default if not specified. Ignored when recursive=true.'
            },
            limit: { type: 'number', description: 'Maximum results to return (overrides mode default). Ignored when recursive=true.' },
            offset: { type: 'number', description: 'Pagination offset. Ignored when recursive=true.' },
            recursive: {
              type: 'boolean',
              description: 'When true, recursively return the full nested collection tree. Each collection includes a subcollections array of its children. Pagination is ignored.'
            },
            parentCollection: {
              type: 'string',
              description: 'Key of a parent collection. When provided, returns direct children of that collection instead of top-level collections.'
            },
          },
        },
      },
      {
        name: 'search_collections',
        description: 'Search collections by name',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            q: { type: 'string', description: 'Collection name search query' },
            limit: { type: 'number', description: 'Maximum results to return' },
          },
        },
      },
      {
        name: 'get_collection_details',
        description: 'Get detailed information about a specific collection',
        inputSchema: {
          type: 'object',
          properties: {
            collectionKey: { type: 'string', description: 'Collection key' },
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
          },
          required: ['collectionKey'],
        },
      },
      {
        name: 'get_collection_items',
        description: 'Get items in a specific collection',
        inputSchema: {
          type: 'object',
          properties: {
            collectionKey: { type: 'string', description: 'Collection key' },
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            limit: { type: 'number', description: 'Maximum results to return' },
            offset: { type: 'number', description: 'Pagination offset' },
          },
          required: ['collectionKey'],
        },
      },
      {
        name: 'get_subcollections',
        description: 'Get subcollections (child collections) of a specific collection. Use recursive=true to retrieve the full nested hierarchy of all descendant collections.',
        inputSchema: {
          type: 'object',
          properties: {
            collectionKey: { type: 'string', description: 'Parent collection key' },
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            limit: { type: 'number', description: 'Maximum results to return (default: 100). Ignored when recursive=true.' },
            offset: { type: 'number', description: 'Pagination offset (default: 0). Ignored when recursive=true.' },
            recursive: { 
              type: 'boolean', 
              description: 'When true, recursively return all descendant subcollections as a nested tree (default: false).' 
            },
          },
          required: ['collectionKey'],
        },
      },
      {
        name: 'create_collection',
        description: 'Create a new collection in the library. Optionally nest it under a parent collection.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            name: { type: 'string', description: 'Name of the new collection' },
            parentCollection: {
              type: 'string',
              description: 'Key of the parent collection. If omitted, creates a top-level collection.'
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'update_collection',
        description: 'Rename or move an existing collection. Provide name to rename, parentCollection to move (empty string moves to top level).',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            collectionKey: { type: 'string', description: 'Key of the collection to update' },
            name: { type: 'string', description: 'New name for the collection' },
            parentCollection: {
              type: 'string',
              description: 'Key of the new parent collection. Use empty string "" to move to top level.'
            },
          },
          required: ['collectionKey'],
        },
      },
      {
        name: 'delete_collection',
        description: 'Delete a collection. WARNING: This is a destructive operation. By default, items in the collection are NOT deleted (only removed from the collection). Set deleteItems=true to also send items to trash.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            collectionKey: { type: 'string', description: 'Key of the collection to delete' },
            deleteItems: {
              type: 'boolean',
              description: 'If true, also send items in the collection to trash. Default: false (items remain in library).'
            },
          },
          required: ['collectionKey'],
        },
      },
      {
        name: 'add_items_to_collection',
        description: 'Add one or more items to a collection by their item keys.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            collectionKey: { type: 'string', description: 'Key of the target collection' },
            itemKeys: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of item keys to add to the collection'
            },
          },
          required: ['collectionKey', 'itemKeys'],
        },
      },
      {
        name: 'remove_items_from_collection',
        description: 'Remove one or more items from a collection. Items are NOT deleted from the library, only removed from this collection.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            collectionKey: { type: 'string', description: 'Key of the collection' },
            itemKeys: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of item keys to remove from the collection'
            },
          },
          required: ['collectionKey', 'itemKeys'],
        },
      },
      {
        name: 'search_fulltext',
        description: [
          'SECOND-STAGE retrieval: a hybrid search inside the full text of ONE document located by hybrid_search. Same machinery as hybrid_search - keyword matching plus vector semantic retrieval over the same index, fused into the same normalized 0-1 relevance score, filtered by the same user threshold - except the candidates are the passages (chunks) of a single paper instead of the whole library.',
          '',
          "Call it once per document, with that document's own itemKey.",
          '',
          'BEFORE you write the arguments, redo the expert analysis FOR THIS PAPER. Do not reuse the library-level query and keywords: they were written for the user question in general, and they will retrieve the same generic passages from every paper.',
          'A. Get this paper\'s abstract first, with get_item_abstract on its itemKey — hybrid_search does not return abstracts. Read it together with the hit evidence hybrid_search gave you for this paper.',
          "B. Re-judge the field from \"user question + this paper's title + its abstract + its evidence\", and adopt the expert role that THIS paper belongs to. Expect it to be narrower or simply different from the stage-1 pair, and pass the re-fitted values in domain and expertRole.",
          'C. Identify what is particular to THIS paper: its study object, material or sample system, experimental or computational method, the variables it manipulates and measures, the mechanism it argues for, and its own terminology and abbreviations.',
          'D. Write query and keywords out of THAT: a natural-language sentence about what you need from this paper, and probes in this paper\'s own vocabulary and terms of art.',
          'E. Write those keywords in the LANGUAGE THIS PAPER IS WRITTEN IN — one language, not both. Library-wide search is bilingual because the library is; this search is not, because a single document is not. Chinese probes cannot match an English paper\'s passages and vice versa: they match nothing and only dilute keyword coverage. hybrid_search reports each candidate\'s language, and the abstract confirms it. Only a genuinely mixed-language document takes mixed probes.',
          '',
          'CONTEXT EXPANSION: read the returned passages first and stop when the evidence is sufficient. Only when a passage is clearly missing its cause, its consequence, its experimental conditions or its mechanism context, call this tool again with chunkIds set to the chunkId(s) of that passage - it then returns those passages plus their immediate neighbours in reading order, within the radius the user allows. Never request neighbours by default and never ask for the whole document.',
          '',
          "Result counts are capped by the user's preferences and the relevance threshold is a floor you cannot lower. Passages below it are discarded; the cap is a ceiling, not a quota, so a document with only one good passage returns one passage.",
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            itemKey: {
              type: 'string',
              description: 'The single item key to dig into, taken from a hybrid_search candidate row whose abstract you have already read with get_item_abstract.'
            },
            query: {
              type: 'string',
              description: 'Natural-language sentence describing what you need FROM THIS PAPER, written after re-judging the field from the user question plus this paper\'s abstract (fetched with get_item_abstract) and its stage-1 evidence. Embedded as-is for semantic retrieval over this paper\'s passages, so write prose, not tokens, and write it in the language this paper is written in. Required unless chunkIds is used.'
            },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: MAX_SUPPLIED_KEYWORDS,
              description: `Probes specific to THIS paper: its study object, material system, method, variables, mechanism terms and its own abbreviations. Write them in the LANGUAGE THIS PAPER IS WRITTEN IN - one language, not both: this searches inside a single document, so probes in the other language match nothing and only dilute keyword coverage. hybrid_search reports each candidate's language and the abstract confirms it. Do not copy the library-level bilingual keyword set. 1 to ${MAX_HYBRID_KEYWORDS} entries; around 5-12 is recommended. Omitting them makes the server fall back to mechanically splitting the query and flags the result as keywordSource "fallback".`
            },
            domain: {
              type: 'string',
              description: 'The discipline and sub-field THIS paper belongs to, as you judged it from the question plus this paper\'s abstract and evidence. Re-fit it to this paper instead of repeating the library-level domain; it is normal for it to come out narrower or simply different. Required, together with expertRole, for the call to count as domain-expert retrieval.'
            },
            expertRole: {
              type: 'string',
              description: 'The specialist perspective you adopted for this paper, e.g. "solidification microstructure specialist". Required, together with domain, for the call to count as domain-expert retrieval.'
            },
            chunkIds: {
              type: 'array',
              items: { type: 'number' },
              description: 'CONTEXT EXPANSION mode. The chunkId(s) of passages that lack surrounding context. Returns those passages plus their neighbours within the user-configured radius, in reading order, and performs no ranking. Use only after reading the search results and finding a specific gap.'
            },
            neighborRadius: {
              type: 'number',
              description: 'How many chunks either side to include in context expansion. Capped by the user setting; ask for less, never more.'
            },
            maxChunks: {
              type: 'number',
              description: 'Upper bound on returned passages. Capped by the user setting. Only lowers the cap; it can never raise it, and it never pads weak passages in to reach a count.'
            },
            minScore: {
              type: 'number',
              description: 'Relevance floor 0-1 for the fused score. May only be stricter than the user setting; a lower value is raised back to it.'
            },
          },
          required: ['itemKey'],
        },
      },
      {
        name: 'get_item_abstract',
        description: [
          "Get ONE item's abstract - the author's own summary from the original publication.",
          '',
          'This is the on-demand middle step of the retrieval funnel, and it is deliberately not part of what hybrid_search returns. Call it for a candidate you are seriously considering going deeper on, one itemKey at a time. Do NOT sweep it across a result set: if 3 of 20 candidates look worth pursuing, you fetch 3 abstracts. When a candidate row already shows a paper is off-topic, decide that from the row and never fetch its abstract at all.',
          '',
          'What to do with what comes back: read it together with the user question, the title and the hit evidence hybrid_search gave for this paper, then re-fit domain and expertRole to what THIS paper actually studies, and derive a query and keywords from its own subject matter - in the language the paper is written in - for a search_fulltext call on that single itemKey.',
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            itemKey: { type: 'string', description: 'Item key' },
            format: {
              type: 'string',
              enum: ['json', 'text'],
              description: 'Response format (default: json)'
            },
          },
          required: ['itemKey'],
        },
      },
      // Semantic Search Tools
      {
        name: 'semantic_search',
        description: 'Pure embedding-similarity search. For normal literature discovery, use hybrid_search first; use this tool only when the user explicitly requests semantic-only retrieval.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Natural language search query (e.g., "machine learning in healthcare")'
            },
            topK: {
              type: 'number',
              description: 'Number of results to return (default: 10)'
            },
            minScore: {
              type: 'number',
              description: 'Minimum similarity score 0-1 (default: 0.3)'
            },
            language: {
              type: 'string',
              enum: ['zh', 'en', 'all', 'auto'],
              description: 'Filter by language; all searches every language, auto uses query language (default: all)'
            },
            libraryID: {
              type: 'number',
              description: 'Zotero library ID (default: user library)'
            },
            timeoutMs: {
              type: 'number',
              minimum: 1,
              description: 'Total semantic search deadline in milliseconds (default: 8000)'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'find_similar',
        description: [
          'Find DOCUMENTS in the library that are semantically similar to ONE paper you already have, using several of that paper\'s own passages as the query. Purely semantic: no keywords are involved at any point.',
          '',
          'THE CALL CHAIN, in order. You must do step 1 yourself; this tool does 2-5.',
          '1. YOU pick the representative chunks. Run search_fulltext on the paper you are expanding from and read the passages it returns. Choose the ones that actually characterise the paper for YOUR task — its method, its mechanism, its material system, its findings, or whichever facets matter — and note their chunkId values. This tool does not and cannot judge which passages are representative; that judgement is the part only you can make, and it decides the quality of everything below.',
          '2. Full-index semantic scan with every chunk you passed, as separate query vectors. Their stored vectors are reused directly, so nothing is re-embedded.',
          '3. The query paper itself is excluded from its own results.',
          '4. DOCUMENT-LEVEL aggregation. Chunk scores are folded into ONE score per candidate document: for each of your query chunks, the candidate\'s two best-matching passages are averaged, then those per-chunk-query scores are combined (mostly their mean, plus a smaller weight on the strongest one). A paper therefore scores high by relating to SEVERAL of the facets you supplied, not by owning one lucky passage. The result is on the same 0-1 scale as every other relevance score in this plugin.',
          '5. The user\'s relevance threshold is applied to those document scores, and EVERY document above it is ranked and paged - there is no cap on how many papers may qualify.',
          '',
          'PAGING: 20 documents per page, ordered best first. When hasMore is true, call again with cursor set to nextCursor and nothing else changed; that replays the stored ranking instead of re-scanning the library. Decide as you page whether to keep going or to stop and dig into a promising candidate with get_item_abstract and search_fulltext.',
          '',
          'WHAT COMES BACK: identity, score, the chunkIds that carried the score, and fullText — whether that document has body text in the index, one of: indexed, parse_failed, no_source, not_indexed, unknown. No passage text. To read a candidate, call search_fulltext on its itemKey; a row whose fullText is "parse_failed", "no_source" or "not_indexed" holds only title and abstract and will be refused there, and one that is "unknown" predates the record so its passages are unverified.',
          '',
          'Pass chunks from ONE document only. chunkIds are numbered within their own document, so ids from another paper either fail to resolve or would silently mean different passages.',
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            itemKey: {
              type: 'string',
              description: 'The paper the query chunks are taken from. It is excluded from its own results. Required when starting a new search; omit it when following a cursor.'
            },
            chunkIds: {
              type: 'array',
              items: { type: 'number' },
              minItems: 1,
              maxItems: MAX_SIMILAR_QUERY_CHUNKS,
              description: `The chunkIds of the passages of THAT paper you judged representative, taken from a search_fulltext call on it. How many to pass is your call — enough to cover the facets you care about. Every id must belong to itemKey; ids from another document are rejected. Hard maximum ${MAX_SIMILAR_QUERY_CHUNKS}, because each additional chunk re-scores the entire index. Required when starting a new search.`
            },
            libraryID: {
              type: 'number',
              description: 'Zotero library ID (default: user library)'
            },
            minScore: {
              type: 'number',
              description: 'Document-level relevance floor 0-1. May only be STRICTER than the user setting; a lower value is raised back to it.'
            },
            topK: {
              type: 'number',
              description: 'Page size. Capped by the user\'s maximum (20); it only lowers the page size and never the number of qualifying documents, which is unlimited.'
            },
            cursor: {
              type: 'string',
              description: 'Continue a previous find_similar. Pass nextCursor exactly as returned; the stored ranking is replayed with no new scan. Do not change itemKey, chunkIds or minScore while paging.'
            }
          },
          required: []
        }
      },
      {
        name: 'semantic_status',
        description: 'Get the status of the semantic search service including index statistics.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      // Full-text Database Tool (read-only operations)
      {
        name: 'fulltext_database',
        description: 'Read full text on demand. Search is second-stage only and requires itemKeys returned by hybrid_search; unscoped whole-library content scanning is disabled. Actions: list, search, get, stats.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'search', 'get', 'stats'],
              description: 'Action: list (show indexed metadata), search (search explicit candidate content), get (read explicit item content), stats (database statistics)'
            },
            query: {
              type: 'string',
              description: 'Search query (required for search action)'
            },
            itemKeys: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Required for search and get actions'
            },
            limit: {
              type: 'number',
              description: 'Maximum results to return (default: 20 for list/search)'
            },
            caseSensitive: {
              type: 'boolean',
              description: 'Case sensitive search (default: false)'
            },
            libraryID: {
              type: 'number',
              description: 'Optional Zotero library ID (default: user library)'
            }
          },
          required: ['action']
        }
      },
      // Write Tools
      {
        name: 'write_note',
        description: 'Create or modify Zotero notes. Supports child notes (attached to items), standalone notes, updating, or appending. Markdown is auto-converted to HTML. Confirm with user before writing.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            action: {
              type: 'string',
              enum: ['create', 'update', 'append'],
              description: 'create: new note, update: replace content, append: add to end'
            },
            parentKey: {
              type: 'string',
              description: 'Item key to attach note to (create action only, omit for standalone note)'
            },
            noteKey: {
              type: 'string',
              description: 'Existing note key (required for update/append actions)'
            },
            content: {
              type: 'string',
              description: 'Note content in HTML or Markdown format. Markdown is auto-converted to HTML for Zotero storage.'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags to add to the note'
            }
          },
          required: ['action', 'content']
        }
      },
      {
        name: 'write_tag',
        description: 'Add, remove, or replace tags on Zotero items. Works on any item type. Response includes before/after tag lists for verification. Confirm with user before executing.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            action: {
              type: 'string',
              enum: ['add', 'remove', 'set'],
              description: 'add: add tags (keep existing), remove: remove specific tags, set: replace all tags with provided list'
            },
            itemKey: {
              type: 'string',
              description: 'Item key to modify tags on'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags to add/remove/set'
            }
          },
          required: ['action', 'itemKey', 'tags']
        }
      },
      {
        name: 'write_metadata',
        description: 'Update metadata fields on Zotero items (title, abstract, date, URL, DOI, creators, etc.). Only works on regular items, not notes or attachments. Confirm with user before executing.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            itemKey: {
              type: 'string',
              description: 'Item key to update metadata on'
            },
            fields: {
              type: 'object',
              description: 'Fields to update. Common fields: title, abstractNote, date, url, DOI, language, shortTitle, volume, issue, pages, publisher, place, ISBN, ISSN, extra, rights, series, seriesNumber, edition, numPages, journalAbbreviation, publicationTitle, bookTitle',
              additionalProperties: { type: 'string' }
            },
            creators: {
              type: 'array',
              description: 'Set the creators list (replaces all existing creators). Each creator has creatorType (author/editor/translator/etc.), and either firstName+lastName or name (for organizations).',
              items: {
                type: 'object',
                properties: {
                  creatorType: {
                    type: 'string',
                    description: 'Creator type: author, editor, translator, contributor, bookAuthor, seriesEditor, reviewedAuthor, etc.'
                  },
                  firstName: { type: 'string', description: 'First name (for individuals)' },
                  lastName: { type: 'string', description: 'Last name (for individuals)' },
                  name: { type: 'string', description: 'Full name (for organizations, use instead of firstName/lastName)' }
                },
                required: ['creatorType']
              }
            }
          },
          required: ['itemKey']
        }
      },
      {
        name: 'write_item',
        description: 'Create a new Zotero item, re-parent existing attachments, or import a local file as an attachment. Common workflows: (1) read PDF → extract metadata → create item → attach PDF via attachmentKeys; (2) convert PDF to Markdown → import the .md file as attachment via import action. Confirm with user before executing.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            action: {
              type: 'string',
              enum: ['create', 'reparent', 'import'],
              description: 'create: create a new item with metadata. reparent: move an attachment under a different parent item. import: import a local file (e.g., Markdown, PDF) as an attachment to an existing item; this action additionally requires the "Allow File Import" preference to be enabled and fails otherwise.'
            },
            itemType: {
              type: 'string',
              description: 'Item type for create action (e.g., journalArticle, book, conferencePaper, thesis, report, webpage, preprint, bookSection, etc.)'
            },
            fields: {
              type: 'object',
              description: 'Metadata fields for create action. Common: title, abstractNote, date, url, DOI, language, volume, issue, pages, publisher, place, publicationTitle, bookTitle, etc.',
              additionalProperties: { type: 'string' }
            },
            creators: {
              type: 'array',
              description: 'Creators for create action. Each: {creatorType, firstName, lastName} or {creatorType, name} for organizations.',
              items: {
                type: 'object',
                properties: {
                  creatorType: { type: 'string', description: 'author, editor, translator, contributor, etc.' },
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                  name: { type: 'string', description: 'For organizations' }
                },
                required: ['creatorType']
              }
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags to add to the new item'
            },
            attachmentKeys: {
              type: 'array',
              items: { type: 'string' },
              description: 'For create: existing standalone attachment keys to re-parent under the new item. For reparent: attachment keys to move.'
            },
            parentKey: {
              type: 'string',
              description: 'For reparent action: the target parent item key to move attachments to'
            },
            filePath: {
              type: 'string',
              description: 'For import action: absolute path to the file to import as an attachment'
            },
            parentItemKey: {
              type: 'string',
              description: 'For import action: Zotero item key of the parent to attach the file to'
            },
            title: {
              type: 'string',
              description: 'For import action: display title for the attachment (defaults to the file name)'
            }
          },
          required: ['action']
        }
      }
    ];

    // Filter out semantic tools if semantic search is disabled
    const semanticEnabled = Zotero.Prefs.get('extensions.zotero.zotero-mcp-plugin.semantic.enabled', true);
    const semanticToolNames = new Set(['semantic_search', 'find_similar', 'semantic_status']);
    const filteredTools = semanticEnabled === false
      ? tools.filter((t: any) => !semanticToolNames.has(t.name))
      : tools;

    // Filter out write tools if write operations are disabled (default: disabled)
    const writeEnabled = isWriteEnabled();
    const finalTools = writeEnabled
      ? filteredTools
      : filteredTools.filter((t: any) => !MUTATING_TOOL_NAMES.has(t.name));

    return finalTools;
  }

  private async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const { name, arguments: args } = request.params;

    try {
      // 统一的写入闸门：任何会改动 Zotero 数据的工具都先过这里。
      // 每个 case 内原有的 write.enabled 检查保留，作为二次校验。
      if (MUTATING_TOOL_NAMES.has(name)) {
        assertWriteEnabled(name);
        await assertMutationConfirmed(name, args);
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
            throw new Error('search_library.fulltext is disabled. Use hybrid_search first, then search_fulltext with one matched itemKey at a time');
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
            throw new Error('Either q (query), colors, or tags filter is required');
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
          if (!args?.itemKey && !args?.annotationId && !args?.annotationIds) {
            throw new Error('Either itemKey, annotationId, or annotationIds is required');
          }
          result = await this.callGetAnnotations(args);
          break;

        case 'get_content':
          if (!args?.itemKey && !args?.attachmentKey) {
            throw new Error('Either itemKey or attachmentKey is required');
          }
          result = await this.callGetContent(args);
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

        case 'get_collection_items':
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          result = await this.callGetCollectionItems(args);
          break;

        case 'get_subcollections':
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          result = await this.callGetSubcollections(args);
          break;

        case 'create_collection': {
          const writeEnabledCC = Zotero.Prefs.get('extensions.zotero.zotero-mcp-plugin.write.enabled', true);
          if (writeEnabledCC !== true) {
            throw new Error('Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.');
          }
          if (!args?.name) {
            throw new Error('name is required');
          }
          result = await this.callCreateCollection(args);
          break;
        }

        case 'update_collection': {
          const writeEnabledUC = Zotero.Prefs.get('extensions.zotero.zotero-mcp-plugin.write.enabled', true);
          if (writeEnabledUC !== true) {
            throw new Error('Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.');
          }
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          result = await this.callUpdateCollection(args);
          break;
        }

        case 'delete_collection': {
          const writeEnabledDC = Zotero.Prefs.get('extensions.zotero.zotero-mcp-plugin.write.enabled', true);
          if (writeEnabledDC !== true) {
            throw new Error('Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.');
          }
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          result = await this.callDeleteCollection(args);
          break;
        }

        case 'add_items_to_collection': {
          const writeEnabledAI = Zotero.Prefs.get('extensions.zotero.zotero-mcp-plugin.write.enabled', true);
          if (writeEnabledAI !== true) {
            throw new Error('Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.');
          }
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          const addKeys = this.coerceStringArray(args?.itemKeys);
          if (!addKeys || addKeys.length === 0) {
            throw new Error(`itemKeys array is required, e.g. ["ABCD1234"]. Received: ${JSON.stringify(args?.itemKeys)}`);
          }
          result = await this.callAddItemsToCollection({ ...args, itemKeys: addKeys });
          break;
        }

        case 'remove_items_from_collection': {
          const writeEnabledRI = Zotero.Prefs.get('extensions.zotero.zotero-mcp-plugin.write.enabled', true);
          if (writeEnabledRI !== true) {
            throw new Error('Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.');
          }
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          const removeKeys = this.coerceStringArray(args?.itemKeys);
          if (!removeKeys || removeKeys.length === 0) {
            throw new Error(`itemKeys array is required, e.g. ["ABCD1234"]. Received: ${JSON.stringify(args?.itemKeys)}`);
          }
          result = await this.callRemoveItemsFromCollection({ ...args, itemKeys: removeKeys });
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
          result = await this.callSearchFulltext(fulltextArgs);
          break;
        }

        case 'get_item_abstract':
          if (!args?.itemKey) {
            throw new Error('itemKey is required');
          }
          result = await this.callGetItemAbstract(args);
          break;

        // Semantic Search Tools
        case 'semantic_search':
        case 'find_similar':
        case 'semantic_status': {
          const semEnabled = Zotero.Prefs.get('extensions.zotero.zotero-mcp-plugin.semantic.enabled', true);
          if (semEnabled === false) {
            throw new Error('Semantic search is disabled. Enable it in Zotero MCP Plugin preferences.');
          }
          if (name === 'semantic_search') {
            if (typeof args?.query !== 'string' || !args.query.trim()) {
              throw new Error('query is required');
            }
            result = await this.callSemanticSearch(args);
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
              if (!Array.isArray(args?.chunkIds) || args.chunkIds.length === 0) {
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

        case 'fulltext_database':
          if (!args?.action) {
            throw new Error('action is required');
          }
          if (args.action === 'search') {
            const cachedSearchItemKeys = this.coerceStringArray(args?.itemKeys);
            if (!cachedSearchItemKeys || cachedSearchItemKeys.length === 0) {
              throw new Error('itemKeys from hybrid_search are required for search; whole-library full-text scanning is disabled');
            }
            args.itemKeys = cachedSearchItemKeys;
          }
          result = await this.callFulltextDatabase(args);
          break;

        // Write Tools
        case 'write_note': {
          const writeEnabled = Zotero.Prefs.get('extensions.zotero.zotero-mcp-plugin.write.enabled', true);
          if (writeEnabled !== true) {
            throw new Error('Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.');
          }
          if (!args?.action || !args?.content) {
            throw new Error('action and content are required');
          }
          result = await this.callWriteNote(args);
          break;
        }

        case 'write_tag': {
          const writeEnabled2 = Zotero.Prefs.get('extensions.zotero.zotero-mcp-plugin.write.enabled', true);
          if (writeEnabled2 !== true) {
            throw new Error('Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.');
          }
          if (!args?.action || !args?.itemKey || !args?.tags) {
            throw new Error('action, itemKey, and tags are required');
          }
          result = await this.callWriteTag(args);
          break;
        }

        case 'write_metadata': {
          const writeEnabled3 = Zotero.Prefs.get('extensions.zotero.zotero-mcp-plugin.write.enabled', true);
          if (writeEnabled3 !== true) {
            throw new Error('Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.');
          }
          if (!args?.itemKey) {
            throw new Error('itemKey is required');
          }
          if (!args?.fields && !args?.creators) {
            throw new Error('At least one of fields or creators is required');
          }
          result = await this.callWriteMetadata(args);
          break;
        }

        case 'write_item': {
          const writeEnabled4 = Zotero.Prefs.get('extensions.zotero.zotero-mcp-plugin.write.enabled', true);
          if (writeEnabled4 !== true) {
            throw new Error('Write operations are currently disabled. Please go to Zotero → Tools → Add-ons → Zotero MCP Plugin → Preferences, and enable "Write Operations" to use this feature.');
          }
          if (!args?.action) {
            throw new Error('action is required');
          }
          result = await this.callWriteItem(args);
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
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
            type: "text",
            text: compactJson.length > 100000 ? compactJson : JSON.stringify(result, null, 2)
          }
        ]
      });

    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Tool call error for ${name}: ${error}`);
      return this.createError(request.id ?? null, -32603, 
        `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`);
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
    // Apply mode-based defaults before creating search params
    const effectiveMode = args.mode || MCPSettingsService.get('content.mode');
    const modeConfig = this.getSearchModeConfiguration(effectiveMode);
    
    // Apply mode defaults if not explicitly provided
    const processedArgs = {
      ...args,
      limit: args.limit || modeConfig.limit
    };
    
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(processedArgs)) {
      if (value !== undefined && value !== null) {
        if (key !== 'mode') { // Don't pass mode to API
          searchParams.append(key, String(value));
        }
      }
    }
    
    const SEARCH_TIMEOUT_MS = 25000; // 25 秒超时，低于 keepAlive 的 30 秒
    const searchPromise = handleSearch(searchParams);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Search timed out after 25 seconds. Try narrowing your query or reducing the limit.")), SEARCH_TIMEOUT_MS);
    });
    const response = await Promise.race([searchPromise, timeoutPromise]);
    let result = response.body ? JSON.parse(response.body) : response;
    if (response.status < 200 || response.status >= 300 || result?.error) {
      throw new Error(
        result?.error ||
          `Keyword metadata search failed with HTTP ${response.status}`,
      );
    }
    
    // Add mode information to metadata
    if (result && typeof result === 'object') {
      result.metadata = {
        ...result.metadata,
        mode: effectiveMode,
        appliedModeConfig: modeConfig
      };
      
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
    const documentCap = resolveResultCap(args.topK, settings.maxDocuments);
    const scoreFloor = resolveScoreFloor(args.minScore, settings.minScore);
    // topK is only the page size; retrieval enumerates every available match.
    const topK = documentCap.value;
    const language = args.language ?? 'all';
    const libraryID =
      args.libraryID ?? Zotero.Libraries.userLibraryID;

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
        scoreFloor: scoreFloor.value,
        language,
        libraryID,
      });
    }

    this.validateSearchParameters({
      query: args.query,
      topK,
      minScore: scoreFloor.value,
      language,
      libraryID,
    });

    // Collection scope is resolved to item keys BEFORE either branch runs, so
    // both of them narrow their candidates instead of scoring the library and
    // discarding afterwards.
    const uncertainCollections = Array.isArray(args.uncertainCollectionKeys)
      ? args.uncertainCollectionKeys.map((key: unknown) => String(key)).filter(Boolean)
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
      keywordWeight: args.keywordWeight ?? 1,
      semanticWeight: args.semanticWeight ?? 1,
      minScore: scoreFloor.value,
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
    const semanticEnabled = Zotero.Prefs.get(
      'extensions.zotero.zotero-mcp-plugin.semantic.enabled',
      true,
    ) !== false;

    // Both branches must be able to stop, not just be stopped waiting for:
    // an abandoned embedding request or library scan would otherwise keep
    // burning time (and API quota) after the hybrid deadline has passed.
    const semanticAbort =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    // Filled in by the vector scan so the response can report how much work
    // the collection scope actually saved.
    const semanticScanStats: { chunksScanned?: number; chunksMatched?: number } = {};
    let lexicalCancelled = false;
    let lexicalDiagnostics: Awaited<
      ReturnType<typeof runLexicalSearch>
    >['diagnostics'] | null = null;

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
          if (!semanticEnabled) {
            throw new Error('semantic search is disabled in plugin preferences');
          }
          const semanticService = getSemanticSearchService();
          return semanticService.search(args.query, {
            exhaustive: true,
            includeChunkText: false,
            // The fused threshold is the only Library-level relevance filter.
            minScore: -1,
            language,
            libraryID,
            // Restricting the vector scan itself: the SQL only reads chunks
            // belonging to these items, so out-of-scope chunks are never
            // dequantised and never have a similarity computed for them.
            itemKeys: scope.searchScope === 'collections' ? scope.itemKeys : undefined,
            vectorScanTimeoutMs: settings.vectorScanTimeoutMs,
            signal: semanticAbort?.signal,
            stats: semanticScanStats,
          });
        },
        cancelSemanticSearch: () => {
          semanticAbort?.abort();
        },
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
    if (scoreFloor.clamped) {
      hybridWarnings.push(
        `Requested minScore was below the user's relevance threshold; raised to ${scoreFloor.value}.`,
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
      appliedMinScore: searchResult.appliedMinScore,
      libraryID,
      // searchResult.warnings carries branch-level failures ("Semantic search
      // unavailable: ..."). An empty result set means something completely
      // different depending on this flag, so it has to travel with the page.
      branchFailed: searchResult.warnings.length > 0,
      metadata: {
        searchMode: 'hybrid',
        fusion: 'normalized_weighted_hybrid',
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
        scopeItemCount: scope.searchScope === 'collections' ? scope.itemKeys.length : null,
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
        lexicalFieldWeights: LEXICAL_FIELD_WEIGHTS,
        language,
        rrfK: options.rrfK,
        keywordWeight: options.keywordWeight,
        semanticWeight: options.semanticWeight,
        appliedMinScore: searchResult.appliedMinScore,
        userMinScore: settings.minScore,
        appliedPageSize: topK,
        userMaxDocuments: settings.maxDocuments,
        discardedBelowThreshold: searchResult.discardedBelowThreshold,
        keywordResultCount: searchResult.keywordResultCount,
        semanticResultCount: searchResult.semanticResultCount,
        degraded,
        warnings: hybridWarnings,
        timings: {
          lexicalMs: searchResult.timings.keywordMs,
          semanticMs: searchResult.timings.semanticMs,
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
      appliedMinScore: searchResult.appliedMinScore,
      language,
      libraryID,
      rrfK: options.rrfK,
      keywordWeight: options.keywordWeight,
      semanticWeight: options.semanticWeight,
      pageSize: topK,
      scope: describeScope(scope),
    };
    // Only worth remembering when there is a page 2 to remember it for.
    const searchId =
      ranked.length > topK
        ? this.hybridPages.create(fingerprint, ranked, snapshot)
        : 'single-page';

    const window = detachPageWindow(
      windowOf<Record<string, any>>(ranked, 0, topK, searchId),
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
          childCollectionKeys = (Zotero.Collections.get(childIDs) as unknown as any[])
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
      scoreFloor: number;
      language: string;
      libraryID: number;
    },
  ): Promise<any> {
    // Only arguments the caller actually re-sent are checked. Omitting one
    // means "unchanged"; re-sending a different one means this is a different
    // search, and continuing the old cursor would answer the new question with
    // the old ranking.
    const claim: FingerprintClaim = {};
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
    if (args.minScore !== undefined) claim.appliedMinScore = request.scoreFloor;
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
        // The floor these results were filtered by. Paging never moves it.
        appliedMinScore: snapshot.appliedMinScore,
        // Documents that cleared that floor in this search — NOT the raw
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
      return `Nothing in the library reached the relevance threshold of ${snapshot.appliedMinScore}. Say so rather than reporting weak matches; the threshold is the user's setting and is not negotiable from here.`;
    }

    const funnel =
      'These are candidates above the relevance threshold, as lightweight rows: title, creators, year, venue, language, fused score, which keywords matched which fields, a short evidence snippet, and fullText — whether that document actually has body text in the index, one of: indexed (real full text), parse_failed (a PDF/Markdown exists but could not be parsed), no_source (no PDF/Markdown/text attachment at all), not_indexed (has a body source but is not in the semantic index yet), unknown (indexed before this was recorded). Read fullText before you read matchedChunks. "indexed" is the only value whose snippets are confirmed body text. For "parse_failed", "no_source" and "not_indexed" the document was indexed from its title and abstract alone, the snippets are that metadata rather than passages from the paper, and search_fulltext will refuse it. For "unknown" the document predates this record: search_fulltext still works, but whether its passages are body text or just an abstract was never established, so do not cite them as the paper\'s content without checking. Every row that is not "indexed" carries a fullTextNote saying what to do about it. metadata.fullTextCoverage counts this page by those same five values, and the five counts add up to the rows returned. Abstracts are NOT included - they were searched, they are just not shipped back. Triage from these rows first. For a paper you are seriously considering going deeper on - and only for those - call get_item_abstract with that one itemKey; a page of 20 candidates does not mean 20 abstracts. After reading an abstract, re-fit domain and expertRole to what THAT paper actually studies, write a query and keywords from its own subject matter in the language it is written in (one language, not both), and call search_fulltext with its single itemKey.';

    const paging = window.hasMore
      ? ` PAGING: ${window.totalRelevant} documents cleared the threshold and you are seeing ${range}. If the bottom of this page is still relevant, or the user asked for a comprehensive sweep or a literature review, call hybrid_search again with cursor="${window.nextCursor}" and change nothing else - same query, keywords, domain, expertRole and minScore - to get the next page of the SAME ranking. Do not page by reflex: if this page already answers the question, stop here.`
      : ` PAGING: ${range} of ${window.totalRelevant} - this is the last page of the ranking.`;

    const degradedNote = snapshot.branchFailed
      ? ` DEGRADED: a retrieval branch failed or timed out during this search (see metadata.warnings), so this ranking is incomplete — treat a thin result list as a retrieval problem, not as a fact about the library.`
      : '';

    const bound = window.hasMore
      ? ''
      : ' These are all the documents above the threshold. Do not lower minScore to find more; the threshold is the user\'s setting.';

    // Placed in nextStep as well as in warnings: this one changes what the
    // caller may do with specific rows, so it belongs in the instruction it is
    // about to follow, not only in a list it may skim.
    const fullTextNote = fullTextWarning ? ` FULL TEXT: ${fullTextWarning}` : '';

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
          result.title = item.getDisplayTitle?.() || item.getField?.('title') || '';
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
    if (
      !Number.isInteger(params.libraryID) ||
      Number(params.libraryID) <= 0
    ) {
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

  private async callGetItemDetails(args: any): Promise<any> {
    const { itemKey, mode, libraryID } = args;
    
    // Import the specific handler for item details
    const { handleGetItem } = await import('./apiHandlers');
    
    // Get effective mode
    const effectiveMode = mode || MCPSettingsService.get('content.mode');
    
    // Create query params with mode-based field selection
    const queryParams = new URLSearchParams();
    if (libraryID !== undefined && libraryID !== null) {
      queryParams.append('libraryID', String(libraryID));
    }
    if (effectiveMode !== 'complete') {
      // Apply field filtering based on mode (this could be enhanced in apiHandlers)
      const modeConfig = this.getItemDetailsModeConfiguration(effectiveMode);
      if (modeConfig.fields) {
        queryParams.append('fields', modeConfig.fields.join(','));
      }
    }
    
    // Call the dedicated item details handler
    const response = await handleGetItem({ 1: itemKey }, queryParams);
    let result = response.body ? JSON.parse(response.body) : response;
    
    // Add mode information to metadata
    if (result && typeof result === 'object') {
      result.metadata = {
        ...result.metadata,
        mode: effectiveMode,
        appliedModeConfig: this.getItemDetailsModeConfiguration(effectiveMode)
      };
    }
    
    return result;
  }

  private async callGetAnnotations(args: any): Promise<any> {
    const extractor = new SmartAnnotationExtractor();
    const result = await extractor.getAnnotations(args);
    return result;
  }

  private async callGetContent(args: any): Promise<any> {
    const { itemKey, attachmentKey, include, format, mode, contentControl, libraryID } = args;
    const extractor = new UnifiedContentExtractor();
    
    try {
      let result;
      
      if (itemKey) {
        // Get content from item with unified mode control and content control parameters
        result = await extractor.getItemContent(itemKey, include || {}, mode, contentControl, libraryID);
      } else if (attachmentKey) {
        // Get content from specific attachment with unified mode control and content control parameters
        result = await extractor.getAttachmentContent(attachmentKey, mode, contentControl, libraryID);
      } else {
        throw new Error('Either itemKey or attachmentKey must be provided');
      }
      
      // Apply format conversion if requested
      if (format === 'text' && itemKey) {
        return extractor.convertToText(result);
      } else if (format === 'text' && attachmentKey) {
        return result.content || '';
      }
      
      return result;
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Error in callGetContent: ${error}`, 'error');
      throw error;
    }
  }

  private async callGetCollections(args: any): Promise<any> {
    // Apply mode-based defaults before creating search params
    const effectiveMode = args.mode || MCPSettingsService.get('content.mode');
    const modeConfig = this.getCollectionModeConfiguration(effectiveMode);
    
    // Apply mode defaults if not explicitly provided
    const processedArgs = {
      ...args,
      limit: args.limit || modeConfig.limit
    };
    
    const collectionParams = new URLSearchParams();
    for (const [key, value] of Object.entries(processedArgs)) {
      if (value !== undefined && value !== null) {
        if (key !== 'mode') { // Don't pass mode to API
          collectionParams.append(key, String(value));
        }
      }
    }
    
    const response = await handleGetCollections(collectionParams);
    let result = response.body ? JSON.parse(response.body) : response;
    
    // Add mode information to metadata
    if (result && typeof result === 'object') {
      result.metadata = {
        ...result.metadata,
        mode: effectiveMode,
        appliedModeConfig: modeConfig
      };
    }
    
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
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  private async callGetCollectionDetails(args: any): Promise<any> {
    const { collectionKey, ...otherArgs } = args;
    const detailParams = new URLSearchParams();
    for (const [key, value] of Object.entries(otherArgs)) {
      if (value !== undefined && value !== null) {
        detailParams.append(key, String(value));
      }
    }
    const response = await handleGetCollectionDetails({ 1: collectionKey }, detailParams);
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  private async callGetCollectionItems(args: any): Promise<any> {
    const { collectionKey, ...otherArgs } = args;
    const itemParams = new URLSearchParams();
    for (const [key, value] of Object.entries(otherArgs)) {
      if (value !== undefined && value !== null) {
        itemParams.append(key, String(value));
      }
    }
    const response = await handleGetCollectionItems({ 1: collectionKey }, itemParams);
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  private async callGetSubcollections(args: any): Promise<any> {
    const { collectionKey, ...otherArgs } = args;
    const subcollectionParams = new URLSearchParams();
    for (const [key, value] of Object.entries(otherArgs)) {
      if (value !== undefined && value !== null) {
        subcollectionParams.append(key, String(value));
      }
    }
    const response = await handleGetSubcollections({ 1: collectionKey }, subcollectionParams);
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  private async callCreateCollection(args: any): Promise<any> {
    const response = await handleCreateCollection({
      libraryID: args.libraryID,
      name: args.name,
      parentCollection: args.parentCollection,
    });
    return response.body ? JSON.parse(response.body) : response;
  }

  private async callUpdateCollection(args: any): Promise<any> {
    const { collectionKey, ...body } = args;
    const response = await handleUpdateCollection({ 1: collectionKey }, body);
    return response.body ? JSON.parse(response.body) : response;
  }

  private async callDeleteCollection(args: any): Promise<any> {
    const { collectionKey, ...body } = args;
    const response = await handleDeleteCollection({ 1: collectionKey }, body);
    return response.body ? JSON.parse(response.body) : response;
  }

  /**
   * Accept arrays that some MCP clients serialize as strings, e.g.
   * '["KEY1","KEY2"]' or 'KEY1,KEY2' (#71).
   */
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
        return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
    return undefined;
  }

  private async callAddItemsToCollection(args: any): Promise<any> {
    const { collectionKey, itemKeys, libraryID } = args;
    const response = await handleAddItemsToCollection({ 1: collectionKey }, { itemKeys, libraryID });
    return response.body ? JSON.parse(response.body) : response;
  }

  private async callRemoveItemsFromCollection(args: any): Promise<any> {
    const { collectionKey, itemKeys, libraryID } = args;
    const response = await handleRemoveItemsFromCollection({ 1: collectionKey }, { itemKeys, libraryID });
    return response.body ? JSON.parse(response.body) : response;
  }

  /**
   * Document-level hybrid search, plus the neighbour-expansion mode.
   *
   * Both delegate to documentDeepDive, which is built on the same hybrid
   * primitives as hybrid_search: there is no second retrieval stack here, only
   * a different candidate set (this paper's chunks instead of the library).
   */
  private async callSearchFulltext(args: any): Promise<any> {
    const semanticEnabled = Zotero.Prefs.get(
      'extensions.zotero.zotero-mcp-plugin.semantic.enabled',
      true,
    );
    if (semanticEnabled === false) {
      throw new Error(
        'search_fulltext needs the semantic index. Enable semantic search in Zotero MCP Plugin preferences and build the index first.',
      );
    }

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
      minScore: args.minScore,
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
    const response = await handleGetItemAbstract({ 1: itemKey }, abstractParams);
    const contentType = response.headers?.['Content-Type'] || '';
    if (contentType.startsWith('text/plain')) {
      // format=text returns a plain-text body that must not be JSON.parsed
      return response.body;
    }
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  // ============ Semantic Search Methods ============

  private async callSemanticSearch(args: any): Promise<any> {
    try {
      const topK = args.topK ?? 10;
      const minScore = args.minScore ?? 0.3;
      const language = args.language ?? 'all';
      const libraryID =
        args.libraryID ?? Zotero.Libraries.userLibraryID;
      // The caller does not get to choose its own deadline: the user's
      // vector-scan setting is the single source of truth for how long a scan
      // may run, exactly as it is for hybrid_search.
      const settings = getHybridSearchSettings();
      const vectorScanTimeoutMs = settings.vectorScanTimeoutMs;
      this.validateSearchParameters({
        query: args.query,
        topK,
        minScore,
        language,
        libraryID,
      });
      const semanticService = getSemanticSearchService();

      const results = await runWithTimeout(
        () =>
          semanticService.search(args.query, {
            topK,
            minScore,
            language,
            libraryID,
            vectorScanTimeoutMs,
          }),
        // Backstop only; embedding and scanning are each bounded inside.
        vectorScanTimeoutMs + DEFAULT_EMBEDDING_TIMEOUT_MS,
        'Semantic search',
      );

      const response = {
        mode: 'semantic',
        query: args.query,
        data: results,
        metadata: {
          extractedAt: new Date().toISOString(),
          searchMode: 'semantic',
          resultCount: results.length,
          fallbackMode: semanticService.getIndexProgress().status === 'idle'
            ? (await semanticService.getStats()).serviceStatus.fallbackMode
            : false
        }
      };

      return response;
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Semantic search error: ${error}`, 'error');
      throw error;
    }
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
      const scoreFloor = resolveScoreFloor(args.minScore, settings.minScore);
      const libraryID = args.libraryID ?? Zotero.Libraries.userLibraryID;

      const cursor =
        typeof args.cursor === 'string' && args.cursor.trim()
          ? args.cursor.trim()
          : null;
      if (cursor) {
        return this.continueFindSimilar(args, cursor, {
          requestedPageSize: args.topK === undefined ? undefined : pageCap.value,
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
              'documentScore = (meanWeight * mean_i(s_i) + maxWeight * max_i(s_i)) / (meanWeight + maxWeight), where s_i is the mean of this document\'s two best chunk cosines against query chunk i (0 when it has none)',
          },
          queryItemKey: outcome.itemKey,
          queryChunkIds: outcome.queryChunkIds,
          queryChunkCount: outcome.queryChunkIds.length,
          totalChunksInQueryItem: outcome.totalChunksInItem,
          candidateDocuments: outcome.candidateDocuments,
          discardedBelowThreshold: outcome.discardedBelowThreshold,
          chunksScanned: outcome.chunksScanned,
          appliedMinScore: scoreFloor.value,
          userMinScore: settings.minScore,
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
        windowOf<Record<string, any>>(ranked, 0, pageCap.value, searchId),
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
        message += `. NOTE: ${int8Status.count}/${int8Status.total} stored vectors predate Int8 quantisation, so searches over them run on the slower Float32 path. This is not something you can fix from here and it does not affect result quality — searches work normally. If the user asks about it, tell them to rebuild the semantic index from Zotero → Preferences → Zotero MCP Plugin → Semantic Search; newly indexed vectors are always quantised.`;
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
        message
      };
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Semantic status error: ${error}`, 'error');
      return {
        ready: false,
        error: String(error)
      };
    }
  }

  private async callFulltextDatabase(args: any): Promise<any> {
    try {
      const { createFulltextDatabaseService } = await import(
        './fulltextDatabaseService'
      );
      const service = await createFulltextDatabaseService();
      return await service.execute(args);
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Fulltext database error: ${error}`, 'error');
      return {
        success: false,
        error: String(error)
      };
    }
  }

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
    html = html.replace(/&/g, '&amp;')
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
      const items = match.trim().split('\n').map((line: string) => {
        const content = line.replace(/^[-*+]\s+/, '');
        return `<li>${content}</li>`;
      }).join('');
      return `<ul>${items}</ul>\n`;
    });

    // Ordered lists (block)
    html = html.replace(/(?:^\d+\.\s+.+$\n?)+/gm, (match) => {
      const items = match.trim().split('\n').map((line: string) => {
        const content = line.replace(/^\d+\.\s+/, '');
        return `<li>${content}</li>`;
      }).join('');
      return `<ol>${items}</ol>\n`;
    });

    // Paragraphs: split by double newline, wrap plain text blocks in <p>
    const blocks = html.split(/\n\n+/);
    html = blocks.map((block: string) => {
      block = block.trim();
      if (!block) return '';
      if (/^<(h[1-6]|ul|ol|li|blockquote|hr|div|p|pre|table)/i.test(block)) {
        return block;
      }
      block = block.replace(/\n/g, '<br/>');
      return `<p>${block}</p>`;
    }).filter(Boolean).join('\n');

    return html;
  }

  /**
   * Handle write_note tool calls: create, update, append notes
   */
  private async callWriteNote(args: any): Promise<any> {
    const { action, parentKey, noteKey, content, tags, libraryID = Zotero.Libraries.userLibraryID } = args;

    try {
      const htmlContent = this.markdownToNoteHtml(content);

      switch (action) {
        case 'create': {
          const note = new Zotero.Item('note');
          note.libraryID = libraryID;

          if (parentKey) {
            const parentItem = await Zotero.Items.getByLibraryAndKeyAsync(
              libraryID, parentKey
            );
            if (!parentItem) {
              throw new Error(`Parent item not found in library ${libraryID}: ${parentKey}`);
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

          ztoolkit.log(`[StreamableMCP] Created note ${note.key}${parentKey ? ' attached to ' + parentKey : ' (standalone)'}`);

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
              dateCreated: note.dateAdded
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Note created successfully (key: ${note.key})`
            }
          };
        }

        case 'update': {
          if (!noteKey) {
            throw new Error('noteKey is required for update action');
          }

          const existingNote = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID, noteKey
          );
          if (!existingNote) {
            throw new Error(`Note not found in library ${libraryID}: ${noteKey}`);
          }
          if (!existingNote.isNote()) {
            throw new Error(`Item ${noteKey} is not a note`);
          }

          existingNote.setNote(htmlContent);

          if (tags && Array.isArray(tags)) {
            for (const tag of tags) {
              existingNote.addTag(tag, 0);
            }
          }

          await existingNote.saveTx();

          ztoolkit.log(`[StreamableMCP] Updated note ${noteKey}`);

          return {
            action: 'update',
            success: true,
            data: {
              noteKey,
              contentPreview: content.substring(0, 200),
              contentLength: content.length,
              tags: existingNote.getTags().map((t: any) => t.tag),
              dateModified: existingNote.dateModified
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Note ${noteKey} updated successfully`
            }
          };
        }

        case 'append': {
          if (!noteKey) {
            throw new Error('noteKey is required for append action');
          }

          const existingNote = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID, noteKey
          );
          if (!existingNote) {
            throw new Error(`Note not found in library ${libraryID}: ${noteKey}`);
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
              dateModified: existingNote.dateModified
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Content appended to note ${noteKey} successfully`
            }
          };
        }

        default:
          throw new Error(`Unknown action: ${action}. Use create, update, or append.`);
      }
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Write note error: ${error}`, 'error');
      return {
        success: false,
        error: String(error)
      };
    }
  }

  /**
   * Handle write_tag tool calls: add, remove, set tags on items
   */
  private async callWriteTag(args: any): Promise<any> {
    const { action, itemKey, tags, libraryID = Zotero.Libraries.userLibraryID } = args;

    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        libraryID, itemKey
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
          throw new Error(`Unknown action: ${action}. Use add, remove, or set.`);
      }

      await item.saveTx();

      const afterTags = item.getTags().map((t: any) => t.tag);

      ztoolkit.log(`[StreamableMCP] write_tag ${action} on ${itemKey}: [${beforeTags.join(', ')}] -> [${afterTags.join(', ')}]`);

      return {
        action,
        success: true,
        data: {
          itemKey,
          beforeTags,
          afterTags,
          tagsModified: tags
        },
        metadata: {
          extractedAt: new Date().toISOString(),
          message: `Tags ${action === 'add' ? 'added to' : action === 'remove' ? 'removed from' : 'set on'} item ${itemKey}`
        }
      };
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Write tag error: ${error}`, 'error');
      return {
        success: false,
        error: String(error)
      };
    }
  }

  /**
   * Handle write_metadata tool calls: update fields and creators on items
   */
  private async callWriteMetadata(args: any): Promise<any> {
    const { itemKey, fields, creators, libraryID = Zotero.Libraries.userLibraryID } = args;

    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        libraryID, itemKey
      );
      if (!item) {
        throw new Error(`Item not found in library ${libraryID}: ${itemKey}`);
      }
      if (!item.isRegularItem()) {
        throw new Error(`Item ${itemKey} is not a regular item (it is a ${item.itemType}). Use write_note for notes.`);
      }

      const updatedFields: Record<string, { before: string; after: string }> = {};
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
            throw new Error(`Failed to set field "${fieldName}": ${fieldError}`);
          }
        }
      }

      // Update creators
      if (creators && Array.isArray(creators)) {
        beforeCreators = item.getCreators().map((c: any) => ({
          creatorType: Zotero.CreatorTypes.getName(c.creatorTypeID),
          firstName: c.firstName,
          lastName: c.lastName
        }));

        item.setCreators(creators.map((c: any) => {
          const creatorData: any = {
            creatorType: c.creatorType || 'author'
          };
          if (c.name) {
            // Organization / single-field name
            creatorData.name = c.name;
          } else {
            creatorData.firstName = c.firstName || '';
            creatorData.lastName = c.lastName || '';
          }
          return creatorData;
        }));

        creatorsUpdated = true;
        afterCreators = creators;
      }

      await item.saveTx();

      ztoolkit.log(`[StreamableMCP] Updated metadata on ${itemKey}: fields=[${Object.keys(updatedFields).join(', ')}], creators=${creatorsUpdated}`);

      return {
        success: true,
        data: {
          itemKey,
          updatedFields,
          creatorsUpdated,
          ...(creatorsUpdated ? { beforeCreators, afterCreators } : {})
        },
        metadata: {
          extractedAt: new Date().toISOString(),
          message: `Metadata updated on item ${itemKey}`
        }
      };
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Write metadata error: ${error}`, 'error');
      return {
        success: false,
        error: String(error)
      };
    }
  }

  /**
   * Handle write_item tool calls: create items, reparent attachments, and import files
   */
  private async callWriteItem(args: any): Promise<any> {
    const { action, itemType, fields, creators, tags, attachmentKeys, parentKey, filePath, parentItemKey, title, libraryID = Zotero.Libraries.userLibraryID } = args;

    try {
      switch (action) {
        case 'create': {
          if (!itemType) {
            throw new Error('itemType is required for create action (e.g., journalArticle, book, conferencePaper)');
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
                throw new Error(`Failed to set field "${fieldName}": ${fieldError}`);
              }
            }
          }

          // Set creators
          if (creators && Array.isArray(creators)) {
            item.setCreators(creators.map((c: any) => {
              const creatorData: any = { creatorType: c.creatorType || 'author' };
              if (c.name) {
                creatorData.name = c.name;
              } else {
                creatorData.firstName = c.firstName || '';
                creatorData.lastName = c.lastName || '';
              }
              return creatorData;
            }));
          }

          // Add tags
          if (tags && Array.isArray(tags)) {
            for (const tag of tags) {
              item.addTag(tag, 0);
            }
          }

          await item.saveTx();

          ztoolkit.log(`[StreamableMCP] Created item ${item.key} (type: ${itemType})`);

          // Re-parent attachments if provided
          const reparentedAttachments: string[] = [];
          if (attachmentKeys && Array.isArray(attachmentKeys)) {
            for (const attKey of attachmentKeys) {
              const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
                libraryID, attKey
              );
              if (!attachment) {
                ztoolkit.log(`[StreamableMCP] Attachment not found in library ${libraryID}: ${attKey}`, 'warn');
                continue;
              }
              if (!attachment.isAttachment()) {
                ztoolkit.log(`[StreamableMCP] Item ${attKey} is not an attachment (type: ${attachment.itemType}), skipping`, 'warn');
                continue;
              }
              attachment.parentKey = item.key;
              await attachment.saveTx();
              reparentedAttachments.push(attKey);
              ztoolkit.log(`[StreamableMCP] Re-parented attachment ${attKey} under ${item.key}`);
            }
          }

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
              dateCreated: item.dateAdded
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Item created (key: ${item.key}, type: ${itemType})${reparentedAttachments.length > 0 ? `, ${reparentedAttachments.length} attachment(s) attached` : ''}`
            }
          };
        }

        case 'reparent': {
          if (!attachmentKeys || !Array.isArray(attachmentKeys) || attachmentKeys.length === 0) {
            throw new Error('attachmentKeys is required for reparent action');
          }
          if (!parentKey) {
            throw new Error('parentKey is required for reparent action');
          }

          // Verify parent exists
          const parentItem = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID, parentKey
          );
          if (!parentItem) {
            throw new Error(`Parent item not found in library ${libraryID}: ${parentKey}`);
          }
          if (!parentItem.isRegularItem()) {
            throw new Error(`Parent ${parentKey} is not a regular item (type: ${parentItem.itemType})`);
          }

          const results: Array<{ key: string; success: boolean; error?: string }> = [];
          for (const attKey of attachmentKeys) {
            try {
              const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
                libraryID, attKey
              );
              if (!attachment) {
                results.push({ key: attKey, success: false, error: `Not found in library ${libraryID}` });
                continue;
              }
              if (!attachment.isAttachment() && !attachment.isNote()) {
                results.push({ key: attKey, success: false, error: `Not an attachment or note (type: ${attachment.itemType})` });
                continue;
              }
              attachment.parentKey = parentKey;
              await attachment.saveTx();
              results.push({ key: attKey, success: true });
              ztoolkit.log(`[StreamableMCP] Re-parented ${attKey} under ${parentKey}`);
            } catch (attError) {
              results.push({ key: attKey, success: false, error: String(attError) });
            }
          }

          const successCount = results.filter(r => r.success).length;

          return {
            action: 'reparent',
            success: successCount > 0,
            data: {
              parentKey,
              results,
              successCount,
              totalCount: attachmentKeys.length
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Re-parented ${successCount}/${attachmentKeys.length} item(s) under ${parentKey}`
            }
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
            throw new Error('filePath is required for import action (absolute path to the file)');
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
            libraryID, importParentKey
          );
          if (!parentItem) {
            throw new Error(`Parent item not found in library ${libraryID}: ${importParentKey}`);
          }
          if (!parentItem.isRegularItem()) {
            throw new Error(`Parent ${importParentKey} is not a regular item (type: ${parentItem.itemType}), cannot attach files`);
          }

          // Import file as attachment
          const attachment = await Zotero.Attachments.importFromFile({
            file: filePath,
            parentItemID: parentItem.id,
            title: title || filePath.split(/[\\/]/).pop() || 'Imported Attachment'
          });

          ztoolkit.log(`[StreamableMCP] Imported file as attachment ${attachment.key} under ${importParentKey}`);

          return {
            action: 'import',
            success: true,
            data: {
              attachmentKey: attachment.key,
              parentItemKey: importParentKey,
              filePath,
              title: attachment.getField('title')
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `File imported as attachment (key: ${attachment.key}) under parent ${importParentKey}`
            }
          };
        }

        default:
          throw new Error(`Unknown action: ${action}. Use create, reparent, or import.`);
      }
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Write item error: ${error}`, 'error');
      return {
        success: false,
        error: String(error)
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
        _contentType: 'application/json'
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
      case 'get_content':
        return this.formatContentAsText(obj);
      case 'search_library':
        return this.formatSearchResultsAsText(obj);
      case 'get_annotations':
        return this.formatAnnotationsAsText(obj);
      default:
        return JSON.stringify(obj, null, 2);
    }
  }

  private formatContentAsText(contentResult: any): string {
    const parts = [];
    
    if (contentResult.title) {
      parts.push(`TITLE: ${contentResult.title}\n`);
    }
    
    if (contentResult.content) {
      if (contentResult.content.abstract) {
        parts.push(`ABSTRACT:\n${contentResult.content.abstract.content}\n`);
      }
      
      if (contentResult.content.attachments) {
        for (const att of contentResult.content.attachments) {
          parts.push(`ATTACHMENT (${att.filename || att.type}):\n${att.content}\n`);
        }
      }
      
      if (contentResult.content.notes) {
        for (const note of contentResult.content.notes) {
          parts.push(`NOTE (${note.title}):\n${note.content}\n`);
        }
      }
    }
    
    return parts.join('\n---\n\n');
  }

  private formatSearchResultsAsText(searchResult: any): string {
    if (!searchResult.results || !Array.isArray(searchResult.results)) {
      return JSON.stringify(searchResult, null, 2);
    }
    
    const parts = [`SEARCH RESULTS (${searchResult.results.length} items):\n`];
    
    searchResult.results.forEach((item: any, index: number) => {
      parts.push(`${index + 1}. ${item.title || 'Untitled'}`);
      if (item.creators && item.creators.length > 0) {
        parts.push(`   Authors: ${item.creators.map((c: any) => c.name || `${c.firstName} ${c.lastName}`).join(', ')}`);
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

  private createError(id: string | number | null, code: number, message: string, data?: any): MCPResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    };
  }

  private isNotificationRequest(request: MCPRequest): boolean {
    return !Object.prototype.hasOwnProperty.call(request, 'id') || request.id === null || request.id === undefined;
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
        'ping'
      ],
      // Derived from the same builder tools/list uses, so this can never
      // drift from what the server actually serves, and it follows the
      // semantic/write prefs instead of ignoring them.
      availableTools: this.getAvailableTools().map((t: any) => t.name),
      transport: {
        type: "streamable-http",
        keepAliveSupported: false,
        maxConnections: 100
      }
    };
  }

  /**
   * Get search mode configuration
   */
  private getSearchModeConfiguration(mode: string): any {
    const modeConfigs = {
      'minimal': {
        limit: 30
      },
      'preview': {
        limit: 100
      },
      'standard': {
        limit: 200
      },
      'complete': {
        limit: 500
      }
    };

    return modeConfigs[mode as keyof typeof modeConfigs] || modeConfigs['standard'];
  }

  /**
   * Get collection mode configuration
   */
  private getCollectionModeConfiguration(mode: string): any {
    const modeConfigs = {
      'minimal': {
        limit: 20
      },
      'preview': {
        limit: 50
      },
      'standard': {
        limit: 100
      },
      'complete': {
        limit: 500
      }
    };

    return modeConfigs[mode as keyof typeof modeConfigs] || modeConfigs['standard'];
  }

  /**
   * Get item details mode configuration
   */
  private getItemDetailsModeConfiguration(mode: string): any {
    const modeConfigs = {
      'minimal': {
        fields: ['key', 'title', 'creators', 'date', 'itemType']
      },
      'preview': {
        fields: ['key', 'title', 'creators', 'date', 'itemType', 'abstractNote', 'tags', 'collections']
      },
      'standard': {
        fields: null // Include most fields (default behavior)
      },
      'complete': {
        fields: null // Include all fields
      }
    };

    return modeConfigs[mode as keyof typeof modeConfigs] || modeConfigs['standard'];
  }
}
