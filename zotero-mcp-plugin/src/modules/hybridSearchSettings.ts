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
  /** GPU resident-vector precision; auto selects from the current device. */
  gpuPrecision: "auto" | "float32" | "int8";
  /** Upper bound on documents returned by library-level hybrid search. */
  maxDocuments: number;
  /** Upper bound on chunks returned per document by search_fulltext. */
  maxChunksPerItem: number;
  /**
   * Keyword-branch relevance floor, 0..1 on the normalised BM25F scale.
   *
   * Gates the keyword branch ALONE. A document below it simply contributes no
   * keyword rank to the fusion; the semantic branch can still admit it, and
   * frequently does. This is the half of the split that replaced the old single
   * fused-score floor.
   */
  keywordMinScore: number;
  /**
   * Semantic-branch relevance floor, 0..1 on the cosine scale.
   *
   * Gates the semantic branch alone, with the same "one branch cannot veto the
   * other" rule as {@link keywordMinScore}.
   */
  semanticMinScore: number;
  /** Keyword branch's weight in the weighted RRF that produces the ranking. */
  keywordRrfWeight: number;
  /** Semantic branch's weight in the same weighted RRF. */
  semanticRrfWeight: number;
  /** Target characters per chunk when indexing. */
  chunkTargetChars: number;
  /** A paragraph up to this long may still join a chunk that hit the target. */
  chunkAppendToleranceChars: number;
  /** How many chunks either side may be pulled in for context. */
  neighborRadius: number;
  /**
   * Maximum time spent in the full-library vector scan itself.
   *
   * The query embedding is NOT covered by this: it is a network request with
   * its own fixed deadline (see EMBEDDING_TIMEOUT_MS in semanticSearchService),
   * so a slow embedding endpoint cannot eat the scan's budget.
   */
  vectorScanTimeoutMs: number;
  /**
   * Maximum time the keyword (metadata) branch of hybrid retrieval may take.
   *
   * This is a per-branch deadline, not a whole-search deadline: the keyword and
   * vector branches run in parallel and are bounded independently.
   */
  keywordSearchTimeoutMs: number;
}

export const HYBRID_SETTING_DEFAULTS: HybridSearchSettings = {
  gpuAccelerationEnabled: false,
  gpuPrecision: "auto",
  maxDocuments: 20,
  maxChunksPerItem: 5,
  keywordMinScore: 0.52,
  semanticMinScore: 0.6,
  keywordRrfWeight: 1,
  semanticRrfWeight: 1,
  chunkTargetChars: 1000,
  chunkAppendToleranceChars: 500,
  neighborRadius: 1,
  vectorScanTimeoutMs: 8000,
  // The keyword branch loads and scans the metadata of every candidate item, so
  // on a large library it is routinely slower than the vector scan. The old
  // 10s hybrid-wide budget was measured against a much cheaper per-keyword
  // implementation and degraded constantly; 30s is the untuned starting point
  // and the scan test replaces it with a value measured on the real library.
  keywordSearchTimeoutMs: 30000,
};

export const HYBRID_SETTING_BOUNDS = {
  maxDocuments: { min: 1, max: 20 },
  maxChunksPerItem: { min: 1, max: 50 },
  keywordMinScore: { min: 0, max: 1 },
  semanticMinScore: { min: 0, max: 1 },
  keywordRrfWeight: { min: 0, max: 10 },
  semanticRrfWeight: { min: 0, max: 10 },
  chunkTargetChars: { min: 200, max: 4000 },
  chunkAppendToleranceChars: { min: 0, max: 2000 },
  neighborRadius: { min: 0, max: 10 },
  vectorScanTimeoutMs: { min: 1, max: 3600000 },
  keywordSearchTimeoutMs: { min: 1000, max: 3600000 },
} as const;

export const HYBRID_SETTING_PREF_KEYS = {
  gpuAccelerationEnabled: "hybrid.gpuAccelerationEnabled",
  gpuPrecision: "hybrid.gpuPrecision",
  maxDocuments: "hybrid.maxDocuments",
  maxChunksPerItem: "hybrid.maxChunksPerItem",
  keywordMinScore: "hybrid.keywordMinScore",
  semanticMinScore: "hybrid.semanticMinScore",
  keywordRrfWeight: "hybrid.keywordRrfWeight",
  semanticRrfWeight: "hybrid.semanticRrfWeight",
  chunkTargetChars: "hybrid.chunkTargetChars",
  chunkAppendToleranceChars: "hybrid.chunkAppendToleranceChars",
  neighborRadius: "hybrid.neighborRadius",
  // Deliberately still `searchTimeoutMs`: this pref has always meant the vector
  // scan, and renaming the stored key would reset every user who has already
  // tuned it (addon/prefs.js declares a default, so "unset" is indistinguishable
  // from "set to the default" and a migration could not tell them apart).
  vectorScanTimeoutMs: "hybrid.searchTimeoutMs",
  keywordSearchTimeoutMs: "hybrid.keywordSearchTimeoutMs",
} as const;

/**
 * The values the preference pane advertises as "推荐值 / Recommended".
 *
 * A hint, never a policy: nothing in retrieval reads this table, so a user who
 * types something else keeps what they typed. It exists so the pane, the tool
 * documentation and the calibration test all quote the SAME number, and so that
 * changing a recommendation is one edit rather than four.
 *
 * Where each number comes from:
 *
 * `keywordMinScore` — MEASURED, not chosen. `npm run calibrate:branch-thresholds`
 * scores 8 real queries against 931 real documents from this user's own library
 * with the production BM25F ranker, against relevance labels written by reading
 * each document's title and abstract, and sweeps the threshold. 0.52 is the F0.5
 * optimum (precision 0.935, recall 0.457). F0.5 rather than F1 because the union
 * gives recall a backstop — the semantic branch admits documents on its own —
 * and gives precision none. The corpus is metadata-only, which is the strict
 * case: body-text hits can only raise scores, so real recall is better than the
 * measured figure. `scripts/test-branch-thresholds.js` fails if this number ever
 * stops being the measured optimum.
 *
 * `semanticMinScore` — INHERITED from the behaviour this replaced. The old
 * single fused-score floor defaulted to 0.60, and for a document only the
 * semantic branch found, that fused score WAS the cosine similarity — so 0.60
 * has been the de-facto semantic-only floor all along, and keeping it is the
 * option that changes least. Confirmed against the live library: a real
 * directional-solidification query returned semantic-only matches at 0.6711 and
 * 0.6041, both genuinely on topic, both still admitted at 0.60.
 *
 * `keywordRrfWeight` / `semanticRrfWeight` — 1.0 / 1.0. No measurement supports
 * preferring either branch, so neither is preferred. These exist to let a user
 * who knows their own library lean one way, not to encode a guess.
 */
export const HYBRID_SETTING_RECOMMENDATIONS = {
  keywordMinScore: 0.52,
  semanticMinScore: 0.6,
  keywordRrfWeight: 1,
  semanticRrfWeight: 1,
} as const;

/**
 * The retired single fused-score threshold.
 *
 * Only the migration below reads it. It is deliberately NOT in
 * HYBRID_SETTING_PREF_KEYS: nothing in retrieval may consult it any more, and
 * leaving it out of that table is what makes that mechanical rather than a
 * promise.
 */
const LEGACY_MIN_SCORE_PREF = "hybrid.minScore";
const LEGACY_MIN_SCORE_DEFAULT = 0.6;
const THRESHOLD_SPLIT_MIGRATION_PREF = "hybrid.thresholdSplitMigrated";

/**
 * Carry a user's own fused-score threshold across to the semantic threshold.
 *
 * The old setting gated ONE number that both branches had to clear together.
 * Splitting it in two would otherwise silently discard whatever the user had
 * tuned, so the value moves to the semantic side — the side where it means the
 * same thing it always did, because a semantic-only document's old fused score
 * was exactly its cosine similarity. The keyword side starts from the measured
 * recommendation instead: the old number was never a BM25F threshold, and
 * reusing it there would be inventing a calibration rather than migrating one.
 *
 * Runs once, guarded by its own flag. A user who left the old threshold at its
 * 0.60 default has nothing to carry over and is left entirely alone.
 *
 * Returns what it did, so startup can log it and the test can assert it.
 */
export function migrateFusedScoreThreshold(): {
  migrated: boolean;
  reason:
    | "already-migrated"
    | "left-at-default"
    | "unreadable"
    | "carried-over";
  value?: number;
} {
  try {
    if (
      Zotero.Prefs.get(PREF_PREFIX + THRESHOLD_SPLIT_MIGRATION_PREF, true) ===
      true
    ) {
      return { migrated: false, reason: "already-migrated" };
    }
  } catch {
    return { migrated: false, reason: "unreadable" };
  }

  let legacy: unknown;
  try {
    legacy = Zotero.Prefs.get(PREF_PREFIX + LEGACY_MIN_SCORE_PREF, true);
  } catch {
    return { migrated: false, reason: "unreadable" };
  }

  const parsed = typeof legacy === "string" ? Number(legacy) : legacy;
  const customised =
    typeof parsed === "number" &&
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed <= 1 &&
    Math.abs(parsed - LEGACY_MIN_SCORE_DEFAULT) > 1e-9;

  try {
    if (customised) {
      Zotero.Prefs.set(
        PREF_PREFIX + HYBRID_SETTING_PREF_KEYS.semanticMinScore,
        String(parsed),
        true,
      );
    }
    Zotero.Prefs.set(PREF_PREFIX + THRESHOLD_SPLIT_MIGRATION_PREF, true, true);
  } catch {
    return { migrated: false, reason: "unreadable" };
  }

  return customised
    ? { migrated: true, reason: "carried-over", value: parsed as number }
    : { migrated: false, reason: "left-at-default" };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

type NumericHybridSetting = Exclude<
  keyof HybridSearchSettings,
  "gpuAccelerationEnabled" | "gpuPrecision"
>;

function readNumberPref(key: NumericHybridSetting, integer: boolean): number {
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
    gpuAccelerationEnabled: (() => {
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
    gpuPrecision: (() => {
      try {
        const value = String(
          Zotero.Prefs.get(
            PREF_PREFIX + HYBRID_SETTING_PREF_KEYS.gpuPrecision,
            true,
          ),
        );
        return value === "float32" || value === "int8" ? value : "auto";
      } catch {
        return HYBRID_SETTING_DEFAULTS.gpuPrecision;
      }
    })(),
    maxDocuments: readNumberPref("maxDocuments", true),
    maxChunksPerItem: readNumberPref("maxChunksPerItem", true),
    keywordMinScore: readNumberPref("keywordMinScore", false),
    semanticMinScore: readNumberPref("semanticMinScore", false),
    keywordRrfWeight: readNumberPref("keywordRrfWeight", false),
    semanticRrfWeight: readNumberPref("semanticRrfWeight", false),
    chunkTargetChars: readNumberPref("chunkTargetChars", true),
    chunkAppendToleranceChars: readNumberPref(
      "chunkAppendToleranceChars",
      true,
    ),
    neighborRadius: readNumberPref("neighborRadius", true),
    vectorScanTimeoutMs: readNumberPref("vectorScanTimeoutMs", true),
    keywordSearchTimeoutMs: readNumberPref("keywordSearchTimeoutMs", true),
  };
}

/** Persist an integer timeout, rounding benchmark recommendations upward. */
function setTimeoutPref(
  key: "vectorScanTimeoutMs" | "keywordSearchTimeoutMs",
  value: number,
): number {
  const bounds = HYBRID_SETTING_BOUNDS[key];
  const finite = Number.isFinite(value) ? value : HYBRID_SETTING_DEFAULTS[key];
  const stored = Math.ceil(clamp(finite, bounds.min, bounds.max));
  Zotero.Prefs.set(PREF_PREFIX + HYBRID_SETTING_PREF_KEYS[key], stored, true);
  return stored;
}

/** Persist the vector-scan timeout. */
export function setVectorScanTimeoutMs(value: number): number {
  return setTimeoutPref("vectorScanTimeoutMs", value);
}

/** Persist the keyword-search timeout. */
export function setKeywordSearchTimeoutMs(value: number): number {
  return setTimeoutPref("keywordSearchTimeoutMs", value);
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
  // v3: the references list is finally actually excluded (the v2 detector
  // required the heading alone on a line and so never matched the `## References`
  // that MinerU Markdown produces). Chunk boundaries therefore differ from v2,
  // which is what this string exists to announce — an index built under v2 stays
  // usable and simply gets the "consider rebuilding" notice, rather than being
  // rebuilt behind the user's back.
  //
  // v4: two changes move boundaries again. A Markdown heading now ends the open
  // chunk whatever its length, so no chunk straddles a section break; and the
  // front matter the item record already holds — title, abstract, authors,
  // affiliations, keywords, identifiers — is dropped from the body before
  // chunking instead of being embedded twice.
  return `paragraph-v4:${settings.chunkTargetChars}:${settings.chunkAppendToleranceChars}`;
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
      return {
        version: 1,
        legacyUntrusted: false,
        libraries: {},
        incompleteLibraries: {},
      };
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
                  Object.keys(parsed.incompleteLibraries).map((key) => [
                    key,
                    true,
                  ]),
                )
              : {},
        };
      }
    } catch {
      // The old format stored the signature itself instead of JSON.
    }
    return {
      version: 1,
      legacyUntrusted: true,
      libraries: {},
      incompleteLibraries: {},
    };
  } catch {
    return {
      version: 1,
      legacyUntrusted: false,
      libraries: {},
      incompleteLibraries: {},
    };
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
    Zotero.Prefs.set(INDEX_CHUNK_SIGNATURE_PREF, JSON.stringify(state), true);
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
    Zotero.Prefs.set(INDEX_CHUNK_SIGNATURE_PREF, JSON.stringify(state), true);
  } catch (error) {
    ztoolkit.log(
      `[HybridSettings] Failed to invalidate chunking signature: ${error}`,
      "warn",
    );
    throw error;
  }
}

export function hasIncompleteFullLibraryRebuild(libraryID: number): boolean {
  return (
    readStoredChunkingSignatures().incompleteLibraries?.[String(libraryID)] ===
    true
  );
}

export function clearStoredChunkingSignatures(): void {
  try {
    Zotero.Prefs.clear(INDEX_CHUNK_SIGNATURE_PREF, true);
    const remaining = Zotero.Prefs.get(INDEX_CHUNK_SIGNATURE_PREF, true);
    if (typeof remaining === "string" && remaining.trim()) {
      throw new Error("chunking signature preference still contains data");
    }
  } catch (error) {
    ztoolkit.log(
      `[HybridSettings] Failed to clear chunking signatures: ${error}`,
      "warn",
    );
    throw error;
  }
}

export function shouldShowChunkingWarning(params: {
  chunkCount: number;
  float32VectorCount: number;
  indexedItemCount: number;
  storedSignature: string | null;
  currentSignature: string;
  incomplete: boolean;
  legacyUntrusted: boolean;
}): boolean {
  if (
    params.chunkCount === 0 &&
    params.float32VectorCount === 0 &&
    params.indexedItemCount === 0
  ) {
    return false;
  }
  return (
    params.incomplete ||
    params.legacyUntrusted ||
    (Boolean(params.storedSignature) &&
      params.storedSignature !== params.currentSignature)
  );
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
