// Tests for providers/cache-control.ts
import { describe, expect, it } from 'vitest'

import type { ModelMessage } from 'ai'

import {
  OPENAI_SESSION_ID_HEADER,
  XAI_PROMPT_CACHE_KEY_HEADER,
  applyCacheControl,
} from '../src/providers/cache-control.js'

function msg(role: 'user' | 'assistant', text: string): ModelMessage {
  return { role, content: text } as ModelMessage
}

describe('applyCacheControl', () => {
  const baseMessages: ModelMessage[] = [msg('user', 'first'), msg('assistant', 'response'), msg('user', 'second')]

  describe('anthropic', () => {
    it('keeps the tagged system prompt in instructions for AI SDK v7', () => {
      const out = applyCacheControl({
        instructions: 'you are helpful',
        messages: baseMessages,
        modelId: 'anthropic:claude-opus-4-8',
        sessionId: 'abc',
      })
      expect(out.instructions).toEqual({
        role: 'system',
        content: 'you are helpful',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      })
      expect(out.messages).toHaveLength(baseMessages.length)
      expect(out.messages[0].role).toBe('user')
    })

    it('tags the last two non-system messages with cache_control', () => {
      const out = applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        modelId: 'anthropic:claude-sonnet-5',
        sessionId: 'abc',
      })
      const lastTwo = out.messages.slice(-2)
      for (const m of lastTwo) {
        const opts = (m as { providerOptions?: { anthropic?: { cacheControl?: { type: string } } } }).providerOptions
          ?.anthropic?.cacheControl
        expect(opts?.type).toBe('ephemeral')
      }
      // Earliest user should NOT have cache_control
      const earliest = out.messages[0]
      const earliestOpts = (earliest as { providerOptions?: Record<string, unknown> }).providerOptions
      expect(earliestOpts).toBeUndefined()
    })

    it('does not set top-level providerOptions for anthropic', () => {
      const out = applyCacheControl({
        instructions: 'sys',
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
        instructions: 'sys',
        messages: frozenSource,
        modelId: 'anthropic:claude-opus-4-8',
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
        instructions: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'anthropic:claude-opus-4-8',
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
        instructions: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'anthropic:claude-opus-4-8',
        sessionId: 'abc',
      })
      expect(Object.keys(out.tools!)).toEqual(['read', 'write', 'edit', 'shell'])
    })

    it('does not mutate the input tools record', () => {
      const tools = { read: { description: 'r' }, write: { description: 'w' } }
      applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'anthropic:claude-opus-4-8',
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
        instructions: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'anthropic:claude-opus-4-8',
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
    it('groups identical stable prefixes across sessions without exposing either prompt or session text', () => {
      const first = applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        modelId: 'openai:gpt-5.6-sol',
        sessionId: 'session-one',
      })
      const second = applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        modelId: 'openai:gpt-5.6-sol',
        sessionId: 'session-two',
      })
      const firstKey = (first.providerOptions?.openai as { promptCacheKey?: string }).promptCacheKey
      const secondKey = (second.providerOptions?.openai as { promptCacheKey?: string }).promptCacheKey

      expect(firstKey).toBe(secondKey)
      expect(firstKey).toMatch(/^xc-agent-v1:[a-f0-9]{32}$/)
      expect(firstKey).not.toContain('sys')
      expect(firstKey).not.toContain('session-one')
      expect(firstKey!.length).toBeLessThanOrEqual(64)
      expect(first.headers).toEqual({ [OPENAI_SESSION_ID_HEADER]: 'session-one' })
      expect(second.headers).toEqual({ [OPENAI_SESSION_ID_HEADER]: 'session-two' })
    })

    it('changes the cache group when the model or stable instructions change', () => {
      const cacheKey = (modelId: string, instructions: string) => {
        const out = applyCacheControl({
          instructions,
          messages: baseMessages,
          modelId,
          sessionId: 'same-session',
        })
        return (out.providerOptions?.openai as { promptCacheKey?: string }).promptCacheKey
      }

      expect(cacheKey('openai:gpt-5.6-sol', 'sys-a')).not.toBe(cacheKey('openai:gpt-5.6-sol', 'sys-b'))
      expect(cacheKey('openai:gpt-5.6-sol', 'sys-a')).not.toBe(cacheKey('openai:gpt-5.6-terra', 'sys-a'))
    })

    it('adds GPT-5.6 cache options and an explicit stable-system breakpoint', () => {
      const out = applyCacheControl({
        instructions: 'stable system prompt',
        messages: baseMessages,
        modelId: 'openai:gpt-5.6-sol',
        sessionId: 'abc',
      })
      const options = out.providerOptions?.openai as {
        promptCacheOptions?: { mode?: string; ttl?: string }
        store?: boolean
      }

      expect(options).toMatchObject({
        promptCacheOptions: { mode: 'implicit', ttl: '30m' },
        store: false,
      })
      expect(out.instructions).toMatchObject({
        role: 'system',
        content: 'stable system prompt',
        providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } },
      })
      expect(out.messages).toBe(baseMessages)
    })

    it('keeps the legacy automatic-cache shape for earlier OpenAI models', () => {
      const out = applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        modelId: 'openai:gpt-5.5',
        sessionId: 'abc',
      })
      const options = out.providerOptions?.openai as {
        promptCacheOptions?: unknown
        promptCacheKey?: string
        store?: boolean
      }

      expect(out.instructions).toBe('sys')
      expect(out.messages).toBe(baseMessages)
      expect(options.promptCacheOptions).toBeUndefined()
      expect(options.promptCacheKey).toMatch(/^xc-agent-v1:/)
      expect(options.store).toBe(false)
    })

    it('passes tools through untouched', () => {
      const tools = { read: { description: 'r' }, write: { description: 'w' } }
      const out = applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'openai:gpt-5.6-sol',
        sessionId: 'abc',
      })
      expect(out.tools).toBe(tools)
    })
  })

  describe('moonshotai', () => {
    it('sets prompt_cache_key to sessionId for cache-shard affinity', () => {
      const out = applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        modelId: 'moonshotai:kimi-k3',
        sessionId: 'session-xyz',
      })
      const opts = out.providerOptions?.moonshotai as { prompt_cache_key?: string }
      expect(opts.prompt_cache_key).toBe('session-xyz')
    })

    it('keeps system prompt and messages untouched', () => {
      const tools = { read: { description: 'r' } }
      const out = applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'moonshotai:kimi-k3',
        sessionId: 'abc',
      })
      expect(out.instructions).toBe('sys')
      expect(out.messages).toEqual(baseMessages)
      expect(out.tools).toBe(tools)
    })
  })

  describe('xai', () => {
    it('stages the Responses prompt cache key for the registry fetch adapter', () => {
      const out = applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        modelId: 'xai:grok-4.5',
        sessionId: 'session-xyz',
      })
      expect(out.headers).toEqual({ [XAI_PROMPT_CACHE_KEY_HEADER]: 'session-xyz' })
    })

    it('keeps system prompt, messages and tools untouched', () => {
      const tools = { read: { description: 'r' } }
      const out = applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'xai:grok-4.5',
        sessionId: 'abc',
      })
      expect(out.instructions).toBe('sys')
      expect(out.messages).toEqual(baseMessages)
      expect(out.tools).toBe(tools)
      expect(out.providerOptions).toBeUndefined()
    })
  })

  describe('alibaba', () => {
    it('keeps the tagged system prompt in instructions for AI SDK v7', () => {
      const out = applyCacheControl({
        instructions: 'you are helpful',
        messages: baseMessages,
        modelId: 'alibaba:qwen3-coder-plus',
        sessionId: 'abc',
      })
      expect(out.instructions).toEqual({
        role: 'system',
        content: 'you are helpful',
        providerOptions: { alibaba: { cacheControl: { type: 'ephemeral' } } },
      })
      expect(out.messages).toHaveLength(baseMessages.length)
      expect(out.messages[0].role).toBe('user')
    })

    it('tags the last two non-system messages with cache_control', () => {
      const out = applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        modelId: 'alibaba:qwen3-coder-plus',
        sessionId: 'abc',
      })
      const lastTwo = out.messages.slice(-2)
      for (const m of lastTwo) {
        const opts = (m as { providerOptions?: { alibaba?: { cacheControl?: { type: string } } } }).providerOptions
          ?.alibaba?.cacheControl
        expect(opts?.type).toBe('ephemeral')
      }
      const earliest = out.messages[0]
      const earliestOpts = (earliest as { providerOptions?: Record<string, unknown> }).providerOptions
      expect(earliestOpts).toBeUndefined()
    })

    it('leaves tool definitions untouched because Alibaba ignores tool breakpoints', () => {
      const tools = {
        read: { description: 'read a file' },
        write: { description: 'write a file' },
        edit: { description: 'edit a file' },
      }
      const out = applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'alibaba:qwen3-coder-plus',
        sessionId: 'abc',
      })
      expect(out.tools).toBe(tools)
      expect((out.tools!.edit as { providerOptions?: unknown }).providerOptions).toBeUndefined()
    })

    it('does not set top-level providerOptions', () => {
      const out = applyCacheControl({
        instructions: 'sys',
        messages: baseMessages,
        modelId: 'alibaba:qwen3-coder-plus',
        sessionId: 'abc',
      })
      expect(out.providerOptions).toBeUndefined()
    })
  })

  describe('implicit-only (deepseek, zhipu, google)', () => {
    it.each([['deepseek:deepseek-v4-pro'], ['zhipu:glm-4.7'], ['google:gemini-2.5-pro']])(
      'leaves everything untouched for %s',
      (modelId) => {
        const tools = { read: { description: 'r' } }
        const out = applyCacheControl({
          instructions: 'sys',
          messages: baseMessages,
          tools,
          modelId,
          sessionId: 'abc',
        })
        expect(out.instructions).toBe('sys')
        expect(out.messages).toEqual(baseMessages)
        expect(out.providerOptions).toBeUndefined()
        expect(out.tools).toBe(tools)
      },
    )
  })
})
