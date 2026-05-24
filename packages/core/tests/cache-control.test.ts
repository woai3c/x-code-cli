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
        const opts = (m as { providerOptions?: { anthropic?: { cacheControl?: { type: string } } } }).providerOptions
          ?.anthropic?.cacheControl
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

    it('tags only the last tool with cache_control', () => {
      const tools = {
        read: { description: 'read a file' },
        write: { description: 'write a file' },
        edit: { description: 'edit a file' },
      }
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'anthropic:claude-opus-4-7',
        sessionId: 'abc',
      })
      expect(out.tools).toBeDefined()
      // Earlier tools should not have providerOptions
      expect((out.tools!.read as { providerOptions?: unknown }).providerOptions).toBeUndefined()
      expect((out.tools!.write as { providerOptions?: unknown }).providerOptions).toBeUndefined()
      const lastOpts = (out.tools!.edit as { providerOptions?: { anthropic?: { cacheControl?: { type: string } } } })
        .providerOptions?.anthropic?.cacheControl
      expect(lastOpts?.type).toBe('ephemeral')
    })

    it('preserves tool key order so the cached prefix stays byte-stable', () => {
      const tools = { read: {}, write: {}, edit: {}, shell: {} }
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'anthropic:claude-opus-4-7',
        sessionId: 'abc',
      })
      expect(Object.keys(out.tools!)).toEqual(['read', 'write', 'edit', 'shell'])
    })

    it('does not mutate the input tools record', () => {
      const tools = { read: { description: 'r' }, write: { description: 'w' } }
      applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'anthropic:claude-opus-4-7',
        sessionId: 'abc',
      })
      expect((tools.write as { providerOptions?: unknown }).providerOptions).toBeUndefined()
    })

    it('merges with any pre-existing tool providerOptions', () => {
      const tools = {
        read: {},
        write: {
          providerOptions: { anthropic: { cacheControl: { type: 'persistent' }, deferLoading: true } },
        },
      }
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'anthropic:claude-opus-4-7',
        sessionId: 'abc',
      })
      const writeOpts = (
        out.tools!.write as {
          providerOptions?: { anthropic?: { cacheControl?: { type: string }; deferLoading?: boolean } }
        }
      ).providerOptions?.anthropic
      // Our ephemeral mark overrides whatever was there, but unrelated keys
      // (deferLoading) are preserved.
      expect(writeOpts?.cacheControl?.type).toBe('ephemeral')
      expect(writeOpts?.deferLoading).toBe(true)
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

    it('passes tools through untouched', () => {
      const tools = { read: { description: 'r' }, write: { description: 'w' } }
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'openai:gpt-4.1',
        sessionId: 'abc',
      })
      expect(out.tools).toBe(tools)
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
      const tools = { read: { description: 'r' } }
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        tools,
        modelId,
        sessionId: 'abc',
      })
      expect(out.system).toBe('sys')
      expect(out.messages).toEqual(baseMessages)
      expect(out.providerOptions).toBeUndefined()
      expect(out.tools).toBe(tools)
    })
  })
})
