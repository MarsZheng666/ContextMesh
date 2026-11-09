import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ArchiveEntry,
  ArchiveResumeOptions,
} from '../../../protocol/src/archives.js'
import { errorText } from './state.js'

type Picked = NonNullable<ArchiveResumeOptions['include']>[number]
type Page = {
  records: ArchiveEntry[]
  next: number | null
  parent?: string
  title: string
}

export function archiveSize(bytes: number) {
  return bytes >= 1024 ** 2
    ? (bytes / 1024 ** 2).toFixed(1) + ' MiB'
    : (bytes / 1024).toFixed(1) + ' KiB'
}

export function ArchiveHistory({
  source,
  request,
  t,
  close,
  pick,
}: PropsLocale<'contextmesh'> & {
  source: string
  request: (command: unknown) => Promise<unknown>
  close: () => void
  pick: (selection: Picked) => void
}) {
  const [id, setId] = useState(source)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<Page>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [body, setBody] = useState<{
    seq: number
    offset: number
    text: string
    next: number | null
  }>()
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (error) {
      setError(errorText(error, t))
    } finally {
      setBusy(false)
    }
  }
  const load = (archive = id, more = false) =>
    run(async () => {
      const result = (await request({
        action: 'archive-index',
        id: archive,
        query,
        after: more ? (page?.next ?? undefined) : undefined,
      })) as Page
      if (!more) setBody(undefined)
      setId(archive)
      setPage(
        more && page
          ? { ...result, records: [...page.records, ...result.records] }
          : result,
      )
    })
  useEffect(() => {
    void load(source)
  }, [source])
  const read = (seq: number, offset: number) =>
    run(async () => {
      const result = (await request({
        action: 'archive-content',
        id,
        seq,
        offset,
        length: 4096,
      })) as { text: string; next: number | null }
      setBody({ seq, offset, ...result })
    })
  return (
    <section className="cm-card">
      <h3>{page?.title ?? t('archiveBrowse')}</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void load()
        }}
      >
        <label>
          {t('archiveSearch')}{' '}
          <input
            value={query}
            maxLength={512}
            disabled={busy}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button disabled={busy}>{t('archiveSearch')}</button>
      </form>
      {page && !page.records.length && <p>{t('archiveEmpty')}</p>}
      {page?.records.map((record) => (
        <article key={record.seq}>
          <p>
            {record.seq} · {record.kind} · {archiveSize(record.bytes)}
          </p>
          <p>{record.preview}</p>
          <button disabled={busy} onClick={() => void read(record.seq, 0)}>
            {t('archiveRead')}
          </button>
          {record.anchors.slice(-4).map((anchor) => (
            <button
              key={anchor.offset}
              disabled={busy}
              onClick={() => void read(record.seq, anchor.offset)}
            >
              {t('archiveLine')} {anchor.line}
            </button>
          ))}
        </article>
      ))}
      {page?.next != null && (
        <button disabled={busy} onClick={() => void load(id, true)}>
          {t('archiveMore')}
        </button>
      )}
      {page?.parent && (
        <button disabled={busy} onClick={() => void load(page.parent)}>
          {t('archiveEarlier')}
        </button>
      )}
      {body && (
        <div>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              maxHeight: '20em',
              overflow: 'auto',
            }}
          >
            {body.text}
          </pre>
          {body.next != null && (
            <button
              disabled={busy}
              onClick={() => void read(body.seq, body.next!)}
            >
              {t('archiveNext')}
            </button>
          )}
          <button
            disabled={busy}
            onClick={() =>
              pick({ id, seq: body.seq, offset: body.offset, length: 4096 })
            }
          >
            {t('archiveInclude')}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <button onClick={close}>{t('archiveClose')}</button>
    </section>
  )
}
