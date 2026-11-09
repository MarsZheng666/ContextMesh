// Served directly from the installed runtime so the desktop panel needs no separate web host.
export const codexPanelHtml = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ContextMesh</title>
<style>
:root{color-scheme:light dark;font:15px system-ui}
body{box-sizing:border-box;margin:auto;max-width:760px;padding:24px}
header{display:flex;justify-content:space-between;align-items:center;gap:16px}
h1,h2,p{margin:0 0 12px}h2{font-size:1.15rem}
section,dialog{border:1px solid GrayText;border-radius:12px;padding:18px;margin-block:16px}
p,small{line-height:1.5}label{display:grid;gap:5px;margin-block:10px}
label.check{display:flex;align-items:center}
.folder-row{display:flex;align-items:center;gap:8px}.folder-row input{min-width:0}.folder-row button{flex-shrink:0}
#folderStatus{display:block;margin-top:4px}
input,select,button,textarea{font:inherit;color:inherit;padding:7px 10px;border:1px solid GrayText;border-radius:6px;box-sizing:border-box}
input:not([type=checkbox]),select{width:100%}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}
article{border-top:1px solid GrayText;padding-block:12px;overflow-wrap:anywhere}article p{margin-bottom:5px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:19rem;overflow:auto}
code{display:block;user-select:all;margin-block:6px}dialog{margin:auto;max-width:28rem}dialog::backdrop{background:#0007}
</style>
<header><h1>ContextMesh</h1><button id="refresh" type="button" disabled>Refresh</button></header>
<p id="notice" role="status">Connecting to ContextMesh…</p>
<section>
<h2>Receive a shared session</h2>
<form id="receive">
<label>Shared session<select id="source" required></select></label>
<p id="sourceHelp"></p>
<label for="cwd">Local Codex project directory</label>
<div class="folder-row">
<input id="cwd" list="folders" required placeholder="/path/to/project" aria-describedby="folderStatus">
<button id="browse" type="button" disabled>Choose Folder…</button>
</div>
<small id="folderStatus" role="status"></small>
<datalist id="folders"></datalist>
<label class="check"><input id="write" type="checkbox">Allow writes in the selected project</label>
<div id="budgetOptions" hidden>
<label>Next instruction for finding relevant history <textarea id="archiveQuery" rows="2" maxlength="16000"></textarea></label>
<details><summary>Advanced context settings</summary>
<label>Context window override (tokens) <input id="contextWindow" type="number" min="1" max="10000000"></label>
</details>
<button type="button" id="historyOpen" hidden>Browse full archive</button>
<span id="picksStatus" aria-live="polite"></span>
<button type="button" id="picksClear" hidden>Clear selected excerpts</button>
</div>
<button id="take" disabled>Review transfer</button>
</form>
</section>
<section id="history" hidden>
<h2 id="historyTitle">Archive history</h2>
<form id="historySearchForm">
<label>Search history <input id="historyQuery" maxlength="512"></label>
<button>Search</button>
</form>
<div id="historyList" aria-live="polite"></div>
<button id="historyMore" type="button" hidden>More records</button>
<button id="historyParent" type="button" hidden>Earlier linked archive</button>
<div id="historyContent" hidden>
<pre id="historyText"></pre>
<button id="historyNext" type="button" hidden>Next part</button>
<button id="historyInclude" type="button">Include this excerpt</button>
</div>
<button type="button" id="historyClose">Close history</button>
</section>
<section>
<h2>Publish a conversation</h2>
<form id="send">
<label>Saved Codex conversation<select id="thread" required></select></label>
<label>Archive contents
<select id="archiveScope" aria-describedby="archiveHelp">
<option value="full">Full archive</option>
<option value="text">Conversation text only</option>
</select>
</label>
<p id="archiveHelp">Choose what to share. Full archives include supported tool records.</p>
<p>Wait for the conversation and its tools to finish before publishing.</p>
<button id="publish" disabled>Review snapshot</button>
</form>
</section>
<section>
<h2>Recent transfers</h2>
<div id="jobs" aria-live="polite"></div>
</section>
<dialog id="review">
<h2 id="reviewTitle"></h2>
<p id="reviewText"></p>
<details id="reviewDetails" hidden><summary>Records selected for the model</summary><ul id="reviewRecords"></ul></details>
<form method="dialog">
<button value="cancel" autofocus>Cancel</button>
<button value="confirm">Confirm</button>
</form>
</dialog>
<script type="module">
const $ = (id) => document.getElementById(id)
const pending = new Map()
const bytesLabel = (bytes) => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MiB' : (bytes / 1024).toFixed(1) + ' KiB'
let seq = 0, action, refreshingJobs = false
let remote = [], local = [], receiveCapabilities, receiving = false
let pickingFolder = false, selectedPath
let historyArchive, historyCursor, historyParent, activeExcerpt, include = []
let selectedSourceKey, historyGeneration = 0
const sourceLabels = {
  takeover: 'Ready to take over',
  import: 'Saved · Ready to import',
  recovery: 'Needs recovery on the source device',
  busy: 'Transfer or operation in progress',
  transferred: 'Already transferred',
  empty: 'No saved context',
}
const agentLabels = {deepseek: 'DeepSeek Harness', codex: 'Codex'}
function post(message) {
  window.parent.postMessage({jsonrpc:'2.0', ...message}, '*')
}
function rpc(method, params, timeout = 30000) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Codex did not respond in time. Check recent transfers before submitting again.'))
    }, timeout)
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    })
    post({id, method, params})
  })
}
window.addEventListener('message', ({source, data}) => {
  if (source !== window.parent || data?.jsonrpc !== '2.0') return
  const receive = pending.get(data.id)
  if (receive) { pending.delete(data.id); receive(data) }
  if (data.method === 'ping' && data.id != null) post({id:data.id,result:{}})
})
async function tool(name, args = {}, timeout) {
  const result = await rpc('tools/call', {name:'contextmesh_' + name, arguments:args}, timeout)
  const text = result.content?.find((entry) => entry.type === 'text')?.text
  if (result.isError || !text) throw new Error(text || 'The panel action failed.')
  return JSON.parse(text)
}
function options(id, entries, prompt) {
  const el = $(id), selected = el.value
  el.replaceChildren()
  if (prompt) el.add(new Option(prompt, ''))
  for (const [value, name, disabled] of entries) {
    const option = new Option(name || value, value)
    option.disabled = Boolean(disabled)
    el.append(option)
  }
  if (entries.some(([value, , disabled]) => value === selected && !disabled)) el.value = selected
}
function line(parent, tag, text) {
  const element = document.createElement(tag)
  element.textContent = text
  parent.append(element)
  return element
}
function conversationTitle(value) { return value?.trim().slice(0,160) || undefined }
function localTitle(thread) { return conversationTitle(thread?.name) || conversationTitle(thread?.preview) }
function transferTitle(job) {
  const action = job.action
  if (action.title) return action.title
  if (action.kind === 'publish')
    return localTitle(local.find((thread) => thread.id === action.threadId)) || 'Untitled conversation · ' + action.threadId.slice(-8)
  const source = remote.find((session) => session.id === action.sourceId && session.adapter === (action.sourceAdapter ?? 'deepseek'))
  return conversationTitle(source?.title) || localTitle(local.find((thread) => thread.id === job.threadId)) ||
    'Untitled conversation · ' + action.sourceId.slice(-8)
}
async function refreshJobs() {
  if (refreshingJobs) return
  refreshingJobs = true
  try {
    const jobs = (await tool('jobs')).map((job) => ({...job, displayTitle:transferTitle(job)}))
    const list = $('jobs'), rendered = JSON.stringify(jobs)
    if (rendered === list.dataset.rendered) return
    list.dataset.rendered = rendered
    list.replaceChildren()
    if (!jobs.length) line(list, 'p', 'No transfers yet.')
    for (const job of jobs) {
      const item = document.createElement('article')
      line(item, 'strong', job.displayTitle)
      line(item, 'p', ({takeover:'Takeover', import:'Import', publish:'Publish'}[job.action.kind]) + ' · ' + job.state)
      line(item, 'p', job.message)
      if (job.archiveId) line(item, 'code', 'Archive reference ' + job.archiveId.slice(-12))
      if (job.state === 'attention') line(item, 'code', 'Operation ' + job.id)
      if (job.action.kind === 'publish' && ['failed','attention'].includes(job.state)) {
        const retry = line(item, 'button', 'Retry publication')
        retry.addEventListener('click', async () => {
          retry.disabled = true
          try { await tool('retry_publish', {id:job.id}); await refreshJobs() }
          catch (error) { showError(error) }
          finally { retry.disabled = false }
        })
      }
      if (job.threadId) {
        const button = line(item, 'button', 'Open in Codex')
        button.addEventListener('click', () => tool('open', {id:job.id}).catch(showError))
      }
      list.append(item)
    }
  } finally { refreshingJobs = false }
}
function showError(error) { $('notice').textContent = error.message }
function sourceKey(s) { return s.adapter + ':' + s.id }
function canReceive(s) {
  return s.status === 'takeover' && receiveCapabilities?.takeoverAvailable ||
    s.status === 'import' && receiveCapabilities?.importAvailable
}
function updateReceive() {
  const source = remote.find((s) => sourceKey(s) === $('source').value)
  const budgeted = source?.status === 'import' && (source.format === 2 ||
    source.adapter === 'deepseek' && receiveCapabilities?.chunkedArchives)
  $('budgetOptions').hidden = !budgeted
  $('historyOpen').hidden = source?.format !== 2
  if (selectedSourceKey !== $('source').value) {
    selectedSourceKey = $('source').value
    $('history').hidden = true
    historyGeneration++
    include = []
    updatePicks()
  }
  $('take').disabled = receiving || pickingFolder || !source || !canReceive(source)
  $('take').textContent = source?.status === 'import' ? 'Review import' : source?.status === 'takeover' ? 'Review takeover' : 'Review transfer'
  $('sourceHelp').textContent = source?.status === 'import'
    ? 'Import the saved context into a new Codex conversation.'
    : source?.status === 'takeover'
    ? 'Transfer ownership and automatically continue unfinished work.'
    : remote.length && !remote.some(canReceive)
    ? 'The shared sessions are currently unavailable. Check their status in the list.'
    : 'Saved sessions can be imported. Live sessions can be taken over when the source supports it.'
}
$('source').addEventListener('change', updateReceive)
function updatePicks() {
  $('picksStatus').textContent = include.length ? include.length + ' selected excerpt(s)' : ''
  $('picksClear').hidden = !include.length
}
$('picksClear').addEventListener('click', () => { include = []; updatePicks() })
async function loadHistory(reset = false) {
  const id = historyArchive, generation = ++historyGeneration
  $('historyMore').disabled = true
  if (reset) {
    $('historyList').replaceChildren()
    $('historyContent').hidden = true
    historyCursor = undefined
  }
  try {
    const page = await tool('archive_index', {id, query:$('historyQuery').value, after:historyCursor})
    if (generation !== historyGeneration) return
    $('historyTitle').textContent = page.title
    historyCursor = page.next ?? undefined
    historyParent = page.parent
    $('historyParent').hidden = !historyParent
    $('historyMore').hidden = historyCursor === undefined
    if (!page.records.length && reset) line($('historyList'), 'p', 'No matching records.')
    for (const record of page.records) {
      const row = document.createElement('article')
      line(row,'strong', 'Record ' + record.seq + ' · ' + record.kind + ' · ' + bytesLabel(record.bytes))
      line(row,'p',record.preview)
      const view = line(row,'button','Read record')
      view.type = 'button'
      view.addEventListener('click', () => readExcerpt(id, record.seq, 0).catch(showError))
      for (const anchor of record.anchors.slice(-4)) {
        const jump = line(row,'button','Line ' + anchor.line)
        jump.type = 'button'
        jump.addEventListener('click', () => readExcerpt(id, record.seq, anchor.offset).catch(showError))
      }
      $('historyList').append(row)
    }
  } finally { if (generation === historyGeneration) $('historyMore').disabled = false }
}
async function readExcerpt(id, seq, offset) {
  const generation = historyGeneration
  const page = await tool('archive_content', {id, seq, offset})
  if (generation !== historyGeneration) return
  activeExcerpt = {id,seq,offset,next:page.next}
  $('historyText').textContent = page.text
  $('historyContent').hidden = false
  $('historyNext').hidden = page.next === null
}
$('historyOpen').addEventListener('click', () => {
  const source = remote.find(s => sourceKey(s) === $('source').value)
  if (!source || source.format !== 2) return
  historyArchive = source.id
  $('historyQuery').value = ''
  $('history').hidden = false
  loadHistory(true).catch(showError)
})
$('historyClose').addEventListener('click', () => { $('history').hidden = true; historyGeneration++ })
$('historySearchForm').addEventListener('submit', (event) => { event.preventDefault(); loadHistory(true).catch(showError) })
$('historyMore').addEventListener('click', () => loadHistory().catch(showError))
$('historyParent').addEventListener('click', () => { historyArchive = historyParent; loadHistory(true).catch(showError) })
$('historyNext').addEventListener('click', () => {
  if (activeExcerpt?.next != null) readExcerpt(activeExcerpt.id,activeExcerpt.seq,activeExcerpt.next).catch(showError)
})
$('historyInclude').addEventListener('click', () => {
  if (!activeExcerpt) return
  const {id,seq,offset} = activeExcerpt
  if (include.some(item => item.id === id && item.seq === seq && item.offset === offset)) return
  if (include.length >= 8) { showError(new Error('Select up to eight excerpts.')); return }
  include.push({id,seq,offset,length:4096})
  updatePicks()
})
$('cwd').addEventListener('input', () => { selectedPath = undefined })
$('browse').addEventListener('click', async () => {
  pickingFolder = true
  $('browse').disabled = true
  $('folderStatus').textContent = 'Choose a folder in the macOS dialog.'
  updateReceive()
  try {
    let result = await tool('folder_picker', {action:'open', initialDirectory:selectedPath ?? $('cwd').value.trim()})
    while (result.state === 'waiting') {
      await new Promise((resolve) => setTimeout(resolve, 500))
      result = await tool('folder_picker', {action:'status', id:result.id})
    }
    if (result.state === 'failed') throw new Error(result.message)
    if (result.state === 'selected') {
      selectedPath = result.path
      $('cwd').value = selectedPath
    }
    $('folderStatus').textContent = ''
  } catch (error) {
    $('folderStatus').textContent = error.message
  } finally {
    pickingFolder = false
    $('browse').disabled = false
    updateReceive()
  }
})
async function refresh() {
  $('refresh').disabled = $('take').disabled = $('publish').disabled = true
  $('notice').textContent = 'Checking the server and this Codex device…'
  const [catalog, choices] = await Promise.allSettled([tool('catalog'), tool('choices')])
  const messages = []
  if (choices.status === 'fulfilled') {
    local = choices.value.threads
    options('thread', local.map((t) => [t.id, localTitle(t) || t.id]), 'Choose a conversation')
    options('folders', [...new Set(local.map((t) => t.cwd).filter(Boolean))].map((x) => [x,x]))
  } else messages.push(choices.reason.message)
  if (catalog.status === 'fulfilled') {
    receiveCapabilities = catalog.value
    remote = catalog.value.sessions
    options('source', remote.map((s) => [
      sourceKey(s),
      [conversationTitle(s.title) || s.id, agentLabels[s.adapter] || s.adapter, s.activeNodeName, sourceLabels[s.status]].filter(Boolean).join(' · '),
      !canReceive(s),
    ]), remote.length ? 'Choose a shared session' : 'No shared sessions found')
    if (!catalog.value.publishAvailable) messages.push('Upgrade the ContextMesh Server to publish Codex snapshots.')
    $('publish').disabled = !catalog.value.publishAvailable || choices.status !== 'fulfilled' || !local.length
  } else {
    receiveCapabilities = undefined
    remote = []
    options('source', [], 'Could not load shared sessions')
    messages.push(catalog.reason.message)
  }
  updateReceive()
  $('notice').textContent = messages.join(' ') || 'Connected to the ContextMesh Server.'
  $('refresh').disabled = false
  await refreshJobs()
}
function review(kind, text, args, records = []) {
  action = args
  $('review').returnValue = ''
  $('reviewTitle').textContent = kind
  $('reviewText').textContent = text
  $('reviewDetails').hidden = !records.length
  $('reviewDetails').open = false
  $('reviewRecords').replaceChildren()
  for (const record of records) line($('reviewRecords'),'li',
    record.kind + ' · record ' + record.seq + ' · ' + bytesLabel(record.length) +
    (record.length < record.totalBytes ? ' excerpt' : ''))
  $('review').showModal()
}
$('receive').addEventListener('submit', async (event) => {
  event.preventDefault()
  const source = remote.find((s) => sourceKey(s) === $('source').value)
  if (pickingFolder || !source || !canReceive(source)) return
  const target = {cwd:selectedPath ?? $('cwd').value.trim(), sandbox:$('write').checked ? 'workspace-write' : 'read-only'}
  const title = conversationTitle(source.title)
  const label = '“' + (title || source.id) + '” in ' + target.cwd + ' with ' + target.sandbox + ' access.'
  if (source.status === 'import') {
    let resume
    let detail = '', records = []
    if (!$('budgetOptions').hidden) {
      const query = $('archiveQuery').value.trim() || undefined
      const contextWindow = $('contextWindow').value ? Number($('contextWindow').value) : undefined
      resume = {query,include,contextWindow}
      receiving = true
      updateReceive()
      try {
        const plan = await tool('preview_import', {id:source.id,sourceAdapter:source.adapter,target,resume}, 180000)
        if (sourceKey(source) !== $('source').value) return
        resume = {...resume, planDigest:plan.planDigest}
        records = plan.selected
        detail = ' Saved ' + bytesLabel(plan.archivedBytes) + ' across ' + plan.archivedRecords + ' records. This import loads ' +
          plan.selected.length + ' records or excerpts with a conservative estimate of ' + plan.inputTokens + ' tokens.'
      } catch (error) { showError(error); return }
      finally { receiving = false; updateReceive() }
    }
    review('Import saved session', 'Import ' + label + ' The new conversation uses Codex’s local model.' + detail + ' Send a message in Codex to continue.',
      {kind:'import', sourceId:source.id, sourceAdapter:source.adapter, title, target, resume, confirmed:true}, records)
  } else {
    review('Take over shared session', 'Take over ' + label + ' Codex will check its default model with the conversation context before stopping the source, then continue any unfinished work.',
      {kind:'takeover', sourceId:source.id, title, target, confirmed:true})
  }
})
$('send').addEventListener('submit', async (event) => {
  event.preventDefault()
  const thread = local.find((t) => t.id === $('thread').value)
  if (!thread) return
  const title = localTitle(thread)
  const scope = $('archiveScope').value
  const button = $('publish')
  button.disabled = true
  $('notice').textContent = 'Preparing a local copy for review…'
  try {
    const capture = receiveCapabilities?.chunkedArchives
      ? await tool('prepare_publish', {threadId:thread.id, scope}, 180000)
      : null
    const contents = scope === 'text' ? 'the saved user and assistant messages' : 'the saved messages and supported tool records'
    let details = capture ? ' ' + capture.records + ' records · ' + bytesLabel(capture.bytes) + '.' : ' This Server uses the legacy 1 MiB archive format.'
    if (capture?.interrupted) details += ' The last turn was interrupted.'
    if (capture?.omittedAttachments) details += ' ' + capture.omittedAttachments + ' attachment parts stay in Codex.'
    if (capture?.unrecognizedItems) details += ' ' + capture.unrecognizedItems + ' unrecognized items stay in Codex.'
    $('notice').textContent = 'Review what will be shared.'
    review('Publish a Codex archive', 'Share ' + contents + ' from “' + (title || thread.id) + '” on the ContextMesh Server.' + details,
      {kind:'publish', threadId:thread.id, title, scope, captureId:capture?.id, confirmed:true})
  } catch (error) { showError(error) }
  finally { button.disabled = false }
})
$('review').addEventListener('close', async () => {
  const args = action
  action = undefined
  if ($('review').returnValue !== 'confirm' || !args) {
    if (args?.captureId) tool('discard_capture', {id:args.captureId}).catch(showError)
    return
  }
  const button = $(args.kind === 'publish' ? 'publish' : 'take')
  if (args.kind !== 'publish') receiving = true
  button.disabled = true
  try {
    await tool('start', args)
    await refreshJobs()
    $('notice').textContent = 'Transfer queued. Watch Recent transfers for the result.'
  } catch (error) { showError(error) }
  finally {
    if (args.kind === 'publish') button.disabled = false
    else { receiving = false; updateReceive() }
  }
})
$('refresh').addEventListener('click', () => refresh().catch(showError))
try {
  await rpc('ui/initialize', {appInfo:{name:'ContextMesh',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'})
  post({method:'ui/notifications/initialized'})
  $('browse').disabled = false
  await refresh()
  setInterval(() => refreshJobs().catch(showError), 2500)
} catch (error) { showError(error) }
</script>
</html>`
