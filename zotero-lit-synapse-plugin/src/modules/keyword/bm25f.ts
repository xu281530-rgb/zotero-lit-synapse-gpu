/**
 * BM25F scoring for the keyword branch.
 *
 * BM25F 和「先按字段算分再加权求和」不是一回事，区别正是这里唯一值得记住的事：
 * 词频先跨字段累加、再做一次饱和，所以
 *
 *     标题命中一次 + 摘要命中一次   >   摘要命中两次
 *
 * 而不是让某个长字段靠反复出现同一个词把分数堆上去。如果先对每个字段分别做
 * 饱和再相加，一个词在六个字段各出现一次就会拿到六份接近上限的分数，那就退化
 * 成了「字段数计数器」。
 *
 * 每个字段有独立的 b_f 和独立的 avgdl_f，这是本插件必须自己实现 BM25F 的直接
 * 原因：SQLite 的 FTS5 在此环境不可用（`no such module: fts5`），而即使可用，
 * 它的 bm25() 也只做全表一个长度归一化，给不了「标题按标题的平均长度归一化、
 * 正文按正文的平均长度归一化」。
 */

/**
 * The fields a document is scored over.
 *
 * The first four are the ones the feature is specified in terms of. The last
 * three exist for continuity rather than ambition: the ranker being replaced
 * already scored publication title, creators and Extra, so leaving them out
 * would silently drop every document that currently matches only there — a
 * regression dressed up as a simplification.
 */
export type Bm25Field =
  | "title"
  | "abstract"
  | "tags"
  | "body"
  | "publicationTitle"
  | "creator"
  | "extra";

export const BM25_FIELDS: readonly Bm25Field[] = [
  "title",
  "abstract",
  "tags",
  "body",
  "publicationTitle",
  "creator",
  "extra",
];

/**
 * Which collection a field's evidence was observed in.
 *
 * This exists because IDF is only meaningful when N and df are counted over the
 * SAME set of documents whose contents are known. The metadata fields are read
 * from the live Zotero items, so every document in the library is observed. The
 * body field is read from the keyword index, which covers only what the user has
 * indexed — 26 of 931 documents here — and says nothing about the rest.
 *
 * Pooling the two and scoring the sum against the library count was the defect
 * this replaces: a term found in 8 indexed bodies and no metadata was scored as
 * df=8 against N=931, which asserts that the 905 bodies nobody has read do NOT
 * contain it. Measured on the real library, that inflated IDF by 3.76x to 4.39x.
 */
export type Bm25Regime = "metadata" | "body";

export const FIELD_REGIME: Readonly<Record<Bm25Field, Bm25Regime>> = {
  title: "metadata",
  abstract: "metadata",
  tags: "metadata",
  body: "body",
  publicationTitle: "metadata",
  creator: "metadata",
  extra: "metadata",
};

export const METADATA_REGIME_FIELDS: readonly Bm25Field[] = BM25_FIELDS.filter(
  (field) => FIELD_REGIME[field] === "metadata",
);

export const BODY_REGIME_FIELDS: readonly Bm25Field[] = BM25_FIELDS.filter(
  (field) => FIELD_REGIME[field] === "body",
);

/**
 * Zotero's field names, mapped to the fields this scorer knows.
 *
 * `abstractNote` is Zotero's name for the abstract; the rest already agree. Kept
 * here rather than beside the ranker so that the statistics provider and the
 * ranker cannot drift apart about what counts as which field.
 */
export const METADATA_FIELD_MAP: Readonly<Record<string, Bm25Field>> = {
  title: "title",
  abstractNote: "abstract",
  tags: "tags",
  publicationTitle: "publicationTitle",
  creator: "creator",
  extra: "extra",
};

export interface FieldParameters {
  /**
   * Field weight. Relative magnitudes are what matter, not absolute values.
   *
   * Chosen so a title hit dominates, an abstract hit is strong, a body hit is
   * close behind the abstract, and a tag hit supports without deciding — which
   * is the ordering the feature was specified with.
   */
  boost: number;
  /**
   * Length normalisation strength, 0..1.
   *
   * 0 ignores length entirely, 1 divides fully by relative length. Short fields
   * take a low value: a six-word title is not "concise" in a way that should
   * earn a bonus, it is simply what titles are. Running text takes the classic
   * 0.75, where a term appearing in a short passage genuinely is more central
   * to it than the same term buried in a long one.
   */
  b: number;
}

/**
 * Boosts deliberately reuse the numbers the previous ranker used, so that a
 * metadata-only match keeps the same relative shape it had before BM25F existed.
 * `body` is the one new entry: close behind the abstract, clearly below the
 * title, which is the ordering the feature was specified with.
 *
 * The `b` values are new, because the old ranker had no length normalisation at
 * all. Short, curated fields take a low value — a six-word title is not
 * "concise" in a way that deserves a bonus, it is simply what titles are —
 * while running text takes the classic 0.75.
 */
export const DEFAULT_FIELD_PARAMETERS: Readonly<
  Record<Bm25Field, FieldParameters>
> = {
  title: { boost: 3, b: 0.5 },
  abstract: { boost: 1.6, b: 0.75 },
  body: { boost: 1.4, b: 0.75 },
  publicationTitle: { boost: 1.2, b: 0.4 },
  creator: { boost: 1.2, b: 0.4 },
  tags: { boost: 1.1, b: 0.4 },
  extra: { boost: 0.4, b: 0.4 },
};

/**
 * Term-frequency saturation. Above this, more occurrences add almost nothing.
 *
 * The standard 1.2. Kept low on purpose: in a research library the difference
 * between "mentions the alloy once" and "is about the alloy" is real but it is
 * not linear in the word count, and a paper that names a grade forty times in
 * its tables must not outrank the paper that studies it.
 */
export const DEFAULT_K1 = 1.2;

/** Per-field corpus statistics the normalisation needs. */
export interface FieldStatistics {
  /** Mean length of this field over the indexed documents, in tokens. */
  averageLength: number;
}

export interface CorpusStatistics {
  /**
   * Documents observed in the METADATA regime.
   *
   * The whole library, or the collection scope when one is applied — whichever
   * set the metadata document frequencies were counted over.
   */
  documentCount: number;
  /**
   * Documents observed in the BODY regime, i.e. those with a body-keyword index.
   *
   * Absent or zero means no body corpus exists, and body evidence then cannot be
   * scored at all: there is no collection to measure its rarity against.
   */
  bodyDocumentCount?: number;
  fields: Record<Bm25Field, FieldStatistics>;
}

/** One document's field lengths, in tokens. */
export type FieldLengths = Record<Bm25Field, number>;

/** One document's occurrence counts for one term, per field. */
export type FieldFrequencies = Partial<Record<Bm25Field, number>>;

/**
 * Inverse document frequency, Robertson/Sparck-Jones form with the +0.5 guards.
 *
 * `Math.max(0, …)` matters: without it a term occurring in more than half the
 * corpus gets a NEGATIVE idf, and a document would be punished for containing
 * a common word — which shows up as broad queries ranking sparse records above
 * rich ones.
 */
export function inverseDocumentFrequency(
  documentCount: number,
  documentFrequency: number,
): number {
  if (documentCount <= 0) return 0;
  const clamped = Math.min(Math.max(documentFrequency, 0), documentCount);
  const raw = Math.log(1 + (documentCount - clamped + 0.5) / (clamped + 0.5));
  return raw > 0 ? raw : 0;
}

/**
 * The cross-field weighted frequency BM25F calls w̃.
 *
 * Each field's raw count is divided by that field's own relative length before
 * anything is added up, which is the "independent length normalisation" the
 * design calls for.
 */
export function weightedFrequency(params: {
  frequencies: FieldFrequencies;
  lengths: FieldLengths;
  statistics: CorpusStatistics;
  fieldParameters?: Readonly<Record<Bm25Field, FieldParameters>>;
  /**
   * Restrict the accumulation to these fields. Defaults to all of them.
   *
   * Used to accumulate one regime at a time: fields whose df was counted in
   * different collections cannot share a saturation, because the saturated value
   * is what a single IDF gets multiplied by.
   */
  fields?: readonly Bm25Field[];
}): number {
  const fieldParameters = params.fieldParameters ?? DEFAULT_FIELD_PARAMETERS;
  let total = 0;
  for (const field of params.fields ?? BM25_FIELDS) {
    const frequency = params.frequencies[field] ?? 0;
    if (frequency <= 0) continue;
    const { boost, b } = fieldParameters[field];
    if (boost <= 0) continue;
    const averageLength = params.statistics.fields[field]?.averageLength ?? 0;
    const length = params.lengths[field] ?? 0;
    // With no corpus average yet — the first document indexed — length carries
    // no information, so normalising by it would be inventing a signal.
    const ratio = averageLength > 0 && length > 0 ? length / averageLength : 1;
    const normalization = 1 - b + b * ratio;
    total += (boost * frequency) / (normalization > 0 ? normalization : 1);
  }
  return total;
}

/** One term's contribution to a document's score. */
export interface TermContribution {
  term: string;
  /**
   * Documents whose METADATA contains the term, out of
   * {@link CorpusStatistics.documentCount}.
   */
  documentFrequency: number;
  /**
   * Documents whose BODY contains the term, out of
   * {@link CorpusStatistics.bodyDocumentCount}.
   *
   * Separate from {@link documentFrequency} because the two are counted over
   * different collections. Pooling them forces one of the two to be divided by
   * the other's N.
   */
  bodyDocumentFrequency?: number;
  frequencies: FieldFrequencies;
  /**
   * Caller-supplied trust in the probe itself, mirroring the existing lexical
   * ranker: a curated keyword counts fully, a token guessed from the raw query
   * counts less. Retrieval quality should not depend on whether the caller did
   * its job, but the SCORE should reflect how much the probe can be trusted.
   */
  weight?: number;
}

export interface ScoreDocumentParams {
  contributions: TermContribution[];
  lengths: FieldLengths;
  statistics: CorpusStatistics;
  fieldParameters?: Readonly<Record<Bm25Field, FieldParameters>>;
  k1?: number;
}

export interface DocumentScore {
  score: number;
  /** Terms that contributed anything, for evidence reporting. */
  matchedTerms: string[];
  /** Fields any term landed in, for evidence reporting. */
  matchedFields: Bm25Field[];
}

/**
 * Score one document against every query term.
 *
 * The returned score is unbounded above, exactly like BM25: it is turned into
 * the plugin's 0..1 relevance by a separate saturation step, so that the
 * mapping can be calibrated without touching the ranking itself.
 */
export function scoreDocument(params: ScoreDocumentParams): DocumentScore {
  const k1 = params.k1 ?? DEFAULT_K1;
  const fieldParameters = params.fieldParameters ?? DEFAULT_FIELD_PARAMETERS;
  const matchedTerms: string[] = [];
  const matchedFields = new Set<Bm25Field>();
  let score = 0;

  for (const contribution of params.contributions) {
    const probeWeight = contribution.weight ?? 1;
    if (probeWeight <= 0) continue;

    /*
     * One saturation per observation regime, each multiplied by the IDF of the
     * collection its own document frequency was counted in.
     *
     * Within the metadata regime all six fields still accumulate BEFORE
     * saturating — that is BM25F's defining property, and it is exactly right
     * there, because those six counts come from one collection in which every
     * document was observed. Across regimes the two parts are added instead,
     * because there is no single IDF that could legitimately multiply a sum of
     * evidence drawn from a 931-document collection and a 26-document one.
     *
     * As the user indexes more papers the body collection grows toward the
     * library and idf_body converges on idf_meta, so the split closes itself
     * rather than needing to be revisited.
     */
    let termScore = 0;
    const regimes: Array<{
      fields: readonly Bm25Field[];
      documentCount: number;
      documentFrequency: number;
    }> = [
      {
        fields: METADATA_REGIME_FIELDS,
        documentCount: params.statistics.documentCount,
        documentFrequency: contribution.documentFrequency,
      },
      {
        fields: BODY_REGIME_FIELDS,
        documentCount: params.statistics.bodyDocumentCount ?? 0,
        documentFrequency: contribution.bodyDocumentFrequency ?? 0,
      },
    ];

    for (const regime of regimes) {
      const weighted = weightedFrequency({
        frequencies: contribution.frequencies,
        lengths: params.lengths,
        statistics: params.statistics,
        fieldParameters,
        fields: regime.fields,
      });
      if (weighted <= 0) continue;

      // This document contains the term in this regime, so it is itself one of
      // the documents the frequency counts. A caller that passed 0 has a
      // bookkeeping error, and df=0 would produce a wildly inflated IDF rather
      // than a small one, so the floor is applied here instead of trusted.
      const documentFrequency = Math.max(1, regime.documentFrequency);
      const idf = inverseDocumentFrequency(
        regime.documentCount,
        documentFrequency,
      );
      if (idf <= 0) continue;

      termScore += idf * (weighted / (k1 + weighted));
      for (const field of regime.fields) {
        if ((contribution.frequencies[field] ?? 0) > 0)
          matchedFields.add(field);
      }
    }

    if (termScore <= 0) continue;
    score += probeWeight * termScore;
    matchedTerms.push(contribution.term);
  }

  return {
    score,
    matchedTerms,
    matchedFields: BM25_FIELDS.filter((field) => matchedFields.has(field)),
  };
}

/**
 * Saturation constant mapping the unbounded BM25F score into 0..1.
 *
 * `raw / (raw + K)`: monotone, never reaches 1, and needs no knowledge of the
 * other candidates — the same shape, and the same reasoning, as the lexical
 * normalisation this sits alongside. A "best hit = 1.0" normalisation would make
 * some document score 1.0 for every query, including queries the library has
 * nothing on, and the user's relevance floor could then never reject everything.
 *
 * The VALUE is measured, not chosen. `scripts/calibrate-bm25f-threshold.js`
 * scores this user's real 931-document library with both the old scorer and this
 * one and reports, for each K, how many documents that clear the 0.60 floor
 * today would stop clearing it:
 *
 *   K:      0.5    1    1.5    2    2.5    3    4    5    6    8   10
 *   lost:     0    0      0    0      0    0    0    0    1    4    5
 *   gained: 127  126    104   63     34   19   10    4    1    0    0
 *
 * K=5 is the largest value with no regressions, but it leaves the weakest
 * surviving document at 0.614 — fourteen thousandths above the floor, which is
 * one unlucky query away from becoming a regression. K=4 keeps the same zero
 * regressions with that document at 0.665, and admits ten more documents that
 * were previously retrieved and then dropped for being one keyword short.
 */
export const BM25F_SCORE_SATURATION = 4;

/**
 * Map a raw BM25F score onto the 0..1 relevance every other score here uses.
 */
export function normalizeBm25fScore(
  rawScore: number | undefined,
  saturation = BM25F_SCORE_SATURATION,
): number {
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) return 0;
  if (rawScore <= 0) return 0;
  return rawScore / (rawScore + saturation);
}

/**
 * How many distinct query terms a document matched, as a 0..1 fraction.
 *
 * Kept separate from the score so the caller can apply the SAME coverage bonus
 * the existing lexical ranker applies, rather than this module inventing a
 * second, differently-shaped one.
 */
export function keywordCoverage(
  matchedTerms: number,
  totalTerms: number,
): number {
  if (totalTerms <= 0) return 0;
  return Math.min(1, matchedTerms / totalTerms);
}
