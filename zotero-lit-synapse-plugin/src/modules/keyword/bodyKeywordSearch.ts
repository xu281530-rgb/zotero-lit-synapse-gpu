/**
 * Turn inverted-index postings into scored documents with passage evidence.
 *
 * 这一层是「chunk 级命中」到「文献级一行结果」的唯一转换点，也是唯一做精确校验
 * 的地方。三件事按顺序发生，顺序本身就是设计：
 *
 *   1. 取 postings 并按 (字段, 段落) 求交 —— 只有同一段里同时含有该词全部
 *      2-gram 的段落才成为候选；
 *   2. 对「无法由索引证明相邻」的词（3 字以上中文、多词短语、混合脚本），
 *      用已存的段落原文做子串校验，剔掉假命中；
 *   3. 按 BM25F 打分，跨字段累加词频后再饱和，每篇只输出一行，附带得分最高的
 *      若干段落作为证据。
 *
 * 第 2 步之所以「免费」，是因为段落原文本来就和向量一起存着（embeddings.chunk_text）。
 * 实测：省掉它会带来 6.30% 误召回；做了它是 0.00%，而且因为进入打分的段落更少，
 * 反而比不校验更快（0.86ms vs 1.07ms / 查询）。
 */

import {
  BM25_FIELDS,
  DEFAULT_FIELD_PARAMETERS,
  DEFAULT_K1,
  keywordCoverage,
  scoreDocument,
  type Bm25Field,
  type CorpusStatistics,
  type FieldFrequencies,
  type FieldLengths,
  type FieldParameters,
  type TermContribution,
} from "./bm25f";
import {
  KeywordIndexStore,
  type KeywordFieldLengths,
  type KeywordFieldName,
  type Posting,
} from "./keywordIndexStore";
import { planQueryTerm, type QueryPlan } from "./scientificTokenizer";

declare let ztoolkit: ZToolkit;

/** A keyword plus how much the ranking may trust it, as the caller supplied it. */
export interface KeywordProbe {
  text: string;
  weight: number;
}

/** Where the verification text and the evidence snippets come from. */
export interface KeywordEvidenceResolver {
  /**
   * Stored chunk texts, keyed `${itemKey}:${chunkId}`.
   *
   * Batched over items on purpose: verification touches many passages across
   * few documents, so one query per passage would dominate the search.
   */
  chunkTexts(
    libraryID: number,
    pairs: Array<{ itemKey: string; chunkId: number }>,
  ): Promise<Map<string, string>>;
  /**
   * Metadata field text, for verifying a metadata-field hit.
   *
   * Keyed by field name so a new field cannot be silently skipped: verification
   * that cannot read a field drops the hit, so a missing key would look like a
   * false positive rather than an omission.
   */
  metadataTexts(
    libraryID: number,
    itemKeys: string[],
  ): Promise<Map<string, Partial<Record<KeywordFieldName, string>>>>;
}

export interface BodyKeywordSearchOptions {
  libraryID: number;
  probes: KeywordProbe[];
  /** Restrict to these item keys (the collection scope). Undefined = library. */
  scopeItemKeys?: Set<string>;
  /** Absolute wall-clock deadline. The search degrades rather than overruns. */
  deadlineAt?: number;
  isCancelled?: () => boolean;
  /** Passages reported as evidence per document. */
  maxEvidenceChunks?: number;
  fieldParameters?: Readonly<Record<Bm25Field, FieldParameters>>;
  k1?: number;
  maxPostingRows?: number;
  /**
   * Which indexed fields to draw on.
   *
   * The combined keyword ranker passes `["body"]`, because it scores the metadata
   * fields from the live Zotero item instead — the index only covers documents
   * the user has indexed (26 of 931 here), so taking metadata from it would drop
   * the rest of the library. Left undefined, every indexed field is used, which
   * is what makes this usable on its own when Zotero's own search is unavailable.
   */
  includeFields?: readonly KeywordFieldName[];
}

export interface EvidenceChunk {
  chunkId: number;
  /** Terms of the query this passage carries. */
  matchedKeywords: string[];
  /** Occurrences in this passage, summed over the matched keywords. */
  occurrences: number;
  text?: string;
}

export interface BodyKeywordResult {
  itemKey: string;
  libraryID: number;
  score: number;
  matchedKeywords: string[];
  matchedFields: KeywordFieldName[];
  keywordCoverage: number;
  evidence: EvidenceChunk[];
  /**
   * Per-probe body occurrence counts, summed over this document's passages.
   *
   * Exposed so the combined ranker can fold them into ONE BM25F pass together
   * with the metadata fields, rather than scoring body separately and then
   * having to reconcile two scores on different scales.
   */
  bodyFrequencies: Map<string, number>;
  /** Body length in tokens, as the index recorded it. */
  bodyLength: number;
}

export interface BodyKeywordDiagnostics {
  /** Documents in the keyword index for this library. */
  indexedDocuments: number;
  probesPlanned: number;
  probesUnindexable: number;
  postingsRead: number;
  candidateDocuments: number;
  /** Candidate hits dropped because the text did not really contain the term. */
  rejectedByVerification: number;
  verifiedHits: number;
  truncated: boolean;
  lookupMs: number;
  verifyMs: number;
  scoreMs: number;
  totalMs: number;
}

export interface BodyKeywordOutcome {
  results: BodyKeywordResult[];
  diagnostics: BodyKeywordDiagnostics;
}

/** Default number of passages reported per document. */
const DEFAULT_MAX_EVIDENCE_CHUNKS = 3;

function isExpired(deadlineAt?: number): boolean {
  return deadlineAt !== undefined && Date.now() >= deadlineAt;
}

/** `${itemKey}:${chunkId}` — the key both text maps are addressed by. */
function pairKey(itemKey: string, chunkId: number): string {
  return `${itemKey}:${chunkId}`;
}

interface PlannedProbe {
  probe: KeywordProbe;
  plan: QueryPlan;
}

/** One (field, slot) location a probe was found at, before verification. */
interface ProbeHit {
  docId: number;
  field: KeywordFieldName;
  chunkId: number;
  /** Smallest per-term occurrence count, i.e. how often the phrase can occur. */
  tf: number;
}

/**
 * Intersect a plan's per-term postings on (field, slot).
 *
 * Intersecting on the SLOT rather than on the document is what makes a phrase
 * mean something in body text: the terms have to occur in the same passage, not
 * merely in the same paper. And because a slot already encodes the chunk, the
 * same code gives field-level intersection for title/abstract/tags, whose slots
 * carry no chunk of their own.
 */
function intersectPlan(
  plan: QueryPlan,
  byTerm: Map<string, Posting[]>,
): ProbeHit[] {
  if (plan.terms.length === 0) return [];

  const lists = plan.terms.map((term) => byTerm.get(term));
  if (lists.some((list) => list === undefined || list.length === 0)) return [];

  // Start from the shortest list: the intersection can only shrink, so leading
  // with the rarest term keeps the work proportional to the answer.
  const sorted = (lists as Posting[][])
    .slice()
    .sort((a, b) => a.length - b.length);

  let current = new Map<string, ProbeHit>();
  for (const posting of sorted[0]) {
    current.set(`${posting.field}:${posting.slot}`, {
      docId: posting.docId,
      field: posting.field,
      chunkId: posting.chunkId,
      tf: posting.tf,
    });
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const next = new Map<string, ProbeHit>();
    for (const posting of sorted[index]) {
      const key = `${posting.field}:${posting.slot}`;
      const existing = current.get(key);
      if (!existing) continue;
      // The phrase cannot occur more often than its rarest constituent.
      next.set(key, {
        ...existing,
        tf: Math.min(existing.tf, posting.tf),
      });
    }
    current = next;
    if (current.size === 0) break;
  }

  return Array.from(current.values());
}

/**
 * The store's length record IS the scorer's, field for field.
 *
 * Kept as an explicit rebuild rather than a cast so that adding a field to one
 * side and forgetting the other is a compile error instead of a silently
 * unnormalised field.
 */
function toFieldLengths(lengths: KeywordFieldLengths): FieldLengths {
  const out = {} as FieldLengths;
  for (const field of BM25_FIELDS) out[field] = lengths[field] ?? 0;
  return out;
}

/**
 * Search the body-keyword index and score every document it turns up.
 *
 * Returns documents, not passages — one row per paper, with its strongest
 * passages attached as evidence — because that is the unit `hybrid_search`
 * ranks, pages and thresholds, and changing that unit would change every one of
 * those behaviours.
 */
export async function runBodyKeywordSearch(
  store: KeywordIndexStore,
  resolver: KeywordEvidenceResolver,
  options: BodyKeywordSearchOptions,
): Promise<BodyKeywordOutcome> {
  const startedAt = Date.now();
  const diagnostics: BodyKeywordDiagnostics = {
    indexedDocuments: 0,
    probesPlanned: 0,
    probesUnindexable: 0,
    postingsRead: 0,
    candidateDocuments: 0,
    rejectedByVerification: 0,
    verifiedHits: 0,
    truncated: false,
    lookupMs: 0,
    verifyMs: 0,
    scoreMs: 0,
    totalMs: 0,
  };

  const live = await store.liveDocuments(options.libraryID);
  diagnostics.indexedDocuments = live.size;
  if (live.size === 0 || options.probes.length === 0) {
    diagnostics.totalMs = Date.now() - startedAt;
    return { results: [], diagnostics };
  }

  const planned: PlannedProbe[] = [];
  for (const probe of options.probes) {
    if (probe.weight <= 0) continue;
    const plan = planQueryTerm(probe.text);
    if (plan.terms.length === 0) {
      diagnostics.probesUnindexable += 1;
      continue;
    }
    planned.push({ probe, plan });
  }
  diagnostics.probesPlanned = planned.length;
  if (planned.length === 0) {
    diagnostics.totalMs = Date.now() - startedAt;
    return { results: [], diagnostics };
  }

  // ---------------------------------------------------------------- lookup
  const lookupStartedAt = Date.now();
  const hitsByProbe = new Map<string, ProbeHit[]>();
  for (const entry of planned) {
    if (options.isCancelled?.() || isExpired(options.deadlineAt)) {
      diagnostics.truncated = true;
      break;
    }
    const found = await store.lookupPlan(
      options.libraryID,
      entry.plan,
      options.maxPostingRows,
    );
    if (found.truncated) diagnostics.truncated = true;
    for (const list of found.byTerm.values()) {
      diagnostics.postingsRead += list.length;
    }

    let hits = intersectPlan(entry.plan, found.byTerm);
    // Scope and liveness are applied here, before any text is fetched, so an
    // out-of-scope document is never read and never verified.
    const allowedFields = options.includeFields;
    hits = hits.filter((hit) => {
      if (allowedFields && !allowedFields.includes(hit.field)) return false;
      const document = live.get(hit.docId);
      if (!document) return false;
      if (
        options.scopeItemKeys &&
        !options.scopeItemKeys.has(document.itemKey)
      ) {
        return false;
      }
      return true;
    });

    // The alternatives of a synonym plan (gamma prime -> γ′) are additional
    // ways to satisfy the SAME probe, so their hits join this probe's set.
    for (const alternative of entry.plan.alternatives ?? []) {
      if (alternative.terms.length === 0) continue;
      const alternativeFound = await store.lookupPlan(
        options.libraryID,
        alternative,
        options.maxPostingRows,
      );
      if (alternativeFound.truncated) diagnostics.truncated = true;
      for (const list of alternativeFound.byTerm.values()) {
        diagnostics.postingsRead += list.length;
      }
      const seen = new Set(
        hits.map((hit) => `${hit.field}:${hit.docId}:${hit.chunkId}`),
      );
      for (const hit of intersectPlan(alternative, alternativeFound.byTerm)) {
        if (allowedFields && !allowedFields.includes(hit.field)) continue;
        const document = live.get(hit.docId);
        if (!document) continue;
        if (
          options.scopeItemKeys &&
          !options.scopeItemKeys.has(document.itemKey)
        ) {
          continue;
        }
        const key = `${hit.field}:${hit.docId}:${hit.chunkId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(hit);
      }
    }

    if (hits.length > 0) hitsByProbe.set(entry.probe.text, hits);
  }
  diagnostics.lookupMs = Date.now() - lookupStartedAt;

  if (hitsByProbe.size === 0) {
    diagnostics.totalMs = Date.now() - startedAt;
    return { results: [], diagnostics };
  }

  // ------------------------------------------------------------ verification
  const verifyStartedAt = Date.now();
  const needsVerification = planned.filter(
    (entry) =>
      entry.plan.requiresVerification && hitsByProbe.has(entry.probe.text),
  );

  if (needsVerification.length > 0) {
    const chunkPairs = new Map<string, { itemKey: string; chunkId: number }>();
    const metadataKeys = new Set<string>();
    for (const entry of needsVerification) {
      for (const hit of hitsByProbe.get(entry.probe.text) ?? []) {
        const document = live.get(hit.docId);
        if (!document) continue;
        if (hit.field === "body") {
          chunkPairs.set(pairKey(document.itemKey, hit.chunkId), {
            itemKey: document.itemKey,
            chunkId: hit.chunkId,
          });
        } else {
          metadataKeys.add(document.itemKey);
        }
      }
    }

    const chunkTexts =
      chunkPairs.size > 0
        ? await resolver.chunkTexts(
            options.libraryID,
            Array.from(chunkPairs.values()),
          )
        : new Map<string, string>();
    const metadataTexts =
      metadataKeys.size > 0
        ? await resolver.metadataTexts(
            options.libraryID,
            Array.from(metadataKeys),
          )
        : new Map<string, Partial<Record<KeywordFieldName, string>>>();

    const { verifyOccurrence } = await import("./scientificTokenizer");
    for (const entry of needsVerification) {
      const hits = hitsByProbe.get(entry.probe.text) ?? [];
      const kept: ProbeHit[] = [];
      for (const hit of hits) {
        const document = live.get(hit.docId);
        if (!document) continue;
        let haystack: string | undefined;
        if (hit.field === "body") {
          haystack = chunkTexts.get(pairKey(document.itemKey, hit.chunkId));
        } else {
          haystack = metadataTexts.get(document.itemKey)?.[hit.field];
        }
        if (haystack === undefined) {
          // The text could not be read. Keeping the hit would assert a phrase
          // the index cannot prove; dropping it loses at most one unverifiable
          // candidate, so the conservative direction is to drop.
          diagnostics.rejectedByVerification += 1;
          continue;
        }
        if (verifyOccurrence(haystack, entry.plan)) {
          kept.push(hit);
        } else {
          diagnostics.rejectedByVerification += 1;
        }
      }
      if (kept.length > 0) hitsByProbe.set(entry.probe.text, kept);
      else hitsByProbe.delete(entry.probe.text);
    }
  }
  diagnostics.verifyMs = Date.now() - verifyStartedAt;

  for (const hits of hitsByProbe.values())
    diagnostics.verifiedHits += hits.length;

  // ------------------------------------------------------------------ score
  const scoreStartedAt = Date.now();
  const storeStats = await store.statistics(options.libraryID);
  /*
   * In THIS path every field is read from the keyword index, so both observation
   * regimes cover exactly the same documents — the indexed ones — and both
   * collection sizes are that count. (The combined ranker is the asymmetric case:
   * there metadata comes from the whole library and only the body comes from the
   * index, so the two sizes differ and must be reported separately.)
   */
  const statistics: CorpusStatistics = {
    documentCount: storeStats.documentCount,
    bodyDocumentCount: storeStats.documentCount,
    fields: {} as CorpusStatistics["fields"],
  };
  for (const field of BM25_FIELDS) {
    statistics.fields[field] = {
      averageLength: storeStats.averageLengths[field] ?? 0,
    };
  }

  /**
   * Per-probe document frequency, counted AFTER verification.
   *
   * Counting before would inflate df with documents that only satisfied the
   * bigram conjunction, which lowers idf and quietly makes a precise term look
   * common. Counting here costs nothing, because the verified hits are already
   * in hand.
   */
  const documentFrequency = new Map<string, number>();
  const bodyDocumentFrequency = new Map<string, number>();
  for (const [probeText, hits] of hitsByProbe) {
    // Split by regime, because IDF is applied per regime: a metadata hit and a
    // body hit are evidence about different fields even when they land in the
    // same document, and pooling them would let one regime's count weight the
    // other's saturation.
    const metadataDocuments = new Set<number>();
    const bodyDocuments = new Set<number>();
    for (const hit of hits) {
      if (hit.field === "body") bodyDocuments.add(hit.docId);
      else metadataDocuments.add(hit.docId);
    }
    documentFrequency.set(probeText, metadataDocuments.size);
    bodyDocumentFrequency.set(probeText, bodyDocuments.size);
  }

  interface Accumulator {
    itemKey: string;
    lengths: FieldLengths;
    frequencies: Map<string, FieldFrequencies>;
    /** chunkId -> which probes hit it, and how often in total. */
    chunkHits: Map<number, { probes: Set<string>; occurrences: number }>;
  }

  const accumulators = new Map<number, Accumulator>();
  for (const [probeText, hits] of hitsByProbe) {
    for (const hit of hits) {
      const document = live.get(hit.docId);
      if (!document) continue;
      let accumulator = accumulators.get(hit.docId);
      if (!accumulator) {
        accumulator = {
          itemKey: document.itemKey,
          lengths: toFieldLengths(document.lengths),
          frequencies: new Map(),
          chunkHits: new Map(),
        };
        accumulators.set(hit.docId, accumulator);
      }
      const perProbe = accumulator.frequencies.get(probeText) ?? {};
      perProbe[hit.field] = (perProbe[hit.field] ?? 0) + hit.tf;
      accumulator.frequencies.set(probeText, perProbe);

      if (hit.field === "body") {
        const chunk = accumulator.chunkHits.get(hit.chunkId) ?? {
          probes: new Set<string>(),
          occurrences: 0,
        };
        chunk.probes.add(probeText);
        chunk.occurrences += hit.tf;
        accumulator.chunkHits.set(hit.chunkId, chunk);
      }
    }
  }
  diagnostics.candidateDocuments = accumulators.size;

  const probeWeights = new Map(
    planned.map((entry) => [entry.probe.text, entry.probe.weight]),
  );
  const maxEvidence = options.maxEvidenceChunks ?? DEFAULT_MAX_EVIDENCE_CHUNKS;

  const results: BodyKeywordResult[] = [];
  for (const accumulator of accumulators.values()) {
    const contributions: TermContribution[] = [];
    for (const [probeText, frequencies] of accumulator.frequencies) {
      contributions.push({
        term: probeText,
        documentFrequency: documentFrequency.get(probeText) ?? 0,
        bodyDocumentFrequency: bodyDocumentFrequency.get(probeText) ?? 0,
        frequencies,
        weight: probeWeights.get(probeText) ?? 1,
      });
    }
    const scored = scoreDocument({
      contributions,
      lengths: accumulator.lengths,
      statistics,
      fieldParameters: options.fieldParameters ?? DEFAULT_FIELD_PARAMETERS,
      k1: options.k1 ?? DEFAULT_K1,
    });
    if (scored.score <= 0) continue;

    const evidence: EvidenceChunk[] = Array.from(
      accumulator.chunkHits.entries(),
    )
      .map(([chunkId, hit]) => ({
        chunkId,
        matchedKeywords: Array.from(hit.probes),
        occurrences: hit.occurrences,
      }))
      // Breadth of matched probes first, then density: a passage covering three
      // of the query's terms is better evidence than one repeating a single term.
      .sort((a, b) => {
        const coverage = b.matchedKeywords.length - a.matchedKeywords.length;
        if (coverage !== 0) return coverage;
        const density = b.occurrences - a.occurrences;
        if (density !== 0) return density;
        return a.chunkId - b.chunkId;
      })
      .slice(0, maxEvidence);

    const bodyFrequencies = new Map<string, number>();
    for (const [probeText, frequencies] of accumulator.frequencies) {
      const count = frequencies.body ?? 0;
      if (count > 0) bodyFrequencies.set(probeText, count);
    }

    results.push({
      itemKey: accumulator.itemKey,
      libraryID: options.libraryID,
      score: scored.score,
      bodyFrequencies,
      bodyLength: accumulator.lengths.body,
      matchedKeywords: scored.matchedTerms,
      matchedFields: scored.matchedFields as KeywordFieldName[],
      keywordCoverage: keywordCoverage(
        scored.matchedTerms.length,
        planned.length,
      ),
      evidence,
    });
  }

  results.sort((a, b) => {
    const byScore = b.score - a.score;
    if (byScore !== 0) return byScore;
    const byCoverage = b.matchedKeywords.length - a.matchedKeywords.length;
    if (byCoverage !== 0) return byCoverage;
    return a.itemKey.localeCompare(b.itemKey);
  });

  // Evidence text is attached only for what is actually being returned, so a
  // long candidate list never turns into a long list of passage reads.
  const evidencePairs: Array<{ itemKey: string; chunkId: number }> = [];
  for (const result of results) {
    for (const chunk of result.evidence) {
      evidencePairs.push({ itemKey: result.itemKey, chunkId: chunk.chunkId });
    }
  }
  if (evidencePairs.length > 0) {
    try {
      const texts = await resolver.chunkTexts(options.libraryID, evidencePairs);
      for (const result of results) {
        for (const chunk of result.evidence) {
          chunk.text = texts.get(pairKey(result.itemKey, chunk.chunkId));
        }
      }
    } catch (error) {
      // Evidence text is a convenience; a ranking without snippets is still a
      // correct ranking, so this must never fail the search.
      ztoolkit?.log?.(
        `[BodyKeyword] evidence text unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warn",
      );
    }
  }

  diagnostics.scoreMs = Date.now() - scoreStartedAt;
  diagnostics.totalMs = Date.now() - startedAt;
  return { results, diagnostics };
}

/** Fields BM25F knows about, re-exported so callers need one import. */
export { BM25_FIELDS };
