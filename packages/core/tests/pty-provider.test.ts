import { fileURLToPath } from 'node:url'

import type { ManagedProcessFrame } from '../src/tools/shell-session/provider.js'
import { PtyShellProvider } from '../src/tools/shell-session/providers/pty.js'

const fixturePath = fileURLToPath(new URL('./fixtures/pty-repl.mjs', import.meta.url))
const managedTreeFixturePath = fileURLToPath(new URL('./fixtures/managed-shell-tree.mjs', import.meta.url))

function shellQuote(value: string): string {
  return process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
}

function fixtureCommand(mode: 'repl' | 'interrupt'): string {
  const command = `${shellQuote(process.execPath)} ${shellQuote(fixturePath)} ${mode}`
  return process.platform === 'win32' ? `& ${command}` : command
}

function managedTreeCommand(behavior: 'force' | 'root-exit' = 'force'): string {
  const command = `${shellQuote(process.execPath)} ${shellQuote(managedTreeFixturePath)} parent ${behavior}`
  return process.platform === 'win32' ? `& ${command}` : command
}

function outputText(frames: ManagedProcessFrame[]): string {
  return Buffer.concat(
    frames.filter((frame) => frame.kind === 'output').map((frame) => Buffer.from(frame.chunk)),
  ).toString('utf8')
}

async function waitForOutput(frames: ManagedProcessFrame[], pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const output = outputText(frames)
    if (pattern.test(output)) return output
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${pattern}; output was ${JSON.stringify(outputText(frames))}`)
}

async function waitForFrameCount(
  frames: ManagedProcessFrame[],
  kind: ManagedProcessFrame['kind'],
  count: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (frames.filter((frame) => frame.kind === kind).length >= count) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${count} ${kind} frames`)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 10_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
  ])
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
  throw new Error(`PTY descendant ${pid} remained live`)
}

describe('PTY shell provider', () => {
  it('supports interactive Unicode input, echo/output, resize, and normal exit', async () => {
    const provider = new PtyShellProvider()
    const attempt = provider.spawnManaged(fixtureCommand('repl'), {
      cwd: process.cwd(),
      buffer: false,
      isolatedProcessTree: true,
      tty: true,
      cols: 80,
      rows: 24,
    })
    const frames: ManagedProcessFrame[] = []
    const ready = await withTimeout(attempt.ready)
    attempt.activate((frame) => frames.push(frame))

    try {
      expect(ready.treeKind).toBe(process.platform === 'win32' ? 'windows-conpty' : 'posix-pty-process-group')
      expect(await waitForOutput(frames, /READY:true:true:80x24/)).toContain('READY:true:true:80x24')

      await attempt.handle.resize!(100, 35)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      await attempt.handle.write!('你好🌟\r')
      expect(await waitForOutput(frames, /VALUE:你好🌟/)).toContain('你好🌟')

      await attempt.handle.write!('size\r')
      expect(await waitForOutput(frames, /SIZE:100x35/)).toContain('SIZE:100x35')

      await attempt.handle.write!('exit\r')
      const status = await withTimeout(attempt.handle.waitForRootExit())
      await withTimeout(attempt.handle.waitForTreeExit())
      await waitForFrameCount(frames, 'stream-end', 2)
      expect(status.exitCode).toBe(0)
      const kinds = frames.map((frame) => frame.kind)
      expect(kinds.filter((kind) => kind === 'stream-end')).toHaveLength(2)
      expect(kinds.indexOf('root-exit')).toBeLessThan(kinds.indexOf('tree-exit'))
    } finally {
      attempt.handle.forceTreeSync(performance.now() + 1_000)
    }
  }, 20_000)

  it('delivers Ctrl+C as terminal control input and confirms the PTY tree exit', async () => {
    const provider = new PtyShellProvider()
    const attempt = provider.spawnManaged(fixtureCommand('interrupt'), {
      cwd: process.cwd(),
      buffer: false,
      isolatedProcessTree: true,
      tty: true,
    })
    const frames: ManagedProcessFrame[] = []
    await withTimeout(attempt.ready)
    attempt.activate((frame) => frames.push(frame))

    try {
      await waitForOutput(frames, /READY:true:true/)
      await attempt.handle.write!('\u0003')
      await withTimeout(attempt.handle.waitForTreeExit())
      expect(await waitForOutput(frames, /INTERRUPTED/)).toContain('INTERRUPTED')
    } finally {
      attempt.handle.forceTreeSync(performance.now() + 1_000)
    }
  }, 20_000)

  it('terminates and confirms descendants through the managed PTY tree boundary', async () => {
    const provider = new PtyShellProvider()
    const attempt = provider.spawnManaged(managedTreeCommand(), {
      cwd: process.cwd(),
      buffer: false,
      isolatedProcessTree: true,
      tty: true,
    })
    const frames: ManagedProcessFrame[] = []
    await withTimeout(attempt.ready)
    attempt.activate((frame) => frames.push(frame))

    try {
      const output = await waitForOutput(frames, /DESCENDANT:\d+/)
      const descendantPid = Number(output.match(/DESCENDANT:(\d+)/)?.[1])
      expect(descendantPid).toBeGreaterThan(0)

      const result = await attempt.handle.terminateTree('stop-command', {
        gracefulMs: 300,
        forceMs: 2_000,
        confirmMs: 1_000,
      })

      expect(result.treeConfirmedExited).toBe(true)
      await expectPidGone(descendantPid)
    } finally {
      attempt.handle.forceTreeSync(performance.now() + 1_000)
    }
  }, 20_000)

  // A Windows Job must keep tracking descendants after the ConPTY root exits.
  // POSIX PTYs instead use a process-group boundary and terminal close may reap
  // that group with SIGHUP, so the equivalent contract is covered above.
  it.runIf(process.platform === 'win32')(
    'does not confirm a PTY tree when the root exits before a detached descendant',
    async () => {
      const provider = new PtyShellProvider()
      const attempt = provider.spawnManaged(managedTreeCommand('root-exit'), {
        cwd: process.cwd(),
        buffer: false,
        isolatedProcessTree: true,
        tty: true,
      })
      const frames: ManagedProcessFrame[] = []
      await withTimeout(attempt.ready)
      attempt.activate((frame) => frames.push(frame))

      try {
        const output = await waitForOutput(frames, /DESCENDANT:\d+/)
        const descendantPid = Number(output.match(/DESCENDANT:(\d+)/)?.[1])
        expect(descendantPid).toBeGreaterThan(0)

        await withTimeout(attempt.handle.waitForRootExit())
        expect(await attempt.handle.probeTree()).toBe('live')

        const result = await attempt.handle.terminateTree('root-exited-residual', {
          gracefulMs: 300,
          forceMs: 2_000,
          confirmMs: 1_000,
        })

        expect(result.treeConfirmedExited).toBe(true)
        await withTimeout(attempt.handle.waitForTreeExit())
        await expectPidGone(descendantPid)
        const kinds = frames.map((frame) => frame.kind)
        expect(kinds.indexOf('root-exit')).toBeLessThan(kinds.indexOf('tree-exit'))
      } finally {
        attempt.handle.forceTreeSync(performance.now() + 1_000)
      }
    },
    20_000,
  )
})
