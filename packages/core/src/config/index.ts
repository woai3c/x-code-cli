// @x-code/core — Configuration loading (env vars for API keys, config file for model preference)

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { AppConfig } from '../types/index.js'
import { MODEL_ALIASES, PROVIDER_DETECTION_ORDER } from '../types/index.js'

const CONFIG_DIR = path.join(os.homedir(), '.xcode')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

/** Load config from ~/.xcode/config.json (model preference only) */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8')
    return JSON.parse(raw) as AppConfig
  } catch {
    return {}
  }
}

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
  const providers: string[] = []
  const allProviders = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'alibaba', 'zhipu', 'moonshotai']
  for (const p of allProviders) {
    if (getApiKey(p)) providers.push(p)
  }
  // Check custom OpenAI compatible
  if (process.env.OPENAI_COMPATIBLE_API_KEY && process.env.OPENAI_COMPATIBLE_BASE_URL) {
    providers.push('custom')
  }
  return providers
}

/** Resolve model ID from alias/full ID, with smart default fallback */
export function resolveModelId(input: string | undefined, config: AppConfig): string | null {
  // 1. Explicit user choice: --model flag or X_CODE_MODEL env var
  const explicit = input ?? process.env.X_CODE_MODEL
  if (explicit) {
    // Always return explicit choice (will show clear error later if key missing)
    return MODEL_ALIASES[explicit] ?? explicit
  }

  // 2. Config file model preference — only if provider key is available
  if (config.model) {
    const resolved = MODEL_ALIASES[config.model] ?? config.model
    const provider = resolved.split(':')[0]
    if (provider && getApiKey(provider)) {
      return resolved
    }
    // Provider key not available — fall through to smart default
  }

  // 3. Smart default: scan for first available API key
  for (const { envKey, defaultModel } of PROVIDER_DETECTION_ORDER) {
    if (process.env[envKey]) return defaultModel
  }

  return null // No provider configured
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

export { CONFIG_DIR, CONFIG_FILE }
