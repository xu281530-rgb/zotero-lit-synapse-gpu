/**
 * Which key on an annotation row means what.
 *
 * A mark lives three levels down: annotation -> attachment -> document. The
 * old row reported one field, `parentKey`, which held the ATTACHMENT key for a
 * highlight and the ITEM key for a note. One name, two meanings, and no way
 * for a caller to tell them apart. Feeding a highlight's `parentKey` to
 * get_annotations, get_item_details or search_fulltext found nothing and
 * looked like "this paper has no marks" rather than like a wrong key.
 *
 * `sourceItemKey` is the replacement, and it means exactly one thing: the
 * BIBLIOGRAPHIC ITEM this mark belongs to. When there is no such item it is
 * null, not a substitute.
 *
 * That distinction was not free to learn. A standalone note briefly reported
 * its own key here, on the reasoning that a top-level note is an item in its
 * own right — and against the live library it reproduced the original bug
 * exactly: get_annotations(itemKeys: ["2YNJQJ9U"]) returned 0 marks with
 * mode "empty", and get_document_chunks answered that the note "has a text
 * attachment but is not in the semantic index yet". A key that every
 * document-level tool silently rejects is not a document key, whatever else it
 * is a key for. Null says so; the row's own key remains available as
 * `annotationKey`.
 *
 * The resolution is pure and lives here so it can be tested without Zotero,
 * and so the note path and the annotation path go through one place rather
 * than each inventing its own answer.
 */

/** Why a row has no document. Present only when `sourceItemKey` is null. */
export type NoSourceItemReason = "standalone_note" | "standalone_attachment";

export interface AnnotationKeySet {
  /** The mark itself. */
  annotationKey: string;
  /** The PDF the mark sits on. Absent for notes, which have no attachment. */
  attachmentKey?: string;
  /**
   * The bibliographic item, and the only key here that a document-level tool
   * accepts. Null when the mark hangs off nothing filed under a document.
   */
  sourceItemKey: string | null;
  /**
   * Set exactly when `sourceItemKey` is null, so a caller reading the row
   * knows this is a fact about the library rather than a lookup that failed.
   */
  noSourceItemReason?: NoSourceItemReason;
}

/**
 * Resolve the three keys from what the item hierarchy actually offers.
 *
 * `attachmentParentKey` is the attachment's own parent, and `noteParentKey` a
 * note's; Zotero files both only under regular items, so either one being
 * present means the document is real. Either being false/null means the
 * container sits at the top level of the library and there is nothing above it.
 */
export function resolveAnnotationKeys(input: {
  ownKey: string;
  attachmentKey?: string | false | null;
  attachmentParentKey?: string | false | null;
  noteParentKey?: string | false | null;
}): AnnotationKeySet {
  const attachmentKey = input.attachmentKey || undefined;
  const sourceItemKey =
    (attachmentKey ? input.attachmentParentKey : input.noteParentKey) || null;

  return {
    annotationKey: input.ownKey,
    ...(attachmentKey ? { attachmentKey } : {}),
    sourceItemKey,
    ...(sourceItemKey
      ? {}
      : {
          noSourceItemReason: attachmentKey
            ? ("standalone_attachment" as const)
            : ("standalone_note" as const),
        }),
  };
}
