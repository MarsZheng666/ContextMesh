import {
  upgrade,
  rollback,
} from '../../packages/runtime-manager/src/upgrade.js'
import { spawn } from 'node:child_process'
import {
  installBundle,
  selection,
} from '../../packages/runtime-manager/src/install.js'
import {
  inventory,
  sha256,
  verifyBundle,
} from '../../packages/runtime-manager/src/manifest.js'
import { installCodexPanel } from '../../apps/cli/src/codex-panel-install.js'
import { it, expect, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createConnection } from 'node:net'
import {
  privateDirectory,
  atomicJson,
} from '../../packages/runtime-manager/src/files.js'
import {
  powershell,
  windowsPrivatePath,
} from '../../packages/platform/src/windows.js'
import {
  listenLocal,
  callLocal,
  controlSocketPath,
} from '../../packages/handoff-deepseek/src/local-control.js'
import { windowsFolderScript } from '../../apps/cli/src/codex-panel-windows-folder.js'

const windowsTest = it.skipIf(process.platform !== 'win32')
windowsTest(
  'protects native files with ACLs and atomically replaces Unicode JSON',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cm-win-')),
      dir = join(root, '中文 & % data')
    try {
      await privateDirectory(dir)
      await atomicJson(join(dir, 'state.json'), { title: '你好', cursor: 1 })
      await atomicJson(join(dir, 'state.json'), { title: '你好', cursor: 2 })
      expect(
        JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')),
      ).toEqual({ title: '你好', cursor: 2 })
      await windowsPrivatePath(join(dir, 'state.json'))
      const exposed = join(dir, 'exposed.json')
      await writeFile(exposed, 'fixture only')
      await powershell(
        `$acl=Get-Acl -LiteralPath $env:CM_TEST_PATH
$id=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($id,'Read','Allow'))
Set-Acl -LiteralPath $env:CM_TEST_PATH -AclObject $acl`,
        { CM_TEST_PATH: exposed },
      )
      await expect(windowsPrivatePath(exposed)).rejects.toThrow('private NTFS')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60000,
)

windowsTest(
  'authenticates both ends of a native pipe, rejects unauthenticated writes and reconnects',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cm-pipe-')),
      dir = join(root, 'state')
    await privateDirectory(dir)
    let calls = 0
    let listener = await listenLocal(dir, async (command) => {
      calls++
      return command
    })
    try {
      const path = await controlSocketPath(dir)
      expect(path).toMatch(/^\\\\\.\\pipe\\contextmesh-/)
      expect(await callLocal(dir, { title: '中文', cursor: 3 })).toEqual({
        ok: true,
        value: { title: '中文', cursor: 3 },
      })
      await expect(listenLocal(dir, async () => 'wrong')).rejects.toThrow(
        'Another ContextMesh controller',
      )
      await new Promise<void>((accept, reject) => {
        const socket = createConnection(path)
        socket.once('error', reject)
        socket.once('data', () =>
          socket.end(
            JSON.stringify({ payload: '{}', proof: '0'.repeat(64) }) + '\n',
          ),
        )
        socket.once('close', () => accept())
      })
      expect(calls).toBe(1)
      await listener.close()
      listener = await listenLocal(dir, async () => 'restarted')
      expect(await callLocal(dir, {})).toEqual({ ok: true, value: 'restarted' })
    } finally {
      await listener.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  60000,
)

windowsTest(
  'compiles the Windows common folder dialog without opening UI in CI',
  async () => {
    const compileOnly =
      windowsFolderScript.slice(0, windowsFolderScript.indexOf('$folder =')) +
      '[ContextMeshFolder].FullName'
    expect((await powershell(compileOnly)).stdout.trim()).toBe(
      'ContextMeshFolder',
    )
  },
  60000,
)

windowsTest(
  'installs a relocatable native runtime and one panel, with lossless hook stdin',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cm-native-install-')),
      bundle = join(root, 'bundle'),
      home = join(root, "用户 A & % ! '"),
      codexHome = join(root, 'codex')
    try {
      await mkdir(join(bundle, 'bin'), { recursive: true })
      await mkdir(join(bundle, 'app/dist'), { recursive: true })
      await cp(process.execPath, join(bundle, 'bin/node.exe'))
      await writeFile(join(bundle, 'bin/contextmesh.cmd'), '@echo off\r\n')
      await writeFile(join(bundle, 'app/package.json'), '{"type":"module"}')
      await writeFile(
        join(bundle, 'app/dist/cli.js'),
        `let body='';for await(const chunk of process.stdin)body+=chunk;console.log(JSON.stringify({args:process.argv.slice(2),body,home:process.env.CONTEXTMESH_HOME,codexHome:process.env.CODEX_HOME}));`,
      )
      const manifest = JSON.stringify({
        format: 1,
        version: '0.8.0-dev.18',
        platform: 'win32-x64',
        components: ['codex'],
        node: process.version,
        dsh: '0.2.1-rc.3',
        protocol: 1,
        schema: 10,
        minSchema: 8,
        maxSchema: 10,
        sourceCommit: 'a'.repeat(40),
        lockHash: 'b'.repeat(64),
        patchHash: 'c'.repeat(64),
        files: await inventory(bundle),
      })
      await writeFile(join(bundle, 'manifest.json'), manifest)
      await installBundle(bundle, home, sha256(manifest))
      expect((await selection(home))?.version).toBe('0.8.0-dev.18')
      await expect(installBundle(bundle, home)).rejects.toThrow(
        'Already installed',
      )
      const registry = join(root, 'registry.jsonl'),
        preload = join(root, 'register.cjs')
      await writeFile(
        preload,
        `if(process.argv[1]==='plugin'){require('fs').appendFileSync(process.env.CM_REGISTRY,JSON.stringify(process.argv.slice(2))+'\\n');console.log('{}');process.exit(0)}`,
      )
      vi.stubEnv('CONTEXTMESH_HOME', home)
      vi.stubEnv('CODEX_HOME', codexHome)
      vi.stubEnv('CM_REGISTRY', registry)
      vi.stubEnv('NODE_OPTIONS', '--require ' + JSON.stringify(preload))
      await installCodexPanel(process.execPath)
      const plugin = join(home, 'data/codex-panel/plugins/contextmesh')
      const mcp = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'))
        .mcpServers.contextmesh
      expect(
        Object.keys(
          JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'))
            .mcpServers,
        ),
      ).toEqual(['contextmesh'])
      expect(mcp.command).toBe(join(home, 'bootstrap/node.exe'))
      expect(mcp.args.slice(1)).toEqual(['codex', 'panel-mcp'])
      const hook = JSON.parse(
        await readFile(join(plugin, 'hooks/hooks.json'), 'utf8'),
      ).hooks.Stop[0].hooks[0]
      const script = Buffer.from(
        hook.commandWindows.split(' ').at(-1),
        'base64',
      ).toString('utf16le')
      expect(script).toContain('sync-hook')
      const payload = JSON.stringify({
        session_id: 'fixture',
        cwd: 'C:\\中文 & %',
        prompt: '你好',
      })
      const result = await new Promise<string>((accept, reject) => {
        const child = spawn(
          process.env.COMSPEC ?? 'cmd.exe',
          ['/d', '/s', '/c', '"' + hook.commandWindows + '"'],
          {
            windowsVerbatimArguments: true,
            windowsHide: true,
            stdio: 'pipe',
          },
        )
        let stdout = '',
          stderr = ''
        child.stdout.on('data', (chunk) => (stdout += String(chunk)))
        child.stderr.on('data', (chunk) => (stderr += String(chunk)))
        child.once('error', reject)
        child.once('exit', (code) =>
          code === 0 ? accept(stdout) : reject(new Error(stderr)),
        )
        child.stdin.end(payload)
      })
      const parsed = JSON.parse(result.trim())
      expect(parsed.args).toEqual(['codex', 'sync-hook'])
      expect(parsed.home).toBe(home)
      expect(parsed.codexHome).toBe(codexHome)
      expect(JSON.parse(parsed.body)).toEqual(JSON.parse(payload))
      expect(
        (await readFile(registry, 'utf8')).trim().split('\n'),
      ).toHaveLength(2)
      const next = join(root, 'next')
      await cp(bundle, next, { recursive: true })
      await writeFile(
        join(next, 'manifest.json'),
        JSON.stringify({ ...JSON.parse(manifest), version: '0.8.0-dev.19' }),
      )
      const journal = join(home, 'data', 'preserved.json')
      await atomicJson(journal, { cursor: 17 })
      const hooks = {
        running: async () => false,
        stop: async () => {},
        start: async () => {},
        health: async () => {},
      }
      expect((await upgrade(next, home, undefined, hooks)).phase).toBe(
        'verified',
      )
      expect((await selection(home))?.version).toBe('0.8.0-dev.19')
      await rollback(home, hooks)
      expect((await selection(home))?.version).toBe('0.8.0-dev.18')
      expect(JSON.parse(await readFile(journal, 'utf8'))).toEqual({
        cursor: 17,
      })
      await writeFile(join(bundle, 'app/dist/cli.js'), 'tampered')
      await expect(verifyBundle(bundle)).rejects.toThrow('integrity')
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  },
  120000,
)
