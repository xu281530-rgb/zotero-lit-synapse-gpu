import { getStoredChunkingSignature } from "../hybridSearchSettings";
import { bodyIndexStateFromSourceKind } from "../semantic/bodyIndexState";
import { getEmbeddingService, sameEmbeddingSpace, type EmbeddingIdentity } from "../semantic/embeddingService";
import {
  conceptNamesWorthReviewing,
  normalizeOrigin,
} from "./wikiConceptTerms";
import { getVectorStore } from "../semantic/vectorStore";
import {
  hashWikiText,
  hashExactText,
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
  WIKI_REVIEW_AXES,
  WIKI_REVIEW_MIN_AXIS_CHARS,
  WikiReadingIntegrationRequired,
  integrationDebt,
  type WikiReadingAbandonOutcome,
  type WikiReadingSessionRecord,
  type WikiWholeWikiReview,
} from "./wikiReadingSession";
import {
  WIKI_EXPERT_OPEN_SCOPE_MANDATE,
  WIKI_READING_NOTE_SCHEMA,
  WikiReadingNoteStore,
  appendMacroSummary,
  appendReadingRecord,
  assertBlockCitations,
  assertChunkCitations,
  assertChunkCitationsResolvable,
  assertHolisticBody,
  formatChunkRanges,
  formatCoverageMap,
  parseAppendOnlyReadingNote,
  parseReadingNote,
  readingNoteEpisode,
  renderReadingNote,
  stripMachineBlock,
  type WikiReadingExpert,
  type WikiReadingNoteMetadata,
  type WikiReadingNoteStatus,
} from "./wikiReadingNote";
import {
  routeBySimilarity,
  routeFallback,
  routeWithoutSimilarity,
  type NoteRoute,
  type RoutableNote,
} from "./wikiNoteRouting";
import {
  WIKI_SYNTHESIS_MIN_QUOTE_CHARS,
  WIKI_EVIDENCE_MIN_EXCERPT_CHARS,
  WikiSynthesisAuditRequired,
  auditSynthesis,
  citedChunkIds,
  describeFlaggedSentences,
  verifySynthesisAudit,
  type WikiAuditChunk,
  type WikiSynthesisAuditEntry,
} from "./wikiSynthesisAudit";
import {
  WIKI_MACRO_SECTIONS,
  WIKI_RECORD_SECTIONS,
  renderTemplateGuide,
  assertBatchChunkCoverage,
  assertMacroIsNotPaste,
  assertProseIsConnected,
  splitTemplateSections,
  assertMacroTouchesEveryRecord,
  assertRecordLedgerIntact,
  assertTemplateSections,
  assertUnchangedCarriesNothingNew,
  assertValuesLanded,
} from "./wikiRecordTemplate";
import { describeEvidenceMismatch } from "./wikiEvidenceDiagnostics";
import { WikiValidation } from "./wikiValidation";
import { WIKI_CITATION_GUIDE } from "./wikiCitations";
import type { WikiEmbeddingWorkUnit } from "./wikiEmbeddingQueue";
import {
  decodeChunkCursor,
  documentChunkRevision,
  assertChunkRevision,
  encodeChunkCursor,
  resolvePageSize,
} from "../documentChunks";
import {
  renderConceptLibraryMarkdown,
  renderWikiMarkdown,
} from "./wikiRenderer";
import type { WikiPreparedSource } from "./wikiConceptLibrary";
import { normalizeTermFields } from "./wikiConceptTerms";
import type {
  WikiConceptEntity,
  WikiConceptEntityInput,
  WikiTermInput,
  WikiTermSourceInput,
} from "./wikiConceptTerms";
import {
  getWikiNoteEpisodeSimilarity,
  getWikiRequireQuestionTerminology,
} from "./wikiSettings";
import {
  WikiLinkService,
  normalizeLinkDismissals,
} from "./wikiLinkService";
import type { WikiLinkResolutionType, WikiLinkSettlementResult } from "./wikiLinkTypes";
import { WikiRetriever } from "./wikiRetriever";
import { boundPreparedContext, compactWikiClaim, compactPreparedResponse, fragmentContextText, pagePreparedContext, WIKI_PREPARE_IDLE_SECONDS, WIKI_PREPARE_MAX_TOKENS, WikiPreparedContextExpired, type WikiPreparedContext } from "./wikiPreparedContext";
import { findWikiSourceQuote, wikiSourceTextView } from "./wikiSourceText";
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

/** One SKIP action, validated: these chunks need no Wiki entry, and why. */
interface WikiWikiWriteOff {
  itemKey: string;
  chunkIds: number[];
  reason: string;
}

interface WikiCommitReadingDependency {
  sessionId: number;
  itemKey: string;
  sourceVersion?: string;
  noteKey?: string;
}

type WikiCommitDependencies = Record<string, WikiCommitReadingDependency[]>;

type WikiNoteStatusWriteResult =
  | {
      updated: true;
      attachmentKey: string;
      status: WikiReadingNoteStatus;
    }
  | {
      updated: false;
      reason:
        | "item_not_found"
        | "reading_note_not_found"
        | "not_authorized"
        | "write_failed";
    };

interface WikiNoteStatusWriteOptions {
  authorizeNoteStatusWrite?: () => Promise<boolean | void>;
}

/**
 * Shortest write-off reason that can carry an argument.
 *
 * The point of allowing "this reading added nothing" is that it is often TRUE,
 * and forcing a Claim for every chunk read would fill the Wiki with restated
 * definitions to satisfy a counter. The point of bounding it is that the same
 * answer is also the easiest thing to say when nothing was checked at all, and
 * those two are indistinguishable unless the reason names what the text
 * actually said and what the Wiki already holds instead.
 */
export const WIKI_WRITE_OFF_MIN_REASON_CHARS = 40;

/**
 * How many nearby concepts the write-up is shown, and how many hubs.
 *
 * Fixed numbers, not a fraction of the library: the whole point of the
 * neighbourhood is that its size does not depend on how much is in the Wiki.
 * Forty is roughly what a paper's own concept list can be usefully compared
 * against in one pass; a dozen hubs is the entire high-degree tail of a Wiki
 * this size and stays a dozen when there are thousands of concepts.
 */
export const WIKI_SKELETON_NEIGHBOURS = 40;
export const WIKI_SKELETON_HUBS = 12;

/**
 * How many existing pages are offered as extension candidates.
 *
 * Six, because the list has to be short enough to actually be read against the
 * paper in hand. The complete page list is still in the same response; this is
 * the shortlist, ranked by how close the page's own Claims sit to this paper.
 */
export const WIKI_SKELETON_EXTENDABLE_PAGES = 6;

/**
 * How many cross-paper candidates one write-up is shown.
 *
 * Bounded for the same reason the neighbourhood is: the number must not grow
 * with the library, or the response stops fitting and the list stops being
 * read. Twelve because a pair carries two excerpts and a verdict - three or
 * four of those is real work, and a list nobody finishes is worse than a
 * shorter one somebody does. Mandatory signals sort first, so a truncated list
 * never hides the ones that block the commit.
 */
export const WIKI_PENDING_LINK_SIGNAL_LIMIT = 12;

/** The Evidence excerpt floor this service enforces; defined in the leaf so
 * `toolCatalog` can state the same number without importing the wiki stack. */
export { WIKI_EVIDENCE_MIN_EXCERPT_CHARS };

/**
 * Reasons that assert rather than argue.
 *
 * Matched against the WHOLE reason, so a sentence that happens to contain
 * "nothing new" while going on to say what was already recorded passes; a
 * reason that is only this does not. The list is short on purpose - it catches
 * the reflex answer, and the length floor above catches the rest.
 */
const VACUOUS_WRITE_OFF_REASON =
  /^(?:no(?:thing)?\s+new(?:\s+knowledge)?|nothing\s+to\s+add|not\s+relevant|irrelevant|n\/?a|none|already\s+known|duplicate)[\s.。!！]*$|^(?:\u65e0|\u6ca1\u6709)?(?:\u65b0\u77e5\u8bc6|\u65b0\u5185\u5bb9|\u65b0\u4fe1\u606f|\u53ef\u8865\u5145\u5185\u5bb9)[\s.。!！]*$|^\u5df2\u77e5(?:\u5185\u5bb9)?[\s.。!！]*$|^\u91cd\u590d\u5185\u5bb9[\s.。!！]*$|^\u4e0d\u76f8\u5173[\s.。!！]*$/iu;

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
/**
 * Refuse a whole-paper synthesis whose reaching sentences are not backed by
 * the chunks they cite.
 *
 * This is the evidence-closure pass, and it runs at exactly one moment: the
 * call that turns a working note into the paper's settled account of itself.
 * Not on every batch - a mid-reading note is allowed to be provisional, that
 * is what mid-reading means, and paying for a full justification seven times
 * per paper would buy nothing the final pass does not already cover. Not
 * never, which is what shipped before and is how "notably unique" became
 * "irreplaceable" with `finalSynthesis: true` stamped beside it.
 *
 * The division of labour is the point. `auditSynthesis` decides WHICH
 * sentences have to be proved, using nothing but the shapes a drifting
 * sentence takes. The model decides whether its quotation actually supports
 * the sentence - a judgement no string rule can make, and one this code does
 * not pretend to make. `verifySynthesisAudit` checks the only thing left that
 * is mechanically checkable, and checks it exactly as strictly as Evidence is
 * checked: the quotation is really in that chunk, character for character.
 *
 * A model has two ways past this, and the cheaper one is the honest one:
 * quote the source, or write the sentence at the strength the source used, at
 * which point it stops being flagged and costs nothing at all.
 */
function assertSynthesisEvidenceClosure(
  body: string,
  chunks: readonly WikiAuditChunk[],
  submittedAudit: readonly WikiSynthesisAuditEntry[],
  /**
   * What is being written, so the refusal can name it.
   *
   * This check runs on every reading record as well as on the whole-paper
   * pass, but the message only ever described the latter: an ordinary batch
   * was told "The whole-paper synthesis has 3 sentence(s) that reach past..."
   * and instructed to "resubmit the WHOLE note with finalSynthesis true" - a
   * call that batch is not allowed to make. The check was right; the only way
   * out of it was misdescribed, which is its own kind of wrong.
   */
  what: "record" | "synthesis" = "synthesis",
): void {
  const flagged = auditSynthesis(body, { chunks });
  if (!flagged.length) return;

  if (!submittedAudit.length) {
    throw new WikiSynthesisAuditRequired(
      `${what === "record" ? "This reading record" : "The whole-paper synthesis"} has ` +
        `${flagged.length} sentence(s) that reach past what the chunks they ` +
        "cite can be shown to say, so nothing was written. Coverage cannot catch this: the chunks " +
        "really were delivered, and the drift happened afterwards, while the text was being made to " +
        "read well.\n\n" +
        "FOR EACH SENTENCE BELOW, DO ONE OF TWO THINGS.\n" +
        "(a) Prove it. Re-read the chunks it cites and copy out, VERBATIM, the passage that carries " +
        "it - one quotation per cited chunk, at least " +
        `${WIKI_SYNTHESIS_MIN_QUOTE_CHARS} characters each. Copy from the CHUNK, never from the note: ` +
        "the note is your paraphrase, and a quotation that is not in the chunk character for " +
        "character is refused. Re-reading a chunk you have already been given is free and does not " +
        "count against the integration gate.\n" +
        "(b) Cheaper, and usually right: rewrite the sentence so it says what the paper says, at the " +
        "strength the paper says it. Keep the hedge the source used. Do not widen the subject - a " +
        "capability shown for one technique is not a capability of the family it belongs to, and a " +
        "family's capability is not that one technique's. Split a sentence that fuses several " +
        "mechanisms into one sentence each, so each cites only the chunk that carries it. Restore a " +
        "dropped item from an enumeration, especially when the dropped one was the difficulty. A " +
        "rewritten sentence is not flagged and needs no quotation.\n\n" +
        (what === "record"
          ? "Then resubmit THIS RECORD - the same wiki_update_reading_note call, with readingRecord " +
            "and NOT finalSynthesis - carrying synthesisAudit with one entry "
          : "Then resubmit the WHOLE summary with finalSynthesis true and synthesisAudit carrying one entry ") +
        "for every sentence that is still flagged:\n" +
        '  synthesisAudit: [{ "auditId": "<the current issue auditId>", ' +
        '"support": [{ "chunkId": 18, "quote": "<verbatim from chunk 18>" }, ...] }]' +
        "\nOmit an entry for any sentence you rewrote. Sentences you neither prove nor rewrite " +
        "are refused again.\n\n" +
        `SENTENCES TO ANSWER (${flagged.length}):\n${describeFlaggedSentences(flagged)}`,
      { flagged: flagged.length, issues: flagged, activeIssues:flagged, staleAuditIds:[], mode: what },
    );
  }

  const problems = verifySynthesisAudit(flagged, submittedAudit, chunks);
  if (!problems.length) return;
  const shown = problems.slice(0, 25);
  const staleAuditIds = problems.filter(p => p.code === "STALE_AUDIT" && p.auditId).map(p=>p.auditId!);
  const activeIds = new Set(problems.filter(p=>p.code !== "STALE_AUDIT").map(p=>p.auditId));
  const activeIssues = flagged.filter(f=>activeIds.has(f.auditId));
  throw new WikiSynthesisAuditRequired(
    `The synthesis audit does not close: ${problems.length} problem(s), so nothing was written. Fix ` +
      (what === "record" ? "these and resubmit readingRecord in the same call mode. " : "these and resubmit macroSummary with finalSynthesis true. ") +
      "Remember that rewriting a " +
      "sentence to the paper's own strength removes the need to justify it at all.\n\n" +
      shown
        .map(
          (problem, index) =>
            `${index + 1}. "${problem.sentence.slice(0, 200)}"\n   -> ${problem.problem}`,
        )
        .join("\n") +
      (problems.length > shown.length
        ? `\n... and ${problems.length - shown.length} more.`
        : ""),
    { flagged: flagged.length, problems: problems.length, issues: activeIssues, activeIssues, staleAuditIds, auditProblems: problems, mode: what },
  );
}

/**
 * Name the exact place in the submitted commit that an Evidence entry sits.
 *
 * `actions[3] ADD_CLAIM ... evidence[1]` is enough for a model to find the
 * entry in the payload it just wrote without re-deriving anything; the Claim
 * text (truncated) is there so a person reading the log knows what failed
 * without the payload in front of them.
 */
function describeEvidenceLocation(
  action: WikiCommitAction,
  actionIndex: number,
  entryIndex: number,
): string {
  const parts = [`actions[${actionIndex}] ${action.action}`];
  if ("claimText" in action && action.claimText) {
    const text = String(action.claimText);
    parts.push(
      `claim "${text.length > 90 ? `${text.slice(0, 90)}...` : text}"`,
    );
  }
  if ("claimId" in action && action.claimId !== undefined) {
    parts.push(`claimId ${String(action.claimId)}`);
  }
  if ("pageId" in action && action.pageId !== undefined) {
    parts.push(`pageId ${String(action.pageId)}`);
  }
  parts.push(`evidence[${entryIndex}]`);
  return parts.join(", ");
}

/**
 * What a model is told about the synthesis gate BEFORE it meets it.
 *
 * Repeated at every point that points forward to the whole-paper pass,
 * because the gate is cheapest to satisfy while the note is still being
 * written: a sentence kept at its source's strength is never flagged, and a
 * model that only learns the rule from the refusal has already paid for one
 * full submission of the document.
 */
const GATE_HINT =
  "Every sentence of that note is checked against the chunks it cites before anything is written, so " +
  "keep each sentence at the strength its source used, and let a sentence cite only the chunks that " +
  "carry it on their own.";

export class WikiService {
  private static readonly noteWrites = new Map<string, Promise<unknown>>();

  private noteRequestHash(options: unknown): Promise<string> {
    return hashExactText(JSON.stringify(options, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value));
  }

  private async withNoteWrite<T>(libraryID: number, itemKey: string | undefined,
    run: (queued: boolean) => Promise<T>): Promise<T> {
    const sessions = await this.store.readingSessions();
    const key = `${libraryID}:${itemKey || (await sessions.getOpen(libraryID))?.itemKey || ""}`;
    const previous = WikiService.noteWrites.get(key);
    const current = (previous ?? Promise.resolve()).catch(() => undefined).then(() => run(Boolean(previous)));
    WikiService.noteWrites.set(key, current);
    try { return await current; }
    finally { if (WikiService.noteWrites.get(key) === current) WikiService.noteWrites.delete(key); }
  }
  private activeCommitOperations = new Set<string>();
  private readonly store: WikiStore;
  private readonly retriever: WikiRetriever;
  private readonly notes: WikiReadingNoteStore;
  private readonly skeletonRevisions = new Map<string, { revision: string; skeleton: any }>();

  private readonly prepareTokens = new Map<
    string,
    {
      libraryID: number;
      expiresAt: number;
      preparedPageTitles: Set<string>;
      /** Reading whose paper-based reconciliation this prepare call reviewed. */
      reconciliationSessionId?: number;
      /** A commit holding this token is running; a second one must not start. */
      inFlight?: boolean;
      context?: WikiPreparedContext;
      canCommit?: boolean;
      reviewScope?: { itemKey: string; topic: string };
    }
  >();

  constructor(
    store: WikiStore = getWikiStore(),
    notes: WikiReadingNoteStore = new WikiReadingNoteStore(),
  ) {
    this.store = store;
    this.retriever = new WikiRetriever(store);
    this.notes = notes;
    this.links = new WikiLinkService(store);
  }

  /** Cross-paper candidates. Public so the panel and the tools can reach it. */
  readonly links: WikiLinkService;

  /**
   * `wiki_status`, with the cross-paper layer folded in.
   *
   * The link counters are reported by TYPE as well as in total, because the
   * question they exist to answer is "which of the three discovery paths is
   * producing noise" and one aggregate cannot answer it. A rejection rate of
   * 0.8 on lexical signals and 0.1 on concept ones is a finding; their average
   * is a number with no referent.
   *
   * `linkRejectedRate` is watched for the opposite failure too. A model that
   * dismisses everything produces a library that looks exactly like one with
   * no real connections, and the ratio is what tells them apart.
   */
  async status(libraryID?: number): Promise<any> {
    const reviews = await this.store.crossPaperReviews();
    const base = {
      ...(await this.store.getStatus(libraryID)),
      pendingCommitOperations:
        await this.store.listPendingCommitOperations(libraryID),
      scope:
        libraryID === undefined
          ? { kind: "all_libraries" }
          : { kind: "library", libraryID },
      ...(await reviews.statistics(libraryID)),
    };
    try {
      if (libraryID !== undefined)
        return { ...base, ...(await this.links.statistics(libraryID)) };
      const totals: Record<string, any> = {};
      for (const id of await reviews.libraryIDs()) {
        const stats = await this.links.statistics(id);
        for (const [key, value] of Object.entries(stats)) {
          if (key === "linkRejectedRate") continue;
          if (typeof value === "number")
            totals[key] = (totals[key] ?? 0) + value;
          else if (value && typeof value === "object") {
            totals[key] ??= {};
            for (const [type, count] of Object.entries(value))
              totals[key][type] = (totals[key][type] ?? 0) + Number(count);
          }
        }
      }
      const settled =
        (totals.linkSignalsAccepted ?? 0) + (totals.linkSignalsRejected ?? 0);
      totals.linkRejectedRate = settled
        ? totals.linkSignalsRejected / settled
        : 0;
      return { ...base, ...totals };
    } catch (error) {
      // Status must answer. A link layer that cannot be read is itself worth
      // reporting, and is not a reason to withhold the Wiki's own counts.
      ztoolkit.log("[wiki] link statistics unavailable", error);
      return {
        ...base,
        linkStatisticsError:
          error instanceof Error ? error.message : String(error),
      };
    }
  }

  private prunePrepareTokens(): void {
    const now = Date.now();
    for (const [token, prepared] of this.prepareTokens) {
      if (!prepared.inFlight && prepared.expiresAt < now) this.prepareTokens.delete(token);
    }
    // The idle window is an hour, so the ceiling on how much prepared context
    // is held has to be a count, not the clock. Insertion order is close
    // enough to least-recently-used here because every touch re-inserts.
    if (this.prepareTokens.size <= WIKI_PREPARE_MAX_TOKENS) return;
    for (const [token, prepared] of this.prepareTokens) {
      if (this.prepareTokens.size <= WIKI_PREPARE_MAX_TOKENS) break;
      if (!prepared.inFlight) this.prepareTokens.delete(token);
    }
  }

  /** Look a token up without renewing it, dropping it if it has lapsed. */
  private readPrepareToken(token: string | undefined) {
    if (!token) return undefined;
    const prepared = this.prepareTokens.get(token);
    if (!prepared) return undefined;
    if (!prepared.inFlight && prepared.expiresAt < Date.now()) {
      this.prepareTokens.delete(token);
      return undefined;
    }
    return prepared;
  }

  /**
   * Restart a token's idle clock, and mark it as most recently used.
   *
   * Renewal on use is what makes the window an idle timeout rather than a
   * stopwatch started at `wiki_prepare_update`; the re-insertion is what makes
   * the eviction order above least-recently-used.
   */
  private renewPrepareToken(token: string): number {
    const prepared = this.prepareTokens.get(token);
    if (!prepared) return 0;
    prepared.expiresAt = Date.now() + WIKI_PREPARE_IDLE_SECONDS * 1000;
    this.prepareTokens.delete(token);
    this.prepareTokens.set(token, prepared);
    return prepared.expiresAt;
  }

  /** Look a token up AND renew it: the shape every non-paging caller wants. */
  private touchPrepareToken(token: string | undefined) {
    const prepared = this.readPrepareToken(token);
    if (prepared) this.renewPrepareToken(token!);
    return prepared;
  }

  async prepareUpdate(options: {
    libraryID: number;
    itemKey?: string;
    query: string;
    limit?: number;
    proposedPageTitles?: string[];
    /** Re-send the Wiki skeleton even if it has not changed. */
    refreshSkeleton?: boolean;
    knownSkeletonRevision?: string;
    compact?: boolean;
    preview?: boolean;
    checkpoint?: boolean;
    /**
     * The whole-Wiki review, required once a paper has been read in full.
     * See {@link assertReadyToWriteUp}.
     */
    wikiReview?: Partial<WikiWholeWikiReview>;
  }): Promise<any> {
    this.prunePrepareTokens();
    if (!options.preview) await this.recordWikiReviewIfOffered(
      options.libraryID,
      options.wikiReview,
      options.itemKey,
    );
    if (!options.preview && !options.checkpoint) await this.assertReadyToWriteUp(options.libraryID, options.itemKey);
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
    const openSession = options.itemKey
      ? await sessions.openForItem(options.libraryID, options.itemKey)
      : await sessions.getOpen(options.libraryID);
    if (openSession && !options.preview) await sessions.markPrepared(openSession.sessionId);
    let wikiReconciliation: any = null;
    if (openSession && openSession.finalSynthesisAt !== null) {
      const paper = await this.requirePaperItem(
        openSession.libraryID,
        openSession.itemKey,
      );
      const body = (await this.readNoteBody(paper, openSession)) ?? "";
      wikiReconciliation = await this.paperReconciliationSnapshot(
        openSession,
        body,
      );
      const claimsById = new Map(
        wikiReconciliation.claims.map((claim: any) => [claim.claimId, claim]),
      );
      const verdicts = openSession.wikiReview?.claimVerdicts ?? [];
      wikiReconciliation.requiredClaimActions = verdicts.reduce(
        (actions: any[], entry) => {
          const claim: any = claimsById.get(entry.claimId);
          if (!claim) return actions;
          if (entry.verdict === "overstated") {
            actions.push({
              action: "UPDATE_CLAIM",
              claimId: entry.claimId,
              expectedVersion: claim.version,
              claimText: entry.replacementClaimText,
              previousClaimText: entry.previousClaimText,
              basis: entry.basis,
            });
          }
          if (entry.verdict === "contradicted") {
            actions.push({
              action: "MARK_CONFLICT",
              claimId: entry.claimId,
              resultingEpistemicStatus: "disputed",
              basis: entry.basis,
            });
          }
          return actions;
        },
        [],
      );
      wikiReconciliation.humanReviewQueue = verdicts
        .filter((entry) => entry.verdict === "contradicted")
        .map((entry) => ({
          claimId: entry.claimId,
          reason: entry.basis,
          statusAfterCommit: "disputed",
        }));
    }
    // Every paper whose note has run ahead of the Wiki, so the write-up can be
    // planned over all of them at once. A round of questions typically leaves
    // three, and writing up one and forgetting the others is the failure this
    // list exists to make impossible to overlook.
    const pendingWiki = await sessions.listPendingWiki(options.libraryID);

    /*
     * Cross-paper candidates touching what this turn read.
     *
     * Narrowed to the chunks of the papers whose reading is being written up,
     * not to the whole library. A question that read five passages must not be
     * handed every candidate in the library that happens to mention one of
     * those papers: a forty-item checklist is not a checklist, and the honest
     * answer to most of it would be "I have not read that passage".
     *
     * `mustResolve` is computed by the server, per signal, against the reading
     * ledger. The model is never asked to judge whether the other paper "seems
     * to have been read" - that judgement is exactly the one it cannot make
     * and would answer optimistically.
     */
    const linkTargets = new Map<string, number[]>();
    if (openSession) linkTargets.set(openSession.itemKey, []);
    if (options.itemKey) linkTargets.set(options.itemKey, []);
    for (const entry of pendingWiki) {
      linkTargets.set(entry.session.itemKey, entry.pendingChunkIds);
    }
    const pendingLinkSignals: any[] = [];
    for (const [itemKey, chunkIds] of linkTargets) {
      try {
        pendingLinkSignals.push(
          ...(await this.links.pendingSignals({
            libraryID: options.libraryID,
            itemKey,
            chunkIds: chunkIds.length ? chunkIds : undefined,
            limit: Infinity,
          })),
        );
      } catch (error) {
        // A broken candidate table must not stop a write-up. The Wiki is the
        // durable thing here; candidates are suggestions about it.
        ztoolkit.log("[wiki] pending link signals unavailable", error);
      }
    }

    const prepareToken = `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 14)}`;
    this.prepareTokens.set(prepareToken, {
      libraryID: options.libraryID,
      expiresAt: Date.now() + WIKI_PREPARE_IDLE_SECONDS * 1000,
      preparedPageTitles: new Set(proposedPageTitles.map(normalizeWikiName)),
      canCommit: !options.preview,
      ...(openSession && openSession.wikiReviewAt !== null
        ? { reconciliationSessionId: openSession.sessionId }
        : {}),
    });
    const response = {
      ...exactCandidates,
      semanticClaims: semanticCandidates.claims.slice(0, options.limit ?? 10),
      semanticWarnings: semanticCandidates.warnings,
      searched: ["title", "alias", "concept", "claim", "embedding"],
      wikiSkeleton: await this.skeletonFor(options, proposedPageTitles),
      preparedPageTitles: proposedPageTitles,
      pagePreparations,
      prepareToken,
      prepareTokenExpiresInSeconds: WIKI_PREPARE_IDLE_SECONDS,
      crossPaperTasks: await this.prepareCrossPaperTasks(
        options.libraryID,
        options.itemKey ?? openSession?.itemKey,
        options.query,
        openSession,
      ),
      ...(wikiReconciliation ? { wikiReconciliation } : {}),
      ...(openSession
        ? {
            readingSession: {
              sessionId: openSession.sessionId,
              itemKey: openSession.itemKey,
              state: options.preview ? openSession.state : "prepared",
              mode: openSession.mode,
              wikiReviewRecorded: openSession.wikiReviewAt !== null,
            },
          }
        : {}),
      ...(pendingLinkSignals.length
        ? {
            pendingLinkSignals,
            pendingLinkNote:
              "跨文献候选连接：这些文献对是服务器根据代表性段落的语义相似度、" +
              "共享稀有术语或共享概念发现的，还没有被结算。" +
              "mustResolve=true 表示两侧所指向的**具体段落都已经被读过**，" +
              "本次写入必须对它给出结论；其余只是可选线索，不阻塞提交，也不要求你去读对方全文。" +
              "允许的结论有五种：共同支撑同一条 Claim（两侧都要写 Evidence）、" +
              "属于同一个主题 Page 但应保持为不同 Claim、在条件相当时给出矛盾结论、" +
              "能形成 concept↔concept 的可证关系、以及「只是套话或条件不可比」。" +
              "最后一种用 DISMISS_LINK_SIGNALS，并且**每一条 signal 各写各的理由**：" +
              "dismissals: [{ signalId, reason }, ...]，每条理由不少于 40 字并结合该 signal 自己的两段原文。" +
              "一条理由套一整批是不行的——同一批里的 signal 指向的是不同段落对，" +
              "一句话描述不了它们，存进去的判断就会挂在它没引用过的段落上。" +
              "推荐用 RESOLVE_LINK_SIGNAL 为每条候选明确填写 resolutionType 和 reason；" +
              "保留独立时使用 same_page 并填写 pageId 和两个 claimIds。无需为了结束而合并。" +
              "若某一对带有 reopenedReason，说明它以前被结算过、而当时的依据已经不成立" +
              "（Wiki 被重置过，或者后来出现了同时引用两篇的 Claim）：" +
              "priorDismissals 里是上一位读者的原话，请针对它作判断，不要原样重复一遍。",
          }
        : {}),
      ...(pendingWiki.length
        ? {
            pendingWikiWriteUp: pendingWiki.map((entry) => ({
              itemKey: entry.session.itemKey,
              mode: entry.session.mode,
              // The chunk ids themselves, because settling is now per chunk:
              // a Claim citing one of them settles that one, and every other
              // one has to be either cited too or explicitly written off.
              pendingChunkIds: entry.pendingChunkIds,
              pendingChunks: entry.pendingChunkIds.length,
            })),
            pendingWikiWriteUpNote:
              "These papers have reading in their notes that has not reached the Wiki, listed chunk by " +
              "chunk. This update should carry all of it: add or correct the Claims that reading " +
              "established, attach its Evidence quoted from those papers' own chunks, and update the " +
              "Concepts and relations it touched. A chunk is settled by being cited as Evidence, or - " +
              "when it genuinely established nothing the Wiki did not already hold - by a SKIP action " +
              "naming it with a reason. Anything left unsettled keeps its paper closed to further " +
              "question-driven reading.",
          }
        : {}),
    };
    const contextSkeleton = response.wikiSkeleton?.unchanged
      ? await this.skeletonFor({ ...options, knownSkeletonRevision: undefined }, proposedPageTitles)
      : response.wikiSkeleton;
    if (options.itemKey || openSession?.itemKey)
      this.prepareTokens.get(prepareToken)!.reviewScope = {
        itemKey: (options.itemKey ?? openSession?.itemKey)!,
        topic: openSession?.mode === "fulltext" ? "fulltext" : options.query,
      };
    return this.presentPreparedContext(response, options, contextSkeleton);
  }

  private async prepareCrossPaperTasks(
    libraryID: number,
    itemKey?: string,
    query = "question",
    session?: any,
  ): Promise<any[]> {
    if (!itemKey) return [];
    const reviews = await this.store.crossPaperReviews();
    return reviews.prepare({
      libraryID,
      itemKey,
      topic: session?.mode === "fulltext" ? "fulltext" : query,
      readingRevision: String(session?.sourceVersion ?? ""),
    });
  }

  private async ensureCommitReviewTasks(input: WikiCommitInput): Promise<void> {
    const sessions = await this.store.readingSessions();
    const scope = input.prepareToken
      ? this.touchPrepareToken(input.prepareToken)?.reviewScope
      : undefined;
    const keys = new Set<string>();
    if (scope) keys.add(scope.itemKey);
    const selected = input.readingSessionId
      ? await sessions.get(input.readingSessionId)
      : await sessions.getOpen(input.libraryID);
    if (selected?.libraryID === input.libraryID) keys.add(selected.itemKey);
    for (const action of input.actions)
      for (const e of (action as any).evidence ?? []) keys.add(e.itemKey);
    const reviews = await this.store.crossPaperReviews();
    const submitted = new Set(
      (input.crossPaperReview ?? []).map((r) => r.taskId),
    );
    for (const itemKey of keys) {
      const session = await sessions.openForItem(input.libraryID, itemKey);
      if (!session && scope?.itemKey !== itemKey) continue;
      const taskList = await this.prepareCrossPaperTasks(
        input.libraryID,
        itemKey,
        scope?.itemKey === itemKey ? scope.topic : "question",
        session,
      );
      const pending = taskList.filter(
        (t) => t.required && !submitted.has(t.taskId),
      );
      if (pending.length && !input.checkpoint)
        throw new Error(
          `Cross-paper Wiki review required for task(s) ${pending.map((t) => t.taskId).join(", ")}. ` +
            "Use wiki_prepare_update and page crossPaperTasks. Submit crossPaperReview with explicit exclusions or gaps. Use checkpoint true to save progress without completing reading.",
        );
    }
    await reviews.validateSnapshots(
      input.libraryID,
      input.crossPaperReview ?? [],
    );
  }

  private async presentPreparedContext(
    response: any,
    options: { compact?: boolean; preview?: boolean; libraryID: number },
    contextSkeleton = response.wikiSkeleton,
  ): Promise<any> {
    const { prepareToken, wikiReconciliation, pendingLinkSignals = [], wikiSkeleton: skeleton } = response;
    const allClaims = new Map<number, any>();
    for (const claim of [...response.claims, ...response.semanticClaims, ...(wikiReconciliation?.claims ?? []),
      ...response.pagePreparations.flatMap((page: any) => [...(page.claims ?? []), ...(page.semanticClaims ?? [])])]) {
      if (!allClaims.has(claim.claimId)) {
        const stored = await this.store.getClaim(claim.claimId);
        allClaims.set(claim.claimId, stored ? { ...stored, score: claim.score } : claim);
      }
    }
    const crossPaperCandidates: any[] = [];
    for (const itemKey of new Set<string>(pendingLinkSignals.map((entry: any) => entry.otherItemKey))) {
      const related = await this.store.listClaimsByEvidenceSource(options.libraryID, itemKey);
      for (const claim of related) allClaims.set(claim.claimId, { ...claim, score: allClaims.get(claim.claimId)?.score });
      crossPaperCandidates.push(...related.map((claim) => ({ ...compactWikiClaim(claim), sourceItemKey: itemKey })));
    }
    const signalViews = new Map<number, any>();
    for (const pair of pendingLinkSignals) {
      const individual = pair.signals ?? (pair.signalIds ?? []).map((signalId: number) => ({
        signalId, mustResolve: pair.mustResolve, signalType: pair.signalTypes?.[0],
        thisChunk: pair.thisChunk, otherChunk: pair.otherChunk,
      }));
      for (const signal of individual) signalViews.set(signal.signalId, {
        linkId: pair.linkId, otherItemKey: pair.otherItemKey, otherTitle: pair.otherTitle,
        ...signal, signalIds: [signal.signalId], suggestedLabels: pair.suggestedLabels,
        priorDismissals: pair.priorDismissals?.filter((prior: any) => prior.signalId === signal.signalId),
      });
    }
    const signals = [...signalViews.values()].sort((a, b) => Number(b.mustResolve) - Number(a.mustResolve) || a.signalId - b.signalId);
    const reviewTasks = {
      sourceClaimIds: (wikiReconciliation?.claims ?? []).map(
        (claim: any) => claim.claimId,
      ),
      crossPaperTaskIds: (response.crossPaperTasks ?? [])
        .filter((task: any) => task.required)
        .map((task: any) => task.taskId),
      mandatorySignalIds: signals
        .filter((signal) => signal.mustResolve)
        .map((signal) => signal.signalId),
      note: "Read all obligations from context section reviewTasks. Submit required crossPaperReview entries (or explicitly select empty tasks with deferMissingTargets). Task reviews cover their mapped signals; use RESOLVE_LINK_SIGNAL only for remaining mandatory signals.",
    };
    const preparation = [
      { kind: "skeleton", ...contextSkeleton },
      {
        kind: "reconciliation",
        ...wikiReconciliation,
        claims: undefined,
        readingRecords: undefined,
      },
      ...response.pagePreparations.map((p: any) => ({
        kind: "pagePreparation",
        ...p,
      })),
      {
        kind: "metadata",
        preparedPageTitles: response.preparedPageTitles,
        searched: response.searched,
        semanticWarnings: response.semanticWarnings,
      },
    ];
    const context: WikiPreparedContext = boundPreparedContext({
      pages: contextSkeleton?.pages ?? [],
      claims: [...allClaims.values()].map(compactWikiClaim),
      evidence: fragmentContextText(
        [...allClaims.values()].flatMap((claim) =>
          (claim.evidence ?? []).map((entry: any) => ({
            ...entry,
            claimId: claim.claimId,
          })),
        ),
        "excerpt",
      ),
      readingRecords: fragmentContextText(
        wikiReconciliation?.readingRecords ?? [],
        "content",
      ),
      linkSignals: signals,
      concepts: [
        ...(response.concepts ?? []),
        ...(contextSkeleton?.nearbyConcepts ?? []),
        ...(contextSkeleton?.hubConcepts ?? []),
        ...(contextSkeleton?.duplicateCandidates ?? []),
        ...response.pagePreparations.flatMap(
          (page: any) => page.concepts ?? [],
        ),
      ],
      relations: contextSkeleton?.relations ?? [],
      crossPaperTasks: response.crossPaperTasks ?? [],
      claimRelations: await (
        await this.store.crossPaperReviews()
      ).relations(options.libraryID),
      preparation,
      reviewTasks: [
        ...reviewTasks.sourceClaimIds.map((claimId: number) => ({
          kind: "sourceClaim",
          claimId,
        })),
        ...(response.crossPaperTasks ?? []).map((t: any) => ({
          kind: "crossPaperTask",
          taskId: t.taskId,
          revision: t.revision,
          required: t.required,
          targetCount: t.targetCount,
          relatedItemKey: t.relatedItemKey,
        })),
        ...reviewTasks.mandatorySignalIds.map((signalId: number) => ({
          kind: "mandatorySignal",
          signalId,
        })),
      ],
      pendingWikiWriteUp: response.pendingWikiWriteUp ?? [],
    });
    this.prepareTokens.get(prepareToken)!.context = context;
    const contextIndex = {
      tool: "wiki_get_prepared_context",
      prepareToken,
      sections: Object.fromEntries(
        Object.entries(context).map(([key, values]) => [key, values.length]),
      ),
      unit: "context_entry",
      fragmentNote:
        "Counts and limits refer to stored entries, including fragments, not logical tasks. Pages may stop at the character budget; always use nextOffset. Join text for each contextFragment.entryIndex in offset order, then JSON.parse. Text fields with textFragment are joined directly. For cross-paper tasks prefer wiki_get_link_review with taskId, section targets, and expectedRevision.",
      recovery:
        "Successful context reads renew the ten-minute idle timeout. After inactivity or restart, prepare again; recover durable tasks and reviews with wiki_get_link_review.",
    };
    if (options.compact === false) return { prepareToken, ...response, preview: options.preview === true, context: contextIndex, crossPaperCandidates, reviewTasks };
    return compactPreparedResponse(
      { ...response, preview: options.preview === true },
      contextIndex,
      reviewTasks,
      crossPaperCandidates,
      signals,
    );
  }

  getPreparedContext(options: {
    libraryID: number;
    prepareToken: string;
    section: string;
    offset?: number;
    limit?: number;
  }): any {
    this.prunePrepareTokens();
    // Deliberately the non-renewing lookup: the renewal below happens only
    // after the page was actually produced, so a read for a section that does
    // not exist cannot keep a token alive.
    const prepared = this.readPrepareToken(options.prepareToken);
    if (!prepared?.context || prepared.libraryID !== options.libraryID)
      throw new WikiPreparedContextExpired();
    const page = pagePreparedContext(
      prepared.context,
      options.section,
      options.offset,
      options.limit,
    );
    const expiresAt = this.renewPrepareToken(options.prepareToken);
    return {
      prepareToken: options.prepareToken,
      prepareTokenExpiresInSeconds: WIKI_PREPARE_IDLE_SECONDS,
      prepareTokenExpiresAt: expiresAt,
      ...page,
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
  private async assertReadyToWriteUp(
    libraryID: number,
    itemKey?: string,
  ): Promise<void> {
    const sessions = await this.store.readingSessions();
    const requestedKey = String(itemKey ?? "").trim();
    const open = requestedKey
      ? await sessions.openForItem(libraryID, requestedKey)
      : await sessions.getOpen(libraryID);
    if (!open || !open.expert) return;
    const coverage = await sessions.coverage(open.sessionId);
    if (!coverage.complete) return;
    if (open.finalSynthesisAt === null) {
      throw new Error(
        `Every chunk of ${open.itemKey} has been delivered, but its macro summary has not been appended. ` +
          "Do that pass first: call wiki_update_reading_note with finalSynthesis true and macroSummary; " +
          "the summary must distil the paper's core content and methods, " +
          "then come back to wiki_prepare_update. (Committing PART of a paper you are still reading is " +
          "always allowed - this only applies once the whole paper has been delivered.)",
      );
    }
    // The terminology pass, for the same reason as the synthesis pass, and
    // after it: the concepts a paper established are read off the whole-paper
    // account, not off the batch that happened to mention them. Asking for
    // that once, deliberately, is what turns scattered per-batch notes into a
    // concept library. An empty answer with a reason is accepted - most papers
    // introduce nothing the library did not already hold.
    if (open.conceptsRecordedAt === null) {
      throw new Error(
        `${open.itemKey} has been read and synthesised, but its concepts have not been reviewed as a whole. ` +
          "Call wiki_record_concepts ONCE with final true - anything you staged while reading is written by that same call - and the terms this paper established, each with whatever " +
          "of Chinese full name, English full name and abbreviation you can actually confirm, and never an " +
          "abbreviation alone - or with an empty concepts list and noConceptsReason if it introduced nothing " +
          "new. Then come back to wiki_prepare_update.",
      );
    }
    // The last gate, and the widest. The two above look at the NOTE and at the
    // terminology; neither looks at the Wiki, which by this point has usually
    // been growing for a while - a Page created after the third question, a
    // Claim written from chunk 20 that chunk 140 turns out to qualify, Evidence
    // gathered at chunk_local that the completed read can now carry deeper, two
    // Concepts that six questions apart became duplicates, a relation drawn
    // early that no longer holds. Incremental building is what makes the Wiki
    // useful during a read and what makes it drift by the end of one, and the
    // only moment the drift is visible is now, with the whole paper in hand.
    //
    // Answered once, in five sentences, and remembered - a retry after a
    // validation error does not re-ask. "Nothing to change here, because ..."
    // is a proper answer to any axis and is the commonest one; what is not
    // accepted is silence, which cannot be told from not having looked.
    if (open.wikiReviewAt === null) {
      throw new Error(
        `${open.itemKey} is read, synthesised and its concepts are recorded. One pass left before the ` +
          "write-up: review the WHOLE Wiki against the finished paper, not just the part you are about " +
          "to add. Call wiki_prepare_update again with wikiReview, an object answering all five of " +
          "pages, claims, evidence, concepts and relations — for each, what this paper means you should " +
          "ADD, CORRECT, MERGE or LEAVE ALONE in what the Wiki already holds, and why. Concretely: " +
          "pages — does an existing Page need adjusting, or a new one creating; claims — which existing " +
          "Claims does the complete reading confirm, qualify, merge or contradict; evidence — which " +
          "Claims are thin, and which Evidence gathered mid-read can now be re-cited at full-paper " +
          "depth; concepts — which terms need adding, correcting or de-duplicating; relations — which " +
          "links between concepts and claims should be drawn or withdrawn. " +
          `Each answer needs at least ${WIKI_REVIEW_MIN_AXIS_CHARS} characters, and "nothing to change, ` +
          'because ..." is a real answer. The candidates this call returns are what you review against.',
      );
    }
  }

  /**
   * Store the whole-Wiki review when a caller supplies one.
   *
   * Validated here rather than in the gate so a malformed review is reported as
   * a malformed review, instead of silently leaving the gate shut and sending
   * the caller round the same loop wondering why its answer was ignored.
   */
  private async recordWikiReviewIfOffered(
    libraryID: number,
    review: Partial<WikiWholeWikiReview> | undefined,
    itemKey?: string,
  ): Promise<void> {
    if (!review || typeof review !== "object") return;
    const sessions = await this.store.readingSessions();
    const requestedKey = String(itemKey ?? "").trim();
    const open = requestedKey
      ? await sessions.openForItem(libraryID, requestedKey)
      : await sessions.getOpen(libraryID);
    // Nowhere to record it, so nothing to record. The review belongs to a
    // completed reading; an unfinished question-driven update has no such pass
    // and is not gated on one. Ignoring the argument rather than refusing the call keeps
    // an over-eager caller from turning a harmless extra field into a failed
    // write-up - the gate that actually needs the review asks for it by name.
    if (!open) return;

    // The review is a review OF A FINISHED PAPER, and until now it was only a
    // review of an open one. A caller could answer all five axes on page two
    // of a 181-chunk paper, have it stamped, and never be asked again - the
    // gate at the end only checked that SOMETHING had been recorded, so the
    // pass it exists to force was skippable by doing it before there was
    // anything to review. Both conditions are required, and they are the same
    // depth rule uses, plus the independent whole-paper terminology pass:
    // every chunk delivered, the macro summary appended after all records,
    // and its final concepts recorded. Refused rather than ignored, because a
    // caller that sent a review and got silence would reasonably believe the
    // pass was done.
    const coverage = await sessions.coverage(open.sessionId);
    if (
      !coverage.complete ||
      open.finalSynthesisAt === null ||
      open.conceptsRecordedAt === null
    ) {
      throw new Error(
        `The whole-Wiki review is the LAST pass over a finished paper, and ${open.itemKey} is not ` +
          "ready for it: " +
          (coverage.complete
            ? open.finalSynthesisAt === null
              ? "every chunk has been delivered, but the macro summary has not been appended"
              : "the macro summary has been appended after all reading records, but the paper's " +
                "concepts have not been reviewed as a whole with wiki_record_concepts final true"
            : `${coverage.deliveredChunks} of ${coverage.totalChunks} chunks have been delivered` +
              (coverage.firstMissingIndex === null
                ? ""
                : `, resume at chunk index ${coverage.firstMissingIndex}`)) +
          ". Reviewing now would complete the final Wiki pass before all earlier whole-paper passes, " +
          "and it would then count forever and never be asked for again. Nothing was recorded. Finish the paper with " +
          "wiki_build_from_paper, do the whole-paper synthesis with wiki_update_reading_note and " +
          "finalSynthesis true, complete the terminology pass with wiki_record_concepts and final true, " +
          "then send wikiReview. Committing what you have read so far is still allowed in the meantime " +
          "- just leave wikiReview out of those calls.",
      );
    }

    const missing: string[] = [];
    const complete: Record<string, unknown> = {};
    for (const axis of WIKI_REVIEW_AXES) {
      const text = String(
        (review as Record<string, unknown>)[axis] ?? "",
      ).trim();
      if (text.length < WIKI_REVIEW_MIN_AXIS_CHARS) {
        missing.push(axis);
        continue;
      }
      complete[axis] = text;
    }
    if (missing.length) {
      throw new Error(
        `The Wiki review is missing a real answer for: ${missing.join(", ")}. All five of ` +
          `${WIKI_REVIEW_AXES.join(", ")} must be answered with at least ` +
          `${WIKI_REVIEW_MIN_AXIS_CHARS} characters saying what this paper means for what the Wiki ` +
          'already holds. "Nothing to change here, because the paper only confirms what page X already ' +
          'states" is a valid answer; an empty string is not, because it cannot be told apart from not ' +
          "having looked.",
      );
    }
    const sourceClaims = await this.store.listClaimsByEvidenceSource(
      open.libraryID,
      open.itemKey,
    );
    const rawVerdicts = Array.isArray((review as any).claimVerdicts)
      ? (review as any).claimVerdicts
      : [];
    const claimById = new Map(sourceClaims.map((claim) => [claim.claimId, claim]));
    const verdictById = new Map<number, any>();
    const allowedVerdicts = new Set([
      "confirmed",
      "qualified",
      "overstated",
      "contradicted",
      "unsupported",
    ]);
    for (const raw of rawVerdicts) {
      const claimId = Number(raw?.claimId);
      const claim = claimById.get(claimId);
      if (!claim) {
        throw new Error(
          `claimVerdicts contains Claim ${claimId}, which is not backed by Evidence from ${open.itemKey}. Review exactly the Claims in the paper-based reconciliation snapshot.`,
        );
      }
      if (verdictById.has(claimId)) {
        throw new Error(`claimVerdicts contains Claim ${claimId} more than once.`);
      }
      const verdict = String(raw?.verdict ?? "").trim();
      const basis = String(raw?.basis ?? "").trim();
      if (!allowedVerdicts.has(verdict)) {
        throw new Error(
          `Claim ${claimId} has invalid verdict "${verdict}". Use confirmed, qualified, overstated, contradicted or unsupported.`,
        );
      }
      if (basis.length < WIKI_REVIEW_MIN_AXIS_CHARS) {
        throw new Error(
          `Claim ${claimId} needs a concrete basis of at least ${WIKI_REVIEW_MIN_AXIS_CHARS} characters for verdict ${verdict}.`,
        );
      }
      const normalized: Record<string, unknown> = { claimId, verdict, basis };
      if (verdict === "overstated") {
        const previousClaimText = String(raw?.previousClaimText ?? "").trim();
        const replacementClaimText = String(
          raw?.replacementClaimText ?? "",
        ).trim();
        if (previousClaimText !== claim.claimText) {
          throw new Error(
            `Claim ${claimId} is marked overstated, but previousClaimText does not match version ${claim.version}. Copy the current text exactly so the revision audit cannot drift.`,
          );
        }
        if (!replacementClaimText || replacementClaimText === claim.claimText) {
          throw new Error(
            `Claim ${claimId} is marked overstated and needs a different replacementClaimText for UPDATE_CLAIM.`,
          );
        }
        normalized.previousClaimText = previousClaimText;
        normalized.replacementClaimText = replacementClaimText;
      }
      verdictById.set(claimId, normalized);
    }
    const unreviewed = sourceClaims.filter(
      (claim) => !verdictById.has(claim.claimId),
    );
    if (unreviewed.length) {
      throw new Error(
        `claimVerdicts must judge every Claim backed by ${open.itemKey}. Missing Claim(s): ${unreviewed.map((claim) => claim.claimId).join(", ")}.`,
      );
    }
    complete.claimVerdicts = [...verdictById.values()];
    await sessions.recordWikiReview(
      open.sessionId,
      complete as unknown as WikiWholeWikiReview,
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

  /**
   * The chunks a note is allowed to cite, addressed the way the model saw them.
   *
   * `wiki_build_from_paper` hands back both a `chunkIndex` (position in the
   * paper) and a `chunkId` (the row in the index), and they coincide for
   * almost every document - which is exactly why a rule that accepted only one
   * of them would look correct for a year and then refuse a perfectly good
   * note on the one paper whose index was rebuilt with a gap. So both
   * addresses resolve to the same text here, and a citation is accepted if it
   * matches either.
   *
   * Undelivered chunks are excluded on purpose. The note may only cite what
   * this reading has actually been shown; a number from the half it has not
   * reached is either a typo or an invention, and both are worth refusing
   * while the reader can still say which it was.
   */
  /**
   * The two addresses each of this paper's chunks answers to.
   *
   * Position and row id coincide for almost every document, which is exactly
   * why code that assumes one of them looks correct until the day it meets a
   * paper whose index was rebuilt with a gap. `readableChunks` already accepts
   * either when resolving a citation; this is the same equivalence, in the
   * form the record/summary comparison needs.
   */
  private async chunkAddressAliases(
    libraryID: number,
    itemKey: string,
  ): Promise<Map<number, number[]>> {
    const aliases = new Map<number, number[]>();
    try {
      const vectorStore = getVectorStore();
      await vectorStore.initialize();
      const chunks = await vectorStore.getChunksForItem(itemKey, libraryID);
      chunks.forEach((chunk: any, index: number) => {
        const chunkId = Number(chunk?.chunkId);
        if (!Number.isInteger(chunkId) || chunkId === index) return;
        aliases.set(index, [chunkId]);
        aliases.set(chunkId, [index]);
      });
    } catch {
      // A paper whose index cannot be read has no aliases to offer; the
      // comparison then falls back to exact addresses, which is what it did
      // before this existed.
    }
    return aliases;
  }

  private async readableChunks(
    libraryID: number,
    itemKey: string,
    deliveredIndexes: readonly number[],
  ): Promise<WikiAuditChunk[]> {
    const vectorStore = getVectorStore();
    await vectorStore.initialize();
    const chunks = await vectorStore.getChunksForItem(itemKey, libraryID);
    const out: WikiAuditChunk[] = [];
    const seen = new Set<number>();
    for (const index of deliveredIndexes) {
      const chunk = chunks[index];
      if (!chunk) continue;
      for (const address of [index, chunk.chunkId]) {
        if (seen.has(address)) continue;
        seen.add(address);
        out.push({ chunkId: address, text: chunk.text });
      }
    }
    return out.sort((a, b) => a.chunkId - b.chunkId);
  }

  private assertReadingRecordValid(
    record: string,
    options: {
      fulltext: boolean;
      recordChunkIds: number[];
      allowedChunkIds: Iterable<number>;
      totalChunks: number;
      batchChunks: readonly WikiAuditChunk[];
      readable: readonly WikiAuditChunk[];
      currentChunkAddresses: ReadonlySet<number>;
      explicitRecord: boolean;
      audit: readonly WikiSynthesisAuditEntry[];
    },
  ): void {
    const validation = new WikiValidation({
      mode: "record",
      requiredSections: options.fulltext ? WIKI_RECORD_SECTIONS : [],
    });
    const path = "/readingRecord";
    const syntax = validation.check(path, "CHUNK_CITATIONS", () =>
      assertChunkCitations(record),
    );
    const addresses =
      syntax &&
      validation.check(path, "CITATION_ADDRESSES", () =>
        assertChunkCitationsResolvable(record, options),
      );
    if (syntax)
      validation.check(path, "BLOCK_CITATIONS", () =>
        assertBlockCitations(record),
      );
    if (options.fulltext) {
      validation.check(path, "RECORD_TEMPLATE", () =>
        assertTemplateSections(record, WIKI_RECORD_SECTIONS, "阅读记录"),
      );
      const sections = splitTemplateSections(record, WIKI_RECORD_SECTIONS);
      for (const label of ["方法", "结果与结论"]) {
        const body = sections.get(label);
        if (body?.trim())
          validation.check(
            path,
            "CONNECTED_PROSE",
            () => assertProseIsConnected(body, `阅读记录的「${label}」`),
            label,
          );
      }
    }
    if (syntax) {
      validation.check(path, "CHUNK_COVERAGE", () =>
        assertBatchChunkCoverage(record, options.recordChunkIds),
      );
      validation.check(path, "MEASURED_VALUES", () =>
        assertValuesLanded(record, options.batchChunks, "阅读记录"),
      );
    }
    if (addresses)
      validation.check(path, "SYNTHESIS_AUDIT", () =>
        this.assertReadingRecordAudited(
          record,
          options.readable,
          options.currentChunkAddresses,
          options.explicitRecord,
          options.audit,
        ),
      );
    validation.finish();
  }

  private assertReadingRecordAudited(
    record: string,
    readable: readonly WikiAuditChunk[],
    currentChunkAddresses: ReadonlySet<number>,
    explicitRecord: boolean,
    synthesisAudit: readonly WikiSynthesisAuditEntry[],
  ): void {
    assertSynthesisEvidenceClosure(
      record,
      explicitRecord
        ? readable.filter((chunk) => currentChunkAddresses.has(chunk.chunkId))
        : readable,
      synthesisAudit,
      "record",
    );
  }

  /**
   * The Wiki as seen from where this paper is standing.
   *
   * WHY NOT A QUERY. The recall around this is query-driven: a proposed title
   * and a semantic search return perhaps ten neighbouring Claims. That is the
   * right tool for "has this been said before", and the wrong one for "how
   * does this paper sit against the thirty already in here" - because the
   * model does not know what to ask for until it can see what is there.
   * Thirty-one papers written up through the query path produced ZERO
   * relations between them; not one was refused, and none was ever offered.
   *
   * WHY NOT THE WHOLE WIKI EITHER. The first fix for that was to enumerate
   * everything - every page, every concept with a 120-character description,
   * every relation. That is 102 characters per concept, and it is sent again
   * for every paper written up, so reading a library front to back costs
   * roughly N squared. Measured on this library's own entries it reaches
   * ~120k tokens per call at 500 papers and ~376k at 2000, where it stops
   * being an expense and becomes a functional failure: the response cannot be
   * sent, so the Wiki cannot be written at all.
   *
   * WHAT REPLACES IT. The failure that produced zero relations was not "the
   * model saw too little", it was "the model had to name what it wanted".
   * The server does not have that problem: `wiki_record_concepts` is a
   * precondition of this call and records, for every term, the paper it was
   * read out of - so by the time we are here the paper's own concept list is
   * in the database and can seed a recall nobody had to think of.
   *
   * The three parts of the old dump have different growth rates and are
   * handled differently:
   *
   *   - PAGES stay complete. They grow per topic, not per paper - a thousand
   *     papers is still tens of pages - and the page list is the answer to
   *     "which page does this extend", which is the question the skeleton
   *     exists for.
   *   - CONCEPTS become a neighbourhood: what this paper may be duplicating,
   *     what sits near it in meaning, what is already one relation away, and
   *     the dozen most-connected hubs as the catch-all for a real link that
   *     embedding proximity cannot see. Bounded by the paper, not the library.
   *   - RELATIONS are restricted to that neighbourhood, since a relation
   *     between two concepts this paper has nothing to do with is not
   *     something it can extend.
   *
   * What is deliberately NOT here is the flat list of every concept name.
   * Duplicate detection was the reason to keep it, and a vector search does
   * that job better than a wall of names a model skims: `界面换热系数` and
   * `界面传热系数` normalize differently and are the same concept, which only
   * the vectors can see. The cost of that is real and stated in the response:
   * a link between two genuinely distant fields is not reachable this way,
   * and `wiki_list_concepts` remains the way to go looking for one.
   */
  /**
   * The skeleton, or a note saying it has not changed since the last one.
   *
   * `wiki_prepare_update` is called once per paper in a full-text read but
   * once per answering turn in question-driven reading, and the structure it
   * returns is usually identical across those turns - several verbatim copies
   * of the same thing accumulating in one conversation's context. Sending
   * "unchanged" instead costs a line.
   *
   * The revision identifies the library content and this request's paper and
   * query. Suppression requires the caller to acknowledge that exact revision;
   * a new client receives the full skeleton even if another client cached it.
   */
  private async skeletonFor(
    options: {
      libraryID: number;
      itemKey?: string;
      query: string;
      refreshSkeleton?: boolean;
      knownSkeletonRevision?: string;
    },
    proposedPageTitles: string[],
  ): Promise<any> {
    const revision = await this.store.wikiRevision(options.libraryID);
    const embedding = getEmbeddingService();
    await embedding.initialize();
    const modelConfig = embedding.getConfigurationIdentity();
    const key = JSON.stringify([options.libraryID, options.itemKey ?? "", options.query, proposedPageTitles, modelConfig]);
    const responseRevision = await hashExactText(JSON.stringify([key, revision]));
    const cached = this.skeletonRevisions.get(key);
    if (!options.refreshSkeleton && options.knownSkeletonRevision === responseRevision && cached?.revision === revision) {
      return {
        unchanged: true,
        revision: responseRevision,
        note:
          "Wiki 结构自本次会话上一份骨架以来没有变化，沿用那一份。" +
          "若你手上没有它，用 refreshSkeleton true 重新获取。",
      };
    }
    const probes = Array.from(
      new Set(
        [...proposedPageTitles, options.query]
          .map((text) => normalizeWikiText(text ?? ""))
          .filter(Boolean),
      ),
    );
    if (!options.refreshSkeleton && cached?.revision === revision) {
      return { ...JSON.parse(JSON.stringify(cached.skeleton)), revision: responseRevision };
    }
    const skeleton = await this.wikiSkeleton(options.libraryID, {
      itemKey: options.itemKey,
      probes,
    });
    if (!skeleton.warnings?.length) this.skeletonRevisions.set(key, { revision, skeleton: JSON.parse(JSON.stringify(skeleton)) });
    while (this.skeletonRevisions.size > 8) this.skeletonRevisions.delete(this.skeletonRevisions.keys().next().value!);
    return { ...skeleton, revision: responseRevision };
  }

  private async wikiSkeleton(
    libraryID: number,
    options: { itemKey?: string; probes: string[] },
  ): Promise<any> {
    const warnings: string[] = [];
    let model = "";
    let identity: EmbeddingIdentity | undefined;
    const probes: { text: string; vector: Float32Array | null }[] = [];
    try {
      const embeddingService = getEmbeddingService();
      for (const text of options.probes) {
        const embedded = await embeddingService.embed(text, "auto", true);
        if (identity && !sameEmbeddingSpace(identity, embedded.identity)) throw new Error("Embedding configuration changed between concept probes; retry this request.");
        identity = embedded.identity;
        model = embedded.identity.model;
        probes.push({
          text,
          vector: embedded.embedding,
        });
      }
    } catch (error) {
      /*
       * Degrade rather than fail. Without vectors the duplicate check falls
       * back to exact name and alias matching, which is what it was before
       * concepts had vectors at all - weaker, but a write-up blocked entirely
       * because an embedding backend is down would be worse.
       */
      warnings.push(
        `概念向量召回不可用，本次查重只做名称与别名的字面匹配（近义异名可能漏判）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      for (const text of options.probes) {
        if (!probes.some((probe) => probe.text === text)) {
          probes.push({ text, vector: null });
        }
      }
    }

    const seedConceptIds = options.itemKey
      ? await this.store.conceptIdsForItem(libraryID, options.itemKey)
      : [];
    if (identity) await this.store.requeueIncompatibleEmbeddings(libraryID, identity);
    const [pages, neighbourhood, duplicates, extendable] = await Promise.all([
      this.store.listPageTitles(libraryID),
      this.store.conceptNeighbourhood({
        libraryID,
        seedConceptIds,
        seedVectors: probes
          .map((probe) => probe.vector)
          .filter((vector): vector is Float32Array => Boolean(vector)),
        model,
        identity,
        warnings,
        limit: WIKI_SKELETON_NEIGHBOURS,
        hubLimit: WIKI_SKELETON_HUBS,
      }),
      this.store.matchConcepts({
        libraryID,
        probes,
        model,
        identity,
        warnings,
        limit: 5,
        // Annotates each candidate with sourceDocuments / sourcedFromThisPaper.
        // Without it the duplicate list says a concept exists and stops there,
        // which the model reads as "nothing to do" - see WikiConceptMatch.
        itemKey: options.itemKey,
      }),
      this.store.pagesNearVectors({
        libraryID,
        vectors: probes
          .map((probe) => probe.vector)
          .filter((vector): vector is Float32Array => Boolean(vector)),
        seedConceptIds,
        model,
        identity,
        warnings,
        limit: WIKI_SKELETON_EXTENDABLE_PAGES,
      }),
    ]);

    const describe = (concept: {
      name: string;
      type: string;
      description: string;
      score?: number;
    }) => ({
      name: concept.name,
      type: concept.type,
      description: concept.description.slice(0, 120),
      ...(concept.score ? { score: concept.score } : {}),
    });

    return {
      note:
        "这不是 Wiki 全量，是以本篇论文为中心召回的邻域——页目录是完整的，" +
        "概念只给与本篇相关的那些。写入前先看它：本篇该扩展哪些页、" +
        "哪些概念已经存在（别重复造）、能和哪些概念建立关系。" +
        "duplicateCandidates 里 sourcedFromThisPaper false 的条目，" +
        "是本篇也在用、但还没把本篇登记为来源的概念：用 wiki_record_concepts " +
        "提交它的 conceptId，配一条 source（本篇 itemKey、真正读过的 chunkIdSnapshot、" +
        "以及从该 chunk 原文摘出的 excerpt），不要带任何命名字段——这种提交会立即写入，" +
        "不进暂存，服务器只追加来源，不新建概念。" +
        "只被一篇文献引用的术语连接不了任何两篇文献，sourceDocuments 就是它现在连了几篇。" +
        "一页 ≠ 一篇文献：页是主题，一篇文献通常横跨好几个主题，" +
        "所以正常结果是把 Claim 分别挂到若干个已有页上，而不是新建一页装下整篇。" +
        "pagesToExtend 按语义近似列出了最可能容纳本篇的已有页。" +
        "要展开某一页用 wiki_get_page；要在邻域之外找概念用 wiki_list_concepts。",
      pageCount: pages.length,
      pages,
      pagesToExtend: extendable,
      conceptCount: neighbourhood.conceptCount,
      duplicateCandidates: duplicates,
      paperConcepts: neighbourhood.seeds.map((concept) => concept.name),
      nearbyConcepts: neighbourhood.neighbours.map(describe),
      relatedConcepts: neighbourhood.related.map(describe),
      hubConcepts: neighbourhood.hubs.map((concept) => ({
        ...describe(concept),
        degree: concept.degree,
      })),
      relations: neighbourhood.relations,
      ...(neighbourhood.pendingVectors
        ? {
            recallIncomplete: `${neighbourhood.pendingVectors} 个概念还没有向量，本次邻域召回不完整；后台建完后会自动补上。`,
          }
        : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /** Records and Claims aligned by one paper, without query-based recall. */
  private async paperReconciliationSnapshot(
    session: WikiReadingSessionRecord,
    body: string,
  ): Promise<any> {
    const parsed = parseAppendOnlyReadingNote(body);
    const claims = await this.store.listClaimsByEvidenceSource(
      session.libraryID,
      session.itemKey,
    );
    return {
      itemKey: session.itemKey,
      readingRecords: parsed.records.map((record) => ({
        recordNumber: record.number,
        chunkIds: record.chunkIds,
        noNewContent: record.noNewContent,
        content: record.content,
      })),
      claims: claims.map((claim) => ({
        claimId: claim.claimId,
        pageId: claim.pageId,
        pageTitle: claim.pageTitle,
        claimText: claim.claimText,
        epistemicStatus: claim.epistemicStatus,
        coverageLevel: claim.coverageLevel,
        version: claim.version,
        evidence: claim.evidence.filter(
          (entry) =>
            entry.libraryID === session.libraryID &&
            entry.itemKey === session.itemKey,
        ),
      })),
      requiredVerdicts: [
        "confirmed",
        "qualified",
        "overstated",
        "contradicted",
        "unsupported",
      ],
      actionPolicy: {
        overstated:
          "Use UPDATE_CLAIM with expectedVersion, and preserve previousClaimText, replacementClaimText and basis in wikiReview.claimVerdicts.",
        contradicted:
          "Use MARK_CONFLICT with contradicting Evidence; the Claim becomes disputed for human review.",
        unsupported:
          "At commit, this paper's SUPPORTS links are archived in the review audit and retracted. Claim status is recomputed from the remaining sources; other papers' support is preserved.",
      },
    };
  }

  private async hydrateEvidence(
    entry: any,
    libraryID: number,
    warnings: string[],
    /**
     * Which action and Claim this excerpt belongs to.
     *
     * A commit routinely carries a dozen excerpts across several Claims, and a
     * refusal that does not say which one failed leaves the model to resubmit
     * all of them or none. Threaded down from `hydrateActions` rather than
     * reconstructed here, because only the caller knows the action's index in
     * the array the model wrote.
     */
    context?: string,
  ): Promise<WikiEvidenceInput> {
    if (Number(entry.libraryID ?? libraryID) !== libraryID) {
      throw new Error(
        `Evidence must belong to the Wiki page's library${context ? ` (${context})` : ""}`,
      );
    }
    const itemKey = String(entry.itemKey ?? "").trim();
    if (!itemKey) {
      throw new Error(
        `Evidence itemKey is required${context ? ` (${context})` : ""}`,
      );
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
    if (!item || item.deleted || !item.isRegularItem?.()) {
      throw new Error(
        `Evidence source ${libraryID}:${itemKey} is missing or is not a Zotero document`,
      );
    }
    const vectorStore = getVectorStore();
    await vectorStore.initialize();
    const evidenceVersion = await vectorStore.getDocumentRevision(itemKey, libraryID);
    const chunks = await vectorStore.getChunksForItem(itemKey, libraryID);
    assertChunkRevision(evidenceVersion, await vectorStore.getDocumentRevision(itemKey, libraryID));
    if (!chunks.length) {
      throw new Error(
        `Evidence source ${itemKey} has no indexed chunks; build the search index first`,
      );
    }
    const excerpt = String(entry.excerpt ?? "").trim();
    if (!excerpt) throw new Error("Evidence excerpt is required");
    if (excerpt.length < WIKI_EVIDENCE_MIN_EXCERPT_CHARS) {
      throw new Error(
        `Evidence excerpt is ${excerpt.length} characters: "${excerpt}"${context ? ` (${context})` : ""}. ` +
          `At least ${WIKI_EVIDENCE_MIN_EXCERPT_CHARS} are needed, because a quotation this short is a ` +
          "TERM rather than a passage: it proves the paper mentions those words, which is not what the " +
          "Claim asserts, and it matches so many chunks that the passage it came from can no longer be " +
          "identified. Quote the clause or sentence the Claim actually rests on - the definition with " +
          "its definiendum, the measurement with the conditions it was taken under - copied verbatim " +
          "from the chunk. If no sentence in the paper carries the Claim, the Claim is reaching past " +
          "the paper and belongs at a weaker strength or not at all.",
      );
    }
    // WHERE THE PASSAGE REALLY IS, and who gets told when the caller was wrong.
    //
    // The named chunk wins whenever it actually carries the excerpt. Otherwise
    // the document is searched - but the result of that search used to be
    // applied SILENTLY, which made `wikiEvidenceDiagnostics`' own "the excerpt
    // is real; the chunkIdSnapshot is wrong. Resubmit it with chunkIdSnapshot
    // N" message unreachable: by the time the diagnostic ran, the fallback had
    // already succeeded and nobody was ever told. A single match is now
    // accepted with a warning naming both numbers, and an AMBIGUOUS one is
    // refused, because picking the first of several chunks is a guess about
    // provenance dressed up as a fact.
    const named = Number.isFinite(Number(entry.chunkIdSnapshot))
      ? chunks.find(
          (candidate) => candidate.chunkId === Number(entry.chunkIdSnapshot),
        )
      : undefined;
    let chunk =
      named && findWikiSourceQuote(named.text, excerpt)
        ? named
        : undefined;
    if (!chunk) {
      const carrying = chunks.filter((candidate) =>
        findWikiSourceQuote(candidate.text, excerpt),
      );
      if (carrying.length > 1) {
        throw new Error(
          `Evidence excerpt appears in ${carrying.length} chunks of ${itemKey} (${carrying
            .map((candidate) => candidate.chunkId)
            .join(", ")})${context ? ` (${context})` : ""}, and ` +
            (named
              ? `chunk ${named.chunkId}, the one you named, is not among them. `
              : "no usable chunkIdSnapshot was supplied. ") +
            "Which passage this Claim rests on therefore cannot be determined, and choosing the first " +
            "match would be a guess recorded as a fact. Name the chunk you actually read it in, or " +
            "quote a longer stretch that occurs in only one of them.",
        );
      }
      chunk = carrying[0];
      if (chunk && named) {
        warnings.push(
          `Evidence for ${itemKey} was submitted as chunk ${named.chunkId}, but that chunk does not ` +
            `contain the excerpt; it is in chunk ${chunk.chunkId}, which is what was recorded` +
            `${context ? ` (${context})` : ""}. Cite the chunk you read the passage in - the number is ` +
            "the trail back to the source, and a later reader follows it.",
        );
      }
    }
    if (!chunk) {
      throw new Error(
        describeEvidenceMismatch({
          itemKey,
          excerpt: String(entry.excerpt ?? ""),
          chunkIdSnapshot:
            entry.chunkIdSnapshot === undefined ||
            entry.chunkIdSnapshot === null ||
            !Number.isFinite(Number(entry.chunkIdSnapshot))
              ? null
              : Number(entry.chunkIdSnapshot),
          chunks: chunks.map((candidate) => ({
            chunkId: candidate.chunkId,
            text: candidate.text,
          })),
          context,
        }),
      );
    }
    const status = await vectorStore.getIndexStatus(itemKey, libraryID);
    const bodyState = bodyIndexStateFromSourceKind(status?.sourceKind);
    await this.assertChunkWasRead(libraryID, itemKey, chunk.chunkId, bodyState, evidenceVersion);
    const resetGeneration = await vectorStore.getCommittedResetGeneration();
    return {
      libraryID,
      itemKey,
      chunkIdSnapshot: chunk.chunkId,
      chunkTextHash: await hashWikiText(chunk.text),
      sourceContentHash: status?.contentHash || "unknown",
      sourceChunkSignature: status?.chunkSignature || getStoredChunkingSignature(libraryID) || "unknown",
      sourceResetGeneration: resetGeneration || "none",
      excerpt: findWikiSourceQuote(chunk.text, excerpt)!.excerpt,
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
   * Refuse Evidence quoted from a passage that was never read.
   *
   * The excerpt check above proves the words are really in the paper. This
   * proves someone looked at them. They are different claims and both are
   * needed: retrieval hands back passages by the dozen, and a model can lift a
   * sentence out of a snippet it never engaged with, cite it as Evidence, and
   * produce a Wiki entry that is textually accurate and epistemically empty.
   * The reading ledger knows which chunks were declared read - by paging in a
   * full-text pass, or by being named in `readChunkIds` after a question - so
   * the rule is simply that Evidence comes from those.
   *
   * It is also what makes "note first, Wiki second" more than advice. Chunks
   * become read by being folded into the reading note, so a Claim can only
   * ever rest on something the note already accounts for.
   *
   * Body-less documents are exempt: their "chunks" are the title and abstract,
   * there is nothing to page through, and evidence from them is already capped
   * at `chunk_local` by `readDepthCeiling`.
   */
  private async assertChunkWasRead(
    libraryID: number,
    itemKey: string,
    chunkId: number,
    bodyState: string,
    sourceVersion?: string,
  ): Promise<void> {
    if (bodyState !== "body") return;
    const sessions = await this.store.readingSessions();
    if (sourceVersion !== undefined) {
      const latest = await sessions.latestForItem(libraryID, itemKey);
      if (latest && latest.sourceVersion !== sourceVersion) {
        throw new Error(`The indexed text of ${itemKey} changed. Read the current version before committing evidence; earlier reading progress cannot verify it.`);
      }
    }
    if (await sessions.hasReadChunkId(libraryID, itemKey, chunkId)) return;
    const coverage = await sessions.coverageForItem(libraryID, itemKey);
    throw new Error(
      `Evidence for ${itemKey} quotes chunk ${chunkId}, which is not recorded as read. The excerpt is ` +
        "genuinely in the paper — what is missing is a reading of it. Retrieval returning a passage is " +
        "not reading it, so passages have to be declared: after answering from them, call " +
        `wiki_update_reading_note with itemKey "${itemKey}", readChunkIds including ${chunkId}, and the ` +
        "readingRecord describing only what they say. The server appends it; then commit this Claim. " +
        (coverage.sessionId === null
          ? "Nothing has been read from this paper yet."
          : `So far ${coverage.deliveredChunks} of ${coverage.totalChunks} chunks are recorded as read.`) +
        " For a full-text read, page through wiki_build_from_paper instead — it books each page as it " +
        "hands it over, so anything it delivered can be quoted immediately.",
    );
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
    if (
      coverage.mode !== "qa" &&
      coverage.complete &&
      coverage.finalSynthesisAt !== null
    ) {
      return requested;
    }
    // A question-driven session is refused whole-paper depth on the MODE, not
    // on the count, and the two are different rules. Sixty questions can, in
    // principle, touch every chunk of a paper; the count would then say the
    // paper was covered, and it would be wrong. `paper_reviewed` names an act
    // - reading the paper through and then reconciling it as a whole - that
    // scattered passages never perform, however many of them there are. Only
    // a promotion to a full-text read can change that, and it keeps every
    // chunk already read.
    const read =
      coverage.sessionId === null
        ? "no reading session recorded"
        : coverage.mode === "qa"
          ? `${coverage.deliveredChunks} of ${coverage.totalChunks} chunks read by answering questions, which is not a full-text reading of the paper`
          : coverage.complete
            ? "every chunk delivered but no whole-paper synthesis of the reading note"
            : `only ${coverage.deliveredChunks} of ${coverage.totalChunks} chunks delivered`;
    warnings.push(
      `Evidence from ${itemKey} asked for read_depth "${requested}", but the server has ${read}. ` +
        `It was stored as "section_read". Whole-paper depth needs both: read every chunk through ` +
        `wiki_build_from_paper (follow pagination.nextCursor to the end), then rewrite the reading ` +
        `note as one account of the complete paper with wiki_update_reading_note and finalSynthesis true. ` +
          `${GATE_HINT}`,
    );
    return "section_read";
  }

  /**
   * Read the SKIP actions as write-offs, refusing the ones that assert instead
   * of arguing.
   *
   * Validated BEFORE the transaction, so a write-off that would not have
   * settled anything fails the whole commit rather than leaving Claims written
   * and a debt silently outstanding. A SKIP without an itemKey is the old
   * no-op form and is left alone: it has always meant "I considered this and
   * chose to do nothing", and nothing depended on it.
   */
  private async readWriteOffs(
    actions: WikiCommitAction[],
    libraryID: number,
  ): Promise<WikiWikiWriteOff[]> {
    const sessions = await this.store.readingSessions();
    const writeOffs: WikiWikiWriteOff[] = [];
    for (const action of actions) {
      if (action.action !== "SKIP") continue;
      const raw = action as unknown as {
        itemKey?: unknown;
        chunkIds?: unknown;
        reason?: unknown;
      };
      const itemKey = String(raw.itemKey ?? "").trim();
      const chunkIds = Array.isArray(raw.chunkIds)
        ? raw.chunkIds.map((id) => Number(id)).filter(Number.isFinite)
        : [];
      const reason = String(raw.reason ?? "").trim();
      if (!itemKey && !chunkIds.length) continue;
      if (!itemKey || !chunkIds.length) {
        throw new Error(
          "A SKIP that writes off reading needs BOTH itemKey and chunkIds: which paper, and which of " +
            "its chunks established nothing the Wiki did not already hold. Omit both to use SKIP as the " +
            "plain no-op it has always been.",
        );
      }
      // Shape before size. Both refuse the same answer, but "your reason is
      // too short" invites padding, whereas naming the reflex tells the caller
      // what is actually wanted - so the specific diagnosis has to win when
      // both apply, which for the commonest answer of all they always do.
      if (VACUOUS_WRITE_OFF_REASON.test(reason)) {
        throw new Error(
          `The SKIP reason for ${itemKey} asserts rather than argues: "${reason}". "Nothing new" is ` +
            "exactly what a reader who checked nothing would also say, so it cannot settle anything. " +
            "Name what those chunks say and what already covers it - for example \"restates the CET " +
            "criterion already stored as Claim #12 with the same threshold, and adds no condition or " +
            "parameter beyond it\".",
        );
      }
      if (reason.length < WIKI_WRITE_OFF_MIN_REASON_CHARS) {
        throw new Error(
          `The SKIP for ${itemKey} chunk(s) ${chunkIds.join(", ")} needs a reason of at least ` +
            `${WIKI_WRITE_OFF_MIN_REASON_CHARS} characters. Say what those passages actually establish ` +
            "and where the Wiki already holds it - which Page, Claim, Concept or relation makes them " +
            "redundant - so the judgement can be read back and checked later. One reason may cover the " +
            "whole group; you are not asked to explain each chunk separately.",
        );
      }
      const open = await sessions.openForItem(libraryID, itemKey);
      if (!open) {
        throw new Error(
          `SKIP names ${itemKey}, which has no open reading session in this library, so it owes the ` +
            "Wiki nothing and there is nothing to write off.",
        );
      }
      const owed = new Set(
        (await sessions.pendingWikiChunks(open.sessionId)).map(
          (chunk) => chunk.chunkId,
        ),
      );
      const notOwed = chunkIds.filter((id) => !owed.has(id));
      if (notOwed.length) {
        throw new Error(
          `SKIP writes off ${itemKey} chunk(s) ${notOwed.join(", ")}, which do not owe the Wiki ` +
            "anything: they were never delivered to this reading, or they have already been settled. " +
            "Note that a chunk is named here by its chunkId, the id the index gave it - not by its " +
            "position in the paper, which is what a citation in the note uses. " +
            (owed.size
              ? `Outstanding for this paper: ${[...owed].join(", ")}.`
              : "This paper owes nothing at all."),
        );
      }
      writeOffs.push({ itemKey, chunkIds, reason });
    }
    return writeOffs;
  }

  private async hydrateActions(
    actions: WikiCommitAction[],
    libraryID: number,
  ): Promise<{ actions: WikiCommitAction[]; warnings: string[] }> {
    const hydrated: WikiCommitAction[] = [];
    const warnings: string[] = [];
    for (const [actionIndex, action] of actions.entries()) {
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
      for (const [entryIndex, entry] of (action.evidence ?? []).entries()) {
        evidence.push(
          await this.hydrateEvidence(
            entry,
            libraryID,
            warnings,
            describeEvidenceLocation(action, actionIndex, entryIndex),
          ),
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

  /** Enforce the action policy recorded by the completed paper review. */
  private async assertRequiredReconciliationActions(
    input: WikiCommitInput,
  ): Promise<void> {
    const sessions = await this.store.readingSessions();
    const prepared = this.touchPrepareToken(input.prepareToken);
    let session = prepared?.reconciliationSessionId
      ? await sessions.get(prepared.reconciliationSessionId)
      : input.readingSessionId
        ? await sessions.get(input.readingSessionId)
        : null;

    if (!session) {
      const reviewed = (await sessions.listOpen(input.libraryID)).filter(
        (candidate) =>
          candidate.state === "prepared" && candidate.wikiReviewAt !== null,
      );
      if (reviewed.length > 1) {
        throw new Error(
          "Several reviewed papers are prepared in this library. Pass the prepareToken returned by the paper's wiki_prepare_update call so reconciliation actions are checked against the correct paper.",
        );
      }
      session = reviewed[0] ?? null;
    }
    if (!session?.wikiReview) return;

    const missing: string[] = [];
    for (const verdict of session.wikiReview.claimVerdicts ?? []) {
      if (verdict.verdict === "overstated") {
        const replacement = String(verdict.replacementClaimText ?? "").trim();
        const matched = input.actions.some(
          (action) =>
            action.action === "UPDATE_CLAIM" &&
            Number(action.claimId) === verdict.claimId &&
            String(action.claimText ?? "").trim() === replacement &&
            Boolean(action.evidence?.length),
        );
        if (!matched) {
          missing.push(
            `UPDATE_CLAIM for Claim ${verdict.claimId} using the reviewed replacementClaimText and supporting Evidence`,
          );
        }
      }
      if (verdict.verdict === "contradicted") {
        const matched = input.actions.some(
          (action) =>
            action.action === "MARK_CONFLICT" &&
            Number(action.claimId) === verdict.claimId &&
            Boolean(action.evidence?.length),
        );
        if (!matched) {
          missing.push(
            `MARK_CONFLICT for Claim ${verdict.claimId} with the contradicting Evidence`,
          );
        }
      }
    }
    if (missing.length) {
      throw new Error(
        `The completed review of ${session.itemKey} requires these reconciliation actions before the commit can proceed: ${missing.join("; ")}.`,
      );
    }
  }

  async commitStatus(libraryID: number, operationId: string): Promise<any> {
    const saved = await this.store.getCommitOperation(libraryID, operationId);
    if (!saved) return { operationId, libraryID, status: 'not_recorded', committed: false, inProgress: this.activeCommitOperations.has(`${libraryID}:${operationId}`) };
    const needsReview = Object.values(saved.steps).some((step: any) => step.state === 'superseded');
    return { operationId, libraryID, committed: true, status: saved.response ? 'completed' : needsReview ? 'postprocessing_needs_review' : 'postprocessing_pending', steps: saved.steps, result: saved.result, response: saved.response,
      nextStep: saved.response ? undefined : needsReview
        ? 'Review the changed paper using its current reading session. Superseded bookkeeping will not be replayed; settle current reading with a new operation after review. Resume this operation to retry any other pending stages. Its knowledge is already saved; do not resubmit it.'
        : 'Resume wiki_commit with the same operationId, resume true, and actions []. Do not submit the saved knowledge as a new operation.' };
  }

  async commit(
    input: WikiCommitInput,
    options: WikiNoteStatusWriteOptions = {},
  ): Promise<any> {
    const operationId = input.operationId ?? await hashWikiText(`${Date.now()}:${Math.random()}`);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(operationId)) throw new Error('operationId must contain 8-128 letters, digits, underscores or hyphens');
    const key = `${input.libraryID}:${operationId}`;
    if (this.activeCommitOperations.has(key)) throw new Error(`Operation ${operationId} is in progress. Query wiki_status with this operationId.`);
    this.activeCommitOperations.add(key);
    try {
      const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
      const inputHash = JSON.stringify(
        stable({
          libraryID: input.libraryID,
          actions: input.actions,
          readingSessionId: input.readingSessionId,
          checkpoint: input.checkpoint,
          crossPaperReview: input.crossPaperReview,
          deferMissingTargets: input.deferMissingTargets,
          evidenceAssessments: input.evidenceAssessments,
        }),
      );
      const saved = await this.store.getCommitOperation(input.libraryID, operationId);
      if (saved) {
        if (!input.resume && saved.inputHash !== inputHash) throw new Error('This operationId belongs to different actions. Use a new operationId for a different write.');
        if (
          input.resume &&
          (input.actions?.length ||
            input.crossPaperReview?.length ||
            input.deferMissingTargets?.length ||
            input.evidenceAssessments?.length)
        )
          throw new Error(
            "A resume uses saved actions and reviews; pass actions [] and omit new review decisions.",
          );
        if (saved.response) return saved.response;
        return await this.finishCommit(saved.payload.input, saved.payload.actions, saved.payload.warnings, saved.result, saved.payload.writeOffs, options, saved.payload.sessions, saved.payload.dependencies);
      }
      if (input.resume) throw new Error(`Operation ${operationId} was not recorded; no saved write can be resumed.`);
      return await this.commitNew({ ...input, operationId }, options, inputHash);
    } finally { this.activeCommitOperations.delete(key);
    }
  }

  private async commitNew(
    input: WikiCommitInput,
    options: WikiNoteStatusWriteOptions,
    inputHash: string,
  ): Promise<
    WikiCommitResult & {
      warnings: string[];
      /** Always true on return: the database transaction is durable. */
      committed: true;
      /** Claims whose vector is queued rather than built yet. */
      embeddingPending: number | undefined;
      embeddingNote?: string;
    }
  > {
    this.prunePrepareTokens();
    let consumedToken: string | undefined;
    let actions: WikiCommitAction[];
    let warnings: string[];
    if (input.actions.some((action) => action.action === "CREATE_PAGE")) {
      const prepared = this.touchPrepareToken(input.prepareToken);
      // Expiry is not re-checked here: touchPrepareToken has already dropped a
      // lapsed token and answered undefined, and it renewed a live one, so
      // testing `expiresAt` again could only ever contradict itself.
      if (
        !prepared ||
        prepared.libraryID !== input.libraryID ||
        prepared.canCommit === false
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
    let writeOffs: WikiWikiWriteOff[];
    const sessionSnapshot: WikiCommitReadingDependency[] = [];
    let dependencies: WikiCommitDependencies = {};
    try {
      if (!input.checkpoint)
        await this.assertRequiredReconciliationActions(input);
      // Both before the transaction: a write-off whose reason does not argue,
      // or whose chunks owe nothing, must fail the commit rather than let the
      // Claims land while the debt it was meant to settle quietly survives.
      writeOffs = await this.readWriteOffs(input.actions, input.libraryID);
      // Same reason, one layer along: a dismissal whose reason does not argue
      // must not clear a candidate, and a mandatory candidate this commit
      // ignores must not be able to slip past by being unmentioned.
      if (input.deferMissingTargets !== undefined)
        input = {
          ...input,
          crossPaperReview: await (
            await this.store.crossPaperReviews()
          ).missingTargetDeferrals(
            input.libraryID,
            input.deferMissingTargets,
            input.crossPaperReview ?? [],
          ),
          deferMissingTargets: undefined,
        };
      await this.ensureCommitReviewTasks(input);
      if (!input.checkpoint) await this.assertLinkSignalsAnswered(input);
      await this.assertQuestionTerminologyRecorded(input);
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
      const sessions = await this.store.readingSessions();
      const openSessions = await sessions.listOpen(input.libraryID);
      const resolvedItemKeys = new Set<string>();
      const linkStore = await this.store.links();
      const reviewStore = await this.store.crossPaperReviews();
      for (const review of input.crossPaperReview ?? []) {
        const task = await reviewStore.task(review.taskId, input.libraryID);
        if (task) resolvedItemKeys.add(task.currentItemKey);
      }
      for (const action of actions) {
        const ids = action.action === "RESOLVE_LINK_SIGNAL" ? [action.signalId]
          : action.action === "DISMISS_LINK_SIGNALS" ? normalizeLinkDismissals(action).map((entry) => entry.signalId)
          : (action as any).resolvesSignalIds ?? [];
        for (const id of ids) {
          const signal = await linkStore.getSignal(id);
          if (signal?.libraryID === input.libraryID) {
            resolvedItemKeys.add(signal.aItemKey);
            resolvedItemKeys.add(signal.bItemKey);
          }
        }
      }
      const citedSession = openSessions.find((session) => session.mode === 'fulltext' &&
        (resolvedItemKeys.has(session.itemKey) || actions.some((action) => 'evidence' in action && action.evidence?.some((evidence) => evidence.itemKey === session.itemKey)) ||
          writeOffs.some((writeOff) => writeOff.itemKey === session.itemKey)));
      input = { ...input, readingSessionId: input.readingSessionId ?? citedSession?.sessionId };
      const relatedKeys = new Set([...resolvedItemKeys, ...writeOffs.map((entry) => entry.itemKey)]);
      for (const action of actions) {
        for (const evidence of ('evidence' in action ? action.evidence : undefined) ?? []) relatedKeys.add(evidence.itemKey);
      }
      for (const itemKey of relatedKeys) {
        const session = await sessions.latestForItem(input.libraryID, itemKey);
        if (session) sessionSnapshot.push({ sessionId: session.sessionId, itemKey, sourceVersion: session.sourceVersion, noteKey: session.noteKey });
      }
      if (input.readingSessionId && !sessionSnapshot.some((entry) => entry.sessionId === input.readingSessionId)) {
        const session = await sessions.get(input.readingSessionId);
        if (!session || session.libraryID !== input.libraryID) throw new Error('The reading session does not belong to this library.');
        sessionSnapshot.push({ sessionId: session.sessionId, itemKey: session.itemKey, sourceVersion: session.sourceVersion, noteKey: session.noteKey });
      }
      dependencies = this.commitReadingDependencies(input, actions, writeOffs, sessionSnapshot, resolvedItemKeys);
      result = await this.store.commit(
        { ...input, actions },
        {
          operationId: input.operationId!,
          inputHash,
          payload: {
            input,
            actions,
            warnings,
            writeOffs,
            sessions: sessionSnapshot,
            dependencies,
          },
          beforeCommit: async (written) => {
            // Verify final evidence, including earlier and later actions, before
            // either the knowledge or its link resolutions become durable.
            if (!input.checkpoint) await this.assertLinkSignalsAnswered(input);
          written.linkSettlement = await this.settleLinkSignals(input, actions, written);
          },
        },
      );
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

    return this.finishCommit(input, actions, warnings, result, writeOffs, options, sessionSnapshot, dependencies);
  }

  private commitReadingDependencies(input: WikiCommitInput, actions: WikiCommitAction[], writeOffs: WikiWikiWriteOff[], snapshot: WikiCommitReadingDependency[], resolvedItemKeys: ReadonlySet<string> = new Set()): WikiCommitDependencies {
    const terminologyKeys = new Set(writeOffs.map((entry) => entry.itemKey));
    const settlementKeys = new Set([...terminologyKeys, ...resolvedItemKeys]);
    for (const action of actions) {
      for (const evidence of ('evidence' in action ? action.evidence : undefined) ?? []) {
        terminologyKeys.add(evidence.itemKey);
        if (Number.isFinite(Number(evidence.chunkIdSnapshot))) settlementKeys.add(evidence.itemKey);
      }
    }
    // Older receipts saved all open sessions; only actual reading consumers inherit them.
    return {
      terminology: snapshot.filter((entry) => terminologyKeys.has(entry.itemKey)),
      'question reading settlement': snapshot.filter((entry) => settlementKeys.has(entry.itemKey)),
      'reading session': snapshot.filter((entry) => entry.sessionId === input.readingSessionId),
    };
  }

  private async finishCommit(
    input: WikiCommitInput,
    actions: WikiCommitAction[],
    warnings: string[],
    result: WikiCommitResult,
    writeOffs: WikiWikiWriteOff[],
    options: WikiNoteStatusWriteOptions,
    sessionSnapshot: WikiCommitReadingDependency[] = [],
    dependencies?: WikiCommitDependencies,
  ): Promise<any> {
    warnings = [...warnings];
    dependencies ??= this.commitReadingDependencies(input, actions, writeOffs, sessionSnapshot);
    let saved: any;
    try { saved = await this.store.getCommitOperation(input.libraryID, input.operationId!); }
    catch (error) { warnings.push(`Knowledge is already saved; recovery status is temporarily unavailable: ${String(error)}`); }
    const steps: Record<string, any> = saved?.steps ?? {};
    const stageNames = ['link settlement', 'link recheck', 'terminology', 'question reading settlement', 'reading session', 'embedding queue status'];

    // Which chunks of which papers this commit actually quoted. The keys alone
    // used to be enough because the debt was per paper; now that it is per
    // chunk, the chunk ids ARE the settlement.
    const citedKeys = new Set<string>();
    const citedChunkIdsByItem = new Map<string, Set<number>>();
    for (const action of actions) {
      for (const entry of (action as any).evidence ?? []) {
        if (!entry?.itemKey) continue;
        const itemKey = String(entry.itemKey);
        citedKeys.add(itemKey);
        const chunkId = Number(entry.chunkIdSnapshot);
        if (!Number.isFinite(chunkId)) continue;
        const set = citedChunkIdsByItem.get(itemKey) ?? new Set<number>();
        set.add(chunkId);
        citedChunkIdsByItem.set(itemKey, set);
      }
    }
    // A write-off is a statement ABOUT a paper just as much as Evidence is, so
    // it counts as this commit concerning that paper. Without this, a commit
    // whose only business was settling the last outstanding chunk - which is
    // exactly the commit that finishes a paper - looked to the session logic
    // like a commit about some other paper entirely, and left the one it had
    // just finished open.
    for (const writeOff of writeOffs) citedKeys.add(writeOff.itemKey);

    // New resolutions are already durable with the knowledge. Legacy receipts
    // may still owe settlement; incomplete recovery must not close a session.
    const afterCommit = async <T>(stage: string, operation: () => Promise<T>): Promise<T | undefined> => {
      if (steps[stage]?.state === 'completed') return steps[stage].result;
      if (steps[stage]?.state === 'superseded') {
        warnings.push(`Knowledge is already saved. ${stage} needs review: ${steps[stage].error}`);
        return undefined;
      }
      try {
        if ((stage === 'question reading settlement' || stage === 'reading session') &&
          (steps['link settlement']?.state !== 'completed' || steps['link recheck']?.state !== 'completed')) {
          throw new Error('Cross-paper settlement recovery must finish before closing reading.');
        }
        for (const before of dependencies[stage] ?? []) {
          const sessions = await this.store.readingSessions();
          const current = await sessions.get(before.sessionId);
          const latest = await sessions.latestForItem(input.libraryID, before.itemKey);
          const sourceChanged = before.sourceVersion
            ? await getVectorStore().getDocumentRevision(before.itemKey, input.libraryID) !== before.sourceVersion
            : false;
          if (sourceChanged || !current || current.libraryID !== input.libraryID || current.itemKey !== before.itemKey || current.sourceVersion !== before.sourceVersion || latest?.sessionId !== before.sessionId ||
            (stage === 'reading session' && before.noteKey !== undefined && current.noteKey !== before.noteKey)) {
            const error = `Reading state of ${before.itemKey} changed. Review its current version; this saved operation will not settle newer reading or overwrite another note.`;
            steps[stage] = { state: 'superseded', error, itemKey: before.itemKey, sessionId: before.sessionId, nextStep: 'Review current reading, then use a new operation to settle it. The original knowledge write is already committed.' };
            await this.store.updateCommitOperation(input.libraryID, input.operationId!, steps);
            warnings.push(`Knowledge is already saved. ${stage} needs review: ${error}`);
            return undefined;
          }
        }
        steps[stage] = { state: 'pending' };
        await this.store.updateCommitOperation(input.libraryID, input.operationId!, steps);
        const run = async () => {
          const value = await operation();
          if ((value as any)?.warnings?.some((warning: string) => /could not|not written|more was staged/.test(warning))) throw new Error((value as any).warnings.join(' '));
          if ((value as any)?.noteStatusWrite?.updated === false) {
            const error = `The Zotero reading note status still needs updating (${(value as any).noteStatusWrite.reason})`;
            steps[stage] = { state: 'pending', error, result: value };
            await this.store.updateCommitOperation(input.libraryID, input.operationId!, steps);
            warnings.push(`Knowledge is already saved. ${stage} remains pending: ${error}. Do not resubmit the saved actions.`);
            return value;
          }
          steps[stage] = { state: 'completed', result: value ?? null };
          await this.store.updateCommitOperation(input.libraryID, input.operationId!, steps);
          return value;
        };
        return stage === 'link settlement' || stage === 'link recheck' ? await this.store.commitBookkeeping(run) : await run();
      } catch (error) {
        steps[stage] = { state: 'pending', error: String(error) };
        try { await this.store.updateCommitOperation(input.libraryID, input.operationId!, steps); } catch { /* The original transaction still contains the pending operation. */ }
        warnings.push(`Knowledge is already saved. ${stage} remains pending: ${error instanceof Error ? error.message : String(error)}. Do not resubmit the saved actions.`);
        ztoolkit.log(`[wiki] post-commit ${stage} failed`, error);
        return undefined;
      }
    };
    const linkSettlement = await afterCommit("link settlement", async () => result.linkSettlement ?? this.settleLinkSignals(input, actions, result));

    /*
     * A Claim citing both papers of a dismissed pair contradicts that
     * dismissal, and the Claim is the one with quoted passages behind it.
     *
     * Run AFTER the settlement above, deliberately: a commit that both
     * dismisses a pair and writes a Claim citing both its papers has just
     * contradicted itself, and the Claim is what stands. Failures are logged
     * rather than thrown for the same reason the settlement's are - the Wiki
     * write is permanent, and a bookkeeping sweep may not turn it into an
     * error.
     */
    let reopenedLinks: Array<{
      linkId: number;
      aItemKey: string;
      bItemKey: string;
      claimId: number;
    }> = [];
    reopenedLinks = await afterCommit('link recheck', () => this.links.reopenContradictedDismissals({
        libraryID: input.libraryID,
        // Both sets: a Claim written here, and a Claim that merely GAINED
        // Evidence here. The second is the case the sweep exists for - a
        // second paper's excerpt arriving on a Claim that already existed is
        // precisely when a pair somebody dismissed turns out to share one.
        claimIds: [
          ...result.affectedClaimIds,
          ...result.evidenceChangedClaimIds,
        ],
      })) ?? [];

    // Terminology, written where the question-driven path can actually reach it.
    const conceptWriteUp = await afterCommit("terminology", () => this.writeQuestionReadingConcepts(
      input.libraryID,
      citedKeys,
      actions,
      dependencies.terminology,
    ));

    const questionReading = await afterCommit(
      "question reading settlement",
      () =>
        input.checkpoint
          ? Promise.resolve(undefined)
          : this.settleQuestionReading(
              input.libraryID,
              citedChunkIdsByItem,
              writeOffs,
              dependencies["question reading settlement"],
            ),
    );
    const readingSession = await afterCommit("reading session", () => this.settleReadingSession(
      input,
      actions,
      citedKeys,
      options.authorizeNoteStatusWrite,
    ));

    const embeddingPending = await afterCommit("embedding queue status", async () => {
      const queue = await this.store.embeddingQueue();
      return queue.pendingCount();
    });
    if (steps["embedding queue status"]) steps["embedding queue status"].meaning = "queue_status_snapshot_read";
    // Kick the drain but do not wait for it: its outcome cannot change the
    // fact that the commit succeeded.
    void this.pumpEmbeddingQueue().catch((error) => ztoolkit.log("[wiki] embedding drain failed", error));

    const response = {
      ...result,
      warnings,
      operationId: input.operationId,
      postprocessing: { state: stageNames.some((name) => steps[name]?.state === 'superseded') ? 'needs_review' : stageNames.every((name) => steps[name]?.state === 'completed') ? 'completed' : 'pending', steps },
      committed: true,
      embeddingPending,
      embedding: { state: embeddingPending === undefined ? "unknown" : embeddingPending > 0 ? "pending" : "ready", pendingClaims: embeddingPending, statusIsSnapshot: true },
      embeddingNote:
        (embeddingPending ?? 0) > 0
          ? `The Wiki write is committed and permanent. ${embeddingPending} claim embedding(s) are queued and will be built in the background; Wiki keyword retrieval already sees these claims, and semantic retrieval will once the queue drains. Nothing needs to be re-submitted.`
          : undefined,
      ...(readingSession ? { readingSession } : {}),
      ...(questionReading ? { wikiWriteUp: questionReading, questionReading } : {}),
      ...(linkSettlement ? { linkSettlement } : {}),
      ...(reopenedLinks.length
        ? {
            reopenedLinks: {
              pairs: reopenedLinks,
              note:
                `${reopenedLinks.length} cross-paper pair(s) that had been dismissed are back in the ` +
                "queue: a Claim written by this commit cites BOTH papers as Evidence, which is the " +
                "shared Claim the dismissal said could not exist. The earlier reasoning is kept on " +
                "each signal as its prior rejection and the original settlement row is untouched - " +
                "the pair simply needs deciding again against the Claim that now exists.",
            },
          }
        : {}),
      ...(conceptWriteUp ? { conceptWriteUp } : {}),
    };
    try {
      await this.store.updateCommitOperation(input.libraryID, input.operationId!, steps, response.postprocessing.state === 'completed' ? response : undefined);
    } catch (error) { warnings.push(`Knowledge is saved; operation status persistence needs retry: ${String(error)}`); }
    return response;
  }

  /**
   * Write the terminology a question-driven reading staged.
   *
   * Staging exists so a full-text read can note candidate terms page by page
   * and write them ONCE, at the whole-paper pass, for one confirmation instead
   * of one per batch. That reasoning does not transfer to question-driven
   * reading, and the difference had teeth: a `qa` session never reaches a
   * whole-paper pass, its `final: true` is refused by design because coverage
   * is incomplete, and the session is never closed. So every concept a
   * question read recognised was staged into a session that would hold it
   * forever. On a fresh library the concept library could not bootstrap AT
   * ALL - measured: four cross-paper Claims written, zero concepts, and the
   * terms were sitting in the Claim text.
   *
   * The commit is the question-driven equivalent of the whole-paper pass: it
   * is the moment this turn's reading becomes knowledge, and the moment the
   * user is already approving a write. So the concepts land here, inside that
   * approval, rather than costing a second prompt of their own.
   *
   * Best-effort by construction. The Wiki write is already durable when this
   * runs; terminology that cannot be written is reported and stays staged for
   * the next commit rather than turning a successful commit into an error.
   */
  private async writeQuestionReadingConcepts(
    libraryID: number,
    citedKeys: ReadonlySet<string>,
    actions: WikiCommitAction[],
    dependencies?: WikiCommitReadingDependency[],
  ): Promise<
    | {
        papers: Array<{ itemKey: string; concepts: number; sources: number }>;
        autoAttached: Array<{
          itemKey: string;
          concept: string;
          term: string;
        }>;
        warnings: string[];
      }
    | undefined
  > {
    if (!citedKeys.size) return undefined;
    const sessions = await this.store.readingSessions();
    const papers: Array<{
      itemKey: string;
      concepts: number;
      sources: number;
    }> = [];
    const warnings: string[] = [];

    for (const itemKey of citedKeys) {
      try {
        const dependency = dependencies?.find((entry) => entry.itemKey === itemKey);
        const open = dependencies
          ? dependency ? await sessions.get(dependency.sessionId) : null
          : await sessions.openForItem(libraryID, itemKey);
        // Only the question-driven path. A full-text read keeps its own
        // terminology pass, which is a review of the whole paper and a
        // stronger thing than this.
        if (!open || open.mode !== "qa") continue;
        const staged = (await sessions.readStagedConcepts(
          open.sessionId,
        )) as Array<WikiConceptEntityInput & { itemKey?: string }>;
        if (!staged.length) continue;

        const preparation = await this.prepareConceptEntities(
          libraryID,
          staged,
          itemKey,
        );
        if (preparation.sourceValidationFailures.length) {
          warnings.push(
            `Staged terminology for ${itemKey} was not written: ${preparation.sourceValidationFailures.join(" ")}`,
          );
          continue;
        }
        const prepared = preparation.prepared.filter((entity) => {
          const sources = [
            ...(entity.sources ?? []),
            ...(entity.primaryTerm?.sources ?? []),
            ...(entity.terms ?? []).flatMap((term) => term.sources ?? []),
          ];
          return sources.length > 0;
        });
        if (!prepared.length) continue;

        const library = await this.store.concepts();
        const result = await library.record({ libraryID, entities: prepared });
        // Cleared only after the write landed, and only if nothing was staged
        // in between - otherwise the next commit picks up the fuller list.
        const cleared = await sessions.clearStagedConcepts(
          open.sessionId,
          staged,
        );
        if (!cleared) {
          warnings.push(
            `Terminology for ${itemKey} was written, but more was staged while it was being written; the rest follows on the next commit.`,
          );
        }
        papers.push({
          itemKey,
          concepts:
            (result.createdConcepts ?? 0) + (result.updatedConcepts ?? 0),
          sources: result.addedSources ?? 0,
        });
        warnings.push(...(result.warnings ?? []));
      } catch (error) {
        ztoolkit.log("[wiki] could not write question-driven concepts", error);
        warnings.push(
          `Terminology for ${itemKey} could not be written: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const autoAttached = await this.attachConceptsFoundInEvidence(
      libraryID,
      actions,
      warnings,
    );
    if (!papers.length && !autoAttached.length && !warnings.length) {
      return undefined;
    }
    return { papers, autoAttached, warnings };
  }

  /**
   * Record a paper as a source of every concept its own quoted Evidence names.
   *
   * Nothing here is inferred. The excerpt has already been verified against
   * the live index by `prepareEvidence`, so it is text this paper really
   * contains; the concept already exists with a name somebody confirmed. "This
   * paper's quoted passage contains 动态再结晶, and 动态再结晶 is a concept this
   * library defines" is a fact about two stored strings, not a judgement about
   * meaning - which is exactly why the server may assert it and why it needs
   * no confirmation.
   *
   * It exists because the alternative did not work. The tool catalogue has
   * asked models to record terminology while answering questions since 2.5.0,
   * `wiki_prepare_update` marks every duplicate candidate with
   * `sourcedFromThisPaper`, and 2.7.2 made a staged concept land at commit.
   * Measured after all three: a run that produced four cross-paper Claims and
   * eleven verified excerpts called `wiki_record_concepts` zero times, so
   * there was nothing staged to write. The design document's own conclusion
   * applies to terminology as much as to connections - a step that depends on
   * the reader remembering is a step that does not happen, and only something
   * the server does itself is reliable.
   *
   * Strictly an ATTACH. It never founds, renames or merges a concept: naming
   * is a judgement and stays with the model and its confirmation. What this
   * removes is the clerical half - noticing that a paper you just quoted uses
   * a term the library already holds.
   */
  private async attachConceptsFoundInEvidence(
    libraryID: number,
    actions: WikiCommitAction[],
    warnings: string[],
  ): Promise<Array<{ itemKey: string; concept: string; term: string }>> {
    const attached: Array<{ itemKey: string; concept: string; term: string }> =
      [];
    try {
      const library = await this.store.concepts();
      const concepts = await library.list(libraryID);
      if (!concepts.length) return attached;

      // Longest term first, so 「不连续动态再结晶」 wins over 「动态再结晶」 when a
      // passage contains both and the longer one is the more specific claim.
      const terms: Array<{
        conceptId: number;
        display: string;
        term: string;
        normalized: string;
        latin: boolean;
      }> = [];
      for (const concept of concepts) {
        for (const record of [concept.primaryTerm, ...concept.aliasTerms]) {
          for (const name of [record?.zh, record?.en, record?.abbr]) {
            const value = String(name ?? "").trim();
            // Two characters is the floor: a one-character "term" matches
            // almost any Chinese passage and any English word containing it.
            if (value.length < 2) continue;
            const normalized = normalizeWikiName(value);
            if (!normalized) continue;
            terms.push({
              conceptId: concept.conceptId,
              display: concept.displayName ?? value,
              term: value,
              normalized,
              latin: !/\p{Script=Han}/u.test(value),
            });
          }
        }
      }
      terms.sort((left, right) => right.normalized.length - left.normalized.length);
      if (!terms.length) return attached;

      const sessions = await this.store.readingSessions();
      const seen = new Set<string>();
      for (const action of actions) {
        for (const entry of (action as any).evidence ?? []) {
          const itemKey = String(entry?.itemKey ?? "");
          const excerpt = String(entry?.excerpt ?? "");
          const chunkId = Number(entry?.chunkIdSnapshot);
          if (!itemKey || !excerpt || !Number.isFinite(chunkId)) continue;
          const haystack = normalizeWikiName(excerpt);

          for (const term of terms) {
            const key = `${term.conceptId}:${itemKey}`;
            if (seen.has(key)) continue;
            // A Latin term needs a boundary, or "at" matches "saturation" and
            // "DRX" matches "DRXED". Han has no word boundaries, so
            // containment is the only test available - and the two-character
            // floor above is what keeps it from matching everything.
            const found = term.latin
              ? new RegExp(
                  `(^|[^\\p{L}\\p{N}])${term.normalized.replace(
                    /[.*+?^${}()|[\]\\]/gu,
                    "\\$&",
                  )}([^\\p{L}\\p{N}]|$)`,
                  "u",
                ).test(haystack)
              : haystack.includes(term.normalized);
            if (!found) continue;
            // Only for a passage this paper was actually read on. The excerpt
            // is verified text either way, but a source row asserts that
            // somebody READ this paper using this term.
            if (!(await sessions.hasReadChunkId(libraryID, itemKey, chunkId))) {
              continue;
            }
            seen.add(key);
            const outcome = await library.attachExistingSources({
              libraryID,
              conceptId: term.conceptId,
              sources: [
                { libraryID, itemKey, chunkIdSnapshot: chunkId, excerpt },
              ],
            });
            if (outcome.added > 0) {
              attached.push({
                itemKey,
                concept: outcome.displayName || term.display,
                term: term.term,
              });
            }
          }
        }
      }
    } catch (error) {
      ztoolkit.log("[wiki] could not auto-attach concept sources", error);
      warnings.push(
        `Concept sources could not be derived from this commit's Evidence: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return attached;
  }

  /**
   * Refuse a commit that ignores a candidate both of whose passages were read.
   *
   * "Both passages were read" is the whole of the rule, and it is checked per
   * signal against the reading ledger by {@link WikiLinkService}. A candidate
   * pointing at a passage nobody has opened is a suggestion and stays one: it
   * goes in the queue, it may draw a ghost node, and it never blocks anything.
   * Without that distinction the feature would demand that a reader reconcile
   * text they have not seen, which they can only do by guessing.
   *
   * Enabled by default after screening. Every candidate needs a decision;
   * retaining independent findings or no substantive relation is valid.
   */
  private async assertLinkSignalsAnswered(
    input: WikiCommitInput,
  ): Promise<void> {
    const settled = new Set<number>();
    const reviews = await this.store.crossPaperReviews();
    for (const review of input.crossPaperReview ?? []) {
      const task = await reviews.task(review.taskId, input.libraryID);
      if (!task) throw new Error(`Unknown cross-paper task ${review.taskId}`);
      for (const id of task.signalIds) settled.add(id);
    }
    const add = (id: unknown) => {
      const value = Number(id);
      if (!Number.isSafeInteger(value) || value <= 0 || settled.has(value)) throw new Error(`Invalid or duplicate link signal decision: ${id}`);
      settled.add(value);
    };
    for (const action of input.actions) {
      for (const raw of (action as any).resolvesSignalIds ?? []) {
        if (!["ADD_CLAIM", "ATTACH_EVIDENCE", "UPDATE_CLAIM", "CREATE_PAGE", "LINK_RELATION", "MARK_CONFLICT"].includes(action.action)) {
          throw new Error(`${action.action} cannot carry resolvesSignalIds. Use RESOLVE_LINK_SIGNAL to record each decision.`);
        }
        add(raw);
      }
      if (action.action === "RESOLVE_LINK_SIGNAL") add(action.signalId);
      if (action.action !== "DISMISS_LINK_SIGNALS") continue;
      // Shape, reflex and length are all checked per signal by
      // `normalizeLinkDismissals`, which is also what the settlement below
      // reads - so what is validated here and what is written there cannot
      // drift apart.
      for (const dismissal of normalizeLinkDismissals(action as any)) {
        add(dismissal.signalId);
      }
    }

    const itemKeys = new Set<string>();
    const sessions = await this.store.readingSessions();
    const target = input.readingSessionId ? await sessions.get(input.readingSessionId) : await sessions.getOpen(input.libraryID);
    if (target && target.libraryID === input.libraryID) itemKeys.add(target.itemKey);
    const linkStore = await this.store.links();
    for (const signalId of settled) {
      const signal = await linkStore.getSignal(signalId);
      if (!signal || signal.libraryID !== input.libraryID) throw new Error(`Signal ${signalId} does not belong to this library`);
      // A decision about A-B must not create a new obligation to review B-C.
    }
    for (const action of input.actions) {
      for (const entry of (action as any).evidence ?? []) {
        if (entry?.itemKey) itemKeys.add(String(entry.itemKey));
      }
      const named = (action as any).itemKey;
      if (named) itemKeys.add(String(named));
    }
    if (!itemKeys.size) return;
    const outstanding = await this.links.unsettledMandatory({
      libraryID: input.libraryID,
      itemKeys,
      settledSignalIds: settled,
    });
    if (!outstanding.length) return;
    const described = outstanding
      .slice(0, 5)
      .map(
        (signal) =>
          `signal ${signal.signalId} (${signal.aItemKey} - ${signal.bItemKey})`,
      )
      .join(", ");
    throw new Error(
      `${outstanding.length} cross-paper candidate signal(s) point at passages that have BOTH been ` +
        `read, and this commit neither used nor dismissed them: ${described}` +
        `${outstanding.length > 5 ? ", ..." : ""}. Call wiki_prepare_update with preview true to see every mandatory candidate, then page section linkSignals with wiki_get_prepared_context. ` +
        "Use RESOLVE_LINK_SIGNAL for each: shared_claim, same_page (two independent Claims), conflict, concept_relation, or reasoned no_action. Nothing was written.",
    );
  }

  /**
   * A question-driven write-up records its terminology, or says why not.
   *
   * The full-text path has had this gate since 2.4.4 and it works: every
   * full-text session in a real library shows `concepts_recorded_at` set,
   * because the paper cannot be closed without it. The question-driven path
   * had no equivalent, and across four measured runs on the same library the
   * model called `wiki_record_concepts` there exactly zero times - while
   * writing Claims whose own text was full of the terms. Three separate
   * attempts to fix that by asking more clearly changed nothing, which is the
   * conclusion the design document had already reached about connections:
   * a step that depends on the reader remembering is a step that does not
   * happen, and only a debt the server can check is reliable.
   *
   * Satisfied four ways, and only one of them is work:
   *   - terminology was recorded for that paper (staged and drained, or
   *     attached by conceptId);
   *   - a concept was attached automatically from this commit's own Evidence,
   *     which means the paper IS now recorded against the library's terms;
   *   - the reading declared it introduced no new term, with a reason;
   *   - the paper already has concept sources from an earlier reading.
   *
   * Off via `wiki.requireQuestionTerminology` for anyone who wants the old
   * behaviour back.
   */
  private async assertQuestionTerminologyRecorded(
    input: WikiCommitInput,
  ): Promise<void> {
    if (!getWikiRequireQuestionTerminology()) return;
    const sessions = await this.store.readingSessions();
    const library = await this.store.concepts();

    const itemKeys = new Set<string>();
    for (const action of input.actions) {
      for (const entry of (action as any).evidence ?? []) {
        if (entry?.itemKey) itemKeys.add(String(entry.itemKey));
      }
    }
    const owing: string[] = [];
    for (const itemKey of itemKeys) {
      const open = await sessions.openForItem(input.libraryID, itemKey);
      if (!open || open.mode !== "qa") continue;
      if (open.conceptsDeclaredAt !== null) continue;
      if (open.conceptsRecordedAt !== null) continue;
      // Already tied to the library's terminology, by this reading or an
      // earlier one. Nothing more is owed.
      const sourced = await library.conceptIdsForItem(input.libraryID, itemKey);
      if (sourced.length) continue;
      // Something staged this turn will be written by this same commit.
      const staged = await sessions.readStagedConcepts(open.sessionId);
      if (staged.length) continue;
      owing.push(itemKey);
    }
    if (!owing.length) return;
    throw new Error(
      `This reading of ${owing.join(", ")} has recorded no terminology. Before writing it up, call ` +
        "wiki_record_concepts with that paper's itemKey and the terms these passages actually used - " +
        "preferring concepts the library already holds, which is what turns a concept into an edge " +
        "between papers. A term the library already has is submitted with its conceptId and one " +
        "source (this paper's itemKey, the chunkIdSnapshot you read, an excerpt from that chunk). " +
        "If this reading genuinely introduced no term the library does not hold, say so: call " +
        "wiki_record_concepts with an empty concepts list and a noConceptsReason naming the terms " +
        "and where they are already covered. Nothing was written.",
    );
  }

  /**
   * Record which signals this commit's writes settled.
   *
   * Explicit decisions and legacy action annotations are both verified
   * against transaction-local evidence before any knowledge becomes durable.
   */
  private async settleLinkSignals(
    input: WikiCommitInput,
    actions: WikiCommitAction[],
    result: WikiCommitResult,
  ): Promise<
    | WikiLinkSettlementResult
    | undefined
  > {
    const settlements: Array<{
      signalIds: number[];
      resolutionType: WikiLinkResolutionType;
      claimId?: number | null;
      claimIds?: number[];
      pageId?: number | null;
      relationId?: number | null;
      note: string;
      reasonBySignal?: ReadonlyMap<number, string>;
    }> = [];
    /*
     * Which row did this action actually create or touch?
     *
     * Three shapes reach here and only one of them carries a plain number.
     * ATTACH_EVIDENCE and MARK_CONFLICT name an existing `claimId`, but it may
     * be a REF string from earlier in the same commit rather than an id.
     * ADD_CLAIM and CREATE_PAGE carry no id at all - the store assigns one and
     * returns it through `refs`, keyed by the action's own `ref`.
     *
     * Reading `action.claimId` alone, which is what shipped, produced NaN for
     * every ADD_CLAIM and wrote a resolution saying "settled by a shared Claim"
     * that could not say which Claim. The audit trail is half the reason these
     * tables exist, so a settlement that cannot be followed back is not much
     * better than none.
     */
    const settledId = (
      raw: unknown,
      ref: unknown,
      fromAction: number | null | undefined,
    ): number | null => {
      const direct = Number(raw);
      if (Number.isInteger(direct) && direct > 0) return direct;
      for (const key of [raw, ref]) {
        if (typeof key !== "string" || !key) continue;
        const resolved = result.refs[key];
        if (Number.isInteger(resolved) && resolved > 0) return resolved;
      }
      // What the store actually wrote for this action. The two lookups above
      // both depend on the caller having named something; this one does not,
      // and it is why a commit whose ADD_CLAIM carried no `ref` still records
      // which Claim settled the signal.
      return Number.isInteger(fromAction) && (fromAction as number) > 0
        ? (fromAction as number)
        : null;
    };

    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      if (action.action === "RESOLVE_LINK_SIGNAL") {
        if (String(action.reason ?? "").trim().length < 40) throw new Error(`Signal ${action.signalId} requires a reason of at least 40 characters comparing both passages`);
        const resolve = (value: number | string | undefined) => {
          if (value === undefined) return undefined;
          const id = settledId(value, undefined, undefined);
          if (!id) throw new Error(`Unresolved link decision reference: ${value}`);
          return id;
        };
        settlements.push({ signalIds: [action.signalId], resolutionType: action.resolutionType,
          claimId: resolve(action.claimId), claimIds: action.claimIds?.map((id) => resolve(id)!),
          pageId: resolve(action.pageId), relationId: resolve(action.relationId), note: action.reason });
        continue;
      }
      if (action.action === "DISMISS_LINK_SIGNALS") {
        const dismissals = normalizeLinkDismissals(action as any);
        settlements.push({
          signalIds: dismissals.map((entry) => entry.signalId),
          resolutionType: "no_action",
          // The settlement row carries every reason it settled, labelled by
          // signal. One sentence used to stand for the whole batch here AND on
          // each signal, which is how a signal about misorientation profiles
          // came to be archived as a competing-interest declaration.
          note: dismissals
            .map((entry) => `signal ${entry.signalId}: ${entry.reason}`)
            .join("\n"),
          reasonBySignal: new Map(
            dismissals.map((entry) => [entry.signalId, entry.reason]),
          ),
        });
        continue;
      }
      const signalIds = ((action as any).resolvesSignalIds ?? []).map(
        (id: unknown) => Number(id),
      );
      if (!signalIds.length) continue;
      const claimId = settledId(
        (action as any).claimId,
        (action as any).ref,
        result.actionClaimIds[index],
      );
      const pageId = settledId(
        (action as any).pageId,
        (action as any).ref,
        result.actionPageIds[index],
      );
      switch (action.action) {
        case "ADD_CLAIM":
        case "ATTACH_EVIDENCE":
          settlements.push({
            signalIds,
            resolutionType: "shared_claim",
            claimId,
            note: "Settled by Evidence attached to a shared Claim.",
          });
          break;
        case "UPDATE_CLAIM":
          settlements.push({
            signalIds,
            resolutionType: "shared_claim",
            claimId,
            note: "Settled by revising a Claim both papers now support.",
          });
          break;
        case "MARK_CONFLICT":
          settlements.push({
            signalIds,
            resolutionType: "conflict",
            claimId,
            note: "Settled as a contradiction between the two papers.",
          });
          break;
        case "CREATE_PAGE":
          settlements.push({
            signalIds,
            resolutionType: "same_page",
            pageId,
            note: "Settled by placing both papers under one knowledge entry.",
          });
          break;
        case "LINK_RELATION":
          settlements.push({
            signalIds,
            resolutionType: "concept_relation",
            relationId: result.actionRelationIds?.[index],
            note: "Settled as a relation between concepts the two papers share.",
          });
          break;
        default:
          break;
      }
    }
    if (!settlements.length) return undefined;
    let settledSignals = 0;
    let resolutions = 0;
    let dismissed = 0;
    const decisions: WikiLinkSettlementResult["decisions"] = [];
    for (const settlement of settlements) {
      try {
        const outcome = await this.links.resolveSignals({
          libraryID: input.libraryID,
          signalIds: settlement.signalIds,
          resolutionType: settlement.resolutionType,
          claimId: settlement.claimId,
          claimIds: settlement.claimIds,
          pageId: settlement.pageId,
          relationId: settlement.relationId,
          note: settlement.note,
          reasonBySignal: settlement.reasonBySignal,
        });
        settledSignals += outcome.settled;
        resolutions += outcome.resolutionIds.length;
        decisions.push(...outcome.decisions);
        if (settlement.resolutionType === "no_action") {
          dismissed += outcome.settled;
        }
      } catch (error) {
        ztoolkit.log("[wiki] could not settle a link signal", error);
        throw error;
      }
    }
    return { settledSignals, resolutions, dismissed, decisions };
  }

  /**
   * Settle the "the note is ahead of the Wiki" debt CHUNK BY CHUNK, and report
   * what is still owed.
   *
   * The version this replaced settled per PAPER: any Evidence citing a paper
   * cleared everything that paper owed. Read {10, 11, 35, 48, 60} to answer a
   * question, write one Claim quoting chunk 10, and the other four were
   * recorded as written up although nothing had looked at them. The debt has
   * to be as fine-grained as the reading was, or it measures the wrong thing.
   *
   * Two ways a chunk is settled, and both are honest:
   *
   *   - It was CITED as Evidence. Its content is now in the Wiki.
   *   - It was WRITTEN OFF by a SKIP action naming it, with a reason. Plenty
   *     of read text establishes nothing the Wiki did not already hold - a
   *     restated definition, a figure caption confirming a known number, a
   *     paragraph of related work - and demanding a Claim for it would fill
   *     the Wiki with noise to satisfy a counter. So the answer is allowed;
   *     what is not allowed is leaving it unsaid. The reason is validated when
   *     the action is hydrated and kept in the ledger permanently.
   *
   * Anything neither cited nor written off stays owed, and its paper stays
   * closed to further question-driven reading. That is deliberate: a partial
   * write-up is still a real write-up and its Claims are kept, but it does not
   * buy the right to read on.
   *
   * Separate from `settleReadingSession` because they answer different
   * questions. That one is about the library's single full-text slot - who
   * holds it, may they let go of it. This one is about a round of questions,
   * which routinely reads three papers and writes them up in ONE commit; each
   * of those papers has its own debt and its own session, and none of them is
   * the paper holding the slot.
   */
  private async settleQuestionReading(
    libraryID: number,
    citedChunkIdsByItem: Map<string, Set<number>>,
    writeOffs: WikiWikiWriteOff[],
    dependencies?: WikiCommitReadingDependency[],
  ): Promise<
    | {
        settledByEvidence: Array<{ itemKey: string; chunkIds: number[] }>;
        settledAsNoUpdate: Array<{
          itemKey: string;
          chunkIds: number[];
          reason: string;
        }>;
        clearedPapers: string[];
        stillPending: Array<{
          itemKey: string;
          pendingChunkIds: number[];
          pendingChunks: number;
        }>;
        consulted: Array<{
          itemKey: string;
          chunksRead: number;
          totalChunks: number;
          noteKey: string;
        }>;
        note?: string;
      }
    | undefined
  > {
    const sessions = await this.store.readingSessions();
    const relatedKeys = new Set([...citedChunkIdsByItem.keys(), ...writeOffs.map((entry) => entry.itemKey)]);
    const belongsToOperation = (session: WikiReadingSessionRecord) => dependencies
      ? dependencies.some((entry) => entry.sessionId === session.sessionId)
      : relatedKeys.has(session.itemKey);
    const pending = await sessions.listPendingWiki(libraryID);

    const byItem = new Map(
      pending.filter((entry) => belongsToOperation(entry.session)).map((entry) => [entry.session.itemKey, entry]),
    );
    const settledByEvidence: Array<{ itemKey: string; chunkIds: number[] }> =
      [];
    const settledAsNoUpdate: Array<{
      itemKey: string;
      chunkIds: number[];
      reason: string;
    }> = [];

    for (const [itemKey, chunkIds] of citedChunkIdsByItem) {
      const entry = byItem.get(itemKey);
      if (!entry) continue;
      const settled = await sessions.settleWikiChunks(
        entry.session.sessionId,
        [...chunkIds],
        "evidence",
      );
      if (settled.length) settledByEvidence.push({ itemKey, chunkIds: settled });
    }

    for (const writeOff of writeOffs) {
      const entry = byItem.get(writeOff.itemKey);
      if (!entry) continue;
      const settled = await sessions.settleWikiChunks(
        entry.session.sessionId,
        writeOff.chunkIds,
        "no_update",
        writeOff.reason,
      );
      if (settled.length) {
        settledAsNoUpdate.push({
          itemKey: writeOff.itemKey,
          chunkIds: settled,
          reason: writeOff.reason,
        });
      }
    }

    const clearedPapers: string[] = [];
    const stillPending: Array<{
      itemKey: string;
      pendingChunkIds: number[];
      pendingChunks: number;
      pendingSignalIds?: number[];
    }> = [];
    for (const entry of pending) {
      const remaining = await sessions.pendingWikiChunks(
        entry.session.sessionId,
      );
      if (!remaining.length) {
        clearedPapers.push(entry.session.itemKey);
        continue;
      }
      stillPending.push({
        itemKey: entry.session.itemKey,
        pendingChunkIds: remaining.map((chunk) => chunk.chunkId),
        pendingChunks: remaining.length,
      });
    }

    /*
     * Close the question-driven sessions that owe nothing, and say which
     * papers this round of questions consulted.
     *
     * This runs LAST so it sees the settlements above: a paper cleared by this
     * very commit is closed by it too, rather than waiting for the next one.
     *
     * The sessions closed here are not in debt - that is the whole condition -
     * so nothing is being waved through. What was missing was an ending. A
     * `qa` session cannot be `committed`, because a question never delivers a
     * whole paper, and calling it `skipped` would report a reading that was
     * used as one that was abandoned. So they stayed open, and the papers a
     * round of questions had read left no trace unless they happened to
     * produce Evidence: in the measured run, four of six papers appeared in
     * the ledger and the two that produced nothing appeared nowhere at all.
     *
     * The reading NOTE is deliberately not touched. Its status still says
     * `reading` because that is still true - the note stays open and the next
     * question about this paper appends to it - and stamping it would cost a
     * Zotero write and a user approval to record something that has not
     * happened.
     */
    const consulted: Array<{
      itemKey: string;
      chunksRead: number;
      totalChunks: number;
      noteKey: string;
    }> = [];
    for (const session of await sessions.listSettledQuestionSessions(
      libraryID,
    )) {
      if (!belongsToOperation(session)) continue;
      const pendingLinks = await this.links.unsettledMandatory({ libraryID, itemKeys: new Set([session.itemKey]), settledSignalIds: new Set() });
      if (pendingLinks.length) {
        stillPending.push({ itemKey: session.itemKey, pendingChunkIds: [], pendingChunks: 0, pendingSignalIds: pendingLinks.map((signal) => signal.signalId) });
        continue;
      }
      const coverage = await sessions.coverage(session.sessionId);
      await sessions.close(
        session.sessionId,
        "answered",
        `Closed by a Wiki commit: ${coverage.deliveredChunks} chunk(s) of this paper were read to ` +
          "answer questions, and every one of them is accounted for in the Wiki.",
      );
      consulted.push({
        itemKey: session.itemKey,
        chunksRead: coverage.deliveredChunks,
        totalChunks: coverage.totalChunks,
        noteKey: session.noteKey ?? "",
      });
    }

    if (
      !pending.length &&
      !consulted.length &&
      !settledByEvidence.length &&
      !settledAsNoUpdate.length
    ) {
      return undefined;
    }

    return {
      settledByEvidence,
      settledAsNoUpdate,
      clearedPapers,
      stillPending,
      consulted,
      ...(stillPending.length || consulted.length
        ? {
            note: [
              stillPending.length
                ? `This commit settled ${clearedPapers.length ? clearedPapers.join(", ") : "no paper"} in full. ` +
                  "Reading that has still not reached the Wiki: " +
                  stillPending
                    .map(
                      (row) =>
                        row.pendingSignalIds?.length ? `${row.itemKey} cross-paper signals ${row.pendingSignalIds.join(", ")}` : `${row.itemKey} chunk(s) ${row.pendingChunkIds.join(", ")}`,
                    )
                    .join("; ") +
                  ". Each of those chunks needs either Evidence quoting it in a Claim, or a SKIP " +
                  "action naming it and saying what it established that the Wiki already holds - a " +
                  'real reason, not "nothing new". Until then those papers refuse another ' +
                  "question's reading. If a paper's reading is not worth writing up at all, close " +
                  'it with wiki_finish_reading and outcome "skipped".'
                : "",
              consulted.length
                ? "Question-driven reading closed as answered: " +
                  consulted
                    .map(
                      (row) =>
                        `${row.itemKey} (${row.chunksRead}/${row.totalChunks} chunk(s))`,
                    )
                    .join("; ") +
                  ". Those papers owed the Wiki nothing, so their sessions are finished and the " +
                  "record of what this round of questions consulted is kept. Their notes stay open: " +
                  "the next question about one of them appends to the same note and will not be " +
                  "handed passages it has already read."
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          }
        : {}),
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
    citedKeys: Set<string>,
    authorizeNoteStatusWrite?: () => Promise<boolean | void>,
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
        noteStatusWrite?: WikiNoteStatusWriteResult;
      }
    | undefined
  > {
    const sessions = await this.store.readingSessions();
    if (input.checkpoint) return undefined;
    const open = input.readingSessionId ? await sessions.get(input.readingSessionId) : await sessions.getOpen(input.libraryID);
    if (!open) return undefined;
    if (open.libraryID !== input.libraryID) throw new Error('The saved reading session does not belong to this library.');
    if (open.state === 'committed') {
      const coverage = await sessions.coverage(open.sessionId);
      const noteStatusWrite = await this.syncNoteStatus(open, 'completed', authorizeNoteStatusWrite);
      return { sessionId: open.sessionId, itemKey: open.itemKey, state: open.state, released: true,
        deliveredChunks: coverage.deliveredChunks, totalChunks: coverage.totalChunks, coverageComplete: coverage.complete,
        note: 'The saved session was already closed; only its reading-note status was retried.', noteStatusWrite };
    }
    if (open.mode !== 'fulltext' || !['reading', 'prepared'].includes(open.state)) return undefined;

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
      // Delivering every chunk is the FIRST of four conditions, and for a long
      // time it was treated as all of them.
      //
      // The other three are already enforced at wiki_prepare_update - but only
      // a commit containing CREATE_PAGE has to pass through prepare at all, so
      // an ADD_CLAIM-only commit reached this line having answered none of
      // them, and closed the paper as `committed` with no whole-paper
      // synthesis, no terminology pass and no Wiki review. Checking them here
      // as well is not redundant: this is where "committed" is actually
      // written, and it is the only place that catches the path around the
      // gate rather than through it.
      //
      // The fourth is the reason this check exists at all. A paper questions
      // had been reading carries per-chunk Wiki debt into the full-text read
      // when its session is promoted. Closing on coverage alone discarded it:
      // `listPendingWiki` only looks at OPEN sessions, so the moment the
      // session closed the outstanding chunks stopped being visible anywhere.
      // The reading was recorded, the Wiki never learned it, and nothing was
      // left to say so.
      const outstanding = await sessions.pendingWikiChunks(open.sessionId);
      const blockers: string[] = [];
      const crossPaperPending = await (
        await this.store.crossPaperReviews()
      ).pendingForItem(input.libraryID, open.itemKey);
      if (crossPaperPending.length)
        blockers.push(
          `old Wiki knowledge still needs review in task(s): ${crossPaperPending.join(", ")}`,
        );
      const pendingLinks = await this.links.unsettledMandatory({ libraryID: input.libraryID, itemKeys: new Set([open.itemKey]), settledSignalIds: new Set() });
      if (pendingLinks.length) blockers.push(`cross-paper signals still need individual decisions: ${pendingLinks.map((signal) => signal.signalId).join(", ")}`);
      const unrecorded = await sessions.pendingIntegrationIndexes(open.sessionId);
      if (unrecorded.length) blockers.push(`reading records are missing for chunk indexes ${unrecorded.join(", ")}`);
      if (open.finalSynthesisAt === null) {
        blockers.push(
          "the macro summary has not been appended after the reading records — call " +
            "wiki_update_reading_note with finalSynthesis true and macroSummary",
        );
      }
      if (open.conceptsRecordedAt === null) {
        blockers.push(
          "the terminology this paper established has not been reviewed as a whole — call " +
            "wiki_record_concepts once with final true, an empty list and a reason if it introduced " +
            "nothing new",
        );
      }
      if (open.wikiReviewAt === null) {
        blockers.push(
          "the whole Wiki has not been reviewed against the finished paper — call " +
            "wiki_prepare_update with wikiReview answering pages, claims, evidence, concepts and " +
            "relations",
        );
      }
      if (outstanding.length) {
        blockers.push(
          `${outstanding.length} chunk(s) of this paper have been read and have still not reached the ` +
            `Wiki: ${outstanding.map((chunk) => chunk.chunkId).join(", ")}. Settle each one, with ` +
            "Evidence quoting it or a SKIP action naming it and saying what already covers it. One " +
            "SKIP may name many chunks at once, so a section of derivation or a bibliography is a " +
            "single action with one reason",
        );
      }

      if (blockers.length) {
        // The write stands and the paper stays open. Everything committed here
        // is durable; what is refused is the CLAIM THAT THE PAPER IS FINISHED.
        await sessions.markReading(open.sessionId);
        return {
          ...base,
          state: "reading",
          released: false,
          ...(outstanding.length
            ? {
                outstandingQuestionChunkIds: outstanding.map(
                  (chunk) => chunk.chunkId,
                ),
              }
            : {}),
          note:
            `Every chunk of ${open.itemKey} has been delivered and these claims are committed, but the ` +
            `paper is not finished, so it stays open and keeps the library. Outstanding: ` +
            blockers.map((line, index) => `(${index + 1}) ${line}`).join("; ") +
            `. Do those, then commit again — the last commit closes it. To abandon it instead, use ` +
            `wiki_finish_reading with itemKey "${open.itemKey}" and outcome "skipped".`,
        };
      }

      await sessions.close(open.sessionId, "committed");
      // The note is kept permanently, so it becomes this paper's long-term
      // reading memory rather than scaffolding: a later re-read continues it,
      // and a person can open it in Zotero. Only its status changes here.
      const noteStatusWrite = await this.syncNoteStatus(
        open,
        "completed",
        authorizeNoteStatusWrite,
      );
      return {
        ...base,
        state: "committed",
        released: true,
        noteStatusWrite,
        note:
          `Paper ${open.itemKey} was read in full, synthesised, its terminology and the Wiki reviewed, and every chunk it owed the Wiki settled. It is now closed. ` +
          (noteStatusWrite.updated
            ? "Its reading note stays on the Zotero item, marked completed. "
            : `Its Wiki state is complete, but the Zotero reading-note status was not changed (${noteStatusWrite.reason}). `) +
          "The library is free for the next paper.",
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
  async finishReading(
    options: {
      libraryID: number;
      itemKey?: string;
      outcome: WikiReadingAbandonOutcome;
      note?: string;
    },
    writeOptions: WikiNoteStatusWriteOptions = {},
  ): Promise<any> {
    const pending = await this.store.findNoteOperation(options.libraryID, await this.noteRequestHash(options));
    return this.withNoteWrite(options.libraryID, pending?.session.itemKey ?? options.itemKey, () => this.finishReadingLocked(options, writeOptions));
  }

  private async finishReadingLocked(
    options: Parameters<WikiService["finishReading"]>[0], writeOptions: WikiNoteStatusWriteOptions,
  ): Promise<any> {
    if (options.outcome !== "skipped" && options.outcome !== "failed") {
      throw new Error(
        'finishReading only accepts "skipped" or "failed". A paper becomes "committed" by being read in full and committed, never by being declared finished.',
      );
    }
    const sessions = await this.store.readingSessions();
    const requestHash = await this.noteRequestHash(options);
    const pending = await this.store.findNoteOperation(options.libraryID, requestHash);
    if (pending?.kind === "finish") {
      const saved = await sessions.get(pending.session.sessionId);
      if (!saved || saved.sourceVersion !== pending.session.sourceVersion || saved.noteKey !== pending.session.noteKey) {
        throw new Error("The saved terminal note operation no longer matches its reading session.");
      }
      const latest = await sessions.latestForItem(saved.libraryID, saved.itemKey);
      if (latest?.sessionId !== saved.sessionId && latest?.noteKey === saved.noteKey) {
        throw new Error("A newer reading now uses this note; the old terminal status requires review.");
      }
      if (saved.state !== options.outcome) {
        await this.assertSkippedLinksDecided(options.libraryID, saved.itemKey, options.outcome);
        await sessions.close(saved.sessionId, options.outcome, options.note ?? "");
      }
      const noteStatusWrite = await this.syncNoteStatusLocked(saved, options.outcome, writeOptions.authorizeNoteStatusWrite);
      if (noteStatusWrite.updated) await this.store.clearNoteOperation(saved.libraryID, saved.itemKey);
      return { closed: true, recovered: true, itemKey: saved.itemKey, outcome: options.outcome, noteStatusWrite };
    }
    // With a key, close THAT paper, whichever mode it is being read in: a
    // round of questions can leave three papers open, none of which holds the
    // full-text slot, and "I read a bit of that one and it is not worth
    // writing up" has to be sayable about each of them. Without a key it means
    // what it always meant - close the paper being read in full.
    const requestedKey = String(options.itemKey ?? "").trim();
    const open = requestedKey
      ? await sessions.openForItem(options.libraryID, requestedKey)
      : await sessions.getOpen(options.libraryID);
    if (!open) {
      // Naming a paper that is not open stays an ERROR rather than a quiet
      // "nothing to do". The itemKey is a guard, and the whole value of a
      // guard is that being wrong about which paper you are closing is loud:
      // silently succeeding would let a caller believe it closed one paper
      // while a different one still held the slot.
      const stillOpen = await sessions.getOpen(options.libraryID);
      if (requestedKey && stillOpen) {
        throw new Error(
          `The open paper is ${stillOpen.itemKey}, not ${requestedKey}. Pass that itemKey, or omit ` +
            "itemKey to close whatever is open. (Papers being read by questions are closed by naming " +
            "them too, but nothing is open for " +
            `${requestedKey}.)`,
        );
      }
      return {
        closed: false,
        message: requestedKey
          ? `No reading session is open for ${requestedKey} in this library.`
          : "No paper is currently open for full-text reading in this library.",
      };
    }
    const coverage = await sessions.coverage(open.sessionId);
    const owedAtClose = await sessions.pendingWikiChunks(open.sessionId);
    await this.assertSkippedLinksDecided(options.libraryID, open.itemKey, options.outcome);
    if (await this.store.getNoteOperation(open.libraryID, open.itemKey)) {
      throw new Error("A reading-note operation needs recovery before closing. Retry its original request.");
    }
    await this.store.saveNoteOperation(open.libraryID, open.itemKey, { kind: "finish", requestHash, request: options, session: open });
    await sessions.close(open.sessionId, options.outcome, options.note ?? "");
    // The note stays on the item - it records a real reading even when the
    // paper was not written up - but its status has to stop saying "reading",
    // or a later resume would trust a progress line that nothing is advancing.
    const noteResult = await this.syncNoteStatusLocked(
      open,
      options.outcome === "skipped" ? "skipped" : "failed",
      writeOptions.authorizeNoteStatusWrite,
    );
    if (noteResult.updated || !open.noteKey) await this.store.clearNoteOperation(open.libraryID, open.itemKey);
    return {
      closed: true,
      itemKey: open.itemKey,
      outcome: options.outcome,
      chunksRead: coverage.deliveredChunks,
      totalChunks: coverage.totalChunks,
      noteStatusWrite: noteResult,
      ...(noteResult.updated
        ? {
            readingNote: {
              attachmentKey: noteResult.attachmentKey,
              status: noteResult.status,
            },
          }
        : {}),
      mode: open.mode,
      // Closing discharges whatever the note owed the Wiki: the reading has
      // been deliberately abandoned, so there is nothing left to write up and
      // nothing left to block the next question.
      pendingWikiChunksDischarged: owedAtClose.length,
      pendingWikiChunkIdsDischarged: owedAtClose.map((chunk) => chunk.chunkId),
      message:
        `Paper ${open.itemKey} closed as ${options.outcome}.` +
        (open.mode === "fulltext"
          ? " The library is free for the next paper."
          : " It was being read by questions, so it held no reading slot; what it does free is the " +
            "block on reading it again — its note keeps everything already understood.") +
        (owedAtClose.length > 0
          ? ` ${owedAtClose.length} chunk(s) of reading in its note were never written into the Wiki, and now never will be.`
          : "") +
        (noteResult.updated
          ? ` Its Zotero reading note is marked ${noteResult.status}.`
          : ` Its Wiki state is closed, but the Zotero reading-note status was not changed (${noteResult.reason}).`),
    };
  }

  private async assertSkippedLinksDecided(libraryID: number, itemKey: string, outcome: string): Promise<void> {
    if (outcome !== "skipped") return;
    const pending = await this.links.unsettledMandatory({ libraryID, itemKeys: new Set([itemKey]), settledSignalIds: new Set() });
    if (pending.length) throw new Error(`Before concluding this reading as skipped, decide cross-paper signals ${pending.map((signal) => signal.signalId).join(", ")} with RESOLVE_LINK_SIGNAL. Independent Claims and reasoned no_action are valid. Use failed only when the reading could not be completed.`);
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
    return this.withNoteWrite(options.libraryID, options.itemKey, () => this.setReadingExpertLocked(options));
  }

  private async setReadingExpertLocked(options: {
    libraryID: number;
    itemKey?: string;
    persona: string;
    focus: string[];
  }): Promise<any> {
    const sessions = await this.store.readingSessions();
    const session = await this.requireOpenSession(options.libraryID, options.itemKey);
    if (await this.store.getNoteOperation(session.libraryID, session.itemKey)) {
      throw new Error("Recover the pending reading-note operation before changing the expert.");
    }
    // A provisional profile is the placeholder a question-driven read assembles
    // from the retrieval call's own domain and expertRole. It is replaceable
    // precisely because it was never composed: the full-text read of a paper
    // that questions had been probing still gets its one deliberate reader.
    if (session.expert && !session.expert.provisional) {
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
    const item = await this.requirePaperItem(session.libraryID, session.itemKey);
    const existingBody = await this.readNoteBody(item, session);
    await sessions.setExpert(session.sessionId, expert);
    const refreshed = (await sessions.get(session.sessionId)) ?? session;
    const written = await this.writeNote(item, { ...refreshed, noteKey: session.noteKey }, existingBody ?? "", "reading",
      { expectedBody: existingBody ?? "" });

    return {
      itemKey: session.itemKey,
      expert,
      readingSession: { sessionId: session.sessionId, state: refreshed.state },
      readingNote: written,
      requiredSections:
        refreshed.mode === "fulltext" ? WIKI_RECORD_SECTIONS : [],
      nextStep:
        "The reading note now exists on the Zotero item and will survive a restart, a dropped " +
        "connection and a context compaction. Read the body with wiki_build_from_paper, and after " +
        "each batch call wiki_update_reading_note with one readingRecord for only that batch. The " +
        "server audits, numbers and appends it without changing earlier records.",
    };
  }

  /**
   * Append one immutable record, or the final macro summary, to the note.
   *
   * New information never rewrites an earlier record. If section 5 corrects
   * what section 2 appeared to establish, it appends a correction naming that
   * record so both the original reading and its correction remain auditable.
   * `unchanged` appends an explicit no-new-content record and may repeat.
   */
  /**
   * Fold what has just been read into the paper's one Markdown note.
   *
   * Two callers, one document. A `wiki_build_from_paper` page arrives with no
   * `readChunkIds`: the chunks were already booked when they were handed over,
   * and this call only says the note now accounts for them. A QUESTION arrives
   * with `readChunkIds` - the passages retrieval surfaced and the model
   * actually used to answer - and those are booked here, because that is the
   * only moment the server can tell reading from retrieval. A chunk that came
   * back from `search_fulltext` and was skimmed past is not reading, and the
   * model is the only party that knows which is which, so it declares them.
   *
   * The note is the same file either way. That is the whole design: the
   * understanding a hundred questions built up and the understanding a
   * full-text pass builds are the same understanding of the same paper, and
   * splitting them into two documents would mean the full-text read starts
   * from nothing and the questions are forgotten.
   */
  async updateReadingNote(options: {
    libraryID: number;
    itemKey?: string;
    /** This turn's append-only record. `markdown` is a deprecated alias. */
    readingRecord?: string;
    /** The one whole-paper summary appended after all reading records. */
    macroSummary?: string;
    markdown?: string;
    unchanged?: boolean;
    unchangedReason?: string;
    finalSynthesis?: boolean;
    /**
     * Proof for the sentences the synthesis gate flagged; see
     * `./wikiSynthesisAudit`. Only ever read on the final-synthesis pass.
     */
    synthesisAudit?: WikiSynthesisAuditEntry[];
    /**
     * The chunk ids this turn actually READ and used, from `search_fulltext`
     * or `get_document_chunks`. Present only on the question-driven path.
     */
    readChunkIds?: number[];
    /** The sub-field this paper was read as, from the retrieval call. */
    domain?: string;
    /** The specialist perspective it was read from, from the same call. */
    expertRole?: string;
  }): Promise<any> {
    return this.withNoteWrite(options.libraryID, options.itemKey, (queued) =>
      this.updateReadingNoteLocked(options, queued));
  }

  private async updateReadingNoteLocked(
    options: Parameters<WikiService["updateReadingNote"]>[0],
    queued: boolean,
  ): Promise<any> {
    const operationKey = options.itemKey || (await (await this.store.readingSessions()).getOpen(options.libraryID))?.itemKey;
    const requestHash = await this.noteRequestHash(options);
    if (operationKey) {
      const pending = await this.store.getNoteOperation(options.libraryID, operationKey);
      if (pending) {
        if (pending.kind !== "integration" || pending.requestHash !== requestHash) {
          throw new Error(`A reading-note operation for ${operationKey} needs recovery. Retry its original request before submitting new content.`);
        }
        const result = await this.resumeNoteIntegration(pending);
        const debt = await (await this.store.readingSessions()).pendingWikiChunks(pending.session.sessionId);
        const coverage = await (await this.store.readingSessions()).coverage(pending.session.sessionId);
        return { itemKey: operationKey, integrated: true, recovered: true,
          mode: result.refreshed.mode,
          finalSynthesis: pending.finalSynthesis, readingNote: result.written,
          reading: { newChunks: result.booked.newIndexes, newChunkCount: result.booked.newIndexes.length,
            alreadyReadChunks: result.booked.alreadyRead, alreadyReadCount: result.booked.alreadyRead.length,
            deliveredChunks: coverage.deliveredChunks, totalChunks: coverage.totalChunks, coverageComplete: coverage.complete },
          readingSession: result.refreshed, wikiDebt: { count: debt.length, chunkIds: debt.map((entry) => entry.chunkId), chunkIndexes: debt.map((entry) => entry.chunkIndex) },
          nextStep: "The saved reading-note operation is complete. Call wiki_get_reading_note for the current progress and next step." };
      }
    }
    if (Array.isArray(options.readChunkIds) && options.readChunkIds.length) {
      return this.integrateQuestionReading(options as any, queued);
    }
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
        "The final synthesis appends the paper's macro summary, so it cannot be submitted as " +
          '"unchanged". Send macroSummary.',
      );
    }
    if (finalSynthesis && session.expert.provisional) {
      throw new Error(
        `${session.itemKey} still has the provisional expert assembled from question retrieval. Before ` +
          "the macro summary, call wiki_set_reading_expert with a persona of at least 20 characters and " +
          "2-8 focus areas chosen again from the paper's metadata and abstract.",
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

    const previousBody = (await this.readNoteBody(item, session)) ?? "";
    const deliveredIndexes = await sessions.deliveredIndexes(session.sessionId);
    const pendingIntegrationIndexes =
      await sessions.pendingIntegrationIndexes(session.sessionId);
    if (finalSynthesis && pendingIntegrationIndexes.length) {
      throw new Error(`Reading records are missing for chunk indexes ${pendingIntegrationIndexes.join(", ")}. Integrate every delivered chunk before the macro summary.`);
    }
    const readable = await this.readableChunks(
      session.libraryID,
      session.itemKey,
      deliveredIndexes,
    );
    // The note is the only place the reading records exist, so before either
    // branch touches it, check that it still holds everything this session has
    // already had accepted. Both branches, because a loss discovered only at
    // the final synthesis is a loss that is already permanent.
    const parsedPrevious = parseAppendOnlyReadingNote(previousBody);
    assertRecordLedgerIntact(
      parsedPrevious.records.length,
      await sessions.integrationCount(session.sessionId),
    );
    let body: string;
    if (finalSynthesis) {
      const summary = stripMachineBlock(
        String(options.macroSummary ?? options.markdown ?? ""),
      );
      if (!summary.trim()) {
        throw new Error(
          "macroSummary is required with finalSynthesis. Send only the whole-paper summary; the server appends it after every immutable reading record.",
        );
      }
      const validation = new WikiValidation({
        mode: "synthesis",
        requiredSections:
          session.mode === "fulltext" ? WIKI_MACRO_SECTIONS : [],
      });
      const path = "/macroSummary";
      validation.check(path, "HOLISTIC_BODY", () =>
        assertHolisticBody(summary),
      );
      const syntax = validation.check(path, "CHUNK_CITATIONS", () =>
        assertChunkCitations(summary),
      );
      const addresses =
        syntax &&
        validation.check(path, "CITATION_ADDRESSES", () =>
          assertChunkCitationsResolvable(summary, {
            allowedChunkIds: readable.map((chunk) => chunk.chunkId),
            totalChunks: coverage.totalChunks,
          }),
        );
      if (syntax)
        validation.check(path, "BLOCK_CITATIONS", () =>
          assertBlockCitations(summary),
        );
      if (session.mode === "fulltext") {
        validation.check(path, "SUMMARY_TEMPLATE", () =>
          assertTemplateSections(summary, WIKI_MACRO_SECTIONS, "全文总结"),
        );
        validation.check(path, "CONNECTED_PROSE", () =>
          assertProseIsConnected(summary, "全文总结"),
        );
      }
      validation.check(path, "SUMMARY_PASTE", () =>
        assertMacroIsNotPaste(previousBody, summary),
      );
      const aliases = await this.chunkAddressAliases(
        session.libraryID,
        session.itemKey,
      );
      if (syntax)
        validation.check(path, "RECORD_COVERAGE", () =>
          assertMacroTouchesEveryRecord(
            parsedPrevious.records,
            summary,
            aliases,
          ),
        );
      if (addresses)
        validation.check(path, "SYNTHESIS_AUDIT", () =>
          assertSynthesisEvidenceClosure(
            summary,
            readable,
            options.synthesisAudit ?? [],
          ),
        );
      validation.finish();
      body = appendMacroSummary(previousBody, summary);
    } else {
      const reason = String(options.unchangedReason ?? "").trim();
      if (unchanged && !reason) {
        throw new Error(
          "unchangedReason is required with unchanged: name what was in the chunks that produced no new content.",
        );
      }
      const record = unchanged
        ? `- 本次无新内容（${reason}）。`
        : stripMachineBlock(
            String(options.readingRecord ?? options.markdown ?? ""),
          );
      if (!record.trim()) {
        throw new Error(
          "readingRecord is required: send only what this turn established, not the whole note. The server appends and numbers it.",
        );
      }
      const requestedChunkIds = (options.readChunkIds ?? []).map(Number);
      const recordChunkIds = requestedChunkIds.length
        ? requestedChunkIds
        : pendingIntegrationIndexes.length
          ? pendingIntegrationIndexes
          : citedChunkIds(record).length
            ? citedChunkIds(record)
            : deliveredIndexes.slice(-1);
      const citable = new Set(readable.map((chunk) => chunk.chunkId));
      const invalid = recordChunkIds.filter((id) => !citable.has(id));
      if (invalid.length) {
        throw new Error(
          `Reading record chunk(s) ${invalid.join(", ")} were not delivered for ${session.itemKey}.`,
        );
      }
      const batchChunks = readable.filter((chunk) =>
        recordChunkIds.includes(chunk.chunkId),
      );
      if (!unchanged) {
        this.assertReadingRecordValid(record, {
          fulltext: session.mode === "fulltext",
          recordChunkIds,
          readable,
          batchChunks,
          allowedChunkIds:
            options.readingRecord !== undefined
              ? recordChunkIds
              : readable.map((chunk) => chunk.chunkId),
          totalChunks: coverage.totalChunks,
          currentChunkAddresses: new Set(recordChunkIds),
          explicitRecord: options.readingRecord !== undefined,
          audit: options.synthesisAudit ?? [],
        });
      } else {
        assertUnchangedCarriesNothingNew(previousBody, batchChunks, reason);
      }
      body = appendReadingRecord(previousBody, {
        chunkIds: recordChunkIds,
        content: record,
      });
    }

    // Body before ledger, for the same reason as the question path above: an
    // integration recorded against a note that never saved would mean the
    // batch is never offered again and what it said is gone. Here it also
    // guards the whole-paper synthesis, which is what `paper_reviewed` rests
    // on - recording it before the synthesised note is on disk would let the
    // deepest claim in the system be backed by a file that does not exist.
    const status = finalSynthesis ? "synthesized" : "reading";
    const { written, refreshed } = await this.saveNoteIntegration({
      item, session, body, status, previousBody, requestHash, request: options,
      integratedIndexes: finalSynthesis ? [] : pendingIntegrationIndexes,
      finalSynthesis, unchanged,
    });
    const wikiReconciliation = finalSynthesis
      ? await this.paperReconciliationSnapshot(refreshed, body)
      : null;

    return {
      itemKey: session.itemKey,
      integrated: true,
      mode: refreshed.mode,
      unchanged,
      finalSynthesis,
      readingNote: written,
      requiredSections:
        refreshed.mode === "fulltext"
          ? finalSynthesis
            ? WIKI_MACRO_SECTIONS
            : WIKI_RECORD_SECTIONS
          : [],
      readingSession: {
        sessionId: session.sessionId,
        state: refreshed.state,
        deliveredChunks: coverage.deliveredChunks,
        totalChunks: coverage.totalChunks,
        coverageComplete: coverage.complete,
        integrationDebt: integrationDebt(refreshed),
      },
      ...(wikiReconciliation ? { wikiReconciliation } : {}),
      nextStep: finalSynthesis
        ? "The macro summary is recorded. The response lists every reading record beside every Wiki Claim whose Evidence cites this paper. Now call wiki_record_concepts once with final true " +
          "(use an empty concepts list plus noConceptsReason when appropriate). Then call " +
          "wiki_prepare_update with a five-axis Wiki Review and one claimVerdict for every listed Claim, followed by wiki_commit. Use UPDATE_CLAIM for overstated wording and MARK_CONFLICT for factual contradictions. Every Claim still needs Evidence quoted from the paper's own chunks - the " +
          "note is your understanding, not a source - so re-read the chunks a claim rests on with " +
          "wiki_build_from_paper (offset) and take the excerpt from there. Re-reading a chunk you have " +
          "already been given costs nothing against the integration gate."
        : coverage.complete
          ? "Every chunk has been delivered. Do the whole-paper pass now: call wiki_update_reading_note " +
            "once more with finalSynthesis true and macroSummary. It is written under the heading " +
            "全文总结, and it is written FROM THE WHOLE PAPER AT ONCE rather than from the last page - " +
            "that vantage point is the requirement itself. Retrieve all pages of wiki_get_reading_note " +
            "using markdownPagination, then read every record together and work out how they relate - which " +
            "one explains another's mechanism, which corrects an earlier judgement, which are the same " +
            "phenomenon measured under different conditions. That relating is the job. Re-reading any " +
            "chunk while you write is free.\n" +
            "正文用中文，提炼核心论述、核心方法和核心结论。" +
            // The seven headings are asserted for a full-text pass only (see
            // the mode guard on assertTemplateSections above), so shipping the
            // guide to a question-driven session asked it to write six
            // headings nothing would ever check - and every one of those
            // headings is output the caller pays for.
            (session.mode === "fulltext"
              ? renderTemplateGuide(WIKI_MACRO_SECTIONS)
              : "问答阅读的全文总结不套固定小节：写成连贯的中文段落即可，" +
                "每句引用它依据的 chunk。检查的是引用能否落到读过的 chunk 上，不是小节齐不齐。") +
            "\n" +
            "Do NOT paste the records end to end - more than 60% verbatim is refused. It adds nothing, " +
            "since those records sit directly above it in the same file. Do not reproduce full parameter " +
            "tables or preserve numbers mechanically; include a value only when it is necessary to express " +
            "a core finding or distinguish an important condition. The complete details remain permanently " +
            "available in the reading records. " +
            "Existing reading records stay unchanged. Claims cannot be recorded at paper_reviewed depth until that is done. " +
            GATE_HINT
          : `Keep reading: ${coverage.remainingChunks} chunk(s) left, resume at chunk index ` +
            `${coverage.firstMissingIndex ?? coverage.deliveredChunks}.`,
    };
  }

  /**
   * The question-driven read: book the chunks this turn used, then rewrite the
   * note around them.
   *
   * This is the whole of the incremental path, and it is deliberately ONE call
   * rather than a read tool plus a write tool. A separate "record what I read"
   * step would be a step a model can forget, and a chunk recorded as read
   * before the note is rewritten is a chunk that can end up counted but never
   * understood - which is precisely the coverage inflation the reading ledger
   * exists to prevent. Booking and integrating in the same call makes "the
   * note accounts for everything marked read" true by construction.
   *
   * The order inside is the rule the user asked for, made structural: the note
   * is validated and written FIRST, and only then does the Wiki debt go up.
   * The Wiki is updated from the note, so a turn that could not write a decent
   * note has nothing to put in the Wiki either, and fails before it has
   * changed anything.
   */
  private async integrateQuestionReading(
    options: {
      libraryID: number;
      itemKey?: string;
      readingRecord?: string;
      markdown?: string;
      readChunkIds: number[];
      domain?: string;
      expertRole?: string;
      synthesisAudit?: WikiSynthesisAuditEntry[];
      finalSynthesis?: boolean;
      unchanged?: boolean;
      unchangedReason?: string;
    },
    queued = false,
  ): Promise<any> {
    const itemKey = String(options.itemKey ?? "").trim();
    if (!itemKey) {
      throw new Error(
        "itemKey is required with readChunkIds: the chunk ids say WHICH passages were read, and only " +
          "the item key says which paper they belong to. Pass the same itemKey you gave search_fulltext.",
      );
    }
    if (options.finalSynthesis === true) {
      throw new Error(
        "Do not combine finalSynthesis with new readChunkIds. First append this turn's readingRecord; " +
          "once coverage is complete, reset the provisional expert and make a separate call with " +
          "finalSynthesis true and macroSummary.",
      );
    }
    const item = await this.requirePaperItem(options.libraryID, itemKey);
    const vectorStore = getVectorStore();
    await vectorStore.initialize();
    const readingVersion = await vectorStore.getDocumentRevision(itemKey, options.libraryID);
    const [documentChunks, indexStatus] = await Promise.all([
      vectorStore.getChunksForItem(itemKey, options.libraryID),
      vectorStore.getIndexStatus(itemKey, options.libraryID),
    ]);
    assertChunkRevision(readingVersion, await vectorStore.getDocumentRevision(itemKey, options.libraryID));
    if (!documentChunks.length) {
      throw new Error(
        `${itemKey} has no indexed chunks, so nothing about it can be recorded as read. Build its search index first.`,
      );
    }
    const bodyState = bodyIndexStateFromSourceKind(indexStatus?.sourceKind);
    if (bodyState !== "body") {
      throw new Error(
        `${itemKey} holds only metadata/abstract chunks (index state: ${bodyState}). Reading it means ` +
          "reading its body, so build the body-text index before recording a reading of it.",
      );
    }

    const sessions = await this.store.readingSessions();
    const session = await sessions.startOrContinue({
      libraryID: options.libraryID,
      itemKey,
      title: String(item.getField?.("title") || ""),
      totalChunks: documentChunks.length,
      sourceVersion: readingVersion,
      mode: "qa",
    });

    // The "note before Wiki" gate, one turn later. A paper whose last reading
    // never reached the Wiki does not get to be read again: otherwise a reader
    // answers question after question from the same paper, improves the note
    // every time, and the Wiki - which is the part that survives the
    // conversation - never learns anything at all.
    const owed = await sessions.pendingWikiChunks(session.sessionId);
    if (owed.length > 0 && session.mode === "qa" && !queued) {
      throw new Error(
        `Chunk(s) ${owed.map((chunk) => chunk.chunkId).join(", ")} of ${itemKey} are in its reading note ` +
          "but not yet in the Wiki, and the note must never run ahead of the Wiki by more than one turn. " +
          "Write that reading up first: wiki_prepare_update, then wiki_commit. Every one of those chunks " +
          "has to be settled - either an Evidence excerpt quoting it in a Claim, or a SKIP action naming " +
          "it with a reason saying what it establishes that the Wiki already holds. Citing just one of " +
          "them no longer settles the rest, because it never did settle the rest. (If the whole reading " +
          'is not worth writing up, close the paper with wiki_finish_reading and outcome "skipped".)',
      );
    }

    // An expert profile from what the retrieval call already decided. A
    // question-driven read has a reader too - search_fulltext refuses to be
    // recorded as domain-expert retrieval without `domain` and `expertRole`,
    // re-fitted to THIS paper - so asking for the persona a second time would
    // be asking the same question twice and slowing every question down to do
    // it. The profile is only ever filled in, never overwritten: a persona
    // written for a full-text read is the considered one and outranks this.
    if (!session.expert) {
      const expert = this.questionReadingExpert(
        options.domain,
        options.expertRole,
        itemKey,
      );
      await sessions.setExpert(session.sessionId, expert);
      session.expert = expert;
    }

    // Ids are checked as ARGUMENTS, before anything is judged about the note.
    // A chunkId from the wrong paper is a mistake in the call, and answering it
    // with "your note is too short" sends the caller to fix the wrong thing.
    // Nothing is booked here - that happens once the note has passed.
    const knownChunkIds = new Set(
      documentChunks.map((chunk) => Number(chunk.chunkId)),
    );
    const unknownChunkIds = options.readChunkIds
      .map((raw) => Number(raw))
      .filter((id) => !knownChunkIds.has(id));
    if (unknownChunkIds.length) {
      throw new Error(
        `These chunk ids are not passages of ${itemKey}: ${unknownChunkIds.join(", ")}. ` +
          "chunkId comes from a search_fulltext or get_document_chunks call on THIS paper; ids from " +
          "another document, and chunkIndex values passed as ids, both land here. Nothing was recorded.",
      );
    }

    /*
     * A concluded note is left alone and this episode starts a new one.
     *
     * The note ends with 全文总结, which synthesises every record above it, so
     * nothing may follow it. Before this, a question about a paper that had
     * been read through was simply refused - which meant the papers you know
     * best were the ones whose later reading could never be recorded.
     */
    const previousBody = (await this.readNoteBody(item, session)) ?? "";
    const unchanged = options.unchanged === true;
    const reason = String(options.unchangedReason ?? "").trim();
    if (unchanged && !reason) {
      throw new Error(
        "unchangedReason is required with unchanged: name what was in the chunks that produced no new content.",
      );
    }
    const record = unchanged
      ? `- 本次无新内容（${reason}）。`
      : stripMachineBlock(
          String(options.readingRecord ?? options.markdown ?? ""),
        );
    if (!record.trim()) {
      throw new Error(
        "readingRecord is required: send only what this turn established, not the whole note. The server appends and numbers it.",
      );
    }
    // The chunks this note may cite are what the ledger already holds PLUS the
    // ones this call is booking. They are booked after the note passes, so
    // reading the ledger alone would refuse the very citations the caller is
    // here to add - the note and its reading are submitted together on this
    // path, which is the whole point of it being one call.
    const citableChunks = await this.readableChunks(
      session.libraryID,
      itemKey,
      [
        ...(await sessions.deliveredIndexes(session.sessionId)),
        ...documentChunks
          .map((chunk, index) => ({ index, id: Number(chunk.chunkId) }))
          .filter((entry) => options.readChunkIds.includes(entry.id))
          .map((entry) => entry.index),
      ],
    );
    const batchChunks = documentChunks.filter((chunk) => options.readChunkIds.includes(Number(chunk.chunkId)));
    if (!unchanged) {
      const currentAddresses = new Set<number>();
      documentChunks.forEach((chunk, index) => {
        if (options.readChunkIds.includes(Number(chunk.chunkId))) {
          currentAddresses.add(index);
          currentAddresses.add(Number(chunk.chunkId));
        }
      });
      const aliases = await this.chunkAddressAliases(session.libraryID, itemKey);
      let cited = new Set<number>();
      try {
        cited = new Set(citedChunkIds(record));
      } catch {
        /* The validation collector reports malformed ranges. */
      }
      this.assertReadingRecordValid(record, {
        fulltext: false,
        readable: citableChunks,
        batchChunks,
        recordChunkIds: options.readChunkIds.map((id) =>
          cited.has(id)
            ? id
            : (aliases.get(id)?.find((alias) => cited.has(alias)) ?? id),
        ),
        allowedChunkIds:
          options.readingRecord !== undefined
            ? currentAddresses
            : citableChunks.map((chunk) => chunk.chunkId),
        totalChunks: documentChunks.length,
        currentChunkAddresses: currentAddresses,
        explicitRecord: options.readingRecord !== undefined,
        audit: options.synthesisAudit ?? [],
      });
    } else {
      assertUnchangedCarriesNothingNew(previousBody, batchChunks, reason);
    }
    // Decided here rather than earlier, because the test is what this turn
    // SAYS and the record only exists once it has passed validation.
    const route = await this.routeReadingRecord(
      item,
      session,
      options.readChunkIds,
      record,
    );
    /*
     * Append onto whichever note is taking this record.
     *
     * `previousBody` already holds the session's current note, so it is reused
     * unless the record is going somewhere else. Re-reading unconditionally
     * would be harmless right up until the read failed, and a failed read here
     * would look like an empty note and overwrite it.
     */
    let targetBody = previousBody;
    if (route.startNewEpisode) {
      targetBody = "";
    } else if (route.attachment && route.attachment.key !== session.noteKey) {
      const raw = await this.notes.read(route.attachment);
      if (raw === null) {
        throw new Error(
          `The reading note this record belongs in could not be read (${String(
            route.attachment.key ?? "unknown",
          )}). Nothing was recorded; retry once Zotero can open its attachments.`,
        );
      }
      targetBody = parseReadingNote(raw).body;
    }
    const body = route.write
      ? appendReadingRecord(targetBody, {
          chunkIds: options.readChunkIds,
          content: record,
        })
      : targetBody;

    // THE ORDER HERE IS THE POINT, and it used to be the other way round.
    //
    // A chunk counts as read because its content reached the reading note. The
    // ledger was being written first, so a note write that failed - a full
    // disk, a locked attachment, a Zotero API error - left the chunk recorded
    // as read, counted towards coverage and owing the Wiki, while the sentence
    // that was supposed to preserve what it said existed nowhere. The reader
    // would never be handed that text again, because the ledger says it has
    // been read.
    //
    // The two stores cannot be made atomic - one is a file, the other is a
    // database - so the order is chosen for which way a failure leans. Body
    // first means a crash in between UNDER-counts: the note holds text the
    // ledger does not credit, so the chunk is offered again and the model
    // rewrites a note that already covers it. That is wasted work. Ledger
    // first OVER-counts, which is silent, permanent data loss.
    const saved = await this.saveNoteIntegration({
      item, session, body, previousBody: targetBody, status: "reading",
      requestHash: await this.noteRequestHash(options), request: options,
      readChunkIds: options.readChunkIds, documentChunks: documentChunks.map((chunk) => ({ chunkId: Number(chunk.chunkId) })),
      newUnderstanding: route.write && !unchanged, finalSynthesis: false, unchanged,
      write: route.write, startNewEpisode: route.startNewEpisode, attachment: route.attachment,
    });
    const written = route.write
      ? saved.written
      : {
          // The reading still reaches the ledger - see below - so the Evidence
          // gate and the cross-paper mustResolve check both see it. What it
          // does not get is a note of its own, because it said nothing the
          // note does not already say.
          ...saved.written,
          skipped: route.reason,
          similarity: route.similarity,
          // Said in a sentence, not left to be inferred from `bodyChars: 0`.
          // A caller that does not notice this believes it recorded something
          // it did not, and the chunks ARE booked as read either way, so the
          // difference never shows up as a missing obligation later.
          discarded:
            "This record was NOT written to any note: it restates what an " +
            "existing note already says about these passages. The chunks are " +
            "booked as read. Nothing needs retrying - write a record only if " +
            "you have something the existing notes do not say, and read them " +
            "first (see `paper.episodes` from wiki_get_reading_note).",
        };

    // Durable. Only now is the reading real.
    const booked = saved.booked;
    const coverage = await sessions.coverage(session.sessionId);
    // The paper now has a real reading record, which is the trigger for
    // cross-paper candidates - not being imported, and not being returned by
    // retrieval. Queued, never awaited: this answer must not wait on a
    // full-library vector pass, and a scan that cannot start is a missing
    // suggestion rather than a lost page of reading.
    void this.links.onPaperRead(options.libraryID, itemKey);
    const refreshed = (await sessions.get(session.sessionId)) ?? session;

    // The debt is booked by `recordReadChunkIds` itself now - every newly read
    // chunk is written with owes_wiki set - so there is no separate counter to
    // keep in step, and no way for the two to disagree.
    const newlyRead = booked.newIndexes.length;
    const owedNow = await sessions.pendingWikiChunks(session.sessionId);
    const delivered = await sessions.deliveredIndexes(session.sessionId);
    return {
      itemKey,
      integrated: true,
      mode: refreshed.mode,
      readingNote: written,
      reading: {
        newChunks: booked.newIndexes,
        newChunkCount: newlyRead,
        alreadyReadChunks: booked.alreadyRead,
        // Re-reading a passage to check a quotation is normal and must not
        // inflate anything, so the two numbers are reported apart.
        alreadyReadCount: booked.alreadyRead.length,
        readChunkRanges: formatChunkRanges(delivered),
        coverageMap: formatCoverageMap(delivered, coverage.totalChunks),
        deliveredChunks: coverage.deliveredChunks,
        totalChunks: coverage.totalChunks,
        coverageComplete: coverage.complete,
        coveragePercent:
          coverage.totalChunks === 0
            ? 0
            : Math.round(
                (coverage.deliveredChunks / coverage.totalChunks) * 1000,
              ) / 10,
      },
      wikiDebt: {
        chunkIds: owedNow.map((chunk) => chunk.chunkId),
        chunkIndexes: owedNow.map((chunk) => chunk.chunkIndex),
        count: owedNow.length,
      },
      readDepthCeiling: "section_read",
      readDepthNote:
        "Evidence from this reading is stored at chunk_local or section_read. Question-driven reading " +
          "never reaches paper_reviewed however much of the paper it accumulates: that depth means the " +
          "paper was read end to end and then synthesised as a whole, which is what wiki_build_from_paper " +
          "does — and it will continue this same note and skip what you have already read.",
      nextStep:
        owedNow.length > 0
          ? `The note now accounts for ${coverage.deliveredChunks} of ${coverage.totalChunks} chunks. Update ` +
            "the Wiki from it now, before the next question: call wiki_prepare_update with what this " +
            "reading established, then wiki_commit. Update the Page, Claims, Concepts and relations that " +
            "already exist rather than creating parallel ones, and quote every Evidence excerpt from " +
            `${itemKey}'s own chunks — the note is your memory, never the source. EVERY one of chunk(s) ` +
            `${owedNow.map((chunk) => chunk.chunkId).join(", ")} has to be accounted for: either an ` +
            "Evidence excerpt quoting it, or a SKIP action naming it with a reason saying what it " +
            "establishes that the Wiki already holds. Writing up one of them does not settle the others. " +
            "Reading this paper again is refused until they are all settled."
          : "This reading adds no unsettled Wiki work. Continue with the next question.",
    };
  }

  /**
   * The reader a question read this paper as.
   *
   * Built from the `domain` and `expertRole` the retrieval call declared, not
   * invented here: those two are re-fitted to the specific paper before
   * `search_fulltext` will record the call as domain-expert retrieval, so by
   * the time a passage has been read the decision has already been made and
   * paid for. Falling back to a generic reader is allowed rather than fatal -
   * refusing here would lose a real reading over a missing label.
   */
  private questionReadingExpert(
    domain: unknown,
    expertRole: unknown,
    itemKey: string,
  ): WikiReadingExpert {
    const field = String(domain ?? "").trim();
    const role = String(expertRole ?? "").trim();
    const persona = role
      ? `${role}${field ? ` in ${field}` : ""}, reading ${itemKey} to answer specific questions about it.`
      : `A reader of ${itemKey}${field ? ` working in ${field}` : ""}, reached through questions rather than a full-text pass. Re-state this properly when the paper is read in full.`;
    return {
      persona,
      focus: [
        field || "what this paper actually establishes",
        "the questions this paper has been asked so far",
      ],
      openScopeMandate: WIKI_EXPERT_OPEN_SCOPE_MANDATE,
      createdAt: Date.now(),
      provisional: true,
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
    markdownOffset?: number;
    markdownLimit?: number;
    expectedBodyHash?: string;
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
    const attachment = item ? (session.noteKey
      ? await this.notes.getByKey(session.libraryID, session.noteKey)
      : await this.notes.findAttachment(item)) : null;
    const raw = attachment ? await this.notes.read(attachment) : null;
    const parsed = raw ? parseReadingNote(raw) : { metadata: null, body: "" };
    const coverage = await sessions.coverage(session.sessionId);
    const delivered = await sessions.deliveredIndexes(session.sessionId);
    const pendingOperation = await this.store.getNoteOperation(session.libraryID, session.itemKey);
    const markdownPage = options.includeMarkdown === false ? {} : await this.readingMarkdownPage(parsed.body, options);
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
      progress: this.noteProgress(session, coverage, delivered),
      pendingOperation: pendingOperation ? {
        kind: pendingOperation.kind, sessionId: pendingOperation.session.sessionId,
        attachmentKey: pendingOperation.session.noteKey, sourceVersion: pendingOperation.session.sourceVersion,
        ledgerDone: pendingOperation.ledgerDone ?? false, request: pendingOperation.request,
        nextStep: "Retry the original request to finish the saved operation without regenerating content.",
      } : null,
      paper: await this.paperReadingSummary(item, session, coverage.totalChunks),
      readingNote: {
        exists: Boolean(attachment),
        attachmentKey: attachment?.key ?? session.noteKey ?? "",
        bodyChars: parsed.body.length,
        metadata: parsed.metadata,
        metadataScope: "last_saved_note_snapshot",
        ...markdownPage,
      },
      nextStep: this.resumeInstruction(session, coverage),
    };
  }

  private async readingMarkdownPage(body: string, options: { markdownOffset?: number; markdownLimit?: number; expectedBodyHash?: string }): Promise<any> {
    const offset = options.markdownOffset ?? 0;
    const limit = options.markdownLimit ?? 12000;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 30000) throw new Error("Markdown pagination requires a nonnegative offset and a limit from 1 to 30000");
    const bodyHash = await hashExactText(body);
    if (offset > 0 && options.expectedBodyHash !== bodyHash) throw new Error("The reading note changed or expectedBodyHash is missing. Restart from markdownOffset 0.");
    const end = Math.min(body.length, offset + limit);
    return { markdown: body.slice(offset, end), markdownPagination: { offset, returnedChars: Math.max(0, end - offset), totalChars: body.length,
      hasMore: end < body.length, nextOffset: end < body.length ? end : null, bodyHash, tool: "wiki_get_reading_note" } };
  }

  /**
   * What is true of the PAPER, as against the episode currently being written.
   *
   * `progress` describes one episode, and that was the whole truth until a
   * concluded note could be followed by a second one. After that it became
   * actively misleading: a paper read cover to cover in episode 1 answered
   * "14 of 67 read, resume at chunk 0", the full-text macro summary sat in a
   * file this response never mentioned, and the only sane readings of that were
   * "read it again" - re-delivering 53 chunks somebody had already paid to
   * read - or "this paper is barely known".
   *
   * Deliberately compact. This rides on every call, so it carries the ranges
   * and the episode index rather than a second coverage map, and it never
   * carries a second copy of any note's text.
   */
  private async paperReadingSummary(
    item: any,
    session: WikiReadingSessionRecord,
    totalChunks: number,
  ): Promise<Record<string, unknown> | undefined> {
    if (!item) return undefined;
    let attachments: any[] = [];
    try {
      attachments = await this.notes.listAttachments(item);
    } catch (error) {
      ztoolkit.log("[wiki] could not list reading notes for the paper view", error);
      return undefined;
    }
    // One episode and nothing else is the ordinary case, and it has nothing to
    // add over `progress`. Staying silent there is what keeps this cheap.
    if (attachments.length <= 1) return undefined;

    const sessions = await this.store.readingSessions();
    const paperCoverage = await sessions.paperCoverage(
      session.libraryID,
      session.itemKey,
      totalChunks,
    );
    const delivered = await sessions.paperDeliveredIndexes(
      session.libraryID,
      session.itemKey,
    );
    const episodes: Array<Record<string, unknown>> = [];
    for (const attachment of attachments) {
      let concluded: boolean | null = null;
      let records: number | null = null;
      try {
        const raw = await this.notes.read(attachment);
        if (raw !== null) {
          const parsed = parseAppendOnlyReadingNote(parseReadingNote(raw).body);
          concluded = parsed.macroSummary !== null;
          records = parsed.records.length;
        }
      } catch {
        // An unreadable note is reported as one, not omitted: a caller that
        // cannot see it would conclude the reading it holds never happened.
      }
      episodes.push({
        episode: readingNoteEpisode(attachment),
        attachmentKey: String(attachment?.key ?? ""),
        current: String(attachment?.key ?? "") === String(session.noteKey ?? ""),
        concluded,
        records,
      });
    }

    return {
      episodes,
      readChunkRanges: formatChunkRanges(delivered),
      deliveredChunks: paperCoverage.deliveredChunks,
      totalChunks: paperCoverage.totalChunks,
      readThrough: paperCoverage.complete,
      note:
        `This paper has ${episodes.length} reading notes. \`progress\` above describes only the ` +
        `current one; these are the figures for the paper. A concluded note cannot be appended to, ` +
        `so later reading opens a new one beside it - read the earlier notes before writing, ` +
        `because what they already establish is not in the note you are extending.` +
        (paperCoverage.complete
          ? " Every chunk of this paper has already been read by some episode: do not read it through again unless the user asks, and pass an explicit offset when you need one passage back."
          : ""),
    };
  }

  /**
   * The session a call is about, checked against an optional itemKey guard.
   *
   * With a key, look that paper up in EITHER mode. Without one, it means the
   * paper holding the full-text slot, which is what it has always meant.
   *
   * The distinction matters for the refusals more than for the successes: a
   * call naming a paper that questions have been reading has to reach that
   * paper's session in order to be told what is actually wrong with it -
   * "the whole-paper synthesis is not available on a paper read by questions"
   * - rather than bouncing off "no paper is open", which is both unhelpful and
   * untrue.
   */
  private async requireOpenSession(
    libraryID: number,
    itemKey?: string,
  ): Promise<WikiReadingSessionRecord> {
    const sessions = await this.store.readingSessions();
    const requestedKey = String(itemKey ?? "").trim();
    const open = requestedKey
      ? ((await sessions.openForItem(libraryID, requestedKey)) ??
        (await sessions.getOpen(libraryID)))
      : await sessions.getOpen(libraryID);
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
  /**
   * The body of the note this reading is writing into.
   *
   * A session that already owns a note stays with it even after a later
   * episode has been opened; without that, two readings running against the
   * same paper would each append to whichever note happened to be newest.
   * Falling back to the item's latest is right for a session that has not
   * written yet, and for every caller that just wants "the current note".
   */
  private async readNoteBody(
    item: any,
    session?: WikiReadingSessionRecord,
  ): Promise<string | null> {
    const attachment = session?.noteKey
      ? await this.notes.getByKey(session.libraryID, session.noteKey)
      : await this.notes.findAttachment(item);
    if (session?.noteKey && !attachment) throw new Error(`Reading note ${session.noteKey} is unavailable; retry after restoring the attachment.`);
    if (!attachment) return null;
    const raw = await this.notes.read(attachment);
    if (raw === null) throw new Error(`Reading note ${attachment.key} could not be read; no content was replaced. Retry when the attachment is readable.`);
    if (session && !session.noteKey) session.noteKey = String(attachment.key);
    return parseReadingNote(raw).body;
  }

  /**
   * Where does this turn's reading record go?
   *
   * Three destinations, and the order between them is the rule:
   *
   *   1. The EARLIEST note that is still open and does not already cover these
   *      passages. Filling a note toward the whole paper is the point - a note
   *      that opened on every new chunk would never accumulate enough reading
   *      to be worth summarising, which is the completeness the notes exist to
   *      hold. A concluded note is skipped whatever it lacks: 全文总结
   *      synthesises every record above it and nothing may follow.
   *   2. A NEW note, when every eligible note already covers these passages and
   *      what this turn says differs from what they already say.
   *   3. No note at all, when it does not differ - the reading still reaches
   *      the ledger, so the Evidence gate and the cross-paper mustResolve check
   *      both see it; it simply earns no record of its own.
   *
   * The similarity threshold sits high on purpose, and the errors are not
   * symmetric: judging two readings the same costs a lost reading, silently,
   * while judging them different costs one mostly-redundant note that a reader
   * can see and ignore. So anything short of near-restatement opens a note, and
   * every failure - no prior discussion, no embedding service, any error at
   * all - opens one too.
   */
  private async routeReadingRecord(
    item: any,
    session: WikiReadingSessionRecord,
    chunkIds: readonly number[],
    record: string,
  ): Promise<NoteRoute<any>> {
    // I/O only. Every branch is decided in wikiNoteRouting, which is where the
    // rules can be asserted without a Zotero and without an embedding service.
    let attachments: any[] = [];
    try {
      attachments = await this.notes.listAttachments(item);
    } catch (error) {
      ztoolkit.log("[wiki] could not list reading notes", error);
      return routeFallback("the note list could not be read");
    }

    const wanted = new Set(chunkIds.map(Number));
    const notes: RoutableNote<any>[] = [];
    let unreadable = false;
    for (const attachment of attachments) {
      let body = "";
      try {
        const raw = await this.notes.read(attachment);
        if (raw === null) {
          unreadable = true;
          break;
        }
        body = parseReadingNote(raw).body;
      } catch {
        unreadable = true;
        break;
      }
      const parsed = parseAppendOnlyReadingNote(body);
      const covered = new Set<number>();
      const related: string[] = [];
      for (const entry of parsed.records) {
        let touches = false;
        for (const id of entry.chunkIds) {
          covered.add(id);
          if (wanted.has(id)) touches = true;
        }
        if (touches) related.push(entry.content);
      }
      notes.push({
        attachment,
        concluded: parsed.macroSummary !== null,
        chunkIds: covered,
        related: related.join("\n\n").trim(),
      });
    }

    if (unreadable) throw new Error("A reading note could not be read. Retry before appending content.");
    const identical = notes.find((note) => note.related === record && [...wanted].every((id) => note.chunkIds.has(id)));
    if (identical) return { ...routeBySimilarity<any>(1, getWikiNoteEpisodeSimilarity()), attachment: identical.attachment };
    const decided = routeWithoutSimilarity(notes, wanted, { unreadable });
    if (decided) return decided;

    // Only the "every note is concluded and one of them discusses these
    // passages" case gets this far, so the embedding cost is paid only where
    // the answer actually depends on it.
    try {
      const embeddingService = getEmbeddingService();
      const freshResult = await embeddingService.embed(record);
      const left = freshResult?.embedding;
      if (!left?.length) return routeFallback("no comparable embedding");
      const cosine = (right: Float32Array): number | null => {
        if (!right?.length || right.length !== left.length) return null;
        let dot = 0;
        let leftNorm = 0;
        let rightNorm = 0;
        for (let index = 0; index < left.length; index += 1) {
          dot += left[index] * right[index];
          leftNorm += left[index] * left[index];
          rightNorm += right[index] * right[index];
        }
        const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
        return denominator > 0 ? dot / denominator : 0;
      };
      let closest: number | null = null;
      // Two notes that quote the same passages often carry the same text, and
      // an identical account needs no embedding to be recognised as identical.
      const embedded = new Map<string, Float32Array | null>();
      for (const note of notes) {
        if (!note.related) continue;
        if (note.related === record) {
          closest = 1;
          break;
        }
        let prior = embedded.get(note.related);
        if (prior === undefined) {
          const priorResult = await embeddingService.embed(note.related);
          if (!sameEmbeddingSpace(priorResult.identity, freshResult.identity)) return routeFallback("embedding configuration changed");
          prior = priorResult?.embedding ?? null;
          embedded.set(note.related, prior);
        }
        const similarity = prior ? cosine(prior) : null;
        if (similarity === null) continue;
        if (closest === null || similarity > closest) closest = similarity;
      }
      return routeBySimilarity(closest, getWikiNoteEpisodeSimilarity());
    } catch (error) {
      ztoolkit.log("[wiki] could not compare this reading to the notes", error);
      return routeFallback("the comparison failed");
    }
  }

  /**
   * Is the note this reading would append to already concluded?
   *
   * A note ends with 全文总结, the synthesis of every record above it, and
   * nothing may be appended after that. So a new reading episode starts a new
   * note rather than being refused - see readingNoteAttachmentTitle.
   */
  private async noteIsConcluded(
    item: any,
    session?: WikiReadingSessionRecord,
  ): Promise<boolean> {
    const body = await this.readNoteBody(item, session);
    if (!body) return false;
    return parseAppendOnlyReadingNote(body).macroSummary !== null;
  }

  private async saveNoteIntegration(input: {
    item: any; session: WikiReadingSessionRecord; body: string; previousBody: string;
    status: WikiReadingNoteStatus; requestHash: string; finalSynthesis: boolean; unchanged: boolean;
    request: unknown;
    integratedIndexes?: number[]; readChunkIds?: number[]; documentChunks?: Array<{ chunkId: number }>;
    newUnderstanding?: boolean; write?: boolean; startNewEpisode?: boolean; attachment?: any;
  }): Promise<any> {
    const { item, session } = input;
    const attachment = input.attachment ?? (input.startNewEpisode
      ? await this.notes.createNextAttachment(item, "")
      : session.noteKey ? await this.notes.getByKey(session.libraryID, session.noteKey)
        : await this.notes.ensureAttachment(item, ""));
    if (!attachment) throw new Error("The selected reading note is unavailable; retry after restoring it.");
    const raw = await this.notes.read(attachment);
    if (raw === null) throw new Error("The selected reading note could not be read; nothing was replaced.");
    const oldBody = parseReadingNote(raw).body;
    if (input.write !== false && oldBody !== input.previousBody) {
      throw new Error("The reading note changed while this record was being prepared. Read it again and retry.");
    }
    const operation = {
      ...input, item: undefined, attachment: undefined, kind: "integration",
      session: { ...session, noteKey: String(attachment.key) },
      oldBodyHash: await hashExactText(oldBody), bodyHash: await hashExactText(input.body),
      ledgerDone: false,
    };
    await this.store.saveNoteOperation(session.libraryID, session.itemKey, operation);
    return this.resumeNoteIntegration(operation);
  }

  private async resumeNoteIntegration(operation: any): Promise<any> {
    const sessions = await this.store.readingSessions();
    const before: WikiReadingSessionRecord = operation.session;
    const session = await sessions.get(before.sessionId);
    const latest = await sessions.latestForItem(before.libraryID, before.itemKey);
    const revision = await getVectorStore().getDocumentRevision(before.itemKey, before.libraryID);
    if (!session || latest?.sessionId !== before.sessionId || session.sourceVersion !== before.sourceVersion ||
      (before.sourceVersion && revision !== before.sourceVersion)) {
      throw new Error("The reading session or source revision changed. The saved note operation requires review before recovery.");
    }
    const item = await this.requirePaperItem(before.libraryID, before.itemKey);
    const attachment = await this.notes.getByKey(before.libraryID, before.noteKey);
    if (!attachment || (attachment.parentID !== undefined && attachment.parentID !== item.id)) {
      throw new Error("The saved operation's reading-note attachment is unavailable.");
    }
    const raw = await this.notes.read(attachment);
    if (raw === null) throw new Error("The saved operation's reading note could not be read.");
    const currentHash = await hashExactText(parseReadingNote(raw).body);
    if (currentHash !== operation.oldBodyHash && currentHash !== operation.bodyHash) {
      throw new Error("The reading note changed after this operation was saved. Review its content before retrying.");
    }
    if (operation.write !== false && currentHash !== operation.bodyHash) {
      await this.writeNote(item, before, operation.body, operation.status, { attachment, expectedBody: parseReadingNote(raw).body });
    }
    if (!operation.ledgerDone) {
      assertChunkRevision(revision, await getVectorStore().getDocumentRevision(before.itemKey, before.libraryID));
      await this.store.commitBookkeeping(async () => {
        await sessions.setNoteKey(before.sessionId, before.noteKey);
        const booked = operation.readChunkIds
          ? await sessions.recordReadChunkIds(before.sessionId, operation.readChunkIds, operation.documentChunks, operation.newUnderstanding)
          : { newIndexes: [], alreadyRead: [] };
        await sessions.recordIntegration(before.sessionId, {
          unchanged: operation.unchanged,
          integratedIndexes: operation.readChunkIds
            ? (session.mode === "fulltext" ? booked.newIndexes : [...booked.newIndexes, ...booked.alreadyRead])
            : operation.integratedIndexes,
          finalSynthesis: operation.finalSynthesis,
        });
        await this.store.saveNoteOperation(before.libraryID, before.itemKey, { ...operation, ledgerDone: true, booked });
      });
      operation = await this.store.getNoteOperation(before.libraryID, before.itemKey);
    }
    const refreshed = (await sessions.get(before.sessionId))!;
    const written = operation.write !== false
      ? await this.writeNote(item, refreshed, operation.body, operation.status, { attachment, expectedBody: operation.body })
      : { attachmentKey: before.noteKey, bodyChars: parseReadingNote(raw).body.length,
          status: parseReadingNote(raw).metadata?.status ?? operation.status };
    await this.store.clearNoteOperation(before.libraryID, before.itemKey);
    return { written, refreshed, booked: operation.booked };
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
    options: { startNewEpisode?: boolean; attachment?: any | null; expectedBody?: string } = {},
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
      coverageMap: formatCoverageMap(delivered, coverage.totalChunks),
      mode: session.mode,
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
    // A session that already owns a note keeps writing to it; only the first
    // write of an episode that follows a concluded note opens a new file.
    // An explicit route wins; otherwise retain the session's pinned attachment.
    const pinned = session.noteKey && !options.startNewEpisode && !options.attachment
      ? await this.notes.getByKey(session.libraryID, session.noteKey) : null;
    if (session.noteKey && !options.startNewEpisode && !options.attachment && !pinned) {
      throw new Error(`Reading note ${session.noteKey} is unavailable; refusing to redirect this write.`);
    }
    const attachment =
      options.attachment ??
      pinned ??
      (options.startNewEpisode
        ? await this.notes.createNextAttachment(item, markdown)
        : await this.notes.ensureAttachment(item, markdown));
    if (options.expectedBody !== undefined) {
      const raw = await this.notes.read(attachment);
      if (raw === null || parseReadingNote(raw).body !== options.expectedBody) {
        throw new Error("The reading note changed before saving; retry after reading the current version.");
      }
    }
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
    authorizeWrite?: () => Promise<boolean | void>,
  ): Promise<WikiNoteStatusWriteResult> {
    return this.withNoteWrite(session.libraryID, session.itemKey, () => this.syncNoteStatusLocked(session, status, authorizeWrite));
  }

  private async syncNoteStatusLocked(
    session: WikiReadingSessionRecord,
    status: WikiReadingNoteStatus,
    authorizeWrite?: () => Promise<boolean | void>,
  ): Promise<WikiNoteStatusWriteResult> {
    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        session.libraryID,
        session.itemKey,
      );
      if (!item) return { updated: false, reason: "item_not_found" };
      const attachment = session.noteKey
        ? await this.notes.getByKey(session.libraryID, session.noteKey)
        : await this.notes.findAttachment(item);
      if (!attachment || (attachment.parentID !== undefined && attachment.parentID !== item.id)) {
        return { updated: false, reason: "reading_note_not_found" };
      }
      const raw = await this.notes.read(attachment);
      if (raw === null) return { updated: false, reason: "reading_note_not_found" };
      const body = parseReadingNote(raw).body;
      if (authorizeWrite) {
        try {
          const authorized = await authorizeWrite();
          if (authorized === false) {
            return { updated: false, reason: "not_authorized" };
          }
        } catch (error) {
          ztoolkit?.log?.(
            `[WikiService] reading note status write was not authorized for ${session.itemKey}: ${error}`,
            "warn",
          );
          return { updated: false, reason: "not_authorized" };
        }
      }
      const written = await this.writeNote(item, session, body, status, { attachment, expectedBody: body });
      return {
        updated: true,
        attachmentKey: written.attachmentKey,
        status,
      };
    } catch (error) {
      ztoolkit?.log?.(
        `[WikiService] could not stamp reading note status for ${session.itemKey}: ${error}`,
        "warn",
      );
      return { updated: false, reason: "write_failed" };
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
    delivered?: readonly number[],
  ): Record<string, unknown> {
    return {
      mode: session.mode,
      ...(delivered
        ? {
            readChunkRanges: formatChunkRanges(delivered),
            coverageMap: formatCoverageMap(delivered, coverage.totalChunks),
          }
        : {}),
      wikiReviewRecorded: session.wikiReviewAt !== null,
      deliveredChunks: coverage.deliveredChunks,
      totalChunks: coverage.totalChunks,
      remainingChunks: coverage.remainingChunks,
      coverageComplete: coverage.complete,
      nextChunk: coverage.complete
        ? null
        : (coverage.firstMissingIndex ?? coverage.deliveredChunks),
      integratedChunks: session.integratedChunks,
      deliveredProgress: { chunks: coverage.deliveredChunks, totalChunks: coverage.totalChunks, complete: coverage.complete,
        nextChunk: coverage.complete ? null : coverage.firstMissingIndex ?? coverage.deliveredChunks },
      integratedProgress: { chunks: session.integratedChunks, totalChunks: coverage.totalChunks,
        complete: session.integratedChunks >= coverage.totalChunks, pendingDeliveredChunks: Math.max(0, coverage.deliveredChunks - session.integratedChunks) },
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
    if (integrationDebt(session) > 0) {
      return "Delivered chunks still lack reading records. Call wiki_update_reading_note with a readingRecord for the outstanding fulltext batch before paging or summarizing.";
    }
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
        `with itemKey "${session.itemKey}" and offset ${resume}. Append one readingRecord after each batch ` +
        "with wiki_update_reading_note."
      );
    }
    if (session.finalSynthesisAt === null) {
      return (
        "Every chunk has been delivered but the whole-paper synthesis has not been done. Call " +
        "wiki_update_reading_note with finalSynthesis true and macroSummary. Distil the paper's core " +
        "content and methods without reproducing the reading records. Then review its terminology with " +
        "wiki_record_concepts final true."
      );
    }
    if (session.conceptsRecordedAt === null) {
      return (
        "The paper has been read and synthesised. Call wiki_record_concepts once with final true " +
        "(or an empty concepts list plus noConceptsReason). Then run the five-axis Wiki Review."
      );
    }
    if (session.wikiReviewAt === null) {
      return (
        "The paper and its terminology have been reviewed. Call wiki_prepare_update with wikiReview " +
        "covering pages, claims, evidence, concepts and relations, then call wiki_commit."
      );
    }
    return (
      "The paper synthesis, terminology pass and five-axis Wiki Review are complete. Call wiki_commit, " +
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
    const claims = await this.store.embeddingQueue();
    const concepts = await this.store.conceptEmbeddingQueue();
    const claimResult = await claims.drain(
      (unit: WikiEmbeddingWorkUnit) => this.embedQueuedClaim(unit),
      options,
    );
    const conceptResult = await concepts.drain(
      (unit: WikiEmbeddingWorkUnit) => this.embedQueuedConcept(unit),
      options,
    );
    return {
      processed: claimResult.processed + conceptResult.processed,
      succeeded: claimResult.succeeded + conceptResult.succeeded,
      failed: claimResult.failed + conceptResult.failed,
    };
  }

  /**
   * The model name to stamp on a vector, read AFTER the vector was made.
   *
   * `getConfig()` returns DEFAULT_CONFIG until `initialize()` has read the
   * user's preferences, and `embed()` is what triggers that initialization.
   * Reading the name first therefore stamped whatever the first drain after a
   * restart happened to catch: one concept was written as
   * `text-embedding-3-small` while its vector had in fact come from
   * `qwen3.7-text-embedding`, and the identity guard then rejected all 118
   * other concepts as belonging to a different embedding space - permanently,
   * since every retry hit the same wall. Concept recall was blind for a whole
   * 30-paper run because of the order of two lines.
   */
  private async embedWithModel(text: string): Promise<{
    vector: Float32Array;
    model: string;
    identity: EmbeddingIdentity;
  }> {
    const embeddingService = getEmbeddingService();
    const embedded = await embeddingService.embed(text, "auto", false);
    return {
      vector: embedded.embedding,
      model: embedded.identity.model,
      identity: embedded.identity,
    };
  }

  private async embedQueuedClaim(unit: WikiEmbeddingWorkUnit): Promise<void> {
    const { vector, model, identity } = await this.embedWithModel(unit.text);
    await this.store.saveClaimEmbedding({
      claimId: unit.id,
      vector,
      model,
      identity,
      textHash: await hashWikiText(unit.text),
    });
  }

  private async embedQueuedConcept(unit: WikiEmbeddingWorkUnit): Promise<void> {
    const { vector, model, identity } = await this.embedWithModel(unit.text);
    await this.store.saveConceptEmbedding({
      conceptId: unit.id,
      vector,
      model,
      identity,
      textHash: await hashWikiText(unit.text),
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
    signal?: AbortSignal;
  }): Promise<WikiServiceSearchResult> {
    const warnings: string[] = [];
    let queryVector: Float32Array | undefined;
    let queryVectorModel: string | undefined;
    let queryVectorIdentity: EmbeddingIdentity | undefined;
    if (options.useVector !== false) {
      try {
        const embeddingService = getEmbeddingService();
        const embedded = await embeddingService.embed(options.query, "auto", true, { signal: options.signal });
        queryVectorModel = embedded.identity.model;
        queryVectorIdentity = embedded.identity;
        queryVector = embedded.embedding;
      } catch (error) {
        warnings.push(
          `Wiki vector search unavailable; Concept/Alias/Claim/Relation keyword retrieval still ran: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (options.signal?.aborted) throw new Error("Wiki search cancelled");
    if (queryVectorIdentity) await this.store.requeueIncompatibleEmbeddings(options.libraryID, queryVectorIdentity);
    const result = await this.retriever.search({
      ...options,
      queryVector,
      queryVectorModel,
      queryVectorIdentity,
    });
    return { ...result, vectorSearchUsed: Boolean(queryVector), warnings: [...warnings, ...(result.warnings ?? [])] };
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
    // "Recheck everything" includes the concept vectors. A concept renamed or
    // rewritten through a path that does not enqueue leaves a vector that
    // still describes its old text, and nothing else in the system would ever
    // notice: recall would keep working and keep being subtly wrong.
    await this.store.resyncConceptEmbeddings(libraryID);
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
            status?.chunkSignature || getStoredChunkingSignature(sourceLibraryID) || "unknown",
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
    const evidence = await relinker.relinkPending({ libraryID, itemKeys });
    /*
     * Link signals are re-verified in the same pass, and by their OWN relinker.
     *
     * The two must run together: a reindex that relocates a Claim's Evidence
     * while leaving a candidate signal pointing at the old chunk id would give
     * one library two different opinions about where a passage lives, and the
     * signal's opinion is the dangerous one - it is offered as settleable debt.
     *
     * They cannot be the same relinker. `wikiEvidenceRelinker` writes
     * `wiki_evidence`: its columns, its unique constraint, its `link_state`
     * vocabulary and the Claim-status recomputation it triggers. A signal has
     * none of those. What they share is the locating primitive, which is now
     * `wikiChunkLocator` and is used by both.
     *
     * Best-effort: Evidence provenance is the durable thing here, and a
     * candidate that could not be re-checked stays pending and is checked
     * again next time.
     */
    let links: Awaited<ReturnType<WikiLinkService["relink"]>> | undefined;
    try {
      links = await this.links.relink({ libraryID, itemKeys });
    } catch (error) {
      ztoolkit.log("[wiki] link signal relink failed", error);
    }
    return { ...evidence, ...(links ? { linkSignals: links } : {}) };
  }

  async exportMarkdown(libraryID: number): Promise<string> {
    const [pages, snapshot, concepts] = await Promise.all([
      this.store.listPages(libraryID),
      this.store.getRetrievalSnapshot(libraryID),
      this.listConcepts(libraryID),
    ]);
    return renderWikiMarkdown(
      pages,
      snapshot,
      concepts,
      await this.nameConceptSources(concepts),
    );
  }

  /** `libraryID:itemKey` to a readable citation, for either export. */
  private async nameConceptSources(
    concepts: WikiConceptEntity[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const concept of concepts) {
      for (const term of [concept.primaryTerm, ...concept.aliasTerms]) {
        for (const source of term?.sources ?? []) {
          const key = `${source.libraryID}:${source.itemKey}`;
          if (names.has(key)) continue;
          names.set(
            key,
            await this.describeSourceItem(source.libraryID, source.itemKey),
          );
        }
      }
    }
    return names;
  }

  /** Every concept entity in the library, with its terms and their sources. */
  async listConcepts(libraryID: number): Promise<WikiConceptEntity[]> {
    const library = await this.store.concepts();
    return library.list(libraryID);
  }

  /**
   * The concept library, optionally filtered.
   *
   * The filter is matched against every field of every term, abbreviations
   * included, so looking up "DRX" finds the concept whose primary term is
   * 动态再结晶 - which is the whole point of storing the short form in its own
   * column rather than as another loose string.
   */
  async searchConcepts(options: {
    libraryID: number;
    query?: string;
    limit?: number;
  }): Promise<{ total: number; concepts: WikiConceptEntity[] }> {
    const all = await this.listConcepts(options.libraryID);
    const query = normalizeWikiName(String(options.query ?? ""));
    const matched = !query
      ? all
      : all.filter((concept) =>
          [concept.primaryTerm, ...concept.aliasTerms].some((term) =>
            term
              ? [term.zh, term.en, term.abbr].some(
                  (name) => name && normalizeWikiName(name).includes(query),
                )
              : false,
          ),
        );
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
    return { total: matched.length, concepts: matched.slice(0, limit) };
  }

  /** The concept library alone, as its own Markdown document. */
  async exportConceptsMarkdown(libraryID: number): Promise<string> {
    const concepts = await this.listConcepts(libraryID);
    return renderConceptLibraryMarkdown(
      concepts,
      await this.nameConceptSources(concepts),
    );
  }

  /** A readable name for one source document, for exports and the panel. */
  private async describeSourceItem(
    libraryID: number,
    itemKey: string,
  ): Promise<string> {
    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        libraryID,
        itemKey,
      );
      if (!item) return itemKey;
      const title = item.getDisplayTitle?.() || item.getField?.("title") || "";
      const creator = String(item.getField?.("firstCreator") ?? "");
      const year = String(item.getField?.("date") ?? "").slice(0, 4);
      const detail = [creator, year].filter(Boolean).join(" ");
      return [String(title || itemKey), detail && `(${detail})`]
        .filter(Boolean)
        .join(" ");
    } catch {
      return itemKey;
    }
  }

  /**
   * Record the concepts one reading pass recognised.
   *
   * This is the extraction entry point, and it is deliberately NOT part of
   * `CREATE_PAGE`. Concepts accumulate while a paper is actually being read
   * and analysed - which is when a reader can tell that DRX in this paper
   * means dynamic recrystallization and not something else - rather than at
   * the moment somebody decides a topic deserves a page.
   *
   * TWO MODES, separated by the whole-paper final pass:
   *
   *   - Without `final`, while a paper is open, the entities are STAGED. They
   *     are checked for shape and held on the reading session; nothing reaches
   *     the concept tables and no confirmation dialog is raised. A model may
   *     therefore note candidates as it goes without costing the user a prompt
   *     per batch, and may drop a candidate it later decides it misread simply
   *     by leaving it out of the final list.
   *   - With `final`, everything staged is combined with what this call
   *     carries and written ONCE. One write, one confirmation, one paper.
   *
   * Sources are verified as far as they were offered. The document is
   * mandatory and must exist in Zotero. An excerpt and chunk index are
   * optional; when they are supplied they are checked against the live index
   * exactly as Evidence is, and a quotation that cannot be found is dropped -
   * with a warning - rather than stored as if it had been verified. The term
   * keeps its link to the document either way, because "this paper uses this
   * term" is true whether or not a quotable line came with it.
   */
  async recordConcepts(options: {
    libraryID: number;
    concepts: WikiConceptEntityInput[];
    /** The whole-paper pass. Writes, and discharges the write-up gate. */
    final?: boolean;
    /** Required when `final` is set with nothing to write, for the reading log. */
    noConceptsReason?: string;
    itemKey?: string;
    /**
     * Raised immediately before anything is written, never for a staging call.
     * The server passes the user consent gate here so that consent is asked
     * once per paper rather than once per batch.
     */
    confirmWrite?: (conceptCount: number) => Promise<void>;
  }): Promise<any> {
    const sessions = await this.store.readingSessions();
    const requestedKey = String(options.itemKey ?? "").trim();
    const open = requestedKey
      ? await sessions.openForItem(options.libraryID, requestedKey)
      : await sessions.getOpen(options.libraryID);
    if (options.itemKey && open && options.itemKey.trim() !== open.itemKey) {
      throw new Error(
        `The open paper is ${open.itemKey}, not ${options.itemKey.trim()}.`,
      );
    }
    const defaultItemKey = options.itemKey?.trim() || open?.itemKey || "";
    const submitted = Array.isArray(options.concepts) ? options.concepts : [];

    /*
     * Source-only attachments are split off before anything else happens.
     *
     * They are the one submission that must NOT be staged. Everything else in
     * this method is shaped around the whole-paper pass - stage while reading,
     * write once at the end - and that shape is correct for naming decisions,
     * which deserve one confirmation per paper rather than one per batch. It
     * is wrong for "this paper also uses that concept": a question-driven read
     * never reaches the whole-paper pass, so a source staged during one is
     * staged forever, and the concept it would have connected keeps reading as
     * a term sourced from a single document. Five papers discussing the same
     * mechanism produced five isolated nodes exactly this way.
     *
     * They are also written on the `final` path, unchanged, so the two calls
     * mean the same thing wherever they appear.
     */
    const attachments: Array<{ index: number; entity: any }> = [];
    const entities: typeof submitted = [];
    submitted.forEach((entity, index) => {
      if (entity && (entity as any).conceptId != null) {
        attachments.push({ index, entity });
      } else {
        entities.push(entity);
      }
    });
    const attachmentResult = attachments.length
      ? await this.attachExistingConceptSources(
          options.libraryID,
          defaultItemKey,
          attachments,
        )
      : null;

    /*
     * "This reading introduced no term the library did not already hold."
     *
     * The full-text path has been able to say this since 2.4.4, through
     * `final: true` with a noConceptsReason. The question-driven path could
     * not: `final` is refused there because coverage is incomplete, so there
     * was no way to finish a reading honestly without terminology - and, with
     * nothing requiring terminology either, the answer in practice was silence.
     */
    if (
      options.final !== true &&
      open &&
      open.mode === "qa" &&
      !entities.length &&
      options.noConceptsReason?.trim()
    ) {
      const reason = options.noConceptsReason.trim();
      if (VACUOUS_WRITE_OFF_REASON.test(reason)) {
        throw new Error(
          `That reason asserts rather than argues: "${reason}". "Nothing new" is what a reader who ` +
            "looked at nothing would also say. Name the terms these passages used and which concepts " +
            "in the library already cover them.",
        );
      }
      if (reason.length < WIKI_WRITE_OFF_MIN_REASON_CHARS) {
        throw new Error(
          `A no-terminology declaration needs at least ${WIKI_WRITE_OFF_MIN_REASON_CHARS} characters. ` +
            "Say which terms this reading used and where the library already holds them, so the " +
            "judgement can be read back later.",
        );
      }
      await sessions.declareNoConcepts(open.sessionId, reason);
      return {
        declared: true,
        written: false,
        staged: 0,
        readingSession: {
          sessionId: open.sessionId,
          itemKey: open.itemKey,
          conceptPassRecorded: false,
        },
        note:
          "Recorded: this reading introduced no term the library did not already hold. " +
          "The commit that writes it up will no longer ask for terminology.",
      };
    }

    // ---- Staging: no write, no prompt ------------------------------------
    if (options.final !== true && open) {
      const stagedEntities = entities.map((entity) => ({
        ...entity,
        itemKey: defaultItemKey,
      }));
      const shapeFailures = this.inspectConceptShapes(stagedEntities);
      const stagedPreparation = await this.prepareConceptEntities(
        options.libraryID,
        stagedEntities,
        defaultItemKey,
      );
      const stagingFailures = [
        ...shapeFailures,
        ...stagedPreparation.sourceValidationFailures,
      ];
      if (stagingFailures.length) {
        throw new Error(
          `The staged concept batch is invalid: ${stagingFailures.join(" ")} Nothing was staged; correct the batch and retry.`,
        );
      }
      const totalStaged = await sessions.stageConcepts(
        open.sessionId,
        stagedEntities,
      );
      return {
        staged: entities.length,
        totalStaged,
        // Still false: no CONCEPT was written. Attached sources are reported
        // on their own keys, because "a source row landed" and "a concept was
        // created or renamed" are different events and only the second one is
        // what this flag has ever meant.
        written: false,
        ...(attachmentResult ?? {}),
        warnings: [
          ...stagedPreparation.warnings,
          ...(attachmentResult?.warnings ?? []),
        ],
        readingSession: {
          sessionId: open.sessionId,
          itemKey: open.itemKey,
          conceptPassRecorded: false,
        },
        note:
          (attachmentResult
            ? `${attachmentResult.added} source(s) were recorded immediately against ${attachmentResult.attachedConcepts.length} existing concept(s) — those are not staged, because a question-driven read never reaches the whole-paper pass. `
            : "") +
          (stagedEntities.length
            ? open.mode === "qa"
              ? "The rest is staged for this reading and is written by the next wiki_commit that " +
                "cites this paper: a question-driven read has no whole-paper pass, so the commit " +
                "is where its terminology lands. You do not need to call this again with final."
              : "The rest is held for the whole-paper pass. Call wiki_record_concepts with final " +
                "true after the paper has been read to write these, plus anything else you found, " +
                "in one go."
            : "Nothing new was staged by this call."),
      };
    }

    // A final submission is the paper's terminology pass, not merely a write
    // mode. It must use the finished whole-paper account, and this check has
    // to happen before staged concepts are drained or confirmation is raised.
    if (options.final === true && open) {
      const coverage = await sessions.coverage(open.sessionId);
      if (!coverage.complete || open.finalSynthesisAt === null) {
        throw new Error(
          `The final terminology pass for ${open.itemKey} belongs after the complete paper has been ` +
            "delivered and its whole-paper synthesis recorded. " +
            (coverage.complete
              ? "Every chunk is delivered, but finalSynthesis is still missing. "
              : `${coverage.deliveredChunks} of ${coverage.totalChunks} chunks have been delivered. `) +
            "Nothing was written, no confirmation was requested, and all staged concepts remain staged.",
        );
      }
    }

    // ---- The write -------------------------------------------------------
    const staged = open
      ? ((await sessions.readStagedConcepts(open.sessionId)) as Array<
          WikiConceptEntityInput & { itemKey?: string }
        >)
      : [];
    const combined = [...staged, ...entities];
    if (options.final && !combined.length && !options.noConceptsReason?.trim()) {
      throw new Error(
        "A final concept submission with no concepts must say why in noConceptsReason. " +
          "That this paper introduced no term the library did not already hold is a real answer; " +
          "an empty one is not.",
      );
    }
    const shapeFailures = this.inspectConceptShapes(combined);
    if (options.final === true && open && shapeFailures.length) {
      throw new Error(
        "The final concept submission contains an invalid concept: " +
          `${shapeFailures.join(" ")} Nothing was written or marked complete, and all staged concepts remain staged.`,
      );
    }
    const preparation = await this.prepareConceptEntities(
      options.libraryID,
      combined,
      defaultItemKey,
    );
    if (
      options.final === true &&
      open &&
      preparation.sourceValidationFailures.length
    ) {
      throw new Error(
        `${preparation.sourceValidationFailures.join(" ")} Nothing was written or marked complete, and all staged concepts remain staged.`,
      );
    }
    const { prepared, warnings } = preparation;
    const sourceFree = prepared.filter((entity) => {
      const sources = [
        ...(entity.sources ?? []),
        ...(entity.primaryTerm?.sources ?? []),
        ...(entity.terms ?? []).flatMap((term) => term.sources ?? []),
      ];
      return sources.length === 0;
    });
    if (sourceFree.length) {
      throw new Error(
        `${sourceFree.length} concept(s) have no real Zotero document source. ` +
          "Pass itemKey, use the paper currently open for reading, or provide a valid source itemKey on every concept. Nothing was written.",
      );
    }
    if (prepared.length) await options.confirmWrite?.(prepared.length);
    const library = await this.store.concepts();
    const result = await library.record({
      libraryID: options.libraryID,
      entities: prepared,
      ...(open
        ? {
            beforeCommit: () =>
              sessions.completeConceptSubmission(open.sessionId, {
                final: options.final === true,
                stagedConcepts: staged,
              }),
          }
        : {}),
    });
    /*
     * Names that read like a paper rather than like a term of the field.
     *
     * Reported here, at the moment they are written, because everything
     * downstream is too late: `wiki_prepare_update` shows duplicate candidates,
     * but by then these are already in the library and a concept only one paper
     * will ever use is not a duplicate of anything. Advisory by design - see
     * CONCEPT_NAME_REVIEW_UNITS for why no rule refuses them.
     */
    const written = await (
      await this.store.concepts()
    ).list(options.libraryID);
    const touched = new Set(result.conceptIds ?? []);
    const review = conceptNamesWorthReviewing(
      written
        .filter((concept: any) => touched.has(concept.conceptId))
        .map(
          (concept: any) => concept.displayName ?? concept.canonicalName ?? "",
        ),
    );
    return {
      ...result,
      ...(attachmentResult ?? {}),
      written: true,
      fromStaging: staged.length,
      warnings: [
        ...result.warnings,
        ...warnings,
        ...(attachmentResult?.warnings ?? []),
      ],
      final: options.final === true,
      ...(review.length
        ? {
            conceptNamesToReview: {
              names: review,
              note:
                "这些名字更像本篇论文的描述，而不像别的论文也会用到的领域术语——" +
                "而只有后者才可能被共用、被关联、被复用。" +
                "请检查：去掉牌号、工艺参数和「…技术/…工艺/…调控」的尾巴之后剩下的是什么，" +
                "把它作为概念，本篇具体做了什么交给 Claim 承载。" +
                "确实是领域自己的术语（如 Lomer-Cottrell 位错锁）就保留，不必改。",
            },
          }
        : {}),
      ...(open
        ? {
            readingSession: {
              sessionId: open.sessionId,
              itemKey: open.itemKey,
              conceptPassRecorded: options.final === true,
            },
          }
        : {}),
    };
  }

  /**
   * Check entities for shapes the concept store cannot persist.
   *
   * Staging rejects these before it changes the session, so a malformed
   * candidate cannot become an entry that every final retry is forced to read.
   */
  private inspectConceptShapes(entities: WikiConceptEntityInput[]): string[] {
    const warnings: string[] = [];
    for (const entity of entities) {
      const terms = [entity.primaryTerm, ...(entity.terms ?? [])].filter(
        (term): term is WikiTermInput => Boolean(term),
      );
      if (!terms.length) {
        warnings.push(
          "A concept must include a primaryTerm or at least one term.",
        );
      }
      for (const term of terms) {
        try {
          normalizeTermFields(term);
        } catch (error) {
          warnings.push(String((error as Error)?.message ?? error));
        }
      }
    }
    return warnings;
  }

  /**
   * Record this paper as another source document behind existing concepts.
   *
   * Phase 0A of the cross-paper link work, and the whole of it. The concept
   * library already knew how to hold several source documents per term; what
   * was missing was a way for that to HAPPEN during the reading that actually
   * produces the observation. A question-driven read is where a model notices
   * that the paper in front of it uses a term the library defines, and it was
   * also the one path whose concept submissions were staged into a session
   * that never closes.
   *
   * Everything here is a check rather than a courtesy, because this write
   * skips the user confirmation the ordinary concept write raises. What it may
   * do is add a row saying "this document, this chunk, this quotation". So the
   * server, not the model, establishes each of those three:
   *
   *   - the concept exists, in THIS library;
   *   - the entity carries no naming payload at all, so nothing can be founded,
   *     merged, renamed or completed through this door;
   *   - the source names the paper the call is about, and no other;
   *   - the chunk is in that paper's reading ledger, so a passage nobody read
   *     cannot become evidence that the paper uses the term;
   *   - the quotation is really in THAT chunk - not merely somewhere in the
   *     paper, which is the weaker check `prepareTermSources` settles for when
   *     it has a whole confirmed concept write to fall back on.
   *
   * Every attachment is validated before any of them is written, so a batch
   * with one bad entry writes nothing rather than half of itself.
   */
  private async attachExistingConceptSources(
    libraryID: number,
    defaultItemKey: string,
    attachments: Array<{ index: number; entity: any }>,
  ): Promise<{
    added: number;
    attachedConcepts: Array<{
      conceptId: number;
      displayName: string;
      added: number;
    }>;
    warnings: string[];
  }> {
    const where = (index: number) => `concepts[${index}]`;
    const failures: string[] = [];
    const planned: Array<{
      conceptId: number;
      sources: WikiPreparedSource[];
    }> = [];
    const sessions = await this.store.readingSessions();

    for (const { index, entity } of attachments) {
      const conceptId = Number(entity.conceptId);
      if (!Number.isInteger(conceptId) || conceptId <= 0) {
        failures.push(
          `${where(index)}: conceptId must be a positive integer; received ${JSON.stringify(entity.conceptId)}.`,
        );
        continue;
      }
      const naming = [
        entity.primaryTerm ? "primaryTerm" : "",
        Array.isArray(entity.terms) && entity.terms.length ? "terms" : "",
        String(entity.conceptType ?? "").trim() ? "conceptType" : "",
        String(entity.description ?? "").trim() ? "description" : "",
      ].filter(Boolean);
      if (naming.length) {
        failures.push(
          `${where(index)}: conceptId attaches a source to a concept that already exists, so it cannot carry ${naming.join(", ")}. ` +
            "To rename, complete or merge a concept, submit it the ordinary way - by its terms, without conceptId - and it goes through the whole-paper pass and its confirmation.",
        );
        continue;
      }
      const rawSources = Array.isArray(entity.sources) ? entity.sources : [];
      if (!rawSources.length) {
        failures.push(
          `${where(index)}: conceptId with no sources records nothing. Give the chunkIdSnapshot and the excerpt from this paper that uses the term.`,
        );
        continue;
      }
      const sources: WikiPreparedSource[] = [];
      for (let position = 0; position < rawSources.length; position += 1) {
        const source = rawSources[position] ?? {};
        const at = `${where(index)}.sources[${position}]`;
        const itemKey = String(source.itemKey ?? "").trim() || defaultItemKey;
        if (!itemKey) {
          failures.push(
            `${at}: no itemKey, and no paper is open or named on the call, so there is nothing to attach.`,
          );
          continue;
        }
        if (itemKey !== defaultItemKey) {
          failures.push(
            `${at}: names ${itemKey}, but this call is about ${defaultItemKey}. A source may only be attached for the paper being read; record the other paper while reading it.`,
          );
          continue;
        }
        const chunkId = Number(source.chunkIdSnapshot);
        if (!Number.isInteger(chunkId)) {
          failures.push(
            `${at}: chunkIdSnapshot is required and must be the integer chunkId of the passage that uses the term.`,
          );
          continue;
        }
        const excerpt = normalizeWikiText(String(source.excerpt ?? ""));
        if (!excerpt) {
          failures.push(
            `${at}: excerpt is required. A source with no quotation cannot be checked, and this write is not confirmed by anyone.`,
          );
          continue;
        }
        if (!(await sessions.hasReadChunkId(libraryID, itemKey, chunkId))) {
          failures.push(
            `${at}: chunk ${chunkId} of ${itemKey} is not in that paper's reading ledger. Attach a source only for a passage that was actually delivered and read.`,
          );
          continue;
        }
        if (!(await this.excerptIsInChunk(libraryID, itemKey, chunkId, excerpt))) {
          failures.push(
            `${at}: the quotation was not found in chunk ${chunkId} of ${itemKey}. Quote the text of that chunk itself.`,
          );
          continue;
        }
        sources.push({ libraryID, itemKey, chunkIdSnapshot: chunkId, excerpt });
      }
      if (sources.length) planned.push({ conceptId, sources });
    }

    if (failures.length) {
      throw new Error(
        `Concept source attachment refused: ${failures.join(" ")} Nothing was written; correct the batch and retry.`,
      );
    }

    const library = await this.store.concepts();
    const attachedConcepts: Array<{
      conceptId: number;
      displayName: string;
      added: number;
    }> = [];
    const warnings: string[] = [];
    let added = 0;
    for (const plan of planned) {
      const outcome = await library.attachExistingSources({
        libraryID,
        conceptId: plan.conceptId,
        sources: plan.sources,
      });
      added += outcome.added;
      attachedConcepts.push({
        conceptId: outcome.conceptId,
        displayName: outcome.displayName,
        added: outcome.added,
      });
      if (outcome.added < plan.sources.length) {
        warnings.push(
          `${plan.sources.length - outcome.added} source(s) for 「${outcome.displayName}」 were already recorded for ${defaultItemKey} and were not duplicated.`,
        );
      }
    }
    return { added, attachedConcepts, warnings };
  }

  /** Is this quotation in THIS chunk - not merely somewhere in the paper? */
  private async excerptIsInChunk(
    libraryID: number,
    itemKey: string,
    chunkId: number,
    excerpt: string,
  ): Promise<boolean> {
    try {
      const vectorStore = getVectorStore();
      await vectorStore.initialize();
      const chunks = await vectorStore.getChunksForItem(itemKey, libraryID);
      const named = chunks.find(
        (candidate) => Number(candidate.chunkId) === chunkId,
      );
      if (!named) return false;
      return normalizeWikiText(named.text).includes(excerpt);
    } catch (error) {
      ztoolkit.log("[wiki] could not verify an attached concept source", error);
      return false;
    }
  }

  private async prepareConceptEntities(
    libraryID: number,
    entities: Array<WikiConceptEntityInput & { itemKey?: string }>,
    defaultItemKey: string,
  ): Promise<{
    prepared: Array<
      WikiConceptEntityInput & { sources?: WikiPreparedSource[] }
    >;
    warnings: string[];
    sourceValidationFailures: string[];
  }> {
    const warnings: string[] = [];
    const sourceValidationFailures: string[] = [];
    const prepared: Array<
      WikiConceptEntityInput & { sources?: WikiPreparedSource[] }
    > = [];
    for (const entity of entities) {
      // A staged entity remembers which paper it was staged for, so a stretch
      // read before the reader moved on still cites the right document.
      const itemKey = String(entity.itemKey ?? "").trim() || defaultItemKey;
      const entityPrepared = {
        ...entity,
        sources: await this.prepareTermSources(
          libraryID,
          entity.sources,
          itemKey,
          warnings,
          sourceValidationFailures,
        ),
        primaryTerm: entity.primaryTerm
          ? {
              ...entity.primaryTerm,
              sources: await this.prepareTermSources(
                libraryID,
                entity.primaryTerm.sources,
                "",
                warnings,
                sourceValidationFailures,
              ),
            }
          : undefined,
        terms: await Promise.all(
          (entity.terms ?? []).map(async (term) => ({
            ...term,
            sources: await this.prepareTermSources(
              libraryID,
              term.sources,
              "",
              warnings,
              sourceValidationFailures,
            ),
          })),
        ),
      };
      await this.verifyClaimedOrigins(libraryID, entityPrepared, warnings);
      prepared.push(entityPrepared);
    }
    return { prepared, warnings, sourceValidationFailures };
  }

  /**
   * Downgrade a "quoted from the paper" claim the paper does not support.
   *
   * `origin: literature` is a factual assertion — this exact string appears in
   * the source document — and it is the one provenance value that cannot be
   * revised later: a field marked `ai` is upgraded to `literature` the day a
   * paper confirms it, and corrected outright if a paper contradicts it, but a
   * field already marked `literature` is treated as settled by every write
   * that follows. A false one is therefore permanent.
   *
   * Models mark everything `literature`. Measured on a real library: six
   * concepts, and all six declared their CHINESE name quoted from papers
   * written in English — 不连续动态再结晶 from Xie 2019, 层错能 from Zhou 2022.
   * The tool documentation already says the default is `ai` and that
   * `literature` means the text you read actually contains it; saying it again
   * would be the fourth time this session that asking has failed to work.
   *
   * So the server checks. The term's own source documents are already indexed,
   * so "does this paper contain this string" is a lookup, not a judgement. A
   * field that survives keeps `literature` and its full weight; one that does
   * not is stored as `ai`, which is what it is — the model supplied it from
   * its own knowledge, which is allowed and useful, and only the claim about
   * where it came from was wrong.
   */
  private async verifyClaimedOrigins(
    libraryID: number,
    entity: WikiConceptEntityInput & { sources?: WikiPreparedSource[] },
    warnings: string[],
  ): Promise<void> {
    const terms = [entity.primaryTerm, ...(entity.terms ?? [])].filter(
      (term): term is NonNullable<typeof term> => Boolean(term),
    );
    if (!terms.length) return;

    // One haystack per paper, built once for the whole entity.
    const haystacks = new Map<string, string>();
    const textFor = async (itemKey: string): Promise<string> => {
      const cached = haystacks.get(itemKey);
      if (cached !== undefined) return cached;
      let text = "";
      try {
        const vectorStore = getVectorStore();
        await vectorStore.initialize();
        const chunks = await vectorStore.getChunksForItem(itemKey, libraryID);
        text = normalizeWikiName(
          chunks.map((chunk) => chunk.text).join("\n"),
        );
      } catch (error) {
        ztoolkit.log("[wiki] could not read a paper to check provenance", error);
      }
      haystacks.set(itemKey, text);
      return text;
    };

    for (const term of terms) {
      const sources = [
        ...((term.sources ?? []) as WikiPreparedSource[]),
        ...((entity.sources ?? []) as WikiPreparedSource[]),
      ];
      const itemKeys = Array.from(
        new Set(sources.map((source) => String(source.itemKey)).filter(Boolean)),
      );
      if (!itemKeys.length) continue;

      const fallback = String(term.origin ?? "");
      const declared = {
        zh: String(term.origins?.zh ?? fallback),
        en: String(term.origins?.en ?? fallback),
        abbr: String(term.origins?.abbr ?? fallback),
      };
      const values = {
        zh: String(term.zh ?? "").trim(),
        en: String(term.en ?? "").trim(),
        abbr: String(term.abbr ?? "").trim(),
      };
      const corrected: Record<string, string> = { ...declared };
      let changed = false;

      for (const field of ["zh", "en", "abbr"] as const) {
        const value = values[field];
        if (!value) continue;
        if (normalizeOrigin(declared[field]) !== "literature") continue;
        const needle = normalizeWikiName(value);
        if (!needle) continue;
        let found = false;
        for (const itemKey of itemKeys) {
          if ((await textFor(itemKey)).includes(needle)) {
            found = true;
            break;
          }
        }
        if (found) continue;
        corrected[field] = "ai";
        changed = true;
        warnings.push(
          `"${value}" was submitted as quoted from ${itemKeys.join(", ")}, but none of those ` +
            "documents contains it. Stored as ai — supplied from your own knowledge — which is " +
            "allowed and can still be upgraded to literature by a paper that does state it. " +
            "A literature mark cannot be revised once stored, so it is only ever set from text.",
        );
      }
      if (!changed) continue;
      // Expanded to explicit per-field origins: a `origin` shorthand would
      // otherwise put the unverified value back on the fields just corrected.
      term.origins = corrected as typeof term.origins;
      delete (term as { origin?: string }).origin;
    }
  }

  /**
   * Verify a term's sources as far as the caller chose to specify them.
   *
   * A source with no `itemKey` is dropped; a source naming a document Zotero
   * does not have is dropped and reported. An excerpt that cannot be found in
   * that document's indexed chunks loses the excerpt and the chunk index, not
   * the source - the link to the paper still holds.
   */
  private async prepareTermSources(
    libraryID: number,
    sources: WikiTermSourceInput[] | undefined,
    defaultItemKey: string,
    warnings: string[],
    validationFailures: string[],
  ): Promise<WikiPreparedSource[]> {
    const requested = (sources ?? []).slice();
    if (!requested.length && defaultItemKey) {
      requested.push({ itemKey: defaultItemKey });
    }
    const prepared: WikiPreparedSource[] = [];
    for (const source of requested) {
      const itemKey = String(source.itemKey ?? "").trim();
      if (!itemKey) continue;
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        libraryID,
        itemKey,
      );
      if (!item || item.deleted || !item.isRegularItem?.()) {
        const warning = `Concept source ${libraryID}:${itemKey} is not a Zotero document in this library and was not recorded.`;
        warnings.push(warning);
        validationFailures.push(warning);
        continue;
      }
      const excerpt = normalizeWikiText(String(source.excerpt ?? ""));
      if (!excerpt) {
        prepared.push({
          libraryID,
          itemKey,
          chunkIdSnapshot: null,
          excerpt: "",
        });
        continue;
      }
      const located = await this.locateTermExcerpt(
        libraryID,
        itemKey,
        excerpt,
        source.chunkIdSnapshot,
      );
      if (!located) {
        warnings.push(
          `The quotation offered for ${itemKey} could not be found in its indexed chunks, so the source was kept without it. ` +
            "Quote the text of the paper itself if you want the excerpt stored.",
        );
        prepared.push({
          libraryID,
          itemKey,
          chunkIdSnapshot: null,
          excerpt: "",
        });
        continue;
      }
      prepared.push({
        libraryID,
        itemKey,
        chunkIdSnapshot: located.chunkId,
        excerpt,
      });
    }
    return prepared;
  }

  private async locateTermExcerpt(
    libraryID: number,
    itemKey: string,
    excerpt: string,
    chunkIdSnapshot: number | null | undefined,
  ): Promise<{ chunkId: number } | null> {
    try {
      const vectorStore = getVectorStore();
      await vectorStore.initialize();
      const chunks = await vectorStore.getChunksForItem(itemKey, libraryID);
      if (!chunks.length) return null;
      const named = chunks.find(
        (candidate) => candidate.chunkId === Number(chunkIdSnapshot),
      );
      if (named && normalizeWikiText(named.text).includes(excerpt)) {
        return { chunkId: named.chunkId };
      }
      const found = chunks.find((candidate) =>
        normalizeWikiText(candidate.text).includes(excerpt),
      );
      return found ? { chunkId: found.chunkId } : null;
    } catch (error) {
      ztoolkit.log("[wiki] could not verify a concept excerpt", error);
      return null;
    }
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
    libraryIDExplicit?: boolean;
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
    includeSourceText?: boolean;
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
    let cursorRevision: string | undefined;

    if (typeof options.cursor === "string" && options.cursor.trim()) {
      const cursor = decodeChunkCursor(options.cursor.trim());
      if (options.libraryIDExplicit !== false && options.libraryID !== undefined && options.libraryID !== cursor.l) {
        throw new Error("cursor and libraryID refer to different libraries. Drop the cursor to start a new reading.");
      }
      cursorRevision = cursor.r;
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
    const sourceVersion = await vectorStore.getDocumentRevision(itemKey, libraryID);
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
    assertChunkRevision(sourceVersion, await vectorStore.getDocumentRevision(itemKey, libraryID));
    if (servedFromCursor) assertChunkRevision(cursorRevision, sourceVersion);

    // Opening the session is what enforces one paper at a time. It throws
    // WikiReadingSessionConflict when a different paper is still unfinished.
    const sessions = await this.store.readingSessions();
    // Whether this paper has been read by questions before matters here and
    // nowhere else, so it is read BEFORE the session is opened - opening it
    // promotes a question session to a full-text one, which is exactly what
    // makes this the last moment the difference is visible.
    const priorSession = await sessions.openForItem(libraryID, itemKey);
    if (priorSession?.mode === "qa") {
      // Recorded on the session rather than computed here, because after this
      // call the session IS a full-text one and the question-driven reading it
      // inherited is no longer distinguishable from its own. It is worth
      // keeping: a reader resuming after a restart needs to know it is
      // continuing somebody's notes rather than starting a paper.
      await sessions.recordQuestionCarryOver(
        priorSession.sessionId,
        (await sessions.coverage(priorSession.sessionId)).deliveredChunks,
      );
    }
    const session = await sessions.startOrContinue({
      libraryID,
      itemKey,
      title,
      totalChunks: chunks.length,
      mode: "fulltext",
      sourceVersion,
    });
    const carriedOverFromQuestions = session.questionChunksCarriedOver;

    const target = {
      libraryID,
      itemKey,
      title,
      doi: String(item.getField("DOI") || ""),
      url: String(item.getField("url") || ""),
    };

    // Phase one: no considered expert, no body text. The metadata and the
    // abstract are everything needed to decide who should be reading this
    // paper, and they are all that is handed over until that decision is made.
    // A paper questions have already been probing arrives here too, carrying a
    // provisional reader assembled from a retrieval call; the deliberate one
    // is still asked for, because who reads a paper end to end is a decision
    // worth making once and making properly.
    if (!session.expert || session.expert.provisional) {
      const briefingCoverage = await sessions.coverage(session.sessionId);
      const briefingDelivered = await sessions.deliveredIndexes(
        session.sessionId,
      );
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
          deliveredChunks: briefingCoverage.deliveredChunks,
          remainingChunks: briefingCoverage.remainingChunks,
          coverageComplete: briefingCoverage.complete,
          readChunkRanges: formatChunkRanges(briefingDelivered),
          coverageMap: formatCoverageMap(briefingDelivered, chunks.length),
          blocked: "expert_required",
        },
        readingNote: {
          status: "awaiting_expert" as WikiReadingNoteStatus,
          exists: briefingCoverage.deliveredChunks > 0,
        },
        ...(carriedOverFromQuestions > 0
          ? {
              carriedOverFromQuestionAnswering: {
                chunksAlreadyRead: carriedOverFromQuestions,
                note:
                  `${carriedOverFromQuestions} chunk(s) of this paper have already been read while ` +
                  "answering questions, and there is a reading note for it. This read continues both — " +
                  "call wiki_get_reading_note to see what is already understood before you write the " +
                  "expert profile, then read only what questions never reached.",
              },
            }
          : {}),
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

    const deliveredBefore = new Set(
      await sessions.deliveredIndexes(session.sessionId),
    );

    // An explicit offset is an instruction, not a starting guess: it is how a
    // chunk gets re-read to check an excerpt against the source before that
    // excerpt becomes Evidence. It is honoured exactly, and the gap-skip below
    // is switched off for it - skipping ahead would silently hand back some
    // other part of the paper than the one that was asked for.
    let explicitOffset = false;
    if (!servedFromCursor) {
      const requested = Number(options.offset);
      // `offset: 0` is an instruction like any other - it is how the opening
      // of a paper gets re-read to quote from it - so what counts is whether
      // an offset was GIVEN, not whether it was above zero. Testing `> 0` made
      // the two indistinguishable, which was harmless only while the implicit
      // case also started at zero.
      if (options.offset !== undefined && Number.isFinite(requested) && requested >= 0) {
        offset = Math.floor(requested);
        explicitOffset = true;
      } else {
        // Resume where the reading actually stopped, not at zero. On a paper
        // questions had already been asking about, zero would spend the first
        // pages re-delivering text the note already accounts for; on a fresh
        // paper there is no first missing index below zero, so this is the old
        // behaviour exactly.
        offset =
          (await sessions.coverage(session.sessionId)).firstMissingIndex ?? 0;
      }
    }
    offset = Math.min(offset, chunks.length);

    // Which indexes this page carries.
    //
    // An explicit offset takes a plain contiguous slice, unchanged: it is the
    // re-read path, used to check an excerpt against its source before that
    // excerpt becomes Evidence, and it has to hand back exactly the stretch it
    // was asked for even when every chunk in it has been read before.
    //
    // Everything else pages over the chunks NOT YET READ. Question-driven
    // reading leaves holes rather than a clean frontier - {7, 8, 42} means the
    // gaps are 0-6, 9-41, 43-onwards - and the previous version only skipped a
    // run at the head of a page, so a lone already-read chunk in the middle of
    // the paper came back on every pass over it. Filtering the candidate list
    // instead means a page can be discontinuous, and that is the right trade:
    // the skipped text is already in the reading note WITH its chunk citations,
    // so nothing is lost, whereas re-delivering it costs a slot that could have
    // carried text nobody has seen. On a paper nobody has read this reduces to
    // exactly the old contiguous slice.
    let pageIndexes: number[];
    if (explicitOffset) {
      pageIndexes = [];
      for (
        let index = offset;
        index < chunks.length && pageIndexes.length < pageSize;
        index += 1
      ) {
        pageIndexes.push(index);
      }
    } else {
      const unread: number[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        if (!deliveredBefore.has(index)) unread.push(index);
      }
      // A cursor points at a position, and the holes it has yet to cover may
      // all lie BEHIND it - a question read the end of the paper, so paging
      // forward from the last page finds nothing while chunk 3 is still
      // unread. Wrapping to the earliest unread chunk keeps paging converging
      // on full coverage instead of stalling on an empty page.
      const ahead = unread.filter((index) => index >= offset);
      pageIndexes = (ahead.length ? ahead : unread).slice(0, pageSize);
    }

    const rows = pageIndexes.map((index) => {
      const chunk = chunks[index];
      return {
        chunkIndex: index,
        chunkId: chunk.chunkId,
        chars: chunk.text.length,
        ...(chunk.language ? { language: chunk.language } : {}),
        text: chunk.text,
      };
    });
    if (rows.length) offset = rows[0].chunkIndex;

    // The integration gate. Only NEW text is gated: re-reading a chunk already
    // delivered is how an excerpt gets checked against the source before it
    // becomes Evidence, and that must stay free.
    const carriesNewText = rows.some(
      (row) => !deliveredBefore.has(row.chunkIndex),
    );
    const debt = integrationDebt(session);
    if (carriesNewText && debt >= WIKI_MAX_OUTSTANDING_BATCHES) {
      throw new WikiReadingIntegrationRequired(
        `${debt} batch${debt === 1 ? "" : "es"} of ${itemKey} ${debt === 1 ? "has" : "have"} been ` +
          "delivered without being folded into its reading " +
          `note, and at most ${WIKI_MAX_OUTSTANDING_BATCHES} may be outstanding. Chunks are a way to ` +
          "transport the text, not a way to organise what it says: call wiki_update_reading_note with " +
          "one readingRecord for the chunks just delivered. The server appends it without changing " +
          "earlier records, and reading " +
          "resumes at chunk index " +
          `${(await sessions.coverage(session.sessionId)).firstMissingIndex ?? deliveredBefore.size}. ` +
          "If a batch genuinely changed nothing, send unchanged: true with unchangedReason instead; " +
          "consecutive no-new-content records are allowed.",
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
    // Same trigger on the full-text path. Idempotent, so a paper delivered
    // page by page enqueues once and every later page costs one SELECT.
    void this.links.onPaperRead(session.libraryID, session.itemKey);
    const [coverage, afterDelivery, deliveredAfter] = await Promise.all([
      sessions.coverage(session.sessionId),
      sessions.get(session.sessionId),
      sessions.deliveredIndexes(session.sessionId),
    ]);
    const current = afterDelivery ?? session;
    const deliveredAfterSet = new Set(deliveredAfter);

    // Where the next page starts, and whether there is one.
    //
    // A discontinuous page breaks the old arithmetic: `offset + rows.length`
    // assumed the page was a contiguous slice, so a page that skipped two
    // already-read chunks would hand back a cursor pointing two chunks short
    // and re-deliver them next time - which is the bug this whole change is
    // about, reintroduced one line later.
    //
    // `hasMore` also stops being "did we reach the end of the array". What
    // decides whether there is more to read is whether any chunk is still
    // unread, wherever it sits; a page that ends at the last chunk while
    // chunk 3 is still unread is not the end of the reading. On the explicit
    // re-read path both keep their old meaning, because that path deliberately
    // walks the paper rather than the unread set.
    const end = rows.length ? rows[rows.length - 1].chunkIndex + 1 : offset;
    const hasMore = explicitOffset
      ? end < chunks.length
      : coverage.remainingChunks > 0;
    const range = rows.length === 0 ? "none" : `${offset + 1}-${end}`;
    // What was actually handed over, when it is not a plain run. A model told
    // it received "41-60" that in fact received 41-44 and 46-60 would silently
    // mis-attribute an excerpt to chunk 45.
    const contiguous = rows.every(
      (row, index) => index === 0 || row.chunkIndex === rows[index - 1].chunkIndex + 1,
    );
    const skippedWithinPage = contiguous
      ? []
      : Array.from(
          { length: end - offset },
          (_, step) => offset + step,
        ).filter((index) => !rows.some((row) => row.chunkIndex === index));

    const existing = await this.store.prepareUpdate({
      libraryID,
      query: title || itemKey,
      limit: 20,
    });

    // Resuming includes one bounded note page; ordinary paging, including the
    // last batch, leaves note retrieval to wiki_get_reading_note.
    const includeNote = options.includeReadingNote ?? !servedFromCursor;
    const noteAttachment = current.noteKey ? await this.notes.getByKey(libraryID, current.noteKey) : await this.notes.findAttachment(item);
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
      ...(carriedOverFromQuestions > 0
        ? {
            carriedOverFromQuestionAnswering: {
              chunksAlreadyRead: carriedOverFromQuestions,
              note:
                `${carriedOverFromQuestions} chunk(s) of this paper were already read while answering ` +
                "questions, and this read continues that same session, that same reading note and that " +
                "same chunk ledger — it does not start over. Paging skips runs of text the note already " +
                "accounts for and asks only for what questions never reached. Carry the existing note " +
                "forward: reorganise and extend it, never replace it with a fresh summary, and keep the " +
                "chunk citations already in it. When every chunk has been delivered, the whole-paper " +
                "synthesis becomes available for the first time — questions could not do it — and only " +
                "then can this paper's Evidence be stored at paper_reviewed depth.",
            },
          }
        : {}),
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
                r: sourceVersion,
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
        // What has been read and what is left, as ranges rather than counts.
        // On a paper questions had already been asked of, the holes are
        // scattered and a single "resume at" index does not describe them.
        deliveredChunkIndexes: rows.map((row) => row.chunkIndex),
        ...(skippedWithinPage.length
          ? {
              skippedAlreadyReadChunkIndexes: skippedWithinPage,
              skippedNote:
                `Chunk(s) ${skippedWithinPage.join(", ")} fall inside this page's range but were left ` +
                "out because they have already been read and are accounted for in the reading note, " +
                "with their chunk citations. This page is therefore not a continuous run — read " +
                "deliveredChunkIndexes, not the range, when you attribute an excerpt to a chunk. To " +
                "see a skipped chunk again, ask for it by offset; re-reading is free.",
            }
          : {}),
        readChunkRanges: formatChunkRanges(deliveredAfter),
        unreadChunkRanges: formatChunkRanges(
          Array.from({ length: chunks.length }, (_, i) => i).filter(
            (i) => !deliveredAfterSet.has(i),
          ),
        ),
        coverageMap: formatCoverageMap(deliveredAfter, chunks.length),
      },
      chunks: options.includeSourceText
        ? await Promise.all(
            rows.map(async (row) => ({
              ...row,
              sourceText: await wikiSourceTextView(row.text),
            })),
          )
        : rows,
      readingNote: {
        exists: Boolean(noteAttachment),
        attachmentKey: noteAttachment?.key ?? current.noteKey ?? "",
        bodyChars: noteBody.length,
        ...this.noteProgress(current, coverage, deliveredAfter),
        ...(includeNote ? await this.readingMarkdownPage(noteBody, {}) : {}),
      },
      requiredSections: WIKI_RECORD_SECTIONS,
      citationGrammar: WIKI_CITATION_GUIDE,
      integrationInstruction:
        "Write one readingRecord now, as this paper's expert, containing only what the chunks just " +
        "delivered establish. DISTIL them, do not compress them: the record owes their core reasoning, " +
        "their key data and their conclusions, and someone holding only this record should be able to " +
        "reconstruct what these chunks said.\n" +
        "用中文写，术语、化学式、数值和单位保留原文形式。\n" +
        renderTemplateGuide(WIKI_RECORD_SECTIONS) +
        "\n" +
        WIKI_CITATION_GUIDE +
        "\n" +
        "「方法」「结果与结论」两栏写成连贯段落：不要一句一行，也不要用 1. 2. 或 - 分点；" +
        "一句话里可以串联多个 chunk，只要每个分句各自带引用，这不算缝合。" +
        "句子按论证顺序接续；每句仍各自引用自己的 chunk。纯数据可用 Markdown 表格。\n" +
        "TWO THINGS ARE CHECKED, and both scale with how big a page you asked for. Every chunk on this " +
        "page has to be accounted for - several lines where it carries parameters or a mechanism, a " +
        "clause where it carries little, and a chunk holding nothing still named with what it held; " +
        'consecutive ones may share a citation, written "（chunk 44-47）". All recognized ' +
        "measured values in these chunks have to appear, each with its unit and its condition: " +
        '"0.1-125 MPa" and "1750 +- 7.4 K at 21.6 kW", never "selected pressures" or "under the ' +
        'stated power". A block that names a chunk and then says only what it was ABOUT has recorded a ' +
        "table of contents. Detail is the cheap path: the audit flags a number whose condition was " +
        "dropped, so a fully conditioned value is not flagged at all. Cite their chunk ids in every factual block. The " +
        "server audits, numbers and appends it without changing earlier records; if this text corrects " +
        "an earlier entry, append a correction naming that record. Send it with wiki_update_reading_note." +
        (integrationDebt(current) >= WIKI_MAX_OUTSTANDING_BATCHES
          ? ` ${integrationDebt(current)} batch(es) are outstanding; fold them into the note before requesting another page.`
          : ""),
      coverageInstruction: coverage.complete
        ? "Every chunk of this paper has been delivered. That is delivery, not understanding: " +
          "paper_reviewed also requires a full-text reading plus its macro summary, so call " +
          "wiki_update_reading_note with finalSynthesis true and macroSummary. " +
          GATE_HINT
        : `${coverage.deliveredChunks} of ${coverage.totalChunks} chunks delivered. wiki_commit will store evidence from this paper as section_read at best until the whole paper has been delivered; keep paging with pagination.nextCursor, or submit chunk_local / section_read / partial / incomplete now.`,
      nextStep: hasMore
        ? `You have read chunks ${range} of ${chunks.length}. Record what these chunks established - every one of them, with their values and conditions - then continue with cursor set to pagination.nextCursor and nothing else changed. If this page was mostly methods, tables or results and the record could not hold what it carried, ask for fewer chunks on the next page. Continue until the whole paper is delivered; if you abandon the read instead, close it with wiki_finish_reading and outcome "skipped".`
        : `That is the whole paper: ${chunks.length} chunk(s). Append a readingRecord for this last batch, then follow the fixed completion chain: wiki_update_reading_note with finalSynthesis true and macroSummary; wiki_record_concepts with final true (or an empty list plus noConceptsReason); wiki_prepare_update with the five-axis Wiki Review and one claimVerdict per source-backed Claim; then wiki_commit. Quote Claim Evidence from these chunks rather than from the note. If you decide not to write it up, close it with wiki_finish_reading and outcome "skipped".`,
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
