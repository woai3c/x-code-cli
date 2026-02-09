// @x-code/cli — Streaming text output component
import React from 'react'

import { Text } from 'ink'

interface StreamingTextProps {
  text: string
}

export function StreamingText({ text }: StreamingTextProps) {
  if (!text) return null
  return <Text color="green">{text}</Text>
}
