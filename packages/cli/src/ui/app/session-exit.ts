export interface SessionExitInfo {
  sessionId: string
  taskSlug: string
  messageCount: number
  peerInfluenced: boolean
}

let sessionInfoGetter: (() => SessionExitInfo | null) | null = null

export function registerSessionInfoGetter(getter: () => SessionExitInfo | null): void {
  sessionInfoGetter = getter
}

export function getSessionExitInfo(): SessionExitInfo | null {
  return sessionInfoGetter ? sessionInfoGetter() : null
}
