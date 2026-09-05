import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

async function measure(contents) {
  const built = await build({ stdin: { contents, resolveDir: path.resolve("src/modules"), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
  const catalog = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
  const tools = catalog.projectToolsForList(catalog.buildToolCatalog());
  return { tools: tools.length, characters: JSON.stringify(tools).length };
}

const baseline = execFileSync("git", ["show", "a479ff5d368502acf2e9a9da96b7b715e320c8b3:zotero-lit-synapse-plugin/src/modules/toolCatalog.ts"], { encoding: "utf8" });
const result = {
  baseline: await measure(baseline),
  current: await measure(fs.readFileSync("src/modules/toolCatalog.ts", "utf8")),
  unit: "JavaScript string characters; not tokens or billed cost",
};
fs.writeFileSync(".scaffold/audit-payload.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
