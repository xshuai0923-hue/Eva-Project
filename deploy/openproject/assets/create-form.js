import { el } from './shell.js?v=ed60c0da2c';
import { recordPicker } from './ui-controls.js?v=a9c7e129c8';

export function creationRequestId(random = globalThis.crypto) {
  if (typeof random.randomUUID === 'function') return random.randomUUID();
  const bytes = random.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

// Keep the form mounted on failure so the text and request ID survive a retry.
export function showCreateForm({ kind = 'requirement', types = [], agents = [], parent = null,
  project = null, userId = null, initial = {}, submit, created }) {
  const handoff = kind === 'handoff';
  const editing = kind === 'edit';
  const focusBefore = document.activeElement;
  const scope = project?.identifier ?? '';
  const draftKey = scope && userId ? `eva.draft.${JSON.stringify([location.origin, userId, scope, kind, parent?.workPackageId ?? initial.workPackageId ?? null])}` : null;
  let draft = null;
  try { if (draftKey) draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null'); } catch { /* Storage can be unavailable. */ }
  if (!draft || typeof draft !== 'object' || !draft.values || !Array.isArray(draft.todos)) draft = null;
  const dialog = el('dialog', 'eva-create');
  const form = el('form');
  const title = el('h2', '', editing ? '编辑需求' : handoff ? '新建交接' : parent ? '新建分工子任务' : '新建需求');
  title.id = `eva-form-${creationRequestId()}`;
  dialog.setAttribute('aria-labelledby', title.id);
  form.append(title);
  form.append(el('p', 'eva-create-project', `目标项目：${project?.name || scope || '请先选择项目'}`));
  const draftStatus = el('p', 'eva-create-hint', draft ? '发现本标签页未提交的草稿，已恢复。' : '填写后可保留草稿，成功提交后自动清除。');
  draftStatus.setAttribute('role', 'status');
  form.append(draftStatus);
  const fields = {};
  const add = (key, label, tag = 'input', values = null, required = false) => {
    const wrap = el('label', 'eva-create-field');
    wrap.append(el('span', '', label));
    const node = el(tag);
    node.name = key;
    node.required = required;
    if (tag === 'input') node.type = 'text';
    if (tag === 'textarea') node.rows = 4;
    if (values) for (const [value, text] of values) {
      const option = el('option', '', text);
      option.value = value;
      node.append(option);
    }
    fields[key] = node;
    wrap.append(node);
    form.append(wrap);
    return node;
  };
  add('title', '标题 *', 'input', null, true).maxLength = 255;
  if (parent) form.append(el('p', '', `归属需求 #${parent.workPackageId}。子任务可分别认领，全部必需子任务完成后再完成主需求。`));
  if (!handoff && types.length) add('typeId', '类型', 'select', types.map(t => [String(t.id), t.name]));
  if (!editing) {
    add('visibility', '可见性', 'select', [['私有', '私有'], ['公开', '公开']]);
    form.append(el('p', 'eva-create-hint', '公开内容仍受项目访问权限限制。私有内容仅所属用户与管理员可见。'));
  }
  const todoRows = [];
  let previousPicker = null;
  let supersede = null;
  if (handoff) {
    previousPicker = recordPicker({ project: scope, kind: 'handoff', label: '继续已有工作线（可选）',
      initial: draft?.previous ?? null, onChange: () => {
        supersede.checked = false;
        supersede.disabled = previousPicker.value()?.handoffState !== '待接手';
        form.dispatchEvent(new Event('input'));
      } });
    form.append(previousPicker.node);
    const replaceLabel = el('label', 'eva-create-hint');
    supersede = el('input');
    supersede.type = 'checkbox';
    supersede.disabled = previousPicker.value()?.handoffState !== '待接手';
    supersede.checked = Boolean(draft?.supersede) && !supersede.disabled;
    replaceLabel.append(supersede, ' 替换尚未接手的旧交接（旧记录将归档，需要相应权限）');
    form.append(replaceLabel);
    for (const name of ['背景', '主线', '现状', '注意事项']) add(name, name, 'textarea');
    const todos = el('section', 'eva-create-todos');
    todos.append(el('h3', '', '待办与关联需求'));
    const addTodo = (saved = {}) => {
      if (todoRows.length >= 100) return;
      const row = el('div', 'eva-todo-editor');
      const label = el('label', 'eva-create-field');
      label.append(el('span', '', '待办内容'));
      const text = el('input');
      text.type = 'text'; text.maxLength = 2000; text.value = saved.text || '';
      label.append(text);
      const picker = recordPicker({ project: scope, label: '这项待办关联的需求（可选）',
        initial: saved.requirement ?? null, onChange: () => form.dispatchEvent(new Event('input')) });
      const remove = el('button', 'mp-action', '移除这项待办');
      remove.type = 'button';
      const item = { row, text, picker };
      remove.onclick = () => { todoRows.splice(todoRows.indexOf(item), 1); row.remove(); form.dispatchEvent(new Event('input')); };
      row.append(label, picker.node, remove);
      todoRows.push(item); todos.append(row);
    };
    for (const saved of draft?.todos?.length ? draft.todos : [{}]) addTodo(saved);
    const addButton = el('button', 'mp-action', '＋ 添加待办'); addButton.type = 'button';
    addButton.onclick = () => { addTodo(); form.dispatchEvent(new Event('input')); };
    form.append(todos, addButton, el('p', 'eva-create-hint', '勾选待办不等于需求完成；代码变更和验证结果请填写在现状中，不确定的信息保留未知。'));
  } else if (editing) {
    add('agentUnderstanding', 'Agent 理解', 'textarea');
    add('scope', '范围', 'textarea');
    add('acceptanceCriteria', '验收条件', 'textarea');
    form.append(el('p', 'eva-create-hint', '保留原始用户原文，保存时使用打开表单时的记录版本；冲突后请先核对最新内容。'));
  } else {
    add('rawText', '需求说明 *', 'textarea', null, true);
    add('acceptanceCriteria', '验收条件', 'textarea');
    add('priority', '优先级', 'select', [['普通', '普通'], ['高', '高'], ['低', '低']]);
    if (agents.length) add('responsibleAgent', '负责 Agent', 'select', [['', '待确认'], ...agents.map(a => [a, a])]);
  }
  for (const [key, node] of Object.entries(fields)) {
    const value = draft?.values[key] ?? initial[key];
    if (value !== undefined && value !== null) node.value = String(value);
  }
  const error = el('p', 'eva-create-error');
  error.setAttribute('role', 'alert');
  const actions = el('div', 'eva-create-actions');
  const cancel = el('button', '', '取消');
  cancel.type = 'button';
  const save = el('button', 'mp-action mp-is-primary', editing ? '保存' : '创建');
  save.type = 'submit';
  const discard = el('button', '', '清除草稿并关闭'); discard.type = 'button';
  actions.append(discard, cancel, save);
  form.append(error, actions);
  dialog.append(form);
  const requestId = typeof draft?.requestId === 'string' ? draft.requestId : creationRequestId();
  let busy = false;
  let submitted = false;
  const values = () => Object.fromEntries(Object.entries(fields).map(([key, node]) => [key, node.value]));
  const original = JSON.stringify(values());
  let dirty = Boolean(draft);
  let stored = Boolean(draft);
  const persist = () => {
    dirty = Boolean(draft) || JSON.stringify(values()) !== original || handoff;
    if (!dirty) {
      try { if (draftKey) sessionStorage.removeItem(draftKey); } catch { /* Storage may be unavailable. */ }
      stored = false;
      return;
    }
    if (!draftKey) return;
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ requestId, values: values(),
        todos: todoRows.map(item => ({ text: item.text.value, requirement: item.picker.value() })),
        previous: previousPicker?.value() ?? null, supersede: supersede?.checked ?? false }));
      stored = true;
      const message = '草稿已保存在本浏览器标签页，尚未提交。';
      if (draftStatus.textContent !== message) draftStatus.textContent = message;
    } catch { stored = false; draftStatus.textContent = '浏览器无法保存草稿，请保持本窗口打开或复制内容。'; }
  };
  form.addEventListener('input', persist);
  form.addEventListener('change', persist);
  const close = () => {
    if (busy) return;
    if (dirty && !confirm(stored ? '关闭后会保留本标签页的草稿，是否关闭？' : '尚有未保存内容，关闭将放弃这些内容。是否关闭？')) return;
    dialog.close();
  };
  cancel.onclick = close;
  discard.onclick = () => {
    if (busy || !confirm('清除本表单草稿并关闭？此操作不会删除已保存的业务记录。')) return;
    try { if (draftKey) sessionStorage.removeItem(draftKey); } catch { /* Best effort. */ }
    dirty = false; dialog.close();
  };
  const beforeUnload = event => { if (dirty && !submitted) { event.preventDefault(); event.returnValue = ''; } };
  const beforeVisit = event => {
    if (busy) { event.preventDefault(); return; }
    if (dirty && !confirm(stored ? '离开页面？未提交草稿将保留在本标签页。' : '离开页面将放弃未保存内容，是否继续？')) event.preventDefault();
    else dialog.close();
  };
  window.addEventListener('beforeunload', beforeUnload);
  document.addEventListener('turbo:before-visit', beforeVisit);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => {
    window.removeEventListener('beforeunload', beforeUnload);
    document.removeEventListener('turbo:before-visit', beforeVisit);
    dialog.remove();
    if (focusBefore?.isConnected) focusBefore.focus();
  });
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    if (handoff && previousPicker.value()?.handoffState === '待接手' && !supersede.checked) {
      error.textContent = '这条工作线已有待接手交接。请明确勾选替换旧交接，或取消选择旧工作线。';
      error.scrollIntoView({ block: 'nearest' });
      return;
    }
    busy = true;
    error.textContent = '';
    save.disabled = cancel.disabled = true;
    const body = editing ? { title: fields.title.value } : { requestId, title: fields.title.value, visibility: fields.visibility.value };
    if (handoff) {
      body.sections = Object.fromEntries(['背景', '主线', '现状', '注意事项'].map(name => [name, fields[name].value]));
      body.todos = todoRows.filter(item => item.text.value.trim()).map(item => ({ text: item.text.value.trim(),
        ...(item.picker.value() ? { requirement: item.picker.value().workPackageId } : {}) }));
      if (previousPicker.value()) body.previous = previousPicker.value().id || String(previousPicker.value().workPackageId);
      body.supersede = supersede.checked && !supersede.disabled;
    } else if (editing) {
      for (const key of ['agentUnderstanding', 'scope', 'acceptanceCriteria']) body[key] = fields[key].value;
      if (fields.typeId) body.typeId = Number(fields.typeId.value);
    } else {
      Object.assign(body, { rawText: fields.rawText.value, acceptanceCriteria: fields.acceptanceCriteria.value,
        priority: fields.priority.value });
      if (fields.typeId) body.typeId = Number(fields.typeId.value);
      if (fields.responsibleAgent?.value) body.responsibleAgent = fields.responsibleAgent.value;
      if (parent) body.parent = parent.workPackageId;
    }
    persist();
    let result;
    try { result = await submit(body); }
    catch (failure) {
      error.textContent = failure.message;
      busy = false;
      save.disabled = cancel.disabled = false;
      return;
    }
    submitted = true; dirty = false;
    try { if (draftKey) sessionStorage.removeItem(draftKey); } catch { /* Best effort. */ }
    dialog.close();
    await created(result.item);
  };
  document.body.append(dialog);
  dialog.showModal();
  fields.title.focus();
}
