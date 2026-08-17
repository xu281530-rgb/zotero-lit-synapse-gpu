import {
  type KeywordSearchItem,
  type LexicalCandidate,
  type LexicalKeyword,
  rankLexicalCandidates,
} from "./hybridSearch";
import {
  keywordSearchGate,
  resolveQueryGraceMs,
  type KeywordSearchGate,
} from "./keywordSearchGate";

declare let ztoolkit: ZToolkit;

/** Items loaded per chunk before yielding to the main thread. */
const CANDIDATE_CHUNK_SIZE = 200;

/**
 * The deadline was reached before a ranking could be produced.
 *
 * Distinct from a truncated scan, which still has real results to return: this
 * means the candidate query itself never came back in time, so there is
 * nothing to rank and nothing partial to salvage.
 */
export class LexicalSearchTimeoutError extends Error {
  readonly elapsedMs: number;

  constructor(elapsedMs: number) {
    super(
      `Keyword search timed out after ${elapsedMs}ms while waiting for ` +
        `Zotero's item query. The request was ended at the deadline and any ` +
        `late result is discarded.`,
    );
    this.name = "LexicalSearchTimeoutError";
    this.elapsedMs = elapsedMs;
  }
}

export function isLexicalSearchTimeoutError(
  error: unknown,
): error is LexicalSearchTimeoutError {
  return (
    error instanceof LexicalSearchTimeoutError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "LexicalSearchTimeoutError")
  );
}

export interface LexicalSearchOptions {
  keywords: LexicalKeyword[];
  libraryID: number;
  /**
   * Restrict the search to these Zotero item keys — the collection scope.
   *
   * Applied to the candidate set BEFORE anything is read or scored, so an
   * out-of-scope item is never loaded, never has its fields scanned and never
   * reaches the ranker. Filtering after ranking would leave the expensive part
   * of the work untouched.
   *
   * Undefined means the whole library.
   */
  scopeItemKeys?: Set<string>;
  /** Absolute wall-clock deadline; the scan degrades instead of overrunning. */
  deadlineAt?: number;
  isCancelled?: () => boolean;
  /**
   * What reaching {@link deadlineAt} during the candidate SCAN means.
   *
   * `"truncate"` (default) keeps the historic hybrid behaviour: whatever was
   * scored so far is returned with `truncated: true`, because a partial
   * lexical ranking still fuses usefully with a complete semantic one.
   *
   * `"throw"` is for single-branch `keyword_search`, where there is no other
   * branch to make up the difference and a short list would be indistinguishable
   * from a genuinely short answer. The caller asked for results within N
   * seconds; past N seconds it gets a timeout, not a quiet subset.
   *
   * Neither setting applies to the candidate QUERY itself — a deadline reached
   * before Zotero answers always throws, since there is nothing to truncate.
   */
  onDeadline?: "truncate" | "throw";
  /**
   * Serialises the underlying, uncancellable Zotero query per library.
   * Injectable so tests can drive their own gate.
   */
  gate?: KeywordSearchGate;
  /**
   * How long the gate keeps believing in the background query after this
   * caller has stopped waiting for it.
   *
   * A separate, much longer clock than {@link deadlineAt}, and deliberately
   * so: `deadlineAt` is the user's patience, this is how long a query nobody
   * is waiting for stays entitled to the library's slot. Past it the query is
   * presumed dead, the slot is freed so the queue drains, and the gate stops
   * new searches for a cool-down rather than stacking more unkillable queries
   * onto a database that is not answering.
   */
  queryGraceMs?: number;
}

export interface LexicalSearchDiagnostics {
  strategy: "union" | "per-keyword";
  candidateIDs: number;
  /** Candidates dropped for being outside the collection scope. */
  outOfScope: number;
  scannedItems: number;
  truncated: boolean;
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
 * Await `operation`, but stop waiting at `deadlineAt`.
 *
 * This is the difference between a deadline and a hard timeout. Every check in
 * this file used to happen AFTER `Zotero.Search.search()` resolved, so a query
 * that took two minutes was noticed two minutes in — the configured timeout
 * described when the code would next look at the clock, not when the caller
 * would get an answer. Racing a timer means the answer arrives at the
 * deadline whatever the query does.
 *
 * The query itself cannot be cancelled — Zotero exposes no API for it — so it
 * runs to completion and its result is discarded. What keeps that from
 * accumulating is the gate: the abandoned query still owns its library's slot
 * until it settles, so no replacement starts on top of it.
 */
async function awaitWithHardDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number | undefined,
  startedAt: number,
): Promise<T> {
  if (deadlineAt === undefined) return operation;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new LexicalSearchTimeoutError(Date.now() - startedAt);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new LexicalSearchTimeoutError(Date.now() - startedAt)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // The loser of the race is still a live promise. Nothing reads it, but an
    // unobserved rejection would surface as an unhandled rejection later, in a
    // request that has nothing to do with this one.
    operation.catch(() => undefined);
  }
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
    scopeItemKeys,
    deadlineAt,
    isCancelled,
    onDeadline = "truncate",
  } = options;

  if (keywords.length === 0) {
    return {
      items: [],
      diagnostics: {
        strategy: "union",
        candidateIDs: 0,
        outOfScope: 0,
        scannedItems: 0,
        truncated: false,
        searchMs: 0,
        scanMs: 0,
        rankMs: 0,
        totalMs: Date.now() - startedAt,
        failedKeywords: [],
      },
    };
  }

  const searchStartedAt = Date.now();
  // Two guarantees, and they are different:
  //   the gate bounds how many uncancellable Zotero queries can exist at once,
  //   the race bounds how long THIS request waits for one.
  // Neither alone is enough — without the gate, every timeout would leave
  // another query running; without the race, the gate would just queue this
  // caller behind a query that is already overrunning.
  const gate = options.gate ?? keywordSearchGate;
  const { ids, strategy, failedKeywords } = await awaitWithHardDeadline(
    gate.run(libraryID, () => findCandidateIDs(keywords, libraryID), {
      graceMs:
        options.queryGraceMs ??
        resolveQueryGraceMs(
          deadlineAt === undefined ? 0 : deadlineAt - startedAt,
        ),
    }),
    deadlineAt,
    startedAt,
  );
  const searchMs = Date.now() - searchStartedAt;

  let truncated = false;
  let candidateIDs = ids;
  let outOfScope = 0;

  // Collection scope is applied before any item is scored.
  if (scopeItemKeys) {
    const before = candidateIDs.length;
    const inScope: number[] = [];
    for (
      let offset = 0;
      offset < candidateIDs.length;
      offset += CANDIDATE_CHUNK_SIZE
    ) {
      if (isCancelled?.() || isExpired(deadlineAt)) {
        // A single-branch keyword_search has nothing to fuse a partial ranking
        // with, so "some of the matches, silently" is the wrong answer there:
        // the caller cannot tell it apart from "these are all the matches".
        if (onDeadline === "throw" && isExpired(deadlineAt)) {
          throw new LexicalSearchTimeoutError(Date.now() - startedAt);
        }
        truncated = true;
        break;
      }
      const chunk = candidateIDs.slice(offset, offset + CANDIDATE_CHUNK_SIZE);
      const items = await Zotero.Items.getAsync(chunk);
      for (const item of items as any[]) {
        const key = item?.key;
        if (key && scopeItemKeys.has(key)) inScope.push(item.id);
      }
    }
    candidateIDs = inScope;
    outOfScope = before - candidateIDs.length;
  }

  const scanStartedAt = Date.now();
  const candidates: LexicalCandidate[] = [];
  for (
    let offset = 0;
    offset < candidateIDs.length;
    offset += CANDIDATE_CHUNK_SIZE
  ) {
    if (isCancelled?.() || isExpired(deadlineAt)) {
      // A single-branch keyword_search has nothing to fuse a partial ranking
      // with, so "some of the matches, silently" is the wrong answer there:
      // the caller cannot tell it apart from "these are all the matches".
      if (onDeadline === "throw" && isExpired(deadlineAt)) {
        throw new LexicalSearchTimeoutError(Date.now() - startedAt);
      }
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
  const items = rankLexicalCandidates(candidates, keywords, {});
  const rankMs = Date.now() - rankStartedAt;

  return {
    items,
    diagnostics: {
      strategy,
      candidateIDs: ids.length,
      outOfScope,
      scannedItems: candidates.length,
      truncated,
      searchMs,
      scanMs,
      rankMs,
      totalMs: Date.now() - startedAt,
      failedKeywords,
    },
  };
}
