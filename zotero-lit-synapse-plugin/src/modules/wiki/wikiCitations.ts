export interface WikiCitationGroup {
  start: number;
  end: number;
  chunkIds: number[];
}

export const WIKI_CITATION_GUIDE =
  "Cite chunk addresses as (chunk 12), [chunk:12], or (chunks 12-14, 18). " +
  "Put citations before the sentence's final punctuation. A bracketed citation immediately after a sentence stop belongs to that sentence when it has no citation yet. " +
  "Use a new paragraph for a leading citation when the previous sentence is uncited. Ranges must be ascending; every cited chunk must have been read. " +
  "A bracket that opens with an address may also carry your own words - (chunk 43, 呼应 chunk 2 的存疑) is read as citing 43 and 2 - but it must contain at least one address the server can parse, so write the number, never a word for it.";

/** Shared addresses for coverage, source validation and sentence audits. */
export function parseWikiCitations(text: string): WikiCitationGroup[] {
  const input = String(text ?? "");
  const pattern =
    /(?:\bchunks?|块|段)\s*[:：#]?\s*(\d+(?:\s*(?:[-–—]|to|~|、|,|，)\s*\d+)*)|第\s*(\d+)\s*(?:块|段)/giu;
  const groups: WikiCitationGroup[] = [];
  for (const match of input.matchAll(pattern)) {
    const chunkIds = new Set<number>();
    for (const part of (match[1] ?? match[2]).split(/\s*(?:、|,|，)\s*/u)) {
      const ends = part.split(/\s*(?:[-–—]|to|~)\s*/iu).map(Number);
      const first = ends[0];
      const last = ends.at(-1)!;
      if (
        ends.length > 2 ||
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(last) ||
        last < first ||
        last - first > 10000
      ) {
        throw new Error(
          `Invalid chunk range: ${part}. Use an ascending range of at most 10001 chunks.`,
        );
      }
      for (let id = first; id <= last; id++) chunkIds.add(id);
    }
    groups.push({
      start: match.index!,
      end: match.index! + match[0].length,
      chunkIds: [...chunkIds],
    });
  }
  return groups;
}

/**
 * Parentheticals that OPEN with a chunk address but do not carry one.
 *
 * The rule used to be that such a bracket may contain NOTHING but addresses and
 * commas, so a note writing
 *
 *     （chunk 43，呼应第一批记录中 chunk 2 的存疑）
 *
 * was refused - every address in it parses, and the prose between them is the
 * writer saying something true about their own reading. There is no ambiguity
 * to protect against: the addresses are read by {@link parseWikiCitations},
 * which finds them wherever they sit, and whether they were really delivered is
 * a separate check that still runs. All the strictness bought was a refusal on
 * the first attempt for a shape nobody had been warned about.
 *
 * What remains worth catching is a bracket that ANNOUNCES an address and then
 * fails to give one - `(chunk twelve)`, `(chunks 14-)`, `(chunk )`. Those are
 * citations the reader meant to make and the server cannot resolve, and they
 * would otherwise pass silently as decoration.
 */
export function invalidWikiCitations(text: string): Array<{
  raw: string;
  start: number;
  end: number;
}> {
  const issues = [];
  for (const match of String(text ?? "").matchAll(
    /[[(（]\s*(?:chunks?\b|块|段)[^\])）\r\n]*[\])）]/giu,
  )) {
    const inner = match[0].slice(1, -1).trim();
    try {
      const groups = parseWikiCitations(inner);
      if (groups.length && groups[0].start === 0) continue;
    } catch {
      /* Invalid ranges are reported at the original citation. */
    }
    issues.push({
      raw: match[0],
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }
  return issues;
}

export function stripWikiCitations(text: string): string {
  let result = String(text ?? "");
  for (const group of parseWikiCitations(result).reverse())
    result =
      result.slice(0, group.start) +
      " ".repeat(group.end - group.start) +
      result.slice(group.end);
  return result;
}

export function citedWikiChunkIds(text: string): number[] {
  return [
    ...new Set(parseWikiCitations(text).flatMap((group) => group.chunkIds)),
  ].sort((a, b) => a - b);
}
