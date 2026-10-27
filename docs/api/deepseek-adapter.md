# DeepSeek Harness plugin API

`dsh-contextmesh` implements the native DeepSeek Harness SessionPersistence service. The public contract follows DSH 0.2.1-rc.3; the plugin's source is [packages/adapter-deepseek/src/index.ts](../../packages/adapter-deepseek/src/index.ts).

The plugin stores native Session headers and events through the ContextMesh HTTP API. It returns logical Session handles, not dedicated TCP or WebSocket connections.

## Configuration

| Option              | Default                 | Purpose                                          |
| ------------------- | ----------------------- | ------------------------------------------------ |
| `endpoint`          | `http://127.0.0.1:8787` | ContextMesh API base URL                         |
| `token`             | Unset                   | Explicit Bearer token; overrides tokenEnv        |
| `tokenEnv`          | `CONTEXTMESH_TOKEN`     | Environment variable containing the token        |
| `batchDelayMs`      | `200`                   | Delay before a buffered live-event batch is sent |
| `timeoutMs`         | `10000`                 | Timeout for each HTTP attempt                    |
| `renewalMs`         | `15000`                 | Write-handle lease renewal interval              |
| `allowInsecureHttp` | `false`                 | Allow plain HTTP for non-loopback hosts          |

Non-loopback endpoints require HTTPS by default. Local HTTP endpoints can be used with SSH forwarding. The endpoint must not contain credentials, a query string, or a fragment.

Startup checks the service protocol and requires `renewalMs * 3 <= leaseMs`. The default server lease is 60000 ms. A missing or empty token rejects plugin startup.

## Persistence service

The service is available as `ctx.sessionPersistence` after the plugin is mounted.

| Method                       | Parameters                                             | Result                                                        |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| `create(header, options?)`   | SessionHeader; optional signal and inheritedEventCount | `Promise<SessionHandle>` with write access                    |
| `open(id, access, options?)` | SessionId; read or write access; optional signal       | `Promise<SessionHandle>`                                      |
| `stat(id, options?)`         | SessionId; optional signal                             | `Promise<SessionPersistenceSnapshot \| undefined>`            |
| `list(options?)`             | Optional signal                                        | `Promise<readonly SessionPersistenceSnapshot[]>`              |
| `flush()`                    | None                                                   | `Promise<void>` covering this service's current write handles |

### Create

`create` validates and copies the header, checks the Session format, creates a remote pending Session, and returns a write handle. It does not start an Agent or write conversation events by itself.

`inheritedEventCount` must be a non-negative safe integer. It is required for seeded headers; for unseeded headers, omit it or use zero.

A pending Session is visible to its creator instance. Its first non-empty append or flush materializes it for other instances. Closing a never-materialized empty Session removes it.

### Open

Read access does not take write ownership and can coexist with a writer. Write access atomically claims the Session's single-writer ownership and validates the complete log before returning. Missing Sessions, competing owners, and invalid logs reject the operation.

### Stat and list

Snapshots expose a copied header, `formatStatus: 'current'`, an opaque `revision`, and `eventCount`. They do not include conversation events or a local per-Session file path. Listing follows remote pagination and makes no ordering guarantee.

Compare revisions only for the same Session and service instance. Do not use a revision as a write epoch or parse its representation.

## Session handles

A handle has `id`, `header`, `access`, and `inheritedEventCount` properties. Write handles are also readable.

| Method                             | Parameters                                 | Result                                                                 |
| ---------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `read(offset?, length?, options?)` | Non-negative safe offsets; optional signal | `Promise<{ eventState: 'detached'; events: readonly SessionEvent[] }>` |
| `append(events, options?)`         | Contiguous native events; optional signal  | `Promise<void>`                                                        |
| `flush(options?)`                  | Optional signal                            | `Promise<void>`                                                        |
| `close()`                          | None                                       | `Promise<void>`                                                        |
| `[Symbol.asyncDispose]()`          | None                                       | Delegates to close                                                     |

### Read

The default offset is zero and the default length reads the remaining log. Reads use pages of at most 512 events with a fixed end cursor. Responses are checked for Session identity, log incarnation, contiguous sequence numbers, and valid native event data.

`eventState: 'detached'` means returned values do not share mutable storage references. It does not mean the Session is closed. Reading does not drain buffered live events; flush first when the latest local events must be included.

### Append

The first event sequence must equal the stored next sequence. The plugin snapshots input data, serializes writes, and sends batches of at most 512 events. Each remote batch has an operation ID that is reused if its result is uncertain.

A successful remote batch is confirmed after a synchronous PostgreSQL transaction. An append larger than one batch is not one atomic transaction: earlier batches may commit even if a later batch fails.

The append cancellation signal is checked before queuing and again before the queued task starts. It is not propagated through every in-progress batch request. Cancellation does not imply that remote changes rolled back.

### Flush

Flush drains live-event buffers, confirms any unresolved append, and waits for the server's durability barrier. It also materializes an empty pending Session. It does not clear history or release ownership.

In a Harness integration, use `await ctx.sessions.flush(session)` for a particular live Session. The plugin handles its `session/flush` event and waits on the matching write handle. `ctx.sessionPersistence.flush()` covers all current write handles owned by that provider instance.

### Close

Close stops renewal, drains pending writes, requests remote release, and clears local handle registration. It is idempotent and deliberately not cancellable. New operations reject once closing has begun.

Close preserves materialized history. If a write failed or the server cannot confirm a clean close, explicit recovery may be required. A renewal failure marks the handle as having lost write ownership and subsequent writes are rejected; the handle does not terminate external tool processes.

## Lifecycle integration

- `session/event` routes native live events to the matching write handle's buffer.
- `session/flush` waits for that handle's persistence barrier.
- `session/disposed` initiates handle cleanup.
- Plugin shutdown waits for outstanding acquisitions and closes tracked handles.

Seed history and live publication are separate paths. Let Harness manage its normal persistence lifecycle rather than manually appending the same live events a second time.

## HTTP endpoints

All endpoints below require `Authorization: Bearer <token>`. Requests with a body use JSON.

| Method     | Endpoint                   | Purpose                                                  |
| ---------- | -------------------------- | -------------------------------------------------------- |
| GET        | `/health/ready`            | Database readiness, protocol version, and lease duration |
| POST / GET | `/v1/sessions`             | Create a pending Session or list snapshots               |
| GET        | `/v1/sessions/:id`         | Read a snapshot                                          |
| POST       | `/v1/sessions/:id/handles` | Open a read or write handle                              |
| GET        | `/v1/handles/:id/events`   | Read a bounded event page                                |
| POST       | `/v1/handles/:id/append`   | Append a contiguous batch                                |
| POST       | `/v1/handles/:id/flush`    | Confirm durability and materialization                   |
| POST       | `/v1/handles/:id/renew`    | Renew write ownership                                    |
| POST       | `/v1/handles/:id/close`    | Close a handle                                           |
| GET        | `/v1/operations/:id`       | Query an operation result                                |
| POST       | `/v1/sessions/:id/recover` | Recover after confirming the old writer stopped          |

The default HTTP body limit is 8 MiB. Append requests admit at most 512 events. An individual event that exceeds the request limit is rejected rather than truncated.

## Errors and retries

The adapter maps known storage failures to DSH errors such as SessionPersistenceNotFoundError, SessionAlreadyOwnedError, SessionReadOnlyError, SessionOwnershipLostError, and SessionPersistenceCorruptionError. Not every method applies the same mapping; other failures may remain MeshError, validation errors, or cancellation reasons.

The HTTP client defaults to two retries after the first attempt. Recognized client-side business errors below HTTP 500 are not retried. Stateful requests reuse their operation ID, and append keeps an unresolved batch for later confirmation. Service-wide flush and shutdown collect failures into AggregateError.

Native event history is append-only. Unknown required event types are refused before interpretation; ignorable records are preserved. Write epochs protect the log, not external side effects or workspace files.

## Read-only example

In a Context with the plugin installed:

```ts
const handle = await ctx.sessionPersistence.open(sessionId, 'read')
try {
  const { events } = await handle.read(0, 100)
  console.log(events)
} finally {
  await handle.close()
}
```

See [getting started](../getting-started.md) for installation and recovery, and [deployment](../deployment.md) for remote connections.
