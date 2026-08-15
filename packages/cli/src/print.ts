// @x-code-cli/cli — Non-interactive (-p / --print) runner.
//
// Intentionally bypasses Ink entirely: no TUI components, no raw-mode stdin,
// no reconciler frames waiting on input events. The Ink path couldn't reliably
// auto-exit in print mode because `usePromptInput` ref'd stdin in raw mode,
// keeping the event loop alive until the user pressed a key or resized the
// terminal — at which point the queued unmount finally ran. Keeping print
// mode as a separate code path sidesteps every one of those landmines.
import { agentLoop, createLoopState, hydrateLoopState, saveSession } from '@x-code-cli/core'
import type { AgentCallbacks, AgentOptions, LanguageModel, LoadedSession } from '@x-code-cli/core'

import { registerCleanupController } from './cleanup-controller.js'
import { SHELL_SHUTDOWN_BUDGET, runShutdownPhases } from './shutdown-coordinator.js'

export async function runPrintMode(
  model: LanguageModel,
  options: AgentOptions,
  prompt: string,
  initialSession?: LoadedSession | null,
): Promise<number> {
  // Abort on Ctrl+C so a long-running -p invocation is interruptible.
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)

  let sawError = false
  let exitCode = 0
  let shouldSaveSession = false
  const state = initialSession
    ? hydrateLoopState(initialSession, options.permissionMode ?? 'default', process.cwd())
    : createLoopState(options.permissionMode ?? 'default', { projectCwd: process.cwd() })

  registerCleanupController({
    terminateShells: (reason, budget = SHELL_SHUTDOWN_BUDGET) => state.shellSessions.dispose(reason, budget),
    drain: async () => {
      await options.memoryService?.shutdown(options.memoryService.getConfig().drainTimeoutMs)
    },
  })

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
      process.stderr.write(`\n[permission denied: ${toolCall.toolName} — pass --trust to auto-approve in -p mode]\n`)
      return 'no'
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
    onStreamRetry: (event) => {
      if (event) process.stderr.write(`\nReconnecting... ${event.attempt}/${event.maxAttempts}\n`)
    },
    onError: (err) => {
      sawError = true
      process.stderr.write(`\n[error] ${err.message}\n`)
    },
  }

  try {
    // Honor --continue / --resume in print mode by hydrating the loop state
    // from the loaded session. Without this, main() loads the previous jsonl
    // but the agent starts a brand-new conversation here, silently dropping
    // the resume request. The Ink path threads this through useAgent →
    // hydrateLoopState; print mode just needed the same wiring.
    await agentLoop(prompt, model, { ...options, abortSignal: controller.signal }, callbacks, state)

    // End on a newline when stdout is a TTY so the shell prompt lands on
    // a fresh line. When piped, trust the model's output verbatim.
    if (process.stdout.isTTY) process.stdout.write('\n')

    shouldSaveSession = true
    exitCode = sawError ? 1 : 0
  } catch (err) {
    process.stderr.write(`\n[fatal] ${err instanceof Error ? err.message : String(err)}\n`)
    exitCode = 1
  } finally {
    process.off('SIGINT', onSigint)
    const shutdown = await runShutdownPhases({
      controller: {
        terminateShells: (reason, budget = SHELL_SHUTDOWN_BUDGET) => state.shellSessions.dispose(reason, budget),
        drain: async () => {
          await options.memoryService?.shutdown(options.memoryService.getConfig().drainTimeoutMs)
        },
      },
      reason: 'print-exit',
      ordinaryFinalizers: shouldSaveSession ? [() => saveSession(state, model).catch(() => undefined)] : [],
    })
    if (shutdown.emergency.requested > 0 && exitCode === 0) exitCode = 1
    registerCleanupController(null)
    // Flush stdout/stderr before returning so the caller's process.exit()
    // doesn't race the pipe drain. On Windows, pipe writes are non-blocking —
    // without this, error messages written via process.stderr.write() can be
    // silently lost when the process exits immediately after.
    await new Promise<void>((resolve) => {
      process.stdout.write('', () => process.stderr.write('', () => resolve()))
    })
  }
  return exitCode
}
