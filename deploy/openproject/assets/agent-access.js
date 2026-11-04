const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
export function installPrompt({ client, server, archive, sha256, version }) {
  const label = client === 'claude' ? 'Claude Code' : 'Codex';
  const host = new URL(server);
  const lanFlag = host.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) ? ' --allow-private-http' : '';
  if (client === 'generic') return `请帮当前 Agent 接入 Eva Project ${version}。先确认本客户端实际支持的 MCP、Skill 和规范加载方式，再使用它自己的配置入口。

1. 从 ${archive} 下载官方包，校验 SHA-256：${sha256}，解压并阅读 README.md 和安装脚本。
2. 若可运行 Node.js 22+，执行 node <解压目录>/scripts/setup.mjs install --client generic。它只准备文件并输出 MCP stdio 配置，不注册 Codex 或 Claude Code。把输出的 eva-project 配置合并到当前客户端的 MCP 配置，保留其他服务。
3. 执行 node <解压目录>/scripts/setup.mjs connect --server ${server} --client generic${lanFlag}。把授权页和配对码交给我，让我在自己的浏览器登录并确认；Token 由安装器保存，不在对话中提供。
4. 按本客户端支持的机制加载包内 skills。若不支持插件、stdio 或 Skills 自动发现，说明限制和需要用户完成的步骤，不声称已经完成。工具参数遵循服务返回的合同，不冒用其他 Agent 身份。
5. 执行 doctor 核对身份和项目。说明 templates/global-guidelines.md 应合并到哪个实际全局规范文件；项目缺少 Eva project_id 时先问我是否创建或接入，确认后查重、创建或复用，并将返回的 Eva project_id 与 Eva identifier 一起合并到项目规范，保留原内容。
6. 在新会话中实际调用 eva_connection_info、requirements_projects，报告连接、Skills 和规范是否加载成功。
本次仅配置接入，不改动业务数据。`;
  return `请帮我在 ${label} 安装 Eva Project Plugin ${version}，连接我的 Eva 账号。\n\n1. 从 ${archive} 下载官方插件包，确认 SHA-256 为 ${sha256}，解压并阅读 README.md 和安装脚本。\n2. 确认已安装 Node.js 22+ 和 ${label} CLI，执行 node <解压目录>/scripts/setup.mjs install --client ${client}。保留已有个人配置。\n3. 执行 node <解压目录>/scripts/setup.mjs connect --server ${server} --client ${client}${lanFlag}。把返回的 Eva 授权页与配对码交给我，让我在自己的浏览器登录并确认；等待连接完成。\n4. Token 由安装器保存到本机，不需要我在对话中提供。未配置 MCP 身份时提示我联系管理员。\n5. 执行 doctor，报告当前 Eva 身份和可访问项目。询问我使用哪个项目。\n6. 向我说明插件、全局规范与项目规范的分工。使用包内 templates/global-guidelines.md 合并客户端实际加载的全局约定，保留已有内容；使用 templates/project-guidelines.md，项目缺少 Eva project_id 时先询问我是否创建或接入，确认后查重、创建或复用，并把返回的 Eva project_id 与 Eva identifier 一起写入项目 AGENTS.md。已有其他管理系统绑定时先确认，不自动改绑。\n7. 提示开启新会话，调用 eva_connection_info、requirements_projects 核对身份和项目，并确认全局约定、项目绑定与 Skills 均已加载；仅在明确绑定 Eva 的项目中按约定自动协作。\n本次配置接入，未经我确认不创建业务项目，不改动其他业务数据。遇到客户端权限提示或缺少安装条件时，说明需要我完成的具体步骤。`;
}
async function json(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) {
    if (data.needsToken) throw new Error('你的账号尚未开通 Agent 接入，请联系管理员预设 MCP Token。');
    if (response.status === 401) throw new Error('登录已过期，请重新登录后打开安装器提供的授权页。');
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}
export function globalGuidelinesLocation(client) {
  if (client === 'generic') return '当前 Agent 实际加载的用户级规范文件';
  return client === 'claude' ? '~/.claude/CLAUDE.md' : '~/.codex/AGENTS.md';
}
async function copyText(area, status) {
  try { await navigator.clipboard.writeText(area.value); status.textContent = '已复制。'; }
  catch {
    area.closest('details')?.setAttribute('open', '');
    area.focus(); area.select();
    status.textContent = document.execCommand('copy') ? '已复制。' : '请复制已选中的内容。';
  }
}
function guidelines(root, clientSelect) {
  const globalSection = el('section', '', 'eva-guidelines');
  globalSection.append(el('h2', '2. 配置全局规范'), el('p', '每个 Agent 配置一次，规定何时自动使用 Eva。只在明确绑定 Eva 的项目生效。', 'eva-agent-help'));
  const locationHint = el('p', '', 'eva-agent-help');
  const update = () => { locationHint.textContent = `合并到 ${globalGuidelinesLocation(clientSelect.value)}，保留已有内容。若配置目录或全局覆盖文件有调整，以客户端实际加载的文件为准。`; };
  clientSelect.addEventListener('change', update);update();globalSection.append(locationHint);
  const projectSection = el('section', '', 'eva-guidelines');
  projectSection.append(el('h2', '3. 配置项目规范'), el('p', '每个项目配置一次。项目中没有 Eva project_id 时，Agent 先询问你是否创建或接入。确认后回填同一项目的数字 ID（Eva project_id）和稳定标识（Eva identifier），再合并业务与环境约定，保留原有规范。', 'eva-agent-help'), el('p', 'Claude Code 若没有加载 AGENTS.md，可在同目录的 CLAUDE.md 中加入 @AGENTS.md，保留其他内容。项目文件不需要复制全局约定。', 'eva-agent-help'));
  root.append(globalSection, projectSection);
  for (const [section, url, title] of [[globalSection, '/evaproject/agent-plugin/global-guidelines.md?v=371f4a0fe3', '全局规范'], [projectSection, '/evaproject/agent-plugin/project-guidelines.md?v=519919af33', '项目规范']]) {
    const controls = el('div', '', 'eva-agent-actions'), button = el('button', `复制${title}`), download = el('a', '下载范本');
    download.href = url;download.download = new URL(url, location.origin).pathname.split('/').pop();button.disabled = true;
    controls.append(button, download);section.append(controls);
    const details = el('details'), summary = el('summary', `查看${title}范本`), area = el('textarea');
    area.readOnly = true; area.rows = 12;area.setAttribute('aria-label', `${title}范本`);details.append(summary, area);section.append(details);
    const status = el('p');status.setAttribute('role', 'status');section.append(status);
    fetch(download.href).then(async response => {
      if (!response.ok) throw new Error();area.value = await response.text();button.disabled = false;
    }).catch(() => { status.textContent = '范本暂时不可用，请刷新后重试。'; });
    button.addEventListener('click', () => copyText(area, status));
  }
  const verification = el('section', '', 'eva-guidelines');
  verification.append(el('h2', '4. 验证自动协作'), el('p', '开启新会话，让 Agent 报告已加载的全局规范、当前 Eva 账号与项目绑定。已绑定项目中的明确新需求会触发查重、登记和执行；交接按用户指令触发。未记录项目 ID 时先询问是否接入，未获同意继续原流程；部署等操作仍按用户授权。', 'eva-agent-help'));
  root.append(verification);
}
async function mount() {
  const root = document.querySelector('#eva-agent-access');
  if (!root || root.dataset.mounted) return;
  root.dataset.mounted = '1';
  root.append(el('h1', 'Agent 接入'), el('p', '安装 Eva Project Plugin，让你的 Agent 使用需求与交接。', 'eva-agent-intro'));
  const code = new URLSearchParams(location.search).get('code') || root.dataset.code;
  if (code) {
    const approval = el('section', '', 'eva-agent-approval'); root.append(approval);
    try {
      const info = await json(`/agent-access/api/request?code=${encodeURIComponent(code)}`);
      approval.append(el('h2', '确认连接'), el('p', `${info.client} 正在请求连接账号：${info.identity.displayName}（${info.identity.userId}）`), el('strong', info.code, 'eva-agent-code'), el('p', '请确认此码与安装器显示的一致。确认后，这台设备将获得你已有的 MCP 权限。'));
      const actions = el('div', '', 'eva-agent-actions'), status = el('p'); status.setAttribute('role', 'status');
      const approve = el('button', '允许连接', 'eva-agent-primary'), deny = el('button', '取消');
      for (const [button, operation] of [[approve, 'approve'], [deny, 'deny']]) button.addEventListener('click', async () => {
        approve.disabled = deny.disabled = true;
        try {
          await json(`/agent-access/api/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || '' }, body: JSON.stringify({ code: info.code }) });
          status.textContent = operation === 'approve' ? '已允许连接，请回到安装器查看结果。' : '已取消连接。';
        } catch (error) { status.textContent = error.message; approve.disabled = deny.disabled = false; }
      });
      if (info.approved) { approve.disabled = deny.disabled = true; status.textContent = '已确认，请回到安装器领取连接结果。'; }
      actions.append(approve, deny); approval.append(actions, status);
    } catch (error) { approval.append(el('p', error.message, 'eva-agent-error')); }
  }
  const server = root.dataset.mcpUrl;
  if (!server) { root.append(el('p', '管理员尚未配置 Agent 服务地址，请配置后再安装。')); return; }
  root.append(el('h2', '1. 安装插件与连接账号'));
  const controls = el('div', '', 'eva-agent-actions eva-agent-install-actions'), select = el('select', '', 'eva-agent-select');
  select.setAttribute('aria-label', '接入客户端');
  for (const [value, text] of [['codex', 'Codex'], ['claude', 'Claude Code'], ['generic', '通用 Agent']]) { const option = el('option', text); option.value = value; select.append(option); }
  const copy = el('button', '复制安装提示词', 'eva-agent-primary'); copy.disabled = true;
  const download = el('a', '下载插件包'); download.href = '/evaproject/agent-plugin/eva-project.zip?v=a5123d06d3'; download.download = 'eva-project.zip';
  controls.append(select, copy, download);root.append(controls);
  const prompt = el('textarea');prompt.readOnly = true;prompt.rows = 13;prompt.setAttribute('aria-label', '安装提示词');root.append(prompt);
  const status = el('p'); status.setAttribute('role', 'status'); root.append(status);
  root.append(el('p', '把提示词复制给你的 Agent。安装器会引导你登录 Eva 确认连接，无需在对话里发送 Token。', 'eva-agent-help'));
  if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(server).hostname)) root.append(el('p', '当前为本机调试地址，只能在运行 Eva 的这台电脑上接入。外网服务部署后，管理员会更新接入地址。', 'eva-agent-help'));
  if (new URL(server).protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(server).hostname)) root.append(el('p', '当前为局域网 HTTP 调试连接，提示词已带上仅用于私有网络测试的选项。正式外网部署使用 HTTPS。', 'eva-agent-help'));
  try {
    const release = await json('/evaproject/agent-plugin/release.json?v=7aae463ce4');
    const update = () => { prompt.value = installPrompt({ client: select.value, server, archive: new URL(download.href).href, sha256: release.sha256, version: release.version }); };
    select.addEventListener('change', update);update();copy.disabled = false;
    copy.addEventListener('click', async () => {
      await copyText(prompt, status);
    });
  } catch { status.textContent = '插件包尚未准备好，请联系管理员。'; }
  guidelines(root, select);
}
if (typeof document !== 'undefined') {
  for (const event of ['DOMContentLoaded', 'turbo:load', 'turbo:render']) document.addEventListener(event, mount);
  mount();
}
