import { useRef, useState } from 'react'
import { modelCheckSchema, ControlError, type Snapshot } from './state.js'
import { en, type Key } from './locales.js'
import type { z } from 'zod'
export function ModelCheckPanel({
  data,
  request,
  t,
}: {
  data: Snapshot
  request: (command: unknown) => Promise<unknown>
  t: (key: Key) => string
}) {
  const [sessionId, setSession] = useState(''),
    [target, setTarget] = useState(''),
    [report, setReport] = useState<z.infer<typeof modelCheckSchema>>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const revision = useRef(0)
  const sessions = data.sessions.filter(
    (s) =>
      s.activeNodeId === data.nodeId && !s.recoveryRequired && !s.handoffId,
  )
  const selected = sessionId || sessions[0]?.id || '',
    models = data.models ?? [],
    route =
      target ||
      (models[0]
        ? JSON.stringify({
            provider: models[0].provider,
            model: models[0].model,
          })
        : '')
  const invalidate = () => {
    revision.current++
    setReport(undefined)
    setError('')
    setBusy(false)
  }
  return (
    <section className="cm-card">
      <details>
        <summary>{t('modelCheck')}</summary>
        <div className="cm-form">
          <label>
            {t('checkSession')}
            <select
              value={selected}
              onChange={(e) => {
                invalidate()
                setSession(e.target.value)
              }}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title ?? s.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('checkTarget')}
            <select
              value={route}
              onChange={(e) => {
                invalidate()
                setTarget(e.target.value)
              }}
            >
              {models.map((m) => (
                <option
                  key={m.provider + '/' + m.model}
                  value={JSON.stringify({
                    provider: m.provider,
                    model: m.model,
                  })}
                >
                  {m.provider} / {m.name ?? m.model}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={!selected || !route || busy}
            onClick={() => {
              const generation = ++revision.current
              setBusy(true)
              setError('')
              setReport(undefined)
              void request({
                action: 'model-check',
                sessionId: selected,
                ...JSON.parse(route),
              })
                .then((value) => {
                  if (generation === revision.current)
                    setReport(modelCheckSchema.parse(value))
                })
                .catch((e) => {
                  if (generation === revision.current)
                    setError(
                      e instanceof ControlError && e.code in en
                        ? t(e.code as Key)
                        : e instanceof Error
                          ? e.message
                          : String(e),
                    )
                })
                .finally(() => {
                  if (generation === revision.current) setBusy(false)
                })
            }}
          >
            {t('checkModel')}
          </button>
        </div>
        {report && (
          <div role="status">
            <p>
              {report.capacity.conservativeFits
                ? t('capacityFits')
                : report.capacity.estimatedFits
                  ? t('capacityReview')
                  : t('capacityBlocked')}
            </p>
            <dl>
              <dt>{t('capacityEstimate')}</dt>
              <dd>{report.capacity.estimatedTokens}</dd>
              <dt>{t('capacityUpper')}</dt>
              <dd>{report.capacity.byteUpperBound}</dd>
              <dt>{t('capacityOutput')}</dt>
              <dd>{report.capacity.outputReserve}</dd>
              <dt>{t('capacityWindow')}</dt>
              <dd>{report.capacity.contextWindow}</dd>
            </dl>
            <p>{t('capacityExactNotice')}</p>
          </div>
        )}
        {error && (
          <p role="alert" className="cm-error">
            {error}
          </p>
        )}
      </details>
    </section>
  )
}
