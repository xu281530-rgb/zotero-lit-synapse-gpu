import { getStoredChunkingSignature } from "../hybridSearchSettings";
import { bodyIndexStateFromSourceKind } from "../semantic/bodyIndexState";
import { getEmbeddingService } from "../semantic/embeddingService";
import { getVectorStore } from "../semantic/vectorStore";
import {
  hashWikiText,
  normalizeWikiName,
  normalizeWikiText,
} from "./wikiCanonicalizer";
import {
  mapWikiAliasRow,
  mapWikiConceptRow,
  mapWikiRelationRow,
} from "./wikiDto";
import { WikiEvidenceRelinker } from "./wikiEvidenceRelinker";
import {
  WIKI_MAX_OUTSTANDING_BATCHES,
  WikiReadingIntegrationRequired,
  integrationDebt,
  type WikiReadingAbandonOutcome,
  type WikiReadingSessionRecord,
} from "./wikiReadingSession";
import {
  WIKI_EXPERT_OPEN_SCOPE_MANDATE,
  WIKI_READING_NOTE_SCHEMA,
  WikiReadingNoteStore,
  assertHolisticBody,
  formatChunkRanges,
  parseReadingNote,
  renderReadingNote,
  stripMachineBlock,
  type WikiReadingExpert,
  type WikiReadingNoteMetadata,
  type WikiReadingNoteStatus,
} from "./wikiReadingNote";
import type { WikiEmbeddingWorkUnit } from "./wikiEmbeddingQueue";
import {
  decodeChunkCursor,
  encodeChunkCursor,
  resolvePageSize,
} from "../documentChunks";
import { renderWikiMarkdown } from "./wikiRenderer";
import { WikiRetriever } from "./wikiRetriever";
import type {
  WikiClaimSearchResult,
  WikiDocumentSearchResult,
} from "./wikiRetriever";
import { getWikiStore, type WikiStore } from "./wikiStore";
import {
  WIKI_READ_DEPTHS,
  type WikiCoverageLevel,
  type WikiCommitAction,
  type WikiCommitInput,
  type WikiCommitResult,
  type WikiEvidenceInput,
  type WikiReadDepth,
  type WikiRelationRecord,
  type WikiSourceChunk,
} from "./wikiTypes";

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

/**
 * What `wiki_search` returns, and what `wiki_prepare_update` embeds as
 * `semanticClaims`. Every field is a plain DTO: {@link WikiRetriever.search}
 * maps its Evidence and Relation rows at that boundary, so nothing here is a
 * `Zotero.DB.queryAsync` row. Typing it as `any[]` is what let rows through
 * unnoticed until `JSON.stringify` hit a row's `toJSON` probe and the tool
 * call died with `DB column 'toJSON' not found`.
 */
export interface WikiServiceSearchResult {
  claims: WikiClaimSearchResult[];
  documents: WikiDocumentSearchResult[];
  relations: WikiRelationRecord[];
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

/**
 * The shortest reading note the server will accept as a reading.
 *
 * Not a quality measure - nothing here can judge one - but a floor under the
 * degenerate answer. "Updated." and a two-line stub are what a model returns
 * when it is treating the write-back as a formality to get the next page, and
 * accepting them would make the whole integration gate ceremonial.
 */
const MIN_READING_NOTE_BODY_CHARS = 200;

export class WikiService {
  private readonly store: WikiStore;
  private readonly retriever: WikiRetriever;
  private readonly notes: WikiReadingNoteStore;
  private readonly prepareTokens = new Map<
    string,
    {
      libraryID: number;
      expiresAt: number;
      preparedPageTitles: Set<string>;
      /** A commit holding this token is running; a second one must not start. */
      inFlight?: boolean;
    }
  >();

  constructor(
    store: WikiStore = getWikiStore(),
    notes: WikiReadingNoteStore = new WikiReadingNoteStore(),
  ) {
    this.store = store;
    this.retriever = new WikiRetriever(store);
    this.notes = notes;
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
    await this.assertReadyToWriteUp(options.libraryID);
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

  /**
   * Refuse to start the write-up of a paper that has been read but not
   * understood as a whole.
   *
   * Narrow on purpose. A commit made PARTWAY through a paper is a checkpoint
   * and stays allowed - evidence already read is real evidence, and holding it
   * hostage to finishing the paper is how a crash loses a day's reading. What
   * is refused is the one moment this rule is about: every chunk has been
   * delivered, so the model is about to write the paper's final claims, and it
   * has not yet reread its own note as a single account of the whole paper.
   * That pass is where a reading stops being a sequence of impressions - it is
   * also the only chance to notice that the conclusion contradicts something
   * accepted on page 4.
   */
  private async assertReadyToWriteUp(libraryID: number): Promise<void> {
    const sessions = await this.store.readingSessions();
    const open = await sessions.getOpen(libraryID);
    if (!open || !open.expert) return;
    const coverage = await sessions.coverage(open.sessionId);
    if (!coverage.complete || open.finalSynthesisAt !== null) return;
    throw new Error(
      `Every chunk of ${open.itemKey} has been delivered, but its reading note has not been rewritten ` +
        "as one account of the complete paper. Do that pass first: call wiki_update_reading_note with " +
        "finalSynthesis true and the whole note, reconciling anything the later sections corrected, " +
        "then come back to wiki_prepare_update. (Committing PART of a paper you are still reading is " +
        "always allowed - this only applies once the whole paper has been delivered.)",
    );
  }

  async getPage(pageId: number): Promise<any> {
    const page = await this.store.getPage(pageId);
    if (!page) return null;
    const snapshot = await this.store.getRetrievalSnapshot(page.libraryID);
    // The snapshot holds `Zotero.DB.queryAsync` rows. `store.getPage` already
    // returns DTOs, but the Concept, Alias and Relation rows appended here do
    // not go through it, so they are mapped at this boundary. Handing a row to
    // MCP fails the whole tool call at `JSON.stringify` time with
    // `DB column 'toJSON' not found` - see ./wikiDto.
    const conceptRecords = snapshot.concepts.map(mapWikiConceptRow);
    const aliasRecords = snapshot.aliases.map(mapWikiAliasRow);
    const relationRecords = snapshot.relations.map(mapWikiRelationRow);
    const concept =
      page.primaryConceptId == null
        ? null
        : (conceptRecords.find(
            (record) => record.conceptId === page.primaryConceptId,
          ) ?? null);
    const aliases =
      page.primaryConceptId == null
        ? []
        : aliasRecords.filter(
            (record) => record.conceptId === page.primaryConceptId,
          );
    const relations =
      page.primaryConceptId == null
        ? []
        : relationRecords.filter(
            (record) =>
              record.sourceConceptId === page.primaryConceptId ||
              record.targetConceptId === page.primaryConceptId,
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
   * This still does not claim to measure comprehension - nothing can. It
   * checks the two things that ARE checkable, and they are different claims.
   * Delivery says every chunk was handed over. The final synthesis says the
   * model then rewrote its note as one account of the whole paper, in a call
   * the server watched happen. Delivery alone was never enough: a model that
   * pages to the end and writes a summary from whatever survived in context
   * has been given the paper, not read it, and the depth label is supposed to
   * mean the second thing.
   *
   * Anything short is clamped to `section_read` and reported, rather than
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
    if (coverage.complete && coverage.finalSynthesisAt !== null) {
      return requested;
    }
    const read =
      coverage.sessionId === null
        ? "no reading session recorded"
        : coverage.complete
          ? "every chunk delivered but no whole-paper synthesis of the reading note"
          : `only ${coverage.deliveredChunks} of ${coverage.totalChunks} chunks delivered`;
    warnings.push(
      `Evidence from ${itemKey} asked for read_depth "${requested}", but the server has ${read}. ` +
        `It was stored as "section_read". Whole-paper depth needs both: read every chunk through ` +
        `wiki_build_from_paper (follow pagination.nextCursor to the end), then rewrite the reading ` +
        `note as one account of the complete paper with wiki_update_reading_note and finalSynthesis true.`,
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
    let consumedToken: string | undefined;
    let actions: WikiCommitAction[];
    let warnings: string[];
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
      // A token is spent by a DURABLE write, not by an attempt. It used to be
      // deleted here, before hydration and before the transaction, so any
      // failure on the way in - a validation error, a transient database
      // fault - burned it and forced a fresh wiki_prepare_update even though
      // nothing had been written. Marking it in flight instead keeps a retry
      // possible while still making the token single-use: it is deleted the
      // moment the transaction is durable, and a concurrent caller holding the
      // same token is refused rather than allowed to write twice.
      if (prepared.inFlight) {
        throw new Error(
          "A wiki_commit using this prepareToken is already running. Wait for it to finish; if it failed, retry with the same token.",
        );
      }
      prepared.inFlight = true;
      consumedToken = input.prepareToken!;
    }

    let result: WikiCommitResult;
    try {
      const hydrated = await this.hydrateActions(
        input.actions,
        input.libraryID,
      );
      actions = hydrated.actions;
      warnings = hydrated.warnings;

      // THE DURABLE BOUNDARY. When this resolves the write is permanent, and
      // the vectors those claims still need are queued in the same
      // transaction. The caller is answered from here; embedding happens
      // afterwards, off the request, so a slow or broken embedding backend can
      // no longer turn a successful commit into a client-side timeout of
      // unknown outcome.
      result = await this.store.commit({ ...input, actions });
    } catch (error) {
      // Nothing was written, so hand the token back for a straight retry.
      if (consumedToken) {
        const prepared = this.prepareTokens.get(consumedToken);
        if (prepared) prepared.inFlight = false;
      }
      throw error;
    }
    // Durable. The token can never be spent again.
    if (consumedToken) this.prepareTokens.delete(consumedToken);

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
      // The note is kept permanently, so it becomes this paper's long-term
      // reading memory rather than scaffolding: a later re-read continues it,
      // and a person can open it in Zotero. Only its status changes here.
      await this.syncNoteStatus(open, "completed");
      return {
        ...base,
        state: "committed",
        released: true,
        note: `Paper ${open.itemKey} was fully read and is now closed. Its reading note stays on the Zotero item, marked completed. The library is free for the next paper.`,
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
    // The note stays on the item - it records a real reading even when the
    // paper was not written up - but its status has to stop saying "reading",
    // or a later resume would trust a progress line that nothing is advancing.
    const noteResult = await this.syncNoteStatus(
      open,
      options.outcome === "skipped" ? "skipped" : "failed",
    );
    return {
      closed: true,
      itemKey: open.itemKey,
      outcome: options.outcome,
      chunksRead: coverage.deliveredChunks,
      totalChunks: coverage.totalChunks,
      ...(noteResult ? { readingNote: noteResult } : {}),
      message: `Paper ${open.itemKey} closed as ${options.outcome}. The library is free for the next paper.`,
    };
  }

  // =====================================================================
  // Reading note: the model's understanding of the paper being read.
  //
  // Three calls, in the order the reading happens. `setReadingExpert` decides
  // who is reading and opens the document. `updateReadingNote` rewrites it -
  // once per batch of new text, and once more over the whole paper at the end.
  // `getReadingNote` hands it back, which is how a read survives a restart or
  // a context compaction: the note holds the understanding, the session row
  // holds where the understanding got to, and neither lives in the transcript.
  // =====================================================================

  /**
   * Generate this paper's expert reader, once, from its metadata and abstract.
   *
   * Once, and before any body text: a persona written after reading half the
   * paper is a description of what was already found, and it is the priorities
   * of the reader that are supposed to shape the reading rather than the other
   * way round. The server pins {@link WIKI_EXPERT_OPEN_SCOPE_MANDATE} to
   * whatever focus the model proposes, so a narrow focus cannot become a
   * filter that quietly discards the paper's actual contribution.
   */
  async setReadingExpert(options: {
    libraryID: number;
    itemKey?: string;
    persona: string;
    focus: string[];
  }): Promise<any> {
    const sessions = await this.store.readingSessions();
    const session = await this.requireOpenSession(options.libraryID, options.itemKey);
    if (session.expert) {
      throw new Error(
        `Paper ${session.itemKey} already has its expert profile ("${session.expert.persona}"), ` +
          "and it is generated once per paper on purpose so the rest of the reading is done by " +
          "one consistent reader. Continue with wiki_build_from_paper, or call wiki_get_reading_note " +
          "to see the profile and the note so far.",
      );
    }
    const persona = String(options.persona ?? "").trim();
    if (persona.length < 20) {
      throw new Error(
        "persona must describe who is reading this paper and why they are the right reader for it " +
          "(field, sub-speciality, what they already know), in at least 20 characters.",
      );
    }
    const focus = (options.focus ?? [])
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean);
    if (focus.length < 2 || focus.length > 8) {
      throw new Error(
        "focus must list 2 to 8 things this paper in particular makes worth watching for. " +
          "They set priority, not scope: material outside them still has to be captured.",
      );
    }
    const expert: WikiReadingExpert = {
      persona,
      focus,
      openScopeMandate: WIKI_EXPERT_OPEN_SCOPE_MANDATE,
      createdAt: Date.now(),
    };
    await sessions.setExpert(session.sessionId, expert);

    const item = await this.requirePaperItem(session.libraryID, session.itemKey);
    const refreshed = (await sessions.get(session.sessionId)) ?? session;
    const existingBody = await this.readNoteBody(item);
    const written = await this.writeNote(item, refreshed, existingBody ?? "", "reading");

    return {
      itemKey: session.itemKey,
      expert,
      readingSession: { sessionId: session.sessionId, state: refreshed.state },
      readingNote: written,
      nextStep:
        "The reading note now exists on the Zotero item and will survive a restart, a dropped " +
        "connection and a context compaction. Read the body with wiki_build_from_paper, and after " +
        "each batch call wiki_update_reading_note with the WHOLE note rewritten to account for the " +
        "new text - not with an appended section for it.",
    };
  }

  /**
   * Replace the reading note with the model's current understanding.
   *
   * The whole document every time. That is the point rather than an
   * inconvenience: an append-only note is a transcript of the delivery order,
   * and the order chunks arrive in has nothing to do with how a paper's
   * argument is organised. Rewriting lets section 5 correct the sentence
   * written for section 2 instead of contradicting it three headings later.
   *
   * `unchanged` is the honest escape hatch for a batch that genuinely adds
   * nothing - front matter, a reference list, a repeated figure caption - and
   * it may not be used twice running, so "nothing new" cannot quietly become
   * the way the whole paper gets read.
   */
  async updateReadingNote(options: {
    libraryID: number;
    itemKey?: string;
    markdown?: string;
    unchanged?: boolean;
    unchangedReason?: string;
    finalSynthesis?: boolean;
  }): Promise<any> {
    const sessions = await this.store.readingSessions();
    const session = await this.requireOpenSession(options.libraryID, options.itemKey);
    if (!session.expert) {
      throw new Error(
        `Paper ${session.itemKey} has no expert profile yet. Call wiki_set_reading_expert first; ` +
          "the note is written by that reader and does not exist before it.",
      );
    }
    const item = await this.requirePaperItem(session.libraryID, session.itemKey);
    const coverage = await sessions.coverage(session.sessionId);
    const finalSynthesis = options.finalSynthesis === true;
    const unchanged = options.unchanged === true;

    if (finalSynthesis && unchanged) {
      throw new Error(
        "The final synthesis is a rewrite of the whole paper's account in one pass, so it cannot be " +
          'submitted as "unchanged". Send the full markdown.',
      );
    }
    if (finalSynthesis && !coverage.complete) {
      throw new Error(
        `The final synthesis is only available once every chunk has been delivered: ` +
          `${coverage.deliveredChunks} of ${coverage.totalChunks} so far` +
          (coverage.firstMissingIndex === null
            ? ""
            : `, resume at chunk index ${coverage.firstMissingIndex}`) +
          ". Keep reading with wiki_build_from_paper, integrating each batch as it arrives.",
      );
    }

    const previousBody = (await this.readNoteBody(item)) ?? "";
    let body: string;
    if (unchanged) {
      if (!previousBody.trim()) {
        throw new Error(
          'There is no reading note yet, so there is nothing that can be "unchanged". ' +
            "Submit the first version of the note as markdown.",
        );
      }
      if (session.lastIntegrationUnchanged) {
        throw new Error(
          'The previous batch was also recorded as "unchanged". Two in a row is how a paper ends up ' +
            "unread, so this one has to be answered with the rewritten note. If the new text really " +
            "adds nothing, say so inside the note - a sentence about what the section does and why it " +
            "does not change the account is itself part of understanding the paper.",
        );
      }
      if (!String(options.unchangedReason ?? "").trim()) {
        throw new Error(
          'unchangedReason is required with unchanged: say what was in the batch (references, ' +
            "acknowledgements, a repeated figure caption) that leaves the account of the paper intact.",
        );
      }
      body = previousBody;
    } else {
      const submitted = stripMachineBlock(String(options.markdown ?? ""));
      if (!submitted.trim()) {
        throw new Error(
          "markdown is required: send the entire reading note as it now stands, not a diff and not " +
            'only the new part. Use unchanged: true with unchangedReason if the batch truly changes nothing.',
        );
      }
      if (submitted.length < MIN_READING_NOTE_BODY_CHARS) {
        throw new Error(
          `The reading note is ${submitted.length} characters. It is meant to be a complete account of ` +
            "the paper - question, materials, full method chain, models and parameters, conditions, " +
            "results, mechanism, validation, contribution, limits - carried forward and improved after " +
            `every batch, so anything under ${MIN_READING_NOTE_BODY_CHARS} characters is a placeholder ` +
            "rather than a reading.",
        );
      }
      assertHolisticBody(submitted);
      body = submitted;
    }

    await sessions.recordIntegration(session.sessionId, {
      unchanged,
      integratedChunks: coverage.deliveredChunks,
      finalSynthesis,
    });
    const refreshed = (await sessions.get(session.sessionId)) ?? session;
    const written = await this.writeNote(
      item,
      refreshed,
      body,
      finalSynthesis ? "synthesized" : "reading",
    );

    return {
      itemKey: session.itemKey,
      integrated: true,
      unchanged,
      finalSynthesis,
      readingNote: written,
      readingSession: {
        sessionId: session.sessionId,
        state: refreshed.state,
        deliveredChunks: coverage.deliveredChunks,
        totalChunks: coverage.totalChunks,
        coverageComplete: coverage.complete,
        integrationDebt: integrationDebt(refreshed),
      },
      nextStep: finalSynthesis
        ? "The whole-paper synthesis is recorded. Now build the Wiki from it: call wiki_prepare_update, " +
          "then wiki_commit. Every Claim still needs Evidence quoted from the paper's own chunks - the " +
          "note is your understanding, not a source - so re-read the chunks a claim rests on with " +
          "wiki_build_from_paper (offset) and take the excerpt from there. Re-reading a chunk you have " +
          "already been given costs nothing against the integration gate."
        : coverage.complete
          ? "Every chunk has been delivered. Do the whole-paper pass now: call wiki_update_reading_note " +
            "once more with finalSynthesis true and the note rewritten as a single coherent reading of " +
            "the complete paper. Claims cannot be recorded at paper_reviewed depth until that is done."
          : `Keep reading: ${coverage.remainingChunks} chunk(s) left, resume at chunk index ` +
            `${coverage.firstMissingIndex ?? coverage.deliveredChunks}.`,
    };
  }

  /**
   * Hand back the reading note and where the reading got to.
   *
   * The recovery entry point. After a restart or a compaction the model has
   * lost the note, the expert and the page it was on; all three are here, and
   * reading resumes from `nextChunk` rather than from the beginning.
   */
  async getReadingNote(options: {
    libraryID: number;
    itemKey?: string;
    includeMarkdown?: boolean;
  }): Promise<any> {
    const sessions = await this.store.readingSessions();
    const requestedKey = String(options.itemKey ?? "").trim();
    const session = requestedKey
      ? await sessions.latestForItem(options.libraryID, requestedKey)
      : await sessions.getOpen(options.libraryID);
    if (!session) {
      return {
        found: false,
        message: requestedKey
          ? `No Wiki reading session has ever been opened for ${requestedKey} in this library.`
          : "No paper is currently open for Wiki reading in this library.",
      };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
      session.libraryID,
      session.itemKey,
    );
    const attachment = item ? await this.notes.findAttachment(item) : null;
    const raw = attachment ? await this.notes.read(attachment) : null;
    const parsed = raw ? parseReadingNote(raw) : { metadata: null, body: "" };
    const coverage = await sessions.coverage(session.sessionId);
    return {
      found: true,
      itemKey: session.itemKey,
      libraryID: session.libraryID,
      title: session.title,
      readingSession: {
        sessionId: session.sessionId,
        state: session.state,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
      },
      expert: session.expert,
      progress: this.noteProgress(session, coverage),
      readingNote: {
        exists: Boolean(attachment),
        attachmentKey: attachment?.key ?? session.noteKey ?? "",
        bodyChars: parsed.body.length,
        metadata: parsed.metadata,
        ...(options.includeMarkdown === false ? {} : { markdown: parsed.body }),
      },
      nextStep: this.resumeInstruction(session, coverage),
    };
  }

  /** The open session, checked against an optional itemKey guard. */
  private async requireOpenSession(
    libraryID: number,
    itemKey?: string,
  ): Promise<WikiReadingSessionRecord> {
    const sessions = await this.store.readingSessions();
    const open = await sessions.getOpen(libraryID);
    if (!open) {
      throw new Error(
        "No paper is open for Wiki reading in this library. Start one with wiki_build_from_paper, " +
          "which returns the paper's metadata and abstract so an expert reader can be generated for it.",
      );
    }
    const wanted = String(itemKey ?? "").trim();
    if (wanted && wanted !== open.itemKey) {
      throw new Error(
        `The open paper is ${open.itemKey}, not ${wanted}. Finish it first, or omit itemKey to act on whatever is open.`,
      );
    }
    return open;
  }

  private async requirePaperItem(
    libraryID: number,
    itemKey: string,
  ): Promise<any> {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
    if (!item || item.deleted || !item.isRegularItem?.()) {
      throw new Error(
        `The paper being read (${libraryID}:${itemKey}) is no longer an available Zotero document. ` +
          'Close the session with wiki_finish_reading and outcome "failed".',
      );
    }
    return item;
  }

  /** The model's half of the existing note, or null when there is none. */
  private async readNoteBody(item: any): Promise<string | null> {
    const attachment = await this.notes.findAttachment(item);
    if (!attachment) return null;
    const raw = await this.notes.read(attachment);
    return raw === null ? null : parseReadingNote(raw).body;
  }

  /**
   * Write the note: machine block regenerated from the ledger, body as given.
   *
   * The block is never taken from what the model submitted, so no wording in
   * the note can make the server believe the paper is further along than the
   * database says it is.
   */
  private async writeNote(
    item: any,
    session: WikiReadingSessionRecord,
    body: string,
    status: WikiReadingNoteStatus,
  ): Promise<{
    attachmentKey: string;
    status: WikiReadingNoteStatus;
    bodyChars: number;
  }> {
    const sessions = await this.store.readingSessions();
    const [coverage, delivered] = await Promise.all([
      sessions.coverage(session.sessionId),
      sessions.deliveredIndexes(session.sessionId),
    ]);
    const metadata: WikiReadingNoteMetadata = {
      schema: WIKI_READING_NOTE_SCHEMA,
      paperKey: session.itemKey,
      libraryID: session.libraryID,
      title: String(item.getField?.("title") || session.title || ""),
      abstract: String(item.getField?.("abstractNote") || ""),
      expert: session.expert,
      readChunks: formatChunkRanges(delivered),
      totalChunks: coverage.totalChunks,
      nextChunk: coverage.complete
        ? null
        : (coverage.firstMissingIndex ?? coverage.deliveredChunks),
      coverage: {
        deliveredChunks: coverage.deliveredChunks,
        totalChunks: coverage.totalChunks,
        complete: coverage.complete,
        integratedChunks: session.integratedChunks,
        finalSynthesis: session.finalSynthesisAt !== null,
      },
      status,
      updatedAt: new Date().toISOString(),
    };
    const markdown = renderReadingNote(metadata, body);
    const attachment = await this.notes.ensureAttachment(item, markdown);
    await this.notes.write(attachment, markdown);
    if (attachment?.key && attachment.key !== session.noteKey) {
      await sessions.setNoteKey(session.sessionId, String(attachment.key));
    }
    return {
      attachmentKey: String(attachment?.key ?? ""),
      status,
      bodyChars: stripMachineBlock(body).length,
    };
  }

  /**
   * Stamp a terminal status onto the note when its session closes.
   *
   * Best effort by design: the Wiki write is already durable when this runs,
   * and a missing attachment or an unwritable file is not a reason to turn a
   * successful commit into an error.
   */
  private async syncNoteStatus(
    session: WikiReadingSessionRecord,
    status: WikiReadingNoteStatus,
  ): Promise<{ attachmentKey: string; status: WikiReadingNoteStatus } | null> {
    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        session.libraryID,
        session.itemKey,
      );
      if (!item) return null;
      const body = await this.readNoteBody(item);
      if (body === null) return null;
      const written = await this.writeNote(item, session, body, status);
      return { attachmentKey: written.attachmentKey, status };
    } catch (error) {
      ztoolkit?.log?.(
        `[WikiService] could not stamp reading note status for ${session.itemKey}: ${error}`,
        "warn",
      );
      return null;
    }
  }

  private noteProgress(
    session: WikiReadingSessionRecord,
    coverage: {
      deliveredChunks: number;
      totalChunks: number;
      complete: boolean;
      remainingChunks: number;
      firstMissingIndex: number | null;
    },
  ): Record<string, unknown> {
    return {
      deliveredChunks: coverage.deliveredChunks,
      totalChunks: coverage.totalChunks,
      remainingChunks: coverage.remainingChunks,
      coverageComplete: coverage.complete,
      nextChunk: coverage.complete
        ? null
        : (coverage.firstMissingIndex ?? coverage.deliveredChunks),
      integratedChunks: session.integratedChunks,
      integrationDebt: integrationDebt(session),
      maxOutstandingBatches: WIKI_MAX_OUTSTANDING_BATCHES,
      lastIntegrationUnchanged: session.lastIntegrationUnchanged,
      finalSynthesisDone: session.finalSynthesisAt !== null,
    };
  }

  private resumeInstruction(
    session: WikiReadingSessionRecord,
    coverage: {
      deliveredChunks: number;
      totalChunks: number;
      complete: boolean;
      remainingChunks: number;
      firstMissingIndex: number | null;
    },
  ): string {
    if (!session.expert) {
      return (
        "This paper has no expert reader yet. Call wiki_set_reading_expert with a persona drawn from " +
        "the title, metadata and abstract, and 2 to 8 focus areas; the body text opens after that."
      );
    }
    if (!coverage.complete) {
      const resume = coverage.firstMissingIndex ?? coverage.deliveredChunks;
      return (
        `Resume reading at chunk index ${resume} of ${coverage.totalChunks}: call wiki_build_from_paper ` +
        `with itemKey "${session.itemKey}" and offset ${resume}. Rewrite the whole note after each batch ` +
        "with wiki_update_reading_note."
      );
    }
    if (session.finalSynthesisAt === null) {
      return (
        "Every chunk has been delivered but the whole-paper synthesis has not been done. Call " +
        "wiki_update_reading_note with finalSynthesis true and the note rewritten as one coherent " +
        "reading of the complete paper, then build the Wiki from it."
      );
    }
    return (
      "The paper has been read and synthesised. Build the Wiki: wiki_prepare_update, then wiki_commit, " +
      "with every Claim's Evidence quoted from the paper's own chunks rather than from this note."
    );
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
   *
   * Reading now happens in two phases, and the first one carries no body text
   * at all. The opening call returns the paper's metadata and abstract and
   * asks for an expert reader; chunks start flowing only once
   * `wiki_set_reading_expert` has answered. Ordering it that way is the whole
   * point - a persona written after the fact describes what was already found,
   * whereas one written from the title and abstract decides what to look for.
   *
   * From then on the reading is paced by the note rather than by the cursor.
   * A batch that carried new text is owed an integration, and asking for more
   * while {@link WIKI_MAX_OUTSTANDING_BATCHES} are already outstanding is
   * refused. Without that gate nothing stops the old failure mode: page to the
   * end, then write one summary out of whatever survived in context - which is
   * exactly what "read the whole paper" was supposed to stop meaning.
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
    /**
     * Return the reading note's markdown with this page. Defaults to true on a
     * call that is not continuing a cursor - which is what resuming looks like
     * - and false while paging, where the model already has it.
     */
    includeReadingNote?: boolean;
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

    const target = {
      libraryID,
      itemKey,
      title,
      doi: String(item.getField("DOI") || ""),
      url: String(item.getField("url") || ""),
    };

    // Phase one: no expert, no body text. The metadata and the abstract are
    // everything needed to decide who should be reading this paper, and they
    // are all that is handed over until that decision is made.
    if (!session.expert) {
      if (servedFromCursor) {
        throw new Error(
          `Paper ${itemKey} has no expert reader yet, so no body text has been delivered and this ` +
            "cursor cannot be continued. Call wiki_set_reading_expert with a persona and 2-8 focus " +
            "areas drawn from the metadata and abstract, then read from the beginning.",
        );
      }
      return {
        explicitUserRequestVerified: true,
        phase: "expert_briefing",
        target,
        metadata: await this.paperBriefing(item),
        readingSession: {
          sessionId: session.sessionId,
          state: session.state,
          startedAt: session.startedAt,
          itemKey,
        },
        chunkCount: chunks.length,
        chunks: [],
        pagination: {
          totalChunks: chunks.length,
          returned: 0,
          offset: 0,
          range: "none",
          pageSize,
          hasMore: chunks.length > 0,
          servedFromCursor: false,
          deliveredChunks: 0,
          remainingChunks: chunks.length,
          coverageComplete: false,
          blocked: "expert_required",
        },
        readingNote: {
          status: "awaiting_expert" as WikiReadingNoteStatus,
          exists: false,
        },
        expertInstruction:
          "Before any body text is delivered, decide who is reading this paper. From the title, " +
          "metadata and abstract above, write the persona of a domain expert who is the right reader " +
          "for THIS paper - their field and sub-speciality, and what they already know that makes " +
          "them able to judge it - and 2 to 8 focus areas this paper in particular makes worth " +
          "watching for. The focus sets priority, never scope: the server attaches a standing mandate " +
          "that anything important outside it must be captured too, because an expert who only finds " +
          "what they were looking for has not read the paper.",
        nextStep:
          `Call wiki_set_reading_expert with libraryID ${libraryID}, itemKey "${itemKey}", persona and ` +
          "focus. It creates the persistent Markdown reading note on this Zotero item, and the body " +
          "text opens immediately afterwards.",
      };
    }

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

    // The integration gate. Only NEW text is gated: re-reading a chunk already
    // delivered is how an excerpt gets checked against the source before it
    // becomes Evidence, and that must stay free.
    const deliveredAlready = new Set(
      await sessions.deliveredIndexes(session.sessionId),
    );
    const carriesNewText = rows.some(
      (row) => !deliveredAlready.has(row.chunkIndex),
    );
    const debt = integrationDebt(session);
    if (carriesNewText && debt > WIKI_MAX_OUTSTANDING_BATCHES) {
      throw new WikiReadingIntegrationRequired(
        `${debt} batches of ${itemKey} have been delivered without being folded into its reading ` +
          `note, and at most ${WIKI_MAX_OUTSTANDING_BATCHES} may be outstanding. Chunks are a way to ` +
          "transport the text, not a way to organise what it says: call wiki_update_reading_note with " +
          "the WHOLE note rewritten to account for everything delivered so far - adding, merging, " +
          "moving, and correcting earlier passages that the newer text has overtaken - and reading " +
          "resumes at chunk index " +
          `${(await sessions.coverage(session.sessionId)).firstMissingIndex ?? deliveredAlready.size}. ` +
          "If a batch genuinely changed nothing, send unchanged: true with unchangedReason instead; " +
          "that cannot be used twice in a row.",
        {
          itemKey,
          integrationDebt: debt,
          maxOutstandingBatches: WIKI_MAX_OUTSTANDING_BATCHES,
        },
      );
    }

    await sessions.recordDelivery(
      session.sessionId,
      rows.map((row) => ({ chunkIndex: row.chunkIndex, chunkId: row.chunkId })),
    );
    const [coverage, afterDelivery] = await Promise.all([
      sessions.coverage(session.sessionId),
      sessions.get(session.sessionId),
    ]);
    const current = afterDelivery ?? session;

    const end = offset + rows.length;
    const hasMore = end < chunks.length;
    const range = rows.length === 0 ? "none" : `${offset + 1}-${end}`;

    const existing = await this.store.prepareUpdate({
      libraryID,
      query: title || itemKey,
      limit: 20,
    });

    // Resuming looks exactly like a call without a cursor, and a resuming
    // model has lost the note, so it comes back with the page by default.
    const includeNote = options.includeReadingNote ?? !servedFromCursor;
    const noteAttachment = await this.notes.findAttachment(item);
    const noteBody = noteAttachment
      ? parseReadingNote((await this.notes.read(noteAttachment)) ?? "").body
      : "";

    return {
      explicitUserRequestVerified: true,
      phase: "reading",
      target,
      readingSession: {
        sessionId: session.sessionId,
        state: session.state,
        startedAt: session.startedAt,
      },
      expert: current.expert,
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
      readingNote: {
        exists: Boolean(noteAttachment),
        attachmentKey: noteAttachment?.key ?? current.noteKey ?? "",
        bodyChars: noteBody.length,
        ...this.noteProgress(current, coverage),
        ...(includeNote ? { markdown: noteBody } : {}),
      },
      integrationInstruction:
        "Rewrite the whole reading note now, as this paper's expert, from the note above plus the " +
        "chunks just delivered. Not an appended section: revise the single continuous account of the " +
        "paper - merge the new material into whichever part of it belongs to, and where this text " +
        "corrects or sharpens something written earlier, rewrite that passage rather than leaving " +
        "both versions standing. Then send it with wiki_update_reading_note." +
        (integrationDebt(current) >= WIKI_MAX_OUTSTANDING_BATCHES
          ? ` ${integrationDebt(current)} batch(es) are outstanding; the next page is refused once more than ${WIKI_MAX_OUTSTANDING_BATCHES} is.`
          : ""),
      coverageInstruction: coverage.complete
        ? "Every chunk of this paper has been delivered. That is delivery, not understanding: " +
          "paper_reviewed also requires the whole-paper pass, so call wiki_update_reading_note with " +
          "finalSynthesis true once the note reads as one coherent account of the complete paper."
        : `${coverage.deliveredChunks} of ${coverage.totalChunks} chunks delivered. wiki_commit will store evidence from this paper as section_read at best until the whole paper has been delivered; keep paging with pagination.nextCursor, or submit chunk_local / section_read / partial / incomplete now.`,
      nextStep: hasMore
        ? `You have read chunks ${range} of ${chunks.length}. Update the reading note, then continue with cursor set to pagination.nextCursor and nothing else changed. When you are done reading — whether or not you read it all — finish this paper before starting another: call wiki_prepare_update then wiki_commit to write it, or wiki_finish_reading with outcome "skipped" to close it without writing.`
        : `That is the whole paper: ${chunks.length} chunk(s). Fold this last batch in, then call wiki_update_reading_note once more with finalSynthesis true. Only after that: wiki_prepare_update and wiki_commit, with every Claim's Evidence quoted from these chunks rather than from the note. If you decide not to write it up, close it with wiki_finish_reading and outcome "skipped".`,
      existingWikiCandidates: existing,
    };
  }

  /** Title, creators, venue and abstract: everything the expert is built from. */
  private async paperBriefing(item: any): Promise<Record<string, unknown>> {
    const field = (name: string): string => {
      try {
        return String(item.getField?.(name) ?? "");
      } catch {
        return "";
      }
    };
    let creators: string[] = [];
    try {
      creators = (item.getCreators?.() ?? []).map((creator: any) =>
        [creator?.lastName, creator?.firstName].filter(Boolean).join(", ") ||
        String(creator?.name ?? ""),
      );
    } catch {
      creators = [];
    }
    let tags: string[] = [];
    try {
      tags = (item.getTags?.() ?? []).map((tag: any) => String(tag?.tag ?? ""));
    } catch {
      tags = [];
    }
    const abstract = field("abstractNote");
    return {
      title: field("title"),
      creators,
      date: field("date"),
      itemType: String(item.itemType ?? ""),
      publication:
        field("publicationTitle") ||
        field("proceedingsTitle") ||
        field("bookTitle") ||
        field("publisher"),
      volume: field("volume"),
      issue: field("issue"),
      pages: field("pages"),
      doi: field("DOI"),
      url: field("url"),
      language: field("language"),
      tags,
      abstract,
      abstractAvailable: Boolean(abstract.trim()),
      ...(abstract.trim()
        ? {}
        : {
            abstractNote:
              "This item has no abstract. Build the expert from the title, venue and item type, and " +
              "revise your priorities in the note itself once the opening chunks make the paper's " +
              "actual subject clear.",
          }),
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
