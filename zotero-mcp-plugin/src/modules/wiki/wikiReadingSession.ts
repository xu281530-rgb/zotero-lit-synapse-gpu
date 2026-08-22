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
  };
}

const OPEN_STATE_SQL = `state IN ('reading','prepared')`;

export class WikiReadingSessions {
  private readonly db: WikiDatabase;

  constructor(db: WikiDatabase) {
    this.db = db;
  }

  /** The session that currently owns this library, if any. */
  async getOpen(libraryID: number): Promise<WikiReadingSessionRecord | null> {
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_reading_sessions
       WHERE library_id = ? AND ${OPEN_STATE_SQL}
       ORDER BY session_id DESC LIMIT 1`,
      [libraryID],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async get(sessionId: number): Promise<WikiReadingSessionRecord | null> {
    const rows = await this.db.queryAsync(
      "SELECT * FROM wiki_reading_sessions WHERE session_id = ?",
      [sessionId],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  /**
   * Open a session for `itemKey`, or return the one already open for it.
   *
   * Refuses when a DIFFERENT paper is open. The message carries the open
   * paper's key and both ways out, because the caller is a model that has to
   * pick a recovery without asking anyone.
   */
  async startOrContinue(options: {
    libraryID: number;
    itemKey: string;
    title: string;
    totalChunks: number;
  }): Promise<WikiReadingSessionRecord> {
    const open = await this.getOpen(options.libraryID);
    if (open && open.itemKey !== options.itemKey) {
      const coverage = await this.coverage(open.sessionId);
      throw new WikiReadingSessionConflict(
        `Paper ${open.itemKey} is still open in this library (state: ${open.state}, ` +
          `${coverage.deliveredChunks} of ${coverage.totalChunks} chunks read). ` +
          `Finish it before starting ${options.itemKey}. Two ways: read it to the end with ` +
          `wiki_build_from_paper` +
          (coverage.firstMissingIndex === null
            ? ""
            : ` (resume at chunk index ${coverage.firstMissingIndex})`) +
          ` and then commit it — a commit only closes a paper once every chunk has been ` +
          `delivered, so committing partway through keeps it open — or close it deliberately ` +
          `with wiki_finish_reading, itemKey "${open.itemKey}", outcome "skipped".`,
        open,
      );
    }
    if (open) {
      // Same paper: re-reading is normal. Refresh the chunk total in case the
      // index was rebuilt underneath the reader.
      if (open.totalChunks !== options.totalChunks) {
        // A re-chunked document invalidates what "delivered" meant, and with
        // it every count derived from delivery: the batch ledger, how much of
        // the paper the note covers, and the whole-paper synthesis, which was
        // made from text that no longer maps onto these chunks. The note's
        // BODY is kept - the reading it records is still a reading of this
        // paper - but its coverage claim restarts from zero.
        await this.db.queryAsync(
          `UPDATE wiki_reading_sessions
           SET total_chunks = ?, updated_at = ?, delivered_batches = 0,
               integrated_batches = 0, integrated_chunks = 0,
               last_integration_unchanged = 0, final_synthesis_at = NULL
           WHERE session_id = ?`,
          [options.totalChunks, Date.now(), open.sessionId],
        );
        await this.db.queryAsync(
          "DELETE FROM wiki_reading_chunks WHERE session_id = ?",
          [open.sessionId],
        );
        return {
          ...open,
          totalChunks: options.totalChunks,
          deliveredBatches: 0,
          integratedBatches: 0,
          integratedChunks: 0,
          lastIntegrationUnchanged: false,
          finalSynthesisAt: null,
        };
      }
      return open;
    }
    const now = Date.now();
    await this.db.queryAsync(
      `INSERT INTO wiki_reading_sessions
       (library_id, item_key, title, total_chunks, state, started_at, updated_at)
       VALUES (?, ?, ?, ?, 'reading', ?, ?)`,
      [
        options.libraryID,
        options.itemKey,
        options.title,
        options.totalChunks,
        now,
        now,
      ],
    );
    const opened = await this.getOpen(options.libraryID);
    if (!opened) throw new Error("Failed to open a Wiki reading session");
    return opened;
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
      };
    }
    return {
      sessionId: session.sessionId,
      finalSynthesisAt: session.finalSynthesisAt,
      integratedChunks: session.integratedChunks,
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
