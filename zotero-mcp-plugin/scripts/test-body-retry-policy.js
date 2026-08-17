/* eslint-env node */

/**
 * Items whose body text failed to parse must be reachable by an ORDINARY
 * incremental build — not only by an explicit "retry failed items" run.
 *
 * The regression: `getItemsToSkip` deliberately keeps `metadata-only` and
 * `empty` rows out of the skip set, with a comment saying that is exactly the
 * case a later build should try again. But `indexItemWithProcessor` then hit
 * the timestamp fast path first, and neither the item's nor the PDF's
 * `dateModified` changes when a file is repaired or MinerU is switched on — so
 * every one of those items was answered "unchanged, succeeded" without ever
 * being opened. The exemption above was unreachable, and a failed parse was
 * permanent.
 *
 * The fix must not swing the other way: a healthy indexed document must still
 * cost nothing, and a permanently broken PDF must not be re-parsed on every
 * single pass.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.Zotero = { Libraries: { userLibraryID: 1 } };
globalThis.ztoolkit = { log: () => {} };

const {
  DEFAULT_BODY_RETRY_BACKOFF_MS,
  computeBodyExtractionSignature,
  decideBodyRetry,
  isBodyRetryCandidate,
} = await import("../src/modules/semantic/bodyRetryPolicy.ts");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceSource = fs.readFileSync(
  path.join(root, "src/modules/semantic/semanticSearchService.ts"),
  "utf8",
);
const vectorStoreSource = fs.readFileSync(
  path.join(root, "src/modules/semantic/vectorStore.ts"),
  "utf8",
);

const baseConfig = {
  minerUEnabled: true,
  minerUMode: "cloud",
  minerUBaseURL: "https://example.invalid",
  minerUModelVersion: "vlm",
  minerULanguage: "ch",
  minerUEnableOCR: false,
  minerUEnableFormula: true,
  minerUEnableTable: true,
  minerUTimeoutSeconds: 600,
  minerUMaxFileSizeMB: 50,
  minerUApiToken: "token-a",
};
const SIG = computeBodyExtractionSignature(baseConfig);
const NOW = 1_800_000_000_000;
const secondsAgo = (ms) => Math.floor((NOW - ms) / 1000);

// ---- which rows are candidates at all ----

assert.equal(isBodyRetryCandidate({ sourceKind: "metadata-only" }), true);
assert.equal(isBodyRetryCandidate({ contentHash: "empty" }), true);
assert.equal(
  isBodyRetryCandidate({ sourceKind: "body", contentHash: "abc123" }),
  false,
);
assert.equal(isBodyRetryCandidate(null), false);

// ---- a healthy indexed document is never re-processed ----

{
  const decision = decideBodyRetry({
    status: {
      sourceKind: "body",
      contentHash: "abc123",
      indexedAt: secondsAgo(365 * 24 * 60 * 60 * 1000),
      bodyRetrySignature: null,
    },
    currentSignature: SIG,
    now: NOW,
  });
  assert.deepEqual(
    decision,
    { retry: false, reason: "not-a-retry-candidate" },
    "a document with a real body index must cost an incremental build nothing, " +
      "however old it is and whatever the settings now say",
  );
}

// ---- THE REGRESSION: a parse_failed row whose PDF has not been touched ----

{
  // Exactly the state that used to be unreachable: metadata-only, timestamps
  // unchanged, and a build running without `force`.
  const decision = decideBodyRetry({
    status: {
      sourceKind: "metadata-only",
      contentHash: "hash-of-title-and-abstract",
      indexedAt: secondsAgo(3 * 24 * 60 * 60 * 1000),
      bodyRetrySignature: SIG,
    },
    currentSignature: SIG,
    now: NOW,
  });
  assert.equal(
    decision.retry,
    true,
    "a metadata-only item must be re-attempted by an ordinary incremental build " +
      "once the backoff has elapsed, without the user pressing 'retry failed items'",
  );
  assert.equal(decision.reason, "backoff-elapsed");
}

{
  const decision = decideBodyRetry({
    status: {
      contentHash: "empty",
      sourceKind: "no-source",
      indexedAt: secondsAgo(DEFAULT_BODY_RETRY_BACKOFF_MS + 1000),
      bodyRetrySignature: SIG,
    },
    currentSignature: SIG,
    now: NOW,
  });
  assert.equal(
    decision.retry,
    true,
    "'empty' rows are kept eligible by getItemsToSkip for the same reason and " +
      "must reach extraction too",
  );
}

// ---- changing the parse configuration retries immediately ----

{
  const changed = computeBodyExtractionSignature({
    ...baseConfig,
    minerUEnableOCR: true,
  });
  assert.notEqual(changed, SIG, "OCR must be part of the signature");
  const decision = decideBodyRetry({
    status: {
      sourceKind: "metadata-only",
      indexedAt: secondsAgo(60_000), // one minute ago: well inside the backoff
      bodyRetrySignature: SIG,
    },
    currentSignature: changed,
    now: NOW,
  });
  assert.deepEqual(
    decision,
    { retry: true, reason: "configuration-changed" },
    "turning OCR on is precisely when the outcome can differ, so waiting out a " +
      "backoff would be pointless",
  );
}

{
  // Switching MinerU on, and correcting a rejected API token, are both changes
  // that can fix a failed parse.
  assert.notEqual(
    computeBodyExtractionSignature({ ...baseConfig, minerUEnabled: false }),
    SIG,
  );
  assert.notEqual(
    computeBodyExtractionSignature({
      ...baseConfig,
      minerUApiToken: "token-b",
    }),
    SIG,
  );
  assert.ok(
    !computeBodyExtractionSignature(baseConfig).includes(
      baseConfig.minerUApiToken,
    ),
    "the raw credential must never be written into the signature",
  );
  assert.equal(
    computeBodyExtractionSignature(baseConfig),
    computeBodyExtractionSignature({ ...baseConfig }),
    "the signature must be stable for unchanged settings",
  );
}

// ---- the cost control: no re-parse on every pass ----

{
  const decision = decideBodyRetry({
    status: {
      sourceKind: "metadata-only",
      indexedAt: secondsAgo(60 * 60 * 1000), // an hour ago
      bodyRetrySignature: SIG,
    },
    currentSignature: SIG,
    now: NOW,
  });
  assert.deepEqual(
    decision,
    { retry: false, reason: "backoff-pending" },
    "a permanently broken PDF must not be re-parsed by every incremental build",
  );
}

{
  // Simulate a day of hourly incremental builds against one broken PDF.
  let lastAttemptSeconds = secondsAgo(0);
  let attempts = 0;
  for (let hour = 1; hour <= 26; hour++) {
    const now = NOW + hour * 60 * 60 * 1000;
    const decision = decideBodyRetry({
      status: {
        sourceKind: "metadata-only",
        indexedAt: lastAttemptSeconds,
        bodyRetrySignature: SIG,
      },
      currentSignature: SIG,
      now,
    });
    if (decision.retry) {
      attempts++;
      lastAttemptSeconds = Math.floor(now / 1000);
    }
  }
  assert.equal(
    attempts,
    1,
    "26 hourly builds must cost exactly one re-parse, not 26",
  );
}

// ---- rows predating the column get one retry, then follow the pacing ----

{
  const first = decideBodyRetry({
    status: {
      sourceKind: "metadata-only",
      indexedAt: secondsAgo(60_000),
      bodyRetrySignature: null,
    },
    currentSignature: SIG,
    now: NOW,
  });
  assert.deepEqual(first, { retry: true, reason: "configuration-changed" });

  const second = decideBodyRetry({
    status: {
      sourceKind: "metadata-only",
      indexedAt: secondsAgo(60_000),
      bodyRetrySignature: SIG,
    },
    currentSignature: SIG,
    now: NOW,
  });
  assert.equal(
    second.retry,
    false,
    "once the attempt has stamped a signature, normal pacing takes over",
  );
}

{
  // A missing timestamp must not pin an item to "never retry".
  for (const indexedAt of [undefined, null, 0, Number.NaN]) {
    assert.equal(
      decideBodyRetry({
        status: {
          sourceKind: "metadata-only",
          indexedAt,
          bodyRetrySignature: SIG,
        },
        currentSignature: SIG,
        now: NOW,
      }).retry,
      true,
      `indexedAt=${String(indexedAt)} must not block the retry forever`,
    );
  }
}

// ---- indexItemWithProcessor consults the policy before skipping ----

{
  const start = serviceSource.indexOf("async indexItemWithProcessor(");
  assert.ok(start > 0);
  const body = serviceSource.slice(start, start + 8000);

  const decideAt = body.indexOf("decideBodyRetry({");
  const skipAt = body.indexOf("indexItem() skip: timestamps unchanged");
  assert.ok(
    decideAt > 0 && skipAt > 0 && decideAt < skipAt,
    "the retry decision must be made BEFORE the timestamp fast path returns",
  );
  assert.match(
    body,
    /if \(!needsCheckByTimestamp && !force && !bodyRetry\)/,
    "the fast path must additionally require that this is not a retry candidate",
  );
  assert.match(
    body,
    /bodyRetrySignature,/,
    "each attempt must stamp the configuration it ran under, or the backoff " +
      "can never advance",
  );
}

// ---- the store persists the signature ----

{
  assert.match(
    vectorStoreSource,
    /ALTER TABLE index_status ADD COLUMN body_retry_signature TEXT/,
    "existing databases must be migrated, not just new ones",
  );
  assert.match(
    vectorStoreSource,
    /SELECT item_key, indexed_at, version, chunk_count, content_hash, item_modified, attachment_modified, content_length, source_kind, body_retry_signature FROM index_status/,
    "getIndexStatus must read the column it decides on",
  );
  assert.match(
    vectorStoreSource,
    /source_kind != 'metadata-only'/,
    "getItemsToSkip must still keep metadata-only rows eligible",
  );
}

console.log("body retry policy: all assertions passed");
