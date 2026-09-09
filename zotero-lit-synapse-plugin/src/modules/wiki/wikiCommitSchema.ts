export const wikiKnowledgeRefSchema = {
  anyOf: [
    { type: "integer", minimum: 1 },
    { type: "string", minLength: 1 },
  ],
  description: "Existing ID or earlier action ref in this commit.",
};

/** Keep shared field metadata for older clients and expose a complete discriminated union. */
export function withWikiActionVariants(schema: any): any {
  const required: Record<string, string[]> = {
    SKIP: [],
    CREATE_PAGE: ["canonicalTitle"],
    ADD_CLAIM: [
      "pageId",
      "claimText",
      "claimType",
      "epistemicStatus",
      "coverageLevel",
      "evidence",
    ],
    ATTACH_EVIDENCE: ["claimId", "evidence"],
    UPDATE_CLAIM: ["claimId", "expectedVersion"],
    MARK_CONFLICT: ["claimId", "evidence"],
    LINK_RELATION: [
      "sourceConceptId",
      "targetConceptId",
      "predicate",
      "confidence",
    ],
    RESOLVE_LINK_SIGNAL: ["signalId", "resolutionType", "reason"],
    DISMISS_LINK_SIGNALS: [],
  };
  return {
    ...schema,
    oneOf: Object.keys(required).map((action) => ({
      type: "object",
      properties: {
        action: { const: action },
        ...(["ADD_CLAIM", "ATTACH_EVIDENCE", "MARK_CONFLICT"].includes(action)
          ? { evidence: { minItems: 1 } }
          : {}),
      },
      required: ["action", ...required[action]],
      ...(action === "SKIP"
        ? {
            description:
              "To settle reading, supply itemKey, chunkIds and a specific reason. A legacy SKIP without chunk addresses writes off no reading.",
            anyOf: [
              {
                not: {
                  anyOf: [
                    { required: ["itemKey"] },
                    { required: ["chunkIds"] },
                  ],
                },
              },
              {
                required: ["itemKey", "chunkIds", "reason"],
                properties: {
                  chunkIds: { minItems: 1 },
                  reason: { minLength: 40 },
                },
              },
            ],
          }
        : {}),
      ...(action === "DISMISS_LINK_SIGNALS"
        ? {
            anyOf: [
              { required: ["dismissals"] },
              {
                required: ["signalIds", "reason"],
                properties: {
                  signalIds: { minItems: 1, maxItems: 1 },
                  reason: { minLength: 40 },
                },
              },
            ],
          }
        : {}),
      ...(action === "RESOLVE_LINK_SIGNAL"
        ? {
            oneOf: [
              ["shared_claim", ["claimId"]],
              ["conflict", ["claimId"]],
              ["same_page", ["pageId", "claimIds"]],
              ["concept_relation", ["relationId"]],
              ["no_action", []],
            ].map(([resolutionType, names]) => ({
              properties: { resolutionType: { const: resolutionType } },
              required: ["resolutionType", ...(names as string[])],
            })),
          }
        : {}),
    })),
  };
}

export const deferMissingTargetsSchema = {
  type: "array",
  description:
    "Explicitly select tasks with no target Wiki Claims to defer in this commit. Each task is checked against its revision and current knowledge. This records a knowledge gap, never no_relation; new target knowledge reopens review.",
  items: {
    type: "object",
    properties: {
      taskId: { type: "integer", minimum: 1 },
      expectedRevision: { type: "string", minLength: 1 },
    },
    required: ["taskId", "expectedRevision"],
  },
};

export const WIKI_COMMIT_EXAMPLE = {
  operationId: "example_comparison_001",
  actions: [
    {
      action: "ADD_CLAIM",
      ref: "newFinding",
      pageId: 1,
      claimText: "The calibrated sensor achieved 2 ms latency at 25 C.",
      claimType: "comparison",
      epistemicStatus: "supported",
      coverageLevel: "section_read",
      evidence: [
        {
          itemKey: "NEWPAPER",
          chunkIdSnapshot: 4,
          excerpt: "The calibrated sensor achieved 2 ms latency at 25 C.",
          evidenceRole: "SUPPORTS",
          readDepth: "section_read",
        },
      ],
    },
    {
      action: "SKIP",
      itemKey: "NEWPAPER",
      chunkIds: [5],
      reason:
        "This passage repeats the calibration setup already represented on Page 1 and establishes no additional result.",
    },
  ],
  crossPaperReview: [
    {
      taskId: 1,
      expectedRevision: "replace-with-current-task-revision",
      reviewedTargets: [
        {
          claimId: 10,
          version: 1,
          disposition: "reviewed",
          basis:
            "Compared the reported latency under the stated calibration conditions.",
        },
      ],
      outcomes: [
        {
          outcome: "compares_with",
          targetClaimIds: [10],
          basis:
            "Both studies report latency; the comparison retains their separate conditions.",
          evidenceBindings: [
            { claimId: 10, evidenceId: 20 },
            {
              claimId: "newFinding",
              itemKey: "NEWPAPER",
              excerpt: "The calibrated sensor achieved 2 ms latency at 25 C.",
            },
          ],
          relation: {
            sourceClaimId: "newFinding",
            targetClaimId: 10,
            dimension: "latency",
            conditions:
              "Each result retains its own calibration and temperature conditions.",
            statement:
              "The studies provide separate latency observations; these alone do not establish superiority or inheritance.",
          },
        },
      ],
    },
  ],
};
