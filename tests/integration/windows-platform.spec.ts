import { expect, it } from 'vitest'
import { win32 } from 'node:path'
import { powershellCommand } from '../../packages/platform/src/windows.js'
import { windowsCodexCandidates } from '../../apps/cli/src/codex-executable.js'
import { panelFolderPicker } from '../../apps/cli/src/codex-panel-folder.js'
import { releaseManifest } from '../../packages/runtime-manager/src/manifest.js'

it('keeps Windows paths as data when constructing native PowerShell commands', () => {
  const script = "$env:CM_INITIAL_FOLDER; Write-Output '中文 & % $()'"
  const command = powershellCommand(script)
  expect(command.executable).toMatch(/powershell\.exe$/)
  expect(command.args).toContain('-STA')
  expect(command.args).not.toContain('-ExecutionPolicy')
  expect(
    Buffer.from(command.args.at(-1)!, 'base64').toString('utf16le'),
  ).toContain(script)
  expect(command.args.join(' ')).not.toContain('$env:')
})

it('discovers native Windows Codex executables without selecting a WSL or cmd wrapper', () => {
  expect(
    windowsCodexCandidates({
      CODEX_INSTALL_DIR: 'D:\\中文 & test',
      LOCALAPPDATA: 'C:\\Users\\A B\\AppData\\Local',
      PATH: 'C:\\native;"D:\\more tools"',
    }),
  ).toEqual([
    'D:\\中文 & test\\codex.exe',
    'C:\\Users\\A B\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
    'C:\\native\\codex.exe',
    'D:\\more tools\\codex.exe',
  ])
})

it.each(['C:\\Users\\中文\\Any folder', '\\\\fileserver\\share\\Project'])(
  'keeps native folder %s in the same panel state machine',
  async (path) => {
    expect(win32.isAbsolute(path)).toBe(true)
    const picker = panelFolderPicker(async () => path)
    const opened = picker({ action: 'open', initialDirectory: path })
    await Promise.resolve()
    expect(picker({ action: 'status', id: opened.id })).toEqual({
      id: opened.id,
      state: 'selected',
      path,
    })
  },
)

it('records the Windows Codex capability without advertising Windows DSH', () => {
  const parsed = releaseManifest.parse({
    format: 1,
    version: '0.8.0-dev.18',
    platform: 'win32-x64',
    components: ['codex'],
    node: 'v24.15.0',
    dsh: '0.2.1-rc.3',
    protocol: 1,
    schema: 10,
    minSchema: 8,
    maxSchema: 10,
    sourceCommit: 'a'.repeat(40),
    lockHash: 'b'.repeat(64),
    patchHash: 'c'.repeat(64),
    files: {},
  })
  expect(parsed.components).toEqual(['codex'])
})
