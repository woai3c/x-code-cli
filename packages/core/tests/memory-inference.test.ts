import { NoOutputGeneratedError } from 'ai'

import {
  outputBudgetSteps,
  reasoningControls,
  resetMemoryInferenceState,
  runMemoryInference,
} from '../src/knowledge/memory/inference.js'

describe('memory inference policy', () => {
  beforeEach(() => resetMemoryInferenceState())

  it('starts ordinary models with thinking off and deterministic sampling', async () => {
    const generate = vi.fn().mockResolvedValue({ output: {} })

    await runMemoryInference({
      modelId: 'deepseek:deepseek-v4-pro',
      maxOutputTokens: 1500,
      maxTotalOutputTokens: 8192,
      generate,
    })

    expect(generate).toHaveBeenCalledWith({ maxOutputTokens: 1500, reasoning: 'none', temperature: 0 })
  })

  it('starts models that require thinking at low effort without temperature', async () => {
    const generate = vi.fn().mockResolvedValue({ output: {} })

    await runMemoryInference({
      modelId: 'google:gemini-3.5-flash',
      maxOutputTokens: 1500,
      maxTotalOutputTokens: 8192,
      generate,
    })

    expect(generate).toHaveBeenCalledWith({ maxOutputTokens: 1500, reasoning: 'low' })
  })

  it('falls back from unsupported reasoning controls and remembers the result', async () => {
    const wrapped = Object.assign(new Error('Failed after 1 attempt'), {
      lastError: new Error('reasoning_effort none is not supported by this model'),
    })
    const first = vi.fn().mockRejectedValueOnce(wrapped).mockResolvedValueOnce({ output: {} })

    await runMemoryInference({
      modelId: 'openai:gpt-5.6-sol',
      maxOutputTokens: 1500,
      maxTotalOutputTokens: 8192,
      generate: first,
    })

    expect(first).toHaveBeenNthCalledWith(1, { maxOutputTokens: 1500, reasoning: 'none', temperature: 0 })
    expect(first).toHaveBeenNthCalledWith(2, { maxOutputTokens: 1500, reasoning: 'low' })
    expect(reasoningControls('openai:gpt-5.6-sol', 'auto')).toEqual(['low', 'provider-default'])
  })

  it('learns when a provider silently keeps reasoning enabled', async () => {
    await runMemoryInference({
      modelId: 'deepseek:deepseek-v4-pro',
      maxOutputTokens: 1500,
      generate: async () => ({ usage: { outputTokenDetails: { reasoningTokens: 300 } } }),
    })

    expect(reasoningControls('deepseek:deepseek-v4-pro', 'auto')).toEqual(['low', 'provider-default'])
  })

  it('retries the same reasoning control without an unsupported temperature', async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error('temperature must be omitted for this model'))
      .mockResolvedValueOnce({ output: {} })

    await runMemoryInference({
      modelId: 'deepseek:deepseek-v4-pro',
      maxOutputTokens: 1500,
      maxTotalOutputTokens: 8192,
      generate,
    })

    expect(generate).toHaveBeenNthCalledWith(1, { maxOutputTokens: 1500, reasoning: 'none', temperature: 0 })
    expect(generate).toHaveBeenNthCalledWith(2, { maxOutputTokens: 1500, reasoning: 'none' })
  })

  it('raises only the output budget after empty structured output', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new NoOutputGeneratedError()).mockResolvedValueOnce({ output: {} })

    await runMemoryInference({
      modelId: 'deepseek:deepseek-v4-pro',
      maxOutputTokens: 1500,
      maxTotalOutputTokens: 8192,
      generate,
    })

    expect(generate).toHaveBeenNthCalledWith(1, { maxOutputTokens: 1500, reasoning: 'none', temperature: 0 })
    expect(generate).toHaveBeenNthCalledWith(2, { maxOutputTokens: 4096, reasoning: 'none', temperature: 0 })
    expect(outputBudgetSteps(1500, 8192)).toEqual([1500, 4096, 8192])
  })

  it('does not retry structured selector failures when escalation is disabled', async () => {
    const generate = vi.fn().mockRejectedValue(new NoOutputGeneratedError())

    await expect(
      runMemoryInference({
        modelId: 'google:gemini-3.5-flash',
        maxOutputTokens: 1024,
        retryStructuredOutput: false,
        generate,
      }),
    ).rejects.toThrow('No output generated')
    expect(generate).toHaveBeenCalledTimes(1)
  })
})
