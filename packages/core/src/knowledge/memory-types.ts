export type MemoryType = 'user' | 'portfolio' | 'feedback' | 'workflow' | 'project' | 'reference'
export type MemoryStatus = 'active' | 'stale'
export type EvidenceKind = 'explicit' | 'validated' | 'observed'

export interface MemoryEvidence {
  kind: EvidenceKind
  sourceId: string
  occurredAt: string
  contentHash?: string
}

export interface TopicMetadataPatch {
  type?: MemoryType
  description?: string
  summary?: string
  addKeywords?: string[]
  removeKeywords?: string[]
  addAliases?: string[]
  removeAliases?: string[]
  appliesTo?: string[]
  related?: string[]
  pinned?: boolean
}

export interface MemoryFactTarget {
  topicId: string
  factId?: string
  expectedTopicHash: string
}

export type MemoryOperation =
  | {
      action: 'upsert'
      topicId: string
      factId: string
      expectedTopicHash?: string
      content: string
      evidence: MemoryEvidence[]
      topicPatch?: TopicMetadataPatch
    }
  | {
      action: 'replace-conflict'
      topicId: string
      factId: string
      expectedTopicHash?: string
      content: string
      remove: Array<MemoryFactTarget & { factId: string }>
      evidence: MemoryEvidence[]
      reason: string
      topicPatch?: TopicMetadataPatch
    }
  | {
      action: 'delete'
      remove: MemoryFactTarget[]
      evidence: MemoryEvidence[]
      reason: 'explicit-forget'
      topicPatches?: Array<{ topicId: string; patch: TopicMetadataPatch }>
    }

export interface TurnMemoryProjection {
  userMessages: string[]
  assistantFinal: string
  events: Array<
    | { type: 'tool-call'; name: string; summary: string }
    | { type: 'tool-result'; name: string; status: 'ok' | 'error'; evidence: string }
  >
  changedFiles: string[]
  verification: string[]
  repositoryId: string
  turnStartedAt: string
  turnCompletedAt: string
}

export interface MemoryJob {
  version: 2
  jobId: string
  sessionId: string
  turnStartMessageIndex: number
  modelId: string
  repositoryId: string
  cwd: string
  createdAt: string
  sourceOccurredAt: string
  attempt: number
  explicitMemoryIntent: boolean
  nextAttemptAt?: string
  projection: TurnMemoryProjection
}

export interface MemoryFactMetadata {
  id: string
  observedAt: string
  evidence: EvidenceKind
  status: MemoryStatus
  expiresAt?: string
}

export interface MemoryFact {
  metadata: MemoryFactMetadata
  content: string
  hash: string
  sectionId: string
  start: number
  end: number
}

export interface MemorySection {
  id: string
  headingPath: string[]
  content: string
  facts: MemoryFact[]
  estimatedTokens: number
}

export interface MemoryTopicMetadata {
  id: string
  type: MemoryType
  description: string
  summary: string
  createdAt: string
  updatedAt: string
  status: MemoryStatus
  keywords: string[]
  aliases: string[]
  appliesTo: string[]
  related: string[]
  pinned: boolean
}

export interface MemoryTopic {
  metadata: MemoryTopicMetadata
  body: string
  facts: MemoryFact[]
  sections: MemorySection[]
  hash: string
  path: string
  raw: string
}

export interface MemorySchemaFile {
  version: 2
  generation: number
}

export interface MemoryChange {
  generation: number
  reason: 'upsert' | 'replace-conflict' | 'forget' | 'manual-edit'
  changed: Array<{ topicId: string; factId: string; previousHash?: string; nextHash: string }>
  deleted: Array<{ topicId: string; factId: string; previousHash: string }>
}

export interface MemoryTransactionManifest {
  transactionId: string
  baseGeneration: number
  targetGeneration: number
  writes: Array<{ target: string; staged: string; previousHash?: string; nextHash: string }>
  deletes: Array<{ target: string; previousHash: string }>
}

export interface RecallQuery {
  currentUserText: string
  recentConversationText: string
  repositoryId: string
  mentionedPaths: string[]
  identifiers: string[]
  explicitHistoryIntent: boolean
  explicitForgetIntent: boolean
}

export interface RecallCandidate {
  topicId: string
  score: number
  routes: string[]
  coverage: number
  protected: boolean
}

export interface MemoryRecallTrace {
  query: string
  generation: number
  selectorUsed: boolean
  candidates: RecallCandidate[]
  selectedTopicIds: string[]
  filtered: string[]
  packedTokens: number
}

export interface MemoryRecallAttachmentTopic {
  topicId: string
  topicHash: string
  factIds: string[]
  factHashes: Record<string, string>
  path: string
  renderedContent: string
}

export interface MemoryRecallAttachment {
  attachmentId: string
  anchorMessageIndex: number
  placement: 'before-user' | 'after-tool-results'
  topics: MemoryRecallAttachmentTopic[]
  estimatedTokens: number
}

export interface MemoryRecallTombstone {
  generation: number
  factIds: string[]
}

export interface LateRecallSignals {
  anchorMessageIndex: number
  repositoryId: string
  paths: string[]
  identifiers: string[]
  text: string
}

export interface MemorySearchArgs {
  query: string
  topicIds?: string[]
  maxResults?: number
  includeStale?: boolean
  semantic?: boolean
}

export interface MemorySearchContext {
  repositoryId: string
  currentUserText: string
  explicitHistoryIntent?: boolean
  allowedTopicIds?: string[]
}

export interface MemorySearchResult {
  topicId: string
  section: string
  status: MemoryStatus
  updatedAt: string
  path: string
  snippet: string
  score: number
}

export interface MemoryStatusReport {
  enabled: boolean
  initialized: boolean
  schemaVersion?: number
  generation: number
  topics: number
  facts: number
  queue: { pending: number; running: number; failed: number }
  worker: 'idle' | 'running' | 'stopped' | 'disabled'
  invalidTopics: Array<{ path: string; error: string }>
  lastRun?: {
    jobId: string
    status: string
    durationMs: number
    operations: number
    errorCategory?: string
  }
  error?: string
}

export interface MemoryWriteNotice {
  action: 'remembered' | 'updated' | 'forgotten' | 'failed'
  topicId?: string
  factId?: string
  content?: string
  error?: string
}

export interface MemoryOperationResult {
  status: 'success' | 'no-op' | 'warning'
  notices: MemoryWriteNotice[]
  generation: number
}
