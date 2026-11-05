import { renderToStaticMarkup } from 'react-dom/server'
import { it, expect } from 'vitest'
import { CodexImportPanel } from '../../packages/handoff-deepseek/src/client/view.js'
import { en, zh } from '../../packages/handoff-deepseek/src/client/locales.js'
import {
  snapshotSchema,
  type Snapshot,
} from '../../packages/handoff-deepseek/src/client/state.js'
const data: Snapshot = {
  nodeId: 'A',
  name: 'Laptop',
  nodes: [],
  projects: [],
  mappings: [],
  sessions: [],
  handoffs: [],
  errors: {},
  receiverModel: { provider: 'local-provider', model: 'ds-flash' },
  codexArchives: [
    {
      id: 'codex:ready',
      nextSeq: 2,
      createdAt: 0,
      busy: false,
      recoveryRequired: false,
    },
    {
      id: 'codex:busy',
      nextSeq: 1,
      createdAt: 0,
      busy: true,
      recoveryRequired: false,
    },
    {
      id: 'codex:uncertain',
      nextSeq: 2,
      createdAt: 0,
      busy: false,
      recoveryRequired: true,
    },
  ],
}
for (const locale of [en, zh])
  it(
    'describes copying, uses a host folder picker and disables unsettled sources: ' +
      locale.codexImportTitle,
    () => {
      const html = renderToStaticMarkup(
        <CodexImportPanel
          data={data}
          t={(key) =>
            new Map<string, string>(Object.entries(locale)).get(key) ?? key
          }
          request={async () => ({})}
          refresh={async () => {}}
          open={() => {}}
          browse={async () => {
            throw new Error('not used in static rendering')
          }}
        />,
      )
      expect(html).toContain(locale.codexImportNotice)
      expect(html).toContain(locale.browseDirectory)
      expect(html).toContain('readonly=""')
      expect(html).toContain('local-provider/ds-flash')
      expect(html).toContain('<option value="codex:busy" disabled="">')
      expect(html).toContain('<option value="codex:uncertain" disabled="">')
      expect(html).not.toContain('type="password"')
    },
  )
it('preserves archive availability in client state without loading conversation contents', () => {
  expect(snapshotSchema.parse(data).codexArchives).toEqual(data.codexArchives)
  expect(JSON.stringify(snapshotSchema.parse(data))).not.toContain('portable')
})
