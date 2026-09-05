export const SEARCH_LIBRARY_DEFAULT_LIMIT = 200;
export const COLLECTIONS_DEFAULT_LIMIT = 100;

export const STANDARD_ITEM_DETAIL_FIELDS = [
  'key',
  'title',
  'creators',
  'date',
  'itemType',
  'publicationTitle',
  'volume',
  'issue',
  'pages',
  'DOI',
  'url',
  'language',
  'tags',
  'hasAbstract',
  'noteCount',
  'attachments',
  // Where the item is filed. Metadata, not content, and the only way a caller
  // can see that a document is in the wrong folder — or in five folders at
  // once — without listing every collection in the library and inverting it.
  'collections',
] as const;

const LEGACY_CONTENT_CONTROL_FIELDS = new Set([
  'mode',
  'detail',
  'outputMode',
  'maxTokens',
]);

/** Keep old clients compatible while content behavior is fixed. */
export function prepareFixedContentToolArgs(
  args: Record<string, any> | null | undefined,
  defaultLimit: number,
): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (!LEGACY_CONTENT_CONTROL_FIELDS.has(key)) result[key] = value;
  }
  if (result.limit === undefined || result.limit === null) {
    result.limit = defaultLimit;
  }
  return result;
}
