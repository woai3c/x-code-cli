export interface GoalRunCoordinator {
  activeGoalId(): string | null
  run<T>(goalId: string, runner: (signal: AbortSignal) => Promise<T>): Promise<T>
  wake(goalId: string, runner: (signal: AbortSignal) => Promise<unknown>): void
  interrupt(goalId?: string): Promise<void>
}

export function createGoalRunCoordinator(): GoalRunCoordinator {
  let active: { goalId: string; controller: AbortController; promise: Promise<unknown> } | null = null
  let pendingWake: { goalId: string; runner: (signal: AbortSignal) => Promise<unknown> } | null = null

  const drainWake = () => {
    if (active || !pendingWake) return
    const next = pendingWake
    pendingWake = null
    void coordinator.run(next.goalId, next.runner).catch(() => {})
  }

  const coordinator: GoalRunCoordinator = {
    activeGoalId() {
      return active?.goalId ?? null
    },

    async run<T>(goalId: string, runner: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (active) return active.promise as Promise<T>
      const controller = new AbortController()
      const promise = runner(controller.signal)
      active = { goalId, controller, promise }
      try {
        return await promise
      } finally {
        if (active?.promise === promise) active = null
        drainWake()
      }
    },

    wake(goalId: string, runner: (signal: AbortSignal) => Promise<unknown>): void {
      if (active?.goalId === goalId) {
        pendingWake = { goalId, runner }
        return
      }
      pendingWake = { goalId, runner }
      drainWake()
    },

    async interrupt(goalId?: string): Promise<void> {
      if (!active) return
      if (goalId && active.goalId !== goalId) return
      active.controller.abort()
      try {
        await active.promise
      } catch {
        // The active runner owns user-facing error reporting.
      }
    },
  }

  return coordinator
}
