/* eslint-env node */

export function getWikiService() {
  return {
    async reverify(libraryID, itemKeys) {
      globalThis.__wikiReverifyCalls?.push({ libraryID, itemKeys });
    },
  };
}
