// Local fixtures only. Never run against a production instance.
// node deploy/dev/smoke-project-creation.mjs <admin jar> <creator jar> <outsider jar> [new identifier]
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const [adminJar, creatorJar, outsiderJar, identifier = 'sclaw-local-preview', reuseFixture] = process.argv.slice(2);
if (!adminJar || !creatorJar || !outsiderJar) throw new Error('Pass three temporary local session jars');
const web = 'http://localhost:28080', mcp = 'http://localhost:28081';
function cookie(path) {
  return readFileSync(path, 'utf8').split('\n').map(line => line.replace(/^#HttpOnly_/, ''))
    .filter(line => line && !line.startsWith('#')).map(line => line.split('\t'))
    .filter(fields => fields.length >= 7 && fields[5] !== 'autologin')
    .map(fields => `${fields[5]}=${fields[6]}`).join('; ');
}
const adminCookie = cookie(adminJar), creatorCookie = cookie(creatorJar), outsiderCookie = cookie(outsiderJar);
async function webApi(path, auth, body) {
  const response = await fetch(`${web}${path}`, { headers: { Cookie: auth, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: web },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
async function createIdentity(userId, login) {
  const list = await fetch(`${mcp}/admin/api/users`, { headers: { Cookie: adminCookie } });
  assert.equal(list.status, 200);
  const existing = (await list.json()).users.find(p => p.userId === userId);
  if (existing) assert.ok(existing.openProjectLogin === login && existing.role === 'user', 'Only rotate this script\'s own local fixture identity');
  const response = await fetch(`${mcp}/admin/api/users${existing ? `/${userId}/rotate` : ''}`, {
    method: 'POST', headers: { Cookie: adminCookie, Origin: mcp, 'Content-Type': 'application/json' },
    body: JSON.stringify(existing ? {} : { userId, displayName: `${login}（本地验证）`, openProjectLogin: login })
  });
  assert.equal(response.status, existing ? 200 : 201, 'Local MCP fixture identity must be created or rotated');
  return (await response.json()).token; // Generated token stays in process memory only.
}
let rpcId = 0;
async function rpc(token, method, params) {
  const response = await fetch(`${mcp}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  assert.equal(response.status, 200, 'Local MCP call must authenticate');
  const text = await response.text();
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').find(line => line.startsWith('data:'))?.slice(5).trim() : text;
  const result = JSON.parse(payload);
  assert.ok(!result.error, 'MCP request must be valid');
  return result.result;
}
async function call(token, name, args) {
  const result = await rpc(token, 'tools/call', { name, arguments: args });
  return { error: result.isError === true, data: result.structuredContent ?? JSON.parse(result.content[0].text) };
}
const creatorToken = await createIdentity('sclaw-local-preview-creator', 'project-creator-demo');
const outsiderToken = await createIdentity('sclaw-local-preview-outsider', 'project-outsider-demo');
for (const token of [creatorToken, outsiderToken]) {
  await rpc(token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'Eva local project permissions smoke', version: '1' } });
}
const created = await call(creatorToken, 'requirements_project_create', { project: identifier, name: 'SClaw（本地修复验证）' });
assert.ok(!created.error, `Project creation failed: ${created.data.message ?? 'unknown'}`);
assert.equal(created.data.created, reuseFixture !== '--reuse-fixture', 'Use a fresh identifier, or explicitly continue this script\'s own local fixture');
const projectId = created.data.project.id;
const memberFilter = encodeURIComponent(JSON.stringify([{ project: { operator: '=', values: [String(projectId)] } }]));
const memberships = async () => (await webApi(`/api/v3/memberships?filters=${memberFilter}`, adminCookie)).data._embedded.elements;
const before = await memberships();
assert.equal(before.length, 1, 'New private project must have exactly the actual caller as a member');
assert.equal(before[0]._links.principal.title, '子芸 本地验证');
assert.equal(before[0]._links.roles.length, 1);
assert.ok(['成员', 'Member'].includes(before[0]._links.roles[0].title), 'Creator must receive the member role');
const creatorProjects = await call(creatorToken, 'requirements_projects', {});
assert.ok(!creatorProjects.error && creatorProjects.data.items.some(p => p.id === projectId));
const outsiderProjects = await call(outsiderToken, 'requirements_projects', {});
assert.ok(!outsiderProjects.error && !outsiderProjects.data.items.some(p => p.id === projectId));
assert.ok(!(await call(creatorToken, 'requirements_types', { project: identifier })).error);
assert.ok((await call(outsiderToken, 'requirements_types', { project: identifier })).error);
const tools = await rpc(creatorToken, 'tools/list', {});
const fields = tools.tools.find(t => t.name === 'requirements_create').inputSchema.properties;
const requirement = await call(creatorToken, 'requirements_create', {
  project: identifier, id: `${identifier}-member-check`, title: 'MCP 成员创建需求验证（本地）',
  raw_text: '验证普通用户新建私有项目后能登记需求。', agent_understanding: '仅用于本地权限验证。',
  modules: [fields.modules.items.enum[0]], responsible_agent: 'Codex', intake_status: '已受理',
  state: '待认领', priority: 'Normal', requester_type: '人', visibility: '私有',
  proposed_time_precision: fields.proposed_time_precision.enum.find(v => /unknown|未知/.test(v)) ?? fields.proposed_time_precision.enum[0],
  source_label: 'local project permission smoke', request_id: `${identifier}-member-check`
});
assert.ok(!requirement.error, `Member MCP requirement creation failed: ${requirement.data.message ?? 'unknown'}`);
const mcpWorkPackageId = requirement.data.requirement.workPackageId;
assert.equal((await webApi(`/api/v3/work_packages/${mcpWorkPackageId}`, creatorCookie)).status, 200, 'MCP-created requirement must be readable in the native webpage');

const nativeCreator = await webApi(`/api/v3/projects/${projectId}`, creatorCookie);
assert.equal(nativeCreator.status, 200, 'Creator must have native webpage access');
assert.equal(nativeCreator.data.public, false);
const nativeProjects = await webApi('/api/v3/projects?pageSize=100', creatorCookie);
assert.ok(nativeProjects.data._embedded.elements.some(p => p.id === projectId), 'Creator native project list must contain it');
const nativeOutsider = await webApi(`/api/v3/projects/${projectId}`, outsiderCookie);
assert.ok([403, 404].includes(nativeOutsider.status), 'Other webpage users must not access the private project');
const nativeOutsiderProjects = await webApi('/api/v3/projects?pageSize=100', outsiderCookie);
assert.ok(!nativeOutsiderProjects.data._embedded.elements.some(p => p.id === projectId));

const workPackage = await webApi(`/api/v3/projects/${projectId}/work_packages`, creatorCookie, {
  subject: '成员权限验证（本地）', _links: { type: { href: `/api/v3/types/${created.data.types[0].id}` } }
});
assert.equal(workPackage.status, 201, 'Member must be able to create a native work package');
const memberAdministration = await webApi('/api/v3/memberships', creatorCookie, {
  _links: { project: { href: `/api/v3/projects/${projectId}` }, principal: { href: before[0]._links.principal.href }, roles: before[0]._links.roles }
});
assert.equal(memberAdministration.status, 403, 'Member must not receive project member administration permission');

const reused = await call(creatorToken, 'requirements_project_create', { project: identifier });
assert.ok(!reused.error && reused.data.created === false);
const denied = await call(outsiderToken, 'requirements_project_create', { project: identifier });
assert.ok(denied.error && /Project not found/.test(denied.data.message), 'Reuse must not grant access');
const after = await memberships();
assert.deepEqual(after.map(m => ({ id: m.id, roles: m._links.roles, user: m._links.principal.href })),
  before.map(m => ({ id: m.id, roles: m._links.roles, user: m._links.principal.href })), 'Reuse must preserve memberships and roles');
console.log(JSON.stringify({ status: 'passed', identifier, projectId, memberRole: before[0]._links.roles[0].title,
  created: created.data.created, workPackageId: workPackage.data.id, mcpWorkPackageId,
  checks: ['MCP creation or confirmed fixture reuse as mapped ordinary user', 'explicit member role', 'creator MCP and native project visibility', 'MCP requirement creation and native readback',
    'native member work package creation', 'member administration denied', 'outsider MCP and native access denied', 'reuse preserves memberships'] }));
