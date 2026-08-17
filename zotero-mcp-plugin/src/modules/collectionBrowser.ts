/**
 * `get_collection_items`: walk the library one level at a time.
 *
 * The old tool took a collectionKey and returned that collection's items
 * formatted by `formatItem`'s default field list — which meant every row
 * carried the abstract, every note's full HTML body and every attachment's
 * absolute file path. Two rows measured 4.5 KB in a real library, so listing a
 * 200-item folder was most of a context window spent on a directory listing.
 * It also had no way to say what was BELOW the current level, so the only way
 * to see the shape of a library was `get_collections(recursive: true)`, which
 * returns the entire tree at once.
 *
 * A file manager solves this by showing one level: the folders here, the files
 * here, and a count on each folder so you can tell where to descend without
 * opening it. That is what this does.
 *
 * Everything here is pure and takes its Zotero access as injected accessors,
 * so path resolution, counting and paging are testable without Zotero.
 */

/** Documents listed per level when the caller does not say. */
export const DEFAULT_BROWSE_PAGE_SIZE = 50;

/** Hard ceiling, so a large folder is several pages rather than one dump. */
export const MAX_BROWSE_PAGE_SIZE = 200;

/** A folder as seen from its parent, before you decide to descend into it. */
export interface BrowsedCollection {
  collectionKey: string;
  name: string;
  /** Documents filed directly at this level. */
  directItemCount: number;
  /** This level plus everything nested below it, de-duplicated. */
  totalItemCount: number;
  hasChildren: boolean;
}

/** A document row: identity and citation basics, never content. */
export interface BrowsedItem {
  itemKey: string;
  title: string;
  creators?: string;
  year?: string;
  itemType?: string;
  publicationTitle?: string;
  DOI?: string;
}

export interface CollectionNode {
  key: string;
  name: string;
  parentKey: string | null;
  childCollectionKeys: string[];
  /** Keys of items filed DIRECTLY in this collection. */
  itemKeys: string[];
}

export interface CollectionBrowserDeps {
  /** null when the key does not exist in this library. */
  getCollection(key: string): CollectionNode | null;
  /** Top-level collections of the library, in display order. */
  getTopLevelCollectionKeys(): string[];
  /** Items that belong to no collection at all. */
  getUnfiledItemKeys(): string[];
  /** Light metadata for one page of items. Order follows the keys given. */
  describeItems(itemKeys: string[]): Promise<BrowsedItem[]>;
  /** Display name of the library itself, used as the path root. */
  getLibraryName(): string;
}

export class CollectionBrowserError extends Error {
  /** Candidate keys when a path was ambiguous, so the caller can pick. */
  readonly candidates?: Array<{ collectionKey: string; path: string }>;

  constructor(
    message: string,
    candidates?: Array<{ collectionKey: string; path: string }>,
  ) {
    super(message);
    this.name = "CollectionBrowserError";
    this.candidates = candidates;
  }
}

export function resolveBrowsePageSize(requested: unknown): number {
  const value = Number(requested);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_BROWSE_PAGE_SIZE;
  return Math.min(MAX_BROWSE_PAGE_SIZE, Math.floor(value));
}

/**
 * Every descendant item of a collection, de-duplicated.
 *
 * De-duplication matters and summing children's totals would get it wrong: a
 * document filed in both a parent and its child is one document, and Zotero
 * collections form a tree of references, not a partition. A caller deciding
 * where to descend from `totalItemCount` needs it to mean "documents you would
 * find under here", not "filing entries".
 */
function collectDescendantItemKeys(
  key: string,
  deps: CollectionBrowserDeps,
  seenCollections: Set<string>,
  into: Set<string>,
): void {
  if (seenCollections.has(key)) return;
  seenCollections.add(key);
  const node = deps.getCollection(key);
  if (!node) return;
  for (const itemKey of node.itemKeys) into.add(itemKey);
  for (const child of node.childCollectionKeys) {
    collectDescendantItemKeys(child, deps, seenCollections, into);
  }
}

function summarise(
  key: string,
  deps: CollectionBrowserDeps,
): BrowsedCollection | null {
  const node = deps.getCollection(key);
  if (!node) return null;
  const descendants = new Set<string>();
  collectDescendantItemKeys(key, deps, new Set<string>(), descendants);
  return {
    collectionKey: node.key,
    name: node.name,
    directItemCount: node.itemKeys.length,
    totalItemCount: descendants.size,
    hasChildren: node.childCollectionKeys.length > 0,
  };
}

/** Walk up to the root so a response can show where the caller is. */
export function buildPath(
  key: string,
  deps: CollectionBrowserDeps,
): { segments: string[]; path: string } {
  const segments: string[] = [];
  const seen = new Set<string>();
  let current: string | null = key;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = deps.getCollection(current);
    if (!node) break;
    segments.unshift(node.name);
    current = node.parentKey;
  }
  const full = [deps.getLibraryName(), ...segments];
  return { segments, path: full.join("/") };
}

function normalisePathSegments(raw: string, libraryName: string): string[] {
  const segments = raw
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  // The library name is optional in the input: "Materials/CET" and
  // "My Library/Materials/CET" name the same folder, and requiring one form
  // would reject the path this tool itself printed half the time.
  if (
    segments.length > 0 &&
    segments[0].toLowerCase() === libraryName.toLowerCase()
  ) {
    segments.shift();
  }
  return segments;
}

/**
 * Turn a slash-separated path into a collectionKey.
 *
 * Ambiguity is an error, never a guess. Two sibling folders may legitimately
 * share a name, and picking one silently would list the wrong folder's
 * contents while looking entirely successful.
 */
export function resolvePath(
  rawPath: string,
  deps: CollectionBrowserDeps,
): string | null {
  const segments = normalisePathSegments(rawPath, deps.getLibraryName());
  if (segments.length === 0) return null;

  let level = deps.getTopLevelCollectionKeys();
  let resolved: string | null = null;

  for (let depth = 0; depth < segments.length; depth += 1) {
    const wanted = segments[depth].toLowerCase();
    const matches = level.filter((key) => {
      const node = deps.getCollection(key);
      return node ? node.name.trim().toLowerCase() === wanted : false;
    });

    if (matches.length === 0) {
      const soFar = segments.slice(0, depth).join("/");
      throw new CollectionBrowserError(
        `No collection named "${segments[depth]}"${soFar ? ` under "${soFar}"` : " at the top level"}. List the level with get_collection_items and use the collectionKey it returns.`,
      );
    }
    if (matches.length > 1) {
      throw new CollectionBrowserError(
        `The path segment "${segments[depth]}" matches ${matches.length} sibling collections, so it does not identify one folder. Call get_collection_items again with one of the collectionKey values below instead of a path.`,
        matches.map((key) => ({
          collectionKey: key,
          path: buildPath(key, deps).path,
        })),
      );
    }

    resolved = matches[0];
    const node = deps.getCollection(resolved);
    level = node ? node.childCollectionKeys : [];
  }

  return resolved;
}

export interface BrowseRequest {
  collectionKey?: string;
  path?: string;
  libraryID?: number;
  limit?: unknown;
  offset?: unknown;
}

/**
 * List one level: the folders here, and one page of the documents here.
 */
export async function browseCollection(
  request: BrowseRequest,
  deps: CollectionBrowserDeps,
  libraryID: number,
): Promise<Record<string, any>> {
  let key =
    typeof request.collectionKey === "string" && request.collectionKey.trim()
      ? request.collectionKey.trim()
      : null;

  if (!key && typeof request.path === "string" && request.path.trim()) {
    key = resolvePath(request.path, deps);
  }

  const pageSize = resolveBrowsePageSize(request.limit);
  const requestedOffset = Number(request.offset);
  let offset =
    Number.isFinite(requestedOffset) && requestedOffset > 0
      ? Math.floor(requestedOffset)
      : 0;

  let location: Record<string, any>;
  let childKeys: string[];
  let directItemKeys: string[];
  let parent: Record<string, any> | null = null;

  if (key) {
    const node = deps.getCollection(key);
    if (!node) {
      throw new CollectionBrowserError(
        `Collection ${key} does not exist in library ${libraryID}. List the level above with get_collection_items, or read the folder names with get_collections.`,
      );
    }
    const { path } = buildPath(node.key, deps);
    location = {
      level: "collection",
      libraryID,
      collectionKey: node.key,
      name: node.name,
      path,
    };
    childKeys = node.childCollectionKeys;
    directItemKeys = node.itemKeys;
    parent = node.parentKey
      ? {
          collectionKey: node.parentKey,
          name: deps.getCollection(node.parentKey)?.name ?? node.parentKey,
          path: buildPath(node.parentKey, deps).path,
        }
      : { collectionKey: null, name: deps.getLibraryName(), path: deps.getLibraryName() };
  } else {
    location = {
      level: "library",
      libraryID,
      collectionKey: null,
      name: deps.getLibraryName(),
      path: deps.getLibraryName(),
    };
    childKeys = deps.getTopLevelCollectionKeys();
    // At the root, "documents filed directly here" means the ones in no
    // collection at all. Listing every item in the library instead would make
    // the root the one level that is not browsable.
    directItemKeys = deps.getUnfiledItemKeys();
  }

  const subcollections = childKeys
    .map((child) => summarise(child, deps))
    .filter((entry): entry is BrowsedCollection => entry !== null);

  const total = directItemKeys.length;
  offset = Math.min(offset, total);
  const pageKeys = directItemKeys.slice(offset, offset + pageSize);
  const items = await deps.describeItems(pageKeys);
  const end = offset + items.length;
  const hasMore = end < total;

  return {
    location,
    ...(parent ? { parent } : {}),
    subcollections,
    subcollectionCount: subcollections.length,
    items,
    itemPagination: {
      total,
      returned: items.length,
      offset,
      range: items.length === 0 ? "none" : `${offset + 1}-${end}`,
      limit: pageSize,
      hasMore,
      ...(hasMore ? { nextOffset: end } : {}),
    },
    metadata: {
      extractedAt: new Date().toISOString(),
      itemsAreDirectChildrenOnly: true,
      nextStep: buildNextStep(location, subcollections, total, hasMore, end),
    },
  };
}

function buildNextStep(
  location: Record<string, any>,
  subcollections: BrowsedCollection[],
  totalItems: number,
  hasMore: boolean,
  end: number,
): string {
  const where =
    location.level === "library"
      ? `the top level of ${location.name}`
      : `"${location.path}"`;

  const parts: string[] = [
    `This is one level of the library: ${where}. It has ${subcollections.length} subcollection(s) and ${totalItems} document(s) filed directly here${location.level === "library" ? " (documents in no collection at all)" : ""}.`,
  ];

  if (subcollections.length > 0) {
    parts.push(
      `To go deeper, call get_collection_items again with the collectionKey of the subcollection you want. Use directItemCount and totalItemCount to choose without opening anything: a folder with directItemCount 0 and a large totalItemCount is a container whose documents live further down, not an empty folder.`,
    );
  }

  if (hasMore) {
    parts.push(
      `Documents 1-${end} of ${totalItems} are shown; pass offset=${end} for the next page.`,
    );
  }

  parts.push(
    `Rows here are identity only — no abstracts, notes, annotations or full text. For a document worth pursuing, call get_item_details for its metadata, get_item_abstract for its abstract, or search_fulltext to look inside it. If the user is actually asking about a TOPIC rather than about the library's structure, stop browsing and call hybrid_search, optionally scoped with collectionKeys.`,
  );

  return parts.join(" ");
}
