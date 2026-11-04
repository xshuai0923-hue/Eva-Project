import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const { rowModel, formatWhen, activeCount, accountChoices, associationModel, USER_ID_PATTERN } = await import('./assets/tokens.js');

const user = (extra = {}) => ({
  userId: 'yimeng',
  displayName: '忆梦',
  role: 'user',
  active: true,
  tokenFingerprint: '69121f9798db',
  createdAt: '2026-09-20T02:00:00Z',
  ...extra
});

test('an ordinary account can have its token rotated and revoked', () => {
  const model = rowModel(user());

  assert.equal(model.role, '用户');
  assert.equal(model.statusLabel, '已启用');
  assert.equal(model.rotateLabel, '轮换 Token');
  assert.equal(model.canRotate, true);
  assert.equal(model.canRevoke, true);
});

// The page is read through an admin's own token. Offering to rotate or revoke it is
// offering to lock the reader out halfway through the action.
test('an admin account offers neither rotate nor revoke', () => {
  const model = rowModel(user({ role: 'admin', userId: 'brian' }));

  assert.equal(model.role, '管理员');
  assert.equal(model.canRotate, false);
  assert.equal(model.canRevoke, false);
});

test('a revoked account can be re-enabled but not revoked again', () => {
  const model = rowModel(user({ active: false, revokedAt: '2026-09-21T03:00:00Z' }));

  assert.equal(model.statusLabel, '已吊销');
  assert.equal(model.statusClass, 'mp-is-revoked');
  assert.equal(model.rotateLabel, '重新启用');
  assert.equal(model.canRotate, true);
  assert.equal(model.canRevoke, false);
});

test('the date column shows the most recent thing that happened to the token', () => {
  const created = formatWhen(user());
  const rotated = formatWhen(user({ rotatedAt: '2026-09-22T13:21:00Z' }));
  const revoked = formatWhen(user({ rotatedAt: '2026-09-22T13:21:00Z', revokedAt: '2026-09-22T14:00:00Z' }));

  assert.notEqual(created, rotated);
  assert.notEqual(rotated, revoked);
});

// A token that has never been touched carries no date at all, and the column has to say
// so rather than printing Invalid Date.
test('a missing or unparseable date reads as a dash', () => {
  assert.equal(formatWhen({ }), '—');
  assert.equal(formatWhen({ createdAt: 'not a date' }), '—');
});

test('the count is of enabled accounts, not of rows', () => {
  assert.equal(activeCount([user(), user({ active: false }), user()]), 2);
});

// A browser compiles an <input pattern> with the `v` flag. The old page's pattern ended
// in a bare dash, which is a syntax error there, so the browser threw the attribute away
// and the field validated nothing — visible only as a console line nobody was reading.
test('the user id pattern is one a browser will actually compile', () => {
  assert.doesNotThrow(() => new RegExp(USER_ID_PATTERN, 'v'));
});

test('the user id pattern accepts a plain id and rejects what the server would refuse', () => {
  const matches = value => new RegExp(`^(?:${USER_ID_PATTERN})$`, 'v').test(value);

  assert.equal(matches('alice'), true);
  assert.equal(matches('a.b_c-d'), true);
  assert.equal(matches('_leading'), false);
  assert.equal(matches('has space'), false);
  assert.equal(matches(''), false);
});

test('association uses the exact login, with legacy fallback but no fallback after unlink', () => {
  const accounts = [{ login: '李多吉', name: '李多吉' }, { login: 'yimeng', name: '忆梦' }];
  assert.equal(associationModel(user({ openProjectLogin: '李多吉' }), accounts).login, '李多吉');
  assert.equal(associationModel(user(), accounts).name, '忆梦');
  assert.equal(associationModel(user({ openProjectLogin: null }), accounts).label, '未关联');
  assert.equal(associationModel(user({ openProjectLogin: 'missing' }), accounts).label, '账号不存在或未启用');
});

test('occupied accounts cannot be selected by another user, even if its token is revoked', () => {
  const accounts = [{ login: '李多吉', name: '李多吉' }, { login: 'free', name: '新用户' }];
  const users = [user({ openProjectLogin: '李多吉', active: false })];
  assert.equal(accountChoices(accounts, users)[0].disabled, true);
  assert.equal(accountChoices(accounts, users, users[0])[0].disabled, false);
  assert.equal(accountChoices(accounts, users)[1].disabled, false);
});

test('administrator identities can only select administrator webpage accounts', () => {
  const choices = accountChoices([{ login: 'admin', admin: true }, { login: 'other', admin: false }], [], user({ role: 'admin' }));
  assert.equal(choices[0].disabled, false);
  assert.equal(choices[1].disabled, true);
});

test('a later association edit appears in the recent-change column', () => {
  assert.notEqual(formatWhen(user()), formatWhen(user({ linkedAt: '2026-10-09T02:00:00Z' })));
});
