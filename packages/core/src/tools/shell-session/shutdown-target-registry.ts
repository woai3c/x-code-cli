import type { ManagedProcess } from './provider.js'
import type { EmergencyTerminationResult, ShellFailure, TerminationReason } from './types.js'

interface ShutdownTarget {
  managerInstanceId: string
  shellId: string
  process: ManagedProcess
}

const targets = new Map<string, ShutdownTarget>()

function targetKey(managerInstanceId: string, shellId: string): string {
  return `${managerInstanceId}\0${shellId}`
}

export function registerManagedShellTarget(managerInstanceId: string, shellId: string, process: ManagedProcess): void {
  targets.set(targetKey(managerInstanceId, shellId), { managerInstanceId, shellId, process })
}

export function unregisterManagedShellTarget(managerInstanceId: string, shellId: string): void {
  targets.delete(targetKey(managerInstanceId, shellId))
}

export function managedShellTargetCount(): number {
  return targets.size
}

export function forceTerminateManagedShellsSync(
  reason: TerminationReason,
  absoluteDeadline: number,
): EmergencyTerminationResult {
  const current = [...targets.values()]
  const results: EmergencyTerminationResult['results'] = []
  for (const target of current) {
    if (performance.now() >= absoluteDeadline) {
      results.push({
        managerInstanceId: target.managerInstanceId,
        shellId: target.shellId,
        disposition: 'deadline-exhausted',
      })
      continue
    }
    try {
      results.push({
        managerInstanceId: target.managerInstanceId,
        shellId: target.shellId,
        disposition: target.process.forceTreeSync(absoluteDeadline),
      })
    } catch (error) {
      const failure: ShellFailure = {
        code: 'termination-failed',
        message: error instanceof Error ? error.message : String(error),
      }
      results.push({
        managerInstanceId: target.managerInstanceId,
        shellId: target.shellId,
        disposition: 'failed',
        failure,
      })
    }
  }
  return { reason, requested: current.length, results }
}
