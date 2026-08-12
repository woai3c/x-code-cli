// @x-code-cli/core — One browser transaction at a time.
//
// Playwright MCP keeps one mutable "current tab" per connection. Individual
// tool calls are safe to await, but interleaving two multi-call browser flows
// lets one flow silently redirect the other one's clicks and screenshots.

interface Waiter {
  resolve: (release: () => void) => void
  signal?: AbortSignal
  onAbort?: () => void
}

let active = false
const waiters: Waiter[] = []

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Browser operation aborted', 'AbortError')
}

function releaseNext(): void {
  const next = waiters.shift()
  if (!next) {
    active = false
    return
  }
  if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
  let released = false
  next.resolve(() => {
    if (released) return
    released = true
    releaseNext()
  })
}

function acquire(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  if (!active) {
    active = true
    let released = false
    return Promise.resolve(() => {
      if (released) return
      released = true
      releaseNext()
    })
  }

  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = { resolve, signal }
    waiter.onAbort = () => {
      const index = waiters.indexOf(waiter)
      if (index >= 0) waiters.splice(index, 1)
      reject(abortReason(signal!))
    }
    signal?.addEventListener('abort', waiter.onAbort, { once: true })
    waiters.push(waiter)
  })
}

export async function withBrowserOperation<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquire(signal)
  try {
    if (signal?.aborted) throw abortReason(signal)
    return await operation()
  } finally {
    release()
  }
}
