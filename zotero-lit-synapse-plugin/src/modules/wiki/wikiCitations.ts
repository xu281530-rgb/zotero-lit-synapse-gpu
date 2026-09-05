export interface WikiCitationGroup {
  start: number;
  end: number;
  chunkIds: number[];
}

/** Shared addresses for coverage, source validation and sentence audits. */
export function parseWikiCitations(text: string): WikiCitationGroup[] {
  const input = String(text ?? "");
  const pattern =
    /(?:chunks?|块|段)\s*#?\s*(\d+(?:\s*(?:[-–—]|to|~|、|,|，)\s*\d+)*)|第\s*(\d+)\s*(?:块|段)/giu;
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

export function citedWikiChunkIds(text: string): number[] {
  return [
    ...new Set(parseWikiCitations(text).flatMap((group) => group.chunkIds)),
  ].sort((a, b) => a - b);
}
