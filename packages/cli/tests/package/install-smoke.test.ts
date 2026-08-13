import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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

const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

let suiteRoot = ''
let packDir = ''
let installPrefix = ''
let tarballPath = ''
let installedCliJs = ''

function command(
  executable: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
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
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 2000).unref()
      }, options.timeoutMs ?? 120_000)
      child.once('error', reject)
      // On Windows a .cmd wrapper can exit while a descendant still holds an
      // inherited output pipe. Waiting for `close` then hangs until the hook
      // timeout even though pnpm/npm already finished; `exit` tracks the
      // command process itself and matches the result we assert below.
      child.once('exit', (exitCode) => {
        clearTimeout(timer)
        resolve({ stdout, stderr, exitCode })
      })
    }, reject)
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
  await fs.mkdir(packDir, { recursive: true })

  const packed = await command(packageManager, ['pack', '--pack-destination', packDir], {
    cwd: path.join(REPO_ROOT, 'packages', 'cli'),
  })
  if (packed.exitCode !== 0) throw new Error(`pnpm pack failed\n${packed.stdout}\n${packed.stderr}`)
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
    }
    expect(manifest.files).toEqual(['dist'])
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
