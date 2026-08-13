import { spawn } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FakeProvider } from './fake-provider-server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
export const CLI_BIN = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli.js')

const PASSTHROUGH_ENV = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'SHELL',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
] as const

export interface TestWorkspace {
  cwd: string
  xcodeHome: string
  cleanup(): Promise<void>
}

export interface CliRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
}

export interface CliProcess {
  pid: number | undefined
  stdout(): string
  stderr(): string
  kill(signal?: NodeJS.Signals): boolean
  wait(): Promise<CliRunResult>
}

export function assertCliBuilt(cliBin = CLI_BIN): void {
  if (!fsSync.existsSync(cliBin)) throw new Error(`CLI binary not found at ${cliBin}; run pnpm build first`)
}

export async function createTestWorkspace(prefix = 'xc-release-test-'): Promise<TestWorkspace> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const xcodeHome = path.join(cwd, '.x-code-home')
  await fs.mkdir(xcodeHome, { recursive: true })
  return {
    cwd,
    xcodeHome,
    cleanup: () => fs.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  }
}

export function isolatedCliEnv(
  workspace: Pick<TestWorkspace, 'cwd' | 'xcodeHome'>,
  provider?: Pick<FakeProvider, 'baseUrl'>,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, {
    INIT_CWD: workspace.cwd,
    X_CODE_HOME: workspace.xcodeHome,
    NODE_ENV: 'test',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: env.TERM ?? 'xterm-256color',
    ...overrides,
  })
  if (provider) {
    env.OPENAI_COMPATIBLE_API_KEY = 'test-key'
    env.OPENAI_COMPATIBLE_BASE_URL = provider.baseUrl
    env.X_CODE_MODEL = 'custom:test-model'
  }
  return env
}

export function spawnCli(options: {
  cwd: string
  env: NodeJS.ProcessEnv
  args: string[]
  cliBin?: string
  timeoutMs?: number
}): CliProcess {
  const cliBin = options.cliBin ?? CLI_BIN
  assertCliBuilt(cliBin)
  const startedAt = Date.now()
  const child = spawn(process.execPath, [cliBin, ...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (value: Buffer) => {
    stdout += value.toString('utf-8')
  })
  child.stderr.on('data', (value: Buffer) => {
    stderr += value.toString('utf-8')
  })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 2000).unref()
  }, options.timeoutMs ?? 20_000)
  timeout.unref()

  const result = new Promise<CliRunResult>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout)
      if (timedOut) stderr += '\n[test harness] process timed out'
      resolve({ stdout, stderr, exitCode, signal, durationMs: Date.now() - startedAt })
    })
  })
  return {
    pid: child.pid,
    stdout: () => stdout,
    stderr: () => stderr,
    kill: (signal = 'SIGTERM') => child.kill(signal),
    wait: () => result,
  }
}

export function runPrintCli(options: {
  workspace: TestWorkspace
  provider?: Pick<FakeProvider, 'baseUrl'>
  prompt?: string
  env?: NodeJS.ProcessEnv
  args?: string[]
  cliBin?: string
  timeoutMs?: number
}): Promise<CliRunResult> {
  return spawnCli({
    cwd: options.workspace.cwd,
    env: isolatedCliEnv(options.workspace, options.provider, options.env),
    args: [
      '--print',
      '--no-plugins',
      '--no-hooks',
      '--max-turns',
      '4',
      ...(options.args ?? []),
      options.prompt ?? 'hi',
    ],
    ...(options.cliBin ? { cliBin: options.cliBin } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  }).wait()
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function readSessionJsonl(cwd: string): Promise<unknown[]> {
  const dir = path.join(cwd, '.x-code', 'sessions')
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort()
  if (names.length === 0) throw new Error(`No session JSONL found under ${dir}`)
  const raw = await fs.readFile(path.join(dir, names.at(-1)!), 'utf-8')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
}

export async function listFilesRecursively(root: string): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else out.push(path.relative(root, absolute).replaceAll(path.sep, '/'))
    }
  }
  await visit(root)
  return out.sort()
}
