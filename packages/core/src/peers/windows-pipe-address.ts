const WINDOWS_PEER_PIPE_PATTERN = /^\\\\\.\\pipe\\x-code-peer-v2-([a-f0-9]{12})-([A-Za-z0-9_-]{32})$/

export function isValidWindowsPeerPipeAddress(address: string, namespaceId?: string): boolean {
  const match = WINDOWS_PEER_PIPE_PATTERN.exec(address)
  return Boolean(match && namespaceId && match[1] === namespaceId)
}
