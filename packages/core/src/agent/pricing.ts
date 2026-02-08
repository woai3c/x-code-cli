// @x-code/core — Model pricing table and cost estimation

/** Price per million tokens (USD) */
interface ModelPrice {
  input: number
  output: number
}

const MODEL_PRICING: Record<string, ModelPrice> = {
  // Anthropic
  'anthropic:claude-opus-4-6': { input: 15, output: 75 },
  'anthropic:claude-sonnet-4-5': { input: 3, output: 15 },
  'anthropic:claude-haiku-4-5': { input: 0.8, output: 4 },
  // OpenAI
  'openai:gpt-4.1': { input: 2, output: 8 },
  'openai:gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'openai:gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'openai:o3': { input: 2, output: 8 },
  'openai:o4-mini': { input: 1.1, output: 4.4 },
  // Google
  'google:gemini-2.5-pro': { input: 1.25, output: 10 },
  'google:gemini-2.5-flash': { input: 0.15, output: 0.6 },
  // DeepSeek
  'deepseek:deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek:deepseek-reasoner': { input: 0.55, output: 2.19 },
  // xAI
  'xai:grok-3': { input: 3, output: 15 },
  'xai:grok-3-mini': { input: 0.3, output: 0.5 },
  // Alibaba
  'alibaba:qwen-max': { input: 1.6, output: 6.4 },
  'alibaba:qwen-plus': { input: 0.8, output: 2 },
  // Zhipu
  'zhipu:glm-4-plus': { input: 0.7, output: 0.7 },
  // Moonshot
  'moonshotai:kimi-k2.5': { input: 2, output: 6 },
}

/** Estimate cost in USD from model ID and token counts */
export function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[modelId]
  if (!pricing) return 0
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
}
