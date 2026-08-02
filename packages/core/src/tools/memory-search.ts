import { tool } from 'ai'

import { z } from 'zod'

import type { LoopState } from '../agent/loop-state.js'
import { normalizeMemoryText, tokenizeMemoryText } from '../knowledge/memory-index.js'
import type { MemoryService } from '../knowledge/memory-service.js'
import { extractText } from '../utils/message-helpers.js'

function latestUserText(state: LoopState): string {
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index]
    if (message?.role === 'user') return extractText(message.content)
  }
  return ''
}

function recentToolText(state: LoopState): string {
  return state.messages
    .slice(-6)
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.stringify(message.content))
    .join('\n')
    .slice(0, 6000)
}

function relatedToTurn(query: string, userText: string, toolText: string): boolean {
  const queryTokens = new Set(tokenizeMemoryText(query))
  const turnTokens = new Set(tokenizeMemoryText(`${userText}\n${toolText}`))
  if (queryTokens.size === 0) return false
  if ([...queryTokens].some((token) => turnTokens.has(token))) return true
  return /(?:记得|记忆|之前|以前|上次|历史|remember|previous|history)/i.test(userText)
}

export function createMemorySearchTool(service: MemoryService, state: LoopState, repositoryId: string) {
  return tool({
    description:
      'Search selected long-term user memory when the current request explicitly depends on prior preferences, products, decisions, or references. This is read-only. Never use it to enumerate all memory.',
    inputSchema: z.object({
      query: z.string().min(1),
      topicIds: z.array(z.string()).optional(),
      maxResults: z.number().int().min(1).max(5).optional(),
      includeStale: z.boolean().optional(),
    }),
    execute: async (args) => {
      const userText = latestUserText(state)
      const toolText = recentToolText(state)
      if (!relatedToTurn(args.query, userText, toolText)) {
        return { error: 'memorySearch query is unrelated to the current user request or newly observed tool entities' }
      }
      if (/^(?:\*|\.\*|all|全部|所有)$/i.test(normalizeMemoryText(args.query))) {
        return { error: 'memorySearch cannot enumerate all memory' }
      }
      const results = await service.search(args, {
        repositoryId,
        currentUserText: userText,
        explicitHistoryIntent: /(?:记得|记忆|之前|以前|上次|历史|remember|previous|history)/i.test(userText),
      })
      return { results }
    },
  })
}
