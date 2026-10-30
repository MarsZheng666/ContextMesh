# Bring workspace files with a conversation

[中文](files.zh.md) · [Device handoff](handoff.md)

Use **Remote sessions → Workspace files and attachments** in the existing ContextMesh plugin. File transfer is an explicit preparation step; uploading or applying a bundle does not move the conversation's writer.

## Transfer and continue

1. Configure the same project on both devices. For a Git workspace, map repository roots at the same existing commit. Fetch or clone the repository yourself; ContextMesh does not fetch remotes or change branches.
2. On the current owning device, choose the conversation and target, then **Inspect files to transfer**. Review every added, changed and deleted path and every attachment. Ignored files are excluded. The preview expires after 60 seconds.
3. Choose **Upload these files** and confirm. Files are uploaded to your ContextMesh service for the selected target. Review the list for private data; filename checks cannot identify every secret.
4. On the target, refresh **Available transfers**, choose **Preview on this device**, and check the displayed directory and file list. The target must have a clean Git workspace, matching base contents and no live DSH conversations using that directory. Preserve your target edits first; ContextMesh does not merge or overwrite them.
5. Choose **Apply confirmed files here** and confirm within 60 seconds. A changed directory mapping or file content requires another preview. New DSH Agent creation is briefly refused while the local import runs. Stop external editors, build processes and other programs that could modify these files.
6. After **Target files ready**, hand off normally from the source. Both devices recheck the approved content and attachment references before ownership moves. Later changes require a fresh transfer. Failed preflight keeps the source available.

The working-tree result transfers; Git staging, branches and commits do not. A staged edit appears as an unstaged edit on the target. Renames may appear as a deletion and an addition. Binary bytes and the regular-file executable flag are preserved. Ordinary non-Git conversations still transfer without copying their directory contents; their supported file attachments can use this flow.

## Attachments and limits

Supported native DSH **file** attachments are read through the public attachment store, verified by SHA-256, and saved through the target's attachment store. Original attachment IDs, names, bytes and Session events remain intact. Model relay still supports text and completed tools; transfer of a file attachment does not certify it for a different model.

Limits per bundle: **64 workspace files, 32 file attachments, 1 MiB per file or attachment, 4 MiB total**. Both source and target need the updated single plugin and a server advertising `workspace-transfer-v1`.

Images, spill objects, submodules, symlinks, hardlinks, non-regular files, Git assume-unchanged/skip-worktree entries, ignored files and running processes are unsupported. Common credential filenames and paths such as `.git`, `.env`, `.ssh`, `.aws`, private keys and credential files are refused. A forbidden changed path blocks the bundle; it is never silently omitted to make a dirty workspace appear portable. Review the complete preview before confirming.

## Interrupted imports and rollback

Before changing workspace files, the target saves a private durable recovery journal and original bytes under its ContextMesh state directory. An interrupted import blocks automatic retry. Choose **Roll back imported files**, or use the CLI with the transfer ID. Rollback checks all affected file hashes and modes first and stops if any file contains later edits. Preserve those edits separately and reconcile the file with the recorded imported or original version before retrying. There is no force-overwrite option.

After a successful rollback, original workspace bytes are restored and the target's readiness is cleared. Immutable attachment cache objects remain; rollback does not rewrite conversation history. A lost successful apply response can be retried against the same preview while valid, or inspected again after restart. Source export retries reuse the same plan ID while it remains valid. After a source restart, inspect again to create a new plan; never reuse a confirmation for changed content.

Server bundles expire after **24 hours**. Expired content is removed opportunistically during new exports, except while referenced by an active or recovery-required handoff. Each namespace retains at most **32 bundles**. Local journals and backups are retained for recovery; keep the transfer ID and do not delete its state directory while an import is unresolved. After server expiry, CLI rollback can use the local journal once the service is reachable and confirms no active handoff. Do not delete that journal as a substitute for resolving a partial import.

The service's existing HTTPS/SSH transport and namespace trust rules apply. Server storage is ordinary PostgreSQL, not end-to-end encrypted storage or a per-project sharing system. Paired devices belong to the same owner trust domain; the selected target controls routing, not isolation from the owner or server administrator.

## CLI

Use the private control socket of a running DSH. Add `--state-dir PATH` when needed. Inspect the returned file list before each confirmed mutation.

```sh
# Source
pnpm cli workspace-plan SESSION_ID TARGET_NODE_ID
pnpm cli workspace-export PLAN_ID --confirm

# Target
pnpm cli workspace-list
pnpm cli workspace-preview TRANSFER_ID
pnpm cli workspace-apply TRANSFER_ID --preview-id PREVIEW_ID --confirm

# Source, after the target reports ready
pnpm cli handoff SESSION_ID TARGET_NODE_ID

# Target recovery, before handoff or after confirming no active handoff
pnpm cli workspace-rollback TRANSFER_ID --confirm
```

## Upgrade

The server uses database schema **6**. Back up PostgreSQL and stop older writers before upgrading the server and participating devices together. Migration from schemas 1–5 preserves Session headers and events and adds expiring workspace-transfer records. Older server binaries reject schema 6; rollback requires the backup. The native DSH Session format is unchanged.
