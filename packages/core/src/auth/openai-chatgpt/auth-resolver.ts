import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'

import { openAIChatGPTCredentialPath, readOpenAIChatGPTCredentialsSync } from './credential-store.js'
import type { OpenAIAuthContext, OpenAIAuthStatus } from './types.js'

let activeContext: OpenAIAuthContext | undefined
let activeRevision: string | undefined
let authGeneration = 0
let authObservationSequence = 0
let appliedObservationSequence = 0

export interface OpenAIAuthSnapshot {
  context: OpenAIAuthContext
  generation: number
  revision: string
}

interface ResolvedAuthSnapshot {
  context: OpenAIAuthContext
  revision: string
}

export interface OpenAIAuthRefreshResult {
  changed: boolean
  current: OpenAIAuthContext
  previous: OpenAIAuthContext
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fallbackSnapshot(): ResolvedAuthSnapshot {
  const apiKey = process.env.OPENAI_API_KEY
  return apiKey
    ? { context: { mode: 'api-key', apiKey }, revision: `api-key:${digest(apiKey)}` }
    : { context: { mode: 'none' }, revision: 'none' }
}

function chatGPTSnapshot(raw: string): ResolvedAuthSnapshot {
  let storedRevision: string | undefined
  try {
    const value = JSON.parse(raw) as { accountId?: unknown; authRevision?: unknown; refreshToken?: unknown }
    if (typeof value.authRevision === 'string' && value.authRevision) storedRevision = value.authRevision
    else {
      const legacyIdentity =
        typeof value.accountId === 'string' && value.accountId
          ? value.accountId
          : typeof value.refreshToken === 'string'
            ? value.refreshToken
            : undefined
      if (legacyIdentity) storedRevision = `legacy-${digest(legacyIdentity)}`
    }
  } catch {
    // A malformed credential file still disables API-key fallback.
  }
  return { context: { mode: 'chatgpt' }, revision: `chatgpt:${storedRevision ?? digest(raw)}` }
}

function resolveUncachedSnapshot(): ResolvedAuthSnapshot {
  try {
    return chatGPTSnapshot(fsSync.readFileSync(openAIChatGPTCredentialPath(), 'utf-8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallbackSnapshot()
    return { context: { mode: 'chatgpt' }, revision: `chatgpt-unreadable:${String(error)}` }
  }
}

async function resolveUncachedSnapshotAsync(): Promise<ResolvedAuthSnapshot> {
  try {
    return chatGPTSnapshot(await fs.readFile(openAIChatGPTCredentialPath(), 'utf-8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallbackSnapshot()
    return { context: { mode: 'chatgpt' }, revision: `chatgpt-unreadable:${String(error)}` }
  }
}

function nextObservationSequence(): number {
  authObservationSequence += 1
  return authObservationSequence
}

function applySnapshot(snapshot: ResolvedAuthSnapshot, sequence: number, forceGeneration = false): boolean {
  if (sequence < appliedObservationSequence) return false
  appliedObservationSequence = sequence
  const changed = activeContext === undefined || activeRevision !== snapshot.revision
  activeContext = snapshot.context
  activeRevision = snapshot.revision
  if (changed || forceGeneration) authGeneration += 1
  return true
}

export function initializeOpenAIAuthContext(): OpenAIAuthContext {
  const snapshot = resolveUncachedSnapshot()
  applySnapshot(snapshot, nextObservationSequence(), true)
  return activeContext!
}

function activeSnapshot(): OpenAIAuthSnapshot {
  if (activeContext === undefined || activeRevision === undefined) {
    const snapshot = resolveUncachedSnapshot()
    applySnapshot(snapshot, nextObservationSequence())
  }
  return { context: activeContext!, generation: authGeneration, revision: activeRevision! }
}

export function getOpenAIAuthContext(): OpenAIAuthContext {
  return activeSnapshot().context
}

export function getOpenAIAuthGeneration(): number {
  return activeSnapshot().generation
}

export function getOpenAIAuthSnapshot(): OpenAIAuthSnapshot {
  return activeSnapshot()
}

export async function refreshOpenAIAuthSnapshot(): Promise<OpenAIAuthSnapshot> {
  activeSnapshot()
  const sequence = nextObservationSequence()
  const current = await resolveUncachedSnapshotAsync()
  applySnapshot(current, sequence)
  return activeSnapshot()
}

export async function refreshOpenAIAuthContextIfChanged(): Promise<OpenAIAuthRefreshResult> {
  const previous = getOpenAIAuthSnapshot()
  const current = await refreshOpenAIAuthSnapshot()
  return { changed: current.revision !== previous.revision, previous: previous.context, current: current.context }
}

export function getOpenAIAuthStatus(): OpenAIAuthStatus {
  const context = getOpenAIAuthContext()
  const base: OpenAIAuthStatus = {
    mode: context.mode,
    apiKeyConfigured: !!process.env.OPENAI_API_KEY,
    apiKeyActive: context.mode === 'api-key',
  }
  if (context.mode !== 'chatgpt') return base
  try {
    const credentials = readOpenAIChatGPTCredentialsSync()
    return {
      ...base,
      accountId: credentials.accountId,
      email: credentials.email,
      planType: credentials.planType,
      expiresAt: credentials.expiresAt,
    }
  } catch (err) {
    return {
      ...base,
      credentialError: err instanceof Error ? err.message : 'Stored ChatGPT credentials are invalid.',
    }
  }
}

export function resetOpenAIAuthContextForTesting(): void {
  appliedObservationSequence = nextObservationSequence()
  activeContext = undefined
  activeRevision = undefined
  authGeneration += 1
}
