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
