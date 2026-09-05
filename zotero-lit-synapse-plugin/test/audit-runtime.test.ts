/* runtimeIt registers ordinary tests while preserving native Zotero error details. */
/* eslint-disable mocha/no-setup-in-describe */
import { WikiStore } from "../src/modules/wiki/wikiStore";
import { WikiRetriever } from "../src/modules/wiki/wikiRetriever";
import { WikiService } from "../src/modules/wiki/wikiService";
import { hashWikiText } from "../src/modules/wiki/wikiCanonicalizer";
import { readDocumentChunks } from "../src/modules/documentChunks";
import { SharedQuery } from "../src/modules/semantic/sharedQuery";
import { StreamableMCPServer } from "../src/modules/streamableMCPServer";
import { runHybridSearch } from "../src/modules/hybridSearch";
import {
  EmbeddingService,
  getEmbeddingService,
} from "../src/modules/semantic/embeddingService";
import { requestSignal } from "../src/modules/requestCancellation";
import { getVectorStore } from "../src/modules/semantic/vectorStore";

describe("Audit regressions in real Zotero", function () {
  this.timeout(30000);
  let store: WikiStore;
  let db: any;
  let libraryID: number;
  let dbPath: string;
  let restartPath: string;
  const rpc = async (body: any) => {
    const response = await Zotero.HTTP.request(
      "POST",
      "http://127.0.0.1:23121/mcp",
      {
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        responseType: "text",
        successCodes: [200, 202, 204],
      },
    );
    return response.responseText ? JSON.parse(response.responseText) : null;
  };
  const outcomes: any[] = [];
  const runtimeIt = (title: string, run: () => Promise<void>) =>

    it(title, async function () {
      try {
        await run();
      } catch (error) {
        outcomes.push({
          title,
          error: String(error),
          originalError: String((error as any)?.originalError ?? ""),
          stack: (error as any)?.stack,
        });
        await IOUtils.writeUTF8(
          PathUtils.join(Zotero.DataDirectory.dir, "audit-results.json"),
          JSON.stringify(outcomes, null, 2),
        );
        throw error;
      }
    });

  before(async function () {
    libraryID = Zotero.Libraries.userLibraryID;
    restartPath = PathUtils.join(
      PathUtils.parent(PathUtils.parent(Zotero.DataDirectory.dir)),
      "audit-restart.sqlite",
    );
    (globalThis as any).ztoolkit = {
      log: (...args: any[]) => Zotero.debug(args.map(String).join(" ")),
    };
    dbPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      `audit-${Date.now()}.sqlite`,
    );
    db = new Zotero.DBConnection(dbPath);
    store = new WikiStore(db);
    await Promise.all([
      store.initialize(),
      store.initialize(),
      store.readingSessions(),
    ]);
  });

  afterEach(async function () {
    const test = this.currentTest as any;
    outcomes.push({
      title: test.title,
      state: test.state,
      error: test.err ? String(test.err) : null,
      stack: test.err?.stack,
    });
    await IOUtils.writeUTF8(
      PathUtils.join(Zotero.DataDirectory.dir, "audit-results.json"),
      JSON.stringify(outcomes, null, 2),
    );
  });

  after(async function () {
    await store.close();
  });

  it("recovers a pending receipt created by a previous Zotero process", async function () {
    if (!(await IOUtils.exists(restartPath))) this.skip();
    const persisted = new WikiStore(new Zotero.DBConnection(restartPath));
    try {
      const restarted: any = new WikiService(persisted);
      const status = await restarted.commitStatus(
        libraryID,
        "audit-durable-save",
      );
      assert.equal(status.status, "postprocessing_pending");
      restarted.hydrateActions = async () => {
        throw new Error("must not repeat main write after restart");
      };
      restarted.settleQuestionReading = async () => ({});
      restarted.pumpEmbeddingQueue = async () => ({});
      const result = await restarted.commit({
        libraryID,
        operationId: "audit-durable-save",
        resume: true,
        userInitiated: true,
        actions: [],
      });
      assert.equal(result.postprocessing.state, "completed");
      assert.equal(
        (await persisted.listPageTitles(libraryID)).filter(
          (page: any) => page.title === "Saved audit result",
        ).length,
        1,
      );
    } finally {
      await persisted.close();
    }
  });

  runtimeIt(
    "uses the actual Zotero SQLite rows without elevating another paper or duplicating claims",
    async function () {
      const evidence = async (
        itemKey: string,
        text: string,
        readDepth: any,
        chunkIdSnapshot: number,
      ) => ({
        libraryID,
        itemKey,
        chunkIdSnapshot,
        chunkTextHash: await hashWikiText(text),
        sourceContentHash: "audit",
        sourceChunkSignature: "audit",
        sourceResetGeneration: "audit",
        excerpt: text,
        evidenceRole: "SUPPORTS" as const,
        readDepth,
      });
      await store.commit({
        libraryID,
        userInitiated: true,
        actions: [
          {
            action: "CREATE_PAGE",
            ref: "page",
            canonicalTitle: "Audit solidification",
          },
          {
            action: "ADD_CLAIM",
            pageId: "page",
            claimText: "Audit solidification depends on thermal gradient.",
            claimType: "mechanism",
            epistemicStatus: "provisional",
            coverageLevel: "chunk_local",
            confidence: 0.7,
            evidence: [
              await evidence(
                "AUDIT001",
                "First complete paper establishes thermal effects.",
                "paper_reviewed",
                0,
              ),
              await evidence(
                "AUDIT002",
                "Second paper provides a local supporting passage.",
                "chunk_local",
                0,
              ),
              await evidence(
                "AUDIT002",
                "Another local passage explains the same effect.",
                "chunk_local",
                1,
              ),
            ],
          },
        ],
      });
      const result = await new WikiRetriever(store).search({
        libraryID,
        query: "solidification",
      });
      const second = result.documents.find(
        (row) => row.itemKey === "AUDIT002",
      )!;
      assert.equal(second.readDepth, "chunk_local");
      assert.equal(second.wikiClaims.length, 1);
      assert.equal(second.wikiClaims[0].evidence.length, 2);
      assert.equal(second.wikiClaims[0].readDepth, "chunk_local");
      assert.doesNotThrow(() => JSON.stringify(result));
      const scoped = await store.getRetrievalSnapshot(libraryID, {
        itemKeys: ["AUDIT002"],
        includeEmbeddings: false,
      });
      assert.equal(scoped.claims.length, 1);
      assert.equal(scoped.evidence.length, 3);
      const empty = await store.getRetrievalSnapshot(libraryID, {
        itemKeys: ["NOAUDIT1"],
      });
      assert.equal(empty.claims.length, 0);
      const first = result.documents.find((row) => row.itemKey === "AUDIT001")!;
      const oldEvidence = first.wikiClaims[0].evidence[0];
      await store.updateEvidenceLink(oldEvidence.evidenceId, {
        ...oldEvidence,
        sourceContentHash: "changed-content",
        linkState: "valid",
      });
      const relinked = await new WikiRetriever(store).search({
        libraryID,
        query: "solidification",
      });
      assert.equal(
        relinked.documents.find((row) => row.itemKey === "AUDIT001")?.readDepth,
        "chunk_local",
      );
    },
  );

  it("invalidates same-length changed reading and persists the revision after reopening SQLite", async function () {
    const sessions = await store.readingSessions();
    const first = await sessions.startOrContinue({
      libraryID,
      itemKey: "VERSION1",
      title: "Audit",
      totalChunks: 2,
      mode: "qa",
      sourceVersion: "old",
    });
    await sessions.recordDelivery(first.sessionId, [
      { chunkIndex: 0, chunkId: 0 },
    ]);
    const next = await sessions.startOrContinue({
      libraryID,
      itemKey: "VERSION1",
      title: "Audit",
      totalChunks: 2,
      mode: "qa",
      sourceVersion: "new",
    });
    assert.equal(next.sourceVersion, "new");
    assert.equal((await sessions.coverage(next.sessionId)).deliveredChunks, 0);
    assert.equal((await sessions.get(next.sessionId))?.sourceVersion, "new");
    await store.close();
    db = new Zotero.DBConnection(dbPath);
    store = new WikiStore(db);
    await store.initialize();
    assert.equal(
      (await (await store.readingSessions()).get(next.sessionId))
        ?.sourceVersion,
      "new",
    );
  });

  it("rejects a reading bookmark after text changes and rejects a conflicting library", async function () {
    let chunks = ["A", "B", "C"].map((text, chunkId) => ({ text, chunkId }));
    const deps = {
      getChunks: async () => chunks,
      getFullTextAvailability: async () => "indexed" as const,
      getTitle: async () => "Audit",
    };
    const first = await readDocumentChunks(
      { itemKey: "VERSION1", limit: 1 },
      deps,
      libraryID,
    );
    const cursor = first.pagination.nextCursor;
    const next = await readDocumentChunks({ cursor }, deps, libraryID);
    assert.equal(next.data[0].text, "B");
    chunks = ["A", "changed", "C"].map((text, chunkId) => ({ text, chunkId }));
    try {
      await readDocumentChunks({ cursor }, deps, libraryID);
      assert.fail("stale cursor accepted");
    } catch (error) {
      assert.match(String(error), /document changed/);
    }
    try {
      await readDocumentChunks(
        { cursor, libraryID: libraryID + 1 },
        deps,
        libraryID,
      );
      assert.fail("conflict accepted");
    } catch (error) {
      assert.match(String(error), /different libraries/);
    }
  });

  runtimeIt(
    "keeps a committed SQLite write successful when later bookkeeping fails",
    async function () {
      const service: any = new WikiService(store);
      service.assertRequiredReconciliationActions = async () => undefined;
      service.readWriteOffs = async () => [];
      service.assertLinkSignalsAnswered = async () => undefined;
      service.assertQuestionTerminologyRecorded = async () => undefined;
      service.hydrateActions = async () => ({
        actions: [
          { action: "CREATE_PAGE", canonicalTitle: "Saved audit result" },
        ],
        warnings: [],
      });
      service.settleQuestionReading = async () => {
        throw new Error("audit injected ledger failure");
      };
      service.pumpEmbeddingQueue = async () => ({
        processed: 0,
        succeeded: 0,
        failed: 0,
      });
      const result = await service.commit({
        libraryID,
        userInitiated: true,
        actions: [],
        operationId: "audit-durable-save",
      });
      assert.isTrue(result.committed);
      assert.isTrue(
        (await store.listPageTitles(libraryID)).some(
          (page: any) => page.title === "Saved audit result",
        ),
      );
      assert.isTrue(
        result.warnings.some((warning: string) =>
          warning.includes("already saved"),
        ),
      );
      assert.equal(
        (await service.commitStatus(libraryID, "audit-durable-save")).status,
        "postprocessing_pending",
      );
      await store.close();
      await IOUtils.copy(dbPath, restartPath);
      db = new Zotero.DBConnection(dbPath);
      store = new WikiStore(db);
      await store.initialize();
      const restarted: any = new WikiService(store);
      let recoveries = 0;
      restarted.hydrateActions = async () => {
        throw new Error("saved main write must never repeat");
      };
      restarted.settleQuestionReading = async () => {
        recoveries++;
        return {};
      };
      restarted.pumpEmbeddingQueue = async () => ({});
      const resumed = await restarted.commit({
        libraryID,
        userInitiated: true,
        operationId: "audit-durable-save",
        resume: true,
        actions: [],
      });
      assert.equal(
        resumed.postprocessing.state,
        "completed",
        JSON.stringify(resumed),
      );
      await restarted.commit({
        libraryID,
        userInitiated: true,
        operationId: "audit-durable-save",
        resume: true,
        actions: [],
      });
      assert.equal(recoveries, 1);
      assert.equal(
        (await store.listPageTitles(libraryID)).filter(
          (page: any) => page.title === "Saved audit result",
        ).length,
        1,
      );
    },
  );

  it("shares concurrent queries without letting one cancelled caller stop another", async function () {
    const shared = new SharedQuery<number>();
    const controller = new AbortController();
    let calls = 0;
    let release: (value: number) => void = () => undefined;
    const work = async (signal: AbortSignal) => {
      calls++;
      const value = await new Promise<number>((resolve) => {
        release = resolve;
      });
      assert.isFalse(signal.aborted);
      return value;
    };
    const first = shared
      .run("same", work, controller.signal)
      .catch(() => "cancelled");
    const second = shared.run("same", work);
    await Zotero.Promise.delay(0);
    controller.abort();
    release(42);
    assert.equal(await first, "cancelled");
    assert.equal(await second, 42);
    assert.equal(calls, 1);
  });

  it("returns recoverable MCP tool errors and keeps valid active Wiki results", async function () {
    const server: any = new StreamableMCPServer();
    const response = await server.processRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_document_chunks",
        arguments: { itemKey: "AUDITBAD", libraryID },
      },
    });
    assert.isUndefined(response.error);
    assert.isTrue(response.result.isError);
    const result = await runHybridSearch(
      {
        query: "audit",
        topK: 2,
        rrfK: 60,
        keywordWeight: 1,
        semanticWeight: 1,
        wikiWeight: 1,
        wikiShadowMode: false,
      },
      {
        keywordSearch: async () => {
          throw new Error("keyword failed");
        },
        semanticSearch: async () => {
          throw new Error("semantic failed");
        },
        wikiSearch: async () => [
          {
            itemKey: "AUDIT001",
            libraryID,
            normalizedWikiScore: 1,
            evidenceConfidence: 0.8,
            readDepth: "chunk_local",
            epistemicStatus: "provisional",
          },
        ],
      },
    );
    assert.equal(result.results[0].itemKey, "AUDIT001");
    assert.isTrue(result.degraded);
  });

  runtimeIt(
    "serves recoverable tool errors over the installed addon's real HTTP transport",
    async function () {
      const response = await rpc({
        jsonrpc: "2.0",
        id: "audit-http",
        method: "tools/call",
        params: {
          name: "get_document_chunks",
          arguments: { itemKey: "AUDITBAD", libraryID },
        },
      });
      assert.isUndefined(response.error);
      assert.isTrue(response.result.isError);
      const unknown = await rpc({
        jsonrpc: "2.0",
        id: "audit-unknown",
        method: "tools/call",
        params: { name: "audit_unknown", arguments: {} },
      });
      assert.equal(unknown.error.code, -32602);
    },
  );

  runtimeIt(
    "cancels an installed addon request via a real HTTP notification",
    async function () {
      const server = (Zotero as any).ZoteroLitSynapse.data.httpServer.mcpServer;
      const original = server.handleToolCall;
      let entered = false;
      let aborted = false;
      server.handleToolCall = async (request: any) => {
        if (request.id !== "audit-cancel")
          return original.call(server, request);
        entered = true;
        const signal = requestSignal(request.params.arguments);
        // The installed bundle owns its own symbol; discover it on the injected args.
        const installedSignal =
          signal ??
          Object.getOwnPropertySymbols(request.params.arguments)
            .map((key) => request.params.arguments[key])
            .find((value) => value?.addEventListener);
        assert.exists(
          installedSignal,
          "installed addon must supply a cancellation signal",
        );
        await new Promise<void>((resolve) =>
          installedSignal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        return { jsonrpc: "2.0", id: request.id, result: { content: [] } };
      };
      try {
        const pending = rpc({
          jsonrpc: "2.0",
          id: "audit-cancel",
          method: "tools/call",
          params: { name: "wiki_search", arguments: { query: "audit" } },
        });
        for (let i = 0; i < 100 && !entered; i++)
          await Zotero.Promise.delay(10);
        assert.isTrue(entered);
        await rpc({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "audit-cancel" },
        });
        const result = await pending;
        assert.exists(result.result, JSON.stringify(result));
        assert.isTrue(result.result.isError);
        assert.isTrue(aborted);
        assert.equal(server.activeReads.size, 0);
      } finally {
        server.handleToolCall = original;
      }
    },
  );

  runtimeIt(
    "coalesces actual embedding HTTP calls and returns independent vector copies",
    async function () {
      const { HttpServer } = ChromeUtils.importESModule(
        "chrome://remote/content/server/httpd.sys.mjs",
      );
      const endpointServer = new HttpServer();
      let requests = 0;
      let failEmbedding = false;
      const endpoint = "/audit/v1/embeddings";
      endpointServer.registerPathHandler(
        endpoint,
        (_request: any, response: any) => {
          requests++;
          response.processAsync();
          void Zotero.Promise.delay(80).then(() => {
            response.setHeader("Content-Type", "application/json", false);
            if (failEmbedding) {
              response.setStatusLine(null, 400, "Bad Request");
              response.write(
                JSON.stringify({
                  error: { message: "audit embedding failure" },
                }),
              );
              response.finish();
              return;
            }
            response.write(
              JSON.stringify({
                data: [{ index: 0, embedding: [0.6, 0.8] }],
                usage: { total_tokens: 3 },
              }),
            );
            response.finish();
          });
        },
      );
      endpointServer.start(23125);
      const embedding = new EmbeddingService();
      await embedding.initialize();
      const previousConfig = embedding.getConfig();
      try {
        embedding.updateConfig({
          apiBase: `http://127.0.0.1:${endpointServer.identity.primaryPort}/audit/v1`,
          model: "audit",
          apiProvider: "openai",
          dimensions: 2,
        });
        const [a, b] = await Promise.all([
          embedding.embed("audit shared", "en", true),
          embedding.embed("audit shared", "en", true),
        ]);
        assert.equal(requests, 1);
        assert.equal(a.identity.model, "audit");
        assert.equal(a.identity.dimensions, 2);
        assert.isTrue(a.identity.queryMode);
        assert.equal(a.identity.inputHash, b.identity.inputHash);
        a.embedding[0] = 99;
        assert.closeTo(b.embedding[0], 0.6, 0.0001);
        await embedding.embed("audit shared", "en", true);
        assert.equal(requests, 1);
        const calls = await Promise.all(
          ["installed-a", "installed-b"].map((id) =>
            rpc({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: {
                name: "wiki_search",
                arguments: { query: "audit installed shared", libraryID },
              },
            }),
          ),
        );
        for (const response of calls) {
          assert.isUndefined(response.result.isError, JSON.stringify(response));
          const result = JSON.parse(response.result.content[0].text);
          assert.isTrue(result.vectorSearchUsed, JSON.stringify(result));
          assert.isEmpty(result.warnings);
        }
        assert.equal(
          requests,
          2,
          "the installed addon must also coalesce its two HTTP requests",
        );
        const shadow = await rpc({
          jsonrpc: "2.0",
          id: "audit-shadow",
          method: "tools/call",
          params: {
            name: "hybrid_search",
            arguments: {
              query: "audit shadow",
              keywords: ["audit"],
              domain: "testing",
              expertRole: "researcher",
              keywordWeight: 1,
              semanticWeight: 0,
              libraryID,
            },
          },
        });
        assert.isUndefined(shadow.result.isError, JSON.stringify(shadow));
        const shadowResult = JSON.parse(shadow.result.content[0].text);
        assert.equal(
          shadowResult.metadata.wikiRetrievalStatus,
          "skipped_shadow",
        );
        assert.isNull(shadowResult.metadata.wikiResultCount);
        assert.equal(
          requests,
          2,
          "shadow-only work must not send another embedding request",
        );
        const originalIdentity = { ...a.identity };
        const changing = embedding.embed("configuration switch", "en", false);
        while (requests < 3) await Zotero.Promise.delay(5);
        embedding.updateConfig({ model: "audit-new-model", dimensions: 3 });
        const oldVector = await changing;
        assert.equal(oldVector.identity.model, originalIdentity.model);
        assert.isUndefined(oldVector.identity.requestedDimensions);
        assert.isFalse(oldVector.identity.queryMode);
        const newVector = await embedding.embed(
          "configuration switch",
          "en",
          true,
        );
        assert.equal(newVector.identity.model, "audit-new-model");
        assert.isUndefined(newVector.identity.requestedDimensions);
        assert.equal(
          newVector.identity.dimensions,
          2,
          "actual output dimensions travel with the vector",
        );
        assert.equal(
          oldVector.identity.inputHash,
          newVector.identity.inputHash,
        );
        const shadowPref =
          "extensions.zotero.zotero-lit-synapse.wiki.shadowMode";
        const weightPref =
          "extensions.zotero.zotero-lit-synapse.wiki.rrfWeight";
        const oldShadow = Zotero.Prefs.get(shadowPref, true);
        const oldWeight = Zotero.Prefs.get(weightPref, true);
        try {
          failEmbedding = true;
          Zotero.Prefs.set(shadowPref, false, true);
          Zotero.Prefs.set(weightPref, "1", true);
          const failedWiki = await rpc({
            jsonrpc: "2.0",
            id: "audit-wiki-warning",
            method: "tools/call",
            params: {
              name: "hybrid_search",
              arguments: {
                query: "audit degraded wiki",
                keywords: ["audit"],
                domain: "testing",
                expertRole: "researcher",
                keywordWeight: 1,
                semanticWeight: 0,
                libraryID,
              },
            },
          });
          assert.isUndefined(
            failedWiki.result.isError,
            JSON.stringify(failedWiki),
          );
          const partial = JSON.parse(failedWiki.result.content[0].text);
          assert.isTrue(partial.metadata.degraded);
          assert.include(
            partial.metadata.warnings.join(" "),
            "Wiki vector search unavailable",
          );
        } finally {
          Zotero.Prefs.set(shadowPref, oldShadow, true);
          Zotero.Prefs.set(weightPref, oldWeight, true);
        }
      } finally {
        embedding.updateConfig(previousConfig);
        embedding.destroy();
        await endpointServer.stop();
      }
    },
  );

  runtimeIt(
    "loads the embedding model before cold Wiki retrieval and preserves vector failure warnings",
    async function () {
      const embedding: any = getEmbeddingService();
      const originals = {
        initialize: embedding.initialize,
        getConfig: embedding.getConfig,
        embed: embedding.embed,
      };
      let initialized = false;
      const service: any = new WikiService(store);
      let model: string | undefined;
      const retrieve = service.retriever.search.bind(service.retriever);
      service.retriever.search = async (options: any) => {
        model = options.queryVectorModel;
        return retrieve(options);
      };
      try {
        embedding.initialize = async () => {
          initialized = true;
        };
        embedding.getConfig = () => ({
          model: initialized ? "audit-cold" : "",
        });
        embedding.embed = async () => ({
          embedding: new Float32Array([1, 0]),
          identity: {
            model: "audit-generated-model",
            apiBase: "test",
            provider: "openai",
            dimensions: 2,
          },
        });
        await service.search({ libraryID, query: "solidification" });
        assert.equal(model, "audit-generated-model");
        embedding.embed = async () => {
          throw new Error("audit vector offline");
        };
        const degraded = await service.search({
          libraryID,
          query: "solidification",
        });
        assert.isFalse(degraded.vectorSearchUsed);
        assert.isAbove(degraded.documents.length, 0);
        assert.include(degraded.warnings.join(" "), "audit vector offline");
      } finally {
        Object.assign(embedding, originals);
      }
    },
  );

  runtimeIt(
    "persists source revisions on actual index mutations and reads only a page",
    async function () {
      const vectors = getVectorStore();
      await vectors.initialize();
      const write = async (text: string) =>
        vectors.replaceItemIndex({
          itemKey: "AUDITVER",
          libraryID,
          contentHash: "same-source-marker",
          contentLength: 10,
          sourceKind: "pdf",
          records: [0, 1, 2].map((chunkId) => ({
            itemKey: "AUDITVER",
            libraryID,
            chunkId,
            chunkText: chunkId === 1 ? text : `fixed ${chunkId}`,
            language: "en" as const,
            vector: new Float32Array([1, 0]),
          })),
        });
      await write("old");
      const first = await vectors.getDocumentChunkPage(
        "AUDITVER",
        libraryID,
        1,
        1,
      );
      assert.equal(first.totalChunks, 3);
      assert.equal(first.chunks.length, 1);
      assert.equal(first.chunks[0].text, "old");
      assert.equal(
        first.revision,
        await vectors.getDocumentRevision("AUDITVER", libraryID),
      );
      await write("new");
      const next = await vectors.getDocumentChunkPage(
        "AUDITVER",
        libraryID,
        1,
        1,
      );
      assert.equal(next.totalChunks, 3);
      assert.notEqual(first.revision, next.revision);
      assert.equal(next.chunks[0].text, "new");
    },
  );
});
