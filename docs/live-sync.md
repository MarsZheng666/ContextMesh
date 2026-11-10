# Live shared conversations

[中文](live-sync.zh.md)

Share a conversation once on its source device, then choose **Receive and follow** once on each receiving device. Future messages and recorded tool executions update automatically in **Live conversations**. The existing ContextMesh plugin provides this view in both DSH and the Codex sidebar.

## Set up

1. Use matching clients and a schema **10** Server advertising `live-session-sync-v1`. Devices need credentials for the same Server namespace; sharing follows that existing access boundary.
2. In DSH, open ContextMesh and choose **Share and sync** beside the conversation. In the Codex sidebar, select a saved conversation on the publish page, choose its sharing scope, then **Share and sync**. Confirm that future records may be sent to your paired devices.
3. For Codex, review and trust ContextMesh's lifecycle hooks in the native hook settings (`/hooks` in the CLI). Changed hook definitions require review again. Source hooks coordinate new prompts, tool starts/completions and turn completion; keep them enabled while using shared ownership. The plugin installer supplies the hooks and never disables native trust checks.
4. On another device, open **Live conversations**, select the conversation, and choose **Receive and follow**. Leave DSH or the Codex integration running. Codex's sync worker keeps running when the panel closes; the panel and native session-start hook restart it when needed.

Following does not run a model or a tool. It displays a shared view; it does not continually rewrite another process's native Codex history. Choose **Continue here** when you want to execute the task on that device. Select that device's folder and confirm its permissions; its own model is used.

## What updates

- Visible user and assistant messages. Hidden reasoning, model replay state, runtime policy prompts and credential files are not collected by this view.
- With full sharing, tool start/status and saved results. Text-only sharing omits tool records. Tool arguments and output can contain sensitive project information: the confirmation applies to later records as well as the initial history.
- Tools keep a stable identity: completion updates their existing card. Full bodies are available through **Read record** and paged **Read more**; previews are not the archive.

DSH's native events are already persisted on the remote Server. The shared view references those events. Codex reads its saved native items and queues lifecycle records privately on the device before uploading. Large Codex records use verified 512 KiB blocks stored in PostgreSQL, with no 1 MiB limit on the whole conversation. The configured storage quota still applies.

The worker checks for saved records approximately every 750 ms, and the panel refreshes approximately once per second. Network latency and native persistence affect visibility. This is synchronization of records, not token-by-token output or a remote terminal stream. Native tools that have not yet produced a saved result remain pending.

## Disconnects and handoff

Receivers save each page and its cursor together. After a connection interruption or process restart, they request only missing updates. Upload identities make repeated requests safe after a lost acknowledgement. Failed requests leave queued Codex records on disk for retry. Preserve the managed data directory when upgrading.

A shared conversation has one executing source. Its native DSH/Codex IDs may change during a confirmed handoff; its shared identity and followers remain the same. DSH → Codex uses the existing receiver preflight, source stop and confirmed continuation. Codex → DSH checks the receiver first, waits for the current Codex turn and its tools to finish, reserves the exact previewed history, prepares DSH, then switches ownership before activating it. Send the next instruction in the receiving DSH session. The old Codex source cannot admit new shared prompts or tools through its ContextMesh hooks.

If the source advances after preview, prepare a fresh preview. A failed or interrupted reserved import needs the same operation's recovery, not another takeover. An unknown source state is not treated as idle. During a Server outage, new prompts/tools on a shared Codex source wait for connectivity so a disconnected old source cannot continue after another device takes ownership. Already recorded results remain queued.

Keep workspace files synchronized separately or use the existing confirmed file-transfer feature. Receiving conversation records never executes historical tools or applies their file changes.

## Upgrade

Follow [schema 9 → 10 migration](runtime.md#migrate-schema-9-to-10). Update the existing single plugin on each device and review its new hooks. Snapshot publishing/importing remains available separately; those immutable snapshots do not become live subscriptions automatically.
