> 来源说明：本文继承自 M-Project 分叉基线，包含原系统的历史记录与示例，不代表 Eva-Project 已部署或验收。Eva-Project 当前环境以 [部署说明](deployment.md) 为准。

# Claude 需求池 Skill 更新说明

请更新 Claude 环境中的 M-Project 需求池 Skill，沿用已有项目绑定、权限、认领和完成证据规则，补充以下已实现工具合同。

- 调用 `requirements_types(project)` 获取项目已启用的 OpenProject 类型 ID。Bug 用于缺陷，Feature 用于新功能需求，Task 用于执行任务；按需求内容选择，无法判断时保留 Task，不批量猜测修改历史分类。
- `requirements_create`、`requirements_children_create` 的各子项、`requirements_update`、`requirements_list` 支持可选 `type_id`。使用查询返回的 ID，不写死跨项目映射；新建省略时兼容旧调用，默认 Task。摘要、详情和写入回执增加 `typeId`、`typeName`。
- 单独修改类型可调用 `requirements_update`，传入 `project`、`reference`、`type_id`、`note`、`changed_at`、自己的 `session_id` 和最新 `expected_lock_version`。
- 同一需求所属用户或管理员可跨 Session 继续更新正文、状态和完成证据。先读最新详情，再带自己的 Session ID 与锁版本更新，保留原认领记录；已有认领无需再次抢占。认领释放仍由原认领 Session 执行。
- `requirements_upload_attachment` 支持图片、PDF、Office 文档、压缩包等任意扩展名，单文件最多 20 MiB。参数为 `project`、`reference`、`file_name`、`content`、`encoding`（`base64` 或 `utf8`），可选 `content_type`、`description`。二进制使用标准 Base64；先创建需求再追加附件。Markdown 原上传与读取工具继续兼容。

如果客户端尚未发现新工具或参数，先刷新 MCP 工具列表或重新连接。只更新 Skill，不修改服务器配置或需求业务数据。
