// @x-code/core — Model pricing table and cost estimation

/** Price per million tokens */
interface ModelPrice {
  input: number
  output: number
  currency: 'USD' | 'CNY'
}

const MODEL_PRICING: Record<string, ModelPrice> = {
  // ── USD providers ──

  // Anthropic
  'anthropic:claude-opus-4-6': { input: 15, output: 75, currency: 'USD' },
  'anthropic:claude-sonnet-4-5': { input: 3, output: 15, currency: 'USD' },
  'anthropic:claude-haiku-4-5': { input: 0.8, output: 4, currency: 'USD' },
  // OpenAI
  'openai:gpt-4.1': { input: 2, output: 8, currency: 'USD' },
  'openai:gpt-4.1-mini': { input: 0.4, output: 1.6, currency: 'USD' },
  'openai:gpt-4.1-nano': { input: 0.1, output: 0.4, currency: 'USD' },
  'openai:o3': { input: 2, output: 8, currency: 'USD' },
  'openai:o4-mini': { input: 1.1, output: 4.4, currency: 'USD' },
  // Google
  'google:gemini-2.5-pro': { input: 1.25, output: 10, currency: 'USD' },
  'google:gemini-2.5-flash': { input: 0.15, output: 0.6, currency: 'USD' },
  // xAI
  'xai:grok-3': { input: 3, output: 15, currency: 'USD' },
  'xai:grok-3-mini': { input: 0.3, output: 0.5, currency: 'USD' },

  // ── CNY (人民币) providers ──

  // DeepSeek (api.deepseek.com, V3.2 统一定价, 人民币)
  'deepseek:deepseek-chat': { input: 2, output: 3, currency: 'CNY' },
  'deepseek:deepseek-reasoner': { input: 2, output: 3, currency: 'CNY' },
  // Alibaba / 阿里云百炼 (dashscope.aliyuncs.com, 中国内地定价)
  'alibaba:qwen-max': { input: 2.4, output: 9.6, currency: 'CNY' },
  'alibaba:qwen-plus': { input: 0.8, output: 2, currency: 'CNY' },
  // Zhipu / 智谱 (bigmodel.cn)
  'zhipu:glm-4-plus': { input: 5, output: 5, currency: 'CNY' },
  // Moonshot / 月之暗面 (platform.moonshot.cn, 人民币)
  'moonshotai:kimi-k2.5': { input: 4, output: 16, currency: 'CNY' },
}

export interface CostEstimate {
  cost: number
  currency: 'USD' | 'CNY'
}

/** Estimate cost from model ID and token counts. Returns cost and currency. */
export function estimateCost(modelId: string, inputTokens: number, outputTokens: number): CostEstimate {
  const pricing = MODEL_PRICING[modelId]
  if (!pricing) return { cost: 0, currency: 'USD' }
  const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
  return { cost, currency: pricing.currency }
}

/** Format cost string with currency symbol */
export function formatCost(estimate: CostEstimate): string {
  if (estimate.cost <= 0) return ''
  const symbol = estimate.currency === 'CNY' ? '¥' : '$'
  return `${symbol}${estimate.cost.toFixed(4)}`
}
