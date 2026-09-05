/**
 * Turning a database row into a plain object before it can leave the module.
 *
 * `Zotero.DB.queryAsync` hands back Proxies, not objects (see ./wikiRow for
 * what their traps do). Passing one into an MCP response is not merely untidy,
 * it is fatal: `JSON.stringify` probes `value.toJSON` before serialising, the
 * `get` trap forwards that probe to `mozIStorageRow.getResultByName`, and the
 * miss comes back as `DB column 'toJSON' not found`. The whole tool call fails
 * with an error that names a column nobody ever selected.
 *
 * `scrubPathFields`, which runs on the way out just before serialisation,
 * enumerates the same rows and trips over the same trap.
 *
 * The rule this module exists to enforce: a row read out of SQLite is mapped
 * to a DTO at the boundary of whatever is going to return it, and it is the
 * DTO - never the row - that travels onward. Filtering `toJSON` out of the
 * response would only paper over one probe of many; a plain object has no trap
 * to fire in the first place.
 *
 * Every mapper here reads through `rowColumn`, so it accepts both shapes the
 * Wiki module sees: a real Zotero result set (snake_case) and the plain-object
 * test doubles (either casing).
 */

import { rowColumn } from "./wikiRow";
import type {
  WikiAliasRecord,
  WikiConceptRecord,
  WikiEvidenceRecord,
  WikiRelationRecord,
} from "./wikiTypes";

/** `wiki_evidence` -> DTO. The row that reaches MCP most often, via Claims. */
export function mapWikiEvidenceRow(row: any): WikiEvidenceRecord {
  return {
    evidenceId: Number(rowColumn(row, "evidence_id", "evidenceId")),
    claimId: Number(rowColumn(row, "claim_id", "claimId")),
    libraryID: Number(rowColumn(row, "library_id", "libraryID")),
    itemKey: String(rowColumn(row, "item_key", "itemKey")),
    chunkIdSnapshot: Number(
      rowColumn(row, "chunk_id_snapshot", "chunkIdSnapshot"),
    ),
    chunkTextHash: String(rowColumn(row, "chunk_text_hash", "chunkTextHash")),
    sourceContentHash: String(
      rowColumn(row, "source_content_hash", "sourceContentHash"),
    ),
    sourceChunkSignature: String(
      rowColumn(row, "source_chunk_signature", "sourceChunkSignature"),
    ),
    sourceResetGeneration: String(
      rowColumn(row, "source_reset_generation", "sourceResetGeneration"),
    ),
    excerptHash: String(rowColumn(row, "excerpt_hash", "excerptHash")),
    excerpt: String(row.excerpt),
    evidenceRole: rowColumn(row, "evidence_role", "evidenceRole"),
    readDepth: rowColumn(row, "read_depth", "readDepth"),
    linkState: rowColumn(row, "link_state", "linkState"),
    createdAt: Number(rowColumn(row, "created_at", "createdAt")),
    // A column that exists and holds NULL, not an absent one - keep it null.
    lastVerifiedAt:
      rowColumn(row, "last_verified_at", "lastVerifiedAt") == null
        ? null
        : Number(rowColumn(row, "last_verified_at", "lastVerifiedAt")),
  };
}

/** `wiki_concepts` -> DTO. */
export function mapWikiConceptRow(row: any): WikiConceptRecord {
  return {
    conceptId: Number(rowColumn(row, "concept_id", "conceptId")),
    libraryID: Number(rowColumn(row, "library_id", "libraryID")),
    canonicalName: String(rowColumn(row, "canonical_name", "canonicalName")),
    normalizedName: String(rowColumn(row, "normalized_name", "normalizedName")),
    conceptType: String(rowColumn(row, "concept_type", "conceptType")),
    description: String(rowColumn(row, "description", "description") ?? ""),
  };
}

/** `wiki_aliases` -> DTO. */
export function mapWikiAliasRow(row: any): WikiAliasRecord {
  return {
    aliasId: Number(rowColumn(row, "alias_id", "aliasId")),
    conceptId: Number(rowColumn(row, "concept_id", "conceptId")),
    alias: String(rowColumn(row, "alias", "alias")),
    normalizedAlias: String(
      rowColumn(row, "normalized_alias", "normalizedAlias"),
    ),
    language: String(rowColumn(row, "language", "language")),
    source: String(rowColumn(row, "source", "source")),
    confidence: Number(rowColumn(row, "confidence", "confidence")),
  };
}

/** `wiki_relations` -> DTO. */
export function mapWikiRelationRow(row: any): WikiRelationRecord {
  return {
    relationId: Number(rowColumn(row, "relation_id", "relationId")),
    sourceConceptId: Number(
      rowColumn(row, "source_concept_id", "sourceConceptId"),
    ),
    predicate: String(rowColumn(row, "predicate", "predicate")),
    normalizedPredicate: String(
      rowColumn(row, "normalized_predicate", "normalizedPredicate"),
    ),
    targetConceptId: Number(
      rowColumn(row, "target_concept_id", "targetConceptId"),
    ),
    confidence: Number(rowColumn(row, "confidence", "confidence")),
    createdAt: Number(rowColumn(row, "created_at", "createdAt")),
  };
}
