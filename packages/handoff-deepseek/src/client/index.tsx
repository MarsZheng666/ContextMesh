import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { en, zh } from './locales.js'
import { UiModel } from './state.js'
import type { ModelRoute } from '../../../protocol/src/model-relay.js'
import { RemotePanel, HandoffDock, SessionDevice } from './view.js'
declare module '@deepseek-ai/cordis' {
  interface Events {
    'model-selection/before-select'(
      sessionId: SessionId,
      previous: ModelRoute | null,
      target: ModelRoute,
    ): true | undefined | Promise<true | undefined>
    'model-selection/after-select'(sessionId: SessionId): void
    'conversation/before-send'(
      sessionId: SessionId,
      signal?: AbortSignal,
    ): true | undefined | Promise<true | undefined>
  }
}
export const inject = ['slots', 'locale', 'layout', 'uiWorkspace']
export function apply(ctx: Context) {
  const model = new UiModel(undefined, (path, signal) =>
    ctx.uiWorkspace.listDirectory(path, signal),
  )
  ctx.on('model-selection/before-select', (id, previous, target) =>
    model.beforeModelSelect(
      id,
      previous,
      target,
      ctx.locale.bind('contextmesh'),
    ),
  )
  ctx.on('model-selection/after-select', (id) => model.finishModelSelect(id))
  ctx.on('conversation/before-send', async (id, signal) => {
    return (await model.readyToSend(id, ctx.locale.bind('contextmesh'), signal))
      ? undefined
      : true
  })
  const open = (id: string) =>
    ctx.uiWorkspace.openSession(brandString<SessionId>(id))
  ctx.effect(
    () => ctx.locale.register('contextmesh', { en, zh }),
    'contextmesh: locale',
  )
  ctx.effect(() => {
    model.start()
    return () => model.close()
  }, 'contextmesh: client state')
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: 'contextmesh',
        locale: 'contextmesh',
        inject: () => ({ model, open }),
      },
      RemotePanel,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'contextmesh',
        order: 25,
        locale: 'contextmesh',
        label: () => ctx.locale.bind('contextmesh')('panel'),
      },
      () => <span className="cm-icon">⇄</span>,
    ),
  )
  for (const name of [
    'sidebar.session.row.leading',
    'sidebar.session.row.hover',
  ] as const) {
    ctx.slots.inject(name, () =>
      ctx.slots.register(
        {
          name,
          id: 'contextmesh-device',
          order: 30,
          locale: 'contextmesh',
          inject: () => ({
            model,
            detail: name === 'sidebar.session.row.hover',
          }),
        },
        SessionDevice,
      ),
    )
  }
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'contextmesh',
        order: 30,
        locale: 'contextmesh',
        inject: (sessionId) => ({ model, sessionId }),
      },
      HandoffDock,
    ),
  )
}
