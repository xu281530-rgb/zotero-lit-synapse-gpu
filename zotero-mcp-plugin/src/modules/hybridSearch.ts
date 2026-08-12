export interface KeywordSearchItem extends Record<string, unknown> {
  key: string;
  libraryID?: number;
  title?: string;
  relevanceScore?: number;
  matchedFields?: string[];
  /** Which of the supplied keywords retrieved this item. */
  matchedKeywords?: string[];
}

export interface SemanticSearchItem {
  itemKey: string;
  libraryID?: number;
  title?: string;
  score?: number;
  matchedChunks?: Array<{
    chunkId: number;
    text: string;
    score: number;
  }>;
}

export interface HybridSearchOptions {
  query?: string;
  /**
   * Optional caller-supplied lexical keywords. Expected to already mix Chinese
   * and English surface forms so the lexical branch recalls literature written
   * in either language regardless of the language the user asked in.
   */
  keywords?: string[];
  topK: number;
  candidateK: number;
  rrfK: number;
  keywordWeight: number;
  semanticWeight: number;
  semanticTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface HybridSearchResult extends Record<string, unknown> {
  itemKey: string;
  libraryID?: number;
  rrfScore: number;
  keywordRank?: number;
  semanticRank?: number;
  keywordScore?: number;
  semanticScore?: number;
  matchedChunks?: SemanticSearchItem["matchedChunks"];
}

export interface HybridSearchRunResult {
  results: HybridSearchResult[];
  degraded: boolean;
  warnings: string[];
  keywordResultCount: number;
  semanticResultCount: number;
  timings: {
    keywordMs: number;
    semanticMs: number;
    rrfMs: number;
    totalMs: number;
  };
}

interface HybridSearchDependencies {
  keywordSearch: () => Promise<KeywordSearchItem[]>;
  semanticSearch: () => Promise<SemanticSearchItem[]>;
  /**
   * Called when a branch loses its race against the timeout. Racing a promise
   * only stops waiting for it — without these hooks the abandoned embedding
   * request and library scan keep running, so back-to-back queries pile up
   * background work that nobody is waiting for any more.
   */
  cancelKeywordSearch?: () => void;
  cancelSemanticSearch?: () => void;
}

interface FusedCandidate {
  itemKey: string;
  libraryID?: number;
  keywordItem?: KeywordSearchItem;
  semanticItem?: SemanticSearchItem;
  keywordRank?: number;
  semanticRank?: number;
  rrfScore: number;
}

export const DEFAULT_SEMANTIC_TIMEOUT_MS = 8000;
export const DEFAULT_HYBRID_TIMEOUT_MS = 10000;

/**
 * Upper bound on lexical probes issued per hybrid call — the only hard limit.
 *
 * The accepted range is 1..MAX_HYBRID_KEYWORDS. The "5-12 keywords" figure that
 * appears throughout the tool descriptions is a *recommendation* for retrieval
 * quality, never a validated constraint: a single keyword is a valid call and so
 * is a list of 16. Keep that distinction when editing any user-facing text.
 *
 * 中文：5～12 是「建议提供 5～12 个相关的中英文关键词以获得较好的检索效果」，
 * 但这不是强制要求；实际允许的输入范围是 1～16 个。
 */
export const MAX_HYBRID_KEYWORDS = 16;
/**
 * Upper bound on keywords accepted before normalisation rejects the input.
 *
 * Deliberately identical to {@link MAX_HYBRID_KEYWORDS}: the tool description
 * and the JSON schema both advertise a 16-keyword ceiling, so accepting 32 and
 * then silently discarding half of them was a lie to the caller — the dropped
 * probes were simply never searched and nothing said so.
 */
export const MAX_SUPPLIED_KEYWORDS = MAX_HYBRID_KEYWORDS;
/** Upper bound on keywords derived from the query when none were supplied. */
export const MAX_FALLBACK_KEYWORDS = MAX_HYBRID_KEYWORDS;
const MAX_KEYWORD_LENGTH = 120;
/**
 * Per-extra-keyword multiplier applied to an item's aggregated lexical score.
 * Matching several distinct keywords is a much better on-topic signal than
 * matching one common term very strongly.
 */
export const HYBRID_KEYWORD_COVERAGE_BONUS = 0.2;

/**
 * Function words that carry no retrieval signal. Both scripts are listed on
 * purpose: the lexical branch is always bilingual, so the noise filter has to
 * be bilingual too.
 */
const FALLBACK_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "how",
  "what",
  "why",
  "does",
  "did",
  "are",
  "was",
  "were",
  "from",
  "into",
  "onto",
  "that",
  "this",
  "these",
  "those",
  "about",
  "during",
  "between",
  "over",
  "under",
  "its",
  "their",
  "can",
  "will",
  "would",
  "should",
]);

/**
 * Han characters that only glue a sentence together. A bigram containing one of
 * them is dropped, which keeps the fallback probes close to real terminology.
 *
 * Deliberately narrow. A dropped bigram is lost recall, while a surviving
 * nonsense bigram merely spends one probe that matches nothing, so characters
 * that occur inside real technical compounds stay off this list — 能 (能量),
 * 对 (对流), 不 (不锈钢), 向 (定向), 过 (过冷), 中 (中间相), 时 (时效),
 * 因 (因子) and similar must not be treated as stop characters.
 */
const HAN_STOP_CHARS = new Set(
  Array.from(
    "的了是与及把被其该这那也都或吗呢且但而让所之很更最如何什么怎于我你他她它们请吧呀啊哪谁",
  ),
);

const HAN_PATTERN = /\p{Script=Han}/u;

function containsHan(value: string): boolean {
  return HAN_PATTERN.test(value);
}

/**
 * Normalise caller-supplied keywords: trim, drop blanks, case-insensitively
 * deduplicate while keeping the first spelling, and cap the probe count.
 *
 * The list is never filtered by script. A Chinese question is expected to carry
 * English keywords and vice versa, and dropping either half would silently
 * restrict recall to one language.
 */
export function normalizeKeywords(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("keywords must be an array of strings");
  }
  if (raw.length > MAX_SUPPLIED_KEYWORDS) {
    throw new Error(
      `keywords must contain at most ${MAX_SUPPLIED_KEYWORDS} entries`,
    );
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new Error("keywords must be an array of strings");
    }
    const keyword = entry.trim();
    if (!keyword) continue;
    if (keyword.length > MAX_KEYWORD_LENGTH) {
      throw new Error(
        `each keyword must be at most ${MAX_KEYWORD_LENGTH} characters`,
      );
    }
    const identity = keyword.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push(keyword);
  }

  // Deduplication can only shrink the list, and the length check above already
  // rejects anything longer, so this slice is a defensive no-op.
  return normalized.slice(0, MAX_HYBRID_KEYWORDS);
}

/**
 * Weight assigned to a caller-supplied keyword. The calling AI picked the term
 * on purpose, so it is trusted at full strength.
 */
export const PROVIDED_KEYWORD_WEIGHT = 1;
/**
 * Weight for a whole token or Han segment recovered from the query itself.
 * Slightly below a curated keyword because nothing vetted it.
 */
export const FALLBACK_TOKEN_WEIGHT = 0.9;
/**
 * Weight for a dictionary-free Han bigram taken at an even offset, i.e. the
 * segmentation you get when the segment really is a run of two-character
 * terms — the common case in Chinese technical writing.
 */
export const FALLBACK_NGRAM_WEIGHT = 0.3;
/**
 * Weight for an odd-offset bigram. These straddle two neighbouring terms and
 * are what produces junk such as 度梯 / 响定 / 向凝, so they are kept only as
 * a last-resort recall net and must never outvote a genuine keyword.
 */
export const FALLBACK_OFFSET_NGRAM_WEIGHT = 0.15;
/** Cap on Han bigrams emitted per fallback query. */
const MAX_FALLBACK_NGRAMS = 8;

export type LexicalKeywordOrigin = "provided" | "token" | "ngram";

/** A lexical probe plus how much the ranking is allowed to trust it. */
export interface LexicalKeyword {
  text: string;
  weight: number;
  origin: LexicalKeywordOrigin;
}

/**
 * Split a Han run on the function characters that glue a sentence together.
 * "温度梯度如何影响定向凝固" -> ["温度梯度", "影响定向凝固"], which keeps whole
 * terms intact instead of forcing every term through bigram guesswork.
 */
function splitHanRun(run: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (const char of run) {
    if (HAN_STOP_CHARS.has(char)) {
      if (current) segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * Derive weighted lexical probes from the raw query when the caller supplied
 * none.
 *
 * Whitespace tokenisation alone is useless for Chinese: a Han sentence has no
 * spaces, so `[\p{L}\p{N}]+` yields one long run that matches no title. Han
 * runs are therefore split on function characters and, when a segment is still
 * too long to be a term, approximated with sliding bigrams — at a much lower
 * weight, because that step is pure guesswork.
 *
 * This is a degraded path. It can only probe the language the user typed in, so
 * callers are expected to pass bilingual `keywords` instead.
 */
export function buildFallbackKeywordEntries(query: string): LexicalKeyword[] {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const primary: string[] = [];
  const alignedBigrams: string[] = [];
  const offsetBigrams: string[] = [];

  for (const token of tokens) {
    if (containsHan(token)) {
      for (const segment of splitHanRun(token)) {
        // Short segments are already term-sized; keep them verbatim.
        if (segment.length <= 6) primary.push(segment);
        if (segment.length >= 4) {
          for (let index = 0; index + 2 <= segment.length; index += 1) {
            // Even offsets reconstruct two-character terms (温度 | 梯度);
            // odd offsets straddle term boundaries (度梯) and are demoted.
            const bigram = segment.slice(index, index + 2);
            if (index % 2 === 0) alignedBigrams.push(bigram);
            else offsetBigrams.push(bigram);
          }
        }
      }
      continue;
    }
    if (token.length <= 1) continue;
    if (FALLBACK_STOPWORDS.has(token)) continue;
    primary.push(token);
  }

  const seen = new Set<string>();
  const keywords: LexicalKeyword[] = [];
  const push = (text: string, weight: number, origin: LexicalKeywordOrigin) => {
    if (seen.has(text)) return;
    if (keywords.length >= MAX_FALLBACK_KEYWORDS) return;
    seen.add(text);
    keywords.push({ text, weight, origin });
  };

  for (const candidate of primary) {
    push(candidate, FALLBACK_TOKEN_WEIGHT, "token");
  }
  let ngramCount = 0;
  const pushNgram = (candidate: string, weight: number) => {
    if (ngramCount >= MAX_FALLBACK_NGRAMS) return;
    const before = keywords.length;
    push(candidate, weight, "ngram");
    if (keywords.length > before) ngramCount += 1;
  };
  for (const candidate of alignedBigrams) {
    pushNgram(candidate, FALLBACK_NGRAM_WEIGHT);
  }
  for (const candidate of offsetBigrams) {
    pushNgram(candidate, FALLBACK_OFFSET_NGRAM_WEIGHT);
  }

  if (keywords.length === 0) {
    return [
      { text: query.trim(), weight: FALLBACK_TOKEN_WEIGHT, origin: "token" },
    ];
  }
  return keywords;
}

/** Backwards-compatible view of {@link buildFallbackKeywordEntries}. */
export function buildFallbackKeywords(query: string): string[] {
  return buildFallbackKeywordEntries(query).map((entry) => entry.text);
}

/**
 * Resolve the lexical probe list for one hybrid call, reporting whether the
 * caller supplied it or it had to be derived from the query.
 *
 * `entries` carries the per-probe trust weight the ranking uses; `keywords`
 * stays a plain string list so existing callers and diagnostics are unchanged.
 */
export function resolveHybridKeywords(
  query: string,
  keywords?: unknown,
): {
  keywords: string[];
  entries: LexicalKeyword[];
  source: "provided" | "fallback";
} {
  const supplied = normalizeKeywords(keywords);
  if (supplied.length > 0) {
    return {
      keywords: supplied,
      entries: supplied.map((text) => ({
        text,
        weight: PROVIDED_KEYWORD_WEIGHT,
        origin: "provided" as const,
      })),
      source: "provided",
    };
  }
  const entries = buildFallbackKeywordEntries(query);
  return {
    keywords: entries.map((entry) => entry.text),
    entries,
    source: "fallback",
  };
}

/**
 * Field weights for the single-pass lexical ranking. They mirror the weights
 * search_library uses for `relevanceScoring` so both entry points agree on what
 * a title hit is worth relative to an abstract or tag hit.
 */
export const LEXICAL_FIELD_WEIGHTS: Record<string, number> = {
  title: 3,
  abstractNote: 1.6,
  publicationTitle: 1.2,
  creator: 1.2,
  tags: 1.1,
  extra: 0.4,
};

/** Per-extra-field multiplier: a term in several fields is a stronger hit. */
export const LEXICAL_FIELD_DIVERSITY_BONUS = 0.08;
/** Strength of a keyword that only occurs inside a longer Latin word. */
const LEXICAL_PARTIAL_WORD_STRENGTH = 0.45;
/** Multiplier for a field whose whole value is exactly the keyword. */
const LEXICAL_EXACT_FIELD_BONUS = 1.25;
/** Occurrences beyond this stop adding to a field's strength. */
const LEXICAL_MAX_OCCURRENCES = 4;

/** One candidate document handed to the lexical ranker. */
export interface LexicalCandidate {
  key: string;
  libraryID: number;
  title?: string;
  /** Raw field text keyed by the names in {@link LEXICAL_FIELD_WEIGHTS}. */
  fields: Record<string, string>;
  /** Extra metadata copied verbatim onto the ranked result. */
  metadata?: Record<string, unknown>;
}

export interface LexicalRankingOptions {
  candidateK: number;
  fieldWeights?: Record<string, number>;
}

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

/**
 * How strongly `keyword` occurs in `haystack`, both already lowercased.
 *
 * Latin keywords must hit a word boundary to score full strength: "cet" inside
 * "faucet" is noise, while "CET" as a word is the term being looked for. Han
 * has no word boundaries, so a substring hit is the real signal there.
 */
function fieldMatchStrength(haystack: string, keyword: string): number {
  if (!haystack || !keyword) return 0;

  const requiresBoundary = !containsHan(keyword);
  let occurrences = 0;
  let boundaryHit = false;
  let index = haystack.indexOf(keyword);
  while (index !== -1 && occurrences < LEXICAL_MAX_OCCURRENCES) {
    occurrences += 1;
    if (requiresBoundary) {
      const before = haystack[index - 1];
      const after = haystack[index + keyword.length];
      if (!isWordCharacter(before) && !isWordCharacter(after)) {
        boundaryHit = true;
      }
    }
    index = haystack.indexOf(keyword, index + keyword.length);
  }

  if (occurrences === 0) return 0;

  let strength =
    !requiresBoundary || boundaryHit ? 1 : LEXICAL_PARTIAL_WORD_STRENGTH;
  // Saturating repeat bonus: a term repeated in an abstract matters, but not
  // linearly, or one verbose record would dominate the ranking.
  strength *= 1 + 0.25 * Math.log(occurrences);
  if (haystack === keyword) strength *= LEXICAL_EXACT_FIELD_BONUS;
  return strength;
}

/**
 * Rank candidates against every keyword in one pass.
 *
 * Scoring deliberately avoids "normalise each keyword's best hit to 1", which
 * makes a broad word such as `growth` as decisive as a discriminative phrase
 * such as `columnar-to-equiaxed transition`. Instead each keyword is weighted
 * by three stable signals:
 *
 * - **specificity** — an inverse document frequency over the candidate pool, so
 *   a term matching almost everything contributes almost nothing;
 * - **field** — where the hit landed, using {@link LEXICAL_FIELD_WEIGHTS};
 * - **coverage** — how many distinct keywords and fields the item matched.
 */
export function rankLexicalCandidates(
  candidates: LexicalCandidate[],
  keywords: LexicalKeyword[],
  options: LexicalRankingOptions,
): KeywordSearchItem[] {
  validateFiniteNumber(options.candidateK, "candidateK", 1);
  if (candidates.length === 0 || keywords.length === 0) return [];

  const fieldWeights = options.fieldWeights ?? LEXICAL_FIELD_WEIGHTS;
  const probes = keywords.map((keyword) => ({
    ...keyword,
    needle: keyword.text.toLowerCase(),
  }));

  interface Accumulator {
    candidate: LexicalCandidate;
    perKeyword: number[];
    matchedKeywords: string[];
    matchedFields: Set<string>;
  }

  const documentFrequency = new Array<number>(probes.length).fill(0);
  const accumulators: Accumulator[] = [];

  for (const candidate of candidates) {
    const lowered = new Map<string, string>();
    for (const [field, value] of Object.entries(candidate.fields)) {
      if (value) lowered.set(field, value.toLowerCase());
    }

    const perKeyword = new Array<number>(probes.length).fill(0);
    const matchedKeywords: string[] = [];
    const matchedFields = new Set<string>();
    let matchedAny = false;

    probes.forEach((probe, probeIndex) => {
      let keywordScore = 0;
      for (const [field, value] of lowered) {
        const weight = fieldWeights[field];
        if (!weight) continue;
        const strength = fieldMatchStrength(value, probe.needle);
        if (strength <= 0) continue;
        keywordScore += weight * strength;
        matchedFields.add(field);
      }
      if (keywordScore <= 0) return;
      perKeyword[probeIndex] = keywordScore;
      matchedKeywords.push(probe.text);
      documentFrequency[probeIndex] += 1;
      matchedAny = true;
    });

    if (!matchedAny) continue;
    accumulators.push({
      candidate,
      perKeyword,
      matchedKeywords,
      matchedFields,
    });
  }

  if (accumulators.length === 0) return [];

  // Inverse document frequency over the retrieved pool, normalised to (0, 1]
  // so the absolute score stays comparable between queries.
  const poolSize = accumulators.length;
  const idfCeiling = Math.log(1 + poolSize) || 1;
  const specificity = documentFrequency.map((frequency) =>
    frequency === 0
      ? 0
      : Math.min(1, Math.log(1 + poolSize / (1 + frequency)) / idfCeiling),
  );

  const ranked = accumulators.map((entry) => {
    let base = 0;
    for (let index = 0; index < probes.length; index += 1) {
      const contribution = entry.perKeyword[index];
      if (contribution <= 0) continue;
      base += probes[index].weight * specificity[index] * contribution;
    }
    const coverageFactor =
      1 + HYBRID_KEYWORD_COVERAGE_BONUS * (entry.matchedKeywords.length - 1);
    const fieldFactor =
      1 + LEXICAL_FIELD_DIVERSITY_BONUS * (entry.matchedFields.size - 1);
    return {
      ...(entry.candidate.metadata ?? {}),
      key: entry.candidate.key,
      libraryID: entry.candidate.libraryID,
      title: entry.candidate.title ?? "",
      relevanceScore: base * coverageFactor * fieldFactor,
      matchedFields: Array.from(entry.matchedFields),
      matchedKeywords: entry.matchedKeywords,
      keywordCoverage: entry.matchedKeywords.length / probes.length,
    } as KeywordSearchItem;
  });

  return ranked
    .sort((a, b) => {
      const scoreDifference = (b.relevanceScore || 0) - (a.relevanceScore || 0);
      if (scoreDifference !== 0) return scoreDifference;
      const coverageDifference =
        (b.matchedKeywords?.length || 0) - (a.matchedKeywords?.length || 0);
      if (coverageDifference !== 0) return coverageDifference;
      return a.key.localeCompare(b.key);
    })
    .slice(0, options.candidateK);
}

function validateFiniteNumber(
  value: number,
  name: string,
  minimum: number,
): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(
      `${name} must be a finite number greater than or equal to ${minimum}`,
    );
  }
}

export function validateHybridSearchOptions(
  options: HybridSearchOptions,
): void {
  if (!options.query?.trim()) {
    throw new Error("query must not be blank");
  }
  validateFiniteNumber(options.topK, "topK", 1);
  validateFiniteNumber(options.candidateK, "candidateK", options.topK);
  validateFiniteNumber(options.rrfK, "rrfK", 1);
  validateFiniteNumber(options.keywordWeight, "keywordWeight", 0);
  validateFiniteNumber(options.semanticWeight, "semanticWeight", 0);
  if (!Number.isInteger(options.topK) || options.topK > 100) {
    throw new Error("topK must be an integer between 1 and 100");
  }
  if (!Number.isInteger(options.candidateK) || options.candidateK > 500) {
    throw new Error("candidateK must be an integer between topK and 500");
  }
  if (options.semanticTimeoutMs !== undefined) {
    validateFiniteNumber(options.semanticTimeoutMs, "semanticTimeoutMs", 1);
  }
  if (options.totalTimeoutMs !== undefined) {
    validateFiniteNumber(options.totalTimeoutMs, "totalTimeoutMs", 1);
  }
  if (options.keywords !== undefined) {
    normalizeKeywords(options.keywords);
  }

  if (options.keywordWeight === 0 && options.semanticWeight === 0) {
    throw new Error("keywordWeight and semanticWeight cannot both be zero");
  }
}

export function fuseHybridSearchResults(
  keywordResults: KeywordSearchItem[],
  semanticResults: SemanticSearchItem[],
  options: Pick<
    HybridSearchOptions,
    "topK" | "rrfK" | "keywordWeight" | "semanticWeight"
  >,
): HybridSearchResult[] {
  validateFiniteNumber(options.topK, "topK", 1);
  validateFiniteNumber(options.rrfK, "rrfK", 1);
  validateFiniteNumber(options.keywordWeight, "keywordWeight", 0);
  validateFiniteNumber(options.semanticWeight, "semanticWeight", 0);

  const candidates = new Map<string, FusedCandidate>();

  if (options.keywordWeight > 0) {
    keywordResults.forEach((item, index) => {
      const candidateKey = `${item.libraryID ?? "unknown"}:${item.key}`;
      if (!item.key || candidates.get(candidateKey)?.keywordItem) return;
      const rank = index + 1;
      const existing = candidates.get(candidateKey) || {
        itemKey: item.key,
        libraryID: item.libraryID,
        rrfScore: 0,
      };
      existing.keywordItem = item;
      existing.keywordRank = rank;
      existing.rrfScore += options.keywordWeight / (options.rrfK + rank);
      candidates.set(candidateKey, existing);
    });
  }

  if (options.semanticWeight > 0) {
    semanticResults.forEach((item, index) => {
      const candidateKey = `${item.libraryID ?? "unknown"}:${item.itemKey}`;
      if (!item.itemKey || candidates.get(candidateKey)?.semanticItem) return;
      const rank = index + 1;
      const existing = candidates.get(candidateKey) || {
        itemKey: item.itemKey,
        libraryID: item.libraryID,
        rrfScore: 0,
      };
      existing.semanticItem = item;
      existing.semanticRank = rank;
      existing.rrfScore += options.semanticWeight / (options.rrfK + rank);
      candidates.set(candidateKey, existing);
    });
  }

  return Array.from(candidates.values())
    .sort((a, b) => {
      const scoreDifference = b.rrfScore - a.rrfScore;
      if (scoreDifference !== 0) return scoreDifference;

      const aSourceCount =
        Number(Boolean(a.keywordItem)) + Number(Boolean(a.semanticItem));
      const bSourceCount =
        Number(Boolean(b.keywordItem)) + Number(Boolean(b.semanticItem));
      if (aSourceCount !== bSourceCount) return bSourceCount - aSourceCount;

      const aBestRank = Math.min(
        a.keywordRank ?? Infinity,
        a.semanticRank ?? Infinity,
      );
      const bBestRank = Math.min(
        b.keywordRank ?? Infinity,
        b.semanticRank ?? Infinity,
      );
      if (aBestRank !== bBestRank) return aBestRank - bBestRank;

      return a.itemKey.localeCompare(b.itemKey);
    })
    .slice(0, options.topK)
    .map((candidate) => {
      const keywordItem = candidate.keywordItem;
      const semanticItem = candidate.semanticItem;
      const base = keywordItem
        ? { ...keywordItem }
        : semanticItem
          ? { ...semanticItem }
          : {};

      delete (base as Record<string, unknown>).key;
      delete (base as Record<string, unknown>).score;

      return {
        ...base,
        itemKey: candidate.itemKey,
        libraryID: candidate.libraryID,
        title: keywordItem?.title || semanticItem?.title || "",
        rrfScore: candidate.rrfScore,
        keywordRank: candidate.keywordRank,
        semanticRank: candidate.semanticRank,
        keywordScore: keywordItem?.relevanceScore,
        semanticScore: semanticItem?.score,
        matchedChunks: semanticItem?.matchedChunks,
      };
    });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Cancel first, then reject: the caller stops waiting either way, so
          // this is the only chance to stop the work itself.
          try {
            onTimeout?.();
          } catch {
            // A failing canceller must not mask the timeout error.
          }
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<{ outcome: PromiseSettledResult<T>; elapsedMs: number }> {
  const startedAt = Date.now();
  try {
    const value = await runWithTimeout(operation, timeoutMs, label, onTimeout);
    return {
      outcome: { status: "fulfilled", value },
      elapsedMs: Date.now() - startedAt,
    };
  } catch (reason) {
    return {
      outcome: { status: "rejected", reason },
      elapsedMs: Date.now() - startedAt,
    };
  }
}

export async function runHybridSearch(
  options: HybridSearchOptions & { query: string },
  dependencies: HybridSearchDependencies,
): Promise<HybridSearchRunResult> {
  validateHybridSearchOptions(options);
  const startedAt = Date.now();
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_HYBRID_TIMEOUT_MS;
  const semanticTimeoutMs = Math.min(
    options.semanticTimeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS,
    totalTimeoutMs,
  );
  const [keywordRun, semanticRun] = await Promise.all([
    options.keywordWeight > 0
      ? settleWithTimeout(
          dependencies.keywordSearch,
          totalTimeoutMs,
          "Keyword search",
          dependencies.cancelKeywordSearch,
        )
      : Promise.resolve({
          outcome: {
            status: "fulfilled",
            value: [],
          } as PromiseFulfilledResult<KeywordSearchItem[]>,
          elapsedMs: 0,
        }),
    options.semanticWeight > 0
      ? settleWithTimeout(
          dependencies.semanticSearch,
          semanticTimeoutMs,
          "Semantic search",
          dependencies.cancelSemanticSearch,
        )
      : Promise.resolve({
          outcome: {
            status: "fulfilled",
            value: [],
          } as PromiseFulfilledResult<SemanticSearchItem[]>,
          elapsedMs: 0,
        }),
  ]);
  const keywordOutcome = keywordRun.outcome;
  const semanticOutcome = semanticRun.outcome;

  if (
    keywordOutcome.status === "rejected" &&
    semanticOutcome.status === "rejected"
  ) {
    throw new Error(
      `Hybrid search failed: keyword search: ${errorMessage(keywordOutcome.reason)}; semantic search: ${errorMessage(semanticOutcome.reason)}`,
    );
  }

  const warnings: string[] = [];
  const keywordResults =
    keywordOutcome.status === "fulfilled" ? keywordOutcome.value : [];
  const semanticResults =
    semanticOutcome.status === "fulfilled" ? semanticOutcome.value : [];

  if (keywordOutcome.status === "rejected") {
    warnings.push(
      `Keyword metadata search unavailable: ${errorMessage(keywordOutcome.reason)}`,
    );
  }
  if (semanticOutcome.status === "rejected") {
    warnings.push(
      `Semantic search unavailable: ${errorMessage(semanticOutcome.reason)}`,
    );
  }

  const rrfStartedAt = Date.now();
  const results = fuseHybridSearchResults(
    keywordResults,
    semanticResults,
    options,
  );
  const rrfMs = Date.now() - rrfStartedAt;

  return {
    results,
    degraded: warnings.length > 0,
    warnings,
    keywordResultCount: keywordResults.length,
    semanticResultCount: semanticResults.length,
    timings: {
      keywordMs: keywordRun.elapsedMs,
      semanticMs: semanticRun.elapsedMs,
      rrfMs,
      totalMs: Date.now() - startedAt,
    },
  };
}
