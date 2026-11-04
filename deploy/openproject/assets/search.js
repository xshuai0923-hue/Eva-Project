// The top bar's search (Brian 2026-09-24, #218): requirements and handoffs only, across
// every project the reader may see, in two groups. Typing shows the first few of each
// group under the box; Enter, or 查看全部, opens the results page, where each group pages
// on its own.
//
// Answers come from the pool's own API, which applies the visibility rules; nothing here
// decides who may see what. Everything is built as DOM nodes from text, so nothing an
// author wrote is ever interpreted as HTML.

import { createShell, el, loadingNode } from './shell.js?v=ed60c0da2c';
import { localTime } from './prose.js?v=2f4b0da858';

export const RESULTS_PATH = '/requirements/search';
const PREVIEW_SIZE = 5;
const PAGE_SIZE = 20;
const TYPING_PAUSE_MS = 250;
const MAX_LENGTH = 100;

export const GROUPS = [
  { name: 'requirements', label: '需求', none: '没有匹配的需求。' },
  { name: 'handoffs', label: '上下文交接', none: '没有匹配的上下文交接。' }
];

// The pool's tones for its states, and the handoff page's for its own, so a state reads the
// same wherever it is shown.
const STATE_TONES = {
  待确认: 'muted', 待认领: 'muted', 进行中: 'accent',
  已实现待提交: 'attention', '待验证/验收': 'attention',
  已完成: 'success', 暂缓: 'muted', 取消: 'muted',
  草稿: 'muted', 待接手: 'attention', 已接手: 'accent', 已归档: 'muted', 已作废: 'muted'
};

// The pool's names for the types, so a type reads the same here as in its column.
const TYPE_LABELS = { Task: '任务', Feature: '特性', Bug: '缺陷', Epic: '史诗', Milestone: '里程碑' };

// Always the global API: the box is on every page, a project's pages included, and the
// search is across projects wherever it is typed.
const { request } = createShell({
  root: () => document.body,
  apiBase: () => '/requirements/api',
  project: () => '',
  csrfToken: () => ''
});

// --- pure pieces -----------------------------------------------------------------

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A text cut into the runs a reader should see marked — every place one of the words
 * occurs, whatever its case — and the runs between them, in order.
 */
export function highlightParts(text, words) {
  const source = String(text ?? '');
  const usable = (words ?? []).filter(Boolean);
  if (!source) return [];
  if (!usable.length) return [{ text: source, hit: false }];
  // Longest first, so a word inside a longer one does not take its place.
  const pattern = new RegExp(usable.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|'), 'giu');
  const parts = [];
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: source.slice(last, match.index), hit: false });
    parts.push({ text: match[0], hit: true });
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push({ text: source.slice(last), hit: false });
  return parts;
}

/** Where a result opens: its own page in its project, with it open. */
export function hitHref(hit) {
  if (!hit.project) return `/work_packages/${hit.workPackageId}`;
  const page = hit.kind === 'handoff' ? 'handoff' : 'requirements';
  const reference = hit.id || String(hit.workPackageId);
  return `/projects/${encodeURIComponent(hit.project)}/${page}?open=${encodeURIComponent(reference)}`;
}

export function resultsHref(query) {
  return `${RESULTS_PATH}?q=${encodeURIComponent(query.trim())}`;
}

/** The option a keyboard step lands on, going round at either end; -1 is none. */
export function stepActive(current, count, step) {
  if (count <= 0) return -1;
  if (current < 0) return step > 0 ? 0 : count - 1;
  return (current + step + count) % count;
}

/**
 * A snippet started a few characters before its first marked word, for a line too short to
 * show all of it: cut from the front, a match further in was never seen.
 */
export function focusSnippet(snippet, words, lead = 8) {
  const text = String(snippet ?? '');
  let at = 0;
  for (const part of highlightParts(text, words)) {
    if (part.hit) break;
    at += part.text.length;
  }
  if (at >= text.length || at <= lead + 1) return text;
  let start = at - lead;
  // Not in the middle of a Latin word: "…ject" reads as a typo for the word it cut.
  while (start < at && /[\w-]/.test(text.charAt(start - 1)) && /[\w-]/.test(text.charAt(start))) start += 1;
  return `…${text.slice(start).trimStart()}`;
}

/** Which of the matched fields to tell a reader about, beside the highlighted title. */
export function matchNote(hit) {
  const matched = hit.matched ?? [];
  if (matched.includes('body')) return hit.snippet ? { snippet: hit.snippet } : null;
  if (matched.includes('comment')) return { where: '命中评论' };
  return null;
}

const total = answer => GROUPS.reduce((sum, group) => sum + (answer?.groups?.[group.name]?.total ?? 0), 0);

// --- DOM pieces ------------------------------------------------------------------

function marked(text, words) {
  return highlightParts(text, words).map(part => {
    if (!part.hit) return document.createTextNode(part.text);
    return el('mark', 'mp-search-mark', part.text);
  });
}

function searchIcon() {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('width', '16');
  node.setAttribute('height', '16');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('class', 'mp-search-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z');
  node.append(path);
  return node;
}

function stateChip(state) {
  return el('span', `mp-search-chip mp-tone-${STATE_TONES[state] ?? 'muted'}`, state);
}

/**
 * The line under a title: its numbers, state and project. The short line in the top bar
 * names the business id only when the words were found in it, which leaves the room to
 * the text around the match.
 */
function metaNodes(hit, words, { full }) {
  const nodes = [];
  if (hit.state) nodes.push(stateChip(hit.state));
  const number = el('span', 'mp-search-num');
  number.append(...marked(`#${hit.workPackageId}`, words));
  nodes.push(number);
  if (hit.id && (full || (hit.matched ?? []).includes('id'))) {
    const id = el('span', 'mp-search-bid');
    id.append(...marked(hit.id, words));
    nodes.push(id);
  }
  if (full) {
    if (hit.kind !== 'handoff' && hit.typeName) nodes.push(el('span', '', TYPE_LABELS[hit.typeName] ?? hit.typeName));
    if (hit.projectName) nodes.push(el('span', '', hit.projectName));
    if (hit.updatedAt) {
      const when = el('time', '', `更新于 ${localTime(hit.updatedAt)}`);
      when.dateTime = hit.updatedAt;
      nodes.push(when);
    }
  }
  return nodes;
}

function noteNode(hit, words, className, { focus = false } = {}) {
  const note = matchNote(hit);
  if (!note) return null;
  if (note.where) return el('span', `${className} mp-search-where`, note.where);
  const node = el('span', className);
  node.append(...marked(focus ? focusSnippet(note.snippet, words) : note.snippet, words));
  return node;
}

// --- the box in the top bar ----------------------------------------------------------

// The box of the page on show. Turbo swaps the header out on every visit, so each visit
// builds its own; the document-wide keys and clicks look it up here.
let bar = null;

function buildBar() {
  const wrap = el('div', 'mp-search op-app-menu--item');
  wrap.setAttribute('role', 'search');

  const form = el('form', 'mp-search-form');
  form.action = RESULTS_PATH;
  form.method = 'get';
  const input = el('input', 'mp-search-input');
  input.type = 'search';
  input.name = 'q';
  input.maxLength = MAX_LENGTH;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = '搜索需求与交接';
  input.setAttribute('aria-label', '搜索需求与上下文交接');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const key = el('kbd', 'mp-search-key', '/');
  key.setAttribute('aria-hidden', 'true');
  key.title = '按 / 开始搜索';
  form.append(searchIcon(), input, key);

  const panel = el('div', 'mp-search-panel');
  panel.id = 'mp-search-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-label', '搜索结果');
  input.setAttribute('aria-controls', panel.id);
  wrap.append(form, panel);

  const box = {
    wrap, form, input, panel,
    query: '', answer: null, error: null, loading: false, composing: false,
    active: -1, options: [], sequence: 0, timer: null, controller: null
  };

  // While an input method still holds the text — pinyin before its candidate is chosen, or
  // a word typed in pinyin mode before it is committed — Safari gives the next click to the
  // input method, to commit the text, rather than to the page. A result shown then took two
  // clicks to open (Brian 2026-09-24), so the panel waits until the text is committed.
  input.addEventListener('compositionstart', () => {
    box.composing = true;
    clearTimeout(box.timer);
    closePanel(box);
  });
  input.addEventListener('compositionend', () => {
    box.composing = false;
    typed(box);
  });
  input.addEventListener('input', event => {
    if (event.isComposing || box.composing) return;
    typed(box);
  });
  input.addEventListener('focus', () => {
    if (!box.composing && box.query.trim() && (box.answer || box.error)) renderPanel(box);
  });
  input.addEventListener('keydown', event => {
    // Keys pressed while composing belong to the input method: the arrows pick a candidate.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (panel.hidden) {
        if (box.answer) renderPanel(box);
        return;
      }
      event.preventDefault();
      setActive(box, stepActive(box.active, box.options.length, event.key === 'ArrowDown' ? 1 : -1), { reveal: true });
    } else if (event.key === 'Escape') {
      if (!panel.hidden) {
        event.preventDefault();
        closePanel(box);
      } else {
        input.blur();
      }
    } else if (event.key === 'Tab') {
      closePanel(box);
    }
  });
  form.addEventListener('submit', event => {
    const option = box.options[box.active];
    if (option) {
      event.preventDefault();
      closePanel(box);
      visit(option.href);
      return;
    }
    if (!input.value.trim()) {
      event.preventDefault();
      return;
    }
    closePanel(box);
  });
  return box;
}

/** What was typed changed: ask again once typing pauses, or close on an empty box. */
function typed(box) {
  box.query = box.input.value;
  clearTimeout(box.timer);
  if (!box.query.trim()) {
    box.controller?.abort();
    box.sequence += 1;
    box.answer = null;
    box.error = null;
    box.loading = false;
    closePanel(box);
    return;
  }
  box.timer = setTimeout(() => { void preview(box); }, TYPING_PAUSE_MS);
}

function visit(href) {
  if (window.Turbo?.visit) window.Turbo.visit(href);
  else window.location.assign(href);
}

async function preview(box) {
  const query = box.query.trim();
  box.controller?.abort();
  const controller = new AbortController();
  box.controller = controller;
  const sequence = ++box.sequence;
  box.loading = true;
  renderPanel(box);
  try {
    const answer = await request('/search', {
      params: [['q', query], ['page_size', String(PREVIEW_SIZE)]],
      signal: controller.signal,
      failure: '搜索失败'
    });
    if (sequence !== box.sequence) return;
    box.answer = answer;
    box.error = null;
  } catch (error) {
    if (sequence !== box.sequence || error.name === 'AbortError') return;
    box.error = error.message;
  }
  box.loading = false;
  // Rendered only while the reader is still in the box: an answer arriving after they
  // clicked away should not pop open over the page.
  if (document.activeElement === box.input && !box.composing) renderPanel(box);
}

function renderPanel(box) {
  const { panel, input } = box;
  panel.replaceChildren();
  box.options = [];
  box.active = -1;
  input.removeAttribute('aria-activedescendant');
  if (!box.query.trim()) {
    closePanel(box);
    return;
  }
  panel.classList.toggle('mp-is-loading', box.loading && Boolean(box.answer));

  if (box.error && !box.loading) {
    panel.append(el('p', 'mp-search-note mp-is-error', box.error));
  } else if (!box.answer) {
    panel.append(loadingNode('搜索中…'));
  } else {
    const answer = box.answer;
    const count = total(answer);
    if (count === 0) {
      panel.append(el('p', 'mp-search-note', `没有找到与「${answer.query}」相关的需求或上下文交接。`));
    } else {
      for (const group of GROUPS) {
        const found = answer.groups?.[group.name];
        if (!found) continue;
        const head = el('div', 'mp-search-group-head');
        head.setAttribute('role', 'presentation');
        head.append(el('span', '', group.label), el('span', 'mp-search-count', String(found.total)));
        panel.append(head);
        for (const hit of found.items) panel.append(optionNode(box, hit, answer.words));
      }
      const all = el('a', 'mp-search-all');
      all.href = resultsHref(answer.query);
      all.append(el('span', '', `查看全部 ${count} 条结果`), el('kbd', 'mp-search-enter', '↵'));
      addOption(box, all, all.href);
      panel.append(all);
    }
  }
  panel.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function optionNode(box, hit, words) {
  const link = el('a', 'mp-search-hit');
  link.href = hitHref(hit);
  const head = el('span', 'mp-search-hit-head');
  const title = el('span', 'mp-search-hit-title');
  title.append(...marked(hit.title, words));
  head.append(title);
  if (hit.projectName) head.append(el('span', 'mp-search-hit-project', hit.projectName));
  const meta = el('span', 'mp-search-hit-meta');
  meta.append(...metaNodes(hit, words, { full: false }));
  const note = noteNode(hit, words, 'mp-search-hit-note', { focus: true });
  if (note) meta.append(note);
  link.append(head, meta);
  addOption(box, link, link.href);
  return link;
}

function addOption(box, node, href) {
  node.id = `mp-search-option-${box.options.length}`;
  node.setAttribute('role', 'option');
  node.setAttribute('aria-selected', 'false');
  node.addEventListener('mouseenter', () => setActive(box, box.options.findIndex(option => option.node === node)));
  // Chosen with the mouse: the box keeps focus until the visit lands.
  node.addEventListener('mousedown', event => event.preventDefault());
  node.addEventListener('click', () => closePanel(box));
  box.options.push({ node, href });
}

/** Marks the chosen row. Only the arrow keys bring it into view: a row under the mouse is
 *  in view already, and scrolling the list under a pointer moves the row it is on. */
function setActive(box, index, { reveal = false } = {}) {
  box.options[box.active]?.node.classList.remove('mp-is-active');
  box.options[box.active]?.node.setAttribute('aria-selected', 'false');
  box.active = index;
  const option = box.options[index];
  if (!option) {
    box.input.removeAttribute('aria-activedescendant');
    return;
  }
  option.node.classList.add('mp-is-active');
  option.node.setAttribute('aria-selected', 'true');
  box.input.setAttribute('aria-activedescendant', option.node.id);
  if (reveal) option.node.scrollIntoView({ block: 'nearest' });
}

function closePanel(box) {
  box.panel.hidden = true;
  box.input.setAttribute('aria-expanded', 'false');
  box.input.removeAttribute('aria-activedescendant');
  box.options[box.active]?.node.classList.remove('mp-is-active');
  box.active = -1;
}

function mountBar() {
  const end = document.querySelector('.op-app-header--end');
  if (!end) return;
  const existing = end.querySelector(':scope > .mp-search');
  if (existing && existing === bar?.wrap) return;
  // A page Turbo restored from its cache carries a copy of the box with nothing behind it.
  existing?.remove();

  bar = buildBar();
  // Left of the appearance control, which sits left of the avatar; before the avatar if
  // that control is not there yet, which it then joins on the box's right.
  const anchor = end.querySelector(':scope > .mp-appearance') ??
    end.querySelector(':scope > button.op-app-header--primer-button');
  if (anchor) end.insertBefore(bar.wrap, anchor); else end.append(bar.wrap);

  // On the results page the box holds what was searched, so it can be changed in place.
  if (window.location.pathname === RESULTS_PATH) {
    const query = new URL(window.location.href).searchParams.get('q') ?? '';
    bar.input.value = query;
    bar.query = query;
  }
}

function typingIn(target) {
  return target instanceof Element &&
    (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null);
}

// --- the results page ------------------------------------------------------------

let page = null;

function renderResults() {
  const { root, query } = page;
  root.replaceChildren();
  const head = el('header', 'mp-search-page-head');
  head.append(el('h1', 'mp-search-page-title', '搜索'));
  root.append(head);

  if (!query) {
    head.append(el('p', 'mp-search-page-summary', '在顶栏的搜索框里输入要找的词：标题、编号、正文和评论都会搜到。'));
    return;
  }
  if (page.error) {
    head.append(el('p', 'mp-search-page-summary', `「${query}」`));
    root.append(el('p', 'mp-search-note mp-is-error', page.error));
    return;
  }
  if (!page.answer) {
    head.append(el('p', 'mp-search-page-summary', `「${query}」`));
    root.append(loadingNode('搜索中…'));
    return;
  }
  head.append(el('p', 'mp-search-page-summary',
    `「${page.answer.query}」共 ${total(page.answer)} 条结果，分需求和上下文交接两组；标题、编号、正文和评论都在搜索范围内。`));
  for (const group of GROUPS) root.append(groupSection(group));
}

function groupSection(group) {
  const found = page.answer.groups?.[group.name] ?? { total: 0, page: 1, pageSize: PAGE_SIZE, items: [] };
  const words = page.answer.words;
  const section = el('section', 'mp-search-group' + (page.loading === group.name ? ' mp-is-loading' : ''));
  section.dataset.group = group.name;
  const head = el('div', 'mp-search-page-group-head');
  head.append(el('h2', '', group.label), el('span', 'mp-search-count', String(found.total)));
  if (page.loading === group.name) head.append(loadingNode('载入中…'));
  section.append(head);

  if (!found.items.length) {
    section.append(el('p', 'mp-search-empty', group.none));
    return section;
  }
  const list = el('ol', 'mp-search-list');
  for (const hit of found.items) {
    const item = el('li');
    const link = el('a', 'mp-search-row');
    link.href = hitHref(hit);
    const title = el('span', 'mp-search-row-title');
    title.append(...marked(hit.title, words));
    const meta = el('span', 'mp-search-row-meta');
    meta.append(...metaNodes(hit, words, { full: true }));
    link.append(title, meta);
    const note = noteNode(hit, words, 'mp-search-row-note');
    if (note) link.append(note);
    item.append(link);
    list.append(item);
  }
  section.append(list);

  const pages = Math.ceil(found.total / found.pageSize);
  if (pages > 1) section.append(pager(group, found.page, pages));
  return section;
}

function pager(group, current, pages) {
  const nav = el('nav', 'mp-search-pager');
  nav.setAttribute('aria-label', `${group.label}翻页`);
  const button = (label, target) => {
    const node = el('button', 'mp-search-page-button', label);
    node.type = 'button';
    node.disabled = target < 1 || target > pages || page.loading !== null;
    node.addEventListener('click', () => { void turnPage(group, target); });
    return node;
  };
  nav.append(button('上一页', current - 1), el('span', '', `第 ${current} / ${pages} 页`), button('下一页', current + 1));
  return nav;
}

async function turnPage(group, target) {
  page.loading = group.name;
  renderResults();
  try {
    const answer = await request('/search', {
      params: [['q', page.query], ['group', group.name], ['page', String(target)], ['page_size', String(PAGE_SIZE)]],
      failure: '搜索失败'
    });
    const found = answer.groups?.[group.name];
    if (found) page.answer.groups[group.name] = found;
    page.loading = null;
    renderResults();
    const top = page.root.querySelector(`[data-group="${group.name}"]`);
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start' });
  } catch (error) {
    page.loading = null;
    renderResults();
    const section = page.root.querySelector(`[data-group="${group.name}"]`);
    section?.append(el('p', 'mp-search-note mp-is-error', error.message));
  }
}

async function mountResults() {
  const container = document.getElementById('mp-search');
  if (!container || container.dataset.mounted === '1') return;
  container.dataset.mounted = '1';
  const query = (new URL(window.location.href).searchParams.get('q') ?? '').trim().slice(0, MAX_LENGTH);
  page = { root: container, query, answer: null, error: null, loading: null };
  document.title = query ? `搜索：${query} | Eva Project` : '搜索 | Eva Project';
  renderResults();
  if (!query) return;
  try {
    page.answer = await request('/search', {
      params: [['q', query], ['page_size', String(PAGE_SIZE)]],
      failure: '搜索失败'
    });
  } catch (error) {
    page.error = error.message;
  }
  renderResults();
}

// --- boot ------------------------------------------------------------------------

if (typeof document !== 'undefined') {
  const mount = () => {
    mountBar();
    void mountResults();
  };
  for (const event of ['turbo:load', 'turbo:render', 'DOMContentLoaded']) {
    document.addEventListener(event, mount);
  }
  document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || typingIn(event.target)) return;
    if (!bar?.input.isConnected) return;
    event.preventDefault();
    bar.input.focus();
    bar.input.select();
  });
  document.addEventListener('click', event => {
    if (bar && !bar.wrap.contains(event.target)) closePanel(bar);
  });
  mount();
}
