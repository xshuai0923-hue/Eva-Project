# Eva-Project 部署准备

本次 MCP 账号关联、密码规则与私有项目创建权限更新见 [2026-10-09 发布说明](releases/2026-10-09.md)。既有 macOS 实例的升级及回滚参考见 [账号更新说明](mcp-account-update.md)。

当前状态：开发机保留本地开发实例。用户说明另有通过独立发布包运行的服务器实例，其当前地址和版本尚未核实；新服务器将由另一个部署会话接手。本文 2026-09-30 的家中联调地址属于历史记录，不能当作本次部署目标。旧 macOS 生产安装、launchd、远程发布、用户管理和拉取原系统备份的脚本已移除；源版本保留在 Git 历史中。

当前仓库：[xshuai0923-hue/Eva-Project](https://github.com/xshuai0923-hue/Eva-Project)，分支 `main`；本地工作区为 `E:\Dev\Projects\eva-project-20261009-r1\Eva-Project`。

## 独立环境

- Compose 项目名：`eva-project`；本地开发：`eva-project-local`。
- 本地 Colima profile：`evaproject-local`；数据目录 `/Users/Shared/Eva-Project-local`；只监听本机 28080/28081。
- 云端建议根目录 `/srv/eva-project`，分开存放 `current`、`runtime`、`data/postgres`、`data/openproject/assets`、`backup`。
- 账号由管理员预设；Compose 对全部应用进程设置 `OPENPROJECT_SELF__REGISTRATION=0`，关闭登录页自助注册及直接注册入口。
- `deploy/.env.example` 是待填写的模板，`.invalid` 域名和占位凭据不能用于上线。自有配置统一使用 `EVAPROJECT_*`；OpenProject 自身沿用 `OPENPROJECT_*`。
- 云端使用独立 Linux Docker 环境、PostgreSQL/OpenProject、附件、备份、账号、API Token、Rails secret 与协同编辑 secret。首次引导仅创建 `eva-project` 项目，实际项目 ID 由新数据库分配。
- `EVAPROJECT_UID/GID` 对应云端运行用户，需能访问挂载目录；模板中的 1000 不是已确认账号。

## 首次部署流程（待部署授权后执行）

1. 确认阿里云账号/地域、主机与架构、域名、TLS、网络访问范围、管理员邮箱、邮件服务和备份策略。
2. 检出批准的完整提交并初始化固定 submodule；安装 Docker Compose。创建专用运行用户和上述目录。
3. 从模板生成权限为 0600 的独立环境文件，替换全部占位值，密码和 Token 现场生成，不能复用其他系统。配置文件放仓库外。反向代理提供 HTTPS，并转发 WebSocket；Web/MCP 后端默认只绑定 loopback。
4. 用固定项目名、环境文件、官方 Compose 与本仓 override 渲染 `docker compose config --quiet`；先启 db/cache/seeder/web/worker/cron/hocuspocus/proxy，暂不启 MCP。
5. 在 web 容器执行 `deploy/bootstrap/openproject_bootstrap.rb`。生成的 `runtime/field-map.json` 和 `runtime/openproject-api-token` 仅属于新实例；将 API Token 写入环境文件，不输出到日志。
6. 在 `runtime/mcp/principals.json` 建立新管理员映射（`principals` 数组内含随机 token、userId、displayName、role、active），设置 0600，启动 MCP。由新实例管理员签发公司成员自己的 Token。
7. 验证首次登录、项目创建、需求读写、权限、交接、附件、MCP 调用和备份恢复，再配置重启策略及发布/回滚流程。

Compose 调用必须同时指定：

```sh
docker compose --project-name eva-project \
  --env-file /srv/eva-project/runtime/.env \
  -f vendor/openproject-docker-compose/docker-compose.yml \
  -f deploy/docker-compose.override.yml config --quiet
```

本次未创建云资源、配置 DNS、启动云端服务或迁移内部数据；云端部署与真实端到端验收仍待后续执行。

## 本地调试实例（2026-09-30）

- 页面：http://localhost:28080；MCP：http://localhost:28081/mcp。
- 登录名 `admin`，密码保存在 `/Users/Shared/Eva-Project-local/runtime/admin-password`，可通过 `pbcopy < /Users/Shared/Eva-Project-local/runtime/admin-password` 复制，不输出到终端或文档。
- Colima profile `evaproject-local`，Compose 项目 `eva-project-local`，数据与凭据均在 `/Users/Shared/Eva-Project-local`。
- 本地 MCP 初始身份 `local-admin` 显式关联 OpenProject 登录名 `admin`；这解决了首次登录后的会话接口 403。
- 当前仓库远端为 `xshuai0923-hue/Eva-Project`；本节历史 macOS 工作区路径为 `/Users/brian/Documents/Brian AI/M-Works`，不是当前 Windows 工作区。
- 启动、状态、日志、停止：`deploy/bin/evaproject-local up|status|logs|down`。Colima 启动不改变全局 Docker context。应用容器自动重启；本次未安装宿主机开机自启服务。
- 验证：Web/MCP 健康检查 200；登录态页面、交接会话/列表接口、原生工作包列表、菜单渲染检查通过；MCP 初始化、30 个工具枚举、项目/需求列表读取通过，匿名请求 401。
- 当前仅有新建 `eva-project` 项目，需求列表为空；未导入源系统的数据。数据库分配的数字 ID 恰为 3，不代表绑定到源系统。
- M-Works 首次安装的中间实例已清理。原 M-Project 本地实例保持运行，全局 Docker context 保持 `colima-mproject-local`。
- 本次仅完成本地启动与冒烟；业务写入、附件、完整备份恢复和多人调试留待后续验证，不视为用户验收。

## Agent 插件

首页提供 Agent 接入入口，安装和 Token 配对流程见 [Agent 接入说明](agent-plugin.md)。本地已配置 EVAPROJECT_MCP_PUBLIC_URL；云端须设置真实 HTTPS MCP URL。发布插件脚本或 Skills 后重新构建下载包及资源版本。

## 局域网调试补充（2026-09-30）

Brian 指定另一台设备通过 192.168.200.40 测试。当前本机 loopback 入口保留；增加上述网卡的 28080/28081 转发。runtime/.env 的网页公开地址、MCP地址、允许Host及协同编辑URL同步使用局域网地址。仅 Eva 服务应用该配置；M-Project 和宿主 Agent 配置不变。

## 家中服务器部署（2026-09-30）

Brian 授权迁到双方 VPN 可达的 `192.168.80.4` 进行联调。本次为新的 Eva 实例，没有迁移内部 M-Project 或开发机 Eva 的业务数据/凭据。

- Web：http://192.168.80.4:28080；Agent 接入：http://192.168.80.4:28080/agent-access；MCP：http://192.168.80.4:28081/mcp。
- 应用发布基线：`f32eea1bf2a06fc8e89c306f2b167c8a2e66d262`，`/Users/Shared/Eva-Project/current` 指向同名 releases 子目录。
- Colima：`evaproject`，2 CPU、4 GB RAM、20 GB 磁盘；Docker context `colima-evaproject`；Compose 项目 `eva-project`。
- 独立 runtime、data/postgres、data/openproject/assets、backup 目录都在 `/Users/Shared/Eva-Project`。凭据全部在服务器新生成，不进入仓库。
- 管理员登录名 `admin`，显示名“头哥”；初始密码只保存在服务器 `/Users/Shared/Eva-Project/runtime/admin-password`。用户改密后，该初始密码文件不再代表当前密码。
- 使用 `deploy/docker-compose.home.yml` 将 Eva Web worker 限为 1。原 M-Project 的 profile、目录、8080/8081 和默认 Docker context 保持原样。
- 运维入口：`/Users/Shared/Eva-Project/current/deploy/bin/evaproject-home status|logs|up`。首次部署使用 home_env.rb 生成新环境、prepare 启动基础服务、bootstrap 生成字段及 API Token、up 启动 MCP。
- 用户级启动任务：`/Users/brian/Library/LaunchAgents/com.briantai.evaproject.home.plist`；当前已加载，宿主用户登录后启动 Eva。容器使用自动重启策略；没有安装系统级开机服务，也未做宿主重启验收。
- 验证：VPN访问登录/需求/交接/工作包/接入页正常；用户密码登录通过；实际 HTTP 登录态下配对批准→一次性领取 Token→读取 Eva 身份与新项目通过；重复领取拒绝。网页油画和插件包散列与工作区一致。测试凭据仅在测试进程内使用，没有保存到本机 Agent 配置。
- 另一台设备的真实 Codex 插件安装仍待 Brian 验收。开发机之前的临时 LAN 转发已停止，后续以80.4入口为准。

## 默认语言与时区

新环境默认 `OPENPROJECT_DEFAULT__LANGUAGE=zh-CN`，`EVAPROJECT_TZ=Asia/Hong_Kong`。Web/worker/cron/seeder 的用户默认时区与进程 TZ 同步，MCP 使用同一 TZ。保留已有用户显式个人偏好；80.4管理员已自行选择简中及香港时区。引导和新项目类型绑定同时兼容中文与英文种子类型名称。
