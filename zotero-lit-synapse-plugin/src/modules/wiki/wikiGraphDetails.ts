import type { GraphLinkInput } from "./graph3D";
import type { DocumentPairLink } from "./wikiGraphLinks";
import { commandBlock, element } from "./wikiDom";

export interface LinkFacts {
  kind:
    | "shared-claim"
    | "same-page"
    | "shared-concept"
    | "candidate"
    | "claim-relation";
  a: string;
  b: string;
  claimIds: number[];
  stance?: "support" | "conflict" | "context";
  pageId?: number;
  relation?: any;
  concepts?: Array<{
    conceptId: number;
    name: string;
    df: number;
    idf: number;
  }>;
  conceptScore?: number;
  signals?: Array<{
    signalId: number;
    signalType: string;
    score: number;
    termSnapshot: string;
    thisExcerpt: string;
    otherExcerpt: string;
    mustResolve: boolean;
  }>;
  candidateScore?: number;
  mustResolve?: boolean;
}

interface DetailContext {
  doc: Document;
  documentTitle(key: string): string;
  claim(id: number): { page: any; claim: any } | undefined;
  page(id: number): any;
  openClaim(page: any, claim: any): void;
  openConcept(id: number): void;
  getConcept(id: number): Promise<any>;
}

const roleNames: Record<string, string> = {
  SUPPORTS: "支持",
  CONTRADICTS: "反驳",
  QUALIFIES: "限定",
  EXAMPLE: "示例",
};

/** Candidates and established relations share exactly the same card and quote DOM. */
export async function renderGraphLinkDetails(
  root: HTMLElement,
  link: GraphLinkInput,
  context: DetailContext,
): Promise<void> {
  const { doc } = context;
  const payload = link.payload as DocumentPairLink | LinkFacts;
  const facts =
    payload.kind === "document-pair"
      ? payload.relations.map((r) => r.payload as LinkFacts)
      : [payload];
  root.replaceChildren();
  if (!facts.length) return;
  const heading = element(doc, "h2");
  for (const key of [facts[0].a, facts[0].b]) {
    const document = element(doc, "span", "zmp-wiki-graph-document");
    document.append(
      element(doc, "strong", "zmp-wiki-graph-item-key", key),
      element(doc, "span", "", context.documentTitle(key)),
    );
    heading.append(document);
  }
  root.append(heading);
  const loading: Promise<void>[] = [];
  const quoteGroups = new WeakMap<HTMLElement, Map<string, HTMLDetailsElement>>();

  const card = (title: string, detail = "", conflict = false): HTMLElement => {
    const node = element(
      doc,
      "div",
      `zmp-wiki-graph-claim${conflict ? " is-conflict" : ""}`,
    );
    const head = element(doc, "div", "zmp-wiki-graph-claim-head");
    head.append(element(doc, "span", "zmp-wiki-claim-type", title));
    if (detail)
      head.append(element(doc, "small", "zmp-wiki-graph-context", detail));
    node.append(head);
    root.append(node);
    return node;
  };
  const quote = (
    node: HTMLElement,
    itemKey: string,
    excerpt: string,
    detail = "",
  ) => {
    let groups = quoteGroups.get(node);
    if (!groups) {
      groups = new Map();
      quoteGroups.set(node, groups);
    }
    let block = groups.get(itemKey);
    if (!block) {
      block = element(doc, "details", "zmp-wiki-graph-quote");
      block.dataset.itemKey = itemKey;
      block.append(element(doc, "summary", "zmp-wiki-graph-quote-source", itemKey));
      groups.set(itemKey, block);
      node.append(block);
    }
    const passage = element(doc, "div", "zmp-wiki-graph-passage");
    if (detail)
      passage.append(element(doc, "div", "zmp-wiki-graph-passage-reference", detail));
    passage.append(
      element(doc, "p", "zmp-wiki-graph-quote-text", excerpt || "未保存摘录。"),
    );
    block.append(passage);
  };
  const claim = (node: HTMLElement, id: number, selectedEvidence: any[]) => {
    const found = context.claim(id);
    if (!found) {
      node.append(element(doc, "p", "", `Claim ${id} 当前不可用。`));
      return;
    }
    const open = commandBlock(
      doc,
      `Claim ${id}：${found.claim.claimText}`,
      `打开论断 ${id}`,
    );
    open.addEventListener("click", () =>
      context.openClaim(found.page, found.claim),
    );
    // Scope document groups to this Claim, even in cards with multiple Claims.
    const evidenceGroup = element(doc, "div", "zmp-wiki-graph-claim-evidence");
    evidenceGroup.dataset.claimId = String(id);
    evidenceGroup.append(open);
    node.append(evidenceGroup);
    for (const evidence of selectedEvidence)
      quote(
        evidenceGroup,
        evidence.itemKey,
        evidence.excerpt,
        `Evidence ${evidence.evidenceId} · ${roleNames[evidence.evidenceRole] ?? evidence.evidenceRole ?? ""}`,
      );
  };

  for (const fact of facts) {
    const relevantEvidence = (id: number): any[] =>
      (context.claim(id)?.claim.evidence ?? []).filter(
        (e: any) =>
          e.linkState === "valid" && [fact.a, fact.b].includes(e.itemKey),
      );
    if (fact.kind === "candidate") {
      const labels: Record<string, string> = {
        semantic: "语义相似",
        lexical: "共享术语",
        concept: "共享概念",
      };
      for (const signal of fact.signals ?? []) {
        const node = card(
          `待核验线索 · ${labels[signal.signalType] ?? signal.signalType}`,
          [
            signal.termSnapshot,
            `Signal ${signal.signalId}`,
            `相关度 ${signal.score.toFixed(3)}`,
          ]
            .filter(Boolean)
            .join(" · "),
        );
        node.append(
          element(
            doc,
            "p",
            "",
            `对称相关度 ${(fact.candidateScore ?? 0).toFixed(3)} · ${signal.mustResolve || fact.mustResolve ? "本次待核验" : "尚未核验"}`,
          ),
        );
        quote(node, fact.a, signal.thisExcerpt);
        quote(node, fact.b, signal.otherExcerpt);
      }
    } else if (fact.kind === "shared-concept") {
      for (const concept of fact.concepts ?? []) {
        const node = card(
          "共享概念",
          `Concept ${concept.conceptId} · ${concept.df} 篇文献使用 · 稀有度 ${concept.idf.toFixed(2)}`,
        );
        const open = commandBlock(
          doc,
          concept.name,
          `在术语库中打开概念 ${concept.conceptId}`,
        );
        open.addEventListener("click", () =>
          context.openConcept(concept.conceptId),
        );
        const status = element(doc, "p", "", "正在读取术语依据…");
        node.append(open, status);
        // Each async result only updates its own card, even after another line is selected.
        loading.push(
          context
            .getConcept(concept.conceptId)
            .then((entity) => {
              status.remove();
              const seen = new Set<number>();
              for (const term of [
                entity?.primaryTerm,
                ...(entity?.aliasTerms ?? []),
              ].filter(Boolean)) {
                for (const source of term.sources ?? []) {
                  if (
                    ![fact.a, fact.b].includes(source.itemKey) ||
                    seen.has(source.sourceId)
                  )
                    continue;
                  seen.add(source.sourceId);
                  quote(
                    node,
                    source.itemKey,
                    source.excerpt,
                    `术语来源 ${source.sourceId}${source.chunkIdSnapshot == null ? "" : ` · chunk ${source.chunkIdSnapshot}`}`,
                  );
                }
              }
              if (!seen.size)
                node.append(
                  element(doc, "p", "", "当前没有可用的术语来源摘录。"),
                );
            })
            .catch(() => {
              status.textContent = "术语依据读取失败。";
            }),
        );
      }
    } else if (fact.kind === "claim-relation") {
      const relation = fact.relation;
      const labels: Record<string, string> = {
        compares_with: "方法差异",
        qualifies_scope: "适用限制",
        extends_method: "方法扩展",
      };
      const node = card(
        labels[relation.relationType] ?? "论断关系",
        `核验任务 ${relation.taskId} · 记录 ${relation.reviewId}`,
      );
      node.append(
        element(doc, "p", "", relation.statement),
        element(doc, "p", "", `比较维度：${relation.dimension}`),
        element(doc, "p", "", `适用条件：${relation.conditions}`),
      );
      for (const id of fact.claimIds)
        claim(
          node,
          id,
          relation.evidenceBindings.filter((e: any) => e.claimId === id),
        );
    } else if (fact.kind === "same-page") {
      const page = fact.pageId == null ? undefined : context.page(fact.pageId);
      const node = card(
        "同一条目",
        page?.canonicalTitle ?? `Page ${fact.pageId}`,
      );
      node.append(
        element(doc, "p", "", "页面共属，不代表两篇论文支持同一命题。"),
      );
      for (const id of fact.claimIds) claim(node, id, relevantEvidence(id));
    } else {
      for (const id of fact.claimIds) {
        const title =
          fact.stance === "conflict"
            ? "存在分歧"
            : fact.stance === "support"
              ? "共同支持"
              : "共同引用";
        const node = card(
          title,
          `Claim ${id} · ${context.claim(id)?.page.canonicalTitle ?? ""}`,
          fact.stance === "conflict",
        );
        claim(node, id, relevantEvidence(id));
      }
    }
  }
  await Promise.all(loading);
}
