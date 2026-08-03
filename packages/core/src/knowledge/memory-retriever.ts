import { createHash } from 'node:crypto'

import type { ModelMessage } from 'ai'

import { generateTimestampId } from '../utils.js'
import { LruCache } from '../utils/lru-cache.js'
import { extractText } from '../utils/message-helpers.js'
import {
  MemoryIndex,
  extractMemoryIdentifiers,
  extractMemoryPaths,
  isMemoryFactActive,
  normalizeMemoryText,
  tokenizeMemoryText,
} from './memory-index.js'
import type {
  MemoryRecallAttachment,
  MemoryRecallAttachmentTopic,
  MemoryRecallTrace,
  MemorySection,
  MemoryTopic,
  MemoryType,
  RecallCandidate,
  RecallQuery,
} from './memory-types.js'

const HISTORY_RE = /(?:记得|记忆|之前|以前|上次|曾经|历史|过去|remember|before|previous|last time|history)/i
const FORGET_RE = /(?:忘记|别记|删除.*记忆|forget|remove.*memory)/i
const SELF_CONTAINED_RE = /^(?:你好|您好|谢谢|翻译|格式化|hello\b|hi\b|thanks\b|format\b|translate\b)/i

export interface RetrieverOptions {
  maxTopicsPerTurn: number
  maxTokensPerTopic: number
  maxTokensPerTurn: number
}

export interface RetrieveResult {
  candidates: RecallCandidate[]
  selectedTopicIds: string[]
  protectedTopicIds: string[]
  needsSelector: boolean
  trace: MemoryRecallTrace
}

function recentConversation(messages: readonly ModelMessage[], currentIndex: number): string {
  const selected: string[] = []
  let userCount = 0
  let assistantCount = 0
  for (let index = currentIndex - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message) continue
    if (message.role === 'user' && userCount < 2) {
      selected.unshift(extractText(message.content).slice(0, 500))
      userCount++
    } else if (message.role === 'assistant' && assistantCount < 1) {
      selected.unshift(extractText(message.content).slice(0, 500))
      assistantCount++
    }
    if (userCount >= 2 && assistantCount >= 1) break
  }
  return selected.join('\n')
}

export function buildRecallQuery(
  currentUserText: string,
  messages: readonly ModelMessage[],
  currentMessageIndex: number,
  repositoryId: string,
): RecallQuery {
  const clean = currentUserText
    .replace(/<activated_skill\b[^>]*>[\s\S]*?<\/activated_skill>/gi, '')
    .replace(/```[\s\S]{4000,}?```/g, '[large pasted content removed]')
    .trim()
  const recentConversationText = recentConversation(messages, currentMessageIndex)
  return {
    currentUserText: clean,
    recentConversationText,
    repositoryId: repositoryId.replace(/\\/g, '/'),
    mentionedPaths: extractMemoryPaths(clean),
    identifiers: extractMemoryIdentifiers(clean),
    explicitHistoryIntent: HISTORY_RE.test(clean),
    explicitForgetIntent: FORGET_RE.test(clean),
  }
}

function addRoute(routeRanks: Map<string, Map<string, number>>, route: string, topicIds: readonly string[]): void {
  const ranks = new Map<string, number>()
  topicIds.slice(0, 20).forEach((topicId, index) => ranks.set(topicId, index + 1))
  routeRanks.set(route, ranks)
}

function repositoryMatches(topic: MemoryTopic, repositoryId: string): boolean {
  const repo = normalizeMemoryText(repositoryId)
  return topic.metadata.appliesTo.some((value) => normalizeMemoryText(value) === repo)
}

function includesAlias(message: string, alias: string): boolean {
  const normalized = normalizeMemoryText(alias)
  if (!normalized) return false
  if (/[^\x00-\x7F]/u.test(normalized)) return message.includes(normalized)
  let index = message.indexOf(normalized)
  while (index >= 0) {
    const before = index === 0 ? '' : message[index - 1]!
    const afterIndex = index + normalized.length
    const after = afterIndex >= message.length ? '' : message[afterIndex]!
    if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return true
    index = message.indexOf(normalized, index + 1)
  }
  return false
}

function intentTypes(query: RecallQuery): MemoryType[] {
  const text = normalizeMemoryText(query.currentUserText)
  const types = new Set<MemoryType>()
  if (/(?:产品|项目定位|路线图|技术栈|架构|product|portfolio|roadmap|tech stack|architecture)/i.test(text)) {
    types.add('portfolio')
  }
  if (/(?:偏好|习惯|纠正|反馈|协作|风格|prefer|preference|correction|feedback|collaboration|style)/i.test(text)) {
    types.add('feedback')
    types.add('user')
  }
  if (
    query.explicitHistoryIntent ||
    /(?:决定|决策|为什么|为何|流程|工作流|约定|decision|why|workflow|process|convention)/i.test(text)
  ) {
    types.add('project')
    types.add('workflow')
  }
  if (/(?:文档|参考|入口|链接|地址|docs?|reference|entry|link|url)/i.test(text)) types.add('reference')
  return [...types]
}

export class MemoryRetriever {
  private readonly cache = new LruCache<RetrieveResult>({ maxEntries: 128 })

  constructor(
    private readonly index: MemoryIndex,
    private readonly options: RetrieverOptions,
  ) {}

  retrieve(query: RecallQuery): RetrieveResult {
    const recentHash = createHash('sha1').update(query.recentConversationText).digest('hex').slice(0, 12)
    const cacheKey = `${this.index.generation}:${normalizeMemoryText(query.currentUserText)}:${normalizeMemoryText(query.repositoryId)}:${recentHash}:${query.explicitHistoryIntent}:${query.explicitForgetIntent}`
    const cached = this.cache.get(cacheKey)
    if (cached) return structuredClone(cached)
    const routeRanks = new Map<string, Map<string, number>>()
    const exact = this.index.exactHits(query.currentUserText, query.mentionedPaths, query.identifiers)
    addRoute(
      routeRanks,
      'exact',
      [...exact].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id),
    )
    const bm25 = this.index.bm25(query.currentUserText)
    addRoute(
      routeRanks,
      'bm25',
      bm25.map((hit) => hit.topicId),
    )
    const conversation = query.recentConversationText ? this.index.bm25(query.recentConversationText) : []
    addRoute(
      routeRanks,
      'conversation',
      conversation.map((hit) => hit.topicId),
    )
    const typeIntent = new Set(intentTypes(query))
    addRoute(
      routeRanks,
      'type',
      [...this.index.topics.values()]
        .filter((topic) => typeIntent.has(topic.metadata.type))
        .map((topic) => topic.metadata.id),
    )
    addRoute(
      routeRanks,
      'pinned',
      [...this.index.topics.values()].filter((topic) => topic.metadata.pinned).map((topic) => topic.metadata.id),
    )

    const weights: Record<string, number> = {
      exact: 4,
      bm25: 2.5,
      conversation: 1.5,
      type: 1.5,
      relationship: 0.8,
      pinned: 0.5,
    }
    const scoreMap = new Map<string, { score: number; routes: string[] }>()
    for (const [route, ranks] of routeRanks) {
      for (const [topicId, rank] of ranks) {
        const entry = scoreMap.get(topicId) ?? { score: 0, routes: [] }
        entry.score += (weights[route] ?? 0) / (60 + rank)
        entry.routes.push(route)
        scoreMap.set(topicId, entry)
      }
    }

    const topBeforeRelated = [...scoreMap].sort((a, b) => b[1].score - a[1].score).slice(0, 3)
    let relatedAdded = 0
    for (const [topicId] of topBeforeRelated) {
      const topic = this.index.topics.get(topicId)
      for (const relatedId of topic?.metadata.related ?? []) {
        if (relatedAdded >= 2) break
        const entry = scoreMap.get(relatedId) ?? { score: 0, routes: [] }
        if (!entry.routes.includes('relationship')) {
          entry.score += weights.relationship / 61
          entry.routes.push('relationship')
          scoreMap.set(relatedId, entry)
          relatedAdded++
        }
      }
    }

    const queryTokens = new Set(tokenizeMemoryText(query.currentUserText))
    const bm25Coverage = new Map(bm25.map((hit) => [hit.topicId, hit.coverage]))
    const protectedTopicIds = [...exact].filter(([, score]) => score >= 0.8).map(([id]) => id)
    const protectedSet = new Set(protectedTopicIds)
    const normalizedMessage = normalizeMemoryText(query.currentUserText)
    const candidates: RecallCandidate[] = [...scoreMap]
      .map(([topicId, entry]) => {
        const topic = this.index.topics.get(topicId)!
        let score = entry.score
        if (repositoryMatches(topic, query.repositoryId)) score += 0.15
        if (query.explicitHistoryIntent && typeIntent.has(topic.metadata.type)) score += 0.1
        if (topic.metadata.aliases.some((alias) => includesAlias(normalizedMessage, alias))) {
          score += 0.2
          protectedSet.add(topicId)
        }
        if (topic.facts.length > 0 && !topic.facts.some((fact) => isMemoryFactActive(fact))) score *= 0.5
        const topicTokens = this.index.topicTokens(topicId)
        const localCoverage = queryTokens.size
          ? [...queryTokens].filter((token) => topicTokens.has(token)).length / queryTokens.size
          : 0
        return {
          topicId,
          score,
          routes: [...new Set(entry.routes)],
          coverage: Math.max(localCoverage, bm25Coverage.get(topicId) ?? 0),
          protected: protectedSet.has(topicId),
        }
      })
      .sort((a, b) => b.score - a.score || a.topicId.localeCompare(b.topicId))

    const exactUnique = candidates.filter((candidate) => candidate.routes.includes('exact') && candidate.protected)
    let selectedTopicIds: string[] = []
    let needsSelector = false
    if (exactUnique.length === 1) {
      selectedTopicIds = [exactUnique[0]!.topicId]
    } else if (exactUnique.length > 1) {
      needsSelector = true
    } else if (candidates.length) {
      const top = candidates[0]!
      const second = candidates[1]
      const independentRoutes = top.routes.filter((route) => route !== 'pinned').length
      const locallyCertain =
        independentRoutes >= 2 && top.coverage >= 0.6 && (!second || top.score - second.score >= 0.02)
      if (locallyCertain) selectedTopicIds = [top.topicId]
      else if (query.explicitHistoryIntent || query.explicitForgetIntent || independentRoutes >= 2) needsSelector = true
    }
    if (candidates.length === 0 && (query.explicitHistoryIntent || query.explicitForgetIntent)) needsSelector = true
    if (SELF_CONTAINED_RE.test(query.currentUserText.trim())) needsSelector = false

    const trace: MemoryRecallTrace = {
      query: query.currentUserText,
      generation: this.index.generation,
      selectorUsed: false,
      candidates: candidates.slice(0, 20),
      selectedTopicIds,
      filtered: candidates
        .filter((candidate) => !selectedTopicIds.includes(candidate.topicId))
        .map((candidate) => `${candidate.topicId}: below selection threshold`),
      packedTokens: 0,
    }
    const result = { candidates, selectedTopicIds, protectedTopicIds: [...protectedSet], needsSelector, trace }
    this.cache.set(cacheKey, structuredClone(result))
    return result
  }

  pack(
    query: RecallQuery,
    topicIds: readonly string[],
    anchorMessageIndex: number,
    placement: MemoryRecallAttachment['placement'] = 'before-user',
  ): MemoryRecallAttachment | null {
    const queryTokens = new Set(tokenizeMemoryText(`${query.currentUserText} ${query.recentConversationText}`))
    const protectedIds = new Set(
      [...this.index.exactHits(query.currentUserText, query.mentionedPaths, query.identifiers)]
        .filter(([, score]) => score >= 0.8)
        .map(([topicId]) => topicId),
    )
    const selected = this.selectTopicsMmr(topicIds, queryTokens, protectedIds)
    const packed: MemoryRecallAttachmentTopic[] = []
    let totalTokens = 0
    for (const topic of selected) {
      const sections = topic.sections
        .map((section) => ({ section, score: sectionScore(section, queryTokens) }))
        .sort(
          (a, b) => b.score / Math.max(b.section.estimatedTokens, 1) - a.score / Math.max(a.section.estimatedTokens, 1),
        )
      const rendered: string[] = [`## ${topic.metadata.id}`, topic.metadata.description]
      const factIds: string[] = []
      const factHashes: Record<string, string> = {}
      let topicTokens = estimateTokens(rendered.join('\n'))
      for (const { section, score } of sections) {
        if (score <= 0 && rendered.length > 2) continue
        const content = renderSection(section)
        if (!content) continue
        const tokens = estimateTokens(content)
        const candidateContent = [...rendered, content].join('\n\n')
        if (
          topicTokens + tokens > this.options.maxTokensPerTopic ||
          totalTokens + topicTokens + tokens > this.options.maxTokensPerTurn ||
          candidateContent.split('\n').length > 200 ||
          Buffer.byteLength(candidateContent, 'utf-8') > 8 * 1024
        ) {
          continue
        }
        rendered.push(content)
        topicTokens += tokens
        for (const fact of section.facts.filter((item) => isMemoryFactActive(item))) {
          factIds.push(fact.metadata.id)
          factHashes[fact.metadata.id] = fact.hash
        }
      }
      if (rendered.length <= 2) continue
      const renderedContent = rendered.join('\n\n')
      const actualTokens = estimateTokens(renderedContent)
      if (totalTokens + actualTokens > this.options.maxTokensPerTurn) continue
      packed.push({
        topicId: topic.metadata.id,
        topicHash: topic.hash,
        factIds: [...new Set(factIds)],
        factHashes,
        path: topic.path,
        renderedContent,
      })
      totalTokens += actualTokens
    }
    if (packed.length === 0) return null
    return {
      attachmentId: `memory-${generateTimestampId()}-${createHash('sha1')
        .update(packed.map((item) => item.topicHash).join(':'))
        .digest('hex')
        .slice(0, 8)}`,
      anchorMessageIndex,
      placement,
      topics: packed,
      estimatedTokens: totalTokens,
    }
  }

  private selectTopicsMmr(
    topicIds: readonly string[],
    queryTokens: Set<string>,
    protectedIds: ReadonlySet<string>,
  ): MemoryTopic[] {
    const remaining = topicIds
      .map((id) => this.index.topics.get(id))
      .filter((topic): topic is MemoryTopic => Boolean(topic))
    const selected: MemoryTopic[] = []
    while (remaining.length && selected.length < this.options.maxTopicsPerTurn) {
      let bestIndex = 0
      let bestScore = -Infinity
      for (let index = 0; index < remaining.length; index++) {
        const topic = remaining[index]!
        const tokens = this.index.topicTokens(topic.metadata.id)
        const relevance = overlap(queryTokens, tokens)
        const redundancy = selected.reduce(
          (max, item) => Math.max(max, overlap(tokens, this.index.topicTokens(item.metadata.id))),
          0,
        )
        const score = (protectedIds.has(topic.metadata.id) ? 10 : 0) + 0.8 * relevance - 0.2 * redundancy
        if (score > bestScore) {
          bestScore = score
          bestIndex = index
        }
      }
      selected.push(remaining.splice(bestIndex, 1)[0]!)
    }
    return selected
  }
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  return intersection / Math.sqrt(a.size * b.size)
}

function sectionScore(section: MemorySection, queryTokens: Set<string>): number {
  const tokens = new Set(tokenizeMemoryText(`${section.headingPath.join(' ')} ${section.content}`))
  return overlap(queryTokens, tokens) + (section.facts.some((fact) => isMemoryFactActive(fact)) ? 0.01 : 0)
}

function renderSection(section: MemorySection): string {
  if (section.facts.length === 0) {
    return section.content.replace(/^#{1,3}\s+.*$/gm, '').trim() ? section.content : ''
  }
  const active = section.facts.filter((fact) => isMemoryFactActive(fact))
  let manual = section.content
  for (const fact of section.facts) {
    const id = fact.metadata.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const content = fact.content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    manual = manual.replace(
      new RegExp(`<!--\\s*x-memory:\\s*\\{[^\\n]*"id"\\s*:\\s*"${id}"[^\\n]*\\}\\s*-->\\s*${content}`),
      '',
    )
  }
  manual = manual.replace(/\n{3,}/g, '\n\n').trim()
  if (active.length === 0 && !manual.replace(/^#{1,3}\s+.*$/gm, '').trim()) return ''
  return [manual, ...active.map((fact) => fact.content)].filter(Boolean).join('\n\n')
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf-8') / 3)
}
