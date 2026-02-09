// @x-code/cli — Permission confirmation component (Y/N + diff preview)
import { diffLines } from 'diff'

import fs from 'node:fs/promises'

import React, { useEffect, useState } from 'react'

import { Box, Text, useInput } from 'ink'

import { getPermissionLevel } from '@x-code/core'

interface PermissionProps {
  toolName: string
  input: Record<string, unknown>
  onResolve: (approved: boolean) => void
}

const PERMISSION_LABELS: Record<string, { label: string; color: string }> = {
  'always-allow': { label: 'read-only', color: 'green' },
  ask: { label: 'write', color: 'yellow' },
  deny: { label: 'dangerous', color: 'red' },
}

export function Permission({ toolName, input, onResolve }: PermissionProps) {
  useInput((inputKey) => {
    if (inputKey.toLowerCase() === 'y') onResolve(true)
    else if (inputKey.toLowerCase() === 'n') onResolve(false)
  })

  // Tool-specific preview
  let preview: React.ReactNode = null

  if (toolName === 'shell') {
    const level = getPermissionLevel('shell', input)
    const info = PERMISSION_LABELS[level] ?? PERMISSION_LABELS.ask
    preview = (
      <Box flexDirection="column" marginLeft={2}>
        <Box gap={1}>
          <Text color="cyan">$ {input.command as string}</Text>
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
      <Box flexDirection="column" marginLeft={2}>
        <Text color="cyan">{filePath}</Text>
        <DiffView oldText={oldStr} newText={newStr} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        ? Allow {toolName}? (y/n)
      </Text>
      {preview}
    </Box>
  )
}

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
      <Box marginLeft={2}>
        <Text dimColor>Loading...</Text>
      </Box>
    )
  }

  // Existing file — show diff
  if (existingContent !== null) {
    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text color="cyan">{filePath} (overwrite)</Text>
        <DiffView oldText={existingContent} newText={content} />
      </Box>
    )
  }

  // New file — show content summary
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color="cyan">{filePath} (new file)</Text>
      <Text dimColor>
        {content.slice(0, 300)}
        {content.length > 300 ? '\n...' : ''}
      </Text>
    </Box>
  )
}

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
          <Text key={`+${lineCount}`} color="green">
            + {line}
          </Text>,
        )
      } else if (change.removed) {
        elements.push(
          <Text key={`-${lineCount}`} color="red">
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
