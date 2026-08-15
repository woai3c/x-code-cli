import { forceTerminateManagedShellsSync } from '@x-code-cli/core'
import type { EmergencyTerminationResult, TerminationBudget, TerminationReason } from '@x-code-cli/core'

import type { CliCleanupController } from './cleanup-controller.js'

export const SHELL_SHUTDOWN_BUDGET: TerminationBudget = {
  gracefulMs: 1_000,
  forceMs: 1_000,
  confirmMs: 250,
}
export const ORDINARY_DRAIN_BUDGET_MS = 1_500
export const CLI_SHUTDOWN_HARD_CAP_MS = 4_000
export const EMERGENCY_RESERVE_MS = 500

export interface ShutdownTiming {
  shellBudget: TerminationBudget
  ordinaryDrainMs: number
  hardCapMs: number
  emergencyReserveMs: number
}

export interface ShutdownPhaseResult {
  absoluteDeadline: number
  shellPhaseTimedOut: boolean
  ordinaryPhaseTimedOut: boolean
  emergency: EmergencyTerminationResult
}

const DEFAULT_TIMING: ShutdownTiming = {
  shellBudget: SHELL_SHUTDOWN_BUDGET,
  ordinaryDrainMs: ORDINARY_DRAIN_BUDGET_MS,
  hardCapMs: CLI_SHUTDOWN_HARD_CAP_MS,
  emergencyReserveMs: EMERGENCY_RESERVE_MS,
}

async function settleUntil(promise: Promise<unknown>, deadline: number): Promise<boolean> {
  const remaining = Math.max(0, deadline - performance.now())
  if (remaining === 0) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runShutdownPhases(options: {
  controller: CliCleanupController | null
  reason: TerminationReason
  ordinaryFinalizers: Array<() => Promise<unknown>>
  timing?: ShutdownTiming
  startedAt?: number
  forceSync?: typeof forceTerminateManagedShellsSync
}): Promise<ShutdownPhaseResult> {
  const timing = options.timing ?? DEFAULT_TIMING
  const startedAt = options.startedAt ?? performance.now()
  const absoluteDeadline = startedAt + timing.hardCapMs
  const ordinaryDeadline = absoluteDeadline - timing.emergencyReserveMs

  const shellPhase = options.controller
    ? Promise.resolve().then(() => options.controller!.terminateShells(options.reason, timing.shellBudget))
    : Promise.resolve(null)
  const shellPhaseTimedOut = !(await settleUntil(shellPhase, ordinaryDeadline))

  const ordinary = Promise.allSettled([
    ...(options.controller ? [Promise.resolve().then(() => options.controller!.drain())] : []),
    ...options.ordinaryFinalizers.map((finalize) => Promise.resolve().then(finalize)),
  ])
  const ordinaryPhaseDeadline = Math.min(performance.now() + timing.ordinaryDrainMs, ordinaryDeadline)
  const ordinaryPhaseTimedOut = !(await settleUntil(ordinary, ordinaryPhaseDeadline))

  const forceSync = options.forceSync ?? forceTerminateManagedShellsSync
  const emergency = forceSync(options.reason, absoluteDeadline)
  return { absoluteDeadline, shellPhaseTimedOut, ordinaryPhaseTimedOut, emergency }
}
