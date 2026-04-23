// @x-code-cli/cli — Startup header banner
//
// printHeader() writes the banner directly to stdout BEFORE Ink starts.
// This avoids the Ink <Static> re-render bug where the header would
// appear multiple times as the dynamic area changes height.
import { Chalk } from 'chalk'

import { VERSION } from '../../version.js'

const c = new Chalk({ level: 3 })

/** Logo color — kept as the original soft sky-blue (`#89b4fa`) on purpose,
 *  independent of the main ACCENT which follows Claude Code's orange. */
const LOGO_COLOR = '#89b4fa'

// ── ASCII logos for different terminal widths ──

const LOGO_WIDE = `
  ██╗  ██╗       ██████╗ ██████╗ ██████╗ ███████╗
  ╚██╗██╔╝      ██╔════╝██╔═══██╗██╔══██╗██╔════╝
   ╚███╔╝ █████╗██║     ██║   ██║██║  ██║█████╗  
   ██╔██╗ ╚════╝██║     ██║   ██║██║  ██║██╔══╝  
  ██╔╝ ██╗      ╚██████╗╚██████╔╝██████╔╝███████╗
  ╚═╝  ╚═╝       ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝`

const LOGO_COMPACT = `
  ╔═╗       ╔═╗╔═╗╔╦╗╔═╗
  ╔╩╦╝ ───── ║  ║ ║ ║║║╣ 
  ╩ ╚═       ╚═╝╚═╝═╩╝╚═╝`

const LOGO_TINY = '  X-Code'

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

  // Pick logo based on terminal width
  let logo: string
  if (cols >= 52) {
    logo = LOGO_WIDE
  } else if (cols >= 30) {
    logo = LOGO_COMPACT
  } else {
    logo = LOGO_TINY
  }

  // Extract provider and model from "provider:model-name"
  const [provider, ...modelParts] = modelId.split(':')
  const modelName = modelParts.join(':') || modelId

  const lines = [
    c.hex(LOGO_COLOR).bold(logo),
    ` ${c.dim(`v${VERSION}`)} ${c.dim('│')} ${c.hex(LOGO_COLOR)(provider)} ${c.dim('/')} ${c.hex(LOGO_COLOR).bold(modelName)}`,
    ` ${c.dim(`Type /help for commands, ${process.platform === 'darwin' ? '⌃C' : 'Ctrl+C'} to abort`)}`,
    '', // blank line after header
  ]

  return lines.join('\n') + '\n'
}

/**
 * Print the startup header banner directly to stdout.
 * Call this ONCE before Ink's render() so it is never re-drawn.
 */
export function printHeader(modelId: string): void {
  process.stdout.write(renderHeader(modelId))
}
