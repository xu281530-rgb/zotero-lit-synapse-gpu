/* eslint-env node */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./index-failure-hooks.mjs", import.meta.url);

const zoteroItems = new Map();
globalThis.Zotero = {
  Libraries: { userLibraryID: 1 },
  Prefs: { get: () => undefined },
  Items: { getAsync: async (id) => zoteroItems.get(id) || null },
  File: { getContentsAsync: (filePath) => fs.readFile(filePath, "utf8") },
};
globalThis.ztoolkit = { log: () => undefined };

const { assembleStructuredDocument, selectStructuredSource } = await import(
  "../src/modules/mineru/structuredDocumentAssembler.ts"
);
const { TextChunker } = await import(
  "../src/modules/semantic/textChunker.ts"
);
const { VectorStore } = await import(
  "../src/modules/semantic/vectorStore.ts"
);
const { KeywordIndexStore } = await import(
  "../src/modules/keyword/keywordIndexStore.ts"
);
const { runBodyKeywordSearch } = await import(
  "../src/modules/keyword/bodyKeywordSearch.ts"
);
const { runHybridSearch } = await import(
  "../src/modules/hybridSearch.ts"
);
const { SemanticSearchService } = await import(
  "../src/modules/semantic/semanticSearchService.ts"
);

const LIBRARY_ID = 1;
const PARENT_KEY = "PARENTPAPER";
const PDF_ATTACHMENT_KEY = "PDFATT01";
const MD_ATTACHMENT_KEY = "MDATT001";
const UNIQUE_TERM = "XENOTHERMALPHASE8127";
const UNIQUE_SENTENCE =
  `${UNIQUE_TERM} appears only in the structured MinerU Markdown attachment.`;

const structured = [[
  {
    type: "title",
    content: {
      level: 1,
      title_content: [{ type: "text", content: "Canonical Indexed Paper" }],
    },
  },
  {
    type: "paragraph",
    content: {
      paragraph_content: [{ type: "text", content: UNIQUE_SENTENCE }],
    },
  },
  {
    type: "image",
    content: {
      image_source: { path: "images/plot.png" },
      image_caption: [{ type: "text", content: "Figure 1. Retained caption." }],
    },
  },
]];
const assembled = assembleStructuredDocument(
  selectStructuredSource({
    "paper_content_list_v2.json": JSON.stringify(structured),
  }),
);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zmp-mineru-index-"));
const markdownPath = path.join(
  tempDir,
  `MinerU Markdown (${PDF_ATTACHMENT_KEY}).md`,
);
await fs.writeFile(markdownPath, assembled.markdown, "utf8");
const markdownAttachment = {
  id: 2,
  key: MD_ATTACHMENT_KEY,
  attachmentFilename: path.basename(markdownPath),
  attachmentContentType: "text/markdown",
  isPDFAttachment: () => false,
  getFilePathAsync: async () => markdownPath,
  getField: (name) =>
    name === "title" ? `MinerU Markdown (${PDF_ATTACHMENT_KEY}).md` : "",
};
zoteroItems.set(markdownAttachment.id, markdownAttachment);
const parentItem = {
  key: PARENT_KEY,
  libraryID: LIBRARY_ID,
  itemType: "journalArticle",
  isRegularItem: () => true,
  getAttachments: () => [markdownAttachment.id],
  getDisplayTitle: () => "Canonical Indexed Paper",
  getField: () => "",
  getNotes: () => [],
};
const semanticService = Object.create(SemanticSearchService.prototype);
const extracted = await semanticService.extractItemContent(parentItem, null);
const attachmentMarkdown = extracted.text;
assert.match(attachmentMarkdown, new RegExp(UNIQUE_TERM));
assert.doesNotMatch(attachmentMarkdown, /plot\.png|!\[/);
assert.deepEqual(
  extracted.bodySources,
  [`markdown:${MD_ATTACHMENT_KEY}`],
  "production attachment discovery reads the Zotero MD child directly",
);

const chunker = new TextChunker({
  targetChunkSize: 240,
  appendToleranceSize: 80,
  skipReferences: false,
});
const chunks = chunker.chunk(attachmentMarkdown);
assert.ok(chunks.some((chunk) => chunk.includes(UNIQUE_SENTENCE)));

const embeddingStub = (text) =>
  text.includes(UNIQUE_TERM)
    ? new Float32Array([1, 0])
    : new Float32Array([0, 1]);
const vectorBytes = (vector) =>
  new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
const rows = chunks.map((chunkText, chunkId) => ({
  id: chunkId + 1,
  item_key: PARENT_KEY,
  chunk_id: chunkId,
  language: "en",
  dimensions: 2,
  float32: vectorBytes(embeddingStub(chunkText)),
  chunk_text: chunkText,
}));

const storageRow = (columns) => ({
  getResultByName(name) {
    if (!(name in columns)) throw new Error(`DB column '${name}' not found`);
    return columns[name];
  },
});
const semanticDB = {
  async queryAsync(sql, params = [], options = {}) {
    let resultRows;
    if (sql.includes("SELECT dimensions, vector_int8 IS NOT NULL")) {
      resultRows = rows.length
        ? [{ dimensions: 2, has_int8: 0 }]
        : [];
    } else if (sql.includes("SELECT id, chunk_text")) {
      const ids = new Set(params);
      resultRows = rows
        .filter((row) => ids.has(row.id))
        .map((row) => ({ id: row.id, chunk_text: row.chunk_text }));
    } else if (sql.includes("ORDER BY id LIMIT ? OFFSET ?")) {
      const limit = Number(params.at(-2));
      const offset = Number(params.at(-1));
      resultRows = rows.slice(offset, offset + limit).map((row) => ({
        ...row,
        vector_f32: row.float32,
      }));
    } else {
      throw new Error(`Unexpected semantic query: ${sql}`);
    }
    if (options?.onRow) {
      for (const row of resultRows) options.onRow(storageRow(row), () => {});
      return undefined;
    }
    return resultRows;
  },
};
const cpuBackend = {
  isEnabled: () => false,
  getEffectivePrecision: () => "float32",
  getCpuFallbackPrecision: () => "float32",
  reportCpuPrecision: () => undefined,
  registerProvider: () => undefined,
  startIfEnabled: async () => undefined,
  search: async () => [],
  publishMutation: async () => undefined,
  fallback: () => undefined,
  setEnabled: async () => undefined,
  setPrecision: async () => undefined,
  shutdown: async () => undefined,
};
const vectorStore = new VectorStore(cpuBackend);
vectorStore.initialized = true;
vectorStore.db = semanticDB;
const semanticHits = await vectorStore.search(embeddingStub(UNIQUE_TERM), {
  groupByItem: true,
  documentLimit: 10,
  maxChunksPerItem: 3,
  libraryID: LIBRARY_ID,
  minScore: 0.5,
});
assert.ok(semanticHits.length > 0);
assert.equal(semanticHits[0].itemKey, PARENT_KEY);
assert.match(semanticHits[0].chunkText, new RegExp(UNIQUE_TERM));

let transactionDepth = 0;
const sqlite = new DatabaseSync(path.join(tempDir, "keyword.sqlite"));
const keywordDB = {
  async queryAsync(sql, params = []) {
    const statement = sqlite.prepare(sql);
    if (/^\s*(select|pragma)/iu.test(sql)) return statement.all(...params);
    statement.run(...params);
    return [];
  },
  async executeTransaction(operation) {
    if (transactionDepth > 0) return operation();
    transactionDepth += 1;
    sqlite.exec("BEGIN");
    try {
      const result = await operation();
      sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      transactionDepth -= 1;
    }
  },
};
const keywordStore = new KeywordIndexStore(keywordDB);
await keywordStore.writeItem({
  libraryID: LIBRARY_ID,
  itemKey: PARENT_KEY,
  title: "Canonical Indexed Paper",
  abstract: "",
  tags: [],
  chunks,
});
const resolver = {
  async chunkTexts(_libraryID, pairs) {
    return new Map(
      pairs.map((pair) => [
        `${pair.itemKey}:${pair.chunkId}`,
        chunks[pair.chunkId] || "",
      ]),
    );
  },
  async metadataTexts(_libraryID, itemKeys) {
    return new Map(
      itemKeys.map((itemKey) => [
        itemKey,
        { title: "Canonical Indexed Paper", abstract: "", tags: "" },
      ]),
    );
  },
};
const keywordRun = await runBodyKeywordSearch(keywordStore, resolver, {
  libraryID: LIBRARY_ID,
  probes: [{ text: UNIQUE_TERM, weight: 1 }],
});
assert.equal(keywordRun.results[0].itemKey, PARENT_KEY);
assert.match(keywordRun.results[0].evidence[0].text, new RegExp(UNIQUE_TERM));

const semanticResults = [{
  itemKey: PARENT_KEY,
  libraryID: LIBRARY_ID,
  title: "Canonical Indexed Paper",
  score: semanticHits[0].score,
  matchedChunks: semanticHits.map((hit) => ({
    chunkId: hit.chunkId,
    text: hit.chunkText,
    score: hit.score,
  })),
}];
const keywordResults = keywordRun.results.map((result) => ({
  ...result,
  key: result.itemKey,
  libraryID: LIBRARY_ID,
}));
const hybrid = await runHybridSearch(
  {
    query: UNIQUE_SENTENCE,
    keywords: [UNIQUE_TERM],
    topK: 10,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
    keywordMinScore: 0,
    semanticMinScore: 0,
  },
  {
    keywordSearch: async () => keywordResults,
    semanticSearch: async () => semanticResults,
  },
);
assert.equal(hybrid.results[0].itemKey, PARENT_KEY);
assert.equal(hybrid.results[0].keywordRank, 1);
assert.equal(hybrid.results[0].semanticRank, 1);
assert.equal(
  hybrid.results.some((result) => result.itemKey === MD_ATTACHMENT_KEY),
  false,
  "search results remain owned by the parent literature item",
);
assert.equal(
  new Set(hybrid.results.map((result) => result.itemKey)).size,
  hybrid.results.length,
  "the indexed parent appears only once in the fused result",
);

sqlite.close();
await fs.rm(tempDir, { recursive: true, force: true });
console.log("MinerU Markdown semantic/keyword/hybrid integration tests passed");
