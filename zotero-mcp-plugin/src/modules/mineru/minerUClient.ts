/**
 * MinerU API 客户端
 *
 * 支持两种部署方式：
 * - cloud: mineru.net 官方 v4 接口
 *     POST /api/v4/file-urls/batch  -> 拿到 batch_id 与预签名上传地址
 *     PUT  <presigned url>          -> 上传 PDF 字节
 *     GET  /api/v4/extract-results/batch/{batch_id} -> 轮询直到 state=done
 *     GET  <full_zip_url>           -> 下载结果压缩包
 * - local: 自建 mineru-api
 *     POST {baseURL}/file_parse     -> multipart/form-data，直接返回 zip 或 JSON
 *
 * 两条路径最终都归一为经过选择和校验的结构化 JSON 文件集合。
 */

import {
  selectStructuredSource,
  type StructuredSource,
} from "./structuredDocumentAssembler";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;
declare const Components: any;
declare const ztoolkit: ZToolkit;

export type MinerUMode = "cloud" | "local";

export const MINERU_CLOUD_BASE_URL = "https://mineru.net";
export const MINERU_LOCAL_BASE_URL = "http://127.0.0.1:8000";

export interface MinerUClientConfig {
  mode: MinerUMode;
  baseURL: string;
  apiToken: string;
  modelVersion: string; // "vlm" | "hybrid"（仅本地） | "pipeline"
  language: string;
  enableOCR: boolean;
  enableFormula: boolean;
  enableTable: boolean;
  timeoutSeconds: number;
  /** 解包结果压缩包时使用的临时目录 */
  tmpDir: string;
}

export interface MinerUParseResult {
  /** 按优先级选出的结构化解析结果。 */
  structuredSource: StructuredSource;
  /** 结果包中所有允许缓存的 JSON 文本文件。 */
  files: Record<string, string>;
}

/**
 * 取可用的 fetch。
 * 插件沙箱通常直接有全局 fetch；万一没有，就退到主窗口的实现
 * （必须 bind 到 window，否则会抛 Illegal invocation）。
 */
export function resolveFetch(): typeof fetch {
  if (typeof fetch === "function") {
    return fetch;
  }
  const win = Zotero.getMainWindow?.();
  if (win?.fetch) {
    return win.fetch.bind(win);
  }
  throw new Error("当前环境不可用 fetch，无法调用 MinerU 接口。");
}

/** 同理取 AbortController */
export function resolveAbortController(): typeof AbortController {
  if (typeof AbortController === "function") {
    return AbortController;
  }
  const win = Zotero.getMainWindow?.();
  if (win?.AbortController) {
    return win.AbortController;
  }
  throw new Error("当前环境不可用 AbortController。");
}

/** 返回默认 base URL（按部署方式） */
export function defaultMinerUBaseURL(mode: MinerUMode): string {
  return mode === "local" ? MINERU_LOCAL_BASE_URL : MINERU_CLOUD_BASE_URL;
}

/**
 * 规整 base URL：为空时回落到默认值，并防止 cloud/local 地址串用
 * （用户切换模式后常常忘记改地址）。
 */
export function normalizeMinerUBaseURL(mode: MinerUMode, value: any): string {
  const baseURL = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  if (!baseURL) {
    return defaultMinerUBaseURL(mode);
  }
  if (mode === "local" && baseURL === MINERU_CLOUD_BASE_URL) {
    return MINERU_LOCAL_BASE_URL;
  }
  if (mode !== "local" && baseURL === MINERU_LOCAL_BASE_URL) {
    return MINERU_CLOUD_BASE_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error("MinerU base URL is invalid");
  }
  if (mode === "cloud" && parsed.protocol !== "https:") {
    throw new Error("MinerU cloud mode requires HTTPS");
  }
  if (
    mode === "local" &&
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    throw new Error("MinerU local mode requires an HTTP(S) URL");
  }
  return baseURL;
}

export class MinerUClient {
  private readonly baseURL: string;
  private readonly config: MinerUClientConfig;

  constructor(config: MinerUClientConfig) {
    this.config = config;
    this.baseURL = config.baseURL.replace(/\/+$/, "");
  }

  /**
   * 解析本地 PDF 文件
   * @param filePath PDF 绝对路径
   * @param fileName 文件名（云端用于回显，本地用于 multipart filename）
   * @param dataID 业务侧唯一标识，这里传附件 key
   */
  async parseLocalFile(
    filePath: string,
    fileName: string,
    dataID: string,
  ): Promise<MinerUParseResult> {
    if (this.config.mode === "local") {
      return this.parseWithLocalAPI(filePath, fileName, dataID);
    }
    return this.parseWithCloud(filePath, fileName, dataID);
  }

  // ============== 云端 ==============

  private async parseWithCloud(
    filePath: string,
    fileName: string,
    dataID: string,
  ): Promise<MinerUParseResult> {
    if (!this.config.apiToken) {
      throw new Error("MinerU 云端模式需要 API Token，请先在插件设置中填写。");
    }

    const submit = await this.requestJSON("/api/v4/file-urls/batch", {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        files: [
          {
            name: fileName,
            data_id: dataID,
            is_ocr: this.config.enableOCR,
          },
        ],
        model_version: cloudModelVersion(this.config.modelVersion),
        language: this.config.language,
        enable_formula: this.config.enableFormula,
        enable_table: this.config.enableTable,
      }),
    });

    const batchID = submit.data?.batch_id;
    const uploadURL = submit.data?.file_urls?.[0];
    if (!batchID || !uploadURL) {
      throw new Error("MinerU 未返回上传地址。");
    }

    const bytes = await IOUtils.read(filePath);
    // 预签名地址不能附加自定义头（含 Content-Type），否则签名校验会失败
    const upload = await this.fetchWithTimeout(uploadURL, {
      method: "PUT",
      body: bytes,
    });
    if (!upload.ok) {
      throw new Error(`MinerU 上传失败：HTTP ${upload.status}`);
    }
    ztoolkit.log(`[MinerU] 已上传 ${fileName}，batch_id=${batchID}`);

    const result = await this.pollCloudBatch(batchID);
    if (!result.full_zip_url) {
      throw new Error("MinerU 未返回结果下载地址。");
    }
    const zipBytes = await this.downloadBytes(result.full_zip_url);
    const files = await this.extractZipTextFiles(zipBytes, dataID);
    return this.toParseResult(files);
  }

  private async pollCloudBatch(batchID: string): Promise<any> {
    const intervalMs = 3000;
    const deadline = Date.now() + this.config.timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      const response = await this.requestJSON(
        `/api/v4/extract-results/batch/${encodeURIComponent(batchID)}`,
        { method: "GET", headers: this.authHeaders() },
      );
      const result = (response.data?.extract_result || [])[0];
      if (result?.state === "done") {
        return result;
      }
      if (result?.state === "failed") {
        throw new Error(result.err_msg || "MinerU 解析失败。");
      }
      await Zotero.Promise.delay(intervalMs);
    }
    throw new Error(
      `MinerU 解析超时（超过 ${this.config.timeoutSeconds} 秒）。`,
    );
  }

  // ============== 本地 ==============

  private async parseWithLocalAPI(
    filePath: string,
    fileName: string,
    dataID: string,
  ): Promise<MinerUParseResult> {
    const bytes = await IOUtils.read(filePath);
    const multipart = createMultipartBody(
      [
        ["backend", localMinerUBackend(this.config.modelVersion)],
        ["lang_list", this.config.language],
        ["parse_method", this.config.enableOCR ? "ocr" : "auto"],
        ["formula_enable", String(this.config.enableFormula)],
        ["table_enable", String(this.config.enableTable)],
        ["return_md", "false"],
        ["return_content_list", "true"],
        ["return_model_output", "true"],
        ["response_format_zip", "true"],
        ["return_original_file", "false"],
      ],
      [
        {
          name: "files",
          fileName,
          contentType: "application/pdf",
          bytes,
        },
      ],
    );

    const response = await this.fetchWithTimeout(`${this.baseURL}/file_parse`, {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": multipart.contentType,
      },
      body: multipart.body,
    });
    if (!response.ok) {
      throw new Error(`本地 MinerU API 请求失败：HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const payload = new Uint8Array(await response.arrayBuffer());

    if (contentType.includes("zip")) {
      const files = await this.extractZipTextFiles(payload, dataID);
      return this.toParseResult(files);
    }

    const text = new TextDecoder().decode(payload);
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("本地 MinerU API 返回了无法解析的响应。");
    }
    return this.toParseResult(localResponseToStructuredFiles(data));
  }

  // ============== 通用 ==============

  private authHeaders(): Record<string, string> {
    return {
      Accept: "*/*",
      Authorization: `Bearer ${this.config.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  private async requestJSON(path: string, options: any): Promise<any> {
    const response = await this.fetchWithTimeout(
      `${this.baseURL}${path}`,
      options,
    );
    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`MinerU 返回了非 JSON 响应：HTTP ${response.status}`);
    }
    if (!response.ok || data.code !== 0) {
      throw new Error(data.msg || `MinerU 请求失败：HTTP ${response.status}`);
    }
    return data;
  }

  private async downloadBytes(url: string): Promise<Uint8Array> {
    const response = await this.fetchWithTimeout(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(`下载 MinerU 解析结果失败：HTTP ${response.status}`);
    }
    const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
    const declaredLength = Number(
      response.headers?.get?.("content-length") || 0,
    );
    if (declaredLength > MAX_DOWNLOAD_BYTES) {
      throw new Error("MinerU result archive exceeds the 128 MB safety limit");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error("MinerU result archive exceeds the 128 MB safety limit");
    }
    return bytes;
  }

  /**
   * 带超时的 fetch。单次网络请求最多等 timeoutSeconds，
   * 避免某个请求挂死时把整条索引流程一起拖住。
   */
  private async fetchWithTimeout(url: string, options: any): Promise<Response> {
    const Controller = resolveAbortController();
    const controller = new Controller();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutSeconds * 1000,
    );
    try {
      return await resolveFetch()(url, {
        ...options,
        signal: controller.signal,
      });
    } catch (error: any) {
      if (error?.name === "AbortError") {
        let safeURL = "remote endpoint";
        try {
          const parsedURL = new URL(url);
          safeURL = `${parsedURL.origin}${parsedURL.pathname}`;
        } catch {
          /* ignore */
        }
        throw new Error(
          `MinerU 请求超时（超过 ${this.config.timeoutSeconds} 秒）：${safeURL}`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private toParseResult(files: Record<string, string>): MinerUParseResult {
    return {
      structuredSource: selectStructuredSource(files),
      files,
    };
  }

  /**
   * 解包 MinerU 结果 zip，只取出 JSON 文件。
   * nsIZipReader 只能读磁盘文件，所以先落到临时目录，读完即删。
   */
  private async extractZipTextFiles(
    zipBytes: Uint8Array,
    stem: string,
  ): Promise<Record<string, string>> {
    await IOUtils.makeDirectory(this.config.tmpDir, {
      ignoreExisting: true,
      createAncestors: true,
    });
    const zipPath = PathUtils.join(
      this.config.tmpDir,
      `${sanitizeFileName(stem)}-${Date.now()}.zip`,
    );
    await IOUtils.write(zipPath, zipBytes);

    const zipFile = Zotero.File.pathToFile(zipPath);
    const zipReader = Components.classes[
      "@mozilla.org/libjar/zip-reader;1"
    ].createInstance(Components.interfaces.nsIZipReader);
    const files: Record<string, string> = {};
    try {
      zipReader.open(zipFile);
      const entries = zipReader.findEntries("*");
      let entryCount = 0;
      let totalExtractedBytes = 0;
      const MAX_ENTRY_COUNT = 500;
      const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
      const MAX_TOTAL_EXTRACTED_BYTES = 64 * 1024 * 1024;
      while (entries.hasMore()) {
        const name = entries.getNext();
        if (!/\.json$/i.test(name)) continue;
        entryCount++;
        if (entryCount > MAX_ENTRY_COUNT) {
          throw new Error("MinerU archive contains too many text entries");
        }
        const stream = zipReader.getInputStream(name);
        const availableBytes = stream.available();
        if (
          availableBytes > MAX_ENTRY_BYTES ||
          totalExtractedBytes + availableBytes > MAX_TOTAL_EXTRACTED_BYTES
        ) {
          stream.close();
          throw new Error("MinerU archive exceeds extraction safety limits");
        }
        const binaryStream = Components.classes[
          "@mozilla.org/binaryinputstream;1"
        ].createInstance(Components.interfaces.nsIBinaryInputStream);
        binaryStream.setInputStream(stream);
        const bytes = binaryStream.readByteArray(availableBytes);
        totalExtractedBytes += availableBytes;
        files[name] = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
        try {
          binaryStream.close();
        } catch {
          /* ignore */
        }
        stream.close();
      }
    } finally {
      try {
        zipReader.close();
      } catch {
        /* ignore */
      }
      await IOUtils.remove(zipPath, { ignoreAbsent: true });
    }
    return files;
  }
}

/**
 * 云端 model_version 只接受 pipeline / vlm / MinerU-HTML —— 没有 hybrid。
 * 设置页切到云端时会把 hybrid 改回 vlm，这里再兜一次，防止残留的偏好值
 * 让云端直接返回 400。
 */
function cloudModelVersion(modelVersion: string): string {
  return modelVersion === "hybrid" ? "vlm" : modelVersion;
}

/**
 * 本地 mineru-api 的 backend 取值与云端 model_version 不同名。
 *
 * MinerU 3.4 的 /file_parse 接受 "vlm-engine" 和 "hybrid-engine"。
 */
function localMinerUBackend(modelVersion: string): string {
  if (modelVersion === "pipeline") return "pipeline";
  if (modelVersion === "hybrid") return "hybrid-engine";
  return "vlm-engine";
}

/** 本地 API 的 JSON 响应转成与 zip 一致的文件表 */
export function localResponseToStructuredFiles(
  data: any,
): Record<string, string> {
  const files: Record<string, string> = {};
  const append = (prefix: string, value: any) => {
    if (!value || typeof value !== "object") return;
    const mappings: Array<[string, string]> = [
      ["content_list_v2", "content_list_v2.json"],
      ["content_list", "content_list.json"],
      ["model", "model.json"],
      ["model_output", "model.json"],
      ["layout", "layout.json"],
      ["middle_json", "middle.json"],
    ];
    for (const [key, fileName] of mappings) {
      if (value[key] === undefined || value[key] === null) continue;
      files[`${prefix}${fileName}`] =
        typeof value[key] === "string"
          ? value[key]
          : JSON.stringify(value[key]);
    }
  };
  for (const [name, value] of Object.entries<any>(data?.results || {})) {
    append(`${name}/`, value);
  }
  append("", data);
  return files;
}

function createMultipartBody(
  fields: Array<[string, string]>,
  files: Array<{
    name: string;
    fileName: string;
    contentType?: string;
    bytes: Uint8Array;
  }>,
): { body: Uint8Array; contentType: string } {
  const boundary = `----ZoteroMCP${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2)}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const file of files) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${escapeMultipartValue(
            file.name,
          )}"; filename="${escapeMultipartValue(file.fileName)}"\r\n` +
          `Content-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`,
      ),
      file.bytes,
      encoder.encode("\r\n"),
    );
  }

  for (const [name, value] of fields) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${escapeMultipartValue(
            name,
          )}"\r\n\r\n` +
          `${value}\r\n`,
      ),
    );
  }

  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  return {
    body: concatUint8Arrays(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function escapeMultipartValue(value: string): string {
  return String(value || "").replace(/["\r\n]/g, "_");
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

export function sanitizeFileName(value: string): string {
  return String(value || "file")
    .replace(/[\\/:*?"<>|\r\n]/g, "_")
    .slice(0, 80);
}
