// Detect API keys from env (and optionally .env), map to a flat list of model
// ids the user can pick to drive the e2e suite.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')

export const DEFAULT_MODEL = 'deepseek:deepseek-v4-flash'

/** Provider env-var → list of model ids that can be selected when that key is set.
 *  Keep aligned with `packages/core/src/types/index.ts::PROVIDER_DETECTION_ORDER`. */
const PROVIDER_MODELS: Record<string, string[]> = {
  DEEPSEEK_API_KEY: ['deepseek:deepseek-v4-flash', 'deepseek:deepseek-v4-pro'],
  ANTHROPIC_API_KEY: [
    'anthropic:claude-fable-5',
    'anthropic:claude-opus-4-8',
    'anthropic:claude-sonnet-5',
    'anthropic:claude-haiku-4-5',
  ],
  OPENAI_API_KEY: ['openai:gpt-5.6-sol', 'openai:gpt-5.6-terra', 'openai:gpt-5.6-luna', 'openai:gpt-5.4-mini'],
  GOOGLE_GENERATIVE_AI_API_KEY: ['google:gemini-3.5-flash', 'google:gemini-2.5-pro', 'google:gemini-2.5-flash'],
  XAI_API_KEY: ['xai:grok-4.3', 'xai:grok-4.5'],
  ALIBABA_API_KEY: ['alibaba:qwen3.7-max', 'alibaba:qwen3.7-plus', 'alibaba:qwen3-coder-plus', 'alibaba:qwq-plus'],
  ZHIPU_API_KEY: ['zhipu:glm-5.2', 'zhipu:glm-5', 'zhipu:glm-4.7'],
  MOONSHOT_API_KEY: ['moonshotai:kimi-k2.6', 'moonshotai:kimi-k3'],
}

/** Short aliases — accepted on CLI `--model` flag. Aligns with product's
 *  `MODEL_ALIASES` table; keep them in sync. */
export const ALIASES: Record<string, string> = {
  fable: 'anthropic:claude-fable-5',
  sonnet: 'anthropic:claude-sonnet-5',
  opus: 'anthropic:claude-opus-4-8',
  haiku: 'anthropic:claude-haiku-4-5',
  gpt5: 'openai:gpt-5.6-sol',
  gemini: 'google:gemini-3.5-flash',
  deepseek: 'deepseek:deepseek-v4-flash',
  'deepseek-pro': 'deepseek:deepseek-v4-pro',
  qwen: 'alibaba:qwen3.7-max',
  glm: 'zhipu:glm-5.2',
  kimi: 'moonshotai:kimi-k3',
}

export function resolveModelArg(input: string): string {
  return ALIASES[input] ?? input
}

/** Best-effort .env loader. Does NOT overwrite values already in process.env.
 *  Returns the merged env after loading. */
export async function loadDotenv(): Promise<Record<string, string>> {
  const envPath = path.join(REPO_ROOT, '.env')
  let parsed: Record<string, string> = {}
  try {
    const raw = await fs.readFile(envPath, 'utf-8')
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      // Strip optional surrounding quotes.
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      parsed[key] = value
    }
  } catch {
    // No .env — that's fine.
  }
  // Don't overwrite already-set process.env keys.
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] == null) process.env[k] = v
  }
  // Build a return env that has only string values.
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  return env
}

export interface ModelOption {
  modelId: string
  providerEnvKey: string
}

/** Given the current env, return the flat list of (modelId, sourceEnvKey)
 *  pairs the user can pick. */
export function availableModels(env: Record<string, string>): ModelOption[] {
  const out: ModelOption[] = []
  for (const [envKey, models] of Object.entries(PROVIDER_MODELS)) {
    if (env[envKey]) {
      for (const modelId of models) out.push({ modelId, providerEnvKey: envKey })
    }
  }
  // OpenAI-compatible custom endpoint
  if (env.OPENAI_COMPATIBLE_API_KEY && env.OPENAI_COMPATIBLE_BASE_URL) {
    out.push({ modelId: 'custom:default', providerEnvKey: 'OPENAI_COMPATIBLE_API_KEY' })
  }
  return out
}

/** Pretty-printable summary of detected keys. Returns lines for direct printing. */
export function describeDetectedKeys(env: Record<string, string>): string[] {
  const lines: string[] = []
  for (const [envKey, models] of Object.entries(PROVIDER_MODELS)) {
    if (env[envKey]) {
      const family = envKey.replace(/_API_KEY|_GENERATIVE_AI_API_KEY/, '').toLowerCase()
      lines.push(`  ${envKey}  →  ${family}: ${models.map((m) => m.split(':')[1]).join(' / ')}`)
    }
  }
  if (env.OPENAI_COMPATIBLE_API_KEY && env.OPENAI_COMPATIBLE_BASE_URL) {
    lines.push(`  OPENAI_COMPATIBLE_API_KEY  →  custom endpoint @ ${env.OPENAI_COMPATIBLE_BASE_URL}`)
  }
  return lines
}
