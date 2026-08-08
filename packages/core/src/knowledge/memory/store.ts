import fs from 'node:fs/promises'
import path from 'node:path'

import { parseFrontmatter } from '../../frontmatter.js'
import { estimateTextTokens, fileExists, truncateUtf8 } from '../../utils.js'
import { atomicWriteFile } from '../../utils/atomic-file.js'
import { redactMemoryText } from './redaction.js'
import { MemoryTransactionStore, memoryContentHash } from './transaction-store.js'
import { MEMORY_ID_RE, SAFE_JOB_ID_RE } from './types.js'
import type {
  EvidenceKind,
  MemoryChange,
  MemoryFact,
  MemoryFactMetadata,
  MemoryOperation,
  MemoryOperationResult,
  MemorySection,
  MemoryStatus,
  MemoryTopic,
  MemoryTopicMetadata,
  MemoryType,
  TopicMetadataPatch,
} from './types.js'

const FACT_MARKER_RE = /<!--\s*x-memory:\s*(\{[^\n]*\})\s*-->/g
const VALID_TYPES = new Set<MemoryType>(['user', 'portfolio', 'feedback', 'workflow', 'project', 'reference'])
const VALID_EVIDENCE = new Set<EvidenceKind>(['explicit', 'validated', 'observed'])
const VALID_STATUS = new Set<MemoryStatus>(['active', 'stale'])

export interface MemoryCommitContext {
  jobId: string
  sourceOccurredAt: string
}

export interface MemoryLoadResult {
  topics: MemoryTopic[]
  invalidTopics: Array<{ path: string; error: string }>
  generation: number
}

function isolateInvalidTopics(
  topics: MemoryTopic[],
  invalidTopics: Array<{ path: string; error: string }>,
): MemoryTopic[] {
  const invalidPaths = new Set(invalidTopics.map((item) => item.path))
  const owners = new Map<string, MemoryTopic>()
  for (const topic of topics) {
    for (const fact of topic.facts) {
      const owner = owners.get(fact.metadata.id)
      if (!owner) {
        owners.set(fact.metadata.id, topic)
        continue
      }
      const error = `Duplicate fact ID across topics: ${fact.metadata.id}`
      for (const duplicate of [owner, topic]) {
        if (invalidPaths.has(duplicate.path)) continue
        invalidPaths.add(duplicate.path)
        invalidTopics.push({ path: duplicate.path, error })
      }
    }
  }
  let foundInvalidRelation = true
  while (foundInvalidRelation) {
    foundInvalidRelation = false
    const activeIds = new Set(topics.filter((topic) => !invalidPaths.has(topic.path)).map((topic) => topic.metadata.id))
    for (const topic of topics) {
      if (invalidPaths.has(topic.path)) continue
      const missing = topic.metadata.related.filter((id) => !activeIds.has(id))
      if (!missing.length) continue
      invalidPaths.add(topic.path)
      invalidTopics.push({ path: topic.path, error: `Unknown related topic: ${missing.join(', ')}` })
      foundInvalidRelation = true
    }
  }
  return topics.filter((topic) => !invalidPaths.has(topic.path))
}

function canonicalText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

function cleanLine(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(cleanLine).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function parseTopicFrontmatter(raw: string): { data: Record<string, string | boolean | string[]>; body: string } {
  const result = parseFrontmatter(raw, { blockLists: true })
  if (!result) throw new Error('Missing YAML frontmatter')
  return result as { data: Record<string, string | boolean | string[]>; body: string }
}

function requiredString(data: Record<string, string | boolean | string[]>, key: string): string {
  const value = data[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing frontmatter field: ${key}`)
  return value.trim()
}

function optionalString(data: Record<string, string | boolean | string[]>, key: string): string {
  const value = data[key]
  return typeof value === 'string' ? value.trim() : ''
}

function stringArray(data: Record<string, string | boolean | string[]>, key: string, maxItemChars?: number): string[] {
  const value = data[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`Frontmatter field ${key} must be a list`)
  const result = uniqueSorted(value)
  if (maxItemChars && result.some((item) => [...item].length > maxItemChars)) {
    throw new Error(`Frontmatter field ${key} contains an item over ${maxItemChars} characters`)
  }
  return result
}

function headingLevelAt(body: string, offset: number): number {
  const heading = /^(#{1,3})\s+.+$/gm
  let level = 0
  let match: RegExpExecArray | null
  while ((match = heading.exec(body)) && match.index < offset) level = match[1]!.length
  return level
}

function nextFactBoundary(
  body: string,
  markerStart: number,
  markerEnd: number,
  nextMarker: number | undefined,
): number {
  let end = nextMarker ?? body.length
  const currentLevel = headingLevelAt(body, markerStart)
  const heading = /^(#{1,3})\s+.+$/gm
  heading.lastIndex = markerEnd
  let nextHeading: RegExpExecArray | null
  while ((nextHeading = heading.exec(body))) {
    if (nextHeading.index >= end) break
    if (currentLevel === 0 || nextHeading[1]!.length <= currentLevel) {
      end = nextHeading.index
      break
    }
  }
  return end
}

function parseFacts(body: string): MemoryFact[] {
  const matches: Array<{ index: number; end: number; json: string }> = []
  FACT_MARKER_RE.lastIndex = 0
  let marker: RegExpExecArray | null
  while ((marker = FACT_MARKER_RE.exec(body))) {
    matches.push({ index: marker.index, end: FACT_MARKER_RE.lastIndex, json: marker[1]! })
  }
  const facts: MemoryFact[] = []
  const ids = new Set<string>()
  for (let index = 0; index < matches.length; index++) {
    const current = matches[index]!
    let metadata: MemoryFactMetadata
    try {
      metadata = JSON.parse(current.json) as MemoryFactMetadata
    } catch {
      throw new Error(`Invalid x-memory JSON near byte ${current.index}`)
    }
    if (!metadata.id || !MEMORY_ID_RE.test(metadata.id)) throw new Error(`Invalid fact ID: ${String(metadata.id)}`)
    if (ids.has(metadata.id)) throw new Error(`Duplicate fact ID: ${metadata.id}`)
    ids.add(metadata.id)
    if (!VALID_EVIDENCE.has(metadata.evidence)) throw new Error(`Invalid evidence for ${metadata.id}`)
    if (!VALID_STATUS.has(metadata.status)) throw new Error(`Invalid status for ${metadata.id}`)
    if (!Number.isFinite(Date.parse(metadata.observedAt))) throw new Error(`Invalid observedAt for ${metadata.id}`)
    if (metadata.expiresAt && !Number.isFinite(Date.parse(metadata.expiresAt))) {
      throw new Error(`Invalid expiresAt for ${metadata.id}`)
    }
    const end = nextFactBoundary(body, current.index, current.end, matches[index + 1]?.index)
    const content = canonicalText(body.slice(current.end, end))
    if (!content) throw new Error(`Empty fact content: ${metadata.id}`)
    facts.push({
      metadata,
      content,
      hash: memoryContentHash(content),
      start: current.index,
      end,
    })
  }
  return facts
}

function parseSections(body: string, facts: MemoryFact[]) {
  const headings: Array<{ index: number; contentStart: number; level: number; title: string }> = []
  const pattern = /^(#{2,3})\s+(.+)$/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body))) {
    headings.push({
      index: match.index,
      contentStart: pattern.lastIndex,
      level: match[1]!.length,
      title: match[2]!.trim(),
    })
  }
  if (headings.length === 0) {
    return [
      {
        headingPath: [],
        content: canonicalText(body),
        facts: [...facts],
        estimatedTokens: estimateTextTokens(body),
      },
    ]
  }
  const sections: MemorySection[] = []
  const preambleEnd = headings[0]!.index
  const preamble = canonicalText(body.slice(0, preambleEnd))
  const preambleFacts = facts.filter((fact) => fact.start < preambleEnd)
  if (preambleFacts.length > 0 || preamble.replace(/^#{1,3}\s+.*$/gm, '').trim()) {
    sections.push({
      headingPath: [],
      content: preamble,
      facts: preambleFacts,
      estimatedTokens: estimateTextTokens(preamble),
    })
  }
  for (const [index, heading] of headings.entries()) {
    const end = headings[index + 1]?.index ?? body.length
    const before = headings.slice(0, index + 1)
    const pathParts: string[] = []
    for (const item of before) {
      pathParts.splice(item.level - 2)
      pathParts[item.level - 2] = item.title
    }
    const headingPath = pathParts.filter(Boolean)
    const content = canonicalText(body.slice(heading.index, end))
    sections.push({
      headingPath,
      content,
      facts: facts.filter((fact) => fact.start >= heading.index && fact.start < end),
      estimatedTokens: estimateTextTokens(content),
    })
  }
  return sections
}

export function parseMemoryTopic(raw: string, filePath: string): MemoryTopic {
  const { data, body } = parseTopicFrontmatter(raw)
  const id = requiredString(data, 'id')
  if (!MEMORY_ID_RE.test(id)) throw new Error(`Invalid topic ID: ${id}`)
  if (path.basename(filePath, '.md') !== id) throw new Error(`Topic ID does not match filename: ${id}`)
  const type = requiredString(data, 'type') as MemoryType
  if (!VALID_TYPES.has(type)) throw new Error(`Invalid topic type: ${type}`)
  const status = requiredString(data, 'status') as MemoryStatus
  if (!VALID_STATUS.has(status)) throw new Error(`Invalid topic status: ${status}`)
  const createdAt = requiredString(data, 'created_at')
  const updatedAt = requiredString(data, 'updated_at')
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error('Invalid topic timestamp')
  }
  const facts = parseFacts(body)
  if (
    (type === 'user' || type === 'portfolio' || type === 'feedback') &&
    facts.some((fact) => fact.metadata.expiresAt)
  ) {
    throw new Error(`Stable ${type} facts cannot define expiresAt`)
  }
  const derivedStatus: MemoryStatus = facts.some((fact) => fact.metadata.status === 'active') ? 'active' : 'stale'
  if (facts.length > 0 && status !== derivedStatus) throw new Error(`Topic status must be ${derivedStatus}`)
  const pinned = data.pinned === true
  const summary = optionalString(data, 'summary')
  if (pinned && !summary) throw new Error('Pinned topic requires summary')
  if (pinned && type !== 'user' && type !== 'portfolio' && type !== 'feedback') {
    throw new Error(`Only stable user, portfolio, or feedback topics may be pinned`)
  }
  if (estimateTextTokens(summary) > 120) throw new Error('Topic summary exceeds 120 tokens')
  const metadata: MemoryTopicMetadata = {
    id,
    type,
    description: requiredString(data, 'description'),
    summary,
    createdAt,
    updatedAt,
    status: facts.length === 0 ? status : derivedStatus,
    keywords: stringArray(data, 'keywords', 80),
    aliases: stringArray(data, 'aliases', 80),
    appliesTo: stringArray(data, 'applies_to'),
    related: stringArray(data, 'related'),
    pinned,
  }
  if (metadata.related.length > 8) throw new Error('Topic related list exceeds 8 entries')
  return {
    metadata,
    body,
    facts,
    sections: parseSections(body, facts),
    hash: memoryContentHash(raw.replace(/\r\n/g, '\n')),
    path: filePath,
    raw: raw.replace(/\r\n/g, '\n'),
  }
}

function yamlScalar(value: string): string {
  if (!value || /^[-?:,[\]{}#&*!|>'"%@`] |\s$/.test(value) || value.includes('\n')) return JSON.stringify(value)
  return value
}

function renderList(key: string, values: readonly string[]): string[] {
  if (values.length === 0) return [`${key}: []`]
  return [`${key}:`, ...values.map((value) => `  - ${yamlScalar(value)}`)]
}

export function formatMemoryTopic(topic: MemoryTopic): string {
  const m = topic.metadata
  const lines = [
    '---',
    `id: ${m.id}`,
    `type: ${m.type}`,
    `description: ${yamlScalar(cleanLine(m.description))}`,
    `summary: ${yamlScalar(cleanLine(m.summary))}`,
    `created_at: ${m.createdAt}`,
    `updated_at: ${m.updatedAt}`,
    `status: ${m.status}`,
    ...renderList('keywords', uniqueSorted(m.keywords)),
    ...renderList('aliases', uniqueSorted(m.aliases)),
    ...renderList('applies_to', uniqueSorted(m.appliesTo)),
    ...renderList('related', uniqueSorted(m.related)),
    `pinned: ${m.pinned ? 'true' : 'false'}`,
    '---',
    '',
    topic.body.replace(/\r\n/g, '\n').trimEnd(),
    '',
  ]
  return lines.join('\n')
}

function applyPatch(metadata: MemoryTopicMetadata, patch: TopicMetadataPatch | undefined): void {
  if (!patch) return
  if (patch.type) metadata.type = patch.type
  if (patch.description !== undefined) metadata.description = cleanLine(redactMemoryText(patch.description))
  if (patch.summary !== undefined) metadata.summary = cleanLine(redactMemoryText(patch.summary))
  metadata.keywords = uniqueSorted([
    ...metadata.keywords.filter((item) => !(patch.removeKeywords ?? []).includes(item)),
    ...(patch.addKeywords ?? []).map(redactMemoryText),
  ])
  metadata.aliases = uniqueSorted([
    ...metadata.aliases.filter((item) => !(patch.removeAliases ?? []).includes(item)),
    ...(patch.addAliases ?? []).map(redactMemoryText),
  ])
  if (patch.appliesTo) metadata.appliesTo = uniqueSorted(patch.appliesTo.map(redactMemoryText))
  if (patch.related) metadata.related = uniqueSorted(patch.related).slice(0, 8)
  if (patch.pinned !== undefined) metadata.pinned = patch.pinned
}

function cloneTopic(topic: MemoryTopic): MemoryTopic {
  return structuredClone(topic)
}

function removeFactBlocks(topic: MemoryTopic, ids: ReadonlySet<string>): void {
  const targets = topic.facts.filter((fact) => ids.has(fact.metadata.id)).sort((a, b) => b.start - a.start)
  let body = topic.body
  for (const target of targets) body = body.slice(0, target.start) + body.slice(target.end)
  topic.body = body.trimEnd() + '\n'
}

function latestEvidence(evidence: MemoryOperation['evidence']): MemoryOperation['evidence'][number] | undefined {
  return [...evidence].sort(
    (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || evidenceRank(b.kind) - evidenceRank(a.kind),
  )[0]
}

function factMetadata(evidence: MemoryOperation['evidence']): MemoryFactMetadata {
  const latest = latestEvidence(evidence)
  if (!latest) throw new Error('Memory operation requires evidence')
  return { id: '', observedAt: latest.occurredAt, evidence: latest.kind, status: 'active' }
}

function appendFact(topic: MemoryTopic, factId: string, content: string, evidence: MemoryOperation['evidence']): void {
  const clean = canonicalText(content)
  if (!clean || clean.includes('<!-- x-memory:')) throw new Error(`Invalid fact content: ${factId}`)
  if (Buffer.byteLength(clean, 'utf-8') > 8 * 1024) throw new Error(`Fact content exceeds 8 KiB: ${factId}`)
  topic.body = topic.body.replace(/\r\n/g, '\n').trimEnd()
  if (!/^#{2,3}\s/m.test(topic.body)) topic.body += '\n\n## Facts'
  const metadata = factMetadata(evidence)
  metadata.id = factId
  const marker = `<!-- x-memory: ${JSON.stringify(metadata)} -->`
  topic.body = `${topic.body}\n\n${marker}\n\n${clean}\n`
}

function derivedFactSummary(facts: readonly MemoryFact[]): string {
  const derived = facts
    .filter((fact) => fact.metadata.status === 'active')
    .map((fact) => fact.content)
    .join(' ')
    .replace(/<!--[^]*?-->/g, '')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
  return cleanLine(truncateUtf8(derived, 360))
}

function refreshTopic(topic: MemoryTopic, now: string, refreshDescription = false): MemoryTopic {
  topic.metadata.updatedAt = now
  const rawFacts = parseFacts(topic.body)
  topic.metadata.status = rawFacts.some((fact) => fact.metadata.status === 'active') ? 'active' : 'stale'
  if (refreshDescription) {
    const description = derivedFactSummary(rawFacts)
    if (description) topic.metadata.description = description
  }
  if (topic.metadata.pinned) {
    topic.metadata.summary = derivedFactSummary(rawFacts)
    if (!topic.metadata.summary) topic.metadata.pinned = false
  }
  const raw = formatMemoryTopic(topic)
  return parseMemoryTopic(raw, topic.path)
}

function hasManualContent(topic: MemoryTopic): boolean {
  let body = topic.body
  for (const fact of [...topic.facts].sort((a, b) => b.start - a.start))
    body = body.slice(0, fact.start) + body.slice(fact.end)
  body = body.replace(/^#{1,3}\s+.*$/gm, '').replace(/\s/g, '')
  return body.length > 0
}

function newTopic(
  memoryRoot: string,
  topicId: string,
  patch: TopicMetadataPatch | undefined,
  now: string,
): MemoryTopic {
  if (!MEMORY_ID_RE.test(topicId)) throw new Error(`Invalid topic ID: ${topicId}`)
  if (!patch?.type || !patch.description || !patch.addAliases?.length || !patch.addKeywords?.length) {
    throw new Error(`New topic ${topicId} requires type, description, aliases, and keywords`)
  }
  const metadata: MemoryTopicMetadata = {
    id: topicId,
    type: patch.type,
    description: cleanLine(redactMemoryText(patch.description)),
    summary: cleanLine(redactMemoryText(patch.summary ?? '')),
    createdAt: now,
    updatedAt: now,
    status: 'active',
    keywords: uniqueSorted(patch.addKeywords.map(redactMemoryText)),
    aliases: uniqueSorted(patch.addAliases.map(redactMemoryText)),
    appliesTo: uniqueSorted(patch.appliesTo?.map(redactMemoryText)),
    related: uniqueSorted(patch.related).slice(0, 8),
    pinned: patch.pinned ?? false,
  }
  const filePath = path.join(memoryRoot, 'topics', `${topicId}.md`)
  const raw = formatMemoryTopic({
    metadata,
    body: `# ${topicId}\n\n## Facts\n`,
    facts: [],
    sections: [],
    hash: '',
    path: filePath,
    raw: '',
  })
  return parseMemoryTopic(raw, filePath)
}

function evidenceRank(kind: EvidenceKind): number {
  if (kind === 'explicit') return 3
  if (kind === 'validated') return 2
  return 1
}

function slotParts(factId: string): { subject: Set<string>; predicate: string } {
  const segments = factId.split('.')
  const predicate = (segments.pop() ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const subject = new Set(
    segments
      .join('.')
      .toLowerCase()
      .split(/[^a-z0-9\p{L}]+/u)
      .filter(Boolean),
  )
  return { subject, predicate }
}

function subjectOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0
  let matches = 0
  for (const token of a) if (b.has(token)) matches++
  return matches / Math.min(a.size, b.size)
}

function findSlotCandidates(factId: string, topicId: string, topics: Iterable<MemoryTopic>): MemoryFact[] {
  const desired = slotParts(factId)
  const candidates: MemoryFact[] = []
  for (const topic of topics) {
    for (const fact of topic.facts) {
      if (fact.metadata.id === factId) continue
      const existing = slotParts(fact.metadata.id)
      if (existing.predicate !== desired.predicate) continue
      if (topic.metadata.id === topicId || subjectOverlap(existing.subject, desired.subject) >= 0.6)
        candidates.push(fact)
    }
  }
  return candidates
}

function incomingWins(existing: MemoryFact, evidence: MemoryOperation['evidence']): boolean {
  const incoming = latestEvidence(evidence)
  if (!incoming) return false
  const incomingTime = Date.parse(incoming.occurredAt)
  const existingTime = Date.parse(existing.metadata.observedAt)
  if (incomingTime < existingTime) return false
  if (existing.metadata.evidence === 'explicit' && incoming.kind !== 'explicit') {
    return false
  }
  if (incomingTime > existingTime) return true
  return evidenceRank(incoming.kind) >= evidenceRank(existing.metadata.evidence)
}

function hasOversizeIndexValue(patch: TopicMetadataPatch | undefined): boolean {
  if (!patch) return false
  return [
    ...(patch.addKeywords ?? []),
    ...(patch.removeKeywords ?? []),
    ...(patch.addAliases ?? []),
    ...(patch.removeAliases ?? []),
  ].some((value) => [...cleanLine(value)].length > 80)
}

export function renderCoreProfile(topics: readonly MemoryTopic[]): string {
  const sorted = [...topics]
    .filter((topic) => topic.metadata.status === 'active')
    .sort((a, b) => {
      if (a.metadata.pinned !== b.metadata.pinned) return a.metadata.pinned ? -1 : 1
      const updated = Date.parse(b.metadata.updatedAt) - Date.parse(a.metadata.updatedAt)
      return updated || a.metadata.id.localeCompare(b.metadata.id)
    })
  const lines = ['<!-- Generated from memory/topics. Manual edits will be overwritten. -->', '', '# Core profile', '']
  let coreTokens = 0
  for (const topic of sorted.filter((item) => item.metadata.pinned)) {
    const line = `- ${topic.metadata.summary}`
    const tokens = estimateTextTokens(line)
    if (coreTokens + tokens > 800) break
    lines.push(line)
    coreTokens += tokens
  }
  while (lines.at(-1) === '') lines.pop()
  lines.push('', '# Topic registry', '')
  for (const topic of sorted) {
    const aliases = topic.metadata.aliases.length ? `; aliases: ${topic.metadata.aliases.join(', ')}` : ''
    const line = `- ${topic.metadata.id} — ${topic.metadata.description}${aliases}`
    const candidate = [...lines, line].join('\n')
    if (lines.length >= 199 || estimateTextTokens(candidate) > 1500) break
    lines.push(line)
  }
  return lines.join('\n').trimEnd() + '\n'
}

export class MemoryStore {
  readonly memoryRoot: string
  readonly topicsDir: string
  readonly transactionStore: MemoryTransactionStore

  constructor(memoryRoot: string) {
    this.memoryRoot = memoryRoot
    this.topicsDir = path.join(memoryRoot, 'topics')
    this.transactionStore = new MemoryTransactionStore(memoryRoot)
  }

  async initialize(): Promise<MemoryLoadResult> {
    await this.transactionStore.initializeLayout()
    await this.transactionStore.recover()
    let loaded = await this.load()
    const memoryContent = renderCoreProfile(loaded.topics)
    const currentMemory = await fs.readFile(this.transactionStore.memoryPath, 'utf-8').catch(() => '')
    const schemaMtime = await fs.stat(this.transactionStore.schemaPath).then((stat) => stat.mtimeMs)
    const manuallyChangedTopics: MemoryTopic[] = []
    for (const topic of loaded.topics) {
      const mtime = await fs
        .stat(topic.path)
        .then((stat) => stat.mtimeMs)
        .catch(() => 0)
      if (mtime > schemaMtime + 1) manuallyChangedTopics.push(topic)
    }
    if (currentMemory !== memoryContent || manuallyChangedTopics.length > 0) {
      await this.transactionStore.commit({
        writes: new Map(),
        deletes: [],
        memoryContent,
        change: {
          reason: 'manual-edit',
          changed: manuallyChangedTopics.flatMap((topic) =>
            topic.facts.map((fact) => ({ topicId: topic.metadata.id, factId: fact.metadata.id, nextHash: fact.hash })),
          ),
          deleted: [],
        },
      })
      loaded = await this.load()
    }
    return loaded
  }

  async load(): Promise<MemoryLoadResult> {
    const { value, generation } = await this.transactionStore.readConsistent(async () => {
      const entries = (await fs.readdir(this.topicsDir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .sort((a, b) => a.name.localeCompare(b.name))
      const topics: MemoryTopic[] = []
      const invalidTopics: Array<{ path: string; error: string }> = []
      for (const entry of entries) {
        const filePath = path.join(this.topicsDir, entry.name)
        try {
          const topic = parseMemoryTopic(await fs.readFile(filePath, 'utf-8'), filePath)
          topics.push(topic)
        } catch (error) {
          invalidTopics.push({ path: filePath, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return { topics: isolateInvalidTopics(topics, invalidTopics), invalidTopics }
    })
    return { ...value, generation }
  }

  async applyOperations(
    operations: readonly MemoryOperation[],
    context?: MemoryCommitContext,
  ): Promise<MemoryOperationResult> {
    if (!context && operations.length === 0) {
      return { status: 'no-op', notices: [] }
    }
    return this.transactionStore.withWriterLock(async () => {
      const appliedJobPath = context
        ? path.join(this.memoryRoot, '.state', 'jobs', 'applied', `${context.jobId}.json`)
        : null
      if (context && (!SAFE_JOB_ID_RE.test(context.jobId) || !Number.isFinite(Date.parse(context.sourceOccurredAt)))) {
        throw new Error('Invalid memory commit context')
      }
      if (appliedJobPath && (await fileExists(appliedJobPath))) {
        return { status: 'no-op', notices: [] }
      }
      const loaded = await this.loadWithoutReaderProtocol()
      const topics = new Map(loaded.topics.map((topic) => [topic.metadata.id, cloneTopic(topic)]))
      const originalTopics = new Map(loaded.topics.map((topic) => [topic.metadata.id, topic]))
      const quarantinedTopicIds = new Set(
        loaded.invalidTopics
          .map((item) => path.basename(item.path, '.md').toLowerCase())
          .filter((id) => MEMORY_ID_RE.test(id)),
      )
      const writes = new Map<string, string>()
      const deletes = new Set<string>()
      const touched = new Set<string>()
      const changed: MemoryChange['changed'] = []
      const deleted: MemoryChange['deleted'] = []
      const notices: MemoryOperationResult['notices'] = []
      const now = new Date().toISOString()
      let reason: MemoryChange['reason'] = 'upsert'
      let metadataOnlyChange = false

      const rebuildFacts = () => {
        const map = new Map<string, Array<{ topic: MemoryTopic; fact: MemoryFact }>>()
        for (const topic of topics.values()) {
          for (const fact of topic.facts) {
            const list = map.get(fact.metadata.id) ?? []
            list.push({ topic, fact })
            map.set(fact.metadata.id, list)
          }
        }
        return map
      }

      for (const operation of operations.slice(0, 8)) {
        const factsById = rebuildFacts()
        if (
          operation.evidence.length === 0 ||
          operation.evidence.some(
            (evidence) =>
              !VALID_EVIDENCE.has(evidence.kind) ||
              !evidence.sourceId.trim() ||
              !Number.isFinite(Date.parse(evidence.occurredAt)) ||
              (context !== undefined &&
                (evidence.occurredAt !== context.sourceOccurredAt ||
                  evidence.sourceId !== `memory-job:${context.jobId}:${evidence.kind}`)),
          )
        ) {
          notices.push({ action: 'failed', error: 'Invalid or unbound memory evidence' })
          continue
        }
        if (operation.action === 'delete') {
          reason = 'forget'
          if (
            operation.remove.some((target) => quarantinedTopicIds.has(target.topicId)) ||
            operation.topicPatches?.some((item) => quarantinedTopicIds.has(item.topicId))
          ) {
            notices.push({ action: 'failed', error: 'Cannot automatically modify a quarantined topic' })
            continue
          }
          if (
            operation.remove.some((target) => {
              const topic = topics.get(target.topicId)
              return Boolean(topic && target.expectedTopicHash && target.expectedTopicHash !== topic.hash)
            })
          ) {
            notices.push({ action: 'failed', error: 'Forget target changed since extraction' })
            continue
          }
          for (const target of operation.remove) {
            const topic = topics.get(target.topicId)
            if (!topic) continue
            if (target.expectedTopicHash && target.expectedTopicHash !== topic.hash) {
              notices.push({ action: 'failed', topicId: target.topicId, error: 'Topic changed since extraction' })
              continue
            }
            if (!target.factId) {
              for (const fact of topic.facts) {
                deleted.push({ topicId: topic.metadata.id, factId: fact.metadata.id, previousHash: fact.hash })
                notices.push({ action: 'forgotten', topicId: topic.metadata.id, factId: fact.metadata.id })
              }
              topics.delete(topic.metadata.id)
              deletes.add(topic.path)
              continue
            }
            const fact = topic.facts.find((item) => item.metadata.id === target.factId)
            if (!fact) continue
            touched.add(topic.metadata.id)
            removeFactBlocks(topic, new Set([target.factId]))
            deleted.push({ topicId: topic.metadata.id, factId: fact.metadata.id, previousHash: fact.hash })
            notices.push({ action: 'forgotten', topicId: topic.metadata.id, factId: fact.metadata.id })
            const refreshed = refreshTopic(topic, now)
            if (refreshed.facts.length === 0 && !hasManualContent(refreshed)) {
              topics.delete(topic.metadata.id)
              deletes.add(topic.path)
            } else {
              topics.set(topic.metadata.id, refreshed)
            }
          }
          for (const topicPatch of operation.topicPatches ?? []) {
            const topic = topics.get(topicPatch.topicId)
            if (!topic) continue
            const resultingType = topicPatch.patch.type ?? topic.metadata.type
            const resultingPinned = topicPatch.patch.pinned ?? topic.metadata.pinned
            if (
              hasOversizeIndexValue(topicPatch.patch) ||
              (resultingPinned &&
                resultingType !== 'user' &&
                resultingType !== 'portfolio' &&
                resultingType !== 'feedback')
            ) {
              notices.push({ action: 'failed', topicId: topicPatch.topicId, error: 'Invalid topic metadata patch' })
              continue
            }
            applyPatch(topic.metadata, topicPatch.patch)
            topics.set(topic.metadata.id, refreshTopic(topic, now))
            touched.add(topic.metadata.id)
            metadataOnlyChange = true
          }
          continue
        }

        if (quarantinedTopicIds.has(operation.topicId)) {
          notices.push({
            action: 'failed',
            topicId: operation.topicId,
            factId: operation.factId,
            error: 'Cannot automatically overwrite a quarantined topic',
          })
          continue
        }
        if (!MEMORY_ID_RE.test(operation.factId)) {
          notices.push({
            action: 'failed',
            topicId: operation.topicId,
            factId: operation.factId,
            error: 'Invalid fact ID',
          })
          continue
        }
        const operationTarget = topics.get(operation.topicId)
        const resultingType = operation.topicPatch?.type ?? operationTarget?.metadata.type
        if (
          (operation.topicPatch?.pinned ?? operationTarget?.metadata.pinned) === true &&
          resultingType !== 'user' &&
          resultingType !== 'portfolio' &&
          resultingType !== 'feedback'
        ) {
          notices.push({
            action: 'failed',
            topicId: operation.topicId,
            factId: operation.factId,
            error: 'Only stable user, portfolio, or feedback topics may be pinned',
          })
          continue
        }
        if (
          (!operationTarget &&
            (!operation.topicPatch?.type ||
              !operation.topicPatch.description ||
              !operation.topicPatch.addAliases?.length ||
              !operation.topicPatch.addKeywords?.length)) ||
          hasOversizeIndexValue(operation.topicPatch) ||
          !canonicalText(operation.content) ||
          operation.content.includes('<!-- x-memory:') ||
          Buffer.byteLength(operation.content, 'utf-8') > 8 * 1024
        ) {
          notices.push({
            action: 'failed',
            topicId: operation.topicId,
            factId: operation.factId,
            error: 'Invalid fact content or incomplete new-topic metadata',
          })
          continue
        }
        let factId = operation.factId
        if (!factsById.has(factId)) {
          const slotCandidates = findSlotCandidates(factId, operation.topicId, topics.values())
          if (slotCandidates.length > 1) {
            notices.push({
              action: 'failed',
              topicId: operation.topicId,
              factId,
              error: 'Multiple existing facts match the same semantic slot',
            })
            continue
          }
          if (slotCandidates.length === 1) factId = slotCandidates[0]!.metadata.id
        }
        const existingMatches = factsById.get(factId) ?? []
        const existing = existingMatches[0]
        const expectedTarget = topics.get(operation.topicId)
        if (operation.expectedTopicHash && operation.expectedTopicHash !== expectedTarget?.hash) {
          notices.push({
            action: 'failed',
            topicId: operation.topicId,
            factId,
            error: 'Topic changed since extraction',
          })
          continue
        }
        if (
          operation.action === 'replace-conflict' &&
          operation.remove.some((target) => {
            if (quarantinedTopicIds.has(target.topicId)) return true
            const topic = topics.get(target.topicId)
            return !topic || target.expectedTopicHash !== topic.hash
          })
        ) {
          notices.push({
            action: 'failed',
            topicId: operation.topicId,
            factId,
            error: 'Conflict target changed since extraction',
          })
          continue
        }
        if (existing && !incomingWins(existing.fact, operation.evidence)) {
          notices.push({
            action: 'failed',
            topicId: operation.topicId,
            factId,
            error: 'Older or weaker evidence cannot replace the current fact',
          })
          continue
        }
        const safeContent = redactMemoryText(operation.content)
        const nextHash = memoryContentHash(canonicalText(safeContent))
        if (existing && existing.fact.hash === nextHash) {
          const metadata = factMetadata(operation.evidence)
          if (
            existing.fact.metadata.observedAt === metadata.observedAt &&
            existing.fact.metadata.evidence === metadata.evidence &&
            !operation.topicPatch
          ) {
            continue
          }
          const markerPattern = new RegExp(
            `<!--\\s*x-memory:\\s*\\{[^\\n]*"id"\\s*:\\s*"${factId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^\\n]*\\}\\s*-->`,
          )
          existing.topic.body = existing.topic.body.replace(markerPattern, () => {
            metadata.id = factId
            return `<!-- x-memory: ${JSON.stringify(metadata)} -->`
          })
          applyPatch(existing.topic.metadata, operation.topicPatch)
          topics.set(existing.topic.metadata.id, refreshTopic(existing.topic, now))
          touched.add(existing.topic.metadata.id)
          metadataOnlyChange = true
          notices.push({
            action: 'updated',
            topicId: existing.topic.metadata.id,
            factId,
            content: existing.fact.content,
          })
          continue
        }

        if (existing || operation.action === 'replace-conflict') reason = 'replace-conflict'
        const removals = new Map<string, Set<string>>()
        for (const match of existingMatches) {
          const ids = removals.get(match.topic.metadata.id) ?? new Set<string>()
          ids.add(match.fact.metadata.id)
          removals.set(match.topic.metadata.id, ids)
        }
        if (operation.action === 'replace-conflict') {
          for (const target of operation.remove) {
            const topic = topics.get(target.topicId)
            if (!topic || (target.expectedTopicHash && target.expectedTopicHash !== topic.hash)) continue
            const ids = removals.get(target.topicId) ?? new Set<string>()
            ids.add(target.factId)
            removals.set(target.topicId, ids)
          }
        }
        for (const [topicId, ids] of removals) {
          const topic = topics.get(topicId)
          if (!topic) continue
          touched.add(topicId)
          for (const id of ids) {
            const fact = topic.facts.find((item) => item.metadata.id === id)
            if (fact) deleted.push({ topicId, factId: id, previousHash: fact.hash })
          }
          removeFactBlocks(topic, ids)
          const refreshed = refreshTopic(topic, now, operation.action === 'replace-conflict')
          if (topicId !== operation.topicId && refreshed.facts.length === 0 && !hasManualContent(refreshed)) {
            topics.delete(topicId)
            deletes.add(topic.path)
          } else {
            topics.set(topicId, refreshed)
          }
        }

        let target = topics.get(operation.topicId)
        if (!target) target = newTopic(this.memoryRoot, operation.topicId, operation.topicPatch, now)
        applyPatch(target.metadata, operation.topicPatch)
        appendFact(target, factId, safeContent, operation.evidence)
        target = refreshTopic(
          target,
          now,
          operation.action === 'replace-conflict' && operation.topicPatch?.description === undefined,
        )
        topics.set(target.metadata.id, target)
        touched.add(target.metadata.id)
        changed.push({
          topicId: target.metadata.id,
          factId,
          ...(existing ? { previousHash: existing.fact.hash } : {}),
          nextHash,
        })
        notices.push({
          action: existing ? 'updated' : 'remembered',
          topicId: target.metadata.id,
          factId,
          content: canonicalText(safeContent),
        })
      }

      if (changed.length === 0 && deleted.length === 0 && !metadataOnlyChange) {
        const rejected = notices.some((notice) => notice.action === 'failed')
        if (appliedJobPath && !rejected) {
          await atomicWriteFile(
            appliedJobPath,
            JSON.stringify({ jobId: context!.jobId, appliedAt: new Date().toISOString() }) + '\n',
          )
        }
        return {
          status: rejected ? 'warning' : 'no-op',
          notices,
        }
      }
      const activeTopicIds = new Set(topics.keys())
      for (const topic of topics.values()) {
        const related = topic.metadata.related.filter((id) => activeTopicIds.has(id))
        if (related.length !== topic.metadata.related.length) touched.add(topic.metadata.id)
        topic.metadata.related = related
      }
      for (const topic of topics.values()) {
        if (!touched.has(topic.metadata.id) && originalTopics.has(topic.metadata.id)) continue
        const raw = formatMemoryTopic(topic)
        parseMemoryTopic(raw, topic.path)
        if (raw !== originalTopics.get(topic.metadata.id)?.raw) writes.set(topic.path, raw)
      }
      const memoryContent = renderCoreProfile([...topics.values()])
      if (appliedJobPath) {
        writes.set(
          appliedJobPath,
          JSON.stringify({ jobId: context!.jobId, appliedAt: new Date().toISOString() }) + '\n',
        )
      }
      await this.transactionStore.commitLocked({
        writes,
        deletes: [...deletes].filter((target) => !writes.has(target)),
        memoryContent,
        change: { reason, changed, deleted },
      })
      return {
        status: notices.some((notice) => notice.action === 'failed') ? 'warning' : 'success',
        notices,
      }
    })
  }

  async commitManualEdit(previousTopics: readonly MemoryTopic[]): Promise<MemoryLoadResult> {
    return this.transactionStore.withWriterLock(async () => {
      const loaded = await this.loadWithoutReaderProtocol()
      const before = new Map(
        previousTopics.flatMap((topic) => topic.facts.map((fact) => [fact.metadata.id, { topic, fact }])),
      )
      const after = new Map(
        loaded.topics.flatMap((topic) => topic.facts.map((fact) => [fact.metadata.id, { topic, fact }])),
      )
      const changed: MemoryChange['changed'] = []
      const deleted: MemoryChange['deleted'] = []
      for (const [id, entry] of after) {
        const old = before.get(id)
        if (!old || old.fact.hash !== entry.fact.hash) {
          changed.push({
            topicId: entry.topic.metadata.id,
            factId: id,
            ...(old ? { previousHash: old.fact.hash } : {}),
            nextHash: entry.fact.hash,
          })
        }
      }
      for (const [id, entry] of before) {
        if (!after.has(id))
          deleted.push({ topicId: entry.topic.metadata.id, factId: id, previousHash: entry.fact.hash })
      }
      const previousTopicHashes = new Map(previousTopics.map((topic) => [topic.metadata.id, topic.hash]))
      const currentTopicIds = new Set(loaded.topics.map((topic) => topic.metadata.id))
      const manualTopicChanged =
        loaded.topics.some((topic) => previousTopicHashes.get(topic.metadata.id) !== topic.hash) ||
        previousTopics.some((topic) => !currentTopicIds.has(topic.metadata.id))
      const memoryContent = renderCoreProfile(loaded.topics)
      const currentMemory = await fs.readFile(this.transactionStore.memoryPath, 'utf-8').catch(() => '')
      let generation = loaded.generation
      if (changed.length || deleted.length || manualTopicChanged || currentMemory !== memoryContent) {
        generation = await this.transactionStore.commitLocked({
          writes: new Map(),
          deletes: [],
          memoryContent,
          change: { reason: 'manual-edit', changed, deleted },
        })
      }
      return { ...loaded, generation }
    })
  }

  private async loadWithoutReaderProtocol(): Promise<MemoryLoadResult> {
    const entries = (await fs.readdir(this.topicsDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))
    const topics: MemoryTopic[] = []
    const invalidTopics: Array<{ path: string; error: string }> = []
    for (const entry of entries) {
      const filePath = path.join(this.topicsDir, entry.name)
      try {
        topics.push(parseMemoryTopic(await fs.readFile(filePath, 'utf-8'), filePath))
      } catch (error) {
        invalidTopics.push({ path: filePath, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return {
      topics: isolateInvalidTopics(topics, invalidTopics),
      invalidTopics,
      generation: (await this.transactionStore.readSchema()).generation,
    }
  }
}
