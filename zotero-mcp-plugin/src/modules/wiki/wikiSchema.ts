import type { WikiDatabase } from "./wikiTypes";

export const WIKI_SCHEMA_VERSION = 3;

/**
 * Add a column an older database does not have yet.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so every
 * column added after a release has to be migrated in separately or it exists
 * only for users who installed after it. Checked against `table_info` rather
 * than by catching "duplicate column name", so a genuine ALTER failure - a
 * locked database, a typo in the DDL - still surfaces instead of being
 * swallowed as "already there".
 */
async function addColumnIfMissing(
  db: WikiDatabase,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const rows = await db.queryAsync(`PRAGMA table_info(${table})`);
  const present = rows.some((row: any) => {
    try {
      return String(row.name) === column;
    } catch {
      return false;
    }
  });
  if (present) return;
  await db.queryAsync(
    `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
  );
}

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
  await db.queryAsync(`
    CREATE TABLE IF NOT EXISTS wiki_reading_sessions (
      session_id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      total_chunks INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reading','prepared','committed','skipped','failed')),
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      note TEXT NOT NULL DEFAULT '',
      expert TEXT NOT NULL DEFAULT '',
      note_key TEXT NOT NULL DEFAULT '',
      delivered_batches INTEGER NOT NULL DEFAULT 0,
      integrated_batches INTEGER NOT NULL DEFAULT 0,
      integrated_chunks INTEGER NOT NULL DEFAULT 0,
      last_integration_unchanged INTEGER NOT NULL DEFAULT 0,
      final_synthesis_at INTEGER
    )
  `);
  // The reading-note columns, for databases created before schema 3. Their
  // defaults are the pre-note state exactly: no expert, no note, nothing
  // delivered and nothing integrated, so an interrupted 2.x read resumes as a
  // paper whose note has not been started rather than as one that is finished.
  for (const [column, definition] of [
    ["expert", "TEXT NOT NULL DEFAULT ''"],
    ["note_key", "TEXT NOT NULL DEFAULT ''"],
    ["delivered_batches", "INTEGER NOT NULL DEFAULT 0"],
    ["integrated_batches", "INTEGER NOT NULL DEFAULT 0"],
    ["integrated_chunks", "INTEGER NOT NULL DEFAULT 0"],
    ["last_integration_unchanged", "INTEGER NOT NULL DEFAULT 0"],
    ["final_synthesis_at", "INTEGER"],
  ] as const) {
    await addColumnIfMissing(db, "wiki_reading_sessions", column, definition);
  }
  await db.queryAsync(`
    CREATE TABLE IF NOT EXISTS wiki_reading_chunks (
      session_id INTEGER NOT NULL REFERENCES wiki_reading_sessions(session_id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      chunk_id INTEGER NOT NULL,
      delivered_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, chunk_index)
    )
  `);
  await db.queryAsync(`
    CREATE TABLE IF NOT EXISTS wiki_embedding_queue (
      claim_id INTEGER PRIMARY KEY REFERENCES wiki_claims(claim_id) ON DELETE CASCADE,
      text_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      enqueued_at INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL
    )
  `);
  // At most one paper may be open per library. A partial unique index makes
  // that the database's rule rather than a check the service could forget:
  // the "start B while A is unfinished" case cannot be written at all.
  await db.queryAsync(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_open_reading_session
       ON wiki_reading_sessions(library_id)
       WHERE state IN ('reading','prepared')`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS idx_wiki_reading_sessions_item
       ON wiki_reading_sessions(library_id, item_key, state)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS idx_wiki_embedding_queue_due
       ON wiki_embedding_queue(next_attempt_at)`,
  );
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
