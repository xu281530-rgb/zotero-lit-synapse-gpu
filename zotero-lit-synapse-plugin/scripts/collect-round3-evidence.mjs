import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve('..', '..');
const output = path.join(root, 'zotero-lit-synapse-3.0.2-Wiki与笔记审查记录');
await fs.mkdir(output, { recursive: true });
const files = [
  ...['fulltext', 'qa', 'notes', 'http'].map((name) => `.scaffold/test/data/round3-${name}-results.json`),
  ...['fulltext', 'qa', 'notes', 'http'].map((name) => `diagnostics/round3-${name}.test.ts`),
  ...['fulltext', 'qa', 'notes', 'live'].map((name) => `scripts/audit-round3-${name}.mjs`),
  'diagnostics/README-round3.md',
];
for (const file of files) await fs.copyFile(file, path.join(output, path.basename(file)));
const hashes = [];
for (const file of [
  'src/modules/wiki/wikiService.ts',
  'src/modules/wiki/wikiReadingSession.ts',
  'src/modules/wiki/wikiReadingNote.ts',
  'src/modules/wiki/wikiNoteRouting.ts',
  'src/modules/toolCatalog.ts',
  path.join(root, 'zotero-lit-synapse-3.0.2.xpi'),
]) {
  const content = await fs.readFile(file);
  hashes.push({ file: path.resolve(file), bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
}
await fs.writeFile(path.join(output, 'audit-metadata.json'), JSON.stringify({
  capturedAt: new Date().toISOString(),
  productSourceModifiedByThisAudit: false,
  productionChecks: 'Read-only MCP initialization, status and method resources',
  runtimeChecks: 'Current source executed inside an isolated real Zotero profile; synthetic documents, real files and SQLite',
  note: 'Intentional red diagnostics. Read observations to distinguish defects from fixture failures. External embedding responses and explicit failure or scheduling injection are controlled.',
  hashes,
}, null, 2));
console.log(output);
