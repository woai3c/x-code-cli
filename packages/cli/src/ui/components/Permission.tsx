// @x-code-cli/cli — Permission confirmation component
//
// Aligned with Claude Code's PermissionDialog + PermissionPrompt:
//   - Manual separator line (no Ink border Box — avoids Yoga width jitter)
//   - Select-based Yes/No options with quick-keys
//   - Diff preview for writeFile / edit tools
import { diffLines } from 'diff'

import fs from 'node:fs/promises'

import React, { useEffect, useState } from 'react'

import { Box, Text, useInput, useStdout } from 'ink'

import { getPermissionLevel } from '@x-code-cli/core'

import { ACCENT, DIM, ERROR, PROMPT_BORDER, SUCCESS, WARNING } from '../theme.js'

// ─── Types ──────────────────────────────────────────────────────────────────

interface PermissionProps {
  toolName: string
  input: Record<string, unknown>
  onResolve: (approved: boolean) => void
}

const PERMISSION_LABELS: Record<string, { label: string; color: string }> = {
  'always-allow': { label: 'read-only', color: SUCCESS },
  ask: { label: 'write', color: WARNING },
  deny: { label: 'dangerous', color: ERROR },
}

// ─── Title helpers ──────────────────────────────────────────────────────────

/** Human-readable title for each tool */
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

// ─── Main component ─────────────────────────────────────────────────────────

export function Permission({ toolName, input, onResolve }: PermissionProps) {
  const [selected, setSelected] = useState(0)
  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? 80

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelected((prev) => (prev > 0 ? prev - 1 : 1))
    } else if (key.downArrow) {
      setSelected((prev) => (prev < 1 ? prev + 1 : 0))
    } else if (key.return) {
      onResolve(selected === 0)
    } else {
      const ch = _input.toLowerCase()
      if (ch === 'y') onResolve(true)
      else if (ch === 'n') onResolve(false)
    }
  })

  // Tool-specific content line
  let contentLine: React.ReactNode = null

  if (toolName === 'shell') {
    const level = getPermissionLevel('shell', input)
    const info = PERMISSION_LABELS[level] ?? PERMISSION_LABELS.ask
    contentLine = (
      <Text>
        <Text color={ACCENT}>  $ {input.command as string} </Text>
        <Text color={info.color}>[{info.label}]</Text>
      </Text>
    )
  } else if (toolName === 'writeFile') {
    contentLine = <WriteFilePreview filePath={input.filePath as string} content={input.content as string} />
  } else if (toolName === 'edit') {
    const filePath = input.filePath as string
    const oldStr = input.oldString as string
    const newStr = input.newString as string
    contentLine = (
      <Box flexDirection="column">
        <Text color={ACCENT}>  {filePath}</Text>
        <DiffView oldText={oldStr} newText={newStr} />
      </Box>
    )
  }

  // Manual separator — avoids Ink border Box which causes Yoga width
  // jitter with CJK/ambiguous-width characters.
  const separator = '─'.repeat(Math.max(0, termWidth - 1))

  return (
    <Box flexDirection="column">
      <Text color={PROMPT_BORDER}>{separator}</Text>
      <Text color={WARNING} bold>
        {'  '}{getPermissionTitle(toolName)}
      </Text>
      {contentLine}
      <Box flexDirection="column">
        <Text>
          <Text color={selected === 0 ? SUCCESS : DIM} bold={selected === 0}>
            {'  '}{selected === 0 ? '❯ ' : '  '}Yes
          </Text>
        </Text>
        <Text>
          <Text color={selected === 1 ? ERROR : DIM} bold={selected === 1}>
            {'  '}{selected === 1 ? '❯ ' : '  '}No
          </Text>
        </Text>
      </Box>
    </Box>
  )
}

// ─── writeFile preview ──────────────────────────────────────────────────────

/** writeFile preview — shows diff if file already exists, else shows content summary */
function WriteFilePreview({ filePath, content }: { filePath: string; content: string }) {
  const [existingContent, setExistingContent] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fs.readFile(filePath, 'utf-8')
      .then((data) => {
        setExistingContent(data)
        setLoaded(true)
      })
      .catch(() => {
        setExistingContent(null)
        setLoaded(true)
      })
  }, [filePath])

  if (!loaded) {
    return <Text dimColor>  Loading...</Text>
  }

  // Existing file — show diff
  if (existingContent !== null) {
    return (
      <Box flexDirection="column">
        <Text color={ACCENT}>  {filePath} (overwrite)</Text>
        <DiffView oldText={existingContent} newText={content} />
      </Box>
    )
  }

  // New file — show content summary
  return (
    <Box flexDirection="column">
      <Text color={ACCENT}>  {filePath} (new file)</Text>
      <Text dimColor>
        {'  '}{content.slice(0, 300)}
        {content.length > 300 ? '\n  ...' : ''}
      </Text>
    </Box>
  )
}

// ─── Diff view ──────────────────────────────────────────────────────────────

/** Render a unified diff with red/green coloring */
function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const changes = diffLines(oldText, newText)
  const maxLines = 20
  let lineCount = 0

  const elements: React.ReactNode[] = []
  for (const change of changes) {
    const lines = change.value.split('\n').filter((l) => l !== '' || change.value === '\n')
    for (const line of lines) {
      if (lineCount >= maxLines) {
        elements.push(
          <Text key="truncated" dimColor>
            {'  '}... (diff truncated)
          </Text>,
        )
        return <Box flexDirection="column">{elements}</Box>
      }
      if (change.added) {
        elements.push(
          <Text key={`+${lineCount}`} color={SUCCESS}>
            {'  '}+ {line}
          </Text>,
        )
      } else if (change.removed) {
        elements.push(
          <Text key={`-${lineCount}`} color={ERROR}>
            {'  '}- {line}
          </Text>,
        )
      } else {
        elements.push(
          <Text key={` ${lineCount}`} dimColor>
            {'    '}
            {line}
          </Text>,
        )
      }
      lineCount++
    }
  }

  return <Box flexDirection="column">{elements}</Box>
}
