import { describe, expect, it } from 'vitest'

import {
  INPUT_FRAME_BUDGET_MS,
  type InteractiveKeyInput,
  MIN_COMMIT_GAP_MS,
  SPINNER_DEFER_MS,
  STRUCTURAL_DEFER_MS,
  buildInteractiveKey,
  decideFlushAction,
} from '../src/ui/chat-input/flush-scheduler.js'

const BASE_KEY_INPUT: InteractiveKeyInput = {
  text: '',
  cursor: 0,
  completionIndex: 0,
  atCompletionIndex: 0,
  atDismissed: null,
  permissionSelected: 0,
  permissionFeedback: null,
  selectIndex: 0,
  freeform: { text: '', cursor: 0 },
  authoritySelected: 1,
  authorityPage: 0,
  notice: null,
}

describe('ChatInput flush scheduler', () => {
  it('flushes user typing immediately even when an unflushed spinner tick is pending', () => {
    expect(
      decideFlushAction({
        isStructuralCommit: false,
        isOneShotImmediate: false,
        hasUnflushedUserInput: true,
        hasPendingCommitThrottle: false,
        heightChanged: false,
        spinnerTicked: true,
        lastFlushTime: 1_000,
        now: 1_040,
      }),
    ).toEqual({
      kind: 'flush-now',
      cancelCommitThrottle: false,
    })
  })

  it('schedules a bounded trailing flush instead of dropping keystrokes within 16ms of a commit', () => {
    // Keystroke 1 at +5ms after a commit: defers 11ms (target = 1016ms), NOT dropped.
    expect(
      decideFlushAction({
        isStructuralCommit: false,
        isOneShotImmediate: false,
        hasUnflushedUserInput: true,
        hasPendingCommitThrottle: false,
        heightChanged: false,
        spinnerTicked: false,
        lastFlushTime: 1_000,
        now: 1_005,
      }),
    ).toEqual({
      kind: 'defer',
      delayMs: 11,
      cancelCommitThrottle: false,
    })

    // Keystroke 2 (plus an intervening spinner tick) at +12ms: shrinks delay to 4ms
    // so the deadline stays anchored at 1016ms instead of sliding out by 160ms.
    expect(
      decideFlushAction({
        isStructuralCommit: false,
        isOneShotImmediate: false,
        hasUnflushedUserInput: true,
        hasPendingCommitThrottle: false,
        heightChanged: false,
        spinnerTicked: true,
        lastFlushTime: 1_000,
        now: 1_012,
      }),
    ).toEqual({
      kind: 'defer',
      delayMs: 4,
      cancelCommitThrottle: false,
    })
  })

  it('supersedes a pending commit throttle when new user input arrives', () => {
    expect(
      decideFlushAction({
        isStructuralCommit: false,
        isOneShotImmediate: false,
        hasUnflushedUserInput: true,
        hasPendingCommitThrottle: true,
        heightChanged: false,
        spinnerTicked: false,
        lastFlushTime: 1_000,
        now: 1_025,
      }),
    ).toEqual({
      kind: 'flush-now',
      cancelCommitThrottle: true,
    })
  })

  it('uses the 16ms interactive gap instead of 50ms when a commit also carries user input', () => {
    expect(
      decideFlushAction({
        isStructuralCommit: true,
        isOneShotImmediate: false,
        hasUnflushedUserInput: true,
        hasPendingCommitThrottle: true,
        heightChanged: false,
        spinnerTicked: true,
        lastFlushTime: 1_000,
        now: 1_020,
      }),
    ).toEqual({
      kind: 'flush-now',
      cancelCommitThrottle: true,
    })

    expect(
      decideFlushAction({
        isStructuralCommit: true,
        isOneShotImmediate: false,
        hasUnflushedUserInput: true,
        hasPendingCommitThrottle: false,
        heightChanged: false,
        spinnerTicked: false,
        lastFlushTime: 1_000,
        now: 1_006,
      }),
    ).toEqual({
      kind: 'throttle-commit',
      delayMs: INPUT_FRAME_BUDGET_MS - 6,
    })
  })

  it('preserves passive anti-flicker coalescing and defer windows when user input is clean', () => {
    expect(
      decideFlushAction({
        isStructuralCommit: false,
        isOneShotImmediate: false,
        hasUnflushedUserInput: false,
        hasPendingCommitThrottle: false,
        heightChanged: false,
        spinnerTicked: true,
        lastFlushTime: 1_000,
        now: 1_010,
      }),
    ).toEqual({
      kind: 'skip',
      reason: 'coalesced',
    })

    expect(
      decideFlushAction({
        isStructuralCommit: false,
        isOneShotImmediate: false,
        hasUnflushedUserInput: false,
        hasPendingCommitThrottle: false,
        heightChanged: false,
        spinnerTicked: true,
        lastFlushTime: 1_000,
        now: 1_030,
      }),
    ).toEqual({
      kind: 'defer',
      delayMs: SPINNER_DEFER_MS,
      cancelCommitThrottle: false,
    })

    expect(
      decideFlushAction({
        isStructuralCommit: false,
        isOneShotImmediate: false,
        hasUnflushedUserInput: false,
        hasPendingCommitThrottle: false,
        heightChanged: true,
        spinnerTicked: true,
        lastFlushTime: 1_000,
        now: 1_005,
      }),
    ).toEqual({
      kind: 'defer',
      delayMs: STRUCTURAL_DEFER_MS,
      cancelCommitThrottle: false,
    })

    expect(
      decideFlushAction({
        isStructuralCommit: true,
        isOneShotImmediate: false,
        hasUnflushedUserInput: false,
        hasPendingCommitThrottle: false,
        heightChanged: false,
        spinnerTicked: false,
        lastFlushTime: 1_000,
        now: 1_020,
      }),
    ).toEqual({
      kind: 'throttle-commit',
      delayMs: MIN_COMMIT_GAP_MS - 20,
    })
  })

  it('tracks text, cursor, menu, dialog, and notice transitions in buildInteractiveKey', () => {
    const base = buildInteractiveKey(BASE_KEY_INPUT)
    expect(buildInteractiveKey({ ...BASE_KEY_INPUT, text: 'a', cursor: 1 })).not.toBe(base)
    expect(buildInteractiveKey({ ...BASE_KEY_INPUT, cursor: 1 })).not.toBe(base)
    expect(buildInteractiveKey({ ...BASE_KEY_INPUT, completionIndex: 2 })).not.toBe(base)
    expect(buildInteractiveKey({ ...BASE_KEY_INPUT, selectIndex: 1 })).not.toBe(base)
    expect(buildInteractiveKey({ ...BASE_KEY_INPUT, notice: 'Press Ctrl+C again to exit' })).not.toBe(base)
  })
})
