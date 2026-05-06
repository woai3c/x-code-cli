// @x-code-cli/cli — Per-line syntax highlighter for the diff renderer.
//
// Why in-house: every off-the-shelf Node terminal highlighter we looked
// at (cli-highlight, chalk-highlight, etc.) either pulls in highlight.js
// (~600KB) or hasn't seen a release in years. The diff use case here is
// narrow — we only highlight ~60 lines per diff, on a dark bg, and we
// only need to recognize the common token classes. ~150 lines of regex
// gives us 80% of the visual benefit at 0.1% of the dep weight.
//
// Per-LINE: the highlighter takes one diff line at a time. That means
// we lose state across lines (block comments split by a hunk boundary
// won't keep highlighting through context rows), but it matches how
// Claude Code's StructuredDiff fallback renders too — each line is its
// own React node. For the diff use case that limitation is invisible
// in practice: a hunk's context window is 3 lines, and you very rarely
// get a `/* ... */` straddling exactly those lines.
//
// Theme system: a small set of named palettes (one-dark, monokai,
// dracula, github-dark, solarized-dark, ansi, off). The active palette
// is held in a module-level ref initialized from `~/.x-code/config.json`
// at startup and flipped at runtime by `/syntax <name>`. Any rendering
// path that wants the current palette calls `highlightLine` with no
// theme arg — that picks up the live module ref. Tests and previews
// can pass an explicit theme to bypass the global.
import { Chalk } from 'chalk'

const c = new Chalk({ level: 3 })

// ─── Themes ───

/** Token kinds the highlighter emits. Each theme maps these to colors.
 *
 *  `storage` is split from `keyword` to match CC / syntect's convention:
 *  control-flow keywords (`if`, `return`, `throw`) use `keyword`, while
 *  declaration keywords (`const`, `let`, `function`, `class`, `interface`)
 *  use `storage`. In Monokai these come out as hot-pink and cyan
 *  respectively — without the split, `function` ends up the same color
 *  as `if`, which doesn't match CC. See CC color-diff/index.ts:248-265. */
type Token = 'keyword' | 'storage' | 'type' | 'string' | 'number' | 'comment' | 'function' | 'literal'

/** Palette: a color (hex `#rrggbb`, ANSI name like `'magenta'`, or `null`
 *  to mean "leave fg alone — use terminal default"). Null is the trick
 *  that lets the `'off'` theme pass tokens through unchanged without
 *  needing a separate code path. */
type ColorSpec = string | null
type Palette = Record<Token, ColorSpec>

/** Built-in syntax themes. Names are lowercase-kebab. `'off'` is a real
 *  entry — it disables every paint() call by setting every color to
 *  null.
 *
 *  Two palettes are CC-derived: `monokai` (CC's "Monokai Extended" —
 *  bundled with all dark `/theme` modes) and `github-light` (CC's
 *  "GitHub" — bundled with all light `/theme` modes). The other names
 *  predate the CC parity work. */
export type SyntaxThemeName =
  | 'one-dark'
  | 'monokai'
  | 'dracula'
  | 'github-dark'
  | 'github-light'
  | 'solarized-dark'
  | 'ansi'
  | 'off'

const THEMES: Record<SyntaxThemeName, Palette> = {
  // One Dark — Atom's signature theme. Calm, well-balanced contrast on
  // dark bg. Good default for most users.
  'one-dark': {
    keyword: '#c678dd', // purple
    storage: '#c678dd', // purple — One Dark groups storage with keyword
    type: '#e5c07b', // sand yellow
    string: '#98c379', // mossy green
    number: '#d19a66', // warm orange
    comment: '#7f848e', // dim cool gray
    function: '#61afef', // light blue
    literal: '#d19a66', // orange (same family as numbers)
  },
  // Monokai — Sublime Text's classic. Punchy, high-saturation. Values
  // match CC's MONOKAI_SCOPES (native-ts/color-diff/index.ts:190-215)
  // byte-for-byte so dark-mode diffs render with the same syntax
  // colors as Claude Code's "Monokai Extended" syntect theme.
  monokai: {
    keyword: '#f92672', // hot pink — control keywords (if/return/throw)
    storage: '#66d9ef', // cyan — declaration keywords (const/let/function/class)
    type: '#a6e22e', // chartreuse — types, built-ins
    string: '#e6db74', // muted yellow
    number: '#be84ff', // pastel purple — numbers/literals (CC rgb 190,132,255)
    comment: '#75715e', // brown-gray
    function: '#a6e22e', // chartreuse — function/class titles (CC groups w/ types)
    literal: '#be84ff', // pastel purple
  },
  // Dracula — popular dark theme with a pastel palette.
  dracula: {
    keyword: '#ff79c6', // pink
    storage: '#ff79c6', // pink — Dracula groups storage with keyword
    type: '#8be9fd', // cyan
    string: '#f1fa8c', // pale yellow
    number: '#bd93f9', // lavender
    comment: '#6272a4', // blue-gray
    function: '#50fa7b', // mint green
    literal: '#bd93f9', // lavender
  },
  // GitHub Dark — matches GitHub.com's dark-mode code blocks.
  'github-dark': {
    keyword: '#ff7b72', // salmon
    storage: '#ff7b72', // salmon
    type: '#ffa657', // orange
    string: '#a5d6ff', // light blue
    number: '#79c0ff', // blue
    comment: '#8b949e', // gray
    function: '#d2a8ff', // lavender
    literal: '#79c0ff', // blue
  },
  // GitHub Light — values match CC's GITHUB_SCOPES (native-ts/color-diff/
  // index.ts:218-243) byte-for-byte. Tuned for LIGHT terminals: deep
  // saturated colors that read well on white. Bundled with the
  // light / light-daltonized /theme modes.
  'github-light': {
    keyword: '#a71d5d', // deep magenta — control keywords
    storage: '#a71d5d', // deep magenta — GitHub groups storage with keyword
    type: '#0086b3', // teal — types, built-ins, numbers, literals
    string: '#183691', // navy — strings
    number: '#0086b3', // teal
    comment: '#969896', // medium gray
    function: '#795da3', // purple — function/class titles
    literal: '#0086b3', // teal
  },
  // Solarized Dark — Ethan Schoonover's much-imitated low-contrast theme.
  'solarized-dark': {
    keyword: '#859900', // moss green
    storage: '#cb4b16', // burnt orange — separates declarations
    type: '#b58900', // gold
    string: '#2aa198', // teal
    number: '#d33682', // magenta
    comment: '#586e75', // slate
    function: '#268bd2', // blue
    literal: '#d33682', // magenta
  },
  // ANSI — uses the terminal's 16-color palette (named chalk colors).
  // Looks correct everywhere, even dumb terminals; trades fidelity for
  // compatibility. Values are byte-aligned to CC's `ANSI_SCOPES` (color-
  // diff/index.ts:267-280): every entry uses `ansiIdx(N)` with N in
  // 10-14, i.e. the BRIGHT palette half. We previously used the normal
  // 0-7 names which made our ANSI mode look noticeably dimmer / less
  // saturated than CC's. Mapping:
  //   keyword         = ansiIdx(13) = bright magenta
  //   _storage        = ansiIdx(14) = bright cyan
  //   built_in / type = ansiIdx(14) = bright cyan
  //   string          = ansiIdx(10) = bright green
  //   number / literal = ansiIdx(12) = bright blue
  //   title.function  = ansiIdx(11) = bright yellow
  //   comment         = ansiIdx(8)  = bright black (chalk `gray`)
  ansi: {
    keyword: 'magentaBright',
    storage: 'cyanBright',
    type: 'cyanBright',
    string: 'greenBright',
    number: 'blueBright',
    comment: 'gray',
    function: 'yellowBright',
    literal: 'blueBright',
  },
  // Off — every token color is null so paint() is an identity. This
  // keeps the hot path branchless: the rule loop still runs (cheap on
  // ~60-line inputs), it just doesn't insert any escape codes.
  off: {
    keyword: null,
    storage: null,
    type: null,
    string: null,
    number: null,
    comment: null,
    function: null,
    literal: null,
  },
}

/** Display labels for the picker. Order is intentional — sorted by
 *  popularity so the first row of the picker is the most common pick. */
export const SYNTAX_THEME_DESCRIPTIONS: { name: SyntaxThemeName; label: string; description: string }[] = [
  { name: 'one-dark', label: 'One Dark', description: 'Atom signature — calm, balanced contrast (default)' },
  { name: 'monokai', label: 'Monokai', description: 'Sublime classic — punchy, high saturation' },
  { name: 'dracula', label: 'Dracula', description: 'Popular dark theme with pastel palette' },
  { name: 'github-dark', label: 'GitHub Dark', description: "Match GitHub's dark-mode code blocks" },
  { name: 'solarized-dark', label: 'Solarized Dark', description: 'Low-contrast, easy on the eyes' },
  { name: 'ansi', label: 'ANSI', description: 'Use the terminal 16-color palette — works everywhere' },
  { name: 'off', label: 'Off', description: 'Disable syntax highlighting entirely' },
]

export const DEFAULT_SYNTAX_THEME: SyntaxThemeName = 'one-dark'

/** Active theme — read by `highlightLine` when no explicit theme arg is
 *  passed. Initialized to default; flipped by `setSyntaxTheme` on
 *  startup (from user config) and again when the user runs `/syntax`. */
let currentTheme: SyntaxThemeName = DEFAULT_SYNTAX_THEME

export function setSyntaxTheme(name: SyntaxThemeName): void {
  currentTheme = name
}

export function getSyntaxTheme(): SyntaxThemeName {
  return currentTheme
}

/** Validate / coerce an arbitrary string into a SyntaxThemeName. Used
 *  when reading user config (which is `unknown`-typed) and parsing
 *  slash-command arguments. Returns null for anything we don't
 *  recognize so the caller can show a helpful error. */
export function parseSyntaxThemeName(input: unknown): SyntaxThemeName | null {
  if (typeof input !== 'string') return null
  const normalized = input
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
  // Common alias mappings — matches what users might type.
  const aliases: Record<string, SyntaxThemeName> = {
    onedark: 'one-dark',
    one: 'one-dark',
    atom: 'one-dark',
    mono: 'monokai',
    sublime: 'monokai',
    drac: 'dracula',
    gh: 'github-dark',
    github: 'github-dark',
    'gh-dark': 'github-dark',
    solarized: 'solarized-dark',
    sol: 'solarized-dark',
    sold: 'solarized-dark',
    none: 'off',
    disable: 'off',
    disabled: 'off',
    plain: 'off',
  }
  if (normalized in aliases) return aliases[normalized]!
  if (normalized in THEMES) return normalized as SyntaxThemeName
  return null
}

// ─── Language detection ───

/** Languages we have specific tokenizer rules for. Anything not in this
 *  set falls back to plain text (no highlighting), which is still a
 *  valid render — just less colorful. */
type Lang = 'js' | 'json' | 'html' | 'css' | 'yaml' | 'shell' | 'python' | 'go' | 'rust' | 'md'

/** Single lookup table for both file extensions (used by detectLanguage)
 *  and markdown fence-language identifiers (used by detectFenceLanguage).
 *  Keys are lowercase. Most entries are valid in both contexts (e.g. `ts`,
 *  `py`, `rs`); fence-only aliases like `typescript`, `python`, `golang`,
 *  `rust`, `javascript`, `shell` simply produce no match for file paths
 *  since extensions don't use those forms. Extension-only entries like
 *  `mts` / `cts` similarly produce no match for fences in practice. */
const LANG_LOOKUP: Record<string, Lang> = {
  // JS / TS family — share the same tokenizer (TS-isms like `interface`,
  // `type`, `enum` are treated as keywords; the tokenizer is permissive
  // by design, false positives in raw JS are not visually offensive).
  ts: 'js',
  tsx: 'js',
  typescript: 'js',
  js: 'js',
  jsx: 'js',
  javascript: 'js',
  mjs: 'js',
  cjs: 'js',
  mts: 'js',
  cts: 'js',
  vue: 'js', // Vue SFCs are mostly TS — close enough for diff display
  svelte: 'js',
  // Data formats
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  // Web
  html: 'html',
  htm: 'html',
  xml: 'html',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  // Config
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'yaml', // close enough for diff coloring (key=value, strings, numbers)
  // Shell
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  // Other
  py: 'python',
  python: 'python',
  go: 'go',
  golang: 'go',
  rs: 'rust',
  rust: 'rust',
  md: 'md',
  markdown: 'md',
}

export function detectLanguage(filePath: string): Lang | null {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filePath)
  if (!m) return null
  return LANG_LOOKUP[m[1]!.toLowerCase()] ?? null
}

/** Map a markdown fence-language identifier (the bit after the opening
 *  ``` on a fenced code block) to one of our supported `Lang` values.
 *  Returns null when the fence had no language hint or the language
 *  isn't covered — caller falls back to plain (un-highlighted) text. */
export function detectFenceLanguage(fenceLang: string | undefined): Lang | null {
  if (!fenceLang) return null
  return LANG_LOOKUP[fenceLang.trim().toLowerCase()] ?? null
}

// ─── Tokenization ───

interface Rule {
  re: RegExp
  token: Token
}

/** Build a single sticky regex (`y` flag, anchored at lastIndex) from
 *  the rule set. We try each rule in order at the current position; the
 *  first match wins. Patterns must be authored to avoid catastrophic
 *  backtracking — kept simple and bounded throughout. */
function makeRules(rules: { re: RegExp; token: Token }[]): Rule[] {
  return rules.map(({ re, token }) => ({
    // Force sticky so we can scan position-by-position in the loop below.
    // The original `re` may already include `y`; if not, recreate it with
    // the same pattern + sticky flag.
    re: re.flags.includes('y') ? re : new RegExp(re.source, re.flags + 'y'),
    token,
  }))
}

/** Storage / declaration keywords — render in the `storage` token color
 *  to match CC's `_storage` scope (color-diff/index.ts:248-265). One
 *  global set across languages: hljs / syntect treat these as the same
 *  scope regardless of source language, and the words don't overlap
 *  with anything that needs different coloring. */
const STORAGE_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'type',
  'interface',
  'enum',
  'namespace',
  'module',
  'def',
  'fn',
  'func',
  'struct',
  'trait',
  'impl',
])

/** JS / TS global "support" objects — what hljs scopes as `built_in`
 *  and CC's MONOKAI_SCOPES paints chartreuse green (color-diff/
 *  index.ts:193). Routing these to the `function` palette slot is what
 *  makes `console.log(...)` come out as **green** `console` + plain
 *  `log` — matching CC. Without this, our previous "identifier
 *  followed by `(`" heuristic painted `log` (the method) green and
 *  left `console` (the global) plain, which the user noticed was
 *  the exact inverse of CC. */
const JS_GLOBALS = new Set([
  'console',
  'globalThis',
  'window',
  'document',
  'process',
  'module',
  'exports',
  'require',
  '__dirname',
  '__filename',
  'global',
  'self',
  'Math',
  'JSON',
  'Symbol',
  'Reflect',
  'Atomics',
  'Intl',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'BigInt',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'Proxy',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'encodeURIComponent',
  'decodeURI',
  'decodeURIComponent',
])

const KEYWORDS_JS = new Set([
  'await',
  'async',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'try',
  'type',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'as',
  'declare',
  'namespace',
  'satisfies',
  'override',
])

const LITERALS_JS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])

const KEYWORDS_PYTHON = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
])

const KEYWORDS_GO = new Set([
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
  'true',
  'false',
  'nil',
])

const KEYWORDS_RUST = new Set([
  'as',
  'async',
  'await',
  'break',
  'const',
  'continue',
  'crate',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
])

const KEYWORDS_SHELL = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'while',
  'until',
  'do',
  'done',
  'function',
  'in',
  'return',
  'exit',
  'export',
  'local',
  'readonly',
  'unset',
  'echo',
  'printf',
  'source',
])

/** Keyword classification for the simple-grammar languages: look the word
 *  up in the language's keyword set, optionally classify PascalCase as a
 *  type. JS has its own richer logic (LITERALS / GLOBALS / PascalCase) so
 *  it isn't in this table. */
const KEYWORD_RULES: Partial<Record<Lang, { keywords: Set<string>; pascalAsType?: boolean }>> = {
  python: { keywords: KEYWORDS_PYTHON, pascalAsType: true },
  go: { keywords: KEYWORDS_GO, pascalAsType: true },
  rust: { keywords: KEYWORDS_RUST, pascalAsType: true },
  shell: { keywords: KEYWORDS_SHELL },
}

// ─── Per-language rule tables ───
//
// Each rule list is tried in order at every byte position. The first
// rule that matches consumes those characters and emits a colored
// fragment. Important: comment / string / number rules MUST come before
// the identifier rule so a string like `"if"` doesn't get its inner
// `if` highlighted as a keyword.

function jsRules(): Rule[] {
  return makeRules([
    { re: /\/\/[^\n]*/, token: 'comment' },
    // Bounded block comment to keep regex non-catastrophic — anything
    // over 500 chars on one line is pathological anyway and we'd rather
    // bail than hang.
    { re: /\/\*[\s\S]{0,500}?\*\//, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    { re: /`(?:[^`\\]|\\.){0,500}`/, token: 'string' },
    { re: /0[xX][0-9a-fA-F]+n?/, token: 'number' },
    { re: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b/, token: 'number' },
    // Declaration-name capture: after `function` / `class` / `interface`
    // / `type` / `enum` / `namespace`, the next identifier is a `title.*`
    // scope in hljs. We collapse all of them onto the `function` token
    // because CC's three themes treat `title.function` and `title.class`
    // identically: monokai chartreuse, ansi bright yellow. (github-light
    // is the one mismatch — `title.class` is black there but we keep
    // class names in the `function` slot to stay correct in monokai/ansi
    // mode where the user sees the difference more sharply.)
    {
      re: /(?<=\b(?:function|class|interface|type|enum|namespace)\s+)[A-Za-z_$][\w$]*/,
      token: 'function',
    },
    // Generic identifier — keyword / literal / global / type lookup
    // happens in paint(). NOTE: we deliberately do NOT have a generic
    // "identifier followed by `(`" rule here. Per CC's hljs scoping,
    // method calls like `obj.method(...)` paint `method` as `property`
    // (= default fg, no color), not as a function name. The previous
    // heuristic painted `log` chartreuse — flipping the visual against
    // CC. Function CALLS are now plain by design.
    { re: /[A-Za-z_$][\w$]*/, token: 'keyword' },
  ])
}

function jsonRules(): Rule[] {
  return makeRules([
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, token: 'number' },
    { re: /\b(?:true|false|null)\b/, token: 'literal' },
  ])
}

function htmlRules(): Rule[] {
  return makeRules([
    { re: /<!--[\s\S]{0,500}?-->/, token: 'comment' },
    // Tag names: `<TagName` and `</TagName`. Yellow.
    { re: /<\/?[A-Za-z][\w-]*/, token: 'type' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    // Attribute names — not perfect (matches loose ids too) but close.
    { re: /\b[a-zA-Z_:][\w:.-]*(?=\s*=)/, token: 'function' },
  ])
}

function cssRules(): Rule[] {
  return makeRules([
    { re: /\/\*[\s\S]{0,500}?\*\//, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    // Selectors with `.foo`, `#bar`, `:hover` — yellow.
    { re: /[#.][a-zA-Z_-][\w-]*/, token: 'type' },
    { re: /:[a-zA-Z-]+(?:\([^)]*\))?/, token: 'function' },
    // Property names (identifier directly followed by `:`).
    { re: /\b[a-zA-Z-]+(?=\s*:)/, token: 'function' },
    // #hex colors and numeric values (with optional unit).
    { re: /#[0-9a-fA-F]{3,8}\b/, token: 'number' },
    { re: /-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|deg|s|ms|fr)?\b/, token: 'number' },
  ])
}

function yamlRules(): Rule[] {
  return makeRules([
    { re: /#[^\n]*/, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    // Key followed by `:` (at start-ish of line; we don't track position so this is approximate).
    { re: /\b[a-zA-Z_][\w-]*(?=\s*:)/, token: 'function' },
    { re: /\b(?:true|false|null|yes|no|on|off)\b/i, token: 'literal' },
    { re: /-?\b\d+(?:\.\d+)?\b/, token: 'number' },
  ])
}

function shellRules(): Rule[] {
  return makeRules([
    { re: /#[^\n]*/, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'[^'\n]{0,500}'/, token: 'string' },
    // Variables: $VAR or ${VAR}.
    { re: /\$\{[^}\n]{1,200}\}|\$[A-Za-z_]\w*/, token: 'literal' },
    { re: /-?\b\d+\b/, token: 'number' },
    { re: /[A-Za-z_][\w-]*/, token: 'keyword' },
  ])
}

function pythonRules(): Rule[] {
  return makeRules([
    { re: /#[^\n]*/, token: 'comment' },
    // Triple strings (single line — multi-line wouldn't survive per-line tokenization anyway).
    { re: /"""(?:[^"\\]|\\.){0,500}"""/, token: 'string' },
    { re: /'''(?:[^'\\]|\\.){0,500}'''/, token: 'string' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    { re: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[jJ]?\b/, token: 'number' },
    { re: /[A-Za-z_][\w]*(?=\s*\()/, token: 'function' },
    { re: /[A-Za-z_][\w]*/, token: 'keyword' },
  ])
}

function goRules(): Rule[] {
  return makeRules([
    { re: /\/\/[^\n]*/, token: 'comment' },
    { re: /\/\*[\s\S]{0,500}?\*\//, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /`[^`]{0,500}`/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,5}'/, token: 'string' }, // rune
    { re: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, token: 'number' },
    { re: /[A-Za-z_][\w]*(?=\s*\()/, token: 'function' },
    { re: /[A-Za-z_][\w]*/, token: 'keyword' },
  ])
}

function rustRules(): Rule[] {
  return makeRules([
    { re: /\/\/[^\n]*/, token: 'comment' },
    { re: /\/\*[\s\S]{0,500}?\*\//, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,5}'/, token: 'string' }, // char literal
    { re: /\b\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+)?(?:[uif]\d+|usize|isize)?\b/, token: 'number' },
    { re: /[A-Za-z_][\w]*!/, token: 'function' }, // macros
    { re: /[A-Za-z_][\w]*(?=\s*\()/, token: 'function' },
    { re: /[A-Za-z_][\w]*/, token: 'keyword' },
  ])
}

function mdRules(): Rule[] {
  return makeRules([
    { re: /^#{1,6}\s.*/, token: 'type' }, // heading
    { re: /\*\*[^*\n]{1,200}\*\*/, token: 'keyword' },
    { re: /`[^`\n]{1,200}`/, token: 'string' },
    { re: /\[[^\]\n]{1,200}\]\([^)\n]{1,200}\)/, token: 'function' },
  ])
}

const RULES_BY_LANG: Record<Lang, () => Rule[]> = {
  js: jsRules,
  json: jsonRules,
  html: htmlRules,
  css: cssRules,
  yaml: yamlRules,
  shell: shellRules,
  python: pythonRules,
  go: goRules,
  rust: rustRules,
  md: mdRules,
}

// ─── Token coloring ───

/** Apply a color spec from the active palette. Hex strings go through
 *  `chalk.hex`; named ANSI colors go through chalk's named accessor; a
 *  null spec returns the text unchanged (used by `'off'` and by the
 *  identifier-classification fallthrough when a word doesn't match
 *  any known keyword/type pattern). */
export function applyColor(text: string, spec: ColorSpec): string {
  if (spec === null) return text
  if (spec.startsWith('#')) return c.hex(spec)(text)
  // Named ANSI color — a small accessor lookup. Chalk types this as a
  // chainable getter, but we only need the common 8/16 colors.
  const named = (c as unknown as Record<string, (s: string) => string>)[spec]
  if (typeof named === 'function') return named(text)
  return text
}

/** Default-fg fallback. Used by paint() and the unmatched-character
 *  loop in highlightLine to give plain text inside diff rows the same
 *  bright cream/dark-gray that CC's `Theme.foreground` produces.
 *  When `defaultFg` is null/undefined, falls through unchanged. */
function paintDefault(text: string, defaultFg: ColorSpec | undefined): string {
  if (!defaultFg) return text
  return applyColor(text, defaultFg)
}

function paint(text: string, token: Token, lang: Lang, palette: Palette, defaultFg?: ColorSpec): string {
  // Identifier post-classification: for languages where the same regex
  // matches keywords / literals / generic identifiers, we re-bucket
  // based on the source word. This keeps the rule tables flat.
  if (token === 'keyword') {
    const word = text
    // Storage keywords route to the `storage` palette slot for ALL
    // languages — `function`/`const`/`class`/`def`/`fn`/`struct` etc.
    // come out cyan (Monokai) / magenta (GitHub) instead of the same
    // hot-pink as control-flow keywords. Mirrors CC scopeColor's
    // STORAGE_KEYWORDS check (color-diff/index.ts:459-461).
    if (STORAGE_KEYWORDS.has(word)) return applyColor(text, palette.storage)
    if (lang === 'js') {
      if (KEYWORDS_JS.has(word)) return applyColor(text, palette.keyword)
      if (LITERALS_JS.has(word)) return applyColor(text, palette.literal)
      // Known JS globals (`console`, `Math`, `JSON`, ...) → palette.type.
      // Reasoning: hljs scopes them as `built_in`, and across CC's three
      // syntax themes `built_in` and `type` always share a color
      // (monokai chartreuse / github-light teal / ansi bright cyan).
      // The `function` slot is reserved for `title.function` (declaration
      // names like `greet`) which differs in github-light (purple) and
      // ANSI (bright yellow).
      if (JS_GLOBALS.has(word)) return applyColor(text, palette.type)
      // Heuristic: PascalCase identifiers are most likely type / class
      // names. Cheap, no false-negative on common idiomatic code.
      if (/^[A-Z][a-zA-Z0-9_]*$/.test(word)) return applyColor(text, palette.type)
      return paintDefault(text, defaultFg)
    }
    const rule = KEYWORD_RULES[lang]
    if (rule) {
      if (rule.keywords.has(word)) return applyColor(text, palette.keyword)
      if (rule.pascalAsType && /^[A-Z][a-zA-Z0-9_]*$/.test(word)) return applyColor(text, palette.type)
      return paintDefault(text, defaultFg)
    }
    return applyColor(text, palette.keyword)
  }
  if (token === 'storage') return applyColor(text, palette.storage)
  if (token === 'string') return applyColor(text, palette.string)
  if (token === 'number') return applyColor(text, palette.number)
  if (token === 'comment') return applyColor(text, palette.comment)
  if (token === 'function') return applyColor(text, palette.function)
  if (token === 'type') return applyColor(text, palette.type)
  if (token === 'literal') return applyColor(text, palette.literal)
  return paintDefault(text, defaultFg)
}

// ─── Main entry ───

/** Highlight a single line of code using the named theme (or the active
 *  module-level theme when omitted). Returns ANSI-colored text whose
 *  visible width is identical to the input — only escape codes added,
 *  no character substitution.
 *
 *  When `lang` is null (file extension we don't recognize) or the active
 *  theme is `'off'`, the output (with no `defaultFg`) is identical to
 *  the input. With `defaultFg`, ALL chars get a fg color so unhighlighted
 *  text on the diff bg matches CC's brighter cream/dark-gray instead of
 *  the terminal default white. */
export function highlightLine(
  line: string,
  lang: Lang | null,
  theme?: SyntaxThemeName,
  defaultFg?: string | null,
): string {
  if (line.length === 0) return line

  // Unrecognized language: just paint the whole line in defaultFg if
  // provided (so a Python diff with no Python rules still gets the
  // bright cream fg on bg), else identity.
  if (lang === null) {
    return defaultFg ? applyColor(line, defaultFg) : line
  }

  const palette = THEMES[theme ?? currentTheme]
  // For `'off'` (all-null palette), there are no token colors to apply.
  // But we still want defaultFg so unhighlighted text on diff bg has
  // the right brightness. Skip the regex work — paint the whole line
  // in defaultFg (or identity if no defaultFg).
  if (palette === THEMES.off) {
    return defaultFg ? applyColor(line, defaultFg) : line
  }

  const rules = RULES_BY_LANG[lang]()
  let pos = 0
  let out = ''
  const len = line.length

  while (pos < len) {
    let matched = false
    for (const r of rules) {
      r.re.lastIndex = pos
      const m = r.re.exec(line)
      if (m && m.index === pos && m[0].length > 0) {
        out += paint(m[0], r.token, lang, palette, defaultFg ?? undefined)
        pos += m[0].length
        matched = true
        break
      }
    }
    if (!matched) {
      // No rule matched — paint one char in defaultFg (or pass through).
      // This catches punctuation `(`, `)`, `;`, `{`, `}`, etc. — CC's
      // hljs scopes them as `punctuation` (= theme.foreground). Single-
      // char advancement keeps the loop bounded.
      out += defaultFg ? applyColor(line[pos]!, defaultFg) : line[pos]!
      pos++
    }
  }
  return out
}
