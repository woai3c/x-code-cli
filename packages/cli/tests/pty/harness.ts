import { Terminal } from '@xterm/headless'
import * as pty from 'node-pty'

import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { CLI_BIN, isolatedCliEnv, waitFor } from '../fixtures/cli-test-helpers.js'
import type { TestWorkspace } from '../fixtures/cli-test-helpers.js'
import type { FakeProvider } from '../fixtures/fake-provider-server.js'
import { lastPromptLine, screenText, terminalScreen } from './screen.js'

const EXIT_MARKER = '__X_CODE_CLI_EXIT__:'
const require = createRequire(import.meta.url)

const KEY_BYTES: Record<string, string> = {
  enter: '\r',
  escape: '\x1b',
  'ctrl-c': '\x03',
  'ctrl-u': '\x15',
  'ctrl-home': '\x1b[1;5H',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  backspace: '\x7f',
  delete: '\x1b[3~',
  tab: '\t',
}

export interface CliExit {
  exitCode: number | null
  signal: string | null
}

export interface TuiHarness {
  startCli(args?: string[]): Promise<void>
  write(text: string): void
  key(name: keyof typeof KEY_BYTES): void
  paste(text: string): void
  resize(columns: number, rows: number): void
  waitForText(text: string | RegExp, timeoutMs?: number): Promise<void>
  waitForScreen(predicate: (screen: string) => boolean, description: string, timeoutMs?: number): Promise<void>
  settle(): Promise<void>
  screen(): string[]
  text(): string
  raw(): string
  waitForCliExit(timeoutMs?: number): Promise<CliExit>
  shellProbe(timeoutMs?: number): Promise<string>
  dispose(): Promise<void>
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

async function seedHarnessState(workspace: TestWorkspace, seedTheme: boolean): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(path.resolve(CLI_BIN, '..', '..', 'package.json'), 'utf-8')) as {
    version: string
  }
  const cacheDir = path.join(workspace.xcodeHome, 'cache')
  await fs.mkdir(cacheDir, { recursive: true })
  await fs.writeFile(
    path.join(cacheDir, 'update-check.json'),
    JSON.stringify({ checkedAt: Date.now(), latest: manifest.version }),
    'utf-8',
  )
  if (seedTheme) {
    await fs.writeFile(path.join(workspace.xcodeHome, 'config.json'), JSON.stringify({ theme: 'dark' }), 'utf-8')
  }
}

async function ensureNodePtyHelperExecutable(): Promise<void> {
  if (process.platform === 'win32') return
  const packageRoot = path.dirname(require.resolve('node-pty/package.json'))
  const helper = path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  // pnpm's content-addressed copy can lose the executable bit carried by the
  // node-pty tarball on macOS. The native addon then reports only the opaque
  // "posix_spawnp failed" at runtime even though installation succeeded.
  await fs.chmod(helper, 0o755).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

export async function createTuiHarness(options: {
  workspace: TestWorkspace
  provider: Pick<FakeProvider, 'baseUrl'>
  columns?: number
  rows?: number
  env?: NodeJS.ProcessEnv
  seedTheme?: boolean
}): Promise<TuiHarness> {
  await seedHarnessState(options.workspace, options.seedTheme !== false)
  await ensureNodePtyHelperExecutable()
  let columns = options.columns ?? 100
  let rows = options.rows ?? 32
  const terminal = new Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 5000 })
  const env = stringEnv(
    isolatedCliEnv(options.workspace, options.provider, {
      TERM_PROGRAM: process.env.TERM_PROGRAM,
      WT_SESSION: process.env.WT_SESSION,
      ...options.env,
    }),
  )
  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'powershell.exe' : '/bin/sh'
  const shellArgs = isWindows ? ['-NoLogo', '-NoProfile', '-NoExit'] : ['-f', '-i']
  if (!isWindows) env.PS1 = ''

  const processUnderTest = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: columns,
    rows,
    cwd: options.workspace.cwd,
    env,
    // The DLL-backed ConPTY path avoids the console-list helper, which cannot
    // AttachConsole during teardown on headless Windows runners.
    ...(isWindows ? { useConpty: true, useConptyDll: true } : {}),
  })
  let raw = ''
  let disposed = false
  let writeChain = Promise.resolve()
  let cliStarted = false
  let processExited = false
  let resolveProcessExit!: () => void
  const processExit = new Promise<void>((resolve) => {
    resolveProcessExit = resolve
  })

  const dataDisposable = processUnderTest.onData((data) => {
    raw += data
    writeChain = writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          terminal.write(data, resolve)
        }),
    )
  })
  const exitDisposable = processUnderTest.onExit(() => {
    processExited = true
    resolveProcessExit()
  })

  const waitForRendered = async (): Promise<void> => {
    await writeChain
  }

  const waitForTerminalQuiet = async (quietMs = 40): Promise<void> => {
    let observedLength = raw.length
    let unchangedSince = Date.now()
    await waitFor(
      async () => {
        await waitForRendered()
        if (raw.length !== observedLength) {
          observedLength = raw.length
          unchangedSince = Date.now()
        }
        return Date.now() - unchangedSince >= quietMs
      },
      'terminal output to settle',
      2000,
    )
  }

  const promptLine = (): string => lastPromptLine(terminalScreen(terminal))

  const waitForInputReady = async (): Promise<void> => {
    const probe = 'q'
    const deadline = Date.now() + 5000
    while (!promptLine().endsWith(` ${probe}`)) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for interactive stdin listener')
      processUnderTest.write(probe)
      await waitForRendered()
      await waitFor(
        async () => {
          await waitForRendered()
          return promptLine().endsWith(` ${probe}`)
        },
        'one input readiness probe attempt',
        100,
      ).catch(() => undefined)
    }
    await waitForTerminalQuiet()
    while (promptLine().includes(probe)) {
      const before = promptLine()
      while (promptLine() === before) {
        if (Date.now() >= deadline) throw new Error('Timed out cleaning up the input readiness probe')
        processUnderTest.write(KEY_BYTES.backspace)
        await waitForRendered()
        await waitFor(
          async () => {
            await waitForRendered()
            return promptLine() !== before
          },
          'one input readiness cleanup attempt',
          100,
        ).catch(() => undefined)
      }
      await waitForTerminalQuiet()
    }
  }

  const harness: TuiHarness = {
    startCli: async (args = []) => {
      if (cliStarted) throw new Error('This PTY harness already started a CLI process')
      cliStarted = true
      const cliArgs = ['--no-plugins', '--no-hooks', ...args]
      const values = [process.execPath, CLI_BIN, ...cliArgs]
      const command = isWindows
        ? `& ${values.map(powershellQuote).join(' ')}; Write-Output "${EXIT_MARKER}$LASTEXITCODE"\r`
        : `${values.map(posixQuote).join(' ')}; __x_code_status=$?; printf '\\n${EXIT_MARKER}%s\\n' "$__x_code_status"\n`
      processUnderTest.write(command)
      await waitFor(() => raw.includes('test-model'), 'CLI header', 10_000)
      await waitFor(
        async () => {
          await waitForRendered()
          return lastPromptLine(terminalScreen(terminal)) !== ''
        },
        'interactive input prompt',
        10_000,
      )
      await waitForRendered()
      await waitForTerminalQuiet()
      if (options.seedTheme !== false) await waitForInputReady()
      await waitForTerminalQuiet()
    },
    write: (text) => processUnderTest.write(text),
    key: (name) => processUnderTest.write(KEY_BYTES[name]),
    paste: (text) => processUnderTest.write(`\x1b[200~${text}\x1b[201~`),
    resize: (nextColumns, nextRows) => {
      columns = nextColumns
      rows = nextRows
      processUnderTest.resize(columns, rows)
      terminal.resize(columns, rows)
    },
    waitForText: async (expected, timeoutMs = 5000) => {
      await waitFor(
        async () => {
          await waitForRendered()
          const rendered = `${raw}\n${screenText(terminal)}`
          return typeof expected === 'string' ? rendered.includes(expected) : expected.test(rendered)
        },
        `PTY text ${String(expected)}`,
        timeoutMs,
      )
      await waitForTerminalQuiet()
    },
    waitForScreen: async (predicate, description, timeoutMs = 5000) => {
      await waitFor(
        async () => {
          await waitForRendered()
          return predicate(screenText(terminal))
        },
        description,
        timeoutMs,
      )
      await waitForTerminalQuiet()
    },
    settle: () => waitForTerminalQuiet(),
    screen: () => terminalScreen(terminal),
    text: () => screenText(terminal),
    raw: () => raw,
    waitForCliExit: async (timeoutMs = 10_000) => {
      const exitPattern = new RegExp(`${EXIT_MARKER}(-?\\d+)`)
      if (isWindows) {
        const before = raw.length
        await waitFor(() => raw.slice(before).includes('\x1b[?1049l'), 'CLI terminal restoration', timeoutMs)
        await waitForTerminalQuiet()
        return { exitCode: 0, signal: null }
      }
      await waitFor(() => exitPattern.test(raw), 'CLI exit marker', timeoutMs)
      const match = raw.match(exitPattern)
      return { exitCode: match ? Number(match[1]) : null, signal: null }
    },
    shellProbe: async (timeoutMs = 5000) => {
      const marker = `__X_CODE_SHELL_OK_${Date.now()}__`
      const before = raw.length
      const windowsProbe = `Write-Output (${powershellQuote(marker.slice(0, -2))} + ${powershellQuote(marker.slice(-2))})\r`
      processUnderTest.write(isWindows ? windowsProbe : `printf '${marker}\\n'\n`)
      await waitFor(() => raw.slice(before).includes(marker), 'post-CLI shell marker', timeoutMs)
      await waitForRendered()
      return raw.slice(before)
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      dataDisposable.dispose()
      try {
        processUnderTest.kill()
      } catch {
        // PTY may already be closed after a failed launch.
      }
      if (!processExited) {
        const timeout = setTimeout(resolveProcessExit, 2000)
        await processExit
        clearTimeout(timeout)
      }
      exitDisposable.dispose()
      terminal.dispose()
    },
  }

  return harness
}
