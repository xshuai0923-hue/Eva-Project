// MCP user and token management, running inside OpenProject's own page.
//
// Third consumer of the arrangement the handoff module introduced: OpenProject renders
// the chrome, this renders the body, and the JSON API is reached through a controller
// that forwards the session cookie. The page this replaces was the last one still
// serving its own HTML off the MCP port.
//
// Everything is built as DOM nodes from text, so nothing a user typed — a display name,
// a user id — is ever interpreted as HTML.

import { createShell, el } from './shell.js?v=ed60c0da2c';

let root = null;
let apiBase = '';
let csrfToken = '';
let bodyNode = null;
let state = null;

const { notify, clearNotice, request: send, post: sendPost } = createShell({
  root: () => root,
  apiBase: () => apiBase,
  // Instance-wide administration: there is no project to narrow it to, and sending one
  // would put a stray parameter on every call.
  project: () => '',
  csrfToken: () => csrfToken
});

/** An admin's own token is what the page is being read through, so it is not rotatable
 *  or revocable from here: doing either would lock the person out mid-action. */
export function rowModel(user) {
  const isAdmin = user.role === 'admin';
  return {
    name: user.displayName,
    id: user.userId,
    role: isAdmin ? '管理员' : '用户',
    statusLabel: user.active ? '已启用' : '已吊销',
    statusClass: user.active ? 'mp-is-active' : 'mp-is-revoked',
    fingerprint: user.tokenFingerprint,
    when: formatWhen(user),
    rotateLabel: user.active ? '轮换 Token' : '重新启用',
    canRotate: !isAdmin,
    canRevoke: !isAdmin && user.active
  };
}

/** Include association changes alongside token changes. */
export function formatWhen(user) {
  const times = [user.revokedAt, user.rotatedAt, user.createdAt, user.linkedAt]
    .filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
  if (!times.length) return '—';
  const when = new Date(Math.max(...times));
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(when);
}

export const activeCount = users => users.filter(user => user.active).length;

const effectiveLogin = user => user.openProjectLogin === undefined ? user.userId : user.openProjectLogin;

export function associationModel(user, accounts) {
  const login = effectiveLogin(user);
  const account = accounts.find(account => account.login === login);
  return {
    login, name: account?.name ?? login,
    label: account ? '' : login === null ? '未关联' : '账号不存在或未启用',
    linked: Boolean(account)
  };
}

export function accountChoices(accounts, users, editing = null) {
  return accounts.map(account => {
    const owner = users.find(user => user.userId !== editing?.userId && effectiveLogin(user) === account.login);
    const adminOnly = editing?.role === 'admin' && !account.admin;
    return { ...account, disabled: Boolean(owner) || adminOnly,
      hint: owner ? `已关联 ${owner.userId}` : adminOnly ? '需要网页管理员账号' : '' };
  });
}

/**
 * What a user id may look like, in the form an <input pattern> accepts.
 *
 * The dash is escaped for a reason that is not cosmetic: a browser compiles this
 * attribute with the `v` flag, where a bare `-` at the end of a character class is a
 * syntax error. The page this replaces carried the unescaped form, so the attribute was
 * rejected outright and the field had no client-side validation at all -- silently, with
 * only a console line to say so.
 */
export const USER_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}';

function cell(row, value, className) {
  const td = el('td', className);
  if (value instanceof Node) td.append(value); else td.textContent = value;
  row.append(td);
  return td;
}

function action(label, className, onClick, disabled = false) {
  const button = el('button', 'mp-action' + (className ? ' ' + className : ''), label);
  button.type = 'button';
  button.disabled = disabled;
  if (!disabled) button.addEventListener('click', onClick);
  return button;
}

function renderHeader() {
  const header = el('div', 'mp-header');
  header.append(
    el('span', 'mp-header-title', 'MCP 用户'),
    el('span', 'mp-count', `${activeCount(state.users)} 个启用帐号 · Token 明文仅在创建或轮换后显示一次`)
  );
  const actions = el('div', 'mp-header-actions');
  actions.append(
    action('刷新', '', () => { void load(); }),
    action('新增用户', 'mp-is-primary', openCreateDialog, !state.ready)
  );
  header.append(actions);
  return header;
}

function renderTable() {
  const table = el('table', 'mp-table');
  const head = el('tr');
  for (const [label, className] of [
    ['用户', ''], ['角色', ''], ['状态', ''], ['关联网页账号', 'mp-col-account'],
    ['Token 指纹', 'mp-col-fingerprint'], ['最近变更', 'mp-col-when'], ['', '']
  ]) {
    const th = el('th', className, label);
    if (!label) th.setAttribute('aria-label', '操作');
    head.append(th);
  }
  const thead = el('thead');
  thead.append(head);
  table.append(thead);

  const body = el('tbody');
  for (const user of state.users) {
    const model = rowModel(user);
    const row = el('tr', 'mp-row');

    const identity = el('div');
    identity.append(el('div', 'mp-user-name', model.name), el('div', 'mp-user-id', model.id));
    cell(row, identity);
    cell(row, model.role);
    cell(row, el('span', 'mp-badge ' + model.statusClass, model.statusLabel));
    const account = associationModel(user, state.accounts);
    const linked = el('div');
    linked.append(el('div', '', account.linked ? account.name : account.label));
    if (account.login) linked.append(el('div', 'mp-user-id', account.login));
    cell(row, linked, 'mp-col-account');
    cell(row, el('span', 'mp-fingerprint', model.fingerprint), 'mp-col-fingerprint');
    cell(row, model.when, 'mp-when mp-col-when');

    const actions = el('div', 'mp-row-actions');
    actions.append(
      action(account.linked ? '编辑关联' : '关联账号', '', () => openLinkDialog(user)),
      action(model.rotateLabel, '', () => { void rotate(user); }, !model.canRotate),
      action('吊销', 'mp-is-danger', () => { void revoke(user); }, !model.canRevoke)
    );
    cell(row, actions);
    body.append(row);
  }
  table.append(body);
  return table;
}

function render() {
  bodyNode.replaceChildren();
  bodyNode.append(renderHeader());
  if (state.users.length === 0) {
    bodyNode.append(el('p', 'mp-empty', state.loaded ? '暂无用户' : '载入中…'));
    return;
  }
  bodyNode.append(renderTable());
}

function dialog(titleText, hintText) {
  const node = el('dialog', 'mp-tokens-dialog');
  node.append(el('h2', 'mp-dialog-title', titleText), el('p', 'mp-dialog-hint', hintText));
  // A dialog appended to the module root would be removed with it on the next Turbo
  // render while still open; the body outlives both.
  document.body.append(node);
  node.addEventListener('close', () => node.remove());
  return node;
}

function accountField(form, editing = null) {
  const wrap = el('label', 'mp-field', '关联网页账号');
  const select = el('select');
  select.name = 'openProjectLogin';
  select.required = true;
  const placeholder = el('option', '', '请选择网页账号');
  placeholder.value = '';
  select.append(placeholder);
  for (const account of accountChoices(state.accounts, state.users, editing)) {
    const option = el('option', '', `${account.name}（登录名：${account.login}）${account.hint ? ' · ' + account.hint : ''}`);
    option.value = account.login;
    option.disabled = account.disabled;
    select.append(option);
  }
  select.value = editing ? effectiveLogin(editing) ?? '' : '';
  wrap.append(select);
  form.append(wrap, el('p', 'mp-dialog-hint', '选择已启用的网页账号；每个网页账号只能关联一个 MCP 身份。'));
  return select;
}

function dialogError(node, error) {
  let message = node.querySelector('[role="alert"]');
  if (!message) {
    message = el('p', 'mp-dialog-error');
    message.setAttribute('role', 'alert');
    node.append(message);
  }
  message.textContent = error.message;
}

function openLinkDialog(user) {
  const node = dialog(`关联网页账号 · ${user.displayName}`, '保存关联会保留原有 MCP ID、Token 和角色。');
  const form = el('form');
  const select = accountField(form, user);
  const actions = el('div', 'mp-dialog-actions');
  if (user.role !== 'admin' && effectiveLogin(user) !== null) {
    actions.append(action('解除关联', 'mp-is-danger', () => {
      if (confirm('解除关联后，该网页账号将无法使用此 MCP 身份。确认解除？')) void saveLink(node, user, null);
    }));
  }
  const submit = el('button', 'mp-action mp-is-primary', '保存关联');
  submit.type = 'submit';
  actions.append(action('取消', '', () => node.close()), submit);
  form.append(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void saveLink(node, user, select.value);
  });
  node.append(form);
  node.showModal();
  select.focus();
}

async function saveLink(node, user, openProjectLogin) {
  const buttons = [...node.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    await sendPost(`/users/${encodeURIComponent(user.userId)}/link`, { openProjectLogin, lockVersion: user.lockVersion }, '保存关联失败');
    node.close();
    await load();
    notify(openProjectLogin === null ? '已解除网页账号关联，原 Token 保留。' : '已保存网页账号关联。');
  } catch (error) {
    dialogError(node, error);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

function openCreateDialog() {
  const node = dialog('新增 MCP 用户', '创建后立即生成 Token，明文只显示这一次。');
  const form = el('form');

  const field = (label, name, placeholder, pattern) => {
    const wrap = el('label', 'mp-field', label);
    const input = el('input');
    input.name = name;
    input.required = true;
    input.autocomplete = 'off';
    input.placeholder = placeholder;
    input.maxLength = name === 'userId' ? 64 : 100;
    if (pattern) input.pattern = pattern;
    wrap.append(input);
    form.append(wrap);
    return input;
  };

  const userId = field('用户 ID', 'userId', '例如 alice', USER_ID_PATTERN);
  field('显示名称', 'displayName', '例如 Alice');
  accountField(form);

  const actions = el('div', 'mp-dialog-actions');
  const cancel = action('取消', '', () => node.close());
  const submit = el('button', 'mp-action mp-is-primary', '创建并生成 Token');
  submit.type = 'submit';
  actions.append(cancel, submit);
  form.append(actions);

  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form);
    void create(node, String(data.get('userId') ?? ''), String(data.get('displayName') ?? ''), String(data.get('openProjectLogin') ?? ''));
  });

  node.append(form);
  node.showModal();
  userId.focus();
}

function showToken(userId, token, verb) {
  const node = dialog(`${userId} 的 Token 已${verb}`, '复制后交给对应用户配置 MCP。关闭后无法再次查看。');
  const box = el('div', 'mp-token-box');
  const copy = action('复制', '', async () => {
    try {
      await navigator.clipboard.writeText(token);
      copy.textContent = '已复制';
    } catch {
      // Clipboard access is refused outside a secure context, and the token is right
      // there to select by hand — say so instead of failing silently.
      copy.textContent = '请手动复制';
    }
  });
  box.append(el('code', 'mp-token-value', token), copy);

  const actions = el('div', 'mp-dialog-actions');
  actions.append(action('完成', 'mp-is-primary', () => node.close()));
  node.append(box, actions);
  node.showModal();
}

async function load() {
  try {
    clearNotice();
    const [result, accountResult] = await Promise.all([
      send('/users', { failure: '载入用户失败' }), send('/accounts', { failure: '载入网页账号失败' })
    ]);
    state.users = result.users ?? [];
    state.accounts = accountResult.accounts ?? [];
    state.ready = true;
    state.loaded = true;
    render();
  } catch (error) {
    state.loaded = true;
    render();
    notify(error.message, 'error');
  }
}

async function create(node, userId, displayName, openProjectLogin) {
  const submit = node.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    clearNotice();
    const result = await sendPost('/users', { userId, displayName, openProjectLogin }, '创建用户失败');
    node.close();
    await load();
    showToken(userId, result.token, '生成');
  } catch (error) {
    dialogError(node, error);
  } finally {
    submit.disabled = false;
  }
}

async function rotate(user) {
  const verb = user.active ? '轮换' : '重新启用并生成';
  if (!confirm(`${verb} ${user.userId} 的 Token？旧 Token 立即失效。`)) return;
  try {
    clearNotice();
    const result = await sendPost(`/users/${encodeURIComponent(user.userId)}/rotate`, {}, '轮换失败');
    await load();
    showToken(user.userId, result.token, user.active ? '轮换' : '生成');
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function revoke(user) {
  if (!confirm(`吊销 ${user.userId}？该用户的 MCP Token 立即失效。`)) return;
  try {
    clearNotice();
    await sendPost(`/users/${encodeURIComponent(user.userId)}/revoke`, {}, '吊销失败');
    await load();
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function mount() {
  const container = document.getElementById('mp-tokens');
  if (!container || container.dataset.mounted === '1') return;
  container.dataset.mounted = '1';

  root = container;
  apiBase = container.dataset.api ?? '';
  csrfToken = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
  state = { users: [], accounts: [], loaded: false, ready: false };

  bodyNode = el('div', 'mp-body');
  container.append(bodyNode);
  render();
  await load();
}

if (typeof document !== 'undefined') {
  for (const event of ['turbo:load', 'turbo:render', 'DOMContentLoaded']) {
    document.addEventListener(event, () => { void mount(); });
  }
  void mount();
}
