// @x-code-cli/core — Shared tool error formatting
//
// All `tool({ execute })` bodies follow the same pattern: catch unknown,
// extract a string message, and return `Error <action>: <msg>`. Centralising
// it here keeps the wording consistent and removes ~7 copies of the
// `err instanceof Error ? err.message : String(err)` snippet.

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Format a tool failure as a user-facing string the model will see as the
 *  tool result. `action` is a short verb phrase ("reading file", "searching"). */
export function formatToolError(action: string, err: unknown): string {
  return `Error ${action}: ${toErrorMessage(err)}`
}
