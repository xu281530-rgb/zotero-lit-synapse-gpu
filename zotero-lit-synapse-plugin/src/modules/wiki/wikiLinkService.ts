/**
 * The cross-paper link layer, assembled.
 *
 * Everything below it is either pure (scoring, the selector, the lexical
 * terms) or a plain table (the link store). This is the only file that knows
 * about Zotero, the vector index, the keyword index and the reading ledger at
 * once, which is deliberate: it means the parts worth arguing about - the
 * formulas, the thresholds, the state machine - can be tested without any of
 * those.
 *
 * The one rule that could not live anywhere else is `mustResolve`.
 *
 * ## Why the server decides what is mandatory
 *
 * The tempting rule is "if both papers already have Evidence, they have both
 * been read, so reconcile them". It is wrong, and wrong in the direction that
 * costs the most: Evidence on a paper proves that SOME passage of it was read,
 * not that the passage this candidate points at was. A question that read
 * three chunks of a ninety-chunk review leaves that review with Evidence; a
 * candidate anchored on chunk 71 of it is then declared settleable debt, and
 * the model is asked to reconcile a passage nobody has looked at. It will
 * comply - that is the problem - by writing something plausible.
 *
 * So the check is per signal and per chunk:
 *
 *     mustResolve = the signal is valid
 *                   AND A's specific chunk is in A's reading ledger
 *                   AND B's specific chunk is in B's reading ledger
 *
 * `paper_reviewed` is a sufficient condition for one side, and only in its
 * strict sense: a full-text session, complete coverage, whole-paper synthesis
 * recorded. A question-driven session that happens to have touched every chunk
 * does not qualify, for the same reason it cannot reach `paper_reviewed` as an
 * Evidence depth - see WikiService.verifiedReadDepth.
 *
 * And the model never computes this. It gets a boolean.
 */

import { getEmbeddingService } from "../semantic/embeddingService";
import { isNonBodyChunk } from "../keyword/contentFilters";
import { bodyIndexStateFromSourceKind } from "../semantic/bodyIndexState";
import { getVectorStore } from "../semantic/vectorStore";
import { getStoredChunkingSignature } from "../hybridSearchSettings";
import { hashWikiText } from "./wikiCanonicalizer";
import {
  LEXICAL_ALGORITHM_VERSION,
  lexicalScore,
  sharedRareTerms,
} from "./wikiLexicalSignals";
import { LINK_ALGORITHM_VERSION } from "./wikiLinkScoring";
import { getWikiLinkSettings, type WikiLinkSettings } from "./wikiLinkSettings";
import {
  WikiLinkSignalRelinker,
  type WikiLinkRelinkReport,
} from "./wikiLinkSignalRelinker";
import { scanDocumentLinks, type ScanDocument } from "./wikiLinkScanner";
import { REPRESENTATIVE_SELECTOR_VERSION } from "./wikiRepresentativeChunks";
import type { WikiStore } from "./wikiStore";
import type {
  WikiLinkResolutionType,
  WikiLinkSignalInput,
  WikiLinkSignalWithPair,
  WikiLinkStatistics,
} from "./wikiLinkTypes";

declare const Zotero: any;
declare let ztoolkit: ZToolkit;

/** Retry schedule for a failed scan, mirroring the embedding queue's shape. */
const SCAN_RETRY_BACKOFF_MS = [0, 60_000, 5 * 60_000, 30 * 60_000];
const SCAN_MAX_ATTEMPTS = 4;

/** The concept algorithm has no parameters, but it still needs a version. */
export const CONCEPT_ALGORITHM_VERSION = "link-concept-v1";

/**
 * How long a dismissal has to argue for, per signal.
 *
 * The same floor SKIP uses, and kept here rather than imported from
 * `wikiService` because this module is the one that decides what a dismissal
 * is; the service applies the rule, it does not own it.
 */
export const WIKI_LINK_DISMISSAL_MIN_REASON_CHARS = 40;

/**
 * Reasons that assert rather than argue, matched against the whole sentence.
 *
 * Deliberately short: it catches the reflex answer, and the length floor
 * catches the rest.
 */
const VACUOUS_DISMISSAL_REASON =
  /^(?:no(?:thing)?\s+new(?:\s+knowledge)?|nothing\s+to\s+add|not\s+relevant|irrelevant|n\/?a|none|already\s+known|duplicate)[\s.。!！]*$|^(?:无|没有)?(?:新知识|新内容|新信息|可补充内容)[\s.。!！]*$|^已知(?:内容)?[\s.。!！]*$|^重复内容[\s.。!！]*$|^不相关[\s.。!！]*$/iu;

/** One signal, and the sentence that dismisses THAT signal. */
export interface WikiLinkDismissal {
  signalId: number;
  reason: string;
}

/**
 * Read a DISMISS_LINK_SIGNALS action as one reason per signal.
 *
 * The action used to carry `signalIds` plus a single `reason`, and the reason
 * was copied onto every signal in the batch. A batch is not homogeneous. One
 * measured dismissal covered three signals - a competing-interest declaration,
 * a lexical hit on the word "played", and a semantic pair about misorientation
 * profiles - under "both sides are the journal's standard competing-interest
 * declaration", which was true of the first and false of the other two.
 * Another covered six signals across six different chunk pairs under a reason
 * that named chunk 43 and chunk 40, true of exactly one of them.
 *
 * The reasons are kept permanently and are what a later reviewer reads when
 * asking whether a connection was rightly dropped. A reason filed against a
 * passage it does not describe is worse than no reason at all, because it will
 * be believed.
 *
 * So a batch says what it dismisses, one sentence each. `signalIds` + `reason`
 * survives for the case it was always honest about - a single signal - and is
 * refused beyond that, with the shape to use instead.
 */
export function normalizeLinkDismissals(action: {
  signalIds?: unknown;
  reason?: unknown;
  dismissals?: unknown;
}): WikiLinkDismissal[] {
  const raw: Array<{ signalId: unknown; reason: unknown }> = [];
  if (Array.isArray(action.dismissals)) {
    for (const entry of action.dismissals) {
      raw.push({
        signalId: (entry as any)?.signalId,
        reason: (entry as any)?.reason,
      });
    }
  } else {
    const signalIds = Array.isArray(action.signalIds) ? action.signalIds : [];
    if (signalIds.length > 1) {
      throw new Error(
        `DISMISS_LINK_SIGNALS carried one reason for ${signalIds.length} signals. Each signal is a ` +
          "different pair of passages, so one sentence cannot describe all of them and the archive " +
          "ends up filed against text it does not quote. Send one reason per signal: " +
          '"dismissals": [{"signalId": ..., "reason": "..."}, ...]. Use signalIds + reason only when ' +
          "it names a single signal.",
      );
    }
    for (const signalId of signalIds) {
      raw.push({ signalId, reason: action.reason });
    }
  }
  if (!raw.length) {
    throw new Error(
      "DISMISS_LINK_SIGNALS needs the signals it dismisses, each with its own reason: " +
        '"dismissals": [{"signalId": ..., "reason": "..."}, ...]. The ids come from ' +
        "pendingLinkSignals in wiki_prepare_update.",
    );
  }
  const seen = new Set<number>();
  const dismissals: WikiLinkDismissal[] = [];
  for (const entry of raw) {
    const signalId = Number(entry.signalId);
    if (!Number.isInteger(signalId) || signalId <= 0) {
      throw new Error(
        `DISMISS_LINK_SIGNALS got "${String(entry.signalId)}" where a signalId was expected. The ids ` +
          "come from pendingLinkSignals in wiki_prepare_update.",
      );
    }
    if (seen.has(signalId)) {
      throw new Error(
        `DISMISS_LINK_SIGNALS names signal ${signalId} twice. A signal is settled once, with one ` +
          "reason; two entries would record two conclusions about one finding.",
      );
    }
    seen.add(signalId);
    const reason = String(entry.reason ?? "").trim();
    if (!reason) {
      throw new Error(
        `DISMISS_LINK_SIGNALS gave no reason for signal ${signalId}. Every dismissed signal keeps its ` +
          "own reason permanently, because that is what stops the same pair being offered again.",
      );
    }
    // Shape before size, exactly as SKIP does: naming the reflex tells the
    // caller what is wanted, where a length complaint only invites padding.
    if (VACUOUS_DISMISSAL_REASON.test(reason)) {
      throw new Error(
        `Signal ${signalId} is dismissed by assertion rather than argument: "${reason}". "Not related" ` +
          "is exactly what a reader who compared nothing would also say. Quote what each side actually " +
          "claims, and say why they cannot support one Claim, sit under one Page, contradict each " +
          "other, or form a concept relation.",
      );
    }
    if (reason.length < WIKI_LINK_DISMISSAL_MIN_REASON_CHARS) {
      throw new Error(
        `Signal ${signalId} needs a reason of at least ${WIKI_LINK_DISMISSAL_MIN_REASON_CHARS} ` +
          "characters, argued from the quoted text on both sides. This judgement is kept permanently " +
          "and is what stops the same pair being offered again, so it has to be readable later.",
      );
    }
    dismissals.push({ signalId, reason });
  }
  return dismissals;
}

export interface PendingLinkSignalView {
  linkId: number;
  signalIds: number[];
  otherItemKey: string;
  otherTitle: string;
  scoreAB: number | null;
  scoreBA: number | null;
  scoreSymmetric: number | null;
  signalTypes: string[];
  thisChunk: { chunkId: number | null; excerpt: string; read: boolean };
  otherChunk: { chunkId: number | null; excerpt: string; read: boolean };
  mustResolve: boolean;
  fingerprintState: "valid" | "stale";
  suggestedLabels: string[];
  /**
   * Why this pair is being asked AGAIN, when it has been settled before.
   *
   * A reopened pair that looks identical to a fresh one gets the same answer
   * as last time - which is the whole problem, since it is being asked again
   * precisely because that answer no longer holds. `reopenedReason` says what
   * changed (a Wiki reset, or a Claim that cites both papers) and
   * `priorDismissals` carries what the earlier reader concluded, so the second
   * judgement argues with the first instead of reproducing it.
   */
  reopenedReason?: string;
  priorDismissals?: Array<{ signalId: number; reason: string }>;
}

export class WikiLinkService {
  private readonly store: WikiStore;
  private draining = false;

  constructor(store: WikiStore) {
    this.store = store;
  }

  private settings(): WikiLinkSettings {
    return getWikiLinkSettings();
  }

  // ---- Triggering ---------------------------------------------------------

  /**
   * A paper produced its first real reading record: queue it for a scan.
   *
   * Reading, not importing. Importing five hundred papers must not start five
   * hundred full-library scans, and a paper that retrieval merely returned has
   * told us nothing about whether anyone cares about it. Queueing is
   * idempotent, so calling this on every note update costs one SELECT.
   *
   * Never throws into the reading path. A scan that cannot be queued is a
   * missing suggestion; a reading call that fails because of one is a lost
   * page of work.
   */
  async onPaperRead(libraryID: number, itemKey: string): Promise<void> {
    if (!this.settings().enabled) return;
    try {
      const links = await this.store.links();
      await links.enqueueScan({
        libraryID,
        itemKey,
        reason: "first reading record",
      });
    } catch (error) {
      ztoolkit.log("[wiki] could not queue a link scan", error);
      return;
    }
    /*
     * Work the queue in the background, the way the embedding queue is worked.
     *
     * Enqueueing alone was not enough and the gap was invisible: after a Wiki
     * reset the four papers a reading touched sat `queued` indefinitely,
     * `wiki_status` reported linkCandidates 0, and nothing said why - the only
     * thing that ever drained the queue was somebody calling wiki_scan_links.
     * A candidate the reader has to ask for is a candidate that does not
     * exist.
     *
     * Not awaited: a full-library vector pass must never be on the path of the
     * reading call that triggered it. The drain is re-entrant-guarded, so
     * several readings in one turn start one pass between them.
     */
    void this.pumpQueue().catch((error: unknown) => {
      ztoolkit.log("[wiki] background link scan failed", error);
    });
  }

  /** Queue every paper of a library that has been read but never scanned. */
  async enqueueLibraryScan(
    libraryID: number,
    options: { force?: boolean } = {},
  ): Promise<{ queued: number; skipped: number }> {
    const links = await this.store.links();
    const sessions = await this.store.readingSessions();
    const seen = new Set<string>();
    let queued = 0;
    let skipped = 0;
    for (const session of await sessions.list(libraryID, 500)) {
      if (seen.has(session.itemKey)) continue;
      seen.add(session.itemKey);
      const added = await links.enqueueScan({
        libraryID,
        itemKey: session.itemKey,
        reason: options.force ? "manual full-library rescan" : "manual scan",
        force: options.force,
      });
      if (added) queued += 1;
      else skipped += 1;
    }
    return { queued, skipped };
  }

  // ---- Scanning -----------------------------------------------------------

  /**
   * Work the scan queue until it is empty or something fails.
   *
   * Serial on purpose. A scan is a full-library vector pass; running two at
   * once does not halve the wall clock, it doubles the memory and fights the
   * index builder for the same rows. The re-entrancy guard is the same one the
   * embedding queue uses and exists for the same reason - several callers kick
   * the drain and only one may be inside it.
   */
  async pumpQueue(limit = 25): Promise<{ scanned: number; failed: number }> {
    if (this.draining || !this.settings().enabled) {
      return { scanned: 0, failed: 0 };
    }
    this.draining = true;
    let scanned = 0;
    let failed = 0;
    try {
      const links = await this.store.links();
      // Clear out anything a superseded algorithm left pending before writing
      // fresh signals, so a corrected formula does not have to compete for
      // per-pair slots with the results of the formula it replaced.
      await links.purgeSupersededSignals(this.currentAlgorithmVersions());
      for (let round = 0; round < limit; round += 1) {
        const next = await links.claimNextScan();
        if (!next) break;
        try {
          await this.runScan(next.libraryID, next.itemKey);
          scanned += 1;
        } catch (error) {
          failed += 1;
          const message =
            error instanceof Error ? error.message : String(error);
          await links.failScan({
            libraryID: next.libraryID,
            itemKey: next.itemKey,
            error: message,
            retryDelayMs:
              SCAN_RETRY_BACKOFF_MS[
                Math.min(next.attempts, SCAN_RETRY_BACKOFF_MS.length - 1)
              ],
            maxAttempts: SCAN_MAX_ATTEMPTS,
          });
          ztoolkit.log(
            `[wiki] link scan failed for ${next.itemKey}: ${message}`,
          );
        }
      }
    } finally {
      this.draining = false;
    }
    return { scanned, failed };
  }

  /** The algorithm version each signal type is currently produced by. */
  private currentAlgorithmVersions(): Record<string, string> {
    return {
      semantic: LINK_ALGORITHM_VERSION,
      lexical: LEXICAL_ALGORITHM_VERSION,
      concept: CONCEPT_ALGORITHM_VERSION,
    };
  }

  /** Compute and store one paper's candidates. Throws; the queue catches. */
  async runScan(libraryID: number, itemKey: string): Promise<void> {
    const settings = this.settings();
    const links = await this.store.links();
    const vectorStore = getVectorStore();
    await vectorStore.initialize();

    const document = await this.loadScanDocument(libraryID, itemKey);
    if (!document) {
      throw new Error(
        `${itemKey} has no usable body vectors, so it cannot be scanned for cross-paper links.`,
      );
    }
    const documentCount = await this.libraryDocumentCount(libraryID);
    const outcome = await scanDocumentLinks({
      document,
      documentCount,
      settings,
      scan: async (queryVectors, scanOptions) => {
        const matches = await vectorStore.searchMultiQuery(queryVectors, {
          chunksPerQuery: scanOptions.chunksPerQuery,
          libraryID: scanOptions.libraryID,
          excludeItemKeys: scanOptions.excludeItemKeys,
          // Keep every chunk, as findSimilarByChunks does: a floor above the
          // lowest cosine makes "no such passage" and "an unrelated passage"
          // indistinguishable, and breadth counts both.
          minChunkScore: -1,
          deadlineAt: scanOptions.deadlineAt,
        });
        return matches.map((match) => ({
          itemKey: match.itemKey,
          libraryID: match.libraryID,
          perQuery: match.perQuery.map((hits) =>
            hits.map((hit) => ({ chunkId: hit.chunkId, score: hit.score })),
          ),
        }));
      },
      loadDocument: (candidateLibraryID, candidateItemKey) =>
        this.loadScanDocument(candidateLibraryID, candidateItemKey),
    });

    let candidatesWritten = 0;
    let signalsWritten = 0;
    for (const pair of outcome.pairs) {
      const candidate = await this.loadScanDocument(
        pair.libraryID,
        pair.itemKey,
      );
      const linkId = await links.upsertCandidate({
        libraryID,
        itemKeyA: document.itemKey,
        itemKeyB: pair.itemKey,
        scoreAB: pair.scoreQueryToCandidate,
        scoreBA: pair.scoreCandidateToQuery,
        scoreSymmetric: pair.scoreSymmetric,
        fingerprintA: document.fingerprint,
        fingerprintB: candidate?.fingerprint,
        semanticModel: outcome.model,
        semanticDimensions: outcome.dimensions,
        semanticAlgorithmVersion: outcome.algorithmVersion,
        semanticSelectorVersion: outcome.selection.selectorVersion,
      });
      candidatesWritten += 1;
      const signals = [...pair.signals];
      if (candidate) {
        signals.push(
          ...(await this.lexicalSignalsFor(
            libraryID,
            document,
            candidate,
            documentCount,
            settings,
          )),
        );
      }
      const written = await links.recordSignals({
        linkId,
        signals,
        cap: settings.anchorsPerType,
      });
      signalsWritten += written.written;
    }

    await links.finishScan({
      libraryID,
      itemKey,
      contentHash: document.fingerprint.contentHash,
      chunkSignature: document.fingerprint.chunkSignature,
      resetGeneration: document.fingerprint.resetGeneration,
      selectorVersion: outcome.selection.selectorVersion,
      algorithmVersion: outcome.algorithmVersion,
      embeddingModel: outcome.model,
      candidatesWritten,
      signalsWritten,
    });
  }

  /**
   * Terms only these two papers share, as lexical signals.
   *
   * Run inside the semantic scan rather than as its own pass, because it needs
   * exactly the two documents the pairwise stage has already loaded. A
   * separate lexical sweep would re-read both from SQLite to compute something
   * that costs a few milliseconds once the text is in hand.
   */
  private async lexicalSignalsFor(
    libraryID: number,
    a: ScanDocument,
    b: ScanDocument,
    documentCount: number,
    settings: WikiLinkSettings,
  ): Promise<WikiLinkSignalInput[]> {
    try {
      const keywordStore = getVectorStore().getKeywordIndexStore();
      const aIsFirst = a.itemKey < b.itemKey;
      /*
       * Tokenise only what the KEYWORD index would have tokenised.
       *
       * The two indexes disagreed, and the disagreement was the whole bug. The
       * keyword indexer drops acknowledgements, funding statements, data
       * availability and reference lists (`isNonBodyChunk`); the vector index
       * keeps every chunk, because those passages are still part of the paper
       * and a reader may legitimately search them. This pass reads the VECTOR
       * chunks, so it was offering terms the keyword index had no frequency
       * for - and rating them the rarest in the library.
       *
       * The unknown-rarity guard now catches those anyway. Filtering here as
       * well is not belt-and-braces for its own sake: it stops two papers being
       * paired on `financially` or `foundation` at all, rather than computing a
       * pairing and then discarding it, and it keeps the excerpt a candidate
       * shows drawn from the paper's argument rather than from its funding line.
       */
      const body = (chunks: ScanDocument["chunks"]) =>
        chunks.filter((chunk) => !isNonBodyChunk(chunk.text));
      const first = body(aIsFirst ? a.chunks : b.chunks);
      const second = body(aIsFirst ? b.chunks : a.chunks);
      if (!first.length || !second.length) return [];
      const liveDocuments =
        (await keywordStore.liveDocumentCount(libraryID)) || documentCount;
      // Shared terms are found first, then their frequencies looked up in one
      // batch: asking the index for every term of two papers would be a query
      // per token for a set that is mostly discarded.
      const provisional = sharedRareTerms(
        first,
        second,
        new Map(),
        {
          documentCount: liveDocuments,
          // Everything, at this stage: the ceiling needs real frequencies and
          // the empty map above has none.
          maxDocumentFraction: 1,
          termsPerPair: 500,
          unknownFrequency: "assume-rare",
        },
      );
      if (!provisional.length) return [];
      const frequencies = await keywordStore.documentFrequencies(
        libraryID,
        provisional.map((hit) => hit.term),
      );
      const hits = sharedRareTerms(first, second, frequencies, {
        documentCount: liveDocuments,
        maxDocumentFraction: settings.lexicalMaxDocumentFraction,
        termsPerPair: settings.lexicalTermsPerPair,
        // A term the keyword index has no posting for has an UNKNOWN rarity,
        // and unknown must not be read as rare - that is how "and" ends up
        // labelling an edge. See LexicalOptions.unknownFrequency.
        unknownFrequency: "skip",
      });
      const signals: WikiLinkSignalInput[] = [];
      for (const hit of hits) {
        const firstChunk = first.find((chunk) => chunk.chunkId === hit.aChunkId);
        const secondChunk = second.find((chunk) => chunk.chunkId === hit.bChunkId);
        if (!firstChunk || !secondChunk) continue;
        signals.push({
          signalType: "lexical",
          // A shared term is not directional: both papers use the word.
          direction: "symmetric",
          algorithmVersion: LEXICAL_ALGORITHM_VERSION,
          score: lexicalScore(hit.idf, liveDocuments),
          specificityWeight: hit.idf,
          breadthDocs: hit.df,
          termSnapshot: hit.term,
          a: {
            chunkIdSnapshot: hit.aChunkId,
            chunkTextHash: await hashWikiText(firstChunk.text),
            excerpt: hit.aExcerpt,
          },
          b: {
            chunkIdSnapshot: hit.bChunkId,
            chunkTextHash: await hashWikiText(secondChunk.text),
            excerpt: hit.bExcerpt,
          },
        });
      }
      return signals;
    } catch (error) {
      // A missing or half-built keyword index costs the lexical half of a
      // scan, not the scan. The semantic candidates are already computed.
      ztoolkit.log("[wiki] lexical link signals unavailable", error);
      return [];
    }
  }

  /**
   * Project shared concepts into the same audit trail as the other two paths.
   *
   * Phase 0B derives concept edges straight from `wiki_concept_term_sources`
   * for the graph, and that stays: an edge nobody has to settle does not need
   * a row. This exists for the edges that DO enter the queue - a shared
   * concept a reader should reconcile like any other candidate - so that all
   * three discovery paths are counted, capped, rejected and audited the same
   * way rather than concepts having a private channel.
   */
  async recordConceptSignals(
    libraryID: number,
    options: { minSharedConcepts?: number } = {},
  ): Promise<{ candidates: number; signals: number }> {
    if (!this.settings().enabled) return { candidates: 0, signals: 0 };
    const links = await this.store.links();
    const projection = await this.store.getConceptDocumentSources(libraryID);
    const settings = this.settings();
    const minimum = Math.max(1, options.minSharedConcepts ?? 1);

    const byPair = new Map<
      string,
      { a: string; b: string; concepts: typeof projection.concepts }
    >();
    for (const concept of projection.concepts) {
      const keys = concept.itemKeys;
      if (keys.length < 2) continue;
      // The same combinatorial guard the graph uses: one term every paper
      // mentions proposes every pair, and a complete graph of candidates would
      // be worse than no candidates at all.
      if (keys.length > 40) continue;
      for (let left = 0; left < keys.length; left += 1) {
        for (let right = left + 1; right < keys.length; right += 1) {
          const a = keys[left] < keys[right] ? keys[left] : keys[right];
          const b = keys[left] < keys[right] ? keys[right] : keys[left];
          const pairKey = `${a} ${b}`;
          const entry =
            byPair.get(pairKey) ?? byPair.set(pairKey, { a, b, concepts: [] }).get(pairKey)!;
          entry.concepts.push(concept);
        }
      }
    }

    let candidates = 0;
    let signals = 0;
    for (const pair of byPair.values()) {
      if (pair.concepts.length < minimum) continue;
      const linkId = await links.upsertCandidate({
        libraryID,
        itemKeyA: pair.a,
        itemKeyB: pair.b,
      });
      candidates += 1;
      const ranked = pair.concepts
        .slice()
        .sort((left, right) => right.idf - left.idf);
      const written = await links.recordSignals({
        linkId,
        cap: settings.anchorsPerType,
        signals: ranked.slice(0, settings.anchorsPerType).map((concept) => ({
          signalType: "concept" as const,
          direction: "symmetric" as const,
          algorithmVersion: CONCEPT_ALGORITHM_VERSION,
          score: Math.min(1, concept.idf / Math.log(projection.documentCount + 2)),
          specificityWeight: concept.idf,
          breadthDocs: concept.df,
          termSnapshot: concept.name,
          // A concept signal has no chunk anchors of its own. The passages are
          // in wiki_concept_term_sources, one per document per term, and
          // duplicating them here would create a second copy to keep in step.
          a: {},
          b: {},
        })),
      });
      signals += written.written;
    }
    return { candidates, signals };
  }

  // ---- Reading the queue --------------------------------------------------

  /**
   * The candidates a write-up should look at, with `mustResolve` decided here.
   *
   * `chunkIds` narrows to the passages this turn read. Without it a
   * question that touched five chunks would be handed every candidate in the
   * library that mentions the paper, which is not a checklist anybody
   * completes - it is a reason to stop using the feature.
   */
  async pendingSignals(options: {
    libraryID: number;
    itemKey: string;
    chunkIds?: readonly number[];
    limit?: number;
  }): Promise<PendingLinkSignalView[]> {
    if (!this.settings().enabled) return [];
    const links = await this.store.links();
    const signals = await links.pendingSignalsForItem(options);
    const views = new Map<number, PendingLinkSignalView>();
    for (const signal of signals) {
      const thisIsA = signal.aItemKey === options.itemKey;
      const otherItemKey = thisIsA ? signal.bItemKey : signal.aItemKey;
      const thisSide = thisIsA ? signal.a : signal.b;
      const otherSide = thisIsA ? signal.b : signal.a;
      const thisRead = await this.chunkIsRead(
        signal.libraryID,
        options.itemKey,
        thisSide.chunkIdSnapshot,
      );
      const otherRead = await this.chunkIsRead(
        signal.libraryID,
        otherItemKey,
        otherSide.chunkIdSnapshot,
      );

      const existing = views.get(signal.linkId);
      const view: PendingLinkSignalView = existing ?? {
        linkId: signal.linkId,
        signalIds: [],
        otherItemKey,
        otherTitle: await this.titleOf(signal.libraryID, otherItemKey),
        scoreAB: signal.scoreAB,
        scoreBA: signal.scoreBA,
        scoreSymmetric: signal.scoreSymmetric,
        signalTypes: [],
        thisChunk: {
          chunkId: thisSide.chunkIdSnapshot,
          excerpt: thisSide.excerpt,
          read: thisRead,
        },
        otherChunk: {
          chunkId: otherSide.chunkIdSnapshot,
          excerpt: otherSide.excerpt,
          read: otherRead,
        },
        mustResolve: false,
        fingerprintState: "valid",
        suggestedLabels: [],
      };
      view.signalIds.push(signal.signalId);
      if (!view.signalTypes.includes(signal.signalType)) {
        view.signalTypes.push(signal.signalType);
      }
      if (signal.priorRejection) {
        (view.priorDismissals ??= []).push({
          signalId: signal.signalId,
          reason: signal.priorRejection,
        });
        if (view.reopenedReason === undefined) {
          const candidate = await links.getCandidate(signal.linkId);
          view.reopenedReason = candidate?.reopenedReason || "";
        }
      }
      if (signal.termSnapshot && !view.suggestedLabels.includes(signal.termSnapshot)) {
        view.suggestedLabels.push(signal.termSnapshot);
      }
      // A pair is mandatory when ANY of its signals is: one reconcilable
      // passage pair is enough to owe an answer, and the answer may of course
      // be that it establishes nothing.
      if (await this.signalIsMandatory(signal)) view.mustResolve = true;
      views.set(signal.linkId, view);
    }
    return Array.from(views.values()).sort(
      (left, right) =>
        Number(right.mustResolve) - Number(left.mustResolve) ||
        (right.scoreSymmetric ?? 0) - (left.scoreSymmetric ?? 0),
    );
  }

  /** Which pending signals of a library are settleable debt right now. */
  async mandatorySignalIds(libraryID: number): Promise<Set<number>> {
    const mandatory = new Set<number>();
    if (!this.settings().mandatorySettlement) return mandatory;
    const links = await this.store.links();
    for (const signal of await links.pendingSignalsForRelink(libraryID)) {
      if (await this.signalIsMandatory(signal)) mandatory.add(signal.signalId);
    }
    return mandatory;
  }

  /**
   * The rule in one place. See the file comment for why it is this and not
   * "both papers have Evidence".
   */
  private async signalIsMandatory(
    signal: WikiLinkSignalWithPair,
  ): Promise<boolean> {
    if (!this.settings().mandatorySettlement) return false;
    if (signal.state !== "pending") return false;
    // A concept signal has no chunk anchors, so there is no specific passage
    // to have read. It stays optional by construction rather than by policy.
    if (signal.a.chunkIdSnapshot == null || signal.b.chunkIdSnapshot == null) {
      return false;
    }
    return (
      (await this.chunkIsRead(
        signal.libraryID,
        signal.aItemKey,
        signal.a.chunkIdSnapshot,
      )) &&
      (await this.chunkIsRead(
        signal.libraryID,
        signal.bItemKey,
        signal.b.chunkIdSnapshot,
      ))
    );
  }

  /**
   * Has this exact passage been read?
   *
   * `paper_reviewed` short-circuits it, in the strict sense only: a completed
   * FULL-TEXT session with a whole-paper synthesis. Sixty questions that
   * between them touched every chunk do not qualify - the same rule Evidence
   * depth uses, and for the same reason.
   */
  private async chunkIsRead(
    libraryID: number,
    itemKey: string,
    chunkId: number | null,
  ): Promise<boolean> {
    if (chunkId == null) return false;
    const sessions = await this.store.readingSessions();
    const coverage = await sessions.coverageForItem(libraryID, itemKey);
    if (
      coverage.mode === "fulltext" &&
      coverage.complete &&
      coverage.finalSynthesisAt !== null
    ) {
      return true;
    }
    return sessions.hasReadChunkId(libraryID, itemKey, chunkId);
  }

  // ---- Settlement ---------------------------------------------------------

  /**
   * Record that a knowledge write settled some signals.
   *
   * Validation is the caller-facing half of the contract, so it refuses
   * loudly: a signal id from another library, an already-settled signal, or a
   * stale one are all mistakes worth a message rather than a silent no-op,
   * because each of them means the model believed it had discharged something
   * it had not.
   */
  async resolveSignals(options: {
    libraryID: number;
    signalIds: readonly number[];
    resolutionType: WikiLinkResolutionType;
    claimId?: number | null;
    pageId?: number | null;
    relationId?: number | null;
    note: string;
    /**
     * One reason per signal, for a `no_action` covering several findings.
     * Absent for every other resolution type: those settle a batch by writing
     * one thing, so one sentence describes all of them truthfully.
     */
    reasonBySignal?: ReadonlyMap<number, string>;
  }): Promise<{ resolutionIds: number[]; settled: number }> {
    const links = await this.store.links();
    const byLink = new Map<number, number[]>();
    for (const rawId of options.signalIds) {
      const signalId = Number(rawId);
      const signal = await links.getSignal(signalId);
      if (!signal) {
        throw new Error(
          `Link signal ${signalId} does not exist. Signal ids come from pendingLinkSignals in wiki_prepare_update.`,
        );
      }
      if (signal.libraryID !== options.libraryID) {
        throw new Error(
          `Link signal ${signalId} belongs to library ${signal.libraryID}, not ${options.libraryID}.`,
        );
      }
      if (signal.state === "stale") {
        throw new Error(
          `Link signal ${signalId} is stale: the text it was computed from has changed, so it cannot be settled. It will be replaced by a fresh signal on the next scan.`,
        );
      }
      if (signal.state !== "pending") {
        throw new Error(
          `Link signal ${signalId} was already settled as "${signal.state}". A signal is settled once; settling it again would record two different conclusions about one finding.`,
        );
      }
      (byLink.get(signal.linkId) ?? byLink.set(signal.linkId, []).get(signal.linkId)!)
        .push(signalId);
    }
    const resolutionIds: number[] = [];
    let settled = 0;
    for (const [linkId, signalIds] of byLink) {
      resolutionIds.push(
        await links.recordResolution({
          linkId,
          resolutionType: options.resolutionType,
          signalIds,
          claimId: options.claimId,
          pageId: options.pageId,
          relationId: options.relationId,
          note: options.note,
          reasonBySignal: options.reasonBySignal,
        }),
      );
      settled += signalIds.length;
    }
    return { resolutionIds, settled };
  }

  /**
   * Reopen dismissed pairs that this commit's Claims have just contradicted.
   *
   * A dismissal says "these two papers cannot support one Claim". A Claim
   * whose Evidence cites both of them is that Claim. The two cannot both
   * stand, and the Claim is the one backed by quoted passages, so the
   * dismissal is the one that goes back in the queue.
   *
   * This is a sweep after the fact rather than a check at dismissal time
   * because the contradiction usually is not available yet when the dismissal
   * is made - in the run that produced this, the dismissal came first and the
   * Claim thirty minutes later, with a Wiki reset in between. The pair is
   * REOPENED and flagged, not silently re-settled: the earlier reader's
   * sentence stays on the signal as its prior rejection and the `no_action`
   * resolution row is left exactly as written, because rewriting an audit
   * trail to agree with a later conclusion is how an audit trail stops being
   * worth keeping.
   */
  async reopenContradictedDismissals(options: {
    libraryID: number;
    claimIds: readonly number[];
  }): Promise<
    Array<{
      linkId: number;
      aItemKey: string;
      bItemKey: string;
      claimId: number;
    }>
  > {
    const claimIds = Array.from(
      new Set(options.claimIds.map((id) => Number(id))),
    ).filter((id) => Number.isInteger(id) && id > 0);
    if (!claimIds.length) return [];
    const links = await this.store.links();
    const dismissed = await links.pairsSettledOnlyByRejection(options.libraryID);
    if (!dismissed.length) return [];

    // Keyed on the pair, so one lookup answers "does any Claim in this commit
    // cite both of these?" for every dismissed pair at once.
    const byPair = new Map<string, { linkId: number; a: string; b: string }>();
    for (const pair of dismissed) {
      byPair.set(`${pair.aItemKey} ${pair.bItemKey}`, {
        linkId: pair.linkId,
        a: pair.aItemKey,
        b: pair.bItemKey,
      });
    }

    const reopened: Array<{
      linkId: number;
      aItemKey: string;
      bItemKey: string;
      claimId: number;
    }> = [];
    const done = new Set<number>();
    for (const claimId of claimIds) {
      const sources = await this.store.claimEvidenceSources(
        claimId,
        options.libraryID,
      );
      if (sources.length < 2) continue;
      const ordered = sources.slice().sort();
      for (let left = 0; left < ordered.length; left += 1) {
        for (let right = left + 1; right < ordered.length; right += 1) {
          const pair = byPair.get(`${ordered[left]} ${ordered[right]}`);
          if (!pair || done.has(pair.linkId)) continue;
          const moved = await links.reopenRejected(
            pair.linkId,
            `Claim ${claimId} cites both ${pair.a} and ${pair.b} as Evidence, which is the shared ` +
              "Claim this pair was dismissed for not being able to support. The dismissal is kept as " +
              "each signal's prior rejection; the pair needs deciding again against the Claim that " +
              "now exists.",
          );
          if (!moved) continue;
          done.add(pair.linkId);
          reopened.push({
            linkId: pair.linkId,
            aItemKey: pair.a,
            bItemKey: pair.b,
            claimId,
          });
        }
      }
    }
    return reopened;
  }

  /** Mandatory signals this commit left unanswered, for the blocking check. */
  async unsettledMandatory(options: {
    libraryID: number;
    itemKeys: ReadonlySet<string>;
    settledSignalIds: ReadonlySet<number>;
  }): Promise<WikiLinkSignalWithPair[]> {
    if (!this.settings().mandatorySettlement) return [];
    const links = await this.store.links();
    const pending = await links.pendingSignalsForRelink(
      options.libraryID,
      Array.from(options.itemKeys),
    );
    const outstanding: WikiLinkSignalWithPair[] = [];
    for (const signal of pending) {
      if (options.settledSignalIds.has(signal.signalId)) continue;
      if (await this.signalIsMandatory(signal)) outstanding.push(signal);
    }
    return outstanding;
  }

  // ---- Maintenance --------------------------------------------------------

  /** Re-verify every pending signal against the live index. */
  async relink(options: {
    libraryID?: number;
    itemKeys?: string[];
  } = {}): Promise<WikiLinkRelinkReport> {
    const links = await this.store.links();
    const vectorStore = getVectorStore();
    await vectorStore.initialize();
    const relinker = new WikiLinkSignalRelinker(
      links,
      {
        sourceExists: async (libraryID, itemKey) => {
          const item = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            itemKey,
          );
          return Boolean(item && !item.deleted && item.isRegularItem?.());
        },
        getChunks: async (libraryID, itemKey) => {
          const [chunks, status] = await Promise.all([
            vectorStore.getChunksForItem(itemKey, libraryID),
            vectorStore.getIndexStatus(itemKey, libraryID),
          ]);
          return chunks.map((chunk) => ({
            chunkId: chunk.chunkId,
            text: chunk.text,
            contentHash: status?.contentHash || "unknown",
          }));
        },
        indexReady: async (libraryID, itemKey) => {
          const status = await vectorStore.getIndexStatus(itemKey, libraryID);
          return bodyIndexStateFromSourceKind(status?.sourceKind) === "body";
        },
      },
      {
        algorithmVersions: this.currentAlgorithmVersions(),
        embeddingModel: String(getEmbeddingService().getConfig().model ?? ""),
      },
    );
    return relinker.relinkPending(options);
  }

  async statistics(libraryID: number): Promise<WikiLinkStatistics> {
    const links = await this.store.links();
    return links.statistics(libraryID, await this.mandatorySignalIds(libraryID));
  }

  // ---- Loading ------------------------------------------------------------

  /** One document as the scanner wants it: chunks, vectors and a fingerprint. */
  private async loadScanDocument(
    libraryID: number,
    itemKey: string,
  ): Promise<ScanDocument | null> {
    const vectorStore = getVectorStore();
    const [chunks, vectors, status, resetGeneration] = await Promise.all([
      vectorStore.getChunksForItem(itemKey, libraryID),
      vectorStore.getItemVectors(itemKey, libraryID),
      vectorStore.getIndexStatus(itemKey, libraryID),
      vectorStore.getCommittedResetGeneration(),
    ]);
    if (!chunks.length || !vectors.length) return null;
    // A metadata-only index is a title and an abstract. Every paper's abstract
    // resembles every other paper's abstract in the same field, so scanning
    // one would manufacture candidates that say nothing about the papers.
    if (bodyIndexStateFromSourceKind(status?.sourceKind) !== "body") return null;
    const vectorByChunkId = new Map(
      vectors.map((entry) => [entry.chunkId, entry.vector]),
    );
    return {
      itemKey,
      libraryID,
      chunks: chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        text: chunk.text,
        vector: vectorByChunkId.get(chunk.chunkId) ?? null,
      })),
      fingerprint: {
        contentHash: status?.contentHash || "unknown",
        chunkSignature: getStoredChunkingSignature(libraryID) || "unknown",
        resetGeneration: resetGeneration || "none",
      },
    };
  }

  /** N for the IDF and breadth arithmetic: indexed documents, not imports. */
  private async libraryDocumentCount(libraryID: number): Promise<number> {
    try {
      const keywordStore = getVectorStore().getKeywordIndexStore();
      const count = await keywordStore.liveDocumentCount(libraryID);
      if (count > 0) return count;
    } catch (error) {
      ztoolkit.log("[wiki] keyword document count unavailable", error);
    }
    // The keyword index may not exist. Falling back to the reading ledger
    // under-counts, which makes every weight more conservative rather than
    // less - the safe direction for a number that gates what gets stored.
    const sessions = await this.store.readingSessions();
    const seen = new Set(
      (await sessions.list(libraryID, 500)).map((session) => session.itemKey),
    );
    return Math.max(1, seen.size);
  }

  private async titleOf(libraryID: number, itemKey: string): Promise<string> {
    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        libraryID,
        itemKey,
      );
      const title =
        item?.getDisplayTitle?.() || item?.getField?.("title") || "";
      return String(title || itemKey);
    } catch {
      return itemKey;
    }
  }

  /** The selector version stamped on candidates, for status reporting. */
  static readonly SELECTOR_VERSION = REPRESENTATIVE_SELECTOR_VERSION;
}
