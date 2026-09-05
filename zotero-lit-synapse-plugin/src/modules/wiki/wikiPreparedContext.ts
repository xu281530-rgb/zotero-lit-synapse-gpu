export const WIKI_CONTEXT_SECTIONS = [
  "pages",
  "claims",
  "evidence",
  "readingRecords",
  "linkSignals",
  "concepts",
  "relations",
] as const;
export type WikiContextSection = (typeof WIKI_CONTEXT_SECTIONS)[number];
export type WikiPreparedContext = Record<WikiContextSection, any[]>;

export function compactWikiClaim(claim: any): any {
  return {
    claimId: claim.claimId,
    pageId: claim.pageId,
    claimText: claim.claimText,
    version: claim.version,
    epistemicStatus: claim.epistemicStatus,
    coverageLevel: claim.coverageLevel,
    score: claim.score,
    sourceItemKeys: [
      ...new Set((claim.evidence ?? []).map((entry: any) => entry.itemKey)),
    ],
    evidenceCount: claim.evidence?.length ?? 0,
  };
}

/** Large records remain recoverable as ordered fragments, without an oversized page. */
export function fragmentContextText(entries: any[], field: string): any[] {
  return entries.flatMap((entry) => {
    const value = String(entry[field] ?? "");
    if (value.length <= 6000) return [entry];
    const parts = [];
    for (let offset = 0; offset < value.length; offset += 6000) {
      parts.push({
        ...entry,
        [field]: value.slice(offset, offset + 6000),
        textFragment: {
          field,
          offset,
          totalChars: value.length,
          hasMore: offset + 6000 < value.length,
        },
      });
    }
    return parts;
  });
}

/** Preserve even large nested entries as reconstructable JSON fragments. */
export function boundPreparedContext(
  context: WikiPreparedContext,
): WikiPreparedContext {
  return Object.fromEntries(
    Object.entries(context).map(([section, entries]) => [
      section,
      entries.flatMap((entry, entryIndex) => {
        const json = JSON.stringify(entry);
        if (json.length <= 12000) return [entry];
        const fragments = [];
        for (let offset = 0; offset < json.length; offset += 6000) {
          fragments.push({
            signalId: entry.signalId,
            claimId: entry.claimId,
            contextFragment: {
              entryIndex,
              format: "json",
              offset,
              totalChars: json.length,
              hasMore: offset + 6000 < json.length,
            },
            text: json.slice(offset, offset + 6000),
          });
        }
        return fragments;
      }),
    ]),
  ) as WikiPreparedContext;
}

export function pagePreparedContext(
  context: WikiPreparedContext,
  section: string,
  offset = 0,
  limit = 10,
): any {
  if (!WIKI_CONTEXT_SECTIONS.includes(section as WikiContextSection))
    throw new Error(`Unknown prepared context section: ${section}`);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("offset must be a nonnegative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new Error("limit must be an integer from 1 to 50");
  const rows = context[section as WikiContextSection];
  const items = [];
  let chars = 0;
  for (const row of rows.slice(offset, offset + limit)) {
    const size = JSON.stringify(row).length;
    if (items.length && chars + size > 20000) break;
    items.push(row);
    chars += size;
  }
  const end = offset + items.length;
  return {
    section,
    items,
    pagination: {
      offset,
      returned: items.length,
      total: rows.length,
      hasMore: end < rows.length,
      nextOffset: end < rows.length ? end : null,
    },
  };
}
