import { chooseWindowsFolder } from './codex-panel-windows-folder.js'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const execute = promisify(execFile)
const folderScript = `
ObjC.import('AppKit')
function run(argv) {
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  const panel = $.NSOpenPanel.openPanel
  panel.title = 'Choose a Project Folder'
  panel.message = 'Choose a folder for this ContextMesh conversation.'
  panel.prompt = 'Choose'
  panel.canChooseDirectories = true
  panel.canChooseFiles = false
  panel.allowsMultipleSelection = false
  if (argv.length) panel.directoryURL = $.NSURL.fileURLWithPathIsDirectory(argv[0], true)
  app.activateIgnoringOtherApps(true)
  return JSON.stringify(Number(panel.runModal) === Number($.NSModalResponseOK) ? ObjC.unwrap(panel.URL.path) : null)
}
`

async function chooseNativeFolder(
  initialDirectory?: string,
  signal?: AbortSignal,
) {
  if (!['darwin', 'win32'].includes(process.platform))
    throw new Error(
      'The native folder picker is available on macOS and Windows. Enter the project path manually.',
    )
  const initial =
    initialDirectory &&
    isAbsolute(initialDirectory) &&
    (await stat(initialDirectory).catch(() => undefined))?.isDirectory()
      ? [initialDirectory]
      : []
  const { stdout } = await (
    process.platform === 'win32'
      ? chooseWindowsFolder(initial[0], signal)
      : execute(
          '/usr/bin/osascript',
          ['-l', 'JavaScript', '-e', folderScript, '--', ...initial],
          { timeout: 5 * 60 * 1000, maxBuffer: 32 * 1024, signal },
        )
  ).catch(() => {
    throw new Error(
      'Could not finish choosing a folder. Reopen the picker or enter the project path manually.',
    )
  })
  const folder = z.string().nullable().parse(JSON.parse(stdout))
  if (folder !== null && !isAbsolute(folder))
    throw new Error('The picker did not return an absolute folder path.')
  return folder
}

export const folderPickerAction = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('open'),
      initialDirectory: z.string().max(8192).optional(),
    })
    .strict(),
  z.object({ action: z.literal('status'), id: z.uuid() }).strict(),
])

type FolderChoice = {
  id: string
} & (
  | { state: 'waiting' | 'cancelled' }
  | { state: 'selected'; path: string }
  | { state: 'failed'; message: string }
)

export function panelFolderPicker(
  selectFolder = chooseNativeFolder,
  signal?: AbortSignal,
) {
  let choice: FolderChoice | undefined
  return (input: unknown): FolderChoice => {
    const action = folderPickerAction.parse(input)
    if (action.action === 'status') {
      if (!choice || choice.id !== action.id)
        throw new Error('This folder selection expired. Open the picker again.')
      return choice
    }
    if (choice?.state === 'waiting')
      throw new Error('A folder picker is already open.')
    const id = randomUUID()
    choice = { id, state: 'waiting' }
    void selectFolder(action.initialDirectory, signal).then(
      (path) => {
        choice =
          path === null
            ? { id, state: 'cancelled' }
            : { id, state: 'selected', path }
      },
      (error: unknown) => {
        choice = {
          id,
          state: 'failed',
          message:
            error instanceof Error
              ? error.message
              : 'The folder picker could not be opened.',
        }
      },
    )
    return choice
  }
}
