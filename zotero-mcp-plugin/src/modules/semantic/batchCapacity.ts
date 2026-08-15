/**
 * Adaptive batch capacity for the embedding API.
 *
 * Every embedding endpoint has a limit on how much text one request may carry,
 * and none of them publishes it in a form we can compute from: it is a token
 * budget, applied after the provider's own tokenizer, sometimes per-input and
 * sometimes per-request, and a self-hosted model changes it whenever its
 * context window is reconfigured. So the limit is discovered rather than
 * assumed, and it is discovered in the one unit we can measure before sending:
 * the total number of characters in the batch.
 *
 * The search is a plain bisection between two bounds:
 *
 *   successChars  largest batch (in characters) this endpoint has accepted
 *   failureChars  smallest batch this endpoint has rejected *for being too long*
 *
 * Nothing else narrows them. A timeout, a 429, an expired key or a 500 says
 * nothing about capacity, and feeding those into the search would teach the
 * plugin to send one chunk at a time forever after a bad afternoon on the
 * network — which is exactly what the old halve-on-any-413 code did.
 *
 * Two invariants hold throughout, and they are what make the loop terminate:
 *
 *  1. successChars < failureChars whenever both are known. A measurement that
 *     contradicts the other bound discards that bound rather than being
 *     discarded itself: the newer observation is the one that just happened.
 *  2. Chunks are never split. `packBatch` fills up to the budget on chunk
 *     boundaries and always returns at least one chunk, so a budget below the
 *     size of the next chunk yields a single-chunk batch. If *that* is refused
 *     for length, no smaller request exists and the caller must stop rather
 *     than truncate — a half-embedded chunk is a vector that does not describe
 *     the text stored beside it.
 */

/**
 * Bounds are close enough to stop probing: within 1000 chars, or within 10%.
 *
 * The absolute floor is deliberately near one chunk. Below that, bisection
 * cannot change anything: `packBatch` rounds down to chunk boundaries, so two
 * budgets less than a chunk apart produce the identical request. Setting it
 * wider (2000 was tried) stops the search a chunk or two early and leaves real
 * capacity unused — at an 8000-char limit it settled on 7500 and never
 * discovered the last 500. Each extra step costs exactly one refused request,
 * once, for the lifetime of that endpoint's stored record.
 */
export const CAPACITY_CONVERGE_ABS_CHARS = 1000;
export const CAPACITY_CONVERGE_REL = 0.1;

export interface BatchCapacityState {
  /** Largest total-character batch known to succeed, or null if never proven. */
  successChars: number | null;
  /** Smallest total-character batch known to fail on length, or null. */
  failureChars: number | null;
  /** True once the two bounds are close enough that probing has stopped. */
  converged: boolean;
  /** Epoch ms of the last change, used to evict stale endpoints from the store. */
  updatedAt: number;
}

export function createCapacityState(now: number = Date.now()): BatchCapacityState {
  return {
    successChars: null,
    failureChars: null,
    converged: false,
    updatedAt: now,
  };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Rebuild a state from whatever was persisted, discarding anything that does
 * not satisfy the invariants. A pref file is user-editable and survives
 * downgrades, so it is treated as untrusted input.
 */
export function normalizeCapacityState(
  raw: unknown,
  now: number = Date.now(),
): BatchCapacityState {
  const fresh = createCapacityState(now);
  if (!raw || typeof raw !== 'object') return fresh;
  const value = raw as Partial<BatchCapacityState>;

  const successChars = isPositiveInt(value.successChars)
    ? Math.floor(value.successChars)
    : null;
  let failureChars = isPositiveInt(value.failureChars)
    ? Math.floor(value.failureChars)
    : null;

  // Invariant 1: an impossible pair means the file is not trustworthy about
  // the upper bound; keep the success floor, which is the safe half.
  if (successChars !== null && failureChars !== null && successChars >= failureChars) {
    failureChars = null;
  }

  const state: BatchCapacityState = {
    successChars,
    failureChars,
    converged: false,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now,
  };
  state.converged = hasConverged(state);
  return state;
}

function hasConverged(state: BatchCapacityState): boolean {
  const { successChars, failureChars } = state;
  if (successChars === null || failureChars === null) return false;
  const gap = failureChars - successChars;
  const tolerance = Math.max(
    CAPACITY_CONVERGE_ABS_CHARS,
    successChars * CAPACITY_CONVERGE_REL,
  );
  return gap <= tolerance;
}

/**
 * Character budget for the next batch.
 *
 * `Infinity` means "no length failure has ever been observed on this endpoint",
 * in which case the request is limited only by the provider's maximum number of
 * inputs. That is deliberate: capping a healthy endpoint at some number we
 * guessed would make every library pay for a limit only a few endpoints have.
 */
export function capacityBudget(state: BatchCapacityState): number {
  const { successChars, failureChars } = state;
  if (failureChars === null) return Infinity;
  if (state.converged && successChars !== null) return successChars;
  // Nothing has succeeded yet: halve down from the failure until something does.
  if (successChars === null) return Math.max(1, Math.floor(failureChars / 2));
  // Both bounds known: bisect.
  return Math.max(1, Math.floor((successChars + failureChars) / 2));
}

export function recordCapacitySuccess(
  state: BatchCapacityState,
  totalChars: number,
  now: number = Date.now(),
): BatchCapacityState {
  if (!isPositiveInt(totalChars)) return state;
  const successChars = Math.max(state.successChars ?? 0, Math.floor(totalChars));

  // A batch larger than the recorded failure just went through. Since chunks
  // are never split, this happens legitimately whenever a single chunk is
  // bigger than the current budget, and it also happens when the earlier
  // failure was really about token density rather than characters. Either way
  // the upper bound has been disproved, so it is dropped and the search
  // reopens rather than being pinned to a number we know is wrong.
  const failureChars =
    state.failureChars !== null && successChars >= state.failureChars
      ? null
      : state.failureChars;

  const next: BatchCapacityState = {
    successChars,
    failureChars,
    converged: false,
    updatedAt: now,
  };
  next.converged = hasConverged(next);
  return next;
}

/**
 * Record a batch refused *specifically* for input/payload length. Callers must
 * classify the error first; anything else must not reach this function.
 */
export function recordCapacityLengthFailure(
  state: BatchCapacityState,
  totalChars: number,
  now: number = Date.now(),
): BatchCapacityState {
  if (!isPositiveInt(totalChars)) return state;
  const failureChars = Math.min(
    state.failureChars ?? Number.MAX_SAFE_INTEGER,
    Math.floor(totalChars),
  );

  // Invariant 1 again, from the other side: a size we thought was safe has just
  // been refused, so the floor is no longer proven and the next budget drops to
  // half the failure. This is what guarantees the retry loop makes progress —
  // the budget strictly decreases until the batch is a single chunk.
  const successChars =
    state.successChars !== null && state.successChars >= failureChars
      ? null
      : state.successChars;

  const next: BatchCapacityState = {
    successChars,
    failureChars,
    converged: false,
    updatedAt: now,
  };
  next.converged = hasConverged(next);
  return next;
}

/**
 * Fill one request from `items` starting at `start`, on chunk boundaries.
 *
 * Always returns at least one item, even when that item alone exceeds the
 * budget: the alternative would be splitting a chunk, and the caller relies on
 * a single-item batch as the signal that bisection has bottomed out.
 */
export function packBatch<T extends { text: string }>(
  items: T[],
  start: number,
  budgetChars: number,
  maxItems: number,
): T[] {
  const batch: T[] = [];
  let total = 0;
  const itemCap = Math.max(1, Math.floor(maxItems));

  for (let i = start; i < items.length && batch.length < itemCap; i++) {
    const length = items[i].text.length;
    if (batch.length > 0 && total + length > budgetChars) break;
    batch.push(items[i]);
    total += length;
  }
  return batch;
}

export function totalChars(items: Array<{ text: string }>): number {
  let total = 0;
  for (const item of items) total += item.text.length;
  return total;
}

/**
 * Identity of an endpoint for capacity purposes.
 *
 * The limit belongs to the model behind a URL, not to the plugin, so switching
 * model or host must start a fresh search instead of inheriting a budget that
 * described something else. Provider is included because it decides the wire
 * format and therefore the request shape.
 */
export function capacityKey(
  provider: string,
  apiBase: string,
  model: string,
): string {
  const base = String(apiBase || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
  return `${String(provider || '').toLowerCase()}|${base}|${String(model || '').trim()}`;
}

/** Endpoints kept in the pref; oldest are evicted first. */
export const CAPACITY_STORE_MAX_ENTRIES = 24;

export type CapacityRecords = Record<string, BatchCapacityState>;

export function parseCapacityRecords(rawJson: unknown): CapacityRecords {
  if (typeof rawJson !== 'string' || !rawJson.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const records: CapacityRecords = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key) continue;
    records[key] = normalizeCapacityState(value);
  }
  return records;
}

export function writeCapacityRecord(
  records: CapacityRecords,
  key: string,
  state: BatchCapacityState,
  maxEntries: number = CAPACITY_STORE_MAX_ENTRIES,
): CapacityRecords {
  const next: CapacityRecords = { ...records, [key]: state };
  const keys = Object.keys(next);
  if (keys.length <= maxEntries) return next;

  keys.sort((a, b) => (next[a].updatedAt ?? 0) - (next[b].updatedAt ?? 0));
  for (const stale of keys.slice(0, keys.length - maxEntries)) {
    if (stale === key) continue;
    delete next[stale];
  }
  return next;
}
