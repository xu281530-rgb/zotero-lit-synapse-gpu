export const WIKI_CONTEXT_SECTIONS = [
  "pages",
  "claims",
  "evidence",
  "readingRecords",
  "linkSignals",
  "concepts",
  "relations",
  "crossPaperTasks",
  "claimRelations",
  "preparation",
  "reviewTasks",
  "pendingWikiWriteUp",
] as const;
export type WikiContextSection = (typeof WIKI_CONTEXT_SECTIONS)[number];
export type WikiPreparedContext = Record<WikiContextSection, any[]>;
export const WIKI_PREPARE_IDLE_SECONDS = 600;
export const WIKI_COMPACT_MAX_CHARS = 20000;

export class WikiPreparedContextExpired extends Error {
  readonly code = "PREPARED_CONTEXT_EXPIRED";
  readonly retryable = false;
  readonly details = {
    recovery: {
      tool: "wiki_prepare_update",
      preview: true,
      savedReviewsTool: "wiki_get_link_review",
      message:
        "Prepare a new context after inactivity or restart. Saved cross-paper tasks and reviews remain available by taskId and revision.",
    },
  };
  constructor() {
    super(
      "Prepared context is unavailable or expired. Call wiki_prepare_update again.",
    );
    this.name = "WikiPreparedContextExpired";
  }
}

export function compactPreparedResponse(
  response: any,
  context: any,
  reviewTasks: any,
  crossPaperCandidates: any[],
  signals: any[],
): any {
  const text = (value: unknown, max = 160) => String(value ?? "").slice(0, max);
  const page = (p: any) => ({
    pageId: p.pageId,
    canonicalTitle: text(p.canonicalTitle),
    claimCount: p.claims?.length ?? p.claimCount,
  });
  const concept = (c: any) => ({
    conceptId: c.conceptId,
    canonicalName: text(c.canonicalName ?? c.name),
    name: text(c.name ?? c.canonicalName),
    type: c.type ?? c.conceptType,
    description: text(c.description, 120),
    score: c.score,
    sourceDocuments:
      typeof c.sourceDocuments === "number"
        ? c.sourceDocuments
        : c.sourceDocuments?.length,
    sourcedFromThisPaper: c.sourcedFromThisPaper,
    contextSection: "concepts",
  });
  const claim = (c: any) => ({
    claimId: c.claimId,
    pageId: c.pageId,
    version: c.version,
    claimText: text(c.claimText, 240),
    textTruncated: String(c.claimText ?? "").length > 240,
    evidenceCount: c.evidenceCount ?? c.evidence?.length ?? 0,
    epistemicStatus: c.epistemicStatus,
    coverageLevel: c.coverageLevel,
    sourceItemKey: c.sourceItemKey,
    contextSection: "claims",
  });
  const skeleton = response.wikiSkeleton;
  for (let limit = 10; limit >= 0; limit--) {
    const take = (rows: any[] = []) => rows.slice(0, limit);
    const tasks = response.crossPaperTasks ?? [];
    const recalledPages = take(response.pages).map(page);
    const result = {
      prepareToken: response.prepareToken,
      prepareTokenExpiresInSeconds: WIKI_PREPARE_IDLE_SECONDS,
      compact: true,
      responseVersion: 2,
      preview: response.preview === true,
      context,
      indexTruncated: limit < 10,
      fieldAliases: { pages: "recalledPages" },
      recalledPages,
      pages: recalledPages,
      counts: {
        recalledPages: response.pages?.length ?? 0,
        claims: response.claims?.length ?? 0,
        semanticClaims: response.semanticClaims?.length ?? 0,
        concepts: response.concepts?.length ?? 0,
        crossPaperCandidates: crossPaperCandidates.length,
        crossPaperTasks: tasks.length,
        pendingLinkSignals: signals.length,
        pendingWikiWriteUp: response.pendingWikiWriteUp?.length ?? 0,
      },
      reviewTasks: {
        sourceClaimIds: reviewTasks.sourceClaimIds.slice(0, limit * 2),
        sourceClaimCount: reviewTasks.sourceClaimIds.length,
        crossPaperTaskIds: reviewTasks.crossPaperTaskIds.slice(0, limit * 2),
        crossPaperTaskCount: reviewTasks.crossPaperTaskIds.length,
        mandatorySignalIds: reviewTasks.mandatorySignalIds.slice(0, limit * 2),
        mandatorySignalCount: reviewTasks.mandatorySignalIds.length,
        contextSection: "reviewTasks",
        note: reviewTasks.note,
      },
      claims: take(response.claims).map(claim),
      semanticClaims: take(response.semanticClaims).map(claim),
      concepts: take(response.concepts).map(concept),
      preparedPageTitles: take(response.preparedPageTitles).map((title) =>
        text(title),
      ),
      pagePreparations: take(response.pagePreparations).map((p) => ({
        canonicalTitle: text(p.canonicalTitle),
        pageIds: take(p.pages).map((p) => p.pageId),
        claimIds: take(p.claims).map((c) => c.claimId),
        contextSection: "preparation",
      })),
      semanticWarnings: take(response.semanticWarnings).map((w) =>
        text(w, 300),
      ),
      readingSession: response.readingSession,
      wikiSkeleton: !skeleton
        ? undefined
        : skeleton.unchanged
          ? { unchanged: true, revision: skeleton.revision }
          : {
              revision: skeleton.revision,
              pages: take(skeleton.pages).map(page),
              pagesTruncated: (skeleton.pages?.length ?? 0) > limit,
              pageCount: skeleton.pages?.length ?? 0,
              pagesToExtend: take(skeleton.pagesToExtend).map(page),
              conceptCount: skeleton.conceptCount,
              paperConcepts: take(skeleton.paperConcepts).map((c) => text(c)),
              duplicateCandidates: take(skeleton.duplicateCandidates).map(
                concept,
              ),
              nearbyConcepts: take(skeleton.nearbyConcepts).map(concept),
              hubConcepts: take(skeleton.hubConcepts).map(concept),
              warnings: take(skeleton.warnings).map((w) => text(w, 300)),
              contextSection: "preparation",
            },
      wikiReconciliation: response.wikiReconciliation
        ? {
            itemKey: response.wikiReconciliation.itemKey,
            requiredClaimActions: take(
              response.wikiReconciliation.requiredClaimActions,
            ).map((a) => ({ action: a.action, claimId: a.claimId })),
            requiredClaimActionCount:
              response.wikiReconciliation.requiredClaimActions?.length ?? 0,
            readingRecordCount:
              response.wikiReconciliation.readingRecords?.length ?? 0,
            claimCount: response.wikiReconciliation.claims?.length ?? 0,
            claims: take(response.wikiReconciliation.claims).map(claim),
            contextSection: "preparation",
          }
        : undefined,
      crossPaperCandidates: take(crossPaperCandidates).map(claim),
      crossPaperCandidateCount: crossPaperCandidates.length,
      crossPaperTasks: take(tasks).map((t) => ({
        taskId: t.taskId,
        relatedItemKey: t.relatedItemKey,
        revision: t.revision,
        state: t.state,
        required: t.required,
        targetCount: t.targetCount,
        missingTargets: t.targetCount === 0,
        readWith: {
          tool: "wiki_get_link_review",
          taskId: t.taskId,
          section: "targets",
          expectedRevision: t.revision,
        },
      })),
      pendingLinkSignalCount: signals.length,
      pendingLinkSignals: take(signals).map((s) => ({
        signalId: s.signalId,
        signalIds: [s.signalId],
        linkId: s.linkId,
        otherItemKey: s.otherItemKey,
        signalType: s.signalType,
        mustResolve: s.mustResolve,
        contextSection: "linkSignals",
      })),
      pendingLinkNote:
        "Review required cross-paper tasks first. Their reviews cover mapped signals; decide uncovered mandatory signals separately. Read complete passages in context before deciding.",
      pendingWikiWriteUp: take(response.pendingWikiWriteUp).map((p) => ({
        itemKey: p.itemKey,
        mode: p.mode,
        pendingChunks: p.pendingChunks,
        pendingChunkIds: (p.pendingChunkIds ?? []).slice(0, limit * 2),
        ...((p.pendingChunkIds?.length ?? 0) > limit * 2
          ? {
              contextSection: "pendingWikiWriteUp",
              pendingChunkIdsTruncated: true,
            }
          : {}),
      })),
    };
    if (JSON.stringify(result).length <= WIKI_COMPACT_MAX_CHARS) return result;
  }
  throw new Error("Prepared context index exceeds its response budget.");
}

export function compactWikiClaim(claim: any): any {
  return {
    claimId: claim.claimId,
    pageId: claim.pageId,
    claimText: claim.claimText,
    version: claim.version,
    epistemicStatus: claim.epistemicStatus,
    coverageLevel: claim.coverageLevel,
    score: claim.score,
    sourceItemKeys: [
      ...new Set((claim.evidence ?? []).map((entry: any) => entry.itemKey)),
    ],
    evidenceCount: claim.evidence?.length ?? 0,
    evidenceOverview: claim.evidenceOverview,
    claimRelations: claim.claimRelations,
  };
}

/** Large records remain recoverable as ordered fragments, without an oversized page. */
export function fragmentContextText(entries: any[], field: string): any[] {
  return entries.flatMap((entry) => {
    const value = String(entry[field] ?? "");
    if (value.length <= 6000) return [entry];
    const parts = [];
    for (let offset = 0; offset < value.length; offset += 6000) {
      parts.push({
        ...entry,
        [field]: value.slice(offset, offset + 6000),
        textFragment: {
          field,
          offset,
          totalChars: value.length,
          hasMore: offset + 6000 < value.length,
        },
      });
    }
    return parts;
  });
}

/** Preserve even large nested entries as reconstructable JSON fragments. */
export function boundPreparedContext(
  context: WikiPreparedContext,
): WikiPreparedContext {
  return Object.fromEntries(
    Object.entries(context).map(([section, entries]) => [
      section,
      entries.flatMap((entry, entryIndex) => {
        const json = JSON.stringify(entry);
        if (json.length <= 12000) return [entry];
        const fragments = [];
        for (let offset = 0; offset < json.length; offset += 6000) {
          fragments.push({
            taskId: entry.taskId,
            revision: entry.revision,
            signalId: entry.signalId,
            claimId: entry.claimId,
            contextFragment: {
              entryIndex,
              format: "json",
              offset,
              totalChars: json.length,
              hasMore: offset + 6000 < json.length,
            },
            text: json.slice(offset, offset + 6000),
          });
        }
        return fragments;
      }),
    ]),
  ) as WikiPreparedContext;
}

export function pagePreparedContext(
  context: WikiPreparedContext,
  section: string,
  offset = 0,
  limit = 10,
): any {
  if (!WIKI_CONTEXT_SECTIONS.includes(section as WikiContextSection))
    throw new Error(`Unknown prepared context section: ${section}`);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("offset must be a nonnegative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new Error("limit must be an integer from 1 to 50");
  const rows = context[section as WikiContextSection];
  const items = [];
  let chars = 0;
  for (const row of rows.slice(offset, offset + limit)) {
    const size = JSON.stringify(row).length;
    if (items.length && chars + size > 20000) break;
    items.push(row);
    chars += size;
  }
  const end = offset + items.length;
  return {
    section,
    items,
    pagination: {
      offset,
      returned: items.length,
      total: rows.length,
      requestedLimit: limit,
      unit: "context_entry",
      characterBudgetLimited:
        items.length < Math.min(limit, Math.max(0, rows.length - offset)),
      hasMore: end < rows.length,
      nextOffset: end < rows.length ? end : null,
    },
  };
}
