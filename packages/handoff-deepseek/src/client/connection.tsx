import { useState } from 'react'
import type { Snapshot } from './state.js'
import type { Key } from './locales.js'
export function ConnectionSetup({
  data,
  request,
  refresh,
  t,
}: {
  data: Snapshot
  request: (input: unknown) => Promise<unknown>
  refresh: () => Promise<void>
  t: (key: Key) => string
}) {
  const [url, setUrl] = useState(''),
    [code, setCode] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const state = data.connectivity
  if (!state) return null
  const run = async (pair: boolean) => {
    setBusy(true)
    setError('')
    try {
      await request(
        pair
          ? {
              action: 'connection-pair',
              endpoint: url.trim(),
              code: code.trim(),
            }
          : { action: 'connection-retry' },
      )
      setCode('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="cm-card" aria-label={t('connectionSetup')}>
      <h2>{t('connectionSetup')}</h2>
      <p role="status">
        {t(
          state.state === 'ready'
            ? 'connectionReady'
            : state.state === 'offline'
              ? 'connectionOffline'
              : 'connectionMissing',
        )}
      </p>
      {state.endpoint && <code>{state.endpoint}</code>}
      {state.code && <p>{state.code}</p>}
      {state.lastSync && state.state !== 'ready' && (
        <p>
          {t('lastSync')}: {new Date(state.lastSync).toLocaleString()}
        </p>
      )}
      <details>
        <summary>{t('configSource')}</summary>
        {Object.entries(state.source).map(([key, value]) => (
          <p key={key}>
            {key}: {value}
          </p>
        ))}
      </details>
      {state.state === 'unconfigured' && (
        <form
          className="cm-form"
          onSubmit={(e) => {
            e.preventDefault()
            void run(true)
          }}
        >
          <label>
            {t('serviceUrl')}
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label>
            {t('pairCode')}
            <input
              type="password"
              required
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button disabled={busy}>{t('connectDevice')}</button>
        </form>
      )}
      {state.state === 'offline' && (
        <button disabled={busy} onClick={() => void run(false)}>
          {t('retryConnection')}
        </button>
      )}
      {error && (
        <p className="cm-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
