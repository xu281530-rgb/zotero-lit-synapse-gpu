/* eslint-env node */

/**
 * Claim confidence is DERIVED, not asserted.
 *
 * The failure this exists to prevent is a field that looks like a judgement
 * and is really a constant. Every Claim in a real 2.7.7 library carried
 * confidence 0.95 - seven Claims, two Pages, several runs, one value - because
 * the tool schema published a bare `{type:'number', minimum:0, maximum:1}`
 * with no description and no server-side check, so the model had nothing to
 * anchor on and filled in a number that looked respectable. The field was not
 * unread: `refreshPageSummary` picks a Page's representative Claims with
 * `ORDER BY confidence DESC`, and a constant turned that into "the five most
 * recently touched", so the summary showed the newest Claims rather than the
 * best-supported ones.
 *
 * So confidence stops being something the model says and becomes something the
 * ledger computes, from the same evidence that already decides
 * `epistemic_status`: how many distinct papers support it, how deeply they were
 * read, and whether anything contradicts it.
 *
 * Each block is named for the thing that has to be true:
 *
 *   1. The formula is a pure function of the ledger, and it separates.
 *   2. A commit that says nothing about confidence is accepted.
 *   3. A commit that DOES say something about confidence is not believed.
 *   4. Two Claims written in one commit differ when their support differs.
 *   5. Later evidence from a second paper raises the number.
 *   6. Contradicting evidence lowers it.
 *   7. The Page summary picks the best-supported Claims, not the newest.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { parseQueryAndParams } = await import("./zotero-db-params.mjs");
const { createZoteroFake } = await import("./wiki-reading-fixtures.mjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zmp-wiki-conf-"));
const fake = createZoteroFake({ rootDir: tempDir });
fake.install();

const { WikiStore, deriveClaimConfidence } = await import(
  "../src/modules/wiki/wikiStore.ts"
);
const { hashWikiText } = await import(
  "../src/modules/wiki/wikiCanonicalizer.ts"
);

function adapt(sqlite) {
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
        return statement.all(...values);
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

const dbPath = path.join(tempDir, "zotero-lit-synapse-wiki.sqlite");
const sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA foreign_keys = ON");
const store = new WikiStore(adapt(sqlite));
await store.initialize();

function block(name, fn) {
  return fn().then(
    () => console.log(`  ok  ${name}`),
    (error) => {
      console.error(`  FAIL  ${name}`);
      throw error;
    },
  );
}

const SUB_GRAIN =
  "Subgrain rotation accumulates misorientation until the boundary crosses fifteen degrees.";
const BULGING =
  "Serrated boundaries bulge locally where the dislocation density gradient is steepest.";
const NO_ROTATION =
  "Rotation reduced the misorientation to one degree without ever forming a high-angle boundary.";

const subGrainHash = await hashWikiText(SUB_GRAIN);
const bulgingHash = await hashWikiText(BULGING);
const noRotationHash = await hashWikiText(NO_ROTATION);

function evidence(options) {
  return {
    libraryID: 1,
    itemKey: options.itemKey,
    chunkIdSnapshot: options.chunkId ?? 3,
    chunkTextHash: options.hash,
    sourceContentHash: "content-v1",
    sourceChunkSignature: "paragraph-v3:1000:500",
    sourceResetGeneration: "reset-17",
    excerpt: options.excerpt,
    evidenceRole: options.role ?? "SUPPORTS",
    readDepth: options.readDepth ?? "section_read",
  };
}

function confidenceOf(claimId) {
  return Number(
    sqlite
      .prepare("SELECT confidence FROM wiki_claims WHERE claim_id = ?")
      .get(claimId).confidence,
  );
}

function statusOf(claimId) {
  return String(
    sqlite
      .prepare("SELECT epistemic_status FROM wiki_claims WHERE claim_id = ?")
      .get(claimId).epistemic_status,
  );
}

console.log("wiki claim confidence");

// --- 1. The formula is a pure function of the ledger ------------------------

await block("the formula separates support breadth and read depth", async () => {
  assert.equal(typeof deriveClaimConfidence, "function");
  const oneShallow = deriveClaimConfidence({
    epistemicStatus: "supported",
    coverageLevel: "chunk_local",
    supportingSourceCount: 1,
  });
  const oneDeep = deriveClaimConfidence({
    epistemicStatus: "supported",
    coverageLevel: "paper_reviewed",
    supportingSourceCount: 1,
  });
  const threeDeep = deriveClaimConfidence({
    epistemicStatus: "corroborated",
    coverageLevel: "paper_reviewed",
    supportingSourceCount: 3,
  });
  assert.ok(
    oneShallow < oneDeep,
    "reading the whole paper must count for more than one chunk of it",
  );
  assert.ok(
    oneDeep < threeDeep,
    "three papers agreeing must count for more than one",
  );
  const unsupported = deriveClaimConfidence({
    epistemicStatus: "unsupported",
    coverageLevel: "chunk_local",
    supportingSourceCount: 0,
  });
  const disputed = deriveClaimConfidence({
    epistemicStatus: "disputed",
    coverageLevel: "section_read",
    supportingSourceCount: 2,
  });
  assert.ok(unsupported < 0.3, "a Claim nothing supports is not 0.95");
  assert.ok(
    disputed <
      deriveClaimConfidence({
        epistemicStatus: "corroborated",
        coverageLevel: "section_read",
        supportingSourceCount: 2,
      }),
    "a contradicted Claim must sit below the same Claim uncontradicted",
  );
  for (const value of [unsupported, disputed, threeDeep]) {
    assert.ok(value >= 0 && value <= 1, "confidence stays inside 0..1");
  }
});

// --- 2 & 3. What the model says about confidence -----------------------------

let claimRotation = 0;
let claimBulging = 0;

await block("a commit may omit confidence entirely", async () => {
  const result = await store.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "CREATE_PAGE",
        ref: "page:nucleation",
        canonicalTitle: "Recrystallisation nucleation",
      },
      {
        action: "ADD_CLAIM",
        ref: "claim:rotation",
        pageId: "page:nucleation",
        claimText:
          "Subgrain rotation drives continuous dynamic recrystallisation once misorientation crosses the high-angle threshold.",
        claimType: "mechanism",
        epistemicStatus: "supported",
        coverageLevel: "section_read",
        evidence: [
          evidence({
            itemKey: "ITEMA001",
            hash: subGrainHash,
            excerpt: "accumulates misorientation until the boundary crosses",
          }),
        ],
      },
    ],
  });
  claimRotation = result.refs["claim:rotation"];
  assert.ok(claimRotation > 0, "the Claim was written without a confidence");
});

await block("a confidence the model supplies is not believed", async () => {
  const result = await store.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "ADD_CLAIM",
        ref: "claim:bulging",
        pageId: Number(
          sqlite
            .prepare(
              "SELECT page_id FROM wiki_pages WHERE normalized_title LIKE '%nucleation%'",
            )
            .get().page_id,
        ),
        claimText:
          "Serrated grain boundaries bulge into the neighbouring grain where the stored-energy gradient is steepest.",
        claimType: "mechanism",
        epistemicStatus: "corroborated",
        coverageLevel: "paper_reviewed",
        confidence: 0.01,
        evidence: [
          evidence({
            itemKey: "ITEMA001",
            chunkId: 7,
            hash: bulgingHash,
            excerpt: "bulge locally where the dislocation density gradient",
            readDepth: "paper_reviewed",
          }),
          evidence({
            itemKey: "ITEMB002",
            chunkId: 9,
            hash: bulgingHash,
            excerpt: "Serrated boundaries bulge locally where the dislocation",
            readDepth: "paper_reviewed",
          }),
        ],
      },
    ],
  });
  claimBulging = result.refs["claim:bulging"];
  assert.ok(
    confidenceOf(claimBulging) > 0.5,
    "a supplied 0.01 must not survive: the ledger says this Claim is well supported",
  );
});

// --- 4. Two Claims in one library differ when their support differs ----------

await block("differently supported Claims get different numbers", async () => {
  assert.equal(statusOf(claimRotation), "supported");
  assert.equal(statusOf(claimBulging), "corroborated");
  assert.notEqual(
    confidenceOf(claimRotation),
    confidenceOf(claimBulging),
    "one paper read in sections and two papers read in full cannot score the same",
  );
  assert.ok(confidenceOf(claimBulging) > confidenceOf(claimRotation));
});

// --- 5. Later evidence moves the number --------------------------------------

await block("a second paper's evidence raises the number", async () => {
  const before = confidenceOf(claimRotation);
  await store.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "ATTACH_EVIDENCE",
        claimId: claimRotation,
        evidence: [
          evidence({
            itemKey: "ITEMC003",
            chunkId: 11,
            hash: subGrainHash,
            excerpt: "until the boundary crosses fifteen degrees",
          }),
        ],
      },
    ],
  });
  assert.equal(statusOf(claimRotation), "corroborated");
  assert.ok(
    confidenceOf(claimRotation) > before,
    "a second independent source has to show up in the number",
  );
});

// --- 6. Contradicting evidence lowers it -------------------------------------

await block("a contradiction lowers the number", async () => {
  const before = confidenceOf(claimRotation);
  await store.commit({
    libraryID: 1,
    userInitiated: true,
    actions: [
      {
        action: "MARK_CONFLICT",
        claimId: claimRotation,
        evidence: [
          evidence({
            itemKey: "ITEMD004",
            chunkId: 13,
            hash: noRotationHash,
            excerpt: "without ever forming a high-angle boundary",
            role: "CONTRADICTS",
          }),
        ],
      },
    ],
  });
  assert.equal(statusOf(claimRotation), "disputed");
  assert.ok(
    confidenceOf(claimRotation) < before,
    "a Claim another paper contradicts cannot keep its corroborated number",
  );
});

// --- 7. The Page summary follows the number ----------------------------------

await block("the Page summary leads with the best-supported Claim", async () => {
  const pageId = Number(
    sqlite
      .prepare(
        "SELECT page_id FROM wiki_pages WHERE normalized_title LIKE '%nucleation%'",
      )
      .get().page_id,
  );
  const summary = String(
    sqlite
      .prepare("SELECT summary FROM wiki_pages WHERE page_id = ?")
      .get(pageId).summary,
  );
  const bulgingAt = summary.indexOf("Serrated grain boundaries bulge");
  const rotationAt = summary.indexOf("Subgrain rotation drives");
  assert.ok(bulgingAt >= 0, "the summary carries the corroborated Claim");
  assert.ok(rotationAt >= 0, "the summary carries the disputed Claim");
  assert.ok(
    bulgingAt < rotationAt,
    "ORDER BY confidence has to mean something: the better-supported Claim leads",
  );
});

console.log("wiki claim confidence: all blocks passed");
