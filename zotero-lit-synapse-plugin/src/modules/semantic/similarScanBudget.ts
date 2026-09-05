/**
 * find_similar 的扫描预算。
 *
 * 用户只有一个旋钮：vectorScanTimeoutMs，它的含义是「一次全库向量扫描允许花多久」。
 * find_similar 要用 N 个查询 chunk 扫全库，直接套用单查询预算会把正常调用误判成
 * 超时；但也不能简单按 N 倍放大——两条执行路径的代价结构完全不同：
 *
 *   CPU：数据库只读一遍、Int8 只解码一遍，只有点积随 N 增长 → 有很大的固定成本；
 *   GPU：向量常驻显存，worker 一次只收一个查询 → N 次独立全库扫描，近似线性。
 *
 * 下面的系数来自本机实测（scripts/benchmark-find-similar-scaling.js，
 * 60000 chunk / 6000 篇文献 / 1024 维 / Int8，取中位数，倍率相对各自路径的
 * 单次全库扫描）：
 *
 *   N        1      3      5     10     20
 *   CPU   1.01   1.42   1.88   2.99   5.24    拟合 ≈ 0.78 + 0.22 N
 *   GPU   0.76   2.25   3.75   7.54  14.72    拟合 ≈ 0.74 N
 *
 * 预算在拟合值之上留约 1.4–1.6 倍余量：实测是单机中位数，而用户的库大小、向量维度
 * （1024 vs 2560）、磁盘和显卡都不同；余量吸收这些差异，但仍然远小于「N 倍」，所以
 * 真正卡死的调用依然会被判超时。绝对值全部来自用户自己的 vectorScanTimeoutMs，
 * 用户调大调小，本工具自动跟随。
 */

/** 每条路径的倍率模型：multiplier = intercept + slope × N。 */
export const SIMILAR_SCAN_BUDGET_MODEL = {
  cpu: {
    /** 单遍读取 + 解码的共享成本（实测 0.78）。 */
    intercept: 0.8,
    /** 每增加一个查询 chunk 的边际成本（实测 0.22，留余量取 0.35）。 */
    slope: 0.35,
    measured: { 1: 1.01, 3: 1.42, 5: 1.88, 10: 2.99, 20: 5.24 },
  },
  gpu: {
    /** 每次扫描都是独立的，共享成本接近 0（实测 ~0）。 */
    intercept: 0.5,
    /** 每个查询 chunk 就是一次完整显存扫描（实测 0.74，留余量取 1.1）。 */
    slope: 1.1,
    measured: { 1: 0.76, 3: 2.25, 5: 3.75, 10: 7.54, 20: 14.72 },
  },
} as const;

export type SimilarScanPath = keyof typeof SIMILAR_SCAN_BUDGET_MODEL;

/**
 * 预算的绝对上限，等于单次扫描超时本身允许的最大值（见 HYBRID_SETTING_BOUNDS）。
 *
 * 只在用户把 vectorScanTimeoutMs 调到极端值时才会生效：1 小时 × 22.5 倍是没有任何
 * 意义的等待。默认 8000ms 下永远不会触发（20 个 chunk 走 GPU 也只有 180s）。
 */
export const SIMILAR_SCAN_BUDGET_CEILING_MS = 3600000;

export interface SimilarScanBudget {
  /** 本次调用实际使用的扫描截止预算。 */
  timeoutMs: number;
  /** 相对用户单次扫描设置的倍率。 */
  multiplier: number;
  path: SimilarScanPath;
  queryChunkCount: number;
  /** 用户设置本身，原样回报便于诊断。 */
  vectorScanTimeoutMs: number;
  /** 是否被绝对上限截断。 */
  capped: boolean;
}

/**
 * 按查询 chunk 数量和实际执行路径，把用户的单次扫描预算放大成本次调用的预算。
 *
 * 纯函数：不读设置、不碰 Zotero，可以直接单测。
 */
export function resolveSimilarScanBudget(params: {
  queryChunkCount: number;
  vectorScanTimeoutMs: number;
  /** GPU 加速当前是否真的在用；不确定时传 'gpu'，因为它的预算更宽。 */
  path: SimilarScanPath;
}): SimilarScanBudget {
  const queryChunkCount = Math.max(
    1,
    Math.floor(Number(params.queryChunkCount) || 1),
  );
  const base = Math.max(1, Math.floor(Number(params.vectorScanTimeoutMs) || 1));
  const model = SIMILAR_SCAN_BUDGET_MODEL[params.path];
  const multiplier = model.intercept + model.slope * queryChunkCount;
  const raw = Math.ceil(base * multiplier);
  const timeoutMs = Math.min(raw, SIMILAR_SCAN_BUDGET_CEILING_MS);

  return {
    timeoutMs,
    multiplier,
    path: params.path,
    queryChunkCount,
    vectorScanTimeoutMs: base,
    capped: timeoutMs < raw,
  };
}
