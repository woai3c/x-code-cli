// @x-code-cli/cli — Platform-aware Unicode glyph fallbacks.
//
// Legacy ConHost (cmd.exe / Windows PowerShell host outside Windows Terminal)
// defaults to fonts (Lucida Console, Consolas, SimSun, NSimSun, MS Gothic)
// that lack many Unicode glyphs outside the CP437 / Latin-1 Supplement range.
// Characters like ●, ▸, ⎿, ✢, ✶, ⏸, ⚡, ✓, ◼, •, ▎ either render as
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

/** True when the terminal is a legacy ConHost that can't reliably render
 *  Unicode beyond CP437 / Latin-1 Supplement (U+0000–U+00FF) and the
 *  Box Drawing block (U+2500–U+257F). */
const IS_LEGACY_TERMINAL =
  process.platform === 'win32' && !process.env.WT_SESSION && process.env.TERM_PROGRAM !== 'vscode'

// ── Glyph table ─────────────────────────────────────────────────────────
//
// Each export pair: `GLYPH_NAME` = rich Unicode, fallback = ASCII/Latin-1.
// Consumers import the name and get the right variant at module load time.

/** "Current selection" radio marker in picker dialogs: `●` (U+25CF) → `*` */
export const GLYPH_BULLET = IS_LEGACY_TERMINAL ? '*' : '●'

/** Row-leading status bullet (tool calls, collapsed read groups, peer
 *  messages) in scrollback and live frames: `•` (U+2022) → `*`. Half the
 *  visual size of GLYPH_BULLET — the full-size `●` read as oversized next
 *  to single-line tool rows. U+2022 is in CP437/Windows-1252 so even the
 *  legacy ConHost fonts carry it; the `*` fallback stays for consistency
 *  with the rest of the table. */
export const GLYPH_TOOL_BULLET = IS_LEGACY_TERMINAL ? '*' : '\u2022'

/** User-message prompt arrow: `▸` (U+25B8) → `>`. Middle ground
 *  between the heavy `❯` (U+276F) and the tiny `›` (U+203A). */
export const GLYPH_PROMPT_ARROW = IS_LEGACY_TERMINAL ? '>' : '\u25b8'

/** Tool-result / sub-item bracket: `⎿` (U+23BF) → `|` */
export const GLYPH_RESULT_BRACKET = IS_LEGACY_TERMINAL ? '|' : '⎿'

/** Permission / select-option pointer: `▸` (U+25B8) → `>`. Matches
 *  GLYPH_PROMPT_ARROW. */
export const GLYPH_SELECT_POINTER = IS_LEGACY_TERMINAL ? '>' : '\u25b8'

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

/** Fork lineage arrow in session pickers: `↳` (U+21B3) → `->` */
export const GLYPH_FORK_ARROW = IS_LEGACY_TERMINAL ? '->' : '\u21b3'

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
