# Continue a snapshot with Codex CLI

[中文](codex.zh.md) · [Device setup](getting-started.md) · [Native storage](native-agents.md)

On Mac, the [Codex Desktop sidebar](codex-desktop.md) can receive remote DSH tasks and publish saved conversations for a remote DSH device.

The optional Codex bridge is included in the existing ContextMesh CLI. It imports a completed DSH or ContextMesh-managed Codex snapshot into a **new local Codex thread**, then lets you send new instructions through Codex's native app-server. The source conversation keeps its history and ownership. This `import` flow copies a snapshot. To stop a running DSH task and continue it after confirmation, use [confirmed takeover](confirmed-takeover.md).

To continue a settled managed archive in DSH, use the [Codex → DSH import](codex-return.md). This creates a new DSH conversation and waits for your next instruction; it does not stop or transfer running Codex work. The receiving DSH device needs only its own model and the existing ContextMesh plugin.

## Before starting

- Install the supported official Codex CLI separately and make `codex` available on PATH. The adapter was validated with **0.154.0**; a compatible newer 0.x version must provide the same app-server methods. ContextMesh does not bundle Codex or install a second DSH plugin.
- Configure the receiving machine's Codex login and model provider locally. ContextMesh uses that configuration through Codex, without uploading its authentication files or copying source model credentials.
- Connect ContextMesh with `contextmesh setup` and use a schema-8 or schema-9 Server. Chunked archives require schema 9. Keep the HTTPS connection described in the [server guide](deployment.md).
- Finish the source turn, including tool calls. This preview supports text and historical tool references. Unresolved tool outcomes and unsupported projections require review. Chunked archive imports preview the records that fit the receiving model before creating a local thread.

## Import and continue

On the receiving device:

```sh
contextmesh list
contextmesh codex import SOURCE_SESSION_ID \
  --cwd /absolute/path/to/local/project \
  --model YOUR_LOCAL_CODEX_MODEL
```

Choose the directory and model configured on this machine. The source's model and absolute directory are not imposed on the receiver. The directory may be an ordinary folder; Git is not required. Files are not copied by this command.

The result includes a new `sessionId` beginning with `codex:`, a native `threadId`, and an `operationId`. Import saves context but does **not** begin a turn. Continue explicitly:

```sh
contextmesh codex run CODEX_SESSION_ID --message "Continue from the previous result."
contextmesh codex status CODEX_SESSION_ID
```

`run` restores the local native thread and uses the model, directory and permissions selected during import. A run waits up to 30 minutes by default; `--timeout-seconds` accepts 10–3600 seconds. Each acknowledged turn is archived to the remote Server before its result is reported as saved. A later invocation resumes the same thread after app-server restart. Codex-backed sessions are inspected with `contextmesh list --adapter codex` or `export ID --adapter codex`; they do not appear in DSH's native restore catalog.

The default native sandbox is **read-only**. Add `--workspace-write` to the **import** command only when you want Codex to edit that local workspace. Source system messages and tool configuration are imported as references, not target permissions. Historical tool calls/results become reference text rather than executable function calls. The local Codex policy still controls new work. Unsupported interactive approvals are declined; this CLI never silently approves them.

To copy a saved Codex snapshot to another receiving device, configure Codex there and use:

```sh
contextmesh codex import CODEX_SESSION_ID --from codex \
  --cwd /absolute/path/on/this/device --model YOUR_LOCAL_CODEX_MODEL
```

This creates another thread and remote session with source provenance. It does not move the previous writer or automatically start its unfinished work. Existing unmanaged Codex threads are not automatically ingested. Use the ContextMesh commands for managed threads; changing them through another client is detected when reflected in native turn/item history and blocks further execution until reviewed. Direct out-of-band native execution is not governed by ContextMesh's remote lease.

## Configuration and privacy

`--codex-home DIR` selects a native Codex configuration directory; `--codex-bin PATH` selects its executable. `CONTEXTMESH_CODEX_BIN` is an executable fallback. Use the same native home when importing, running or reconciling a local binding.

Private import journals and thread bindings live in `~/.contextmesh/data/codex-bridge`, or the directory given with `--state-dir`. They may contain imported context and must remain private. The Server persists the portable context, source identity/digest and native thread/turn/item snapshots under adapter `codex`. Native Codex maintains its own local thread history as well. Remote archives are created by these bridge commands; unrelated Codex use is not automatically synchronized.

The portable contract preserves the source session ID, incarnation and fixed event count. DSH projections use its canonical surface fold, including replacements. Provider replay state and hidden reasoning are excluded from the portable text; native source logs remain intact. Legacy exports use a 1 MiB portable envelope. For chunked archives, run `contextmesh codex archives`, then import an `archive:…` reference. Use `--history-query` to guide selection or `--context-window` to set a conservative receiver ceiling. A saved DSH session can use the same planner when one of these options is provided. The target provider can still reject a context that exceeds its own capacity.

## Interrupted operations

Use the returned operation ID to inspect an import without printing its conversation content:

```sh
contextmesh codex status IMPORT_OPERATION_ID
```

You can supply `--operation UUID` to an import for a stable operation identity. A completed import returns its existing result; reusing that identity with different source or target settings is rejected. A lost native creation or injection response is marked for attention and **not automatically retried**. Inspect the private journal and native thread before creating a new import; the source remains intact.

For a run with an uncertain result, do not resend the instruction. Stop and confirm the previous native process and its tools have stopped, then:

```sh
contextmesh codex status CODEX_SESSION_ID
contextmesh codex reconcile CODEX_SESSION_ID --confirm-stopped
```

Reconciliation checks native terminal state and remote identity, recovers the stopped writer, and archives already completed results without starting another turn. Active writers, background commands, in-progress turns, changed identities or unavailable native history block recovery. A failed reconciliation keeps the pending operation for review. It does not undo tool side effects or infer that tools stopped from a lease timeout.

## Compatibility and validation

The bridge uses the documented [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server): initialization, thread start/resume, context injection, paginated history and turn lifecycle. Integration tests cover lost replies and writer protection. Set `CONTEXTMESH_TEST_CODEX_BIN` to an installed CLI to enable the isolated end-to-end test; it uses a disposable home and local scripted Responses provider, without paid model credentials. This validates native protocol and context continuity, not the quality of a live model's reasoning.
