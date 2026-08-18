/* eslint-env node */

const STUBBED = new Set(["../pdfProcessor", "../mineru"]);

export async function resolve(specifier, context, nextResolve) {
  if (STUBBED.has(specifier)) {
    return nextResolve("./fixtures/stub-build-indexing-deps.mjs", {
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
