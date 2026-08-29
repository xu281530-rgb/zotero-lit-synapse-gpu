/**
 * The durable boundary for `wiki_commit`, and the repair path behind it.
 *
 * `commit()` used to be: run the database transaction, then embed every new
 * claim one at a time against a remote embedding service, THEN answer the
 * caller. Two things followed from that order.
 *
 * A slow embedding backend made the whole call slow, so a client deadline
 * could expire while the transaction had already committed. The client saw a
 * timeout and could not tell whether anything had been written - and a naive
 * retry then failed on "An equivalent Claim already exists", which is a
 * confusing way to learn that the first attempt had in fact worked.
 *
 * A failing embedding backend was caught and downgraded to a warning, which is
 * right, but nothing remembered the claim afterwards. It stayed permanently
 * without a vector, so Wiki retrieval could never match it semantically, and
 * no code path existed that would ever notice.
 *
 * This queue moves the embedding out of the request. The database transaction
 * is the commit; once it lands the caller is answered. Rows needing a vector
 * are written into the queue inside that same transaction, so the intent to
 * embed is exactly as durable as the row itself - a crash between the two is
 * impossible. A background drain then works the queue with exponential
 * backoff, and rows survive a Zotero restart because they are rows, not
 * memory.
 *
 * TWO KINDS OF ROW go through this, Claims and Concepts, and they share one
 * implementation rather than two. The backoff schedule, the "exhausted but
 * not deleted" rule and the re-entrancy guard are subtle enough that a second
 * copy would drift from this one, and a drift in a retry policy is invisible
 * until the day the backend is down. What differs between them - which table,
 * which id column, and how a row's current text is assembled - is the target
 * descriptor below and nothing else.
 */

import { hashWikiText } from "./wikiCanonicalizer";
import {
  CONCEPT_EMBEDDING_COLUMNS,
  conceptEmbeddingTextFromRow,
} from "./wikiConceptEmbedding";
import { rowColumn } from "./wikiRow";
import type { WikiDatabase } from "./wikiTypes";

declare let ztoolkit: ZToolkit;

/** Backoff schedule in milliseconds, indexed by attempt count. */
const RETRY_BACKOFF_MS = [
  0,
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
];

/**
 * Attempts after which a row stops being retried automatically.
 *
 * It is not deleted: the row stays as the record that this Claim or Concept
 * still has no vector, so `wiki_status` can report it and a manual reverify
 * can pick it up.
 */
export const MAX_EMBEDDING_ATTEMPTS = RETRY_BACKOFF_MS.length;

export interface WikiEmbeddingQueueRow {
  id: number;
  textHash: string;
  attempts: number;
  lastError: string;
  enqueuedAt: number;
  nextAttemptAt: number;
}

export interface WikiEmbeddingWorkUnit {
  id: number;
  text: string;
  attempts: number;
}

/**
 * What makes one queue different from another.
 *
 * `loadDue` returns the text as it stands NOW rather than the text that was
 * queued. That is deliberate: a Claim edited between enqueue and drain should
 * be embedded as it currently reads, and the stored `text_hash` then says
 * whether the vector still matches the row.
 */
export interface WikiEmbeddingTarget {
  /** Used in log lines; also what `wiki_status` calls these rows. */
  readonly kind: string;
  readonly queueTable: string;
  readonly idColumn: string;
  loadDue(
    db: WikiDatabase,
    now: number,
    limit: number,
    maxAttempts: number,
  ): Promise<WikiEmbeddingWorkUnit[]>;
}

export const CLAIM_EMBEDDING_TARGET: WikiEmbeddingTarget = {
  kind: "claim",
  queueTable: "wiki_embedding_queue",
  idColumn: "claim_id",
  async loadDue(db, now, limit, maxAttempts) {
    const rows = await db.queryAsync(
      `SELECT q.claim_id AS id, q.attempts AS attempts, c.claim_text AS text
         FROM wiki_embedding_queue q
         JOIN wiki_claims c ON c.claim_id = q.claim_id
        WHERE q.next_attempt_at <= ? AND q.attempts < ?
        ORDER BY q.next_attempt_at, q.claim_id
        LIMIT ?`,
      [now, maxAttempts, limit],
    );
    return rows.map((row: any) => ({
      id: Number(rowColumn(row, "id", "id")),
      text: String(rowColumn(row, "text", "text") ?? ""),
      attempts: Number(rowColumn(row, "attempts", "attempts")),
    }));
  },
};

export const CONCEPT_EMBEDDING_TARGET: WikiEmbeddingTarget = {
  kind: "concept",
  queueTable: "wiki_concept_embedding_queue",
  idColumn: "concept_id",
  async loadDue(db, now, limit, maxAttempts) {
    const rows = await db.queryAsync(
      `SELECT q.concept_id AS id, q.attempts AS attempts, ${CONCEPT_EMBEDDING_COLUMNS}
         FROM wiki_concept_embedding_queue q
         JOIN wiki_concepts c ON c.concept_id = q.concept_id
        WHERE q.next_attempt_at <= ? AND q.attempts < ?
        ORDER BY q.next_attempt_at, q.concept_id
        LIMIT ?`,
      [now, maxAttempts, limit],
    );
    return rows.map((row: any) => ({
      id: Number(rowColumn(row, "id", "id")),
      text: conceptEmbeddingTextFromRow(row),
      attempts: Number(rowColumn(row, "attempts", "attempts")),
    }));
  },
};

function mapRow(row: any, idColumn: string): WikiEmbeddingQueueRow {
  return {
    id: Number(rowColumn(row, idColumn, idColumn)),
    textHash: String(rowColumn(row, "text_hash", "textHash")),
    attempts: Number(rowColumn(row, "attempts", "attempts")),
    lastError: String(rowColumn(row, "last_error", "lastError") ?? ""),
    enqueuedAt: Number(rowColumn(row, "enqueued_at", "enqueuedAt")),
    nextAttemptAt: Number(rowColumn(row, "next_attempt_at", "nextAttemptAt")),
  };
}

export class WikiEmbeddingQueue {
  private readonly db: WikiDatabase;
  private readonly target: WikiEmbeddingTarget;
  private draining = false;

  constructor(db: WikiDatabase, target: WikiEmbeddingTarget) {
    this.db = db;
    this.target = target;
  }

  get kind(): string {
    return this.target.kind;
  }

  /**
   * Mark a row as needing a vector.
   *
   * Call inside the commit transaction. Re-enqueuing an already queued row
   * resets its backoff, which is what a caller re-submitting the same text
   * means.
   */
  async enqueue(id: number, text: string): Promise<void> {
    const now = Date.now();
    const { queueTable, idColumn } = this.target;
    await this.db.queryAsync(
      `INSERT INTO ${queueTable}
       (${idColumn}, text_hash, attempts, last_error, enqueued_at, next_attempt_at)
       VALUES (?, ?, 0, '', ?, ?)
       ON CONFLICT(${idColumn}) DO UPDATE SET
         text_hash = excluded.text_hash,
         attempts = 0,
         last_error = '',
         next_attempt_at = excluded.next_attempt_at`,
      [id, await hashWikiText(text), now, now],
    );
  }

  async remove(id: number): Promise<void> {
    await this.db.queryAsync(
      `DELETE FROM ${this.target.queueTable} WHERE ${this.target.idColumn} = ?`,
      [id],
    );
  }

  /** Rows still waiting for a vector, whether or not they are due. */
  async pendingCount(): Promise<number> {
    return Number(
      (await this.db.valueQueryAsync(
        `SELECT COUNT(*) FROM ${this.target.queueTable}`,
        [],
      )) ?? 0,
    );
  }

  /** Rows that have exhausted their automatic retries. */
  async exhaustedCount(): Promise<number> {
    return Number(
      (await this.db.valueQueryAsync(
        `SELECT COUNT(*) FROM ${this.target.queueTable} WHERE attempts >= ?`,
        [MAX_EMBEDDING_ATTEMPTS],
      )) ?? 0,
    );
  }

  async list(limit = 100): Promise<WikiEmbeddingQueueRow[]> {
    const { queueTable, idColumn } = this.target;
    const rows = await this.db.queryAsync(
      `SELECT * FROM ${queueTable} ORDER BY next_attempt_at, ${idColumn} LIMIT ?`,
      [Math.max(1, Math.min(1000, Math.floor(limit)))],
    );
    return rows.map((row: any) => mapRow(row, idColumn));
  }

  private async recordFailure(
    id: number,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    const next = attempts + 1;
    const backoff =
      RETRY_BACKOFF_MS[Math.min(next, RETRY_BACKOFF_MS.length - 1)];
    await this.db.queryAsync(
      `UPDATE ${this.target.queueTable}
          SET attempts = ?, last_error = ?, next_attempt_at = ?
        WHERE ${this.target.idColumn} = ?`,
      [
        next,
        error instanceof Error ? error.message : String(error),
        Date.now() + backoff,
        id,
      ],
    );
  }

  /**
   * Work the queue once.
   *
   * `embedOne` does the embedding and persists it; it throws to signal a
   * retryable failure. A row that succeeds leaves the queue, so the queue
   * being empty is the same statement as "every row has a current vector".
   *
   * Re-entrancy is guarded rather than queued: a second concurrent drain would
   * embed the same rows twice for no benefit.
   */
  async drain(
    embedOne: (unit: WikiEmbeddingWorkUnit) => Promise<void>,
    options: { limit?: number; now?: number } = {},
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.draining) return { processed: 0, succeeded: 0, failed: 0 };
    this.draining = true;
    try {
      const now = options.now ?? Date.now();
      const units = await this.target.loadDue(
        this.db,
        now,
        options.limit ?? 25,
        MAX_EMBEDDING_ATTEMPTS,
      );
      let succeeded = 0;
      let failed = 0;
      for (const unit of units) {
        try {
          await embedOne(unit);
          await this.remove(unit.id);
          succeeded += 1;
        } catch (error) {
          await this.recordFailure(unit.id, unit.attempts, error);
          failed += 1;
        }
      }
      return { processed: units.length, succeeded, failed };
    } finally {
      this.draining = false;
    }
  }

  /**
   * Reset the backoff on every queued row so the next drain retries all of
   * them, including ones that had exhausted their attempts.
   *
   * This is what a user-triggered "retry indexing" means.
   */
  async retryAll(): Promise<number> {
    const pending = await this.pendingCount();
    await this.db.queryAsync(
      `UPDATE ${this.target.queueTable} SET attempts = 0, next_attempt_at = ?`,
      [Date.now()],
    );
    if (pending) {
      ztoolkit.log(
        `[WikiEmbeddingQueue] re-armed ${pending} ${this.target.kind}(s)`,
      );
    }
    return pending;
  }
}
