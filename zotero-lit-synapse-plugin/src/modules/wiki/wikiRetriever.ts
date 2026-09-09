import { hashWikiText, normalizeWikiName } from "./wikiCanonicalizer";
import { tokenizeForIndex } from "../keyword/scientificTokenizer";
import { mapWikiEvidenceRow, mapWikiRelationRow } from "./wikiDto";
import { rowColumn as column } from "./wikiRow";
import type {
  WikiEvidenceRecord,
  WikiReadDepth,
  WikiEpistemicStatus,
  WikiRelationRecord,
} from "./wikiTypes";
import type { WikiStore } from "./wikiStore";
import { cosine, floatVector } from "./wikiVector";
import type { EmbeddingIdentity } from "../semantic/embeddingService";
import { compatibleEmbeddingIdentity, parseEmbeddingIdentity } from "../semantic/embeddingIdentity";

const ONE_HOP_DECAY = 0.72;

function terms(value: string): string[] {
  return Array.from(
    new Set(tokenizeForIndex(value).map((occurrence) => occurrence.term)),
  );
}

function lexicalScore(queryTerms: string[], value: string): number {
  const normalized = normalizeWikiName(value);
  if (!normalized || !queryTerms.length) return 0;
  const valueTerms = new Set(terms(value));
  const matched = queryTerms.filter(
    (term) => valueTerms.has(term) || normalized.includes(term),
  ).length;
  return Math.min(1, matched / queryTerms.length);
}


export interface WikiClaimSearchResult {
  evidenceOverview?: any;
  scoreKind?: string;
  claimId: number;
  pageId: number;
  claimText: string;
  claimType: string;
  normalizedWikiScore: number;
  matchKind: "direct" | "one_hop";
  evidenceConfidence: number;
  readDepth: WikiReadDepth | null;
  epistemicStatus: WikiEpistemicStatus;
  /** Plain DTOs. Never the `Zotero.DB.queryAsync` rows they were read from. */
  evidence: WikiEvidenceRecord[];
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
  warnings?: string[];
  claims: WikiClaimSearchResult[];
  documents: WikiDocumentSearchResult[];
  /** Plain DTOs, for the same reason as {@link WikiClaimSearchResult.evidence}. */
  relations: WikiRelationRecord[];
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
    queryVectorModel?: string;
    queryVectorIdentity?: EmbeddingIdentity;
    itemKeys?: string[];
    minScore?: number;
    limit?: number | null;
    signal?: AbortSignal;
  }): Promise<WikiSearchResult> {
    const snapshot = await this.store.getRetrievalSnapshot(options.libraryID, {
      itemKeys: options.itemKeys, includeEmbeddings: Boolean(options.queryVector),
    });
    const checkCancelled = () => { if (options.signal?.aborted) throw new Error("Wiki search cancelled"); };
    checkCancelled();
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
    // Evidence and Relations are the two row kinds this result carries out of
    // the module, so both are mapped to DTOs HERE, at the boundary, and it is
    // the DTOs that every step below reads and returns. A Zotero row that
    // reached an MCP response would kill the tool call at `JSON.stringify`
    // time: the stringifier probes `toJSON`, the row's `get` trap forwards
    // that to `getResultByName`, and the miss surfaces as
    // `DB column 'toJSON' not found`. See ./wikiDto.
    const claimEvidence = new Map<number, WikiEvidenceRecord[]>();
    const itemScope =
      options.itemKeys === undefined ? null : new Set(options.itemKeys);
    const scopedClaimIds = itemScope ? new Set<number>() : null;
    for (const raw of snapshot.evidence) {
      const row = mapWikiEvidenceRow(raw);
      const id = Number(column(row, "claim_id", "claimId"));
      const list = claimEvidence.get(id) ?? [];
      list.push(row);
      claimEvidence.set(id, list);
      if (
        scopedClaimIds &&
        Number(column(row, "library_id", "libraryID")) === options.libraryID &&
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
    const relationRecords = snapshot.relations.map(mapWikiRelationRow);
    const directRelationConceptScores = new Map<number, number>();
    const relationHits: WikiRelationRecord[] = [];
    for (const relation of relationRecords) {
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
    for (const relation of relationRecords) {
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
    let incompatibleVectors = 0;
    const matchedConceptIds = new Set<number>();
    let scanned = 0;
    for (const claim of snapshot.claims) {
      if (++scanned % 128 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      checkCancelled();
      const claimId = Number(column(claim, "claim_id", "claimId"));
      if (column(claim, "epistemic_status", "epistemicStatus") === "unsupported" && !claimEvidence.get(claimId)?.length) continue;
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
      const compatible = compatibleEmbeddingIdentity(
        options.queryVectorIdentity,
        parseEmbeddingIdentity(column(embedding, "embedding_identity", "embeddingIdentity")),
      );
      if (options.queryVector && embedding && !compatible) incompatibleVectors++;
      if (
        options.queryVector &&
        compatible &&
        options.queryVectorModel &&
        embedding &&
        String(column(embedding, "model", "model")) ===
          options.queryVectorModel &&
        Number(column(embedding, "dimensions", "dimensions")) ===
          options.queryVector.length &&
        String(column(embedding, "text_hash", "textHash")) ===
          (await hashWikiText(String(column(claim, "claim_text", "claimText"))))
      ) {
        const vector = floatVector(
          column(embedding, "embedding", "embedding"),
          Number(column(embedding, "dimensions", "dimensions")),
        );
        if (vector) vectorScore = cosine(options.queryVector, vector);
      }
      const oneHop = relatedConceptScores.get(conceptId) ?? 0;
      const normalizedWikiScore = Math.max(direct, vectorScore, oneHop);
      if (normalizedWikiScore < minScore || normalizedWikiScore <= 0) continue;
      const evidence = (claimEvidence.get(claimId) ?? []).filter(
        (row) =>
          !itemScope ||
          (Number(column(row, "library_id", "libraryID")) ===
            options.libraryID &&
            itemScope.has(String(column(row, "item_key", "itemKey")))),
      );
      const verifiedEvidence = evidence.filter((row) => {
        const state = String(column(row, "link_state", "linkState"));
        return state === "valid" || state === "source_deleted";
      });
      const readDepth = verifiedEvidence.length
        ? verifiedEvidence.reduce<WikiReadDepth>((best, row) => {
            const depth = column(
              row,
              "read_depth",
              "readDepth",
            ) as WikiReadDepth;
            return DEPTH_ORDER.indexOf(depth) > DEPTH_ORDER.indexOf(best)
              ? depth
              : best;
          }, "chunk_local")
        : null;
      matchedConceptIds.add(conceptId);
      claims.push({
        claimId,
        pageId,
        claimText: String(column(claim, "claim_text", "claimText")),
        claimType: String(column(claim, "claim_type", "claimType")),
        normalizedWikiScore,
        matchKind: direct > 0 || vectorScore > 0 ? "direct" : "one_hop",
        evidenceConfidence: Number(claim.confidence),
        scoreKind: "heuristic",
        evidenceOverview: (await this.store.getClaim(claimId))?.evidenceOverview,
        readDepth,
        epistemicStatus: column(claim, "epistemic_status", "epistemicStatus"),
        evidence,
      });
    }
    claims.sort(
      (a, b) =>
        b.normalizedWikiScore - a.normalizedWikiScore || a.claimId - b.claimId,
    );
    const groups = new Map<string, { itemKey: string; libraryID: number; claims: Map<number, WikiClaimSearchResult> }>();
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
        let group = groups.get(key);
        if (!group) {
          group = { itemKey, libraryID, claims: new Map() };
          groups.set(key, group);
        }
        let localClaim = group.claims.get(claim.claimId);
        if (!localClaim) {
          localClaim = { ...claim, evidence: [], readDepth: null };
          group.claims.set(claim.claimId, localClaim);
        }
        localClaim.evidence.push(evidence);
      }
    }
    // Evidence depth was verified on write; relinking a changed source resets it.
    // Only this document's valid evidence can raise its current reading depth.
    const documents: WikiDocumentSearchResult[] = Array.from(groups.values(), (group) => {
      const wikiClaims = Array.from(group.claims.values());
      let readDepth: WikiReadDepth = "chunk_local";
      for (const claim of wikiClaims) {
        claim.readDepth = claim.evidence.reduce<WikiReadDepth>((depth, evidence) =>
          DEPTH_ORDER.indexOf(evidence.readDepth) > DEPTH_ORDER.indexOf(depth) ? evidence.readDepth : depth,
        "chunk_local");
        if (DEPTH_ORDER.indexOf(claim.readDepth) > DEPTH_ORDER.indexOf(readDepth)) readDepth = claim.readDepth;
      }
      return {
        itemKey: group.itemKey, libraryID: group.libraryID, wikiClaims, readDepth,
        normalizedWikiScore: Math.max(...wikiClaims.map((claim) => claim.normalizedWikiScore)),
        evidenceConfidence: Math.max(...wikiClaims.map((claim) => claim.evidenceConfidence)),
        epistemicStatus: wikiClaims[0].epistemicStatus,
      };
    });
    return {
      ...(incompatibleVectors ? { warnings: [`${incompatibleVectors} Wiki vectors have an unknown or incompatible generating identity and were excluded. Rebuild the queued Wiki embeddings; keyword retrieval remains available.`] } : {}),
      claims,
      documents: documents
        .sort(
          (a, b) =>
            b.normalizedWikiScore - a.normalizedWikiScore ||
            a.itemKey.localeCompare(b.itemKey),
        )
        .slice(0, documentLimit ?? undefined),
      relations: itemScope
        ? relationHits.filter((relation) => {
            const source = Number(
              column(relation, "source_concept_id", "sourceConceptId"),
            );
            const target = Number(
              column(relation, "target_concept_id", "targetConceptId"),
            );
            return (
              matchedConceptIds.has(source) || matchedConceptIds.has(target)
            );
          })
        : relationHits,
      directCount: claims.filter((claim) => claim.matchKind === "direct")
        .length,
      oneHopCount: claims.filter((claim) => claim.matchKind === "one_hop")
        .length,
    };
  }
}
