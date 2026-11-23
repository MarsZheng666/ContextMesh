# ContextMesh for Antigravity

Connect Antigravity to the same ContextMesh Server as your DSH and Codex devices. Each device uses its own paired connection file. The Server stores the shared history. The receiving model runs in the project you open on that device.

## Installation

Use Node 24 and a schema 11 ContextMesh Server. With the matching repository checkout and pnpm installed, build the plugin and install the resulting directory with the Antigravity CLI:

```sh
pnpm install --frozen-lockfile
pnpm build:antigravity
agy plugin install ./dist/antigravity
```

If you received a built copy, pass the unpacked directory containing `plugin.json` to `agy plugin install`. In **Customizations → Installed → ContextMesh**, set the absolute path to this device’s private paired `connection.json`, enable the plugin and its hooks, and open **ContextMesh** in the side panel. Keep the plugin running for background synchronization.

| In the panel                        | What it does                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Publish → Share and sync**        | Select a native conversation and give it a recognizable title. Uploads saved visible messages, tool calls and results and follows future records.                                                                                                                                                                                          |
| **Live conversations → Follow**     | Choose a shared conversation once. New records and missed updates arrive automatically in the panel.                                                                                                                                                                                                                                       |
| **Live conversations → Take over…** | Confirm to open a new native chat. Its model completes a readiness turn before the Server asks the source to stop. After the final tool results arrive, the receiver claims the same shared conversation. Interrupted work continues automatically. A completed task waits for your next message. Keep both devices online during handoff. |
| **Publish → Publish snapshot**      | Creates a portable archive of the selected native conversation up to its last complete saved record.                                                                                                                                                                                                                                       |
| **Receive**                         | Preview the archive and optionally add an instruction. From a conversation side panel, continue in a new background chat in the same project. From the full-page plugin, choose **Copy for a new chat**, then paste and send in your destination project.                                                                                  |
| **Publish**                         | Send a short handoff note under a title of your choice.                                                                                                                                                                                                                                                                                    |

The plugin uploads explicitly shared content, including tool arguments and output. It reads the native transcript locally and excludes hidden reasoning and host-injected user metadata. The current preview budgets for a 16k window, reserving room for the prompt and the reply. Snapshot exchange copies conversation context; it does not move project files.

An active Antigravity source acknowledges transfer at a native idle boundary after its background tools settle. When receiving from Codex, its source worker waits for the native turn to settle. DSH and Codex can also take over a shared Antigravity task. Select the share in the receiving panel, choose the local project, and confirm. The receiver checks its project and model before requesting the source to stop.

## 中文

每台设备使用自己的配对文件连接同一台 ContextMesh Server。Server 持久化共享历史，接收端在所选项目中使用自己的模型执行任务。

**安装**：准备 Node 24 和 schema 11 Server，在仓库根目录执行上面的三条命令。拿到构建产物后，也可以直接用 `agy plugin install` 安装包含 `plugin.json` 的目录。打开 **Customizations → Installed → ContextMesh**，填写本设备私有 `connection.json` 的绝对路径，启用插件及其钩子，然后在侧栏打开 **ContextMesh**。

- **持续共享**：在 **Publish** 选择本机对话，填入标题并点 **Share and sync**。接收端只需点一次 **Follow**。插件运行时，新消息、工具调用和结果会自动同步；重连后从上次位置补齐。
- **接管执行**：在 **Live conversations → Take over…** 确认后，Antigravity 打开新对话，先用接收端模型完成预检，再通知来源设备停下。工具完成、最后的记录同步后，接收端沿用原共享会话。被打断的任务自动续跑，已完成的任务等待你的下一条消息。交接期间两端保持在线。Codex 来源会等当前原生轮次结束。反向交接时，在 DSH 或 Codex 的接收面板选择共享会话，选择本地项目并确认，即可在该端继续。
- **快照与交接说明**：在 **Publish → Publish snapshot** 发布原生对话及工具记录；用 **Receive** 预览归档，可选填下一条指令。从会话侧栏可以在当前项目后台新建对话；从全页插件入口点击 **Copy for a new chat**，在目标项目新建对话后粘贴并发送；也可以在 **Publish** 只发布手写交接说明。Codex 可以跟随共享会话或导入已发布的快照。

上传范围包括选中对话的可见消息、工具参数与输出，隐藏推理及宿主附加的用户元数据会被过滤。归档保存在远端，接续时按保守的 16k 窗口选取上下文，并给下一轮输入和输出预留空间。项目文件另行同步。
