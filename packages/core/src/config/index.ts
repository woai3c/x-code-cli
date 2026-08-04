// @x-code-cli/core — Configuration resolution
//
// API keys always come from environment variables (provider-specific keys
// like ANTHROPIC_API_KEY / ALIBABA_API_KEY — never stored on disk).
//
// The default **model** can come from four sources, in precedence order:
//   1. `--model` CLI flag (explicit `input` arg)
//   2. `~/.x-code/config.json` `model` field — written by `/model` picker
//   3. `X_CODE_MODEL` environment variable
//   4. Smart default: first provider (by PROVIDER_DETECTION_ORDER) with a key
//
// The picker's choice beats the env var so that `/model` "sticks" across
// restarts — otherwise a user who had `X_CODE_MODEL` set in their shell /
// .env file would see their `/model` selection silently reverted next
// launch (reported bug).
import fsSync from 'node:fs'
import path from 'node:path'

import { MODEL_ALIASES, PROVIDER_DETECTION_ORDER } from '../types/index.js'
import { userXcodeDir } from '../utils.js'

/** Provider → environment variable mapping */
const ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  alibaba: 'ALIBABA_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
}

/** Get API key for a provider — reads from environment variables only */
function getApiKey(provider: string): string | undefined {
  const envKey = ENV_MAP[provider]
  return envKey ? process.env[envKey] : undefined
}

/** Get the env var name for a provider */
export function getEnvVarName(provider: string): string | undefined {
  return ENV_MAP[provider]
}

/** Check which providers have API keys configured (env vars only) */
export function getAvailableProviders(): string[] {
  const providers = Object.keys(ENV_MAP).filter((p) => getApiKey(p))
  if (process.env.OPENAI_COMPATIBLE_API_KEY && process.env.OPENAI_COMPATIBLE_BASE_URL) {
    providers.push('custom')
  }
  return providers
}

/**
 * Resolve a model ID with four levels of precedence:
 *   1. Explicit `input` (e.g. --model CLI flag)
 *   2. `~/.x-code/config.json` `model` field (written by the /model picker)
 *   3. `X_CODE_MODEL` environment variable
 *   4. Smart default: first provider (by PROVIDER_DETECTION_ORDER) with an API key
 *
 * Aliases in MODEL_ALIASES (e.g. "sonnet" → "anthropic:claude-sonnet-4-5")
 * are expanded at all levels. Returns null if no provider is configured.
 */
export function resolveModelId(input?: string): string | null {
  const explicit = input ?? loadUserConfig().model ?? process.env.X_CODE_MODEL
  if (explicit) {
    return MODEL_ALIASES[explicit] ?? explicit
  }

  for (const { envKey, defaultModel } of PROVIDER_DETECTION_ORDER) {
    if (process.env[envKey]) return defaultModel
  }

  return null
}

// ── User config file (~/.x-code/config.json) ────────────────────────────
//
// Persistent preferences:
//   model    — id the /model picker most recently committed
//   thinking — extended-thinking / reasoning toggle written by /thinking.
//              Applied uniformly across providers that expose a thinking
//              switch (see providers/thinking.ts). Default is undefined
//              (treated as off) so naive launches don't silently incur the
//              2-10× latency on providers whose default is off (Sonnet,
//              DeepSeek, Qwen) — same as the pre-feature baseline.
//
// API keys are deliberately NOT stored here (env-var only, see header
// comment).

/** Browser-automation settings for the `browser` sub-agent. Default-off: the
 *  agent is only registered when `enabled` is true (see createSubAgentRegistry),
 *  so users who don't opt in see no change to the agent list or the byte-stable
 *  system prompt. The engine is the @playwright/mcp server, spawned on first
 *  browser-agent use. */
export interface BrowserConfig {
  enabled?: boolean
  /** Run headless (no visible window). Default: visible, so the user can watch
   *  the agent drive the browser. */
  headless?: boolean
  /** Browser channel @playwright/mcp drives. Default 'chrome' — the user's
   *  installed Google Chrome (no Chromium download). */
  browser?: 'chrome' | 'chromium' | 'msedge' | 'firefox' | 'webkit'
  /** Browser viewport size as "width,height" (px). Default '1280,800'. Caps
   *  screenshot resolution — vision token cost scales with image dimensions, so
   *  a smaller viewport means cheaper screenshots. Raise it only if a site needs
   *  a wider layout to render correctly. */
  viewport?: string
  /** Visual (screenshot + coordinate-click) browsing. Adds `--caps vision` to
   *  the @playwright/mcp launch so the agent can screenshot a page and act by
   *  pixel coordinates — the only way to drive canvas / WebGL / chart content
   *  the accessibility tree can't represent. Default (undefined) is AUTO: on
   *  whenever a vision-capable model is reachable (the active model, or any
   *  other configured provider the browser agent can borrow). Set `false` to
   *  force tree-only; `true` to force it on. */
  vision?: boolean
  /** Override the launch command entirely (advanced: offline, pinned version,
   *  custom server). When set, `args` is passed verbatim. */
  command?: string
  args?: string[]
}

export interface MemoryRecallConfig {
  maxTopicsPerTurn: number
  maxTokensPerTopic: number
  maxTokensPerTurn: number
  maxTokensPerCompactionWindow: number
  semanticSelector: 'auto' | 'off'
  selectorModel: string
  lateBoundRecall: boolean
}

export type MemoryReasoningMode = 'auto' | 'off' | 'low' | 'provider-default'

export interface MemoryConfig {
  model: string
  reasoning: MemoryReasoningMode
  maxInputTokens: number
  maxOutputTokens: number
  maxTotalOutputTokens: number
  maxOperationsPerTurn: number
  drainTimeoutMs: number
  retryMaxAttempts: number
  recall: MemoryRecallConfig
}

export const DEFAULT_MEMORY_CONFIG: Readonly<MemoryConfig> = {
  model: 'inherit',
  reasoning: 'auto',
  maxInputTokens: 12_000,
  maxOutputTokens: 1500,
  maxTotalOutputTokens: 8192,
  maxOperationsPerTurn: 8,
  drainTimeoutMs: 5000,
  retryMaxAttempts: 8,
  recall: {
    maxTopicsPerTurn: 5,
    maxTokensPerTopic: 1500,
    maxTokensPerTurn: 4000,
    maxTokensPerCompactionWindow: 15_000,
    semanticSelector: 'auto',
    selectorModel: 'inherit',
    lateBoundRecall: true,
  },
}

export function resolveMemoryConfig(config: UserConfig = loadUserConfig()): MemoryConfig {
  const memory =
    config.memory && typeof config.memory === 'object' && !Array.isArray(config.memory)
      ? (config.memory as Record<string, unknown>)
      : {}
  const recallValue = memory.recall
  const recall =
    recallValue && typeof recallValue === 'object' && !Array.isArray(recallValue)
      ? (recallValue as Record<string, unknown>)
      : {}
  const integer = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback
  const text = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback
  const maxTokensPerTopic = integer(
    recall.maxTokensPerTopic,
    DEFAULT_MEMORY_CONFIG.recall.maxTokensPerTopic,
    100,
    10_000,
  )
  const maxTokensPerTurn = Math.max(
    maxTokensPerTopic,
    integer(recall.maxTokensPerTurn, DEFAULT_MEMORY_CONFIG.recall.maxTokensPerTurn, 100, 20_000),
  )
  const maxOutputTokens = integer(memory.maxOutputTokens, DEFAULT_MEMORY_CONFIG.maxOutputTokens, 128, 8192)
  return {
    model: text(memory.model, DEFAULT_MEMORY_CONFIG.model),
    reasoning:
      memory.reasoning === 'auto' ||
      memory.reasoning === 'off' ||
      memory.reasoning === 'low' ||
      memory.reasoning === 'provider-default'
        ? memory.reasoning
        : DEFAULT_MEMORY_CONFIG.reasoning,
    maxInputTokens: integer(memory.maxInputTokens, DEFAULT_MEMORY_CONFIG.maxInputTokens, 1000, 100_000),
    maxOutputTokens,
    maxTotalOutputTokens: Math.max(
      maxOutputTokens,
      integer(memory.maxTotalOutputTokens, DEFAULT_MEMORY_CONFIG.maxTotalOutputTokens, 128, 65_536),
    ),
    maxOperationsPerTurn: integer(memory.maxOperationsPerTurn, DEFAULT_MEMORY_CONFIG.maxOperationsPerTurn, 1, 8),
    drainTimeoutMs: integer(memory.drainTimeoutMs, DEFAULT_MEMORY_CONFIG.drainTimeoutMs, 0, 30_000),
    retryMaxAttempts: integer(memory.retryMaxAttempts, DEFAULT_MEMORY_CONFIG.retryMaxAttempts, 1, 8),
    recall: {
      maxTopicsPerTurn: integer(recall.maxTopicsPerTurn, DEFAULT_MEMORY_CONFIG.recall.maxTopicsPerTurn, 1, 5),
      maxTokensPerTopic,
      maxTokensPerTurn,
      maxTokensPerCompactionWindow: Math.max(
        maxTokensPerTurn,
        integer(
          recall.maxTokensPerCompactionWindow,
          DEFAULT_MEMORY_CONFIG.recall.maxTokensPerCompactionWindow,
          100,
          100_000,
        ),
      ),
      semanticSelector:
        recall.semanticSelector === 'auto' || recall.semanticSelector === 'off'
          ? recall.semanticSelector
          : DEFAULT_MEMORY_CONFIG.recall.semanticSelector,
      selectorModel: text(recall.selectorModel, DEFAULT_MEMORY_CONFIG.recall.selectorModel),
      lateBoundRecall:
        typeof recall.lateBoundRecall === 'boolean'
          ? recall.lateBoundRecall
          : DEFAULT_MEMORY_CONFIG.recall.lateBoundRecall,
    },
  }
}

export interface UserConfig {
  model?: string
  thinking?: boolean
  /** Persisted UI theme name. Drives both diff bg colors and the
   *  associated syntax-highlight palette. Validated at load time by
   *  `parseThemeName` in the CLI; the type stays loose `string` here
   *  because core doesn't depend on the CLI's theme list. Unknown
   *  values fall back to the default ('dark') silently. */
  theme?: string
  /** MCP server declarations. Loose-typed here because the schema is
   *  validated in `mcp/config-schema.ts` — we don't want to drag a Zod
   *  type into the config module's surface. Loader uses
   *  `parseServersBlock` to validate before constructing clients. */
  mcpServers?: Record<string, unknown>
  /** Browser sub-agent settings. Absent / `enabled !== true` ⇒ the browser
   *  agent is not registered (the default). */
  browser?: BrowserConfig
  /** Per-model reasoning effort levels chosen via the /model tier picker.
   *  Key = full model id (e.g. "openai:gpt-5.6-sol"), value = effort label
   *  (e.g. "medium"). When present, it overrides the /thinking toggle for
   *  that model — tier knows what the user actually wants; /thinking is a
   *  coarse fallback for models without an explicit tier. */
  modelReasoningEffort?: Record<string, string>
  /** Base URLs for multi-endpoint providers, chosen via the /model base-URL
   *  picker. Key = provider key (e.g. "moonshotai"), value = full base URL
   *  (e.g. "https://api.moonshot.cn/v1"). */
  baseUrls?: Record<string, string>
  memory?: Partial<Omit<MemoryConfig, 'recall'>> & { recall?: Partial<MemoryRecallConfig> }
}

/** Path to the user config file. Exposed so other modules that want to
 *  read the same JSON (e.g. the MCP loader for the `mcpServers` field)
 *  honour the X_CODE_HOME override automatically. */
export function getUserConfigPath(): string {
  return path.join(userXcodeDir(), 'config.json')
}

/** Read the user config. Returns empty object on any failure (missing file,
 *  parse error, wrong shape) so callers don't have to null-check. */
export function loadUserConfig(): UserConfig {
  try {
    const raw = fsSync.readFileSync(getUserConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as UserConfig
    }
  } catch {
    // File may not exist yet, or is malformed — either way fall through to {}
  }
  return {}
}

/** Write a partial update into the user config, preserving other keys. */
export function saveUserConfig(update: Partial<UserConfig>): void {
  const merged: UserConfig = { ...loadUserConfig(), ...update }
  try {
    // mkdir the SAME root getUserConfigPath() points at — otherwise an
    // X_CODE_HOME override creates `~/.x-code/` but writes to the override
    // and the write silently fails on a missing parent.
    fsSync.mkdirSync(userXcodeDir(), { recursive: true })
    fsSync.writeFileSync(getUserConfigPath(), JSON.stringify(merged, null, 2) + '\n', 'utf-8')
  } catch {
    // Best-effort: don't crash the UI if the config dir is read-only.
  }
}

/** Build provider options with API keys from env vars */
export function getProviderOptions() {
  return {
    anthropic: getApiKey('anthropic'),
    openai: getApiKey('openai'),
    google: getApiKey('google'),
    xai: getApiKey('xai'),
    deepseek: getApiKey('deepseek'),
    alibaba: getApiKey('alibaba'),
    zhipu: getApiKey('zhipu'),
    moonshotai: getApiKey('moonshotai'),
    custom: {
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
      baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL,
    },
  }
}
