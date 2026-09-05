import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

register("./ts-ext-hooks.mjs", import.meta.url);
globalThis.Zotero = {
  Libraries: { userLibraryID: 1 },
  Prefs: { get: () => undefined, set() {}, clear() {} },
};
globalThis.ztoolkit = { log() {} };
const { VectorStore } = await import("../src/modules/semantic/vectorStore.ts");
const { SemanticSearchService } = await import(
  "../src/modules/semantic/semanticSearchService.ts"
);
const { getChunkingSignature, getHybridSearchSettings } = await import(
  "../src/modules/hybridSearchSettings.ts"
);
const { sourceKindForBodyState } = await import(
  "../src/modules/semantic/bodyIndexState.ts"
);

const identityA = {
  model: "same-alias",
  apiBase: "https://service-a.invalid/v1",
  provider: "openai",
  dimensions: 2,
  inputHash: "original-input",
  queryMode: false,
};
const identityB = {
  ...identityA,
  apiBase: "https://service-b.invalid/v1",
  inputHash: "query-input",
  queryMode: true,
};
const record = (key, identity = identityA, text = "Same indexed text") => ({
  itemKey: key,
  libraryID: 1,
  chunkId: 0,
  vector: new Float32Array([1, 0]),
  language: "en",
  chunkText: text,
  identity,
});
function adapter(sqlite) {
  return {
    async queryAsync(sql, params = [], options) {
      const stmt = sqlite.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/iu.test(sql)) {
        const rows = stmt.all(...params);
        if (options?.onRow) {
          for (const row of rows) options.onRow(row, () => {});
          return undefined;
        }
        return rows;
      }
      stmt.run(...params);
      return [];
    },
    async valueQueryAsync(sql, params = []) {
      const row = sqlite.prepare(sql).get(...params);
      return row && Object.values(row)[0];
    },
    async executeTransaction(fn) {
      sqlite.exec("BEGIN");
      try {
        const value = await fn();
        sqlite.exec("COMMIT");
        return value;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
async function harness() {
  const db = new DatabaseSync(":memory:");
  let gpuEnabled = false;
  let gpuSearches = 0;
  const backend = {
    registerProvider() {},
    isEnabled: () => gpuEnabled,
    getCpuFallbackPrecision: () => "int8",
    getEffectivePrecision: () => "int8",
    reportCpuPrecision() {},
    publishMutation: async () => {},
    fallback() {},
    async search() {
      gpuSearches++;
      return [];
    },
  };
  const store = new VectorStore(backend);
  store.db = adapter(db);
  await store.createTables();
  store.initialized = true;
  return {
    store,
    db,
    backend,
    enableGpu: () => {
      gpuEnabled = true;
    },
    gpuCalls: () => gpuSearches,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const operation of [
  "single-delete",
  "batch-delete",
  "library-clear",
  "build-clear",
]) {
  test(`${operation} blocks searches until its committed deletion reaches the GPU`, async () => {
    const { store, db, backend, enableGpu } = await harness();
    const started = deferred();
    const release = deferred();
    let mutation;
    try {
      await store.insertVector(record("OLDPAPER", identityA));
      await store.insertVector(record("NEWPAPER", identityB));
      enableGpu();
      backend.publishMutation = async () => {
        started.resolve();
        await release.promise;
      };
      mutation =
        operation === "single-delete"
          ? store.deleteItemVectors("OLDPAPER", 1)
          : operation === "batch-delete"
            ? store.deleteItemsVectors(["OLDPAPER"], 1)
            : operation === "library-clear"
              ? store.clear(1)
              : store.clearLibraryForBuild("audit-build", 1);
      await started.promise;
      await assert.rejects(
        store.search(new Float32Array([1, 0]), {
          libraryID: 1,
          identity: identityB,
        }),
        /updating|synchronization/iu,
      );
    } finally {
      release.resolve();
      await mutation;
      db.close();
    }
  });
}

test("all vector writes persist the actual generating identity and preserve character totals", async () => {
  const { store, db } = await harness();
  try {
    await store.insertVector(record("PAPER001"));
    await store.insertVectorsBatch([record("PAPER002")]);
    await store.replaceItemIndex({
      itemKey: "PAPER003",
      libraryID: 1,
      records: [record("PAPER003")],
      contentHash: "a",
      contentLength: 17,
      sourceKind: "pdf",
    });
    for (const key of ["PAPER001", "PAPER002", "PAPER003"]) {
      const chunks = await store.getItemVectors(key, 1);
      assert.deepEqual(chunks[0].identity, identityA);
      const page = await store.getDocumentChunkPage(key, 1, 0, 1);
      assert.equal(page.totalChunks, 1);
      assert.equal(page.totalChars, record(key).chunkText.length);
    }
    const before = await store.getDocumentRevision("PAPER003", 1);
    await store.replaceItemIndex({
      itemKey: "PAPER003",
      libraryID: 1,
      records: [record("PAPER003", identityB)],
      contentHash: "a",
      contentLength: 17,
      sourceKind: "pdf",
    });
    assert.equal(
      await store.getDocumentRevision("PAPER003", 1),
      before,
      "re-embedding unchanged text must retain its reading version",
    );
  } finally {
    db.close();
  }
});

test("complete reset blocks queries during its post-commit callback", async () => {
  const { store, db, backend, enableGpu } = await harness();
  const committed = deferred();
  const release = deferred();
  let reset;
  try {
    await store.insertVector(record("OLDPAPER", identityA));
    enableGpu();
    backend.shutdown = async () => {};
    reset = store.clearAll({
      onDatabaseCleared: async () => {
        committed.resolve();
        await release.promise;
      },
    });
    await committed.promise;
    await assert.rejects(
      store.search(new Float32Array([1, 0]), {
        libraryID: 1,
        identity: identityB,
      }),
      /updating|synchronization/iu,
    );
  } finally {
    release.resolve();
    await reset;
    db.close();
  }
});

test("CPU and GPU reject same-model same-dimension vectors from another service before scoring", async () => {
  const { store, db, enableGpu, gpuCalls } = await harness();
  try {
    await store.insertVector(record("PAPER001"));
    for (const gpu of [false, true]) {
      if (gpu) enableGpu();
      await assert.rejects(
        store.search(new Float32Array([1, 0]), {
          libraryID: 1,
          identity: identityB,
        }),
        /identity|incompatible|rebuild/iu,
      );
      await assert.rejects(
        store.searchMultiQuery([new Float32Array([1, 0])], {
          libraryID: 1,
          identity: identityB,
        }),
        /identity|incompatible|rebuild/iu,
      );
    }
    assert.equal(gpuCalls(), 0);
  } finally {
    db.close();
  }
});

test("legacy vectors without provenance refuse production queries while compatible vectors work", async () => {
  const { store, db } = await harness();
  try {
    await store.insertVector(record("KNOWN001"));
    await store.insertVector({ ...record("LEGACY01"), identity: undefined });
    const query = {
      ...identityA,
      inputHash: "different-question",
      queryMode: true,
    };
    const known = await store.search(new Float32Array([1, 0]), {
      libraryID: 1,
      itemKeys: ["KNOWN001"],
      identity: query,
    });
    assert.equal(known.length, 1);
    assert.equal(known[0].itemKey, "KNOWN001");
    await assert.rejects(
      store.search(new Float32Array([1, 0]), { libraryID: 1, identity: query }),
      /identity|incompatible|rebuild/iu,
    );
  } finally {
    db.close();
  }
});

test("GPU results cannot survive a vector identity mutation during the scan", async () => {
  const { store, db, backend, enableGpu } = await harness();
  try {
    await store.insertVector(record("PAPER001"));
    enableGpu();
    const scanning = deferred();
    const release = deferred();
    backend.search = async () => {
      scanning.resolve();
      await release.promise;
      return [];
    };
    const search = store.search(new Float32Array([1, 0]), {
      libraryID: 1,
      identity: identityA,
    });
    const rejected = assert.rejects(search, /changed during retrieval/iu);
    await scanning.promise;
    await store.insertVector(record("PAPER001", identityB));
    release.resolve();
    await rejected;
  } finally {
    db.close();
  }
});

test("a query waits for an index update to synchronize before it can use GPU vectors", async () => {
  const { store, db, backend, enableGpu, gpuCalls } = await harness();
  try {
    await store.insertVector(record("PAPER001"));
    enableGpu();
    const syncing = deferred();
    const release = deferred();
    backend.publishMutation = async () => {
      syncing.resolve();
      await release.promise;
    };
    const update = store.insertVector(record("PAPER001", identityB));
    await syncing.promise;
    await assert.rejects(
      store.search(new Float32Array([1, 0]), {
        libraryID: 1,
        identity: identityB,
      }),
      /updating|synchronization/iu,
    );
    assert.equal(gpuCalls(), 0);
    release.resolve();
    await update;
  } finally {
    db.close();
  }
});

test("forced reindex repairs missing or changed embedding identity without resetting unchanged text", async () => {
  const { store, db } = await harness();
  try {
    const service = new SemanticSearchService();
    const content =
      "One unchanged paragraph whose vectors need a new identity.";
    let batches = 0;
    Object.assign(service, {
      initialized: true,
      vectorStore: store,
      embeddingService: {
        getConfigurationIdentity: () => identityB,
        embedBatch: async (items) => {
          batches++;
          return new Map(
            items.map((item) => [
              item.id,
              {
                embedding: new Float32Array([1, 0]),
                dimensions: 2,
                language: "en",
                identity: identityB,
              },
            ]),
          );
        },
      },
      textChunker: { chunk: () => [content] },
      getBodyExtractionSignature: () => "same-parser",
      extractItemContent: async () => ({
        text: content,
        hasBody: true,
        hasBodySource: true,
        bodySources: ["pdf"],
        failedSources: [],
      }),
      writeKeywordIndexForItem: async () => {},
    });
    for (const oldIdentity of [undefined, identityA]) {
      const key = oldIdentity ? "OLDAPI01" : "LEGACY01";
      await store.replaceItemIndex({
        itemKey: key,
        libraryID: 1,
        records: [
          { ...record(key, identityA, content), identity: oldIdentity },
        ],
        contentHash: service.hashContent(content),
        contentLength: content.length,
        sourceKind: sourceKindForBodyState("body"),
        itemModified: "same",
        bodyRetrySignature: "same-parser",
      });
      await store.setChunkSignature(
        key,
        getChunkingSignature(getHybridSearchSettings()),
        1,
      );
      const before = await store.getDocumentRevision(key, 1);
      await service.indexItemWithProcessor(
        {
          key,
          libraryID: 1,
          dateModified: "same",
          getDisplayTitle: () => key,
          isRegularItem: () => true,
          getAttachments: () => [],
        },
        null,
        true,
      );
      assert.deepEqual(
        (await store.getItemVectors(key, 1))[0].identity,
        identityB,
      );
      assert.equal(await store.getDocumentRevision(key, 1), before);
    }
    assert.equal(batches, 2);
  } finally {
    db.close();
  }
});

test("find_similar refuses a stored query from another configured service", async () => {
  const { store, db } = await harness();
  try {
    await store.insertVector(record("PAPER001"));
    const service = new SemanticSearchService();
    Object.assign(service, {
      initialized: true,
      vectorStore: store,
      embeddingService: { getConfigurationIdentity: () => identityB },
    });
    await assert.rejects(
      service.findSimilarByChunks({
        itemKey: "PAPER001",
        libraryID: 1,
        chunkIds: [0],
      }),
      /incompatible embedding identity/iu,
    );
  } finally {
    db.close();
  }
});
