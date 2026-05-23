// @x-code-cli/core — Custom sub-agent loader
//
// Scans ~/.x-code/agents/*.md and <repo-root>/.x-code/agents/*.md for
// user-defined sub-agents with YAML frontmatter. Bad files are skipped
// with a warning to stderr — one broken agent file must never crash the CLI.
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { GLOBAL_XCODE_DIR, XCODE_DIR } from '../../utils.js'
import type { SubAgentDefinition } from './types.js'

const frontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  shellRestrictions: z.array(z.string()).optional(),
})

/** Minimal YAML frontmatter parser. Handles the subset we need:
 *  string scalars, number scalars, and inline/flow arrays.
 *  No dependency on gray-matter — keeps the install lean. */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]!
  const body = match[2]!
  const data: Record<string, unknown> = {}

  // Fold YAML continuation lines: an indented non-empty line is joined to
  // the previous line with a single space. Matches the folded-scalar form
  // commonly used for long `description:` values in agent frontmatter.
  const foldedLines: string[] = []
  for (const line of yamlBlock.split(/\r?\n/)) {
    if (/^\s/.test(line) && line.trim() && foldedLines.length > 0) {
      foldedLines[foldedLines.length - 1] += ' ' + line.trim()
    } else {
      foldedLines.push(line)
    }
  }

  for (const line of foldedLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    let value: string | number | string[] = trimmed.slice(colonIdx + 1).trim()

    // Inline array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1)
      data[key] = inner
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
      continue
    }

    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    // Number
    if (/^\d+$/.test(value)) {
      data[key] = parseInt(value, 10)
      continue
    }

    data[key] = value
  }

  return { data, body }
}

async function loadAgentsFromDir(dir: string, source: SubAgentDefinition['source']): Promise<SubAgentDefinition[]> {
  const agents: SubAgentDefinition[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return agents
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = path.join(dir, entry)

    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = parseFrontmatter(raw)
      if (!parsed) {
        console.error(`[sub-agents] Skipping ${filePath}: no valid YAML frontmatter`)
        continue
      }

      const result = frontmatterSchema.safeParse(parsed.data)
      if (!result.success) {
        console.error(
          `[sub-agents] Skipping ${filePath}: invalid frontmatter — ${result.error.issues.map((i) => i.message).join(', ')}`,
        )
        continue
      }

      const fm = result.data
      agents.push({
        name: fm.name,
        description: fm.description,
        prompt: parsed.body.trim(),
        tools: fm.tools,
        disallowedTools: fm.disallowedTools,
        model: fm.model,
        maxTurns: fm.maxTurns ?? 30,
        shellRestrictions: fm.shellRestrictions,
        source,
      })
    } catch (err) {
      console.error(`[sub-agents] Skipping ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return agents
}

/** Load custom sub-agents from global + project directories.
 *  Environment variable `XC_AGENTS_DIR` overrides paths (testing only). */
export async function loadCustomAgents(): Promise<SubAgentDefinition[]> {
  const override = process.env.XC_AGENTS_DIR
  if (override) {
    return loadAgentsFromDir(override, 'project')
  }

  const globalDir = path.join(GLOBAL_XCODE_DIR, 'agents')
  const projectDir = path.join(process.cwd(), XCODE_DIR, 'agents')

  const globalAgents = await loadAgentsFromDir(globalDir, 'global')
  const projectAgents = await loadAgentsFromDir(projectDir, 'project')

  return [...globalAgents, ...projectAgents]
}
