# Getting started

Install one complete plugin for remote persistence, handoff and confirmed takeover.

This guide connects a DeepSeek Harness profile to a self-hosted ContextMesh service. Use Node.js 24.9+, pnpm 11.25.0, and DeepSeek Harness 0.2.1-rc.3.

## Build and configure

```sh
git clone https://github.com/MarsZheng666/ContextMesh.git
cd ContextMesh
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
```

Replace the example `CONTEXTMESH_TOKEN` in `.env` with a random token:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

| Server setting          | Purpose                                   | Default                                                         |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`          | PostgreSQL connection string              | Required; `.env.example` targets the local development database |
| `CONTEXTMESH_TOKEN`     | Bearer token shared with clients          | Required                                                        |
| `CONTEXTMESH_NAMESPACE` | Session namespace served by this instance | `personal`                                                      |
| `CONTEXTMESH_HOST`      | API bind address                          | `127.0.0.1`                                                     |
| `CONTEXTMESH_PORT`      | API port                                  | `8787`                                                          |

The server initializes its database schema on startup and checks that synchronous durability is enabled.

## Start PostgreSQL and the API

For local development, run this as a regular, non-root user and keep the terminal open:

```sh
pnpm db:local
```

The development database listens on `127.0.0.1:55432` and stores data in `.contextmesh/postgres`. Use a separately managed PostgreSQL instance for deployment.

In another terminal, from the repository root:

```sh
pnpm start
```

The API defaults to `http://127.0.0.1:8787`. `GET /health/ready` requires the configured Bearer token and reports database readiness.

## Install the Harness plugin

Use the pinned runtime built in this repository and install the single complete plugin from its root:

```sh
export DSH_HOME="$HOME/.dsh-contextmesh"
export CONTEXTMESH_ENDPOINT=http://127.0.0.1:8787
export CONTEXTMESH_TOKEN='your-token-from-.env'
pnpm exec dsh plugin --profile web add "link:$PWD/packages/handoff-deepseek"
pnpm exec dsh --profile web
```

The complete plugin loads persistence internally and creates only one ContextMesh installation entry. See the [handoff guide](handoff.md) for device names, directory mapping, handoff and confirmed takeover before sending. Harness reads the service token from its launching environment rather than automatically loading this repository's `.env`.

### sdk-minimal profiles

The `sdk-minimal` profile uses a different storage entry ID. Use [its overlay](../examples/deepseek/sdk-minimal.patch.yml) instead of the base-profile bundle. Ensure `dsh-contextmesh` is resolvable from that profile and pass the overlay with `--patch` when launching `dsh --profile sdk-minimal`.

Do not apply the base-profile bundle and the SDK overlay together: each replaces the provider in a different profile composition.

## Inspect and export

The CLI reads the repository's `.env`:

```sh
pnpm cli list
pnpm cli stat SESSION_ID
pnpm cli export SESSION_ID
pnpm cli operation OPERATION_ID
```

For a remote service, also set `CONTEXTMESH_ENDPOINT` in `.env` to its HTTPS URL or local SSH-tunnel address. Export writes the complete native log to standard output.

## Resume on another machine

1. Configure both Harness installations to use the same service and token.
2. Prepare the target machine's workspace separately.
3. Stop the source Harness runtime, or explicitly dispose its Agent, and wait for persistence shutdown to release ownership.
4. Use the target Harness's normal Session resume entry point with the same Session ID.

Closing a browser tab alone does not release the writer held by a running Harness server. Only one writer may own a Session. Read-only inspection remains available while another client holds write ownership. Automatic workspace mapping and handoff coordination are not part of the current release.

Workspace groups and title caches belong to each Harness installation. A cold remote Session may initially display its directory name until the local Harness has built its title projection. The native event history remains in ContextMesh.

## Recover after an interrupted writer

Confirm that the previous Harness process and its tools have stopped, then wait for its lease to expire before running:

```sh
pnpm cli recover SESSION_ID --confirm-stopped
```

Resume through Harness after recovery. A lease protects log ownership; it does not stop shell commands or undo external API calls. A database restart alone does not release Session ownership.

See [the plugin API](api/deepseek-adapter.md) for configuration and storage semantics, or [deployment](deployment.md) for Docker and SSH connections.
