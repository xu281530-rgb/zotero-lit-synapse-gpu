/**
 * Deciding which copy of a duplicated document survives, and what it inherits.
 *
 * Merging is the one collection-management operation that DESTROYS something:
 * the losing records go to the trash, and their attachments, notes, collection
 * memberships and relations are moved onto the survivor. Getting the survivor
 * wrong is therefore not a filing mistake that a second call can undo — it is
 * the difference between keeping the record that carries a DOI and an abstract
 * and keeping the one somebody saved from a search page in a hurry.
 *
 * So the choice is made here, as a pure function over what the library
 * reports, and it is made explicit in the plan: every group says which record
 * won and on what grounds. The Zotero call that performs the merge does not
 * get to decide anything.
 */

export interface MergeCandidateCollection {
  collectionKey: string;
  name: string;
  path: string;
}

/** One record as the library currently reports it. */
export interface MergeCandidate {
  itemKey: string;
  found: boolean;
  title?: string;
  itemType?: string;
  /** True for a child note or attachment, which cannot be merged this way. */
  isChildItem?: boolean;
  inTrash?: boolean;
  /** Non-empty metadata fields only; an empty string counts as absent. */
  fields?: Record<string, string>;
  creatorCount?: number;
  attachmentCount?: number;
  collections?: MergeCandidateCollection[];
  /** ISO timestamp, used only to break an exact tie. */
  dateAdded?: string;
}

export interface MergeGroupInput {
  candidates: MergeCandidate[];
  /** Caller's explicit choice. When absent the most complete record wins. */
  masterItemKey?: string;
}

export interface MergeGroupPlan {
  masterItemKey: string;
  masterTitle: string;
  /** Why this record won, in words the user can check against the row. */
  chosenBecause: string;
  merging: Array<{
    itemKey: string;
    title: string;
    attachmentCount: number;
    collections: string[];
  }>;
  /** Attachments and notes that move onto the master. */
  attachmentsMoved: number;
  /** Collection paths the master does not have yet and will gain. */
  collectionsGained: string[];
}

export interface MergePlanSummary {
  groups: number;
  itemsTrashed: number;
  attachmentsMoved: number;
  collectionsGained: number;
}

export interface MergePlanAccepted {
  ok: true;
  groups: MergeGroupPlan[];
  summary: MergePlanSummary;
}

export interface MergePlanProblem {
  groupIndex: number;
  itemKey?: string;
  reason: string;
}

export interface MergePlanRejected {
  ok: false;
  problems: MergePlanProblem[];
  /** Groups that were fine, so the caller can see how much it is losing. */
  wouldHaveMerged: number;
}

export type MergePlanResult = MergePlanAccepted | MergePlanRejected;

/**
 * What a metadata field is worth when choosing a survivor.
 *
 * DOI outweighs everything because it is the field that makes a record
 * citable and de-duplicable forever after; an abstract and a publication
 * title are next because they are what a reader and a search index actually
 * use. Volume, issue and pages are each worth little alone but add up to the
 * difference between a complete citation and one that needs fixing by hand.
 */
const FIELD_WEIGHTS: Record<string, number> = {
  DOI: 5,
  abstractNote: 3,
  publicationTitle: 3,
  date: 2,
  pages: 1,
  volume: 1,
  issue: 1,
  url: 1,
  ISSN: 1,
  ISBN: 1,
  language: 1,
  publisher: 1,
  bookTitle: 1,
  conferenceName: 1,
};

export interface CompletenessScore {
  total: number;
  /** Field names that contributed, for explaining the choice. */
  has: string[];
}

export function scoreMetadataCompleteness(
  candidate: MergeCandidate,
): CompletenessScore {
  const fields = candidate.fields ?? {};
  const has: string[] = [];
  let total = 0;

  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const value = fields[field];
    if (typeof value === "string" && value.trim().length > 0) {
      total += weight;
      has.push(field);
    }
  }

  if ((candidate.creatorCount ?? 0) > 0) {
    total += 2;
    has.push("creators");
  }

  // An attached PDF is evidence the record was actually used, but three
  // attachments are not three times the record: cap it so a copy that
  // accumulated duplicate PDFs cannot outrank one with real metadata.
  const attachments = Math.min(candidate.attachmentCount ?? 0, 3);
  total += attachments;

  return { total, has };
}

function describeChoice(
  score: CompletenessScore,
  candidate: MergeCandidate,
  tiedOn: boolean,
): string {
  const parts: string[] = [];
  if (score.has.includes("DOI")) parts.push("has a DOI");
  if (score.has.includes("abstractNote")) parts.push("has an abstract");
  if (score.has.includes("publicationTitle")) parts.push("names its venue");
  if ((candidate.attachmentCount ?? 0) > 0) {
    parts.push(
      `${candidate.attachmentCount} attachment${(candidate.attachmentCount ?? 0) === 1 ? "" : "s"}`,
    );
  }
  const filed = candidate.collections?.length ?? 0;
  if (filed > 0) parts.push(`filed in ${filed}`);

  const basis = parts.length > 0 ? parts.join(", ") : "no distinguishing metadata";
  return tiedOn
    ? `tied on metadata (${basis}); kept the earliest-added copy`
    : `most complete metadata (${basis}); score ${score.total}`;
}

/**
 * Pick the survivor: the most complete record, then the one filed in the most
 * places, then the earliest added, then the lowest key.
 *
 * The last two tie-breakers exist so the same batch always plans the same way.
 * A merge that picked differently on a retry would make a dry run a promise
 * about nothing.
 */
function chooseMaster(candidates: MergeCandidate[]): {
  master: MergeCandidate;
  score: CompletenessScore;
  tied: boolean;
} {
  const scored = candidates.map((candidate) => ({
    candidate,
    score: scoreMetadataCompleteness(candidate),
  }));

  scored.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    const aFiled = a.candidate.collections?.length ?? 0;
    const bFiled = b.candidate.collections?.length ?? 0;
    if (bFiled !== aFiled) return bFiled - aFiled;
    const aAdded = a.candidate.dateAdded ?? "";
    const bAdded = b.candidate.dateAdded ?? "";
    if (aAdded !== bAdded) return aAdded < bAdded ? -1 : 1;
    return a.candidate.itemKey < b.candidate.itemKey ? -1 : 1;
  });

  const winner = scored[0];
  const tied = scored.length > 1 && scored[1].score.total === winner.score.total;
  return { master: winner.candidate, score: winner.score, tied };
}

/**
 * Validate every group and plan every merge, or refuse the whole batch.
 *
 * Refusal is total for the same reason it is in a collection move: a caller
 * holding a partly-applied merge has to work out which survivors already
 * absorbed which copies before it can retry, and it cannot see the library to
 * find out.
 */
export function planItemMerge(groups: MergeGroupInput[]): MergePlanResult {
  const problems: MergePlanProblem[] = [];
  const plans: MergeGroupPlan[] = [];
  const keySeenInGroup = new Map<string, number>();

  groups.forEach((group, groupIndex) => {
    const candidates = group.candidates ?? [];
    const distinct = new Map<string, MergeCandidate>();

    for (const candidate of candidates) {
      const previous = keySeenInGroup.get(candidate.itemKey);
      if (previous !== undefined && previous !== groupIndex) {
        problems.push({
          groupIndex,
          itemKey: candidate.itemKey,
          reason: `This item also appears in group ${previous + 1}. One record cannot be merged into two different survivors.`,
        });
        continue;
      }
      keySeenInGroup.set(candidate.itemKey, groupIndex);
      if (!distinct.has(candidate.itemKey)) {
        distinct.set(candidate.itemKey, candidate);
      }
    }

    const unique = [...distinct.values()];

    if (unique.length < 2) {
      problems.push({
        groupIndex,
        reason:
          "A merge group needs at least two distinct items; this one has fewer, so there is nothing to merge.",
      });
      return;
    }

    let usable = true;
    for (const candidate of unique) {
      if (!candidate.found) {
        problems.push({
          groupIndex,
          itemKey: candidate.itemKey,
          reason: "No item with this key exists in the library.",
        });
        usable = false;
      } else if (candidate.isChildItem) {
        problems.push({
          groupIndex,
          itemKey: candidate.itemKey,
          reason:
            "This is a child note or attachment. Merge the parent items instead.",
        });
        usable = false;
      } else if (candidate.inTrash) {
        problems.push({
          groupIndex,
          itemKey: candidate.itemKey,
          reason: "This item is in the trash. Restore it in Zotero first.",
        });
        usable = false;
      }
    }
    if (!usable) return;

    const types = new Set(unique.map((candidate) => candidate.itemType ?? ""));
    if (types.size > 1) {
      problems.push({
        groupIndex,
        reason: `Zotero can only merge items of the same type, and this group mixes ${[...types].join(", ")}. Correct the item types in Zotero first, or drop the odd one out.`,
      });
      return;
    }

    let master: MergeCandidate;
    let chosenBecause: string;

    if (group.masterItemKey) {
      const chosen = distinct.get(group.masterItemKey);
      if (!chosen) {
        problems.push({
          groupIndex,
          itemKey: group.masterItemKey,
          reason:
            "The requested master is not one of the items in this group.",
        });
        return;
      }
      master = chosen;
      chosenBecause = "chosen by the caller";
    } else {
      const picked = chooseMaster(unique);
      master = picked.master;
      chosenBecause = describeChoice(picked.score, picked.master, picked.tied);
    }

    const losers = unique.filter(
      (candidate) => candidate.itemKey !== master.itemKey,
    );
    const masterPaths = new Set(
      (master.collections ?? []).map((entry) => entry.path),
    );
    const gained = new Set<string>();
    let attachmentsMoved = 0;

    for (const loser of losers) {
      attachmentsMoved += loser.attachmentCount ?? 0;
      for (const entry of loser.collections ?? []) {
        if (!masterPaths.has(entry.path)) gained.add(entry.path);
      }
    }

    plans.push({
      masterItemKey: master.itemKey,
      masterTitle: master.title || "(no title)",
      chosenBecause,
      merging: losers.map((loser) => ({
        itemKey: loser.itemKey,
        title: loser.title || "(no title)",
        attachmentCount: loser.attachmentCount ?? 0,
        collections: (loser.collections ?? []).map((entry) => entry.path),
      })),
      attachmentsMoved,
      collectionsGained: [...gained].sort(),
    });
  });

  if (problems.length > 0) {
    return { ok: false, problems, wouldHaveMerged: plans.length };
  }

  return {
    ok: true,
    groups: plans,
    summary: {
      groups: plans.length,
      itemsTrashed: plans.reduce((total, plan) => total + plan.merging.length, 0),
      attachmentsMoved: plans.reduce(
        (total, plan) => total + plan.attachmentsMoved,
        0,
      ),
      collectionsGained: plans.reduce(
        (total, plan) => total + plan.collectionsGained.length,
        0,
      ),
    },
  };
}
