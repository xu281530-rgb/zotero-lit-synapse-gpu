/**
 * `get_attachment_text`: the text of ONE attachment, named by source, served
 * in windows.
 *
 * This replaces the item-level half of the old `get_content`, which took an
 * itemKey and returned the abstract, the notes, every attachment's text and a
 * webpage snapshot fused into one object. Three separate problems came out of
 * that shape:
 *
 *  - The caller could not ask for the PDF without also being handed the notes,
 *    so a model that wanted one paragraph of a paper received the user's own
 *    annotations alongside it and had no reliable way to tell whose words were
 *    whose.
 *  - `extractionMethod` existed but was per-attachment and buried, and the
 *    three genuinely different Markdown reuse paths all reported the same
 *    `mineru_cache`. Text from Doc2X, text reconstructed by MinerU and text
 *    from Zotero's flat full-text index read very differently — tables survive
 *    in the first, are rebuilt in the second and are gone in the third — and a
 *    model quoting a table has no way to know which it got.
 *  - There was no paging at all, only a mode-driven truncation, so `complete`
 *    meant "the entire PDF in one response".
 *
 * The Zotero-facing half lives in `streamableMCPServer`; everything here is
 * pure so the windowing and the source reporting can be tested without Zotero.
 */

/** Characters per window when the caller does not say. */
export const DEFAULT_ATTACHMENT_TEXT_WINDOW = 4000;

/**
 * Hard ceiling per window.
 *
 * A window is a reading unit, not a transfer budget: the point of the cap is
 * that the caller has to decide, after each window, whether the text is still
 * answering the question. Raising it far enough to hold a whole paper would
 * restore exactly the behaviour this tool exists to remove.
 */
export const MAX_ATTACHMENT_TEXT_WINDOW = 20000;

/**
 * How far past the requested cut a window may run to land on a clean break.
 *
 * Small on purpose. Slicing at a fixed character count regularly cuts a word
 * or a formula in half, and a model reading the seam cannot tell a truncation
 * artefact from the source text; extending to the next paragraph or sentence
 * boundary removes that ambiguity. Extending far would let one window quietly
 * grow well past the cap the caller asked for, so the search gives up quickly
 * and cuts at the requested offset when no boundary is near.
 */
export const WINDOW_BOUNDARY_SEARCH_CHARS = 400;

/**
 * Where an attachment's text came from.
 *
 * Ordered best-structure first. The distinction is not cosmetic: it decides
 * what the caller may claim about the text it is quoting.
 */
export type AttachmentTextMethod =
  /** Lossless source Markdown recovered from a Doc2X note. */
  | "doc2x"
  /** A MinerU parse result reused from the shared cache — no parsing. */
  | "mineru_cache"
  /** A Markdown file an earlier MinerU parse attached to the item. */
  | "mineru_attachment"
  /** MinerU parsed the PDF during this call. */
  | "mineru"
  /** A Markdown/text file attached to the item directly. */
  | "markdown_attachment"
  /** Zotero's own extracted full-text index. Flat: no layout, no tables. */
  | "zotero_fulltext_cache"
  /** The bundled PDF worker, used when no Markdown path produced text. */
  | "pdf_processor"
  /** The PDF worker ran out of time. */
  | "pdf_processor_timeout"
  /** An HTML snapshot converted to text. */
  | "html_parsing"
  /** A plain-text attachment read as-is. */
  | "text_reading"
  /** No Markdown and MinerU is switched off. */
  | "mineru_disabled"
  /** No Markdown and on-demand parsing is not allowed by the preference. */
  | "mineru_on_demand_disabled"
  /** MinerU was asked to parse and explicitly failed or refused. */
  | "mineru_failed"
  /** Unexpected error while talking to MinerU. */
  | "mineru_error"
  /** Nothing produced text for this attachment. */
  | "no_text";

/** One sentence per method, stating what the caller may rely on. */
const METHOD_NOTES: Record<AttachmentTextMethod, string> = {
  doc2x:
    "Doc2X source Markdown: the publisher's own structure, so headings, tables and formulas are as close to the original as this plugin gets.",
  mineru_cache:
    "MinerU Markdown reused from the cache — reconstructed layout, not the publisher's own; no parsing ran for this call.",
  mineru_attachment:
    "MinerU Markdown reused from a Markdown file attached to this item — reconstructed layout, not the publisher's own.",
  mineru:
    "MinerU parsed this PDF during this call. Layout, tables and formulas are reconstructed, so treat their exact form as approximate.",
  markdown_attachment:
    "Read from a Markdown or text file attached to this item, as written.",
  zotero_fulltext_cache:
    "Zotero's own extracted full-text index: a flat character stream. Column order, headings, tables and formulas are NOT preserved — never present this as the paper's layout, and never reconstruct a table from it.",
  pdf_processor:
    "Extracted by the bundled PDF worker because no Markdown was available. Reading order is approximate and multi-column pages may interleave.",
  pdf_processor_timeout:
    "The PDF worker timed out before extracting the text. Index this PDF in Zotero, or enable on-demand MinerU parsing, and try again.",
  html_parsing: "Converted from an HTML snapshot; markup was stripped.",
  text_reading: "Read from a plain-text file, as written.",
  mineru_disabled:
    "No text: no Markdown exists for this PDF and MinerU is switched off in the plugin preferences.",
  mineru_on_demand_disabled:
    "No text: no Markdown exists for this PDF and on-demand parsing is not allowed by the current preference.",
  mineru_failed:
    "No text: MinerU was asked to parse this PDF and refused or failed (it may be too large, or a previous failure is still in cooldown).",
  mineru_error: "No text: an unexpected error occurred while calling MinerU.",
  no_text:
    "No text could be produced from this attachment. It may be an image-only scan, an unsupported file type, or a missing file.",
};

/** The explanation shipped alongside every `textSource.method`. */
export function describeTextMethod(method: AttachmentTextMethod): string {
  return METHOD_NOTES[method] ?? METHOD_NOTES.no_text;
}

/** Methods that mean "there is no text here", so the caller stops asking. */
export function isEmptyTextMethod(method: AttachmentTextMethod): boolean {
  return (
    method === "mineru_disabled" ||
    method === "mineru_on_demand_disabled" ||
    method === "mineru_failed" ||
    method === "mineru_error" ||
    method === "pdf_processor_timeout" ||
    method === "no_text"
  );
}

export interface TextWindow {
  text: string;
  offset: number;
  returnedChars: number;
  totalChars: number;
  hasMore: boolean;
  nextOffset?: number;
  /** True when the window was extended to land on a paragraph/sentence break. */
  endsOnBoundary: boolean;
}

/** Clamp a caller's window size into the allowed range. */
export function resolveWindowSize(requested: unknown): number {
  const value = Number(requested);
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_ATTACHMENT_TEXT_WINDOW;
  }
  return Math.min(MAX_ATTACHMENT_TEXT_WINDOW, Math.floor(value));
}

/** Clamp a caller's offset into the text. */
export function resolveOffset(requested: unknown, totalChars: number): number {
  const value = Number(requested);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), totalChars);
}

/**
 * Take one reading window out of `text`, ending on a clean break when one is
 * within reach.
 *
 * The boundary search only ever moves the cut FORWARD, never back. Moving it
 * back would mean a window can return less than the caller asked for while
 * `hasMore` is true, which reads as "the text ran out here" — and a caller
 * that stops on a short window would silently lose the rest of the document.
 */
export function takeTextWindow(
  text: string,
  requestedOffset: unknown,
  requestedLimit: unknown,
): TextWindow {
  const totalChars = text.length;
  const offset = resolveOffset(requestedOffset, totalChars);
  const limit = resolveWindowSize(requestedLimit);

  if (offset >= totalChars) {
    return {
      text: "",
      offset,
      returnedChars: 0,
      totalChars,
      hasMore: false,
      endsOnBoundary: true,
    };
  }

  const softEnd = Math.min(totalChars, offset + limit);
  let end = softEnd;
  let endsOnBoundary = softEnd >= totalChars;

  if (!endsOnBoundary) {
    const searchLimit = Math.min(
      totalChars,
      softEnd + WINDOW_BOUNDARY_SEARCH_CHARS,
    );
    const tail = text.slice(softEnd, searchLimit);
    // A blank line is the strongest break available, so it wins outright.
    const paragraph = tail.search(/\n[ \t]*\n/);
    if (paragraph >= 0) {
      end = softEnd + paragraph + 1;
      endsOnBoundary = true;
    } else {
      // Sentence terminators in both scripts, plus a bare newline as the
      // weakest acceptable break.
      const sentence = tail.search(/[.!?。！？；;]\s|\n/);
      if (sentence >= 0) {
        end = softEnd + sentence + 1;
        endsOnBoundary = true;
      } else if (searchLimit >= totalChars) {
        // The rest of the text is shorter than the search budget and holds no
        // delimiter at all. Taking it is strictly better than cutting inside a
        // word to leave a scrap behind: the end of the text IS a boundary, and
        // the alternative is a final window a few characters long that the
        // caller has to make one more call to collect.
        end = totalChars;
        endsOnBoundary = true;
      }
    }
  }

  const slice = text.slice(offset, end);
  const hasMore = end < totalChars;
  return {
    text: slice,
    offset,
    returnedChars: slice.length,
    totalChars,
    hasMore,
    ...(hasMore ? { nextOffset: end } : {}),
    endsOnBoundary,
  };
}

export interface AttachmentSummary {
  attachmentKey: string;
  title?: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  /** The file type could yield text. Not a claim that we HAVE its text. */
  hasExtractableText: boolean;
  /** A Markdown file this plugin generated from a sibling PDF. */
  isGeneratedMarkdown: boolean;
}

/**
 * Pick the attachment to read when the caller did not name one.
 *
 * Auto-selection happens only when the choice is unambiguous, because reading
 * silently from the wrong attachment produces text that looks perfectly valid
 * and belongs to a different document. Generated Markdown siblings never
 * count: their content duplicates the PDF they came from, so counting them
 * would turn a one-PDF item into an ambiguous two-candidate one.
 */
export function selectAttachment(
  attachments: AttachmentSummary[],
  requestedKey?: string,
):
  | { kind: "selected"; attachment: AttachmentSummary; automatic: boolean }
  | { kind: "not_found"; requestedKey: string }
  | { kind: "choose"; candidates: AttachmentSummary[] }
  | { kind: "none" } {
  if (requestedKey) {
    const found = attachments.find(
      (attachment) => attachment.attachmentKey === requestedKey,
    );
    return found
      ? { kind: "selected", attachment: found, automatic: false }
      : { kind: "not_found", requestedKey };
  }

  const readable = attachments.filter(
    (attachment) =>
      attachment.hasExtractableText && !attachment.isGeneratedMarkdown,
  );
  if (readable.length === 0) return { kind: "none" };
  if (readable.length === 1) {
    return { kind: "selected", attachment: readable[0], automatic: true };
  }
  return { kind: "choose", candidates: readable };
}
