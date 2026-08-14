import { StreamableMCPServer } from "./streamableMCPServer";
import { serverPreferences } from "./serverPreferences";
import { testMCPIntegration } from "./mcpTest";
import {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  checkProtocolVersionHeader,
  getMCPMethodResponse,
} from "./mcpTransport";
import { checkRequestAccess } from "./httpAccessControl";
import {
  readHttpRequest,
  utf8Decode,
  utf8Encode,
  writeAllBytes,
} from "./httpFraming";
import { MAX_HYBRID_KEYWORDS } from "./hybridSearch";
import { sanitizeForPrivacy } from "../utils/privacy";
import { config } from "../../package.json";

declare let ztoolkit: ZToolkit;

/** 读取/写出请求时的时间上限，防止任何一条连接无限期挂着。 */
const REQUEST_IDLE_TIMEOUT_MS = 15000;
const REQUEST_TOTAL_TIMEOUT_MS = 60000;
const RESPONSE_WRITE_TIMEOUT_MS = 60000;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** 单次 write 的切片上限，避免给非阻塞管道一次塞进过大的字符串。 */
const WRITE_SLICE_BYTES = 32 * 1024;

/** 请求流水号：把同一次调用的读取、分发、写出三段日志串起来。 */
let requestSequence = 0;

/** 请求体的头尾预览，只用于诊断，不记录完整内容。 */
function bodyPreview(body: string): string {
  const clean = (value: string) => value.replace(/\s+/g, " ");
  if (body.length <= 90) return `"${clean(body)}"`;
  return `"${clean(body.substring(0, 60))}"..."${clean(body.substring(body.length - 30))}"`;
}

export class HttpServer {
  public static testServer() {
    Zotero.debug("Static testServer method called.");
  }
  private serverSocket: any;
  private isRunning: boolean = false;
  private mcpServer: StreamableMCPServer | null = null;
  private port: number = 8080;
  private activeSessions: Map<string, { createdAt: Date; lastActivity: Date; }> = new Map();
  private keepAliveTimeout: number = 30000; // 30 seconds
  private sessionTimeout: number = 300000; // 5 minutes
  private sessionCleanupInterval: ReturnType<typeof setInterval> | null = null;
  // Track active transports to close them on shutdown
  private activeTransports: Set<any> = new Set();
  // 记录当前实际绑定的监听参数，供设置变更时判断是否需要重新绑定。
  // 只看 isRunning 无法区分 "已在跑" 和 "在跑但绑错了地址/端口"。
  private boundPort: number | null = null;
  private boundLoopbackOnly: boolean | null = null;

  public isServerRunning(): boolean {
    return this.isRunning;
  }

  /** 当前实际监听的端口；未运行时为 null。 */
  public getBoundPort(): number | null {
    return this.isRunning ? this.boundPort : null;
  }

  public clearSemanticState(): void {
    this.mcpServer?.clearSemanticState();
  }

  /** 当前是否仅绑定回环地址；未运行时为 null。 */
  public isBoundLoopbackOnly(): boolean | null {
    return this.isRunning ? this.boundLoopbackOnly : null;
  }

  public start(port: number) {
    // 进程诊断
    try {
      const pid = (Cc["@mozilla.org/xre/app-info;1"]?.getService(Ci.nsIXULRuntime) as any)?.processID;
      ztoolkit.log(`[HttpServer] start() called - port: ${port}, PID: ${pid}, isRunning: ${this.isRunning}`);
    } catch (e) {
      ztoolkit.log(`[HttpServer] start() called - port: ${port}, isRunning: ${this.isRunning}`);
    }

    if (this.isRunning) {
      ztoolkit.log("[HttpServer] Server is already running, skipping start");
      return;
    }

    if (!port || isNaN(port) || port < 1 || port > 65535) {
      const errorMsg = `[HttpServer] Invalid port number: ${port}. Port must be between 1 and 65535.`;
      ztoolkit.log(errorMsg, 'error');
      throw new Error(errorMsg);
    }

    try {
      this.port = port;
      ztoolkit.log(`[HttpServer] Attempting to start server on port ${port}...`);

      this.serverSocket = Cc[
        "@mozilla.org/network/server-socket;1"
      ].createInstance(Ci.nsIServerSocket);

      // init方法参数：端口，是否仅允许回环地址，backlog队列大小
      // loopbackOnly=true: 仅监听 127.0.0.1
      // loopbackOnly=false: 监听 0.0.0.0 (所有接口)
      const loopbackOnly = !serverPreferences.isRemoteAccessAllowed();
      Zotero.debug(`[HttpServer] Binding to ${loopbackOnly ? '127.0.0.1' : '0.0.0.0'}:${port}`);
      this.serverSocket.init(port, loopbackOnly, -1);
      this.serverSocket.asyncListen(this.listener);
      this.isRunning = true;
      this.boundPort = port;
      this.boundLoopbackOnly = loopbackOnly;

      if (!loopbackOnly) {
        // 监听 0.0.0.0 时令牌是唯一屏障，确保它存在。
        try {
          serverPreferences.ensureAuthToken();
        } catch (tokenError) {
          ztoolkit.log(`[HttpServer] Failed to ensure MCP access token: ${tokenError}`, 'error');
        }
      }

      Zotero.debug(
        `[HttpServer] Successfully started HTTP server on port ${port}`,
      );

      // Initialize integrated MCP server if enabled
      this.initializeMCPServer();
      
      // Start session cleanup timer
      this.startSessionCleanup();
    } catch (e) {
      const errorMsg = `[HttpServer] Failed to start server on port ${port}: ${e}`;
      Zotero.debug(errorMsg);
      this.stop();
      throw new Error(errorMsg);
    }
  }

  private initializeMCPServer(): void {
    try {
      this.mcpServer = new StreamableMCPServer();
      ztoolkit.log(`[HttpServer] Integrated MCP server initialized`);
    } catch (error) {
      ztoolkit.log(`[HttpServer] Failed to initialize MCP server: ${error}`);
      // Don't throw error, HTTP server can still work without MCP
    }
  }

  public stop() {
    ztoolkit.log(`[HttpServer] stop() called - isRunning: ${this.isRunning}, hasSocket: ${!!this.serverSocket}`);

    if (!this.isRunning || !this.serverSocket) {
      ztoolkit.log("[HttpServer] Server is not running, nothing to stop");
      return;
    }

    // Stop session cleanup timer FIRST to prevent new cleanup cycles
    ztoolkit.log("[HttpServer] Stopping session cleanup timer...");
    this.stopSessionCleanup();

    // Close all active transports
    ztoolkit.log(`[HttpServer] Closing ${this.activeTransports.size} active transport connections...`);
    for (const transport of this.activeTransports) {
      try {
        transport.close(0);
      } catch (e) {
        // Ignore errors when closing individual transports
      }
    }
    this.activeTransports.clear();
    ztoolkit.log("[HttpServer] All transports closed");

    // Close server socket
    try {
      ztoolkit.log("[HttpServer] Closing server socket...");
      this.serverSocket.close();
      this.isRunning = false;
      ztoolkit.log("[HttpServer] Server socket closed successfully");
    } catch (e) {
      ztoolkit.log(`[HttpServer] Error closing server socket: ${e}`, 'error');
      this.isRunning = false;
    }

    this.boundPort = null;
    this.boundLoopbackOnly = null;

    // Clear active sessions
    this.activeSessions.clear();

    // Clean up MCP server
    this.cleanupMCPServer();
    ztoolkit.log("[HttpServer] stop() complete");
  }

  private cleanupMCPServer(): void {
    if (this.mcpServer) {
      this.mcpServer = null;
      ztoolkit.log("[HttpServer] MCP server cleaned up");
    }
  }

  /**
   * Generate a unique session ID for MCP connections
   */
  private generateSessionId(): string {
    return 'mcp-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Start session cleanup timer to remove expired sessions
   */
  private startSessionCleanup(): void {
    // Clear any existing interval first
    this.stopSessionCleanup();

    this.sessionCleanupInterval = setInterval(() => {
      const now = new Date();
      for (const [sessionId, session] of this.activeSessions.entries()) {
        if (now.getTime() - session.lastActivity.getTime() > this.sessionTimeout) {
          this.activeSessions.delete(sessionId);
          ztoolkit.log(`[HttpServer] Cleaned up expired session: ${sessionId}`);
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Stop session cleanup timer
   */
  private stopSessionCleanup(): void {
    if (this.sessionCleanupInterval) {
      clearInterval(this.sessionCleanupInterval);
      this.sessionCleanupInterval = null;
      ztoolkit.log(`[HttpServer] Session cleanup timer stopped`);
    }
  }

  /**
   * Update session activity
   */
  private updateSessionActivity(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
    }
  }

  /**
   * Determine if connection should be kept alive based on request
   *
   * 监听器对每条 socket 只处理一个请求，并在 finally 里关流，因此永远不能
   * 对外宣称 keep-alive：客户端把这条连接留在池里复用，实际早已被服务端
   * 关掉，下一个请求就会撞上一个死连接。
   */
  private shouldKeepAlive(
    _headers: Map<string, string>,
    _path: string,
  ): boolean {
    return false;
  }

  /**
   * Build appropriate HTTP headers with session and connection management
   */
  private buildHttpHeaders(result: any, keepAlive: boolean, sessionId?: string): string {
    const baseHeaders = `HTTP/1.1 ${result.status} ${result.statusText}\r\n` +
      `Content-Type: ${result.headers?.["Content-Type"] || "application/json; charset=utf-8"}\r\n`;
    
    let headers = baseHeaders;

    for (const [name, value] of Object.entries(result.headers || {})) {
      if (
        name.toLowerCase() === "content-type" ||
        name.toLowerCase() === "content-length" ||
        name.toLowerCase() === "connection"
      ) {
        continue;
      }
      headers += `${name}: ${String(value)}\r\n`;
    }
    
    // Add session ID for MCP requests
    if (sessionId) {
      headers += `Mcp-Session-Id: ${sessionId}\r\n`;
    }
    
    // Add connection management headers
    if (keepAlive) {
      headers += `Connection: keep-alive\r\n` +
        `Keep-Alive: timeout=${this.keepAliveTimeout / 1000}, max=100\r\n`;
    } else {
      headers += `Connection: close\r\n`;
    }
    
    return headers;
  }

  /**
   * 把一个 {status, headers, body} 结果完整写回输出流。
   *
   * Content-Length 取真正的 UTF-8 字节串长度，正文也按同一串字节写出，
   * 并且一直写到最后一个字节为止（writeAllBytes 负责处理部分写）——
   * 响应头声明多少字节，客户端就一定收得到多少字节。
   */
  private async writeResult(
    output: any,
    result: { status: number; statusText: string; headers?: Record<string, string>; body: string },
    keepAlive: boolean,
    sessionId?: string,
    requestId = 0,
    state?: { started: boolean },
  ): Promise<void> {
    // 一条连接只能有一个响应。标记必须在写出任何字节之前置位，
    // 否则写到一半失败时，错误分支会把第二份响应头接在正文后面，
    // 客户端按 Content-Length 读到的就是一段被污染的 JSON。
    if (state) state.started = true;
    const bodyBytes = utf8Encode(result.body || "");
    const headers = this.buildHttpHeaders(result, keepAlive, sessionId) +
      `Content-Length: ${bodyBytes.length}\r\n` +
      "\r\n";

    ztoolkit.log(
      `[HttpServer] #${requestId} response start: ${result.status} ${result.statusText}, body ${bodyBytes.length}B`,
    );

    const written = await writeAllBytes(
      output,
      headers + bodyBytes,
      Date.now() + RESPONSE_WRITE_TIMEOUT_MS,
      WRITE_SLICE_BYTES,
    );

    try {
      output.flush();
    } catch (flushError) {
      // Some streams don't support flush, ignore
    }

    ztoolkit.log(
      `[HttpServer] #${requestId} response end: ${written}B written (headers ${headers.length}B + body ${bodyBytes.length}B)`,
    );
  }

  private listener = {
    onSocketAccepted: async (_socket: any, transport: any) => {
      let input: any = null;
      let output: any = null;
      let sin: any = null;
      const requestId = (requestSequence += 1);
      const acceptedAt = Date.now();
      const responseState = { started: false };

      // Track this transport for cleanup on shutdown
      this.activeTransports.add(transport);

      ztoolkit.log(
        `[HttpServer] #${requestId} connection accepted from ${transport.host || "unknown"}:${transport.port || "unknown"}`,
      );

      try {
        input = transport.openInputStream(0, 0, 0);
        output = transport.openOutputStream(0, 0, 0);

        // 只用 nsIScriptableInputStream 拿原始字节；不再叠加
        // nsIConverterInputStream，两者混用会让已被转换流吞进内部缓冲区的
        // 字节丢失或错序。
        sin = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
          Ci.nsIScriptableInputStream,
        );
        sin.init(input);

        const { raw, frame, outcome } = await readHttpRequest(input, sin, {
          idleTimeoutMs: REQUEST_IDLE_TIMEOUT_MS,
          totalTimeoutMs: REQUEST_TOTAL_TIMEOUT_MS,
          maxBytes: MAX_REQUEST_BYTES,
        });

        // 诊断：一次请求一行，只记长度与头尾片段，不记完整请求体。
        ztoolkit.log(
          `[HttpServer] #${requestId} read=${outcome} line="${frame.requestLine || "<none>"}" ` +
            `raw=${raw.length}B ct=${frame.headers.get("content-type") || "-"} ` +
            `cl=${frame.contentLength} te=${frame.headers.get("transfer-encoding") || "-"} ` +
            `bodyRecv=${frame.bodyBytesReceived}B trailing=${frame.trailingBytes}B ` +
            `in=${Date.now() - acceptedAt}ms${frame.error ? ` frameError=${frame.error}` : ""}`,
        );

        if (outcome === "empty") {
          // 端口探活 / 连接池预热：一个字节都没发，安静关闭即可。
          ztoolkit.log(
            `[HttpServer] #${requestId} empty connection (probe), closing without response`,
          );
          return;
        }

        const requestLine = frame.requestLine;
        const requestParts = requestLine.split(" ");
        const method = requestParts[0];
        const rawPath = requestParts[1];

        // 验证请求格式
        if (!requestLine.includes("HTTP/") || !method || !rawPath) {
          ztoolkit.log(
            `[HttpServer] #${requestId} invalid request line: "${requestLine.substring(0, 120)}" (${raw.length}B read)`,
            "error",
          );
          await this.writeResult(
            output,
            {
              status: 400,
              statusText: "Bad Request",
              headers: { "Content-Type": "text/plain; charset=utf-8" },
              body: "Bad Request",
            },
            false,
            undefined,
            requestId,
            responseState,
          );
          return;
        }

        const url = new URL(rawPath, "http://127.0.0.1");
        const path = url.pathname;
        const headers = frame.headers;
        const isMCPPath =
          path === "/mcp" ||
          (path.startsWith("/mcp/") && !path.includes(".well-known"));

        // 请求没收全就绝不往下走：截断的请求体交给 JSON.parse 只会得到一个
        // 误导性的 -32700，真正的问题是传输层没读完。
        if (outcome !== "complete") {
          const detail =
            outcome === "too-large"
              ? `request exceeds ${MAX_REQUEST_BYTES} bytes`
              : frame.error
                ? frame.error
                : `incomplete request body: received ${frame.bodyBytesReceived} of ${frame.contentLength >= 0 ? frame.contentLength : "unknown"} bytes (${outcome})`;
          const status = outcome === "too-large" ? 413 : 400;
          ztoolkit.log(
            `[HttpServer] #${requestId} ${status} - ${detail}`,
            "error",
          );
          await this.writeResult(
            output,
            {
              status,
              statusText: status === 413 ? "Payload Too Large" : "Bad Request",
              headers: { "Content-Type": "application/json; charset=utf-8" },
              body: isMCPPath
                ? JSON.stringify({
                    jsonrpc: "2.0",
                    id: null,
                    error: { code: -32600, message: `Invalid Request: ${detail}` },
                  })
                : JSON.stringify({ error: detail }),
            },
            false,
            undefined,
            requestId,
            responseState,
          );
          return;
        }

        if (frame.trailingBytes > 0) {
          // 本服务器对每条连接只处理一个请求并回 Connection: close，
          // 流水线过来的第二个请求不会被执行，必须显式记录而不是默默丢弃。
          ztoolkit.log(
            `[HttpServer] #${requestId} ${frame.trailingBytes} extra bytes after the request body were not processed (pipelining is not supported)`,
            "warn",
          );
        }

        try {
          // 访问控制先于任何业务处理：Origin/Host 防跨源与 DNS rebinding，
          // Bearer Token 在开启远程访问（或用户显式要求鉴权）时强制生效。
          const accessFailure = checkRequestAccess(path, headers);
          if (accessFailure) {
            ztoolkit.log(
              `[HttpServer] #${requestId} rejected by access control: ${method} ${path} -> ${accessFailure.status}`,
              "warn",
            );
            await this.writeResult(
              output,
              accessFailure,
              false,
              undefined,
              requestId,
              responseState,
            );
            return;
          }

          // 请求体到这里才做一次 UTF-8 解码：字节已经确认收全。
          const requestBody = method === "POST" ? utf8Decode(frame.body) : "";
          if (requestBody) {
            ztoolkit.log(
              `[HttpServer] #${requestId} body decoded: ${frame.body.length}B -> ${requestBody.length} chars ${bodyPreview(requestBody)}`,
            );
          }

          // Extract existing session ID or create new one for MCP requests
          const sessionId: string | undefined = undefined;
          const incomingSessionId = headers.get("mcp-session-id");
          if (isMCPPath && incomingSessionId) {
            this.updateSessionActivity(incomingSessionId.trim());
            ztoolkit.log(
              `[HttpServer] #${requestId} client MCP session header: ${incomingSessionId.trim()}`,
            );
          }

          // Determine if connection should be kept alive
          const keepAlive = this.shouldKeepAlive(headers, path);

          let result;

          if (path === "/mcp") {
            // MCP 2025-06-18: 初始化之后的请求需要带 MCP-Protocol-Version，
            // 缺失按 2025-03-26 处理，出现无法识别的版本直接 400。
            const versionFailure = checkProtocolVersionHeader(
              headers.get("mcp-protocol-version"),
            );
            const methodResponse = getMCPMethodResponse(
              method,
              Boolean(this.mcpServer),
            );
            if (versionFailure) {
              result = versionFailure;
            } else if (methodResponse) {
              result = methodResponse;
            } else {
              // Handle MCP requests via streamable HTTP
              result = await this.mcpServer!.handleMCPRequest(requestBody, requestId);
            }
          } else if (path === "/mcp/status") {
            // MCP server status endpoint
            if (this.mcpServer) {
              result = {
                status: 200,
                statusText: "OK",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify(sanitizeForPrivacy(this.mcpServer.getStatus())),
              };
            } else {
              result = {
                status: 503,
                statusText: "Service Unavailable",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify({ error: "MCP server not enabled", enabled: false }),
              };
            }
          } else if (path === "/mcp/capabilities" || path === "/capabilities" || path === "/help") {
            // Comprehensive capabilities discovery endpoint
            result = {
              status: 200,
              statusText: "OK",
              headers: { "Content-Type": "application/json; charset=utf-8" },
              // 该文档端点目前只含静态描述，但统一走 sanitizer，
              // 以免日后往里加动态字段时又开出一个绕过口子。
              body: JSON.stringify(sanitizeForPrivacy(this.getCapabilities())),
            };
          } else if (path === "/test/mcp") {
            const testResult = await testMCPIntegration();
            result = {
              status: 200,
              statusText: "OK",
              headers: { "Content-Type": "application/json; charset=utf-8" },
              body: JSON.stringify(sanitizeForPrivacy(testResult)),
            };
          } else if (path.startsWith("/ping")) {
            result = {
              status: 200,
              statusText: "OK",
              headers: { "Content-Type": "text/plain; charset=utf-8" },
              body: "pong",
            };
          } else {
            result = {
              status: 404,
              statusText: "Not Found",
              headers: { "Content-Type": "application/json; charset=utf-8" },
              body: JSON.stringify({ error: "Not Found" }),
            };
          }

          await this.writeResult(
            output,
            result,
            keepAlive,
            sessionId,
            requestId,
            responseState,
          );
          ztoolkit.log(
            `[HttpServer] #${requestId} completed ${method} ${path} -> ${result.status} in ${Date.now() - acceptedAt}ms`,
          );
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          ztoolkit.log(
            `[HttpServer] #${requestId} error in request handling: ${error.message}`,
            "error",
          );
          if (responseState.started) {
            // 响应已经开始写了，再写一份只会污染正文；这条连接就此结束。
            ztoolkit.log(
              `[HttpServer] #${requestId} response already started, closing without an error body`,
              "warn",
            );
            return;
          }
          // 异常信息常带本机路径（文件读取失败、导入失败等），
          // 这是绕过 MCP 层 sanitizer 的另一个出口，必须单独脱敏。
          const errorBody = JSON.stringify(sanitizeForPrivacy({ error: error.message }));
          await this.writeResult(
            output,
            {
              status: 500,
              statusText: "Internal Server Error",
              headers: { "Content-Type": "application/json; charset=utf-8" },
              body: errorBody,
            },
            false,
            undefined,
            requestId,
            responseState,
          );
        }
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        ztoolkit.log(
          `[HttpServer] #${requestId} error handling request: ${error.message}`,
          "error",
        );
        ztoolkit.log(`[HttpServer] #${requestId} error stack: ${error.stack}`, "error");
        if (responseState.started) {
          ztoolkit.log(
            `[HttpServer] #${requestId} response already started, closing without an error body`,
            "warn",
          );
          return;
        }
        try {
          if (!output) {
            output = transport.openOutputStream(0, 0, 0);
          }
          await this.writeResult(
            output,
            {
              status: 500,
              statusText: "Internal Server Error",
              headers: { "Content-Type": "text/plain; charset=utf-8" },
              body: "Internal Server Error",
            },
            false,
            undefined,
            requestId,
            responseState,
          );
        } catch (closeError) {
          ztoolkit.log(
            `[HttpServer] #${requestId} error sending error response: ${closeError}`,
            "error",
          );
        }
      } finally {
        // Remove transport from tracking
        this.activeTransports.delete(transport);

        // 确保资源清理：无论走哪条分支，这条连接的生命周期都在这里明确结束。
        try {
          if (output) {
            output.close();
          }
        } catch (e) {
          ztoolkit.log(
            `[HttpServer] #${requestId} error closing output stream: ${e}`,
            "error",
          );
        }

        try {
          if (sin) sin.close();
        } catch (e) {
          ztoolkit.log(
            `[HttpServer] #${requestId} error closing scriptable stream: ${e}`,
            "error",
          );
        }

        try {
          if (input) {
            input.close();
          }
        } catch (e) {
          ztoolkit.log(
            `[HttpServer] #${requestId} error closing input stream: ${e}`,
            "error",
          );
        }

        ztoolkit.log(
          `[HttpServer] #${requestId} connection closed after ${Date.now() - acceptedAt}ms`,
        );
      }
    },
    onStopListening: (socket: any, status: any) => {
      ztoolkit.log(`[HttpServer] onStopListening called, status: ${status}`);
      this.isRunning = false;
    },
  };

/**
 * Get comprehensive capabilities and API documentation
 */
private getCapabilities() {
  return {
    serverInfo: {
      name: "Zotero MCP Plugin",
      // 版本号统一取自 package.json 的 config.addonVersion，
      // 与 manifest.json、设置页脚、MCP serverInfo 保持同一来源。
      version: config.addonVersion,
      description: "Model Context Protocol integration for Zotero research management",
      author: config.addonName,
      repository: "https://github.com/cookjohn/zotero-mcp",
      documentation: "https://github.com/cookjohn/zotero-mcp/blob/main/README.md"
    },
    protocols: {
      mcp: {
        version: MCP_PROTOCOL_VERSION,
        transport: "streamable-http",
        endpoint: "/mcp",
        description: "Full MCP protocol support for AI clients"
      },
      rest: {
        version: config.addonVersion,
        description: "REST API for direct HTTP access",
        baseUrl: `http://127.0.0.1:${this.port}`
      }
    },
    capabilities: {
      search: {
        library: true,
        annotations: true,
        collections: true,
        fullText: true,
        advanced: true
      },
      retrieval: {
        items: true,
        annotations: true,
        pdfContent: true,
        collections: true,
        notes: true
      },
      formats: {
        json: true,
        text: true,
        markdown: false
      }
    },
    tools: [
      {
        name: "hybrid_search",
        description: "Default first step for literature discovery. Searches Zotero metadata fields and the semantic index in parallel, then fuses them into one normalized 0-1 relevance score (the stronger branch sets the score, the weaker one adds a bounded agreement bonus; Reciprocal Rank Fusion is only the tie-break). Does not scan full document text. Always covers Chinese and English literature together: pass a complete natural-language query for the semantic branch plus bilingual keywords for the lexical branch, whichever language the user asked in. About 5-12 keywords is the recommended amount for best results, not a required range; any number from 1 to " + MAX_HYBRID_KEYWORDS + " is accepted. Returns ONE PAGE of lightweight candidate rows (itemKey, title, creators, year, venue, language, fused score, matched keywords/fields, a short evidence snippet, and whether an abstract exists), plus a pagination block with appliedMinScore, totalRelevant, returned, hasMore and nextCursor. The relevance threshold is applied BEFORE paging, so no page contains a document below it and a short last page is never padded; pass nextCursor back as cursor to window further down the same ranking. Abstracts are searched but NOT returned: fetch one with get_item_abstract only for a candidate worth going deeper on, then dig into that single paper with search_fulltext.",
        category: "search",
        parameters: {
          query: { type: "string", description: "Complete natural-language sentence describing the information need, embedded as-is for cross-lingual semantic search. Include an English and a Chinese phrasing separated by ' / '.", required: true },
          keywords: { type: "array", items: { type: "string" }, description: "Precise Chinese AND English domain terms, translations, synonyms and abbreviations. For best results, it is recommended to provide 5-12 relevant Chinese and/or English keywords; fewer or more are still allowed, from 1 up to " + MAX_HYBRID_KEYWORDS + " entries. Each is searched separately over title, abstract, creator, publicationTitle and tags, then aggregated, deduplicated and scored with a coverage bonus. Omitting this falls back to splitting the query, which only probes the language the user typed in.", required: false },
          topK: { type: "number", description: "Page size: 1-20 documents per response (also capped by the user setting). Anything past it is reachable with cursor, not lost.", required: false },
          cursor: { type: "string", description: "Continue a previous hybrid_search by passing the nextCursor it returned. Returns the next page of the SAME ranked, threshold-filtered result set without re-running retrieval. Send the other search arguments unchanged or omitted; changing them is a new search.", required: false },
          minScore: { type: "number", description: "Minimum fused relevance score (0-1)", required: false },
          language: { type: "string", enum: ["zh", "en", "all", "auto"], description: "Semantic branch language filter. Keep the 'all' default for cross-lingual recall; zh/en/auto drop literature written in the other language", required: false },
          rrfK: { type: "number", description: "Rank constant for the Reciprocal Rank Fusion TIE-BREAK (default: 60). Ranking is decided by the fused 0-1 relevance score; RRF only separates candidates whose fused scores are equal.", required: false },
          keywordWeight: { type: "number", description: "Keyword branch weight (default: 1)", required: false },
          semanticWeight: { type: "number", description: "Semantic branch weight (default: 1)", required: false },
          libraryID: { type: "number", description: "Library used by keyword and semantic retrieval", required: false },
        },
        examples: [
          {
            query: {
              query: "Effects of temperature gradient on columnar-to-equiaxed transition during directional solidification / 温度梯度对定向凝固柱状晶-等轴晶转变的影响",
              keywords: ["温度梯度", "定向凝固", "柱状晶", "等轴晶", "柱状晶-等轴晶转变", "temperature gradient", "directional solidification", "columnar grain", "equiaxed grain", "columnar-to-equiaxed transition", "CET"]
            },
            description: "Chinese question, bilingual retrieval: the full sentence drives cross-lingual semantic search while the keywords drive lexical search in both languages"
          }
        ]
      },
      {
        name: "get_libraries",
        description: "List all Zotero libraries available in the current client. Returns: [{libraryID, name, libraryType}]",
        category: "retrieval",
        parameters: {
          limit: { type: "number", description: "Maximum results to return", required: false },
          offset: { type: "number", description: "Pagination offset", required: false }
        }
      },
      {
        name: "search_libraries",
        description: "Search libraries by name. Returns: [{libraryID, name, libraryType}]",
        category: "retrieval",
        parameters: {
          q: { type: "string", description: "Library name search query", required: true },
          limit: { type: "number", description: "Maximum results to return", required: false },
          offset: { type: "number", description: "Pagination offset", required: false }
        }
      },
      {
        name: "search_library",
        description: "Structured Zotero metadata search for explicit title, author, year, item type, or field constraints. Use hybrid_search first for general literature discovery.",
        category: "search",
        parameters: {
          libraryID: { type: "number", description: "Optional target Zotero library ID. Defaults to the user library when omitted.", required: false },
          q: { type: "string", description: "General search query", required: false },
          title: { type: "string", description: "Title search", required: false },
          titleOperator: { 
            type: "string", 
            enum: ["contains", "exact", "startsWith", "endsWith", "regex"],
            description: "Title search operator",
            required: false
          },
          yearRange: { type: "string", description: "Year range (e.g., '2020-2023')", required: false },
          relevanceScoring: { type: "boolean", description: "Enable relevance scoring", required: false },
          sort: { 
            type: "string", 
            enum: ["relevance", "date", "title", "year"],
            description: "Sort order",
            required: false
          },
          limit: { type: "number", description: "Maximum results to return", required: false },
          offset: { type: "number", description: "Pagination offset", required: false }
        },
        examples: [
          { query: { q: "machine learning" }, description: "Basic text search" },
          { query: { title: "deep learning", titleOperator: "contains" }, description: "Title-specific search" },
          { query: { yearRange: "2020-2023", sort: "relevance" }, description: "Year-filtered search with relevance sorting" }
        ]
      },
      {
        name: "search_annotations",
        description: "Search all notes, PDF annotations and highlights with smart content processing",
        category: "search",
        parameters: {
          libraryID: { type: "number", description: "Optional target Zotero library ID. Defaults to the user library when omitted.", required: false },
          q: { type: "string", description: "Search query for content, comments, and tags", required: false },
          type: { 
            type: "string", 
            enum: ["note", "highlight", "annotation", "ink", "text", "image"],
            description: "Filter by annotation type",
            required: false
          },
          detailed: { type: "boolean", description: "Return detailed content (default: false for preview)", required: false },
          limit: { type: "number", description: "Maximum results (preview: 20, detailed: 50)", required: false },
          offset: { type: "number", description: "Pagination offset", required: false }
        },
        examples: [
          { query: { q: "important findings" }, description: "Search annotation content" },
          { query: { type: "highlight", detailed: true }, description: "Get detailed highlights" }
        ]
      },
      {
        name: "get_item_details",
        description: "Get detailed information for a specific item including metadata, abstract, attachments info, notes, and tags but not fulltext content. Returns: {key, title, creators, date, itemType, publicationTitle, volume, issue, pages, DOI, url, abstractNote, tags, notes: [note_content], attachments: [{key, title, path, contentType, filename, url, linkMode, hasFulltext, size}]}",
        category: "retrieval",
        parameters: {
          libraryID: { type: "number", description: "Optional target Zotero library ID. Defaults to the user library when omitted.", required: false },
          itemKey: { type: "string", description: "Unique item key", required: true }
        },
        examples: [
          { query: { itemKey: "ABCD1234" }, description: "Get item by key" }
        ]
      },
      {
        name: "get_annotation_by_id",
        description: "Get complete content of a specific annotation by ID",
        category: "retrieval",
        parameters: {
          annotationId: { type: "string", description: "Annotation ID", required: true }
        }
      },
      {
        name: "get_annotations_batch",
        description: "Get complete content of multiple annotations by IDs",
        category: "retrieval",
        parameters: {
          ids: { 
            type: "array", 
            items: { type: "string" },
            description: "Array of annotation IDs",
            required: true
          }
        }
      },
      {
        name: "get_item_pdf_content",
        description: "Extract text content from PDF attachments",
        category: "retrieval",
        parameters: {
          itemKey: { type: "string", description: "Item key", required: true },
          page: { type: "number", description: "Specific page number (optional)", required: false }
        }
      },
      {
        name: "get_collections",
        description: "Get list of all collections in the library",
        category: "collections",
        parameters: {
          libraryID: { type: "number", description: "Optional target Zotero library ID. Defaults to the user library when omitted.", required: false },
          limit: { type: "number", description: "Maximum results to return", required: false },
          offset: { type: "number", description: "Pagination offset", required: false }
        }
      },
      {
        name: "search_collections",
        description: "Search collections by name",
        category: "collections",
        parameters: {
          libraryID: { type: "number", description: "Optional target Zotero library ID. Defaults to the user library when omitted.", required: false },
          q: { type: "string", description: "Collection name search query", required: true },
          limit: { type: "number", description: "Maximum results to return", required: false },
          offset: { type: "number", description: "Pagination offset", required: false }
        }
      },
      {
        name: "get_collection_details",
        description: "Get detailed information about a specific collection",
        category: "collections",
        parameters: {
          collectionKey: { type: "string", description: "Collection key", required: true },
          libraryID: { type: "number", description: "Optional target Zotero library ID. Defaults to the user library when omitted.", required: false }
        }
      },
      {
        name: "get_collection_items",
        description: "Get items in a specific collection",
        category: "collections",
        parameters: {
          collectionKey: { type: "string", description: "Collection key", required: true },
          libraryID: { type: "number", description: "Optional target Zotero library ID. Defaults to the user library when omitted.", required: false },
          limit: { type: "number", description: "Maximum results to return", required: false },
          offset: { type: "number", description: "Pagination offset", required: false }
        }
      },
      {
        name: "get_item_fulltext",
        description: "Get comprehensive fulltext content from item including attachments, notes, abstracts, and webpage snapshots. Returns: {itemKey, title, itemType, abstract, fulltext: {attachments: [{attachmentKey, filename, filePath, contentType, type, content, length, extractionMethod}], notes: [{noteKey, title, content, htmlContent, length, dateModified}], webpage: {url, filename, filePath, content, length, type}, total_length}, metadata: {extractedAt, sources}}",
        category: "fulltext",
        parameters: {
          itemKey: { type: "string", description: "Item key", required: true },
          attachments: { type: "boolean", description: "Include attachment content (default: true)", required: false },
          notes: { type: "boolean", description: "Include notes content (default: true)", required: false },
          webpage: { type: "boolean", description: "Include webpage snapshots (default: true)", required: false },
          abstract: { type: "boolean", description: "Include abstract (default: true)", required: false }
        },
        examples: [
          { query: { itemKey: "ABCD1234" }, description: "Get all fulltext content for an item" },
          { query: { itemKey: "ABCD1234", attachments: true, notes: false }, description: "Get only attachment content" }
        ]
      },
      {
        name: "get_attachment_content",
        description: "Extract text content from a specific attachment (PDF, HTML, text files). Returns: {attachmentKey, filename, filePath, contentType, type, content, length, extractionMethod, extractedAt}",
        category: "fulltext",
        parameters: {
          attachmentKey: { type: "string", description: "Attachment key", required: true },
          format: { type: "string", enum: ["json", "text"], description: "Response format (default: json)", required: false }
        }
      },
      {
        name: "search_fulltext",
        description: "Final stage of the retrieval funnel: hybrid keyword + semantic search over the passages of ONE document located by hybrid_search, fused into the same normalized 0-1 score and filtered by the user's relevance threshold. Read that paper's abstract with get_item_abstract first, re-fit domain/expertRole to it, and write query and keywords from its own subject matter in its own language. Also serves neighbouring-passage context expansion via chunkIds. Whole-library scanning is disabled.",
        category: "fulltext",
        parameters: {
          libraryID: { type: "number", description: "Optional target Zotero library ID. Defaults to the user library when omitted.", required: false },
          itemKey: { type: "string", description: "The single item key to dig into, from hybrid_search", required: true },
          q: { type: "string", description: "Natural-language query written for THIS paper", required: true },
          keywords: { type: "string", description: "Comma-separated probes specific to this paper, written in the language THIS paper is written in (one language, not both - the other language matches nothing inside a single document)", required: false },
          domain: { type: "string", description: "Discipline / sub-field of this paper", required: false },
          expertRole: { type: "string", description: "Expert perspective adopted for this paper", required: false },
          maxChunks: { type: "number", description: "Upper bound on returned passages; capped by the user setting", required: false },
          minScore: { type: "number", description: "Relevance floor 0-1; may only be stricter than the user setting", required: false },
          chunkIds: { type: "string", description: "Comma-separated chunk ids for context expansion mode", required: false },
          neighborRadius: { type: "number", description: "Neighbour radius for context expansion; capped by the user setting", required: false }
        },
        examples: [
          { query: { q: "Conditions under which the columnar-to-equiaxed transition occurs in this alloy", itemKey: "ABCD1234", keywords: "CET,columnar-to-equiaxed transition,thermal gradient,growth rate" }, description: "Hybrid search inside one English document: probes in that document's language only" },
          { query: { itemKey: "ABCD1234", chunkIds: "17" }, description: "Pull in the passages neighbouring chunk 17" }
        ]
      },
      {
        name: "get_item_abstract",
        description: "Get ONE item's abstract. On-demand middle step of the retrieval funnel, not a batch step after hybrid_search: call it only for a candidate you are seriously considering reading in depth, one itemKey at a time. Read it, re-fit domain/expertRole to what that paper actually studies, then call search_fulltext with that itemKey and keywords written in the paper's own language.",
        category: "retrieval",
        parameters: {
          libraryID: { type: "number", description: "Optional target Zotero library ID. Defaults to the user library when omitted.", required: false },
          itemKey: { type: "string", description: "Item key", required: true },
          format: { type: "string", enum: ["json", "text"], description: "Response format (default: json)", required: false }
        }
      }
    ],
    endpoints: {
      mcp: {
        "/mcp": {
          method: "POST",
          description: "MCP protocol endpoint for AI clients",
          contentType: "application/json",
          protocol: `MCP ${MCP_PROTOCOL_VERSION}`
        }
      },
      rest: {
        "/ping": {
          method: "GET",
          description: "Health check endpoint",
          response: "text/plain"
        },
        "/mcp/status": {
          method: "GET", 
          description: "MCP server status and capabilities",
          response: "application/json"
        },
        "/capabilities": {
          method: "GET",
          description: "This endpoint - comprehensive API documentation",
          response: "application/json"
        },
        "/help": {
          method: "GET",
          description: "Alias for /capabilities",
          response: "application/json"
        },
        "/test/mcp": {
          method: "GET",
          description: "MCP integration testing endpoint",
          response: "application/json"
        }
      }
    },
    usage: {
      gettingStarted: {
        mcp: {
          description: "Connect via MCP protocol",
          steps: [
            "Configure MCP client to connect to this server",
            "Use streamable HTTP transport",
            "Send MCP requests to /mcp endpoint",
            "Available tools will be listed via tools/list method"
          ]
        },
        rest: {
          description: "Use REST API directly", 
          examples: [
            "GET /capabilities - Get this documentation",
            "GET /ping - Health check",
            "GET /mcp/status - Check MCP server status"
          ]
        }
      },
      authentication: serverPreferences.isAuthRequired()
        ? "Required: send the plugin access token as an Authorization: Bearer <token> header"
        : "Not required for loopback connections; enabling remote access makes the bearer token mandatory",
      originPolicy:
        "Requests carrying a non-loopback Origin header are rejected (DNS rebinding protection)",
      protocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
      rateLimit: "No rate limiting currently implemented",
      cors: "CORS headers not currently set"
    },
    timestamp: new Date().toISOString(),
    status: this.mcpServer ? "ready" : "mcp-disabled"
  };
}
}

// 进程诊断 - 记录 HttpServer 单例创建时机
try {
  const runtime = Cc["@mozilla.org/xre/app-info;1"]?.getService(Ci.nsIXULRuntime) as any;
  ztoolkit.log(`[HttpServer] Singleton created - PID: ${runtime?.processID}, processType: ${runtime?.processType}`);
} catch (e) { /* ignore */ }

export const httpServer = new HttpServer();
