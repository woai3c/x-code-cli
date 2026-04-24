// Tests for providers/cache-control.ts
import { describe, expect, it } from 'vitest'

import type { ModelMessage } from 'ai'

import { applyCacheControl } from '../src/providers/cache-control.js'

function msg(role: 'user' | 'assistant', text: string): ModelMessage {
  return { role, content: text } as ModelMessage
}

describe('applyCacheControl', () => {
  const baseMessages: ModelMessage[] = [msg('user', 'first'), msg('assistant', 'response'), msg('user', 'second')]

  describe('anthropic', () => {
    it('folds system prompt into messages with cache_control', () => {
      const out = applyCacheControl({
        system: 'you are helpful',
        messages: baseMessages,
        modelId: 'anthropic:claude-opus-4-7',
        sessionId: 'abc',
      })
      expect(out.system).toBeUndefined()
      expect(out.messages[0].role).toBe('system')
      expect(out.messages[0].content).toBe('you are helpful')
      const sysOpts = (out.messages[0] as { providerOptions?: { anthropic?: { cacheControl?: { type: string } } } })
        .providerOptions?.anthropic?.cacheControl
      expect(sysOpts?.type).toBe('ephemeral')
    })

    it('tags the last two non-system messages with cache_control', () => {
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        modelId: 'anthropic:claude-sonnet-4-6',
        sessionId: 'abc',
      })
      // Structure: [system, user1, assistant, user2]
      const lastTwo = out.messages.slice(-2)
      for (const m of lastTwo) {
        const opts = (m as { providerOptions?: { anthropic?: { cacheControl?: { type: string } } } })
          .providerOptions?.anthropic?.cacheControl
        expect(opts?.type).toBe('ephemeral')
      }
      // Earliest user should NOT have cache_control
      const earliest = out.messages[1]
      const earliestOpts = (earliest as { providerOptions?: Record<string, unknown> }).providerOptions
      expect(earliestOpts).toBeUndefined()
    })

    it('does not set top-level providerOptions for anthropic', () => {
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        modelId: 'anthropic:claude-haiku-4-5',
        sessionId: 'abc',
      })
      expect(out.providerOptions).toBeUndefined()
    })

    it('does not mutate the input message array', () => {
      const frozenSource: ModelMessage[] = [msg('user', 'a'), msg('assistant', 'b')]
      const snapshot = frozenSource.map((m) => ({ ...m }))
      applyCacheControl({
        system: 'sys',
        messages: frozenSource,
        modelId: 'anthropic:claude-opus-4-7',
        sessionId: 'abc',
      })
      // Each original message object has no providerOptions mutation
      for (let i = 0; i < frozenSource.length; i++) {
        const before = snapshot[i]
        const after = frozenSource[i]
        expect(after.role).toBe(before.role)
        expect(after.content).toBe(before.content)
        expect((after as { providerOptions?: unknown }).providerOptions).toBeUndefined()
      }
    })
  })

  describe('openai', () => {
    it('sets top-level promptCacheKey to sessionId', () => {
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        modelId: 'openai:gpt-4.1',
        sessionId: 'session-xyz',
      })
      expect(out.providerOptions?.openai).toBeDefined()
      const oaiOpts = out.providerOptions?.openai as { promptCacheKey?: string; store?: boolean }
      expect(oaiOpts.promptCacheKey).toBe('session-xyz')
      expect(oaiOpts.store).toBe(false)
    })

    it('keeps system prompt separate (not folded into messages)', () => {
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        modelId: 'openai:gpt-4.1',
        sessionId: 'abc',
      })
      expect(out.system).toBe('sys')
      expect(out.messages).toHaveLength(baseMessages.length)
    })
  })

  describe('openai-compatible (deepseek, moonshot, alibaba, zhipu)', () => {
    it.each([
      ['deepseek:deepseek-v4-pro'],
      ['moonshotai:kimi-k2.5'],
      ['alibaba:qwen3-coder-plus'],
      ['zhipu:glm-4-plus'],
      ['xai:grok-3'],
      ['google:gemini-2.5-pro'],
    ])('leaves everything untouched for %s', (modelId) => {
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        modelId,
        sessionId: 'abc',
      })
      expect(out.system).toBe('sys')
      expect(out.messages).toEqual(baseMessages)
      expect(out.providerOptions).toBeUndefined()
    })
  })
})
