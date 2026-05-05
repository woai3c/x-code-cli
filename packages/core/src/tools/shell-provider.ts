// @x-code-cli/core — Cross-platform shell provider abstraction.
//
// Each shell (bash/zsh, PowerShell) spawns its own child process with its own
// quoting/encoding quirks. Keeping those quirks behind a provider interface
// means the tool-execution layer does not need platform branches and does not
// hand-roll quote escapes for PowerShell.
import { type ResultPromise, execa } from 'execa'

import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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

export interface ShellSpawnResult {
  /** The execa child process. Caller awaits this for stdout/stderr/exit. */
  proc: ResultPromise
  /** Resolves to the cwd the shell session was in when the command finished
   *  (i.e. honors any `cd` issued by the command). Returns null when
   *  capture failed — child died before writing the file, file was empty,
   *  parsed path doesn't exist, etc. Caller should leave its persisted
   *  cwd unchanged on null. Always cleans up the temp file. */
  readCwd: () => Promise<string | null>
}

export interface ShellProvider {
  type: ShellType
  spawn(command: string, opts: ShellSpawnOptions): ShellSpawnResult
}

/** Cwd-capture file path for one shell invocation. We use a fresh file per
 *  command so concurrent shell calls (rare today, but possible) don't race.
 *  Lives in os.tmpdir() and is unlinked after readCwd. */
function newCwdFile(): string {
  return path.join(os.tmpdir(), `xc-shellcwd-${randomBytes(8).toString('hex')}`)
}

/** Compose the env passed to every shell child. The overrides here are
 *  what makes "the model accidentally ran an interactive command"
 *  recoverable instead of fatal — they intentionally win over the user's
 *  personal env so a developer who has GIT_EDITOR=vim in their shell rc
 *  doesn't get a hung agent:
 *
 *  - GIT_EDITOR=true / EDITOR=true: a `git commit` (no -m), `git rebase`
 *    without -i, etc. would otherwise launch vim inside the child and
 *    block until timeout. `true` is a real binary that exits 0
 *    immediately, so git proceeds with an empty commit message and we
 *    get a clear "aborted, empty message" rather than a 30-s hang.
 *  - PAGER=cat / GIT_PAGER=cat: `git log`, `git diff`, `man` etc. open
 *    less in a TTY. Our child has no TTY, so they'd buffer indefinitely
 *    or hang. Forcing cat returns the full output immediately.
 *  - PYTHONIOENCODING=utf-8: zh-CN Windows defaults Python stdout to
 *    GBK; we decode as UTF-8.
 *  - XC_CWD_FILE: the per-call cwd-capture file (see newCwdFile above).
 *  - XCODE_CLI=1: a marker hint-protocol-aware tools can detect (parity
 *    with CC's CLAUDECODE=1). */
function makeChildEnv(userEnv: NodeJS.ProcessEnv | undefined, cwdFile: string): NodeJS.ProcessEnv {
  const base = userEnv ?? process.env
  return {
    ...base,
    GIT_EDITOR: 'true',
    EDITOR: 'true',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    PYTHONIOENCODING: 'utf-8',
    XCODE_CLI: '1',
    XC_CWD_FILE: cwdFile,
  }
}

/** Read and unlink the cwd capture file. Returns null on any failure
 *  (missing file, parse error, the captured path no longer exists). */
async function consumeCwdFile(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const trimmed = raw.replace(/\r?\n/g, '').trim()
    if (!trimmed) return null
    // Sanity check that the captured path still exists. A `cd` to a
    // directory that was deleted mid-command would leave PowerShell /
    // bash in a phantom state we don't want to propagate.
    try {
      const stat = await fs.stat(trimmed)
      if (!stat.isDirectory()) return null
    } catch {
      return null
    }
    return trimmed
  } catch {
    return null
  } finally {
    fs.unlink(filePath).catch(() => {})
  }
}

function createPosixProvider(executable: string, type: 'bash' | 'zsh'): ShellProvider {
  return {
    type,
    spawn(command, opts) {
      const cwdFile = newCwdFile()
      // Append a pwd capture step. We use a subshell + redirect so it
      // runs unconditionally even if the user command failed. The leading
      // semicolon protects against commands with no trailing newline.
      // pwd -P resolves symlinks so the captured path is canonical.
      const wrapped = `${command}\n( pwd -P > "$XC_CWD_FILE" ) || true`
      const proc = execa(executable, ['-c', wrapped], {
        timeout: opts.timeout,
        maxBuffer: MAX_SHELL_BUFFER,
        cwd: opts.cwd,
        reject: false,
        cancelSignal: opts.signal,
        env: makeChildEnv(opts.env, cwdFile),
      })
      return { proc, readCwd: () => consumeCwdFile(cwdFile) }
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
      //   • cwd capture — write `(Get-Location).Path` to $env:XC_CWD_FILE
      //     after the command runs (try/catch so a failed command doesn't
      //     skip the capture). Caller reads the file via readCwd() and
      //     persists it as the next call's cwd.
      //   • trailing `exit` — PowerShell does NOT propagate $LASTEXITCODE
      //     to its own process exit code. Without this, `git push` failing
      //     with exit 1 or `tsc` failing with exit 2 all come back as exit 0
      //     or a generic 1, losing the signal. Prefer $LASTEXITCODE when a
      //     native exe ran; fall back to $? for cmdlet-only pipelines.
      const cwdFile = newCwdFile()
      const wrapped = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        "$ProgressPreference = 'SilentlyContinue'",
        command,
        // Save the exit code BEFORE the cwd capture so writing the file
        // doesn't clobber $LASTEXITCODE / $?.
        '$__ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
        'try { (Get-Location).Path | Out-File -FilePath $env:XC_CWD_FILE -Encoding utf8 -NoNewline } catch {}',
        'exit $__ec',
      ].join('\n')
      const proc = execa(
        executable,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(wrapped)],
        {
          timeout: opts.timeout,
          maxBuffer: MAX_SHELL_BUFFER,
          cwd: opts.cwd,
          reject: false,
          cancelSignal: opts.signal,
          env: makeChildEnv(opts.env, cwdFile),
        },
      )
      return { proc, readCwd: () => consumeCwdFile(cwdFile) }
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
