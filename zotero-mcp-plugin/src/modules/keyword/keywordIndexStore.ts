/**
 * The inverted index the body-keyword branch reads.
 *
 * 为什么自己写倒排表，而不是用 SQLite 的 FTS5：本环境实测 `no such module: fts5`，
 * Zotero 的 SQLite 没编译 FTS5。而且即使有，FTS5 的 bm25() 只做「整表一个长度
 * 归一化」，给不了「标题按标题平均长度、正文按正文平均长度」这种按字段独立归
 * 一化，中文还只能按单字切。所以自建反而更贴合需求。
 *
 * 存储形态：每条 posting 一行，而不是「每词一个二进制块」。块存储更省——在 706 篇
 * 语料上实测 29.8MB vs 84.8MB，差 2.8 倍——但块存储每更新一篇文献就要读改写这篇
 * 里全部约 5000 个词的块，一次单篇「更新索引」要几千次写操作。行存储用「墓碑 +
 * 批量压实」换来单篇更新的低成本。
 *
 * 实测真实开销（本库 26 篇已索引文献、去重后 1719 段正文）：索引 2.40MB、
 * 132021 条 posting、19.0 字节/posting，建索引 32ms/篇。按此外推到全部 706 篇
 * 有正文的文献约 65MB、约 23 秒，远在既定的 200MB 预算内。
 *
 * 库隔离：term_id 按 library 分配，所以一次查询在物理上就不会碰到别的 library
 * 的 posting，不依赖查询里写对 WHERE 条件。
 */

import {
  normalize,
  planQueryTerm,
  tokenizeForIndex,
  type QueryPlan,
} from "./scientificTokenizer";
import { filterBodyForKeywordIndex, isNonBodyChunk } from "./contentFilters";

declare let ztoolkit: ZToolkit;

/**
 * The slice of Zotero's DBConnection this module needs.
 *
 * Narrow on purpose: the tests drive it with node:sqlite, and a wider surface
 * would mean the tests exercise a different object than production does.
 */
export interface KeywordIndexDatabase {
  queryAsync(sql: string, params?: unknown[]): Promise<any[]>;
  executeTransaction<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Fields, stored as small integers so a posting row stays narrow.
 *
 * Numbers are permanent: they are written into every posting row, so reordering
 * them would silently reinterpret an existing index rather than migrate it.
 */
export const KEYWORD_FIELD_IDS = {
  title: 0,
  abstract: 1,
  tags: 2,
  body: 3,
  publicationTitle: 4,
  creator: 5,
  extra: 6,
} as const;

export type KeywordFieldName = keyof typeof KEYWORD_FIELD_IDS;

const FIELD_NAME_BY_ID: Readonly<Record<number, KeywordFieldName>> = {
  0: "title",
  1: "abstract",
  2: "tags",
  3: "body",
  4: "publicationTitle",
  5: "creator",
  6: "extra",
};

/**
 * Chunk numbers per document, as a multiplier packing (doc, chunk) into one
 * integer key.
 *
 * This is what removes a whole mapping table and a join from every query: a
 * posting's document is `Math.floor(slot / CHUNK_STRIDE)`, so compaction and
 * liveness filtering are arithmetic rather than lookups. 65536 is far above the
 * largest chunk count observed in this library (196) and leaves the packed value
 * inside the exactly-representable integer range.
 */
export const CHUNK_STRIDE = 65536;

/** Schema version, so a future change can migrate rather than guess. */
export const KEYWORD_INDEX_VERSION = 1;

export function slotFor(docId: number, chunkId = 0): number {
  return docId * CHUNK_STRIDE + chunkId;
}

export function docIdFromSlot(slot: number): number {
  return Math.floor(slot / CHUNK_STRIDE);
}

export function chunkIdFromSlot(slot: number): number {
  return slot - docIdFromSlot(slot) * CHUNK_STRIDE;
}

/** One document's per-field token counts, in tokens. */
export type KeywordFieldLengths = Record<KeywordFieldName, number>;

export interface WriteItemRequest {
  libraryID: number;
  itemKey: string;
  title?: string;
  abstract?: string;
  tags?: string[];
  publicationTitle?: string;
  /** Creator names, already joined the way the metadata ranker joins them. */
  creator?: string;
  extra?: string;
  /**
   * The chunk texts the vector index stored, in the SAME order and therefore
   * with the same chunk numbers.
   *
   * Passed in rather than re-derived: one parse, one chunking, both indexes.
   * A chunk that is entirely reference list or submission boilerplate is skipped
   * here but still counts as a chunk number, because those numbers are part of
   * the plugin's public surface (`search_fulltext`, `get_document_chunks`).
   */
  chunks: string[];
}

export interface WriteItemResult {
  docId: number;
  lengths: KeywordFieldLengths;
  indexedChunks: number;
  skippedChunks: number;
  distinctTerms: number;
  postings: number;
}

/** One posting: which document/chunk/field, and how often the term occurs. */
export interface Posting {
  slot: number;
  docId: number;
  /** 0 for the document-level fields, which have no passage of their own. */
  chunkId: number;
  field: KeywordFieldName;
  tf: number;
}

export interface TermPostings {
  term: string;
  field: KeywordFieldName;
  postings: Posting[];
}

export interface KeywordCorpusStatistics {
  documentCount: number;
  averageLengths: KeywordFieldLengths;
}

/**
 * Cap on posting rows one query may read.
 *
 * A common Chinese bigram can appear in most chunks of most documents, so an
 * uncapped lookup would degrade into the whole-corpus scan this index exists to
 * avoid. Terms are read rarest-first, so the cap bites on the terms that carry
 * the least information — the opposite of truncating the ranking.
 */
export const DEFAULT_MAX_POSTING_ROWS = 200000;

function tokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const occurrence of tokenizeForIndex(text)) {
    counts.set(occurrence.term, (counts.get(occurrence.term) ?? 0) + 1);
  }
  return counts;
}

function totalTokens(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

export class KeywordIndexStore {
  private readonly db: KeywordIndexDatabase;
  private schemaReady = false;

  constructor(db: KeywordIndexDatabase) {
    this.db = db;
  }

  /**
   * Create the tables if they are absent.
   *
   * Idempotent, and deliberately additive: nothing here touches the embeddings
   * tables, so a database that already holds a vector index keeps working
   * whether or not the keyword tables exist yet. That is what lets an existing
   * vector-only index be topped up with a keyword index instead of rebuilt.
   */
  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;

    await this.db.queryAsync(
      `CREATE TABLE IF NOT EXISTS kw_terms (term_id INTEGER PRIMARY KEY AUTOINCREMENT, library_id INTEGER NOT NULL, term TEXT NOT NULL, UNIQUE(library_id, term))`,
    );
    await this.db.queryAsync(
      `CREATE TABLE IF NOT EXISTS kw_docs (doc_id INTEGER PRIMARY KEY AUTOINCREMENT, library_id INTEGER NOT NULL, item_key TEXT NOT NULL, alive INTEGER NOT NULL DEFAULT 1, len_title INTEGER NOT NULL DEFAULT 0, len_abstract INTEGER NOT NULL DEFAULT 0, len_tags INTEGER NOT NULL DEFAULT 0, len_body INTEGER NOT NULL DEFAULT 0, len_publication INTEGER NOT NULL DEFAULT 0, len_creator INTEGER NOT NULL DEFAULT 0, len_extra INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0, indexed_chunks INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT ${KEYWORD_INDEX_VERSION}, indexed_at INTEGER NOT NULL)`,
    );
    // Only ONE live row per item may exist; the partial index makes that a
    // database guarantee rather than something every caller has to remember.
    await this.db.queryAsync(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_kw_docs_live ON kw_docs(library_id, item_key) WHERE alive = 1`,
    );
    await this.db.queryAsync(
      `CREATE INDEX IF NOT EXISTS idx_kw_docs_library ON kw_docs(library_id, alive)`,
    );
    await this.db.queryAsync(
      `CREATE TABLE IF NOT EXISTS kw_postings (term_id INTEGER NOT NULL, field INTEGER NOT NULL, slot INTEGER NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY (term_id, field, slot)) WITHOUT ROWID`,
    );

    this.schemaReady = true;
  }

  /** Resolve, creating on demand, the term ids for one library. */
  private async internTerms(
    libraryID: number,
    terms: Iterable<string>,
  ): Promise<Map<string, number>> {
    const wanted = Array.from(new Set(terms));
    const resolved = new Map<string, number>();
    if (wanted.length === 0) return resolved;

    /*
     * Three statements per batch, not two per term.
     *
     * A body-bearing document contributes several thousand distinct terms, most
     * of which already exist. Probing and inserting them one at a time was the
     * other half of the slow build: insert-then-select per new term is two round
     * trips each, so a first-time document cost ~10,000 statements. Here the
     * whole batch is looked up, the misses are inserted in one multi-row
     * statement, and the batch is looked up once more to pick up the new ids.
     */
    const CHUNK = 400;
    for (let offset = 0; offset < wanted.length; offset += CHUNK) {
      const slice = wanted.slice(offset, offset + CHUNK);
      const placeholders = slice.map(() => "?").join(",");

      const existing = await this.db.queryAsync(
        `SELECT term_id, term FROM kw_terms WHERE library_id = ? AND term IN (${placeholders})`,
        [libraryID, ...slice],
      );
      for (const row of existing ?? []) {
        resolved.set(String(row.term), Number(row.term_id));
      }

      const missing = slice.filter((term) => !resolved.has(term));
      if (missing.length === 0) continue;

      const values = missing.map(() => "(?, ?)").join(",");
      const params: unknown[] = [];
      for (const term of missing) params.push(libraryID, term);
      await this.db.queryAsync(
        `INSERT OR IGNORE INTO kw_terms (library_id, term) VALUES ${values}`,
        params,
      );

      const inserted = await this.db.queryAsync(
        `SELECT term_id, term FROM kw_terms WHERE library_id = ? AND term IN (${missing.map(() => "?").join(",")})`,
        [libraryID, ...missing],
      );
      for (const row of inserted ?? []) {
        resolved.set(String(row.term), Number(row.term_id));
      }
    }
    return resolved;
  }

  /**
   * Index one item, replacing whatever was indexed for it before.
   *
   * The previous revision is TOMBSTONED rather than deleted: its postings stay
   * on disk, unreachable because queries only follow live documents, and are
   * reclaimed in one pass by {@link compact}. Deleting them here instead would
   * mean thousands of individual statements — one per distinct term in the
   * document — every time a single paper is updated.
   */
  async writeItem(request: WriteItemRequest): Promise<WriteItemResult> {
    await this.ensureSchema();

    // Every document-level field, in one list, so adding a field means editing
    // one place instead of four (tokenise, sum lengths, collect terms, insert).
    const metadataCounts: Array<[KeywordFieldName, Map<string, number>]> = [
      ["title", tokenCounts(request.title ?? "")],
      ["abstract", tokenCounts(request.abstract ?? "")],
      ["tags", tokenCounts((request.tags ?? []).join("\n"))],
      ["publicationTitle", tokenCounts(request.publicationTitle ?? "")],
      ["creator", tokenCounts(request.creator ?? "")],
      ["extra", tokenCounts(request.extra ?? "")],
    ];

    // Per-chunk body counts, so a hit can be traced to the passage it came from.
    const bodyChunks: Array<{ chunkId: number; counts: Map<string, number> }> =
      [];
    let skippedChunks = 0;
    request.chunks.forEach((chunkText, chunkId) => {
      if (chunkId >= CHUNK_STRIDE) {
        // Beyond the packing capacity. Never reached in practice (the largest
        // document in this library has 196 chunks) but silently mis-attributing
        // a passage would be worse than dropping it.
        skippedChunks += 1;
        return;
      }
      if (isNonBodyChunk(chunkText)) {
        skippedChunks += 1;
        return;
      }
      const filtered = filterBodyForKeywordIndex(chunkText);
      if (!filtered.text) {
        skippedChunks += 1;
        return;
      }
      const counts = tokenCounts(filtered.text);
      if (counts.size === 0) {
        skippedChunks += 1;
        return;
      }
      bodyChunks.push({ chunkId, counts });
    });

    let bodyLength = 0;
    for (const chunk of bodyChunks) bodyLength += totalTokens(chunk.counts);

    const lengths: KeywordFieldLengths = {
      title: 0,
      abstract: 0,
      tags: 0,
      body: bodyLength,
      publicationTitle: 0,
      creator: 0,
      extra: 0,
    };
    for (const [field, counts] of metadataCounts) {
      lengths[field] = totalTokens(counts);
    }

    const allTerms = new Set<string>();
    for (const [, counts] of metadataCounts) {
      for (const term of counts.keys()) allTerms.add(term);
    }
    for (const chunk of bodyChunks) {
      for (const term of chunk.counts.keys()) allTerms.add(term);
    }

    let docId = 0;
    let postingCount = 0;

    await this.db.executeTransaction(async () => {
      await this.db.queryAsync(
        `UPDATE kw_docs SET alive = 0 WHERE library_id = ? AND item_key = ? AND alive = 1`,
        [request.libraryID, request.itemKey],
      );
      await this.db.queryAsync(
        `INSERT INTO kw_docs (library_id, item_key, alive, len_title, len_abstract, len_tags, len_body, len_publication, len_creator, len_extra, chunk_count, indexed_chunks, version, indexed_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          request.libraryID,
          request.itemKey,
          lengths.title,
          lengths.abstract,
          lengths.tags,
          lengths.body,
          lengths.publicationTitle,
          lengths.creator,
          lengths.extra,
          request.chunks.length,
          bodyChunks.length,
          KEYWORD_INDEX_VERSION,
          Math.floor(Date.now() / 1000),
        ],
      );
      const created = await this.db.queryAsync(
        `SELECT doc_id FROM kw_docs WHERE library_id = ? AND item_key = ? AND alive = 1`,
        [request.libraryID, request.itemKey],
      );
      docId = Number(created?.[0]?.doc_id ?? 0);
      if (!docId)
        throw new Error("keyword index: document row was not created");

      const termIds = await this.internTerms(request.libraryID, allTerms);

      const rows: Array<[number, number, number, number]> = [];
      const pushField = (
        field: KeywordFieldName,
        counts: Map<string, number>,
        chunkId: number,
      ) => {
        for (const [term, tf] of counts) {
          const termId = termIds.get(term);
          if (termId === undefined) continue;
          rows.push([
            termId,
            KEYWORD_FIELD_IDS[field],
            slotFor(docId, chunkId),
            tf,
          ]);
        }
      };
      for (const [field, counts] of metadataCounts) {
        pushField(field, counts, 0);
      }
      for (const chunk of bodyChunks) {
        pushField("body", chunk.counts, chunk.chunkId);
      }

      /*
       * Multi-row INSERT, not one statement per posting.
       *
       * Measured on this user's library: 931 metadata-only documents took 13.7s
       * one row at a time, i.e. 15ms per document for nothing but a title and an
       * abstract. A document WITH body text carries roughly twenty times as many
       * postings, so the per-statement overhead — not the tokenising — would have
       * been what made an index build slow.
       *
       * 200 rows is 800 bound parameters, comfortably inside SQLite's default
       * limit of 999 per statement.
       */
      const INSERT_BATCH = 200;
      for (let offset = 0; offset < rows.length; offset += INSERT_BATCH) {
        const batch = rows.slice(offset, offset + INSERT_BATCH);
        const values = batch.map(() => "(?, ?, ?, ?)").join(",");
        const params: number[] = [];
        for (const row of batch) params.push(row[0], row[1], row[2], row[3]);
        await this.db.queryAsync(
          `INSERT OR REPLACE INTO kw_postings (term_id, field, slot, tf) VALUES ${values}`,
          params,
        );
      }
      postingCount = rows.length;
    });

    return {
      docId,
      lengths,
      indexedChunks: bodyChunks.length,
      skippedChunks,
      distinctTerms: allTerms.size,
      postings: postingCount,
    };
  }

  /** Tombstone one item. Its postings are reclaimed by {@link compact}. */
  async removeItem(libraryID: number, itemKey: string): Promise<boolean> {
    await this.ensureSchema();
    const before = await this.db.queryAsync(
      `SELECT doc_id FROM kw_docs WHERE library_id = ? AND item_key = ? AND alive = 1`,
      [libraryID, itemKey],
    );
    if (!before?.length) return false;
    await this.db.queryAsync(
      `UPDATE kw_docs SET alive = 0 WHERE library_id = ? AND item_key = ? AND alive = 1`,
      [libraryID, itemKey],
    );
    return true;
  }

  /** Drop everything for one library, or for every library when omitted. */
  async clear(libraryID?: number): Promise<void> {
    await this.ensureSchema();
    await this.db.executeTransaction(async () => {
      if (libraryID === undefined) {
        await this.db.queryAsync(`DELETE FROM kw_postings`);
        await this.db.queryAsync(`DELETE FROM kw_docs`);
        await this.db.queryAsync(`DELETE FROM kw_terms`);
        return;
      }
      const terms = await this.db.queryAsync(
        `SELECT term_id FROM kw_terms WHERE library_id = ?`,
        [libraryID],
      );
      for (const row of terms ?? []) {
        await this.db.queryAsync(`DELETE FROM kw_postings WHERE term_id = ?`, [
          Number(row.term_id),
        ]);
      }
      await this.db.queryAsync(`DELETE FROM kw_docs WHERE library_id = ?`, [
        libraryID,
      ]);
      await this.db.queryAsync(`DELETE FROM kw_terms WHERE library_id = ?`, [
        libraryID,
      ]);
    });
  }

  /**
   * Reclaim the postings of tombstoned documents in ONE table scan.
   *
   * Meant to be called once at the end of an index build, not per item: the
   * whole reason updates are cheap is that they defer this work, so doing it
   * eagerly would give back the cost it was designed to avoid.
   */
  async compact(): Promise<{
    removedDocuments: number;
    removedPostings: number;
  }> {
    await this.ensureSchema();
    const dead = await this.db.queryAsync(
      `SELECT doc_id FROM kw_docs WHERE alive = 0`,
    );
    const deadIds = (dead ?? []).map((row: any) => Number(row.doc_id));
    if (deadIds.length === 0)
      return { removedDocuments: 0, removedPostings: 0 };

    let removedPostings = 0;
    await this.db.executeTransaction(async () => {
      const CHUNK = 200;
      for (let offset = 0; offset < deadIds.length; offset += CHUNK) {
        const slice = deadIds.slice(offset, offset + CHUNK);
        const ranges = slice.map(() => `(slot >= ? AND slot < ?)`).join(" OR ");
        const params: number[] = [];
        for (const docId of slice) {
          params.push(slotFor(docId, 0), slotFor(docId + 1, 0));
        }
        const counted = await this.db.queryAsync(
          `SELECT COUNT(*) AS n FROM kw_postings WHERE ${ranges}`,
          params,
        );
        removedPostings += Number(counted?.[0]?.n ?? 0);
        await this.db.queryAsync(
          `DELETE FROM kw_postings WHERE ${ranges}`,
          params,
        );
      }
      const placeholders = deadIds.map(() => "?").join(",");
      await this.db.queryAsync(
        `DELETE FROM kw_docs WHERE doc_id IN (${placeholders})`,
        deadIds,
      );
      // A term whose every posting has just gone is dead weight in the
      // dictionary, and leaving it would let document frequency count documents
      // that no longer exist.
      await this.db.queryAsync(
        `DELETE FROM kw_terms WHERE term_id NOT IN (SELECT DISTINCT term_id FROM kw_postings)`,
      );
    });

    ztoolkit?.log?.(
      `[KeywordIndex] compacted ${deadIds.length} tombstoned documents, ${removedPostings} postings reclaimed`,
    );
    return { removedDocuments: deadIds.length, removedPostings };
  }

  /** Item keys with a live keyword index in this library. */
  async indexedItemKeys(libraryID: number): Promise<Set<string>> {
    await this.ensureSchema();
    const rows = await this.db.queryAsync(
      `SELECT item_key FROM kw_docs WHERE library_id = ? AND alive = 1`,
      [libraryID],
    );
    return new Set((rows ?? []).map((row: any) => String(row.item_key)));
  }

  /** Live document ids mapped to their item keys, for one library. */
  async liveDocuments(
    libraryID: number,
  ): Promise<Map<number, { itemKey: string; lengths: KeywordFieldLengths }>> {
    await this.ensureSchema();
    const rows = await this.db.queryAsync(
      `SELECT doc_id, item_key, len_title, len_abstract, len_tags, len_body, len_publication, len_creator, len_extra FROM kw_docs WHERE library_id = ? AND alive = 1`,
      [libraryID],
    );
    const map = new Map<
      number,
      { itemKey: string; lengths: KeywordFieldLengths }
    >();
    for (const row of rows ?? []) {
      map.set(Number(row.doc_id), {
        itemKey: String(row.item_key),
        lengths: {
          title: Number(row.len_title ?? 0),
          abstract: Number(row.len_abstract ?? 0),
          tags: Number(row.len_tags ?? 0),
          body: Number(row.len_body ?? 0),
          publicationTitle: Number(row.len_publication ?? 0),
          creator: Number(row.len_creator ?? 0),
          extra: Number(row.len_extra ?? 0),
        },
      });
    }
    return map;
  }

  /**
   * Per-field averages BM25F normalises against.
   *
   * Computed from the live document rows on every search rather than maintained
   * incrementally. That is a deliberate trade: the table has one row per indexed
   * paper, so this is a single cheap aggregate, and it can never drift out of
   * agreement with the documents actually in the index — which a counter updated
   * on every write eventually would.
   */
  async statistics(libraryID: number): Promise<KeywordCorpusStatistics> {
    await this.ensureSchema();
    const rows = await this.db.queryAsync(
      `SELECT COUNT(*) AS n, SUM(len_title) AS t, SUM(len_abstract) AS a, SUM(len_tags) AS g, SUM(len_body) AS b, SUM(len_publication) AS p, SUM(len_creator) AS c, SUM(len_extra) AS e FROM kw_docs WHERE library_id = ? AND alive = 1`,
      [libraryID],
    );
    const row = rows?.[0] ?? {};
    const documentCount = Number(row.n ?? 0);
    const mean = (total: unknown) =>
      documentCount > 0 ? Number(total ?? 0) / documentCount : 0;
    return {
      documentCount,
      averageLengths: {
        title: mean(row.t),
        abstract: mean(row.a),
        tags: mean(row.g),
        body: mean(row.b),
        publicationTitle: mean(row.p),
        creator: mean(row.c),
        extra: mean(row.e),
      },
    };
  }

  /** How many postings a term has, used to read the rarest terms first. */
  async postingCount(libraryID: number, term: string): Promise<number> {
    await this.ensureSchema();
    const rows = await this.db.queryAsync(
      `SELECT COUNT(*) AS n FROM kw_postings WHERE term_id IN (SELECT term_id FROM kw_terms WHERE library_id = ? AND term = ?)`,
      [libraryID, term],
    );
    return Number(rows?.[0]?.n ?? 0);
  }

  /**
   * Every posting for one term, across all fields.
   *
   * Returns an empty array for an unknown term rather than throwing: a query
   * naming a term the library has never contained is an ordinary miss, not an
   * error.
   */
  async lookup(libraryID: number, term: string): Promise<Posting[]> {
    await this.ensureSchema();
    const rows = await this.db.queryAsync(
      `SELECT field, slot, tf FROM kw_postings WHERE term_id IN (SELECT term_id FROM kw_terms WHERE library_id = ? AND term = ?) ORDER BY slot`,
      [libraryID, normalize(term)],
    );
    return (rows ?? []).map((row: any) => {
      const slot = Number(row.slot);
      return {
        slot,
        docId: docIdFromSlot(slot),
        chunkId: chunkIdFromSlot(slot),
        field: FIELD_NAME_BY_ID[Number(row.field)],
        tf: Number(row.tf),
      };
    });
  }

  /**
   * Look up every term of a query plan, cheapest first, under a row budget.
   *
   * Rarest-first matters twice over: the intersection shrinks fastest, and when
   * the budget runs out the terms left unread are the least informative ones.
   */
  async lookupPlan(
    libraryID: number,
    plan: QueryPlan,
    maxPostingRows = DEFAULT_MAX_POSTING_ROWS,
  ): Promise<{ byTerm: Map<string, Posting[]>; truncated: boolean }> {
    const counts = await Promise.all(
      plan.terms.map(async (term) => ({
        term,
        count: await this.postingCount(libraryID, term),
      })),
    );
    counts.sort((a, b) => a.count - b.count);

    const byTerm = new Map<string, Posting[]>();
    let budget = maxPostingRows;
    let truncated = false;
    for (const entry of counts) {
      if (entry.count === 0) {
        // A conjunction with a term nothing contains has no answer at all, so
        // stopping here is not truncation — it is the complete result.
        byTerm.set(entry.term, []);
        return { byTerm, truncated: false };
      }
      if (entry.count > budget) {
        truncated = true;
        break;
      }
      const postings = await this.lookup(libraryID, entry.term);
      byTerm.set(entry.term, postings);
      budget -= postings.length;
    }
    return { byTerm, truncated };
  }
}

/** Convenience: plan and look up in one call, for callers with a raw keyword. */
export async function lookupKeyword(
  store: KeywordIndexStore,
  libraryID: number,
  keyword: string,
  maxPostingRows?: number,
) {
  const plan = planQueryTerm(keyword);
  if (plan.terms.length === 0) {
    return { plan, byTerm: new Map<string, Posting[]>(), truncated: false };
  }
  const result = await store.lookupPlan(libraryID, plan, maxPostingRows);
  return { plan, ...result };
}
