export const STANDARD_AGGREGATE_CONTENT_LIMITS = Object.freeze({
  maxContentLength: 3000,
  maxAttachments: 10,
  maxNotes: 15,
  includeWebpage: true,
});

export function resolveAttachmentContentLimit(
  preserveOriginal: boolean,
): number {
  return preserveOriginal
    ? -1
    : STANDARD_AGGREGATE_CONTENT_LIMITS.maxContentLength;
}
