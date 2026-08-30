/**
 * What a term IS, once a concept stops being a name on a page.
 *
 * A concept entity owns one primary term and any number of alias terms, and
 * every one of them - primary and alias alike - has the same three-field
 * shape: a Chinese full name, an English full name, and an abbreviation. That
 * uniformity is the point. The old model stored an alias as a bare string with
 * a language tag, so "动态再结晶", "Dynamic Recrystallization" and "DRX" were
 * three unrelated rows that happened to hang off the same concept, and nothing
 * recorded that the third is the short form of the second.
 *
 * ONE HARD RULE, and it lives here rather than in the UI or the tool schema
 * because it is about truth, not convenience: an abbreviation may never stand
 * alone. A term with only a Chinese name is fine. A term with an English name
 * and an abbreviation is fine. A term that is ONLY "CET" is refused, because
 * nothing in the database then says what those letters expand to - and a model
 * that cannot tell whether this paper's "CET" is a columnar-to-equiaxed
 * transition or something else entirely must leave the field empty rather than
 * pick one. Missing information is recoverable; invented information is not.
 *
 * Matching follows from the same rule. Two terms are the same term when one of
 * their FULL names agrees; a shared abbreviation is never on its own enough to
 * fuse two concepts, because abbreviation collisions across subfields are
 * common and a wrong merge silently destroys a distinction.
 */

import { normalizeWikiName, normalizeWikiText } from "./wikiCanonicalizer";

/** The three-field shape every term has, primary and alias alike. */
export interface WikiTermFields {
  /** Chinese full name, e.g. 动态再结晶. May be empty. */
  zh: string;
  /** English full name, e.g. Dynamic Recrystallization. May be empty. */
  en: string;
  /** Short form, e.g. DRX. May be empty; may never be the only field. */
  abbr: string;
}

export type WikiTermRole = "primary" | "alias";

/**
 * Where one FIELD of a term came from. Per field, never per row.
 *
 * A single row routinely mixes all three: the paper stated the English name,
 * the model supplied the Chinese translation from domain knowledge, and a
 * reader later corrected the abbreviation. Recording provenance on the row
 * would collapse that into one lie, so each of the three columns carries its
 * own mark and the terminology view tints each cell separately.
 *
 *   literature - the text of a paper stated it. The strongest claim.
 *   ai         - the model completed or translated it from what it knows.
 *                Plausible, unverified, and never allowed to look like the
 *                paper said it.
 *   user       - a person typed it. Never overwritten by anything automatic.
 *   ""         - unknown. Only pre-2.4.4 rows, which were written before the
 *                distinction existed. Left blank rather than guessed.
 */
export type WikiTermOrigin = "literature" | "ai" | "user" | "";

export interface WikiTermOrigins {
  zh: WikiTermOrigin;
  en: WikiTermOrigin;
  abbr: WikiTermOrigin;
}

export const EMPTY_ORIGINS: WikiTermOrigins = { zh: "", en: "", abbr: "" };

export function normalizeOrigin(value: unknown): WikiTermOrigin {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "literature" || text === "paper" || text === "source") {
    return "literature";
  }
  if (text === "ai" || text === "model" || text === "inferred") return "ai";
  if (text === "user" || text === "manual" || text === "human") return "user";
  return "";
}

/** One source document a term was recognised in. */
export interface WikiTermSourceInput {
  libraryID?: number;
  itemKey: string;
  /** Optional. Verified against the live index when supplied. */
  chunkIdSnapshot?: number | null;
  /** Optional. Verified against the chunk when supplied. */
  excerpt?: string;
}

export interface WikiTermInput extends Partial<WikiTermFields> {
  sources?: WikiTermSourceInput[];
  /** Provenance of the term text itself: "ai", "user" or "legacy". */
  source?: string;
  confidence?: number;
  /** Per-field provenance. Anything unstated defaults to "ai", never to "literature". */
  origins?: Partial<Record<keyof WikiTermFields, string>>;
  /** Shorthand: one origin for every field this term fills in. */
  origin?: string;
}

export interface WikiConceptEntityInput {
  /**
   * An existing concept this entity IS, rather than one to resolve by name.
   *
   * Set on its own - with sources and nothing else - it means "record this
   * paper as another document behind that concept". That submission is written
   * immediately instead of being staged, because the reason it exists is that
   * staging loses it: a question-driven read never reaches the whole-paper
   * pass, so a source staged during one sits in the session forever and the
   * concept keeps connecting exactly one document.
   *
   * Combined with any naming field it is refused. Renaming, merging and
   * founding still go through the ordinary path, confirmation gate included.
   */
  conceptId?: number;
  /** The term the caller believes is primary. May be overruled; see below. */
  primaryTerm?: WikiTermInput;
  /** Alias terms. A caller may also put everything here and omit primaryTerm. */
  terms?: WikiTermInput[];
  conceptType?: string;
  description?: string;
  /** Sources applied to every term of this entity that names none of its own. */
  sources?: WikiTermSourceInput[];
}

export class WikiTermError extends Error {}

const MAX_TERM_LENGTH = 200;

function field(value: unknown): string {
  const text = normalizeWikiText(String(value ?? ""));
  return text.length > MAX_TERM_LENGTH ? text.slice(0, MAX_TERM_LENGTH) : text;
}

/**
 * Clean a caller's three fields, or explain why they are not a term.
 *
 * The refusal for an abbreviation-only term names the rule rather than the
 * field, because the caller's fix is never "fill in something" - it is "drop
 * the abbreviation you could not attach to a full name".
 */
export function normalizeTermFields(
  input: Partial<WikiTermFields>,
): WikiTermFields {
  const zh = field(input.zh);
  const en = field(input.en);
  const abbr = field(input.abbr);
  if (!zh && !en) {
    if (abbr) {
      throw new WikiTermError(
        `A term may not be an abbreviation on its own: "${abbr}" has neither a Chinese nor an English full name. ` +
          "If you cannot tell which full name this abbreviation expands to, leave the abbreviation out - " +
          "an incomplete term is acceptable, a guessed one is not.",
      );
    }
    throw new WikiTermError("A term needs a Chinese or an English full name");
  }
  return { zh, en, abbr };
}

/** True when the fields form a storable term. Never throws. */
export function isStorableTerm(input: Partial<WikiTermFields>): boolean {
  try {
    normalizeTermFields(input);
    return true;
  } catch {
    return false;
  }
}

export interface WikiTermKeys {
  zh: string;
  en: string;
  abbr: string;
}

export function termKeys(fields: WikiTermFields): WikiTermKeys {
  return {
    zh: fields.zh ? normalizeWikiName(fields.zh) : "",
    en: fields.en ? normalizeWikiName(fields.en) : "",
    abbr: fields.abbr ? normalizeWikiName(fields.abbr) : "",
  };
}

/**
 * Do these two terms name the same thing?
 *
 * Full names only. Sharing an abbreviation is suggestive and is deliberately
 * not sufficient: an abbreviation means different things in different
 * subfields, and a merge cannot be undone by the model that made it.
 */
export function sameTerm(left: WikiTermFields, right: WikiTermFields): boolean {
  const a = termKeys(left);
  const b = termKeys(right);
  if (a.zh && b.zh && a.zh === b.zh) return true;
  if (a.en && b.en && a.en === b.en) return true;
  return false;
}

/**
 * Fold `extra` into `base` without overwriting anything `base` already states.
 *
 * Only called for terms {@link sameTerm} has already agreed are one term, so
 * taking the abbreviation from one and the Chinese name from the other is
 * completing a record, not merging two.
 */
export function mergeTermFields(
  base: WikiTermFields,
  extra: WikiTermFields,
): WikiTermFields {
  return {
    zh: base.zh || extra.zh,
    en: base.en || extra.en,
    abbr: base.abbr || extra.abbr,
  };
}

/**
 * The per-field provenance of a submission, defaulted the safe way.
 *
 * A field the caller filled in but did not label counts as "ai". That default
 * is deliberate and one-directional: labelling model output as the paper's own
 * words is the failure this whole column exists to prevent, while labelling a
 * quoted term as inferred understates it and costs nothing but a tint.
 */
export function normalizeTermOrigins(
  fields: WikiTermFields,
  input: Pick<WikiTermInput, "origins" | "origin">,
): WikiTermOrigins {
  const fallback = normalizeOrigin(input.origin) || "ai";
  const pick = (key: keyof WikiTermFields): WikiTermOrigin => {
    if (!fields[key]) return "";
    return normalizeOrigin(input.origins?.[key]) || fallback;
  };
  return { zh: pick("zh"), en: pick("en"), abbr: pick("abbr") };
}

/** What happens to one field when a submission meets a stored term. */
export type WikiFieldOutcome =
  | { kind: "keep" }
  /** The stored field was empty; the submission supplies it. */
  | { kind: "fill" }
  /** Same text, better provenance: an inferred field the paper now confirms. */
  | { kind: "promote" }
  /** Different text, and the stored one was only inferred. The paper wins. */
  | { kind: "correct" }
  /** Both sides state something neither may overwrite. Not one term. */
  | { kind: "conflict" };

/**
 * Decide one field, given what is stored and what has just arrived.
 *
 * The two rules that matter, and why they point in opposite directions:
 *
 *   - An inferred value that a paper contradicts is REPLACED. The model
 *     guessed "Dynamic Recrystallisation" from memory and the paper in front
 *     of it says "Dynamic Recrystallization"; keeping the guess as a second
 *     name would manufacture a spelling variant nobody uses.
 *   - Two values that both came from papers are BOTH KEPT, as separate term
 *     rows. British and American spellings are both real, both cited, and a
 *     library that silently drops one cannot answer which paper used which.
 *
 * A value a person typed is never overwritten by either.
 */
export function reconcileField(
  stored: { value: string; origin: WikiTermOrigin },
  incoming: { value: string; origin: WikiTermOrigin },
): WikiFieldOutcome {
  if (!incoming.value) return { kind: "keep" };
  if (!stored.value) return { kind: "fill" };
  if (normalizeWikiName(stored.value) === normalizeWikiName(incoming.value)) {
    if (stored.origin === "user") return { kind: "keep" };
    if (incoming.origin === "literature" && stored.origin !== "literature") {
      return { kind: "promote" };
    }
    if (incoming.origin === "user" && stored.origin !== "literature") {
      return { kind: "promote" };
    }
    return { kind: "keep" };
  }
  if (stored.origin === "ai" && incoming.origin !== "ai") {
    return { kind: "correct" };
  }
  return { kind: "conflict" };
}

export interface WikiTermReconciliation {
  fields: WikiTermFields;
  origins: WikiTermOrigins;
  /** Anything at all changed, so the row has to be written back. */
  changed: boolean;
  /** A stored value was replaced rather than filled in. Worth reporting. */
  corrected: boolean;
  /** How many fields matched exactly, for choosing between candidate rows. */
  exact: number;
}

const TERM_FIELDS: Array<keyof WikiTermFields> = ["zh", "en", "abbr"];

/**
 * Is the arriving term the SAME term as this stored one, and if so, what does
 * the stored row become?
 *
 * Returns null in exactly two cases, and both mean "record this separately
 * rather than folding it in": the two share no full name at all, or they share
 * one but disagree on another field in a way neither side may overrule. The
 * second case is the bug this function exists to fix - the old code matched on
 * one field and then let `base.en || extra.en` throw the other side's English
 * name away without a word.
 */
export function reconcileTerm(
  stored: { fields: WikiTermFields; origins: WikiTermOrigins },
  incoming: { fields: WikiTermFields; origins: WikiTermOrigins },
): WikiTermReconciliation | null {
  if (!sameTerm(stored.fields, incoming.fields)) return null;
  const fields: WikiTermFields = { ...stored.fields };
  const origins: WikiTermOrigins = { ...stored.origins };
  let changed = false;
  let corrected = false;
  let exact = 0;
  for (const key of TERM_FIELDS) {
    const outcome = reconcileField(
      { value: stored.fields[key], origin: stored.origins[key] },
      { value: incoming.fields[key], origin: incoming.origins[key] },
    );
    switch (outcome.kind) {
      case "conflict":
        return null;
      case "fill":
        fields[key] = incoming.fields[key];
        origins[key] = incoming.origins[key];
        changed = true;
        break;
      case "correct":
        fields[key] = incoming.fields[key];
        origins[key] = incoming.origins[key];
        changed = true;
        corrected = true;
        break;
      case "promote":
        origins[key] = incoming.origins[key];
        changed = true;
        exact += 1;
        break;
      case "keep":
        if (incoming.fields[key]) exact += 1;
        break;
    }
  }
  return { fields, origins, changed, corrected, exact };
}

/** How many of the three fields are filled in. The primary-term criterion. */
export function termCompleteness(fields: WikiTermFields): number {
  return (fields.zh ? 1 : 0) + (fields.en ? 1 : 0) + (fields.abbr ? 1 : 0);
}

/**
 * The name a reader sees: Chinese full name, else English full name.
 *
 * Never the abbreviation. A list of entries reading "DRX / CET / EBSD" is a
 * glossary index, not a concept library, and an abbreviation as a title is
 * exactly the ambiguity the storage rule exists to keep out.
 */
export function termDisplayName(fields: WikiTermFields): string {
  return fields.zh || fields.en || "";
}

export interface WikiTermSourceRecord {
  sourceId: number;
  termId: number;
  libraryID: number;
  itemKey: string;
  chunkIdSnapshot: number | null;
  excerpt: string;
  createdAt: number;
}

export interface WikiTermRecord extends WikiTermFields {
  termId: number;
  conceptId: number;
  role: WikiTermRole;
  /** Per-field provenance, driving the cell tints in the terminology view. */
  origins: WikiTermOrigins;
  source: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  sources: WikiTermSourceRecord[];
}

export interface WikiConceptEntity {
  conceptId: number;
  libraryID: number;
  conceptType: string;
  description: string;
  /** Display name, derived from the primary term and mirrored into wiki_concepts. */
  displayName: string;
  primaryTerm: WikiTermRecord | null;
  aliasTerms: WikiTermRecord[];
  /**
   * A person chose this primary term by hand, so nothing automatic may move
   * it. Only another manual choice can.
   */
  primaryLocked: boolean;
  /** Pages whose primary concept this is. Empty for a page-less concept. */
  pageIds: number[];
}

/**
 * Which of a concept's terms deserves to be the primary one.
 *
 * The rule: the most complete group wins - all three fields beats two, two
 * beats one - and a tie goes to whichever was recorded first. Completeness
 * rather than recency, because the primary term is what every other surface
 * renders, and a later paper that only had the English name should not demote
 * a term that already carried all three.
 */
export function choosePrimaryTerm<
  T extends WikiTermFields & { createdAt: number; termId: number },
>(terms: readonly T[]): T | null {
  let best: T | null = null;
  for (const term of terms) {
    if (!best) {
      best = term;
      continue;
    }
    const score = termCompleteness(term);
    const bestScore = termCompleteness(best);
    if (score > bestScore) {
      best = term;
      continue;
    }
    if (score < bestScore) continue;
    if (term.createdAt < best.createdAt) {
      best = term;
      continue;
    }
    if (term.createdAt === best.createdAt && term.termId < best.termId) {
      best = term;
    }
  }
  return best;
}

/**
 * Read an old flat alias string as a three-field term.
 *
 * Used only when migrating a pre-2.4.3 database, where an alias was a bare
 * string plus a language tag. The classification is deliberately conservative:
 * anything holding a CJK character is a Chinese name, a short all-caps token
 * is an abbreviation, everything else is an English name. It guesses which
 * FIELD a string already in the database belongs in, which is recoverable and
 * correctable in the UI; it never guesses a value that was not there.
 */
export function classifyLegacyName(
  raw: string,
  language?: string,
): WikiTermFields {
  const text = field(raw);
  if (!text) return { zh: "", en: "", abbr: "" };
  const tag = normalizeWikiName(language ?? "");
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(text)) {
    return { zh: text, en: "", abbr: "" };
  }
  if (tag.startsWith("zh")) return { zh: text, en: "", abbr: "" };
  const looksAbbreviated =
    text.length <= 12 &&
    !/\s/u.test(text) &&
    /^[A-Za-z0-9][A-Za-z0-9./\-+]*$/u.test(text) &&
    text === text.toUpperCase() &&
    /[A-Z]/u.test(text);
  if (looksAbbreviated) return { zh: "", en: "", abbr: text };
  return { zh: "", en: text, abbr: "" };
}

/** Every non-empty name a term carries, for the flat search projection. */
export function termSearchNames(fields: WikiTermFields): string[] {
  return [fields.zh, fields.en, fields.abbr].filter(Boolean);
}

/**
 * How many "units" a concept name is, counting a Latin/number run as one.
 *
 * `Lomer-Cottrell位错锁高温阻碍效应` is 23 characters and a real term of the
 * field; `柱状晶长度调控二冷优化技术` is 13 and is a paper title. Counting raw
 * characters would flag the first and clear the second, which is backwards -
 * so a run of Latin letters and digits counts as one unit, the way a reader
 * treats it.
 */
export function conceptNameUnits(name: string): number {
  return String(name ?? "")
    .replace(/[A-Za-z0-9][A-Za-z0-9\-()._]*/gu, "X")
    .trim().length;
}

/**
 * Names long enough to be worth a second look, never a refusal.
 *
 * There is no reliable string test for "is this a term of the field": the
 * property that matters is whether another paper would use the same name, and
 * that is not in the string. Three candidate rules were measured against a
 * 119-concept library built from thirty papers - a conjunction test matched 4,
 * a containment test matched 4 and got one of them wrong (`不连续动态再结晶` is
 * not a malformed `连续动态再结晶`), and only length correlated at all.
 *
 * So this warns and does not block. At this threshold it marked 25 of those 119
 * concepts, and they are the ones like `增材修复熔池柱状晶外延生长与CET抑制` and
 * `双辉等离子表面合金化柱状晶Ni涂层` - paper titles wearing a concept's clothes.
 * A genuine long term stays, and the caller is asked rather than overruled.
 */
export const CONCEPT_NAME_REVIEW_UNITS = 12;

export function conceptNamesWorthReviewing(names: string[]): string[] {
  return names.filter((name) => conceptNameUnits(name) > CONCEPT_NAME_REVIEW_UNITS);
}
