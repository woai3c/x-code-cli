// @x-code-cli/cli — Startup header banner
//
// printHeader() writes the banner directly to stdout BEFORE Ink starts.
// This avoids the Ink <Static> re-render bug where the header would
// appear multiple times as the dynamic area changes height.
import { Chalk } from 'chalk'

import { VERSION } from '../../version.js'
import { GLYPH_HEADER_PIPE } from '../terminal-glyphs.js'

const c = new Chalk({ level: 3 })

/** Logo color — kept as the original soft sky-blue (`#89b4fa`) on purpose,
 *  independent of Claude Code's brand orange used elsewhere. */
const LOGO_COLOR = '#89b4fa'

// ── ASCII logos for different terminal widths ──

const LOGO_WIDE = `
  ██╗  ██╗       ██████╗ ██████╗ ██████╗ ███████╗
  ╚██╗██╔╝      ██╔════╝██╔═══██╗██╔══██╗██╔════╝
   ╚███╔╝ █████╗██║     ██║   ██║██║  ██║█████╗  
   ██╔██╗ ╚════╝██║     ██║   ██║██║  ██║██╔══╝  
  ██╔╝ ██╗      ╚██████╗╚██████╔╝██████╔╝███████╗
  ╚═╝  ╚═╝       ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝`

const LOGO_NARROW = '  ╳ X-Code CLI'

/**
 * Return how many terminal rows the startup banner occupies. Needed by
 * ChatInput to correctly initialize its blank-rows-above-frame tracker
 * (otherwise the first time the completion menu / dialog grows, it
 * would pre-scroll rows that are actually blank, wasting viewport space
 * and pushing the banner into real scrollback unnecessarily).
 */
export function getHeaderRowCount(modelId: string): number {
  return renderHeader(modelId).split('\n').length - 1 // final '\n' adds one empty split
}

/**
 * Build the startup banner as a string.
 */
export function renderHeader(modelId: string): string {
  const cols = process.stdout.columns ?? 80

  const isWide = cols >= 52
  const logo = isWide ? LOGO_WIDE : LOGO_NARROW

  // Extract provider and model from "provider:model-name"
  const [provider, ...modelParts] = modelId.split(':')
  const modelName = modelParts.join(':') || modelId

  // Newline-shortcut hint:
  //   - Trailing `\` + Enter is the universal fallback (works in every
  //     terminal — ConHost, Terminal.app, all of xterm-family).
  //   - Alt/Option+Enter works on most modern terminals (Windows Terminal,
  //     iTerm2 with Esc+ Option, GNOME Terminal, kitty, WezTerm). On
  //     macOS Terminal.app the user must enable "Use Option as Meta key"
  //     in profile settings — otherwise only the `\` form works.
  // Why no Ctrl/Cmd+Enter: stock terminals send the same byte for plain
  // Enter and Ctrl+Enter, so we cannot distinguish them. modifyOtherKeys
  // / kitty CSI-u forms ARE accepted (see use-prompt-input.ts) but they
  // require terminal-specific opt-in, which we don't surface here.
  const isMac = process.platform === 'darwin'
  const abortKey = isMac ? '⌃C' : 'Ctrl+C'
  const newlineKey = isMac ? '⌥⏎ or \\⏎' : 'Alt+Enter or \\+Enter'

  const lines = [
    c.hex(LOGO_COLOR).bold(logo),
    '', // breathing room between logo and status info
    `  ${c.dim(`v${VERSION}`)} ${c.dim(GLYPH_HEADER_PIPE)} ${c.dim('model:')} ${c.hex(LOGO_COLOR)(`${provider}/${modelName}`)}`,
    `  ${c.dim(`/help commands · ${abortKey} abort · ${newlineKey} newline`)}`,
    '', // blank line after header
  ]

  return lines.join('\n') + '\n'
}

/**
 * Print the startup header banner directly to stdout.
 * Call this ONCE before Ink's render() so it is never re-drawn.
 */
export function printHeader(modelId: string): void {
  // Push the terminal viewport's existing content into scrollback and park
  // the cursor at (1,1) before writing. Without this, when startup runs
  // after noisy preamble (pnpm dev build logs, the user's command echo,
  // etc.) the cursor sits near the bottom of the viewport — the banner
  // lands there too, and ChatInput's bottom-pinned frame paints OVER the
  // banner's last rows. That's why only the top half of the logo showed.
  //
  // `\n`×(rows-1) auto-scrolls prior viewport content into real scrollback
  // history (still accessible by scrolling up in the terminal); `\x1b[H`
  // then homes the cursor so the banner writes at row 1, leaving all rows
  // below it blank for ChatInput to use as its pin-to-bottom territory.
  //
  // Two routes tried before this and rejected:
  //   - `\x1b[2J\x1b[H` (clear-screen + home): cleaner conceptually but
  //     several terminal/code-page combinations on Windows interpreted
  //     CSI 2J as also clearing visible scrollback above; users lost
  //     context (their typed command vanished).
  //   - `fs.writeSync(1, ...)` to force synchronous write: bypasses Node's
  //     UTF-16 conversion path for Windows TTYs and the box-drawing
  //     characters in the logo were rendered as GBK byte pairs under
  //     CP936 (zh-CN PowerShell default). Result was full mojibake plus
  //     visible scrollback corruption.
  //
  // process.stdout.write through Node's tty layer remains the only path
  // that handles Unicode correctly across Windows code pages.
  const rows = process.stdout.rows ?? 25
  if (process.stdout.isTTY && rows > 1) {
    process.stdout.write('\n'.repeat(rows - 1) + '\x1b[H')
  }
  process.stdout.write(renderHeader(modelId))
}
