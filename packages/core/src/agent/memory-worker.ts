import type { LanguageModel } from 'ai'

import type { MemoryReasoningMode } from '../config/index.js'
import { extractMemoryIdentifiers, extractMemoryPaths, normalizeMemoryText } from '../knowledge/memory-index.js'
import { memoryContentHash } from '../knowledge/memory-transaction-store.js'
import type { MemoryJob, MemoryOperation, MemoryOperationResult, MemoryWriteNotice } from '../knowledge/memory-types.js'
import { debugLog } from '../utils.js'
import { extractMemoryOperations } from './memory-extractor.js'
import type { MemoryJobStore } from './memory-job-store.js'

export interface MemoryWorkerOptions {
  jobStore: MemoryJobStore
  resolveModel(modelId: string): LanguageModel | null
  preferredModelId(): string | null
  contextFor(job: MemoryJob): Promise<{
    coreProfile: string
    factRegistry: string
    relatedTopics: Array<{ topicId: string; topicHash: string; content: string }>
    existingTopicIds?: readonly string[]
  }>
  commitOperations(
    operations: Awaited<ReturnType<typeof extractMemoryOperations>>['operations'],
    job: MemoryJob,
  ): Promise<MemoryOperationResult>
  onCommitted(result: MemoryOperationResult): Promise<void>
  onNotice(notice: MemoryWriteNotice): void
  maxOperations(): number
  maxOutputTokens(): number
  maxTotalOutputTokens?(): number
  reasoningMode?(): MemoryReasoningMode
  maxAttempts(): number
}

export class MemoryWorker {
  private runningPromise: Promise<void> | null = null
  private stopped = false
  private retryTimer: NodeJS.Timeout | null = null
  private lockRetryNotBefore = 0
  private activeController: AbortController | null = null

  constructor(private readonly options: MemoryWorkerOptions) {}

  get status(): 'idle' | 'running' | 'stopped' {
    if (this.stopped) return 'stopped'
    return this.runningPromise ? 'running' : 'idle'
  }

  wake(): void {
    if (this.stopped || this.runningPromise) return
    this.runningPromise = this.run()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        debugLog('memory-worker.run-error', message)
        try {
          this.options.onNotice({ action: 'failed', error: message })
        } catch (noticeError) {
          debugLog(
            'memory-worker.notice-error',
            noticeError instanceof Error ? noticeError.message : String(noticeError),
          )
        }
      })
      .finally(() => {
        this.runningPromise = null
        void this.schedulePending().catch((error) => {
          debugLog('memory-worker.schedule-error', error instanceof Error ? error.message : String(error))
        })
      })
  }

  async shutdown(timeoutMs: number): Promise<void> {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const running = this.runningPromise
    if (!running) return
    let deadline: NodeJS.Timeout | undefined
    const drained = await Promise.race([
      running.then(() => true),
      new Promise<false>((resolve) => {
        deadline = setTimeout(() => resolve(false), Math.max(0, timeoutMs))
      }),
    ])
    if (deadline) clearTimeout(deadline)
    if (!drained) {
      this.activeController?.abort(new Error('Memory worker shutdown deadline reached'))
      await Promise.race([running, new Promise<void>((resolve) => setTimeout(resolve, 250))])
    }
  }

  private async run(): Promise<void> {
    const lease = await this.options.jobStore.tryAcquireExtractorLock()
    if (!lease) {
      this.lockRetryNotBefore = Date.now() + 1000
      return
    }
    try {
      await this.options.jobStore.recoverRunning()
      while (!this.stopped) {
        const job = await this.options.jobStore.claimNext()
        if (!job) break
        await this.process(job)
      }
    } finally {
      await lease.release()
    }
  }

  private async process(job: MemoryJob): Promise<void> {
    const started = Date.now()
    let tokens = 0
    let operations = 0
    const controller = new AbortController()
    this.activeController = controller
    try {
      if (await this.options.jobStore.isApplied(job.jobId)) {
        await this.options.jobStore.appendRun({
          jobId: job.jobId,
          status: 'no-op',
          durationMs: Date.now() - started,
          tokens: 0,
          operations: 0,
          completedAt: new Date().toISOString(),
        })
        await this.options.jobStore.complete(job)
        return
      }
      const preferred = this.options.preferredModelId()
      const modelId = preferred && preferred !== 'inherit' ? preferred : job.modelId
      let resolvedModelId = modelId
      let model = this.options.resolveModel(modelId)
      if (!model && modelId !== job.modelId) {
        resolvedModelId = job.modelId
        model = this.options.resolveModel(job.modelId)
      }
      if (!model) {
        const retry = await this.options.jobStore.retry(job, this.options.maxAttempts())
        if (retry === 'failed') {
          await this.options.jobStore.appendRun({
            jobId: job.jobId,
            status: 'failed',
            durationMs: Date.now() - started,
            tokens: 0,
            operations: 0,
            errorCategory: 'model-unavailable',
            completedAt: new Date().toISOString(),
          })
          this.options.onNotice({ action: 'failed', error: `Memory model unavailable: ${modelId}` })
        }
        return
      }
      const context = await this.options.contextFor(job)
      const extracted = await extractMemoryOperations({
        job,
        model,
        modelId: resolvedModelId,
        ...context,
        maxOperations: this.options.maxOperations(),
        maxOutputTokens: this.options.maxOutputTokens(),
        maxTotalOutputTokens: this.options.maxTotalOutputTokens?.(),
        reasoningMode: this.options.reasoningMode?.(),
        abortSignal: controller.signal,
      })
      tokens = extracted.tokens
      const safeOperations = bindOperationEvidence(
        extracted.operations.filter(
          (operation) =>
            operation.action !== 'delete' || isDeleteOperationAuthorized(operation, job.projection.userMessages),
        ),
        job,
      )
      if (
        shouldRetryUngroundedOperations(job.explicitMemoryIntent, extracted.operations.length, safeOperations.length)
      ) {
        throw new Error('All extracted memory operations lacked grounded evidence')
      }
      operations = safeOperations.length
      const committed = await this.options.commitOperations(safeOperations, job)
      const rejection = rejectedOperationsError(committed, operations)
      if (rejection && !(await this.options.jobStore.isApplied(job.jobId))) throw new Error(rejection)
      await this.options.onCommitted(committed)
      const status = committed.status === 'success' ? 'success' : committed.status
      await this.options.jobStore.appendRun({
        jobId: job.jobId,
        status,
        durationMs: Date.now() - started,
        tokens,
        operations,
        completedAt: new Date().toISOString(),
      })
      await this.options.jobStore.complete(job)
      for (const notice of committed.notices) this.options.onNotice(notice)
    } catch (error) {
      const retry = await this.options.jobStore.retry(job, this.options.maxAttempts())
      const message = error instanceof Error ? error.message : String(error)
      debugLog('memory-worker.error', `${job.jobId}: ${message}`)
      if (retry === 'failed') {
        await this.options.jobStore.appendRun({
          jobId: job.jobId,
          status: 'failed',
          durationMs: Date.now() - started,
          tokens,
          operations,
          errorCategory: 'extract-or-commit',
          completedAt: new Date().toISOString(),
        })
        this.options.onNotice({ action: 'failed', error: message })
      }
    } finally {
      if (this.activeController === controller) this.activeController = null
    }
  }

  private async schedulePending(): Promise<void> {
    if (this.stopped || this.retryTimer) return
    const delay = await this.options.jobStore.nextPendingDelay()
    if (delay === null || this.stopped) return
    const lockDelay = Math.max(0, this.lockRetryNotBefore - Date.now())
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null
        this.wake()
      },
      Math.max(10, delay + 25, lockDelay),
    )
    this.retryTimer.unref?.()
  }
}

export function rejectedOperationsError(result: MemoryOperationResult, operationCount: number): string | null {
  if (operationCount === 0 || result.status !== 'warning' || !result.notices.length) return null
  if (result.notices.some((notice) => notice.action !== 'failed')) return null
  const reasons = [...new Set(result.notices.map((notice) => notice.error).filter(Boolean))]
  return `All ${operationCount} memory operation${operationCount === 1 ? '' : 's'} were rejected${
    reasons.length ? `: ${reasons.join('; ')}` : ''
  }`
}

export function shouldRetryUngroundedOperations(
  explicitMemoryIntent: boolean,
  extractedCount: number,
  groundedCount: number,
): boolean {
  return explicitMemoryIntent && extractedCount > 0 && groundedCount === 0
}

export function isDeleteOperationAuthorized(
  operation: Extract<MemoryOperation, { action: 'delete' }>,
  userMessages: readonly string[],
): boolean {
  const request = operation.userRequest.normalize('NFKC').trim()
  if (!request) return false
  return userMessages.some((message) => message.normalize('NFKC').trim() === request)
}

export function bindOperationEvidence(operations: readonly MemoryOperation[], job: MemoryJob): MemoryOperation[] {
  const observedPaths = new Set(job.projection.changedFiles.map(normalizeMemoryText))
  const observedIdentifiers = new Set<string>()
  for (const event of job.projection.events) {
    if (event.type !== 'tool-result' || event.status !== 'ok') continue
    const start = event.evidence.indexOf('; signals=')
    const end = event.evidence.lastIndexOf('; status=')
    if (start < 0 || end <= start) continue
    const signals = event.evidence.slice(start + '; signals='.length, end)
    for (const value of extractMemoryPaths(signals)) observedPaths.add(normalizeMemoryText(value))
    for (const value of extractMemoryIdentifiers(signals)) observedIdentifiers.add(normalizeMemoryText(value))
  }
  const contentHash = memoryContentHash(JSON.stringify(job.projection))
  const bind = (operation: MemoryOperation): MemoryOperation | null => {
    const supported = new Set<MemoryOperation['evidence'][number]['kind']>(['explicit'])
    if (job.projection.verification.length > 0) supported.add('validated')
    if (operation.action !== 'delete') {
      const hasObservedPath = extractMemoryPaths(operation.content).some((value) =>
        observedPaths.has(normalizeMemoryText(value)),
      )
      const hasObservedIdentifier = extractMemoryIdentifiers(operation.content).some((value) =>
        observedIdentifiers.has(normalizeMemoryText(value)),
      )
      if (hasObservedPath || hasObservedIdentifier) supported.add('observed')
    }
    const evidence = operation.evidence
      .filter(
        (item) =>
          supported.has(item.kind) &&
          (item.kind !== 'explicit' ||
            isExplicitEvidenceSupported(item.sourceId, job.projection.userMessages, job.explicitMemoryIntent)),
      )
      .map((item) => ({
        kind: item.kind,
        sourceId: `memory-job:${job.jobId}:${item.kind}`,
        occurredAt: job.sourceOccurredAt,
        contentHash,
      }))
    if (evidence.length === 0) return null
    return { ...operation, evidence } as MemoryOperation
  }
  return operations.map(bind).filter((operation): operation is MemoryOperation => Boolean(operation))
}

function isExplicitEvidenceSupported(
  sourceId: string,
  userMessages: readonly string[],
  explicitMemoryIntent: boolean,
): boolean {
  const quote = sourceId.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if ([...quote].length < 2) return false
  return userMessages.some((message) => {
    const normalized = message.normalize('NFKC').replace(/\s+/g, ' ').trim()
    if (!normalized.includes(quote)) return false
    return explicitMemoryIntent || !isQuestionLike(normalized)
  })
}

function isQuestionLike(value: string): boolean {
  return (
    /[?？]\s*$/.test(value) ||
    /^(?:what|which|who|whose|where|when|why|how|do|does|did|is|are|was|were|can|could|would|should)\b/i.test(value) ||
    /(?:吗|么|呢|什么|哪个|哪一个|为什么|怎么|如何|是否)[？?。！!\s]*$/.test(value)
  )
}
