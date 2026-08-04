import type { LanguageModel, LanguageModelUsage } from 'ai'
import { NoObjectGeneratedError, NoOutputGeneratedError, Output, generateText } from 'ai'

import { z } from 'zod'

import type { MemoryReasoningMode } from '../config/index.js'
import { providerOf } from '../providers/capabilities.js'
import { getReasoningLevel, getThinkingProviderOptions } from '../providers/thinking.js'
import { debugLog } from '../utils.js'

export type MemoryReasoningControl = 'off' | 'low' | 'provider-default'

export interface MemoryInferenceSettings {
  maxOutputTokens: number
  reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  providerOptions?: Record<string, Record<string, unknown>>
  temperature?: number
}

interface RunMemoryInferenceInput<T> {
  modelId?: string
  reasoningMode?: MemoryReasoningMode
  maxOutputTokens: number
  maxTotalOutputTokens?: number
  retryStructuredOutput?: boolean
  generate(settings: MemoryInferenceSettings): Promise<T>
}

const rejectedControls = new Map<string, Set<MemoryReasoningControl>>()
const rejectedTemperature = new Set<string>()

export async function runMemoryInference<T>(input: RunMemoryInferenceInput<T>): Promise<T> {
  const modelId = input.modelId
  const controls = reasoningControls(modelId, input.reasoningMode ?? 'auto')
  const budgets =
    input.retryStructuredOutput === false
      ? [input.maxOutputTokens]
      : outputBudgetSteps(input.maxOutputTokens, input.maxTotalOutputTokens ?? input.maxOutputTokens)
  let controlIndex = 0
  let budgetIndex = 0
  let omitTemperature = Boolean(modelId && rejectedTemperature.has(modelId))

  while (true) {
    const control = controls[controlIndex] ?? 'provider-default'
    const settings = inferenceSettings(modelId, control, budgets[budgetIndex]!, omitTemperature)
    try {
      const result = await input.generate(settings)
      observeSuccessfulResult(modelId, control, result)
      return result
    } catch (error) {
      if (modelId && settings.temperature !== undefined && rejectsParameter(error, ['temperature'])) {
        rejectedTemperature.add(modelId)
        omitTemperature = true
        debugLog('memory-inference.fallback', `${modelId}: omit unsupported temperature`)
        continue
      }
      if (
        modelId &&
        control !== 'provider-default' &&
        rejectsParameter(error, [
          'reasoning',
          'reasoning_effort',
          'thinking',
          'thinking_level',
          'thinkinglevel',
          'thinking_budget',
          'thinkingbudget',
          'enable_thinking',
          'enablethinking',
        ])
      ) {
        rejectControl(modelId, control)
        controlIndex += 1
        debugLog('memory-inference.fallback', `${modelId}: ${control} unsupported, trying ${controls[controlIndex]}`)
        continue
      }
      if (input.retryStructuredOutput !== false && isRetryableStructuredOutputError(error)) {
        if (NoObjectGeneratedError.isInstance(error) && error.finishReason === 'content-filter') throw error
        if (budgetIndex + 1 < budgets.length) {
          budgetIndex += 1
          debugLog(
            'memory-inference.fallback',
            `${modelId ?? 'unknown'}: raise output budget to ${budgets[budgetIndex]}`,
          )
          continue
        }
      }
      throw error
    }
  }
}

export function outputBudgetSteps(base: number, maximum: number): number[] {
  const first = Math.max(1, Math.min(base, maximum))
  const limit = Math.max(first, maximum)
  const middle = Math.min(limit, Math.max(first * 2, 4096))
  return [...new Set([first, middle, limit])].sort((a, b) => a - b)
}

export function reasoningControls(modelId: string | undefined, mode: MemoryReasoningMode): MemoryReasoningControl[] {
  const requested: MemoryReasoningControl[] =
    mode === 'provider-default'
      ? ['provider-default']
      : mode === 'low'
        ? ['low', 'provider-default']
        : mode === 'off'
          ? ['off', 'low', 'provider-default']
          : modelId && requiresThinking(modelId)
            ? ['low', 'provider-default']
            : modelId && providerOf(modelId) === 'custom'
              ? ['provider-default']
              : ['off', 'low', 'provider-default']
  if (!modelId) return ['provider-default']
  const rejected = rejectedControls.get(modelId)
  const remaining = requested.filter((control) => !rejected?.has(control))
  return remaining.length ? remaining : ['provider-default']
}

export function resetMemoryInferenceState(): void {
  rejectedControls.clear()
  rejectedTemperature.clear()
}

/** Shared structured-output generateText wrapper used by the extractor and
 *  the selector. Inference settings from runMemoryInference are spread last
 *  so budget/reasoning fallbacks always win over call-site defaults. */
export function generateStructuredObject(input: {
  model: LanguageModel
  instructions: string
  payload: unknown
  outputName: string
  outputDescription: string
  outputSchema: z.ZodType<unknown>
  maxRetries: number
  abortSignal?: AbortSignal
}): (settings: MemoryInferenceSettings) => Promise<{ output: unknown; usage: LanguageModelUsage }> {
  return async ({ providerOptions, ...settings }) => {
    const result = await generateText({
      model: input.model,
      instructions: input.instructions,
      prompt: JSON.stringify(input.payload),
      output: Output.object({
        schema: input.outputSchema,
        name: input.outputName,
        description: input.outputDescription,
      }),
      maxRetries: input.maxRetries,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...settings,
      ...(providerOptions
        ? { providerOptions: providerOptions as Parameters<typeof generateText>[0]['providerOptions'] }
        : {}),
    })
    return result as { output: unknown; usage: LanguageModelUsage }
  }
}

function inferenceSettings(
  modelId: string | undefined,
  control: MemoryReasoningControl,
  maxOutputTokens: number,
  omitTemperature: boolean,
): MemoryInferenceSettings {
  if (!modelId || control === 'provider-default') return { maxOutputTokens }
  if (control === 'off') {
    const reasoning = getReasoningLevel(modelId, false)
    const providerOptions = getThinkingProviderOptions(modelId, false)
    return {
      maxOutputTokens,
      ...(reasoning && reasoning !== 'provider-default' ? { reasoning } : {}),
      ...(Object.keys(providerOptions).length ? { providerOptions } : {}),
      ...(!omitTemperature ? { temperature: 0 } : {}),
    }
  }
  const provider = providerOf(modelId)
  if (provider === 'alibaba' || provider === 'zhipu') {
    const providerOptions = getThinkingProviderOptions(modelId, true)
    return { maxOutputTokens, ...(Object.keys(providerOptions).length ? { providerOptions } : {}) }
  }
  if (provider === 'custom') return { maxOutputTokens }
  return { maxOutputTokens, reasoning: 'low' }
}

function requiresThinking(modelId: string): boolean {
  const normalized = modelId.toLowerCase()
  const provider = providerOf(normalized)
  if (provider === 'google') return /gemini-(?:2\.5-pro|3(?:[.\-]|$))/.test(normalized)
  if (provider === 'deepseek') return /(?:^|:)deepseek-reasoner(?:$|[-.])/.test(normalized)
  if (provider === 'openai') return /(?:^|:)(?:gpt-5-pro|o[134])(?:$|[-.])/.test(normalized)
  return provider === 'anthropic' && /claude-opus-4-5/.test(normalized)
}

function rejectControl(modelId: string, control: MemoryReasoningControl): void {
  const rejected = rejectedControls.get(modelId) ?? new Set<MemoryReasoningControl>()
  rejected.add(control)
  rejectedControls.set(modelId, rejected)
}

function observeSuccessfulResult(modelId: string | undefined, control: MemoryReasoningControl, result: unknown): void {
  if (!modelId || control !== 'off' || !result || typeof result !== 'object') return
  const usage = (result as { usage?: LanguageModelUsage }).usage
  if (Number(usage?.outputTokenDetails?.reasoningTokens ?? 0) > 0) {
    rejectControl(modelId, control)
    debugLog('memory-inference.detected', `${modelId}: reasoning remained active after off request`)
  }
}

function isRetryableStructuredOutputError(error: unknown): boolean {
  if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)) return true
  if (!(error instanceof Error)) return false
  return error.name === 'AI_NoObjectGeneratedError' || error.name === 'AI_NoOutputGeneratedError'
}

function rejectsParameter(error: unknown, parameters: readonly string[]): boolean {
  const message = errorMessages(error).join('\n').toLowerCase()
  if (!parameters.some((parameter) => message.includes(parameter))) return false
  return /(?:unsupported|not support|does not support|invalid|unknown|unrecognized|not allowed|not permitted|cannot|must be|expected|only supports?|extra inputs?)/i.test(
    message,
  )
}

function errorMessages(error: unknown): string[] {
  const messages: string[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number) => {
    if (value === null || value === undefined || depth > 5 || seen.has(value)) return
    if (typeof value === 'string') {
      messages.push(value)
      return
    }
    if (typeof value !== 'object') return
    seen.add(value)
    const record = value as Record<string, unknown>
    if (value instanceof Error) messages.push(value.message)
    for (const key of ['responseBody', 'lastError', 'cause', 'errors', 'data']) {
      const nested = record[key]
      if (Array.isArray(nested)) for (const item of nested) visit(item, depth + 1)
      else visit(nested, depth + 1)
    }
  }
  visit(error, 0)
  return messages
}
