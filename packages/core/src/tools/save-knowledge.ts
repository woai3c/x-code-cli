// @x-code/core — saveKnowledge tool (knowledge CRUD)

import { tool } from 'ai'
import { z } from 'zod'

import { getAutoMemory } from '../knowledge/auto-memory.js'

export const saveKnowledge = tool({
  description:
    'Save, update, or delete a project/user knowledge fact in persistent memory. Use when you discover project conventions, user preferences, or important facts worth remembering for future sessions.',
  inputSchema: z.object({
    action: z
      .enum(['add', 'delete'])
      .describe('add = create or update (auto-replaces conflicting old fact), delete = remove outdated fact'),
    key: z
      .string()
      .describe(
        'A short unique identifier for this fact, e.g. "package-manager", "test-framework". Same key = same fact.',
      ),
    fact: z.string().describe('The fact value, e.g. "pnpm (workspace mode)", "Vitest 4"'),
    scope: z.enum(['project', 'global']).describe('project = this repo (.x-code/), global = all repos (~/.xcode/)'),
    category: z.enum(['tech-stack', 'commands', 'conventions', 'preferences', 'context']),
  }),
  execute: async ({ action, key, fact, scope, category }) => {
    try {
      const memory = getAutoMemory(scope)
      if (action === 'add') {
        memory.add({ key, fact, category, date: new Date().toISOString().slice(0, 10) })
        return `Knowledge saved: [${category}] ${key}: ${fact}`
      } else {
        memory.delete(key, category)
        return `Knowledge deleted: [${category}] ${key}`
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error saving knowledge: ${msg}`
    }
  },
})
