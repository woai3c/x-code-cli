// @x-code-cli/cli — Loading spinner component with elapsed time and token count
//
// Visible throughout the entire isLoading phase (not hidden during streaming).
// Arrow direction follows Claude Code's convention:
//   ↑ = requesting (sending to API, waiting for first token)
//   ↓ = responding/thinking/tool-use (receiving output)
import React, { useEffect, useRef, useState } from 'react'

import { Text } from 'ink'

import { ACCENT, DIM } from '../theme.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export type SpinnerMode = 'requesting' | 'responding' | 'thinking' | 'tool-use'

interface SpinnerProps {
  label?: string
  /** Cumulative total tokens */
  totalTokens?: number
  /** Current phase — controls arrow direction */
  mode?: SpinnerMode
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

export function Spinner({ label = 'Thinking', totalTokens, mode = 'requesting' }: SpinnerProps) {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const startTimeRef = useRef(0)

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
  const arrow = mode === 'requesting' ? '↑' : '↓'

  const parts: string[] = []
  if (elapsed >= 2000) parts.push(formatElapsed(elapsed))
  if (hasTokens) parts.push(`${arrow} ${formatTokens(totalTokens)} tokens`)
  const metaStr = parts.join(' · ')

  return (
    <Text>
      <Text color={ACCENT}>  {FRAMES[frame]} </Text>
      <Text color={ACCENT}>{label}...</Text>
      {showMeta && <Text color={DIM}> ({metaStr})</Text>}
    </Text>
  )
}
