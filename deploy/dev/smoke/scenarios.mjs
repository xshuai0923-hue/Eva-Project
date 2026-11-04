// What a person does in the pages, as steps both runners play: chrome.mjs through Chrome's
// DevTools protocol and webkit.swift through WKWebView, the engine Safari runs. Written once
// so the two engines are asked exactly the same thing.
//
// Ops: navigate {path} · waitFor {js, timeoutMs} · click {selector} · type {text} ·
// compose {text} (text an input method still holds) · commit {text} (the input method
// commits it) · key {key: Enter | ArrowDown} · remember {name, js} · expect {js, label} ·
// skipUnless {js, reason} · sleep {ms} · viewport {width, height} (a phone's screen; each
// scenario starts on a wide one).
// {{name}} in a path or typed text is the remembered value as is, and in js a JSON literal of it.
//
// Run as a script it prints the scenarios as JSON, which is how webkit.swift reads them:
//   node scenarios.mjs <query>

const panelReady = `(() => { const p = document.querySelector('.mp-search-panel');
  return !!p && !p.hidden && !!p.querySelector('.mp-search-hit') && !p.classList.contains('mp-is-loading'); })()`;
const panelClosed = `(() => { const p = document.querySelector('.mp-search-panel'); return !p || p.hidden; })()`;
const firstHref = kind => `(() => [...document.querySelectorAll('.mp-search-hit')]
  .map(a => a.getAttribute('href')).find(h => h && h.includes('${kind === 'handoff' ? '/handoff?open=' : '/requirements?open='}')) ?? '')()`;
// The page drops ?open= once the record is shown, so a detail on screen with the address
// clean is the record having opened.
const requirementShown = href => `(() => { const d = document.querySelector('.mp-detail-id');
  return !!d && !location.search.includes('open=') &&
    d.textContent === new URL(${href}, location.origin).searchParams.get('open'); })()`;
const handoffShown = href => `(() => { const d = document.querySelector('.mp-detail .mp-detail-id');
  return !!document.querySelector('.mp-card.mp-is-active') && !!d && !location.search.includes('open=') &&
    d.textContent.startsWith(new URL(${href}, location.origin).searchParams.get('open')); })()`;

const restoreButton = "document.querySelector('dialog.mp-backup-dialog[open] button[type=submit]')";

const openHome = [
  { op: 'navigate', path: '/' },
  { op: 'waitFor', js: "!!document.querySelector('.mp-search-input')" },
  { op: 'sleep', ms: 800 },
  { op: 'click', selector: '.mp-search-input' }
];

// A phone (EVAPROJECT-REQ-20260928-002): the detail is a sheet over the whole screen, top bar
// included, and 返回列表 goes back to the list as it was left — the same page, not drawn
// again (a mark put on it survives), and scrolled where it was.
const phone = { op: 'viewport', width: 390, height: 844 };
const covers = sheet => `!!document.elementFromPoint(60, 10)?.closest(${JSON.stringify(sheet)})`;
const markPage = { op: 'expect', label: '（给页面做个记号）', js: "(document.querySelector('#content-body').dataset.smoke = 'kept') === 'kept'" };
const samePage = "document.querySelector('#content-body')?.dataset.smoke === 'kept'";
const findLinks = query => [
  ...openHome,
  { op: 'type', text: query },
  { op: 'waitFor', js: panelReady },
  { op: 'remember', name: 'requirement', js: firstHref('requirement') },
  { op: 'remember', name: 'handoff', js: firstHref('handoff') }
];

export function scenarios(query) {
  return [
    {
      name: '顶栏：输入后鼠标第一次点击结果就打开',
      steps: [
        ...openHome,
        { op: 'type', text: query },
        { op: 'waitFor', js: panelReady },
        { op: 'remember', name: 'first', js: "document.querySelector('.mp-search-hit').getAttribute('href')" },
        { op: 'click', selector: '.mp-search-hit' },
        { op: 'waitFor', js: "location.pathname !== '/'" },
        { op: 'expect', label: '到了第一条结果的页面', js: "location.pathname === new URL({{first}}, location.origin).pathname" },
        { op: 'waitFor', js: `(${requirementShown('{{first}}')}) || (${handoffShown('{{first}}')})` },
        { op: 'expect', label: '打开的正是这一条', js: `(${requirementShown('{{first}}')}) || (${handoffShown('{{first}}')})` }
      ]
    },
    {
      name: '顶栏：输入法选字期间不出结果，确认后第一次点击就打开',
      steps: [
        ...openHome,
        { op: 'compose', text: query },
        { op: 'sleep', ms: 1200 },
        { op: 'expect', label: '选字期间下拉框不出现', js: panelClosed },
        { op: 'commit', text: query },
        { op: 'waitFor', js: panelReady },
        { op: 'remember', name: 'first', js: "document.querySelector('.mp-search-hit').getAttribute('href')" },
        { op: 'click', selector: '.mp-search-hit' },
        { op: 'waitFor', js: "location.pathname !== '/'" },
        { op: 'expect', label: '确认后第一次点击就打开', js: "location.pathname === new URL({{first}}, location.origin).pathname" }
      ]
    },
    {
      name: '顶栏：上下键选中后回车打开',
      steps: [
        ...openHome,
        { op: 'type', text: query },
        { op: 'waitFor', js: panelReady },
        { op: 'remember', name: 'first', js: "document.querySelector('.mp-search-hit').getAttribute('href')" },
        { op: 'key', key: 'ArrowDown' },
        { op: 'expect', label: '第一条被选中', js: "!!document.querySelector('.mp-search-hit.mp-is-active')" },
        { op: 'key', key: 'Enter' },
        { op: 'waitFor', js: "location.pathname !== '/'" },
        { op: 'expect', label: '回车打开选中的那条', js: "location.pathname === new URL({{first}}, location.origin).pathname" }
      ]
    },
    {
      name: '顶栏：没选中时回车进结果页',
      steps: [
        ...openHome,
        { op: 'type', text: query },
        { op: 'waitFor', js: panelReady },
        { op: 'key', key: 'Enter' },
        { op: 'waitFor', js: "location.pathname === '/requirements/search' && !!document.querySelector('.mp-search-row')" },
        { op: 'expect', label: '结果页分两组', js: "document.querySelectorAll('.mp-search-group').length === 2" },
        { op: 'expect', label: '顶栏保留搜索词', js: `document.querySelector('.mp-search-input').value === ${JSON.stringify(query)}` }
      ]
    },
    {
      name: '结果页：一组翻到第 2 页',
      steps: [
        { op: 'navigate', path: `/requirements/search?q=${encodeURIComponent(query)}` },
        { op: 'waitFor', js: "!!document.querySelector('.mp-search-row')" },
        { op: 'skipUnless', reason: '结果不到两页', js: "[...document.querySelectorAll('.mp-search-page-button')].some(b => b.textContent === '下一页' && !b.disabled)" },
        { op: 'click', selector: '.mp-search-pager .mp-search-page-button:last-child' },
        { op: 'waitFor', js: "[...document.querySelectorAll('.mp-search-pager span')].some(s => s.textContent.startsWith('第 2 '))" },
        { op: 'expect', label: '翻到第 2 页', js: "[...document.querySelectorAll('.mp-search-pager span')].some(s => s.textContent.startsWith('第 2 '))" }
      ]
    },
    {
      name: '需求池与交接页：按链接打开指定的一条',
      steps: [
        ...openHome,
        { op: 'type', text: query },
        { op: 'waitFor', js: panelReady },
        { op: 'remember', name: 'requirement', js: firstHref('requirement') },
        { op: 'remember', name: 'handoff', js: firstHref('handoff') },
        { op: 'skipUnless', reason: '结果里没有需求', js: '{{requirement}} !== ""' },
        { op: 'navigate', path: '{{requirement}}' },
        { op: 'waitFor', js: requirementShown('{{requirement}}') },
        { op: 'expect', label: '需求池打开了这条需求', js: requirementShown('{{requirement}}') },
        { op: 'skipUnless', reason: '结果里没有交接', js: '{{handoff}} !== ""' },
        { op: 'navigate', path: '{{handoff}}' },
        { op: 'waitFor', js: handoffShown('{{handoff}}') },
        { op: 'expect', label: '交接页打开了这份交接，卡片高亮', js: handoffShown('{{handoff}}') }
      ]
    },
    {
      // Stops at the confirmation: a restore itself would overwrite the instance.
      name: '备份页：恢复要打出备份名才能点，选字期间也不行，取消后不恢复',
      steps: [
        { op: 'navigate', path: '/backups' },
        { op: 'waitFor', js: "!!document.querySelector('.mp-backup .mp-row')" },
        { op: 'skipUnless', reason: '有任务在进行，恢复按钮不可用', js: "!!document.querySelector('.mp-backup .mp-row .mp-row-actions button:not(.mp-is-danger):not(:disabled)')" },
        { op: 'remember', name: 'backup', js: "document.querySelector('.mp-backup .mp-row .mp-backup-name').textContent" },
        { op: 'click', selector: '.mp-backup .mp-row .mp-row-actions button:not(.mp-is-danger)' },
        { op: 'waitFor', js: "!!document.querySelector('dialog.mp-backup-dialog[open] input')" },
        { op: 'expect', label: '没打名字时不能恢复', js: `${restoreButton}.disabled` },
        { op: 'click', selector: 'dialog.mp-backup-dialog[open] input' },
        { op: 'compose', text: '{{backup}}' },
        { op: 'expect', label: '输入法还在选字时不能恢复', js: `${restoreButton}.disabled` },
        { op: 'commit', text: '{{backup}}' },
        { op: 'expect', label: '名字上屏后可以恢复', js: `!${restoreButton}.disabled` },
        { op: 'click', selector: 'dialog.mp-backup-dialog[open] .mp-dialog-actions button:not([type=submit])' },
        { op: 'sleep', ms: 800 },
        { op: 'expect', label: '取消后弹窗关掉，没有开始恢复', js: "!document.querySelector('dialog.mp-backup-dialog[open]') && !document.querySelector('.mp-backup-job.mp-is-running')" }
      ]
    },
    {
      name: '手机：需求详情盖住整屏，返回列表回到原处',
      steps: [
        phone,
        ...findLinks(query),
        { op: 'skipUnless', reason: '结果里没有需求', js: '{{requirement}} !== ""' },
        { op: 'navigate', path: '{{requirement}}' },
        { op: 'waitFor', js: requirementShown('{{requirement}}') },
        { op: 'expect', label: '详情连顶栏一起盖住', js: covers('.mp-requirements .mp-detail') },
        { op: 'click', selector: '.mp-requirements .mp-sheet-back' },
        { op: 'waitFor', js: "!document.querySelector('.mp-requirements .mp-detail') && !!document.querySelector('.mp-requirements .mp-row')" },
        markPage,
        { op: 'click', selector: '.mp-requirements tbody .mp-row:last-child .mp-col-title' },
        { op: 'waitFor', js: "!!document.querySelector('.mp-requirements .mp-detail .mp-tabs')" },
        { op: 'remember', name: 'top', js: "String(document.querySelector('#content-body').scrollTop)" },
        { op: 'click', selector: '.mp-requirements .mp-sheet-back' },
        { op: 'waitFor', js: "!document.querySelector('.mp-requirements .mp-detail')" },
        { op: 'sleep', ms: 500 },
        { op: 'expect', label: '还是这一页，没有重新载入', js: samePage },
        { op: 'expect', label: '列表停在原处', js: "String(document.querySelector('#content-body').scrollTop) === {{top}}" }
      ]
    },
    {
      name: '手机：交接详情盖住整屏，返回列表',
      steps: [
        phone,
        ...findLinks(query),
        { op: 'skipUnless', reason: '结果里没有交接', js: '{{handoff}} !== ""' },
        { op: 'navigate', path: '{{handoff}}' },
        { op: 'waitFor', js: handoffShown('{{handoff}}') },
        { op: 'expect', label: '详情连顶栏一起盖住', js: covers('.mp-handoff .mp-detail') },
        markPage,
        { op: 'click', selector: '.mp-handoff .mp-sheet-back' },
        { op: 'waitFor', js: "!document.querySelector('.mp-handoff .mp-detail.mp-is-open') && !!document.querySelector('.mp-handoff .mp-card')" },
        { op: 'sleep', ms: 500 },
        { op: 'expect', label: '还是这一页，没有重新载入', js: samePage }
      ]
    },
    {
      name: '手机：主题筛选选字期间不搜，上屏后输入框和光标都还在',
      steps: [
        phone,
        ...findLinks(query),
        { op: 'skipUnless', reason: '结果里没有需求', js: '{{requirement}} !== ""' },
        { op: 'navigate', path: '{{requirement}}' },
        { op: 'waitFor', js: requirementShown('{{requirement}}') },
        { op: 'click', selector: '.mp-requirements .mp-sheet-back' },
        { op: 'waitFor', js: "!!document.querySelector('.mp-requirements .mp-row')" },
        { op: 'click', selector: '.mp-requirements th[data-column="title"] .mp-th' },
        { op: 'waitFor', js: "!!document.querySelector('.mp-filter-search')" },
        { op: 'click', selector: '.mp-filter-search' },
        { op: 'expect', label: '（给输入框做个记号）', js: "(document.querySelector('.mp-filter-search').dataset.smoke = 'kept') === 'kept'" },
        { op: 'remember', name: 'count', js: "document.querySelector('.mp-requirements .mp-count').textContent" },
        { op: 'compose', text: query },
        { op: 'sleep', ms: 1200 },
        { op: 'expect', label: '选字期间不搜', js: "document.querySelector('.mp-requirements .mp-count').textContent === {{count}} && !document.querySelector('.mp-clear-filters')" },
        { op: 'commit', text: query },
        { op: 'waitFor', js: "!!document.querySelector('.mp-clear-filters')" },
        { op: 'expect', label: '上屏后搜了，输入框还是原来那个、光标还在', js: "document.querySelector('.mp-filter-search')?.dataset.smoke === 'kept' && document.activeElement === document.querySelector('.mp-filter-search')" }
      ]
    }
  ];
}

/** What the page looks like when a step fails, for the failure line. */
export const DIAGNOSE = `JSON.stringify({ url: location.pathname + location.search,
  active: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
  typed: document.querySelector('.mp-search-input') ? document.querySelector('.mp-search-input').value : null,
  panel: (p => p ? { hidden: p.hidden, text: p.textContent.slice(0, 60) } : null)(document.querySelector('.mp-search-panel')) })`;

/** {{name}} filled in: as is in a path, as a JSON literal in JavaScript. */
export function fill(text, vars, { literal }) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => (literal ? JSON.stringify(vars[name] ?? '') : String(vars[name] ?? '')));
}

if (import.meta.main) {
  const query = process.argv[2];
  if (!query) {
    console.error('usage: node scenarios.mjs <query>');
    process.exit(2);
  }
  console.log(JSON.stringify({ diagnose: DIAGNOSE, scenarios: scenarios(query) }));
}
