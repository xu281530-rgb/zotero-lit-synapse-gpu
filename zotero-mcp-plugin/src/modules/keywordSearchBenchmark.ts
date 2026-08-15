/**
 * Benchmark for the keyword (metadata) branch of hybrid retrieval.
 *
 * The cost of a keyword search is dominated by how many CANDIDATE ITEMS the
 * probes select, not by the probes themselves: `runLexicalSearch` issues one
 * OR-ed Zotero search and then loads, reads and ranks the metadata of every
 * item it returned. Timing one narrow term therefore measures almost nothing —
 * it is the fast path by construction.
 *
 * So the probes are derived from the library being measured. Terms are ranked
 * by how many documents contain them, and three profiles are cut from that
 * ranking:
 *
 * - `broad`   the most common terms — close to "select the whole library"
 * - `typical` mid-frequency domain terms — what a real query looks like
 * - `narrow`  rare terms — the cheap end, kept for contrast
 *
 * The recommendation is taken from the slowest profile, because the timeout has
 * to survive the worst query the user might actually run.
 */

import {
  KEYWORD_BENCHMARK_RUNS,
  summarizeDurations,
  type TimingSample,
} from "./semantic/vectorScanBenchmark";

declare const Zotero: any;

export type KeywordProfileName = "broad" | "typical" | "narrow";

export interface KeywordProfile {
  name: KeywordProfileName;
  keywords: string[];
}

export interface KeywordProfileTiming extends TimingSample {
  name: KeywordProfileName;
  keywords: string[];
  /** Candidate items the probes selected, from the last run's diagnostics. */
  candidateItems: number;
}

export interface KeywordSearchBenchmarkResult {
  runsPerProfile: number;
  profiles: KeywordProfileTiming[];
  /** Worst observed timing across all profiles — what the timeout must cover. */
  worst: TimingSample;
  /** Name of the profile the worst timing came from. */
  worstProfile: KeywordProfileName;
  /** Items whose metadata was sampled to build the profiles. */
  sampledItems: number;
}

/** How many items to read when measuring term frequencies. */
const PROFILE_SAMPLE_LIMIT = 4000;
/** Probe counts per profile; the broad one uses the full accepted maximum. */
const PROFILE_SIZES: Record<KeywordProfileName, number> = {
  broad: 16,
  typical: 12,
  narrow: 8,
};

/**
 * Split text into probe candidates.
 *
 * Latin runs of 4+ characters, plus CJK bigrams — the lexical branch matches
 * substrings, so a bigram like "材料" is exactly the shape of probe a Chinese
 * query contributes, while single characters match so indiscriminately that
 * they stop being representative of anything.
 */
export function tokenizeForProfiles(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  const latin = text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g);
  if (latin) tokens.push(...latin);
  const cjkRuns = text.match(/[一-鿿]{2,}/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      for (let index = 0; index + 2 <= run.length; index += 1) {
        tokens.push(run.slice(index, index + 2));
      }
    }
  }
  return tokens;
}

/**
 * Cut three probe sets out of a document-frequency ranking.
 *
 * Exported separately from the Zotero sampling so the selection rules can be
 * tested without a library.
 */
export function buildKeywordProfiles(
  documentFrequency: Map<string, number>,
  sampledItems: number,
): KeywordProfile[] {
  const ranked = Array.from(documentFrequency.entries())
    .filter(([term, count]) => term.length > 0 && count > 0)
    // Ties broken by term so the same library always yields the same probes;
    // a benchmark that silently changed its own workload between runs would be
    // useless for comparing before and after.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  if (ranked.length === 0) return [];

  const broad = ranked.slice(0, PROFILE_SIZES.broad).map(([term]) => term);

  // Mid-band: common enough to select a real working set, rare enough not to be
  // the whole library. Falls back to the middle of the ranking when the
  // frequency bands are too sparse to apply.
  const upperBound = Math.max(2, Math.floor(sampledItems * 0.05));
  const lowerBound = Math.max(2, Math.floor(sampledItems * 0.005));
  let typicalPool = ranked.filter(
    ([, count]) => count <= upperBound && count >= lowerBound,
  );
  if (typicalPool.length < PROFILE_SIZES.typical) {
    const middle = Math.floor(ranked.length / 2);
    typicalPool = ranked.slice(
      Math.max(0, middle - PROFILE_SIZES.typical),
      middle + PROFILE_SIZES.typical,
    );
  }
  const typical = typicalPool
    .slice(0, PROFILE_SIZES.typical)
    .map(([term]) => term);

  const narrow = ranked
    .slice(-PROFILE_SIZES.narrow)
    .map(([term]) => term)
    .reverse();

  const profiles: KeywordProfile[] = [
    { name: "broad", keywords: broad },
    { name: "typical", keywords: typical },
    { name: "narrow", keywords: narrow },
  ];
  return profiles.filter((profile) => profile.keywords.length > 0);
}

/**
 * Read titles, tags and publication names from the library to rank terms by
 * document frequency.
 */
export async function sampleLibraryTerms(libraryID: number): Promise<{
  documentFrequency: Map<string, number>;
  sampledItems: number;
}> {
  const documentFrequency = new Map<string, number>();
  let sampledItems = 0;

  const itemIDs: number[] = (await Zotero.Items.getAll(libraryID, true)) ?? [];
  const ids = Array.isArray(itemIDs)
    ? itemIDs.map((entry: any) =>
        typeof entry === "number" ? entry : entry?.id,
      )
    : [];

  for (
    let offset = 0;
    offset < ids.length && sampledItems < PROFILE_SAMPLE_LIMIT;
    offset += 200
  ) {
    const chunk = ids.slice(offset, offset + 200).filter(Boolean);
    if (chunk.length === 0) continue;
    const items = await Zotero.Items.getAsync(chunk);
    for (const item of (items as any[]) ?? []) {
      if (sampledItems >= PROFILE_SAMPLE_LIMIT) break;
      try {
        if (!item?.isRegularItem?.()) continue;
        if (item.deleted) continue;
        const parts: string[] = [];
        for (const field of ["title", "publicationTitle"]) {
          try {
            const value = item.getField(field);
            if (typeof value === "string" && value) parts.push(value);
          } catch {
            // A field this item type does not have contributes nothing.
          }
        }
        try {
          for (const tag of item.getTags() ?? []) {
            if (tag?.tag) parts.push(String(tag.tag));
          }
        } catch {
          // Tags are optional.
        }
        sampledItems += 1;
        // Counted once per document: this is document frequency, not term
        // frequency, because candidate-set size is what drives the cost.
        const seen = new Set(tokenizeForProfiles(parts.join(" ")));
        for (const term of seen) {
          documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
        }
      } catch {
        // A single unreadable item must not abort the sampling pass.
      }
    }
    // Yield so sampling cannot freeze the Zotero UI thread.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { documentFrequency, sampledItems };
}

/**
 * Time the keyword branch across all three profiles.
 *
 * `search` is the production lexical search, injected so this stays testable.
 */
export async function runKeywordSearchBenchmark(
  profiles: KeywordProfile[],
  search: (
    keywords: string[],
  ) => Promise<{ candidateItems: number } | undefined | void>,
  sampledItems: number,
  now: () => number = () => globalThis.performance?.now() ?? Date.now(),
): Promise<KeywordSearchBenchmarkResult> {
  const timings: KeywordProfileTiming[] = [];

  for (const profile of profiles) {
    const durationsMs: number[] = [];
    let candidateItems = 0;
    for (let run = 0; run < KEYWORD_BENCHMARK_RUNS; run += 1) {
      const startedAt = now();
      const outcome = await search(profile.keywords);
      durationsMs.push(Math.max(0, now() - startedAt));
      if (outcome && typeof outcome.candidateItems === "number") {
        candidateItems = outcome.candidateItems;
      }
    }
    timings.push({
      name: profile.name,
      keywords: profile.keywords,
      candidateItems,
      ...summarizeDurations(durationsMs),
    });
  }

  if (timings.length === 0) {
    throw new Error(
      "No keyword probes could be derived from this library — index or add items with titles first.",
    );
  }

  // The timeout has to cover the worst query, so the recommendation is driven
  // by the slowest profile rather than by an average across profiles that the
  // user may never run in that mix.
  const worstTiming = timings.reduce((slowest, current) =>
    current.maxMs > slowest.maxMs ? current : slowest,
  );

  return {
    runsPerProfile: KEYWORD_BENCHMARK_RUNS,
    profiles: timings,
    worst: {
      durationsMs: worstTiming.durationsMs,
      minMs: worstTiming.minMs,
      averageMs: worstTiming.averageMs,
      maxMs: worstTiming.maxMs,
    },
    worstProfile: worstTiming.name,
    sampledItems,
  };
}
