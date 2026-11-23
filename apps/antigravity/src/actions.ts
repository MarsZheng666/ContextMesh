import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveSpool } from '../../../packages/adapter-codex/src/archive-spool.js'
import { ArchiveClient } from '../../../packages/client/src/archives.js'
import { MeshClient } from '../../../packages/client/src/index.js'
import { planArchiveResume } from '../../../packages/client/src/resume-archive.js'

export class AntigravityArchives {
  readonly archives: ArchiveClient
  constructor(private readonly mesh: MeshClient) {
    this.archives = new ArchiveClient(mesh)
  }

  async list(after?: string) {
    const page = await this.archives.list(after)
    return {
      entries: page.archives.map(({ id, manifest }) => ({
        id,
        title: manifest.header.title,
        source: manifest.header.source.adapter,
      })),
      next: page.next,
    }
  }

  async preview(id: string, query: string) {
    // Antigravity does not supply the active model's remaining capacity to an MCP App.
    const plan = await planArchiveResume(
      this.archives,
      id,
      {
        contextWindow: 16384,
        outputReserve: 4096,
        fixedTokens: 2048,
        route: 'antigravity',
      },
      { query },
    )
    return { title: plan.report.title, messages: plan.context.messages }
  }

  async publish(id: string, title: string, note: string) {
    const dir = await mkdtemp(join(tmpdir(), 'contextmesh-antigravity-'))
    try {
      const spool = new ArchiveSpool(dir, this.mesh.endpoint)
      await spool.prepare(async (append) => {
        await append({
          turn: 'handoff',
          role: 'user',
          kind: 'message',
          text: note,
        })
        return {
          version: 2,
          scope: 'text',
          title,
          source: {
            adapter: 'antigravity',
            id,
            incarnation: id,
            eventCount: 1,
          },
          interrupted: false,
          omittedAttachments: 0,
          unrecognizedItems: 0,
        }
      })
      return await spool.upload(this.archives)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
