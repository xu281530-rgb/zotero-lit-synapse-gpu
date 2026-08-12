import {
  type KeywordSearchItem,
  type LexicalCandidate,
  type LexicalKeyword,
  rankLexicalCandidates,
} from "./hybridSearch";

declare let ztoolkit: ZToolkit;

/**
 * Hard cap on candidate items pulled into memory for one lexical pass. A
 * bilingual keyword set can select a large slice of a big library, and loading
 * every hit is what used to blow the hybrid deadline.
 */
export const MAX_LEXICAL_CANDIDATES = 4000;
/** Items loaded per chunk before yielding to the main thread. */
const CANDIDATE_CHUNK_SIZE = 200;

export interface LexicalSearchOptions {
  keywords: LexicalKeyword[];
  libraryID: number;
  candidateK: number;
  maxCandidates?: number;
  /** Absolute wall-clock deadline; the scan degrades instead of overrunning. */
  deadlineAt?: number;
  isCancelled?: () => boolean;
}

export interface LexicalSearchDiagnostics {
  strategy: "union" | "per-keyword";
  candidateIDs: number;
  scannedItems: number;
  truncated: boolean;
  /**
   * Whether the over-cap candidate set was reduced by keyword coverage rather
   * than by taking whatever the database returned first.
   */
  prioritized: boolean;
  searchMs: number;
  scanMs: number;
  rankMs: number;
  totalMs: number;
  failedKeywords: string[];
}

export interface LexicalSearchOutcome {
  items: KeywordSearchItem[];
  diagnostics: LexicalSearchDiagnostics;
}

/** Metadata fields the ranker scores, read once per candidate item. */
const CANDIDATE_FIELDS = [
  "title",
  "abstractNote",
  "publicationTitle",
  "extra",
] as const;

function safeField(item: any, field: string): string {
  try {
    const value = item.getField(field);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function isExpired(deadlineAt?: number): boolean {
  return deadlineAt !== undefined && Date.now() >= deadlineAt;
}

/**
 * Select candidate item IDs for every keyword with a single Zotero search.
 *
 * `joinMode any` turns the per-keyword conditions into one OR-ed query, so K
 * keywords cost one SQL round trip instead of K full search pipelines. If a
 * Zotero build rejects that shape, the per-keyword fallback still only asks for
 * IDs, which is far cheaper than the previous K x search_library calls.
 */
async function findCandidateIDs(
  keywords: LexicalKeyword[],
  libraryID: number,
): Promise<{
  ids: number[];
  strategy: "union" | "per-keyword";
  failedKeywords: string[];
}> {
  try {
    const search = new Zotero.Search();
    (search as any).libraryID = libraryID;
    search.addCondition("joinMode", "any");
    for (const keyword of keywords) {
      search.addCondition("field", "contains", keyword.text, false);
      search.addCondition("creator", "contains", keyword.text, false);
      search.addCondition("tag", "contains", keyword.text, false);
    }
    const ids = await search.search();
    return { ids: ids || [], strategy: "union", failedKeywords: [] };
  } catch (error) {
    ztoolkit.log(
      `[LexicalSearch] union search failed, falling back to per-keyword ID probes: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "warn",
    );
  }

  const merged = new Set<number>();
  const failedKeywords: string[] = [];
  const probes = await Promise.all(
    keywords.map(async (keyword) => {
      try {
        const search = new Zotero.Search();
        (search as any).libraryID = libraryID;
        search.addCondition("quicksearch-fields", "contains", keyword.text);
        return { keyword, ids: (await search.search()) || [], failed: false };
      } catch (error) {
        ztoolkit.log(
          `[LexicalSearch] keyword probe failed for "${keyword.text}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warn",
        );
        return { keyword, ids: [] as number[], failed: true };
      }
    }),
  );
  for (const probe of probes) {
    if (probe.failed) failedKeywords.push(probe.keyword.text);
    for (const id of probe.ids) merged.add(id);
  }
  return { ids: Array.from(merged), strategy: "per-keyword", failedKeywords };
}

/**
 * Reduce an over-sized candidate set by how many keywords each item matches.
 *
 * Blindly slicing the union result keeps whatever order the database happened
 * to return — effectively item insertion order — so a paper matching ten of the
 * twelve keywords is dropped simply for being added to the library late, and it
 * never reaches the scorer at all. Here every keyword gets one ID-only probe
 * (no item loads, no field reads), items are ordered by summed keyword weight,
 * and only then is the cap applied. Items matching more of the query survive.
 *
 * This only runs when the cap is actually exceeded, so the normal path costs
 * nothing extra, and it never widens the candidate pool beyond `ids`.
 */
async function prioritizeCandidateIDs(
  ids: number[],
  keywords: LexicalKeyword[],
  libraryID: number,
  maxCandidates: number,
  deadlineAt?: number,
  isCancelled?: () => boolean,
): Promise<{ ids: number[]; prioritized: boolean }> {
  if (ids.length <= maxCandidates) {
    return { ids, prioritized: false };
  }
  if (isCancelled?.() || isExpired(deadlineAt)) {
    return { ids: ids.slice(0, maxCandidates), prioritized: false };
  }

  const allowed = new Set(ids);
  const scores = new Map<number, number>();
  let anyProbeSucceeded = false;

  // Same condition shape as the union query, so every union member is
  // reachable by at least one probe and no item is scored 0 by construction.
  const probes = await Promise.all(
    keywords.map(async (keyword) => {
      try {
        const search = new Zotero.Search();
        (search as any).libraryID = libraryID;
        search.addCondition("joinMode", "any");
        search.addCondition("field", "contains", keyword.text, false);
        search.addCondition("creator", "contains", keyword.text, false);
        search.addCondition("tag", "contains", keyword.text, false);
        return { keyword, ids: (await search.search()) || [], failed: false };
      } catch (error) {
        ztoolkit.log(
          `[LexicalSearch] coverage probe failed for "${keyword.text}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warn",
        );
        return { keyword, ids: [] as number[], failed: true };
      }
    }),
  );

  for (const probe of probes) {
    if (probe.failed) continue;
    anyProbeSucceeded = true;
    for (const id of probe.ids) {
      if (!allowed.has(id)) continue;
      scores.set(id, (scores.get(id) || 0) + probe.keyword.weight);
    }
  }

  if (!anyProbeSucceeded) {
    // No usable coverage signal; fall back to the previous behaviour rather
    // than pretending the truncation was informed.
    return { ids: ids.slice(0, maxCandidates), prioritized: false };
  }

  // Stable: equal coverage keeps the original database order.
  const order = new Map<number, number>();
  ids.forEach((id, index) => order.set(id, index));
  const ranked = [...ids].sort((a, b) => {
    const scoreDifference = (scores.get(b) || 0) - (scores.get(a) || 0);
    if (scoreDifference !== 0) return scoreDifference;
    return (order.get(a) || 0) - (order.get(b) || 0);
  });

  return { ids: ranked.slice(0, maxCandidates), prioritized: true };
}

/**
 * Rank a library against every keyword in one traversal.
 *
 * The previous implementation issued one full `search_library` call per
 * keyword, so a 16-keyword bilingual query ran 16 searches, 16 item loads and
 * 16 formatting passes - routinely past the hybrid deadline, which silently
 * degraded hybrid to semantic-only. Here candidates are selected once, their
 * metadata is read once, and all keywords are matched during that single pass.
 */
export async function runLexicalSearch(
  options: LexicalSearchOptions,
): Promise<LexicalSearchOutcome> {
  const startedAt = Date.now();
  const {
    keywords,
    libraryID,
    candidateK,
    maxCandidates = MAX_LEXICAL_CANDIDATES,
    deadlineAt,
    isCancelled,
  } = options;

  if (keywords.length === 0) {
    return {
      items: [],
      diagnostics: {
        strategy: "union",
        candidateIDs: 0,
        scannedItems: 0,
        truncated: false,
        prioritized: false,
        searchMs: 0,
        scanMs: 0,
        rankMs: 0,
        totalMs: Date.now() - startedAt,
        failedKeywords: [],
      },
    };
  }

  const searchStartedAt = Date.now();
  const { ids, strategy, failedKeywords } = await findCandidateIDs(
    keywords,
    libraryID,
  );
  const searchMs = Date.now() - searchStartedAt;

  let truncated = false;
  let prioritized = false;
  let candidateIDs = ids;
  if (candidateIDs.length > maxCandidates) {
    truncated = true;
    const reduced = await prioritizeCandidateIDs(
      candidateIDs,
      keywords,
      libraryID,
      maxCandidates,
      deadlineAt,
      isCancelled,
    );
    candidateIDs = reduced.ids;
    prioritized = reduced.prioritized;
  }

  const scanStartedAt = Date.now();
  const candidates: LexicalCandidate[] = [];
  for (
    let offset = 0;
    offset < candidateIDs.length;
    offset += CANDIDATE_CHUNK_SIZE
  ) {
    if (isCancelled?.() || isExpired(deadlineAt)) {
      truncated = true;
      break;
    }
    const chunk = candidateIDs.slice(offset, offset + CANDIDATE_CHUNK_SIZE);
    const items = await Zotero.Items.getAsync(chunk);
    for (const item of items as any[]) {
      try {
        if (!item?.isRegularItem?.()) continue;
        if (item.deleted) continue;

        const fields: Record<string, string> = {};
        for (const field of CANDIDATE_FIELDS) {
          const value = safeField(item, field);
          if (value) fields[field] = value;
        }

        let creators = "";
        try {
          creators = item
            .getCreators()
            .map((creator: any) =>
              `${creator.firstName || ""} ${creator.lastName || ""}`.trim(),
            )
            .filter(Boolean)
            .join(", ");
        } catch {
          creators = "";
        }
        if (creators) fields.creator = creators;

        let tags: string[] = [];
        try {
          tags = item.getTags().map((tag: any) => tag.tag);
        } catch {
          tags = [];
        }
        if (tags.length > 0) fields.tags = tags.join(", ");

        candidates.push({
          key: item.key,
          libraryID: item.libraryID ?? libraryID,
          title: fields.title || "",
          fields,
          metadata: {
            itemType: item.itemType,
            creators,
            date: safeField(item, "date").match(/\d{4}/)?.[0] || "",
            publicationTitle: fields.publicationTitle || "",
            DOI: safeField(item, "DOI"),
          },
        });
      } catch (error) {
        ztoolkit.log(
          `[LexicalSearch] skipped candidate: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warn",
        );
      }
    }
    // Yield so a long scan cannot freeze the Zotero UI thread.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const scanMs = Date.now() - scanStartedAt;

  const rankStartedAt = Date.now();
  const items = rankLexicalCandidates(candidates, keywords, { candidateK });
  const rankMs = Date.now() - rankStartedAt;

  return {
    items,
    diagnostics: {
      strategy,
      candidateIDs: ids.length,
      scannedItems: candidates.length,
      truncated,
      prioritized,
      searchMs,
      scanMs,
      rankMs,
      totalMs: Date.now() - startedAt,
      failedKeywords,
    },
  };
}
