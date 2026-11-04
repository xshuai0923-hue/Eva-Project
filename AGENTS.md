# Eva-Project 协作约定

- 遵循各 Agent 自己的全局规范。
- M-Project project: `eva-project`
- M-Project project_id: `9`
- 开发需求与后续交接统一记录在现有内部 M-Project 的 Eva Project 公开项目；该管理绑定与 Eva Project 产品运行实例分离。
- 本项目维护 Eva-Project 服务；下列业务不变量与部署约定用于服务实现和验证。
- OpenProject 是启用后的唯一业务权威；Markdown 仅用于导入、导出与归档。
- 用户原文、Agent 理解和讨论分开保存；未知时间或来源明确标记，不能补造。
- 父子层级与执行依赖分别使用 OpenProject hierarchy 和 relation。
- 写操作必须使用 `lockVersion`；冲突时返回冲突，不覆盖或静默重试。
- Agent 完成需求必须有与交付类型匹配的真实证据、验证和适用验收来源；Git 与非 Git 证据规则见全局规范，接口支持情况以当前工具合同为准。人在需求池页面上手动改为已完成直接生效，记下完成时间与操作人，视为人工验收。
- Agent 要先认领，才能把需求推进到进行中、已实现待提交、待验证/验收或完成，实际认领 Agent 与 Session 由认领写入；人在需求池页面上手动改状态不受此限。
- 服务器凭据、OpenProject 密钥、管理员密码和 API Token 不进入 Git、日志或对话。
- Eva-Project 是面向公司团队的独立系统；未来部署于阿里云，主机、域名与账号待指定。部署需要当次明确授权。
- 服务、数据库、附件、备份、账号、密钥和部署流程独立；首次部署使用空数据与新凭据。

- 当前开发机上的 Codex 与 Claude Code 继续连接内部 M-Project。Eva Plugin 仅在仓库内封装及隔离验证，不安装或配置到本机 Agent；真实客户端接入由 Brian 在另一台设备测试。
- 家中联调历史目标为 `brian@192.168.80.4`，Eva 独立根目录 `/Users/Shared/Eva-Project`、Colima profile `evaproject`、Compose 项目 `eva-project`、端口 28080/28081；原 M-Project 使用其原目录、profile 与 8080/8081。这是历史记录，当前目标以当次用户指定的服务器为准；新服务器的主机、域名与账号须在实际部署会话中确认，不根据历史地址自动发布。
