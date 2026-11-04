// Isolated UI regressions: original modules, synthetic records, no live service access.
// Set EVAPROJECT_PLAYWRIGHT_PATH if playwright is outside the local dependency tree.
// Set EVAPROJECT_CHROME to use an installed Chrome instead of Playwright's browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.EVAPROJECT_PLAYWRIGHT_PATH || 'playwright');
const repo = path.resolve(__dirname, '../../..');
const output = process.env.EVAPROJECT_UI_REVIEW_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'eva-ui-fix-'));
fs.mkdirSync(output, { recursive: true });
const project = { id: 5, identifier: 'preview-a', name: '隔离项目 A' };
const projectB = { id: 6, identifier: 'preview-b', name: '隔离项目 B' };
const access = { create: true, edit: true, update: true, manage: true, claim: true, release: true, upload: true };
const req = { id: 'PREVIEW-REQ-1', workPackageId: 90001, project: project.identifier, title: '隔离示例需求', typeId: 1, typeName: '任务', state: '进行中', modules: ['开发流程'], responsibleAgent: 'Codex', claimedAgent: 'Codex', claimedSession: 'preview-session', priority: '普通', visibility: '私有', ownerUserId: 'preview-user', updatedAt: '2026-11-04T09:00:00Z', lockVersion: 3 };
const ho = { id: 'PREVIEW-HO-1', workPackageId: 91001, project: project.identifier, title: '项目 A 的交接', thread: req.id, handoffState: '待接手', todoDone: 0, todoTotal: 1, expectedAgent: '不限', lockVersion: 0 };
const types = [{ id: 1, name: '任务' }, { id: 4, name: '功能' }, { id: 7, name: '缺陷' }];
const options = { state: ['待确认', '待认领', '进行中', '已实现待提交', '待验证/验收', '已完成', '暂缓', '取消'], responsibleAgent: ['Codex', 'Claude', '待确认'], claimedAgent: ['Codex', 'Claude'], modules: ['开发流程'] };
const tally = { total: 3, bugs: 1, unclaimed: 1, states: { 进行中: 1, 待认领: 1, 已完成: 1 }, modules: [], agents: [] };
const empty = { items: [], total: 0 };
const view = { current: tally, period: tally, attention: { acceptance: empty, confirmation: empty, stale: empty }, recent: [req], trend: { buckets: Array.from({ length: 12 }, () => ({ created: 1, createdBugs: 0, completed: 0 })), undatedCompletions: 0 } };
let browser;
const results = [];
function pageHtml(kind) {
  const ids = { requirements: 'mp-requirements', handoff: 'mp-handoff', dashboard: 'mp-dashboard', 'agent-access': 'eva-agent-access' };
  const name = kind === 'agent-access' ? 'eva-agent-access' : `mp-${kind}`;
  const attrs = kind === 'agent-access' ? 'data-mcp-url="http://localhost:28081/mcp"' : `data-api="/${kind === 'dashboard' ? 'requirements' : kind}/api"`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf-token" content="fixture"><link rel="stylesheet" href="/evaproject/theme.css"><link rel="stylesheet" href="/evaproject/prose.css"><link rel="stylesheet" href="/evaproject/requirements.css"><link rel="stylesheet" href="/evaproject/${kind}.css"><style>body{font:14px system-ui;margin:0}main{padding:16px}.fixture{padding:12px;background:#eee}button,input,select,textarea{font:inherit}</style></head><body data-color-mode="light" data-light-theme="light"><header class="fixture">隔离回归检查 · 全部为模拟数据</header><main><section id="${ids[kind]}" class="${name}" ${attrs}></section></main><script type="module" src="/evaproject/${kind}.js"></script></body></html>`;
}
async function pageFor(kind, setup = {}) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  p.setDefaultTimeout(8000);
  const fixture = { user: 'preview-user', permissions: access, writes: [], reads: [], errors: [], ...setup };
  p.on('dialog', dialog => void dialog.accept());
  p.on('pageerror', error => fixture.errors.push(error.message));
  await p.route('**/*', async route => {
    const r = route.request(), url = new URL(r.url()), name = url.pathname;
    if (!['eva-review.invalid'].includes(url.hostname)) throw new Error(`Unexpected network request: ${url.origin}`);
    if (name.startsWith('/evaproject/')) {
      const file = path.resolve(repo, 'deploy/openproject/assets', name.slice('/evaproject/'.length));
      assert.ok(file.startsWith(path.resolve(repo, 'deploy/openproject/assets') + path.sep));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file, contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : undefined });
      return route.fulfill({ status: 404, body: 'not found' });
    }
    const isB = url.searchParams.get('project') === projectB.identifier;
    const currentReq = { ...req, project: isB ? projectB.identifier : project.identifier, ...(fixture.req ?? {}) };
    const currentHo = { ...ho, title: isB ? '项目 B 的交接' : ho.title, project: isB ? projectB.identifier : project.identifier,
      handoffState: fixture.handoffState ?? ho.handoffState };
    if (r.method() !== 'GET') {
      const body = r.postDataJSON();
      fixture.writes.push({ path: name, project: url.searchParams.getAll('project'), body });
      if (fixture.failWrites) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '模拟保存失败，请核对', conflict: true }) });
      if (name.endsWith('/content')) fixture.content = body;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ item: kind === 'handoff' ? currentHo : currentReq, requirement: currentReq, relation: { id: 1 }, attachment: { id: 1 } }) });
    }
    fixture.reads.push(url.pathname + url.search);
    let data;
    if (name.endsWith('/api/session')) data = { user: { userId: fixture.user, displayName: fixture.user, role: 'user' }, project: project.identifier, projects: fixture.projects ?? [project, projectB] };
    else if (name.endsWith('/api/meta')) data = { types, options, permissions: fixture.permissions };
    else if (name === '/requirements/api/requirements') {
      if (fixture.requirementRace && !isB && fixture.delayRequirement) await new Promise(resolve => setTimeout(resolve, 700));
      const rows = fixture.pickTargets ? [currentReq, { ...currentReq, id: 'PREVIEW-REQ-2', workPackageId: 90002, title: '前置任务' }] : [currentReq];
      data = { items: rows, total: rows.length, nextCursor: null };
    }
    else if (name.startsWith('/requirements/api/requirements/')) data = name.endsWith('/activities') ? { items: [] } : {
      summary: currentReq, permissions: fixture.permissions, description: '## 用户原文\n\n用户的原始需求',
      agentUnderstanding: '实现清楚的错误提示', scope: fixture.content?.scope ?? '登录功能', acceptanceCriteria: '验证错误情况',
      intakeStatus: '已受理', verificationStatus: '未验证', userAcceptance: '待确认',
      claim: { session: req.claimedSession }, completion: { complete: currentReq.state === '已完成', ready: true },
      children: [], parent: null, dependencies: { blockedBy: [], blocks: [], related: [] }, attachments: []
    };
    else if (name === '/handoff/api/handoffs') {
      if (fixture.failListCount > 0) {
        fixture.failListCount--;
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟交接列表暂时不可用' }) });
      }
      if (fixture.race && !isB && url.searchParams.get('state') === '已接手') await new Promise(resolve => setTimeout(resolve, 700));
      let rows = fixture.many ? Array.from({ length: 51 }, (_, index) => ({ ...currentHo, workPackageId: 91001 + index, id: `HO-${index}`, title: `交接 ${index}` })) : [currentHo];
      if (url.searchParams.get('q')) rows = rows.filter(item => item.title.includes(url.searchParams.get('q')));
      const start = (Number(url.searchParams.get('cursor') || '1') - 1) * 50;
      data = { items: rows.slice(start, start + 50), total: rows.length, nextCursor: start + 50 < rows.length ? '2' : null, permissions: fixture.permissions };
    }
    else if (name.startsWith('/handoff/api/handoffs/')) {
      if (fixture.detailRace && !isB) await new Promise(resolve => setTimeout(resolve, 700));
      data = { handoff: currentHo, permissions: fixture.permissions,
      sections: { 背景: '隔离检查', 主线: '今日工作', 现状: '尚有剩余步骤', 注意事项: '无需写入实际业务' },
      todos: [{ id: 'T1', text: '剩余步骤', done: false, requirement: req.id, requirementState: '进行中' }] };
    }
    else if (name === '/requirements/api/dashboard') data = { all: view, projects: [{ ...project, ...view }], staleDays: 7, generatedAt: req.updatedAt, endedStates: ['已完成', '取消'], handoffs: { all: { items: [ho], total: 1 }, projects: { [project.identifier]: { items: [ho], total: 1 } } } };
    if (data !== undefined) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (name.includes('/api/')) throw new Error(`Unhandled fixture: ${name}`);
    return route.fulfill({ contentType: 'text/html', body: pageHtml(kind) });
  });
  const open = async (query = '') => {
    const suffix = query || (kind === 'requirements' ? `?project=${project.identifier}` : '');
    await p.goto(`http://eva-review.invalid/${kind}${suffix}`, { waitUntil: 'networkidle' });
    assert.equal(await p.locator('main').count(), 1);
  };
  await open();
  return { p, fixture, open, close: async () => { assert.deepEqual(fixture.errors, []); await p.close({ runBeforeUnload: false }); } };
}
async function check(name, run) {
  if (process.env.EVAPROJECT_UI_CASE && !name.includes(process.env.EVAPROJECT_UI_CASE)) return;
  await run(); results.push(name); console.log('PASS ' + name);
}
async function shot(p, name) { await p.screenshot({ path: path.join(output, name + '.png'), fullPage: true }); }
(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.EVAPROJECT_CHROME ? { executablePath: process.env.EVAPROJECT_CHROME } : {}) });
  await check('R01: load all 51 handoffs and search after paging', async () => {
    const x = await pageFor('handoff', { many: true });
    assert.equal(await x.p.locator('.mp-card').count(), 50);
    await x.p.getByRole('button', { name: '加载更多交接', exact: true }).click();
    await x.p.waitForFunction(() => document.querySelectorAll('.mp-card').length === 51);
    assert.equal(await x.p.getByRole('button', { name: '加载更多交接', exact: true }).count(), 0);
    await x.p.getByRole('searchbox').fill('交接 50');
    await x.p.waitForFunction(() => document.querySelectorAll('.mp-card').length === 1);
    assert.match(await x.p.locator('.mp-card').innerText(), /交接 50/);
    await shot(x.p, 'handoff-paging-fixed'); await x.close();
  });
  await check('R02: late project A response cannot replace project B', async () => {
    const x = await pageFor('handoff', { race: true });
    await x.p.getByRole('button', { name: '已接手', exact: true }).click();
    await x.p.getByLabel('项目', { exact: true }).selectOption(projectB.identifier);
    await x.p.waitForTimeout(1000);
    assert.equal(await x.p.locator('.mp-card-title').innerText(), '项目 B 的交接');
    await shot(x.p, 'handoff-race-fixed'); await x.close();
  });
  await check('R01: failed initial list can be retried without duplicate page containers', async () => {
    const x = await pageFor('handoff', { failListCount: 1 });
    await x.p.getByRole('button', { name: '重试加载交接', exact: true }).click();
    await x.p.locator('.mp-card').waitFor();
    assert.equal(await x.p.locator('#mp-handoff > aside').count(), 1); await x.close();
  });
  await check('R03/R04: named dialog restores a draft and isolates it by account', async () => {
    const x = await pageFor('requirements');
    await x.p.getByRole('button', { name: '＋ 新建需求', exact: true }).click();
    const dialog = x.p.getByRole('dialog', { name: '新建需求', exact: true });
    await dialog.getByLabel('标题 *', { exact: true }).fill('未提交的需求草稿');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await x.p.getByRole('button', { name: '＋ 新建需求', exact: true }).click();
    assert.equal(await dialog.getByLabel('标题 *', { exact: true }).inputValue(), '未提交的需求草稿');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    x.fixture.user = 'another-user'; await x.open();
    await x.p.getByRole('button', { name: '＋ 新建需求', exact: true }).click();
    assert.equal(await dialog.getByLabel('标题 *', { exact: true }).inputValue(), '');
    assert.equal(x.fixture.writes.length, 0); await x.close();
  });
  await check('R02: same reference on two projects does not reuse a late detail', async () => {
    const x = await pageFor('handoff', { detailRace: true });
    await x.p.locator('.mp-card').click();
    await x.p.getByLabel('项目', { exact: true }).selectOption(projectB.identifier);
    await x.p.locator('.mp-card-title').filter({ hasText: '项目 B 的交接' }).waitFor();
    await x.p.locator('.mp-card').click();
    await x.p.waitForTimeout(900);
    assert.equal(await x.p.locator('.mp-detail h2').innerText(), '项目 B 的交接'); await x.close();
  });
  await check('R04/R06/R12: keyboard title link, task-first detail and persistent deep link', async () => {
    const x = await pageFor('requirements');
    const title = x.p.getByRole('link', { name: req.title, exact: true }); await title.focus(); await x.p.keyboard.press('Enter');
    await x.p.getByRole('button', { name: '编辑需求', exact: true }).waitFor();
    assert.equal(new URL(x.p.url()).searchParams.get('open'), req.id);
    assert.equal(await x.p.locator('.mp-trace').getAttribute('open'), null);
    assert.match(await x.p.locator('.mp-tab-body').innerText(), /目标与验收/);
    await x.p.reload({ waitUntil: 'networkidle' });
    await x.p.getByRole('button', { name: '编辑需求', exact: true }).waitFor();
    await shot(x.p, 'requirement-detail-fixed');
    await x.p.setViewportSize({ width: 390, height: 844 });
    assert.equal(await x.p.getByRole('button', { name: '复制链接', exact: true }).isVisible(), true);
    await shot(x.p, 'requirement-mobile-fixed');
    await x.close();
  });
  await check('R05: select a predecessor and associate a todo without typing IDs', async () => {
    const x = await pageFor('handoff', { handoffState: '已接手' }); await x.p.getByRole('button', { name: '＋ 新建交接', exact: true }).click();
    const dialog = x.p.getByRole('dialog', { name: '新建交接', exact: true });
    await dialog.getByLabel('标题 *', { exact: true }).fill('今天的进度');
    const predecessor = dialog.getByLabel('继续已有工作线（可选）', { exact: true });
    await predecessor.locator('option[value="91001"]').waitFor({ state: 'attached' }); await predecessor.selectOption('91001');
    const todo = dialog.locator('.eva-todo-editor'); await todo.getByLabel('待办内容', { exact: true }).fill('补充测试');
    const requirement = todo.getByLabel('这项待办关联的需求（可选）', { exact: true });
    await requirement.locator('option[value="90001"]').waitFor({ state: 'attached' }); await requirement.selectOption('90001');
    await shot(x.p, 'handoff-structured-fixed'); await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await x.p.waitForFunction(() => !document.querySelector('dialog'));
    const write = x.fixture.writes[0]; assert.deepEqual(write.project, [project.identifier]);
    assert.equal(write.body.previous, ho.id); assert.deepEqual(write.body.todos, [{ text: '补充测试', requirement: 90001 }]);
    assert.equal(write.body.supersede, false); await x.close();
  });
  await check('R12: handoff direct links keep the selected record after refresh', async () => {
    const x = await pageFor('handoff');
    await x.open(`?project=${project.identifier}&open=${ho.id}`);
    await x.p.locator('.mp-detail h2').waitFor();
    assert.equal(new URL(x.p.url()).searchParams.get('open'), ho.id);
    await x.p.reload({ waitUntil: 'networkidle' });
    assert.equal(await x.p.locator('.mp-detail h2').innerText(), ho.title); await x.close();
  });
  await check('R05: replacing an unclaimed handoff requires explicit confirmation', async () => {
    const x = await pageFor('handoff'); await x.p.getByRole('button', { name: '＋ 新建交接', exact: true }).click();
    const dialog = x.p.getByRole('dialog', { name: '新建交接', exact: true });
    await dialog.getByLabel('标题 *', { exact: true }).fill('新的交接');
    const previous = dialog.getByLabel('继续已有工作线（可选）', { exact: true });
    await previous.locator('option[value="91001"]').waitFor({ state: 'attached' }); await previous.selectOption('91001');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '明确勾选' }).waitFor(); assert.equal(x.fixture.writes.length, 0);
    await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await x.p.waitForFunction(() => !document.querySelector('dialog')); assert.equal(x.fixture.writes[0].body.supersede, true);
    await x.close();
  });
  await check('R12: mobile browser back closes the detail while retaining the list', async () => {
    const x = await pageFor('requirements'); await x.p.setViewportSize({ width: 390, height: 844 });
    await x.p.getByRole('link', { name: req.title, exact: true }).click();
    await x.p.getByRole('button', { name: '编辑需求', exact: true }).waitFor();
    assert.equal(await x.p.evaluate(() => history.state?.mpSheet), 'requirements');
    await x.p.goBack(); await x.p.waitForFunction(() => !document.querySelector('.mp-detail'));
    assert.equal(await x.p.getByRole('link', { name: req.title, exact: true }).count(), 1); await x.close();
  });
  await check('R08: edit scope with its original version; preserve input on save failure', async () => {
    const x = await pageFor('requirements'); await x.p.getByRole('link', { name: req.title, exact: true }).click();
    await x.p.getByRole('button', { name: '编辑需求', exact: true }).click();
    const dialog = x.p.getByRole('dialog', { name: '编辑需求', exact: true }); await dialog.getByLabel('范围', { exact: true }).fill('新的明确范围');
    x.fixture.failWrites = true; await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '模拟保存失败' }).waitFor();
    assert.equal(await dialog.getByLabel('范围', { exact: true }).inputValue(), '新的明确范围');
    assert.equal(x.fixture.writes[0].body.lockVersion, 3); assert.equal('rawText' in x.fixture.writes[0].body, false);
    x.fixture.failWrites = false; await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await x.p.waitForFunction(() => !document.querySelector('dialog')); await x.close();
  });
  await check('R08: upload file and maintain a dependency through explicit project APIs', async () => {
    const x = await pageFor('requirements'); await x.p.getByRole('link', { name: req.title, exact: true }).click();
    await x.p.getByRole('button', { name: '附件', exact: true }).click();
    await x.p.getByLabel('上传参考文件（最多 20 MiB）', { exact: true }).setInputFiles({ name: 'reference.txt', mimeType: 'text/plain', buffer: Buffer.from('reference') });
    await x.p.getByRole('button', { name: '上传附件', exact: true }).click();
    await x.p.waitForFunction(() => document.querySelector('.mp-notice')?.textContent === '附件已上传');
    assert.equal(x.fixture.writes[0].body.content, Buffer.from('reference').toString('base64'));
    x.fixture.pickTargets = true;
    await x.p.getByRole('button', { name: '关系', exact: true }).click();
    await x.p.getByText('维护父级与执行依赖', { exact: true }).click();
    const prerequisite = x.p.getByLabel('选择同项目需求', { exact: true });
    await prerequisite.locator('option[value="90002"]').waitFor({ state: 'attached' });
    await prerequisite.selectOption('90002');
    await x.p.getByRole('button', { name: '保存关系', exact: true }).click();
    await x.p.waitForFunction(() => document.querySelector('.mp-notice')?.textContent === '关系已保存');
    assert.equal(x.fixture.writes[1].body.prerequisite, 90002);
    assert.deepEqual(x.fixture.writes[0].project, [project.identifier]); await x.close();
  });
  await check('R09/R10: all 101 projects remain selectable; read-only actions are disabled', async () => {
    const projects = [project, ...Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, identifier: `project-${i}`, name: `项目 ${i}` }))];
    const x = await pageFor('requirements', { projects }); await x.open('?all=1');
    // The per-browser remembered project is a deliberate navigation preference.
    await x.p.evaluate(() => localStorage.clear()); await x.open('?all=1');
    assert.equal(await x.p.locator('.mp-project-card').count(), 101);
    x.fixture.permissions = { create: false, edit: false, update: false, manage: false, claim: false, release: false, upload: false };
    await x.open(); assert.equal(await x.p.getByRole('button', { name: '＋ 新建需求', exact: true }).isDisabled(), true);
    await x.p.getByRole('link', { name: req.title, exact: true }).click();
    assert.equal(await x.p.getByRole('button', { name: '编辑需求', exact: true }).isDisabled(), true);
    assert.equal(x.fixture.writes.length, 0); await x.close();
  });
  await check('R10: a completed parent cannot offer splitting before reopening', async () => {
    const x = await pageFor('requirements', { req: { state: '已完成' } });
    await x.p.getByRole('link', { name: req.title, exact: true }).click();
    assert.equal(await x.p.getByRole('button', { name: '分工子任务', exact: true }).isDisabled(), true);
    assert.equal(await x.p.getByRole('button', { name: '重新打开', exact: true }).isEnabled(), true); await x.close();
  });
  await check('R11/R12: current counts drill into filters; handoff links open the selected record', async () => {
    const x = await pageFor('dashboard');
    const current = x.p.locator('.mp-dash-section').filter({ has: x.p.getByRole('heading', { name: '现状', exact: true }) });
    const active = current.locator('a.mp-dash-stat').filter({ hasText: '进行中' });
    assert.equal(new URL(await active.getAttribute('href')).searchParams.get('state'), '进行中');
    const link = x.p.getByRole('link', { name: ho.title, exact: true }); assert.equal(new URL(await link.getAttribute('href')).searchParams.get('open'), ho.id);
    await shot(x.p, 'dashboard-fixed'); await x.close();
  });
  await check('R07/R14: daily-use prompts explain stopping and continuing without claiming client load', async () => {
    const x = await pageFor('agent-access');
    await x.p.getByText('今天收工', { exact: true }).click();
    assert.match(await x.p.getByLabel('今天收工指令', { exact: true }).inputValue(), /隔离项目 A/);
    await x.p.getByLabel('日常指令所用项目', { exact: true }).selectOption(projectB.identifier);
    assert.match(await x.p.getByLabel('今天收工指令', { exact: true }).inputValue(), /隔离项目 B/);
    await shot(x.p, 'agent-usage-fixed'); assert.equal(x.fixture.writes.length, 0); await x.close();
  });
  await browser.close();
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ mode: 'isolated synthetic data; no live backend calls', tests: results, passed: results.length }, null, 2));
  console.log(`Verified ${results.length} browser scenarios. Evidence: ${output}`);
})().catch(async error => {
  console.error(error.stack);
  if (browser) {
    for (const context of browser.contexts()) for (const p of context.pages()) {
      console.error((await p.locator('body').innerText()).slice(-4500));
      console.error(await p.locator('dialog select').evaluateAll(nodes => nodes.map(node => ({label: node.parentElement.innerText, options: [...node.options].map(option => [option.value, option.text])}))));
      await shot(p, 'failure');
    }
    await browser.close();
  }
  process.exitCode = 1;
});
