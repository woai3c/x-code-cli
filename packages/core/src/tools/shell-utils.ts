// @x-code-cli/core — Cross-platform shell detection and abstraction
import os from 'node:os'

export type ShellType = 'powershell' | 'bash' | 'zsh'

export interface ShellConfig {
  executable: string
  args: string[]
  type: ShellType
}

export function getShellConfig(): ShellConfig {
  if (os.platform() === 'win32') {
    // Git Bash / MSYS2 / Cygwin set SHELL to a Unix-style path (e.g. /usr/bin/bash).
    // Prefer that shell when available so the Unix tool ecosystem works as expected.
    const shell = process.env.SHELL
    if (shell && /\b(bash|zsh)$/i.test(shell)) {
      const type: ShellType = shell.endsWith('zsh') ? 'zsh' : 'bash'
      return { executable: shell, args: ['-c'], type }
    }
    return { executable: 'powershell.exe', args: ['-NoProfile', '-Command'], type: 'powershell' }
  }
  const userShell = process.env.SHELL ?? '/bin/bash'
  const type: ShellType = userShell.endsWith('zsh') ? 'zsh' : 'bash'
  return { executable: userShell, args: ['-c'], type }
}

/** Split compound shell commands by pipe/chain operators for permission checking */
export function splitShellCommands(cmd: string): string[] {
  // Split by |, &&, ;, || — but not inside quotes
  const parts: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    const next = cmd[i + 1]

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += ch
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += ch
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '|' && next === '|') {
        parts.push(current)
        current = ''
        i++ // skip next |
      } else if (ch === '&' && next === '&') {
        parts.push(current)
        current = ''
        i++ // skip next &
      } else if (ch === '|') {
        parts.push(current)
        current = ''
      } else if (ch === ';') {
        parts.push(current)
        current = ''
      } else {
        current += ch
      }
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)

  return parts.map((p) => p.trim()).filter(Boolean)
}

/** Unix/PowerShell commands that are safe to auto-allow */
const READ_ONLY_COMMANDS = [
  'cd',
  'ls',
  'dir',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'echo',
  'which',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'env',
  'printenv',
  'find',
  'tree',
  // PowerShell
  'Get-ChildItem',
  'Get-Location',
  'Get-Content',
  'Select-String',
  'Test-Path',
]

/** Git sub-commands that are read-only */
const READ_ONLY_GIT_SUBCOMMANDS = ['status', 'log', 'diff', 'branch', 'show', 'remote', 'tag']

// Pre-compiled regexes for performance
const READ_ONLY_REGEX = new RegExp(
  `^\\s*(${READ_ONLY_COMMANDS.join('|')}|git\\s+(${READ_ONLY_GIT_SUBCOMMANDS.join('|')}))\\b`,
)

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b(chmod|chown)\s+.*\//,
  />\s*\/dev\/sd/,
  /\bformat\b/,
  /\bRemove-Item\s+.*-Recurse/,
]

/** Check if a sub-command is read-only (safe to auto-allow) */
export function isReadOnly(cmd: string): boolean {
  return READ_ONLY_REGEX.test(cmd.trim())
}

/** Check if a sub-command is destructive (should be denied) */
export function isDestructive(cmd: string): boolean {
  const c = cmd.trim()
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(c))
}
