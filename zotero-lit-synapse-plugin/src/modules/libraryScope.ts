/**
 * Library-scoping helpers for the semantic index lifecycle.
 *
 * The vector store namespaces every record by library, and buildIndex resolves
 * keys with getByLibraryAndKeyAsync, so any path that indexes, refreshes or
 * clears items has to know which library each key belongs to. Keeping the
 * grouping here (free of Zotero globals) makes it directly testable.
 */

/** Identity of one queued item, as stored in the auto-update queue. */
export interface LibraryItemIdentity {
  key: string;
  libraryID: number;
}

/** Encode a queue entry so items with equal keys in different libraries differ. */
export function toLibraryQueueKey(itemKey: string, libraryID: number): string {
  return `${libraryID}:${itemKey}`;
}

/** Split encoded queue entries into one itemKey list per library. */
export function groupQueueKeysByLibrary(
  identities: string[],
  fallbackLibraryID: number,
): Map<number, string[]> {
  const grouped = new Map<number, string[]>();
  for (const identity of identities) {
    const separator = identity.indexOf(":");
    const libraryID =
      separator > 0 ? Number(identity.slice(0, separator)) : fallbackLibraryID;
    const itemKey = separator > 0 ? identity.slice(separator + 1) : identity;
    if (!itemKey || !Number.isFinite(libraryID)) continue;
    const bucket = grouped.get(libraryID);
    if (bucket) {
      if (!bucket.includes(itemKey)) bucket.push(itemKey);
    } else {
      grouped.set(libraryID, [itemKey]);
    }
  }
  return grouped;
}

/** Split a selection of items into one deduplicated itemKey list per library. */
export function groupItemKeysByLibrary(
  items: LibraryItemIdentity[],
): Map<number, string[]> {
  const grouped = new Map<number, string[]>();
  for (const { key, libraryID } of items) {
    if (!key) continue;
    const bucket = grouped.get(libraryID);
    if (bucket) {
      if (!bucket.includes(key)) bucket.push(key);
    } else {
      grouped.set(libraryID, [key]);
    }
  }
  return grouped;
}
