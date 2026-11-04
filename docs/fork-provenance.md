# Eva-Project 来源与隔离记录

- 建立日期：2026-09-30。
- 源仓库：`git@github.com:briantant3/M-Project.git`，私有。
- 源权威默认分支：`main`。
- 分叉提交：`05f09064c10946879d9841923332b14788085d87`。
- 官方 Compose submodule：`8c349d3b2a4e8ae5f5c253b5392993777148bc2f`。
- 独立仓库：`https://github.com/briantant3/Eva-Project`，同一所有者，保持私有。
- 方式：保留源提交历史的新独立 GitHub 仓库，不是 GitHub fork network 中的原生 fork。本地从远端 clone，未读取或复制源工作区的未提交修改。
- 本地 `origin` 指向 Eva-Project；`source` 只作来源引用，push URL 已禁用。只推送 Eva-Project 的 main，不镜像推送其他引用。

## 已完成的隔离

2026-09-30 根据 Brian 指示，M-Works 更名为 Eva Project；远端仓库同步更名为 Eva-Project。本地代码目录暂沿用 M-Works，运行资源使用 Eva-Project 独立目录。

产品名称 Eva Project；包名、MCP 名称、浏览器存储键、资产路由、Ruby 扩展及自有环境变量使用独立命名。保留源业务逻辑与接口能力；字标改为 Eva Project，站点图标改为 E。

移除旧主机安装、launchd、远程发布、用户恢复命令和远端备份下载脚本。新模板使用 `/srv/eva-project`、独立 Compose 项目和明确待填域名；本地使用专用 Colima profile、数据目录及 28080/28081 loopback 端口。自动恢复服务使用专用容器标签。

引导仅创建 `eva-project`，不再创建内部业务项目。按 Brian 后续要求，AGENTS.md 绑定内部 M-Project 中新建的 Eva Project 公开协作项目（eva-project / 9），不沿用源产品的 m-project / 3。本地新实例生成独立凭据，初始 MCP 身份为 local-admin，关联网页登录名 admin；云端账号及密钥须首次部署时生成。没有复制运行时环境文件、账号映射、字段映射、数据库、附件或备份。

源文档中的历史记录保留并标记来源；它们不是 Eva-Project 的部署或验收证据。源历史按要求保留，因此历史中仍可查到原系统的部署约定。当前运行配置与脚本不再默认指向原系统。

## 本次验证

- MCP TypeScript 类型检查和构建通过；294 项测试通过，其中新增 2 项验证默认及显式 Host allowlist。
- 前端模块 114 项测试通过；资产内容版本校验通过。
- 状态对账器自测通过（17 种破坏、6 种遗漏）。
- Compose 合并配置渲染通过，检查数据与配置挂载均属于 `/srv/eva-project`（autoheal 的 Docker socket 属宿主服务接口）；只发布 loopback 端口，无原实例标识或地址。
- 本地 shell 脚本语法检查、Git whitespace 检查通过。
- 历史路径检查未发现受版本控制的运行时密钥文件/数据库转储；高置信度私钥、GitHub 和 AWS 凭据签名扫描为 0。此检查不等同于完整秘密审计。

分叉阶段未启动应用；随后按 Brian 授权完成本地 Eva Project 部署、数据库引导、登录态页面/API 冒烟与 MCP 读取验证。阿里云尚未部署，完整业务验收未执行。当前参数与验证范围见 [部署说明](deployment.md)。
