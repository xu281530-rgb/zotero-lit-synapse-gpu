import {
  isWriteEnabled,
  MUTATING_TOOL_NAMES,
  StreamableMCPServer,
} from "./streamableMCPServer";
import { filterToolCatalog } from "./toolCatalog";
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
import { describePrivateText, sanitizeForPrivacy } from "../utils/privacy";
import { config } from "../../package.json";
import { getWikiSettings } from "./wiki";

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

export class HttpServer {
  public static testServer() {
    Zotero.debug("Static testServer method called.");
  }
  private serverSocket: any = null;
  private isRunning: boolean = false;
  private mcpServer: StreamableMCPServer | null = null;
  private port: number = 8080;
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

    // Retire ownership before close(), whose callback may arrive after restart.
    const socket = this.serverSocket;
    this.serverSocket = null;
    this.isRunning = false;
    this.boundPort = null;
    this.boundLoopbackOnly = null;

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
      socket?.close();
      ztoolkit.log("[HttpServer] Server socket closed successfully");
    } catch (e) {
      ztoolkit.log(`[HttpServer] Error closing server socket: ${e}`, 'error');
    }

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
   * Build appropriate HTTP headers with connection management
   */
  private buildHttpHeaders(result: any, keepAlive: boolean): string {
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
    
    // Add connection management headers
    if (keepAlive) {
      headers += `Connection: keep-alive\r\n` +
        `Keep-Alive: timeout=30, max=100\r\n`;
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
    requestId = 0,
    state?: { started: boolean },
  ): Promise<void> {
    // 一条连接只能有一个响应。标记必须在写出任何字节之前置位，
    // 否则写到一半失败时，错误分支会把第二份响应头接在正文后面，
    // 客户端按 Content-Length 读到的就是一段被污染的 JSON。
    if (state) state.started = true;
    const bodyBytes = utf8Encode(result.body || "");
    const headers = this.buildHttpHeaders(result, keepAlive) +
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
    onSocketAccepted: async (socket: any, transport: any) => {
      if (socket !== this.serverSocket || !this.isRunning) {
        try {
          transport.close(0);
        } catch {
          // The retired listener's transport may already be closed.
        }
        return;
      }
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
              requestId,
              responseState,
            );
            return;
          }

          // 请求体到这里才做一次 UTF-8 解码：字节已经确认收全。
          const requestBody = method === "POST" ? utf8Decode(frame.body) : "";
          if (requestBody) {
            ztoolkit.log(
              `[HttpServer] #${requestId} body decoded: ${frame.body.length}B -> ${describePrivateText(requestBody)}`,
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
      if (socket !== this.serverSocket) return;
      this.serverSocket = null;
      this.stop();
    },
  };

/**
 * Project the shared tool catalog into the shape /capabilities describes.
 *
 * The parameter table is derived from each tool's JSON Schema rather than
 * written out again: `required` comes from the schema's own `required` array,
 * so a tool whose schema changes cannot end up documented here with the old
 * signature. The pref filtering is the same one tools/list applies, so with
 * write operations disabled this stops advertising the write_* tools instead
 * of promising capabilities the server would refuse.
 */
private projectCatalogForCapabilities(): any[] {
  const tools = filterToolCatalog({
    wikiEnabled: getWikiSettings().enabled,
    writeEnabled: isWriteEnabled(),
    mutatingToolNames: MUTATING_TOOL_NAMES,
  });

  return tools.map((tool) => {
    const schema = tool.inputSchema ?? {};
    const properties: Record<string, any> = schema.properties ?? {};
    const required: string[] = Array.isArray(schema.required)
      ? schema.required
      : [];
    const parameters: Record<string, any> = {};
    for (const [name, definition] of Object.entries(properties)) {
      const spec = definition as Record<string, any>;
      parameters[name] = {
        type: spec.type,
        ...(spec.enum ? { enum: spec.enum } : {}),
        ...(spec.items ? { items: spec.items } : {}),
        ...(spec.default !== undefined ? { default: spec.default } : {}),
        description: spec.description,
        required: required.includes(name),
      };
    }
    return {
      name: tool.name,
      category: tool.category,
      description: tool.description,
      parameters,
    };
  });
}

/**
 * Get comprehensive capabilities and API documentation
 */
private getCapabilities() {
  return {
    serverInfo: {
      name: "Zotero LitSynapse",
      // 版本号统一取自 package.json 的 config.addonVersion，
      // 与 manifest.json、设置页脚、MCP serverInfo 保持同一来源。
      version: config.addonVersion,
      description: "Model Context Protocol integration for Zotero research management"
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
    // Mirrored from the MCP tool catalog, never written out again.
    //
    // This block used to be a second, hand-maintained copy of the tool list,
    // and it had drifted badly: it still advertised get_annotation_by_id,
    // get_annotations_batch, get_item_pdf_content, get_item_fulltext and
    // get_attachment_content, none of which had existed for some time, while
    // omitting eleven tools that did — including every collection-mutation
    // tool and every semantic tool. A client that read /capabilities to decide
    // what to call was being told to call things that would fail, and never
    // told about half the server. The projection below cannot drift, and
    // scripts/test-tool-catalog.js fails the build if the two shapes diverge.
    tools: this.projectCatalogForCapabilities(),
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
