import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { UiModel } from '../../packages/handoff-deepseek/src/client/state.js'
import {
  HandoffDock,
  RemotePanelView,
  SessionDeviceView,
} from '../../packages/handoff-deepseek/src/client/view.js'
import { en, zh } from '../../packages/handoff-deepseek/src/client/locales.js'
import type { Snapshot } from '../../packages/handoff-deepseek/src/client/state.js'
const snapshot: Snapshot = {
  nodeId: 'A',
  name: 'My laptop',
  nodes: [
    { id: 'A', name: 'My laptop', online: true },
    { id: 'B', name: 'Server', online: true },
    { id: 'C', name: 'Offline device', online: false },
  ],
  projects: [{ id: 'project', name: 'Shared project' }],
  mappings: [{ projectId: 'project', root: '/workspace' }],
  sessions: [
    {
      id: 'session',
      incarnation: 'incarnation',
      title: 'Continuity example',
      projectId: 'project',
      activeNodeId: 'A',
      activeNodeName: 'My laptop',
      handoffId: null,
      handoffState: null,
      recoveryRequired: false,
    },
  ],
  handoffs: [],
  errors: {},
}
for (const [language, locale] of [
  ['English', en],
  ['Chinese', zh],
] as const)
  it(`renders project, ownership, target and history controls in ${language}`, () => {
    const html = renderToStaticMarkup(
      <RemotePanelView
        data={snapshot}
        t={(key) =>
          new Map<string, string>(Object.entries(locale)).get(key) ?? key
        }
        request={async () => null}
        refresh={async () => {}}
        open={() => {}}
      />,
    )
    for (const text of [
      locale.panel,
      locale.history,
      locale.handoff,
      'Shared project',
      'Continuity example',
      'My laptop',
      'Server',
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('Offline device')
    expect(html).not.toContain('CONTEXTMESH_TOKEN')
  })
it('shows manual recovery and does not offer resume for an uncertain owner', () => {
  const data = structuredClone(snapshot)
  Object.assign(data.sessions[0]!, {
    activeNodeId: null,
    recoveryRequired: true,
    handoffId: 'h',
    handoffState: 'recovery_required',
  })
  data.handoffs = [
    {
      id: 'h',
      sessionId: 'session',
      sourceNodeId: 'A',
      targetNodeId: 'B',
      state: 'recovery_required',
      error: 'Close could not be confirmed',
    },
  ]
  const html = renderToStaticMarkup(
    <RemotePanelView
      data={data}
      t={(key) => new Map<string, string>(Object.entries(en)).get(key) ?? key}
      request={async () => null}
      refresh={async () => {}}
      open={() => {}}
    />,
  )
  expect(html).toContain(en.recover)
  expect(html).toContain('Close could not be confirmed')
  expect(html).not.toContain(`>${en.resume}</button>`)
})

for (const [language, locale] of [
  ['English', en],
  ['Chinese', zh],
] as const)
  it(`shows the owning device on a remote sidebar row in ${language}`, () => {
    const data = structuredClone(snapshot)
    Object.assign(data.sessions[0]!, {
      activeNodeId: 'B',
      activeNodeName: 'Server',
    })
    const t = (key: string) =>
      new Map<string, string>(Object.entries(locale)).get(key) ?? key
    const icon = renderToStaticMarkup(
      <SessionDeviceView data={data} sessionId="session" t={t} />,
    )
    const hover = renderToStaticMarkup(
      <SessionDeviceView data={data} sessionId="session" t={t} detail />,
    )
    expect(icon).toContain(`aria-label="${locale.remote}: Server"`)
    expect(hover).toContain(`${locale.remote}: Server`)
    expect(
      renderToStaticMarkup(
        <SessionDeviceView data={snapshot} sessionId="session" t={t} />,
      ),
    ).toBe('')
  })

for (const owner of ['A', 'B'])
  it(`keeps only device handoff controls in the dock for owner ${owner}`, async () => {
    const data = structuredClone(snapshot)
    data.sessions[0]!.activeNodeId = owner
    data.models = [{ provider: 'local', model: 'local-model' }]
    data.nodes[1]!.models = [{ provider: 'remote', model: 'remote-model' }]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, value: data })),
    )
    const model = new UiModel(() => true)
    try {
      await model.refresh()
      const html = renderToStaticMarkup(
        <HandoffDock
          model={model}
          sessionId="session"
          t={(key) =>
            new Map<string, string>(Object.entries(en)).get(key) ?? key
          }
        />,
      )
      expect(html).not.toContain('Continue with model')
      expect(html).not.toContain('local-model')
      expect(html).not.toContain('remote-model')
      expect(html).toContain(owner === 'A' ? en.handoff : en.takeover)
    } finally {
      model.close()
      vi.unstubAllGlobals()
    }
  })
