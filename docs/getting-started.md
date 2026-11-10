# Install and configure the device plugin

[中文](getting-started.zh.md) · [Server installation](deployment.md) · [Device pairing](devices.md)

Use this guide on **each device running DSH**. Deploy one [ContextMesh Server](deployment.md) first. Devices need a service URL and a credential; they do not need PostgreSQL or a local ContextMesh API process.

For Codex Desktop on Windows, use the [Windows installation guide](runtime.md#windows-codex-device).

## Choose an installation method

- **Source:** follow the steps below. Requires Git, Node.js 24.9+, and pnpm 11.25.0.
- **Self-contained runtime:** includes Node, the compatible DSH, and the same single plugin. Candidate package availability, supported platforms, setup, and upgrades are documented in the [runtime guide](runtime.md).

Both methods use the pinned DSH 0.2.1-rc.3 with this repository's compatibility patches. An arbitrary global DSH installation is not a substitute.

## Install the Harness plugin

Use a client checkout separate from the server checkout, even on the same machine:

```sh
git clone https://github.com/MarsZheng666/ContextMesh.git contextmesh-client
cd contextmesh-client
corepack enable
pnpm install --frozen-lockfile
pnpm build

export DSH_HOME="$HOME/.dsh-contextmesh"
export CONTEXTMESH_NODE_NAME='My laptop'
pnpm exec dsh plugin --profile web add "link:$PWD/packages/handoff-deepseek"
```

Only `dsh-contextmesh-handoff` appears in the installed-plugin list. It loads persistence internally. Keep the same `DSH_HOME` when configuring and starting this device. Use a separate home for each DSH instance; never copy another device's home or `node.json`.

Do not create the server's `.env` in this client checkout. The source CLI loads a repository `.env`, whereas `pnpm exec dsh` does not automatically load it. A leftover owner token can override a paired device's saved credential.

## Configure the service connection

| Device setting             | Where to configure it                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| Service URL                | `endpoint` in the private connection file, or `CONTEXTMESH_ENDPOINT`                     |
| Device credential          | Pairing writes `token` automatically; only the first owner uses the server's owner token |
| Device identity and name   | Pairing writes `nodeId` and `name`; owner setup is shown below                           |
| DSH data directory         | `DSH_HOME`; this guide uses `$HOME/.dsh-contextmesh`                                     |
| Model provider and API key | Configure locally in DSH, independently of ContextMesh                                   |

**Use HTTPS direct connection by default**, for example `https://mesh.example.com`. Replace that example with your deployed service URL; each device connects to it with its own credential. No SSH setup is required. The server's [HTTPS configuration](deployment.md#https-direct-connection-default) must be ready before pairing.

For an optional SSH-only deployment, use the local forwarded URL from the [SSH guide](deployment.md#optional-ssh-tunnel). Same-host local development can use `http://127.0.0.1:8787`.

### First owner: try the connection

In the client checkout, with the `DSH_HOME` above still set:

```sh
export CONTEXTMESH_ENDPOINT='https://mesh.example.com'
export CONTEXTMESH_TOKEN='your-server-owner-token'
pnpm cli doctor
```

The token is the server's `CONTEXTMESH_TOKEN`. Keep it on your owner device. These exports apply to the current terminal, so later launches need the same environment or a saved connection file.

### Save the owner connection

If DSH is already running, finish its work and stop it before changing its connection configuration. For a persistent owner configuration, create a private file at `$DSH_HOME/contextmesh/connection.json`. If it already exists, keep it and inspect the current configuration instead of overwriting it.

```sh
mkdir -p "$DSH_HOME/contextmesh"
chmod 700 "$DSH_HOME/contextmesh"
node -e "console.log(require('node:crypto').randomUUID())"
```

Create the following JSON with a text editor, replacing the URL, token, and UUID with your values. For a new device, use the UUID generated above. If this DSH home already has `contextmesh/node.json`, reuse its `nodeId` instead. Keep that identity stable:

```json
{
  "version": 1,
  "endpoint": "https://mesh.example.com",
  "token": "REPLACE_WITH_SERVER_OWNER_TOKEN",
  "nodeId": "REPLACE_WITH_GENERATED_UUID",
  "name": "My laptop"
}
```

Then apply the required private file permissions and use the saved connection:

```sh
chmod 600 "$DSH_HOME/contextmesh/connection.json"
unset CONTEXTMESH_TOKEN CONTEXTMESH_ENDPOINT
pnpm cli doctor
```

If the server was created with `contextmesh server init`, it already generated a private `owner-connection.json`. Transfer that file securely to the first owner device, preserve mode 600, run `pnpm cli setup`, and choose **private owner connection file** to import it instead of creating another file. For the default HTTPS deployment, keep its service HTTPS endpoint so all devices use the same address. Only for the optional SSH deployment, update the imported copy's endpoint to this device's local tunnel address before setup.

### Additional devices: pair instead of copying the owner token

1. On the owner device, open **Remote sessions → Service connection → Add or revoke a device** and create a code for the new device.
2. On the new device, set its own `DSH_HOME` as above, then run:

   ```sh
   unset CONTEXTMESH_TOKEN CONTEXTMESH_ENDPOINT
   pnpm cli setup
   ```

3. Select **pairing code**, then enter the same HTTPS service URL used by the owner device and the code. The wizard writes `$DSH_HOME/contextmesh/connection.json` with a private credential and stable identity.
4. Run `pnpm cli doctor` to check the connection, then start DSH below.

The code is single-use and expires within ten minutes. See [device access](devices.md) for retries and revocation. Explicit plugin or environment credentials override the saved connection; `doctor` shows which source is in use without printing the credential. `CONTEXTMESH_CONFIG` can select a different private connection file.

## Start DSH and configure a model

From the client checkout, using the same DSH home and connection settings:

```sh
pnpm exec dsh --profile web --host 127.0.0.1 --port 3080 --no-open
```

Open the authenticated URL printed by DSH. Use this repository's `pnpm exec dsh` on later launches so the compatibility patches remain active. Choose a different Web port if another DSH runs on the same machine.

Configure model providers in DSH on each device. ContextMesh does not grant model-provider access or transfer API keys. The receiver can use a different model from the source; DSH's native model selector controls the local choice.

The Web login URL belongs to this DSH instance. It is not the ContextMesh service URL and must not be entered into the pairing wizard.

## Check the installation and continue a task

- **Plugins:** one enabled `dsh-contextmesh-handoff` entry, with persistence and handoff components running.
- **Remote sessions:** the service is connected and both participating devices are online.
- **Model:** a locally configured model is available in the native selector.

Map the same project to each device's local directory when prompted. Use **Hand off** on the source or **Take over here** on the receiver. Running-task takeover checks the receiver before stopping the source and automatically continues unfinished work after activation. See [handoff and recovery](handoff.md), [model compatibility](model-relay.md), and [file transfer](files.md).

## Inspect and export

With this device's saved connection or owner environment configured:

```sh
pnpm cli list
pnpm cli stat SESSION_ID
pnpm cli export SESSION_ID
pnpm cli operation OPERATION_ID
```

Export writes the native session log to standard output. Closing a browser tab does not stop the DSH process or release its session writer.

## Recover after an interrupted writer

Confirm that the previous DSH process and its tools have stopped, then wait for its lease to expire before running:

```sh
pnpm cli recover SESSION_ID --confirm-stopped
```

Resume through DSH after recovery. A lease does not stop shell commands or undo external effects, and a database restart does not release logical ownership. Use [coordinated handoff](handoff.md) for ordinary transfers.

## SDK integration

For a custom `sdk-minimal` integration, use [its overlay](../examples/deepseek/sdk-minimal.patch.yml). Its persistence entry differs from the Web/base profile. Make `dsh-contextmesh` resolvable and pass the overlay with `--patch` when launching `dsh --profile sdk-minimal`; do not combine it with the complete Web plugin bundle. This is an integration path, not an additional plugin for ordinary DSH users.
