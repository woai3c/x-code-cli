// Tests for the "must read before edit/write" + "no external mod since read"
// gates in executeWriteTool. These mirror Claude Code's FileEditTool /
// FileWriteTool validateInput checks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import { processToolCalls } from '../src/agent/tool-execution.js'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '../src/types/index.js'

function makeCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolProgress: vi.fn(),
    onToolResult: vi.fn(),
    onAskPermission: vi.fn().mockResolvedValue('yes'),
    onAskUser: vi.fn().mockResolvedValue('answer'),
    onPlanApprovalRequest: vi.fn().mockResolvedValue(true),
    onPlanModeChange: vi.fn(),
    onTodosUpdate: vi.fn(),
    onShellOutput: vi.fn(),
    onUsageUpdate: vi.fn(),
    onContextCompressed: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

const options: AgentOptions = {
  modelId: 'test:model',
  trustMode: true, // Skip permission prompts so tests focus on the gate
  maxTurns: 10,
  printMode: false,
}

const stubModel = {} as LanguageModel

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-edit-gate-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('executeWriteTool read-first gate', () => {
  it('rejects edit when the file was never read', async () => {
    const filePath = path.join(tmpDir, 'a.ts')
    await fs.writeFile(filePath, 'const a = 1\n')

    const state = createLoopState()
    const captured: string[] = []
    const callbacks = makeCallbacks({
      onToolResult: (_id: string, output: string) => captured.push(output),
    })

    await processToolCalls(
      [
        {
          toolName: 'edit',
          toolCallId: 'tc1',
          input: { filePath, oldString: 'const a = 1', newString: 'const a = 2' },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )

    expect(captured[0]).toMatch(/has not been read/i)
    // File on disk must be unchanged.
    expect(await fs.readFile(filePath, 'utf-8')).toBe('const a = 1\n')
  })

  it('allows edit after a full read recorded the file', async () => {
    const filePath = path.join(tmpDir, 'b.ts')
    await fs.writeFile(filePath, 'const b = 1\n')

    const state = createLoopState()
    const stat = await fs.stat(filePath)
    state.readFiles.set(filePath, { timestamp: Math.floor(stat.mtimeMs), isPartialView: false })

    const captured: string[] = []
    const callbacks = makeCallbacks({
      onToolResult: (_id: string, output: string) => captured.push(output),
    })

    await processToolCalls(
      [
        {
          toolName: 'edit',
          toolCallId: 'tc1',
          input: { filePath, oldString: 'const b = 1', newString: 'const b = 2' },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )

    expect(captured[0]).toMatch(/File edited/)
    expect(await fs.readFile(filePath, 'utf-8')).toBe('const b = 2\n')
  })

  it('rejects edit when only a partial view (offset/limit) was read', async () => {
    const filePath = path.join(tmpDir, 'c.ts')
    await fs.writeFile(filePath, 'const c = 1\n')

    const state = createLoopState()
    const stat = await fs.stat(filePath)
    state.readFiles.set(filePath, { timestamp: Math.floor(stat.mtimeMs), isPartialView: true })

    const captured: string[] = []
    const callbacks = makeCallbacks({
      onToolResult: (_id: string, output: string) => captured.push(output),
    })

    await processToolCalls(
      [
        {
          toolName: 'edit',
          toolCallId: 'tc1',
          input: { filePath, oldString: 'const c = 1', newString: 'const c = 2' },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )

    expect(captured[0]).toMatch(/partial view/i)
    expect(await fs.readFile(filePath, 'utf-8')).toBe('const c = 1\n')
  })

  it('rejects edit when the file was modified externally after being read', async () => {
    const filePath = path.join(tmpDir, 'd.ts')
    await fs.writeFile(filePath, 'const d = 1\n')

    const state = createLoopState()
    // Record an OLD mtime — simulates the case where the model read the
    // file at t0 and the user (or some other process) wrote to it at t1
    // before the model's edit dispatched.
    state.readFiles.set(filePath, { timestamp: 1, isPartialView: false })

    const captured: string[] = []
    const callbacks = makeCallbacks({
      onToolResult: (_id: string, output: string) => captured.push(output),
    })

    await processToolCalls(
      [
        {
          toolName: 'edit',
          toolCallId: 'tc1',
          input: { filePath, oldString: 'const d = 1', newString: 'const d = 2' },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )

    expect(captured[0]).toMatch(/modified externally/i)
    expect(await fs.readFile(filePath, 'utf-8')).toBe('const d = 1\n')
  })

  it('allows writeFile to create a NEW file without a prior read', async () => {
    const filePath = path.join(tmpDir, 'new-file.ts')
    // File does not exist on disk.

    const state = createLoopState()
    const captured: string[] = []
    const callbacks = makeCallbacks({
      onToolResult: (_id: string, output: string) => captured.push(output),
    })

    await processToolCalls(
      [{ toolName: 'writeFile', toolCallId: 'tc1', input: { filePath, content: 'fresh content\n' } }],
      state,
      options,
      callbacks,
      stubModel,
    )

    expect(captured[0]).toMatch(/File created/)
    expect(await fs.readFile(filePath, 'utf-8')).toBe('fresh content\n')
  })

  it('rejects writeFile that would OVERWRITE an existing file without a prior read', async () => {
    const filePath = path.join(tmpDir, 'existing.ts')
    await fs.writeFile(filePath, 'old content\n')

    const state = createLoopState()
    const captured: string[] = []
    const callbacks = makeCallbacks({
      onToolResult: (_id: string, output: string) => captured.push(output),
    })

    await processToolCalls(
      [{ toolName: 'writeFile', toolCallId: 'tc1', input: { filePath, content: 'overwritten\n' } }],
      state,
      options,
      callbacks,
      stubModel,
    )

    expect(captured[0]).toMatch(/has not been read/i)
    // Existing content untouched.
    expect(await fs.readFile(filePath, 'utf-8')).toBe('old content\n')
  })

  // Regression for M4: edit/writeFile result string should include a
  // brief diff snippet so the model knows what actually changed without
  // needing to re-read the file. UI gets the full structured payload
  // separately via callbacks.onFileEdit.
  it('appends a diff snippet to the edit result for the model', async () => {
    const filePath = path.join(tmpDir, 'diff-snippet.ts')
    await fs.writeFile(filePath, 'line one\nline two\nline three\n')

    const state = createLoopState()
    const stat = await fs.stat(filePath)
    state.readFiles.set(filePath, { timestamp: Math.floor(stat.mtimeMs), isPartialView: false })

    const captured: string[] = []
    const callbacks = makeCallbacks({
      onToolResult: (_id: string, output: string) => captured.push(output),
    })

    await processToolCalls(
      [{ toolName: 'edit', toolCallId: 'tc1', input: { filePath, oldString: 'line two', newString: 'LINE TWO' } }],
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(captured[0]).toContain('File edited:')
    expect(captured[0]).toContain('Diff (+1 -1)')
    // The actual changed lines should appear in the diff snippet.
    expect(captured[0]).toContain('-line two')
    expect(captured[0]).toContain('+LINE TWO')
  })

  it('appends a content preview to the writeFile result when creating a new file', async () => {
    const filePath = path.join(tmpDir, 'preview.ts')
    const state = createLoopState()
    const captured: string[] = []
    const callbacks = makeCallbacks({
      onToolResult: (_id: string, output: string) => captured.push(output),
    })

    await processToolCalls(
      [{ toolName: 'writeFile', toolCallId: 'tc1', input: { filePath, content: 'a\nb\nc\n' } }],
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(captured[0]).toContain('File created:')
    expect(captured[0]).toContain('Created with 3 lines')
    expect(captured[0]).toContain('  a')
    expect(captured[0]).toContain('  b')
    expect(captured[0]).toContain('  c')
  })

  // Regression for M3: when oldString doesn't literally match but a
  // quote-normalized form does, the error tells the model the file uses
  // fancy punctuation. Saves a re-read round-trip.
  it('detects quote/dash mismatches and tells the model in the error', async () => {
    const filePath = path.join(tmpDir, 'fancy.ts')
    // File uses curly double quotes — model would naturally type ASCII.
    await fs.writeFile(filePath, 'const greeting = “hello”\n')

    const state = createLoopState()
    const stat = await fs.stat(filePath)
    state.readFiles.set(filePath, { timestamp: Math.floor(stat.mtimeMs), isPartialView: false })

    const captured: string[] = []
    const callbacks = makeCallbacks({
      onToolResult: (_id: string, output: string) => captured.push(output),
    })

    await processToolCalls(
      [
        {
          toolName: 'edit',
          toolCallId: 'tc1',
          input: { filePath, oldString: 'const greeting = "hello"', newString: 'const greeting = "hi"' },
        },
      ],
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(captured[0]).toMatch(/quote-normalized match exists|curly quotes/i)
  })

  it('refreshes the read timestamp after a successful edit so a follow-up edit succeeds', async () => {
    const filePath = path.join(tmpDir, 'chain.ts')
    await fs.writeFile(filePath, 'a\nb\nc\n')

    const state = createLoopState()
    const stat = await fs.stat(filePath)
    state.readFiles.set(filePath, { timestamp: Math.floor(stat.mtimeMs), isPartialView: false })

    const captured: string[] = []
    const callbacks = makeCallbacks({
      onToolResult: (_id: string, output: string) => captured.push(output),
    })

    await processToolCalls(
      [{ toolName: 'edit', toolCallId: 'tc1', input: { filePath, oldString: 'a', newString: 'A' } }],
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(captured[0]).toMatch(/File edited/)

    // Second edit should NOT trip the mtime gate even though the file's
    // mtime just changed — the post-edit refresh updated state.readFiles.
    await processToolCalls(
      [{ toolName: 'edit', toolCallId: 'tc2', input: { filePath, oldString: 'b', newString: 'B' } }],
      state,
      options,
      callbacks,
      stubModel,
    )
    expect(captured[1]).toMatch(/File edited/)
    expect(await fs.readFile(filePath, 'utf-8')).toBe('A\nB\nc\n')
  })
})
