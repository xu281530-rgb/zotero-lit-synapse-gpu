/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const {
  ASSEMBLER_VERSION,
  StructuredDocumentError,
  assembleStructuredDocument,
  selectStructuredSource,
} = await import(
  "../src/modules/mineru/structuredDocumentAssembler.ts"
);

assert.equal(typeof ASSEMBLER_VERSION, "number");

const v2 = [
  [
    {
      type: "title",
      bbox: [10, 20, 90, 40],
      content: {
        level: 1,
        title_content: [{ type: "text", content: "Structured Paper" }],
      },
    },
    {
      type: "paragraph",
      bbox: [10, 100, 90, 150],
      content: {
        paragraph_content: [
          { type: "text", content: "Yamasaki et al." },
        ],
      },
    },
    {
      type: "image",
      bbox: [20, 160, 80, 500],
      content: {
        image_source: { path: "images/plot.png" },
        content: "![](images/plot.png)",
        image_caption: [
          {
            type: "text",
            content: "Fig. 1. Temperature was 1173 K.",
          },
        ],
        image_footnote: [],
      },
    },
    {
      type: "paragraph",
      bbox: [10, 520, 90, 570],
      content: {
        paragraph_content: [
          { type: "text", content: "[69, 70] proposed an empirical model." },
        ],
      },
    },
  ],
];

const selected = selectStructuredSource({
  "paper_content_list_v2.json": JSON.stringify(v2),
  "paper_content_list.json": JSON.stringify([{ type: "text", text: "old" }]),
  "full.md": "must never be selected",
});
assert.equal(selected.format, "content_list_v2");
assert.equal(
  selectStructuredSource({
    "layout.json": JSON.stringify({ version: "must-not-be-used" }),
    "paper_content_list_v2.json": JSON.stringify(v2),
  }).parserVersion,
  null,
  "parser version is read only from layout.json._version_name",
);
assert.equal(
  selectStructuredSource({
    "layout.json": JSON.stringify({ _version_name: "3.4.4" }),
    "paper_content_list_v2.json": JSON.stringify(v2),
  }).parserVersion,
  "3.4.4",
);

const assembled = assembleStructuredDocument(selected);
assert.equal(
  assembled.markdown,
  [
    "# Structured Paper",
    "",
    "Yamasaki et al. [69, 70] proposed an empirical model.",
    "",
    "Fig. 1. Temperature was 1173 K.",
  ].join("\n"),
);
assert.doesNotMatch(assembled.markdown, /plot\.png|!\[/);
assert.equal(assembled.blocks.length, 3);
assert.equal(assembled.blocks[1].pageIndex, 0);
assert.deepEqual(assembled.blocks[1].bbox, [10, 100, 90, 150]);

assert.throws(
  () =>
    selectStructuredSource({
      "paper_content_list_v2.json": "{broken",
      "paper_content_list.json": JSON.stringify([{ type: "text", text: "old" }]),
    }),
  (error) =>
    error instanceof StructuredDocumentError &&
    /content_list_v2.*JSON/i.test(error.message),
  "a damaged v2 result must not silently fall back to legacy data",
);

const richV2 = [
  [
    {
      type: "paragraph",
      bbox: [10, 10, 90, 30],
      content: {
        paragraph_content: [
          { type: "text", content: "The stress is " },
          { type: "equation_inline", content: "\\sigma_y" },
          { type: "text", content: "." },
        ],
      },
    },
    {
      type: "equation_interline",
      bbox: [10, 40, 90, 70],
      content: { math_content: "E = mc^2" },
    },
    {
      type: "list",
      bbox: [10, 80, 90, 120],
      content: {
        list_type: "ordered",
        list_items: [
          { item_content: [{ type: "text", content: "First" }] },
          { item_content: [{ type: "text", content: "Second" }] },
        ],
      },
    },
    {
      type: "table",
      bbox: [10, 130, 90, 200],
      content: {
        table_caption: [{ type: "text", content: "Table 1. Results" }],
        html: "<table><tr><th>Alloy</th><th>T</th></tr><tr><td>AM3</td><td>1173 K</td></tr></table>",
        table_footnote: [{ type: "text", content: "T is temperature." }],
      },
    },
    {
      type: "table",
      bbox: [10, 210, 90, 260],
      content: {
        html: "<table onclick=\"bad()\"><tr><td rowspan=\"2\">A</td><td>B</td></tr><tr><td>C</td></tr></table><script>bad()</script>",
      },
    },
    {
      type: "page_header",
      bbox: [10, 0, 90, 5],
      content: { page_header_content: [{ type: "text", content: "Journal 42" }] },
    },
    {
      type: "page_footnote",
      bbox: [10, 270, 90, 290],
      content: { page_footnote_content: [{ type: "text", content: "* Corresponding author." }] },
    },
    {
      type: "page_aside_text",
      bbox: [95, 10, 99, 290],
      content: {
        page_aside_text_content: [
          { type: "text", content: "Downloaded by the institutional subscriber." },
        ],
      },
    },
    {
      type: "page_number",
      bbox: [45, 295, 55, 300],
      content: { page_number_content: [{ type: "text", content: "7" }] },
    },
  ],
];
const rich = assembleStructuredDocument(
  selectStructuredSource({ "content_list_v2.json": JSON.stringify(richV2) }),
).markdown;
assert.match(rich, /The stress is \$\\sigma_y\$\./);
assert.match(rich, /\$\$\nE = mc\^2\n\$\$/);
assert.match(rich, /1\. First\n2\. Second/);
assert.match(rich, /Table 1\. Results/);
assert.match(rich, /\| Alloy \| T \|\n\| --- \| --- \|\n\| AM3 \| 1173 K \|/);
assert.match(rich, /T is temperature\./);
assert.match(rich, /<td rowspan="2">A<\/td>/);
assert.doesNotMatch(rich, /onclick|script|bad\(\)|Journal 42/);
assert.match(rich, /\* Corresponding author\./);
assert.match(
  rich,
  /Downloaded by the institutional subscriber\./,
  "MinerU 3.4 page_aside_text is a known text block and must not be discarded",
);
assert.doesNotMatch(rich, /(?:^|\n)7(?:\n|$)/);

const legacy = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([
      { type: "title", text_level: 2, text: "Legacy Heading", page_idx: 0, bbox: [1, 2, 3, 4] },
      { type: "text", text: "Legacy paragraph.", page_idx: 0, bbox: [1, 5, 3, 6] },
    ]),
  }),
);
assert.equal(legacy.markdown, "## Legacy Heading\n\nLegacy paragraph.");

const model = assembleStructuredDocument(
  selectStructuredSource({
    "model.json": JSON.stringify([
      [
        { type: "doc_title", content: "Model Heading", bbox: [1, 2, 3, 4] },
        { type: "text", content: "Model paragraph.", bbox: [1, 5, 3, 6] },
      ],
    ]),
  }),
);
assert.equal(model.markdown, "# Model Heading\n\nModel paragraph.");

const realModelTypes = assembleStructuredDocument(
  selectStructuredSource({
    "model.json": JSON.stringify([
      [
        { type: "header", content: "Journal header", bbox: [0, 0, 1, 0.05] },
        { type: "list", content: null, bbox: [0.1, 0.1, 0.9, 0.2] },
        { type: "image_block", content: null, bbox: [0.1, 0.2, 0.9, 0.5] },
        { type: "image_caption", content: "Fig. 2. Retained model caption.", bbox: [0.1, 0.51, 0.9, 0.55] },
        { type: "image_footnote", content: "(a) 1173 K; (b) 1273 K", bbox: [0.1, 0.56, 0.9, 0.6] },
        { type: "table_caption", content: "Table 2. Model results", bbox: [0.1, 0.61, 0.9, 0.65] },
        { type: "table", content: "<table><tr><td>A</td><td>1</td></tr></table>", bbox: [0.1, 0.66, 0.9, 0.75] },
        { type: "table_footnote", content: "A is the alloy.", bbox: [0.1, 0.76, 0.9, 0.8] },
        { type: "algorithm", content: "while x < 3 do x = x + 1", bbox: [0.1, 0.81, 0.9, 0.9] },
        { type: "footer", content: "Publisher footer", bbox: [0, 0.95, 1, 1] },
      ],
    ]),
  }),
).markdown;
assert.doesNotMatch(realModelTypes, /Journal header|Publisher footer/);
assert.match(realModelTypes, /Fig\. 2\. Retained model caption\./);
assert.match(realModelTypes, /\(a\) 1173 K; \(b\) 1273 K/);
assert.match(realModelTypes, /Table 2\. Model results/);
assert.match(realModelTypes, /\| A \| 1 \|/);
assert.match(realModelTypes, /A is the alloy\./);
assert.match(realModelTypes, /while x < 3 do x = x \+ 1/);

const midPageSplit = assembleStructuredDocument(
  selectStructuredSource({
    "content_list_v2.json": JSON.stringify([
      [{
        type: "paragraph",
        bbox: [100, 400, 900, 500],
        content: { paragraph_content: [{ type: "text", content: "A complete clause without punctuation" }] },
      }],
      [{
        type: "paragraph",
        bbox: [100, 50, 900, 100],
        content: { paragraph_content: [{ type: "text", content: "continues on another logical column." }] },
      }],
    ]),
  }),
).markdown;
assert.match(
  midPageSplit,
  /punctuation\n\ncontinues/,
  "cross-page paragraphs are not merged when the prior block is only mid-page",
);

assert.throws(
  () =>
    assembleStructuredDocument(
      selectStructuredSource({
        "content_list_v2.json": JSON.stringify([
          [
            {
              type: "future_scientific_block",
              content: { text: "Do not silently discard this result." },
              bbox: [1, 2, 3, 4],
            },
          ],
        ]),
      }),
    ),
  /unsupported text block type/i,
);

console.log("MinerU structured document assembler tests passed");
