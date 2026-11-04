import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const { confirmsRestore, contentLabel, formatSize, jobVisible, restoreNote, stampLabel } = await import('./assets/backup.js');

// A restore overwrites everything after the backup, so it goes ahead only on the
// backup's own name, typed out — a stray click or an Enter is not enough.
test('a restore is confirmed only by the backup name itself', () => {
  assert.equal(confirmsRestore('20260920-100000', '20260920-100000'), true);
  assert.equal(confirmsRestore(' 20260920-100000 ', '20260920-100000'), true);
  assert.equal(confirmsRestore('20260920-10000', '20260920-100000'), false);
  assert.equal(confirmsRestore('', '20260920-100000'), false);
});

// A restore logs everyone out, so its outcome has to still be on the page after logging
// back in; a job someone has read and closed does not come back.
test('a finished job stays on the page for a while, until it is dismissed', () => {
  const now = Date.parse('2026-09-24T14:00:00Z');
  const job = { id: 'restore-1', state: 'succeeded', startedAt: '2026-09-24T13:20:00Z', finishedAt: '2026-09-24T13:30:00Z' };
  assert.equal(jobVisible({ ...job, state: 'running' }, null, now), true);
  assert.equal(jobVisible(job, null, now), true);
  assert.equal(jobVisible(job, 'restore-1', now), false);
  assert.equal(jobVisible({ ...job, finishedAt: '2026-09-24T12:00:00Z' }, null, now), false);
  assert.equal(jobVisible(null, null, now), false);
});

// Whether the data changed is the first thing to know after a restore that did not finish.
test('a restore that failed before switching says the data was not changed', () => {
  const restore = { type: 'restore', backupName: '20260924-221419' };
  assert.equal(restoreNote({ ...restore, state: 'failed' }), '现有数据没有改动。');
  assert.match(restoreNote({ ...restore, state: 'failed', liveTouched: true }), /恢复前/);
  assert.match(restoreNote({ ...restore, state: 'succeeded', liveTouched: true }), /重新登录/);
  assert.equal(restoreNote({ ...restore, state: 'running' }), '');
});

test('a backup missing its dump or attachments says it cannot be restored', () => {
  assert.match(contentLabel({ complete: false, entries: null, attachments: null }), /不能恢复/);
  assert.equal(contentLabel({ complete: true, entries: 2145, attachments: 74 }), '数据库 2145 项 · 附件 74 个');
});

test('sizes read in the unit that fits', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(17 * 1024 * 1024), '17 MB');
  assert.equal(formatSize(38.4 * 1024 ** 3), '38 GB');
  assert.equal(formatSize(undefined), '—');
});

test('a backup is labelled by when it was taken, with the year only when it is another one', () => {
  const now = new Date(2026, 8, 24, 22, 0);
  assert.equal(stampLabel('20260924-212750', now), '9月24日 21:27');
  assert.equal(stampLabel('20251231-033000', now), '2025年12月31日 03:30');
});
