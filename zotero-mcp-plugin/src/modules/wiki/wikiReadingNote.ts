/**
 * The per-paper reading note: a single Markdown document that IS the model's
 * understanding of one paper while it is being read.
 *
 * The problem it solves. Reading a long paper used to be nothing but paging:
 * `wiki_build_from_paper` handed over chunks and the model was left to hold a
 * hundred-and-eighty of them in its head until the end. Two things went wrong
 * every time. The model's notes drifted into a per-page shape - "chunks 0-7:
 * new concepts", "chunks 8-15: new methods" - which is a transcript of the
 * TRANSPORT, not an understanding of the paper; and a context compaction or a
 * dropped connection destroyed everything it had understood, because none of
 * it was written anywhere.
 *
 * So the note is deliberately not a log. A chunk is a unit of delivery and
 * nothing else. After every batch the model rewrites this document as a whole:
 * adding, deleting, merging, moving, correcting. When section 5 overturns what
 * section 2 implied, the sentence written for section 2 is rewritten, not
 * annotated. What the file holds at any moment is one continuous, self-
 * consistent account of the paper - the same shape it would have if the paper
 * had been read in one sitting.
 *
 * Two halves, two owners:
 *
 *   - The machine block at the top belongs to the PROGRAM. Paper key, title,
 *     abstract, expert, chunk progress, coverage, status, timestamp. The model
 *     never writes it; it is regenerated from the reading-session ledger on
 *     every save, so it cannot drift from the database and cannot be talked
 *     into saying the paper was finished.
 *   - Everything after the block belongs to the MODEL. No template is imposed:
 *     a method paper and a review need different shapes, and forcing headings
 *     is how a full method chain gets compressed into a heading that says
 *     "Methods".
 *
 * The file lives as a Markdown attachment on the Zotero item itself, so it
 * survives a Zotero restart, an MCP disconnect and a compaction, and so a
 * person can read it. It is written atomically (temp file, then rename) - a
 * crash mid-write leaves the previous version intact rather than a half
 * document, which for a document that is only ever rewritten in full is the
 * difference between losing one batch and losing the whole read.
 *
 * It is NOT evidence. Evidence is still an excerpt verified against a real
 * indexed chunk of the real paper; see WikiService.hydrateEvidence, which
 * refuses an excerpt that cannot be found in the source. This document is the
 * reading memory that decides WHAT to claim, never the proof of it.
 */

declare const IOUtils: any;
declare const PathUtils: any;
declare let Zotero: any;
declare let ztoolkit: ZToolkit;

import { citedChunkIds, splitNoteBlocks } from "./wikiSynthesisAudit";

export const WIKI_READING_NOTE_SCHEMA = 1;

/**
 * Attachment title prefix. Also the first half of the indexing exclusion: a
 * reading note is a paraphrase of the paper it hangs on, so indexing it would
 * feed the model's own summary back into retrieval as if it were the source.
 */
export const WIKI_READING_NOTE_TITLE_PREFIX = "Wiki Reading Note";

/** Filename prefix. The other half of the exclusion, and harder to rename. */
export const WIKI_READING_NOTE_FILENAME_PREFIX = "zotero-mcp-reading-note-";

const BLOCK_OPEN =
  "<!-- ZOTERO-MCP-WIKI-READING-NOTE: machine-maintained, do not edit -->";
const BLOCK_CLOSE = "<!-- /ZOTERO-MCP-WIKI-READING-NOTE -->";

/**
 * The standing instruction attached to every expert profile, written by the
 * server rather than by the model.
 *
 * An expert persona focuses attention, and focused attention is exactly what
 * produces confirmation bias: a model told to watch for solidification
 * parameters will come back with solidification parameters and will not
 * mention that the paper's real contribution was a calibration method. The
 * model proposes the focus; this sentence, which it cannot edit or omit, keeps
 * the focus from becoming a filter.
 */
export const WIKI_EXPERT_OPEN_SCOPE_MANDATE =
  "Standing mandate (server-imposed, not editable): the focus areas above set " +
  "priority, never scope. Anything this paper establishes that falls outside " +
  "them - an unexpected method, a negative result, a boundary condition, a " +
  "contribution in another subfield - must be captured in the note with the " +
  "same care as the focus areas, and flagged as outside the initial focus. " +
  "A note that only ever confirms the initial focus is a failed reading.";

export interface WikiReadingExpert {
  /** Who is reading this paper, in this paper's own field. */
  persona: string;
  /** What this paper in particular makes worth watching for. */
  focus: string[];
  /** Server-owned; see WIKI_EXPERT_OPEN_SCOPE_MANDATE. */
  openScopeMandate: string;
  createdAt: number;
  /**
   * Derived from a retrieval call's `domain` and `expertRole` rather than
   * written deliberately.
   *
   * A question-driven read needs a reader - the note is written by someone -
   * but it cannot be worth an extra round trip per question to compose one,
   * and the retrieval call has already declared a field and a perspective
   * fitted to this paper. So one is assembled from those and marked
   * provisional, which means exactly one thing: `wiki_set_reading_expert` may
   * still replace it. A profile written properly, before a full-text read of
   * the whole paper, is the considered one, and the full-text pass still asks
   * for it even on a paper questions have already been asking about.
   */
  provisional?: boolean;
}

export type WikiReadingNoteStatus =
  | "awaiting_expert"
  | "reading"
  | "synthesized"
  | "completed"
  | "skipped"
  | "failed";

export interface WikiReadingNoteMetadata {
  schema: number;
  paperKey: string;
  libraryID: number;
  title: string;
  abstract: string;
  expert: WikiReadingExpert | null;
  /** Compact ranges of chunk indexes actually read, e.g. "0-7,12-19". */
  readChunks: string;
  /**
   * The same fact as a picture: one cell per chunk, filled where it has been
   * read.
   *
   * `readChunks` is exact and `coverage` is countable, but neither answers the
   * question a person actually has when they open this file - "how much of
   * this paper has been read, and is it the front of it or scattered through
   * it?" - at a glance. A question-driven read produces coverage like
   * `{7,8,42,70}`, which reads as "0-7,42,70" and means nothing until it is
   * drawn.
   */
  coverageMap: string;
  /** How this reading is being done: a full-text pass, or questions. */
  mode: "fulltext" | "qa";
  totalChunks: number;
  /** Where reading resumes. null once every chunk has been delivered. */
  nextChunk: number | null;
  coverage: {
    deliveredChunks: number;
    totalChunks: number;
    complete: boolean;
    /** Delivered chunks the model has folded into this document. */
    integratedChunks: number;
    /** The whole-document rewrite done after the last chunk. */
    finalSynthesis: boolean;
  };
  status: WikiReadingNoteStatus;
  updatedAt: string;
}

/** Collapse delivered chunk indexes into "0-7,12-19". */
export function formatChunkRanges(indexes: readonly number[]): string {
  const sorted = [...new Set(indexes.map((n) => Math.floor(n)))].sort(
    (a, b) => a - b,
  );
  const parts: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;
  for (const index of sorted) {
    if (start === null) {
      start = index;
      previous = index;
      continue;
    }
    if (index === (previous as number) + 1) {
      previous = index;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = index;
    previous = index;
  }
  if (start !== null) {
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  }
  return parts.join(",");
}

export const WIKI_READING_RECORDS_HEADING = "## 阅读记录";
export const WIKI_MACRO_SUMMARY_HEADING = "## 宏观总结";

export interface WikiReadingRecord {
  number: number;
  chunkIds: number[];
  content: string;
  noNewContent: boolean;
}

export interface WikiAppendOnlyReadingNote {
  legacyBody: string;
  records: WikiReadingRecord[];
  macroSummary: string | null;
  appendOnly: boolean;
}

const READING_RECORD_HEADING =
  /^###\s+第\s*(\d+)\s*次\s*·\s*chunk\s+([^\r\n]+)\s*$/gimu;
const NO_NEW_CONTENT =
  /(?:本次|此次|这一批|本批).*无新(?:内容|信息|发现)|no new (?:content|information|findings?)/iu;

function parseChunkRanges(value: string): number[] {
  const ids: number[] = [];
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    const range = /^(\d+)\s*-\s*(\d+)$/u.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end < start || end - start > 100_000) continue;
      for (let id = start; id <= end; id += 1) ids.push(id);
      continue;
    }
    if (/^\d+$/u.test(part)) ids.push(Number(part));
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

function sectionStart(body: string, heading: string): number {
  const pattern = new RegExp(
    `^${heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`,
    "mu",
  );
  const match = pattern.exec(body);
  return match?.index ?? -1;
}

/** Parse the server-owned append-only sections while leaving legacy prose alone. */
export function parseAppendOnlyReadingNote(
  body: string,
): WikiAppendOnlyReadingNote {
  const text = String(body ?? "").trim();
  const recordsStart = sectionStart(text, WIKI_READING_RECORDS_HEADING);
  if (recordsStart === -1) {
    return {
      legacyBody: text,
      records: [],
      macroSummary: null,
      appendOnly: false,
    };
  }

  const legacyPrefix = text.slice(0, recordsStart).trimEnd();
  const legacyBody = legacyPrefix.replace(/\n\s*-{3,}\s*$/u, "").trimEnd();
  const afterRecordsHeading =
    recordsStart + WIKI_READING_RECORDS_HEADING.length;
  const summaryRelative = sectionStart(
    text.slice(afterRecordsHeading),
    WIKI_MACRO_SUMMARY_HEADING,
  );
  const summaryStart =
    summaryRelative === -1 ? -1 : afterRecordsHeading + summaryRelative;
  const recordsText = text.slice(
    afterRecordsHeading,
    summaryStart === -1 ? text.length : summaryStart,
  );
  const matches = [...recordsText.matchAll(READING_RECORD_HEADING)];
  const records = matches.map((match, index) => {
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? recordsText.length)
        : recordsText.length;
    const content = recordsText
      .slice(contentStart, contentEnd)
      .replace(/\n\s*-{3,}\s*$/u, "")
      .trim();
    return {
      number: Number(match[1]),
      chunkIds: parseChunkRanges(match[2]),
      content,
      noNewContent: NO_NEW_CONTENT.test(content),
    };
  });
  const macroSummary =
    summaryStart === -1
      ? null
      : text.slice(summaryStart + WIKI_MACRO_SUMMARY_HEADING.length).trim();
  return { legacyBody, records, macroSummary, appendOnly: true };
}

function assertAppendPayload(content: string, kind: string): string {
  const clean = String(content ?? "").trim();
  if (!clean) throw new Error(`${kind} is required and cannot be empty.`);
  if (
    sectionStart(clean, WIKI_READING_RECORDS_HEADING) !== -1 ||
    sectionStart(clean, WIKI_MACRO_SUMMARY_HEADING) !== -1 ||
    /^###\s+第\s*\d+\s*次\s*·/mu.test(clean)
  ) {
    throw new Error(
      `${kind} contains a server-owned reading-note heading. Send only this turn's content; ` +
        "the server numbers records and writes the section structure.",
    );
  }
  return clean;
}

/** Append one immutable reading record, preserving every earlier byte of body text. */
export function appendReadingRecord(
  body: string,
  input: { chunkIds: readonly number[]; content: string },
): string {
  const previous = String(body ?? "").trim();
  const parsed = parseAppendOnlyReadingNote(previous);
  if (parsed.macroSummary !== null) {
    throw new Error(
      "This reading note already has a macro summary, so no reading record can be inserted after it.",
    );
  }
  const chunkIds = [...new Set(input.chunkIds.map(Number))]
    .filter((id) => Number.isInteger(id) && id >= 0)
    .sort((a, b) => a - b);
  if (!chunkIds.length) {
    throw new Error(
      "A reading record must name the chunk ids read in this turn, including a no-new-content record.",
    );
  }
  const content = assertAppendPayload(input.content, "readingRecord");
  const entry = [
    `### 第 ${parsed.records.length + 1} 次 · chunk ${formatChunkRanges(chunkIds)}`,
    content,
  ].join("\n");
  if (parsed.appendOnly) return `${previous}\n\n${entry}`;
  if (!previous) return `${WIKI_READING_RECORDS_HEADING}\n\n${entry}`;
  return `${previous}\n\n---\n\n${WIKI_READING_RECORDS_HEADING}\n\n${entry}`;
}

/** Append the one macro summary after all immutable reading records. */
export function appendMacroSummary(body: string, summary: string): string {
  const previous = String(body ?? "").trim();
  const parsed = parseAppendOnlyReadingNote(previous);
  if (!parsed.appendOnly || !parsed.records.length) {
    throw new Error(
      "A macro summary requires at least one append-only reading record.",
    );
  }
  if (parsed.macroSummary !== null) {
    throw new Error("This reading note already has a macro summary.");
  }
  const content = assertAppendPayload(summary, "macroSummary");
  return `${previous}\n\n---\n\n${WIKI_MACRO_SUMMARY_HEADING}\n\n${content}`;
}

/**
 * Every substantive record must remain traceable from the macro summary.
 *
 * Citation coverage is deliberately mechanical: semantic similarity would
 * accept increase/decrease paraphrases as nearly identical. A no-new-content
 * record carries no finding and is therefore exempt.
 */
export function assertMacroSummaryCoversRecords(
  body: string,
  summary: string,
): void {
  const parsed = parseAppendOnlyReadingNote(body);
  const summaryChunks = new Set(citedChunkIds(String(summary ?? "")));
  const uncovered = parsed.records.filter(
    (record) =>
      !record.noNewContent &&
      record.chunkIds.some((chunkId) => !summaryChunks.has(chunkId)),
  );
  if (!uncovered.length) return;
  throw new Error(
    "The macro summary does not account for reading record(s) " +
      uncovered.map((record) => `第 ${record.number} 次`).join(", ") +
      ". Preserve their findings in the summary and cite the chunks that carry them; length is not a coverage test.",
  );
}

/**
 * Widest coverage bar drawn one-cell-per-chunk.
 *
 * Beyond this a bar would wrap in any reader, so cells start standing for
 * several chunks each and a third, half-filled state appears for a cell whose
 * span is partly read. Under the cap every cell is exactly one chunk and the
 * bar is strictly filled-or-empty.
 */
export const WIKI_COVERAGE_MAP_CELLS = 100;

/**
 * Draw the read/unread map: filled square read, hollow square unread.
 *
 * @param delivered chunk indexes actually read, in any order, duplicates fine
 * @param totalChunks the document's chunk count
 */
export function formatCoverageMap(
  delivered: readonly number[],
  totalChunks: number,
): string {
  const total = Math.max(0, Math.floor(totalChunks));
  if (!total) return "";
  const read = new Set(delivered.map((n) => Math.floor(n)));
  if (total <= WIKI_COVERAGE_MAP_CELLS) {
    let bar = "";
    for (let index = 0; index < total; index += 1) {
      bar += read.has(index) ? "\u25a0" : "\u25a1";
    }
    return bar;
  }
  const cells = WIKI_COVERAGE_MAP_CELLS;
  let bar = "";
  for (let cell = 0; cell < cells; cell += 1) {
    const start = Math.floor((cell * total) / cells);
    const end = Math.floor(((cell + 1) * total) / cells);
    let hits = 0;
    for (let index = start; index < end; index += 1) {
      if (read.has(index)) hits += 1;
    }
    const span = Math.max(1, end - start);
    bar += hits === 0 ? "\u25a1" : hits >= span ? "\u25a0" : "\u25e7";
  }
  return bar;
}

/**
 * Chunk citations in the model's half of the note.
 *
 * The note is reading memory, never evidence, so every fact it carries has to
 * name the chunk it came from or the trail back to the source is lost - and a
 * fact whose source cannot be found again is a fact that cannot become
 * Evidence. Matched in PROSE, not in headings: a heading that says "chunk 12"
 * is a page log and is refused by `assertHolisticBody` a few lines below, so
 * the two rules pull in opposite directions on purpose. `(chunk 42)` after a
 * measured value is what this is asking for.
 */
const CHUNK_CITATION =
  /(?:chunks?|\u5757|\u6bb5)\s*#?\s*\d+|#\s*chunks?\s*\d+|\u7b2c\s*\d+\s*(?:\u5757|\u6bb5)/iu;

export class WikiReadingNoteCitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiReadingNoteCitationError";
  }
}

/**
 * Refuse a note that records reading without recording where it came from.
 *
 * @throws WikiReadingNoteCitationError
 */
export function assertChunkCitations(body: string): void {
  if (CHUNK_CITATION.test(String(body ?? ""))) return;
  throw new WikiReadingNoteCitationError(
    "The reading note cites no chunk. Every fact, parameter, result and figure in it has to name the " +
      "chunk it came from - write the number in the prose, like \"the melt-pool depth reaches 1.2 mm " +
      "(chunk 42)\" - because this note is reading memory and never evidence: a Claim built on it still " +
      "has to quote the paper's own chunk, and without the number that chunk cannot be found again. " +
      "Put the citations in the TEXT, never in a heading: a heading naming chunks is a page log and is " +
      "refused separately.",
  );
}

/**
 * A prose block long enough that it is carrying something, rather than
 * introducing the thing that follows it.
 *
 * The rule below refuses an uncited block of this length. The threshold is
 * what separates "For example:" and "Two issues constrain reconstruction:" -
 * connective lines that cite nothing because they assert nothing - from a
 * paragraph or a bullet that states a finding. Set low enough that a single
 * substantive sentence is caught, high enough that a section's opening clause
 * is not.
 *
 * Stated per script, because "a single substantive sentence" is a different
 * number of characters in each. A Chinese sentence states a finding in twenty
 * or thirty characters, so one count for both scripts meant a Chinese
 * paragraph of three or four such sentences - a real chunk of the paper's
 * argument - stayed under the English threshold and could carry no chunk
 * number at all. The blocks that generalise across a paper are exactly the
 * ones this rule exists to keep tethered, and in a bilingual library they were
 * tethered in one language only.
 */
export const WIKI_NOTE_UNCITED_BLOCK_CHARS = 120;

/** The same threshold for a block containing Han characters. */
export const WIKI_NOTE_UNCITED_BLOCK_CHARS_CJK = 50;

const HAN_CHARACTER = /\p{Script=Han}/u;

/** How long an uncited block of THIS text may be before it is refused. */
export function uncitedBlockLimit(text: string): number {
  return HAN_CHARACTER.test(text)
    ? WIKI_NOTE_UNCITED_BLOCK_CHARS_CJK
    : WIKI_NOTE_UNCITED_BLOCK_CHARS;
}

/**
 * Every chunk number in the note has to be one this paper actually has, and
 * one this reading has actually been given.
 *
 * The old rule accepted a note the moment ANY chunk number appeared anywhere
 * in it, which made the citation a formality: a paper of 53 chunks could carry
 * `(chunk 91)`, or hang a conclusion on a chunk that had not been delivered
 * yet, and the trail back to the source - the entire point of the number -
 * pointed nowhere. Nothing here reads the chunk's text or judges support; it
 * only refuses a citation that cannot be resolved at all.
 *
 * `allowedChunkIds` is what has been DELIVERED, not what exists. A note
 * written half way through a paper cites what it has been shown, and a number
 * from the half it has not seen is either a typo or an invention.
 *
 * @throws WikiReadingNoteCitationError
 */
export function assertChunkCitationsResolvable(
  body: string,
  options: { allowedChunkIds: Iterable<number>; totalChunks: number },
): void {
  const allowed = new Set<number>();
  for (const id of options.allowedChunkIds) allowed.add(Math.floor(id));
  const cited = citedChunkIds(String(body ?? ""));
  const unknown = cited.filter((id) => !allowed.has(id));
  if (!unknown.length) return;
  const beyond = unknown.filter((id) => id >= options.totalChunks);
  const undelivered = unknown.filter((id) => id < options.totalChunks);
  const parts: string[] = [
    `The note cites chunk(s) ${unknown.join(", ")}, which this reading cannot resolve.`,
  ];
  if (beyond.length) {
    parts.push(
      `Chunk(s) ${beyond.join(", ")} do not exist: this paper is indexed as ${options.totalChunks} chunk(s), numbered 0 to ${options.totalChunks - 1}.`,
    );
  }
  if (undelivered.length) {
    parts.push(
      `Chunk(s) ${undelivered.join(", ")} exist but have not been delivered to this reading yet, so nothing in the note can have come from them. Read them first, or cite the chunk the fact actually came from.`,
    );
  }
  parts.push(
    "A chunk number is the trail back to the source; one that resolves to nothing is worse than none, " +
      "because a Claim will later be built on it and its Evidence will be quoted from the wrong passage.",
  );
  throw new WikiReadingNoteCitationError(parts.join(" "));
}

/**
 * Refuse a substantive paragraph or bullet that names no chunk.
 *
 * The note's contract has always been that every fact carries its chunk
 * number. Checked once per document, that contract was satisfiable by one
 * citation in fifty paragraphs - and that is exactly the shape a drifting
 * synthesis has: the passages that quote a measurement keep their numbers,
 * and the paragraphs that generalise across the paper quietly lose them.
 * Those generalising paragraphs are the ones that need the trail most.
 *
 * Headings, block quotes, tables and fenced code are exempt: a heading naming
 * a chunk is a page log and is refused by `assertHolisticBody`, so requiring
 * one here would make the two rules unsatisfiable together.
 *
 * @throws WikiReadingNoteCitationError naming the blocks, because the model
 *   has to fix them without being able to ask which ones.
 */
export function assertBlockCitations(body: string): void {
  const uncited = splitNoteBlocks(String(body ?? ""))
    .filter((block) => block.prose)
    .filter((block) => block.text.length >= uncitedBlockLimit(block.text))
    .filter((block) => citedChunkIds(block.text).length === 0);
  if (!uncited.length) return;
  const shown = uncited
    .slice(0, 6)
    .map(
      (block) =>
        `line ${block.line}: "${block.text.slice(0, 110)}${block.text.length > 110 ? "..." : ""}"`,
    );
  throw new WikiReadingNoteCitationError(
    `${uncited.length} paragraph(s) or bullet(s) in the note state something substantial without naming ` +
      "a chunk. Every block that carries a fact, a parameter, a result, a mechanism or a conclusion has " +
      "to name the chunk it came from, written in the prose - not once per document, once per block. A " +
      "generalisation drawn across several chunks names all of them, and each one has to hold the claim " +
      "on its own; if one of them only shares the topic, leave it out and make the sentence smaller. " +
      `Uncited block(s): ${shown.join(" | ")}` +
      (uncited.length > shown.length
        ? ` (and ${uncited.length - shown.length} more)`
        : ""),
  );
}

/**
 * Headings that describe the DELIVERY rather than the paper.
 *
 * This is the one structural rule imposed on the model's half of the document,
 * and it exists because the failure it catches is the default behaviour: asked
 * to update a summary after a batch of chunks, a model appends "New in chunks
 * 8-15" and calls it an update. That document can never become a reading of
 * the paper, because its skeleton is the page boundary. Rejecting it at the
 * write, with the reason, is the only point where it can still be fixed
 * cheaply.
 *
 * Deliberately narrow: it matches HEADINGS and standalone emphasised lines,
 * never prose. A sentence that says "the chunk boundary split table 3" is a
 * legitimate observation and passes.
 */
const DELIVERY_SHAPED_LINE: readonly RegExp[] = [
  /\bchunks?\s*#?\s*\d/i,
  /\bpages?\s*\d+\s*(?:[-–—]|to)\s*\d+/i,
  /\bbatch\s*#?\s*\d/i,
  /第\s*\d+\s*(?:页|批|块|轮|段)/,
  /(?:本页|本批|本轮|本次|这一页|这一批|该批)\s*(?:新增|新知识|要点|内容|小结|总结|阅读)/,
  /(?:新增知识|增量知识|增量小结|分页笔记|分批笔记|阅读日志|本页笔记)/,
  /\b(?:new|newly\s+added|added|updates?|updated)\b[^\n]{0,48}\b(?:in|from)\s+(?:this|these|the\s+current|the\s+latest)\s+(?:page|pages|batch|batches|chunk|chunks|delivery|round|pass)\b/i,
  /\b(?:incremental|per-page|per-batch|running)\s+(?:notes?|summary|summaries|update|log)\b/i,
];

function structuralLineText(line: string): string | null {
  const heading = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/u.exec(line);
  if (heading) return heading[1];
  const emphasised = /^\s{0,3}\*\*(.+?)\*\*\s*[:：]?\s*$/u.exec(line);
  if (emphasised) return emphasised[1];
  const listHeading = /^\s{0,3}[-*+]\s+\*\*(.+?)\*\*\s*[:：]?\s*$/u.exec(
    line,
  );
  if (listHeading) return listHeading[1];
  return null;
}

export class WikiReadingNoteShapeError extends Error {
  readonly offendingLines: string[];

  constructor(message: string, offendingLines: string[]) {
    super(message);
    this.name = "WikiReadingNoteShapeError";
    this.offendingLines = offendingLines;
  }
}

/**
 * Refuse a note organised by delivery batch instead of by the paper.
 *
 * @throws WikiReadingNoteShapeError naming the lines, because the model has to
 *   fix them without being able to ask what was wrong.
 */
export function assertHolisticBody(body: string): void {
  const offending: string[] = [];
  let inFence = false;
  for (const rawLine of String(body ?? "").split(/\r?\n/u)) {
    if (/^\s{0,3}(?:`{3,}|~{3,})/u.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const structural = structuralLineText(rawLine);
    if (!structural) continue;
    if (DELIVERY_SHAPED_LINE.some((pattern) => pattern.test(structural))) {
      offending.push(rawLine.trim());
    }
  }
  if (!offending.length) return;
  throw new WikiReadingNoteShapeError(
    "The reading note is organised by delivery batch, not by the paper. " +
      "Chunks are how the text is transported; they are not a way to organise " +
      "knowledge. Rewrite these section headings so the document reads as one " +
      "continuous account of the paper - research question, materials, method " +
      "chain, model and parameters, conditions, results, mechanism, validation, " +
      "contribution, limits - with the new material merged into whichever " +
      "section it belongs to, and nothing left saying which page it arrived on. " +
      `Offending heading(s): ${offending.slice(0, 6).join(" | ")}`,
    offending,
  );
}

/** The model's half of the document, with any machine block removed. */
export function stripMachineBlock(markdown: string): string {
  const text = String(markdown ?? "");
  const open = text.indexOf(BLOCK_OPEN);
  if (open === -1) return text.trim();
  const close = text.indexOf(BLOCK_CLOSE, open);
  if (close === -1) return text.slice(open + BLOCK_OPEN.length).trim();
  const rest = text.slice(close + BLOCK_CLOSE.length);
  // Everything the SERVER renders between the machine block and the model's
  // document - the expert brief, the coverage map, and the rule that closes
  // them off - is regenerated on every save and is not part of the body.
  //
  // Cut at the rule rather than by walking quote lines. The walk worked while
  // there was exactly one quoted paragraph; the coverage map made it two,
  // separated by a blank line, and a blank line ends the walk - so half the
  // server's own preamble started coming back as though the model had written
  // it. Every rendered note has the rule, so finding it is exact, and it moves
  // whenever the preamble grows again. The quote-walk stays as the fallback
  // for a file written before the rule existed.
  const afterBrief = stripServerPreamble(rest);
  return (text.slice(0, open) + afterBrief).trim();
}

/** Drop the server-rendered preamble that follows the machine block. */
function stripServerPreamble(rest: string): string {
  const lines = rest.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^-{3,}$/u.test(line)) return lines.slice(index + 1).join("\n");
    // Anything that is not blank, not quoted and not the rule is already the
    // model's document: this file predates the rule, so nothing is dropped.
    if (!line.startsWith(">")) break;
  }
  return rest.replace(/^\s*(?:>[^\n]*\n?)*\s*/u, "");
}

/** Read back the machine block. Returns null when the file has none. */
export function parseMachineBlock(
  markdown: string,
): WikiReadingNoteMetadata | null {
  const text = String(markdown ?? "");
  const open = text.indexOf(BLOCK_OPEN);
  if (open === -1) return null;
  const close = text.indexOf(BLOCK_CLOSE, open);
  if (close === -1) return null;
  const inner = text.slice(open + BLOCK_OPEN.length, close);
  const fenced = /`{3}json\s*([\s\S]*?)`{3}/u.exec(inner);
  if (!fenced) return null;
  try {
    return JSON.parse(fenced[1]) as WikiReadingNoteMetadata;
  } catch {
    return null;
  }
}

export function parseReadingNote(markdown: string): {
  metadata: WikiReadingNoteMetadata | null;
  body: string;
} {
  return {
    metadata: parseMachineBlock(markdown),
    body: stripMachineBlock(markdown),
  };
}

/** Compose the file: machine block, then the model's document. */
export function renderReadingNote(
  metadata: WikiReadingNoteMetadata,
  body: string,
): string {
  const coverageLine = metadata.totalChunks
    ? [
        `> **Reading coverage:** \`${metadata.coverageMap}\``,
        `> ${metadata.coverage.deliveredChunks} of ${metadata.totalChunks} chunks read` +
          ` (\u25a0 read, \u25a1 unread` +
          (metadata.totalChunks > WIKI_COVERAGE_MAP_CELLS
            ? `, \u25e7 partly read \u2014 one cell spans several chunks in a document this long`
            : "") +
          `). Read: ${metadata.readChunks || "none"}.` +
          (metadata.mode === "qa"
            ? " Read so far by answering questions, not by a full-text pass."
            : ""),
      ].join("\n>\n")
    : "";
  const expertBrief = metadata.expert
    ? [
        `> **Reading as:** ${metadata.expert.persona}`,
        `> **Priority focus:** ${metadata.expert.focus.join("; ")}`,
        `> **${metadata.expert.openScopeMandate}**`,
      ].join("\n>\n")
    : "> No expert profile yet: the body text has not been opened.";
  return [
    BLOCK_OPEN,
    "",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    "",
    BLOCK_CLOSE,
    "",
    expertBrief,
    ...(coverageLine ? ["", coverageLine] : []),
    "",
    "---",
    "",
    stripMachineBlock(body),
    "",
  ].join("\n");
}

/**
 * Is this attachment a reading note?
 *
 * Load-bearing for indexing: `extractItemContent` classifies any `.md` child
 * as a body source, so without this test a paper's own index would be built
 * partly from the model's summary of that paper - the summary would be
 * retrievable as if it were the paper's text, and every rewrite would change
 * the item's newest attachment mtime and force a full re-index of the item on
 * every batch. Both halves of the identity are checked, so renaming the
 * attachment in Zotero's UI does not silently re-enable indexing.
 */
export function isWikiReadingNoteAttachment(attachment: any): boolean {
  try {
    if (!attachment?.isAttachment?.()) return false;
    const title = String(attachment.getField?.("title") ?? "");
    if (title.startsWith(WIKI_READING_NOTE_TITLE_PREFIX)) return true;
    const filename = String(
      attachment.attachmentFilename ?? attachment.getFilePath?.() ?? "",
    );
    const base = filename.split(/[\\/]/u).pop() ?? "";
    return base.startsWith(WIKI_READING_NOTE_FILENAME_PREFIX);
  } catch {
    return false;
  }
}

export function readingNoteAttachmentTitle(itemKey: string): string {
  return `${WIKI_READING_NOTE_TITLE_PREFIX} (${itemKey}).md`;
}

export function readingNoteFileName(itemKey: string): string {
  return `${WIKI_READING_NOTE_FILENAME_PREFIX}${itemKey}.md`;
}

/**
 * The Zotero side: find, create and rewrite the note attachment.
 *
 * Every method takes the parent item rather than looking it up, so the service
 * resolves a paper once and this class never has to guess which library it is
 * in.
 */
export class WikiReadingNoteStore {
  /** The note attachment on this item, by identity rather than by key. */
  async findAttachment(item: any): Promise<any | null> {
    const ids: number[] = item?.getAttachments?.() ?? [];
    for (const id of ids) {
      try {
        const attachment = await Zotero.Items.getAsync(id);
        if (attachment && isWikiReadingNoteAttachment(attachment)) {
          return attachment;
        }
      } catch {
        // A broken child attachment is not a reason to lose the note.
      }
    }
    return null;
  }

  async getByKey(
    libraryID: number,
    attachmentKey: string,
  ): Promise<any | null> {
    if (!attachmentKey) return null;
    try {
      const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
        libraryID,
        attachmentKey,
      );
      return attachment && isWikiReadingNoteAttachment(attachment)
        ? attachment
        : null;
    } catch {
      return null;
    }
  }

  /** The whole file, or null when it is missing or unreadable. */
  async read(attachment: any): Promise<string | null> {
    try {
      const filePath = await this.filePath(attachment);
      if (!filePath) return null;
      return await IOUtils.readUTF8(filePath);
    } catch (error) {
      ztoolkit?.log?.(
        `[WikiReadingNote] could not read ${attachment?.key}: ${error}`,
        "warn",
      );
      return null;
    }
  }

  private async filePath(attachment: any): Promise<string | null> {
    const viaAsync = await attachment?.getFilePathAsync?.();
    if (viaAsync) return String(viaAsync);
    const viaSync = attachment?.getFilePath?.();
    return viaSync ? String(viaSync) : null;
  }

  /**
   * Replace the file's contents atomically.
   *
   * The document is only ever rewritten in full, so a torn write is not a
   * partially updated note - it is an unparseable one, and the whole read is
   * lost with it. Writing beside the file and renaming makes the previous
   * version the worst case.
   */
  async write(attachment: any, markdown: string): Promise<void> {
    const filePath = await this.filePath(attachment);
    if (!filePath) {
      throw new Error(
        `Reading note attachment ${attachment?.key} has no file on disk`,
      );
    }
    await IOUtils.writeUTF8(filePath, markdown, {
      tmpPath: `${filePath}.tmp`,
    });
    // Zotero keeps a stored hash for sync; a file changed underneath it
    // otherwise looks unmodified. Best effort only: a sync-bookkeeping failure
    // must not discard a write that already landed.
    try {
      const toUpload = Zotero?.Sync?.Storage?.Local?.SYNC_STATE_TO_UPLOAD;
      if (toUpload !== undefined && attachment) {
        attachment.attachmentSyncState = toUpload;
        await attachment.saveTx?.({ skipDateModifiedUpdate: true });
      }
    } catch (error) {
      ztoolkit?.log?.(
        `[WikiReadingNote] sync state update failed for ${attachment?.key}: ${error}`,
        "warn",
      );
    }
  }

  /**
   * The note attachment for this paper, created on first use.
   *
   * Re-reading a paper reuses the note that is already there: these are kept
   * permanently, so the note is this paper's long-term reading memory and a
   * second pass continues it rather than starting from a blank page.
   */
  async ensureAttachment(item: any, initialMarkdown: string): Promise<any> {
    const existing = await this.findAttachment(item);
    if (existing) return existing;
    const stagingDir = PathUtils.join(
      Zotero.DataDirectory.dir,
      "zotero-mcp",
      "wiki-reading-notes",
    );
    await IOUtils.makeDirectory(stagingDir, {
      ignoreExisting: true,
      createAncestors: true,
    });
    const stagingPath = PathUtils.join(
      stagingDir,
      readingNoteFileName(item.key),
    );
    await IOUtils.writeUTF8(stagingPath, initialMarkdown, {
      tmpPath: `${stagingPath}.tmp`,
    });
    const imported = await Zotero.Attachments.importFromFile({
      file: stagingPath,
      parentItemID: item.id,
      title: readingNoteAttachmentTitle(item.key),
      contentType: "text/markdown",
      charset: "utf-8",
    });
    try {
      await IOUtils.remove(stagingPath, { ignoreAbsent: true });
    } catch {
      // A leftover staging file is harmless.
    }
    return imported;
  }
}
