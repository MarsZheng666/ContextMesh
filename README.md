# ContextMesh

English | [中文](README.zh.md)

**Remote session persistence for coding agents.**

ContextMesh gives agent sessions a shared home beyond a single machine. It preserves conversation history, tool calls, and execution events in PostgreSQL, so a session can be closed on one machine and resumed on another.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the first integration. The longer-term goal is a model-independent context service for cross-machine handoff, cross-model relay, and different coding agents.

[Getting started](docs/getting-started.md) · [Plugin API](docs/api/deepseek-adapter.md) · [Deployment](docs/deployment.md)

## Developer preview

ContextMesh is in **developer preview**. The current release provides remote Session storage and recovery for DeepSeek Harness **0.2.1-rc.3**. APIs may change as the project evolves.

Automatic handoff, workspace synchronization, and cross-model relay are planned. Today, close the source session before resuming it elsewhere, and prepare the target workspace separately.

## What it does

- **Preserve native history.** Store messages, tool calls, tool results, and Session events without replacing them with summaries.
- **Resume across machines.** Connect multiple Harness installations to the same service and continue a session after its writer closes.
- **Keep one writer.** Leases and write epochs prevent competing clients from appending to the same session.
- **Self-host the storage.** Run the HTTP service with PostgreSQL, using a local connection, an SSH tunnel, or HTTPS.

```text
DeepSeek Harness A ─┐
                   ├── ContextMesh ── PostgreSQL
DeepSeek Harness B ─┘
```

## Quick start

Requires **Node.js 24.9+**, **pnpm 11.25.0**, and a compatible DeepSeek Harness installation. The local development database is included; you can also use your own PostgreSQL instance.

### 1. Build from source

```sh
git clone https://github.com/MarsZheng666/ContextMesh.git
cd ContextMesh
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
```

Set `CONTEXTMESH_TOKEN` in `.env` to a long random value. Generate one with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### 2. Start the service

Start the local PostgreSQL process in one terminal:

```sh
pnpm db:local
```

In another terminal, from the repository root:

```sh
pnpm start
```

The API listens on `http://127.0.0.1:8787`. Local database files remain in `.contextmesh/postgres` between runs.

### 3. Connect DeepSeek Harness

From the repository root, set the same token used by the service and install the built plugin into your Web profile:

```sh
export CONTEXTMESH_ENDPOINT=http://127.0.0.1:8787
export CONTEXTMESH_TOKEN='your-token-from-.env'
dsh plugin --profile web add "file:$PWD/packages/adapter-deepseek"
dsh --profile web
```

The plugin replaces the profile's JSONL persistence provider. See [getting started](docs/getting-started.md) for profile setup, configuration, and recovery.

## Inspect sessions

```sh
pnpm cli list
pnpm cli stat SESSION_ID
pnpm cli export SESSION_ID
```

Export writes the native session log to standard output. The CLI reads connection settings from the repository's `.env`.

## Roadmap

| Capability                                | Status    |
| ----------------------------------------- | --------- |
| Remote Session persistence and recovery   | Available |
| Controlled handoff with workspace mapping | Planned   |
| Cross-model task relay within one Harness | Planned   |
| Additional coding-agent integrations      | Planned   |

## Development

```sh
pnpm check
```

Runs formatting, upstream fixture integrity checks, type checking, builds, and tests. The suite uses an isolated PostgreSQL instance and does not require model API credentials.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), or [open an issue](https://github.com/MarsZheng666/ContextMesh/issues) for bugs and feature requests.
