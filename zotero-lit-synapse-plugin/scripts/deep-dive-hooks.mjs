/* eslint-env node */

/**
 * Resolution hooks for the document deep-dive tests.
 *
 * Two jobs: teach Node the extensionless imports esbuild resolves at build
 * time, and swap the semantic-search barrel for a fixture so the deep dive can
 * be exercised without an embedding API or a SQLite vector store.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "./semantic" || specifier === "../semantic") {
    return nextResolve("./fixtures/fake-semantic.mjs", {
      ...context,
      parentURL: import.meta.url,
    });
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
