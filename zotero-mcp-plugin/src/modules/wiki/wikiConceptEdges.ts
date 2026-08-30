/**
 * 把「概念 → 它被读到的文献集合」压成「文献对 → 一条共享概念边」。
 *
 * 为什么这条边必须存在：`wiki_relations` 连接 concept↔concept，`wiki_evidence`
 * 连接 claim↔source，两者都推不出 document↔document。于是只要写入行为还是
 * 「一篇文献一个 Page、每条 Claim 只引用当前文献」，图谱就必然是一堆
 * `degree === 0` 的孤岛——实测 5 篇文献、20 个概念、20 条概念来源，全部一对一。
 * 但 `wiki_concept_term_sources` 一直记着「哪个术语在哪篇文献的哪个 chunk 里被
 * 读到」，两篇文献落在同一个概念上，本身就是一条有原文支撑的连接，只是没人这样
 * 读过这张表。
 *
 * 为什么不能直接展开成完全图：一个概念挂在 n 篇文献上就提议 n(n-1)/2 对。
 * 冶金库里每篇都讲「再结晶」，只有两篇讲「Lomer-Cottrell 位错锁」，把两者同等
 * 展开的结果是四十篇左右整张图糊成一片，而且糊掉它的恰恰是最没有区分度的词。
 * 所以这里做两件事：
 *
 *   1. **稀有度加权**。每个概念按 idf 贡献权重，边的分数是 Σ idf。一条由一个
 *      稀有术语撑起来的边，要排在三个通用术语撑起来的边前面。
 *   2. **组合护栏**。来源文献数超过 `cliqueLimit` 的概念不再提议任何文献对。
 *      这不是稀有度判断（idf 已经管了），是纯粹的组合爆炸防护：它仍然计入每个
 *      概念的 df，仍然出现在详情里，只是不再自己拉线。
 *
 * 纯函数、无 Zotero 依赖，可以直接在 Node 下跑单测。
 */

/** 一个概念，以及它被读到的文献。来自 WikiStore.getConceptDocumentSources。 */
export interface ConceptDocumentSource {
  conceptId: number;
  name: string;
  /** 该概念被读到的不同文献数（全库口径，不受 visibleDocuments 影响）。 */
  df: number;
  /** log((N + 1) / (df + 1))。 */
  idf: number;
  itemKeys: string[];
}

export interface ConceptEdgeConcept {
  conceptId: number;
  name: string;
  df: number;
  idf: number;
}

export interface ConceptEdge {
  a: string;
  b: string;
  /** Σ idf，两篇文献共享概念的加权强度。 */
  score: number;
  /** 全部共享概念，按稀有度降序。 */
  concepts: ConceptEdgeConcept[];
}

export interface ConceptEdgeOptions {
  /**
   * 图上真实存在的文献。落在图外的来源不画线，也不参与配对——否则一条边会指向
   * 一个不存在的节点。
   */
  visibleDocuments: ReadonlySet<string>;
  /**
   * 已经有更强关系（共享论断、同一条目）的文献对。同一对文献只画一条主边，
   * 更强的那条才是值得画的。
   */
  excludedPairs?: ReadonlySet<string>;
  /** 来源文献数超过此值的概念不提议文献对。见上文组合护栏。 */
  cliqueLimit: number;
}

/** 与调用方一致的无向文献对键。 */
export function conceptPairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

export function buildConceptEdges(
  concepts: readonly ConceptDocumentSource[],
  options: ConceptEdgeOptions,
): ConceptEdge[] {
  const excluded = options.excludedPairs ?? new Set<string>();
  const pairs = new Map<string, ConceptEdge>();

  for (const concept of concepts) {
    const ordered = concept.itemKeys.filter((key) =>
      options.visibleDocuments.has(key),
    );
    // 一篇文献连不了任何两篇文献；超过护栏的概念只贡献 df，不贡献边。
    if (ordered.length < 2 || ordered.length > options.cliqueLimit) continue;
    for (let left = 0; left < ordered.length; left += 1) {
      for (let right = left + 1; right < ordered.length; right += 1) {
        const key = conceptPairKey(ordered[left], ordered[right]);
        if (excluded.has(key)) continue;
        const pair =
          pairs.get(key) ??
          pairs
            .set(key, {
              a: ordered[left] < ordered[right] ? ordered[left] : ordered[right],
              b: ordered[left] < ordered[right] ? ordered[right] : ordered[left],
              score: 0,
              concepts: [],
            })
            .get(key)!;
        pair.score += concept.idf;
        pair.concepts.push({
          conceptId: concept.conceptId,
          name: concept.name,
          df: concept.df,
          idf: concept.idf,
        });
      }
    }
  }

  const edges = Array.from(pairs.values());
  for (const edge of edges) {
    // 稀有优先：边上的标签要说出「到底是什么让这两篇文献相关」。
    edge.concepts.sort(
      (left, right) => right.idf - left.idf || left.conceptId - right.conceptId,
    );
  }
  // 同分时按文献对排序，让同一份数据的两次渲染给出同一个顺序。
  edges.sort(
    (left, right) =>
      right.score - left.score ||
      left.a.localeCompare(right.a) ||
      left.b.localeCompare(right.b),
  );
  return edges;
}

/**
 * 边上的文字。没有标签的候选边不画——「余弦 0.62」和「共享概念」是同一种废话，
 * 读者对它做不了任何事。
 */
export function conceptEdgeLabel(edge: ConceptEdge, named: number): string {
  const names = edge.concepts
    .slice(0, named)
    .map((concept) => concept.name)
    .filter(Boolean);
  if (!names.length) return "";
  const rest = edge.concepts.length - names.length;
  return `共享概念：${names.join("、")}${rest > 0 ? ` 等 ${edge.concepts.length} 个` : ""}`;
}

/**
 * Σ idf → 渲染层认识的线宽。
 *
 * 别处的 `strength` 是共享论断的条数，是个小整数，渲染层的
 * `0.7 + strength * 0.45` 就是照着它配的。idf 之和是完全不同尺度的实数，直接
 * 传进去会让六个通用术语撑起来的边比一条共享论断还粗。映射到 1..3，让最粗的
 * 概念边仍然细于两条论断的边——这个次序才是应该成立的。
 */
export function conceptEdgeStrength(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 1;
  return Math.min(3, 1 + score);
}
