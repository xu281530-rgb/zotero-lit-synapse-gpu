import { serverPreferences } from "./serverPreferences";
import { constantTimeStringEqual } from "../utils/security";
import type { MCPHttpResponse } from "./mcpTransport";

/**
 * HTTP 层访问控制：Origin / Host 校验 + Bearer Token 鉴权。
 *
 * 威胁模型：
 * 1. `allowRemote = true` 时监听 0.0.0.0，局域网内任何人都能直接调用 /mcp，
 *    因此必须校验 Bearer Token。
 * 2. 即使只监听 127.0.0.1，用户浏览器里的恶意页面也能向 localhost 发请求
 *    （DNS rebinding / 跨来源请求），所以要按 MCP 规范校验 Origin。
 * 3. 本机默认配置（loopback + 未开启 requireAuth）不应被打扰，
 *    否则等于逼所有既有用户重配客户端。
 */

/** 允许作为 Origin / Host 的回环主机名。 */
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
  "0:0:0:0:0:0:0:1",
]);

/** 无需鉴权的路径：仅用于存活探测，不返回任何库数据。 */
const PUBLIC_PATHS = new Set(["/ping"]);

export type RequestHeaders = Map<string, string>;

function jsonError(
  status: number,
  statusText: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): MCPHttpResponse {
  return {
    status,
    statusText,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

/** 取出 host:port 中的主机部分，保留 IPv6 的方括号形式。 */
function extractHostname(hostHeader: string): string {
  const value = hostHeader.trim();
  if (!value) return "";
  if (value.startsWith("[")) {
    const closing = value.indexOf("]");
    return closing === -1 ? value.toLowerCase() : value.substring(0, closing + 1).toLowerCase();
  }
  const colon = value.indexOf(":");
  return (colon === -1 ? value : value.substring(0, colon)).toLowerCase();
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * Origin 校验。
 *
 * - 无 Origin：放行。命令行 / 桌面版 MCP 客户端不会发送该头，
 *   而浏览器发起的跨源请求一定会带上，所以这条不会削弱防护。
 * - Origin 指向回环地址：放行，本机页面调试属于正常用法。
 * - 其它任何 Origin（包括 "null" 沙箱来源）：拒绝。
 *   DNS rebinding 攻击页面的 Origin 是攻击者域名，在此被挡下。
 */
function checkOrigin(headers: RequestHeaders): MCPHttpResponse | null {
  const origin = headers.get("origin");
  if (origin === undefined) return null;

  const value = origin.trim();
  if (!value) return null;

  let hostname = "";
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    hostname = "";
  }

  if (hostname && isLoopbackHost(hostname)) return null;
  if (hostname && isLoopbackHost(`[${hostname}]`)) return null;

  return jsonError(403, "Forbidden", {
    error: "Origin not allowed",
    detail:
      "The MCP endpoint only accepts requests without an Origin header or with a loopback Origin.",
  });
}

/**
 * Host 校验：仅在服务器绑定回环地址时启用。
 *
 * 绑定 127.0.0.1 时，任何合法请求的 Host 必然是回环名；出现别的域名
 * 说明请求经由 DNS rebinding 之类的重定向而来。开启远程访问时跳过此检查，
 * 因为用户就是要用主机名或 LAN IP 访问，此时由 Bearer Token 兜底。
 */
function checkHost(headers: RequestHeaders): MCPHttpResponse | null {
  if (serverPreferences.isRemoteAccessAllowed()) return null;

  const host = headers.get("host");
  if (host === undefined) return null;

  const hostname = extractHostname(host);
  if (!hostname || isLoopbackHost(hostname)) return null;

  return jsonError(403, "Forbidden", {
    error: "Host not allowed",
    detail:
      "The MCP server is bound to the loopback interface and only accepts loopback Host headers.",
  });
}

/**
 * 从 Authorization 头中取 Bearer Token。
 *
 * 只认请求头，不接受 `?token=` 查询参数：MCP 规范明确要求令牌不得出现在
 * URL 里，而 URL 会进代理日志、浏览器历史和 Referer。本插件支持的每个客户端
 * 都能设置请求头（配置模板里的 headers 字段，或 mcp-remote 的 --header）。
 */
function extractBearerToken(headers: RequestHeaders): string {
  const authorization = headers.get("authorization");
  if (!authorization) return "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/**
 * Bearer Token 鉴权。
 *
 * 触发条件由 `serverPreferences.isAuthRequired()` 决定：
 * 开启远程访问时强制要求，本机模式下仅当用户显式打开 requireAuth 才要求。
 */
function checkAuthorization(headers: RequestHeaders): MCPHttpResponse | null {
  if (!serverPreferences.isAuthRequired()) return null;

  const expected = serverPreferences.getAuthToken();
  if (!expected || expected.length < 32) {
    // 开了远程访问却没有可用令牌：拒绝服务，而不是无令牌放行。
    return jsonError(
      503,
      "Service Unavailable",
      {
        error: "MCP access token is not configured",
        detail:
          "Remote access is enabled but no valid access token exists. Open the Zotero MCP Plugin preferences and regenerate the access token.",
      },
    );
  }

  const presented = extractBearerToken(headers);
  if (!presented) {
    return jsonError(
      401,
      "Unauthorized",
      {
        error: "Missing bearer token",
        detail: "Send the MCP access token as an Authorization: Bearer <token> header.",
      },
      { "WWW-Authenticate": 'Bearer realm="zotero-mcp"' },
    );
  }

  if (!constantTimeStringEqual(presented, expected)) {
    return jsonError(
      403,
      "Forbidden",
      { error: "Invalid bearer token" },
      { "WWW-Authenticate": 'Bearer realm="zotero-mcp", error="invalid_token"' },
    );
  }

  return null;
}

/**
 * 单一入口：对一个已解析的请求做完整的访问控制检查。
 * 返回 null 表示放行，否则返回应当直接写回客户端的响应。
 */
export function checkRequestAccess(
  path: string,
  headers: RequestHeaders,
): MCPHttpResponse | null {
  // Origin / Host 对所有路径生效：跨源页面连 /ping 也不该读到。
  const originFailure = checkOrigin(headers);
  if (originFailure) return originFailure;

  const hostFailure = checkHost(headers);
  if (hostFailure) return hostFailure;

  if (PUBLIC_PATHS.has(path)) return null;

  return checkAuthorization(headers);
}
