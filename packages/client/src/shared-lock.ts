import { setTimeout } from 'node:timers/promises'
import { privateDirectory } from '../../runtime-manager/src/files.js'
import { listenLocal } from '../../handoff-deepseek/src/local-control.js'

/** Process-owned socket locks recover automatically after a crash. */
export async function withSharedLock<T>(
  directory: string,
  work: () => Promise<T>,
): Promise<T> {
  await privateDirectory(directory)
  let lock: Awaited<ReturnType<typeof listenLocal>> | undefined
  for (let attempt = 0; ; attempt++) {
    try {
      lock = await listenLocal(directory, async () => ({ busy: true }))
      break
    } catch (error) {
      if (
        attempt >= 200 ||
        !(error instanceof Error) ||
        !error.message.includes('Another ContextMesh controller')
      )
        throw error
      await setTimeout(50)
    }
  }
  try {
    return await work()
  } finally {
    await lock.close()
  }
}
