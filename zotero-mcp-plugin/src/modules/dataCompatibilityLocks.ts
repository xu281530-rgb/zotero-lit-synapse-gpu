import { getVectorStore } from "./semantic/vectorStore";
import { getWikiStore } from "./wiki/wikiStore";

export interface DataCompatibilityCounts {
  semanticVectors: number;
  keywordDocuments: number;
  keywordChunks: number;
  wikiRows: number;
  wikiClaimEmbeddings: number;
}

export interface DataCompatibilityLocks {
  chunkLocked: boolean;
  embeddingIdentityLocked: boolean;
}

export function deriveDataCompatibilityLocks(
  counts: DataCompatibilityCounts,
): DataCompatibilityLocks {
  return {
    chunkLocked:
      counts.semanticVectors > 0 ||
      counts.keywordDocuments > 0 ||
      counts.keywordChunks > 0 ||
      counts.wikiRows > 0,
    embeddingIdentityLocked:
      counts.semanticVectors > 0 || counts.wikiClaimEmbeddings > 0,
  };
}

export async function getDataCompatibilityState(): Promise<
  DataCompatibilityCounts & DataCompatibilityLocks
> {
  const vectorStore = getVectorStore();
  await vectorStore.initialize();
  const [search, wiki] = await Promise.all([
    vectorStore.getPersistentIndexCounts(),
    getWikiStore().getStatus(),
  ]);
  const wikiClaimEmbeddings = Number(wiki.claimEmbeddings) || 0;
  const wikiRows = [
    wiki.pages,
    wiki.claims,
    wiki.concepts,
    wiki.aliases,
    wiki.relations,
    wiki.evidence,
    wiki.claimEmbeddings,
  ].reduce<number>((total, value) => total + (Number(value) || 0), 0);
  const counts = {
    semanticVectors: search.semanticVectors,
    keywordDocuments: search.keywordDocuments,
    keywordChunks: search.keywordChunks,
    wikiRows,
    wikiClaimEmbeddings,
  };
  return { ...counts, ...deriveDataCompatibilityLocks(counts) };
}
