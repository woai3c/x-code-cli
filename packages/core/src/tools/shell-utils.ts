// @x-code/core — Cross-platform shell detection and abstraction

import os from 'node:os'

export type ShellType = 'powershell' | 'bash' | 'zsh'

export interface ShellConfig {
  executable: string
  args: string[]
  type: ShellType
}

export function getShellConfig(): ShellConfig {
  if (os.platform() === 'win32') {
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

/** Check if a sub-command is read-only (safe to auto-allow) */
export function isReadOnly(cmd: string): boolean {
  const c = cmd.trim()
  return /^\s*(ls|pwd|cat|head|tail|wc|echo|which|type|file|stat|du|df|env|printenv|git\s+(status|log|diff|branch|show|remote|tag))/.test(
    c,
  )
}

/** Check if a sub-command is destructive (should be denied) */
export function isDestructive(cmd: string): boolean {
  const c = cmd.trim()
  return (
    /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)/.test(c) ||
    /\bsudo\b/.test(c) ||
    /\bmkfs\b/.test(c) ||
    /\bdd\s+if=/.test(c) ||
    /\b(chmod|chown)\s+.*\//.test(c) ||
    />\s*\/dev\/sd/.test(c) ||
    /\bformat\b/.test(c) ||
    /\bRemove-Item\s+.*-Recurse/.test(c)
  )
}
