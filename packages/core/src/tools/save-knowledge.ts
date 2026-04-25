// @x-code-cli/core — saveKnowledge tool (AI-written persistent memory)
import { tool } from 'ai'

import { z } from 'zod'

import { getAutoMemory } from '../knowledge/auto-memory.js'
import { formatToolError } from '../utils/tool-errors.js'

export const saveKnowledge = tool({
  description: `Save or delete a persistent memory that should survive across sessions.

Before calling this tool, ask yourself: **"Will a future session plausibly act better because I save this?"** If not — do NOT call the tool. No-op is the default; saving is the exception. This tool is strictly for durable, cross-session knowledge.

Every memory MUST be filed under one of four categories — pick the one that describes the TYPE of knowledge, not the topic:

  user       — Facts about the human user: their role, expertise, goals, long-term constraints. Example: "user is a senior Go engineer new to this frontend".
  feedback   — Corrections or validated approaches the user has given. Save both when the user corrects you AND when they confirm a non-obvious choice worked. Include WHY so edge cases are judgeable. Example: "integration tests must hit real DB, not mocks — prior incident where mocks masked broken migration".
  project    — Ongoing work, initiatives, deadlines, non-obvious project state that would NOT be derivable from reading code or git log. Example: "merge freeze begins 2026-03-05 for mobile release cut".
  reference  — Pointers to external systems. Example: "pipeline bugs tracked in Linear project INGEST".

Do NOT save any of these (these are the common failure modes):
- The user's current task or request ("user asked me to build a snake game") — this is transient, not durable
- Summaries of code you just wrote, bugs you just fixed, or findings from the current turn
- Anything derivable from the code or git log (tech stack, package.json scripts, dependencies, directory layout) — future sessions can read the code
- Content already in AGENTS.md / CLAUDE.md
- Debugging solutions (the fix is in the code; the commit has the context)
- Duplicates or near-duplicates of an existing memory — update the existing one instead

Even if the user says "remember X" — if X is one-off task context (a specific request, a game they wanted), still decline. Ask yourself what is *surprising* or *durable* about it; if nothing, no-op.

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
      return formatToolError('saving knowledge', err)
    }
  },
})
