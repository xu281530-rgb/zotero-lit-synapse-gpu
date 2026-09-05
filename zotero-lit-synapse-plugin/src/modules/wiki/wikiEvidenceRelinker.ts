import { hashWikiText } from "./wikiCanonicalizer";
import { locateChunk } from "./wikiChunkLocator";
import type { WikiEvidenceSource, WikiSourceChunk } from "./wikiTypes";
import type { WikiStore } from "./wikiStore";

export interface WikiRelinkReport {
  checked: number;
  relinked: number;
  pending: number;
  stale: number;
  sourceDeleted: number;
}

export class WikiEvidenceRelinker {
  private readonly store: WikiStore;
  private readonly source: WikiEvidenceSource;

  constructor(store: WikiStore, source: WikiEvidenceSource) {
    this.store = store;
    this.source = source;
  }

  /**
   * The chunk this Evidence now belongs to, or null.
   *
   * Delegates to the shared locator so that Evidence and link signals answer
   * "where did this passage go" the same way. They must: a library reindexed
   * once should not relocate a Claim's Evidence while leaving the candidate
   * signal that quoted the same paragraph pointing somewhere else.
   */
  private async chooseChunk(
    chunkTextHash: string,
    excerpt: string,
    chunks: WikiSourceChunk[],
  ): Promise<WikiSourceChunk | null> {
    const match = await locateChunk(chunkTextHash, excerpt, chunks);
    return match ? match.chunk : null;
  }

  async relinkPending(
    options: { libraryID?: number; itemKeys?: string[] } = {},
  ): Promise<WikiRelinkReport> {
    const evidence = await this.store.listEvidenceForRelink(
      options.libraryID,
      options.itemKeys,
    );
    const report: WikiRelinkReport = {
      checked: evidence.length,
      relinked: 0,
      pending: 0,
      stale: 0,
      sourceDeleted: 0,
    };
    const affectedEvidenceIds = evidence.map((item) => item.evidenceId);
    try {
      for (const item of evidence) {
        if (!(await this.source.sourceExists(item.libraryID, item.itemKey))) {
          await this.store.markSourceDeleted(item.libraryID, item.itemKey);
          report.sourceDeleted += 1;
          continue;
        }
        const chunks = await this.source.getChunks(
          item.libraryID,
          item.itemKey,
        );
        const indexReady = this.source.indexReadyForRelink
          ? await this.source.indexReadyForRelink(item.libraryID, item.itemKey)
          : chunks.length > 0;
        if (chunks.length === 0 || !indexReady) {
          report.pending += 1;
          continue;
        }
        const matched = await this.chooseChunk(
          item.chunkTextHash,
          item.excerpt,
          chunks,
        );
        if (!matched) {
          await this.store.updateEvidenceLink(
            item.evidenceId,
            {
              chunkIdSnapshot: item.chunkIdSnapshot,
              chunkTextHash: item.chunkTextHash,
              sourceContentHash: item.sourceContentHash,
              sourceChunkSignature: item.sourceChunkSignature,
              sourceResetGeneration: item.sourceResetGeneration,
              linkState: "stale",
            },
            { deferDerivedUpdates: true },
          );
          report.stale += 1;
          continue;
        }
        await this.store.updateEvidenceLink(
          item.evidenceId,
          {
            chunkIdSnapshot: matched.chunkId,
            chunkTextHash: await hashWikiText(matched.text),
            sourceContentHash: matched.contentHash,
            sourceChunkSignature: matched.chunkSignature,
            sourceResetGeneration: matched.resetGeneration,
            linkState: "valid",
          },
          { deferDerivedUpdates: true },
        );
        report.relinked += 1;
      }
    } finally {
      await this.store.finalizeEvidenceRelink(affectedEvidenceIds);
    }
    return report;
  }
}
