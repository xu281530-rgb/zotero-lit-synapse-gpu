declare const Zotero: any;

interface IndexedContentMetadata {
  itemKey: string;
  libraryID: number;
  contentLength: number;
  hash: string;
  indexedAt: number;
  sourceKind: string;
}

interface FulltextDatabaseDependencies {
  vectorStore: {
    initialize(): Promise<void>;
    listIndexedContentMetadata(
      libraryID: number,
      limit: number,
    ): Promise<{ total: number; items: IndexedContentMetadata[] }>;
    getStats(libraryID?: number): Promise<{
      totalItems: number;
      totalVectors: number;
      zhVectors: number;
      enVectors: number;
      cachedContentItems: number;
      cachedContentSizeBytes: number;
    }>;
  };
  fulltextService: {
    searchFulltext(query: string, options: any): Promise<any>;
    getItemFulltextText(
      itemKey: string,
      libraryID: number,
    ): Promise<{
      content: string | null;
      contentLength: number;
      sources: string[];
    }>;
  };
}

export interface FulltextDatabaseRequest {
  action: "list" | "search" | "get" | "stats";
  query?: string;
  itemKeys?: string[];
  libraryID?: number;
  limit?: number;
  caseSensitive?: boolean;
}

function normalizeItemKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((key): key is string => typeof key === "string")
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeLimit(value: unknown, fallback = 20): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(1000, Math.floor(number))
    : fallback;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export class FulltextDatabaseService {
  private readonly dependencies: FulltextDatabaseDependencies;

  constructor(dependencies: FulltextDatabaseDependencies) {
    this.dependencies = dependencies;
  }

  async execute(request: FulltextDatabaseRequest): Promise<any> {
    const libraryID = request.libraryID ?? Zotero.Libraries.userLibraryID;
    const limit = normalizeLimit(request.limit);
    const itemKeys = normalizeItemKeys(request.itemKeys);
    await this.dependencies.vectorStore.initialize();

    if (request.action === "list") {
      const listed = await this.dependencies.vectorStore.listIndexedContentMetadata(
        libraryID,
        limit,
      );
      return {
        action: "list",
        data: listed.items.map((item) => ({
          ...item,
          cachedAt: item.indexedAt,
          storageMode: "on-demand",
        })),
        metadata: {
          extractedAt: new Date().toISOString(),
          totalCached: listed.total,
          returned: listed.items.length,
          storageMode: "on-demand",
          sqliteBodyCopies: 0,
          message: `Found ${listed.total} indexed items available on demand`,
        },
      };
    }

    if (request.action === "search") {
      if (typeof request.query !== "string" || !request.query.trim()) {
        throw new Error("query is required for search action");
      }
      if (itemKeys.length === 0) {
        throw new Error(
          "itemKeys from hybrid_search are required for search; whole-library full-text scanning is disabled",
        );
      }
      const searched = await this.dependencies.fulltextService.searchFulltext(
        request.query,
        {
          libraryID,
          itemKeys,
          maxResults: limit,
          caseSensitive: request.caseSensitive === true,
        },
      );
      const results = (searched.results || []).map((result: any) => ({
        itemKey: result.itemKey,
        title: result.title,
        snippet: result.matches?.[0]?.context || "",
        matchCount: Number(result.totalMatches || 0),
        matches: result.matches || [],
      }));
      return {
        action: "search",
        query: request.query,
        data: results,
        metadata: {
          extractedAt: new Date().toISOString(),
          resultCount: results.length,
          caseSensitive: request.caseSensitive === true,
          searchedCandidates: itemKeys.length,
          storageMode: "on-demand",
          sqliteBodyCopies: 0,
          message: `Found ${results.length} items matching "${request.query}"`,
        },
      };
    }

    if (request.action === "get") {
      if (itemKeys.length === 0) {
        throw new Error("itemKeys is required for get action");
      }
      const results = [];
      for (const itemKey of itemKeys) {
        try {
          const resolved =
            await this.dependencies.fulltextService.getItemFulltextText(
              itemKey,
              libraryID,
            );
          results.push({ itemKey, ...resolved });
        } catch {
          results.push({
            itemKey,
            content: null,
            contentLength: 0,
            sources: [],
          });
        }
      }
      const found = results.filter((result) => result.content !== null).length;
      return {
        action: "get",
        data: results,
        metadata: {
          extractedAt: new Date().toISOString(),
          requested: itemKeys.length,
          found,
          storageMode: "on-demand",
          sqliteBodyCopies: 0,
          message: `Retrieved content for ${found}/${itemKeys.length} items`,
        },
      };
    }

    if (request.action === "stats") {
      const [stats, indexed] = await Promise.all([
        // Same library as `indexed` below: this action already answers for one
        // library, so its vector counts must be that library's too.
        this.dependencies.vectorStore.getStats(libraryID),
        this.dependencies.vectorStore.listIndexedContentMetadata(libraryID, 0),
      ]);
      return {
        action: "stats",
        data: {
          cachedItems: 0,
          cachedContentSize: 0,
          cachedContentSizeFormatted: formatSize(0),
          indexedItems: indexed.total,
          totalVectors: stats.totalVectors,
          zhVectors: stats.zhVectors,
          enVectors: stats.enVectors,
          storageMode: "on-demand",
          sqliteBodyCopies: 0,
        },
        metadata: {
          extractedAt: new Date().toISOString(),
          storageMode: "on-demand",
          sqliteBodyCopies: 0,
          message: `Full text is resolved on demand for ${indexed.total} indexed items`,
        },
      };
    }

    throw new Error(
      `Unknown action: ${request.action}. Use list, search, get, or stats.`,
    );
  }
}

export async function createFulltextDatabaseService(): Promise<FulltextDatabaseService> {
  const [{ getVectorStore }, { fulltextService }] = await Promise.all([
    import("./semantic/vectorStore"),
    import("./fulltextService"),
  ]);
  return new FulltextDatabaseService({
    vectorStore: getVectorStore(),
    fulltextService,
  });
}
