// @x-code-cli/cli — Shiki-backed syntax highlighter (prototype).
//
// Complements the in-house regex highlighter (syntax-highlight.ts) with a
// real TextMate grammar engine, modeled on how codex-cli uses syntect:
//
//  - Lazy singleton: the engine warms up in the background at startup
//    (`warmShikiEngine`, fire-and-forget). Until it's ready, every entry
//    point returns null and callers fall back to the regex highlighter —
//    the render path stays synchronous and never blocks on engine init.
//  - Guardrails (same idea as codex's highlight.rs): inputs over
//    MAX_LINES lines / MAX_BYTES bytes / MAX_LINE_BYTES per line are
//    rejected, returning null so callers render plain/fallback text.
//    The render loop draws via a setInterval on the UI thread, so a
//    pathological multi-thousand-line paste must never be tokenized
//    synchronously.
//  - Languages beyond the eager set load on demand: the first render of
//    an uncommon fence (e.g. `ruby`) kicks off an async load and falls
//    back for that one render; subsequent renders use shiki.
//
// Engine choice: Oniguruma WASM via `shiki/wasm` (base64-inlined, so no
// .wasm asset for esbuild to ship). Measured ~30-40x faster than the
// pure-JS regex engine at our input sizes — the JS engine took ~160ms
// for a 500-line block, which would visibly freeze the render loop.
import { type HighlighterCore, type LanguageInput, createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

import { type SyntaxThemeName, highlightLine } from './syntax-highlight.js'
import { chalk as c } from './tokens.js'

// ─── Guardrails ───

/** User decision: code blocks longer than this aren't worth reading
 *  (or coloring) — render them plain. */
const MAX_LINES = 500
const MAX_BYTES = 256 * 1024
/** A single minified mega-line is pathological; skip it. */
const MAX_LINE_BYTES = 4 * 1024

// ─── Theme mapping ───

/** Our 4 syntax palettes → shiki theme names. `ansi` has no shiki
 *  equivalent (terminal 16-color palette), so it maps to null and always
 *  falls back to the in-house highlighter. */
const SHIKI_THEMES: Record<Exclude<SyntaxThemeName, 'ansi'>, string> = {
  'one-dark': 'one-dark-pro',
  monokai: 'monokai',
  'github-light': 'github-light',
}

let currentShikiTheme: string | null = SHIKI_THEMES['one-dark']

/** Mirror of setSyntaxTheme — called from the same two sites (startup
 *  config apply, `/theme` switch) so the shiki path follows the active
 *  UI theme. */
export function setShikiTheme(name: SyntaxThemeName): void {
  currentShikiTheme = name === 'ansi' ? null : SHIKI_THEMES[name]
}

// ─── Language registry ───

/** Languages loaded eagerly at warm-up — the ones that dominate agent
 *  output. Anything else in LANG_LOADERS below loads on first use. */
const EAGER_LANGS = ['typescript', 'javascript', 'json', 'bash', 'python', 'markdown', 'yaml'] as const

/** fence id / extension → shiki language id + lazy loader. Keys are
 *  lowercase. Fence aliases shiki doesn't know out of the box (or whose
 *  spelling differs, e.g. `shell`) are normalized here. */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  ts: () => import('shiki/dist/langs/typescript.mjs'),
  typescript: () => import('shiki/dist/langs/typescript.mjs'),
  tsx: () => import('shiki/dist/langs/tsx.mjs'),
  mts: () => import('shiki/dist/langs/typescript.mjs'),
  cts: () => import('shiki/dist/langs/typescript.mjs'),
  js: () => import('shiki/dist/langs/javascript.mjs'),
  javascript: () => import('shiki/dist/langs/javascript.mjs'),
  jsx: () => import('shiki/dist/langs/jsx.mjs'),
  mjs: () => import('shiki/dist/langs/javascript.mjs'),
  cjs: () => import('shiki/dist/langs/javascript.mjs'),
  json: () => import('shiki/dist/langs/json.mjs'),
  jsonc: () => import('shiki/dist/langs/jsonc.mjs'),
  json5: () => import('shiki/dist/langs/json5.mjs'),
  html: () => import('shiki/dist/langs/html.mjs'),
  xml: () => import('shiki/dist/langs/xml.mjs'),
  vue: () => import('shiki/dist/langs/vue.mjs'),
  svelte: () => import('shiki/dist/langs/svelte.mjs'),
  css: () => import('shiki/dist/langs/css.mjs'),
  scss: () => import('shiki/dist/langs/scss.mjs'),
  less: () => import('shiki/dist/langs/less.mjs'),
  yml: () => import('shiki/dist/langs/yaml.mjs'),
  yaml: () => import('shiki/dist/langs/yaml.mjs'),
  toml: () => import('shiki/dist/langs/toml.mjs'),
  ini: () => import('shiki/dist/langs/ini.mjs'),
  sh: () => import('shiki/dist/langs/bash.mjs'),
  bash: () => import('shiki/dist/langs/bash.mjs'),
  shell: () => import('shiki/dist/langs/bash.mjs'),
  zsh: () => import('shiki/dist/langs/bash.mjs'),
  shellscript: () => import('shiki/dist/langs/bash.mjs'),
  py: () => import('shiki/dist/langs/python.mjs'),
  python: () => import('shiki/dist/langs/python.mjs'),
  go: () => import('shiki/dist/langs/go.mjs'),
  golang: () => import('shiki/dist/langs/go.mjs'),
  rs: () => import('shiki/dist/langs/rust.mjs'),
  rust: () => import('shiki/dist/langs/rust.mjs'),
  md: () => import('shiki/dist/langs/markdown.mjs'),
  markdown: () => import('shiki/dist/langs/markdown.mjs'),
  sql: () => import('shiki/dist/langs/sql.mjs'),
  c: () => import('shiki/dist/langs/c.mjs'),
  h: () => import('shiki/dist/langs/c.mjs'),
  cpp: () => import('shiki/dist/langs/cpp.mjs'),
  cxx: () => import('shiki/dist/langs/cpp.mjs'),
  java: () => import('shiki/dist/langs/java.mjs'),
  kt: () => import('shiki/dist/langs/kotlin.mjs'),
  kotlin: () => import('shiki/dist/langs/kotlin.mjs'),
  swift: () => import('shiki/dist/langs/swift.mjs'),
  rb: () => import('shiki/dist/langs/ruby.mjs'),
  ruby: () => import('shiki/dist/langs/ruby.mjs'),
  php: () => import('shiki/dist/langs/php.mjs'),
  lua: () => import('shiki/dist/langs/lua.mjs'),
  dockerfile: () => import('shiki/dist/langs/dockerfile.mjs'),
  docker: () => import('shiki/dist/langs/dockerfile.mjs'),
  graphql: () => import('shiki/dist/langs/graphql.mjs'),
  diff: () => import('shiki/dist/langs/diff.mjs'),
  make: () => import('shiki/dist/langs/make.mjs'),
  makefile: () => import('shiki/dist/langs/make.mjs'),
}

// ─── Engine singleton ───

let highlighter: HighlighterCore | null = null
let warmPromise: Promise<void> | null = null
/** Language ids (shiki names) known to be loaded. */
const loadedLangs = new Set<string>()
/** In-flight on-demand loads, keyed by shiki language id. */
const pendingLangs = new Map<string, Promise<void>>()

/** Kick off engine initialization in the background. Safe to call more
 *  than once — subsequent calls are no-ops. Never rejects. */
export function warmShikiEngine(): void {
  if (highlighter || warmPromise) return
  warmPromise = (async () => {
    const h = await createHighlighterCore({
      themes: [
        import('shiki/dist/themes/one-dark-pro.mjs'),
        import('shiki/dist/themes/monokai.mjs'),
        import('shiki/dist/themes/github-light.mjs'),
      ],
      langs: (await Promise.all(
        EAGER_LANGS.map(async (id) => {
          const loader = LANG_LOADERS[id]
          return loader ? (((await loader()) as { default: LanguageInput }).default ?? null) : null
        }),
      ).then((mods) => mods.filter((m) => m !== null))) as LanguageInput[],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    })
    for (const id of EAGER_LANGS) loadedLangs.add(shikiLangId(id))
    highlighter = h
  })().catch(() => {
    // Engine failure (OOM, bad chunk, …) — stay permanently on the
    // regex fallback rather than crashing the UI.
    warmPromise = null
  })
}

/** Normalize a fence id / extension to the shiki language id our
 *  loaders register. Must cover every alias in LANG_LOADERS —
 *  `loadedLangs` and `codeToTokens` both key off the normalized id. */
function shikiLangId(fenceId: string): string {
  switch (fenceId) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'sh':
    case 'shell':
    case 'zsh':
    case 'shellscript':
      return 'bash'
    case 'py':
      return 'python'
    case 'golang':
      return 'go'
    case 'rs':
      return 'rust'
    case 'rb':
      return 'ruby'
    case 'kt':
      return 'kotlin'
    case 'yml':
      return 'yaml'
    case 'md':
      return 'markdown'
    case 'h':
      return 'c'
    case 'cxx':
      return 'cpp'
    case 'docker':
      return 'dockerfile'
    case 'make':
      return 'makefile'
    default:
      return fenceId
  }
}

/** If the fence id is one we can load but haven't yet, start loading it
 *  in the background. Returns true when the language is ready NOW. */
function ensureLang(shikiId: string, fenceId: string): boolean {
  if (loadedLangs.has(shikiId)) return true
  if (!highlighter) return false
  const loader = LANG_LOADERS[fenceId]
  if (!loader) return false
  let pending = pendingLangs.get(shikiId)
  if (!pending) {
    const h = highlighter
    pending = loader()
      .then(async (mod) => {
        await h.loadLanguage((mod as { default: never }).default)
        loadedLangs.add(shikiId)
      })
      .catch(() => {
        // Unloadable grammar — treat as unsupported, stay on fallback.
      })
      .finally(() => pendingLangs.delete(shikiId))
    pendingLangs.set(shikiId, pending)
  }
  return false
}

// ─── Token → ANSI ───

// shiki/vscode-textmate FontStyle bit flags — we honor Bold only, and
// suppress Italic/Underline the same way codex's convert_style does
// (they read as visual noise in terminal output).
const FONT_BOLD = 2

interface ShikiToken {
  content: string
  color?: string
  fontStyle?: number
}

/** Render one line of tokens to ANSI. Two throughput/output-size
 *  optimizations over the naive per-token paint:
 *  1. Tokens whose color equals the theme's default foreground are
 *     emitted bare — TextMate grammars tag every space/identifier with
 *     the fg scope, which would otherwise triple the byte size and
 *     burden the cell differ for zero visual effect.
 *  2. Adjacent tokens sharing color+bold are merged into one SGR run. */
function paintLine(tokens: ShikiToken[], themeFg: string | null): string {
  let out = ''
  let pending = ''
  let pendingKey: string | null = null
  for (const t of tokens) {
    if (!t.content) continue
    const color = t.color?.toLowerCase()
    const key = !color || color === themeFg ? null : `${color}${t.fontStyle && t.fontStyle & FONT_BOLD ? 'b' : ''}`
    if (key !== pendingKey) {
      out += flush(pending, pendingKey)
      pending = ''
      pendingKey = key
    }
    pending += t.content
  }
  return out + flush(pending, pendingKey)
}

function flush(text: string, key: string | null): string {
  if (!text) return ''
  if (key === null) return text
  const bold = key.endsWith('b')
  const hex = bold ? key.slice(0, -1) : key
  const fn = c.hex(hex)
  return bold ? fn.bold(text) : fn(text)
}

// ─── Public API ───

/** Highlight `code` (a whole snippet, any number of lines) with shiki,
 *  returning ANSI-colored text with the same visible content. Returns
 *  null — caller falls back to the regex highlighter or plain text —
 *  when: the engine isn't warmed up yet, the active theme is `ansi`,
 *  the fence language is unknown/not-yet-loaded, or the input exceeds
 *  the guardrails. Never throws. */
export function highlightCodeShiki(code: string, fenceLang: string | undefined): string | null {
  if (!highlighter || !currentShikiTheme || !fenceLang) return null
  if (code.length === 0) return code
  if (code.length > MAX_BYTES) return null
  const lines = code.split('\n')
  if (lines.length > MAX_LINES) return null
  for (const line of lines) {
    if (line.length > MAX_LINE_BYTES) return null
  }

  const fenceId = fenceLang.trim().toLowerCase()
  const shikiId = shikiLangId(fenceId)
  if (!ensureLang(shikiId, fenceId)) return null

  try {
    const theme = highlighter.getTheme(currentShikiTheme)
    const themeFg = (theme as { fg?: string }).fg?.toLowerCase() ?? null
    const { tokens } = highlighter.codeToTokens(code, { lang: shikiId, theme: currentShikiTheme })
    return (tokens as ShikiToken[][]).map((line) => paintLine(line, themeFg)).join('\n')
  } catch {
    // Grammar/theme hiccup on this input — fall back, never crash render.
    return null
  }
}

/** Highlight a shell command preview (single- or multi-line). Tries the
 *  shiki engine first, falls back to the in-house regex highlighter when
 *  shiki isn't ready or declines the input. All shell-preview call sites
 *  (live tool row, committed scrollback row, permission dialog) must go
 *  through this one helper so their coloring can't drift apart. */
export function highlightShellCommand(command: string): string {
  return highlightCodeShiki(command, 'shell') ?? highlightLine(command, 'shell')
}

/** Test hook: true once the engine finished warming up. */
export function isShikiReady(): boolean {
  return highlighter !== null
}
