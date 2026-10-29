# ContextMesh

English | [中文](README.zh.md)

**Remote session persistence for coding agents.**

ContextMesh gives agent sessions a shared home beyond a single machine. It preserves conversation history, tool calls, and execution events in PostgreSQL, so a session can be closed on one machine and resumed on another.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the first integration. The longer-term goal is a model-independent context service for cross-machine handoff, cross-model relay, and different coding agents.

[Getting started](docs/getting-started.md) · [Plugin API](docs/api/deepseek-adapter.md) · [Handoff](docs/handoff.md) · [Deployment](docs/deployment.md) · [Model relay](docs/model-relay.md)

[Connect devices](docs/devices.md)

## Developer preview

ContextMesh is in **developer preview**. M1/M2 provide remote Session storage, coordinated cross-machine handoff and model relay for the pinned DeepSeek Harness **0.2.1-rc.3** runtime. APIs may change as the project evolves.

Hand off a conversation to a folder on another device, with shared titles, a remote session panel and a single writer. Plain folders need no Git; code workspaces still require the same clean Git commit on both devices. M1 requires the explicit DSH compatibility patches shipped in this repository. Continue with another configured model through the native selector or choose a model during device takeover. See [model relay](docs/model-relay.md). File synchronization remains planned.

## What it does

- **Preserve native history.** Store messages, tool calls, tool results, and Session events without replacing them with summaries.
- **Hand off across machines.** Validate both workspaces, stop the source Agent, and restore its conversation on the designated device.
- **Find shared sessions.** Browse project groups, shared titles, history, current ownership and progress from the DSH sidebar.
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

Use the pinned, patched runtime built above and install the complete plugin. It includes remote persistence and the handoff UI in one installed entry:

```sh
export CONTEXTMESH_ENDPOINT=http://127.0.0.1:8787
export CONTEXTMESH_TOKEN='your-token-from-.env'
pnpm exec dsh plugin --profile web add "link:$PWD/packages/handoff-deepseek"
pnpm exec dsh --profile web
```

Follow the [handoff guide](docs/handoff.md) to configure device names, workspace mapping, and upgrades from the earlier two-plugin installation. See [getting started](docs/getting-started.md) for server setup.

## Inspect sessions

```sh
pnpm cli list
pnpm cli stat SESSION_ID
pnpm cli export SESSION_ID
```

Export writes the native session log to standard output. The CLI reads connection settings from the repository's `.env`.

## Roadmap

| Capability                                | Status       |
| ----------------------------------------- | ------------ |
| Remote Session persistence and recovery   | Available    |
| Controlled handoff with workspace mapping | M1 preview   |
| Cross-model task relay within one Harness | M2 preview   |
| Device pairing and guided configuration   | M2.1 preview |
| Additional coding-agent integrations      | Planned      |

## Development

```sh
pnpm check
```

Runs formatting, upstream fixture integrity checks, type checking, builds, and tests. The suite uses an isolated PostgreSQL instance and does not require model API credentials.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), or [open an issue](https://github.com/MarsZheng666/ContextMesh/issues) for bugs and feature requests.
