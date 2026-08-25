export const ASSEMBLER_VERSION = 5;

export type MinerUStructuredFormat =
  | "content_list_v2"
  | "content_list"
  | "model";

export interface StructuredSource {
  format: MinerUStructuredFormat;
  fileName: string;
  data: any;
  rawJSON: string;
  structuredHash: string;
  parserVersion: string | null;
}

export interface AssembledDocumentBlock {
  type: string;
  pageIndex: number;
  bbox: number[];
  markdown: string;
  /** Original flattened MinerU block order before paragraph/figure reordering. */
  sourceOrder: number;
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

interface NormalizedBlock extends AssembledDocumentBlock {
  mergePrev: boolean;
  ignoredFurniture: boolean;
  bridgeKind: BridgeKind;
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
    };
  }

  throw new StructuredDocumentError(
    "MinerU returned no supported structured result (content_list_v2, content_list, or model)",
  );
}

export function assembleStructuredDocument(
  source: StructuredSource,
): AssembledDocument {
  const normalized = filterStandaloneVisualOcrNoise(normalizeSource(source));
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
    .map(({ type, pageIndex, bbox, markdown, sourceOrder }) => ({
      type,
      pageIndex,
      bbox,
      markdown: cleanBlock(markdown),
      sourceOrder,
    }));
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
  switch (type) {
    case "title": {
      const level = clampHeadingLevel(content.level ?? item.level ?? 1);
      const text = spansToMarkdown(content.title_content ?? content.content);
      markdown = text ? `${"#".repeat(level)} ${text}` : "";
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
  return makeBlock(type, pageIndex, item, markdown);
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
    const level = clampHeadingLevel(legacyTextLevel || item.level || 1);
    const text = spansToMarkdown(item.text ?? item.content);
    markdown = text ? `${"#".repeat(level)} ${text}` : "";
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
  return makeBlock(type, pageIndex, item, markdown);
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
  if (MODEL_TITLE_TYPES.has(rawType)) {
    type = "title";
    const level = rawType === "doc_title" ? 1 : 2;
    const text = spansToMarkdown(item.content ?? item.text);
    markdown = text ? `${"#".repeat(level)} ${text}` : "";
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
  return makeBlock(type, pageIndex, item, markdown);
}

function makeBlock(
  type: string,
  pageIndex: number,
  item: any,
  markdown: string,
): NormalizedBlock {
  const publicationMetadataFootnote =
    type === "page_footnote" && isPublicationMetadataFootnote(markdown);
  return {
    type,
    pageIndex,
    bbox: normalizeBBox(item?.bbox),
    markdown: publicationMetadataFootnote ? "" : cleanBlock(markdown),
    sourceOrder: -1,
    mergePrev: item?.merge_prev === true || item?.content?.merge_prev === true,
    ignoredFurniture: FURNITURE_TYPES.has(type) || publicationMetadataFootnote,
    bridgeKind: FURNITURE_TYPES.has(type) || publicationMetadataFootnote
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

function isPublicationMetadataFootnote(markdown: string): boolean {
  return (
    /\b(?:corresponding\s+author|e-?mail\s+address)\b/i.test(markdown) ||
    /(?:^|[\n;；])\s*(?:收稿日期|修订日期)\s*[:：]/u.test(markdown)
  );
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
    return `${result}${separator}${next}`;
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
  return /^[A-Za-z0-9\u3400-\u9fff]$/u.test(value);
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
      candidate.pageIndex > sourcePage + 1 ||
      candidate.bridgeKind === null
    ) {
      break;
    }
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
  if (!/^(?:[a-z]|\[[0-9]|\([0-9]|[,.;:)}\]])/u.test(nextText)) {
    return false;
  }
  if (hasLayoutBridge) return endsWithDependencyWord(previousText);
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
  if (!pageExtent || previousBottom < pageExtent * 0.7) return false;
  const previousPageLayout = positionedLayout.filter(
    (block) => block.pageIndex === previous.pageIndex,
  );
  if (
    previousPageLayout.some((block) => block.bbox[1] < previousBottom)
  ) {
    return false;
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
  return normalizeInlineFormulaBoundaries(
    normalizeHTMLScripts(stripImageReferences(String(value || ""))),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeHTMLScripts(value: string): string {
  return value.replace(
    /<(sub|sup)\b[^>]*>([\s\S]*?)<\/\1\s*>/giu,
    (_match, rawTag: string, content: string) => {
      const operator = rawTag.toLowerCase() === "sub" ? "_" : "^";
      return `$${operator}{${content}}$`;
    },
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
  return cleanBlock(value).replace(/\n{3,}/g, "\n\n");
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

function clampHeadingLevel(value: any): number {
  const level = Math.trunc(Number(value) || 1);
  return Math.max(1, Math.min(6, level));
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
