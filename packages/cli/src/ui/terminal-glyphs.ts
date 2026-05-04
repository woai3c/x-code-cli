// @x-code-cli/cli — Platform-aware Unicode glyph fallbacks.
//
// Legacy ConHost (cmd.exe / Windows PowerShell host outside Windows Terminal)
// defaults to fonts (Lucida Console, Consolas, SimSun, NSimSun, MS Gothic)
// that lack many Unicode glyphs outside the CP437 / Latin-1 Supplement range.
// Characters like ●, ❯, ⎿, ✢, ✶, ⏸, ⚡, ✓, ◼, •, ▎ either render as
// missing-glyph boxes (□) or at incorrect widths, producing visual artifacts
// the user described as "ugly" / "broken".
//
// This module centralises ALL decorative Unicode used in the TUI behind a
// capability-detection gate. Every rendering path (ChatInput cell buffer,
// stdout-writer scrollback, render-markdown, AppHeader) imports glyphs from
// here instead of hard-coding literals.
//
// Detection logic mirrors the spinner ASCII fallback that already existed
// in ChatInput.tsx: WT_SESSION → Windows Terminal (Cascadia Mono, full
// Unicode); TERM_PROGRAM=vscode → VSCode integrated terminal; neither on
// win32 → legacy ConHost. Non-Windows platforms always get rich glyphs.
//
// ConHost also has a scrollbar that eats ~1 column from the visible width
// while process.stdout.columns still reports the full buffer width. The
// RIGHT_MARGIN_SAFETY constant lets right-alignment calculations compensate.

/** True when the terminal is a legacy ConHost that can't reliably render
 *  Unicode beyond CP437 / Latin-1 Supplement (U+0000–U+00FF) and the
 *  Box Drawing block (U+2500–U+257F). */
export const IS_LEGACY_TERMINAL =
  process.platform === 'win32' && !process.env.WT_SESSION && process.env.TERM_PROGRAM !== 'vscode'

/** Extra columns to reserve on the right edge when right-aligning text.
 *  ConHost's vertical scrollbar overlaps the rightmost column(s) of the
 *  buffer, clipping characters that sit at `columns - 1`. Modern terminals
 *  (Windows Terminal, VSCode, iTerm2, etc.) don't have this issue. */
export const RIGHT_MARGIN_SAFETY = IS_LEGACY_TERMINAL ? 1 : 0

// ── Glyph table ─────────────────────────────────────────────────────────
//
// Each export pair: `GLYPH_NAME` = rich Unicode, fallback = ASCII/Latin-1.
// Consumers import the name and get the right variant at module load time.

/** Tool-call bullet: `●` (U+25CF) → `*` */
export const GLYPH_BULLET = IS_LEGACY_TERMINAL ? '*' : '●'

/** User-message prompt arrow: `❯` (U+276F) → `>` */
export const GLYPH_PROMPT_ARROW = IS_LEGACY_TERMINAL ? '>' : '❯'

/** Tool-result / sub-item bracket: `⎿` (U+23BF) → `|` */
export const GLYPH_RESULT_BRACKET = IS_LEGACY_TERMINAL ? '|' : '⎿'

/** Permission / select-option pointer: `❯` (U+276F) → `>` */
export const GLYPH_SELECT_POINTER = IS_LEGACY_TERMINAL ? '>' : '\u276f'

/** Plan mode indicator: `⏸` (U+23F8) → `=` */
export const GLYPH_PLAN_MODE = IS_LEGACY_TERMINAL ? '=' : '\u23f8'

/** Accept-edits indicator: `⚡` (U+26A1) → `*` */
export const GLYPH_ACCEPT_EDITS = IS_LEGACY_TERMINAL ? '*' : '\u26a1'

/** Todo completed check: `✓` (U+2713) → `+` */
export const GLYPH_TODO_CHECK = IS_LEGACY_TERMINAL ? '+' : '\u2713'

/** Todo in-progress filled square: `◼` (U+25FC) → `#` */
export const GLYPH_TODO_IN_PROGRESS = IS_LEGACY_TERMINAL ? '#' : '\u25fc'

/** Todo pending hollow square: `◻` (U+25FB) → `-` */
export const GLYPH_TODO_PENDING = IS_LEGACY_TERMINAL ? '-' : '\u25fb'

/** Todo panel corner bracket: `⎿` (U+23BF) → `|` (same as result bracket) */
export const GLYPH_TODO_BRACKET = IS_LEGACY_TERMINAL ? '|' : '\u23bf'

/** Blockquote left bar: `▎` (U+258E) → `|` */
export const GLYPH_BLOCKQUOTE_BAR = IS_LEGACY_TERMINAL ? '|' : '\u258e'

/** Unordered list bullet: `•` (U+2022) → `-` */
export const GLYPH_LIST_BULLET = IS_LEGACY_TERMINAL ? '-' : '\u2022'

/** Header separator pipe: `│` (U+2502) → `|` */
export const GLYPH_HEADER_PIPE = IS_LEGACY_TERMINAL ? '|' : '\u2502'

/** Ellipsis: `…` (U+2026) — present in Windows-1252 and all ConHost fonts,
 *  no fallback needed. Exported for consistency so consumers don't hardcode
 *  the literal, but the value is the same on every platform. */
export const GLYPH_ELLIPSIS = '\u2026'

// Spinner frames — already had a partial fallback in ChatInput.tsx, now
// centralised here. ConHost's default fonts lack U+2722–U+273D (dingbats).
const SPINNER_BASE_RICH = ['·', '✢', '*', '✶', '✻', '✽']
const SPINNER_BASE_ASCII = ['·', ':', '+', '*', '+', ':']
const BASE = IS_LEGACY_TERMINAL ? SPINNER_BASE_ASCII : SPINNER_BASE_RICH

/** Full spinner frame sequence (forward + reversed for breathe cycle). */
export const SPINNER_FRAMES = [...BASE, ...[...BASE].reverse()]

// ── Box-drawing characters (tables in render-markdown) ──────────────────
//
// The light box-drawing range U+2500–U+257F is present in every ConHost
// font (Lucida Console, Consolas, SimSun, all CJK fallbacks) — they're
// part of CP437, the original IBM PC character set. Same for the double-
// line range U+2550–U+256C used in AppHeader's logo. These do NOT need
// fallbacks.
//
// The horizontal rule character `─` (U+2500) and table chars `┌┐└┘├┤┬┴┼│`
// are all in this safe range. No exports needed — they render correctly
// on every terminal we target.
