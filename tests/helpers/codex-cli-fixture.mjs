import { basename } from 'node:path'

// A native Node executable stands in for codex.exe on every platform. Load
// the RPC fixture before Node attempts to run the 'app-server' entrypoint.
if (basename(process.argv[1] ?? '') === 'app-server') {
  await import('./codex-rpc-fixture.mjs')
  await new Promise((resolve) => process.stdin.once('end', resolve))
  process.exit(0)
}
