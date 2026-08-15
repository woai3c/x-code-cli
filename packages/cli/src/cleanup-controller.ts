import type { TerminateAllResult, TerminationBudget, TerminationReason } from '@x-code-cli/core'

export interface CliCleanupController {
  terminateShells(reason: TerminationReason, budget?: TerminationBudget): Promise<TerminateAllResult | null>
  drain(): Promise<void>
}

let registeredController: CliCleanupController | null = null

export function registerCleanupController(controller: CliCleanupController | null): void {
  registeredController = controller
}

export function getCleanupController(): CliCleanupController | null {
  return registeredController
}
