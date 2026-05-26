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
}

/** Path to the user config file. Exposed so other modules that want to
 *  read the same JSON (e.g. the MCP loader for the `mcpServers` field)
 *  honour the X_CODE_HOME override automatically. */
export function getUserConfigPath(): string {
  return userConfigPath()
}

function userConfigPath(): string {
  return path.join(userXcodeDir(), 'config.json')
}

/** Read the user config. Returns empty object on any failure (missing file,
 *  parse error, wrong shape) so callers don't have to null-check. */
export function loadUserConfig(): UserConfig {
  try {
    const raw = fsSync.readFileSync(userConfigPath(), 'utf-8')
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
    // mkdir the SAME root userConfigPath() points at — otherwise an
    // X_CODE_HOME override creates `~/.x-code/` but writes to the override
    // and the write silently fails on a missing parent.
    fsSync.mkdirSync(userXcodeDir(), { recursive: true })
    fsSync.writeFileSync(userConfigPath(), JSON.stringify(merged, null, 2) + '\n', 'utf-8')
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
