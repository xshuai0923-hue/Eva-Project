import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { arrange, listParams, localTime, activeFilterCount, completionEvidence, proposedTime, referenceHref } from './assets/requirements.js';

// The page had no tests at all: hierarchy, the header filters and the default hiding of
// finished work were only ever checked by clicking. These cover the parts with rules in
// them, so the shell extraction and the retirement of the old filter script have
// something to fail against.

const row = (workPackageId, parentWorkPackageId = null) =>
  ({ workPackageId, parentWorkPackageId, id: `REQ-${workPackageId}` });

const shape = (rows) => rows.map(({ item, depth, children, collapsed, buried }) =>
  [item.workPackageId, depth, children, collapsed, buried]);

// --- hierarchy ------------------------------------------------------------------

test('a child follows its parent, one level in, and deeper levels keep nesting', () => {
  // The fixture chain on the test instance: 57 → 58 → 65 → 66.
  const rows = arrange([row(57), row(58, 57), row(65, 58), row(66, 65)], new Set());
  assert.deepEqual(shape(rows), [
    [57, 0, 1, false, 0],
    [58, 1, 1, false, 0],
    [65, 2, 1, false, 0],
    [66, 3, 0, false, 0]
  ]);
});

test('the server order is kept; arranging only nests, it never re-sorts', () => {
  const rows = arrange([row(40), row(42), row(53)], new Set());
  assert.deepEqual(rows.map(entry => entry.item.workPackageId), [40, 42, 53]);
});

test('a parent outside the result leaves its child at the top level', () => {
  // Filtered out. Nothing is fetched just to draw a line, so the row stands on its own
  // rather than pretending to a nesting that was not loaded.
  const rows = arrange([row(66, 65)], new Set());
  assert.deepEqual(shape(rows), [[66, 0, 0, false, 0]]);
});

test('a child whose family began on an earlier page keeps its depth and names its parent', () => {
  // #258: a page is cut from the whole tree, so its first rows can carry on a family
  // whose parent is a page back.
  const rows = arrange([{ ...row(7, 4), depth: 2 }, { ...row(6, 1), depth: 1 }, { ...row(2), depth: 0 },
    { ...row(8, 2), depth: 1 }], new Set());
  assert.deepEqual(shape(rows), [
    [7, 2, 0, false, 0],
    [6, 1, 0, false, 0],
    [2, 0, 1, false, 0],
    [8, 1, 0, false, 0]
  ]);
  assert.deepEqual(rows.map(entry => entry.detached), [true, true, false, false]);
});

test('collapsing counts the whole subtree, not just the direct children', () => {
  // The number on a collapsed row is the promise that nothing vanished silently, so
  // counting one level would be worse than not showing it.
  const rows = arrange([row(57), row(58, 57), row(65, 58), row(66, 65)], new Set([57]));
  assert.deepEqual(shape(rows), [[57, 0, 1, true, 3]]);
});

test('collapsing one branch leaves its siblings alone', () => {
  const items = [row(1), row(2, 1), row(3, 2), row(4, 1)];
  assert.deepEqual(shape(arrange(items, new Set([2]))), [
    [1, 0, 2, false, 0],
    [2, 1, 1, true, 1],
    [4, 1, 0, false, 0]
  ]);
});

test('a row collapsed in a result that no longer contains it changes nothing', () => {
  // The collapsed set outlives a filter change, so it routinely names absent rows.
  assert.deepEqual(shape(arrange([row(40)], new Set([999]))), [[40, 0, 0, false, 0]]);
});

test('a handoff among the relations opens on its handoff page, a requirement here (#262)', () => {
  // The pool's own API refuses a handoff, which is what clicking one used to hit.
  assert.equal(
    referenceHref({ id: 'EVAPROJECT-HO-20260924-003', workPackageId: 248, project: 'eva-project', typeName: '交接' }),
    '/projects/eva-project/handoff?open=EVAPROJECT-HO-20260924-003');
  assert.equal(
    referenceHref({ id: 'EVAPROJECT-REQ-20260925-001', workPackageId: 256, project: 'eva-project', typeName: 'Feature' }),
    null);
});

// --- the query the header filters build -------------------------------------------

const TYPES = [{ id: 1, name: 'Task' }, { id: 7, name: 'Bug' }];
const params = (view) => listParams({ page: 1, select: {}, types: TYPES, ...view });
const values = (view, name) => params(view).filter(([key]) => key === name).map(([, value]) => value);

test('every list read is paged and ordered by ID', () => {
  assert.deepEqual(params({}).slice(0, 3), [
    ['page_size', '50'], ['cursor', '1'], ['sort_by', 'id:asc']
  ]);
});

test('several values in one column repeat the name, which is how it says OR', () => {
  assert.deepEqual(values({ select: { responsibleAgent: ['Claude', 'Codex'] } }, 'select.responsibleAgent'),
    ['Claude', 'Codex']);
});

test('different columns each carry their own name, and the server ANDs them', () => {
  const sent = params({ select: { responsibleAgent: ['Claude'], visibility: ['公开'] } });
  assert.deepEqual(values({ select: { responsibleAgent: ['Claude'], visibility: ['公开'] } }, 'select.responsibleAgent'), ['Claude']);
  assert.deepEqual(values({ select: { responsibleAgent: ['Claude'], visibility: ['公开'] } }, 'select.visibility'), ['公开']);
  assert.equal(sent.filter(([key]) => key.startsWith('select.')).length, 2);
});

test('the type column is picked by its Chinese label but filtered by id', () => {
  assert.deepEqual(values({ select: { type: ['任务', '缺陷'] } }, 'select.type'), ['1', '7']);
});

test('a type the project does not have is dropped rather than sent as a name', () => {
  // Sending the label would filter on a value the server cannot resolve, and the list
  // would come back empty as though nothing matched.
  assert.deepEqual(values({ select: { type: ['里程碑'] } }, 'select.type'), []);
});

test('finished work stays out until the 需求状态 column says otherwise', () => {
  assert.deepEqual(values({}, 'exclude_state'), ['已完成']);
  assert.deepEqual(values({ select: { state: ['进行中'] } }, 'exclude_state'), []);
  // Any selection at all lifts it, including 已完成 itself.
  assert.deepEqual(values({ select: { state: ['已完成'] } }, 'exclude_state'), []);
  // An empty selection is not a selection.
  assert.deepEqual(values({ select: { state: [] } }, 'exclude_state'), ['已完成']);
});

test('the unclaimed toggle is only sent when it is on', () => {
  assert.deepEqual(values({ unclaimedOnly: true }, 'unclaimed'), ['1']);
  assert.deepEqual(values({ unclaimedOnly: false }, 'unclaimed'), []);
});

test('paging keeps the filters that were already chosen', () => {
  const sent = params({ page: 3, select: { visibility: ['私有'] } });
  assert.deepEqual(sent.find(([key]) => key === 'cursor'), ['cursor', '3']);
  assert.deepEqual(values({ page: 3, select: { visibility: ['私有'] } }, 'select.visibility'), ['私有']);
});

// --- the stylesheet invariant the popup depends on --------------------------------

test('the filter popup is positioned against the viewport, not inside the table', () => {
  // A stylesheet assertion on purpose: this one is invisible to every behaviour test
  // here, because they reach the options through the DOM and a programmatic click works
  // perfectly well on an element clipped to nothing. Only a person with a mouse sees it.
  //
  // It has now been clipped twice. First by overflow:hidden on the th, which arrived with
  // column resizing. Then, once that was lifted, by .mp-main — it scrolls horizontally,
  // and a box that scrolls on one axis clips the other, so the popup was cut off whenever
  // the list was shorter than the popup. position:fixed escapes every overflow ancestor,
  // which is why the popup's coordinates are computed in JS instead of by CSS.
  const css = readFileSync(new URL('./assets/requirements.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('./assets/requirements.js', import.meta.url), 'utf8');

  const menuRule = /\.mp-requirements \.mp-filter-menu\s*\{([^}]*)\}/.exec(css);
  assert.ok(menuRule, 'expected a rule for the filter popup');
  assert.match(menuRule[1], /position\s*:\s*fixed/,
    'the popup must be fixed; absolute puts it back inside a clipping ancestor');

  // Fixed only works if something actually places it.
  assert.match(js, /menu\.style\.top\s*=/, 'the popup needs its top set from the anchor');
  assert.match(js, /menu\.style\.left\s*=/, 'the popup needs its left set from the anchor');

  // The th still has to anchor the resize handle.
  const thRules = [...css.matchAll(/\.mp-requirements \.mp-table th\s*\{([^}]*)\}/g)].map(m => m[1]);
  assert.ok(thRules.some(body => /position\s*:\s*relative/.test(body)),
    'the th must stay position:relative for the resize handle');

  // And a narrowed column still must not spill its label.
  assert.match(css, /\.mp-requirements \.mp-th[^{]*\{[^}]*overflow\s*:\s*hidden/,
    'the header content should clip, so narrowing a column does not spill the label');
});

// The subject is different on every row, so the header has nothing to tick: the useful
// question is which rows contain what you are looking for. OpenProject does the matching,
// which is what keeps paging and the total honest.
test('a subject search is sent to the server, trimmed', () => {
  assert.deepEqual(
    listParams({ page: 1, select: {}, subject: '  登录页  ', types: [] }).filter(([key]) => key === 'subject'),
    [['subject', '登录页']]
  );
});

test('a blank subject is not sent at all, so it does not narrow anything', () => {
  for (const subject of ['', '   ', undefined]) {
    assert.deepEqual(
      listParams({ page: 1, select: {}, subject, types: [] }).filter(([key]) => key === 'subject'),
      []
    );
  }
});

test('a subject search combines with the column filters rather than replacing them', () => {
  const params = listParams({ page: 1, select: { visibility: ['公开'] }, subject: '登录', types: [] });

  assert.deepEqual(params.filter(([key]) => key === 'subject'), [['subject', '登录']]);
  assert.deepEqual(params.filter(([key]) => key === 'select.visibility'), [['select.visibility', '公开']]);
});

// OpenProject answers in UTC. The history timeline used to slice the ISO string, which
// printed those UTC digits as if they were local — eight hours early in Singapore, and
// wrong by a different amount everywhere else, with nothing on screen to say so.
test('a history timestamp is converted to the reader timezone, not sliced', () => {
  const shown = localTime('2026-09-22T15:07:59Z');

  assert.notEqual(shown, '2026-09-22 15:07');
  const expected = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date('2026-09-22T15:07:59Z'));
  assert.equal(shown, expected);
});

test('a missing or unparseable timestamp prints nothing rather than Invalid Date', () => {
  assert.equal(localTime(null), '');
  assert.equal(localTime(''), '');
  assert.equal(localTime('not a time'), '');
});

// A filter that matched nothing used to take the table away with it — and the filters
// live in that table's header, so the only way back was reloading the page. The count is
// what decides whether a way out is offered at all.
test('the filter count sees every kind of narrowing, not just the ticked ones', () => {
  assert.equal(activeFilterCount({ select: {} }), 0);
  assert.equal(activeFilterCount({ select: { visibility: ['公开'] } }), 1);
  assert.equal(activeFilterCount({ select: { state: ['进行中', '待确认'] } }), 2);
  assert.equal(activeFilterCount({ select: {}, unclaimedOnly: true }), 1);
  assert.equal(activeFilterCount({ select: {}, subject: '登录' }), 1);
  assert.equal(activeFilterCount({ select: {}, ids: '57' }), 1);
  assert.equal(activeFilterCount({ select: { visibility: ['公开'] }, subject: '登录', ids: '57' }), 3);
});

test('blank narrowing is not counted, so no way out is offered when nothing is on', () => {
  assert.equal(activeFilterCount({ select: {}, subject: '   ', ids: '  ' }), 0);
});

// An id is looked up, not searched: `~` on a number would match 157 for someone after 57.
test('an id filter sends only digits, comma separated', () => {
  const ids = view => listParams({ page: 1, select: {}, types: [], ...view }).filter(([k]) => k === 'ids');

  assert.deepEqual(ids({ ids: '40,42' }), [['ids', '40,42']]);
  assert.deepEqual(ids({ ids: ' 57 ' }), [['ids', '57']]);
  assert.deepEqual(ids({ ids: '40 42' }), [['ids', '40,42']]);
});

test('typing something that is not an id sends nothing rather than an impossible query', () => {
  for (const value of ['abc', '#57', '', '   ']) {
    assert.deepEqual(
      listParams({ page: 1, select: {}, types: [], ids: value }).filter(([k]) => k === 'ids'), []);
  }
});

test('a requirement id is searched as typed, trimmed, and counts as a filter', () => {
  assert.deepEqual(
    listParams({ page: 1, select: {}, requirementId: '  20260922-003 ', types: [] })
      .filter(([key]) => key === 'requirement_id'),
    [['requirement_id', '20260922-003']]
  );
  assert.equal(activeFilterCount({ select: {}, requirementId: 'REQ' }), 1);
  assert.equal(activeFilterCount({ select: {}, requirementId: '   ' }), 0);
});

test('completion evidence from the form is a commit, or files outside a repository', () => {
  const typed = {
    repository: 'Eva-Project', sha: ' ' + 'a'.repeat(40) + ' ', paths: 'a.js， b.js,',
    locations: '~/.codex/skills/update-context/SKILL.md, ~/.claude/CLAUDE.md', change: '适配交接 Skill',
    verification: '新会话实测', acceptanceStatus: '已验收', acceptanceSource: 'Brian 原话'
  };
  assert.deepEqual(completionEvidence('git', typed), {
    repository: 'Eva-Project', sha: 'a'.repeat(40), paths: ['a.js', 'b.js'],
    verification: '新会话实测', acceptanceStatus: '已验收', acceptanceSource: 'Brian 原话'
  });
  assert.deepEqual(completionEvidence('file', typed), {
    kind: 'file', locations: ['~/.codex/skills/update-context/SKILL.md', '~/.claude/CLAUDE.md'], change: '适配交接 Skill',
    verification: '新会话实测', acceptanceStatus: '已验收', acceptanceSource: 'Brian 原话'
  });
});

test('when a requirement was proposed is shown as precisely as it is known', () => {
  assert.equal(proposedTime('2026-09-22T03:20:00+08:00', 'timestamp'), localTime('2026-09-22T03:20:00+08:00'));
  // A day stays that day: it is not a moment, so no timezone moves it.
  assert.equal(proposedTime('2026-09-22', 'date'), '2026年9月22日');
  assert.equal(proposedTime('2026-09-22T00:00:00Z', 'date'), '2026年9月22日');
  assert.equal(proposedTime(null, 'unknown'), '未知');
  assert.equal(proposedTime('2026-09-22', 'unknown'), '未知');
  assert.equal(proposedTime(null, 'timestamp'), null);
});
