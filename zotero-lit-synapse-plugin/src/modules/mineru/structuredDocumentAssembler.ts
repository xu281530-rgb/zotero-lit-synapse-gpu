export const ASSEMBLER_VERSION = 8;

export type MinerUStructuredFormat =
  | "content_list_v2"
  | "content_list"
  | "model";

/**
 * Where a resolved heading level came from.
 *
 * The first four are levels MinerU stated explicitly (or, for `model`, that
 * MinerU's own post-processing derives from the block type). The rest are
 * this assembler's reconstruction, used only once every JSON has been asked.
 */
export type HeadingLevelSource =
  | "content_list_v2"
  | "content_list"
  | "middle"
  | "model"
  | "doc-title"
  | "numbering"
  | "section-name"
  | "enumeration"
  | "fallback";

/** One JSON's opinion about a single heading's level. */
interface HeadingEvidenceEntry {
  level: number;
  origin: Extract<
    HeadingLevelSource,
    "content_list_v2" | "content_list" | "middle" | "model"
  >;
  /** True when MinerU stored no `level` and the value came from the block type. */
  derived: boolean;
}

/**
 * Every heading level MinerU stated anywhere in the result bundle, keyed both
 * with and without the page number so sources that disagree on pagination can
 * still be matched by normalized title text.
 */
export interface HeadingEvidenceIndex {
  byPage: Map<string, HeadingEvidenceEntry[]>;
  byText: Map<string, HeadingEvidenceEntry[]>;
}

export interface StructuredSource {
  format: MinerUStructuredFormat;
  fileName: string;
  data: any;
  rawJSON: string;
  structuredHash: string;
  parserVersion: string | null;
  /**
   * Heading levels harvested from *all* structured JSONs in the bundle, not
   * just the one chosen for body text. Body text still comes from a single
   * source; heading levels may be corroborated across sources.
   */
  headingEvidence?: HeadingEvidenceIndex;
}

export interface AssembledDocumentBlock {
  type: string;
  pageIndex: number;
  bbox: number[];
  markdown: string;
  /** Original flattened MinerU block order before paragraph/figure reordering. */
  sourceOrder: number;
  /** Markdown heading depth (1-6) for `title` blocks; absent otherwise. */
  headingLevel?: number;
  /** Which evidence decided `headingLevel`. */
  headingLevelSource?: HeadingLevelSource;
}

export interface AssembledDocument {
  markdown: string;
  blocks: AssembledDocumentBlock[];
  format: MinerUStructuredFormat;
  structuredHash: string;
  assemblerVersion: number;
}

export class StructuredDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredDocumentError";
  }
}

/**
 * A heading before its Markdown level is decided. `markdown` on the owning
 * block holds the bare title text at this stage; the `#` prefix is only added
 * once every source has been consulted.
 */
interface HeadingDraft {
  text: string;
  /** Level stated by the source that provided the body text, if any. */
  sourceLevel: number | null;
  sourceOrigin: HeadingLevelSource | null;
  /** True when `sourceLevel` was inferred from the block type, not stored. */
  sourceDerived: boolean;
}

interface NormalizedBlock extends AssembledDocumentBlock {
  mergePrev: boolean;
  ignoredFurniture: boolean;
  bridgeKind: BridgeKind;
  heading?: HeadingDraft;
}

type BridgeKind =
  | "furniture"
  | "visual-anchor"
  | "visual-detail"
  | "table-anchor"
  | "table-detail"
  | null;

interface EnglishToken {
  text: string;
  lower: string;
  start: number;
  end: number;
}

interface WordRepairEvidence {
  joinablePairs: Set<string>;
}

interface BridgeTarget {
  nextIndex: number;
  bridged: NormalizedBlock[];
}

const KNOWN_V2_TYPES = new Set([
  "algorithm",
  "chart",
  "equation_interline",
  "image",
  "list",
  "page_footer",
  "page_footnote",
  "page_header",
  "page_aside_text",
  "page_number",
  "paragraph",
  "table",
  "title",
]);

const FURNITURE_TYPES = new Set([
  "footer",
  "header",
  "page_footer",
  "page_header",
  "page_number",
]);

const VISUAL_ANCHOR_TYPES = new Set([
  "chart",
  "image",
  "image_block",
]);

const VISUAL_DETAIL_TYPES = new Set(["image_caption", "image_footnote"]);

const TABLE_ANCHOR_TYPES = new Set(["table"]);

const TABLE_DETAIL_TYPES = new Set(["table_caption", "table_footnote"]);

const MAX_INTERRUPTED_PARAGRAPH_LOOKAHEAD = 2;

const DEPENDENCY_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "because",
  "between",
  "by",
  "for",
  "from",
  "if",
  "in",
  "into",
  "of",
  "on",
  "or",
  "than",
  "that",
  "the",
  "through",
  "to",
  "under",
  "via",
  "when",
  "where",
  "which",
  "while",
  "with",
  "without",
]);

/**
 * MinerU 3.x never emits a heading level deeper than 2: pipeline and hybrid
 * both hard-map `doc_title -> 1` and `paragraph_title -> 2`, and the VLM
 * backend stores no level at all. Section depth therefore has to come from the
 * heading text, exactly as MinerU itself does for DOCX input
 * (`_correct_toc_level_by_text`). These are the recognizers for that.
 */

/** "1. Introduction", "2.3.1 Reward functions", "0 引言" */
const SECTION_NUMBER_PATTERN =
  /^(\d{1,3}(?:[.．·]\d{1,3})*)[.．、)）]?[^\S\r\n]+\S/u;
/** "A.1 Filter type", "B.2.1 ..." — appendix sub-sections. */
const APPENDIX_NUMBER_PATTERN =
  /^([A-Z](?:[.．]\d{1,3})+)[.．)）]?[^\S\r\n]+\S/u;
/** A section number is small; "2011 - ..." is a filename, not a section. */
const MAX_SECTION_NUMBER = 40;
/**
 * Leading debris MinerU sometimes glues onto a heading: an OCR'd inline
 * formula ("$^{D}$3.3 Analysis ...") or a patent paragraph code
 * ("[0104] 实施例1"). Stripped before the heading is classified.
 */
const HEADING_NOISE_PREFIX_PATTERN =
  /^(?:\$[^$]{0,24}\$|\[[0-9]{2,5}\]|【[0-9]{2,5}】)\s*/u;
/** "第 3 章", "三、", "（一）" — Chinese chapter markers, always top level. */
const CHINESE_CHAPTER_PATTERN =
  /^(?:第[\s]*[0-9一二三四五六七八九十百]+[\s]*[章节節篇部]|[一二三四五六七八九十]+[、.．][^\S\r\n]*\S)/u;
/** "Appendix B", "附录 A" — peers of a top-level chapter. */
const APPENDIX_PATTERN = /^(?:appendix|annex|附录|附錄)\s*[A-Za-z0-9一二三四五六七八九十]/iu;
/** "Step 2:", "(3)", "（iv）", "①", "1)", "• item" — enumerations in a section. */
const ENUMERATION_PATTERN =
  /^(?:[（(]\s*[0-9]{1,3}|[（(]\s*[ivxIVX]{1,5}\s*[)）]|[（(]\s*[a-zA-Z]\s*[)）]|[①-⑳]|[0-9]{1,3}\s*[)）]|[•·▪◦◆◇■□★]\s*\S|step\s*[0-9]+\s*[:：.]|阶段\s*[0-9一二三四五六七八九十]+|步骤\s*[0-9一二三四五六七八九十]+)/iu;
/** Front/back-matter markers that carry a leading INID or ordinal code. */
const LEADING_CODE_PATTERN = /^[（(]\s*[0-9]{1,3}\s*[)）]\s*/u;
/** "Fig. 1", "Table 2", "图 3" — captions misfiled as titles keep no depth. */
const CAPTION_PREFIX_PATTERN =
  /^(?:fig(?:ure)?|tab(?:le)?|scheme|eq(?:uation)?|图|圖|表|式)\s*\.?\s*[0-9]/iu;

/**
 * Unnumbered headings that are nonetheless top-level sections. Compared after
 * `headingMatchKey` normalization (case-folded, punctuation and spaces
 * removed), so "A R T I C L E I N F O" and "ARTICLEINFO" both match.
 */
const SECTION_NAME_KEYS = new Set(
  [
    // English front/back matter
    "abstract",
    "graphicalabstract",
    "highlights",
    "keywords",
    "keyword",
    "indexterms",
    "articleinfo",
    "articleinformation",
    "nomenclature",
    "abbreviations",
    "introduction",
    "background",
    "relatedwork",
    "methods",
    "methodology",
    "materialsandmethods",
    "experimental",
    "results",
    "resultsanddiscussion",
    "discussion",
    "conclusion",
    "conclusions",
    "conclusionsandoutlook",
    "summary",
    "outlook",
    "futurework",
    "acknowledgement",
    "acknowledgements",
    "acknowledgment",
    "acknowledgments",
    "references",
    "reference",
    "bibliography",
    "literaturecited",
    "appendix",
    "appendices",
    "supplementarymaterial",
    "supplementarymaterials",
    "supportinginformation",
    "dataavailability",
    "dataavailabilitystatement",
    "codeavailability",
    "authorstatement",
    "authorcontributions",
    "creditauthorshipcontributionstatement",
    "declarationofcompetinginterest",
    "declarationofcompetinginterests",
    "conflictofinterest",
    "conflictsofinterest",
    "competinginterests",
    "funding",
    "fundinginformation",
    "ethicsstatement",
    "ethicalapproval",
    "notes",
    "disclaimer",
    // Chinese journal sections
    "摘要",
    "关键词",
    "關鍵詞",
    "引言",
    "前言",
    "绪论",
    "緒論",
    "结论",
    "結論",
    "结语",
    "结束语",
    "致谢",
    "致謝",
    "参考文献",
    "參考文獻",
    "附录",
    "附錄",
    "目录",
    "符号说明",
    "利益冲突",
    "数据可用性",
    "作者贡献",
    "基金项目",
    "作者简介",
    // Chinese patent sections
    "技术领域",
    "技術領域",
    "背景技术",
    "背景技術",
    "发明内容",
    "發明內容",
    "发明目的",
    "实用新型内容",
    "附图说明",
    "附圖說明",
    "具体实施方式",
    "具體實施方式",
    "实施例",
    "实施方式",
    "权利要求书",
    "权利要求",
    "说明书摘要",
    "摘要附图",
    "发明名称",
    "发明人",
    "申请人",
  ].map((value) => headingMatchKey(value)),
);

/** Markdown level given to a depth-1 chapter, leaving `#` for the doc title. */
const CHAPTER_BASE_LEVEL = 2;

const MODEL_TITLE_TYPES = new Set(["doc_title", "paragraph_title", "title"]);
const MODEL_PARAGRAPH_TYPES = new Set([
  "ocr_text",
  "paragraph",
  "ref_text",
  "text",
]);

export function selectStructuredSource(
  files: Record<string, string>,
): StructuredSource {
  const entries = Object.entries(files || {}).filter(
    ([name, value]) => /\.json$/i.test(name) && typeof value === "string",
  );
  const parserVersion = findParserVersion(entries);
  const candidates: Array<{
    format: MinerUStructuredFormat;
    test: (name: string) => boolean;
  }> = [
    {
      format: "content_list_v2",
      test: (name) => /(?:^|[_/\\])content_list_v2\.json$/i.test(name),
    },
    {
      format: "content_list",
      test: (name) =>
        /(?:^|[_/\\])content_list\.json$/i.test(name) &&
        !/content_list_v2\.json$/i.test(name),
    },
    {
      format: "model",
      test: (name) => /(?:^|[_/\\])model\.json$/i.test(name),
    },
  ];

  for (const candidate of candidates) {
    const entry = entries.find(([name]) => candidate.test(name));
    if (!entry) continue;
    const [fileName, rawJSON] = entry;
    let data: any;
    try {
      data = JSON.parse(rawJSON);
    } catch (error) {
      throw new StructuredDocumentError(
        `${candidate.format} JSON is invalid (${fileName}): ${error}`,
      );
    }
    validateRoot(candidate.format, data, fileName);
    return {
      format: candidate.format,
      fileName,
      data,
      rawJSON,
      structuredHash: hashDocumentText(rawJSON),
      parserVersion,
      headingEvidence: collectHeadingEvidence(entries),
    };
  }

  throw new StructuredDocumentError(
    "MinerU returned no supported structured result (content_list_v2, content_list, or model)",
  );
}

export function assembleStructuredDocument(
  source: StructuredSource,
): AssembledDocument {
  // Heading levels are settled before anything else looks at the Markdown, so
  // every later stage still sees a fully rendered `## Heading` block and the
  // paragraph/figure/table behaviour is unchanged.
  const normalized = filterStandaloneVisualOcrNoise(
    renderResolvedHeadings(normalizeSource(source), source.headingEvidence),
  );
  const meaningful = normalized.filter(
    (block) => block.markdown.trim() && !block.ignoredFurniture,
  );
  if (!meaningful.length) {
    throw new StructuredDocumentError(
      `${source.format} contains no meaningful document text`,
    );
  }

  const wordEvidence = buildWordRepairEvidence(normalized);
  const repaired = repairHighConfidenceSplitWords(normalized, wordEvidence);
  const merged = mergeInterruptedParagraphs(repaired, wordEvidence);
  const blocks = merged
    .filter(
      (block) =>
        !block.ignoredFurniture &&
        (Boolean(block.markdown.trim()) || isLayoutAnchor(block)),
    )
    .map(
      ({
        type,
        pageIndex,
        bbox,
        markdown,
        sourceOrder,
        headingLevel,
        headingLevelSource,
      }) => ({
        type,
        pageIndex,
        bbox,
        markdown,
        sourceOrder,
        ...(headingLevel ? { headingLevel, headingLevelSource } : {}),
      }),
    );
  const markdown = cleanDocument(blocks.map((block) => block.markdown).join("\n\n"));
  if (!markdown) {
    throw new StructuredDocumentError(
      `${source.format} produced empty Markdown`,
    );
  }
  return {
    markdown,
    blocks,
    format: source.format,
    structuredHash: source.structuredHash,
    assemblerVersion: ASSEMBLER_VERSION,
  };
}

function validateRoot(
  format: MinerUStructuredFormat,
  data: any,
  fileName: string,
): void {
  if (!Array.isArray(data) || data.length === 0) {
    throw new StructuredDocumentError(
      `${format} has an unsupported or empty root (${fileName})`,
    );
  }
  if (format === "content_list" && !data.some((item) => isObject(item))) {
    throw new StructuredDocumentError(
      `content_list contains no blocks (${fileName})`,
    );
  }
  if (
    (format === "content_list_v2" || format === "model") &&
    !data.every((page) => Array.isArray(page))
  ) {
    throw new StructuredDocumentError(
      `${format} must be an array of page arrays (${fileName})`,
    );
  }
}

function normalizeSource(source: StructuredSource): NormalizedBlock[] {
  let blocks: NormalizedBlock[];
  if (source.format === "content_list_v2") {
    blocks = source.data.flatMap((page: any[], pageIndex: number) =>
      page.map((item) => normalizeV2Block(item, pageIndex)),
    );
  } else if (source.format === "content_list") {
    blocks = source.data.map((item: any, index: number) =>
      normalizeLegacyBlock(item, index),
    );
  } else {
    blocks = source.data.flatMap((page: any[], pageIndex: number) =>
      page.map((item) => normalizeModelBlock(item, pageIndex)),
    );
  }
  return blocks.map((block, sourceOrder) => ({ ...block, sourceOrder }));
}

function normalizeV2Block(item: any, pageIndex: number): NormalizedBlock {
  if (!isObject(item)) {
    throw new StructuredDocumentError(
      `content_list_v2 page ${pageIndex + 1} contains a non-object block`,
    );
  }
  const type = String(item.type || item.sub_type || "").toLowerCase();
  if (!KNOWN_V2_TYPES.has(type)) {
    if (hasMeaningfulText(item)) {
      throw new StructuredDocumentError(
        `content_list_v2 contains unsupported text block type: ${type || "(missing)"}`,
      );
    }
    return makeBlock(type || "unknown", pageIndex, item, "");
  }
  const content = isObject(item.content) ? item.content : {};
  let markdown = "";
  let heading: HeadingDraft | undefined;
  switch (type) {
    case "title": {
      const text = spansToMarkdown(content.title_content ?? content.content);
      const stated = readStatedLevel(content.level ?? item.level);
      heading = {
        text,
        sourceLevel: stated,
        sourceOrigin: stated === null ? null : "content_list_v2",
        sourceDerived: false,
      };
      markdown = text;
      break;
    }
    case "paragraph":
      markdown = spansToMarkdown(
        content.paragraph_content ?? content.content ?? item.text,
      );
      break;
    case "list":
      markdown = renderList(content);
      break;
    case "equation_interline":
      markdown = renderDisplayEquation(
        content.math_content ?? content.latex ?? content.content,
      );
      break;
    case "table":
      markdown = renderMediaBlock(content, "table");
      break;
    case "image":
    case "chart":
      markdown = renderMediaBlock(content, type);
      break;
    case "algorithm":
      markdown = joinNonEmpty([
        spansToMarkdown(content.algorithm_caption),
        spansToMarkdown(content.algorithm_content ?? content.content),
        spansToMarkdown(content.algorithm_footnote),
      ]);
      break;
    case "page_footnote":
      markdown = spansToMarkdown(
        content.page_footnote_content ?? content.content,
      );
      break;
    case "page_aside_text":
      markdown = spansToMarkdown(
        content.page_aside_text_content ?? content.content,
      );
      break;
    case "page_header":
    case "page_footer":
    case "page_number":
      markdown = spansToMarkdown(content);
      break;
  }
  return makeBlock(type, pageIndex, item, markdown, heading);
}

function normalizeLegacyBlock(item: any, index: number): NormalizedBlock {
  if (!isObject(item)) {
    throw new StructuredDocumentError(
      `content_list block ${index + 1} is not an object`,
    );
  }
  const rawType = String(item.type || item.sub_type || "text").toLowerCase();
  const pageIndex = Number.isInteger(item.page_idx) ? item.page_idx : 0;
  let type = rawType;
  let markdown = "";
  let heading: HeadingDraft | undefined;
  const legacyTextLevel = Number(item.text_level);
  const hasLegacyHeadingLevel =
    ["text", "paragraph", "ref_text", "ocr_text"].includes(rawType) &&
    Number.isInteger(legacyTextLevel) &&
    legacyTextLevel >= 1 &&
    legacyTextLevel <= 6;
  if (
    ["title", "heading", "doc_title", "paragraph_title"].includes(rawType) ||
    hasLegacyHeadingLevel
  ) {
    type = "title";
    const text = spansToMarkdown(item.text ?? item.content);
    const stated = readStatedLevel(item.text_level ?? item.level);
    // content_list has no `level`; a bare `doc_title`/`paragraph_title` type
    // still tells us what MinerU's own post-processing would have stored.
    const derived = stated === null ? levelFromTitleType(rawType) : null;
    heading = {
      text,
      sourceLevel: stated ?? derived,
      sourceOrigin:
        stated === null && derived === null ? null : "content_list",
      sourceDerived: stated === null && derived !== null,
    };
    markdown = text;
  } else if (["text", "paragraph", "ref_text", "ocr_text"].includes(rawType)) {
    type = "paragraph";
    markdown = spansToMarkdown(item.text ?? item.content);
  } else if (rawType.includes("equation") || rawType === "formula") {
    type = "equation_interline";
    markdown = renderDisplayEquation(
      item.text ?? item.latex ?? item.content?.math_content ?? item.content,
    );
  } else if (rawType === "list") {
    markdown = renderList(isObject(item.content) ? item.content : item);
  } else if (["image", "chart", "table"].includes(rawType)) {
    markdown = renderMediaBlock(item, rawType);
  } else if (rawType === "page_footnote" || rawType === "footnote") {
    type = "page_footnote";
    markdown = spansToMarkdown(item.text ?? item.content);
  } else if (FURNITURE_TYPES.has(rawType)) {
    markdown = spansToMarkdown(item.text ?? item.content);
  } else if (hasMeaningfulText(item)) {
    throw new StructuredDocumentError(
      `content_list contains unsupported text block type: ${rawType}`,
    );
  }
  return makeBlock(type, pageIndex, item, markdown, heading);
}

function normalizeModelBlock(item: any, pageIndex: number): NormalizedBlock {
  if (!isObject(item)) {
    throw new StructuredDocumentError(
      `model page ${pageIndex + 1} contains a non-object block`,
    );
  }
  const rawType = String(item.type || item.sub_type || "").toLowerCase();
  let type = rawType;
  let markdown = "";
  let heading: HeadingDraft | undefined;
  if (MODEL_TITLE_TYPES.has(rawType)) {
    type = "title";
    const text = spansToMarkdown(item.content ?? item.text);
    const stated = readStatedLevel(item.level);
    // model.json stores no level. `doc_title`/`paragraph_title` are the same
    // two classes MinerU maps to 1 and 2, so treat the type as derived
    // evidence rather than a stated level.
    const derived = stated === null ? levelFromTitleType(rawType) : null;
    heading = {
      text,
      sourceLevel: stated ?? derived,
      sourceOrigin: stated === null && derived === null ? null : "model",
      sourceDerived: stated === null && derived !== null,
    };
    markdown = text;
  } else if (MODEL_PARAGRAPH_TYPES.has(rawType)) {
    type = "paragraph";
    markdown = spansToMarkdown(item.content ?? item.text);
  } else if (["equation", "formula", "equation_interline"].includes(rawType)) {
    type = "equation_interline";
    markdown = renderDisplayEquation(item.content ?? item.text);
  } else if (["image", "image_block", "image_caption", "image_footnote", "chart", "table", "table_caption", "table_footnote"].includes(rawType)) {
    type = rawType;
    if (["image", "chart", "table"].includes(rawType)) {
      markdown = renderMediaBlock(item, rawType);
    } else {
      markdown = spansToMarkdown(item.content ?? item.text);
    }
  } else if (["page_footnote", "footnote"].includes(rawType)) {
    type = "page_footnote";
    markdown = spansToMarkdown(item.content ?? item.text);
  } else if (FURNITURE_TYPES.has(rawType)) {
    markdown = spansToMarkdown(item.content ?? item.text);
  } else if (rawType === "list") {
    markdown = renderList(isObject(item.content) ? item.content : item);
  } else if (rawType === "algorithm" || rawType === "aside_text") {
    markdown = spansToMarkdown(item.content ?? item.text);
  } else if (["inline_formula", "equation_inline"].includes(rawType)) {
    type = "paragraph";
    markdown = inlineEquation(item.content ?? item.text);
  } else if (hasMeaningfulText(item)) {
    throw new StructuredDocumentError(
      `model contains unsupported text block type: ${rawType || "(missing)"}`,
    );
  }
  return makeBlock(type, pageIndex, item, markdown, heading);
}

function makeBlock(
  type: string,
  pageIndex: number,
  item: any,
  markdown: string,
  heading?: HeadingDraft,
): NormalizedBlock {
  const pageFootnote = type === "page_footnote";
  const cleaned = pageFootnote ? "" : cleanBlock(markdown);
  return {
    type,
    pageIndex,
    bbox: normalizeBBox(item?.bbox),
    markdown: cleaned,
    ...(heading ? { heading: { ...heading, text: cleaned } } : {}),
    sourceOrder: -1,
    mergePrev: item?.merge_prev === true || item?.content?.merge_prev === true,
    ignoredFurniture: FURNITURE_TYPES.has(type) || pageFootnote,
    bridgeKind: pageFootnote
      ? null
      : FURNITURE_TYPES.has(type)
        ? "furniture"
      : VISUAL_ANCHOR_TYPES.has(type)
        ? "visual-anchor"
        : VISUAL_DETAIL_TYPES.has(type)
          ? "visual-detail"
          : TABLE_ANCHOR_TYPES.has(type)
            ? "table-anchor"
            : TABLE_DETAIL_TYPES.has(type)
              ? "table-detail"
          : null,
  };
}

function renderList(content: any): string {
  const items = Array.isArray(content?.list_items)
    ? content.list_items
    : Array.isArray(content?.items)
      ? content.items
      : [];
  if (!items.length) return spansToMarkdown(content?.content ?? content?.text);
  const ordered = /order|number/i.test(String(content.list_type || ""));
  return items
    .map((item: any, index: number) => {
      const text = spansToMarkdown(
        item?.item_content ?? item?.content ?? item?.text ?? item,
      );
      return text ? `${ordered ? `${index + 1}.` : "-"} ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function renderMediaBlock(content: any, kind: string): string {
  const source = isObject(content?.content) ? content.content : content;
  const prefix = kind === "chart" ? "chart" : kind;
  const captions =
    source?.[`${prefix}_caption`] ??
    source?.image_caption ??
    source?.table_caption ??
    source?.caption;
  const footnotes =
    source?.[`${prefix}_footnote`] ??
    source?.image_footnote ??
    source?.table_footnote ??
    source?.footnote;
  const bodyText = spansToMarkdown(
    source?.text ??
      (typeof source?.content === "string" ? source.content : ""),
  );
  let table = "";
  if (kind === "table") {
    const html =
      source?.html ??
      source?.table_body ??
      source?.table_content ??
      (typeof source?.content === "string" && /<table\b/i.test(source.content)
        ? source.content
        : undefined);
    if (typeof html === "string" && html.trim()) {
      table = renderTableHTML(html);
    } else if (typeof bodyText === "string") {
      table = bodyText;
    }
  }
  return joinNonEmpty([
    captionToMarkdown(captions, kind === "image" || kind === "chart"),
    kind === "table" ? table : bodyText,
    spansToMarkdown(footnotes),
  ]);
}

function captionToMarkdown(value: any, filterVisualOcr = false): string {
  if (!Array.isArray(value)) {
    const text = stripPanelLabelBeforeFormalCaption(spansToMarkdown(value));
    return filterVisualOcr && isShortVisualOcrText(text) ? "" : text;
  }
  const entries = value.map((entry) => spansToMarkdown(entry));
  const formalCaptionIndex = filterVisualOcr
    ? entries.findIndex(isFormalFigureCaption)
    : -1;
  const stringEntries = value.every(
    (entry) => typeof entry === "string" || typeof entry === "number",
  );
  return entries.reduce((result: string, entry: string, index: number) => {
    let next = stripPanelLabelBeforeFormalCaption(entry);
    if (
      filterVisualOcr &&
      index < formalCaptionIndex &&
      isShortVisualOcrText(next)
    ) {
      next = "";
    } else if (
      filterVisualOcr &&
      formalCaptionIndex < 0 &&
      isShortVisualOcrText(next)
    ) {
      next = "";
    }
    if (!next) return result;
    if (!result) return next;
    const separator = stringEntries
      ? captionFragmentSeparator(result, next)
      : (/[.!?。！？]$/u.test(result) && startsWithWordCharacter(next)) ||
          (/\d$/u.test(result) && /^[A-Za-z]/u.test(next))
        ? " "
        : "";
    // Captions render each span on its own, so back-to-back inline formulas
    // meet here rather than in spansToMarkdown and still need the gap that
    // keeps their delimiters from merging into `$$`.
    const gap =
      separator || (needsInlineFormulaGap(result, next) ? " " : "");
    return `${result}${gap}${next}`;
  }, "");
}

function captionFragmentSeparator(previous: string, next: string): string {
  if (
    /\s$/u.test(previous) ||
    /^\s/u.test(next) ||
    /[([{]$/u.test(previous) ||
    /^[,.;:!?)}\]]/u.test(next)
  ) {
    return "";
  }
  return " ";
}

function isFormalFigureCaption(value: string): boolean {
  return /^\s*(?:fig(?:ure)?[.\uFF0E]?|图)\s*[A-Za-z]?\d+/iu.test(value);
}

function stripPanelLabelBeforeFormalCaption(value: string): string {
  return value.replace(
    /^\s*(?:[（(]\s*[A-Za-z0-9]+\s*[)）]\s*)+(?=(?:fig(?:ure)?[.\uFF0E]?|图)\s*[A-Za-z]?\d+)/iu,
    "",
  );
}

function isShortVisualOcrText(value: string): boolean {
  const text = cleanBlock(value);
  if (!text || isFormalFigureCaption(text)) return false;
  if (/^[（(]\s*[A-Za-z0-9]+\s*[)）]\.?$/u.test(text)) return true;
  if (/[.!?。！？]\s*$/u.test(text)) return false;
  const asciiWordCount = (
    text.match(/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*/g) || []
  ).length;
  const hanCount = (text.match(/[\u3400-\u9fff]/gu) || []).length;
  if (hanCount > 0) return hanCount <= 10 && asciiWordCount <= 5;
  return asciiWordCount >= 1 && asciiWordCount <= 5;
}

function filterStandaloneVisualOcrNoise(
  blocks: NormalizedBlock[],
): NormalizedBlock[] {
  const visualAnchors = blocks.filter(
    (block) => block.bridgeKind === "visual-anchor" && hasFiniteBBox(block),
  );
  return blocks.map((block) => {
    if (!block.markdown || !isShortVisualOcrText(block.markdown)) return block;
    const typedVisualDetail = block.bridgeKind === "visual-detail";
    const overlappingVisual =
      block.type === "paragraph" &&
      hasFiniteBBox(block) &&
      visualAnchors.some(
        (visual) =>
          visual.pageIndex === block.pageIndex &&
          isSmallTextInsideVisualRegion(block, visual),
      );
    if (!typedVisualDetail && !overlappingVisual) return block;
    return {
      ...block,
      markdown: "",
      ignoredFurniture: true,
      bridgeKind: "visual-detail",
    };
  });
}

function isSmallTextInsideVisualRegion(
  textBlock: NormalizedBlock,
  visual: NormalizedBlock,
): boolean {
  const [textLeft, textTop, textRight, textBottom] = textBlock.bbox;
  const [visualLeft, visualTop, visualRight, visualBottom] = visual.bbox;
  const textWidth = Math.max(0, textRight - textLeft);
  const textHeight = Math.max(0, textBottom - textTop);
  const visualWidth = Math.max(0, visualRight - visualLeft);
  const visualHeight = Math.max(0, visualBottom - visualTop);
  const textArea = textWidth * textHeight;
  const visualArea = visualWidth * visualHeight;
  if (!textArea || !visualArea || textArea > visualArea * 0.2) return false;

  const overlapWidth = Math.max(
    0,
    Math.min(textRight, visualRight) - Math.max(textLeft, visualLeft),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(textBottom, visualBottom) - Math.max(textTop, visualTop),
  );
  if ((overlapWidth * overlapHeight) / textArea >= 0.8) return true;

  const pageExtent = pageExtentFor([textBlock, visual]);
  if (!pageExtent || overlapWidth / textWidth < 0.5) return false;
  const textCenterX = (textLeft + textRight) / 2;
  const isPanelLabel = /^[（(]\s*[A-Za-z0-9]+\s*[)）]\.?$/u.test(
    textBlock.markdown.trim(),
  );
  const boundaryTolerance = pageExtent * (isPanelLabel ? 0.01 : 0.005);
  if (
    textCenterX < visualLeft - boundaryTolerance ||
    textCenterX > visualRight + boundaryTolerance
  ) {
    return false;
  }
  const verticalBoundaryGap = Math.min(
    Math.abs(textTop - visualTop),
    Math.abs(textTop - visualBottom),
    Math.abs(textBottom - visualTop),
    Math.abs(textBottom - visualBottom),
  );
  return verticalBoundaryGap <= boundaryTolerance;
}

function renderTableHTML(html: string): string {
  const sanitized = sanitizeTableHTML(html);
  if (!sanitized) return "";
  if (/\b(?:rowspan|colspan)\s*=/i.test(sanitized) || /<table[\s>][\s\S]*<table[\s>]/i.test(sanitized)) {
    return sanitized;
  }
  const rowMatches = [...sanitized.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const rows = rowMatches
    .map((row) =>
      [...row[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map(
        (cell) =>
          decodeHTMLEntities(stripTags(cell[1]))
            .replace(/\s+/g, " ")
            .trim()
            .replace(/\|/g, "\\|"),
      ),
    )
    .filter((row) => row.length);
  if (!rows.length) return decodeHTMLEntities(stripTags(sanitized)).trim();
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) =>
    row.concat(Array(Math.max(0, width - row.length)).fill("")),
  );
  const header = normalized[0];
  return [header, Array(width).fill("---"), ...normalized.slice(1)]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

function sanitizeTableHTML(html: string): string {
  const withoutUnsafe = String(html)
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<(?:script|style|img|svg|iframe)\b[^>]*>[\s\S]*?<\/(?:script|style|svg|iframe)>/gi, "")
    .replace(/<(?:img|br)\b[^>]*\/?>/gi, (tag) =>
      /^<br/i.test(tag) ? "<br>" : "",
    );
  const allowed = new Set([
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "sup",
    "sub",
    "strong",
    "em",
    "br",
  ]);
  return withoutUnsafe
    .replace(/<\/?([a-z0-9]+)\b([^>]*)>/gi, (tag, rawName, rawAttrs) => {
      const name = String(rawName).toLowerCase();
      if (!allowed.has(name)) return "";
      if (tag.startsWith("</")) return `</${name}>`;
      const spans = [...String(rawAttrs).matchAll(/\b(rowspan|colspan)\s*=\s*["']?(\d+)["']?/gi)]
        .map((match) => `${match[1].toLowerCase()}="${match[2]}"`)
        .join(" ");
      return `<${name}${spans ? ` ${spans}` : ""}>`;
    })
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function spansToMarkdown(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") {
    return stripImageReferences(String(value));
  }
  if (Array.isArray(value)) {
    let result = "";
    let previousWasInlineEquation = false;
    for (const entry of value) {
      const next = spansToMarkdown(entry);
      if (!next) continue;
      const nextIsInlineEquation = isInlineEquationSpan(entry);
      if (
        (nextIsInlineEquation && endsWithWordCharacter(result)) ||
        (previousWasInlineEquation && startsWithWordCharacter(next))
      ) {
        result += " ";
      } else if (needsInlineFormulaGap(result, next)) {
        result += " ";
      }
      result += next;
      previousWasInlineEquation = nextIsInlineEquation;
    }
    return result;
  }
  if (!isObject(value)) return "";
  const type = String(
    value.type || value.sub_type || value.content_type || value.format || "",
  ).toLowerCase();
  if (type.includes("equation_inline") || type === "inline_formula") {
    return inlineEquation(value.content ?? value.text ?? value.latex);
  }
  if (type === "equation" && !Array.isArray(value.content)) {
    return inlineEquation(value.content ?? value.text ?? value.latex);
  }
  const preferredKeys = [
    "content",
    "text",
    "item_content",
    "paragraph_content",
    "title_content",
    "math_content",
  ];
  for (const key of preferredKeys) {
    if (value[key] !== undefined && value[key] !== value) {
      return spansToMarkdown(value[key]);
    }
  }
  return "";
}

/**
 * True when joining `next` straight onto `previous` would put two `$`
 * delimiters side by side.
 *
 * MinerU regularly emits a formula as two adjacent `equation_inline` spans, or
 * places a `<sup>` right after one. Concatenated, their delimiters merge into
 * `$$`, which Markdown reads as a display-math fence — and because
 * `findInlineFormulaEnd` skips a `$` that neighbours another `$`, the two
 * formulas are then swallowed into one malformed span. A single space is the
 * minimum that keeps both formulas intact; no other spacing is introduced, so
 * CJK text stays flush against its formulas.
 */
function needsInlineFormulaGap(previous: string, next: string): boolean {
  return previous.endsWith("$") && next.startsWith("$");
}

function isInlineEquationSpan(value: any): boolean {
  if (!isObject(value)) return false;
  const type = String(
    value.type || value.sub_type || value.content_type || value.format || "",
  ).toLowerCase();
  return (
    type.includes("equation_inline") ||
    type === "inline_formula" ||
    (type === "equation" && !Array.isArray(value.content))
  );
}

function isWordCharacter(value: string): boolean {
  return /^[A-Za-z0-9]$/u.test(value);
}

function startsWithWordCharacter(value: string): boolean {
  return Boolean(value && isWordCharacter(value[0]));
}

function endsWithWordCharacter(value: string): boolean {
  return Boolean(value && isWordCharacter(value[value.length - 1]));
}

function inlineEquation(value: any): string {
  const text = String(value ?? "")
    .trim()
    .replace(/^\$+|\$+$/g, "")
    .trim();
  if (!text) return "";
  return `$${text}$`;
}

function renderDisplayEquation(value: any): string {
  const text = spansToMarkdown(value)
    .trim()
    .replace(/^\$+|\$+$/g, "")
    .trim();
  return text ? `$$${text}$$` : "";
}

function maskProtectedText(value: string): string {
  const mask = (match: string) => match.replace(/[^\r\n]/g, " ");
  return [
    /`[^`\n]*`/g,
    /\$[^$\n]*\$/g,
    /https?:\/\/[^\s<>)]*/gi,
    /\[[^\]\n]*\]\([^)\n]*\)/g,
    /<[^>\n]+>/g,
  ].reduce((text, pattern) => text.replace(pattern, mask), value);
}

function englishTokens(value: string): EnglishToken[] {
  const masked = maskProtectedText(value);
  return [...masked.matchAll(/[A-Za-z]+/g)].map((match) => {
    const start = match.index ?? 0;
    const text = value.slice(start, start + match[0].length);
    return {
      text,
      lower: text.toLowerCase(),
      start,
      end: start + text.length,
    };
  });
}

function wordPairKey(left: string, right: string): string {
  return `${left.toLowerCase()}\u0000${right.toLowerCase()}`;
}

function adjacentWordPairs(
  value: string,
): Array<{ left: EnglishToken; right: EnglishToken }> {
  const tokens = englishTokens(value);
  const pairs: Array<{ left: EnglishToken; right: EnglishToken }> = [];
  for (let index = 0; index + 1 < tokens.length; index++) {
    const left = tokens[index];
    const right = tokens[index + 1];
    if (value.slice(left.end, right.start) === " ") {
      pairs.push({ left, right });
    }
  }
  return pairs;
}

function boundaryWordPair(
  previous: string,
  next: string,
): { left: EnglishToken; right: EnglishToken; key: string } | null {
  const previousTokens = englishTokens(previous);
  const nextTokens = englishTokens(next);
  const left = previousTokens[previousTokens.length - 1];
  const right = nextTokens[0];
  if (!left || !right) return null;
  if (previous.slice(left.end).trim() || next.slice(0, right.start).trim()) {
    return null;
  }
  return { left, right, key: wordPairKey(left.lower, right.lower) };
}

function buildWordRepairEvidence(
  blocks: NormalizedBlock[],
): WordRepairEvidence {
  const tokenCounts = new Map<string, number>();
  const pairCounts = new Map<
    string,
    { left: string; right: string; count: number }
  >();
  const recordPair = (left: EnglishToken, right: EnglishToken) => {
    const key = wordPairKey(left.lower, right.lower);
    const existing = pairCounts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      pairCounts.set(key, { left: left.lower, right: right.lower, count: 1 });
    }
  };

  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.markdown) continue;
    for (const token of englishTokens(block.markdown)) {
      tokenCounts.set(token.lower, (tokenCounts.get(token.lower) ?? 0) + 1);
    }
    for (const pair of adjacentWordPairs(block.markdown)) {
      recordPair(pair.left, pair.right);
    }
  }

  for (let index = 0; index < blocks.length; index++) {
    const current = blocks[index];
    if (current.type !== "paragraph" || !current.markdown) continue;
    const target = findBridgeTarget(blocks, index);
    const next = blocks[target.nextIndex];
    if (next?.type !== "paragraph" || !next.markdown) continue;
    const pair = boundaryWordPair(current.markdown, next.markdown);
    if (pair) recordPair(pair.left, pair.right);
  }

  const joinablePairs = new Set<string>();
  for (const [key, pair] of pairCounts) {
    if (pair.left.length < 2 || pair.right.length < 2) continue;
    const joined = `${pair.left}${pair.right}`;
    if (joined.length < 6 || joined.length > 40) continue;
    const intactCount = tokenCounts.get(joined) ?? 0;
    if (intactCount <= pair.count) continue;
    const leftCount = tokenCounts.get(pair.left) ?? 0;
    const rightCount = tokenCounts.get(pair.right) ?? 0;
    const hasRareLongFragment =
      (pair.left.length >= 5 && leftCount === pair.count) ||
      (pair.right.length >= 5 && rightCount === pair.count);
    if (hasRareLongFragment) joinablePairs.add(key);
  }
  return { joinablePairs };
}

function repairHighConfidenceSplitWords(
  blocks: NormalizedBlock[],
  evidence: WordRepairEvidence,
): NormalizedBlock[] {
  if (!evidence.joinablePairs.size) return blocks;
  return blocks.map((block) => {
    if (block.type !== "paragraph" || !block.markdown) return block;
    const spacesToRemove = adjacentWordPairs(block.markdown)
      .filter(({ left, right }) =>
        evidence.joinablePairs.has(wordPairKey(left.lower, right.lower)),
      )
      .map(({ left }) => left.end);
    if (!spacesToRemove.length) return block;
    let markdown = block.markdown;
    for (const index of [...new Set(spacesToRemove)].sort((a, b) => b - a)) {
      markdown = `${markdown.slice(0, index)}${markdown.slice(index + 1)}`;
    }
    return { ...block, markdown };
  });
}

function findBridgeTarget(
  blocks: NormalizedBlock[],
  index: number,
): BridgeTarget {
  let nextIndex = index + 1;
  const bridged: NormalizedBlock[] = [];
  const sourcePage = blocks[index]?.pageIndex ?? 0;

  while (nextIndex < blocks.length) {
    const candidate = blocks[nextIndex];
    if (
      candidate.pageIndex < sourcePage ||
      candidate.pageIndex > sourcePage + 1
    ) {
      break;
    }
    if (candidate.type === "paragraph" && !candidate.markdown.trim()) {
      bridged.push(candidate);
      nextIndex += 1;
      continue;
    }
    if (candidate.bridgeKind === null) break;
    bridged.push(candidate);
    nextIndex += 1;
  }
  return { nextIndex, bridged };
}

function isVisualBridge(block: NormalizedBlock): boolean {
  return (
    block.bridgeKind === "visual-anchor" ||
    block.bridgeKind === "visual-detail"
  );
}

function isTableBridge(block: NormalizedBlock): boolean {
  return (
    block.bridgeKind === "table-anchor" ||
    block.bridgeKind === "table-detail"
  );
}

function isLayoutBridge(block: NormalizedBlock): boolean {
  return isVisualBridge(block) || isTableBridge(block);
}

function isLayoutAnchor(block: NormalizedBlock): boolean {
  return (
    block.bridgeKind === "visual-anchor" ||
    block.bridgeKind === "table-anchor"
  );
}

function mergeInterruptedParagraphs(
  blocks: NormalizedBlock[],
  evidence: WordRepairEvidence,
): NormalizedBlock[] {
  const output: NormalizedBlock[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const current = blocks[index];
    if (current.type !== "paragraph" || !current.markdown) {
      output.push(current);
      continue;
    }

    let merged = current;
    let previousSource = current;
    let cursor = index;
    let mergeCount = 0;
    let followsInterruptedLayout = false;
    const relocated: NormalizedBlock[] = [];

    while (mergeCount < MAX_INTERRUPTED_PARAGRAPH_LOOKAHEAD) {
      const { nextIndex, bridged } = findBridgeTarget(blocks, cursor);
      const next = blocks[nextIndex];
      if (
        next?.type !== "paragraph" ||
        next.pageIndex > current.pageIndex + 1 ||
        !shouldMergeParagraphs(previousSource, next, bridged, evidence)
      ) {
        break;
      }
      const hasLayoutBridge = bridged.some(isLayoutBridge);
      if (mergeCount === 0) {
        followsInterruptedLayout = hasLayoutBridge;
      } else if (!followsInterruptedLayout) {
        break;
      }
      const separator = paragraphJoinSeparator(
        previousSource.markdown,
        next.markdown,
        evidence,
      );
      merged = {
        ...merged,
        markdown: cleanBlock(`${merged.markdown}${separator}${next.markdown}`),
      };
      relocated.push(...bridged);
      previousSource = next;
      cursor = nextIndex;
      mergeCount += 1;
      if (!followsInterruptedLayout) break;
    }

    if (mergeCount > 0) {
      output.push(merged, ...relocated);
      index = cursor;
      continue;
    }
    output.push(current);
  }
  return output;
}

function paragraphJoinSeparator(
  previous: string,
  next: string,
  evidence: WordRepairEvidence,
): string {
  return boundaryWordPairJoins(previous, next, evidence) ||
    (/-$/u.test(previous) && /^[a-z]/u.test(next))
    ? ""
    : " ";
}

function shouldMergeParagraphs(
  previous: NormalizedBlock,
  next: NormalizedBlock,
  bridged: NormalizedBlock[],
  evidence: WordRepairEvidence,
): boolean {
  if (next.pageIndex < previous.pageIndex || next.pageIndex > previous.pageIndex + 1) {
    return false;
  }
  const hasVisualBridge = bridged.some(isVisualBridge);
  const hasTableBridge = bridged.some(isTableBridge);
  const hasLayoutBridge = hasVisualBridge || hasTableBridge;
  const isColumnContinuation =
    next.pageIndex === previous.pageIndex &&
    isLikelySamePageColumnContinuation(previous, next);
  if (
    next.pageIndex === previous.pageIndex + 1 &&
    !isLikelyPageBoundary(previous, next, bridged)
  ) {
    return false;
  }
  if (
    next.pageIndex === previous.pageIndex &&
    hasLayoutBridge &&
    !isLikelySamePageVisualBridge(previous, next, bridged)
  ) {
    return false;
  }
  const previousText = previous.markdown.trim();
  const nextText = next.markdown.trim();
  if (!previousText || !nextText) {
    return false;
  }
  if (next.mergePrev) return true;
  // Citations following an author abbreviation are a common MinerU split:
  // "Yamasaki et al." + "[69, 70] proposed ...".  The citation token is a
  // stronger continuation signal than the abbreviation's period is a stop.
  if (/^\[[0-9]/u.test(nextText)) return true;
  if (boundaryWordPairJoins(previousText, nextText, evidence)) return true;
  if (
    hasTableBridge &&
    /;\s*$/u.test(previousText) &&
    /^[a-z]/u.test(nextText)
  ) {
    return true;
  }
  if (/[.!?。！？；;:]\s*$/u.test(previousText)) return false;
  const startsWithTextContinuation = /^(?:[a-z]|\[[0-9]|\([0-9]|[,.;:)}\]])/u.test(
    nextText,
  );
  const startsWithColumnContinuation =
    isColumnContinuation && /^(?:[0-9][\p{L}]?|[\p{Script=Greek}])/u.test(nextText);
  if (!startsWithTextContinuation && !startsWithColumnContinuation) {
    return false;
  }
  if (hasLayoutBridge || isColumnContinuation) {
    return endsWithDependencyWord(previousText);
  }
  return true;
}

function boundaryWordPairJoins(
  previous: string,
  next: string,
  evidence: WordRepairEvidence,
): boolean {
  const pair = boundaryWordPair(previous, next);
  return Boolean(pair && evidence.joinablePairs.has(pair.key));
}

function endsWithDependencyWord(value: string): boolean {
  const tokens = englishTokens(value);
  const last = tokens[tokens.length - 1];
  if (!last || value.slice(last.end).trim()) return false;
  return DEPENDENCY_WORDS.has(last.lower);
}

function isLikelyPageBoundary(
  previous: NormalizedBlock,
  next: NormalizedBlock,
  bridged: NormalizedBlock[],
): boolean {
  const previousBottom = previous.bbox[3];
  const nextTop = next.bbox[1];
  if (!Number.isFinite(previousBottom) || !Number.isFinite(nextTop)) return false;
  const layout = bridged.filter(isLayoutBridge);
  const anchors = layout.filter(isLayoutAnchor);
  if (anchors.some((block) => !hasFiniteBBox(block))) return false;
  const positionedLayout = layout.filter(hasFiniteBBox);
  const pageExtent = pageExtentFor([previous, next, ...positionedLayout]);
  if (!pageExtent) return false;
  const previousPageLayout = positionedLayout.filter(
    (block) => block.pageIndex === previous.pageIndex,
  );
  if (
    previousPageLayout.some((block) => block.bbox[1] < previousBottom)
  ) {
    return false;
  }
  const samePageAnchors = anchors.filter(
    (block) => block.pageIndex === previous.pageIndex,
  );
  const hasFullPageTrailingVisual = samePageAnchors.some(
    (block) =>
      block.bbox[1] >= previousBottom &&
      block.bbox[1] - previousBottom <= pageExtent * 0.1 &&
      block.bbox[3] >= pageExtent * 0.9,
  );
  if (previousBottom < pageExtent * 0.7) {
    return Boolean(
      hasFullPageTrailingVisual &&
        nextTop <= pageExtent * 0.2 &&
        next.pageIndex === previous.pageIndex + 1,
    );
  }
  const nextPageLayout = positionedLayout.filter(
    (block) => block.pageIndex === next.pageIndex,
  );
  if (nextTop <= pageExtent * 0.3) {
    return nextPageLayout.every((block) => block.bbox[3] <= nextTop);
  }
  const nextPageAnchors = anchors.filter(
    (block) => block.pageIndex === next.pageIndex,
  );
  if (!nextPageAnchors.length || !nextPageLayout.length) return false;
  const visualTop = Math.min(...nextPageLayout.map((block) => block.bbox[1]));
  const visualBottom = Math.max(
    ...nextPageLayout.map((block) => block.bbox[3]),
  );
  return (
    visualTop <= pageExtent * 0.2 &&
    nextTop <= pageExtent * 0.8 &&
    visualBottom <= nextTop &&
    nextTop - visualBottom <= pageExtent * 0.08
  );
}

function isLikelySamePageVisualBridge(
  previous: NormalizedBlock,
  next: NormalizedBlock,
  bridged: NormalizedBlock[],
): boolean {
  const layout = bridged.filter(isLayoutBridge);
  const anchors = layout.filter(isLayoutAnchor);
  const positionedLayout = layout.filter(hasFiniteBBox);
  if (
    !hasFiniteBBox(previous) ||
    !hasFiniteBBox(next) ||
    !anchors.length ||
    anchors.some(
      (block) =>
        block.pageIndex !== previous.pageIndex || !hasFiniteBBox(block),
    ) ||
    positionedLayout.some((block) => block.pageIndex !== previous.pageIndex)
  ) {
    return false;
  }
  const pageExtent = pageExtentFor([previous, next, ...positionedLayout]);
  if (!pageExtent) return false;
  const visualTop = Math.min(...positionedLayout.map((block) => block.bbox[1]));
  const visualBottom = Math.max(
    ...positionedLayout.map((block) => block.bbox[3]),
  );
  const previousBottom = previous.bbox[3];
  const nextTop = next.bbox[1];
  if (
    previousBottom > visualTop ||
    visualBottom > nextTop ||
    visualTop - previousBottom > pageExtent * 0.12 ||
    nextTop - visualBottom > pageExtent * 0.12
  ) {
    return false;
  }
  const overlap = Math.max(
    0,
    Math.min(previous.bbox[2], next.bbox[2]) -
      Math.max(previous.bbox[0], next.bbox[0]),
  );
  const narrowerWidth = Math.min(
    previous.bbox[2] - previous.bbox[0],
    next.bbox[2] - next.bbox[0],
  );
  return narrowerWidth > 0 && overlap / narrowerWidth >= 0.5;
}

function isLikelySamePageColumnContinuation(
  previous: NormalizedBlock,
  next: NormalizedBlock,
): boolean {
  if (!hasFiniteBBox(previous) || !hasFiniteBBox(next)) return false;
  const pageExtent = pageExtentFor([previous, next]);
  if (!pageExtent) return false;
  const [previousLeft, , previousRight, previousBottom] = previous.bbox;
  const [nextLeft, nextTop] = next.bbox;
  if (
    previousBottom < pageExtent * 0.7 ||
    nextTop > pageExtent * 0.2 ||
    nextLeft <= previousLeft ||
    nextLeft <= previousRight
  ) {
    return false;
  }
  return nextLeft - previousRight <= pageExtent * 0.08;
}

function hasFiniteBBox(block: NormalizedBlock): boolean {
  return (
    block.bbox.length >= 4 &&
    block.bbox.slice(0, 4).every((coordinate) => Number.isFinite(coordinate))
  );
}

function pageExtentFor(blocks: NormalizedBlock[]): number | null {
  const coordinates = blocks.flatMap((block) => block.bbox.slice(0, 4));
  if (!coordinates.length || coordinates.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return Math.max(...coordinates) <= 1.5 ? 1 : 1000;
}

function cleanBlock(value: string): string {
  return normalizeHTMLScripts(
    normalizeInlineFormulaBoundaries(stripImageReferences(String(value || ""))),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Turn HTML sub/superscripts into Markdown maths.
 *
 * A payload that is only punctuation — or a citation marker such as `[3]` /
 * `［3］` — keeps its characters and just loses the tag; everything else
 * becomes `$_{…}$` / `$^{…}$`. No padding is added around the delimiters, so
 * the surrounding spacing is exactly whatever the source had.
 *
 * The result is built incrementally rather than with a plain `replace` so each
 * emitted formula can see what precedes it: a `$^{…}$` landing straight after
 * a closing `$` would otherwise form a `$$` display fence.
 */
function normalizeHTMLScripts(value: string): string {
  const pattern = /([ \t]*)<(sub|sup)\b[^>]*>([\s\S]*?)<\/\2\s*>/giu;
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const [full, leadingSpace, rawTag, content] = match;
    result += value.slice(cursor, match.index);
    cursor = (match.index ?? 0) + full.length;
    const normalized = content.trim();
    if (!normalized) {
      result += leadingSpace;
      continue;
    }
    if (
      /^[\p{P}\s]+$/u.test(normalized) ||
      isBracketedNumericCitation(normalized)
    ) {
      result += normalized;
      continue;
    }
    const operator = rawTag.toLowerCase() === "sub" ? "_" : "^";
    const rendered = `$${operator}{${normalized}}$`;
    const gap =
      !leadingSpace && needsInlineFormulaGap(result, rendered) ? " " : "";
    result += `${leadingSpace}${gap}${rendered}`;
  }
  return result + value.slice(cursor);
}

function isBracketedNumericCitation(value: string): boolean {
  return /^(?:\[[\d\s,;:，；：.\-–—]+\]|［[\d\s,;:，；：.\-–—]+］|【[\d\s,;:，；：.\-–—]+】)$/u.test(
    value,
  );
}

function normalizeInlineFormulaBoundaries(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "$" || isEscapedAt(value, index)) {
      result += value[index];
      index += 1;
      continue;
    }
    if (value[index + 1] === "$") {
      const displayEnd = findUnescapedDelimiter(value, "$$", index + 2);
      if (displayEnd < 0) {
        result += value.slice(index);
        break;
      }
      result += value.slice(index, displayEnd + 2);
      index = displayEnd + 2;
      continue;
    }
    const inlineEnd = findInlineFormulaEnd(value, index + 1);
    if (inlineEnd < 0) {
      result += value.slice(index);
      break;
    }
    if (
      isLikelyCurrencyMarker(value, index) &&
      isLikelyCurrencyMarker(value, inlineEnd)
    ) {
      result += value[index];
      index += 1;
      continue;
    }
    const formulaContent = value.slice(index + 1, inlineEnd).trim();
    if (!formulaContent) {
      result += value.slice(index, inlineEnd + 1);
      index = inlineEnd + 1;
      continue;
    }
    if (endsWithWordCharacter(result)) result += " ";
    result += `$${formulaContent}$`;
    const following = value[inlineEnd + 1] || "";
    if (startsWithWordCharacter(following)) result += " ";
    index = inlineEnd + 1;
  }
  return result;
}

function isLikelyCurrencyMarker(value: string, index: number): boolean {
  return /^\$(?:\d|\.\d)/u.test(value.slice(index));
}

function findInlineFormulaEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index++) {
    if (
      value[index] === "$" &&
      value[index - 1] !== "$" &&
      value[index + 1] !== "$" &&
      !isEscapedAt(value, index)
    ) {
      return index;
    }
  }
  return -1;
}

function findUnescapedDelimiter(
  value: string,
  delimiter: string,
  start: number,
): number {
  let index = value.indexOf(delimiter, start);
  while (index >= 0 && isEscapedAt(value, index)) {
    index = value.indexOf(delimiter, index + delimiter.length);
  }
  return index;
}

function isEscapedAt(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function cleanDocument(value: string): string {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripImageReferences(value: string): string {
  return String(value || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<IMAGE\b[^>]*>/gi, "")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, "")
    .replace(/^\s*(?:images?[\\/])?[^\s]+\.(?:png|jpe?g|gif|webp|bmp|svg)\s*$/gim, "");
}

function joinNonEmpty(values: string[]): string {
  return values.map(cleanBlock).filter(Boolean).join("\n\n");
}

function findParserVersion(entries: Array<[string, string]>): string | null {
  for (const [name, raw] of entries) {
    if (!/(?:^|[_/\\])layout\.json$/i.test(name)) continue;
    try {
      const parsed = JSON.parse(raw);
      const version = parsed?._version_name;
      if (typeof version === "string" && version.trim()) return version.trim();
    } catch {
      // layout.json is supplementary; selected structured JSON is validated separately.
    }
  }
  return null;
}

export function hashDocumentText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function hasMeaningfulText(value: any): boolean {
  if (typeof value === "string") {
    return stripImageReferences(value).trim().length > 0;
  }
  if (Array.isArray(value)) return value.some(hasMeaningfulText);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    if (/^(?:bbox|image_source|path|page_idx|type|sub_type)$/i.test(key)) {
      return false;
    }
    return hasMeaningfulText(child);
  });
}

function normalizeBBox(value: any): number[] {
  if (!Array.isArray(value) || value.length < 4) return [];
  return value.slice(0, 4).map((part) => Number(part) || 0);
}

function clampHeadingLevel(value: number): number {
  return Math.max(1, Math.min(6, Math.trunc(value)));
}

/**
 * Read a heading level a JSON actually stated. Returns null — never 1 — when
 * the field is missing, so callers are forced to keep looking instead of
 * silently promoting an unknown heading to the document title.
 */
function readStatedLevel(value: any): number | null {
  if (value === undefined || value === null || value === "") return null;
  const level = Math.trunc(Number(value));
  if (!Number.isFinite(level) || level < 1 || level > 6) return null;
  return level;
}

/**
 * The level MinerU's own post-processing assigns to a title block type
 * (`pipeline/model_json_to_middle_json.py::_post_block_process` and the hybrid
 * equivalent). Used only when no JSON stored a level.
 */
function levelFromTitleType(rawType: string): number | null {
  if (rawType === "doc_title") return 1;
  if (rawType === "paragraph_title" || rawType === "heading") return 2;
  return null;
}

/** Case/punctuation/space-insensitive key for matching a heading across JSONs. */
function headingMatchKey(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function evidencePageKey(pageIndex: number, text: string): string {
  return `${pageIndex}\u0000${headingMatchKey(text)}`;
}

/**
 * Harvest every heading level stated anywhere in the MinerU bundle.
 *
 * Body text still comes from exactly one JSON, but a heading whose level is
 * missing there can be answered by another file — `middle.json`/`layout.json`
 * in particular, which is the upstream artefact the `content_list*` files are
 * generated from.
 */
function collectHeadingEvidence(
  entries: Array<[string, string]>,
): HeadingEvidenceIndex {
  const index: HeadingEvidenceIndex = { byPage: new Map(), byText: new Map() };
  const record = (
    pageIndex: number,
    text: string,
    level: number | null,
    origin: HeadingEvidenceEntry["origin"],
    derived: boolean,
  ) => {
    const key = headingMatchKey(text);
    if (!key || level === null) return;
    const entry: HeadingEvidenceEntry = { level, origin, derived };
    const pageKey = evidencePageKey(pageIndex, text);
    index.byPage.set(pageKey, [...(index.byPage.get(pageKey) ?? []), entry]);
    index.byText.set(key, [...(index.byText.get(key) ?? []), entry]);
  };

  for (const [name, rawJSON] of entries) {
    const leaf = name.split(/[\\/]/).pop()?.toLowerCase() || "";
    let kind: HeadingEvidenceEntry["origin"] | null = null;
    if (/content_list_v2\.json$/i.test(leaf)) kind = "content_list_v2";
    else if (/content_list\.json$/i.test(leaf)) kind = "content_list";
    else if (/(?:middle|layout)\.json$/i.test(leaf)) kind = "middle";
    else if (/model\.json$/i.test(leaf)) kind = "model";
    if (!kind) continue;

    let data: any;
    try {
      data = JSON.parse(rawJSON);
    } catch {
      // A companion file being unreadable must never fail the whole parse.
      continue;
    }

    try {
      if (kind === "middle") {
        collectMiddleHeadingEvidence(data, record);
      } else if (kind === "content_list_v2") {
        forEachPagedItem(data, (item, pageIndex) => {
          if (String(item.type || "").toLowerCase() !== "title") return;
          const content = isObject(item.content) ? item.content : {};
          const text = spansToMarkdown(content.title_content ?? content.content);
          record(
            pageIndex,
            text,
            readStatedLevel(content.level ?? item.level),
            "content_list_v2",
            false,
          );
        });
      } else if (kind === "content_list") {
        if (!Array.isArray(data)) continue;
        for (const item of data) {
          if (!isObject(item)) continue;
          const rawType = String(item.type || item.sub_type || "").toLowerCase();
          const stated = readStatedLevel(item.text_level ?? item.level);
          const derived = levelFromTitleType(rawType);
          if (stated === null && derived === null) continue;
          record(
            Number.isInteger(item.page_idx) ? item.page_idx : 0,
            spansToMarkdown(item.text ?? item.content),
            stated ?? derived,
            "content_list",
            stated === null,
          );
        }
      } else {
        forEachPagedItem(data, (item, pageIndex) => {
          const rawType = String(item.type || item.sub_type || "").toLowerCase();
          if (!MODEL_TITLE_TYPES.has(rawType)) return;
          const stated = readStatedLevel(item.level);
          const derived = levelFromTitleType(rawType);
          if (stated === null && derived === null) return;
          record(
            pageIndex,
            spansToMarkdown(item.content ?? item.text),
            stated ?? derived,
            "model",
            stated === null,
          );
        });
      }
    } catch {
      // Best-effort corroboration only.
    }
  }
  return index;
}

function forEachPagedItem(
  data: any,
  visit: (item: Record<string, any>, pageIndex: number) => void,
): void {
  if (!Array.isArray(data)) return;
  data.forEach((page: any, pageIndex: number) => {
    if (!Array.isArray(page)) return;
    for (const item of page) {
      if (isObject(item)) visit(item, pageIndex);
    }
  });
}

/**
 * `middle.json` (returned as `layout.json` by the local MinerU API) keeps the
 * pre-Markdown block tree. `para_blocks[]`/`preproc_blocks[]` carry the same
 * `level` field the content lists are generated from, plus the raw span text.
 */
function collectMiddleHeadingEvidence(
  data: any,
  record: (
    pageIndex: number,
    text: string,
    level: number | null,
    origin: HeadingEvidenceEntry["origin"],
    derived: boolean,
  ) => void,
): void {
  const pages = Array.isArray(data?.pdf_info) ? data.pdf_info : [];
  pages.forEach((page: any, fallbackIndex: number) => {
    if (!isObject(page)) return;
    const pageIndex = Number.isInteger(page.page_idx)
      ? page.page_idx
      : fallbackIndex;
    for (const key of ["para_blocks", "preproc_blocks"]) {
      const blocks = Array.isArray(page[key]) ? page[key] : [];
      for (const block of blocks) {
        if (!isObject(block)) continue;
        const rawType = String(block.type || "").toLowerCase();
        if (!MODEL_TITLE_TYPES.has(rawType)) continue;
        const stated = readStatedLevel(block.level);
        const derived = levelFromTitleType(rawType);
        if (stated === null && derived === null) continue;
        record(
          pageIndex,
          middleBlockText(block),
          stated ?? derived,
          "middle",
          stated === null,
        );
      }
    }
  });
}

function middleBlockText(block: Record<string, any>): string {
  const lines = Array.isArray(block.lines) ? block.lines : [];
  const parts: string[] = [];
  for (const line of lines) {
    for (const span of Array.isArray(line?.spans) ? line.spans : []) {
      const content = span?.content;
      if (typeof content === "string") parts.push(content);
    }
  }
  return stripTags(parts.join(" ")).replace(/\s+/gu, " ").trim();
}

/** Sources are consulted in this order when the body source stated no level. */
const EVIDENCE_PRIORITY: Array<HeadingEvidenceEntry["origin"]> = [
  "content_list_v2",
  "middle",
  "content_list",
  "model",
];

/**
 * Ask every other JSON for this heading's level. Stated levels always beat
 * levels derived from a block type, and a page-matched hit beats a text-only
 * one. Returns null when no JSON knows.
 */
function lookupHeadingEvidence(
  evidence: HeadingEvidenceIndex | undefined,
  pageIndex: number,
  text: string,
  exclude: HeadingLevelSource | null,
): { level: number; origin: HeadingLevelSource } | null {
  if (!evidence) return null;
  const key = headingMatchKey(text);
  if (!key) return null;
  const buckets = [
    evidence.byPage.get(evidencePageKey(pageIndex, text)),
    evidence.byText.get(key),
  ];
  for (const derivedPass of [false, true]) {
    for (const bucket of buckets) {
      if (!bucket) continue;
      for (const origin of EVIDENCE_PRIORITY) {
        const hit = bucket.find(
          (entry) =>
            entry.origin === origin &&
            entry.derived === derivedPass &&
            entry.origin !== exclude,
        );
        if (hit) return { level: hit.level, origin: hit.origin };
      }
    }
  }
  return null;
}

interface SectionNumber {
  depth: number;
  leading: number;
}

/**
 * Section depth carried by the heading text itself: "2.3.1 Reward functions"
 * has depth 3. This mirrors MinerU's own `_correct_toc_level_by_text`, and is
 * the only depth signal that survives MinerU's binary title classification.
 */
function readSectionNumber(text: string): SectionNumber | null {
  const trimmed = String(text || "").trim();
  if (!trimmed || CAPTION_PREFIX_PATTERN.test(trimmed)) return null;

  // "A.1 Filter type" — an appendix letter counts as one level of depth.
  const appendix = APPENDIX_NUMBER_PATTERN.exec(trimmed);
  if (appendix) {
    return { depth: appendix[1].split(/[.．]/u).length, leading: 1 };
  }

  const match = SECTION_NUMBER_PATTERN.exec(trimmed);
  if (!match) return null;
  const parts = match[1].split(/[.．·]/u);
  const leading = Number(parts[0]);
  // Guards against years and quantities parsed as section numbers
  // ("2011 - A study ...", "300 K annealing"). Zero is allowed only as a
  // whole chapter, which is how Chinese journals number "0 引言".
  if (!Number.isFinite(leading) || leading > MAX_SECTION_NUMBER) return null;
  if (leading === 0 && parts.length > 1) return null;
  if (leading < 0) return null;
  if (parts.some((part) => part.length > 2 && Number(part) > 99)) return null;
  return { depth: parts.length, leading };
}

type HeadingClass = "numbered" | "section-name" | "enumeration" | "unknown";

function classifyHeadingText(text: string): {
  kind: HeadingClass;
  depth: number;
} {
  const trimmed = String(text || "")
    .trim()
    .replace(HEADING_NOISE_PREFIX_PATTERN, "")
    .trim();
  if (!trimmed) return { kind: "unknown", depth: 0 };

  const numbered = readSectionNumber(trimmed);
  if (numbered) return { kind: "numbered", depth: numbered.depth };
  if (CHINESE_CHAPTER_PATTERN.test(trimmed) || APPENDIX_PATTERN.test(trimmed)) {
    return { kind: "numbered", depth: 1 };
  }

  // A patent INID code ("(54) 发明名称") looks like an enumeration but names a
  // top-level section, so strip the code before testing the section list.
  const withoutCode = trimmed.replace(LEADING_CODE_PATTERN, "");
  if (SECTION_NAME_KEYS.has(headingMatchKey(withoutCode))) {
    return { kind: "section-name", depth: 1 };
  }
  if (ENUMERATION_PATTERN.test(trimmed)) {
    return { kind: "enumeration", depth: 0 };
  }
  return { kind: "unknown", depth: 0 };
}

/**
 * Decide every heading's Markdown level, then render it.
 *
 * Order of authority, per heading:
 *   1. a level the body-text JSON stated;
 *   2. a level any other JSON in the bundle stated (stated beats derived);
 *   3. section numbering in the heading text — the only depth MinerU 3.x can
 *      express beyond its two title classes;
 *   4. a small set of named front/back-matter sections;
 *   5. enumerations, nested one level under the section they sit in;
 *   6. the MinerU class itself, unchanged from previous behaviour.
 *
 * MinerU stops at level 2, so step 3 is what actually recovers depth. Steps
 * 1-2 still run first: if a future MinerU (or the DOCX backend, which does
 * carry real levels) states a deeper level, that wins over the text.
 */
function renderResolvedHeadings(
  blocks: NormalizedBlock[],
  evidence: HeadingEvidenceIndex | undefined,
): NormalizedBlock[] {
  let docTitleSeen = false;
  // Markdown level of the innermost numbered section, for nesting enumerations.
  let enclosingSectionLevel = CHAPTER_BASE_LEVEL;

  return blocks.map((block) => {
    const heading = block.heading;
    if (block.type !== "title" || !heading) return block;
    if (!heading.text) {
      return { ...block, markdown: "" };
    }

    let level: number | null = heading.sourceLevel;
    let origin: HeadingLevelSource | null = heading.sourceOrigin;
    let derived = heading.sourceDerived;

    // Ask the other JSONs whenever this source said nothing, or only guessed
    // from a block type while another file may have stored a real level.
    if (level === null || derived) {
      const corroborated = lookupHeadingEvidence(
        evidence,
        block.pageIndex,
        heading.text,
        level === null ? null : heading.sourceOrigin,
      );
      if (corroborated) {
        level = corroborated.level;
        origin = corroborated.origin;
        derived = false;
      }
    }

    const classified = classifyHeadingText(heading.text);
    let resolved: number;
    let resolvedSource: HeadingLevelSource;

    if (level !== null && level >= CHAPTER_BASE_LEVEL + 1) {
      // A source stated a genuinely deep level — trust it over the text.
      resolved = level;
      resolvedSource = origin ?? "fallback";
    } else if (level === 1) {
      // Document title. The first one keeps `#`; later ones (bilingual titles,
      // running heads reparsed as titles) drop a level so a document still has
      // exactly one top-level block.
      resolved = docTitleSeen ? CHAPTER_BASE_LEVEL : 1;
      resolvedSource = docTitleSeen ? "doc-title" : (origin ?? "doc-title");
      docTitleSeen = true;
    } else if (classified.kind === "numbered") {
      resolved = CHAPTER_BASE_LEVEL + classified.depth - 1;
      resolvedSource = "numbering";
      enclosingSectionLevel = resolved;
    } else if (classified.kind === "section-name") {
      resolved = CHAPTER_BASE_LEVEL;
      resolvedSource = "section-name";
      enclosingSectionLevel = resolved;
    } else if (classified.kind === "enumeration") {
      resolved = enclosingSectionLevel + 1;
      resolvedSource = "enumeration";
    } else {
      // Every JSON agrees this is a heading and none of them — nor the text —
      // says how deep. Keep MinerU's own class (level 2, the same output as
      // before this change) and label it `fallback` so the guess is visible
      // rather than passed off as recovered structure.
      resolved = level ?? CHAPTER_BASE_LEVEL;
      resolvedSource = "fallback";
    }

    const headingLevel = clampHeadingLevel(resolved);
    return {
      ...block,
      headingLevel,
      headingLevelSource: resolvedSource,
      markdown: `${"#".repeat(headingLevel)} ${heading.text}`,
    };
  });
}

function isObject(value: any): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stripTags(value: string): string {
  return String(value || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
}

function decodeHTMLEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, token) => {
    if (token[0] === "#") {
      const hex = token[1]?.toLowerCase() === "x";
      const code = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    }
    return named[String(token).toLowerCase()] ?? _match;
  });
}
