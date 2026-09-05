/**
 * 两篇文献之间的语义连接分：方向分、对称分，以及「套话降权」。
 *
 * ## 为什么分数必须有方向
 *
 * 现有 `aggregateSimilarDocument` 的口径是：拿查询文献的每个 query chunk，在候选
 * 文献里找最相似的 top-2 段求平均，再跨 query chunk 聚合。也就是说它回答的是
 * 「A 的代表段落在 B 里被覆盖得有多好」。反过来问「B 的代表段落在 A 里被覆盖得
 * 有多好」是另一个问题，答案经常明显不同——一篇长综述几乎覆盖每篇专题论文，反过来
 * 则不成立。把单向分当成对称边保存，就是把「B 包含 A」写成「A 与 B 相关」。
 *
 * 所以文献对存两个方向，并且对称分用几何平均：
 *
 *     score_symmetric = sqrt(score_ab × score_ba)
 *
 * 几何平均的三个性质正好都要：严格对称；单向很高而反向很低时会被明显惩罚（算术
 * 平均不会）；保持 0..1 尺度，可以和用户设定的阈值直接比。
 *
 * ## 为什么聚合公式必须改，而不能「一行不改」
 *
 * 原始聚合是「广度为主、峰值为辅」：0.75 × mean + 0.25 × max。这个思想保留，但
 * 一旦引入 IDF 加权，公式就已经变了，声称没变只是自欺：
 *
 *     s_i        = 候选文献中与代表段 i 最相似的 top-2 段的平均分
 *     breadth_i  = 代表段 i 在同一次粗扫描中，命中分超过阈值的不同文献数
 *     w_i        = log((N + 1) / (breadth_i + 1)) / log(N + 1)
 *     direction  = 0.75 × Σ(w_i s_i)/Σw_i + 0.25 × max(w_i s_i)
 *
 * `breadth_i` 是这里唯一真正新的量，也是整套降噪的支点。它衡量的不是「这一段有
 * 多重要」，而是「这一段有多不挑对象」。「试样经砂纸打磨后抛光并用 4% 硝酸酒精
 * 腐蚀」和全库每一篇金相论文都像，它的 breadth 接近 N，权重被压到接近 0；
 * 「Lomer-Cottrell 位错锁在层错能较低的合金中更易形成」只和少数几篇像，权重接近 1。
 * 没有这一项，得分最高的文献对会是「都用了金相制样」的那些，而且它们会连成完全图。
 *
 * 超过 BREADTH_CAP 的代表段完全不允许独自撑起一条候选边（仍保留在调试统计里）。
 *
 * 纯函数、无 Zotero 依赖，可以直接在 Node 下跑单测。
 */

/** 打分算法版本。公式改动必须同时改这里，旧 signal 才能被认出需要重算。 */
export const LINK_ALGORITHM_VERSION = "link-sem-v2";
// v2: the representative selector's boilerplate filter never matched a
// Markdown heading, so acknowledgements, competing-interest and reference
// sections were being used as query vectors and became candidate anchors. The
// signals that produced cannot be explained by the corrected selector, so they
// are superseded rather than carried forward.

/** 广度项权重，沿用现有 similarDocumentAggregation 的比例。 */
export const DIRECTION_MEAN_WEIGHT = 0.75;
/** 深度项权重。 */
export const DIRECTION_MAX_WEIGHT = 0.25;

/** 一个代表段在候选文献里的命中情况。 */
export interface AnchorHit {
  /** 查询侧的代表 chunk。 */
  queryChunkId: number;
  /** 候选侧命中的 chunk。没有命中时为 null。 */
  matchedChunkId: number | null;
  /** top-2 命中的平均分，即 s_i。 */
  score: number;
  /** 该代表段在同一次粗扫描中命中的不同文献数，即 breadth_i。 */
  breadthDocs: number;
}

export interface DirectionScore {
  score: number;
  /** 逐段权重，与 anchors 顺序一致。 */
  weights: number[];
  /** 加权后分数最高的那一段，作为这条方向的锚点。 */
  best: (AnchorHit & { weight: number; weighted: number }) | null;
  /** 因 breadth 超过 cap 而不允许单独承载候选边的段数。 */
  suppressed: number;
}

/**
 * 特异性权重 w_i。
 *
 * 归一化到 0..1（除以 log(N+1)），这样它是「权重」而不是「另一个尺度的分数」，
 * 加权平均的结果仍然可以和余弦阈值比较。
 */
export function specificityWeight(breadthDocs: number, documentCount: number): number {
  const total = Math.max(1, documentCount);
  const denominator = Math.log(total + 1);
  if (!(denominator > 0)) return 1;
  const breadth = Math.max(0, breadthDocs);
  const weight = Math.log((total + 1) / (breadth + 1)) / denominator;
  return Math.min(1, Math.max(0, weight));
}

export function scoreDirection(
  anchors: readonly AnchorHit[],
  options: { documentCount: number; breadthCap: number },
): DirectionScore {
  if (!anchors.length) {
    return { score: 0, weights: [], best: null, suppressed: 0 };
  }
  const weights: number[] = [];
  let weightedSum = 0;
  let weightSum = 0;
  let peak = 0;
  let suppressed = 0;
  let best: (AnchorHit & { weight: number; weighted: number }) | null = null;

  for (const anchor of anchors) {
    const weight = specificityWeight(anchor.breadthDocs, options.documentCount);
    weights.push(weight);
    const clamped = Math.min(1, Math.max(0, anchor.score));
    const weighted = weight * clamped;
    // 命中过的文献太多的段落仍然参与加权平均（它确实是这篇论文的一部分），
    // 但不允许成为这条边的锚点——不然边上写着的就是「都做了金相制样」。
    const overCap = anchor.breadthDocs > options.breadthCap;
    if (overCap) suppressed += 1;
    weightedSum += weighted;
    weightSum += weight;
    if (!overCap && weighted > peak) {
      peak = weighted;
      best = { ...anchor, weight, weighted };
    }
  }

  const mean = weightSum > 0 ? weightedSum / weightSum : 0;
  const score =
    DIRECTION_MEAN_WEIGHT * mean + DIRECTION_MAX_WEIGHT * peak;
  return {
    score: Math.min(1, Math.max(0, score)),
    weights,
    best,
    suppressed,
  };
}

/**
 * 对称分。几何平均：见文件头。
 *
 * 任一方向为 0 时结果为 0，这是有意的——一个方向完全没有覆盖，就不是一条对称边。
 */
export function symmetricScore(scoreAB: number, scoreBA: number): number {
  const a = Math.min(1, Math.max(0, scoreAB));
  const b = Math.min(1, Math.max(0, scoreBA));
  return Math.sqrt(a * b);
}

/**
 * 词法信号的 IDF，口径与概念边一致：log((N + 1) / (df + 1))。
 *
 * 这里必须用真实文献频率。`libraryFieldStats` 提供的是 BM25F 归一化用的各字段
 * 平均长度，不是词项稀有度——把它当稀有度用会得到一个与稀有度无关的数。
 */
export function lexicalIdf(documentFrequency: number, documentCount: number): number {
  const total = Math.max(0, documentCount);
  const df = Math.max(0, documentFrequency);
  return Math.log((total + 1) / (df + 1));
}

/**
 * 稳定的 signal 指纹。
 *
 * 用途只有一个：阻止同一次扫描、或重复扫描，为同一个发现生成两条 signal。因此它
 * 由「这条发现是什么」的稳定部分构成——类型、算法版本、方向、术语、两侧内容 hash——
 * 而不包含分数或时间戳，那两个每次都会微动。
 *
 * 反过来，算法版本或任一侧正文变化时指纹必然变化，于是新扫描产生的是一条新
 * signal，而不是悄悄复用旧的 chunk id。这正是失效机制要的：旧 chunk id 指向新
 * 内容却仍被当作有效候选，是这套设计最要避免的两种故障之一。
 */
export function signalFingerprint(parts: {
  signalType: string;
  algorithmVersion: string;
  direction: string;
  sourceModel?: string;
  termSnapshot?: string;
  aChunkTextHash?: string;
  bChunkTextHash?: string;
  aExcerptHash?: string;
  bExcerptHash?: string;
}): string {
  return [
    parts.signalType,
    parts.algorithmVersion,
    parts.direction,
    parts.sourceModel ?? "",
    parts.termSnapshot ?? "",
    parts.aChunkTextHash ?? "",
    parts.bChunkTextHash ?? "",
    parts.aExcerptHash ?? "",
    parts.bExcerptHash ?? "",
  ].join("|");
}

/** 无向文献对的规范化：谁是 a、谁是 b 只由 itemKey 排序决定。 */
export function normalizePair(
  left: string,
  right: string,
): { aItemKey: string; bItemKey: string; swapped: boolean } {
  return left < right
    ? { aItemKey: left, bItemKey: right, swapped: false }
    : { aItemKey: right, bItemKey: left, swapped: true };
}

/**
 * 方向标签也要跟着规范化一起翻转。
 *
 * 从 A 触发扫描得到的「查询侧→候选侧」，在 (B,A) 被规范化成 (A,B) 之后就是
 * `b_to_a`。忘了翻转，两次触发顺序不同的同一对文献就会得到互相矛盾的方向记录。
 */
export function orientDirection(
  queryIsA: boolean,
): "a_to_b" | "b_to_a" {
  return queryIsA ? "a_to_b" : "b_to_a";
}
