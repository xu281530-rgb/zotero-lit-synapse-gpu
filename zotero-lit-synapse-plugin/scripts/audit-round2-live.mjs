import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const endpoint = 'http://127.0.0.1:23120/mcp';
const records = [];
async function request(method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `round2-${records.length}`, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  records.push({ method, params, status: response.status, body });
  return body;
}
const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'readonly-review', version: '1' } });
console.log('Installed version:', init.result.serverInfo.version);
const missing = 'ZZZZZZZZ';
for (const [name, args] of [
  ['get_item_details', { itemKey: missing, libraryID: 1 }],
  ['get_document_chunks', { itemKey: missing, libraryID: 1, limit: 1 }],
  ['wiki_status', { libraryID: 1, operationId: 'audit_nonexistent_receipt' }],
]) {
  const response = await request('tools/call', { name, arguments: args });
  console.log(name, JSON.stringify(response.result ?? response.error));
}
const workflow = await request('resources/read', { uri: 'zotero://guide/workflow' });
const method = await request('resources/read', { uri: 'zotero://tool/hybrid_search' });
const tools = await request('tools/list', {});
const methodText = method.result.contents.map((entry) => entry.text).join('\n');
const workflowText = workflow.result.contents.map((entry) => entry.text).join('\n');
console.log('Method promises shadow measurement:', methodText.includes('where it is measured and changes nothing'));
console.log('Workflow states empty library from thresholds:', workflowText.includes('the library has nothing relevant'));
console.log('Live tool count:', tools.result.tools.length);
const directory = 'D:/Zotero_Pluging/zotero-lit-synapse-3.0.1-复查记录';
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(`${directory}/live-mcp.json`, JSON.stringify(records, null, 2));
const missingChunks = records.find((entry) => entry.params.name === 'get_document_chunks').body.result;
assert.equal(missingChunks.isError, true);
assert.ok(!missingChunks.content.some((entry) => entry.text?.includes('has a text attachment')), 'A nonexistent item must not be described as having a text attachment');
