// Cell-style palette for ChatInput's direct-stdout cell-diff renderer.
//
// Hardcoded RGB ANSI escapes because cells store raw style strings (the
// cell-diff emitter can't run chalk). Values mirror `ui/theme.ts` which
// itself mirrors Claude Code's dark theme (src/utils/theme.ts darkTheme)
// — keep these two tables in sync.

export const S_GRAY = '\x1b[38;2;136;136;136m' // promptBorder rgb(136,136,136) #888888
export const S_ACCENT = '\x1b[38;2;215;119;87m' // claude rgb(215,119,87) #d77757
export const S_ACCENT_DIM = '\x1b[38;2;153;153;153m' // inactive rgb(153,153,153) #999999
export const S_SPINNER = '\x1b[38;2;147;165;255m' // claudeBlue rgb(147,165,255) #93a5ff
export const S_SUCCESS = '\x1b[38;2;78;186;101;1m' // success rgb(78,186,101) #4eba65
// Non-bold variant of SUCCESS — used for the live tool `●` bullet so it
// matches the committed `stdout-writer.formatToolCall` output exactly
// (`c.hex(SUCCESS)('●')` is non-bold there). If live used the bold variant,
// the dot would visibly "de-bold" at the moment the tool finishes.
export const S_SUCCESS_DOT = '\x1b[0m\x1b[38;2;78;186;101m'
// Dim half of the running-tool bullet pulse animation. Same green hue as
// S_SUCCESS_DOT, but with the ANSI dim attribute (2) layered on top so
// terminals render it as a subdued shade of the same color rather than
// a different color entirely. Toggling between this and S_SUCCESS_DOT
// every few spinner frames produces the bright↔dim "heartbeat" CC uses
// to signal a tool is actively running, so the user can tell at a glance
// which committed line in scrollback turned into the live row.
export const S_SUCCESS_DOT_DIM = '\x1b[0m\x1b[38;2;78;186;101;2m'
// Bold with NO foreground color — matches committed `c.bold(label)`.
// Must start with `\x1b[0m` to reset any prior foreground so bold doesn't
// inherit a color from the preceding cell (same reasoning as S_DIM).
export const S_BOLD = '\x1b[0m\x1b[1m'
// BLUE_PURPLE (permission #99ccff) — used for the
// `(preview)` inside the live tool bubble to match committed
// `c.hex(BLUE_PURPLE)('(...)')`. Previously used S_SPINNER blue here
// (147,165,255) which is a DIFFERENT shade, producing a visible
// color shift at the live→committed handoff.
export const S_BLUE_PURPLE = '\x1b[0m\x1b[38;2;153;204;255m'
export const S_BLUE_PURPLE_BOLD = '\x1b[0m\x1b[38;2;153;204;255;1m'
export const S_WARNING = '\x1b[38;2;255;193;7m' // warning rgb(255,193,7) #ffc107
export const S_WARNING_BOLD = '\x1b[38;2;255;193;7;1m'
export const S_ERROR_BOLD = '\x1b[38;2;255;107;128;1m'
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
