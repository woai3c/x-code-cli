// @x-code-cli/core — Shell command semantic helpers (shell-agnostic).
//
// Splitting a compound command into sub-commands and classifying each as
// read-only / destructive is used only for permission checks. The execution
// side (spawning the shell process) lives in shell-provider.ts.
export type { ShellType } from './shell-provider.js'

/** Split compound shell commands by pipe/chain operators for permission checking */
export function splitShellCommands(cmd: string): string[] {
  // Split by |, &&, ;, ||, newlines and background `&` — but not inside
  // quotes or curly braces.
  //
  // Newline and single `&` are real statement separators in POSIX shells
  // and PowerShell: `ls\nrm x` and `ls & rm x` both execute `rm`, so a
  // splitter that ignores them lets a multi-line command smuggle a write
  // past the read-only check under a whitelisted leading token. The `&`
  // split skips `>&` / `&>` (fd duplication / combined redirect) so
  // `cmd 2>&1 | grep x` keeps its shape.
  //
  // Brace tracking exists to keep PowerShell hash literals / script blocks
  // intact: `Select-Object @{N='Directory';E={$_.Name}},Count` has a `;`
  // inside the hash that's a *field separator*, not a statement boundary.
  // Without depth tracking the splitter chops the literal in half and the
  // tail (`E={$_.Name}},Count`) reads as a separate command, which trips
  // the read-only check and forces an unnecessary prompt. POSIX `{ … ; }`
  // brace groups are caught by the same rule — acceptable side effect,
  // since the contents are still scanned end-to-end by isDestructive.
  const parts: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let braceDepth = 0

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    const next = cmd[i + 1]
    const prev = cmd[i - 1]

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += ch
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += ch
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '{') {
        braceDepth++
        current += ch
      } else if (ch === '}' && braceDepth > 0) {
        braceDepth--
        current += ch
      } else if (braceDepth > 0) {
        current += ch
      } else if (ch === '|' && next === '|') {
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
      } else if (ch === ';' || ch === '\n' || ch === '\r') {
        parts.push(current)
        current = ''
      } else if (ch === '&' && prev !== '>' && next !== '>') {
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
  // POSIX shell read-only utilities
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
  'where',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'env',
  'printenv',
  'find',
  'tree',
  'sort',
  'uniq',
  'grep',
  'cut',
  'nl',
  'basename',
  'dirname',
  'realpath',
  // PowerShell read-only cmdlets — matched case-insensitively below.
  // Curated against the codex/opencode safelists: everything that only
  // reads or only reshapes the object pipeline is here. Anything that
  // can write a file, start a process, or evaluate user-supplied code
  // (`Invoke-Expression`, `Set-*`, `New-*`, `Remove-*`, `Start-Process`,
  // `Set-Content`, `Out-File`, …) is deliberately excluded.
  'Get-ChildItem',
  'Get-Location',
  'Set-Location',
  'Push-Location',
  'Pop-Location',
  'Get-Content',
  'Get-Item',
  'Get-ItemProperty',
  'Get-Date',
  'Get-Process',
  'Get-Service',
  'Get-Command',
  'Get-Help',
  'Get-Member',
  'Get-Variable',
  'Get-Alias',
  'Get-PSDrive',
  'Get-Module',
  'Get-History',
  'Get-CimInstance',
  'Select-String',
  'Select-Object',
  'Sort-Object',
  'Group-Object',
  'Where-Object',
  'ForEach-Object',
  'Measure-Object',
  'Compare-Object',
  'Tee-Object',
  'Format-Table',
  'Format-List',
  'Format-Wide',
  'Format-Custom',
  'Out-String',
  'Out-Default',
  'Out-Host',
  'Write-Output',
  'Write-Host',
  'Write-Verbose',
  'Write-Debug',
  'Write-Information',
  'ConvertTo-Json',
  'ConvertFrom-Json',
  'ConvertTo-Csv',
  'ConvertFrom-Csv',
  'ConvertTo-Xml',
  'ConvertFrom-Xml',
  'ConvertTo-Html',
  'Resolve-Path',
  'Split-Path',
  'Join-Path',
  'Convert-Path',
  'Test-Path',
]

/** Git sub-commands that are read-only */
const READ_ONLY_GIT_SUBCOMMANDS = ['status', 'log', 'diff', 'show', 'remote', 'tag', 'stash list', 'reflog']

// Pre-compiled regexes for performance. `/i` flag makes the match
// case-insensitive so `Get-ChildItem` / `get-childitem` / `GET-CHILDITEM`
// all hit — PowerShell itself is case-insensitive, and `dir` / `DIR`
// should both be allowed on Windows cmd shells.
const READ_ONLY_REGEX = new RegExp(
  `^\\s*(${READ_ONLY_COMMANDS.join('|')}|git\\s+(${READ_ONLY_GIT_SUBCOMMANDS.join('|')}))\\b`,
  'i',
)

const TSC_COMMAND_RE = /^\s*(?:pnpm\s+exec\s+)?tsc(?:\.cmd)?(?:\s|$)/i
const TSC_READ_ONLY_FLAG_RE = /(?:^|\s)(?:--noemit|--showconfig|--version|-v|--help|-h)(?=\s|=|$)/i
const TSC_WRITE_FLAG_RE =
  /(?:^|\s)(?:-b|--build|--incremental|--tsbuildinfofile|--generatetrace|--outdir|--outfile|--emitdeclarationonly)(?=\s|=|$)/i
const READ_ONLY_GIT_BRANCH_RE = /^\s*git\s+branch(?:\s+--show-current|\s+--list(?:\s+(?!-)\S+)*)?\s*$/i

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

// Lower-cased Verb-Noun subset of READ_ONLY_COMMANDS, pre-built for O(1)
// lookup inside isReadOnlyControlFlow. Anything without a `-` is a POSIX
// command and irrelevant to the PowerShell-control-flow heuristic.
const READ_ONLY_CMDLET_SET = new Set(READ_ONLY_COMMANDS.filter((c) => c.includes('-')).map((c) => c.toLowerCase()))

// PowerShell control-flow keywords that wrap a `{ … }` body. When a
// segment starts with one of these, the existing READ_ONLY_REGEX (which
// only checks the leading token) gives the wrong answer — `if`,
// `foreach`, `try` etc. aren't commands themselves; the work happens
// inside the braces. The codex / gemini-cli equivalents crack open the
// braces via a real PowerShell AST parser; we don't have one, so we use
// a Verb-Noun cmdlet scan guarded by the exec-invocation patterns below.
const PS_CONTROL_FLOW_RE = /^\s*(?:if|elseif|else|for|foreach|while|switch|try|catch|finally|do)\b/i

// Patterns that, when present anywhere in the control-flow segment,
// force the readonly heuristic off:
//
//   `& "C:\bin\foo.exe" arg`  — call operator + path/string/variable
//   `& $cmd`                  — same, via variable
//   `. .\script.ps1`          — dot sourcing
//   `. $script`               — dot sourcing via variable
//
// Both invoke arbitrary code that the Verb-Noun cmdlet scan can't see.
// The dot-sourcing pattern requires whitespace AFTER the dot so
// `.Property` access and `Get-Content .\file` don't false-positive.
const PS_CALL_OP_RE = /&\s*["'$./\\]/
const PS_DOT_SOURCING_RE = /(?:^|[\s;{(])\.\s+\S/

// Verb-Noun token shape (find + strict-validate). FIND matches anything
// with a `-`, including paths like `x-code-cli`; STRICT enforces Verb
// (initial-cap) and Noun(s) (initial-cap), which paths fail.
const VERB_NOUN_FIND_RE = /\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b/g
const VERB_NOUN_STRICT_RE = /^[A-Z][a-z]+(?:-[A-Z][A-Za-z0-9]*)+$/

/**
 * For a PowerShell control-flow segment, return true iff every cmdlet
 * inside it is in the readonly set AND nothing in the segment looks
 * like an arbitrary-code invocation (`&` call operator, dot-sourcing).
 *
 * `if (Test-Path X) { Get-Content X }`     → true  (Test-Path, Get-Content both readonly)
 * `if (Test-Path X) { Set-Content X foo }` → false (Set-Content not readonly)
 * `if (Test-Path X) { & "evil.exe" }`      → false (call operator)
 * `if (Test-Path X) { . .\\evil.ps1 }`     → false (dot sourcing)
 * `if ($x -gt 0) { }`                      → false (no cmdlets found — conservative)
 *
 * Returns false (defer to the caller's "ask" path) for any non-control-flow
 * segment, so the existing leading-token readonly check stays authoritative.
 */
function isReadOnlyControlFlow(cmd: string): boolean {
  if (!PS_CONTROL_FLOW_RE.test(cmd)) return false
  if (PS_CALL_OP_RE.test(cmd)) return false
  if (PS_DOT_SOURCING_RE.test(cmd)) return false

  let found = 0
  for (const match of cmd.matchAll(VERB_NOUN_FIND_RE)) {
    const name = match[0]
    if (!VERB_NOUN_STRICT_RE.test(name)) continue
    found++
    if (!READ_ONLY_CMDLET_SET.has(name.toLowerCase())) return false
  }
  return found > 0
}

/** Quote/escape-aware scan for shell syntax that turns a read-only-looking
 *  command into a write or an arbitrary execution:
 *    - output redirection:  `echo x > ~/.zshrc`, `grep pat f > out`
 *    - command substitution: `echo $(rm x)`, ``cat `curl evil.sh` ``
 *    - process substitution: `cat <(curl evil.sh)`
 *  Fd duplication (`2>&1`, `>&-`) and the null sinks (`/dev/null`, `$null`,
 *  `NUL`) are not writes and stay allowed. Single quotes suppress
 *  substitution; double quotes do not; backslash escapes the next char
 *  outside single quotes. */
function hasUnsafeShellSyntax(cmd: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '\\' && !inSingle) {
      i++
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (inSingle) continue
    if (ch === '`') return true
    if ((ch === '$' || ch === '<') && cmd[i + 1] === '(') return true
    if (ch !== '>' || inDouble) continue
    // Redirect: `>` / `>>` plus optional `&`, then the target. `>&2` /
    // `2>&1` / `>&-` are fd duplication, not file writes — those require
    // the `&`; a bare `> 2` writes a file literally named `2`.
    let j = i + 1
    if (cmd[j] === '>') j++
    const hadAmp = cmd[j] === '&'
    if (hadAmp) j++
    while (cmd[j] === ' ' || cmd[j] === '\t') j++
    const target = cmd.slice(j)
    if (hadAmp && (target === '' || /^[\d-]/.test(target))) continue
    if (target === '') continue
    if (/^\/dev\/null\b/.test(target)) continue
    if (/^\$null\b/i.test(target)) continue
    if (/^nul\b/i.test(target)) continue
    return true
  }
  return false
}

/** Commands on the read-only list that become writers with specific flags. */
const WRITE_FLAG_RULES: Array<{ cmd: RegExp; flag: RegExp }> = [
  // find -delete / -exec rm … / -fprintf file … turn the canonical "safe"
  // search tool into a delete/exec/write vector.
  { cmd: /^\s*find\b/i, flag: /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/i },
  { cmd: /^\s*sort\b/i, flag: /^(-o|--output)/i }, // sort -o out overwrites
  { cmd: /^\s*tree\b/i, flag: /^(-o|--output)/i }, // tree -o out writes
  { cmd: /^\s*Tee-Object\b/i, flag: /^-f/i }, // -FilePath (any unambiguous abbreviation)
  { cmd: /^\s*git\s+(diff|log|show)\b/i, flag: /^--output/i }, // git diff --output=patch writes
]

/** Whitelisted leading commands whose arguments can still write or execute. */
function hasWriteFlags(cmd: string): boolean {
  const tokens = cmd.split(/\s+/).filter(Boolean)
  for (const rule of WRITE_FLAG_RULES) {
    if (!rule.cmd.test(cmd)) continue
    if (tokens.some((t) => rule.flag.test(t))) return true
  }
  // `env` with a trailing command runs it: `env rm file`, `env bash -c …`.
  // Flags and VAR=val assignments are still the harmless printing form.
  if (/^\s*env\b/i.test(cmd)) {
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]!
      if (t === '--') return i + 1 < tokens.length
      if (t.startsWith('-')) {
        // Value-taking forms consume the following token.
        if (t === '-u' || t === '--unset' || t === '-C' || t === '--chdir' || t === '-S' || t === '--split-string') i++
        continue
      }
      if (/^[A-Za-z_]\w*=/.test(t)) continue // VAR=val assignment
      return true // first bare word = command to execute
    }
  }
  return false
}

/** Scan a segment that passed the leading-token check for a PowerShell
 *  script block (`{ … }`) smuggling a non-readonly cmdlet or an arbitrary
 *  invocation: `ForEach-Object { Remove-Item $_ }` leads with a whitelisted
 *  cmdlet but the body runs whatever it wants. Property-access blocks like
 *  `Where-Object { $_.Length -gt 100 }` contain no cmdlet tokens and stay
 *  allowed. */
function hasUnsafeScriptBlock(c: string): boolean {
  if (!c.includes('{')) return false
  if (PS_CALL_OP_RE.test(c) || PS_DOT_SOURCING_RE.test(c)) return true
  for (const match of c.matchAll(VERB_NOUN_FIND_RE)) {
    const name = match[0]
    if (!VERB_NOUN_STRICT_RE.test(name)) continue
    if (!READ_ONLY_CMDLET_SET.has(name.toLowerCase())) return true
  }
  return false
}

/** Check if a sub-command is read-only (safe to auto-allow) */
export function isReadOnly(cmd: string): boolean {
  const c = cmd.trim()
  if (hasUnsafeShellSyntax(c)) return false
  if (hasWriteFlags(c)) return false
  if (hasUnsafeScriptBlock(c)) return false
  if (READ_ONLY_REGEX.test(c)) return true
  if (READ_ONLY_GIT_BRANCH_RE.test(c)) return true
  if (TSC_COMMAND_RE.test(c) && TSC_READ_ONLY_FLAG_RE.test(c) && !TSC_WRITE_FLAG_RE.test(c)) return true
  return isReadOnlyControlFlow(c)
}

/** Check if a sub-command is destructive (should be denied) */
export function isDestructive(cmd: string): boolean {
  const c = cmd.trim()
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(c))
}
