import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { getOpenAIAuthContext } from '../auth/openai-chatgpt/auth-resolver.js'
import { readOpenAIChatGPTCredentials } from '../auth/openai-chatgpt/credential-store.js'
import { OPENAI_CHATGPT_OAUTH } from '../auth/openai-chatgpt/oauth.js'
import { getOpenAIChatGPTTokenManager } from '../auth/openai-chatgpt/token-manager.js'
import { debugLog, userXcodeDir } from '../utils.js'
import { PROVIDER_MODELS } from './catalog.js'
import type { ProviderModel, ReasoningTierOption } from './catalog.js'

const CACHE_TTL_MS = 5 * 60 * 1000

export interface OpenAIChatGPTRuntimeModel extends ProviderModel {
  contextWindow?: number
  defaultReasoningLevel?: string
  maxOutputTokens?: number
  supportsReasoningSummaryParameter?: boolean
  supportedReasoningLevels?: Array<{ effort: string; description?: string }>
}

interface RemoteModel {
  slug?: string
  display_name?: string
  description?: string
  input_modalities?: string[]
  context_window?: number
  default_reasoning_level?: string
  max_context_window?: number
  max_output_tokens?: number
  supports_reasoning_summary_parameter?: boolean
  supported_reasoning_levels?: Array<{ effort?: string; description?: string }>
  visibility?: string
  priority?: number
}

interface ModelsResponse {
  models?: RemoteModel[]
}

interface ModelsCache {
  accountKey: string
  fetchedAt: number
  models: OpenAIChatGPTRuntimeModel[]
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
let fetchedAt = 0
let lastClientVersion: string | undefined

function cachePath(): string {
  return path.join(userXcodeDir(), 'cache', 'openai-chatgpt-models.json')
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
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

async function loadCache(accountKey: string): Promise<ModelsCache | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(cachePath(), 'utf-8')) as Partial<ModelsCache>
    if (
      value.accountKey === accountKey &&
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

async function writeCache(cache: ModelsCache): Promise<void> {
  const target = cachePath()
  const temp = `${target}.${process.pid}.tmp`
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(temp, JSON.stringify(cache, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(temp, target)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined)
  }
}

function normalizeRemoteModels(response: ModelsResponse): OpenAIChatGPTRuntimeModel[] {
  return (response.models ?? [])
    .filter((model) => !!model.slug && (model.visibility === undefined || model.visibility === 'list'))
    .sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER))
    .map((model) => {
      const supportedReasoningLevels = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
            .filter((level): level is { effort: string; description?: string } => !!level.effort)
            .map((level) => ({
              effort: level.effort,
              ...(level.description ? { description: level.description } : {}),
            }))
        : undefined
      return {
        id: `openai:${model.slug!}`,
        label: model.display_name || model.slug!,
        description: model.description || 'ChatGPT subscription model',
        vision: !Array.isArray(model.input_modalities) || model.input_modalities.includes('image'),
        supportsReasoningSummaryParameter: model.supports_reasoning_summary_parameter !== false,
        ...(typeof (model.context_window ?? model.max_context_window) === 'number' &&
        (model.context_window ?? model.max_context_window)! > 0
          ? { contextWindow: model.context_window ?? model.max_context_window }
          : {}),
        ...(typeof model.default_reasoning_level === 'string' && model.default_reasoning_level
          ? { defaultReasoningLevel: model.default_reasoning_level }
          : {}),
        ...(typeof model.max_output_tokens === 'number' && model.max_output_tokens > 0
          ? { maxOutputTokens: model.max_output_tokens }
          : {}),
        ...(supportedReasoningLevels ? { supportedReasoningLevels } : {}),
      }
    })
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
    fetchImpl(`${OPENAI_CHATGPT_OAUTH.modelsEndpoint}?client_version=${encodeURIComponent(clientVersion)}`, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        ...(auth.accountId ? { 'ChatGPT-Account-ID': auth.accountId } : {}),
        ...(auth.isFedRamp ? { 'X-OpenAI-Fedramp': 'true' } : {}),
        originator: 'x-code-cli',
        'User-Agent': `x-code-cli/${clientVersion}`,
      },
      signal,
    })

  let response = await request()
  if (response.status === 401) {
    auth = await manager.recoverAfterUnauthorized(auth.accessToken, signal)
    response = await request()
  }
  if (!response.ok) throw new Error(`ChatGPT model catalog request failed (${response.status})`)
  const models = normalizeRemoteModels((await response.json()) as ModelsResponse)
  return { accountKey, fetchedAt: Date.now(), models }
}

export async function refreshOpenAIChatGPTModels(
  clientVersion: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal; force?: boolean } = {},
): Promise<readonly OpenAIChatGPTRuntimeModel[]> {
  if (getOpenAIAuthContext().mode !== 'chatgpt') return PROVIDER_MODELS.openai ?? []
  lastClientVersion = clientVersion
  let accountKey: string
  try {
    accountKey = await currentAccountKey()
  } catch (err) {
    debugLog('openai-chatgpt.models-account-read-failed', err instanceof Error ? err.message : String(err))
    runtimeModels = FALLBACK_MODELS
    runtimeAccountKey = undefined
    fetchedAt = Date.now()
    return runtimeModels
  }
  if (!options.force && runtimeModels && runtimeAccountKey === accountKey && Date.now() - fetchedAt < CACHE_TTL_MS) {
    return runtimeModels
  }

  const cached = await loadCache(accountKey)
  if (!options.force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    runtimeModels = cached.models
    runtimeAccountKey = accountKey
    fetchedAt = cached.fetchedAt
    return runtimeModels
  }

  try {
    const remote = await fetchRemoteModels(clientVersion, accountKey, options.fetch ?? fetch, options.signal)
    runtimeModels = remote.models
    runtimeAccountKey = accountKey
    fetchedAt = remote.fetchedAt
    await writeCache(remote).catch((err) => debugLog('openai-chatgpt.models-cache-write-failed', String(err)))
  } catch (err) {
    debugLog('openai-chatgpt.models-refresh-failed', err instanceof Error ? err.message : String(err))
    runtimeModels = cached?.models ?? FALLBACK_MODELS
    runtimeAccountKey = accountKey
    fetchedAt = cached?.fetchedAt ?? Date.now()
  }
  return runtimeModels
}

export async function refreshOpenAIChatGPTModelsAfterNotFound(signal?: AbortSignal): Promise<void> {
  if (!lastClientVersion) return
  await refreshOpenAIChatGPTModels(lastClientVersion, { signal, force: true })
}

export function getProviderModels(): Record<string, readonly ProviderModel[]> {
  if (getOpenAIAuthContext().mode !== 'chatgpt') return PROVIDER_MODELS
  return { ...PROVIDER_MODELS, openai: runtimeModels ?? FALLBACK_MODELS }
}

export function getOpenAIChatGPTRuntimeModel(modelId: string): OpenAIChatGPTRuntimeModel | undefined {
  if (getOpenAIAuthContext().mode !== 'chatgpt') return undefined
  return (runtimeModels ?? FALLBACK_MODELS).find((model) => model.id === modelId)
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
  fetchedAt = 0
  lastClientVersion = undefined
}
