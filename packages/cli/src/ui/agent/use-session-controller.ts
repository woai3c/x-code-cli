import { useCallback, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import {
  appendCheckpoint,
  captureSessionForkSnapshot,
  cloneUsageBreakdown,
  createLoopState,
  createUsageBreakdown,
  errorMessage,
  extractText,
  forkSession as forkCoreSession,
  getDiffStatsForCheckpoint,
  hydrateLoopState,
  markBoundaryAndReflush,
  restoreCheckpoint,
  saveSession,
  scanCacheMisses,
} from '@x-code-cli/core'
import type {
  AgentOptions,
  CheckpointEntry,
  DiffStats,
  ExecutionAuthority,
  LanguageModel,
  LoadedSession,
  LoopState,
  PermissionDecision,
  QueuedAgentInput,
  SessionForkSnapshot,
} from '@x-code-cli/core'

import { cloneCacheMissSummary, initialAgentState } from './agent-state.js'
import { disposeShellSessionsForTransition } from './shell-session-transition.js'
import type { TurnCoordinator } from './turn-coordinator.js'
import type { AgentState, PendingQuestion } from './types.js'
import { modelMessagesToDisplay } from './use-agent-display.js'

interface MutableRef<T> {
  current: T
}

export interface ActiveForkBoundary {
  snapshot: SessionForkSnapshot | null
  error?: string
}

interface PendingTool {
  toolName: string
  input: Record<string, unknown>
  startedAt: number
}

interface UseSessionControllerOptions {
  agentOptions: AgentOptions
  setState: Dispatch<SetStateAction<AgentState>>
  loopStateRef: MutableRef<LoopState | null>
  modelRef: MutableRef<LanguageModel>
  modelIdRef: MutableRef<string>
  permissionModeRef: MutableRef<AgentState['permissionMode']>
  activeForkBoundaryRef: MutableRef<ActiveForkBoundary | null>
  turnCoordinatorRef: MutableRef<TurnCoordinator>
  pendingToolsRef: MutableRef<Map<string, PendingTool>>
  permissionResolversRef: MutableRef<Array<(decision: PermissionDecision) => void>>
  pendingQuestionRef: MutableRef<PendingQuestion | null>
  queuedMessagesRef: MutableRef<QueuedAgentInput[]>
  bindShellSessionEvents: (state: LoopState) => void
  resetBuffer: () => void
  currentAuthority: (source?: 'user' | 'peer') => ExecutionAuthority
  hasPendingPeerInput: () => boolean
}

export function useSessionController({
  agentOptions,
  setState,
  loopStateRef,
  modelRef,
  modelIdRef,
  permissionModeRef,
  activeForkBoundaryRef,
  turnCoordinatorRef,
  pendingToolsRef,
  permissionResolversRef,
  pendingQuestionRef,
  queuedMessagesRef,
  bindShellSessionEvents,
  resetBuffer,
  currentAuthority,
  hasPendingPeerInput,
}: UseSessionControllerOptions) {
  const pendingForksRef = useRef(new Set<Promise<unknown>>())

  const cleanup = useCallback(async () => {
    const sessionSave = loopStateRef.current ? saveSession(loopStateRef.current, modelRef.current) : Promise.resolve()
    const memoryDrain = agentOptions.memoryService
      ? agentOptions.memoryService.shutdown(agentOptions.memoryService.getConfig().drainTimeoutMs)
      : Promise.resolve()
    const forkDrain = Promise.allSettled([...pendingForksRef.current])
    await Promise.all([sessionSave, memoryDrain, forkDrain])
  }, [agentOptions.memoryService, loopStateRef, modelRef])

  const reloadMemory = useCallback(async () => {
    await agentOptions.memoryService?.reload(loopStateRef.current ?? undefined)
  }, [agentOptions.memoryService, loopStateRef])

  const getSessionInfo = useCallback(() => {
    const state = loopStateRef.current
    if (!state || state.messages.length === 0) return null
    const firstUserMessage = state.messages.find((message) => message.role === 'user')
    const firstPrompt = firstUserMessage ? extractText(firstUserMessage.content).slice(0, 80) : ''
    return {
      sessionId: state.sessionId,
      taskSlug: state.taskSlug,
      messageCount: state.messages.length,
      firstPrompt,
      peerInfluenced: state.contextSecurity.peerInfluenceActive || state.contextSecurity.integrityFailure === true,
    }
  }, [loopStateRef])

  const fork = useCallback(
    async (name?: string) => {
      const boundary = activeForkBoundaryRef.current
      const activeOwner = turnCoordinatorRef.current.current()?.owner
      if (activeOwner && !boundary) {
        return {
          ok: false as const,
          reason: `Cannot fork while ${activeOwner} owns the active turn because no stable conversation boundary exists.`,
        }
      }
      if (boundary?.error) return { ok: false as const, reason: boundary.error }
      let snapshot = boundary?.snapshot ?? null
      if (!boundary && loopStateRef.current) {
        try {
          snapshot = captureSessionForkSnapshot(loopStateRef.current)
        } catch (error) {
          return { ok: false as const, reason: errorMessage(error) }
        }
      }
      if (!snapshot || snapshot.trackedMessages.length === 0) {
        return {
          ok: false as const,
          reason: boundary
            ? 'No completed conversation context exists before the active request.'
            : 'No active conversation to fork.',
        }
      }
      const operation = forkCoreSession(snapshot, modelIdRef.current, { name })
      pendingForksRef.current.add(operation)
      try {
        const result = await operation
        return { ok: true as const, ...result, excludedActiveTurn: boundary !== null }
      } catch (error) {
        return { ok: false as const, reason: errorMessage(error) }
      } finally {
        pendingForksRef.current.delete(operation)
      }
    },
    [activeForkBoundaryRef, loopStateRef, modelIdRef, turnCoordinatorRef],
  )

  const beginSessionTransition = useCallback(
    async (operation: 'clear' | 'resume') => {
      const lease = turnCoordinatorRef.current.tryAcquire(operation, currentAuthority())
      if (!lease) return { ok: false as const, reason: 'another turn is active' }
      if (hasPendingPeerInput()) {
        lease.release()
        return { ok: false as const, reason: 'peer input is waiting for review' }
      }
      const previous = loopStateRef.current
      if (previous) {
        const disposed = await disposeShellSessionsForTransition(previous.shellSessions, operation)
        if (!disposed.ok) {
          lease.release()
          return { ok: false as const, reason: disposed.reason, result: disposed.result }
        }
      }
      return { ok: true as const, lease, previous }
    },
    [currentAuthority, hasPendingPeerInput, loopStateRef, turnCoordinatorRef],
  )

  const clear = useCallback(
    async (commandText = '/clear') => {
      const transition = await beginSessionTransition('clear')
      if (!transition.ok) return transition
      const { lease, previous } = transition
      const nextState = createLoopState(permissionModeRef.current, {
        projectCwd: previous?.projectCwd ?? process.cwd(),
      })
      loopStateRef.current = nextState
      bindShellSessionEvents(nextState)
      pendingToolsRef.current.clear()
      permissionResolversRef.current = []
      pendingQuestionRef.current = null
      queuedMessagesRef.current = []
      resetBuffer()
      setState((previousState) => ({
        ...initialAgentState,
        modelId: previousState.modelId,
        permissionMode: previousState.permissionMode,
        messages: [
          {
            id: `cmd-${Date.now()}`,
            role: 'user',
            content: commandText,
            timestamp: Date.now(),
            kind: 'command-echo',
          },
        ],
      }))
      lease.release()
      return { ok: true as const }
    },
    [
      beginSessionTransition,
      bindShellSessionEvents,
      loopStateRef,
      pendingQuestionRef,
      pendingToolsRef,
      permissionModeRef,
      permissionResolversRef,
      queuedMessagesRef,
      resetBuffer,
      setState,
    ],
  )

  const resume = useCallback(
    async (loaded: LoadedSession) => {
      const transition = await beginSessionTransition('resume')
      if (!transition.ok) return transition
      const { lease, previous } = transition
      pendingToolsRef.current.clear()
      queuedMessagesRef.current = []
      resetBuffer()
      loopStateRef.current = hydrateLoopState(loaded, permissionModeRef.current, previous?.projectCwd ?? process.cwd())
      bindShellSessionEvents(loopStateRef.current)
      const converted = modelMessagesToDisplay(loaded.messages)
      setState((previousState) => ({
        ...previousState,
        activeToolCalls: [],
        shellOutput: '',
        error: null,
        reconnectLabel: null,
        todos: [],
        queuedMessages: [],
        restoredDraft: null,
        messages: [...previousState.messages, ...converted],
        usage: { ...loaded.tokenUsage },
        usageBreakdown: loaded.usageBreakdown ? cloneUsageBreakdown(loaded.usageBreakdown) : createUsageBreakdown(),
        cacheMissSummary: cloneCacheMissSummary(loaded.cacheMissSummary ?? scanCacheMisses(loaded.providerTurns ?? [])),
        stepStats: loaded.stepStats.slice(),
        goalStatus: loaded.goal ? { ...loaded.goal } : null,
        peerInfluenced: loaded.contextSecurity.peerInfluenceActive,
      }))
      lease.release()
      return { ok: true as const }
    },
    [
      beginSessionTransition,
      bindShellSessionEvents,
      loopStateRef,
      pendingToolsRef,
      permissionModeRef,
      queuedMessagesRef,
      resetBuffer,
      setState,
    ],
  )

  const getCheckpoints = useCallback((): CheckpointEntry[] => {
    return loopStateRef.current?.checkpoints.slice() ?? []
  }, [loopStateRef])

  const rewind = useCallback(
    async (
      checkpointId: string,
      mode: 'both' | 'code' | 'conversation' = 'both',
    ): Promise<{ ok: true; preview: string; messageCount: number } | { ok: false; reason: string }> => {
      const state = loopStateRef.current
      if (!state) return { ok: false, reason: 'No active session to rewind.' }
      const lease = turnCoordinatorRef.current.tryAcquire('rewind', currentAuthority())
      if (!lease) {
        return { ok: false, reason: 'A turn is in progress. Press Esc to cancel it, then run /rewind.' }
      }
      try {
        const target = state.checkpoints.find((checkpoint) => checkpoint.ckptId === checkpointId)
        if (!target) return { ok: false, reason: `Checkpoint not found: ${checkpointId}` }

        if (mode === 'both' || mode === 'code') {
          const restored = await restoreCheckpoint(state, checkpointId)
          if (!restored) {
            return {
              ok: false,
              reason: 'Failed to read checkpoint manifest — backups may have been cleaned up.',
            }
          }
        }

        if (mode === 'both' || mode === 'conversation') {
          const newLength = Math.max(0, target.messageCount - 1)
          const candidate = state.trackedMessages.slice(0, newLength)
          const survivingCheckpoints = state.checkpoints.filter(
            (checkpoint) => checkpoint.messageCount <= candidate.length,
          )
          await markBoundaryAndReflush(state, undefined, candidate)
          state.checkpoints = survivingCheckpoints
          for (const checkpoint of survivingCheckpoints) await appendCheckpoint(state, checkpoint)

          pendingToolsRef.current.clear()
          resetBuffer()
          const converted = modelMessagesToDisplay(state.messages)
          setState((previousState) => ({
            ...previousState,
            activeToolCalls: [],
            shellOutput: '',
            error: null,
            reconnectLabel: null,
            todos: [],
            messages: converted,
          }))
        }

        return { ok: true, preview: target.userPrompt, messageCount: target.messageCount - 1 }
      } finally {
        lease.release()
      }
    },
    [currentAuthority, loopStateRef, pendingToolsRef, resetBuffer, setState, turnCoordinatorRef],
  )

  const getDiffStats = useCallback(
    async (checkpointId: string): Promise<DiffStats | null> => {
      const state = loopStateRef.current
      if (!state) return null
      return getDiffStatsForCheckpoint(state, checkpointId)
    },
    [loopStateRef],
  )

  const activeTurnOwner = useCallback(() => turnCoordinatorRef.current.current()?.owner ?? null, [turnCoordinatorRef])
  const hasActiveForkBoundary = useCallback(() => activeForkBoundaryRef.current !== null, [activeForkBoundaryRef])

  return {
    cleanup,
    reloadMemory,
    getSessionInfo,
    fork,
    clear,
    resume,
    getCheckpoints,
    rewind,
    getDiffStats,
    activeTurnOwner,
    hasActiveForkBoundary,
  }
}
