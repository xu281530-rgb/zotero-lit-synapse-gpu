/**
 * Tokenisation for the body-keyword index.
 *
 * 这个模块只做一件事：把「一段文字」和「一个检索词」映射到同一套词元空间，
 * 使得倒排索引里存的东西和查询时找的东西必然对得上。它不打分、不读数据库。
 *
 * 两个语言各有一套规则，因为它们的失败模式完全不同：
 *
 * - 拉丁/数字/符号：整词保留。`Ti-6Al-4V` 拆成 ti / 6al / 4v 之后就再也检索
 *   不回来了，而这类牌号恰恰是科研检索里最需要精确命中的东西。所以词元边界
 *   允许跨越 `-_./'`，整段保留为一个词元。
 *
 * - 汉字：没有词边界可用，所以按 2-gram 切。3-gram 被实测否决了：在本库
 *   706 篇正文（46131 段）上，2+3-gram 比纯 2-gram 多花 14.7MB 索引，
 *   却依然有 3.85% 误召回；而纯 2-gram 配合「取回候选后用段落原文精确校验」
 *   是 0% 误召回、索引最小、查询最快（见 REQUIRES_VERIFICATION）。
 *
 * 索引侧与查询侧共用 {@link normalize}，这是全部正确性的基础：任何只在一侧
 * 做的归一化都会静默地制造一批永远检索不到的词。
 */

/**
 * Dash-like characters PDF extraction produces where the author typed a hyphen.
 *
 * This is not cosmetic. Publishers typeset `Ti-6Al-4V` with an EN DASH, so the
 * text extracted from the PDF contains `Ti–6Al–4V` while the user types
 * `Ti-6Al-4V`. Without this mapping the grade is unsearchable in exactly the
 * documents that discuss it.
 */
const DASH_CHARS = "\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFF0D";

/**
 * Prime and apostrophe variants, folded onto the ASCII apostrophe.
 *
 * `γ′` (PRIME) and `γ'` (APOSTROPHE) are the same phase written two ways, and
 * both occur in the same paper.
 */
const APOSTROPHE_CHARS = "\u2032\u2033\u02B9\u2018\u2019\u201B\uFF07";

/**
 * Greek letters that carry meaning as phase and variable names, with the Latin
 * spelling a user is equally likely to type.
 *
 * Deliberately a closed list. The requirement was case/dash/prime folding plus
 * `γ ↔ gamma`, NOT open-ended fuzzy expansion: every extra variant is another
 * way for an unrelated document to look like a match.
 */
const GREEK_SPELLINGS: Readonly<Record<string, string>> = {
  "\u03B1": "alpha",
  "\u03B2": "beta",
  "\u03B3": "gamma",
  "\u03B4": "delta",
  "\u03B5": "epsilon",
  "\u03B6": "zeta",
  "\u03B7": "eta",
  "\u03B8": "theta",
  "\u03BA": "kappa",
  "\u03BB": "lambda",
  "\u03BC": "mu",
  "\u03BD": "nu",
  "\u03BE": "xi",
  "\u03C0": "pi",
  "\u03C1": "rho",
  "\u03C3": "sigma",
  "\u03C4": "tau",
  "\u03C6": "phi",
  "\u03C7": "chi",
  "\u03C8": "psi",
  "\u03C9": "omega",
};

const DASH_PATTERN = new RegExp(`[${DASH_CHARS}]`, "gu");
const APOSTROPHE_PATTERN = new RegExp(`[${APOSTROPHE_CHARS}]`, "gu");

/** CJK ideographs. Kana and Hangul are deliberately not included here. */
const HAN_CLASS = "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF";
const HAN_RUN_PATTERN = new RegExp(`[${HAN_CLASS}]+`, "gu");
const HAN_TEST_PATTERN = new RegExp(`[${HAN_CLASS}]`, "u");

/**
 * One Latin/digit/symbol token.
 *
 * The inner class is joined by `-_./'` rather than split on it, which is what
 * keeps `ti-6al-4v`, `al2o3`, `x-ray` and `10.1016/j.msea` whole. A separator
 * only stays inside the token when a token character follows it, so trailing
 * punctuation (`superalloy.`) does not become part of the term.
 *
 * The trailing `'*` is not symmetry for its own sake: a prime is the one
 * separator that legitimately ENDS a term. `γ′` has nothing after the prime, so
 * without this the token collapsed to a bare `γ` and the phase name was never
 * indexed at all — the exact failure the symbol handling exists to prevent.
 */
const LATIN_CORE = "A-Za-z0-9\\u00C0-\\u024F\\u0370-\\u03FF";
const LATIN_TOKEN_PATTERN = new RegExp(
  `[${LATIN_CORE}]+(?:['\\-_./][${LATIN_CORE}]+)*'*`,
  "gu",
);

/** Greek letters carry meaning alone (γ, δ, α), unlike single Latin letters. */
const SINGLE_GREEK_PATTERN = /^[\u0370-\u03FF]$/u;

/**
 * Separators removed to produce the "written solid" variant of a token.
 *
 * The apostrophe is NOT in this set, and that is a correctness decision rather
 * than an oversight: stripping it would fold `γ'` onto `γ`, and in a nickel
 * superalloy γ and γ′ are two different phases. Conflating them would answer a
 * question about the matrix with papers about the strengthening precipitate.
 */
const SOLID_STRIP_PATTERN = /[-_./]/gu;

/** Latin tokens this short carry no retrieval value on their own. */
const MIN_LATIN_TOKEN_LENGTH = 2;

/**
 * Whether a Latin-side token is worth an index entry.
 *
 * Length two is the general bar — a lone `a` or `x` matches everything and
 * discriminates nothing — but a single Greek letter is a real term of art (γ the
 * matrix, δ the phase, α the parameter), so it is admitted explicitly.
 */
function isIndexableLatinToken(token: string): boolean {
  if (token.length >= MIN_LATIN_TOKEN_LENGTH) return true;
  return SINGLE_GREEK_PATTERN.test(token);
}

/**
 * Fold a string onto the form both the index and the query are built from.
 *
 * Applied identically on both sides. Unicode is normalised to NFKC first so
 * full-width Latin (`ＦＧＨ４０９６`) and compatibility forms collapse onto the
 * plain ASCII a user actually types.
 */
export function normalize(text: string): string {
  if (!text) return "";
  let folded: string;
  try {
    folded = text.normalize("NFKC");
  } catch {
    // A malformed lone surrogate can throw; the unnormalised text still indexes.
    folded = text;
  }
  return folded
    .replace(DASH_PATTERN, "-")
    .replace(APOSTROPHE_PATTERN, "'")
    .toLowerCase();
}

/** Whether `value` contains at least one Han character. */
export function containsHan(value: string): boolean {
  return HAN_TEST_PATTERN.test(value);
}

/**
 * Every indexable form of one already-normalised Latin token.
 *
 * The exact token always comes first. The extra forms exist so that a user who
 * types the grade differently than the paper printed it still finds it:
 *
 *   ti-6al-4v -> ti-6al-4v, ti6al4v
 *   γ'        -> γ', gamma'
 *   10.1016/j -> 10.1016/j, 101016j
 *
 * Note what is absent: no prefixes, no infixes, no stemming. `x-ray` yields
 * `x-ray` and `xray` but never `ray`, so searching for `ray` cannot be
 * satisfied by an X-ray paper — which is the requested behaviour.
 */
export function latinTokenVariants(token: string): string[] {
  const variants: string[] = [token];
  const push = (candidate: string) => {
    if (!candidate) return;
    if (!isIndexableLatinToken(candidate)) return;
    if (variants.includes(candidate)) return;
    variants.push(candidate);
  };

  push(token.replace(SOLID_STRIP_PATTERN, ""));

  let spelled = "";
  let sawGreek = false;
  for (const char of token) {
    const latin = GREEK_SPELLINGS[char];
    if (latin) {
      spelled += latin;
      sawGreek = true;
    } else {
      spelled += char;
    }
  }
  if (sawGreek) {
    push(spelled);
    push(spelled.replace(SOLID_STRIP_PATTERN, ""));
  }

  return variants;
}

/** One term occurrence found in a text. */
export interface TokenOccurrence {
  term: string;
  /** Offset in the NORMALISED text, used only to derive Han adjacency. */
  offset: number;
}

/**
 * Tokenise text for INDEXING.
 *
 * Han runs become overlapping bigrams; a lone Han character is emitted as
 * itself so a single-character query still has something to match. Latin tokens
 * are emitted together with their variants, all at the same offset, because a
 * variant is the same occurrence written differently rather than a second hit.
 */
export function tokenizeForIndex(text: string): TokenOccurrence[] {
  const normalized = normalize(text);
  const occurrences: TokenOccurrence[] = [];
  if (!normalized) return occurrences;

  LATIN_TOKEN_PATTERN.lastIndex = 0;
  for (
    let match = LATIN_TOKEN_PATTERN.exec(normalized);
    match !== null;
    match = LATIN_TOKEN_PATTERN.exec(normalized)
  ) {
    const token = match[0];
    if (!isIndexableLatinToken(token)) continue;
    for (const variant of latinTokenVariants(token)) {
      occurrences.push({ term: variant, offset: match.index });
    }
  }

  HAN_RUN_PATTERN.lastIndex = 0;
  for (
    let match = HAN_RUN_PATTERN.exec(normalized);
    match !== null;
    match = HAN_RUN_PATTERN.exec(normalized)
  ) {
    const run = match[0];
    if (run.length === 1) {
      occurrences.push({ term: run, offset: match.index });
      continue;
    }
    for (let index = 0; index + 2 <= run.length; index += 1) {
      occurrences.push({
        term: run.slice(index, index + 2),
        offset: match.index + index,
      });
    }
  }

  return occurrences;
}

/**
 * What the index must be asked for in order to answer one user keyword.
 *
 * `terms` is a conjunction: a candidate must carry ALL of them. That is what
 * makes a multi-character Chinese term work off a bigram index — 柱状晶 becomes
 * 柱状 AND 状晶 — and it is also why {@link requiresVerification} exists.
 */
export interface QueryPlan {
  /** The keyword as the index would have written it. */
  normalized: string;
  /** Terms that must all be present. Empty when the keyword is unindexable. */
  terms: string[];
  /**
   * Whether a candidate carrying every term still has to be checked against
   * the stored text before it counts as a hit.
   *
   * True exactly when the conjunction cannot prove adjacency, i.e. a Han term
   * of 3+ characters: a passage containing 柱状 and 状晶 in unrelated places
   * satisfies the conjunction without containing 柱状晶. Measured on this
   * library, skipping the check costs 6.3% false hits; performing it costs
   * nothing, because the passage text is already stored alongside its vector.
   */
  requiresVerification: boolean;
  /**
   * Alternative plans that also satisfy this keyword, e.g. the `gamma prime`
   * spelling of `γ′`. A candidate matching ANY plan matches the keyword.
   */
  alternatives?: QueryPlan[];
}

/**
 * Multi-word spellings of symbol-bearing terms, expanded on the QUERY side.
 *
 * Kept out of the index on purpose: `gamma prime` is two Latin tokens, so
 * indexing it would mean inventing phrase entries for every symbol, whereas
 * expanding it here costs one extra lookup and stays trivial to extend.
 */
const QUERY_SYNONYMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^gamma[\s-]*prime$/u, "\u03B3'"],
  [/^gamma[\s-]*double[\s-]*prime$/u, "\u03B3''"],
  [/^alpha[\s-]*prime$/u, "\u03B1'"],
  [/^beta[\s-]*prime$/u, "\u03B2'"],
];

function planForNormalized(normalized: string): QueryPlan {
  const terms: string[] = [];

  LATIN_TOKEN_PATTERN.lastIndex = 0;
  for (
    let match = LATIN_TOKEN_PATTERN.exec(normalized);
    match !== null;
    match = LATIN_TOKEN_PATTERN.exec(normalized)
  ) {
    const token = match[0];
    if (!isIndexableLatinToken(token)) continue;
    // The exact form only. Variants are an INDEX-side courtesy: the index
    // already holds ti6al4v for a document printing ti-6al-4v, so asking for
    // the user's own spelling is enough and asking for all of them would turn
    // a conjunction into an impossible requirement.
    terms.push(token);
  }

  HAN_RUN_PATTERN.lastIndex = 0;
  for (
    let match = HAN_RUN_PATTERN.exec(normalized);
    match !== null;
    match = HAN_RUN_PATTERN.exec(normalized)
  ) {
    const run = match[0];
    if (run.length === 1) {
      terms.push(run);
      continue;
    }
    for (let index = 0; index + 2 <= run.length; index += 1) {
      terms.push(run.slice(index, index + 2));
    }
  }

  const unique = Array.from(new Set(terms));

  /*
   * One rule, and it is exact rather than a list of cases.
   *
   * The index can prove "this term is present". It can never prove "these terms
   * are ADJACENT", because no positions are stored — that was measured and
   * rejected as costing more space than trigrams while running four times
   * slower. So the conjunction alone answers the keyword only when the
   * conjunction IS the keyword: exactly one term, and that term reconstructs
   * the whole normalised keyword.
   *
   * Everything else needs the text checked:
   *   柱状晶      -> 柱状 AND 状晶, which 柱状组织与环状晶粒 also satisfies
   *   δ相         -> δ AND 相, present in a paper that never writes δ相
   *   inconel 718 -> both words, in a paper citing Inconel 625 and ISO 718
   *
   * That last case is also what keeps this consistent with the existing
   * metadata ranker, which has always matched a multi-word keyword as a literal
   * substring rather than as a bag of words.
   */
  const requiresVerification = !(
    unique.length === 1 && unique[0] === normalized
  );

  return { normalized, terms: unique, requiresVerification };
}

/**
 * Turn one user keyword into the lookups that answer it.
 *
 * Returns a plan whose `terms` may be empty — a keyword of punctuation alone,
 * or a single Latin letter, is simply not indexable, and the caller must skip
 * it rather than treat it as matching everything.
 */
export function planQueryTerm(keyword: string): QueryPlan {
  const normalized = normalize(keyword).trim();
  if (!normalized) {
    return { normalized: "", terms: [], requiresVerification: false };
  }

  const plan = planForNormalized(normalized);

  const alternatives: QueryPlan[] = [];

  /*
   * The de-punctuated spelling, as an alternative rather than as an extra term.
   *
   * The index already stores both forms for a document that WRITES the separated
   * one (`ti-6al-4v` also indexes `ti6al4v`), so a solid query already reached a
   * hyphenated paper. The reverse did not: a paper printing `Ti6Al4V` solid has
   * nothing to strip and so only ever indexed `ti6al4v`, leaving the hyphenated
   * query unable to find it. Measured on this library that asymmetry was 23
   * documents for `Ti-6Al-4V` against 31 for `Ti6Al4V` — the same grade.
   *
   * It must be an ALTERNATIVE, not another required term: adding it to `terms`
   * would demand both spellings be present in the same field, which almost never
   * happens and would turn the fix into a way of finding nothing.
   */
  const solid = normalized.replace(SOLID_STRIP_PATTERN, "");
  if (solid && solid !== normalized) {
    const solidPlan = planForNormalized(solid);
    if (solidPlan.terms.length > 0) alternatives.push(solidPlan);
  }
  for (const [pattern, canonical] of QUERY_SYNONYMS) {
    if (pattern.test(normalized)) {
      alternatives.push(planForNormalized(normalize(canonical)));
    }
  }
  // The reverse direction: someone typing γ′ should also reach a paper that
  // only ever spelled it out. The index already holds the spelled variant of a
  // symbol token, so this is only needed for the multi-word spelling.
  for (const [pattern, canonical] of QUERY_SYNONYMS) {
    if (normalized === normalize(canonical)) {
      const spelled = pattern.source
        .replace(/^\^/u, "")
        .replace(/\$$/u, "")
        .replace(/\[\\s-\]\*/gu, " ")
        .trim();
      if (spelled) alternatives.push(planForNormalized(spelled));
    }
  }

  if (alternatives.length > 0) plan.alternatives = alternatives;
  return plan;
}

/**
 * How often `plan`'s keyword occurs in `text`, by the SAME rule the index uses.
 *
 * This is the parity function. The body field is scored from postings, while
 * title/abstract/tags are scored from the live item — and if those two paths
 * disagreed about what counts as an occurrence, a term would be worth more in
 * one field than another for reasons having nothing to do with field weights.
 * So both go through this: every term of the plan must be present, the count is
 * the rarest term's count, and a plan that cannot prove adjacency is verified
 * against the text.
 *
 * Returns 0 rather than a partial count when any term is missing: a conjunction
 * is all-or-nothing.
 */
/** Token counts for one text, the form both scoring paths evaluate against. */
export function tokenCountsOf(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const occurrence of tokenizeForIndex(text)) {
    counts.set(occurrence.term, (counts.get(occurrence.term) ?? 0) + 1);
  }
  return counts;
}

/**
 * How often `plan`'s keyword occurs, given ALREADY-TOKENISED counts.
 *
 * Split from {@link countPlanOccurrences} for one measured reason: scoring a
 * candidate means evaluating every probe against every field, and re-tokenising
 * the field per probe made ranking 931 candidates take 233ms instead of tens.
 * Tokenising is per field; this is per (field, probe).
 *
 * `text` is still needed, and only for verification — a bigram conjunction
 * cannot prove adjacency, so the original string is what settles it.
 */
export function countPlanInCounts(
  plan: QueryPlan,
  counts: Map<string, number>,
  text: string,
  normalizedText?: string,
): number {
  const evaluate = (candidate: QueryPlan): number => {
    if (candidate.terms.length === 0) return 0;
    let smallest = Infinity;
    for (const term of candidate.terms) {
      const count = counts.get(term) ?? 0;
      if (count === 0) return 0;
      if (count < smallest) smallest = count;
    }
    if (!Number.isFinite(smallest)) return 0;
    if (candidate.requiresVerification) {
      const haystack = normalizedText ?? normalize(text);
      if (!haystack.includes(candidate.normalized)) return 0;
    }
    return smallest;
  };

  let best = evaluate(plan);
  for (const alternative of plan.alternatives ?? []) {
    if (best > 0) break;
    best = Math.max(best, evaluate(alternative));
  }
  return best;
}

/**
 * How often `plan`'s keyword occurs in `text`, by the SAME rule the index uses.
 *
 * This is the parity function. The body field is scored from postings, while
 * title/abstract/tags are scored from the live item — and if those two paths
 * disagreed about what counts as an occurrence, a term would be worth more in
 * one field than another for reasons having nothing to do with field weights.
 * So both go through this: every term of the plan must be present, the count is
 * the rarest term's count, and a plan that cannot prove adjacency is verified
 * against the text.
 *
 * Returns 0 rather than a partial count when any term is missing: a conjunction
 * is all-or-nothing.
 */
export function countPlanOccurrences(plan: QueryPlan, text: string): number {
  if (!text || plan.terms.length === 0) return 0;
  return countPlanInCounts(plan, tokenCountsOf(text), text);
}

/**
 * Whether `haystack` really contains `plan`'s keyword.
 *
 * Both sides are normalised, so this is the same comparison the index was
 * built from. Only called for plans that {@link QueryPlan.requiresVerification}.
 */
export function verifyOccurrence(haystack: string, plan: QueryPlan): boolean {
  if (!plan.normalized) return false;
  const normalizedHaystack = normalize(haystack);
  if (normalizedHaystack.includes(plan.normalized)) return true;
  for (const alternative of plan.alternatives ?? []) {
    if (normalizedHaystack.includes(alternative.normalized)) return true;
  }
  return false;
}
