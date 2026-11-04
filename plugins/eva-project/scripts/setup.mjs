import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configPath, loadConnection, saveConnection, validateConnection, validateEndpoint, isPrivateHost, inspectConnection } from './connection.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(source, '.codex-plugin/plugin.json'), 'utf8')).version;
const args = process.argv.slice(2), command = args.shift();
const option = key => { const at = args.indexOf(key); return at < 0 ? undefined : args[at + 1]; };
const run = (bin, argv) => {
  const result = spawnSync(bin, argv, { stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error(`${bin} failed. Install/update that client, then rerun install.`);
};
async function hiddenToken() {
  if (!process.stdin.isTTY) throw new Error('Run configure in your terminal, or use --token-stdin with a protected local file.');
  process.stderr.write('Personal Eva MCP token (hidden): ');
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stderr.write('\n'); error ? reject(error) : resolve(value); };
    const onData = chunk => {
      for (const c of chunk) {
        if (c === '\u0003') { finish(new Error('Cancelled.')); return; }
        if (c === '\r' || c === '\n') { finish(); return; }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1); else value += c;
      }
    };
    process.stdin.on('data', onData);
  });
}
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  if (command === 'connect') {
    const old = existsSync(configPath()) ? loadConnection() : null;
    const allowPrivateHttp = args.includes('--allow-private-http') || old?.allowPrivateHttp === true;
    const url = validateEndpoint(option('--server') || old?.url || '', { allowPrivateHttp });
    const client = option('--client') === 'generic' ? 'Generic Agent' : option('--client') === 'claude' ? 'Claude Code' : 'Codex';
    const request = async (name, body) => {
      const target = new URL(url); target.pathname = target.pathname.replace(/\/mcp$/, `/agent-connect/${name}`);
      let response;
      try { response = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
      catch { throw new Error('Cannot reach Eva. Check the service URL and network.'); }
      if (!response.ok) throw new Error(response.status === 410 ? 'Connection expired or was denied. Run connect again.' : `Connection request failed (HTTP ${response.status}).`);
      return response.json();
    };
    const started = await request('start', { client });
    const verification = new URL(started.verification_uri);
    if (verification.protocol !== 'https:' && !(verification.protocol === 'http:' && (['localhost', '127.0.0.1', '[::1]'].includes(verification.hostname) || (allowPrivateHttp && isPrivateHost(verification.hostname))))) throw new Error('Eva returned an insecure authorization page.');
    console.log(`Open this Eva page and confirm the matching code: ${started.user_code}\n${verification.href}`);
    if (!args.includes('--no-open')) {
      const opener = process.platform === 'darwin' ? ['open', [verification.href]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', verification.href]] : ['xdg-open', [verification.href]];
      spawnSync(opener[0], opener[1], { stdio: 'ignore', shell: false });
    }
    const deadline = Date.now() + Math.min(started.expires_in, 600) * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const result = await request('token', { device_code: started.device_code });
      if (result.status === 'pending') continue;
      if (result.status !== 'connected') throw new Error('Connection was not approved.');
      const config = validateConnection({ url, token: result.token, allowPrivateHttp });
      const info = await inspectConnection(config);
      saveConnection(config);
      console.log(JSON.stringify({ ok: true, saved: configPath(), ...info }, null, 2));
      return;
    }
    throw new Error('Connection request expired. Run connect again.');
  } else if (command === 'configure') {
    const old = existsSync(configPath()) ? loadConnection() : null;
    const url = option('--server') || old?.url;
    if (!url) throw new Error('Pass --server https://YOUR-EVA-HOST/mcp.');
    const token = args.includes('--token-stdin') ? readFileSync(0, 'utf8').trim() : await hiddenToken();
    const config = validateConnection({ url, token, allowPrivateHttp: args.includes('--allow-private-http') || old?.allowPrivateHttp === true });
    const result = await inspectConnection(config);
    saveConnection(config);
    console.log(JSON.stringify({ ok: true, saved: configPath(), ...result }, null, 2));
  } else if (command === 'doctor') {
    console.log(JSON.stringify({ ok: true, ...await inspectConnection(loadConnection()) }, null, 2));
  } else if (command === 'install') {
    const client = option('--client');
    if (!['codex', 'claude', 'both', 'generic'].includes(client)) throw new Error('Use --client codex|claude|both|generic.');
    const root = resolve(option('--destination') || join(homedir(), '.local/share/eva-project/marketplace'));
    const target = join(root, 'plugins/eva-project');
    if (target === source || source.startsWith(target + '/')) throw new Error('Choose an installation directory separate from the source package.');
    if (existsSync(target) && JSON.parse(readFileSync(join(target, '.codex-plugin/plugin.json'), 'utf8')).name !== 'eva-project') throw new Error('Destination belongs to another plugin.');
    mkdirSync(target, { recursive: true });
    for (const name of ['.codex-plugin', '.claude-plugin', 'skills', 'scripts', 'assets', 'templates', 'README.md']) cpSync(join(source, name), join(target, name), { recursive: true });
    // An absolute local entry point works in both clients and GUI-launched sessions.
    // Personal connection details live outside this install tree and survive updates.
    writeFileSync(join(target, '.mcp.json'), JSON.stringify({ mcpServers: { 'eva-project': { command: process.execPath, args: [join(target, 'scripts/mcp.mjs')] } } }, null, 2) + '\n');
    mkdirSync(join(root, '.agents/plugins'), { recursive: true }); mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'eva-project', interface: { displayName: 'Eva Project' }, plugins: [{ name: 'eva-project', source: { source: 'local', path: './plugins/eva-project' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }, null, 2));
    writeFileSync(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'eva-project', owner: { name: 'Brian Tan' }, plugins: [{ name: 'eva-project', source: './plugins/eva-project', description: 'Eva requirements and handoffs', version }] }, null, 2));
    if (client === 'generic') {
      console.log(JSON.stringify({ prepared: target, mcp: JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8')), skills: join(target, 'skills'), next: `node "${join(target, 'scripts/setup.mjs')}" connect --server <Eva-MCP-URL> --client generic` }, null, 2));
      return;
    }
    if (args.includes('--prepare-only')) { console.log(JSON.stringify({ prepared: root, plugin: target })); return; }
    if (client === 'codex' || client === 'both') {
      const listed = spawnSync('codex', ['plugin', 'marketplace', 'list'], { encoding: 'utf8', shell: false });
      if (listed.error || listed.status !== 0) throw new Error('Cannot inspect Codex marketplaces; check the Codex CLI.');
      const existing = listed.stdout.split('\n').find(line => /^eva-project\s/.test(line));
      if (existing && resolve(existing.replace(/^eva-project\s+/, '').trim()) !== root) throw new Error('Codex already has an Eva marketplace at another location. Review it before replacing it.');
      if (!existing) run('codex', ['plugin', 'marketplace', 'add', root]);
      run('codex', ['plugin', 'add', 'eva-project@eva-project']);
    }
    if (client === 'claude' || client === 'both') {
      const listed = spawnSync('claude', ['plugin', 'marketplace', 'list', '--json'], { encoding: 'utf8', shell: false });
      if (listed.error || listed.status !== 0) throw new Error('Cannot inspect Claude Code marketplaces; check the Claude CLI.');
      const existing = JSON.parse(listed.stdout).find(item => item.name === 'eva-project');
      if (existing && resolve(existing.installLocation || existing.path || '') !== root) throw new Error('Claude Code already has an Eva marketplace at another location. Review it before replacing it.');
      if (!existing) run('claude', ['plugin', 'marketplace', 'add', root]);
      const installed = spawnSync('claude', ['plugin', 'list', '--json'], { encoding: 'utf8', shell: false });
      if (installed.error || installed.status !== 0) throw new Error('Cannot inspect installed Claude Code plugins.');
      const present = JSON.parse(installed.stdout).some(item => item.id === 'eva-project@eva-project');
      run('claude', ['plugin', present ? 'update' : 'install', 'eva-project@eva-project', '--scope', 'user']);
    }
    console.log(`Installed Eva Project. Configure your connection with:\nnode "${join(target, 'scripts/setup.mjs')}" connect --server <Eva-MCP-URL> --client ${client === 'claude' ? 'claude' : 'codex'}\nThen open a new client session and run doctor.`);
  } else {
    console.log('Usage: node scripts/setup.mjs install --client codex|claude|both|generic\n       node scripts/setup.mjs connect --server <URL> --client codex|claude|generic [--no-open]\n       node scripts/setup.mjs configure --server <URL> [--token-stdin]\n       node scripts/setup.mjs doctor');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
