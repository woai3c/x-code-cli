// @x-code-cli/core — AI SDK Provider Registry (multi-model support)
import { zhipu } from 'zhipu-ai-provider'

import { createAlibaba } from '@ai-sdk/alibaba'
import { anthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { google } from '@ai-sdk/google'
import { moonshotai } from '@ai-sdk/moonshotai'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { xai } from '@ai-sdk/xai'
import { createProviderRegistry } from 'ai'

import { getProviderOptions } from '../config/index.js'

export function createModelRegistry() {
  const opts = getProviderOptions()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: Record<string, any> = {}

  if (opts.anthropic) providers.anthropic = anthropic
  if (opts.openai) providers.openai = createOpenAI()
  if (opts.google) providers.google = google
  if (opts.xai) providers.xai = xai
  if (opts.deepseek) providers.deepseek = createDeepSeek({ fetch: deepseekReasoningFetch })
  if (opts.alibaba) {
    providers.alibaba = createAlibaba({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })
  }
  if (opts.zhipu) providers.zhipu = zhipu
  if (opts.moonshotai) providers.moonshotai = moonshotai

  // Custom OpenAI compatible provider
  if (opts.custom.apiKey && opts.custom.baseURL) {
    providers.custom = createOpenAICompatible({
      name: 'custom',
      apiKey: opts.custom.apiKey,
      baseURL: opts.custom.baseURL,
    })
  }

  return createProviderRegistry(providers)
}

/**
 * Back-fill `reasoning_content: ""` on every assistant message in the request
 * body before it reaches DeepSeek V4. The upstream `@ai-sdk/deepseek` converter
 * (convert-to-deepseek-chat-messages.ts) strips `reasoning_content` from any
 * assistant message at or before the last user message — correct for
 * deepseek-reasoner (R1), which forbids passing reasoning back, but wrong for
 * deepseek-v4-*, which *requires* it. Without this, the second turn 400s with
 * "reasoning_content in the thinking mode must be passed back to the API."
 * Scoped to v4 so R1 keeps its documented behavior. Remove once upstream
 * differentiates by model.
 */
const deepseekReasoningFetch: typeof fetch = async (input, init) => {
  if (!init?.body || typeof init.body !== 'string') return fetch(input, init)

  try {
    const body = JSON.parse(init.body) as { model?: string; messages?: Array<Record<string, unknown>> }
    if (typeof body.model === 'string' && body.model.includes('deepseek-v4') && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role === 'assistant' && msg.reasoning_content == null) {
          msg.reasoning_content = ''
        }
      }
      return fetch(input, { ...init, body: JSON.stringify(body) })
    }
  } catch {
    // Body wasn't JSON we recognize — pass through unchanged.
  }

  return fetch(input, init)
}
