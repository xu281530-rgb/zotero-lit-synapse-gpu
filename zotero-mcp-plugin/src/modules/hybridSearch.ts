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

export interface WikiSearchItem {
  itemKey: string;
  libraryID?: number;
  title?: string;
  /** Query relevance only. Evidence quality is deliberately separate below. */
  normalizedWikiScore: number;
  evidenceConfidence: number;
  readDepth: string;
  epistemicStatus: string;
  wikiClaims?: unknown[];
}

export interface HybridSearchOptions {
  query?: string;
  /**
   * Keyword-branch relevance floor, 0..1 on the normalised BM25F scale.
   *
   * Gates the keyword branch and NOTHING else. A document below it contributes
   * no keyword rank to the fusion, but the semantic branch may still admit it
   * on its own — the two branches can no longer veto each other. Defaults to 0
   * (admit everything the branch returned) for direct/test callers; production
   * callers pass the user's setting.
   */
  keywordMinScore?: number;
  /**
   * Semantic-branch relevance floor, 0..1 on the cosine scale. Gates the
   * semantic branch alone, under the same rule.
   */
  semanticMinScore?: number;
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
  /** Optional third-route RRF weight. Zero disables active Wiki fusion. */
  wikiWeight?: number;
  /** Wiki relevance floor, on normalizedWikiScore rather than confidence. */
  wikiMinScore?: number;
  /** Compute and report Wiki retrieval without changing the final ranking. */
  wikiShadowMode?: boolean;
  /** Independent deadline; a Wiki failure never blocks the two existing routes. */
  wikiSearchTimeoutMs?: number;
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
   * The weighted Reciprocal Rank Fusion score — the ONLY ranking key.
   *
   * Deliberately not a relevance: it is a small rank-consensus number (a
   * first-place-in-both-branches document lands near 2/(k+1) ≈ 0.033 at the
   * default k=60), so it says "this ranked above that" and nothing about how
   * relevant either one is. Always equal to {@link rrfScore}; the field is
   * duplicated so that the value results are SORTED by and the value called
   * `score` can never drift apart, which is the one way a consumer could be
   * misled into re-sorting.
   *
   * "How relevant is it?" is answered by normalizedKeywordScore and
   * normalizedSemanticScore, which are real 0..1 relevances on their own
   * branch's scale — and which are what the thresholds were applied to.
   */
  score: number;
  /**
   * Normalised (0..1) BM25F relevance, present only when the keyword branch
   * ADMITTED this document, i.e. only when it cleared keywordMinScore. Absent
   * means "this branch contributed no rank", never "this branch scored 0".
   */
  normalizedKeywordScore?: number;
  /** Same, for the semantic branch and semanticMinScore. */
  normalizedSemanticScore?: number;
  normalizedWikiScore?: number;
  /** The weighted RRF score. Identical to {@link score}. */
  rrfScore: number;
  keywordRank?: number;
  semanticRank?: number;
  wikiRank?: number;
  keywordScore?: number;
  semanticScore?: number;
  evidenceConfidence?: number;
  readDepth?: string;
  epistemicStatus?: string;
  wikiClaims?: unknown[];
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
  wikiResultCount: number;
  wikiAdmittedCount: number;
  wikiShadowMode: boolean;
  /** Wiki documents admitted after its own relevance threshold. */
  wikiCandidateItemKeys: string[];
  /** Shadow candidates not admitted by either existing route. */
  wikiNovelDocumentCount: number;
  wikiKeywordOverlapCount: number;
  wikiSemanticOverlapCount: number;
  /**
   * Documents that one or both branches retrieved but NEITHER admitted.
   *
   * Under the old single fused floor this counted documents rejected by one
   * verdict. It now counts documents rejected twice over, which is the only
   * way a candidate can be dropped: clearing either threshold is enough.
   */
  discardedBelowThreshold: number;
  /** The keyword floor actually applied (after the user's setting won). */
  appliedKeywordMinScore: number;
  /** The semantic floor actually applied. */
  appliedSemanticMinScore: number;
  /** The Wiki relevance floor actually applied. */
  appliedWikiMinScore: number;
  /** Documents the keyword branch admitted. */
  keywordAdmittedCount: number;
  /** Documents the semantic branch admitted. */
  semanticAdmittedCount: number;
  timings: {
    keywordMs: number;
    semanticMs: number;
    wikiMs: number;
    rrfMs: number;
    totalMs: number;
  };
}

interface HybridSearchDependencies {
  keywordSearch: () => Promise<KeywordSearchItem[]>;
  semanticSearch: () => Promise<SemanticSearchItem[]>;
  wikiSearch?: () => Promise<WikiSearchItem[]>;
  /**
   * Called when a branch loses its race against the timeout. Racing a promise
   * only stops waiting for it — without these hooks the abandoned embedding
   * request and library scan keep running, so back-to-back queries pile up
   * background work that nobody is waiting for any more.
   */
  cancelKeywordSearch?: () => void;
  cancelSemanticSearch?: () => void;
  cancelWikiSearch?: () => void;
}

interface FusedCandidate {
  itemKey: string;
  libraryID?: number;
  keywordItem?: KeywordSearchItem;
  semanticItem?: SemanticSearchItem;
  wikiItem?: WikiSearchItem;
  keywordRank?: number;
  semanticRank?: number;
  wikiRank?: number;
  /** Set only when the keyword branch admitted this document. */
  normalizedKeywordScore?: number;
  /** Set only when the semantic branch admitted this document. */
  normalizedSemanticScore?: number;
  normalizedWikiScore?: number;
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
export const DEFAULT_WIKI_SEARCH_TIMEOUT_MS = 5000;

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

/*
 * There is deliberately no function here that combines the two branch scores
 * into one relevance number.
 *
 * There used to be: the stronger branch set the score and the weaker one added
 * a bounded agreement bonus (max + 0.15·min), and that single number was both
 * the ranking key and the thing the user's one threshold was applied to. It
 * required believing that a normalised BM25F score and a cosine similarity are
 * commensurable — that keyword 0.62 and semantic 0.62 mean the same amount of
 * relevance — which they are not: they come from differently-shaped scales and
 * only ever looked comparable because both happen to land inside 0..1.
 *
 * The replacement never compares them. Each branch is thresholded on its OWN
 * scale, where its number does mean something, and the ranking is decided by
 * where each document placed WITHIN its own branch — see
 * {@link fuseHybridSearchResultsDetailed}. Rank is the one quantity the two
 * branches genuinely share.
 */

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
  if (options.wikiWeight !== undefined) {
    validateFiniteNumber(options.wikiWeight, "wikiWeight", 0);
  }
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
  if (options.wikiSearchTimeoutMs !== undefined) {
    validateFiniteNumber(options.wikiSearchTimeoutMs, "wikiSearchTimeoutMs", 1);
  }
  if (options.keywords !== undefined) {
    normalizeKeywords(options.keywords);
  }
  for (const name of [
    "keywordMinScore",
    "semanticMinScore",
    "wikiMinScore",
  ] as const) {
    const value = options[name];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${name} must be a finite number between 0 and 1`);
    }
  }

  if (
    options.keywordWeight === 0 &&
    options.semanticWeight === 0 &&
    (options.wikiShadowMode || (options.wikiWeight ?? 0) === 0)
  ) {
    throw new Error("at least one active retrieval weight must be non-zero");
  }
}

export interface HybridFusionOutcome {
  /** The first `topK` of {@link ranked} — what a non-paginating caller reads. */
  results: HybridSearchResult[];
  /**
   * EVERY candidate at least ONE branch admitted, in final RRF order.
   *
   * `results` is a window onto this list, not a different ranking: both
   * thresholds have already been applied here, so paging through `ranked` can
   * never surface a document both branches rejected, and never has to lower a
   * threshold to fill a page.
   */
  ranked: HybridSearchResult[];
  /** Candidates that were retrieved but admitted by NEITHER branch. */
  discardedBelowThreshold: number;
  /** Candidates that survived but did not fit inside topK. */
  discardedBeyondTopK: number;
  appliedKeywordMinScore: number;
  appliedSemanticMinScore: number;
  appliedWikiMinScore: number;
  keywordAdmittedCount: number;
  semanticAdmittedCount: number;
  wikiAdmittedCount: number;
}

export function fuseHybridSearchResults(
  keywordResults: KeywordSearchItem[],
  semanticResults: SemanticSearchItem[],
  options: Pick<
    HybridSearchOptions,
    | "topK"
    | "rrfK"
    | "keywordWeight"
    | "semanticWeight"
    | "keywordMinScore"
    | "semanticMinScore"
  >,
): HybridSearchResult[] {
  return fuseHybridSearchResultsDetailed(
    keywordResults,
    semanticResults,
    options,
  ).results;
}

/**
 * Gate each branch on its OWN scale, union the survivors, and rank the union by
 * weighted Reciprocal Rank Fusion.
 *
 * The rule that makes this different from what it replaced: **a branch may
 * admit, never veto.** A document enters the fusion the moment one branch's
 * threshold accepts it, and the other branch's opinion — including "I never
 * retrieved it at all" — cannot take it back out. A document both branches
 * admit is not a document that survived twice; it is a document that collects
 * TWO rank contributions and therefore outranks single-branch documents at
 * comparable ranks. Corroboration is expressed as position, not as a bonus.
 *
 *   RRF = keywordWeight/(k + keywordRank)
 *       + semanticWeight/(k + semanticRank)
 *       + wikiWeight/(k + wikiRank)
 *
 * with an absent branch contributing nothing rather than a penalty. The weights
 * are what a user leans on to prefer one branch; `rrfK` controls how quickly
 * rank advantage flattens out and is deliberately NOT a per-branch knob — two
 * different k values would tangle "how much do I trust this branch" together
 * with "how much does placing first matter", which is the confusion the
 * weights exist to avoid.
 *
 * RANKS ARE POSITIONS AMONG THE ADMITTED, and that happens to cost nothing:
 * each branch hands back a list already sorted by its own score, and each
 * threshold is a floor on that same score, so the admitted set is always a
 * prefix of the list and a document's position is the same whether counted
 * before or after filtering. That is why one pass can filter and rank without
 * the two disagreeing.
 *
 * There is NO threshold on the RRF score. It is an ordering, not a relevance —
 * comparing it against 0.6 would be meaningless — and the old single fused
 * floor that did exactly that is gone. `topK` is a ceiling applied after
 * ranking, so a query the library cannot answer returns few results, or none,
 * rather than being padded out with weak matches.
 */
export function fuseHybridSearchResultsDetailed(
  keywordResults: KeywordSearchItem[],
  semanticResults: SemanticSearchItem[],
  wikiResultsOrOptions:
    | WikiSearchItem[]
    | Pick<
        HybridSearchOptions,
        | "topK"
        | "rrfK"
        | "keywordWeight"
        | "semanticWeight"
        | "wikiWeight"
        | "keywordMinScore"
        | "semanticMinScore"
        | "wikiMinScore"
        | "wikiShadowMode"
      >,
  maybeOptions?: Pick<
    HybridSearchOptions,
    | "topK"
    | "rrfK"
    | "keywordWeight"
    | "semanticWeight"
    | "wikiWeight"
    | "keywordMinScore"
    | "semanticMinScore"
    | "wikiMinScore"
    | "wikiShadowMode"
  >,
): HybridFusionOutcome {
  const wikiResults = Array.isArray(wikiResultsOrOptions)
    ? wikiResultsOrOptions
    : [];
  const options = Array.isArray(wikiResultsOrOptions)
    ? maybeOptions!
    : wikiResultsOrOptions;
  validateFiniteNumber(options.topK, "topK", 1);
  validateFiniteNumber(options.rrfK, "rrfK", 1);
  validateFiniteNumber(options.keywordWeight, "keywordWeight", 0);
  validateFiniteNumber(options.semanticWeight, "semanticWeight", 0);

  const clampFloor = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(1, Math.max(0, value))
      : 0;
  const keywordMinScore = clampFloor(options.keywordMinScore);
  const semanticMinScore = clampFloor(options.semanticMinScore);
  const wikiMinScore = clampFloor(options.wikiMinScore);

  const candidates = new Map<string, FusedCandidate>();
  // Every document either branch returned, admitted or not. Used only to report
  // how many were turned away by BOTH — the one number a caller can no longer
  // infer from the surviving rows.
  const retrieved = new Set<string>();
  let keywordAdmittedCount = 0;
  let semanticAdmittedCount = 0;
  let wikiAdmittedCount = 0;

  const upsert = (
    identityKey: string,
    itemKey: string,
    libraryID: number | undefined,
  ): FusedCandidate => {
    const existing = candidates.get(identityKey);
    if (existing) return existing;
    const created: FusedCandidate = { itemKey, libraryID, rrfScore: 0 };
    candidates.set(identityKey, created);
    return created;
  };

  // Weight 0 disables a branch outright: it can then neither admit a document
  // nor contribute a rank, which is what "weight 0" has to mean for the weights
  // to be a usable control at all.
  if (options.keywordWeight > 0) {
    let admittedRank = 0;
    for (const item of keywordResults) {
      if (!item.key) continue;
      const identityKey = `${item.libraryID ?? "unknown"}:${item.key}`;
      retrieved.add(identityKey);
      // A branch may list a document once. A duplicate is an upstream bug, and
      // letting it through would pay that document two rank contributions out
      // of a single branch.
      if (candidates.get(identityKey)?.keywordItem) continue;
      const normalized = normalizeLexicalScore(item.relevanceScore);
      if (normalized < keywordMinScore) continue;
      admittedRank += 1;
      const candidate = upsert(identityKey, item.key, item.libraryID);
      candidate.keywordItem = item;
      candidate.keywordRank = admittedRank;
      candidate.normalizedKeywordScore = normalized;
      candidate.rrfScore +=
        options.keywordWeight / (options.rrfK + admittedRank);
      keywordAdmittedCount += 1;
    }
  }

  if (options.semanticWeight > 0) {
    let admittedRank = 0;
    for (const item of semanticResults) {
      if (!item.itemKey) continue;
      const identityKey = `${item.libraryID ?? "unknown"}:${item.itemKey}`;
      retrieved.add(identityKey);
      if (candidates.get(identityKey)?.semanticItem) continue;
      const normalized = normalizeSemanticScore(item.score);
      if (normalized < semanticMinScore) continue;
      admittedRank += 1;
      const candidate = upsert(identityKey, item.itemKey, item.libraryID);
      candidate.semanticItem = item;
      candidate.semanticRank = admittedRank;
      candidate.normalizedSemanticScore = normalized;
      candidate.rrfScore +=
        options.semanticWeight / (options.rrfK + admittedRank);
      semanticAdmittedCount += 1;
    }
  }

  // Shadow Mode deliberately computes admission/rank diagnostics but never
  // creates or mutates a fused candidate. This keeps the legacy two-route
  // ordering byte-for-byte stable while real Zotero searches calibrate Wiki.
  const wikiWeight = options.wikiWeight ?? 0;
  if (wikiWeight > 0 || options.wikiShadowMode) {
    let admittedRank = 0;
    const seen = new Set<string>();
    for (const item of wikiResults) {
      if (!item.itemKey) continue;
      const identityKey = `${item.libraryID ?? "unknown"}:${item.itemKey}`;
      if (seen.has(identityKey)) continue;
      seen.add(identityKey);
      const normalized = clampFloor(item.normalizedWikiScore);
      if (normalized < wikiMinScore) continue;
      admittedRank += 1;
      wikiAdmittedCount += 1;
      if (options.wikiShadowMode || wikiWeight === 0) continue;
      retrieved.add(identityKey);
      const candidate = upsert(identityKey, item.itemKey, item.libraryID);
      candidate.wikiItem = item;
      candidate.wikiRank = admittedRank;
      candidate.normalizedWikiScore = normalized;
      candidate.rrfScore += wikiWeight / (options.rrfK + admittedRank);
    }
  }

  // A map entry is only ever created for a document some branch admitted, so
  // the difference is precisely the documents both branches turned away.
  const discardedBelowThreshold = Math.max(0, retrieved.size - candidates.size);

  const ordered = Array.from(candidates.values()).sort((a, b) => {
    const rrfDifference = b.rrfScore - a.rrfScore;
    if (rrfDifference !== 0) return rrfDifference;
    return compareFusedCandidates(a, b);
  });

  const ranked = ordered.map((candidate) => {
    const keywordItem = candidate.keywordItem;
    const semanticItem = candidate.semanticItem;
    const wikiItem = candidate.wikiItem;
    const base = keywordItem
      ? { ...keywordItem }
      : semanticItem
        ? { ...semanticItem }
        : wikiItem
          ? { ...wikiItem }
          : {};

    delete (base as Record<string, unknown>).key;
    delete (base as Record<string, unknown>).score;

    return {
      ...base,
      itemKey: candidate.itemKey,
      libraryID: candidate.libraryID,
      title: keywordItem?.title || semanticItem?.title || wikiItem?.title || "",
      // Ranking key and reported score are the same value on purpose: a row
      // whose `score` disagreed with its position would invite the reader to
      // re-sort, and re-sorting a rank fusion by anything else undoes it.
      score: candidate.rrfScore,
      normalizedKeywordScore: candidate.normalizedKeywordScore,
      normalizedSemanticScore: candidate.normalizedSemanticScore,
      normalizedWikiScore: candidate.normalizedWikiScore,
      rrfScore: candidate.rrfScore,
      keywordRank: candidate.keywordRank,
      semanticRank: candidate.semanticRank,
      wikiRank: candidate.wikiRank,
      keywordScore: keywordItem?.relevanceScore,
      semanticScore: semanticItem?.score,
      evidenceConfidence: wikiItem?.evidenceConfidence,
      readDepth: wikiItem?.readDepth,
      epistemicStatus: wikiItem?.epistemicStatus,
      wikiClaims: wikiItem?.wikiClaims,
      matchedChunks: semanticItem?.matchedChunks,
    };
  });

  // The window is taken after gating and ordering, so a page can never contain
  // a document neither branch admitted, and a short last page is never padded.
  const results = ranked.slice(0, options.topK);

  return {
    results,
    ranked,
    discardedBelowThreshold,
    discardedBeyondTopK: Math.max(0, ranked.length - results.length),
    appliedKeywordMinScore: keywordMinScore,
    appliedSemanticMinScore: semanticMinScore,
    appliedWikiMinScore: wikiMinScore,
    keywordAdmittedCount,
    semanticAdmittedCount,
    wikiAdmittedCount,
  };
}

/** Stable ordering for candidates whose fused and RRF scores are identical. */
function compareFusedCandidates(a: FusedCandidate, b: FusedCandidate): number {
  const aSourceCount =
    Number(Boolean(a.keywordItem)) +
    Number(Boolean(a.semanticItem)) +
    Number(Boolean(a.wikiItem));
  const bSourceCount =
    Number(Boolean(b.keywordItem)) +
    Number(Boolean(b.semanticItem)) +
    Number(Boolean(b.wikiItem));
  if (aSourceCount !== bSourceCount) return bSourceCount - aSourceCount;

  const aBestRank = Math.min(
    a.keywordRank ?? Infinity,
    a.semanticRank ?? Infinity,
    a.wikiRank ?? Infinity,
  );
  const bBestRank = Math.min(
    b.keywordRank ?? Infinity,
    b.semanticRank ?? Infinity,
    b.wikiRank ?? Infinity,
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
  const wikiSearchTimeoutMs =
    options.wikiSearchTimeoutMs ?? DEFAULT_WIKI_SEARCH_TIMEOUT_MS;
  const wikiRequested =
    Boolean(dependencies.wikiSearch) &&
    (options.wikiShadowMode === true || (options.wikiWeight ?? 0) > 0);
  const [keywordRun, semanticRun, wikiRun] = await Promise.all([
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
    wikiRequested
      ? settleWithTimeout(
          dependencies.wikiSearch!,
          wikiSearchTimeoutMs,
          "Wiki search",
          dependencies.cancelWikiSearch,
        )
      : Promise.resolve({
          outcome: {
            status: "fulfilled",
            value: [],
          } as PromiseFulfilledResult<WikiSearchItem[]>,
          elapsedMs: 0,
        }),
  ]);
  const keywordOutcome = keywordRun.outcome;
  const semanticOutcome = semanticRun.outcome;
  const wikiOutcome = wikiRun.outcome;

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
  const wikiResults =
    wikiOutcome.status === "fulfilled" ? wikiOutcome.value : [];

  const identity = (libraryID: number | undefined, itemKey: string): string =>
    `${libraryID ?? "unknown"}:${itemKey}`;
  const keywordKeys = new Set(
    keywordResults
      .filter((item) => item.key)
      .map((item) => identity(item.libraryID, item.key)),
  );
  const semanticKeys = new Set(
    semanticResults
      .filter((item) => item.itemKey)
      .map((item) => identity(item.libraryID, item.itemKey)),
  );
  const wikiFloor = Math.max(0, Math.min(1, options.wikiMinScore ?? 0));
  const wikiCandidateKeys = Array.from(
    new Set(
      wikiResults
        .filter(
          (item) =>
            item.itemKey &&
            Math.max(0, Math.min(1, item.normalizedWikiScore)) >= wikiFloor,
        )
        .map((item) => identity(item.libraryID, item.itemKey)),
    ),
  );

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
  if (wikiOutcome.status === "rejected") {
    warnings.push(
      `Wiki search unavailable; Keyword + Semantic results are unaffected: ${errorMessage(wikiOutcome.reason)}`,
    );
  }

  const rrfStartedAt = Date.now();
  const fusion = fuseHybridSearchResultsDetailed(
    keywordResults,
    semanticResults,
    wikiResults,
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
    wikiResultCount: wikiResults.length,
    wikiAdmittedCount: fusion.wikiAdmittedCount,
    wikiShadowMode: options.wikiShadowMode === true,
    wikiCandidateItemKeys: wikiCandidateKeys.map((key) =>
      key.slice(key.indexOf(":") + 1),
    ),
    wikiNovelDocumentCount: wikiCandidateKeys.filter(
      (key) => !keywordKeys.has(key) && !semanticKeys.has(key),
    ).length,
    wikiKeywordOverlapCount: wikiCandidateKeys.filter((key) =>
      keywordKeys.has(key),
    ).length,
    wikiSemanticOverlapCount: wikiCandidateKeys.filter((key) =>
      semanticKeys.has(key),
    ).length,
    discardedBelowThreshold: fusion.discardedBelowThreshold,
    appliedKeywordMinScore: fusion.appliedKeywordMinScore,
    appliedSemanticMinScore: fusion.appliedSemanticMinScore,
    appliedWikiMinScore: fusion.appliedWikiMinScore,
    keywordAdmittedCount: fusion.keywordAdmittedCount,
    semanticAdmittedCount: fusion.semanticAdmittedCount,
    timings: {
      keywordMs: keywordRun.elapsedMs,
      semanticMs: semanticRun.elapsedMs,
      wikiMs: wikiRun.elapsedMs,
      rrfMs,
      totalMs: Date.now() - startedAt,
    },
  };
}
