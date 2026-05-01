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
const READ_ONLY_GIT_SUBCOMMANDS = ['status', 'log', 'diff', 'branch', 'show', 'remote', 'tag', 'stash list', 'reflog']

// Pre-compiled regexes for performance
const READ_ONLY_REGEX = new RegExp(
  `^\\s*(${READ_ONLY_COMMANDS.join('|')}|git\\s+(${READ_ONLY_GIT_SUBCOMMANDS.join('|')}))\\b`,
)

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // ── Filesystem destruction ──
  /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)/,
  /\brm\s+-rf\b/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b(chmod|chown)\s+.*\//,
  />\s*\/dev\/sd/,
  /\bformat\b/,
  /\bRemove-Item\s+.*-Recurse/i,
  /\bRemove-Item\s+.*-Force/i,
  /\bdel\s+\/[sS]/,
  /\brmdir\s+\/[sS]/,

  // ── Git destructive operations ──
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+checkout\s+--\s*\./,
  /\bgit\s+rebase\b/,
  /\bgit\s+filter-branch\b/,
  /\bgit\s+reflog\s+expire\b/,
  /\bgit\s+gc\s+--prune\b/,

  // ── Remote code execution / download-and-exec ──
  /\bcurl\s.*\|\s*(ba)?sh\b/,
  /\bwget\s.*\|\s*(ba)?sh\b/,
  /\bcurl\s.*\|\s*python/,
  /\bwget\s.*\|\s*python/,

  // ── System control ──
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[06]\b/,
  /\bsystemctl\s+(stop|disable|mask|halt|poweroff)\b/,
  /\bkillall\b/,
  /\bpkill\s+-9\b/,
  /\bStop-Computer\b/i,
  /\bRestart-Computer\b/i,

  // ── Database destruction ──
  /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\s+\S+\s*;?\s*$/im,

  // ── Container / infra destruction ──
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/,
  /\bkubectl\s+delete\b/,

  // ── Environment pollution ──
  /\bnpm\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\byarn\s+publish\b/,

  // ── Disk / partition ──
  /\bfdisk\b/,
  /\bparted\b/,
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
