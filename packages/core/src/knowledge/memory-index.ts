import path from 'node:path'

import type { MemoryFact, MemoryTopic } from './memory-types.js'

const WORD_RE = /[\p{L}\p{M}\p{N}]+/gu

export function isMemoryFactActive(fact: MemoryFact, now = Date.now()): boolean {
  return fact.metadata.status === 'active' && (!fact.metadata.expiresAt || Date.parse(fact.metadata.expiresAt) > now)
}

function searchableTopicBody(topic: MemoryTopic): string {
  let manual = topic.body
  for (const fact of [...topic.facts].sort((a, b) => b.start - a.start)) {
    manual = manual.slice(0, fact.start) + manual.slice(fact.end)
  }
  const activeFacts = topic.facts.filter((fact) => isMemoryFactActive(fact)).map((fact) => fact.content)
  return `${manual}\n${activeFacts.join('\n')}`
}

export function normalizeMemoryText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\\/g, '/')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenizeMemoryText(value: string): string[] {
  const normalized = normalizeMemoryText(value)
  const tokens = normalized.match(WORD_RE) ?? []
  const result = new Set<string>()
  const source = value.normalize('NFKC')
  const identifiers =
    source.match(/\b(?:[A-Za-z_$][\w$]*(?:[.:-][A-Za-z_$][\w$]*)+|[A-Za-z_$][\w$]*[A-Z][\w$]*)\b/g) ?? []
  for (const identifier of identifiers) result.add(identifier.toLowerCase())
  for (const token of tokens) {
    result.add(token)
    for (const run of token.match(/[^\x00-\x7F]+/g) ?? []) {
      result.add(run)
      const chars = [...run]
      if (chars.length > 64) continue
      for (let size = 2; size <= 3; size++) {
        for (let index = 0; index + size <= chars.length; index++) result.add(chars.slice(index, index + size).join(''))
      }
    }
  }
  return [...result]
}

export function extractMemoryPaths(value: string): string[] {
  const matches = value.match(/(?:[A-Za-z]:[\\/]|\.?\.?[\\/]|\/)[^\s"'`<>|]+/g) ?? []
  return [...new Set(matches.map((item) => item.replace(/[),.;:]+$/, '').replace(/\\/g, '/')))]
}

export function extractMemoryIdentifiers(value: string): string[] {
  const codeIdentifiers =
    value.match(/\b(?:[A-Za-z_$][\w$]*(?:[.:-][A-Za-z_$][\w$]*)+|[A-Z][A-Z0-9_]{2,}|[A-Za-z_$][\w$]*[A-Z][\w$]*)\b/g) ??
    []
  const scopedPackages = value.match(/@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/gi) ?? []
  return [...new Set([...codeIdentifiers, ...scopedPackages].map((item) => item.normalize('NFKC')))]
}

interface IndexedTopic {
  topic: MemoryTopic
  fields: {
    id: string[]
    aliases: string[]
    keywords: string[]
    description: string[]
    heading: string[]
    body: string[]
  }
  tokenCounts: Map<string, number>
  tokenLength: number
  exactKeys: string[]
}

export interface IndexedFactLocation {
  topicId: string
  sectionId: string
  factHash: string
  observedAt: string
  evidence: MemoryFact['metadata']['evidence']
  status: MemoryFact['metadata']['status']
}

export interface Bm25Hit {
  topicId: string
  score: number
  coverage: number
}

function counts(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1)
  return result
}

function basename(value: string): string {
  return path.posix.basename(value.replace(/\\/g, '/'))
}

export class MemoryIndex {
  generation = 0
  readonly topics = new Map<string, MemoryTopic>()
  readonly facts = new Map<string, IndexedFactLocation>()
  private indexed = new Map<string, IndexedTopic>()
  private documentFrequency = new Map<string, number>()
  private exact = new Map<string, Set<string>>()
  private averageLength = 1

  rebuild(topics: readonly MemoryTopic[], generation: number): void {
    this.generation = generation
    this.topics.clear()
    this.facts.clear()
    this.indexed.clear()
    this.documentFrequency.clear()
    this.exact.clear()

    let totalLength = 0
    for (const topic of topics) {
      this.topics.set(topic.metadata.id, topic)
      for (const fact of topic.facts) {
        this.facts.set(fact.metadata.id, {
          topicId: topic.metadata.id,
          sectionId: fact.sectionId,
          factHash: fact.hash,
          observedAt: fact.metadata.observedAt,
          evidence: fact.metadata.evidence,
          status: isMemoryFactActive(fact) ? 'active' : 'stale',
        })
      }
      const fields = {
        id: tokenizeMemoryText(topic.metadata.id),
        aliases: tokenizeMemoryText(topic.metadata.aliases.join(' ')),
        keywords: tokenizeMemoryText(topic.metadata.keywords.join(' ')),
        description: tokenizeMemoryText(topic.metadata.description),
        heading: tokenizeMemoryText(topic.sections.flatMap((section) => section.headingPath).join(' ')),
        body: tokenizeMemoryText(searchableTopicBody(topic)),
      }
      const all = Object.values(fields).flat()
      const tokenCounts = counts(all)
      const exactKeys = uniqueExactKeys(topic)
      const indexed: IndexedTopic = { topic, fields, tokenCounts, tokenLength: all.length || 1, exactKeys }
      this.indexed.set(topic.metadata.id, indexed)
      totalLength += indexed.tokenLength
      for (const token of tokenCounts.keys()) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1)
      }
      for (const key of exactKeys) {
        const owners = this.exact.get(key) ?? new Set<string>()
        owners.add(topic.metadata.id)
        this.exact.set(key, owners)
      }
    }
    this.averageLength = this.indexed.size ? totalLength / this.indexed.size : 1
  }

  exactHits(query: string, paths: readonly string[], identifiers: readonly string[]): Map<string, number> {
    const scores = new Map<string, number>()
    const normalizedQuery = normalizeMemoryText(query)
    const keys = new Set<string>([
      normalizedQuery,
      ...paths.flatMap((item) => [normalizeMemoryText(item), normalizeMemoryText(basename(item))]),
      ...identifiers.map(normalizeMemoryText),
    ])
    for (const key of keys) {
      if (!key) continue
      for (const [exactKey, owners] of this.exact) {
        if (key !== exactKey && !normalizedQuery.includes(exactKey)) continue
        const specificity =
          key === exactKey ? 1 : Math.min(0.9, exactKey.length / Math.max(normalizedQuery.length, 1) + 0.35)
        for (const owner of owners) scores.set(owner, Math.max(scores.get(owner) ?? 0, specificity))
      }
    }
    return scores
  }

  bm25(query: string): Bm25Hit[] {
    const queryTokens = tokenizeMemoryText(query)
    if (queryTokens.length === 0) return []
    const fieldWeights = { id: 6, aliases: 6, keywords: 5, description: 3, heading: 2, body: 1 } as const
    const hits: Bm25Hit[] = []
    for (const indexed of this.indexed.values()) {
      let score = 0
      let matched = 0
      for (const token of queryTokens) {
        let weightedFrequency = 0
        for (const [field, weight] of Object.entries(fieldWeights) as Array<[keyof typeof fieldWeights, number]>) {
          weightedFrequency += indexed.fields[field].filter((value) => value === token).length * weight
        }
        if (weightedFrequency <= 0) continue
        matched++
        const df = this.documentFrequency.get(token) ?? 0
        const idf = Math.log(1 + (this.indexed.size - df + 0.5) / (df + 0.5))
        const denominator = weightedFrequency + 1.2 * (1 - 0.75 + 0.75 * (indexed.tokenLength / this.averageLength))
        score += idf * ((weightedFrequency * 2.2) / denominator)
      }
      if (score > 0) hits.push({ topicId: indexed.topic.metadata.id, score, coverage: matched / queryTokens.length })
    }
    return hits.sort((a, b) => b.score - a.score || a.topicId.localeCompare(b.topicId)).slice(0, 20)
  }

  manifest(topicIds?: readonly string[]): Array<{
    id: string
    type: MemoryTopic['metadata']['type']
    description: string
    aliases: string[]
    keywords: string[]
    appliesTo: string[]
    pinned: boolean
  }> {
    const allowed = topicIds ? new Set(topicIds) : null
    return [...this.topics.values()]
      .filter((topic) => !allowed || allowed.has(topic.metadata.id))
      .map((topic) => ({
        id: topic.metadata.id,
        type: topic.metadata.type,
        description: topic.metadata.description,
        aliases: topic.metadata.aliases,
        keywords: topic.metadata.keywords,
        appliesTo: topic.metadata.appliesTo,
        pinned: topic.metadata.pinned,
      }))
  }

  compactFactRegistry(maxTokens = 2000, preferredTopicIds: readonly string[] = []): string {
    const lines: string[] = []
    let tokens = 0
    const preferred = new Set(preferredTopicIds)
    const topics = [...this.topics.values()].sort(
      (a, b) =>
        Number(preferred.has(b.metadata.id)) - Number(preferred.has(a.metadata.id)) ||
        Date.parse(b.metadata.updatedAt) - Date.parse(a.metadata.updatedAt) ||
        a.metadata.id.localeCompare(b.metadata.id),
    )
    for (const topic of topics) {
      for (const fact of topic.facts.filter((item) => isMemoryFactActive(item))) {
        const summary = fact.content.replace(/\s+/g, ' ').slice(0, 180)
        const line = `${fact.metadata.id}\t${topic.metadata.id}\t${topic.metadata.type}\t${summary}`
        const lineTokens = Math.ceil(Buffer.byteLength(line, 'utf-8') / 3)
        if (tokens + lineTokens > maxTokens) return lines.join('\n')
        lines.push(line)
        tokens += lineTokens
      }
    }
    return lines.join('\n')
  }

  topicTokens(topicId: string): Set<string> {
    return new Set(this.indexed.get(topicId)?.tokenCounts.keys() ?? [])
  }
}

function uniqueExactKeys(topic: MemoryTopic): string[] {
  const values = [
    topic.metadata.id,
    ...topic.metadata.aliases,
    ...topic.metadata.appliesTo,
    ...topic.metadata.appliesTo.map(basename),
    ...topic.sections.flatMap((section) => section.headingPath),
    ...topic.metadata.keywords.filter((value) => /[A-Z0-9_.:-]/i.test(value)),
  ]
  return [...new Set(values.map(normalizeMemoryText).filter((value) => value.length >= 2))]
}
