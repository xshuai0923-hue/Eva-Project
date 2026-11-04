// The backup page (#237), running inside OpenProject's own page.
//
// Brian 2026-09-24 asked whether backups ran by themselves, where to see them and how to
// restore one — and did not want a terminal to be the answer to any of it. So all of it
// is here: whether backups run and when, how long they are kept, every backup and what
// it holds, and taking, downloading, deleting and restoring one. The MCP does the work;
// a backup or a restore runs as a job, and this page follows it until it ends.
//
// Built as DOM nodes from text, like the other module pages.

import { createShell, el, loadingNode } from './shell.js?v=ed60c0da2c';

let root = null;
let apiBase = '';
let downloadBase = '';
let csrfToken = '';
let bodyNode = null;
let state = null;
let pollTimer = null;

const { notify, clearNotice, request: send, post: sendPost } = createShell({
  root: () => root,
  apiBase: () => apiBase,
  // Instance-wide: there is no project to narrow it to.
  project: () => '',
  csrfToken: () => csrfToken
});

export const ORIGIN_LABELS = { scheduled: '自动', manual: '手动', 'before-restore': '恢复前', release: '上线前' };

const pad = value => String(value).padStart(2, '0');

export function formatSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 || value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** Month, day and time; the year only when it is not this one. */
export function formatDate(when, now = new Date()) {
  if (!(when instanceof Date) || Number.isNaN(when.getTime())) return '—';
  const year = when.getFullYear() === now.getFullYear() ? '' : `${when.getFullYear()}年`;
  return `${year}${when.getMonth() + 1}月${when.getDate()}日 ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

export const formatWhen = (iso, now = new Date()) => (iso ? formatDate(new Date(iso), now) : '—');

/** A backup is named by when it was taken, on the server's clock. */
export function stampLabel(name, now = new Date()) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name ?? '');
  if (!match) return name ?? '';
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  return formatDate(new Date(year, month - 1, day, hour, minute, second), now);
}

export function contentLabel(entry) {
  if (!entry.complete) return '不完整，不能恢复';
  const parts = [];
  if (typeof entry.entries === 'number') parts.push(`数据库 ${entry.entries} 项`);
  if (typeof entry.attachments === 'number') parts.push(`附件 ${entry.attachments} 个`);
  return parts.length > 0 ? parts.join(' · ') : '数据库与附件';
}

export function scheduleLabel(settings) {
  return settings.enabled
    ? `每天 ${settings.time} 自动备份，保留 ${settings.keepDays} 天`
    : '自动备份已关闭';
}

export function lastBackupLabel(last) {
  if (!last) return '还没有备份过';
  const what = `${formatWhen(last.at)} ${ORIGIN_LABELS[last.origin] ?? ''}备份`;
  return last.ok ? `${what}，成功` : `${what}失败：${last.error ?? '原因不明'}`;
}

export function jobTitle(job) {
  if (job.type === 'restore') {
    const target = job.target ? `${stampLabel(job.target.name)} 的备份` : '备份';
    if (job.state === 'running') return `正在恢复到 ${target}…`;
    return job.state === 'succeeded' ? `已恢复到 ${target}` : '恢复没有完成';
  }
  if (job.state === 'running') return '正在备份…';
  return job.state === 'succeeded' ? '备份完成' : '备份失败';
}

/**
 * What a restore's outcome means for the data. One that failed before switching has not
 * changed anything, and says so: naming the backup of the current data there read as if
 * the data had been touched.
 */
export function restoreNote(job) {
  if (job.type !== 'restore' || job.state === 'running') return '';
  if (job.state === 'succeeded') {
    return job.backupName
      ? `恢复前的数据已另存为 ${stampLabel(job.backupName)} 的「恢复前」备份。所有人需要重新登录。`
      : '所有人需要重新登录。';
  }
  if (!job.liveTouched) return '现有数据没有改动。';
  return job.backupName ? `恢复前的数据另存在 ${stampLabel(job.backupName)} 的「恢复前」备份里。` : '';
}

/** The confirmation a restore asks for: the backup's own name, typed out. */
export const confirmsRestore = (typed, name) => typed.trim() === name;

const JOB_SHOWN_FOR_MS = 60 * 60 * 1000;

/** A finished job stays on the page for an hour, so a restore's outcome is still there
 *  after the login it forces. */
export function jobVisible(job, dismissed, now = Date.now()) {
  if (!job || job.id === dismissed) return false;
  if (job.state === 'running') return true;
  return now - Date.parse(job.finishedAt ?? job.startedAt) < JOB_SHOWN_FOR_MS;
}

const running = () => state.data?.job?.state === 'running';

function action(label, className, onClick, disabled = false) {
  const button = el('button', 'mp-action' + (className ? ' ' + className : ''), label);
  button.type = 'button';
  button.disabled = disabled;
  if (!disabled) button.addEventListener('click', onClick);
  return button;
}

function renderHeader() {
  const header = el('div', 'mp-header');
  header.append(el('span', 'mp-header-title', '备份'));
  if (state.data) {
    const backups = state.data.backups ?? [];
    const total = backups.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
    const free = state.data.freeBytes === null ? '' : ` · 磁盘剩余 ${formatSize(state.data.freeBytes)}`;
    header.append(el('span', 'mp-count', `${backups.length} 份，共 ${formatSize(total)}${free}`));
  }
  const actions = el('div', 'mp-header-actions');
  actions.append(
    action('刷新', '', () => { void load(); }),
    action('立即备份', 'mp-is-primary', () => { void runNow(); }, !state.data || running())
  );
  header.append(actions);
  return header;
}

function renderSchedule() {
  const { settings, nextRun, lastBackup } = state.data;
  const panel = el('section', 'mp-backup-panel');
  const line = el('div', 'mp-backup-schedule');
  line.append(
    el('span', 'mp-badge ' + (settings.enabled ? 'mp-is-active' : 'mp-is-off'), settings.enabled ? '已开启' : '已关闭'),
    el('span', 'mp-backup-summary', scheduleLabel(settings)),
    action('修改设置', '', openSettingsDialog)
  );
  panel.append(line);
  if (settings.enabled && nextRun) panel.append(el('div', 'mp-backup-meta', `下次：${formatWhen(nextRun)}`));
  const last = el('div', 'mp-backup-meta' + (lastBackup && !lastBackup.ok ? ' mp-is-error' : ''), `最近一次：${lastBackupLabel(lastBackup)}`);
  panel.append(last);
  return panel;
}

function renderJob(job) {
  const panel = el('section', `mp-backup-panel mp-backup-job mp-is-${job.state}`);
  panel.setAttribute('role', 'status');
  const head = el('div', 'mp-backup-job-head');
  head.append(el('span', 'mp-backup-job-title', jobTitle(job)));
  if (job.state !== 'running') {
    head.append(action('知道了', '', () => {
      state.dismissedJob = job.id;
      render();
    }));
  }
  panel.append(head);

  const steps = el('ol', 'mp-backup-steps');
  for (const step of job.steps ?? []) steps.append(el('li', `mp-step mp-is-${step.state}`, step.label));
  panel.append(steps);

  if (job.error) panel.append(el('p', 'mp-backup-job-error', job.error));
  if (job.warning) panel.append(el('p', 'mp-backup-job-warning', job.warning));
  const note = restoreNote(job);
  if (note) panel.append(el('p', 'mp-backup-job-note', note));
  return panel;
}

function renderList() {
  const backups = state.data.backups ?? [];
  if (backups.length === 0) return el('p', 'mp-empty', '还没有备份');

  const table = el('table', 'mp-table');
  const head = el('tr');
  for (const [label, className] of [['时间', ''], ['来源', ''], ['大小', 'mp-col-size'], ['内容', 'mp-col-content'], ['', '']]) {
    const th = el('th', className, label);
    if (!label) th.setAttribute('aria-label', '操作');
    head.append(th);
  }
  const thead = el('thead');
  thead.append(head);
  table.append(thead);

  const body = el('tbody');
  const busy = running();
  const restoring = state.data.job?.state === 'running' ? state.data.job.target : null;
  for (const entry of backups) {
    const row = el('tr', 'mp-row');
    const when = el('td');
    when.append(el('div', 'mp-backup-when', stampLabel(entry.name)), el('div', 'mp-backup-name', entry.name));
    row.append(when);
    row.append(el('td', '', ORIGIN_LABELS[entry.origin] ?? entry.origin));
    row.append(el('td', 'mp-when mp-col-size', formatSize(entry.sizeBytes)));
    row.append(el('td', 'mp-when mp-col-content' + (entry.complete ? '' : ' mp-is-error'), contentLabel(entry)));

    const actions = el('div', 'mp-row-actions');
    const download = el('a', 'mp-action', '下载');
    download.href = `${downloadBase}/${entry.kind}/${entry.name}`;
    download.setAttribute('download', `eva-project-backup-${entry.name}.tar`);
    const inUse = restoring && restoring.kind === entry.kind && restoring.name === entry.name;
    actions.append(
      download,
      action('恢复', '', () => openRestoreDialog(entry), busy || !entry.complete),
      action('删除', 'mp-is-danger', () => { void remove(entry); }, Boolean(inUse))
    );
    const cell = el('td');
    cell.append(actions);
    row.append(cell);
    body.append(row);
  }
  table.append(body);
  return table;
}

function renderSessionLost() {
  const panel = el('section', 'mp-backup-panel mp-backup-job mp-is-failed');
  panel.append(el('div', 'mp-backup-job-title', '需要重新登录'));
  panel.append(el('p', 'mp-backup-job-note', '恢复会让所有人退出登录。重新登录后回到这一页，就能看到恢复的结果。'));
  const login = el('a', 'mp-action mp-is-primary', '重新登录');
  login.href = `/login?back_url=${encodeURIComponent(location.pathname)}`;
  panel.append(login);
  return panel;
}

function render() {
  if (!bodyNode) return;
  bodyNode.replaceChildren();
  bodyNode.append(renderHeader());
  if (state.sessionLost) {
    bodyNode.append(renderSessionLost());
    return;
  }
  if (!state.data) {
    if (!state.loaded) bodyNode.append(loadingNode());
    return;
  }
  if (state.switching) {
    bodyNode.append(el('div', 'mp-backup-panel mp-backup-meta', '正在切换到恢复的数据，系统可能有一小会儿没有响应…'));
  }
  bodyNode.append(renderSchedule());
  const job = state.data.job;
  if (jobVisible(job, state.dismissedJob)) bodyNode.append(renderJob(job));
  bodyNode.append(renderList());
  bodyNode.append(el('p', 'mp-backup-footnote',
    '下载的备份里有运行配置中的密钥和令牌，请妥善保管。上线前的备份不会自动清理，不需要的可以在这里删除。'));
}

function dialog(titleText, hintText) {
  const node = el('dialog', 'mp-backup-dialog');
  node.append(el('h2', 'mp-dialog-title', titleText));
  if (hintText) node.append(el('p', 'mp-dialog-hint', hintText));
  // A dialog appended to the module root would be removed with it on the next Turbo
  // render while still open; the body outlives both.
  document.body.append(node);
  node.addEventListener('close', () => node.remove());
  return node;
}

function field(labelText, input) {
  const wrap = el('label', 'mp-field', labelText);
  wrap.append(input);
  return wrap;
}

function openSettingsDialog() {
  const settings = state.data.settings;
  const node = dialog('自动备份', `按服务器时间（${state.data.timezone}）每天备份一次。`);
  const form = el('form');

  const toggleWrap = el('label', 'mp-check');
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.checked = settings.enabled;
  toggleWrap.append(toggle, el('span', '', '每天自动备份'));

  const time = el('input');
  time.type = 'time';
  time.required = true;
  time.step = 60;
  time.value = settings.time;

  const keep = el('input');
  keep.type = 'number';
  keep.required = true;
  keep.min = '1';
  keep.max = '365';
  keep.step = '1';
  keep.value = String(settings.keepDays);

  form.append(toggleWrap, field('时间', time), field('保留天数', keep),
    el('p', 'mp-dialog-hint', '超过保留天数的每日备份会在下一次备份后清掉；上线前的备份不受影响。'));

  const actions = el('div', 'mp-dialog-actions');
  const submit = el('button', 'mp-action mp-is-primary', '保存');
  submit.type = 'submit';
  actions.append(action('取消', '', () => node.close()), submit);
  form.append(actions);

  form.addEventListener('submit', event => {
    event.preventDefault();
    void saveSettings(node, { enabled: toggle.checked, time: time.value, keepDays: Number(keep.value) });
  });
  node.append(form);
  node.showModal();
}

function openRestoreDialog(entry) {
  const node = dialog(`恢复到 ${stampLabel(entry.name)} 的备份？`, '');
  for (const text of [
    '数据库和附件会回到这份备份时的样子，之后的改动都会被覆盖。',
    '恢复前会先自动备份当前数据，恢复错了还可以从那一份再恢复回来。',
    '恢复时系统会有一小会儿不可用，完成后所有人都需要重新登录。'
  ]) node.append(el('p', 'mp-dialog-hint', text));

  const form = el('form');
  const input = el('input');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'off');
  form.append(field(`输入 ${entry.name} 确认`, input));

  const actions = el('div', 'mp-dialog-actions');
  const submit = el('button', 'mp-action mp-is-primary', '恢复');
  submit.type = 'submit';
  submit.disabled = true;
  actions.append(action('取消', '', () => node.close()), submit);
  form.append(actions);

  // Text an input method still holds is not typed yet, as in the top bar search: the
  // button follows what has been committed to the field.
  const sync = event => {
    submit.disabled = Boolean(event?.isComposing) || !confirmsRestore(input.value, entry.name);
  };
  input.addEventListener('input', sync);
  input.addEventListener('compositionend', () => sync());

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!confirmsRestore(input.value, entry.name)) return;
    void restore(node, entry, input.value.trim());
  });
  node.append(form);
  node.showModal();
  input.focus();
}

// --- Requests ---------------------------------------------------------------------

function schedulePoll(delay = 2000) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    // The page may have been left; a detached root has nobody to show anything to.
    if (root?.isConnected) void load();
  }, delay);
}

const sessionLost = () => Object.assign(new Error('需要重新登录'), { sessionLost: true });

async function load() {
  const restoring = running() && state.data.job.type === 'restore';
  try {
    const result = await send('/state', { failure: '载入备份失败' });
    // The session lives in the database a restore replaces; losing it answers with the
    // login page instead of the state.
    if (!result || !result.settings) throw sessionLost();
    state.data = result;
    state.loaded = true;
    state.sessionLost = false;
    state.switching = false;
    state.failures = 0;
    render();
    if (running()) schedulePoll();
  } catch (error) {
    state.loaded = true;
    if (error.sessionLost && state.data) {
      state.sessionLost = true;
      render();
      return;
    }
    if (restoring && state.failures < 90) {
      // Mid-switch the application reconnects to the restored database; keep asking.
      state.failures += 1;
      state.switching = true;
      render();
      schedulePoll(3000);
      return;
    }
    render();
    notify(error.message, 'error');
  }
}

async function runNow() {
  try {
    clearNotice();
    const result = await sendPost('/run', {}, '备份没有开始');
    state.data.job = result.job;
    state.dismissedJob = null;
    render();
    schedulePoll(1000);
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function saveSettings(node, settings) {
  try {
    clearNotice();
    state.data = await sendPost('/settings', settings, '保存设置失败');
    node.close();
    render();
    notify('设置已保存');
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function restore(node, entry, confirm) {
  try {
    clearNotice();
    const result = await sendPost(`/backups/${entry.kind}/${entry.name}/restore`, { confirm }, '恢复没有开始');
    node.close();
    state.data.job = result.job;
    state.dismissedJob = null;
    render();
    schedulePoll(1000);
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function remove(entry) {
  if (!confirm(`删除 ${stampLabel(entry.name)} 的备份（${entry.name}）？删除后无法找回。`)) return;
  try {
    clearNotice();
    state.data = await sendPost(`/backups/${entry.kind}/${entry.name}/delete`, {}, '删除失败');
    render();
    notify('已删除');
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function mount() {
  const container = document.getElementById('mp-backup');
  if (!container || container.dataset.mounted === '1') return;
  container.dataset.mounted = '1';

  root = container;
  apiBase = container.dataset.api ?? '';
  downloadBase = container.dataset.download ?? '';
  csrfToken = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
  state = { data: null, loaded: false, sessionLost: false, switching: false, failures: 0, dismissedJob: null };

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
