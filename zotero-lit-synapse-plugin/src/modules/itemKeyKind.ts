/**
 * What kind of thing a key names, and what to say when it is not a document.
 *
 * Zotero keys are all the same shape, so nothing about `32MBWFLW` says whether
 * it is a paper, the PDF under it, a note, or a highlight. The document-level
 * tools take a document key, and when handed one of the others they used to
 * fail in the two worst possible ways:
 *
 *  - get_item_details SUCCEEDED on an attachment key, returning
 *    `itemType: "attachment"` with the PDF's filename as the title. That reads
 *    as a bibliographic record for a paper called
 *    "2020-Statistical-Numerical_Model_...pdf".
 *  - get_document_chunks and search_fulltext, handed a note key, reported that
 *    the item "has a text attachment but is not in the semantic index yet".
 *    A note has no attachment. The suggested fix — build the index — can never
 *    make the call work, so the caller retries into a dead end.
 *
 * Both are the same defect as the old `parentKey`: a wrong key that does not
 * look wrong. This module answers with what the key actually names and which
 * key or tool to use instead.
 */

export type ItemKeyKind =
  /** A bibliographic item: what every document-level tool expects. */
  | "regular"
  /** A file hanging off a document. */
  | "attachment"
  /** A note, either the user's own top-level note or one filed on a document. */
  | "note"
  /** A single highlight/ink/image mark. */
  | "annotation";

export interface ItemKeyIdentity {
  key: string;
  kind: ItemKeyKind;
  /** The document above it, when there is one. */
  parentItemKey?: string;
}

/**
 * The refusal for a key that is not a document, or null when it is one.
 *
 * `tool` names the caller so the message can say what that specific tool needs
 * rather than something generic.
 */
export function describeNonDocumentKey(
  identity: ItemKeyIdentity,
  tool: string,
): string | null {
  if (identity.kind === "regular") return null;

  const { key, kind, parentItemKey } = identity;
  const useInstead = parentItemKey
    ? `Its document is ${parentItemKey} — call ${tool} with that key instead.`
    : null;

  switch (kind) {
    case "attachment":
      return [
        `${key} is an attachment (a file), not a document, and ${tool} takes a document key.`,
        useInstead ??
          `It is a standalone attachment with no document above it, so there is no bibliographic record to return. Read its text with get_attachment_text, or ask the user to file it under an item.`,
        `Attachment keys turn up in search_annotations results as attachmentKey; the key to continue with is sourceItemKey.`,
      ].join(" ");
    case "note":
      return [
        `${key} is a note — something the user wrote — not a document with a body, and ${tool} takes a document key.`,
        `Read notes with get_annotations, which returns them alongside the highlights as what they are.`,
        useInstead ??
          `This is a top-level note that belongs to no document, so there is nothing further up to read.`,
      ].join(" ");
    case "annotation":
      return [
        `${key} is a single annotation (one highlight or mark), not a document, and ${tool} takes a document key.`,
        `Read marks with get_annotations, passing this key as annotationIds.`,
        useInstead ??
          `Its document could not be resolved from the annotation itself.`,
      ].join(" ");
    default:
      return null;
  }
}
