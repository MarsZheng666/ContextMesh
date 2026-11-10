# Native Agent storage

[中文](native-agents.zh.md) · [Server deployment](deployment.md) · [DSH handoff](handoff.md)

ContextMesh Server persists independent native Agent logs. DSH uses the single installed ContextMesh plugin; the optional [Codex CLI bridge](codex.md) imports snapshots or explicitly takes over unfinished DSH work, and archives its native continuation. Selecting `adapter: 'codex'` in the SDK alone still only names a storage format; it does not install Codex or convert a DSH log. Receiver-confirmed DSH → Codex takeover is described in the [takeover guide](confirmed-takeover.md).

## Storage contract

Create one `MeshClient` per native format:

```ts
const client = new MeshClient({
  endpoint: 'https://mesh.example.com',
  token: deviceCredential,
  adapter: 'codex',
})
```

The default is `deepseek`. Adapter names contain 1–64 lowercase letters, digits and single `.`, `_` or `-` separators, starting with a letter. Examples: `deepseek`, `codex`, `claude-code`. They identify codecs, not model names or devices. Changing a model within DSH still uses `deepseek`.

| Field                       | Meaning                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `header.id`                 | Stable ContextMesh ID, unique across every adapter in the namespace; include an adapter prefix or use a UUID to avoid collisions. |
| `header.version`            | Adapter-owned envelope format version; other Agents must not interpret it as a DSH format version.                                |
| `header.createdAt`          | Nonnegative safe-integer timestamp.                                                                                               |
| `header.isSeeded`           | Whether an inherited prefix exists; unseeded logs require inherited count 0.                                                      |
| Additional header fields    | JSON preserved with the header; record the original native thread ID and native format metadata here.                             |
| Event `seq`, `type`, `time` | Contiguous nonnegative safe-integer sequence from 0, nonempty event type and nonnegative safe-integer timestamp.                  |
| Additional event fields     | Opaque JSON owned by the adapter, including the original native item where appropriate.                                           |

The Server validates the storage envelope, not each Agent's executable semantics. It stores the original JSON; it does not flatten tool calls, replay tools, copy model credentials, or synthesize successful results. The adapter must validate its native payload before execution. Keep credentials out of headers and events. Existing single-writer leases, fencing epochs, append order, operation IDs, flush, failed-writer recovery and read pagination apply to every format.

## Catalog and ownership

| Operation                       | Adapter selection                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/sessions`             | Required body `adapter`; immutable after creation.                                                                                     |
| `GET /v1/sessions`              | Query `adapter`; defaults to `deepseek`. Filtering happens before pagination.                                                          |
| `GET /v1/sessions/:id`          | Query `adapter`; defaults to `deepseek`; another format returns a null session.                                                        |
| `POST /v1/sessions/:id/handles` | Optional body `adapter`; defaults to `deepseek`. Mismatch returns `ADAPTER_MISMATCH` before acquiring a handle.                        |
| `POST /v1/sessions/:id/recover` | Optional body `adapter`; defaults to `deepseek`. Still requires `confirmStopped: true`; mismatch cannot close another format's writer. |

The SDK supplies the selection for create, list, stat and open automatically. Raw `request` calls, including recovery, must specify a nondefault adapter explicitly. Existing DeepSeek mutation bodies keep their omitted-adapter encoding for operation retry compatibility. Handle reads/writes use the authenticated namespace and acquired handle, as before. DSH-only handoff, model relay, summary and project-setup workflows reject foreign native formats; they do not convert those formats.

Adapters are **not access-control boundaries**. Authorized devices in the same configured namespace can explicitly select another format. Separate users and permissions require a future authorization layer. IDs remain namespace-wide: creating an existing ID with another adapter returns `ALREADY_EXISTS`, preserving the original history.

For inspection, the remote CLI accepts a selector:

```sh
contextmesh list --adapter codex
contextmesh stat codex-thread-id --adapter codex
contextmesh export codex-thread-id --adapter codex
contextmesh recover codex-thread-id --confirm-stopped --adapter codex
```

Exports include the adapter, original header, inherited count and events. Recovery is an explicit administrative action only after the previous process and its tools have stopped; selecting an adapter does not authorize stopping a running Agent.

## Codex archive return

The authenticated `GET /v1/codex-archives` catalog and `GET /v1/codex-archives/:id` return namespace-scoped archive metadata: identity, incarnation, sequence count, creation time, busy and recovery-required flags. They do not return context or credentials. `/health/ready` advertises `codex-context-return-v1`; the legacy format remains available on schema 9.

The receiving DSH plugin's [explicit archive import](codex-return.md) validates and converts a fixed Codex snapshot into a new DSH log. It does not reinterpret a foreign log through native restore. The target header's `contextmeshImport` records the source cut/digest, operation and expected seed event count. Incomplete imports are excluded before normal list pagination and summaries. Ordinary write-open returns `IMPORT_INCOMPLETE` until the seed is complete; only explicit importer recovery supplies the matching optional `importOperationId` to finish its saved prefix. This is a staging guard within the existing trusted namespace, not an additional authorization boundary.

## Compatibility

Authenticated `/health/ready` advertises `native-agent-storage-v1` with database schema **10**. An older Server cannot accept other native formats. Schema 8 retains existing DSH headers/events and the native-format boundary, adding a successor-session link, separate Agent endpoint identity and one-time continuation execution records. A transferred DSH session stays readable; write-open and recovery return `SESSION_MOVED`. See the [schema migration procedure](runtime.md#migrate-schema-8-to-9). The public installation still contains exactly one DSH ContextMesh plugin.

## Chunked archives

`chunked-archives-v2` advertises the separate archive API. Uploaders start with a fixed manifest at `POST /v2/archive-uploads`, post numbered blocks to `/v2/archive-uploads/:id/blocks/:seq`, and commit after all blocks are acknowledged. The Server validates the block checksum, sequence and manifest before publishing it. Repeating a block with the same content is safe, including after restart.

`GET /v2/archives` lists committed manifests. `GET /v2/archives/:id/records` pages through the record index, with filters for role and indexed terms. `GET /v2/archives/:id/records/:seq/content` reads a byte range of one record. A range that crosses a block boundary reads and verifies both blocks. Receivers load only the selected records and ranges into their model context.
