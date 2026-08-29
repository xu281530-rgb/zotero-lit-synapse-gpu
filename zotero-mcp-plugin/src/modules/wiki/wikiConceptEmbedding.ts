/**
 * What a Concept looks like to the embedding model.
 *
 * A Claim embeds its own sentence and there is nothing to decide. A Concept
 * is a record with four parts - a canonical name, aliases in two languages, a
 * type and a description - and which of them go into the vector decides what
 * the recall is actually good at.
 *
 * All of them do, in this order, for two different jobs:
 *
 *   - DUPLICATE DETECTION needs the NAMES to dominate. `界面换热系数` and
 *     `界面传热系数` normalize to different strings, so the alias table cannot
 *     see they are the same term and the library grows two records for one
 *     concept - the exact failure that made lexical matching insufficient.
 *     Names first, and every alias with them, is what puts those two next to
 *     each other; it is also what puts `IHTC` next to both, since the aliases
 *     carry the English and the abbreviation.
 *   - RELATION DISCOVERY needs the DESCRIPTION, because relatedness between
 *     two concepts is a statement about what they are, not what they are
 *     called. `溶质抑制形核区` and `成分过冷` share no character at all.
 *
 * Determinism matters as much as content: the text is hashed, and the hash is
 * what says whether a stored vector is still current. Aliases arrive from the
 * database in whatever order the rows come back, so they are sorted here. An
 * unsorted join would make the hash flip between two values for an unchanged
 * concept, and every drain would re-embed the whole library.
 */

import { normalizeWikiText } from "./wikiCanonicalizer";
import { rowColumn } from "./wikiRow";

export interface WikiConceptEmbeddingInput {
  canonicalName: string;
  conceptType?: string;
  description?: string;
  aliases?: string[];
}

/**
 * The text whose vector represents this concept.
 *
 * The canonical name leads and is never sorted away: it is the name the
 * concept is written under, and an embedding that led with an incidental
 * English alias would sit slightly off from where the Chinese Wiki puts it.
 */
export function conceptEmbeddingText(
  concept: WikiConceptEmbeddingInput,
): string {
  const canonical = normalizeWikiText(concept.canonicalName ?? "");
  const seen = new Set<string>();
  if (canonical) seen.add(canonical);
  const aliases = Array.from(
    new Set(
      (concept.aliases ?? [])
        .map((alias) => normalizeWikiText(alias ?? ""))
        .filter((alias) => Boolean(alias) && alias !== canonical),
    ),
  ).sort();
  for (const alias of aliases) seen.add(alias);

  const names = Array.from(seen).join(" / ");
  const type = normalizeWikiText(concept.conceptType ?? "");
  const description = normalizeWikiText(concept.description ?? "");

  const lines = [names];
  if (type && type !== "concept") lines.push(`[${type}]`);
  if (description) lines.push(description);
  return lines.filter(Boolean).join("\n");
}

/**
 * The separator `group_concat` joins the aliases with.
 *
 * A comma would have been the obvious delimiter and would have been wrong:
 * concept aliases routinely contain one - `T-Mg(Al,Zn,Cu)2` is an alias in
 * this library today - and splitting on it would feed the embedding two
 * fragments of a chemical formula as if they were two different names.
 */
export const ALIAS_SEPARATOR = "\u001f";

/**
 * The columns a query must select for {@link conceptEmbeddingTextFromRow}.
 *
 * Exported as a fragment rather than written out at each call site because
 * two places need a concept's embedding text - the queue drain, which embeds
 * it, and the staleness resync, which hashes it to decide whether the stored
 * vector still matches. Assembled differently in those two places, the text
 * would hash differently, and every resync would re-queue the whole library
 * for no reason. The alias `c` must be bound to `wiki_concepts`.
 */
export const CONCEPT_EMBEDDING_COLUMNS = `c.canonical_name AS canonical_name,
       c.concept_type AS concept_type,
       c.description AS description,
       (SELECT group_concat(a.alias, char(31))
          FROM wiki_aliases a WHERE a.concept_id = c.concept_id) AS aliases`;

/** {@link conceptEmbeddingText} for a row selected with the columns above. */
export function conceptEmbeddingTextFromRow(row: any): string {
  return conceptEmbeddingText({
    canonicalName: String(
      rowColumn(row, "canonical_name", "canonicalName") ?? "",
    ),
    conceptType: String(rowColumn(row, "concept_type", "conceptType") ?? ""),
    description: String(rowColumn(row, "description", "description") ?? ""),
    aliases: String(rowColumn(row, "aliases", "aliases") ?? "")
      .split(ALIAS_SEPARATOR)
      .filter(Boolean),
  });
}
