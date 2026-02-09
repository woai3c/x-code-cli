// @x-code/cli — Bottom status bar (model / token / cost)
import React from 'react'

import { Box, Text } from 'ink'

import type { TokenUsage } from '@x-code/core'

interface StatusBarProps {
  modelId: string
  usage: TokenUsage
}

export function StatusBar({ modelId, usage }: StatusBarProps) {
  const costStr = usage.estimatedCost > 0 ? ` $${usage.estimatedCost.toFixed(4)}` : ''
  return (
    <Box>
      <Text dimColor>
        {modelId} | {usage.totalTokens.toLocaleString()} tokens{costStr}
      </Text>
    </Box>
  )
}
