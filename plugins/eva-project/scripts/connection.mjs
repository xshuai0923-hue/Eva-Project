import { readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const configPath = () => resolve(process.env.EVA_PROJECT_CONFIG || join(homedir(), '.config/eva-project/connection.json'));
export function isPrivateHost(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d+$/.test(p) || Number(p) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
export function validateEndpoint(url, { allowPrivateHttp = false } = {}) {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (local || (allowPrivateHttp && isPrivateHost(u.hostname))))) throw new Error('Use HTTPS; for a private LAN development server, explicitly pass --allow-private-http.');
  if (u.username || u.password || u.search || u.hash) throw new Error('The MCP URL must not contain credentials, a query, or a fragment.');
  if (!u.pathname.endsWith('/mcp')) throw new Error('Use the full Eva MCP endpoint ending in /mcp.');
  return u.href;
}
export function validateConnection(value) {
  if (!value || typeof value.url !== 'string' || typeof value.token !== 'string') throw new Error('Configure an Eva URL and personal MCP token first.');
  const allowPrivateHttp = value.allowPrivateHttp === true;
  const url = validateEndpoint(value.url, { allowPrivateHttp });
  const token = value.token.trim();
  if (token.length < 32 || /[\r\n]/.test(token)) throw new Error('Invalid MCP token format.');
  return { url, token, ...(allowPrivateHttp ? { allowPrivateHttp: true } : {}) };
}
export function loadConnection(file = configPath()) {
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077)) throw new Error('Connection file must be private (chmod 600).');
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Cannot read the Eva connection file. Run configure again.'); }
  return validateConnection(value);
}
export function saveConnection(value, file = configPath()) {
  const config = validateConnection(value);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}
export class EvaTransport {
  constructor(config, { fetchImpl = fetch, timeoutMs = 120000 } = {}) {
    this.config = validateConnection(config); this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
    this.protocol = '2025-11-25'; this.client = 'EvaProjectPlugin/0.1.5'; this.agentName = ''; this.session = null;
  }
  async send(message) {
    if (message.method === 'initialize') {
      const info = message.params?.clientInfo;
      this.agentName = typeof info?.name === 'string' ? info.name.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim().slice(0, 64).toWellFormed() : '';
      const product = typeof info?.name === 'string' ? info.name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) : '';
      const version = typeof info?.version === 'string' ? info.version.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) : '';
      this.client = product ? `${product}/${version || 'unknown'} EvaProjectPlugin/0.1.5` : 'EvaProjectPlugin/0.1.5';
    }
    let response;
    try {
      response = await this.fetch(this.config.url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': this.protocol, 'User-Agent': this.client, ...(this.agentName ? { 'X-Eva-Agent': encodeURIComponent(this.agentName) } : {}), ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) },
        body: JSON.stringify(message)
      });
    } catch { throw new Error('Eva is unreachable or the request timed out. Check its URL/network. A write may have completed; inspect its result before retrying.'); }
    if (!response.ok) {
      const errors = { 401: 'MCP token is invalid or revoked.', 403: 'This account does not have permission.', 404: 'Eva MCP endpoint or session was not found.' };
      throw new Error(errors[response.status] || `Eva returned HTTP ${response.status}.`);
    }
    this.session = response.headers.get('mcp-session-id') || this.session;
    if (response.status === 202 || response.status === 204) return [];
    const raw = await response.text();
    if (!raw.trim()) return [];
    let messages;
    try {
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        messages = raw.replace(/\r\n/g, '\n').split('\n\n').filter(b => b.split('\n').some(l => l.startsWith('data:'))).map(b => JSON.parse(b.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')));
      } else { const parsed = JSON.parse(raw); messages = Array.isArray(parsed) ? parsed : [parsed]; }
    } catch { throw new Error('Eva returned an invalid MCP response.'); }
    if (message.method === 'initialize') {
      const result = messages.find(m => m.id === message.id)?.result;
      if (result && result.serverInfo?.name !== 'eva-project-openproject') throw new Error('The endpoint is not an Eva Project MCP server.');
      if (result?.protocolVersion) this.protocol = result.protocolVersion;
    }
    return messages;
  }
  async call(id, method, params = {}) {
    const messages = await this.send({ jsonrpc: '2.0', id, method, params });
    const result = messages.find(m => m.id === id);
    if (!result) throw new Error('Missing MCP response.');
    if (result.error) throw new Error(`MCP request failed (${result.error.code}).`);
    if (result.result?.isError) throw new Error('Eva rejected the operation. Check account permissions and server compatibility.');
    return result.result;
  }
}
export async function inspectConnection(config) {
  const transport = new EvaTransport(config);
  await transport.call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'eva-project-doctor', version: '0.1.5' } });
  await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const toolList = await transport.call(2, 'tools/list');
  if (!toolList.tools.some(t => t.name === 'eva_connection_info')) throw new Error('Eva server needs the Agent onboarding update (eva_connection_info is missing).');
  const identity = await transport.call(3, 'tools/call', { name: 'eva_connection_info', arguments: {} });
  const projects = await transport.call(4, 'tools/call', { name: 'requirements_projects', arguments: { page_size: 50 } });
  const unpack = result => result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
  return { endpoint: config.url, identity: unpack(identity), projects: unpack(projects), toolCount: toolList.tools.length };
}
