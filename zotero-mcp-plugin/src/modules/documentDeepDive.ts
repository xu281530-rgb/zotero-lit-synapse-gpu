/**
 * Document-level hybrid search — the second stage of retrieval.
 *
 * 第一阶段 hybrid_search 在整个文献库里找出「哪几篇相关」；这一阶段在**某一篇**
 * 文献的全部 chunk 里找出「哪几段是证据」。两个阶段共用同一套东西：
 *
 *   - 关键词处理     normalizeKeywords / resolveHybridKeywords
 *   - 关键词排序     rankLexicalCandidates（只换一张字段权重表）
 *   - 语义检索       SemanticSearchService（同一个 embedding + 同一个向量库）
 *   - 融合与阈值     runHybridSearch / fuseHybridSearchResultsDetailed
 *   - 超时/取消      runHybridSearch 的 settleWithTimeout + cancel 钩子
 *   - fallback 判定  resolveKeywordProvenance
 *
 * 这里没有第二套检索体系，只有「候选集合从文献换成 chunk」这一个区别。
 */

import {
  CHUNK_FIELD_WEIGHTS,
  DEFAULT_HYBRID_TIMEOUT_MS,
  DEFAULT_SEMANTIC_TIMEOUT_MS,
  rankLexicalCandidates,
  resolveHybridKeywords,
  resolveKeywordProvenance,
  runHybridSearch,
  type KeywordProvenance,
  type KeywordSearchItem,
  type LexicalCandidate,
  type SemanticSearchItem,
} from "./hybridSearch";
import {
  getHybridSearchSettings,
  resolveNeighborRadius,
  resolveResultCap,
  resolveScoreFloor,
} from "./hybridSearchSettings";
import { getSemanticSearchService } from "./semantic";

declare const Zotero: any;
declare let ztoolkit: ZToolkit;

/** Chunks past this are still scanned, but only this many reach fusion. */
const MAX_CHUNK_CANDIDATES = 500;

export interface DeepDiveRequest {
  itemKey: string;
  libraryID?: number;
  query: string;
  keywords?: unknown;
  domain?: unknown;
  expertRole?: unknown;
  maxChunks?: unknown;
  minScore?: unknown;
  keywordWeight?: number;
  semanticWeight?: number;
  rrfK?: number;
  semanticTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface DeepDiveChunk {
  chunkId: number;
  text: string;
  score: number;
  normalizedKeywordScore?: number;
  normalizedSemanticScore?: number;
  keywordScore?: number;
  semanticScore?: number;
  matchedKeywords?: string[];
  keywordRank?: number;
  semanticRank?: number;
}

export interface DeepDiveResult {
  mode: "document_hybrid";
  itemKey: string;
  libraryID: number;
  title: string;
  query: string;
  keywords: string[];
  keywordSource: KeywordProvenance["keywordSource"];
  chunks: DeepDiveChunk[];
  totalChunks: number;
  degraded: boolean;
  warnings: string[];
  warning?: string;
  metadata: Record<string, unknown>;
}

export interface ChunkContextRequest {
  itemKey: string;
  libraryID?: number;
  chunkIds: number[];
  radius?: unknown;
}

export interface ChunkContextResult {
  mode: "chunk_context";
  itemKey: string;
  libraryID: number;
  title: string;
  totalChunks: number;
  appliedRadius: number;
  chunks: Array<{
    chunkId: number;
    text: string;
    /** "anchor" = one of the requested chunks, "context" = pulled in around it. */
    role: "anchor" | "context";
  }>;
  degraded: boolean;
  warnings: string[];
  metadata: Record<string, unknown>;
}

async function resolveItem(itemKey: string, libraryID: number): Promise<any> {
  const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
  if (!item) {
    throw new Error(
      `Item ${itemKey} was not found in library ${libraryID}. Use an itemKey returned by hybrid_search.`,
    );
  }
  return item;
}

function itemTitle(item: any): string {
  try {
    return item.getDisplayTitle?.() || item.getField?.("title") || "";
  } catch {
    return "";
  }
}

/**
 * Rank a document's chunks with the shared lexical ranker.
 *
 * Each chunk is presented as a one-field candidate document, so term
 * specificity (IDF across the document's own chunks), keyword coverage and
 * repeat saturation all behave exactly as they do at library level — a chunk
 * that hits four of the query's terms outranks one that repeats a common term.
 */
function rankChunksLexically(
  chunks: Array<{ chunkId: number; text: string }>,
  keywordEntries: Parameters<typeof rankLexicalCandidates>[1],
  libraryID: number,
  candidateLimit: number,
): KeywordSearchItem[] {
  const candidates: LexicalCandidate[] = chunks.map((chunk) => ({
    key: String(chunk.chunkId),
    libraryID,
    title: "",
    fields: { chunkText: chunk.text },
  }));
  return rankLexicalCandidates(candidates, keywordEntries, {
    limit: candidateLimit,
    fieldWeights: CHUNK_FIELD_WEIGHTS,
  });
}

/**
 * Run the hybrid search inside one document and return only the chunks that
 * clear the relevance threshold.
 */
export async function runDocumentDeepDive(
  request: DeepDiveRequest,
): Promise<DeepDiveResult> {
  if (typeof request.query !== "string" || !request.query.trim()) {
    throw new Error("query must not be blank");
  }
  if (typeof request.itemKey !== "string" || !request.itemKey.trim()) {
    throw new Error("itemKey is required");
  }

  const settings = getHybridSearchSettings();
  const libraryID = request.libraryID ?? Zotero.Libraries.userLibraryID;
  const item = await resolveItem(request.itemKey, libraryID);

  const cap = resolveResultCap(request.maxChunks, settings.maxChunksPerItem);
  const floor = resolveScoreFloor(request.minScore, settings.minScore);

  const semanticService = getSemanticSearchService();
  const storedChunks = await semanticService.getItemChunks(
    request.itemKey,
    libraryID,
  );
  if (storedChunks.length === 0) {
    throw new Error(
      `Item ${request.itemKey} has no indexed full text. Build or refresh the semantic index for it (Zotero → item context menu → update semantic index), then retry.`,
    );
  }

  const chunkTextById = new Map<number, string>();
  for (const chunk of storedChunks)
    chunkTextById.set(chunk.chunkId, chunk.text);

  const {
    keywords: lexicalKeywords,
    entries: lexicalKeywordEntries,
    source: probeSource,
  } = resolveHybridKeywords(request.query, request.keywords);
  const provenance = resolveKeywordProvenance({
    probeSource,
    keywordsArgumentPresent:
      request.keywords !== undefined && request.keywords !== null,
    domain: request.domain,
    expertRole: request.expertRole,
  });

  const candidateLimit = Math.min(
    MAX_CHUNK_CANDIDATES,
    Math.max(cap.value, storedChunks.length),
  );
  const candidatePoolTruncated = storedChunks.length > MAX_CHUNK_CANDIDATES;

  const totalTimeoutMs = request.totalTimeoutMs ?? DEFAULT_HYBRID_TIMEOUT_MS;
  const semanticTimeoutMs = Math.min(
    request.semanticTimeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS,
    totalTimeoutMs,
  );
  const semanticAbort =
    typeof AbortController !== "undefined" ? new AbortController() : null;

  const searchResult = await runHybridSearch(
    {
      query: request.query,
      keywords: lexicalKeywords,
      topK: cap.value,
      rrfK: request.rrfK ?? 60,
      keywordWeight: request.keywordWeight ?? 1,
      semanticWeight: request.semanticWeight ?? 1,
      minScore: floor.value,
      semanticTimeoutMs,
      totalTimeoutMs,
    },
    {
      keywordSearch: async () =>
        rankChunksLexically(
          storedChunks,
          lexicalKeywordEntries,
          libraryID,
          candidateLimit,
        ),
      semanticSearch: async (): Promise<SemanticSearchItem[]> => {
        const results = await semanticService.searchItemChunks(request.query, {
          itemKey: request.itemKey,
          libraryID,
          topK: candidateLimit,
          timeoutMs: semanticTimeoutMs,
          signal: semanticAbort?.signal,
        });
        // The fusion layer is keyed by "document"; inside one paper the
        // document IS the chunk, which is what lets both levels share it.
        return results.map((chunk) => ({
          itemKey: String(chunk.chunkId),
          libraryID,
          title: "",
          score: chunk.score,
        }));
      },
      cancelSemanticSearch: () => semanticAbort?.abort(),
    },
  );
  semanticAbort?.abort();

  const warnings = [...searchResult.warnings];
  if (provenance.keywordSource === "fallback") {
    warnings.unshift(
      `warning: Keywords for this document were not confirmed as domain-expert output. ${provenance.reason} Re-run this deep dive once with keywords derived from THIS paper — its study object, material system, method, variables, mechanism and abbreviations — written in the language this paper is written in, plus a domain and expertRole declaration re-fitted to this paper. Do not simply reuse the library-level bilingual search terms.`,
    );
  }
  if (candidatePoolTruncated) {
    warnings.push(
      `This document has ${storedChunks.length} chunks; only the top ${MAX_CHUNK_CANDIDATES} candidates per branch were fused.`,
    );
  }
  if (cap.clamped) {
    warnings.push(
      `Requested chunk count exceeded the user's per-document limit; capped at ${cap.value}.`,
    );
  }
  if (floor.clamped) {
    warnings.push(
      `Requested minScore was below the user's relevance threshold; raised to ${floor.value}.`,
    );
  }

  const degraded =
    searchResult.degraded ||
    provenance.keywordSource === "fallback" ||
    candidatePoolTruncated;

  const chunks: DeepDiveChunk[] = searchResult.results.map((result) => {
    const chunkId = Number(result.itemKey);
    return {
      chunkId,
      text: chunkTextById.get(chunkId) ?? "",
      score: result.score,
      normalizedKeywordScore: result.normalizedKeywordScore,
      normalizedSemanticScore: result.normalizedSemanticScore,
      keywordScore: result.keywordScore,
      semanticScore: result.semanticScore,
      matchedKeywords: (result as any).matchedKeywords,
      keywordRank: result.keywordRank,
      semanticRank: result.semanticRank,
    };
  });

  ztoolkit.log(
    `[DocumentDeepDive] ${request.itemKey}: ${chunks.length}/${storedChunks.length} chunks kept (minScore=${floor.value}, cap=${cap.value}, discarded=${searchResult.discardedBelowThreshold}, keywordSource=${provenance.keywordSource})`,
  );

  const fallbackWarning =
    provenance.keywordSource === "fallback" ? warnings[0] : undefined;

  return {
    mode: "document_hybrid",
    itemKey: request.itemKey,
    libraryID,
    title: itemTitle(item),
    query: request.query,
    keywords: lexicalKeywords,
    keywordSource: provenance.keywordSource,
    chunks,
    totalChunks: storedChunks.length,
    degraded,
    warnings,
    ...(fallbackWarning ? { warning: fallbackWarning } : {}),
    metadata: {
      extractedAt: new Date().toISOString(),
      searchMode: "document_hybrid",
      fusion: "normalized_weighted_hybrid",
      keywordSource: provenance.keywordSource,
      keywordProbeOrigin: provenance.probeOrigin,
      keywordFallbackReason: provenance.reason ?? undefined,
      declaredDomain: provenance.domain ?? undefined,
      declaredExpertRole: provenance.expertRole ?? undefined,
      keywordCount: lexicalKeywords.length,
      keywordWeights: lexicalKeywordEntries.map((entry) => ({
        keyword: entry.text,
        weight: entry.weight,
        origin: entry.origin,
      })),
      chunkFieldWeights: CHUNK_FIELD_WEIGHTS,
      appliedMinScore: searchResult.appliedMinScore,
      userMinScore: settings.minScore,
      appliedMaxChunks: cap.value,
      userMaxChunks: settings.maxChunksPerItem,
      neighborRadiusLimit: settings.neighborRadius,
      totalChunks: storedChunks.length,
      candidateLimit,
      candidatePoolTruncated,
      keywordResultCount: searchResult.keywordResultCount,
      semanticResultCount: searchResult.semanticResultCount,
      discardedBelowThreshold: searchResult.discardedBelowThreshold,
      resultCount: chunks.length,
      degraded,
      warnings,
      timings: {
        lexicalMs: searchResult.timings.keywordMs,
        semanticMs: searchResult.timings.semanticMs,
        fusionMs: searchResult.timings.rrfMs,
        totalMs: searchResult.timings.totalMs,
      },
      nextStep:
        chunks.length === 0
          ? "No passage in this document reached the relevance threshold. Do not lower the threshold; either this paper does not answer the question, or the query needs to be rewritten from the paper's own terminology."
          : "Read these passages first. Only if a passage is missing its cause, consequence, experimental condition or mechanism context, call search_fulltext again with chunkIds set to that passage's chunkId to pull in its neighbours. Do not request neighbours by default.",
    },
  };
}

/**
 * Return the requested chunks together with their immediate neighbours.
 *
 * Only ever called when the AI says a specific passage lacks context, and the
 * radius can never exceed the user's setting, so this cannot quietly turn into
 * "send the whole paper".
 */
export async function expandChunkContext(
  request: ChunkContextRequest,
): Promise<ChunkContextResult> {
  if (typeof request.itemKey !== "string" || !request.itemKey.trim()) {
    throw new Error("itemKey is required");
  }
  if (!Array.isArray(request.chunkIds) || request.chunkIds.length === 0) {
    throw new Error("chunkIds must be a non-empty array of chunk ids");
  }

  const settings = getHybridSearchSettings();
  const libraryID = request.libraryID ?? Zotero.Libraries.userLibraryID;
  const item = await resolveItem(request.itemKey, libraryID);
  const radius = resolveNeighborRadius(request.radius, settings.neighborRadius);

  const semanticService = getSemanticSearchService();
  const storedChunks = await semanticService.getItemChunks(
    request.itemKey,
    libraryID,
  );
  if (storedChunks.length === 0) {
    throw new Error(
      `Item ${request.itemKey} has no indexed full text, so it has no chunks to expand.`,
    );
  }

  const byId = new Map<number, string>();
  for (const chunk of storedChunks) byId.set(chunk.chunkId, chunk.text);

  const anchors: number[] = [];
  const unknownAnchors: number[] = [];
  for (const raw of request.chunkIds) {
    const chunkId = Number(raw);
    if (!Number.isInteger(chunkId)) {
      throw new Error(`chunkIds must be integers; received ${String(raw)}`);
    }
    if (!byId.has(chunkId)) {
      unknownAnchors.push(chunkId);
      continue;
    }
    if (!anchors.includes(chunkId)) anchors.push(chunkId);
  }

  const anchorSet = new Set(anchors);
  const selected = new Map<number, "anchor" | "context">();
  for (const anchor of anchors) {
    selected.set(anchor, "anchor");
    for (let offset = 1; offset <= radius.value; offset += 1) {
      for (const neighbour of [anchor - offset, anchor + offset]) {
        if (!byId.has(neighbour)) continue;
        if (anchorSet.has(neighbour)) continue;
        if (!selected.has(neighbour)) selected.set(neighbour, "context");
      }
    }
  }

  const chunks = Array.from(selected.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([chunkId, role]) => ({
      chunkId,
      text: byId.get(chunkId) ?? "",
      role,
    }));

  const warnings: string[] = [];
  if (unknownAnchors.length > 0) {
    warnings.push(
      `These chunkIds do not exist in this document and were ignored: ${unknownAnchors.join(", ")}. Valid ids run from ${storedChunks[0].chunkId} to ${storedChunks[storedChunks.length - 1].chunkId}.`,
    );
  }
  if (radius.clamped) {
    warnings.push(
      `Requested neighbour radius exceeded the user's limit; capped at ${radius.value}.`,
    );
  }

  ztoolkit.log(
    `[DocumentDeepDive] ${request.itemKey}: context expansion radius=${radius.value}, anchors=${anchors.length}, returned=${chunks.length}`,
  );

  return {
    mode: "chunk_context",
    itemKey: request.itemKey,
    libraryID,
    title: itemTitle(item),
    totalChunks: storedChunks.length,
    appliedRadius: radius.value,
    chunks,
    // A partly-ignored request is a partial failure: say so.
    degraded: unknownAnchors.length > 0,
    warnings,
    metadata: {
      extractedAt: new Date().toISOString(),
      searchMode: "chunk_context",
      anchors,
      ignoredChunkIds: unknownAnchors,
      appliedRadius: radius.value,
      userNeighborRadius: settings.neighborRadius,
      resultCount: chunks.length,
      degraded: unknownAnchors.length > 0,
      warnings,
      nextStep:
        "Context expansion does not re-rank anything; these passages are neighbours by position. If they still do not explain the passage, the answer is probably not in this document.",
    },
  };
}
