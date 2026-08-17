import {
  DIMENSION_MISMATCH_HINT,
  isVectorDimensionMismatchError,
} from "./semantic/dimensionMismatch";
import { isKeywordSearchUnavailableError } from "./keywordSearchGate";

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
   * Fused-score floor in 0..1. Candidates below it are discarded outright and
   * are never padded back in to reach topK — topK is a ceiling, not a quota.
   */
  minScore?: number;
  /**
   * Optional caller-supplied lexical keywords. Expected to already mix Chinese
   * and English surface forms so the lexical branch recalls literature written
   * in either language regardless of the language the user asked in.
   */
  keywords?: string[];
  topK: number;
  rrfK: number;
  keywordWeight: number;
  semanticWeight: number;
  // NOTE: there is deliberately no `exhaustive` option here. Fusion is already
  // exhaustive — `ranked` holds every scored candidate and `results` is just the
  // topK window onto it — so the flag had no effect at this layer except the one
  // it should never have had: it used to replace both branch deadlines with an
  // unbounded await. Exhaustiveness is a property of the semantic scan
  // (SemanticSearchOptions.exhaustive), never of a timeout.
  /**
   * Deadline for the keyword (metadata) branch. Defaults to
   * DEFAULT_KEYWORD_SEARCH_TIMEOUT_MS; production callers pass the user's
   * setting. The semantic branch is bounded inside the semantic service by the
   * vector-scan and embedding deadlines, not here.
   */
  keywordSearchTimeoutMs?: number;
  /**
   * Backstop deadline for the semantic branch as seen from the fusion layer.
   *
   * The real bound lives inside the semantic service (embedding timeout +
   * vector-scan timeout); this only guarantees that fusion cannot be left
   * waiting forever if a dependency never settles. Callers pass the sum of the
   * budgets they gave the service.
   */
  semanticBranchTimeoutMs?: number;
}

export interface HybridSearchResult extends Record<string, unknown> {
  itemKey: string;
  libraryID?: number;
  /**
   * The unified fused relevance, normalised to 0..1. This is the value the
   * threshold is applied to and the value results are ranked by.
   */
  score: number;
  /** Normalised (0..1) view of the lexical branch's own score. */
  normalizedKeywordScore?: number;
  /** Normalised (0..1) view of the semantic branch's own score. */
  normalizedSemanticScore?: number;
  /** Rank-consensus score, kept as a tie-break and for diagnostics. */
  rrfScore: number;
  keywordRank?: number;
  semanticRank?: number;
  keywordScore?: number;
  semanticScore?: number;
  matchedChunks?: SemanticSearchItem["matchedChunks"];
}

export interface HybridSearchRunResult {
  /** The first `topK` of {@link ranked}. */
  results: HybridSearchResult[];
  /**
   * Every candidate above the relevance threshold, in final order.
   * Pagination windows this list; it never re-ranks and never re-thresholds.
   */
  ranked: HybridSearchResult[];
  degraded: boolean;
  /**
   * The semantic branch could not run because the stored vectors and the
   * current embedding model disagree on dimensionality.
   *
   * Broken out as its own flag rather than left inside the warning prose,
   * because it is the one degradation a caller can act on mechanically: every
   * semantic result is missing and will stay missing until the index is
   * rebuilt. Without it, `hybrid_search` returned a keyword-only ranking that
   * was indistinguishable from a healthy hybrid run.
   */
  semanticIndexIncompatible: boolean;
  /**
   * The keyword branch was refused because Zotero's database stopped
   * answering an earlier query and the gate is waiting before it risks
   * creating another uncancellable one.
   *
   * Distinct from a plain keyword timeout: retrying immediately cannot help,
   * and — unlike a timeout — the semantic half of this search is completely
   * healthy. The rows below are semantic-only, and that is a temporary,
   * self-healing state rather than a fact about the library.
   */
  keywordSearchUnavailable: boolean;
  warnings: string[];
  keywordResultCount: number;
  semanticResultCount: number;
  /** Fused candidates dropped for scoring below the threshold. */
  discardedBelowThreshold: number;
  /** The floor actually applied (after the user's setting was enforced). */
  appliedMinScore: number;
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

/**
 * Fallback keyword-branch deadline for callers that pass no explicit budget.
 *
 * Production callers read the user's `keywordSearchTimeoutMs` setting instead;
 * this only keeps direct/test callers of runHybridSearch bounded. It matches
 * HYBRID_SETTING_DEFAULTS.keywordSearchTimeoutMs.
 */
export const DEFAULT_KEYWORD_SEARCH_TIMEOUT_MS = 30000;

/**
 * Fallback backstop for the semantic branch as seen from the fusion layer.
 *
 * The semantic branch's real budget is embedding timeout + vector-scan timeout,
 * enforced inside the semantic service. This is only the "the dependency never
 * settled at all" backstop, so it is deliberately looser than either.
 */
export const DEFAULT_SEMANTIC_BRANCH_TIMEOUT_MS = 60000;

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
  /** Optional result cap used only by bounded single-document searches. */
  limit?: number;
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
  if (options.limit !== undefined) {
    validateFiniteNumber(options.limit, "limit", 1);
  }
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

  const ordered = ranked.sort((a, b) => {
      const scoreDifference = (b.relevanceScore || 0) - (a.relevanceScore || 0);
      if (scoreDifference !== 0) return scoreDifference;
      const coverageDifference =
        (b.matchedKeywords?.length || 0) - (a.matchedKeywords?.length || 0);
      if (coverageDifference !== 0) return coverageDifference;
      return a.key.localeCompare(b.key);
    });
  return options.limit === undefined
    ? ordered
    : ordered.slice(0, options.limit);
}

/**
 * Field weight for ranking the chunks of ONE document, used by the
 * document-level deep dive. Deliberately a separate table from
 * {@link LEXICAL_FIELD_WEIGHTS} — a chunk has one field, not six — but it feeds
 * the exact same {@link rankLexicalCandidates} ranker, so specificity, coverage
 * and repeat saturation behave identically at both levels.
 *
 * Higher than the title weight for two reasons. A term of art appearing in a
 * passage of running text is a stronger signal than the same term in a title,
 * because the passage is where the claim actually lives; and the ranker's
 * inverse document frequency is computed over the candidate pool, which inside
 * one paper is a handful of chunks rather than a whole library, so specificity
 * is compressed towards the middle of its range.
 *
 * Calibrated so that a passage matching the full keyword set clears the default
 * 0.60 threshold on the lexical branch alone — that is what keeps the deep dive
 * useful when the semantic branch is unavailable — while a passage that only
 * repeats one common term of the set does not.
 */
export const CHUNK_FIELD_WEIGHTS: Record<string, number> = {
  chunkText: 6,
};

/**
 * Saturation constant for mapping the unbounded lexical score into 0..1.
 *
 * `raw / (raw + K)`: monotone, never reaches 1, and needs no knowledge of the
 * other candidates — which is the whole point. A relative "best hit = 1.0"
 * normalisation would make some document score 1.0 for every query, including
 * queries the library has nothing on, and the threshold could then never
 * discard everything.
 *
 * Calibration at K=4: one exact keyword in a title scores ≈3.75 → 0.48; two
 * distinct keywords in a title ≈7.2 → 0.64; a dense multi-field match ≈12 → 0.75.
 */
export const LEXICAL_SCORE_SATURATION = 4;

/** Bonus applied when both branches independently retrieved the candidate. */
export const HYBRID_AGREEMENT_BONUS = 0.15;

export function normalizeLexicalScore(rawScore: number | undefined): number {
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) return 0;
  if (rawScore <= 0) return 0;
  return rawScore / (rawScore + LEXICAL_SCORE_SATURATION);
}

/** Cosine similarity is already 0..1 in practice; clamp defensively. */
export function normalizeSemanticScore(rawScore: number | undefined): number {
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) return 0;
  if (rawScore <= 0) return 0;
  return rawScore > 1 ? 1 : rawScore;
}

/**
 * Combine the two normalised branch scores into the single 0..1 relevance the
 * threshold is applied to.
 *
 * The rule is that evidence may never cost a document its score. A candidate
 * found by one branch keeps that branch's strength, and a candidate both
 * branches found scores the STRONGER branch plus a bounded share of the weaker
 * one — so agreement lifts a document and never dilutes it.
 *
 * The previous formula averaged the two branches, which inverted that: a paper
 * the semantic index scored 0.75 passed a 0.60 threshold on its own, and the
 * same paper with one incidental keyword hit (0.10) averaged down to 0.49 and
 * was filtered out. Finding MORE evidence for a document deleted it — measured
 * on the real library, one broad keyword removed a 0.7153-scoring paper from
 * the result set entirely. Weaker-than-perfect agreement was penalised: a
 * keyword score below ~0.55 always dragged a 0.75 semantic match down.
 *
 * Equal agreement is scored exactly as before (0.75 + 0.15*0.75 == 0.75*1.15),
 * so this removes the dilution without inflating the agreement bonus.
 *
 * Weights scale each branch's contribution relative to the strongest weight, so
 * the default 1/1 leaves both branches at full strength, and lowering one
 * weight demotes that branch instead of reweighting an average.
 */
export function computeFusedScore(params: {
  normalizedKeywordScore?: number;
  normalizedSemanticScore?: number;
  keywordWeight: number;
  semanticWeight: number;
}): number {
  const keywordActive =
    params.normalizedKeywordScore !== undefined && params.keywordWeight > 0;
  const semanticActive =
    params.normalizedSemanticScore !== undefined && params.semanticWeight > 0;

  if (!keywordActive && !semanticActive) return 0;

  const maxWeight = Math.max(
    keywordActive ? params.keywordWeight : 0,
    semanticActive ? params.semanticWeight : 0,
  );
  if (maxWeight <= 0) return 0;

  const keywordContribution = keywordActive
    ? (params.normalizedKeywordScore ?? 0) * (params.keywordWeight / maxWeight)
    : undefined;
  const semanticContribution = semanticActive
    ? (params.normalizedSemanticScore ?? 0) * (params.semanticWeight / maxWeight)
    : undefined;

  if (keywordContribution === undefined) {
    return Math.min(1, Math.max(0, semanticContribution ?? 0));
  }
  if (semanticContribution === undefined) {
    return Math.min(1, Math.max(0, keywordContribution));
  }

  const dominant = Math.max(keywordContribution, semanticContribution);
  const support = Math.min(keywordContribution, semanticContribution);
  return Math.min(1, Math.max(0, dominant + HYBRID_AGREEMENT_BONUS * support));
}

/**
 * Whether the calling AI can be *confirmed* to have done the domain-expert
 * query rewrite, which is the only thing that earns the `ai` label.
 *
 * The plugin never calls an LLM, so it cannot inspect the reasoning; it can
 * only check that the caller did the two observable things the protocol asks
 * for — supply its own probes AND state the field and expert role it adopted.
 * Anything less is reported as `fallback`, because an unverified claim of
 * expertise is exactly what this flag exists to distinguish.
 */
export interface KeywordProvenance {
  keywordSource: "ai" | "fallback";
  /** Whether the probes themselves came from the caller or from tokenisation. */
  probeOrigin: "provided" | "derived";
  /** Present whenever keywordSource is "fallback". */
  reason: string | null;
  domain: string | null;
  expertRole: string | null;
}

const MAX_DECLARATION_LENGTH = 200;

function normalizeDeclaration(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_DECLARATION_LENGTH
    ? trimmed.slice(0, MAX_DECLARATION_LENGTH)
    : trimmed;
}

export function resolveKeywordProvenance(params: {
  probeSource: "provided" | "fallback";
  keywordsArgumentPresent: boolean;
  domain?: unknown;
  expertRole?: unknown;
}): KeywordProvenance {
  const domain = normalizeDeclaration(params.domain);
  const expertRole = normalizeDeclaration(params.expertRole);
  const probeOrigin =
    params.probeSource === "provided" ? "provided" : "derived";

  if (probeOrigin === "derived") {
    return {
      keywordSource: "fallback",
      probeOrigin,
      reason: params.keywordsArgumentPresent
        ? "The keywords argument was present but empty after trimming blank entries and duplicates, so the server fell back to mechanical tokenization of the query."
        : "No keywords argument was supplied, so the server fell back to mechanical tokenization of the query.",
      domain,
      expertRole,
    };
  }

  if (!domain || !expertRole) {
    const missing = [
      !domain ? "domain" : null,
      !expertRole ? "expertRole" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    return {
      keywordSource: "fallback",
      probeOrigin,
      reason: `Keywords were supplied but ${missing} was not declared, so domain-expert query rewriting could not be confirmed. The supplied keywords were still used for retrieval.`,
      domain,
      expertRole,
    };
  }

  return {
    keywordSource: "ai",
    probeOrigin,
    reason: null,
    domain,
    expertRole,
  };
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
  validateFiniteNumber(options.rrfK, "rrfK", 1);
  validateFiniteNumber(options.keywordWeight, "keywordWeight", 0);
  validateFiniteNumber(options.semanticWeight, "semanticWeight", 0);
  if (!Number.isInteger(options.topK) || options.topK > 20) {
    throw new Error("topK must be an integer between 1 and 20");
  }
  // Only the ceiling is the engine's business: it is the latency guard, and a
  // depth above it fails the scan rather than shortening it. The floor is a
  // configuration concern — a caller driving this directly (a test, a narrow
  // internal search) may legitimately fuse four candidates.
  if (options.keywordSearchTimeoutMs !== undefined) {
    validateFiniteNumber(
      options.keywordSearchTimeoutMs,
      "keywordSearchTimeoutMs",
      1,
    );
  }
  if (options.semanticBranchTimeoutMs !== undefined) {
    validateFiniteNumber(
      options.semanticBranchTimeoutMs,
      "semanticBranchTimeoutMs",
      1,
    );
  }
  if (options.keywords !== undefined) {
    normalizeKeywords(options.keywords);
  }
  if (options.minScore !== undefined) {
    if (
      !Number.isFinite(options.minScore) ||
      options.minScore < 0 ||
      options.minScore > 1
    ) {
      throw new Error("minScore must be a finite number between 0 and 1");
    }
  }

  if (options.keywordWeight === 0 && options.semanticWeight === 0) {
    throw new Error("keywordWeight and semanticWeight cannot both be zero");
  }
}

export interface HybridFusionOutcome {
  /** The first `topK` of {@link ranked} — what a non-paginating caller reads. */
  results: HybridSearchResult[];
  /**
   * EVERY candidate that cleared the relevance threshold, in final order.
   *
   * `results` is a window onto this list, not a different ranking: the
   * threshold has already been applied here, so paging through `ranked` can
   * never surface a document the threshold rejected, and never has to lower
   * the threshold to fill a page.
   */
  ranked: HybridSearchResult[];
  /** Candidates that scored below the threshold and were dropped. */
  discardedBelowThreshold: number;
  /** Candidates that survived the threshold but did not fit inside topK. */
  discardedBeyondTopK: number;
  appliedMinScore: number;
}

export function fuseHybridSearchResults(
  keywordResults: KeywordSearchItem[],
  semanticResults: SemanticSearchItem[],
  options: Pick<
    HybridSearchOptions,
    "topK" | "rrfK" | "keywordWeight" | "semanticWeight" | "minScore"
  >,
): HybridSearchResult[] {
  return fuseHybridSearchResultsDetailed(
    keywordResults,
    semanticResults,
    options,
  ).results;
}

/**
 * Fuse the two branches into one 0..1-scored ranking and apply the relevance
 * floor.
 *
 * Ordering is by the fused score, with the rank-consensus RRF score kept only
 * as a tie-break. `topK` is a ceiling applied AFTER the threshold, so a query
 * the library cannot answer returns few results — or none — instead of being
 * padded out with weak matches.
 */
export function fuseHybridSearchResultsDetailed(
  keywordResults: KeywordSearchItem[],
  semanticResults: SemanticSearchItem[],
  options: Pick<
    HybridSearchOptions,
    "topK" | "rrfK" | "keywordWeight" | "semanticWeight" | "minScore"
  >,
): HybridFusionOutcome {
  validateFiniteNumber(options.topK, "topK", 1);
  validateFiniteNumber(options.rrfK, "rrfK", 1);
  validateFiniteNumber(options.keywordWeight, "keywordWeight", 0);
  validateFiniteNumber(options.semanticWeight, "semanticWeight", 0);

  const candidates = new Map<string, FusedCandidate>();

  if (options.keywordWeight > 0) {
    keywordResults.forEach((item, index) => {
      const identityKey = `${item.libraryID ?? "unknown"}:${item.key}`;
      if (!item.key || candidates.get(identityKey)?.keywordItem) return;
      const rank = index + 1;
      const existing = candidates.get(identityKey) || {
        itemKey: item.key,
        libraryID: item.libraryID,
        rrfScore: 0,
      };
      existing.keywordItem = item;
      existing.keywordRank = rank;
      existing.rrfScore += options.keywordWeight / (options.rrfK + rank);
      candidates.set(identityKey, existing);
    });
  }

  if (options.semanticWeight > 0) {
    semanticResults.forEach((item, index) => {
      const identityKey = `${item.libraryID ?? "unknown"}:${item.itemKey}`;
      if (!item.itemKey || candidates.get(identityKey)?.semanticItem) return;
      const rank = index + 1;
      const existing = candidates.get(identityKey) || {
        itemKey: item.itemKey,
        libraryID: item.libraryID,
        rrfScore: 0,
      };
      existing.semanticItem = item;
      existing.semanticRank = rank;
      existing.rrfScore += options.semanticWeight / (options.rrfK + rank);
      candidates.set(identityKey, existing);
    });
  }

  const minScore =
    typeof options.minScore === "number" && Number.isFinite(options.minScore)
      ? Math.min(1, Math.max(0, options.minScore))
      : 0;

  const scored = Array.from(candidates.values()).map((candidate) => {
    const normalizedKeywordScore = candidate.keywordItem
      ? normalizeLexicalScore(candidate.keywordItem.relevanceScore)
      : undefined;
    const normalizedSemanticScore = candidate.semanticItem
      ? normalizeSemanticScore(candidate.semanticItem.score)
      : undefined;
    return {
      candidate,
      normalizedKeywordScore,
      normalizedSemanticScore,
      score: computeFusedScore({
        normalizedKeywordScore,
        normalizedSemanticScore,
        keywordWeight: options.keywordWeight,
        semanticWeight: options.semanticWeight,
      }),
    };
  });

  const surviving = scored.filter((entry) => entry.score >= minScore);
  const discardedBelowThreshold = scored.length - surviving.length;

  const ordered = surviving.sort((a, b) => {
    const fusedDifference = b.score - a.score;
    if (fusedDifference !== 0) return fusedDifference;
    const rrfDifference = b.candidate.rrfScore - a.candidate.rrfScore;
    if (rrfDifference !== 0) return rrfDifference;
    return compareFusedCandidates(a.candidate, b.candidate);
  });

  const ranked = ordered
    .map(
      ({
        candidate,
        normalizedKeywordScore,
        normalizedSemanticScore,
        score,
      }) => {
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
          score,
          normalizedKeywordScore,
          normalizedSemanticScore,
          rrfScore: candidate.rrfScore,
          keywordRank: candidate.keywordRank,
          semanticRank: candidate.semanticRank,
          keywordScore: keywordItem?.relevanceScore,
          semanticScore: semanticItem?.score,
          matchedChunks: semanticItem?.matchedChunks,
        };
      },
    );

  // The window is taken after scoring, ordering and thresholding, so page 1 is
  // byte-for-byte what it was before pagination existed.
  const results = ranked.slice(0, options.topK);

  return {
    results,
    ranked,
    discardedBelowThreshold,
    discardedBeyondTopK: Math.max(0, ranked.length - results.length),
    appliedMinScore: minScore,
  };
}

/** Stable ordering for candidates whose fused and RRF scores are identical. */
function compareFusedCandidates(a: FusedCandidate, b: FusedCandidate): number {
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
  const keywordSearchTimeoutMs =
    options.keywordSearchTimeoutMs ?? DEFAULT_KEYWORD_SEARCH_TIMEOUT_MS;
  const semanticBranchTimeoutMs =
    options.semanticBranchTimeoutMs ?? DEFAULT_SEMANTIC_BRANCH_TIMEOUT_MS;
  // Both branches are ALWAYS bounded. `exhaustive` widens what is retrieved, it
  // never removes a deadline: an unbounded branch here used to let a single
  // hybrid_search hang the caller indefinitely, because the library-level tool
  // always sets exhaustive.
  const [keywordRun, semanticRun] = await Promise.all([
    options.keywordWeight > 0
      ? settleWithTimeout(
          dependencies.keywordSearch,
          keywordSearchTimeoutMs,
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
          semanticBranchTimeoutMs,
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

  const keywordSearchUnavailable =
    keywordOutcome.status === "rejected" &&
    isKeywordSearchUnavailableError(keywordOutcome.reason);
  if (keywordOutcome.status === "rejected") {
    warnings.push(
      `Keyword metadata search unavailable: ${errorMessage(keywordOutcome.reason)}`,
    );
  }
  if (keywordSearchUnavailable) {
    // Stated separately from the branch error so the two facts a client needs
    // are both explicit: these rows are semantic-only, and this is temporary.
    warnings.push(
      "These results come from the SEMANTIC branch ALONE: Zotero's database " +
        "stopped answering an earlier keyword query, and its search API " +
        "cannot be cancelled, so the plugin is waiting before it starts " +
        "another. Do NOT read a small or empty result set as evidence that " +
        "the library lacks relevant work, and do not retry immediately — the " +
        "keyword branch restores itself as soon as Zotero answers.",
    );
  }
  const semanticIndexIncompatible =
    semanticOutcome.status === "rejected" &&
    isVectorDimensionMismatchError(semanticOutcome.reason);
  if (semanticOutcome.status === "rejected") {
    warnings.push(
      `Semantic search unavailable: ${errorMessage(semanticOutcome.reason)}`,
    );
  }
  if (semanticIndexIncompatible) {
    // Stated separately from the branch error, and in the shared wording, so
    // the remedy is legible whichever tool the caller reached this through.
    warnings.push(
      `${DIMENSION_MISMATCH_HINT} These results come from the keyword branch ALONE — treat them as a keyword search, not as a hybrid one, and do not read a small or empty result set as evidence that the library lacks relevant work.`,
    );
  }

  const rrfStartedAt = Date.now();
  const fusion = fuseHybridSearchResultsDetailed(
    keywordResults,
    semanticResults,
    options,
  );
  const rrfMs = Date.now() - rrfStartedAt;

  return {
    results: fusion.results,
    ranked: fusion.ranked,
    degraded: warnings.length > 0,
    semanticIndexIncompatible,
    keywordSearchUnavailable,
    warnings,
    keywordResultCount: keywordResults.length,
    semanticResultCount: semanticResults.length,
    discardedBelowThreshold: fusion.discardedBelowThreshold,
    appliedMinScore: fusion.appliedMinScore,
    timings: {
      keywordMs: keywordRun.elapsedMs,
      semanticMs: semanticRun.elapsedMs,
      rrfMs,
      totalMs: Date.now() - startedAt,
    },
  };
}
