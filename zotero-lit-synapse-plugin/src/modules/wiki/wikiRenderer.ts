import type { WikiPageRecord } from "./wikiTypes";
import { rowColumn as value } from "./wikiRow";
import {
  termDisplayName,
  type WikiConceptEntity,
  type WikiTermRecord,
} from "./wikiConceptTerms";

interface WikiMarkdownContext {
  concepts?: any[];
  aliases?: any[];
  relations?: any[];
}

export function renderWikiMarkdown(
  pages: WikiPageRecord[],
  context: WikiMarkdownContext = {},
  conceptLibrary: WikiConceptEntity[] = [],
  sourceNames: Map<string, string> = new Map(),
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
  // The concept library goes at the END of the existing document, after the
  // sections 2.4.2 already produced. Appending rather than interleaving is
  // what keeps this export a superset of the old one: anything that parsed a
  // 2.4.2 Wiki export still finds every heading where it was.
  if (conceptLibrary.length) {
    output.push(...conceptLibrarySection(conceptLibrary, sourceNames));
  }
  return output.join("\n").trimEnd() + "\n";
}

/** One term as a table row: 序号 / 中文术语 / 英文术语 / 简称. */
function termRow(index: number, term: WikiTermRecord | null): string {
  if (!term) return `| ${index} | | | |`;
  return `| ${index} | ${term.zh || "—"} | ${term.en || "—"} | ${term.abbr || "—"} |`;
}

const ORIGIN_NAMES: Record<string, string> = {
  literature: "文献原文",
  ai: "AI 补全",
  user: "人工修改",
};

/**
 * Where each field of each term came from, for readers of the exported file.
 *
 * The panel says this with a tint per cell, which a Markdown table cannot do,
 * so the export states it in words underneath instead. Terms whose provenance
 * was never recorded - everything written before 2.4.4 - contribute nothing
 * rather than a row of blanks.
 */
function originLines(terms: WikiTermRecord[]): string[] {
  const rows: string[] = [];
  terms.forEach((term, index) => {
    const parts = (
      [
        ["中文", term.zh, term.origins.zh],
        ["英文", term.en, term.origins.en],
        ["简称", term.abbr, term.origins.abbr],
      ] as Array<[string, string, string]>
    )
      .filter(([, value, origin]) => value && ORIGIN_NAMES[origin])
      .map(([label, , origin]) => `${label}：${ORIGIN_NAMES[origin]}`);
    if (parts.length) rows.push(`- [${index + 1}] ${parts.join("；")}`);
  });
  return rows.length ? ["术语来源标注：", ...rows, ""] : [];
}

function conceptTitle(concept: WikiConceptEntity): string {
  return (
    concept.displayName ||
    (concept.primaryTerm ? termDisplayName(concept.primaryTerm) : "") ||
    concept.primaryTerm?.abbr ||
    `Concept ${concept.conceptId}`
  );
}

/**
 * One concept, rendered as the terminology view renders it.
 *
 * The table carries every term - primary first, then aliases - and the source
 * list underneath is keyed by the same 序号, so a reader can tell WHICH of a
 * concept's names a given paper actually used. That is the whole reason
 * sources hang off terms rather than off concepts.
 */
function conceptBlock(
  concept: WikiConceptEntity,
  names: Map<string, string>,
  heading: string,
): string[] {
  const lines: string[] = [`${heading} ${conceptTitle(concept)}`, ""];
  if (concept.description) lines.push(concept.description, "");
  lines.push(
    "| 序号 | 中文术语 | 英文术语 | 简称 |",
    "| --- | --- | --- | --- |",
  );
  const terms = [concept.primaryTerm, ...concept.aliasTerms].filter(
    (term): term is WikiTermRecord => Boolean(term),
  );
  terms.forEach((term, index) => lines.push(termRow(index + 1, term)));
  lines.push("");
  lines.push(...originLines(terms));
  const sourced = terms
    .map((term, index) => ({ term, index: index + 1 }))
    .filter((entry) => entry.term.sources.length);
  if (!sourced.length) {
    lines.push("来源文献：暂无记录", "");
    return lines;
  }
  lines.push("来源文献：");
  for (const entry of sourced) {
    for (const source of entry.term.sources) {
      const key = `${source.libraryID}:${source.itemKey}`;
      const label = names.get(key) ?? source.itemKey;
      const locator =
        source.chunkIdSnapshot == null
          ? ""
          : ` · 片段 ${source.chunkIdSnapshot}`;
      lines.push(
        `- [${entry.index}] ${label} (Zotero ${key})${locator}` +
          (source.excerpt ? `: ${source.excerpt}` : ""),
      );
    }
  }
  lines.push("");
  return lines;
}

function conceptLibrarySection(
  concepts: WikiConceptEntity[],
  names: Map<string, string>,
): string[] {
  const lines = ["## 术语库 / Concept Library", ""];
  for (const concept of concepts) {
    lines.push(...conceptBlock(concept, names, "###"));
  }
  return lines;
}

/**
 * The concept library as a document of its own.
 *
 * Same block renderer as the appendix inside the Wiki export, so the two can
 * never describe a concept differently - only the surrounding document
 * differs. `names` maps `libraryID:itemKey` to a readable citation; anything
 * missing falls back to the item key, which is still resolvable in Zotero.
 */
export function renderConceptLibraryMarkdown(
  concepts: WikiConceptEntity[],
  names: Map<string, string> = new Map(),
): string {
  const output = [
    "# Zotero LLM 术语库",
    "",
    `共 ${concepts.length} 个概念。`,
    "",
  ];
  if (!concepts.length) {
    output.push("知识库中还没有记录任何概念。", "");
  }
  for (const concept of concepts) {
    output.push(...conceptBlock(concept, names, "##"));
  }
  return output.join("\n").trimEnd() + "\n";
}
