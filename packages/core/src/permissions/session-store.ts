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

// Detects the `powershell` / `powershell.exe` / `pwsh` invocation prefix.
// We don't try to match the WHOLE shape here — agents use a lot of flag
// variations (`-NoProfile`, `-ExecutionPolicy Bypass`, `-File foo.ps1`,
// bare invocation without `-Command`). Just identify the launcher; the
// extractor below scans past flags to find the inner command.
const POWERSHELL_LAUNCHER_RE = /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b/i

// Extracts the first cmdlet or command name from inside quoted PowerShell.
// Handles Verb-Noun cmdlets (Get-Process) and plain commands (git, npm).
const PS_INNER_CMD_RE = /["']?\s*(?:&\s*\{?\s*)?([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|[a-z][a-z0-9._-]*)/

/**
 * Extract a command prefix suitable for prefix-match rules.
 * Returns `null` when no meaningful prefix can be derived.
 *
 *   'git commit -m "fix"'                                    → 'git commit'
 *   'pnpm run build'                                         → 'pnpm run'
 *   'npm install lodash'                                     → 'npm install'
 *   'NODE_ENV=prod npm run dev'                              → 'npm run'
 *   'powershell -Command "Get-CimInstance ..."'              → 'Get-CimInstance'
 *   'powershell -NoProfile -Command "Get-CimInstance ..."'   → 'Get-CimInstance'
 *   'powershell -ExecutionPolicy Bypass -c "git status"'     → 'git'
 *   'pwsh -Command "& { Get-Process }"'                      → 'Get-Process'
 *   'powershell -Command Get-Date'                           → 'Get-Date'
 *   'ls -la'                                                 → null
 *   ''                                                       → null
 */
export function extractCommandPrefix(command: string): string | null {
  let cmd = command.trim()
  while (ENV_VAR_RE.test(cmd)) {
    cmd = cmd.replace(ENV_VAR_RE, '')
  }

  // PowerShell: scan past launcher + flags to find the inner command.
  // Agents emit varied flag combinations (`-NoProfile`, `-ExecutionPolicy
  // Bypass`, `-c` vs `-Command`, etc.) — strip them all, then extract the
  // first cmdlet/command from the remaining string. The earlier regex-based
  // approach only matched a fixed flag layout and produced null for the
  // common `-NoProfile` case, hiding the "don't ask again" option.
  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    const tokens = cmd.split(/\s+/).filter(Boolean)
    let i = 1 // skip launcher
    while (i < tokens.length) {
      const tok = tokens[i]!
      if (!tok.startsWith('-')) break
      const lower = tok.toLowerCase()
      // -Command / -c ends the flag run — what follows is the actual command
      if (lower === '-command' || lower === '-c') {
        i++
        break
      }
      // -File <path> — no useful prefix; bail.
      if (lower === '-file') return null
      // Flags that take an argument (consume next token too).
      if (
        lower === '-executionpolicy' ||
        lower === '-encodedcommand' ||
        lower === '-inputformat' ||
        lower === '-outputformat' ||
        lower === '-version' ||
        lower === '-windowstyle' ||
        lower === '-configurationname' ||
        lower === '-mta' ||
        lower === '-sta'
      ) {
        i += 2
        continue
      }
      // Boolean flags (no argument): -NoProfile, -NoLogo, -NonInteractive, etc.
      i++
    }
    if (i >= tokens.length) return null
    const inner = tokens.slice(i).join(' ')
    const m = PS_INNER_CMD_RE.exec(inner)
    if (m?.[1]) return m[1]
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
 * Returns `null` only for tools where a "don't ask again" affordance
 * makes no sense (enterPlanMode toggles a mode, not a recurring action).
 *
 * Shell with derivable prefix:    `git commit:*`
 * Shell without derivable prefix: `this exact command` (exact-match rule —
 *   covers Windows-style commands like `findstr /n …`, `cmd /c …`,
 *   `dir /b`, where the second token is a `/flag` or path that fails
 *   the prefix regex; without this fallback the user gets only Yes/No
 *   forever for repeated identical commands).
 * Write tools (writeFile / edit): `all edits this session` (session-only)
 */
export function suggestRuleLabel(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'enterPlanMode') return null
  if (toolName === 'shell') {
    const cmd = (input.command as string) ?? ''
    const prefix = extractCommandPrefix(cmd)
    if (prefix) return `${prefix}:*`
    return 'this exact command'
  }
  return 'all edits this session'
}

/**
 * Build the AllowRule for a "don't ask again" approval.
 *
 * - Shell with derivable prefix (e.g. `git commit`) → prefix rule, persisted
 * - Shell without derivable prefix                  → exact-match rule,
 *   persisted (mirrors Claude Code's `suggestionForExactCommand`
 *   fallback in `bashPermissions.ts`). Less reusable than a prefix rule
 *   (any arg change breaks the match) but at least suppresses repeated
 *   identical invocations — better than "Yes/No forever". The matcher
 *   compares against `stripEnvVars(cmd)` so leading `NODE_ENV=…` etc.
 *   don't defeat the rule.
 * - writeFile / edit                                → tool-wide allow,
 *   session-only (matches Claude Code).
 *
 * `persist` indicates whether the rule should be saved to disk. Write
 * tools return persist=false; everything else returns persist=true.
 * Returns `null` only for the very few cases where no rule shape applies
 * (currently nothing — kept in the signature so callers stay defensive).
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
    // Strip env-var prefixes so a `NODE_ENV=prod foo …` approval works
    // for plain `foo …` later — same key the matcher compares against.
    const exact = stripEnvVars(cmd)
    if (!exact) return null
    return { rule: { tool: toolName, pattern: exact, type: 'exact' }, persist: true }
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
  // Self-protect .x-code/local/ — permissions.json records auto-approved
  // shell-command patterns specific to this user's threat tolerance and
  // shouldn't leak into git history. Drop a `*` .gitignore on first write
  // so the directory is safe even when the user's project hasn't gitignored
  // .x-code/ as a whole.
  const gitignorePath = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n', 'utf-8')
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}
