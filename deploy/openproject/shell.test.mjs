import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetHistory, forgetProject, rememberedProject, rememberProject, startingProject } from './assets/shell.js';

const visible = [{ identifier: 'eva-project' }, { identifier: 'mila-3' }];

// #181: whatever was chosen on the pool, the handoff page opened on Eva-Project.
test('a page starts on the project last chosen on either page', () => {
  assert.equal(startingProject({ fromAddress: '', remembered: 'mila-3', visible, fallback: 'eva-project' }), 'mila-3');
});

test('a link that names a project still wins over what was remembered', () => {
  assert.equal(startingProject({ fromAddress: 'eva-project', remembered: 'mila-3', visible, fallback: '' }), 'eva-project');
});

test('a remembered project this person can no longer see is not reopened', () => {
  assert.equal(startingProject({ fromAddress: '', remembered: 'gone', visible, fallback: 'eva-project' }), 'eva-project');
});

test('with nothing ever chosen, each page keeps its own default', () => {
  assert.equal(startingProject({ fromAddress: '', remembered: '', visible, fallback: 'eva-project' }), 'eva-project');
  assert.equal(startingProject({ fromAddress: '', remembered: '', visible }), '');
});

test('the choice is kept in this browser, and a browser that refuses storage is no failure', () => {
  const saved = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, String(value)); }
  };
  try {
    rememberProject('mila-3');
    assert.equal(rememberedProject(), 'mila-3');
    rememberProject('');
    assert.equal(rememberedProject(), 'mila-3', 'an empty choice does not erase the last one');

    globalThis.localStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); }
    };
    assert.doesNotThrow(() => rememberProject('mila-3'));
    assert.equal(rememberedProject(), '');
  } finally {
    globalThis.localStorage = saved;
  }
});

// #184: after going back to every project, a reload carried the reader straight back into
// the project they had just left.
test('going back to every project forgets the one chosen, so the project list survives a reload', () => {
  const saved = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: key => { store.delete(key); }
  };
  try {
    rememberProject('mila-3');
    forgetProject();
    assert.equal(startingProject({ fromAddress: '', remembered: rememberedProject(), visible }), '');

    globalThis.localStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); }
    };
    assert.doesNotThrow(() => forgetProject());
  } finally {
    globalThis.localStorage = saved;
  }
});

// EVAPROJECT-REQ-20260928-002: on a phone the detail is a sheet over the list, and back — the
// button or the swipe from the screen's edge — has to close it, not leave the page, and not
// have Turbo draw the list again (on an iPhone that lost the reader's place in it).
function browser({ narrow }) {
  const entries = [{ state: { turbo: { restorationIdentifier: 'list' } } }];
  let at = 0;
  const listeners = [];
  const seen = { turboVisits: 0, reloads: 0 };
  // Turbo's own listener, registered first: a return to one of its entries is a visit that
  // draws the page again; an entry without its state it only takes over.
  listeners.push(event => {
    if (event.state?.turbo) seen.turboVisits += 1;
    else entries[at].state = { turbo: { restorationIdentifier: 'taken-over' } };
  });
  const pop = () => { const state = entries[at].state; for (const listener of listeners) listener({ state }); };
  return {
    seen,
    entries: () => entries.length,
    window: {
      matchMedia: () => ({ matches: narrow }),
      addEventListener: (type, listener) => { if (type === 'popstate') listeners.push(listener); }
    },
    history: {
      get state() { return entries[at].state; },
      pushState(state) { entries.splice(at + 1); entries.push({ state }); at += 1; },
      replaceState(state) { entries[at].state = state; },
      back() { at -= 1; pop(); },
      forward() { at += 1; pop(); }
    },
    location: { reload() { seen.reloads += 1; } }
  };
}

function withBrowser(fake, run) {
  const saved = { window: globalThis.window, history: globalThis.history, location: globalThis.location };
  globalThis.window = fake.window;
  globalThis.history = fake.history;
  globalThis.location = fake.location;
  try { run(); } finally {
    globalThis.window = saved.window;
    globalThis.history = saved.history;
    globalThis.location = saved.location;
  }
}

test('on a narrow screen back closes the sheet and leaves the list where it was', () => {
  const fake = browser({ narrow: true });
  withBrowser(fake, () => {
    let closed = 0;
    const sheet = createSheetHistory({ page: 'pool', onClose: () => { closed += 1; }, present: () => true });
    sheet.opened();
    assert.equal(fake.entries(), 2);
    sheet.opened();
    assert.equal(fake.entries(), 2, 'another record opened inside the sheet reuses the entry');
    fake.history.back();
    assert.equal(closed, 1);
    assert.equal(fake.seen.turboVisits, 0, 'the list is not drawn again');
    assert.equal(fake.seen.reloads, 0);

    sheet.opened();
    assert.equal(fake.entries(), 2, 'opening again replaces the entry going back left behind');
    fake.history.back();
    assert.equal(closed, 2);
    assert.equal(fake.seen.turboVisits, 0);
  });
});

test('the sheet\'s own 返回列表 goes back through its entry, so back and 返回列表 cannot disagree', () => {
  const fake = browser({ narrow: true });
  withBrowser(fake, () => {
    let closed = 0;
    const sheet = createSheetHistory({ page: 'pool', onClose: () => { closed += 1; }, present: () => true });
    sheet.opened();
    sheet.close();
    assert.equal(closed, 1);
    assert.equal(fake.history.state.mpSheet, undefined, 'back on the list\'s own entry');
    assert.equal(fake.seen.turboVisits, 0);
  });
});

test('arriving at one of these entries with another page on screen loads this page afresh', () => {
  const fake = browser({ narrow: true });
  withBrowser(fake, () => {
    let onScreen = true;
    const sheet = createSheetHistory({ page: 'pool', onClose: () => {}, present: () => onScreen });
    sheet.opened();
    // A link followed from inside the sheet: another page, then back to the sheet's entry.
    fake.history.pushState({ turbo: { restorationIdentifier: 'other' } });
    onScreen = false;
    fake.history.back();
    assert.equal(fake.seen.reloads, 1);
  });
});

test('a wide screen adds no history entry and closes the panel directly, as before', () => {
  const fake = browser({ narrow: false });
  withBrowser(fake, () => {
    let closed = 0;
    const sheet = createSheetHistory({ page: 'pool', onClose: () => { closed += 1; }, present: () => true });
    sheet.opened();
    assert.equal(fake.entries(), 1);
    assert.ok(fake.history.state.turbo, 'the page\'s own entry is left as it was');
    sheet.close();
    assert.equal(closed, 1);
    assert.equal(fake.entries(), 1);
  });
});
