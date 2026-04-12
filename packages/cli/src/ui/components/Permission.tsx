// @x-code-cli/cli — Permission confirmation component
//
// Architecture aligned with Claude Code's PermissionDialog + PermissionPrompt:
//   - Top-only border (no left/right/bottom) to minimise dynamic-region height
//   - Select-based options instead of raw y/n keypresses
//   - Diff preview for writeFile / edit tools
import { diffLines } from 'diff'

import fs from 'node:fs/promises'

import React, { useEffect, useState } from 'react'

import { Box, Text, useInput } from 'ink'

import { getPermissionLevel } from '@x-code-cli/core'

import { ACCENT, DIM, ERROR, SUCCESS, WARNING } from '../theme.js'

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

/** Short subtitle describing the target */
function getPermissionSubtitle(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'shell') return (input.command as string) ?? null
  if (toolName === 'writeFile' || toolName === 'edit') return (input.filePath as string) ?? null
  return null
}

// ─── Select options ─────────────────────────────────────────────────────────

interface SelectOption {
  label: string
  value: boolean
  color: string
}

const OPTIONS: SelectOption[] = [
  { label: 'Yes', value: true, color: SUCCESS },
  { label: 'No', value: false, color: ERROR },
]

// ─── Main component ─────────────────────────────────────────────────────────

export function Permission({ toolName, input, onResolve }: PermissionProps) {
  const [selected, setSelected] = useState(0)

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelected((prev) => (prev > 0 ? prev - 1 : OPTIONS.length - 1))
    } else if (key.downArrow) {
      setSelected((prev) => (prev < OPTIONS.length - 1 ? prev + 1 : 0))
    } else if (key.return) {
      onResolve(OPTIONS[selected].value)
    } else {
      // Quick-keys: y / n
      const ch = _input.toLowerCase()
      if (ch === 'y') onResolve(true)
      else if (ch === 'n') onResolve(false)
    }
  })

  // Tool-specific preview
  let preview: React.ReactNode = null

  if (toolName === 'shell') {
    const level = getPermissionLevel('shell', input)
    const info = PERMISSION_LABELS[level] ?? PERMISSION_LABELS.ask
    preview = (
      <Box flexDirection="column" marginLeft={1}>
        <Box gap={1}>
          <Text color={ACCENT}>$ {input.command as string}</Text>
          <Text color={info.color}>[{info.label}]</Text>
        </Box>
      </Box>
    )
  } else if (toolName === 'writeFile') {
    preview = <WriteFilePreview filePath={input.filePath as string} content={input.content as string} />
  } else if (toolName === 'edit') {
    const filePath = input.filePath as string
    const oldStr = input.oldString as string
    const newStr = input.newString as string
    preview = (
      <Box flexDirection="column" marginLeft={1}>
        <Text color={ACCENT}>{filePath}</Text>
        <DiffView oldText={oldStr} newText={newStr} />
      </Box>
    )
  }

  const subtitle = getPermissionSubtitle(toolName, input)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={WARNING}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      marginTop={1}
    >
      {/* Title bar */}
      <Box paddingX={1} flexDirection="column">
        <Text color={WARNING} bold>
          {getPermissionTitle(toolName)}
        </Text>
        {subtitle && (
          <Text color={DIM} wrap="truncate-end">
            {subtitle}
          </Text>
        )}
      </Box>

      {/* Content */}
      <Box flexDirection="column" paddingX={1}>
        {preview}

        {/* Select options */}
        <Box marginTop={1} flexDirection="column">
          {OPTIONS.map((opt, i) => (
            <Box key={opt.label}>
              <Text color={i === selected ? opt.color : DIM}>
                {i === selected ? '> ' : '  '}
                {opt.label}
              </Text>
            </Box>
          ))}
          <Text dimColor>  ↑↓ Navigate  Enter Confirm  y/n Quick-key</Text>
        </Box>
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
    return (
      <Box marginLeft={1}>
        <Text dimColor>Loading...</Text>
      </Box>
    )
  }

  // Existing file — show diff
  if (existingContent !== null) {
    return (
      <Box flexDirection="column" marginLeft={1}>
        <Text color={ACCENT}>{filePath} (overwrite)</Text>
        <DiffView oldText={existingContent} newText={content} />
      </Box>
    )
  }

  // New file — show content summary
  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text color={ACCENT}>{filePath} (new file)</Text>
      <Text dimColor>
        {content.slice(0, 300)}
        {content.length > 300 ? '\n...' : ''}
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
            ... (diff truncated)
          </Text>,
        )
        return <Box flexDirection="column">{elements}</Box>
      }
      if (change.added) {
        elements.push(
          <Text key={`+${lineCount}`} color={SUCCESS}>
            + {line}
          </Text>,
        )
      } else if (change.removed) {
        elements.push(
          <Text key={`-${lineCount}`} color={ERROR}>
            - {line}
          </Text>,
        )
      } else {
        elements.push(
          <Text key={` ${lineCount}`} dimColor>
            {'  '}
            {line}
          </Text>,
        )
      }
      lineCount++
    }
  }

  return <Box flexDirection="column">{elements}</Box>
}
