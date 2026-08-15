import type { ShellSessionController, TerminateAllResult } from '@x-code-cli/core'

import { errorMessage } from '../../../../core/src/utils.js'

export type ShellSessionTransitionResult =
  | { ok: true; result: TerminateAllResult }
  | { ok: false; reason: string; result?: TerminateAllResult }

export async function disposeShellSessionsForTransition(
  manager: Pick<ShellSessionController, 'dispose'>,
  reason: 'clear' | 'resume',
): Promise<ShellSessionTransitionResult> {
  let result: TerminateAllResult
  try {
    result = await manager.dispose(reason)
  } catch (error) {
    return { ok: false, reason: errorMessage(error) }
  }

  if (result.results.some((entry) => !entry.treeConfirmedExited)) {
    return { ok: false, reason: 'background terminal cleanup was not confirmed', result }
  }
  return { ok: true, result }
}
