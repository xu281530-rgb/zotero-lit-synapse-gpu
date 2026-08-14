/**
 * HTTP/1.1 请求分帧 + UTF-8 编解码，全部按「字节」处理。
 *
 * 为什么单独抽出来：请求的读取阶段绝不能做字符解码。旧实现用
 * nsIConverterInputStream 边读边把 socket 字节解码成 JS 字符串，再拿
 * UTF-8 字节数去和 Content-Length 比较——一个循环里混了两种计数单位。
 * 只要一个多字节字符（中文关键词）被 TCP 分片切开，解码这一轮就会返回
 * 0 个字符，读取循环把「读到 0 字符」当成 EOF 提前退出，JSON.parse 拿到
 * 一个被截断的请求体，于是回 -32700 Parse error（id 无法确定，按
 * JSON-RPC 2.0 规定填 null）。
 *
 * 这里的函数是纯函数，不依赖 XPCOM，可以直接在 Node 下跑单测。
 */

/** 二进制字符串：每个 JS 字符对应一个字节（0-255）。 */
export type ByteString = string;

const CHUNK_CONVERSION_SIZE = 8192;

function bytesToByteString(bytes: Uint8Array): ByteString {
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK_CONVERSION_SIZE) {
    const slice = bytes.subarray(i, i + CHUNK_CONVERSION_SIZE);
    out += String.fromCharCode.apply(null, Array.from(slice) as number[]);
  }
  return out;
}

function byteStringToBytes(binary: ByteString): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** 把 JS 字符串编码成 UTF-8 字节串；其长度就是 Content-Length。 */
export function utf8Encode(str: string): ByteString {
  if (!str) return "";
  try {
    return bytesToByteString(new TextEncoder().encode(str));
  } catch {
    // 没有 TextEncoder 时的手写回退，语义与上面一致。
    let out = "";
    for (let i = 0; i < str.length; i += 1) {
      let code = str.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        const next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
          i += 1;
        }
      }
      if (code < 0x80) {
        out += String.fromCharCode(code);
      } else if (code < 0x800) {
        out += String.fromCharCode(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        out += String.fromCharCode(
          0xe0 | (code >> 12),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      } else {
        out += String.fromCharCode(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      }
    }
    return out;
  }
}

/** 把 UTF-8 字节串解码成 JS 字符串。只在请求体收全之后调用一次。 */
export function utf8Decode(binary: ByteString): string {
  if (!binary) return "";
  try {
    return new TextDecoder("utf-8").decode(byteStringToBytes(binary));
  } catch {
    // 回退：至少不丢 ASCII，也不会让整个请求变成异常。
    return binary;
  }
}

export interface RequestFrame {
  /** 请求头是否已完整收到（找到了 CRLFCRLF）。 */
  headersComplete: boolean;
  /** 请求行 + 头部原文（HTTP 头必为 ASCII，可直接当字符串用）。 */
  headerText: string;
  /** 请求行。 */
  requestLine: string;
  /** 头部小写键 -> 值（重复头按逗号拼接）。 */
  headers: Map<string, string>;
  /** 请求体在原始字节串中的起始下标；头未收全时为 -1。 */
  bodyStart: number;
  /** Content-Length 的值；没有该头时为 -1。 */
  contentLength: number;
  /** 是否为 chunked 传输编码。 */
  chunked: boolean;
  /** 本请求是否应带请求体。 */
  expectsBody: boolean;
  /** 请求体是否已完整收到。 */
  bodyComplete: boolean;
  /** 完整收到时的请求体原始字节；否则为空串。 */
  body: ByteString;
  /** 目前已收到的请求体字节数（用于诊断日志）。 */
  bodyBytesReceived: number;
  /** 本请求之外的多余字节数（HTTP 流水线或客户端多发）。 */
  trailingBytes: number;
  /** 分帧本身非法（冲突的 Content-Length、非法 chunk 长度等）。 */
  error?: string;
}

function parseHeaderSection(headerText: string): {
  requestLine: string;
  headers: Map<string, string>;
} {
  const lines = headerText.split("\r\n");
  const headers = new Map<string, string>();
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.substring(0, separator).trim().toLowerCase();
    const value = line.substring(separator + 1).trim();
    if (!name) continue;
    const existing = headers.get(name);
    headers.set(name, existing ? `${existing}, ${value}` : value);
  }
  return { requestLine: lines[0] || "", headers };
}

function emptyFrame(overrides: Partial<RequestFrame>): RequestFrame {
  return {
    headersComplete: false,
    headerText: "",
    requestLine: "",
    headers: new Map(),
    bodyStart: -1,
    contentLength: -1,
    chunked: false,
    expectsBody: false,
    bodyComplete: false,
    body: "",
    bodyBytesReceived: 0,
    trailingBytes: 0,
    ...overrides,
  };
}

/**
 * 解析 chunked 请求体。
 * complete=false 表示还需要更多字节，这不是错误。
 */
export function decodeChunkedBody(
  raw: ByteString,
  start: number,
): { complete: boolean; body: ByteString; consumed: number; error?: string } {
  let cursor = start;
  let body = "";

  for (;;) {
    const lineEnd = raw.indexOf("\r\n", cursor);
    if (lineEnd === -1) return { complete: false, body: "", consumed: 0 };

    const sizeLine = raw.substring(cursor, lineEnd);
    // chunk 扩展用 ';' 分隔，长度只取前半段。
    const sizeToken = sizeLine.split(";")[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeToken)) {
      return {
        complete: false,
        body: "",
        consumed: 0,
        error: `invalid chunk size "${sizeToken.substring(0, 16)}"`,
      };
    }
    const size = parseInt(sizeToken, 16);
    cursor = lineEnd + 2;

    if (size === 0) {
      // 末尾 chunk 之后是可选 trailer，再跟一个空行。
      if (raw.startsWith("\r\n", cursor)) {
        return { complete: true, body, consumed: cursor + 2 - start };
      }
      const trailerEnd = raw.indexOf("\r\n\r\n", cursor);
      if (trailerEnd === -1) return { complete: false, body: "", consumed: 0 };
      return { complete: true, body, consumed: trailerEnd + 4 - start };
    }

    if (raw.length < cursor + size + 2) {
      return { complete: false, body: "", consumed: 0 };
    }
    body += raw.substr(cursor, size);
    cursor += size + 2;
  }
}

/**
 * 对「目前累积到的原始字节」做一次分帧判断。
 *
 * 不做任何字符解码，也不猜测：请求体只有在按 Content-Length / chunked
 * 确认收全之后才会被填进 body，调用方据此决定继续读还是开始处理。
 */
export function analyzeRequest(raw: ByteString): RequestFrame {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    return emptyFrame({});
  }

  const headerText = raw.substring(0, headerEnd);
  const { requestLine, headers } = parseHeaderSection(headerText);
  const bodyStart = headerEnd + 4;
  const received = raw.length - bodyStart;

  const base = emptyFrame({
    headersComplete: true,
    headerText,
    requestLine,
    headers,
    bodyStart,
    bodyBytesReceived: received,
  });

  // RFC 9112 §6.1：出现 Transfer-Encoding 时必须忽略 Content-Length。
  const transferEncoding = (
    headers.get("transfer-encoding") || ""
  ).toLowerCase();
  if (transferEncoding) {
    const last = transferEncoding.split(",").pop();
    if ((last || "").trim() !== "chunked") {
      return {
        ...base,
        error: `unsupported Transfer-Encoding: ${transferEncoding}`,
      };
    }
    const decoded = decodeChunkedBody(raw, bodyStart);
    if (decoded.error) {
      return {
        ...base,
        chunked: true,
        expectsBody: true,
        error: decoded.error,
      };
    }
    return {
      ...base,
      chunked: true,
      expectsBody: true,
      bodyComplete: decoded.complete,
      body: decoded.complete ? decoded.body : "",
      trailingBytes: decoded.complete ? received - decoded.consumed : 0,
    };
  }

  const rawContentLength = headers.get("content-length");
  if (rawContentLength !== undefined) {
    const values = rawContentLength.split(",").map((value) => value.trim());
    if (values.some((value) => !/^[0-9]+$/.test(value))) {
      return { ...base, error: `invalid Content-Length: ${rawContentLength}` };
    }
    const parsed = values.map((value) => parseInt(value, 10));
    if (parsed.some((value) => value !== parsed[0])) {
      return {
        ...base,
        error: `conflicting Content-Length: ${rawContentLength}`,
      };
    }
    const contentLength = parsed[0];
    return {
      ...base,
      contentLength,
      expectsBody: contentLength > 0,
      bodyComplete: received >= contentLength,
      body:
        received >= contentLength ? raw.substr(bodyStart, contentLength) : "",
      trailingBytes: received >= contentLength ? received - contentLength : 0,
    };
  }

  // 既没有 Content-Length 也没有 Transfer-Encoding：按无请求体处理。
  return { ...base, bodyComplete: true, trailingBytes: received };
}

/* ------------------------------------------------------------------ *
 * 字节级流读写
 *
 * 这些函数只对流做鸭子类型调用（available / read / write），不引用 XPCOM，
 * 因此可以用假的流对象在 Node 下直接跑，验证「分片到达」和「部分写」这两
 * 条真实链路。
 * ------------------------------------------------------------------ */

/** NS_BASE_STREAM_WOULD_BLOCK：非阻塞流暂时没有数据/没有空间，不是错误。 */
export const NS_BASE_STREAM_WOULD_BLOCK = 0x80470007;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isWouldBlock(error: any): boolean {
  return (
    error?.result === NS_BASE_STREAM_WOULD_BLOCK ||
    String(error).includes("NS_BASE_STREAM_WOULD_BLOCK")
  );
}

/** 已就绪的字节数；返回 null 表示流已关闭（对端断开），即 EOF。 */
export function availableBytes(input: any): number | null {
  try {
    return Number(input.available());
  } catch (error) {
    if (isWouldBlock(error)) return 0;
    return null; // NS_BASE_STREAM_CLOSED 等：EOF
  }
}

/**
 * 从 nsIScriptableInputStream 读原始字节。
 * 返回值里 1 个字符 = 1 个字节；"" 表示暂时无数据；null 表示 EOF。
 */
export function readRawBytes(sin: any, count: number): string | null {
  if (count <= 0) return "";
  try {
    const chunk = sin.read(count);
    return typeof chunk === "string" ? chunk : "";
  } catch (error) {
    return isWouldBlock(error) ? "" : null;
  }
}

export interface ReadLimits {
  /** 多久没有新字节就放弃。 */
  idleTimeoutMs: number;
  /** 单个请求允许花的总时长。 */
  totalTimeoutMs: number;
  /** 单个请求允许的最大字节数。 */
  maxBytes: number;
  /** 无数据时的等待间隔。 */
  pollIntervalMs?: number;
}

export type ReadOutcome =
  | "complete"
  | "empty"
  | "incomplete"
  | "timeout"
  | "too-large";

/**
 * 按字节读入一个完整的 HTTP 请求。
 *
 * 不做任何字符解码：HTTP 的分帧单位是字节，Content-Length 也是字节。
 * 边读边解码会让「这一轮解不出字符」（一个多字节字符被 TCP 分片切开）和
 * 「对端已关闭」变得无法区分，读取循环因此提前退出，把半个请求体交给
 * JSON.parse——那正是随机 -32700 的来源。请求体是否收全，只由
 * analyzeRequest 依据字节数判定。
 */
export async function readHttpRequest(
  input: any,
  sin: any,
  limits: ReadLimits,
): Promise<{ raw: ByteString; frame: RequestFrame; outcome: ReadOutcome }> {
  const pollIntervalMs = limits.pollIntervalMs ?? 2;
  let raw = "";
  let frame = analyzeRequest(raw);
  let needsAnalysis = false;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;

  for (;;) {
    if (needsAnalysis) {
      frame = analyzeRequest(raw);
      needsAnalysis = false;
    }

    if (frame.error) return { raw, frame, outcome: "incomplete" };
    if (frame.headersComplete && frame.bodyComplete) {
      return { raw, frame, outcome: "complete" };
    }
    if (raw.length >= limits.maxBytes) {
      return { raw, frame, outcome: "too-large" };
    }

    const available = availableBytes(input);
    if (available === null) {
      // 对端关闭且缓冲区已空：请求就到此为止。
      return { raw, frame, outcome: raw.length === 0 ? "empty" : "incomplete" };
    }

    if (available > 0) {
      const chunk = readRawBytes(
        sin,
        Math.min(available, limits.maxBytes - raw.length),
      );
      if (chunk === null) {
        return {
          raw,
          frame,
          outcome: raw.length === 0 ? "empty" : "incomplete",
        };
      }
      if (chunk.length > 0) {
        raw += chunk;
        needsAnalysis = true;
        lastProgressAt = Date.now();
        continue;
      }
    }

    // 暂时没有数据：等待，但空闲时长与总时长都有上限，
    // 任何一条连接都不会无限期停在这里。
    const now = Date.now();
    if (
      now - lastProgressAt > limits.idleTimeoutMs ||
      now - startedAt > limits.totalTimeoutMs
    ) {
      return { raw, frame, outcome: raw.length === 0 ? "empty" : "timeout" };
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * 完整写出一段字节串。
 *
 * 这里的 nsIOutputStream 是非阻塞管道：write() 有多少空间写多少，并把实际
 * 写入的字节数作为返回值。旧实现忽略了返回值，响应一旦超过管道缓冲区
 * （默认约 96KB）就会被静默截断——客户端按 Content-Length 等剩下的字节，
 * 一直等下去，表现为「Zotero 这边搜完了，Claude 还卡在调用中」。
 */
export async function writeAllBytes(
  output: any,
  data: ByteString,
  deadline: number,
  sliceBytes = 32 * 1024,
): Promise<number> {
  let offset = 0;
  while (offset < data.length) {
    const sliceLength = Math.min(sliceBytes, data.length - offset);
    const slice =
      offset === 0 && sliceLength === data.length
        ? data
        : data.substr(offset, sliceLength);

    let written = 0;
    try {
      written = Number(output.write(slice, slice.length)) || 0;
    } catch (error) {
      if (!isWouldBlock(error)) throw error;
      written = 0;
    }

    if (written > 0) {
      offset += written;
      continue;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Response write timed out after ${offset}/${data.length} bytes`,
      );
    }
    // 管道满了：等 socket 把已缓冲的数据发出去，腾出空间再继续。
    await sleep(5);
  }
  return offset;
}
