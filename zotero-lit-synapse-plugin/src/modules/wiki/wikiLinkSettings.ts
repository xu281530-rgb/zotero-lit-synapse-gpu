/**
 * Every number the cross-paper link layer has not yet earned.
 *
 * Collected in one file deliberately. The design document is explicit that
 * thresholds, top-K, M, the breadth cap and the representative-chunk count
 * must be calibrated on real 50- and 500-paper libraries before anyone trusts
 * them, and that the mandatory-settlement gate must not be switched on until
 * that measurement exists. None of that measurement has been done. Writing the
 * values inline across six modules would have buried that fact; here it is the
 * first thing anyone reads, and every one of them is overridable from prefs so
 * a calibration run can move them without a build.
 *
 * `mandatorySettlement` is off by default for the same reason and is the one
 * setting that changes what the server REFUSES rather than what it suggests.
 * A false mandatory signal blocks a commit, so it has to be opted into by
 * someone who has looked at the candidates their own library produces.
 */

declare const Zotero: any;

const PREFIX = "extensions.zotero.zotero-lit-synapse.wiki.link.";

export interface WikiLinkSettings {
  /** Master switch for candidate computation. Off leaves the Wiki untouched. */
  enabled: boolean;
  /**
   * Whether a signal whose passages were BOTH read blocks the commit that
   * ignores it. Off until real-library calibration; see the file comment.
   */
  mandatorySettlement: boolean;
  /** Documents kept per paper after the pairwise pass. Design says 6-8. */
  topK: number;
  /** Documents carried from coarse recall into the pairwise pass. */
  coarseCandidates: number;
  /** Anchors kept per pair per signal type. */
  anchorsPerType: number;
  /** Symmetric score below which a pair is not worth a row. */
  minSymmetricScore: number;
  /** Directional score below which a direction contributes no anchor. */
  minDirectionalScore: number;
  /** Chunk-level cosine under which a hit does not count toward breadth. */
  breadthChunkScore: number;
  /**
   * Documents one representative chunk may reach before it counts as
   * boilerplate. Expressed as a fraction of the library, floored at 3.
   */
  breadthCapFraction: number;
  /** Lexical terms considered per pair. */
  lexicalTermsPerPair: number;
  /** A lexical term in more than this fraction of the library is a stopword. */
  lexicalMaxDocumentFraction: number;
  /** Scan deadline for one paper's coarse pass, milliseconds. */
  scanTimeoutMs: number;
}

export const WIKI_LINK_SETTING_DEFAULTS: WikiLinkSettings = {
  enabled: true,
  // The one gate the design forbids enabling before measurement.
  mandatorySettlement: false,
  topK: 8,
  // "M = max(20, 3 × K)", with K at its default.
  coarseCandidates: 24,
  anchorsPerType: 3,
  // Deliberately uncalibrated, like wiki.minScore before it. A pair below this
  // is not stored at all, so the value decides how much of the library becomes
  // a candidate, and nobody has measured what it should be.
  minSymmetricScore: 0.45,
  minDirectionalScore: 0.35,
  breadthChunkScore: 0.5,
  breadthCapFraction: 0.3,
  lexicalTermsPerPair: 3,
  lexicalMaxDocumentFraction: 0.25,
  scanTimeoutMs: 60_000,
};

function read(key: string): unknown {
  try {
    return Zotero.Prefs.get(PREFIX + key, true);
  } catch {
    return undefined;
  }
}

function numeric(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = read(key);
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback;
}

function integer(key: string, fallback: number, min: number, max: number): number {
  return Math.round(numeric(key, fallback, min, max));
}

export function getWikiLinkSettings(): WikiLinkSettings {
  const defaults = WIKI_LINK_SETTING_DEFAULTS;
  return {
    enabled: read("enabled") !== false,
    mandatorySettlement: read("mandatorySettlement") === true,
    topK: integer("topK", defaults.topK, 1, 50),
    coarseCandidates: integer(
      "coarseCandidates",
      defaults.coarseCandidates,
      1,
      500,
    ),
    anchorsPerType: integer("anchorsPerType", defaults.anchorsPerType, 1, 20),
    minSymmetricScore: numeric(
      "minSymmetricScore",
      defaults.minSymmetricScore,
      0,
      1,
    ),
    minDirectionalScore: numeric(
      "minDirectionalScore",
      defaults.minDirectionalScore,
      0,
      1,
    ),
    breadthChunkScore: numeric(
      "breadthChunkScore",
      defaults.breadthChunkScore,
      -1,
      1,
    ),
    breadthCapFraction: numeric(
      "breadthCapFraction",
      defaults.breadthCapFraction,
      0.01,
      1,
    ),
    lexicalTermsPerPair: integer(
      "lexicalTermsPerPair",
      defaults.lexicalTermsPerPair,
      1,
      20,
    ),
    lexicalMaxDocumentFraction: numeric(
      "lexicalMaxDocumentFraction",
      defaults.lexicalMaxDocumentFraction,
      0.01,
      1,
    ),
    scanTimeoutMs: integer(
      "scanTimeoutMs",
      defaults.scanTimeoutMs,
      1_000,
      600_000,
    ),
  };
}

/**
 * `BREADTH_CAP = max(3, floor(0.3 × N))`.
 *
 * A representative chunk that resembles more documents than this is measuring
 * the genre rather than the paper - "samples were sectioned, ground and
 * polished" resembles every metallurgy paper ever written - and must not be
 * allowed to hold up a candidate on its own. Three is the floor because on a
 * library of four papers every fraction rounds to something useless.
 */
export function breadthCap(documentCount: number, fraction: number): number {
  return Math.max(3, Math.floor(fraction * Math.max(0, documentCount)));
}
