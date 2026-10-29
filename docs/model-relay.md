# Continue with another model

[中文](model-relay.zh.md) · [Device handoff](handoff.md)

ContextMesh can continue the same DeepSeek Harness conversation with another configured model, including a different provider route. The original Session and event history remain intact. Completed tools are history, not work to run again.

## Requirements

Use the single `dsh-contextmesh-handoff` plugin with this repository's pinned DSH runtime and compatibility patches. Update the ContextMesh server and participating devices together. The server advertises `model-relay-v1`; a device without the model-selection bridge cannot perform model relay.

Configure model credentials independently on the device that will execute the conversation. They never enter relay records or travel with a handoff. A target that explicitly selects another model does not need the source provider installed or authenticated.

This preview supports text conversations with completed tool calls and results. Image, file and spill resources, addressed child agents, persistent terminals, background jobs, schedules and pending input are not portable. End or remove those resources before relay. Adapters remain responsible for translating the common DSH message vocabulary and their own private replay state; not every provider/model combination is certified by ContextMesh.

## Change the model on this device

Open the conversation and use DSH's existing model selector. For a provider change, confirm the notice that subsequent requests will send the required conversation history to that provider. Cancel leaves the current selection and draft unchanged.

ContextMesh freezes new input, waits for admitted work to finish, checks the target and saves a native `model/selection` event. Input reopens after remote persistence is confirmed. Selecting a model does not generate a response. The next message uses the selected route. With ContextMesh enabled, this operation changes only this conversation; it does not save a new global default for other conversations.

The existing native selector remains the entry point. No additional plugin needs installation. A live task that cannot finish within the configured wait period leaves the existing model in place; let the task finish and retry.

## Change the device and model together

In the input dock, choose the target device and optionally **Continue with model**. **Keep the current model** preserves normal handoff behavior. The target's advertised catalog is a convenience; final validation runs on that target with its actual preset and credentials.

On a remote conversation, the dock also offers models configured on the current device. Select one and click **Take over here**. Choosing a model through the native selector on a remote conversation enters the same confirmed takeover flow. Missing project/folder mapping opens the existing setup dialog first. Cancellation preserves drafts.

The source model stays unchanged while both devices check the transfer. The target installs its selected model during controlled restoration and persists it before input opens. Target preflight failure leaves the source writer available. A failure after the source has closed follows the explicit handoff recovery flow; changing a model never silently reopens the source.

Ordinary folders still need no Git. Git workspaces still require matching clean commits. Only context transfers: files stay on their respective devices.

## Compatibility and capacity

Targets must declare text input and a known context window. ContextMesh checks portable content, matching tool calls/results, valid tool-argument JSON and the target's reasoning controls. Explicit output limits are checked with the target; omitted reasoning controls use its defaults instead of inheriting the previous model's effort.

Capacity checks conservatively count serialized UTF-8 bytes against the model's token window, reserve output capacity and leave additional headroom. This is deliberately an estimate, not a provider tokenizer. It can reject a conversation that a more precise tokenizer would fit. The first and subsequent routed requests are checked again with their assembled messages and tools. Provider-side authentication, availability and context errors can still occur at dispatch. History is never silently truncated or replaced by an automatic summary to make relay succeed.

DSH retains provider-private replay state in the original log and only passes it to an adapter that owns the historical and target route. Cross-adapter requests use DSH's provider-neutral projection. Relay does not promise to transfer hidden model state.

## CLI

Run from the repository using a running DSH's private control socket. Add `--state-dir` for a custom location.

```sh
pnpm cli models
pnpm cli model-select SESSION_ID PROVIDER MODEL
pnpm cli model-select SESSION_ID PROVIDER MODEL --reasoning-effort high --operation-id UUID
pnpm cli model-relay-status UUID
pnpm cli handoff SESSION_ID TARGET_NODE_ID --provider PROVIDER --model MODEL
pnpm cli takeover SESSION_ID --confirm --provider PROVIDER --model MODEL
```

Reuse the same operation ID with the same selection to inspect or retry an uncertain switch. Reusing it for another selection is rejected. CLI model selection is an explicit request to send subsequent conversation history to the named provider.

## Failed or interrupted switches

Model changes have durable operation records bound to the original Session incarnation, writer and event cut. A lost response is reconciled against that record and the native event instead of appending the selection twice. While the outcome is uncertain, new input remains frozen and the draft stays in the client.

Keep the device running and restore its connection. On restart, a persisted selection can be confirmed without calling the model. A switch with no selection event can be abandoned only when its original writer is confirmed closed or superseded through explicit recovery; lease expiry alone does not prove a safe rollback. The [handoff recovery rules](handoff.md#interruption-and-recovery) still apply to external tools. A model failure after switching does not undo tool side effects or automatically select another provider.

## Database upgrade

The server uses schema **4**. Back up PostgreSQL and stop older writers before upgrade. Migration from schemas 1, 2 or 3 preserves existing headers and events, adds model-relay records and optional target-model takeover data. The prior server rejects schema 4; rollback requires the backup. The native DSH Session format remains unchanged.
