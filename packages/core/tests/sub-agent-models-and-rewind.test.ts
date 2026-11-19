import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { LanguageModel, ModelMessage } from 'ai'

import { createLoopState } from '../src/agent/loop-state.js'
import { createCheckpoint, restoreCheckpoint } from '../src/agent/snapshot.js'
import { createBuiltInRegistry, createSubAgentRegistry } from '../src/agent/sub-agents/registry.js'
import { buildSubAgentToolFilter, resolveSubAgentRuntimeModel, runSubAgent } from '../src/agent/sub-agents/runner.js'
import { processToolCalls } from '../src/agent/tool-execution.js'
import { loadUserConfig, resolveSubAgentModelSelection, saveUserConfig } from '../src/config/index.js'
import { createTaskTool } from '../src/tools/task.js'
import type { AgentCallbacks, AgentOptions } from '../src/types/index.js'

function noopCallbacks(): AgentCallbacks {
  return {
    onTextDelta: () => {},
    onToolCall: () => {},
    onToolProgress: () => {},
    onToolResult: () => {},
    onFileEdit: () => {},
    onAskPermission: async () => 'yes',
    onAskUser: async () => '',
    onPlanApprovalRequest: async () => true,
    onPlanModeChange: () => {},
    onShellOutput: () => {},
    onUsageUpdate: () => {},
    onContextCompressed: () => {},
    onStreamRetry: () => {},
    onError: () => {},
  }
}

describe('built-in sub-agent set (explore, plan, worker)', () => {
  let homeDir: string
  let prevHome: string | undefined

  beforeEach(async () => {
    prevHome = process.env.X_CODE_HOME
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-subagents-home-'))
    process.env.X_CODE_HOME = homeDir
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = prevHome
    await fs.rm(homeDir, { recursive: true, force: true })
  })

  it('exposes strictly explore, plan, and worker by default while keeping goal-verifier internal', async () => {
    const builtIn = createBuiltInRegistry()
    expect(builtIn.names()).toEqual(['explore', 'plan', 'worker'])
    expect(builtIn.get('goal-verifier')?.internal).toBe(true)
    expect(builtIn.names({ includeInternal: true })).toEqual(['explore', 'plan', 'worker', 'goal-verifier'])

    const full = await createSubAgentRegistry({ includeBrowser: false })
    expect(full.names()).toEqual(['explore', 'plan', 'worker'])

    const taskTool = createTaskTool(builtIn)
    expect(taskTool.description).toContain('- explore:')
    expect(taskTool.description).toContain('- plan:')
    expect(taskTool.description).toContain('- worker:')
    expect(taskTool.description).not.toContain('goal-verifier')
    expect(taskTool.description).not.toContain('general-purpose')
    expect(taskTool.description).not.toContain('code-reviewer')
  })

  it('grants worker execution tools while denying dialog/root-only tools, and denies writes in plan mode', () => {
    const worker = createBuiltInRegistry().get('worker')!
    expect(buildSubAgentToolFilter(worker, 'default')).toEqual({
      allow: undefined,
      deny: ['askUser', 'exitPlanMode', 'task'],
    })
    expect(buildSubAgentToolFilter(worker, 'plan')).toEqual({
      allow: [
        'readFile',
        'glob',
        'grep',
        'listDir',
        'webSearch',
        'webFetch',
        'listMcpResources',
        'readMcpResource',
        'activateSkill',
      ],
      deny: ['askUser', 'exitPlanMode', 'task', 'writeFile', 'edit', 'shell', 'shellOutput', 'killShell'],
    })
  })

  it('blocks direct task invocation of internal goal-verifier unless allowInternal is set', async () => {
    const parentState = createLoopState()
    const parentModel = { id: 'parent' } as unknown as LanguageModel
    const parentOptions: AgentOptions = {
      modelId: 'openai:gpt-6.2-astra',
      trustMode: true,
      printMode: false,
      subAgentRegistry: createBuiltInRegistry(),
    }

    const denied = await runSubAgent(
      {
        parentState,
        parentOptions,
        callbacks: noopCallbacks(),
        toolCallId: 'tc-gv-denied',
        agentName: 'goal-verifier',
        description: 'verify',
        prompt: 'check',
        knowledgeContext: '',
        isGitRepo: false,
      },
      parentModel,
      async (_prompt, _m, _o, _c, s) => ({ state: s!, turnCount: 1 }),
    )
    expect(denied.resultText).toBe("[Sub-agent 'goal-verifier' not found. Available: explore, plan, worker]")

    const allowed = await runSubAgent(
      {
        parentState,
        parentOptions,
        callbacks: noopCallbacks(),
        toolCallId: 'tc-gv-allowed',
        agentName: 'goal-verifier',
        description: 'verify',
        prompt: 'check',
        knowledgeContext: '',
        isGitRepo: false,
        allowInternal: true,
      },
      parentModel,
      async (_prompt, _m, _o, _c, s) => {
        s!.messages.push({ role: 'assistant', content: '{"ok":true,"findings":[],"requiredFixes":[]}' } as ModelMessage)
        return { state: s!, turnCount: 1 }
      },
    )
    expect(allowed.resultText).toContain('"ok":true')
  })
})

describe('sub-agent model selection and fallback', () => {
  let homeDir: string
  let prevHome: string | undefined

  beforeEach(async () => {
    prevHome = process.env.X_CODE_HOME
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-submodel-home-'))
    process.env.X_CODE_HOME = homeDir
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = prevHome
    await fs.rm(homeDir, { recursive: true, force: true })
  })

  it('defaults all built-in sub-agents to inheriting the parent model', () => {
    const reg = createBuiltInRegistry()
    for (const agent of reg.list({ includeInternal: true })) {
      expect(resolveSubAgentModelSelection(agent, 'google:gemini-4-carbon')).toEqual({
        modelId: 'google:gemini-4-carbon',
        source: 'inherit',
      })
    }
  })

  it('applies per-agent override only to the targeted agent (e.g. worker) and leaves explore/plan on inherit', () => {
    saveUserConfig({ subAgentModels: { worker: 'sol' } })
    const config = loadUserConfig()
    expect(config.subAgentModels).toEqual({ worker: 'openai:gpt-6.2-sol' })

    const reg = createBuiltInRegistry()
    expect(resolveSubAgentModelSelection(reg.get('worker')!, 'openai:gpt-6.2-astra')).toEqual({
      modelId: 'openai:gpt-6.2-sol',
      configuredModelId: 'openai:gpt-6.2-sol',
      source: 'override',
    })
    expect(resolveSubAgentModelSelection(reg.get('explore')!, 'openai:gpt-6.2-astra')).toEqual({
      modelId: 'openai:gpt-6.2-astra',
      source: 'inherit',
    })
    expect(resolveSubAgentModelSelection(reg.get('plan')!, 'openai:gpt-6.2-astra')).toEqual({
      modelId: 'openai:gpt-6.2-astra',
      source: 'inherit',
    })
  })

  it('enforces precedence: per-agent override > frontmatter > global subAgentModel > inherit, and keeps internal goal-verifier on main model', () => {
    saveUserConfig({
      subAgentModel: 'luna',
      subAgentModels: { customA: 'sol' },
    })

    expect(
      resolveSubAgentModelSelection({ name: 'customA', model: 'anthropic:claude-haiku-5-5' }, 'openai:gpt-6.2-astra'),
    ).toMatchObject({
      modelId: 'openai:gpt-6.2-sol',
      source: 'override',
    })
    expect(resolveSubAgentModelSelection({ name: 'customB', model: 'haiku' }, 'openai:gpt-6.2-astra')).toMatchObject({
      modelId: 'anthropic:claude-haiku-5-5',
      source: 'frontmatter',
    })
    expect(
      resolveSubAgentModelSelection({ name: 'customInherit', model: 'inherit' }, 'openai:gpt-6.2-astra'),
    ).toMatchObject({
      modelId: 'openai:gpt-6-luna',
      source: 'default',
    })
    const goalVerifier = createBuiltInRegistry().get('goal-verifier')!
    expect(resolveSubAgentModelSelection(goalVerifier, 'openai:gpt-6.2-astra')).toEqual({
      modelId: 'openai:gpt-6.2-astra',
      source: 'inherit',
    })

    // Object.prototype / reserved keys never masquerade as per-agent overrides
    expect(resolveSubAgentModelSelection({ name: 'toString' }, 'openai:gpt-6.2-astra')).toEqual({
      modelId: 'openai:gpt-6-luna',
      source: 'default',
      configuredModelId: 'openai:gpt-6-luna',
    })
    expect(resolveSubAgentModelSelection({ name: 'constructor' }, 'openai:gpt-6.2-astra')).toEqual({
      modelId: 'openai:gpt-6-luna',
      source: 'default',
      configuredModelId: 'openai:gpt-6-luna',
    })
  })

  it('falls back both model instance and modelId together when provider lookup fails', () => {
    saveUserConfig({ subAgentModels: { worker: 'anthropic:claude-sonnet-5-5' } })
    const worker = createBuiltInRegistry().get('worker')!
    const parentModel = { id: 'parent' } as unknown as LanguageModel
    const resolved = resolveSubAgentRuntimeModel(
      worker,
      {
        modelId: 'openai:gpt-6.2-astra',
        trustMode: true,
        printMode: false,
        modelRegistry: {
          languageModel: () => {
            throw new Error('No such provider: anthropic')
          },
        } as unknown as AgentOptions['modelRegistry'],
      },
      parentModel,
    )
    expect(resolved).toEqual({
      model: parentModel,
      modelId: 'openai:gpt-6.2-astra',
    })
  })
})

describe('worker sub-agent file mutations integrate with /rewind', () => {
  let tempDir: string
  let homeDir: string
  let prevHome: string | undefined

  beforeEach(async () => {
    prevHome = process.env.X_CODE_HOME
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-worker-home-'))
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-worker-proj-'))
    process.env.X_CODE_HOME = homeDir
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = prevHome
    await fs.rm(homeDir, { recursive: true, force: true })
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('rolls back files edited and created by worker when restoring a root checkpoint', async () => {
    const existingPath = path.join(tempDir, 'existing.ts')
    const createdPath = path.join(tempDir, 'created-by-worker.ts')
    await fs.writeFile(existingPath, 'export const value = 1\n', 'utf-8')

    const parentState = createLoopState('default', { projectCwd: tempDir })
    parentState.messages.push({ role: 'user', content: 'implement changes' } as ModelMessage)
    const ckpt = await createCheckpoint(parentState, 'implement changes', tempDir)
    expect(ckpt).not.toBeNull()

    const parentModel = { id: 'parent' } as unknown as LanguageModel
    const parentOptions: AgentOptions = {
      modelId: 'openai:gpt-6.2-astra',
      trustMode: true,
      printMode: false,
      subAgentRegistry: createBuiltInRegistry(),
    }

    const result = await runSubAgent(
      {
        parentState,
        parentOptions,
        callbacks: noopCallbacks(),
        toolCallId: 'tc-worker-1',
        agentName: 'worker',
        description: 'update files',
        prompt: 'Edit existing.ts and create created-by-worker.ts',
        knowledgeContext: '',
        isGitRepo: false,
      },
      parentModel,
      async (_prompt, subModel, subOptions, subCallbacks, existingSubState) => {
        const child = existingSubState!
        const calls = [
          {
            toolCallId: 'sub-edit-1',
            toolName: 'edit',
            input: {
              filePath: existingPath,
              oldString: 'value = 1',
              newString: 'value = 2',
            },
          },
          {
            toolCallId: 'sub-write-1',
            toolName: 'writeFile',
            input: {
              filePath: createdPath,
              content: 'export const extra = true\n',
            },
          },
        ]
        child.messages.push(
          { role: 'user', content: 'go' } as ModelMessage,
          {
            role: 'assistant',
            content: calls.map((c) => ({ type: 'tool-call', ...c })),
          } as ModelMessage,
        )
        await processToolCalls(calls, child, subOptions, subCallbacks, subModel)
        child.messages.push({ role: 'assistant', content: 'Updated both files.' } as ModelMessage)
        return { state: child, turnCount: 2 }
      },
    )

    expect(result.resultText).toContain('Updated both files.')
    expect(await fs.readFile(existingPath, 'utf-8')).toBe('export const value = 2\n')
    expect(existsSync(createdPath)).toBe(true)
    expect(parentState.filesModified.has(existingPath)).toBe(true)
    expect(parentState.filesModified.has(createdPath)).toBe(true)

    const restored = await restoreCheckpoint(parentState, ckpt!.ckptId, tempDir)
    expect(restored).toBe(true)
    expect(await fs.readFile(existingPath, 'utf-8')).toBe('export const value = 1\n')
    expect(existsSync(createdPath)).toBe(false)
  })

  it('serializes origin capture safely across concurrent worker sub-agents', async () => {
    const fileA = path.join(tempDir, 'a.ts')
    const fileB = path.join(tempDir, 'b.ts')
    await fs.writeFile(fileA, 'a-before\n', 'utf-8')
    await fs.writeFile(fileB, 'b-before\n', 'utf-8')

    const parentState = createLoopState('default', { projectCwd: tempDir })
    parentState.messages.push({ role: 'user', content: 'parallel workers' } as ModelMessage)
    const ckpt = await createCheckpoint(parentState, 'parallel workers', tempDir)
    expect(ckpt).not.toBeNull()

    const parentModel = { id: 'parent' } as unknown as LanguageModel
    const parentOptions: AgentOptions = {
      modelId: 'openai:gpt-6.2-astra',
      trustMode: true,
      printMode: false,
      subAgentRegistry: createBuiltInRegistry(),
    }

    const spawnWorkerWrite = (id: string, targetFile: string, nextContent: string) =>
      runSubAgent(
        {
          parentState,
          parentOptions,
          callbacks: noopCallbacks(),
          toolCallId: id,
          agentName: 'worker',
          description: `write ${path.basename(targetFile)}`,
          prompt: 'write',
          knowledgeContext: '',
          isGitRepo: false,
        },
        parentModel,
        async (_prompt, subModel, subOptions, subCallbacks, existingSubState) => {
          const child = existingSubState!
          const call = {
            toolCallId: `${id}-write`,
            toolName: 'writeFile',
            input: { filePath: targetFile, content: nextContent },
          }
          child.messages.push(
            { role: 'user', content: 'go' } as ModelMessage,
            { role: 'assistant', content: [{ type: 'tool-call', ...call }] } as ModelMessage,
          )
          await processToolCalls([call], child, subOptions, subCallbacks, subModel)
          child.messages.push({ role: 'assistant', content: 'done' } as ModelMessage)
          return { state: child, turnCount: 1 }
        },
      )

    await Promise.all([spawnWorkerWrite('w1', fileA, 'a-after\n'), spawnWorkerWrite('w2', fileB, 'b-after\n')])

    expect(await fs.readFile(fileA, 'utf-8')).toBe('a-after\n')
    expect(await fs.readFile(fileB, 'utf-8')).toBe('b-after\n')

    const restored = await restoreCheckpoint(parentState, ckpt!.ckptId, tempDir)
    expect(restored).toBe(true)
    expect(await fs.readFile(fileA, 'utf-8')).toBe('a-before\n')
    expect(await fs.readFile(fileB, 'utf-8')).toBe('b-before\n')
  })

  it('inherits acceptEdits permission mode and invalidates parent readFileCache when worker edits a file', async () => {
    const targetPath = path.join(tempDir, 'cached.ts')
    await fs.writeFile(targetPath, 'const x = 1\n', 'utf-8')

    const parentState = createLoopState('acceptEdits', { projectCwd: tempDir })
    parentState.readFileCache.set(targetPath, { mtimeMs: 1, size: 12 })

    let permissionAsked = false
    const callbacks: AgentCallbacks = {
      ...noopCallbacks(),
      onAskPermission: async () => {
        permissionAsked = true
        return 'no'
      },
    }

    const parentModel = { id: 'parent' } as unknown as LanguageModel
    const parentOptions: AgentOptions = {
      modelId: 'openai:gpt-6.2-astra',
      trustMode: false,
      printMode: false,
      subAgentRegistry: createBuiltInRegistry(),
    }

    await runSubAgent(
      {
        parentState,
        parentOptions,
        callbacks,
        toolCallId: 'tc-accept-edits',
        agentName: 'worker',
        description: 'edit cached.ts',
        prompt: 'edit cached.ts',
        knowledgeContext: '',
        isGitRepo: false,
      },
      parentModel,
      async (_prompt, subModel, subOptions, subCallbacks, existingSubState) => {
        const child = existingSubState!
        expect(child.permissionMode).toBe('acceptEdits')
        expect(subOptions.permissionMode).toBe('acceptEdits')
        const call = {
          toolCallId: 'sub-edit-cached',
          toolName: 'edit',
          input: { filePath: targetPath, oldString: 'x = 1', newString: 'x = 2' },
        }
        child.messages.push(
          { role: 'user', content: 'go' } as ModelMessage,
          { role: 'assistant', content: [{ type: 'tool-call', ...call }] } as ModelMessage,
        )
        await processToolCalls([call], child, subOptions, subCallbacks, subModel)
        child.messages.push({ role: 'assistant', content: 'done' } as ModelMessage)
        return { state: child, turnCount: 1 }
      },
    )

    expect(permissionAsked).toBe(false)
    expect(await fs.readFile(targetPath, 'utf-8')).toBe('const x = 2\n')
    expect(parentState.readFileCache.has(targetPath)).toBe(false)
  })

  it('grants one tool-free synthesis turn when a sub-agent hits maxTurns on a tool round', async () => {
    const parentState = createLoopState()
    const parentModel = { provider: 'openai', modelId: 'gpt-6.2-sol' } as unknown as LanguageModel
    const parentOptions: AgentOptions = {
      modelId: 'openai:gpt-6.2-sol',
      trustMode: false,
      printMode: false,
      subAgentRegistry: createBuiltInRegistry(),
    }

    const calls: Array<{ maxTurns?: number; allow?: readonly string[] }> = []
    const result = await runSubAgent(
      {
        parentState,
        parentOptions,
        callbacks: noopCallbacks(),
        toolCallId: 'tc-max-turns-salvage',
        agentName: 'explore',
        description: 'broad explore',
        prompt: 'find everything',
        knowledgeContext: '',
        isGitRepo: false,
      },
      parentModel,
      async (_prompt, _subModel, subOptions, _subCallbacks, existingSubState) => {
        const child = existingSubState!
        calls.push({ maxTurns: subOptions.maxTurns, allow: subOptions.toolFilter?.allow })
        if (calls.length === 1) {
          child.messages.push(
            { role: 'user', content: 'find everything' } as ModelMessage,
            {
              role: 'assistant',
              content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'grep', input: { pattern: 'x' } }],
            } as ModelMessage,
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: 'tc-1',
                  toolName: 'grep',
                  output: { type: 'text', value: 'found x' },
                },
              ],
            } as ModelMessage,
          )
          return { state: child, turnCount: 25 }
        }
        child.messages.push({ role: 'assistant', content: 'Synthesized findings: found x' } as ModelMessage)
        return { state: child, turnCount: 1 }
      },
    )

    expect(calls).toEqual([
      { maxTurns: 25, allow: ['readFile', 'glob', 'grep', 'listDir', 'shell'] },
      { maxTurns: 1, allow: [] },
    ])
    expect(result.resultText).toContain('Synthesized findings: found x')
    expect(result.turnCount).toBe(26)
  })

  it('does not mistake an early tool-call preamble for a completed answer when the synthesis turn fails', async () => {
    const parentState = createLoopState()
    const parentModel = { provider: 'openai', modelId: 'gpt-6.2-sol' } as unknown as LanguageModel
    const parentOptions: AgentOptions = {
      modelId: 'openai:gpt-6.2-sol',
      trustMode: false,
      printMode: false,
      subAgentRegistry: createBuiltInRegistry(),
    }

    let invocation = 0
    const result = await runSubAgent(
      {
        parentState,
        parentOptions,
        callbacks: noopCallbacks(),
        toolCallId: 'tc-max-turns-failed-synthesis',
        agentName: 'explore',
        description: 'broad explore',
        prompt: 'find everything',
        knowledgeContext: '',
        isGitRepo: false,
      },
      parentModel,
      async (_prompt, _subModel, _subOptions, _subCallbacks, existingSubState) => {
        const child = existingSubState!
        invocation++
        if (invocation === 1) {
          child.messages.push(
            { role: 'user', content: 'find everything' } as ModelMessage,
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Let me inspect src/ first.' },
                { type: 'tool-call', toolCallId: 'tc-1', toolName: 'grep', input: { pattern: 'x' } },
              ],
            } as ModelMessage,
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: 'tc-1',
                  toolName: 'grep',
                  output: { type: 'text', value: 'found x' },
                },
              ],
            } as ModelMessage,
          )
          return { state: child, turnCount: 25 }
        }
        // Simulate failed synthesis turn (user nudge appended, no assistant reply).
        child.messages.push({ role: 'user', content: 'Turn limit reached.' } as ModelMessage)
        return { state: child, turnCount: 1 }
      },
    )

    expect(result.resultText).toContain('[Sub-agent reached max turns (25) without finishing.')
    expect(result.resultText).not.toContain('<task_result>')
  })
})
