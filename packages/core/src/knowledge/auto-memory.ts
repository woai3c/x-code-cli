// @x-code-cli/core — AutoMemory class (key-based CRUD + conflict detection + TTL eviction)
import fs from 'node:fs/promises'
import path from 'node:path'

import type { KnowledgeFact } from '../types/index.js'
import { GLOBAL_XCODE_DIR, XCODE_DIR } from '../utils.js'

const MAX_LOAD_LINES = 200

/**
 * Collapse newlines and trim whitespace — keeps the serialized line-per-fact
 * invariant intact even if a caller passes multi-line content. Returns '' for
 * falsy input so callers don't have to null-check.
 */
function sanitizeLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

class AutoMemory {
  private facts: KnowledgeFact[] = []
  private filePath: string
  /** Queued save promise – prevents concurrent writes */
  private saveQueue: Promise<void> = Promise.resolve()

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
    // Sanitize so embedded newlines can't break the markdown line format.
    const fact: KnowledgeFact = {
      ...newFact,
      key: sanitizeLine(newFact.key),
      fact: sanitizeLine(newFact.fact),
    }
    const conflictIndex = this.facts.findIndex(
      (existing) => existing.category === fact.category && existing.key === fact.key,
    )
    if (conflictIndex >= 0) {
      this.facts[conflictIndex] = fact
    } else {
      this.facts.push(fact)
    }
    this.enqueueSave()
  }

  /** Delete by key (optionally scoped to category) */
  delete(key: string, category?: string): void {
    this.facts = this.facts.filter((f) => !(f.key === key && (!category || f.category === category)))
    this.enqueueSave()
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

  /**
   * Enqueue a save so that concurrent add/delete calls are serialized.
   * Each save waits for the previous one to finish before writing.
   */
  private enqueueSave(): void {
    this.saveQueue = this.saveQueue.then(() => this.save())
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
//
// Project memory is keyed by cwd so that if the process ever changes its
// working directory (e.g. embedding in a daemon or test harness), we get a
// fresh instance bound to the right file rather than silently reusing the
// stale one. Global memory is a true singleton — its path is fixed by
// GLOBAL_XCODE_DIR.

const projectMemories = new Map<string, AutoMemory>()
let globalMemory: AutoMemory | null = null

function projectMemoryPath(cwd: string): string {
  return path.join(cwd, XCODE_DIR, 'memory', 'auto.md')
}

export function getAutoMemory(scope: 'project' | 'global'): AutoMemory {
  if (scope === 'project') {
    const filePath = projectMemoryPath(process.cwd())
    let mem = projectMemories.get(filePath)
    if (!mem) {
      mem = new AutoMemory(filePath)
      projectMemories.set(filePath, mem)
    }
    return mem
  }
  if (!globalMemory) {
    globalMemory = new AutoMemory(path.join(GLOBAL_XCODE_DIR, 'memory', 'auto.md'))
  }
  return globalMemory
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
