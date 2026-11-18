// @x-code-cli/cli — Frame-flush scheduling policy for ChatInput.
//
// Separates interactive user-input responsiveness from passive background
// anti-flicker windows:
//   - Passive spinner ticks coalesce inside 16ms and defer 160ms so nearby
//     stream-buffer commits (150ms cadence) absorb them into one atomic write.
//   - Passive structural commits keep a 50ms inter-write gap (~3 vsyncs) to
//     avoid back-to-back full-frame repaints flickering on weaker terminals.
//   - Renders carrying unflushed user input (typing, backspace, cursor/menu
//     navigation, modal selection, interrupt notice) flush immediately on the
//     leading edge and cap any intra-frame trailing coalesce to 16ms (60Hz),
//     measured from `lastFlushTime` so rapid typing never pushes the deadline
//     outward or inherits the 160ms spinner defer.

export const MIN_COMMIT_GAP_MS = 50
export const INPUT_FRAME_BUDGET_MS = 16
export const SPINNER_DEFER_MS = 160
export const STRUCTURAL_DEFER_MS = 8

export interface InteractiveKeyInput {
  text: string
  cursor: number
  completionIndex: number
  atCompletionIndex: number
  atDismissed: string | null
  permissionSelected: number
  permissionFeedback: { text: string; cursor: number } | null
  selectIndex: number
  freeform: { text: string; cursor: number }
  authoritySelected: number
  authorityPage: number
  notice: string | null | undefined
}

export function buildInteractiveKey(state: InteractiveKeyInput): string {
  const feedback = state.permissionFeedback ? `${state.permissionFeedback.cursor}:${state.permissionFeedback.text}` : ''
  return (
    `${state.text}\0${state.cursor}\0${state.completionIndex}\0${state.atCompletionIndex}\0` +
    `${state.atDismissed ?? ''}\0${state.permissionSelected}\0${feedback}\0` +
    `${state.selectIndex}\0${state.freeform.cursor}:${state.freeform.text}\0` +
    `${state.authoritySelected}:${state.authorityPage}\0${state.notice ?? ''}`
  )
}

export interface FlushScheduleInput {
  isStructuralCommit: boolean
  isOneShotImmediate: boolean
  hasUnflushedUserInput: boolean
  hasPendingCommitThrottle: boolean
  heightChanged: boolean
  spinnerTicked: boolean
  lastFlushTime: number
  now: number
}

export type FlushDecision =
  | { kind: 'flush-now'; cancelCommitThrottle: boolean }
  | { kind: 'throttle-commit'; delayMs: number }
  | { kind: 'defer'; delayMs: number; cancelCommitThrottle: boolean }
  | { kind: 'skip'; reason: 'commit-throttle-pending' | 'coalesced' }

export function decideFlushAction(input: FlushScheduleInput): FlushDecision {
  const dt = Math.max(0, input.now - input.lastFlushTime)

  if (input.isStructuralCommit) {
    if (input.isOneShotImmediate || input.lastFlushTime <= 0) {
      return { kind: 'flush-now', cancelCommitThrottle: true }
    }
    const minGap = input.hasUnflushedUserInput ? INPUT_FRAME_BUDGET_MS : MIN_COMMIT_GAP_MS
    if (dt < minGap) {
      return { kind: 'throttle-commit', delayMs: minGap - dt }
    }
    return { kind: 'flush-now', cancelCommitThrottle: true }
  }

  if (input.hasPendingCommitThrottle && !input.heightChanged && !input.hasUnflushedUserInput) {
    return { kind: 'skip', reason: 'commit-throttle-pending' }
  }

  if (input.hasUnflushedUserInput) {
    if (input.lastFlushTime <= 0 || dt >= INPUT_FRAME_BUDGET_MS) {
      return { kind: 'flush-now', cancelCommitThrottle: input.hasPendingCommitThrottle }
    }
    return {
      kind: 'defer',
      delayMs: Math.max(1, INPUT_FRAME_BUDGET_MS - dt),
      cancelCommitThrottle: input.hasPendingCommitThrottle,
    }
  }

  if (!input.heightChanged && input.lastFlushTime > 0 && dt < INPUT_FRAME_BUDGET_MS) {
    return { kind: 'skip', reason: 'coalesced' }
  }

  return {
    kind: 'defer',
    delayMs: !input.heightChanged && input.spinnerTicked ? SPINNER_DEFER_MS : STRUCTURAL_DEFER_MS,
    cancelCommitThrottle: input.hasPendingCommitThrottle,
  }
}
