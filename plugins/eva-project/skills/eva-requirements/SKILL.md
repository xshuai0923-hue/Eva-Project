---
name: eva-requirements
description: 在已绑定 Eva Project 的项目中处理明确的新需求、缺陷、执行和交付时，或用户要求操作 Eva 需求池时，查重、登记、认领并维护需求与证据。
---

# Eva 需求管理

使用本插件 `eva-project` MCP 提供的工具；宿主可能在工具名前加命名空间。首次使用先用 `eva_connection_info` 核对服务和账号，再用 `requirements_projects` 获取可访问项目。

先读取项目 `AGENTS.md` 的 `Eva project_id` 和 `Eva identifier`。缺少数字 ID 时，询问用户是否在 Eva 创建或接入项目；用户同意后先查重，确认复用已有项目或按确认的标识创建。已有稳定标识时先核对它对应的项目，避免重复创建。回读后将数字 ID 和稳定标识一起合并到项目规范，保留原内容。用户拒绝接入时沿用原流程。工具的 `project` 参数仍使用稳定标识，数字 ID 用于核对。

## 查找与登记

- 登记前用 `requirements_search` 按目标查重；列表/树用于结构化筛选，正文用 `requirements_get` 按章节读取。无项目限制的搜索只用于用户明确要求的跨项目检索。
- 用 `requirements_types` 获取当前项目类型：缺陷选 Bug，新能力选 Feature，执行事项或无法归类才选 Task。传实际 `type_id`，不复用其他项目的数字 ID。
- `requirements_create` 保存用户原文、Agent 理解、范围、验收和来源。区分已确认要求与建议；优先级未知如实注明。来源 Session 使用当前客户端提供的真实标识；未知消息编号留空。
- 参考附件通过上传工具保存并回读文件名；可选父级和执行依赖分别使用父子关系与依赖工具。
- 创建后回读类型、来源、项目及附件，确认记录完整。

## 执行与状态

读取最新详情后按真实 Agent、Session 和当前范围认领。已有其他会话认领时说明冲突；认领本身不扩大实现、部署或对外发送授权。

正文变更用 `requirements_update`，状态用 `requirements_update_state`，变更理由写 note。携带最新 `expected_lock_version`；遇冲突重新读取并核对差异，不覆盖他人修改。执行进展写入交接，需求正文保留目标和验收。

完成步骤不等于需求验收。代码已提交但验证或验收未闭合时用“待验证/验收”。`requirements_complete` 的 Git 证据包含真实仓库、完整 SHA、路径、验证与适用验收来源；仓库外交付使用工具支持的 file 证据和实际位置。只在范围、依赖及必需子项闭合后完成，并回读状态。

不再继续时使用释放工具交还认领；用户要求交接时使用 Eva 交接工作流保存当前状态。
