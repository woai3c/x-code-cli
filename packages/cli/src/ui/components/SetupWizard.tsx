// @x-code/cli — First-use setup wizard (choose provider → enter key → choose model)

import React, { useState } from 'react'

import { Box, Text, useInput } from 'ink'

import { saveConfig, PROVIDER_KEY_URLS } from '@x-code/core'
import type { AppConfig } from '@x-code/core'

interface SetupWizardProps {
  onComplete: (config: AppConfig, modelId: string) => void
}

const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic (Claude)', envKey: 'ANTHROPIC_API_KEY' },
  { id: 'openai', name: 'OpenAI (GPT)', envKey: 'OPENAI_API_KEY' },
  { id: 'google', name: 'Google (Gemini)', envKey: 'GOOGLE_GENERATIVE_AI_API_KEY' },
  { id: 'xai', name: 'xAI (Grok)', envKey: 'XAI_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY' },
  { id: 'alibaba', name: 'Alibaba Qwen (通义千问)', envKey: 'ALIBABA_API_KEY' },
  { id: 'zhipu', name: 'Zhipu AI (智谱 GLM)', envKey: 'ZHIPU_API_KEY' },
  { id: 'moonshotai', name: 'Moonshot AI (Kimi)', envKey: 'MOONSHOT_API_KEY' },
  { id: 'custom', name: 'Custom OpenAI Compatible', envKey: 'OPENAI_COMPATIBLE_API_KEY' },
]

const DEFAULT_MODELS: Record<string, { models: string[]; default: string }> = {
  anthropic: { models: ['claude-sonnet-4-5', 'claude-opus-4-6', 'claude-haiku-4-5'], default: 'claude-sonnet-4-5' },
  openai: { models: ['gpt-4.1', 'gpt-4.1-mini', 'o3'], default: 'gpt-4.1' },
  google: { models: ['gemini-2.5-pro', 'gemini-2.5-flash'], default: 'gemini-2.5-pro' },
  xai: { models: ['grok-3'], default: 'grok-3' },
  deepseek: { models: ['deepseek-chat', 'deepseek-reasoner'], default: 'deepseek-chat' },
  alibaba: { models: ['qwen-max', 'qwen-plus'], default: 'qwen-max' },
  zhipu: { models: ['glm-4-plus', 'glm-4-flash'], default: 'glm-4-plus' },
  moonshotai: { models: ['kimi-k2.5', 'moonshot-v1-128k'], default: 'kimi-k2.5' },
}

type Step = 'provider' | 'apiKey' | 'baseUrl' | 'model' | 'modelName'

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>('provider')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [provider, setProvider] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelName, setModelName] = useState('')

  useInput((input, key) => {
    // Provider selection
    if (step === 'provider') {
      if (key.upArrow) setSelectedIdx((p) => Math.max(0, p - 1))
      else if (key.downArrow) setSelectedIdx((p) => Math.min(PROVIDERS.length - 1, p + 1))
      else if (key.return) {
        setProvider(PROVIDERS[selectedIdx].id)
        setStep('apiKey')
        setSelectedIdx(0)
      }
      return
    }

    // API key input
    if (step === 'apiKey') {
      if (key.return && apiKey.trim()) {
        if (provider === 'custom') {
          setStep('baseUrl')
        } else {
          setStep('model')
        }
        return
      }
      if (key.backspace || key.delete) {
        setApiKey((p) => p.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setApiKey((p) => p + input)
      }
      return
    }

    // Base URL input (custom provider)
    if (step === 'baseUrl') {
      if (key.return && baseUrl.trim()) {
        setStep('modelName')
        return
      }
      if (key.backspace || key.delete) {
        setBaseUrl((p) => p.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setBaseUrl((p) => p + input)
      }
      return
    }

    // Model name input (custom provider)
    if (step === 'modelName') {
      if (key.return && modelName.trim()) {
        finishSetup(`custom:${modelName}`)
        return
      }
      if (key.backspace || key.delete) {
        setModelName((p) => p.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setModelName((p) => p + input)
      }
      return
    }

    // Model selection
    if (step === 'model') {
      const models = DEFAULT_MODELS[provider]?.models ?? []
      if (key.upArrow) setSelectedIdx((p) => Math.max(0, p - 1))
      else if (key.downArrow) setSelectedIdx((p) => Math.min(models.length - 1, p + 1))
      else if (key.return) {
        const chosen = models[selectedIdx]
        finishSetup(`${provider}:${chosen}`)
      }
    }
  })

  async function finishSetup(modelId: string) {
    const config: AppConfig = {
      model: modelId,
      providers: {
        [provider]: provider === 'custom'
          ? { apiKey, baseURL: baseUrl, name: 'custom' }
          : { apiKey },
      },
    }
    await saveConfig(config)
    onComplete(config, modelId)
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} paddingY={1}>
      <Text color="green" bold>Welcome to X-Code!</Text>
      <Text />

      {step === 'provider' && (
        <>
          <Text>No API Key detected. Please choose a provider:</Text>
          <Text />
          {PROVIDERS.map((p, i) => (
            <Text key={p.id} color={i === selectedIdx ? 'cyan' : undefined}>
              {i === selectedIdx ? '> ' : '  '}{p.name}
            </Text>
          ))}
          <Text />
          <Text dimColor>↑↓ Navigate  Enter Select</Text>
        </>
      )}

      {step === 'apiKey' && (
        <>
          <Text>Enter your {PROVIDERS.find((p) => p.id === provider)?.name} API Key:</Text>
          {PROVIDER_KEY_URLS[provider] && (
            <Text dimColor>Get key: {PROVIDER_KEY_URLS[provider]}</Text>
          )}
          <Text />
          <Box>
            <Text color="cyan">{'> '}</Text>
            <Text>{apiKey ? '•'.repeat(apiKey.length) : ''}</Text>
            <Text dimColor>█</Text>
          </Box>
        </>
      )}

      {step === 'baseUrl' && (
        <>
          <Text>Enter the API base URL:</Text>
          <Box>
            <Text color="cyan">{'> '}</Text>
            <Text>{baseUrl}</Text>
            <Text dimColor>█</Text>
          </Box>
        </>
      )}

      {step === 'modelName' && (
        <>
          <Text>Enter the model name:</Text>
          <Box>
            <Text color="cyan">{'> '}</Text>
            <Text>{modelName}</Text>
            <Text dimColor>█</Text>
          </Box>
        </>
      )}

      {step === 'model' && (
        <>
          <Text>Choose default model:</Text>
          <Text />
          {(DEFAULT_MODELS[provider]?.models ?? []).map((m, i) => (
            <Text key={m} color={i === selectedIdx ? 'cyan' : undefined}>
              {i === selectedIdx ? '> ' : '  '}{m}
              {m === DEFAULT_MODELS[provider]?.default ? ' (recommended)' : ''}
            </Text>
          ))}
          <Text />
          <Text dimColor>↑↓ Navigate  Enter Select</Text>
        </>
      )}
    </Box>
  )
}
