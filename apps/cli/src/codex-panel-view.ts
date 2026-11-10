import { codexPanelCopy } from './codex-panel-copy.js'

// The managed runtime serves this self-contained MCP App.
export const codexPanelHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ContextMesh</title>
<style>
:root {
  color-scheme: light dark;
  font: 14px/1.45 system-ui, sans-serif;
  --surface: light-dark(#fff, #000);
  --ink: light-dark(#171717, #f5f5f5);
  --muted: light-dark(#606060, #aaa);
  --border: light-dark(#ddd, #343434);
  --hover: light-dark(#f5f5f5, #141414);
  --selected: light-dark(#eee, #202020);
  --primary: light-dark(#000, #fff);
  --primary-ink: light-dark(#fff, #000);
  --good: light-dark(#275742, #b3dec2);
  --warning: light-dark(#79531c, #edce9e);
  --danger: light-dark(#8f3832, #ffb8b2);
  background: var(--surface);
  color: var(--ink);
  scroll-padding-top: 92px;
}
:root[data-theme="dark"] { color-scheme: dark; }
:root[data-theme="light"] { color-scheme: light; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0 auto; max-width: 660px; padding: 0 16px 18px; }
h1, h2, p { margin: 0; }
h1 { font-size: 18px; font-weight: 650; letter-spacing: -.025em; }
h2 { font-size: 14px; font-weight: 650; }
small, .muted { color: var(--muted); font-size: 12px; }
button, input, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { cursor: default; opacity: .5; }
:focus-visible { outline: 2px solid light-dark(#505050, #d5d5d5); outline-offset: 2px; }
input { accent-color: light-dark(#262626, #ddd); }
.header, .header-actions, .section-heading, .folder-row, .job-title {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
}
.panel-top { position: sticky; top: 0; z-index: 3; background: var(--surface); padding-top: 12px; }
.header { padding-bottom: 8px; }
#connection { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
#connection::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
#connection[data-state="connected"] { color: var(--good); }
#connection[data-state="disconnected"] { color: var(--warning); }
.quiet, nav button {
  min-height: 34px; padding: 4px 8px; color: var(--muted);
  background: transparent; border: 0; border-radius: 7px;
}
.quiet:hover:not(:disabled), nav button:hover { background: var(--hover); }
nav { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; padding-bottom: 9px; border-bottom: 1px solid var(--border); }
nav button[aria-pressed="true"] { background: var(--selected); color: var(--ink); font-weight: 620; }
.badge {
  border: 1px solid var(--border); border-radius: 6px; color: var(--muted);
  padding: 2px 6px; font-size: 11px; white-space: nowrap;
}
#activityCount { padding: 0 5px; margin-inline-start: 4px; border-radius: 10px; color: var(--warning); }
.badge[data-status="takeover"], .badge[data-status="completed"] { color: var(--good); }
.badge[data-status="recovery"], .badge[data-status="attention"], .badge[data-status="busy"] { color: var(--warning); }
.badge[data-status="failed"] { color: var(--danger); }
.page, form, .thread-field, .folder-value, .source-text { display: grid; min-width: 0; }
.page { padding-top: 14px; gap: 10px; }
form { gap: 10px; }
.thread-field { gap: 5px; }
#receive { border-top: 1px solid var(--border); padding-top: 11px; }
.archive-controls, .history, #historyContent { display: grid; gap: 8px; }
.archive-controls label, .history label { display: grid; gap: 4px; }
.archive-controls details label { padding-top: 6px; }
.archive-controls input, .archive-controls textarea, #historyQuery {
  width: 100%; min-width: 0; border: 1px solid var(--border);
  border-radius: 7px; padding: 7px 9px; background: var(--surface);
}
.archive-controls textarea { resize: vertical; }
.history { border-top: 1px solid var(--border); padding-top: 12px; }
.history pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 19rem; overflow: auto; margin: 0; }
progress { width: 100%; accent-color: var(--primary); }
.source-list { display: grid; gap: 4px; max-height: 285px; overflow: auto; padding: 2px; }
.source-row, #thread, .thread-option {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center;
  width: 100%; text-align: start; overflow-wrap: anywhere;
}
.source-row { padding: 8px; border: 1px solid transparent; border-radius: 8px; background: transparent; }
button.source-row:hover, .thread-option:hover { background: var(--hover); }
button.source-row[aria-pressed="true"] { border-color: var(--border); background: var(--selected); }
.source-text { gap: 2px; }
#unavailable { color: var(--muted); font-size: 12px; }
summary { cursor: pointer; }
#unavailable summary { padding: 3px 0; }
.folder-value { gap: 2px; overflow-wrap: anywhere; }
.check { display: flex; align-items: center; gap: 6px; min-height: 32px; }
.secondary, .primary {
  padding: 6px 10px; min-height: 34px; border: 1px solid var(--border);
  border-radius: 7px; background: var(--surface);
}
.secondary:hover:not(:disabled) { background: var(--hover); }
.primary { background: var(--primary); color: var(--primary-ink); border-color: var(--primary); font-weight: 620; }
.main-action { width: 100%; min-height: 40px; }
#browse { flex-shrink: 0; }
.thread-picker { position: relative; min-width: 0; }
#thread { padding: 8px 12px; min-height: 40px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface); }
#thread:hover:not(:disabled), #thread[aria-expanded="true"] { background: var(--hover); }
.chevron { width: 14px; height: 14px; display: grid; place-items: center; color: var(--muted); transition: transform 160ms ease; }
.chevron::before { content: ""; width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: translateY(-1px) rotate(45deg); }
#thread[aria-expanded="true"] .chevron { transform: rotate(180deg); }
#threads {
  position: absolute; z-index: 2; inset-inline: 0; top: calc(100% + 5px);
  display: grid; gap: 3px; max-height: 220px; overflow: auto; padding: 5px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: 0 7px 20px light-dark(#0000001c, #000000a0);
  opacity: 0; visibility: hidden; pointer-events: none;
  transform: translateY(-5px) scale(.985); transform-origin: top center;
  transition: opacity 150ms ease, transform 170ms cubic-bezier(.2,.7,.3,1), visibility 0s linear 170ms;
}
#thread[aria-expanded="true"] + #threads { opacity: 1; visibility: visible; pointer-events: auto; transform: none; transition-delay: 0s; }
.thread-option { border: 0; border-radius: 9px; background: transparent; min-height: 36px; padding: 7px 9px; }
.thread-option[aria-pressed="true"] { background: var(--selected); }
.thread-option::after { content: ""; width: 6px; height: 6px; border-radius: 50%; background: transparent; }
.thread-option[aria-pressed="true"]::after { background: currentColor; }
fieldset { min-width: 0; display: grid; gap: 5px; margin: 0; padding: 0; border: 0; }
legend { padding: 0 0 5px; }
.scope {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px; align-items: start;
  padding: 8px; border: 1px solid var(--border); border-radius: 8px;
}
.scope:has(:checked) { background: var(--selected); }
.scope span { display: grid; gap: 1px; }
.notice { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.notice[data-error="true"] { color: var(--danger); }
.notice:empty { display: none; }
#queuedNotice { padding-top: 8px; }
#queuedNotice button { margin-inline-start: 6px; }
article { border-top: 1px solid var(--border); padding: 9px 0; display: grid; gap: 4px; justify-items: start; overflow-wrap: anywhere; }
.job-title { width: 100%; align-items: start; }
article details, article code { font-size: 12px; color: var(--muted); }
article code { display: block; user-select: all; }
.job-actions, .dialog-actions { display: flex; flex-wrap: wrap; gap: 7px; }
dialog {
  position: fixed; inset: 0; margin: auto; width: min(380px, calc(100% - 24px));
  max-width: none; max-height: calc(100% - 24px); overflow: auto;
  border: 1px solid var(--border); border-radius: 13px; padding: 15px;
  background: var(--surface); color: var(--ink);
}
dialog::backdrop { background: light-dark(#0005, #000b); }
dialog h2 { font-size: 16px; }
dialog p { overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: fit-content(40%) minmax(0, 1fr); gap: 6px 12px; margin: 12px 0; }
dt { color: var(--muted); overflow-wrap: anywhere; }
dd { margin: 0; overflow-wrap: anywhere; }
.dialog-actions { justify-content: end; margin-top: 13px; }
@media (max-width: 360px) {
  body { padding-inline: 10px; }
  .source-row, .job-title { gap: 5px; }
}
@media (pointer: coarse) {
  .quiet, .secondary, .primary, .thread-option, .check, nav button, #thread { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .chevron, #threads { transition: none; }
}
</style>
</head>
<body>
<div class="panel-top">
<header class="header">
  <h1>ContextMesh</h1>
  <div class="header-actions">
    <span id="connection" class="muted" role="status" data-state="connecting">Connecting…</span>
    <button id="refresh" class="quiet" type="button" data-copy="refresh" disabled></button>
  </div>
</header>
<nav aria-label="ContextMesh">
  <button type="button" data-view="receive" aria-controls="receivePage" aria-pressed="true" data-copy="receive"></button>
  <button type="button" data-view="publish" aria-controls="publishPage" aria-pressed="false" data-copy="publish"></button>
  <button type="button" data-view="activity" aria-controls="activityPage" aria-pressed="false"><span data-copy="activity"></span><span id="activityCount" class="badge" hidden></span></button>
</nav>
</div>
<div id="queuedNotice" class="notice" hidden><span role="status" data-copy="submitted"></span><button id="viewActivity" class="quiet" type="button" data-copy="viewActivity"></button></div>
<main>
  <section id="receivePage" class="page" data-page="receive" aria-labelledby="receiveHeading">
    <div class="section-heading"><h2 id="receiveHeading" data-copy="shared"></h2><span id="readyCount" class="muted"></span></div>
    <p id="receiveNotice" class="notice" role="status"></p>
    <div id="readySources" class="source-list" role="group" aria-labelledby="receiveHeading" hidden></div>
    <details id="unavailable" hidden>
      <summary><span data-copy="unavailable"></span> <span id="unavailableCount"></span></summary>
      <div id="unavailableSources" class="source-list"></div>
    </details>
    <form id="receive" hidden aria-labelledby="receiveSettings">
      <h2 id="receiveSettings" data-copy="settings"></h2>
      <div class="folder-row">
        <div class="folder-value"><span class="muted" data-copy="folder"></span><strong id="folderName"></strong><small id="folderParent"></small></div>
        <button id="browse" class="secondary" type="button" data-copy="chooseFolder" aria-describedby="folderStatus" disabled></button>
      </div>
      <p id="folderStatus" class="notice" role="status"></p>
      <label class="check"><input id="write" type="checkbox"><span data-copy="allowWrites"></span></label>
      <div id="budgetOptions" class="archive-controls" hidden>
        <label><span data-copy="nextInstruction"></span><textarea id="archiveQuery" rows="2" maxlength="16000"></textarea></label>
        <details>
          <summary data-copy="contextSettings"></summary>
          <label><span data-copy="contextWindow"></span><input id="contextWindow" type="number" min="1" max="10000000"></label>
        </details>
        <div class="job-actions">
          <button id="historyOpen" class="secondary" type="button" data-copy="browseHistory" hidden></button>
          <button id="picksClear" class="quiet" type="button" data-copy="clearExcerpts" hidden></button>
        </div>
        <p id="picksStatus" class="notice" role="status"></p>
      </div>
      <button id="take" class="primary main-action" type="button" data-copy="reviewTakeover" disabled></button>
      <p id="receiveResult" class="notice" role="status"></p>
    </form>
    <section id="history" class="history" aria-labelledby="historyTitle" hidden>
      <div class="section-heading">
        <h2 id="historyTitle" data-copy="history"></h2>
        <button id="historyClose" class="quiet" type="button" data-copy="closeHistory"></button>
      </div>
      <label><span data-copy="searchHistory"></span><input id="historyQuery" type="search" maxlength="512"></label>
      <div class="job-actions">
        <button id="historySearch" class="secondary" type="button" data-copy="search"></button>
        <button id="historyParent" class="secondary" type="button" data-copy="earlierArchive" hidden></button>
      </div>
      <p id="historyNotice" class="notice" role="status"></p>
      <div id="historyList" aria-live="polite"></div>
      <button id="historyMore" class="secondary" type="button" data-copy="moreRecords" hidden></button>
      <div id="historyContent" hidden>
        <pre id="historyText"></pre>
        <div class="job-actions">
          <button id="historyNext" class="secondary" type="button" data-copy="nextPart" hidden></button>
          <button id="historyInclude" class="secondary" type="button" data-copy="includeExcerpt"></button>
        </div>
      </div>
    </section>
  </section>
  <section id="publishPage" class="page" data-page="publish" aria-labelledby="publishHeading" hidden>
    <h2 id="publishHeading" data-copy="publishHeading"></h2>
    <p id="publishNotice" class="notice" role="status"></p>
    <form id="send">
      <div class="thread-field">
        <span id="threadLabel" data-copy="localThread"></span>
        <div id="threadPicker" class="thread-picker">
          <button id="thread" type="button" aria-controls="threads" aria-expanded="false" aria-labelledby="threadLabel threadValue" disabled>
            <span id="threadValue" data-copy="chooseThread"></span><span class="chevron" aria-hidden="true"></span>
          </button>
          <div id="threads" role="group" aria-labelledby="threadLabel" inert></div>
        </div>
      </div>
      <fieldset>
        <legend data-copy="archiveScope"></legend>
        <label class="scope"><input type="radio" name="archiveScope" value="full" checked><span><strong data-copy="full"></strong><small data-copy="fullDetail"></small></span></label>
        <label class="scope"><input type="radio" name="archiveScope" value="text"><span><strong data-copy="text"></strong><small data-copy="textDetail"></small></span></label>
      </fieldset>
      <p class="notice" data-copy="publishHelp"></p>
      <button id="publish" class="primary main-action" type="button" data-copy="reviewPublish" disabled></button>
      <p id="publishResult" class="notice" role="status"></p>
    </form>
  </section>
  <section id="activityPage" class="page" data-page="activity" aria-labelledby="activityHeading" hidden>
    <h2 id="activityHeading" data-copy="activityHeading"></h2>
    <p id="activityNotice" class="notice" role="status"></p>
    <p id="activityResult" class="notice" role="status"></p>
    <div id="jobs"></div>
  </section>
</main>
<dialog id="review" aria-labelledby="reviewTitle" aria-describedby="reviewNote">
  <h2 id="reviewTitle"></h2>
  <dl id="reviewFields"></dl>
  <p id="reviewNote"></p>
  <details id="reviewDetails" hidden><summary data-copy="selectedRecords"></summary><ul id="reviewRecords"></ul></details>
  <div class="dialog-actions">
    <button id="cancelReview" class="secondary" type="button" data-copy="cancel" autofocus></button>
    <button id="confirmReview" class="primary" type="button"></button>
  </div>
</dialog>
<script type="module">
const copy = ${JSON.stringify(codexPanelCopy)}
const $ = (id) => document.getElementById(id)
const pending = new Map()
const tabs = [...document.querySelectorAll('[data-view]')]
const pages = [...document.querySelectorAll('[data-page]')]
const agentLabels = {deepseek: 'DeepSeek Harness', codex: 'Codex'}
const kindLabels = {takeover:'kindTakeover', import:'kindImport', publish:'kindPublish'}
let language = navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
let seq = 0, confirmation, preparing = false, starting = false, refreshing = false, refreshingJobs = false
let catalog, remote = [], local = [], jobs, selectedSource, selectedThread, retryThread
let catalogRevision = 0, checkingConnection = false, choicesError
let pickingFolder = false, selectedPath
let archiveSettingsKey, historyArchive, historyCursor, historyParent, activeExcerpt, include = []
let historyGeneration = 0, excerptGeneration = 0

function t(key) { return copy[language][key] || key }
function countLabel(key, count) { return t(key).replace('{count}', String(count)) }
function bytesLabel(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MiB' : (bytes / 1024).toFixed(1) + ' KiB'
}
function localize() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  for (const element of document.querySelectorAll('[data-copy]')) element.textContent = t(element.dataset.copy)
}
function hostAppearance(context) {
  if (!context) return
  if (context.theme === 'light' || context.theme === 'dark') document.documentElement.dataset.theme = context.theme
  if (typeof context.locale !== 'string') return
  const nextLanguage = context.locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  if (nextLanguage === language) return
  language = nextLanguage
  localize()
  connection($('connection').dataset.state)
  updateFolder()
  updateReceive()
  updatePicks()
  renderSources()
  renderThreads()
  renderJobs()
}
function post(message) { window.parent.postMessage({jsonrpc:'2.0', ...message}, '*') }
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
  if (data.method === 'ui/notifications/host-context-changed') hostAppearance(data.params)
  if (data.method === 'ping' && data.id != null) post({id:data.id,result:{}})
  if (!('result' in data || 'error' in data)) return
  const receive = pending.get(data.id)
  if (receive) { pending.delete(data.id); receive(data) }
})
async function tool(name, args = {}, timeout) {
  const result = await rpc('tools/call', {name:'contextmesh_' + name, arguments:args}, timeout)
  const text = result?.content?.find((entry) => entry.type === 'text')?.text
  if (result?.isError || !text) throw new Error(text || 'The panel action failed.')
  return JSON.parse(text)
}
function line(parent, tag, text, className) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text) element.textContent = text
  parent.append(element)
  return element
}
function button(parent, text, className, run) {
  const element = line(parent, 'button', text, className)
  element.type = 'button'
  element.addEventListener('click', run)
  return element
}
function badge(parent, status, label = t(status)) {
  const element = line(parent, 'span', label, 'badge')
  element.dataset.status = status
}
function notice(id, message = '', error = false) {
  $(id).textContent = message
  $(id).dataset.error = String(error)
}
function connection(state) {
  $('connection').dataset.state = state
  $('connection').textContent = t(state)
}
function showPage(page, focus = false) {
  setThreadPicker(false)
  for (const tab of tabs) {
    const active = tab.dataset.view === page
    tab.setAttribute('aria-pressed', String(active))
    if (active && focus) tab.focus()
  }
  for (const section of pages) section.hidden = section.dataset.page !== page
  if (page === 'activity') $('queuedNotice').hidden = true
}

function conversationTitle(value) { return value?.trim().slice(0,160) || undefined }
function localTitle(thread) { return conversationTitle(thread?.name) || conversationTitle(thread?.preview) }
function fallbackTitle(id) { return t('untitled') + ' · ' + id.slice(-8) }
function sourceKey(source) { return source.adapter + ':' + source.id }
function canReceive(source) {
  return source && (source.status === 'takeover' && catalog?.takeoverAvailable ||
    source.status === 'import' && catalog?.importAvailable)
}
function renderSources() {
  const ready = $('readySources'), unavailable = $('unavailableSources')
  ready.replaceChildren()
  unavailable.replaceChildren()
  for (const source of remote) {
    const key = sourceKey(source)
    const available = canReceive(source)
    const row = available
      ? button(ready, '', 'source-row', () => {
        selectedSource = key
        notice('receiveResult')
        updateReceive()
      })
      : line(unavailable, 'div', '', 'source-row')
    row.dataset.source = key
    if (available) row.setAttribute('aria-pressed', String(selectedSource === key))
    const description = line(row, 'span', '', 'source-text')
    line(description, 'strong', conversationTitle(source.title) || fallbackTitle(source.id))
    line(description, 'small', [
      agentLabels[source.adapter] || source.adapter,
      source.activeNodeName,
      typeof source.bytes === 'number' ? bytesLabel(source.bytes) : undefined,
    ].filter(Boolean).join(' · '))
    const unsupported = !available && ['takeover','import'].includes(source.status)
    badge(row, unsupported ? 'unavailable' : source.status, unsupported ? t('unsupported') : t(source.status))
  }
  ready.hidden = !ready.childElementCount
  $('readyCount').textContent = catalog ? countLabel('readyCount', ready.childElementCount) : ''
  $('unavailable').hidden = !unavailable.childElementCount
  $('unavailableCount').textContent = String(unavailable.childElementCount)
}
function sourceChoice() { return remote.find(source => sourceKey(source) === selectedSource) }
function budgeted(source) {
  return source?.status === 'import' && (source.format === 2 || source.adapter === 'deepseek' && catalog?.chunkedArchives)
}
function updateReceive() {
  const source = sourceChoice()
  const available = Boolean(canReceive(source))
  if (archiveSettingsKey !== selectedSource) {
    archiveSettingsKey = selectedSource
    closeHistory()
    include = []
    $('archiveQuery').value = ''
    updatePicks()
  }
  $('budgetOptions').hidden = !budgeted(source)
  $('historyOpen').hidden = source?.format !== 2
  $('receive').hidden = !available
  $('take').disabled = preparing || starting || refreshing || pickingFolder || !selectedPath || !available
  $('take').textContent = t(source?.status === 'import' ? 'reviewImport' : 'reviewTakeover')
  $('browse').disabled = pickingFolder || preparing || starting || !available
  for (const row of $('readySources').children) row.setAttribute('aria-pressed', String(row.dataset.source === selectedSource))
}
function updateFolder() {
  const split = selectedPath?.lastIndexOf('/') ?? -1
  $('folderName').textContent = selectedPath ? selectedPath.slice(split + 1) || selectedPath : t('noFolder')
  $('folderParent').textContent = split > 0 ? selectedPath.slice(0, split) : ''
}
$('browse').addEventListener('click', async () => {
  if (pickingFolder || preparing || starting) return
  pickingFolder = true
  notice('folderStatus', t('pickingFolder'))
  updateReceive()
  try {
    let result = await tool('folder_picker', {action:'open', initialDirectory:selectedPath})
    while (result.state === 'waiting') {
      await new Promise(resolve => setTimeout(resolve, 500))
      result = await tool('folder_picker', {action:'status', id:result.id})
    }
    if (result.state === 'failed') throw new Error(result.message)
    if (result.state === 'selected') selectedPath = result.path
    updateFolder()
    notice('folderStatus')
  } catch (error) {
    notice('folderStatus', error.message, true)
  } finally {
    pickingFolder = false
    updateReceive()
  }
})

function updatePicks() {
  notice('picksStatus', include.length ? countLabel('excerptCount', include.length) : '')
  $('picksClear').hidden = !include.length
}
function closeHistory() {
  $('history').hidden = true
  historyGeneration++
  excerptGeneration++
}
async function loadHistory(reset = false) {
  const id = historyArchive, generation = ++historyGeneration
  $('historyMore').disabled = true
  notice('historyNotice')
  if (reset) {
    $('historyList').replaceChildren()
    $('historyContent').hidden = true
    $('historyParent').hidden = true
    $('historyMore').hidden = true
    activeExcerpt = undefined
    excerptGeneration++
    historyCursor = undefined
  }
  try {
    const page = await tool('archive_index', {id, query:$('historyQuery').value, after:historyCursor})
    if (generation !== historyGeneration) return
    $('historyTitle').textContent = page.title || t('history')
    historyCursor = page.next ?? undefined
    historyParent = page.parent
    $('historyParent').hidden = !historyParent
    $('historyMore').hidden = historyCursor === undefined
    if (!page.records.length && reset) line($('historyList'), 'p', t('noRecords'), 'muted')
    for (const record of page.records) {
      const row = line($('historyList'), 'article')
      line(row, 'strong', t('record') + ' ' + record.seq + ' · ' + record.kind + ' · ' + bytesLabel(record.bytes))
      line(row, 'p', record.preview)
      const actions = line(row, 'div', '', 'job-actions')
      button(actions, t('readRecord'), 'secondary', () => readExcerpt(id, record.seq, 0))
      for (const anchor of record.anchors.slice(-4))
        button(actions, t('line') + ' ' + anchor.line, 'quiet', () => readExcerpt(id, record.seq, anchor.offset))
    }
  } catch (error) {
    if (generation === historyGeneration) notice('historyNotice', error.message, true)
  } finally {
    if (generation === historyGeneration) $('historyMore').disabled = false
  }
}
async function readExcerpt(id, seq, offset) {
  const generation = ++excerptGeneration
  notice('historyNotice')
  try {
    const page = await tool('archive_content', {id, seq, offset})
    if (generation !== excerptGeneration) return
    activeExcerpt = {id, seq, offset, next:page.next}
    $('historyText').textContent = page.text
    $('historyContent').hidden = false
    $('historyNext').hidden = page.next == null
  } catch (error) {
    if (generation === excerptGeneration) notice('historyNotice', error.message, true)
  }
}
$('picksClear').addEventListener('click', () => { include = []; updatePicks() })
$('historyOpen').addEventListener('click', () => {
  const source = sourceChoice()
  if (source?.format !== 2) return
  historyArchive = source.id
  $('historyQuery').value = ''
  $('history').hidden = false
  $('historyQuery').focus()
  void loadHistory(true)
})
$('historyClose').addEventListener('click', () => {
  closeHistory()
  $('historyOpen').focus()
})
$('historySearch').addEventListener('click', () => loadHistory(true))
$('historyQuery').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault()
    void loadHistory(true)
  }
})
$('historyMore').addEventListener('click', () => loadHistory())
$('historyParent').addEventListener('click', () => {
  if (!historyParent) return
  historyArchive = historyParent
  void loadHistory(true)
})
$('historyNext').addEventListener('click', () => {
  if (activeExcerpt?.next != null) readExcerpt(activeExcerpt.id, activeExcerpt.seq, activeExcerpt.next)
})
$('historyInclude').addEventListener('click', () => {
  if (!activeExcerpt) return
  const {id, seq, offset} = activeExcerpt
  if (include.some(item => item.id === id && item.seq === seq && item.offset === offset)) return
  if (include.length >= 8) { notice('historyNotice', t('excerptLimit'), true); return }
  include.push({id, seq, offset, length:4096})
  updatePicks()
})

function setThreadPicker(open, restoreFocus = false) {
  $('thread').setAttribute('aria-expanded', String(open))
  $('threads').inert = !open
  if (restoreFocus) $('thread').focus()
}
function threadChoice() {
  return local.find(thread => thread.id === selectedThread) ||
    (retryThread?.id === selectedThread ? retryThread : undefined)
}
function updatePublish() {
  const thread = threadChoice()
  $('threadValue').textContent = thread ? localTitle(thread) || fallbackTitle(thread.id) : t('chooseThread')
  $('publish').disabled = preparing || starting || refreshing || !catalog?.publishAvailable || !thread
  for (const row of $('threads').children) row.setAttribute('aria-pressed', String(row.dataset.thread === selectedThread))
}
function renderThreads() {
  setThreadPicker(false)
  const list = $('threads')
  list.replaceChildren()
  const choices = retryThread && !local.some(thread => thread.id === retryThread.id) ? [retryThread, ...local] : local
  for (const thread of choices) {
    const row = button(list, localTitle(thread) || fallbackTitle(thread.id), 'thread-option', () => {
      selectedThread = thread.id
      notice('publishResult')
      updatePublish()
      setThreadPicker(false, true)
    })
    row.dataset.thread = thread.id
  }
  $('thread').disabled = !choices.length
  updatePublish()
}
$('thread').addEventListener('click', () => setThreadPicker($('threads').inert))
$('threadPicker').addEventListener('focusout', event => {
  if (event.relatedTarget && !$('threadPicker').contains(event.relatedTarget)) setThreadPicker(false)
})
document.addEventListener('pointerdown', event => {
  if (!$('threads').inert && !$('threadPicker').contains(event.target)) setThreadPicker(false)
})
$('threadPicker').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('threads').inert) {
    event.preventDefault()
    setThreadPicker(false, true)
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = [...$('threads').children]
  if (!rows.length) return
  event.preventDefault()
  const current = rows.indexOf(document.activeElement)
  const selected = rows.findIndex(row => row.dataset.thread === selectedThread)
  const index = current < 0
    ? Math.max(0, selected)
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
  setThreadPicker(true)
  rows[index].focus()
})

function transferTitle(job) {
  const action = job.action
  if (action.title) return action.title
  if (action.kind === 'publish')
    return localTitle(local.find(thread => thread.id === action.threadId)) || fallbackTitle(action.threadId)
  const source = remote.find(session => session.id === action.sourceId && session.adapter === (action.sourceAdapter ?? 'deepseek'))
  return conversationTitle(source?.title) || localTitle(local.find(thread => thread.id === job.threadId)) || fallbackTitle(action.sourceId)
}
function useText(job) {
  retryThread = {id:job.action.threadId, name:transferTitle(job)}
  selectedThread = retryThread.id
  document.querySelector('input[name="archiveScope"][value="text"]').checked = true
  notice('publishResult')
  showPage('publish', true)
  renderThreads()
  $('thread').focus()
}
function renderJobs() {
  if (!jobs) return
  const list = $('jobs')
  const rendered = JSON.stringify([language, catalog?.chunkedArchives, jobs.map(job => [job, transferTitle(job)])])
  if (rendered === list.dataset.rendered) return
  list.dataset.rendered = rendered
  const open = new Set([...list.querySelectorAll('details[open]')].map(detail => detail.closest('article').dataset.job))
  const focused = list.contains(document.activeElement) ? document.activeElement : undefined
  const focusedJob = focused?.closest('article')?.dataset.job
  const focusedAction = focused?.dataset.action
  const dateFormat = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', {
    month:'short', day:'numeric', hour:'numeric', minute:'2-digit'
  })
  let nextFocus
  list.replaceChildren()
  if (!jobs.length) line(list, 'p', t('noActivity'), 'muted')
  for (const job of jobs) {
    const row = line(list, 'article')
    row.dataset.job = job.id
    const heading = line(row, 'div', '', 'job-title')
    line(heading, 'strong', transferTitle(job))
    badge(heading, job.state)
    const time = dateFormat.format(job.createdAt)
    line(row, 'p', t(kindLabels[job.action.kind]) + ' · ' + time, 'muted')
    line(row, 'p', job.message)
    if (job.state === 'running' && job.progress?.total > 0) {
      const progress = line(row, 'progress')
      progress.max = job.progress.total
      progress.value = job.progress.sent
      progress.setAttribute('aria-label', job.message)
    }
    if (job.archiveId || job.state === 'attention') {
      const detail = line(row, 'details')
      const summary = line(detail, 'summary', t('details'))
      summary.dataset.action = 'details'
      detail.open = open.has(job.id)
      if (job.archiveId) line(detail, 'code', t('archiveId') + ' ' + job.archiveId.slice(-12))
      if (job.state === 'attention') line(detail, 'code', t('operationId') + ' ' + job.id)
    }
    const canOpen = job.threadId && ['completed','failed'].includes(job.state)
    const canRetry = job.action.kind === 'publish' && ['failed','attention'].includes(job.state)
    if (canOpen || canRetry) {
      const actions = line(row, 'div', '', 'job-actions')
      if (canOpen) button(actions, t('openCodex'), 'secondary', async () => {
        try {
          await tool('open', {id:job.id})
          notice('activityResult')
        } catch (error) { notice('activityResult', error.message, true) }
      }).dataset.action = 'open'
      if (canRetry && job.suggestion === 'publish-text')
        button(actions, t('useText'), 'secondary', () => useText(job)).dataset.action = 'useText'
      if (canRetry && (catalog?.chunkedArchives || job.suggestion !== 'publish-text'))
        button(actions, t('retryPublication'), 'secondary', async event => {
          const trigger = event.currentTarget
          trigger.disabled = true
          try {
            await tool('retry_publish', {id:job.id})
            notice('activityResult')
            await refreshJobs()
          } catch (error) { notice('activityResult', error.message, true) }
          finally { trigger.disabled = false }
        }).dataset.action = 'retry'
    }
    if (focusedJob === job.id && focusedAction)
      nextFocus = [...row.querySelectorAll('[data-action]')].find(el => el.dataset.action === focusedAction)
  }
  const outstanding = jobs.filter(job => job.state !== 'completed').length
  $('activityCount').hidden = !outstanding
  $('activityCount').textContent = String(outstanding)
  nextFocus?.focus()
}
async function refreshJobs() {
  if (refreshingJobs) return
  refreshingJobs = true
  try {
    jobs = await tool('jobs')
    renderJobs()
    notice('activityNotice')
  } catch (error) {
    notice('activityNotice', error.message, true)
  } finally { refreshingJobs = false }
}
function applyCatalog(next, error) {
  catalog = next
  remote = catalog?.sessions ?? []
  connection(catalog ? 'connected' : 'disconnected')
  if (!catalog) notice('receiveNotice', error, true)
  else if (selectedSource && !canReceive(sourceChoice())) {
    selectedSource = undefined
    notice('receiveNotice', t('selectionChanged'), true)
  } else notice('receiveNotice', !remote.length ? t('noSessions') : remote.some(canReceive) ? '' : t('noReady'))
  if (choicesError) notice('publishNotice', choicesError, true)
  else if (!catalog) notice('publishNotice', error, true)
  else if (!catalog.publishAvailable) notice('publishNotice', t('upgradeToPublish'), true)
  else notice('publishNotice', !local.length && !retryThread ? t('noLocal') : '')
  renderSources()
  updateReceive()
  updatePublish()
}
async function checkConnection() {
  if (document.hidden || pending.size || checkingConnection || refreshing || preparing || starting) return
  checkingConnection = true
  const revision = catalogRevision
  try {
    await tool('connection', {}, 6000)
    if (revision !== catalogRevision || catalog) return
    const next = await tool('catalog')
    if (revision === catalogRevision) applyCatalog(next)
  } catch (error) {
    if (revision === catalogRevision && catalog) applyCatalog(undefined, error.message)
  } finally { checkingConnection = false }
}
async function refresh() {
  if (refreshing) return
  refreshing = true
  catalogRevision++
  $('refresh').disabled = true
  connection('connecting')
  notice('receiveNotice', t('loadingSessions'))
  notice('publishNotice')
  updateReceive()
  updatePublish()
  setThreadPicker(false)
  try {
    const [server, choices] = await Promise.allSettled([tool('catalog'), tool('choices')])
    choicesError = choices.status === 'rejected' ? choices.reason.message : undefined
    if (choices.status === 'fulfilled') {
      local = choices.value.threads
      if (!threadChoice()) selectedThread = undefined
    } else local = []
    if (server.status === 'fulfilled') applyCatalog(server.value)
    else applyCatalog(undefined, server.reason.message)
    renderThreads()
    renderJobs()
  } finally {
    refreshing = false
    $('refresh').disabled = false
    updateReceive()
    updatePublish()
  }
  await refreshJobs()
}

function review(title, fields, note, label, args, records = []) {
  confirmation = args
  const dialog = $('review')
  dialog.returnValue = ''
  $('reviewTitle').textContent = title
  $('reviewNote').textContent = note
  $('confirmReview').textContent = label
  const list = $('reviewFields')
  list.replaceChildren()
  for (const [name, value] of fields) {
    line(list, 'dt', name)
    line(list, 'dd', value)
  }
  $('reviewDetails').hidden = !records.length
  $('reviewDetails').open = false
  const details = $('reviewRecords')
  details.replaceChildren()
  for (const record of records)
    line(details, 'li', record.kind + ' · ' + t('record') + ' ' + record.seq + ' · ' + bytesLabel(record.length) +
      (record.length < record.totalBytes ? ' · ' + t('excerpt') : ''))
  dialog.showModal()
}
function setPreparing(value) {
  preparing = value
  updateReceive()
  updatePublish()
}
$('take').addEventListener('click', async () => {
  const source = sourceChoice()
  if (preparing || starting || refreshing || pickingFolder || !selectedPath || !canReceive(source)) return
  const target = {cwd:selectedPath, sandbox:$('write').checked ? 'workspace-write' : 'read-only'}
  const title = conversationTitle(source.title)
  const fields = [
    [t('session'), title || fallbackTitle(source.id)],
    [t('folder'), target.cwd],
    [t('permissions'), t(target.sandbox === 'read-only' ? 'readOnly' : 'mayWrite')],
  ]
  const common = {sourceId:source.id, title, target, confirmed:true}
  if (source.status !== 'import') {
    review(t('reviewTakeover'), fields, t('takeoverNote'), t('confirmTakeover'), {kind:'takeover', ...common})
    return
  }
  let resume, records = []
  if (budgeted(source)) {
    const windowInput = $('contextWindow')
    if (!windowInput.reportValidity()) return
    resume = {
      query: $('archiveQuery').value.trim() || undefined,
      contextWindow: windowInput.value ? Number(windowInput.value) : undefined,
      include: [...include],
    }
    setPreparing(true)
    notice('receiveResult', t('checkingImport'))
    try {
      const plan = await tool('preview_import', {id:source.id, sourceAdapter:source.adapter, target, resume}, 180000)
      notice('receiveResult')
      if (sourceKey(source) !== selectedSource || $('receivePage').hidden || !canReceive(sourceChoice())) return
      resume.planDigest = plan.planDigest
      records = plan.selected
      fields.push(
        [t('savedRecords'), countLabel('recordsCount', plan.archivedRecords) + ' · ' + bytesLabel(plan.archivedBytes)],
        [t('loadedRecords'), countLabel('recordsCount', records.length) + ' · ' + plan.inputTokens + ' ' + t('tokens')],
      )
    } catch (error) {
      notice('receiveResult', error.message, true)
      return
    } finally { setPreparing(false) }
  }
  review(t('reviewImport'), fields, t('importNote'), t('confirmImport'), {kind:'import', sourceAdapter:source.adapter, ...common, resume}, records)
})
$('publish').addEventListener('click', async () => {
  const thread = threadChoice()
  if (preparing || starting || refreshing || !catalog?.publishAvailable || !thread) return
  setThreadPicker(false)
  const title = localTitle(thread)
  const scope = document.querySelector('input[name="archiveScope"]:checked').value
  const fields = [
    [t('session'), title || fallbackTitle(thread.id)],
    [t('archiveScope'), t(scope)],
    [t('shareLocation'), 'ContextMesh Server'],
  ]
  let capture
  if (catalog.chunkedArchives) {
    setPreparing(true)
    notice('publishResult', t('preparingArchive'))
    try {
      capture = await tool('prepare_publish', {threadId:thread.id, scope}, 180000)
      notice('publishResult')
      const currentScope = document.querySelector('input[name="archiveScope"]:checked').value
      if (thread.id !== selectedThread || scope !== currentScope || $('publishPage').hidden) {
        if (capture?.id) await tool('discard_capture', {id:capture.id})
        return
      }
    } catch (error) {
      notice('publishResult', error.message, true)
      return
    } finally { setPreparing(false) }
  }
  const notes = [t('publishNote')]
  if (capture) {
    fields.push([t('savedRecords'), countLabel('recordsCount', capture.records) + ' · ' + bytesLabel(capture.bytes)])
    if (capture.interrupted) notes.push(t('interrupted'))
    if (capture.omittedAttachments) notes.push(countLabel('omittedAttachments', capture.omittedAttachments))
    if (capture.unrecognizedItems) notes.push(countLabel('unrecognizedItems', capture.unrecognizedItems))
  } else notes.push(t('legacyArchive'))
  review(t('reviewPublish'), fields, notes.join(' '), t('confirmPublish'),
    {kind:'publish', threadId:thread.id, title, scope, captureId:capture?.id, confirmed:true})
})
$('cancelReview').addEventListener('click', () => $('review').close('cancel'))
$('confirmReview').addEventListener('click', () => $('review').close('confirm'))
$('review').addEventListener('close', async () => {
  const args = confirmation
  confirmation = undefined
  if ($('review').returnValue !== 'confirm' || !args || starting) {
    if (args?.captureId) tool('discard_capture', {id:args.captureId}).catch(error => notice('publishResult', error.message, true))
    return
  }
  const result = args.kind === 'publish' ? 'publishResult' : 'receiveResult'
  starting = true
  notice(result)
  updateReceive()
  updatePublish()
  try {
    await tool('start', args)
    $('queuedNotice').hidden = !$('activityPage').hidden
    await refreshJobs()
  } catch (error) {
    notice(result, error.message, true)
  } finally {
    starting = false
    updateReceive()
    updatePublish()
  }
})
for (const tab of tabs) tab.addEventListener('click', () => showPage(tab.dataset.view))
$('viewActivity').addEventListener('click', () => showPage('activity', true))
$('refresh').addEventListener('click', () => refresh().catch(error => notice('receiveNotice', error.message, true)))

localize()
updateFolder()
notice('activityNotice', t('loadingActivity'))
try {
  const host = await rpc('ui/initialize', {appInfo:{name:'ContextMesh',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'})
  hostAppearance(host?.hostContext)
  post({method:'ui/notifications/initialized'})
  await refresh()
  setInterval(refreshJobs, 2500)
  setInterval(checkConnection, 6000)
  window.addEventListener('online', checkConnection)
  document.addEventListener('visibilitychange', checkConnection)
} catch (error) {
  connection('disconnected')
  for (const id of ['receiveNotice','publishNotice','activityNotice']) notice(id, error.message, true)
}
</script>
</body>
</html>`
