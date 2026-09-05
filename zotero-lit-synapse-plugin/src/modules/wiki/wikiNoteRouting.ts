/**
 * Which reading note a new record belongs in.
 *
 * A concluded note cannot be appended to - the append-only guarantee is what
 * makes a reading note evidence rather than a draft - so reading that arrives
 * after a whole-paper pass has to go somewhere. It opens a new note beside the
 * finished one. That is the "episode" mechanism, and this module is the part of
 * it that DECIDES, kept separate from the part that reads and writes files.
 *
 * It was inline in `WikiService.routeReadingRecord`, wrapped around attachment
 * listing, note parsing and an embedding call, so nothing here could be tested
 * without a Zotero and an embedding service. Four branches, an unreadable-note
 * fallback whose whole purpose is to avoid silent data loss, and a similarity
 * comparison that must take the CLOSEST note rather than the average one - all
 * of it decision logic, none of it reachable by a test. Splitting it out is
 * what makes the rules below assertable.
 */

/** One existing note, already read and parsed by the caller. */
export interface RoutableNote<TAttachment = unknown> {
  attachment: TAttachment;
  /** A note with a whole-paper summary. Nothing may be appended to it. */
  concluded: boolean;
  /** Every chunk id any record in this note cites. */
  chunkIds: ReadonlySet<number>;
  /** The text of the records that touch the chunks now being recorded. */
  related: string;
}

export interface NoteRoute<TAttachment = unknown> {
  /** The note to append to. `null` means "the session's current note". */
  attachment: TAttachment | null;
  /** Open a new note beside the finished ones. */
  startNewEpisode: boolean;
  /** False when this record says nothing a note does not already say. */
  write: boolean;
  similarity: number | null;
  reason: string;
}

const skip = <T>(reason: string, similarity: number | null = null): NoteRoute<T> => ({
  attachment: null,
  startNewEpisode: false,
  write: false,
  similarity,
  reason,
});

const fresh = <T>(reason: string, similarity: number | null = null): NoteRoute<T> => ({
  attachment: null,
  startNewEpisode: true,
  write: true,
  similarity,
  reason,
});

const appendHere = <T>(attachment: T | null, reason: string): NoteRoute<T> => ({
  attachment,
  startNewEpisode: false,
  write: true,
  similarity: null,
  reason,
});

/**
 * The decision that does not need an embedding.
 *
 * Returns `null` when the answer genuinely depends on how similar this record
 * is to what the notes already say, which is the only case worth paying an
 * embedding for. Everything else is settled here, so the common paths - a first
 * note, an open note, a note that has not seen these passages - never touch the
 * embedding service at all.
 */
export function routeWithoutSimilarity<T>(
  notes: readonly RoutableNote<T>[],
  wantedChunkIds: Iterable<number>,
  options: { unreadable?: boolean } = {},
): NoteRoute<T> | null {
  /*
   * A note that exists but cannot be READ must never reach the "start a new
   * episode" branch. Treating it as absent looks harmless and is not: the new
   * episode would be written from an empty body and the records already in that
   * file would be replaced by a single one - the append-only guarantee broken
   * by the very code meant to preserve it, silently. So it falls back to the
   * ordinary append path, where the note/ledger consistency check can refuse
   * the write loudly.
   */
  if (options.unreadable) {
    return appendHere<T>(
      null,
      "a note could not be read; appending to the current one",
    );
  }

  if (!notes.length) return appendHere<T>(null, "first note for this paper");

  const wanted = new Set<number>();
  for (const id of wantedChunkIds) wanted.add(Number(id));

  // 1. The earliest open note that has not seen all of these passages.
  for (const note of notes) {
    if (note.concluded) continue;
    const missing = [...wanted].filter((id) => !note.chunkIds.has(id));
    if (!missing.length) continue;
    return {
      attachment: note.attachment,
      startNewEpisode: false,
      write: true,
      similarity: null,
      reason: `note covers neither chunk ${missing.slice(0, 4).join(", ")}`,
    };
  }

  /*
   * 2. An open note that has already seen these passages still takes the
   *    record. Re-reading a passage and saying something further about it is
   *    ordinary, and the note is not finished, so there is nothing to protect.
   *    Only a CONCLUDED note forces the question below, because only a
   *    concluded note cannot be appended to. Leaving this case out sent every
   *    re-read down the similarity branch and opened a new note for it.
   */
  const open = notes.find((note) => !note.concluded);
  if (open) return appendHere(open.attachment, "appended to the open note");

  // 3. Every note is concluded and none of them discusses these passages, so
  //    there is nothing this record could be restating.
  if (!notes.some((note) => note.related)) {
    return fresh<T>("no note discusses these passages");
  }

  // 4. Every note is concluded and at least one discusses these passages.
  //    Only now does similarity decide.
  return null;
}

/**
 * Whether a record that every concluded note already discusses is worth a note.
 *
 * `closest` is the similarity to the NEAREST existing account, never the
 * average and never a comparison against all of them concatenated. Joining
 * their discussions into one text and comparing once dilutes the case that
 * matters most: a reading that restates note #2 exactly would still look
 * different once note #1's unrelated prose was mixed in, and would open a note
 * it had no business opening. The test is the closest account, not the mean.
 */
export function routeBySimilarity<T>(
  closest: number | null,
  threshold: number,
): NoteRoute<T> {
  if (closest === null) return fresh<T>("no comparable embedding");
  return closest >= threshold
    ? skip<T>(
        `restates what a note already records (closest ${closest.toFixed(3)} >= ${threshold})`,
        closest,
      )
    : fresh<T>(
        `differs from every note's account of these passages (closest ${closest.toFixed(3)} < ${threshold})`,
        closest,
      );
}

export const routeFallback = <T>(reason: string): NoteRoute<T> => fresh<T>(reason);
