# 在 Codex 桌面版使用 ContextMesh

[English](codex-desktop.md) · [安装并连接设备](getting-started.zh.md) · [部署服务端](deployment.zh.md)

在 Codex 左侧栏点击 **ContextMesh**，即可打开独立面板。Mac 上的 Codex 桌面版可以通过共享的 ContextMesh Server 接收会话和发布快照。面板会显示 DeepSeek Harness 会话和 Codex 归档，具体可执行的操作取决于源端 Agent 和会话状态。

## 在 Mac 上启用面板

1. 安装或升级 [ContextMesh 托管运行时](runtime.zh.md)。运行 `contextmesh setup`，连接另一台设备使用的同一个 HTTPS Server。新设备可以用配对码加入。
2. 登录 Codex 桌面版，确认准备使用的本机模型可用。
3. 执行一次 `contextmesh codex install-panel`。在桌面应用中切换到 Codex，然后点击左侧栏的 **ContextMesh**。如果入口还没出现，重启桌面应用。如果应用装在其他位置，可以用 `--codex-bin /absolute/path/to/bundled/codex` 指定应用自带的 Codex 程序。

运行时注册一个 ContextMesh 侧栏入口，并提供面板所需的本地服务。远程 DSH 沿用现有的单个 ContextMesh 插件。分块归档需要支持 `chunked-archives-v2` 的 schema 9 Server。旧 Server 和旧归档可通过旧版接口访问。

## 接收共享会话

面板可见时会检查 Server 连接。恢复连接后会自动刷新共享会话列表，并保留仍可用的会话选择。

1. 在 **接收（Receive）** 中选择共享会话。点击 **选择文件夹…（Choose Folder…）** 会打开 macOS 系统弹窗，可选任意有权访问的文件夹。取消时保留上一次选择。新会话使用接收端 Codex 的模型，需要改项目文件时再开启写权限。
2. 根据会话状态选择操作。
   - **Review import** 预览本机 Codex 模型可载入的记录。可以输入下一条指令作为检索线索，或点击 **Browse full archive**（浏览完整归档）选取片段。确认后打开新会话，在 Codex 发送下一条消息即可接续。
   - **Review takeover** 转移受支持的在线会话。ContextMesh 先检查接收端模型和工作区，再请求源端停止，随后由 Codex 自动续跑未完成的任务。
3. 在 **记录（Activity）** 按会话标题找到交接记录，完成后点 **在 Codex 中打开**。记录入口的数字包含待完成和待处理的操作。

在线接管支持普通目录。Git 项目需要两端处于同一个提交且工作区干净。源端支持范围、工作区权限和故障处理见[确认接管与恢复](confirmed-takeover.zh.md)。

## 发布 Codex 会话

1. 等待 Codex 会话和工具执行结束，在 **发布（Publish）** 中选择已保存的会话和归档范围。
   - **对话与工具记录** 包含已保存的消息和受支持的工具记录。中断且工具已停止的轮次也可保存。预览会显示条目数、大小以及无法导出的内容。
   - **Conversation text only** 共享已保存的用户与助手文字，包括中断前已保存的文字。
2. 核对范围后确认发布。接收端使用 DSH 时，在 ContextMesh 中选择 **Continue a Codex archive**（继续 Codex 归档），按标题或归档编号找到会话，选择目录并确认。在新的会话里发送下一条指令。

Server 将完整的可导出记录按最多 512 KiB 一块保存到 PostgreSQL。记录索引指向正文的字节范围，长日志可按错误和文件路径查找片段。即使模型只加载部分内容，同一命名空间中的设备仍可浏览完整归档。上传中断后，在 **记录 → 重试发布** 继续。旧 Server 发布的归档使用其原有的 1 MiB 格式。记录中出现 **改用仅文字** 时，点击会返回发布页，预选原会话和仅会话文字范围，核对后可再次确认发布。

Codex 采用接收项目中生效的模型。ContextMesh 从有效配置或与模型匹配的本机资料读取窗口大小。窗口未知时，可以在 **Advanced context settings** 中设置保守的 token 窗口。估算会预留接收端提示词、工具、用户输入和输出空间。导入后如果要使用另一个模型，可以在面板重新准备导入。[归档格式与恢复](codex-return.zh.md)
