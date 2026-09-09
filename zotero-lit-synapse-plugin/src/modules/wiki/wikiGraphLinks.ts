import type { GraphLinkInput } from "./graph3D";
import type { LinkFacts } from "./wikiGraphDetails";

interface SharedGraphContext {
  pages: Array<{
    pageId: number;
    claims: Array<{
      claimId: number;
      evidence: Array<{ itemKey: string; linkState: string }>;
    }>;
  }>;
  concepts: Array<{
    conceptId: number;
    name: string;
    df: number;
    idf: number;
    itemKeys: string[];
  }>;
}

export interface DocumentPairLink {
  kind: "document-pair";
  relations: GraphLinkInput[];
}

/** Display priority is independent of similarity scores or relation counts. */
function priority(link: GraphLinkInput): number {
  if (link.tone === "conflict") return 5;
  if (link.style === "solid") return 4;
  if (link.style === "comparison") return 3;
  if (link.style === "dashed") return 2;
  if (link.style === "dotdash") return 1;
  return 0;
}

export function graphRelationLabel(link: GraphLinkInput): string {
  if (link.tone === "conflict") return "存在分歧";
  if (link.style === "solid") return "共享论断";
  if (link.style === "comparison") return "方法差异或限定";
  if (link.style === "dashed") return "同一条目";
  if (link.style === "dotdash") return "共享概念";
  return "候选连接";
}

/** Retain every payload for inspection, while drawing one strongest line per pair. */
export function aggregateDocumentLinks(
  links: GraphLinkInput[],
  context?: SharedGraphContext,
): GraphLinkInput[] {
  const pairs = new Map<string, GraphLinkInput[]>();
  for (const link of links) {
    const key = JSON.stringify([link.source, link.target].sort());
    const relations = pairs.get(key) ?? [];
    relations.push(link);
    pairs.set(key, relations);
  }
  // Complete only pairs already on the canvas, without generating dense cliques.
  if (context)
    for (const relations of pairs.values()) {
      const first = relations[0];
      const a = first.source.replace(/^item:/, ""),
        b = first.target.replace(/^item:/, "");
      const facts = relations.map((r) => r.payload as LinkFacts);
      const pageIds = new Set(
        facts.filter((f) => f?.kind === "same-page").map((f) => f.pageId),
      );
      const conceptIds = new Set(
        facts.flatMap((f) => f?.concepts?.map((c) => c.conceptId) ?? []),
      );
      for (const page of context.pages) {
        if (pageIds.has(page.pageId)) continue;
        const from = (key: string) =>
          page.claims.some((c) =>
            c.evidence.some(
              (e) => e.linkState === "valid" && e.itemKey === key,
            ),
          );
        if (!from(a) || !from(b)) continue;
        relations.push({
          source: first.source,
          target: first.target,
          style: "dashed",
          strength: 1,
          payload: {
            kind: "same-page",
            a,
            b,
            pageId: page.pageId,
            claimIds: page.claims
              .filter((c) =>
                c.evidence.some(
                  (e) => e.linkState === "valid" && [a, b].includes(e.itemKey),
                ),
              )
              .map((c) => c.claimId),
          } satisfies LinkFacts,
        });
      }
      for (const concept of context.concepts) {
        if (
          conceptIds.has(concept.conceptId) ||
          !concept.itemKeys.includes(a) ||
          !concept.itemKeys.includes(b)
        )
          continue;
        relations.push({
          source: first.source,
          target: first.target,
          style: "dotdash",
          strength: 1,
          payload: {
            kind: "shared-concept",
            a,
            b,
            claimIds: [],
            concepts: [concept],
            conceptScore: concept.idf,
          } satisfies LinkFacts,
        });
      }
    }
  return Array.from(pairs.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, relations]) => {
      relations.sort(
        (a, b) =>
          priority(b) - priority(a) ||
          JSON.stringify(a.payload ?? {}).localeCompare(
            JSON.stringify(b.payload ?? {}),
          ),
      );
      const primary = relations[0];
      const [source, target] = [primary.source, primary.target].sort();
      return {
        ...primary,
        source,
        target,
        label: `${graphRelationLabel(primary)} · ${relations.length} 项关系`,
        payload: {
          kind: "document-pair",
          relations,
        } satisfies DocumentPairLink,
      };
    });
}
