import {
  type KeywordSearchItem,
  type LexicalCandidate,
  type LexicalKeyword,
} from "./hybridSearch";
import { runBodyKeywordSearch } from "./keyword/bodyKeywordSearch";
import {
  rankKeywordCandidates,
  type BodyContribution,
} from "./keyword/keywordRanker";
import type { Bm25Field } from "./keyword/bm25f";
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
  /**
   * Whether to consult the body-keyword index.
   *
   * On by default. Turned off only where body text would be wrong or
   * unavailable — and it degrades rather than fails: if the index is missing,
   * empty or unreadable, the metadata half of the branch still answers, and the
   * diagnostics say so instead of the result set quietly shrinking.
   */
  bodyKeywords?: boolean;
  /** Injectable for tests; defaults to the shared vector store's keyword index. */
  bodyKeywordDependencies?: BodyKeywordDependencies;
}

/** The two things the body half needs, injected so tests can drive them. */
export interface BodyKeywordDependencies {
  store: Parameters<typeof runBodyKeywordSearch>[0];
  resolver: Parameters<typeof runBodyKeywordSearch>[1];
  /** Documents in the library, BM25F's N. */
  libraryDocumentCount: () => Promise<number>;
  /**
   * The body index's own statistics: how many documents it covers and their mean
   * body length.
   *
   * The document count is what BODY document frequencies are divided by. It is
   * NOT the library count: the bodies the index does not cover are unknown, and
   * treating them as non-containing inflated IDF by 3.76x to 4.39x on real
   * body-only terms.
   */
  bodyStatistics: () => Promise<{
    documentCount: number;
    averageBodyLength: number;
  }>;
  /** Library-wide mean metadata field lengths, stable across queries. */
  libraryFieldAverages: () => Promise<Record<string, number>>;
  /** Item keys that have a body index, for sizing a scoped body collection. */
  indexedItemKeys: () => Promise<Set<string>>;
}

/** What the body-keyword half of the branch did, or why it did nothing. */
export interface BodyKeywordDiagnosticsSummary {
  enabled: boolean;
  /** Documents with a body-keyword index in this library. */
  indexedDocuments: number;
  /**
   * The two collections the two document frequencies were counted over.
   *
   * Reported so the IDF arithmetic is auditable from a search response: a body
   * frequency divided by the metadata collection would be the exact defect these
   * numbers exist to make visible.
   */
  metadataCollectionSize: number;
  bodyCollectionSize: number;
  candidateDocuments: number;
  /** Documents that ONLY the body index found — pure added recall. */
  bodyOnlyDocuments: number;
  postingsRead: number;
  rejectedByVerification: number;
  truncated: boolean;
  ms: number;
  /** Present when the body half could not run; the metadata half still did. */
  error?: string;
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
  /** BM25F ranking time, distinct from the candidate scan. */
  scoreMs: number;
  body: BodyKeywordDiagnosticsSummary;
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
 * Read one Zotero item into the shape the ranker scores.
 *
 * Extracted so that a document found ONLY by the body index goes through exactly
 * the same construction. That matters for identity rather than tidiness: the
 * fusion downstream keys candidates on `libraryID:itemKey`, so a body-only row
 * assembled by hand — without a libraryID, without a title — would fail to merge
 * with the same document coming from the semantic branch and the caller would
 * see one paper twice.
 */
function buildLexicalCandidate(
  item: any,
  libraryID: number,
): LexicalCandidate | null {
  try {
    if (!item?.isRegularItem?.()) return null;
    if (item.deleted) return null;

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

    return {
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
    };
  } catch (error) {
    ztoolkit.log(
      `[LexicalSearch] skipped candidate: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "warn",
    );
    return null;
  }
}

/**
 * The production body-keyword dependencies: the shared vector store's index.
 *
 * Loaded lazily so that a metadata-only keyword search never pulls the semantic
 * modules into the import graph, which is a startup-cost rule this codebase
 * already follows elsewhere.
 */
async function defaultBodyKeywordDependencies(
  libraryID: number,
): Promise<BodyKeywordDependencies> {
  const { getVectorStore } = await import("./semantic/vectorStore");
  const vectorStore = getVectorStore();
  const store = vectorStore.getKeywordIndexStore();

  return {
    store,
    resolver: {
      async chunkTexts(_libraryID, pairs) {
        const wanted = new Map<string, Set<number>>();
        for (const pair of pairs) {
          const set = wanted.get(pair.itemKey) ?? new Set<number>();
          set.add(pair.chunkId);
          wanted.set(pair.itemKey, set);
        }
        const texts = new Map<string, string>();
        /*
         * getItemChunks matches the stored `item_key` verbatim, and stored keys
         * carry a `libraryID:` prefix for every library EXCEPT the user's own.
         * Passing bare keys therefore worked in the user library and silently
         * returned nothing in a group library — no verification text, so every
         * Chinese and multi-word hit there would have been discarded as
         * unverifiable. The prefix has to be applied on the way in and stripped
         * on the way out.
         */
        const userLibraryID = Zotero.Libraries.userLibraryID;
        const toStorageKey = (itemKey: string): string =>
          libraryID === userLibraryID ? itemKey : `${libraryID}:${itemKey}`;
        const fromStorageKey = (storageKey: string): string => {
          const separator = storageKey.indexOf(":");
          return separator === -1
            ? storageKey
            : storageKey.slice(separator + 1);
        };

        // Batched per item, because the stored chunks are addressed per item and
        // one query per passage would dominate a search that touches hundreds.
        const itemKeys = Array.from(wanted.keys());
        const BATCH = 100;
        for (let offset = 0; offset < itemKeys.length; offset += BATCH) {
          const slice = itemKeys.slice(offset, offset + BATCH);
          const chunks = await vectorStore.getItemChunks(
            slice.map(toStorageKey),
          );
          for (const [storageKey, list] of chunks) {
            const bare = fromStorageKey(storageKey);
            const need = wanted.get(bare);
            if (!need) continue;
            for (const chunk of list) {
              if (!need.has(chunk.chunkId)) continue;
              texts.set(`${bare}:${chunk.chunkId}`, chunk.text ?? "");
            }
          }
        }
        return texts;
      },
      async metadataTexts(_libraryID, itemKeys) {
        const out = new Map<string, Record<string, string>>();
        const items = await Promise.all(
          itemKeys.map(async (key) => {
            try {
              return await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
            } catch {
              return null;
            }
          }),
        );
        for (const item of items) {
          // getByLibraryAndKeyAsync answers `false` for a key the library does
          // not have, so this is a type narrowing and not a redundant check.
          if (!item || typeof item !== "object") continue;
          const field = (name: string): string => {
            try {
              const value = (item as any).getField?.(name);
              return typeof value === "string" ? value : "";
            } catch {
              return "";
            }
          };
          let tags = "";
          try {
            tags = ((item as any).getTags?.() ?? [])
              .map((tag: any) => tag.tag)
              .filter(Boolean)
              .join("\n");
          } catch {
            tags = "";
          }
          let creator = "";
          try {
            creator = ((item as any).getCreators?.() ?? [])
              .map((entry: any) =>
                `${entry.firstName || ""} ${entry.lastName || ""}`.trim(),
              )
              .filter(Boolean)
              .join(", ");
          } catch {
            creator = "";
          }
          out.set(item.key, {
            title: (item as any).getDisplayTitle?.() || field("title"),
            abstract: field("abstractNote"),
            tags,
            publicationTitle: field("publicationTitle"),
            creator,
            extra: field("extra"),
          });
        }
        return out as any;
      },
    },
    async libraryDocumentCount() {
      try {
        const items = (await Zotero.Items.getAll(libraryID, true)) ?? [];
        return items.length || 1;
      } catch {
        // A count we cannot read must not become a zero: N=0 would flatten every
        // idf to nothing and make the whole ranking uniform.
        return 1;
      }
    },
    async bodyStatistics() {
      try {
        const stats = await store.statistics(libraryID);
        return {
          documentCount: stats.documentCount,
          averageBodyLength: stats.averageLengths.body,
        };
      } catch {
        // No readable body statistics means no body collection to score against,
        // so body evidence contributes nothing rather than being scored against a
        // collection size we guessed.
        return { documentCount: 0, averageBodyLength: 0 };
      }
    },
    async libraryFieldAverages() {
      const { getLibraryFieldStats } = await import(
        "./keyword/libraryFieldStats"
      );
      const averages = await getLibraryFieldStats().get(libraryID);
      return averages.averageLengths;
    },
    async indexedItemKeys() {
      try {
        return await store.indexedItemKeys(libraryID);
      } catch {
        return new Set<string>();
      }
    },
  };
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
        scoreMs: 0,
        totalMs: Date.now() - startedAt,
        failedKeywords: [],
        body: {
          enabled: false,
          indexedDocuments: 0,
          metadataCollectionSize: 0,
          bodyCollectionSize: 0,
          candidateDocuments: 0,
          bodyOnlyDocuments: 0,
          postingsRead: 0,
          rejectedByVerification: 0,
          truncated: false,
          ms: 0,
        },
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
      const candidate = buildLexicalCandidate(item, libraryID);
      if (candidate) candidates.push(candidate);
    }
    // Yield so a long scan cannot freeze the Zotero UI thread.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const scanMs = Date.now() - scanStartedAt;

  // ---------------------------------------------------------------- body half
  //
  // Runs INSIDE this branch rather than as a third parallel one, so it inherits
  // the deadline, the cancellation hook and the gate's overload protection that
  // already bound the keyword branch. No new timeout was added anywhere.
  const bodyStartedAt = Date.now();
  const bodyDiagnostics: BodyKeywordDiagnosticsSummary = {
    enabled: options.bodyKeywords !== false,
    indexedDocuments: 0,
    metadataCollectionSize: 0,
    bodyCollectionSize: 0,
    candidateDocuments: 0,
    bodyOnlyDocuments: 0,
    postingsRead: 0,
    rejectedByVerification: 0,
    truncated: false,
    ms: 0,
  };
  let bodyContributions = new Map<string, BodyContribution>();
  let libraryDocumentCount = Math.max(candidates.length, 1);
  let bodyDocumentCount = 0;
  let averageBodyLength = 0;
  let averageFieldLengths: Record<string, number> | undefined;
  let scopeBodyDocumentCount: number | undefined;

  if (bodyDiagnostics.enabled) {
    try {
      const dependencies =
        options.bodyKeywordDependencies ??
        (await defaultBodyKeywordDependencies(libraryID));
      const outcome = await runBodyKeywordSearch(
        dependencies.store,
        dependencies.resolver,
        {
          libraryID,
          probes: keywords.map((keyword) => ({
            text: keyword.text,
            weight: keyword.weight,
          })),
          scopeItemKeys,
          deadlineAt,
          isCancelled,
          // Only the body. The metadata fields are scored from the live items
          // below, which covers the WHOLE library; the index covers only what the
          // user has indexed, so taking metadata from it would drop the rest.
          includeFields: ["body"],
        },
      );
      bodyDiagnostics.indexedDocuments = outcome.diagnostics.indexedDocuments;
      bodyDiagnostics.candidateDocuments =
        outcome.diagnostics.candidateDocuments;
      bodyDiagnostics.postingsRead = outcome.diagnostics.postingsRead;
      bodyDiagnostics.rejectedByVerification =
        outcome.diagnostics.rejectedByVerification;
      if (outcome.diagnostics.truncated) {
        bodyDiagnostics.truncated = true;
        truncated = true;
      }
      const metadataKeys = new Set(
        candidates.map((candidate) => candidate.key),
      );
      const bodyOnlyKeys: string[] = [];
      for (const result of outcome.results) {
        bodyContributions.set(result.itemKey, {
          itemKey: result.itemKey,
          frequencies: result.bodyFrequencies,
          bodyLength: result.bodyLength,
          evidence: result.evidence,
        });
        if (!metadataKeys.has(result.itemKey)) {
          bodyDiagnostics.bodyOnlyDocuments += 1;
          bodyOnlyKeys.push(result.itemKey);
        }
      }

      // A document whose match is ONLY in its body was never a metadata
      // candidate, so it has to be admitted here — as a full candidate, read the
      // same way as any other, so that its identity, title and citation fields
      // are the ones every downstream stage expects.
      for (const itemKey of bodyOnlyKeys) {
        try {
          const item = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            itemKey,
          );
          if (!item || typeof item !== "object") continue;
          const candidate = buildLexicalCandidate(item, libraryID);
          if (candidate) candidates.push(candidate);
        } catch (error) {
          ztoolkit.log(
            `[LexicalSearch] body-only candidate ${itemKey} could not be read: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "warn",
          );
        }
      }
      libraryDocumentCount = await dependencies.libraryDocumentCount();
      const bodyStats = await dependencies.bodyStatistics();
      bodyDocumentCount = bodyStats.documentCount;
      averageBodyLength = bodyStats.averageBodyLength;
      averageFieldLengths = await dependencies.libraryFieldAverages();
      if (scopeItemKeys) {
        // A scope narrows the collection the body frequencies were counted in, so
        // it has to narrow that collection's size too: how many of the indexed
        // documents are actually inside the scope.
        const indexed = await dependencies.indexedItemKeys();
        let inScope = 0;
        for (const key of indexed) {
          if (scopeItemKeys.has(key)) inScope += 1;
        }
        scopeBodyDocumentCount = inScope;
      }
    } catch (error) {
      // The body half is additive. Losing it must degrade the answer, never
      // fail the branch: metadata retrieval is what the caller had before.
      bodyContributions = new Map();
      bodyDiagnostics.error =
        error instanceof Error ? error.message : String(error);
      ztoolkit.log(
        `[LexicalSearch] body-keyword retrieval unavailable: ${bodyDiagnostics.error}`,
        "warn",
      );
    }
  }
  bodyDiagnostics.ms = Date.now() - bodyStartedAt;

  bodyDiagnostics.metadataCollectionSize =
    scopeItemKeys?.size ?? libraryDocumentCount;
  bodyDiagnostics.bodyCollectionSize =
    scopeBodyDocumentCount ?? bodyDocumentCount;

  const rankStartedAt = Date.now();
  const items = rankKeywordCandidates({
    probes: keywords.map((keyword) => ({
      text: keyword.text,
      weight: keyword.weight,
    })),
    candidates,
    bodyContributions,
    libraryDocumentCount,
    bodyDocumentCount,
    scopeDocumentCount: scopeItemKeys?.size,
    scopeBodyDocumentCount,
    averageFieldLengths: averageFieldLengths as
      | Record<Bm25Field, number>
      | undefined,
    averageBodyLength,
  }) as unknown as KeywordSearchItem[];
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
      scoreMs: rankMs,
      totalMs: Date.now() - startedAt,
      failedKeywords,
      body: bodyDiagnostics,
    },
  };
}
