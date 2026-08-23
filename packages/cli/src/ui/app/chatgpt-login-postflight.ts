export type ChatGPTLoginCatalogResult<T> = { models: T } | { error: unknown }

export async function refreshCatalogAfterCommittedLogin<T>(
  refresh: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 8_000,
): Promise<ChatGPTLoginCatalogResult<T>> {
  try {
    return { models: await refresh(AbortSignal.timeout(timeoutMs)) }
  } catch (error) {
    return { error }
  }
}
