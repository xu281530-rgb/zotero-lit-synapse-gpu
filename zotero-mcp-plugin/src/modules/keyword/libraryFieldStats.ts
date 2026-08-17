/**
 * Library-wide average field lengths, the reference BM25F normalises against.
 *
 * 为什么不能用「本次查询的候选池」算 avgdl：avgdl 只是长度归一化的基准，它必须
 * 对同一篇文献恒定，否则同一篇文献、同一个检索词会因为**别的**文献恰好也命中而
 * 得到不同的分数。实测本库上这个漂移是真实的：
 *
 *   TARGET 单独命中           raw = 5.1011
 *   多一篇很长的共同命中文献   raw = 5.3521   (+4.9%)
 *   多一篇很短的共同命中文献   raw = 4.2930   (-15.8%)
 *
 * 更糟的是只有一篇命中时：池均值就等于它自己的长度，len/avgdl 恒为 1，长度归一化
 * 被彻底抵消——实测「1 个词的标题」和「81 个词的标题」得分完全相同（都是 4.5942）。
 *
 * 所以基准改成 Library 级：对全库一次性算出各字段平均长度，缓存起来，用一个
 * 极便宜的指纹判断是否需要重算。指纹是「条目数 + 最近修改时间」，实测 0.85ms，
 * 新增、删除、编辑三种改动都会让它变化。全量重算实测 35ms / 931 篇，所以这里
 * 不做增量维护——那是为一个 35ms 的操作增加一整套失效逻辑。
 */

import {
  BM25_FIELDS,
  METADATA_FIELD_MAP,
  METADATA_REGIME_FIELDS,
  type Bm25Field,
} from "./bm25f";
import { tokenizeForIndex } from "./scientificTokenizer";

declare const Zotero: any;
declare let ztoolkit: ZToolkit;

/** Average token length per field, plus the population it was measured over. */
export interface LibraryFieldAverages {
  /** Documents the averages were computed over. */
  documentCount: number;
  averageLengths: Record<Bm25Field, number>;
}

/**
 * Where the statistics come from, injected so the caching and the arithmetic can
 * be tested without a Zotero library.
 */
export interface LibraryFieldStatsSource {
  /**
   * A cheap value that changes whenever the library's documents change.
   *
   * Cheap is the requirement: it is consulted on every search, whereas
   * {@link readFields} runs only when this value moved.
   */
  signature(libraryID: number): Promise<string>;
  /**
   * The metadata field text of every document in the library, keyed by Zotero
   * field name (`title`, `abstractNote`, `tags`, ...).
   */
  readFields(libraryID: number): Promise<Array<Record<string, string>>>;
}

function emptyAverages(): Record<Bm25Field, number> {
  const averages = {} as Record<Bm25Field, number>;
  for (const field of BM25_FIELDS) averages[field] = 0;
  return averages;
}

const EMPTY: LibraryFieldAverages = {
  documentCount: 0,
  averageLengths: emptyAverages(),
};

interface CacheEntry {
  signature: string;
  averages: LibraryFieldAverages;
}

export class LibraryFieldStats {
  private readonly source: LibraryFieldStatsSource;
  private readonly cache = new Map<number, CacheEntry>();

  constructor(source: LibraryFieldStatsSource) {
    this.source = source;
  }

  /**
   * The library's average field lengths, recomputed only when it has changed.
   *
   * Never throws. A library that cannot be read yields zero averages, and zero
   * averages disable length normalisation for that query rather than inventing a
   * reference length — a wrong reference would silently distort every score,
   * whereas no reference simply means "score without it".
   */
  async get(libraryID: number): Promise<LibraryFieldAverages> {
    let signature: string;
    try {
      signature = await this.source.signature(libraryID);
    } catch (error) {
      // Without a signature there is no way to know whether the cache is stale.
      // Serving it anyway is better than recomputing on every query, and far
      // better than failing the search.
      const cached = this.cache.get(libraryID);
      if (cached) return cached.averages;
      ztoolkit?.log?.(
        `[LibraryFieldStats] no signature for library ${libraryID}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warn",
      );
      return EMPTY;
    }

    const cached = this.cache.get(libraryID);
    if (cached && cached.signature === signature) return cached.averages;

    let averages: LibraryFieldAverages;
    try {
      averages = await this.compute(libraryID);
    } catch (error) {
      ztoolkit?.log?.(
        `[LibraryFieldStats] could not read library ${libraryID}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warn",
      );
      return EMPTY;
    }

    this.cache.set(libraryID, { signature, averages });
    return averages;
  }

  /** Forget one library, or all of them. */
  invalidate(libraryID?: number): void {
    if (libraryID === undefined) this.cache.clear();
    else this.cache.delete(libraryID);
  }

  private async compute(libraryID: number): Promise<LibraryFieldAverages> {
    const documents = await this.source.readFields(libraryID);
    const totals = emptyAverages();
    let documentCount = 0;

    for (const document of documents) {
      documentCount += 1;
      for (const [sourceField, targetField] of Object.entries(
        METADATA_FIELD_MAP,
      )) {
        const text = document?.[sourceField];
        if (!text) continue;
        totals[targetField] += tokenizeForIndex(text).length;
      }
    }

    const averageLengths = emptyAverages();
    if (documentCount > 0) {
      // Only the metadata regime: the body average belongs to the keyword index,
      // which knows exactly which documents have a body and how long it is.
      for (const field of METADATA_REGIME_FIELDS) {
        averageLengths[field] = totals[field] / documentCount;
      }
    }

    return { documentCount, averageLengths };
  }
}

/**
 * The production source: this Zotero library.
 *
 * The signature is one indexed SQL query — measured at 0.85ms on a
 * 3427-item database — and moves on all three kinds of change: an insert or a
 * permanent delete moves the count, a trash moves it too (trashed items are
 * excluded), and an edit moves `clientDateModified`.
 */
export function createZoteroLibraryFieldStatsSource(): LibraryFieldStatsSource {
  return {
    async signature(libraryID: number): Promise<string> {
      // Single-line SQL: Zotero's queryAsync has a known problem with multi-line
      // statements, which the vector store documents at its own call sites.
      const value = await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(*) || ':' || IFNULL(MAX(clientDateModified), '') FROM items WHERE libraryID = ? AND itemID NOT IN (SELECT itemID FROM deletedItems)`,
        [libraryID],
      );
      return String(value ?? "");
    },

    async readFields(
      libraryID: number,
    ): Promise<Array<Record<string, string>>> {
      const out: Array<Record<string, string>> = [];
      const all = (await Zotero.Items.getAll(libraryID, true)) ?? [];
      const ids = (Array.isArray(all) ? all : []).map((entry: any) =>
        typeof entry === "number" ? entry : entry?.id,
      );

      // Chunked exactly as the term sampler does, so a large library is read in
      // bounded steps rather than as one enormous load.
      for (let offset = 0; offset < ids.length; offset += 200) {
        const chunk = ids.slice(offset, offset + 200).filter(Boolean);
        if (chunk.length === 0) continue;
        const items = await Zotero.Items.getAsync(chunk);
        for (const item of (items as any[]) ?? []) {
          try {
            if (!item?.isRegularItem?.()) continue;
            if (item.deleted) continue;
            const fields: Record<string, string> = {};
            for (const field of [
              "title",
              "abstractNote",
              "publicationTitle",
              "extra",
            ]) {
              try {
                const value = item.getField(field);
                if (typeof value === "string" && value) fields[field] = value;
              } catch {
                // A field this item type does not have contributes nothing.
              }
            }
            try {
              const creators = (item.getCreators?.() ?? [])
                .map((creator: any) =>
                  `${creator.firstName || ""} ${creator.lastName || ""}`.trim(),
                )
                .filter(Boolean)
                .join(", ");
              if (creators) fields.creator = creators;
            } catch {
              // No creators is not an error.
            }
            try {
              const tags = (item.getTags?.() ?? [])
                .map((tag: any) => tag.tag)
                .filter(Boolean)
                .join(", ");
              if (tags) fields.tags = tags;
            } catch {
              // No tags is not an error.
            }
            out.push(fields);
          } catch {
            // One unreadable item must not cost the whole statistic.
          }
        }
      }
      return out;
    },
  };
}

/** The shared instance the keyword branch uses. */
let sharedStats: LibraryFieldStats | null = null;

export function getLibraryFieldStats(): LibraryFieldStats {
  if (!sharedStats) {
    sharedStats = new LibraryFieldStats(createZoteroLibraryFieldStatsSource());
  }
  return sharedStats;
}
