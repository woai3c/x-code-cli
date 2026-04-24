// @x-code-cli/core — Shell command semantic helpers (shell-agnostic).
//
// Splitting a compound command into sub-commands and classifying each as
// read-only / destructive is used only for permission checks. The execution
// side (spawning the shell process) lives in shell-provider.ts.
export type { ShellType } from './shell-provider.js'

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
