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
//   OpenAI      — automatic prefix caching, with `promptCacheKey` routing
//                 identical stable prefixes to the same cache shard. Platform
//                 API-key requests on GPT-5.6+ additionally get a 30-minute
//                 implicit cache and an explicit breakpoint after the byte-
//                 stable system prompt. ChatGPT subscription requests retain
//                 the private transport's accepted key-only shape. `store:
//                 false` independently disables response storage.
//
//   Moonshot    — automatic prefix caching + `prompt_cache_key: sessionId`
//                 for session affinity (requests of one session hit the same
//                 server-side cache shard), plus the byte-stable prefix below.
//
//   xAI         — automatic prefix caching. The default AI SDK model uses the
//                 Responses API, which requires `prompt_cache_key` in the body.
//                 The SDK does not expose that option, so an internal header
//                 carries the sessionId to the registry fetch adapter. The
//                 adapter consumes it before sending the request.
//
//   Alibaba     — supports both implicit and explicit caching. Explicit
//                 `cache_control` markers are valid on message content, not
//                 tool definitions. We tag the system prompt and last two
//                 messages; the stable tools schema still participates in
//                 the cached prefix before those message breakpoints.
//
//   OpenAI-     — the DeepSeek / Zhipu / custom providers all offer automatic
//   compatible    prefix caching with NO explicit flags required. The only
//                 prerequisite is a byte-stable prefix across turns.
//
//   Google      — Gemini uses implicit caching; no per-request flags we can
//                 usefully set from the SDK. Left as a no-op.
import { createHash } from 'node:crypto'

import type { ModelMessage, SystemModelMessage } from 'ai'

import { providerOf } from './capabilities.js'

/** Max messages we attach an Anthropic cache breakpoint to. Anthropic allows
 *  up to 4 `cache_control` blocks per request; we spend one on the system
 *  prompt and one on the last tool definition, leaving two for the message
 *  tail. Two is the sweet spot from opencode's testing — a third message
 *  breakpoint costs a cache-write against a region (the just-before-last
 *  message) that's about to be evicted anyway. */
const MESSAGE_CACHE_BREAKPOINTS = 2

export const XAI_PROMPT_CACHE_KEY_HEADER = 'x-x-code-prompt-cache-key'
export const OPENAI_SESSION_ID_HEADER = 'x-x-code-openai-session-id'

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
  /** Stable per-session identifier. OpenAI's ChatGPT transport receives this
   *  separately from the cross-session prompt-cache routing key. */
  sessionId: string
  /** ChatGPT subscription uses a private Responses transport that accepts the
   *  stable key but not Platform-only explicit cache controls. */
  openAIAuthMode?: 'chatgpt' | 'api-key' | 'none'
}

export interface CacheControlResult {
  /** Instructions may be a tagged system message when a provider needs a
   *  cache breakpoint on the stable system prompt. */
  instructions?: string | SystemModelMessage
  messages: ModelMessage[]
  /** Anthropic receives a shallow-cloned tools record with cache_control on
   *  the last entry. Other providers get the input record as-is. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Record<string, any>
  /** Top-level providerOptions to pass through to streamText. */
  providerOptions?: Record<string, unknown>
  /** HTTP headers to pass through to streamText, including internal fetch-adapter hints. */
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

/** Build a system-role instruction with Anthropic cache_control attached. */
function anthropicSystemMessage(system: string): SystemModelMessage {
  return {
    role: 'system',
    content: system,
    providerOptions: {
      anthropic: { cacheControl: { type: 'ephemeral' } },
    },
  }
}

/** Build a system-role instruction with Alibaba cache_control attached. */
function alibabaSystemMessage(system: string): SystemModelMessage {
  return {
    role: 'system',
    content: system,
    providerOptions: {
      alibaba: { cacheControl: { type: 'ephemeral' } },
    },
  }
}

/** GPT-5.6 model variants share the new prompt_cache_options contract. */
function supportsOpenAIExplicitPromptCaching(modelId: string): boolean {
  return /^openai:gpt-5\.6(?:$|-)/.test(modelId)
}

const CHATGPT_CACHE_COMPARISON_TTL_MS = 5 * 60 * 1000
const OPENAI_EXPLICIT_CACHE_TTL_MS = 30 * 60 * 1000

/** Diagnostic comparison window for adjacent OpenAI turns. Platform GPT-5.6
 *  receives an explicit 30-minute TTL. ChatGPT's private transport exposes no
 *  TTL control, so use a conservative five-minute window and avoid labeling
 *  older provider-default evictions as byte-instability regressions. */
export function openAICacheComparisonTtlMs(
  modelId: string,
  authMode: CacheControlArgs['openAIAuthMode'],
): number | undefined {
  if (!supportsOpenAIExplicitPromptCaching(modelId)) return undefined
  return authMode === 'chatgpt' ? CHATGPT_CACHE_COMPARISON_TTL_MS : OPENAI_EXPLICIT_CACHE_TTL_MS
}

/** Keep cache routing stable across sessions without exposing prompt text or
 *  local paths in the provider-visible key. Model and prompt changes naturally
 *  produce a different cache group. */
export function openAIStablePromptCacheKey(modelId: string, instructions: string): string {
  const digest = createHash('sha256').update(modelId).update('\0').update(instructions).digest('hex').slice(0, 32)
  return `xc-agent-v1:${digest}`
}

function openAISystemMessage(system: string): SystemModelMessage {
  return {
    role: 'system',
    content: system,
    providerOptions: {
      openai: { promptCacheBreakpoint: { mode: 'explicit' } },
    },
  }
}

/**
 * Return the request shape enriched with provider-specific caching hints.
 * The input `messages` array is not mutated — new message objects are
 * returned for any message that needs extra providerOptions.
 */
export function applyCacheControl(args: CacheControlArgs): CacheControlResult {
  const provider = providerOf(args.modelId)

  if (provider === 'anthropic') {
    // AI SDK v7 rejects system-role entries in `messages`; keep the tagged
    // system prompt in `instructions` and mark the message tail separately.
    const nonSystemTail = args.messages.slice(-MESSAGE_CACHE_BREAKPOINTS)
    const tailSet = new Set(nonSystemTail)
    const tagged = args.messages.map((m) =>
      tailSet.has(m) ? tagMessage(m, 'anthropic', { cacheControl: { type: 'ephemeral' } }) : m,
    )
    return {
      instructions: anthropicSystemMessage(args.instructions),
      messages: tagged,
      tools: tagLastTool(args.tools),
    }
  }

  if (provider === 'openai') {
    const promptCacheKey = openAIStablePromptCacheKey(args.modelId, args.instructions)
    const explicitCaching = supportsOpenAIExplicitPromptCaching(args.modelId) && args.openAIAuthMode !== 'chatgpt'
    // Platform GPT-5.6 implicit mode keeps the automatic latest-message
    // breakpoint alongside our explicit stable-system breakpoint. ChatGPT
    // subscription stays on the accepted automatic key-only shape.
    return {
      instructions: explicitCaching ? openAISystemMessage(args.instructions) : args.instructions,
      messages: args.messages,
      tools: args.tools,
      providerOptions: {
        openai: {
          promptCacheKey,
          ...(explicitCaching ? { promptCacheOptions: { mode: 'implicit', ttl: '30m' } } : {}),
          store: false,
        },
      },
      headers: { [OPENAI_SESSION_ID_HEADER]: args.sessionId },
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
    // The provider registry consumes this internal header and moves the key to
    // the transport-specific location without leaking the header upstream.
    return {
      instructions: args.instructions,
      messages: args.messages,
      tools: args.tools,
      headers: { [XAI_PROMPT_CACHE_KEY_HEADER]: args.sessionId },
    }
  }

  if (provider === 'alibaba') {
    // Alibaba's explicit markers belong on message content. Tool definitions
    // still form part of the stable prefix, but markers attached to tools are
    // ignored by both the API contract and the current provider adapter.
    const nonSystemTail = args.messages.slice(-MESSAGE_CACHE_BREAKPOINTS)
    const tailSet = new Set(nonSystemTail)
    const tagged = args.messages.map((m) =>
      tailSet.has(m) ? tagMessage(m, 'alibaba', { cacheControl: { type: 'ephemeral' } }) : m,
    )
    return {
      instructions: alibabaSystemMessage(args.instructions),
      messages: tagged,
      tools: args.tools,
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
