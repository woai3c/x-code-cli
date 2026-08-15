import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { REPO_ROOT, createTestWorkspace, isolatedCliEnv, listFilesRecursively } from '../fixtures/cli-test-helpers.js'
import { startFakeProvider } from '../fixtures/fake-provider-server.js'

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

interface TarEntry {
  name: string
  data: Buffer
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

let suiteRoot = ''
let packDir = ''
let installPrefix = ''
let tarballPath = ''
let installedCliJs = ''

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function commandInvocation(executable: string, args: string[]): { executable: string; args: string[] } {
  if (process.platform !== 'win32' || !executable.toLowerCase().endsWith('.cmd')) return { executable, args }

  // Node 22 rejects direct .cmd spawning with EINVAL on Windows. An encoded
  // PowerShell invocation preserves spaces and Unicode without cmd.exe's
  // nested quoting ambiguities.
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$ProgressPreference = 'SilentlyContinue'",
    `& ${[executable, ...args].map(powershellQuote).join(' ')}`,
    '$__ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
    'exit $__ec',
  ].join('\n')
  return {
    executable: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  }
}

function command(
  executable: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const invocation = commandInvocation(executable, args)
    const child = spawn(invocation.executable, invocation.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (value: Buffer) => {
      stdout += value.toString('utf-8')
    })
    child.stderr.on('data', (value: Buffer) => {
      stderr += value.toString('utf-8')
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }, options.timeoutMs ?? 120_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (exitCode) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode })
    })
  })
}

function readTarEntries(buffer: Buffer): TarEntry[] {
  const tar = gunzipSync(buffer)
  const entries: TarEntry[] = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) break
    const text = (start: number, end: number) => header.subarray(start, end).toString('utf-8').replace(/\0.*$/s, '')
    const name = text(0, 100)
    const prefix = text(345, 500)
    const size = Number.parseInt(text(124, 136).trim() || '0', 8)
    const fullName = prefix ? `${prefix}/${name}` : name
    const dataStart = offset + 512
    entries.push({ name: fullName, data: tar.subarray(dataStart, dataStart + size) })
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(process.env.TMPDIR ?? process.env.TEMP ?? '/tmp', 'xc-package-smoke-'))
  packDir = path.join(suiteRoot, 'packed artifacts')
  installPrefix = path.join(suiteRoot, 'npm prefix')
  const packageStage = path.join(suiteRoot, 'package source')
  await fs.mkdir(packDir, { recursive: true })
  await fs.mkdir(packageStage, { recursive: true })

  const cliPackageRoot = path.join(REPO_ROOT, 'packages', 'cli')
  await Promise.all([
    fs.copyFile(path.join(cliPackageRoot, 'package.json'), path.join(packageStage, 'package.json')),
    fs.cp(path.join(cliPackageRoot, 'dist'), path.join(packageStage, 'dist'), { recursive: true }),
  ])

  const packed = await command(npmCommand, ['pack', '--ignore-scripts', '--pack-destination', packDir], {
    cwd: packageStage,
  })
  if (packed.exitCode !== 0) throw new Error(`npm pack failed\n${packed.stdout}\n${packed.stderr}`)
  const tarballs = (await fs.readdir(packDir)).filter((name) => name.endsWith('.tgz'))
  if (tarballs.length !== 1) throw new Error(`Expected one CLI tarball, found: ${tarballs.join(', ')}`)
  tarballPath = path.join(packDir, tarballs[0]!)

  const installed = await command(
    npmCommand,
    ['install', '--no-audit', '--no-fund', '--prefix', installPrefix, tarballPath],
    {
      cwd: suiteRoot,
      timeoutMs: 180_000,
    },
  )
  if (installed.exitCode !== 0) throw new Error(`npm install failed\n${installed.stdout}\n${installed.stderr}`)
  installedCliJs = path.join(installPrefix, 'node_modules', '@x-code-cli', 'cli', 'dist', 'cli.js')
})

afterAll(async () => {
  if (suiteRoot) await fs.rm(suiteRoot, { recursive: true, force: true })
})

describe('published CLI tarball', () => {
  it('contains the built CLI but no source, sessions, logs, tests, or secrets', async () => {
    const entries = readTarEntries(await fs.readFile(tarballPath))
    const names = entries.map((entry) => entry.name)

    expect(names).toContain('package/package.json')
    expect(names).toContain('package/dist/cli.js')
    expect(names.some((name) => /(?:^|\/)src\//.test(name))).toBe(false)
    expect(names.some((name) => /(?:^|\/)tests?\//.test(name))).toBe(false)
    expect(names.some((name) => /(?:^|\/)(?:\.env|sessions?|logs?)(?:\/|$)/.test(name))).toBe(false)
    expect(names.some((name) => name.includes('packages/core'))).toBe(false)

    const manifest = JSON.parse(
      entries.find((entry) => entry.name === 'package/package.json')!.data.toString('utf-8'),
    ) as {
      files?: string[]
      dependencies?: Record<string, string>
    }
    expect(manifest.files).toEqual(['dist'])
    expect(manifest.dependencies?.['node-pty']).toBe('^1.1.0')
  })

  it('contains hash-verified Windows helpers for x64 and arm64', async () => {
    const entries = readTarEntries(await fs.readFile(tarballPath))
    const byName = new Map(entries.map((entry) => [entry.name, entry.data]))
    const manifestBytes = byName.get('package/dist/native/windows/manifest.json')
    expect(manifestBytes).toBeDefined()
    const manifest = JSON.parse(manifestBytes!.toString('utf-8')) as {
      protocolVersion: number
      artifacts: Record<string, { file: string; sha256: string }>
    }

    expect(manifest.protocolVersion).toBe(2)
    for (const arch of ['x64', 'arm64']) {
      const artifact = manifest.artifacts[arch]!
      const bytes = byName.get(`package/dist/native/windows/${artifact.file}`)
      expect(bytes, `missing ${arch} Windows helper`).toBeDefined()
      expect(createHash('sha256').update(bytes!).digest('hex')).toBe(artifact.sha256)
    }
  })

  it('installs both bin aliases and runs version/help outside the repository', async () => {
    const cwd = path.join(suiteRoot, '外部 project with spaces')
    await fs.mkdir(cwd, { recursive: true })
    const binDir = path.join(installPrefix, 'node_modules', '.bin')
    const suffix = process.platform === 'win32' ? '.cmd' : ''
    const xc = path.join(binDir, `xc${suffix}`)
    const xCode = path.join(binDir, `x-code${suffix}`)

    await expect(fs.access(xc)).resolves.toBeUndefined()
    await expect(fs.access(xCode)).resolves.toBeUndefined()
    const version = await command(xc, ['--version'], { cwd })
    const help = await command(xCode, ['--help'], { cwd })
    const manifest = JSON.parse(
      await fs.readFile(path.join(REPO_ROOT, 'packages', 'cli', 'package.json'), 'utf-8'),
    ) as {
      version: string
    }
    expect(version).toMatchObject({ exitCode: 0, stdout: expect.stringContaining(manifest.version) })
    expect(help).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('Options:') })
    expect(help.stderr).not.toMatch(/API key/i)
  })

  it('installs and loads the native PTY dependency outside the repository', async () => {
    const script = `
      const { createRequire } = require('node:module')
      const load = createRequire(${JSON.stringify(installedCliJs)})
      const pty = load('node-pty')
      if (typeof pty.spawn !== 'function') process.exit(1)
      process.stdout.write('package-pty-loaded')
    `
    const result = await command(process.execPath, ['-e', script], { cwd: suiteRoot, timeoutMs: 20_000 })

    expect(result).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('package-pty-loaded') })
  })

  it('runs a fake-provider print task from the installed package', async () => {
    const provider = await startFakeProvider([{ type: 'completion', text: 'installed-package-ok' }])
    const workspace = await createTestWorkspace('xc-installed-task-')
    try {
      const result = await command(
        process.execPath,
        [installedCliJs, '--print', '--no-plugins', '--no-hooks', '--max-turns', '2', 'hi'],
        { cwd: workspace.cwd, env: isolatedCliEnv(workspace, provider) },
      )
      expect(result).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('installed-package-ok') })
      expect(provider.requests()).toHaveLength(1)
      expect(provider.requests()[0]).toMatchObject({ model: 'test-model', authorizationPresent: true })
    } finally {
      await provider.close()
      await workspace.cleanup()
    }
  })

  it('executes a tty shell tool through the bundled provider', async () => {
    const provider = await startFakeProvider([
      { type: 'tool-call', name: 'shell', input: { command: 'node --version', tty: true } },
      { type: 'completion', text: 'installed-pty-tool-ok' },
    ])
    const workspace = await createTestWorkspace('xc-installed-pty-tool-')
    try {
      const result = await command(
        process.execPath,
        [installedCliJs, '--print', '--trust', '--no-plugins', '--no-hooks', '--max-turns', '3', 'run a tty command'],
        { cwd: workspace.cwd, env: isolatedCliEnv(workspace, provider), timeoutMs: 30_000 },
      )
      expect(result).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('installed-pty-tool-ok') })
      const requests = provider.mainRequests()
      expect(requests).toHaveLength(2)
      const observedToolResult = JSON.stringify(requests[1]!.messages)
      expect(observedToolResult).toContain(process.version)
      expect(observedToolResult).toContain('Chunk ID:')
      expect(observedToolResult).toContain('Process exited with code 0')
      expect(observedToolResult).not.toMatch(/supervisor artifact|protocol (?:error|mismatch)/i)
    } finally {
      await provider.close()
      await workspace.cleanup()
    }
  })

  it('returns an actionable non-zero error in print mode when no API key is configured', async () => {
    const workspace = await createTestWorkspace('xc-installed-no-key-')
    try {
      const result = await command(process.execPath, [installedCliJs, '--print', '--no-plugins', '--no-hooks', 'hi'], {
        cwd: workspace.cwd,
        env: isolatedCliEnv(workspace),
      })
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(/No API key found|Set at least one provider API key/i)
      expect(result.stderr).not.toMatch(/Fatal error|\n\s+at\s/)
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps first-run state inside the isolated project and X_CODE_HOME', async () => {
    const provider = await startFakeProvider([{ type: 'completion', text: 'first-run-ok' }])
    const workspace = await createTestWorkspace('xc-first-run-中文 space-')
    try {
      const beforeRepoFiles = await listFilesRecursively(path.join(REPO_ROOT, 'packages', 'cli', 'src'))
      const result = await command(
        process.execPath,
        [installedCliJs, '--print', '--no-plugins', '--no-hooks', '--max-turns', '2', 'hi'],
        { cwd: workspace.cwd, env: isolatedCliEnv(workspace, provider) },
      )
      const afterRepoFiles = await listFilesRecursively(path.join(REPO_ROOT, 'packages', 'cli', 'src'))
      const workspaceFiles = await listFilesRecursively(workspace.cwd)

      expect(result.exitCode).toBe(0)
      expect(result.stderr).not.toMatch(/module not found|ERR_MODULE_NOT_FOUND/i)
      expect(afterRepoFiles).toEqual(beforeRepoFiles)
      expect(workspaceFiles.some((name) => name.startsWith('.x-code-home/'))).toBe(true)
      expect(workspaceFiles.some((name) => name.startsWith('.x-code/sessions/'))).toBe(true)
    } finally {
      await provider.close()
      await workspace.cleanup()
    }
  })
})
