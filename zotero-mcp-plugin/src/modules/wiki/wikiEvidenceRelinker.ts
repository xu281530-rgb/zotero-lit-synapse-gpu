import { hashWikiText, normalizeWikiName } from "./wikiCanonicalizer";
import type { WikiEvidenceSource, WikiSourceChunk } from "./wikiTypes";
import type { WikiStore } from "./wikiStore";

export interface WikiRelinkReport {
  checked: number;
  relinked: number;
  pending: number;
  stale: number;
  sourceDeleted: number;
}

function tokenOverlap(excerpt: string, text: string): number {
  const needle = normalizeWikiName(excerpt);
  const haystack = normalizeWikiName(text);
  if (!needle || !haystack) return 0;
  if (haystack.includes(needle)) return 1;
  const grams = (value: string): Set<string> => {
    const output = new Set<string>();
    for (let index = 0; index + 2 <= value.length; index += 1) {
      output.add(value.slice(index, index + 2));
    }
    return output;
  };
  const left = grams(needle);
  const right = grams(haystack);
  let common = 0;
  for (const gram of left) if (right.has(gram)) common += 1;
  return left.size ? common / left.size : 0;
}

export class WikiEvidenceRelinker {
  private readonly store: WikiStore;
  private readonly source: WikiEvidenceSource;

  constructor(store: WikiStore, source: WikiEvidenceSource) {
    this.store = store;
    this.source = source;
  }

  private async chooseChunk(
    chunkTextHash: string,
    excerpt: string,
    chunks: WikiSourceChunk[],
  ): Promise<WikiSourceChunk | null> {
    for (const chunk of chunks) {
      if ((await hashWikiText(chunk.text)) === chunkTextHash) return chunk;
    }
    let best: { chunk: WikiSourceChunk; score: number } | null = null;
    for (const chunk of chunks) {
      const score = tokenOverlap(excerpt, chunk.text);
      if (!best || score > best.score) best = { chunk, score };
    }
    return best && best.score >= 0.72 ? best.chunk : null;
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
