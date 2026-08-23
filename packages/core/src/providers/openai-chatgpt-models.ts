import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { getOpenAIAuthContext, getOpenAIAuthGeneration } from '../auth/openai-chatgpt/auth-resolver.js'
import { readOpenAIChatGPTCredentials } from '../auth/openai-chatgpt/credential-store.js'
import { OPENAI_CHATGPT_OAUTH } from '../auth/openai-chatgpt/oauth.js'
import { getOpenAIChatGPTTokenManager } from '../auth/openai-chatgpt/token-manager.js'
import { debugLog, userXcodeDir } from '../utils.js'
import { PROVIDER_MODELS } from './catalog.js'
import type { ProviderModel, ReasoningTierOption } from './catalog.js'

const CACHE_TTL_MS = 5 * 60 * 1000
const SHARED_MODEL_REFRESH_TIMEOUT_MS = 8 * 1000
const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95

// The ChatGPT models endpoint interprets `client_version` as an official
// Codex protocol compatibility version, not this product's package version.
// GPT-5.6 requires at least 0.144.0; sending x-code's independent 0.x version
// makes the endpoint legitimately return an empty picker catalog.
const OPENAI_CODEX_COMPATIBILITY_VERSION = '0.144.0'

export interface OpenAIChatGPTRuntimeModel extends ProviderModel {
  /** Raw `context_window` advertised by the ChatGPT Codex model catalog. */
  contextWindow?: number
  defaultReasoningLevel?: string
  effectiveContextWindowPercent?: number
  maxOutputTokens?: number
  supportsReasoningSummaryParameter?: boolean
  supportedReasoningLevels?: Array<{ effort: string; description?: string }>
}

export interface OpenAIChatGPTModelCatalogState {
  error?: string
  errorCode?: string
  models: readonly OpenAIChatGPTRuntimeModel[]
  source: 'cache' | 'fallback' | 'remote'
  verifiedAt?: number
}

interface ModelsCache {
  accountKey: string
  codexCompatibilityVersion: string
  fetchedAt: number
  models: OpenAIChatGPTRuntimeModel[]
}

interface AuthSnapshot {
  accountKey?: string
  accountReadError?: unknown
  generation: number
}

const FALLBACK_MODELS: OpenAIChatGPTRuntimeModel[] = [
  {
    id: 'openai:gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description: 'ChatGPT subscription — frontier agentic coding model',
    vision: true,
    contextWindow: 272000,
    supportedReasoningLevels: [
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'high' },
      { effort: 'xhigh' },
      { effort: 'max' },
      { effort: 'ultra' },
    ],
  },
  {
    id: 'openai:gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'ChatGPT subscription — balanced agentic coding model',
    vision: true,
    contextWindow: 272000,
    supportedReasoningLevels: [
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'high' },
      { effort: 'xhigh' },
      { effort: 'max' },
      { effort: 'ultra' },
    ],
  },
  {
    id: 'openai:gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'ChatGPT subscription — fast agentic coding model',
    vision: true,
    contextWindow: 272000,
    supportedReasoningLevels: [
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'high' },
      { effort: 'xhigh' },
      { effort: 'max' },
    ],
  },
  {
    id: 'openai:gpt-5.5',
    label: 'GPT-5.5',
    description: 'ChatGPT subscription model',
    vision: true,
    contextWindow: 272000,
    supportedReasoningLevels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
  },
  {
    id: 'openai:gpt-5.2',
    label: 'GPT-5.2',
    description: 'ChatGPT subscription model',
    vision: true,
    contextWindow: 272000,
    supportedReasoningLevels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
  },
]

let runtimeModels: OpenAIChatGPTRuntimeModel[] | undefined
let runtimeAccountKey: string | undefined
let runtimeAuthGeneration: number | undefined
let runtimeError: string | undefined
let runtimeErrorCode: string | undefined
let runtimeSource: OpenAIChatGPTModelCatalogState['source'] | undefined
let fetchedAt = 0
let lastClientVersion: string | undefined
const catalogRefreshPromises = new Map<
  string,
  { force: boolean; promise: Promise<readonly OpenAIChatGPTRuntimeModel[]> }
>()

function cachePath(): string {
  return path.join(userXcodeDir(), 'cache', 'openai-chatgpt-models.json')
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isContextWindowPercent(value: unknown): value is number {
  return isPositiveSafeInteger(value) && value <= 100
}

function isReasoningLevel(value: unknown): value is { effort: string; description?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const level = value as Record<string, unknown>
  return (
    typeof level.effort === 'string' &&
    level.effort.length > 0 &&
    (level.description === undefined || typeof level.description === 'string')
  )
}

function isRuntimeModel(value: unknown): value is OpenAIChatGPTRuntimeModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<OpenAIChatGPTRuntimeModel>
  return (
    typeof item.id === 'string' &&
    item.id.startsWith('openai:') &&
    typeof item.label === 'string' &&
    typeof item.description === 'string' &&
    typeof item.vision === 'boolean' &&
    (item.contextWindow === undefined || isPositiveSafeInteger(item.contextWindow)) &&
    (item.effectiveContextWindowPercent === undefined || isContextWindowPercent(item.effectiveContextWindowPercent)) &&
    (item.defaultReasoningLevel === undefined ||
      (typeof item.defaultReasoningLevel === 'string' && item.defaultReasoningLevel.length > 0)) &&
    (item.maxOutputTokens === undefined || isPositiveSafeInteger(item.maxOutputTokens)) &&
    (item.supportsReasoningSummaryParameter === undefined ||
      typeof item.supportsReasoningSummaryParameter === 'boolean') &&
    (item.supportedReasoningLevels === undefined ||
      (Array.isArray(item.supportedReasoningLevels) && item.supportedReasoningLevels.every(isReasoningLevel)))
  )
}

async function currentAccountKey(): Promise<string> {
  const credentials = await readOpenAIChatGPTCredentials()
  return createHash('sha256')
    .update(credentials.accountId ?? credentials.refreshToken)
    .digest('hex')
}

async function captureAuthSnapshot(): Promise<AuthSnapshot> {
  const generation = getOpenAIAuthGeneration()
  try {
    return { generation, accountKey: await currentAccountKey() }
  } catch (accountReadError) {
    return { generation, accountReadError }
  }
}

async function authSnapshotIsCurrent(snapshot: AuthSnapshot): Promise<boolean> {
  if (getOpenAIAuthContext().mode !== 'chatgpt' || getOpenAIAuthGeneration() !== snapshot.generation) return false
  try {
    return (await currentAccountKey()) === snapshot.accountKey
  } catch {
    return snapshot.accountKey === undefined
  }
}

function activeCatalogState(): OpenAIChatGPTModelCatalogState {
  if (runtimeAuthGeneration !== getOpenAIAuthGeneration()) {
    return { models: FALLBACK_MODELS, source: 'fallback' }
  }
  return {
    models: runtimeModels ?? FALLBACK_MODELS,
    source: runtimeSource ?? 'fallback',
    ...(fetchedAt > 0 ? { verifiedAt: fetchedAt } : {}),
    ...(runtimeError ? { error: runtimeError } : {}),
    ...(runtimeErrorCode ? { errorCode: runtimeErrorCode } : {}),
  }
}

function activeRuntimeModels(): readonly OpenAIChatGPTRuntimeModel[] {
  return activeCatalogState().models
}

async function commitRuntimeModels(
  snapshot: AuthSnapshot,
  models: OpenAIChatGPTRuntimeModel[],
  accountKey: string | undefined,
  timestamp: number,
  source: OpenAIChatGPTModelCatalogState['source'],
  error?: string,
  errorCode?: string,
): Promise<boolean> {
  if (!(await authSnapshotIsCurrent(snapshot))) return false
  runtimeModels = models
  runtimeAccountKey = accountKey
  runtimeAuthGeneration = snapshot.generation
  runtimeError = error
  runtimeErrorCode = errorCode
  runtimeSource = source
  fetchedAt = timestamp
  return true
}

async function loadCache(accountKey: string): Promise<ModelsCache | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(cachePath(), 'utf-8')) as Partial<ModelsCache>
    if (
      value.accountKey === accountKey &&
      value.codexCompatibilityVersion === OPENAI_CODEX_COMPATIBILITY_VERSION &&
      typeof value.fetchedAt === 'number' &&
      Array.isArray(value.models) &&
      value.models.every(isRuntimeModel)
    ) {
      return value as ModelsCache
    }
  } catch {
    // Missing or malformed cache falls back to the bundled subscription catalog.
  }
  return undefined
}

async function writeCache(cache: ModelsCache, snapshot: AuthSnapshot): Promise<void> {
  const target = cachePath()
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(temp, JSON.stringify(cache, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
    if (!(await authSnapshotIsCurrent(snapshot))) return
    await fs.rename(temp, target)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function normalizeRemoteModels(response: unknown): OpenAIChatGPTRuntimeModel[] {
  const values = asRecord(response)?.models
  if (!Array.isArray(values)) throw new Error('ChatGPT model catalog response is invalid.')

  const normalized: Array<{ model: OpenAIChatGPTRuntimeModel; priority: number }> = []
  let recognizedEntries = 0
  for (const value of values) {
    const item = asRecord(value)
    const slug = typeof item?.slug === 'string' ? item.slug.trim() : ''
    if (!item || !slug) continue
    recognizedEntries += 1
    if (item.visibility !== undefined && item.visibility !== 'list') continue

    const supportedReasoningLevels = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels.flatMap((level) => {
          const candidate = asRecord(level)
          if (typeof candidate?.effort !== 'string' || !candidate.effort) return []
          return [
            {
              effort: candidate.effort,
              ...(typeof candidate.description === 'string' && candidate.description
                ? { description: candidate.description }
                : {}),
            },
          ]
        })
      : undefined
    const modalities =
      Array.isArray(item.input_modalities) && item.input_modalities.every((value) => typeof value === 'string')
        ? item.input_modalities
        : undefined
    const contextWindow = isPositiveSafeInteger(item.context_window)
      ? item.context_window
      : isPositiveSafeInteger(item.max_context_window)
        ? item.max_context_window
        : undefined
    const effectiveContextWindowPercent = isContextWindowPercent(item.effective_context_window_percent)
      ? item.effective_context_window_percent
      : DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT
    normalized.push({
      priority:
        typeof item.priority === 'number' && Number.isFinite(item.priority) ? item.priority : Number.MAX_SAFE_INTEGER,
      model: {
        id: `openai:${slug}`,
        label: typeof item.display_name === 'string' && item.display_name ? item.display_name : slug,
        description:
          typeof item.description === 'string' && item.description ? item.description : 'ChatGPT subscription model',
        vision: !modalities || modalities.includes('image'),
        supportsReasoningSummaryParameter:
          typeof item.supports_reasoning_summary_parameter === 'boolean'
            ? item.supports_reasoning_summary_parameter
            : true,
        ...(contextWindow ? { contextWindow } : {}),
        effectiveContextWindowPercent,
        ...(typeof item.default_reasoning_level === 'string' && item.default_reasoning_level
          ? { defaultReasoningLevel: item.default_reasoning_level }
          : {}),
        ...(isPositiveSafeInteger(item.max_output_tokens) ? { maxOutputTokens: item.max_output_tokens } : {}),
        ...(supportedReasoningLevels ? { supportedReasoningLevels } : {}),
      },
    })
  }
  if (values.length > 0 && recognizedEntries === 0) {
    throw new Error('ChatGPT model catalog contained no valid model entries.')
  }
  return normalized.sort((left, right) => left.priority - right.priority).map(({ model }) => model)
}

async function fetchRemoteModels(
  clientVersion: string,
  accountKey: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ModelsCache> {
  const manager = getOpenAIChatGPTTokenManager()
  let auth = await manager.getRequestAuth(signal)
  const request = async () =>
    fetchImpl(
      `${OPENAI_CHATGPT_OAUTH.modelsEndpoint}?client_version=${encodeURIComponent(OPENAI_CODEX_COMPATIBILITY_VERSION)}`,
      {
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          ...(auth.accountId ? { 'ChatGPT-Account-ID': auth.accountId } : {}),
          ...(auth.isFedRamp ? { 'X-OpenAI-Fedramp': 'true' } : {}),
          originator: 'x-code-cli',
          'User-Agent': `x-code-cli/${clientVersion}`,
        },
        signal,
      },
    )

  let response = await request()
  if (response.status === 401) {
    auth = await manager.recoverAfterUnauthorized(auth.accessToken, signal)
    response = await request()
  }
  if (!response.ok) throw new Error(`ChatGPT model catalog request failed (${response.status})`)
  const models = normalizeRemoteModels(await response.json())
  return {
    accountKey,
    codexCompatibilityVersion: OPENAI_CODEX_COMPATIBILITY_VERSION,
    fetchedAt: Date.now(),
    models,
  }
}

async function refreshOpenAIChatGPTModelsInternal(
  clientVersion: string,
  snapshot: AuthSnapshot,
  options: { fetch?: typeof fetch; signal?: AbortSignal; force?: boolean } = {},
): Promise<readonly OpenAIChatGPTRuntimeModel[]> {
  const accountKey = snapshot.accountKey
  if (!accountKey) {
    const err = snapshot.accountReadError
    const message = err instanceof Error ? err.message : String(err)
    const errorCode =
      err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : undefined
    debugLog('openai-chatgpt.models-account-read-failed', message)
    await commitRuntimeModels(snapshot, FALLBACK_MODELS, undefined, 0, 'fallback', message, errorCode)
    return activeRuntimeModels()
  }
  if (
    !options.force &&
    runtimeModels &&
    runtimeAccountKey === accountKey &&
    runtimeAuthGeneration === snapshot.generation &&
    runtimeError === undefined &&
    Date.now() - fetchedAt < CACHE_TTL_MS
  ) {
    return runtimeModels
  }

  const cached = await loadCache(accountKey)
  const retryingAfterFailure = runtimeAuthGeneration === snapshot.generation && runtimeError !== undefined
  if (!options.force && !retryingAfterFailure && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    await commitRuntimeModels(snapshot, cached.models, accountKey, cached.fetchedAt, 'cache')
    return activeRuntimeModels()
  }

  try {
    const remote = await fetchRemoteModels(clientVersion, accountKey, options.fetch ?? fetch, options.signal)
    if (!(await commitRuntimeModels(snapshot, remote.models, accountKey, remote.fetchedAt, 'remote')))
      return activeRuntimeModels()
    await writeCache(remote, snapshot).catch((err) => debugLog('openai-chatgpt.models-cache-write-failed', String(err)))
  } catch (err) {
    if (!(await authSnapshotIsCurrent(snapshot))) return activeRuntimeModels()
    const message = err instanceof Error ? err.message : String(err)
    const errorCode =
      err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : undefined
    debugLog('openai-chatgpt.models-refresh-failed', message)
    await commitRuntimeModels(
      snapshot,
      cached?.models ?? FALLBACK_MODELS,
      accountKey,
      cached?.fetchedAt ?? 0,
      cached ? 'cache' : 'fallback',
      message,
      errorCode,
    )
  }
  return activeRuntimeModels()
}

export function refreshOpenAIChatGPTModels(
  clientVersion: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal; force?: boolean } = {},
): Promise<readonly OpenAIChatGPTRuntimeModel[]> {
  if (getOpenAIAuthContext().mode !== 'chatgpt') return Promise.resolve(PROVIDER_MODELS.openai ?? [])
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason ?? new Error('ChatGPT model catalog wait was cancelled.'))
  }
  lastClientVersion = clientVersion
  return captureAuthSnapshot().then((snapshot) => {
    const refreshKey = `${snapshot.generation}:${snapshot.accountKey ?? 'unavailable'}`
    const existing = catalogRefreshPromises.get(refreshKey)
    if (existing) {
      const joined = waitForModelRefresh(existing.promise, options.signal)
      if (!options.force || existing.force) return joined
      return joined.then(() => refreshOpenAIChatGPTModels(clientVersion, options))
    }

    const pending = refreshOpenAIChatGPTModelsInternal(clientVersion, snapshot, {
      ...options,
      signal: AbortSignal.timeout(SHARED_MODEL_REFRESH_TIMEOUT_MS),
    })
    const shared = pending.finally(() => {
      if (catalogRefreshPromises.get(refreshKey)?.promise === shared) catalogRefreshPromises.delete(refreshKey)
    })
    catalogRefreshPromises.set(refreshKey, { force: options.force === true, promise: shared })
    return waitForModelRefresh(shared, options.signal)
  })
}

function waitForModelRefresh<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('ChatGPT model catalog wait was cancelled.'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('ChatGPT model catalog wait was cancelled.'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export async function refreshOpenAIChatGPTModelsAfterNotFound(
  rejectedModelId?: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!lastClientVersion) return
  const generation = getOpenAIAuthGeneration()
  await refreshOpenAIChatGPTModels(lastClientVersion, { signal, force: true })
  if (!rejectedModelId || generation !== getOpenAIAuthGeneration() || runtimeAuthGeneration !== generation) return
  runtimeModels = activeRuntimeModels().filter((model) => model.id !== rejectedModelId)
}

export function getProviderModels(): Record<string, readonly ProviderModel[]> {
  if (getOpenAIAuthContext().mode !== 'chatgpt') return PROVIDER_MODELS
  return { ...PROVIDER_MODELS, openai: activeRuntimeModels() }
}

export function getOpenAIChatGPTModelCatalogState(): OpenAIChatGPTModelCatalogState | undefined {
  if (getOpenAIAuthContext().mode !== 'chatgpt') return undefined
  return activeCatalogState()
}

export function getOpenAIChatGPTRuntimeModel(modelId: string): OpenAIChatGPTRuntimeModel | undefined {
  if (getOpenAIAuthContext().mode !== 'chatgpt') return undefined
  return activeRuntimeModels().find((model) => model.id === modelId)
}

export function resolveOpenAIChatGPTEffectiveContextWindow(model: OpenAIChatGPTRuntimeModel): number | undefined {
  if (!model.contextWindow) return undefined
  const percent = model.effectiveContextWindowPercent ?? DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT
  return Math.floor((model.contextWindow * percent) / 100)
}

function reasoningLabel(effort: string): string {
  if (effort === 'xhigh') return 'XHigh'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

export function getOpenAIChatGPTReasoningTiers(modelId: string): readonly ReasoningTierOption[] | undefined {
  const model = getOpenAIChatGPTRuntimeModel(modelId)
  if (!model) {
    return getOpenAIAuthContext().mode === 'chatgpt' && modelId.startsWith('openai:') ? [] : undefined
  }
  const levels = model.supportedReasoningLevels ?? []
  return levels.map(({ effort, description }) => ({
    label: reasoningLabel(effort),
    value: effort,
    description: description ?? `${reasoningLabel(effort)} reasoning effort`,
  }))
}

export function resetOpenAIChatGPTModelsForTesting(): void {
  runtimeModels = undefined
  runtimeAccountKey = undefined
  runtimeAuthGeneration = undefined
  runtimeError = undefined
  runtimeErrorCode = undefined
  runtimeSource = undefined
  fetchedAt = 0
  lastClientVersion = undefined
  catalogRefreshPromises.clear()
}
