// Read-only checks inside the local MCP container. Tokens stay in memory;
// no pairing, account creation, work package writes or client installation.
import fs from 'node:fs';
import { request } from 'node:http';
import { MCP_MAX_REQUEST_BYTES, MCP_MAX_TOOL_INPUT_ELEMENTS } from '/app/dist/mcp-http.js';

function check(condition, message) { if (!condition) throw new Error(message); }
const principals = JSON.parse(fs.readFileSync(process.env.MCP_PRINCIPALS_FILE, 'utf8')).principals.filter(p => p.active);
check(principals.length >= 1, 'At least one active local identity is required');
if (process.env.EVA_SECURITY_REQUIRE_TWO_IDENTITIES === '1') {
  check(principals.length >= 2, 'Two isolated test identities are required');
}
const people = principals.slice(0, 2);
const url = 'http://127.0.0.1:8081/mcp';
const headers = person => ({ Authorization: `Bearer ${person.token}`, 'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' });
async function send(body, person = people[0]) {
  return fetch(url, { method: 'POST', headers: headers(person), body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
}
async function rpc(method, params, person = people[0]) {
  const response = await send({ jsonrpc: '2.0', id: 1, method, params }, person);
  check(response.status === 200, `Unexpected MCP HTTP status ${response.status}`);
  const reply = await response.json();
  check(reply.id === 1 && !reply.error, 'Invalid MCP protocol response');
  return reply.result;
}

const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {},
  clientInfo: { name: 'EvaSecurityReadOnlyCheck', version: '1.0' } });
check(init.serverInfo.name === 'eva-project-openproject', 'Unexpected server identity');
const listed = await rpc('tools/list', {});
check(listed.tools.some(tool => tool.name === 'requirements_claim'), 'Tool registration missing');

await Promise.all(Array.from({ length: 40 }, async (_, i) => {
  const person = people[i % people.length];
  const result = await rpc('tools/call', { name: 'eva_connection_info', arguments: {} }, person);
  check(!result.isError && result.structuredContent?.userId === person.userId, 'Concurrent identity isolation failed');
}));

const dense = await rpc('tools/call', { name: 'requirements_projects', arguments: {
  rejectedProbe: Array(MCP_MAX_TOOL_INPUT_ELEMENTS + 1).fill(0)
} });
check(dense.isError && JSON.stringify(dense).includes('maximum'), 'Tool input element bound missing');

const batch = await send(Array.from({ length: 101 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} })));
check(batch.status === 400, 'Batch limit missing');
await batch.arrayBuffer();

const tooLarge = await new Promise((resolve, reject) => {
  const req = request(url, { method: 'POST', headers: { ...headers(people[0]), 'Content-Length': String(MCP_MAX_REQUEST_BYTES + 1) } }, res => {
    res.resume(); res.once('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.setTimeout(5000, () => req.destroy(new Error('Body limit check timed out')));
  req.end('{}');
});
check(tooLarge === 413, 'HTTP body limit missing');

check((await rpc('tools/call', { name: 'eva_connection_info', arguments: {} })).structuredContent?.userId === people[0].userId,
  'Service unavailable after rejected inputs');
console.log(JSON.stringify({ ok: true, tools: listed.tools.length, identities: people.length,
  multiIdentityIsolationVerified: people.length > 1,
  concurrentRequestsWithSameId: 40, oversizedToolInputRejected: true, oversizedBatchRejected: true,
  oversizedBodyRejected: true, serviceStillAvailable: true }));
