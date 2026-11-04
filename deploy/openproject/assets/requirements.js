// Requirement pool module, running inside OpenProject's own page.
//
// Second consumer of the arrangement the handoff module introduced: OpenProject renders
// the chrome, this renders the body, and the JSON API is reached through a controller
// that forwards the session cookie. The pipeline that used to be copied from handoff.js
// now lives in shell.js — the extraction waited for this second consumer to say what was
// genuinely common, and the answer was the notice strip, the fetch wrapper and the
// conflict guard. The bodies stayed different all the way down.

// prose.js is imported, not linked from the layout, so the ?v= on this file does not
// reach it and a stale copy can survive a bump here. The version travels with the
// specifier instead: raise it in BOTH importers whenever prose.js changes.
import { localTime, proseNodes, splitInstants } from './prose.js?v=2f4b0da858';
import {
  createSheetHistory, createShell, el, forgetProject, isCompact, loadingNode, rememberedProject, rememberProject,
  sheetBar, startingProject
} from './shell.js?v=4a5e3f829e';

let root = null;
let searchTimer = null;
let apiBase = '';
let fixedProject = '';
let csrfToken = '';

const { notify, request: send, post: sendPost } = createShell({
  root: () => root,
  apiBase: () => apiBase,
  project: () => (fixedProject ? '' : state.project),
  csrfToken: () => csrfToken
});

// The call sites read better naming the shape they want than spelling out the options.
const request = (path, params) => send(path, params ? { params } : undefined);
const post = (path, body) => sendPost(path, body);

// On a narrow screen the detail is a sheet over the list, and back closes it (shell.js).
const sheet = createSheetHistory({
  page: 'requirements', onClose: () => closeDetail(), present: () => Boolean(root?.isConnected)
});

// --- state ----------------------------------------------------------------------

// Field values come from the server's field map. Keeping a copy here meant that adding
// an agent in OpenProject left it unusable from this page, silently.
const options = { state: [], responsibleAgent: [], claimedAgent: [], modules: [] };
// Finished work is the bulk of a mature pool and almost never what someone came to read,
// so it is left out until asked for. Filtering to 已完成 turns the exclusion off.
const HIDDEN_BY_DEFAULT = '已完成';
const PAGE_SIZE = 50;

let state = {
  project: '',
  projects: [],
  openProjectUrl: '',
  items: [],
  total: 0,
  selected: null,
  detail: null,
  history: null,
  tab: 'overview',
  form: null,
  page: 1,
  widths: loadWidths(),
  loading: false,
  select: {},
  unclaimedOnly: false,
  openFilter: null,
  collapsed: new Set(),
  expanded: false,
  types: []
};

let bodyNode;

// --- rendering ------------------------------------------------------------------

function projectList() {
  const wrap = el('section', 'mp-panel');
  wrap.append(el('h2', 'mp-panel-title', '选择项目'));
  if (!state.projects.length) {
    wrap.append(el('p', 'mp-empty', '没有你可以访问的项目。'));
    return wrap;
  }
  const list = el('div', 'mp-project-list');
  for (const project of state.projects) {
    const card = el('button', 'mp-project-card');
    card.type = 'button';
    card.append(el('span', 'mp-project-name', project.name));
    card.append(el('span', 'mp-project-id', project.identifier));
    card.onclick = () => { selectProject(project.identifier); };
    list.append(card);
  }
  wrap.append(list);
  return wrap;
}

/**
 * Column widths, dragged and remembered.
 *
 * Kept in localStorage: it is a per-person layout preference, not data, and it has to
 * survive a reload without a round trip. Reads and writes are guarded — a private window
 * or blocked site data throws on access, and a table that cannot remember its widths is
 * still a usable table.
 */
const WIDTH_KEY = 'mp-requirements-widths';

function loadWidths() {
  try {
    return JSON.parse(localStorage.getItem(WIDTH_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function saveWidths(widths) {
  try {
    localStorage.setItem(WIDTH_KEY, JSON.stringify(widths));
  } catch {
    /* not being able to remember the layout is not worth an error */
  }
}

function resizeHandle(column) {
  const handle = el('span', 'mp-resize');
  handle.title = '拖动调整列宽';
  handle.onclick = event => event.stopPropagation();
  handle.onmousedown = event => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = state.widths[column.key] ?? column.width;
    const move = moveEvent => {
      state.widths[column.key] = Math.max(48, Math.round(startWidth + moveEvent.clientX - startX));
      // Written straight onto the <col> so a drag does not re-render the whole table.
      const col = bodyNode.querySelector(`col[data-column="${column.key}"]`);
      if (col) col.style.width = `${state.widths[column.key]}px`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      saveWidths(state.widths);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  return handle;
}

// Types are seeded in English; these are the labels to read, and the tone each carries.
// A bug should be findable by colour alone in a long list.
const TYPE_LABELS = { Task: '任务', Feature: '特性', Bug: '缺陷', Epic: '史诗', Milestone: '里程碑' };
const TYPE_TONES = { Bug: 'danger', Feature: 'done', Task: 'neutral', Epic: 'accent', Milestone: 'accent' };
const STATE_TONES = {
  待确认: 'muted', 待认领: 'muted', 进行中: 'accent',
  已实现待提交: 'attention', '待验证/验收': 'attention',
  已完成: 'success', 已合并: 'success', 暂缓: 'muted', 取消: 'muted'
};

// ID is the work package number, the one people and agents both say out loud. The
// business id (EVAPROJECT-REQ-…) used to live only in the detail, being long; but it is the
// name records, handoffs and conversations use, and a reader handed one had no way to
// find it in the list (Brian 2026-09-23). So it has a column of its own, searchable.
const COLUMNS = [
  { key: 'workPackageId', label: 'ID', className: 'mp-col-id', width: 76,
    filter: { field: 'ids', search: true, stateKey: 'ids', placeholder: '按 ID 查找', note: '可用逗号分隔多个' } },
  { key: 'id', label: '需求 ID', className: 'mp-col-reqid', width: 210,
    filter: { field: 'requirementId', search: true, stateKey: 'requirementId', placeholder: '按需求 ID 查找', note: '包含即匹配' } },
  { key: 'title', label: '主题', className: 'mp-col-title', width: 320,
    filter: { field: 'subject', search: true, stateKey: 'subject', placeholder: '搜索主题' } },
  { key: 'typeName', label: '类型', width: 84, filter: { field: 'type', source: 'types' },
    tag: value => ({ text: TYPE_LABELS[value] ?? value, tone: TYPE_TONES[value] ?? 'neutral' }) },
  { key: 'ownerUserId', label: '需求提交人', width: 104, filter: { field: 'ownerUserId', source: 'data' } },
  { key: 'visibility', label: '可见性', width: 78, filter: { field: 'visibility', source: 'options' } },
  { key: 'responsibleAgent', label: '负责 Agent', width: 118,
    filter: { field: 'responsibleAgent', source: 'options' },
    edit: { options: 'responsibleAgent', endpoint: 'content', field: 'responsibleAgent' } },
  // Who actually holds it is set by claiming, not by picking from a list.
  { key: 'claimedAgent', label: '实际认领 Agent', width: 130,
    filter: { field: 'claimedAgent', source: 'options', unclaimed: true } },
  { key: 'state', label: '需求状态', width: 130,
    filter: { field: 'state', source: 'options', note: '默认不含已完成' },
    edit: { options: 'state', endpoint: 'state', field: 'state', tone: value => STATE_TONES[value] ?? 'neutral' } }
];

/** The values a column can be filtered by: fixed for a list field, observed for text. */
function filterValues(column) {
  const spec = column.filter;
  if (spec.source === 'options') return options[spec.field] ?? [];
  if (spec.source === 'types') return state.types.map(type => TYPE_LABELS[type.name] ?? type.name);
  const seen = new Set();
  for (const item of state.items) {
    const value = item[column.key];
    if (value !== null && value !== undefined && value !== '') seen.add(String(value));
  }
  return [...seen].sort();
}

/**
 * Filtering from the column header.
 *
 * A plain list of the values in that column, ticked or not — not the operator-and-value
 * dialog the native table uses, which takes several decisions to express "show me these".
 * Values inside one column are an OR, columns AND together.
 */
function headerFilter(column) {
  const search = column.filter.search === true;
  const key = column.filter.stateKey;
  const chosen = search ? [] : (state.select[column.filter.field] ?? []);
  const active = search
    ? (state[key] ?? '') !== ''
    : chosen.length > 0 || (column.filter.unclaimed && state.unclaimedOnly);

  const button = el('button', 'mp-th' + (active ? ' mp-is-filtered' : ''));
  button.type = 'button';
  button.append(el('span', '', column.label));
  button.append(el('span', 'mp-th-caret',
    active && !search ? `· ${chosen.length + (state.unclaimedOnly && column.filter.unclaimed ? 1 : 0)}` : (search ? '⌕' : '▾')));
  button.onclick = event => {
    event.stopPropagation();
    state.openFilter = state.openFilter === column.key ? null : column.key;
    render();
  };

  const cell = el('th', column.className);
  // A narrow screen lines the headers up as chips, the most used first.
  cell.dataset.column = column.key;
  cell.append(button);
  if (state.openFilter !== column.key) return cell;

  // On a narrow screen the menu rises from the bottom over a shade, and a tap on the shade
  // only closes it; without one, that tap also opened whichever row lay under it. The
  // shade is not drawn on a wide screen, where a click beside the menu stays what it was.
  const shade = el('div', 'mp-filter-shade');
  cell.append(shade);
  const menu = el('div', 'mp-filter-menu');
  menu.onclick = event => event.stopPropagation();
  if (column.filter.note) menu.append(el('div', 'mp-filter-note', column.filter.note));

  const clear = el('button', 'mp-filter-clear', '清除');
  clear.type = 'button';
  clear.onclick = () => {
    delete state.select[column.filter.field];
    if (search) state[key] = '';
    if (column.filter.unclaimed) state.unclaimedOnly = false;
    state.page = 1;
    state.openFilter = null;
    void reload();
  };
  menu.append(clear);

  // A free-text column has no list of values to tick: the subject is different on every
  // row, so the only useful question is which ones contain what you are looking for.
  // OpenProject does the matching, so paging and the count stay honest — filtering the
  // page after it arrived would hide a match on page four and count rows you cannot see.
  if (search) {
    const field = el('input', 'mp-filter-search');
    field.type = 'search';
    field.placeholder = column.filter.placeholder ?? '搜索';
    field.value = state[key] ?? '';
    const run = () => {
      clearTimeout(searchTimer);
      state.page = 1;
      void reload({ keepOpen: true });
    };
    // Letters an input method still holds — pinyin before its character is chosen — are
    // not what the reader is looking for: searching them emptied the list and, on a phone,
    // took the keyboard away mid-word. The search waits for the text to be committed, as
    // the top bar's does (#218).
    let composing = false;
    const typed = () => {
      state[key] = field.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(run, 350);
    };
    field.addEventListener('compositionstart', () => {
      composing = true;
      clearTimeout(searchTimer);
    });
    field.addEventListener('compositionend', () => {
      composing = false;
      typed();
    });
    field.oninput = event => {
      if (event.isComposing || composing) return;
      typed();
    };
    field.onkeydown = event => {
      // Enter while composing commits the input method's text; it is not a search.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== 'Enter') return;
      event.preventDefault();
      state[key] = field.value;
      // A phone's keyboard covers most of the list, so its 搜索 closes the box to show
      // what was found; a wide screen keeps it open as before.
      if (isCompact()) {
        clearTimeout(searchTimer);
        state.page = 1;
        void reload();
      } else {
        run();
      }
    };
    menu.append(field);
    // A reload made while typing leaves this node in place (see reload); any other redraw
    // rebuilds it, so the caret has to be put back.
    setTimeout(() => {
      if (!field.isConnected) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }, 0);
  }

  const entry = (label, checked, onToggle) => {
    const row = el('label', 'mp-filter-option');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.onchange = () => { onToggle(box.checked); void reload(); };
    row.append(box, el('span', '', label));
    menu.append(row);
  };

  if (!search && column.filter.unclaimed) {
    entry('（未认领）', state.unclaimedOnly, value => { state.unclaimedOnly = value; state.page = 1; });
  }
  if (!search) {
    for (const value of filterValues(column)) {
      entry(value, chosen.includes(value), on => {
        const next = new Set(state.select[column.filter.field] ?? []);
        if (on) next.add(value); else next.delete(value);
        state.page = 1;
        if (next.size) state.select[column.filter.field] = [...next];
        else delete state.select[column.filter.field];
      });
    }
  }
  cell.append(menu);
  // The popup is taller than the table whenever the list is short, and .mp-main scrolls
  // horizontally — which forces overflow-y to auto as well, so the container clips it.
  // position:fixed escapes every overflow ancestor, but then the popup no longer follows
  // the header, so its place is measured from the button once it is actually laid out.
  // Flips above the header when there is no room below, and never runs off the right.
  requestAnimationFrame(() => {
    if (!menu.isConnected) return;
    const anchor = button.getBoundingClientRect();
    const height = menu.offsetHeight;
    const below = window.innerHeight - anchor.bottom;
    menu.style.top = (below < height + 8 && anchor.top > height + 8
      ? anchor.top - height
      : anchor.bottom) + 'px';
    menu.style.left = Math.max(8,
      Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  });
  return cell;
}

/** A cell the reader can change without leaving the list. */
function editableCell(item, column) {
  const tone = column.edit.tone?.(item[column.key]) ?? null;
  const node = el('select', 'mp-cell-input' + (tone ? ` mp-tone-${tone}` : ''));
  const current = item[column.key] ?? '';
  for (const value of ['', ...(options[column.edit.options] ?? [])]) {
    const option = el('option', '', value === '' ? '—' : value);
    option.value = value;
    if (value === current) option.selected = true;
    node.append(option);
  }
  // The row's own click opens the detail; changing a value should not also do that.
  node.onclick = event => event.stopPropagation();
  node.onchange = async event => {
    event.stopPropagation();
    const value = node.value;
    node.disabled = true;
    try {
      const saved = await post(
        `/requirements/${encodeURIComponent(item.id ?? item.workPackageId)}/${column.edit.endpoint}`,
        { [column.edit.field]: value, lockVersion: item.lockVersion }
      );
      Object.assign(item, saved.requirement ?? {});
      notify('已保存');
      // The new value can take the row out of the filters (Brian 2026-09-23, #193), and
      // the row can be the one open on the right.
      void refreshList();
      if (state.selected === (item.id ?? String(item.workPackageId))) void refreshDetail();
    } catch (error) {
      node.value = current;
      notify(error.message, 'error');
    } finally {
      node.disabled = false;
      render();
    }
  };
  return node;
}

/**
 * The query behind the list, built from what the header filters have selected.
 *
 * Separate from the request that sends it because this is the part with rules in it:
 * which column is filtered by id rather than by name, when finished work is allowed in,
 * and the order the list is read in. The request itself has nothing to get wrong.
 *
 * Repeating a name is how one column says OR; different names are ANDed by the server.
 */
// The one formatter every page uses; see prose.js.
export { localTime };

/**
 * When a requirement was proposed, as precisely as it is known and no more precisely.
 *
 * Shown raw, it read 2026-09-22T03:20:00+08:00（timestamp）: an offset nobody asked about
 * and the precision's English name (Brian 2026-09-23). A time is shown in the reader's
 * timezone; a date alone is only a day, so it is shown as that day without being moved
 * across a timezone boundary; an unknown time says so.
 */
export function proposedTime(at, precision) {
  if (precision === 'unknown') return '未知';
  if (!at) return null;
  if (precision === 'date') {
    const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(at));
    return day ? `${Number(day[1])}年${Number(day[2])}月${Number(day[3])}日` : String(at);
  }
  return localTime(at) || String(at);
}

/**
 * How many things are currently narrowing the list.
 *
 * Used to decide whether to offer a way out. A filter that returns nothing used to hide
 * the table, and the filters live in the table's own header — so the only way back was a
 * page reload, which is not something a reader should have to work out.
 */
export function activeFilterCount(view) {
  const picked = Object.values(view.select ?? {}).reduce((total, values) => total + values.length, 0);
  return picked + (view.unclaimedOnly ? 1 : 0)
    + ((view.subject ?? '').trim() ? 1 : 0)
    + ((view.ids ?? '').trim() ? 1 : 0)
    + ((view.requirementId ?? '').trim() ? 1 : 0);
}

export function listParams(view) {
  // Brian reads the pool by ID and lines requirements up with agents by ID, so that is
  // the order the list is actually used in. The server's own default is updatedAt:desc,
  // which reshuffles the list on every edit.
  const params = [
    ['page_size', String(PAGE_SIZE)],
    ['cursor', String(view.page)],
    ['sort_by', 'id:asc']
  ];
  for (const [field, values] of Object.entries(view.select ?? {})) {
    for (const value of values) {
      // The type column is picked by name but filtered by id.
      if (field === 'type') {
        const type = (view.types ?? []).find(
          candidate => (TYPE_LABELS[candidate.name] ?? candidate.name) === value);
        if (type) params.push(['select.type', String(type.id)]);
      } else {
        params.push([`select.${field}`, value]);
      }
    }
  }
  if (view.unclaimedOnly) params.push(['unclaimed', '1']);
  const subject = (view.subject ?? '').trim();
  if (subject) params.push(['subject', subject]);
  // An id is looked up rather than searched, so only digits are sent; anything else the
  // reader typed would otherwise come back as an empty list with no reason given.
  const ids = (view.ids ?? '').split(/[,，\s]+/).map(value => value.trim()).filter(value => /^\d+$/.test(value));
  if (ids.length) params.push(['ids', ids.join(',')]);
  // Searched rather than looked up: a part such as 20260922-003 is how one is remembered,
  // and a match also brings the children whose ids extend it.
  const requirementId = (view.requirementId ?? '').trim();
  if (requirementId) params.push(['requirement_id', requirementId]);
  // Finished work stays out until the 需求状态 column says otherwise.
  if (!view.select?.state?.length) params.push(['exclude_state', HIDDEN_BY_DEFAULT]);
  return params;
}

/**
 * Orders rows so a child follows its parent, indented.
 *
 * A page arrives in tree order, each row saying how deep it sits in the whole match
 * (#258). A child whose parent is on the page nests under it. One whose parent is not
 * keeps the depth it came with and says who it sits under: its family began on an earlier
 * page, or the filters left the parent out and it came at depth 0. Nothing is fetched just
 * to draw a line.
 */
export function arrange(items, collapsed) {
  const byWorkPackage = new Map(items.map(item => [item.workPackageId, item]));
  const children = new Map();
  const roots = [];
  for (const item of items) {
    const parent = item.parentWorkPackageId;
    if (parent !== null && parent !== undefined && byWorkPackage.has(parent)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(item);
    } else {
      roots.push(item);
    }
  }
  const ordered = [];
  // Nesting is arbitrarily deep — OpenProject puts no limit on it and neither does this.
  const walk = (item, depth, detached) => {
    const kids = children.get(item.workPackageId) ?? [];
    // A collapsed row still says how many it is hiding, so nothing disappears silently.
    const hidden = collapsed.has(item.workPackageId);
    let buried = 0;
    if (hidden) {
      const count = node => (children.get(node.workPackageId) ?? [])
        .reduce((sum, child) => sum + 1 + count(child), 0);
      buried = count(item);
    }
    ordered.push({ item, depth, children: kids.length, collapsed: hidden, buried, detached });
    if (hidden) return;
    for (const child of kids) walk(child, depth + 1, false);
  };
  for (const item of roots) {
    const parent = item.parentWorkPackageId;
    walk(item, item.depth ?? 0, parent !== null && parent !== undefined);
  }
  return ordered;
}

function requirementTable() {
  const table = el('table', 'mp-table');
  // Fixed layout so the widths below are obeyed rather than treated as hints.
  const group = el('colgroup');
  for (const column of COLUMNS) {
    const col = el('col');
    col.dataset.column = column.key;
    col.style.width = `${state.widths[column.key] ?? column.width}px`;
    group.append(col);
  }
  table.append(group);
  const head = el('thead');
  const headRow = el('tr');
  for (const column of COLUMNS) {
    const cell = column.filter ? headerFilter(column) : el('th', column.className);
    if (!column.filter) cell.append(el('span', 'mp-th-plain', column.label));
    cell.append(resizeHandle(column));
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);

  const body = el('tbody');
  if (!state.items.length) {
    const row = el('tr', 'mp-row-empty');
    const cell = el('td', 'mp-empty', activeFilterCount(state) > 0
      ? '没有符合当前筛选的需求。'
      : '这个项目还没有需求。');
    cell.colSpan = COLUMNS.length;
    row.append(cell);
    body.append(row);
    table.append(body);
    return table;
  }
  for (const { item, depth, children, collapsed, buried, detached } of arrange(state.items, state.collapsed)) {
    const row = el('tr', 'mp-row');
    if (state.selected === item.id) row.classList.add('mp-is-active');
    row.onclick = () => selectRequirement(item.id ?? String(item.workPackageId));
    // A narrow screen draws the row as a card and indents the whole card, not the title.
    row.style.setProperty('--mp-depth', String(depth));

    for (const column of COLUMNS) {
      const cell = el('td', column.className);
      // Which column it is, for the card a narrow screen lays the cells out in.
      cell.dataset.column = column.key;
      if (column.key === 'title') {
        // Indentation alone reads as an accident at one level deep, so a child also gets
        // a connector. The parent's name is only repeated when the parent is not on
        // screen to be indented under.
        cell.style.paddingLeft = `${8 + depth * 22}px`;
        if (depth > 0) cell.append(el('span', 'mp-row-branch', '└'));
        if (children > 0) {
          const toggle = el('button', 'mp-row-toggle', collapsed ? '▸' : '▾');
          toggle.type = 'button';
          toggle.setAttribute('aria-label', collapsed ? '展开子需求' : '收起子需求');
          toggle.onclick = event => {
            event.stopPropagation();
            if (collapsed) state.collapsed.delete(item.workPackageId);
            else state.collapsed.add(item.workPackageId);
            render();
          };
          cell.append(toggle);
        } else if (state.items.some(other => other.parentWorkPackageId)) {
          // Keeps titles on one line whether or not a row has a toggle.
          cell.append(el('span', 'mp-row-toggle mp-is-empty', ''));
        }
        cell.append(el('span', 'mp-row-title', item.title));
        if (collapsed && buried) cell.append(el('span', 'mp-row-parent', ` +${buried}`));
        if (detached) cell.append(el('span', 'mp-row-parent', ` 属于 ${item.parentTitle ?? '上级需求'}`));
      } else if (column.edit) {
        cell.append(editableCell(item, column));
      } else {
        const value = item[column.key];
        const empty = value === null || value === undefined || value === '';
        if (empty) cell.classList.add('mp-is-empty');
        if (!empty && column.tag) {
          const tag = column.tag(String(value));
          cell.append(el('span', `mp-tag mp-tone-${tag.tone}`, tag.text));
        } else {
          cell.append(el('span', 'mp-cell-text', empty ? '—' : String(value)));
        }
      }
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body);
  return table;
}

function section(title, build) {
  const wrap = el('section', 'mp-detail-section');
  wrap.append(el('h4', 'mp-detail-heading', title));
  const content = build();
  if (content) wrap.append(content);
  return wrap;
}

/**
 * Where a listed reference opens, when not here. A handoff is not a requirement and this
 * page's API refuses it, so it opens on its project's handoff page with it open, the
 * address a search hit uses (Brian 2026-09-25, #262). A requirement opens in this page.
 */
export function referenceHref(item) {
  if (item.typeName !== '交接') return null;
  if (!item.project) return `/work_packages/${item.workPackageId}`;
  const reference = item.id || String(item.workPackageId);
  return `/projects/${encodeURIComponent(item.project)}/handoff?open=${encodeURIComponent(reference)}`;
}

function referenceList(items, empty) {
  if (!items?.length) return el('p', 'mp-empty', empty);
  const list = el('ul', 'mp-ref-list');
  for (const item of items) {
    const row = el('li');
    const link = el('button', 'mp-ref');
    link.type = 'button';
    link.append(el('span', 'mp-ref-id', item.id ?? `#${item.workPackageId}`));
    link.append(el('span', 'mp-ref-title', item.title ?? ''));
    if (item.state) link.append(el('span', 'mp-ref-state', item.state));
    const href = referenceHref(item);
    link.onclick = () => {
      if (href) window.location.assign(href);
      else if (item.id) selectRequirement(item.id);
    };
    row.append(link);
    list.append(row);
  }
  return list;
}

/**
 * Change history and the box to add to it.
 *
 * Kept on this page rather than left to OpenProject's own (Brian 2026-09-22). The change
 * sentences are OpenProject's own wording, so the history reads the same whether an agent
 * or a person made the change.
 */
/**
 * Initials for the disc in front of a history entry.
 *
 * Two letters from a latin name (first and last word, the pair OpenProject shows), one
 * character from a Chinese one — two would already be half the name.
 */
function initialsOf(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) {
    return parts[0].slice(0, /^[\u4e00-\u9fff]/.test(parts[0]) ? 1 : 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The disc itself.
 *
 * OpenProject already serves whatever picture a user uploaded at /users/:id/avatar, so
 * that is what gets asked for rather than a second likeness invented here; it answers
 * with nothing for the many users who never uploaded one, and the initials underneath
 * stay visible — the same fallback the native activity stream ends on. The image only
 * becomes visible once it has actually loaded, so a missing one never flashes a broken
 * icon. The hue is derived from the name, so one person keeps one colour down the whole
 * timeline without a palette having to be stored anywhere.
 */
function avatarDisc(name, userId) {
  const disc = el('span', 'mp-avatar', initialsOf(name));
  disc.title = name;
  let hue = 0;
  for (const character of String(name)) hue = (hue * 31 + character.codePointAt(0)) % 360;
  disc.style.setProperty('--mp-avatar-hue', String(hue));
  if (userId) {
    const image = el('img', 'mp-avatar-image');
    image.alt = '';
    image.style.display = 'none';
    image.onload = () => { image.style.display = ''; };
    image.onerror = () => image.remove();
    image.src = `/users/${encodeURIComponent(userId)}/avatar`;
    disc.append(image);
  }
  return disc;
}

function historyBlock() {
  const wrap = el('div');
  const box = el('textarea', 'mp-comment');
  box.placeholder = '写条评论…';
  box.rows = 2;
  const send = el('button', 'mp-action mp-is-primary', '发表');
  send.type = 'button';
  send.onclick = async () => {
    const text = box.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await post(`/requirements/${encodeURIComponent(state.selected)}/comment`, { text });
      box.value = '';
      await loadHistory(state.selected);
      notify('已发表');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      send.disabled = false;
      render();
    }
  };
  const actions = el('div', 'mp-comment-actions');
  actions.append(send);
  wrap.append(box, actions);

  if (state.history === null) {
    wrap.append(loadingNode('载入历史…'));
    return wrap;
  }
  if (!state.history.length) {
    wrap.append(el('p', 'mp-empty', '还没有变更记录。'));
    return wrap;
  }
  const list = el('ul', 'mp-history');
  for (const entry of [...state.history].reverse()) {
    const row = el('li', 'mp-history-item');
    const name = entry.user ?? '未知';
    row.append(avatarDisc(name, entry.userId));

    const body = el('div', 'mp-history-body');
    const meta = el('div', 'mp-history-meta');
    const who = el('span', 'mp-history-user', name);
    // The agent that wrote it, from the signature the service puts on every write
    // (Brian 2026-09-23). Absent on entries from before signing began, and on anything
    // written in OpenProject's own screens: not known, so not shown.
    if (entry.agent) who.append(el('span', 'mp-history-agent', ` · ${entry.agent}`));
    meta.append(who);
    meta.append(el('span', 'mp-history-time', localTime(entry.createdAt)));
    body.append(meta);
    if (entry.comment) {
      const comment = el('div', 'mp-history-comment');
      comment.append(...proseNodes(entry.comment));
      body.append(comment);
    }
    // One change per line, indented under the name, the way the native activity lists
    // them — a single entry can carry ten of them and they ran together before.
    const details = (entry.details ?? []).filter(Boolean);
    if (details.length) {
      const changes = el('ul', 'mp-history-details');
      for (const detail of details) changes.append(detailLine(detail));
      body.append(changes);
    }
    row.append(body);
    list.append(row);
  }
  wrap.append(list);
  return wrap;
}

/**
 * One change sentence. A time field's value comes as it was stored — an agent's timestamp
 * with its offset, 「认领时间 设置为 2026-09-25T17:50:00+08:00」 — so it is shown in the
 * reader's time like every other time on the page, as the prose does (Brian 2026-09-25,
 * #265). The rest of the sentence is OpenProject's own.
 */
function detailLine(detail) {
  const line = el('li', 'mp-history-detail');
  for (const part of splitInstants(detail)) {
    if (!part.instant) {
      line.append(document.createTextNode(part.text));
      continue;
    }
    const node = el('time', 'mp-time', part.text);
    node.dateTime = part.instant;
    line.append(node);
  }
  return line;
}

// A requirement carries more than fits in one column, and the tail of it — relations,
// files, everything that ever happened — only grows. Tabs keep the common read (what it
// says and where it stands) free of a scroll past all of that.
const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'relations', label: '关系', count: detail => (detail.children?.length ?? 0)
      + (detail.parent ? 1 : 0)
      + (detail.dependencies?.blockedBy?.length ?? 0)
      + (detail.dependencies?.blocks?.length ?? 0)
      + (detail.dependencies?.related?.length ?? 0) },
  { key: 'files', label: '附件', count: detail => detail.attachments?.length ?? 0 },
  { key: 'history', label: '历史' }
];

/**
 * Claiming, releasing and completing.
 *
 * Each form is exactly the arguments the service already takes — no extra validation and
 * no rules restated here. Completion in particular refuses a commit whose SHA is not 40
 * hex characters, files outside a repository without their locations or a description of
 * the change, evidence without verification or an acceptance source, and anything still
 * blocked by a dependency or an unfinished required child. Those checks live on the
 * server, where they cannot be skipped; the page only reports what comes back.
 */
function actionBar(item) {
  const bar = el('div', 'mp-actions');
  const open = name => { state.form = state.form === name ? null : name; render(); };

  const claimed = Boolean(item.claimedAgent || item.claimedSession);
  const claim = el('button', 'mp-action', claimed ? '重新认领' : '认领');
  claim.type = 'button';
  claim.onclick = () => open('claim');
  bar.append(claim);

  if (claimed) {
    const release = el('button', 'mp-action', '释放');
    release.type = 'button';
    release.onclick = () => open('release');
    bar.append(release);
  }

  const complete = el('button', 'mp-action', '完成');
  complete.type = 'button';
  complete.onclick = () => open('complete');
  bar.append(complete);
  return bar;
}

function field(label, node) {
  const wrap = el('label', 'mp-form-field');
  wrap.append(el('span', 'mp-form-label', label));
  wrap.append(node);
  return wrap;
}

const input = (placeholder, value = '') => {
  const node = el('input', 'mp-form-input');
  node.type = 'text';
  node.placeholder = placeholder;
  node.value = value;
  return node;
};

async function submitForm(path, body, button) {
  button.disabled = true;
  try {
    await post(`/requirements/${encodeURIComponent(state.selected)}/${path}`, body);
    state.form = null;
    notify('已保存');
    await selectRequirement(state.selected);
    await reload();
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    button.disabled = false;
    render();
  }
}

function actionForm(item) {
  if (!state.form) return null;
  const form = el('div', 'mp-form');
  const submit = (label, build) => {
    const button = el('button', 'mp-action mp-is-primary', label);
    button.type = 'button';
    button.onclick = () => void submitForm(state.form, build(), button);
    const actions = el('div', 'mp-form-actions');
    actions.append(button);
    form.append(actions);
  };

  if (state.form === 'claim') {
    const agent = el('select', 'mp-form-input');
    for (const value of options.claimedAgent ?? []) {
      const option = el('option', '', value);
      option.value = value;
      if (value === (item.claimedAgent ?? item.responsibleAgent)) option.selected = true;
      agent.append(option);
    }
    const scope = input('这次要做到哪一步');
    form.append(field('认领 Agent', agent), field('认领范围', scope));
    submit('认领', () => ({ agent: agent.value, scope: scope.value, lockVersion: item.lockVersion }));
    return form;
  }

  if (state.form === 'release') {
    const reason = input('为什么释放');
    form.append(field('释放原因', reason));
    // A person is never the session that holds a claim, so this is always a takeover.
    form.append(el('p', 'mp-form-note', '从网页释放属于接管，会记进认领历史。'));
    submit('释放', () => ({ reason: reason.value, lockVersion: item.lockVersion }));
    return form;
  }

  // A commit, or files that live outside any repository — a global skill, a hook, local
  // configuration — where there is no commit to name. Only the fields of the kind chosen
  // are shown.
  const kind = el('select', 'mp-form-input');
  for (const [value, label] of [['git', 'Git 提交'], ['file', '仓库外文件']]) {
    const option = el('option', '', label);
    option.value = value;
    kind.append(option);
  }
  const repository = input('仓库名', 'Eva-Project');
  const sha = input('40 位 commit SHA');
  const paths = input('改动路径，逗号分隔');
  const locations = input('文件或制品的实际位置，逗号分隔');
  const change = input('改了什么');
  const verification = input('验证结果');
  const acceptanceSource = input('验收来源');
  const acceptanceStatus = el('select', 'mp-form-input');
  for (const value of ['已验收', '不适用']) {
    const option = el('option', '', value);
    option.value = value;
    acceptanceStatus.append(option);
  }
  const gitFields = [field('仓库', repository), field('提交 SHA', sha), field('路径', paths)];
  const fileFields = [field('位置', locations), field('变更说明', change)];
  const showKind = () => {
    for (const node of gitFields) node.hidden = kind.value !== 'git';
    for (const node of fileFields) node.hidden = kind.value !== 'file';
  };
  kind.onchange = showKind;
  showKind();
  form.append(
    field('交付类型', kind), ...gitFields, ...fileFields,
    field('验证', verification), field('验收状态', acceptanceStatus), field('验收来源', acceptanceSource)
  );
  submit('完成', () => ({
    evidence: [completionEvidence(kind.value, {
      repository: repository.value, sha: sha.value, paths: paths.value,
      locations: locations.value, change: change.value,
      verification: verification.value, acceptanceStatus: acceptanceStatus.value,
      acceptanceSource: acceptanceSource.value
    })],
    lockVersion: item.lockVersion
  }));
  return form;
}

/**
 * One piece of completion evidence from what was typed into the form, in the shape the
 * service takes: a commit, or files outside any repository. Lists are typed comma
 * separated. Nothing is judged here; the service refuses what is missing.
 */
export function completionEvidence(kind, values) {
  const list = text => String(text ?? '').split(/[,，]/).map(part => part.trim()).filter(Boolean);
  const shared = {
    verification: values.verification,
    acceptanceStatus: values.acceptanceStatus,
    acceptanceSource: values.acceptanceSource
  };
  if (kind === 'file') {
    return { kind: 'file', locations: list(values.locations), change: values.change, ...shared };
  }
  return { repository: values.repository, sha: String(values.sha ?? '').trim(), paths: list(values.paths), ...shared };
}

// The panel's controls are drawn in strokes, as Claude Code draws its pane controls (Brian
// 2026-09-25, #256): arrows out to widen the panel, arrows in to go back to the list, a
// cross to close it. The words stay as the tooltip and the accessible name.
const PANEL_ICONS = {
  expand: ['M9.5 2.5h4v4', 'M13.5 2.5 9 7', 'M6.5 13.5h-4v-4', 'M2.5 13.5 7 9'],
  collapse: ['M13.5 6.5h-4v-4', 'M9.5 6.5 14 2', 'M2.5 9.5h4v4', 'M6.5 9.5 2 14'],
  close: ['M4 4l8 8', 'M12 4l-8 8']
};

function iconButton(icon, label, onclick) {
  const button = el('button', 'mp-icon-button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({
    viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
  })) svg.setAttribute(name, value);
  for (const d of PANEL_ICONS[icon]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  button.append(svg);
  button.onclick = onclick;
  return button;
}

function detailPanel() {
  const summary = state.items.find(candidate => candidate.id === state.selected);
  if (!summary && !state.detail) return null;
  const detail = state.detail;
  const item = detail?.summary ?? summary;
  const panel = el('aside', 'mp-detail');
  // Only a narrow screen shows it: there the panel is a sheet over the list, and this is
  // the way back to it, in place of the widen and close icons.
  panel.append(sheetBar(() => sheet.close()));

  const head = el('div', 'mp-detail-head');
  const heading = el('div');
  heading.append(el('h3', 'mp-detail-title', item.title));
  heading.append(el('div', 'mp-detail-id', item.id ?? `#${item.workPackageId}`));
  head.append(heading);
  const tools = el('div', 'mp-detail-tools');
  tools.append(iconButton(state.expanded ? 'collapse' : 'expand', state.expanded ? '回到列表' : '展开', () => {
    state.expanded = !state.expanded;
    render();
  }));
  tools.append(iconButton('close', '关闭', () => sheet.close()));
  head.append(tools);
  panel.append(head);

  if (!detail) {
    panel.append(loadingNode('载入详情…'));
    return panel;
  }

  const tabs = el('div', 'mp-tabs');
  for (const tab of TABS) {
    const button = el('button', 'mp-tab' + (state.tab === tab.key ? ' mp-is-active' : ''));
    button.type = 'button';
    button.append(el('span', '', tab.label));
    const count = tab.count?.(detail) ?? null;
    if (count) button.append(el('span', 'mp-tab-count', String(count)));
    button.onclick = () => {
      state.tab = tab.key;
      // History is only worth a request once someone asks to see it.
      if (tab.key === 'history' && state.history === null) void loadHistory(state.selected);
      render();
    };
    tabs.append(button);
  }
  panel.append(tabs);

  const body = el('div', 'mp-tab-body');
  panel.append(body);

  if (state.tab === 'overview') {
    // Grouped rather than one dense label/value grid. A requirement carries a dozen
    // attributes and reading them off a packed two-column list is tiring
    // (Brian 2026-09-22); the native page groups its own for the same reason.
    // Everything the record carries, grouped. Nothing here is editable: maintaining a
    // requirement by hand stays on the native work package page (Brian 2026-09-22), so
    // this side is for reading it.
    const requester = [detail.sourceLabel, item.requesterName, item.requesterId]
      .filter(Boolean).join(' / ') || null;
    const proposed = proposedTime(detail.proposedAt, detail.proposedTimePrecision);

    const groups = [
      ['进展', [
        ['需求状态', item.state, STATE_TONES[item.state] ?? null],
        ['受理状态', detail.intakeStatus],
        ['负责 Agent', item.responsibleAgent],
        ['实际认领 Agent', item.claimedAgent],
        ['认领标签', detail.claimLabel],
        ['认领时间', localTime(detail.claimedAt) || null],
        ['认领会话', detail.claim?.session],
        ['认领范围', detail.claim?.scope ?? detail.claimScope]
      ]],
      // The pair a completion is judged on. Its own group rather than a tail on 进展:
      // both are empty until the work is finished, and an empty group is not drawn.
      ['验收', [
        ['验证状态', detail.verificationStatus],
        ['用户验收', detail.userAcceptance]
      ]],
      ['归属', [
        ['类型', item.typeName ? (TYPE_LABELS[item.typeName] ?? item.typeName) : null,
          TYPE_TONES[item.typeName] ?? null],
        ['优先级', item.priority],
        ['模块', item.modules?.join('、')],
        ['可见性', item.visibility],
        ['需求提交人', item.ownerUserId],
        ['父需求必需项', detail.requiredForParent ? '是' : null]
      ]],
      ['来源', [
        ['提出者类型', item.requesterType],
        ['提出者', requester],
        ['提出时间', proposed],
        ['来源 Session', detail.sourceSessionId],
        ['来源消息', detail.sourceMessageId]
      ]],
      ['时间', [
        ['更新时间', localTime(item.updatedAt) || null]
      ]]
    ];

    for (const [name, rows] of groups) {
      const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
      if (!shown.length) continue;
      const group = el('section', 'mp-group');
      group.append(el('h4', 'mp-group-title', name));
      const grid = el('div', 'mp-group-grid');
      for (const [label, value, tone] of shown) {
        const cell = el('div', 'mp-attr');
        cell.append(el('div', 'mp-attr-label', label));
        cell.append(tone
          ? el('span', `mp-tag mp-tone-${tone}`, String(value))
          : el('div', 'mp-attr-value', String(value)));
        grid.append(cell);
      }
      group.append(grid);
      body.append(group);
    }

    const completion = detail.completion ?? {};
    const blocked = (completion.blockingDependencies?.length ?? 0)
      + (completion.incompleteRequiredChildren?.length ?? 0);
    body.append(el('div',
      'mp-ready ' + (completion.complete ? 'mp-is-done' : completion.ready ? 'mp-is-ready' : 'mp-is-blocked'),
      completion.complete ? '已完成' : completion.ready ? '可以开工' : `被 ${blocked} 项挡住`));

    body.append(actionBar(item));
    const form = actionForm(item);
    if (form) body.append(form);

    body.append(section('正文', () => {
      if (!detail.description) return el('p', 'mp-empty', '尚无正文。');
      const prose = el('div', 'mp-detail-prose');
      prose.append(...proseNodes(detail.description));
      return prose;
    }));
  }

  if (state.tab === 'relations') {
    if (detail.parent) body.append(section('上级需求', () => referenceList([detail.parent], '')));
    body.append(section('子需求', () => referenceList(detail.children, '没有子需求。')));
    const deps = detail.dependencies ?? {};
    body.append(section('依赖', () => {
      if (!deps.blockedBy?.length && !deps.blocks?.length && !deps.related?.length) {
        return el('p', 'mp-empty', '没有依赖。');
      }
      const wrap = el('div');
      if (deps.blockedBy?.length) { wrap.append(el('div', 'mp-dep-label', '被这些挡住')); wrap.append(referenceList(deps.blockedBy, '')); }
      if (deps.blocks?.length) { wrap.append(el('div', 'mp-dep-label', '挡住这些')); wrap.append(referenceList(deps.blocks, '')); }
      if (deps.related?.length) { wrap.append(el('div', 'mp-dep-label', '相关')); wrap.append(referenceList(deps.related, '')); }
      return wrap;
    }));
  }

  if (state.tab === 'files') {
    if (!detail.attachments?.length) body.append(el('p', 'mp-empty', '没有附件。'));
    else {
      const list = el('ul', 'mp-ref-list');
      for (const file of detail.attachments) {
        const row = el('li');
        const link = el('a', 'mp-ref');
        // The attachment endpoint, not the work package page: the file downloads.
        link.href = `${state.openProjectUrl}/api/v3/attachments/${file.id}/content`;
        link.append(el('span', 'mp-ref-title', file.fileName ?? '附件'));
        if (file.fileSize) link.append(el('span', 'mp-ref-state', `${Math.max(1, Math.round(file.fileSize / 1024))} KB`));
        row.append(link);
        list.append(row);
      }
      body.append(list);
    }
  }

  if (state.tab === 'history') body.append(historyBlock());
  return panel;
}

/**
 * Paging.
 *
 * The list asks for one page, not the pool: a project that has run for a while has more
 * requirements than anyone scrolls. The server lays the whole match out as a tree and a
 * page is PAGE_SIZE rows of it, children counted like any other row (#258), so the pages
 * are the total divided up. The server counts the whole match, so the total is the real
 * one and not just what was fetched.
 */
function pager() {
  const bar = el('div', 'mp-pager');
  const pages = pageCount();
  const go = (label, page, disabled) => {
    const button = el('button', 'mp-action', label);
    button.type = 'button';
    button.disabled = disabled;
    button.onclick = () => { state.page = page; state.collapsed = new Set(); void reload(); };
    bar.append(button);
  };
  go('← 上一页', state.page - 1, state.page <= 1 || state.loading);
  bar.append(el('span', 'mp-pager-label', `第 ${state.page} / ${pages} 页 · 共 ${state.total} 条`));
  go('下一页 →', state.page + 1, state.page >= pages || state.loading);
  return bar;
}

function pageCount() {
  return Math.max(1, Math.ceil(state.total / PAGE_SIZE));
}

/** The row over the list: back to every project, the project and its count, the way out of
 *  the filters. */
function listHeader() {
  const header = el('div', 'mp-header');
  if (!fixedProject) {
    const back = el('button', 'mp-action', '← 全部项目');
    back.type = 'button';
    back.onclick = () => {
      state.project = '';
      state.items = [];
      state.selected = null;
      state.detail = null;
      forgetProject();
      syncUrl();
      render();
    };
    header.append(back);
  }
  const current = state.projects.find(project => project.identifier === state.project);
  header.append(el('span', 'mp-header-title', current?.name ?? state.project));
  header.append(el('span', 'mp-count', state.loading ? '载入中…' : `${state.total} 条`));
  const narrowing = activeFilterCount(state);
  if (narrowing > 0) {
    const clear = el('button', 'mp-action mp-clear-filters', `清除筛选（${narrowing}）`);
    clear.type = 'button';
    clear.onclick = () => {
      state.select = {};
      state.unclaimedOnly = false;
      // Every search box too: the ID search used to survive this, so the count said
      // nothing was narrowing the list while it still was.
      state.subject = '';
      state.ids = '';
      state.requirementId = '';
      state.page = 1;
      state.openFilter = null;
      void reload();
    };
    header.append(clear);
  }
  return header;
}

// Which record and tab the sheet last showed; see render.
let sheetView = '';

function render() {
  // A sheet is redrawn with everything else. It keeps its place while it shows the same
  // record on the same tab: opening 认领 or 完成 below the fold jumped it back to the top,
  // away from the form just opened. (A wide panel scrolls its tab body instead, and keeps
  // behaving as it did.)
  const shown = bodyNode.querySelector('.mp-detail');
  const view = `${state.selected}|${state.tab}`;
  const keep = shown && view === sheetView ? shown.scrollTop : 0;
  bodyNode.replaceChildren();
  if (!state.project) {
    bodyNode.append(projectList());
    return;
  }

  bodyNode.append(listHeader());

  const detail = detailPanel();
  // Widening the panel is a wide screen's control. A sheet has the whole screen already,
  // and the list stays under it so closing it lands where the reader left off.
  const expanded = state.expanded && Boolean(detail) && !isCompact();
  const layout = el('div', 'mp-layout' + (expanded ? ' mp-is-expanded' : ''));
  if (!expanded) {
    const main = el('div', 'mp-main');
    if (state.loading) main.append(loadingNode());
    // The table is rendered even with nothing in it: the column filters live in its
    // header, so dropping the table when a filter matched nothing took away the only
    // way to undo that filter and left a reload as the way out.
    else main.append(requirementTable());
    layout.append(main);
  }
  if (detail) layout.append(detail);
  bodyNode.append(layout);
  // While a page is on its way the pager's count is the last one, or 0 on the first load.
  if (!expanded && !state.loading) bodyNode.append(pager());
  sheetView = detail ? view : '';
  if (detail && keep) detail.scrollTop = keep;
}

// --- actions --------------------------------------------------------------------

function syncUrl() {
  if (fixedProject) return;
  const url = new URL(location.href);
  if (state.project) url.searchParams.set('project', state.project);
  else url.searchParams.delete('project');
  history.replaceState(null, '', url);
}

/**
 * Fetches the history behind the tab that asks for it.
 *
 * Callers do not await this, so it renders itself when the answer lands — otherwise the
 * panel keeps showing "载入历史…" over data it already has.
 */
async function loadHistory(reference) {
  try {
    const result = await request('/requirements/' + encodeURIComponent(reference) + '/activities');
    if (state.selected !== reference) return;
    state.history = result.items ?? [];
  } catch (error) {
    if (state.selected !== reference) return;
    state.history = [];
    notify(error.message, 'error');
  }
  render();
}

async function selectRequirement(reference) {
  sheet.opened();
  state.selected = reference;
  state.detail = null;
  state.form = null;
  state.history = null;
  render();
  try {
    state.detail = await request('/requirements/' + encodeURIComponent(reference));
  } catch (error) {
    notify(error.message, 'error');
  }
  render();
  if (state.tab === 'history') void loadHistory(reference);
}

/** Back to the list alone: the panel's 关闭, a sheet's 返回列表, or the browser's back. */
function closeDetail() {
  if (state.selected === null && state.detail === null) return;
  state.selected = null;
  state.detail = null;
  state.expanded = false;
  render();
}

function selectProject(identifier) {
  state.project = identifier;
  rememberProject(identifier);
  state.selected = null;
  state.page = 1;
  state.detail = null;
  syncUrl();
  void reload();
}

async function reload({ keepOpen = false } = {}) {
  // Picking a value from a list is one decision and the popup closing after it is the
  // answer. Typing is not: closing it after the first keystroke that fetches would mean
  // the third character has nowhere to go.
  if (!keepOpen) state.openFilter = null;
  // While a column's search box is being typed into, it stays in place and only the rows
  // under it change. Drawn afresh — the loading ring used to take the table's place — it
  // took a phone's keyboard away after every pause in the typing.
  const typing = keepOpen && Boolean(bodyNode.querySelector('.mp-filter-search'));
  const asked = JSON.stringify(listParams(state));
  if (!typing) {
    state.loading = true;
    render();
  }
  let result = null;
  let failure = null;
  try {
    result = await request('/requirements', listParams(state));
  } catch (error) {
    failure = error;
  }
  // Typed on meanwhile: the later search has the say.
  if (typing && JSON.stringify(listParams(state)) !== asked) return;
  state.items = failure ? [] : result.items ?? [];
  state.total = failure ? 0 : result.total ?? state.items.length;
  if (failure) notify(failure.message, 'error');
  state.loading = false;
  if (typing && bodyNode.querySelector('.mp-filter-search')) refreshRows();
  else render();
}

/** The rows, the count and the pager, redrawn around a search box left as it is. */
function refreshRows() {
  const table = bodyNode.querySelector('.mp-table');
  if (!table) {
    render();
    return;
  }
  table.querySelector('tbody').replaceWith(requirementTable().querySelector('tbody'));
  bodyNode.querySelector('.mp-header')?.replaceWith(listHeader());
  bodyNode.querySelector('.mp-pager')?.replaceWith(pager());
}

/**
 * The current page again, fetched without the 载入中 placeholder: after a change made in
 * the list, a row that no longer matches the filters has to leave it, and blanking the
 * table meanwhile would throw away the reader's place in it.
 */
async function refreshList() {
  const asked = JSON.stringify(listParams(state));
  try {
    const result = await request('/requirements', listParams(state));
    // The reader filtered or turned the page meanwhile; that load has the say.
    if (JSON.stringify(listParams(state)) !== asked) return;
    state.items = result.items ?? [];
    state.total = result.total ?? state.items.length;
    const pages = pageCount();
    if (state.page > pages) {
      // The change emptied the last page.
      state.page = pages;
      await refreshList();
      return;
    }
  } catch (error) {
    notify(error.message, 'error');
  }
  render();
}

/** The open requirement again, keeping the tab and form the reader has open. */
async function refreshDetail() {
  const reference = state.selected;
  try {
    const detail = await request('/requirements/' + encodeURIComponent(reference));
    if (state.selected !== reference) return;
    state.detail = detail;
  } catch (error) {
    notify(error.message, 'error');
  }
  render();
  if (state.tab === 'history' && state.selected === reference) void loadHistory(reference);
}

// --- boot -----------------------------------------------------------------------

async function mount() {
  const container = document.getElementById('mp-requirements');
  if (!container || container.dataset.mounted === '1') return;
  container.dataset.mounted = '1';

  root = container;
  apiBase = container.dataset.api ?? '';
  fixedProject = container.dataset.project || '';
  csrfToken = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
  state = {
    project: fixedProject || new URL(location.href).searchParams.get('project') || '',
    projects: [],
    openProjectUrl: '',
    items: [],
    total: 0,
    selected: null,
    detail: null,
    history: null,
    tab: 'overview',
    form: null,
    page: 1,
    widths: loadWidths(),
    loading: false,
    select: {},
    unclaimedOnly: false,
    subject: '',
    ids: '',
    requirementId: '',
    openFilter: null,
    collapsed: new Set(),
    expanded: false,
    types: []
  };

  bodyNode = el('div', 'mp-body');
  container.append(bodyNode);
  document.addEventListener('click', () => {
    if (state.openFilter === null) return;
    state.openFilter = null;
    render();
  });
  render();

  try {
    const session = await request('/session');
    state.projects = session.projects ?? [];
    state.openProjectUrl = session.openProjectUrl ?? '';
    // Opened without a project in its route: a link naming one wins, then the project
    // last chosen on either page. Never having chosen still lands on the project list.
    if (!fixedProject) {
      state.project = startingProject({
        fromAddress: state.project, remembered: rememberedProject(), visible: state.projects
      });
      syncUrl();
    }
    rememberProject(state.project);
    const meta = await request('/meta');
    Object.assign(options, meta.options ?? {});
    state.types = meta.types ?? [];
    if (state.project) await reload();
    else render();
    // The home page links a requirement this way. The address drops it once opened, so a
    // reload shows the list rather than reopening the same record every time.
    const open = new URL(location.href).searchParams.get('open');
    if (open && state.project) {
      const url = new URL(location.href);
      url.searchParams.delete('open');
      history.replaceState(null, '', url);
      await selectRequirement(open);
    }
  } catch (error) {
    render();
    notify(error.message, 'error');
  }
}

if (typeof document !== 'undefined') {
  for (const event of ['turbo:load', 'turbo:render', 'DOMContentLoaded']) {
    document.addEventListener(event, () => { void mount(); });
  }
  void mount();
}
