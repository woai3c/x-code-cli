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
   *  not listed here. Vision flags reflect model FAMILY: Claude / GPT /
   *  Gemini / Grok flagships, DeepSeek Flash, and Kimi K2.x are multimodal;
   *  Qwen-Max / GLM text flagships and DeepSeek V4 Pro are text-only; the
   *  dedicated *-VL / GLM-4V / *-vision-preview models see images. */
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
   *  (e.g. thinkingLevel is Gemini 3-only, Kimi's reasoningEffort is
   *  K3-only). Models that don't match fall back to the binary /thinking
   *  toggle. */
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
    defaultModel: 'anthropic:claude-sonnet-5',
    keyUrl: 'https://console.anthropic.com/',
    models: [
      {
        id: 'anthropic:claude-fable-5-1',
        label: 'Fable 5.1',
        description: 'Newest adaptive-reasoning flagship, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-opus-5',
        label: 'Opus 5',
        description: 'Latest Opus for complex reasoning and agentic coding, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-fable-5',
        label: 'Fable 5',
        description: 'Most capable model, strongest reasoning + agentic, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-opus-4-8',
        label: 'Opus 4.8',
        description: 'Top Opus-tier, complex reasoning + agentic coding, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-sonnet-5',
        label: 'Sonnet 5',
        description: 'Best balance, near-Opus coding at $3/$15, 1M context',
        vision: true,
      },
      {
        id: 'anthropic:claude-haiku-4-5',
        label: 'Haiku 4.5',
        description: 'Fastest, cheapest — $1/$5, shorter replies',
        vision: true,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /claude-fable-5(?:-1)?$/,
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
        modelPattern: /claude-(?:opus-(?:5|4-8)|sonnet-5)$/,
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
    defaultModel: 'openai:gpt-5.6-sol',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      {
        id: 'openai:gpt-6-astra',
        label: 'GPT-6 Astra',
        description: 'Newest flagship, 1.05M context and 128k output',
        vision: true,
      },
      {
        id: 'openai:gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        description: 'Flagship reasoning and coding tier, $4/$20, 1M context',
        vision: true,
      },
      {
        id: 'openai:gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
        description: 'Balanced tier, $2/$12, 1M context',
        vision: true,
      },
      {
        id: 'openai:gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        description: 'Budget tier, $0.20/$1.20, 1M context',
        vision: true,
      },
      {
        id: 'openai:gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        description: 'Cheap mini model, $0.75/$4.50',
        vision: true,
      },
      {
        id: 'openai:gpt-5.4-nano',
        label: 'GPT-5.4 Nano',
        description: 'Cheapest, $0.20/$1.25',
        vision: true,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /gpt-6-astra$/,
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
        modelPattern: /gpt-5\.6(?:-(?:sol|terra|luna))?$/,
        options: [
          { label: 'Low', value: 'low', description: 'Fast, concise reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Very deep reasoning' },
          { label: 'Max', value: 'max', description: 'Maximum reasoning depth' },
        ],
      },
      {
        modelPattern: /gpt-5\.5$/,
        options: [
          { label: 'Low', value: 'low', description: 'Fast, concise reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Maximum reasoning depth' },
        ],
      },
      {
        modelPattern: /gpt-5\.4-(?:mini|nano)$/,
        options: [
          { label: 'Low', value: 'low', description: 'Fast, concise reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced (default)' },
          { label: 'High', value: 'high', description: 'Thorough reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Maximum reasoning depth' },
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
    defaultModel: 'alibaba:qwen3.8-max',
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    models: [
      {
        id: 'alibaba:qwen3.8-max',
        label: 'Qwen3.8 Max',
        description: 'Newest flagship with native vision, 1M context',
        vision: true,
      },
      {
        id: 'alibaba:qwen3.8-flash',
        label: 'Qwen3.8 Flash',
        description: 'Fast multimodal model with 1M context',
        vision: true,
      },
      {
        id: 'alibaba:qwen3.7-max',
        label: 'Qwen3.7 Max',
        description: 'Latest flagship, 1M context, reasoning-native',
        vision: false,
      },
      {
        id: 'alibaba:qwen3.7-plus',
        label: 'Qwen3.7 Plus',
        description: 'Multimodal mid-tier with 1M context',
        vision: true,
      },
      {
        id: 'alibaba:qwen3.7-flash',
        label: 'Qwen3.7 Flash',
        description: 'Fast multimodal model with 1M context',
        vision: true,
      },
      {
        id: 'alibaba:qwen3-coder-plus',
        label: 'Qwen3 Coder Plus',
        description: 'Coding-focused, 1M context',
        vision: false,
      },
      {
        id: 'alibaba:qwq-plus',
        label: 'QwQ Plus',
        description: 'Dedicated reasoning model',
        vision: false,
      },
      {
        id: 'alibaba:qwen3-vl-plus',
        label: 'Qwen3-VL Plus',
        description: 'Vision-language flagship',
        vision: true,
      },
      {
        id: 'alibaba:qwen3-vl-flash',
        label: 'Qwen3-VL Flash',
        description: 'Cheap/fast vision-language model',
        vision: true,
      },
    ],
  },
  {
    name: 'google',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    defaultModel: 'google:gemini-3.8-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      {
        id: 'google:gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        description: 'Newest multimodal flagship, 1M context and 64k output',
        vision: true,
      },
      {
        id: 'google:gemini-3.7-flash',
        label: 'Gemini 3.7 Flash',
        description: 'Previous-generation multimodal agentic model, 1M context',
        vision: true,
      },
      {
        id: 'google:gemini-3.6-flash',
        label: 'Gemini 3.6 Flash',
        description: 'Fast multimodal agentic model, 1M context',
        vision: true,
      },
      {
        id: 'google:gemini-3.5-flash',
        label: 'Gemini 3.5 Flash',
        description: 'Latest flagship, agentic + coding, 1M context',
        vision: true,
      },
      {
        id: 'google:gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
        description: '1M context, strong long-doc handling',
        vision: true,
      },
      {
        id: 'google:gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        description: 'Cheaper/faster tier, 1M context',
        vision: true,
      },
    ],
    reasoningTiers: [
      {
        modelPattern: /gemini-3\.[78]-flash$/,
        offValue: 'low',
        options: [
          { label: 'Low', value: 'low', description: 'Minimum supported reasoning' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning, higher quality' },
        ],
      },
      {
        modelPattern: /gemini-3\.[56]-flash$/,
        offValue: 'minimal',
        options: [
          { label: 'Minimal', value: 'minimal', description: 'Minimum supported reasoning' },
          { label: 'Low', value: 'low', description: 'Lower latency, lower cost' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning, higher quality' },
        ],
      },
    ],
  },
  {
    name: 'xai',
    envKey: 'XAI_API_KEY',
    defaultModel: 'xai:grok-4.6',
    keyUrl: 'https://console.x.ai/',
    models: [
      {
        id: 'xai:grok-4.6',
        label: 'Grok 4.6',
        description: 'Recommended flagship, native vision and 500k context',
        vision: true,
      },
      {
        id: 'xai:grok-4.20',
        label: 'Grok 4.20',
        description: 'Fixed-reasoning model with native vision and 1M context',
        vision: true,
      },
      {
        id: 'xai:grok-4.20-non-reasoning',
        label: 'Grok 4.20 Non-Reasoning',
        description: 'Low-latency non-reasoning variant with 1M context',
        vision: true,
      },
      {
        id: 'xai:grok-4.5',
        label: 'Grok 4.5',
        description: 'Flagship, agentic coding, $2/$6, 500k context',
        vision: true,
      },
      {
        id: 'xai:grok-4.3',
        label: 'Grok 4.3',
        description: 'General-purpose, $1.25/$2.50, 1M context',
        vision: true,
      },
    ],
    reasoningTiers: [
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
      {
        modelPattern: /grok-4\.3$/,
        options: [
          { label: 'Low', value: 'low', description: 'Faster, cheaper responses' },
          { label: 'Medium', value: 'medium', description: 'Balanced reasoning' },
          { label: 'High', value: 'high', description: 'Deeper reasoning' },
          { label: 'XHigh', value: 'xhigh', description: 'Maximum supported reasoning' },
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
        description: 'Newest reasoning flagship with 1M context',
        vision: false,
      },
      {
        id: 'zhipu:glm-5.3-flash',
        label: 'GLM-5.3 Flash',
        description: 'Fast native-multimodal model with 1M context',
        vision: true,
      },
      {
        id: 'zhipu:glm-5.2',
        label: 'GLM-5.2',
        description: 'Latest flagship, $1.40/$4.40, 1M context',
        vision: false,
      },
      {
        id: 'zhipu:glm-5',
        label: 'GLM-5',
        description: 'Agentic engineering model, $1/$3.20, 200k context',
        vision: false,
      },
      {
        id: 'zhipu:glm-4.7',
        label: 'GLM-4.7',
        description: 'Cost-efficient, $0.60/$2.20, 128k context',
        vision: false,
      },
      {
        id: 'zhipu:glm-5v-turbo',
        label: 'GLM-5V Turbo',
        description: 'Vision model, $1.20/$4',
        vision: true,
      },
      {
        id: 'zhipu:glm-4.6v',
        label: 'GLM-4.6V',
        description: 'Cheap vision model, $0.30/$0.90',
        vision: true,
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
      {
        modelPattern: /glm-5\.2$/,
        options: [
          { label: 'High', value: 'high', description: 'Enhanced reasoning' },
          { label: 'Max', value: 'max', description: 'Deep reasoning (default)' },
        ],
      },
    ],
  },
  {
    name: 'moonshotai',
    envKey: 'MOONSHOT_API_KEY',
    defaultModel: 'moonshotai:kimi-k3',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    models: [
      {
        id: 'moonshotai:kimi-k3',
        label: 'Kimi K3',
        description: 'Flagship, 2.8T params, 1M context, native multimodal',
        vision: true,
      },
      {
        id: 'moonshotai:kimi-k2.7-code',
        label: 'Kimi K2.7 Code',
        description: 'Dedicated coding model, 256k context',
        vision: true,
      },
      {
        id: 'moonshotai:kimi-k2.7-code-highspeed',
        label: 'Kimi K2.7 Code Highspeed',
        description: 'High-speed coding variant, 256k context',
        vision: true,
      },
      {
        id: 'moonshotai:kimi-k2.6',
        label: 'Kimi K2.6',
        description: 'Multimodal general-purpose, 256k context',
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
        // reasoning_effort is K3-only; K2.x uses the binary thinking switch.
        modelPattern: /kimi-k3/,
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
  fable: 'anthropic:claude-fable-5-1',
  sonnet: 'anthropic:claude-sonnet-5',
  opus: 'anthropic:claude-opus-5',
  haiku: 'anthropic:claude-haiku-4-5',
  gpt6: 'openai:gpt-6-astra',
  astra: 'openai:gpt-6-astra',
  gpt5: 'openai:gpt-5.6-sol',
  gemini: 'google:gemini-3.8-flash',
  deepseek: 'deepseek:deepseek-flash',
  'deepseek-pro': 'deepseek:deepseek-v4-pro',
  qwen: 'alibaba:qwen3.8-max',
  grok: 'xai:grok-4.6',
  glm: 'zhipu:glm-5.3',
  kimi: 'moonshotai:kimi-k3',
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
