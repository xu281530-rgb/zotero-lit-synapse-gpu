/**
 * 把「多个查询 chunk × 候选文献多个 chunk」的相似度矩阵，压成每篇候选文献的
 * 一个语义相关度分数。
 *
 * 为什么不能沿用「取前 N 个 chunk 再去重成文献」：那种做法先在 chunk 层面截断，
 * 再把剩下的 chunk 折叠成文献。一篇文献只要有若干个高分段落，就能把整张榜单占满，
 * 于是「找 20 篇相似文献」实际返回的可能是 2 篇。截断必须发生在文献层面，也就是
 * 先给每一篇候选文献算出唯一分数，排序、过阈值，最后才分页。
 *
 * 打分口径（三层，全部是余弦值的均值/最大值，所以结果与单次余弦同尺度 0..1，
 * 可以直接和用户设定的相关度阈值比较）：
 *
 *   1. 对每个查询 chunk i，取候选文献里与之最相似的前 CHUNKS_PER_QUERY 段，
 *      求平均得到 s_i。取前两段而不是最高一段，是为了让「整段偶然撞上」的
 *      单个段落无法独自代表整篇文献。
 *   2. 文献分 = MEAN_WEIGHT * mean_i(s_i) + MAX_WEIGHT * max_i(s_i)。
 *      均值项要求文献在你给的多个方面上都站得住（广度），最大值项保留一小份
 *      权重给「某一方面极强」的文献（深度），避免纯均值把专精文献一刀切掉。
 *   3. 某个查询 chunk 在这篇文献里完全没有命中时 s_i = 0，这是有意的：它表示
 *      「这一方面这篇文献没有对应内容」，而不是「这一方面不算数」。
 *
 * 纯函数、无 Zotero 依赖，可以直接在 Node 下跑单测。
 */

/** 每个查询 chunk 在一篇候选文献里取几段求平均。 */
export const SIMILAR_CHUNKS_PER_QUERY = 2;
/** 广度项（跨查询 chunk 求均值）的权重。 */
export const SIMILAR_MEAN_WEIGHT = 0.75;
/** 深度项（跨查询 chunk 取最大）的权重。 */
export const SIMILAR_MAX_WEIGHT = 0.25;
/**
 * 一次调用允许传入的查询 chunk 数量上限。
 *
 * 不限制数量在 CPU 路径上等于让一次调用把全库向量重复打分任意多遍；20 段已经
 * 远超「一篇文献的代表性段落」需要的规模，超出时报错比悄悄变慢诚实。
 */
export const MAX_SIMILAR_QUERY_CHUNKS = 20;

export interface SimilarChunkHit {
  chunkId: number;
  score: number;
}

/** 一篇候选文献在每个查询 chunk 上的命中段落（同一维度内按分数降序）。 */
export interface SimilarDocumentMatch {
  itemKey: string;
  libraryID: number;
  perQuery: SimilarChunkHit[][];
}

export interface AggregatedSimilarDocument {
  itemKey: string;
  libraryID: number;
  /** 文献级语义相关度，与余弦同尺度 0..1。 */
  score: number;
  /** 每个查询 chunk 对应的 s_i，顺序与传入的 chunkIds 一致。 */
  perQueryScores: number[];
  /** 有命中的查询 chunk 数 / 查询 chunk 总数。 */
  matchedQueryChunks: number;
  /** 该文献参与打分的段落（去重后按分数降序）。 */
  evidence: SimilarChunkHit[];
  /** 该文献最高的单段相似度，用于说明分数是被广度还是深度撑起来的。 */
  bestChunkScore: number;
}

export interface AggregationOptions {
  chunksPerQuery?: number;
  meanWeight?: number;
  maxWeight?: number;
  /** 证据里最多保留多少段（只影响输出，不影响分数）。 */
  maxEvidence?: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** 单篇候选文献的聚合。查询 chunk 数量由 perQuery 的长度决定。 */
export function aggregateSimilarDocument(
  match: SimilarDocumentMatch,
  options: AggregationOptions = {},
): AggregatedSimilarDocument {
  const chunksPerQuery = Math.max(
    1,
    Math.floor(options.chunksPerQuery ?? SIMILAR_CHUNKS_PER_QUERY),
  );
  const meanWeight = options.meanWeight ?? SIMILAR_MEAN_WEIGHT;
  const maxWeight = options.maxWeight ?? SIMILAR_MAX_WEIGHT;
  const maxEvidence = Math.max(1, Math.floor(options.maxEvidence ?? 5));

  const perQueryScores: number[] = [];
  const bestByChunkId = new Map<number, number>();
  let matchedQueryChunks = 0;
  let bestChunkScore = 0;

  for (const hits of match.perQuery) {
    const usable = (hits ?? [])
      .filter((hit) => Number.isFinite(hit.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, chunksPerQuery);
    if (usable.length > 0) matchedQueryChunks += 1;
    for (const hit of usable) {
      const clamped = Math.min(1, Math.max(0, hit.score));
      if (clamped > bestChunkScore) bestChunkScore = clamped;
      const previous = bestByChunkId.get(hit.chunkId);
      if (previous === undefined || clamped > previous) {
        bestByChunkId.set(hit.chunkId, clamped);
      }
    }
    // 没有命中的查询 chunk 计 0 分：这一方面确实没有对应内容。
    perQueryScores.push(
      mean(usable.map((hit) => Math.min(1, Math.max(0, hit.score)))),
    );
  }

  const breadth = mean(perQueryScores);
  const depth = perQueryScores.length === 0 ? 0 : Math.max(...perQueryScores);
  const weightSum = meanWeight + maxWeight;
  const score =
    weightSum <= 0
      ? 0
      : Math.min(
          1,
          Math.max(0, (meanWeight * breadth + maxWeight * depth) / weightSum),
        );

  const evidence = Array.from(bestByChunkId.entries())
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score || a.chunkId - b.chunkId)
    .slice(0, maxEvidence);

  return {
    itemKey: match.itemKey,
    libraryID: match.libraryID,
    score,
    perQueryScores,
    matchedQueryChunks,
    evidence,
    bestChunkScore,
  };
}

/**
 * 聚合全部候选文献 → 过阈值 → 排序。
 *
 * 这里不做任何数量截断：阈值之上有多少篇就是多少篇，分页在这份完整名单上开窗口。
 */
export function rankSimilarDocuments(
  matches: SimilarDocumentMatch[],
  options: AggregationOptions & {
    minScore: number;
    /** 结果中要排除的文献（查询文献自身）。 */
    excludeItemKeys?: Array<{ libraryID: number; itemKey: string }>;
  },
): { ranked: AggregatedSimilarDocument[]; discardedBelowThreshold: number } {
  const excluded = new Set(
    (options.excludeItemKeys ?? []).map(
      (identity) => `${identity.libraryID}:${identity.itemKey}`,
    ),
  );

  let discardedBelowThreshold = 0;
  const ranked: AggregatedSimilarDocument[] = [];
  for (const match of matches) {
    if (excluded.has(`${match.libraryID}:${match.itemKey}`)) continue;
    const aggregated = aggregateSimilarDocument(match, options);
    if (aggregated.score < options.minScore) {
      discardedBelowThreshold += 1;
      continue;
    }
    ranked.push(aggregated);
  }

  // 同分时按 itemKey 排序，让同一份索引上的两次调用给出同一个顺序 —— 分页依赖
  // 这个稳定性，否则第二页可能重复或漏掉第一页边界上的文献。
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.bestChunkScore - a.bestChunkScore ||
      a.itemKey.localeCompare(b.itemKey),
  );

  return { ranked, discardedBelowThreshold };
}
