/**
 * MinerU 解析服务
 *
 * 保存每个 PDF 的结构化 JSON 缓存，并将组装后的 Markdown 仅作为 Zotero
 * 子附件保存。缓存目录不保存 Markdown 正文副本。
 */

import {
  MinerUClient,
  type MinerUMode,
  type MinerUParseResult,
  normalizeMinerUBaseURL,
  resolveAbortController,
  resolveFetch,
  sanitizeFileName,
} from "./minerUClient";
import {
  ASSEMBLER_VERSION,
  assembleStructuredDocument,
  hashDocumentText,
  selectStructuredSource,
  type AssembledDocument,
  type StructuredSource,
} from "./structuredDocumentAssembler";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;
declare const ztoolkit: ZToolkit;

const PREF_PREFIX = "extensions.zotero.zotero-mcp-plugin.";

/** 缓存格式版本，格式变更时递增即可让旧缓存自动失效 */
const CACHE_VERSION = 2;

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
  libraryID?: number;
  fileName: string;
  fileSize: number;
  fileMTime: number;
  signature: string;
  parsedAt: string;
  markdownLength: number;
  parserVersion?: string | null;
  structuredFormat?: string;
  structuredFileName?: string;
  structuredHash?: string;
  assemblerVersion?: number;
  markdownHash?: string;
  generatedAttachmentKey?: string;
  generatedAt?: string;
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
  /** The user explicitly requested a new parse/regeneration. */
  userInitiated?: boolean;
  /**
   * An index build found the canonical Markdown missing. Recreate it from a
   * valid structured cache, or allow a new parse when no cache can be used.
   */
  restoreMissingMarkdown?: boolean;
  /** Reports that the canonical Zotero Markdown attachment changed. */
  onAttachmentChanged?: () => void;
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

/**
 * Flatten a ZIP entry into a Windows-safe cache filename without truncating
 * the structured-format suffix that source selection relies on.
 */
function structuredCacheFileName(value: string): string {
  const leaf = String(value || "structured.json")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\\/:*?"<>|\r\n]/g, "_");
  if (leaf.length <= 180) return leaf;
  const sourceSuffix =
    leaf.match(
      /(?:content_list_v2|content_list|model|layout|middle)\.json$/i,
    )?.[0] ||
    "structured.json";
  const identity = hashDocumentText(value).replace(/^.*:/, "");
  const tail = `-${identity}_${sourceSuffix}`;
  return `${leaf.slice(0, 180 - tail.length)}${tail}`;
}

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
  private limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

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

interface CachedStructuredResult {
  meta: CacheMeta;
  source: StructuredSource;
  assembled: AssembledDocument;
}

interface CachedStructuredFailure {
  skipReason: string;
  /** This entry cannot be reused and must be discarded before a retry. */
  discardBeforeRetry?: boolean;
}

interface GeneratedMarkdownAttachment {
  item: any;
  key: string;
  markdown: string;
}

interface MarkdownAttachmentState {
  version: 1;
  suppressed: Record<string, { deletedAt: string; parentKey?: string }>;
}

export class MinerUService {
  private semaphore = new Semaphore(2);
  /** In-flight work keyed by attachment to prevent duplicate parsing. */
  private inFlight = new Map<string, Promise<string | null>>();
  /** MinerU failures/fallbacks in the current indexing run, deduplicated by PDF. */
  private runFailures = new Map<
    string,
    { fileName: string; message: string }
  >();
  /** Markdown attachments created during the current indexing run. */
  private runAttachments = 0;
  /** 界面进度监听器；解析是分钟级操作，没有它用户只能盯着一个不动的弹窗 */
  private progressListener: MinerUProgressListener | null = null;
  private attachmentState: MarkdownAttachmentState | null = null;
  private attachmentStateWrite: Promise<void> = Promise.resolve();
  private ownReplacementAttachmentKeys = new Set<string>();

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
    };
  }

  isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  // ============== 缓存路径 ==============

  private getCacheRoot(): string {
    return PathUtils.join(Zotero.DataDirectory.dir, "zotero-mcp", "mineru");
  }

  private getAttachmentStatePath(): string {
    return PathUtils.join(
      Zotero.DataDirectory.dir,
      "zotero-mcp",
      "mineru-attachment-state.json",
    );
  }

  private getAttachmentDir(attachmentKey: string): string {
    return PathUtils.join(this.getCacheRoot(), sanitizeFileName(attachmentKey));
  }

  private getTmpDir(): string {
    return PathUtils.join(this.getCacheRoot(), "tmp");
  }

  private sourceIdentity(libraryID: number, attachmentKey: string): string {
    return `${Number(libraryID) || Zotero.Libraries.userLibraryID}:${attachmentKey}`;
  }

  private async readAttachmentState(): Promise<MarkdownAttachmentState> {
    if (this.attachmentState) return this.attachmentState;
    try {
      const parsed = JSON.parse(
        await IOUtils.readUTF8(this.getAttachmentStatePath()),
      );
      if (parsed?.version === 1 && parsed?.suppressed) {
        this.attachmentState = parsed as MarkdownAttachmentState;
        return this.attachmentState;
      }
    } catch {
      // First run or damaged state: start empty and rewrite on the next change.
    }
    this.attachmentState = { version: 1, suppressed: {} };
    return this.attachmentState;
  }

  private async writeAttachmentState(): Promise<void> {
    const state = await this.readAttachmentState();
    this.attachmentStateWrite = this.attachmentStateWrite.then(async () => {
      const path = this.getAttachmentStatePath();
      await IOUtils.makeDirectory(PathUtils.parent(path), {
        ignoreExisting: true,
        createAncestors: true,
      });
      await IOUtils.writeUTF8(path, JSON.stringify(state, null, 2));
    });
    await this.attachmentStateWrite;
  }

  async suppressAutomaticMarkdown(
    libraryID: number,
    sourceAttachmentKey: string,
  ): Promise<void> {
    if (!sourceAttachmentKey) return;
    const state = await this.readAttachmentState();
    let parentKey: string | undefined;
    try {
      const source = await Zotero.Items.getByLibraryAndKeyAsync?.(
        libraryID,
        sourceAttachmentKey,
      );
      parentKey =
        source?.parentItem?.key ||
        source?.parentItemKey ||
        (source?.parentItemID
          ? (await Zotero.Items.getAsync(source.parentItemID))?.key
          : undefined);
    } catch {
      // Deletion notifications may arrive after the source PDF is gone.
    }
    state.suppressed[this.sourceIdentity(libraryID, sourceAttachmentKey)] = {
      deletedAt: new Date().toISOString(),
      parentKey,
    };
    await this.writeAttachmentState();
  }

  async allowAutomaticMarkdown(
    libraryID: number,
    sourceAttachmentKey: string,
  ): Promise<void> {
    if (!sourceAttachmentKey) return;
    const state = await this.readAttachmentState();
    const identity = this.sourceIdentity(libraryID, sourceAttachmentKey);
    if (!(identity in state.suppressed)) return;
    delete state.suppressed[identity];
    await this.writeAttachmentState();
  }

  async forgetAutomaticMarkdownState(
    libraryID: number,
    sourceAttachmentKey: string,
  ): Promise<void> {
    await this.allowAutomaticMarkdown(libraryID, sourceAttachmentKey);
  }

  async forgetAutomaticMarkdownStateForParent(
    libraryID: number,
    parentKey: string,
  ): Promise<void> {
    if (!parentKey) return;
    const state = await this.readAttachmentState();
    let changed = false;
    for (const [identity, entry] of Object.entries(state.suppressed)) {
      if (
        identity.startsWith(`${Number(libraryID)}:`) &&
        entry.parentKey === parentKey
      ) {
        delete state.suppressed[identity];
        changed = true;
      }
    }
    if (changed) await this.writeAttachmentState();
  }

  async isAutomaticMarkdownSuppressed(attachment: any): Promise<boolean> {
    const state = await this.readAttachmentState();
    return Boolean(
      state.suppressed[
        this.sourceIdentity(attachment?.libraryID, attachment?.key || "")
      ],
    );
  }

  consumeOwnReplacementDeletion(attachmentKey: string): boolean {
    if (!this.ownReplacementAttachmentKeys.has(attachmentKey)) return false;
    this.ownReplacementAttachmentKeys.delete(attachmentKey);
    return true;
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
  ): Promise<GeneratedMarkdownAttachment | null> {
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
        return { item: child, key: child.key, markdown };
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

      // Structured cache may upgrade an existing attachment, but it must not
      // recreate one that the user removed.
      const cached =
        options.force === true
          ? null
          : await this.readStructuredCache(attachment.key, config, stat);
      const structured =
        cached && "assembled" in cached ? cached : null;
      const attachedMinerU =
        options.force === true
          ? null
          : await this.readFreshMinerUMarkdownAttachment(attachment, stat);

      if (structured && attachedMinerU) {
        const currentAttachment =
          structured.meta.assemblerVersion === ASSEMBLER_VERSION &&
          structured.meta.structuredHash === structured.source.structuredHash &&
          structured.meta.generatedAttachmentKey === attachedMinerU.key &&
          structured.meta.markdownHash ===
            hashDocumentText(attachedMinerU.markdown);
        if (!currentAttachment) {
          const synced = await this.syncMarkdownAttachment(
            attachment,
            structured.assembled.markdown,
            attachment.attachmentFilename || `${attachment.key}.pdf`,
            { replaceExisting: true },
          );
          if (!synced) return null;
          await this.updateCacheAttachmentMeta(
            attachment.key,
            structured,
            synced,
          );
          options.onAttachmentChanged?.();
          options.onOrigin?.("mineru_attachment");
          return synced.markdown;
        }
        options.onOrigin?.("mineru_attachment");
        return attachedMinerU.markdown;
      }

      if (attachedMinerU && options.restoreMissingMarkdown) {
        await this.allowAutomaticMarkdown(
          attachment.libraryID,
          attachment.key,
        );
        options.onOrigin?.("mineru_attachment");
        return attachedMinerU.markdown;
      }

      if (structured && options.restoreMissingMarkdown) {
        const synced = await this.syncMarkdownAttachment(
          attachment,
          structured.assembled.markdown,
          attachment.attachmentFilename || `${attachment.key}.pdf`,
          { replaceExisting: true },
        );
        if (!synced) return null;
        await this.updateCacheAttachmentMeta(
          attachment.key,
          structured,
          synced,
        );
        await this.allowAutomaticMarkdown(
          attachment.libraryID,
          attachment.key,
        );
        options.onAttachmentChanged?.();
        options.onOrigin?.("mineru_cache");
        return synced.markdown;
      }

      if (structured && !options.userInitiated) {
        await this.suppressAutomaticMarkdown(
          attachment.libraryID,
          attachment.key,
        );
        ztoolkit.log(
          `[MinerU] structured cache exists but generated Markdown is absent; respecting deletion for ${attachment.key}`,
        );
        return null;
      }

      if (cached && "skipReason" in cached) {
        if (options.ignoreFailureCache) {
          ztoolkit.log(
            `[MinerU] retrying ${attachment.key} despite cached failure: ${cached.skipReason}`,
          );
          if (
            options.restoreMissingMarkdown &&
            allowParse &&
            cached.discardBeforeRetry
          ) {
            await IOUtils.remove(this.getAttachmentDir(attachment.key), {
              recursive: true,
              ignoreAbsent: true,
            });
            ztoolkit.log(
              `[MinerU] removed unusable structured cache before index recovery for ${attachment.key}`,
            );
          }
        } else {
          ztoolkit.log(`[MinerU] skipping ${attachment.key}: ${cached.skipReason}`);
          return null;
        }
      }

      if (
        !options.userInitiated &&
        !options.restoreMissingMarkdown &&
        (await this.isAutomaticMarkdownSuppressed(attachment))
      ) {
        ztoolkit.log(
          `[MinerU] automatic Markdown regeneration suppressed for ${attachment.key}`,
        );
        return null;
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
        options,
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
      if (options.userInitiated) throw error;
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
      const cached = await this.readStructuredCache(
        attachment.key,
        this.getConfig(),
        stat,
      );
      const attachedMinerU = await this.readFreshMinerUMarkdownAttachment(
        attachment,
        stat,
      );
      if (!attachedMinerU?.markdown?.trim()) return false;
      if (!cached || !("assembled" in cached)) return false;
      return (
        cached.meta.assemblerVersion === ASSEMBLER_VERSION &&
        cached.meta.structuredHash === cached.source.structuredHash &&
        cached.meta.generatedAttachmentKey === attachedMinerU.key &&
        cached.meta.markdownHash === hashDocumentText(attachedMinerU.markdown)
      );
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
    this.runFailures.clear();
    this.runAttachments = 0;
  }

  /** Record that an index build had to use Zotero's built-in PDF extractor. */
  recordIndexFallback(attachment: any, message?: string): void {
    const key = String(attachment?.key || attachment?.attachmentFilename || "pdf");
    if (this.runFailures.has(key)) return;
    const fileName = String(
      attachment?.attachmentFilename || attachment?.key || "PDF",
    );
    this.runFailures.set(key, {
      fileName,
      message:
        message ||
        "MinerU did not produce a canonical Markdown attachment; Zotero PDF extraction was used",
    });
  }

  /** Failures and generated attachments from the current run. */
  getRunStats(): {
    failures: number;
    lastError?: string;
    attachments: number;
  } {
    const failures = [...this.runFailures.values()];
    const last = failures[failures.length - 1];
    return {
      failures: failures.length,
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
        const meta = await this.statFile(PathUtils.join(dir, "meta.json"));
        if (!meta) continue;
        entries++;
        bytes += meta.size;
        try {
          for (const artifact of await IOUtils.getChildren(
            PathUtils.join(dir, "raw"),
          )) {
            const stat = await this.statFile(artifact);
            if (stat) bytes += stat.size;
          }
        } catch {
          // A failure-only cache entry has no raw directory.
        }
      }
    } catch {
      /* 目录尚不存在 */
    }
    return { entries, bytes };
  }

  /** Remove legacy Markdown copies and normalize persistent caches to JSON. */
  async migrateLegacyCaches(): Promise<void> {
    let directories: string[] = [];
    try {
      directories = await IOUtils.getChildren(this.getCacheRoot());
    } catch {
      return;
    }

    for (const dir of directories) {
      const attachmentKey = String(dir).split(/[\\/]/).pop() || "";
      if (!attachmentKey || attachmentKey === "tmp") continue;
      let meta: CacheMeta;
      try {
        meta = JSON.parse(
          await IOUtils.readUTF8(PathUtils.join(dir, "meta.json")),
        ) as CacheMeta;
      } catch {
        continue;
      }

      const removeLegacyCopies = async (): Promise<void> => {
        for (const name of ["full.md", "parse.json"]) {
          await IOUtils.remove(PathUtils.join(dir, name), {
            ignoreAbsent: true,
          });
        }
        try {
          for (const child of await IOUtils.getChildren(
            PathUtils.join(dir, "raw"),
          )) {
            if (/\.md$/i.test(String(child))) {
              await IOUtils.remove(child, { ignoreAbsent: true });
            }
          }
        } catch {
          // Failure-only and partially migrated entries may have no raw dir.
        }
      };

      await removeLegacyCopies();
      if (meta.version >= CACHE_VERSION) {
        continue;
      }

      const files = await this.readArtifactFiles(attachmentKey);
      let source: StructuredSource | null = null;
      let assembled: AssembledDocument | null = null;
      let migrationError: string | null = null;
      try {
        source = selectStructuredSource(files);
        assembled = assembleStructuredDocument(source);
      } catch (error) {
        migrationError = `legacy structured cache is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }

      const rawDir = PathUtils.join(dir, "raw");
      if (source && assembled) {
        await IOUtils.remove(rawDir, { recursive: true, ignoreAbsent: true });
        await IOUtils.makeDirectory(rawDir, {
          ignoreExisting: true,
          createAncestors: true,
        });
        let totalBytes = 0;
        for (const [name, content] of Object.entries(files)) {
          if (!/\.json$/i.test(name)) continue;
          const baseName = name.split(/[\\/]/).pop()?.toLowerCase() || "";
          if (
            [
              "meta.json",
              "parse.json",
              "translation-cache.json",
              "doc2x-meta.json",
            ].includes(baseName)
          ) {
            continue;
          }
          const byteLength = new TextEncoder().encode(content).byteLength;
          if (byteLength > 16 * 1024 * 1024 || totalBytes + byteLength > 64 * 1024 * 1024) {
            continue;
          }
          totalBytes += byteLength;
          await IOUtils.writeUTF8(
            PathUtils.join(rawDir, structuredCacheFileName(name)),
            content,
          );
        }
      }

      let children: string[] = [];
      try {
        children = await IOUtils.getChildren(dir);
      } catch {
        // The entry disappeared while migrating.
      }
      for (const child of children) {
        const name = String(child).split(/[\\/]/).pop()?.toLowerCase() || "";
        if (
          (Boolean(source && assembled) &&
            /\.json$/i.test(name) &&
            ![
              "meta.json",
              "doc2x-meta.json",
              "translation-cache.json",
            ].includes(name))
        ) {
          await IOUtils.remove(child, { ignoreAbsent: true });
        }
      }

      let generated: GeneratedMarkdownAttachment | null = null;
      let sourceAttachment: any = null;
      try {
        sourceAttachment = await Zotero.Items.getByLibraryAndKeyAsync?.(
          meta.libraryID ?? Zotero.Libraries.userLibraryID,
          attachmentKey,
        );
        if (sourceAttachment) {
          generated = await this.readFreshMinerUMarkdownAttachment(
            sourceAttachment,
            null,
          );
        }
      } catch {
        // Binding is best effort; the next access can bind the attachment.
      }

      const migrated: CacheMeta = {
        ...meta,
        version: CACHE_VERSION,
        signature:
          source && assembled
            ? this.getSignature(this.getConfig())
            : meta.signature,
        parserVersion: source?.parserVersion ?? null,
        structuredFormat: source?.format,
        structuredFileName: source?.fileName,
        structuredHash: source?.structuredHash,
        // Existing Markdown came from MinerU full.md and must be rebuilt.
        assemblerVersion: generated ? 0 : undefined,
        generatedAttachmentKey: generated?.key,
        markdownHash: generated
          ? hashDocumentText(generated.markdown)
          : undefined,
        markdownLength: generated?.markdown.length ?? 0,
        error: migrationError || undefined,
        failedAt: migrationError ? Date.now() : undefined,
      };
      await IOUtils.writeUTF8(
        PathUtils.join(dir, "meta.json"),
        JSON.stringify(migrated, null, 2),
      );
      if (!generated) {
        await this.suppressAutomaticMarkdown(
          meta.libraryID ?? Zotero.Libraries.userLibraryID,
          attachmentKey,
        );
      }
    }
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
    options: GetMarkdownOptions,
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
      const assembled = assembleStructuredDocument(result.structuredSource);
      await this.writeCache(
        attachment,
        config,
        stat,
        fileName,
        result,
        assembled,
      );
      const synced = await this.syncMarkdownAttachment(
        attachment,
        assembled.markdown,
        fileName,
        { replaceExisting: true },
      );
      if (!synced) {
        throw new Error("Could not create the canonical Zotero Markdown attachment");
      }
      const cached: CachedStructuredResult = {
        meta: await this.readMeta(attachment.key),
        source: result.structuredSource,
        assembled,
      };
      await this.updateCacheAttachmentMeta(attachment.key, cached, synced);
      if (options.userInitiated || options.restoreMissingMarkdown) {
        await this.allowAutomaticMarkdown(attachment.libraryID, attachment.key);
      }
      options.onAttachmentChanged?.();
      ztoolkit.log(
        `[MinerU] structured parse completed ${fileName}: ${synced.markdown.length} Markdown characters in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      this.emitProgress({
        phase: "done",
        attachmentKey: attachment.key,
        fileName,
        markdownLength: synced.markdown.length,
        elapsedMs: Date.now() - started,
      });
      return synced.markdown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ztoolkit.log(`[MinerU] 解析失败 ${fileName}: ${message}`, "warn");
      this.runFailures.set(String(attachment.key || fileName), {
        fileName,
        message,
      });
      this.emitProgress({
        phase: "failed",
        attachmentKey: attachment.key,
        fileName,
        message,
        elapsedMs: Date.now() - started,
      });
      await this.writeFailure(attachment.key, config, stat, fileName, message);
      if (options.userInitiated) throw error;
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
  ): Promise<GeneratedMarkdownAttachment | null> {
    const parentItemID = attachment?.parentItemID;
    if (!parentItemID) {
      ztoolkit.log(
        `[MinerU] ${attachment?.key} 没有父条目，跳过 Markdown 附件挂载`,
      );
      return null;
    }

    const baseName = sanitizeFileName(fileName.replace(/\.pdf$/i, ""));
    const title = `${MARKDOWN_ATTACHMENT_PREFIX} (${attachment.key}).md`;
    const legacyTitles = new Set([title, `MinerU · ${baseName}`]);
    const tmpPath = PathUtils.join(
      this.getTmpDir(),
      `${sanitizeFileName(attachment.key)}-${baseName}.md`,
    );

    let imported: any = null;
    try {
      const parent = await Zotero.Items.getAsync(parentItemID);
      if (!parent) return null;

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
            this.ownReplacementAttachmentKeys.add(child.key);
            await child.eraseTx();
          } catch (error) {
            ztoolkit.log(
              `[MinerU] failed to remove duplicate Markdown attachment ${child.key}: ${error}`,
              "warn",
            );
          }
        }
        const keepPath = keep.getFilePathAsync
          ? await keep.getFilePathAsync()
          : keep.getFilePath?.();
        if (!keepPath) return null;
        const keepMarkdown = await IOUtils.readUTF8(keepPath);
        return { item: keep, key: keep.key, markdown: keepMarkdown };
      }

      await IOUtils.makeDirectory(this.getTmpDir(), {
        ignoreExisting: true,
        createAncestors: true,
      });
      await IOUtils.writeUTF8(tmpPath, markdown);

      imported = await Zotero.Attachments.importFromFile({
        file: tmpPath,
        parentItemID,
        title,
        contentType: "text/markdown",
        charset: "utf-8",
      });
      ztoolkit.log(
        `[MinerU] Attached Markdown ${imported?.key} to item ${parent.key}: ${title}`,
      );
      const importedPath = imported?.getFilePathAsync
        ? await imported.getFilePathAsync()
        : imported?.getFilePath?.();
      if (!imported?.key || !importedPath) {
        throw new Error("Zotero imported the Markdown attachment without a readable file");
      }
      const importedMarkdown = await IOUtils.readUTF8(importedPath);
      if (!importedMarkdown?.trim()) {
        throw new Error("The imported Zotero Markdown attachment is empty");
      }
      this.runAttachments++;
      for (const child of existing) {
        try {
          ztoolkit.log(
            `[MinerU] Replacing existing Markdown attachment ${child.key}`,
          );
          this.ownReplacementAttachmentKeys.add(child.key);
          await child.eraseTx();
        } catch (e) {
          ztoolkit.log(
            `[MinerU] Failed to delete old Markdown attachment: ${e}`,
            "warn",
          );
        }
      }
      return {
        item: imported,
        key: imported.key,
        markdown: importedMarkdown,
      };
    } catch (error) {
      if (imported?.key) {
        try {
          this.ownReplacementAttachmentKeys.add(imported.key);
          await imported.eraseTx?.();
        } catch (cleanupError) {
          ztoolkit.log(
            `[MinerU] failed to remove unreadable imported Markdown ${imported.key}: ${cleanupError}`,
            "warn",
          );
        }
      }
      ztoolkit.log(
        `[MinerU] 挂载 Markdown 附件失败 ${attachment?.key}：${error}`,
        "warn",
      );
      return null;
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
    blocks: AssembledDocument["blocks"];
    structuredHash: string | null;
    assemblerVersion: number;
  } | null> {
    const markdown = await this.getMarkdownForAttachment(attachment, options);
    if (!markdown) return null;

    let rawFiles: Record<string, string> = {};
    let blocks: AssembledDocument["blocks"] = [];
    let structuredHash: string | null = null;
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
          ? await this.readStructuredCache(
              attachment.key,
              this.getConfig(),
              stat,
            )
          : null;
        if (cached && "assembled" in cached) {
          rawFiles = await this.readArtifactFiles(attachment.key);
          blocks = cached.assembled.blocks;
          structuredHash = cached.source.structuredHash;
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

    return {
      markdown,
      rawFiles,
      files: rawFiles,
      blocks,
      structuredHash,
      assemblerVersion: ASSEMBLER_VERSION,
    };
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
        if (!/\.json$/i.test(name)) continue;
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

  private async readMeta(attachmentKey: string): Promise<CacheMeta> {
    const raw = await IOUtils.readUTF8(
      PathUtils.join(this.getAttachmentDir(attachmentKey), "meta.json"),
    );
    return JSON.parse(raw) as CacheMeta;
  }

  private async readStructuredCache(
    attachmentKey: string,
    config: MinerUServiceConfig,
    stat: { size: number; mtime: number },
  ): Promise<CachedStructuredResult | CachedStructuredFailure | null> {
    let meta: CacheMeta | null = null;
    try {
      meta = await this.readMeta(attachmentKey);
    } catch {
      return null;
    }
    if (!meta) return null;

    const sourceFresh =
      (meta.version === 1 || meta.version === CACHE_VERSION) &&
      meta.fileSize === stat.size &&
      meta.fileMTime === stat.mtime;
    if (!sourceFresh) {
      ztoolkit.log(
        `[MinerU] PDF changed; structured cache is stale for ${attachmentKey}`,
      );
      return null;
    }
    if (meta.signature !== this.getSignature(config)) {
      ztoolkit.log(
        `[MinerU] parse settings changed; structured cache is stale for ${attachmentKey}`,
      );
      return null;
    }
    if (meta.error) {
      const elapsed = Date.now() - (meta.failedAt || 0);
      if (elapsed < FAILURE_RETRY_MS) {
        return {
          skipReason: `上次解析失败（${meta.error}），冷却中`,
          discardBeforeRetry: true,
        };
      }
      return null;
    }

    try {
      const files = await this.readArtifactFiles(attachmentKey);
      const source = selectStructuredSource(files);
      return {
        meta,
        source,
        assembled: assembleStructuredDocument(source),
      };
    } catch (error) {
      return {
        skipReason: `structured MinerU cache is invalid: ${error instanceof Error ? error.message : String(error)}`,
        discardBeforeRetry: true,
      };
    }
  }

  private async writeCache(
    attachment: any,
    config: MinerUServiceConfig,
    stat: { size: number; mtime: number },
    fileName: string,
    result: MinerUParseResult,
    assembled: AssembledDocument,
  ): Promise<void> {
    const attachmentKey = attachment.key;
    const dir = this.getAttachmentDir(attachmentKey);
    await IOUtils.makeDirectory(dir, {
      ignoreExisting: true,
      createAncestors: true,
    });
    // Canonical Markdown lives only in Zotero. Derived Reader/translation data
    // is invalidated whenever the structured source changes.
    await IOUtils.remove(PathUtils.join(dir, "full.md"), {
      ignoreAbsent: true,
    });
    await IOUtils.remove(PathUtils.join(dir, "parse.json"), {
      ignoreAbsent: true,
    });
    await IOUtils.remove(PathUtils.join(dir, "translation-cache.json"), {
      ignoreAbsent: true,
    });
    for (const legacyName of [
      "content_list.json",
      "content_list_v2.json",
      "model.json",
      "layout.json",
    ]) {
      await IOUtils.remove(PathUtils.join(dir, legacyName), {
        ignoreAbsent: true,
      });
    }
    const rawDir = PathUtils.join(dir, "raw");
    await IOUtils.remove(rawDir, { recursive: true, ignoreAbsent: true });
    await IOUtils.makeDirectory(rawDir, {
      ignoreExisting: true,
      createAncestors: true,
    });
    let rawTotalBytes = 0;
    for (const [name, content] of Object.entries(result.files || {})) {
      if (typeof content !== "string" || !/\.json$/i.test(name)) continue;
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
        PathUtils.join(rawDir, structuredCacheFileName(name)),
        content,
      );
    }
    const meta: CacheMeta = {
      version: CACHE_VERSION,
      attachmentKey,
      libraryID: attachment.libraryID,
      fileName,
      fileSize: stat.size,
      fileMTime: stat.mtime,
      signature: this.getSignature(config),
      parsedAt: new Date().toISOString(),
      markdownLength: assembled.markdown.length,
      parserVersion: result.structuredSource.parserVersion,
      structuredFormat: result.structuredSource.format,
      structuredFileName: result.structuredSource.fileName,
      structuredHash: result.structuredSource.structuredHash,
      assemblerVersion: ASSEMBLER_VERSION,
      markdownHash: hashDocumentText(assembled.markdown),
    };
    await IOUtils.writeUTF8(
      PathUtils.join(dir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );
  }

  private async updateCacheAttachmentMeta(
    attachmentKey: string,
    cached: CachedStructuredResult,
    attached: GeneratedMarkdownAttachment,
  ): Promise<void> {
    const meta: CacheMeta = {
      ...cached.meta,
      version: CACHE_VERSION,
      parserVersion: cached.source.parserVersion,
      structuredFormat: cached.source.format,
      structuredFileName: cached.source.fileName,
      structuredHash: cached.source.structuredHash,
      assemblerVersion: ASSEMBLER_VERSION,
      markdownLength: attached.markdown.length,
      markdownHash: hashDocumentText(attached.markdown),
      generatedAttachmentKey: attached.key,
      generatedAt: new Date().toISOString(),
    };
    await IOUtils.writeUTF8(
      PathUtils.join(this.getAttachmentDir(attachmentKey), "meta.json"),
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
