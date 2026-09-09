import type { WikiClaimRecord } from "./wikiTypes";

export function evidenceOverview(
  claim: Pick<
    WikiClaimRecord,
    "evidence" | "confidence" | "coverageLevel" | "epistemicStatus"
  >,
  assessment: any = null,
): any {
  const bySource = new Map<string, any>();
  const depth = [
    "chunk_local",
    "section_read",
    "paper_reviewed",
    "cross_paper",
  ];
  for (const e of claim.evidence) {
    const key = `${e.libraryID}:${e.itemKey}`;
    const source = bySource.get(key) ?? {
      libraryID: e.libraryID,
      itemKey: e.itemKey,
      validRoles: [],
      historicalRoles: [],
      readDepth: null,
      traceability: [],
    };
    if (e.linkState === "valid") {
      if (!source.validRoles.includes(e.evidenceRole))
        source.validRoles.push(e.evidenceRole);
      if (depth.indexOf(e.readDepth) > depth.indexOf(source.readDepth))
        source.readDepth = e.readDepth;
    } else if (
      e.linkState === "source_deleted" &&
      !source.historicalRoles.includes(e.evidenceRole)
    )
      source.historicalRoles.push(e.evidenceRole);
    if (!source.traceability.includes(e.linkState))
      source.traceability.push(e.linkState);
    bySource.set(key, source);
  }
  const sources = [...bySource.values()].sort(
    (a, b) => a.libraryID - b.libraryID || a.itemKey.localeCompare(b.itemKey),
  );
  const count = (role: string) =>
    sources.filter((s) => s.validRoles.includes(role)).length;
  const currentAssessment =
    assessment?.validity === "valid" ? assessment : null;
  return {
    supportingSources: count("SUPPORTS"),
    contradictingSources: count("CONTRADICTS"),
    qualifyingSources: count("QUALIFIES"),
    exampleSources: count("EXAMPLE"),
    sourceEntries: sources.length,
    historicalSupportingSources: sources.filter((s) =>
      s.historicalRoles.includes("SUPPORTS"),
    ).length,
    sources,
    independence: currentAssessment?.independence ?? "unknown",
    supportCompleteness: currentAssessment?.supportCompleteness ?? "unverified",
    conditionCompleteness:
      currentAssessment?.conditionCompleteness ?? "unverified",
    basisTypes: currentAssessment?.basisTypes ?? [],
    assessment,
    scoreKind: "heuristic",
    scoreVersion: "legacy-evidence-v1",
    legacyScore: claim.confidence,
    scoreExplanation: {
      epistemicStatus: claim.epistemicStatus,
      coverageLevel: claim.coverageLevel,
      includesArchivedSources: true,
      meaning:
        "Heuristic evidence bookkeeping score, not a probability of correctness.",
    },
  };
}

export function evidenceOverviewLabel(claim: WikiClaimRecord): string {
  const overview = claim.evidenceOverview ?? evidenceOverview(claim);
  const depths = new Set(
    overview.sources
      .filter((s: any) => s.validRoles.length)
      .map((s: any) => s.readDepth),
  );
  const reading =
    depths.size === 1 && depths.has("paper_reviewed")
      ? "来源全文已读"
      : depths.size
        ? "来源阅读深度见详情"
        : "当前无可核验证据";
  return `${overview.supportingSources} 篇来源支持 · ${reading} · ${overview.contradictingSources ? `${overview.contradictingSources} 篇来源反驳` : "未记录有效反驳"}`;
}

/** Stable coverage of claim types and sources, independent of write timestamps. */
export function selectSummaryClaims(claims: any[], limit = 5): any[] {
  const remaining = claims.filter((c) =>
    c.evidence?.some((e: any) => e.linkState === "valid"),
  );
  const selected: any[] = [],
    types = new Set<string>(),
    sources = new Set<string>();
  while (remaining.length && selected.length < limit) {
    const rank = (c: any) => {
      const keys = c.evidence
        .filter((e: any) => e.linkState === "valid")
        .map((e: any) => `${e.libraryID}:${e.itemKey}`);
      return (
        Number(c.confidence ?? 0) +
        (types.has(c.claimType) ? 0 : 0.08) +
        (keys.some((k: string) => !sources.has(k)) ? 0.14 : 0) +
        (["limitation", "conflict"].includes(c.claimType) ? 0.08 : 0)
      );
    };
    remaining.sort((a, b) => rank(b) - rank(a) || a.claimId - b.claimId);
    const claim = remaining.shift()!;
    if (
      selected.some(
        (c) =>
          c.claimText.toLowerCase().trim() ===
          claim.claimText.toLowerCase().trim(),
      )
    )
      continue;
    selected.push(claim);
    types.add(claim.claimType);
    for (const e of claim.evidence.filter((e: any) => e.linkState === "valid"))
      sources.add(`${e.libraryID}:${e.itemKey}`);
  }
  return selected;
}
