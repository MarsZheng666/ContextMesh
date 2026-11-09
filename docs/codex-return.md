# Continue a Codex archive in DSH

[中文](codex-return.zh.md) · [Codex setup](codex.md) · [DSH → Codex takeover](confirmed-takeover.md)

Copy a settled ContextMesh archive or a [snapshot published from Codex Desktop](codex-desktop.md) into a **new DSH conversation**. Use the receiving DSH device's own model and directory. The original Codex thread stays independent. This flow copies a fixed archived snapshot; it does not stop Codex, transfer its live execution or automatically send a new model request.

## Prepare the devices

- Use the same reviewed ContextMesh version on the Server and clients. The Server advertises `codex-context-return-v1` for legacy archives and `chunked-archives-v2` for chunked archives on schema 9.
- On the source, finish the managed Codex run and wait until ContextMesh reports its result archived. If a previous operation is uncertain, reconcile it first using the [Codex recovery procedure](codex.md). Desktop conversations appear in the archive after you confirm publication in the ContextMesh panel.
- On the receiver, run DSH with the existing **single** `dsh-contextmesh-handoff` plugin and connect it to the same Server namespace using that device's credential. Configure its own model provider; Codex CLI and the source model are not required on this device.
- Choose a model with DSH's native selector before importing. Until a local selection exists, the local DSH default is used. The plugin checks that model and the imported context before creating the copy. It never silently substitutes a source model or another available model.

## Import from the DSH interface

Open the ContextMesh remote-session panel and its **Continue a Codex archive** section. Select an available archive, use **Choose folder** to browse directories on the receiving DSH host, review the local model and confirm the import. Busy or unreconciled archives cannot be selected. A browser connected to remote DSH browses that remote host, not the browser's filesystem.

Ordinary directories are supported. This snapshot copy does not require a Git repository, matching commits or a clean tree. Files, attachments, credentials and source tool permissions are not copied; prepare any files the next instruction will need yourself. The chosen directory becomes the new DSH conversation's local working directory and workspace boundary, subject to its local permission policy.

The new conversation opens with the imported history. **Send your next instruction to continue.** Import alone generates no model turn and executes no historical tool calls. Later model changes use the ordinary DSH selector.

## Import from the CLI

These commands contact the receiving DSH plugin's local control socket; keep that DSH instance running. With a built source checkout, replace `contextmesh` with `pnpm cli`:

```sh
contextmesh codex archives
contextmesh import-codex CODEX_SESSION_ID \
  --cwd /absolute/path/on/this/dsh-device \
  --operation-id YOUR_OPERATION_UUID --confirm
contextmesh import-codex-status YOUR_OPERATION_UUID
```

`--operation-id` is optional; without it, the CLI generates an ID and prints `Import reference: ...` before contacting DSH. Keep this reference. Reusing it with the same source, directory and local model resumes the same copy rather than creating another conversation. A different set of choices requires a new operation only after checking the previous result. `--state-dir` selects the plugin's existing private state directory when using a nondefault DSH profile. Runtime-managed CLI commands select their managed profile automatically.

The returned metadata includes the new `dsh:` session ID, operation reference, source ID and fixed archive cut, archive time, local directory, model and phase (`writing`, `archived`, `published`). Status does not return conversation content or credentials. `archived` means the complete seed history is durable on the Server; `published` means it has also been activated and announced in the receiving DSH instance.

With a chunked archive, the receiving model and project determine the context budget. You can browse records by path or error, include an excerpt, and review the estimated load before import. The history-search field helps find related records. Send your next instruction in the new conversation when ready.

## What the copy contains

The copy includes saved user and assistant messages. It includes completed tool and plan records when the source archive contains them. A desktop archive published with **Conversation text only** contains the saved messages and a note about the chosen scope. All imported entries become historical references with their source adapter, session and original role. The receiving agent uses its own instructions and tool permissions. Unsupported content, oversized context and unresolved native work block import.

The DSH header records the source incarnation, archived event cut and context digest. Each operation keeps that same snapshot across retries, even if the source later adds another turn. The Server persists the separate DSH event log. Codex's native thread and remote archive remain intact; new DSH turns do not synchronize back into that thread. If the Codex session came from an earlier takeover, the old DSH source remains read-only and the returned DSH conversation has a new identity.

## Recover an interrupted import

The private DSH plugin state directory contains `codex-imports/` journals. These retain the fixed copy and HTTP operation IDs for recovery and may contain conversation text. They are local recovery data, separate from the remote Server's persisted session history; keep the original profile/state directory when retrying.

1. Keep the original Server connection, directory and model. Check `import-codex-status` with the saved reference. Retry the original command with the same operation ID for transient connection failures; acknowledged HTTP mutations are not duplicated.
2. An unfinished seed is hidden from normal DSH lists, and ordinary write-open is blocked until its expected history is complete. If the importing writer expired or failed, first confirm the previous importing process **and any associated tools** have stopped. Lease expiry alone does not establish that.
3. Use explicit recovery with the same reference:

```sh
contextmesh import-codex-recover YOUR_OPERATION_UUID --confirm-stopped
```

Recovery checks the existing log against the exact saved seed, closes/reconciles that operation's writer and appends only its missing prefix remainder. It never replays a native task. Changed history or identity is blocked for inspection rather than overwritten. A committed complete copy can be published again without creating a new session. The UI also offers retry and confirmed recovery while an import is pending.
