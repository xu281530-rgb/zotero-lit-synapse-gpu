/**
 * What of a paper's body text is worth putting in the keyword index.
 *
 * 三类内容会被排除，每一类都是实测出来的问题，不是预防性设计：
 *
 * 1. 参考文献。被引论文的标题和术语密度极高，一旦入索引，一篇只是「引用了
 *    某方向」的论文会和真正研究该方向的论文得到相近的分数。实测本库返回的
 *    证据段落里大量是 `[18] Y. Ning, ... Mater. Sci. Eng. A 531 (2012) 91–97`。
 *
 * 2. 图片链接。MinerU 的 Markdown 里含 `![](images/8f3a2b...)`，其中的哈希串
 *    会变成一批只出现一次的垃圾词元：涨体积、零检索价值。
 *
 * 3. 作者贡献与利益声明段落。`CRediT authorship contribution statement`、
 *    `Declaration of Competing Interest` 等，是投稿流程产物而非论文内容。
 *
 * TextChunker 本来就有 skipReferences 且默认开启，但它的检测要求 References
 * 独占一行，而正文来自 MinerU 的 Markdown，实际写法是 `## References`，所以
 * 那个开关从未生效过。{@link findReferencesBoundary} 是修好的检测，同时被
 * 关键词索引和 TextChunker 使用。
 */

/**
 * Headings that begin the reference list.
 *
 * Matched with an optional Markdown heading prefix and an optional leading
 * number, which is what the previous line-exact pattern could not do. A
 * trailing colon is allowed because some journals typeset `References:`.
 */
const REFERENCE_HEADINGS = [
  "references",
  "reference",
  "bibliography",
  "references and notes",
  "literature cited",
  "参考文献",
  "參考文獻",
  "引用文献",
];

/**
 * Headings for the submission-process sections that follow the body.
 *
 * These are excluded individually rather than by "everything after the body",
 * because they are interleaved with real content — data availability sometimes
 * sits before the conclusions.
 */
const BOILERPLATE_HEADINGS = [
  "credit authorship contribution statement",
  "declaration of competing interest",
  "declaration of competing interests",
  "declaration of conflicting interests",
  "conflict of interest",
  "conflicts of interest",
  "competing interests",
  "declaration of generative ai",
  "acknowledgement",
  "acknowledgements",
  "acknowledgment",
  "acknowledgments",
  "data availability",
  "data availability statement",
  "supplementary materials",
  "supplementary material",
  "supporting information",
  "author contributions",
  "funding",
  "致谢",
  "作者贡献",
  "利益冲突",
  "数据可用性",
];

/** Escape a literal for use inside a RegExp. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Build a pattern matching any of `headings` as a heading line.
 *
 * Anatomy of the prefix, which is the whole reason the original pattern failed:
 *   `#{1,6}\s*`      Markdown ATX heading, which MinerU always emits
 *   `\d+[.、)]?\s*`   a section number, e.g. "5. References"
 * and the suffix allows a colon, a period, or nothing, but nothing else — so a
 * sentence merely beginning with the word "References" is not a heading.
 */
function buildHeadingPattern(headings: string[]): RegExp {
  const alternatives = headings.map(escapeLiteral).join("|");
  return new RegExp(
    `^[ \\t>*_]*(?:#{1,6}[ \\t]*)?(?:\\d+[.、)][ \\t]*)?(?:${alternatives})[ \\t]*[:：.]?[ \\t]*$`,
    "imu",
  );
}

const REFERENCE_HEADING_PATTERN = buildHeadingPattern(REFERENCE_HEADINGS);
const BOILERPLATE_HEADING_PATTERN = buildHeadingPattern(BOILERPLATE_HEADINGS);

/** Any Markdown heading line, used to find where a boilerplate section ends. */
const ANY_HEADING_PATTERN = /^[ \t>*_]*#{1,6}[ \t]*\S.*$/gmu;

/**
 * Offset where the reference list starts, or null when there is none.
 *
 * When a paper repeats the heading — which happens when its body was extracted
 * twice — the LAST occurrence is returned, so that everything genuinely
 * preceding the final reference list is kept. Taking the first would discard a
 * whole duplicate body's worth of real content.
 */
export function findReferencesBoundary(text: string): number | null {
  if (!text) return null;
  const pattern = new RegExp(REFERENCE_HEADING_PATTERN.source, "gimu");
  let last: number | null = null;
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    last = match.index;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return last;
}

/**
 * A reference-list line that survived heading detection.
 *
 * Papers whose extraction lost the heading still have unmistakable entries:
 * a bracketed ordinal, then author initials, then a journal abbreviation and a
 * year in parentheses. Requiring several of those signals together keeps the
 * test from firing on ordinary prose that happens to cite `[12]`.
 */
const REFERENCE_LINE_PATTERN =
  /^\s*\[\d{1,3}\]\s+\S.*?(?:\(\d{4}\)|,\s*\d{4}|\b\d{4};)/u;

/** A line that is nothing but a Markdown image or a bare image path. */
const IMAGE_LINE_PATTERN =
  /^\s*!?\[[^\]]*\]\([^)]*\)\s*$|^\s*(?:images?|figures?)\/\S+\s*$/iu;

/** Inline Markdown images and HTML `<img>` tags, stripped wherever they occur. */
const INLINE_IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/giu;

/**
 * A long unbroken alphanumeric run, i.e. a hash, a base64 fragment or a
 * checksum. Nothing a person searches for looks like this, and every one of
 * them becomes a unique term that only inflates the index.
 */
const OPAQUE_RUN_PATTERN = /\b[0-9a-f]{16,}\b|\b[A-Za-z0-9+/]{32,}={0,2}\b/gu;

export interface BodyFilterResult {
  /** Text to index. Empty when nothing indexable survived. */
  text: string;
  /** Why text was removed, for diagnostics. Absent reasons are simply unused. */
  removed: {
    referencesChars: number;
    boilerplateChars: number;
    imageChars: number;
    opaqueChars: number;
  };
}

/** Remove one boilerplate section: its heading up to the next heading. */
function stripBoilerplateSections(text: string): {
  text: string;
  removedChars: number;
} {
  const headings: Array<{ start: number; end: number }> = [];
  ANY_HEADING_PATTERN.lastIndex = 0;
  for (
    let match = ANY_HEADING_PATTERN.exec(text);
    match !== null;
    match = ANY_HEADING_PATTERN.exec(text)
  ) {
    headings.push({ start: match.index, end: match.index + match[0].length });
  }
  if (headings.length === 0) return { text, removedChars: 0 };

  const drop: Array<{ from: number; to: number }> = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const line = text.slice(heading.start, heading.end);
    if (!BOILERPLATE_HEADING_PATTERN.test(line)) continue;
    const to =
      index + 1 < headings.length ? headings[index + 1].start : text.length;
    drop.push({ from: heading.start, to });
  }
  if (drop.length === 0) return { text, removedChars: 0 };

  let result = "";
  let cursor = 0;
  let removedChars = 0;
  for (const range of drop) {
    result += text.slice(cursor, range.from);
    removedChars += range.to - range.from;
    cursor = range.to;
  }
  result += text.slice(cursor);
  return { text: result, removedChars };
}

/**
 * Reduce one document's extracted text to what the keyword index should hold.
 *
 * Order matters: the reference list is cut first so that its thousands of
 * bracketed entries never reach the per-line tests, which would otherwise be
 * the expensive part on a long bibliography.
 */
export function filterBodyForKeywordIndex(text: string): BodyFilterResult {
  const removed = {
    referencesChars: 0,
    boilerplateChars: 0,
    imageChars: 0,
    opaqueChars: 0,
  };
  if (!text) return { text: "", removed };

  let working = text;

  const referencesAt = findReferencesBoundary(working);
  if (referencesAt !== null) {
    removed.referencesChars = working.length - referencesAt;
    working = working.slice(0, referencesAt);
  }

  const boilerplate = stripBoilerplateSections(working);
  removed.boilerplateChars = boilerplate.removedChars;
  working = boilerplate.text;

  const beforeImages = working.length;
  working = working.replace(INLINE_IMAGE_PATTERN, " ");
  const keptLines: string[] = [];
  for (const line of working.split("\n")) {
    if (IMAGE_LINE_PATTERN.test(line)) continue;
    if (REFERENCE_LINE_PATTERN.test(line)) continue;
    keptLines.push(line);
  }
  working = keptLines.join("\n");
  removed.imageChars = Math.max(0, beforeImages - working.length);

  const beforeOpaque = working.length;
  working = working.replace(OPAQUE_RUN_PATTERN, " ");
  removed.opaqueChars = Math.max(0, beforeOpaque - working.length);

  return { text: working.trim(), removed };
}

// ===========================================================================
// Front matter that Zotero already holds as metadata
// ===========================================================================

/**
 * The body text of a PDF repeats what the item record already stores: the
 * title, the abstract, the author list. `extractItemContent` deliberately
 * prepends the metadata copy of the title and abstract so that an item with no
 * readable PDF is still searchable — so the copy sitting in the body is pure
 * duplication, and it competes with real content for retrieval slots.
 *
 * Two mechanisms are combined, because measurement showed neither works alone:
 *
 *  - Position alone is wrong. Some journals print no `Introduction` heading at
 *    all, so "delete everything before the first section" eats the opening of
 *    the body.
 *  - Content matching alone is wrong. A conclusions section restates the
 *    abstract closely enough to score 0.91, and a patent's claims legitimately
 *    repeat the title on almost every clause.
 *
 * So position bounds the damage — nothing past the front matter is ever
 * touched — and precise matchers decide what goes inside that window. A
 * paragraph the metadata cannot vouch for is kept.
 */

/** How far into the document front matter may possibly extend. */
const FRONT_MATTER_MAX_PARAGRAPHS = 25;
const FRONT_MATTER_MAX_CHARS = 8000;

/**
 * Token overlap required to call two texts the same content.
 *
 * Measured over this library: every genuine abstract scored 0.97 or better
 * against the item's `abstractNote` (20 of 27 scored exactly 1.00), while the
 * highest-scoring false positive — a conclusions section — reached 0.91.
 */
const FRONT_MATTER_MATCH_THRESHOLD = 0.95;

/** A heading that means the body has started, so front matter is over. */
const BODY_SECTION_HEADINGS = [
  "introduction",
  "background",
  "related work",
  "literature review",
  "引言",
  "前言",
  "绪论",
  "緒論",
  "研究背景",
];

/**
 * Column labels that carry no information of their own. Compared after
 * `frontMatterKey` normalisation, so `A B S T R A C T` — which is how several
 * publishers typeset it, and how MinerU reads it — matches `abstract`.
 */
const FRONT_MATTER_LABELS = new Set(
  [
    "abstract",
    "graphicalabstract",
    "highlights",
    "articleinfo",
    "articleinformation",
    "keywords",
    "keyword",
    "keywordsabstract",
    "indexterms",
    "摘要",
    "关键词",
    "關鍵詞",
    "发明名称",
    "实用新型名称",
    "摘要附图",
    "作者简介",
    "基金项目",
    "通信作者",
  ].map(frontMatterKey),
);

/** `Keywords: …`, `关键词：…` — the list, not just the label. */
const KEYWORD_LINE_PATTERN =
  /^[ \t>*_]*(?:#{1,6}[ \t]*)?(?:keywords?|key\s+words|index\s+terms|关\s*键\s*词|關\s*鍵\s*詞)[ \t]*[:：]?/iu;

/**
 * Bibliographic furniture: identifiers, dates and classification codes that
 * belong to the record rather than to the paper.
 */
const BIBLIOGRAPHIC_LINE_PATTERNS: RegExp[] = [
  /\barxiv:\s*\d{4}\.\d{4,5}/iu,
  /\bdoi\s*[:：]|\bhttps?:\/\/(?:dx\.)?doi\.org\//iu,
  /\bissn\b|\bisbn\b/iu,
  /^\s*©|\ball rights reserved\b/iu,
  /\b(?:received|revised|accepted|available online|published online)\b[^\n]{0,40}\b(?:19|20)\d{2}\b/iu,
  /中图分类号|文献标志码|文献标识码|文章编号|收稿日期|修回日期|网络首发|基金项目|作者简介|通信作者|通讯作者/u,
  /^\s*[（(]\s*\d{2}\s*[)）]\s*\S/u, // patent INID code, e.g. "(21) 申请号 …"
  /^\s*(?:cn|us|ep|wo|jp)\s*\d{6,}\s*[a-z]\d?\s*$/iu, // patent publication number
];

/**
 * A patent cover-sheet table: several INID codes in one block. MinerU renders
 * it as an HTML table, so it never starts with a code and the line patterns
 * above cannot see it.
 */
const PATENT_COVER_TABLE_PATTERN = /[（(]\s*\d{2}\s*[)）]\s*\S/gu;

function isPatentCoverBlock(paragraph: string): boolean {
  if (paragraph.length > 2000) return false;
  const matches = paragraph.match(PATENT_COVER_TABLE_PATTERN);
  return (matches?.length ?? 0) >= 3;
}

/** Organisation words that make a line an affiliation rather than prose. */
const AFFILIATION_ORG_PATTERN =
  /\b(?:department|dept\.|university|universit[ée]|institute|institut|laborator|college|faculty|school\s+of|academy|hospital|centre|center for|co\.,?\s*ltd|corporation)\b|大学|學院|学院|研究所|研究院|实验室|實驗室|重点实验室|科学院|集团|有限公司|公司/iu;

/** Evidence that an organisation line is an address block, not a sentence. */
const AFFILIATION_ADDRESS_PATTERN =
  /\b\d{4,6}\b|\b(?:china|usa|u\.s\.a|united states|uk|united kingdom|japan|korea|germany|france|spain|italy|canada|australia|netherlands|denmark|sweden|singapore|india|portugal)\b\s*[.;]?\s*$|[，,]\s*[一-鿿]{2,}(?:省|市|区|县)/iu;

/** A leading affiliation marker such as `$^{a}$` or `a)`. */
const AFFILIATION_MARKER_PATTERN = /^\s*(?:\$\^?\{?[a-z0-9,*†‡\s]{1,10}\}?\$|[a-z]\)|\d\))\s*\S/iu;

export interface FrontMatterMetadata {
  title?: string | null;
  abstract?: string | null;
  creators?: string[] | null;
}

export interface FrontMatterFilterResult {
  text: string;
  removed: {
    titleChars: number;
    abstractChars: number;
    authorChars: number;
    affiliationChars: number;
    keywordChars: number;
    bibliographicChars: number;
    labelChars: number;
  };
  /** Whether the metadata abstract was actually located and removed. */
  matchedAbstract: boolean;
}

/** Case/punctuation/space-insensitive key, so `A B S T R A C T` folds down. */
function frontMatterKey(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Comparison tokens: Latin words and individual CJK characters.
 *
 * Maths, markup and punctuation are dropped entirely — that is what lets a
 * parsed abstract containing `$\alpha$` still match a metadata abstract that
 * spells it out, which is the mismatch case that motivated a threshold at all.
 */
function overlapTokens(value: string): string[] {
  const stripped = String(value || "")
    .replace(/\$\$[\s\S]*?\$\$/gu, " ")
    .replace(/\$[^$\n]*\$/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/!?\[[^\]]*\]\([^)]*\)/gu, " ")
    .normalize("NFKC")
    .toLowerCase();
  const out: string[] = [];
  for (const match of stripped.matchAll(/[a-z0-9]+|[㐀-鿿]/gu)) {
    out.push(match[0]);
  }
  return out;
}

function tokenBag(tokens: string[]): Map<string, number> {
  const bag = new Map<string, number>();
  for (const token of tokens) bag.set(token, (bag.get(token) ?? 0) + 1);
  return bag;
}

/**
 * Fraction of `needle`'s tokens that also occur in `hay`, counting repeats.
 *
 * Deliberately asymmetric: the parsed paragraph may carry extra text the
 * record does not have — a leading `Abstract:`, a formula, a stray footnote
 * marker — and that must not lower the score.
 */
function tokenContainment(needle: string[], hay: string[]): number {
  if (!needle.length) return 0;
  const hayBag = tokenBag(hay);
  let hits = 0;
  let total = 0;
  for (const [token, count] of tokenBag(needle)) {
    total += count;
    hits += Math.min(count, hayBag.get(token) ?? 0);
  }
  return total ? hits / total : 0;
}

function headingText(paragraph: string): string | null {
  const match = /^\s{0,3}#{1,6}\s+(.*)$/u.exec(paragraph.trim());
  return match ? match[1].trim() : null;
}

/** Where the front matter can no longer extend to. */
function frontMatterLimit(paragraphs: string[]): number {
  let chars = 0;
  const limit = Math.min(paragraphs.length, FRONT_MATTER_MAX_PARAGRAPHS);
  for (let index = 0; index < limit; index += 1) {
    const heading = headingText(paragraphs[index]);
    if (heading) {
      const key = frontMatterKey(heading);
      // A numbered section, or a named body section, means the paper proper
      // has begun. `1. Introduction` normalises to `1introduction`, so the
      // number is stripped before the name is compared.
      const withoutNumber = key.replace(/^\d+/u, "");
      if (
        BODY_SECTION_HEADINGS.some(
          (name) => withoutNumber === frontMatterKey(name),
        ) ||
        /^\s{0,3}#{1,6}\s+\d+(?:[.．]\d+)*[.．、)）]?\s+\S/u.test(paragraphs[index])
      ) {
        return index;
      }
    }
    chars += paragraphs[index].length;
    if (chars > FRONT_MATTER_MAX_CHARS) return index;
  }
  return limit;
}

function isAffiliationParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  if (trimmed.length > 500) return false;
  if (!AFFILIATION_ORG_PATTERN.test(trimmed)) return false;
  return (
    AFFILIATION_MARKER_PATTERN.test(trimmed) ||
    AFFILIATION_ADDRESS_PATTERN.test(trimmed)
  );
}

function isAuthorParagraph(
  paragraph: string,
  creatorTokens: string[],
): boolean {
  const trimmed = paragraph.trim();
  if (!creatorTokens.length || trimmed.length > 600) return false;
  // Author lines are names plus markers; a body sentence that happens to name
  // an author will not carry most of the author list.
  return tokenContainment(creatorTokens, overlapTokens(trimmed)) >= 0.6;
}

/**
 * Remove, from the front matter only, what the Zotero record already holds.
 *
 * Returns the text unchanged when nothing matched — a paper whose PDF is a
 * translation of the record's language, or whose abstract was never printed,
 * simply keeps its front matter rather than being cut blind.
 */
export function stripFrontMatterDuplicates(
  text: string,
  metadata: FrontMatterMetadata,
): FrontMatterFilterResult {
  const removed = {
    titleChars: 0,
    abstractChars: 0,
    authorChars: 0,
    affiliationChars: 0,
    keywordChars: 0,
    bibliographicChars: 0,
    labelChars: 0,
  };
  if (!text?.trim()) return { text: text ?? "", removed, matchedAbstract: false };

  const paragraphs = text.split(/\n\s*\n+/u);
  const limit = frontMatterLimit(paragraphs);
  if (limit <= 0) return { text, removed, matchedAbstract: false };

  const titleTokens = overlapTokens(metadata.title ?? "");
  const abstractTokens = overlapTokens(metadata.abstract ?? "");
  const creatorTokens = overlapTokens((metadata.creators ?? []).join(" "));
  const titleLength = (metadata.title ?? "").trim().length;

  let matchedAbstract = false;
  const kept: string[] = [];

  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    if (index >= limit) {
      kept.push(paragraph);
      continue;
    }
    const trimmed = paragraph.trim();
    if (!trimmed) {
      kept.push(paragraph);
      continue;
    }
    const heading = headingText(trimmed);
    const body = heading ?? trimmed;
    const tokens = overlapTokens(body);

    // A column label carries nothing on its own, and once its content is gone
    // it would otherwise be left behind as an empty heading. The optional
    // leading code covers patent front pages, where the label is printed as
    // `(54) 发明名称`.
    if (
      heading !== null &&
      FRONT_MATTER_LABELS.has(
        frontMatterKey(heading.replace(/^\s*[（(]\s*\d{1,3}\s*[)）]\s*/u, "")),
      )
    ) {
      removed.labelChars += paragraph.length;
      continue;
    }

    if (
      abstractTokens.length >= 20 &&
      tokenContainment(abstractTokens, tokens) >= FRONT_MATTER_MATCH_THRESHOLD
    ) {
      removed.abstractChars += paragraph.length;
      matchedAbstract = true;
      continue;
    }

    // The title must be matched on a paragraph of roughly title length.
    // Without that, two things go wrong: every abstract trivially "contains"
    // all of the title's words, and a patent's claims each restate the title
    // before adding their own clause — deleting those would destroy the only
    // substantive text a patent has.
    if (
      titleTokens.length >= 3 &&
      titleLength > 0 &&
      body.length <= titleLength * 1.6 + 20 &&
      tokenContainment(titleTokens, tokens) >= FRONT_MATTER_MATCH_THRESHOLD
    ) {
      removed.titleChars += paragraph.length;
      continue;
    }

    if (isAuthorParagraph(body, creatorTokens)) {
      removed.authorChars += paragraph.length;
      continue;
    }

    if (isAffiliationParagraph(body)) {
      removed.affiliationChars += paragraph.length;
      continue;
    }

    if (KEYWORD_LINE_PATTERN.test(trimmed)) {
      removed.keywordChars += paragraph.length;
      continue;
    }

    if (
      BIBLIOGRAPHIC_LINE_PATTERNS.some((pattern) => pattern.test(trimmed)) ||
      isPatentCoverBlock(trimmed)
    ) {
      removed.bibliographicChars += paragraph.length;
      continue;
    }

    // Nothing claimed this paragraph. If the abstract has already been found,
    // the front matter is over: the abstract is the last thing a record can
    // vouch for, so the first unrecognised paragraph after it is body text.
    // This is what stops the window running on into a patent's claims, and it
    // works for journals that print no `Introduction` heading at all.
    if (matchedAbstract) {
      kept.push(...paragraphs.slice(index));
      break;
    }

    kept.push(paragraph);
  }

  return {
    text: kept.join("\n\n").trim(),
    removed,
    matchedAbstract,
  };
}

/**
 * Whether ONE already-produced chunk should be left out of the keyword index.
 *
 * The chunk boundaries themselves are fixed by the vector index, and this
 * function must not change them — a chunk's number is part of the plugin's
 * public surface (`search_fulltext`, `get_document_chunks`). So a chunk that is
 * entirely reference list or entirely boilerplate is skipped whole, and a chunk
 * that merely contains some is filtered in place by
 * {@link filterBodyForKeywordIndex}.
 */
export function isNonBodyChunk(chunkText: string): boolean {
  const trimmed = chunkText?.trim();
  if (!trimmed) return true;

  if (BOILERPLATE_HEADING_PATTERN.test(trimmed)) {
    // The heading opens this chunk, so the chunk IS the boilerplate section.
    const firstLine = trimmed.split("\n", 1)[0];
    if (BOILERPLATE_HEADING_PATTERN.test(firstLine)) return true;
  }

  const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return true;

  let referenceLines = 0;
  let imageLines = 0;
  for (const line of lines) {
    if (REFERENCE_LINE_PATTERN.test(line)) referenceLines += 1;
    else if (IMAGE_LINE_PATTERN.test(line)) imageLines += 1;
  }
  // Half or more of the substantive lines being citations means this chunk is
  // the bibliography, whatever the extraction did to the heading.
  return (referenceLines + imageLines) / lines.length >= 0.5;
}
