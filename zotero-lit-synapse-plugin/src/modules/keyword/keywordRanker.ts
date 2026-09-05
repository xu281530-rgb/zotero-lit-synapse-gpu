/**
 * The keyword branch's scorer: metadata AND body, in one BM25F pass.
 *
 * 为什么必须这样拼，而不是「全字段都从倒排索引里取」——这是实测出来的，不是设计
 * 偏好：
 *
 *   - 正文索引只覆盖用户真正索引过的文献（当前 26 篇），而 Zotero 库里有 931 篇。
 *     若元数据也只从索引里取，元数据检索会**直接丢掉 905 篇**，这比任何分数漂移
 *     都严重得多。
 *   - 而且 N=26 时 idf 会塌缩：同一个词在 df=3 时，N=26 给 2.04，N=931 给 5.58，
 *     导致没有任何文献能越过 0.60 阈值（实测最高 0.5685）。
 *
 * 所以：
 *   标题/摘要/标签/期刊/作者/Extra —— 仍由现有候选扫描从 Zotero 条目实时取，覆盖全库；
 *   正文                          —— 由倒排索引取，只有已索引文献才有；
 *   两者进入**同一次** BM25F，词频跨字段累加后统一饱和，idf 用全库文献数。
 *
 * 这依然是完整的 BM25F（每字段独立权重 + 独立长度归一化），只是它的正文项来自
 * 索引、元数据项来自条目本身。两条路径对「什么算一次命中」的判定共用
 * {@link countPlanOccurrences}，否则同一个词会因为所在字段不同而价值不同。
 */

import {
  BM25_FIELDS,
  DEFAULT_FIELD_PARAMETERS,
  DEFAULT_K1,
  FIELD_REGIME,
  METADATA_FIELD_MAP,
  keywordCoverage,
  normalizeBm25fScore,
  scoreDocument,
  type Bm25Field,
  type CorpusStatistics,
  type FieldFrequencies,
  type FieldLengths,
  type FieldParameters,
  type TermContribution,
} from "./bm25f";
import {
  countPlanInCounts,
  normalize,
  planQueryTerm,
  tokenCountsOf,
  type QueryPlan,
} from "./scientificTokenizer";
import type { EvidenceChunk, KeywordProbe } from "./bodyKeywordSearch";

/**
 * Re-exported so callers keep one import. The definition lives with the scorer,
 * because the statistics provider and the ranker must agree about which Zotero
 * field is which BM25F field or their averages describe different things.
 */
export { METADATA_FIELD_MAP };

/** One document as the metadata scan produced it. */
export interface MetadataCandidate {
  key: string;
  /** Absent for a document the metadata scan never produced, i.e. body-only. */
  libraryID?: number;
  title?: string;
  /** Raw field text, keyed by the names in {@link METADATA_FIELD_MAP}. */
  fields: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/** Body-side frequencies for one document, keyed by probe text. */
export interface BodyContribution {
  itemKey: string;
  /** Occurrences of each probe across the whole body, summed over passages. */
  frequencies: Map<string, number>;
  /** Total body length in tokens, as the index recorded it. */
  bodyLength: number;
  evidence: EvidenceChunk[];
}

export interface KeywordRankingOptions {
  probes: KeywordProbe[];
  candidates: MetadataCandidate[];
  /** Body-side contributions, keyed by item key. Empty when nothing is indexed. */
  bodyContributions?: Map<string, BodyContribution>;
  /**
   * Documents in the library — the collection the METADATA document frequencies
   * were counted over, and therefore the N their IDF must use.
   *
   * Sound because the metadata candidate scan asks Zotero for every item
   * containing any keyword: a document absent from the pool provably has no
   * metadata hit, so "not in the pool" really does mean "does not contain it".
   */
  libraryDocumentCount: number;
  /**
   * Documents with a body-keyword index — the collection the BODY document
   * frequencies were counted over.
   *
   * Not the library count. The body index covers only what the user indexed, and
   * the bodies it does not cover are UNKNOWN rather than known-absent. Scoring
   * df_body against the library count asserts absence for documents nobody has
   * read, which measured 3.76x to 4.39x too much IDF on real body-only terms.
   */
  bodyDocumentCount?: number;
  /**
   * When a collection scope is applied: documents inside it, and of those, how
   * many have a body index.
   *
   * The frequencies are counted inside the scope, so N has to be the scope too —
   * otherwise the same mismatch reappears at a smaller scale.
   */
  scopeDocumentCount?: number;
  scopeBodyDocumentCount?: number;
  /**
   * Library-wide mean field lengths, for length normalisation.
   *
   * Deliberately NOT derived from the documents being scored. The pool mean moved
   * a document's own score by -15.8% to +4.9% depending on which other documents
   * happened to match, and collapsed normalisation entirely when only one did
   * (the mean was then that document's own length, so the ratio was always 1).
   * The reference has to be a property of the library, not of the query.
   *
   * Scope-independent on purpose: a stable length reference is the point, and a
   * per-collection reference would reintroduce the same drift between scopes.
   */
  averageFieldLengths?: Record<Bm25Field, number>;
  /** Mean body length over indexed documents, from the index's own statistics. */
  averageBodyLength?: number;
  fieldParameters?: Readonly<Record<Bm25Field, FieldParameters>>;
  k1?: number;
  limit?: number;
}

export interface RankedKeywordItem extends Record<string, unknown> {
  key: string;
  libraryID?: number;
  title: string;
  /** Raw BM25F score, unbounded above. */
  relevanceScore: number;
  /** {@link relevanceScore} mapped into 0..1. */
  normalizedScore: number;
  matchedKeywords: string[];
  matchedFields: string[];
  keywordCoverage: number;
  /** Passages that carried a hit, present only for documents with a body hit. */
  bodyEvidence?: EvidenceChunk[];
}

interface PreparedCandidate {
  candidate: MetadataCandidate;
  lengths: FieldLengths;
  /** probe text -> per-field occurrence counts. */
  frequencies: Map<string, FieldFrequencies>;
}

function emptyLengths(): FieldLengths {
  const lengths = {} as FieldLengths;
  for (const field of BM25_FIELDS) lengths[field] = 0;
  return lengths;
}

function totalTokens(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

/** The collection sizes and frequencies one ranking actually used. */
export interface KeywordRankingStatistics {
  /** Documents the metadata frequencies were counted over. */
  documentCount: number;
  /** Documents the body frequencies were counted over. */
  bodyDocumentCount: number;
  /** Probe -> documents with a metadata hit. */
  documentFrequency: Map<string, number>;
  /** Probe -> documents with a body hit. */
  bodyDocumentFrequency: Map<string, number>;
  /** The per-field length references used, for diagnostics. */
  averageLengths: Record<Bm25Field, number>;
}

export interface KeywordRankingOutcome {
  items: RankedKeywordItem[];
  statistics: KeywordRankingStatistics;
}

/**
 * Score every candidate against every probe, metadata and body together.
 *
 * Returns rows shaped like the existing lexical ranker's, so the fusion, the
 * pagination and the relevance floor downstream need no knowledge that the
 * scorer changed. Use {@link rankKeywordCandidatesDetailed} when the collection
 * sizes and frequencies themselves matter — the statistics are the thing most
 * worth asserting about, and they were previously unobservable.
 */
export function rankKeywordCandidates(
  options: KeywordRankingOptions,
): RankedKeywordItem[] {
  return rankKeywordCandidatesDetailed(options).items;
}

export function rankKeywordCandidatesDetailed(
  options: KeywordRankingOptions,
): KeywordRankingOutcome {
  const planned: Array<{ probe: KeywordProbe; plan: QueryPlan }> = [];
  for (const probe of options.probes) {
    if (probe.weight <= 0) continue;
    const plan = planQueryTerm(probe.text);
    if (plan.terms.length === 0) continue;
    planned.push({ probe, plan });
  }
  const emptyStatistics = (): KeywordRankingStatistics => ({
    documentCount: options.scopeDocumentCount ?? options.libraryDocumentCount,
    bodyDocumentCount:
      options.scopeBodyDocumentCount ?? options.bodyDocumentCount ?? 0,
    documentFrequency: new Map(),
    bodyDocumentFrequency: new Map(),
    averageLengths:
      options.averageFieldLengths ?? ({} as Record<Bm25Field, number>),
  });
  if (planned.length === 0) {
    return { items: [], statistics: emptyStatistics() };
  }

  const bodyContributions =
    options.bodyContributions ?? new Map<string, BodyContribution>();

  // ------------------------------------------------------ metadata pass
  const prepared = new Map<string, PreparedCandidate>();
  for (const candidate of options.candidates) {
    const lengths = emptyLengths();
    const frequencies = new Map<string, FieldFrequencies>();
    let matchedAny = false;

    for (const [sourceField, targetField] of Object.entries(
      METADATA_FIELD_MAP,
    )) {
      const text = candidate.fields?.[sourceField];
      if (!text) continue;
      // Tokenised ONCE per field, then reused for every probe. Doing it per
      // probe instead is what made ranking the whole library take 233ms.
      const counts = tokenCountsOf(text);
      const normalizedText = normalize(text);
      lengths[targetField] = totalTokens(counts);
      for (const entry of planned) {
        const count = countPlanInCounts(
          entry.plan,
          counts,
          text,
          normalizedText,
        );
        if (count <= 0) continue;
        const perProbe = frequencies.get(entry.probe.text) ?? {};
        perProbe[targetField] = (perProbe[targetField] ?? 0) + count;
        frequencies.set(entry.probe.text, perProbe);
        matchedAny = true;
      }
    }

    const identity = `${candidate.libraryID ?? "unknown"}:${candidate.key}`;
    if (matchedAny || bodyContributions.has(candidate.key)) {
      prepared.set(identity, { candidate, lengths, frequencies });
    }
  }

  // ------------------------------------------------------------ body pass
  for (const [itemKey, contribution] of bodyContributions) {
    // A document can have body hits without being in the metadata candidate
    // set — that is the whole point of body-keyword retrieval — so it has to be
    // able to enter the ranking here rather than only be enriched here.
    let identity: string | undefined;
    for (const [key, entry] of prepared) {
      if (entry.candidate.key === itemKey) {
        identity = key;
        break;
      }
    }
    let entry = identity ? prepared.get(identity) : undefined;
    if (!entry) {
      const created: PreparedCandidate = {
        candidate: { key: itemKey, fields: {} },
        lengths: emptyLengths(),
        frequencies: new Map(),
      };
      prepared.set(`unknown:${itemKey}`, created);
      entry = created;
    }
    entry.lengths.body = contribution.bodyLength;
    for (const [probeText, count] of contribution.frequencies) {
      if (count <= 0) continue;
      const perProbe = entry.frequencies.get(probeText) ?? {};
      perProbe.body = (perProbe.body ?? 0) + count;
      entry.frequencies.set(probeText, perProbe);
    }
  }

  if (prepared.size === 0) {
    return { items: [], statistics: emptyStatistics() };
  }

  // -------------------------------------------------------------- statistics
  /*
   * Two document frequencies, counted separately, because they are counted over
   * two different collections.
   *
   * df_meta: documents with a hit in any METADATA field, out of the library (or
   *   the scope). Sound because Zotero's candidate query returns every item whose
   *   metadata contains any keyword, so absence from the pool is real absence.
   *
   * df_body: documents with a hit in the BODY field, out of the documents whose
   *   bodies are indexed. The bodies that are NOT indexed are unknown, and must
   *   not be counted as non-containing — that was the defect.
   */
  const documentFrequency = new Map<string, number>();
  const bodyDocumentFrequency = new Map<string, number>();
  for (const entry of prepared.values()) {
    for (const [probeText, frequencies] of entry.frequencies) {
      let metadataHit = false;
      let bodyHit = false;
      for (const field of BM25_FIELDS) {
        if ((frequencies[field] ?? 0) <= 0) continue;
        if (FIELD_REGIME[field] === "body") bodyHit = true;
        else metadataHit = true;
      }
      if (metadataHit) {
        documentFrequency.set(
          probeText,
          (documentFrequency.get(probeText) ?? 0) + 1,
        );
      }
      if (bodyHit) {
        bodyDocumentFrequency.set(
          probeText,
          (bodyDocumentFrequency.get(probeText) ?? 0) + 1,
        );
      }
    }
  }

  /*
   * Collection sizes. A scope narrows the collection the frequencies were counted
   * in, so it narrows N as well; without a scope the collections are the whole
   * library and the whole body index.
   *
   * The `Math.max` floors are not cosmetic: a df can never exceed the collection
   * it was counted in, and if a caller reports a smaller N than the df it just
   * supplied, the arithmetic would say a term occurs in more documents than exist.
   */
  const metadataCollectionSize = Math.max(
    options.scopeDocumentCount ?? options.libraryDocumentCount,
    documentFrequency.size > 0 ? Math.max(...documentFrequency.values()) : 0,
  );
  const bodyCollectionSize = Math.max(
    options.scopeBodyDocumentCount ?? options.bodyDocumentCount ?? 0,
    bodyDocumentFrequency.size > 0
      ? Math.max(...bodyDocumentFrequency.values())
      : 0,
  );

  const statistics: CorpusStatistics = {
    documentCount: metadataCollectionSize,
    bodyDocumentCount: bodyCollectionSize,
    fields: {} as CorpusStatistics["fields"],
  };
  const libraryAverages = options.averageFieldLengths;
  for (const field of BM25_FIELDS) {
    // Metadata averages are a library-wide property supplied by the caller; the
    // body average comes from the keyword index, where it is exact over every
    // indexed document. Neither is derived from the documents being scored.
    statistics.fields[field] = {
      averageLength:
        field === "body"
          ? (options.averageBodyLength ?? 0)
          : (libraryAverages?.[field] ?? 0),
    };
  }

  // ------------------------------------------------------------------ score
  const ranked: RankedKeywordItem[] = [];
  for (const entry of prepared.values()) {
    const contributions: TermContribution[] = [];
    for (const [probeText, frequencies] of entry.frequencies) {
      const probe = planned.find((item) => item.probe.text === probeText);
      contributions.push({
        term: probeText,
        documentFrequency: documentFrequency.get(probeText) ?? 0,
        bodyDocumentFrequency: bodyDocumentFrequency.get(probeText) ?? 0,
        frequencies,
        weight: probe?.probe.weight ?? 1,
      });
    }
    if (contributions.length === 0) continue;

    const scored = scoreDocument({
      contributions,
      lengths: entry.lengths,
      statistics,
      fieldParameters: options.fieldParameters ?? DEFAULT_FIELD_PARAMETERS,
      k1: options.k1 ?? DEFAULT_K1,
    });
    if (scored.score <= 0) continue;

    const evidence = bodyContributions.get(entry.candidate.key)?.evidence;
    ranked.push({
      ...(entry.candidate.metadata ?? {}),
      key: entry.candidate.key,
      libraryID: entry.candidate.libraryID,
      title: entry.candidate.title ?? "",
      relevanceScore: scored.score,
      normalizedScore: normalizeBm25fScore(scored.score),
      matchedKeywords: scored.matchedTerms,
      matchedFields: scored.matchedFields,
      keywordCoverage: keywordCoverage(
        scored.matchedTerms.length,
        planned.length,
      ),
      ...(evidence && evidence.length > 0 ? { bodyEvidence: evidence } : {}),
    });
  }

  ranked.sort((a, b) => {
    const byScore = b.relevanceScore - a.relevanceScore;
    if (byScore !== 0) return byScore;
    const byCoverage = b.matchedKeywords.length - a.matchedKeywords.length;
    if (byCoverage !== 0) return byCoverage;
    return a.key.localeCompare(b.key);
  });

  return {
    items:
      options.limit === undefined ? ranked : ranked.slice(0, options.limit),
    statistics: {
      documentCount: statistics.documentCount,
      bodyDocumentCount: statistics.bodyDocumentCount ?? 0,
      documentFrequency,
      bodyDocumentFrequency,
      averageLengths: Object.fromEntries(
        BM25_FIELDS.map((field) => [
          field,
          statistics.fields[field].averageLength,
        ]),
      ) as Record<Bm25Field, number>,
    },
  };
}
