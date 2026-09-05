/**
 * 知识图谱里，一个文献节点该染成什么颜色。
 *
 * ## 为什么不再按 Page 上色
 *
 * 原来的规则是「这篇文献贡献 Claim 最多的那个 Page 的序号」。它在 Wiki 有五六个
 * Page 时是好用的，而这套系统的整个目标之一恰恰是让写入者**别再一篇文献开一个
 * Page**——目标达成之后，库里只剩一个主题页，于是所有节点 group 都是 0，颜色通道
 * 塌成常量。实测：4 篇文献、4 条 Claim、1 个 Page，四个节点同色。
 *
 * 把「一页 = 一色」修好的办法不是回到一篇一页，而是让颜色去表达页**内部**的结构。
 *
 * ## 为什么是「最具区分度的 Claim」，而不是「支撑最多的 Claim」
 *
 * 边已经在表达「谁和谁共享论断」了——实线就是这个意思。颜色再去表达一次是浪费。
 * 有信息量的是另一个问题：**这篇文献在这一页里，独特地扛着哪一条论断。**
 *
 * 所以取这篇文献支撑的、支撑者最少的那条 Claim。实测数据上的效果：
 *
 *     4V3CP6BB {334,335}      → 335（2 篇支撑）
 *     EMWXIG66 {333,334,335}  → 335
 *     BRF2ZXMX {333,334,336}  → 336（2 篇支撑）
 *     P7ARF6XI {333,336}      → 336
 *
 * 于是「讲低层错能与微孪晶的那两篇」一色，「讲取向依赖性的那两篇」另一色。反过来
 * 若取支撑最多的那条，四篇会全落到 333/334 上，又变成一两种颜色——因为被最多文献
 * 支撑的论断，恰恰是最不能区分文献的那一条。
 *
 * 纯函数、无 Zotero 依赖，可以直接在 Node 下跑单测。
 */

export interface GraphGroupDocument {
  itemKey: string;
  /** Claims this document is cited as evidence for. Order irrelevant. */
  claimIds: readonly number[];
}

/**
 * 文献 → 颜色组号。
 *
 * 组号是「被选中的 Claim 在全部 Claim 升序排列中的位置」，而不是 claimId 本身：
 * 渲染层要 `groups[group % palette.length]`，直接用 id 会让 8 色调色板上的落点
 * 由数据库自增值决定，同一批文献换个库就换一套颜色。用位置则只取决于这一页有哪些
 * Claim，稳定且可复现。
 *
 * 没有任何 Claim 的文献（幽灵节点）得 0：它们本来就画成空心轮廓，颜色不承载信息。
 */
export function assignDocumentGroups(
  documents: readonly GraphGroupDocument[],
): Map<string, number> {
  const groups = new Map<string, number>();
  if (!documents.length) return groups;

  // 每条 Claim 被多少篇不同文献支撑。
  const reach = new Map<number, Set<string>>();
  for (const document of documents) {
    for (const claimId of document.claimIds) {
      const supporters =
        reach.get(claimId) ?? reach.set(claimId, new Set()).get(claimId)!;
      supporters.add(document.itemKey);
    }
  }
  // 稳定的 Claim 顺序，决定调色板落点。
  const order = new Map(
    Array.from(reach.keys())
      .sort((left, right) => left - right)
      .map((claimId, index) => [claimId, index] as const),
  );

  for (const document of documents) {
    if (!document.claimIds.length) {
      groups.set(document.itemKey, 0);
      continue;
    }
    let chosen: number | null = null;
    let chosenReach = Number.POSITIVE_INFINITY;
    for (const claimId of document.claimIds) {
      const supporters = reach.get(claimId)?.size ?? 0;
      // 同样稀有时取 claimId 小的，让同一份数据每次都得到同一张图。
      if (
        supporters < chosenReach ||
        (supporters === chosenReach && chosen !== null && claimId < chosen)
      ) {
        chosen = claimId;
        chosenReach = supporters;
      }
    }
    groups.set(document.itemKey, chosen === null ? 0 : (order.get(chosen) ?? 0));
  }
  return groups;
}
