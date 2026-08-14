/**
 * hybrid_search 的分页状态。
 *
 * 要解决的问题：一次检索里通过相关度阈值的文献可能有 47 篇，而 topK 只让
 * AI 看到前 20 篇——第 21 名之后的合格文献永远看不到。翻页是唯一的出路，
 * 但翻页本身有一个必须守住的前提：
 *
 *   全库召回 → 融合评分排序 → 按 minScore 过滤 → 得到全部合格文献 → 分页
 *
 * 分页发生在阈值之后，所以它既不可能把低于阈值的文献带进结果，也永远不需要
 * 为了凑满一页而放宽阈值。第二页不是「再搜一次」，而是同一份已排好序的合格
 * 名单上的另一个窗口——重新检索会让排名漂移，从而出现重复、遗漏、同一篇出现
 * 在两页里。
 *
 * 状态是进程内的、有过期时间的、有条数上限的：翻页是一次检索会话内的短期行为，
 * 不值得为它引入持久化。cursor 过期就重新搜一次，这是明确的错误而不是静默降级。
 *
 * 纯函数 + 显式时钟，不依赖 XPCOM，可以直接在 Node 下跑单测。
 */

/** 分页状态的存活时间：够一次文献综述的翻阅，不够长到把内存变成缓存。 */
export const PAGE_STATE_TTL_MS = 15 * 60 * 1000;
/** 同时保留的检索会话数上限，超出时淘汰最旧的。 */
export const MAX_PAGE_STATES = 5;
/** cursor 的格式版本；换格式时旧 cursor 会干净地失败而不是被误读。 */
const CURSOR_PREFIX = "hs1";

/**
 * 决定「这是不是同一次检索」的参数。
 *
 * 任何一项改变都意味着这是另一份结果集，旧 cursor 不能再用——继续用会把两次
 * 不同排序的结果拼在一起。topK 不在其中：它只是页大小，改变它只会改变窗口
 * 大小，不会改变名单本身。
 */
export interface SearchFingerprint {
  query: string;
  keywords: string[];
  domain?: string;
  expertRole?: string;
  /** 实际生效的阈值（已按用户设置收紧过），不是调用方传入的原始值。 */
  appliedMinScore: number;
  language: string;
  libraryID: number;
  /**
   * 会改变排名的检索旋钮。
   *
   * 它们必须在指纹里：带着 cursor 改 candidateK / rrfK / 分支权重，调用方以为
   * 自己换了一套排序，服务端却照旧回放旧名单——沉默地答非所问，比直接报错糟糕。
   */
  candidateK: number;
  rrfK: number;
  keywordWeight: number;
  semanticWeight: number;
  /** 第一页用的页大小；续页省略 topK 时沿用它，而不是回落到用户默认值。 */
  pageSize: number;
  /**
   * 本次检索的范围标识（全库，或按分类收窄后的那一组分类）。
   *
   * 换了范围就是换了一份结果集：同一个 cursor 继续翻，会把「只搜某几个分类」
   * 的第一页和「搜全库」的第二页拼在一起。
   */
  scope: string;
}

/**
 * 续页调用实际传了哪些检索参数。
 *
 * 只比较「传了的」：省略某个参数是「不改动它」，不是「把它改成默认值」。
 * 否则一次只带 cursor 的续页调用会因为 query 缺失而被判成换了检索。
 */
export type FingerprintClaim = Partial<SearchFingerprint>;

export interface PageState<TRow, TMeta = Record<string, unknown>> {
  searchId: string;
  fingerprint: SearchFingerprint;
  /** 通过阈值的全部文献，最终顺序。 */
  ranked: TRow[];
  /** 这次检索的静态说明（口径、诊断、耗时），续页时原样回放。 */
  meta: TMeta;
  createdAt: number;
  lastAccessAt: number;
}

export interface PageWindow<TRow> {
  rows: TRow[];
  offset: number;
  returned: number;
  totalRelevant: number;
  hasMore: boolean;
  nextCursor?: string;
}

export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

function normalizeKeywords(keywords: string[] | undefined): string[] {
  return (keywords || [])
    .map((keyword) => String(keyword).trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function normalizeText(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * 两个指纹是否指向同一次检索。
 *
 * 分数用 6 位小数比较：阈值是浮点数，来回经过 JSON 之后不该因为末位差异
 * 被判成「换了一次检索」。
 */
export function fingerprintsMatch(
  stored: SearchFingerprint,
  claim: FingerprintClaim,
): { match: true } | { match: false; changed: string } {
  if (
    claim.query !== undefined &&
    normalizeText(stored.query) !== normalizeText(claim.query)
  ) {
    return { match: false, changed: "query" };
  }
  if (
    claim.keywords !== undefined &&
    normalizeKeywords(stored.keywords).join(" ") !==
      normalizeKeywords(claim.keywords).join(" ")
  ) {
    return { match: false, changed: "keywords" };
  }
  if (
    claim.domain !== undefined &&
    normalizeText(stored.domain) !== normalizeText(claim.domain)
  ) {
    return { match: false, changed: "domain" };
  }
  if (
    claim.expertRole !== undefined &&
    normalizeText(stored.expertRole) !== normalizeText(claim.expertRole)
  ) {
    return { match: false, changed: "expertRole" };
  }
  if (
    claim.appliedMinScore !== undefined &&
    stored.appliedMinScore.toFixed(6) !== claim.appliedMinScore.toFixed(6)
  ) {
    return { match: false, changed: "minScore" };
  }
  if (
    claim.language !== undefined &&
    normalizeText(stored.language) !== normalizeText(claim.language)
  ) {
    return { match: false, changed: "language" };
  }
  if (claim.libraryID !== undefined && stored.libraryID !== claim.libraryID) {
    return { match: false, changed: "libraryID" };
  }
  if (claim.scope !== undefined && stored.scope !== claim.scope) {
    return { match: false, changed: "collectionKeys" };
  }
  for (const knob of [
    "candidateK",
    "rrfK",
    "keywordWeight",
    "semanticWeight",
  ] as const) {
    if (claim[knob] !== undefined && stored[knob] !== claim[knob]) {
      return { match: false, changed: knob };
    }
  }
  return { match: true };
}

export function encodeCursor(searchId: string, offset: number): string {
  return `${CURSOR_PREFIX}_${searchId}_${offset}`;
}

export function decodeCursor(cursor: string): {
  searchId: string;
  offset: number;
} {
  const raw = String(cursor || "").trim();
  const parts = raw.split("_");
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) {
    throw new CursorError(
      `Malformed cursor "${raw.slice(0, 40)}". Pass a nextCursor exactly as hybrid_search returned it, or omit cursor to start a new search.`,
    );
  }
  const offset = Number(parts[2]);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new CursorError(
      `Malformed cursor "${raw.slice(0, 40)}": bad offset. Omit cursor to start a new search.`,
    );
  }
  return { searchId: parts[1], offset };
}

/**
 * 进程内的分页状态表。
 *
 * 时钟由外部注入，过期与淘汰因此是可测试的，而不是「等 15 分钟看看」。
 */
export class HybridSearchPageStore<
  TRow,
  TMeta = Record<string, unknown>,
> {
  private states = new Map<string, PageState<TRow, TMeta>>();
  private counter = 0;
  // 参数属性（constructor(private x)）在 Node 的 strip-only 模式下不被支持，
  // 而单测正是用它直接跑 .ts 源码，所以这里写成普通字段赋值。
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxStates: number;

  constructor(
    now: () => number = () => Date.now(),
    ttlMs: number = PAGE_STATE_TTL_MS,
    maxStates: number = MAX_PAGE_STATES,
  ) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxStates = maxStates;
  }

  /** 登记一次新检索的合格名单，返回它的 searchId。 */
  create(fingerprint: SearchFingerprint, ranked: TRow[], meta: TMeta): string {
    this.evict();
    this.counter += 1;
    const searchId = `${this.now().toString(36)}${this.counter.toString(36)}${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    this.states.set(searchId, {
      searchId,
      fingerprint,
      ranked,
      meta,
      createdAt: this.now(),
      lastAccessAt: this.now(),
    });
    // 新会话也算一次占用，登记后再收一次，保证上限是硬的。
    this.evict();
    return searchId;
  }

  /**
   * 取出 cursor 指向的那一页。
   *
   * 调用方传来的指纹必须与建立这份名单时的一致；不一致说明检索条件被改过，
   * 这时必须报错而不是拿旧名单去回答新问题。
   */
  read(
    cursor: string,
    claim: FingerprintClaim,
    /** 省略时沿用建立这次检索时的页大小。 */
    pageSize?: number,
  ): { state: PageState<TRow, TMeta>; window: PageWindow<TRow> } {
    const { searchId, offset } = decodeCursor(cursor);
    this.evict();

    const state = this.states.get(searchId);
    if (!state) {
      throw new CursorError(
        `This cursor is no longer valid: the search it points to has expired or was replaced (pagination state lives ${Math.round(
          this.ttlMs / 60000,
        )} minutes and only the ${this.maxStates} most recent searches are kept). Run hybrid_search again without a cursor to get a fresh ranking.`,
      );
    }

    const verdict = fingerprintsMatch(state.fingerprint, claim);
    if (!verdict.match) {
      throw new CursorError(
        `Cannot continue this cursor: ${verdict.changed} differs from the search that produced it. A cursor pages through ONE ranked, threshold-filtered result set; changing ${verdict.changed} means a different result set. Drop the cursor and run hybrid_search again with the new arguments.`,
      );
    }

    state.lastAccessAt = this.now();
    return {
      state,
      window: windowOf(
        state.ranked,
        offset,
        pageSize ?? state.fingerprint.pageSize,
        searchId,
      ),
    };
  }

  get size(): number {
    return this.states.size;
  }

  clear(): void {
    this.states.clear();
  }

  /** 丢弃过期状态，并把会话数压回上限（淘汰最久未访问的）。 */
  private evict(): void {
    const now = this.now();
    for (const [id, state] of this.states) {
      if (now - state.createdAt > this.ttlMs) this.states.delete(id);
    }
    if (this.states.size <= this.maxStates) return;
    const byAge = [...this.states.values()].sort(
      (a, b) => a.lastAccessAt - b.lastAccessAt,
    );
    for (const state of byAge.slice(0, this.states.size - this.maxStates)) {
      this.states.delete(state.searchId);
    }
  }
}

/**
 * 在已排好序的合格名单上开一个窗口。
 *
 * 偏移量来自 cursor 而不是服务端游标，所以重复请求同一页得到同一页——
 * 重试不会跳过文献，也不会把同一篇发两次。
 */
export function windowOf<TRow>(
  ranked: TRow[],
  offset: number,
  pageSize: number,
  searchId: string,
): PageWindow<TRow> {
  const size = Math.max(1, Math.floor(pageSize));
  const start = Math.min(Math.max(0, Math.floor(offset)), ranked.length);
  const rows = ranked.slice(start, start + size);
  const nextOffset = start + rows.length;
  const hasMore = nextOffset < ranked.length;

  return {
    rows,
    offset: start,
    returned: rows.length,
    totalRelevant: ranked.length,
    hasMore,
    ...(hasMore ? { nextCursor: encodeCursor(searchId, nextOffset) } : {}),
  };
}
