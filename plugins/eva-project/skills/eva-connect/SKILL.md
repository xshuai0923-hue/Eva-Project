---
name: eva-connect
description: 安装后连接 Eva Project、核对账号和项目，或排查 Eva MCP 地址、认证及插件加载问题。
---

# 连接 Eva Project

连接由管理员部署的 Eva 实例。使用用户提供或 Eva 接入页面给出的 MCP 地址。

首次连接运行插件的 [安装与连接脚本](../../scripts/setup.mjs)：

```sh
node <plugin-root>/scripts/setup.mjs connect --server <Eva-MCP-URL> --client codex
```

Claude Code 把 client 改成 claude。脚本打印授权页和配对码；请用户在自己的浏览器中登录 Eva，核对相同配对码后确认。脚本领取该账号已有 Token，保存到本机私有连接文件，随后报告认证身份和项目列表。未预设 MCP 身份时由管理员配置账号 Token 后重试。

自动授权暂不可用时，用户可在自己的终端运行 configure，用隐藏输入填写管理员交付的个人 Token。Token 不需要进入对话、提示词或插件文件。

安装后开启新客户端会话，使插件工具和 Skills 加载。用 `eva_connection_info` 核对实例、身份，用 `requirements_projects` 查看项目，再请用户选择业务项目；连接检查本身不创建项目或改动需求。

用 `node <plugin-root>/scripts/setup.mjs doctor` 复查。地址不可达检查网络和 URL；401 检查 Token 是否失效；403 检查账号权限；缺少 eva_connection_info 请管理员更新 Eva 服务。已有连接升级时保留本机配置，不把它覆盖成示例地址。

## 规范配置

连接后按用户选择的客户端说明 [全局触发约定](../../templates/global-guidelines.md) 与 [项目规范范本](../../templates/project-guidelines.md) 的分工。全局规则合并到客户端实际加载的用户级规范。项目未记录 `Eva project_id` 时，先询问用户是否创建或接入；同意后查重、创建或确认复用，并将服务返回的数字 ID 与稳定标识一起合并进项目 AGENTS.md，保留原有约定。Claude Code 若未加载 AGENTS.md，可在同目录已有或新建的 CLAUDE.md 中加入 `@AGENTS.md`，保留原内容。开启新会话后先核对加载的规则、绑定和工具，再按约定处理工作。
