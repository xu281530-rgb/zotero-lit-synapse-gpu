/**
 * Keeping pending link signals honest after the index moves.
 *
 * The failure this exists to prevent is named in the design as one of the two
 * worst outcomes of the whole feature: an old chunk id quietly pointing at new
 * text, and still being treated as settleable debt. A signal says "chunk 38 of
 * this paper and chunk 34 of that one are about the same mechanism, here are
 * both passages". Re-chunk either document and chunk 38 is a different
 * paragraph. Nothing about the row looks wrong; the model is simply asked to
 * reconcile two passages that were never compared.
 *
 * So every pending signal is checked against the live index, and the three
 * outcomes are kept apart:
 *
 *   VALID     - the passage is still where the signal says, or has moved and
 *               been found again. The row is updated in place and stays debt.
 *   STALE     - the passage cannot be found on one side. The signal stops
 *               being debt and waits for a rescan. It is NOT deleted: the
 *               reason a pair was noticed is worth keeping even when the
 *               evidence for it has to be recomputed.
 *   DELETED   - the paper is gone. Its whole pair goes `source_deleted`.
 *
 * Only PENDING signals are touched. An accepted signal already produced a
 * Claim, and that Claim's Evidence is maintained by the Evidence relinker,
 * which is the right owner - re-relocating it here would give one passage two
 * maintainers. A rejected signal is a judgement someone made about text that
 * existed; it is history, and history does not relocate.
 *
 * Algorithm and model versions are checked too, not just text. A signal
 * computed by `link-sem-v1` under one embedding model is not evidence about
 * what `link-sem-v2` under another model would find, and silently carrying it
 * forward would make an algorithm change invisible.
 */

import { hashWikiText } from "./wikiCanonicalizer";
import { locateChunk, type LocatableChunk } from "./wikiChunkLocator";
import type { WikiLinkStore } from "./wikiLinkStore";
import type { WikiLinkSignalWithPair } from "./wikiLinkTypes";

declare let ztoolkit: ZToolkit;

export interface WikiLinkRelinkReport {
  checked: number;
  valid: number;
  relocated: number;
  stale: number;
  sourceDeleted: number;
  supersededByAlgorithm: number;
}

export interface WikiLinkSignalSource {
  sourceExists(libraryID: number, itemKey: string): Promise<boolean>;
  getChunks(
    libraryID: number,
    itemKey: string,
  ): Promise<Array<LocatableChunk & { contentHash: string }>>;
  /** True once a body index exists, so an unmatched signal may be called stale. */
  indexReady(libraryID: number, itemKey: string): Promise<boolean>;
}

export interface WikiLinkAlgorithmIdentity {
  /** Current version for each signal type; a mismatch supersedes the signal. */
  algorithmVersions: Readonly<Record<string, string>>;
  /** Current embedding model. Only checked for semantic signals. */
  embeddingModel: string;
}

export class WikiLinkSignalRelinker {
  private readonly store: WikiLinkStore;
  private readonly source: WikiLinkSignalSource;
  private readonly identity: WikiLinkAlgorithmIdentity;

  constructor(
    store: WikiLinkStore,
    source: WikiLinkSignalSource,
    identity: WikiLinkAlgorithmIdentity,
  ) {
    this.store = store;
    this.source = source;
    this.identity = identity;
  }

  async relinkPending(
    options: { libraryID?: number; itemKeys?: string[] } = {},
  ): Promise<WikiLinkRelinkReport> {
    const signals = await this.store.pendingSignalsForRelink(
      options.libraryID,
      options.itemKeys,
    );
    const report: WikiLinkRelinkReport = {
      checked: signals.length,
      valid: 0,
      relocated: 0,
      stale: 0,
      sourceDeleted: 0,
      supersededByAlgorithm: 0,
    };
    const chunkCache = new Map<
      string,
      Array<LocatableChunk & { contentHash: string }> | null
    >();
    const deletedSources = new Set<string>();
    const staleIds: number[] = [];

    for (const signal of signals) {
      if (this.superseded(signal)) {
        staleIds.push(signal.signalId);
        report.supersededByAlgorithm += 1;
        continue;
      }
      let gone = false;
      let unresolved = false;
      let moved = false;

      for (const side of ["a", "b"] as const) {
        const itemKey = side === "a" ? signal.aItemKey : signal.bItemKey;
        const cacheKey = `${signal.libraryID}:${itemKey}`;
        if (deletedSources.has(cacheKey)) {
          gone = true;
          break;
        }
        if (!chunkCache.has(cacheKey)) {
          const exists = await this.source.sourceExists(
            signal.libraryID,
            itemKey,
          );
          if (!exists) {
            deletedSources.add(cacheKey);
            chunkCache.set(cacheKey, null);
          } else {
            chunkCache.set(
              cacheKey,
              await this.source.getChunks(signal.libraryID, itemKey),
            );
          }
        }
        const chunks = chunkCache.get(cacheKey);
        if (chunks === null) {
          gone = true;
          break;
        }
        if (!chunks?.length) {
          // The index is mid-rebuild. Not stale, not valid: leave the signal
          // alone and check again next time, exactly as the Evidence relinker
          // treats a document whose chunks have not come back yet.
          unresolved = true;
          break;
        }
        const ready = await this.source.indexReady(signal.libraryID, itemKey);
        if (!ready) {
          unresolved = true;
          break;
        }
        const anchor = side === "a" ? signal.a : signal.b;
        const match = await locateChunk(
          anchor.chunkTextHash,
          anchor.excerpt,
          chunks,
        );
        if (!match) {
          unresolved = false;
          gone = false;
          moved = false;
          staleIds.push(signal.signalId);
          report.stale += 1;
          unresolved = true;
          break;
        }
        if (
          match.kind === "relocated" ||
          match.chunk.chunkId !== anchor.chunkIdSnapshot
        ) {
          await this.relocate(signal.signalId, side, match.chunk);
          moved = true;
        }
      }

      if (gone) {
        report.sourceDeleted += 1;
        continue;
      }
      if (unresolved) continue;
      if (moved) report.relocated += 1;
      else report.valid += 1;
    }

    if (staleIds.length) await this.store.markSignalsStale(staleIds);
    for (const cacheKey of deletedSources) {
      const separator = cacheKey.indexOf(":");
      const libraryID = Number(cacheKey.slice(0, separator));
      const itemKey = cacheKey.slice(separator + 1);
      await this.store.markSourceDeleted(libraryID, itemKey);
    }
    ztoolkit.log(
      `[wiki] link signal relink: checked=${report.checked} valid=${report.valid} ` +
        `relocated=${report.relocated} stale=${report.stale} ` +
        `deleted=${report.sourceDeleted} superseded=${report.supersededByAlgorithm}`,
    );
    return report;
  }

  /**
   * Was this signal produced by an algorithm or model that is no longer current?
   *
   * A superseded signal is marked stale rather than deleted, so
   * `wiki_status` can report how many candidates an upgrade invalidated -
   * which is the number that tells someone whether a rescan is worth running.
   */
  private superseded(signal: WikiLinkSignalWithPair): boolean {
    const expected = this.identity.algorithmVersions[signal.signalType];
    if (expected && signal.algorithmVersion !== expected) return true;
    if (
      signal.signalType === "semantic" &&
      this.identity.embeddingModel &&
      signal.sourceModel &&
      signal.sourceModel !== this.identity.embeddingModel
    ) {
      return true;
    }
    return false;
  }

  private async relocate(
    signalId: number,
    side: "a" | "b",
    chunk: LocatableChunk & { contentHash: string },
  ): Promise<void> {
    await this.store.relocateSignalSide(signalId, side, {
      chunkIdSnapshot: chunk.chunkId,
      chunkTextHash: await hashWikiText(chunk.text),
    });
  }
}
