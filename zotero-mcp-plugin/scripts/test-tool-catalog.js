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
  projectDoctrineResources,
  projectToolsForList,
  renderToolDoctrine,
  toolDoctrineUri,
  REMOVED_TOOL_REPLACEMENTS,
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
  "move_items_to_collection",
  "merge_items",
  "wiki_set_reading_expert",
  "wiki_update_reading_note",
]);

/**
 * Everything a caller can read about a tool.
 *
 * `description` is served on every turn by tools/list; `doctrine` is served
 * from zotero://tool/<name> on demand. Both reach the model, so an assertion
 * about what a tool SAYS belongs here. Only an assertion about per-turn COST
 * should look at `description` alone.
 */
const served = (tool) => `${tool.description}\n${tool.doctrine ?? ""}`;

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
  // which is the whole difference from the catch-all content tool it replaced.
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

test("reading-note updates advertise append-only inputs", () => {
  const tool = buildToolCatalog().find(
    (candidate) => candidate.name === "wiki_update_reading_note",
  );
  const properties = tool.inputSchema.properties;
  assert.equal(properties.readingRecord.type, "string");
  assert.equal(properties.macroSummary.type, "string");
  assert.equal(properties.markdown.deprecated, true);
  assert.match(served(tool), /record is audited immediately/iu);
  assert.match(served(tool), /appends? .*record/isu);
  assert.doesNotMatch(served(tool), /rewrite the whole|whole note rewritten/iu);
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

test("cursor and collection schemas match their runtime paging contracts", () => {
  const byName = new Map(buildToolCatalog().map((tool) => [tool.name, tool]));

  const hybrid = byName.get("hybrid_search").inputSchema;
  assert.ok(
    !(hybrid.required ?? []).includes("query"),
    "cursor-only hybrid_search continuation must not require query",
  );
  assert.deepEqual(hybrid.anyOf, [
    { required: ["query"] },
    { required: ["cursor"] },
  ]);

  const collections = byName.get("search_collections").inputSchema;
  assert.ok("offset" in collections.properties);
  assert.ok(collections.required.includes("q"));

  const update = byName.get("update_collection").inputSchema;
  assert.deepEqual(update.required, ["collectionKey"]);
  assert.deepEqual(update.anyOf, [
    { required: ["name"] },
    { required: ["parentCollection"] },
  ]);
});

test("tool descriptions expose the repaired read contracts", () => {
  const byName = new Map(buildToolCatalog().map((tool) => [tool.name, tool]));

  const libraries = byName.get("search_libraries");
  assert.match(libraries.description, /results.*pagination.*nextOffset/isu);
  assert.doesNotMatch(libraries.description, /Returns \[\{/u);

  const attachment = byName.get("get_attachment_text");
  assert.match(attachment.description, /standalone attachment/iu);
  assert.match(
    attachment.inputSchema.properties.itemKey.description,
    /standalone attachment/iu,
  );
});

test("fixed-default tools no longer expose content modes", () => {
  for (const name of ["search_library", "get_collections"]) {
    const tool = buildToolCatalog().find((t) => t.name === name);
    assert.ok(!("mode" in tool.inputSchema.properties), `${name} still exposes mode`);
    assert.ok("limit" in tool.inputSchema.properties, `${name} lost paging`);
  }
});

test("disabling writes hides every mutating tool and nothing else", () => {
  const all = filterToolCatalog({
    writeEnabled: true,
    mutatingToolNames: MUTATING,
  }).map((tool) => tool.name);
  const readOnly = filterToolCatalog({
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
  for (const wikiDatabaseTool of [
    "wiki_record_concepts",
    "wiki_prepare_update",
    "wiki_commit",
    "wiki_finish_reading",
  ]) {
    assert.ok(
      readOnly.includes(wikiDatabaseTool),
      `${wikiDatabaseTool} must remain available when Zotero writes are disabled`,
    );
  }
});

test("disabling Wiki hides exactly the Wiki tools", () => {
  const all = filterToolCatalog({
    wikiEnabled: true,
    writeEnabled: true,
    mutatingToolNames: MUTATING,
  }).map((tool) => tool.name);
  const withoutWiki = filterToolCatalog({
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
    wikiEnabled: false,
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
    assert.ok(!WIKI_TOOL_NAMES.has(entry.name), `${entry.name} leaked from disabled Wiki`);
  }
  const chunks = projected.find((t) => t.name === "get_document_chunks");
  assert.equal(chunks.parameters.itemKey.required, false);
  const attachment = projected.find((t) => t.name === "get_attachment_text");
  assert.equal(attachment.parameters.itemKey.required, true);
});

/**
 * The record template is enforced for `session.mode === "fulltext"` only —
 * see the two mode guards in `WikiService.updateReadingNote`. The description
 * used to say "FIXED AND ENFORCED" without saying where, so a model paid for
 * six headings on a three-passage question read and the server checked none of
 * them. These pin the two halves together: the catalog must say which shape
 * belongs to which mode, and must not tell a question read to emit headings.
 */
test("the reading-note templates are advertised as the full-text shape", () => {
  const tools = buildToolCatalog();
  const note = tools.find((t) => t.name === "wiki_update_reading_note");

  // The per-turn record template.
  assert.match(
    served(note),
    /THE RECORD TEMPLATE IS THE FULL-TEXT SHAPE, AND IT IS ENFORCED ONLY THERE/,
    "the record template must be advertised as full-text only",
  );
  assert.match(
    served(note),
    /A QUESTION-DRIVEN RECORD IS NOT HELD TO THOSE SIX SECTIONS/,
    "the question-driven exemption must be stated, not left to be discovered",
  );
  // The six labels are still named, so a full-text read still knows the shape.
  for (const label of [
    "阅读总结",
    "方法",
    "结果与结论",
    "概念与术语",
    "本批覆盖",
    "存疑与未交代",
  ]) {
    assert.ok(
      served(note).includes(label),
      `the full-text record template must still name ${label}`,
    );
  }
  // ...and the count claimed matches the count listed. It said "Five".
  assert.ok(
    !/Five sections, each a line of its own/.test(served(note)),
    "the record template lists six sections and must not claim five",
  );

  // The whole-paper summary template, under the same guard.
  assert.match(
    served(note),
    /THE MACRO SUMMARY TEMPLATE IS THE FULL-TEXT SHAPE AND IS ENFORCED ONLY THERE/,
    "the macro summary template must be advertised as full-text only",
  );

  // The four checks that DO apply in both modes must stay advertised, because
  // they are the quality floor the exemption is safe to sit on.
  for (const promise of [/readChunkIds/, /80%/, /citation/i, /audit/i]) {
    assert.match(
      served(note),
      promise,
      `the mode-independent guarantee ${promise} must stay advertised`,
    );
  }
});

test("wiki_commit says a question is charged only for what it declared", () => {
  const commit = buildToolCatalog().find((t) => t.name === "wiki_commit");
  // `recordDelivery` books every delivered chunk with owes_wiki = 1;
  // `recordReadChunkIds` books only the ids the caller declared. The
  // description used to flatten the two into "a full-text page exactly as
  // much as a passage a question retrieved", which invited a SKIP action for
  // passages that were never on the ledger.
  assert.ok(
    !/a full-text page exactly as much as a passage a question retrieved/.test(
      served(commit),
    ),
    "wiki_commit must not claim a retrieved passage owes what a delivered one does",
  );
  assert.match(
    served(commit),
    /charges every chunk it DELIVERED/,
    "the full-text charging rule must be stated",
  );
  assert.match(
    served(commit),
    /charges only the chunks you DECLARED in readChunkIds/,
    "the question charging rule must be stated",
  );
});

/**
 * The per-turn payload is the thing being protected here.
 *
 * `tools/list` is re-sent on every turn of every conversation. It used to carry
 * every tool's METHOD as well as its contract - the query-construction
 * procedure, the worked examples, the six-section reading-note template - about
 * 42k tokens of it, most of it teaching, and teaching only has to be read once.
 * Splitting `doctrine` out and serving it from zotero://tool/<name> is what
 * bought that back. These tests keep it bought.
 */
test("tools/list carries the contract only, never the method", () => {
  const listed = projectToolsForList(buildToolCatalog());
  for (const tool of listed) {
    assert.deepEqual(
      Object.keys(tool).sort(),
      ["description", "inputSchema", "name"],
      `${tool.name} leaked a field into the per-turn payload`,
    );
  }
  // Whatever moved out must really be out: no tool's list entry may still
  // contain a line that now lives in its doctrine.
  const byName = new Map(buildToolCatalog().map((t) => [t.name, t]));
  for (const entry of listed) {
    const doctrine = byName.get(entry.name).doctrine;
    if (!doctrine) continue;
    const longest = doctrine
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 80)
      .sort((a, b) => b.length - a.length)[0];
    if (!longest) continue;
    assert.ok(
      !entry.description.includes(longest),
      `${entry.name} still ships a doctrine paragraph in tools/list`,
    );
  }
});

test("every tool with a method advertises where to read it", () => {
  const byName = new Map(buildToolCatalog().map((t) => [t.name, t]));
  for (const entry of projectToolsForList(buildToolCatalog())) {
    const tool = byName.get(entry.name);
    if (!tool.doctrine) {
      assert.doesNotMatch(
        entry.description,
        /METHOD: read the resource/,
        `${entry.name} points at a method it does not have`,
      );
      continue;
    }
    // A method nobody is told to read is a method nobody reads.
    assert.ok(
      entry.description.includes(toolDoctrineUri(entry.name)),
      `${entry.name} has a method but never names its URI`,
    );
  }
});

test("the method resources round-trip, and are gated like the tools", () => {
  const all = buildToolCatalog();
  const resources = projectDoctrineResources(all);
  assert.ok(resources.length > 0, "no tool methods are served at all");

  for (const resource of resources) {
    const text = renderToolDoctrine(all, resource.uri);
    assert.ok(text, `${resource.uri} lists but does not resolve`);
    const tool = all.find((t) => toolDoctrineUri(t.name) === resource.uri);
    // Served verbatim: a caller reading this gets exactly what the single
    // description used to say, contract first and then method.
    assert.ok(text.includes(tool.description), `${resource.uri} dropped the contract`);
    assert.ok(text.includes(tool.doctrine), `${resource.uri} dropped the method`);
  }

  assert.equal(renderToolDoctrine(all, "zotero://tool/nope"), null);
  assert.equal(renderToolDoctrine(all, ""), null);

  // A method must never be offered for a tool this build refuses to run: with
  // the Wiki off, resources/list may not advertise a Wiki procedure.
  const withoutWiki = filterToolCatalog({
    wikiEnabled: false,
    writeEnabled: true,
    mutatingToolNames: MUTATING,
  });
  for (const resource of projectDoctrineResources(withoutWiki)) {
    assert.ok(
      !resource.uri.includes("zotero://tool/wiki_"),
      `${resource.uri} survived the Wiki being disabled`,
    );
  }
});

test("the per-turn tool payload stays inside its budget", () => {
  // Measured in characters, because a token count depends on a tokenizer this
  // repo does not ship. ~3.5 chars/token is the ratio for this mixed
  // English/Chinese text, so the ceiling below is roughly 36k tokens.
  const CEILING = 126_000;
  const listed = filterToolCatalog({
    wikiEnabled: true,
    writeEnabled: true,
    mutatingToolNames: MUTATING,
  });
  const size = JSON.stringify(projectToolsForList(listed)).length;
  assert.ok(
    size <= CEILING,
    `tools/list is ${size} chars, over the ${CEILING} ceiling. This payload is ` +
      `re-sent on EVERY turn, so growth here is multiplied by the length of ` +
      `every conversation. Before raising the ceiling, check whether the new ` +
      `text is a CONTRACT (what the tool does, how to read its response) or a ` +
      `METHOD (how to do it well) - a method belongs in \`doctrine\`, which is ` +
      `served on demand from zotero://tool/<name> and costs nothing until read.`,
  );
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
