# Install and configure the server

[中文](deployment.zh.md) · [Install the device plugin](getting-started.md) · [Managed runtimes](runtime.md)

Deploy **one ContextMesh Server** for your devices. It stores session history in PostgreSQL, authenticates devices, and coordinates session ownership and transfers. DSH and the ContextMesh plugin run separately on each device that executes tasks. The service host needs the plugin only if it also runs DSH.

## Option A: Docker Compose from source

Requires Git and Docker Compose on the service host. The [Dockerfile](../Dockerfile) builds the API inside Docker; a host Node, pnpm, or DSH installation is not required.

```sh
git clone https://github.com/MarsZheng666/ContextMesh.git contextmesh-server
cd contextmesh-server
cp .env.example .env
chmod 600 .env
```

Configure these entries in this **server-only** `.env`:

| Setting             | Required value                                                 |
| ------------------- | -------------------------------------------------------------- |
| `CONTEXTMESH_TOKEN` | A long random owner token, retained for the first owner device |
| `POSTGRES_PASSWORD` | A different random database password; add this entry           |

Generate each value separately with `openssl rand -hex 32`. Hexadecimal passwords avoid URL-encoding issues in the Compose database URL.

```sh
docker compose --env-file .env -f deploy/compose.yml up --build -d
docker compose --env-file .env -f deploy/compose.yml ps
docker compose --env-file .env -f deploy/compose.yml logs -f server
```

[The Compose file](../deploy/compose.yml) starts PostgreSQL 18 and the API. It supplies the container's `DATABASE_URL`, uses the image's `0.0.0.0` API bind address inside Docker, and publishes the API only on the host's `127.0.0.1:8787`. The example `.env` values for native `DATABASE_URL`, `CONTEXTMESH_HOST`, `CONTEXTMESH_PORT`, and `CONTEXTMESH_NAMESPACE` are not passed through by this Compose file. The default namespace is `personal`; to customize these settings, explicitly change the Compose environment and port mapping.

PostgreSQL is accessible only inside the Compose network. Its data is stored in the `postgres-data` named volume. Preserve that volume and keep a separate database backup; deleting the volume deletes the stored history.

## Make the API reachable

Choose one connection method and give each device the URL it can reach:

| Connection                             | URL configured on the device                                 |
| -------------------------------------- | ------------------------------------------------------------ |
| DSH on the service host                | `http://127.0.0.1:8787`                                      |
| DSH on another device through SSH      | The device's forwarded address, e.g. `http://127.0.0.1:8788` |
| DSH connecting directly over a network | Your HTTPS origin, e.g. `https://mesh.example.com`           |

### Through HTTPS

Put a TLS reverse proxy in front of the API. For example, a Caddy instance running directly on the same host can use:

```caddyfile
mesh.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Replace the domain, point its DNS at this host, and make ports 80/443 available for certificate issuance and HTTPS. This configuration assumes a **host** proxy; inside a container, `127.0.0.1` refers to that container. A containerized proxy must share the API's Docker network and use `server:8787` as its upstream.

Devices then configure `https://mesh.example.com`. Keep PostgreSQL private. Model-provider credentials belong in the individual DSH instances, not in this proxy or the ContextMesh server.

### Connect through SSH

On **each connecting device**, establish its own tunnel:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:8788:127.0.0.1:8787 user@server
```

Replace `user@server` with your SSH destination. This device uses `http://127.0.0.1:8788` as its ContextMesh URL while the tunnel stays open. Use a different local port if 8788 is occupied.

The API does not serve the DSH Web UI. To view a remote DSH, forward its Web port separately and open the login URL printed by that DSH instance. When viewing two DSH instances together, use `127.0.0.1` for one and `localhost` for the other to avoid sharing their authentication Cookie host.

## Connect the first owner, then pair devices

On the first owner device, install [the device plugin](getting-started.md) and configure the reachable API URL plus the server's `CONTEXTMESH_TOKEN`. For subsequent devices, create one-time pairing codes from the owner's DSH instead of sharing the owner token.

All paired devices share this server's configured conversation namespace. They receive independent, revocable credentials. DSH browser login and model-provider authentication do not grant ContextMesh access. See [device access](devices.md).

Do not copy the server's `.env` or database password into client checkouts. If one machine hosts both roles, keep separate server and client directories.

## Option B: an existing PostgreSQL database

Requires Git, Node.js 24.9+, pnpm 11.25.0, and an available PostgreSQL database. Use PostgreSQL 18 to match the current managed deployment and upgrade tooling.

In a server source checkout:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
chmod 600 .env
```

For **native API deployment**, the server reads these settings from `.env`:

| Setting                 | Purpose                                       | Default     |
| ----------------------- | --------------------------------------------- | ----------- |
| `DATABASE_URL`          | Connection string for the database you manage | Required    |
| `CONTEXTMESH_TOKEN`     | Owner credential                              | Required    |
| `CONTEXTMESH_NAMESPACE` | Conversation namespace served by this API     | `personal`  |
| `CONTEXTMESH_HOST`      | Bind address                                  | `127.0.0.1` |
| `CONTEXTMESH_PORT`      | API port                                      | `8787`      |

Set `DATABASE_URL` to your actual database and replace the example token, then start:

```sh
pnpm start
```

For a service manager, run `node --env-file=.env dist/server.js` from the server checkout. Startup initializes the database schema and requires `fsync` and synchronous commit. Use the same HTTPS or SSH connection options above.

`pnpm db:local` is a development-only alternative: run it as a regular user in a separate terminal. It starts PostgreSQL on `127.0.0.1:55432`, matching `.env.example`, and stores data in `.contextmesh/postgres`. It is not needed on client devices or with Docker Compose.

## Option C: generated deployment with a runtime package

When you have a verified runtime package and a published server image pinned by digest, `contextmesh server init` can generate the deployment, secrets, owner connection file, and optional HTTPS proxy. See [the runtime guide](runtime.md#new-server). CI artifacts remain candidates until separately published; this repository's default source Compose path above does not require a published image.

## Operations and upgrades

- `GET /health/live` checks API process liveness without authentication.
- `GET /health/ready` requires an owner or paired-device Bearer credential and checks database readiness and protocol capabilities. `pnpm cli doctor` performs a connection check from a configured device.
- Back up PostgreSQL separately from device configuration. Conversation history lives in the server database; model credentials, local device state, and private connection files live on each device.
- Keep server and client versions compatible. Let clients finish work, flush, and close before stopping or replacing the API.
- For source installations, build the approved target version and restart the API and each DSH with that version after backing up their data. A plugin linked to the same source directory loads its rebuilt code on the next DSH launch; do not add a second ContextMesh plugin.
- Managed package installations have separate [client upgrade](runtime.md#client-upgrades) and [server maintenance, backup, and restore](runtime.md#server-maintenance-backup-and-restore) commands. These commands manage deployments initialized through the runtime tool, not arbitrary existing Compose or native services.

Current schema is **6**. The old 0.6.1 server has no maintenance API: stop all old clients, their tools, and the API, verify they have exited, then back up PostgreSQL before replacing it. Earlier schema versions require an explicit migration procedure. Restoring an old backup replaces newer writes and is a separate recovery action, not an automatic binary rollback.

A database restart or expired lease does not prove a previous writer stopped. Follow [writer recovery](getting-started.md#recover-after-an-interrupted-writer) when needed. The current service uses one authoritative database and one namespace per API instance; multi-region replication and automatic failover are not provided.
