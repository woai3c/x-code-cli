// @x-code-cli/core — Per-provider prompt caching
//
// Prompt caching is the single biggest lever on per-session cost. All current
// providers offer it, but the activation protocol differs:
//
//   Anthropic   — set `cacheControl: { type: 'ephemeral' }` on the SYSTEM
//                 message and the LAST two non-system messages (three
//                 breakpoints total, under the API's limit of four). The
//                 content at each breakpoint is cached server-side with a
//                 5-minute TTL; subsequent requests that share the exact
//                 prefix hit the cache and only pay for the uncached tail.
//
//   OpenAI      — automatic prefix caching, but setting `promptCacheKey`
//                 (routes identical keys to the same cache shard) and `store`
//                 (retains the call for later fetching) improves hit rates.
//                 We send the sessionId as the key so every turn in a
//                 conversation maps to the same shard.
//
//   OpenAI-     — the DeepSeek / Moonshot / Alibaba / Zhipu / xAI / custom
//   compatible    providers all offer automatic prefix caching with NO
//                 explicit flags required. The only prerequisite is a
//                 byte-stable prefix across turns: if the system prompt
//                 rebuilds with a fresh timestamp every turn, every request
//                 misses the cache. We therefore cache the system prompt
//                 once per session in LoopState (see loop-state.ts) and use
//                 the same string on every subsequent turn.
//
//   Google      — Gemini uses implicit caching; no per-request flags we can
//                 usefully set from the SDK. Left as a no-op.
import type { ModelMessage } from 'ai'

import { providerOf } from './capabilities.js'

/** Max messages we attach an Anthropic cache breakpoint to. Anthropic allows
 *  up to 4 `cache_control` blocks per request; we spend one on the system
 *  prompt, leaving three for the message tail. Two is the sweet spot from
 *  opencode's testing — a third breakpoint costs a cache-write against a
 *  region (the just-before-last message) that's about to be evicted anyway. */
const MESSAGE_CACHE_BREAKPOINTS = 2

export interface CacheControlArgs {
  /** System prompt string. May be wrapped into a system-role message if the
   *  provider needs cache_control attached to it. */
  system: string
  /** Conversation messages to send. */
  messages: ModelMessage[]
  /** provider:model id used to select the caching strategy. */
  modelId: string
  /** Stable per-session key. Used by OpenAI's `promptCacheKey` to pin
   *  identical prefixes to the same cache shard. */
  sessionId: string
}

export interface CacheControlResult {
  /** Possibly-undefined: for Anthropic we fold the system prompt into the
   *  messages array to attach cache_control; in that case streamText must be
   *  called without a separate `system` param. */
  system?: string
  messages: ModelMessage[]
  /** Top-level providerOptions to pass through to streamText. */
  providerOptions?: Record<string, unknown>
}

/** Attach the given providerOptions entry to a message non-destructively. */
function tagMessage(msg: ModelMessage, provider: string, entry: Record<string, unknown>): ModelMessage {
  const existing = (msg as { providerOptions?: Record<string, Record<string, unknown>> }).providerOptions ?? {}
  return {
    ...msg,
    providerOptions: {
      ...existing,
      [provider]: { ...(existing[provider] ?? {}), ...entry },
    },
  } as ModelMessage
}

/** Build a system-role message with Anthropic cache_control attached. */
function anthropicSystemMessage(system: string): ModelMessage {
  return {
    role: 'system',
    content: system,
    providerOptions: {
      anthropic: { cacheControl: { type: 'ephemeral' } },
    },
  } as unknown as ModelMessage
}

/**
 * Return the request shape enriched with provider-specific caching hints.
 * The input `messages` array is not mutated — new message objects are
 * returned for any message that needs extra providerOptions.
 */
export function applyCacheControl(args: CacheControlArgs): CacheControlResult {
  const provider = providerOf(args.modelId)

  if (provider === 'anthropic') {
    // Fold system into messages so we can attach cache_control to it, then
    // mark the last N non-system messages as additional breakpoints.
    const nonSystemTail = args.messages.slice(-MESSAGE_CACHE_BREAKPOINTS)
    const tailSet = new Set(nonSystemTail)
    const tagged = args.messages.map((m) =>
      tailSet.has(m) ? tagMessage(m, 'anthropic', { cacheControl: { type: 'ephemeral' } }) : m,
    )
    return {
      system: undefined,
      messages: [anthropicSystemMessage(args.system), ...tagged],
    }
  }

  if (provider === 'openai') {
    // store:false — we don't need the stored-call bookkeeping (retrieval via
    // API), but the promptCacheKey still routes identical prefixes to the
    // same cache shard which is the actual cost win.
    return {
      system: args.system,
      messages: args.messages,
      providerOptions: {
        openai: { promptCacheKey: args.sessionId, store: false },
      },
    }
  }

  // OpenAI-compatible & Gemini: no explicit flags, just rely on stable prefix.
  // Callers must ensure buildSystemPrompt is cached in LoopState so the same
  // system string is re-sent every turn.
  return { system: args.system, messages: args.messages }
}
