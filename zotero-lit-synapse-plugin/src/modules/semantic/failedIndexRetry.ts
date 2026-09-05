import type { FailedIndexItem } from "./vectorStore";

/** Keep retry batches scoped to both their originating build and Library. */
export function groupFailedIndexItems(
  failures: Iterable<FailedIndexItem>,
): FailedIndexItem[][] {
  const groups = new Map<string, FailedIndexItem[]>();
  for (const failure of failures) {
    const identity = `${failure.buildID ?? "none"}:${failure.libraryID}`;
    const group = groups.get(identity) ?? [];
    group.push(failure);
    groups.set(identity, group);
  }
  return Array.from(groups.values());
}
