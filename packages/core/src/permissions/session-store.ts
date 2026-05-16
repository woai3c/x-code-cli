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
// The capture group exposes the name so the whitelist can decide whether
// to strip the prefix or treat it as a poison pill (see SAFE_ENV_VARS).
const ENV_VAR_RE = /^([A-Za-z_]\w*)=[A-Za-z0-9_./:@-]*\s+/

// Env-var names safe to strip before deriving a "don't ask again" prefix.
// Deliberately conservative — anything that could shift program behaviour
// in security-relevant ways (PATH, LD_*, NODE_OPTIONS, http(s)_proxy,
// DYLD_*, …) is excluded so a non-whitelisted assignment downgrades the
// rule to exact-match. Without that, an agent could smuggle unaudited env
// into an already-approved command shape.
//
// Picked to cover the common NODE_ENV / CI / DEBUG / locale / color
// settings agents emit in practice, mirroring the spirit of Claude Code's
// SAFE_ENV_VARS list.
const SAFE_ENV_VARS = new Set([
  'NODE_ENV',
  'PYTHONUNBUFFERED',
  'PYTHONIOENCODING',
  'PYTHONDONTWRITEBYTECODE',
  'CI',
  'DEBUG',
  'FORCE_COLOR',
  'NO_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'TERM',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_TIME',
  'LC_COLLATE',
  'TZ',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'LESS',
])

// First-token wrappers too broad to anchor a "don't ask again" rule on.
// `sudo ls` once approved must NOT auto-approve `sudo <anything>`, and we
// don't (yet) crack open `bash -c "<inner>"` to re-extract — so for these
// we return null and force exact-match. `sudo` is also caught upstream by
// isDestructive(); listed here for defence-in-depth.
const WRAPPER_BLOCKLIST = new Set([
  'sudo',
  'doas',
  'su',
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'cmd',
  'env',
  'time',
  'nice',
  'ionice',
  'timeout',
  'nohup',
  'xargs',
  'watch',
  'parallel',
  'exec',
  'eval',
])

// Per-command global-flag tables: tokens between `cmd` and its real
// subcommand. Without these, `git -C /tmp commit` would extract `git -C`
// and miss every prefix rule the user has for `git commit`.
//
// `valued` flags consume the following token; everything else starting
// with `-` is treated as a boolean flag (skip one). `--name=value` is
// detected by the embedded `=`. `cargo +toolchain` is the one non-flag
// token kind that needs skipping; gated by `takesPlus`.
const GLOBAL_FLAGS: Record<string, { valued: Set<string>; takesPlus?: boolean }> = {
  git: {
    valued: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']),
  },
  docker: {
    valued: new Set([
      '-H',
      '--host',
      '--config',
      '--context',
      '-c',
      '--log-level',
      '--tlscacert',
      '--tlscert',
      '--tlskey',
    ]),
  },
  podman: {
    valued: new Set(['--connection', '-c', '--log-level', '--root', '--runroot', '--storage-driver', '--url']),
  },
  kubectl: {
    valued: new Set([
      '-n',
      '--namespace',
      '--context',
      '--cluster',
      '--kubeconfig',
      '--server',
      '-s',
      '--user',
      '--token',
      '--as',
      '--as-group',
      '--cache-dir',
      '--certificate-authority',
      '--client-certificate',
      '--client-key',
    ]),
  },
  cargo: {
    valued: new Set(['--config', '-Z', '--color', '--manifest-path']),
    takesPlus: true,
  },
}

// Subcommand-name shape: lowercase letter, then [a-z0-9-]. Hyphens only
// internal (no trailing dash). Filters out `-flag`, `/flag`, and paths.
const SUBCOMMAND_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

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
 * Returns `null` when no meaningful prefix can be safely derived —
 * callers fall back to exact-match.
 *
 *   'git commit -m "fix"'                                    → 'git commit'
 *   'git -C /tmp commit -m fix'                              → 'git commit'
 *   'docker -H tcp://host:2375 ps'                           → 'docker ps'
 *   'kubectl -n prod get pods'                               → 'kubectl get'
 *   'cargo +nightly build --release'                         → 'cargo build'
 *   'pnpm run build'                                         → 'pnpm run'
 *   'npm install lodash'                                     → 'npm install'
 *   'NODE_ENV=prod npm run dev'                              → 'npm run'
 *   'FOO=1 git status'                                       → null   (unsafe env)
 *   'sudo npm install'                                       → null   (wrapper)
 *   'bash -c "git status"'                                   → null   (wrapper)
 *   'powershell -Command "Get-CimInstance ..."'              → 'Get-CimInstance'
 *   'powershell -NoProfile -Command "Get-CimInstance ..."'   → 'Get-CimInstance'
 *   'powershell -ExecutionPolicy Bypass -c "git status"'     → 'git'
 *   'pwsh -Command "& { Get-Process }"'                      → 'Get-Process'
 *   'powershell -Command Get-Date'                           → 'Get-Date'
 *   'ls -la'                                                 → null
 *   ''                                                       → null
 */
export function extractCommandPrefix(command: string): string | null {
  const cmd = command.trim()
  if (!cmd) return null

  // PowerShell first — its argument syntax doesn't follow the POSIX
  // VAR=value convention so the env-var stripping below doesn't apply.
  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    return extractPowershellPrefix(cmd)
  }

  const tokens = cmd.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  // Per-token env-var stripping. An env-var-shaped token (NAME=…) at the
  // head must be either whitelisted or it's a hard stop — otherwise an
  // agent could smuggle PATH=/evil, NODE_OPTIONS=--require ./evil.js,
  // http_proxy=…, etc. into a rule shaped like `npm run`. Value chars are
  // intentionally not constrained at this layer: it's the NAME that gates
  // safety, and an arbitrary value class would let weird-but-safe values
  // (`/`, `$`, `:`) bypass the check entirely.
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]!
    const m = /^([A-Za-z_]\w*)=/.exec(tok)
    if (!m) break
    if (!SAFE_ENV_VARS.has(m[1]!)) return null
    // A quoted value split across whitespace (`FOO="a b" cmd`) means our
    // \s+ tokenizer broke the value boundary. We can't tell where the
    // value ends without a real shell parser, so refuse the prefix.
    const value = tok.slice(m[0].length)
    if (hasUnclosedQuote(value)) return null
    i++
  }

  const rest = tokens.slice(i)
  if (rest.length < 2) return null

  const firstLower = rest[0]!.toLowerCase()
  if (WRAPPER_BLOCKLIST.has(firstLower)) return null

  const subIdx = skipGlobalFlags(rest, firstLower)
  if (subIdx >= rest.length) return null

  const sub = rest[subIdx]!
  if (!SUBCOMMAND_RE.test(sub)) return null

  return `${rest[0]} ${sub}`
}

function hasUnclosedQuote(s: string): boolean {
  let sq = 0
  let dq = 0
  for (const ch of s) {
    if (ch === "'") sq++
    else if (ch === '"') dq++
  }
  return sq % 2 === 1 || dq % 2 === 1
}

function skipGlobalFlags(tokens: string[], firstLower: string): number {
  const cfg = GLOBAL_FLAGS[firstLower]
  if (!cfg) return 1
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]!
    if (cfg.takesPlus && tok.startsWith('+')) {
      i++
      continue
    }
    if (!tok.startsWith('-')) break
    // --flag=value: single token, advance once.
    if (tok.includes('=')) {
      i++
      continue
    }
    if (cfg.valued.has(tok)) {
      i += 2
      continue
    }
    // Unknown boolean-style flag — best-effort skip. Erring toward "find
    // the subcommand" matches what users see at the CLI.
    i++
  }
  return i
}

function extractPowershellPrefix(cmd: string): string | null {
  const tokens = cmd.split(/\s+/).filter(Boolean)
  let i = 1 // skip launcher
  while (i < tokens.length) {
    const tok = tokens[i]!
    if (!tok.startsWith('-')) break
    const lower = tok.toLowerCase()
    if (lower === '-command' || lower === '-c') {
      i++
      break
    }
    if (lower === '-file') return null
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
    i++
  }
  if (i >= tokens.length) return null
  const inner = tokens.slice(i).join(' ')
  const m = PS_INNER_CMD_RE.exec(inner)
  return m?.[1] ?? null
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
    // Strip *safe* env-var prefixes only — same key the matcher compares
    // against (stripSafeEnvVars). Non-whitelisted assignments stay in the
    // pattern so an approval for `BACKDOOR=1 findstr …` doesn't
    // accidentally auto-allow `findstr …` on its own.
    const exact = stripSafeEnvVars(cmd)
    if (!exact) return null
    return { rule: { tool: toolName, pattern: exact, type: 'exact' }, persist: true }
  }
  return { rule: { tool: toolName, pattern: '*', type: 'tool' }, persist: false }
}

function stripSafeEnvVars(command: string): string {
  let cmd = command.trim()
  while (true) {
    const m = ENV_VAR_RE.exec(cmd)
    if (!m) break
    if (!SAFE_ENV_VARS.has(m[1]!)) break
    cmd = cmd.slice(m[0].length)
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
        if (rule.type === 'exact' && stripSafeEnvVars(cmd) === rule.pattern) return true
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
