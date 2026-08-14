/**
 * Hybrid search settings — the single source of truth for the retrieval caps
 * the user controls in Preferences → Hybrid Search.
 *
 * These values are user-facing caps or thresholds. Candidate enumeration is
 * exhaustive and is therefore not configurable here.
 */

declare const Zotero: any;
declare let ztoolkit: ZToolkit;

const PREF_PREFIX = "extensions.zotero.zotero-mcp-plugin.";

export interface HybridSearchSettings {
  /** Use the bundled NVIDIA CUDA worker when it is available. */
  gpuAccelerationEnabled: boolean;
  /** Upper bound on documents returned by library-level hybrid search. */
  maxDocuments: number;
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
  /** Maximum time spent in the full-library vector scan itself. */
  searchTimeoutMs: number;
}

export const HYBRID_SETTING_DEFAULTS: HybridSearchSettings = {
  gpuAccelerationEnabled: false,
  maxDocuments: 20,
  maxChunksPerItem: 5,
  minScore: 0.6,
  chunkTargetChars: 1000,
  chunkAppendToleranceChars: 500,
  neighborRadius: 1,
  searchTimeoutMs: 8000,
};

export const HYBRID_SETTING_BOUNDS = {
  maxDocuments: { min: 1, max: 20 },
  maxChunksPerItem: { min: 1, max: 50 },
  minScore: { min: 0, max: 1 },
  chunkTargetChars: { min: 200, max: 4000 },
  chunkAppendToleranceChars: { min: 0, max: 2000 },
  neighborRadius: { min: 0, max: 10 },
  searchTimeoutMs: { min: 1, max: 3600000 },
} as const;

export const HYBRID_SETTING_PREF_KEYS = {
  gpuAccelerationEnabled: "hybrid.gpuAccelerationEnabled",
  maxDocuments: "hybrid.maxDocuments",
  maxChunksPerItem: "hybrid.maxChunksPerItem",
  minScore: "hybrid.minScore",
  chunkTargetChars: "hybrid.chunkTargetChars",
  chunkAppendToleranceChars: "hybrid.chunkAppendToleranceChars",
  neighborRadius: "hybrid.neighborRadius",
  searchTimeoutMs: "hybrid.searchTimeoutMs",
} as const;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

type NumericHybridSetting = Exclude<
  keyof HybridSearchSettings,
  "gpuAccelerationEnabled"
>;

function readNumberPref(
  key: NumericHybridSetting,
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
    gpuAccelerationEnabled:
      (() => {
        try {
          return (
            Zotero.Prefs.get(
              PREF_PREFIX + HYBRID_SETTING_PREF_KEYS.gpuAccelerationEnabled,
              true,
            ) === true
          );
        } catch {
          return HYBRID_SETTING_DEFAULTS.gpuAccelerationEnabled;
        }
      })(),
    maxDocuments: readNumberPref("maxDocuments", true),
    maxChunksPerItem: readNumberPref("maxChunksPerItem", true),
    minScore: readNumberPref("minScore", false),
    chunkTargetChars: readNumberPref("chunkTargetChars", true),
    chunkAppendToleranceChars: readNumberPref(
      "chunkAppendToleranceChars",
      true,
    ),
    neighborRadius: readNumberPref("neighborRadius", true),
    searchTimeoutMs: readNumberPref("searchTimeoutMs", true),
  };
}

/** Persist an integer vector-scan timeout, rounding benchmark maxima upward. */
export function setSearchTimeoutMs(value: number): number {
  const bounds = HYBRID_SETTING_BOUNDS.searchTimeoutMs;
  const finite = Number.isFinite(value)
    ? value
    : HYBRID_SETTING_DEFAULTS.searchTimeoutMs;
  const stored = Math.ceil(clamp(finite, bounds.min, bounds.max));
  Zotero.Prefs.set(
    PREF_PREFIX + HYBRID_SETTING_PREF_KEYS.searchTimeoutMs,
    stored,
    true,
  );
  return stored;
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

interface StoredChunkingSignatures {
  version: 1;
  /** A legacy global string cannot prove completion for any one library. */
  legacyUntrusted: boolean;
  libraries: Record<string, string>;
  incompleteLibraries?: Record<string, true>;
}

function readStoredChunkingSignatures(): StoredChunkingSignatures {
  try {
    const value = Zotero.Prefs.get(INDEX_CHUNK_SIGNATURE_PREF, true);
    if (typeof value !== "string" || !value.trim()) {
      return { version: 1, legacyUntrusted: false, libraries: {}, incompleteLibraries: {} };
    }
    try {
      const parsed = JSON.parse(value) as Partial<StoredChunkingSignatures>;
      if (
        parsed.version === 1 &&
        parsed.libraries &&
        typeof parsed.libraries === "object"
      ) {
        return {
          version: 1,
          legacyUntrusted: parsed.legacyUntrusted === true,
          libraries: Object.fromEntries(
            Object.entries(parsed.libraries).filter(
              ([, signature]) =>
                typeof signature === "string" && signature.length > 0,
            ),
          ),
          incompleteLibraries:
            parsed.incompleteLibraries &&
            typeof parsed.incompleteLibraries === "object"
              ? Object.fromEntries(
                  Object.keys(parsed.incompleteLibraries).map((key) => [key, true]),
                )
              : {},
        };
      }
    } catch {
      // The old format stored the signature itself instead of JSON.
    }
    return { version: 1, legacyUntrusted: true, libraries: {}, incompleteLibraries: {} };
  } catch {
    return { version: 1, legacyUntrusted: false, libraries: {}, incompleteLibraries: {} };
  }
}

export function getStoredChunkingSignature(libraryID: number): string | null {
  return readStoredChunkingSignatures().libraries[String(libraryID)] ?? null;
}

export function hasUntrustedLegacyChunkingSignature(
  libraryID: number,
): boolean {
  const state = readStoredChunkingSignatures();
  return state.legacyUntrusted && !state.libraries[String(libraryID)];
}

export function setStoredChunkingSignature(
  libraryID: number,
  signature: string,
): void {
  try {
    const state = readStoredChunkingSignatures();
    state.libraries[String(libraryID)] = signature;
    delete state.incompleteLibraries?.[String(libraryID)];
    Zotero.Prefs.set(
      INDEX_CHUNK_SIGNATURE_PREF,
      JSON.stringify(state),
      true,
    );
  } catch (error) {
    ztoolkit.log(
      `[HybridSettings] Failed to store chunking signature: ${error}`,
      "warn",
    );
    throw error;
  }
}

export function invalidateStoredChunkingSignature(libraryID: number): void {
  try {
    const state = readStoredChunkingSignatures();
    delete state.libraries[String(libraryID)];
    state.incompleteLibraries ??= {};
    state.incompleteLibraries[String(libraryID)] = true;
    Zotero.Prefs.set(
      INDEX_CHUNK_SIGNATURE_PREF,
      JSON.stringify(state),
      true,
    );
  } catch (error) {
    ztoolkit.log(
      `[HybridSettings] Failed to invalidate chunking signature: ${error}`,
      "warn",
    );
    throw error;
  }
}

export function hasIncompleteFullLibraryRebuild(libraryID: number): boolean {
  return readStoredChunkingSignatures().incompleteLibraries?.[
    String(libraryID)
  ] === true;
}

export function shouldRecordFullLibraryChunkingSignature(params: {
  rebuild: boolean;
  itemKeysProvided: boolean;
  status: string;
  processed: number;
  total: number;
  failedCount: number;
}): boolean {
  return (
    params.rebuild &&
    !params.itemKeysProvided &&
    params.status === "completed" &&
    params.processed === params.total &&
    params.failedCount === 0
  );
}
