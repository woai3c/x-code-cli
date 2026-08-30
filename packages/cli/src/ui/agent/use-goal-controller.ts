import { useCallback, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import {
  admitGoalInput,
  appendGoalInput,
  appendGoalState,
  appendGoalVerification,
  appendHeader,
  buildVerifierFailurePrompt,
  cancelGoal as cancelCoreGoal,
  clearGoal as clearCoreGoal,
  clearPendingTransition,
  createGoal as createCoreGoal,
  createGoalRunCoordinator,
  createLoopState,
  generateTaskSlug,
  markExpectedCacheMiss,
  pauseGoal as pauseCoreGoal,
  recordVerificationFailure,
  resetVerificationFailures,
  resumeGoal as resumeCoreGoal,
  runGoalLoop,
  runVerifierLadder,
  updateGoalStatus,
} from '@x-code-cli/core'
import type {
  AgentCallbacks,
  AgentOptions,
  AuthorityApproval,
  DisplayMessage,
  ExecutionAuthority,
  GoalState,
  LanguageModel,
  LoopState,
  PermissionDecision,
  PermissionMode,
  StreamRetryEvent,
} from '@x-code-cli/core'

import type { GoalToolLifecycleCallbacks } from './agent-tool-lifecycle.js'
import { authorityApproval } from './authority-approval.js'
import { OTHER_OPTION } from './question-options.js'
import type { TurnCoordinator, TurnLease } from './turn-coordinator.js'
import type { AgentState, PendingAuthority, PendingQuestion, RunGoalCommand, SubmitAgentInput } from './types.js'
import { extractLastAssistantText } from './use-stream-buffer.js'

interface MutableRef<T> {
  current: T
}

interface UseGoalControllerOptions {
  agentOptions: AgentOptions
  setState: Dispatch<SetStateAction<AgentState>>
  modelRef: MutableRef<LanguageModel>
  modelIdRef: MutableRef<string>
  thinkingRef: MutableRef<boolean>
  permissionModeRef: MutableRef<PermissionMode>
  loopStateRef: MutableRef<LoopState | null>
  abortControllerRef: MutableRef<AbortController | null>
  pendingQuestionRef: MutableRef<PendingQuestion | null>
  pendingAuthorityRef: MutableRef<PendingAuthority | null>
  authorityRequestSequenceRef: MutableRef<number>
  permissionResolversRef: MutableRef<Array<(decision: PermissionDecision) => void>>
  turnCoordinatorRef: MutableRef<TurnCoordinator>
  appendMessage: (message: DisplayMessage) => void
  appendTextDelta: AgentCallbacks['onTextDelta']
  goalToolLifecycleCallbacks: GoalToolLifecycleCallbacks
  handleStreamRetry: (event: StreamRetryEvent | null) => void
  bindShellSessionEvents: (state: LoopState) => void
  currentAuthority: (source?: 'user' | 'peer') => ExecutionAuthority
  submit: SubmitAgentInput
}

export function useGoalController({
  agentOptions,
  setState,
  modelRef,
  modelIdRef,
  thinkingRef,
  permissionModeRef,
  loopStateRef,
  abortControllerRef,
  pendingQuestionRef,
  pendingAuthorityRef,
  authorityRequestSequenceRef,
  permissionResolversRef,
  turnCoordinatorRef,
  appendMessage,
  appendTextDelta,
  goalToolLifecycleCallbacks,
  handleStreamRetry,
  bindShellSessionEvents,
  currentAuthority,
  submit,
}: UseGoalControllerOptions) {
  const goalCoordinatorRef = useRef(createGoalRunCoordinator())

  const createGoalCallbacks = useCallback((): AgentCallbacks => {
    return {
      onTextDelta: appendTextDelta,
      ...goalToolLifecycleCallbacks,
      onAskPermission: (toolCall) => {
        return new Promise<PermissionDecision>((resolve) => {
          permissionResolversRef.current.push(resolve)
          const mcpEntry = agentOptions.mcpRegistry?.get(toolCall.toolName)
          setState((previous) => ({
            ...previous,
            permissionQueue: [
              ...previous.permissionQueue,
              {
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                input: toolCall.input,
                mcp: mcpEntry ? { serverName: mcpEntry.serverName, rawName: mcpEntry.rawName } : undefined,
              },
            ],
          }))
        })
      },
      onAskAuthority: (request) => {
        return new Promise<AuthorityApproval>((resolve) => {
          const pending: PendingAuthority = { ...request, requestId: authorityRequestSequenceRef.current++, resolve }
          pendingAuthorityRef.current = pending
          void agentOptions.peerService?.updateLocalState({ status: 'waiting' }).catch(() => {})
          setState((previous) => ({ ...previous, authorityRequest: pending }))
        })
      },
      onAskUser: (question, options) => {
        return new Promise<string>((resolve) => {
          const pendingQuestion: PendingQuestion = {
            question,
            options: [...options, OTHER_OPTION],
            resolve,
            abortAnswer: '',
            layout: 'compact-vertical',
          }
          pendingQuestionRef.current = pendingQuestion
          setState((previous) => ({ ...previous, pendingQuestion }))
        })
      },
      onPlanApprovalRequest: async () => false,
      onPlanModeChange: (mode) => {
        permissionModeRef.current = mode
        setState((previous) => ({ ...previous, permissionMode: mode }))
      },
      onTodosUpdate: (todos) => setState((previous) => ({ ...previous, todos })),
      onShellOutput: (chunk) => setState((previous) => ({ ...previous, shellOutput: previous.shellOutput + chunk })),
      onUsageUpdate: (usage) => setState((previous) => ({ ...previous, usage })),
      onContextCompressed: (summary) => {
        appendMessage({
          id: `compress-${Date.now()}`,
          role: 'assistant',
          content: summary,
          timestamp: Date.now(),
          kind: 'command-result',
        })
      },
      onStreamRetry: handleStreamRetry,
      onError: (error) => setState((previous) => ({ ...previous, error: error.message })),
    }
  }, [
    agentOptions.mcpRegistry,
    agentOptions.peerService,
    appendMessage,
    appendTextDelta,
    goalToolLifecycleCallbacks,
    handleStreamRetry,
    pendingAuthorityRef,
    authorityRequestSequenceRef,
    pendingQuestionRef,
    permissionModeRef,
    permissionResolversRef,
    setState,
  ])

  const ensureLoopState = useCallback((): LoopState => {
    if (!loopStateRef.current) {
      loopStateRef.current = createLoopState(permissionModeRef.current, { projectCwd: process.cwd() })
      bindShellSessionEvents(loopStateRef.current)
    }
    return loopStateRef.current
  }, [bindShellSessionEvents, loopStateRef, permissionModeRef])

  const prepareGoalSession = useCallback(
    async (state: LoopState, firstPrompt: string) => {
      if (!state.taskSlug) {
        state.taskSlug = generateTaskSlug(firstPrompt)
      }
      await appendHeader(state, modelIdRef.current, firstPrompt)
    },
    [modelIdRef],
  )

  const executeGoalLoop = useCallback(
    async (state: LoopState, goalId: string, signal: AbortSignal, lease: TurnLease): Promise<void> => {
      await runGoalLoop({
        state,
        model: modelRef.current,
        options: {
          ...agentOptions,
          modelId: modelIdRef.current,
          thinking: thinkingRef.current,
          permissionMode: permissionModeRef.current,
          abortSignal: signal,
        },
        callbacks: createGoalCallbacks(),
        goalId,
        signal,
        runAgentTurn: async (content, turnOptions) => {
          const result = await submit(content, {
            silent: true,
            toolFilter: turnOptions?.finalSummary ? { allow: [] } : undefined,
            maxTurns: turnOptions?.finalSummary ? 1 : undefined,
            signal,
            skipIdleDrain: true,
            owner: 'goal',
            lease,
            authority: lease.authority as ExecutionAuthority,
          })
          if (!result) throw new Error('Goal agent turn did not complete')
          return {
            ...result,
            text: extractLastAssistantText(result.state.messages),
          }
        },
      })
    },
    [agentOptions, createGoalCallbacks, modelIdRef, modelRef, permissionModeRef, submit, thinkingRef],
  )

  const runGoal = useCallback(
    async (command: RunGoalCommand): Promise<void> => {
      const lease = turnCoordinatorRef.current.tryAcquire('goal', currentAuthority())
      if (!lease) return
      const state = ensureLoopState()
      try {
        const goal = createCoreGoal(state, {
          objective: command.objective,
          maxTurns: command.maxTurns,
          tokenBudget: command.tokenBudget,
          verifiers: command.verifiers ?? [],
          requiresUserConfirmation: command.requiresUserConfirmation,
        })
        setState((previous) => ({ ...previous, goalStatus: { ...goal }, goalRunnerActive: true }))
        await prepareGoalSession(state, command.objective)
        await appendGoalState(state)

        await goalCoordinatorRef.current.run(goal.id, async (signal) => {
          try {
            await executeGoalLoop(state, goal.id, signal, lease)
          } finally {
            if (loopStateRef.current) {
              await appendGoalState(loopStateRef.current)
              setState((previous) => ({
                ...previous,
                goalStatus: loopStateRef.current?.goal ? { ...loopStateRef.current.goal } : null,
                goalRunnerActive: false,
              }))
            } else {
              setState((previous) => ({ ...previous, goalRunnerActive: false }))
            }
          }
        })
      } finally {
        lease.release()
      }
    },
    [
      currentAuthority,
      ensureLoopState,
      executeGoalLoop,
      loopStateRef,
      prepareGoalSession,
      setState,
      turnCoordinatorRef,
    ],
  )

  const drainPendingInteractions = useCallback(() => {
    const permissionResolvers = permissionResolversRef.current
    permissionResolversRef.current = []
    for (const resolve of permissionResolvers) resolve('no')

    const pendingAuthority = pendingAuthorityRef.current
    pendingAuthorityRef.current = null
    if (pendingAuthority) pendingAuthority.resolve(authorityApproval(pendingAuthority.preview, 'deny'))

    const pendingQuestion = pendingQuestionRef.current
    pendingQuestionRef.current = null
    setState((previous) => ({
      ...previous,
      permissionQueue: [],
      authorityRequest: null,
      pendingQuestion: null,
      bufferingReads: false,
    }))
    if (pendingQuestion) pendingQuestion.resolve(pendingQuestion.abortAnswer)
  }, [pendingAuthorityRef, pendingQuestionRef, permissionResolversRef, setState])

  const stopGoalRun = useCallback(
    async (state: LoopState, goal: GoalState): Promise<void> => {
      abortControllerRef.current?.abort()
      drainPendingInteractions()
      await goalCoordinatorRef.current.interrupt(goal.id)
      await appendGoalState(state)
      setState((previous) => ({ ...previous, goalStatus: { ...goal }, goalRunnerActive: false }))
    },
    [abortControllerRef, drainPendingInteractions, setState],
  )

  const pauseGoal = useCallback(async (): Promise<GoalState | null> => {
    const state = loopStateRef.current
    if (!state?.goal) return null
    if (state.goal.status !== 'active') return null
    const goal = pauseCoreGoal(state)
    await stopGoalRun(state, goal)
    return goal
  }, [loopStateRef, stopGoalRun])

  const resumeGoal = useCallback(async (): Promise<GoalState | null> => {
    const state = loopStateRef.current
    if (!state?.goal) return null
    const lease = turnCoordinatorRef.current.tryAcquire('goal', currentAuthority())
    if (!lease) return null
    let goal: GoalState
    try {
      goal = state.goal.status === 'active' ? state.goal : resumeCoreGoal(state)
    } catch {
      lease.release()
      return null
    }
    try {
      await appendGoalState(state)
      setState((previous) => ({ ...previous, goalStatus: { ...goal }, goalRunnerActive: true }))
      goalCoordinatorRef.current.wake(goal.id, async (signal) => {
        try {
          await executeGoalLoop(state, goal.id, signal, lease)
        } finally {
          lease.release()
          setState((previous) => ({
            ...previous,
            goalStatus: state.goal ? { ...state.goal } : null,
            goalRunnerActive: false,
          }))
        }
      })
      return goal
    } catch {
      lease.release()
      return null
    }
  }, [currentAuthority, executeGoalLoop, loopStateRef, setState, turnCoordinatorRef])

  const cancelGoal = useCallback(async (): Promise<GoalState | null> => {
    const state = loopStateRef.current
    if (!state?.goal) return null
    const goal = cancelCoreGoal(state)
    await stopGoalRun(state, goal)
    return goal
  }, [loopStateRef, stopGoalRun])

  const clearGoal = useCallback(async (): Promise<void> => {
    const state = loopStateRef.current
    if (!state) return
    const lease = turnCoordinatorRef.current.tryAcquire('clear', currentAuthority())
    if (!lease) return
    const goalId = state.goal?.id
    try {
      if (goalId) {
        abortControllerRef.current?.abort()
        drainPendingInteractions()
        await goalCoordinatorRef.current.interrupt(goalId)
      }
      clearCoreGoal(state)
      await appendGoalState(state)
      setState((previous) => ({ ...previous, goalStatus: null, goalRunnerActive: false }))
    } finally {
      lease.release()
    }
  }, [abortControllerRef, currentAuthority, drainPendingInteractions, loopStateRef, setState, turnCoordinatorRef])

  const steerGoal = useCallback(
    async (text: string): Promise<GoalState | null> => {
      const state = loopStateRef.current
      if (!state?.goal) return null
      const input = admitGoalInput(state, { goalId: state.goal.id, kind: 'user_steering', content: text })
      await appendGoalInput(state, input)
      await appendGoalState(state)
      setState((previous) => ({ ...previous, goalStatus: state.goal ? { ...state.goal } : null }))
      await resumeGoal()
      return state.goal
    },
    [loopStateRef, resumeGoal, setState],
  )

  const editGoal = useCallback(
    async (input: { objective?: string; maxTurns?: number }): Promise<GoalState | null> => {
      const state = loopStateRef.current
      if (!state?.goal) return null
      const lease = turnCoordinatorRef.current.tryAcquire('goal', currentAuthority())
      if (!lease) return null
      try {
        if (input.objective !== undefined) {
          const objective = input.objective.trim()
          if (objective) state.goal.objective = objective
        }
        if (input.maxTurns !== undefined && Number.isFinite(input.maxTurns) && input.maxTurns > 0) {
          state.goal.maxTurns = Math.floor(input.maxTurns)
        }
        state.goal.updatedAt = new Date().toISOString()
        state.systemPromptCache = null
        markExpectedCacheMiss(state, 'goal-change')
        await appendGoalState(state)
        setState((previous) => ({ ...previous, goalStatus: state.goal ? { ...state.goal } : null }))
        return state.goal
      } finally {
        lease.release()
      }
    },
    [currentAuthority, loopStateRef, setState, turnCoordinatorRef],
  )

  const verifyGoal = useCallback(async (): Promise<{ goal: GoalState; ok: boolean; summary: string } | null> => {
    const state = loopStateRef.current
    if (!state?.goal) return null
    const lease = turnCoordinatorRef.current.tryAcquire('goal', currentAuthority())
    if (!lease) return null
    const controller = new AbortController()
    abortControllerRef.current = controller
    setState((previous) => ({ ...previous, goalVerificationActive: true }))
    try {
      const goal = state.goal
      const verification = await runVerifierLadder({
        goal,
        state,
        options: {
          ...agentOptions,
          modelId: modelIdRef.current,
          thinking: thinkingRef.current,
          permissionMode: permissionModeRef.current,
          abortSignal: controller.signal,
        },
        callbacks: createGoalCallbacks(),
        model: modelRef.current,
      })
      for (const result of verification.results) {
        await appendGoalVerification(state, goal.id, result)
      }

      if (goal.status === 'active') {
        if (verification.ok) {
          resetVerificationFailures(goal)
          updateGoalStatus(goal, 'complete', verification.summary)
          clearPendingTransition(goal)
        } else {
          const repeatedFailureCount = recordVerificationFailure(goal, verification.results)
          clearPendingTransition(goal)
          if (!verification.retryable) {
            updateGoalStatus(goal, 'blocked', verification.summary)
          } else {
            const input = admitGoalInput(state, {
              goalId: goal.id,
              kind: 'verifier_failure',
              content: buildVerifierFailurePrompt(
                goal,
                verification.results,
                verification.summary,
                repeatedFailureCount,
              ),
            })
            await appendGoalInput(state, input)
            await goalCoordinatorRef.current.run(goal.id, (signal) => executeGoalLoop(state, goal.id, signal, lease))
          }
        }
      }

      await appendGoalState(state)
      setState((previous) => ({ ...previous, goalStatus: { ...goal } }))
      return { goal, ok: verification.ok, summary: verification.summary }
    } finally {
      setState((previous) => ({ ...previous, goalVerificationActive: false }))
      lease.release()
    }
  }, [
    abortControllerRef,
    agentOptions,
    createGoalCallbacks,
    currentAuthority,
    executeGoalLoop,
    loopStateRef,
    modelIdRef,
    modelRef,
    permissionModeRef,
    setState,
    thinkingRef,
    turnCoordinatorRef,
  ])

  const pauseActiveGoalOnAbort = useCallback(() => {
    if (loopStateRef.current?.goal?.status !== 'active') return
    try {
      pauseCoreGoal(loopStateRef.current)
      void goalCoordinatorRef.current.interrupt(loopStateRef.current.goal.id)
      setState((previous) => ({
        ...previous,
        goalStatus: loopStateRef.current?.goal ? { ...loopStateRef.current.goal } : null,
      }))
    } catch {
      // A non-active terminal goal does not need abort-time state changes.
    }
  }, [loopStateRef, setState])

  return {
    runGoal,
    pauseGoal,
    resumeGoal,
    cancelGoal,
    clearGoal,
    steerGoal,
    editGoal,
    verifyGoal,
    drainPendingInteractions,
    pauseActiveGoalOnAbort,
  }
}
