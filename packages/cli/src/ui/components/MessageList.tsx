// @x-code-cli/cli — Message history (uses Ink Static for performance)
//
// Static items are rendered ONCE and written permanently to the terminal's
// scrollback buffer.  Ink never clears or redraws them.
//
// Formatting follows Claude Code's visual style:
//   ● — assistant thinking / text messages
//   ⎿ — tool results
//   Tool calls shown as: ● ToolName(input_preview)
//   Tool results shown as: ⎿ result_summary (duration)
import React from 'react'

import { Box, Static, Text } from 'ink'

import type { DisplayMessage, DisplayToolCall } from '@x-code-cli/core'

import { renderMarkdown } from '../render-markdown.js'
import { ACCENT, DIM, ERROR, SUCCESS } from '../theme.js'
import { getToolInputPreview, getToolLabel, getToolResultSummary } from '../tool-display.js'

interface MessageListProps {
  messages: DisplayMessage[]
}

/** Format duration in human-readable form */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return `${minutes}m ${secs}s`
}

/**
 * Indent continuation lines of a multi-line string to align with
 * the content after the `⎿  ` prefix (5 chars of indentation).
 */
const RESULT_INDENT = '     '

/** Render a single tool call in Claude Code style */
function ToolCallEntry({ tc }: { tc: DisplayToolCall }) {
  const label = getToolLabel(tc.toolName)
  const inputPreview = getToolInputPreview(tc.toolName, tc.input)
  const resultSummary = getToolResultSummary(tc.toolName, tc.output, tc.status)
  const isDenied = tc.status === 'denied'
  const durationStr = tc.durationMs != null ? formatDuration(tc.durationMs) : null

  // Indent all continuation lines so they align under the ⎿ content
  let formattedResult = resultSummary
  if (resultSummary && resultSummary.includes('\n')) {
    const lines = resultSummary.split('\n')
    formattedResult = lines.map((line, i) => (i === 0 ? line : RESULT_INDENT + line)).join('\n')
  }

  return (
    <Box flexDirection="column" marginLeft={1}>
      {/* Tool call line: ● ToolName(input_preview) */}
      <Text>
        <Text color={isDenied ? ERROR : SUCCESS}>{'● '}</Text>
        <Text bold>{label}</Text>
        <Text dimColor>({inputPreview})</Text>
      </Text>
      {/* Result line: ⎿ result_summary (duration) */}
      {formattedResult && (
        <Text>
          <Text color={DIM}>{'  ⎿  '}</Text>
          <Text color={isDenied ? ERROR : undefined} dimColor={!isDenied}>
            {formattedResult}
          </Text>
          {durationStr && <Text color={DIM}> ({durationStr})</Text>}
        </Text>
      )}
    </Box>
  )
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Static items={messages}>
      {(msg) => (
        <Box key={msg.id} flexDirection="column" marginBottom={0}>
          {msg.role === 'user' ? (
            // User message: ❯ input
            <Box marginBottom={1}>
              <Text>
                <Text color={ACCENT} bold>
                  {'❯ '}
                </Text>
                {msg.content}
              </Text>
            </Box>
          ) : (
            // Assistant message: tool calls and/or text content
            <Box flexDirection="column">
              {/* Render tool calls */}
              {msg.toolCalls?.map((tc) => (
                <ToolCallEntry key={tc.id} tc={tc} />
              ))}
              {/* Assistant text content */}
              {msg.content && (
                <Box flexDirection="column" marginLeft={2}>
                  <Text>{renderMarkdown(msg.content)}</Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      )}
    </Static>
  )
}
