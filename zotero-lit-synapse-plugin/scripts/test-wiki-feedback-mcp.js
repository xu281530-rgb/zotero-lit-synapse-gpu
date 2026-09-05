import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";

async function main() {
  globalThis.Zotero = {
    DataDirectory: { dir: "" },
    Libraries: { userLibraryID: 1 },
    DBConnection: class {},
    Prefs: {
      get() {},
      set() {},
      registerObserver() {},
      unregisterObserver() {},
    },
    debug() {},
  };
  globalThis.ztoolkit = { log() {} };
  globalThis.Cc = {};
  globalThis.Ci = {};
  globalThis.PathUtils = { join: path.join };
  globalThis.Services = {
    uuid: { generateUUID: () => "{test-wiki-feedback}" },
  };
  const bundled = await build({
    stdin: {
      contents:
        'export { StreamableMCPServer } from "./src/modules/streamableMCPServer.ts"; export { getWikiService } from "./src/modules/wiki/wikiService.ts"; export { WikiSynthesisAuditRequired } from "./src/modules/wiki/wikiSynthesisAudit.ts";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const { StreamableMCPServer, getWikiService, WikiSynthesisAuditRequired } =
    await import(
      `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
    );
  const server = new StreamableMCPServer();
  const service = getWikiService();
  let id = 0;
  async function call(name, args) {
    const response = await server.handleToolCall({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return JSON.parse(server.serializeResponse(response)).result;
  }
  const audit = server.coerceSynthesisAudit([
    {
      auditId: "audit-stable",
      support: [{ chunkId: 51, quote: "The original source passage." }],
    },
  ]);
  assert.equal(audit[0].auditId, "audit-stable");
  console.log("PASS MCP preserves audit IDs without requiring a sentence");

  service.getReadingNote = async (options) => options;
  const page = await call("wiki_get_reading_note", {
    itemKey: "PAPER",
    markdownOffset: 12000,
    markdownLimit: 5000,
    expectedBodyHash: "version-1",
  });
  const received = JSON.parse(page.content[0].text);
  assert.equal(received.markdownOffset, 12000);
  assert.equal(received.markdownLimit, 5000);
  assert.equal(received.expectedBodyHash, "version-1");
  service.buildFromPaper = async (options) => options;
  const source = await call("wiki_build_from_paper", {
    userRequested: true,
    itemKey: "PAPER",
    includeSourceText: true,
    includeReadingNote: false,
  });
  assert.equal(JSON.parse(source.content[0].text).includeSourceText, true);
  assert.equal(JSON.parse(source.content[0].text).includeReadingNote, false);
  console.log(
    "PASS MCP forwards versioned note paging and source-view options",
  );

  service.prepareUpdate = async (options) => options;
  const preview = await call("wiki_prepare_update", {
    query: "stress",
    preview: true,
  });
  assert.equal(JSON.parse(preview.content[0].text).preview, true);
  assert.equal(JSON.parse(preview.content[0].text).compact, true);
  service.getPreparedContext = (options) => options;
  const context = await call("wiki_get_prepared_context", {
    prepareToken: "token",
    section: "linkSignals",
    offset: 10,
  });
  assert.equal(JSON.parse(context.content[0].text).offset, 10);
  console.log("PASS MCP routes preview and prepared-context pagination");

  service.getReadingNote = async () => {
    throw new WikiSynthesisAuditRequired("A record needs supporting evidence", {
      mode: "record",
      flagged: 1,
      issues: [
        {
          auditId: "audit-stable",
          sentence: "Statement",
          citedChunks: [51, 52, 53],
          reasons: ["multi-chunk-fusion"],
          details: [],
        },
      ],
    });
  };
  const refused = await call("wiki_get_reading_note", { itemKey: "PAPER" });
  assert.equal(refused.isError, true);
  const problem = JSON.parse(refused.content[0].text);
  assert.equal(problem.mode, "record");
  assert.equal(problem.issues[0].auditId, "audit-stable");
  assert.deepEqual(problem.issues[0].citedChunks, [51, 52, 53]);
  console.log(
    "PASS MCP audit errors expose structured issues and the original call mode",
  );
}
await main().catch((error) => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
