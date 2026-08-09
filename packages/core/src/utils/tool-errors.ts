// @x-code-cli/core — Shared tool error formatting
//
// All `tool({ execute })` bodies follow the same pattern: catch unknown,
// extract a string message, and return `Error <action>: <msg>`. Centralising
// it here keeps the wording consistent and removes ~7 copies of the
// `err instanceof Error ? err.message : String(err)` snippet.

function toErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)

  const messages: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current instanceof Error && messages.length < 6 && !seen.has(current)) {
    seen.add(current)
    if (current.message && !messages.includes(current.message)) messages.push(current.message)
    current = current.cause
  }

  if (messages.length <= 1) return messages[0] ?? err.name
  return `${messages[0]} (cause: ${messages.slice(1).join(' → ')})`
}

/** Format a tool failure as a user-facing string the model will see as the
 *  tool result. `action` is a short verb phrase ("reading file", "searching"). */
export function formatToolError(action: string, err: unknown): string {
  return `Error ${action}: ${toErrorMessage(err)}`
}
