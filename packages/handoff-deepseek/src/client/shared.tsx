import { useEffect, useState } from 'react'
import { z } from 'zod'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { sharedInfo, sharedEvent } from '../../../protocol/src/shared.js'

const status = z.object({
  shares: z.array(sharedInfo),
  following: z.array(
    z.object({
      share: sharedInfo,
      cursor: z.number(),
      records: z.array(sharedEvent),
      error: z.string(),
    }),
  ),
})
export function SharedConversations({
  request,
  t,
  continueHere,
}: {
  request: (value: unknown) => Promise<unknown>
  continueHere: (id: string) => Promise<void>
} & PropsLocale<'contextmesh'>) {
  const [data, setData] = useState<z.infer<typeof status>>()
  const [id, setId] = useState('')
  const [error, setError] = useState('')
  const [count, setCount] = useState(100)
  const [content, setContent] = useState<{
    seq: number
    text: string
    next: number | null
  }>()
  useEffect(() => {
    let closed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const result = status.parse(await request({ action: 'shared-status' }))
        if (!closed) {
          setData(result)
          setError('')
        }
      } catch (e) {
        if (!closed) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!closed) timer = setTimeout(() => void refresh(), 1000)
      }
    }
    void refresh()
    return () => {
      closed = true
      clearTimeout(timer)
    }
  }, [request])
  const selected = id || data?.shares[0]?.id || ''
  const followed = data?.following.find((value) => value.share.id === selected)
  const read = async (seq: number, offset = 0) => {
    try {
      const page = z
        .object({ text: z.string(), next: z.number().nullable() })
        .parse(
          await request({
            action: 'shared-content',
            id: selected,
            seq,
            offset,
          }),
        )
      setContent((previous) => ({
        seq,
        text:
          offset && previous?.seq === seq
            ? previous.text + page.text
            : page.text,
        next: page.next,
      }))
    } catch (e) {
      setError(String(e))
    }
  }
  return (
    <section className="cm-card">
      <h2>{t('liveShared')}</h2>
      <p>{t('liveHelp')}</p>
      {error && (
        <p role="status">
          {t('liveOffline')} {error}
        </p>
      )}
      <select
        aria-label={t('liveShared')}
        value={selected}
        onChange={(event) => {
          setId(event.target.value)
          setContent(undefined)
          setCount(100)
        }}
      >
        {!data?.shares.length && <option value="">{t('liveEmpty')}</option>}
        {data?.shares.map((value) => (
          <option key={value.id} value={value.id}>
            {value.title}
          </option>
        ))}
      </select>
      {selected && !followed && (
        <button
          onClick={() =>
            void request({ action: 'shared-follow', id: selected }).catch((e) =>
              setError(String(e)),
            )
          }
        >
          {t('liveFollow')}
        </button>
      )}
      {followed && (
        <>
          <p role="status">
            {t(followed.error ? 'liveOffline' : 'liveFollowing')}
          </p>
          <button
            onClick={() =>
              void continueHere(selected).catch((e) => setError(String(e)))
            }
          >
            {t('liveContinue')}
          </button>
          {followed.records.length > count && (
            <button onClick={() => setCount(count + 100)}>
              {t('liveMore')}
            </button>
          )}
          {followed.records.slice(-count).map((record) => (
            <article key={record.key} className="cm-history">
              <strong>
                {t(
                  record.role === 'user'
                    ? 'liveUser'
                    : record.role === 'assistant'
                      ? 'liveAssistant'
                      : 'liveReference',
                )}{' '}
                {record.status === 'running'
                  ? t('liveRunning')
                  : record.status === 'completed'
                    ? t('liveCompleted')
                    : record.status === 'failed'
                      ? t('liveFailed')
                      : record.status === 'declined'
                        ? t('liveDeclined')
                        : ''}
              </strong>
              <pre>{record.preview}</pre>
              <button onClick={() => void read(record.seq)}>
                {t('liveOpen')}
              </button>
            </article>
          ))}
          {content && (
            <section className="cm-history">
              <pre>{content.text}</pre>
              {content.next !== null && (
                <button onClick={() => void read(content.seq, content.next!)}>
                  {t('liveMore')}
                </button>
              )}
            </section>
          )}
        </>
      )}
    </section>
  )
}
