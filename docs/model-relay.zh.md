# 换一个模型继续任务

[English](model-relay.md) · [跨机器交接](handoff.zh.md)

ContextMesh 支持在同一个 DeepSeek Harness 会话中切换到其他已配置模型，包括不同的 Provider 路由。保留原始 Session 和事件历史，已完成的工具调用作为历史传递，不因切换重新执行。

## 使用条件

继续使用唯一的 `dsh-contextmesh-handoff` 插件，以及本仓库锁定的 DSH 运行时和兼容补丁。服务端和参与设备需要一起更新。服务端声明 `model-relay-v1`，缺少模型选择桥接的旧设备不能进行模型接力。

模型凭证在实际执行任务的设备单独配置，不进入接力记录，也不随交接传送。接收设备需要配置会话当前的 Provider 和模型路由；会话此前已经切换离开的旧 Provider 无需继续安装。

当前支持文本和已完成的工具调用、工具结果。图片、附件、spill 资源、子 Agent、持久终端、后台任务、计划任务和待处理输入暂不支持接力，应先结束或移除。各适配器负责转换 DSH 的公共消息格式和自身私有重放状态，不能将模型列表中的所有组合理解为都已通过 ContextMesh 认证。

## 在当前设备换模型

打开会话，使用 DSH 原有模型选择器。跨 Provider 时，确认后续请求会将所需历史发送给目标提供方的提示；取消保留当前选择和草稿。

ContextMesh 暂停新输入，等待已接收的当前工作结束，完成目标检查，追加原生 `model/selection` 事件并确认远程持久化，再开放输入。选择模型本身不生成回复，下一条消息使用新路由。启用 ContextMesh 后，这项操作只修改当前会话，不改变其他会话的全局默认模型。

仍然只有一个插件，无需安装新的模型接力插件。当前任务超过等待时限时，继续使用原模型；等任务结束后再切换。

## 交接沿用当前模型

在输入区选择接收设备，点击“交接”。ContextMesh 携带会话当前的 Provider、模型和推理强度，不再单独提供交接模型选择。“在此接管”遵循同一规则。

接收设备需预先配置当前模型。如果无法使用，会在停止来源写者前拒绝交接，不自动换成其他模型。如需换模型，请在拥有会话的设备上单独使用 DSH 原生模型选择器。查看远程会话时通过原生选择器换模型，会先确认并按已有模型完成接管，然后再执行你请求的本机模型切换；取消接管保留模型和草稿。

普通目录无需 Git；代码工作区需相同基准提交，保持干净或先完成[确认式文件传输](files.zh.md)。

## 兼容性和容量

目标必须声明文本输入支持和上下文窗口。检查包括可移植内容、工具调用与结果配对、工具参数 JSON，以及目标支持的推理强度。显式输出上限按目标检查；省略推理强度时使用目标默认值，不继承原模型的强度。

打开“远程会话 → 模型兼容性检查”，可以只检查当前设备已打开的会话，不切换模型、不生成回复。报告展示序列化 UTF-8 字节上界、锁定版本 DSH 的启发式估算（另加 Unicode 和格式余量）、输出预留与目标窗口；两者都不是提供方 tokenizer 的精确结果。

默认使用保守字节上界。只有启发式估算能够容纳时，原生模型选择器会询问是否按估算继续；确认绑定当前历史、模型路由和 Agent，60 秒过期且只消费一次。取消不改变选择。选定策略保存在本机，重启后仍生效。跨设备交接始终使用保守检查，本机确认不会降低另一台设备的要求。实际发送时还会用组装后的消息和工具再次检查。凭证、服务可用性和提供方实际计算的容量仍可能在调用时失败。不会为完成接力而自动截断历史或用摘要覆盖原文。

路由元数据不完整时，可在现有 ContextMesh 插件配置中增加 `modelProfiles`：

```yaml
modelProfiles:
  - provider: my-provider
    model: my-model
    textInput: true
    contextWindow: 128000
    tools: true
    maxOutputTokens: 8192
```

填写提供方公布的限制。配置只能补充缺失元数据或缩小已知窗口，不能放大 SDK 已声明的上限，也不能开启 SDK 明确拒绝的输入类型。`tools: false` 拒绝工具历史和带工具的请求；`maxOutputTokens` 要求适配器显式配置输出上限并对其约束。这里不安装 Provider，也不提供模型凭证。修改配置后重启 DSH。

兼容性测试通过已安装的 Responses、Chat Completions 和 Anthropic 适配器连接本地协议测试端点，验证完整工具历史与其他路由私有状态的隔离。这验证的是请求转换，不代表线上服务可用或所有模型均已认证。

提供方私有重放状态保留在原始日志中；DSH 只有在同一适配器拥有历史与目标路由时才向它传递该状态，跨适配器使用公共消息投影。不承诺迁移模型未公开的内部状态。

## CLI

在仓库中通过运行中的 DSH 私有控制 socket 操作。自定义目录可增加 `--state-dir`。

```sh
pnpm cli models
pnpm cli model-check SESSION_ID PROVIDER MODEL
pnpm cli model-select SESSION_ID PROVIDER MODEL
pnpm cli model-select SESSION_ID PROVIDER MODEL --allow-estimate
pnpm cli model-select SESSION_ID PROVIDER MODEL --reasoning-effort high --operation-id UUID
pnpm cli model-relay-status UUID
pnpm cli handoff SESSION_ID TARGET_NODE_ID
pnpm cli takeover SESSION_ID --confirm
```

结果不确定时，使用相同操作 ID 和相同模型选择重试或查询；用同一个 ID 请求其他模型会被拒绝。CLI 换模型代表明确要求后续将所需历史发送给指定提供方。

## 失败和中断

模型切换记录绑定原始 Session incarnation、写入方和历史切点。响应丢失后通过记录与原生事件核对，不重复追加模型选择。结果未知期间保持输入冻结，客户端保留草稿。

请保持设备运行并恢复连接。重启后可直接确认已保存的选择，无需调用模型。没有选择事件的操作，只有在原写者确认关闭，或通过显式恢复使其失效后，才可判定未完成；仅租约到期不足以推断安全回滚。外部工具仍遵循[交接恢复说明](handoff.zh.md#中断与恢复)。切换后的模型调用失败不会撤销工具副作用，也不会自动换用其他 Provider。

## 数据库升级

当前服务端使用 schema **6**。升级前备份 PostgreSQL 并停止旧写者。可从 schema 1–5 迁移，保留已有 header 和事件，增加模型切换记录及接管的可选目标模型。旧服务端拒绝 schema 6，回滚需要恢复备份。DSH 原生 Session 格式不变。

同一插件已提供[设备配对](devices.zh.md)。
