// Integration tests for shell-provider.ts.
//
// These spawn real child processes (bash / zsh / PowerShell) so they exercise
// the whole encoding + quoting path end-to-end. Each suite skips itself when
// the current platform resolves to a different shell.
//
// Regression targets (see a.log in the repo root, which captured the original
// breakage on a zh-CN Windows machine):
//   • double-quoted commands used to hit `At line:1 char:N` under the old
//     backslash-escape scheme
//   • native exe exit codes used to be dropped because PS does not propagate
//     $LASTEXITCODE to its own process exit code
//   • UTF-8 output used to depend on a `chcp 65001 >nul && ...` cmd wrapper
import { describe, expect, it } from 'vitest'

import { getShellProvider } from '../src/tools/shell-provider.js'

const provider = getShellProvider()
const isPowerShell = provider.type === 'powershell'
const isPosix = provider.type === 'bash' || provider.type === 'zsh'

async function run(command: string, timeout = 10_000) {
  const r = await provider.spawn(command, { timeout })
  return {
    exitCode: r.exitCode ?? -1,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
  }
}

describe.skipIf(!isPowerShell)('PowerShell provider', () => {
  // a.log line 11: the exact shape that hit "At line:1 char:24" before.
  it('runs commands with nested double quotes', async () => {
    const r = await run(`powershell -Command "Write-Host 'nested'"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('nested')
  })

  // a.log line 33: compound with embedded double-quoted literal.
  it('runs compound commands with double-quoted literals', async () => {
    const r = await run(`Write-Output "a"; Write-Output "---"; Write-Output "b"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('a')
    expect(r.stdout).toContain('---')
    expect(r.stdout).toContain('b')
  })

  // a.log line 49: double-quoted commit-message style arg.
  it('runs commands with colon-bearing double-quoted args', async () => {
    const r = await run(`Write-Output "feat: use primary accent color"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('primary accent color')
  })

  // Previously depended on `chcp 65001 >nul &&` cmd wrapper; now the
  // -EncodedCommand payload sets [Console]::OutputEncoding itself.
  it('round-trips UTF-8 (Chinese + em-dash + emoji)', async () => {
    const r = await run(`Write-Output "中文测试 — emoji 🎯"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('中文测试')
    expect(r.stdout).toContain('🎯')
  })

  // PS 5.1 does not propagate $LASTEXITCODE to its own exit code. Without the
  // trailing `exit $__ec` in the provider, this comes back as 0 or 1.
  it('propagates native exit codes', async () => {
    const r = await run(`cmd /c exit 3`)
    expect(r.exitCode).toBe(3)
  })

  it('returns exit 0 on success', async () => {
    const r = await run(`Write-Output hello`)
    expect(r.exitCode).toBe(0)
  })

  it('does not leak CLIXML progress noise to stderr', async () => {
    const r = await run(`Write-Output ok`)
    expect(r.stderr).not.toMatch(/CLIXML/)
  })
})

describe.skipIf(!isPosix)('POSIX provider (bash/zsh)', () => {
  it('runs commands with escaped double quotes', async () => {
    const r = await run(`echo "hello \\"world\\""`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hello')
    expect(r.stdout).toContain('world')
  })

  it('round-trips UTF-8 (Chinese + em-dash + emoji)', async () => {
    const r = await run(`echo "中文测试 — emoji 🎯"`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('中文测试')
    expect(r.stdout).toContain('🎯')
  })

  it('propagates non-zero exit codes', async () => {
    const r = await run(`sh -c 'exit 3'`)
    expect(r.exitCode).toBe(3)
  })

  it('returns exit 0 on success', async () => {
    const r = await run(`echo hello`)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hello')
  })
})

describe('getShellProvider', () => {
  it('returns a provider with a valid type and spawn()', () => {
    expect(['bash', 'zsh', 'powershell']).toContain(provider.type)
    expect(typeof provider.spawn).toBe('function')
  })
})
