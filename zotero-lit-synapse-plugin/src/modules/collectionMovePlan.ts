/**
 * Deciding what a move DOES, separately from performing it.
 *
 * The safety of `move_items_to_collection` rests entirely on one rule — a
 * batch that contains anything unmovable must move nothing — and that rule is
 * a property of the plan, not of the database. Kept here as a pure function it
 * can be tested against every awkward batch (a deleted item, a child
 * attachment, the same key twice, an item already in the target) without a
 * Zotero instance; left inside the handler it could only ever be tested by
 * reorganising somebody's real library.
 */

export interface MoveCandidateCollection {
  collectionKey: string;
  name: string;
  path: string;
}

/**
 * One item as the library currently reports it. Everything the decision needs
 * is on this record, so the caller does the Zotero lookups and this file does
 * the judging.
 */
export interface MoveCandidate {
  itemKey: string;
  /** Null when no item with this key exists in the library. */
  found: boolean;
  title?: string;
  /** True for a child note or attachment, which Zotero cannot file. */
  isChildItem?: boolean;
  inTrash?: boolean;
  collections?: MoveCandidateCollection[];
}

export interface MovePlanRow {
  itemKey: string;
  title: string;
  /** Paths of the collections this item is filed OUT of by the move. */
  leaving: string[];
  alreadyInTarget: boolean;
}

export interface MovePlanSummary {
  items: number;
  alreadyInTarget: number;
  removedFilings: number;
  duplicateKeysIgnored?: number;
}

export interface MovePlanAccepted {
  ok: true;
  rows: MovePlanRow[];
  summary: MovePlanSummary;
}

export interface MovePlanRejected {
  ok: false;
  notFound: string[];
  notFilable: Array<{ itemKey: string; reason: string }>;
  /** How much of the batch was fine, so the caller can say what it is losing. */
  wouldHaveMoved: number;
}

export type MovePlanResult = MovePlanAccepted | MovePlanRejected;

const CHILD_ITEM_REASON =
  "This is a child note or attachment. Only top-level items can be filed in a collection — move its parent item instead.";
const TRASHED_REASON = "This item is in the trash. Restore it in Zotero first.";

/**
 * Work out where every item ends up, or refuse the batch.
 *
 * Duplicated keys are collapsed rather than rejected: asking to move the same
 * paper twice is a redundant instruction, not a contradictory one, and the
 * count is reported so a caller can notice its own double-entry.
 */
export function planCollectionMove(
  candidates: MoveCandidate[],
  toCollectionKey: string,
): MovePlanResult {
  const rows: MovePlanRow[] = [];
  const notFound: string[] = [];
  const notFilable: Array<{ itemKey: string; reason: string }> = [];
  const seen = new Set<string>();
  let duplicateKeysIgnored = 0;

  for (const candidate of candidates) {
    if (seen.has(candidate.itemKey)) {
      duplicateKeysIgnored++;
      continue;
    }
    seen.add(candidate.itemKey);

    if (!candidate.found) {
      notFound.push(candidate.itemKey);
      continue;
    }
    if (candidate.isChildItem) {
      notFilable.push({ itemKey: candidate.itemKey, reason: CHILD_ITEM_REASON });
      continue;
    }
    if (candidate.inTrash) {
      notFilable.push({ itemKey: candidate.itemKey, reason: TRASHED_REASON });
      continue;
    }

    const current = candidate.collections ?? [];
    rows.push({
      itemKey: candidate.itemKey,
      title: candidate.title || "(no title)",
      leaving: current
        .filter((entry) => entry.collectionKey !== toCollectionKey)
        .map((entry) => entry.path),
      alreadyInTarget: current.some(
        (entry) => entry.collectionKey === toCollectionKey,
      ),
    });
  }

  if (notFound.length > 0 || notFilable.length > 0) {
    return {
      ok: false,
      notFound,
      notFilable,
      wouldHaveMoved: rows.length,
    };
  }

  return {
    ok: true,
    rows,
    summary: {
      items: rows.length,
      alreadyInTarget: rows.filter((row) => row.alreadyInTarget).length,
      removedFilings: rows.reduce((total, row) => total + row.leaving.length, 0),
      ...(duplicateKeysIgnored > 0 ? { duplicateKeysIgnored } : {}),
    },
  };
}
