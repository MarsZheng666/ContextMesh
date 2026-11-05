# Confirm takeover, then continue in Codex

[中文](confirmed-takeover.zh.md) · [Codex setup and snapshots](codex.md) · [Server upgrades](runtime.md#migrate-schema-6-or-7-to-8)

Use this flow to move an unfinished DSH task to Codex CLI after **you confirm on the receiver**. ContextMesh checks B before asking A to stop, saves A's final history, transfers ownership, and starts one continuation in B. It does not schedule transfers without your confirmation. The supported direction is DSH → Codex; each Agent retains its own native history.

To return a settled Codex archive to a new DSH conversation, use [archive return](codex-return.md). That separate flow copies context without taking over a live Codex task.

## Prepare the receiver

- Use the same reviewed ContextMesh source version on the Server and participating devices. This flow requires schema **8** and the `cross-agent-takeover-v1` feature; follow the stopped-service migration before upgrading an existing database.
- Keep the source DSH and its single `dsh-contextmesh-handoff` plugin online. The source must have a confirmed live writer. Offline or uncertain writers require explicit recovery rather than takeover.
- Install a supported Codex CLI separately (validated with **0.154.0**), configure its provider/login on B, and connect ContextMesh using `contextmesh setup`. Source model credentials are never copied; B needs only its own model.
- Select B's existing project root. Ordinary directories need no Git. Git projects need the same base commit and clean workspaces on both devices. This Codex flow does not automatically apply file transfers, clone repositories or move uncommitted edits.
- Supported context is text and settled historical tool references. Empty conversations stay in DSH. Unsupported attachments, unresolved effects and oversized history block transfer. Live terminals, jobs and background processes cannot migrate.

## Confirm and run

With a built source checkout, replace `contextmesh` below with `pnpm cli`:

```sh
contextmesh list
contextmesh codex takeover SOURCE_SESSION_ID \
  --cwd /absolute/path/to/project-root \
  --model YOUR_LOCAL_CODEX_MODEL \
  --workspace-write --confirm
```

`--confirm` authorizes the takeover and transmission of the required history to B's configured model provider. Review the model, provider configuration, folder and file permissions first. The default Codex sandbox is read-only; `--workspace-write` explicitly permits workspace edits and is required for a source task with that policy. Full-access source policies are unsupported. The source's absolute path and model do not replace B's choices. Existing project mappings are reused and never silently overwritten.

Keep this foreground command running. Progress and operation/handoff references appear on stderr; the final JSON includes the handoff, the new `codex:` session ID and the acknowledged continuation result. `--operation UUID` gives the receiver operation a stable identity. Reusing it does not start the task again. `--state-dir`, `--codex-home` and `--codex-bin` work as in the [Codex guide](codex.md).

1. **Preflight B.** Check the local directory and native permission policy, then perform one restricted readiness model call with the portable history in a temporary read-only thread. Command, patch, connected-app, configured MCP, hook and collaboration capabilities are disabled for this check. The check can incur provider usage; it does not execute the task. Unacceptable model/configuration/history leaves A running.
2. **Prepare A.** Check current context and matching project mapping. Freeze new input and tool admission, wait for tool bodies already dispatched, recheck the workspace and explicitly authorize source stop. If preparation fails before stop authorization, A keeps running. Tool timeouts never imply cancellation of the tool body.
3. **Stop and save A.** Cancel the unfinished model turn, flush all final events and close its native owner. An unconfirmed close blocks transfer. If the turn finished naturally before cancellation, no continuation is created.
4. **Transfer ownership.** Import the finalized history into a separate native Codex thread, archive its prepared state remotely, then atomically link the source and target. A's history remains readable and shows the Codex session ID; it cannot be resumed as a writer.
5. **Continue once.** Record a one-time execution claim before `turn/start`. Import tool history as reference text, never as executable historical calls. Archive B's terminal result before acknowledging execution. Later instructions use `contextmesh codex run CODEX_SESSION_ID --message "..."`.

One paired hardware credential can serve separate DSH and Codex endpoints on the same device without node collisions. Revoking that device revokes both. All authorized devices in the Server's namespace still share the same trust boundary.

## Understand the result

Ownership state `completed` means the source has transferred to the linked Codex session. Inspect the separate `executionState`:

| Execution     | Meaning                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `none`        | Source was idle or completed naturally. No task was started in Codex.                                                       |
| `pending`     | Ownership moved; the continuation has not been claimed.                                                                     |
| `dispatching` | A single execution claim was persisted; the native result is not acknowledged yet.                                          |
| `completed`   | That native continuation turn completed and was archived. The model may still report missing information or remaining work. |
| `failed`      | The native turn failed or was interrupted; review its result before issuing a new instruction.                              |
| `uncertain`   | Execution may have happened. Do not resend the task; reconcile the existing native history.                                 |

## Inspect and recover

```sh
contextmesh codex takeover-status HANDOFF_ID
# An operation ID from this receiver's private journal is also accepted for status.
contextmesh codex status CODEX_SESSION_ID
```

Use the same private state directory and native Codex home. Journals and bindings are device-local recovery data, not a replacement for the Server's persisted history. If the receiver stops before ownership transfers, inspect the source and handoff, confirm any previous execution/tools stopped, then use the source-side [handoff recovery](handoff.md). A lost native creation/injection response requires review; never create a new import blindly. The source remains reserved until explicit recovery.

After ownership transfer, first stop and verify the previous Codex process **and its tools**, then:

```sh
contextmesh codex takeover-recover HANDOFF_ID --confirm-stopped
```

For an unused `pending` continuation, recovery verifies/recovers the stopped writer, binds the operation to the restarted receiver and spends its first execution claim. For `dispatching` or `uncertain`, it archives already settled native results and acknowledges the matching client-message/turn identity **without starting another turn**. Active/background work, missing native history or a spent claim with no matching terminal evidence remains blocked for manual inspection. Recovery never guesses that a task did not execute and never undoes external tool effects. Lease expiry is not evidence of process shutdown.

If the source cannot close, or import cannot complete after source stop, ownership remains frozen for review. If ownership has transferred but Codex cannot run, the DSH source stays read-only; `completed` ownership is never silently rolled back. After reviewing and resolving an uncertain operation, follow the reported recovery state rather than creating another takeover.

## Validation scope

Tests exercise real DSH and Codex CLI processes with disposable homes, a temporary PostgreSQL database and a local scripted Responses provider. They cover unfinished/idle tasks, natural completion during preflight, running tool boundaries, rejected model/workspace preflight, competing claims, lost replies and receiver restart without replay. This verifies native lifecycle and continuity, not a paid model's reasoning quality or a live multi-machine deployment.
