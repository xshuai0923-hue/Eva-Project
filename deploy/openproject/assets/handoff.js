// Handoff module, running inside OpenProject's own page.
//
// The top bar, project menu and theme belong to OpenProject; this file renders only the
// module body. Split into a resource-agnostic shell and a handoff adapter so the
// requirement pool can reuse the shell later.

// --- shell --------------------------------------------------------------------

// OpenProject navigates with Turbo: the body is swapped, but a module script is only
// ever evaluated once, so nothing re-runs when the page is entered again. Everything
// below is therefore re-read on each mount rather than captured at module scope.
let root = null;
let apiBase = '';
// Set when the page is opened inside a project; empty on the global entry, where the
// project is chosen in the page instead.
let fixedProject = '';
let csrfToken = '';

// prose.js is imported, not linked from the layout, so the ?v= on this file does not
// reach it and a stale copy can survive a bump here. The version travels with the
// specifier instead: raise it in BOTH importers whenever prose.js changes.
import { inlineNodes, proseNodes } from './prose.js?v=2f4b0da858';
import {
  createSheetHistory, createShell, el, isCompact, loadingNode, rememberedProject, rememberProject, sheetBar,
  startingProject
} from './shell.js?v=4a5e3f829e';

// The pipeline is shared with the requirement pool page; see shell.js for why it waited
// for a second consumer before being pulled out. Its request takes the fetch options
// straight through, which is what this page's call sites already passed.
const { notify, clearNotice, request, guarded } = createShell({
  root: () => root,
  apiBase: () => apiBase,
  project: () => (fixedProject ? '' : state.project),
  csrfToken: () => csrfToken
});

// On a narrow screen the detail is a sheet over the list, and back closes it (shell.js).
const sheet = createSheetHistory({
  page: 'handoff', onClose: () => closeHandoff(), present: () => Boolean(root?.isConnected)
});

// --- adapter ------------------------------------------------------------------

let state = { filter: '待接手', project: '', projects: [], items: [], selected: null, detail: null, editing: null };
const STATES = ['草稿', '待接手', '已接手', '已归档', '已作废'];

let listNode;
let detailNode;

function progressBar(done, total) {
  const wrap = el('span', 'mp-progress');
  const fill = el('span');
  fill.style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
  wrap.append(fill);
  return wrap;
}

function renderList() {
  listNode.replaceChildren();
  if (!state.items.length) {
    listNode.append(el('p', 'mp-empty', '没有符合条件的交接。'));
    return;
  }
  for (const item of state.items) {
    const key = item.id || String(item.workPackageId);
    const card = el('button', 'mp-card' + (state.selected === key ? ' mp-is-active' : ''));
    card.type = 'button';
    card.append(el('div', 'mp-card-thread', item.thread || '未命名线程'));
    card.append(el('div', 'mp-card-title', item.title));
    const meta = el('div', 'mp-card-meta');
    meta.append(el('span', 'mp-badge mp-badge-' + (item.handoffState || ''), item.handoffState || '未知'));
    meta.append(progressBar(item.todoDone || 0, item.todoTotal || 0));
    meta.append(el('span', '', (item.todoDone || 0) + '/' + (item.todoTotal || 0)));
    if (item.claimedSession) meta.append(el('span', '', '· ' + (item.claimedAgent || '已领取')));
    card.append(meta);
    card.onclick = () => selectHandoff(key);
    listNode.append(card);
  }
}

function fact(label, value) {
  const wrap = el('div');
  wrap.append(el('div', 'mp-fact-label', label));
  wrap.append(el('div', 'mp-fact-value', value || '—'));
  return wrap;
}

function serializeTodo(todo) {
  const parts = [];
  if (todo.requirement) parts.push('需求:' + todo.requirement);
  if (todo.status) parts.push('状态:' + todo.status);
  if (todo.commit) parts.push('提交:' + todo.commit);
  if (todo.blockedBy && todo.blockedBy.length) parts.push('依赖:' + todo.blockedBy.join(','));
  if (todo.note) parts.push('说明:' + todo.note);
  for (const extra of todo.extras || []) parts.push(extra);
  const head = '- [' + (todo.done ? 'x' : ' ') + '] (' + todo.id + ') ' + todo.text;
  return parts.length ? head + ' · ' + parts.join(' · ') : head;
}

function todoRow(todo) {
  const row = el('div', 'mp-todo' + (todo.done ? ' mp-is-done' : ''));
  const box = el('input');
  box.type = 'checkbox';
  box.checked = todo.done;
  box.setAttribute('aria-label', todo.text);
  box.onchange = () => toggleTodo(todo.id, box.checked, box);
  row.append(box);

  const main = el('div', 'mp-todo-main');
  const text = el('div', 'mp-todo-text');
  // Marked like the sections below: a todo names requirements, commits and files too (#208).
  text.append('(' + todo.id + ') ', ...inlineNodes(todo.text));
  main.append(text);
  const tags = el('div', 'mp-todo-tags');
  if (todo.status) tags.append(el('span', 'mp-tag', todo.status));
  if (todo.requirement) {
    // Alignment is computed from the requirement read just now, so a disagreement shows
    // as a prompt rather than being resolved silently in either direction.
    const cls = todo.aligned === false ? 'mp-tag mp-tag-misaligned'
      : todo.aligned === true ? 'mp-tag mp-tag-aligned' : 'mp-tag';
    const suffix = todo.requirementState ? ' · 需求现状 ' + todo.requirementState : '';
    tags.append(el('span', cls, todo.requirement + suffix));
  }
  if (todo.blockedBy && todo.blockedBy.length) tags.append(el('span', 'mp-tag', '依赖 ' + todo.blockedBy.join(', ')));
  if (todo.commit) tags.append(el('span', 'mp-tag mp-tag-code', todo.commit.slice(0, 7)));
  if (todo.note) {
    const note = el('span', 'mp-tag');
    note.append(...inlineNodes(todo.note));
    tags.append(note);
  }
  if (tags.childElementCount) main.append(tags);
  row.append(main);
  return row;
}

// Prose rendering moved to prose.js when the requirement pool needed the same thing.
export { parseProse, inlineNodes, proseNodes } from './prose.js?v=2f4b0da858';

function sectionBlock(name, content) {
  const block = el('section', 'mp-section');
  const head = el('div', 'mp-section-head');
  head.append(el('h3', '', name));
  const edit = el('button', 'mp-action', state.editing === name ? '取消' : '编辑');
  edit.type = 'button';
  edit.onclick = () => { state.editing = state.editing === name ? null : name; renderDetail(); };
  head.append(edit);
  block.append(head);

  if (state.editing === name) {
    const area = el('textarea', 'mp-editor');
    area.value = content || '';
    const actions = el('div', 'mp-editor-actions');
    const save = el('button', 'mp-action mp-is-primary', '保存');
    save.type = 'button';
    save.onclick = () => saveSection(name, area.value, save);
    actions.append(save);
    block.append(area, actions);
    block.append(el('p', 'mp-hint',
      '高亮块：另起一行写 > [!WARNING] 标题，紧跟的 > 开头各行是块内正文。可用 NOTE、TIP、IMPORTANT、WARNING、CAUTION，标题可省。普通的 > 引用行不受影响。'));
  } else {
    const body = el('div', 'mp-section-body');
    body.append(...proseNodes(content));
    block.append(body);
  }
  return block;
}

function todosSection(detail) {
  const block = el('section', 'mp-section');
  const head = el('div', 'mp-section-head');
  head.append(el('h3', '', '待办'));
  const edit = el('button', 'mp-action', state.editing === '待办' ? '取消' : '编辑清单');
  edit.type = 'button';
  edit.onclick = () => { state.editing = state.editing === '待办' ? null : '待办'; renderDetail(); };
  head.append(edit);
  block.append(head);

  if (state.editing === '待办') {
    const area = el('textarea', 'mp-editor mp-mono');
    area.rows = Math.max(6, detail.todos.length + 3);
    area.value = detail.todos.map(serializeTodo).join('\n');
    const actions = el('div', 'mp-editor-actions');
    const save = el('button', 'mp-action mp-is-primary', '保存');
    save.type = 'button';
    save.onclick = () => saveTodos(area.value, save);
    actions.append(save);
    block.append(area, actions);
    block.append(el('p', 'mp-hint',
      '一行一项：- [x] (T1) 文本 · 需求:编号 · 状态:进行中 · 提交:sha · 依赖:T2 · 说明:备注。勾选只表示这一步做完，不会推进需求状态。'));
  } else if (!detail.todos.length) {
    block.append(el('p', 'mp-empty', '还没有待办。'));
  } else {
    for (const todo of detail.todos) block.append(todoRow(todo));
  }

  if (detail.unparsedTodoLines && detail.unparsedTodoLines.length) {
    block.append(el('div', 'mp-unparsed',
      '有 ' + detail.unparsedTodoLines.length + ' 行无法按待办语法解析，已原样保留：' + detail.unparsedTodoLines.join(' / ')));
  }
  return block;
}

function renderDetail() {
  const detail = state.detail;
  detailNode.replaceChildren();
  // A narrow screen shows the detail only while one is chosen, as a sheet over the list,
  // with the bar that leads back to it; a wide one always shows it and never the bar.
  detailNode.classList.toggle('mp-is-open', Boolean(state.selected));
  if (state.selected) detailNode.append(sheetBar(() => sheet.close()));
  if (!detail) {
    // Only a sheet is ever drawn without its handoff: it opens on the tap, not on the answer.
    detailNode.append(state.selected ? loadingNode('载入交接…') : el('p', 'mp-empty', '从左侧选择一份交接。'));
    return;
  }
  const handoff = detail.handoff;

  detailNode.append(el('h2', '', handoff.title));
  detailNode.append(el('div', 'mp-detail-id', (handoff.id || '#' + handoff.workPackageId) + ' · ' + (handoff.thread || '')));

  const controls = el('div', 'mp-controls');
  const stateSelect = el('select');
  for (const value of STATES) {
    const option = el('option', '', value);
    option.value = value;
    if (value === handoff.handoffState) option.selected = true;
    stateSelect.append(option);
  }
  stateSelect.onchange = () => changeState(stateSelect.value, stateSelect);
  controls.append(stateSelect);
  if (handoff.claimedSession) {
    const release = el('button', 'mp-action', '接管释放认领');
    release.type = 'button';
    release.onclick = () => releaseClaim(release);
    controls.append(release);
  }
  const open = el('a', 'mp-action', '打开工作包');
  open.href = '/work_packages/' + handoff.workPackageId;
  controls.append(open);
  detailNode.append(controls);

  const facts = el('div', 'mp-facts');
  facts.append(fact('仓库', handoff.repository));
  facts.append(fact('分支', handoff.branch));
  facts.append(fact('基线提交', handoff.baseCommit ? handoff.baseCommit.slice(0, 12) : ''));
  facts.append(fact('写出 Session', handoff.sourceSessionId));
  facts.append(fact('接手', handoff.claimedSession ? (handoff.claimedAgent || '') + ' ' + handoff.claimedSession : '未领取'));
  facts.append(fact('上一任交接', handoff.previous));
  facts.append(fact('期望接手 Agent', handoff.expectedAgent));
  facts.append(fact('待办', (handoff.todoDone || 0) + ' / ' + (handoff.todoTotal || 0)));
  detailNode.append(facts);

  detailNode.append(todosSection(detail));
  for (const name of ['背景', '主线', '现状', '注意事项']) {
    detailNode.append(sectionBlock(name, detail.sections[name]));
  }
}

// --- actions ------------------------------------------------------------------

async function loadList() {
  const query = state.filter ? '?state=' + encodeURIComponent(state.filter) : '';
  state.items = (await request('/handoffs' + query)).items;
  renderList();
}

async function loadDetail() {
  if (!state.selected) return;
  const reference = state.selected;
  const detail = await request('/handoffs/' + encodeURIComponent(reference));
  // Closed, or another one chosen, while this was on its way.
  if (state.selected !== reference) return;
  state.detail = detail;
  renderDetail();
}

async function selectHandoff(reference) {
  sheet.opened();
  state.selected = reference;
  state.editing = null;
  renderList();
  // A sheet opens at once, at its top, and fills in when the handoff arrives. A wide
  // screen keeps showing the last one meanwhile, as it always has.
  if (isCompact()) {
    state.detail = null;
    renderDetail();
    detailNode.scrollTop = 0;
  }
  await guarded(loadDetail, () => {});
}

/** Back to the list alone: a sheet's 返回列表, or the browser's back. */
function closeHandoff() {
  if (state.selected === null) return;
  state.selected = null;
  state.detail = null;
  state.editing = null;
  renderList();
  renderDetail();
}

async function refreshBoth() {
  await loadDetail();
  await loadList();
}

const post = (suffix, body) =>
  request('/handoffs/' + encodeURIComponent(state.selected) + '/' + suffix,
    { method: 'POST', body: JSON.stringify(body) });

async function toggleTodo(id, done, box) {
  box.disabled = true;
  const todos = state.detail.todos.map(todo => serializeTodo(todo.id === id ? { ...todo, done } : todo)).join('\n');
  await guarded(async () => {
    await post('todos', { todos, lockVersion: state.detail.handoff.lockVersion, note: (done ? '勾选' : '取消勾选') + ' ' + id });
    await refreshBoth();
  }, refreshBoth);
  box.disabled = false;
}

async function saveTodos(todos, button) {
  button.disabled = true;
  await guarded(async () => {
    await post('todos', { todos, lockVersion: state.detail.handoff.lockVersion, note: '在网页上编辑待办清单' });
    state.editing = null;
    await refreshBoth();
    notify('待办已保存');
  }, refreshBoth);
  button.disabled = false;
}

async function saveSection(name, content, button) {
  button.disabled = true;
  await guarded(async () => {
    await post('sections', { section: name, content, lockVersion: state.detail.handoff.lockVersion });
    state.editing = null;
    await loadDetail();
    notify(name + ' 已保存');
  }, loadDetail);
  button.disabled = false;
}

async function changeState(value, select) {
  select.disabled = true;
  await guarded(async () => {
    await post('state', { state: value, lockVersion: state.detail.handoff.lockVersion });
    await refreshBoth();
    notify('状态已更新为 ' + value);
  }, refreshBoth);
  select.disabled = false;
}

async function releaseClaim(button) {
  const reason = prompt('接管释放的原因（会记入变更记录）：', '原认领 Session 已失联');
  if (reason === null) return;
  button.disabled = true;
  await guarded(async () => {
    await post('release', { reason, lockVersion: state.detail.handoff.lockVersion });
    await refreshBoth();
    notify('认领已释放，交接回到待接手');
  }, refreshBoth);
  button.disabled = false;
}

// --- boot ---------------------------------------------------------------------

function projectPicker() {
  const wrap = el('div', 'mp-filters');
  const select = el('select');
  select.setAttribute('aria-label', '项目');
  for (const project of state.projects) {
    const option = el('option', '', project.name || project.identifier);
    option.value = project.identifier;
    if (project.identifier === state.project) option.selected = true;
    select.append(option);
  }
  select.style.flex = '1';
  select.onchange = () => {
    state.project = select.value;
    rememberProject(state.project);
    syncUrl();
    state.selected = null;
    state.detail = null;
    renderDetail();
    void guarded(loadList, () => {});
  };
  wrap.append(select);
  return wrap;
}

/** The handoff a link asks to open. The address drops it once read, as the pool's does, so a
 *  reload shows the list rather than reopening the same one every time. */
function takeOpen() {
  const url = new URL(location.href);
  const open = url.searchParams.get('open');
  if (!open) return '';
  url.searchParams.delete('open');
  history.replaceState(null, '', url);
  return open;
}

/** The address says which project is shown, so it can be linked to and reloaded. */
function syncUrl() {
  if (fixedProject) return;
  const url = new URL(location.href);
  if (state.project) url.searchParams.set('project', state.project);
  else url.searchParams.delete('project');
  history.replaceState(null, '', url);
}

function build() {
  const aside = el('aside');
  if (!fixedProject) aside.append(projectPicker());
  const filters = el('div', 'mp-filters');
  filters.setAttribute('role', 'tablist');
  for (const [label, value] of [['待接手', '待接手'], ['已接手', '已接手'], ['全部', '']]) {
    const button = el('button', 'mp-filter' + (value === state.filter ? ' mp-is-active' : ''), label);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.onclick = () => {
      for (const other of filters.children) other.classList.remove('mp-is-active');
      button.classList.add('mp-is-active');
      state.filter = value;
      void guarded(loadList, () => {});
    };
    filters.append(button);
  }
  listNode = el('div', 'mp-list');
  listNode.setAttribute('aria-live', 'polite');
  aside.append(filters, listNode);

  detailNode = el('section', 'mp-detail');
  detailNode.setAttribute('aria-live', 'polite');
  detailNode.append(el('p', 'mp-empty', '从左侧选择一份交接。'));

  root.append(aside, detailNode);
}

async function mount() {
  const container = document.getElementById('mp-handoff');
  // Already mounted: Turbo fires its load event for in-page updates too.
  if (!container || container.dataset.mounted === '1') return;
  container.dataset.mounted = '1';

  root = container;
  apiBase = container.dataset.api ?? '';
  fixedProject = container.dataset.project || '';
  csrfToken = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
  state = { filter: '待接手', project: fixedProject, projects: [], items: [], selected: null, detail: null, editing: null };

  try {
    const open = takeOpen();
    if (!fixedProject) {
      const session = await request('/session');
      state.projects = session.projects || [];
      // A link naming a project wins, then the project last chosen on either page; the
      // server's default only when nothing was ever chosen — and that default is not
      // remembered, so the pool still opens on its project list for someone who never
      // picked one.
      const fromAddress = new URL(location.href).searchParams.get('project') || '';
      state.project = startingProject({
        fromAddress, remembered: rememberedProject(), visible: state.projects, fallback: session.project
      });
      if (state.project !== session.project || fromAddress) rememberProject(state.project);
      syncUrl();
    } else {
      rememberProject(fixedProject);
    }
    // A link to one handoff, as the search gives (#218), opens it with the list on the tab
    // it is in, so its card is there beside it.
    let unopened = null;
    if (open) {
      try {
        state.detail = await request('/handoffs/' + encodeURIComponent(open));
        state.selected = open;
        const handoffState = state.detail.handoff.handoffState;
        state.filter = handoffState === '待接手' || handoffState === '已接手' ? handoffState : '';
      } catch (error) {
        unopened = error;
      }
    }
    build();
    await loadList();
    if (state.detail) {
      sheet.opened();
      renderDetail();
    }
    if (unopened) notify(unopened.message, 'error');
  } catch (error) {
    build();
    notify(error.message, 'error');
  }
}

// Covers a normal load, a Turbo navigation, and a Turbo cache restore.
if (typeof document !== 'undefined') {
  for (const event of ['turbo:load', 'turbo:render', 'DOMContentLoaded']) {
    document.addEventListener(event, () => { void mount(); });
  }
  void mount();
}
