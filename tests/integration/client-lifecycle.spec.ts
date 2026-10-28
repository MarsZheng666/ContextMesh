import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('revives the same browser session and projections after a round-trip handoff', async () => {
  const source = await readFile(
    'node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js',
    'utf8',
  )
  type Session = {
    getSnapshot(): { removed: boolean }
    resync(): Promise<void>
    projections: { values(): { title?: string } }
  }
  type Manager = {
    getListSnapshot(): { items: { sessionId: string; title?: string }[] }
    get(id: string): Session
    handleSessionAdded(summary: object): void
    handleSessionRemoved(id: string): void
    projectionStore(id: string): Session['projections']
  }
  let ManagerClass: new (remote: object) => Manager
  runInNewContext(
    source.replace(
      'exports.apply = apply;',
      'exports.SessionManager = SessionManager; exports.apply = apply;',
    ),
    {
      window: {
        __ModuleLoader__: {
          load: (entry: {
            factory: (require: (id: string) => unknown) => {
              SessionManager: typeof ManagerClass
            }
          }) => {
            ManagerClass = entry.factory((id) => {
              if (id === '@deepseek-ai/dsh-api-gateway/client')
                return { RemoteJournalStream: class {} }
              if (id === '@deepseek-ai/dsh-client-store')
                return {
                  notifySubscribers: (listeners: Set<() => void>) => {
                    for (const listener of listeners) listener()
                  },
                }
              return {}
            }).SessionManager
          },
        },
      },
      queueMicrotask,
      AbortController,
      console,
    },
  )
  const manager = new ManagerClass!({})
  const summary = {
    sessionId: 'round-trip-session',
    cwd: '/project',
    running: false,
    blank: false,
    agentAvailable: true,
    projections: {
      kind: 'sequenced',
      asOfSeq: 5,
      values: { title: 'Before handoff' },
    },
  }
  manager.handleSessionAdded(summary)
  const session = manager.get(summary.sessionId)
  const resync = vi.spyOn(session, 'resync').mockResolvedValue()
  manager.handleSessionRemoved(summary.sessionId)
  expect(session.getSnapshot().removed).toBe(true)
  manager.handleSessionAdded({
    ...summary,
    agentAvailable: false,
    running: false,
  })
  expect(manager.getListSnapshot().items).toContainEqual(
    expect.objectContaining({
      sessionId: summary.sessionId,
      title: 'Before handoff',
    }),
  )
  expect(session.getSnapshot().removed).toBe(false)
  expect(resync).toHaveBeenCalledTimes(1)

  manager.handleSessionAdded({
    ...summary,
    projections: {
      kind: 'sequenced',
      asOfSeq: 12,
      values: { title: 'Returned from server' },
    },
  })
  expect(manager.get(summary.sessionId)).toBe(session)
  expect(session.getSnapshot().removed).toBe(false)
  expect(manager.projectionStore(summary.sessionId)).toBe(session.projections)
  expect(session.projections.values().title).toBe('Returned from server')
  expect(resync).toHaveBeenCalledTimes(2)
  manager.handleSessionAdded(summary)
  expect(resync).toHaveBeenCalledTimes(2)
  expect(session.projections.values().title).toBe('Returned from server')
})
