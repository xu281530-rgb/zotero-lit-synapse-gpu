import type { WikiDatabase } from "./wikiTypes";
import { normalizeWikiName } from "./wikiCanonicalizer";
import {
  classifyLegacyName,
  mergeTermFields,
  sameTerm,
  type WikiTermFields,
} from "./wikiConceptTerms";
import { rowColumn } from "./wikiRow";

export const WIKI_SCHEMA_VERSION = 5;

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
      primary_term_locked INTEGER NOT NULL DEFAULT 0,
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
  // The structured term store, schema 4. A concept's names stop being flat
  // strings here: every term - the primary one and every alias - carries a
  // Chinese full name, an English full name and an abbreviation in their own
  // columns, so "DRX" is recorded as the short form of a named concept rather
  // than as a third unrelated string.
  //
  // `source = 'legacy'` is the one exemption from the abbreviation rule, and
  // it exists only for migration: a pre-2.4.3 database may already hold a bare
  // "DRX" alias whose full name was never recorded, and dropping the user's
  // data to satisfy a rule about what the AI may WRITE would be the wrong
  // trade. Those rows are labelled in the UI so they can be completed by hand.
  await db.queryAsync(`
    CREATE TABLE IF NOT EXISTS wiki_concept_terms (
      term_id INTEGER PRIMARY KEY AUTOINCREMENT,
      concept_id INTEGER NOT NULL REFERENCES wiki_concepts(concept_id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('primary','alias')),
      name_zh TEXT NOT NULL DEFAULT '',
      name_en TEXT NOT NULL DEFAULT '',
      abbreviation TEXT NOT NULL DEFAULT '',
      normalized_zh TEXT NOT NULL DEFAULT '',
      normalized_en TEXT NOT NULL DEFAULT '',
      normalized_abbr TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'ai',
      origin_zh TEXT NOT NULL DEFAULT '',
      origin_en TEXT NOT NULL DEFAULT '',
      origin_abbr TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (name_zh <> '' OR name_en <> '' OR source = 'legacy'),
      UNIQUE(concept_id, normalized_zh, normalized_en, normalized_abbr)
    )
  `);
  // Schema 5. Field-level provenance, added to a table schema 4 already
  // created, so the columns arrive by ALTER for anyone upgrading. They default
  // to the empty string - "unknown" - because a 2.4.3 row genuinely does not
  // record whether its English name was quoted or inferred, and stamping every
  // one of them "literature" would invent exactly the assurance these columns
  // exist to make honest. Unknown fields render untinted and are treated as
  // unoverwritable, so the upgrade cannot cost anyone a name.
  for (const column of ["origin_zh", "origin_en", "origin_abbr"]) {
    await addColumnIfMissing(
      db,
      "wiki_concept_terms",
      column,
      "TEXT NOT NULL DEFAULT ''",
    );
  }
  // Schema 5. A primary term a person pinned by hand. 0 is the pre-lock state:
  // every migrated concept keeps electing its primary by completeness until
  // someone overrules it.
  await addColumnIfMissing(
    db,
    "wiki_concepts",
    "primary_term_locked",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await db.queryAsync(`
    CREATE TABLE IF NOT EXISTS wiki_concept_term_sources (
      source_id INTEGER PRIMARY KEY AUTOINCREMENT,
      term_id INTEGER NOT NULL REFERENCES wiki_concept_terms(term_id) ON DELETE CASCADE,
      library_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      chunk_id_snapshot INTEGER,
      excerpt TEXT NOT NULL DEFAULT '',
      excerpt_hash TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(term_id, library_id, item_key, excerpt_hash)
    )
  `);
  // Exactly one primary term per concept, enforced by the database rather than
  // by whichever write path happens to remember. A concept with two primaries
  // would render two different titles for one entry depending on which query
  // reached it first.
  await db.queryAsync(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_concept_primary_term
       ON wiki_concept_terms(concept_id)
       WHERE role = 'primary'`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS idx_wiki_concept_terms_zh ON wiki_concept_terms(normalized_zh)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS idx_wiki_concept_terms_en ON wiki_concept_terms(normalized_en)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS idx_wiki_concept_term_sources_item
       ON wiki_concept_term_sources(library_id, item_key)`,
  );
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
    // Schema 4. NULL is the pre-concept-library state exactly: a session
    // carried over from 2.4.2 owes its whole-paper concept pass like any other.
    ["concepts_recorded_at", "INTEGER"],
    // Schema 5. Candidate concepts noticed while reading, held here until the
    // whole-paper pass writes them in one go. Empty is the correct carried-over
    // state: a session from 2.4.3 staged nothing because staging did not exist.
    ["staged_concepts", "TEXT NOT NULL DEFAULT ''"],
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
  await backfillConceptTerms(db);
  await db.queryAsync(`PRAGMA user_version = ${WIKI_SCHEMA_VERSION}`);
}

/**
 * Give every pre-2.4.3 concept the structured terms it never had.
 *
 * Before schema 4 a concept was one `canonical_name` plus a bag of flat alias
 * strings. Those strings still exist and still mean something, so the upgrade
 * reads them rather than discarding them: `canonical_name` becomes the primary
 * term, each alias becomes an alias term, and {@link classifyLegacyName}
 * decides which of the three fields each string belongs in.
 *
 * Two behaviours are worth stating, because both are choices:
 *
 *   - A legacy alias that classifies as a bare abbreviation is folded into the
 *     primary term's empty abbreviation slot when there is one. That is not a
 *     guess: the database already asserts this string is a name for THIS
 *     concept, so attaching it to the concept's own full name adds no claim
 *     that was not already recorded. Only when the slot is already taken by a
 *     different abbreviation is the row kept as its own `source = 'legacy'`
 *     term, which the UI marks as needing a full name.
 *   - It runs on every open and skips any concept that already has terms, so
 *     it is idempotent and costs one query on an up-to-date database.
 */
async function backfillConceptTerms(db: WikiDatabase): Promise<void> {
  const pending = await db.queryAsync(
    `SELECT c.concept_id, c.canonical_name
       FROM wiki_concepts c
       LEFT JOIN wiki_concept_terms t ON t.concept_id = c.concept_id
      WHERE t.term_id IS NULL`,
  );
  if (!pending.length) return;
  const now = Date.now();
  for (const row of pending) {
    const conceptId = Number(rowColumn(row, "concept_id", "conceptId"));
    const canonicalName = String(
      rowColumn(row, "canonical_name", "canonicalName") ?? "",
    );
    const primary = classifyLegacyName(canonicalName);
    if (!primary.zh && !primary.en && !primary.abbr) continue;
    const aliasRows = await db.queryAsync(
      "SELECT alias, language FROM wiki_aliases WHERE concept_id = ? ORDER BY alias_id",
      [conceptId],
    );
    const aliasTerms: WikiTermFields[] = [];
    for (const aliasRow of aliasRows) {
      const fields = classifyLegacyName(
        String(rowColumn(aliasRow, "alias", "alias") ?? ""),
        String(rowColumn(aliasRow, "language", "language") ?? ""),
      );
      if (!fields.zh && !fields.en && !fields.abbr) continue;
      // A bare abbreviation completes the primary term when that term has no
      // abbreviation yet, rather than becoming a term of its own.
      if (!fields.zh && !fields.en && fields.abbr) {
        if (!primary.abbr) {
          primary.abbr = fields.abbr;
          continue;
        }
        if (normalizeWikiName(primary.abbr) === normalizeWikiName(fields.abbr)) {
          continue;
        }
      }
      const twin = aliasTerms.find((existing) => sameTerm(existing, fields));
      if (twin) {
        Object.assign(twin, mergeTermFields(twin, fields));
        continue;
      }
      if (sameTerm(primary, fields)) {
        Object.assign(primary, mergeTermFields(primary, fields));
        continue;
      }
      aliasTerms.push(fields);
    }
    await insertLegacyTerm(db, conceptId, "primary", primary, now);
    for (const fields of aliasTerms) {
      await insertLegacyTerm(db, conceptId, "alias", fields, now);
    }
  }
}

async function insertLegacyTerm(
  db: WikiDatabase,
  conceptId: number,
  role: "primary" | "alias",
  fields: WikiTermFields,
  now: number,
): Promise<void> {
  await db.queryAsync(
    `INSERT OR IGNORE INTO wiki_concept_terms
       (concept_id, role, name_zh, name_en, abbreviation,
        normalized_zh, normalized_en, normalized_abbr,
        source, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'legacy', 1, ?, ?)`,
    [
      conceptId,
      role,
      fields.zh,
      fields.en,
      fields.abbr,
      fields.zh ? normalizeWikiName(fields.zh) : "",
      fields.en ? normalizeWikiName(fields.en) : "",
      fields.abbr ? normalizeWikiName(fields.abbr) : "",
      now,
      now,
    ],
  );
}
