import fs from 'node:fs/promises'
import path from 'node:path'

import type { LanguageModel } from 'ai'

import { markExpectedCacheMiss } from '../../agent/cache-stats.js'
import type { LoopState } from '../../agent/loop-state.js'
import { appendMemoryRecall, appendMemoryRecallDelete } from '../../agent/session-store.js'
import { resolveMemoryConfig } from '../../config/index.js'
import type { MemoryConfig } from '../../config/index.js'
import { debugLog, userXcodeDir } from '../../utils.js'
import { MemoryJobStore } from './job-store.js'
import { addMemoryRecallAttachment, addMemoryRecallTombstone } from './recall-state.js'
import { FORGET_INTENT_RE, HISTORY_INTENT_RE, MemoryRetriever } from './retriever.js'
import { MemoryIndex, isMemoryFactActive } from './search-index.js'
import { selectMemoryTopics } from './selector.js'
import { MemoryStore, renderCoreProfile } from './store.js'
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
} from './types.js'
import { MemoryWorker } from './worker.js'

export interface MemoryServiceOptions {
  memoryRoot?: string
  resolveModel?: (modelId: string) => LanguageModel
  config?: () => MemoryConfig
  onNotice?: (notice: MemoryWriteNotice) => void
}

function pinnedCoreSignature(topics: readonly MemoryTopic[]): string {
  return JSON.stringify(
    topics
      .filter((topic) => topic.metadata.pinned && topic.metadata.status === 'active')
      .sort(
        (a, b) =>
          Date.parse(b.metadata.updatedAt) - Date.parse(a.metadata.updatedAt) ||
          a.metadata.id.localeCompare(b.metadata.id),
      )
      .map((topic) => ({
        id: topic.metadata.id,
        summary: topic.metadata.summary,
        description: topic.metadata.description,
        aliases: topic.metadata.aliases,
      })),
  )
}

function isWildcardMemoryQuery(value: string): boolean {
  const normalized = value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  if (/^(?:\*|\.\*|memory|memories|记忆|全部记忆|所有记忆)$/.test(normalized)) return true
  return (
    /\b(?:list|show|dump|enumerate|export)\b.*\b(?:all|every|everything)\b.*\b(?:memory|memories|preferences?|facts?)\b/.test(
      normalized,
    ) ||
    /\b(?:all|every|everything)\b.*\b(?:memory|memories|preferences?|facts?)\b/.test(normalized) ||
    /\b(?:everything|all)\b.*\b(?:know|remember)\b.*\b(?:about me|about the user)\b/.test(normalized) ||
    /(?:列出|显示|枚举|导出).*(?:全部|所有|一切).*(?:记忆|偏好|事实)|(?:全部|所有).*(?:记忆|偏好)/.test(normalized)
  )
}

export class MemoryService {
  readonly memoryRoot: string
  private readonly store: MemoryStore
  private readonly jobStore: MemoryJobStore
  private readonly index = new MemoryIndex()
  private currentConfig: MemoryConfig
  private retriever: MemoryRetriever
  private retrieverConfigKey = ''
  private worker: MemoryWorker
  private topics: MemoryTopic[] = []
  private invalidTopics: Array<{ path: string; error: string }> = []
  private coreProfile = ''
  private initialized = false
  private initializationError: string | undefined
  private noticeHandler: ((notice: MemoryWriteNotice) => void) | undefined
  private lastTrace: LoopState['lastMemoryRecallTrace'] = null
  private activeModelId: string | null = null
  private pinnedInvalidationGeneration = 0

  constructor(private readonly options: MemoryServiceOptions = {}) {
    this.currentConfig = this.readConfig()
    this.memoryRoot = options.memoryRoot ?? path.join(userXcodeDir(), 'memory')
    this.store = new MemoryStore(this.memoryRoot)
    this.jobStore = new MemoryJobStore(this.memoryRoot)
    this.noticeHandler = options.onNotice
    this.retriever = this.createRetriever()
    this.worker = new MemoryWorker({
      jobStore: this.jobStore,
      resolveModel: (modelId) => this.resolveModel(modelId),
      preferredModelId: () => this.refreshConfig().model,
      contextFor: (job) => this.extractionContext(job),
      commitOperations: (operations, job) =>
        this.store.applyOperations(operations, {
          jobId: job.jobId,
          sourceOccurredAt: job.sourceOccurredAt,
        }),
      onCommitted: (result) => this.afterCommit(result),
      onNotice: (notice) => this.noticeHandler?.(notice),
      maxOperations: () => this.config().maxOperationsPerTurn,
      maxOutputTokens: () => this.config().maxOutputTokens,
      maxTotalOutputTokens: () => this.config().maxTotalOutputTokens,
      reasoningMode: () => this.config().reasoning,
      maxAttempts: () => this.config().retryMaxAttempts,
    })
  }

  setNoticeHandler(handler: ((notice: MemoryWriteNotice) => void) | undefined): void {
    this.noticeHandler = handler
  }

  setActiveModelId(modelId: string): void {
    this.activeModelId = modelId
  }

  async initialize(_cwd: string): Promise<void> {
    if (this.initialized) return
    try {
      await this.jobStore.initialize()
      const loaded = await this.store.initialize()
      this.installSnapshot(loaded.topics, loaded.invalidTopics, loaded.generation)
      this.initialized = true
      this.refreshConfig()
      this.worker.wake()
    } catch (error) {
      this.initialized = true
      this.initializationError = error instanceof Error ? error.message : String(error)
      debugLog('memory.initialize-error', this.initializationError)
    }
  }

  getCoreProfile(): string {
    return this.initializationError ? '' : this.coreProfile
  }

  getConfig(): MemoryConfig {
    return this.refreshConfig()
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
    const config = this.refreshConfig()
    if (!this.available()) return null
    await this.synchronizeGeneration(state)
    this.ensureRetrieverConfig(config)
    if (state.memoryTokensInWindow >= config.recall.maxTokensPerCompactionWindow) return null
    const retrieved = this.retriever.retrieve(query)
    let selected = retrieved.selectedTopicIds
    if (retrieved.needsSelector && config.recall.semanticSelector === 'auto') {
      const outcome = await this.runSelector({
        query,
        manifest: this.index.manifest(),
        preferredTopicIds: retrieved.candidates.slice(0, 50).map((candidate) => candidate.topicId),
        failureLogTag: 'memory.selector-fallback',
      })
      if (outcome.ids) {
        selected = outcome.ids
        retrieved.trace.selectorUsed = true
      } else if (outcome.attempted) {
        selected = retrieved.candidates
          .filter(
            (candidate) =>
              candidate.routes.filter((route) => route !== 'pinned').length >= 2 && candidate.coverage >= 0.6,
          )
          .slice(0, 2)
          .map((candidate) => candidate.topicId)
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
    const config = this.refreshConfig()
    this.ensureRetrieverConfig(config)
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
    const candidateIds = retrieved.candidates
      .filter(
        (candidate) =>
          !surfaced.has(candidate.topicId) && candidate.routes.some((route) => route === 'exact' || route === 'bm25'),
      )
      .slice(0, 50)
      .map((candidate) => candidate.topicId)
    if (candidateIds.length === 0) return null
    const protectedExact = retrieved.candidates.filter(
      (candidate) => !surfaced.has(candidate.topicId) && candidate.protected && candidate.routes.includes('exact'),
    )
    let selected = protectedExact.length === 1 ? [protectedExact[0]!.topicId] : []
    if (selected.length === 0) {
      const outcome = await this.runSelector({
        query: {
          currentUserText: signals.currentUserText,
          recentConversationText: '',
          repositoryId: signals.repositoryId,
          mentionedPaths: [],
          identifiers: [],
          explicitHistoryIntent: false,
          explicitForgetIntent: false,
        },
        manifest: this.index.manifest(candidateIds),
        preferredTopicIds: candidateIds,
        untrustedSignals: signals.text,
        failureLogTag: 'memory.late-recall-selector-failed',
      })
      if (!outcome.ids) return null
      selected = outcome.ids.filter((topicId) => !surfaced.has(topicId)).slice(0, 2)
      retrieved.trace.selectorUsed = true
    }
    const attachment = this.retriever.pack(query, selected, signals.anchorMessageIndex, signals.placement)
    if (!attachment || attachment.estimatedTokens > remainingBudget || !addMemoryRecallAttachment(state, attachment)) {
      return null
    }
    state.lastMemoryRecallTrace = {
      ...retrieved.trace,
      selectedTopicIds: selected,
      packedTokens: attachment.estimatedTokens,
    }
    this.lastTrace = state.lastMemoryRecallTrace
    state.memoryGeneration = this.index.generation
    void appendMemoryRecall(state, attachment)
    return attachment
  }

  async enqueuePostTurnJob(job: MemoryJob): Promise<'created' | 'duplicate' | 'skipped'> {
    this.refreshConfig()
    if (!this.available()) return 'skipped'
    const result = await this.jobStore.enqueue(job)
    if (result === 'created') this.worker.wake()
    return result
  }

  async search(args: MemorySearchArgs, context: MemorySearchContext): Promise<MemorySearchResult[]> {
    const config = this.refreshConfig()
    if (!this.available()) return []
    this.ensureRetrieverConfig(config)
    const query = args.query.trim()
    if (!query || isWildcardMemoryQuery(query)) {
      throw new Error('memorySearch requires a specific, non-wildcard query')
    }
    const recallQuery: RecallQuery = {
      currentUserText: query,
      recentConversationText: '',
      repositoryId: context.repositoryId,
      mentionedPaths: [],
      identifiers: [],
      explicitHistoryIntent: HISTORY_INTENT_RE.test(query),
      explicitForgetIntent: FORGET_INTENT_RE.test(query),
    }
    const retrieved = this.retriever.retrieve(recallQuery)
    const lexicalCandidateIds = retrieved.candidates
      .filter((candidate) => candidate.protected || candidate.routes.some((route) => route !== 'pinned'))
      .map((candidate) => candidate.topicId)
    let candidateIds = lexicalCandidateIds
    if (args.semantic) {
      const outcome = await this.runSelector({
        query: recallQuery,
        manifest: this.index.manifest(),
        preferredTopicIds: lexicalCandidateIds,
        failureLogTag: 'memory.search-selector-fallback',
      })
      if (outcome.ids) candidateIds = outcome.ids
    }
    if (args.topicIds) {
      const candidates = new Set(candidateIds)
      if (args.topicIds.some((id) => !candidates.has(id)))
        throw new Error('topicIds cannot expand memory search candidates')
      candidateIds = candidateIds.filter((id) => args.topicIds!.includes(id))
    }
    const score = new Map(retrieved.candidates.map((candidate) => [candidate.topicId, candidate.score]))
    const results: MemorySearchResult[] = []
    for (const topicId of candidateIds) {
      const topic = this.index.topics.get(topicId)
      if (!topic) continue
      for (const section of topic.sections) {
        const activeFacts = section.facts.filter((fact) => args.includeStale || isMemoryFactActive(fact))
        if (section.facts.length && activeFacts.length === 0) continue
        results.push({
          topicId,
          section: section.headingPath.join(' / ') || 'root',
          status: section.facts.length
            ? activeFacts.some((fact) => isMemoryFactActive(fact))
              ? 'active'
              : 'stale'
            : topic.metadata.status,
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
        markExpectedCacheMiss(state, 'memory-context-change')
      }
    }
  }

  async status(): Promise<MemoryStatusReport> {
    this.refreshConfig()
    const queue = await this.jobStore.counts().catch(() => ({ pending: 0, running: 0, failed: 0 }))
    const lastRun = await this.jobStore.lastRun().catch(() => undefined)
    return {
      initialized: this.initialized,
      schemaVersion: this.initializationError ? undefined : 2,
      generation: this.index.generation,
      topics: this.topics.length,
      facts: this.topics.reduce((sum, topic) => sum + topic.facts.length, 0),
      queue,
      worker: this.worker.status,
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
    return this.currentConfig
  }

  private readConfig(): MemoryConfig {
    return this.options.config?.() ?? resolveMemoryConfig()
  }

  private refreshConfig(): MemoryConfig {
    this.currentConfig = this.readConfig()
    return this.currentConfig
  }

  private available(): boolean {
    return this.initialized && !this.initializationError
  }

  private createRetriever(config: MemoryConfig = this.config()): MemoryRetriever {
    const recall = config.recall
    this.retrieverConfigKey = JSON.stringify([
      recall.maxTopicsPerTurn,
      recall.maxTokensPerTopic,
      recall.maxTokensPerTurn,
    ])
    return new MemoryRetriever(this.index, {
      maxTopicsPerTurn: recall.maxTopicsPerTurn,
      maxTokensPerTopic: recall.maxTokensPerTopic,
      maxTokensPerTurn: recall.maxTokensPerTurn,
    })
  }

  private ensureRetrieverConfig(config: MemoryConfig): void {
    const key = JSON.stringify([
      config.recall.maxTopicsPerTurn,
      config.recall.maxTokensPerTopic,
      config.recall.maxTokensPerTurn,
    ])
    if (key !== this.retrieverConfigKey) this.retriever = this.createRetriever(config)
  }

  private installSnapshot(
    topics: MemoryTopic[],
    invalidTopics: Array<{ path: string; error: string }>,
    generation: number,
  ): void {
    if (
      (this.initialized || this.topics.length > 0) &&
      pinnedCoreSignature(this.topics) !== pinnedCoreSignature(topics)
    ) {
      this.pinnedInvalidationGeneration = generation
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

  /** Shared semantic-selector invocation. attempted=false means no usable
   *  model was configured; attempted=true with ids=null means the call
   *  failed and the caller should apply its own local fallback. */
  private async runSelector(input: {
    query: RecallQuery
    manifest: ReturnType<MemoryIndex['manifest']>
    preferredTopicIds: readonly string[]
    untrustedSignals?: string
    failureLogTag: string
  }): Promise<{ attempted: boolean; ids: string[] | null }> {
    const configured = this.config().recall.selectorModel
    const selectorModelId = configured === 'inherit' ? this.currentModelId() : configured
    const model = selectorModelId ? this.resolveModel(selectorModelId) : null
    if (!model) return { attempted: false, ids: null }
    try {
      const ids = await selectMemoryTopics({
        model,
        modelId: selectorModelId ?? undefined,
        reasoningMode: this.config().reasoning,
        query: input.query,
        manifest: input.manifest,
        preferredTopicIds: input.preferredTopicIds,
        ...(input.untrustedSignals !== undefined ? { untrustedSignals: input.untrustedSignals } : {}),
      })
      return { attempted: true, ids }
    } catch (error) {
      debugLog(input.failureLogTag, error instanceof Error ? error.message : String(error))
      return { attempted: true, ids: null }
    }
  }

  private async extractionContext(job: MemoryJob) {
    this.ensureRetrieverConfig(this.config())
    const query: RecallQuery = {
      currentUserText: `${job.projection.userMessages.join('\n')}\n${job.projection.assistantFinal}`,
      recentConversationText: '',
      repositoryId: job.repositoryId,
      mentionedPaths: job.projection.changedFiles,
      identifiers: [],
      explicitHistoryIntent: false,
      explicitForgetIntent: false,
    }
    const retrieved = this.retriever.retrieve(query)
    const ids = [
      ...new Set([...retrieved.selectedTopicIds, ...retrieved.candidates.slice(0, 3).map((item) => item.topicId)]),
    ].slice(0, 3)
    return {
      coreProfile: this.coreProfile,
      factRegistry: this.index.compactFactRegistry(2000, ids),
      existingTopicIds: [...this.index.topics.keys()],
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
    if (fromGeneration > toGeneration) {
      const factIds = [
        ...new Set(
          state.memoryRecallAttachments.flatMap((attachment) => attachment.topics.flatMap((topic) => topic.factIds)),
        ),
      ]
      const topicIds = [
        ...new Set(
          state.memoryRecallAttachments.flatMap((attachment) => attachment.topics.map((topic) => topic.topicId)),
        ),
      ]
      if (factIds.length > 0 || topicIds.length > 0) {
        const tombstone = { generation: toGeneration, factIds, topicIds }
        addMemoryRecallTombstone(state, tombstone)
        void appendMemoryRecallDelete(state, tombstone)
      }
      state.systemPromptCache = null
      markExpectedCacheMiss(state, 'memory-context-change')
      state.memoryGeneration = toGeneration
      return
    }
    if (fromGeneration === toGeneration) {
      state.memoryGeneration = toGeneration
      return
    }
    const factIds = new Set<string>()
    const topicIds = new Set<string>()
    const attachedFactIds = new Set(
      state.memoryRecallAttachments.flatMap((attachment) => attachment.topics.flatMap((topic) => topic.factIds)),
    )
    let pinnedChanged = false
    let manualEdit = false
    let missingChange = false
    if (toGeneration - fromGeneration <= 256) {
      for (let generation = fromGeneration + 1; generation <= toGeneration; generation++) {
        const change = await this.readChange(generation)
        if (!change) {
          missingChange = true
          continue
        }
        if (change.reason === 'manual-edit') manualEdit = true
        for (const item of [...change.changed, ...change.deleted]) {
          if (attachedFactIds.has(item.factId)) factIds.add(item.factId)
          const topic = this.index.topics.get(item.topicId)
          if (topic?.metadata.pinned) pinnedChanged = true
        }
      }
    } else {
      missingChange = true
    }
    const collectChangedAttachmentIds = () => {
      for (const attachment of state.memoryRecallAttachments) {
        for (const topic of attachment.topics) {
          if (this.index.topics.get(topic.topicId)?.hash !== topic.topicHash) topicIds.add(topic.topicId)
          for (const [factId, factHash] of Object.entries(topic.factHashes)) {
            if (this.index.facts.get(factId)?.factHash !== factHash) factIds.add(factId)
          }
        }
      }
    }
    if (missingChange) {
      collectChangedAttachmentIds()
      pinnedChanged = state.memoryRecallAttachments.some((attachment) =>
        attachment.topics.some((topic) => this.index.topics.get(topic.topicId)?.metadata.pinned),
      )
      // A missing manifest means we cannot prove the cached Core profile is
      // unchanged. Prefer one expected cache miss over retaining stale pinned
      // data across a damaged/pruned generation chain.
      if (state.systemPromptCache !== null) pinnedChanged = true
    }
    if (manualEdit) {
      collectChangedAttachmentIds()
    }
    if (factIds.size || topicIds.size) {
      const tombstone = { generation: toGeneration, factIds: [...factIds], topicIds: [...topicIds] }
      addMemoryRecallTombstone(state, tombstone)
      void appendMemoryRecallDelete(state, tombstone)
    }
    if (
      pinnedChanged ||
      (this.pinnedInvalidationGeneration > fromGeneration && this.pinnedInvalidationGeneration <= toGeneration)
    ) {
      state.systemPromptCache = null
      markExpectedCacheMiss(state, 'memory-context-change')
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
