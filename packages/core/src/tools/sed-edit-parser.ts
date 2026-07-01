// @x-code-cli/core — sed -i command parser & in-process substitution
//
// Intercepts simple `sed -i 's/pattern/replacement/flags' file` commands so
// the file-history checkpoint system can track the modification (the normal
// shell path doesn't call fileHistoryTrackEdit / add to filesModified).
//
// Only handles single-file, single-expression substitutions. Complex
// pipelines, multi-file globs, and non-substitution sed programs (d, y, a,
// etc.) fall through to real shell execution.
import { randomBytes } from 'node:crypto'

export type SedEditInfo = {
  filePath: string
  pattern: string
  replacement: string
  flags: string
  extendedRegex: boolean
}

// ── Shell tokenizer (simplified) ────────────────────────────────────────

/** Split a shell command string into tokens, respecting single and double
 *  quotes. Returns null if the command contains operators that make it
 *  unsafe to simulate (pipes, redirects, &&, ||, ;, backticks, $()). */
function tokenize(input: string): string[] | null {
  // Reject commands with shell operators — too complex to simulate safely
  if (/[|><;`]|&&|\|\||\$\(/.test(stripQuoted(input))) return null

  const tokens: string[] = []
  let current = ''
  let i = 0

  while (i < input.length) {
    const ch = input[i]!

    if (ch === "'") {
      const end = input.indexOf("'", i + 1)
      if (end === -1) return null // unclosed quote
      current += input.slice(i + 1, end)
      i = end + 1
      continue
    }

    if (ch === '"') {
      const end = findClosingDoubleQuote(input, i + 1)
      if (end === -1) return null
      current += input.slice(i + 1, end)
      i = end + 1
      continue
    }

    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1]
      i += 2
      continue
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      i++
      continue
    }

    current += ch
    i++
  }

  if (current.length > 0) tokens.push(current)
  return tokens
}

/** Strip single- and double-quoted substrings so operator detection doesn't
 *  trigger on characters inside quotes (e.g. `sed 's/a|b/c/'`). */
function stripQuoted(s: string): string {
  return s.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
}

function findClosingDoubleQuote(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      i++
      continue
    }
    if (s[i] === '"') return i
  }
  return -1
}

// ── BRE → ERE conversion placeholders ──────────────────────────────────

const PH_BACKSLASH = '\x00BS\x00'
const PH_PLUS = '\x00PL\x00'
const PH_QUESTION = '\x00QU\x00'
const PH_PIPE = '\x00PI\x00'
const PH_LPAREN = '\x00LP\x00'
const PH_RPAREN = '\x00RP\x00'

// ── Public API ─────────────────────────────────────────────────────────

/** Parse a shell command string. Returns info for simple `sed -i` in-place
 *  substitutions, or null for anything we can't safely simulate. */
export function parseSedEditCommand(command: string): SedEditInfo | null {
  const trimmed = command.trim()
  if (!/^\s*sed\s+/.test(trimmed)) return null

  const tokens = tokenize(trimmed.replace(/^\s*sed\s+/, ''))
  if (!tokens) return null

  let hasInPlace = false
  let extendedRegex = false
  let expression: string | null = null
  let filePath: string | null = null

  let i = 0
  while (i < tokens.length) {
    const arg = tokens[i]!

    // -i / --in-place (with optional inline or separate suffix)
    if (arg === '-i' || arg === '--in-place') {
      hasInPlace = true
      i++
      // macOS: -i '' (empty backup suffix as separate arg)
      if (i < tokens.length) {
        const next = tokens[i]
        if (typeof next === 'string' && !next.startsWith('-') && (next === '' || next.startsWith('.'))) {
          i++ // consume backup suffix
        }
      }
      continue
    }
    if (arg.startsWith('-i')) {
      hasInPlace = true // -i.bak etc.
      i++
      continue
    }

    // -E / -r / --regexp-extended
    if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') {
      extendedRegex = true
      i++
      continue
    }

    // -e / --expression (only one allowed)
    if (arg === '-e' || arg === '--expression') {
      if (expression !== null) return null
      if (i + 1 >= tokens.length) return null
      expression = tokens[i + 1]!
      i += 2
      continue
    }
    if (arg.startsWith('--expression=')) {
      if (expression !== null) return null
      expression = arg.slice('--expression='.length)
      i++
      continue
    }

    // Unknown flags → bail
    if (arg.startsWith('-')) return null

    // Positional arguments: expression first, then file path
    if (expression === null) {
      expression = arg
    } else if (filePath === null) {
      filePath = arg
    } else {
      return null // multiple files
    }
    i++
  }

  if (!hasInPlace || !expression || !filePath) return null

  // Parse s/pattern/replacement/flags
  if (!expression.startsWith('s/')) return null
  const rest = expression.slice(2)

  let pattern = ''
  let replacement = ''
  let flags = ''
  let state: 'pattern' | 'replacement' | 'flags' = 'pattern'
  let j = 0

  while (j < rest.length) {
    const ch = rest[j]!

    if (ch === '\\' && j + 1 < rest.length) {
      const escaped = ch + rest[j + 1]
      if (state === 'pattern') pattern += escaped
      else if (state === 'replacement') replacement += escaped
      else flags += escaped
      j += 2
      continue
    }

    if (ch === '/') {
      if (state === 'pattern') state = 'replacement'
      else if (state === 'replacement') state = 'flags'
      else return null // extra delimiter
      j++
      continue
    }

    if (state === 'pattern') pattern += ch
    else if (state === 'replacement') replacement += ch
    else flags += ch
    j++
  }

  if (state !== 'flags') return null

  if (!/^[gpimIM]*$/.test(flags)) return null

  return { filePath, pattern, replacement, flags, extendedRegex }
}

/** Apply a sed s/…/…/flags substitution to content in-process. */
export function applySedSubstitution(content: string, info: SedEditInfo): string {
  let regexFlags = ''
  if (info.flags.includes('g')) regexFlags += 'g'
  if (info.flags.includes('i') || info.flags.includes('I')) regexFlags += 'i'
  if (info.flags.includes('m') || info.flags.includes('M')) regexFlags += 'm'

  let jsPattern = info.pattern.replace(/\\\//g, '/')

  if (!info.extendedRegex) {
    jsPattern = jsPattern
      .replace(/\\\\/g, PH_BACKSLASH)
      .replace(/\\\+/g, PH_PLUS)
      .replace(/\\\?/g, PH_QUESTION)
      .replace(/\\\|/g, PH_PIPE)
      .replace(/\\\(/g, PH_LPAREN)
      .replace(/\\\)/g, PH_RPAREN)
      .replace(/\+/g, '\\+')
      .replace(/\?/g, '\\?')
      .replace(/\|/g, '\\|')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(new RegExp(PH_BACKSLASH, 'g'), '\\\\')
      .replace(new RegExp(PH_PLUS, 'g'), '+')
      .replace(new RegExp(PH_QUESTION, 'g'), '?')
      .replace(new RegExp(PH_PIPE, 'g'), '|')
      .replace(new RegExp(PH_LPAREN, 'g'), '(')
      .replace(new RegExp(PH_RPAREN, 'g'), ')')
  }

  const salt = randomBytes(8).toString('hex')
  const AMP_PH = `__ESC_AMP_${salt}__`
  const jsReplacement = info.replacement
    .replace(/\\\//g, '/')
    .replace(/\\&/g, AMP_PH)
    .replace(/&/g, '$$&')
    .replace(new RegExp(AMP_PH, 'g'), '&')

  try {
    return content.replace(new RegExp(jsPattern, regexFlags), jsReplacement)
  } catch {
    return content
  }
}
