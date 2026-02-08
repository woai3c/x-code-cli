// @x-code/core — AutoMemory class (key-based CRUD + conflict detection + TTL eviction)

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { KnowledgeFact } from '../types/index.js'

const MAX_LOAD_LINES = 200

class AutoMemory {
  private facts: KnowledgeFact[] = []
  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /** Load from markdown file */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8')
      this.facts = parseMemoryFile(content)
    } catch {
      this.facts = []
    }
  }

  /** Add or update: same category + same key → replace */
  add(newFact: KnowledgeFact): void {
    const conflictIndex = this.facts.findIndex(
      (existing) => existing.category === newFact.category && existing.key === newFact.key,
    )
    if (conflictIndex >= 0) {
      this.facts[conflictIndex] = newFact
    } else {
      this.facts.push(newFact)
    }
    this.save()
  }

  /** Delete by key (optionally scoped to category) */
  delete(key: string, category?: string): void {
    this.facts = this.facts.filter((f) => !(f.key === key && (!category || f.category === category)))
    this.save()
  }

  /** Find a fact by key and optional category */
  find(key: string, category?: string): KnowledgeFact | undefined {
    return this.facts.find((f) => f.key === key && (!category || f.category === category))
  }

  /** Evict facts older than maxAgeDays */
  evict(maxAgeDays: number = 90): void {
    const cutoff = Date.now() - maxAgeDays * 86400_000
    const before = this.facts.length
    this.facts = this.facts.filter((f) => new Date(f.date).getTime() > cutoff)
    if (this.facts.length < before) this.save()
  }

  /** Get all facts */
  getAll(): KnowledgeFact[] {
    return [...this.facts]
  }

  /** Get content for system prompt injection (first MAX_LOAD_LINES) */
  getPromptContent(): string {
    const content = this.serialize()
    const lines = content.split('\n')
    if (lines.length > MAX_LOAD_LINES) {
      return lines.slice(0, MAX_LOAD_LINES).join('\n') + '\n... (truncated)'
    }
    return content
  }

  /** Serialize to markdown format */
  private serialize(): string {
    if (this.facts.length === 0) return ''

    const categories = new Map<string, KnowledgeFact[]>()
    for (const fact of this.facts) {
      const list = categories.get(fact.category) ?? []
      list.push(fact)
      categories.set(fact.category, list)
    }

    const sections: string[] = ['## Auto Memory', '']
    for (const [category, facts] of categories) {
      sections.push(`### ${category}`)
      for (const f of facts) {
        sections.push(`- [${f.date}] ${f.key}: ${f.fact}`)
      }
      sections.push('')
    }

    return sections.join('\n')
  }

  /** Save to file */
  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.writeFile(this.filePath, this.serialize(), 'utf-8')
    } catch {
      // Silently fail — don't crash agent if memory write fails
    }
  }
}

/** Parse markdown memory file back to facts */
function parseMemoryFile(content: string): KnowledgeFact[] {
  const facts: KnowledgeFact[] = []
  let currentCategory = ''

  for (const line of content.split('\n')) {
    const categoryMatch = line.match(/^### (.+)$/)
    if (categoryMatch) {
      currentCategory = categoryMatch[1].trim()
      continue
    }

    const factMatch = line.match(/^- \[(\d{4}-\d{2}-\d{2})\] (.+?):\s*(.+)$/)
    if (factMatch && currentCategory) {
      facts.push({
        date: factMatch[1],
        key: factMatch[2].trim(),
        fact: factMatch[3].trim(),
        category: currentCategory as KnowledgeFact['category'],
      })
    }
  }

  return facts
}

// ─── Singleton instances ───

let projectMemory: AutoMemory | null = null
let globalMemory: AutoMemory | null = null

export function getAutoMemory(scope: 'project' | 'global'): AutoMemory {
  if (scope === 'project') {
    if (!projectMemory) {
      projectMemory = new AutoMemory(path.join(process.cwd(), '.x-code', 'memory', 'auto.md'))
    }
    return projectMemory
  } else {
    if (!globalMemory) {
      globalMemory = new AutoMemory(path.join(os.homedir(), '.xcode', 'memory', 'auto.md'))
    }
    return globalMemory
  }
}

/** Initialize memories (load from disk + evict old entries) */
export async function initMemories(): Promise<void> {
  const project = getAutoMemory('project')
  const global = getAutoMemory('global')
  await Promise.all([project.load(), global.load()])
  project.evict(90)
  global.evict(90)
}

export { AutoMemory }
