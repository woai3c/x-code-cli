// @x-code/cli — Startup header banner
import React from 'react'

import { Box, Text, useStdout } from 'ink'

import { VERSION } from '@x-code/core'

import { ACCENT } from '../theme.js'

interface AppHeaderProps {
  modelId: string
}

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

const LOGO_TINY = ' X-Code'

export function AppHeader({ modelId }: AppHeaderProps) {
  const { stdout } = useStdout()
  const terminalWidth = stdout?.columns ?? 80

  // Pick logo based on terminal width
  let logo: string
  if (terminalWidth >= 52) {
    logo = LOGO_WIDE
  } else if (terminalWidth >= 30) {
    logo = LOGO_COMPACT
  } else {
    logo = LOGO_TINY
  }

  // Extract provider and model from "provider:model-name"
  const [provider, ...modelParts] = modelId.split(':')
  const modelName = modelParts.join(':') || modelId

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={ACCENT} bold>
        {logo}
      </Text>

      <Box marginTop={0} gap={1}>
        <Text dimColor>v{VERSION}</Text>
        <Text dimColor>│</Text>
        <Text color={ACCENT}>{provider}</Text>
        <Text dimColor>/</Text>
        <Text color={ACCENT} bold>
          {modelName}
        </Text>
      </Box>

      <Box>
        <Text dimColor>Type /help for commands, Ctrl+C to abort</Text>
      </Box>
    </Box>
  )
}
