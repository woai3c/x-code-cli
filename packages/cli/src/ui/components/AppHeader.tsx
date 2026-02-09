// @x-code/cli — Startup header banner
//
// printHeader() writes the banner directly to stdout BEFORE Ink starts.
// This avoids the Ink <Static> re-render bug where the header would
// appear multiple times as the dynamic area changes height.
import { Chalk } from 'chalk'

import { VERSION } from '@x-code/core'

import { ACCENT } from '../theme.js'

const c = new Chalk({ level: 3 })

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
 * Print the startup header banner directly to stdout.
 * Call this ONCE before Ink's render() so it is never re-drawn.
 */
export function printHeader(modelId: string): void {
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
    c.hex(ACCENT).bold(logo),
    ` ${c.dim(`v${VERSION}`)} ${c.dim('│')} ${c.hex(ACCENT)(provider)} ${c.dim('/')} ${c.hex(ACCENT).bold(modelName)}`,
    ` ${c.dim('Type /help for commands, Ctrl+C to abort')}`,
    '', // blank line after header
  ]

  process.stdout.write(lines.join('\n') + '\n')
}
