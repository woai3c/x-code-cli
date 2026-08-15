interface ErrorEmitter {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
  off(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

export function installTerminalStreamErrorGuards(streams: readonly ErrorEmitter[]): () => void {
  const onError = (error: NodeJS.ErrnoException): void => {
    // A disconnected pipe must not preempt the shutdown coordinator before
    // its managed process trees reach a confirmed terminal state.
    if (error.code === 'EPIPE') return
    throw error
  }
  for (const stream of streams) stream.on('error', onError)
  return () => {
    for (const stream of streams) stream.off('error', onError)
  }
}
