export const ASSEMBLER_VERSION = 1;

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
  canBridge: boolean;
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
  const normalized = normalizeSource(source);
  const meaningful = normalized.filter(
    (block) => block.markdown.trim() && !block.ignoredFurniture,
  );
  if (!meaningful.length) {
    throw new StructuredDocumentError(
      `${source.format} contains no meaningful document text`,
    );
  }

  const merged = mergeInterruptedParagraphs(normalized);
  const blocks = merged
    .filter((block) => block.markdown.trim() && !block.ignoredFurniture)
    .map(({ type, pageIndex, bbox, markdown }) => ({
      type,
      pageIndex,
      bbox,
      markdown: cleanBlock(markdown),
    }))
    .filter((block) => block.markdown);
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
  if (source.format === "content_list_v2") {
    return source.data.flatMap((page: any[], pageIndex: number) =>
      page.map((item) => normalizeV2Block(item, pageIndex)),
    );
  }
  if (source.format === "content_list") {
    return source.data.map((item: any, index: number) =>
      normalizeLegacyBlock(item, index),
    );
  }
  return source.data.flatMap((page: any[], pageIndex: number) =>
    page.map((item) => normalizeModelBlock(item, pageIndex)),
  );
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
  if (["title", "heading", "doc_title", "paragraph_title"].includes(rawType)) {
    type = "title";
    const level = clampHeadingLevel(item.text_level ?? item.level ?? 1);
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
  return {
    type,
    pageIndex,
    bbox: normalizeBBox(item?.bbox),
    markdown: cleanBlock(markdown),
    mergePrev: item?.merge_prev === true || item?.content?.merge_prev === true,
    ignoredFurniture: FURNITURE_TYPES.has(type),
    canBridge: type === "image" || type === "chart" || FURNITURE_TYPES.has(type),
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
    spansToMarkdown(captions),
    kind === "table" ? table : bodyText,
    spansToMarkdown(footnotes),
  ]);
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
    return value.map(spansToMarkdown).join("");
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

function inlineEquation(value: any): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^\$[^$].*\$$/s.test(text)) return text;
  return `$${text.replace(/^\$+|\$+$/g, "")}$`;
}

function renderDisplayEquation(value: any): string {
  const text = spansToMarkdown(value).trim().replace(/^\$+|\$+$/g, "");
  return text ? `$$\n${text}\n$$` : "";
}

function mergeInterruptedParagraphs(blocks: NormalizedBlock[]): NormalizedBlock[] {
  const output: NormalizedBlock[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const current = blocks[index];
    if (current.type !== "paragraph" || !current.markdown) {
      output.push(current);
      continue;
    }

    let nextIndex = index + 1;
    const bridged: NormalizedBlock[] = [];
    while (
      nextIndex < blocks.length &&
      bridged.length < 4 &&
      blocks[nextIndex].canBridge
    ) {
      bridged.push(blocks[nextIndex]);
      nextIndex++;
    }
    const next = blocks[nextIndex];
    if (
      next?.type === "paragraph" &&
      shouldMergeParagraphs(current, next)
    ) {
      const separator = /-$/u.test(current.markdown) && /^[a-z]/.test(next.markdown)
        ? ""
        : " ";
      output.push({
        ...current,
        markdown: cleanBlock(`${current.markdown}${separator}${next.markdown}`),
      });
      for (const bridge of bridged) output.push(bridge);
      index = nextIndex;
      continue;
    }
    output.push(current);
  }
  return output;
}

function shouldMergeParagraphs(
  previous: NormalizedBlock,
  next: NormalizedBlock,
): boolean {
  if (next.pageIndex < previous.pageIndex || next.pageIndex > previous.pageIndex + 1) {
    return false;
  }
  if (
    next.pageIndex === previous.pageIndex + 1 &&
    !isLikelyPageBoundary(previous, next)
  ) {
    return false;
  }
  if (next.mergePrev) return true;
  const previousText = previous.markdown.trim();
  const nextText = next.markdown.trim();
  if (!previousText || !nextText) {
    return false;
  }
  // Citations following an author abbreviation are a common MinerU split:
  // "Yamasaki et al." + "[69, 70] proposed ...".  The citation token is a
  // stronger continuation signal than the abbreviation's period is a stop.
  if (/^\[[0-9]/u.test(nextText)) return true;
  if (/[.!?。！？；;:]\s*$/u.test(previousText)) return false;
  return /^(?:[a-z]|\[[0-9]|\([0-9]|[,.;:)}\]])/u.test(nextText);
}

function isLikelyPageBoundary(
  previous: NormalizedBlock,
  next: NormalizedBlock,
): boolean {
  const previousBottom = previous.bbox[3];
  const nextTop = next.bbox[1];
  if (!Number.isFinite(previousBottom) || !Number.isFinite(nextTop)) return false;
  // MinerU v2 uses a 0..1000 page coordinate system; model output uses 0..1.
  // Inferring height from the candidate blocks makes the lower-page check
  // tautological whenever the previous paragraph is the lowest observed block.
  const maxCoordinate = Math.max(...previous.bbox, ...next.bbox);
  const pageExtent = maxCoordinate <= 1.5 ? 1 : 1000;
  return previousBottom >= pageExtent * 0.7 && nextTop <= pageExtent * 0.3;
}

function cleanBlock(value: string): string {
  return stripImageReferences(String(value || ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
