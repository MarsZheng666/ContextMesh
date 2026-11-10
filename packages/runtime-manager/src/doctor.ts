import {
  resolveConnection,
  safeEndpoint,
  type ConnectionOptions,
} from '../../client/src/config.js'
export function connectionFailure(error: unknown): {
  code: string
  advice: string
} {
  const codes: string[] = []
  let current = error
  for (let i = 0; i < 6 && current && typeof current === 'object'; i++) {
    const e = current as { code?: unknown; name?: unknown; cause?: unknown }
    codes.push(String(e.code ?? e.name ?? ''))
    current = e.cause
  }
  const text = codes.join(' ')
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(text))
    return {
      code: 'TLS_ERROR',
      advice:
        'Renew the server certificate or configure the correct trusted CA. Do not disable certificate verification.',
    }
  if (/ENOTFOUND|EAI_AGAIN/.test(text))
    return {
      code: 'DNS_ERROR',
      advice: 'Check the service hostname and DNS connection.',
    }
  if (/ECONNREFUSED/.test(text))
    return {
      code: 'CONNECTION_REFUSED',
      advice: 'Check the server listener or the managed SSH tunnel.',
    }
  if (/Timeout|ETIMEDOUT|Abort/.test(text))
    return {
      code: 'TIMEOUT',
      advice: 'Check the network, firewall and server availability.',
    }
  return {
    code: 'NETWORK_ERROR',
    advice: 'Check the network and service address, then retry.',
  }
}
export async function diagnose(
  options: ConnectionOptions = {},
  transport: typeof fetch = fetch,
) {
  let config
  try {
    config = await resolveConnection(options)
  } catch {
    return {
      ready: false,
      configuration: 'invalid',
      code: 'CONFIG_INVALID',
      advice:
        process.platform === 'win32'
          ? 'Check the connection file format and Windows account permissions.'
          : 'Check the connection file format and private file permissions (600).',
    }
  }
  const base = {
    endpoint: safeEndpoint(config.endpoint),
    source: config.source,
    warnings: config.warnings,
  }
  if (!config.token || !config.endpoint)
    return {
      ...base,
      ready: false,
      configuration: 'missing',
      code: 'NOT_CONFIGURED',
      advice: 'Run contextmesh setup, or open Connection setup in DSH.',
    }
  let url: URL
  try {
    url = new URL(config.endpoint)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['https:', 'http:'].includes(url.protocol)
    )
      throw Error()
    if (
      url.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      throw Error()
  } catch {
    return {
      ...base,
      ready: false,
      code: 'ADDRESS_INVALID',
      advice: 'Use HTTPS for a remote service, with no credentials in the URL.',
    }
  }
  try {
    const response = await transport(
      url.toString().replace(/\/$/, '') + '/health/ready',
      {
        headers: { authorization: 'Bearer ' + config.token },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      },
    )
    if (response.status === 401 || response.status === 403)
      return {
        ...base,
        ready: false,
        transport: 'connected',
        authentication: 'rejected',
        code: 'AUTH_REJECTED',
        advice:
          'The device credential is invalid or revoked. Ask an owner device for a new pairing.',
      }
    if (!response.ok)
      return {
        ...base,
        ready: false,
        transport: 'connected',
        code: 'SERVICE_NOT_READY',
        advice: 'Check the server health and PostgreSQL connection.',
      }
    const body = (await response.json()) as {
      protocolVersion?: number
      maintenance?: boolean
    }
    if (body.protocolVersion !== 1)
      return {
        ...base,
        ready: false,
        transport: 'connected',
        code: 'VERSION_INCOMPATIBLE',
        advice: 'Install a compatible ContextMesh client and server.',
      }
    return {
      ...base,
      ready: !body.maintenance,
      transport: 'connected',
      authentication: 'accepted',
      code: body.maintenance ? 'MAINTENANCE' : 'READY',
      advice: body.maintenance
        ? 'Wait for server maintenance to finish.'
        : 'Connection is ready. Session ownership is checked separately.',
    }
  } catch (error) {
    return { ...base, ready: false, ...connectionFailure(error) }
  }
}
