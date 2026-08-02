import { createHash } from 'node:crypto'

import type { LanguageModel } from 'ai'

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
  }>
  commitOperations(
    operations: Awaited<ReturnType<typeof extractMemoryOperations>>['operations'],
    job: MemoryJob,
  ): Promise<MemoryOperationResult>
  onCommitted(result: MemoryOperationResult): Promise<void>
  onNotice(notice: MemoryWriteNotice): void
  maxOperations(): number
  maxOutputTokens(): number
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
    this.runningPromise = this.run().finally(() => {
      this.runningPromise = null
      void this.schedulePending()
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
        await this.options.jobStore.complete(job)
        return
      }
      const preferred = this.options.preferredModelId()
      const modelId = preferred && preferred !== 'inherit' ? preferred : job.modelId
      const model =
        this.options.resolveModel(modelId) ?? (modelId === job.modelId ? null : this.options.resolveModel(job.modelId))
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
        ...context,
        maxOperations: this.options.maxOperations(),
        maxOutputTokens: this.options.maxOutputTokens(),
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
      operations = safeOperations.length
      const committed = await this.options.commitOperations(safeOperations, job)
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

export function isDeleteOperationAuthorized(
  operation: Extract<MemoryOperation, { action: 'delete' }>,
  userMessages: readonly string[],
): boolean {
  const request = operation.userRequest.normalize('NFKC').trim()
  if (!request) return false
  return userMessages.some((message) => message.normalize('NFKC').includes(request))
}

export function bindOperationEvidence(operations: readonly MemoryOperation[], job: MemoryJob): MemoryOperation[] {
  const supported = new Set<MemoryOperation['evidence'][number]['kind']>(['explicit'])
  if (job.projection.verification.length > 0) supported.add('validated')
  if (
    job.projection.changedFiles.length > 0 ||
    job.projection.events.some((event) => event.type === 'tool-result' && event.status === 'ok')
  ) {
    supported.add('observed')
  }
  const contentHash = createHash('sha256').update(JSON.stringify(job.projection)).digest('hex')
  const bind = (operation: MemoryOperation): MemoryOperation | null => {
    const evidence = operation.evidence
      .filter((item) => supported.has(item.kind))
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
