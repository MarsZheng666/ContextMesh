import { DeviceSetup } from './devices.js'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ControlError,
  historySchema,
  type History,
  type Snapshot,
  type UiModel,
  type ProjectSetup,
} from './state.js'
import { en, type Key } from './locales.js'
import {
  DirectoryBrowserModel,
  type ListDirectory,
  type DirectoryState,
} from './directory.js'
type Locale = PropsLocale<'contextmesh'>
type Actions = {
  request: (command: unknown) => Promise<unknown>
  refresh: () => Promise<void>
  open: (id: string) => void
  takeover?: (id: string) => Promise<boolean>
}
const stateKeys = new Set<Key>([
  'requested',
  'preparing',
  'ready',
  'activating',
  'completed',
  'cancelled',
  'failed',
  'recovery_required',
])
function errorText(error: unknown, t: Locale['t']) {
  if (error instanceof ControlError && error.code in en)
    return t(error.code as Key)
  return error instanceof Error ? error.message : String(error)
}
function stateLabel(state: string, t: Locale['t']) {
  return stateKeys.has(state as Key) ? t(state as Key) : state
}
const style = `.cm-panel{padding:24px;max-width:1120px;margin:auto;height:100%;overflow:auto;color:inherit;font:inherit;box-sizing:border-box}.cm-panel h1{font-size:25px;margin:0 0 8px}.cm-muted{opacity:.7;font-size:13px}.cm-toolbar,.cm-actions,.cm-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.cm-panel button,.cm-panel select,.cm-panel input,.cm-dock button,.cm-dock select{font:inherit;padding:7px 10px;border:1px solid #8886;border-radius:7px;color:inherit;background:transparent}.cm-panel input{min-width:180px}.cm-panel button:disabled,.cm-dock button:disabled{opacity:.4;cursor:default}.cm-panel button,.cm-dock button{cursor:pointer}.cm-card{border:1px solid #8884;border-radius:12px;padding:16px;margin:14px 0}.cm-card h2{font-size:17px;margin:0 0 12px}.cm-session{padding:13px 0;border-top:1px solid #8883;display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap}.cm-session strong{display:block;max-width:560px;overflow-wrap:anywhere}.cm-error{color:#d65c5c;white-space:pre-wrap;overflow-wrap:anywhere}.cm-history{position:relative;border:1px solid #8886;border-radius:12px;padding:16px;margin-top:14px}.cm-history pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;max-height:450px;overflow:auto}.cm-form{display:grid;gap:12px;padding-top:14px}.cm-form label{display:grid;gap:6px}.cm-dock{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 0;font-size:12px}.cm-badge{font-size:12px;opacity:.75}.cm-notice{border-left:3px solid #6479dc;padding:8px 12px;margin:12px 0}.cm-panel code{overflow-wrap:anywhere}.cm-icon{font-size:20px}`

export function DirectoryBrowserView({
  state,
  device,
  path,
  setPath,
  hidden,
  setHidden,
  navigate,
  pick,
  cancel,
  t,
}: {
  state: DirectoryState
  device: string
  path: string
  setPath: (path: string) => void
  hidden: boolean
  setHidden: (hidden: boolean) => void
  navigate: (path?: string) => void
  pick: (path: string) => void
  cancel: () => void
} & Locale) {
  const listing = state.listing
  const entries =
    listing?.entries.filter((entry) => hidden || !entry.hidden) ?? []
  return (
    <div className="cm-form cm-directory-browser">
      <h2 id="cm-directory-title">{t('selectDirectory')}</h2>
      <p className="cm-muted">
        {t('directoryDevice')}: {device}
      </p>
      <nav className="cm-actions" aria-label={t('directoryNavigation')}>
        <button type="button" onClick={() => navigate()}>
          {t('directoryHome')}
        </button>
        {listing?.crumbs.map((crumb) => (
          <button
            type="button"
            key={crumb.path}
            title={crumb.path}
            onClick={() => navigate(crumb.path)}
          >
            {crumb.name || crumb.path}
          </button>
        ))}
      </nav>
      <form
        className="cm-directory-path"
        onSubmit={(event) => {
          event.preventDefault()
          if (path.trim()) navigate(path.trim())
        }}
      >
        <input
          aria-label={t('directoryPath')}
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <button type="submit" disabled={!path.trim()}>
          {t('directoryGo')}
        </button>
      </form>
      <div className="cm-directory-list" aria-busy={state.loading}>
        {state.loading ? (
          <p role="status">{t('directoryLoading')}</p>
        ) : state.failed ? (
          <p className="cm-error" role="alert">
            {t('DIRECTORY_BROWSE_FAILED')}
          </p>
        ) : entries.length ? (
          entries.map((entry) => (
            <button
              type="button"
              className="cm-directory-entry"
              key={entry.path}
              title={entry.path}
              onClick={() => navigate(entry.path)}
            >
              <span aria-hidden="true">📁</span> {entry.name}
            </button>
          ))
        ) : (
          <p>{t('directoryEmpty')}</p>
        )}
      </div>
      {listing?.truncated && (
        <p className="cm-muted">{t('directoryTruncated')}</p>
      )}
      <label className="cm-directory-hidden">
        <input
          type="checkbox"
          checked={hidden}
          onChange={(event) => setHidden(event.target.checked)}
        />
        {t('directoryHidden')}
      </label>
      <div className="cm-actions">
        <button type="button" onClick={cancel}>
          {t('cancelSetup')}
        </button>
        <button
          type="button"
          disabled={
            state.loading || state.failed || !listing || path !== listing.path
          }
          onClick={() => listing && pick(listing.path)}
        >
          {t('useDirectory')}
        </button>
      </div>
    </div>
  )
}
function DirectoryBrowser({
  browse,
  initialPath,
  device,
  pick,
  cancel,
  t,
}: {
  browse: ListDirectory
  initialPath?: string
  device: string
  pick: (path: string) => void
  cancel: () => void
} & Locale) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [browser] = useState(() => new DirectoryBrowserModel(browse))
  const [path, setPath] = useState(initialPath ?? ''),
    [hidden, setHidden] = useState(false)
  const state = useSyncExternalStore(
    browser.subscribe,
    browser.getSnapshot,
    browser.getSnapshot,
  )
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
    void browser.start(initialPath)
    return () => {
      browser.close()
      if (element?.open) element.close()
    }
  }, [browser, initialPath])
  useEffect(() => {
    if (state.listing && !state.failed) setPath(state.listing.path)
  }, [state.listing, state.failed])
  return (
    <dialog
      ref={dialog}
      className="cm-project-dialog"
      aria-labelledby="cm-directory-title"
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        cancel()
      }}
    >
      <DirectoryBrowserView
        state={state}
        device={device}
        path={path}
        setPath={setPath}
        hidden={hidden}
        setHidden={setHidden}
        navigate={(path) => void browser.navigate(path)}
        pick={pick}
        cancel={cancel}
        t={t}
      />
    </dialog>
  )
}
export function ProjectSetupForm({
  data,
  setup,
  t,
  save,
  cancel,
  browse,
}: {
  data: Snapshot
  setup: ProjectSetup
  save: (id: string, root?: string, name?: string) => Promise<void>
  cancel: () => void
  browse: ListDirectory
} & Locale) {
  const [project, setProject] = useState(setup.projectId ?? ''),
    [name, setName] = useState(''),
    [root, setRoot] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [browsing, setBrowsing] = useState(false)
  const createdId = useRef<string>()
  const creating = project === '__new__'
  const mapping = data.mappings.find((m) => m.projectId === project)
  const local = setup.sourceNodeId === data.nodeId
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      if (creating) createdId.current ??= crypto.randomUUID()
      await save(
        creating ? createdId.current! : project,
        mapping ? undefined : root.trim() || undefined,
        creating ? name.trim() : undefined,
      )
    } catch (error) {
      setError(errorText(error, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {browsing && (
        <DirectoryBrowser
          browse={browse}
          initialPath={root || undefined}
          device={data.name}
          pick={(path) => {
            setRoot(path)
            setBrowsing(false)
          }}
          cancel={() => setBrowsing(false)}
          t={t}
        />
      )}
      <form
        className="cm-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <h2 id="cm-project-title">{t('projectSetupTitle')}</h2>
        <p>{t('projectSetupHelp')}</p>
        <strong>
          {setup.title === setup.sessionId ? t('conversation') : setup.title}
        </strong>
        <p className="cm-muted">
          {t('projectSetupSource')}: {setup.sourceName}
        </p>
        <label>
          {t('project')}
          <select
            autoFocus
            required
            disabled={busy || Boolean(setup.projectId)}
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">{t('projectPlaceholder')}</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {!setup.projectId && (
              <option value="__new__">{t('newProject')}</option>
            )}
          </select>
        </label>
        {creating && (
          <label>
            {t('projectName')}
            <input
              required
              maxLength={100}
              disabled={busy}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        {project && (
          <label>
            {t('directory')}
            {mapping ? (
              <code>{mapping.root}</code>
            ) : (
              <span className="cm-directory-control">
                <input
                  readOnly
                  aria-label={t('directory')}
                  value={root}
                  placeholder={t('directoryNotSelected')}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setBrowsing(true)}
                >
                  {root ? t('changeDirectory') : t('browseDirectory')}
                </button>
              </span>
            )}
          </label>
        )}
        <p className="cm-muted">
          {local ? t('localDirectoryHelp') : t('directoryHelp')}
        </p>
        {!local && <p className="cm-muted">{t('sourceDirectoryHelp')}</p>}
        {error && (
          <p role="alert" className="cm-error">
            {error}
          </p>
        )}
        <div className="cm-actions">
          <button type="button" onClick={cancel}>
            {t('cancelSetup')}
          </button>
          <button
            type="submit"
            disabled={
              busy ||
              !project ||
              (creating && !name.trim()) ||
              (!mapping && !local && !root.trim())
            }
          >
            {busy ? t('busy') : t('continueSetup')}
          </button>
        </div>
      </form>
    </>
  )
}
function ProjectSetupDialog({
  model,
  data,
  setup,
  t,
}: { model: UiModel; data?: Snapshot; setup?: ProjectSetup } & Locale) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (setup && !dialog.current?.open) dialog.current?.showModal()
  }, [setup])
  if (!setup || !data) return null
  return (
    <dialog
      ref={dialog}
      className="cm-project-dialog"
      aria-labelledby="cm-project-title"
      onCancel={(event) => {
        event.preventDefault()
        model.cancelProjectSetup()
      }}
    >
      <style>
        {style +
          `.cm-project-dialog{width:min(520px,calc(100vw - 48px));max-height:85vh;overflow:auto;border:1px solid #8886;border-radius:14px;padding:24px;background:var(--background-color,#202020);color:inherit;font:inherit}.cm-project-dialog::backdrop{background:#0009}.cm-project-dialog h2,.cm-project-dialog p{margin:0}.cm-project-dialog button,.cm-project-dialog input,.cm-project-dialog select{font:inherit;color:inherit;background:transparent;border:1px solid #8886;border-radius:7px;padding:9px}.cm-project-dialog select option{background:#202020}.cm-project-dialog button{cursor:pointer}.cm-project-dialog button:disabled{opacity:.5}.cm-project-dialog .cm-actions{justify-content:flex-end;margin-top:8px}.cm-directory-control{display:flex;gap:8px}.cm-directory-control input{min-width:0;flex:1}.cm-directory-path{display:flex;gap:8px}.cm-directory-path input{min-width:0;flex:1}.cm-directory-browser nav.cm-actions{justify-content:flex-start;gap:4px}.cm-directory-list{height:240px;overflow:auto;border:1px solid #8885;border-radius:8px;padding:6px}.cm-directory-entry{display:block;width:100%;border:0!important;text-align:left;padding:9px!important}.cm-directory-entry:hover{background:#8882}.cm-directory-hidden{display:flex!important;align-items:center;gap:8px}.cm-directory-browser{padding:0}`}
      </style>
      <ProjectSetupForm
        key={setup.sessionId}
        data={data}
        setup={setup}
        t={t}
        save={(...args) => model.saveProjectSetup(...args)}
        cancel={() => model.cancelProjectSetup()}
        browse={model.listDirectories}
      />
    </dialog>
  )
}
function text(data: unknown) {
  if (!data || typeof data !== 'object') return String(data ?? '')
  const record = Object.fromEntries(Object.entries(data))
  const content =
    record.message && typeof record.message === 'object'
      ? Object.fromEntries(Object.entries(record.message)).content
      : record.content
  if (Array.isArray(content))
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String(part.text)
          : '',
      )
      .filter(Boolean)
      .join('\n')
  return JSON.stringify(data, null, 2)
}
export function RemotePanelView({
  data,
  error,
  request,
  refresh,
  open,
  takeover,
  t,
}: Actions & Locale & { data?: Snapshot; error?: Error }) {
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(''),
    [notice, setNotice] = useState('')
  const [project, setProject] = useState(''),
    [root, setRoot] = useState(''),
    [name, setName] = useState(''),
    [target, setTarget] = useState('')
  const [history, setHistory] = useState<
    { id: string; value: History } | undefined
  >()
  const run = async (operation: () => Promise<unknown>, success = '') => {
    setBusy(true)
    setFailure('')
    setNotice('')
    try {
      await operation()
      setNotice(success)
      await refresh()
    } catch (error) {
      setFailure(errorText(error, t))
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  const load = async (id: string, offset?: number) => {
    const result = historySchema.parse(
      await request({
        action: 'history',
        sessionId: id,
        ...(offset === undefined ? {} : { offset }),
      }),
    )
    setHistory((previous) => ({
      id,
      value:
        previous &&
        previous.id === id &&
        previous.value.incarnation === result.incarnation &&
        offset !== undefined
          ? { ...result, events: [...result.events, ...previous.value.events] }
          : result,
    }))
  }
  if (!data)
    return (
      <div className="cm-panel">
        <style>{style}</style>
        <p>{error ? errorText(error, t) : t('loading')}</p>
      </div>
    )
  const selectedProject = project || data.projects[0]?.id || ''
  const targets = data.nodes.filter(
    (node) => node.online && node.id !== data.nodeId,
  )
  const selectedTarget = target || targets[0]?.id || ''
  const groups = [...new Set(data.sessions.map((session) => session.projectId))]
  return (
    <div className="cm-panel">
      <style>{style}</style>
      <div className="cm-toolbar">
        <h1>{t('panel')}</h1>
        <button disabled={busy} onClick={() => void run(refresh)}>
          {t('refresh')}
        </button>
      </div>
      <div className="cm-muted">
        {t('device')}: {data.name}
      </div>
      <DeviceSetup connection={data.connection} request={request} t={t} />
      <p className="cm-notice">{t('prepare')}</p>
      {(failure || error) && (
        <p className="cm-error" role="alert">
          {failure || errorText(error, t)}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <section className="cm-card">
        <details open={!data.mappings.length}>
          <summary>{t('setup')}</summary>
          <div className="cm-form">
            <div className="cm-row">
              <input
                aria-label={t('projectName')}
                placeholder={t('projectName')}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <button
                disabled={busy || !name.trim()}
                onClick={() =>
                  void run(
                    () => request({ action: 'project', name: name.trim() }),
                    t('projectCreated'),
                  )
                }
              >
                {t('create')}
              </button>
            </div>
            <label>
              {t('project')}
              <select
                value={selectedProject}
                onChange={(event) => setProject(event.target.value)}
              >
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('directory')}
              <input
                value={root}
                onChange={(event) => setRoot(event.target.value)}
                placeholder={
                  data.mappings.find((m) => m.projectId === selectedProject)
                    ?.root ?? ''
                }
              />
            </label>
            <button
              disabled={busy || !selectedProject || !root.trim()}
              onClick={() =>
                void run(
                  () =>
                    request({
                      action: 'mapping',
                      projectId: selectedProject,
                      root: root.trim(),
                    }),
                  t('mappingSaved'),
                )
              }
            >
              {t('map')}
            </button>
            {data.mappings.map((m) => (
              <div className="cm-muted" key={m.projectId}>
                {data.projects.find((p) => p.id === m.projectId)?.name}:{' '}
                <code>{m.root}</code>
              </div>
            ))}
          </div>
        </details>
      </section>
      <div className="cm-row">
        <label>
          {t('target')}{' '}
          <select
            value={selectedTarget}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">{t('choose')}</option>
            {targets.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!data.sessions.length && <p>{t('empty')}</p>}
      {groups.map((group) => (
        <section className="cm-card" key={group ?? 'unassigned'}>
          <h2>
            {data.projects.find((p) => p.id === group)?.name ?? t('unknown')}
          </h2>
          {!data.mappings.some((m) => m.projectId === group) && (
            <p className="cm-muted">{t('unmapped')}</p>
          )}
          {data.sessions
            .filter((s) => s.projectId === group)
            .map((session) => {
              const local = session.activeNodeId === data.nodeId
              const last = data.handoffs.find((h) => h.sessionId === session.id)
              return (
                <div className="cm-session" key={session.id}>
                  <div>
                    <strong>{session.title || session.id.slice(0, 8)}</strong>
                    <span className="cm-badge">
                      {session.activeNodeName ?? '—'}
                      {session.handoffState
                        ? ` · ${stateLabel(session.handoffState, t)}`
                        : ''}
                    </span>
                    {session.recoveryRequired && (
                      <p className="cm-error">{t('recover')}</p>
                    )}
                    {last?.error && <p className="cm-error">{last.error}</p>}
                  </div>
                  <div className="cm-actions">
                    <button
                      disabled={busy}
                      onClick={() => void run(() => load(session.id))}
                    >
                      {t('history')}
                    </button>
                    {!local &&
                      session.activeNodeId &&
                      !session.handoffId &&
                      takeover && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              if (await takeover(session.id)) open(session.id)
                            })
                          }
                        >
                          {t('takeover')}
                        </button>
                      )}
                    {local && (
                      <button disabled={busy} onClick={() => open(session.id)}>
                        {t('open')}
                      </button>
                    )}
                    {local && (
                      <button
                        disabled={
                          busy || !selectedTarget || !!session.handoffId
                        }
                        onClick={() =>
                          void run(
                            () =>
                              request({
                                action: 'handoff',
                                sessionId: session.id,
                                targetNodeId: selectedTarget,
                              }),
                            t('handoffStarted'),
                          )
                        }
                      >
                        {t('handoff')}
                      </button>
                    )}
                    {!session.activeNodeId &&
                      !session.handoffId &&
                      last &&
                      ((last.targetNodeId === data.nodeId &&
                        last.state === 'completed') ||
                        ['failed', 'cancelled'].includes(last.state)) && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await request({
                                action: 'resume',
                                sessionId: session.id,
                              })
                              open(session.id)
                            })
                          }
                        >
                          {t('resume')}
                        </button>
                      )}
                    {last?.sourceNodeId === data.nodeId &&
                      ['requested', 'preparing', 'ready'].includes(
                        last.state,
                      ) && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              request({ action: 'cancel', handoffId: last.id }),
                            )
                          }
                        >
                          {t('cancel')}
                        </button>
                      )}
                  </div>
                </div>
              )
            })}
        </section>
      ))}
      {history && (
        <section className="cm-history">
          <div className="cm-toolbar">
            <h2>{t('readonly')}</h2>
            <button onClick={() => setHistory(undefined)}>{t('close')}</button>
            {history.value.from > 0 && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    load(history.id, Math.max(0, history.value.from - 200)),
                  )
                }
              >
                {t('older')}
              </button>
            )}
          </div>
          {history.value.events
            .filter((event) =>
              ['user/message', 'assistant/message', 'tool/result'].includes(
                event.type,
              ),
            )
            .map((event) => (
              <div key={event.seq}>
                <strong>
                  {event.type === 'user/message'
                    ? t('roleUser')
                    : event.type === 'assistant/message'
                      ? t('roleAssistant')
                      : t('roleTool')}
                </strong>
                <pre>{text(event.data)}</pre>
              </div>
            ))}
        </section>
      )}
      {data.handoffs.length > 0 && (
        <section className="cm-card">
          <h2>{t('progress')}</h2>
          {data.handoffs.slice(0, 8).map((h) => (
            <p key={h.id}>
              {data.sessions.find((s) => s.id === h.sessionId)?.title ||
                h.sessionId.slice(0, 8)}{' '}
              · {stateLabel(h.state, t)}
            </p>
          ))}
        </section>
      )}
      {Object.values(data.errors).map((value, index) => (
        <p className="cm-error" key={index}>
          {value}
        </p>
      ))}
    </div>
  )
}
export function RemotePanel({
  model,
  open,
  t,
}: { model: UiModel; open: Actions['open'] } & Locale) {
  const state = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  )
  return (
    <>
      <ProjectSetupDialog
        model={model}
        data={state.data}
        setup={state.projectSetup}
        t={t}
      />
      <RemotePanelView
        {...state}
        t={t}
        request={(command) => model.request(command)}
        refresh={() => model.refresh()}
        takeover={(id) => model.ensureOwned(id, t)}
        open={open}
      />
    </>
  )
}
export function HandoffDock({
  model,
  sessionId,
  t,
}: { model: UiModel; sessionId: string } & Locale) {
  const state = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  )
  const [target, setTarget] = useState(''),
    [targetModel, setTargetModel] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const data = state.data,
    session = data?.sessions.find((s) => s.id === sessionId)
  if (!data || !session) return null
  const options = data.nodes.filter((n) => n.online && n.id !== data.nodeId)
  const destination = target || options[0]?.id || ''
  const takingOver = state.takingOver?.includes(sessionId) ?? false
  const local = session.activeNodeId === data.nodeId
  const choices = local
    ? (data.nodes.find((n) => n.id === destination)?.models ?? [])
    : (data.models ?? [])
  const chosenModel = choices.find(
    (choice) =>
      JSON.stringify({ provider: choice.provider, model: choice.model }) ===
      targetModel,
  )
  const route = chosenModel
    ? { provider: chosenModel.provider, model: chosenModel.model }
    : undefined
  const switching =
    state.modelSelecting?.includes(sessionId) ||
    data.modelSwitching?.includes(sessionId)
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      if (
        (!session.projectId ||
          !data.mappings.some((m) => m.projectId === session.projectId)) &&
        !(await model.chooseProject(sessionId, t))
      )
        return
      if (targetModel && !route)
        throw new ControlError('MODEL_RELAY_CHANGED', t('MODEL_RELAY_CHANGED'))
      await model.request({
        action: 'handoff',
        sessionId,
        targetNodeId: destination,
        ...(route ? { targetModel: route } : {}),
      })
      await model.refresh()
    } catch (error) {
      setError(errorText(error, t))
      await model.refresh()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cm-dock">
      {state.error && (
        <span role="status" className="cm-error">
          {t('CONNECTION_LOST')}
        </span>
      )}
      <style>{style}</style>
      <ProjectSetupDialog
        model={model}
        data={data}
        setup={
          state.projectSetup?.sessionId === sessionId
            ? state.projectSetup
            : undefined
        }
        t={t}
      />
      {(!session.projectId ||
        !data.mappings.some((m) => m.projectId === session.projectId)) &&
        !session.handoffId && (
          <button
            disabled={busy || takingOver}
            onClick={() =>
              void model
                .chooseProject(sessionId, t)
                .catch((error) => setError(errorText(error, t)))
            }
          >
            {t('chooseProject')}
          </button>
        )}
      <strong>{t('app')}</strong>
      <span>
        {session.handoffState
          ? stateLabel(session.handoffState, t)
          : session.activeNodeName}
      </span>
      {takingOver && <span role="status">{t('takingOver')}</span>}
      {switching && <span role="status">{t('switchingModel')}</span>}
      {!session.handoffId && session.activeNodeId && (
        <label>
          {t('targetModel')}
          <select
            aria-label={t('targetModel')}
            value={targetModel}
            disabled={busy || takingOver || switching}
            onChange={(event) => setTargetModel(event.target.value)}
          >
            <option value="">{t('keepModel')}</option>
            {choices.map((choice) => (
              <option
                key={choice.provider + '/' + choice.model}
                value={JSON.stringify({
                  provider: choice.provider,
                  model: choice.model,
                })}
              >
                {choice.provider} / {choice.name ?? choice.model}
              </option>
            ))}
          </select>
        </label>
      )}
      {route && <small>{t('providerNotice')}</small>}
      {!local && session.activeNodeId && !session.handoffId && (
        <button
          disabled={busy || takingOver}
          onClick={() => {
            setBusy(true)
            setError('')
            if (targetModel && !route) {
              setError(t('MODEL_RELAY_CHANGED'))
              setBusy(false)
              return
            }
            void model
              .ensureOwned(sessionId, t, undefined, route)
              .catch((error) => setError(errorText(error, t)))
              .finally(() => setBusy(false))
          }}
        >
          {takingOver ? t('takingOver') : t('takeover')}
        </button>
      )}
      {local && !session.handoffId && (
        <>
          <select
            aria-label={t('target')}
            value={destination}
            onChange={(event) => {
              setTarget(event.target.value)
              setTargetModel('')
            }}
          >
            <option value="">{t('choose')}</option>
            {options.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
          <button disabled={busy || !destination} onClick={() => void submit()}>
            {busy ? t('busy') : t('handoff')}
          </button>
        </>
      )}
      {error && <span className="cm-error">{error}</span>}
    </div>
  )
}

export function SessionDeviceView({
  data,
  sessionId,
  detail = false,
  t,
}: Locale & { data?: Snapshot; sessionId: string; detail?: boolean }) {
  const session = data?.sessions.find((s) => s.id === sessionId)
  if (!data || !session?.activeNodeName) return null
  const remote = session.activeNodeId !== data.nodeId
  if (!remote && !detail) return null
  const label = `${remote ? t('remote') : t('local')}: ${session.activeNodeName}`
  return detail ? (
    <span style={{ fontSize: 12, opacity: 0.75 }}>{label}</span>
  ) : (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{ color: '#8297ec', fontSize: 13 }}
    >
      ↗
    </span>
  )
}
export function SessionDevice({
  model,
  sessionId,
  detail,
  t,
}: Locale & { model: UiModel; sessionId: string; detail?: boolean }) {
  const { data } = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  )
  return (
    <SessionDeviceView
      data={data}
      sessionId={sessionId}
      detail={detail}
      t={t}
    />
  )
}
