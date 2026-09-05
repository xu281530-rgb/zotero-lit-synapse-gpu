import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), "utf8");
const quiet = { debug() {}, logError() {} };
const results = [];

async function check(name, run) {
  try {
    await run();
    results.push({ name, status: "PASS" });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: "FAIL", error: String(error.stack || error) });
    console.error(`FAIL ${name}\n${error.stack || error}`);
  }
}

// Compile the actual modules; only host APIs and unrelated services are mocked.
function loadTS(file, dependencies = {}, globals = {}, extra = "") {
  const compiled = ts.transpileModule(read(file) + extra, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: file,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    compiled,
    {
      module,
      exports: module.exports,
      require: (name) => dependencies[name] || {},
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Zotero: quiet,
      ztoolkit: { log() {} },
      ...globals,
    },
    { filename: file, timeout: 5000 },
  );
  return module.exports;
}

function serverHarness({ failListen = false } = {}) {
  const sockets = [];
  const callbacks = [];
  const { HttpServer } = loadTS(
    "src/modules/httpServer.ts",
    {
      "./streamableMCPServer": { StreamableMCPServer: class {} },
      "./serverPreferences": {
        serverPreferences: { isRemoteAccessAllowed: () => false },
      },
    },
    {
      Ci: { nsIServerSocket: {} },
      Cc: {
        "@mozilla.org/network/server-socket;1": {
          createInstance() {
            const socket = {
              closed: false,
              init(port) {
                this.port = port;
              },
              asyncListen(listener) {
                if (failListen) throw new Error("listen failed");
                this.listener = listener;
              },
              close() {
                this.closed = true;
                if (this.listener) {
                  callbacks.push(() => this.listener.onStopListening(this, 0));
                }
              },
            };
            sockets.push(socket);
            return socket;
          },
        },
      },
    },
  );
  return { server: new HttpServer(), sockets, callbacks };
}

await check(
  "B1: late close callbacks cannot stop a replacement listener",
  () => {
    const { server, sockets, callbacks } = serverHarness();
    for (const port of [23001, 23002, 23003]) {
      server.start(port);
      if (port !== 23003) server.stop();
    }
    for (const callback of callbacks.splice(0).reverse()) callback();
    assert.equal(server.isServerRunning(), true);
    assert.equal(server.getBoundPort(), 23003);
    assert.equal(server.isBoundLoopbackOnly(), true);
    server.stop();
    assert.ok(sockets.every((socket) => socket.closed));
    assert.equal(server.getBoundPort(), null);
    callbacks.splice(0).forEach((callback) => callback());
    server.stop();
    assert.equal(server.isServerRunning(), false);
  },
);

await check(
  "B1: stop closes the owned socket even with a stale running flag",
  () => {
    const { server, sockets } = serverHarness();
    server.start(23001);
    server.isRunning = false;
    server.stop();
    assert.equal(sockets[0].closed, true);
    assert.equal(server.serverSocket, null);
  },
);

await check(
  "B1: a failed start releases the partially initialized socket",
  () => {
    const { server, sockets } = serverHarness({ failListen: true });
    assert.throws(() => server.start(23001), /listen failed/);
    assert.equal(sockets[0].closed, true);
    assert.equal(server.isServerRunning(), false);
    assert.equal(server.serverSocket, null);
  },
);

await check(
  "B1: an unexpected current-listener stop cleans active connections",
  () => {
    const { server, sockets } = serverHarness();
    server.start(23001);
    let closed = 0;
    server.activeTransports.add({
      close() {
        closed++;
      },
    });
    sockets[0].listener.onStopListening(sockets[0], 1);
    assert.equal(server.isServerRunning(), false);
    assert.equal(server.getBoundPort(), null);
    assert.equal(server.mcpServer, null);
    assert.equal(closed, 1);
  },
);

await check(
  "B1: accepted connections from a retired socket are closed",
  async () => {
    const { server, sockets } = serverHarness();
    server.start(23001);
    server.stop();
    server.start(23002);
    let closed = false;
    await sockets[0].listener.onSocketAccepted(sockets[0], {
      close() {
        closed = true;
      },
      openInputStream() {
        assert.fail("a retired listener must not dispatch requests");
      },
    });
    assert.equal(closed, true);
    assert.equal(server.isServerRunning(), true);
  },
);

const readerFile = "addon/mark-reader/content/scripts/zotero-mark-reader.js";
const readerSource = read(readerFile).replace(
  "  const testExports =",
  "  globalThis.auditReader = { state, getAttachmentDataDir, loadTranslationCache, saveTranslationCache, emptyTranslationCache, ReaderOverlayController };\n  const testExports =",
);

function readerHarness(disk = new Map(), owners = []) {
  const context = {
    console,
    process: { env: { ZMR_TEST: "1" } },
    PathUtils: { join: path.posix.join },
    IOUtils: {
      makeDirectory: async () => {},
      exists: async (file) => disk.has(file),
      readUTF8: async (file) => {
        if (!disk.has(file)) throw new Error(`Missing fixture: ${file}`);
        return disk.get(file);
      },
      writeUTF8: async (file, value) => {
        disk.set(file, value);
      },
      move: async (from, to) => {
        disk.set(to, disk.get(from));
        disk.delete(from);
      },
      remove: async (file) => {
        disk.delete(file);
      },
    },
    Zotero: {
      ...quiet,
      DataDirectory: { dir: "/test-data" },
      DB: {
        queryAsync: async (_sql, [key]) =>
          owners.filter((item) => item.key === key),
      },
      Prefs: { get() {} },
      getMainWindow: () => ({ setTimeout, clearTimeout }),
    },
  };
  vm.runInNewContext(readerSource, context, {
    filename: readerFile,
    timeout: 5000,
  });
  return {
    ...context.auditReader,
    tests: context.ZoteroMarkReader.__test,
    disk,
    host: context,
  };
}

const first = { id: 10, libraryID: 1, key: "ABCD2345" };
const second = { id: 20, libraryID: 7, key: "ABCD2345" };
const parsed = (sourceHash) => ({ sourceHash, blocks: [] });
const cacheFile = async (reader, attachment) =>
  path.posix.join(
    await reader.getAttachmentDataDir(attachment),
    "translation-cache.json",
  );

await check(
  "B2: equal attachment keys in different libraries have separate caches",
  async () => {
    const reader = readerHarness();
    const a = await reader.loadTranslationCache(first, parsed("paper-a"));
    a.glossary.manual.push({ source: "alpha", target: "A" });
    const b = await reader.loadTranslationCache(second, parsed("paper-b"));
    assert.notEqual(
      await cacheFile(reader, first),
      await cacheFile(reader, second),
    );
    assert.notEqual(a, b);
    assert.equal(b.sourceHash, "paper-b");
    assert.equal(b.glossary.manual.length, 0);
    assert.equal(a.libraryID, 1);
    assert.equal(b.libraryID, 7);
  },
);

await check(
  "B2: concurrent writes and reopening preserve each library's data",
  async () => {
    const reader = readerHarness();
    const a = await reader.loadTranslationCache(first, parsed("paper-a"));
    const b = await reader.loadTranslationCache(second, parsed("paper-b"));
    a.entries.block = { version: { markdown: "translation A" } };
    b.entries.block = { version: { markdown: "translation B" } };
    const writes = [
      reader.saveTranslationCache(first, a),
      reader.saveTranslationCache(second, b),
    ];
    assert.equal(reader.state.translationCacheWrites.size, 2);
    await Promise.all(writes);
    assert.equal(reader.state.translationCacheWrites.size, 0);
    const reopened = readerHarness(reader.disk);
    assert.equal(
      (await reopened.loadTranslationCache(first, parsed("paper-a"))).entries
        .block.version.markdown,
      "translation A",
    );
    assert.equal(
      (await reopened.loadTranslationCache(second, parsed("paper-b"))).entries
        .block.version.markdown,
      "translation B",
    );
  },
);

await check(
  "B2: cache notifications update only the matching reader",
  async () => {
    const reader = readerHarness();
    const a = await reader.loadTranslationCache(first, parsed("paper-a"));
    const b = await reader.loadTranslationCache(second, parsed("paper-b"));
    const controllers = [first, second].map((attachment) => {
      const controller = new reader.ReaderOverlayController({});
      controller.attachment = attachment;
      controller.renders = 0;
      controller.queueRender = () => controller.renders++;
      return controller;
    });
    controllers[1].translationCache = b;
    await reader.saveTranslationCache(first, a);
    assert.equal(controllers[0].translationCache, a);
    assert.equal(controllers[0].renders, 1);
    assert.equal(controllers[1].translationCache, b);
    assert.equal(controllers[1].renders, 0);
  },
);

await check(
  "B2: batch glossary editing identifies the library as well as the key",
  async () => {
    const reader = readerHarness();
    const task = new reader.tests.FullTranslationTask([], {});
    task.documents = [first, second].map((attachment) => ({
      attachment,
      title: "Paper",
      cache: reader.emptyTranslationCache(attachment, parsed("same-text")),
      savePromise: Promise.resolve(),
    }));
    const documents = task.snapshot().documents;
    assert.ok(documents[0].attachmentIdentity);
    assert.notEqual(
      documents[0].attachmentIdentity,
      documents[1].attachmentIdentity,
    );
    task.setDocumentGlossary(documents[1].attachmentIdentity, [
      { source: "beta", target: "B" },
    ]);
    await task.documents[1].savePromise;
    assert.equal(task.documents[0].cache.glossary.manual.length, 0);
    assert.equal(task.documents[1].cache.glossary.manual[0].target, "B");
  },
);

function legacyFixture(reader, { libraryID = 1, hash = "paper-a" } = {}) {
  const legacy = reader.emptyTranslationCache(first, parsed(hash));
  delete legacy.libraryID;
  legacy.glossary.manual.push({ source: "alpha", target: "legacy" });
  const directory = "/test-data/zotero-lit-synapse/mineru/ABCD2345";
  reader.disk.set(
    `${directory}/translation-cache.json`,
    JSON.stringify(legacy),
  );
  reader.disk.set(
    `${directory}/meta.json`,
    JSON.stringify({ attachmentKey: first.key, libraryID }),
  );
  return `${directory}/translation-cache.json`;
}

await check(
  "B2: verified unambiguous legacy caches migrate without deleting the original",
  async () => {
    const reader = readerHarness(new Map(), [first]);
    const legacy = legacyFixture(reader);
    const loaded = await reader.loadTranslationCache(first, parsed("paper-a"));
    assert.equal(loaded.glossary.manual[0].target, "legacy");
    assert.equal(loaded.libraryID, 1);
    assert.notEqual(await cacheFile(reader, first), legacy);
    assert.equal(
      JSON.parse(reader.disk.get(await cacheFile(reader, first))).libraryID,
      1,
    );
    assert.ok(reader.disk.has(legacy));
  },
);

for (const scenario of [
  "wrong library",
  "ambiguous key",
  "changed source",
  "missing metadata",
]) {
  await check(`B2: legacy migration rejects ${scenario}`, async () => {
    const reader = readerHarness(
      new Map(),
      scenario === "ambiguous key" ? [first, second] : [first],
    );
    const legacy = legacyFixture(reader, {
      libraryID: scenario === "wrong library" ? 7 : 1,
      hash: scenario === "changed source" ? "old-paper" : "paper-a",
    });
    if (scenario === "missing metadata")
      reader.disk.delete(legacy.replace("translation-cache.json", "meta.json"));
    const loaded = await reader.loadTranslationCache(first, parsed("paper-a"));
    assert.equal(loaded.glossary.manual.length, 0);
    assert.ok(reader.disk.has(legacy));
  });
}

await check(
  "B2: a scoped cache with a conflicting owner is not adopted",
  async () => {
    const reader = readerHarness();
    const wrong = reader.emptyTranslationCache(second, parsed("paper-a"));
    wrong.libraryID = second.libraryID;
    wrong.glossary.manual.push({ source: "beta", target: "wrong" });
    reader.disk.set(await cacheFile(reader, first), JSON.stringify(wrong));
    const loaded = await reader.loadTranslationCache(first, parsed("paper-a"));
    assert.equal(loaded.glossary.manual.length, 0);
    assert.equal(loaded.libraryID, 1);
  },
);

for (const outcome of ["success", "failure"]) {
  await check(
    `B2: MinerU parse ${outcome} invalidates only the owning library's translations`,
    async () => {
      const reader = readerHarness();
      for (const attachment of [first, second]) {
        const cache = await reader.loadTranslationCache(
          attachment,
          parsed("old-source"),
        );
        await reader.saveTranslationCache(attachment, cache);
      }
      const { MinerUService } = loadTS(
        "src/modules/mineru/minerUService.ts",
        {
          "./minerUClient": loadTS("src/modules/mineru/minerUClient.ts"),
          "./structuredDocumentAssembler": loadTS(
            "src/modules/mineru/structuredDocumentAssembler.ts",
          ),
        },
        { ...reader.host, TextEncoder },
      );
      const service = new MinerUService();
      if (outcome === "success") {
        await service.writeCache(
          first,
          {},
          { size: 1, mtime: 1 },
          "paper.pdf",
          {
            files: {},
            structuredSource: {},
          },
          { markdown: "new source" },
        );
      } else {
        await service.writeFailure(
          first,
          {},
          { size: 1, mtime: 1 },
          "paper.pdf",
          "parse failed",
        );
      }
      assert.equal(reader.disk.has(await cacheFile(reader, first)), false);
      assert.equal(reader.disk.has(await cacheFile(reader, second)), true);
    },
  );
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

function indexHarness() {
  const items = new Map();
  const timers = new Map();
  const builds = [];
  const releases = [];
  const lifecycle = [];
  let observer;
  let timerID = 0;
  let enabled = true;
  const timer = (callback, delay) => {
    const id = ++timerID;
    timers.set(id, { callback, delay });
    return id;
  };
  const service = {
    isReady: async () => true,
    isBuildActive: () => false,
    getStats: async () => ({ indexProgress: { status: "idle" } }),
    buildIndex(options) {
      builds.push(options);
      const wait = deferred();
      releases.push(wait.resolve);
      return wait.promise;
    },
  };
  const hooks = loadTS(
    "src/hooks.ts",
    {
      "./modules/serverPreferences": { SERVER_LISTENER_PREFS: {} },
      "./modules/semantic": { getSemanticSearchService: () => service },
      "./modules/semanticIndexColumn": { refreshSemanticColumn() {} },
      "./modules/libraryScope": loadTS("src/modules/libraryScope.ts"),
      "./modules/mineru": {
        getMinerUService: () => ({
          allowAutomaticMarkdown: async (...identity) =>
            lifecycle.push(identity),
          consumeOwnReplacementDeletion: () => false,
          suppressAutomaticMarkdown: async () => {},
        }),
      },
    },
    {
      setTimeout: timer,
      clearTimeout: (id) => timers.delete(id),
      setInterval: () => ++timerID,
      clearInterval() {},
      Zotero: {
        ...quiet,
        Prefs: { get: () => enabled },
        Libraries: { userLibraryID: 1 },
        Items: {
          get: (ids) =>
            Array.isArray(ids)
              ? ids.map((id) => items.get(id))
              : items.get(ids),
        },
        Notifier: {
          registerObserver: (value) => {
            observer = value;
            return "audit";
          },
        },
      },
    },
    "\nexport { registerItemNotifier, pendingAutoUpdateKeys, processPendingAutoUpdates, triggerAutoIndexBuild, isAutoIndexing };\n",
  );
  hooks.registerItemNotifier();
  return {
    hooks,
    items,
    timers,
    builds,
    lifecycle,
    setEnabled: (value) => {
      enabled = value;
    },
    notify: (event, ids) => observer.notify(event, "item", ids, {}),
    complete: (result = { processed: 1, total: 1, status: "completed" }) => {
      assert.ok(releases.length, "an index build must be in flight");
      releases.shift()(result);
    },
    async runTimer(maxDelay) {
      const entry = [...timers].find(([, value]) => value.delay <= maxDelay);
      assert.ok(entry, `a follow-up timer within ${maxDelay}ms must exist`);
      timers.delete(entry[0]);
      entry[1].callback();
      await flush();
    },
  };
}

const paper = (id, libraryID, key) => ({
  id,
  libraryID,
  key,
  deleted: false,
  isRegularItem: () => true,
  isAnnotation: () => false,
  getField: () => "Paper",
});

await check(
  "B3: group add and modify during a periodic build are retained and drained",
  async () => {
    const run = indexHarness();
    run.items.set(99, paper(99, 7, "GROUP123"));
    run.items.set(100, paper(100, 8, "GROUP123"));
    await run.hooks.triggerAutoIndexBuild();
    assert.equal(run.hooks.isAutoIndexing, true);
    await run.notify("add", [99]);
    await run.notify("modify", [99, 100]);
    assert.equal(run.hooks.pendingAutoUpdateKeys.get("7:GROUP123"), true);
    assert.equal(run.hooks.pendingAutoUpdateKeys.get("8:GROUP123"), false);
    await run.runTimer(5000);
    assert.equal(run.builds.length, 1);
    run.complete();
    await flush();
    await run.runTimer(5000);
    assert.equal(run.builds[1].libraryID, 7);
    assert.equal(run.builds[1].force, true);
    assert.deepEqual(Array.from(run.builds[1].itemKeys), ["GROUP123"]);
    run.complete();
    await flush();
    assert.equal(run.builds[2].libraryID, 8);
    assert.equal(run.builds[2].force, false);
    run.complete();
    await flush();
    assert.equal(run.hooks.pendingAutoUpdateKeys.size, 0);
    assert.equal(run.hooks.isAutoIndexing, false);
  },
);

await check(
  "B3: new events during a targeted build trigger a second batch",
  async () => {
    const run = indexHarness();
    run.items.set(1, paper(1, 1, "PERSONAL"));
    run.items.set(99, paper(99, 7, "GROUP123"));
    await run.notify("add", [1]);
    const building = run.hooks.processPendingAutoUpdates();
    await flush();
    await run.notify("add", [99]);
    assert.equal(run.hooks.pendingAutoUpdateKeys.get("7:GROUP123"), true);
    run.complete();
    await building;
    await run.runTimer(5000);
    assert.equal(run.builds[1].libraryID, 7);
    run.complete();
    await flush();
    assert.equal(run.hooks.pendingAutoUpdateKeys.size, 0);
  },
);

await check(
  "B3: generated Markdown notifications do not recursively rebuild their parent",
  async () => {
    const run = indexHarness();
    run.items.set(1, paper(1, 7, "GROUP123"));
    run.items.set(2, {
      ...paper(2, 7, "MARKDOWN"),
      isRegularItem: () => false,
      parentItemKey: "GROUP123",
      attachmentContentType: "text/markdown",
      getField: () => "MinerU Markdown (PDFKEY01).md",
    });
    await run.hooks.triggerAutoIndexBuild();
    await run.notify("add", [2]);
    await run.notify("modify", [2]);
    assert.equal(run.hooks.pendingAutoUpdateKeys.size, 0);
    assert.deepEqual(run.lifecycle, [[7, "PDFKEY01"]]);
    run.complete();
    await flush();
  },
);

await check(
  "B3: retryable failures retain both the old batch and new group work",
  async () => {
    const run = indexHarness();
    run.items.set(1, paper(1, 1, "PERSONAL"));
    run.items.set(99, paper(99, 7, "GROUP123"));
    await run.notify("modify", [1]);
    const building = run.hooks.processPendingAutoUpdates();
    await flush();
    await run.notify("add", [99]);
    run.complete({
      processed: 0,
      total: 1,
      status: "error",
      errorRetryable: true,
    });
    await building;
    assert.equal(run.hooks.pendingAutoUpdateKeys.get("1:PERSONAL"), false);
    assert.equal(run.hooks.pendingAutoUpdateKeys.get("7:GROUP123"), true);
    assert.ok([...run.timers.values()].some((timer) => timer.delay >= 30000));
    assert.equal(run.builds.length, 1);
  },
);

await check(
  "B3: disabling automatic refresh still prevents new work",
  async () => {
    const run = indexHarness();
    run.items.set(99, paper(99, 7, "GROUP123"));
    run.setEnabled(false);
    await run.notify("add", [99]);
    assert.equal(run.hooks.pendingAutoUpdateKeys.size, 0);
    assert.equal(run.builds.length, 0);
  },
);

console.log(
  `${results.filter((result) => result.status === "PASS").length}/${results.length} audit regressions passed`,
);
if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
