// Plays scenarios.mjs in headless Chrome over the DevTools protocol, with real mouse and
// key events, through the session proxy. Prints one line per scenario and exits non-zero
// when any fails.
//
// usage: node chrome.mjs <proxy origin> <query>
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIAGNOSE, fill, scenarios } from './scenarios.mjs';

const [base, query] = process.argv.slice(2);
if (!base || !query) {
  console.error('usage: node chrome.mjs <proxy origin> <query>');
  process.exit(2);
}
const CHROME = process.env.EVAPROJECT_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'evaproject-smoke-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let socket;
let nextId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const answer = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? 'script failed');
  return answer.result.value;
};
// A navigation replaces the page under a running evaluation; that is a "not yet".
const truthy = async expression => { try { return Boolean(await evaluate(expression)); } catch { return false; } };

async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page');
      if (page) {
        socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
        socket.addEventListener('message', event => {
          const message = JSON.parse(event.data);
          const waiting = message.id && pending.get(message.id);
          if (!waiting) return;
          pending.delete(message.id);
          if (message.error) waiting.reject(new Error(message.error.message)); else waiting.resolve(message.result);
        });
        return;
      }
    } catch { /* not listening yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

async function mouseAt(selector) {
  // A person scrolls to what they click; a point outside the window reaches nothing.
  const point = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null; node.scrollIntoView({ block: 'center' });
    const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!point) throw new Error(`没有 ${selector}`);
  const event = (type, extra = {}) => send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...extra });
  await event('mouseMoved', { y: point.y - 4 });
  await sleep(60);
  await event('mouseMoved');
  await sleep(200);
  await event('mousePressed', { button: 'left', clickCount: 1 });
  await sleep(80);
  await event('mouseReleased', { button: 'left', clickCount: 1 });
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }
};

async function play(scenario) {
  const vars = {};
  for (const step of scenario.steps) {
    const js = step.js ? fill(step.js, vars, { literal: true }) : '';
    switch (step.op) {
      case 'navigate':
        await send('Page.navigate', { url: base + fill(step.path, vars, { literal: false }) });
        await sleep(300);
        if (!await waitFor("document.readyState === 'complete'", 20000)) throw new Error('页面没有载入');
        break;
      case 'waitFor':
        if (!await waitFor(js, step.timeoutMs ?? 15000)) throw new Error(`等不到：${step.js.slice(0, 90)}`);
        break;
      case 'click': await mouseAt(step.selector); break;
      case 'type': await send('Input.insertText', { text: fill(step.text, vars, { literal: false }) }); break;
      case 'compose': {
        const text = fill(step.text, vars, { literal: false });
        await send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        break;
      }
      case 'commit': await send('Input.insertText', { text: fill(step.text, vars, { literal: false }) }); break;
      case 'key':
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...KEYS[step.key] });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEYS[step.key], text: undefined });
        await sleep(150);
        break;
      case 'remember': vars[step.name] = await evaluate(js); break;
      case 'expect': if (!await truthy(js)) throw new Error(`没做到：${step.label}`); break;
      case 'skipUnless': if (!await truthy(js)) return { skipped: step.reason }; break;
      case 'sleep': await sleep(step.ms); break;
      case 'viewport':
        await send('Emulation.setDeviceMetricsOverride', { width: step.width, height: step.height, deviceScaleFactor: 2, mobile: true });
        await sleep(300);
        break;
      default: throw new Error(`unknown op ${step.op}`);
    }
  }
  return {};
}

async function waitFor(js, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await truthy(js)) return true;
    await sleep(150);
  }
  return false;
}

let failures = 0;
try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  for (const scenario of scenarios(query)) {
    // Each scenario starts on a wide screen; a phone's sets its own size.
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    try {
      const { skipped } = await play(scenario);
      console.log(skipped ? `  - Chrome  ${scenario.name}（跳过：${skipped}）` : `  ✓ Chrome  ${scenario.name}`);
    } catch (error) {
      failures += 1;
      let state = '';
      try { state = await evaluate(DIAGNOSE); } catch { /* the page is gone */ }
      console.log(`  ✗ Chrome  ${scenario.name}：${error.message}\n      ${state}`);
    }
  }
} finally {
  socket?.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
