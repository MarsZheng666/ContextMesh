import { test, expect } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connectionFailure,
  diagnose,
} from '../../packages/runtime-manager/src/doctor.js'
import {
  tunnelArgs,
  tunnelFailure,
} from '../../packages/runtime-manager/src/tunnel.js'
import { initServer } from '../../packages/runtime-manager/src/server.js'
import { autostartTemplate } from '../../packages/runtime-manager/src/autostart.js'
const token = 'this-is-a-test-credential-not-for-production'
test('doctor separates TLS, DNS, auth, database and protocol failures without disclosing tokens', async () => {
  expect(connectionFailure({ cause: { code: 'CERT_HAS_EXPIRED' } }).code).toBe(
    'TLS_ERROR',
  )
  expect(connectionFailure({ cause: { code: 'ENOTFOUND' } }).code).toBe(
    'DNS_ERROR',
  )
  for (const [status, code] of [
    [401, 'AUTH_REJECTED'],
    [503, 'SERVICE_NOT_READY'],
  ] as const) {
    const result = await diagnose(
      { endpoint: 'https://example.invalid', token },
      async () => new Response('{}', { status }),
    )
    expect(result.code).toBe(code)
    expect(JSON.stringify(result)).not.toContain(token)
  }
  expect(
    (
      await diagnose({ endpoint: 'https://example.invalid', token }, async () =>
        Response.json({ protocolVersion: 2 }),
      )
    ).code,
  ).toBe('VERSION_INCOMPATIBLE')
  const redacted = await diagnose({
    endpoint: 'https://user:secret@example.invalid/?token=private',
    token,
  })
  expect(redacted.code).toBe('ADDRESS_INVALID')
  expect(JSON.stringify(redacted)).not.toMatch(/secret|private/)
})
test('SSH stays on loopback, fails closed for host keys and rejects option injection', () => {
  const args = tunnelArgs({
    host: 'my-host',
    localPort: 18793,
    remotePort: 8792,
  })
  expect(args).toContain('127.0.0.1:18793:127.0.0.1:8792')
  expect(args).toContain('StrictHostKeyChecking=yes')
  expect(() =>
    tunnelArgs({
      host: '-oProxyCommand=evil',
      localPort: 18793,
      remotePort: 8792,
    }),
  ).toThrow()
  expect(tunnelFailure('bind: Address already in use')).toBe('PORT_IN_USE')
  expect(tunnelFailure('Permission denied')).toBe('SSH_AUTH_REQUIRED')
})
test('server initialization preserves private credentials and keeps PostgreSQL private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm-server-init-'))
  try {
    await initServer(
      root,
      'ghcr.io/example/server@sha256:' + 'a'.repeat(64),
      'https://mesh.example.test',
    )
    const before = await readFile(join(root, '.env'), 'utf8')
    await expect(
      initServer(
        root,
        'ghcr.io/example/server@sha256:' + 'a'.repeat(64),
        'https://mesh.example.test',
      ),
    ).rejects.toThrow()
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(before)
    const compose = await readFile(join(root, 'compose.yaml'), 'utf8')
    expect(compose).not.toContain('5432:5432')
    expect(compose).toContain('certificates:/data')
    expect(autostartTemplate('/tmp/a b', 'linux').content).toContain(
      '"/tmp/a b/bin/contextmesh"',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
