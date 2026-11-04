import { el } from './shell.js?v=ed60c0da2c';

export function recordUrl(kind, project, reference) {
  const url = new URL(`/projects/${encodeURIComponent(project)}/${kind}`, location.origin);
  if (reference) url.searchParams.set('open', String(reference));
  return url;
}

export function copyButton(value, label = '复制链接') {
  const button = el('button', 'mp-action', label);
  button.type = 'button';
  button.onclick = async () => {
    const text = typeof value === 'function' ? value() : value;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(String(text));
      button.textContent = '已复制';
    } catch {
      const area = el('textarea');
      area.value = String(text);
      area.readOnly = true;
      area.setAttribute('aria-label', label);
      button.after(area);
      area.select();
      button.textContent = '请复制下方内容';
      area.addEventListener('blur', () => area.remove(), { once: true });
    }
  };
  return button;
}

/** Search and page within an explicit project. Selection is never inferred from text. */
export function recordPicker({ project, kind = 'requirement', label = '关联需求', initial = null, exclude = null, onChange = () => {} }) {
  const node = el('div', 'eva-picker');
  const searchLabel = el('label', 'eva-create-field');
  searchLabel.append(el('span', '', `${label}：搜索${kind === 'handoff' ? '标题、编号或工作线' : '标题'}`));
  const search = el('input');
  search.type = 'search';
  search.placeholder = '输入关键词，无需记编号';
  searchLabel.append(search);
  const selectLabel = el('label', 'eva-create-field');
  selectLabel.append(el('span', '', label));
  const select = el('select');
  select.setAttribute('aria-label', label);
  selectLabel.append(select);
  const status = el('span', 'mp-hint');
  status.setAttribute('role', 'status');
  const more = el('button', 'mp-action', '加载更多选项');
  more.type = 'button';
  const retry = el('button', 'mp-action', '重试加载');
  retry.type = 'button';
  retry.hidden = true;
  const rows = new Map();
  if (initial) rows.set(String(initial.workPackageId ?? initial.id), initial);
  let selected = initial ? String(initial.workPackageId ?? initial.id) : '';
  let cursor = null;
  let ticket = 0;
  let timer;
  let lastAppend = false;
  const render = () => {
    select.replaceChildren();
    select.append(el('option', '', kind === 'handoff' ? '不继续旧交接，创建新工作线' : '不关联需求'));
    select.firstChild.value = '';
    for (const [key, item] of rows) {
      const option = el('option', '', `${item.title} · #${item.workPackageId ?? item.id}`);
      option.value = key;
      option.selected = key === selected;
      select.append(option);
    }
    select.value = selected;
  };
  const load = async (append = false) => {
    lastAppend = append;
    const current = ++ticket;
    const params = new URLSearchParams({ project, page_size: '50' });
    if (append && cursor) params.set('cursor', cursor);
    if (search.value.trim()) params.set(kind === 'handoff' ? 'q' : 'subject', search.value.trim());
    if (kind !== 'handoff') params.set('sort_by', 'id:asc');
    more.disabled = true;
    retry.hidden = true;
    status.textContent = '正在查询…';
    try {
      const base = kind === 'handoff' ? '/handoff/api/handoffs' : '/requirements/api/requirements';
      const response = await fetch(`${base}?${params}`, { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (current !== ticket || !node.isConnected) return;
      if (!response.ok) throw new Error(data.error || '查询失败');
      if (!append) {
        const keep = rows.get(selected);
        rows.clear();
        if (keep) rows.set(selected, keep);
      }
      for (const item of data.items ?? []) {
        if (String(item.workPackageId) !== String(exclude)) rows.set(String(item.workPackageId ?? item.id), item);
      }
      cursor = data.nextCursor ?? null;
      render();
      status.textContent = data.total ? `找到 ${data.total} 条，可选择后继续` : '没有匹配记录，可换关键词查询';
      more.hidden = !cursor;
    } catch (error) {
      if (current === ticket && node.isConnected) { status.textContent = error.message; retry.hidden = false; }
    } finally {
      if (current === ticket) more.disabled = false;
    }
  };
  select.onchange = () => { selected = select.value; onChange(rows.get(selected) ?? null); };
  search.oninput = () => { ++ticket; clearTimeout(timer); timer = setTimeout(() => void load(), 250); };
  more.onclick = () => void load(true);
  retry.onclick = () => void load(lastAppend);
  node.append(searchLabel, selectLabel, status, more, retry);
  render();
  setTimeout(() => void load(), 0);
  return { node, select, value: () => rows.get(selected) ?? null };
}

/** Button groups use pressed semantics rather than incomplete ARIA tab widgets. */
export function pressed(button, active) {
  button.setAttribute('aria-pressed', String(active));
  button.classList.toggle('mp-is-active', active);
}
