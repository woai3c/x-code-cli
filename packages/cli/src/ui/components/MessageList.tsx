// @x-code-cli/cli — Message history, written directly to stdout via
// Ink's useStdout().write (a log-update-coordinated writer that lands
// the content above the current dynamic region without going through
// the console patch).
//
// Historical note: this used to render the message list inside an Ink
// <Static> region. That approach broke on long CJK responses because Ink's
// Yoga-based layout miscalculates the visual width of wide characters,
// causing cursor-rewind repaints to overlap previous content.
//
// The fix is to bypass Ink's layout for message history. We render nothing
// in the React tree; instead, a useEffect detects newly-appended messages
// and pushes them to stdout via Ink's own `write` function (from the
// StdoutContext) which properly coordinates with log-update. The terminal
// itself handles line wrapping, so CJK width is no longer a problem.
import { useEffect, useRef } from 'react'

import { useStdout } from 'ink'

import type { DisplayMessage } from '@x-code-cli/core'

import { writeMessageToStdout } from '../stdout-writer.js'

interface MessageListProps {
  messages: DisplayMessage[]
}

export function MessageList({ messages }: MessageListProps) {
  // Ink's own stdout writer — documented as "similar to <Static>, except
  // it accepts strings, not components". It wraps Ink's internal
  // writeToStdout which does `log.clear() → stdout.write(data) → log(lastOutput)`
  // in a single atomic step, so our content lands safely above whatever
  // dynamic region Ink is currently rendering.
  const { write } = useStdout()

  // Track how many messages we've already written, so we only print the
  // delta on each render rather than re-printing everything.
  const writtenCountRef = useRef(0)

  useEffect(() => {
    // A /clear slash command rewinds state.messages to []. Reset our cursor
    // so the next batch gets written cleanly. (The terminal scrollback
    // already contains the cleared content; we just don't re-print it.)
    if (messages.length < writtenCountRef.current) {
      writtenCountRef.current = messages.length
      return
    }
    if (messages.length === writtenCountRef.current) return
    for (let i = writtenCountRef.current; i < messages.length; i++) {
      writeMessageToStdout(write, messages[i])
    }
    writtenCountRef.current = messages.length
  }, [messages, write])

  return null
}
