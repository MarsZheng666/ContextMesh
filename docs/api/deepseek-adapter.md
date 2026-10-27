# ContextMesh DeepSeek 插件接口文档

本接口文档说明 DeepSeek Harness 如何通过 ContextMesh 保存、读取和恢复 Session，覆盖配置项、持久化服务、会话句柄、插件入口和内部辅助方法。每个接口列出参数、返回值、内部处理和调用条件。

适用源码：`packages/adapter-deepseek/src/index.ts`。版本基线：ContextMesh `6db621accc4f2b72f6123ded8b8558d9438a7524`，DSH `0.2.1-rc.3`，Session 格式版本 `4`。更新日期：2026-10-26。

# 一 调用关系与 TypeScript 语法

```text
DSH 的 Agent 和 Session 生命周期
    ↓ 调用 ctx.sessionPersistence
RemoteSessionPersistence
    ↓ 返回 RemoteSessionHandle
MeshClient
    ↓ HTTP 请求和 JSON 响应
ContextMesh Server
    ↓ PostgreSQL 事务
Session 头信息、事件日志、写入权、幂等操作记录
```

`RemoteSessionPersistence extends SessionPersistence` 相当于 Java 类继承一个抽象类，并实现抽象方法。Cordis 把实现注册为 `ctx.sessionPersistence`；DSH 调用这个服务时，实际执行远程持久化插件。

`RemoteSessionHandle implements SessionHandle` 相当于 Java 的接口实现。这个类未直接导出，调用方通过 `create/open` 拿到声明为 `SessionHandle` 的对象。

| 写法                | 含义                                                      |
| ------------------- | --------------------------------------------------------- |
| `options?: T`       | 参数可以省略；传入时应符合类型 T                          |
| `Promise<T>`        | 异步操作完成后返回 T；失败时 Promise 被拒绝               |
| `Promise<void>`     | 需要等待操作完成，但没有业务返回值                        |
| `await operation()` | 等到异步操作完成后，继续当前函数                          |
| `readonly`          | TypeScript 限制通过该属性重新赋值；不代表对象自动深度冻结 |
| `private`           | 类内部使用的方法或字段，不属于外部调用接口                |
| `options?.signal`   | options 存在时才读取 signal                               |
| `value ?? fallback` | value 为 null 或 undefined 时使用 fallback                |

## 连接类型

`create/open` 返回的是逻辑句柄，不是 TCP Socket、WebSocket 或一条专门持续占用的 HTTP 请求。句柄保存 Session 身份、读写权限、写入代次等信息；后续 read、append、flush、renew、close 分别发 HTTP 请求。

底层 `fetch` 可以复用 HTTP Keep-Alive 连接，但 Session 不与某条 TCP 连接一一绑定。部署中的 SSH 隧道负责网络转发，与 SessionHandle 的生命周期独立。

# 二 公共数据类型

## SessionHeader

创建或打开会话时使用的不可变头信息；历史消息保存在事件日志中，不放在 header 里。

| 字段              | 类型                  | 是否必需 | 含义                                           |
| ----------------- | --------------------- | -------- | ---------------------------------------------- |
| `id`              | `SessionId`           | 是       | 原生会话 ID；运行时以字符串传输                |
| `version`         | 当前 Session 格式版本 | 是       | 此版本为 4；与 HTTP 协议版本分开管理           |
| `createdAt`       | `number`              | 是       | 创建时间，非负安全整数，Unix 毫秒              |
| `isSeeded`        | `boolean`             | 是       | 是否包含从父会话继承的事件前缀                 |
| `cwd`             | `string`              | 否       | 会话创建时的绝对目录，不会因机器切换而自动重写 |
| `parentSession`   | `SessionId`           | 否       | 父会话标识；仅有此字段不等于子 Agent           |
| `origin`          | `'subagent'`          | 否       | 标记子 Agent 会话                              |
| `delegationDepth` | `number`              | 否       | 非负整数，委派层级                             |
| `agentPreset`     | `string`              | 否       | 恢复 Agent 时使用的预设标识                    |

远端头信息通过 `nativeHeader` 校验已知字段，同时允许保留额外字段；实际传输数据仍须满足 JSON 校验。变更执行目录应通过 DSH 的工作目录服务记录新事件，不能修改已有 header 或日志。

## SessionEvent

表示会话中发生的一次记录，例如用户消息、模型回复、工具调用、工具结果、回合开始和结束、目录切换。插件按原生内容保存。

| 字段                  | 含义                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `seq`                 | 从 0 开始的连续事件序号                                          |
| `type`                | 事件类型，例如 `turn/start`、`user/message`、`assistant/message` |
| `time`                | 事件时间，非负安全整数                                           |
| `data` 等类型特定字段 | 由对应 DSH 事件类型定义                                          |
| `ignorable`           | 上游用于控制未知事件类型能否被安全忽略的标记                     |

线协议先校验基础 JSON 结构；读取时再交给 DSH 原生校验器解释事件。未知且没有 `ignorable: true` 的事件类型会被拒绝，不能因为网络返回了合法 JSON 就直接执行。

## 操作选项

| 类型                              | 字段                              | 作用                                   |
| --------------------------------- | --------------------------------- | -------------------------------------- |
| `SessionPersistenceCreateOptions` | `signal?`、`inheritedEventCount?` | 取消创建操作；声明继承事件数           |
| `SessionPersistenceOpenOptions`   | `signal?`                         | 取消打开操作                           |
| `SessionPersistenceStatOptions`   | `signal?`                         | 取消元数据查询                         |
| `SessionPersistenceListOptions`   | `signal?`                         | 取消列表查询                           |
| `SessionHandleReadOptions`        | `signal?`                         | 取消读取                               |
| `SessionHandleAppendOptions`      | `signal?`                         | 写入开始前的取消检查                   |
| `SessionHandleFlushOptions`       | `signal?`                         | 持久化屏障的取消检查与 HTTP flush 取消 |

`signal` 的类型是 `AbortSignal`。取消请求不等于撤销已提交的远程事务；网络超时或中断后，应按幂等操作规则确认结果。

## SessionPersistenceSnapshot

`stat/list` 返回的轻量观察结果，不包含事件正文。

| 字段                    | 本插件返回值                                     |
| ----------------------- | ------------------------------------------------ |
| `header`                | 已校验并复制的原生 SessionHeader                 |
| `revision`              | 由 `incarnation:generation` 构成的不透明变化标识 |
| `eventCount`            | `nextSeq`，即当前逻辑事件总数                    |
| `formatStatus`          | `'current'`                                      |
| `sizeBytes`、`location` | 此实现不返回按会话文件计算的大小或文件位置       |

revision 只用于同一服务实例、同一 Session 的变化比较。调用方不要解析它，也不要拿它代替写入权 epoch。相同 ID 的重建实例通过 incarnation 区分；generation 表示该实例日志的变化。

## RemoteHandle

服务器响应给客户端的传输对象，由 `adopt` 包装成 RemoteSessionHandle。

| 字段       | 含义                                                               |
| ---------- | ------------------------------------------------------------------ |
| `handleId` | 本次操作句柄的 UUID，不等于 Session ID                             |
| `session`  | 远程快照，包含 header、继承数、nextSeq、generation、incarnation 等 |
| `access`   | `'read'` 或 `'write'`                                              |
| `epoch`    | 当前写入代次，用于阻止旧写者继续修改会话                           |

# 三 插件配置

`export const name = 'contextmesh-session-persistence'` 是插件模块标识；`export const inject = ['sessions']` 声明依赖 DSH SessionStore 服务。可安装包名称是 `dsh-contextmesh`，与模块 name 不是同一概念。

`interface Config` 描述 TypeScript 配置类型；同名的 `const Config` 是 Cordis 在运行时校验和补默认值的 schema。

| 参数                | 类型       | 默认值                  | 内部用途                                          |
| ------------------- | ---------- | ----------------------- | ------------------------------------------------- |
| `endpoint`          | `string`   | `http://127.0.0.1:8787` | ContextMesh HTTP 服务地址；schema 会补默认值      |
| `token`             | `string?`  | 不设置                  | 直接提供 Bearer Token，优先于 tokenEnv            |
| `tokenEnv`          | `string?`  | `CONTEXTMESH_TOKEN`     | 从该环境变量读取 Token                            |
| `batchDelayMs`      | `number?`  | `200`                   | 实时事件开始缓冲后的批量写入等待时间，至少 1 毫秒 |
| `timeoutMs`         | `number?`  | `10000`                 | 单次 HTTP 尝试的超时，至少 100 毫秒               |
| `renewalMs`         | `number?`  | `15000`                 | 写句柄续租间隔，至少 100 毫秒                     |
| `allowInsecureHttp` | `boolean?` | `false`                 | 是否允许非本机地址使用明文 HTTP                   |

token 解析顺序：`config.token ?? process.env[config.tokenEnv ?? 'CONTEXTMESH_TOKEN']`。若直接传入空字符串，不会回退到环境变量，而是在启动时因没有有效 token 失败。

endpoint 不能包含用户名、密码、查询参数或 fragment。默认允许本机回环地址使用 HTTP；其他地址应使用 HTTPS。通过 SSH 隧道连接本机回环入口时，HTTP 请求由加密隧道转发。

启动时从服务端读取 leaseMs，并要求 `renewalMs × 3 <= leaseMs`。当前服务默认租约 60000 毫秒，因此默认每 15000 毫秒续租符合要求。timeoutMs 是每次 HTTP 尝试的上限；加上重试后，整个方法的耗时可能超过该值。

# 四 RemoteSessionPersistence 服务接口

## constructor

```ts
constructor(ctx: Context, client: MeshClient, config: Config)
```

参数：ctx 是 DSH 插件上下文；client 是已配置 endpoint 和 token 的 HTTP 客户端；config 是本插件配置。构造函数调用 `super(ctx)`，由抽象基类注册 `sessionPersistence` 服务。构造函数本身不创建会话、不建立专属网络连接。

内部状态：handles 保存所有本地活动句柄；writers 按 Session ID 保存写句柄；acquisitions 跟踪正在 create/open 的 Promise；stopping 阻止停止期间新增句柄。

## create

```ts
create(
  header: SessionHeader,
  options?: SessionPersistenceCreateOptions,
): Promise<SessionHandle>
```

用途：创建新的远程会话并取得写入权。由 DSH 调用插件实现，网络请求的目标是 ContextMesh Server。

| 参数                          | 含义与条件                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `header`                      | 要保存的不可变会话头信息                                                                                |
| `options.signal`              | 已取消则提前失败；也传给创建 HTTP 请求                                                                  |
| `options.inheritedEventCount` | 从父会话继承的事件数，必须是非负安全整数。isSeeded=false 时只能省略或为 0；isSeeded=true 时必须显式提供 |

返回值：一个 access 为 write 的 SessionHandle，可以读历史、追加、flush 和 close。创建本身不上传历史事件，也不会启动模型。

内部处理：

1. 检查取消信号。
2. 调用 materializeCreateHeader，取得可无损 JSON 表达的独立快照；校验格式版本。
3. 检查 inheritedEventCount 与 isSeeded 是否匹配。
4. 通过 acquire 跟踪正在进行的创建。
5. 调用 client.create，发送 `POST /v1/sessions`，携带 operationId、instanceId、adapter、header 和 inheritedEventCount。
6. 服务端在事务中创建 pending 会话并分配写句柄；相同 operationId 的重试复用操作结果。
7. adopt 把 RemoteHandle 包装成本地对象，登记到 handles 和 writers，并启动写句柄续租。
8. 捕获的远程业务错误转换成 DSH 对应错误。

可见性：create 成功后，同一 MeshClient 实例可以查询或打开 pending 会话；其他实例在首次非空 append 或 flush 使其 materialize 后才可见。首次非空 append 或 flush 之前关闭空会话，会移除这个未物化会话。

常见失败：SessionAlreadyExistsError、版本不支持、参数校验错误、服务正在停止、鉴权或网络错误。

## open

```ts
open(
  id: SessionId,
  access: 'read' | 'write',
  options?: SessionPersistenceOpenOptions,
): Promise<SessionHandle>
```

参数：id 是已保存的会话 ID；access 决定读写权限；options.signal 用于取消打开及写模式打开时的预读。

返回值：对应会话的 SessionHandle。read 不取得写入权，可以与现有写者并存；write 是可读写句柄，需要独占写入权。

内部处理：acquire 调用 openHandle → `POST /v1/sessions/{id}/handles` → 校验返回 header 的 ID → adopt。write 模式还会完整读取并校验日志，完成后才把句柄交给调用方。中间失败时尽量关闭已取得的句柄，再映射错误。

常见失败：SessionPersistenceNotFoundError、SessionAlreadyOwnedError、日志损坏或格式不支持。旧写者失联且需要人工确认时，可返回 RECOVERY_REQUIRED；这个错误当前保留为 MeshError，不自动抢占。

## stat

```ts
stat(
  id: SessionId,
  options?: SessionPersistenceStatOptions,
): Promise<SessionPersistenceSnapshot | undefined>
```

参数：id 是目标会话；options.signal 取消元数据查询。

返回值：存在时返回轻量快照，不存在时返回 undefined。不会读取整段事件，也不会占用写入权。

内部处理：调用 `GET /v1/sessions/{id}?instanceId=...`；把远端 null 转为 undefined，其余结果交给 observation，校验和复制 header，并生成 revision、eventCount 和 formatStatus。该方法没有统一调用 mapped；MeshClient 错误可能原样抛出。

## list

```ts
list(
  options?: SessionPersistenceListOptions,
): Promise<readonly SessionPersistenceSnapshot[]>
```

参数：options.signal 取消分页查询。

返回值：当前客户端实例可见的所有会话快照；不承诺排序，不含完整事件正文。readonly 是接口类型约束。

内部处理：MeshClient 循环请求 `GET /v1/sessions?instanceId=...&after=...`，直到 cursor=null；逐项调用 observation。只显示当前服务端 namespace 的内容，并遵守 pending 会话的实例可见性。

## flush

```ts
flush(): Promise<void>
```

参数：无。返回值：所有本次调用捕获的活动写句柄完成持久化屏障后成功；没有业务结果。

内部处理：对 writers 的当前快照并发执行句柄 flush；如果句柄已经开始 close，就等待其 closing Promise。使用 Promise.allSettled 保证某个句柄失败时仍等待其他句柄完成，最后把失败汇总为 AggregateError。只读句柄不参与。

这不会停止 Agent，也不会释放全部写入权。与单个 handle.flush、DSH 的 ctx.sessions.flush 的区别见后文。

## shutdown

```ts
shutdown(): Promise<void>
```

参数：无。返回值：停止接收新句柄，并完成已有句柄关闭后成功。

内部处理：设置 stopping=true → 等待已开始的 acquisitions 全部结束 → 并发 close 所有 handles → 汇总关闭失败，必要时抛 AggregateError。它是插件卸载的清理入口，不会删除已物化的历史会话。

## persistBatch

```ts
persistBatch(
  _header: SessionHeader,
  handle: RemoteHandle,
  events: StoredEvent[],
  operationId: string,
): Promise<number>
```

参数：_header 当前实现未使用，保留为统一存储调用及故障注入的参数；handle 指定远程句柄及 epoch；events 是本批事件；operationId 是本次写入及其重试共用的 UUID。

返回值：服务端响应的 nextSeq，即追加成功后的下一事件序号。

内部处理：调用 client.append，发送 epoch、expectedNextSeq、events 和 operationId。服务端校验写入权与顺序，在 PostgreSQL 事务中写入事件并保存幂等结果。这个方法供内部写路径和测试使用，不应由业务调用方绕过 SessionHandle 的排队与校验直接调用。

## report 与 forget

| 方法                                  | 参数                 | 返回值 | 内部处理                                                                               |
| ------------------------------------- | -------------------- | ------ | -------------------------------------------------------------------------------------- |
| `report(message: string)`             | 告警文字             | `void` | 调用 ctx.logger.warn；用于后台写入或续租失败提示                                       |
| `forget(handle: RemoteSessionHandle)` | 要清理的本地句柄对象 | `void` | 从 handles 移除；仅当 writers 中仍是同一个对象时才删除该条写者记录，避免误删后来的句柄 |

forget 只清理本地登记；释放服务端句柄由 close 发 HTTP 请求完成。

# 五 RemoteSessionHandle 会话接口

## 属性与构造函数

```ts
constructor(owner: RemoteSessionPersistence, remote: RemoteHandle)
```

owner 是管理该句柄的服务；remote 是服务器返回的句柄信息。构造时校验并复制 header，读取 access、inheritedEventCount、nextSeq，初始化本地写入游标；write 句柄启动定时续租，read 句柄不续写租约。

| 属性                  | 类型                         | 含义                                                  |
| --------------------- | ---------------------------- | ----------------------------------------------------- |
| `id`                  | `SessionId`                  | 会话 ID                                               |
| `header`              | `SessionHeader`              | 已校验的创建头信息                                    |
| `access`              | `'read' \| 'write'`          | 操作权限                                              |
| `inheritedEventCount` | `SessionLogOffset`           | 原样继承的历史前缀长度                                |
| `closing`             | `Promise<void> \| undefined` | undefined 表示未开始关闭；有值时表示首次 close 的结果 |

构造函数中的续租逻辑：每 renewalMs 调用 client.renew，发送 handleId 与 epoch；同一时间只允许一个续租请求链。续租最终失败就把 lost=true 并告警。此后本地写操作拒绝执行，不会因为下一次网络恢复就自动恢复写权。该类没有直接停止 Agent 或操作系统工具进程的代码；主动停机与交接属于上层控制。

## read

```ts
read(
  offset = 0,
  length = Number.MAX_SAFE_INTEGER,
  options?: SessionHandleReadOptions,
): Promise<SessionHandleReadResult>
```

| 参数             | 默认值                    | 含义                                 |
| ---------------- | ------------------------- | ------------------------------------ |
| `offset`         | `0`                       | 从哪个事件序号开始读，包含该序号     |
| `length`         | `Number.MAX_SAFE_INTEGER` | 最多返回多少条事件，默认读取剩余日志 |
| `options.signal` | 不设置                    | 取消 HTTP 读取与分页                 |

offset 和 length 必须为非负安全整数；offset 到达或超过末尾时返回空数组。read 和 write 两种句柄均可读取。

返回值：

```ts
{
  eventState: 'detached',
  events: readonly SessionEvent[],
}
```

eventState 表示返回的事件值与持久化存储没有共享可变引用，可以作为 DSH 恢复时的独立种子使用。这里的 detached 不表示会话已经从 DSH 注销，也不表示 HTTP 断开。

内部处理：

1. assertOpen 拒绝 closing 已设置的句柄；校验 offset 和 length。
2. MeshClient 每页最多读取 512 条；首次响应固定本次读取的 end，后续页面沿用同一切点。
3. 客户端核对会话 ID、incarnation、页内序号、nextOffset、end 和是否异常空页，防止分页拼接混入另一代会话或不连续数据。
4. 句柄再次核对 header 身份；若服务端日志末尾小于本句柄此前观察到的末尾，则按损坏处理。
5. decodedEvents 调用 DSH 原生事件校验器，assertContiguous 确认结果从 offset 连续排列。
6. 返回独立事件数组，并更新 observed。

read 不会自动排空实时缓冲区。若调用方刚向内存 Session 追加事件并需要立刻读取已持久化版本，应先执行 `await ctx.sessions.flush(session)` 或相应的 handle.flush。

## append

```ts
append(
  events: readonly SessionEvent[],
  options?: SessionHandleAppendOptions,
): Promise<void>
```

参数：events 是已带原生序号的事件数组，不能只传消息文字；首个序号必须等于当前 cursor，后续逐条连续。options.signal 在进入方法时和队列任务真正开始前检查。

返回值：本次排队写入成功后完成，没有业务结果。调用方不能把“调用了 append 但尚未 await”当成写入成功。

内部处理：assertOpen → assertWrite → 检查取消 → materializeAppendBatch 复制并校验无损 JSON → enqueue 串行排队 → write。write 先处理上次未确认结果，再校验连续序号，按最多 512 条拆批；每批分配一个 operationId，交给 persistBatch。

该实现的子批次在服务端同步事务提交后才确认，强于通用 SessionHandle 接口允许的 best-effort append。但实时路由的缓冲事件仍需 flush 才能保证全部到达持久化层。

超过 512 条的显式 append 会产生多个事务。后续批次失败时，前面的批次可能已经提交，不承诺整次大数组追加的全有或全无。幂等保护按子批次 operationId 生效，不能把它理解为任意重放整个大数组都自动去重。

当前 options.signal 没有从 append 继续传入 write/persistBatch 的 HTTP 请求，因此主要控制写入开始前的取消，不保证中途打断正在提交的子批次。

## flush

```ts
flush(options?: SessionHandleFlushOptions): Promise<void>
```

参数：options.signal 用于入口取消检查，以及最终 HTTP flush 请求；此前 drain 和待确认追加使用既有写路径。

返回值：实时缓冲和排队写入已完成、未确认批次已处理、服务端 flush 确认成功后完成。read 句柄不允许调用。

内部处理：assertOpen → assertWrite → 入口取消检查 → drain 排空实时缓冲 → enqueue 排队执行 retryUnknown → `POST /v1/handles/{handleId}/flush`。

flush 还会让 create 后一直为空的 pending 会话变为已物化，使其他实例可查询。它不清空远端历史、不释放写入权、不关闭会话，也不代表停止模型或工具执行。

## close

```ts
close(): Promise<void>
```

参数：无；故意不提供取消选项。返回值：首次关闭的 Promise；重复 close 返回同一个 Promise，成功或失败结果保持一致。

内部处理：

1. 首次调用建立 closing Promise，停止续租定时器。
2. drain 排空实时事件，等待 chain 内已有操作。
3. write 句柄再尝试确认 unknownAppend。
4. 即使前面失败，仍向 `POST /v1/handles/{handleId}/close` 发关闭请求，携带 operationId、epoch 和 failed 标记。
5. 清理定时器并调用 owner.forget，移除本地登记。
6. 任何需要报告的失败最终仍会抛出；不能因为本地对象已清理就宣称远端关闭成功。

服务端对有效写句柄释放写入权。已经物化的历史保留；尚未物化且一直为空的 pending 会话会被移除。若关闭前写入失败或租约状态异常，服务端会记录需要显式恢复的状态。网络不确定时，不能假设旧写者已释放。

close 开始后，read、append、flush 等通过 assertOpen 的新调用会被拒绝。close 处理的是句柄和写入权，不直接控制 fetch 底层连接池中的某条 TCP 连接。

## Symbol.asyncDispose

```ts
[Symbol.asyncDispose](): Promise<void>
```

参数：无。返回值：close 的 Promise。用于 `await using` 等异步资源管理场景；不会另建一套关闭逻辑。

## route

```ts
route(event: SessionEvent): void
```

参数：DSH `session/event` 事件分发出来的一条原生 SessionEvent。返回值：void；它返回时不能保证事件已经远程保存。

内部处理：structuredClone 复制事件 → 加入 buffer → 如果没有已有计时器且没有暂停，安排 batchDelayMs 后 drain。计时器触发失败时记录告警，保留未确认批次和后续缓冲；paused 阻止继续自动安排后台批量写入，后续显式 flush 或 close 会再次尝试 drain。

这个方法供插件事件监听器使用，不属于 DSH 对外的 SessionHandle 接口。不要同时把同一批实时事件手工 append 和 route 两次；正常接入时，恢复种子由 DSH 显式写入，之后的实时事件由监听器路由。

## 内部状态字段

| 字段            | 作用                                             |
| --------------- | ------------------------------------------------ |
| `chain`         | 串行执行显式追加、后台批写和持久化屏障           |
| `buffer`        | 已收到但尚未进入实时写入批次的事件               |
| `timer`         | 实时批写的延迟定时器                             |
| `heartbeat`     | 写句柄续租定时器                                 |
| `draining`      | 当前排空任务的 Promise，避免并发启动多个 drain   |
| `paused`        | 后台写入失败后暂停自动安排，保留缓冲等待显式处理 |
| `lost`          | 本地已经判定写入权不再可靠，后续拒绝写入         |
| `observed`      | 本句柄此前观察到的最大日志末尾，用于拒绝日志回退 |
| `cursor`        | 本地已确认的下一追加序号                         |
| `unknownAppend` | 尚未确认结果的子批次及其原 operationId           |
| `pendingLive`   | 已从 buffer 取出、尚未确认写入完成的实时批次     |

# 六 插件入口与生命周期

## apply

```ts
apply(ctx: Context, config: Config): Promise<void>
```

参数：ctx 为 Cordis 上下文；config 为校验后的插件配置。返回值：服务子插件完成初始化后成功，不返回句柄或 Session。

内部处理：

1. 解析 token；缺失或为空时拒绝启动。
2. 创建 MeshClient，校验 endpoint。
3. 请求 `/health/ready` 获取协议版本与 leaseMs，并检查续租间隔。
4. 在 ctx.effect 生命周期中登记清理回调与事件监听器。
5. 安装子插件，创建 RemoteSessionPersistence；等待其 Fiber 就绪。

| 监听或清理点       | 参数               | 处理                                                                     |
| ------------------ | ------------------ | ------------------------------------------------------------------------ |
| `session/event`    | `session`、`event` | 按 session.id 找到写句柄，调用 route；没有本插件登记的写句柄则不路由     |
| `session/flush`    | `session`          | 找到对应写句柄并返回其 flush Promise，使 DSH 能等待持久化完成            |
| `session/disposed` | `session`          | 若存在对应写句柄则启动 close；异步失败通过日志报告                       |
| 插件服务卸载       | 无                 | 生命周期包含服务 Fiber 释放与 shutdown，等待正在打开的句柄并关闭已有句柄 |

`session/disposed` 监听器本身不返回可等待的 close Promise；完整插件卸载另有 shutdown 作为等待路径。需要明确的持久化确认时，应等待 flush 或受控关闭，不能仅依赖发出 disposed 通知。

apply 没有自动复制代码目录、迁移工作区归属、切换模型、停止另一台机器 Agent 的逻辑。

## 三种 flush 的关系

| 调用                             | 范围                     | 调用关系                                                    |
| -------------------------------- | ------------------------ | ----------------------------------------------------------- |
| `ctx.sessions.flush(session)`    | 指定的 DSH Session       | SessionStore 分发可等待的 session/flush，插件找到对应写句柄 |
| `handle.flush()`                 | 当前持久化句柄           | 排空此句柄的缓冲，等待提交与服务端屏障                      |
| `ctx.sessionPersistence.flush()` | 此服务实例当前所有写句柄 | 并发等待每个活动写句柄的 flush 或 closing，汇总失败         |

正常 DSH 集成优先使用 SessionStore 的 flush 入口，让同一 Session 的其他持久化参与者也收到正确生命周期通知。

# 七 内部辅助方法

这些方法解释接口内部如何工作，不应作为业务方依赖的稳定入口。

## 模块级函数与校验器

| 函数或对象                     | 参数                        | 返回值                   | 内部作用                                                                    |
| ------------------------------ | --------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `mapped(error, id, op)`        | 未知错误、会话 ID、操作名称 | `unknown`                | 只把已知 MeshError 业务码映射为 DSH typed error；其他错误原样返回           |
| `nativeHeader`                 | 远端 header 对象            | Zod 校验后的 header 数据 | 限制当前版本、基本字段和绝对 cwd，保留额外字段                              |
| `storedHeader(snapshot)`       | 远端 SessionSnapshot        | `SessionHeader`          | 检查版本、执行 nativeHeader 校验，再生成无损 JSON 快照                      |
| `decodedEvents(header, input)` | 已验证 header、待解码数据   | `SessionEvent[]`         | 委托 DSH 原生 validateStoredEvents；TypeScript 的 as 断言本身不做运行时校验 |

## RemoteSessionPersistence 私有方法

| 方法                               | 参数                               | 返回值                       | 内部作用                                                                         |
| ---------------------------------- | ---------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `acquire(run)`                     | 返回 Promise<SessionHandle> 的回调 | `Promise<SessionHandle>`     | stopping 时拒绝；否则执行并登记到 acquisitions，结束后移除，使 shutdown 能等待它 |
| `adopt(remote)`                    | `RemoteHandle`                     | `RemoteSessionHandle`        | 构造句柄并登记 handles；write 额外登记 writers                                   |
| `openHandle(id, access, options?)` | Session ID、读写模式、取消选项     | `Promise<SessionHandle>`     | 执行远端打开、身份校验、包装、write 全量预读，以及失败清理                       |
| `observation(snapshot)`            | `SessionSnapshot`                  | `SessionPersistenceSnapshot` | 生成克隆 header、不透明 revision、事件数和当前格式状态                           |

## RemoteSessionHandle 私有方法

| 方法              | 参数                     | 返回值          | 内部作用                                                                                                                         |
| ----------------- | ------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `assertOpen(op)`  | 操作名称                 | `void`          | closing 已设置时抛 SessionHandleClosedError                                                                                      |
| `assertWrite(op)` | 操作名称                 | `void`          | 只读句柄抛 SessionReadOnlyError；lost 时抛 SessionOwnershipLostError                                                             |
| `enqueue<T>(fn)`  | 返回 Promise<T> 的回调   | `Promise<T>`    | 接在 chain 后串行执行；向调用方保留失败，但让后续队列仍可运行清理或重试                                                          |
| `retryUnknown()`  | 无                       | `Promise<void>` | 没有待确认批次则返回；否则复用原 events 和 operationId 写入，成功后更新 cursor、remote.session.nextSeq 并清除 unknownAppend      |
| `write(events)`   | 连续的 SessionEvent 数组 | `Promise<void>` | 先处理 unknownAppend；若调用正是同一待确认批次，确认后直接返回；其余数据校验 cursor 后按 512 条拆批并追加                        |
| `drain()`         | 无                       | `Promise<void>` | 同一时刻复用一个 draining；停止计时器，逐批把 buffer 放入 pendingLive 并排队写入；成功后清除 pendingLive，失败保留并暂停自动写入 |

retryUnknown 遇到远端 OWNERSHIP_LOST 时还会设置 lost=true。它没有直接删除失败批次，避免发生“服务器可能已提交，但客户端收不到响应，随后又用新 operationId 重复追加”的问题。校验、权限等确定性错误仍须修复原因，不能认为保留批次意味着无限重试必然成功。

# 八 HTTP 请求与幂等规则

本节说明 index.ts 通过 MeshClient 实际触发的请求，不把 TypeScript 方法误称为网络长连接。

| 调用场景         | HTTP 请求                                                         | 核心参数或结果                                                                   |
| ---------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| apply 检查服务   | `GET /health/ready`                                               | 返回 protocolVersion、leaseMs                                                    |
| create           | `POST /v1/sessions`                                               | operationId、instanceId、adapter、header、inheritedEventCount；返回 RemoteHandle |
| open             | `POST /v1/sessions/{id}/handles`                                  | operationId、instanceId、access；返回 RemoteHandle                               |
| stat             | `GET /v1/sessions/{id}?instanceId=...`                            | 返回 session 或 null                                                             |
| list             | `GET /v1/sessions?instanceId=...&after=...`                       | 返回一页 sessions 与 cursor                                                      |
| read             | `GET /v1/handles/{handleId}/events?offset=...&length=...&end=...` | end 在首次请求时省略，之后固定读取切点                                           |
| append、实时批写 | `POST /v1/handles/{handleId}/append`                              | operationId、epoch、expectedNextSeq、events；返回 nextSeq                        |
| handle.flush     | `POST /v1/handles/{handleId}/flush`                               | operationId、epoch；返回 nextSeq                                                 |
| 定时续租         | `POST /v1/handles/{handleId}/renew`                               | epoch                                                                            |
| close            | `POST /v1/handles/{handleId}/close`                               | operationId、epoch、failed                                                       |

所有上述请求都需要 `Authorization: Bearer <token>`；请求体采用 JSON。`/health/live` 是服务端另一个无需鉴权的存活检查，但 apply 使用的是受鉴权的 ready 检查。

MeshClient 每个实例生成独立 instanceId，用于客户端身份及 pending 可见性。operationId 标识一次需要幂等处理的操作；epoch 标识写入代次。三个值不能互相代替。

默认单次 HTTP 操作最多执行 3 次尝试，即首次加 2 次重试；退避为 25 毫秒和 50 毫秒。小于 500 的已知业务错误直接返回，不自动重试；网络、request 内的 JSON 解析失败及服务端错误可能重试。每次重试复用同一请求体中的 operationId。客户端取消信号触发时停止继续重试。各具体客户端方法在 request 返回后进行的 Zod 响应结构校验，不会自动重新进入该请求重试循环。

服务端在事务中保存 operationId 对应的请求摘要和结果。相同 ID、相同操作的重复请求复用结果；请求不一致则拒绝。追加结果不确定时，句柄还会保留该子批次与 ID，供后续 flush、close 或写入路径继续确认。

幂等保证防止重复写入；epoch 和服务端租约检查防止旧写者继续写。它们不保证操作系统中已经运行的 shell 命令或外部 API 副作用自动停止。

# 九 错误与取消

## 已映射业务错误

| ContextMesh 错误码   | mapped 的返回错误                               |
| -------------------- | ----------------------------------------------- |
| `NOT_FOUND`          | `SessionPersistenceNotFoundError`               |
| `ALREADY_EXISTS`     | `SessionAlreadyExistsError`                     |
| `ALREADY_OWNED`      | `SessionAlreadyOwnedError`                      |
| `HANDLE_CLOSED`      | `SessionHandleClosedError`                      |
| `READ_ONLY`          | `SessionReadOnlyError`                          |
| `OWNERSHIP_LOST`     | `SessionOwnershipLostError`                     |
| `FORMAT_UNSUPPORTED` | `SessionFormatUnsupportedError`                 |
| `CORRUPTION`         | `SessionPersistenceCorruptionError`，保留 cause |

UNAUTHORIZED、INVALID_ARGUMENT、RECOVERY_REQUIRED、UNAVAILABLE 等未列入映射的错误码仍是 MeshError；非 MeshError 原样返回。create/open/read 和写入屏障的相应捕获路径调用 mapped，但 stat/list/persistBatch 等没有对所有错误执行同样转换。

参数错误也可能直接表现为 TypeError、Zod 校验错误、序号不连续的 Error 或 AbortSignal 的取消原因。服务级 flush/shutdown 在等待全部操作后抛 AggregateError，调用方可以查看其 errors。

## 取消边界

create/open/stat/list/read 将 signal 传入对应 HTTP 操作。append 在排队前和排队开始时检查 signal，实际追加 HTTP 当前未继承该 signal。handle.flush 的排空阶段也不是整体可取消事务；只有相应入口检查和最终 HTTP flush 使用其 signal。close 不提供取消选项。

取消等待或超时不证明服务端没有提交。需要通过原 operationId、读取结果或显式恢复流程确认状态，不应直接换新 ID 盲目重做。

# 十 调用示例

## 创建并保存会话

以下使用已经装配好本插件的 ctx，演示 DSH 生命周期与持久化句柄的关系。

```ts
const session = ctx.sessions.create(id, {
  meta: { cwd: process.cwd() },
})

const handle = await ctx.sessionPersistence.create(session.header)

try {
  // 产生原生事件；插件通过 session/event 接收并缓冲。
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', {
    turn: 1,
    reason: { kind: 'completed' },
  })

  // 等待对应的实时事件持久化。
  await ctx.sessions.flush(session)
} finally {
  await handle.close()
}
```

## 只读查看已保存历史

```ts
const handle = await ctx.sessionPersistence.open(id, 'read')

try {
  const result = await handle.read(0, 100)
  console.log(result.eventState) // detached
  console.log(result.events)
} finally {
  await handle.close()
}
```

只读打开不启动模型，也不占用写入权；另一台机器可以继续拥有写句柄。

## 查询是否存在及事件数

```ts
const snapshot = await ctx.sessionPersistence.stat(id)

if (snapshot === undefined) {
  console.log('会话不存在，或对当前实例尚不可见')
} else {
  console.log(snapshot.header.id, snapshot.eventCount)
}
```

## 恢复并继续

```text
open(id, 'write') 取得写入权并验证日志
    ↓
handle.read() 读取 seed、header、继承长度
    ↓
DSH 恢复 Session，并处理恢复时生成的原生记录
    ↓
将 Session 接入 SessionStore，发布生命周期通知
    ↓
接收新 prompt，产生实时事件
    ↓
flush 确认保存，受控关闭时释放写入权
```

实际 Agent 接续优先使用 DSH 正式恢复入口。单独拿到 write 句柄不会自动创建 Agent、恢复工具、切换目录或开始模型调用。

# 十一 当前实现范围

已实现原生 Session 事件远程保存、单写者控制、分页读取、幂等子批次、续租、flush 和关闭清理。PostgreSQL 通过同步事务提交保存成功确认的批次；客户端仍在 buffer 中的实时事件只有在排空成功后才得到该保证。

这份 index.ts 不包含 Web 标题缓存与工作区归属的自动跨端同步，不包含目录映射、文件和附件字节同步、运行中终端迁移或跨模型路由控制。header.cwd 是原始机器路径，不能把远程保存路径字符串理解为另一台机器已经拥有对应目录或文件。

M1 计划加入可控跨机器 Handoff、目录映射和仓库版本检查；M2 计划加入同 Harness 的跨模型接力。故障租约过期后不自动抢写权，应先确认旧执行者已停止，再走显式恢复流程。
