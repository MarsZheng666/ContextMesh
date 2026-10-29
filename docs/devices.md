# Connect another device

[中文](devices.zh.md) · [Deployment](deployment.md)

Install the single `dsh-contextmesh-handoff` plugin with the pinned runtime on each device. Start or upgrade the ContextMesh server first. The server uses schema **5**; back up PostgreSQL and stop older writers before migrating. Session headers and event logs are retained.

## Pair a new device

On an existing owner device, open **Remote sessions → Service connection → Add or revoke a device**. Enter the new device's name and create a pairing code. The invitation is single-use and expires within ten minutes. Only share it with your trusted device.

On the new device, from the repository run:

```sh
pnpm cli setup
```

The wizard asks for the reachable service URL and the pairing code, then writes a private configuration automatically. Use HTTPS for a remote address. A loopback address refers to the new device itself: if using SSH, establish that device's tunnel first and keep it running. Pairing does not install SSH keys or manage an SSH login.

Restart DSH after setup. It reads `$DSH_HOME/contextmesh/connection.json` by default, or `$HOME/.dsh/contextmesh/connection.json` when `DSH_HOME` is unset. Set `CONTEXTMESH_CONFIG` to use another location. The file has mode 600 and its directory must have mode 700. Existing configuration is never replaced implicitly. Keep each device's DSH home separate; pairing supplies a stable node identity.

If the response is lost, rerun setup with exactly the same address and code before expiry. Its private retry file preserves the claim identity so the server returns the same credential instead of issuing another one. To abandon an interrupted attempt, explicitly remove `.pairing-attempt.json` from that configuration directory and request a new invitation. Do not copy either private file into Git or send it to another device.

## Owner and device credentials

Existing `CONTEXTMESH_TOKEN` and explicit plugin configuration remain supported and take precedence over the connection file. The original server token is the owner credential; keep it private. An owner device can create invitations, list paired devices and revoke their credentials in the same panel. A paired device cannot perform these owner operations. Revoke a lost device, then pair its replacement with a new invitation.

The server stores hashes of device tokens and invitation codes. Subsequent requests using a revoked token are rejected; already admitted work may still need to finish or be stopped. Revocation does not undo external tool effects. A claimed invitation cannot reactivate a revoked token.

This is a single-owner service: all paired devices share the server's configured namespace and its conversations. Device credentials bind node registration and node-scoped control requests to that device. They are not per-project access controls or separate user accounts. Those require a future authorization layer. DSH's browser login remains separate from ContextMesh pairing.

## Connection interruptions

The panel retains the last known list, marks connection errors and retries reads with capped backoff. Drafts stay in the client. Before sending, the client checks the current service and ownership again; it never queues offline writes or automatically takes over a failed writer. The transport retries ambiguous mutations using the same request identity.

Keep the server and any required tunnel reachable when starting DSH. Restore connectivity before retrying a failed send. An expired writer still requires the explicit [recovery procedure](handoff.md#interruption-and-recovery) after confirming the original process and its tools have stopped. Reconnecting alone does not authorize recovery or tool replay.
