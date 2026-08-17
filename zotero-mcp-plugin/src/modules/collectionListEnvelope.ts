/**
 * The response envelope for a collection listing.
 *
 * `handleGetCollections` and `handleSearchCollections` used to answer with a
 * bare JSON array and put the total in an `X-Total-Count` header. Over HTTP
 * that is merely unusual; over MCP it loses information outright, because MCP
 * forwards only the body. `callGetCollections` set `result.metadata = {...}`
 * on the parsed array and `JSON.stringify` discarded it without a word —
 * properties on an Array are not serialised. The paging state had nowhere to
 * live at all, so a page of 100 out of 300 was indistinguishable from all 300.
 *
 * An object has room for both. Kept pure and separate from the handlers so the
 * serialisation can be tested directly: the bug was invisible until something
 * actually called JSON.stringify.
 */

export interface CollectionListPaging {
  total: number;
  offset: number;
  limit: number;
}

export interface CollectionListEnvelope<T> {
  results: T[];
  pagination: {
    total: number;
    returned: number;
    offset: number;
    limit: number;
    range: string;
    hasMore: boolean;
    nextOffset?: number;
  };
  metadata: Record<string, any>;
}

export function buildCollectionListEnvelope<T>(
  results: T[],
  paging: CollectionListPaging,
  metadata: Record<string, any> = {},
  now: () => string = () => new Date().toISOString(),
): CollectionListEnvelope<T> {
  const end = paging.offset + results.length;
  const hasMore = end < paging.total;
  return {
    results,
    pagination: {
      total: paging.total,
      returned: results.length,
      offset: paging.offset,
      limit: paging.limit,
      range: results.length === 0 ? "none" : `${paging.offset + 1}-${end}`,
      hasMore,
      ...(hasMore ? { nextOffset: end } : {}),
    },
    metadata: {
      extractedAt: now(),
      ...metadata,
    },
  };
}
