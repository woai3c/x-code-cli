import fs from 'node:fs/promises'
import path from 'node:path'

import type { LanguageModel } from 'ai'

import type { LoopState } from '../agent/loop-state.js'
import { MemoryJobStore } from '../agent/memory-job-store.js'
import { MemoryWorker } from '../agent/memory-worker.js'
import { appendMemoryRecall, appendMemoryRecallDelete } from '../agent/session-store.js'
import { resolveMemoryConfig } from '../config/index.js'
import type { MemoryConfig } from '../config/index.js'
import { debugLog, userXcodeDir } from '../utils.js'
import { MemoryIndex } from './memory-index.js'
import { addMemoryRecallAttachment, addMemoryRecallTombstone } from './memory-recall-state.js'
import { MemoryRetriever } from './memory-retriever.js'
import { selectMemoryTopics } from './memory-selector.js'
import { MemoryStore, renderCoreProfile } from './memory-store.js'
import type {
  LateRecallSignals,
  MemoryChange,
  MemoryJob,
  MemoryOperationResult,
  MemoryRecallAttachment,
  MemorySearchArgs,
  MemorySearchContext,
  MemorySearchResult,
  MemoryStatusReport,
  MemoryTopic,
  MemoryWriteNotice,
  RecallQuery,
} from './memory-types.js'

export interface MemoryServiceOptions {
  memoryRoot?: string
  resolveModel?: (modelId: string) => LanguageModel
  config?: () => MemoryConfig
  onNotice?: (notice: MemoryWriteNotice) => void
}

export class MemoryService {
  readonly memoryRoot: string
  private readonly store: MemoryStore
  private readonly jobStore: MemoryJobStore
  private readonly index = new MemoryIndex()
  private retriever: MemoryRetriever
  private worker: MemoryWorker
  private topics: MemoryTopic[] = []
  private invalidTopics: Array<{ path: string; error: string }> = []
  private coreProfile = ''
  private cwd = process.cwd()
  private initialized = false
  private initializationError: string | undefined
  private noticeHandler: ((notice: MemoryWriteNotice) => void) | undefined
  private lastTrace: LoopState['lastMemoryRecallTrace'] = null
  private activeModelId: string | null = null
  private pinnedInvalidationGeneration = 0

  constructor(private readonly options: MemoryServiceOptions = {}) {
    this.memoryRoot = options.memoryRoot ?? path.join(userXcodeDir(), 'memory')
    this.store = new MemoryStore(this.memoryRoot)
    this.jobStore = new MemoryJobStore(this.memoryRoot)
    this.noticeHandler = options.onNotice
    this.retriever = this.createRetriever()
    this.worker = new MemoryWorker({
      jobStore: this.jobStore,
      resolveModel: (modelId) => this.resolveModel(modelId),
      preferredModelId: () => this.config().model,
      contextFor: (job) => this.extractionContext(job),
      commitOperations: (operations) => this.store.applyOperations(operations),
      onCommitted: (result) => this.afterCommit(result),
      onNotice: (notice) => this.noticeHandler?.(notice),
      maxOperations: this.config().maxOperationsPerTurn,
      maxOutputTokens: this.config().maxOutputTokens,
      maxAttempts: this.config().retryMaxAttempts,
    })
  }

  setNoticeHandler(handler: ((notice: MemoryWriteNotice) => void) | undefined): void {
    this.noticeHandler = handler
  }

  setActiveModelId(modelId: string): void {
    this.activeModelId = modelId
  }

  async initialize(cwd: string): Promise<void> {
    if (this.initialized) return
    this.cwd = path.resolve(cwd)
    try {
      await this.jobStore.initialize()
      const loaded = await this.store.initialize()
      this.installSnapshot(loaded.topics, loaded.invalidTopics, loaded.generation)
      this.initialized = true
      if (this.config().enabled) this.worker.wake()
    } catch (error) {
      this.initialized = true
      this.initializationError = error instanceof Error ? error.message : String(error)
      debugLog('memory.initialize-error', this.initializationError)
    }
  }

  getCoreProfile(): string {
    return this.config().enabled && !this.initializationError ? this.coreProfile : ''
  }

  getConfig(): MemoryConfig {
    return this.config()
  }

  listTopics(): Array<{
    id: string
    type: MemoryTopic['metadata']['type']
    summary: string
    description: string
    facts: number
    updatedAt: string
    pinned: boolean
  }> {
    return this.topics.map((topic) => ({
      id: topic.metadata.id,
      type: topic.metadata.type,
      summary: topic.metadata.summary,
      description: topic.metadata.description,
      facts: topic.facts.length,
      updatedAt: topic.metadata.updatedAt,
      pinned: topic.metadata.pinned,
    }))
  }

  getLastTrace(): LoopState['lastMemoryRecallTrace'] {
    return this.lastTrace
  }

  async recall(query: RecallQuery, state: LoopState): Promise<MemoryRecallAttachment | null> {
    if (!this.available()) return null
    await this.synchronizeGeneration(state)
    const config = this.config()
    if (state.memoryTokensInWindow >= config.recall.maxTokensPerCompactionWindow) return null
    const retrieved = this.retriever.retrieve(query)
    let selected = retrieved.selectedTopicIds
    if (
      retrieved.needsSelector &&
      config.recall.semanticSelector === 'auto' &&
      retrieved.protectedTopicIds.length === 0
    ) {
      const selectorModelId =
        config.recall.selectorModel === 'inherit' ? this.currentModelId() : config.recall.selectorModel
      const model = selectorModelId ? this.resolveModel(selectorModelId) : null
      if (model) {
        try {
          selected = await selectMemoryTopics({
            model,
            query,
            manifest: this.index.manifest(),
            preferredTopicIds: retrieved.candidates.slice(0, 50).map((candidate) => candidate.topicId),
          })
          retrieved.trace.selectorUsed = true
        } catch (error) {
          debugLog('memory.selector-fallback', error instanceof Error ? error.message : String(error))
          selected = retrieved.candidates
            .filter(
              (candidate) =>
                candidate.routes.filter((route) => route !== 'pinned').length >= 2 && candidate.coverage >= 0.6,
            )
            .slice(0, 2)
            .map((candidate) => candidate.topicId)
        }
      }
    }
    const remainingBudget = config.recall.maxTokensPerCompactionWindow - state.memoryTokensInWindow
    const attachment = this.retriever.pack(query, selected, state.messages.length - 1)
    if (!attachment || attachment.estimatedTokens > remainingBudget) {
      retrieved.trace.selectedTopicIds = []
      retrieved.trace.packedTokens = 0
      state.lastMemoryRecallTrace = retrieved.trace
      this.lastTrace = retrieved.trace
      return null
    }
    retrieved.trace.selectedTopicIds = attachment.topics.map((topic) => topic.topicId)
    retrieved.trace.packedTokens = attachment.estimatedTokens
    state.lastMemoryRecallTrace = retrieved.trace
    this.lastTrace = retrieved.trace
    if (!addMemoryRecallAttachment(state, attachment)) return null
    state.memoryGeneration = this.index.generation
    void appendMemoryRecall(state, attachment)
    return attachment
  }

  async lateRecall(signals: LateRecallSignals, state: LoopState): Promise<MemoryRecallAttachment | null> {
    const config = this.config()
    if (!this.available() || !config.recall.lateBoundRecall) return null
    await this.synchronizeGeneration(state)
    const remainingBudget = config.recall.maxTokensPerCompactionWindow - state.memoryTokensInWindow
    if (remainingBudget <= 0) return null
    const query: RecallQuery = {
      currentUserText: signals.text,
      recentConversationText: '',
      repositoryId: signals.repositoryId,
      mentionedPaths: signals.paths,
      identifiers: signals.identifiers,
      explicitHistoryIntent: false,
      explicitForgetIntent: false,
    }
    const surfaced = new Set(
      state.memoryRecallAttachments.flatMap((attachment) => attachment.topics.map((topic) => topic.topicId)),
    )
    const retrieved = this.retriever.retrieve(query)
    const selected = retrieved.candidates
      .filter(
        (candidate) =>
          !surfaced.has(candidate.topicId) && candidate.routes.some((route) => route === 'exact' || route === 'bm25'),
      )
      .slice(0, 2)
      .map((candidate) => candidate.topicId)
    const attachment = this.retriever.pack(query, selected, signals.anchorMessageIndex, 'after-tool-results')
    if (!attachment || attachment.estimatedTokens > remainingBudget || !addMemoryRecallAttachment(state, attachment)) {
      return null
    }
    state.lastMemoryRecallTrace = {
      ...retrieved.trace,
      selectedTopicIds: selected,
      packedTokens: attachment.estimatedTokens,
    }
    this.lastTrace = state.lastMemoryRecallTrace
    void appendMemoryRecall(state, attachment)
    return attachment
  }

  async enqueuePostTurnJob(job: MemoryJob): Promise<'created' | 'duplicate' | 'skipped'> {
    if (!this.available() || !this.config().enabled) return 'skipped'
    const result = await this.jobStore.enqueue(job)
    if (result === 'created') this.worker.wake()
    return result
  }

  async search(args: MemorySearchArgs, context: MemorySearchContext): Promise<MemorySearchResult[]> {
    if (!this.available()) return []
    const query = args.query.trim()
    if (!query || /^(?:\*|\.\*|all|全部|所有记忆|列出.*记忆)$/i.test(query)) {
      throw new Error('memorySearch requires a specific, non-enumerating query')
    }
    const recallQuery: RecallQuery = {
      currentUserText: query,
      recentConversationText: '',
      repositoryId: context.repositoryId,
      mentionedPaths: [],
      identifiers: [],
      explicitHistoryIntent: context.explicitHistoryIntent ?? true,
      explicitForgetIntent: false,
    }
    const retrieved = this.retriever.retrieve(recallQuery)
    let candidateIds = retrieved.candidates
      .filter((candidate) => candidate.protected || candidate.routes.some((route) => route !== 'pinned'))
      .map((candidate) => candidate.topicId)
    if (context.allowedTopicIds) candidateIds = candidateIds.filter((id) => context.allowedTopicIds!.includes(id))
    if (args.topicIds) {
      const candidates = new Set(candidateIds)
      if (args.topicIds.some((id) => !candidates.has(id)))
        throw new Error('topicIds cannot expand memory search candidates')
      candidateIds = candidateIds.filter((id) => args.topicIds!.includes(id))
    }
    if (args.semantic) {
      const modelId = this.config().recall.selectorModel
      const resolvedId = modelId === 'inherit' ? this.currentModelId() : modelId
      const model = resolvedId ? this.resolveModel(resolvedId) : null
      if (model) {
        candidateIds = await selectMemoryTopics({
          model,
          query: recallQuery,
          manifest: this.index.manifest(candidateIds.slice(0, 50)),
          preferredTopicIds: candidateIds,
        })
      }
    }
    const score = new Map(retrieved.candidates.map((candidate) => [candidate.topicId, candidate.score]))
    const results: MemorySearchResult[] = []
    for (const topicId of candidateIds) {
      const topic = this.index.topics.get(topicId)
      if (!topic) continue
      for (const section of topic.sections) {
        const activeFacts = section.facts.filter((fact) => args.includeStale || fact.metadata.status === 'active')
        if (section.facts.length && activeFacts.length === 0) continue
        results.push({
          topicId,
          section: section.headingPath.join(' / ') || 'root',
          status: activeFacts.some((fact) => fact.metadata.status === 'active') ? 'active' : topic.metadata.status,
          updatedAt: topic.metadata.updatedAt,
          path: topic.path,
          snippet: (activeFacts.length ? activeFacts.map((fact) => fact.content).join('\n') : section.content).slice(
            0,
            800,
          ),
          score: score.get(topicId) ?? 0,
        })
      }
    }
    return results
      .sort((a, b) => b.score - a.score || a.topicId.localeCompare(b.topicId))
      .slice(0, Math.min(5, Math.max(1, args.maxResults ?? 5)))
  }

  async reload(state?: LoopState): Promise<void> {
    if (!this.initialized || this.initializationError) return
    const previousCore = this.coreProfile
    const previousGeneration = this.index.generation
    const loaded = await this.store.commitManualEdit(this.topics)
    this.installSnapshot(loaded.topics, loaded.invalidTopics, loaded.generation)
    if (state) {
      await this.applyChangesToState(state, previousGeneration, loaded.generation)
      if (previousCore !== this.coreProfile) {
        state.systemPromptCache = null
        state.expectCacheMiss = true
      }
    }
  }

  async status(): Promise<MemoryStatusReport> {
    const queue = await this.jobStore.counts().catch(() => ({ pending: 0, running: 0, failed: 0 }))
    const lastRun = await this.jobStore.lastRun().catch(() => undefined)
    return {
      enabled: this.config().enabled && !this.initializationError,
      initialized: this.initialized,
      schemaVersion: this.initializationError ? undefined : 2,
      generation: this.index.generation,
      topics: this.topics.length,
      facts: this.topics.reduce((sum, topic) => sum + topic.facts.length, 0),
      queue,
      worker: !this.config().enabled || this.initializationError ? 'disabled' : this.worker.status,
      invalidTopics: this.invalidTopics,
      ...(lastRun
        ? {
            lastRun: {
              jobId: lastRun.jobId,
              status: lastRun.status,
              durationMs: lastRun.durationMs,
              operations: lastRun.operations,
              ...(lastRun.errorCategory ? { errorCategory: lastRun.errorCategory } : {}),
            },
          }
        : {}),
      ...(this.initializationError ? { error: this.initializationError } : {}),
    }
  }

  async shutdown(timeoutMs: number): Promise<void> {
    await this.worker.shutdown(timeoutMs)
  }

  private config(): MemoryConfig {
    return this.options.config?.() ?? resolveMemoryConfig()
  }

  private available(): boolean {
    return this.initialized && !this.initializationError && this.config().enabled
  }

  private createRetriever(): MemoryRetriever {
    const recall = this.config().recall
    return new MemoryRetriever(this.index, {
      maxTopicsPerTurn: recall.maxTopicsPerTurn,
      maxTokensPerTopic: recall.maxTokensPerTopic,
      maxTokensPerTurn: recall.maxTokensPerTurn,
    })
  }

  private installSnapshot(
    topics: MemoryTopic[],
    invalidTopics: Array<{ path: string; error: string }>,
    generation: number,
  ): void {
    if (this.initialized || this.topics.length > 0) {
      const nextFacts = new Map(
        topics
          .filter((topic) => topic.metadata.pinned)
          .flatMap((topic) => topic.facts.map((fact) => [fact.metadata.id, fact.hash] as const)),
      )
      const pinnedFactChanged = this.topics
        .filter((topic) => topic.metadata.pinned)
        .some((topic) => topic.facts.some((fact) => nextFacts.get(fact.metadata.id) !== fact.hash))
      if (pinnedFactChanged) this.pinnedInvalidationGeneration = generation
    }
    this.topics = topics
    this.invalidTopics = invalidTopics
    this.coreProfile = topics.length ? renderCoreProfile(topics) : ''
    this.index.rebuild(topics, generation)
    this.retriever = this.createRetriever()
  }

  private resolveModel(modelId: string): LanguageModel | null {
    try {
      return this.options.resolveModel?.(modelId) ?? null
    } catch {
      return null
    }
  }

  private currentModelId(): string | null {
    const configured = this.config().model
    return configured === 'inherit' ? this.activeModelId : configured
  }

  private async extractionContext(job: MemoryJob) {
    const query: RecallQuery = {
      currentUserText: `${job.projection.userMessages.join('\n')}\n${job.projection.assistantFinal}`,
      recentConversationText: '',
      repositoryId: job.repositoryId,
      mentionedPaths: job.projection.changedFiles,
      identifiers: [],
      explicitHistoryIntent: job.explicitMemoryIntent,
      explicitForgetIntent: /(?:忘记|forget)/i.test(job.projection.userMessages.join('\n')),
    }
    const retrieved = this.retriever.retrieve(query)
    const ids = [
      ...new Set([...retrieved.selectedTopicIds, ...retrieved.candidates.slice(0, 3).map((item) => item.topicId)]),
    ].slice(0, 3)
    return {
      coreProfile: this.coreProfile,
      factRegistry: this.index.compactFactRegistry(2000, ids),
      relatedTopics: ids
        .map((id) => this.index.topics.get(id))
        .filter((topic): topic is MemoryTopic => Boolean(topic))
        .map((topic) => ({ topicId: topic.metadata.id, topicHash: topic.hash, content: topic.raw.slice(0, 8 * 1024) })),
    }
  }

  private async afterCommit(result: MemoryOperationResult): Promise<void> {
    if (result.status === 'no-op') return
    const loaded = await this.store.load()
    this.installSnapshot(loaded.topics, loaded.invalidTopics, loaded.generation)
  }

  private async synchronizeGeneration(state: LoopState): Promise<void> {
    const schema = await this.store.transactionStore.readSchema()
    const previous = this.index.generation
    if (schema.generation !== previous) {
      const loaded = await this.store.load()
      this.installSnapshot(loaded.topics, loaded.invalidTopics, loaded.generation)
    }
    if (
      state.memoryGeneration === 0 &&
      state.memoryRecallAttachments.length === 0 &&
      state.memoryRecallTombstones.length === 0 &&
      state.systemPromptCache === null
    ) {
      state.memoryGeneration = this.index.generation
      return
    }
    await this.applyChangesToState(state, state.memoryGeneration, this.index.generation)
  }

  private async applyChangesToState(state: LoopState, fromGeneration: number, toGeneration: number): Promise<void> {
    if (fromGeneration >= toGeneration) {
      state.memoryGeneration = toGeneration
      return
    }
    const factIds = new Set<string>()
    const attachedFactIds = new Set(
      state.memoryRecallAttachments.flatMap((attachment) => attachment.topics.flatMap((topic) => topic.factIds)),
    )
    let pinnedChanged = false
    let manualEdit = false
    if (toGeneration - fromGeneration <= 256) {
      for (let generation = fromGeneration + 1; generation <= toGeneration; generation++) {
        const change = await this.readChange(generation)
        if (!change) continue
        if (change.reason === 'manual-edit') manualEdit = true
        for (const item of [...change.changed, ...change.deleted]) {
          if (attachedFactIds.has(item.factId)) factIds.add(item.factId)
          const topic = this.index.topics.get(item.topicId)
          if (topic?.metadata.pinned) pinnedChanged = true
        }
      }
    } else {
      for (const attachment of state.memoryRecallAttachments) {
        for (const topic of attachment.topics) {
          for (const [factId, factHash] of Object.entries(topic.factHashes)) {
            if (this.index.facts.get(factId)?.factHash !== factHash) factIds.add(factId)
          }
        }
      }
      pinnedChanged = state.memoryRecallAttachments.some((attachment) =>
        attachment.topics.some((topic) => this.index.topics.get(topic.topicId)?.metadata.pinned),
      )
    }
    if (manualEdit) {
      for (const attachment of state.memoryRecallAttachments) {
        for (const topic of attachment.topics) {
          for (const [factId, factHash] of Object.entries(topic.factHashes)) {
            if (this.index.facts.get(factId)?.factHash !== factHash) factIds.add(factId)
          }
        }
      }
    }
    if (factIds.size) {
      const tombstone = { generation: toGeneration, factIds: [...factIds] }
      addMemoryRecallTombstone(state, tombstone)
      void appendMemoryRecallDelete(state, tombstone)
    }
    if (
      pinnedChanged ||
      (this.pinnedInvalidationGeneration > fromGeneration && this.pinnedInvalidationGeneration <= toGeneration)
    ) {
      state.systemPromptCache = null
      state.expectCacheMiss = true
    }
    state.memoryGeneration = toGeneration
  }

  private async readChange(generation: number): Promise<MemoryChange | null> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.memoryRoot, '.state', 'changes', `${generation}.json`), 'utf-8'),
      ) as MemoryChange
    } catch {
      return null
    }
  }
}
