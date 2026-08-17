/**
 * When an incremental build may re-attempt a body parse that previously failed.
 *
 * `getItemsToSkip` deliberately keeps two kinds of row eligible for another
 * try: `source_kind='metadata-only'` (a body source exists but could not be
 * read, so only title/abstract were indexed) and `content_hash='empty'` (no
 * extractable content at all at the time). That exemption used to be dead
 * code, because the item then hit the timestamp fast path in
 * `indexItemWithProcessor` — and the PDF's mtime has not changed just because
 * MinerU was switched on or the file was repaired, so the item was skipped
 * again, forever, unless the user found the explicit "retry failed items"
 * button.
 *
 * The naive fix — always re-extract these — makes every routine incremental
 * build pay a full parse (and, with MinerU, real API quota) for every
 * permanently broken PDF in the library. So retries are allowed, but paced:
 *
 *  1. whenever the extraction configuration has changed since the last
 *     attempt, because that is precisely the case where the outcome can
 *     differ, and waiting out a backoff would be pointless; otherwise
 *  2. once the backoff window since the last attempt has elapsed.
 *
 * A run the user explicitly forced (`force`) ignores all of this, as before.
 */

/** Default pacing: a broken PDF is re-attempted at most once a day. */
export const DEFAULT_BODY_RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000;

/**
 * The subset of extraction settings that can change a body parse's outcome.
 *
 * Deliberately structural rather than "every pref": the point is to re-attempt
 * when the answer could differ, not whenever any unrelated setting is touched.
 */
export interface BodyExtractionSignatureInput {
  minerUEnabled: boolean;
  minerUMode: string;
  minerUBaseURL: string;
  minerUModelVersion: string;
  minerULanguage: string;
  minerUEnableOCR: boolean;
  minerUEnableFormula: boolean;
  minerUEnableTable: boolean;
  minerUTimeoutSeconds: number;
  minerUMaxFileSizeMB: number;
  /**
   * The credential is never stored — only whether it is present and a
   * non-reversible fingerprint of it, so that correcting a rejected token
   * counts as a configuration change and unblocks the retry.
   */
  minerUApiToken: string;
}

function fingerprint(value: string): string {
  // djb2. Not a security primitive — it exists so the raw token never reaches
  // the database while a changed token still changes the signature.
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function computeBodyExtractionSignature(
  input: BodyExtractionSignatureInput,
): string {
  return [
    'v1',
    input.minerUEnabled ? 'on' : 'off',
    input.minerUMode,
    input.minerUBaseURL,
    input.minerUModelVersion,
    input.minerULanguage,
    input.minerUEnableOCR ? 'ocr' : '-',
    input.minerUEnableFormula ? 'formula' : '-',
    input.minerUEnableTable ? 'table' : '-',
    String(input.minerUTimeoutSeconds),
    String(input.minerUMaxFileSizeMB),
    input.minerUApiToken ? `tok:${fingerprint(input.minerUApiToken)}` : 'tok:-',
  ].join('|');
}

/**
 * Rows whose body is known to be missing, and which therefore stay eligible
 * for another attempt. Mirrors the predicate in `getItemsToSkip`, which is
 * what put these items into the build's work list in the first place.
 */
export function isBodyRetryCandidate(status: {
  sourceKind?: string | null;
  contentHash?: string | null;
} | null | undefined): boolean {
  if (!status) return false;
  return (
    status.sourceKind === 'metadata-only' || status.contentHash === 'empty'
  );
}

export interface BodyRetryDecision {
  /** Re-extract this item even though its timestamps are unchanged. */
  retry: boolean;
  reason:
    | 'not-a-retry-candidate'
    | 'configuration-changed'
    | 'backoff-elapsed'
    | 'backoff-pending';
}

/**
 * Decide whether a timestamp-unchanged item should still be re-extracted.
 *
 * Only ever widens what a build does: an item that is not a retry candidate is
 * returned untouched, so a normally indexed document is never re-processed and
 * the incremental build's cost is unchanged for the whole healthy library.
 */
export function decideBodyRetry(options: {
  status:
    | {
        sourceKind?: string | null;
        contentHash?: string | null;
        indexedAt?: number | null;
        bodyRetrySignature?: string | null;
      }
    | null
    | undefined;
  currentSignature: string;
  now: number;
  backoffMs?: number;
}): BodyRetryDecision {
  const { status, currentSignature, now } = options;
  const backoffMs = options.backoffMs ?? DEFAULT_BODY_RETRY_BACKOFF_MS;

  if (!isBodyRetryCandidate(status)) {
    return { retry: false, reason: 'not-a-retry-candidate' };
  }

  // A row written before this column existed carries no signature. Treating
  // that as "changed" gives every pre-existing failure exactly one retry, and
  // the attempt stamps a signature so it then follows the normal pacing.
  const storedSignature = status?.bodyRetrySignature ?? null;
  if (storedSignature !== currentSignature) {
    return { retry: true, reason: 'configuration-changed' };
  }

  // A missing/invalid timestamp must not pin an item to "never retry".
  const indexedAt = Number(status?.indexedAt);
  if (!Number.isFinite(indexedAt) || indexedAt <= 0) {
    return { retry: true, reason: 'backoff-elapsed' };
  }

  // index_status.indexed_at is stored in SECONDS (strftime('%s','now')).
  const elapsedMs = now - indexedAt * 1000;
  if (elapsedMs >= backoffMs) {
    return { retry: true, reason: 'backoff-elapsed' };
  }
  return { retry: false, reason: 'backoff-pending' };
}
