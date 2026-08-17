/**
 * MinerU 解析服务
 *
 * Responsibilities:
 * 1. Read MinerU preferences and maintain per-attachment persistent caches.
 * 2. Deduplicate concurrent parsing and normalize Markdown for indexing.
 *     ├── full.md            解析出的 Markdown
 *     ├── content_list.json  MinerU 结构化输出（如果有）
 *     meta.json          Cache metadata used for invalidation.
 */

import {
  MinerUClient,
  MinerUMode,
  normalizeMinerUBaseURL,
  resolveAbortController,
  resolveFetch,
  sanitizeFileName,
} from "./minerUClient";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;
declare const ztoolkit: ZToolkit;

const PREF_PREFIX = "extensions.zotero.zotero-mcp-plugin.";

/** 缓存格式版本，格式变更时递增即可让旧缓存自动失效 */
const CACHE_VERSION = 1;

/** 解析失败后多久才允许再次尝试，避免每轮索引都去撞同一个坏文件 */
const FAILURE_RETRY_MS = 6 * 60 * 60 * 1000;

export interface MinerUServiceConfig {
  enabled: boolean;
  mode: MinerUMode;
  baseURL: string;
  apiToken: string;
  modelVersion: string;
  language: string;
  enableOCR: boolean;
  enableFormula: boolean;
  enableTable: boolean;
  timeoutSeconds: number;
  maxFileSizeMB: number;
  concurrency: number;
  /** Allow synchronous MCP paths to block on a cache miss. */
  blockingOnDemand: boolean;
  /** Attach successful Markdown output to the Zotero item. */
  attachMarkdown: boolean;
}

/** Parsing progress reported to the UI. */
export interface MinerUProgressEvent {
  phase: "start" | "done" | "failed";
  attachmentKey: string;
  fileName: string;
  /** done 时的 Markdown 长度 */
  markdownLength?: number;
  /** failed 时的错误摘要 */
  message?: string;
  elapsedMs?: number;
}

export type MinerUProgressListener = (event: MinerUProgressEvent) => void;

/**
 * Prefix used to identify generated Markdown attachments and prevent duplicates.
 */
const MARKDOWN_ATTACHMENT_PREFIX = "MinerU Markdown";

interface CacheMeta {
  version: number;
  attachmentKey: string;
  fileName: string;
  fileSize: number;
  fileMTime: number;
  signature: string;
  parsedAt: string;
  markdownLength: number;
  error?: string;
  failedAt?: number;
}

export interface GetMarkdownOptions {
  /**
   * Allow a cache miss to start a potentially long parse operation.
   */
  allowParse?: boolean;
  /**
   * Ignore the failure cooldown when the user explicitly requests a retry.
   */
  ignoreFailureCache?: boolean;
  /**
   * Reuse or parse Markdown even when the general MinerU toggle is disabled.
   */
  ignoreEnabled?: boolean;
  /** Ignore all reusable results and force a new parse. */
  force?: boolean;
  /**
   * Called with which of the four reuse paths actually produced the Markdown.
   *
   * The four are not interchangeable and a caller that reports its text source
   * to a model has to be able to tell them apart: Doc2X source Markdown keeps
   * the publisher's structure, a MinerU parse reconstructs it, and a cache hit
   * says no parsing happened on this call. Returning only the string made all
   * four look identical, so `get_attachment_text` could not name its source.
   */
  onOrigin?: (origin: MarkdownOrigin) => void;
}

/** Which reuse path in {@link MinerUService.getMarkdownForAttachment} won. */
export type MarkdownOrigin =
  /** Lossless source Markdown recovered from a Doc2X note. */
  | "doc2x"
  /** A MinerU parse result that was already in the shared cache. */
  | "mineru_cache"
  /** A Markdown file already attached to the item by an earlier parse. */
  | "mineru_attachment"
  /** MinerU parsed the PDF during this call. */
  | "mineru_parsed";

/** Prevent local health checks from hanging on silently dropped connections. */
const LOCAL_PROBE_TIMEOUT_MS = 8000;

function getPrefValue<T>(key: string, fallback: T): T {
  try {
    const value = Zotero.Prefs.get(`${PREF_PREFIX}${key}`, true);
    if (value === undefined || value === null || value === "") {
      return fallback;
    }
    return value as T;
  } catch {
    return fallback;
  }
}

/** Semaphore limiting concurrent MinerU parses. */
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private limit: number) {}

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.drain();
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }
}

export class MinerUService {
  private semaphore = new Semaphore(2);
  /** In-flight work keyed by attachment to prevent duplicate parsing. */
  private inFlight = new Map<string, Promise<string | null>>();
  /** Failures recorded during the current indexing run. */
  private runFailures: Array<{ fileName: string; message: string }> = [];
  /** Markdown attachments created during the current indexing run. */
  private runAttachments = 0;
  /** 界面进度监听器；解析是分钟级操作，没有它用户只能盯着一个不动的弹窗 */
  private progressListener: MinerUProgressListener | null = null;

  /** 注册/注销解析进度监听（同一时刻只有一个索引任务，单个监听器足够） */
  setProgressListener(listener: MinerUProgressListener | null): void {
    this.progressListener = listener;
  }

  private emitProgress(event: MinerUProgressEvent): void {
    try {
      this.progressListener?.(event);
    } catch (error) {
      ztoolkit.log(`[MinerU] 进度回调异常：${error}`, "warn");
    }
  }

  // ============== 配置 ==============

  getConfig(): MinerUServiceConfig {
    const mode = (
      getPrefValue<string>("mineru.mode", "cloud") === "local"
        ? "local"
        : "cloud"
    ) as MinerUMode;
    return {
      enabled: getPrefValue<boolean>("mineru.enabled", true) !== false,
      mode,
      baseURL: normalizeMinerUBaseURL(
        mode,
        getPrefValue<string>("mineru.baseURL", ""),
      ),
      apiToken: String(getPrefValue<string>("mineru.apiToken", "")).trim(),
      modelVersion: getPrefValue<string>("mineru.modelVersion", "vlm"),
      language: getPrefValue<string>("mineru.language", "ch"),
      enableOCR: getPrefValue<boolean>("mineru.enableOCR", false) === true,
      enableFormula:
        getPrefValue<boolean>("mineru.enableFormula", true) !== false,
      enableTable: getPrefValue<boolean>("mineru.enableTable", true) !== false,
      timeoutSeconds: clampInt(
        getPrefValue<number>("mineru.timeoutSeconds", 600),
        30,
        3600,
        600,
      ),
      maxFileSizeMB: clampInt(
        getPrefValue<number>("mineru.maxFileSizeMB", 50),
        1,
        512,
        50,
      ),
      concurrency: clampInt(
        getPrefValue<number>("mineru.concurrency", 1),
        1,
        4,
        1,
      ),
      blockingOnDemand:
        getPrefValue<boolean>("mineru.blockingOnDemand", false) === true,
      attachMarkdown:
        getPrefValue<boolean>("mineru.attachMarkdown", true) !== false,
    };
  }

  isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  // ============== 缓存路径 ==============

  private getCacheRoot(): string {
    return PathUtils.join(Zotero.DataDirectory.dir, "zotero-mcp", "mineru");
  }

  private getAttachmentDir(attachmentKey: string): string {
    return PathUtils.join(this.getCacheRoot(), sanitizeFileName(attachmentKey));
  }

  private getTmpDir(): string {
    return PathUtils.join(this.getCacheRoot(), "tmp");
  }

  /**
   * Find a fresh Doc2X original Markdown note for this exact PDF.
   *
   * Doc2X may store lossless source Markdown in note metadata/source files,
   * or only the fully rendered Zotero note. We accept all three forms, but
   * only for localized original_MD/原文MD notes; filename affinity and task
   * metadata remain ranking signals rather than hard requirements.
   */
  private async readFreshDoc2XMarkdown(
    attachment: any,
    stat: { size: number; mtime: number } | null,
  ): Promise<{
    markdown: string;
    noteKey: string;
    taskId: string;
    source: string;
  } | null> {
    const parentItemID = attachment?.parentItemID;
    if (!parentItemID) return null;
    try {
      const parent = await Zotero.Items.getAsync(parentItemID);
      if (!parent) return null;
      const noteIDs = parent.getNotes?.(false) || parent.getNotes?.() || [];
      const matches: any[] = [];
      for (const noteID of noteIDs) {
        try {
          const note = await Zotero.Items.getAsync(noteID);
          if (!note?.isNote?.()) continue;
          const noteHTML = note.getNote?.() || "";
          const match = doc2xOriginalNoteMatch(note, attachment, noteHTML);
          if (!match) continue;

          let markdown = decodeDoc2XMarkdownSource(noteHTML);
          let source = "embedded";
          if (!markdown) {
            markdown = await readDoc2XMarkdownSourceFile(note);
            source = "md-sources";
          }
          if (!markdown) {
            const noteTitle =
              note.getNoteTitle?.() || note.getField?.("title") || "";
            markdown = doc2xRenderedNoteToMarkdown(noteHTML, noteTitle);
            source = "note-html";
            if (markdown) {
              ztoolkit.log(
                `[Doc2XBridge] recovered Markdown directly from rendered Doc2X note ${note.key} (${markdown.length} chars)`,
              );
            }
          }
          if (!markdown?.trim()) {
            ztoolkit.log(
              `[Doc2XBridge] original-looking note ${note.key} had no reusable embedded/source/rendered Markdown`,
              "warn",
            );
            continue;
          }

          const modifiedMs = zoteroItemModifiedMs(note);
          matches.push({
            note,
            markdown,
            modifiedMs,
            score: match.score,
            filenameMatched: match.filenameMatched,
            source,
            taskId: getDoc2XNoteTaskId(note),
          });
        } catch (error) {
          ztoolkit.log(
            `[Doc2XBridge] failed to inspect note ${noteID}: ${error}`,
            "warn",
          );
        }
      }

      matches.sort((a, b) => b.score - a.score || b.modifiedMs - a.modifiedMs);

      let sourcePDFCount = 0;
      for (const attachmentID of parent.getAttachments?.() || []) {
        try {
          const sibling = await Zotero.Items.getAsync(attachmentID);
          if (
            sibling?.isPDFAttachment?.() &&
            !isDoc2XGeneratedPDFAttachment(sibling)
          ) {
            sourcePDFCount++;
          }
        } catch {
          /* ignore attachments that disappeared during lookup */
        }
      }

      const bridgeMetaPath = PathUtils.join(
        this.getAttachmentDir(attachment.key),
        "doc2x-meta.json",
      );
      let bridgeMeta: any = null;
      try {
        bridgeMeta = JSON.parse(await IOUtils.readUTF8(bridgeMetaPath));
      } catch {
        /* ignore */
      }

      for (const candidate of matches) {
        const knownSameNote = bridgeMeta?.noteKey === candidate.note.key;
        if (
          sourcePDFCount > 1 &&
          !candidate.filenameMatched &&
          !knownSameNote
        ) {
          ztoolkit.log(
            "[Doc2XBridge] skipped ambiguous note " +
              candidate.note.key +
              " for PDF " +
              attachment.key +
              "; the parent has " +
              sourcePDFCount +
              " source PDFs and no filename affinity",
            "warn",
          );
          continue;
        }
        const fingerprintChanged =
          knownSameNote &&
          (bridgeMeta.fileSize !== stat?.size ||
            bridgeMeta.fileMTime !== stat?.mtime);
        if (fingerprintChanged) {
          const noteWasRefreshed =
            candidate.modifiedMs &&
            bridgeMeta?.noteModifiedMs &&
            candidate.modifiedMs > bridgeMeta.noteModifiedMs + 1000;
          if (!noteWasRefreshed) {
            ztoolkit.log(
              `[Doc2XBridge] PDF fingerprint changed after Doc2X note ${candidate.note.key} was linked; waiting for a refreshed Doc2X original note or MinerU reparse`,
            );
            continue;
          }
          ztoolkit.log(
            `[Doc2XBridge] PDF changed, but Doc2X note ${candidate.note.key} was modified afterwards; accepting refreshed Markdown`,
          );
        }

        // Important: on first encounter do NOT compare Zotero note time with
        // filesystem mtime. Sync/copy operations can touch a PDF after Doc2X
        // parsed it without changing the document. We trust the current
        // original Doc2X note once, record the exact fingerprint, and detect
        // real later changes from that baseline.
        try {
          await IOUtils.makeDirectory(this.getAttachmentDir(attachment.key), {
            ignoreExisting: true,
            createAncestors: true,
          });
          await IOUtils.writeUTF8(
            bridgeMetaPath,
            JSON.stringify(
              {
                noteKey: candidate.note.key,
                noteTaskId: candidate.taskId || "",
                noteModifiedMs: candidate.modifiedMs,
                source: candidate.source,
                fileSize: stat?.size || 0,
                fileMTime: stat?.mtime || 0,
                markdownLength: candidate.markdown.length,
                recordedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
          );
        } catch (error) {
          ztoolkit.log(
            `[Doc2XBridge] failed to save PDF fingerprint for ${attachment.key}: ${error}`,
            "warn",
          );
        }

        ztoolkit.log(
          `[Doc2XBridge] reusing original Doc2X Markdown ${candidate.note.key} for PDF ${attachment.key} via ${candidate.source} (${candidate.markdown.length} chars, score=${candidate.score})`,
        );
        return {
          markdown: candidate.markdown,
          noteKey: candidate.note.key,
          taskId: candidate.taskId,
          source: candidate.source,
        };
      }

      if (noteIDs.length > 0) {
        ztoolkit.log(
          `[Doc2XBridge] no reusable original Doc2X Markdown found for ${attachment.key}; inspected ${noteIDs.length} notes`,
        );
      }
    } catch (error) {
      ztoolkit.log(
        `[Doc2XBridge] lookup failed for PDF ${attachment?.key}: ${error}`,
        "warn",
      );
    }
    return null;
  }

  /** Recover a reusable Markdown generated by this plugin even if the
   * shared cache directory was removed. */
  private async readFreshMinerUMarkdownAttachment(
    attachment: any,
    stat: { size: number; mtime: number } | null,
  ): Promise<{ markdown: string } | null> {
    const parentItemID = attachment?.parentItemID;
    if (!parentItemID) return null;
    const fileName = attachment.attachmentFilename || `${attachment.key}.pdf`;
    const baseName = sanitizeFileName(fileName.replace(/\.pdf$/i, ""));
    const titles = new Set([
      `${MARKDOWN_ATTACHMENT_PREFIX} (${attachment.key}).md`,
      `MinerU · ${baseName}`,
    ]);
    try {
      const parent = await Zotero.Items.getAsync(parentItemID);
      if (!parent) return null;
      for (const childID of parent.getAttachments?.() || []) {
        const child = await Zotero.Items.getAsync(childID);
        if (!child?.isAttachment?.()) continue;
        const title = child.getField?.("title") || "";
        if (!titles.has(title)) continue;
        const modifiedMs = zoteroItemModifiedMs(child);
        if (modifiedMs && stat?.mtime && modifiedMs + 2000 < stat.mtime) {
          ztoolkit.log(
            `[MinerU] generated Markdown attachment ${child.key} is older than current PDF; ignoring stale attachment`,
          );
          continue;
        }
        const mdPath = child.getFilePathAsync
          ? await child.getFilePathAsync()
          : child.getFilePath?.();
        if (!mdPath) continue;
        const mdStat = await this.statFile(mdPath);
        if (!mdStat || mdStat.size <= 0 || mdStat.size > 16 * 1024 * 1024)
          continue;
        const markdown = await IOUtils.readUTF8(mdPath);
        if (!markdown?.trim()) continue;
        ztoolkit.log(
          `[MinerU] reusing generated Markdown attachment ${child.key} for PDF ${attachment.key}`,
        );
        return { markdown };
      }
    } catch (error) {
      ztoolkit.log(
        `[MinerU] generated Markdown attachment lookup failed ${attachment?.key}: ${error}`,
        "warn",
      );
    }
    return null;
  }

  /**
   * The signature records parse settings for diagnostics, but cache reuse
   * depends on the PDF fingerprint. Server or token changes do not reparse a stable PDF.
   */
  private getSignature(config: MinerUServiceConfig): string {
    return [
      `v${CACHE_VERSION}`,
      config.mode,
      config.modelVersion,
      config.language,
      config.enableOCR ? "ocr" : "noocr",
      config.enableFormula ? "formula" : "noformula",
      config.enableTable ? "table" : "notable",
    ].join("|");
  }

  // ============== 对外接口 ==============

  /**
   * Reuse order: Doc2X source, MinerU cache, generated Markdown attachment, then optional parsing.
   */
  async getMarkdownForAttachment(
    attachment: any,
    options: GetMarkdownOptions = {},
  ): Promise<string | null> {
    const config = this.getConfig();
    if (!config.enabled && options.ignoreEnabled !== true) return null;
    if (!attachment?.key) return null;
    if (isDoc2XGeneratedPDFAttachment(attachment)) {
      ztoolkit.log(
        `[PDFSelection] refusing high-precision parse for Doc2X generated PDF ${attachment.key}: ${getAttachmentLabel(attachment)}`,
      );
      return null;
    }

    const allowParse =
      options.allowParse === true ||
      (options.allowParse === undefined && config.blockingOnDemand);

    try {
      const filePath = attachment.getFilePathAsync
        ? await attachment.getFilePathAsync()
        : attachment.getFilePath?.();
      if (!filePath) return null;

      const stat = await this.statFile(filePath);
      if (!stat) return null;
      const doc2x =
        options.force === true
          ? null
          : await this.readFreshDoc2XMarkdown(attachment, stat);
      if (doc2x?.markdown) {
        options.onOrigin?.("doc2x");
        return doc2x.markdown;
      }

      // 1) 先查缓存
      const cached =
        options.force === true
          ? null
          : await this.readCache(attachment.key, config, stat);
      if (cached?.markdown) {
        ztoolkit.log(
          `[MinerU] 命中缓存 ${attachment.key}（${cached.markdown.length} 字符）`,
        );
        if (config.attachMarkdown) {
          await this.syncMarkdownAttachment(
            attachment,
            cached.markdown,
            attachment.attachmentFilename || `${attachment.key}.pdf`,
            { replaceExisting: false },
          );
        }
        options.onOrigin?.("mineru_cache");
        return cached.markdown;
      }
      const attachedMinerU =
        options.force === true
          ? null
          : await this.readFreshMinerUMarkdownAttachment(attachment, stat);
      if (attachedMinerU?.markdown) {
        options.onOrigin?.("mineru_attachment");
        return attachedMinerU.markdown;
      }
      if (cached?.skipReason) {
        if (options.ignoreFailureCache) {
          ztoolkit.log(
            `[MinerU] ${attachment.key} 上次解析失败（${cached.skipReason}），本次为强制重试，忽略冷却`,
          );
        } else {
          ztoolkit.log(`[MinerU] 跳过 ${attachment.key}：${cached.skipReason}`);
          return null;
        }
      }

      if (!allowParse) {
        ztoolkit.log(
          `[MinerU] ${attachment.key} 无缓存且当前路径不允许阻塞解析，返回空结果`,
        );
        return null;
      }
      const maxBytes = config.maxFileSizeMB * 1024 * 1024;
      if (stat.size > maxBytes) {
        ztoolkit.log(
          `[MinerU] ${attachment.key} 体积 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过上限 ${config.maxFileSizeMB}MB，跳过`,
          "warn",
        );
        return null;
      }
      const existing = this.inFlight.get(attachment.key);
      if (existing) {
        ztoolkit.log(`[MinerU] ${attachment.key} 已在解析中，复用同一任务`);
        options.onOrigin?.("mineru_parsed");
        return existing;
      }

      const task = this.parseAndCache(
        attachment,
        filePath,
        stat,
        config,
      ).finally(() => {
        this.inFlight.delete(attachment.key);
      });
      this.inFlight.set(attachment.key, task);
      options.onOrigin?.("mineru_parsed");
      return await task;
    } catch (error) {
      ztoolkit.log(
        `[MinerU] getMarkdownForAttachment 失败 ${attachment?.key}: ${error}`,
        "warn",
      );
      return null;
    }
  }

  /**
   * Return cleaned text suitable for vector and full-text indexing.
   */
  async getIndexTextForAttachment(
    attachment: any,
    options: GetMarkdownOptions = {},
  ): Promise<string | null> {
    const markdown = await this.getMarkdownForAttachment(attachment, options);
    if (!markdown) return null;
    const text = markdownToIndexText(markdown);
    return text.trim() ? text : null;
  }

  /**
   * Check whether the shared MinerU cache is fresh for this PDF without
   * parsing, attaching files, or depending on the legacy enable switch.
   * Semantic-index fast paths use this to ensure a vector created from the
   * old PDF extractor never prevents generation of the reader's Markdown.
   */
  async hasFreshMarkdownForAttachment(attachment: any): Promise<boolean> {
    if (!attachment?.key) return false;
    try {
      const filePath = attachment.getFilePathAsync
        ? await attachment.getFilePathAsync()
        : attachment.getFilePath?.();
      if (!filePath) return false;
      const stat = await this.statFile(filePath);
      if (!stat) return false;
      const doc2x = await this.readFreshDoc2XMarkdown(attachment, stat);
      if (doc2x?.markdown?.trim()) return true;
      const cached = await this.readCache(
        attachment.key,
        this.getConfig(),
        stat,
      );
      if (cached?.markdown?.trim()) return true;
      const attachedMinerU = await this.readFreshMinerUMarkdownAttachment(
        attachment,
        stat,
      );
      return Boolean(attachedMinerU?.markdown?.trim());
    } catch (error) {
      ztoolkit.log(
        `[MinerU] cache freshness check failed ${attachment?.key}: ${error}`,
        "warn",
      );
      return false;
    }
  }

  /**
   * Reset statistics so each indexing result covers only the current run.
   */
  resetRunStats(): void {
    this.runFailures = [];
    this.runAttachments = 0;
  }

  /** Failures and generated attachments from the current run. */
  getRunStats(): {
    failures: number;
    lastError?: string;
    attachments: number;
  } {
    const last = this.runFailures[this.runFailures.length - 1];
    return {
      failures: this.runFailures.length,
      lastError: last ? `${last.fileName}: ${last.message}` : undefined,
      attachments: this.runAttachments,
    };
  }

  /** 清空全部 MinerU 缓存 */
  async clearCache(): Promise<void> {
    const root = this.getCacheRoot();
    await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
    ztoolkit.log(`[MinerU] Cleared cache directory ${root}`);
  }

  /** Cache entry and disk usage statistics for the preferences UI. */
  async getCacheStats(): Promise<{ entries: number; bytes: number }> {
    const root = this.getCacheRoot();
    let entries = 0;
    let bytes = 0;
    try {
      const children = await IOUtils.getChildren(root);
      for (const dir of children) {
        const mdPath = PathUtils.join(dir, "full.md");
        const stat = await this.statFile(mdPath);
        if (stat) {
          entries++;
          bytes += stat.size;
        }
      }
    } catch {
      /* 目录尚不存在 */
    }
    return { entries, bytes };
  }

  /**
   * Test cloud credentials or local mineru-api availability.
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const config = this.getConfig();
    try {
      if (config.mode === "local") {
        return await this.testLocalConnection(config.baseURL);
      }

      if (!config.apiToken) {
        return { ok: false, message: "请先填写 MinerU API Token" };
      }
      // Probe with a missing batch ID: authentication errors still validate the token.
      const response = await resolveFetch()(
        `${config.baseURL}/api/v4/extract-results/batch/zotero-mcp-connectivity-check`,
        {
          method: "GET",
          headers: {
            Accept: "*/*",
            Authorization: `Bearer ${config.apiToken}`,
          },
        },
      );
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: "API Token 无效或已过期" };
      }
      const data: any = await response.json().catch(() => null);
      if (data && (data.code === -10001 || data.code === 401)) {
        return { ok: false, message: data.msg || "API Token 无效" };
      }
      return {
        ok: true,
        message: `云端模式：MinerU 接口连通，Token 可用（${config.baseURL}）`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `连接失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Probe local mineru-api readiness.
   * Prefer /health and fall back to OpenAPI route inspection for older versions.
   * 是否开放（生产部署常把文档关掉）。只有当对面根本没有 /health 路由时，
   * Route validation prevents unrelated HTTP services from passing the check.
   */
  private async testLocalConnection(
    baseURL: string,
  ): Promise<{ ok: boolean; message: string }> {
    const where = `本地模式：${baseURL}`;
    const health = await this.probeLocalEndpoint(`${baseURL}/health`);
    if (!health.response) {
      return {
        ok: false,
        message: this.describeLocalProbeError(where, health),
      };
    }
    if (health.response.ok) {
      return { ok: true, message: `${where} mineru-api 可用` };
    }
    if (health.response.status === 404 || health.response.status === 405) {
      return await this.testLocalConnectionViaOpenAPI(baseURL, where);
    }
    return {
      ok: false,
      message: `${where} /health 返回 HTTP ${health.response.status}，mineru-api 未就绪`,
    };
  }

  /** Timed local GET returning either a response or an error result. */
  private async probeLocalEndpoint(
    url: string,
  ): Promise<{ response?: Response; error?: any; aborted?: boolean }> {
    const controller = new (resolveAbortController())();
    const timer = setTimeout(() => controller.abort(), LOCAL_PROBE_TIMEOUT_MS);
    try {
      const response = await resolveFetch()(url, {
        method: "GET",
        signal: controller.signal,
      });
      return { response };
    } catch (error) {
      return { error, aborted: controller.signal.aborted };
    } finally {
      clearTimeout(timer);
    }
  }

  private describeLocalProbeError(
    where: string,
    probe: { error?: any; aborted?: boolean },
  ): string {
    if (probe.aborted) {
      return `${where} 无响应（${LOCAL_PROBE_TIMEOUT_MS / 1000} 秒超时），请确认 mineru-api 已启动`;
    }
    const error = probe.error;
    return `${where} 连接失败，请确认 mineru-api 已启动：${error instanceof Error ? error.message : String(error)}`;
  }

  /**
   * Older mineru-api versions without /health are verified through OpenAPI routes.
   */
  private async testLocalConnectionViaOpenAPI(
    baseURL: string,
    where: string,
  ): Promise<{ ok: boolean; message: string }> {
    const probe = await this.probeLocalEndpoint(`${baseURL}/openapi.json`);
    if (!probe.response) {
      return { ok: false, message: this.describeLocalProbeError(where, probe) };
    }
    if (!probe.response.ok) {
      return {
        ok: false,
        message: `${where} has no /health endpoint and OpenAPI returned HTTP ${probe.response.status}; unable to verify mineru-api`,
      };
    }

    const schema: any = await probe.response.json().catch(() => null);
    const paths = schema?.paths;
    if (!paths || typeof paths !== "object") {
      return {
        ok: false,
        message: `${where} 有服务在响应，但不是 mineru-api（读不到 OpenAPI 路由表）`,
      };
    }
    if (!Object.prototype.hasOwnProperty.call(paths, "/file_parse")) {
      return {
        ok: false,
        message: `${where} responded but has no /file_parse endpoint; it is not mineru-api`,
      };
    }

    return { ok: true, message: `${where} mineru-api 可用` };
  }

  // ============== 内部实现 ==============

  private async parseAndCache(
    attachment: any,
    filePath: string,
    stat: { size: number; mtime: number },
    config: MinerUServiceConfig,
  ): Promise<string | null> {
    if (isDoc2XGeneratedPDFAttachment(attachment)) {
      ztoolkit.log(
        `[PDFSelection] skipped MinerU parse for Doc2X generated PDF ${attachment?.key}: ${getAttachmentLabel(attachment)}`,
      );
      return null;
    }
    this.semaphore.setLimit(config.concurrency);
    const release = await this.semaphore.acquire();
    const started = Date.now();
    const fileName = attachment.attachmentFilename || `${attachment.key}.pdf`;

    try {
      ztoolkit.log(
        `[MinerU] Parsing ${fileName} (${(stat.size / 1024 / 1024).toFixed(1)}MB, mode=${config.mode})`,
      );
      this.emitProgress({
        phase: "start",
        attachmentKey: attachment.key,
        fileName,
      });
      const client = new MinerUClient({
        mode: config.mode,
        baseURL: config.baseURL,
        apiToken: config.apiToken,
        modelVersion: config.modelVersion,
        language: config.language,
        enableOCR: config.enableOCR,
        enableFormula: config.enableFormula,
        enableTable: config.enableTable,
        timeoutSeconds: config.timeoutSeconds,
        tmpDir: this.getTmpDir(),
      });

      const result = await client.parseLocalFile(
        filePath,
        fileName,
        attachment.key,
      );

      if (!result.markdown || !result.markdown.trim()) {
        throw new Error("MinerU returned empty Markdown");
      }

      await this.writeCache(attachment.key, config, stat, fileName, result);
      ztoolkit.log(
        `[MinerU] 解析完成 ${fileName}：${result.markdown.length} 字符，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      // Cache paths are opaque, so attach Markdown to make results visible in Zotero.
      if (config.attachMarkdown) {
        await this.syncMarkdownAttachment(
          attachment,
          result.markdown,
          fileName,
          {
            replaceExisting: true,
          },
        );
      }
      this.emitProgress({
        phase: "done",
        attachmentKey: attachment.key,
        fileName,
        markdownLength: result.markdown.length,
        elapsedMs: Date.now() - started,
      });
      return result.markdown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ztoolkit.log(`[MinerU] 解析失败 ${fileName}: ${message}`, "warn");
      this.runFailures.push({ fileName, message });
      this.emitProgress({
        phase: "failed",
        attachmentKey: attachment.key,
        fileName,
        message,
        elapsedMs: Date.now() - started,
      });
      await this.writeFailure(attachment.key, config, stat, fileName, message);
      return null;
    } finally {
      release();
    }
  }

  /**
   * Synchronize parsed Markdown as a child attachment of the PDF parent item.
   * Keep one generated attachment per source PDF and replace it only when requested.
   * Do not suppress notifier events because Zotero uses them to refresh the item tree.
   * 抑制它等于附件只进了数据库、界面上看不见，非重启不显形——这正是用户
   * Avoid indexing loops in the notifier listener by filtering generated content types.
   */
  private async syncMarkdownAttachment(
    attachment: any,
    markdown: string,
    fileName: string,
    options: { replaceExisting: boolean },
  ): Promise<void> {
    const parentItemID = attachment?.parentItemID;
    if (!parentItemID) {
      ztoolkit.log(
        `[MinerU] ${attachment?.key} 没有父条目，跳过 Markdown 附件挂载`,
      );
      return;
    }

    const baseName = sanitizeFileName(fileName.replace(/\.pdf$/i, ""));
    const title = `${MARKDOWN_ATTACHMENT_PREFIX} (${attachment.key}).md`;
    const legacyTitles = new Set([title, `MinerU · ${baseName}`]);
    const tmpPath = PathUtils.join(
      this.getTmpDir(),
      `${sanitizeFileName(attachment.key)}-${baseName}.md`,
    );

    try {
      const parent = await Zotero.Items.getAsync(parentItemID);
      if (!parent) return;

      // Find generated Markdown attachments already associated with this PDF.
      const existing: any[] = [];
      for (const childID of parent.getAttachments?.() || []) {
        try {
          const child = await Zotero.Items.getAsync(childID);
          if (!child) continue;
          const childTitle = child.getField?.("title") || "";
          if (legacyTitles.has(childTitle)) {
            existing.push(child);
          }
        } catch (e) {
          ztoolkit.log(`[MinerU] 读取子附件失败：${e}`, "warn");
        }
      }

      if (existing.length > 0 && !options.replaceExisting) {
        const keep =
          existing.find((child) => child.getField?.("title") === title) ||
          existing[0];
        if (keep.getField?.("title") !== title) {
          keep.setField("title", title);
          await keep.saveTx();
        }
        for (const child of existing) {
          if (child.id === keep.id) continue;
          try {
            ztoolkit.log(
              `[MinerU] removing duplicate generated Markdown attachment ${child.key}`,
            );
            await child.eraseTx();
          } catch (error) {
            ztoolkit.log(
              `[MinerU] failed to remove duplicate Markdown attachment ${child.key}: ${error}`,
              "warn",
            );
          }
        }
        return;
      }

      for (const child of existing) {
        try {
          ztoolkit.log(
            `[MinerU] Replacing existing Markdown attachment ${child.key}`,
          );
          await child.eraseTx();
        } catch (e) {
          ztoolkit.log(
            `[MinerU] Failed to delete old Markdown attachment: ${e}`,
            "warn",
          );
        }
      }

      await IOUtils.makeDirectory(this.getTmpDir(), {
        ignoreExisting: true,
        createAncestors: true,
      });
      await IOUtils.writeUTF8(tmpPath, markdown);

      const imported = await Zotero.Attachments.importFromFile({
        file: tmpPath,
        parentItemID,
        title,
        contentType: "text/markdown",
        charset: "utf-8",
      });
      this.runAttachments++;
      ztoolkit.log(
        `[MinerU] Attached Markdown ${imported?.key} to item ${parent.key}: ${title}`,
      );
    } catch (error) {
      // Attachment failures do not invalidate the Markdown retained in cache.
      ztoolkit.log(
        `[MinerU] 挂载 Markdown 附件失败 ${attachment?.key}：${error}`,
        "warn",
      );
    } finally {
      try {
        await IOUtils.remove(tmpPath, { ignoreAbsent: true });
      } catch (_) {
        /* Temporary file cleanup is best effort. */
      }
    }
  }

  /**
   * Return the shared high-precision parse artifacts used by the embedded
   * reader. The authoritative Markdown may come from Doc2X or MinerU; raw
   * MinerU geometry is exposed only when its cache is fresh for this PDF.
   */
  async getRichParseForAttachment(
    attachment: any,
    options: GetMarkdownOptions = {},
  ): Promise<{
    markdown: string;
    rawFiles: Record<string, string>;
    files: Record<string, string>;
  } | null> {
    const markdown = await this.getMarkdownForAttachment(attachment, options);
    if (!markdown) return null;

    let rawFiles: Record<string, string> = {};
    try {
      const filePath = attachment.getFilePathAsync
        ? await attachment.getFilePathAsync()
        : attachment.getFilePath?.();
      const stat = filePath ? await this.statFile(filePath) : null;
      const doc2x =
        options.force === true || !stat
          ? null
          : await this.readFreshDoc2XMarkdown(attachment, stat);
      if (!doc2x?.markdown) {
        const cached = stat
          ? await this.readCache(attachment.key, this.getConfig(), stat)
          : null;
        if (cached?.markdown) {
          rawFiles = await this.readArtifactFiles(attachment.key);
        }
      } else {
        ztoolkit.log(
          `[Doc2XBridge] reader will use Doc2X Markdown without MinerU raw JSON for ${attachment.key}`,
        );
      }
    } catch (error) {
      ztoolkit.log(
        `[HighPrecisionPDF] failed to inspect structured cache for ${attachment?.key}: ${error}`,
        "warn",
      );
    }

    // The selected Markdown is authoritative. Always overwrite full.md so
    // stale artifacts can never override the Doc2X/MinerU reuse decision.
    rawFiles["full.md"] = markdown;
    return { markdown, rawFiles, files: rawFiles };
  }

  private async readArtifactFiles(
    attachmentKey: string,
  ): Promise<Record<string, string>> {
    const dir = this.getAttachmentDir(attachmentKey);
    const files: Record<string, string> = {};
    let totalBytes = 0;

    const readDirectory = async (base: string, prefix = "") => {
      let children: string[];
      try {
        children = await IOUtils.getChildren(base);
      } catch {
        return;
      }
      for (const child of children) {
        const name = String(child).split(/[\\/]/).pop() || "";
        if (!/\.(?:md|json)$/i.test(name)) continue;
        if (
          ["meta.json", "parse.json", "translation-cache.json"].includes(
            name.toLowerCase(),
          )
        )
          continue;
        const stat = await this.statFile(child);
        if (
          !stat ||
          stat.size > 16 * 1024 * 1024 ||
          totalBytes + stat.size > 64 * 1024 * 1024
        )
          continue;
        try {
          files[`${prefix}${name}`] = await IOUtils.readUTF8(child);
          totalBytes += stat.size;
        } catch (error) {
          ztoolkit.log(
            `[MinerU] Failed to read structured cache ${name}: ${error}`,
            "warn",
          );
        }
      }
    };

    await readDirectory(dir);
    await readDirectory(PathUtils.join(dir, "raw"), "raw/");
    return files;
  }

  async updateCachedMarkdown(
    attachment: any,
    markdown: string,
  ): Promise<boolean> {
    const value = String(markdown || "");
    if (!value.trim()) throw new Error("Markdown cannot be empty");
    if (new TextEncoder().encode(value).byteLength > 16 * 1024 * 1024) {
      throw new Error("Markdown exceeds the 16 MB safety limit");
    }
    const dir = this.getAttachmentDir(attachment.key);
    await IOUtils.makeDirectory(dir, {
      ignoreExisting: true,
      createAncestors: true,
    });
    await IOUtils.writeUTF8(PathUtils.join(dir, "full.md"), value);

    const metaPath = PathUtils.join(dir, "meta.json");
    try {
      const meta = JSON.parse(await IOUtils.readUTF8(metaPath));
      meta.markdownLength = value.length;
      meta.editedAt = new Date().toISOString();
      await IOUtils.writeUTF8(metaPath, JSON.stringify(meta, null, 2));
    } catch {
      /* ignore */
    }

    const config = this.getConfig();
    if (config.attachMarkdown) {
      await this.syncMarkdownAttachment(
        attachment,
        value,
        attachment.attachmentFilename || `${attachment.key}.pdf`,
        { replaceExisting: true },
      );
    }
    return true;
  }

  private async statFile(
    path: string,
  ): Promise<{ size: number; mtime: number } | null> {
    try {
      const info = await IOUtils.stat(path);
      return {
        size: Number(info.size) || 0,
        mtime: Number(info.lastModified) || 0,
      };
    } catch {
      return null;
    }
  }

  private async readCache(
    attachmentKey: string,
    config: MinerUServiceConfig,
    stat: { size: number; mtime: number },
  ): Promise<{ markdown?: string; skipReason?: string } | null> {
    const dir = this.getAttachmentDir(attachmentKey);
    const metaPath = PathUtils.join(dir, "meta.json");

    let meta: CacheMeta | null = null;
    try {
      const raw = await IOUtils.readUTF8(metaPath);
      meta = JSON.parse(raw) as CacheMeta;
    } catch {
      return null;
    }
    if (!meta) return null;

    const sourceFresh =
      meta.version === CACHE_VERSION &&
      meta.fileSize === stat.size &&
      meta.fileMTime === stat.mtime;
    if (!sourceFresh) {
      ztoolkit.log(
        `[MinerU] PDF 已变更，已有 Markdown 不再复用：${attachmentKey}`,
      );
      return null;
    }
    if (meta.signature !== this.getSignature(config)) {
      ztoolkit.log(
        `[MinerU] Parse config changed but PDF did not; reusing Markdown for ${attachmentKey}`,
      );
    }
    if (meta.error) {
      const elapsed = Date.now() - (meta.failedAt || 0);
      if (elapsed < FAILURE_RETRY_MS) {
        return {
          skipReason: `上次解析失败（${meta.error}），冷却中`,
        };
      }
      return null;
    }

    try {
      const markdown = await IOUtils.readUTF8(PathUtils.join(dir, "full.md"));
      return markdown?.trim() ? { markdown } : null;
    } catch {
      return null;
    }
  }

  private async writeCache(
    attachmentKey: string,
    config: MinerUServiceConfig,
    stat: { size: number; mtime: number },
    fileName: string,
    result: {
      markdown: string;
      contentList: string | null;
      files?: Record<string, string>;
    },
  ): Promise<void> {
    const dir = this.getAttachmentDir(attachmentKey);
    await IOUtils.makeDirectory(dir, {
      ignoreExisting: true,
      createAncestors: true,
    });
    // A new MinerU result invalidates reader block geometry and translations
    // generated from the previous source. The reader will rebuild parse.json
    // lazily from this same full.md/raw cache on first use.
    await IOUtils.remove(PathUtils.join(dir, "parse.json"), {
      ignoreAbsent: true,
    });
    await IOUtils.remove(PathUtils.join(dir, "translation-cache.json"), {
      ignoreAbsent: true,
    });
    await IOUtils.writeUTF8(PathUtils.join(dir, "full.md"), result.markdown);
    if (result.contentList) {
      await IOUtils.writeUTF8(
        PathUtils.join(dir, "content_list.json"),
        result.contentList,
      );
    }
    const rawDir = PathUtils.join(dir, "raw");
    await IOUtils.remove(rawDir, { recursive: true, ignoreAbsent: true });
    await IOUtils.makeDirectory(rawDir, {
      ignoreExisting: true,
      createAncestors: true,
    });
    let rawTotalBytes = 0;
    for (const [name, content] of Object.entries(result.files || {})) {
      if (typeof content !== "string" || !/\.(?:md|json)$/i.test(name))
        continue;
      const bytes = new TextEncoder().encode(content).byteLength;
      if (
        bytes > 16 * 1024 * 1024 ||
        rawTotalBytes + bytes > 64 * 1024 * 1024
      ) {
        ztoolkit.log(`[MinerU] 跳过过大的结构化结果文件：${name}`, "warn");
        continue;
      }
      rawTotalBytes += bytes;
      await IOUtils.writeUTF8(
        PathUtils.join(rawDir, sanitizeFileName(name)),
        content,
      );
    }
    const meta: CacheMeta = {
      version: CACHE_VERSION,
      attachmentKey,
      fileName,
      fileSize: stat.size,
      fileMTime: stat.mtime,
      signature: this.getSignature(config),
      parsedAt: new Date().toISOString(),
      markdownLength: result.markdown.length,
    };
    await IOUtils.writeUTF8(
      PathUtils.join(dir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );
  }

  private async writeFailure(
    attachmentKey: string,
    config: MinerUServiceConfig,
    stat: { size: number; mtime: number },
    fileName: string,
    message: string,
  ): Promise<void> {
    try {
      const dir = this.getAttachmentDir(attachmentKey);
      await IOUtils.makeDirectory(dir, {
        ignoreExisting: true,
        createAncestors: true,
      });
      // Never leave an old readable Markdown/overlay behind after the source
      // changed and its replacement parse failed.
      await IOUtils.remove(PathUtils.join(dir, "full.md"), {
        ignoreAbsent: true,
      });
      await IOUtils.remove(PathUtils.join(dir, "parse.json"), {
        ignoreAbsent: true,
      });
      await IOUtils.remove(PathUtils.join(dir, "translation-cache.json"), {
        ignoreAbsent: true,
      });
      await IOUtils.remove(PathUtils.join(dir, "raw"), {
        recursive: true,
        ignoreAbsent: true,
      });
      const meta: CacheMeta = {
        version: CACHE_VERSION,
        attachmentKey,
        fileName,
        fileSize: stat.size,
        fileMTime: stat.mtime,
        signature: this.getSignature(config),
        parsedAt: new Date().toISOString(),
        markdownLength: 0,
        error: message.slice(0, 500),
        failedAt: Date.now(),
      };
      await IOUtils.writeUTF8(
        PathUtils.join(dir, "meta.json"),
        JSON.stringify(meta, null, 2),
      );
    } catch (error) {
      ztoolkit.log(`[MinerU] 写入失败记录出错：${error}`, "warn");
    }
  }
}

/**
 * Clean MinerU Markdown for embedding while preserving heading structure.
 */
export function markdownToIndexText(markdown: string): string {
  if (!markdown) return "";
  return (
    markdown
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/<img[^>]*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<\/?(?:div|span|br|p|sup|sub|font|table|tr|td|th|tbody|thead)[^>]*>/gi,
        " ",
      )
      // 链接保留文字部分
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // 公式包裹符去掉，保留内容
      .replace(/\$\$/g, " ")
      .replace(/\\\[|\\\]|\\\(|\\\)/g, " ")
      .replace(/^\s*\|?[\s:-]*\|[\s|:-]*$/gm, "")
      // 强调符号
      .replace(/(\*\*|__|~~)/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Decode the lossless Markdown payload embedded by Doc2X notes.
 * Doc2X 1.1.6 stores Base64(JSON.stringify({md})) in both a comment and
 * a hidden data-doc2x-md attribute. Zotero can normalize/sanitize note HTML,
 * so the matcher intentionally accepts either quote style and HTML-escaped
 * padding. A second exact-source fallback lives in readDoc2XMarkdownSourceFile().
 */
function decodeDoc2XMarkdownSource(noteHTML: string): string | null {
  if (!noteHTML) return null;
  const html = String(noteHTML);
  const dataMatch = html.match(/data-doc2x-md\s*=\s*["']([^"']+)["']/i);
  const commentMatch = html.match(
    /<!--\s*doc2x-md-source\s*:\s*([^\s-]+)\s*-->/i,
  );
  let encoded = dataMatch?.[1] || commentMatch?.[1];
  if (!encoded) return null;
  encoded = encoded
    .replace(/&#(?:61|x3d);/gi, "=")
    .replace(/&amp;/gi, "&")
    .trim();
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const json = new TextDecoder("utf-8").decode(bytes);
    const parsed = JSON.parse(json);
    return typeof parsed?.md === "string" && parsed.md.trim()
      ? parsed.md
      : null;
  } catch (error) {
    ztoolkit.log(
      `[Doc2XBridge] failed to decode embedded Markdown: ${error}`,
      "warn",
    );
    return null;
  }
}

/** Convert a rendered Zotero/Doc2X note back into Markdown.
 *
 * Doc2X 1.1.6 may persist only the rendered Zotero note (HTML) and no
 * data-doc2x-md payload/source file. In that case the note itself is the
 * authoritative reusable parse result. This converter intentionally keeps
 * document structure useful for semantic indexing while ignoring Zotero
 * wrapper elements, embedded-image bytes and Doc2X "Meanless" comments.
 */
function doc2xRenderedNoteToMarkdown(
  noteHTML: string,
  noteTitle = "",
): string | null {
  const input = String(noteHTML || "").trim();
  if (!input) return null;

  const win = Zotero.getMainWindow?.() || null;
  const Parser = (globalThis as any).DOMParser || win?.DOMParser;

  const normalizeText = (value: any) =>
    String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ");
  const escapeInline = (value: any) =>
    normalizeText(value)
      .replace(/\\/g, "\\\\")
      .replace(/([`*_])/g, "\\$1");
  const cleanMarkdown = (value: any) =>
    String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  if (!Parser) {
    // Conservative fallback for unusual Zotero contexts without DOMParser.
    const plain = input
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote)>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
    let cleaned = cleanMarkdown(plain);
    const fallbackFirstLine = cleaned.split("\n", 1)[0]?.trim() || "";
    if (
      /(?:原文MD|original_MD).*\.md$/i.test(fallbackFirstLine) ||
      (noteTitle && fallbackFirstLine === String(noteTitle).trim())
    ) {
      cleaned = cleanMarkdown(cleaned.slice(cleaned.indexOf("\n") + 1));
    }
    return cleaned.length >= 100 ? cleaned : null;
  }

  let doc: any;
  try {
    doc = new Parser().parseFromString(input, "text/html");
  } catch {
    return null;
  }

  const renderTable = (table: any) => {
    const rows = Array.from<any>(table.querySelectorAll?.("tr") || []);
    const matrix = rows
      .map((row: any) =>
        Array.from<any>(row.children || [])
          .filter((cell: any) => /^(TH|TD)$/i.test(cell.tagName || ""))
          .map((cell: any) =>
            cleanMarkdown(renderChildren(cell))
              .replace(/\n+/g, " ")
              .replace(/\|/g, "\\|"),
          ),
      )
      .filter((row: any) => row.length > 0);
    if (!matrix.length) return "";
    const width = Math.max(...matrix.map((row: any) => row.length));
    const normalized = matrix.map((row: any) =>
      row.concat(Array(Math.max(0, width - row.length)).fill("")),
    );
    const firstHasTH = !!(rows[0] as any)?.querySelector?.("th");
    const header = normalized[0];
    const body = normalized.slice(1);
    const separator = Array(width).fill("---");
    const lines = [header, separator, ...body].map(
      (row: any) => `| ${row.join(" | ")} |`,
    );
    // Even when Doc2X emitted only td cells, treating the first row as a
    // Markdown header preserves a valid table and all cell text.
    return `${lines.join("\n")}\n\n`;
  };

  const renderNode = (node: any, listDepth = 0): string => {
    if (!node) return "";
    if (node.nodeType === 3) return escapeInline(node.nodeValue || "");
    if (node.nodeType === 8) return "";
    if (node.nodeType !== 1) return renderChildren(node, listDepth);
    const tag = String(node.tagName || "").toLowerCase();
    if (
      [
        "script",
        "style",
        "svg",
        "canvas",
        "iframe",
        "object",
        "embed",
      ].includes(tag)
    )
      return "";
    if (tag === "br") return "\n";
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      return `${"#".repeat(level)} ${cleanMarkdown(renderChildren(node, listDepth))}\n\n`;
    }
    if (tag === "p")
      return `${cleanMarkdown(renderChildren(node, listDepth))}\n\n`;
    if (tag === "strong" || tag === "b")
      return `**${renderChildren(node, listDepth)}**`;
    if (tag === "em" || tag === "i")
      return `*${renderChildren(node, listDepth)}*`;
    if (tag === "s" || tag === "del")
      return `~~${renderChildren(node, listDepth)}~~`;
    if (
      tag === "code" &&
      node.parentElement?.tagName?.toLowerCase() !== "pre"
    ) {
      return `\`${String(node.textContent || "").replace(/`/g, "\\`")}\``;
    }
    if (tag === "pre") {
      return `\n\`\`\`\n${String(node.textContent || "").trim()}\n\`\`\`\n\n`;
    }
    if (tag === "blockquote") {
      const body = cleanMarkdown(renderChildren(node, listDepth));
      return `${body
        .split("\n")
        .map((line: string) => `> ${line}`)
        .join("\n")}\n\n`;
    }
    if (tag === "a") {
      const label =
        cleanMarkdown(renderChildren(node, listDepth)) ||
        String(node.textContent || "").trim();
      const href = String(node.getAttribute?.("href") || "").trim();
      return href && /^(?:https?:|mailto:|zotero:)/i.test(href)
        ? `[${label}](${href})`
        : label;
    }
    if (tag === "img") {
      const alt = String(node.getAttribute?.("alt") || "").trim();
      // Embedded note images are stored separately in Zotero. Do not emit
      // data/blob URLs into the semantic Markdown; retain useful alt text.
      return alt ? `[Image: ${escapeInline(alt)}]` : "";
    }
    if (tag === "hr") return "\n---\n\n";
    if (tag === "table") return renderTable(node);
    if (tag === "ul" || tag === "ol") {
      let i = 0;
      let out = "";
      for (const child of Array.from<any>(node.children || [])) {
        if (String(child.tagName || "").toLowerCase() !== "li") continue;
        i++;
        const marker = tag === "ol" ? `${i}. ` : "- ";
        const raw = cleanMarkdown(renderChildren(child, listDepth + 1));
        if (!raw) continue;
        const indent = "  ".repeat(listDepth);
        const lines = raw.split("\n");
        out += `${indent}${marker}${lines[0]}\n`;
        for (const extra of lines.slice(1)) out += `${indent}  ${extra}\n`;
      }
      return `${out}\n`;
    }
    if (tag === "li") return renderChildren(node, listDepth);
    if (
      [
        "div",
        "section",
        "article",
        "main",
        "header",
        "footer",
        "figure",
        "figcaption",
      ].includes(tag)
    ) {
      return `${renderChildren(node, listDepth)}\n`;
    }
    return renderChildren(node, listDepth);
  };

  function renderChildren(node: any, listDepth = 0): string {
    let out = "";
    for (const child of Array.from<any>(node?.childNodes || []))
      out += renderNode(child, listDepth);
    return out;
  }

  const body = doc.body || doc.documentElement;
  if (!body) return null;
  let markdown = cleanMarkdown(renderChildren(body));
  if (!markdown) return null;

  // Doc2X writes its synthetic filename as the first paragraph/title. It is
  // metadata, not paper content, so remove only the first matching line.
  const titleCandidates = [String(noteTitle || "").trim()];
  const firstLine = markdown.split("\n", 1)[0]?.trim() || "";
  if (
    /(?:原文MD|original_MD).*\.md$/i.test(firstLine) ||
    titleCandidates.some((t) => t && firstLine === t)
  ) {
    markdown = cleanMarkdown(markdown.slice(markdown.indexOf("\n") + 1));
  }

  // Guard against accepting a title-only/empty Doc2X note as a parse result.
  return markdown.length >= 100 ? markdown : null;
}

async function readDoc2XMarkdownSourceFile(note: any): Promise<string | null> {
  const noteKey = note?.key;
  if (!noteKey) return null;
  try {
    const path = PathUtils.join(
      Zotero.DataDirectory.dir,
      "plugins",
      "doc2x-addon",
      "md-sources",
      `${noteKey}.json`,
    );
    const raw = await IOUtils.readUTF8(path);
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.pages)) return null;
    const markdown = data.pages
      .map((page: any) => (typeof page?.md === "string" ? page.md : ""))
      .filter(Boolean)
      .join("\n");
    if (!markdown.trim()) return null;
    ztoolkit.log(
      `[Doc2XBridge] recovered Markdown from Doc2X md-sources/${noteKey}.json`,
    );
    return markdown;
  } catch {
    return null;
  }
}

function getDoc2XNoteTaskId(note: any): string {
  const noteID = note?.id;
  if (!noteID) return "";
  try {
    return String(
      Zotero.Prefs.get(`extensions.doc2x.noteTaskId:${noteID}`, true) || "",
    ).trim();
  } catch {
    return "";
  }
}

export function getAttachmentLabel(attachment: any): string {
  const values: string[] = [];
  try {
    const title = attachment?.getField?.("title");
    if (title) values.push(String(title));
  } catch {
    /* ignore */
  }
  if (attachment?.attachmentFilename)
    values.push(String(attachment.attachmentFilename));
  return values.join(" ");
}

function isDoc2XGeneratedPDFAttachment(attachment: any): boolean {
  if (!attachment?.isPDFAttachment?.()) return false;
  const label = getAttachmentLabel(attachment);
  return /(?:译文PDF|双语PDF|保留排版(?:双语|译文)PDF|translate_PDF|both_PDF|translate_PDF_original_format|both_PDF_original_format)/i.test(
    label,
  );
}

export async function getOriginalPDFAttachmentsForItem(
  item: any,
): Promise<any[]> {
  if (!item?.isRegularItem?.()) return [];
  const pdfs: any[] = [];
  for (const attachmentID of item.getAttachments?.() || []) {
    try {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (!attachment?.isPDFAttachment?.()) continue;
      if (isDoc2XGeneratedPDFAttachment(attachment)) {
        ztoolkit.log(
          `[PDFSelection] skip Doc2X generated PDF ${attachment.key}: ${getAttachmentLabel(attachment)}`,
        );
        continue;
      }
      pdfs.push(attachment);
    } catch (error) {
      ztoolkit.log(
        `[PDFSelection] failed to inspect attachment ${attachmentID}: ${error}`,
        "warn",
      );
    }
  }
  if (pdfs.length <= 1) return pdfs;

  // Prefer Zotero's best attachment when available. Different Zotero versions
  // have returned either an item or an ID here, hence the defensive handling.
  try {
    const best = await item.getBestAttachment?.();
    const bestID = typeof best === "number" ? best : best?.id;
    const matched = pdfs.find((pdf) => pdf.id === bestID);
    if (matched) {
      ztoolkit.log(
        `[PDFSelection] selected Zotero best/original PDF ${matched.key}; ignored ${pdfs.length - 1} other non-Doc2X PDFs`,
      );
      return [matched];
    }
  } catch {
    /* ignore */
  }

  // Stable fallback: the earliest attachment ID is normally the imported
  // source paper, while generated/secondary files are added later.
  pdfs.sort((a, b) => (a.id || 0) - (b.id || 0));
  ztoolkit.log(
    `[PDFSelection] selected earliest original PDF ${pdfs[0].key}; ignored ${pdfs.length - 1} additional PDFs`,
  );
  return [pdfs[0]];
}

function zoteroItemModifiedMs(item: any): number {
  const value = item?.dateModified || item?.getField?.("dateModified") || "";
  if (!value) return 0;
  try {
    const date = Zotero.Date?.sqlToDate?.(String(value), true);
    const ms = date?.getTime?.();
    if (Number.isFinite(ms)) return ms;
  } catch {
    /* ignore */
  }
  const normalized = String(value).includes("T")
    ? String(value)
    : String(value).replace(" ", "T") + "Z";
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function doc2xOriginalNoteMatch(
  note: any,
  attachment: any,
  noteHTML: string,
): { score: number; filenameMatched: boolean } | null {
  const candidates: string[] = [];
  try {
    const title = note?.getNoteTitle?.();
    if (title) candidates.push(String(title));
  } catch {
    /* ignore */
  }
  try {
    const title = note?.getField?.("title");
    if (title) candidates.push(String(title));
  } catch {
    /* ignore */
  }
  if (noteHTML) {
    const leadingText = String(noteHTML)
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    if (leadingText) candidates.push(leadingText);
  }
  const combined = candidates.join(" ");
  if (/(?:译文MD|双语MD|translate_MD|both_MD)/i.test(combined)) return null;
  if (!/(?:原文MD|original_MD)/i.test(combined)) return null;

  let score = 10;
  // Filename affinity is useful when an item really has multiple source PDFs,
  // but must not be a hard requirement: Doc2X truncates/localizes titles and
  // users can rename Zotero attachments after the note was created.
  const fileName =
    String(attachment?.attachmentFilename || "")
      .split(/[\\/]/)
      .pop() || "";
  const base = fileName
    .replace(/\.pdf$/i, "")
    .slice(0, 20)
    .trim()
    .toLowerCase();
  const filenameMatched =
    base.length > 0 && combined.toLowerCase().includes(base);
  if (filenameMatched) score += 5;
  if (getDoc2XNoteTaskId(note)) score += 3;
  return { score, filenameMatched };
}

function clampInt(
  value: any,
  min: number,
  max: number,
  fallback: number,
): number {
  const num = parseInt(String(value), 10);
  if (isNaN(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

let instance: MinerUService | null = null;

export function getMinerUService(): MinerUService {
  if (!instance) {
    instance = new MinerUService();
  }
  return instance;
}
