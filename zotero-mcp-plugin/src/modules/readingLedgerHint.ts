/**
 * The reminder that a turn which READ something owes the Wiki a record.
 *
 * This obligation used to live only in static text: the tail of hybrid_search's
 * description and STAGE 4 of the server instructions, both loaded once at
 * connection time and both dozens of tool calls behind by the moment a model
 * finishes reading. The tools that actually hand the passages over said
 * nothing, and neither did any response. The commonest outcome was an answer,
 * no record, and a Wiki that stayed at one page however many questions the
 * library was asked.
 *
 * Kept pure, and kept out of the server class, because the bug this module
 * exists to prevent was a SHAPE bug: the first version read `result.chunks`
 * only, so it worked for search_fulltext and silently did nothing for
 * get_document_chunks, whose passages arrive under `data`. Nothing failed and
 * nothing logged - the hint was just absent, which is indistinguishable from
 * the problem it was written to fix. Shape logic that can fail silently
 * belongs somewhere a test can reach without a Zotero.
 */

export interface ReadingLedgerHint {
  itemKey: string;
  deliveredChunkIds: number[];
  recorded: false;
  nextStep: string;
}

/**
 * The chunk ids a reading response just handed over, whichever shape it used.
 *
 * `search_fulltext` returns ranked passages as `chunks`; `get_document_chunks`
 * returns consecutive ones as `data`. Both are "passages this call delivered",
 * and both owe the same record.
 */
export function deliveredChunkIds(result: unknown): number[] {
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const rows = Array.isArray(record.chunks)
    ? record.chunks
    : Array.isArray(record.data)
      ? record.data
      : [];
  const ids: number[] = [];
  for (const row of rows) {
    const id = (row as Record<string, unknown> | null)?.chunkId;
    // A chunkId of 0 is a real chunk - the first one - so this cannot be a
    // truthiness check.
    if (typeof id === "number" && Number.isInteger(id)) ids.push(id);
  }
  return ids;
}

export function buildReadingLedgerHint(
  result: unknown,
  itemKey: string,
): ReadingLedgerHint | null {
  const chunkIds = deliveredChunkIds(result);
  if (!chunkIds.length || !itemKey) return null;
  return {
    itemKey,
    deliveredChunkIds: chunkIds,
    recorded: false,
    nextStep:
      `Answer the user first. Then, if you USED any of these passages, call ` +
      `wiki_update_reading_note with itemKey "${itemKey}", readChunkIds set to just the ` +
      `ones you used, the domain and expertRole you searched with, and one readingRecord ` +
      `of what this turn established. Retrieval is not reading: a passage you skimmed ` +
      `past does not go in. If you used none of them, record nothing.`,
  };
}
