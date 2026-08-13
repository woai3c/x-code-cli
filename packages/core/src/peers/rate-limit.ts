export interface PeerRateLimiter {
  admit(senderInstanceId: string): boolean
  senderCount(): number
}

export interface PeerRateLimiterOptions {
  perSender?: number
  global?: number
  windowMs?: number
  maxSenders?: number
  now?: () => number
}

export function createPeerRateLimiter(options: PeerRateLimiterOptions = {}): PeerRateLimiter {
  const perSender = options.perSender ?? 30
  const globalLimit = options.global ?? 120
  const windowMs = options.windowMs ?? 60_000
  const maxSenders = options.maxSenders ?? 2_048
  const now = options.now ?? Date.now
  const global: number[] = []
  const senders = new Map<string, number[]>()

  const trim = (values: number[], cutoff: number): void => {
    let count = 0
    while (count < values.length && values[count]! <= cutoff) count++
    if (count > 0) values.splice(0, count)
  }

  return {
    admit(senderInstanceId) {
      const timestamp = now()
      const cutoff = timestamp - windowMs
      trim(global, cutoff)
      for (const [sender, values] of senders) {
        trim(values, cutoff)
        if (values.length === 0) senders.delete(sender)
      }
      let sender = senders.get(senderInstanceId)
      if (!sender) {
        if (senders.size >= maxSenders) return false
        sender = []
        senders.set(senderInstanceId, sender)
      }
      if (sender.length >= perSender || global.length >= globalLimit) return false
      sender.push(timestamp)
      global.push(timestamp)
      return true
    },
    senderCount() {
      return senders.size
    },
  }
}
