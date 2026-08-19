import { normalizeWikiName } from "./wikiCanonicalizer";
import type { WikiReadDepth, WikiEpistemicStatus } from "./wikiTypes";
import type { WikiStore } from "./wikiStore";

const ONE_HOP_DECAY = 0.72;

function column(row: any, snake: string, camel: string): any {
  return row?.[snake] ?? row?.[camel];
}

function terms(value: string): string[] {
  const normalized = normalizeWikiName(value);
  const words = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1);
  const han = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  return Array.from(new Set([...words, ...han]));
}

function lexicalScore(queryTerms: string[], value: string): number {
  const normalized = normalizeWikiName(value);
  if (!normalized || !queryTerms.length) return 0;
  const matched = queryTerms.filter((term) => normalized.includes(term)).length;
  return Math.min(1, matched / queryTerms.length);
}

function floatVector(blob: unknown, dimensions: number): Float32Array | null {
  if (blob instanceof Uint8Array) {
    return new Float32Array(
      blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
      0,
      dimensions,
    );
  }
  if (blob instanceof ArrayBuffer) return new Float32Array(blob, 0, dimensions);
  return null;
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

export interface WikiClaimSearchResult {
  claimId: number;
  pageId: number;
  claimText: string;
  claimType: string;
  normalizedWikiScore: number;
  matchKind: "direct" | "one_hop";
  evidenceConfidence: number;
  readDepth: WikiReadDepth;
  epistemicStatus: WikiEpistemicStatus;
  evidence: any[];
}

export interface WikiDocumentSearchResult {
  itemKey: string;
  libraryID: number;
  normalizedWikiScore: number;
  evidenceConfidence: number;
  readDepth: WikiReadDepth;
  epistemicStatus: WikiEpistemicStatus;
  wikiClaims: WikiClaimSearchResult[];
}

export interface WikiSearchResult {
  claims: WikiClaimSearchResult[];
  documents: WikiDocumentSearchResult[];
  relations: any[];
  directCount: number;
  oneHopCount: number;
}

const DEPTH_ORDER: WikiReadDepth[] = [
  "chunk_local",
  "section_read",
  "paper_reviewed",
  "cross_paper",
];

export class WikiRetriever {
  private readonly store: WikiStore;

  constructor(store: WikiStore) {
    this.store = store;
  }

  async search(options: {
    libraryID: number;
    query: string;
    keywords?: string[];
    queryVector?: Float32Array;
    itemKeys?: string[];
    minScore?: number;
    limit?: number | null;
  }): Promise<WikiSearchResult> {
    const snapshot = await this.store.getRetrievalSnapshot(options.libraryID);
    const queryTerms = terms(
      [options.query, ...(options.keywords ?? [])].join(" "),
    );
    const minScore = Math.max(0, Math.min(1, options.minScore ?? 0));
    const documentLimit =
      options.limit === null
        ? null
        : Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
    const pages = new Map(
      snapshot.pages.map((row) => [
        Number(column(row, "page_id", "pageId")),
        row,
      ]),
    );
    const concepts = new Map(
      snapshot.concepts.map((row) => [
        Number(column(row, "concept_id", "conceptId")),
        row,
      ]),
    );
    const aliases = new Map<number, string[]>();
    for (const row of snapshot.aliases) {
      const id = Number(column(row, "concept_id", "conceptId"));
      const list = aliases.get(id) ?? [];
      list.push(String(row.alias));
      aliases.set(id, list);
    }
    const claimEvidence = new Map<number, any[]>();
    const itemScope =
      options.itemKeys === undefined ? null : new Set(options.itemKeys);
    const scopedClaimIds = itemScope ? new Set<number>() : null;
    for (const row of snapshot.evidence) {
      const id = Number(column(row, "claim_id", "claimId"));
      const list = claimEvidence.get(id) ?? [];
      list.push(row);
      claimEvidence.set(id, list);
      if (
        scopedClaimIds &&
        Number(column(row, "library_id", "libraryID")) ===
          options.libraryID &&
        itemScope!.has(String(column(row, "item_key", "itemKey")))
      ) {
        scopedClaimIds.add(id);
      }
    }
    const embeddings = new Map<number, any>(
      snapshot.embeddings.map((row) => [
        Number(column(row, "claim_id", "claimId")),
        row,
      ]),
    );

    const directConceptScores = new Map<number, number>();
    for (const [conceptId, concept] of concepts) {
      directConceptScores.set(
        conceptId,
        Math.max(
          lexicalScore(
            queryTerms,
            String(column(concept, "canonical_name", "canonicalName")),
          ),
          ...(aliases.get(conceptId) ?? []).map((alias) =>
            lexicalScore(queryTerms, alias),
          ),
        ),
      );
    }
    const directRelationConceptScores = new Map<number, number>();
    const relationHits: any[] = [];
    for (const relation of snapshot.relations) {
      const predicateScore = lexicalScore(
        queryTerms,
        String(column(relation, "predicate", "predicate")),
      );
      if (predicateScore <= 0) continue;
      const source = Number(
        column(relation, "source_concept_id", "sourceConceptId"),
      );
      const target = Number(
        column(relation, "target_concept_id", "targetConceptId"),
      );
      directRelationConceptScores.set(
        source,
        Math.max(directRelationConceptScores.get(source) ?? 0, predicateScore),
      );
      directRelationConceptScores.set(
        target,
        Math.max(directRelationConceptScores.get(target) ?? 0, predicateScore),
      );
      relationHits.push(relation);
    }
    const relatedConceptScores = new Map<number, number>();
    for (const relation of snapshot.relations) {
      const source = Number(
        column(relation, "source_concept_id", "sourceConceptId"),
      );
      const target = Number(
        column(relation, "target_concept_id", "targetConceptId"),
      );
      const sourceScore = Math.max(
        directConceptScores.get(source) ?? 0,
        directRelationConceptScores.get(source) ?? 0,
      );
      const targetScore = Math.max(
        directConceptScores.get(target) ?? 0,
        directRelationConceptScores.get(target) ?? 0,
      );
      if (sourceScore > 0)
        relatedConceptScores.set(
          target,
          Math.max(
            relatedConceptScores.get(target) ?? 0,
            sourceScore * ONE_HOP_DECAY,
          ),
        );
      if (targetScore > 0)
        relatedConceptScores.set(
          source,
          Math.max(
            relatedConceptScores.get(source) ?? 0,
            targetScore * ONE_HOP_DECAY,
          ),
        );
      if (
        (sourceScore > 0 || targetScore > 0) &&
        !relationHits.includes(relation)
      ) {
        relationHits.push(relation);
      }
    }

    const claims: WikiClaimSearchResult[] = [];
    for (const claim of snapshot.claims) {
      const claimId = Number(column(claim, "claim_id", "claimId"));
      if (scopedClaimIds && !scopedClaimIds.has(claimId)) continue;
      const pageId = Number(column(claim, "page_id", "pageId"));
      const page = pages.get(pageId);
      const conceptId =
        Number(column(page, "primary_concept_id", "primaryConceptId")) || 0;
      const concept = concepts.get(conceptId);
      const combinedDirectText = [
        column(claim, "claim_text", "claimText"),
        column(page, "canonical_title", "canonicalTitle"),
        concept ? column(concept, "canonical_name", "canonicalName") : "",
        ...(aliases.get(conceptId) ?? []),
      ].join(" ");
      const direct = Math.max(
        lexicalScore(queryTerms, combinedDirectText),
        lexicalScore(
          queryTerms,
          String(column(claim, "claim_text", "claimText")),
        ),
        lexicalScore(
          queryTerms,
          String(column(page, "canonical_title", "canonicalTitle")),
        ),
        directConceptScores.get(conceptId) ?? 0,
        directRelationConceptScores.get(conceptId) ?? 0,
      );
      const embedding = embeddings.get(claimId);
      let vectorScore = 0;
      if (options.queryVector && embedding) {
        const vector = floatVector(
          column(embedding, "embedding", "embedding"),
          Number(embedding.dimensions),
        );
        if (vector) vectorScore = cosine(options.queryVector, vector);
      }
      const oneHop = relatedConceptScores.get(conceptId) ?? 0;
      const normalizedWikiScore = Math.max(direct, vectorScore, oneHop);
      if (normalizedWikiScore < minScore || normalizedWikiScore <= 0) continue;
      const evidence = claimEvidence.get(claimId) ?? [];
      const readDepth = evidence.reduce<WikiReadDepth>((best, row) => {
        const depth = column(row, "read_depth", "readDepth") as WikiReadDepth;
        return DEPTH_ORDER.indexOf(depth) > DEPTH_ORDER.indexOf(best)
          ? depth
          : best;
      }, "chunk_local");
      claims.push({
        claimId,
        pageId,
        claimText: String(column(claim, "claim_text", "claimText")),
        claimType: String(column(claim, "claim_type", "claimType")),
        normalizedWikiScore,
        matchKind: direct > 0 || vectorScore > 0 ? "direct" : "one_hop",
        evidenceConfidence: Number(claim.confidence),
        readDepth,
        epistemicStatus: column(claim, "epistemic_status", "epistemicStatus"),
        evidence,
      });
    }
    claims.sort(
      (a, b) =>
        b.normalizedWikiScore - a.normalizedWikiScore || a.claimId - b.claimId,
    );
    const documents = new Map<string, WikiDocumentSearchResult>();
    for (const claim of claims) {
      for (const evidence of claim.evidence) {
        if (column(evidence, "link_state", "linkState") !== "valid") continue;
        const itemKey = String(column(evidence, "item_key", "itemKey"));
        const libraryID = Number(column(evidence, "library_id", "libraryID"));
        if (
          libraryID !== options.libraryID ||
          (itemScope && !itemScope.has(itemKey))
        )
          continue;
        const key = `${libraryID}:${itemKey}`;
        const existing = documents.get(key);
        if (!existing) {
          documents.set(key, {
            itemKey,
            libraryID,
            normalizedWikiScore: claim.normalizedWikiScore,
            evidenceConfidence: claim.evidenceConfidence,
            readDepth: claim.readDepth,
            epistemicStatus: claim.epistemicStatus,
            wikiClaims: [claim],
          });
        } else {
          existing.normalizedWikiScore = Math.max(
            existing.normalizedWikiScore,
            claim.normalizedWikiScore,
          );
          existing.evidenceConfidence = Math.max(
            existing.evidenceConfidence,
            claim.evidenceConfidence,
          );
          existing.wikiClaims.push(claim);
        }
      }
    }
    return {
      claims,
      documents: Array.from(documents.values())
        .sort(
          (a, b) =>
            b.normalizedWikiScore - a.normalizedWikiScore ||
            a.itemKey.localeCompare(b.itemKey),
        )
        .slice(0, documentLimit ?? undefined),
      relations: relationHits,
      directCount: claims.filter(
        (claim) => claim.matchKind === "direct",
      ).length,
      oneHopCount: claims.filter(
        (claim) => claim.matchKind === "one_hop",
      ).length,
    };
  }
}
