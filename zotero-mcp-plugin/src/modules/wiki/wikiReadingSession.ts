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
        await this.db.queryAsync(
          `UPDATE wiki_reading_sessions SET total_chunks = ?, updated_at = ?
           WHERE session_id = ?`,
          [options.totalChunks, Date.now(), open.sessionId],
        );
        // A re-chunked document invalidates what "delivered" meant.
        await this.db.queryAsync(
          "DELETE FROM wiki_reading_chunks WHERE session_id = ?",
          [open.sessionId],
        );
        return { ...open, totalChunks: options.totalChunks };
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

  /** Record that these chunk indexes were handed to the model. */
  async recordDelivery(
    sessionId: number,
    chunks: Array<{ chunkIndex: number; chunkId: number }>,
  ): Promise<void> {
    if (!chunks.length) return;
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
    await this.db.queryAsync(
      "UPDATE wiki_reading_sessions SET updated_at = ? WHERE session_id = ?",
      [now, sessionId],
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
    const rows = await this.db.queryAsync(
      `SELECT chunk_index FROM wiki_reading_chunks
       WHERE session_id = ? ORDER BY chunk_index`,
      [sessionId],
    );
    const delivered = new Set(
      rows.map((row) => Number(rowColumn(row, "chunk_index", "chunkIndex"))),
    );
    for (let index = 0; index < totalChunks; index += 1) {
      if (!delivered.has(index)) return index;
    }
    return null;
  }

  /** Coverage for a paper by key, across whatever session is open for it. */
  async coverageForItem(
    libraryID: number,
    itemKey: string,
  ): Promise<WikiReadingCoverage & { sessionId: number | null }> {
    const rows = await this.db.queryAsync(
      `SELECT * FROM wiki_reading_sessions
       WHERE library_id = ? AND item_key = ?
       ORDER BY session_id DESC LIMIT 1`,
      [libraryID, itemKey],
    );
    if (!rows[0]) {
      return {
        sessionId: null,
        totalChunks: 0,
        deliveredChunks: 0,
        remainingChunks: 0,
        complete: false,
        firstMissingIndex: null,
      };
    }
    const session = mapSession(rows[0]);
    return { sessionId: session.sessionId, ...(await this.coverage(session.sessionId)) };
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
export class WikiReadingSessionConflict extends Error {
  readonly openSession: WikiReadingSessionRecord;

  constructor(message: string, openSession: WikiReadingSessionRecord) {
    super(message);
    this.name = "WikiReadingSessionConflict";
    this.openSession = openSession;
  }
}
