// @x-code-cli/core — Tool progress reporter (side channel)
//
// AI SDK tool `execute` functions run on their own — we don't own the
// call site, so there's no direct way to thread a progress callback
// into them as a parameter. Instead we keep a small module-level
// registry keyed by `toolCallId`: the agent loop registers a reporter
// when the model emits a tool-call event, tools look it up inside
// execute() via `reportProgress(toolCallId, msg)`, and the loop clears
// it on tool-result.
//
// Why not pass via `tool()` options: the AI SDK does surface
// `{ toolCallId }` as the second arg to execute, but there's no way to
// hand the per-call UI callback through the `streamText({ tools })`
// definition without wrapping every tool. A lookup by toolCallId keeps
// the tool definitions clean and works identically for our
// manually-dispatched tools (shell, writeFile, edit, askUser) in
// tool-execution.ts.
export type ProgressReporter = (message: string) => void

const reporters = new Map<string, ProgressReporter>()

export function setProgressReporter(toolCallId: string, fn: ProgressReporter): void {
  reporters.set(toolCallId, fn)
}

export function clearProgressReporter(toolCallId: string): void {
  reporters.delete(toolCallId)
}

/** No-op if no reporter is registered. Safe to call from anywhere. */
export function reportProgress(toolCallId: string | undefined, message: string): void {
  if (!toolCallId) return
  reporters.get(toolCallId)?.(message)
}
