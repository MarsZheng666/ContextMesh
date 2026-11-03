# ContextMesh

English | [中文](README.zh.md)

**Continue the same agent conversation across devices and models.**

ContextMesh stores native conversation history, tool calls, tool results, and execution events in a shared PostgreSQL service. Start on your laptop, hand the conversation to another device, and continue from the same history—with one device in control at a time.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the first integration. The goal is a model-independent context service that can connect different coding agents over time.

[Getting started](docs/getting-started.md) · [Device pairing](docs/devices.md) · [Handoff](docs/handoff.md) · [Model relay](docs/model-relay.md) · [File transfer](docs/files.md) · [Deployment](docs/deployment.md)

## What you can do

- **Keep the original conversation.** Persist native Session events without replacing history with summaries or rerunning completed tools.
- **Continue on another device.** Hand off explicitly, or confirm a takeover when sending from a remote conversation. Shared titles, history, and the owning device remain visible in DSH.
- **Change models within the same conversation.** Use DSH’s native model selector to switch to another configured route. Check history compatibility and context capacity before switching.
- **Connect a new device.** Create a one-time pairing code, run the setup wizard on the new device, and revoke its credential if needed.
- **Bring selected files with you.** Preview workspace changes and supported file attachments, then confirm their transfer and application on the receiving device.
- **Install one plugin.** `dsh-contextmesh-handoff` includes persistence and the UI; internal components load automatically.
- **Run your own service.** Use PostgreSQL with a local connection, an SSH tunnel, or HTTPS. Write leases and epochs keep one session writer active at a time.

```text
DeepSeek Harness · laptop ─┐
                          ├── ContextMesh ── PostgreSQL
DeepSeek Harness · server ─┘
```

## Current preview

The current plugin is **0.6.1**, in **developer preview**. It requires this repository’s pinned **DeepSeek Harness 0.2.1-rc.3** runtime and compatibility patches. A standard global DSH installation does not include those extensions. APIs may change.

Device handoff preserves the conversation’s **current provider, model, and reasoning selection**. There is no separate handoff-model selector. To use another model, change it through DSH’s native selector as a separate action. Configure the current model and its credentials on the receiving device first; API keys are not transferred and a missing model is never silently substituted.

Plain conversations can move between ordinary folders without Git. Code workspaces require the same base Git commit on both devices; uncommitted changes can use the confirmed file-transfer flow. ContextMesh does not clone repositories, switch branches, or synchronize an entire directory automatically.

Model relay currently supports text and completed tool history. File transfer supports native **file** attachments; images, spill resources, and live processes are unsupported. See the [model](docs/model-relay.md) and [file](docs/files.md) guides for compatibility, transfer limits, and recovery.

## Quick start

Requires **Node.js 24.9+** and **pnpm 11.25.0**. The steps below build the compatible DSH runtime and the single plugin from source. A local development PostgreSQL launcher is included; you can also use your own PostgreSQL instance.

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

The API listens on `http://127.0.0.1:8787`. Local database files remain in `.contextmesh/postgres` between runs. Startup applies database migrations automatically.

### 3. Install the plugin and start DSH

From the repository root, in the terminal that will run DSH:

```sh
export DSH_HOME="$HOME/.dsh-contextmesh"
export CONTEXTMESH_NODE_NAME='My laptop'
export CONTEXTMESH_ENDPOINT='http://127.0.0.1:8787'
export CONTEXTMESH_TOKEN='your-token-from-.env'
pnpm exec dsh plugin --profile web add "link:$PWD/packages/handoff-deepseek"
pnpm exec dsh --profile web --host 127.0.0.1 --port 3080 --no-open
```

Open the authenticated URL printed by DSH. Keep using this repository’s `pnpm exec dsh` so the compatibility patches are loaded. Configure your model provider in DSH separately; the ContextMesh service token does not sign you in to a model provider.

### 4. Connect another device and continue

Install the same runtime and single plugin on the new device, using its own DSH home. On the owner device, open **Remote sessions → Service connection → Add or revoke a device** and create a pairing code. Run `pnpm cli setup` on the new device with the same DSH home selected, enter its reachable service URL and the code, then restart DSH. Keep the owner token and owner `.env` on the owner device; explicit credentials override a paired connection. Use the [device pairing guide](docs/devices.md) for connection-file settings and credential precedence.

Open **Remote sessions** to map a project to a folder on each device. Paths may differ. In a conversation, choose an online target and **Hand off**; on the receiving device, open the conversation and continue. Sending from a remote conversation can also ask to **Take over here**. See the [handoff guide](docs/handoff.md) for project setup and recovery.

## Inspect sessions

```sh
pnpm cli list
pnpm cli stat SESSION_ID
pnpm cli export SESSION_ID
```

Export writes the native session log to standard output. The CLI reads connection settings from the repository’s `.env` or a paired-device connection file. Explicit environment credentials take precedence. The [plugin API](docs/api/deepseek-adapter.md) describes the persistence interface.

## Deployment and upgrades

All paired devices share the configured owner namespace and its conversations; pairing is separate from DSH’s browser login. Use HTTPS for remote service connections, or a loopback endpoint through an SSH tunnel. A loopback address always refers to the device using it.

The current database schema is **6**. Before upgrading an existing installation, back up PostgreSQL and stop older writers, then upgrade the server and participating devices together. Older server binaries cannot use schema 6; rollback requires the backup. See [deployment](docs/deployment.md), [device pairing](docs/devices.md), and [file-transfer upgrades](docs/files.md#upgrade).

## Roadmap

| Capability                                                    | Status               |
| ------------------------------------------------------------- | -------------------- |
| Native Session persistence and recovery                       | Available in preview |
| Cross-device handoff, takeover, and workspace mapping         | Available in preview |
| Model switching, compatibility checks, and capacity preflight | Available in preview |
| Device pairing and revocable credentials                      | Available in preview |
| Confirmed workspace changes and file attachment transfer      | Available in preview |
| Additional coding-agent integrations                          | Planned              |

## Development

```sh
pnpm check
```

Runs formatting, upstream fixture integrity checks, type checking, builds, and tests. The suite uses an isolated PostgreSQL instance and does not require model API credentials.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), or [open an issue](https://github.com/MarsZheng666/ContextMesh/issues) for bugs and feature requests.
