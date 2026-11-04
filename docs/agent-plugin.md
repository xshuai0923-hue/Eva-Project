# Eva Project Agent 接入

> 现行用户操作请先读 [用户功能手册](eva-user-guide-2026-11-04.md)。本文保留安装机制与历次联调环境；后文“当前开发机”“当前联调入口”等小节记录的是当时阶段，不能替代本次会话核验。2026-11-04 已按用户明确授权在本机 Codex 安装并连接插件，仓库仍使用 M-Project；具体绑定以项目 AGENTS.md 为准，不自动迁移数据。

首期支持 Codex 与 Claude Code，本地插件版本 0.1.5。核心包在 `plugins/eva-project`，两种客户端各有自己的插件清单，共用四个 Skills 和本机 MCP 连接器。账号和权限仍由 Eva 服务端管理。

## 用户流程

首页右上角「Agent 接入」→ 选择客户端 → 复制安装提示词给自己的 Agent。页面提供无需访问私有代码仓的插件包下载和 SHA-256。

安装器检查 Node.js 22+，把插件安装到用户的 Eva 专用目录，通过 Codex/Claude Code CLI 各自注册。它不覆盖现有全局 Skill。

首次连接运行 connect：安装器取得设备密钥和可显示配对码，用户在自己的浏览器登录 Eva，核对配对码及账号并选择允许或取消。允许后，安装器在有效期内一次性领取该账号已存在的 MCP Token；安装器验证服务身份、账号和项目后才保存。网页、提示词、安装包和诊断输出不包含 Token。

未建立 MCP 身份、身份停用或 Token 已吊销时拒绝授权或领取；提示联系管理员。配对请求仅保存在 MCP 进程内，10 分钟过期，服务重启后重新发起。已发放的个人 Token 仍按现有 Eva 管理规则轮换和吊销；这不是新 OAuth 实现，也不会创建更高权限的凭据。

个人连接文件 `~/.config/eva-project/connection.json`（Unix 0600）独立于安装目录；升级插件保留它。脚本支持隐藏输入的 configure 和 --token-stdin 作为管理员已交付 Token 时的备用方式。

连接检查使用 eva_connection_info 和 requirements_projects；只读核验不创建项目，不自动绑定仓库。用户选择后可把稳定标识记为 `Eva identifier`，与本仓库内部 M-Project 管理绑定分开。

## 构建与发布

```sh
python3 scripts/build-agent-plugin.py
node deploy/openproject/asset-versions.mjs stamp
node --test plugins/eva-project/tests/*.test.mjs
```

构建白名单只包含插件清单、Skills、脚本、图标及 README，下载包为 `deploy/openproject/assets/agent-plugin/eva-project.zip`，元数据为同目录 release.json。分发包中没有业务数据或本机连接文件。它是可解压安装的双客户端包，不是已提交公共商店的插件。

部署时设置 `EVAPROJECT_MCP_PUBLIC_URL` 为实际远端 HTTPS MCP 地址，并让 `OPENPROJECT_PUBLIC_URL` 指向可访问的 Eva 网页。网页服务挂载 evaproject_agent_access.rb 与静态资产；MCP 镜像必须包括配对 API 和 eva_connection_info。网页代理连接 MCP 的内部地址仍使用 EVAPROJECT_MCP_INTERNAL_URL。

当前本地 URL 只适用于同一台电脑；外网云主机、DNS、TLS和公网接入验收仍待后续部署。公网反向代理应为 /agent-connect/start、/agent-connect/token 设置合理限速；应用内部对待处理请求数量、请求体大小和有效期设有限制。

## 维护边界

技能只保留 Eva 产品操作和实际工具合同。客户端工具名可带各自命名空间。交接规范不会启动其他 Agent、创建新会话或引入特定宿主的全局协作规则，除非用户另有明确授权。

仓库旧 skills/ 下的两份文档来自源项目，新的安装入口统一以 plugins/eva-project 为准。

## 当前开发机验证边界

Brian 指定本机 Codex/Claude Code 继续用于 M-Project。这里仅运行包验证、临时目录安装预演和隔离协议测试，不注册本机客户端插件。真实 Codex 接入由 Brian 在另一台设备验证；当前 localhost 地址不能供另一台设备使用，需要配置可达的 Eva 地址。

## 当前局域网调试

网页与接入页：http://192.168.200.40:28080/agent-access；MCP：http://192.168.200.40:28081/mcp。容器仍绑定 loopback，由 `node deploy/bin/evaproject-lan.mjs --host 192.168.200.40` 仅在指定私有网卡监听并转发两个端口。该开发转发不安装到 Agent，不改变其配置；重启开发机后按需重新运行。

当前接入提示词为局域网 HTTP 增加 `--allow-private-http`。此选项只允许私有 IPv4 主机并保存在个人连接配置中；公网继续要求 HTTPS，不放宽到任意 HTTP 域名。

## 当前联调入口

家中服务器入口已切换到 http://192.168.80.4:28080/agent-access，MCP 为 http://192.168.80.4:28081/mcp。它使用新账号和新 Token，不能直接复用开发机实例的凭据。之前192.168.200.40上的临时转发已停止；开发机Agent继续仅连接内部M-Project。

## 接入规范的三层分工

头像菜单和首页均可进入 Agent 接入页，普通已登录用户也可访问。页面提供安装提示词、全局规范和项目规范，两份 Markdown 同时在插件 templates/ 中分发。

1. 插件：一次安装 Skills/MCP，管理具体工具流程及版本，不覆盖宿主已有全局 Skills。
2. 全局规范：用户为每个客户端合并一次，控制已绑定 Eva 项目的自动触发时机。Codex 默认 ~/.codex/AGENTS.md，存在覆盖文件或自定义配置目录时检查实际加载项；Claude Code 默认 ~/.claude/CLAUDE.md。
3. 项目规范：每个项目在根 AGENTS.md 写明确认的 Eva identifier 标识、业务边界、分工、环境与验证发布差异。全局范本不带具体项目绑定。项目范本不复制任一宿主全局规则。

Claude Code 新版本可按配置直接加载 AGENTS.md；已有 CLAUDE.md 或客户端没有直接加载时，可在项目 CLAUDE.md 加入 @AGENTS.md 导入并保留既有内容。配置完成需开启新会话核对加载结果。自动流程只在已绑定项目内触发，仍受用户授权和服务端权限约束。

官方依据：[Codex 自定义规范](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[Claude Code 项目记忆](https://code.claude.com/docs/en/memory)。本次仅交付模板，未修改开发机的全局规范或安装 Eva 插件。

接入页另提供通用 Agent 提示词，只准备标准 MCP 配置，不调用其他客户端的注册命令。项目规范采用 `Eva project_id`（数字ID）与 `Eva identifier`（稳定标识）；缺少ID时先询问是否创建或接入，查重后回填同一项目的两项标识。

## Agent 历史署名

插件从 MCP initialize 的 clientInfo.name 读取客户端自报名称，以编码后的 X-Eva-Agent 头完整透传，同时在 User-Agent 保留客户端段；桥接器版本仅作附加信息。Eva 服务端同时兼容旧版 EvaProjectPlugin 前缀格式。常见旧别名作显示归一化；其他客户端（如 Qoder、WorkBuddy 或自定义名称）保留自报名称，没有 Agent 白名单。缺失身份显示未知，不从其他字段猜测。用户和权限始终由 Token 确定，Agent 名称仅作为自报来源用于历史展示。eva_connection_info 返回 agent 可核对当前识别结果。已落库的旧署名不自动重写。
