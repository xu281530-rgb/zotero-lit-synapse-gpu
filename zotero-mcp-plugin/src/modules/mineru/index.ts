/**
 * MinerU 高精度 PDF 解析模块
 *
 * 在把 PDF 文本送去向量化 / 交给 MCP 工具之前，先用 MinerU 做版面还原，
 * 拿到带标题层级、公式与表格的 Markdown，替代 Zotero 内置的裸文本提取。
 */

export {
  MinerUClient,
  MINERU_CLOUD_BASE_URL,
  MINERU_LOCAL_BASE_URL,
  defaultMinerUBaseURL,
  normalizeMinerUBaseURL,
  type MinerUMode,
  type MinerUClientConfig,
  type MinerUParseResult,
} from "./minerUClient";

export {
  MinerUService,
  getMinerUService,
  markdownToIndexText,
  getAttachmentLabel,
  isGeneratedMinerUMarkdownTitle,
  getOriginalPDFAttachmentsForItem,
  type MinerUServiceConfig,
  type GetMarkdownOptions,
  type MinerUProgressEvent,
  type MinerUProgressListener,
} from "./minerUService";
