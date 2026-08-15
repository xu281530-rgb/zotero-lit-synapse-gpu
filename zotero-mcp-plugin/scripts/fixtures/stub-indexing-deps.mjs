/* eslint-env node */

/**
 * Stand-ins for the PDF/MinerU dependencies of SemanticSearchService.
 *
 * Nothing here is exercised by the similarity search: it never extracts
 * content, it only reads vectors that indexing already stored. They are stubbed
 * because both real modules use TypeScript constructor parameter properties,
 * which Node's strip-only type stripping cannot load — a build-time detail of
 * the test runner, not a behaviour the tests want to fake away.
 */

export class PDFProcessor {
  constructor() {
    throw new Error("PDFProcessor is not used by similarity search");
  }
}

export function getMinerUService() {
  throw new Error("MinerU is not used by similarity search");
}

export function getOriginalPDFAttachmentsForItem() {
  return [];
}

export function markdownToIndexText() {
  throw new Error("Markdown extraction is not used by similarity search");
}
