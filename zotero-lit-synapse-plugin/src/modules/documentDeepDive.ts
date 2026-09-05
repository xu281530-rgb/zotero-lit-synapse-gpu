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

import { assertNotCancelled, forwardCancellation, createRequestController } from "./requestCancellation";
import {
  CHUNK_FIELD_WEIGHTS,
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
import {
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  describeFullTextAvailability,
  describeMissingBodyText,
  getSemanticSearchService,
  hasBodyText,
} from "./semantic";

declare const Zotero: any;
declare let ztoolkit: ZToolkit;

/** Chunks past this are still scanned, but only this many reach fusion. */
const MAX_CHUNK_CANDIDATES = 500;

export interface DeepDiveRequest {
  signal?: AbortSignal;
  itemKey: string;
  libraryID?: number;
  query: string;
  keywords?: unknown;
  domain?: unknown;
  expertRole?: unknown;
  maxChunks?: unknown;
  /** Keyword-branch floor for THIS document's chunks. Only ever stricter. */
  minKeywordScore?: unknown;
  /** Semantic-branch floor for THIS document's chunks. Only ever stricter. */
  minSemanticScore?: unknown;
  keywordWeight?: number;
  semanticWeight?: number;
  rrfK?: number;
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

/**
 * Refuse to dig into a document whose index holds no body text.
 *
 * Having chunks is not the same as having full text: a paper whose PDF could
 * not be parsed still gets its title and abstract chunked, and this stage used
 * to hand those back as "passages", which reads exactly like evidence from the
 * paper. Indexes written before this was recorded report `unknown` and are
 * still allowed through, so upgrading the plugin does not break every existing
 * item at once — they get a real answer the next time they are refreshed.
 *
 * A legacy item is let through with a warning rather than silently: this is
 * the stage where passages are actually read in depth, so it is the worst
 * place to stay quiet about "we never established whether these are body text".
 * Returns the caveat to attach, or undefined when there is nothing to say.
 */
async function assertBodyTextIndexed(
  itemKey: string,
  libraryID: number,
): Promise<string | undefined> {
  const state = await getSemanticSearchService().getItemBodyIndexState(
    itemKey,
    libraryID,
  );
  if (state === "unknown") {
    return describeFullTextAvailability("unknown");
  }
  if (hasBodyText(state)) return undefined;
  if (state === "metadata-only" || state === "no-source") {
    throw new Error(describeMissingBodyText(itemKey, state));
  }
  // 'missing': no index row at all — the existing "not indexed" message below
  // is the right one, so let the caller reach it.
  return undefined;
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
  // The SAME two settings the library-level search uses. A chunk is a candidate
  // document here, so nothing about the gating changes between the two levels —
  // which is the point: one place to configure, one behaviour to reason about.
  const keywordFloor = resolveScoreFloor(
    request.minKeywordScore,
    settings.keywordMinScore,
  );
  const semanticFloor = resolveScoreFloor(
    request.minSemanticScore,
    settings.semanticMinScore,
  );

  const legacyIndexWarning = await assertBodyTextIndexed(
    request.itemKey,
    libraryID,
  );

  const semanticService = getSemanticSearchService();
  const storedChunks = await semanticService.getItemChunks(
    request.itemKey,
    libraryID,
  );
  if (storedChunks.length === 0) {
    throw new Error(
        `Item ${request.itemKey} has no indexed full text. Build or refresh the search index for it (Zotero → item context menu → update index), then retry.`,
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
  assertNotCancelled(request.signal);

  // Same two user-configured budgets as library-level retrieval. The keyword
  // branch here ranks already-loaded chunks rather than querying Zotero, so it
  // is far cheaper than a library scan — but it is still bounded, because
  // "cheap in practice" is not a guarantee.
  const { keywordSearchTimeoutMs, vectorScanTimeoutMs } = settings;
  const semanticAbort = createRequestController();
  const unlink = forwardCancellation(request.signal, semanticAbort);

  const searchResult = await runHybridSearch(
    {
      query: request.query,
      keywords: lexicalKeywords,
      topK: cap.value,
      rrfK: request.rrfK ?? 60,
      keywordWeight: request.keywordWeight ?? settings.keywordRrfWeight,
      semanticWeight: request.semanticWeight ?? settings.semanticRrfWeight,
      keywordMinScore: keywordFloor.value,
      semanticMinScore: semanticFloor.value,
      keywordSearchTimeoutMs,
      semanticBranchTimeoutMs:
        vectorScanTimeoutMs + DEFAULT_EMBEDDING_TIMEOUT_MS,
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
          vectorScanTimeoutMs,
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
  ).finally(() => { unlink(); semanticAbort?.abort(); });
  assertNotCancelled(request.signal);

  const warnings = [...searchResult.warnings];
  // Front of the list, ahead of retrieval-quality notes: it qualifies what the
  // returned passages ARE, which outranks how well they were ranked.
  if (legacyIndexWarning) warnings.unshift(legacyIndexWarning);
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
  if (keywordFloor.clamped) {
    warnings.push(
      `Requested minKeywordScore was below the user's keyword relevance threshold; raised to ${keywordFloor.value}.`,
    );
  }
  if (semanticFloor.clamped) {
    warnings.push(
      `Requested minSemanticScore was below the user's semantic relevance threshold; raised to ${semanticFloor.value}.`,
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
    `[DocumentDeepDive] ${request.itemKey}: ${chunks.length}/${storedChunks.length} chunks kept (keywordMinScore=${keywordFloor.value}, semanticMinScore=${semanticFloor.value}, cap=${cap.value}, keywordAdmitted=${searchResult.keywordAdmittedCount}, semanticAdmitted=${searchResult.semanticAdmittedCount}, rejectedByBoth=${searchResult.discardedBelowThreshold}, keywordSource=${provenance.keywordSource})`,
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
      fusion: "independent_thresholds_weighted_rrf",
      fusionNote:
        "Chunk-level, following the same rule as hybrid_search's document-level fusion: each branch is filtered against its own user threshold on its own scale, the survivors are unioned, and ranking is weighted RRF over each chunk's rank within each branch that admitted it. A passage only has to clear ONE threshold to be returned. The keyword scale differs from the library level: a chunk is a single-field candidate scored by specificity across THIS document's chunks, coverage and saturating repeats (see chunkFieldWeights), not by the BM25F used over a document's metadata fields — so a chunk keyword score is comparable to other chunks of this paper, not to a hybrid_search score. `score` is the RRF value and orders the list; it is not a relevance — read normalizedKeywordScore and normalizedSemanticScore for that. Adjacent-chunk expansion is not part of this ranking; it is a separate call the client decides to make.",
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
      appliedKeywordMinScore: searchResult.appliedKeywordMinScore,
      appliedSemanticMinScore: searchResult.appliedSemanticMinScore,
      userKeywordMinScore: settings.keywordMinScore,
      userSemanticMinScore: settings.semanticMinScore,
      appliedMaxChunks: cap.value,
      userMaxChunks: settings.maxChunksPerItem,
      neighborRadiusLimit: settings.neighborRadius,
      totalChunks: storedChunks.length,
      candidateLimit,
      candidatePoolTruncated,
      keywordResultCount: searchResult.keywordResultCount,
      semanticResultCount: searchResult.semanticResultCount,
      keywordAdmittedCount: searchResult.keywordAdmittedCount,
      semanticAdmittedCount: searchResult.semanticAdmittedCount,
      /** Chunks rejected by BOTH branches — the only way one is dropped. */
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
          ? "No passage in this document cleared either relevance threshold — and a passage only had to clear one of them, so this is not one branch being strict. Do not lower a threshold; either this paper does not answer the question, or the query needs to be rewritten from the paper's own terminology."
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

  const legacyIndexWarning = await assertBodyTextIndexed(
    request.itemKey,
    libraryID,
  );

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
  // Same caveat as the ranked deep dive: neighbour expansion returns raw
  // passages, so a legacy index must not hand them over unqualified.
  if (legacyIndexWarning) warnings.push(legacyIndexWarning);
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
