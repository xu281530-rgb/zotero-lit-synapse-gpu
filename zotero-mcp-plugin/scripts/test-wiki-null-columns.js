/* eslint-env node */

/**
 * Regression guard for reading nullable Wiki columns off a real Zotero DB row.
 *
 * `Zotero.DB.queryAsync` does not hand back plain objects. Every SELECT row is
 * wrapped in a Proxy whose `get` trap calls `mozIStorageRow.getResultByName`
 * and rethrows any failure as `DB column '<name>' not found`
 * (Zotero.DBConnection.prototype.queryAsync, chrome/content/zotero/xpcom/db.js).
 * A column the query did not select is therefore not `undefined` - reading it
 * throws and aborts the caller.
 *
 * That makes `row[snake] ?? row[camel]` unsafe: a column that EXISTS but holds
 * NULL short-circuits into the camelCase probe, which is not a column in any
 * Zotero result set, and the read explodes. Both `wiki_pages.primary_concept_id`
 * and `wiki_evidence.last_verified_at` are legitimately NULL.
 *
 * The other Wiki suites adapt node:sqlite straight to plain objects, where a
 * missing key is silently `undefined` - which is exactly why this class of bug
 * survived them. This suite runs the same scenarios twice: once over the
 * faithful proxy rows, once over the plain rows, so both shapes stay covered.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

// Every query below goes through Zotero's real parameter rules, not
// node:sqlite's permissive ones - see scripts/zotero-db-params.mjs.
const { parseQueryAndParams } = await import("./zotero-db-params.mjs");

globalThis.Zotero = { Libraries: { userLibraryID: 1 }, debug: () => undefined };
globalThis.ztoolkit = { log: () => undefined };

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { WikiRetriever } = await import("../src/modules/wiki/wikiRetriever.ts");
const { hashWikiText } = await import(
  "../src/modules/wiki/wikiCanonicalizer.ts"
);

/**
 * A row shaped exactly like the ones `Zotero.DB.queryAsync` returns.
 *
 * Mirrors Zotero's own handler, including the two traps that make naive column
 * probing dangerous:
 *   - `get` throws `DB column '<name>' not found` for an unselected column;
 *   - `has` returns `!!getResultByName(name)`, so `'col' in row` is FALSE for a
 *     column that exists but holds NULL / 0 / '' - `in` cannot test existence
 *     either.
 */
function zoteroRow(columns) {
  const target = {
    getResultByName(name) {
      if (!Object.prototype.hasOwnProperty.call(columns, name)) {
        throw new Error(`no such column: ${name}`);
      }
      return columns[name];
    },
  };
  return new Proxy(target, {
    get(t, name) {
      if (name === "then") return undefined;
      try {
        return t.getResultByName(name);
      } catch {
        throw new Error(`DB column '${String(name)}' not found`);
      }
    },
    has(t, name) {
      try {
        return !!t.getResultByName(name);
      } catch {
        return false;
      }
    },
  });
}

/**
 * @param {DatabaseSync} sqlite
 * @param {"proxy"|"plain"} rowShape - `proxy` reproduces Zotero at runtime;
 *   `plain` reproduces the node:sqlite shape the other Wiki suites use.
 */
function adapt(sqlite, rowShape) {
  let depth = 0;
  const normalize = (params) =>
    params.map((value) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
  return {
    async queryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const statement = sqlite.prepare(sql);
      const values = normalize(params);
      if (/^\s*(select|pragma|with)\b/iu.test(sql)) {
        const rows = statement.all(...values);
        return rowShape === "proxy" ? rows.map(zoteroRow) : rows;
      }
      statement.run(...values);
      return [];
    },
    async valueQueryAsync(rawSql, rawParams = []) {
      const [sql, params] = parseQueryAndParams(rawSql, rawParams);
      const row = sqlite.prepare(sql).get(...normalize(params));
      return row ? Object.values(row)[0] : undefined;
    },
    async executeTransaction(fn) {
      if (depth > 0) return fn();
      depth += 1;
      sqlite.exec("BEGIN");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
}

// The double is only evidence if it behaves the way Zotero's rows behave.
{
  const row = zoteroRow({ primary_concept_id: null, page_id: 7 });
  assert.equal(
    row.primary_concept_id,
    null,
    "an existing NULL column reads as null",
  );
  assert.equal(row.page_id, 7);
  assert.throws(
    () => row.primaryConceptId,
    /DB column 'primaryConceptId' not found/u,
    "an unselected column must throw, exactly as Zotero's proxy does",
  );
  assert.equal(
    "primary_concept_id" in row,
    false,
    "`in` reports false for an existing NULL column - it cannot test existence",
  );
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-null-"));
const covered = [];

for (const rowShape of ["proxy", "plain"]) {
  const label = `[${rowShape} rows]`;
  const sqlite = new DatabaseSync(path.join(tempDir, `wiki-${rowShape}.sqlite`));
  sqlite.exec("PRAGMA foreign_keys = ON");
  const store = new WikiStore(adapt(sqlite, rowShape));
  await store.initialize();
  const service = new WikiService(store);
  const retriever = new WikiRetriever(store);

  const chunkText = "Directional solidification narrows the columnar band.";
  const chunkTextHash = await hashWikiText(chunkText);

  // A page WITH a primary concept.
  const withConcept = await store.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "CREATE_PAGE",
        ref: "page:with",
        primaryConceptRef: "concept:with",
        canonicalTitle: "Columnar growth",
        primaryConcept: {
          canonicalName: "columnar growth",
          conceptType: "process_parameter",
          aliases: [
            {
              alias: "柱状晶生长",
              language: "zh",
              source: "ai",
              confidence: 0.9,
            },
          ],
        },
      },
      {
        action: "ADD_CLAIM",
        pageId: "page:with",
        ref: "claim:with",
        claimText: "Directional solidification narrows the columnar band.",
        claimType: "mechanism",
        epistemicStatus: "provisional",
        coverageLevel: "chunk_local",
        confidence: 0.7,
        evidence: [
          {
            libraryID: 1,
            itemKey: "ITEMN001",
            chunkIdSnapshot: 2,
            chunkTextHash,
            sourceContentHash: "content-v1",
            sourceChunkSignature: "paragraph-v3:100:50",
            sourceResetGeneration: "reset-1",
            excerpt: "narrows the columnar band",
            evidenceRole: "SUPPORTS",
            readDepth: "chunk_local",
          },
        ],
      },
    ],
  });

  // A page WITHOUT a primary concept. CREATE_PAGE permits this, and it writes
  // primary_concept_id as SQL NULL.
  const withoutConcept = await store.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "CREATE_PAGE",
        ref: "page:without",
        canonicalTitle: "Unclassified columnar observations",
      },
      {
        action: "ADD_CLAIM",
        pageId: "page:without",
        ref: "claim:without",
        claimText: "Hot-press dwell time was not reported consistently.",
        claimType: "limitation",
        epistemicStatus: "provisional",
        coverageLevel: "incomplete",
        confidence: 0.4,
        evidence: [
          {
            libraryID: 1,
            itemKey: "ITEMN002",
            chunkIdSnapshot: 5,
            chunkTextHash: await hashWikiText(
              "Dwell time is reported inconsistently across the runs.",
            ),
            sourceContentHash: "content-v2",
            sourceChunkSignature: "paragraph-v3:200:60",
            sourceResetGeneration: "reset-1",
            excerpt: "dwell time is reported inconsistently",
            evidenceRole: "SUPPORTS",
            readDepth: "chunk_local",
          },
        ],
      },
    ],
  });

  const pageWith = withConcept.refs["page:with"];
  const pageWithout = withoutConcept.refs["page:without"];

  assert.equal(
    sqlite
      .prepare("SELECT primary_concept_id FROM wiki_pages WHERE page_id = ?")
      .get(pageWithout).primary_concept_id,
    null,
    `${label} a page created without primaryConcept must store SQL NULL`,
  );

  // Drive the other nullable column to NULL, the state a relink pass leaves.
  sqlite.exec("UPDATE wiki_evidence SET last_verified_at = NULL");
  assert.equal(
    Number(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM wiki_evidence WHERE last_verified_at IS NULL",
        )
        .get().n,
    ),
    2,
    `${label} the NULL last_verified_at fixture must actually exist`,
  );

  // --- getPage(): populated primary concept ---
  const loadedWith = await store.getPage(pageWith);
  assert.ok(loadedWith, `${label} getPage must return the concept-backed page`);
  assert.equal(loadedWith.canonicalTitle, "Columnar growth");
  assert.ok(
    Number.isInteger(loadedWith.primaryConceptId) &&
      loadedWith.primaryConceptId > 0,
    `${label} a present primary concept must survive as its integer id`,
  );
  assert.equal(loadedWith.claims.length, 1);
  assert.equal(
    loadedWith.claims[0].evidence.length,
    1,
    `${label} evidence must still load`,
  );
  assert.equal(
    loadedWith.claims[0].evidence[0].lastVerifiedAt,
    null,
    `${label} a NULL last_verified_at must map to null, not throw`,
  );
  assert.equal(
    loadedWith.claims[0].evidence[0].evidenceRole,
    "SUPPORTS",
    `${label} evidence role must be unchanged`,
  );
  assert.equal(loadedWith.claims[0].evidence[0].linkState, "valid");

  // --- getPage(): NULL primary concept ---
  const loadedWithout = await store.getPage(pageWithout);
  assert.ok(
    loadedWithout,
    `${label} getPage must return the concept-less page`,
  );
  assert.equal(
    loadedWithout.primaryConceptId,
    null,
    `${label} a NULL primary_concept_id must map to null, not throw`,
  );
  assert.equal(loadedWithout.claims.length, 1);
  assert.equal(loadedWithout.claims[0].claimType, "limitation");

  // --- listPages(): the first thing renderWikiPanel awaits ---
  const pages = await store.listPages(1);
  assert.equal(pages.length, 2, `${label} listPages must return both pages`);
  assert.deepEqual(
    pages.map((page) => page.primaryConceptId === null).sort(),
    [false, true],
    `${label} listPages must carry both the set and the NULL concept`,
  );

  // --- prepareUpdate(): joins pages to concepts through primary_concept_id ---
  const prepared = await store.prepareUpdate({
    libraryID: 1,
    query: "columnar growth",
  });
  assert.ok(
    prepared.pages.some((page) => page.pageId === pageWith),
    `${label} prepareUpdate must still rank the concept-backed page`,
  );
  const conceptEntry = prepared.concepts.find(
    (concept) => concept.canonicalName === "columnar growth",
  );
  assert.ok(
    conceptEntry,
    `${label} prepareUpdate must still return the concept`,
  );
  assert.ok(
    conceptEntry.aliases.includes("柱状晶生长"),
    `${label} alias rows from the LEFT JOIN must survive`,
  );
  const preparedWithout = await store.prepareUpdate({
    libraryID: 1,
    query: "unclassified columnar observations",
  });
  assert.ok(
    preparedWithout.pages.some((page) => page.pageId === pageWithout),
    `${label} prepareUpdate must rank a page that has no primary concept`,
  );

  // --- The remaining two loads renderWikiPanel awaits ---
  const status = await store.getStatus(1);
  assert.equal(
    Number(status.pages),
    2,
    `${label} getStatus must count both pages`,
  );
  assert.equal(
    Number(status.evidence),
    2,
    `${label} getStatus must count both evidence rows`,
  );
  const snapshot = await store.getRetrievalSnapshot(1);
  assert.equal(
    snapshot.pages.length,
    2,
    `${label} the retrieval snapshot must expose both pages`,
  );

  // --- Wiki retrieval over a library holding a concept-less page ---
  const retrieved = await retriever.search({
    libraryID: 1,
    query: "columnar band",
  });
  assert.ok(
    Array.isArray(retrieved.claims),
    `${label} retrieval must return a claim list`,
  );
  assert.ok(
    retrieved.claims.some((claim) => claim.pageId === pageWith),
    `${label} retrieval must still rank the concept-backed claim`,
  );
  const scores = retrieved.claims.map((claim) => claim.score);
  assert.deepEqual(
    scores,
    [...scores].sort((a, b) => b - a),
    `${label} retrieval must stay sorted by descending score`,
  );

  // --- Markdown export walks pages, concepts, aliases and relations ---
  const markdown = await service.exportMarkdown(1);
  assert.match(
    markdown,
    /Unclassified columnar observations/u,
    `${label} export must include the concept-less page`,
  );
  assert.match(
    markdown,
    /Concept: columnar growth/u,
    `${label} export must include the concept of the concept-backed page`,
  );

  // --- The graph pane's data source ---
  const graph = await store.getDocumentGraph(1);
  assert.ok(
    Array.isArray(graph.nodes) && Array.isArray(graph.edges),
    `${label} the document graph must build`,
  );

  // --- CRUD must not regress: delete a claim, then delete a whole page ---
  await store.deleteClaim(loadedWithout.claims[0].claimId, 1);
  const afterDelete = await store.getPage(pageWithout);
  assert.equal(
    afterDelete.claims.length,
    0,
    `${label} deleteClaim must remove the claim`,
  );
  // The concept-less page is the awkward one: `primary_concept_id` is SQL
  // NULL, so the deletion plan has to decide "no concept to remove" from a
  // null column rather than tripping over it.
  const removed = await store.deletePage(pageWithout, 1);
  assert.equal(removed.pageId, pageWithout);
  assert.equal(
    removed.concepts,
    0,
    `${label} a page without a primary concept must remove no concept`,
  );
  const survivors = await store.listPages(1);
  assert.equal(
    survivors.length,
    1,
    `${label} deletePage must leave exactly the other page`,
  );
  assert.equal(survivors[0].pageId, pageWith);
  assert.equal(
    survivors[0].claims.length,
    1,
    `${label} the surviving page must keep its claim and evidence`,
  );
  assert.equal(survivors[0].claims[0].evidence.length, 1);
  assert.equal(
    await store.getPage(pageWithout),
    null,
    `${label} the deleted page must be gone`,
  );

  sqlite.close();
  covered.push(rowShape);
}

fs.rmSync(tempDir, { recursive: true, force: true });

console.log(`wiki null-column suite passed for row shapes: ${covered.join(", ")}`);
