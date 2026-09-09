const id = {
  anyOf: [
    { type: "integer", minimum: 1 },
    { type: "string", minLength: 1 },
  ],
};
const binding = {
  type: "object",
  properties: {
    claimId: id,
    evidenceId: { type: "integer", minimum: 1 },
    itemKey: { type: "string" },
    excerpt: { type: "string" },
  },
  required: ["claimId"],
  anyOf: [{ required: ["evidenceId"] }, { required: ["itemKey", "excerpt"] }],
};

function withOutcomeVariants(schema: any): any {
  const outcomes = schema.properties.outcome.enum as string[];
  const common = schema.required;
  return {
    ...schema,
    oneOf: outcomes.map((outcome) => {
      const knowledge = !["noise", "deferred", "no_relation"].includes(outcome);
      const relation = [
        "extends_method",
        "qualifies_scope",
        "compares_with",
      ].includes(outcome);
      const result = [
        "shared_claim",
        "conflict",
        "same_page",
        "concept_relation",
      ].includes(outcome);
      const resultFields =
        outcome === "concept_relation"
          ? ["relationId"]
          : outcome === "same_page"
            ? ["pageId", "claimIds"]
            : ["claimIds"];
      return {
        type: "object",
        properties: {
          outcome: { const: outcome },
          ...(knowledge || outcome === "no_relation"
            ? {
                targetClaimIds: {
                  minItems: 1,
                },
                evidenceBindings: {
                  minItems: knowledge ? 2 : 1,
                },
              }
            : {}),
          ...(result
            ? {
                resultRefs: {
                  required: resultFields,
                  properties: {
                    ...(outcome !== "concept_relation"
                      ? {
                          claimIds: {
                            minItems: outcome === "same_page" ? 2 : 1,
                            maxItems: outcome === "same_page" ? 2 : 1,
                            uniqueItems: true,
                          },
                        }
                      : {}),
                  },
                },
              }
            : {}),
        },
        required: [
          ...common,
          ...(relation ? ["relation"] : []),
          ...(result ? ["resultRefs"] : []),
          ...(outcome === "deferred" ? ["gap", "trigger"] : []),
          ...(outcome === "concept_relation" ? ["conceptSourceIds"] : []),
        ],
      };
    }),
  };
}
export const crossPaperReviewSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      taskId: { type: "integer", minimum: 1 },
      expectedRevision: { type: "string" },
      reviewedTargets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claimId: { type: "integer", minimum: 1 },
            version: { type: "integer", minimum: 1 },
            disposition: {
              type: "string",
              enum: ["reviewed", "excluded", "deferred"],
            },
            basis: { type: "string", minLength: 1 },
          },
          required: ["claimId", "version", "disposition", "basis"],
        },
      },
      outcomes: {
        type: "array",
        minItems: 1,
        items: withOutcomeVariants({
          type: "object",
          properties: {
            outcome: {
              type: "string",
              enum: [
                "shared_claim",
                "conflict",
                "same_page",
                "concept_relation",
                "extends_method",
                "qualifies_scope",
                "compares_with",
                "no_relation",
                "noise",
                "deferred",
              ],
            },
            targetClaimIds: {
              type: "array",
              items: { type: "integer", minimum: 1 },
            },
            basis: { type: "string", minLength: 1 },
            evidenceBindings: { type: "array", items: binding },
            conceptSourceIds: {
              type: "array",
              items: { type: "integer", minimum: 1 },
              description:
                "For concept_relation, explicitly bind the term-source records on both concept endpoints.",
            },
            resultRefs: {
              type: "object",
              properties: {
                claimIds: { type: "array", items: id },
                pageId: id,
                relationId: id,
              },
            },
            relation: {
              type: "object",
              properties: {
                sourceClaimId: id,
                targetClaimId: id,
                dimension: { type: "string" },
                conditions: { type: "string" },
                statement: { type: "string" },
              },
              required: [
                "sourceClaimId",
                "targetClaimId",
                "dimension",
                "conditions",
                "statement",
              ],
            },
            gap: { type: "string", minLength: 1 },
            trigger: {
              type: "string",
              enum: [
                "target_knowledge_changed",
                "source_restored",
                "new_evidence",
              ],
            },
          },
          required: ["outcome", "targetClaimIds", "basis", "evidenceBindings"],
        }),
      },
    },
    required: ["taskId", "expectedRevision", "reviewedTargets", "outcomes"],
  },
  description:
    "Review selected old Wiki Claims before settling candidates. Account for every target with review, explicit exclusion, or deferral. Evidence bindings use an existing evidenceId or an exact itemKey/excerpt on a Claim ref created in this commit. New Claim relations are saved atomically from relation. Preserve attribution; use compares_with for observed differences, extends_method only for directly evidenced extension. Never infer inheritance from publication order.",
};
export const evidenceAssessmentSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      claimId: id,
      expectedVersion: { type: "integer", minimum: 1 },
      supportCompleteness: {
        type: "string",
        enum: ["complete", "partial", "overstated", "unverified"],
      },
      conditionCompleteness: {
        type: "string",
        enum: ["explicit", "incomplete", "not_applicable", "unverified"],
      },
      basisTypes: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "simulation",
            "experiment",
            "theory",
            "assumption",
            "secondary_citation",
          ],
        },
      },
      independence: {
        type: "string",
        enum: ["verified_independent", "same_study", "unknown"],
      },
      studyGroups: {
        type: "array",
        items: {
          type: "object",
          properties: {
            itemKeys: { type: "array", items: { type: "string" } },
            basis: { type: "string" },
          },
          required: ["itemKeys", "basis"],
        },
      },
      basis: { type: "string" },
      evidenceBindings: { type: "array", items: binding },
    },
    required: [
      "claimId",
      "expectedVersion",
      "supportCompleteness",
      "conditionCompleteness",
      "basisTypes",
      "independence",
      "basis",
      "evidenceBindings",
    ],
  },
};
