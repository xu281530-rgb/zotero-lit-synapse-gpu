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
      type: "page_footnote",
      bbox: [10, 250, 90, 269],
      content: {
        page_footnote_content: [{
          type: "text",
          content: "The uncertainty is one standard deviation.",
        }],
      },
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
assert.match(rich, /\$\$E = mc\^2\$\$/);
assert.match(rich, /1\. First\n2\. Second/);
assert.match(rich, /Table 1\. Results/);
assert.match(rich, /\| Alloy \| T \|\n\| --- \| --- \|\n\| AM3 \| 1173 K \|/);
assert.match(rich, /T is temperature\./);
assert.match(rich, /<td rowspan="2">A<\/td>/);
assert.doesNotMatch(rich, /onclick|script|bad\(\)|Journal 42/);
assert.doesNotMatch(rich, /Corresponding author/);
assert.match(rich, /The uncertainty is one standard deviation\./);
assert.match(
  rich,
  /Downloaded by the institutional subscriber\./,
  "MinerU 3.4 page_aside_text is a known text block and must not be discarded",
);
assert.doesNotMatch(rich, /(?:^|\n)7(?:\n|$)/);

const legacyPublicationMetadataFootnote = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([
      {
        type: "page_footnote",
        text: "收稿日期: 2009-06-17; 修订日期: 2009-12-14",
        page_idx: 0,
        bbox: [80, 803, 376, 816],
      },
      {
        type: "page_footnote",
        text: "测量误差为一个标准差。",
        page_idx: 0,
        bbox: [80, 817, 376, 830],
      },
    ]),
  }),
).markdown;
assert.doesNotMatch(
  legacyPublicationMetadataFootnote,
  /收稿日期|修订日期|2009-06-17|2009-12-14/,
  "Chinese submission and revision metadata is page furniture, not document body text",
);
assert.match(
  legacyPublicationMetadataFootnote,
  /测量误差为一个标准差。/,
  "scientific page footnotes remain in the assembled document",
);

const legacy = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([
      { type: "text", text_level: 1, text: "Legacy Document Title", page_idx: 0, bbox: [1, 1, 3, 2] },
      { type: "text", text_level: 2, text: "Legacy Heading", page_idx: 0, bbox: [1, 2, 3, 4] },
      { type: "text", text: "Legacy paragraph.", page_idx: 0, bbox: [1, 5, 3, 6] },
      { type: "equation", text: "$$\n x + y \n$$", page_idx: 0, bbox: [1, 7, 3, 8] },
      {
        type: "table",
        page_idx: 0,
        bbox: [1, 9, 3, 12],
        table_caption: [
          "Table 1",
          "Reference process parameters for simulations.",
        ],
        table_body: "<table><tr><td>Pressure</td><td>100 MPa</td></tr></table>",
      },
    ]),
  }),
);
assert.match(legacy.markdown, /^# Legacy Document Title/m);
assert.match(legacy.markdown, /^## Legacy Heading/m);
assert.match(legacy.markdown, /\$\$x \+ y\$\$/);
assert.match(
  legacy.markdown,
  /Table 1 Reference process parameters for simulations\./,
);

const tightInlineFormula = assembleStructuredDocument(
  selectStructuredSource({
    "content_list_v2.json": JSON.stringify([[
      {
        type: "paragraph",
        bbox: [10, 10, 90, 30],
        content: {
          paragraph_content: [
            { type: "text", content: "Value " },
            { type: "equation_inline", content: "$ x + y $" },
            { type: "text", content: "." },
          ],
        },
      },
    ]]),
  }),
).markdown;
assert.equal(tightInlineFormula, "Value $x + y$.");

const repairedInlineFormulaBoundaries = assembleStructuredDocument(
  selectStructuredSource({
    "content_list_v2.json": JSON.stringify([[
      {
        type: "paragraph",
        bbox: [10, 10, 90, 30],
        content: {
          paragraph_content: [
            { type: "text", content: "The" },
            { type: "equation_inline", content: "N _ { V }" },
            { type: "text", content: "is measured as 10" },
            { type: "equation_inline", content: "^\\circ" },
            { type: "text", content: "C, while (" },
            { type: "equation_inline", content: "x" },
            { type: "text", content: "), and 温度" },
            { type: "equation_inline", content: "T" },
            { type: "text", content: "为 stable." },
          ],
        },
      },
    ]]),
  }),
).markdown;
assert.equal(
  repairedInlineFormulaBoundaries,
  "The $N _ { V }$ is measured as 10 $^\\circ$ C, while ($x$), and 温度 $T$ 为 stable.",
);

const repairedLegacyFormulaBoundaries = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([{
      type: "text",
      page_idx: 0,
      bbox: [10, 10, 90, 30],
      text: "The$N _ { V }$is measured as 10$^\\circ$C, while ($x$), $ \\alpha$, and $x $. Escaped \\$5, $$E = mc^2$$, and $unclosed remain.",
    }]),
  }),
).markdown;
assert.equal(
  repairedLegacyFormulaBoundaries,
  "The $N _ { V }$ is measured as 10 $^\\circ$ C, while ($x$), $\\alpha$, and $x$. Escaped \\$5, $$E = mc^2$$, and $unclosed remain.",
);

const htmlScriptToFormula = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([{
      type: "text",
      page_idx: 0,
      bbox: [10, 10, 90, 30],
      text: "The <sub>γ</sub> phase <sup>［3］</sup> ends <sub>。</sub>",
    }]),
  }),
).markdown;
assert.equal(
  htmlScriptToFormula,
  "The $_{γ}$ phase $^{［3］}$ ends $_{。}$",
  "HTML subscript and superscript wrappers become inline formulas without consuming surrounding spaces",
);
assert.doesNotMatch(htmlScriptToFormula, /<\/?(?:sup|sub)>/i);

const legacyCurrency = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([{
      type: "text",
      page_idx: 0,
      bbox: [10, 10, 90, 30],
      text: "The fees were US$5 and US$10 per sample.",
    }]),
  }),
).markdown;
assert.equal(
  legacyCurrency,
  "The fees were US$5 and US$10 per sample.",
  "clear currency markers are not paired as legacy inline formulas",
);

const legacyTablesContinuation = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([
      {
        type: "text",
        page_idx: 2,
        bbox: [507, 813, 939, 933],
        text: "The melt was melted and degassed with argon for 30 min;",
      },
      { type: "header", page_idx: 2, bbox: [58, 42, 126, 54], text: "B. Zhao et al." },
      { type: "page_number", page_idx: 2, bbox: [492, 952, 505, 960], text: "3" },
      {
        type: "table",
        page_idx: 3,
        bbox: [60, 92, 484, 235],
        table_caption: ["Table 1", "Reference process parameters."],
        table_body: "<table><tr><td>Pressure</td><td>100 MPa</td></tr></table>",
      },
      {
        type: "table",
        page_idx: 3,
        bbox: [58, 290, 484, 322],
        table_caption: ["Table 2", "Chemical composition."],
        table_body: "<table><tr><td>Al</td><td>balance</td></tr></table>",
      },
      {
        type: "text",
        page_idx: 3,
        bbox: [55, 341, 487, 513],
        text: "impurities were picked out, and the melt was held at 700 C.",
      },
    ]),
  }),
);
assert.match(
  legacyTablesContinuation.markdown,
  /degassed with argon for 30 min; impurities were picked out,[\s\S]*Table 1 Reference process parameters\.[\s\S]*Table 2 Chemical composition\./,
  "two tables do not interrupt a strongly continuous cross-page sentence",
);
assert.deepEqual(
  legacyTablesContinuation.blocks
    .filter((block) => block.type === "table")
    .map((block) => block.sourceOrder),
  [3, 4],
  "tables retain their original anchors after the repaired paragraph",
);

const mixedVisualTableContinuation = assembleStructuredDocument(
  selectStructuredSource({
    "content_list_v2.json": JSON.stringify([[
      {
        type: "paragraph",
        bbox: [100, 100, 900, 140],
        content: {
          paragraph_content: [{ type: "text", content: "The response depends on" }],
        },
      },
      {
        type: "image",
        bbox: [100, 150, 900, 230],
        content: { image_caption: ["Fig. 1. First image."] },
      },
      {
        type: "table",
        bbox: [100, 240, 900, 320],
        content: {
          table_caption: ["Table 1", "Parameters."],
          html: "<table><tr><td>A</td></tr></table>",
        },
      },
      {
        type: "chart",
        bbox: [100, 330, 900, 410],
        content: { chart_caption: ["Fig. 2. Chart."] },
      },
      {
        type: "image",
        bbox: [100, 420, 900, 500],
        content: { image_caption: ["Fig. 3. Second image."] },
      },
      {
        type: "paragraph",
        bbox: [100, 510, 900, 540],
        content: {
          paragraph_content: [{ type: "text", content: "the applied" }],
        },
      },
      {
        type: "paragraph",
        bbox: [100, 545, 900, 580],
        content: {
          paragraph_content: [{ type: "text", content: "pressure." }],
        },
      },
    ]]),
  }),
);
assert.match(
  mixedVisualTableContinuation.markdown,
  /The response depends on the applied pressure\.[\s\S]*Fig\. 1\. First image\.[\s\S]*Table 1 Parameters\.[\s\S]*Fig\. 2\. Chart\.[\s\S]*Fig\. 3\. Second image\./,
  "an unlimited mixed visual/table run may be crossed before checking two continuation paragraphs",
);
assert.deepEqual(
  mixedVisualTableContinuation.blocks
    .filter((block) => ["image", "table", "chart"].includes(block.type))
    .map((block) => block.sourceOrder),
  [1, 2, 3, 4],
  "all crossed layout blocks retain source order after the repaired paragraph",
);

const threeTableContinuation = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([
      {
        type: "text",
        page_idx: 0,
        bbox: [100, 100, 900, 140],
        text: "The response depends on",
      },
      ...[1, 2, 3].map((number) => ({
        type: "table",
        page_idx: 0,
        bbox: [100, 150 + number * 80, 900, 210 + number * 80],
        table_caption: [`Table ${number}`, `Parameters ${number}.`],
        table_body: `<table><tr><td>${number}</td></tr></table>`,
      })),
      {
        type: "text",
        page_idx: 0,
        bbox: [100, 470, 900, 510],
        text: "the applied pressure.",
      },
    ]),
  }),
).markdown;
assert.match(
  threeTableContinuation,
  /The response depends on the applied pressure\.[\s\S]*Table 1 Parameters 1\.[\s\S]*Table 2 Parameters 2\.[\s\S]*Table 3 Parameters 3\./,
  "three consecutive tables may be crossed when continuity evidence is strong",
);

const adjacentPageMixedContinuation = assembleStructuredDocument(
  selectStructuredSource({
    "content_list_v2.json": JSON.stringify([
      [
        {
          type: "paragraph",
          bbox: [100, 820, 900, 880],
          content: {
            paragraph_content: [{ type: "text", content: "The response depends on" }],
          },
        },
        {
          type: "image",
          bbox: [100, 890, 900, 950],
          content: { image_caption: ["Fig. 1. Previous-page image."] },
        },
      ],
      [
        {
          type: "chart",
          bbox: [100, 50, 900, 190],
          content: { chart_caption: ["Fig. 2. Next-page chart."] },
        },
        {
          type: "table",
          bbox: [100, 200, 900, 280],
          content: {
            table_caption: ["Table 1", "Next-page values."],
            html: "<table><tr><td>A</td></tr></table>",
          },
        },
        {
          type: "paragraph",
          bbox: [100, 320, 900, 360],
          content: {
            paragraph_content: [{ type: "text", content: "the applied pressure." }],
          },
        },
      ],
    ]),
  }),
).markdown;
assert.match(
  adjacentPageMixedContinuation,
  /The response depends on the applied pressure\.[\s\S]*Previous-page image\.[\s\S]*Next-page chart\.[\s\S]*Table 1 Next-page values\./,
  "a mixed layout run may continue onto the adjacent page before the body resumes",
);

const iuzpmr24DeepPageFigureContinuation = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([
      {
        type: "text",
        page_idx: 3,
        bbox: [507, 791, 939, 938],
        text: "At the same time, they tended to",
      },
      ...[
        [75, 68, 357, 226],
        [357, 68, 638, 226],
        [640, 68, 922, 226],
        [75, 228, 357, 385],
        [357, 228, 640, 385],
        [640, 228, 922, 385],
      ].map((bbox) => ({
        type: "image",
        page_idx: 4,
        bbox,
        image_caption: [],
        content: "",
      })),
      {
        type: "chart",
        page_idx: 4,
        bbox: [77, 390, 492, 635],
        chart_caption: [],
        content: "",
      },
      {
        type: "chart",
        page_idx: 4,
        bbox: [499, 390, 921, 636],
        chart_caption: [
          "Fig. 3. Microstructure and grain size under different pressures.",
        ],
        content: "",
      },
      {
        type: "text",
        page_idx: 4,
        bbox: [55, 687, 487, 925],
        text: "aggregate at the shrinkage holes.",
      },
    ]),
  }),
).markdown;
assert.match(
  iuzpmr24DeepPageFigureContinuation,
  /At the same time, they tended to aggregate at the shrinkage holes\.[\s\S]*Fig\. 3\./,
  "a page-top figure group may occupy more than half the page before its interrupted sentence resumes",
);

const tooDeepPageFigureContinuation = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([
      {
        type: "text",
        page_idx: 3,
        bbox: [100, 820, 900, 900],
        text: "The response depends on",
      },
      {
        type: "image",
        page_idx: 4,
        bbox: [100, 50, 900, 820],
        image_caption: [],
        content: "",
      },
      {
        type: "text",
        page_idx: 4,
        bbox: [100, 880, 900, 920],
        text: "the applied pressure.",
      },
    ]),
  }),
).markdown;
assert.doesNotMatch(
  tooDeepPageFigureContinuation,
  /The response depends on the applied pressure\./,
  "a continuation near the next page bottom remains too ambiguous to merge",
);

const crossPageLayoutAfterContinuation = assembleStructuredDocument(
  selectStructuredSource({
    "content_list_v2.json": JSON.stringify([
      [{
        type: "paragraph",
        bbox: [100, 820, 900, 880],
        content: {
          paragraph_content: [{ type: "text", content: "The response depends on" }],
        },
      }],
      [
        {
          type: "image",
          bbox: [100, 600, 900, 800],
          content: { image_caption: ["Fig. 4. Later-page image."] },
        },
        {
          type: "paragraph",
          bbox: [100, 50, 900, 100],
          content: {
            paragraph_content: [{ type: "text", content: "the applied pressure." }],
          },
        },
      ],
    ]),
  }),
).markdown;
assert.doesNotMatch(
  crossPageLayoutAfterContinuation,
  /The response depends on the applied pressure\./,
  "source order cannot bridge a next-page layout block that is geometrically below the continuation",
);

const bboxlessVisualDetailContinuation = assembleStructuredDocument(
  selectStructuredSource({
    "model.json": JSON.stringify([[
      {
        type: "text",
        bbox: [0.1, 0.1, 0.9, 0.15],
        content: "The time was spent at",
      },
      {
        type: "image_block",
        bbox: [0.1, 0.17, 0.9, 0.45],
        content: null,
      },
      {
        type: "image_caption",
        content: "Fig. 4. Positioned by its image anchor.",
      },
      {
        type: "text",
        bbox: [0.1, 0.47, 0.9, 0.52],
        content: "extreme values.",
      },
    ]]),
  }),
);
assert.match(
  bboxlessVisualDetailContinuation.markdown,
  /The time was spent at extreme values\.[\s\S]*Fig\. 4\. Positioned by its image anchor\./,
  "a bbox-less caption does not veto continuity established by its positioned image anchor",
);

const twoPageGap = assembleStructuredDocument(
  selectStructuredSource({
    "content_list_v2.json": JSON.stringify([
      [{
        type: "paragraph",
        bbox: [100, 820, 900, 880],
        content: {
          paragraph_content: [{ type: "text", content: "The response depends on" }],
        },
      }],
      [{ type: "image", bbox: [100, 50, 900, 900], content: {} }],
      [{
        type: "paragraph",
        bbox: [100, 50, 900, 90],
        content: {
          paragraph_content: [{ type: "text", content: "the applied pressure." }],
        },
      }],
    ]),
  }),
).markdown;
assert.doesNotMatch(
  twoPageGap,
  /The response depends on the applied pressure/,
  "an interrupted paragraph never searches beyond the adjacent page",
);

const chainedThirdPageParagraph = assembleStructuredDocument(
  selectStructuredSource({
    "content_list_v2.json": JSON.stringify([
      [{
        type: "paragraph",
        bbox: [100, 820, 900, 880],
        content: {
          paragraph_content: [{ type: "text", content: "The response depends on" }],
        },
      }],
      [
        { type: "image", bbox: [100, 50, 900, 450], content: {} },
        {
          type: "paragraph",
          bbox: [100, 500, 900, 900],
          content: {
            paragraph_content: [{ type: "text", content: "the applied" }],
          },
        },
      ],
      [{
        type: "paragraph",
        bbox: [100, 50, 900, 90],
        content: {
          paragraph_content: [{ type: "text", content: "pressure." }],
        },
      }],
    ]),
  }),
).markdown;
assert.doesNotMatch(
  chainedThirdPageParagraph,
  /The response depends on the applied pressure\./,
  "the second continuation check cannot extend beyond the original adjacent page",
);

const twoParagraphLookahead = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([
      {
        type: "text",
        page_idx: 2,
        bbox: [507, 813, 939, 933],
        text: "The melt was degassed for 30 min;",
      },
      {
        type: "table",
        page_idx: 3,
        bbox: [60, 92, 484, 235],
        table_caption: ["Table 1", "Reference process parameters."],
        table_body: "<table><tr><td>Pressure</td><td>100 MPa</td></tr></table>",
      },
      {
        type: "text",
        page_idx: 3,
        bbox: [55, 250, 487, 300],
        text: "impurities were picked out, and the melt was",
      },
      {
        type: "text",
        page_idx: 3,
        bbox: [55, 301, 487, 350],
        text: "held at 700 C.",
      },
    ]),
  }),
).markdown;
assert.match(
  twoParagraphLookahead,
  /degassed for 30 min; impurities were picked out, and the melt was held at 700 C\.[\s\S]*Table 1 Reference process parameters\./,
  "an interrupted sentence may consume a second continuous paragraph",
);

const legacyTableIndependentParagraph = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([
      {
        type: "text",
        page_idx: 9,
        bbox: [55, 854, 487, 936],
        text: "The initial driving effect can be markedly improved.",
      },
      {
        type: "table",
        page_idx: 9,
        bbox: [512, 92, 937, 272],
        table_caption: ["Table 3", "Physical properties."],
        table_body: "<table><tr><td>Property</td><td>Value</td></tr></table>",
      },
      {
        type: "text",
        page_idx: 9,
        bbox: [507, 359, 939, 385],
        text: "According to classical nucleation theory, a new analysis follows.",
      },
    ]),
  }),
).markdown;
assert.doesNotMatch(
  legacyTableIndependentParagraph,
  /improved\. According to/,
  "a complete paragraph is not merged across a table",
);

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

const modelVisualContinuation = assembleStructuredDocument(
  selectStructuredSource({
    "model.json": JSON.stringify([[
      {
        type: "text",
        content: "Architecture is documented.",
        bbox: [0.1, 0.05, 0.9, 0.1],
      },
      {
        type: "text",
        content: "Architecture is reproducible.",
        bbox: [0.1, 0.12, 0.9, 0.17],
      },
      {
        type: "text",
        content: "The archi",
        bbox: [0.1, 0.2, 0.9, 0.25],
      },
      {
        type: "image_block",
        content: null,
        bbox: [0.1, 0.27, 0.9, 0.5],
      },
      {
        type: "image_caption",
        content: "Figure 3. Separate model caption.",
        bbox: [0.1, 0.51, 0.9, 0.55],
      },
      {
        type: "text",
        content: "tecture remains stable.",
        bbox: [0.1, 0.56, 0.9, 0.61],
      },
    ]]),
  }),
);
assert.match(
  modelVisualContinuation.markdown,
  /The architecture remains stable\.\n\nFigure 3\. Separate model caption\./,
  "a separate model caption remains independent after the repaired paragraph",
);
assert.equal(
  modelVisualContinuation.blocks.find(
    (block) => block.type === "image_caption",
  )?.sourceOrder,
  4,
);

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

const wordRepair = assembleStructuredDocument(
  selectStructuredSource({
    "content_list_v2.json": JSON.stringify([[
      {
        type: "paragraph",
        bbox: [50, 100, 950, 160],
        content: {
          paragraph_content: [{
            type: "text",
            content: "Processes use differential architecture parameters and interpretability.",
          }],
        },
      },
      {
        type: "paragraph",
        bbox: [50, 170, 950, 230],
        content: {
          paragraph_content: [{
            type: "text",
            content: "Processes retain differential architecture parameters and interpretability.",
          }],
        },
      },
      {
        type: "paragraph",
        bbox: [50, 240, 950, 320],
        content: {
          paragraph_content: [{
            type: "text",
            content: "The archi tecture controls metal AM pro cesses through partial differen tial equations, physical param eters, and model inter pretability.",
          }],
        },
      },
      {
        type: "paragraph",
        bbox: [50, 330, 950, 390],
        content: {
          paragraph_content: [{
            type: "text",
            content: "Keep machine learning, in put, data set, and melt pool unchanged.",
          }],
        },
      },
      {
        type: "paragraph",
        bbox: [50, 400, 950, 450],
        content: {
          paragraph_content: [{
            type: "text",
            content: "input input dataset dataset meltpool meltpool",
          }],
        },
      },
      {
        type: "paragraph",
        bbox: [50, 460, 950, 510],
        content: {
          paragraph_content: [
            { type: "text", content: "The protected formula is " },
            { type: "equation_inline", content: "archi tecture" },
            { type: "text", content: "." },
          ],
        },
      },
      {
        type: "title",
        bbox: [50, 520, 950, 560],
        content: {
          level: 2,
          title_content: [{ type: "text", content: "Archi tecture heading" }],
        },
      },
      {
        type: "table",
        bbox: [50, 570, 950, 650],
        content: {
          html: "<table><tr><td>archi tecture</td></tr></table>",
        },
      },
    ]]),
  }),
).markdown;
assert.match(
  wordRepair,
  /The architecture controls metal AM processes through partial differential equations, physical parameters, and model interpretability\./,
);
assert.match(
  wordRepair,
  /Keep machine learning, in put, data set, and melt pool unchanged\./,
  "normal phrases and short independent words are not joined",
);
assert.match(wordRepair, /\$archi tecture\$/);
assert.match(wordRepair, /## Archi tecture heading/);
assert.match(wordRepair, /\| archi tecture \|/);

const crossParagraphWord = assembleStructuredDocument(
  selectStructuredSource({
    "content_list_v2.json": JSON.stringify([[
      {
        type: "paragraph",
        bbox: [100, 50, 900, 90],
        content: { paragraph_content: [{ type: "text", content: "Architecture is documented." }] },
      },
      {
        type: "paragraph",
        bbox: [100, 100, 900, 140],
        content: { paragraph_content: [{ type: "text", content: "Architecture is reproducible." }] },
      },
      {
        type: "paragraph",
        bbox: [100, 200, 900, 250],
        content: { paragraph_content: [{ type: "text", content: "The archi" }] },
      },
      {
        type: "image",
        bbox: [100, 270, 900, 520],
        content: {
          image_caption: [{ type: "text", content: "Figure 2. Preserved anchor." }],
        },
      },
      {
        type: "paragraph",
        bbox: [100, 540, 900, 590],
        content: { paragraph_content: [{ type: "text", content: "tecture remains stable." }] },
      },
    ]]),
  }),
);
assert.match(
  crossParagraphWord.markdown,
  /The architecture remains stable\.\n\nFigure 2\. Preserved anchor\./,
);
const anchoredFigure = crossParagraphWord.blocks.find(
  (block) => block.type === "image",
);
assert.equal(anchoredFigure?.sourceOrder, 3);
assert.equal(anchoredFigure?.pageIndex, 0);
assert.deepEqual(anchoredFigure?.bbox, [100, 270, 900, 520]);

const realInterruptedExcerpt = assembleStructuredDocument(
  selectStructuredSource({
    "content_list_v2.json": JSON.stringify([
      [
        {
          type: "paragraph",
          bbox: [507, 817, 939, 936],
          content: {
            paragraph_content: [{
              type: "text",
              content: "Statistical measures represent time-varying signals and the time spent at",
            }],
          },
        },
        { type: "page_header", bbox: [58, 42, 132, 54], content: {} },
        { type: "page_header", bbox: [672, 42, 939, 54], content: {} },
        { type: "page_number", bbox: [487, 952, 510, 960], content: {} },
      ],
      [
        {
          type: "image",
          bbox: [110, 69, 882, 370],
          content: {
            image_source: { path: "images/figure-9.jpg" },
            image_caption: [{
              type: "text",
              content: "Fig. 9. Feature engineering by dimension augmentation [100].",
            }],
          },
        },
        {
          type: "paragraph",
          bbox: [58, 407, 157, 419],
          content: {
            paragraph_content: [{ type: "text", content: "extreme values." }],
          },
        },
      ],
    ]),
  }),
);
assert.match(
  realInterruptedExcerpt.markdown,
  /the time spent at extreme values\.\n\nFig\. 9\. Feature engineering/,
  "a page-top figure does not interrupt a sentence continued immediately below it",
);
const realFigure = realInterruptedExcerpt.blocks.find(
  (block) => block.type === "image",
);
assert.equal(realFigure?.sourceOrder, 4);
assert.equal(realFigure?.pageIndex, 1);
assert.deepEqual(realFigure?.bbox, [110, 69, 882, 370]);

const visualNegativeCases = [
  {
    name: "completed paragraph",
    previous: "The experiment is complete.",
    previousBBox: [100, 100, 900, 150],
    imageBBox: [100, 170, 900, 400],
    next: "results begin a separate paragraph.",
    nextBBox: [100, 420, 900, 470],
  },
  {
    name: "independent open paragraph",
    previous: "The experiment yielded reproducible observations",
    previousBBox: [100, 100, 900, 150],
    imageBBox: [100, 170, 900, 400],
    next: "results from a separate validation are reported here.",
    nextBBox: [100, 420, 900, 470],
  },
  {
    name: "large visual gap",
    previous: "The time was spent at",
    previousBBox: [100, 100, 900, 150],
    imageBBox: [100, 170, 900, 300],
    next: "extreme values.",
    nextBBox: [100, 550, 900, 600],
  },
  {
    name: "missing geometry",
    previous: "The time was spent at",
    previousBBox: [],
    imageBBox: [],
    next: "extreme values.",
    nextBBox: [],
  },
];
for (const testCase of visualNegativeCases) {
  const markdown = assembleStructuredDocument(
    selectStructuredSource({
      "content_list_v2.json": JSON.stringify([[
        {
          type: "paragraph",
          bbox: testCase.previousBBox,
          content: { paragraph_content: [{ type: "text", content: testCase.previous }] },
        },
        {
          type: "image",
          bbox: testCase.imageBBox,
          content: { image_caption: [{ type: "text", content: "Figure. Independent." }] },
        },
        {
          type: "paragraph",
          bbox: testCase.nextBBox,
          content: { paragraph_content: [{ type: "text", content: testCase.next }] },
        },
      ]]),
    }),
  ).markdown;
  assert.doesNotMatch(
    markdown,
    new RegExp(`${testCase.previous} ${testCase.next}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `${testCase.name} must not be merged across a figure`,
  );
}

const barrierBlocks = [
  {
    type: "title",
    bbox: [100, 170, 900, 200],
    content: { level: 2, title_content: [{ type: "text", content: "Barrier heading" }] },
  },
  {
    type: "list",
    bbox: [100, 170, 900, 250],
    content: { list_items: [{ item_content: [{ type: "text", content: "Barrier" }] }] },
  },
  {
    type: "equation_interline",
    bbox: [100, 170, 900, 250],
    content: { math_content: "x = 1" },
  },
  {
    type: "page_footnote",
    bbox: [100, 170, 900, 250],
    content: { page_footnote_content: [{ type: "text", content: "Barrier footnote." }] },
  },
];
for (const barrier of barrierBlocks) {
  const markdown = assembleStructuredDocument(
    selectStructuredSource({
      "content_list_v2.json": JSON.stringify([[
        {
          type: "paragraph",
          bbox: [100, 100, 900, 150],
          content: { paragraph_content: [{ type: "text", content: "The time was spent at" }] },
        },
        barrier,
        {
          type: "paragraph",
          bbox: [100, 320, 900, 370],
          content: { paragraph_content: [{ type: "text", content: "extreme values." }] },
        },
      ]]),
    }),
  ).markdown;
  assert.doesNotMatch(
    markdown,
    /time was spent at extreme values/,
    `${barrier.type} is a hard paragraph boundary`,
  );
}

const twoFigures = assembleStructuredDocument(
  selectStructuredSource({
    "content_list_v2.json": JSON.stringify([[
      {
        type: "paragraph",
        bbox: [100, 100, 900, 150],
        content: { paragraph_content: [{ type: "text", content: "The time was spent at" }] },
      },
      { type: "image", bbox: [100, 170, 900, 300], content: {} },
      { type: "image", bbox: [100, 320, 900, 450], content: {} },
      {
        type: "paragraph",
        bbox: [100, 470, 900, 520],
        content: { paragraph_content: [{ type: "text", content: "extreme values." }] },
      },
    ]]),
  }),
).markdown;
assert.match(
  twoFigures,
  /time was spent at extreme values/,
  "consecutive figures remain one bridge when sentence and geometry evidence agree",
);

const visualCaptionOcrResult = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([
      {
        type: "text",
        page_idx: 0,
        bbox: [50, 20, 950, 50],
        text: "Body text remains available.",
      },
      {
        type: "chart",
        page_idx: 0,
        bbox: [100, 100, 900, 300],
        chart_caption: [
          { type: "text", text: "(b)" },
          { type: "text", text: "Fig. 5." },
          { type: "text", text: "XRD patterns under different pressures." },
        ],
        content: "",
      },
      {
        type: "image",
        page_idx: 0,
        bbox: [100, 320, 900, 480],
        image_caption: [
          "Time=18 s",
          "t (s)",
          "Increased plastic strain",
          "温度分布",
        ],
        content: "",
      },
      {
        type: "image",
        page_idx: 0,
        bbox: [100, 500, 900, 620],
        image_caption: ["Fig. 8. MPD charge"],
        content: "",
      },
      {
        type: "image",
        page_idx: 0,
        bbox: [100, 640, 900, 760],
        image_caption: ["图5 拉伸试样尺寸"],
        content: "",
      },
      {
        type: "image",
        page_idx: 0,
        bbox: [100, 780, 900, 860],
        image_caption: [
          "A deliberately long unnumbered explanatory caption with scientific meaning remains.",
        ],
        content: "",
      },
      {
        type: "table",
        page_idx: 0,
        bbox: [100, 880, 900, 940],
        table_caption: ["Table 1", "Parameters."],
        table_body: "<table><tr><td>A</td></tr></table>",
      },
    ]),
  }),
);
const visualCaptionOcr = visualCaptionOcrResult.markdown;
assert.doesNotMatch(visualCaptionOcr, /\(b\)Fig\. 5/);
assert.match(visualCaptionOcr, /Fig\. 5\. XRD patterns/);
assert.doesNotMatch(
  visualCaptionOcr,
  /Time=18 s|t \(s\)|Increased plastic strain|温度分布/,
);
assert.match(visualCaptionOcr, /Fig\. 8\. MPD charge/);
assert.match(visualCaptionOcr, /图5 拉伸试样尺寸/);
assert.match(visualCaptionOcr, /long unnumbered explanatory caption/);
assert.match(visualCaptionOcr, /Table 1 Parameters\./);
const captionlessImageAnchor = visualCaptionOcrResult.blocks.find(
  (block) => block.type === "image" && block.sourceOrder === 2,
);
assert.ok(
  captionlessImageAnchor,
  "an image whose OCR-only caption is removed keeps its positioned block anchor",
);
assert.equal(captionlessImageAnchor.markdown, "");
assert.deepEqual(captionlessImageAnchor.bbox, [100, 320, 900, 480]);

const standaloneVisualOcr = assembleStructuredDocument(
  selectStructuredSource({
    "content_list.json": JSON.stringify([
      {
        type: "text",
        page_idx: 0,
        bbox: [166, 165, 196, 182],
        text: "(b)",
      },
      {
        type: "text",
        page_idx: 0,
        bbox: [489, 171, 517, 187],
        text: "(c)",
      },
      {
        type: "text",
        page_idx: 0,
        bbox: [220, 120, 360, 140],
        text: "125 MPa",
      },
      {
        type: "text",
        page_idx: 0,
        bbox: [220, 145, 310, 165],
        text: "温度分布",
      },
      {
        type: "text",
        page_idx: 0,
        bbox: [140, 100, 180, 120],
        text: "Short edge label",
      },
      {
        type: "image",
        page_idx: 0,
        bbox: [161, 66, 835, 177],
        image_caption: [],
        content: "",
      },
      {
        type: "chart",
        page_idx: 0,
        bbox: [164, 186, 500, 390],
        chart_caption: [
          "Fig. 12. Precipitation strengthening with phase size.",
        ],
        content: "",
      },
      {
        type: "text",
        page_idx: 0,
        bbox: [100, 420, 300, 440],
        text: "Short body fragment",
      },
      {
        type: "text",
        page_idx: 0,
        bbox: [220, 100, 360, 120],
        text: "Stable.",
      },
      {
        type: "text",
        text_level: 2,
        page_idx: 0,
        bbox: [220, 125, 360, 145],
        text: "4. Discussion",
      },
    ]),
  }),
).markdown;
assert.doesNotMatch(standaloneVisualOcr, /(?:^|\n)\(b\)(?:\n|$)/);
assert.doesNotMatch(standaloneVisualOcr, /(?:^|\n)\(c\)(?:\n|$)/);
assert.doesNotMatch(standaloneVisualOcr, /125 MPa|温度分布/);
assert.match(standaloneVisualOcr, /Fig\. 12\. Precipitation strengthening/);
assert.match(standaloneVisualOcr, /Short body fragment/);
assert.match(
  standaloneVisualOcr,
  /Short edge label/,
  "a slight bbox overlap is insufficient evidence to delete short text",
);
assert.match(standaloneVisualOcr, /Stable\./);
assert.match(standaloneVisualOcr, /## 4\. Discussion/);

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
