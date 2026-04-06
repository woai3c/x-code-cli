// @x-code-cli/cli — Bottom status bar (model / token count)
import React from 'react'

import { Box, Text } from 'ink'

import type { TokenUsage } from '@x-code-cli/core'

import { ACCENT_DIM, DIM } from '../theme.js'

interface StatusBarProps {
  modelId: string
  usage: TokenUsage
}

export function StatusBar({ modelId, usage }: StatusBarProps) {
  if (usage.totalTokens === 0) return null

  return (
    <Box marginTop={0} gap={1}>
      <Text color={ACCENT_DIM}>{modelId}</Text>
      <Text color={DIM}>·</Text>
      <Text dimColor>{usage.totalTokens.toLocaleString()} tokens</Text>
    </Box>
  )
}
