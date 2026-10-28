import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { it, expect, vi } from 'vitest'
const require = createRequire(import.meta.url)
it('registers a native browser module factory and all remote-session UI slots', async () => {
  const source = await readFile(
    'packages/handoff-deepseek/dist/client.js',
    'utf8',
  )
  let moduleId = '',
    face: Record<string, unknown> | undefined
  const dependencies: string[] = []
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load: (entry: {
          id: string
          factory: (resolve: (id: string) => unknown) => Record<string, unknown>
        }) => {
          moduleId = entry.id
          face = entry.factory((id) => {
            dependencies.push(id)
            return require(id)
          })
        },
      },
    },
    AbortController,
    setInterval,
    clearInterval,
    fetch: async () => Response.json({ ok: true, value: {} }),
  })
  expect(moduleId).toBe('dsh-contextmesh-handoff')
  expect([...new Set(dependencies)].sort()).toEqual([
    'react',
    'react/jsx-runtime',
    'zod',
  ])
  expect(source).not.toMatch(
    /(?:^|\n)import |(?:^|\n)export |node:|process\.env/,
  )
  expect(face?.inject).toEqual(['slots', 'locale', 'layout', 'uiWorkspace'])
  if (typeof face?.apply !== 'function')
    throw new Error('browser apply export missing')
  const slots: Array<{ name: string; id?: string; key?: string }> = [],
    cleanups: Array<() => unknown> = []
  const listDirectory = vi.fn(async () => ({
    path: '/host',
    home: '/host',
    crumbs: [],
    entries: [],
    truncated: false,
  }))
  const ctx = {
    on: () => () => {},
    uiWorkspace: {
      openSession: () => {},
      listDirectory,
    },
    locale: { register: () => () => {}, bind: () => () => '' },
    effect: (setup: () => unknown) => {
      const dispose = setup()
      if (typeof dispose === 'function') cleanups.push(() => dispose())
    },
    slots: {
      inject: (_name: string, run: () => unknown) => run(),
      register: (meta: {
        name: string
        id?: string
        key?: string
        inject?: () => unknown
      }) => {
        slots.push(meta)
        if (
          ['sidebar.session.row.leading', 'sidebar.session.row.hover'].includes(
            meta.name,
          )
        ) {
          // Root injections have no Session scope argument; the row identity arrives as owner props.
          expect(meta.inject?.()).toEqual(
            expect.objectContaining({
              model: expect.any(Object),
              detail: meta.name === 'sidebar.session.row.hover',
            }),
          )
        }

        return () => {}
      },
    },
  }
  try {
    Reflect.apply(face.apply, undefined, [ctx])
    // The browser must read the current DSH host through its native UI capability.
    const probe = slots as Array<{
      name: string
      inject?: () => {
        model?: {
          listDirectories: (
            path?: string,
            signal?: AbortSignal,
          ) => Promise<unknown>
        }
      }
    }>
    const model = probe
      .find((s) => s.name === 'sidebar.session.row.leading')
      ?.inject?.().model
    const signal = new AbortController().signal
    expect(
      await model?.listDirectories('/server/project', signal),
    ).toMatchObject({ path: '/host' })
    expect(listDirectory).toHaveBeenCalledWith('/server/project', signal)
    expect(slots.map((s) => [s.name, s.id ?? s.key])).toEqual([
      ['main', 'contextmesh'],
      ['sidebar.panellist', 'contextmesh'],
      ['sidebar.session.row.leading', 'contextmesh-device'],
      ['sidebar.session.row.hover', 'contextmesh-device'],
      ['conversation.input.dock', 'contextmesh'],
    ])
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup()
  }
})
