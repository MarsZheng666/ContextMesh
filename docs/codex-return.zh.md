# 在 DSH 中继续 Codex 的归档上下文

[English](codex-return.md) · [Codex 配置](codex.zh.md) · [DSH → Codex 确认接管](confirmed-takeover.zh.md)

将 ContextMesh 托管归档或[从桌面侧栏发布的 Codex 快照](codex-desktop.zh.md)复制成一个**新的 DSH 会话**，使用接收设备自己的模型和目录。原 Codex 线程保持独立。本流程复制固定的归档快照，不停止 Codex，不转移其运行中的执行，也不会自动发起新的模型请求。

## 准备设备

- Server 与客户端使用同一经过检查的 ContextMesh 版本。Server 为旧归档提供 `codex-context-return-v1`。使用分块归档需要 schema 9 和 `chunked-archives-v2`。
- 源端先完成托管的 Codex 运行，等 ContextMesh 确认结果已归档。如果之前的操作结果不确定，先按 [Codex 恢复流程](codex.zh.md)核对。桌面会话在你从 ContextMesh 面板确认发布后才会进入共享归档。
- 接收端运行 DSH 和现有的**唯一一个** `dsh-contextmesh-handoff` 插件，使用本设备凭据连接同一 Server 命名空间。配置本机模型服务即可；接收端无需安装 Codex CLI，也无需配置源端模型。
- 导入前用 DSH 原生模型选择器选好模型。尚无本机选择时使用本机 DSH 默认值。插件先检查模型和导入上下文，再创建副本；不会静默替换成源端模型或随意挑选可用模型。

## 从 DSH 界面导入

打开 ContextMesh 远程会话面板中的 **Continue a Codex archive / 继续 Codex 归档**，选择可用归档，点击 **Choose folder / 选择文件夹**浏览接收端 DSH 所在机器的目录，检查本机模型并确认导入。忙碌或尚未核对恢复的归档不可选。浏览器连接远程 DSH 时，浏览的是远程主机目录，而不是浏览器所在机器的目录。

支持普通目录。本流程复制快照，不要求 Git 仓库、相同提交或干净工作区。不复制文件、附件、凭据和源端工具权限；后续指令需要的文件由你准备。所选目录会成为新 DSH 会话的工作目录和工作区边界，并受本机权限策略约束。

导入后打开含有历史上下文的新会话，**发送下一条指令即可继续**。仅导入不会生成模型轮次，也不会执行历史工具调用。之后切换模型仍使用 DSH 原生选择器。

## 从 CLI 导入

这些命令连接接收端 DSH 插件的本地控制接口，需要保持该 DSH 实例运行。在已构建的源码目录，将下方 `contextmesh` 换成 `pnpm cli`：

```sh
contextmesh codex archives
contextmesh import-codex CODEX_SESSION_ID \
  --cwd /absolute/path/on/this/dsh-device \
  --operation-id YOUR_OPERATION_UUID --confirm
contextmesh import-codex-status YOUR_OPERATION_UUID
```

`--operation-id` 可省略；CLI 会生成编号，在连接 DSH 前打印 `Import reference: ...`。请保留这个编号。同一来源、目录和本机模型使用同一编号重试，会恢复原来的副本，不新建会话。修改选项前先检查上次结果，再决定是否需要新的操作。非默认 DSH 配置可通过 `--state-dir` 指定插件现有的私有状态目录；托管运行包的 CLI 会自动选用其托管配置目录。

返回信息包含新的 `dsh:` 会话 ID、操作编号、来源 ID 和固定归档截点、归档时间、本机目录、模型及阶段（`writing`、`archived`、`published`）。状态查询不返回对话正文或凭据。`archived` 表示完整导入历史已持久化到 Server；`published` 表示接收端 DSH 已完成激活并发布会话。

使用分块归档时，本机模型和项目决定可加载的上下文预算。可以按路径或错误查找记录、选择补入片段，并在导入前查看预计加载量。历史搜索框里的文字用来查找相关记录，下一条指令仍在新会话中发送。

## 复制哪些内容

副本包含已保存的用户和助手消息。源归档里有已完成的工具和计划记录时，副本也会包含这些内容。从桌面选择 **Conversation text only** 发布的归档包含已保存的文字和归档范围说明。所有导入条目都标记为历史参考，保留来源适配器、会话和原始角色。接收端 Agent 使用自己的指令和工具权限。不支持的内容、超大上下文和未确定的原生执行会阻止导入。

DSH 头信息记录源会话实例标识、归档事件截点和上下文摘要。同一次操作的重试始终使用同一份快照，即使源端后来又增加了轮次。Server 持久化独立的 DSH 事件日志。Codex 原生线程和远程归档保持完整；新的 DSH 轮次不会反向同步进该线程。如果 Codex 会话来自此前的接管，旧的 DSH 来源仍保持只读，返回的 DSH 会话使用新身份。

## 恢复中断的导入

DSH 插件私有状态目录中的 `codex-imports/` 保存固定副本和 HTTP 操作编号，可能包含对话正文。这些是本机恢复数据，与 Server 持久化的会话历史分开；重试时保留原有配置及状态目录。

1. 保持原 Server 连接、目录和模型，使用保留的编号查询 `import-codex-status`。临时连接错误可用同一操作编号重试原命令，已经确认的 HTTP 写入不会重复追加。
2. 未完成的导入历史不会出现在普通 DSH 列表中，普通写入也会被阻止，直到预期历史完整。导入写者过期或失败后，先确认旧导入进程及相关工具已经停止；租约过期本身不代表进程已停止。
3. 使用同一编号明确恢复：

```sh
contextmesh import-codex-recover YOUR_OPERATION_UUID --confirm-stopped
```

恢复会将现有日志与保存的导入历史逐条核对，关闭并恢复该操作的写者，只补齐缺少的部分，不重放原生任务。如果历史或会话身份已改变，会停止并要求检查，不覆盖已有内容。完整副本可以重新发布，无需新建会话。界面也会在导入待完成时提供重试和确认恢复入口。

需要持续共享时，使用[自动同步流程](live-sync.zh.md)：首次共享和跟随后自动更新，确认接管后保留原有跟随关系。上文的快照流程仍是独立功能。
