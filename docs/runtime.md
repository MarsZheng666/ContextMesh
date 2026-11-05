# Install, connect and upgrade

[中文](runtime.zh.md)

The 0.8.0-dev.4 runtime packages contain Node, the pinned DeepSeek Harness runtime and the **single** `dsh-contextmesh-handoff` plugin. They are built for macOS Apple Silicon and Linux x64. Linux packages record and check their minimum glibc version in the manifest; release CI builds against Ubuntu 22.04 (glibc 2.35). Windows and additional architectures are not supported yet. A global Node, pnpm or Git installation is unnecessary for ordinary conversations; Git is needed when working with Git projects.

Packages are produced by the **Release packages** workflow. Publication is a separate maintainer action: a workflow artifact is a candidate, not a published release. Obtain a platform archive and its checksum from the same trusted release, verify the SHA-256 value, then unpack it. Keep the original checksum and `manifest.json`. The manifest records platform, Node/DSH versions, protocol and schema compatibility, source commit, lockfile/patch hashes, file checksums and bundled third-party license information.

## First device

First deploy the server with the default HTTPS entry point described below. Then, inside the unpacked directory on each device:

```sh
./bin/contextmesh install "$PWD"
export PATH="$HOME/.contextmesh/bin:$PATH"
contextmesh setup
contextmesh dsh
contextmesh open
```

`CONTEXTMESH_HOME` selects a different managed directory. Programs live in `releases/<version>`; persistent configuration, model credentials, device identity and local import journals live in `data/dsh`; the server persists conversation history and project mappings. Upgrades do not replace that directory. Keep its backups private. Use `contextmesh dsh --port 3080` to choose a loopback Web port, or `--port 0` for an available port.

The setup wizard accepts a pairing code or an existing private owner connection file. **HTTPS direct connection is the default:** enter the service URL, such as `https://mesh.example.com`; all devices use that URL with their own credentials. No SSH setup is required. Model login remains in DSH. Open **Remote sessions → Connection setup** to pair an unconfigured device from the browser. That page remains available when the service is offline. Remote writes are blocked while unavailable: there is no hidden local storage fallback or automatic replay of tools/messages.

`contextmesh open` opens the current authenticated address. For a headless machine, use `contextmesh open --print-url` and keep that URL private. The normal `status` output does not expose its login token.

## New server

Docker Compose is required only on the service host. On that host, unpack its verified runtime package, install the CLI, and use a published image pinned by digest:

```sh
./bin/contextmesh install "$PWD"
export PATH="$HOME/.contextmesh/bin:$PATH"
contextmesh server init --image ghcr.io/OWNER/IMAGE@sha256:DIGEST --endpoint https://mesh.example.com
contextmesh server start
```

Replace the image and domain with real values. Initialization generates separate PostgreSQL and owner secrets, saves them privately, and never regenerates them on restart. Import `~/.contextmesh/server/owner-connection.json` into the first owner's setup wizard. Do not distribute that owner credential to ordinary devices.

The default HTTPS setup includes Caddy with persistent certificate storage. DNS must point to this host and certificate issuance must be possible through ports 80/443. An existing HTTPS proxy can provide the entry point instead. The API and database stay inside the Compose network; devices connect directly to the HTTPS URL.

For same-host local development or the [optional SSH-only deployment](#optional-ssh-tunnel), initialize with an explicit loopback HTTP origin such as `http://127.0.0.1:8787`; only that API port is published to loopback. Never expose PostgreSQL to the Internet.

## Another device

1. Install the same platform runtime.
2. On an owner device, open **Remote sessions → Service connection → Add or revoke a device** and create an invitation.
3. Run `contextmesh setup` on the new device, or use **Connection setup** in its DSH page. Enter the same HTTPS service URL used by the owner device and the one-time code. Only for the optional SSH deployment, use this device's local forwarded URL instead.
4. Configure a local model in DSH. Select a local project directory when needed. The receiving device uses its own selected model.

Each device has its own private credentials and identity. A revoked credential cannot reconnect. Existing environment/plugin credentials override the saved connection; `doctor` and the UI show the effective source without exposing the token. Changes to an already active connection require a controlled restart; use a separate managed home to connect another account.

## Existing DSH configuration

Stop the old DSH and its tools first. Use an empty managed home, then run:

```sh
contextmesh adopt /absolute/path/to/old-dsh-home --confirm-stopped
contextmesh dsh
```

Adoption copies configuration and saves a backup; it does not move or delete the original. Dependencies and sockets are excluded. Review custom profile patches for absolute paths and third-party plugins before startup. The managed profile installs only ContextMesh. Model credentials are copied only as part of this explicitly selected local configuration import, never between devices during handoff.

## Connection checks

```sh
contextmesh status
contextmesh doctor
```

`doctor` distinguishes missing/invalid settings, DNS, refused connections, TLS verification, timeouts, rejected credentials, database readiness and incompatible protocol versions. Its JSON report excludes credentials, model keys and conversation contents. Do not solve certificate errors by disabling TLS verification. Session ownership and failed-writer recovery remain separate from connectivity.

`contextmesh autostart install` generates a per-user launchd/systemd configuration. It prints the activation step; stop the manually started instance before enabling it. Only the managed instance is supervised. On Linux, user services normally start at login; unattended boot may require the administrator's user-lingering policy.

### Optional SSH tunnel

Use this only for an SSH-only deployment whose API is bound to server loopback; the default HTTPS connection does not need it. If changing an existing connection, finish active work and stop the managed DSH first.

```sh
contextmesh tunnel configure --host my-ssh-alias --local-port 18793 --remote-port 8787
```

`my-ssh-alias` comes from your system SSH configuration. Complete the first login in a terminal so keys, agent access and host verification are ready. The supervisor uses SSH batch authentication and strict host checking. It stores no SSH password. Set only the endpoint in this device’s private connection file to `http://127.0.0.1:18793`, retaining its credential and identity, then start the managed DSH.

The tunnel binds only to loopback, sends keepalives, retries transient exits up to eight times with bounded backoff, and stops retrying on authentication, host-key or port errors. After attention is required, fix the cause and restart the managed instance. It never kills a process that it did not start. A running SSH process alone is not proof of a healthy service; `doctor` also checks the service and authentication.

## Client upgrades

Download and verify the target platform package first, then unpack it:

```sh
contextmesh upgrade /path/to/new-runtime --check
contextmesh upgrade /path/to/new-runtime
contextmesh rollback
```

Upgrade verifies the entire package and compatibility before stopping anything. It refuses active work, queued messages, handoffs, model changes or file operations. An idle device freezes new acquisitions, flushes, shuts down cooperatively, backs up private data, switches versions and verifies startup and identity. It never forcibly kills a busy DSH.

Progress is saved in `upgrade.json`. Retry the same package after an interruption. A failed compatible startup attempts a binary rollback. `rollback` keeps current data; it does **not** overwrite newer conversation data with an old backup. If draining or health verification fails, inspect `doctor`, private logs and the journal before retrying. An incompatible database schema blocks client upgrade and rollback.

## Server maintenance, backup and restore

```sh
contextmesh server maintenance on
# Stop all participating clients and resolve unfinished handoffs/recovery explicitly.
contextmesh server backup
contextmesh server upgrade --image ghcr.io/OWNER/IMAGE@sha256:DIGEST
contextmesh server resume-upgrade
# After health and client checks:
contextmesh server maintenance off
```

Maintenance blocks new mutations/writers at the API and database admission boundary; existing writers can append, flush and close. An expired lease does not prove a writer stopped. Backups require no active or unresolved writers, are private, and are validated with PostgreSQL's archive reader. Managed server upgrades preserve PostgreSQL major version 18 and require the target image to have the same schema as the running server. Schema-changing images are rejected before maintenance or downtime. Backups record the actual schema (6, 7 or 8); restoration also supports verified schema-6 and schema-7 archives. A recorded interruption keeps maintenance enabled; `resume-upgrade` continues that exact image after validating its backup and drain state.

The old 0.6.1 service has no maintenance API. For that first server upgrade, stop **all old clients, tools and the API**, verify the processes are gone, and take a PostgreSQL backup before replacing the API. Do not use lease expiry as evidence. The managed client can adopt the stopped 0.6.1 home; the server upgrade command deliberately refuses an old server without maintenance support. For schema 6/7 → 8, follow the stopped-service migration below. PostgreSQL-major upgrades remain separate administrator operations.

Disaster restoration is deliberately separate. Stop all clients and the API, keep PostgreSQL running, then:

```sh
contextmesh server restore --backup /path/to/verified-backup --confirm-stopped --confirm-data-loss
```

This replaces the database with the selected backup in a single transaction and restores its deployment settings. Other database connections block restoration. The API stays stopped and maintenance stays enabled. Review the restored data before restarting and admitting writers. Never restore an old backup automatically over new writes.

## Migrate schema 6 to 7

The previous native-storage release introduced schema **7**. The native DSH Session format is unchanged; the new boundary prevents older servers from reading other Agents' native formats incorrectly.

1. Build the reviewed target version or obtain its verified image/package before maintenance.
2. Enable maintenance on the schema-6 service, stop every client and tool, and explicitly resolve pending handoffs, model switches and failed writers. Do not use lease expiry as proof of shutdown.
3. Take and verify a PostgreSQL 18 archive with the old deployment and retain its private configuration and image. The old server can still run against this backup.
4. Stop the API, retain the existing database volume, and replace only the API image/binary with the reviewed schema-7 version. Start that API alone; startup applies the transactional migration. Do not run both server versions together.
5. Check authenticated `/health/ready` reports `schemaVersion: 7`, maintenance remains on, and existing session headers and event counts are intact. Update managed clients to a package whose manifest allows schema 7, then turn maintenance off and resume devices.

Older servers reject schema 7. If rollback is required, stop all devices and the API and explicitly restore the verified schema-6 archive with its corresponding deployment. This discards writes made after that backup; replacing the binary alone is insufficient. `server upgrade` and `resume-upgrade` deliberately do not perform this migration.

## Migrate schema 6 or 7 to 8

This source preview uses schema **8**. It retains native headers and events and adds successor-session links, per-device Agent endpoints and confirmed continuation records. DSH's native Session format remains unchanged. No context rewrite or model-credential migration occurs.

1. Prepare the reviewed schema-8 Server and matching clients before downtime.
2. Enable maintenance on the old Server. Stop all clients, Codex processes, tools and background commands. Resolve unfinished handoffs, model switches, file transfers and failed writers; verify actual process shutdown.
3. Take and verify a PostgreSQL 18 backup with the old deployment and retain its image and private configuration.
4. Stop the old API. Keep the database volume, replace the API with the reviewed schema-8 version and start it alone. Startup applies the transactionally locked migration; do not run old and new APIs together.
5. Verify authenticated `/health/ready` reports `schemaVersion: 8` and `cross-agent-takeover-v1`. Check original headers/events, maintenance state and matching device packages before reopening writes.

Older servers refuse schema 8. Rollback requires stopping clients/API and explicitly restoring the old verified backup with its matching deployment; newer writes will be lost. Managed `server upgrade` and `resume-upgrade` still require the same schema and do not perform this migration.
