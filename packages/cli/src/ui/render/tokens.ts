// ─── Semantic color tokens — single source of truth for UI chrome ──────
//
// Replaces the old split-brain setup where `theme.ts` held hex constants
// and `chat-input/palette.ts` held hand-synced raw ANSI escapes. Now one
// table drives BOTH render paths:
//
//   - `paint(token)`      → chalk styler for the scrollback/commit path
//                           (stdout-writer, render-markdown, AppHeader)
//   - `cellFg/cellBg()`   → raw SGR escapes for ChatInput's cell-diff
//                           renderer (which can't run chalk)
//
// Every token has three values: dark hex, light hex, and a 16-color ANSI
// keyword for the *-ansi themes (which honor the user's terminal palette
// instead of forcing hex — mirrors Claude Code's ansi theme rationale).
// `/theme` switches at runtime; palette.ts rebuilds its derived escapes
// from here on every switch.
//
// Design rules (borrowed from Kimi Code's DESIGN.md / Codex / CC):
//   - Hierarchy comes from dim/bold/italic modifiers, not from more hues.
//   - `primary` is the ONLY brand accent on screen at a time; semantic
//     colors (success/warning/error) appear only for actual status.
//   - Secondary text uses the gray ladder textDim → textMuted → border.
import { Chalk } from 'chalk'

import { getTheme } from './theme.js'

// NO_COLOR (https://no-color.org) disables all color output; FORCE_COLOR
// wins over it (CI log viewers set both). Forcing level 3 bypasses chalk's
// own env detection, so we must honor the convention ourselves. Read once —
// env vars don't change mid-process.
const COLORS_ENABLED = !process.env.NO_COLOR || !!process.env.FORCE_COLOR

/** Shared chalk instance for every UI surface. Centralized so NO_COLOR /
 *  FORCE_COLOR handling lives in exactly one place — previously each
 *  renderer created its own `new Chalk({ level: 3 })` and ignored both. */
export const chalk = new Chalk({ level: COLORS_ENABLED ? 3 : 0 })
const c = chalk

export type ChromeToken =
  | 'primary'
  | 'primaryDim'
  | 'textStrong'
  | 'textDim'
  | 'textMuted'
  | 'border'
  | 'borderFocus'
  | 'success'
  | 'warning'
  | 'error'

/** 16-color ANSI keywords understood by both chalk and `cellFg`'s code
 *  table. Used only by the *-ansi themes. */
type AnsiKeyword = 'blue' | 'blueBright' | 'green' | 'yellow' | 'red' | 'white' | 'gray'

interface TokenDef {
  dark: string
  light: string
  ansi: AnsiKeyword | null
}

const TOKENS: Record<ChromeToken, TokenDef> = {
  // Brand sky blue (from the logo) — spinner, links, inline code, tool
  // previews, selection pointer, focused borders, permission previews.
  primary: { dark: '#89b4fa', light: '#2f6fdd', ansi: 'blueBright' },
  primaryDim: { dark: '#5c7cb8', light: '#7a9cd8', ansi: 'blue' },
  // Explicit "brighter than terminal default" for rare emphasis; plain
  // body text stays on the terminal's own default foreground.
  textStrong: { dark: '#f8f8f2', light: '#1f2328', ansi: 'white' },
  // Gray ladder: textDim for meta/hints, textMuted for placeholder/
  // gutter/hr, border for the input rules and ❯ echo arrow. Dark values
  // are brightened a step above CC's originals (border #888 → #a0a0,
  // textDim #999 → #b3b3, textMuted #5c5c → #8f8f): at CC's depths the
  // ladder reads muddy on many dark terminals, and the dim attribute
  // (previously used for live-UI meta) came out darker still.
  textDim: { dark: '#b3b3b3', light: '#6a737d', ansi: 'white' },
  textMuted: { dark: '#8f8f8f', light: '#959da5', ansi: 'gray' },
  border: { dark: '#a0a0a0', light: '#c8cdd3', ansi: 'gray' },
  borderFocus: { dark: '#89b4fa', light: '#2f6fdd', ansi: 'blueBright' },
  success: { dark: '#4eba65', light: '#248a3d', ansi: 'green' },
  warning: { dark: '#ffc107', light: '#9a6700', ansi: 'yellow' },
  error: { dark: '#ff6b80', light: '#cf222e', ansi: 'red' },
}

type ThemeKind = 'dark' | 'light' | 'ansi'

function themeKind(): ThemeKind {
  const name = getTheme()
  if (name.endsWith('-ansi')) return 'ansi'
  return name.startsWith('light') ? 'light' : 'dark'
}

// ANSI keyword → SGR foreground code (bright variants in the 90s range).
const ANSI_FG: Record<AnsiKeyword, number> = {
  blue: 34,
  blueBright: 94,
  green: 32,
  yellow: 33,
  red: 31,
  white: 37,
  gray: 90,
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

/** Chalk styler for the commit/scrollback path. Resolves against the
 *  active theme at CALL time so `/theme` switches apply to everything
 *  committed afterwards. */
export function paint(token: ChromeToken): (s: string) => string {
  const def = TOKENS[token]
  const kind = themeKind()
  if (kind === 'ansi') {
    if (def.ansi === null) return (s) => s
    return c[def.ansi] as (s: string) => string
  }
  return (s) => c.hex(def[kind])(s)
}

export interface CellMods {
  bold?: boolean
  dim?: boolean
  italic?: boolean
}

/** Raw SGR escape for ChatInput's cell-diff renderer. ALWAYS starts with
 *  `\x1b[0m`: palette.ts's long-form comments document why — a bare color
 *  sequence inherits whatever attributes the previous cell left active
 *  (bold bleeding into the next row, dim meta flashing blue after the
 *  spinner cell). Resetting first pins every cell to a known state. */
export function cellFg(token: ChromeToken, mods: CellMods = {}): string {
  const def = TOKENS[token]
  const kind = themeKind()
  const attrs = `${mods.bold ? ';1' : ''}${mods.dim ? ';2' : ''}${mods.italic ? ';3' : ''}`
  // NO_COLOR strips the color sequence but keeps attribute mods —
  // the convention governs color, not emphasis.
  if (!COLORS_ENABLED) return `\x1b[0m${attrs ? `\x1b[${attrs.slice(1)}m` : ''}`
  if (kind === 'ansi') {
    if (def.ansi === null) return '\x1b[0m'
    return `\x1b[0m\x1b[${ANSI_FG[def.ansi]}${attrs}m`
  }
  const [r, g, b] = hexToRgb(def[kind])
  return `\x1b[0m\x1b[38;2;${r};${g};${b}${attrs}m`
}
