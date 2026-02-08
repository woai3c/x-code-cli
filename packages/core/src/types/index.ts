// @x-code/core — Public type definitions

import type { ModelMessage, LanguageModel } from 'ai'

// ─── Permission ───

export type PermissionLevel = 'always-allow' | 'ask' | 'deny'

// ─── Token usage ───

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCost: number
}

// ─── Display messages ───

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: DisplayToolCall[]
  timestamp: number
}

export interface DisplayToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  output?: string
  status: 'pending' | 'running' | 'completed' | 'denied'
}

// ─── Agent callbacks (core → UI bridge) ───

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onToolCall: (toolName: string, input: Record<string, unknown>) => void
  onToolResult: (toolCallId: string, result: string) => void
  onAskPermission: (toolCall: { toolName: string; input: Record<string, unknown> }) => Promise<boolean>
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

// ─── Config ───

export interface ProviderConfig {
  apiKey: string
  baseURL?: string
  name?: string
}

export interface AppConfig {
  model?: string
  providers: Record<string, ProviderConfig>
}

// ─── Knowledge ───

export interface KnowledgeFact {
  key: string
  fact: string
  category: 'tech-stack' | 'commands' | 'conventions' | 'preferences' | 'context'
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

// ─── Rule loading modes ───

export interface RuleFrontmatter {
  alwaysApply?: boolean
  paths?: string[]
  description?: string
}

export interface RuleFile {
  filename: string
  frontmatter: RuleFrontmatter
  content: string
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
