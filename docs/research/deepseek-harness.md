# DeepSeek Harness 源码预研

日期：2026-10-26。结论基于官方仓库 `deepseek-ai/deepseek-harness` 的固定提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（提交时间 2026-10-23，+08:00），不是对所有已发布版本的保证。根包及所查持久化包版本为 `0.2.1-rc.3`；根包要求 Node.js `>=24.9.0`，包管理器为 `pnpm@11.28.5`。

本轮成功克隆并静态阅读源码、调用链和测试；没有安装依赖、启动 Harness、调用模型或运行上游测试。当前本机默认 Node 为 `v22.23.2`，不满足该上游根包要求。实现前需配置符合要求的运行时。

## 结论

官方已经把持久化抽成 `SessionPersistence extends Service`。ContextMesh 可以实现远程 provider，在对应 Cordis scope 中替换 JSONL 后端，并通过现有 agent-loop 创建和恢复 Session。无需先 fork 或修改 agent-loop。此结论是静态可行性判断，仍需用打包加载和契约测试证实。

Session 是追加式事件日志，模型历史从日志派生；远程服务保存完整原生记录，而不是仅存聊天消息。跨机器还涉及工作目录和外部资源；跨模型涉及模型路由及输入能力；异构 Agent 需要额外的可移植任务上下文。

## 插件与安装扩展点

- Cordis 支持模块 `apply(ctx, config)`、带 `apply` 的对象和 Service 类。模块可以提供 `name`、`Config`、`inject`；顺序由服务依赖控制，不能依赖配置数组位置。[插件教程](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/docs/cordis-tutorial/01-first-plugin.md)
- `ctx.sessionPersistence` 由服务定义声明；新后端应导入公共服务与类型，提供一个 Service 子类，通过 `apply` 管理资源，不依赖 JSONL 的具体类。[服务定义](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence/src/index.ts#L144)
- JSONL 具体类没有 named export，其模块主要公开配置及插件入口；内部 `JsonlBackendTracker`、`JsonlSessionHandle` 是行为参考，不是通用可复用 SDK。新后端需要自己的实时路由、缓冲和关闭实现。[JSONL 挂载](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence-jsonl/src/index.ts#L1824)
- 可安装 bundle 与运行时插件是两层。源码示例在 `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，并导出、打包该文件。ContextMesh 也需声明兼容的 `engines.dsh`，实际版本范围待安装验证后确定。[bundle 示例](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/experimental/session-search/package.json)
- 默认 base 中的后端行 ID 为 `session-persistence-jsonl`，并存在 `session-checkpoint-policy`。新 bundle 必须在相同服务 scope 中停用或替换前者，保留后者及其依赖；不能简单再插入另一个同名服务。[默认组合](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/bundle/base/cordis.patch.yml#L138)

当前没有输出可直接安装的 patch，因为尚未完成 loader 合成及各 profile 的运行验证。

## 持久化公共接口

以下是接口摘要，不是可编译实现。`SessionAccess` 为 `read | write`。

| 层级 | 方法或字段 | ContextMesh 要遵守的行为 |
| --- | --- | --- |
| 服务 | `create(header, options?)` | 返回 write handle；重复 ID 拒绝；seeded header 必须匹配 `inheritedEventCount` |
| 服务 | `open(id, access, options?)` | read 不占写权；write 原子占写权，冲突拒绝 |
| 服务 | `stat(id)` / `list()` | 返回快照；不存在的 stat 为 undefined；list 没有排序承诺，公共接口无分页参数 |
| 服务 | `flush()` | 刷新调用时所有活跃 write handles，继续处理其他 handle 后聚合失败 |
| handle | `id/header/inheritedEventCount/access` | 不变的身份与元数据；fork 继承前缀长度在日志外保存 |
| handle | `read(offset?, length?, options?)` | 返回 `{events, eventState}`；外层数组归调用方；同 handle 的观察不倒退 |
| handle | `append(events, options?)` | 首个 seq 等于当前 next-seq，批次连续；成功后同后端实例的后续读取看见该前缀 |
| handle | `flush(options?)` | 持久化屏障；已确认追加可抵抗承诺故障范围内的崩溃；空 Session 也变得可持久发现 |
| handle | `close()` / async dispose | 异步、幂等、不可取消；write handle 排空写入并释放写权；关闭后其他操作拒绝 |

[服务源码](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence/src/index.ts)、[handle 源码](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence/src/handle.ts#L59)。服务并没有 `save/get/delete/inspect` 这些方法；`SessionInspection` 是导出的数据类型。

`SessionPersistenceRevision` 只是同服务实例、同 Session 内用于缓存比较的 opaque token；不能用作跨机器 CAS 或租约 fencing token。远程协议需要自己的 generation、nextSeq 和 fencing epoch。

上游共享测试还要求：未 append/flush 的 create 在当前实例可见、全新实例不可见；直接 close 该空 pending Session 后消失。不要让远程 create 立即变成所有客户端都能发现的持久 Session。建议使用服务端不可公开枚举的 reservation，加实例内 pending 视图；第一次非空 append 或显式 flush 才 materialize。普通 close 排空已产生的事件；从未 materialize 的空 pending 按此特殊规则释放 reservation。

## 实时写入与生命周期

1. 新建：agent-loop 先 prepare 未发布 Session，调用 persistence.create 取得写 handle，补存构造时 seed，然后才进入 SessionStore 并发布。seed 不会重新触发实时事件，不能只靠订阅来保存它。[create 路径](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/index.ts#L687)
2. 运行：provider 监听 `session/event`，按 session ID 投递到活跃 write handle 的串行缓冲。回调不是异步持久化屏障；后台错误须保留未确认批次并在 flush 暴露。[实时路由](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence-jsonl/src/storage.ts#L535)
3. checkpoint：通过 `ctx.sessions.flush(session)` 进入 `session/flush`，先 drain live buffer，再做 handle.flush。保留 `session-checkpoint-policy`：模型请求前、顶层工具执行前和下一步前进行 checkpoint，失败时阻止对应下游执行。[checkpoint 实现](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-checkpoint-policy/src/index.ts)
4. 恢复：agent-loop 先 `open(id, 'write')`，再读取完整日志，以 agent 层的 `interruptedTurnClosers` 补齐中断轮次，再 prepare/publish。存储层只提供有效物理记录，不自行编造工具结果或重试工具。[resume 路径](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/index.ts#L762)
5. 停止：AgentHandle.dispose 会停止 loop 并等待 idle、清理 scope、关闭存储 handle，再离开注册表；任何最终事件都必须仍能路由到 provider。provider 热卸载时也要让消费者先结束，最后卸载监听器并关闭远端资源。[停止路径](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/index.ts#L497)

替换后端不能只做定时 HTTP 上传；那会绕开生命周期、丢失 seed、吞掉 flush 错误或提前卸载监听器。

## 格式、错误与单写者

当前逻辑 `SESSION_FORMAT_VERSION = 4`，header 含 id、createdAt、原始 cwd、isSeeded，以及可选的子 Agent / preset 元数据。服务应独立记录 adapter ID、Harness commit、格式版本和协议版本，不把这些不同版本号混用。[header](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/types.ts#L86)

复用公共 `assertStoredId`、`assertVersion`、`materializeCreateHeader`、`materializeAppendBatch`、`assertContiguous` 和 `validateStoredEvents`。对网络输入仍要做运行时校验。未知必需事件拒绝读取；`ignorable: true` 是未知事件类型的明确例外，保留原文而不是擅自删掉。旧格式迁移由已有格式 catalog 管线负责；MVP 可明确只接收当前格式，拒绝历史版本，不能顺手“升级”原始数据。[验证器](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence/src/storage-contract.ts#L69)

保留上游 typed errors：NotFound、AlreadyExists、AlreadyOwned、ReadOnly、HandleClosed、OwnershipLost、FormatUnsupported、Corruption。HTTP 状态必须配机器可识别错误码，映射回对应错误，不能全部转成普通 500。[错误类型](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence/src/errors.ts)

JSONL 目前使用本机内核锁（POSIX flock / Windows semaphore），不是跨主机租约，且不对活但卡住的持有者自动超时夺权。ContextMesh 的远程写权必须自己实现。上游已提供永久失权的 `SessionOwnershipLostError`，但远程租约、续期和 fencing 并非现成能力。[JSONL 锁](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence-jsonl/src/lease.ts)

## 跨机器、跨模型与异构 Agent

原始 header.cwd 是不可变元数据，不能在迁移时改写。上游 `workingDirectory.set(agent, path)` 校验目标并记录 `working-directory/change`；适合在恢复 setup 中完成目录映射，首次模型请求前确认目录和仓库身份。ResumeAgentOptions 没有一个任意覆盖原始 cwd 的字段。[工作目录服务](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/working-directory/src/index.ts#L163)、[恢复参数](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent/src/index.ts#L129)。

`AgentModel.current()` 优先采用已记录的模型选择，options 只是 fallback。跨模型接力应在可控恢复 setup 中显式调用 `agent.model.select(...)`，产生 `model/selection`，并在首个请求前 flush。配置启动路径也有 `applyConfiguredRoute`，但不能据此假定通用 resume 的 agentOptions 会覆盖历史。[模型选择](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent/src/model-selection.ts#L105)

日志不包含所有执行资源。默认组合明确把附件字节放在独立 attachment 后端；spill 文件、工作区未提交变更、终端进程、凭证和权限同样不能由 Session 重放自动重建。首个文本闭环只接受已同步的干净 Git 工作区，并拒绝必需外部资源缺失的交接。

异构 Agent 不共享 DSH 的事件词汇、工具协议和执行状态。建议保留 DSH 原生日志用于原生恢复，同时单独生成可移植 TaskContext，由目标适配器创建自己的新 Session。完整字节保存可以检验，行为和模型隐含推理无损接续不能保证。

## 测试入口与下次验证

| 源码测试 | 验证内容 | 本轮状态 |
| --- | --- | --- |
| `session-persistence/tests/contract.ts` 的 `runPersistenceContract` | handle、连续 seq、lazy materialization、读写可见性、格式拒绝、损坏处理、revision | 已阅读，未执行 |
| `session-persistence/tests/live-write-contract.ts` 的 `runLiveWritePathContract` | 实时排队、flush 错误、dispose、失败后重试与顺序 | 已阅读，未执行 |
| `session-persistence-jsonl/tests/jsonl.spec.ts` | 两组共享测试的实际适配示例 | 已核对注册调用，未执行 |

[持久化契约](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence/tests/contract.ts#L139)、[实时契约](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence/tests/live-write-contract.ts)、[JSONL 测试](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence-jsonl/tests/jsonl.spec.ts#L338)。

这两组 helper 位于测试目录，未被持久化包的 npm 公共 exports 导出。实现时应在固定版本的上游测试工作区内挂载新后端运行，或在遵守 MIT 许可和保留许可文本的前提下维护版本固定的测试夹具，不能引用不存在的公共 `testing` 导出。

文件清单、SHA-256、Git blob ID 和固定链接见 [upstream-lock.json](upstream-lock.json)。本轮没有复制上游实现到主仓库。
