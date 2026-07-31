// @x-code-cli/core — Per-provider prompt caching
//
// Prompt caching is the single biggest lever on per-session cost. All current
// providers offer it, but the activation protocol differs:
//
//   Anthropic   — set `cacheControl: { type: 'ephemeral' }` on the SYSTEM
//                 message, the LAST tool definition (caching the whole
//                 tools schema in one breakpoint), and the LAST two
//                 non-system messages — four breakpoints total, exactly
//                 the API's limit. The content at each breakpoint is
//                 cached server-side with a 5-minute TTL; subsequent
//                 requests that share the exact prefix hit the cache and
//                 only pay for the uncached tail. Tools schema is the
//                 highest-leverage slot — it's the same bytes on every
//                 turn and runs into the thousands of tokens once the
//                 full tool set is registered.
//
//   OpenAI      — automatic prefix caching, but setting `promptCacheKey`
//                 (routes identical keys to the same cache shard) and `store`
//                 (retains the call for later fetching) improves hit rates.
//                 We send the sessionId as the key so every turn in a
//                 conversation maps to the same shard.
//
//   Moonshot    — automatic prefix caching + `prompt_cache_key: sessionId`
//                 for session affinity (requests of one session hit the same
//                 server-side cache shard), plus the byte-stable prefix below.
//
//   xAI         — automatic prefix caching. Chat Completions API uses the
//                 `x-grok-conv-id` HTTP header to route requests with the
//                 same conversation ID to the same server, maximizing cache
//                 hits. Responses API uses `prompt_cache_key` in the body
//                 instead. We use Chat Completions, so we send the header.
//
//   Alibaba     — supports both implicit caching (automatic 80% discount,
//                 no flags needed) and explicit caching via `cache_control:
//                 { type: 'ephemeral' }` markers (10% of input price on
//                 hits, 125% write cost). Explicit caching is deterministic
//                 and uses the same breakpoint protocol as Anthropic — up
//                 to 4 markers per request. We tag system prompt, last tool,
//                 and last two messages (same as Anthropic) for 10× savings.
//                 @ai-sdk/alibaba reads `providerOptions.alibaba.cacheControl`.
//
//   OpenAI-     — the DeepSeek / Zhipu / custom providers all offer automatic
//   compatible    prefix caching with NO explicit flags required. The only
//                 prerequisite is a byte-stable prefix across turns.
//
//   Google      — Gemini uses implicit caching; no per-request flags we can
//                 usefully set from the SDK. Left as a no-op.
import type { ModelMessage } from 'ai'

import { providerOf } from './capabilities.js'

/** Max messages we attach an Anthropic cache breakpoint to. Anthropic allows
 *  up to 4 `cache_control` blocks per request; we spend one on the system
 *  prompt and one on the last tool definition, leaving two for the message
 *  tail. Two is the sweet spot from opencode's testing — a third message
 *  breakpoint costs a cache-write against a region (the just-before-last
 *  message) that's about to be evicted anyway. */
const MESSAGE_CACHE_BREAKPOINTS = 2

export interface CacheControlArgs {
  /** Instructions (system prompt) string. May be wrapped into a system-role
   *  message if the provider needs cache_control attached to it. */
  instructions: string
  /** Conversation messages to send. */
  messages: ModelMessage[]
  /** Tool registry passed to streamText. For Anthropic we tag the last entry
   *  with cache_control so the whole tools schema enters the cache prefix.
   *  buildTools() returns the same Record reference for the session, so key
   *  order — and therefore the cached prefix — is byte-stable across turns. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Record<string, any>
  /** provider:model id used to select the caching strategy. */
  modelId: string
  /** Stable per-session key. Used by OpenAI's `promptCacheKey` to pin
   *  identical prefixes to the same cache shard. */
  sessionId: string
}

export interface CacheControlResult {
  /** Possibly-undefined: for Anthropic/Alibaba we fold the instructions into
   *  the messages array to attach cache_control; in that case streamText must
   *  be called without a separate `instructions` param. */
  instructions?: string
  messages: ModelMessage[]
  /** For Anthropic/Alibaba, a shallow-cloned tools record with cache_control
   *  attached to the last entry. Other providers get the input record returned
   *  as-is (or undefined if none was passed). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Record<string, any>
  /** Top-level providerOptions to pass through to streamText. */
  providerOptions?: Record<string, unknown>
  /** HTTP headers to pass through to streamText (e.g. xAI's x-grok-conv-id). */
  headers?: Record<string, string>
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

/** Build a system-role message with Alibaba cache_control attached. */
function alibabaSystemMessage(system: string): ModelMessage {
  return {
    role: 'system',
    content: system,
    providerOptions: {
      alibaba: { cacheControl: { type: 'ephemeral' } },
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
    // Fold instructions into messages so we can attach cache_control to it,
    // then mark the last N non-system messages as additional breakpoints.
    const nonSystemTail = args.messages.slice(-MESSAGE_CACHE_BREAKPOINTS)
    const tailSet = new Set(nonSystemTail)
    const tagged = args.messages.map((m) =>
      tailSet.has(m) ? tagMessage(m, 'anthropic', { cacheControl: { type: 'ephemeral' } }) : m,
    )
    return {
      instructions: undefined,
      messages: [anthropicSystemMessage(args.instructions), ...tagged],
      tools: tagLastTool(args.tools),
    }
  }

  if (provider === 'openai') {
    // store:false — we don't need the stored-call bookkeeping (retrieval via
    // API), but the promptCacheKey still routes identical prefixes to the
    // same cache shard which is the actual cost win.
    return {
      instructions: args.instructions,
      messages: args.messages,
      tools: args.tools,
      providerOptions: {
        openai: { promptCacheKey: args.sessionId, store: false },
      },
    }
  }

  if (provider === 'moonshotai') {
    // Moonshot's server-side prefix caching is automatic, but requests land
    // on a per-key cache shard: pinning `prompt_cache_key` to the sessionId
    // keeps every turn of a conversation on the same shard (same mechanism
    // Kimi CLI uses). Both Moonshot routes forward it: the openai-compatible
    // SDK spreads non-standard providerOptions keys into the request body
    // verbatim, and @ai-sdk/moonshotai inherits that behavior.
    return {
      instructions: args.instructions,
      messages: args.messages,
      tools: args.tools,
      providerOptions: {
        moonshotai: { prompt_cache_key: args.sessionId },
      },
    }
  }

  if (provider === 'xai') {
    // xAI Chat Completions API uses the `x-grok-conv-id` HTTP header for
    // sticky routing — requests with the same conv-id hit the same server
    // where their cache entries live. Without it, requests may land on
    // cache-cold servers. We use sessionId as the conv-id so every turn
    // in a conversation routes to the same cache shard.
    return {
      instructions: args.instructions,
      messages: args.messages,
      tools: args.tools,
      headers: { 'x-grok-conv-id': args.sessionId },
    }
  }

  if (provider === 'alibaba') {
    // Alibaba supports explicit caching via `cache_control: { type: 'ephemeral' }`
    // markers, same protocol as Anthropic — up to 4 breakpoints per request.
    // Explicit cache hits cost 10% of input price (vs 80% implicit discount),
    // with a 125% write cost. We tag instructions + last tool + last 2
    // messages — identical layout to Anthropic.
    const nonSystemTail = args.messages.slice(-MESSAGE_CACHE_BREAKPOINTS)
    const tailSet = new Set(nonSystemTail)
    const tagged = args.messages.map((m) =>
      tailSet.has(m) ? tagMessage(m, 'alibaba', { cacheControl: { type: 'ephemeral' } }) : m,
    )
    return {
      instructions: undefined,
      messages: [alibabaSystemMessage(args.instructions), ...tagged],
      tools: tagLastToolAlibaba(args.tools),
    }
  }

  // OpenAI-compatible & Gemini: no explicit flags, just rely on stable prefix.
  // Callers must ensure buildSystemPrompt is cached in LoopState so the same
  // instructions string is re-sent every turn.
  return { instructions: args.instructions, messages: args.messages, tools: args.tools }
}

/** Shallow-clone `tools` and attach a cache_control breakpoint to the last
 *  entry for the given provider, so the entire tools schema enters one cached
 *  prefix slot. Returns the input unchanged when there are no tools. */
function tagLastToolForProvider(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any> | undefined,
  provider: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> | undefined {
  if (!tools) return tools
  const names = Object.keys(tools)
  if (names.length === 0) return tools
  const lastName = names[names.length - 1]
  const lastTool = tools[lastName]
  const existing = (lastTool?.providerOptions ?? {}) as Record<string, Record<string, unknown>>
  const tagged = {
    ...lastTool,
    providerOptions: {
      ...existing,
      [provider]: { ...(existing[provider] ?? {}), cacheControl: { type: 'ephemeral' } },
    },
  }
  return { ...tools, [lastName]: tagged }
}

/** Anthropic cache_control on last tool. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tagLastTool(tools: Record<string, any> | undefined): Record<string, any> | undefined {
  return tagLastToolForProvider(tools, 'anthropic')
}

/** Alibaba cache_control on last tool. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tagLastToolAlibaba(tools: Record<string, any> | undefined): Record<string, any> | undefined {
  return tagLastToolForProvider(tools, 'alibaba')
}
