import { useState, useEffect, useRef } from 'react'
import { z } from 'zod'
import {
  transferSummarySchema,
  type TransferSummary,
} from '../../../protocol/src/transfers.js'
import { ControlError, type Snapshot } from './state.js'
import { en, type Key } from './locales.js'
export async function confirmFileAction(
  request: (c: unknown) => Promise<unknown>,
  confirm: (message: string) => Promise<boolean>,
  action: 'workspace-export' | 'workspace-apply' | 'workspace-rollback',
  id: string,
  message: string,
  previewId?: string,
) {
  if (!(await confirm(message))) return false
  await request({
    action,
    ...(action === 'workspace-export' ? { planId: id } : { transferId: id }),
    ...(action === 'workspace-apply' ? { previewId } : {}),
    confirmed: true,
  })
  return true
}
function FileSummary({
  value,
  t,
}: {
  value: TransferSummary
  t: (k: Key) => string
}) {
  return (
    <div>
      <p>
        {t('filesSize')}: {value.bytes} B · {t('filesBase')}:{' '}
        <code>{value.baseCommit ?? t('filesNoGit')}</code>
      </p>
      <ul>
        {value.files.map((f) => (
          <li key={f.path}>
            <code>{f.path}</code> ·{' '}
            {t(
              f.action === 'add'
                ? 'fileAdd'
                : f.action === 'delete'
                  ? 'fileDelete'
                  : 'fileChange',
            )}
          </li>
        ))}
        {value.attachments.map((a, i) => (
          <li key={i}>
            {t('fileAttachment')}: {a.name} ({a.bytes} B)
          </li>
        ))}
      </ul>
      {!value.files.length && !value.attachments.length && (
        <p>{t('filesEmpty')}</p>
      )}
    </div>
  )
}
export function FilesPanel({
  data,
  request,
  t,
}: {
  data: Snapshot
  request: (c: unknown) => Promise<unknown>
  t: (k: Key) => string
}) {
  const [session, setSession] = useState(''),
    [target, setTarget] = useState(''),
    [plan, setPlan] = useState<TransferSummary>(),
    [records, setRecords] = useState<TransferSummary[]>([]),
    [preview, setPreview] = useState<
      TransferSummary & {
        root: string
        recoveryRequired: boolean
        previewId?: string
      }
    >(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<{
    message: string
    summary?: TransferSummary
  }>()
  const confirmResolver = useRef<(value: boolean) => void>()
  useEffect(
    () => () => {
      confirmResolver.current?.(false)
    },
    [],
  )
  const confirm = (message: string) =>
    new Promise<boolean>((resolve) => {
      confirmResolver.current = resolve
      setConfirmation({ message, summary: plan ?? preview })
    })
  const finishConfirm = (value: boolean) => {
    confirmResolver.current?.(value)
    confirmResolver.current = undefined
    setConfirmation(undefined)
  }
  const sessions = data.sessions.filter(
      (s) =>
        s.activeNodeId === data.nodeId &&
        s.projectId &&
        !s.handoffId &&
        !s.recoveryRequired,
    ),
    targets = data.nodes.filter((n) => n.online && n.id !== data.nodeId)
  const sessionId = session || sessions[0]?.id || '',
    targetNodeId = target || targets[0]?.id || ''
  async function load() {
    setRecords(
      z
        .array(transferSummarySchema)
        .parse(await request({ action: 'workspace-list' })),
    )
  }
  const run = (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setMessage('')
    void work()
      .catch((e) =>
        setError(
          e instanceof ControlError && e.code in en
            ? t(e.code as Key)
            : e instanceof Error
              ? e.message
              : String(e),
        ),
      )
      .finally(() => setBusy(false))
  }
  return (
    <section className="cm-card">
      {confirmation && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="cm-files-confirm-title"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: '#0007',
            display: 'grid',
            placeItems: 'center',
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              finishConfirm(false)
            }
            if (e.key === 'Tab') {
              const buttons = Array.from(
                e.currentTarget.querySelectorAll('button'),
              )
              const first = buttons[0],
                last = buttons.at(-1)
              if (e.shiftKey && e.target === first) {
                e.preventDefault()
                last?.focus()
              } else if (!e.shiftKey && e.target === last) {
                e.preventDefault()
                first?.focus()
              }
            }
          }}
        >
          <div
            className="cm-card"
            style={{
              background: 'Canvas',
              maxWidth: 640,
              width: 'min(90vw,640px)',
              maxHeight: '80vh',
              overflow: 'auto',
              boxSizing: 'border-box',
            }}
          >
            <h2 id="cm-files-confirm-title">{t('filesConfirmTitle')}</h2>
            <p>{confirmation.message}</p>
            {confirmation.summary && (
              <FileSummary value={confirmation.summary} t={t} />
            )}
            <div className="cm-actions">
              <button autoFocus onClick={() => finishConfirm(false)}>
                {t('filesCancel')}
              </button>
              <button onClick={() => finishConfirm(true)}>
                {t('filesConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
      <details>
        <summary>{t('filesTitle')}</summary>
        <p>{t('filesNotice')}</p>
        <div className="cm-form">
          <label>
            {t('checkSession')}
            <select
              disabled={busy}
              value={sessionId}
              onChange={(e) => {
                setSession(e.target.value)
                setPlan(undefined)
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
            {t('target')}
            <select
              disabled={busy}
              value={targetNodeId}
              onChange={(e) => {
                setTarget(e.target.value)
                setPlan(undefined)
              }}
            >
              {targets.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || !sessionId || !targetNodeId}
            onClick={() =>
              run(async () => {
                setPlan(
                  transferSummarySchema.parse(
                    await request({
                      action: 'workspace-plan',
                      sessionId,
                      targetNodeId,
                    }),
                  ),
                )
                setPreview(undefined)
              })
            }
          >
            {t('filesInspect')}
          </button>
        </div>
        {plan && (
          <div>
            <h3>{t('filesSourcePreview')}</h3>
            <FileSummary value={plan} t={t} />
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (
                    await confirmFileAction(
                      request,
                      confirm,
                      'workspace-export',
                      plan.id,
                      t('filesExportConfirm'),
                    )
                  ) {
                    setPlan(undefined)
                    await load()
                    setMessage(t('filesExported'))
                  }
                })
              }
            >
              {t('filesExport')}
            </button>
          </div>
        )}
        <h3>{t('filesTransfers')}</h3>
        <button disabled={busy} onClick={() => run(load)}>
          {t('refresh')}
        </button>
        {records.map((r) => (
          <div className="cm-session" key={r.id}>
            <div>
              {data.sessions.find((s) => s.id === r.sessionId)?.title ??
                r.sessionId}
              <br />
              {r.ready ? t('filesReady') : t('filesWaiting')} · {r.bytes} B
            </div>
            {r.targetNodeId === data.nodeId ? (
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setPreview(
                      z
                        .object({
                          root: z.string(),
                          recoveryRequired: z.boolean(),
                          previewId: z.string().optional(),
                        })
                        .and(transferSummarySchema)
                        .parse(
                          await request({
                            action: 'workspace-preview',
                            transferId: r.id,
                          }),
                        ),
                    )
                    setPlan(undefined)
                  })
                }
              >
                {t('filesPreview')}
              </button>
            ) : (
              <span>
                {data.nodes.find((n) => n.id === r.targetNodeId)?.name ??
                  r.targetNodeId}
              </span>
            )}
          </div>
        ))}
        {preview && (
          <div>
            <h3>{t('filesTargetPreview')}</h3>
            <p>
              {t('directory')}: <code>{preview.root}</code>
            </p>
            <FileSummary value={preview} t={t} />
            {preview.recoveryRequired ? (
              <p role="alert">{t('filesRecovery')}</p>
            ) : (
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (
                      await confirmFileAction(
                        request,
                        confirm,
                        'workspace-apply',
                        preview.id,
                        t('filesApplyConfirm'),
                        preview.previewId,
                      )
                    ) {
                      setPreview({ ...preview, ready: true })
                      await load()
                      setMessage(t('filesApplied'))
                    }
                  })
                }
              >
                {t('filesApply')}
              </button>
            )}
            {(preview.recoveryRequired || preview.ready) && (
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (
                      await confirmFileAction(
                        request,
                        confirm,
                        'workspace-rollback',
                        preview.id,
                        t('filesRollbackConfirm'),
                      )
                    ) {
                      setPreview(undefined)
                      await load()
                      setMessage(t('filesRolledBack'))
                    }
                  })
                }
              >
                {t('filesRollback')}
              </button>
            )}
          </div>
        )}
        {message && <p role="status">{message}</p>}
        {error && (
          <p role="alert" className="cm-error">
            {error}
          </p>
        )}
      </details>
    </section>
  )
}
