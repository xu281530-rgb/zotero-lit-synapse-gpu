/* eslint-env node */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

globalThis.ztoolkit = { log: () => {} };

const { MinerUClient, localResponseToStructuredFiles } = await import(
  "../src/modules/mineru/minerUClient.ts"
);

const files = localResponseToStructuredFiles({
  results: {
    paper: {
      md_content: "# MinerU Markdown must be ignored",
      content_list_v2: [[{ type: "paragraph", content: { paragraph_content: [] } }]],
      content_list: [{ type: "text", text: "legacy" }],
      model: [[{ type: "text", content: "model" }]],
      layout: { _version_name: "3.4.4" },
    },
  },
  md_content: "top-level Markdown must also be ignored",
});

assert.deepEqual(
  Object.keys(files).sort(),
  [
    "paper/content_list.json",
    "paper/content_list_v2.json",
    "paper/layout.json",
    "paper/model.json",
  ],
);
assert.equal(Object.values(files).some((value) => value.includes("Markdown must")), false);

globalThis.IOUtils = {
  read: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
};
let submittedBody = "";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  submittedBody = new TextDecoder().decode(options.body);
  return new Response(
    JSON.stringify({
      content_list_v2: [[
        {
          type: "paragraph",
          content: {
            paragraph_content: [{ type: "text", content: "Structured only" }],
          },
        },
      ]],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
try {
  const client = new MinerUClient({
    mode: "local",
    baseURL: "http://127.0.0.1:18101",
    apiToken: "",
    modelVersion: "vlm",
    language: "en",
    enableOCR: false,
    enableFormula: true,
    enableTable: true,
    timeoutSeconds: 30,
    tmpDir: ".",
  });
  const parsed = await client.parseLocalFile("fixture.pdf", "fixture.pdf", "PDFKEY");
  assert.equal(parsed.structuredSource.format, "content_list_v2");
  assert.match(submittedBody, /name="backend"\r\n\r\nvlm-engine\r\n/);
  assert.match(submittedBody, /name="return_md"\r\n\r\nfalse\r\n/);
  assert.doesNotMatch(submittedBody, /vlm-auto-engine/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("MinerU structured client tests passed");
