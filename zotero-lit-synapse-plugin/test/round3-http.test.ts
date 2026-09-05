import { VectorStore } from "../src/modules/semantic/vectorStore";
import {
  WikiReadingNoteStore,
  parseReadingNote,
} from "../src/modules/wiki/wikiReadingNote";

describe("Round 3 installed plugin HTTP reading diagnostic", function () {
  this.timeout(30000);

  it("must reject a question note that omits one of its declared read chunks", async function () {
    const dataDir = Zotero.DataDirectory.dir;
    if (!/(?:^|\/)\.scaffold\/test\/data$/i.test(dataDir.replace(/\\/g, "/"))) {
      throw new Error(
        "Refusing HTTP write diagnostic outside the disposable .scaffold/test/data profile: " +
          dataDir,
      );
    }
    const resultPath = PathUtils.join(dataDir, "round3-http-results.json");
    const observations: any = {
      environment:
        "Loaded Zotero addon via actual HTTP MCP on port 23121; disposable profile only; native SQLite fixture and real note attachment; no embedding API",
      dataDir,
    };
    (globalThis as any).ztoolkit = {
      log: (...args: any[]) => Zotero.debug(args.map(String).join(" ")),
    };
    const persist = () =>
      IOUtils.writeUTF8(resultPath, JSON.stringify(observations, null, 2));
    const prefs: Record<string, boolean> = {
      "extensions.zotero.zotero-lit-synapse.write.enabled": true,
      "extensions.zotero.zotero-lit-synapse.write.confirmBeforeMutation": false,
      "extensions.zotero.zotero-lit-synapse.wiki.enabled": true,
      "extensions.zotero.zotero-lit-synapse.wiki.link.enabled": false,
      "extensions.zotero.zotero-lit-synapse.semantic.autoUpdate": false,
    };
    const prior = Object.keys(prefs).map((key) => ({
      key,
      value: Zotero.Prefs.get(key, true),
      userValue: Services.prefs.prefHasUserValue(key),
    }));
    let vectorDB: any;
    const rpc = async (
      id: string,
      method: string,
      params: any,
    ): Promise<any> => {
      const response = await Zotero.HTTP.request(
        "POST",
        "http://127.0.0.1:23121/mcp",
        {
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          responseType: "text",
          successCodes: [200, 202, 204],
          timeout: 15000,
        },
      );
      return response.responseText ? JSON.parse(response.responseText) : null;
    };
    const unpack = (response: any): any => {
      const text = response?.result?.content?.find(
        (entry: any) => entry.type === "text",
      )?.text;
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    try {
      for (const [key, value] of Object.entries(prefs))
        Zotero.Prefs.set(key, value, true);
      observations.initialize = await rpc("round3-http-init", "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "round3-isolated-http-diagnostic", version: "1" },
      });
      await persist();

      const item = new Zotero.Item("journalArticle");
      item.libraryID = Zotero.Libraries.userLibraryID;
      item.setField("title", "Round 3 actual HTTP missing reading record");
      await item.saveTx();
      const libraryID = item.libraryID;
      const itemKey = item.key;
      observations.itemKey = itemKey;
      observations.libraryID = libraryID;
      const source = [
        "The imposed thermal gradient controls the orientation of the solidified grain array.",
        "The cooling protocol was independently calibrated before the grain orientation measurements.",
      ];
      observations.vectorPath = PathUtils.join(
        dataDir,
        "zotero-lit-synapse-vectors.sqlite",
      );
      vectorDB = new Zotero.DBConnection(observations.vectorPath);
      const vector: any = new VectorStore({
        registerProvider() {},
        isEnabled: () => false,
        publishMutation: async () => {},
        fallback() {},
      } as any);
      vector.db = vectorDB;
      await vector.createTables();
      vector.initialized = true;
      await vector.replaceItemIndex({
        libraryID,
        itemKey,
        contentHash: "round3-http-" + itemKey,
        contentLength: source.join("\n").length,
        sourceKind: "body",
        records: source.map((chunkText, chunkId) => ({
          libraryID,
          itemKey,
          chunkId,
          chunkText,
          language: "en",
          vector: new Float32Array([1, 0]),
        })),
      });
      observations.indexedChunks = await vector.getChunksForItem(
        itemKey,
        libraryID,
      );
      await vectorDB.closeDatabase();
      vectorDB = null;
      await persist();

      observations.indexReadResponse = await rpc(
        "round3-http-chunks",
        "tools/call",
        {
          name: "get_document_chunks",
          arguments: { libraryID, itemKey, limit: 2 },
        },
      );
      observations.indexReadResult = unpack(observations.indexReadResponse);
      await persist();
      if (
        observations.indexReadResponse?.result?.isError ||
        observations.indexReadResponse?.error
      ) {
        throw new Error(
          "The loaded plugin could not read the seeded index: " +
            JSON.stringify(observations.indexReadResponse),
        );
      }

      const params = {
        libraryID,
        itemKey,
        readChunkIds: [0, 1],
        domain: "directional solidification",
        expertRole: "materials researcher",
        readingRecord:
          "The thermal gradient controls the orientation of the grain array (chunk 0).",
      };
      observations.updateRequest = params;
      observations.updateResponse = await rpc(
        "round3-http-update",
        "tools/call",
        {
          name: "wiki_update_reading_note",
          arguments: params,
        },
      );
      observations.updateResult = unpack(observations.updateResponse);
      await persist();
      observations.getNoteResponse = await rpc(
        "round3-http-note",
        "tools/call",
        {
          name: "wiki_get_reading_note",
          arguments: { libraryID, itemKey, includeMarkdown: true },
        },
      );
      observations.getNoteResult = unpack(observations.getNoteResponse);
      const notes = new WikiReadingNoteStore();
      const attachment = await notes.findAttachment(item);
      observations.attachmentKey = attachment?.key ?? null;
      observations.attachmentPath = attachment
        ? await attachment.getFilePathAsync()
        : null;
      observations.actualAttachment = attachment
        ? await notes.read(attachment)
        : null;
      observations.actualBody = observations.actualAttachment
        ? parseReadingNote(observations.actualAttachment).body
        : null;
      observations.declaredReadChunks = 2;
      observations.recordReferencesChunk1 = /chunk\s+1\b/i.test(
        params.readingRecord,
      );
      observations.reportedDeliveredChunks =
        observations.updateResult?.reading?.deliveredChunks;
      await persist();

      assert.isTrue(
        observations.updateResponse?.result?.isError === true,
        "The loaded plugin must reject a note which declares two read chunks but accounts for only the first",
      );
      assert.match(
        JSON.stringify(observations.updateResponse.result.content),
        /chunk|覆盖|交代/i,
        "A rejection must concern missing reading content, not an unrelated initialization failure",
      );
      assert.notEqual(
        observations.reportedDeliveredChunks,
        2,
        "Rejected missing content must not be recorded as fully read",
      );
    } catch (error) {
      observations.error = String(error);
      observations.originalError = String((error as any)?.originalError ?? "");
      await persist();
      throw error;
    } finally {
      await vectorDB?.closeDatabase();
      for (const saved of prior) {
        if (saved.userValue)
          Zotero.Prefs.set(saved.key, saved.value as any, true);
        else if (Services.prefs.prefHasUserValue(saved.key))
          Services.prefs.clearUserPref(saved.key);
      }
      observations.preferencesRestored = true;
      await persist();
    }
  });
});
