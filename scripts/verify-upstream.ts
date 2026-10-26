import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
const manifest = JSON.parse(
  await readFile('tests/upstream/source.json', 'utf8'),
) as { files: { path: string; adaptedSha256: string }[] }
for (const entry of manifest.files) {
  const data = await readFile(`tests/upstream/${basename(entry.path)}`)
  if (createHash('sha256').update(data).digest('hex') !== entry.adaptedSha256)
    throw new Error(`upstream fixture changed: ${entry.path}`)
}
console.log('Upstream fixture hashes verified')
