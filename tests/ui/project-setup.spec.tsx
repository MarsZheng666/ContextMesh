import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import {
  UiModel,
  type Snapshot,
} from '../../packages/handoff-deepseek/src/client/state.js'
import { ProjectSetupForm } from '../../packages/handoff-deepseek/src/client/view.js'
import {
  en,
  zh,
  type Key,
} from '../../packages/handoff-deepseek/src/client/locales.js'
const t = (key: Key) => en[key]
const base: Snapshot = {
  nodeId: 'target',
  name: 'Target',
  nodes: [],
  projects: [{ id: 'project', name: 'Shared' }],
  mappings: [],
  sessions: [
    {
      id: 'session',
      incarnation: 'incarnation',
      title: 'Draft conversation',
      projectId: null,
      activeNodeId: 'source',
      activeNodeName: 'Source',
      handoffId: null,
      handoffState: null,
      recoveryRequired: false,
    },
  ],
  handoffs: [],
  errors: {},
}
afterEach(() => vi.unstubAllGlobals())
function backend() {
  const actions: string[] = [],
    commands: unknown[] = []
  let assigned = false,
    owned = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, options: RequestInit) => {
      const command = JSON.parse(String(options.body))
      actions.push(command.action)
      commands.push(command)
      let value: unknown
      if (command.action === 'status')
        value = {
          ...base,
          mappings: assigned ? [{ projectId: 'project', root: '/target' }] : [],
          sessions: [
            {
              ...base.sessions[0],
              projectId: assigned ? 'project' : null,
              activeNodeId: owned ? 'target' : 'source',
            },
          ],
        }
      else if (command.action === 'configure-project') {
        assigned = true
        value = { projectId: 'project' }
      } else if (command.action === 'takeover') value = { id: 'intent' }
      else if (command.action === 'takeover-status') {
        owned = true
        value = {
          state: 'linked',
          handoffState: 'completed',
          errorCode: null,
          error: null,
        }
      } else value = {}
      return Response.json({ ok: true, value })
    }),
  )
  return { actions, commands }
}
it('opens project setup directly before confirming takeover, and cancellation sends nothing', async () => {
  const { actions } = backend(),
    confirm = vi.fn(() => true),
    model = new UiModel(confirm)
  const send = model.ensureOwned('session', t)
  await vi.waitFor(() =>
    expect(model.getSnapshot().projectSetup?.sessionId).toBe('session'),
  )
  expect(confirm).not.toHaveBeenCalled()
  model.cancelProjectSetup()
  expect(await send).toBe(false)
  expect(actions).toEqual(['status'])
  model.close()
})
it('saves the chosen project and local directory before takeover confirmation', async () => {
  const { actions, commands } = backend(),
    confirm = vi.fn(() => true),
    model = new UiModel(confirm)
  const send = model.ensureOwned('session', t)
  await vi.waitFor(() => expect(model.getSnapshot().projectSetup).toBeDefined())
  await model.saveProjectSetup('project', '/target')
  expect(await send).toBe(true)
  expect(confirm).toHaveBeenCalledOnce()
  expect(commands).toContainEqual({
    action: 'configure-project',
    sessionId: 'session',
    incarnation: 'incarnation',
    expectedSourceNodeId: 'source',
    projectId: 'project',
    root: '/target',
  })
  expect(actions.indexOf('configure-project')).toBeLessThan(
    actions.indexOf('takeover'),
  )
  expect(model.getSnapshot().projectSetup).toBeUndefined()
  model.close()
})
it('cancels an open setup when its original send is aborted', async () => {
  const { actions } = backend(),
    model = new UiModel(() => true),
    controller = new AbortController(),
    send = model.ensureOwned('session', t, controller.signal)
  await vi.waitFor(() => expect(model.getSnapshot().projectSetup).toBeDefined())
  controller.abort()
  expect(await send).toBe(false)
  expect(model.getSnapshot().projectSetup).toBeUndefined()
  expect(actions).toEqual(['status'])
  model.close()
})
for (const locale of [en, zh])
  it(`renders project choice and the destination directory in ${locale.chooseProject}`, () => {
    const html = renderToStaticMarkup(
      <ProjectSetupForm
        data={base}
        setup={{
          sessionId: 'internal-session-id',
          incarnation: 'incarnation',
          title: 'internal-session-id',
          projectId: 'project',
          sourceNodeId: 'source',
          sourceName: 'Source',
        }}
        t={(key) => locale[key as Key]}
        browse={async () => ({
          path: '/target',
          home: '/home',
          crumbs: [],
          entries: [],
          truncated: false,
        })}
        save={async () => {}}
        cancel={() => {}}
      />,
    )
    expect(html).toContain(locale.projectSetupTitle)
    expect(html).not.toContain('internal-session-id')
    expect(html).toContain('Shared')
    expect(html).toContain(locale.directory)
    expect(html).toContain(locale.browseDirectory)
    expect(html).toContain('readonly=""')
    expect(html).toContain(locale.cancelSetup)
    expect(html).toContain(locale.continueSetup)
  })

it('keeps setup open and gives a readable message for an invalid destination directory', async () => {
  backend()
  const original = fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, options: RequestInit) => {
      const command = JSON.parse(String(options.body))
      if (command.action === 'configure-project')
        return Response.json(
          { ok: false, error: { code: 128, message: 'git command failed' } },
          { status: 400 },
        )
      return original(url as RequestInfo, options)
    }),
  )
  const model = new UiModel(() => true),
    send = model.ensureOwned('session', t)
  await vi.waitFor(() => expect(model.getSnapshot().projectSetup).toBeDefined())
  await expect(
    model.saveProjectSetup('project', '/plain'),
  ).rejects.toMatchObject({
    code: 'PROJECT_DIRECTORY_INVALID',
    message: en.PROJECT_DIRECTORY_INVALID,
  })
  expect(model.getSnapshot().projectSetup).toBeDefined()
  model.cancelProjectSetup()
  expect(await send).toBe(false)
  model.close()
})
