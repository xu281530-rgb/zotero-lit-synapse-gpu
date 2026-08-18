import type { WikiDatabase } from "./wikiTypes";

export const WIKI_SCHEMA_VERSION = 1;

export async function ensureWikiSchema(db: WikiDatabase): Promise<void> {
  await db.queryAsync("PRAGMA foreign_keys = ON");
  await db.queryAsync(`
    CREATE TABLE IF NOT EXISTS wiki_concepts (
      concept_id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      concept_type TEXT NOT NULL DEFAULT 'concept',
      description TEXT NOT NULL DEFAULT '',
      UNIQUE(library_id, normalized_name)
    )
  `);
  await db.queryAsync(`
    CREATE TABLE IF NOT EXISTS wiki_aliases (
      alias_id INTEGER PRIMARY KEY AUTOINCREMENT,
      concept_id INTEGER NOT NULL REFERENCES wiki_concepts(concept_id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'und',
      source TEXT NOT NULL DEFAULT 'ai',
      confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
      UNIQUE(concept_id, normalized_alias)
    )
  `);
  await db.queryAsync(`
    CREATE TABLE IF NOT EXISTS wiki_pages (
      page_id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      canonical_title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      primary_concept_id INTEGER REFERENCES wiki_concepts(concept_id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(library_id, normalized_title)
    )
  `);
  await db.queryAsync(`
    CREATE TABLE IF NOT EXISTS wiki_claims (
      claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL REFERENCES wiki_pages(page_id) ON DELETE CASCADE,
      claim_text TEXT NOT NULL,
      normalized_claim_text TEXT NOT NULL,
      claim_type TEXT NOT NULL CHECK(claim_type IN ('definition','mechanism','model','condition','comparison','limitation','consensus','conflict')),
      epistemic_status TEXT NOT NULL CHECK(epistemic_status IN ('provisional','supported','corroborated','disputed','unsupported')),
      coverage_level TEXT NOT NULL CHECK(coverage_level IN ('chunk_local','section_read','paper_reviewed','cross_paper','partial','incomplete')),
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(page_id, normalized_claim_text)
    )
  `);
  await db.queryAsync(`
    CREATE TABLE IF NOT EXISTS wiki_relations (
      relation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_concept_id INTEGER NOT NULL REFERENCES wiki_concepts(concept_id) ON DELETE CASCADE,
      predicate TEXT NOT NULL,
      normalized_predicate TEXT NOT NULL,
      target_concept_id INTEGER NOT NULL REFERENCES wiki_concepts(concept_id) ON DELETE CASCADE,
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      created_at INTEGER NOT NULL,
      UNIQUE(source_concept_id, normalized_predicate, target_concept_id),
      CHECK(source_concept_id != target_concept_id)
    )
  `);
  await db.queryAsync(`
    CREATE TABLE IF NOT EXISTS wiki_evidence (
      evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id INTEGER NOT NULL REFERENCES wiki_claims(claim_id) ON DELETE CASCADE,
      library_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      chunk_id_snapshot INTEGER NOT NULL,
      chunk_text_hash TEXT NOT NULL,
      source_content_hash TEXT NOT NULL,
      source_chunk_signature TEXT NOT NULL,
      source_reset_generation TEXT NOT NULL,
      excerpt_hash TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      evidence_role TEXT NOT NULL CHECK(evidence_role IN ('SUPPORTS','CONTRADICTS','QUALIFIES','EXAMPLE')),
      read_depth TEXT NOT NULL CHECK(read_depth IN ('chunk_local','section_read','paper_reviewed','cross_paper')),
      link_state TEXT NOT NULL CHECK(link_state IN ('valid','pending_relink','stale','source_deleted')),
      created_at INTEGER NOT NULL,
      last_verified_at INTEGER,
      UNIQUE(claim_id, library_id, item_key, excerpt_hash, evidence_role)
    )
  `);
  await db.queryAsync(`
    CREATE TABLE IF NOT EXISTS wiki_claim_embeddings (
      claim_id INTEGER PRIMARY KEY REFERENCES wiki_claims(claim_id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      model TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS idx_wiki_pages_library ON wiki_pages(library_id)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS idx_wiki_claims_page ON wiki_claims(page_id)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS idx_wiki_aliases_normalized ON wiki_aliases(normalized_alias)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS idx_wiki_evidence_source ON wiki_evidence(library_id, item_key, link_state)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS idx_wiki_relations_source ON wiki_relations(source_concept_id)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS idx_wiki_relations_target ON wiki_relations(target_concept_id)`,
  );
  await db.queryAsync(`PRAGMA user_version = ${WIKI_SCHEMA_VERSION}`);
}
