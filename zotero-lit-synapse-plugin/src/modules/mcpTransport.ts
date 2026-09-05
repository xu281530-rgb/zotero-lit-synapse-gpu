export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_HTTP_METHOD = "POST";

/**
 * 本服务器可协商的协议版本，新版本在前。
 *
 * 只列出定义了 Streamable HTTP 传输的版本。2024-11-05 规定的是 HTTP+SSE 双端点
 * 传输（GET /sse 建流 + POST /messages 投递），本插件从未实现——它只有一个
 * POST /mcp 端点，GET /mcp 直接返回 405。把 2024-11-05 列进来等于对外承诺一套
 * 并不存在的传输，客户端按该版本连接必然失败，所以它被移出支持列表。
 *
 * Streamable HTTP 自 2025-03-26 引入，因此支持列表从该版本开始。
 */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = [
  MCP_PROTOCOL_VERSION,
  "2025-03-26",
] as const;

/**
 * MCP 2025-06-18 规定：初始化之后的 HTTP 请求若未携带
 * `MCP-Protocol-Version`，服务端应按 2025-03-26 处理。
 * 该值必须始终存在于 {@link SUPPORTED_MCP_PROTOCOL_VERSIONS} 中。
 */
export const MCP_DEFAULT_NEGOTIATED_VERSION = "2025-03-26";

/**
 * 版本协商的结果：客户端请求的版本受支持就用它，否则退回服务器最新支持版本。
 *
 * 依据 MCP lifecycle：服务器支持所请求版本时 MUST 回同一版本，否则 MUST 回一个
 * 自己支持的版本（SHOULD 为最新版），再由客户端决定继续还是断开——这是协商，
 * 不是错误，所以 initialize 不应因版本不匹配而失败。
 */
export function negotiateProtocolVersion(requested: unknown): string {
  return isSupportedProtocolVersion(requested)
    ? (requested as string)
    : MCP_PROTOCOL_VERSION;
}

export function isSupportedProtocolVersion(version: unknown): boolean {
  return (
    typeof version === "string" &&
    (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)
  );
}

export interface MCPHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export function getMCPMethodResponse(
  method: string,
  enabled: boolean,
): MCPHttpResponse | null {
  if (method === "POST" && enabled) return null;

  const unavailable = method === "POST";
  return {
    status: unavailable ? 503 : 405,
    statusText: unavailable ? "Service Unavailable" : "Method Not Allowed",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Allow: MCP_HTTP_METHOD,
    },
    body: JSON.stringify({
      error: unavailable
        ? "MCP server not enabled"
        : `Method ${method} not allowed on the MCP Streamable HTTP endpoint`,
    }),
  };
}

/**
 * 校验 HTTP 层的 `MCP-Protocol-Version` 请求头。
 *
 * 缺失时按规范回落到 2025-03-26；出现无法识别的版本时返回 400，
 * 而不是继续按最新版本解析一个我们并不知道其语义的报文。
 */
export function checkProtocolVersionHeader(
  headerValue: string | undefined,
): MCPHttpResponse | null {
  if (headerValue === undefined) return null;

  const version = headerValue.trim();
  if (!version || isSupportedProtocolVersion(version)) return null;

  return {
    status: 400,
    statusText: "Bad Request",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      error: `Unsupported MCP-Protocol-Version: ${version}`,
      supportedVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
    }),
  };
}
