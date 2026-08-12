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
  handleSearchFulltext,
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
import { getSemanticSearchService, SemanticSearchService } from './semantic';
import {
  DEFAULT_HYBRID_TIMEOUT_MS,
  DEFAULT_SEMANTIC_TIMEOUT_MS,
  HYBRID_KEYWORD_COVERAGE_BONUS,
  LEXICAL_FIELD_WEIGHTS,
  MAX_HYBRID_KEYWORDS,
  MAX_SUPPLIED_KEYWORDS,
  resolveHybridKeywords,
  runHybridSearch,
  runWithTimeout,
  type HybridSearchOptions,
  type KeywordSearchItem,
  type SemanticSearchItem,
} from './hybridSearch';
import { runLexicalSearch } from './lexicalSearch';
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

  constructor() {
    // No initialization needed - using direct function calls
  }

  /**
   * Handle incoming MCP requests and return HTTP response
   */
  async handleMCPRequest(requestBody: string): Promise<{ status: number; statusText: string; headers: any; body: string }> {
    let parsedRequest: unknown;

    try {
      parsedRequest = JSON.parse(requestBody);
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Parse error: ${error}`);

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

      ztoolkit.log(`[StreamableMCP] Received: ${request.method}`);

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
      return {
        status,
        statusText: status === 400 ? "Bad Request" : "OK",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: this.serializeResponse(response)
      };
      
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Error handling request: ${error}`);
      
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
      instructions: `Use hybrid_search as the default first step for literature discovery. It fuses metadata keyword and semantic retrieval without scanning full documents. The library holds both Chinese and English literature, so every hybrid_search call must carry a complete natural-language query for the semantic branch plus keywords covering BOTH Chinese and English terms, translations, synonyms and abbreviations, regardless of the language the user asked in; never narrow the search to one language. Around 5-12 keywords is the recommended amount for best results, not a required range: any number from 1 to ${MAX_HYBRID_KEYWORDS} is accepted. If the user only asks which literature is relevant, return the matched titles and metadata directly. Only when the user requests passages, evidence, or full-text details, call search_fulltext with selected itemKeys from hybrid_search. Never perform unscoped whole-library full-text search.`,
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
    const tools = [
      {
        name: 'hybrid_search',
        description: [
          'DEFAULT FIRST STEP for locating literature. Runs Zotero metadata/field keyword retrieval and semantic vector retrieval in parallel, then fuses their rankings with weighted Reciprocal Rank Fusion (RRF). It does not scan full document text.',
          '',
          'The library is bilingual, so every call must retrieve Chinese AND English literature, no matter which language the user asked in. Do NOT translate the question into a single language and do NOT restrict the search to the language of the question. You (the calling AI) are responsible for the query rewrite: this tool never calls an LLM of its own.',
          '',
          'Build the arguments like this:',
          '1. query — one complete natural-language sentence expressing the real information need of the user, used verbatim as the embedding input for cross-lingual semantic search. Do not reduce it to loose tokens. Writing it as an English phrasing followed by " / " and the Chinese phrasing is recommended, so the embedding sees both surface forms.',
          `2. keywords — precise domain terms covering BOTH Chinese and English: the core concepts, their standard technical translations, common synonyms, and field abbreviations. For best results, providing about 5-12 relevant Chinese and/or English keywords is recommended; this is guidance, not a constraint — any number from 1 to ${MAX_HYBRID_KEYWORDS} is accepted. All of them are matched in a single pass over the candidate records (title, abstract, creator, publication title, tags), then scored by term specificity, field weight and how many distinct keywords each record matched, so short exact terms work far better than long sentences and extra keywords cost almost nothing.`,
          '',
          'Worked example — user asks "温度梯度如何影响定向凝固中的柱状晶转变？":',
          '  query: "Effects of temperature gradient on columnar-to-equiaxed transition during directional solidification / 温度梯度对定向凝固柱状晶-等轴晶转变的影响"',
          '  keywords: ["温度梯度", "定向凝固", "柱状晶", "等轴晶", "柱状晶-等轴晶转变", "temperature gradient", "directional solidification", "columnar grain", "equiaxed grain", "columnar-to-equiaxed transition", "CET"]',
          '',
          'Leave language at its "all" default so retrieval stays genuinely cross-lingual; the other language values only narrow recall. Return these literature matches directly when the user only asks which documents are relevant; call search_fulltext with the matched itemKeys only when the user asks for passages, evidence, or full-text details.',
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Complete natural-language sentence describing the information need, embedded as-is for cross-lingual semantic search. Not a token list. Include both an English and a Chinese phrasing (separated by " / ") so the embedding covers both.'
            },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: MAX_SUPPLIED_KEYWORDS,
              description: `Optional lexical probes for the keyword branch: precise Chinese AND English domain terms, technical translations, synonyms and abbreviations. For best results, it is recommended to provide 5-12 relevant Chinese and/or English keywords. Fewer or more keywords are still allowed within the implemented input limit of 1 to ${MAX_HYBRID_KEYWORDS} entries. Always supply both scripts regardless of the language the user asked in. All keywords are matched together in one pass over title, abstract, creator, publicationTitle and tags, and ranked by term specificity, field weight and keyword coverage, so a broad word cannot outrank a discriminative phrase. Omitting this falls back to splitting the query, which can only probe the language the user typed in and is scored at a lower weight.`
            },
            topK: {
              type: 'number',
              description: 'Number of fused results to return (default: 10)'
            },
            candidateK: {
              type: 'number',
              description: 'Candidates retrieved from each branch before fusion (default: max(topK * 3, 20))'
            },
            minScore: {
              type: 'number',
              description: 'Minimum semantic similarity score 0-1 (default: 0.3)'
            },
            language: {
              type: 'string',
              enum: ['zh', 'en', 'all', 'auto'],
              description: 'Semantic branch language filter. Keep the "all" default for genuinely cross-lingual recall; "zh"/"en" restrict the index to that language and "auto" restricts it to the detected query language, both of which drop literature written in the other language. Only set this when the user explicitly asks for one language.'
            },
            rrfK: {
              type: 'number',
              description: 'RRF rank constant (default: 60)'
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
            semanticTimeoutMs: {
              type: 'number',
              minimum: 1,
              description: 'Semantic branch deadline in milliseconds (default: 8000)'
            },
            totalTimeoutMs: {
              type: 'number',
              minimum: 1,
              description: 'Overall hybrid retrieval deadline in milliseconds (default: 10000)'
            }
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
        description: 'SECOND-STAGE search within full text of specific documents already located by hybrid_search. itemKeys is required; unscoped whole-library full-text scanning is disabled. Use only when the user asks for passages, evidence, or full-text details.',
        inputSchema: {
          type: 'object',
          properties: {
            libraryID: {
              type: 'number',
              description: 'Optional target Zotero library ID. Defaults to the user library when omitted.'
            },
            q: { type: 'string', description: 'Search query' },
            itemKeys: { 
              type: 'array', 
              items: { type: 'string' },
              minItems: 1,
              description: 'Item keys returned by hybrid_search (required)'
            },
            mode: {
              type: 'string',
              enum: ['minimal', 'preview', 'standard', 'complete'],
              description: 'Processing mode: minimal (100 context), preview (200), standard (adaptive), complete (400+). Uses user default if not specified.'
            },
            contextLength: { type: 'number', description: 'Context length around matches (overrides mode default)' },
            maxResults: { type: 'number', description: 'Maximum results to return (overrides mode default)' },
            caseSensitive: { type: 'boolean', description: 'Case sensitive search (default: false)' },
          },
          required: ['q', 'itemKeys'],
        },
      },
      {
        name: 'get_item_abstract',
        description: 'Get the abstract/summary of a specific item. Typically the author\'s own summary from the original publication.',
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
        description: 'Find items semantically similar to a given item using AI embeddings. Useful for expanding research from a known relevant paper and discovering thematic clusters.',
        inputSchema: {
          type: 'object',
          properties: {
            itemKey: {
              type: 'string',
              description: 'The item key to find similar items for'
            },
            topK: {
              type: 'number',
              description: 'Number of similar items to return (default: 5)'
            },
            minScore: {
              type: 'number',
              description: 'Minimum similarity score 0-1 (default: 0.3)'
            },
            libraryID: {
              type: 'number',
              description: 'Zotero library ID (default: user library)'
            },
            timeoutMs: {
              type: 'number',
              minimum: 1,
              description: 'Total similarity search deadline in milliseconds (default: 8000)'
            }
          },
          required: ['itemKey']
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
        description: 'Access the cached full-text database (read-only). The search action is second-stage only and requires itemKeys returned by hybrid_search; unscoped whole-library content scanning is disabled. Actions: list, search, get, stats.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'search', 'get', 'stats'],
              description: 'Action: list (show cached items), search (search within content), get (get full content), stats (database statistics)'
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

    return this.createResponse(request.id ?? null, { tools: finalTools });
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
            throw new Error('search_library.fulltext is disabled. Use hybrid_search first, then search_fulltext with matched itemKeys');
          }
          result = await this.callSearchLibrary(args);
          break;

        case 'hybrid_search':
          if (typeof args?.query !== 'string' || !args.query.trim()) {
            throw new Error('query is required');
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

        case 'search_fulltext':
          if (!args?.q) {
            throw new Error('q (query) is required');
          }
          {
            const fulltextItemKeys = this.coerceStringArray(args?.itemKeys);
            if (!fulltextItemKeys || fulltextItemKeys.length === 0) {
              throw new Error('itemKeys from hybrid_search are required; whole-library full-text scanning is disabled');
            }
            result = await this.callSearchFulltext({
              ...args,
              itemKeys: fulltextItemKeys
            });
          }
          break;

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
            if (!args?.itemKey) throw new Error('itemKey is required');
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
    const topK = args.topK ?? 10;
    const candidateK = args.candidateK ?? Math.max(topK * 3, 20);
    const minScore = args.minScore ?? 0.3;
    const language = args.language ?? 'all';
    const libraryID =
      args.libraryID ?? Zotero.Libraries.userLibraryID;
    this.validateSearchParameters({
      query: args.query,
      topK,
      candidateK,
      minScore,
      language,
      libraryID,
    });
    // The caller supplies bilingual keywords; when it does not we derive probes
    // from the query, which can only cover the language the user typed in.
    const {
      keywords: lexicalKeywords,
      entries: lexicalKeywordEntries,
      source: keywordSource,
    } = resolveHybridKeywords(args.query, args.keywords);
    const options: HybridSearchOptions = {
      keywords: lexicalKeywords,
      topK,
      candidateK,
      rrfK: args.rrfK ?? 60,
      keywordWeight: args.keywordWeight ?? 1,
      semanticWeight: args.semanticWeight ?? 1,
      semanticTimeoutMs: args.semanticTimeoutMs,
      totalTimeoutMs: args.totalTimeoutMs,
    };
    const totalTimeoutMs = args.totalTimeoutMs ?? DEFAULT_HYBRID_TIMEOUT_MS;
    const semanticTimeoutMs = Math.min(
      args.semanticTimeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS,
      totalTimeoutMs,
    );
    const hybridStartedAt = Date.now();
    const semanticEnabled = Zotero.Prefs.get(
      'extensions.zotero.zotero-mcp-plugin.semantic.enabled',
      true,
    ) !== false;

    // Both branches must be able to stop, not just be stopped waiting for:
    // an abandoned embedding request or library scan would otherwise keep
    // burning time (and API quota) after the hybrid deadline has passed.
    const semanticAbort =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
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
            candidateK: options.candidateK,
            // Stop a little before the hybrid deadline so a partial, ranked
            // candidate set still reaches fusion instead of the branch being
            // killed outright and hybrid silently degrading to semantic-only.
            deadlineAt:
              hybridStartedAt + Math.max(1000, Math.floor(totalTimeoutMs * 0.85)),
            isCancelled: () => lexicalCancelled,
          });
          lexicalDiagnostics = outcome.diagnostics;
          ztoolkit.log(
            `[StreamableMCP][Lexical] strategy=${outcome.diagnostics.strategy} candidates=${outcome.diagnostics.candidateIDs} scanned=${outcome.diagnostics.scannedItems} truncated=${outcome.diagnostics.truncated} prioritized=${outcome.diagnostics.prioritized} search=${outcome.diagnostics.searchMs}ms scan=${outcome.diagnostics.scanMs}ms rank=${outcome.diagnostics.rankMs}ms total=${outcome.diagnostics.totalMs}ms keywords=${lexicalKeywordEntries.length}`,
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
            topK: options.candidateK,
            minScore,
            language,
            libraryID,
            timeoutMs: semanticTimeoutMs,
            signal: semanticAbort?.signal,
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
      `[StreamableMCP][HybridTiming] lexical=${searchResult.timings.keywordMs}ms semantic=${searchResult.timings.semanticMs}ms rrf=${searchResult.timings.rrfMs}ms total=${searchResult.timings.totalMs}ms keywords=${lexicalKeywords.length}(${keywordSource}) lexicalCandidates=${diagnostics?.candidateIDs ?? 0} lexicalScanned=${diagnostics?.scannedItems ?? 0} libraryID=${libraryID}`,
    );

    const hybridWarnings = [...searchResult.warnings];
    if (keywordSource === 'fallback') {
      hybridWarnings.push(
        `keywords were not supplied, so the lexical branch was derived from the query and only covers the language it was written in. Pass bilingual Chinese and English keywords to recall literature in both languages; around 5-12 keywords is the recommended amount for best results, and any number from 1 to ${MAX_HYBRID_KEYWORDS} is accepted.`,
      );
    }
    if (diagnostics?.failedKeywords.length) {
      hybridWarnings.push(
        `Keyword probes failed and were skipped: ${diagnostics.failedKeywords.join(', ')}`,
      );
    }
    if (diagnostics?.truncated) {
      hybridWarnings.push(
        diagnostics.prioritized
          ? 'The lexical candidate set exceeded the candidate cap and was reduced to the items matching the most keywords. Pass fewer, more specific keywords for complete lexical coverage.'
          : 'The lexical candidate set was truncated because it hit the candidate cap or the hybrid deadline. Pass fewer, more specific keywords for complete lexical coverage.',
      );
    }

    return {
      mode: 'hybrid',
      query: args.query,
      keywords: lexicalKeywords,
      data: searchResult.results,
      metadata: {
        extractedAt: new Date().toISOString(),
        searchMode: 'hybrid',
        fusion: 'weighted_rrf',
        keywordSource,
        keywordCount: lexicalKeywords.length,
        keywordWeights: lexicalKeywordEntries.map((entry) => ({
          keyword: entry.text,
          weight: entry.weight,
          origin: entry.origin,
        })),
        lexicalStrategy: diagnostics?.strategy,
        lexicalCandidateCount: diagnostics?.candidateIDs ?? 0,
        lexicalScannedCount: diagnostics?.scannedItems ?? 0,
        lexicalTruncated: diagnostics?.truncated ?? false,
        lexicalPrioritized: diagnostics?.prioritized ?? false,
        failedKeywords: diagnostics?.failedKeywords ?? [],
        keywordCoverageBonus: HYBRID_KEYWORD_COVERAGE_BONUS,
        lexicalFieldWeights: LEXICAL_FIELD_WEIGHTS,
        language,
        rrfK: options.rrfK,
        keywordWeight: options.keywordWeight,
        semanticWeight: options.semanticWeight,
        candidateK: options.candidateK,
        resultCount: searchResult.results.length,
        keywordResultCount: searchResult.keywordResultCount,
        semanticResultCount: searchResult.semanticResultCount,
        degraded: searchResult.degraded,
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
        nextStep: 'Return these matches directly unless the user requests passages, evidence, or full-text details; then call search_fulltext with selected itemKeys.',
      },
    };
  }

  private validateSearchParameters(params: {
    query?: unknown;
    topK: unknown;
    candidateK?: unknown;
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
      Number(params.topK) > 100
    ) {
      throw new Error('topK must be an integer between 1 and 100');
    }
    if (
      params.candidateK !== undefined &&
      (!Number.isInteger(params.candidateK) ||
        Number(params.candidateK) < Number(params.topK) ||
        Number(params.candidateK) > 500)
    ) {
      throw new Error(
        'candidateK must be an integer between topK and 500',
      );
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

  private async callSearchFulltext(args: any): Promise<any> {
    // Apply mode-based defaults before creating search params
    const effectiveMode = args.mode || MCPSettingsService.get('content.mode');
    const modeConfig = this.getFulltextModeConfiguration(effectiveMode);
    
    // Apply mode defaults if not explicitly provided
    const processedArgs = {
      ...args,
      contextLength: args.contextLength || modeConfig.contextLength,
      maxResults: args.maxResults || modeConfig.maxResults
    };
    
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(processedArgs)) {
      if (value !== undefined && value !== null) {
        if (key === 'itemKeys' && Array.isArray(value)) {
          searchParams.append(key, value.join(','));
        } else if (key !== 'mode') { // Don't pass mode to API
          searchParams.append(key, String(value));
        }
      }
    }
    
    const response = await handleSearchFulltext(searchParams);
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
      const timeoutMs = args.timeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS;
      this.validateSearchParameters({
        query: args.query,
        topK,
        minScore,
        language,
        libraryID,
        timeoutMs,
      });
      const semanticService = getSemanticSearchService();

      const results = await runWithTimeout(
        () =>
          semanticService.search(args.query, {
            topK,
            minScore,
            language,
            libraryID,
            timeoutMs,
          }),
        timeoutMs,
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

  private async callFindSimilar(args: any): Promise<any> {
    try {
      const topK = args.topK ?? 5;
      const minScore = args.minScore ?? 0.3;
      const libraryID =
        args.libraryID ?? Zotero.Libraries.userLibraryID;
      const timeoutMs = args.timeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS;
      this.validateSearchParameters({
        topK,
        minScore,
        libraryID,
        timeoutMs,
      });
      const semanticService = getSemanticSearchService();

      const results = await runWithTimeout(
        () =>
          semanticService.findSimilar(args.itemKey, {
            topK,
            minScore,
            libraryID,
            timeoutMs,
          }),
        timeoutMs,
        'Similarity search',
      );

      const response = {
        mode: 'similar',
        sourceItemKey: args.itemKey,
        data: results,
        metadata: {
          extractedAt: new Date().toISOString(),
          resultCount: results.length
        }
      };

      return response;
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Find similar error: ${error}`, 'error');
      throw error;
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

      // Add Int8 migration suggestion if needed
      if (int8Status?.needed) {
        message += `. WARNING: ${int8Status.count}/${int8Status.total} vectors need Int8 migration for ~6x faster search. Run migrate_int8 to optimize.`;
      }

      return {
        ready: isReady,
        initialized: stats?.serviceStatus.initialized || false,
        fallbackMode: stats?.serviceStatus.fallbackMode || false,
        indexProgress: progress,
        indexStats: stats?.indexStats || null,
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
      const { getVectorStore } = await import('./semantic/vectorStore');
      const vectorStore = getVectorStore();
      await vectorStore.initialize();

      const { action, query, itemKeys, limit = 20, caseSensitive = false } = args;

      switch (action) {
        case 'list': {
          const cachedItems = await vectorStore.listCachedContent();
          const limitedItems = cachedItems.slice(0, limit);

          return {
            action: 'list',
            data: limitedItems,
            metadata: {
              extractedAt: new Date().toISOString(),
              totalCached: cachedItems.length,
              returned: limitedItems.length,
              message: `Found ${cachedItems.length} items in full-text database`
            }
          };
        }

        case 'search': {
          if (!query) {
            throw new Error('query is required for search action');
          }

          if (!itemKeys || itemKeys.length === 0) {
            throw new Error('itemKeys is required for search action; whole-library full-text scanning is disabled');
          }
          const searchResults = await vectorStore.searchCachedContent(query, {
            limit,
            caseSensitive,
            itemKeys,
          });

          return {
            action: 'search',
            query,
            data: searchResults,
            metadata: {
              extractedAt: new Date().toISOString(),
              resultCount: searchResults.length,
              caseSensitive,
              message: `Found ${searchResults.length} items matching "${query}"`
            }
          };
        }

        case 'get': {
          if (!itemKeys || itemKeys.length === 0) {
            throw new Error('itemKeys is required for get action');
          }

          const contentMap = await vectorStore.getFullContentBatch(itemKeys);
          const results: Array<{ itemKey: string; content: string | null; contentLength: number }> = [];

          for (const key of itemKeys) {
            const content = contentMap.get(key) || null;
            results.push({
              itemKey: key,
              content,
              contentLength: content ? content.length : 0
            });
          }

          return {
            action: 'get',
            data: results,
            metadata: {
              extractedAt: new Date().toISOString(),
              requested: itemKeys.length,
              found: results.filter(r => r.content !== null).length,
              message: `Retrieved content for ${results.filter(r => r.content !== null).length}/${itemKeys.length} items`
            }
          };
        }

        case 'stats': {
          const stats = await vectorStore.getStats();

          // Format size nicely
          const formatSize = (bytes: number) => {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
          };

          return {
            action: 'stats',
            data: {
              cachedItems: stats.cachedContentItems,
              cachedContentSize: stats.cachedContentSizeBytes,
              cachedContentSizeFormatted: formatSize(stats.cachedContentSizeBytes),
              indexedItems: stats.totalItems,
              totalVectors: stats.totalVectors,
              zhVectors: stats.zhVectors,
              enVectors: stats.enVectors
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Full-text database: ${stats.cachedContentItems} items, ${formatSize(stats.cachedContentSizeBytes)}`
            }
          };
        }

        default:
          throw new Error(`Unknown action: ${action}. Use list, search, get, or stats. Database management is done through Zotero preferences.`);
      }
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
      availableTools: [
        'hybrid_search',
        'get_libraries',
        'search_libraries',
        'search_library',
        'search_annotations',
        'get_item_details',
        'get_annotations',
        'get_content',
        'get_collections',
        'search_collections',
        'get_collection_details',
        'get_collection_items',
        'search_fulltext',
        'get_item_abstract',
        // Semantic Search Tools (read-only)
        'semantic_search',
        'find_similar',
        'semantic_status',
        // Full-text Database Tool (read-only)
        'fulltext_database',
        // Write Tools
        'write_note',
        'write_tag',
        'write_metadata',
        'write_item'
      ],
      transport: {
        type: "streamable-http",
        keepAliveSupported: false,
        maxConnections: 100
      }
    };
  }

  /**
   * Get fulltext search mode configuration
   */
  private getFulltextModeConfiguration(mode: string): any {
    const modeConfigs = {
      'minimal': {
        contextLength: 100,
        maxResults: 20
      },
      'preview': {
        contextLength: 200,
        maxResults: 50  
      },
      'standard': {
        contextLength: 250,
        maxResults: 100
      },
      'complete': {
        contextLength: 400,
        maxResults: 200
      }
    };

    return modeConfigs[mode as keyof typeof modeConfigs] || modeConfigs['standard'];
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
