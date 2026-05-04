// @x-code-cli/core — Permission memory with disk persistence.
//
// When a user approves a tool call with "don't ask again", the decision
// is stored as an AllowRule both in-memory AND on disk at
// `.x-code/local/permissions.json`. On next startup the persisted rules
// are loaded so approvals survive across sessions.
import * as fs from 'node:fs'
import * as path from 'node:path'

import { XCODE_DIR } from '../utils.js'

export interface AllowRule {
  tool: string
  pattern: string
  type: 'exact' | 'prefix' | 'tool'
}

// Env-var assignment prefix: VAR=value (unquoted, safe chars only).
const ENV_VAR_RE = /^[A-Za-z_]\w*=[A-Za-z0-9_./:@-]*\s+/

// Matches `powershell -Command "..."` or `powershell -c "..."` (case-insensitive).
const POWERSHELL_CMD_RE = /^powershell(?:\.exe)?\s+(?:-(?:Command|c)\s+)?["']/i

// Extracts the first cmdlet or command name from inside quoted PowerShell.
// Handles Verb-Noun cmdlets (Get-Process) and plain commands (git, npm).
const PS_INNER_CMD_RE = /["']?\s*(?:&\s*)?([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|[a-z][a-z0-9._-]*)/

/**
 * Extract a command prefix suitable for prefix-match rules.
 * Returns `null` when no meaningful prefix can be derived.
 *
 *   'git commit -m "fix"'                          → 'git commit'
 *   'pnpm run build'                               → 'pnpm run'
 *   'npm install lodash'                           → 'npm install'
 *   'NODE_ENV=prod npm run dev'                    → 'npm run'
 *   'powershell -Command "Get-CimInstance ..."'    → 'Get-CimInstance'
 *   'powershell -Command "git status"'             → 'git'
 *   'ls -la'                                       → null
 *   ''                                             → null
 */
export function extractCommandPrefix(command: string): string | null {
  let cmd = command.trim()
  while (ENV_VAR_RE.test(cmd)) {
    cmd = cmd.replace(ENV_VAR_RE, '')
  }

  // Handle `powershell -Command "..."`: extract the inner cmdlet/command.
  if (POWERSHELL_CMD_RE.test(cmd)) {
    const quoteStart = cmd.indexOf('"') !== -1 ? cmd.indexOf('"') : cmd.indexOf("'")
    if (quoteStart !== -1) {
      const inner = cmd.slice(quoteStart)
      const m = PS_INNER_CMD_RE.exec(inner)
      if (m?.[1]) return m[1]
    }
    return null
  }

  const tokens = cmd.split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return null
  const second = tokens[1]!
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(second)) {
    return `${tokens[0]} ${second}`
  }
  return null
}

/**
 * Generate the display label for the "don't ask again" option.
 * Returns `null` when no meaningful rule can be suggested — the UI
 * should hide the "don't ask again" option entirely in that case.
 *
 * Shell with prefix: `git commit:*`
 * Shell without prefix: null (no safe rule to suggest)
 * Write tools (writeFile, edit): `all edits this session` (session-only)
 */
export function suggestRuleLabel(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'enterPlanMode') return null
  if (toolName === 'shell') {
    const cmd = (input.command as string) ?? ''
    const prefix = extractCommandPrefix(cmd)
    if (prefix) return `${prefix}:*`
    return null
  }
  return 'all edits this session'
}

/**
 * Build the AllowRule for a "don't ask again" approval.
 * Returns `null` when no meaningful rule can be built (shell command
 * without derivable prefix) — caller should not save a rule.
 *
 * - Shell with derivable prefix (e.g. `git commit`) → prefix rule
 * - Shell without prefix → null (UI should not offer this option)
 * - writeFile / edit → tool-wide allow (session-only, not persisted)
 *
 * `persist` indicates whether the rule should be saved to disk.
 * Write tools return persist=false (session-only, matching Claude Code).
 */
export function buildAllowRule(
  toolName: string,
  input: Record<string, unknown>,
): { rule: AllowRule; persist: boolean } | null {
  if (toolName === 'shell') {
    const cmd = (input.command as string) ?? ''
    const prefix = extractCommandPrefix(cmd)
    if (prefix) {
      return { rule: { tool: toolName, pattern: prefix, type: 'prefix' }, persist: true }
    }
    return null
  }
  return { rule: { tool: toolName, pattern: '*', type: 'tool' }, persist: false }
}

function stripEnvVars(command: string): string {
  let cmd = command.trim()
  while (ENV_VAR_RE.test(cmd)) {
    cmd = cmd.replace(ENV_VAR_RE, '')
  }
  return cmd.trim()
}

// ─── Serialization helpers ───

function ruleToString(rule: AllowRule): string {
  if (rule.type === 'tool') return `${rule.tool}:*`
  if (rule.type === 'prefix') return `${rule.tool}:${rule.pattern}:*`
  return `${rule.tool}:=${rule.pattern}`
}

function parseRuleString(s: string): AllowRule | null {
  // tool:*  → tool-wide
  const toolWide = s.match(/^([^:]+):\*$/)
  if (toolWide) return { tool: toolWide[1]!, pattern: '*', type: 'tool' }
  // tool:prefix:*  → prefix match
  const prefix = s.match(/^([^:]+):(.+):\*$/)
  if (prefix) return { tool: prefix[1]!, pattern: prefix[2]!, type: 'prefix' }
  // tool:=exact  → exact match
  const exact = s.match(/^([^:]+):=(.+)$/)
  if (exact) return { tool: exact[1]!, pattern: exact[2]!, type: 'exact' }
  return null
}

function getPermissionsPath(cwd: string): string {
  return path.join(cwd, XCODE_DIR, 'local', 'permissions.json')
}

// ─── Store ───

class SessionPermissionStore {
  private rules: AllowRule[] = []

  addRule(rule: AllowRule): void {
    const exists = this.rules.some((r) => r.tool === rule.tool && r.pattern === rule.pattern && r.type === rule.type)
    if (!exists) this.rules.push(rule)
  }

  matches(toolName: string, input: Record<string, unknown>): boolean {
    for (const rule of this.rules) {
      if (rule.tool !== toolName) continue

      if (rule.type === 'tool') return true

      if (toolName === 'shell') {
        const cmd = (input.command as string) ?? ''
        const prefix = extractCommandPrefix(cmd)
        if (rule.type === 'exact' && stripEnvVars(cmd) === rule.pattern) return true
        if (rule.type === 'prefix' && prefix) {
          if (prefix === rule.pattern) return true
          if (prefix.startsWith(rule.pattern + ' ')) return true
        }
      }
    }
    return false
  }

  clear(): void {
    this.rules = []
  }

  get size(): number {
    return this.rules.length
  }
}

const store = new SessionPermissionStore()

export function addSessionAllowRule(rule: AllowRule): void {
  store.addRule(rule)
}

export function sessionRulesMatch(toolName: string, input: Record<string, unknown>): boolean {
  return store.matches(toolName, input)
}

export function clearSessionRules(): void {
  store.clear()
}

// ─── Disk persistence ───

/**
 * Load persisted permission rules from `.x-code/local/permissions.json`
 * into the in-memory store. Safe to call multiple times (deduplicates).
 * Silently no-ops if the file doesn't exist or is malformed.
 */
export function loadPersistedRules(cwd: string): void {
  const filePath = getPermissionsPath(cwd)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return
  }
  let data: { allow?: string[] }
  try {
    data = JSON.parse(raw) as { allow?: string[] }
  } catch {
    return
  }
  if (!Array.isArray(data.allow)) return
  for (const entry of data.allow) {
    if (typeof entry !== 'string') continue
    const rule = parseRuleString(entry)
    if (rule) store.addRule(rule)
  }
}

/**
 * Persist a new rule to `.x-code/local/permissions.json`.
 * Creates the file if it doesn't exist. Appends without duplicating.
 */
export function persistRule(cwd: string, rule: AllowRule): void {
  const filePath = getPermissionsPath(cwd)
  const ruleStr = ruleToString(rule)

  const data: { allow: string[] } = { allow: [] }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { allow?: string[] }
    if (Array.isArray(parsed.allow)) {
      data.allow = parsed.allow.filter((s): s is string => typeof s === 'string')
    }
  } catch {
    // File doesn't exist or is malformed — start fresh.
  }

  if (data.allow.includes(ruleStr)) return

  data.allow.push(ruleStr)

  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}
