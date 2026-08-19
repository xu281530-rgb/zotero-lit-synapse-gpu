import { getStoredChunkingSignature } from "../hybridSearchSettings";
import { bodyIndexStateFromSourceKind } from "../semantic/bodyIndexState";
import { getEmbeddingService } from "../semantic/embeddingService";
import { getVectorStore } from "../semantic/vectorStore";
import {
  hashWikiText,
  normalizeWikiName,
  normalizeWikiText,
} from "./wikiCanonicalizer";
import { WikiEvidenceRelinker } from "./wikiEvidenceRelinker";
import { renderWikiMarkdown } from "./wikiRenderer";
import { WikiRetriever } from "./wikiRetriever";
import { getWikiStore, type WikiStore } from "./wikiStore";
import {
  WIKI_READ_DEPTHS,
  type WikiCoverageLevel,
  type WikiCommitAction,
  type WikiCommitInput,
  type WikiCommitResult,
  type WikiEvidenceInput,
  type WikiSourceChunk,
} from "./wikiTypes";

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

export interface WikiServiceSearchResult {
  claims: any[];
  documents: any[];
  relations: any[];
  directCount: number;
  oneHopCount: number;
  vectorSearchUsed: boolean;
  warnings: string[];
}

function clampCoverageToVerifiedEvidence(
  coverageLevel: WikiCoverageLevel,
  evidence: WikiEvidenceInput[],
): WikiCoverageLevel {
  const requestedDepth = WIKI_READ_DEPTHS.findIndex(
    (depth) => depth === coverageLevel,
  );
  if (requestedDepth < 0 || !evidence.length) return coverageLevel;

  let verifiedDepth = evidence.reduce((best, entry) => {
    const depth = WIKI_READ_DEPTHS.indexOf(entry.readDepth);
    return Math.max(best, depth);
  }, 0);
  if (coverageLevel === "cross_paper") {
    const crossPaperSources = new Set(
      evidence
        .filter((entry) => entry.readDepth === "cross_paper")
        .map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    if (crossPaperSources.size < 2) {
      verifiedDepth = evidence.reduce((best, entry) => {
        const depth = WIKI_READ_DEPTHS.indexOf(entry.readDepth);
        return Math.max(best, Math.min(depth, 2));
      }, 0);
    }
  }
  return WIKI_READ_DEPTHS[Math.min(requestedDepth, verifiedDepth)];
}

export class WikiService {
  private readonly store: WikiStore;
  private readonly retriever: WikiRetriever;
  private readonly prepareTokens = new Map<
    string,
    {
      libraryID: number;
      expiresAt: number;
      preparedPageTitles: Set<string>;
    }
  >();

  constructor(store: WikiStore = getWikiStore()) {
    this.store = store;
    this.retriever = new WikiRetriever(store);
  }

  private prunePrepareTokens(): void {
    const now = Date.now();
    for (const [token, prepared] of this.prepareTokens) {
      if (prepared.expiresAt < now) this.prepareTokens.delete(token);
    }
  }

  async prepareUpdate(options: {
    libraryID: number;
    query: string;
    limit?: number;
    proposedPageTitles?: string[];
  }): Promise<any> {
    this.prunePrepareTokens();
    const exactCandidates = await this.store.prepareUpdate(options);
    const semanticCandidates = await this.search({
      ...options,
      minScore: 0,
      useVector: true,
    });
    const proposedPageTitles = Array.from(
      new Set(
        (options.proposedPageTitles?.length
          ? options.proposedPageTitles
          : [options.query]
        )
          .map((title) => normalizeWikiText(title))
          .filter(Boolean),
      ),
    );
    if (proposedPageTitles.length > 2) {
      throw new Error(
        "wiki_prepare_update accepts at most 2 proposed Page titles",
      );
    }
    const pagePreparations = [];
    for (const title of proposedPageTitles) {
      if (normalizeWikiName(title) === normalizeWikiName(options.query)) {
        pagePreparations.push({
          canonicalTitle: title,
          ...exactCandidates,
          semanticClaims: semanticCandidates.claims.slice(
            0,
            options.limit ?? 10,
          ),
        });
        continue;
      }
      const [exact, semantic] = await Promise.all([
        this.store.prepareUpdate({ ...options, query: title }),
        this.search({
          ...options,
          query: title,
          minScore: 0,
          useVector: true,
        }),
      ]);
      pagePreparations.push({
        canonicalTitle: title,
        ...exact,
        semanticClaims: semantic.claims.slice(0, options.limit ?? 10),
      });
    }
    const prepareToken = `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 14)}`;
    this.prepareTokens.set(prepareToken, {
      libraryID: options.libraryID,
      expiresAt: Date.now() + 10 * 60 * 1000,
      preparedPageTitles: new Set(proposedPageTitles.map(normalizeWikiName)),
    });
    return {
      ...exactCandidates,
      semanticClaims: semanticCandidates.claims.slice(0, options.limit ?? 10),
      semanticWarnings: semanticCandidates.warnings,
      searched: ["title", "alias", "concept", "claim", "embedding"],
      preparedPageTitles: proposedPageTitles,
      pagePreparations,
      prepareToken,
      prepareTokenExpiresInSeconds: 600,
    };
  }

  async getPage(pageId: number): Promise<any> {
    const page = await this.store.getPage(pageId);
    if (!page) return null;
    const snapshot = await this.store.getRetrievalSnapshot(page.libraryID);
    const concept =
      page.primaryConceptId == null
        ? null
        : (snapshot.concepts.find(
            (row) =>
              Number(row.concept_id ?? row.conceptId) === page.primaryConceptId,
          ) ?? null);
    const aliases =
      page.primaryConceptId == null
        ? []
        : snapshot.aliases.filter(
            (row) =>
              Number(row.concept_id ?? row.conceptId) === page.primaryConceptId,
          );
    const relations =
      page.primaryConceptId == null
        ? []
        : snapshot.relations.filter(
            (row) =>
              Number(row.source_concept_id ?? row.sourceConceptId) ===
                page.primaryConceptId ||
              Number(row.target_concept_id ?? row.targetConceptId) ===
                page.primaryConceptId,
          );
    return { ...page, primaryConcept: concept, aliases, relations };
  }

  private async hydrateEvidence(
    entry: any,
    libraryID: number,
  ): Promise<WikiEvidenceInput> {
    if (Number(entry.libraryID ?? libraryID) !== libraryID) {
      throw new Error("Evidence must belong to the Wiki page's library");
    }
    const itemKey = String(entry.itemKey ?? "").trim();
    if (!itemKey) throw new Error("Evidence itemKey is required");
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
    if (!item || item.deleted || !item.isRegularItem?.()) {
      throw new Error(
        `Evidence source ${libraryID}:${itemKey} is missing or is not a Zotero document`,
      );
    }
    const vectorStore = getVectorStore();
    await vectorStore.initialize();
    const chunks = await vectorStore.getChunksForItem(itemKey, libraryID);
    if (!chunks.length) {
      throw new Error(
        `Evidence source ${itemKey} has no indexed chunks; build the search index first`,
      );
    }
    const excerpt = normalizeWikiText(String(entry.excerpt ?? ""));
    if (!excerpt) throw new Error("Evidence excerpt is required");
    let chunk = chunks.find(
      (candidate) => candidate.chunkId === Number(entry.chunkIdSnapshot),
    );
    if (!chunk || !normalizeWikiText(chunk.text).includes(excerpt)) {
      chunk = chunks.find((candidate) =>
        normalizeWikiText(candidate.text).includes(excerpt),
      );
    }
    if (!chunk) {
      throw new Error(
        `Evidence excerpt could not be verified in ${itemKey}'s indexed chunks`,
      );
    }
    const status = await vectorStore.getIndexStatus(itemKey, libraryID);
    const bodyState = bodyIndexStateFromSourceKind(status?.sourceKind);
    const resetGeneration = await vectorStore.getCommittedResetGeneration();
    return {
      libraryID,
      itemKey,
      chunkIdSnapshot: chunk.chunkId,
      chunkTextHash: await hashWikiText(chunk.text),
      sourceContentHash: status?.contentHash || "unknown",
      sourceChunkSignature: getStoredChunkingSignature(libraryID) || "unknown",
      sourceResetGeneration: resetGeneration || "none",
      excerpt,
      evidenceRole: entry.evidenceRole,
      readDepth: bodyState === "body" ? entry.readDepth : "chunk_local",
      readDepthCeiling: bodyState === "body" ? undefined : "chunk_local",
    };
  }

  private async hydrateActions(
    actions: WikiCommitAction[],
    libraryID: number,
  ): Promise<WikiCommitAction[]> {
    const hydrated: WikiCommitAction[] = [];
    for (const action of actions) {
      if (
        action.action !== "ADD_CLAIM" &&
        action.action !== "ATTACH_EVIDENCE" &&
        action.action !== "MARK_CONFLICT" &&
        !(action.action === "UPDATE_CLAIM" && action.evidence?.length)
      ) {
        hydrated.push(action);
        continue;
      }
      const evidence: WikiEvidenceInput[] = [];
      for (const entry of action.evidence ?? []) {
        evidence.push(await this.hydrateEvidence(entry, libraryID));
      }
      if (action.action === "ADD_CLAIM") {
        hydrated.push({
          ...action,
          coverageLevel: clampCoverageToVerifiedEvidence(
            action.coverageLevel,
            evidence,
          ),
          evidence,
        } as WikiCommitAction);
      } else if (action.action === "UPDATE_CLAIM" && action.coverageLevel) {
        hydrated.push({
          ...action,
          coverageLevel: clampCoverageToVerifiedEvidence(
            action.coverageLevel,
            evidence,
          ),
          evidence,
        } as WikiCommitAction);
      } else {
        hydrated.push({ ...action, evidence } as WikiCommitAction);
      }
    }
    return hydrated;
  }

  private async updateDerivedEmbeddings(claimIds: number[]): Promise<string[]> {
    const warnings: string[] = [];
    for (const claimId of claimIds) {
      const claim = await this.store.getClaim(claimId);
      if (!claim) continue;
      try {
        const embeddingService = getEmbeddingService();
        const embeddingModel = embeddingService.getConfig().model;
        const embedded = await embeddingService.embed(
          claim.claimText,
          "auto",
          false,
        );
        await this.store.saveClaimEmbedding({
          claimId,
          vector: embedded.embedding,
          model: embeddingModel,
          textHash: await hashWikiText(claim.claimText),
        });
      } catch (error) {
        warnings.push(
          `Claim ${claimId} was committed, but its derived embedding could not be updated: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return warnings;
  }

  async commit(
    input: WikiCommitInput,
  ): Promise<WikiCommitResult & { warnings: string[] }> {
    this.prunePrepareTokens();
    if (input.actions.some((action) => action.action === "CREATE_PAGE")) {
      const prepared = input.prepareToken
        ? this.prepareTokens.get(input.prepareToken)
        : undefined;
      if (
        !prepared ||
        prepared.libraryID !== input.libraryID ||
        prepared.expiresAt < Date.now()
      ) {
        throw new Error(
          "CREATE_PAGE requires a current wiki_prepare_update token for this library",
        );
      }
      for (const action of input.actions) {
        if (
          action.action === "CREATE_PAGE" &&
          !prepared.preparedPageTitles.has(
            normalizeWikiName(action.canonicalTitle),
          )
        ) {
          throw new Error(
            `CREATE_PAGE requires its prepared Page title: ${action.canonicalTitle}`,
          );
        }
      }
      this.prepareTokens.delete(input.prepareToken!);
    }
    const actions = await this.hydrateActions(input.actions, input.libraryID);
    const result = await this.store.commit({ ...input, actions });
    const warnings = await this.updateDerivedEmbeddings(
      result.affectedClaimIds,
    );
    return { ...result, warnings };
  }

  async search(options: {
    libraryID: number;
    query: string;
    keywords?: string[];
    itemKeys?: string[];
    minScore?: number;
    limit?: number | null;
    useVector?: boolean;
  }): Promise<WikiServiceSearchResult> {
    const warnings: string[] = [];
    let queryVector: Float32Array | undefined;
    let queryVectorModel: string | undefined;
    if (options.useVector !== false) {
      try {
        const embeddingService = getEmbeddingService();
        queryVectorModel = embeddingService.getConfig().model;
        queryVector = (
          await embeddingService.embed(options.query, "auto", true)
        ).embedding;
      } catch (error) {
        warnings.push(
          `Wiki vector search unavailable; Concept/Alias/Claim/Relation keyword retrieval still ran: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const result = await this.retriever.search({
      ...options,
      queryVector,
      queryVectorModel,
    });
    return { ...result, vectorSearchUsed: Boolean(queryVector), warnings };
  }

  async reverify(libraryID?: number, itemKeys?: string[]): Promise<any> {
    const vectorStore = getVectorStore();
    await vectorStore.initialize();
    const deletedSources = await this.store.listDeletedEvidenceSources(
      libraryID,
      itemKeys,
    );
    for (const source of deletedSources) {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        source.libraryID,
        source.itemKey,
      );
      if (item && !item.deleted && item.isRegularItem?.()) {
        await this.store.markItemsPending(
          `restored-${Date.now()}`,
          source.libraryID,
          [source.itemKey],
        );
      }
    }
    const relinker = new WikiEvidenceRelinker(this.store, {
      sourceExists: async (sourceLibraryID, itemKey) => {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          sourceLibraryID,
          itemKey,
        );
        return Boolean(item && !item.deleted && item.isRegularItem?.());
      },
      getChunks: async (
        sourceLibraryID,
        itemKey,
      ): Promise<WikiSourceChunk[]> => {
        const [chunks, status, generation] = await Promise.all([
          vectorStore.getChunksForItem(itemKey, sourceLibraryID),
          vectorStore.getIndexStatus(itemKey, sourceLibraryID),
          vectorStore.getCommittedResetGeneration(),
        ]);
        return chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          text: chunk.text,
          contentHash: status?.contentHash || "unknown",
          chunkSignature:
            getStoredChunkingSignature(sourceLibraryID) || "unknown",
          resetGeneration: generation || "none",
        }));
      },
      indexReadyForRelink: async (sourceLibraryID, itemKey) => {
        const status = await vectorStore.getIndexStatus(
          itemKey,
          sourceLibraryID,
        );
        return bodyIndexStateFromSourceKind(status?.sourceKind) === "body";
      },
    });
    return relinker.relinkPending({ libraryID, itemKeys });
  }

  async exportMarkdown(libraryID: number): Promise<string> {
    const [pages, snapshot] = await Promise.all([
      this.store.listPages(libraryID),
      this.store.getRetrievalSnapshot(libraryID),
    ]);
    return renderWikiMarkdown(pages, snapshot);
  }

  async buildFromPaper(options: {
    libraryID: number;
    userRequested: boolean;
    itemKey?: string;
    doi?: string;
    url?: string;
    title?: string;
    includeAllChunks?: boolean;
  }): Promise<any> {
    if (options.userRequested !== true) {
      throw new Error(
        "wiki_build_from_paper is allowed only after an explicit user request",
      );
    }
    const selectors = [
      options.itemKey,
      options.doi,
      options.url,
      options.title,
    ].filter((value) => typeof value === "string" && value.trim());
    if (selectors.length !== 1) {
      throw new Error(
        "Specify exactly one target paper: itemKey, DOI, URL, or title",
      );
    }
    let item: any = null;
    if (options.itemKey) {
      item = await Zotero.Items.getByLibraryAndKeyAsync(
        options.libraryID,
        options.itemKey.trim(),
      );
    } else {
      const search = new Zotero.Search();
      search.libraryID = options.libraryID;
      if (options.doi) search.addCondition("DOI", "is", options.doi.trim());
      if (options.url) search.addCondition("url", "is", options.url.trim());
      if (options.title)
        search.addCondition("title", "contains", options.title.trim());
      const ids = await search.search();
      const matches = (Zotero.Items.get(ids) as any[]).filter(
        (candidate) => candidate?.isRegularItem?.() && !candidate.deleted,
      );
      if (matches.length !== 1) {
        throw new Error(
          `Target paper selector resolved to ${matches.length} Zotero items; use itemKey to disambiguate`,
        );
      }
      item = matches[0];
    }
    if (!item || item.deleted || !item.isRegularItem?.()) {
      throw new Error(
        "The explicitly selected target is not an available Zotero document",
      );
    }
    const vectorStore = getVectorStore();
    await vectorStore.initialize();
    const [chunks, indexStatus] = await Promise.all([
      vectorStore.getChunksForItem(item.key, options.libraryID),
      vectorStore.getIndexStatus(item.key, options.libraryID),
    ]);
    const bodyState = bodyIndexStateFromSourceKind(indexStatus?.sourceKind);
    if (bodyState !== "body") {
      throw new Error(
        `The selected paper has only metadata/abstract chunks or its body-text index is not confirmed (index state: ${bodyState}); successfully build its body search index first`,
      );
    }
    if (!chunks.length)
      throw new Error(
        "The selected paper has no indexed chunks; build its search index first",
      );
    const existing = await this.store.prepareUpdate({
      libraryID: options.libraryID,
      query: String(item.getField("title") || item.key),
      limit: 20,
    });
    return {
      explicitUserRequestVerified: true,
      target: {
        libraryID: options.libraryID,
        itemKey: item.key,
        title: String(item.getField("title") || ""),
        doi: String(item.getField("DOI") || ""),
        url: String(item.getField("url") || ""),
      },
      chunkCount: chunks.length,
      coverageInstruction:
        "Only claim paper_reviewed after actually reading every ordered chunk. Otherwise submit the chunks used and mark chunk_local, section_read, partial, or incomplete.",
      chunks: options.includeAllChunks ? chunks : chunks.slice(0, 1),
      chunksTruncated: !options.includeAllChunks && chunks.length > 1,
      nextStep: options.includeAllChunks
        ? "Analyze these chunks, call wiki_prepare_update, then submit only controlled actions to wiki_commit."
        : "Read the complete document with get_document_chunks in order before claiming paper_reviewed, then call wiki_prepare_update and wiki_commit.",
      existingWikiCandidates: existing,
    };
  }

  getStore(): WikiStore {
    return this.store;
  }
}

let singleton: WikiService | null = null;

export function getWikiService(): WikiService {
  singleton ??= new WikiService();
  return singleton;
}

export function resetWikiService(): void {
  singleton = null;
}
