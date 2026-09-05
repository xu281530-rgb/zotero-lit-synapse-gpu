/* eslint-env node */

/**
 * Regression guard: no `Zotero.DB.queryAsync` row may reach an MCP response.
 *
 * The failure this locks down was reported as `DB column 'toJSON' not found`
 * from `wiki_prepare_update`. Nothing selects a `toJSON` column, and nothing
 * ever asked for one - `JSON.stringify` did. The stringifier probes
 * `value.toJSON` on every object it visits; Zotero's row Proxy forwards the
 * probe to `mozIStorageRow.getResultByName`; the miss is rethrown as
 * `DB column '<name>' not found`. One row anywhere in the returned graph
 * therefore fails the entire tool call, naming a column that never existed.
 *
 * `wiki_prepare_update` hit it through `semanticClaims[].evidence`, which
 * `WikiRetriever.search` used to fill with the raw `wiki_evidence` rows out of
 * the retrieval snapshot. The same rows travel to `wiki_search`, and to
 * `hybrid_search`'s Wiki branch via `documents[].wikiClaims`;
 * `wiki_get_page` leaked Concept, Alias and Relation rows the same way.
 *
 * The fix is to map rows to DTOs at the module boundary (src/modules/wiki/
 * wikiDto.ts), NOT to filter `toJSON` out of the response: `toJSON` is one
 * probe of many - `scrubPathFields` enumerates the same objects on the way out
 * and trips the same trap - and a plain object has no trap to fire at all.
 *
 * So this suite asserts two things of every MCP-facing Wiki result:
 *   - it survives the real serialisation boundary (`scrubPathFields`, then
 *     `JSON.stringify`), and
 *   - no value anywhere in its object graph is a row.
 *
 * The second check is the load-bearing one. `JSON.stringify` succeeding only
 * proves the rows it happened to reach were clean; a row parked behind
 * `scrubPathFields`' depth limit, or in a branch a later change starts
 * populating, would slip through. `isZoteroRow` inspects every node.
 *
 * Both row shapes are exercised: the faithful proxy (what Zotero returns at
 * runtime) and plain objects (what the other Wiki suites' doubles return, and
 * the reason this class of bug survived them).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const { zoteroRow, isZoteroRow, adaptWikiDatabase } = await import(
  "./zotero-row-proxy.mjs"
);

globalThis.Zotero = { Libraries: { userLibraryID: 1 }, debug: () => undefined };
globalThis.ztoolkit = { log: () => undefined };

const { WikiStore } = await import("../src/modules/wiki/wikiStore.ts");
const { WikiService } = await import("../src/modules/wiki/wikiService.ts");
const { getEmbeddingService } = await import(
  "../src/modules/semantic/embeddingService.ts"
);
const { scrubPathFields } = await import("../src/utils/privacy.ts");
const { fuseHybridSearchResultsDetailed } = await import(
  "../src/modules/hybridSearch.ts"
);
const { hashWikiText } = await import(
  "../src/modules/wiki/wikiCanonicalizer.ts"
);

// No embedding backend in this suite. `search` must degrade to a warning and
// still return lexical hits - which is the path `wiki_prepare_update` takes
// here, so the Evidence under `semanticClaims` is real either way.
getEmbeddingService().embed = async () => {
  throw new Error("embedding backend is disabled in this suite");
};

// --- The double must behave like Zotero's row, or none of this is evidence ---
{
  const row = zoteroRow({ evidence_id: 1, last_verified_at: null });
  assert.equal(row.evidence_id, 1);
  assert.equal(row.last_verified_at, null, "an existing NULL column is null");
  assert.throws(
    () => row.toJSON,
    /DB column 'toJSON' not found/u,
    "reading `toJSON` off a row must throw - that IS the reported bug",
  );
  assert.throws(
    () => JSON.stringify(row),
    /DB column 'toJSON' not found/u,
    "so serialising a row must throw with the reported message",
  );
  assert.throws(
    () => JSON.stringify({ claims: [{ evidence: [row] }] }),
    /DB column 'toJSON' not found/u,
    "and a row buried in a response graph must take the whole response down",
  );
  assert.equal(isZoteroRow(row), true);
  assert.equal(isZoteroRow({ evidenceId: 1 }), false);
}

/**
 * Walk `value` and fail on the first row found.
 *
 * Rows are tested BEFORE their contents are read: enumerating a row's keys is
 * itself a way to trip the trap.
 */
function assertNoRows(value, where, seen = new Set()) {
  if (isZoteroRow(value)) {
    assert.fail(`${where} is a Zotero DB row; it must be mapped to a DTO`);
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoRows(entry, `${where}[${index}]`, seen),
    );
    return;
  }
  for (const key of Object.keys(value)) {
    assertNoRows(value[key], `${where}.${key}`, seen);
  }
}

/**
 * Put a result through the exact boundary `tools/call` puts it through, in the
 * same order: structural scrub, then serialise.
 */
function assertMcpSerializable(where, result) {
  assertNoRows(result, where);
  assert.doesNotThrow(
    () => JSON.stringify(scrubPathFields(result)),
    `${where} must survive the MCP serialisation boundary`,
  );
}

const EVIDENCE_DTO_KEYS = [
  "evidenceId",
  "claimId",
  "libraryID",
  "itemKey",
  "chunkIdSnapshot",
  "chunkTextHash",
  "sourceContentHash",
  "sourceChunkSignature",
  "sourceResetGeneration",
  "excerptHash",
  "excerpt",
  "evidenceRole",
  "readDepth",
  "linkState",
  "createdAt",
  "lastVerifiedAt",
].sort();

const CONCEPT_DTO_KEYS = [
  "conceptId",
  "libraryID",
  "canonicalName",
  "normalizedName",
  "conceptType",
  "description",
].sort();

const ALIAS_DTO_KEYS = [
  "aliasId",
  "conceptId",
  "alias",
  "normalizedAlias",
  "language",
  "source",
  "confidence",
].sort();

const RELATION_DTO_KEYS = [
  "relationId",
  "sourceConceptId",
  "predicate",
  "normalizedPredicate",
  "targetConceptId",
  "confidence",
  "createdAt",
].sort();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-serial-"));
const covered = [];

for (const rowShape of ["proxy", "plain"]) {
  const label = `[${rowShape} rows]`;
  const sqlite = new DatabaseSync(path.join(tempDir, `wiki-${rowShape}.sqlite`));
  sqlite.exec("PRAGMA foreign_keys = ON");
  const store = new WikiStore(
    adaptWikiDatabase(sqlite, rowShape, parseQueryAndParams),
  );
  await store.initialize();
  const service = new WikiService(store);

  const chunkText = "Directional solidification narrows the columnar band.";
  const dwellText = "A longer hot-press dwell widens the columnar band.";

  const committed = await store.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "CREATE_PAGE",
        ref: "page:growth",
        primaryConceptRef: "concept:growth",
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
        action: "CREATE_PAGE",
        ref: "page:dwell",
        primaryConceptRef: "concept:dwell",
        canonicalTitle: "Hot press dwell",
        primaryConcept: {
          canonicalName: "hot press dwell",
          conceptType: "process_parameter",
        },
      },
      {
        action: "ADD_CLAIM",
        pageId: "page:growth",
        ref: "claim:growth",
        claimText: chunkText,
        claimType: "mechanism",
        epistemicStatus: "provisional",
        coverageLevel: "chunk_local",
        confidence: 0.7,
        evidence: [
          {
            libraryID: 1,
            itemKey: "ITEMS001",
            chunkIdSnapshot: 2,
            chunkTextHash: await hashWikiText(chunkText),
            sourceContentHash: "content-v1",
            sourceChunkSignature: "paragraph-v3:100:50",
            sourceResetGeneration: "reset-1",
            excerpt: "narrows the columnar band",
            evidenceRole: "SUPPORTS",
            readDepth: "chunk_local",
          },
        ],
      },
      {
        action: "ADD_CLAIM",
        pageId: "page:dwell",
        ref: "claim:dwell",
        claimText: dwellText,
        claimType: "condition",
        epistemicStatus: "provisional",
        coverageLevel: "chunk_local",
        confidence: 0.6,
        evidence: [
          {
            libraryID: 1,
            itemKey: "ITEMS002",
            chunkIdSnapshot: 5,
            chunkTextHash: await hashWikiText(dwellText),
            sourceContentHash: "content-v2",
            sourceChunkSignature: "paragraph-v3:200:60",
            sourceResetGeneration: "reset-1",
            excerpt: "widens the columnar band",
            evidenceRole: "SUPPORTS",
            readDepth: "chunk_local",
          },
        ],
      },
      {
        action: "LINK_RELATION",
        sourceConceptId: "concept:dwell",
        predicate: "controls columnar band width",
        targetConceptId: "concept:growth",
        confidence: 0.8,
      },
    ],
  });

  const growthPageId = committed.refs["page:growth"];
  assert.ok(growthPageId, `${label} the fixture page must exist`);

  // The nullable column, in the state a relink pass leaves it. It must map to
  // `null` in the DTO rather than throw or vanish.
  sqlite.exec(
    "UPDATE wiki_evidence SET last_verified_at = NULL WHERE item_key = 'ITEMS001'",
  );

  const query = "columnar band";

  // --- wiki_prepare_update: the tool the failure was reported from ---
  const prepared = await service.prepareUpdate({
    libraryID: 1,
    query,
    compact: false,
    proposedPageTitles: ["Columnar band control"],
  });
  assertMcpSerializable(`${label} wiki_prepare_update`, prepared);
  assert.ok(
    prepared.semanticClaims.length > 0,
    `${label} the fixture must produce semanticClaims, or this proves nothing`,
  );
  const preparedEvidence = prepared.semanticClaims.flatMap(
    (claim) => claim.evidence,
  );
  assert.ok(
    preparedEvidence.length > 0,
    `${label} semanticClaims must carry Evidence, or this proves nothing`,
  );
  for (const entry of preparedEvidence) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      EVIDENCE_DTO_KEYS,
      `${label} semanticClaims Evidence must be the Evidence DTO`,
    );
    assert.equal(typeof entry.itemKey, "string");
    assert.equal(entry.linkState, "valid");
  }
  const nulled = preparedEvidence.find((entry) => entry.itemKey === "ITEMS001");
  assert.ok(nulled, `${label} the NULL-verified Evidence must be returned`);
  assert.equal(
    nulled.lastVerifiedAt,
    null,
    `${label} a NULL last_verified_at must map to null, not throw or disappear`,
  );
  // The per-title preparations are a second copy of the same shape, and were
  // leaking rows independently of the top-level one.
  assert.ok(
    prepared.pagePreparations.length > 0,
    `${label} prepareUpdate must return pagePreparations`,
  );
  assertMcpSerializable(
    `${label} wiki_prepare_update.pagePreparations`,
    prepared.pagePreparations,
  );
  assert.ok(
    typeof prepared.prepareToken === "string" && prepared.prepareToken,
    `${label} prepareUpdate must still mint a prepare token`,
  );
  const compact = await service.prepareUpdate({ libraryID: 1, query });
  assertMcpSerializable(`${label} compact prepare`, compact);
  const evidencePage = service.getPreparedContext({ libraryID: 1, prepareToken: compact.prepareToken, section: "evidence" });
  assertMcpSerializable(`${label} prepared evidence page`, evidencePage);
  assert.ok(evidencePage.items.length > 0);
  for (const entry of evidencePage.items) {
    assert.deepEqual(Object.keys(entry).sort(), EVIDENCE_DTO_KEYS);
  }

  // --- wiki_search ---
  const searched = await service.search({ libraryID: 1, query, minScore: 0 });
  assertMcpSerializable(`${label} wiki_search`, searched);
  assert.ok(
    searched.claims.length > 0 && searched.claims[0].evidence.length > 0,
    `${label} wiki_search must return Claims carrying Evidence`,
  );
  for (const entry of searched.claims.flatMap((claim) => claim.evidence)) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      EVIDENCE_DTO_KEYS,
      `${label} wiki_search Evidence must be the Evidence DTO`,
    );
  }
  assert.ok(
    searched.relations.length > 0,
    `${label} the relation predicate must match the query, or relations prove nothing`,
  );
  for (const relation of searched.relations) {
    assert.deepEqual(
      Object.keys(relation).sort(),
      RELATION_DTO_KEYS,
      `${label} wiki_search relations must be the Relation DTO`,
    );
  }
  assert.ok(
    searched.documents.length > 0 && searched.documents[0].wikiClaims.length > 0,
    `${label} wiki_search must return documents carrying wikiClaims`,
  );

  // --- wiki_get_page ---
  const page = await service.getPage(growthPageId);
  assertMcpSerializable(`${label} wiki_get_page`, page);
  assert.equal(page.canonicalTitle, "Columnar growth");
  assert.deepEqual(
    Object.keys(page.primaryConcept).sort(),
    CONCEPT_DTO_KEYS,
    `${label} wiki_get_page primaryConcept must be the Concept DTO`,
  );
  assert.equal(page.primaryConcept.canonicalName, "columnar growth");
  assert.equal(
    page.aliases.length,
    1,
    `${label} the page's alias must still be returned`,
  );
  assert.deepEqual(
    Object.keys(page.aliases[0]).sort(),
    ALIAS_DTO_KEYS,
    `${label} wiki_get_page aliases must be the Alias DTO`,
  );
  assert.equal(page.aliases[0].alias, "柱状晶生长");
  assert.equal(
    page.relations.length,
    1,
    `${label} the relation touching this page's concept must be returned`,
  );
  assert.deepEqual(
    Object.keys(page.relations[0]).sort(),
    RELATION_DTO_KEYS,
    `${label} wiki_get_page relations must be the Relation DTO`,
  );
  assert.equal(page.relations[0].predicate, "controls columnar band width");
  assert.equal(
    page.claims[0].evidence[0].lastVerifiedAt,
    null,
    `${label} the page's Evidence must keep its NULL verification stamp`,
  );

  // --- wiki_get_claim: the store's own Evidence mapper ---
  const claim = await store.getClaim(page.claims[0].claimId);
  assertMcpSerializable(`${label} wiki_get_claim`, claim);

  // --- hybrid_search, Wiki branch ---
  // The Wiki route feeds `service.search().documents` straight into fusion,
  // and fusion copies `wikiClaims` onto the ranked results verbatim.
  const fused = fuseHybridSearchResultsDetailed([], [], searched.documents, {
    topK: 10,
    rrfK: 60,
    keywordWeight: 1,
    semanticWeight: 1,
    wikiWeight: 1,
    wikiMinScore: 0,
  });
  assertMcpSerializable(`${label} hybrid_search (wiki branch)`, fused);
  const withClaims = fused.ranked.filter((entry) => entry.wikiClaims?.length);
  assert.ok(
    withClaims.length > 0,
    `${label} fusion must admit Wiki documents, or this proves nothing`,
  );
  for (const entry of withClaims) {
    for (const wikiClaim of entry.wikiClaims) {
      assert.ok(
        Array.isArray(wikiClaim.evidence) && wikiClaim.evidence.length > 0,
        `${label} fused wikiClaims must keep their Evidence`,
      );
    }
  }

  // --- wiki_export renders from the raw snapshot and returns a string ---
  const markdown = await service.exportMarkdown(1);
  assert.match(markdown, /Columnar growth/u, `${label} export must still work`);

  sqlite.close();
  covered.push(rowShape);
}

fs.rmSync(tempDir, { recursive: true, force: true });

console.log(
  `wiki row-serialization suite passed for row shapes: ${covered.join(", ")}`,
);
