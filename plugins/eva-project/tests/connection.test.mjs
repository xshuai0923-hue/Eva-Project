import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { EvaTransport, saveConnection, loadConnection, validateConnection, inspectConnection } from '../scripts/connection.mjs';
const token = 't'.repeat(48);
async function server(t, handler) {
  const instance = createServer(handler); instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${instance.address().port}/mcp`;
}
function mockRpc(req, res) {
  let raw = ''; req.on('data', b => { raw += b; }); req.on('end', () => {
    const m = JSON.parse(raw);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (m.id === undefined) { res.writeHead(202).end();return; }
    const result = m.method === 'initialize' ? { serverInfo: { name: 'eva-project-openproject', version: '0.2.0' }, protocolVersion: '2025-11-25', capabilities: {} }
      : m.method === 'tools/list' ? { tools: [{ name: 'eva_connection_info' }, { name: 'requirements_projects' }] }
        : { structuredContent: m.params.name === 'eva_connection_info' ? { userId: 'alice', displayName: 'Alice', role: 'user' } : { items: [{ identifier: 'team' }], total: 1 } };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
}
test('connection config stays private and rejects unsafe endpoints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eva-config-test-')); const file = join(dir, 'connection.json');
  try {
    saveConnection({ url: 'https://eva.example/mcp', token }, file);
    assert.equal(loadConnection(file).token, token);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    for (const url of ['http://eva.example/mcp', 'https://user:password@eva.example/mcp', 'https://eva.example/mcp?token=secret']) assert.throws(() => validateConnection({ url, token }));
  } finally { rmSync(dir, { recursive: true }); }
});
test('doctor reports identity and projects through real HTTP MCP exchange', async t => {
  const url = await server(t, mockRpc); const result = await inspectConnection({ url, token });
  assert.equal(result.identity.userId, 'alice'); assert.equal(result.projects.items[0].identifier, 'team');
  assert.equal(JSON.stringify(result).includes(token), false);
});
test('SSE responses are decoded and write errors are never retried', async t => {
  let calls = 0;
  const url = await server(t, (req, res) => { calls++; if (calls === 1) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\r\n\r\n'); } else { res.writeHead(500).end(token); } });
  const transport = new EvaTransport({ url, token });
  assert.deepEqual(await transport.call(1, 'tools/list'), { ok: true });
  await assert.rejects(transport.call(2, 'tools/call', { name: 'requirements_create' }), /HTTP 500/);
  assert.equal(calls, 2);
});
test('credentials are not sent to redirect destinations', async t => {
  let leaked = false;
  const other = await server(t, (_, res) => { leaked = true; res.end('{}'); });
  const url = await server(t, (_, res) => { res.writeHead(307, { Location: other }).end(); });
  await assert.rejects(new EvaTransport({ url, token }).call(1, 'tools/list'), /unreachable/);
  assert.equal(leaked, false);
});
test('installed stdio bridge returns protocol responses without secrets on stdout', async t => {
  const url = await server(t, mockRpc); const dir = mkdtempSync(join(tmpdir(), 'eva-stdio-test-')); const file = join(dir, 'connection.json');
  t.after(() => rmSync(dir, { recursive: true, force: true })); saveConnection({ url, token }, file);
  const child = spawn(process.execPath, [resolve('plugins/eva-project/scripts/mcp.mjs')], { env: { ...process.env, EVA_PROJECT_CONFIG: file }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex' } } }) + '\n');
  await once(child, 'exit'); assert.equal(child.exitCode, 0); assert.equal(errors, '');
  assert.equal(JSON.parse(output).result.serverInfo.name, 'eva-project-openproject'); assert.equal(output.includes(token), false);
});
test('installer upgrades keep the separate connection file unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eva-install-test-')), config = join(dir, 'private/connection.json'), destination = join(dir, 'marketplace');
  try {
    saveConnection({ url: 'https://eva.example/mcp', token }, config); const before = readFileSync(config, 'utf8');
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, ['plugins/eva-project/scripts/setup.mjs', 'install', '--client', 'both', '--destination', destination, '--prepare-only'], { env: { ...process.env, EVA_PROJECT_CONFIG: config }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr); assert.equal(readFileSync(config, 'utf8'), before);
    }
    const mcp = JSON.parse(readFileSync(join(destination, 'plugins/eva-project/.mcp.json')));
    assert.equal(mcp.mcpServers['eva-project'].command, process.execPath);
    assert.equal(JSON.stringify(mcp).includes(token), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('connect receives a token only after approval and never prints it', async t => {
  let polled = 0;
  let url;
  url = await server(t, (req, res) => {
    if (req.url === '/mcp') { mockRpc(req, res); return; }
    let raw = '';req.on('data', b => { raw += b; });req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/agent-connect/start') res.end(JSON.stringify({ device_code: 'd'.repeat(64), user_code: 'AABBCCDDEEFF', expires_in: 30, verification_uri: url.replace('/mcp', '/agent-access?code=AABBCCDDEEFF') }));
      else { assert.equal(JSON.parse(raw).device_code, 'd'.repeat(64)); polled++;res.end(JSON.stringify({ status: 'connected', token })); }
    });
  });
  const dir = mkdtempSync(join(tmpdir(), 'eva-pair-test-')), config = join(dir, 'connection.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['plugins/eva-project/scripts/setup.mjs', 'connect', '--client', 'codex', '--server', url, '--no-open'], { env: { ...process.env, EVA_PROJECT_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';child.stdout.on('data', b => { output += b; });child.stderr.on('data', b => { errors += b; });
  await once(child, 'exit');assert.equal(child.exitCode, 0, errors);assert.equal(polled, 1);
  assert.equal(loadConnection(config).token, token);assert.equal(output.includes(token), false);assert.equal(errors.includes(token), false);
  assert.match(output, /AABBCCDDEEFF/);assert.match(output, /alice/);
});
test('private LAN HTTP requires explicit consent and never allows a public host', () => {
  const url = 'http://192.168.200.40:28081/mcp';
  assert.throws(() => validateConnection({ url, token }));
  assert.equal(validateConnection({ url, token, allowPrivateHttp: true }).url, url);
  for (const url of ['http://203.0.113.1/mcp', 'http://10.evil.example/mcp', 'http://172.32.1.1/mcp']) assert.throws(() => validateConnection({ url, token, allowPrivateHttp: true }));
});
test('generic preparation succeeds without any client CLI available', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eva-generic-test-'));
  try {
    const r = spawnSync(process.execPath, ['plugins/eva-project/scripts/setup.mjs', 'install', '--client', 'generic', '--destination', dir], { env: { ...process.env, PATH: '' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.mcp.mcpServers['eva-project'].command, process.execPath);
    assert.ok(result.skills.startsWith(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('actual bridge requests retain each client in production history signatures', async t => {
  const { channelFromRequest, signed, parseSignature } = await import('../../../services/mcp/src/signature.ts');
  const url = await server(t, (req, res) => {
    let raw = ''; req.on('data', b => { raw += b; }); req.on('end', () => {
      const message = JSON.parse(raw);
      const result = message.method === 'initialize'
        ? { serverInfo: { name: 'eva-project-openproject' }, protocolVersion: '2025-11-25' }
        : { note: signed('updated', 'alice', channelFromRequest(req.headers['user-agent'], req.headers['x-eva-agent'])) };
      res.writeHead(200, { 'Content-Type': 'application/json' });res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  for (const [name, expected] of [['codex-mcp-client', 'Codex'], ['claude-code', 'Claude'], ['Mila-Agent', 'Mila'], ['custom-agent', 'custom-agent'], ['Qoder', 'Qoder'], ['WorkBuddy', 'WorkBuddy'], ['Future Agent', 'Future Agent'], ['自定义助手', '自定义助手'], [undefined, '未知 Agent']]) {
    const bridge = new EvaTransport({ url, token });
    await bridge.call(1, 'initialize', { clientInfo: { name, version: '1.0' } });
    const result = await bridge.call(2, 'tools/call', { name: 'history_signature_probe' });
    assert.deepEqual(parseSignature(result.note), { text: 'updated', userId: 'alice', channel: expected });
  }
});
