/**
 * The per-paper reading session: the server's own record of what a model was
 * actually shown, and of which paper is currently open.
 *
 * Two problems made this necessary, and they are the same problem seen from
 * two sides.
 *
 * `wiki_build_from_paper` used to be stateless. It handed back chunks and
 * forgot the call, so nothing prevented a model from starting paper B, C and D
 * while paper A had never been committed - which is exactly what happened: a
 * batch run read six papers and wrote none of them, and the server could not
 * have noticed. The state machine below closes that: `startOrContinue` refuses
 * to open a second paper while one is unfinished, and the refusal names the
 * open paper and how to close it.
 *
 * `paper_reviewed` had the same shape of hole. It was accepted purely because
 * the model said so; a claim citing one chunk of a 181-chunk paper was stored
 * at full-paper depth. The chunk ledger fixes that without pretending to
 * measure comprehension: it records which chunk indexes were actually
 * DELIVERED, and `coverage()` reports whether delivery covered the document.
 * That is a claim the server can prove, and it is the strongest one available.
 *
 * Since the reading-note pass, the session carries the reading itself as well
 * as the paging: the paper's one expert profile, the attachment holding the
 * Markdown note, and the batch ledger that says whether what has been
 * delivered has actually been folded into that note. Those three are what let
 * a read survive a restart or a compaction - the note holds the understanding,
 * this row holds where the understanding got to - and what let
 * `paper_reviewed` mean more than "every chunk was transmitted".
 *
 * State machine:
 *
 *     (none) --start--> reading --prepare--> prepared
 *                        ^                        |
 *                        |                        +-- commit, coverage COMPLETE --> committed
 *                        |                        |
 *                        +-- commit, coverage INCOMPLETE (partial write kept)
 *                        |
 *                        +----------- skip -----------> skipped  (read, not written up)
 *                        +----------- fail -----------> failed
 *
 * `committed`, `skipped` and `failed` are terminal and free the library for the
 * next paper. `skipped` is a first-class outcome, not an error: reading a paper
 * and deciding it is not worth writing up is a legitimate way to finish.
 *
 * A commit only ENDS the paper when every chunk has been delivered. Committing
 * what has been read so far is encouraged - partial evidence is real evidence,
 * and losing it to a crash helps nobody - but it is a checkpoint, not a
 * conclusion, so the session returns to `reading` and keeps the library. Any
 * other rule would let a model bank one claim from page 3 of a 181-chunk paper
 * and move on, which is the batch-run failure this state machine exists to
 * prevent. The only ways to release a paper early are the explicit ones:
 * `skipped` or `failed`.
 */

import type { WikiDatabase } from "./wikiTypes";
import { rowColumn } from "./wikiRow";
import type { WikiReadingExpert } from "./wikiReadingNote";

/**
 * How many delivered batches may be waiting to be folded into the reading
 * note before the next batch is refused.
 *
 * Zero would mean a model that judged one page to contain nothing new still
 * had to resubmit the whole note to move on, which buys nothing and costs a
 * full document every page. Unbounded is the old behaviour: page to the end,
 * then write one summary from whatever survived in context - the thing this
 * whole mechanism exists to stop.
 *
 * One outstanding batch is the slack. A reader may be a batch behind when it
 * asks for more; asking again while two are outstanding is refused, and any
 * integration clears the whole backlog because the note is rewritten as a
 * whole and therefore covers everything delivered so far.
 */
export const WIKI_MAX_OUTSTANDING_BATCHES = 1;

export const WIKI_READING_STATES = [
  "reading",
  "prepared",
  "committed",
  "skipped",
  "failed",
] as const;

export type WikiReadingState = (typeof WIKI_READING_STATES)[number];

export const WIKI_READING_MODES = ["fulltext", "qa"] as const;

/**
 * How a session is reading its paper.
 *
 * `fulltext` is a `wiki_build_from_paper` read: it holds the library's one
 * reading slot, it is the only mode that can do the whole-paper synthesis, and
 * therefore the only one that can ever reach `paper_reviewed`.
 *
 * `qa` is the reading a question produces. A user asks something, retrieval
 * finds passages in three papers, the model actually reads a handful of them
 * and answers. Those chunks are real reading and belong in the paper's note,
 * so they get a session - but a question is not a review of a paper, and the
 * two differ in exactly two ways: a `qa` session takes no exclusive lock
 * (several are open at once, because one question routinely spans several
 * papers), and its coverage never buys whole-paper depth no matter how many
 * scattered chunks accumulate. Reading all 181 chunks of a paper three at a
 * time across sixty questions is still not the act `paper_reviewed` names.
 *
 * The two are not separate ledgers. A `qa` session is PROMOTED to `fulltext`
 * when `wiki_build_from_paper` opens that paper, keeping the chunks it has
 * already read and the note it has already written; see `startOrContinue`.
 */
export type WikiReadingMode = (typeof WIKI_READING_MODES)[number];

/** States in which a session still owns the library. */
export const WIKI_OPEN_READING_STATES: readonly WikiReadingState[] = [
  "reading",
  "prepared",
];

export type WikiReadingOutcome = Extract<
  WikiReadingState,
  "committed" | "skipped" | "failed"
>;

/**
 * The outcomes a caller may ask for directly.
 *
 * `committed` is deliberately NOT one of them. It is reached only by a commit
 * whose paper was fully delivered, so it cannot be asserted from outside - that
 * keeps "committed means the whole paper was read" true of the service, not
 * merely of the MCP handler that happens to validate the argument today.
 *
 * `failed` means the paper cannot be read at all - a missing attachment, a
 * corrupt index, a user giving up on it. It is NOT for a transient paging,
 * network or tool error: nothing in the server sets it automatically, because
 * releasing a paper on a retryable hiccup is exactly how a batch run silently
 * skips a paper. A failed page read leaves the session untouched, so the next
 * call resumes where it left off.
 */
export type WikiReadingAbandonOutcome = Extract<
  WikiReadingOutcome,
  "skipped" | "failed"
>;

export interface WikiReadingSessionRecord {
  sessionId: number;
  libraryID: number;
  itemKey: string;
  title: string;
  totalChunks: number;
  state: WikiReadingState;
  startedAt: number;
  updatedAt: number;
  closedAt: number | null;
  note: string;
  /** The one expert profile for this paper, or null before it is generated. */
  expert: WikiReadingExpert | null;
  /** Zotero key of the Markdown reading-note attachment. */
  noteKey: string;
  /** Batches of NEW chunks handed over. Re-reads do not count. */
  deliveredBatches: number;
  /** Batches the model has folded into the note. */
  integratedBatches: number;
  /** Chunks covered by the note as of the last integration. */
  integratedChunks: number;
  /** The last integration said "nothing to change" rather than rewriting. */
  lastIntegrationUnchanged: boolean;
  /** When the whole-paper rewrite was done. null until the paper is read. */
  finalSynthesisAt: number | null;
  /**
   * When the paper's whole-paper concept list was submitted. null until it is.
   *
   * The write-up gate reads this: a paper that has been delivered in full and
   * synthesised still owes one deliberate pass over the terminology it
   * established before its claims may be written. Recorded on the session
   * rather than derived from the term rows because "this paper contributed no
   * new concepts" is a real, and common, answer that leaves no rows behind.
   */
  conceptsRecordedAt: number | null;

  /**
   * Concept candidates noticed part-way through, waiting for the whole-paper
   * pass to write them.
   *
   * Held here rather than written on arrival so that reading one paper costs
   * ONE database write and one confirmation instead of one per batch. It also
   * makes the mid-reading calls cheap enough to be honest: a term the model
   * later decides it misread can simply be left out of the final list, whereas
   * a term already written would have to be corrected.
   */
  stagedConcepts: unknown[];

  /** Full-text read, or the incremental reading a question produced. */
  mode: WikiReadingMode;

  /**
   * When the whole-Wiki review was submitted, and what it said.
   *
   * The final synthesis rewrites the NOTE as one account of the paper, and
   * `conceptsRecordedAt` covers the terminology. Neither of them looks at the
   * Wiki that was built incrementally while the paper was being read: whether
   * a Page needs adjusting, whether two Claims written six questions apart are
   * really one Claim, whether Evidence gathered at `chunk_local` can now carry
   * full-paper depth, whether the relations drawn early still hold. That pass
   * is the last gate before the write-up, and it is recorded here so a retry
   * does not have to submit it twice.
   */
  wikiReviewAt: number | null;
  wikiReview: WikiWholeWikiReview | null;

  /**
   * Chunks this session had read as a question-driven read before a full-text
   * read took it over.
   *
   * Kept because the promotion erases the evidence of itself: afterwards the
   * session is a full-text one and the reading it inherited looks like its
   * own. A reader coming back to the paper - after a restart, after a
   * compaction - needs to know it is continuing an existing note rather than
   * opening a fresh paper, and this is the only thing that still says so.
   */
  questionChunksCarriedOver: number;
}

/**
 * The five axes of the post-synthesis Wiki review.
 *
 * Every axis must be answered. "Nothing to change here, because ..." is a
 * perfectly good answer and is the commonest one; what is not allowed is
 * silence, because silence is indistinguishable from not having looked.
 */
export interface WikiWholeWikiReview {
  pages: string;
  claims: string;
  evidence: string;
  concepts: string;
  relations: string;
}

export const WIKI_REVIEW_AXES = [
  "pages",
  "claims",
  "evidence",
  "concepts",
  "relations",
] as const;

/** Minimum characters per axis. Long enough to exclude "ok" and "n/a". */
export const WIKI_REVIEW_MIN_AXIS_CHARS = 20;

function parseWikiReview(raw: unknown): WikiWholeWikiReview | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const review: Record<string, string> = {};
    for (const axis of WIKI_REVIEW_AXES) {
      review[axis] = String((parsed as Record<string, unknown>)[axis] ?? "");
    }
    return review as unknown as WikiWholeWikiReview;
  } catch {
    return null;
  }
}

/** The staging buffer, tolerant of a row written before it existed. */
function parseStagedConcepts(raw: unknown): unknown[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Delivered batches not yet folded into the note. */
export function integrationDebt(session: {
  deliveredBatches: number;
  integratedBatches: number;
}): number {
  return Math.max(0, session.deliveredBatches - session.integratedBatches);
}

function parseExpert(raw: unknown): WikiReadingExpert | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as WikiReadingExpert)
      : null;
  } catch {
    return null;
  }
}

export interface WikiReadingCoverage {
  totalChunks: number;
  deliveredChunks: number;
  remainingChunks: number;
  /** Every chunk of the document has been delivered at least once. */
  complete: boolean;
  /** Lowest index never delivered, or null when complete. Where to resume. */
  firstMissingIndex: number | null;
}

function mapSession(row: any): WikiReadingSessionRecord {
  const closedAt = rowColumn(row, "closed_at", "closedAt");
  const finalSynthesisAt = rowColumn(
    row,
    "final_synthesis_at",
    "finalSynthesisAt",
  );
  const conceptsRecordedAt = rowColumn(
    row,
    "concepts_recorded_at",
    "conceptsRecordedAt",
  );
  const wikiReviewAt = rowColumn(row, "wiki_review_at", "wikiReviewAt");
  return {
    sessionId: Number(rowColumn(row, "session_id", "sessionId")),
    libraryID: Number(rowColumn(row, "library_id", "libraryID")),
    itemKey: String(rowColumn(row, "item_key", "itemKey")),
    title: String(rowColumn(row, "title", "title") ?? ""),
    totalChunks: Number(rowColumn(row, "total_chunks", "totalChunks")),
    state: String(rowColumn(row, "state", "state")) as WikiReadingState,
    startedAt: Number(rowColumn(row, "started_at", "startedAt")),
    updatedAt: Number(rowColumn(row, "updated_at", "updatedAt")),
    closedAt: closedAt == null ? null : Number(closedAt),
    note: String(rowColumn(row, "note", "note") ?? ""),
    expert: parseExpert(rowColumn(row, "expert", "expert")),
    noteKey: String(rowColumn(row, "note_key", "noteKey") ?? ""),
    deliveredBatches: Number(
      rowColumn(row, "delivered_batches", "deliveredBatches") ?? 0,
    ),
    integratedBatches: Number(
      rowColumn(row, "integrated_batches", "integratedBatches") ?? 0,
    ),
    integratedChunks: Number(
      rowColumn(row, "integrated_chunks", "integratedChunks") ?? 0,
    ),
    lastIntegrationUnchanged:
      Number(
        rowColumn(
          row,
          "last_integration_unchanged",
          "lastIntegrationUnchanged",
        ) ?? 0,
      ) === 1,
    finalSynthesisAt:
      finalSynthesisAt == null ? null : Number(finalSynthesisAt),
    conceptsRecordedAt:
      conceptsRecordedAt == null ? null : Number(conceptsRecordedAt),
    stagedConcepts: parseStagedConcepts(
      rowColumn(row, "staged_concepts", "stagedConcepts"),
    ),
    mode: normalizeMode(rowColumn(row, "mode", "mode")),
    wikiReviewAt: wikiReviewAt == null ? null : Number(wikiReviewAt),
    wikiReview: parseWikiReview(rowColumn(row, "wiki_review", "wikiReview")),
    questionChunksCarriedOver: Number(
      rowColumn(
        row,
        "question_chunks_carried_over",
        "questionChunksCarriedOver",
      ) ?? 0,
    ),
  };
}

/** A row written before the column existed reads as a full-text read. */
function normalizeMode(raw: unknown): WikiReadingMode {
  const text = String(raw ?? "").trim();
  return text === "qa" ? "qa" : "fulltext";
}

const OPEN_STATE_SQL = `state IN ('reading','prepared')`;

export class WikiReadingSessions {
  private readonly db: WikiDatabase;

  constructor(db: WikiDatabase) {
    this.db = db;
  }

  /**
   * The FULL-TEXT session that currently owns this library, if any.
   *
   * Deliberately blind to question-driven sessions. Everything that asks "what
   * is open" is really asking "which paper holds the reading slot", and a `qa`
   * session holds nothing: a question that read three papers must not make any
   * of them look like the paper someone is in the middle of reviewing, or the
   * next `wiki_build_from_paper` would be refused for a paper nobody opened.
   * Use `openForItem` to find a specific paper's session in either mode.
   */
  async getOpen(libraryID: number): Promise<WikiReadingSessionRecord | null> {
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_reading_sessions
       WHERE library_id = ? AND ${OPEN_STATE_SQL} AND mode = 'fulltext'
       ORDER BY session_id DESC LIMIT 1`,
      [libraryID],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  /** The open session for one paper, in whichever mode it is reading. */
  async openForItem(
    libraryID: number,
    itemKey: string,
  ): Promise<WikiReadingSessionRecord | null> {
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_reading_sessions
       WHERE library_id = ? AND item_key = ? AND ${OPEN_STATE_SQL}
       ORDER BY session_id DESC LIMIT 1`,
      [libraryID, itemKey],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  /** Every open session in the library, both modes. Newest first. */
  async listOpen(libraryID: number): Promise<WikiReadingSessionRecord[]> {
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_reading_sessions
       WHERE library_id = ? AND ${OPEN_STATE_SQL}
       ORDER BY session_id DESC`,
      [libraryID],
    );
    return rows.map(mapSession);
  }

  /**
   * Open sessions whose reading has not been written into the Wiki yet.
   *
   * What the "MD first, Wiki second" rule reports on: after a round of
   * questions these are the papers whose notes have moved ahead of the Wiki,
   * and the next commit is expected to cite them.
   */
  async listPendingWiki(
    libraryID: number,
  ): Promise<
    Array<{ session: WikiReadingSessionRecord; pendingChunkIds: number[] }>
  > {
    const rows = await this.db.queryAsync(
      `SELECT s.* FROM wiki_reading_sessions s
       WHERE s.library_id = ? AND s.${OPEN_STATE_SQL}
         AND EXISTS (
           SELECT 1 FROM wiki_reading_chunks c
           WHERE c.session_id = s.session_id
             AND c.owes_wiki = 1 AND c.settled_at IS NULL
         )
       ORDER BY s.session_id`,
      [libraryID],
    );
    const pending = [];
    for (const row of rows) {
      const session = mapSession(row);
      pending.push({
        session,
        pendingChunkIds: (await this.pendingWikiChunks(session.sessionId)).map(
          (chunk) => chunk.chunkId,
        ),
      });
    }
    return pending;
  }

  async get(sessionId: number): Promise<WikiReadingSessionRecord | null> {
    const rows = await this.db.queryAsync(
      "SELECT * FROM wiki_reading_sessions WHERE session_id = ?",
      [sessionId],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  /**
   * Open a session for `itemKey`, or return - promoting if necessary - the one
   * already open for it.
   *
   * Three cases, and the middle one is the point of the whole mode split:
   *
   *   - Nothing open for this paper: a session is created in the asked-for
   *     mode.
   *   - A session already open for this paper: it is CONTINUED. If questions
   *     had already read part of the paper and a full-text read now starts,
   *     that same session is promoted from `qa` to `fulltext` - chunk ledger,
   *     note and expert all carry over, so `wiki_build_from_paper` picks up
   *     where the questions left off instead of re-reading what was read.
   *   - A DIFFERENT paper holds the full-text slot and this call wants that
   *     slot: refused, with the open paper's key and both ways out, because
   *     the caller is a model that has to pick a recovery without asking
   *     anyone. A `qa` request is never refused: it takes no slot.
   */
  async startOrContinue(options: {
    libraryID: number;
    itemKey: string;
    title: string;
    totalChunks: number;
    /** Defaults to `fulltext`, which is what every pre-2.5.0 caller meant. */
    mode?: WikiReadingMode;
  }): Promise<WikiReadingSessionRecord> {
    const mode: WikiReadingMode = options.mode ?? "fulltext";
    const existing = await this.openForItem(options.libraryID, options.itemKey);
    if (existing) {
      // Promotion is one-way. A full-text read subsumes whatever a question
      // read, so `qa` -> `fulltext` carries everything over; the reverse would
      // silently downgrade a paper under review and is never done.
      if (mode === "fulltext" && existing.mode === "qa") {
        const blocking = await this.getOpen(options.libraryID);
        if (blocking && blocking.itemKey !== options.itemKey) {
          throw await this.conflict(blocking, options.itemKey);
        }
        await this.db.queryAsync(
          `UPDATE wiki_reading_sessions SET mode = 'fulltext', updated_at = ?
           WHERE session_id = ?`,
          [Date.now(), existing.sessionId],
        );
        existing.mode = "fulltext";
      }
      return this.continueExisting(existing, options.totalChunks);
    }
    if (mode === "fulltext") {
      const open = await this.getOpen(options.libraryID);
      if (open) throw await this.conflict(open, options.itemKey);
    }
    const now = Date.now();
    await this.db.queryAsync(
      `INSERT INTO wiki_reading_sessions
       (library_id, item_key, title, total_chunks, state, started_at, updated_at, mode)
       VALUES (?, ?, ?, ?, 'reading', ?, ?, ?)`,
      [
        options.libraryID,
        options.itemKey,
        options.title,
        options.totalChunks,
        now,
        now,
        mode,
      ],
    );
    const opened = await this.openForItem(options.libraryID, options.itemKey);
    if (!opened) throw new Error("Failed to open a Wiki reading session");
    return opened;
  }

  /** The refusal raised when another paper holds the full-text slot. */
  private async conflict(
    open: WikiReadingSessionRecord,
    wantedKey: string,
  ): Promise<WikiReadingSessionConflict> {
    const coverage = await this.coverage(open.sessionId);
    return new WikiReadingSessionConflict(
      `Paper ${open.itemKey} is still open in this library (state: ${open.state}, ` +
        `${coverage.deliveredChunks} of ${coverage.totalChunks} chunks read). ` +
        `Finish it before starting ${wantedKey}. Two ways: read it to the end with ` +
        `wiki_build_from_paper` +
        (coverage.firstMissingIndex === null
          ? ""
          : ` (resume at chunk index ${coverage.firstMissingIndex})`) +
        ` and then commit it — a commit only closes a paper once every chunk has been ` +
        `delivered, so committing partway through keeps it open — or close it deliberately ` +
        `with wiki_finish_reading, itemKey "${open.itemKey}", outcome "skipped". ` +
        `Answering a QUESTION about ${wantedKey} is not blocked by this: retrieval followed by ` +
        `wiki_update_reading_note with readChunkIds reads it incrementally and takes no slot.`,
      open,
    );
  }

  /**
   * Continue a session already open for this paper.
   *
   * Split out of `startOrContinue` when promotion arrived: "the chunk total
   * changed underneath the reader" has to be handled identically whether the
   * session was found, promoted, or continued in the mode it was already in.
   */
  private async continueExisting(
    open: WikiReadingSessionRecord,
    totalChunks: number,
  ): Promise<WikiReadingSessionRecord> {
    if (open.totalChunks === totalChunks) return open;
    // A re-chunked document invalidates what "delivered" meant, and with it
    // every count derived from delivery: the batch ledger, how much of the
    // paper the note covers, the whole-paper synthesis - made from text that
    // no longer maps onto these chunks - and the Wiki review done over it. The
    // note's BODY is kept, because the reading it records is still a reading
    // of this paper, but its coverage claim restarts from zero.
    await this.db.queryAsync(
      `UPDATE wiki_reading_sessions
       SET total_chunks = ?, updated_at = ?, delivered_batches = 0,
           integrated_batches = 0, integrated_chunks = 0,
           last_integration_unchanged = 0, final_synthesis_at = NULL,
           concepts_recorded_at = NULL, staged_concepts = '',
           wiki_review_at = NULL, wiki_review = ''
       WHERE session_id = ?`,
      [totalChunks, Date.now(), open.sessionId],
    );
    await this.db.queryAsync(
      "DELETE FROM wiki_reading_chunks WHERE session_id = ?",
      [open.sessionId],
    );
    return {
      ...open,
      totalChunks,
      deliveredBatches: 0,
      integratedBatches: 0,
      integratedChunks: 0,
      lastIntegrationUnchanged: false,
      finalSynthesisAt: null,
      conceptsRecordedAt: null,
      stagedConcepts: [],
      wikiReviewAt: null,
      wikiReview: null,
    };
  }

  /**
   * Record that these chunk indexes were handed to the model.
   *
   * A batch counts against the note only when it carried text the model had
   * not seen. Re-reading a chunk is a normal and necessary thing to do - it is
   * how an excerpt is checked against the source before it becomes Evidence -
   * and charging it as a batch would make verifying a claim after the final
   * synthesis push the reader straight into the integration gate.
   *
   * @returns how many of these indexes were new, and the batch counter after.
   */
  async recordDelivery(
    sessionId: number,
    chunks: Array<{ chunkIndex: number; chunkId: number }>,
  ): Promise<{ newChunks: number; deliveredBatches: number }> {
    const session = await this.get(sessionId);
    const deliveredBefore = session?.deliveredBatches ?? 0;
    if (!chunks.length) {
      return { newChunks: 0, deliveredBatches: deliveredBefore };
    }
    const known = new Set(await this.deliveredIndexes(sessionId));
    const newChunks = chunks.filter(
      (chunk) => !known.has(Number(chunk.chunkIndex)),
    ).length;
    const now = Date.now();
    for (const chunk of chunks) {
      await this.db.queryAsync(
        `INSERT INTO wiki_reading_chunks (session_id, chunk_index, chunk_id, delivered_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, chunk_index) DO UPDATE SET
           chunk_id = excluded.chunk_id,
           delivered_at = excluded.delivered_at`,
        [sessionId, chunk.chunkIndex, chunk.chunkId, now],
      );
    }
    const deliveredBatches = deliveredBefore + (newChunks > 0 ? 1 : 0);
    await this.db.queryAsync(
      `UPDATE wiki_reading_sessions SET updated_at = ?, delivered_batches = ?
       WHERE session_id = ?`,
      [now, deliveredBatches, sessionId],
    );
    return { newChunks, deliveredBatches };
  }

  /**
   * Record chunks a question actually READ, by chunk id rather than position.
   *
   * The difference from `recordDelivery` is what the caller knows. Paging hands
   * over a contiguous run and knows every index in it; a question hands over
   * whichever passages retrieval surfaced and the model then genuinely used,
   * and knows them only by the `chunkId` that `search_fulltext` printed. The
   * ids are resolved against the document's real chunk list here, so an id that
   * belongs to another paper - or to no paper - is reported rather than
   * silently counted as reading.
   *
   * No batch is charged. A question integrates its reading into the note in the
   * same turn, so there is never a delivery waiting to be folded in, and
   * charging one would make the very next question fail the integration gate.
   *
   * @returns which ids were new, which were already read, and which were not
   *   chunks of this document at all.
   */
  async recordReadChunkIds(
    sessionId: number,
    chunkIds: readonly number[],
    documentChunks: ReadonlyArray<{ chunkId: number }>,
  ): Promise<{
    newIndexes: number[];
    alreadyRead: number[];
    unknownChunkIds: number[];
  }> {
    const indexByChunkId = new Map<number, number>();
    documentChunks.forEach((chunk, index) => {
      indexByChunkId.set(Number(chunk.chunkId), index);
    });
    const known = new Set(await this.deliveredIndexes(sessionId));
    const newIndexes: number[] = [];
    const alreadyRead: number[] = [];
    const unknownChunkIds: number[] = [];
    const seen = new Set<number>();
    for (const raw of chunkIds) {
      const chunkId = Number(raw);
      const index = indexByChunkId.get(chunkId);
      if (index === undefined) {
        unknownChunkIds.push(chunkId);
        continue;
      }
      // A repeat inside ONE call is as much a duplicate as a repeat across
      // calls, and neither may inflate coverage.
      if (seen.has(index)) continue;
      seen.add(index);
      if (known.has(index)) {
        alreadyRead.push(index);
        continue;
      }
      newIndexes.push(index);
    }
    if (newIndexes.length || alreadyRead.length) {
      const now = Date.now();
      for (const index of newIndexes) {
        const chunk = documentChunks[index];
        // A NEW chunk owes the Wiki. Re-reading one already read does not:
        // checking a passage against the source before quoting it is not new
        // knowledge, and charging it would mean a paper could never be quoted
        // from twice without a Claim in between.
        await this.db.queryAsync(
          `INSERT INTO wiki_reading_chunks
             (session_id, chunk_index, chunk_id, delivered_at, owes_wiki)
           VALUES (?, ?, ?, ?, 1)
           ON CONFLICT(session_id, chunk_index) DO UPDATE SET
             chunk_id = excluded.chunk_id,
             delivered_at = excluded.delivered_at,
             owes_wiki = 1`,
          [sessionId, index, Number(chunk.chunkId), now],
        );
      }
      for (const index of alreadyRead) {
        await this.db.queryAsync(
          `UPDATE wiki_reading_chunks SET delivered_at = ?
           WHERE session_id = ? AND chunk_index = ?`,
          [now, sessionId, index],
        );
      }
      await this.db.queryAsync(
        "UPDATE wiki_reading_sessions SET updated_at = ? WHERE session_id = ?",
        [now, sessionId],
      );
    }
    return {
      newIndexes: newIndexes.sort((a, b) => a - b),
      alreadyRead: alreadyRead.sort((a, b) => a - b),
      unknownChunkIds,
    };
  }

  /** Has this chunk id been read for this paper, in either mode? */
  async hasReadChunkId(
    libraryID: number,
    itemKey: string,
    chunkId: number,
  ): Promise<boolean> {
    const found = await this.db.valueQueryAsync(
      `SELECT 1 FROM wiki_reading_chunks c
       JOIN wiki_reading_sessions s ON s.session_id = c.session_id
       WHERE s.library_id = ? AND s.item_key = ? AND c.chunk_id = ?
       LIMIT 1`,
      [libraryID, itemKey, chunkId],
    );
    return found != null;
  }

  /**
   * The chunks of this session that still owe the Wiki something.
   *
   * Ascending by index, each with the chunk id the model would quote. This is
   * the debt: not a number, but a named list, because "which of the five
   * things I read has been written up" is the only version of the question
   * that can be answered honestly. A count could be discharged by one Claim;
   * a list has to be gone through.
   */
  async pendingWikiChunks(
    sessionId: number,
  ): Promise<Array<{ chunkIndex: number; chunkId: number }>> {
    const rows = await this.db.queryAsync(
      `SELECT chunk_index, chunk_id FROM wiki_reading_chunks
       WHERE session_id = ? AND owes_wiki = 1 AND settled_at IS NULL
       ORDER BY chunk_index`,
      [sessionId],
    );
    return rows.map((row) => ({
      chunkIndex: Number(rowColumn(row, "chunk_index", "chunkIndex")),
      chunkId: Number(rowColumn(row, "chunk_id", "chunkId")),
    }));
  }

  /**
   * Mark chunks as having had their turn at the Wiki.
   *
   * `kind` says how, and both are legitimate. `evidence` means the chunk was
   * quoted into a Claim. `no_update` means the reader looked at what it read,
   * compared it with what the Wiki already holds, and concluded there was
   * nothing to add, correct or merge - which is a real and common conclusion,
   * and is accepted on the condition that it is argued rather than asserted.
   *
   * Only chunks that actually owe something are touched, so settling a chunk
   * twice, or settling one a full-text read delivered, is a no-op rather than
   * an error.
   */
  async settleWikiChunks(
    sessionId: number,
    chunkIds: readonly number[],
    kind: "evidence" | "no_update",
    reason = "",
  ): Promise<number[]> {
    if (!chunkIds.length) return [];
    const now = Date.now();
    const settled: number[] = [];
    for (const raw of chunkIds) {
      const chunkId = Number(raw);
      const owed = await this.db.valueQueryAsync(
        `SELECT chunk_index FROM wiki_reading_chunks
         WHERE session_id = ? AND chunk_id = ? AND owes_wiki = 1
           AND settled_at IS NULL`,
        [sessionId, chunkId],
      );
      if (owed == null) continue;
      await this.db.queryAsync(
        `UPDATE wiki_reading_chunks
         SET settled_at = ?, settled_kind = ?, settled_reason = ?
         WHERE session_id = ? AND chunk_id = ?`,
        [now, kind, reason, sessionId, chunkId],
      );
      settled.push(chunkId);
    }
    if (settled.length) {
      await this.db.queryAsync(
        "UPDATE wiki_reading_sessions SET updated_at = ? WHERE session_id = ?",
        [now, sessionId],
      );
    }
    return settled;
  }

  /**
   * Why chunks of this paper were recorded as needing no Wiki entry.
   *
   * Kept readable rather than write-only: the point of accepting "this added
   * nothing" is defeated if nobody can ever go back and see what was waved
   * through.
   */
  async noUpdateDeclarations(
    sessionId: number,
  ): Promise<Array<{ chunkIndexes: number[]; reason: string; at: number }>> {
    const rows = await this.db.queryAsync(
      `SELECT chunk_index, settled_reason, settled_at FROM wiki_reading_chunks
       WHERE session_id = ? AND settled_kind = 'no_update'
       ORDER BY settled_at, chunk_index`,
      [sessionId],
    );
    const byReason = new Map<
      string,
      { chunkIndexes: number[]; reason: string; at: number }
    >();
    for (const row of rows) {
      const reason = String(rowColumn(row, "settled_reason", "settledReason") ?? "");
      const at = Number(rowColumn(row, "settled_at", "settledAt") ?? 0);
      const key = `${at}:${reason}`;
      const entry = byReason.get(key) ?? { chunkIndexes: [], reason, at };
      entry.chunkIndexes.push(
        Number(rowColumn(row, "chunk_index", "chunkIndex")),
      );
      byReason.set(key, entry);
    }
    return [...byReason.values()];
  }

  /** Remember what a full-text read inherited from question-driven reading. */
  async recordQuestionCarryOver(
    sessionId: number,
    chunks: number,
  ): Promise<void> {
    await this.db.queryAsync(
      `UPDATE wiki_reading_sessions
       SET question_chunks_carried_over = ?, updated_at = ?
       WHERE session_id = ?`,
      [Math.max(0, Math.floor(chunks)), Date.now(), sessionId],
    );
  }

  /** Record the whole-Wiki review that precedes the write-up. */
  async recordWikiReview(
    sessionId: number,
    review: WikiWholeWikiReview,
  ): Promise<void> {
    const now = Date.now();
    await this.db.queryAsync(
      `UPDATE wiki_reading_sessions
       SET wiki_review = ?, wiki_review_at = ?, updated_at = ?
       WHERE session_id = ?`,
      [JSON.stringify(review), now, now, sessionId],
    );
  }

  /** Every chunk index delivered so far, ascending. */
  async deliveredIndexes(sessionId: number): Promise<number[]> {
    const rows = await this.db.queryAsync(
      `SELECT chunk_index FROM wiki_reading_chunks
       WHERE session_id = ? ORDER BY chunk_index`,
      [sessionId],
    );
    return rows.map((row) =>
      Number(rowColumn(row, "chunk_index", "chunkIndex")),
    );
  }

  /** Store the one expert profile for this paper. */
  async setExpert(
    sessionId: number,
    expert: WikiReadingExpert,
  ): Promise<void> {
    await this.db.queryAsync(
      `UPDATE wiki_reading_sessions SET expert = ?, updated_at = ?
       WHERE session_id = ?`,
      [JSON.stringify(expert), Date.now(), sessionId],
    );
  }

  /** Remember which attachment holds this paper's reading note. */
  async setNoteKey(sessionId: number, noteKey: string): Promise<void> {
    await this.db.queryAsync(
      `UPDATE wiki_reading_sessions SET note_key = ?, updated_at = ?
       WHERE session_id = ?`,
      [noteKey, Date.now(), sessionId],
    );
  }

  /**
   * Record that the note now accounts for everything delivered.
   *
   * The note is rewritten as a whole, so one integration clears the whole
   * backlog rather than one batch of it; `integratedBatches` is set to the
   * delivered count instead of being incremented.
   */
  async recordIntegration(
    sessionId: number,
    options: {
      unchanged: boolean;
      integratedChunks: number;
      finalSynthesis: boolean;
    },
  ): Promise<void> {
    const session = await this.get(sessionId);
    const now = Date.now();
    await this.db.queryAsync(
      `UPDATE wiki_reading_sessions
       SET integrated_batches = ?, integrated_chunks = ?,
           last_integration_unchanged = ?, updated_at = ?,
           final_synthesis_at = ?
       WHERE session_id = ?`,
      [
        session?.deliveredBatches ?? 0,
        options.integratedChunks,
        options.unchanged ? 1 : 0,
        now,
        options.finalSynthesis ? now : (session?.finalSynthesisAt ?? null),
        sessionId,
      ],
    );
  }

  /**
   * Record that this paper's whole-paper concept list has been submitted.
   *
   * `final` is what the write-up gate looks for. A submission made partway
   * through a paper is still recorded as terms and sources - it just does not
   * discharge the obligation to review the terminology once the whole paper
   * has been read.
   */
  /**
   * Hold candidate concepts until the whole-paper pass.
   *
   * Appends rather than replaces: each mid-reading call adds what that stretch
   * of text established, and the final pass sees everything at once, which is
   * the only vantage point from which "is this actually a concept of the field
   * or just a phrase this section used" can be answered.
   */
  async stageConcepts(sessionId: number, entities: unknown[]): Promise<number> {
    if (!entities.length) {
      const session = await this.get(sessionId);
      return session ? session.stagedConcepts.length : 0;
    }
    const session = await this.get(sessionId);
    const staged = [...(session?.stagedConcepts ?? []), ...entities];
    await this.db.queryAsync(
      `UPDATE wiki_reading_sessions
       SET staged_concepts = ?, updated_at = ?
       WHERE session_id = ?`,
      [JSON.stringify(staged), Date.now(), sessionId],
    );
    return staged.length;
  }

  /** Take everything staged and empty the buffer, in one step. */
  async drainStagedConcepts(sessionId: number): Promise<unknown[]> {
    const session = await this.get(sessionId);
    const staged = session?.stagedConcepts ?? [];
    if (staged.length) {
      await this.db.queryAsync(
        `UPDATE wiki_reading_sessions
         SET staged_concepts = '', updated_at = ?
         WHERE session_id = ?`,
        [Date.now(), sessionId],
      );
    }
    return staged;
  }

  async recordConceptSubmission(
    sessionId: number,
    options: { final: boolean },
  ): Promise<void> {
    if (!options.final) return;
    await this.db.queryAsync(
      `UPDATE wiki_reading_sessions
       SET concepts_recorded_at = ?, updated_at = ?
       WHERE session_id = ?`,
      [Date.now(), Date.now(), sessionId],
    );
  }

  /** How much of the document has actually been delivered. */
  async coverage(sessionId: number): Promise<WikiReadingCoverage> {
    const session = await this.get(sessionId);
    const totalChunks = session?.totalChunks ?? 0;
    const deliveredChunks = Number(
      (await this.db.valueQueryAsync(
        "SELECT COUNT(*) FROM wiki_reading_chunks WHERE session_id = ?",
        [sessionId],
      )) ?? 0,
    );
    const firstMissingIndex =
      deliveredChunks >= totalChunks
        ? null
        : await this.findFirstMissingIndex(sessionId, totalChunks);
    return {
      totalChunks,
      deliveredChunks,
      remainingChunks: Math.max(0, totalChunks - deliveredChunks),
      complete: totalChunks > 0 && deliveredChunks >= totalChunks,
      firstMissingIndex,
    };
  }

  /**
   * The lowest chunk index never delivered.
   *
   * Reading is normally sequential, so this is almost always "one past the
   * last page". It is computed rather than assumed because a reader that
   * jumped with an explicit offset would otherwise be told to resume from a
   * point it had already passed, and would never be told about the hole.
   */
  private async findFirstMissingIndex(
    sessionId: number,
    totalChunks: number,
  ): Promise<number | null> {
    const delivered = new Set(await this.deliveredIndexes(sessionId));
    for (let index = 0; index < totalChunks; index += 1) {
      if (!delivered.has(index)) return index;
    }
    return null;
  }

  /** The newest session for a paper, open or closed. */
  async latestForItem(
    libraryID: number,
    itemKey: string,
  ): Promise<WikiReadingSessionRecord | null> {
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_reading_sessions
       WHERE library_id = ? AND item_key = ?
       ORDER BY session_id DESC LIMIT 1`,
      [libraryID, itemKey],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  /**
   * Coverage for a paper by key, across whatever session is open for it.
   *
   * Carries `finalSynthesisAt` because delivery alone was never the whole
   * question: `verifiedReadDepth` needs to know both that every chunk was
   * handed over AND that the model rewrote its reading of the paper once the
   * last one arrived.
   */
  async coverageForItem(
    libraryID: number,
    itemKey: string,
  ): Promise<
    WikiReadingCoverage & {
      sessionId: number | null;
      finalSynthesisAt: number | null;
      integratedChunks: number;
      mode: WikiReadingMode | null;
    }
  > {
    const session = await this.latestForItem(libraryID, itemKey);
    if (!session) {
      return {
        sessionId: null,
        totalChunks: 0,
        deliveredChunks: 0,
        remainingChunks: 0,
        complete: false,
        firstMissingIndex: null,
        finalSynthesisAt: null,
        integratedChunks: 0,
        mode: null,
      };
    }
    return {
      sessionId: session.sessionId,
      finalSynthesisAt: session.finalSynthesisAt,
      integratedChunks: session.integratedChunks,
      mode: session.mode,
      ...(await this.coverage(session.sessionId)),
    };
  }

  /**
   * Return an open session to `reading`.
   *
   * Used after a commit that did not cover the whole paper: the write landed,
   * but the paper is not finished, so it keeps the library and the state says
   * what should happen next.
   */
  async markReading(sessionId: number): Promise<void> {
    await this.db.queryAsync(
      `UPDATE wiki_reading_sessions SET state = 'reading', updated_at = ?
       WHERE session_id = ? AND ${OPEN_STATE_SQL}`,
      [Date.now(), sessionId],
    );
  }

  async markPrepared(sessionId: number): Promise<void> {
    await this.db.queryAsync(
      `UPDATE wiki_reading_sessions SET state = 'prepared', updated_at = ?
       WHERE session_id = ? AND ${OPEN_STATE_SQL}`,
      [Date.now(), sessionId],
    );
  }

  /** Close a session. Terminal states free the library for the next paper. */
  async close(
    sessionId: number,
    outcome: WikiReadingOutcome,
    note = "",
  ): Promise<void> {
    const now = Date.now();
    await this.db.queryAsync(
      `UPDATE wiki_reading_sessions
       SET state = ?, updated_at = ?, closed_at = ?, note = ?
       WHERE session_id = ?`,
      [outcome, now, now, note, sessionId],
    );
  }

  /** Every session for a library, newest first. For status reporting. */
  async list(
    libraryID: number,
    limit = 50,
  ): Promise<WikiReadingSessionRecord[]> {
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_reading_sessions WHERE library_id = ?
       ORDER BY session_id DESC LIMIT ?`,
      [libraryID, Math.max(1, Math.min(500, Math.floor(limit)))],
    );
    return rows.map(mapSession);
  }
}

/**
 * Raised when a second paper is started while one is unfinished.
 *
 * A distinct type so the MCP layer can attach the open paper to the error
 * payload instead of leaving the model to parse it back out of the sentence.
 */
/**
 * Raised when more text is asked for than the reading note accounts for.
 *
 * A distinct type for the same reason as the conflict above: the MCP layer
 * attaches the debt to the error payload so the model reads a number rather
 * than parsing one back out of a sentence.
 */
export class WikiReadingIntegrationRequired extends Error {
  readonly details: {
    itemKey: string;
    integrationDebt: number;
    maxOutstandingBatches: number;
  };

  constructor(
    message: string,
    details: {
      itemKey: string;
      integrationDebt: number;
      maxOutstandingBatches: number;
    },
  ) {
    super(message);
    this.name = "WikiReadingIntegrationRequired";
    this.details = details;
  }
}

export class WikiReadingSessionConflict extends Error {
  readonly openSession: WikiReadingSessionRecord;

  constructor(message: string, openSession: WikiReadingSessionRecord) {
    super(message);
    this.name = "WikiReadingSessionConflict";
    this.openSession = openSession;
  }
}
