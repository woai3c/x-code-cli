// @x-code-cli/cli — Scrollback append helpers for slash command output.
//
// Extracted from useAgent: a small sub-hook that wraps `appendMessage`
// (the setState-bumping primitive) in five common shapes used by the App's
// slash command handlers. Sub-hook over plain functions because each is a
// useCallback whose memo identity matters for downstream consumers.
import { useCallback } from 'react'

import type { DisplayMessage } from '@x-code-cli/core'

export function useAgentDisplayHelpers(appendMessage: (msg: DisplayMessage) => void) {
  const addMessage = useCallback(
    (role: 'user' | 'assistant', content: string) => {
      appendMessage({
        id: Date.now().toString(),
        role,
        content,
        timestamp: Date.now(),
      })
    },
    [appendMessage],
  )

  /** Add a system/info message (for slash command output) */
  const addInfoMessage = useCallback((content: string) => addMessage('assistant', content), [addMessage])

  /** Add a user message to the history (for echoing slash commands) */
  const addUserMessage = useCallback((content: string) => addMessage('user', content), [addMessage])

  /** Render a slash command + its short result as a Claude-style 2-line block:
   *    > /cmd
   *      ⎿  result
   *  Use for single-line command responses. For long multi-line output
   *  (/help, /usage, /init) call addUserMessage + addInfoMessage directly. */
  const addCommandMessage = useCallback(
    (commandText: string, resultText: string) => {
      const base = Date.now()
      appendMessage({
        id: `cmd-${base}`,
        role: 'user',
        content: commandText,
        timestamp: base,
        kind: 'command-echo',
      })
      appendMessage({
        id: `cmd-res-${base}`,
        role: 'assistant',
        content: resultText,
        timestamp: base,
        kind: 'command-result',
      })
    },
    [appendMessage],
  )

  /** Append an extra `  ⎿  result` line under the most recent command echo
   *  WITHOUT re-echoing the command. For multi-step slash commands like
   *  /mcp refresh and /mcp auth where one user input produces a tight
   *  result block that fills in over time:
   *    > /mcp auth sentry
   *      ⎿  Authenticating "sentry" — opening browser...    (addCommandMessage)
   *      ⎿  Opened https://...                              (addCommandResult)
   *           Waiting for the authorization redirect...
   *      ⎿  ✓ Authenticated "sentry" — 14 tools             (addCommandResult)
   *  Using addInfoMessage for the follow-ups would render each piece as a
   *  standalone assistant block with leading + trailing blank rows, padding
   *  the result with 3+ blanks before the next prompt. */
  const addCommandResult = useCallback(
    (content: string) => {
      const base = Date.now()
      appendMessage({
        id: `cmd-res-${base}`,
        role: 'assistant',
        content,
        timestamp: base,
        kind: 'command-result',
      })
    },
    [appendMessage],
  )

  return { addInfoMessage, addUserMessage, addCommandMessage, addCommandResult }
}
