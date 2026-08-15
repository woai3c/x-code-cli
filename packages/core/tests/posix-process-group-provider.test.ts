import { fileURLToPath } from 'node:url'

import { PosixProcessGroupProvider } from '../src/tools/shell-session/providers/posix-process-group.js'

const isPosix = process.platform !== 'win32'
const fixturePath = fileURLToPath(new URL('./fixtures/managed-shell-tree.mjs', import.meta.url))

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function fixtureCommand(behavior: 'root-exit' | 'force'): string {
  return `${shellQuote(process.execPath)} ${shellQuote(fixturePath)} parent ${behavior}`
}

async function pidFromOutput(chunks: Buffer[]): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const match = Buffer.concat(chunks).toString('utf8').match(/\d+/)
    if (match) return Number(match[0])
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('fixture did not report its descendant pid')
}

async function expectPidGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`descendant ${pid} remained live`)
}

describe.skipIf(!isPosix)('POSIX process-group shell provider', () => {
  it('retains and terminates the process group after its root exits first', async () => {
    const provider = new PosixProcessGroupProvider('/bin/sh')
    const attempt = provider.spawnManaged(fixtureCommand('root-exit'), {
      cwd: process.cwd(),
      buffer: false,
      isolatedProcessTree: true,
      tty: false,
    })
    const output: Buffer[] = []
    await attempt.ready
    attempt.activate((frame) => {
      if (frame.kind === 'output') output.push(Buffer.from(frame.chunk))
    })

    try {
      await attempt.handle.waitForRootExit()
      const descendantPid = await pidFromOutput(output)
      await expect(attempt.handle.probeTree()).resolves.toBe('live')

      const result = await attempt.handle.terminateTree('root-exited-residual', {
        gracefulMs: 1_000,
        forceMs: 1_000,
        confirmMs: 500,
      })

      expect(result.treeConfirmedExited).toBe(true)
      expect(result.gracefulAttempted).toBe(true)
      await expectPidGone(descendantPid)
    } finally {
      attempt.handle.forceTreeSync(performance.now() + 1_000)
    }
  }, 10_000)

  it('escalates from SIGTERM to SIGKILL when the group ignores graceful termination', async () => {
    const provider = new PosixProcessGroupProvider('/bin/sh')
    const attempt = provider.spawnManaged(fixtureCommand('force'), {
      cwd: process.cwd(),
      buffer: false,
      isolatedProcessTree: true,
      tty: false,
    })
    const output: Buffer[] = []
    await attempt.ready
    attempt.activate((frame) => {
      if (frame.kind === 'output') output.push(Buffer.from(frame.chunk))
    })

    try {
      const descendantPid = await pidFromOutput(output)
      const result = await attempt.handle.terminateTree('stop-command', {
        gracefulMs: 100,
        forceMs: 1_000,
        confirmMs: 500,
      })

      expect(result.treeConfirmedExited).toBe(true)
      expect(result.gracefulAttempted).toBe(true)
      expect(result.forceAttempted).toBe(true)
      await expectPidGone(descendantPid)
    } finally {
      attempt.handle.forceTreeSync(performance.now() + 1_000)
    }
  }, 10_000)
})
