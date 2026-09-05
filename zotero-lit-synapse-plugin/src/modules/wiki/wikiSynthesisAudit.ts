/**
 * The evidence-closure check that stands between a finished reading and the
 * Markdown written down as the paper's account of itself.
 *
 * The failure it exists to catch is not hallucination. It is what a model does
 * when it has genuinely read all 53 chunks and is now asked to say the paper
 * in one voice: the prose gets better and the claims get stronger. "notably
 * unique" becomes "irreplaceable". "can be a solution for missing wedge
 * artifacts" becomes "eliminates missing wedge artifacts entirely". A list of
 * six essential points arrives with five, and the one that went missing is the
 * one that named a difficulty. Two adjacent chunks about the same instrument
 * fuse into one sentence asserting a relationship neither of them states.
 * Every individual edit reads like better writing. The document that comes out
 * says things the paper does not.
 *
 * None of that is visible to a delivery ledger. `53/53 chunks read`,
 * `integratedChunks: 53` and `finalSynthesis: true` were all true of the note
 * that carried all four of those errors. Coverage proves transport; it has
 * never proved a sentence.
 *
 * WHAT THIS MODULE DECIDES, AND WHAT IT REFUSES TO DECIDE. It does not decide
 * whether a sentence is true - nothing on this side of the wire can, and
 * pretending otherwise with a similarity threshold is worse than nothing,
 * because "increased by 10%" and "decreased by 10%" are 95% similar and
 * opposite. It decides ONE thing: which sentences have to be PROVED before the
 * note is written. The proof is a verbatim quotation from each chunk the
 * sentence cites, checked here character by character against the indexed
 * text - the same rule Evidence lives under, for the same reason.
 *
 * So the lexicons below are not truth detectors. They are a list of the shapes
 * a drifting sentence takes. Four can be seen in the sentence alone:
 *
 *   - it states something absolutely, where papers state things carefully;
 *   - it asserts a relation - common, orthogonal, parallel - whose opposite
 *     would read almost identically;
 *   - it cites several chunks at once, which is how two facts become one
 *     relationship that neither chunk asserts;
 *   - it names a technique appearing nowhere in the chunks it cites, which is
 *     how one method's capability gets attributed to another.
 *
 * Three more are only visible by reading the source it cites, and those are
 * the ones that catch drift the wording cannot betray:
 *
 *   - it says flatly what its own source says tentatively;
 *   - it drops a negation the source carried;
 *   - it keeps a number and leaves behind the conditions it was measured
 *     under;
 *   - it enumerates fewer items than the passage it is summarising.
 *
 * A bare number and a bare negation are NOT on either list, and the omission
 * is the whole calibration: an honest reading note is full of both, and a gate
 * that asks a model to justify every one of them is the "prove everything"
 * design this is deliberately not. The risk was never the number; it was the
 * number without its conditions. See STRONG_RISKS.
 *
 * THE CHEAP WAY OUT IS THE CONSERVATIVE ONE, deliberately. A flagged sentence
 * can be answered with a quotation, or rewritten in the paper's own strength -
 * at which point it is no longer flagged and costs nothing. That asymmetry is
 * the whole design: writing what the paper actually said is the path of least
 * effort, and reaching past it costs a round trip.
 */

import { normalizeWikiText } from "./wikiCanonicalizer";
import { citedWikiChunkIds, parseWikiCitations } from "./wikiCitations";
import { findWikiSourceQuote } from "./wikiSourceText";
import {
  CJK_TERMINATORS,
  TRAILING_CLOSERS,
  isFalseSentenceEnd,
} from "../sentenceBoundary";

/** Why one sentence has to be proved before the note is accepted. */
export type WikiSynthesisRisk =
  /** States absolutely what a paper would state carefully. STRONG. */
  | "absolute-language"
  /** Asserts a geometric or set relation whose opposite reads the same. STRONG. */
  | "relation-word"
  /** Cites several chunks, so each one must support it on its own. STRONG. */
  | "multi-chunk-fusion"
  /** Names a technique that appears in none of the chunks it cites. STRONG. */
  | "subject-not-in-cited-chunks"
  /** Says flatly what the passage it cites says tentatively. STRONG. */
  | "hedge-dropped"
  /** Drops a negation its source carried. STRONG. */
  | "negation-dropped"
  /** Keeps a number but drops the conditions its source attached. STRONG. */
  | "condition-dropped"
  /** Enumerates fewer items than the passage it is summarising. STRONG. */
  | "enumeration-shortened"
  /** Carries a magnitude or direction word. WEAK. */
  | "direction-word"
  /** Carries a number. WEAK. */
  | "quantity"
  /** Carries a negation of its own. WEAK. */
  | "negation";

/**
 * Reasons strong enough to demand a quotation on their own.
 *
 * The split exists because the first calibration of this module flagged every
 * sentence containing a digit or the word "not" - which on a real reading note
 * is most of them, and a gate that asks a model to justify its whole document
 * is the "prove everything" design this deliberately is not. A number is not
 * suspicious; a number whose CONDITIONS were dropped is. A negation is not
 * suspicious; a negation the source had and the sentence lost is. That is why
 * the chunk-aware checks carry the weight.
 *
 * The wording-only signals that stay weak escalate only in company: two of
 * them in one sentence - a direction and a number, say, which is exactly how
 * "increased by 10%" and "decreased by 10%" differ - is a shape worth proving.
 */
const STRONG_RISKS: ReadonlySet<WikiSynthesisRisk> = new Set([
  "absolute-language",
  "relation-word",
  "multi-chunk-fusion",
  "subject-not-in-cited-chunks",
  "hedge-dropped",
  "negation-dropped",
  "condition-dropped",
  "enumeration-shortened",
]);

/** How many weak signals, with no strong one, are worth a quotation. */
const WEAK_RISK_THRESHOLD = 2;

export interface WikiFlaggedSentence {
  /** Bound to this statement, its citations and the indexed source text. */
  auditId?: string;
  /** The sentence as it stands in the submitted note, normalized. */
  sentence: string;
  /** Chunk indexes named inside the sentence, or by its block. */
  citedChunks: number[];
  reasons: WikiSynthesisRisk[];
  /** One human-readable line per reason, naming the trigger. */
  details: string[];
}

export interface WikiAuditChunk {
  chunkId: number;
  text: string;
}

/**
 * Absolutes. A review paper almost never states one, so a sentence that does
 * is either reporting a strong result or has strengthened a careful one.
 *
 * Universal quantifiers and bare modals - all, every, only, must, will - are
 * deliberately absent. They are common enough in honest prose that including
 * them would flag most of the document, and a check that flags everything
 * proves nothing while costing a full re-justification of the note.
 */
const ABSOLUTE_LANGUAGE: readonly RegExp[] = [
  /\bcan\s*not\b|\bcannot\b/i,
  /\bimpossible\b|\bimpossibility\b/i,
  /\bnever\b|\balways\b/i,
  /\bentirely\b|\bcompletely\b|\bwholly\b|\bfully\b|\btotally\b|\babsolutely\b/i,
  /\beliminat(?:e|es|ed|ing|ion)\b/i,
  /\birreplaceable\b|\bindispensable\b|\bunique(?:ly)?\b|\bunrivalled\b|\bunmatched\b/i,
  /\bmaximi[sz](?:e|es|ed|ing)\b|\bminimi[sz](?:e|es|ed|ing)\b/i,
  /\bensur(?:e|es|ed|ing)\b|\bguarantee(?:s|d)?\b/i,
  /\bovercom(?:e|es|ing)\b|\bovercame\b/i,
  /\bsolves?\b|\bsolved\b|\bproves?\b|\bproven\b|\bproved\b/i,
  /\bdefinitive(?:ly)?\b|\bunequivocal(?:ly)?\b|\bconclusively\b/i,
  /\bsuperior\b|\boptimal\b|\bthe\s+best\b|\boutperform(?:s|ed|ing)?\b|\bpreferable\b/i,
  /无法|不可能|完全消除|彻底|不可替代|唯一|保证|确保|必然|总是|从不|最大化|克服/u,
];

/**
 * Words that carry a direction or a geometric relation.
 *
 * These are the words paraphrase reverses without looking like it did
 * anything: common and orthogonal, increased and decreased, parallel and
 * perpendicular. Nothing here is suspicious on its own - which is the point.
 * A sentence built on one of them has to show the passage it came from.
 */
const RELATION_WORDS: readonly RegExp[] = [
  /\borthogonal\b|\bperpendicular\b|\bparallel\b|\bcoincid(?:e|es|ent|ing)\b|\bnormal\s+to\b/i,
  /\bcommon\b|\bshared\b|\bidentical\b|\bequivalent\b|\bopposite\b|\binverse(?:ly)?\b/i,
  /\bmonotonic(?:ally)?\b|\bproportional\b|\bindependent\s+of\b/i,
  /正交|平行|垂直|共同|相同|等价|相反|反比|单调/u,
];

/**
 * Magnitude and direction words. WEAK on their own.
 *
 * "increased" is not evidence of anything; honest prose is full of it. Paired
 * with a number in the same sentence it becomes the shape that "increased by
 * 10%" and "decreased by 10%" share, and that pair is worth one quotation.
 */
const DIRECTION_WORDS: readonly RegExp[] = [
  /\bincreas(?:e|es|ed|ing)\b|\bdecreas(?:e|es|ed|ing)\b|\bris(?:e|es|ing)\b|\bdrops?\b/i,
  /\breduc(?:e|es|ed|ing|tion)\b|\benhanc(?:e|es|ed|ing)\b|\bweaken(?:s|ed|ing)?\b|\bstrengthen(?:s|ed|ing)?\b/i,
  /\bsuppress(?:es|ed|ing)?\b|\bpromot(?:e|es|ed|ing)\b|\bimprov(?:e|es|ed|ing)\b|\bdegrad(?:e|es|ed|ing|ation)\b/i,
  /\bhigher\b|\blower\b|\blarger\b|\bsmaller\b|\bgreater\b|\bshorter\b|\blonger\b|\babove\b|\bbelow\b/i,
  /增加|增大|增强|减少|减小|减弱|升高|降低|提高|抑制/u,
];

/**
 * The wording a source uses to fence a measurement in.
 *
 * A number that arrives without any of these, out of a passage that had one,
 * has been separated from the conditions under which it is true - which is how
 * "the extinction distance is 175 nm" comes to be read as a property of the
 * material rather than of one reflection at one accelerating voltage.
 */
const CONDITION_MARKERS: readonly RegExp[] = [
  /\bunder\b|\bat\s+(?:an?\s+)?[\d$]|\bwhen\b|\bwhere\b|\bprovided\b|\bas\s+long\s+as\b/i,
  /\bcondition(?:s)?\b|\bfor\s+(?:a|an|the)\s+\w+\s+(?:specimen|sample|foil|crystal|case)\b/i,
  /\bassuming\b|\bwith\s+(?:a|an)\s+\w+\s+of\b|\bin\s+the\s+case\s+of\b|\bcalculated\b|\bmeasured\b/i,
  /条件|假设|计算得到|测量/u,
];

/**
 * Negation. Dropping one word turns a boundary condition into a capability,
 * and nothing else in the sentence changes.
 *
 * Chinese negation is restricted to the multi-character forms: the bare
 * characters are frequent enough in ordinary prose that matching them would
 * flag a Chinese note line by line.
 */
const NEGATION: readonly RegExp[] = [
  /\bnot\b|\bnone\b|\bneither\b|\bnor\b|\bwithout\b/i,
  // `non-` is deliberately absent. In a materials library it is vocabulary,
  // not logic: "non-equilibrium eutectic phase" is the NAME of a phase and
  // appears in almost every sentence about one, so counting it as a negation
  // put a weak signal on half the note and, paired with the number those
  // sentences also carry, pushed them over the two-weak-signals threshold.
  // Dropping a real negation is still caught by `negation-dropped`, which
  // compares the sentence against its source rather than reading a prefix.
  /\bfree\s+from\b|\bfails?\s+to\b|\bfailed\s+to\b|\bunable\b/i,
  /\brather\s+than\b|\binstead\s+of\b/i,
  /不能|无法|未能|不会|并非|没有|不再|无需|不足以|不需要|不使用|不依赖|不包含|未采用/u,
];

/**
 * Hedges. The vocabulary a paper uses to mark how far it is willing to go.
 *
 * Read in BOTH directions: their presence in a source passage and their
 * absence from the sentence built on it is the drift this module is named
 * after.
 */
const HEDGES: readonly RegExp[] = [
  /\bmay\b|\bmight\b|\bcould\b|\bwould\b|\bcan\s+be\s+a\b/i,
  /\bpossib(?:le|ly|ility|ilities)\b|\bpotential(?:ly)?\b|\bperhaps\b/i,
  /\bpromising\b|\bpreliminary\b|\bpropos(?:e|es|ed|al)\b|\battempt(?:s|ed)?\b/i,
  /\bexpect(?:s|ed)?\b|\bappears?\b|\bseems?\b|\bsuggests?\b|\blikely\b|\bprobabl(?:y|e)\b/i,
  /\bchalleng(?:e|es|ing)\b|\bdifficult(?:y|ies)?\b|\bhard\s+to\b|\bbottleneck\b/i,
  /\btends?\s+to\b|\bgenerally\b|\boften\b|\busually\b|\bsometimes\b|\btypically\b|\bnormally\b/i,
  /\bin\s+principle\b|\bnot\s+necessarily\b|\bmostly\b|\bpartial(?:ly)?\b|\bto\s+some\s+extent\b/i,
  /可能|或许|大概|有望|初步|提出|预期|似乎|困难|挑战|通常|一般而言|往往/u,
];

/**
 * The hedges whose ABSENCE from a sentence built on them is worth a
 * quotation.
 *
 * The full list above is used one way - "does this sentence hedge at all?" -
 * and this shorter one the other way: "did the source commit less than the
 * sentence does?". They have to differ, because the frequency adverbs are the
 * bulk of the long list and are terrible evidence of tentativeness. Almost
 * every paragraph of a review paper contains "generally" or "often"
 * somewhere, so triggering on them flagged two thirds of a real note - which
 * is the "prove everything" failure again, arriving by a different route.
 *
 * What survives is the vocabulary of genuine epistemic distance: the paper
 * saying it MIGHT work, that someone has PROPOSED it, that a result is
 * PRELIMINARY, that a thing is DIFFICULT. Those are the words whose loss
 * turns a research direction into a finished capability.
 */
const COMMITMENT_HEDGES: readonly RegExp[] = [
  /\bmay\b|\bmight\b|\bcan\s+be\s+a\b/i,
  /\bpossib(?:le|ly|ility|ilities)\b|\bpotential(?:ly)?\b|\bperhaps\b/i,
  /\bpromising\b|\bpreliminary\b|\bproposed\s+(?:hypothesis|explanation|interpretation)\b|\battempt(?:s|ed)?\b/i,
  /\bexpect(?:s|ed)?\b|\bappears?\s+to\b|\bseems?\b|\bsuggests?\b|\blikely\b/i,
  /\bchalleng(?:e|es|ing)\b|\bdifficult(?:y|ies)?\b|\bhard\s+to\b|\bbottleneck\b/i,
  /\bin\s+principle\b|\bnot\s+necessarily\b|\bnot\s+a\s+unique\b/i,
  /可能|或许|有望|初步|提出|预期|似乎|困难|挑战/u,
];

/** Words too common to tell one passage from another. */
const STOPWORDS = new Set(
  ("a an the and or but of in on at to for from by with without as is are was " +
    "were be been being that this these those it its their there here which " +
    "who whom whose when while than then so such also not no can could may " +
    "might will would shall should must have has had do does did using used " +
    "use one two both each other others same more most less least very much " +
    "many few some any all into over under between within about through during")
    .split(/\s+/u),
);

/** `(chunk 42)`, `chunk 18, chunk 19`, the Chinese forms. */
const CHUNK_REFERENCE =
  /(?:chunks?|块|段)\s*#?\s*(\d+)|第\s*(\d+)\s*(?:块|段)/giu;

/** Bibliography brackets: `[51-68]`, `[99]`. Never chunk numbers. */
const REFERENCE_BRACKET = /\[[\d\s,–—-]+\]/gu;

/** Acronym-shaped technique names: STEM, DC-ET, LAADF-STEM, FIB-SEM. */
const TECHNIQUE_TOKEN = /\b[A-Z][A-Za-z0-9]*(?:[-/][A-Za-z0-9]+)*\b/gu;

/**
 * Collect the chunk indexes a piece of text names.
 *
 * Reference brackets are stripped first: `[51-68]` cites the paper's own
 * bibliography and has nothing to do with chunk numbering, and a note quoting
 * one would otherwise appear to cite chunk 51.
 */
export function citedChunkIds(text: string): number[] {
  return citedWikiChunkIds(text);
}

const FENCE = /^\s{0,3}(?:`{3,}|~{3,})/u;
const HEADING = /^\s{0,3}#{1,6}\s+/u;
const BLOCKQUOTE = /^\s{0,3}>/u;
const TABLE_ROW = /^\s{0,3}\|/u;

/**
 * A bold line standing alone is a section label, not prose.
 *
 * `assertHolisticBody` has always read it that way - a heading is a heading
 * whether it is written `## X` or `**X**` - and the block splitter used to
 * disagree, gluing the label onto the paragraph beneath it. That difference
 * had no consequences while labels were incidental. It acquired one the
 * moment records arrived under a fixed template with CHINESE labels: the
 * per-block citation rule measures a block against a shorter limit once it
 * contains Han characters, so a two-character label was enough to drag an
 * English paragraph from the 120-character limit to the 50-character one and
 * demand a citation the rule never meant to ask for. The label is not the
 * paragraph; splitting it off is what the other reader already believed.
 */
const BOLD_LABEL = /^\s{0,3}\*\*[^*]+\*\*\s*[:：]?\s*$/u;

export interface WikiNoteBlock {
  /** The block's text with list markers and inline markup left in place. */
  text: string;
  /** 1-based line number of the block's first line, for error messages. */
  line: number;
  /** Headings, quotes, fenced code and tables carry no claims of their own. */
  prose: boolean;
}

/**
 * Split the model's half of the note into blocks: paragraphs and list items.
 *
 * A list item is its own block rather than part of the paragraph around it,
 * because in a reading note the list item IS the claim - the notes this was
 * built for put one finding per bullet - and folding bullets together would
 * let one citation cover five unrelated assertions.
 */
export function splitNoteBlocks(body: string): WikiNoteBlock[] {
  const blocks: WikiNoteBlock[] = [];
  const lines = String(body ?? "").split(/\r?\n/u);
  let inFence = false;
  let inComment = false;
  let buffer: string[] = [];
  let bufferLine = 0;

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.join(" ").trim();
    if (text) blocks.push({ text, line: bufferLine, prose: true });
    buffer = [];
  };

  lines.forEach((line, index) => {
    if (FENCE.test(line)) {
      flush();
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (!inComment && line.includes("<!--")) {
      flush();
      inComment = !line.slice(line.indexOf("<!--")).includes("-->");
      return;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      return;
    }
    if (!line.trim()) {
      flush();
      return;
    }
    if (
      HEADING.test(line) ||
      BLOCKQUOTE.test(line) ||
      TABLE_ROW.test(line) ||
      BOLD_LABEL.test(line)
    ) {
      flush();
      blocks.push({ text: line.trim(), line: index + 1, prose: false });
      return;
    }
    // A list marker or a numbered item starts a new block; continuation lines
    // of the same item join it.
    if (/^\s{0,8}(?:[-*+]|\d{1,3}[.)])\s+/u.test(line)) {
      flush();
      buffer = [line.trim()];
      bufferLine = index + 1;
      return;
    }
    if (!buffer.length) bufferLine = index + 1;
    buffer.push(line.trim());
  });
  flush();
  return blocks;
}

// Private-use code points, so a masked span can never collide with real text.
const MASK_OPEN = "";
const MASK_CLOSE = "";

/** Placeholders keep `$...$` maths and inline code out of sentence splitting. */
function maskSpans(text: string): { masked: string; spans: string[] } {
  const spans: string[] = [];
  const masked = text.replace(/\$[^$]{1,400}\$|`[^`]{1,200}`/gu, (match) => {
    spans.push(match);
    return `${MASK_OPEN}${spans.length - 1}${MASK_CLOSE}`;
  });
  return { masked, spans };
}

function unmask(text: string, spans: string[]): string {
  return text.replace(
    new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, "gu"),
    (_all, index: string) => spans[Number(index)] ?? "",
  );
}

// Where a sentence ends is decided in ../sentenceBoundary, shared with the
// text chunker so the two can never disagree about "Xu et al. (2021)" again.

/**
 * Split a block into sentences.
 *
 * Boundary detection is deliberately conservative: a wrong boundary only
 * changes which text is quoted back in an error message, whereas an aggressive
 * split would cut "Ni-19.5 at.% Mo" in half and ask the model to justify a
 * fragment.
 *
 * THE WHITESPACE RULE IS FOR ASCII ONLY, and applying it to `。？！` meant
 * Chinese never split at all: Chinese does not put a space after a full stop,
 * so an entire paragraph came back as one "sentence". That was not a cosmetic
 * difference. Two independent Chinese sentences citing two different chunks
 * were read as ONE sentence citing both, flagged as `multi-chunk-fusion` -
 * "you fused two chunks into a relationship neither states" - which the note
 * had not done, and whose stated remedy, "split the sentence", was already
 * satisfied. Satisfying that gate then meant quoting every chunk a whole
 * paragraph cited, and echoing the paragraph back verbatim as the `sentence`.
 * A note written in Chinese met a harder gate than the same note in English,
 * for a reason that had nothing to do with what it said.
 *
 * The full-width marks need no whitespace rule: they are not decimal points
 * and they do not end abbreviations, so they are unambiguous wherever they
 * appear.
 */
export function splitSentences(block: string): string[] {
  const { masked, spans } = maskSpans(String(block ?? ""));
  const out: string[] = [];
  let current = "";
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    current += character;
    if (!".?!。？！；;".includes(character)) continue;
    // Split independently cited clauses; keep a shared trailing citation on
    // the whole statement in either language.
    if ((character === ";" || character === "；") && !citedChunkIds(unmask(current, spans)).length) continue;
    if (CJK_TERMINATORS.includes(character)) {
      // A closing quote or bracket after the stop closes THIS sentence.
      while (
        index + 1 < masked.length &&
        TRAILING_CLOSERS.includes(masked[index + 1])
      ) {
        index += 1;
        current += masked[index];
      }
    } else if (isFalseSentenceEnd(current, masked.slice(index + 1))) {
      continue;
    }
    const sentence = current.trim();
    if (sentence) out.push(unmask(sentence, spans));
    current = "";
  }
  const tail = current.trim();
  if (tail) out.push(unmask(tail, spans));
  return out;
}

/**
 * Below this a fragment carries too little to be worth proving.
 *
 * The floor exists so that "See figure 3." and a section's opening clause are
 * not dragged through the gate. It has to be stated per script, because the
 * SAME claim is a different number of characters in each: "Completely
 * eliminates the artifact (chunk 12)." is 45 characters and was audited, while
 * "完全消除伪影（chunk 12）。" is 17 and was not - so the one drift this module
 * names first, an absolute standing where the source hedged, was caught in
 * English and waved through in Chinese. A bilingual library reading and
 * writing in both languages got two different gates.
 *
 * Han characters carry roughly two English characters' worth of content each,
 * which is where the second figure comes from. Anything with Han in it is
 * measured against the lower one; that is deliberately generous to mixed
 * sentences, since a mixed sentence is usually Chinese prose with a technical
 * term or a chunk citation embedded in it.
 */
const MIN_AUDITED_SENTENCE_CHARS = 24;
const MIN_AUDITED_SENTENCE_CHARS_CJK = 10;
const HAN = /\p{Script=Han}/u;

function isTooShortToAudit(sentence: string): boolean {
  const floor = HAN.test(sentence)
    ? MIN_AUDITED_SENTENCE_CHARS_CJK
    : MIN_AUDITED_SENTENCE_CHARS;
  return sentence.length < floor;
}

function contentWords(text: string): Set<string> {
  const words = normalizeWikiText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
  return new Set(words);
}

function matches(patterns: readonly RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found) return found[0];
  }
  return null;
}

/**
 * A citation naming SEVERAL chunks, for stripping only.
 *
 * `CHUNK_REFERENCE` reads one id per citation, which is what an Evidence
 * trail needs and what multi-chunk-fusion counts. It is the wrong tool for
 * erasing a citation from a sentence: given `(chunk 0、1、3、4)` it removes
 * `chunk 0` and leaves `、1、3、4` behind, and those orphaned digits then read
 * as a quantity. A sentence accounting for the thin chunks of a page - which
 * is now required, and which normally also carries a negation - was flagged
 * for a measurement it never mentioned.
 */
const CHUNK_REFERENCE_RUN =
  /(?:chunks?|块|段)\s*#?\s*\d+(?:\s*(?:[-–—]|to|~|、|,|，|and)\s*\d+)*|第\s*\d+\s*(?:块|段)/giu;

/**
 * Are the sentence's numbers the SOURCE's own numbers?
 *
 * `direction-word` and `quantity` are each weak, and two weak signals escalate
 * - the calibration being that "increased by 10%" and "decreased by 10%" are
 * indistinguishable without reading the source. That was written before the
 * note was required to transcribe every measured value with its condition,
 * and the two rules now meet head on: a sentence that does what the template
 * demands - "压力由 0.1 MPa 增至 125 MPa，晶粒尺寸由 273 µm 降至 101 µm，
 * 降幅 63%" - carries a direction word and four numbers, and is flagged every
 * single time. A whole batch of such sentences was, which is how a reading
 * stopped on its first page.
 *
 * The escalation was never about the number; it was about a number the source
 * might not carry. So a number found in the cited chunks stops being a
 * suspicious quantity. What remains, honestly stated: a sentence could copy
 * the values correctly and still reverse their direction. Nothing here would
 * catch that. It is a narrower hole than flagging every data sentence, which
 * had already pushed notes into stating endpoints without trends - and the
 * strong checks, `condition-dropped` above all, still read the source.
 */
function quantitiesComeFromSource(
  sentence: string,
  sources: readonly string[],
): boolean {
  if (!sources.length) return false;
  const stripped = String(sentence).replace(CHUNK_REFERENCE_RUN, " ");
  const numbers = [...stripped.matchAll(/\d+(?:\.\d+)?/gu)].map((m) => m[0]);
  if (!numbers.length) return false;
  const haystacks = sources.map((text) => flattenForTermMatch(text));
  return numbers.every((value) =>
    haystacks.some((text) => text.includes(value)),
  );
}

/** Digits that are neither a chunk citation nor a bibliography bracket. */
function carriesQuantity(sentence: string): boolean {
  const stripped = String(sentence)
    .replace(REFERENCE_BRACKET, " ")
    .replace(CHUNK_REFERENCE_RUN, " ");
  return /\d/u.test(stripped);
}

/** Highest index of an `(i)`/`(1)`-style enumeration in a passage. */
export function enumerationDepth(text: string): number {
  const roman: Record<string, number> = {
    i: 1,
    ii: 2,
    iii: 3,
    iv: 4,
    v: 5,
    vi: 6,
    vii: 7,
    viii: 8,
    ix: 9,
    x: 10,
  };
  let depth = 0;
  for (const match of String(text ?? "").matchAll(
    /\((i{1,3}|iv|vi{0,3}|ix|x|\d{1,2})\)/giu,
  )) {
    const token = match[1].toLowerCase();
    const value = roman[token] ?? Number.parseInt(token, 10);
    if (Number.isInteger(value) && value > depth) depth = value;
  }
  return depth;
}

/**
 * The source sentences a note sentence was plausibly built from.
 *
 * Overlap is measured on distinctive content words, so this finds the passage
 * a sentence is ABOUT without claiming anything about whether it says the same
 * thing. Three shared terms is enough to be the same subject and far too few
 * to be the same assertion - which is exactly the discrimination wanted here:
 * the module then asks whether the source hedged where the note did not.
 */
/**
 * How many distinctive terms a source sentence must share with a note
 * sentence before it counts as the passage that note sentence came from.
 *
 * Three, and deliberately not more. Raising it to four was tried and bought
 * almost nothing on a real note - two fewer flagged sentences out of
 * twenty-nine - while silently losing short sentences that are genuine
 * paraphrases of a long source. The noise this check was accused of came from
 * the hedge list, not from the pairing, and was fixed there instead; see
 * COMMITMENT_HEDGES.
 */
const SOURCE_OVERLAP_TERMS = 3;

function overlappingSourceSentences(
  sentence: string,
  chunkText: string,
): string[] {
  const target = contentWords(sentence);
  if (target.size < SOURCE_OVERLAP_TERMS) return [];
  const out: string[] = [];
  for (const block of splitNoteBlocks(chunkText)) {
    for (const candidate of splitSentences(block.text)) {
      let shared = 0;
      for (const word of contentWords(candidate)) {
        if (target.has(word)) shared += 1;
        if (shared >= SOURCE_OVERLAP_TERMS) break;
      }
      if (shared >= SOURCE_OVERLAP_TERMS) out.push(candidate);
    }
  }
  return out;
}

/**
 * Every chunk a citation reaches, expanding a range into its members.
 *
 * `citedChunkIds` reads one number per citation, and that is right for the
 * fusion count: `chunk 4-6` is one contiguous span the sentence draws on, not
 * three facts welded together. It is wrong for the opposite question - which
 * chunks are allowed to SUPPORT the sentence - and the two were sharing an
 * answer. A record that wrote "chunk 4-6 阐述 … Fe-IMCs …", exactly as the
 * guidance asks, was refused because the term appears in chunk 5 while the
 * check was only looking in chunk 4.
 */
export function citedChunkSpan(text: string): number[] {
  return citedWikiChunkIds(text);
}

/**
 * Flatten the OCR's maths so a term can be found through it.
 *
 * The index stores what MinerU produced: `S(Al$_{2}$CuMg)`, `$\mathrm{i.e.,}$`.
 * A note writes the same phase as `S(Al2CuMg)`, which is correct and is what
 * a person would write - and a plain substring test then reports the term as
 * appearing in none of the chunks it cites. The comparison has to see through
 * the markup, on both sides.
 */
export function flattenForTermMatch(text: string): string {
  return String(text ?? "")
    .replace(/\\(?:mathrm|mathbf|mathit|text|rm)\s*\{([^{}]*)\}/gu, "$1")
    .replace(/\\[a-zA-Z]+/gu, " ")
    .replace(/[${}_^~\\]/gu, "")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

/**
 * Does this chunk introduce the acronym the sentence used?
 *
 * A reading note writes SEM where the paper wrote "scanning electron
 * microscopy", which is what a specialist writing for another specialist
 * does. The substring test cannot see it and reports the technique as absent
 * from its own source. Matching the initials is enough to tell an expansion
 * from an invention: three or more capitals in order, against the first
 * letters of consecutive words.
 */
export function chunkIntroducesAcronym(token: string, chunkText: string): boolean {
  const letters = token.replace(/[^A-Za-z]/gu, "").toLowerCase();
  if (letters.length < 3) return false;
  const words = chunkText.toLowerCase().match(/[a-z]+/gu) ?? [];
  for (let start = 0; start + letters.length <= words.length; start += 1) {
    let ok = true;
    for (let step = 0; step < letters.length; step += 1) {
      if (words[start + step][0] !== letters[step]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Does this sentence ATTRIBUTE its chunks, or pile them behind one assertion?
 *
 * The fusion rule exists for one shape: two facts welded into a relationship
 * neither source states, which is written as a single assertion with the
 * citations gathered at the end - "A and B jointly cause C (chunk 46, chunk
 * 53)". Neither chunk carries that on its own, so each is asked to prove it.
 *
 * It was firing on a different shape as well, and that shape is the one every
 * instruction in this system has been asking for:
 *
 *     加压抬高了相变自由能差（chunk 46），因而形核激活能随之下降（chunk 53）。
 *
 * Each clause names its own source. Nothing is claimed that is not attributed;
 * the sentence relates two findings without asserting anything beyond them.
 * Refusing it made connected prose cost a verbatim quotation per chunk while
 * one fact per line cost nothing - so notes came back as one fact per line,
 * round after round, and every formatting rule added to stop that was
 * arguing with an incentive rather than removing it.
 *
 * The distinction is where the citations SIT. Separated by a clause boundary,
 * they attribute their own clauses. Adjacent, with no boundary between them,
 * they are trailing one assertion, and that is the shape worth proving.
 */
export function citationsAreDistributed(sentence: string): boolean {
  const text = String(sentence ?? "").replace(REFERENCE_BRACKET, " ");
  const spots: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(CHUNK_REFERENCE)) {
    if (match.index === undefined) continue;
    spots.push({ start: match.index, end: match.index + match[0].length });
  }
  if (spots.length < 2) return true;
  for (let i = 1; i < spots.length; i += 1) {
    const between = text.slice(spots[i - 1].end, spots[i].start);
    // A separator is necessary and nowhere near sufficient: the comma in
    // "(chunk 3, chunk 8)" is one, and that is exactly the pile-at-the-end
    // shape this rule exists for. What separates attribution from a pile is
    // whether a CLAUSE stands between them - words of the model's own that
    // the second citation is attached to.
    const separated =
      /[,，、;；:：]|and|while|whereas|so|thus|because/u.test(between);
    const words = between.replace(
      /[\s,;:.·()（）[\]{}、，；：。-]+/gu,
      "",
    );
    if (!separated || words.length < 4) return false;
  }
  return true;
}

/** Acronym-shaped names the sentence asserts something about. */
export function techniqueTokens(sentence: string): string[] {
  const out = new Set<string>();
  for (const match of String(sentence ?? "").matchAll(TECHNIQUE_TOKEN)) {
    const token = match[0];
    if (token.length < 3) continue;
    if (token.replace(/[^A-Z]/gu, "").length < 3) continue;
    out.add(token);
  }
  return [...out];
}

export interface WikiSynthesisAuditOptions {
  /** Indexed chunk text, for the checks that read the source. */
  chunks: readonly WikiAuditChunk[];
}

/**
 * Decide which sentences of a candidate synthesis have to be proved.
 *
 * Returns the flagged sentences in document order. An empty result means
 * nothing in the note reached past the shapes listed at the top of this file -
 * not that the note is true, which is not a thing this can know.
 */
export function auditSynthesis(
  body: string,
  options: WikiSynthesisAuditOptions,
): WikiFlaggedSentence[] {
  const chunkText = new Map<number, string>();
  for (const chunk of options.chunks) {
    chunkText.set(chunk.chunkId, String(chunk.text ?? ""));
  }
  const flagged: WikiFlaggedSentence[] = [];
  const seen = new Set<string>();

  for (const block of splitNoteBlocks(body)) {
    if (!block.prose) continue;
    const blockChunks = citedChunkIds(block.text);
    for (const rawSentence of splitSentences(block.text)) {
      const sentence = normalizeWikiText(rawSentence);
      if (isTooShortToAudit(sentence)) continue;
      // A sentence inherits its block's citations when it carries none of its
      // own: a bullet ending "(chunk 46, chunk 47)" is citing every clause in
      // it, and treating the earlier clauses as uncited would both miss the
      // fusion and produce an error the model cannot act on.
      const own = citedChunkIds(sentence);
      const citedChunks = own.length ? own : blockChunks;
      /*
       * Two different questions, two different answers.
       *
       * `citedChunks` counts CITATIONS, and is what decides fusion: a range
       * is one span the sentence draws on, not several facts welded together.
       * `supporting` is every chunk that range REACHES, and is what the
       * source-reading checks are allowed to look in. Sharing one answer
       * refused a record that wrote "chunk 4-6 阐述 … Fe-IMCs …" - exactly the
       * grouped form the guidance asks for - because the term sits in chunk 5
       * and only chunk 4 was being read.
       */
      const supporting = own.length
        ? citedChunkSpan(sentence)
        : citedChunkSpan(block.text);
      const assertion = rawSentence.replace(/(?:chunks?|块|段)\s*#?\s*\d+(?:\s*(?:[-–—]|to|~|、|,|，)\s*\d+)*|第\s*\d+\s*(?:块|段)/giu, "")
        .replace(/[（(]\s*[)）]/gu, "").trim().replace(/[。.!?]+$/u, "").trim();
      const completeSourceSentence = assertion.length >= 10 && supporting.length === 1 && supporting.every((id) => {
        const source = chunkText.get(id);
        return source !== undefined && splitSentences(source).some((part) => {
          const complete = part.trim().replace(/[。.!?]+$/u, "").trim();
          const match = findWikiSourceQuote(complete, assertion);
          return match !== null && match.excerpt === complete;
        });
      });
      const reasons: WikiSynthesisRisk[] = [];
      const details: string[] = [];

      const absolute = matches(ABSOLUTE_LANGUAGE, sentence);
      if (absolute && !completeSourceSentence) {
        reasons.push("absolute-language");
        details.push(
          `states "${absolute}" - show the passage that states it that strongly, or write the strength the paper used`,
        );
      }
      const relation = matches(RELATION_WORDS, sentence);
      if (relation && !completeSourceSentence) {
        reasons.push("relation-word");
        details.push(
          `asserts the relation "${relation}", whose opposite would read almost identically - quote the passage that fixes it`,
        );
      }
      const direction = matches(DIRECTION_WORDS, sentence);
      if (direction && !completeSourceSentence) {
        reasons.push("direction-word");
        details.push(`carries the direction word "${direction}"`);
      }
      const sourceTexts = supporting
        .map((id) => chunkText.get(id))
        .filter((text): text is string => typeof text === "string");
      // `hasQuantity` stays raw: `condition-dropped` below is a STRONG check
      // and keys on it, and "the number lost its conditions" is a risk whether
      // or not the number came from the source. Only the WEAK signal is
      // suppressed when the value is demonstrably the source's own.
      const hasQuantity = carriesQuantity(sentence);
      if (hasQuantity && !quantitiesComeFromSource(rawSentence, sourceTexts)) {
        reasons.push("quantity");
        details.push(
          "carries a number that is not in the chunks it cites - transcribe the source's own value, or quote the passage this one comes from",
        );
      }
      const negation = matches(NEGATION, sentence);
      if (negation && !completeSourceSentence) {
        reasons.push("negation");
        details.push(`carries the negation "${negation}"`);
      }
      if (parseWikiCitations(rawSentence).length > 1 && !citationsAreDistributed(rawSentence)) {
        reasons.push("multi-chunk-fusion");
        details.push(
          `cites ${citedChunks.length} chunks (${citedChunks.join(", ")}) behind one assertion - quote the supporting passage from each, and explain their contributions, or attribute each clause separately`,
        );
      }

      // The checks that read the source. A sentence citing nothing gets none
      // of them, and is refused separately by the citation rule rather than
      // passing silently.
      const cited = supporting
        .map((id) => ({ id, text: chunkText.get(id) }))
        .filter(
          (entry): entry is { id: number; text: string } =>
            typeof entry.text === "string",
        );

      if (cited.length) {
        const missingSubjects = techniqueTokens(rawSentence).filter((token) => {
          const needle = flattenForTermMatch(token);
          return !cited.some(
            (entry) =>
              // Seen through the OCR's maths, so `S(Al2CuMg)` finds
              // `S(Al$_{2}$CuMg)`...
              flattenForTermMatch(entry.text).includes(needle) ||
              // ...and an acronym finds the phrase the paper spelled out,
              // which is what a note writing SEM for "scanning electron
              // microscopy" was being refused for.
              chunkIntroducesAcronym(token, entry.text),
          );
        });
        if (missingSubjects.length) {
          reasons.push("subject-not-in-cited-chunks");
          details.push(
            `names ${missingSubjects
              .map((token) => `"${token}"`)
              .join(
                ", ",
              )}, which appears in none of the chunks it cites - either the capability belongs to a different technique, or the citation is wrong`,
          );
        }

        if (!matches(HEDGES, sentence)) {
          const hedgedSources: string[] = [];
          for (const entry of cited) {
            for (const source of overlappingSourceSentences(
              sentence,
              entry.text,
            )) {
              const hedge = matches(COMMITMENT_HEDGES, source);
              if (hedge) {
                hedgedSources.push(`chunk ${entry.id} says "${hedge}"`);
                break;
              }
            }
          }
          if (hedgedSources.length) {
            reasons.push("hedge-dropped");
            details.push(
              `states flatly what its source states tentatively: ${hedgedSources.join("; ")} - keep the paper's own strength`,
            );
          }
        }

        // A negation the SOURCE carried and this sentence does not. The
        // reverse - a negation the sentence has - proves nothing: honest prose
        // is full of them. Only the loss is the failure, and it is only
        // visible by reading the passage the sentence came from.
        if (!negation) {
          const negatedSources: string[] = [];
          for (const entry of cited) {
            for (const source of overlappingSourceSentences(
              sentence,
              entry.text,
            )) {
              const lost = matches(NEGATION, source);
              if (lost) {
                negatedSources.push(`chunk ${entry.id} says "${lost}"`);
                break;
              }
            }
          }
          if (negatedSources.length) {
            reasons.push("negation-dropped");
            details.push(
              `its source negates where it does not: ${negatedSources.join("; ")} - a lost negation reads as a capability`,
            );
          }
        }

        // A number kept while the conditions it was measured under were left
        // behind. Same shape as the hedge check, and the same reason: the
        // number alone is not the risk, the number without its "at 200 kV" is.
        if (hasQuantity && !matches(CONDITION_MARKERS, sentence)) {
          const conditionedSources: string[] = [];
          for (const entry of cited) {
            for (const source of overlappingSourceSentences(
              sentence,
              entry.text,
            )) {
              if (!/\d/u.test(source)) continue;
              const marker = matches(CONDITION_MARKERS, source);
              if (marker) {
                conditionedSources.push(`chunk ${entry.id} says "${marker}"`);
                break;
              }
            }
          }
          if (conditionedSources.length) {
            reasons.push("condition-dropped");
            details.push(
              `states a number without the conditions its source attached to it: ${conditionedSources.join("; ")} - carry the conditions with the value`,
            );
          }
        }

        const sentenceDepth = enumerationDepth(rawSentence);
        if (sentenceDepth > 0) {
          for (const entry of cited) {
            const sourceDepth = enumerationDepth(entry.text);
            if (sourceDepth > sentenceDepth) {
              reasons.push("enumeration-shortened");
              details.push(
                `enumerates ${sentenceDepth} item(s) where chunk ${entry.id} enumerates ${sourceDepth} - say which one was dropped and why, or restore it (the dropped item is usually the difficulty)`,
              );
              break;
            }
          }
        }
      }

      // Weak signals only count in company; see STRONG_RISKS.
      const strong = reasons.filter((reason) => STRONG_RISKS.has(reason));
      if (
        !strong.length &&
        reasons.length < WEAK_RISK_THRESHOLD
      ) {
        continue;
      }
      if (!reasons.length) continue;
      const key = sentence.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      flagged.push({ auditId: synthesisAuditId(rawSentence, citedChunks, chunkText), sentence, citedChunks, reasons, details });
    }
  }
  return flagged;
}

export interface WikiSynthesisSupport {
  chunkId: number;
  quote: string;
}

export interface WikiSynthesisAuditEntry {
  auditId?: string;
  sentence?: string;
  support: WikiSynthesisSupport[];
}

function synthesisAuditId(sentence: string, ids: number[], chunks: Map<number, string>): string {
  const stableText = (text: string) => text.replace(/\s+/gu, " ").trim();
  const value = JSON.stringify([stableText(sentence), ids.map((id) => [id, stableText(chunks.get(id) ?? "")])]);
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    a = Math.imul(a ^ value.charCodeAt(index), 0x01000193);
    b = Math.imul(b ^ value.charCodeAt(index), 0x85ebca6b);
  }
  return `audit-v2-${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * The shortest quotation that can prove anything.
 *
 * Below this a quotation degenerates into a shared technical term - quoting
 * "missing wedge" out of a chunk proves the chunk mentions missing wedge, and
 * that is not what the sentence claimed.
 */
export const WIKI_SYNTHESIS_MIN_QUOTE_CHARS = 40;

/**
 * Shortest Evidence excerpt that can identify a passage.
 *
 * Lives beside {@link WIKI_SYNTHESIS_MIN_QUOTE_CHARS} because the two are one
 * decision read at two strengths, and because this module is a leaf that
 * `toolCatalog` can import: the number in the tool contract and the number the
 * server enforces have to be the same number, not two that agree today.
 *
 * Enforced by `WikiService.hydrateEvidence`. Lower than the synthesis floor on
 * purpose: that gate proves a sentence already judged to reach past its source,
 * so it asks for a passage, while this one only has to exclude things that are
 * not passages at all - a term, a heading, a number on its own - and must leave
 * room for a definition or a parameter quoted with its clause.
 */
export const WIKI_EVIDENCE_MIN_EXCERPT_CHARS = 24;

export interface WikiSynthesisAuditProblem {
  auditId?: string;
  sentence: string;
  problem: string;
}

/**
 * Check a submitted audit against the flagged sentences and the real chunks.
 *
 * Three things are verified and nothing else: every flagged sentence is
 * answered, every chunk it cites is quoted, and every quotation is really in
 * that chunk, character for character after the same normalization Evidence
 * uses. Whether the quotation ENTAILS the sentence is the model's judgement -
 * asked for explicitly in the tool contract, and no string rule here pretends
 * to make it.
 */
export function verifySynthesisAudit(
  flagged: readonly WikiFlaggedSentence[],
  submitted: readonly WikiSynthesisAuditEntry[],
  chunks: readonly WikiAuditChunk[],
): WikiSynthesisAuditProblem[] {
  const chunkText = new Map<number, string>();
  for (const chunk of chunks) {
    chunkText.set(chunk.chunkId, String(chunk.text ?? ""));
  }
  const byKey = new Map<string, WikiSynthesisAuditEntry>();
  const problems: WikiSynthesisAuditProblem[] = [];

  for (const entry of submitted) {
    const key = entry.auditId || normalizeWikiText(String(entry?.sentence ?? "")).toLowerCase();
    if (!key) {
      problems.push({
        sentence: "(empty)",
        problem: "an audit entry has no auditId or sentence",
      });
      continue;
    }
    if (byKey.has(key)) problems.push({ sentence: entry.sentence ?? key, auditId: entry.auditId, problem: "duplicate audit entry" });
    byKey.set(key, entry);
  }

  for (const flag of flagged) {
    const key = flag.auditId && byKey.has(flag.auditId) ? flag.auditId : flag.sentence.toLowerCase();
    const entry = byKey.get(key);
    if (!entry) {
      problems.push({
        sentence: flag.sentence,
        problem:
          "not answered - send a support entry for it, or rewrite the sentence so it no longer reaches past the paper",
      });
      continue;
    }
    byKey.delete(key);
    if (entry.auditId && entry.sentence && normalizeWikiText(entry.sentence) !== flag.sentence) {
      problems.push({ auditId: flag.auditId, sentence: flag.sentence, problem: "auditId and sentence refer to different statements" });
      continue;
    }
    const quoted = new Map<number, string>();
    for (const support of entry.support ?? []) {
      const chunkId = Number(support?.chunkId);
      const quote = String(support?.quote ?? "").trim();
      if (!Number.isInteger(chunkId)) {
        problems.push({
          sentence: flag.sentence,
          problem: `a support entry has no valid chunkId (got ${JSON.stringify(support?.chunkId)})`,
        });
        continue;
      }
      const text = chunkText.get(chunkId);
      if (text === undefined) {
        problems.push({
          sentence: flag.sentence,
          problem: `quotes chunk ${chunkId}, which is not an indexed chunk of this paper`,
        });
        continue;
      }
      if (quote.length < WIKI_SYNTHESIS_MIN_QUOTE_CHARS) {
        problems.push({
          sentence: flag.sentence,
          problem: `the quotation from chunk ${chunkId} is ${quote.length} characters; at least ${WIKI_SYNTHESIS_MIN_QUOTE_CHARS} are needed for it to prove anything beyond a shared term`,
        });
        continue;
      }
      if (!findWikiSourceQuote(text, quote)) {
        problems.push({
          sentence: flag.sentence,
          problem: `the quotation offered for chunk ${chunkId} is not in that chunk, character for character. Copy it out of the chunk rather than from the note - the note is your paraphrase. Offered: "${quote.slice(0, 160)}"`,
        });
        continue;
      }
      quoted.set(chunkId, quote);
    }
    const missing = flag.citedChunks.filter((id) => !quoted.has(id));
    if (missing.length) {
      problems.push({
        sentence: flag.sentence,
        problem: `chunk(s) ${missing.join(", ")} are cited but not quoted. Supply the contribution from each cited chunk; the quotations may jointly support the statement. Remove citations that contribute no support`,
      });
    }
  }

  for (const [, entry] of byKey) {
    problems.push({
      auditId: entry.auditId,
      sentence: normalizeWikiText(String(entry.sentence ?? entry.auditId ?? "")),
      problem:
        "this sentence was not flagged or its auditId is stale - use the current auditId after changing the statement, citations or source text",
    });
  }

  return problems.map((problem) => ({ ...problem, auditId: problem.auditId ?? flagged.find((flag) => flag.sentence === problem.sentence)?.auditId }));
}

/**
 * The refusal raised when a final synthesis is not backed by its own citations.
 *
 * A named class rather than a bare Error so the MCP layer can report it as the
 * recoverable, expected outcome it is - the model is meant to answer it and
 * try again, exactly like the integration gate - instead of as a server fault.
 */
export class WikiSynthesisAuditRequired extends Error {
  readonly details: { flagged: number; problems?: number; issues?: WikiFlaggedSentence[]; auditProblems?: WikiSynthesisAuditProblem[]; mode?: "record" | "synthesis" };

  constructor(message: string, details: WikiSynthesisAuditRequired["details"]) {
    super(message);
    this.name = "WikiSynthesisAuditRequired";
    this.details = details;
  }
}

/**
 * Render the flagged sentences as a refusal a model can act on.
 *
 * The list is capped, because a note with a hundred flagged sentences would
 * otherwise produce a refusal nobody can read. What the cap must not do is
 * ask for something it did not show: every flagged sentence has to be answered
 * or rewritten, and the tail used to be dismissed as "N more in the same
 * shape" - which reads as "and some others you need not worry about", while
 * `verifySynthesisAudit` goes on to demand all of them. The trailing line now
 * says what is actually true: the same two options apply to the rest, and they
 * are named by the next submission.
 */
export function describeFlaggedSentences(
  flagged: readonly WikiFlaggedSentence[],
  limit = 40,
): string {
  const shown = flagged.slice(0, limit);
  const lines = shown.map((flag, index) => {
    const cites = flag.citedChunks.length
      ? `cites chunk ${flag.citedChunks.join(", ")}`
      : "cites no chunk";
    return (
      `${index + 1}. ${flag.auditId ?? ""} "${flag.sentence}"\n` +
      `   (${cites}; ${flag.reasons.join(", ")})\n` +
      flag.details.map((detail) => `   - ${detail}`).join("\n")
    );
  });
  if (flagged.length > shown.length) {
    lines.push(
      `... and ${flagged.length - shown.length} more sentence(s) in the same shapes, not listed here ` +
        "because one refusal cannot carry them all. They are NOT excused: every one of them still has " +
        "to be proved or rewritten, and the ones you leave standing are named individually when you " +
        "resubmit. Go through the entire submitted record or macro summary for these shapes rather than only the sentences above - " +
        "rewriting at the paper's own strength costs nothing and clears them without a quotation.",
    );
  }
  return lines.join("\n");
}
