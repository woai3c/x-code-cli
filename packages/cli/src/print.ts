// @x-code-cli/cli — Non-interactive (-p / --print) runner.
//
// Intentionally bypasses Ink entirely: no TUI components, no raw-mode stdin,
// no reconciler frames waiting on input events. The Ink path couldn't reliably
// auto-exit in print mode because `usePromptInput` ref'd stdin in raw mode,
// keeping the event loop alive until the user pressed a key or resized the
// terminal — at which point the queued unmount finally ran. Keeping print
// mode as a separate code path sidesteps every one of those landmines.

import { agentLoop, saveSession } from '@x-code-cli/core'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '@x-code-cli/core'

export async function runPrintMode(
  model: LanguageModel,
  options: AgentOptions,
  prompt: string,
): Promise<number> {
  // Abort on Ctrl+C so a long-running -p invocation is interruptible.
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)

  let sawError = false

  const callbacks: AgentCallbacks = {
    onTextDelta: (delta) => {
      if (delta) process.stdout.write(delta)
    },
    onToolCall: () => {},
    onToolProgress: () => {},
    onToolResult: () => {},
    onAskPermission: async (toolCall) => {
      // Non-interactive — we can't prompt. Deny and let the model adapt;
      // users who want tool writes in -p mode should pass -t / --trust.
      process.stderr.write(
        `\n[permission denied: ${toolCall.toolName} — pass --trust to auto-approve in -p mode]\n`,
      )
      return false
    },
    onAskUser: async (question) => {
      process.stderr.write(`\n[cannot ask question in -p mode: ${question}]\n`)
      return ''
    },
    onPlanApprovalRequest: async () => {
      // Non-interactive — can't show an approval dialog. Deny so the
      // model stays in plan mode and writes a final plan rather than
      // pretending the user accepted something they never saw.
      process.stderr.write(`\n[plan approval not available in -p mode — pass --plan + interactive session]\n`)
      return false
    },
    onPlanModeChange: () => {
      // No UI to update in print mode; the mode change still takes
      // effect on LoopState, which is the only place it actually
      // matters for this short-lived run.
    },
    onTodosUpdate: () => {
      // No live panel in print mode — todos exist on LoopState but
      // there's no terminal UI to render them. Silent no-op.
    },
    onShellOutput: () => {},
    onUsageUpdate: () => {},
    onContextCompressed: () => {},
    onError: (err) => {
      sawError = true
      process.stderr.write(`\n[error] ${err.message}\n`)
    },
  }

  try {
    const state = await agentLoop(
      prompt,
      model,
      { ...options, abortSignal: controller.signal },
      callbacks,
    )

    // End on a newline when stdout is a TTY so the shell prompt lands on
    // a fresh line. When piped, trust the model's output verbatim.
    if (process.stdout.isTTY) process.stdout.write('\n')

    // Fire-and-forget session save: don't block exit on it, matching the
    // Ink path's stance that users care more about exit latency than
    // summaries landing on disk.
    saveSession(state, model).catch(() => undefined)

    return sawError ? 1 : 0
  } catch (err) {
    process.stderr.write(`\n[fatal] ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  } finally {
    process.off('SIGINT', onSigint)
  }
}
