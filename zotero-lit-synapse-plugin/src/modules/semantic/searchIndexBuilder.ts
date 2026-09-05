import {
  bodyIndexStateFromSourceKind,
  fullTextAvailabilityFromState,
  type FullTextAvailability,
} from "./bodyIndexState";
import type { IndexProgress } from "./semanticSearchService";
import type { FailedIndexItem, IndexStatus } from "./vectorStore";

export const MAX_SEARCH_INDEX_BUILD_ITEMS = 100;

export type SearchIndexBranchStatus =
  | "success"
  | "metadata_only"
  | "failed"
  | "not_built";

export interface SearchIndexItemResult {
  libraryID: number;
  itemKey: string;
  status:
    | "success"
    | "partial_failure"
    | "parse_failed"
    | "no_source"
    | "failed"
    | "busy";
  fullText: FullTextAvailability;
  semantic: {
    status: SearchIndexBranchStatus;
    chunks: number;
    error?: string;
  };
  keyword: {
    status: SearchIndexBranchStatus;
    error?: string;
  };
}

export interface SearchIndexBuildResult {
  libraryID: number;
  requested: number;
  buildStatus: IndexProgress["status"];
  items: SearchIndexItemResult[];
  totals: {
    success: number;
    partialFailure: number;
    parseFailed: number;
    noSource: number;
    failed: number;
    busy: number;
  };
}

export interface SearchIndexBuilderDeps {
  buildIndex(options: {
    itemKeys: string[];
    libraryID: number;
    rebuild: false;
    force: true;
  }): Promise<IndexProgress>;
  getIndexStatus(
    itemKey: string,
    libraryID: number,
  ): Promise<IndexStatus | null>;
  getKeywordItemKeys(libraryID: number): Promise<Set<string>>;
  getFailedItems(): Promise<FailedIndexItem[]>;
}

function totals(
  items: SearchIndexItemResult[],
): SearchIndexBuildResult["totals"] {
  return {
    success: items.filter((item) => item.status === "success").length,
    partialFailure: items.filter((item) => item.status === "partial_failure")
      .length,
    parseFailed: items.filter((item) => item.status === "parse_failed").length,
    noSource: items.filter((item) => item.status === "no_source").length,
    failed: items.filter((item) => item.status === "failed").length,
    busy: items.filter((item) => item.status === "busy").length,
  };
}

export async function buildSearchIndex(
  options: { libraryID: number; itemKeys: string[] },
  deps: SearchIndexBuilderDeps,
): Promise<SearchIndexBuildResult> {
  if (!Number.isInteger(options.libraryID) || options.libraryID <= 0) {
    throw new Error("libraryID must be a positive integer");
  }
  const itemKeys = Array.from(
    new Set(options.itemKeys.map((key) => key.trim()).filter(Boolean)),
  );
  if (itemKeys.length === 0) throw new Error("itemKeys must not be empty");
  if (itemKeys.length > MAX_SEARCH_INDEX_BUILD_ITEMS) {
    throw new Error(
      `build_search_index accepts at most ${MAX_SEARCH_INDEX_BUILD_ITEMS} itemKeys per call`,
    );
  }

  const build = await deps.buildIndex({
    itemKeys,
    libraryID: options.libraryID,
    rebuild: false,
    force: true,
  });
  if (
    build.status === "busy" ||
    build.status === "paused" ||
    build.status === "aborted" ||
    build.status === "error" ||
    build.status === "indexing"
  ) {
    const blockedStatus = build.status === "busy" ? "busy" : "failed";
    const items = itemKeys.map<SearchIndexItemResult>((itemKey) => ({
      libraryID: options.libraryID,
      itemKey,
      status: blockedStatus,
      fullText: "not_indexed",
      semantic: {
        status: build.status === "busy" ? "not_built" : "failed",
        chunks: 0,
        ...(build.error ? { error: build.error } : {}),
      },
      keyword: {
        status: "not_built",
        ...(build.error ? { error: build.error } : {}),
      },
    }));
    return {
      libraryID: options.libraryID,
      requested: itemKeys.length,
      buildStatus: build.status,
      items,
      totals: totals(items),
    };
  }

  const [keywordKeys, failures, statuses] = await Promise.all([
    deps.getKeywordItemKeys(options.libraryID),
    deps.getFailedItems(),
    Promise.all(
      itemKeys.map((itemKey) =>
        deps.getIndexStatus(itemKey, options.libraryID),
      ),
    ),
  ]);
  const failureByKey = new Map(
    failures
      .filter((failure) => failure.libraryID === options.libraryID)
      .map((failure) => [failure.itemKey, failure]),
  );

  const items = itemKeys.map<SearchIndexItemResult>((itemKey, index) => {
    const indexStatus = statuses[index];
    const failure = failureByKey.get(itemKey);
    const keywordPresent = keywordKeys.has(itemKey);
    const bodyState = bodyIndexStateFromSourceKind(indexStatus?.sourceKind);
    const fullText = fullTextAvailabilityFromState(bodyState);
    const chunkCount = Number(indexStatus?.chunkCount ?? 0);
    const keywordFailure =
      failure && /keyword index write failed/iu.test(failure.error);

    if (keywordFailure && indexStatus) {
      return {
        libraryID: options.libraryID,
        itemKey,
        status: "partial_failure",
        fullText,
        semantic: { status: "success", chunks: chunkCount },
        keyword: { status: "failed", error: failure.error },
      };
    }
    if (failure || !indexStatus) {
      const message =
        failure?.error ??
        build.error ??
        "The targeted index build did not produce an index status row";
      return {
        libraryID: options.libraryID,
        itemKey,
        status: "failed",
        fullText,
        semantic: { status: "failed", chunks: chunkCount, error: message },
        keyword: {
          status: keywordPresent ? "success" : "not_built",
          ...(keywordPresent ? {} : { error: message }),
        },
      };
    }

    const metadataOnly =
      fullText === "parse_failed" || fullText === "no_source";
    if (!keywordPresent) {
      return {
        libraryID: options.libraryID,
        itemKey,
        status: "partial_failure",
        fullText,
        semantic: {
          status: metadataOnly ? "metadata_only" : "success",
          chunks: chunkCount,
        },
        keyword: {
          status: "failed",
          error: "The unified build produced no live keyword-index row",
        },
      };
    }
    return {
      libraryID: options.libraryID,
      itemKey,
      status:
        fullText === "parse_failed"
          ? "parse_failed"
          : fullText === "no_source"
            ? "no_source"
            : "success",
      fullText,
      semantic: {
        status: metadataOnly ? "metadata_only" : "success",
        chunks: chunkCount,
      },
      keyword: { status: metadataOnly ? "metadata_only" : "success" },
    };
  });

  return {
    libraryID: options.libraryID,
    requested: itemKeys.length,
    buildStatus: build.status,
    items,
    totals: totals(items),
  };
}
