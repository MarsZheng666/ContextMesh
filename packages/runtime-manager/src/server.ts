import { mkdir, writeFile, readFile, open } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { privateDirectory, atomicJson, optionalJson } from './files.js'
const exec = promisify(execFile)
export async function initServer(
  directory: string,
  image: string,
  endpoint: string,
) {
  const root = resolve(directory)
  if (!/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('Pin the server image by its sha256 digest')
  const url = new URL(endpoint)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Use a service origin without a path or credentials')
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(url.hostname)
    )
  )
    throw new Error('Remote services require HTTPS')
  await privateDirectory(root)
  const lock = await open(join(root, '.init.lock'), 'wx', 0o600)
  try {
    if (await optionalJson(join(root, 'server.json')))
      throw new Error('Deployment already exists; credentials are preserved')
    const password = randomBytes(32).toString('hex'),
      token = randomBytes(32).toString('hex')
    const https = url.protocol === 'https:'
    const compose = `services:\n  postgres:\n    image: postgres:18.4-bookworm\n    environment:\n      POSTGRES_USER: contextmesh\n      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}\n      POSTGRES_DB: contextmesh\n    volumes: ["database:/var/lib/postgresql"]\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U contextmesh -d contextmesh"]\n      interval: 5s\n      timeout: 3s\n      retries: 20\n    restart: unless-stopped\n  api:\n    image: ${image}\n    environment:\n      DATABASE_URL: postgres://contextmesh:\${POSTGRES_PASSWORD}@postgres:5432/contextmesh\n      CONTEXTMESH_TOKEN: \${CONTEXTMESH_TOKEN}\n      CONTEXTMESH_HOST: 0.0.0.0\n    depends_on:\n      postgres: {condition: service_healthy}\n    ${https ? 'expose: ["8787"]' : 'ports: ["127.0.0.1:' + (url.port || '8787') + ':8787"]'}\n    restart: unless-stopped\n${https ? '  https:\n    image: caddy:2.10.2-alpine\n    ports: ["80:80", "443:443"]\n    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "certificates:/data", "caddy-config:/config"]\n    depends_on: [api]\n    restart: unless-stopped\n' : ''}volumes:\n  database:\n${https ? '  certificates:\n  caddy-config:\n' : ''}`
    await writeFile(
      join(root, '.env'),
      `POSTGRES_PASSWORD=${password}\nCONTEXTMESH_TOKEN=${token}\n`,
      { flag: 'wx', mode: 0o600 },
    )
    await writeFile(join(root, 'compose.yaml'), compose, {
      flag: 'wx',
      mode: 0o600,
    })
    if (https)
      await writeFile(
        join(root, 'Caddyfile'),
        `${url.hostname} {\n  reverse_proxy api:8787\n}\n`,
        { flag: 'wx', mode: 0o600 },
      )
    await atomicJson(join(root, 'owner-connection.json'), {
      version: 1,
      endpoint: url.origin,
      token,
      nodeId: randomUUID(),
      name: 'Owner device',
    })
    await atomicJson(join(root, 'server.json'), {
      version: 1,
      image,
      endpoint: url.origin,
      postgresMajor: 18,
    })
    return {
      directory: root,
      endpoint: url.origin,
      ownerFile: join(root, 'owner-connection.json'),
      https,
    }
  } finally {
    await lock.close()
  }
}
export async function startServer(directory: string) {
  const root = resolve(directory)
  if (!(await optionalJson(join(root, 'server.json'))))
    throw new Error('Run server init first')
  await exec(
    'docker',
    ['compose', '--project-directory', root, 'up', '-d', '--wait'],
    { timeout: 180000, maxBuffer: 1024 * 1024 },
  )
  return { started: true }
}
