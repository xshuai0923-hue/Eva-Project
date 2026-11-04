# Eva-Project

面向人和 Agent 共用的需求管理系统：

- [用户功能手册：系统用途、功能入口与日常使用](docs/eva-user-guide-2026-11-04.md)
- [功能与 UI 修复记录、验证范围](docs/eva-ui-fixes-2026-11-04.md)
- [首次功能与 UI 评审](docs/eva-ui-review-2026-11-04.md)

- OpenProject Community 提供网页、筛选、历史、父子层级、依赖和附件。
- 自建精简 MCP 提供列表、详情、需求树、登记、批量拆分、正文更新、认领、释放、状态更新、父子/依赖、Markdown 和完成证据工具。
- MCP 通过服务端 Token 映射识别用户；同一项目内公开需求可跨用户读取，私有需求仅所属用户和管理员可见。
- OpenProject 是启用后的唯一业务权威；Markdown 只作为迁移、导出和归档格式。

当前固定基线：OpenProject `17.8.0`、官方 Compose `8c349d3b2a4e8ae5f5c253b5392993777148bc2f`、MCP Streamable HTTP。

Eva-Project 面向公司团队，使用独立仓库、运行环境、数据与凭据。本地调试实例已部署于 `http://localhost:28080`；阿里云尚未部署。

- [来源与隔离记录](docs/fork-provenance.md)
- [部署配置与待定参数](docs/deployment.md)
- [2026-10-09 发布变更与部署验证](docs/releases/2026-10-09.md)
- 本地独立实例：`deploy/bin/evaproject-local up`（创建专用 Colima 环境，端口 28080/28081）。
- 验证：`cd services/mcp && npm ci && npm run typecheck && npm test && npm run build`；前端模块测试：`node --test deploy/openproject/*.test.mjs`。

继承文档保留原系统历史记录，仅用于理解业务合同，不能视作 Eva-Project 的部署或验收证据。

- [Eva Project Plugin 与用户接入](docs/agent-plugin.md)
