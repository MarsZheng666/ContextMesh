import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, win32 } from 'node:path'

export function windowsCodexCandidates(env: NodeJS.ProcessEnv) {
  return [
    ...(env.CODEX_INSTALL_DIR
      ? [win32.join(env.CODEX_INSTALL_DIR, 'codex.exe')]
      : []),
    ...(env.LOCALAPPDATA
      ? [win32.join(env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe')]
      : []),
    ...(env.PATH ?? env.Path ?? '')
      .split(';')
      .filter(Boolean)
      .map((part) => win32.join(part.replace(/^"|"$/g, ''), 'codex.exe')),
  ]
}
export async function findDesktopCodex(explicit?: string) {
  const override = explicit ?? process.env.CONTEXTMESH_CODEX_BIN
  const candidates = override
    ? [resolve(override)]
    : process.platform === 'win32'
      ? windowsCodexCandidates(process.env)
      : [
          '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
        ]
  for (const candidate of candidates) {
    if (
      process.platform === 'win32' &&
      !candidate.toLowerCase().endsWith('.exe')
    )
      continue
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      /* Try the next native executable, never a cmd shim or WSL. */
    }
  }
  throw new Error(
    'Install native Codex or use --codex-bin with its executable. Windows requires codex.exe and the same CODEX_HOME as Codex Desktop.',
  )
}
