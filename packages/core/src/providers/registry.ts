// @x-code/core — AI SDK Provider Registry (multi-model support)

import { createProviderRegistry } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { google } from '@ai-sdk/google'
import { xai } from '@ai-sdk/xai'
import { deepseek } from '@ai-sdk/deepseek'
import { createAlibaba } from '@ai-sdk/alibaba'
import { moonshotai } from '@ai-sdk/moonshotai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { zhipu } from 'zhipu-ai-provider'

import { getProviderOptions } from '../config/index.js'

export function createModelRegistry() {
  const opts = getProviderOptions()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: Record<string, any> = {}

  if (opts.anthropic) providers.anthropic = anthropic
  if (opts.openai) providers.openai = createOpenAI()
  if (opts.google) providers.google = google
  if (opts.xai) providers.xai = xai
  if (opts.deepseek) providers.deepseek = deepseek
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
