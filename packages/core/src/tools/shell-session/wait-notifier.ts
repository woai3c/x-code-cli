interface Waiter<T> {
  resolve: (snapshot: VersionedSnapshot<T>) => void
}

export interface DisposableVersionedWait<T> {
  promise: Promise<VersionedSnapshot<T>>
  dispose(): void
}

export interface VersionedSnapshot<T> {
  generation: number
  value: T
}

/** A reusable notification primitive that cannot lose a wake-up between a state check and listener registration. */
export class VersionedAsyncSignal<T = undefined> {
  private currentGeneration = 0
  private currentValue: T
  private readonly waiters = new Set<Waiter<T>>()

  constructor(initialValue: T) {
    this.currentValue = initialValue
  }

  get generation(): number {
    return this.currentGeneration
  }

  get pendingWaiterCount(): number {
    return this.waiters.size
  }

  snapshot(): VersionedSnapshot<T> {
    return { generation: this.currentGeneration, value: this.currentValue }
  }

  notify(value: T): VersionedSnapshot<T> {
    this.currentValue = value
    this.currentGeneration++
    const snapshot = this.snapshot()
    const pending = [...this.waiters]
    this.waiters.clear()
    for (const waiter of pending) waiter.resolve(snapshot)
    return snapshot
  }

  waitAfter(observedGeneration: number): Promise<VersionedSnapshot<T>> {
    return this.waitAfterDisposable(observedGeneration).promise
  }

  waitAfterDisposable(observedGeneration: number): DisposableVersionedWait<T> {
    if (this.currentGeneration !== observedGeneration) {
      return { promise: Promise.resolve(this.snapshot()), dispose() {} }
    }

    let settled = false
    let resolvePromise!: (snapshot: VersionedSnapshot<T>) => void
    const waiter: Waiter<T> = {
      resolve: (snapshot) => {
        if (settled) return
        settled = true
        this.waiters.delete(waiter)
        resolvePromise(snapshot)
      },
    }
    const promise = new Promise<VersionedSnapshot<T>>((resolve) => {
      resolvePromise = resolve
    })
    this.waiters.add(waiter)
    if (this.currentGeneration !== observedGeneration) waiter.resolve(this.snapshot())
    return {
      promise,
      dispose: () => waiter.resolve(this.snapshot()),
    }
  }
}

export class AsyncMutex {
  private tail = Promise.resolve()

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.tail
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
