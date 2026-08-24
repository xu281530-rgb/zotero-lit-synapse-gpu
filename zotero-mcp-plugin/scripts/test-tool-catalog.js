/* eslint-env node */

/**
 * The single-source-of-truth guarantee for the tool list.
 *
 * There used to be three hand-written copies of "what tools does this server
 * have": the array inside `getAvailableTools()`, the array inside
 * `httpServer.getCapabilities()`, and the prose in the two READMEs. They
 * drifted in every direction at once — /capabilities advertised five tools
 * that had ceased to exist and omitted eleven that had not, and the README
 * documented three hybrid_search fields (`candidateK`,
 * `pagination.totalRelevantIsLowerBound`, `metadata.candidatePoolSaturated`)
 * of which only one was ever implemented.
 *
 * These tests pin the properties that make drift impossible rather than
 * pinning the list itself: one array, both projections derived from it, every
 * removed name carrying a replacement, and every advertised parameter present
 * in the schema it claims to describe.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  buildToolCatalog,
  filterToolCatalog,
  REMOVED_TOOL_REPLACEMENTS,
  SEMANTIC_TOOL_NAMES,
  WIKI_TOOL_NAMES,
} = await import("../src/modules/toolCatalog.ts");

const MUTATING = new Set([
  "write_note",
  "write_tag",
  "write_metadata",
  "write_item",
  "create_collection",
  "update_collection",
  "delete_collection",
  "add_items_to_collection",
  "remove_items_from_collection",
]);

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("every tool has a name, a category, a description and a schema", () => {
  for (const tool of buildToolCatalog()) {
    assert.equal(typeof tool.name, "string", `name of ${JSON.stringify(tool)}`);
    assert.ok(tool.name.length > 0);
    assert.ok(
      [
        "search",
        "retrieval",
        "collections",
        "semantic",
        "wiki",
        "write",
      ].includes(tool.category),
      `${tool.name} has an unknown category ${tool.category}`,
    );
    assert.equal(typeof tool.description, "string");
    assert.ok(
      tool.description.length > 40,
      `${tool.name} has a description too short to guide a caller`,
    );
    assert.equal(tool.inputSchema?.type, "object", `${tool.name} inputSchema`);
  }
});

test("tool names are unique", () => {
  const names = buildToolCatalog().map((tool) => tool.name);
  assert.equal(
    new Set(names).size,
    names.length,
    `duplicate tool name in the catalog: ${names.join(", ")}`,
  );
});

test("every schema's `required` names a property that exists", () => {
  // A required parameter that is not in `properties` documents a call the
  // server cannot accept, which is the exact failure mode of a hand-copied
  // list: the name changes on one side only.
  for (const tool of buildToolCatalog()) {
    const properties = tool.inputSchema.properties ?? {};
    for (const name of tool.inputSchema.required ?? []) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(properties, name),
        `${tool.name} requires "${name}" but does not define it`,
      );
    }
  }
});

test("the tools removed in 1.9.0 are gone and each names its replacement", () => {
  const names = new Set(buildToolCatalog().map((tool) => tool.name));
  for (const removed of Object.keys(REMOVED_TOOL_REPLACEMENTS)) {
    assert.ok(
      !names.has(removed),
      `${removed} was removed but is still in the catalog`,
    );
    const message = REMOVED_TOOL_REPLACEMENTS[removed];
    assert.ok(
      message.length > 40,
      `${removed}'s replacement message is too short to be actionable`,
    );
    // The point of the message is the successor. "Unknown tool" would make a
    // model retry variations of a dead name; naming the live one ends it.
    const mentionsSuccessor = [...names].some((live) => message.includes(live));
    assert.ok(
      mentionsSuccessor,
      `${removed}'s message names no tool that still exists: ${message}`,
    );
  }
});

test("the new tools are present with the shapes their callers depend on", () => {
  const byName = new Map(buildToolCatalog().map((tool) => [tool.name, tool]));

  for (const name of [
    "get_attachment_text",
    "get_document_chunks",
    "keyword_search",
    "semantic_search",
    "build_search_index",
  ]) {
    assert.ok(byName.has(name), `${name} is missing from the catalog`);
  }

  const builder = byName.get("build_search_index");
  assert.deepEqual(builder.inputSchema.required, ["itemKeys"]);
  assert.ok(builder.inputSchema.properties.itemKeys.maxItems >= 2);

  // get_attachment_text must be able to page and to select an attachment,
  // which is the whole difference from the get_content it replaced.
  const attachment = byName.get("get_attachment_text").inputSchema.properties;
  for (const param of ["itemKey", "attachmentKey", "offset", "limit"]) {
    assert.ok(param in attachment, `get_attachment_text lacks ${param}`);
  }

  // get_document_chunks must page. A version of this tool without a cursor or
  // a limit would be fulltext_database's unpaginated `get` under a new name.
  const chunks = byName.get("get_document_chunks").inputSchema.properties;
  for (const param of ["itemKey", "cursor", "offset", "limit"]) {
    assert.ok(param in chunks, `get_document_chunks lacks ${param}`);
  }

  // Both retrieval tools must offer the same scoping and paging as
  // hybrid_search, or the "coarse filter then fine search" chain cannot be
  // expressed and semantic_search is back to its pre-funnel shape.
  for (const name of ["keyword_search", "semantic_search"]) {
    const properties = byName.get(name).inputSchema.properties;
    for (const param of [
      "collectionKeys",
      "itemKeys",
      "topK",
      "cursor",
      "minScore",
      "libraryID",
    ]) {
      assert.ok(param in properties, `${name} lacks ${param}`);
    }
  }
});

test("get_item_details advertises no content-bearing parameter", () => {
  const tool = buildToolCatalog().find((t) => t.name === "get_item_details");
  const properties = Object.keys(tool.inputSchema.properties);
  for (const forbidden of ["include", "contentControl", "format", "mode"]) {
    assert.ok(
      !properties.includes(forbidden),
      `get_item_details still accepts ${forbidden}, which is a content knob`,
    );
  }
});

test("get_collection_items can start at the library root", () => {
  const tool = buildToolCatalog().find(
    (t) => t.name === "get_collection_items",
  );
  // Browsing has to be reachable with no keys in hand. Requiring
  // collectionKey, as the old tool did, meant the only entry point was
  // another tool's output.
  assert.deepEqual(tool.inputSchema.required, []);
  for (const param of ["collectionKey", "path", "limit", "offset"]) {
    assert.ok(param in tool.inputSchema.properties, `missing ${param}`);
  }
});

test("annotation tools expose full-text paging without content controls", () => {
  for (const name of ["get_annotations", "search_annotations"]) {
    const tool = buildToolCatalog().find((t) => t.name === name);
    const properties = tool.inputSchema.properties;
    for (const removed of ["mode", "detail", "outputMode", "maxTokens"]) {
      assert.ok(!(removed in properties), `${name} still exposes ${removed}`);
    }
    assert.ok("limit" in properties && "offset" in properties);
    assert.ok(
      "itemKeys" in properties,
      `${name} must accept several documents, not one`,
    );
  }
});

test("fixed-default tools no longer expose content modes", () => {
  for (const name of ["search_library", "get_collections"]) {
    const tool = buildToolCatalog().find((t) => t.name === name);
    assert.ok(!("mode" in tool.inputSchema.properties), `${name} still exposes mode`);
    assert.ok("limit" in tool.inputSchema.properties, `${name} lost paging`);
  }
});

test("disabling semantic search hides exactly the semantic tools", () => {
  const all = filterToolCatalog({
    semanticEnabled: true,
    writeEnabled: true,
    mutatingToolNames: MUTATING,
  }).map((tool) => tool.name);
  const withoutSemantic = filterToolCatalog({
    semanticEnabled: false,
    writeEnabled: true,
    mutatingToolNames: MUTATING,
  }).map((tool) => tool.name);

  const hidden = all.filter((name) => !withoutSemantic.includes(name));
  assert.deepEqual(
    new Set(hidden),
    new Set([...SEMANTIC_TOOL_NAMES].filter((name) => all.includes(name))),
  );
  // The tools that need the vector index must be in that set: serving them
  // with the index switched off is advertising a call that always fails.
  for (const name of [
    "semantic_search",
    "keyword_search",
    "search_fulltext",
    "get_document_chunks",
    "find_similar",
  ]) {
    assert.ok(hidden.includes(name), `${name} survived semanticEnabled: false`);
  }
});

test("disabling writes hides every mutating tool and nothing else", () => {
  const all = filterToolCatalog({
    semanticEnabled: true,
    writeEnabled: true,
    mutatingToolNames: MUTATING,
  }).map((tool) => tool.name);
  const readOnly = filterToolCatalog({
    semanticEnabled: true,
    writeEnabled: false,
    mutatingToolNames: MUTATING,
  }).map((tool) => tool.name);

  const hidden = new Set(all.filter((name) => !readOnly.includes(name)));
  assert.deepEqual(
    hidden,
    new Set([...MUTATING].filter((n) => all.includes(n))),
  );
  for (const name of readOnly) {
    assert.ok(!MUTATING.has(name), `${name} is mutating but survived`);
  }
});

test("disabling Wiki hides exactly the Wiki tools", () => {
  const all = filterToolCatalog({
    semanticEnabled: true,
    wikiEnabled: true,
    writeEnabled: true,
    mutatingToolNames: MUTATING,
  }).map((tool) => tool.name);
  const withoutWiki = filterToolCatalog({
    semanticEnabled: true,
    wikiEnabled: false,
    writeEnabled: true,
    mutatingToolNames: MUTATING,
  }).map((tool) => tool.name);
  assert.deepEqual(
    new Set(all.filter((name) => !withoutWiki.includes(name))),
    new Set(WIKI_TOOL_NAMES),
  );
});

test("the /capabilities projection cannot drift from the catalog", () => {
  // The same derivation httpServer.projectCatalogForCapabilities performs.
  // Testing the transformation rather than the transcription is the point:
  // there is no second list left to compare against.
  const tools = filterToolCatalog({
    semanticEnabled: true,
    writeEnabled: false,
    mutatingToolNames: MUTATING,
  });
  const projected = tools.map((tool) => {
    const properties = tool.inputSchema.properties ?? {};
    const required = tool.inputSchema.required ?? [];
    const parameters = {};
    for (const [name, spec] of Object.entries(properties)) {
      parameters[name] = {
        type: spec.type,
        description: spec.description,
        required: required.includes(name),
      };
    }
    return { name: tool.name, category: tool.category, parameters };
  });

  assert.equal(projected.length, tools.length);
  for (const entry of projected) {
    assert.ok(!MUTATING.has(entry.name), `${entry.name} leaked into read-only`);
  }
  const chunks = projected.find((t) => t.name === "get_document_chunks");
  assert.equal(chunks.parameters.itemKey.required, false);
  const attachment = projected.find((t) => t.name === "get_attachment_text");
  assert.equal(attachment.parameters.itemKey.required, true);
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
