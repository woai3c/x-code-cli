// @x-code-cli/core — Configuration resolution
//
// Everything comes from environment variables. API keys are mandatory and
// live in provider-specific env vars; the default model is an optional
// preference in X_CODE_MODEL. There is no config file — if the user wants
// to pin a default model, they export X_CODE_MODEL or pass --model each time.
import { MODEL_ALIASES, PROVIDER_DETECTION_ORDER } from '../types/index.js'

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
 * Resolve a model ID with three levels of precedence:
 *   1. Explicit `input` (e.g. --model CLI flag)
 *   2. `X_CODE_MODEL` environment variable
 *   3. Smart default: first provider (by PROVIDER_DETECTION_ORDER) with an API key
 *
 * Aliases in MODEL_ALIASES (e.g. "sonnet" → "anthropic:claude-sonnet-4-5")
 * are expanded at all levels. Returns null if no provider is configured.
 */
export function resolveModelId(input?: string): string | null {
  const explicit = input ?? process.env.X_CODE_MODEL
  if (explicit) {
    return MODEL_ALIASES[explicit] ?? explicit
  }

  for (const { envKey, defaultModel } of PROVIDER_DETECTION_ORDER) {
    if (process.env[envKey]) return defaultModel
  }

  return null
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
