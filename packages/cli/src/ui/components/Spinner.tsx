// @x-code/cli — Loading spinner component
import React, { useEffect, useState } from 'react'

import { Text } from 'ink'

import { ACCENT } from '../theme.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

interface SpinnerProps {
  label?: string
}

export function Spinner({ label = 'Thinking...' }: SpinnerProps) {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % FRAMES.length)
    }, 80)
    return () => clearInterval(timer)
  }, [])

  return (
    <Text color={ACCENT}>
      {FRAMES[frame]} {label}
    </Text>
  )
}
