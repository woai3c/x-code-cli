// @x-code-cli/cli — Loading spinner component with elapsed time and token count
//
// Token display follows Claude Code: ↓ + cumulative token count.
// The ↓ arrow indicates tokens flowing through the interaction.
import React, { useEffect, useRef, useState } from 'react'

import { Text } from 'ink'

import { ACCENT, DIM } from '../theme.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

interface SpinnerProps {
  label?: string
  /** Cumulative total tokens */
  totalTokens?: number
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes}m ${secs}s`
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return `${tokens}`
}

export function Spinner({ label = 'Thinking', totalTokens }: SpinnerProps) {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const startTimeRef = useRef(Date.now())

  useEffect(() => {
    startTimeRef.current = Date.now()
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % FRAMES.length)
      setElapsed(Date.now() - startTimeRef.current)
    }, 80)
    return () => clearInterval(timer)
  }, [])

  const hasTokens = totalTokens != null && totalTokens > 0
  const showMeta = elapsed >= 2000 || hasTokens

  const parts: string[] = []
  if (elapsed >= 2000) parts.push(formatElapsed(elapsed))
  if (hasTokens) parts.push(`↓ ${formatTokens(totalTokens)} tokens`)
  const metaStr = parts.join(' · ')

  return (
    <Text>
      <Text color={ACCENT}>  {FRAMES[frame]} </Text>
      <Text color={ACCENT}>{label}...</Text>
      {showMeta && <Text color={DIM}> ({metaStr})</Text>}
    </Text>
  )
}
