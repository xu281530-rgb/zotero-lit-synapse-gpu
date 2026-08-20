/* eslint-env node */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Resolution hook so tests can import plugin sources directly.
 *
 * The plugin is bundled by esbuild, so its internal imports are written without
 * a file extension ("./hybridSearchSettings"). Node's ESM resolver requires
 * one, so a test that pulls in a module with internal imports fails to resolve
 * them. This retries such a specifier with ".ts" appended, and then as a
 * directory barrel ("./mineru" -> "./mineru/index.ts"), which is the other
 * shape esbuild resolves silently.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return await nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    throw error;
  }
}

/**
 * Load hook so tests can import JSON the way the bundled plugin does.
 *
 * esbuild lets a source file pull named bindings straight out of a JSON file
 * ("import { config } from '../../../package.json'"). Node's own JSON modules
 * need a `type: "json"` import attribute and expose only a default export, so
 * such a module fails to load under the test runner. This translates JSON into
 * a small ES module with one named export per top-level key, matching what the
 * bundler produces.
 */
export async function load(url, context, nextLoad) {
  if (!url.endsWith(".json")) return nextLoad(url, context);
  const source = await readFile(fileURLToPath(url), "utf8");
  const names = Object.keys(JSON.parse(source)).filter((key) =>
    /^[A-Za-z_$][\w$]*$/.test(key),
  );
  const body = [
    `const data = ${source};`,
    "export default data;",
    ...names.map(
      (name) => `export const ${name} = data[${JSON.stringify(name)}];`,
    ),
  ].join("\n");
  return { format: "module", shortCircuit: true, source: body };
}
