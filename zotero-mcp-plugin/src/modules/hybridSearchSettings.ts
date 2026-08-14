/**
 * Hybrid search settings — the single source of truth for the retrieval caps
 * the user controls in Preferences → Hybrid Search.
 *
 * 除 candidateK 之外，这些值都是「硬上限」而不是默认值：调用方（AI）可以要得
 * 更少、更严，但不能要得比用户设置的更多、也不能把阈值调得比用户设置的更低。
 *
 * candidateK 是唯一的例外，它是「默认检索深度」：它约束的是服务端往下挖多深，
 * 而不是允许返回多少。候选池被挖满时响应会明确告知调用方「这只是下界，要更
 * 完整就把 candidateK 调大」——如果把它也钳死在用户值上，这条指令就永远无法
 * 执行。真正保护用户的两道闸（返回条数、相关度阈值）仍然施加在结果上。
 *
 * 所有读取都在这里做夹取（clamp），避免各处重复写边界判断。
 */

import { CANDIDATE_K_BOUNDS } from "./hybridSearch";

declare const Zotero: any;
declare let ztoolkit: ZToolkit;

const PREF_PREFIX = "extensions.zotero.zotero-mcp-plugin.";

export interface HybridSearchSettings {
  /** Upper bound on documents returned by library-level hybrid search. */
  maxDocuments: number;
  /**
   * How many candidates each retrieval branch contributes before fusion.
   *
   * Unlike every other value here this one is a DEFAULT, not a cap. The others
   * protect the user from an AI that wants more results or a looser threshold;
   * this one only decides how deep retrieval digs, and the response tells the
   * caller when the pool filled up and asks it to dig deeper for an exhaustive
   * sweep. Clamping it to the user's number would make that instruction
   * impossible to follow.
   */
  candidateK: number;
  /** Upper bound on chunks returned per document by search_fulltext. */
  maxChunksPerItem: number;
  /** Fused relevance below this (0..1) is discarded, never padded back in. */
  minScore: number;
  /** Target characters per chunk when indexing. */
  chunkTargetChars: number;
  /** A paragraph up to this long may still join a chunk that hit the target. */
  chunkAppendToleranceChars: number;
  /** How many chunks either side may be pulled in for context. */
  neighborRadius: number;
}

export const HYBRID_SETTING_DEFAULTS: HybridSearchSettings = {
  maxDocuments: 20,
  // 240 rather than a page-sized number: measured on a 900-item library, a
  // depth of 120 reported 120 qualifying documents for a broad query when 298
  // actually qualified, while 240 costs the same ~3.7s as 120 because the
  // vector scan visits every stored vector either way.
  candidateK: 240,
  maxChunksPerItem: 5,
  minScore: 0.6,
  chunkTargetChars: 1000,
  chunkAppendToleranceChars: 500,
  neighborRadius: 1,
};

export const HYBRID_SETTING_BOUNDS = {
  maxDocuments: { min: 1, max: 100 },
  // Imported, never restated: the engine that runs the scan owns this limit,
  // and a second copy here would be free to drift out of agreement with it.
  candidateK: CANDIDATE_K_BOUNDS,
  maxChunksPerItem: { min: 1, max: 50 },
  minScore: { min: 0, max: 1 },
  chunkTargetChars: { min: 200, max: 4000 },
  chunkAppendToleranceChars: { min: 0, max: 2000 },
  neighborRadius: { min: 0, max: 10 },
} as const;

export const HYBRID_SETTING_PREF_KEYS = {
  maxDocuments: "hybrid.maxDocuments",
  candidateK: "hybrid.candidateK",
  maxChunksPerItem: "hybrid.maxChunksPerItem",
  minScore: "hybrid.minScore",
  chunkTargetChars: "hybrid.chunkTargetChars",
  chunkAppendToleranceChars: "hybrid.chunkAppendToleranceChars",
  neighborRadius: "hybrid.neighborRadius",
} as const;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function readNumberPref(
  key: keyof HybridSearchSettings,
  integer: boolean,
): number {
  const fallback = HYBRID_SETTING_DEFAULTS[key];
  const bounds = HYBRID_SETTING_BOUNDS[key];
  let raw: unknown;
  try {
    raw = Zotero.Prefs.get(PREF_PREFIX + HYBRID_SETTING_PREF_KEYS[key], true);
  } catch {
    return fallback;
  }
  // Zotero stores numeric prefs as numbers, but a hand-edited profile can hold
  // a string; a silently-NaN cap would disable the whole limit.
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return fallback;
  const bounded = clamp(parsed, bounds.min, bounds.max);
  return integer ? Math.round(bounded) : bounded;
}

export function getHybridSearchSettings(): HybridSearchSettings {
  return {
    maxDocuments: readNumberPref("maxDocuments", true),
    candidateK: readNumberPref("candidateK", true),
    maxChunksPerItem: readNumberPref("maxChunksPerItem", true),
    minScore: readNumberPref("minScore", false),
    chunkTargetChars: readNumberPref("chunkTargetChars", true),
    chunkAppendToleranceChars: readNumberPref(
      "chunkAppendToleranceChars",
      true,
    ),
    neighborRadius: readNumberPref("neighborRadius", true),
  };
}

/**
 * Apply the user's cap to a caller-requested result count.
 *
 * The caller may only ask for FEWER results than the user allows. Anything
 * larger (or missing) collapses to the user's setting.
 */
export function resolveResultCap(
  requested: unknown,
  userCap: number,
): { value: number; clamped: boolean } {
  if (requested === undefined || requested === null) {
    return { value: userCap, clamped: false };
  }
  const parsed = typeof requested === "string" ? Number(requested) : requested;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 1) {
    throw new Error("result count must be a positive integer");
  }
  const rounded = Math.floor(parsed);
  if (rounded > userCap) return { value: userCap, clamped: true };
  return { value: rounded, clamped: false };
}

/**
 * Resolve the retrieval depth for one search.
 *
 * The user's setting is the default depth, and a caller that explicitly asks
 * for a different one gets it — deeper for an exhaustive sweep, shallower for a
 * quick look — bounded only by the hard limits that keep the scan inside its
 * deadline. This is the one hybrid setting the caller may exceed, because it
 * governs how hard the server looks rather than how much it is allowed to
 * return; the caps that protect the user (result count, relevance floor) still
 * apply on top of whatever this finds.
 */
export function resolveCandidateDepth(
  requested: unknown,
  userDefault: number,
): { value: number; clamped: boolean } {
  const bounds = HYBRID_SETTING_BOUNDS.candidateK;
  if (requested === undefined || requested === null) {
    return { value: clamp(userDefault, bounds.min, bounds.max), clamped: false };
  }
  const parsed = typeof requested === "string" ? Number(requested) : requested;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 1) {
    throw new Error("candidateK must be a positive integer");
  }
  const rounded = Math.floor(parsed);
  const bounded = clamp(rounded, bounds.min, bounds.max);
  return { value: bounded, clamped: bounded !== rounded };
}

/**
 * Apply the user's relevance floor to a caller-requested threshold.
 *
 * The caller may only be STRICTER than the user. A lower threshold is raised
 * back to the user's floor, which is what makes "低于阈值的直接舍弃" a promise
 * the AI cannot talk its way out of.
 */
export function resolveScoreFloor(
  requested: unknown,
  userFloor: number,
): { value: number; clamped: boolean } {
  if (requested === undefined || requested === null) {
    return { value: userFloor, clamped: false };
  }
  const parsed = typeof requested === "string" ? Number(requested) : requested;
  if (
    typeof parsed !== "number" ||
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    parsed > 1
  ) {
    throw new Error("minScore must be a finite number between 0 and 1");
  }
  if (parsed < userFloor) return { value: userFloor, clamped: true };
  return { value: parsed, clamped: false };
}

/** Same "caller may only ask for less" rule for the neighbour radius. */
export function resolveNeighborRadius(
  requested: unknown,
  userCap: number,
): { value: number; clamped: boolean } {
  if (requested === undefined || requested === null) {
    return { value: userCap, clamped: false };
  }
  const parsed = typeof requested === "string" ? Number(requested) : requested;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error("neighborRadius must be a non-negative integer");
  }
  const rounded = Math.floor(parsed);
  if (rounded > userCap) return { value: userCap, clamped: true };
  return { value: rounded, clamped: false };
}

/**
 * Identity of the chunking rules the current settings produce.
 *
 * Stored alongside the index after a build so Preferences can tell the user
 * that an existing index predates a chunk-size change and should be rebuilt.
 * Chunk layout is the only thing that matters here — result caps and the score
 * threshold are query-time settings and never invalidate stored vectors.
 */
export function getChunkingSignature(
  settings: HybridSearchSettings = getHybridSearchSettings(),
): string {
  return `paragraph-v2:${settings.chunkTargetChars}:${settings.chunkAppendToleranceChars}`;
}

export const INDEX_CHUNK_SIGNATURE_PREF = `${PREF_PREFIX}semantic.indexChunkSignature`;

export function getStoredChunkingSignature(): string | null {
  try {
    const value = Zotero.Prefs.get(INDEX_CHUNK_SIGNATURE_PREF, true);
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

export function setStoredChunkingSignature(signature: string): void {
  try {
    Zotero.Prefs.set(INDEX_CHUNK_SIGNATURE_PREF, signature, true);
  } catch (error) {
    ztoolkit.log(
      `[HybridSettings] Failed to store chunking signature: ${error}`,
      "warn",
    );
  }
}
