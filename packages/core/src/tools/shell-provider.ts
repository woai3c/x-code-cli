// @x-code-cli/core — Cross-platform shell provider abstraction.
//
// Each shell (bash/zsh, PowerShell) spawns its own child process with its own
// quoting/encoding quirks. Keeping those quirks behind a provider interface
// means the tool-execution layer does not need platform branches and does not
// hand-roll quote escapes for PowerShell.
import { type ResultPromise, execa } from 'execa'

import os from 'node:os'

export type ShellType = 'bash' | 'zsh' | 'powershell'

// 20 MB — matches Claude Code's ripgrep buffer; generous enough for real
// workloads, small enough to prevent an accidental `yes` or `find /` from
// eating all memory. When exceeded, execa terminates the child with SIGTERM
// and surfaces a "maxBuffer exceeded" error.
export const MAX_SHELL_BUFFER = 20 * 1024 * 1024

export interface ShellSpawnOptions {
  timeout: number
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** When this signal aborts, execa kills the child process tree. Used to
   *  honor user Esc / Ctrl+C cancellation mid-command without waiting for
   *  the timeout. */
  signal?: AbortSignal
}

export interface ShellProvider {
  type: ShellType
  spawn(command: string, opts: ShellSpawnOptions): ResultPromise
}

function createPosixProvider(executable: string, type: 'bash' | 'zsh'): ShellProvider {
  return {
    type,
    spawn(command, opts) {
      return execa(executable, ['-c', command], {
        timeout: opts.timeout,
        maxBuffer: MAX_SHELL_BUFFER,
        cwd: opts.cwd,
        reject: false,
        cancelSignal: opts.signal,
        env: { ...(opts.env ?? process.env), PYTHONIOENCODING: 'utf-8' },
      })
    },
  }
}

// PowerShell's -EncodedCommand accepts a base64 UTF-16LE payload. The char set
// is [A-Za-z0-9+/=] which survives any outer quoting layer (cmd.exe, Node's
// Windows argv-to-string serializer, etc.), so we never need to escape quotes
// in the user's command.
function encodePowerShellCommand(psCommand: string): string {
  return Buffer.from(psCommand, 'utf16le').toString('base64')
}

function createPowerShellProvider(executable: string): ShellProvider {
  return {
    type: 'powershell',
    spawn(command, opts) {
      // Prefix/suffix run inside the same -EncodedCommand payload:
      //   • OutputEncoding = UTF-8 — PS 5.1 on zh-CN Windows otherwise writes
      //     output in GBK (mojibake when we decode as UTF-8). Avoids the
      //     `chcp 65001 >nul && ...` cmd.exe wrapper.
      //   • ProgressPreference = SilentlyContinue — first-run module loads
      //     emit CLIXML progress records on stderr, which would surface as
      //     noise in tool output.
      //   • trailing `exit` — PowerShell does NOT propagate $LASTEXITCODE
      //     to its own process exit code. Without this, `git push` failing
      //     with exit 1 or `tsc` failing with exit 2 all come back as exit 0
      //     or a generic 1, losing the signal. Prefer $LASTEXITCODE when a
      //     native exe ran; fall back to $? for cmdlet-only pipelines.
      const wrapped = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        "$ProgressPreference = 'SilentlyContinue'",
        command,
        '$__ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
        'exit $__ec',
      ].join('\n')
      return execa(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(wrapped)], {
        timeout: opts.timeout,
        maxBuffer: MAX_SHELL_BUFFER,
        cwd: opts.cwd,
        reject: false,
        cancelSignal: opts.signal,
        env: { ...(opts.env ?? process.env), PYTHONIOENCODING: 'utf-8' },
      })
    },
  }
}

export function getShellProvider(): ShellProvider {
  if (os.platform() === 'win32') {
    // Git Bash / MSYS2 / Cygwin set SHELL to a Unix-style path. Prefer that
    // when present so the Unix tool ecosystem works as expected.
    const shell = process.env.SHELL
    if (shell && /\b(bash|zsh)$/i.test(shell)) {
      return createPosixProvider(shell, shell.endsWith('zsh') ? 'zsh' : 'bash')
    }
    return createPowerShellProvider('powershell.exe')
  }
  const userShell = process.env.SHELL ?? '/bin/bash'
  return createPosixProvider(userShell, userShell.endsWith('zsh') ? 'zsh' : 'bash')
}
