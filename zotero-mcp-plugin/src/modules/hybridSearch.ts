export interface KeywordSearchItem {
  key: string;
  title?: string;
  relevanceScore?: number;
  matchedFields?: string[];
}

export interface SemanticSearchItem {
  itemKey: string;
  title?: string;
  score?: number;
  matchedChunks?: Array<{
    chunkId: number;
    text: string;
    score: number;
  }>;
}

export interface HybridSearchOptions {
  topK: number;
  candidateK: number;
  rrfK: number;
  keywordWeight: number;
  semanticWeight: number;
}

export interface HybridSearchResult extends Record<string, unknown> {
  itemKey: string;
  rrfScore: number;
  keywordRank?: number;
  semanticRank?: number;
  keywordScore?: number;
  semanticScore?: number;
  matchedChunks?: SemanticSearchItem["matchedChunks"];
}

export interface HybridSearchRunResult {
  results: HybridSearchResult[];
  degraded: boolean;
  warnings: string[];
  keywordResultCount: number;
  semanticResultCount: number;
}

interface HybridSearchDependencies {
  keywordSearch: () => Promise<KeywordSearchItem[]>;
  semanticSearch: () => Promise<SemanticSearchItem[]>;
}

interface FusedCandidate {
  itemKey: string;
  keywordItem?: KeywordSearchItem;
  semanticItem?: SemanticSearchItem;
  keywordRank?: number;
  semanticRank?: number;
  rrfScore: number;
}

function validateFiniteNumber(
  value: number,
  name: string,
  minimum: number,
): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(
      `${name} must be a finite number greater than or equal to ${minimum}`,
    );
  }
}

export function validateHybridSearchOptions(
  options: HybridSearchOptions,
): void {
  validateFiniteNumber(options.topK, "topK", 1);
  validateFiniteNumber(options.candidateK, "candidateK", options.topK);
  validateFiniteNumber(options.rrfK, "rrfK", 1);
  validateFiniteNumber(options.keywordWeight, "keywordWeight", 0);
  validateFiniteNumber(options.semanticWeight, "semanticWeight", 0);

  if (options.keywordWeight === 0 && options.semanticWeight === 0) {
    throw new Error("keywordWeight and semanticWeight cannot both be zero");
  }
}

export function fuseHybridSearchResults(
  keywordResults: KeywordSearchItem[],
  semanticResults: SemanticSearchItem[],
  options: Pick<
    HybridSearchOptions,
    "topK" | "rrfK" | "keywordWeight" | "semanticWeight"
  >,
): HybridSearchResult[] {
  validateFiniteNumber(options.topK, "topK", 1);
  validateFiniteNumber(options.rrfK, "rrfK", 1);
  validateFiniteNumber(options.keywordWeight, "keywordWeight", 0);
  validateFiniteNumber(options.semanticWeight, "semanticWeight", 0);

  const candidates = new Map<string, FusedCandidate>();

  if (options.keywordWeight > 0) {
    keywordResults.forEach((item, index) => {
      if (!item.key || candidates.get(item.key)?.keywordItem) return;
      const rank = index + 1;
      const existing = candidates.get(item.key) || {
        itemKey: item.key,
        rrfScore: 0,
      };
      existing.keywordItem = item;
      existing.keywordRank = rank;
      existing.rrfScore += options.keywordWeight / (options.rrfK + rank);
      candidates.set(item.key, existing);
    });
  }

  if (options.semanticWeight > 0) {
    semanticResults.forEach((item, index) => {
      if (!item.itemKey || candidates.get(item.itemKey)?.semanticItem) return;
      const rank = index + 1;
      const existing = candidates.get(item.itemKey) || {
        itemKey: item.itemKey,
        rrfScore: 0,
      };
      existing.semanticItem = item;
      existing.semanticRank = rank;
      existing.rrfScore += options.semanticWeight / (options.rrfK + rank);
      candidates.set(item.itemKey, existing);
    });
  }

  return Array.from(candidates.values())
    .sort((a, b) => {
      const scoreDifference = b.rrfScore - a.rrfScore;
      if (scoreDifference !== 0) return scoreDifference;

      const aSourceCount =
        Number(Boolean(a.keywordItem)) + Number(Boolean(a.semanticItem));
      const bSourceCount =
        Number(Boolean(b.keywordItem)) + Number(Boolean(b.semanticItem));
      if (aSourceCount !== bSourceCount) return bSourceCount - aSourceCount;

      const aBestRank = Math.min(
        a.keywordRank ?? Infinity,
        a.semanticRank ?? Infinity,
      );
      const bBestRank = Math.min(
        b.keywordRank ?? Infinity,
        b.semanticRank ?? Infinity,
      );
      if (aBestRank !== bBestRank) return aBestRank - bBestRank;

      return a.itemKey.localeCompare(b.itemKey);
    })
    .slice(0, options.topK)
    .map((candidate) => {
      const keywordItem = candidate.keywordItem;
      const semanticItem = candidate.semanticItem;
      const base = keywordItem
        ? { ...keywordItem }
        : semanticItem
          ? { ...semanticItem }
          : {};

      delete (base as Record<string, unknown>).key;
      delete (base as Record<string, unknown>).score;

      return {
        ...base,
        itemKey: candidate.itemKey,
        title: keywordItem?.title || semanticItem?.title || "",
        rrfScore: candidate.rrfScore,
        keywordRank: candidate.keywordRank,
        semanticRank: candidate.semanticRank,
        keywordScore: keywordItem?.relevanceScore,
        semanticScore: semanticItem?.score,
        matchedChunks: semanticItem?.matchedChunks,
      };
    });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runHybridSearch(
  options: HybridSearchOptions & { query: string },
  dependencies: HybridSearchDependencies,
): Promise<HybridSearchRunResult> {
  validateHybridSearchOptions(options);

  const keywordPromise =
    options.keywordWeight > 0
      ? dependencies.keywordSearch()
      : Promise.resolve<KeywordSearchItem[]>([]);
  const semanticPromise =
    options.semanticWeight > 0
      ? dependencies.semanticSearch()
      : Promise.resolve<SemanticSearchItem[]>([]);
  const [keywordOutcome, semanticOutcome] = await Promise.allSettled([
    keywordPromise,
    semanticPromise,
  ]);

  if (
    keywordOutcome.status === "rejected" &&
    semanticOutcome.status === "rejected"
  ) {
    throw new Error(
      `Hybrid search failed: keyword search: ${errorMessage(keywordOutcome.reason)}; semantic search: ${errorMessage(semanticOutcome.reason)}`,
    );
  }

  const warnings: string[] = [];
  const keywordResults =
    keywordOutcome.status === "fulfilled" ? keywordOutcome.value : [];
  const semanticResults =
    semanticOutcome.status === "fulfilled" ? semanticOutcome.value : [];

  if (keywordOutcome.status === "rejected") {
    warnings.push(
      `Keyword metadata search unavailable: ${errorMessage(keywordOutcome.reason)}`,
    );
  }
  if (semanticOutcome.status === "rejected") {
    warnings.push(
      `Semantic search unavailable: ${errorMessage(semanticOutcome.reason)}`,
    );
  }

  return {
    results: fuseHybridSearchResults(keywordResults, semanticResults, options),
    degraded: warnings.length > 0,
    warnings,
    keywordResultCount: keywordResults.length,
    semanticResultCount: semanticResults.length,
  };
}
