// The pipeline both module pages run on, shared once there were two of them.
//
// Extracted now rather than when the handoff page went live: a shell pulled out while it
// had one consumer is what left the earlier "reusable" layer covering almost nothing, so
// the agreement was to wait for a second consumer and let it say what is actually common.
// It turned out to be the notice strip, the fetch wrapper and the conflict guard — the
// two pages' bodies (a card stream with progress, a hierarchical table) stayed different
// all the way down, which is why only this much is here.
//
// Everything is built as DOM nodes from text, so nothing an author wrote is ever
// interpreted as HTML.

export const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * What stands in for data on its way: a turning ring beside a word, so a long load reads
 * as one still going (Brian 2026-09-24, #209). A status, so a screen reader says it too.
 * Each page draws it under its own root.
 */
export function loadingNode(label = '载入中…') {
  const node = el('div', 'mp-loading');
  node.setAttribute('role', 'status');
  const ring = el('span', 'mp-loading-ring');
  ring.setAttribute('aria-hidden', 'true');
  node.append(ring, el('span', 'mp-loading-label', label));
  return node;
}

/**
 * The project both module pages are on, carried from one to the other.
 *
 * The pool kept its project in its own address and the handoff page in a dropdown that
 * remembered nothing, so going from either to the other landed on the server's default,
 * Eva-Project, whatever had been chosen (Brian 2026-09-23, #181). Now a project chosen on
 * either page — picked, opened by a link that names it, or entered through a project's
 * own menu — is remembered, and the other page starts there. Per browser, like the
 * column widths: where someone was looking, not data. Guarded, because a private window
 * refuses storage, and a page that cannot remember is still usable.
 */
const PROJECT_KEY = 'evaproject.project';

export function rememberedProject() {
  try {
    return localStorage.getItem(PROJECT_KEY) || '';
  } catch {
    return '';
  }
}

export function rememberProject(identifier) {
  if (!identifier) return;
  try {
    localStorage.setItem(PROJECT_KEY, identifier);
  } catch {
    // Not remembered; the page itself is unaffected.
  }
}

/**
 * Going back to every project is a choice too: no project. Keeping the old one meant a
 * reload of the project list carried the reader straight back into the project they had
 * just left (Brian 2026-09-23, #184).
 */
export function forgetProject() {
  try {
    localStorage.removeItem(PROJECT_KEY);
  } catch {
    // Not forgotten; the page itself is unaffected.
  }
}

/**
 * Which project a page opened without one in its route starts on. A link that names a
 * project wins; then the one last chosen, if this person can still see it; then whatever
 * the page did before anything was chosen.
 */
export function startingProject({ fromAddress, remembered, visible, fallback = '' }) {
  if (fromAddress) return fromAddress;
  if (remembered && (visible ?? []).some(project => project.identifier === remembered)) return remembered;
  return fallback;
}

/**
 * A narrow screen: a phone, or a window too narrow for a list with its detail beside it.
 * The module pages then lay the detail over the list as a sheet (EVAPROJECT-REQ-20260928-002).
 * The same width the stylesheets switch at.
 */
export const COMPACT = '(max-width: 900px)';

export function isCompact() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(COMPACT).matches;
}

/**
 * The sheet and the browser's back.
 *
 * On a phone, back — the button, or the swipe in from the screen's left edge — is how a
 * view laid over another is closed, and without an entry of its own it left the page with
 * the sheet still open. So a sheet opened on a narrow screen adds one entry, going back
 * from it closes the sheet, and the sheet's own 返回列表 goes back through that entry, so
 * the two never disagree. Another record opened inside the sheet reuses the entry: back
 * always returns to the list. Wide screens add no entry and behave as they did.
 *
 * Neither the sheet's entry nor the list's beneath it carries Turbo's state. Turbo takes a
 * return to an entry of its own as a visit and draws the page again — on an iPhone, back
 * reloaded the whole list and lost the reader's place in it — while an entry without its
 * state it only takes note of. When the page on screen is not this one on arriving at such
 * an entry (a link followed from the sheet, and back), it is loaded afresh.
 *
 * `page` names the page, so each page answers only for its own entries; `present` says
 * whether that page is the one on screen.
 */
export function createSheetHistory({ page, onClose, present }) {
  const onSheet = () => history.state?.mpSheet === page;
  let listening = false;
  const listen = () => {
    if (listening) return;
    listening = true;
    window.addEventListener('popstate', event => {
      const state = event.state ?? {};
      if ((state.mpSheet === page || state.mpList === page) && !present()) {
        location.reload();
        return;
      }
      if (state.mpSheet !== page) onClose();
    });
  };
  return {
    opened() {
      if (!isCompact() || onSheet()) return;
      listen();
      history.replaceState({ mpList: page }, '');
      history.pushState({ mpSheet: page }, '');
    },
    close() {
      if (onSheet()) history.back();
      else onClose();
    }
  };
}

/** The bar across the top of a sheet, with the way back to the list. */
export function sheetBar(onBack) {
  const bar = el('div', 'mp-sheet-bar');
  const back = el('button', 'mp-sheet-back');
  back.type = 'button';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({
    viewBox: '0 0 16 16', width: '18', height: '18', 'aria-hidden': 'true', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
  })) svg.setAttribute(name, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M10 3 5 8l5 5');
  svg.append(path);
  back.append(svg, el('span', '', '返回列表'));
  back.onclick = onBack;
  bar.append(back);
  return bar;
}

/**
 * Binds the pipeline to one page.
 *
 * The context is read through functions rather than copied in, because every one of these
 * changes after mount: the root element appears when the page mounts, the project changes
 * when someone picks another one, and the CSRF token is read off the document. Passing
 * values would freeze whatever happened to be true at import time.
 */
export function createShell(context) {
  let noticeNode = null;
  let noticeTimer = null;

  function notify(message, kind) {
    clearTimeout(noticeTimer);
    // Turbo swaps the page out and mount() runs again against a fresh root, so a node
    // kept from last time is detached and prepending to it shows the person nothing.
    // Checking that it is still in the document beats asking every caller to remember a
    // reset on mount — which is exactly what both pages used to do by hand.
    if (noticeNode && !noticeNode.isConnected) noticeNode = null;
    if (!noticeNode) {
      noticeNode = el('div', 'mp-notice');
      noticeNode.setAttribute('role', 'alert');
      // On a narrow screen the notice floats at the bottom, over a sheet if one is open,
      // where a tap puts it away; a wide screen keeps it in the page as before.
      const node = noticeNode;
      node.onclick = () => { if (isCompact()) node.hidden = true; };
      context.root().prepend(noticeNode);
    }
    noticeNode.textContent = message;
    noticeNode.classList.toggle('mp-is-error', kind === 'error');
    noticeNode.hidden = false;
    // An error stays until something replaces it. Floating over what is being read, it
    // also leaves on its own, after long enough to be read.
    const stay = kind !== 'error' ? 4000 : isCompact() ? 8000 : 0;
    if (stay) noticeTimer = setTimeout(() => { noticeNode.hidden = true; }, stay);
  }

  function clearNotice() {
    clearTimeout(noticeTimer);
    if (noticeNode) noticeNode.hidden = true;
  }

  /**
   * One request against the page's own API, through the controller that forwards the
   * session cookie.
   *
   * `cache: no-store` is not optional. A record edited elsewhere has to show up on the
   * next load, and without it the browser happily serves the previous answer for the same
   * query string — the list then lags behind the pool it is meant to be showing, silently
   * and only sometimes, which is the worst way for it to be wrong.
   */
  async function request(path, { params, failure = '请求失败', ...options } = {}) {
    const url = new URL(context.apiBase() + path, location.origin);
    const project = context.project();
    // A modal may outlive a project switch. Its captured project takes precedence
    // over the currently displayed one, including when it is the empty scope.
    if (project && !(params ?? []).some(([key]) => key === 'project')) url.searchParams.set('project', project);
    for (const [key, value] of params ?? []) url.searchParams.append(key, value);

    const csrfToken = context.csrfToken();
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
      },
      ...options
    });

    let payload = {};
    try { payload = await response.json(); } catch { /* fall back to the status */ }
    if (!response.ok) {
      const error = new Error(payload.error || (failure + ' (' + response.status + ')'));
      // A refused save and a missing token are told apart by the caller, so both travel
      // whichever page threw them.
      error.conflict = payload.conflict === true;
      error.needsToken = payload.needsToken === true;
      throw error;
    }
    return payload;
  }

  const post = (path, body, failure = '保存失败') =>
    request(path, { method: 'POST', body: JSON.stringify(body), failure });

  /**
   * A refused save means someone changed the record first. Reload rather than retry, so
   * the person edits what is actually stored.
   */
  async function guarded(run, onConflict) {
    const container = context.root(), project = context.project();
    try {
      clearNotice();
      await run();
    } catch (error) {
      if (context.root() !== container || !container?.isConnected || context.project() !== project) return;
      if (error.conflict) {
        notify(error.message + '（已载入最新内容，请重新确认后再保存）', 'error');
        await onConflict();
        return;
      }
      notify(error.message, 'error');
    }
  }

  return { notify, clearNotice, request, post, guarded };
}
