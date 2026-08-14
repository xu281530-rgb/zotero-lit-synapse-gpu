/* eslint-env node */

/**
 * Resolution hook so tests can import plugin sources directly.
 *
 * The plugin is bundled by esbuild, so its internal imports are written without
 * a file extension ("./hybridSearchSettings"). Node's ESM resolver requires
 * one, so a test that pulls in a module with internal imports fails to resolve
 * them. This retries such a specifier with ".ts" appended.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
