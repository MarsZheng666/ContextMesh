# 原生 Agent 日志存储

[English](native-agents.md) · [部署 Server](deployment.zh.md) · [DSH 会话交接](handoff.zh.md)

ContextMesh Server 可以保存独立的原生 Agent 日志。DSH 仍使用唯一的 ContextMesh 插件；可选 [Codex CLI 适配器](codex.zh.md)可导入快照、确认接管未完成的 DSH 任务，并归档原生续跑结果。单独在 SDK 中选择 `adapter: 'codex'` 仍只是指定存储格式，不会安装 Codex 或转换 DSH 日志。DSH → Codex 的确认式接管见[接管指南](confirmed-takeover.zh.md)。

## 存储约定

每种原生格式使用独立的 `MeshClient`：

```ts
const client = new MeshClient({
  endpoint: 'https://mesh.example.com',
  token: deviceCredential,
  adapter: 'codex',
})
```

默认值为 `deepseek`。适配器名称长度为 1–64，以小写字母开头，可包含小写字母、数字和单个 `.`, `_`, `-` 分隔符，例如 `deepseek`、`codex`、`claude-code`。名称表示编解码格式，不表示模型或设备；DSH 内切换模型仍使用 `deepseek`。

| 字段                       | 含义                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `header.id`                | ContextMesh 内稳定的会话 ID，在同一命名空间的所有适配器之间唯一；可加适配器前缀或使用 UUID 避免冲突。 |
| `header.version`           | 由适配器定义的封装格式版本；其他 Agent 不应将它解释为 DSH 格式版本。                                  |
| `header.createdAt`         | 非负安全整数时间戳。                                                                                  |
| `header.isSeeded`          | 是否存在继承前缀；未继承的日志要求继承数量为 0。                                                      |
| 其他 header 字段           | 随 header 保留的 JSON；可记录原生线程 ID 和格式元信息。                                               |
| 事件 `seq`, `type`, `time` | 从 0 开始连续递增的非负安全整数序号、非空事件类型和非负安全整数时间戳。                               |
| 其他事件字段               | 由适配器负责解释的原始 JSON，可保存原生事件内容。                                                     |

Server 校验存储封装，不解释各 Agent 的可执行语义。原始 JSON 会被保留，不会压平工具调用、重放工具、复制模型密钥或伪造成功结果。适配器必须在执行前校验自己的原生内容；header 和事件中不应包含凭据。所有格式都遵守现有的单写者租约、写入代次隔离、追加顺序、操作 ID、flush、异常写者恢复及读取分页规则。

## 目录与写入权

| 操作                            | 格式选择                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POST /v1/sessions`             | 请求体必须包含 `adapter`，创建后不能修改。                                                               |
| `GET /v1/sessions`              | 查询参数 `adapter`，默认 `deepseek`；先按格式筛选再分页。                                                |
| `GET /v1/sessions/:id`          | 查询参数 `adapter`，默认 `deepseek`；其他格式的会话返回 null。                                           |
| `POST /v1/sessions/:id/handles` | 可选请求体字段 `adapter`，默认 `deepseek`；不匹配时在申请句柄前返回 `ADAPTER_MISMATCH`。                 |
| `POST /v1/sessions/:id/recover` | 可选请求体字段 `adapter`，默认 `deepseek`；仍需 `confirmStopped: true`，不匹配时不能关闭其他格式的写者。 |

SDK 自动补充 create、list、stat 和 open 的格式选择。直接调用 `request`（包括 recover）时，需要明确传入非默认适配器。已有 DeepSeek 修改请求继续省略默认适配器字段，保持同一操作重试的兼容性。通过句柄读写时，仍使用认证后的命名空间和已取得的句柄。现有 DSH 专用交接、模型接力、摘要与项目设置流程会拒绝其他原生格式，不会自动转换。

适配器**不是权限隔离边界**。同一命名空间内已授权的设备可明确选择其他格式；不同用户的权限仍需后续鉴权层实现。会话 ID 保持命名空间内全局唯一：用其他适配器重复创建已有 ID，返回 `ALREADY_EXISTS` 并保留原历史。

远程 CLI 支持按格式检查：

```sh
contextmesh list --adapter codex
contextmesh stat codex-thread-id --adapter codex
contextmesh export codex-thread-id --adapter codex
contextmesh recover codex-thread-id --confirm-stopped --adapter codex
```

导出包含适配器名称、原 header、继承数量和事件。恢复仅能在确认原进程及其工具停止后明确执行；选择适配器不代表可以停止正在运行的 Agent。

## Codex 归档返回

带认证的 `GET /v1/codex-archives` 和 `GET /v1/codex-archives/:id` 返回本命名空间内归档元信息：身份、会话实例、序号数量、创建时间、忙碌及待恢复标记，不返回上下文正文或凭据。`/health/ready` 声明 `codex-context-return-v1`，该增量能力沿用 schema 8。

接收端 DSH 插件通过[明确的归档导入](codex-return.zh.md)校验固定 Codex 快照并转换为新的 DSH 日志，不通过原生恢复接口解释其他格式。目标 header 的 `contextmeshImport` 记录来源截点、摘要、操作编号和预期导入事件数量。不完整导入会在普通列表分页及摘要查询前被筛除；导入历史完整前，普通写入申请返回 `IMPORT_INCOMPLETE`，仅明确的导入恢复请求携带相符的可选 `importOperationId`，补齐保存的历史前缀。这是现有可信命名空间内的导入阶段保护，不是新增的鉴权边界。

## 版本兼容

带认证的 `/health/ready` 声明 `native-agent-storage-v1`，数据库版本为 **8**。旧 Server 不接受其他原生格式。schema 8 保留原生格式边界和已有 DSH header、事件，增加后继会话关联、独立 Agent 端点身份和一次性续跑记录。已转移的 DSH 历史可读，申请写者或恢复写者返回 `SESSION_MOVED`。请按[结构迁移流程](runtime.zh.md#从-schema-6-或-7-迁移到-8)升级。对外仍只安装一个 DSH ContextMesh 插件。
