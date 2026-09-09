"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const F = require("./fixtures.js");
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
  } catch (error) {
    results.push({ name, status: "FAIL", error: error.stack });
  }
}

function seedCache(
  f,
  dir,
  owner = { libraryID: 1, attachmentKey: "SAMEKEY1" },
) {
  f.disk.set(
    dir + "/raw/content_list.json",
    JSON.stringify([{ type: "text", text: "Legacy A evidence.", page_idx: 0 }]),
  );
  f.dirs.add(dir);
  f.dirs.add(dir + "/raw");
  f.disk.set(
    dir + "/meta.json",
    JSON.stringify({
      version: 2,
      ...owner,
      fileSize: 1000,
      fileMTime: 1000,
      signature: f.s.getSignature(f.s.getConfig()),
      parsedAt: new Date(0).toISOString(),
      fileName: "paper-a.pdf",
      markdownLength: 18,
    }),
  );
}

(async () => {
  await check(
    "C1: same-key Markdown imports use separate temporary files in different libraries",
    async () => {
      const f = F.minerFixture(),
        started = F.deferred(),
        release = F.deferred();
      const original = f.c.Zotero.Attachments.importFromFile;
      f.c.Zotero.Attachments.importFromFile = async (options) => {
        if (options.parentItemID === 11) {
          started.resolve();
          await release.promise;
        }
        return original(options);
      };
      const a = f.s.syncMarkdownAttachment(
        f.a,
        "Paper A temporary bytes",
        "shared.pdf",
        { replaceExisting: true },
      );
      await started.promise;
      try {
        const b = await f.s.syncMarkdownAttachment(
          f.b,
          "Paper B temporary bytes",
          "shared.pdf",
          { replaceExisting: true },
        );
        assert.match(b.markdown, /Paper B/);
      } finally {
        release.resolve();
      }
      assert.match((await a).markdown, /Paper A/);
    },
  );
  await check(
    "C1: matching legacy cache migrates without parsing or removing original files",
    async () => {
      const f = F.minerFixture(),
        legacy = "/test-data/zotero-lit-synapse/mineru/SAMEKEY1";
      seedCache(f, legacy);
      f.disk.set(legacy + "/translation-cache.json", "legacy reader data");
      const before = new Map(f.disk);
      const text = await f.s.getMarkdownForAttachment(f.a, {
        allowParse: false,
        restoreMissingMarkdown: true,
      });
      assert.match(text, /Legacy A/);
      assert.equal(f.parseCalls.length, 0);
      assert.equal((await f.s.readMeta(f.a)).libraryID, 1);
      assert.ok(
        f.disk.has("/test-data/zotero-lit-synapse/mineru/1/SAMEKEY1/meta.json"),
      );
      for (const [file, content] of before)
        assert.equal(f.disk.get(file), content);
      assert.equal((await f.s.getCacheStats()).entries, 1);
    },
  );
  for (const owner of [
    { attachmentKey: "SAMEKEY1" },
    { libraryID: 7, attachmentKey: "SAMEKEY1" },
    { libraryID: 1, attachmentKey: "OTHERKEY" },
  ]) {
    await check(
      "C1: legacy cache with unverified owner is ignored " +
        JSON.stringify(owner),
      async () => {
        const f = F.minerFixture(),
          legacy = "/test-data/zotero-lit-synapse/mineru/SAMEKEY1";
        seedCache(f, legacy, owner);
        const before = new Map(f.disk);
        assert.equal(
          await f.s.getMarkdownForAttachment(f.a, {
            allowParse: false,
            restoreMissingMarkdown: true,
          }),
          null,
        );
        assert.equal(f.imports.length, 0);
        assert.equal(f.parseCalls.length, 0);
        assert.deepEqual([...f.disk], [...before]);
      },
    );
  }
  for (const owner of [
    { libraryID: 7, attachmentKey: "SAMEKEY1" },
    { libraryID: 1, attachmentKey: "OTHERKEY" },
  ]) {
    await check(
      "C1: scoped cache still validates metadata owner " +
        JSON.stringify(owner),
      async () => {
        const f = F.minerFixture();
        seedCache(f, "/test-data/zotero-lit-synapse/mineru/1/SAMEKEY1", owner);
        assert.equal(
          await f.s.getMarkdownForAttachment(f.a, {
            allowParse: false,
            restoreMissingMarkdown: true,
          }),
          null,
        );
        assert.equal(f.imports.length, 0);
      },
    );
  }
  await check(
    "C1: library identity is required for an attachment cache path",
    async () => {
      const f = F.minerFixture();
      assert.throws(
        () => f.s.getAttachmentDir({ key: "SAMEKEY1" }),
        /library/i,
      );
    },
  );
  await check(
    "C1: failure cooldown and cache statistics stay scoped to their libraries",
    async () => {
      const f = F.minerFixture();
      f.stats.set("/pdf/b.pdf", { size: 1000, lastModified: 1000 });
      f.setParse(async (p) => {
        if (p === "/pdf/a.pdf") throw Error("PAPER_A_FAILED");
        return f.result("Paper B evidence.");
      });
      await assert.rejects(
        () =>
          f.s.getMarkdownForAttachment(f.a, {
            force: true,
            allowParse: true,
            userInitiated: true,
          }),
        /PAPER_A_FAILED/,
      );
      assert.match(
        await f.s.getMarkdownForAttachment(f.b, {
          allowParse: true,
          userInitiated: true,
        }),
        /Paper B/,
      );
      assert.match((await f.s.readMeta(f.a)).error, /PAPER_A_FAILED/);
      assert.equal((await f.s.readMeta(f.b)).error, undefined);
      const stats = await f.s.getCacheStats();
      assert.equal(stats.entries, 2);
      assert.ok(stats.bytes > 0);
    },
  );
  const out = process.env.AUDIT_RESULTS || path.join(__dirname, "../results");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, "cache-isolation-results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
