// The home page (Brian 2026-09-23, #185): the pool as it stands, what a day, a week or a
// month brought, and what is waiting on someone — for one project or for all of them.
//
// It began as a row of period-bound counts. Brian then asked for charts, for the pool's
// current numbers rather than only period-bound ones, and for whatever else a working
// dashboard needs. Hence: the current numbers and where they sit (state, module, Agent),
// the lists behind the numbers that need someone, a trend of what arrived against what
// was finished, and what changed last. The counting is done by the server through the
// pool's own visibility rules, so a private requirement never reaches someone else's
// numbers; the Agents and modules are whatever the records carry, and none is named here.
//
// Everything is built as DOM nodes from text, so nothing an author wrote is interpreted
// as HTML.

import { createShell, el, loadingNode } from './shell.js?v=4a5e3f829e';

let root = null;
let apiBase = '';
let csrfToken = '';
let bodyNode = null;
let tipNode = null;
let state = null;

const { notify, request } = createShell({
  root: () => root,
  apiBase: () => apiBase,
  // Counted across every project at once; the chosen one is picked out of the answer.
  project: () => '',
  csrfToken: () => csrfToken
});

export const PERIODS = [
  { value: 'day', label: '日', current: '今天', unit: '天' },
  { value: 'week', label: '周', current: '本周', unit: '周' },
  { value: 'month', label: '月', current: '本月', unit: '个月' }
];
const DEFAULT_PERIOD = 'week';
/** How many periods the trend shows, ending with the current one. */
export const TREND_LENGTH = { day: 14, week: 12, month: 12 };

/**
 * The period containing `date`, in the reader's time zone: a calendar day, a week starting
 * on Monday, or a calendar month. `to` is where the next one starts.
 */
export function periodRange(kind, date) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  let from = day;
  if (kind === 'week') from = new Date(day.getFullYear(), day.getMonth(), day.getDate() - (day.getDay() + 6) % 7);
  if (kind === 'month') from = new Date(day.getFullYear(), day.getMonth(), 1);
  return { from, to: shiftPeriod(kind, from, 1) };
}

/** The start of the period `steps` away from the one starting at `from`. */
export function shiftPeriod(kind, from, steps) {
  if (kind === 'month') return new Date(from.getFullYear(), from.getMonth() + steps, 1);
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + steps * (kind === 'week' ? 7 : 1));
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** How the chosen period reads: 「本周 · 9月21日 – 9月27日」, 「2025年3月」 and so on. */
export function periodLabel(kind, from, now = new Date()) {
  const monthDay = date => `${date.getMonth() + 1}月${date.getDate()}日`;
  const year = date => (date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`);
  let text;
  if (kind === 'day') {
    text = `${year(from)}${monthDay(from)} ${WEEKDAYS[from.getDay()]}`;
  } else if (kind === 'week') {
    const last = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6);
    const crossesYear = last.getFullYear() !== from.getFullYear();
    text = `${year(from)}${monthDay(from)} – ${crossesYear ? `${last.getFullYear()}年` : ''}${monthDay(last)}`;
  } else {
    text = `${from.getFullYear()}年${from.getMonth() + 1}月`;
  }
  const current = periodRange(kind, now).from.getTime() === from.getTime();
  return current ? `${PERIODS.find(period => period.value === kind).current} · ${text}` : text;
}

/** The trend's periods as their boundaries: the last one is the current period. */
export function trendEdges(kind, now = new Date()) {
  const current = periodRange(kind, now).from;
  const count = TREND_LENGTH[kind];
  return Array.from({ length: count + 1 }, (_, index) => shiftPeriod(kind, current, index - (count - 1)));
}

/** The short name of one of the trend's periods, for its axis; the tooltip has the rest. */
export function bucketLabel(kind, from) {
  return kind === 'month' ? `${from.getMonth() + 1}月` : `${from.getMonth() + 1}/${from.getDate()}`;
}

/** A clean top for a count axis, and the ticks under it. */
export function countScale(max) {
  let top = 1;
  for (let magnitude = 1; ; magnitude *= 10) {
    const found = [1, 2, 4, 5, 10].map(step => step * magnitude).find(value => value >= max);
    if (found !== undefined) {
      top = found;
      break;
    }
  }
  return { top, ticks: top % 2 === 0 ? [0, top / 2, top] : [0, top] };
}

/** When something happened, in words, against the reader's clock. */
export function relativeTime(iso, now = new Date()) {
  const time = Date.parse(iso ?? '');
  if (!Number.isFinite(time)) return '时间未知';
  const minutes = Math.floor((now.getTime() - time) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 60 * 24 * 30) return `${Math.floor(minutes / (60 * 24))} 天前`;
  const date = new Date(time);
  return `${date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`;
}

const pad = value => String(value).padStart(2, '0');
const formatDate = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localStamp = iso => {
  const date = new Date(iso);
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function parseDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? '');
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return formatDate(date) === text ? date : null;
}

/**
 * What the address asks to be shown. Anything missing or unreadable falls back to all
 * projects this week, and a period that has not begun yet to the current one.
 */
export function readView(search, now = new Date()) {
  const params = new URLSearchParams(search);
  const asked = params.get('period');
  const period = PERIODS.some(option => option.value === asked) ? asked : DEFAULT_PERIOD;
  const date = parseDate(params.get('date'));
  return {
    project: params.get('project') ?? '',
    period,
    from: periodRange(period, date && date <= now ? date : now).from
  };
}

/** The address for a view; what is already the default is left out, so links stay short. */
export function writeView(url, view, now = new Date()) {
  const next = new URL(url);
  const set = (key, value) => (value ? next.searchParams.set(key, value) : next.searchParams.delete(key));
  set('project', view.project);
  set('period', view.period === DEFAULT_PERIOD ? '' : view.period);
  set('date', periodRange(view.period, now).from.getTime() === view.from.getTime() ? '' : formatDate(view.from));
  return next;
}

const stateCount = name => tally => tally.states?.[name] ?? 0;

/** The row of counts, in the order Brian listed them. 需求 is everything that is not a Bug. */
export const METRICS = [
  { label: '需求', hint: '含 Task', value: tally => tally.total - tally.bugs },
  { label: 'Bug', value: tally => tally.bugs },
  { label: '未认领', value: tally => tally.unclaimed },
  { label: '进行中', value: stateCount('进行中') },
  { label: '已实现待提交', value: stateCount('已实现待提交') },
  { label: '待验证/验收', value: stateCount('待验证/验收') },
  { label: '已完成', value: stateCount('已完成') }
];

/** The life of a requirement, in order; a state the pool adds later follows these. */
export const STATE_ORDER = ['待确认', '待认领', '进行中', '已实现待提交', '待验证/验收', '已完成', '暂缓', '取消'];

/** States in lifecycle order, every known one present so the chart keeps its shape. */
export function stateRows(states = {}) {
  const extra = Object.keys(states).filter(name => !STATE_ORDER.includes(name));
  return [...STATE_ORDER, ...extra].map(name => ({ label: name, value: states[name] ?? 0 }));
}

/** Everything shown for the chosen project, or for all of them when none is chosen. */
export function chosenView(data, project) {
  if (!data) return null;
  if (!project) return data.all;
  return data.projects.find(item => item.identifier === project) ?? null;
}

// Same tones as the pool's state column, so a state reads the same on both pages.
const STATE_TONES = {
  待确认: 'muted', 待认领: 'muted', 进行中: 'accent',
  已实现待提交: 'attention', '待验证/验收': 'attention',
  已完成: 'success', 暂缓: 'muted', 取消: 'muted'
};

// --- pieces ---------------------------------------------------------------------

function projectName(identifier) {
  return state.data?.projects.find(project => project.identifier === identifier)?.name ?? identifier ?? '';
}

function requirementHref(item) {
  const reference = item.id ?? String(item.workPackageId);
  return `/projects/${encodeURIComponent(item.project ?? '')}/requirements?open=${encodeURIComponent(reference)}`;
}

function when(iso, verb) {
  const node = el('time', 'mp-dash-when', `${relativeTime(iso)}${verb}`);
  if (iso) {
    node.dateTime = iso;
    node.title = localStamp(iso);
  }
  return node;
}

function sectionHead(title, note, ...extra) {
  const head = el('div', 'mp-dash-section-head');
  const titles = el('div', 'mp-dash-section-titles');
  titles.append(el('h2', 'mp-dash-section-title', title));
  if (note) titles.append(el('p', 'mp-dash-section-note', note));
  head.append(titles, ...extra);
  return head;
}

function card(title, ...extra) {
  const node = el('section', 'mp-dash-panel');
  const head = el('div', 'mp-dash-panel-head');
  head.append(el('h3', 'mp-dash-panel-title', title), ...extra);
  node.append(head);
  return node;
}

function statTiles(tally, label) {
  const section = el('div', 'mp-dash-stats');
  section.setAttribute('role', 'list');
  section.setAttribute('aria-label', label);
  for (const metric of METRICS) {
    const tile = el('div', 'mp-dash-stat');
    tile.setAttribute('role', 'listitem');
    const name = el('span', 'mp-dash-stat-label', metric.label);
    if (metric.hint) name.append(el('span', 'mp-dash-stat-hint', metric.hint));
    tile.append(name, el('span', 'mp-dash-stat-value', tally ? String(metric.value(tally)) : '–'));
    section.append(tile);
  }
  return section;
}

// --- tooltip ----------------------------------------------------------------------

function showTip(anchor, lines, event) {
  if (!tipNode || !tipNode.isConnected) {
    tipNode = el('div', 'mp-dash-tip');
    tipNode.setAttribute('role', 'tooltip');
    root.append(tipNode);
  }
  tipNode.replaceChildren(...lines.map(([value, name, series]) => {
    const row = el('div', 'mp-dash-tip-row');
    if (series) row.append(el('span', `mp-dash-key mp-dash-key-${series}`));
    row.append(el('strong', '', value));
    if (name) row.append(el('span', '', name));
    return row;
  }));
  tipNode.hidden = false;
  const box = anchor.getBoundingClientRect();
  const x = event?.clientX ?? box.left + box.width / 2;
  const y = event?.clientY ?? box.top;
  const width = tipNode.offsetWidth;
  tipNode.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - width - 8))}px`;
  tipNode.style.top = `${Math.max(8, y - tipNode.offsetHeight - 12)}px`;
}

function hideTip() {
  if (tipNode) tipNode.hidden = true;
}

function withTip(node, lines) {
  node.addEventListener('pointermove', event => showTip(node, lines(), event));
  node.addEventListener('pointerleave', hideTip);
  node.addEventListener('focus', () => showTip(node, lines()));
  node.addEventListener('blur', hideTip);
}

// --- charts -------------------------------------------------------------------------

/** One series of counts against categories: a bar each, the value at its tip. */
function barList(rows, { unit = '条', empty = '没有数据。' } = {}) {
  const max = Math.max(0, ...rows.map(row => row.value));
  if (max === 0) return el('p', 'mp-empty', empty);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const list = el('div', 'mp-dash-bars');
  for (const row of rows) {
    const line = el('div', 'mp-dash-bar-row' + (row.value === 0 ? ' mp-is-zero' : ''));
    line.tabIndex = 0;
    line.setAttribute('aria-label', `${row.label}：${row.value} ${unit}`);
    const track = el('span', 'mp-dash-bar-track');
    const fill = el('span', 'mp-dash-bar');
    fill.style.setProperty('--mp-share', String(row.value / max));
    track.append(fill, el('span', 'mp-dash-bar-value', String(row.value)));
    line.append(el('span', 'mp-dash-bar-label', row.label), track);
    withTip(line, () => [[`${row.value} ${unit}`, `${row.label} · 占 ${total ? Math.round((row.value / total) * 100) : 0}%`]]);
    list.append(line);
  }
  return list;
}

/** Agents by the same counts as the tiles, each cell shaded by how many it holds. */
function heatTable(rows, emptyText) {
  if (!rows.length) return el('p', 'mp-empty', emptyText);
  const values = rows.flatMap(row => METRICS.map(metric => metric.value(row)));
  const max = Math.max(1, ...values);
  const table = el('table', 'mp-dash-heat');
  const head = el('tr');
  head.append(el('th', '', 'Agent'));
  for (const metric of METRICS) head.append(el('th', '', metric.label));
  table.createTHead().append(head);
  const body = table.createTBody();
  for (const row of rows) {
    const line = el('tr');
    line.append(el('th', row.agent ? '' : 'mp-is-unassigned', row.agent ?? '未指定'));
    for (const metric of METRICS) {
      const value = metric.value(row);
      const cell = el('td', value === 0 ? 'mp-is-zero' : '', String(value));
      cell.style.setProperty('--mp-heat', `${Math.round((value / max) * 55)}%`);
      line.append(cell);
    }
    body.append(line);
  }
  const wrap = el('div', 'mp-dash-table-wrap');
  wrap.append(table);
  return wrap;
}

function heatLegend() {
  const legend = el('span', 'mp-dash-heat-legend');
  legend.append(el('span', '', '少'), el('span', 'mp-dash-heat-ramp'), el('span', '', '多'));
  legend.setAttribute('aria-hidden', 'true');
  return legend;
}

/**
 * What arrived against what was finished, a period a column pair. The chosen period is
 * marked; choosing another one is a click on it.
 */
function trendChart(view, edges, kind) {
  const buckets = view.trend.buckets;
  const max = Math.max(0, ...buckets.flatMap(bucket => [bucket.created, bucket.completed]));
  const { top, ticks } = countScale(max);
  const chosen = edges.findIndex(edge => edge.getTime() === state.from.getTime());
  // A narrow axis names every other period, counted from the chosen one so that its own
  // label is never crowded by a neighbour's.
  const anchor = chosen >= 0 ? chosen : buckets.length - 1;

  const figure = el('div', 'mp-dash-trend');
  const plot = el('div', 'mp-dash-trend-plot');
  const grid = el('div', 'mp-dash-trend-grid');
  grid.setAttribute('aria-hidden', 'true');
  for (const tick of ticks) {
    const line = el('span', 'mp-dash-trend-tick');
    line.style.bottom = `${(tick / top) * 100}%`;
    line.append(el('span', 'mp-dash-trend-tick-label', String(tick)));
    grid.append(line);
  }
  const columns = el('div', 'mp-dash-trend-columns');
  columns.style.gridTemplateColumns = `repeat(${buckets.length}, minmax(0, 1fr))`;
  const axis = el('div', 'mp-dash-trend-axis');
  axis.style.gridTemplateColumns = columns.style.gridTemplateColumns;
  axis.setAttribute('aria-hidden', 'true');

  buckets.forEach((bucket, index) => {
    const from = edges[index];
    const label = periodLabel(kind, from);
    const column = el('button', 'mp-dash-trend-column' + (index === chosen ? ' mp-is-chosen' : ''));
    column.type = 'button';
    column.setAttribute('aria-pressed', String(index === chosen));
    column.setAttribute('aria-label',
      `${label}：新建 ${bucket.created}（其中 Bug ${bucket.createdBugs}），完成 ${bucket.completed}`);
    const bars = el('span', 'mp-dash-trend-bars');
    for (const [series, value] of [['1', bucket.created], ['2', bucket.completed]]) {
      const bar = el('span', `mp-dash-trend-bar mp-dash-series-${series}` + (value === 0 ? ' mp-is-zero' : ''));
      bar.style.height = `${(value / top) * 100}%`;
      bars.append(bar);
    }
    column.append(bars);
    column.onclick = () => {
      if (index === chosen) return;
      state.period = kind;
      state.from = from;
      hideTip();
      void load();
    };
    withTip(column, () => [
      [label, ''],
      [String(bucket.created), `新建（其中 Bug ${bucket.createdBugs}）`, '1'],
      [String(bucket.completed), '完成', '2']
    ]);
    columns.append(column);
    const tick = el('span', index === chosen ? 'mp-is-chosen' : '', bucketLabel(kind, from));
    if (Math.abs(index - anchor) % 2 === 1) tick.classList.add('mp-is-sparse');
    axis.append(tick);
  });

  plot.append(grid, columns);
  figure.append(plot, axis);
  return figure;
}

function trendTable(view, edges, kind) {
  const table = el('table', 'mp-dash-heat mp-dash-trend-table');
  const head = el('tr');
  for (const name of ['时间段', '新建', '其中 Bug', '完成']) head.append(el('th', '', name));
  table.createTHead().append(head);
  const body = table.createTBody();
  view.trend.buckets.forEach((bucket, index) => {
    const line = el('tr');
    line.append(el('th', '', periodLabel(kind, edges[index])));
    for (const value of [bucket.created, bucket.createdBugs, bucket.completed]) {
      line.append(el('td', value === 0 ? 'mp-is-zero' : '', String(value)));
    }
    body.append(line);
  });
  const wrap = el('div', 'mp-dash-table-wrap');
  wrap.append(table);
  return wrap;
}

function legend(entries) {
  const node = el('span', 'mp-dash-legend');
  for (const [series, name] of entries) {
    const entry = el('span', 'mp-dash-legend-entry');
    entry.append(el('span', `mp-dash-swatch mp-dash-series-${series}`), el('span', '', name));
    node.append(entry);
  }
  return node;
}

// --- lists ------------------------------------------------------------------------

function itemList(list, { empty, describe }) {
  const wrap = el('div', 'mp-dash-list-wrap');
  if (!list || list.items.length === 0) {
    wrap.append(el('p', 'mp-empty', list ? empty : '暂时读不到。'));
    return wrap;
  }
  const items = el('ul', 'mp-dash-list');
  for (const item of list.items) {
    const entry = el('li', 'mp-dash-list-item');
    const link = el('a', 'mp-dash-list-title', item.title);
    link.href = item.href;
    entry.append(link, describe(item));
    items.append(entry);
  }
  wrap.append(items);
  if (list.total > list.items.length) wrap.append(el('p', 'mp-dash-more', `还有 ${list.total - list.items.length} 条`));
  return wrap;
}

function requirementMeta(item, verb = '更新') {
  const meta = el('span', 'mp-dash-list-meta');
  const parts = [];
  if (!state.project) parts.push(projectName(item.project));
  parts.push(item.responsibleAgent ?? '未指定 Agent');
  meta.append(el('span', '', parts.filter(Boolean).join(' · ')), when(item.updatedAt, verb));
  return meta;
}

function withHref(list) {
  return list && { ...list, items: list.items.map(item => ({ ...item, href: requirementHref(item) })) };
}

function attentionCards(view) {
  const grid = el('div', 'mp-dash-grid mp-dash-grid-4');
  const count = list => el('span', 'mp-dash-panel-count', list ? String(list.total) : '–');
  const lists = [
    ['等待验收', view.attention.acceptance, '没有等待验收的需求。'],
    ['等待确认', view.attention.confirmation, '没有等待确认的需求。'],
    [`停滞 ${state.data.staleDays} 天以上`, view.attention.stale, '没有停滞的需求。']
  ];
  for (const [title, list, empty] of lists) {
    const panel = card(title, count(list));
    panel.append(itemList(withHref(list), { empty, describe: item => requirementMeta(item) }));
    grid.append(panel);
  }

  const handoffs = state.project ? state.data.handoffs?.projects?.[state.project] : state.data.handoffs?.all;
  const panel = card('待接手的交接', count(handoffs));
  panel.append(itemList(handoffs && {
    ...handoffs,
    items: handoffs.items.map(item => ({ ...item, href: `/projects/${encodeURIComponent(item.project)}/handoff` }))
  }, {
    empty: '没有待接手的交接。',
    describe: item => {
      const meta = el('span', 'mp-dash-list-meta');
      const parts = [];
      if (!state.project) parts.push(projectName(item.project));
      if (item.todoTotal) parts.push(`待办 ${item.todoDone ?? 0}/${item.todoTotal}`);
      if (item.expectedAgent && item.expectedAgent !== '不限') parts.push(`交给 ${item.expectedAgent}`);
      meta.append(el('span', '', parts.join(' · ')), when(item.updatedAt, '更新'));
      return meta;
    }
  }));
  grid.append(panel);
  return grid;
}

function recentList(view) {
  const list = el('ul', 'mp-dash-list mp-dash-recent');
  if (!view.recent.length) return el('p', 'mp-empty', '还没有需求。');
  for (const item of view.recent) {
    const entry = el('li', 'mp-dash-list-item');
    const link = el('a', 'mp-dash-list-title', item.title);
    link.href = requirementHref(item);
    const pill = el('span', `mp-dash-pill mp-tone-${STATE_TONES[item.state] ?? 'muted'}`, item.state ?? '无状态');
    const line = el('span', 'mp-dash-list-line');
    line.append(pill, link);
    entry.append(line, requirementMeta(item));
    list.append(entry);
  }
  return list;
}

// --- page -------------------------------------------------------------------------

function projectChips() {
  const chips = el('div', 'mp-dash-projects');
  chips.setAttribute('role', 'tablist');
  chips.setAttribute('aria-label', '项目');
  const choices = [
    { identifier: '', name: '全部项目', total: state.data?.all.period.total },
    ...(state.data?.projects ?? []).map(project => ({ ...project, total: project.period.total }))
  ];
  for (const project of choices) {
    const active = project.identifier === state.project;
    const chip = el('button', 'mp-dash-chip' + (active ? ' mp-is-active' : ''));
    chip.type = 'button';
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(active));
    chip.title = '所选时间段新建的需求数';
    chip.append(el('span', '', project.name));
    if (project.total !== undefined) chip.append(el('span', 'mp-dash-chip-count', String(project.total)));
    chip.onclick = () => {
      state.project = project.identifier;
      syncUrl();
      render();
    };
    chips.append(chip);
  }
  return chips;
}

function periodPicker() {
  const now = new Date();
  const wrap = el('div', 'mp-dash-period');

  const kinds = el('div', 'mp-dash-segment');
  kinds.setAttribute('role', 'tablist');
  kinds.setAttribute('aria-label', '时间维度');
  for (const option of PERIODS) {
    const active = option.value === state.period;
    const button = el('button', active ? 'mp-is-active' : '', option.label);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(active));
    button.onclick = () => {
      if (active) return;
      // From the current period, the current one of the new kind; from an earlier one,
      // the period of the new kind it falls in.
      const current = periodRange(state.period, now).from.getTime() === state.from.getTime();
      state.from = periodRange(option.value, current ? now : state.from).from;
      state.period = option.value;
      void load();
    };
    kinds.append(button);
  }

  const step = (label, text, steps, disabled) => {
    const button = el('button', 'mp-dash-step', text);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.disabled = disabled;
    button.onclick = () => {
      state.from = shiftPeriod(state.period, state.from, steps);
      void load();
    };
    return button;
  };
  const unit = PERIODS.find(option => option.value === state.period);
  const isCurrent = periodRange(state.period, now).from.getTime() === state.from.getTime();

  // Kept together, so a narrow screen wraps the arrows with the dates they move.
  const stepper = el('div', 'mp-dash-stepper');
  stepper.append(
    step(`上一${unit.unit}`, '‹', -1, false),
    el('span', 'mp-dash-period-label', periodLabel(state.period, state.from, now)),
    // Nothing has been created in a period that has not started.
    step(`下一${unit.unit}`, '›', 1, shiftPeriod(state.period, state.from, 1) > now)
  );
  if (!isCurrent) {
    const back = el('button', 'mp-dash-today', `回到${unit.current}`);
    back.type = 'button';
    back.onclick = () => {
      state.from = periodRange(state.period, now).from;
      void load();
    };
    stepper.append(back);
  }
  wrap.append(kinds, stepper);
  return wrap;
}

function freshness() {
  const wrap = el('div', 'mp-dash-fresh');
  // A new answer on its way says so where the time of the last one stands (#209).
  if (state.loading && state.data) wrap.append(loadingNode('更新中…'));
  else if (state.data?.generatedAt) wrap.append(el('span', '', `更新于 ${localStamp(state.data.generatedAt).slice(11)}`));
  const refresh = el('button', 'mp-dash-refresh', '刷新');
  refresh.type = 'button';
  refresh.disabled = state.loading;
  refresh.onclick = () => { void load(); };
  wrap.append(refresh);
  return wrap;
}

function currentSection(view) {
  const section = el('section', 'mp-dash-section');
  section.append(
    sectionHead('现状', '需求池此刻的实际数字，不受上面的时间段影响。'),
    statTiles(view?.current, '现状')
  );
  if (!view) return section;

  section.append(attentionCards(view));

  const charts = el('div', 'mp-dash-grid mp-dash-grid-2');
  const states = card('状态分布');
  states.append(barList(stateRows(view.current.states), { empty: '还没有需求。' }));
  const modules = card('未完成的需求 · 按模块');
  modules.append(barList(view.current.modules.map(row => ({ label: row.module ?? '未指定模块', value: row.open })),
    { empty: '没有未完成的需求。' }));
  charts.append(states, modules);
  section.append(charts);

  const agents = card('各负责 Agent · 现状', heatLegend());
  agents.append(heatTable(view.current.agents, '还没有需求。'));
  section.append(agents);
  return section;
}

function periodSection(view) {
  const section = el('section', 'mp-dash-section');
  const label = periodLabel(state.period, state.from);
  section.append(
    sectionHead('新建与完成', `${label}。按创建时间统计这段时间新提的需求，状态为当前状态。`),
    statTiles(view?.period, '所选时间段')
  );
  if (!view) return section;

  // While a new kind of period loads, the trend on screen is still the old one's.
  const { edges, kind } = state.trend;
  const unit = PERIODS.find(option => option.value === kind);
  const asTable = state.trendAsTable;
  const toggle = el('button', 'mp-dash-toggle', asTable ? '看图表' : '看表格');
  toggle.type = 'button';
  toggle.onclick = () => {
    state.trendAsTable = !state.trendAsTable;
    render();
  };
  const trend = card(`最近 ${TREND_LENGTH[kind]} ${unit.unit}`, legend([['1', '新建'], ['2', '完成']]), toggle);
  const chosen = edges.findIndex(edge => edge.getTime() === state.from.getTime());
  const picked = view.trend.buckets[chosen];
  if (picked) {
    trend.append(el('p', 'mp-dash-trend-summary',
      `${periodLabel(kind, edges[chosen])}：新建 ${picked.created}（其中 Bug ${picked.createdBugs}），完成 ${picked.completed}`));
  }
  trend.append(asTable ? trendTable(view, edges, kind) : trendChart(view, edges, kind));
  const notes = [asTable
    ? '新建按创建时间，完成按交付证据里的完成时间。'
    : '新建按创建时间，完成按交付证据里的完成时间；点柱子可切到那个时间段。'];
  if (view.trend.undatedCompletions > 0) {
    notes.push(`另有 ${view.trend.undatedCompletions} 条已完成的需求没有记录完成时间，未计入完成。`);
  }
  trend.append(el('p', 'mp-dash-footnote', notes.join('')));
  section.append(trend);

  const agents = card('各负责 Agent · 所选时间段新建', heatLegend());
  agents.append(heatTable(view.period.agents, '这段时间没有新建的需求。'));
  section.append(agents);
  return section;
}

function render() {
  const view = chosenView(state.data, state.project);
  const filters = el('div', 'mp-dash-filters');
  const controls = el('div', 'mp-dash-controls');
  controls.append(periodPicker(), freshness());
  filters.append(projectChips(), controls);
  bodyNode.className = 'mp-body' + (state.loading ? ' mp-is-loading' : '');
  // The first answer is still on its way: a turning ring where the numbers will be, rather
  // than empty tiles that read as a pool with nothing in it (Brian 2026-09-24, #209).
  if (!state.data && state.loading) {
    bodyNode.replaceChildren(filters, loadingNode('统计载入中…'));
    return;
  }
  // What the period changes comes first, right under the period it answers to. The pool
  // as it stands follows: it was showing first, so changing the period looked like it
  // did nothing (Brian 2026-09-23).
  const parts = [filters, periodSection(view), currentSection(view)];
  if (view) {
    const recent = el('section', 'mp-dash-section');
    const panel = el('div', 'mp-dash-panel');
    panel.append(recentList(view));
    recent.append(sectionHead('最近更新', null), panel);
    parts.push(recent);
  }
  bodyNode.replaceChildren(...parts);
}

// --- actions ------------------------------------------------------------------------

function syncUrl() {
  history.replaceState(null, '', writeView(location.href, state));
}

async function load() {
  syncUrl();
  state.loading = true;
  render();
  // Choices can outrun answers; only the newest one is shown.
  const ticket = ++state.ticket;
  const edges = trendEdges(state.period);
  try {
    const data = await request('/dashboard', {
      params: [
        ['from', state.from.toISOString()],
        ['to', shiftPeriod(state.period, state.from, 1).toISOString()],
        ['edges', edges.map(edge => edge.toISOString()).join(',')]
      ],
      failure: '统计没能载入'
    });
    if (ticket !== state.ticket) return;
    state.data = data;
    state.trend = { edges, kind: state.period };
    // A project from a link that this person cannot see is not an empty one.
    if (state.project && !data.projects.some(project => project.identifier === state.project)) {
      state.project = '';
      syncUrl();
    }
  } catch (error) {
    if (ticket !== state.ticket) return;
    notify(error.message, 'error');
  } finally {
    if (ticket === state.ticket) {
      state.loading = false;
      render();
    }
  }
}

// --- boot ---------------------------------------------------------------------------

async function mount() {
  const container = document.getElementById('mp-dashboard');
  if (!container || container.dataset.mounted === '1') return;
  container.dataset.mounted = '1';

  root = container;
  apiBase = container.dataset.api ?? '';
  csrfToken = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
  state = {
    ...readView(location.search),
    data: null,
    trend: { edges: [], kind: DEFAULT_PERIOD },
    loading: false,
    ticket: 0,
    trendAsTable: false
  };

  bodyNode = el('div', 'mp-body');
  container.append(bodyNode);
  await load();
}

if (typeof document !== 'undefined') {
  for (const event of ['turbo:load', 'turbo:render', 'DOMContentLoaded']) {
    document.addEventListener(event, () => { void mount(); });
  }
  void mount();
}
