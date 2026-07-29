// Cell-style palette for ChatInput's direct-stdout cell-diff renderer.
//
// Color styles are DERIVED from `ui/tokens.ts` (the single source of
// truth) as `let` bindings — `rebuildPalette()` re-derives them whenever
// `/theme` switches at runtime. The cell-diff emitter can't run chalk,
// so these stay raw escape strings; tokens.ts guarantees they start with
// `\x1b[0m` so no cell inherits SGR state from its predecessor.
//
// Structural (non-color) constants further down keep their hand-tuned
// byte sequences and the comments explaining why.
import { cellFg } from '../../tokens.js'

// ── Derived color styles (rebuilt on theme switch) ─────────────────────

/** Prompt-box rules and card frames (`─`, `╭╮╰╯`). */
export let S_BORDER = cellFg('border')
/** Mode-activated frame color (plan mode) — the primary rung. */
export let S_BORDER_FOCUS = cellFg('borderFocus')
/** Brand primary — live tool `(preview)`, completion/selection labels. */
export let S_PRIMARY = cellFg('primary')
export let S_PRIMARY_BOLD = cellFg('primary', { bold: true })
/** Unfocused option rows (permission dialog) — the gray "inactive" rung. */
export let S_TEXT_DIM = cellFg('textDim')
/** Weakest gray rung — prompt glyph, placeholders. */
export let S_TEXT_MUTED = cellFg('textMuted')
/** Spinner glyph. Same hue as S_PRIMARY but a distinct semantic slot so
 *  the spinner can diverge later without touching emphasis styles. */
export let S_SPINNER = cellFg('primary')
export let S_SUCCESS = cellFg('success', { bold: true })
// Non-bold variant of SUCCESS — used for the live tool `●` bullet so it
// matches the committed `stdout-writer.formatToolCall` output exactly
// (`paint('success')('●')` is non-bold there). If live used the bold
// variant, the dot would visibly "de-bold" at the moment the tool finishes.
export let S_SUCCESS_DOT = cellFg('success')
// Dim half of the running-tool bullet pulse animation. Same green hue as
// S_SUCCESS_DOT, but with the ANSI dim attribute (2) layered on top so
// terminals render it as a subdued shade of the same color rather than
// a different color entirely. Toggling between this and S_SUCCESS_DOT
// every few spinner frames produces the bright↔dim "heartbeat" CC uses
// to signal a tool is actively running, so the user can tell at a glance
// which committed line in scrollback turned into the live row.
export let S_SUCCESS_DOT_DIM = cellFg('success', { dim: true })
export let S_WARNING = cellFg('warning')
export let S_WARNING_BOLD = cellFg('warning', { bold: true })
/** Non-bold error text — matches committed `paint('error')` output. */
export let S_ERROR = cellFg('error')
export let S_ERROR_BOLD = cellFg('error', { bold: true })

/** Re-derive every color style from tokens after a `/theme` switch.
 *  ESM live bindings propagate the new strings to all importers. */
export function rebuildPalette(): void {
  S_BORDER = cellFg('border')
  S_BORDER_FOCUS = cellFg('borderFocus')
  S_PRIMARY = cellFg('primary')
  S_PRIMARY_BOLD = cellFg('primary', { bold: true })
  S_TEXT_DIM = cellFg('textDim')
  S_TEXT_MUTED = cellFg('textMuted')
  S_SPINNER = cellFg('primary')
  S_SUCCESS = cellFg('success', { bold: true })
  S_SUCCESS_DOT = cellFg('success')
  S_SUCCESS_DOT_DIM = cellFg('success', { dim: true })
  S_WARNING = cellFg('warning')
  S_WARNING_BOLD = cellFg('warning', { bold: true })
  S_ERROR = cellFg('error')
  S_ERROR_BOLD = cellFg('error', { bold: true })
}

// ── Structural styles (not colors — fixed byte sequences) ──────────────

// Bold with NO foreground color — matches committed `c.bold(label)`.
// Must start with `\x1b[0m` to reset any prior foreground so bold doesn't
// inherit a color from the preceding cell (same reasoning as S_DIM).
export const S_BOLD = '\x1b[0m\x1b[1m'
// NB: leading `\x1b[0m` matters. Plain `\x1b[2m` just adds the "dim"
// attribute ON TOP of whatever foreground color is active — so meta
// text rendered after a colored span (e.g. the spinner row, where
// S_SPINNER blue is emitted just before the meta transition) comes out
// as BLUE-dim instead of gray-dim. And on a spinner tick where only
// the seconds cell changes, the diff loop emits S_NONE (reset) first
// and then S_DIM starting from the seconds digit — so the SAME meta
// text is redrawn as WHITE-dim. Result: meta flashes white/blue every
// tick depending on which diff path fires ("一会白一会蓝"). Resetting
// SGR first then applying dim pins the color to the terminal default,
// so meta looks consistent regardless of prior SGR state.
export const S_DIM = '\x1b[0m\x1b[2m'
// ANSI 90 (bright black). Equivalent to chalk's `c.gray()` output —
// `c.gray('⎿')` emits `\x1b[90m...\x1b[39m`. Use this for cells that
// MUST visually match a `c.gray()`-styled glyph in committed scrollback
// (currently: the `⎿` connector and the `(duration)` suffix in tool
// rows). S_DIM (`\x1b[2m` = dim attribute on default fg) renders as a
// noticeably different shade than `\x1b[90m` (explicit palette entry)
// on most terminals — the user perceives a color flash on the moment
// a tool finishes and its row switches from live frame to scrollback.
export const S_GRAY_90 = '\x1b[0m\x1b[90m'
// S_NONE means "default styling — no fg color, no attribute" and MUST
// be a non-empty escape, otherwise the cell-diff loop's
// `if (cell.style !== lastStyle) buf += cell.style` branch emits an
// empty string and leaves the terminal SGR state inherited from
// whatever preceded it. That used to render rows like
// `[' '(NONE)][glyph(BLUE)][' '(NONE)][T(BLUE)]…` with the trailing
// NONE space inheriting the BLUE — and with non-atomic terminals the
// user perceived the "Thinking" text flashing white→blue between
// frames as redundant SGR codes arrived just after the chars. Setting
// S_NONE to the explicit DEC reset (`\x1b[0m`, same byte as S_RESET)
// makes every NONE cell explicitly clear styling before its glyph,
// which removes the inheritance and the perceived flash.
// Reset ALL attributes at row end (\x1b[0m), not just foreground (\x1b[39m).
// Bold cells (e.g. Permission's Yes/No highlight) would otherwise bleed
// their bold attribute into the next row. The cell-diff emitter re-emits
// any non-empty style on the first cell of the next row, so a full reset
// here is safe.
export const S_RESET = '\x1b[0m'
export const S_NONE = '\x1b[0m'
// Inverse-video block used to PAINT the input cursor's position as a
// regular cell. The real terminal cursor is hidden app-wide (see the
// useEffect at component mount), so this is the only thing the user
// sees as "the cursor". Updates atomically with the rest of the cell-
// diff frame, so it never flickers on its own. Mirrors Gemini CLI's
// `<Text terminalCursorFocus>` approach (renders an inverse-video
// block at the caret position) and Claude Code's same hidden-cursor
// strategy.
export const S_CURSOR = '\x1b[7m'

// NOTE: `\x1b7` / `\x1b8` (DECSC / DECRC) are DELIBERATELY NOT used
// anywhere in this file. The terminal provides a single save register,
// and Ink's own log-update reuses it on every render cycle — co-owning
// it from two places was producing "ghost" restore positions. We
// reconstruct cursor position with relative moves (CUU / CUD / \r /
// \x1b[NG absolute-column) and by treating post-dialog transitions as
// fresh first-paints (prevFrameRef cleared), which removes the cross-
// writer contention entirely. See the wasHidden handler in ChatInput
// for the transition-case reasoning.

/** DEC 2026 "Synchronized Update Mode". Between BSU and ESU, supported
 *  terminals buffer all output and render it as a single atomic frame.
 *  This eliminates the flash that otherwise occurs between eraseRegion
 *  wiping the frame and the full re-render that follows — the user sees
 *  only the final state, never the intermediate blank region.
 *  Unsupported terminals silently ignore these sequences.
 *
 *  Cursor visibility is intentionally NOT toggled around each render.
 *  Earlier revisions cycled `\x1b[?25l` in BSU and `\x1b[?25h` in ESU to
 *  mask the diff-loop's intermediate cursor positions on terminals that
 *  don't fully atomize DEC 2026. At the 80ms spinner cadence that
 *  produced a 12Hz hide/show flap which users perceived as "上下抖动"
 *  flicker around the input row — and sync-mode batching already hides
 *  the intermediate positions on every terminal we target (xterm.js /
 *  VSCode, Windows Terminal, iTerm2, Ghostty). So: the cursor stays
 *  shown throughout; sync mode handles atomicity; the end-of-buf park
 *  places it at the input column before ESU commits. When there is no
 *  active anchor (disabled / dialog) ESU_HIDE explicitly hides. */
export const BSU = '\x1b[?2026h'
export const ESU_HIDE = '\x1b[?2026l\x1b[?25l'

// NOTE: a DECSTBM-based `buildInsertHistoryAbove` existed briefly here
// (modeled on codex-rs insert_history.rs) but was reverted because it
// required the cell buffer to be anchored at the very bottom of the
// terminal — true in codex-rs (ratatui's Terminal manages a viewport
// rect), but NOT true in our setup, where the banner + partial scroll
// state can leave the cell buffer mid-screen. Setting a scroll region
// `[1, termRows - cellBufH]` then overlapped the live cell buffer rows,
// so history writes tore through the frame. Re-attempting this fix
// properly needs a "force cell buffer to the last N rows via absolute
// cursor positioning on every render" refactor — tracked separately.
