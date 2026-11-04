// The appearance control in the top bar.
//
// OpenProject already carries the preference and everything that acts on it: the layout
// turns it into the data attributes Primer reads, and the OS-following case is handled in
// its own frontend. So this is a second door to that preference, not a second mechanism —
// writing our own would have given the instance two ideas of what theme it is in.
//
// Everything is built as DOM nodes, and the control is re-inserted after a Turbo render
// the same way the module pages re-mount.

export const THEME_OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'sync_with_os', label: '跟随系统' }
];

/** The preference as the layout published it, falling back to light rather than to
 *  nothing: a control showing no selection at all reads as broken. */
export function currentTheme(dataset) {
  const value = dataset?.autoThemeSwitcherThemeValue;
  return THEME_OPTIONS.some(option => option.value === value) ? value : 'light';
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function svg(paths, size = 16) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('aria-hidden', 'true');
  for (const [d, attrs] of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    for (const [key, value] of Object.entries(attrs)) path.setAttribute(key, value);
    node.append(path);
  }
  return node;
}

// A circle with one half filled: the same idea as the control it was modelled on, and it
// reads as "appearance" rather than as "it is currently night".
const contrastIcon = () => svg([
  ['M8 1.25a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5Z',
   { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }],
  ['M8 2.75a5.25 5.25 0 0 0 0 10.5Z', { fill: 'currentColor' }]
]);

const checkIcon = () => svg([
  ['M13.78 4.22a.75.75 0 0 1 0 1.06l-6.5 6.5a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 1 1 1.06-1.06L6.75 10.19l5.97-5.97a.75.75 0 0 1 1.06 0Z',
   { fill: 'currentColor' }]
], 16);

async function choose(value) {
  const token = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
  const response = await fetch('/evaproject-theme', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(token ? { 'X-CSRF-Token': token } : {})
    },
    body: JSON.stringify({ theme: value })
  });
  if (!response.ok) throw new Error('主题没能保存');
  // A full reload rather than flipping the attributes here: the theme reaches stylesheets,
  // inline colour mappings and the logo variant, and half-applying it is worse than a
  // blink. Turbo would restore the old markup from its cache, so bypass it.
  window.location.reload();
}

function build(current) {
  const wrap = el('div', 'mp-appearance op-app-menu--item');

  const button = el('button', 'mp-appearance-button');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', '外观');
  button.title = '外观';
  button.append(contrastIcon());

  const menu = el('div', 'mp-appearance-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'menu');

  for (const option of THEME_OPTIONS) {
    const item = el('button', 'mp-appearance-option');
    item.type = 'button';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(option.value === current));
    const tick = el('span', 'mp-appearance-check');
    tick.append(checkIcon());
    item.append(tick, el('span', '', option.label));
    item.addEventListener('click', () => {
      if (option.value === current) { close(); return; }
      void choose(option.value).catch(() => { item.textContent = '保存失败'; });
    });
    menu.append(item);
  }

  function close() {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  button.addEventListener('click', event => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', close);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  menu.addEventListener('click', event => event.stopPropagation());

  wrap.append(button, menu);
  return wrap;
}

function mountLoginFooter() {
  if (!document.body.matches('.controller-account.action-login')) return;
  const form = document.querySelector('#login-form');
  if (!form || document.querySelector('.eva-login-footer')) return;
  const footer = el('footer', 'eva-login-footer');
  footer.append(
    el('p', 'eva-login-description', 'Eva Project · 让人与 Agent 共同推进每一个项目。'),
    el('p', 'eva-login-credit', 'Created by Brian Tan')
  );
  form.after(footer);
}

function mount() {
  mountLoginFooter();
  const end = document.querySelector('.op-app-header--end');
  if (!end || end.querySelector('.mp-appearance')) return;

  const control = build(currentTheme(document.body.dataset));
  // Immediately left of the avatar, which is the last button in the row — for a visitor
  // that slot holds 登录 ▾ instead, hidden on the login page itself. Appended at the end
  // if that button is ever not there, so the control never simply disappears.
  const avatar = end.querySelector(':scope > button.op-app-header--primer-button');
  if (avatar) end.insertBefore(control, avatar); else end.append(control);
}

if (typeof document !== 'undefined') {
  for (const event of ['turbo:load', 'turbo:render', 'DOMContentLoaded']) {
    document.addEventListener(event, mount);
  }
  mount();
}
