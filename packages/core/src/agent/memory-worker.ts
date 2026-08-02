import type { LanguageModel } from 'ai'

import type { MemoryJob, MemoryOperationResult, MemoryWriteNotice } from '../knowledge/memory-types.js'
import { debugLog } from '../utils.js'
import { extractMemoryOperations } from './memory-extractor.js'
import type { MemoryJobStore } from './memory-job-store.js'

const EXPLICIT_FORGET_RE = /(?:忘记|别记|从记忆中删除|forget|remove\s+(?:this\s+)?memory)/i

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
  ): Promise<MemoryOperationResult>
  onCommitted(result: MemoryOperationResult): Promise<void>
  onNotice(notice: MemoryWriteNotice): void
  maxOperations: number
  maxOutputTokens: number
  maxAttempts: number
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
      const preferred = this.options.preferredModelId()
      const modelId = preferred && preferred !== 'inherit' ? preferred : job.modelId
      const model =
        this.options.resolveModel(modelId) ?? (modelId === job.modelId ? null : this.options.resolveModel(job.modelId))
      if (!model) {
        await this.options.jobStore.fail(job)
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
        return
      }
      const context = await this.options.contextFor(job)
      const extracted = await extractMemoryOperations({
        job,
        model,
        ...context,
        maxOperations: this.options.maxOperations,
        maxOutputTokens: this.options.maxOutputTokens,
        abortSignal: controller.signal,
      })
      tokens = extracted.tokens
      const explicitForget = EXPLICIT_FORGET_RE.test(job.projection.userMessages.join('\n'))
      const safeOperations = extracted.operations.filter((operation) => operation.action !== 'delete' || explicitForget)
      operations = safeOperations.length
      const committed = await this.options.commitOperations(safeOperations)
      await this.options.onCommitted(committed)
      await this.options.jobStore.complete(job)
      const status = committed.status === 'success' ? 'success' : committed.status
      await this.options.jobStore.appendRun({
        jobId: job.jobId,
        status,
        durationMs: Date.now() - started,
        tokens,
        operations,
        completedAt: new Date().toISOString(),
      })
      for (const notice of committed.notices) this.options.onNotice(notice)
    } catch (error) {
      const retry = await this.options.jobStore.retry(job, this.options.maxAttempts)
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
