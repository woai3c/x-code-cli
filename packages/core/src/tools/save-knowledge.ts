// @x-code-cli/core — saveKnowledge tool (AI-written persistent memory)
import { tool } from 'ai'

import { z } from 'zod'

import { getAutoMemory } from '../knowledge/auto-memory.js'

export const saveKnowledge = tool({
  description: `Save or delete a persistent memory that should survive across sessions.

Use for things worth remembering next session, not ephemeral task state. Every memory MUST be filed under one of four categories — pick the one that describes the TYPE of knowledge, not the topic:

  user       — Facts about the human user: their role, expertise, goals, long-term constraints. Example: "user is a senior Go engineer new to this frontend".
  feedback   — Corrections or validated approaches the user has given. Save both when the user corrects you AND when they confirm a non-obvious choice worked. Include WHY so edge cases are judgeable. Example: "integration tests must hit real DB, not mocks — prior incident where mocks masked broken migration".
  project    — Ongoing work, initiatives, deadlines, non-obvious project state that would NOT be derivable from reading code or git log. Example: "merge freeze begins 2026-03-05 for mobile release cut".
  reference  — Pointers to external systems. Example: "pipeline bugs tracked in Linear project INGEST".

Do NOT save: anything derivable from the current code or git history, debugging solutions, conversation context, documented CLAUDE.md / AGENTS.md content.

Scope: project = this repo only; global = applies across all repos.`,
  inputSchema: z.object({
    action: z
      .enum(['add', 'delete'])
      .describe('add = create or update (auto-replaces conflicting old fact), delete = remove outdated fact'),
    key: z
      .string()
      .describe(
        'Short unique slug identifying this fact. Same key under same category auto-replaces. Example: "testing-db-policy", "user-role".',
      ),
    fact: z
      .string()
      .describe(
        'The fact itself. For feedback, lead with the rule and include a one-line reason so future edge cases are judgeable.',
      ),
    scope: z.enum(['project', 'global']).describe('project = this repo (.x-code/), global = all repos (~/.x-code/)'),
    category: z
      .enum(['user', 'feedback', 'project', 'reference'])
      .describe('user | feedback | project | reference — see tool description for when to pick each'),
  }),
  execute: ({ action, key, fact, scope, category }) => {
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
