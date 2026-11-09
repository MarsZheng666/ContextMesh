# 在 Codex 桌面版使用 ContextMesh

[English](codex-desktop.md) · [安装并连接设备](getting-started.zh.md) · [部署服务端](deployment.zh.md)

在 Codex 左侧栏点击 **ContextMesh**，即可打开独立面板。Mac 上的 Codex 桌面版可以通过共享的 ContextMesh Server 接收会话和发布快照。面板会显示 DeepSeek Harness 会话和 Codex 归档，具体可执行的操作取决于源端 Agent 和会话状态。

## 在 Mac 上启用面板

1. 安装或升级 [ContextMesh 托管运行时](runtime.zh.md)。运行 `contextmesh setup`，连接另一台设备使用的同一个 HTTPS Server。新设备可以用配对码加入。
2. 登录 Codex 桌面版，确认准备使用的本机模型可用。
3. 执行一次 `contextmesh codex install-panel`。在桌面应用中切换到 Codex，然后点击左侧栏的 **ContextMesh**。如果入口还没出现，重启桌面应用。如果应用装在其他位置，可以用 `--codex-bin /absolute/path/to/bundled/codex` 指定应用自带的 Codex 程序。

运行时注册一个 ContextMesh 侧栏入口，并提供面板所需的本地服务。远程 DSH 沿用现有的单个 ContextMesh 插件。要从桌面发布快照，Server 需支持 `codex-gui-archive-v1`，数据库版本仍为 schema 8。

## 接收共享会话

1. 在 **Receive a shared session** 中选择会话，再选择 Mac 上的项目目录。新会话使用接收端 Codex 的默认模型。点击 **Choose Folder…** 可以用 macOS 原生选择器浏览任意有权访问的文件夹，也可以直接输入绝对路径。需要改项目文件时再开启项目写权限。
2. 根据会话状态选择操作。
   - **Review import** 将已保存的上下文复制到新的 Codex 会话。打开后发送下一条消息即可接续。
   - **Review takeover** 转移受支持的在线会话。ContextMesh 先检查接收端模型和工作区，再请求源端停止，随后由 Codex 自动续跑未完成的任务。
3. 在 **Recent transfers** 按会话标题找到交接记录，完成后点 **Open in Codex**。需要恢复或正在交接的会话会在列表里标明状态。

在线接管支持普通目录。Git 项目需要两端处于同一个提交且工作区干净。源端支持范围、工作区权限和故障处理见[确认接管与恢复](confirmed-takeover.zh.md)。

## 发布 Codex 会话

1. 等待 Codex 会话和工具执行结束，在 **Publish a conversation** 中选择已保存的会话，并在 **Archive contents** 中选择归档范围。
   - **Full archive** 包含已保存的消息和受支持的工具历史，要求最后一轮已经完成。
   - **Conversation text only** 共享已保存的用户与助手文字，包括中断前已保存的文字。工具历史和附件留在 Codex。完整归档过大或含有不支持的内容时，可以选这个范围。
2. 核对范围后确认发布。接收端使用 DSH 时，在 ContextMesh 中选择 **Continue a Codex archive**（继续 Codex 归档），按标题或归档编号找到会话，选择目录并确认。在新的会话里发送下一条指令。

归档上限为 1 MiB，已导入且属于所选范围的上下文也计入大小。原会话仍可在 Codex 中打开。Server 将共享快照持久化到 PostgreSQL，同一命名空间中已连接的设备可以查看。Codex 登录态和模型凭据保存在 Mac 上。[归档格式与恢复](codex-return.zh.md)
