// Local fixtures only. Never run against a production instance.
// node deploy/dev/smoke-mcp-accounts.mjs <admin jar> <ordinary-user jar>
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const [adminJar, memberJar] = process.argv.slice(2);
if (!adminJar || !memberJar) throw new Error('Pass two newly minted local test session jars');
function cookie(path) {
  return readFileSync(path, 'utf8').split('\n').map(line => line.replace(/^#HttpOnly_/, ''))
    .filter(line => line && !line.startsWith('#')).map(line => line.split('\t'))
    .filter(fields => fields.length >= 7 && fields[5] !== 'autologin')
    .map(fields => `${fields[5]}=${fields[6]}`).join('; ');
}
const adminCookie = cookie(adminJar), memberCookie = cookie(memberJar);
const origin = 'http://localhost:28081';
async function api(path, body, auth = adminCookie, from = origin) {
  const response = await fetch(`${origin}/admin/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: auth, Origin: from, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, data: await response.json() };
}
const check = (condition, label) => assert.ok(condition, label);
check((await api('/users', undefined, '')).status === 401, 'anonymous must be rejected');
check((await api('/accounts', undefined, memberCookie)).status === 403, 'ordinary user must be rejected');
check((await api('/users', {}, adminCookie, 'http://wrong-origin.invalid')).status === 403, 'cross-origin writes must be rejected');
check((await api('/users', { userId: 'missing-link', displayName: 'Test' })).status === 400, 'creation requires association');
const accounts = (await api('/accounts')).data.accounts;
check(accounts.some(a => a.login === '李多吉'), 'Chinese login must be available');
const created = await api('/users', { userId: 'liduoji', displayName: '李多吉（本地演示）', openProjectLogin: '李多吉' });
check(created.status === 201 && created.data.principal.openProjectLogin === '李多吉', 'creation must persist association');
const token = created.data.token; // Generated fixture token stays only in process memory.
const initial = created.data.principal;
const unchanged = p => {
  check(p.userId === initial.userId && p.role === initial.role && p.tokenFingerprint === initial.tokenFingerprint, 'association changes must preserve identity and token');
  check(!Object.hasOwn(p, 'token'), 'association responses must never expose a token');
};
let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  check(response.status === 200, 'MCP fixture token must remain valid');
  const text = await response.text();
  const payload = text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(l => l.startsWith('data:'))?.slice(5).trim() : text;
  return JSON.parse(payload);
}
await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Eva local association smoke', version: '1' } });
check(!(await rpc('tools/call', { name: 'requirements_projects', arguments: {} })).result.isError, 'linked identity must resolve projects');
const unlink = await api('/users/liduoji/link', { openProjectLogin: null, lockVersion: initial.lockVersion });
check(unlink.status === 200 && unlink.data.openProjectLogin === null, 'unlink must be explicit');
unchanged(unlink.data);
check((await rpc('tools/call', { name: 'requirements_projects', arguments: {} })).result.isError === true, 'unlink must stop project access rather than restoring the ID fallback');
const linked = await api('/users/liduoji/link', { openProjectLogin: '李多吉', lockVersion: unlink.data.lockVersion });
check(linked.status === 200, 'existing identity must link'); unchanged(linked.data);
check(!(await rpc('tools/call', { name: 'requirements_projects', arguments: {} })).result.isError, 'the same token must work after re-link');
check((await api('/users/liduoji/link', { openProjectLogin: 'preview-member', lockVersion: unlink.data.lockVersion })).status === 409, 'stale edit must return 409');
const changed = await api('/users/liduoji/link', { openProjectLogin: 'preview-member', lockVersion: linked.data.lockVersion });
check(changed.status === 200, 'association must be editable'); unchanged(changed.data);
const restored = await api('/users/liduoji/link', { openProjectLogin: '李多吉', lockVersion: changed.data.lockVersion });
check(restored.status === 200, 'demo association must be restored'); unchanged(restored.data);
check((await api('/users', { userId: 'duplicate-demo', displayName: 'Duplicate', openProjectLogin: '李多吉' })).status === 400, 'duplicates must be rejected');
check((await api('/users', { userId: 'no-account', displayName: 'Missing', openProjectLogin: 'not-a-user' })).status === 400, 'missing accounts must be rejected');
const admin = (await api('/users')).data.users.find(p => p.role === 'admin');
check((await api(`/users/${admin.userId}/link`, { openProjectLogin: '李多吉', lockVersion: admin.lockVersion })).status === 400, 'ordinary account must not inherit an admin MCP role');
const newUser = await api('/users', { userId: 'preview-new', displayName: '新用户（本地演示）', openProjectLogin: 'preview-member' });
check(newUser.status === 201, 'new identity must create with its chosen account');
console.log('Local HTTP/MCP smoke passed: auth, origin, exact login, create/edit/unlink, unchanged token, duplicates, stale conflicts and admin-role protection.');
