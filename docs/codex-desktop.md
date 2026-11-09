# Use ContextMesh in Codex Desktop

[中文](codex-desktop.zh.md) · [Install and connect a device](getting-started.md) · [Server setup](deployment.md)

The **ContextMesh** entry in the Codex sidebar opens its own panel. A Mac running Codex Desktop can receive sessions and publish snapshots through a ContextMesh Server shared with other devices. The panel shows DeepSeek Harness sessions and Codex archives. Available actions depend on the source agent and session state.

## Enable the panel on the Mac

1. Install or upgrade the [managed ContextMesh runtime](runtime.md). Run `contextmesh setup` and connect to the same HTTPS Server as the other device. Use a pairing code for a new device.
2. Sign in to Codex Desktop and make sure the local model you intend to use works.
3. Run `contextmesh codex install-panel` once. In the desktop app, switch to Codex and select **ContextMesh** in the sidebar. If the entry is missing, restart the app. If the app was installed in a different location, pass `--codex-bin /absolute/path/to/bundled/codex`.

The runtime registers one ContextMesh sidebar entry and supplies its local service. On the remote DSH device, use the existing single ContextMesh plugin. Update the Server for desktop publishing support (`codex-gui-archive-v1`). The database stays at schema 8.

## Receive a shared session

1. In **Receive a shared session**, select a conversation and a project directory on your Mac. New conversations use the receiving Codex default model. Use **Choose Folder…** to browse any accessible folder with the macOS picker, or enter its absolute path. Enable project writes only if the task should edit files.
2. Choose the action shown for the session.
   - **Review import** copies saved context into a new Codex conversation. Send the next message in Codex to continue.
   - **Review takeover** transfers ownership of a live session from a supported source. ContextMesh checks the model and workspace before requesting that the source stop. Codex then continues any unfinished work.
3. Find the conversation title in **Recent transfers**, then select **Open in Codex**. Sessions that need recovery or have a transfer in progress show their status in the list.

For live takeover, ordinary directories are supported. A Git task needs clean workspaces at the same commit on both devices. See [takeover and recovery](confirmed-takeover.md) for source support, permissions and interrupted transfers.

## Publish a conversation

1. Wait for the Codex conversation and any tools to finish. Under **Publish a conversation**, select the saved conversation and choose **Archive contents**.
   - **Full archive** includes saved messages and supported tool history. The latest turn must have completed.
   - **Conversation text only** shares saved user and assistant messages, including text saved before an interruption. Tool history and attachments stay in Codex. Choose this when a full archive is too large or has unsupported items.
2. Review the scope and confirm publication. In DSH, select **Continue a Codex archive**, find it by title or archive reference, choose the receiving directory and confirm. Send your next instruction in the new conversation.

An archive can contain up to 1 MiB, including any earlier imported context within the chosen scope. The original stays available in Codex. The Server persists published copies in PostgreSQL, and connected devices in the same namespace can see them. Codex login and model credentials stay on the Mac. [Archive format and recovery](codex-return.md)
