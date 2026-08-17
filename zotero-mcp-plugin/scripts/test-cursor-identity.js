/* eslint-env node */

/**
 * Every paged tool must hand back a cursor its OWN store will accept.
 *
 * `windowOf` and `encodeCursor` default to `HYBRID_PAGE_IDENTITY`, while
 * `HybridSearchPageStore.read` decodes with the identity the store was
 * constructed with. Omit the identity at the page-1 call site and the two
 * disagree: page 1 returns a perfectly plausible `hs1_…` cursor, and passing it
 * back fails with "Malformed cursor". The failure is invisible until someone
 * actually pages, which is why find_similar shipped with it.
 *
 * These tests pin the round trip per tool rather than the prefix strings, so a
 * new paged tool that forgets the argument fails here instead of in the field.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("./ts-ext-hooks.mjs", import.meta.url);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  HybridSearchPageStore,
  HYBRID_PAGE_IDENTITY,
  KEYWORD_PAGE_IDENTITY,
  SEMANTIC_PAGE_IDENTITY,
  SIMILAR_PAGE_IDENTITY,
  decodeCursor,
  encodeCursor,
  windowOf,
} = await import("../src/modules/hybridSearchPages.ts");

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

const IDENTITIES = [
  ["hybrid_search", HYBRID_PAGE_IDENTITY],
  ["semantic_search", SEMANTIC_PAGE_IDENTITY],
  ["keyword_search", KEYWORD_PAGE_IDENTITY],
  ["find_similar", SIMILAR_PAGE_IDENTITY],
];

test("every tool has its own cursor prefix", () => {
  const prefixes = IDENTITIES.map(([, identity]) => identity.cursorPrefix);
  assert.equal(
    new Set(prefixes).size,
    prefixes.length,
    `cursor prefixes collide: ${prefixes.join(", ")}`,
  );
  for (const [name, identity] of IDENTITIES) {
    assert.equal(identity.toolName, name);
  }
});

test("a cursor is only decodable by the tool that issued it", () => {
  for (const [, issuer] of IDENTITIES) {
    const cursor = encodeCursor("abc", 20, issuer);
    assert.deepEqual(decodeCursor(cursor, issuer), {
      searchId: "abc",
      offset: 20,
    });
    for (const [, other] of IDENTITIES) {
      if (other === issuer) continue;
      assert.throws(
        () => decodeCursor(cursor, other),
        /Malformed cursor/,
        `${issuer.cursorPrefix} cursor was accepted by ${other.cursorPrefix}`,
      );
    }
  }
});

test("a page-1 window's cursor round-trips through its own store", () => {
  // This is the exact sequence the bug broke: build page 1 with windowOf, then
  // feed its nextCursor to the store that owns the ranking.
  for (const [name, identity] of IDENTITIES) {
    const store = new HybridSearchPageStore(
      undefined,
      undefined,
      undefined,
      identity,
    );
    const ranked = Array.from({ length: 25 }, (_, i) => ({ itemKey: `K${i}` }));
    const fingerprint = {
      query: "q",
      keywords: [],
      appliedMinScore: 0.6,
      language: "all",
      libraryID: 1,
      rrfK: 60,
      keywordWeight: 1,
      semanticWeight: 1,
      pageSize: 5,
      scope: "library",
    };
    const searchId = store.create(fingerprint, ranked, { meta: true });

    const page1 = windowOf(ranked, 0, 5, searchId, identity);
    assert.ok(page1.nextCursor, `${name} page 1 must offer a cursor`);
    assert.ok(
      page1.nextCursor.startsWith(`${identity.cursorPrefix}_`),
      `${name} page 1 emitted a foreign cursor: ${page1.nextCursor}`,
    );

    const { window: page2 } = store.read(page1.nextCursor, {}, undefined);
    assert.equal(page2.offset, 5, `${name} page 2 must continue where 1 ended`);
    assert.deepEqual(
      page2.rows.map((row) => row.itemKey),
      ["K5", "K6", "K7", "K8", "K9"],
    );
  }
});

test("omitting the identity is what produced the bug", () => {
  // Kept as an executable explanation: the default is the hybrid prefix, so a
  // non-hybrid store rejects a window built without its identity.
  const store = new HybridSearchPageStore(
    undefined,
    undefined,
    undefined,
    SEMANTIC_PAGE_IDENTITY,
  );
  const ranked = Array.from({ length: 10 }, (_, i) => ({ itemKey: `K${i}` }));
  const searchId = store.create(
    {
      query: "q",
      keywords: [],
      appliedMinScore: 0.6,
      language: "all",
      libraryID: 1,
      rrfK: 60,
      keywordWeight: 0,
      semanticWeight: 1,
      pageSize: 5,
      scope: "library",
    },
    ranked,
    {},
  );
  const careless = windowOf(ranked, 0, 5, searchId); // no identity
  assert.ok(careless.nextCursor.startsWith("hs1_"));
  assert.throws(() => store.read(careless.nextCursor, {}, undefined), /Malformed cursor/);
});

test("every windowOf call site in the server passes an identity", () => {
  // The type system cannot catch this: the parameter is optional and its
  // default is a valid value. A source check is the only guard available.
  const source = fs.readFileSync(
    path.join(rootDir, "src/modules/streamableMCPServer.ts"),
    "utf8",
  );
  // Each call site is the text from `windowOf<` up to the `);` that closes it.
  const sites = source
    .split("windowOf<")
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf(");")));
  assert.ok(
    sites.length >= 3,
    `expected several windowOf call sites, found ${sites.length}`,
  );
  for (const args of sites) {
    assert.ok(
      /_PAGE_IDENTITY|pageIdentity/.test(args),
      `a windowOf call site omits the page identity and will emit a hybrid cursor:\n${args.slice(0, 200)}`,
    );
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error.message}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
