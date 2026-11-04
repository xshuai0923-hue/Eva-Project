# Eva Project Plugin

Brian Tan · 0.1.5 · Codex + Claude Code + 通用接入

包含 Eva 需求管理、交接、接手、连接四个 Skills，以及通往 Eva HTTP MCP 的本机 stdio 连接器。需要 Node.js 22+ 和目标客户端 CLI。无需访问私有 GitHub 仓库；从 Eva 的 Agent 接入页面下载发布包即可。

## 安装

在解压目录执行：

```sh
node scripts/setup.mjs install --client both
```

只安装一个客户端可用 codex 或 claude。脚本将插件放到用户目录 `~/.local/share/eva-project/marketplace`，使用两个客户端各自的 marketplace/install 命令安装，不覆盖用户原有全局 Skills。

## 获取 Token 并连接

```sh
node scripts/setup.mjs connect --server https://YOUR-EVA-HOST/mcp --client codex
```

服务地址从 Eva 接入页面复制。脚本打开授权页，用户登录自己的 Eva 账号并核对终端配对码后确认。10 分钟内，安装器可一次性领取该账号由管理员预设的 MCP Token；网页和标准提示词不包含 Token。授权保持该账号的原有权限，不创建账号或扩权。管理员尚未签发 Token 时，网页会提示联系管理员。

凭据保存到 `~/.config/eva-project/connection.json`（Unix 权限 0600），与插件安装目录分离，更新插件不会清除它。不要将该文件放入版本库。`EVA_PROJECT_CONFIG` 可指定独立连接文件，用于测试或多套客户端启动环境。

无法打开浏览器时用 --no-open 手动打开输出的地址。管理员已经通过其他方式交付 Token 时，可运行 configure --server <URL>，在本机终端的隐藏输入中填写。自动化可用 --token-stdin 从受保护文件读取，避免把 Token 放进进程参数。

连接后运行 `node scripts/setup.mjs doctor`，确认身份、实例和可访问项目。再开启新的 Agent 会话，调用 eva_connection_info 和 requirements_projects，选择工作项目后使用业务工具。需要持久记录项目时，使用 `Eva identifier: <identifier>`；项目标识由用户选择。

## 更新与移除

下载新版本并重跑 install，原连接配置保留。客户端缓存更新后开启新会话。客户端若报告该 marketplace 已存在不同路径，请先核对原安装来源，不覆盖其他来源。

用 `codex plugin remove eva-project@eva-project` 或 `claude plugin uninstall eva-project@eva-project` 移除对应客户端的插件。卸载不自动删除个人连接文件，也不吊销服务端账号 Token；可由用户删除本机连接文件，由管理员吊销 Token。

## 当前边界

本包面向本地 Codex/Claude Code，不是 ChatGPT OAuth 集成。HTTP 默认只接受 loopback 本机调试地址；局域网测试可显式加 --allow-private-http，只允许私有 IPv4 地址，外网仍须 HTTPS。接入页面须配置实际 MCP 公网 URL。当前版本的 Eva MCP 为请求/响应工具服务，本机桥接器转发请求但不会自动重试写操作；超时后先查询结果再决定是否重试。

## 全局与项目规范

安装插件后，用户还需按用途配置两层约定：

- 全局：将 templates/global-guidelines.md 合并到客户端实际加载的用户级规范。Codex 默认 ~/.codex/AGENTS.md（有覆盖文件时核对实际加载项）；Claude Code 默认 ~/.claude/CLAUDE.md。已有内容保留，不整份覆盖。
- 项目：将 templates/project-guidelines.md 的占位填写后合并到仓库根 AGENTS.md。稳定标识由用户从 Eva 项目列表确认，不从目录名推断。
- Claude Code：若项目已有 CLAUDE.md，或当前版本/设置没有加载 AGENTS.md，在项目 CLAUDE.md 中加入 @AGENTS.md，保留既有内容；新版客户端能直接加载时不重复配置。

全局负责何时自动触发 Eva 工作流，项目文件负责绑定、业务边界及环境差异，Skills 负责具体操作。配置后开启新会话，让 Agent 报告加载的规范、Eva 身份和项目绑定，再开始工作。

## 通用 Agent

`install --client generic` 只准备文件并输出 MCP stdio 配置，不注册 Codex 或 Claude Code。由当前 Agent 按自身机制合并 MCP 配置及加载 Skills；配对使用 `connect --client generic`。不支持 shell、stdio 或 Skills 的客户端需说明限制并使用其实际支持的接入方式。
