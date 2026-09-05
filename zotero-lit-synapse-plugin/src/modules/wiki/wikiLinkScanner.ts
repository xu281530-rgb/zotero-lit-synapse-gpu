/**
 * 为一篇文献计算跨文献候选边：一次全库粗召回 + 若干次文献对局部精查。
 *
 * ## 为什么是两阶段，而不是 all-pairs
 *
 * 500 篇 × 平均 150 chunk = 75,000 个向量。全库两两比较是 1.25 亿次文献对比较，
 * 每对还要比它们各自的所有 chunk；这不是「慢」，是不可能。两阶段把它压成：
 *
 *   阶段 A：用本篇最多 20 个代表段扫一次全库 → 20 × 75,000 = 150 万次向量比较，
 *           得到 top-M 候选文献。
 *   阶段 B：只在 top-M 这几对文献内部，用已在内存里的向量算双向分，不再碰全库。
 *
 * 关键是阶段 B 绝不重新扫库。后读的文献 D 发现 A 时，仍然只写一条规范化的
 * (A,D) 记录，但记录里的两个方向分是真算出来的，而不是把单向分当成对称的。
 *
 * ## 为什么直接用 vectorStore.searchMultiQuery，而不是 findSimilarByChunks
 *
 * `findSimilarByChunks` 返回的是聚合并排序后的文献分。本模块需要的是聚合之前的
 * 那张矩阵：每个代表段命中了哪些文献、命中分多少——因为 `breadth_i`（一个代表段
 * 在这次扫描里命中了多少篇不同文献）只能从矩阵里数出来，而它正是套话降权的支点。
 * 拿聚合结果反推是做不到的。`searchMultiQuery` 本来就返回这张矩阵，且不做文献级
 * 截断，所以这里直接用它，扫描预算沿用同一套 `resolveSimilarScanBudget`。
 *
 * ## 反向分的诚实说明
 *
 * 阶段 B 算 B→A 时，B 的代表段没有参加过这次全库扫描，因此它们的 breadth 是未知的，
 * 权重一律取 1，方向分退化为未加权的 0.75×mean + 0.25×max。这不是近似，是「这个量
 * 还没被测过」。等 B 自己被阅读并扫描时，从 B 出发的那次扫描会用真实 breadth 重算
 * 这条边的该方向分并覆盖回来——`upsertCandidate` 的 COALESCE 就是为此。
 */

import { getEmbeddingService } from "../semantic/embeddingService";
import { getHybridSearchSettings } from "../hybridSearchSettings";
import { resolveSimilarScanBudget } from "../semantic/similarScanBudget";
import { hashWikiText } from "./wikiCanonicalizer";
import {
  LINK_ALGORITHM_VERSION,
  orientDirection,
  scoreDirection,
  symmetricScore,
  type AnchorHit,
} from "./wikiLinkScoring";
import { breadthCap, type WikiLinkSettings } from "./wikiLinkSettings";
import {
  MAX_REPRESENTATIVE_CHUNKS,
  selectRepresentativeChunks,
  type RepresentativeSelection,
} from "./wikiRepresentativeChunks";
import type { WikiLinkSignalInput, WikiLinkSourceFingerprint } from "./wikiLinkTypes";

declare let ztoolkit: ZToolkit;

/** 一篇文献在向量库里的样子。由调用方从 vectorStore 组装。 */
export interface ScanDocument {
  itemKey: string;
  libraryID: number;
  chunks: Array<{ chunkId: number; text: string; vector: Float32Array | null }>;
  fingerprint: WikiLinkSourceFingerprint;
}

/** 一次粗扫描的原始返回，与 vectorStore.searchMultiQuery 的形状一致。 */
export interface CoarseMatch {
  itemKey: string;
  libraryID: number;
  /** 与 query chunk 顺序一致；每项是该文献在这个 query 上的命中段（降序）。 */
  perQuery: Array<Array<{ chunkId: number; score: number }>>;
}

export interface CoarseScanner {
  (
    queryVectors: Float32Array[],
    options: {
      libraryID: number;
      excludeItemKeys: string[];
      deadlineAt: number;
      chunksPerQuery: number;
    },
  ): Promise<CoarseMatch[]>;
}

export interface ScanPairResult {
  itemKey: string;
  libraryID: number;
  scoreQueryToCandidate: number;
  scoreCandidateToQuery: number;
  scoreSymmetric: number;
  signals: WikiLinkSignalInput[];
}

export interface ScanOutcome {
  selection: RepresentativeSelection;
  documentCount: number;
  breadthCap: number;
  coarseCandidates: number;
  pairs: ScanPairResult[];
  model: string;
  dimensions: number;
  algorithmVersion: string;
}

/** 每个 query chunk 在一篇候选文献里取几段求平均，与现有聚合口径一致。 */
const CHUNKS_PER_QUERY = 2;

/** 摘录长度：足够读懂一句话，不足以把整段正文塞进 signal 表。 */
const EXCERPT_LIMIT = 220;

function excerptOf(text: string): string {
  const trimmed = String(text ?? "").replace(/\s+/gu, " ").trim();
  return trimmed.length > EXCERPT_LIMIT
    ? `${trimmed.slice(0, EXCERPT_LIMIT)}…`
    : trimmed;
}

function dot(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index];
  return sum;
}

function cosine(a: Float32Array, b: Float32Array): number {
  const denominator =
    Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b));
  return denominator > 0 ? dot(a, b) / denominator : 0;
}

/**
 * 一个方向的逐段命中：查询侧每段，在候选侧取 top-2 求平均。
 *
 * 与 `aggregateSimilarDocument` 同口径（top-2 而不是 top-1），道理也一样：只取最高
 * 一段，会让「整段偶然撞上」的单个段落独自代表整篇文献。
 */
function localAnchors(
  queryChunks: ScanDocument["chunks"],
  candidateChunks: ScanDocument["chunks"],
  breadthByQueryChunk: Map<number, number>,
): AnchorHit[] {
  const anchors: AnchorHit[] = [];
  for (const query of queryChunks) {
    if (!query.vector) continue;
    const scored: Array<{ chunkId: number; score: number }> = [];
    for (const candidate of candidateChunks) {
      if (!candidate.vector) continue;
      scored.push({
        chunkId: candidate.chunkId,
        score: cosine(query.vector, candidate.vector),
      });
    }
    scored.sort((left, right) => right.score - left.score);
    const top = scored.slice(0, CHUNKS_PER_QUERY);
    anchors.push({
      queryChunkId: query.chunkId,
      matchedChunkId: top[0]?.chunkId ?? null,
      score: top.length
        ? top.reduce((sum, hit) => sum + hit.score, 0) / top.length
        : 0,
      // 反向没有测过 breadth，权重取 1 → breadth 记 0。见文件头。
      breadthDocs: breadthByQueryChunk.get(query.chunkId) ?? 0,
    });
  }
  return anchors;
}

/**
 * 扫描一篇文献，产出它的候选文献对。
 *
 * 只做计算，不写库。写库、状态机和队列都在 WikiLinkService，这样这段逻辑可以在
 * 没有数据库的情况下测——阈值和公式恰恰是最需要单测的部分。
 */
export async function scanDocumentLinks(options: {
  document: ScanDocument;
  /** 全库文献数 N，IDF 与 breadth cap 的分母。 */
  documentCount: number;
  scan: CoarseScanner;
  settings: WikiLinkSettings;
  /** 取候选文献的全部 chunk，用于阶段 B。 */
  loadDocument: (
    libraryID: number,
    itemKey: string,
  ) => Promise<ScanDocument | null>;
  now?: number;
}): Promise<ScanOutcome> {
  const { document, settings } = options;
  const embeddingService = getEmbeddingService();
  const config = embeddingService.getConfig();
  const model = String(config.model ?? "");
  const selection = selectRepresentativeChunks(document.chunks);
  const cap = breadthCap(options.documentCount, settings.breadthCapFraction);

  const byChunkId = new Map(
    document.chunks.map((chunk) => [chunk.chunkId, chunk]),
  );
  const representatives = selection.chunkIds
    .map((chunkId) => byChunkId.get(chunkId))
    .filter((chunk): chunk is ScanDocument["chunks"][number] =>
      Boolean(chunk?.vector),
    );

  const empty: ScanOutcome = {
    selection,
    documentCount: options.documentCount,
    breadthCap: cap,
    coarseCandidates: 0,
    pairs: [],
    model,
    dimensions: representatives[0]?.vector?.length ?? 0,
    algorithmVersion: LINK_ALGORITHM_VERSION,
  };
  if (!representatives.length) return empty;
  if (representatives.length > MAX_REPRESENTATIVE_CHUNKS) {
    // 选择器已经保证不会发生；真发生了就是选择器坏了，宁可报错也不要静悄悄地
    // 把 20 段的护栏变成 40 段。
    throw new Error(
      `The representative selector returned ${representatives.length} chunks, above the ${MAX_REPRESENTATIVE_CHUNKS} the coarse scan is budgeted for.`,
    );
  }

  // ---- 阶段 A：一次全库粗召回 -------------------------------------------
  const budget = resolveSimilarScanBudget({
    queryChunkCount: representatives.length,
    vectorScanTimeoutMs: Math.min(
      settings.scanTimeoutMs,
      getHybridSearchSettings().vectorScanTimeoutMs,
    ),
    path: "gpu",
  });
  const matches = await options.scan(
    representatives.map((chunk) => chunk.vector as Float32Array),
    {
      libraryID: document.libraryID,
      excludeItemKeys: [document.itemKey],
      deadlineAt: (options.now ?? Date.now()) + budget.timeoutMs,
      chunksPerQuery: CHUNKS_PER_QUERY,
    },
  );

  // breadth_i：代表段 i 在这次扫描里，命中分超过阈值的不同文献数。
  const breadthByQueryChunk = new Map<number, number>();
  representatives.forEach((chunk, index) => {
    let reached = 0;
    for (const match of matches) {
      const hits = match.perQuery[index] ?? [];
      if (hits.some((hit) => hit.score >= settings.breadthChunkScore)) {
        reached += 1;
      }
    }
    breadthByQueryChunk.set(chunk.chunkId, reached);
  });

  // 粗排：先用未加权的方向分排序取 top-M，精查再算真分。这里不做阈值过滤——
  // 阈值属于对称分，而对称分要等阶段 B 才有。
  const coarse = matches
    .map((match) => {
      const anchors: AnchorHit[] = representatives.map((chunk, index) => {
        const hits = (match.perQuery[index] ?? []).slice(0, CHUNKS_PER_QUERY);
        return {
          queryChunkId: chunk.chunkId,
          matchedChunkId: hits[0]?.chunkId ?? null,
          score: hits.length
            ? hits.reduce((sum, hit) => sum + hit.score, 0) / hits.length
            : 0,
          breadthDocs: breadthByQueryChunk.get(chunk.chunkId) ?? 0,
        };
      });
      const direction = scoreDirection(anchors, {
        documentCount: options.documentCount,
        breadthCap: cap,
      });
      return { match, anchors, direction };
    })
    .sort((left, right) => right.direction.score - left.direction.score)
    .slice(0, Math.max(settings.topK, settings.coarseCandidates));

  // ---- 阶段 B：文献对局部双向精查 ---------------------------------------
  const pairs: ScanPairResult[] = [];
  for (const entry of coarse) {
    const candidate = await options.loadDocument(
      entry.match.libraryID,
      entry.match.itemKey,
    );
    if (!candidate) continue;
    const candidateSelection = selectRepresentativeChunks(candidate.chunks);
    const candidateByChunkId = new Map(
      candidate.chunks.map((chunk) => [chunk.chunkId, chunk]),
    );
    const candidateRepresentatives = candidateSelection.chunkIds
      .map((chunkId) => candidateByChunkId.get(chunkId))
      .filter((chunk): chunk is ScanDocument["chunks"][number] =>
        Boolean(chunk?.vector),
      );

    // 正向用阶段 A 已经算好的锚点（它带着真实 breadth）。
    const forward = entry.direction;
    // 反向在内存里算，权重全 1：这些代表段没参加过本次全库扫描。
    const reverse = scoreDirection(
      localAnchors(candidateRepresentatives, document.chunks, new Map()),
      { documentCount: options.documentCount, breadthCap: cap },
    );
    const symmetric = symmetricScore(forward.score, reverse.score);
    if (symmetric < settings.minSymmetricScore) continue;

    const signals: WikiLinkSignalInput[] = [];
    const queryIsA = document.itemKey < candidate.itemKey;

    // 每个方向最多贡献一个锚点，两个方向各一条 signal。超过 breadth cap 的段落
    // 已经在 scoreDirection 里被排除在 best 之外，所以纯套话不会成为边的说明。
    const forwardBest = forward.best;
    if (forwardBest && forwardBest.score >= settings.minDirectionalScore) {
      const queryChunk = byChunkId.get(forwardBest.queryChunkId);
      const matchedChunk =
        forwardBest.matchedChunkId == null
          ? undefined
          : candidateByChunkId.get(forwardBest.matchedChunkId);
      if (queryChunk && matchedChunk) {
        signals.push(
          await buildSignal({
            direction: orientDirection(queryIsA),
            score: forwardBest.score,
            weight: forwardBest.weight,
            breadthDocs: forwardBest.breadthDocs,
            model,
            queryChunk,
            matchedChunk,
            queryIsA,
          }),
        );
      }
    }
    const reverseBest = reverse.best;
    if (reverseBest && reverseBest.score >= settings.minDirectionalScore) {
      const candidateChunk = candidateByChunkId.get(reverseBest.queryChunkId);
      const matchedChunk =
        reverseBest.matchedChunkId == null
          ? undefined
          : byChunkId.get(reverseBest.matchedChunkId);
      if (candidateChunk && matchedChunk) {
        signals.push(
          await buildSignal({
            direction: orientDirection(!queryIsA),
            score: reverseBest.score,
            weight: reverseBest.weight,
            breadthDocs: null,
            model,
            queryChunk: candidateChunk,
            matchedChunk,
            queryIsA: !queryIsA,
          }),
        );
      }
    }
    // 没有任何可展示锚点的候选不进候选表：一条既没有标签也没有原文的边，读者
    // 对它做不了任何事，只会把图糊掉。
    if (!signals.length) continue;

    pairs.push({
      itemKey: candidate.itemKey,
      libraryID: candidate.libraryID,
      scoreQueryToCandidate: forward.score,
      scoreCandidateToQuery: reverse.score,
      scoreSymmetric: symmetric,
      signals,
    });
  }

  pairs.sort((left, right) => right.scoreSymmetric - left.scoreSymmetric);
  const kept = pairs.slice(0, settings.topK);
  ztoolkit.log(
    `[wiki] link scan ${document.itemKey}: ${representatives.length} representatives, ` +
      `${matches.length} coarse documents, ${pairs.length} above threshold, ${kept.length} kept ` +
      `(N=${options.documentCount}, breadthCap=${cap})`,
  );
  return {
    ...empty,
    coarseCandidates: matches.length,
    pairs: kept,
  };
}

async function buildSignal(options: {
  direction: "a_to_b" | "b_to_a";
  score: number;
  weight: number;
  breadthDocs: number | null;
  model: string;
  queryChunk: ScanDocument["chunks"][number];
  matchedChunk: ScanDocument["chunks"][number];
  /** Whether the QUERY side is the pair's `a`. Decides which side is which. */
  queryIsA: boolean;
}): Promise<WikiLinkSignalInput> {
  const querySide = {
    chunkIdSnapshot: options.queryChunk.chunkId,
    chunkTextHash: await hashWikiText(options.queryChunk.text),
    excerpt: excerptOf(options.queryChunk.text),
  };
  const matchedSide = {
    chunkIdSnapshot: options.matchedChunk.chunkId,
    chunkTextHash: await hashWikiText(options.matchedChunk.text),
    excerpt: excerptOf(options.matchedChunk.text),
  };
  return {
    signalType: "semantic",
    direction: options.direction,
    algorithmVersion: LINK_ALGORITHM_VERSION,
    sourceModel: options.model,
    score: options.score,
    specificityWeight: options.weight,
    breadthDocs: options.breadthDocs,
    a: options.queryIsA ? querySide : matchedSide,
    b: options.queryIsA ? matchedSide : querySide,
  };
}
