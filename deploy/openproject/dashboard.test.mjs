import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chosenView, countScale, METRICS, periodLabel, periodRange, readView, relativeTime, shiftPeriod, stateRows,
  TREND_LENGTH, trendEdges, writeView
} from './assets/dashboard.js';

// Periods are the reader's own days, weeks and months, so everything here is built and
// read in local time and holds whatever time zone the suite runs in.
const at = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour);
const parts = date => [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];

// A Wednesday, at noon.
const now = at(2026, 9, 23);

test('a day, a week from Monday and a calendar month, each ending where the next begins', () => {
  assert.deepEqual(parts(periodRange('day', now).from), [2026, 9, 23, 0, 0]);
  assert.deepEqual(parts(periodRange('day', now).to), [2026, 9, 24, 0, 0]);
  assert.deepEqual(parts(periodRange('week', now).from), [2026, 9, 21, 0, 0]);
  assert.deepEqual(parts(periodRange('week', now).to), [2026, 9, 28, 0, 0]);
  assert.deepEqual(parts(periodRange('month', now).from), [2026, 9, 1, 0, 0]);
  assert.deepEqual(parts(periodRange('month', now).to), [2026, 10, 1, 0, 0]);
});

test('a Sunday belongs to the week that began the Monday before', () => {
  assert.deepEqual(parts(periodRange('week', at(2026, 9, 27)).from), [2026, 9, 21, 0, 0]);
  assert.deepEqual(parts(periodRange('week', at(2026, 9, 28)).from), [2026, 9, 28, 0, 0]);
});

test('stepping back crosses month and year ends without drifting', () => {
  assert.deepEqual(parts(shiftPeriod('day', at(2026, 1, 1, 0), -1)), [2025, 12, 31, 0, 0]);
  assert.deepEqual(parts(shiftPeriod('week', periodRange('week', at(2026, 1, 1)).from, -1)), [2025, 12, 22, 0, 0]);
  assert.deepEqual(parts(shiftPeriod('month', at(2026, 3, 1, 0), -1)), [2026, 2, 1, 0, 0]);
  assert.deepEqual(parts(shiftPeriod('month', at(2026, 1, 1, 0), -1)), [2025, 12, 1, 0, 0]);
});

test('the current period is named as such, and an earlier year is spelled out', () => {
  assert.match(periodLabel('day', periodRange('day', now).from, now), /^今天/);
  assert.match(periodLabel('week', periodRange('week', now).from, now), /^本周/);
  assert.match(periodLabel('month', periodRange('month', now).from, now), /^本月/);

  const lastWeek = periodLabel('week', at(2026, 9, 14, 0), now);
  assert.doesNotMatch(lastWeek, /本周|年/);
  // A week spanning New Year names both years.
  const newYear = periodLabel('week', at(2025, 12, 29, 0), now);
  assert.match(newYear, /2025年12月29日/);
  assert.match(newYear, /2026年1月4日/);
});

test('a link keeps the project and the period, and the default view keeps the address as it was', () => {
  const view = readView('', now);
  assert.equal(view.project, '');
  assert.equal(view.period, 'week');
  assert.deepEqual(parts(view.from), [2026, 9, 21, 0, 0]);
  assert.equal(writeView('http://pool.test/?keep=1', view, now).search, '?keep=1');

  const earlier = { project: 'mila-3', period: 'month', from: at(2026, 8, 1, 0) };
  assert.deepEqual(readView(writeView('http://pool.test/', earlier, now).search, now), earlier);
});

test('an unreadable or not yet started period in a link falls back to the current one', () => {
  assert.deepEqual(parts(readView('?period=year&date=2026-02-30', now).from), [2026, 9, 21, 0, 0]);
  assert.deepEqual(parts(readView('?period=day&date=2027-01-01', now).from), [2026, 9, 23, 0, 0]);
});

// Brian 2026-09-23 (#185): requirements including Tasks, Bugs, unclaimed, then four states.
test('需求 counts everything that is not a Bug, and each state reads its own count', () => {
  const tally = { total: 7, bugs: 2, unclaimed: 3, states: { 进行中: 1, 已完成: 2 } };
  assert.deepEqual(METRICS.map(metric => [metric.label, metric.value(tally)]), [
    ['需求', 5], ['Bug', 2], ['未认领', 3], ['进行中', 1], ['已实现待提交', 0], ['待验证/验收', 0], ['已完成', 2]
  ]);
});

test('what is shown is the chosen project\'s, or everyone\'s when none is chosen', () => {
  const data = {
    all: { current: { total: 3 } },
    projects: [{ identifier: 'eva-project', current: { total: 1 } }, { identifier: 'mila-3', current: { total: 2 } }]
  };
  assert.equal(chosenView(data, '').current.total, 3);
  assert.equal(chosenView(data, 'mila-3').current.total, 2);
  assert.equal(chosenView(data, 'gone'), null);
  assert.equal(chosenView(null, ''), null);
});

test('the trend is a run of whole periods that ends with the current one', () => {
  for (const kind of ['day', 'week', 'month']) {
    const edges = trendEdges(kind, now);
    assert.equal(edges.length, TREND_LENGTH[kind] + 1);
    assert.deepEqual(edges.at(-2), periodRange(kind, now).from);
    assert.deepEqual(edges.at(-1), periodRange(kind, now).to);
    for (let index = 1; index < edges.length; index += 1) {
      assert.deepEqual(edges[index], shiftPeriod(kind, edges[index - 1], 1));
    }
  }
});

test('a count axis tops out at a clean number at or above the largest value', () => {
  for (const max of [0, 1, 3, 7, 12, 38, 260]) {
    const { top, ticks } = countScale(max);
    assert.ok(top >= Math.max(max, 1), `${top} covers ${max}`);
    assert.ok(top < Math.max(max, 1) * 2.5, `${top} is not far above ${max}`);
    assert.equal(ticks[0], 0);
    assert.equal(ticks.at(-1), top);
    assert.ok(ticks.every(Number.isInteger), 'counts have whole ticks');
  }
});

test('how long ago reads in minutes, hours or days, then as a date', () => {
  const at = minutes => new Date(now.getTime() - minutes * 60000).toISOString();
  assert.match(relativeTime(at(0.5), now), /刚刚/);
  assert.match(relativeTime(at(5), now), /^5 分钟前$/);
  assert.match(relativeTime(at(3 * 60), now), /^3 小时前$/);
  assert.match(relativeTime(at(4 * 24 * 60), now), /^4 天前$/);
  assert.match(relativeTime(at(60 * 24 * 60), now), /月\d+日$/);
  assert.match(relativeTime(null, now), /未知/);
});

test('the state chart keeps every state in the order a requirement lives through them', () => {
  const rows = stateRows({ 已完成: 3, 进行中: 2, 新状态: 1 });
  assert.deepEqual(rows.slice(0, 6).map(row => row.label), ['待确认', '待认领', '进行中', '已实现待提交', '待验证/验收', '已完成']);
  assert.equal(rows.find(row => row.label === '待确认').value, 0);
  assert.equal(rows.find(row => row.label === '进行中').value, 2);
  // A state the pool gains later is not dropped.
  assert.equal(rows.at(-1).label, '新状态');
});
