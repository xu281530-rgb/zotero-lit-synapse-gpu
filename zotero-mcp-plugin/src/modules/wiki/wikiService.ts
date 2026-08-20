import { getStoredChunkingSignature } from "../hybridSearchSettings";
import { bodyIndexStateFromSourceKind } from "../semantic/bodyIndexState";
import { getEmbeddingService } from "../semantic/embeddingService";
import { getVectorStore } from "../semantic/vectorStore";
import {
  hashWikiText,
  normalizeWikiName,
  normalizeWikiText,
} from "./wikiCanonicalizer";
import { WikiEvidenceRelinker } from "./wikiEvidenceRelinker";
import { rowColumn } from "./wikiRow";
import type { WikiReadingAbandonOutcome } from "./wikiReadingSession";
import type { WikiEmbeddingWorkUnit } from "./wikiEmbeddingQueue";
import {
  decodeChunkCursor,
  encodeChunkCursor,
  resolvePageSize,
} from "../documentChunks";
import { renderWikiMarkdown } from "./wikiRenderer";
import { WikiRetriever } from "./wikiRetriever";
import { getWikiStore, type WikiStore } from "./wikiStore";
import {
  WIKI_READ_DEPTHS,
  type WikiCoverageLevel,
  type WikiCommitAction,
  type WikiCommitInput,
  type WikiCommitResult,
  type WikiEvidenceInput,
  type WikiReadDepth,
  type WikiSourceChunk,
} from "./wikiTypes";

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

export interface WikiServiceSearchResult {
  claims: any[];
  documents: any[];
  relations: any[];
  directCount: number;
  oneHopCount: number;
  vectorSearchUsed: boolean;
  warnings: string[];
}

function clampCoverageToVerifiedEvidence(
  coverageLevel: WikiCoverageLevel,
  evidence: WikiEvidenceInput[],
): WikiCoverageLevel {
  const requestedDepth = WIKI_READ_DEPTHS.findIndex(
    (depth) => depth === coverageLevel,
  );
  if (requestedDepth < 0 || !evidence.length) return coverageLevel;

  let verifiedDepth = evidence.reduce((best, entry) => {
    const depth = WIKI_READ_DEPTHS.indexOf(entry.readDepth);
    return Math.max(best, depth);
  }, 0);
  if (coverageLevel === "cross_paper") {
    const crossPaperSources = new Set(
      evidence
        .filter((entry) => entry.readDepth === "cross_paper")
        .map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    if (crossPaperSources.size < 2) {
      verifiedDepth = evidence.reduce((best, entry) => {
        const depth = WIKI_READ_DEPTHS.indexOf(entry.readDepth);
        return Math.max(best, Math.min(depth, 2));
      }, 0);
    }
  }
  return WIKI_READ_DEPTHS[Math.min(requestedDepth, verifiedDepth)];
}

export class WikiService {
  private readonly store: WikiStore;
  private readonly retriever: WikiRetriever;
  private readonly prepareTokens = new Map<
    string,
    {
      libraryID: number;
      expiresAt: number;
      preparedPageTitles: Set<string>;
    }
  >();

  constructor(store: WikiStore = getWikiStore()) {
    this.store = store;
    this.retriever = new WikiRetriever(store);
  }

  private prunePrepareTokens(): void {
    const now = Date.now();
    for (const [token, prepared] of this.prepareTokens) {
      if (prepared.expiresAt < now) this.prepareTokens.delete(token);
    }
  }

  async prepareUpdate(options: {
    libraryID: number;
    query: string;
    limit?: number;
    proposedPageTitles?: string[];
  }): Promise<any> {
    this.prunePrepareTokens();
    const exactCandidates = await this.store.prepareUpdate(options);
    const semanticCandidates = await this.search({
      ...options,
      minScore: 0,
      useVector: true,
    });
    const proposedPageTitles = Array.from(
      new Set(
        (options.proposedPageTitles?.length
          ? options.proposedPageTitles
          : [options.query]
        )
          .map((title) => normalizeWikiText(title))
          .filter(Boolean),
      ),
    );
    if (proposedPageTitles.length > 2) {
      throw new Error(
        "wiki_prepare_update accepts at most 2 proposed Page titles",
      );
    }
    const pagePreparations = [];
    for (const title of proposedPageTitles) {
      if (normalizeWikiName(title) === normalizeWikiName(options.query)) {
        pagePreparations.push({
          canonicalTitle: title,
          ...exactCandidates,
          semanticClaims: semanticCandidates.claims.slice(
            0,
            options.limit ?? 10,
          ),
        });
        continue;
      }
      const [exact, semantic] = await Promise.all([
        this.store.prepareUpdate({ ...options, query: title }),
        this.search({
          ...options,
          query: title,
          minScore: 0,
          useVector: true,
        }),
      ]);
      pagePreparations.push({
        canonicalTitle: title,
        ...exact,
        semanticClaims: semantic.claims.slice(0, options.limit ?? 10),
      });
    }
    // Preparing is the second state of the reading state machine: the paper has
    // been read and its write is being planned. Recording it means a crash
    // between prepare and commit still shows the paper as unfinished rather
    // than as never started.
    const sessions = await this.store.readingSessions();
    const openSession = await sessions.getOpen(options.libraryID);
    if (openSession) await sessions.markPrepared(openSession.sessionId);

    const prepareToken = `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 14)}`;
    this.prepareTokens.set(prepareToken, {
      libraryID: options.libraryID,
      expiresAt: Date.now() + 10 * 60 * 1000,
      preparedPageTitles: new Set(proposedPageTitles.map(normalizeWikiName)),
    });
    return {
      ...exactCandidates,
      semanticClaims: semanticCandidates.claims.slice(0, options.limit ?? 10),
      semanticWarnings: semanticCandidates.warnings,
      searched: ["title", "alias", "concept", "claim", "embedding"],
      preparedPageTitles: proposedPageTitles,
      pagePreparations,
      prepareToken,
      prepareTokenExpiresInSeconds: 600,
      ...(openSession
        ? {
            readingSession: {
              sessionId: openSession.sessionId,
              itemKey: openSession.itemKey,
              state: "prepared",
            },
          }
        : {}),
    };
  }

  async getPage(pageId: number): Promise<any> {
    const page = await this.store.getPage(pageId);
    if (!page) return null;
    const snapshot = await this.store.getRetrievalSnapshot(page.libraryID);
    const concept =
      page.primaryConceptId == null
        ? null
        : (snapshot.concepts.find(
            (row) =>
              Number(rowColumn(row, "concept_id", "conceptId")) ===
              page.primaryConceptId,
          ) ?? null);
    const aliases =
      page.primaryConceptId == null
        ? []
        : snapshot.aliases.filter(
            (row) =>
              Number(rowColumn(row, "concept_id", "conceptId")) ===
              page.primaryConceptId,
          );
    const relations =
      page.primaryConceptId == null
        ? []
        : snapshot.relations.filter(
            (row) =>
              Number(rowColumn(row, "source_concept_id", "sourceConceptId")) ===
                page.primaryConceptId ||
              Number(rowColumn(row, "target_concept_id", "targetConceptId")) ===
                page.primaryConceptId,
          );
    return { ...page, primaryConcept: concept, aliases, relations };
  }

  private async hydrateEvidence(
    entry: any,
    libraryID: number,
    warnings: string[],
  ): Promise<WikiEvidenceInput> {
    if (Number(entry.libraryID ?? libraryID) !== libraryID) {
      throw new Error("Evidence must belong to the Wiki page's library");
    }
    const itemKey = String(entry.itemKey ?? "").trim();
    if (!itemKey) throw new Error("Evidence itemKey is required");
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
    if (!item || item.deleted || !item.isRegularItem?.()) {
      throw new Error(
        `Evidence source ${libraryID}:${itemKey} is missing or is not a Zotero document`,
      );
    }
    const vectorStore = getVectorStore();
    await vectorStore.initialize();
    const chunks = await vectorStore.getChunksForItem(itemKey, libraryID);
    if (!chunks.length) {
      throw new Error(
        `Evidence source ${itemKey} has no indexed chunks; build the search index first`,
      );
    }
    const excerpt = normalizeWikiText(String(entry.excerpt ?? ""));
    if (!excerpt) throw new Error("Evidence excerpt is required");
    let chunk = chunks.find(
      (candidate) => candidate.chunkId === Number(entry.chunkIdSnapshot),
    );
    if (!chunk || !normalizeWikiText(chunk.text).includes(excerpt)) {
      chunk = chunks.find((candidate) =>
        normalizeWikiText(candidate.text).includes(excerpt),
      );
    }
    if (!chunk) {
      throw new Error(
        `Evidence excerpt could not be verified in ${itemKey}'s indexed chunks`,
      );
    }
    const status = await vectorStore.getIndexStatus(itemKey, libraryID);
    const bodyState = bodyIndexStateFromSourceKind(status?.sourceKind);
    const resetGeneration = await vectorStore.getCommittedResetGeneration();
    return {
      libraryID,
      itemKey,
      chunkIdSnapshot: chunk.chunkId,
      chunkTextHash: await hashWikiText(chunk.text),
      sourceContentHash: status?.contentHash || "unknown",
      sourceChunkSignature: getStoredChunkingSignature(libraryID) || "unknown",
      sourceResetGeneration: resetGeneration || "none",
      excerpt,
      evidenceRole: entry.evidenceRole,
      readDepth: await this.verifiedReadDepth(
        entry.readDepth,
        libraryID,
        itemKey,
        bodyState,
        warnings,
      ),
      readDepthCeiling: bodyState === "body" ? undefined : "chunk_local",
    };
  }

  /**
   * The deepest read_depth the SERVER can stand behind for this evidence.
   *
   * `paper_reviewed` and `cross_paper` both assert that a whole paper was
   * read. That used to be accepted purely because the model said so, so a
   * claim citing one chunk of a 181-chunk paper was stored at full-paper
   * depth. The reading-session ledger records which chunk indexes were
   * actually DELIVERED, and a whole-paper depth is only honoured when delivery
   * covered the document.
   *
   * This does not claim to measure comprehension - nothing can. It proves the
   * one thing that is provable: the model was given every chunk. Anything
   * short of that is clamped to `section_read` and reported, rather than
   * rejected, so a partially-read paper still contributes its real evidence
   * instead of losing the whole commit.
   */
  private async verifiedReadDepth(
    requested: WikiReadDepth,
    libraryID: number,
    itemKey: string,
    bodyState: string,
    warnings: string[],
  ): Promise<WikiReadDepth> {
    if (bodyState !== "body") return "chunk_local";
    if (requested !== "paper_reviewed" && requested !== "cross_paper") {
      return requested;
    }
    const sessions = await this.store.readingSessions();
    const coverage = await sessions.coverageForItem(libraryID, itemKey);
    if (coverage.complete) return requested;
    const read =
      coverage.sessionId === null
        ? "no reading session recorded"
        : `only ${coverage.deliveredChunks} of ${coverage.totalChunks} chunks delivered`;
    warnings.push(
      `Evidence from ${itemKey} asked for read_depth "${requested}", but the server has ${read}. ` +
        `It was stored as "section_read". Read the whole paper through wiki_build_from_paper ` +
        `(follow pagination.nextCursor to the end) before claiming whole-paper depth.`,
    );
    return "section_read";
  }

  private async hydrateActions(
    actions: WikiCommitAction[],
    libraryID: number,
  ): Promise<{ actions: WikiCommitAction[]; warnings: string[] }> {
    const hydrated: WikiCommitAction[] = [];
    const warnings: string[] = [];
    for (const action of actions) {
      if (
        action.action !== "ADD_CLAIM" &&
        action.action !== "ATTACH_EVIDENCE" &&
        action.action !== "MARK_CONFLICT" &&
        !(action.action === "UPDATE_CLAIM" && action.evidence?.length)
      ) {
        hydrated.push(action);
        continue;
      }
      const evidence: WikiEvidenceInput[] = [];
      for (const entry of action.evidence ?? []) {
        evidence.push(
          await this.hydrateEvidence(entry, libraryID, warnings),
        );
      }
      if (action.action === "ADD_CLAIM") {
        hydrated.push({
          ...action,
          coverageLevel: clampCoverageToVerifiedEvidence(
            action.coverageLevel,
            evidence,
          ),
          evidence,
        } as WikiCommitAction);
      } else if (action.action === "UPDATE_CLAIM" && action.coverageLevel) {
        hydrated.push({
          ...action,
          coverageLevel: clampCoverageToVerifiedEvidence(
            action.coverageLevel,
            evidence,
          ),
          evidence,
        } as WikiCommitAction);
      } else {
        hydrated.push({ ...action, evidence } as WikiCommitAction);
      }
    }
    return { actions: hydrated, warnings };
  }

  async commit(input: WikiCommitInput): Promise<
    WikiCommitResult & {
      warnings: string[];
      /** Always true on return: the database transaction is durable. */
      committed: true;
      /** Claims whose vector is queued rather than built yet. */
      embeddingPending: number;
      embeddingNote?: string;
    }
  > {
    this.prunePrepareTokens();
    if (input.actions.some((action) => action.action === "CREATE_PAGE")) {
      const prepared = input.prepareToken
        ? this.prepareTokens.get(input.prepareToken)
        : undefined;
      if (
        !prepared ||
        prepared.libraryID !== input.libraryID ||
        prepared.expiresAt < Date.now()
      ) {
        throw new Error(
          "CREATE_PAGE requires a current wiki_prepare_update token for this library",
        );
      }
      for (const action of input.actions) {
        if (
          action.action === "CREATE_PAGE" &&
          !prepared.preparedPageTitles.has(
            normalizeWikiName(action.canonicalTitle),
          )
        ) {
          throw new Error(
            `CREATE_PAGE requires its prepared Page title: ${action.canonicalTitle}`,
          );
        }
      }
      this.prepareTokens.delete(input.prepareToken!);
    }
    const { actions, warnings } = await this.hydrateActions(
      input.actions,
      input.libraryID,
    );

    // THE DURABLE BOUNDARY. When this resolves the write is permanent, and the
    // vectors those claims still need are queued in the same transaction. The
    // caller is answered from here; embedding happens afterwards, off the
    // request, so a slow or broken embedding backend can no longer turn a
    // successful commit into a client-side timeout of unknown outcome.
    const result = await this.store.commit({ ...input, actions });

    const readingSession = await this.settleReadingSession(input, actions);

    const queue = await this.store.embeddingQueue();
    const embeddingPending = await queue.pendingCount();
    // Kick the drain but do not wait for it: its outcome cannot change the
    // fact that the commit succeeded.
    void this.pumpEmbeddingQueue();

    return {
      ...result,
      warnings,
      committed: true,
      embeddingPending,
      embeddingNote:
        embeddingPending > 0
          ? `The Wiki write is committed and permanent. ${embeddingPending} claim embedding(s) are queued and will be built in the background; Wiki keyword retrieval already sees these claims, and semantic retrieval will once the queue drains. Nothing needs to be re-submitted.`
          : undefined,
      ...(readingSession ? { readingSession } : {}),
    };
  }

  /**
   * Decide what this commit does to the open reading session.
   *
   * A commit ENDS a paper only when the whole paper has been delivered.
   * Committing partway through is a legitimate checkpoint - evidence already
   * read is real evidence and should not be held hostage to finishing the
   * paper - but it must not be mistaken for finishing it. If a partial commit
   * released the library, a model could bank one claim from page 3 of a
   * 181-chunk paper and move on to the next paper, which is precisely the
   * batch-run failure the session was introduced to stop.
   *
   * So: coverage complete -> `committed`, library released. Coverage
   * incomplete -> the write stands, the session drops back to `reading` and
   * KEEPS the library. The only early exits are the explicit ones, through
   * `wiki_finish_reading`.
   */
  private async settleReadingSession(
    input: WikiCommitInput,
    actions: WikiCommitAction[],
  ): Promise<
    | {
        sessionId: number;
        itemKey: string;
        state: string;
        released: boolean;
        deliveredChunks: number;
        totalChunks: number;
        coverageComplete: boolean;
        note: string;
      }
    | undefined
  > {
    const sessions = await this.store.readingSessions();
    const open = await sessions.getOpen(input.libraryID);
    if (!open) return undefined;

    const citedKeys = new Set<string>();
    for (const action of actions) {
      for (const entry of (action as any).evidence ?? []) {
        if (entry?.itemKey) citedKeys.add(String(entry.itemKey));
      }
    }
    const concernsOpenPaper =
      input.readingSessionId === open.sessionId || citedKeys.has(open.itemKey);

    const coverage = await sessions.coverage(open.sessionId);
    const base = {
      sessionId: open.sessionId,
      itemKey: open.itemKey,
      deliveredChunks: coverage.deliveredChunks,
      totalChunks: coverage.totalChunks,
      coverageComplete: coverage.complete,
    };

    if (!concernsOpenPaper) {
      return {
        ...base,
        state: open.state,
        released: false,
        note: `This commit did not cite ${open.itemKey}, which is still open. Finish it before starting another paper.`,
      };
    }

    if (coverage.complete) {
      await sessions.close(open.sessionId, "committed");
      return {
        ...base,
        state: "committed",
        released: true,
        note: `Paper ${open.itemKey} was fully read and is now closed. The library is free for the next paper.`,
      };
    }

    await sessions.markReading(open.sessionId);
    return {
      ...base,
      state: "reading",
      released: false,
      note:
        `The claims are committed and permanent, but ${open.itemKey} is NOT finished: ` +
        `${coverage.deliveredChunks} of ${coverage.totalChunks} chunks have been delivered, ` +
        `so it keeps the library and no other paper can be started yet. Either keep reading it with ` +
        `wiki_build_from_paper (resume at chunk index ${coverage.firstMissingIndex ?? coverage.deliveredChunks}) ` +
        `and commit the rest, or close it deliberately with wiki_finish_reading and outcome "skipped".`,
    };
  }

  /**
   * Explicitly finish the open paper without writing anything.
   *
   * "I read it and it is not worth a Wiki page" is a normal outcome, not a
   * failure, and the one-paper-at-a-time rule needs a way to express it.
   */
  async finishReading(options: {
    libraryID: number;
    itemKey?: string;
    outcome: WikiReadingAbandonOutcome;
    note?: string;
  }): Promise<any> {
    if (options.outcome !== "skipped" && options.outcome !== "failed") {
      throw new Error(
        'finishReading only accepts "skipped" or "failed". A paper becomes "committed" by being read in full and committed, never by being declared finished.',
      );
    }
    const sessions = await this.store.readingSessions();
    const open = await sessions.getOpen(options.libraryID);
    if (!open) {
      return {
        closed: false,
        message: "No paper is currently open for this library.",
      };
    }
    if (options.itemKey && options.itemKey.trim() !== open.itemKey) {
      throw new Error(
        `The open paper is ${open.itemKey}, not ${options.itemKey.trim()}. Pass that itemKey, or omit itemKey to close whatever is open.`,
      );
    }
    const coverage = await sessions.coverage(open.sessionId);
    await sessions.close(open.sessionId, options.outcome, options.note ?? "");
    return {
      closed: true,
      itemKey: open.itemKey,
      outcome: options.outcome,
      chunksRead: coverage.deliveredChunks,
      totalChunks: coverage.totalChunks,
      message: `Paper ${open.itemKey} closed as ${options.outcome}. The library is free for the next paper.`,
    };
  }

  /**
   * Work the embedding queue.
   *
   * Public so the plugin can schedule it and so tests can drive it
   * deterministically instead of waiting on a timer.
   */
  async pumpEmbeddingQueue(
    options: { limit?: number } = {},
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    const queue = await this.store.embeddingQueue();
    return queue.drain(
      (unit: WikiEmbeddingWorkUnit) => this.embedQueuedClaim(unit),
      options,
    );
  }

  private async embedQueuedClaim(unit: WikiEmbeddingWorkUnit): Promise<void> {
    const embeddingService = getEmbeddingService();
    const embeddingModel = embeddingService.getConfig().model;
    const embedded = await embeddingService.embed(unit.claimText, "auto", false);
    await this.store.saveClaimEmbedding({
      claimId: unit.claimId,
      vector: embedded.embedding,
      model: embeddingModel,
      textHash: await hashWikiText(unit.claimText),
    });
  }

  async search(options: {
    libraryID: number;
    query: string;
    keywords?: string[];
    itemKeys?: string[];
    minScore?: number;
    limit?: number | null;
    useVector?: boolean;
  }): Promise<WikiServiceSearchResult> {
    const warnings: string[] = [];
    let queryVector: Float32Array | undefined;
    let queryVectorModel: string | undefined;
    if (options.useVector !== false) {
      try {
        const embeddingService = getEmbeddingService();
        queryVectorModel = embeddingService.getConfig().model;
        queryVector = (
          await embeddingService.embed(options.query, "auto", true)
        ).embedding;
      } catch (error) {
        warnings.push(
          `Wiki vector search unavailable; Concept/Alias/Claim/Relation keyword retrieval still ran: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const result = await this.retriever.search({
      ...options,
      queryVector,
      queryVectorModel,
    });
    return { ...result, vectorSearchUsed: Boolean(queryVector), warnings };
  }

  async reverify(libraryID?: number, itemKeys?: string[]): Promise<any> {
    const vectorStore = getVectorStore();
    await vectorStore.initialize();
    const deletedSources = await this.store.listDeletedEvidenceSources(
      libraryID,
      itemKeys,
    );
    for (const source of deletedSources) {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        source.libraryID,
        source.itemKey,
      );
      if (item && !item.deleted && item.isRegularItem?.()) {
        await this.store.markItemsPending(
          `restored-${Date.now()}`,
          source.libraryID,
          [source.itemKey],
        );
      }
    }
    const relinker = new WikiEvidenceRelinker(this.store, {
      sourceExists: async (sourceLibraryID, itemKey) => {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          sourceLibraryID,
          itemKey,
        );
        return Boolean(item && !item.deleted && item.isRegularItem?.());
      },
      getChunks: async (
        sourceLibraryID,
        itemKey,
      ): Promise<WikiSourceChunk[]> => {
        const [chunks, status, generation] = await Promise.all([
          vectorStore.getChunksForItem(itemKey, sourceLibraryID),
          vectorStore.getIndexStatus(itemKey, sourceLibraryID),
          vectorStore.getCommittedResetGeneration(),
        ]);
        return chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          text: chunk.text,
          contentHash: status?.contentHash || "unknown",
          chunkSignature:
            getStoredChunkingSignature(sourceLibraryID) || "unknown",
          resetGeneration: generation || "none",
        }));
      },
      indexReadyForRelink: async (sourceLibraryID, itemKey) => {
        const status = await vectorStore.getIndexStatus(
          itemKey,
          sourceLibraryID,
        );
        return bodyIndexStateFromSourceKind(status?.sourceKind) === "body";
      },
    });
    return relinker.relinkPending({ libraryID, itemKeys });
  }

  async exportMarkdown(libraryID: number): Promise<string> {
    const [pages, snapshot] = await Promise.all([
      this.store.listPages(libraryID),
      this.store.getRetrievalSnapshot(libraryID),
    ]);
    return renderWikiMarkdown(pages, snapshot);
  }

  /**
   * Read ONE paper for a Wiki build, one page at a time.
   *
   * This used to hand back the entire document when `includeAllChunks` was
   * set. On the reference library that was up to 181 chunks and ~63k tokens in
   * a single MCP response — nine times the ceiling `get_document_chunks`
   * enforces on the very same text, and the exact bypass that tool's paging
   * was introduced to remove. In practice the client spooled the response to
   * disk, mis-read it back, and abandoned the paper. `includeAllChunks` is now
   * refused; reading is paged, and the page shape is the one
   * `get_document_chunks` already uses, cursor encoding included, so there is
   * one paging model in the server rather than two.
   *
   * Every page delivered is recorded against the paper's reading session, so
   * `paper_reviewed` becomes a fact the server can check rather than a claim it
   * has to take on faith. Opening a second paper while one is unfinished is
   * refused, with the open paper named.
   */
  async buildFromPaper(options: {
    libraryID: number;
    userRequested: boolean;
    itemKey?: string;
    doi?: string;
    url?: string;
    title?: string;
    cursor?: string;
    offset?: unknown;
    limit?: unknown;
    includeAllChunks?: boolean;
  }): Promise<any> {
    if (options.userRequested !== true) {
      throw new Error(
        "wiki_build_from_paper is allowed only after an explicit user request",
      );
    }
    if (options.includeAllChunks === true) {
      throw new Error(
        "includeAllChunks was removed: it returned an entire paper — up to hundreds of chunks and tens of thousands of tokens — in one response, which is what made long papers unreadable. " +
          "Call wiki_build_from_paper without it to get the first page, then keep calling it with cursor set to pagination.nextCursor until pagination.hasMore is false. " +
          "pagination.coverageComplete tells you when the whole paper has been delivered, which is what wiki_commit requires before it will record paper_reviewed.",
      );
    }

    // A cursor already names its document; a fresh call has to resolve one.
    let itemKey = "";
    let libraryID = options.libraryID;
    let offset = 0;
    let pageSize = resolvePageSize(options.limit);
    let servedFromCursor = false;

    if (typeof options.cursor === "string" && options.cursor.trim()) {
      const cursor = decodeChunkCursor(options.cursor.trim());
      if (
        options.itemKey &&
        options.itemKey.trim() &&
        options.itemKey.trim() !== cursor.k
      ) {
        throw new Error(
          `cursor continues ${cursor.k} but itemKey says ${options.itemKey.trim()}. Drop the cursor to start ${options.itemKey.trim()} from the beginning, or drop itemKey to continue ${cursor.k}.`,
        );
      }
      itemKey = cursor.k;
      libraryID = cursor.l;
      offset = cursor.o;
      pageSize = options.limit === undefined ? cursor.s : pageSize;
      servedFromCursor = true;
    }

    const item = servedFromCursor
      ? await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey)
      : await this.resolveTargetPaper(options);
    if (!item || item.deleted || !item.isRegularItem?.()) {
      throw new Error(
        "The explicitly selected target is not an available Zotero document",
      );
    }
    itemKey = item.key;

    const vectorStore = getVectorStore();
    await vectorStore.initialize();
    const [chunks, indexStatus] = await Promise.all([
      vectorStore.getChunksForItem(itemKey, libraryID),
      vectorStore.getIndexStatus(itemKey, libraryID),
    ]);
    const bodyState = bodyIndexStateFromSourceKind(indexStatus?.sourceKind);
    if (bodyState !== "body") {
      throw new Error(
        `The selected paper has only metadata/abstract chunks or its body-text index is not confirmed (index state: ${bodyState}); successfully build its body search index first`,
      );
    }
    if (!chunks.length) {
      throw new Error(
        "The selected paper has no indexed chunks; build its search index first",
      );
    }

    const title = String(item.getField("title") || "");

    // Opening the session is what enforces one paper at a time. It throws
    // WikiReadingSessionConflict when a different paper is still unfinished.
    const sessions = await this.store.readingSessions();
    const session = await sessions.startOrContinue({
      libraryID,
      itemKey,
      title,
      totalChunks: chunks.length,
    });

    if (!servedFromCursor) {
      const requested = Number(options.offset);
      offset =
        Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
    }
    offset = Math.min(offset, chunks.length);

    const page = chunks.slice(offset, offset + pageSize);
    const rows = page.map((chunk, index) => ({
      chunkIndex: offset + index,
      chunkId: chunk.chunkId,
      chars: chunk.text.length,
      ...(chunk.language ? { language: chunk.language } : {}),
      text: chunk.text,
    }));

    await sessions.recordDelivery(
      session.sessionId,
      rows.map((row) => ({ chunkIndex: row.chunkIndex, chunkId: row.chunkId })),
    );
    const coverage = await sessions.coverage(session.sessionId);

    const end = offset + rows.length;
    const hasMore = end < chunks.length;
    const range = rows.length === 0 ? "none" : `${offset + 1}-${end}`;

    const existing = await this.store.prepareUpdate({
      libraryID,
      query: title || itemKey,
      limit: 20,
    });

    return {
      explicitUserRequestVerified: true,
      target: {
        libraryID,
        itemKey,
        title,
        doi: String(item.getField("DOI") || ""),
        url: String(item.getField("url") || ""),
      },
      readingSession: {
        sessionId: session.sessionId,
        state: session.state,
        startedAt: session.startedAt,
      },
      chunkCount: chunks.length,
      pagination: {
        totalChunks: chunks.length,
        returned: rows.length,
        offset,
        range,
        pageSize,
        hasMore,
        ...(hasMore
          ? {
              nextCursor: encodeChunkCursor({
                k: itemKey,
                l: libraryID,
                o: end,
                s: pageSize,
              }),
            }
          : {}),
        servedFromCursor,
        // The two numbers that decide whether paper_reviewed is allowed.
        deliveredChunks: coverage.deliveredChunks,
        remainingChunks: coverage.remainingChunks,
        coverageComplete: coverage.complete,
        ...(coverage.firstMissingIndex === null
          ? {}
          : { firstMissingChunkIndex: coverage.firstMissingIndex }),
      },
      chunks: rows,
      coverageInstruction: coverage.complete
        ? "Every chunk of this paper has been delivered, so paper_reviewed is available for evidence from it. Use it only if you actually read them."
        : `${coverage.deliveredChunks} of ${coverage.totalChunks} chunks delivered. wiki_commit will store evidence from this paper as section_read at best until the whole paper has been delivered; keep paging with pagination.nextCursor, or submit chunk_local / section_read / partial / incomplete now.`,
      nextStep: hasMore
        ? `You have read chunks ${range} of ${chunks.length}. Continue with cursor set to pagination.nextCursor and nothing else changed. When you are done reading — whether or not you read it all — finish this paper before starting another: call wiki_prepare_update then wiki_commit to write it, or wiki_finish_reading with outcome "skipped" to close it without writing.`
        : `That is the whole paper: ${chunks.length} chunk(s). Call wiki_prepare_update, then submit only controlled actions to wiki_commit. If you decide not to write it up, close it with wiki_finish_reading and outcome "skipped".`,
      existingWikiCandidates: existing,
    };
  }

  /** Resolve the one paper named by itemKey, DOI, URL or title. */
  private async resolveTargetPaper(options: {
    libraryID: number;
    itemKey?: string;
    doi?: string;
    url?: string;
    title?: string;
  }): Promise<any> {
    const selectors = [
      options.itemKey,
      options.doi,
      options.url,
      options.title,
    ].filter((value) => typeof value === "string" && value.trim());
    if (selectors.length !== 1) {
      throw new Error(
        "Specify exactly one target paper: itemKey, DOI, URL, or title",
      );
    }
    if (options.itemKey) {
      return Zotero.Items.getByLibraryAndKeyAsync(
        options.libraryID,
        options.itemKey.trim(),
      );
    }
    const search = new Zotero.Search();
    search.libraryID = options.libraryID;
    if (options.doi) search.addCondition("DOI", "is", options.doi.trim());
    if (options.url) search.addCondition("url", "is", options.url.trim());
    if (options.title)
      search.addCondition("title", "contains", options.title.trim());
    const ids = await search.search();
    const matches = (Zotero.Items.get(ids) as any[]).filter(
      (candidate) => candidate?.isRegularItem?.() && !candidate.deleted,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Target paper selector resolved to ${matches.length} Zotero items; use itemKey to disambiguate`,
      );
    }
    return matches[0];
  }

  getStore(): WikiStore {
    return this.store;
  }
}

let singleton: WikiService | null = null;

export function getWikiService(): WikiService {
  singleton ??= new WikiService();
  return singleton;
}

export function resetWikiService(): void {
  singleton = null;
}
