/**
 * `get_document_chunks`: read ONE document's indexed body in order, one page
 * at a time.
 *
 * This replaces `fulltext_database`, which was three unrelated things wearing
 * one name. Two of them were database administration — `list` enumerated the
 * index's metadata rows and `stats` reported vector counts and cache sizes,
 * neither of which answers a research question, both of which invited a model
 * to reason about the plugin's storage instead of about the literature. The
 * third, `get`, returned an item's entire body text in a single response with
 * no paging at all: the one call in the whole server that could hand back a
 * 200-page paper, and therefore the standing bypass around the retrieval
 * funnel that every other tool is shaped to enforce.
 *
 * What survives is the part that was actually useful — sequential reading —
 * with the paging the old tool lacked, and index administration stays inside
 * the plugin's own preferences UI where it belongs.
 *
 * The `readDocumentChunks` function below takes its Zotero access as injected
 * dependencies so the ordering, paging and refusal rules are testable without
 * a running Zotero.
 */

// The leaf module, not the ./semantic barrel — see toolCatalog.ts.
import type { FullTextAvailability } from "./semantic/bodyIndexState";

/** Chunks per page when the caller does not say. */
export const DEFAULT_DOCUMENT_CHUNKS_PER_PAGE = 8;

/**
 * Hard ceiling per page.
 *
 * Deliberately small. The whole reason this tool exists rather than a
 * `get_full_text` is that reading has to be a decision the caller keeps
 * making; a cap large enough to swallow a short paper would let it stop
 * making that decision on the first call.
 */
export const MAX_DOCUMENT_CHUNKS_PER_PAGE = 20;

export interface DocumentChunkRow {
  /** 0-based position in reading order. Stable across calls. */
  chunkIndex: number;
  /**
   * The id the semantic index assigned this passage — what search_fulltext's
   * `chunkIds` and find_similar's `chunkIds` expect.
   *
   * Kept separate from `chunkIndex` because they are only equal for a document
   * whose chunks were all stored contiguously. Deriving one from the other
   * would silently address the wrong passage on any document where a chunk was
   * dropped, and the caller would have no way to notice.
   */
  chunkId: number;
  chars: number;
  language?: string;
  text: string;
}

export interface DocumentChunksRequest {
  itemKey?: string;
  libraryID?: number;
  cursor?: string;
  offset?: unknown;
  limit?: unknown;
}

export interface DocumentChunksDeps {
  /** Every stored chunk of this document, already in chunk_id order. */
  getChunks(
    itemKey: string,
    libraryID: number,
  ): Promise<Array<{ chunkId: number; text: string; language?: string }>>;
  /** Whether the index holds real body text for this document. */
  getFullTextAvailability(
    itemKey: string,
    libraryID: number,
  ): Promise<FullTextAvailability>;
  /** Display title, for orientation in the response. Best-effort. */
  getTitle(itemKey: string, libraryID: number): Promise<string | undefined>;
}

export class DocumentChunksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentChunksError";
  }
}

interface ChunkCursor {
  k: string;
  l: number;
  o: number;
  s: number;
}

/**
 * Encode a continuation token.
 *
 * Stateless on purpose, and this is the one place this plugin's two paging
 * styles genuinely differ. A ranked search has to snapshot its ranking, because
 * re-running retrieval for page 2 can reorder page 1's documents underneath the
 * caller. Reading order cannot reorder: chunk 9 follows chunk 8 today and in an
 * hour. So this cursor carries only "where I was", never expires, and survives
 * a Zotero restart — which is what a caller reading a long paper across several
 * turns actually needs.
 */
export function encodeChunkCursor(cursor: ChunkCursor): string {
  const json = JSON.stringify(cursor);
  if (typeof btoa === "function") {
    // btoa is Latin-1 only and item keys are ASCII, but the guard keeps a
    // future non-ASCII field from throwing here instead of failing loudly.
    return btoa(unescape(encodeURIComponent(json)));
  }
  return Buffer.from(json, "utf-8").toString("base64");
}

export function decodeChunkCursor(raw: string): ChunkCursor {
  let json: string;
  try {
    json =
      typeof atob === "function"
        ? decodeURIComponent(escape(atob(raw)))
        : Buffer.from(raw, "base64").toString("utf-8");
  } catch {
    throw new DocumentChunksError(
      "cursor is not a valid get_document_chunks cursor. Pass nextCursor back exactly as it was returned, or start again with itemKey.",
    );
  }
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DocumentChunksError(
      "cursor is not a valid get_document_chunks cursor. Pass nextCursor back exactly as it was returned, or start again with itemKey.",
    );
  }
  if (
    !parsed ||
    typeof parsed.k !== "string" ||
    !parsed.k ||
    typeof parsed.l !== "number" ||
    typeof parsed.o !== "number" ||
    typeof parsed.s !== "number"
  ) {
    throw new DocumentChunksError(
      "cursor is not a valid get_document_chunks cursor. Pass nextCursor back exactly as it was returned, or start again with itemKey.",
    );
  }
  return parsed as ChunkCursor;
}

export function resolvePageSize(requested: unknown): number {
  const value = Number(requested);
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_DOCUMENT_CHUNKS_PER_PAGE;
  }
  return Math.min(MAX_DOCUMENT_CHUNKS_PER_PAGE, Math.floor(value));
}

/**
 * Why this document cannot be read, phrased as what to do instead.
 *
 * Returning the title-and-abstract chunks of a document whose PDF never parsed
 * would be the single most damaging thing this tool could do: they look exactly
 * like body text, so the abstract gets quoted as the paper's results. Refusing
 * and saying which of the four situations it is costs one call and prevents
 * that outright.
 */
function refusalFor(
  availability: FullTextAvailability,
  itemKey: string,
): string | null {
  switch (availability) {
    case "indexed":
    case "unknown":
      return null;
    case "parse_failed":
      return `${itemKey} has a PDF or Markdown attachment, but it could not be parsed, so the semantic index holds only its title and abstract — there is no body to read. Returning those would look like body text and would be quoted as the paper's content, so this tool refuses. Read the abstract with get_item_abstract, or try get_attachment_text, which can fall back to Zotero's own extracted text.`;
    case "no_source":
      return `${itemKey} has no PDF, Markdown or text attachment at all, so there is no body text anywhere for it — only the metadata Zotero stores. Use get_item_details and get_item_abstract, and tell the user the full text is not in their library.`;
    case "not_indexed":
      return `${itemKey} has a text attachment but is not in the semantic index yet, so its chunks do not exist. Either read the attachment directly with get_attachment_text, or ask the user to build/refresh the search index in the plugin preferences.`;
    default:
      return null;
  }
}

/**
 * Serve one page of a document's chunks.
 */
export async function readDocumentChunks(
  request: DocumentChunksRequest,
  deps: DocumentChunksDeps,
  defaultLibraryID: number,
): Promise<Record<string, any>> {
  let itemKey = typeof request.itemKey === "string" ? request.itemKey.trim() : "";
  let libraryID =
    typeof request.libraryID === "number" ? request.libraryID : defaultLibraryID;
  let offset = 0;
  let pageSize = resolvePageSize(request.limit);
  let servedFromCursor = false;

  if (typeof request.cursor === "string" && request.cursor.trim()) {
    const cursor = decodeChunkCursor(request.cursor.trim());
    // A cursor names the document it continues. A caller that sends a cursor
    // AND a different itemKey has asked two questions at once; answering the
    // cursor's would silently ignore the one they wrote out in full.
    if (itemKey && itemKey !== cursor.k) {
      throw new DocumentChunksError(
        `cursor continues ${cursor.k} but itemKey says ${itemKey}. Drop the cursor to start reading ${itemKey} from the beginning, or drop itemKey to continue ${cursor.k}.`,
      );
    }
    itemKey = cursor.k;
    libraryID = cursor.l;
    offset = cursor.o;
    pageSize = request.limit === undefined ? cursor.s : pageSize;
    servedFromCursor = true;
  }

  if (!itemKey) {
    throw new DocumentChunksError(
      "itemKey is required (or pass cursor to continue reading a document you already started).",
    );
  }

  const availability = await deps.getFullTextAvailability(itemKey, libraryID);
  const refusal = refusalFor(availability, itemKey);
  if (refusal) throw new DocumentChunksError(refusal);

  const chunks = await deps.getChunks(itemKey, libraryID);
  const totalChunks = chunks.length;
  if (totalChunks === 0) {
    throw new DocumentChunksError(
      `${itemKey} has no stored chunks, even though the index recorded it as "${availability}". The index is likely stale for this document; rebuild or refresh it in the plugin preferences.`,
    );
  }

  if (!servedFromCursor) {
    const requested = Number(request.offset);
    offset =
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
  }
  offset = Math.min(offset, totalChunks);

  const page = chunks.slice(offset, offset + pageSize);
  const rows: DocumentChunkRow[] = page.map((chunk, index) => ({
    chunkIndex: offset + index,
    chunkId: chunk.chunkId,
    chars: chunk.text.length,
    ...(chunk.language ? { language: chunk.language } : {}),
    text: chunk.text,
  }));

  const end = offset + rows.length;
  const hasMore = end < totalChunks;
  const title = await deps.getTitle(itemKey, libraryID);
  const range = rows.length === 0 ? "none" : `${offset + 1}-${end}`;

  return {
    itemKey,
    libraryID,
    ...(title ? { title } : {}),
    fullText: availability,
    ...(availability === "unknown"
      ? {
          fullTextNote:
            "This document was indexed before the plugin recorded whether a chunk came from body text or from title+abstract. Its passages are probably real body text, but that was never established — do not cite them as the paper's content without checking one against the PDF.",
        }
      : {}),
    pagination: {
      totalChunks,
      returned: rows.length,
      offset,
      range,
      pageSize,
      hasMore,
      ...(hasMore
        ? {
            nextCursor: encodeChunkCursor({
              k: itemKey,
              l: libraryID,
              o: end,
              s: pageSize,
            }),
          }
        : {}),
      servedFromCursor,
    },
    data: rows,
    metadata: {
      extractedAt: new Date().toISOString(),
      totalChars: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      returnedChars: rows.reduce((sum, row) => sum + row.chars, 0),
      nextStep: hasMore
        ? `You have read chunks ${range} of ${totalChunks}. Continue with cursor set to pagination.nextCursor and nothing else changed. Stop as soon as the text stops answering the question — a long paper is many pages, and reading all of them by reflex is what this paging exists to prevent. To search inside this document instead of reading on, call search_fulltext with itemKey "${itemKey}". To pull the passages around a specific chunk, pass its chunkId (not its chunkIndex) to search_fulltext's chunkIds.`
        : `That is the whole document: ${totalChunks} chunk(s). To search within it, call search_fulltext with itemKey "${itemKey}". To find related papers, pick the chunkIds that best characterise it and pass them to find_similar.`,
    },
  };
}
