// @x-code-cli/core — Provider metadata catalog
//
// Single source of truth for everything statically known about each
// provider: env var, default model, curated /model picker entries,
// API-key console URL, multi-endpoint options, reasoning-effort tiers.
// Adding a provider = one PROVIDERS entry (+ a constructor branch in
// registry.ts). The PROVIDER_* records at the bottom are derived views
// kept byte-compatible for existing consumers.

// ─── Types ───

export interface ProviderModel {
  /** Full `<provider>:<model>` id passed to AI SDK */
  id: string
  /** Short display label shown in the picker */
  label: string
  /** One-line description shown under the label */
  description: string
  /** True if this specific model can natively SEE images (multimodal), not
   *  just whether its provider's API accepts image parts. Drives the browser
   *  agent's visual gating (modelSupportsVision) so a text-only model never
   *  gets `--caps vision` / screenshots. Set per-model because providers mix
   *  vision and text-only models under one id namespace (e.g. DeepSeek Flash
   *  vs V4 Pro, Qwen-VL vs Qwen-Max, GLM-4V vs GLM-5). */
  vision: boolean
}

export interface ProviderBaseUrlOption {
  label: string
  url: string
}

export interface ReasoningTierOption {
  label: string
  value: string
  description: string
}

export interface ReasoningTierProfile {
  /** Restrict this profile to matching model ids. Omit for a provider-wide profile. */
  modelPattern?: RegExp
  options: readonly ReasoningTierOption[]
  /** Lowest valid effort for models that reject disabling reasoning. */
  offValue?: string
}

export interface ProviderInfo {
  /** Provider key used in `<provider>:<model>` ids and config maps. */
  name: string
  /** Environment variable the API key is read from (never stored on disk). */
  envKey: string
  /** Model used when this provider wins smart-default detection. */
  defaultModel: string
  /** Console page where the user can mint an API key. */
  keyUrl: string
  /** Hand-curated models shown in the interactive `/model` picker. Users can
   *  still type any full id into `/model <provider>:<model>` for variants
   *  not listed here. Each provider lists a light/medium/high ladder drawn
   *  from its current generation. Vision flags reflect model FAMILY:
   *  Claude 5.5 / GPT-6 / Gemini 4 and Gemini 3.8 Flash / Grok 4.x / Kimi K3 /
   *  Qwen4 and Qwen3.8 / GLM-5.3 Flash are multimodal; DeepSeek V4 Pro,
   *  GLM-5.3 and GLM-4.7-Flash are text-only. */
  models: readonly ProviderModel[]
  /** Providers that serve multiple endpoints for the same API (regional
   *  platforms, plan-specific gateways, etc.). When a user picks a model
   *  from such a provider, the /model flow shows a picker so they can
   *  choose the right endpoint. The chosen URL is persisted in
   *  UserConfig.baseUrls and is the single source of truth — no env var
   *  involved. */
  baseUrlOptions?: readonly ProviderBaseUrlOption[]
  /** Providers that expose a granular reasoning-effort knob (beyond binary
   *  on/off). After picking a model from such a provider, /model shows a
   *  second picker so the user can choose the effort level. The chosen
   *  level is persisted per-model in UserConfig.modelReasoningEffort.
   *
   *  Providers with no entry here (alibaba) only support the binary
   *  /thinking toggle — skip the tier picker.
   *
   *  `modelPattern` gates each profile to the models that actually honor it:
   *  within a provider, only some model families expose the granular knob
   *  (e.g. thinkingLevel is Gemini 4-only, Kimi's reasoningEffort is
   *  K3-series-only). Models that don't match fall back to the binary
   *  /thinking toggle. */
  reasoningTiers?: readonly ReasoningTierProfile[]
}

// ─── The table ───
//
// Entry order = display order in the /model picker (PROVIDER_MODELS key
// order is observable UI). Smart-default detection uses DETECTION_ORDER
// below instead.

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    name: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    defaultModel: 'anthropic:claude-sonnet-5-5',
    keyUrl: 'https://console.anthropic.com/',
    models: [
      {
        id: 'anthropic:claude-fable-5-2',
        label: 'Fable 5.2',
        description: 'Newest frontier model for long-horizon agentic work, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-sonnet-5-5',
        label: 'Sonnet 5.5',
        description: 'Best balance, near-flagship coding at $2/$10, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-haiku-5-5',
        label: 'Haiku 5.5',
        description: 'Fastest, cheapest tier, 1M context',
        vision: true,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /claude-(?:fable-5-2|opus-5-5)$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum adaptive reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Very deep reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
      {
        modelPattern: /claude-(?:sonnet-5-5|haiku-5-5)$/,
        options: [
          { label: 'Low', value: 'low', description: 'Minimal reasoning, fastest' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Very deep reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
    ],
  },
  {
    name: 'openai',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'openai:gpt-6.2-sol',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      {
        id: 'openai:gpt-6.2-astra',
        label: 'GPT-6.2 Astra',
        description: 'Newest flagship, 1.05M context and 128K output, $8/$40',
        vision: true,
      },
      {
        id: 'openai:gpt-6.2-sol',
        label: 'GPT-6.2 Sol',
        description: 'Everyday coding and agentic tier, $2/$10, 1.05M context',
        vision: true,
      },
      {
        id: 'openai:gpt-6.1-terra',
        label: 'GPT-6.1 Terra',
        description: 'Fast visual-reasoning and computer-use tier, $1/$5, 1.05M context',
        vision: true,
      },
      {
        id: 'openai:gpt-6-luna',
        label: 'GPT-6 Luna',
        description: 'Cheapest high-volume tier, 1.05M context',
        vision: true,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /gpt-6\.2-astra$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Very deep reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
      {
        modelPattern: /(?:gpt-6\.2-sol|gpt-6\.1-terra|gpt-6-luna)$/,
        options: [
          { label: 'Low', value: 'low', description: 'Fast, concise reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Very deep reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
    ],
  },
  {
    name: 'deepseek',
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek:deepseek-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      {
        id: 'deepseek:deepseek-flash',
        label: 'DeepSeek V4.1 Flash',
        description: 'Latest fast, efficient model with native vision and 1M context',
        vision: true,
      },
      {
        id: 'deepseek:deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        description: 'Flagship V4 model with 1M context and text-only API surface',
        vision: false,
      },
    ],
    reasoningTiers: [
      {
        // Flash and V4 Pro support low/high/max; medium/xhigh map to high server-side.
        modelPattern: /deepseek-(?:flash|v4)/,
        options: [
          { label: 'Low', value: 'low', description: 'Faster, less reasoning' },
          { label: 'High', value: 'high', description: 'Standard reasoning (default)' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
    ],
  },
  {
    name: 'alibaba',
    envKey: 'ALIBABA_API_KEY',
    defaultModel: 'alibaba:qwen4-max',
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    models: [
      {
        id: 'alibaba:qwen4-max',
        label: 'Qwen4 Max',
        description: 'Newest flagship with native vision, 1M context',
        vision: true,
      },
      {
        id: 'alibaba:qwen3.8-max',
        label: 'Qwen3.8 Max',
        description: 'Previous flagship with native vision, 1M context',
        vision: true,
      },
      {
        id: 'alibaba:qwen3.8-flash',
        label: 'Qwen3.8 Flash',
        description: 'Fast multimodal model with 1M context',
        vision: true,
      },
    ],
  },
  {
    name: 'google',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    defaultModel: 'google:gemini-4-hydrogen',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      {
        id: 'google:gemini-4-carbon',
        label: 'Gemini 4 Carbon',
        description: 'Strongest reasoning for long-horizon agentic work, 1M context',
        vision: true,
      },
      {
        id: 'google:gemini-4-argon',
        label: 'Gemini 4 Argon',
        description: 'Efficient frontier reasoning model, 1M context',
        vision: true,
      },
      {
        id: 'google:gemini-4-hydrogen',
        label: 'Gemini 4 Hydrogen',
        description: 'Fast, low-cost everyday agentic model, 1M context',
        vision: true,
      },
      {
        id: 'google:gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        description: 'Flash-tier workhorse for long-horizon coding and agents, 1M context',
        vision: true,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /gemini-4-/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning, higher quality' },
        ],
      },
      {
        modelPattern: /gemini-3\.8-flash$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Lower latency, lower cost' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning (default)' },
          { label: 'High', value: 'high', description: 'Deeper reasoning, higher quality' },
        ],
      },
    ],
  },
  {
    name: 'xai',
    envKey: 'XAI_API_KEY',
    defaultModel: 'xai:grok-4.7',
    keyUrl: 'https://console.x.ai/',
    models: [
      {
        id: 'xai:grok-4.7',
        label: 'Grok 4.7',
        description: 'Newest flagship for coding and agentic work, $2/$6, 500k context',
        vision: true,
      },
      {
        id: 'xai:grok-4.6',
        label: 'Grok 4.6',
        description: 'Previous flagship, native vision and 500k context',
        vision: true,
      },
      {
        id: 'xai:grok-4.5',
        label: 'Grok 4.5',
        description: 'Lower-cost agentic coding tier, 500k context',
        vision: true,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /grok-4\.7$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Maximum supported reasoning' },
        ],
      },
      {
        modelPattern: /grok-4\.6$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Maximum supported reasoning' },
        ],
      },
      {
        modelPattern: /grok-4\.5$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Maximum reasoning depth' },
        ],
      },
    ],
  },
  {
    name: 'zhipu',
    envKey: 'ZHIPU_API_KEY',
    defaultModel: 'zhipu:glm-5.3',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [
      {
        id: 'zhipu:glm-5.3',
        label: 'GLM-5.3',
        description: 'Newest reasoning flagship for coding and agents, 1M context',
        vision: false,
      },
      {
        id: 'zhipu:glm-5.3-flash',
        label: 'GLM-5.3 Flash',
        description: 'Mid-tier native multimodal model with 1M context',
        vision: true,
      },
      {
        id: 'zhipu:glm-4.7-flash',
        label: 'GLM-4.7 Flash',
        description: 'Free lightweight text model with 200k context',
        vision: false,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /glm-5\.3(?:-flash)?$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'High', value: 'high', description: 'Enhanced reasoning' },
          { label: 'Max', value: 'max', description: 'Deep reasoning (default)' },
        ],
      },
    ],
  },
  {
    name: 'moonshotai',
    envKey: 'MOONSHOT_API_KEY',
    defaultModel: 'moonshotai:kimi-k3.1-pro',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    models: [
      {
        id: 'moonshotai:kimi-k3.1-pro',
        label: 'Kimi K3.1 Pro',
        description: 'Newest flagship, 1M context, native multimodal',
        vision: true,
      },
      {
        id: 'moonshotai:kimi-k3',
        label: 'Kimi K3',
        description: 'Previous-generation flagship, 1M context, native multimodal',
        vision: true,
      },
      {
        id: 'moonshotai:kimi-k3.1-pro-highspeed',
        label: 'Kimi K3.1 Pro Highspeed',
        description: 'Same intelligence about 2-3x faster, 1M context',
        vision: true,
      },
    ],
    baseUrlOptions: [
      { label: 'api.kimi.com/coding (Coding Plan)', url: 'https://api.kimi.com/coding/v1' },
      { label: 'api.moonshot.cn (China)', url: 'https://api.moonshot.cn/v1' },
      { label: 'api.moonshot.ai (International)', url: 'https://api.moonshot.ai/v1' },
    ],
    reasoningTiers: [
      {
        // reasoning_effort is K3-series-only; K2.x uses the binary thinking switch.
        modelPattern: /kimi-k3/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Faster, concise reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning (default)' },
        ],
      },
    ],
  },
]

// ─── Model aliases ───

export const MODEL_ALIASES: Record<string, string> = {
  fable: 'anthropic:claude-fable-5-2',
  sonnet: 'anthropic:claude-sonnet-5-5',
  opus: 'anthropic:claude-opus-5-5',
  haiku: 'anthropic:claude-haiku-5-5',
  gpt6: 'openai:gpt-6.2-astra',
  astra: 'openai:gpt-6.2-astra',
  sol: 'openai:gpt-6.2-sol',
  terra: 'openai:gpt-6.1-terra',
  luna: 'openai:gpt-6-luna',
  gemini: 'google:gemini-4-hydrogen',
  deepseek: 'deepseek:deepseek-flash',
  'deepseek-pro': 'deepseek:deepseek-v4-pro',
  qwen: 'alibaba:qwen4-max',
  grok: 'xai:grok-4.7',
  glm: 'zhipu:glm-5.3',
  kimi: 'moonshotai:kimi-k3.1-pro',
}

// ─── Derived views (legacy shapes kept for existing consumers) ───

/** Smart-default detection order: first provider with a key wins. This is
 *  NOT the table/display order — deepseek deliberately probes first. */
const DETECTION_ORDER = ['deepseek', 'anthropic', 'openai', 'alibaba', 'google', 'xai', 'zhipu', 'moonshotai'] as const

export const PROVIDER_DETECTION_ORDER = DETECTION_ORDER.map((name) => {
  const p = PROVIDERS.find((provider) => provider.name === name)!
  return { envKey: p.envKey, defaultModel: p.defaultModel }
})

export const PROVIDER_MODELS: Record<string, readonly ProviderModel[]> = Object.fromEntries(
  PROVIDERS.map((p) => [p.name, p.models]),
)

export const PROVIDER_KEY_URLS: Record<string, string> = Object.fromEntries(PROVIDERS.map((p) => [p.name, p.keyUrl]))

export const PROVIDER_BASE_URLS: Record<string, { options: readonly ProviderBaseUrlOption[] }> = Object.fromEntries(
  PROVIDERS.filter((p) => p.baseUrlOptions).map((p) => [p.name, { options: p.baseUrlOptions! }]),
)

export const PROVIDER_REASONING_PROFILES: Record<string, readonly ReasoningTierProfile[]> = Object.fromEntries(
  PROVIDERS.filter((p) => p.reasoningTiers).map((p) => [p.name, p.reasoningTiers!]),
)

/** Legacy provider-wide view retained for public API compatibility. Internal
 * model selection uses PROVIDER_REASONING_PROFILES so each family gets only
 * the effort values it actually supports. */
export const PROVIDER_REASONING_TIERS: Record<
  string,
  { modelPattern?: RegExp; options: readonly ReasoningTierOption[] }
> = Object.fromEntries(
  Object.entries(PROVIDER_REASONING_PROFILES).map(([name, profiles]) => {
    const options = Array.from(
      new Map(profiles.flatMap((profile) => profile.options).map((option) => [option.value, option])).values(),
    )
    const patterns = profiles.map((profile) => profile.modelPattern).filter((pattern) => pattern !== undefined)
    const modelPattern =
      patterns.length === profiles.length ? new RegExp(patterns.map((pattern) => pattern.source).join('|')) : undefined
    return [name, { ...(modelPattern ? { modelPattern } : {}), options }]
  }),
)
