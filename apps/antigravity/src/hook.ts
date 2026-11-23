import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { AntigravityLive, dataRoot, hostSchema } from './live.js'
import { withSharedLock } from '../../../packages/client/src/shared-lock.js'
import {
  atomicJson,
  optionalJson,
} from '../../../packages/runtime-manager/src/files.js'
import { SharedClient } from '../../../packages/client/src/shared.js'
import { resolveConnection } from '../../../packages/client/src/config.js'
import { MeshClient } from '../../../packages/client/src/index.js'

const event = process.argv[2]
function block(message: string) {
  if (event === 'PreToolUse') return { decision: 'deny', reason: message }
  if (event === 'PreInvocation' || event === 'PostInvocation')
    return {
      terminationBehavior: 'terminate',
      injectSteps: [{ errorMessage: { userMessage: message } }],
    }
  return {}
}
async function hook() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  const payload = JSON.parse(text)
  if (!z.uuid().safeParse(payload?.conversationId).success) return {}
  const input = z
    .object({
      conversationId: z.uuid(),
      transcriptPath: z.string().optional(),
      error: z.string().optional(),
      terminationReason: z.string().optional(),
      lastUserInput: z.string().optional(),
      fullyIdle: z.boolean().optional(),
    })
    .parse(payload)
  const thread = input.conversationId
  const ticket = input.lastUserInput
    ?.trim()
    .match(/^ContextMesh transfer ([a-f0-9-]{36})(?:\n|$)/)?.[1]
  const data = dataRoot()
  if (
    !(await optionalJson(join(data, 'sources', thread + '.json'))) &&
    !(
      ticket &&
      z.uuid().safeParse(ticket).success &&
      (await optionalJson(join(data, 'tickets', ticket + '.json')))
    )
  ) {
    if (event === 'PreInvocation' || event === 'Stop') {
      await atomicJson(
        join(data, 'idle', thread + '.json'),
        event === 'Stop' && input.fullyIdle === true,
      )
    }
    return {}
  }
  const config = z
    .object({ path: z.string() })
    .parse(
      JSON.parse(await readFile(join(data, 'connection-path.json'), 'utf8')),
    )
  const conn = await resolveConnection({ configPath: config.path })
  if (!conn.endpoint || !conn.token)
    throw Error('Reconnect this device to ContextMesh.')
  const live = new AntigravityLive(
    new SharedClient(
      new MeshClient({
        endpoint: conn.endpoint,
        token: conn.token,
        retries: 0,
        timeoutMs: 5000,
      }),
    ),
  )
  return withSharedLock(join(data, 'lock', thread), async () => {
    const s = await live.source(thread)
    if (!s && ticket) {
      if (event === 'PreToolUse')
        return block('The receiving model is checking readiness.')
      if (
        event !== 'Stop' ||
        !input.fullyIdle ||
        input.error ||
        !['model_stop', 'NO_TOOL_CALL'].includes(input.terminationReason ?? '')
      )
        return {}
      if (!input.transcriptPath) throw Error('Missing native transcript')
      const transcript = resolve(
        input.transcriptPath.replace(/^~\//, homedir() + '/'),
      )
      const host = hostSchema.options.find((h) => {
        const logs = join(
          homedir(),
          '.gemini',
          h,
          'brain',
          thread,
          '.system_generated/logs',
        )
        return (
          transcript === join(logs, 'transcript.jsonl') ||
          transcript === join(logs, 'transcript_full.jsonl')
        )
      })
      if (!host) throw Error('Unknown Antigravity conversation location')
      const log = transcript.endsWith('transcript_full.jsonl')
        ? 'transcript_full.jsonl'
        : 'transcript.jsonl'
      const bytes = (await stat(transcript)).size
      const result = await withSharedLock(
        join(data, 'ticket-lock', ticket),
        () => live.accept(ticket, thread, host, bytes, log),
      ).catch(async (error) => {
        await atomicJson(join(data, 'issues', ticket + '.json'), {
          message:
            error instanceof Error
              ? error.message
              : 'Could not complete this transfer.',
        })
        throw error
      })
      if (!result || (!result.waiting && !result.interrupted)) return {}
      return {
        decision: 'continue',
        reason: result.waiting
          ? 'The source is finishing its tools. Reply READY without using tools while ContextMesh waits.'
          : 'ContextMesh has claimed this task. Continue with the history supplied at the next invocation.',
      }
    }
    if (
      s &&
      (await live.boundary(s, event ?? '', input.fullyIdle === true)) === 'stop'
    )
      return block(
        'The conversation is transferring. Continue on the receiving device.',
      )
    if (s?.pendingContinuation && event === 'PreInvocation') {
      const userMessage = s.pendingContinuation
      delete s.pendingContinuation
      await live.save(s)
      return { injectSteps: [{ userMessage }] }
    }
    return {}
  })
}
try {
  console.log(JSON.stringify(await hook()))
} catch (e) {
  console.log(
    JSON.stringify(
      block(
        e instanceof Error ? e.message : 'Check the ContextMesh connection.',
      ),
    ),
  )
}
