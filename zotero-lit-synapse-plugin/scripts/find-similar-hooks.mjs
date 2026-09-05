/* eslint-env node */

/**
 * Resolution hooks for the find_similar tests.
 *
 * Same extensionless/barrel resolution as ts-ext-hooks, plus a redirect for the
 * two indexing dependencies whose TypeScript constructor parameter properties
 * Node's strip-only mode refuses to load. Similarity search touches neither.
 */
const STUBBED = new Set(["../pdfProcessor", "../mineru"]);

export async function resolve(specifier, context, nextResolve) {
  if (STUBBED.has(specifier)) {
    return nextResolve("./fixtures/stub-indexing-deps.mjs", {
      ...context,
      parentURL: import.meta.url,
    });
  }
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
