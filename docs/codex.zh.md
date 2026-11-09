# 使用 Codex CLI 接续会话快照

[English](codex.md) · [设备配置](getting-started.zh.md) · [原生存储](native-agents.zh.md)

在 Mac 上可从 [Codex 桌面侧栏](codex-desktop.zh.md)接管远程 DSH 任务，或发布会话快照供远程 DSH 接续。

可选的 Codex 适配器已包含在现有 ContextMesh CLI 中。它将已完成的 DSH 或 ContextMesh 管理的 Codex 快照导入为**本机新的 Codex 线程**，再通过 Codex 原生 app-server 发送新指令。源会话保留原历史和写入权。这是明确的快照复制，不会自动抢占执行中的任务。

运行中的 DSH 任务可通过[确认接管后自动续跑](confirmed-takeover.zh.md)转移；下方 `import` 命令仍只是快照复制，保留来源所有权。

需要在 DSH 继续稳定归档时，使用 [Codex → DSH 导入](codex-return.zh.md)。它创建新的 DSH 会话并等待你的下一条指令，不停止或转移运行中的 Codex；接收端仅需自己的模型和现有 ContextMesh 插件。

## 使用前

- 单独安装受支持的官方 Codex CLI，确保 PATH 中可以执行 `codex`。目前使用 **0.154.0** 验证；兼容的新 0.x 版本需要提供相同 app-server 接口。ContextMesh 不捆绑 Codex，也不增加第二个 DSH 插件。
- 在接收端配置 Codex 登录和模型服务。ContextMesh 通过 Codex 使用本机配置，不上传认证文件，也不复制源端模型密钥。
- 通过 `contextmesh setup` 连接 schema 8 Server，沿用[服务端指南](deployment.zh.md)中的 HTTPS 连接。
- 先结束源端当前轮次及工具调用。本预览支持文本和历史工具引用；附件、未确认的工具执行结果、无法解释的投影及过大上下文会在导入前被拒绝，不会静默删减。

## 导入与继续

在接收设备执行：

```sh
contextmesh list
contextmesh codex import SOURCE_SESSION_ID \
  --cwd /absolute/path/to/local/project \
  --model YOUR_LOCAL_CODEX_MODEL
```

目录和模型使用本机配置，不强制继承源端模型或绝对路径。普通文件夹也能使用，无需 Git；该命令不复制工作区文件。

结果包含以 `codex:` 开头的新 `sessionId`、原生 `threadId` 和 `operationId`。导入只保存上下文，**不会启动模型轮次**。需要继续时明确发送新指令：

```sh
contextmesh codex run CODEX_SESSION_ID --message "根据之前的结果继续。"
contextmesh codex status CODEX_SESSION_ID
```

`run` 恢复本机原生线程，沿用导入时选择的模型、目录和权限。每次运行默认最多等待 30 分钟，可用 `--timeout-seconds` 指定 10–3600 秒。每轮确认的结果先归档到远端 Server，再报告保存成功；app-server 重启后，后续命令恢复同一线程。Codex 会话使用 `contextmesh list --adapter codex` 或 `export ID --adapter codex` 查看，不混入 DSH 的原生恢复目录。

默认原生运行权限为**只读**。确实需要编辑本机工作区时，在**导入命令**增加 `--workspace-write`。源端系统消息和工具配置作为参考内容导入，不变成接收端权限；历史工具调用与结果转换为引用文本，不变成可执行的函数调用。新任务仍由本机 Codex 策略控制。不支持的交互审批会被拒绝，CLI 不会擅自批准。

需要将已保存的 Codex 快照复制到另一台设备时，先配置那台设备的 Codex，再执行：

```sh
contextmesh codex import CODEX_SESSION_ID --from codex \
  --cwd /absolute/path/on/this/device --model YOUR_LOCAL_CODEX_MODEL
```

这会创建另一个线程和远程会话，并记录来源，不会转移原写者或自动执行其未完成任务。已有非托管 Codex 线程不会被自动采集。托管线程应通过 ContextMesh 命令使用；其他客户端修改了可见的原生轮次或事件历史后，会阻止继续执行并要求检查。绕过适配器直接运行原生 Codex，不受 ContextMesh 远程租约约束。

## 配置与隐私

`--codex-home DIR` 指定本机 Codex 配置目录，`--codex-bin PATH` 指定可执行程序，也可用 `CONTEXTMESH_CODEX_BIN` 作为程序路径。导入、执行与恢复同一本机绑定时，应使用相同的原生目录。

私有导入记录与线程绑定保存在 `~/.contextmesh/data/codex-bridge`，可用 `--state-dir` 更换。记录可能含有导入上下文，应保持私有。Server 在 `codex` 适配器下持久化可移植上下文、来源身份与摘要、原生线程、轮次及事件快照。Codex 自己仍维护原生本地历史。远端归档由这些适配器命令产生，不会自动同步其他 Codex 操作。

可移植协议保留源会话 ID、incarnation 和固定事件数量。DSH 通过官方的会话内容投影恢复当前有效历史，包括替换操作。模型服务私有重放状态和隐藏推理不进入可移植文本，源原生日志保持完整。上下文上限为 1 MiB，原生分页和归档也有数量及大小限制；目标模型仍可能拒绝超过自身容量的输入。

## 操作中断

使用导入返回的操作 ID 查看状态，不输出完整会话内容：

```sh
contextmesh codex status IMPORT_OPERATION_ID
```

导入可带 `--operation UUID` 固定操作身份。已完成操作返回原结果，换来源或目标参数则拒绝复用。原生创建或上下文注入的响应丢失时，会标记待处理，**不自动重试**。重新导入前应检查私有记录与原生线程；源会话仍然完整。

执行结果不确定时，不要重发原指令。先停止并确认原生进程及工具退出，再执行：

```sh
contextmesh codex status CODEX_SESSION_ID
contextmesh codex reconcile CODEX_SESSION_ID --confirm-stopped
```

核对流程检查原生终止状态和远程身份，恢复已停止写者并归档已经完成的结果，不创建新轮次。活动写者、后台命令、未完成轮次、身份变化或原生历史不可用都会阻止恢复。失败后保留待检查操作，不撤销工具副作用，也不根据租约超时推断工具已经停止。

## 兼容性与验证

适配器使用官方 [Codex app-server 协议](https://learn.chatgpt.com/docs/app-server)，包括初始化、线程创建与恢复、上下文注入、分页历史和轮次生命周期。集成测试覆盖响应丢失及写者保护。设置 `CONTEXTMESH_TEST_CODEX_BIN` 指向已安装 CLI 可启用隔离端到端测试；测试使用临时原生目录和本地受控 Responses 模型服务，无需付费模型凭据。这验证原生协议与上下文传递，不代表真实模型的推理质量评测。
