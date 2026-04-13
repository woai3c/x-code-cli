// @x-code-cli/cli — Permission confirmation component
//
// Pre-rendered as a single ANSI string (same strategy as ChatInput)
// to avoid Ink's Yoga/wrap-ansi CJK width miscalculation.
import { Chalk } from 'chalk'

import React, { useState } from 'react'

import { Text, useInput, useStdout } from 'ink'

import { getPermissionLevel } from '@x-code-cli/core'

const c = new Chalk({ level: 3 })

// Theme colors (inline to avoid import issues with chalk)
const CLR = {
  accent: '#d77757',
  success: '#4eba65',
  error: '#ff6b80',
  warning: '#ffc107',
  dim: '#999999',
  border: '#888888',
}

interface PermissionProps {
  toolName: string
  input: Record<string, unknown>
  onResolve: (approved: boolean) => void
}

const PERMISSION_LABELS: Record<string, { label: string; color: string }> = {
  'always-allow': { label: 'read-only', color: CLR.success },
  ask: { label: 'write', color: CLR.warning },
  deny: { label: 'dangerous', color: CLR.error },
}

function getPermissionTitle(toolName: string): string {
  switch (toolName) {
    case 'shell':
      return 'X-Code wants to run a shell command'
    case 'writeFile':
      return 'X-Code wants to write a file'
    case 'edit':
      return 'X-Code wants to edit a file'
    default:
      return `X-Code wants to use ${toolName}`
  }
}

export function Permission({ toolName, input, onResolve }: PermissionProps) {
  const [selected, setSelected] = useState(0)
  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? 80

  useInput((_input, key) => {
    if (key.upArrow) setSelected((p) => (p > 0 ? p - 1 : 1))
    else if (key.downArrow) setSelected((p) => (p < 1 ? p + 1 : 0))
    else if (key.return) onResolve(selected === 0)
    else {
      const ch = _input.toLowerCase()
      if (ch === 'y') onResolve(true)
      else if (ch === 'n') onResolve(false)
    }
  })

  // Build content lines
  let contentStr = ''
  if (toolName === 'shell') {
    const level = getPermissionLevel('shell', input)
    const info = PERMISSION_LABELS[level] ?? PERMISSION_LABELS.ask
    contentStr = `  ${c.hex(CLR.accent)('$ ' + (input.command as string))} ${c.hex(info.color)('[' + info.label + ']')}`
  } else if (toolName === 'writeFile') {
    const filePath = input.filePath as string
    contentStr = `  ${c.hex(CLR.accent)(filePath)} (new file)`
  } else if (toolName === 'edit') {
    const filePath = input.filePath as string
    contentStr = `  ${c.hex(CLR.accent)(filePath)}`
  }

  const separator = c.hex(CLR.border)('─'.repeat(Math.max(0, termWidth - 1)))
  const title = `  ${c.hex(CLR.warning).bold(getPermissionTitle(toolName))}`

  const yesLine = selected === 0 ? `    ${c.hex(CLR.success).bold('❯ Yes')}` : `      ${c.hex(CLR.dim)('Yes')}`
  const noLine = selected === 1 ? `    ${c.hex(CLR.error).bold('❯ No')}` : `      ${c.hex(CLR.dim)('No')}`

  const lines = [separator, title]
  if (contentStr) lines.push(contentStr)
  lines.push(yesLine, noLine)

  const rendered = lines.join('\n')

  return <Text wrap="truncate-end">{rendered}</Text>
}
