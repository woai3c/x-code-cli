import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import path from 'node:path'

import {
  WindowsJobObjectProvider,
  resolveWindowsSupervisorArtifact,
  resolveWindowsSupervisorNativeRoot,
} from '../src/tools/shell-session/providers/windows-job.js'
import {
  defaultWindowsPowerShellExecutable,
  powerShellCommandLine,
} from '../src/tools/shell-session/providers/windows-powershell.js'
import {
  WindowsSupervisorFrameDecoder,
  WindowsSupervisorFrameKind,
  encodeWindowsSupervisorLaunch,
} from '../src/tools/shell-session/providers/windows-supervisor-protocol.js'

const isWindows = process.platform === 'win32'

describe('Windows supervisor artifact boundary', () => {
  it('resolves only deterministic package-local native directories', () => {
    const coreRoot = path.resolve('virtual', 'core')
    expect(
      resolveWindowsSupervisorNativeRoot(
        path.join(coreRoot, 'src', 'tools', 'shell-session', 'providers', 'windows-job.ts'),
      ),
    ).toBe(path.join(coreRoot, 'dist', 'native', 'windows'))
    expect(
      resolveWindowsSupervisorNativeRoot(
        path.join(coreRoot, 'dist', 'tools', 'shell-session', 'providers', 'windows-job.js'),
      ),
    ).toBe(path.join(coreRoot, 'dist', 'native', 'windows'))

    const cliBundle = path.resolve('virtual', 'cli', 'dist', 'cli.js')
    expect(resolveWindowsSupervisorNativeRoot(cliBundle)).toBe(path.join(path.dirname(cliBundle), 'native', 'windows'))

    const cliChunk = path.resolve('virtual', 'cli', 'dist', 'chunks', 'chunk-ABC123.js')
    expect(resolveWindowsSupervisorNativeRoot(cliChunk)).toBe(
      path.join(path.dirname(path.dirname(cliChunk)), 'native', 'windows'),
    )
    expect(() => resolveWindowsSupervisorNativeRoot(path.resolve('virtual', 'other', 'chunk.js'))).toThrow(
      /unsupported package layout/,
    )
  })

  it('does not report a pending artifact resolution as an absent process tree', async () => {
    let resolveArtifact!: (artifact: { executablePath: string; sha256: string }) => void
    const artifact = new Promise<{ executablePath: string; sha256: string }>((resolve) => {
      resolveArtifact = resolve
    })
    const provider = new WindowsJobObjectProvider({ artifact })
    const attempt = provider.spawnManaged('Write-Output "never-started"', {
      cwd: process.cwd(),
      buffer: false,
      isolatedProcessTree: true,
      tty: false,
    })
    const readyFailure = attempt.ready.then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(await attempt.handle.probeTree()).not.toBe('confirmed-exited')
    const cleanup = await attempt.cancelBeforeReady('stop-command')
    expect(cleanup.treeConfirmedExited).toBe(true)
    expect(await attempt.handle.probeTree()).toBe('confirmed-exited')

    resolveArtifact({ executablePath: 'not-used-after-cancellation.exe', sha256: '0'.repeat(64) })
    expect(await readyFailure).toBeInstanceOf(Error)
  })
})

function withTimeout<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ])
}

interface SupervisorFrame {
  kind: number
  payload: Buffer
}

async function waitForSupervisorFrame(
  frames: SupervisorFrame[],
  kind: number,
  predicate: (payload: Buffer) => boolean = () => true,
): Promise<SupervisorFrame> {
  return withTimeout(
    new Promise((resolve) => {
      const find = () => {
        const frame = frames.find((candidate) => candidate.kind === kind && predicate(candidate.payload))
        if (frame) return resolve(frame)
        setTimeout(find, 10)
      }
      find()
    }),
  )
}

async function waitForSupervisorOutput(frames: SupervisorFrame[], pattern: RegExp): Promise<string> {
  return withTimeout(
    new Promise((resolve) => {
      const find = () => {
        const output = Buffer.concat(
          frames
            .filter((candidate) => candidate.kind === WindowsSupervisorFrameKind.stdout)
            .map((candidate) => candidate.payload),
        ).toString('utf8')
        if (pattern.test(output)) return resolve(output)
        setTimeout(find, 10)
      }
      find()
    }),
  )
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
  throw new Error(`Job descendant ${pid} remained live`)
}

describe.skipIf(!isWindows)('Windows Job Object shell provider', () => {
  it('confirms that an asynchronous helper ENOENT created no cleanup target', async () => {
    const provider = new WindowsJobObjectProvider({
      artifact: {
        executablePath: `${process.cwd()}\\missing-shell-supervisor-${process.pid}.exe`,
        sha256: '0'.repeat(64),
      },
    })
    const attempt = provider.spawnManaged('Write-Output "never-started"', {
      cwd: process.cwd(),
      buffer: false,
      isolatedProcessTree: true,
      tty: false,
    })

    await expect(withTimeout(attempt.ready)).rejects.toMatchObject({ code: 'ENOENT' })
    const cleanup = await attempt.cancelBeforeReady('spawn-failure-cleanup')

    expect(cleanup.treeConfirmedExited).toBe(true)
    expect(cleanup.rootExited).toBe(false)
    expect(await attempt.handle.probeTree()).toBe('confirmed-exited')
  })

  it('settles cancellation that races an asynchronous helper ENOENT', async () => {
    const provider = new WindowsJobObjectProvider({
      artifact: {
        executablePath: `${process.cwd()}\\missing-shell-supervisor-race-${process.pid}.exe`,
        sha256: '0'.repeat(64),
      },
    })
    const attempt = provider.spawnManaged('Write-Output "never-started"', {
      cwd: process.cwd(),
      buffer: false,
      isolatedProcessTree: true,
      tty: false,
    })
    const readyFailure = withTimeout(attempt.ready).then(
      () => undefined,
      (error: unknown) => error,
    )
    await Promise.resolve()

    const cleanup = await withTimeout(attempt.cancelBeforeReady('turn-abort-before-ready'))

    expect(cleanup.treeConfirmedExited).toBe(true)
    expect(cleanup.rootExited).toBe(false)
    expect(await readyFailure).toBeInstanceOf(Error)
    expect(await attempt.handle.probeTree()).toBe('confirmed-exited')
  })

  it('verifies the packaged supervisor and reports ready before ordered process frames', async () => {
    const artifact = await resolveWindowsSupervisorArtifact()
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)

    const provider = new WindowsJobObjectProvider({ artifact })
    const attempt = provider.spawnManaged('Write-Output "provider-ok"', {
      cwd: process.cwd(),
      buffer: false,
      isolatedProcessTree: true,
      tty: false,
    })
    const frames: Array<{ kind: string; chunk?: Uint8Array }> = []
    const ready = await withTimeout(attempt.ready)
    expect(ready.treeKind).toBe('windows-job-object')
    expect(ready.rootPid).toBeGreaterThan(0)

    attempt.activate((frame) => frames.push(frame))
    await withTimeout(attempt.handle.waitForTreeExit())
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(
      Buffer.concat(frames.filter((frame) => frame.kind === 'output').map((frame) => frame.chunk!)).toString('utf8'),
    ).toContain('provider-ok')
    const kinds = frames.map((frame) => frame.kind)
    expect(kinds.at(-1)).toBe('tree-exit')
    expect(kinds.indexOf('root-exit')).toBeGreaterThan(-1)
    expect(kinds.indexOf('root-exit')).toBeLessThan(kinds.indexOf('tree-exit'))
    expect(kinds.filter((kind) => kind === 'stream-end')).toHaveLength(2)
    expect(kinds.lastIndexOf('output')).toBeLessThan(kinds.indexOf('tree-exit'))
  }, 20_000)

  it('terminates a Job descendant after the PowerShell root exits', async () => {
    const provider = new WindowsJobObjectProvider({ artifact: await resolveWindowsSupervisorArtifact() })
    const command =
      "$p = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30'; Write-Output $p.Id"
    const attempt = provider.spawnManaged(command, {
      cwd: process.cwd(),
      buffer: false,
      isolatedProcessTree: true,
      tty: false,
    })
    const output: Buffer[] = []
    await withTimeout(attempt.ready)
    attempt.activate((frame) => {
      if (frame.kind === 'output') output.push(Buffer.from(frame.chunk))
    })
    await withTimeout(attempt.handle.waitForRootExit())

    const result = await attempt.handle.terminateTree('root-exited-residual', {
      gracefulMs: 200,
      forceMs: 1_000,
      confirmMs: 500,
    })

    expect(result.treeConfirmedExited).toBe(true)
    const childPid = Number(Buffer.concat(output).toString('utf8').trim().match(/\d+/)?.[0])
    expect(childPid).toBeGreaterThan(0)
    expect(() => process.kill(childPid, 0)).toThrow()
  }, 20_000)

  it('keeps redirected PowerShell errors textual instead of emitting CLIXML', async () => {
    const provider = new WindowsJobObjectProvider({ artifact: await resolveWindowsSupervisorArtifact() })
    const attempt = provider.spawnManaged('Write-Error "job-error"', {
      cwd: process.cwd(),
      buffer: false,
      isolatedProcessTree: true,
      tty: false,
    })
    const output: Buffer[] = []
    await withTimeout(attempt.ready)
    attempt.activate((frame) => {
      if (frame.kind === 'output') output.push(Buffer.from(frame.chunk))
    })
    await withTimeout(attempt.handle.waitForTreeExit())

    const text = Buffer.concat(output).toString('utf8')
    expect(text).toContain('job-error')
    expect(text).not.toContain('CLIXML')
    expect(text).not.toContain('\uFFFD')
  }, 20_000)

  it('kills remaining Job descendants when the supervisor control pipe closes', async () => {
    const artifact = await resolveWindowsSupervisorArtifact()
    const executable = defaultWindowsPowerShellExecutable()
    const command =
      "$p = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30'; Write-Output $p.Id"
    const helper: ChildProcessWithoutNullStreams = spawn(artifact.executablePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const frames: SupervisorFrame[] = []
    const decoder = new WindowsSupervisorFrameDecoder()
    const helperExit = new Promise<void>((resolve) => helper.once('exit', () => resolve()))
    let childPid = 0
    helper.stdout.on('data', (chunk: Buffer) => {
      frames.push(...decoder.push(chunk))
    })

    try {
      helper.stdin.write(
        encodeWindowsSupervisorLaunch({
          cwd: process.cwd(),
          application: executable,
          commandLine: powerShellCommandLine(executable, command),
        }),
      )
      await waitForSupervisorFrame(frames, WindowsSupervisorFrameKind.ready)
      const output = await waitForSupervisorOutput(frames, /\d+\r?\n/)
      childPid = Number(output.match(/\d+/)?.[0])
      expect(childPid).toBeGreaterThan(0)
      await waitForSupervisorFrame(frames, WindowsSupervisorFrameKind.rootExit)
      expect(() => process.kill(childPid, 0)).not.toThrow()

      helper.stdin.end()
      await waitForSupervisorFrame(frames, WindowsSupervisorFrameKind.treeEmpty)
      await expectPidGone(childPid)
      await withTimeout(helperExit)
    } finally {
      helper.stdin.destroy()
      helper.kill()
      if (childPid > 0) {
        try {
          process.kill(childPid)
        } catch {
          // The expected Job kill already removed the descendant.
        }
      }
    }
  }, 20_000)
})
