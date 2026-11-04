> 来源说明：本文继承自 M-Project 分叉基线，包含原系统的历史记录与示例，不代表 Eva-Project 已部署或验收。Eva-Project 当前环境以 [部署说明](deployment.md) 为准。

# OpenProject 映射

## 标准能力

| 需求语义 | OpenProject |
| --- | --- |
| 稳定网页记录 | Work package |
| 当前状态 | Work package status + `需求状态` 自定义字段 |
| 父子需求 | Parent/children hierarchy |
| 执行依赖 | `blocks / blocked by` relation |
| 原始 Markdown | Work package attachment |
| 讨论与变更历史 | Description + journal/activity |
| 并发保护 | `lockVersion` |

一个 OpenProject 实例承载多个项目。MCP 以项目 identifier 选择范围；稳定需求 ID 在项目内唯一。使用数字 work package ID 时可直接定位，使用业务需求 ID 时必须同时提供项目或使用显式默认项目。

## 自定义字段

部署引导会创建并激活以下字段，实际 API 键在运行时生成的 `field-map.json` 中记录，代码不硬编码 `customFieldN`：

| 字段 | 类型 |
| --- | --- |
| 需求 ID | 文本 |
| 提出者类型 | 单选列表：人、Agent、系统、未知 |
| 提出者名称 | 文本 |
| 提出者 ID | 文本 |
| 可见性 | 单选列表：公开、私有 |
| 需求提交人 | MCP Token 对应的用户 ID；由认证身份写入，不接受普通调用者冒填 |
| 原记录时间 | 文本（迁移来源时间） |
| 原更新时间 | 文本（迁移来源时间） |
| 模块 | 多选列表 |
| 负责 Agent | 单选列表 |
| 实际认领 Agent | 单选列表 |
| 认领 Session | 文本 |
| 认领标签 | 文本 |
| 认领时间 | 文本（ISO 8601） |
| 认领范围 | 长文本 |
| 受理状态 | 单选列表 |
| 需求状态 | 单选列表 |
| 用户优先级 | 文本 |
| 提出时间 | 文本 |
| 时间精度 | 单选列表 |
| 来源 Session | 文本 |
| 来源消息 | 文本 |
| 来源标签 | 文本 |
| 父需求必需项 | 布尔 |
| 验证状态 | 单选列表 |
| 用户验收 | 单选列表 |

用户原文、Agent 理解、讨论和交付证据使用 Description 的固定章节，避免长正文被拆成大量难读字段。

## 运行时映射

MCP 启动时读取 `OPENPROJECT_FIELD_MAP_FILE`。列表字段值以 option href 写入；读取时同时返回人类可读标题。自定义字段设为全项目可用，新增 OpenProject 项目无需复制一套字段。映射文件由部署引导生成，不包含 API Token。
