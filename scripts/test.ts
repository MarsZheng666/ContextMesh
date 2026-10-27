import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Validate a fresh report independently so a zero exit code cannot hide
// failed tests or teardown errors.
const directory = await mkdtemp(join(tmpdir(), 'contextmesh-test-report-'))
const report = join(directory, 'result.json')
try {
  const child = spawn(
    process.execPath,
    [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      ...process.argv.slice(2),
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${report}`,
    ],
    { stdio: 'inherit' },
  )
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  let status: number | null
  try {
    status = await new Promise<number | null>((accept, reject) => {
      child.once('error', reject)
      child.once('exit', accept)
    })
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
  if (status !== 0) {
    process.exitCode = status ?? 1
  } else {
    const result = JSON.parse(await readFile(report, 'utf8')) as {
      success?: boolean
      numFailedTests?: number
      numFailedTestSuites?: number
      numTotalTests?: number
    }
    if (
      result.success !== true ||
      result.numFailedTests !== 0 ||
      result.numFailedTestSuites !== 0 ||
      !Number.isSafeInteger(result.numTotalTests) ||
      (result.numTotalTests ?? 0) < 1
    ) {
      throw new Error('Vitest reported failures or an incomplete test result')
    }
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await rm(directory, { recursive: true, force: true })
}
