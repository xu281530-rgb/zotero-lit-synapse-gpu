/**
 * Unified PDF body-text source for the MCP content tools.
 *
 * get_content 和 search_fulltext 以前各自实现了一遍「先问 MinerU、不行再回退」的
 * 逻辑，两边的参数并不一致。这里把它收成唯一入口，两个工具的 PDF 正文获取策略
 * 完全相同，并统一受「允许 MCP 接口即时解析」(mineru.blockingOnDemand) 控制。
 *
 * 解析、缓存、.md 挂载全部委托给 MinerUService，向量更新委托给
 * SemanticSearchService，本模块不重复实现任何一项。
 */

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

/** Title prefix of the Markdown attachments MinerUService writes. */
const MARKDOWN_ATTACHMENT_PREFIX = "MinerU Markdown";
/** Master switch for semantic search; mirrors the constant used in hooks.ts. */
const SEMANTIC_ENABLED_PREF =
  "extensions.zotero.zotero-mcp-plugin.semantic.enabled";

/**
 * How the PDF body text was obtained, surfaced as `extractionMethod` so the
 * two text sources never get silently mixed up in a result.
 */
export type PDFTextMethod =
  /** Reused an existing Doc2X / MinerU Markdown, no parsing. */
  | "mineru_cache"
  /** Parsed on demand during this request. */
  | "mineru"
  /** No Markdown and MinerU is switched off. */
  | "mineru_disabled"
  /** No Markdown and on-demand parsing is not allowed by the preference. */
  | "mineru_on_demand_disabled"
  /** MinerU was asked to parse and explicitly failed (or refused). */
  | "mineru_failed"
  /** Unexpected error while talking to MinerU. */
  | "mineru_error";

export interface PDFTextSourceResult {
  /** Plain index text derived from Markdown, or null when unavailable. */
  text: string | null;
  method: PDFTextMethod;
}

/**
 * Parent items whose semantic index refresh is currently running, so two PDFs
 * of the same item parsed in one request do not queue two rebuilds.
 */
const pendingIndexRefresh = new Map<string, Promise<void>>();

/**
 * Resolve PDF body text through Doc2X / MinerU Markdown.
 *
 * 顺序（与 MinerUService.getMarkdownForAttachment 内部一致）：
 *   Doc2X 原文 Markdown → MinerU 缓存 → 已挂载的 .md → （按开关）现场解析
 *
 * 复用已有 Markdown 不受 blockingOnDemand 影响；只有「三者都没有」时才看开关。
 * 返回 null 时由调用方走各自现有的 PDF Worker / PDFProcessor 兜底。
 */
export async function getPDFTextFromMarkdown(
  attachment: any,
): Promise<PDFTextSourceResult> {
  if (!attachment?.key) {
    return { text: null, method: "mineru_error" };
  }

  try {
    const { getMinerUService, markdownToIndexText } = await import("./mineru");
    const minerUService = getMinerUService();

    // 1) 已有 Markdown 直接复用，绝不触发解析（allowParse:false）。
    //    ignoreEnabled:true 让「MinerU 开关关掉但缓存/附件还在」时依然能复用。
    const existing = await minerUService.getMarkdownForAttachment(attachment, {
      allowParse: false,
      ignoreEnabled: true,
    });
    if (existing) {
      const reused = markdownToIndexText(existing).trim();
      if (reused) {
        ztoolkit.log(
          `[PDFTextSource] Reusing existing Markdown for ${attachment.key} (${reused.length} chars)`,
        );
        return { text: reused, method: "mineru_cache" };
      }
    }

    // 2) 三种来源都没有：是否允许现场解析完全由设置决定。
    const config = minerUService.getConfig();
    if (!config.enabled) {
      ztoolkit.log(
        `[PDFTextSource] MinerU disabled; no Markdown for ${attachment.key}`,
      );
      return { text: null, method: "mineru_disabled" };
    }
    if (!config.blockingOnDemand) {
      ztoolkit.log(
        `[PDFTextSource] On-demand parsing disabled; no Markdown for ${attachment.key}`,
      );
      return { text: null, method: "mineru_on_demand_disabled" };
    }

    ztoolkit.log(
      `[PDFTextSource] No Markdown for ${attachment.key}, parsing on demand (blocking)`,
    );
    // allowParse:true 与 blockingOnDemand 此刻同值，显式传入是为了让意图可读；
    // 并发的同一附件由 MinerUService.inFlight 合并成一次解析。
    const markdown = await minerUService.getMarkdownForAttachment(attachment, {
      allowParse: true,
    });
    if (!markdown) {
      // 明确失败：含解析出错、失败冷却未过、体积超限、Doc2X 生成件等。
      return { text: null, method: "mineru_failed" };
    }

    // 3) 缓存写入与 .md 附件挂载已由 MinerUService.parseAndCache 内部完成。
    // 4) 新 Markdown 落盘后，强制增量刷新父条目向量（只此一条，不重建全库）。
    await refreshParentSemanticIndex(attachment);

    const text = markdownToIndexText(markdown).trim();
    if (!text) {
      ztoolkit.log(
        `[PDFTextSource] Markdown for ${attachment.key} produced empty text`,
        "warn",
      );
      return { text: null, method: "mineru_failed" };
    }
    return { text, method: "mineru" };
  } catch (error) {
    ztoolkit.log(
      `[PDFTextSource] Markdown resolution failed for ${attachment?.key}: ${error}`,
      "warn",
    );
    return { text: null, method: "mineru_error" };
  }
}

/**
 * Explicitly re-index the parent item of a freshly parsed PDF.
 *
 * 只更新这一条父文献，不触碰其他条目、更不重建向量库。之所以要显式调用：
 * notifier 会主动忽略 text/markdown 附件（防止索引回环），所以新挂上去的 .md
 * 不会自动触发索引；force=true 是必须的，否则 indexItem 的时间戳/内容缓存快
 * 路径会认为「没变化」而跳过，旧的 PDF Worker 向量就留在库里了。重新抽取时会
 * 再次命中刚写好的 MinerU 缓存，不会二次调用 MinerU。
 */
async function refreshParentSemanticIndex(attachment: any): Promise<void> {
  const parentItemID = attachment?.parentItemID;
  if (!parentItemID) return;

  try {
    const parent = await Zotero.Items.getAsync(parentItemID);
    if (!parent?.isRegularItem?.()) return;

    const refreshKey = `${parent.libraryID}:${parent.key}`;
    const running = pendingIndexRefresh.get(refreshKey);
    if (running) {
      ztoolkit.log(
        `[PDFTextSource] Index refresh already running for ${parent.key}, reusing it`,
      );
      await running;
      return;
    }

    if (Zotero.Prefs.get(SEMANTIC_ENABLED_PREF, true) === false) {
      ztoolkit.log(
        `[PDFTextSource] Semantic search disabled, skipping index update for ${parent.key}`,
      );
      return;
    }

    const { getSemanticSearchService } = await import("./semantic");
    const { enqueueIndexRefresh } = await import("./semantic/indexRefreshQueue");
    const semanticService = getSemanticSearchService();
    // 服务没就绪 / 正在全库构建时，绝不能丢掉这次刷新：新解析出来的正文如果
    // 不进索引，检索会一直用旧向量。入队交给持久化重试队列，稍后由同一个
    // 增量索引入口补跑。
    if (!(await semanticService.isReady())) {
      enqueueIndexRefresh(
        parent.libraryID,
        parent.key,
        "semantic-service-not-ready",
      );
      ztoolkit.log(
        `[PDFTextSource] Semantic service not ready; queued index refresh for ${parent.key}`,
        "warn",
      );
      return;
    }
    if (semanticService.isBuildActive?.()) {
      enqueueIndexRefresh(parent.libraryID, parent.key, "index-build-active");
      ztoolkit.log(
        `[PDFTextSource] Index build in progress; queued index refresh for ${parent.key}`,
      );
      return;
    }

    ztoolkit.log(
      `[PDFTextSource] Incremental vector index update for parent item ${parent.key}`,
    );
    const task = semanticService
      .indexItemWithProcessor(parent, null, true)
      .then((outcome) => {
        if (outcome.status === "incomplete") {
          throw new Error("Incremental index update was interrupted");
        }
      })
      .finally(() => {
        pendingIndexRefresh.delete(refreshKey);
      });
    pendingIndexRefresh.set(refreshKey, task);
    await task;
  } catch (error) {
    // 索引失败不影响本次内容请求的结果返回，但同样不能就此丢掉：排队重试。
    try {
      const parentItemID = attachment?.parentItemID;
      const parent = parentItemID
        ? await Zotero.Items.getAsync(parentItemID)
        : null;
      if (parent?.isRegularItem?.()) {
        const { enqueueIndexRefresh } = await import(
          "./semantic/indexRefreshQueue"
        );
        enqueueIndexRefresh(parent.libraryID, parent.key, "refresh-failed");
      }
    } catch (queueError) {
      ztoolkit.log(
        `[PDFTextSource] Could not queue index refresh: ${queueError}`,
        "warn",
      );
    }
    ztoolkit.log(
      `[PDFTextSource] Incremental index update failed for ${attachment?.key}: ${error}`,
      "warn",
    );
  }
}

/**
 * Detect the Markdown attachments generated by MinerU for a source PDF.
 * 它们和源 PDF 的正文完全重复，内容工具应当跳过，避免同一段文字返回两次。
 */
export function isGeneratedMarkdownAttachment(attachment: any): boolean {
  try {
    if (!attachment?.isAttachment?.()) return false;
    if (attachment.attachmentContentType !== "text/markdown") return false;
    const title = attachment.getField?.("title") || "";
    return title.startsWith(MARKDOWN_ATTACHMENT_PREFIX);
  } catch (error) {
    return false;
  }
}
