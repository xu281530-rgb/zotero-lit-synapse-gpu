/**
 * API Endpoint Handlers for Zotero LitSynapse
 */


import {
  collectionPath,
  describeItemCollections,
  formatItem,
  formatItems,
} from "./itemFormatter";
import {
  formatCollection,
  formatCollectionBrief,
  formatCollectionList,
  formatCollectionDetails,
} from "./collectionFormatter";
import { buildCollectionListEnvelope } from "./collectionListEnvelope";
import { planCollectionMove, type MoveCandidate } from "./collectionMovePlan";
import {
  planItemMerge,
  type MergeCandidate,
  type MergeGroupInput,
} from "./itemMergePlan";
import { handleSearchRequest, MCPError } from "./searchEngine";
import { FulltextService } from "./fulltextService";
import {
  expandChunkContext,
  runDocumentDeepDive,
} from "./documentDeepDive";

declare let ztoolkit: ZToolkit;

// Define a simple interface for HTTP responses, aligning with what httpServer expects.
interface HttpResponse {
  status: number;
  statusText: string;
  headers?: Record<string, string>;
  body?: string;
}

function resolveLibraryID(query: URLSearchParams): number {
  const rawLibraryID = query.get("libraryID");
  if (rawLibraryID === null) {
    return Zotero.Libraries.userLibraryID;
  }

  // Treat empty or whitespace-only values the same as an omitted libraryID.
  if (!rawLibraryID.trim()) {
    return Zotero.Libraries.userLibraryID;
  }

  const libraryID = Number(rawLibraryID);
  if (!Number.isInteger(libraryID) || !Number.isFinite(libraryID)) {
    throw new MCPError(400, "Invalid libraryID: must be an integer");
  }

  return libraryID;
}

/**
 * Handles the /ping endpoint for health checks.
 * @returns A promise that resolves to an HttpResponse.
 */
export async function handlePing(): Promise<HttpResponse> {
  return {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      message: "pong",
      timestamp: new Date().toISOString(),
    }),
  };
}

/**
 * Handles listing all available Zotero libraries.
 * @param query - URL query parameters.
 * @returns A promise that resolves to an HttpResponse.
 */
export async function handleGetLibraries(
  query: URLSearchParams,
): Promise<HttpResponse> {
  try {
    const limit = parseInt(query.get("limit") || "100", 10);
    const offset = parseInt(query.get("offset") || "0", 10);

    const allLibraries = Zotero.Libraries.getAll();
    const total = allLibraries.length;
    const paginated = allLibraries.slice(offset, offset + limit);
    const libraries = paginated.map((library) => ({
      libraryID: library.libraryID,
      name: library.name,
      libraryType: library.libraryType,
    }));

    const hasMore = offset + libraries.length < total;
    return {
      status: 200,
      statusText: "OK",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Total-Count": total.toString(),
      },
      body: JSON.stringify({
        results: libraries,
        pagination: {
          total,
          limit,
          offset,
          hasMore,
          ...(hasMore ? { nextOffset: offset + libraries.length } : {}),
        },
        metadata: { extractedAt: new Date().toISOString() },
      }),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    Zotero.logError(error);
    return {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "An unexpected error occurred" }),
    };
  }
}

/**
 * Handles searching Zotero libraries by name.
 * @param query - URL query parameters.
 * @returns A promise that resolves to an HttpResponse.
 */
export async function handleSearchLibraries(
  query: URLSearchParams,
): Promise<HttpResponse> {
  try {
    const q = query.get("q");
    if (!q) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Missing query parameter 'q'" }),
      };
    }

    const limit = parseInt(query.get("limit") || "100", 10);
    const offset = parseInt(query.get("offset") || "0", 10);
    const lowerCaseQuery = q.toLowerCase();

    const matchedLibraries = Zotero.Libraries.getAll().filter((library) =>
      library.name.toLowerCase().includes(lowerCaseQuery),
    );

    const total = matchedLibraries.length;
    const paginated = matchedLibraries.slice(offset, offset + limit);
    const libraries = paginated.map((library) => ({
      libraryID: library.libraryID,
      name: library.name,
      libraryType: library.libraryType,
    }));

    const hasMore = offset + libraries.length < total;
    return {
      status: 200,
      statusText: "OK",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Total-Count": total.toString(),
      },
      body: JSON.stringify({
        results: libraries,
        pagination: {
          total,
          limit,
          offset,
          hasMore,
          ...(hasMore ? { nextOffset: offset + libraries.length } : {}),
        },
        metadata: { extractedAt: new Date().toISOString() },
      }),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const status = (error as any).status || 500;
    Zotero.logError(error);
    return {
      status,
      statusText: status === 400 ? "Bad Request" : "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: status === 400 ? error.message : "An unexpected error occurred" }),
    };
  }
}

/**
 * Handles the /items/:itemKey endpoint to retrieve a single item.
 * @param params - URL parameters, where params[1] is the itemKey.
 * @param query - URL query parameters, may contain 'fields'.
 * @returns A promise that resolves to an HttpResponse.
 */
export async function handleGetItem(
  params: Record<string, string>,
  query: URLSearchParams,
): Promise<HttpResponse> {
  const itemKey = params[1];
  if (!itemKey) {
    return {
      status: 400,
      statusText: "Bad Request",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Missing itemKey parameter" }),
    };
  }

  try {
    const libraryID = resolveLibraryID(query);
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
      libraryID,
      itemKey,
    );

    if (!item) {
      return {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: `Item with key ${itemKey} not found` }),
      };
    }

    const fieldsParam = query.get("fields");
    const fields = fieldsParam ? fieldsParam.split(",") : undefined;
    const formattedItem = await formatItem(item, fields);

    return {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(formattedItem),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const status = (error as any).status || 500;
    Zotero.logError(error);
    return {
      status,
      statusText: status === 400 ? "Bad Request" : "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: status === 400 ? error.message : "An unexpected error occurred" }),
    };
  }
}

/**
 * Handles the /search endpoint to search for items.
 * @param query - URL query parameters for the search.
 * @returns A promise that resolves to an HttpResponse.
 */
export async function handleSearch(
  query: URLSearchParams,
): Promise<HttpResponse> {
  ztoolkit.log("[MCP ApiHandlers] handleSearch called");

  try {
    // Convert URLSearchParams to a plain object for handleSearchRequest
    // Convert URLSearchParams to a plain object, handling tags specifically
    const searchParams: Record<string, any> = {};
    for (const [key, value] of query.entries()) {
      if (key === "tags") {
        // Split comma-separated tags into an array
        searchParams[key] = value
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      } else {
        searchParams[key] = value;
      }
    }

    const libraryID = resolveLibraryID(query);
    if (query.has("libraryID")) {
      searchParams.libraryID = libraryID;
    }

    // Backward compatibility: if 'tag' is present but 'tags' is not, use 'tag'
    if (searchParams.tag && !searchParams.tags) {
      searchParams.tags = [searchParams.tag];
    }

    // Set default values for new tag parameters if not provided
    if (searchParams.tags) {
      searchParams.tagMode = searchParams.tagMode || "any";
      searchParams.tagMatch = searchParams.tagMatch || "exact";
    }

    ztoolkit.log(
      `[MCP ApiHandlers] Converted search params: ${JSON.stringify(searchParams)}`,
    );

    const searchResult = await handleSearchRequest(searchParams);

    ztoolkit.log(
      `[MCP ApiHandlers] Search engine returned ${searchResult.results?.length || 0} results`,
    );

    // The search result from searchEngine already contains formatted items.
    const response = {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(searchResult),
    };

    ztoolkit.log(
      `[MCP ApiHandlers] Returning response with body length: ${response.body.length}`,
    );

    return response;
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    ztoolkit.log(
      `[MCP ApiHandlers] Error in handleSearch: ${error.message}`,
      "error",
    );
    ztoolkit.log(`[MCP ApiHandlers] Error stack: ${error.stack}`, "error");
    Zotero.logError(error);

    // Check if it's a custom error with a status code
    const status = (error as any).status || 500;

    const errorResponse = {
      status,
      statusText: status === 400 ? "Bad Request" : "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: error.message }),
    };

    ztoolkit.log(
      `[MCP ApiHandlers] Returning error response: ${errorResponse.status} ${errorResponse.statusText}`,
      "error",
    );

    return errorResponse;
  }
}

/**
 * Handles GET /collections endpoint.
 * @param query - URL query parameters.
 * @returns A promise that resolves to an HttpResponse.
 */
/**
 * The envelope every collection listing returns.
 *
 * These handlers used to answer with a bare JSON array and put the total in an
 * `X-Total-Count` header. That works over HTTP and is invisible over MCP,
 * which sees only the body: `callGetCollections` set `result.metadata` on the
 * parsed array and `JSON.stringify` dropped it, because array properties are
 * not serialised. The count and the paging state were simply gone.
 *
 * An object has somewhere to put them, and matches the shape
 * `get_collection_items` already returns.
 */
function collectionListResponse(
  collections: Zotero.Collection[],
  paging: { total: number; offset: number; limit: number },
  metadata: Record<string, any> = {},
): HttpResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Kept for existing REST callers; the body is now the source of truth.
      "X-Total-Count": paging.total.toString(),
    },
    body: JSON.stringify(
      buildCollectionListEnvelope(
        formatCollectionList(collections),
        paging,
        metadata,
      ),
    ),
  };
}

export async function handleGetCollections(
  query: URLSearchParams,
): Promise<HttpResponse> {
  try {
    const libraryID = resolveLibraryID(query);
    const limit = parseInt(query.get("limit") || "100", 10);
    const offset = parseInt(query.get("offset") || "0", 10);
    const sort = query.get("sort") || "name";
    const direction = query.get("direction") || "asc";
    const parentCollection = query.get("parentCollection");

    // `recursive` returned the whole nested tree in one unpaginated response,
    // duplicating get_collection_items and reintroducing the bulk-dump path
    // the level-by-level browser replaced. Refuse rather than silently ignore:
    // a caller who asked for the subtree must not be handed page one of the
    // top level and told it succeeded.
    if (query.has("recursive") && query.get("recursive") !== "false") {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error:
            "recursive was removed: it returned the entire collection tree in one unpaginated response. Browse one level at a time with get_collection_items (no collectionKey starts at the top of the library), which reports directItemCount, totalItemCount and hasChildren per folder so you can see what a subtree holds without downloading it.",
        }),
      };
    }

    let collections: Zotero.Collection[] = [];
    if (parentCollection) {
      const parent = await Zotero.Collections.getByLibraryAndKeyAsync(
        libraryID,
        parentCollection,
      );
      if (!parent) {
        return {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            error: `Parent collection ${parentCollection} not found`,
          }),
        };
      }
      const childIDs = parent.getChildCollections(true);
      collections = Zotero.Collections.get(childIDs) as Zotero.Collection[];
    } else {
      // getByLibrary without the second parameter returns only top-level collections
      collections = Zotero.Collections.getByLibrary(libraryID) as Zotero.Collection[];
    }

    // Sorting
    collections.sort((a: any, b: any) => {
      const aVal = a[sort] || "";
      const bVal = b[sort] || "";
      if (aVal < bVal) return direction === "asc" ? -1 : 1;
      if (aVal > bVal) return direction === "asc" ? 1 : -1;
      return 0;
    });

    const total = collections.length;
    const paginated = collections.slice(offset, offset + limit);

    return collectionListResponse(
      paginated,
      { total, offset, limit },
      {
        scope: parentCollection
          ? { level: "children", parentCollection }
          : { level: "top" },
        sort,
        direction,
      },
    );
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const status = (error as any).status || 500;
    Zotero.logError(error);
    return {
      status,
      statusText: status === 400 ? "Bad Request" : "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: status === 400 ? error.message : "An unexpected error occurred" }),
    };
  }
}

/**
 * Handles GET /collections/search endpoint.
 * @param query - URL query parameters.
 * @returns A promise that resolves to an HttpResponse.
 */
export async function handleSearchCollections(
  query: URLSearchParams,
): Promise<HttpResponse> {
  try {
    const q = query.get("q");
    if (!q) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Missing query parameter 'q'" }),
      };
    }
    const libraryID = resolveLibraryID(query);
    const limit = parseInt(query.get("limit") || "100", 10);
    const offset = parseInt(query.get("offset") || "0", 10);

    const allCollections = Zotero.Collections.getByLibrary(libraryID, true) || [];
    const lowerCaseQuery = q.toLowerCase();

    const matchedCollections = allCollections.filter(
      (collection: Zotero.Collection) =>
        collection.name.toLowerCase().includes(lowerCaseQuery),
    );

    const collections = matchedCollections;
    const total = collections.length;
    const paginated = collections.slice(offset, offset + limit);

    return collectionListResponse(paginated, { total, offset, limit }, {
      query: q,
      matchedOn: "name",
    });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const status = (error as any).status || 500;
    Zotero.logError(error);
    return {
      status,
      statusText: status === 400 ? "Bad Request" : "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: status === 400 ? error.message : "An unexpected error occurred" }),
    };
  }
}

/**
 * Handles GET /collections/:collectionKey endpoint.
 * @param params - URL parameters.
 * @param query - URL query parameters.
 * @returns A promise that resolves to an HttpResponse.
 */
export async function handleGetCollectionDetails(
  params: Record<string, string>,
  query: URLSearchParams,
): Promise<HttpResponse> {
  try {
    const collectionKey = params[1];
    if (!collectionKey) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Missing collectionKey parameter" }),
      };
    }
    const libraryID = resolveLibraryID(query);

    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
      libraryID,
      collectionKey,
    );

    if (!collection) {
      return {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: `Collection with key ${collectionKey} not found`,
        }),
      };
    }

    const options = {
      includeItems: query.get("includeItems") === "true",
      includeSubcollections: query.get("includeSubcollections") === "true",
      itemsLimit: parseInt(query.get("itemsLimit") || "50", 10),
    };

    return {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(await formatCollectionDetails(collection, options)),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const status = (error as any).status || 500;
    Zotero.logError(error);
    return {
      status,
      statusText: status === 400 ? "Bad Request" : "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: status === 400 ? error.message : "An unexpected error occurred" }),
    };
  }
}

/**
 * Handles GET /collections/:collectionKey/items endpoint.
 * @param params - URL parameters.
 * @param query - URL query parameters.
 * @returns A promise that resolves to an HttpResponse.
 */
export async function handleGetCollectionItems(
  params: Record<string, string>,
  query: URLSearchParams,
): Promise<HttpResponse> {
  try {
    const collectionKey = params[1];
    ztoolkit.log(`[ApiHandlers] Getting collection items for key: ${collectionKey}`);
    
    if (!collectionKey) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Missing collectionKey parameter" }),
      };
    }
    const libraryID = resolveLibraryID(query);

    ztoolkit.log(`[ApiHandlers] Using libraryID: ${libraryID}`);

    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
      libraryID,
      collectionKey,
    );

    if (!collection) {
      ztoolkit.log(`[ApiHandlers] Collection not found: ${collectionKey} in library ${libraryID}`, "error");
      return {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: `Collection with key ${collectionKey} not found`,
        }),
      };
    }

    ztoolkit.log(`[ApiHandlers] Found collection: ${collection.name}`);

    const limit = parseInt(query.get("limit") || "100", 10);
    const offset = parseInt(query.get("offset") || "0", 10);
    const fields = query.get("fields")?.split(",");

    ztoolkit.log(`[ApiHandlers] Pagination: limit=${limit}, offset=${offset}`);
    ztoolkit.log(`[ApiHandlers] Fields requested: ${fields?.join(", ") || "default"}`);

    const itemIDs = collection.getChildItems(true);
    const total = itemIDs.length;
    ztoolkit.log(`[ApiHandlers] Collection contains ${total} items, IDs: [${itemIDs.slice(0, 5).join(", ")}${itemIDs.length > 5 ? "..." : ""}]`);
    
    const paginatedIDs = itemIDs.slice(offset, offset + limit);
    ztoolkit.log(`[ApiHandlers] Paginated IDs: [${paginatedIDs.join(", ")}]`);
    
    const items = Zotero.Items.get(paginatedIDs);
    ztoolkit.log(`[ApiHandlers] Retrieved ${items.length} item objects from Zotero`);

    ztoolkit.log(`[ApiHandlers] Starting formatItems...`);
    const formattedItems = await formatItems(items, fields);
    ztoolkit.log(`[ApiHandlers] Formatted ${formattedItems.length} items`);

    return {
      status: 200,
      statusText: "OK",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Total-Count": total.toString(),
      },
      body: JSON.stringify(formattedItems),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const status = (error as any).status || 500;
    ztoolkit.log(`[ApiHandlers] Error in handleGetCollectionItems: ${error.message}`, "error");
    ztoolkit.log(`[ApiHandlers] Error stack: ${error.stack}`, "error");
    Zotero.logError(error);
    return {
      status,
      statusText: status === 400 ? "Bad Request" : "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: status === 400 ? error.message : "An unexpected error occurred" }),
    };
  }
}

// REMOVED: handleGetSubcollections - it was handleGetCollections with
// parentCollection renamed, and became unreachable when the get_subcollections
// tool was removed. Use get_collections(parentCollection) or, to walk the
// library a level at a time, get_collection_items.

// REMOVED: handleGetPDFContent - attachment text is read with get_attachment_text


// REMOVED: handleSearchAnnotations - replaced by SmartAnnotationExtractor in MCP tools

/**
 * Handles GET /items/:itemKey/notes endpoint.
 * @param params - URL parameters, where params[1] is the itemKey.
 * @param query - URL query parameters.
 * @returns A promise that resolves to an HttpResponse.
 */
export async function handleGetItemNotes(
  params: Record<string, string>,
  query: URLSearchParams,
): Promise<HttpResponse> {
  const itemKey = params[1];
  if (!itemKey) {
    return {
      status: 400,
      statusText: "Bad Request",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Missing itemKey parameter" }),
    };
  }

  ztoolkit.log(`[MCP ApiHandlers] Getting notes for item ${itemKey}`);

  try {
    // Note: This function should be replaced by unified content tools
    // For now, return empty result to maintain compatibility
    const allNotes: any[] = [];

    // 添加分页支持
    const limit = Math.min(parseInt(query.get("limit") || "20", 10), 100);
    const offset = parseInt(query.get("offset") || "0", 10);
    const totalCount = allNotes.length;
    const paginatedNotes = allNotes.slice(offset, offset + limit);

    return {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        // 元数据在前
        pagination: {
          limit,
          offset,
          total: totalCount,
          hasMore: offset + limit < totalCount,
        },
        totalCount,
        version: "2.0",
        endpoint: "items/notes",
        itemKey,
        // 数据在后
        notes: paginatedNotes,
      }),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    ztoolkit.log(
      `[MCP ApiHandlers] Error in handleGetItemNotes: ${error.message}`,
      "error",
    );
    Zotero.logError(error);

    if (error.message.includes("not found")) {
      return {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: error.message }),
      };
    }

    return {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "An unexpected error occurred" }),
    };
  }
}

/**
 * Handles GET /items/:itemKey/annotations endpoint.
 * @param params - URL parameters, where params[1] is the itemKey.
 * @param query - URL query parameters.
 * @returns A promise that resolves to an HttpResponse.
 */
export async function handleGetItemAnnotations(
  params: Record<string, string>,
  query: URLSearchParams,
): Promise<HttpResponse> {
  const itemKey = params[1];
  if (!itemKey) {
    return {
      status: 400,
      statusText: "Bad Request",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Missing itemKey parameter" }),
    };
  }

  ztoolkit.log(`[MCP ApiHandlers] Getting annotations for item ${itemKey}`);

  try {
    // Note: This function should be replaced by SmartAnnotationExtractor
    // For now, return empty result to maintain compatibility
    const annotations: any[] = [];

    // Apply optional filtering
    let filteredAnnotations = annotations;

    const typeFilter = query.get("type");
    if (typeFilter) {
      const types = typeFilter.split(",").map((t) => t.trim());
      filteredAnnotations = annotations.filter((ann) =>
        types.includes(ann.type),
      );
    }

    const colorFilter = query.get("color");
    if (colorFilter) {
      filteredAnnotations = filteredAnnotations.filter(
        (ann) => ann.color === colorFilter,
      );
    }

    // 添加分页支持
    const limit = Math.min(parseInt(query.get("limit") || "20", 10), 100);
    const offset = parseInt(query.get("offset") || "0", 10);
    const totalCount = filteredAnnotations.length;
    const paginatedAnnotations = filteredAnnotations.slice(offset, offset + limit);

    return {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        // 元数据在前
        pagination: {
          limit,
          offset,
          total: totalCount,
          hasMore: offset + limit < totalCount,
        },
        totalCount,
        version: "2.0",
        endpoint: "items/annotations",
        itemKey,
        // 数据在后
        annotations: paginatedAnnotations,
      }),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    ztoolkit.log(
      `[MCP ApiHandlers] Error in handleGetItemAnnotations: ${error.message}`,
      "error",
    );
    Zotero.logError(error);

    if (error.message.includes("not found")) {
      return {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: error.message }),
      };
    }

    return {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "An unexpected error occurred" }),
    };
  }
}


// REMOVED: handleGetAnnotationById - replaced by SmartAnnotationExtractor in MCP tools

// REMOVED: handleGetAnnotationsBatch - replaced by SmartAnnotationExtractor in MCP tools

// REMOVED: handleGetItemFulltext - indexed bodies are read with get_document_chunks

// REMOVED: handleGetAttachmentContent - attachments are read with get_attachment_text

/**
 * Handles GET /search/fulltext endpoint.
 * @param query - URL query parameters.
 * @returns A promise that resolves to an HttpResponse.
 */
export async function handleSearchFulltext(
  query: URLSearchParams,
): Promise<HttpResponse> {
  const q = query.get("q");
  if (!q || q.trim().length === 0) {
    return {
      status: 400,
      statusText: "Bad Request",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Missing query parameter 'q'" }),
    };
  }

  ztoolkit.log(`[MCP ApiHandlers] Document-level hybrid search for: "${q}"`);

  try {
    const libraryID = resolveLibraryID(query);
    // Same document-level hybrid search the MCP tool uses, so REST and MCP
    // cannot drift into two different meanings of "search_fulltext".
    const itemKey =
      query.get("itemKey") ||
      (query.get("itemKeys") || "").split(",").map((k) => k.trim()).filter(Boolean)[0];
    if (!itemKey) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error:
            "itemKey is required: search_fulltext digs into one document located by hybrid_search. Whole-library full-text scanning is disabled.",
        }),
      };
    }

    const chunkIdsParam = query.get("chunkIds");
    const searchResult = chunkIdsParam
      ? await expandChunkContext({
          itemKey,
          libraryID,
          chunkIds: chunkIdsParam
            .split(",")
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isInteger(value)),
          radius: query.get("neighborRadius") ?? undefined,
        })
      : await runDocumentDeepDive({
          itemKey,
          libraryID,
          query: q,
          keywords: query.get("keywords")
            ? query.get("keywords")!.split(",").map((k) => k.trim()).filter(Boolean)
            : undefined,
          domain: query.get("domain") ?? undefined,
          expertRole: query.get("expertRole") ?? undefined,
          maxChunks: query.get("maxChunks") ?? undefined,
          minKeywordScore: query.get("minKeywordScore") ?? undefined,
          minSemanticScore: query.get("minSemanticScore") ?? undefined,
        });

    return {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(searchResult, null, 2),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const status = (error as any).status || 500;
    ztoolkit.log(
      `[MCP ApiHandlers] Error in handleSearchFulltext: ${error.message}`,
      "error",
    );
    Zotero.logError(error);

    return {
      status,
      statusText: status === 400 ? "Bad Request" : "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: status === 400 ? error.message : "An unexpected error occurred" }),
    };
  }
}

/**
 * Handles GET /items/:itemKey/abstract endpoint.
 * @param params - URL parameters, where params[1] is the itemKey.
 * @param query - URL query parameters.
 * @returns A promise that resolves to an HttpResponse.
 */
export async function handleGetItemAbstract(
  params: Record<string, string>,
  query: URLSearchParams,
): Promise<HttpResponse> {
  const itemKey = params[1];
  if (!itemKey) {
    return {
      status: 400,
      statusText: "Bad Request",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Missing itemKey parameter" }),
    };
  }

  ztoolkit.log(`[MCP ApiHandlers] Getting abstract for item ${itemKey}`);

  try {
    const libraryID = resolveLibraryID(query);
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
      libraryID,
      itemKey,
    );

    if (!item) {
      return {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: `Item with key ${itemKey} not found` }),
      };
    }

    const fulltextService = new FulltextService();
    const abstract = fulltextService.getItemAbstract(item);

    if (!abstract) {
      return {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "No abstract found for this item" }),
      };
    }

    const format = query.get("format") || "json";
    
    if (format === "text") {
      return {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: abstract,
      };
    } else {
      return {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          itemKey,
          title: item.getDisplayTitle(),
          abstract,
          length: abstract.length,
          extractedAt: new Date().toISOString()
        }, null, 2),
      };
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const status = (error as any).status || 500;
    ztoolkit.log(
      `[MCP ApiHandlers] Error in handleGetItemAbstract: ${error.message}`,
      "error",
    );
    Zotero.logError(error);

    return {
      status,
      statusText: status === 400 ? "Bad Request" : "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: status === 400 ? error.message : "An unexpected error occurred" }),
    };
  }
}

/**
 * Handles creating a new collection.
 */
export async function handleCreateCollection(
  body: { name: string; parentCollection?: string; libraryID?: number },
): Promise<HttpResponse> {
  try {
    if (!body.name || body.name.trim().length === 0) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Missing required parameter 'name'" }),
      };
    }

    const libraryID = body.libraryID ?? Zotero.Libraries.userLibraryID;
    const collection = new Zotero.Collection();
    (collection as any).libraryID = libraryID;
    collection.name = body.name.trim();

    if (body.parentCollection) {
      const parent = await Zotero.Collections.getByLibraryAndKeyAsync(
        libraryID,
        body.parentCollection,
      );
      if (!parent) {
        return {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            error: `Parent collection ${body.parentCollection} not found in library ${libraryID}`,
          }),
        };
      }
      collection.parentKey = body.parentCollection;
    }

    await collection.saveTx();
    ztoolkit.log(`[ApiHandlers] Created collection: ${collection.key} - ${collection.name}`);

    return {
      status: 201,
      statusText: "Created",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(formatCollectionBrief(collection)),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    Zotero.logError(error);
    return {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: error.message }),
    };
  }
}

/**
 * Handles updating an existing collection (rename/move).
 */
export async function handleUpdateCollection(
  params: Record<string, string>,
  body: { name?: string; parentCollection?: string; libraryID?: number },
): Promise<HttpResponse> {
  try {
    const collectionKey = params[1];
    if (!collectionKey) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Missing collectionKey parameter" }),
      };
    }

    if (body.name === undefined && body.parentCollection === undefined) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: "Provide name or parentCollection to update the collection",
        }),
      };
    }

    const libraryID = body.libraryID ?? Zotero.Libraries.userLibraryID;
    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
      libraryID,
      collectionKey,
    );

    if (!collection) {
      return {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: `Collection with key ${collectionKey} not found in library ${libraryID}`,
        }),
      };
    }

    if (body.name !== undefined) {
      if (body.name.trim().length === 0) {
        return {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ error: "Collection name cannot be empty" }),
        };
      }
      collection.name = body.name.trim();
    }

    if (body.parentCollection !== undefined) {
      if (body.parentCollection === "") {
        // Move to top level
        (collection as any).parentKey = false;
      } else {
        if (body.parentCollection === collectionKey) {
          return {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ error: "Cannot move a collection into itself" }),
          };
        }
        const parent = await Zotero.Collections.getByLibraryAndKeyAsync(
          libraryID,
          body.parentCollection,
        );
        if (!parent) {
          return {
            status: 404,
            statusText: "Not Found",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({
              error: `Parent collection ${body.parentCollection} not found in library ${libraryID}`,
            }),
          };
        }
        if (collection.hasDescendent("collection", parent.id)) {
          return {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({
              error: "Cannot move a collection into one of its descendants",
            }),
          };
        }
        collection.parentKey = body.parentCollection;
      }
    }

    await collection.saveTx();
    ztoolkit.log(`[ApiHandlers] Updated collection: ${collection.key} - ${collection.name}`);

    return {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(formatCollectionBrief(collection)),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    Zotero.logError(error);
    return {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: error.message }),
    };
  }
}

/**
 * Handles deleting a collection.
 */
export async function handleDeleteCollection(
  params: Record<string, string>,
  body: { deleteItems?: boolean; libraryID?: number },
): Promise<HttpResponse> {
  try {
    const collectionKey = params[1];
    if (!collectionKey) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Missing collectionKey parameter" }),
      };
    }

    const libraryID = body.libraryID ?? Zotero.Libraries.userLibraryID;
    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
      libraryID,
      collectionKey,
    );

    if (!collection) {
      return {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: `Collection with key ${collectionKey} not found in library ${libraryID}`,
        }),
      };
    }

    const name = collection.name;
    const numItems = collection.getChildItems(true).length;
    const numSubcollections = collection.getChildCollections(true).length;

    await collection.eraseTx({ deleteItems: body.deleteItems ?? false });
    ztoolkit.log(`[ApiHandlers] Deleted collection: ${collectionKey} - ${name}`);

    return {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        success: true,
        deleted: {
          key: collectionKey,
          name,
          numItems,
          numSubcollections,
          itemsDeleted: body.deleteItems ?? false,
        },
      }),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    Zotero.logError(error);
    return {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: error.message }),
    };
  }
}

/**
 * Handles adding items to a collection.
 */
export async function handleAddItemsToCollection(
  params: Record<string, string>,
  body: { itemKeys: string[]; libraryID?: number },
): Promise<HttpResponse> {
  try {
    const collectionKey = params[1];
    if (!collectionKey) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Missing collectionKey parameter" }),
      };
    }

    if (!body.itemKeys || !Array.isArray(body.itemKeys) || body.itemKeys.length === 0) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Missing or empty itemKeys array" }),
      };
    }

    const libraryID = body.libraryID ?? Zotero.Libraries.userLibraryID;
    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
      libraryID,
      collectionKey,
    );

    if (!collection) {
      return {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: `Collection with key ${collectionKey} not found in library ${libraryID}`,
        }),
      };
    }

    const added: string[] = [];
    const notFound: string[] = [];
    const alreadyInCollection: string[] = [];

    for (const itemKey of body.itemKeys) {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
      if (!item) {
        notFound.push(itemKey);
        continue;
      }
      if (collection.hasItem(item)) {
        alreadyInCollection.push(itemKey);
        continue;
      }
      added.push(itemKey);
    }

    if (added.length > 0) {
      const itemIDs = (await Promise.all(added.map(
        (key: string) => Zotero.Items.getByLibraryAndKeyAsync(libraryID, key),
      ))).map((item) => (item as Zotero.Item).id);
      await Zotero.DB.executeTransaction(async () => {
        await collection.addItems(itemIDs);
      });
    }

    ztoolkit.log(
      `[ApiHandlers] Added ${added.length} items to collection ${collectionKey}`,
    );

    const completedCount = added.length + alreadyInCollection.length;
    if (notFound.length > 0 && completedCount === 0) {
      return {
        status: 422,
        statusText: "Unprocessable Entity",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: `No items were added because none of these keys exist in library ${libraryID}: ${notFound.join(", ")}`,
          success: false,
          partial: false,
          collectionKey,
          added,
          notFound,
          alreadyInCollection,
        }),
      };
    }

    const partial = notFound.length > 0;
    return {
      status: partial ? 207 : 200,
      statusText: partial ? "Multi-Status" : "OK",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        success: !partial,
        partial,
        collectionKey,
        added,
        notFound,
        alreadyInCollection,
      }),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    Zotero.logError(error);
    return {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: error.message }),
    };
  }
}

/**
 * Handles removing items from a collection.
 */
export async function handleRemoveItemsFromCollection(
  params: Record<string, string>,
  body: { itemKeys: string[]; libraryID?: number },
): Promise<HttpResponse> {
  try {
    const collectionKey = params[1];
    if (!collectionKey) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Missing collectionKey parameter" }),
      };
    }

    if (!body.itemKeys || !Array.isArray(body.itemKeys) || body.itemKeys.length === 0) {
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Missing or empty itemKeys array" }),
      };
    }

    const libraryID = body.libraryID ?? Zotero.Libraries.userLibraryID;
    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
      libraryID,
      collectionKey,
    );

    if (!collection) {
      return {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: `Collection with key ${collectionKey} not found in library ${libraryID}`,
        }),
      };
    }

    const removed: string[] = [];
    const notFound: string[] = [];
    const notInCollection: string[] = [];

    for (const itemKey of body.itemKeys) {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
      if (!item) {
        notFound.push(itemKey);
        continue;
      }
      if (!collection.hasItem(item)) {
        notInCollection.push(itemKey);
        continue;
      }
      removed.push(itemKey);
    }

    if (removed.length > 0) {
      const itemIDs = (await Promise.all(removed.map(
        (key: string) => Zotero.Items.getByLibraryAndKeyAsync(libraryID, key),
      ))).map((item) => (item as Zotero.Item).id);
      await Zotero.DB.executeTransaction(async () => {
        await collection.removeItems(itemIDs);
      });
    }

    ztoolkit.log(
      `[ApiHandlers] Removed ${removed.length} items from collection ${collectionKey}`,
    );

    const completedCount = removed.length + notInCollection.length;
    if (notFound.length > 0 && completedCount === 0) {
      return {
        status: 422,
        statusText: "Unprocessable Entity",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: `No items were removed because none of these keys exist in library ${libraryID}: ${notFound.join(", ")}`,
          success: false,
          partial: false,
          collectionKey,
          removed,
          notFound,
          notInCollection,
        }),
      };
    }

    const partial = notFound.length > 0;
    return {
      status: partial ? 207 : 200,
      statusText: partial ? "Multi-Status" : "OK",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        success: !partial,
        partial,
        collectionKey,
        removed,
        notFound,
        notInCollection,
      }),
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    Zotero.logError(error);
    return {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: error.message }),
    };
  }
}

/**
 * Move items into one collection, taking them out of every other one.
 *
 * This is the operation a library reorganisation is actually made of, and it
 * did not exist. Callers had to compose `remove_items_from_collection` and
 * `add_items_to_collection`, which is two round trips, two confirmation
 * prompts, and — when the second one fails or the client stops in between — a
 * library left in a state nobody described: the document filed in both places
 * at once, or in neither.
 *
 * PREFLIGHT THEN COMMIT. Every key is validated before anything is written,
 * and a single bad entry aborts the whole batch without touching the library.
 * The alternative — moving what can be moved and reporting the rest — leaves
 * the caller holding a half-applied plan whose remainder it has to reconstruct
 * from a receipt. A plan that cannot be executed as written is a plan to
 * revise, not to partially apply.
 *
 * `dryRun` runs the preflight and reports exactly what WOULD happen, writing
 * nothing. It is the same code path, so a dry run that passes is a real
 * guarantee about the commit that follows, not a separate opinion about it.
 */
export async function handleMoveItemsToCollection(
  params: Record<string, string>,
  body: { itemKeys: string[]; libraryID?: number; dryRun?: boolean },
): Promise<HttpResponse> {
  const json = (status: number, statusText: string, payload: any): HttpResponse => ({
    status,
    statusText,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });

  try {
    const toCollectionKey = params[1];
    if (!toCollectionKey) {
      return json(400, "Bad Request", {
        error: "Missing toCollectionKey parameter",
      });
    }

    if (!body.itemKeys || !Array.isArray(body.itemKeys) || body.itemKeys.length === 0) {
      return json(400, "Bad Request", { error: "Missing or empty itemKeys array" });
    }

    const libraryID = body.libraryID ?? Zotero.Libraries.userLibraryID;
    const target = await Zotero.Collections.getByLibraryAndKeyAsync(
      libraryID,
      toCollectionKey,
    );

    if (!target) {
      return json(404, "Not Found", {
        error: `Target collection ${toCollectionKey} not found in library ${libraryID}. Create it with create_collection, or list the existing folders with get_collections.`,
      });
    }

    const targetPath = collectionPath(target);

    // --- Resolve every key against the library, judge nothing yet ---
    const items = new Map<string, Zotero.Item>();
    const candidates: MoveCandidate[] = [];

    for (const itemKey of body.itemKeys) {
      if (items.has(itemKey)) {
        // A repeated key needs no second lookup; planCollectionMove collapses
        // it and reports the count.
        candidates.push({ itemKey, found: true });
        continue;
      }
      const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
      if (!item) {
        candidates.push({ itemKey, found: false });
        continue;
      }
      items.set(itemKey, item);
      candidates.push({
        itemKey,
        found: true,
        title: String(item.getField("title") || ""),
        // A child note or attachment lives under its parent, not in a folder.
        isChildItem: Boolean(item.parentItemID),
        inTrash: Boolean(item.deleted),
        collections: describeItemCollections(item),
      });
    }

    const planned = planCollectionMove(candidates, toCollectionKey);

    if (!planned.ok) {
      return json(422, "Unprocessable Entity", {
        error:
          "The batch was rejected before anything was written: some items cannot be moved. Nothing in your library changed. Fix or drop these entries and call again.",
        preflight: "failed",
        applied: false,
        toCollection: { collectionKey: toCollectionKey, path: targetPath },
        notFound: planned.notFound,
        notFilable: planned.notFilable,
        wouldHaveMoved: planned.wouldHaveMoved,
      });
    }

    const { rows, summary } = planned;

    if (body.dryRun) {
      return json(200, "OK", {
        preflight: "passed",
        applied: false,
        dryRun: true,
        toCollection: { collectionKey: toCollectionKey, path: targetPath },
        summary,
        plan: rows,
      });
    }

    // --- Commit: one transaction, so a failure leaves nothing half-moved ---
    // Collections are resolved by key up front: inside the transaction a
    // lookup miss would abort a batch that had already been half-applied.
    const leavingByItem = new Map<string, Zotero.Collection[]>();
    for (const row of rows) {
      const item = items.get(row.itemKey) as Zotero.Item;
      const sources = (describeItemCollections(item) || [])
        .filter((entry) => entry.collectionKey !== toCollectionKey)
        .map((entry) =>
          Zotero.Collections.getByLibraryAndKey(libraryID, entry.collectionKey),
        )
        .filter(Boolean) as unknown as Zotero.Collection[];
      leavingByItem.set(row.itemKey, sources);
    }

    await Zotero.DB.executeTransaction(async () => {
      for (const row of rows) {
        const item = items.get(row.itemKey) as Zotero.Item;
        if (!row.alreadyInTarget) {
          await target.addItems([item.id]);
        }
        for (const source of leavingByItem.get(row.itemKey) ?? []) {
          await (source as any).removeItems([item.id]);
        }
      }
    });

    ztoolkit.log(
      `[ApiHandlers] Moved ${rows.length} items into collection ${toCollectionKey}`,
    );

    return json(200, "OK", {
      success: true,
      preflight: "passed",
      applied: true,
      toCollection: { collectionKey: toCollectionKey, path: targetPath },
      summary,
      plan: rows,
    });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    Zotero.logError(error);
    return json(500, "Internal Server Error", {
      error: error.message,
      applied: false,
      note: "The move runs in a single transaction, so a failure here means nothing was written.",
    });
  }
}

/**
 * Merge groups of duplicate records, keeping one survivor per group.
 *
 * Deleting a duplicate and merging one are not the same operation, and the
 * difference is why this tool exists instead of a `delete_item`. Zotero's
 * merge moves the losing records' attachments, notes and annotations onto the
 * survivor, unions their collection memberships, and — critically — records a
 * `dc:replaces` relation so that a citation in an existing document that
 * points at a losing key still resolves. A plain delete throws all three away,
 * and the broken citation does not surface until the manuscript is next
 * refreshed.
 *
 * NO OUTER TRANSACTION, on purpose. `Zotero.Items.merge` opens its own, so
 * each group is atomic by itself; wrapping the batch would nest transactions
 * on an assumption this plugin cannot verify from the type definitions. The
 * cost is that a mid-batch failure leaves earlier groups merged — but a
 * completed merge is a consistent state, not a half-written one, so the
 * receipt names exactly which groups were applied and the rest can simply be
 * requested again.
 */
export async function handleMergeItems(
  body: {
    groups: Array<{ itemKeys: string[]; masterItemKey?: string }>;
    libraryID?: number;
    dryRun?: boolean;
  },
): Promise<HttpResponse> {
  const json = (status: number, statusText: string, payload: any): HttpResponse => ({
    status,
    statusText,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });

  try {
    if (!Array.isArray(body.groups) || body.groups.length === 0) {
      return json(400, "Bad Request", {
        error:
          'groups is required: an array of { itemKeys, masterItemKey? }, one entry per set of duplicates.',
      });
    }

    const libraryID = body.libraryID ?? Zotero.Libraries.userLibraryID;
    const items = new Map<string, Zotero.Item>();

    // Resolve every key first; judge nothing here.
    const inputs: MergeGroupInput[] = [];
    for (const group of body.groups) {
      const candidates: MergeCandidate[] = [];
      for (const itemKey of group?.itemKeys ?? []) {
        if (items.has(itemKey)) {
          candidates.push(buildMergeCandidate(items.get(itemKey) as Zotero.Item));
          continue;
        }
        const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
        if (!item) {
          candidates.push({ itemKey, found: false });
          continue;
        }
        items.set(itemKey, item);
        candidates.push(buildMergeCandidate(item));
      }
      inputs.push({ candidates, masterItemKey: group?.masterItemKey });
    }

    const planned = planItemMerge(inputs);

    if (!planned.ok) {
      return json(422, "Unprocessable Entity", {
        error:
          "The batch was rejected before anything was written: some groups cannot be merged. Nothing in your library changed. Fix or drop these groups and call again.",
        preflight: "failed",
        applied: false,
        problems: planned.problems,
        wouldHaveMerged: planned.wouldHaveMerged,
      });
    }

    if (body.dryRun) {
      return json(200, "OK", {
        preflight: "passed",
        applied: false,
        dryRun: true,
        summary: planned.summary,
        groups: planned.groups,
      });
    }

    // --- Commit, group by group ---
    const merged: string[] = [];
    let failure: { masterItemKey: string; error: string } | null = null;

    for (const plan of planned.groups) {
      try {
        const master = items.get(plan.masterItemKey) as Zotero.Item;
        const others = plan.merging.map(
          (row) => items.get(row.itemKey) as Zotero.Item,
        );
        await (Zotero.Items as any).merge(master, others);
        merged.push(plan.masterItemKey);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        Zotero.logError(error);
        failure = { masterItemKey: plan.masterItemKey, error: error.message };
        break;
      }
    }

    ztoolkit.log(
      `[ApiHandlers] Merged ${merged.length}/${planned.groups.length} duplicate groups`,
    );

    if (failure) {
      return json(207, "Multi-Status", {
        success: false,
        preflight: "passed",
        applied: "partial",
        mergedGroups: merged,
        stoppedAt: failure,
        remaining: planned.groups.length - merged.length,
        note: "Each group is merged atomically, so the groups listed in mergedGroups are complete and the rest were not started. Call again with the remaining groups.",
      });
    }

    return json(200, "OK", {
      success: true,
      preflight: "passed",
      applied: true,
      summary: planned.summary,
      mergedGroups: merged,
      groups: planned.groups,
    });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    Zotero.logError(error);
    return json(500, "Internal Server Error", {
      error: error.message,
      applied: false,
    });
  }
}

/** Everything the merge planner needs to judge one record. */
function buildMergeCandidate(item: Zotero.Item): MergeCandidate {
  const fields: Record<string, string> = {};
  for (const field of [
    "DOI",
    "abstractNote",
    "publicationTitle",
    "date",
    "pages",
    "volume",
    "issue",
    "url",
    "ISSN",
    "ISBN",
    "language",
    "publisher",
    "bookTitle",
    "conferenceName",
  ]) {
    try {
      const value = item.getField(field as any);
      if (value !== null && value !== undefined && String(value).trim()) {
        fields[field] = String(value);
      }
    } catch {
      // Not a field this item type has; absence is the answer.
    }
  }

  let attachmentCount = 0;
  try {
    attachmentCount = (item.getAttachments() || []).length;
  } catch {
    attachmentCount = 0;
  }

  return {
    itemKey: item.key,
    found: true,
    title: String(item.getField("title") || ""),
    itemType: item.itemType,
    isChildItem: Boolean(item.parentItemID),
    inTrash: Boolean(item.deleted),
    fields,
    creatorCount: (item.getCreators() || []).length,
    attachmentCount,
    collections: describeItemCollections(item),
    dateAdded: String(item.dateAdded || ""),
  };
}
