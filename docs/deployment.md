# Deployment

ContextMesh runs as a Node.js HTTP service backed by PostgreSQL. Keep the database private and connect Harness clients through HTTPS or an SSH tunnel.

## Docker Compose

The repository includes a [Dockerfile](../Dockerfile) and [Compose configuration](../deploy/compose.yml) for the API and PostgreSQL 18.

From the repository root, create `.env` if you have not already done so:

```sh
cp .env.example .env
```

Set `CONTEXTMESH_TOKEN` and add `POSTGRES_PASSWORD`. Use a distinct random hexadecimal value for each; this avoids URL-encoding issues in the generated database connection string. Generate a value with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Start the stack:

```sh
docker compose --env-file .env -f deploy/compose.yml up --build -d
docker compose --env-file .env -f deploy/compose.yml logs -f server
```

The API is published at `127.0.0.1:8787`. PostgreSQL is reachable only on the Compose network and stores data in a named volume. The API container connects to that database using the Compose settings, rather than the local-development `DATABASE_URL` from `.env`.

Harness runs separately and uses the API token. Building the server image does not install the plugin into Harness; follow [the plugin setup instructions](getting-started.md#install-the-harness-plugin) on each client machine.

## Run with your own PostgreSQL

Build the repository, configure `.env`, and run `pnpm start`. Set `DATABASE_URL` to the database you manage. The API initializes its schema and requires `fsync` and synchronous commit to be enabled.

For a service manager, run the built entry point from the repository root:

```sh
node --env-file=.env dist/server.js
```

The default bind address is `127.0.0.1`. Use `CONTEXTMESH_HOST` and `CONTEXTMESH_PORT` to change it. Put the service behind a TLS reverse proxy when clients connect over a network directly. Operate database backups and access control as part of your deployment.

## Connect through SSH

If the API binds to the server's loopback interface, forward a local port:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:8788:127.0.0.1:8787 user@server
```

On the local Harness client:

```sh
export CONTEXTMESH_ENDPOINT=http://127.0.0.1:8788
export CONTEXTMESH_TOKEN='your-service-token'
```

Keep the tunnel running while the client uses the remote service. The server-side Harness can use `http://127.0.0.1:8787` directly.

The ContextMesh API does not serve the DSH Web UI. To access a remote DSH Web instance, forward its Web port separately and use the login URL printed by that instance. When viewing local and remote DSH together, use `127.0.0.1` for one and `localhost` for the other to avoid sharing their authentication Cookie host.

## Operations

- `GET /health/live` reports process liveness without authentication.
- `GET /health/ready` requires the Bearer token and checks database readiness.
- Keep the same API token on clients and the service; coordinate changes across running processes.
- On shutdown, clients should flush and close their sessions before stopping the API.
- Restarting PostgreSQL does not release a Session's logical write ownership. Follow [the recovery procedure](getting-started.md#recover-after-an-interrupted-writer) after confirming a failed writer has stopped.

Current deployments use one authoritative database and one configured namespace per API instance. Confirmed [workspace file transfer](files.md) is available within that trust domain. Multi-region replication, automatic failover and automatic writer takeover remain outside the current feature set.
