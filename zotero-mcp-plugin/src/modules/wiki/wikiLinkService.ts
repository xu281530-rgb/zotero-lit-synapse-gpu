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
    }
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
      const first = aIsFirst ? a : b;
      const second = aIsFirst ? b : a;
      const liveDocuments =
        (await keywordStore.liveDocumentCount(libraryID)) || documentCount;
      // Shared terms are found first, then their frequencies looked up in one
      // batch: asking the index for every term of two papers would be a query
      // per token for a set that is mostly discarded.
      const provisional = sharedRareTerms(
        first.chunks,
        second.chunks,
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
      const hits = sharedRareTerms(first.chunks, second.chunks, frequencies, {
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
        const firstChunk = first.chunks.find(
          (chunk) => chunk.chunkId === hit.aChunkId,
        );
        const secondChunk = second.chunks.find(
          (chunk) => chunk.chunkId === hit.bChunkId,
        );
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
        }),
      );
      settled += signalIds.length;
    }
    return { resolutionIds, settled };
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
        algorithmVersions: {
          semantic: LINK_ALGORITHM_VERSION,
          lexical: LEXICAL_ALGORITHM_VERSION,
          concept: CONCEPT_ALGORITHM_VERSION,
        },
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
