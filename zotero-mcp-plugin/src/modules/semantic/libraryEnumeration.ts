/**
 * Enumerating the documents a library contains, as a step that can FAIL.
 *
 * This is deliberately its own module because of what the answer is used for.
 * A full-library rebuild takes the returned list as the authoritative set of
 * documents to index, records it as the build's target snapshot, and then
 * CLEARS every existing vector for the library against exactly that snapshot.
 *
 * The previous implementation caught every error and returned `[]`. That made
 * a transient Zotero query failure indistinguishable from "this library has 0
 * items", with the worst possible consequence: the rebuild wiped the whole
 * semantic index, found nothing to do, and reported `completed` because
 * 0 succeeded of 0 total. The index was gone and nothing said so.
 *
 * So enumeration has exactly two outcomes here — a list, or a throw. There is
 * no third, quiet one.
 */

/**
 * Enumeration did not produce a trustworthy document list.
 *
 * Callers must treat this as "the library is unknown", never as "the library
 * is empty", and must not perform any destructive step that was going to be
 * validated against the list.
 */
export class ItemEnumerationError extends Error {
  readonly libraryID: number;
  readonly cause: unknown;

  constructor(libraryID: number, cause: unknown) {
    const detail =
      cause instanceof Error ? cause.message : String(cause ?? 'unknown error');
    super(
      `Could not enumerate items in library ${libraryID}: ${detail}. ` +
        'The existing semantic index has been left untouched; nothing was ' +
        'cleared or rebuilt. Retry once Zotero can answer the query again.',
    );
    this.name = 'ItemEnumerationError';
    this.libraryID = libraryID;
    this.cause = cause;
  }
}

export function isItemEnumerationError(
  error: unknown,
): error is ItemEnumerationError {
  return (
    error instanceof ItemEnumerationError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'ItemEnumerationError')
  );
}

/**
 * Every regular (non-attachment, non-note, non-annotation) item in a library.
 *
 * @throws {ItemEnumerationError} if the search rejects, or if either Zotero
 *   call resolves to something that is not an array. `null`/`undefined` is not
 *   an empty library — it is a query that did not answer, and answering
 *   "empty" on its behalf is what destroyed indexes.
 */
export async function enumerateLibraryItems(
  libraryID: number,
): Promise<any[]> {
  try {
    const search = new Zotero.Search();
    (search as any).libraryID = libraryID;
    search.addCondition('itemType', 'isNot', 'attachment');
    search.addCondition('itemType', 'isNot', 'note');
    search.addCondition('itemType', 'isNot', 'annotation');

    const ids = await search.search();
    if (!Array.isArray(ids)) {
      throw new Error(
        'Zotero.Search.search() returned no result set for the library',
      );
    }

    const items = await Zotero.Items.getAsync(ids);
    if (!Array.isArray(items)) {
      throw new Error(
        'Zotero.Items.getAsync() returned no item list for the library',
      );
    }
    return items;
  } catch (error) {
    if (isItemEnumerationError(error)) throw error;
    throw new ItemEnumerationError(libraryID, error);
  }
}
