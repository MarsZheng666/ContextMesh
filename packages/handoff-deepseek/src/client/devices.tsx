import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { Snapshot } from './state.js'
import type { Key } from './locales.js'
const invite = z.object({
  code: z.string(),
  expiresAt: z.number(),
  name: z.string(),
})
const credentials = z.array(
  z.object({ id: z.string(), name: z.string(), revoked: z.boolean() }),
)
export function DeviceSetup({
  connection,
  request,
  t,
}: {
  connection: Snapshot['connection']
  request: (command: unknown) => Promise<unknown>
  t: (key: Key) => string
}) {
  const [name, setName] = useState(''),
    [pair, setPair] = useState<z.infer<typeof invite>>(),
    [devices, setDevices] = useState<z.infer<typeof credentials>>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const attempt = useRef<{ name: string; id: string }>()
  useEffect(() => {
    if (!pair) return
    const timer = setTimeout(
      () => setPair(undefined),
      Math.max(0, pair.expiresAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [pair])
  const run = async (body: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await body()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="cm-card">
      <h2>{t('connectionTitle')}</h2>
      <p>{connection?.endpoint}</p>
      {connection?.role === 'owner' ? (
        <details>
          <summary>{t('manageDevices')}</summary>
          <p>{t('pairHelp')}</p>
          <label>
            {t('newDeviceName')}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </label>
          <button
            disabled={busy || !name.trim()}
            onClick={() =>
              void run(async () => {
                if (attempt.current?.name !== name.trim())
                  attempt.current = {
                    name: name.trim(),
                    id: crypto.randomUUID(),
                  }
                setPair(
                  invite.parse(
                    await request({
                      action: 'pair-device',
                      name: attempt.current.name,
                      operationId: attempt.current.id,
                    }),
                  ),
                )
                attempt.current = undefined
              })
            }
          >
            {t('createPairing')}
          </button>
          {pair && (
            <div role="status">
              <p>
                {t('pairCode')}: <code>{pair.code}</code>
              </p>
              <p>
                {t('pairExpires')}:{' '}
                {new Date(pair.expiresAt).toLocaleTimeString()}
              </p>
              <p>{t('pairInstructions')}</p>
            </div>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setDevices(
                  credentials.parse(
                    await request({ action: 'paired-devices' }),
                  ),
                )
              })
            }
          >
            {t('listDevices')}
          </button>
          {devices.map((device) => (
            <div key={device.id} className="cm-row">
              <span>{device.name}</span>
              <button
                disabled={busy || device.revoked}
                onClick={() => {
                  if (window.confirm(t('revokeConfirm') + ' ' + device.name))
                    void run(async () => {
                      await request({
                        action: 'revoke-device',
                        credentialId: device.id,
                        confirmed: true,
                      })
                      setDevices(
                        credentials.parse(
                          await request({ action: 'paired-devices' }),
                        ),
                      )
                    })
                }}
              >
                {device.revoked ? t('revoked') : t('revoke')}
              </button>
            </div>
          ))}
        </details>
      ) : (
        <p>{t('ownerPairing')}</p>
      )}
      {error && (
        <p role="alert" className="cm-error">
          {error}
        </p>
      )}
    </section>
  )
}
