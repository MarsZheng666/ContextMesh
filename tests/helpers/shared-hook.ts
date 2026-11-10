import { readFile } from 'node:fs/promises'
import { CodexSharedSync } from '../../packages/adapter-codex/src/shared-sync.js'
const chunks: Buffer[] = []
for await (const part of process.stdin) chunks.push(Buffer.from(part))
try {
  const options = JSON.parse(await readFile(process.argv[2]!, 'utf8'))
  await new CodexSharedSync(options).captureHook(
    JSON.parse(Buffer.concat(chunks).toString()),
  )
  process.stdout.write('{}\n')
} catch (error) {
  process.stderr.write(String(error) + '\n')
  process.exitCode = 2
}
