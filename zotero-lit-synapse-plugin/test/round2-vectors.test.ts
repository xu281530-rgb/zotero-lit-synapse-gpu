/* eslint-disable mocha/no-setup-in-describe */
import { VectorStore } from "../src/modules/semantic/vectorStore";
import {
  EmbeddingService,
  type EmbeddingIdentity,
} from "../src/modules/semantic/embeddingService";
import { WikiStore } from "../src/modules/wiki/wikiStore";
import { WikiRetriever } from "../src/modules/wiki/wikiRetriever";
import { hashWikiText } from "../src/modules/wiki/wikiCanonicalizer";

describe("Round two vectors in real Zotero", function () {
  this.timeout(30000);
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
          PathUtils.join(
            Zotero.DataDirectory.dir,
            "round2-vector-results.json",
          ),
          JSON.stringify(outcomes, null, 2),
        );
        throw error;
      }
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
      PathUtils.join(Zotero.DataDirectory.dir, "round2-vector-results.json"),
      JSON.stringify(outcomes, null, 2),
    );
  });

  runtimeIt(
    "persists service identity in native SQLite and excludes foreign or legacy Wiki and document vectors",
    async function () {
      const libraryID = Zotero.Libraries.userLibraryID;
      const identityA: EmbeddingIdentity = {
        provider: "openai",
        apiBase: "https://audit-a.invalid/v1",
        model: "shared-model",
        dimensions: 2,
        inputHash: "document",
        queryMode: false,
      };
      const identityB = {
        ...identityA,
        apiBase: "https://audit-b.invalid/v1",
        inputHash: "query",
        queryMode: true,
      };
      const wikiPath = PathUtils.join(
        Zotero.DataDirectory.dir,
        "round2-vector-wiki.sqlite",
      );
      const vectorPath = PathUtils.join(
        Zotero.DataDirectory.dir,
        "round2-vector-main.sqlite",
      );
      let wiki = new WikiStore(new Zotero.DBConnection(wikiPath));
      let vectorDB = new Zotero.DBConnection(vectorPath);
      const createVectorStore = async () => {
        const vectors: any = new VectorStore({
          registerProvider() {},
          isEnabled: () => false,
          getCpuFallbackPrecision: () => "int8",
          reportCpuPrecision() {},
          publishMutation: async () => {},
          fallback() {},
        } as any);
        vectors.db = vectorDB;
        await vectors.createTables();
        vectors.initialized = true;
        return vectors;
      };
      let vectors = await createVectorStore();
      try {
        const text = "Thermal gradients suppress interface instability.";
        const result = await wiki.commit({
          libraryID,
          userInitiated: true,
          actions: [
            {
              action: "CREATE_PAGE",
              ref: "p",
              canonicalTitle: "Round two identity",
              primaryConcept: { canonicalName: "solidification" },
            },
            {
              action: "ADD_CLAIM",
              ref: "c",
              pageId: "p",
              claimText: text,
              claimType: "mechanism",
              epistemicStatus: "provisional",
              coverageLevel: "chunk_local",
              confidence: 0.7,
              evidence: [
                {
                  libraryID,
                  itemKey: "R2VEC001",
                  chunkIdSnapshot: 0,
                  chunkTextHash: await hashWikiText(text),
                  excerpt: text,
                  evidenceRole: "SUPPORTS",
                  readDepth: "chunk_local",
                  sourceContentHash: "v1",
                  sourceChunkSignature: "v1",
                  sourceResetGeneration: "none",
                },
              ],
            },
          ],
        });
        await wiki.saveClaimEmbedding({
          claimId: result.refs.c,
          vector: new Float32Array([1, 0]),
          model: identityA.model,
          identity: identityA,
          textHash: await hashWikiText(text),
        });
        await vectors.insertVector({
          libraryID,
          itemKey: "R2VEC001",
          chunkId: 0,
          vector: new Float32Array([1, 0]),
          language: "en",
          chunkText: text,
          identity: identityA,
        });
        await wiki.close();
        await vectorDB.closeDatabase();
        wiki = new WikiStore(new Zotero.DBConnection(wikiPath));
        vectorDB = new Zotero.DBConnection(vectorPath);
        vectors = await createVectorStore();
        const query = {
          libraryID,
          query: "unrelatedxylophoneresearch",
          queryVector: new Float32Array([1, 0]),
          queryVectorModel: identityA.model,
          queryVectorIdentity: identityB,
          minScore: 0.9,
        };
        const mismatched = await new WikiRetriever(wiki).search(query);
        assert.isEmpty(mismatched.claims);
        assert.isNotEmpty(mismatched.warnings);
        const compatible = {
          ...identityA,
          queryMode: true,
          inputHash: "other-input",
        };
        const compatibleResult = await new WikiRetriever(wiki).search({
          ...query,
          queryVectorIdentity: compatible,
        });
        const snapshot = await wiki.getRetrievalSnapshot(libraryID);
        const blob = snapshot.embeddings[0].embedding;
        await IOUtils.writeUTF8(
          PathUtils.join(
            Zotero.DataDirectory.dir,
            "round2-vector-observation.json",
          ),
          JSON.stringify(
            {
              compatibleResult,
              blobType: Object.prototype.toString.call(blob),
              isArray: Array.isArray(blob),
              byteLength: blob?.byteLength,
              length: blob?.length,
              isUint8: blob instanceof Uint8Array,
              identity: snapshot.embeddings[0].embedding_identity,
            },
            null,
            2,
          ),
        );
        assert.lengthOf(
          compatibleResult.claims,
          1,
          "Native Wiki BLOB with compatible identity participates in scoring",
        );
        let failure: unknown;
        try {
          await vectors.search(query.queryVector, {
            libraryID,
            itemKeys: ["R2VEC001"],
            identity: identityB,
          });
        } catch (error) {
          failure = error;
        }
        assert.match(String(failure), /identity|space|rebuild/i);
        assert.lengthOf(
          await vectors.search(query.queryVector, {
            libraryID,
            itemKeys: ["R2VEC001"],
            identity: compatible,
          }),
          1,
        );
        await vectors.insertVector({
          libraryID,
          itemKey: "R2VEC002",
          chunkId: 0,
          vector: new Float32Array([1, 0]),
          language: "en",
          chunkText: "Legacy vector",
        });
        failure = undefined;
        try {
          await vectors.search(query.queryVector, {
            libraryID,
            itemKeys: ["R2VEC002"],
            identity: compatible,
          });
        } catch (error) {
          failure = error;
        }
        assert.match(String(failure), /identity|space|rebuild/i);
      } finally {
        await wiki.close();
        await vectorDB.closeDatabase();
      }
    },
  );

  runtimeIt(
    "keeps Ollama dimensions and model frozen across a real HTTP 429 retry",
    async function () {
      const { HttpServer } = ChromeUtils.importESModule(
        "chrome://remote/content/server/httpd.sys.mjs",
      );
      const { NetUtil } = ChromeUtils.importESModule(
        "resource://gre/modules/NetUtil.sys.mjs",
      );
      const server = new HttpServer();
      const requests: any[] = [];
      let firstRequest!: () => void;
      const arrived = new Promise<void>((resolve) => {
        firstRequest = resolve;
      });
      server.registerPathHandler(
        "/api/embed",
        (request: any, response: any) => {
          const stream = request.bodyInputStream;
          requests.push(
            JSON.parse(
              NetUtil.readInputStreamToString(stream, stream.available()),
            ),
          );
          response.setHeader("Content-Type", "application/json", false);
          if (requests.length === 1) {
            response.setStatusLine(null, 429, "Too Many Requests");
            response.setHeader("Retry-After", "1", false);
            response.write(JSON.stringify({ error: "audit retry" }));
            firstRequest();
          } else {
            response.write(JSON.stringify({ embeddings: [[0.6, 0.8]] }));
          }
        },
      );
      server.start(23126);
      const embedding = new EmbeddingService();
      await embedding.initialize();
      const previous = embedding.getConfig();
      try {
        embedding.updateConfig({
          apiProvider: "ollama",
          apiBase: "http://127.0.0.1:23126",
          model: "qwen3-embedding",
          dimensions: 2,
          maxRetries: 2,
        });
        const pending = embedding.embed("Frozen Ollama request", "en", false);
        await Promise.race([
          arrived,
          pending.then(() => {
            throw new Error(
              "Ollama call completed without reaching the test endpoint",
            );
          }),
        ]);
        embedding.updateConfig({ model: "qwen3-embedding-new", dimensions: 3 });
        const result = await pending;
        assert.lengthOf(requests, 2);
        assert.deepEqual(requests[0], requests[1]);
        assert.equal(requests[1].dimensions, 2);
        assert.equal(result.identity.requestedDimensions, 2);
        assert.equal(result.identity.model, "qwen3-embedding");
      } finally {
        embedding.updateConfig(previous);
        embedding.destroy();
        await server.stop();
      }
    },
  );

  runtimeIt(
    "returns an actionable missing-document tool error through the installed HTTP server",
    async function () {
      const response = await Zotero.HTTP.request(
        "POST",
        "http://127.0.0.1:23121/mcp",
        {
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "round2-missing",
            method: "tools/call",
            params: {
              name: "get_document_chunks",
              arguments: {
                itemKey: "ZZZZZZZZ",
                libraryID: Zotero.Libraries.userLibraryID,
              },
            },
          }),
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          responseType: "text",
        },
      );
      const result = JSON.parse(response.responseText);
      assert.isUndefined(result.error);
      assert.isTrue(result.result.isError);
      assert.match(
        result.result.content[0].text,
        /not found|does not exist|不存在/i,
      );
      assert.notMatch(
        result.result.content[0].text,
        /has a full-text attachment/i,
      );
    },
  );
});
