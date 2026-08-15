/**
 * Whether a stored semantic index actually contains the paper's body text.
 *
 * The index used to record only *that* an item was indexed, never *what* it
 * was indexed from. That made two very different situations indistinguishable:
 *
 *   - a paper whose PDF/Markdown body was parsed and chunked, and
 *   - a paper whose PDF could not be parsed at all, so the only thing that
 *     reached the embedding API was its title and abstract.
 *
 * Both produced chunks, both were reported as "indexed", and search_fulltext
 * happily dug into the second one and returned metadata as if it were
 * evidence. This module is the single place that decides how that distinction
 * is spelled in `index_status.source_kind` and how it is read back.
 */

/** Body text (PDF / Markdown / plain text / note) reached the index. */
export const INDEX_SOURCE_BODY = 'body';
/**
 * The item HAS a body source, but every extraction path failed, so only
 * title/abstract were indexed. This is a failure, not a success.
 */
export const INDEX_SOURCE_METADATA_ONLY = 'metadata-only';
/**
 * The item offers no body source at all (a bibliography-only record). Not a
 * failure — but still not something search_fulltext may dig into.
 */
export const INDEX_SOURCE_NO_BODY_SOURCE = 'metadata-no-source';

/**
 * Source kinds written before this distinction existed. They say nothing about
 * whether body text was captured, so they are reported as `unknown` and — per
 * the user's decision — treated as "has full text" until the item is next
 * refreshed, at which point it gets a real answer.
 */
export const LEGACY_SOURCE_KINDS = [
  'on-demand',
  'zotero-content-on-demand',
  'legacy-source-on-demand',
  'markdown-on-demand',
];

export type BodyIndexState =
  /** Body text is in the index. */
  | 'body'
  /** A body source exists but could not be parsed; index is metadata only. */
  | 'metadata-only'
  /** No body source exists; index is metadata only, and that is expected. */
  | 'no-source'
  /** Indexed before this distinction was recorded. */
  | 'unknown'
  /** No index_status row at all. */
  | 'missing';

/** The `source_kind` value to persist for a freshly written index. */
export function sourceKindForBodyState(
  state: 'body' | 'metadata-only' | 'no-source',
): string {
  switch (state) {
    case 'body':
      return INDEX_SOURCE_BODY;
    case 'metadata-only':
      return INDEX_SOURCE_METADATA_ONLY;
    case 'no-source':
      return INDEX_SOURCE_NO_BODY_SOURCE;
  }
}

/** Read a persisted `source_kind` back into a body-index state. */
export function bodyIndexStateFromSourceKind(
  sourceKind: string | null | undefined,
): BodyIndexState {
  if (sourceKind === null || sourceKind === undefined || sourceKind === '') {
    return 'missing';
  }
  switch (sourceKind) {
    case INDEX_SOURCE_BODY:
      return 'body';
    case INDEX_SOURCE_METADATA_ONLY:
      return 'metadata-only';
    case INDEX_SOURCE_NO_BODY_SOURCE:
      return 'no-source';
    default:
      // Anything else was written by an older build. It may or may not hold
      // body text; nothing recorded the answer, so it must not be claimed
      // either way.
      return 'unknown';
  }
}

/**
 * May a full-text tool treat this index as containing the paper's body?
 *
 * `unknown` counts as yes deliberately: pre-existing indexes must keep working
 * exactly as they did until the item is refreshed, otherwise upgrading the
 * plugin would break search_fulltext across the whole library at once.
 */
export function hasBodyText(state: BodyIndexState): boolean {
  return state === 'body' || state === 'unknown';
}

/**
 * Does this state mean "we tried to get the body text and failed"? Only these
 * count towards the failure numbers the user sees.
 */
export function isBodyExtractionFailure(state: BodyIndexState): boolean {
  return state === 'metadata-only';
}

/**
 * Full-text availability as a stage-1 candidate row reports it.
 *
 * Refusing at search_fulltext is necessary but too late: by then the AI has
 * already read the candidate row, and a metadata-only paper's row is
 * indistinguishable from a real one — same score, same `matchedBy: semantic`,
 * same `matchedChunks` snippets, which for such a paper ARE its title and
 * abstract. Nothing in the row says so, so the snippets read as passages from
 * the paper. This vocabulary is what makes the difference visible at triage
 * time, before anything gets cited.
 */
export type FullTextAvailability =
  /** Body text is indexed; search_fulltext will work. */
  | 'indexed'
  /** A PDF/Markdown exists but could not be parsed. Metadata only. */
  | 'parse_failed'
  /** No body source at all. Metadata only, and expected. */
  | 'no_source'
  /** Not in the semantic index; matched on metadata by the lexical branch. */
  | 'not_indexed'
  /** Indexed before this was recorded; assume full text until refreshed. */
  | 'unknown';

export function fullTextAvailabilityFromState(
  state: BodyIndexState,
): FullTextAvailability {
  switch (state) {
    case 'body':
      return 'indexed';
    case 'metadata-only':
      return 'parse_failed';
    case 'no-source':
      return 'no_source';
    case 'missing':
      return 'not_indexed';
    default:
      return 'unknown';
  }
}

/** Every value the vocabulary defines, in the order they are reported. */
export const FULL_TEXT_AVAILABILITIES: readonly FullTextAvailability[] = [
  'indexed',
  'parse_failed',
  'no_source',
  'not_indexed',
  'unknown',
];

/**
 * How one page of results breaks down, in exactly the row vocabulary.
 *
 * One key per FullTextAvailability value and no others: a summary that renamed
 * or merged categories would be a second, disagreeing vocabulary. In
 * particular `unknown` is its own count and is never folded into `indexed` —
 * "we know this has body text" and "we never recorded whether it does" are
 * different claims, and reporting the second as the first is precisely the
 * overstatement this whole field exists to prevent.
 *
 * The five counts always sum to the number of rows the page returned.
 */
export type FullTextCoverage = Record<FullTextAvailability, number>;

export function emptyFullTextCoverage(): FullTextCoverage {
  return {
    indexed: 0,
    parse_failed: 0,
    no_source: 0,
    not_indexed: 0,
    unknown: 0,
  };
}

/** Total rows a coverage breakdown accounts for. */
export function fullTextCoverageTotal(coverage: FullTextCoverage): number {
  return FULL_TEXT_AVAILABILITIES.reduce(
    (sum, availability) => sum + coverage[availability],
    0,
  );
}

/** Can a candidate row's evidence be read as body text? */
export function rowHasBodyText(availability: FullTextAvailability): boolean {
  return availability === 'indexed' || availability === 'unknown';
}

/**
 * The per-row warning. Returns undefined only for `indexed` — the one case
 * where the row's evidence is confirmed body text and a note would be noise.
 *
 * The wording has one job: stop the snippets in this row being read as
 * passages from the paper. It says what the row is, what the snippets are,
 * and what will happen if the AI tries to go deeper anyway.
 *
 * `unknown` gets a note too, even though it still passes the full-text gate.
 * Letting a legacy row through unannotated conflates "confirmed body text"
 * with "never recorded either way", which is the same overstatement in a
 * quieter form: those rows may well be title-and-abstract only, and nothing
 * in the response would have said so.
 */
export function describeFullTextAvailability(
  availability: FullTextAvailability,
): string | undefined {
  switch (availability) {
    case 'parse_failed':
      return (
        'NO FULL TEXT: this paper has a PDF/Markdown attachment but it could not be parsed, ' +
        'so only its title and abstract are indexed. Any matchedChunks below are that metadata, ' +
        'NOT passages from the paper — do not quote or cite them as findings, methods or results. ' +
        'search_fulltext will refuse this item; use get_item_abstract if the abstract is enough.'
      );
    case 'no_source':
      return (
        'NO FULL TEXT: this record has no PDF, Markdown or text attachment, so only its title and ' +
        'abstract are indexed. Any matchedChunks below are that metadata, NOT passages from the paper. ' +
        'search_fulltext will refuse this item; use get_item_abstract for what is known about it.'
      );
    case 'not_indexed':
      return (
        'NOT IN THE SEMANTIC INDEX: this item matched on metadata alone. It has no indexed passages, ' +
        'so search_fulltext is unavailable for it until the user builds its index.'
      );
    case 'unknown':
      return (
        'LEGACY INDEX, FULL-TEXT STATUS UNCONFIRMED: this document was indexed before the plugin ' +
        'recorded whether body text was captured, so it may hold the full paper or it may hold only ' +
        'its title and abstract — nothing distinguishes the two here. search_fulltext still works on it, ' +
        'but do not cite its matchedChunks as passages from the paper without checking that they read ' +
        'like body text rather than an abstract. To settle it, ask the user to rebuild this item\'s ' +
        'semantic index (Zotero → item context menu → update semantic index).'
      );
    default:
      return undefined;
  }
}

/**
 * The page-level warning, when some rows cannot back up a full-text claim.
 *
 * Per-row notes can be skimmed past; this one sits with the other warnings the
 * caller is already reading, and names the count so the omission is countable
 * rather than a vague caveat.
 */
export function describePageFullTextGaps(
  counts: FullTextCoverage,
): string | undefined {
  const parts: string[] = [];
  if (counts.parse_failed > 0) {
    parts.push(`${counts.parse_failed} whose PDF/Markdown could not be parsed`);
  }
  if (counts.no_source > 0) {
    parts.push(`${counts.no_source} with no attachment at all`);
  }
  if (counts.not_indexed > 0) {
    parts.push(`${counts.not_indexed} not yet in the semantic index`);
  }
  if (parts.length === 0) return undefined;
  const total =
    counts.parse_failed + counts.no_source + counts.not_indexed;
  return (
    `${total} document(s) on this page have NO indexed full text (${parts.join(', ')}). ` +
    `Each is marked fullText on its row. Their matchedChunks are title/abstract metadata, not body text: ` +
    `do not present them as evidence from the paper, and expect search_fulltext to refuse them.`
  );
}

/**
 * The message a full-text tool returns instead of metadata pretending to be
 * evidence. Written for the MCP client, which is what reads it.
 */
export function describeMissingBodyText(
  itemKey: string,
  state: 'metadata-only' | 'no-source',
): string {
  if (state === 'metadata-only') {
    return (
      `Item ${itemKey} has no indexed body text: its PDF/Markdown could not be parsed, ` +
      `so only the title and abstract were indexed and there are no passages to search. ` +
      `Do not treat its title or abstract as full-text evidence. ` +
      `Tell the user to check this item's PDF (Zotero → item context menu → update semantic index) ` +
      `and use get_item_abstract if the abstract alone is enough.`
    );
  }
  return (
    `Item ${itemKey} has no full text to search: it carries no PDF, Markdown or text attachment, ` +
    `so its semantic index contains only bibliographic metadata. ` +
    `Use get_item_abstract for what is known about it, and do not present metadata as full-text evidence.`
  );
}
