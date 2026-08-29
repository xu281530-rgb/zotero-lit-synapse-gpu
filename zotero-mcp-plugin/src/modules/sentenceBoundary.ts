/**
 * Where a sentence actually ends, for every part of the plugin that has to
 * decide.
 *
 * Two places decide it, and until now they decided differently. The reading
 * note's auditor knew that the full stop in "Xu et al. (2021)" is not the end
 * of anything; the text chunker did not, and split the paper there - leaving
 * one chunk ending "Meanwhile, Xu et al." and the next beginning "(2021)
 * studied that...". That is not a cosmetic defect. A chunk is the unit a
 * Claim's Evidence is quoted from and the unit a reading record accounts for,
 * so a citation cut in half puts the author's name in one piece of evidence
 * and their finding in another, and a reader asked to account for the second
 * chunk is handed a sentence with no subject.
 *
 * The rules are the same in both directions, which is the point of this
 * module existing at all:
 *
 *   - a full stop ends a sentence only when whitespace or the end of the text
 *     follows it, so "0.1 MPa" and "Ni-19.5 at.% Mo" stay whole;
 *   - it does not end one when the word before it is an abbreviation;
 *   - a digit before it and a digit after it is a decimal the OCR split, not
 *     a boundary - MinerU writes "Al-8. 5Zn" often enough to matter;
 *   - the full-width stops end a sentence immediately, since nothing follows
 *     them in Chinese, except a closing quote or bracket that belongs to the
 *     sentence just closed.
 */

/**
 * Abbreviations whose full stop does not end a sentence.
 *
 * Deliberately a closed list rather than a heuristic: "ends in a short word"
 * would swallow "It was hot." and "at 900 K.". The unit abbreviations - at,
 * wt, vol, mol - are here because a composition is routinely written
 * "Ni-19.5 at.% Mo", and the citation forms because a materials paper is full
 * of them.
 */
export const ABBREVIATION =
  /\b(?:e\.g|i\.e|cf|vs|approx|ca|Fig|Figs|Eq|Eqs|Ref|Refs|et\s+al|al|Dr|Prof|No|St|Inc|Ltd|at|wt|vol|mol)\.$/iu;

/** Full-width terminators, which end a sentence with nothing after them. */
export const CJK_TERMINATORS = "。？！";

/** Closing marks that belong to the sentence they follow, not the next one. */
export const TRAILING_CLOSERS = "”’」』）】》〉";

/**
 * Does this text stop on something that only looks like a sentence end?
 *
 * `before` is everything up to and including the stop; `after` is what
 * follows. Both are needed: an abbreviation is decided by what precedes the
 * stop, a decimal by what sits on either side of it.
 */
export function isFalseSentenceEnd(before: string, after: string): boolean {
  const trimmed = before.trimEnd();
  // A stop with no space after it is inside a token, not between sentences.
  if (!/^\s|^$/u.test(after)) return true;
  if (ABBREVIATION.test(trimmed)) return true;
  /*
   * A bare number and a stop, with nothing in front of it, is the marker of
   * an ordered list - "1. 断口表征方法：…" - and counting it as a sentence
   * made every list item look like two.
   *
   * That was not cosmetic. A check meant to refuse "one fact per line"
   * measures sentences per paragraph, and with the marker counted, a numbered
   * item of one sentence scored two: the check passed a whole note in which
   * 96% of the lines were enumerated points. The rule that catches lists was
   * blind to the one punctuation mark that makes a list.
   */
  if (/^\d{1,3}\.$/u.test(trimmed)) return true;
  // A decimal the OCR opened a gap in.
  if (/\d\.$/u.test(trimmed) && /^\s*\d/u.test(after)) return true;
  return false;
}
