import type { WikiPageRecord } from "./wikiTypes";
import { rowColumn as value } from "./wikiRow";

interface WikiMarkdownContext {
  concepts?: any[];
  aliases?: any[];
  relations?: any[];
}

export function renderWikiMarkdown(
  pages: WikiPageRecord[],
  context: WikiMarkdownContext = {},
): string {
  const output = ["# Zotero LLM Wiki", ""];
  const concepts = new Map(
    (context.concepts ?? []).map((concept) => [
      Number(value(concept, "concept_id", "conceptId")),
      concept,
    ]),
  );
  const aliases = new Map<number, string[]>();
  for (const alias of context.aliases ?? []) {
    const conceptId = Number(value(alias, "concept_id", "conceptId"));
    const list = aliases.get(conceptId) ?? [];
    list.push(String(alias.alias));
    aliases.set(conceptId, list);
  }
  for (const page of pages) {
    output.push(`## ${page.canonicalTitle}`, "");
    if (page.primaryConceptId != null) {
      const concept = concepts.get(page.primaryConceptId);
      if (concept) {
        output.push(
          `Concept: ${String(value(concept, "canonical_name", "canonicalName"))}`,
        );
        const names = aliases.get(page.primaryConceptId) ?? [];
        if (names.length) output.push(`Aliases: ${names.join(", ")}`);
        output.push("");
      }
    }
    if (page.summary) output.push(page.summary, "");
    for (const claim of page.claims) {
      output.push(
        `### Claim ${claim.claimId}: ${claim.claimType}`,
        "",
        claim.claimText,
        "",
        `Status: ${claim.epistemicStatus}; coverage: ${claim.coverageLevel}; confidence: ${claim.confidence}`,
        "",
      );
      for (const evidence of claim.evidence) {
        output.push(
          `- ${evidence.evidenceRole} [${evidence.readDepth}, ${evidence.linkState}] Zotero ${evidence.libraryID}:${evidence.itemKey} chunk ${evidence.chunkIdSnapshot}: ${evidence.excerpt}`,
        );
      }
      output.push("");
    }
  }
  if ((context.relations ?? []).length) {
    output.push("## Concept Relations", "");
    for (const relation of context.relations ?? []) {
      const sourceId = Number(
        value(relation, "source_concept_id", "sourceConceptId"),
      );
      const targetId = Number(
        value(relation, "target_concept_id", "targetConceptId"),
      );
      const source = concepts.get(sourceId);
      const target = concepts.get(targetId);
      output.push(
        `- ${String(value(source, "canonical_name", "canonicalName") ?? sourceId)} ${String(
          relation.predicate,
        )} ${String(value(target, "canonical_name", "canonicalName") ?? targetId)} (confidence ${Number(
          relation.confidence,
        )})`,
      );
    }
    output.push("");
  }
  return output.join("\n").trimEnd() + "\n";
}
