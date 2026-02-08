// @x-code/core — Configuration loading (env vars + config file)

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { AppConfig, ProviderConfig } from '../types/index.js'
import { MODEL_ALIASES, PROVIDER_DETECTION_ORDER } from '../types/index.js'

const CONFIG_DIR = path.join(os.homedir(), '.xcode')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

/** Load config from ~/.xcode/config.json */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8')
    return JSON.parse(raw) as AppConfig
  } catch {
    return { providers: {} }
  }
}

/** Save config to ~/.xcode/config.json (mode 600) */
export async function saveConfig(config: AppConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
}

/** Get API key for a provider — env var takes priority over config file */
function getApiKey(provider: string, config: AppConfig): string | undefined {
  const envMap: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_GENERATIVE_AI_API_KEY',
    xai: 'XAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    alibaba: 'ALIBABA_API_KEY',
    zhipu: 'ZHIPU_API_KEY',
    moonshotai: 'MOONSHOT_API_KEY',
  }
  const envKey = envMap[provider]
  if (envKey && process.env[envKey]) return process.env[envKey]
  return config.providers[provider]?.apiKey
}

/** Check which providers have API keys configured */
export function getAvailableProviders(config: AppConfig): string[] {
  const providers: string[] = []
  const allProviders = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'alibaba', 'zhipu', 'moonshotai']
  for (const p of allProviders) {
    if (getApiKey(p, config)) providers.push(p)
  }
  // Check custom OpenAI compatible
  if (
    (process.env.OPENAI_COMPATIBLE_API_KEY || config.providers.custom?.apiKey) &&
    (process.env.OPENAI_COMPATIBLE_BASE_URL || config.providers.custom?.baseURL)
  ) {
    providers.push('custom')
  }
  return providers
}

/** Resolve model ID from alias/full ID, with smart default fallback */
export function resolveModelId(input: string | undefined, config: AppConfig): string | null {
  // 1. CLI --model argument or env var
  const raw = input ?? process.env.X_CODE_MODEL ?? config.model
  if (raw) {
    // Resolve alias
    const resolved = MODEL_ALIASES[raw] ?? raw
    // Ensure it has provider prefix
    return resolved.includes(':') ? resolved : resolved
  }

  // 2. Smart default: scan for first available API key
  for (const { envKey, defaultModel } of PROVIDER_DETECTION_ORDER) {
    if (process.env[envKey]) return defaultModel
  }

  // Check config file providers
  for (const { defaultModel } of PROVIDER_DETECTION_ORDER) {
    const provider = defaultModel.split(':')[0]
    if (config.providers[provider]?.apiKey) return defaultModel
  }

  return null // No provider configured
}

/** Build provider options with API keys from env + config */
export function getProviderOptions(config: AppConfig) {
  return {
    anthropic: getApiKey('anthropic', config),
    openai: getApiKey('openai', config),
    google: getApiKey('google', config),
    xai: getApiKey('xai', config),
    deepseek: getApiKey('deepseek', config),
    alibaba: getApiKey('alibaba', config),
    zhipu: getApiKey('zhipu', config),
    moonshotai: getApiKey('moonshotai', config),
    custom: {
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? config.providers.custom?.apiKey,
      baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL ?? config.providers.custom?.baseURL,
    },
  }
}

export { CONFIG_DIR, CONFIG_FILE }
