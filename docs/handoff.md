# Cross-machine handoff

[中文](handoff.zh.md) · [Getting started](getting-started.md)

ContextMesh transfers a live DeepSeek Harness session between folders on two devices. Plain conversations need no Git; code workspaces retain Git validation. The remote session panel shows the shared title, project, owning device, history and handoff progress. The native conversation keeps its complete event history.

## Install the compatible runtime

ContextMesh requires **Node.js 24.9+, pnpm 11.25.0 and the exact DSH 0.2.1-rc.3 dependency graph in this repository**. Use `pnpm install --frozen-lockfile` and `pnpm build`. The compatibility patches in `patches/` add lifecycle admission, owned disposal and local sandbox workspace binding. An ordinary global DSH installation does not include these extensions; the handoff plugin refuses incompatible runtimes. Review the patches when upgrading DSH. The upstream code remains MIT licensed.

Run these commands from the repository root, on each device, with a **different private DSH home**:

```sh
export DSH_HOME="$HOME/.dsh-contextmesh-m1"
export CONTEXTMESH_NODE_NAME='My laptop'
export CONTEXTMESH_ENDPOINT='http://127.0.0.1:8787'
export CONTEXTMESH_TOKEN='your-service-token'
pnpm exec dsh plugin --profile web add "link:$PWD/packages/handoff-deepseek"
pnpm exec dsh --profile web --host 127.0.0.1 --port 3080 --no-open
```

Use the authenticated URL printed by DSH. Install only this complete plugin. The installed list shows `dsh-contextmesh-handoff`; the persistence component loads as an internal dependency. Keep using this workspace's `pnpm exec dsh` so the lifecycle patches are loaded. Keep the server token in the host environment; the browser uses DSH's existing authenticated connection. Configure the model provider and preset independently on both devices. API keys are not transferred.

### Upgrade an existing two-plugin installation

Finish the current task and stop DSH on that device. With the same `DSH_HOME`, update the complete plugin and remove the separate storage installation:

```sh
pnpm exec dsh plugin --profile web add "link:$PWD/packages/handoff-deepseek"
pnpm exec dsh plugin --profile web remove dsh-contextmesh
```

The complete plugin keeps using the existing server sessions and device configuration without deleting history. These components do not need separate installed entries.

## Prepare and transfer

1. Open **Remote sessions** (⇄) in the DSH sidebar. Create a project once.
2. On each device, select that project and save its local **working folder** (the repository root for Git workspaces). Paths may differ. Do not copy `node.json` between devices; it contains the stable device identity.
3. Plain folders need no Git preparation. For Git workspaces, prepare the same base commit on both devices. Commit local changes or use the [confirmed file-transfer flow](files.md) before handoff. ContextMesh does not fetch Git remotes or synchronize ignored files.
4. Open a native conversation inside the mapped project. Finish its current turn and pending input. Select an online target and choose **Hand off**, either in the conversation dock or remote panel.
5. Wait for **Completed**, then open the conversation on the target. Its next tool runs in the mapped local directory. Folder contents are not copied, so any required files must already be present on that device. The original immutable session header retains the original path; the native working-directory event and sandbox binding select the current device's path.

The source freezes new work, waits for admitted activities, validates both machines, flushes and awaits the actual Agent owner's disposal. Scope cleanup events enter the final log before the server fixes its cut. Only the designated target can atomically claim the new writer epoch. The target restores the native Agent, preset, model selection, local directory and sandbox policy before accepting input. The source keeps the session in its sidebar for read-only history. A remote-device indicator identifies its current location; hover over the row to see the device name.

ContextMesh preserves the selected model and refuses a target whose configured sandbox policy is stricter. It supports root sessions with portable text/tool history. Finish background jobs, close persistent terminals, remove schedules and stop child Agents first. Native file attachments require [explicit transfer and target approval](files.md). Images, spill resources and Git submodules are rejected. Ignored files, credentials, external services and shell side effects are not portable; prepare required resources yourself. Avoid external workspace changes during a handoff.

## Take over from this device

Sending a message in a remote session first asks whether to take it over here. After confirmation, the other device stops its current task, saves the final context, and releases execution ownership. Your original message is sent once after takeover completes. You do not need to click Hand off on the other device. Cancelling confirmation or a failed takeover keeps the draft without sending it.

You can also choose **Take over here** in the conversation dock or remote-session list to move the session without sending a message. This uses the same complete plugin.

Update the plugin on both devices and prepare their project directories. An offline or uncertain source, pending messages, or an unprepared workspace prevents takeover. The UI explains the reason and keeps your draft; retry or follow explicit recovery below when needed.

## CLI

The local commands use the private controller socket of a running DSH instance. They need no service token. Pass `--state-dir` if the plugin uses a custom directory; the default is `$DSH_HOME/contextmesh`.

```sh
pnpm cli devices
pnpm cli projects
pnpm cli project-add 'My project'
pnpm cli map PROJECT_ID /absolute/git/root
pnpm cli remote-list
pnpm cli handoff SESSION_ID TARGET_NODE_ID
pnpm cli handoff-status HANDOFF_ID
pnpm cli history SESSION_ID
pnpm cli handoff-cancel HANDOFF_ID
pnpm cli resume SESSION_ID
```

`resume` explicitly reopens an eligible completed, cancelled or failed handoff on this device; it does not steal a writer. Cancel is available before target activation. Once source teardown has begun, cancellation does not silently restart the source.

## Interrupted handoffs

Temporary API failures keep input frozen and retry or reconcile the original operation. A lost accept/complete response does not create a second Agent. A failed target preflight leaves the original writer available after the server confirms failure. Once ownership is lost, execution is stopped and its scope is disposed.

`recovery_required` means shutdown or ownership could not be confirmed. Verify that the previous DSH runtime **and its tools** have stopped, wait for the write lease to expire, then use the service credentials:

```sh
pnpm cli handoff-recover HANDOFF_ID --confirm-stopped
pnpm cli resume SESSION_ID
```

Recovery clears the reservation and fences the previous writer; resuming remains an explicit action. A restarted process does not automatically claim another device's session. A lease fences log writes, and cannot undo external side effects.

## Upgrade and transport

The current server uses database schema **6**. Back up PostgreSQL and stop old clients before upgrading the server. Startup migrates schemas 1–5 transactionally, preserving existing sessions and adding durable takeover, model relay, device pairing and workspace-transfer records. M0 ordinary storage clients remain usable outside an active handoff; their write-open and ordinary recovery cannot bypass its reservation. Older server binaries cannot run against schema 6. Rolling back requires the backup, not just replacing the binary.

Use HTTPS for network connections, or loopback addresses through an SSH tunnel. Plain HTTP on loopback is not encryption by itself. Devices sharing a namespace token belong to one trust domain; device IDs route work and are not separate authorization credentials. Native DSH Host/Origin and owner authentication protect the browser control endpoint. The local Unix socket is accessible only to its OS user.

M1 coordinates the same Harness and model route. M2 adds [model relay](model-relay.md), through the native model selector; device handoff always keeps the current selection. Confirmed [workspace and file attachment transfer](files.md) is available. Heterogeneous agents and automatic crash takeover remain future work.

On explicit resume, a valid working directory inside the local mapped project is retained. A persisted absolute path from another device is restored through the handoff record and local mapping instead. Stricter session file permissions remain in effect.

When a remote conversation has no project, or this device has no matching directory, sending opens project setup directly. Choose an existing project or create one, click **Browse folders** to select the working directory on this device, then continue to takeover confirmation. Cancel keeps the draft without sending. The input dock also offers **Choose a project**. The source validates the conversation’s actual working folder and can create its first mapping; it never replaces an existing directory automatically. Git workspaces need the same base commit and either clean contents or an explicitly applied file transfer; plain folders do not require Git. Project setup does not copy files or commit code.

The folder browser reads directories from the current DSH host: the server page browses server folders, and the local page browses local folders. Navigate folders or breadcrumbs, optionally show hidden folders or jump to a path, and choose **Use this folder** to fill the project directory. Cancelling browsing keeps the setup form unchanged.

Directory handoffs declare `kind: directory` with no commit, while Git handoffs retain commit validation; legacy manifests without a kind remain Git handoffs. Both devices and the server must be updated before using directory handoffs. Database schema 6 adds model-relay records.
