/**
 * 把用户的分类（Collection）解析成一份「本次检索只看这些文献」的清单。
 *
 * 为什么要有它：全库检索每次都要对所有 chunk 算一遍相似度。用户其实已经用
 * 分类表达了自己的知识结构，先让 AI 看一眼分类、再决定范围，能把扫描量降到
 * 相关的那一部分。
 *
 * 但范围收窄有一个必须守住的方向性原则：**宁可多检索不确定的分类，也不能因为
 * 看不懂分类名就漏掉文献**。用户的分类名常常是「综述」「待读」「课题资料」
 * 「论文写作」这种不带学科信息的自定义名称，它们里面可能全是高相关文献。所以
 * 这里的每一处兜底都朝「多搜」的方向倒：解析不出的 key 不会让整次检索失败，
 * 空范围会退回全库，而不是返回零结果。
 *
 * 依赖以注入方式传入，因此这份逻辑可以脱离 Zotero 在 Node 下跑单测。
 */

/** 一个分类在解析时需要暴露的最小信息。 */
export interface CollectionAccess {
  key: string;
  name: string;
  /** 直接子分类的 key。 */
  childCollectionKeys: string[];
  /** 直接归属于该分类的文献 itemKey。 */
  itemKeys: string[];
}

export interface CollectionScopeDeps {
  /** 找不到时返回 null，而不是抛错。 */
  getCollection: (key: string) => CollectionAccess | null;
}

export interface ResolvedCollection {
  key: string;
  name: string;
  /** 含子分类在内，该分类实际贡献的文献数。 */
  itemCount: number;
}

export interface CollectionScope {
  /** 'library' 表示未收窄；'collections' 表示按分类收窄。 */
  searchScope: "library" | "collections";
  /** 调用方请求的 key（原样保留，便于对照）。 */
  requested: string[];
  /** 真正解析成功的分类。 */
  collections: ResolvedCollection[];
  /** 请求了但库里不存在的 key。 */
  missing: string[];
  /** 因为已被别的分类包含而未重复计数的子分类数量。 */
  subcollectionsIncluded: number;
  /** 去重后的范围内文献 key；searchScope 为 'library' 时为空。 */
  itemKeys: string[];
  /** 是否退回了全库。 */
  fellBackToLibrary: boolean;
  /** 退回全库的原因；未退回时为 null。 */
  fallbackReason: string | null;
}

/**
 * 收窄范围的上限。
 *
 * 超过这个规模，收窄省下的计算已经不多，而把上万个 key 塞进 SQL 的 IN 列表
 * 反而会撞上 SQLite 的变量数上限——那会让检索直接失败，而不是慢一点。
 * 这种情况按「宁可多搜」退回全库。
 */
export const MAX_SCOPE_ITEMS = 5000;

/**
 * 解析分类范围。
 *
 * 子分类一律递归纳入：用户选「材料科学」时想要的是它下面的全部内容，
 * 而不是只有直接挂在该层的那几篇。
 */
export function resolveCollectionScope(
  requestedKeys: unknown,
  deps: CollectionScopeDeps,
): CollectionScope {
  const requested = normalizeKeys(requestedKeys);

  if (requested.length === 0) {
    return {
      searchScope: "library",
      requested: [],
      collections: [],
      missing: [],
      subcollectionsIncluded: 0,
      itemKeys: [],
      fellBackToLibrary: false,
      fallbackReason: null,
    };
  }

  const seenCollections = new Set<string>();
  const itemKeySet = new Set<string>();
  const collections: ResolvedCollection[] = [];
  const missing: string[] = [];
  let subcollectionsIncluded = 0;

  for (const key of requested) {
    const root = deps.getCollection(key);
    if (!root) {
      missing.push(key);
      continue;
    }
    if (seenCollections.has(root.key)) continue;

    const before = itemKeySet.size;
    // Breadth-first over the subtree; the seen-set also protects against a
    // cycle in a corrupted library rather than hanging on it.
    const queue: CollectionAccess[] = [root];
    seenCollections.add(root.key);
    let isRoot = true;
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (!isRoot) subcollectionsIncluded += 1;
      isRoot = false;
      for (const itemKey of node.itemKeys) {
        if (itemKey) itemKeySet.add(itemKey);
      }
      for (const childKey of node.childCollectionKeys) {
        if (seenCollections.has(childKey)) continue;
        const child = deps.getCollection(childKey);
        if (!child) continue;
        seenCollections.add(child.key);
        queue.push(child);
      }
    }

    collections.push({
      key: root.key,
      name: root.name,
      itemCount: itemKeySet.size - before,
    });
  }

  const itemKeys = [...itemKeySet];

  // Every fallback below leans the same way: search MORE rather than return an
  // empty or broken result. A scope the caller asked for that turns out to be
  // unusable must never look like "the library has nothing".
  if (collections.length === 0) {
    return {
      searchScope: "library",
      requested,
      collections: [],
      missing,
      subcollectionsIncluded: 0,
      itemKeys: [],
      fellBackToLibrary: true,
      fallbackReason: `none of the requested collections exist (${missing.join(", ")}); searched the whole library instead of returning nothing`,
    };
  }

  if (itemKeys.length === 0) {
    return {
      searchScope: "library",
      requested,
      collections,
      missing,
      subcollectionsIncluded,
      itemKeys: [],
      fellBackToLibrary: true,
      fallbackReason:
        "the requested collections contain no items; searched the whole library instead of returning nothing",
    };
  }

  if (itemKeys.length > MAX_SCOPE_ITEMS) {
    return {
      searchScope: "library",
      requested,
      collections,
      missing,
      subcollectionsIncluded,
      itemKeys: [],
      fellBackToLibrary: true,
      fallbackReason: `the requested collections cover ${itemKeys.length} items, above the ${MAX_SCOPE_ITEMS}-item limit for scoped search; searched the whole library instead`,
    };
  }

  return {
    searchScope: "collections",
    requested,
    collections,
    missing,
    subcollectionsIncluded,
    itemKeys,
    fellBackToLibrary: false,
    fallbackReason: null,
  };
}

function normalizeKeys(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("collectionKeys must be an array of collection keys");
  }
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new Error("collectionKeys must be an array of collection keys");
    }
    const key = entry.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}
