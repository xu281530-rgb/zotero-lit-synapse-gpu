import fs from 'node:fs/promises';
import path from 'node:path';

const endpoint = 'http://127.0.0.1:23120/mcp';
const records = [];
async function request(method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `round3-${records.length}`, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  records.push({ time: new Date().toISOString(), method, params, status: response.status, body });
  if (body.error && method !== 'resources/read') throw new Error(JSON.stringify(body.error));
  return body.result;
}

const initialized = await request('initialize', {
  protocolVersion: '2025-06-18', capabilities: {},
  clientInfo: { name: 'round3-readonly-audit', version: '1' },
});
const status = await request('tools/call', { name: 'wiki_status', arguments: { libraryID: 1 } });
for (const name of ['wiki_build_from_paper', 'wiki_update_reading_note', 'wiki_prepare_update', 'wiki_finish_reading']) {
  await request('resources/read', { uri: `zotero://tool/${name}` });
}
const output = path.resolve('..', '..', 'zotero-lit-synapse-3.0.2-Wiki与笔记审查记录');
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'live-mcp-readonly.json'), JSON.stringify(records, null, 2));
console.log(JSON.stringify({ endpoint, server: initialized.serverInfo, protocol: initialized.protocolVersion, status, evidence: output }, null, 2));
