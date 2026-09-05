/**
 * Bounding how much keyword-search work can be in flight per library, WITHOUT
 * letting one stuck query lock the library out forever.
 *
 * ## Why a gate exists at all
 *
 * `Zotero.Search.search()` cannot be cancelled. Its only parameter is
 * `asTempTable`; there is no signal, no abort, no handle. (Cancellation does
 * exist one layer down — `Zotero.DB.queryAsync` accepts an `onRow` callback
 * whose second argument cancels the live SQLite statement — but reaching it
 * would mean generating Zotero's search SQL ourselves, and Zotero builds that
 * SQL internally and post-filters some condition types in JS. Reimplementing
 * it would be a copy of Zotero's search engine that drifts every release, so
 * this module treats the search as genuinely uncancellable.)
 *
 * A hard timeout can therefore stop the CALLER waiting, but not the query. So
 * back-to-back searches against a slow library would each start another one
 * nobody is waiting for, and the pile only grows: every abandoned query still
 * competes with the query the user IS waiting on, making the next search
 * slower and more likely to time out too.
 *
 * ## Why the obvious gate is worse than the problem
 *
 * The first version of this file held a library's slot until the underlying
 * query settled, and chained waiters onto that same promise. That is correct
 * for a query that is merely slow, and catastrophic for one that never
 * returns: the slot is never released, every waiter is chained behind a
 * promise that never settles, and their slots are never released either. One
 * hung query permanently bricked keyword search for that library — three
 * requests hung forever and every later request was refused, with no recovery
 * short of restarting Zotero.
 *
 * ## Two clocks, not one
 *
 * The fix starts by separating two things the old design conflated:
 *
 *   - **the caller's deadline** — how long THIS request waits before giving
 *     the user an answer. That is the user's configured search timeout, and it
 *     is enforced by the caller, not here.
 *   - **the query's grace period** — how long the background query is given
 *     before we stop believing it will ever return. Deliberately much longer,
 *     because most "hangs" are really "slow" (a big sync holding a write
 *     transaction), and a query that comes back at 90 seconds is proof the
 *     database is alive, which is worth far more than the slot it was holding.
 *
 * Past the grace period the query is *presumed dead*: its slot is released so
 * the queue can drain, and the run rejects. The query itself keeps running —
 * nothing can stop it — but it no longer holds anything.
 *
 * ## Why releasing the slot is not enough on its own
 *
 * If the database really is blocked, freeing the slot just lets the next
 * search start, hang, and be abandoned in turn: unbounded zombie queries, the
 * exact failure the gate was built to prevent. So abandonment also opens a
 * circuit breaker:
 *
 *   - **open** — searches are refused immediately, with the remaining
 *     cool-down, for a while;
 *   - **half-open** — after the cool-down, exactly ONE search is let through
 *     as a probe. Everything else is still refused, so at most one new query
 *     can be created per cool-down window;
 *   - **closed** — the probe answered, so the database is alive again and
 *     normal service resumes with the backoff reset.
 *
 * The cool-down doubles each time a probe is abandoned too, so a genuinely
 * wedged database is retried at a decreasing rate instead of being poked
 * forever, and a one-off stall costs one cool-down.
 *
 * Two things count as proof of life, and both close the circuit immediately:
 * a probe that settles, and — importantly — a query that was already presumed
 * dead settling LATE. A stall that resolves itself therefore restores full
 * service the moment it resolves, without waiting for any cool-down.
 */

declare let ztoolkit: ZToolkit;

/** Queries allowed to wait behind the one that is running, per library. */
export const DEFAULT_MAX_WAITING_KEYWORD_SEARCHES = 2;

/**
 * How long a background query is given before it is presumed dead, expressed
 * as a multiple of the caller's own timeout, with a floor and a ceiling.
 *
 * A multiple rather than a constant because the caller's timeout is the user's
 * own statement about how slow their library is. The floor keeps a very short
 * configured timeout from declaring healthy queries dead; the ceiling keeps a
 * very long one from re-creating the permanent lockout this module exists to
 * prevent.
 */
export const QUERY_GRACE_MULTIPLIER = 4;
export const MIN_QUERY_GRACE_MS = 60_000;
export const MAX_QUERY_GRACE_MS = 10 * 60_000;

/** First cool-down after a query is presumed dead; doubles per failed probe. */
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;
export const MAX_CIRCUIT_COOLDOWN_MS = 10 * 60_000;

export function resolveQueryGraceMs(callerTimeoutMs: number): number {
  if (!Number.isFinite(callerTimeoutMs) || callerTimeoutMs <= 0) {
    return MIN_QUERY_GRACE_MS;
  }
  return Math.min(
    MAX_QUERY_GRACE_MS,
    Math.max(MIN_QUERY_GRACE_MS, Math.floor(callerTimeoutMs * QUERY_GRACE_MULTIPLIER)),
  );
}

export class KeywordSearchOverloadedError extends Error {
  readonly libraryID: number;
  readonly inFlight: number;

  constructor(libraryID: number, inFlight: number) {
    super(
      `Too many keyword searches are already running against library ` +
        `${libraryID} (${inFlight} in flight). Zotero's search API cannot be ` +
        `cancelled, so queueing another one behind them would only spend this ` +
        `request's whole timeout waiting. Retry once the running searches ` +
        `finish, or raise the keyword search timeout.`,
    );
    this.name = 'KeywordSearchOverloadedError';
    this.libraryID = libraryID;
    this.inFlight = inFlight;
  }
}

/**
 * The circuit is open: a previous query stopped responding and the gate is
 * waiting before it risks creating another one.
 */
export class KeywordSearchUnavailableError extends Error {
  readonly libraryID: number;
  readonly retryAfterMs: number;
  readonly abandonedQueries: number;

  constructor(
    libraryID: number,
    retryAfterMs: number,
    abandonedQueries: number,
  ) {
    super(
      `Keyword search is temporarily unavailable for library ${libraryID}: ` +
        `${abandonedQueries} earlier Zotero query/queries stopped responding, ` +
        `and Zotero's search API cannot be cancelled, so starting more now ` +
        `would only add to them. One probe search will be allowed through in ` +
        `about ${Math.ceil(retryAfterMs / 1000)}s, and full service resumes as ` +
        `soon as one answers. This does NOT mean the library has no matching ` +
        `work — semantic search is unaffected.`,
    );
    this.name = 'KeywordSearchUnavailableError';
    this.libraryID = libraryID;
    this.retryAfterMs = retryAfterMs;
    this.abandonedQueries = abandonedQueries;
  }
}

/** This run's own query outlived its grace period and was presumed dead. */
export class KeywordSearchAbandonedError extends Error {
  readonly libraryID: number;
  readonly graceMs: number;

  constructor(libraryID: number, graceMs: number) {
    super(
      `Zotero's item query for library ${libraryID} did not return within ` +
        `${graceMs}ms and has been presumed dead. Its slot was released so ` +
        `other searches are not blocked behind it; the query itself cannot be ` +
        `cancelled and will be ignored if it ever returns.`,
    );
    this.name = 'KeywordSearchAbandonedError';
    this.libraryID = libraryID;
    this.graceMs = graceMs;
  }
}

function hasName(error: unknown, name: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === name
  );
}

export function isKeywordSearchOverloadedError(
  error: unknown,
): error is KeywordSearchOverloadedError {
  return (
    error instanceof KeywordSearchOverloadedError ||
    hasName(error, 'KeywordSearchOverloadedError')
  );
}

export function isKeywordSearchUnavailableError(
  error: unknown,
): error is KeywordSearchUnavailableError {
  return (
    error instanceof KeywordSearchUnavailableError ||
    hasName(error, 'KeywordSearchUnavailableError')
  );
}

export function isKeywordSearchAbandonedError(
  error: unknown,
): error is KeywordSearchAbandonedError {
  return (
    error instanceof KeywordSearchAbandonedError ||
    hasName(error, 'KeywordSearchAbandonedError')
  );
}

/** Any reason the gate itself refused or gave up on a search. */
export function isKeywordSearchGateError(error: unknown): boolean {
  return (
    isKeywordSearchOverloadedError(error) ||
    isKeywordSearchUnavailableError(error) ||
    isKeywordSearchAbandonedError(error)
  );
}

export type KeywordSearchCircuitState = 'closed' | 'open' | 'half-open';

export interface KeywordSearchGateSnapshot {
  /** Admitted searches: the one running plus any queued behind it. */
  inFlight: number;
  /** Presumed-dead queries that have still never settled. */
  abandoned: number;
  circuit: KeywordSearchCircuitState;
  /** Milliseconds until the next probe is allowed; 0 when not cooling down. */
  retryAfterMs: number;
  /** Queries presumed dead since the gate was last fully healthy. */
  consecutiveAbandonments: number;
}

interface LibraryState {
  /** Resolves when the current occupant releases the slot. */
  tail: Promise<void>;
  inFlight: number;
  abandoned: number;
  circuit: KeywordSearchCircuitState;
  openedAt: number;
  cooldownMs: number;
  /** A half-open probe has been admitted and has not finished. */
  probeActive: boolean;
  consecutiveAbandonments: number;
}

export interface KeywordSearchGateOptions {
  maxWaiting?: number;
  /** First cool-down after an abandonment. Doubles per failed probe. */
  cooldownMs?: number;
  maxCooldownMs?: number;
}

export class KeywordSearchGate {
  private readonly states = new Map<number, LibraryState>();
  private readonly maxWaiting: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;

  constructor(
    options: number | KeywordSearchGateOptions = {},
  ) {
    // A bare number keeps the original, widely-used `new KeywordSearchGate(2)`
    // shape working.
    const resolved: KeywordSearchGateOptions =
      typeof options === 'number' ? { maxWaiting: options } : options;
    this.maxWaiting = Math.max(
      0,
      Math.floor(resolved.maxWaiting ?? DEFAULT_MAX_WAITING_KEYWORD_SEARCHES),
    );
    this.baseCooldownMs = Math.max(
      1,
      Math.floor(resolved.cooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS),
    );
    this.maxCooldownMs = Math.max(
      this.baseCooldownMs,
      Math.floor(resolved.maxCooldownMs ?? MAX_CIRCUIT_COOLDOWN_MS),
    );
  }

  /** Admitted searches (running + queued) for a library. */
  pending(libraryID: number): number {
    return this.states.get(libraryID)?.inFlight ?? 0;
  }

  /** Everything the gate knows about a library. Diagnostics and tests. */
  inspect(libraryID: number): KeywordSearchGateSnapshot {
    const state = this.states.get(libraryID);
    if (!state) {
      return {
        inFlight: 0,
        abandoned: 0,
        circuit: 'closed',
        retryAfterMs: 0,
        consecutiveAbandonments: 0,
      };
    }
    return {
      inFlight: state.inFlight,
      abandoned: state.abandoned,
      circuit: state.circuit,
      retryAfterMs: this.remainingCooldownMs(state),
      consecutiveAbandonments: state.consecutiveAbandonments,
    };
  }

  /**
   * Run `task` as the library's only keyword query.
   *
   * Resolves with the query's result, or rejects: with the query's own error;
   * with {@link KeywordSearchAbandonedError} if it outlives `graceMs`; or,
   * before it ever starts, with {@link KeywordSearchOverloadedError} or
   * {@link KeywordSearchUnavailableError}.
   *
   * The caller is expected to enforce its OWN, much shorter deadline on top of
   * this. `graceMs` is not the user's patience — it is how long we keep
   * believing in a query nobody is waiting for any more.
   */
  run<T>(
    libraryID: number,
    task: () => Promise<T>,
    options: { graceMs?: number } = {},
  ): Promise<T> {
    const graceMs = Math.max(
      1,
      Math.floor(options.graceMs ?? MIN_QUERY_GRACE_MS),
    );
    const state = this.stateFor(libraryID);

    // Admission control is entirely synchronous, so two callers in the same
    // tick cannot both be admitted into a slot that only fits one.
    const refusal = this.admit(libraryID, state);
    if (refusal) return Promise.reject(refusal);

    const previous = state.tail;
    let releaseSlot!: () => void;
    const slot = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    // The NEXT caller waits on our slot, which is released by the grace timer
    // as well as by the task. This is the difference that makes a hung query
    // survivable: the queue drains on a timer, never on a promise that may
    // never settle.
    state.tail = previous.then(() => slot);

    return this.execute(libraryID, state, previous, task, graceMs, releaseSlot);
  }

  private async execute<T>(
    libraryID: number,
    state: LibraryState,
    previous: Promise<void>,
    task: () => Promise<T>,
    graceMs: number,
    releaseSlot: () => void,
  ): Promise<T> {
    // "Did I claim the probe on the way in?" — passed to the re-admission
    // check so this run is not refused by the claim it is itself holding.
    // NOT the same question as "am I the probe?", which is only settled once
    // re-admission has run; see `isProbe` below.
    const claimedProbeOnEntry = state.probeActive;
    let slotReleased = false;
    const release = () => {
      if (slotReleased) return;
      slotReleased = true;
      state.inFlight = Math.max(0, state.inFlight - 1);
      releaseSlot();
      this.collect(libraryID, state);
    };

    try {
      await previous;

      // The queue may have been waiting a long time, and the world can have
      // changed while it waited. Re-checking here is what stops a request that
      // was admitted before an abandonment from starting a SECOND query into a
      // database we have just decided is not answering.
      const refusal = this.admit(libraryID, state, {
        readmit: true,
        wasProbe: claimedProbeOnEntry,
      });
      if (refusal) {
        release();
        throw refusal;
      }

      // Read AFTER admission, not before it: admission is what decides
      // whether this run holds the probe, and the value captured on the way in
      // is only "did I claim it in run()". Deciding the backoff from the stale
      // read would let a run that was promoted to probe at the front of the
      // queue reset the cool-down instead of doubling it.
      const isProbe = state.probeActive;

      let timer: ReturnType<typeof setTimeout> | undefined;
      let abandoned = false;
      let query: Promise<T>;
      try {
        query = task();
      } catch (error) {
        // A task that throws synchronously never becomes a running query, so
        // it can never produce proof of life and can never be abandoned —
        // neither of the two paths that give the probe back would ever run.
        // Without this the circuit would sit in half-open with the probe
        // permanently claimed, refusing every later search with no cool-down
        // left to wait out: a permanent lockout, which is the exact failure
        // this whole module exists to prevent.
        if (isProbe) this.releaseProbe(libraryID, state);
        throw error;
      }

      // Whatever happens to this run, a query that eventually settles is proof
      // the database is alive — including one we have already given up on.
      const observe = () => {
        try {
          this.noteProofOfLife(libraryID, state, abandoned);
        } catch {
          // Bookkeeping must never turn a late answer into a crash.
        }
      };
      query.then(observe, observe);

      try {
        return await Promise.race([
          query,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abandoned = true;
              this.noteAbandonment(libraryID, state, isProbe);
              // Free the slot FIRST: the whole point is that the queue behind
              // this query keeps moving even though the query does not.
              release();
              reject(new KeywordSearchAbandonedError(libraryID, graceMs));
            }, graceMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        release();
      }
    } catch (error) {
      release();
      throw error;
    }
  }

  private stateFor(libraryID: number): LibraryState {
    let state = this.states.get(libraryID);
    if (!state) {
      state = {
        tail: Promise.resolve(),
        inFlight: 0,
        abandoned: 0,
        circuit: 'closed',
        openedAt: 0,
        cooldownMs: this.baseCooldownMs,
        probeActive: false,
        consecutiveAbandonments: 0,
      };
      this.states.set(libraryID, state);
    }
    return state;
  }

  private remainingCooldownMs(state: LibraryState): number {
    // A probe is in flight and nobody knows when it will answer. Reporting 0
    // here would tell a caller to retry at once, when the honest answer is the
    // same one the refusal error already carries: wait about a cool-down.
    if (state.circuit === 'half-open') {
      return state.probeActive ? state.cooldownMs : 0;
    }
    if (state.circuit !== 'open') return 0;
    return Math.max(0, state.openedAt + state.cooldownMs - Date.now());
  }

  /**
   * Decide whether a search may proceed, and record it if so.
   *
   * Called twice per run: once on arrival, and once when the slot is actually
   * reached. The second call must not re-count the request, and must not
   * re-claim the probe it already holds.
   */
  private admit(
    libraryID: number,
    state: LibraryState,
    options: { readmit?: boolean; wasProbe?: boolean } = {},
  ): Error | null {
    const { readmit = false, wasProbe = false } = options;

    if (state.circuit === 'open') {
      const remaining = this.remainingCooldownMs(state);
      if (remaining > 0) {
        return new KeywordSearchUnavailableError(
          libraryID,
          remaining,
          state.abandoned,
        );
      }
      // Cool-down elapsed: let exactly one search through to find out whether
      // the database is answering again.
      state.circuit = 'half-open';
      state.probeActive = false;
    }

    if (state.circuit === 'half-open') {
      if (state.probeActive && !(readmit && wasProbe)) {
        return new KeywordSearchUnavailableError(
          libraryID,
          state.cooldownMs,
          state.abandoned,
        );
      }
      state.probeActive = true;
      if (!readmit) state.inFlight += 1;
      return null;
    }

    if (readmit) return null;

    if (state.inFlight > this.maxWaiting) {
      return new KeywordSearchOverloadedError(libraryID, state.inFlight);
    }
    state.inFlight += 1;
    return null;
  }

  /**
   * Hand the probe back without claiming the database is healthy.
   *
   * Used when a run that held the probe never actually started a query, so it
   * learned nothing either way: the circuit stays open and keeps its
   * cool-down, but the next caller after that cool-down can probe again.
   */
  private releaseProbe(libraryID: number, state: LibraryState): void {
    state.probeActive = false;
    if (state.circuit === 'half-open') {
      state.circuit = 'open';
      // Re-arm the existing cool-down rather than extending it: nothing was
      // learned, so nothing justifies backing off further.
      state.openedAt = Date.now();
    }
    ztoolkit.log(
      `[KeywordSearchGate] library ${libraryID}: probe released without ` +
        `running; will retry after ${state.cooldownMs}ms`,
      'warn',
    );
  }

  private noteAbandonment(
    libraryID: number,
    state: LibraryState,
    wasProbe: boolean,
  ): void {
    state.abandoned += 1;
    state.consecutiveAbandonments += 1;
    // A probe that hung too means the database is still wedged, so back off
    // further. A first abandonment starts at the base cool-down.
    state.cooldownMs = wasProbe
      ? Math.min(this.maxCooldownMs, state.cooldownMs * 2)
      : this.baseCooldownMs;
    state.circuit = 'open';
    state.openedAt = Date.now();
    state.probeActive = false;
    ztoolkit.log(
      `[KeywordSearchGate] library ${libraryID}: query presumed dead ` +
        `(abandoned=${state.abandoned}); refusing keyword searches for ` +
        `${state.cooldownMs}ms, then one probe`,
      'warn',
    );
  }

  /**
   * A query answered. Whether it answered on time or hours late, the database
   * is demonstrably alive, so full service resumes at once.
   */
  private noteProofOfLife(
    libraryID: number,
    state: LibraryState,
    wasAbandoned: boolean,
  ): void {
    if (wasAbandoned) state.abandoned = Math.max(0, state.abandoned - 1);
    const wasDegraded = state.circuit !== 'closed';
    state.circuit = 'closed';
    state.probeActive = false;
    state.cooldownMs = this.baseCooldownMs;
    state.consecutiveAbandonments = 0;
    if (wasDegraded || wasAbandoned) {
      ztoolkit.log(
        `[KeywordSearchGate] library ${libraryID}: Zotero answered ` +
          `${wasAbandoned ? '(late, after being presumed dead)' : ''}; ` +
          `keyword search restored`,
      );
    }
    this.collect(libraryID, state);
  }

  /** Drop a library's bookkeeping once it is idle and healthy again. */
  private collect(libraryID: number, state: LibraryState): void {
    if (
      state.inFlight === 0 &&
      state.abandoned === 0 &&
      state.circuit === 'closed'
    ) {
      this.states.delete(libraryID);
    }
  }
}

/** The gate every production keyword search goes through. */
export const keywordSearchGate = new KeywordSearchGate();
