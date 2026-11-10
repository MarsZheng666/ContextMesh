# Use ContextMesh in Codex Desktop

[中文](codex-desktop.zh.md) · [Install and connect a device](getting-started.md) · [Server setup](deployment.md)

The **ContextMesh** entry in the Codex sidebar opens its own panel. A Mac running Codex Desktop can receive sessions and publish snapshots through a ContextMesh Server shared with other devices. The panel shows DeepSeek Harness sessions and Codex archives. Available actions depend on the source agent and session state.

## Enable the panel on the Mac

1. Install or upgrade the [managed ContextMesh runtime](runtime.md). Run `contextmesh setup` and connect to the same HTTPS Server as the other device. Use a pairing code for a new device.
2. Sign in to Codex Desktop and make sure the local model you intend to use works.
3. Run `contextmesh codex install-panel` once. In the desktop app, switch to Codex and select **ContextMesh** in the sidebar. If the entry is missing, restart the app. If the app was installed in a different location, pass `--codex-bin /absolute/path/to/bundled/codex`.

The runtime registers one ContextMesh sidebar entry and supplies its local service. On the remote DSH device, use the existing single ContextMesh plugin. Chunked archives require a schema 9 Server that advertises `chunked-archives-v2`. Existing servers and archives remain accessible through the older interface.

## Receive a shared session

The panel checks the Server while it is visible. When the connection returns, it refreshes the shared session list and keeps the current selection if the session is still available.

1. In **Receive**, select a shared conversation. **Choose Folder…** opens the macOS folder picker for any accessible folder. If you cancel, your previous selection is kept. New conversations use the receiving Codex model. Enable project writes when the task should edit files.
2. Choose the action shown for the session.
   - **Review import** previews the records that fit the receiving Codex model. Use the optional next instruction to find relevant history, or use **Browse full archive** to select an excerpt. Confirm the import, then send the next message in Codex.
   - **Review takeover** transfers ownership of a live session from a supported source. ContextMesh checks the model and workspace before requesting that the source stop. Codex then continues any unfinished work.
3. In **Activity**, find the conversation by title, then select **Open in Codex**. The activity count includes pending and unresolved transfers.

For live takeover, ordinary directories are supported. A Git task needs clean workspaces at the same commit on both devices. See [takeover and recovery](confirmed-takeover.md) for source support, permissions and interrupted transfers.

## Publish a conversation

1. Wait for the Codex conversation and any tools to finish. In **Publish**, select the saved conversation and choose **Archive contents**.
   - **Conversation and tool history** includes saved messages and supported tool records, including recorded logs from interrupted turns after tools have settled. The review shows the record count, size and any parts the adapter could not export.
   - **Conversation text only** shares saved user and assistant messages, including text saved before an interruption.
2. Review the scope and confirm publication. In DSH, select **Continue a Codex archive**, find it by title or archive reference, choose the receiving directory and confirm. Send your next instruction in the new conversation.

The Server stores complete exported records in PostgreSQL as blocks of up to 512 KiB. Each record has a byte-range index, and large logs have searchable anchors for errors and paths. Full history stays available to devices in the same namespace even when a receiving model uses only a subset. Interrupted uploads can resume from **Activity → Retry publication**. Archives published by an older Server use its legacy 1 MiB format. When Activity offers **Use conversation text only**, it opens Publish with the original conversation and text-only scope selected for review.

Codex resolves the model from the receiving project. ContextMesh reads the available window from the effective Codex configuration or a matching local model profile. If it cannot determine a window, set a conservative token window under **Advanced context settings**. The estimate reserves space for the receiving prompt, tools, user input and output. For a different model after import, use the panel to prepare a new import. [Archive format and recovery](codex-return.md)
