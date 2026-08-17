/* eslint-env node */

/**
 * Regression tests for what the semantic index is allowed to contain, and for
 * telling the truth about what it does contain.
 *
 * Four behaviours are covered, each of which used to be wrong:
 *
 *   1. A paper whose PDF/Markdown body could not be parsed was indexed from
 *      its title and abstract and reported as a SUCCESS, and search_fulltext
 *      then dug into it and returned metadata as if it were evidence.
 *   2. Annotation text and comments were concatenated into the body index, and
 *      every annotation edit scheduled an index refresh.
 *   3. Deleting a PDF removed vectors under the ATTACHMENT's key — which never
 *      matched anything — so the deleted PDF's body text stayed in the parent's
 *      index forever.
 *   4. Text preprocessing deleted whole lines for being short, symbol-heavy or
 *      repeated, and whole documents for scoring badly, destroying exactly the
 *      formulas and short headings a materials paper is about.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");

const prefs = new Map();
globalThis.Zotero = {
  Prefs: {
    get: (key) => prefs.get(key),
    set: (key, value) => prefs.set(key, value),
    clear: (key) => prefs.delete(key),
  },
  Libraries: { userLibraryID: 1 },
};
globalThis.ztoolkit = { log: () => {} };

const {
  bodyIndexStateFromSourceKind,
  describeFullTextAvailability,
  describeMissingBodyText,
  describePageFullTextGaps,
  emptyFullTextCoverage,
  fullTextAvailabilityFromState,
  fullTextCoverageTotal,
  hasBodyText,
  isBodyExtractionFailure,
  rowHasBodyText,
  sourceKindForBodyState,
  FULL_TEXT_AVAILABILITIES,
  INDEX_SOURCE_BODY,
  INDEX_SOURCE_METADATA_ONLY,
  INDEX_SOURCE_NO_BODY_SOURCE,
  LEGACY_SOURCE_KINDS,
} = await import("../src/modules/semantic/bodyIndexState.ts");
const { TextQualityPreprocessor, TextChunker } = await import(
  "../src/modules/semantic/textChunker.ts"
);

// ---------------------------------------------------------------------------
// 1. "Indexed" and "has body text" are now different questions
// ---------------------------------------------------------------------------

assert.equal(sourceKindForBodyState("body"), INDEX_SOURCE_BODY);
assert.equal(
  sourceKindForBodyState("metadata-only"),
  INDEX_SOURCE_METADATA_ONLY,
);
assert.equal(
  sourceKindForBodyState("no-source"),
  INDEX_SOURCE_NO_BODY_SOURCE,
);

// A round trip must survive storage, or the flag means nothing.
for (const state of ["body", "metadata-only", "no-source"]) {
  assert.equal(
    bodyIndexStateFromSourceKind(sourceKindForBodyState(state)),
    state,
    `${state} must round-trip through source_kind`,
  );
}

assert.equal(bodyIndexStateFromSourceKind(null), "missing");
assert.equal(bodyIndexStateFromSourceKind(""), "missing");
// Rows written before the distinction existed say nothing either way.
for (const legacy of LEGACY_SOURCE_KINDS) {
  assert.equal(
    bodyIndexStateFromSourceKind(legacy),
    "unknown",
    `${legacy} predates the flag and must report unknown`,
  );
}

// Only a real body, or a legacy row, may be treated as full text. This is the
// single check search_fulltext depends on.
assert.equal(hasBodyText("body"), true);
assert.equal(hasBodyText("unknown"), true, "existing indexes keep working");
assert.equal(hasBodyText("metadata-only"), false);
assert.equal(hasBodyText("no-source"), false);
assert.equal(hasBodyText("missing"), false);

// Only a failed parse counts as a failure. A bibliography-only record is not
// a failure, or the failure number would be dominated by items nobody can fix.
assert.equal(isBodyExtractionFailure("metadata-only"), true);
assert.equal(isBodyExtractionFailure("no-source"), false);
assert.equal(isBodyExtractionFailure("body"), false);
assert.equal(isBodyExtractionFailure("unknown"), false);

// The refusal has to tell the two cases apart: one means "check your PDF",
// the other means "there was never a PDF".
const parseFailure = describeMissingBodyText("ABCD1234", "metadata-only");
assert.match(parseFailure, /ABCD1234/);
assert.match(parseFailure, /could not be parsed/i);
assert.match(parseFailure, /not treat its title or abstract as full-text/i);
const noSource = describeMissingBodyText("ABCD1234", "no-source");
assert.match(noSource, /no full text to search/i);
assert.doesNotMatch(noSource, /could not be parsed/i);

// ---------------------------------------------------------------------------
// 1b. Stage-1 rows must carry the same fact, at triage time
// ---------------------------------------------------------------------------
//
// Refusing at search_fulltext is necessary but late: the candidate row has
// already been read by then. A metadata-only paper ranks and reads exactly
// like a real one, and its matchedChunks ARE its title and abstract, so
// without a per-row flag the abstract can be cited as the paper's findings
// before search_fulltext is ever called.

assert.equal(fullTextAvailabilityFromState("body"), "indexed");
assert.equal(fullTextAvailabilityFromState("metadata-only"), "parse_failed");
assert.equal(fullTextAvailabilityFromState("no-source"), "no_source");
assert.equal(fullTextAvailabilityFromState("missing"), "not_indexed");
assert.equal(fullTextAvailabilityFromState("unknown"), "unknown");

// The row-level verdict must agree with the gate search_fulltext applies, or
// the AI is promised something the next call will refuse.
for (const state of ["body", "metadata-only", "no-source", "missing", "unknown"]) {
  assert.equal(
    rowHasBodyText(fullTextAvailabilityFromState(state)),
    hasBodyText(state),
    `row and search_fulltext must agree about ${state}`,
  );
}

// Only a confirmed full-text row carries no note: a warning on every row is
// noise, and noise is skimmed past.
assert.equal(describeFullTextAvailability("indexed"), undefined);

// `unknown` still PASSES the gate — legacy indexes must keep working — but it
// is annotated, because "never recorded either way" is not the same claim as
// "confirmed body text", and letting it through silently is that same
// overstatement in a quieter form.
{
  const legacy = describeFullTextAvailability("unknown");
  assert.ok(legacy, "a legacy row must carry a caveat even though it is allowed");
  assert.match(legacy, /LEGACY INDEX/);
  assert.match(legacy, /UNCONFIRMED/);
  assert.match(legacy, /search_fulltext still works/);
  assert.match(legacy, /do not cite its matchedChunks as passages/i);
  assert.match(legacy, /rebuild this item's semantic index/i);
  // It must NOT claim the chunks are metadata: that is not established either.
  assert.doesNotMatch(legacy, /NO FULL TEXT/);
}
// The gate itself is unchanged by the note.
assert.equal(rowHasBodyText("unknown"), true);
assert.equal(hasBodyText("unknown"), true);

// The others must say all three things: no full text, the snippets are
// metadata, and going deeper will not work.
for (const availability of ["parse_failed", "no_source"]) {
  const note = describeFullTextAvailability(availability);
  assert.match(note, /NO FULL TEXT/);
  assert.match(note, /matchedChunks below are that metadata/);
  assert.match(note, /NOT passages from the paper/);
  assert.match(note, /search_fulltext will refuse/);
}
assert.match(describeFullTextAvailability("not_indexed"), /NOT IN THE SEMANTIC INDEX/);
// The two reasons stay distinguishable: one is "check your PDF", the other is
// "there was never a PDF".
assert.match(describeFullTextAvailability("parse_failed"), /could not be parsed/);
assert.doesNotMatch(describeFullTextAvailability("no_source"), /could not be parsed/);

// ---- ONE vocabulary, used by both the row and the page summary ----

// The per-page breakdown must be keyed by exactly the five values a row's
// `fullText` can take: no renamed key, no merged category, nothing extra.
assert.deepEqual(
  [...FULL_TEXT_AVAILABILITIES],
  ["indexed", "parse_failed", "no_source", "not_indexed", "unknown"],
);
assert.deepEqual(
  Object.keys(emptyFullTextCoverage()).sort(),
  [...FULL_TEXT_AVAILABILITIES].sort(),
  "fullTextCoverage keys must be exactly the row vocabulary",
);
// Every value a row can carry has a home in the summary, and vice versa.
for (const state of ["body", "metadata-only", "no-source", "missing", "unknown"]) {
  const availability = fullTextAvailabilityFromState(state);
  assert.ok(
    availability in emptyFullTextCoverage(),
    `${availability} must be countable in fullTextCoverage`,
  );
}
assert.equal(fullTextCoverageTotal(emptyFullTextCoverage()), 0);

// hybridCandidates.ts re-declares the union rather than importing it (it is
// the XPCOM-free pure layer the Node tests load). TypeScript cannot catch the
// two drifting apart, so it is checked here against the single source.
{
  const candidatesSource = read("src/modules/hybridCandidates.ts");
  const declared = candidatesSource
    .slice(
      candidatesSource.indexOf("export type FullTextAvailability ="),
      candidatesSource.indexOf("export interface HybridCandidate"),
    )
    .match(/"([a-z_]+)"/g)
    .map((quoted) => quoted.replace(/"/g, ""));
  assert.deepEqual(
    declared.sort(),
    [...FULL_TEXT_AVAILABILITIES].sort(),
    "the row type and the state vocabulary must list exactly the same values",
  );
}

// unknown is its own count. Folding it into `indexed` would report "we know
// this has body text" for rows where nothing was ever recorded.
{
  const coverage = emptyFullTextCoverage();
  coverage.indexed = 4;
  coverage.unknown = 3;
  coverage.parse_failed = 2;
  coverage.no_source = 1;
  coverage.not_indexed = 1;
  assert.equal(fullTextCoverageTotal(coverage), 11, "the five counts sum to the page");
  assert.equal(coverage.indexed, 4, "unknown must never be added to indexed");
  assert.equal("withFullText" in coverage, false);
}

// Page level: silent when the whole page is fine, countable when it is not.
// The page warning is specifically about rows with NO full text, so `unknown`
// stays out of that count — it is allowed through the gate. Legacy rows are
// still not invisible: they carry their own fullTextNote and are their own
// entry in fullTextCoverage.
assert.equal(
  describePageFullTextGaps({ ...emptyFullTextCoverage(), indexed: 5, unknown: 2 }),
  undefined,
);
const pageWarning = describePageFullTextGaps({
  ...emptyFullTextCoverage(),
  indexed: 14,
  parse_failed: 3,
  no_source: 1,
  not_indexed: 2,
});
assert.match(pageWarning, /6 document\(s\) on this page have NO indexed full text/);
assert.match(pageWarning, /3 whose PDF\/Markdown could not be parsed/);
assert.match(pageWarning, /1 with no attachment at all/);
assert.match(pageWarning, /2 not yet in the semantic index/);
assert.match(pageWarning, /not body text/);
// Only the categories that actually occurred are named.
assert.doesNotMatch(
  describePageFullTextGaps({ ...emptyFullTextCoverage(), parse_failed: 2 }),
  /no attachment at all|not yet in the semantic index/,
);

// Model of annotateFullTextAvailability: every row is annotated and counted
// exactly once, so the totals can never disagree with the rows returned.
function annotatePage(states) {
  const coverage = emptyFullTextCoverage();
  const rows = states.map((state) => {
    const availability =
      state === null ? "unknown" : fullTextAvailabilityFromState(state);
    coverage[availability] += 1;
    return {
      fullText: availability,
      fullTextNote: describeFullTextAvailability(availability),
    };
  });
  return { rows, coverage };
}
{
  const page = annotatePage([
    "body",
    "body",
    "metadata-only",
    "no-source",
    "missing",
    "unknown",
  ]);
  assert.equal(fullTextCoverageTotal(page.coverage), page.rows.length);
  assert.deepEqual(page.coverage, {
    indexed: 2,
    parse_failed: 1,
    no_source: 1,
    not_indexed: 1,
    unknown: 1,
  });
  // `indexed` is the only value that goes without a note. Every other row,
  // including the legacy one that is still allowed through, says something.
  assert.equal(page.rows[0].fullTextNote, undefined);
  for (const index of [2, 3, 4, 5]) {
    assert.ok(
      page.rows[index].fullTextNote,
      `row ${index} (${page.rows[index].fullText}) must carry a note`,
    );
  }
  assert.match(page.rows[5].fullTextNote, /LEGACY INDEX/);
}
// The lookup-failed path: every row reported and counted as unknown, never
// silently dropped and never upgraded to indexed.
{
  const page = annotatePage([null, null, null]);
  assert.equal(fullTextCoverageTotal(page.coverage), 3);
  assert.equal(page.coverage.unknown, 3);
  assert.equal(page.coverage.indexed, 0);
}
// An empty page still yields a well-formed, all-zero breakdown.
{
  const page = annotatePage([]);
  assert.equal(fullTextCoverageTotal(page.coverage), 0);
  assert.deepEqual(Object.keys(page.coverage).sort(), [...FULL_TEXT_AVAILABILITIES].sort());
}

// ---------------------------------------------------------------------------
// 2. The indexer records the state, counts the failure, and retries it
// ---------------------------------------------------------------------------

const serviceSource = read("src/modules/semantic/semanticSearchService.ts");
const vectorStoreSource = read("src/modules/semantic/vectorStore.ts");
const deepDiveSource = read("src/modules/documentDeepDive.ts");
const hooksSourceForCounters = read("src/hooks.ts");

// The extraction result must carry provenance; a bare string cannot express
// "we got nothing but there was something to get".
assert.match(
  serviceSource,
  /extractItemContent\([\s\S]{0,200}?\): Promise<ExtractedItemContent>/,
  "extractItemContent must report where the text came from",
);
assert.match(serviceSource, /const bodyState = classifyExtractedContent\(extracted\);/);
assert.match(serviceSource, /const sourceKind = sourceKindForBodyState\(bodyState\);/);

// Every index write must carry the computed state, not a fixed string.
assert.doesNotMatch(
  serviceSource,
  /sourceKind: 'zotero-content-on-demand'/,
  "no write may hard-code the old provenance-free source kind",
);
const writeCount = (serviceSource.match(/^\s+sourceKind,$/gm) || []).length;
assert.ok(
  writeCount >= 2,
  `both replaceItemIndex writes must pass the computed sourceKind (found ${writeCount})`,
);

// A metadata-only result is counted, but it is a CONTENT problem, not an
// indexing failure: the index row is complete and consistent, so it must not
// fail the build and must not withhold the chunking signature.
assert.match(serviceSource, /private noteBodyExtractionOutcome\(/);
assert.match(
  serviceSource,
  /if \(bodyState !== 'metadata-only'\) return outcome;/,
);
// Scoped to the method body, so these cannot be satisfied or broken by
// unrelated code elsewhere in the file.
const noteBodyStart = serviceSource.indexOf("private noteBodyExtractionOutcome(");
assert.ok(noteBodyStart !== -1);
const noteBodyEnd = serviceSource.indexOf("\n  }\n", noteBodyStart);
assert.ok(noteBodyEnd > noteBodyStart);
const noteBody = serviceSource.slice(noteBodyStart, noteBodyEnd);

assert.match(
  noteBody,
  /this\.indexProgress\.bodyFailures =\s*\r?\n?\s*\(this\.indexProgress\.bodyFailures \|\| 0\) \+ 1;/,
  "a failed body parse must move its own counter",
);
assert.doesNotMatch(
  noteBody,
  /recordFailedItem/,
  "a failed body parse must NOT be written to index_failures: it would fail the build",
);
assert.doesNotMatch(
  noteBody,
  /status: 'failed'/,
  "a failed body parse must not turn the item's outcome into a failure",
);
assert.match(
  noteBody,
  /return outcome;\s*$/,
  "the outcome must be passed straight through",
);
// Every success path funnels through it, so none of them can skip the count.
const settleCalls = (
  serviceSource.match(/return this\.noteBodyExtractionOutcome\(/g) || []
).length;
assert.ok(
  settleCalls >= 3,
  `all indexItemWithProcessor success paths must go through noteBodyExtractionOutcome (found ${settleCalls})`,
);

// Real indexing failures — embedding, database, interruption — keep the old
// path: thrown, recorded in index_failures, build target marked failed.
assert.match(
  serviceSource,
  /await this\.recordFailedItem\(item, error, 'unknown'\);\s*\r?\n\s*return \{ status: 'failed', error \};/,
  "infrastructure failures must still fail the item and the build",
);
assert.match(
  vectorStoreSource,
  /recordFailedItem[\s\S]{0,700}?UPDATE index_build_targets SET state = 'failed'/,
  "a recorded failure must still mark its build target failed",
);
// ...and a failed build still withholds the chunking signature.
const settingsSource = read("src/modules/hybridSearchSettings.ts");
assert.match(
  settingsSource,
  /shouldRecordFullLibraryChunkingSignature[\s\S]{0,400}?params\.status === "completed"[\s\S]{0,200}?params\.failedCount === 0/,
);

// The number the user sees has to move, and it is reported apart from the
// failure count.
assert.match(serviceSource, /bodyFailures\?: number;/);
assert.match(hooksSourceForCounters, /merged\.bodyFailures \+= result\?\.bodyFailures \?\? 0;/);
assert.match(
  hooksSourceForCounters,
  /const bodyFailures = result\?\.bodyFailures \?\? 0;/,
  "the completion notice must report body failures separately from failed items",
);

// A metadata-only row must stay eligible for a retry: the PDF may be fixed,
// or MinerU switched on, later. Automatic (incremental builds) and manual
// (the retry entry point) both have to reach it.
assert.match(
  vectorStoreSource,
  /getItemsToSkip[\s\S]{0,900}?source_kind != 'metadata-only'/,
  "incremental builds must retry items whose body text failed",
);
assert.match(
  vectorStoreSource,
  /async getMetadataOnlyItems\(/,
  "the retry path needs a way to enumerate items still stuck on metadata",
);
assert.match(
  serviceSource,
  /retryFailedItems[\s\S]{0,2000}?await this\.vectorStore\.getMetadataOnlyItems\(\)/,
  "an explicit retry must also pick up body-text failures",
);

// The precondition: a body parse that has just failed must never leave the
// previous body vectors behind. The unchanged-hash shortcut writes no
// vectors, so it must be bypassed whenever the stored index might still hold
// a body — otherwise a completed rebuild could record its chunking signature
// over chunks produced by the old rules.
assert.match(
  serviceSource,
  /const mustClearStaleBody =\s*\r?\n?\s*bodyState === 'metadata-only' && storedBodyState !== 'metadata-only';/,
);
assert.match(
  serviceSource,
  /if \(!needsIndex && !mustClearStaleBody\) \{/,
  "the shortcut must be skipped when stale body vectors could survive it",
);
// ...and the long way round really does clear them, atomically.
assert.match(
  vectorStoreSource,
  /replaceItemIndex[\s\S]{0,600}?executeTransaction[\s\S]{0,200}?DELETE FROM embeddings WHERE item_key = \?[\s\S]{0,120}?DELETE FROM vectors_f32 WHERE item_key = \?/,
  "replaceItemIndex must delete every old vector for the item before writing",
);
// The empty-content path clears them too, by replacing with no records.
assert.match(
  serviceSource,
  /if \(!content\.trim\(\)\) \{[\s\S]{0,300}?records: \[\],/,
);

// Stage 1 must annotate every row it returns — on page 1 AND on cursor pages,
// since a metadata-only paper is just as likely to sit on page 2.
const mcpSource = read("src/modules/streamableMCPServer.ts");
assert.match(mcpSource, /private async annotateFullTextAvailability\(/);
assert.match(
  mcpSource,
  /enrichHybridResults[\s\S]{0,600}?await this\.annotateFullTextAvailability\(/,
  "hybrid rows must be annotated during enrichment",
);
assert.match(
  mcpSource,
  /enrichSimilarResults[\s\S]{0,600}?await this\.annotateFullTextAvailability\(/,
  "find_similar rows are the same triage stage and need the same annotation",
);
// Four sites, and the count is the assertion: hybrid_search page 1, its
// cursor pages, and the same two for the single-branch pipeline that
// semantic_search and keyword_search share. Every path that returns candidate
// rows must annotate them — a metadata-only paper is just as likely to sit on
// page 2 of a semantic search as on page 1 of a hybrid one, and it was
// semantic_search returning UNannotated rows that let an abstract be read as
// body text.
assert.equal(
  (
    mcpSource.match(
      /const fullTextCoverage = await this\.enrichHybridResults\(/g,
    ) || []
  ).length,
  4,
  "every first page and cursor page must compute the coverage breakdown",
);
assert.equal(
  (mcpSource.match(/fullTextCoverage,\r?\n\s+\);/g) || []).length,
  4,
  "every page must pass the coverage into its response builder",
);
// The summary is emitted verbatim: no renaming, no derived count, no merging.
assert.match(
  mcpSource,
  /\r?\n\s+fullTextCoverage,\r?\n/,
  "metadata.fullTextCoverage must be the breakdown itself, shorthand-assigned",
);
assert.match(mcpSource, /const coverage = emptyFullTextCoverage\(\);/);
assert.match(
  mcpSource,
  /coverage\[availability\] \+= 1;/,
  "every row must be counted exactly once, under its own value",
);
// A lookup failure must not silently claim every row has full text — it is
// reported as unknown, and still counted.
assert.match(mcpSource, /: 'unknown';\r?\n\s+result\.fullText = availability;/);

// No stale vocabulary anywhere: a second name for the same thing is how the
// row and the summary drift apart again.
for (const file of [
  "src/modules/streamableMCPServer.ts",
  "src/modules/hybridCandidates.ts",
  "src/modules/semantic/bodyIndexState.ts",
  "src/modules/semantic/index.ts",
]) {
  assert.doesNotMatch(
    read(file),
    /withFullText/,
    `${file} must not carry the old coverage field name`,
  );
}
// The batched lookup, so a 20-row page is one query rather than twenty.
assert.match(vectorStoreSource, /async getSourceKinds\(/);
assert.match(serviceSource, /async getItemBodyIndexStates\(/);
// An item with no row must come back as 'missing', not be dropped: "absent
// from the map" must never be readable as "has full text".
assert.match(
  serviceSource,
  /sourceKinds\.has\(mapKey\)\s*\r?\n?\s*\?[\s\S]{0,120}?: 'missing',/,
);
// The tool descriptions have to point at the field, or it is just another
// unread key in the JSON.
assert.match(
  mcpSource,
  /Read fullText before you read matchedChunks/,
  "hybrid_search must tell the caller to read fullText first",
);
// find_similar's description lives in the shared tool catalog, which is what
// tools/list and /capabilities both project from.
const catalogSource = read("src/modules/toolCatalog.ts");
assert.match(
  catalogSource,
  /WHAT COMES BACK[\s\S]{0,300}?fullText/,
  "find_similar must document the field too",
);
// The two retrieval tools that share the single-branch pipeline return the
// same rows, so they owe the caller the same instruction. semantic_search
// returning unannotated rows is precisely how an abstract could be read as a
// paper's body.
for (const tool of ["keyword_search", "semantic_search"]) {
  const block = catalogSource.slice(
    catalogSource.indexOf(`name: '${tool}'`),
    catalogSource.indexOf("inputSchema", catalogSource.indexOf(`name: '${tool}'`)),
  );
  assert.match(
    block,
    /fullText/,
    `${tool} must document the full-text status on its rows`,
  );
}

// search_fulltext refuses rather than passing metadata off as passages.
assert.match(deepDiveSource, /async function assertBodyTextIndexed\(/);
// Both entry points gate on it, and both keep the caveat it returns for a
// legacy index rather than dropping it on the floor.
assert.equal(
  (
    deepDiveSource.match(
      /const legacyIndexWarning = await assertBodyTextIndexed\(/g,
    ) || []
  ).length,
  2,
  "runDocumentDeepDive and expandChunkContext must both gate and both keep the caveat",
);
assert.equal(
  (deepDiveSource.match(/if \(legacyIndexWarning\) warnings\./g) || []).length,
  2,
  "the legacy caveat must reach the warnings of both entry points",
);
// The gate still lets a legacy index through: the caveat is a warning, never
// a refusal.
assert.match(
  deepDiveSource,
  /if \(state === "unknown"\) \{\s*\r?\n\s*return describeFullTextAvailability\("unknown"\);/,
);

// ---------------------------------------------------------------------------
// 2b. The two kinds of failure land in different buckets
// ---------------------------------------------------------------------------

const { shouldRecordFullLibraryChunkingSignature } = await import(
  "../src/modules/hybridSearchSettings.ts"
);

// A full-library rebuild of 100 papers, 7 of which have unreadable PDFs.
// Every row was written, every stale body vector was cleared, the run is
// internally consistent: the signature must be recorded, or a library with one
// broken PDF carries a permanent "chunk settings changed" warning.
assert.equal(
  shouldRecordFullLibraryChunkingSignature({
    rebuild: true,
    itemKeysProvided: false,
    status: "completed",
    processed: 100,
    total: 100,
    failedCount: 0, // body failures do not go here
  }),
  true,
  "body-text failures must not withhold the chunking signature",
);

// The same run with one embedding/database/interruption failure: the index may
// be incomplete, so nothing may be recorded.
assert.equal(
  shouldRecordFullLibraryChunkingSignature({
    rebuild: true,
    itemKeysProvided: false,
    status: "failed",
    processed: 99,
    total: 100,
    failedCount: 1,
  }),
  false,
  "an infrastructure failure must still withhold the chunking signature",
);
assert.equal(
  shouldRecordFullLibraryChunkingSignature({
    rebuild: true,
    itemKeysProvided: false,
    status: "aborted",
    processed: 40,
    total: 100,
    failedCount: 0,
  }),
  false,
  "an interrupted run must still withhold the chunking signature",
);

// Model of the per-item accounting, mirroring indexItemWithProcessor.
function accountForItem({ bodyState, thrown }) {
  if (thrown) return { outcome: "failed", failedCount: 1, bodyFailures: 0 };
  if (bodyState === "metadata-only") {
    return { outcome: "succeeded", failedCount: 0, bodyFailures: 1 };
  }
  return { outcome: "succeeded", failedCount: 0, bodyFailures: 0 };
}

assert.deepEqual(accountForItem({ bodyState: "body" }), {
  outcome: "succeeded",
  failedCount: 0,
  bodyFailures: 0,
});
assert.deepEqual(
  accountForItem({ bodyState: "metadata-only" }),
  { outcome: "succeeded", failedCount: 0, bodyFailures: 1 },
  "a failed PDF parse is counted, but does not fail the item",
);
assert.deepEqual(
  accountForItem({ bodyState: "no-source" }),
  { outcome: "succeeded", failedCount: 0, bodyFailures: 0 },
  "a bibliography-only record is neither a failure nor a body failure",
);
assert.deepEqual(
  accountForItem({ bodyState: "body", thrown: true }),
  { outcome: "failed", failedCount: 1, bodyFailures: 0 },
  "an embedding or database error is still a real failure",
);

// ---------------------------------------------------------------------------
// 3. Annotations are out of the body index entirely
// ---------------------------------------------------------------------------

for (const forbidden of ["annotationText", "annotationComment", "getAnnotations"]) {
  assert.doesNotMatch(
    serviceSource,
    new RegExp(`\\b${forbidden}\\b`),
    `${forbidden} must not appear anywhere in the semantic indexer`,
  );
}
assert.doesNotMatch(
  serviceSource,
  /item\.isAnnotation\?\.\(\)/,
  "an annotation item must no longer be indexed as content either",
);

// The separate annotation MCP tools are untouched — this change must not take
// Zotero's own annotation features with it.
const annotationServiceSource = read("src/modules/annotationService.ts");
assert.match(annotationServiceSource, /annotationText/);
assert.match(annotationServiceSource, /getAnnotations\(\)/);

const hooksSource = read("src/hooks.ts");
// Annotation events must not schedule an index refresh any more.
assert.match(
  hooksSource,
  /if \(item\.isAnnotation\?\.\(\)\) continue;/,
  "modified annotations must be skipped by the auto-update queue",
);
assert.equal(
  (hooksSource.match(/isAnnotation\?\.\(\)\) continue;/g) || []).length >= 2,
  true,
  "both the add path and the modify path must skip annotations",
);
assert.doesNotMatch(
  hooksSource,
  /item\.parentItem\?\.parentItem\?\.key/,
  "walking up from an annotation to its paper is no longer a reason to reindex",
);

// ---------------------------------------------------------------------------
// 4. Deleting a PDF updates the PARENT's index, not the attachment's key
// ---------------------------------------------------------------------------

// The trash step counts, not just the permanent erase: moving a PDF to the
// trash already removes it from getAttachments().
assert.match(hooksSource, /event === 'trash'/);
assert.match(hooksSource, /queueModifiedItems\(numericIds, \{ trashed: true \}\)/);
assert.match(
  hooksSource,
  /const removedFromLibrary = options\.trashed === true \|\| item\.deleted === true;/,
);
// A trashed child no longer falls out of the queue at the `deleted` guard.
assert.doesNotMatch(
  hooksSource,
  /if \(item\.deleted\) continue;\r?\n\r?\n\s+if \(item\.isRegularItem/,
  "a trashed attachment must not be skipped before its parent is queued",
);

// The parent has to be recoverable at erase time, when the row is gone.
assert.match(hooksSource, /const childParentMemory = new Map</);
assert.match(hooksSource, /function rememberChildParent\(item: any\): void/);
assert.match(
  hooksSource,
  /oldData\?\.parentItem \|\|[\s\S]{0,120}remembered\?\.parentKey/,
  "the deleted child's parent must be read from extraData or from memory",
);
// And the rebuild must be forced, because the parent's own timestamps did not
// move even though its body text did.
assert.match(
  hooksSource,
  /scheduleAutoUpdate\(owner\.key, owner\.libraryID, true\)/,
  "the parent rebuild after an erased child must bypass the timestamp fast path",
);

// Model of the routing, mirroring handleItemsDeleted, so the decisions are
// checked and not just their source text.
function routeDeletion({ oldData, remembered, resolveOwner }) {
  const parentKey =
    oldData?.parentItem ||
    oldData?.parentKey ||
    oldData?.parentItemKey ||
    remembered?.parentKey ||
    null;
  if (!parentKey) {
    return oldData?.key
      ? { action: "delete-index", key: oldData.key }
      : { action: "ignore" };
  }
  if (remembered?.isAnnotation) return { action: "ignore" };
  const owner = resolveOwner(parentKey);
  if (!owner) return { action: "delete-index", key: parentKey };
  if (!owner.isRegularItem) return { action: "ignore" };
  return { action: "rebuild-parent", key: owner.key, force: true };
}

const paper = { key: "PAPER001", isRegularItem: true };
const attachment = { key: "ATTACH01", isRegularItem: false };
const ownerOf = (key) =>
  ({ PAPER001: paper, ATTACH01: attachment })[key] || null;

// A PDF erased from a paper that still exists: rebuild the paper.
assert.deepEqual(
  routeDeletion({
    oldData: { key: "PDFKEY01", libraryID: 1, parentItem: "PAPER001" },
    resolveOwner: ownerOf,
  }),
  { action: "rebuild-parent", key: "PAPER001", force: true },
);

// Same, when Zotero's extraData carried no parent at all.
assert.deepEqual(
  routeDeletion({
    oldData: { key: "PDFKEY01", libraryID: 1 },
    remembered: { parentKey: "PAPER001", libraryID: 1, isAnnotation: false },
    resolveOwner: ownerOf,
  }),
  { action: "rebuild-parent", key: "PAPER001", force: true },
  "the remembered parent is what makes this work when extraData is thin",
);

// A top-level item: its own index goes.
assert.deepEqual(
  routeDeletion({ oldData: { key: "PAPER001", libraryID: 1 }, resolveOwner: ownerOf }),
  { action: "delete-index", key: "PAPER001" },
);

// Paper and PDF erased together: nothing to rebuild, only to remove.
assert.deepEqual(
  routeDeletion({
    oldData: { key: "PDFKEY01", libraryID: 1, parentItem: "GONE0001" },
    resolveOwner: ownerOf,
  }),
  { action: "delete-index", key: "GONE0001" },
);

// An annotation: its parent is an attachment, and annotations no longer feed
// the index, so nothing happens.
assert.deepEqual(
  routeDeletion({
    oldData: { key: "ANNOT001", libraryID: 1, parentItem: "ATTACH01" },
    resolveOwner: ownerOf,
  }),
  { action: "ignore" },
);
assert.deepEqual(
  routeDeletion({
    oldData: { key: "ANNOT001", libraryID: 1 },
    remembered: { parentKey: "ATTACH01", libraryID: 1, isAnnotation: true },
    resolveOwner: ownerOf,
  }),
  { action: "ignore" },
);

// A surviving MinerU Markdown keeps the paper searchable after its PDF is
// gone, so the indexer must read Markdown attachments in their own right and
// not only through the PDF they were generated from.
assert.match(
  serviceSource,
  /const GENERATED_MARKDOWN_TITLE = \/\^MinerU Markdown/,
);
assert.match(serviceSource, /markdownAttachments\.push\(attachment\)/);
assert.match(
  serviceSource,
  /markdownToIndexText\(String\(raw\)\)/,
  "a Markdown attachment must be read directly, not via its deleted PDF",
);
// ...but it must not be indexed twice when the PDF is still there and parsed.
assert.match(
  serviceSource,
  /if \(sourcePDFKey && pdfKeysWithText\.has\(sourcePDFKey\)\) \{[\s\S]{0,120}continue;/,
);

// ---------------------------------------------------------------------------
// 5. Preprocessing only touches whitespace
// ---------------------------------------------------------------------------

const KEEP = [
  "γ′", // two characters, no letters or digits: the old rule deleted it
  "α",
  "σ = E·ε",
  "$$\\Delta G = \\Delta H - T\\Delta S$$",
  "2.1", // short numeric heading
  "→←↑↓",
  "【表 1】",
  "----|----|----", // a Markdown table separator row
  "()[]{}<>", // pure symbols: 0% "valid characters"
];

for (const line of KEEP) {
  const { text, quality } = TextQualityPreprocessor.process(
    `Introduction paragraph.\n${line}\nNext paragraph of the body text.`,
  );
  assert.ok(
    text.includes(line),
    `preprocessing must keep the line ${JSON.stringify(line)}`,
  );
  assert.equal(quality.shouldIndex, true);
}

// A line repeating more than three times used to be deleted as a header or
// footer whenever it was a small enough share of the document. Sized so the
// old rule's "did we remove too much" guard would NOT have saved it: 4 repeats
// among 50 body lines is well under the 10% it tolerated.
const bodyLines = Array.from(
  { length: 50 },
  (_, i) => `Body line ${i} describing the microstructure.`,
);
for (const at of [0, 13, 26, 39]) {
  bodyLines.splice(at, 0, "Journal of Alloys and Compounds");
}
const repeatedOut = TextQualityPreprocessor.process(bodyLines.join("\n")).text;
assert.equal(
  (repeatedOut.match(/Journal of Alloys and Compounds/g) || []).length,
  4,
  "repeated lines must no longer be treated as removable headers/footers",
);

// A document that scores badly is still indexed. This is the rule that used to
// silently discard whole scanned papers.
const noisy = "...,,,;;;::: ((( ))) [[[ ]]] ,,,...";
const noisyResult = TextQualityPreprocessor.process(noisy);
assert.equal(
  noisyResult.quality.shouldIndex,
  true,
  "a low-quality score must no longer discard the document",
);
assert.ok(
  noisyResult.quality.score < 100,
  "the score is still computed, it just does not decide any more",
);
assert.equal(TextQualityPreprocessor.process("   \n\t\n  ").quality.shouldIndex, false);

// A short document is indexed too; the old floor was 50 characters.
const short = TextQualityPreprocessor.process("γ′ 相析出行为");
assert.equal(short.quality.shouldIndex, true);
assert.ok(short.quality.issues.includes("short_document"));

// Whitespace-only lines are normalised, and blank lines survive as the
// paragraph separator the chunker splits on. Fusing paragraphs here would
// change chunking, which must not change.
const spaced = "Para one.\n   \n\n\n\nPara two.\n \nPara three.";
const spacedOut = TextQualityPreprocessor.process(spaced).text;
assert.equal(spacedOut, "Para one.\n\nPara two.\n\nPara three.");
assert.doesNotMatch(spacedOut, /\r?\n{3,}/);

// End to end: the chunker keeps every line, in reading order, and the
// existing paragraph rules still apply.
const chunker = new TextChunker({
  targetChunkSize: 1000,
  appendToleranceSize: 500,
});
const document = [
  "# 1 引言",
  "",
  "γ′",
  "",
  "沉淀强化相 γ′ 的体积分数决定了合金的高温强度。",
  "",
  "α",
  "",
  "σ = E·ε",
].join("\n");
const chunks = chunker.chunk(document);
const joined = chunks.join("\n");
for (const fragment of ["γ′", "α", "σ = E·ε", "# 1 引言"]) {
  assert.ok(
    joined.includes(fragment),
    `chunking must preserve ${JSON.stringify(fragment)}`,
  );
}

console.log("Body-index and preprocessing regression tests passed");
