/**
 * What to say when an Evidence excerpt cannot be found in the paper.
 *
 * The check itself is not negotiable and is not changed here: an excerpt is
 * Evidence only if it appears, character for character after normalization, in
 * a chunk that was actually read. Loosening that - a similarity threshold, a
 * fuzzy match - would destroy the one guarantee the Wiki has, because the
 * excerpts that differ from the source by a few characters are exactly the
 * ones worth catching: "increased by 10%" and "decreased by 10%" differ by
 * four characters and mean opposite things.
 *
 * What WAS wrong is that the refusal said nothing. A commit carrying nine
 * actions and twenty excerpts came back with
 *
 *     Evidence excerpt could not be verified in MQW2Y7U6's indexed chunks
 *
 * and the model had no way to tell which excerpt, from which Claim, or how
 * near it had come. The real case was an excerpt copied from a chunk that
 * renders inline maths as `$[51-68]$`, submitted as `[51-68]`: one pair of
 * dollar signs, in the middle of a two-line quotation, and nothing in the
 * message pointed at them. A model that cannot see the divergence cannot fix
 * it, so it either gives up on the Claim or starts guessing at excerpts, and
 * both of those are worse for the Wiki than the strict check was ever going to
 * be.
 *
 * So this module answers the questions a person would ask: which action, which
 * Claim, which paper, which chunk was named, what was submitted, did the named
 * chunk hold it, did ANY chunk hold it, and - the one that actually solves the
 * case - where exactly the submitted text stops matching the source.
 */

import { normalizeWikiText } from "./wikiCanonicalizer";

export interface WikiEvidenceDiagnosticChunk {
  chunkId: number;
  text: string;
}

export interface WikiEvidenceMismatchInput {
  itemKey: string;
  /** The excerpt as submitted, before normalization. */
  excerpt: string;
  /** The chunk the caller said it came from, if it named one. */
  chunkIdSnapshot?: number | null;
  /** Every indexed chunk of this document. */
  chunks: readonly WikiEvidenceDiagnosticChunk[];
  /** Which action and Claim the excerpt belonged to, for a batched commit. */
  context?: string;
}

/** How much of the divergence to show on each side. */
const CONTEXT_CHARS = 60;
const TAIL_CHARS = 40;

/**
 * The longest leading run of the excerpt that really is in the chunk.
 *
 * Binary search on length rather than a diff: the answer wanted is not the
 * cheapest edit script but the single position where the two texts part
 * company, because that position is where the model has to look. A prefix
 * search finds it in log(n) `indexOf` calls and needs no scoring function,
 * which keeps this diagnostic from turning into the fuzzy matcher the check
 * exists to avoid.
 */
export function longestMatchingPrefix(
  excerpt: string,
  chunkText: string,
): { length: number; index: number } {
  if (!excerpt) return { length: 0, index: -1 };
  let low = 0;
  let high = excerpt.length;
  let best = { length: 0, index: -1 };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (middle === 0) {
      low = 1;
      continue;
    }
    const index = chunkText.indexOf(excerpt.slice(0, middle));
    if (index === -1) {
      high = middle - 1;
    } else {
      best = { length: middle, index };
      low = middle + 1;
    }
  }
  return best;
}

function ellipsize(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/**
 * Point at the character where the excerpt and the chunk part company.
 *
 * Returns null when the excerpt shares no usable opening with the chunk at
 * all, because then the interesting fact is "this is not that passage", not
 * "the third word differs".
 */
function describeDivergence(
  excerpt: string,
  chunkText: string,
): string | null {
  const prefix = longestMatchingPrefix(excerpt, chunkText);
  if (prefix.length < 12) return null;
  const matched = excerpt.slice(0, prefix.length);
  const submittedRest = excerpt.slice(prefix.length, prefix.length + TAIL_CHARS);
  const sourceRest = chunkText.slice(
    prefix.index + prefix.length,
    prefix.index + prefix.length + TAIL_CHARS,
  );
  return (
    `The first ${prefix.length} character(s) match. They end at: "...${matched.slice(-CONTEXT_CHARS)}". ` +
    `The chunk then continues "${sourceRest}" but the excerpt continues "${submittedRest}". ` +
    "That is the divergence - copy the source form, including any inline-maths delimiters, spacing or " +
    "punctuation the chunk renders around numbers and reference brackets."
  );
}

/**
 * The full refusal for an excerpt that could not be verified.
 *
 * Every line of it is something the model can act on without another tool
 * call, which is the whole standard this is written to.
 */
export function describeEvidenceMismatch(
  input: WikiEvidenceMismatchInput,
): string {
  const excerpt = normalizeWikiText(String(input.excerpt ?? ""));
  const chunks = input.chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    text: normalizeWikiText(String(chunk.text ?? "")),
  }));
  const named =
    input.chunkIdSnapshot === null || input.chunkIdSnapshot === undefined
      ? undefined
      : chunks.find((chunk) => chunk.chunkId === Number(input.chunkIdSnapshot));

  const lines: string[] = [];
  lines.push(
    `Evidence excerpt could not be verified in ${input.itemKey}'s indexed chunks.`,
  );
  if (input.context) lines.push(`Where: ${input.context}.`);
  lines.push(
    `Submitted excerpt (${excerpt.length} chars): "${ellipsize(excerpt, 240)}"`,
  );

  if (input.chunkIdSnapshot === null || input.chunkIdSnapshot === undefined) {
    lines.push(
      "chunkIdSnapshot: not supplied, so the whole document had to be searched.",
    );
  } else if (!named) {
    lines.push(
      `chunkIdSnapshot ${input.chunkIdSnapshot}: NOT an indexed chunk of this document. ` +
        `It has ${chunks.length} chunk(s), numbered ${
          chunks.length
            ? `${Math.min(...chunks.map((c) => c.chunkId))} to ${Math.max(...chunks.map((c) => c.chunkId))}`
            : "none"
        }.`,
    );
  } else {
    lines.push(
      `chunkIdSnapshot ${named.chunkId}: exists, and does NOT contain this excerpt.`,
    );
  }

  // The fallback the verifier itself runs: any chunk at all.
  const fallback = chunks.find((chunk) => chunk.text.includes(excerpt));
  lines.push(
    fallback
      ? `Whole-document fallback: FOUND in chunk ${fallback.chunkId}. The excerpt is real; the chunkIdSnapshot is wrong. Resubmit it with chunkIdSnapshot ${fallback.chunkId} - and make sure that chunk is one this reading was actually given, since Evidence may only be quoted from chunks recorded as read.`
      : "Whole-document fallback: not found in ANY chunk of this document, so the excerpt is not a verbatim quotation from this paper as indexed.",
  );

  if (!fallback) {
    // Point at the divergence in the most promising chunk: the one named, or
    // failing that, whichever shares the longest opening with the excerpt.
    let target = named;
    let best = named
      ? longestMatchingPrefix(excerpt, named.text).length
      : -1;
    if (!named || best < 12) {
      for (const chunk of chunks) {
        const length = longestMatchingPrefix(excerpt, chunk.text).length;
        if (length > best) {
          best = length;
          target = chunk;
        }
      }
    }
    const divergence = target
      ? describeDivergence(excerpt, target.text)
      : null;
    if (target && divergence) {
      lines.push(`Closest chunk: ${target.chunkId}. ${divergence}`);
    } else {
      lines.push(
        "No chunk shares an opening with this excerpt, which usually means it was written from the " +
          "reading note rather than copied from the source. The note is your paraphrase and can never " +
          "be Evidence: re-read the chunk with wiki_build_from_paper (offset) or get_document_chunks " +
          "and copy the sentence out of it. Re-reading a chunk you have already been given is free.",
      );
    }
  }

  lines.push(
    "Verification is verbatim by design and is not relaxed: an excerpt that differs from the source by " +
      "a few characters is exactly the case worth catching, since a dropped negation or a changed digit " +
      "reads as a small edit and reverses the claim. Fix the excerpt; do not paraphrase it.",
  );
  return lines.join("\n");
}
