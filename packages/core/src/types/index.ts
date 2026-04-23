// @x-code-cli/core — Public type definitions
import type { LanguageModel, ModelMessage } from 'ai'

// ─── Permission ───

export type PermissionLevel = 'always-allow' | 'ask' | 'deny'

// ─── Token usage ───

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

// ─── Display messages ───

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: DisplayToolCall[]
  timestamp: number
  /** True for assistant text chunks emitted mid-stream (one per newline).
   *  Rendered WITHOUT the trailing blank line that regular messages append,
   *  so consecutive chunks join into a single paragraph visually. Keeps
   *  streaming text out of the bottom cell buffer (avoids row-shift jitter)
   *  by sending each complete line directly to scrollback. */
  streamingChunk?: boolean
  /** Compact slash-command rendering, matching Claude Code's 2-line block:
   *    > /model
   *      ⎿  Set model to Sonnet 4.6
   *  'command-echo' (user role) drops the trailing blank that regular user
   *  messages append; 'command-result' (assistant role) renders with the
   *  ⎿ prefix and a single trailing newline instead of markdown + \n\n.
   *  Used only for short, single-line command responses. Long multi-line
   *  output (/help, /usage) keeps the regular assistant-message path. */
  kind?: 'command-echo' | 'command-result'
}

export interface DisplayToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  output?: string
  status: 'pending' | 'running' | 'completed' | 'denied'
  /** How long the tool call took to execute (milliseconds) */
  durationMs?: number
}

// ─── Agent callbacks (core → UI bridge) ───

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onToolCall: (toolCallId: string, toolName: string, input: Record<string, unknown>) => void
  /** Streamed progress messages emitted by a tool while it runs (e.g.
   *  "Searching: query" → "Found 5 results"). Only the LATEST message is
   *  shown in the live UI; the final summary comes through onToolResult. */
  onToolProgress: (toolCallId: string, message: string) => void
  onToolResult: (toolCallId: string, result: string) => void
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }) => Promise<boolean>
  onAskUser: (question: string, options: { label: string; description: string }[]) => Promise<string>
  onShellOutput: (chunk: string) => void
  onUsageUpdate: (usage: TokenUsage) => void
  onContextCompressed: (summary: string) => void
  onError: (error: Error) => void
}

// ─── Agent options ───

export interface AgentOptions {
  modelId: string
  trustMode: boolean
  maxTurns: number
  printMode: boolean
  systemPromptExtra?: string
  abortSignal?: AbortSignal
}

// ─── Knowledge ───

/**
 * Category taxonomy for auto memory entries. Categories describe the TYPE of
 * knowledge (who it's about, how it was learned) rather than the topic —
 * this mirrors the taxonomy Claude Code uses and produces sharper memories
 * because each category has distinct trigger conditions for the agent.
 *
 * - user:      Facts about the human user — role, expertise, goals, constraints
 * - feedback:  Corrections or validated approaches ("don't mock the db", "yes, that was right")
 * - project:   Ongoing work, initiatives, decisions, non-obvious project state
 * - reference: Pointers to external systems (Linear project, Grafana dashboard, etc.)
 */
export type KnowledgeCategory = 'user' | 'feedback' | 'project' | 'reference'

export interface KnowledgeFact {
  key: string
  fact: string
  category: KnowledgeCategory
  date: string
}

export interface SessionSummary {
  id: string
  title: string
  startedAt: string
  endedAt: string
  status: 'completed' | 'in_progress' | 'abandoned'
  summary: string
  keyResults: string[]
  pendingWork: string[]
  filesModified: string[]
  decisions: string[]
}

// ─── Model aliases ───

export const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'anthropic:claude-sonnet-4-5',
  opus: 'anthropic:claude-opus-4-6',
  haiku: 'anthropic:claude-haiku-4-5',
  gpt4: 'openai:gpt-4.1',
  gemini: 'google:gemini-2.5-pro',
  deepseek: 'deepseek:deepseek-chat',
  r1: 'deepseek:deepseek-reasoner',
  qwen: 'alibaba:qwen-max',
  glm: 'zhipu:glm-4-plus',
  kimi: 'moonshotai:kimi-k2.5',
}

// ─── Provider detection order (for smart defaults) ───

export const PROVIDER_DETECTION_ORDER = [
  { envKey: 'ANTHROPIC_API_KEY', defaultModel: 'anthropic:claude-sonnet-4-5' },
  { envKey: 'OPENAI_API_KEY', defaultModel: 'openai:gpt-4.1' },
  { envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek:deepseek-chat' },
  { envKey: 'ALIBABA_API_KEY', defaultModel: 'alibaba:qwen-max' },
  { envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', defaultModel: 'google:gemini-2.5-pro' },
  { envKey: 'XAI_API_KEY', defaultModel: 'xai:grok-3' },
  { envKey: 'ZHIPU_API_KEY', defaultModel: 'zhipu:glm-4-plus' },
  { envKey: 'MOONSHOT_API_KEY', defaultModel: 'moonshotai:kimi-k2.5' },
] as const

// ─── Curated model catalog per provider (for interactive /model picker) ───

export interface ProviderModel {
  /** Full `<provider>:<model>` id passed to AI SDK */
  id: string
  /** Short display label shown in the picker */
  label: string
  /** One-line description shown under the label */
  description: string
}

/**
 * Hand-curated models per provider. Only models we've tested or that are
 * advertised as production-stable make the list — agents tend to pick
 * whatever is visible, so we don't dump every experimental variant here.
 * Users who need something exotic can still type the full id into
 * `/model <provider>:<model>` or pass it via `--model`.
 */
export const PROVIDER_MODELS: Record<string, readonly ProviderModel[]> = {
  anthropic: [
    {
      id: 'anthropic:claude-sonnet-4-5',
      label: 'Sonnet 4.5',
      description: 'Balanced default — good for coding + reasoning',
    },
    { id: 'anthropic:claude-opus-4-6', label: 'Opus 4.6', description: 'Most capable, slower and pricier' },
    { id: 'anthropic:claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest, cheapest — shorter replies' },
  ],
  openai: [
    { id: 'openai:gpt-4.1', label: 'GPT-4.1', description: 'General-purpose, 1M context window' },
    { id: 'openai:gpt-4.1-mini', label: 'GPT-4.1 Mini', description: 'Cheaper tier of 4.1, 1M context' },
    { id: 'openai:o3', label: 'o3', description: 'Reasoning model — slower, stronger on hard problems' },
    { id: 'openai:o4-mini', label: 'o4-mini', description: 'Smaller reasoning model' },
  ],
  deepseek: [
    { id: 'deepseek:deepseek-chat', label: 'DeepSeek V3 (chat)', description: 'General-purpose, 64k context' },
    { id: 'deepseek:deepseek-reasoner', label: 'DeepSeek R1', description: 'Reasoning model, 128k context' },
  ],
  alibaba: [
    { id: 'alibaba:qwen-max', label: 'Qwen Max', description: 'Strongest general Qwen, 128k context' },
    { id: 'alibaba:qwen-plus', label: 'Qwen Plus', description: 'Balanced cost/quality' },
    { id: 'alibaba:qwen-turbo', label: 'Qwen Turbo', description: 'Cheapest, fast' },
    { id: 'alibaba:qwen3-max', label: 'Qwen3 Max', description: 'Latest flagship' },
    { id: 'alibaba:qwen3-coder-plus', label: 'Qwen3 Coder Plus', description: 'Tuned for coding tasks' },
    { id: 'alibaba:qwq-plus', label: 'QwQ Plus', description: 'Reasoning model' },
  ],
  google: [
    { id: 'google:gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: '1M context, strong long-doc handling' },
    { id: 'google:gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Cheaper/faster tier' },
  ],
  xai: [
    { id: 'xai:grok-3', label: 'Grok 3', description: '131k context' },
    { id: 'xai:grok-3-mini', label: 'Grok 3 Mini', description: 'Smaller/cheaper variant' },
  ],
  zhipu: [{ id: 'zhipu:glm-4-plus', label: 'GLM-4 Plus', description: '128k context' }],
  moonshotai: [{ id: 'moonshotai:kimi-k2.5', label: 'Kimi K2.5', description: '131k context' }],
}

// ─── Provider API key URLs ───

export const PROVIDER_KEY_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai/',
  deepseek: 'https://platform.deepseek.com/api_keys',
  alibaba: 'https://dashscope.console.aliyun.com/apiKey',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  moonshotai: 'https://platform.moonshot.ai/console/api-keys',
}

// ─── Re-export AI SDK types ───

export type { ModelMessage, LanguageModel }
