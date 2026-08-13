// Tests for the per-session JSONL transcript store.
//
// The module is the source of truth for resume — both the CLI startup
// flags (`-c`, `-r`) and the in-app `/resume` command load via
// `loadSession`, and every assistant turn appends through
// `flushPendingMessages` / `appendUsage`. The invariants we care most
// about:
//
//   1. Round-trip:    write a header + N messages + usage, load it back;
//                     messages and tokenUsage match exactly.
//   2. Boundary:      every `compact-boundary` clears the in-load
//                     accumulator so the loaded view reflects only
//                     post-last-boundary content.
//   3. Sanitisation:  trailing assistant tool_calls without paired
//                     tool_results are trimmed; the next API request
//                     can't observe an orphan.
//   4. CJK fallback:  empty taskSlug falls back to timestamp-only
//                     filenames (mirrors plan files).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mkdtempSync, rmSync } from 'node:fs'
import fs, { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendProviderTurnUsage, createProviderTurnUsage } from '../src/agent/cache-stats.js'
import { admitGoalInput, promoteNextGoalInput } from '../src/agent/goal/input.js'
import { createGoal } from '../src/agent/goal/state.js'
import { createLoopState } from '../src/agent/loop-state.js'
import { saveSession } from '../src/agent/loop.js'
import {
  appendGoalInput,
  appendGoalState,
  appendHeader,
  appendMemoryRecall,
  appendUsage,
  flushPendingMessages,
  getSessionFilePath,
  hydrateLoopState,
  listSessions,
  loadSession,
  markBoundaryAndReflush,
  pickLatestSession,
} from '../src/agent/session-store.js'
import { accumulateUsage, normalizeLanguageModelUsage } from '../src/agent/usage.js'

let tempDir: string
let originalCwd: string

beforeEach(() => {
  // Each test gets a clean tmp cwd so jsonl writes don't pollute the
  // dev's actual repo (`.x-code/sessions/` is at process.cwd()).
  tempDir = mkdtempSync(join(tmpdir(), 'xc-session-store-'))
  originalCwd = process.cwd()
  process.chdir(tempDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(tempDir, { recursive: true, force: true })
})

describe('session-store: filename derivation', () => {
  it('uses only the timestamp-shaped session id for new sessions', () => {
    const state = { sessionId: '20260101-120000-000', taskSlug: 'fix-login' }
    const p = getSessionFilePath(state, tempDir)
    expect(p.endsWith('20260101-120000-000.jsonl')).toBe(true)
  })

  it('preserves a pinned legacy slug-prefixed path', () => {
    const legacyPath = join(tempDir, '.x-code', 'sessions', 'fix-login-20260101-120000-000.jsonl')
    const state = {
      sessionId: '20260101-120000-000',
      sessionFilePath: legacyPath,
    }
    expect(getSessionFilePath(state, tempDir)).toBe(legacyPath)
  })
})

describe('session-store: round-trip', () => {
  it('persists and reloads a simple conversation', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'fix-login'
    state.messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]

    await appendHeader(state, 'anthropic:claude-sonnet-5', 'Hello')
    await flushPendingMessages(state)
    state.tokenUsage.inputTokens = 100
    state.tokenUsage.outputTokens = 20
    state.tokenUsage.totalTokens = 120
    await appendUsage(state, 'anthropic:claude-sonnet-5')

    const filePath = getSessionFilePath(state)
    const loaded = await loadSession(filePath)
    expect(loaded).not.toBeNull()
    expect(loaded!.sessionId).toBe('20260101-120000-000')
    expect(loaded!.taskSlug).toBe('fix-login')
    expect(loaded!.firstPrompt).toBe('Hello')
    expect(loaded!.messages).toHaveLength(2)
    expect(loaded!.messages[0]).toEqual({ role: 'user', content: 'Hello' })
    expect(loaded!.messages[1]).toEqual({ role: 'assistant', content: 'Hi there' })
    expect(loaded!.tokenUsage.inputTokens).toBe(100)
    expect(loaded!.tokenUsage.totalTokens).toBe(120)
  })

  it('restores source/model attribution and main-turn cache diagnostics', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-001'
    await appendHeader(state, 'openai:test', 'cache test')

    for (const [index, cacheReadTokens] of [4_000, 0].entries()) {
      const raw = {
        inputTokens: 5_000 + index * 1_000,
        outputTokens: 100,
        inputTokenDetails: { cacheReadTokens, cacheWriteTokens: 0 },
      }
      const normalized = normalizeLanguageModelUsage(raw as any)
      accumulateUsage(state, { source: 'main', modelId: 'openai:test', usage: normalized })
      const turn = createProviderTurnUsage({
        modelId: 'openai:test',
        usage: raw,
        normalized,
        expectedMissReasons: index === 1 ? ['compaction'] : [],
        timestamp: `2026-08-07T00:0${index}:00.000Z`,
      })
      appendProviderTurnUsage(state, turn)
      await appendUsage(state, 'openai:test', turn)
    }

    const loaded = await loadSession(getSessionFilePath(state))
    expect(loaded?.providerTurns).toHaveLength(2)
    expect(loaded?.usageBreakdown?.bySource.main.inputTokens).toBe(11_000)
    expect(loaded?.usageBreakdown?.byModel['openai:test']?.outputTokens).toBe(200)
    expect(loaded?.cacheMissSummary).toMatchObject({ expectedTokens: 5_000, expectedCount: 1 })

    const hydrated = hydrateLoopState(loaded!)
    expect(hydrated.providerTurns).toHaveLength(2)
    expect(hydrated.usageBreakdown.byModel['openai:test']?.inputTokens).toBe(11_000)
  })

  it('uses the latest persisted usage model after an in-session model switch', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-002'
    await appendHeader(state, 'openai:initial', 'switch models')

    state.tokenUsage.inputTokens = 100
    state.tokenUsage.totalTokens = 100
    await appendUsage(state, 'anthropic:switched')

    const filePath = getSessionFilePath(state)
    const loaded = await loadSession(filePath)
    const listed = await listSessions()

    expect(loaded?.modelId).toBe('anthropic:switched')
    expect(listed.find((session) => session.filePath === filePath)?.modelId).toBe('anthropic:switched')
  })

  it('persistedMessageCount stays in sync after multiple flushes', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'multi-flush'

    state.messages.push({ role: 'user', content: 'msg 1' })
    await appendHeader(state, 'anthropic:claude-sonnet-5', 'msg 1')
    await flushPendingMessages(state)
    expect(state.persistedMessageCount).toBe(1)

    state.messages.push({ role: 'assistant', content: 'reply 1' })
    state.messages.push({ role: 'user', content: 'msg 2' })
    await flushPendingMessages(state)
    expect(state.persistedMessageCount).toBe(3)

    // Idempotent — re-flush with no new messages is a no-op.
    await flushPendingMessages(state)
    expect(state.persistedMessageCount).toBe(3)

    const loaded = await loadSession(getSessionFilePath(state))
    expect(loaded!.messages).toHaveLength(3)
  })

  it('keeps visual-check images in memory but omits their base64 from the session file and resume', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-visual'
    const screenshotData = 'PRIVATE_SCREENSHOT_BASE64'
    state.messages = [
      { role: 'user', content: 'check the UI' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc-visual',
            toolName: 'browserVisualCheck',
            input: { url: 'http://localhost:5173/' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-visual',
            toolName: 'browserVisualCheck',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'Visual check captured' },
                { type: 'image-data', data: screenshotData, mediaType: 'image/jpeg' },
              ],
            },
          },
        ],
      },
    ] as any

    await appendHeader(state, 'openai:test', 'check the UI')
    await flushPendingMessages(state)

    const raw = await readFile(getSessionFilePath(state), 'utf8')
    expect(raw).not.toContain(screenshotData)
    expect(raw).toContain('screenshot omitted from session storage')
    expect(JSON.stringify(state.messages)).toContain(screenshotData)

    const loaded = await loadSession(getSessionFilePath(state))
    expect(JSON.stringify(loaded?.messages)).not.toContain(screenshotData)
    expect(JSON.stringify(loaded?.messages)).toContain('screenshot omitted from session storage')
  })
})

describe('session-store: compact boundary', () => {
  it('drops everything before a boundary on load', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'compaction'

    // Pre-compaction: 4 messages get persisted normally.
    state.messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]
    await appendHeader(state, 'anthropic:claude-sonnet-5', 'q1')
    await flushPendingMessages(state)
    expect(state.persistedMessageCount).toBe(4)

    // Compaction shrinks the in-memory array. markBoundaryAndReflush
    // writes a boundary line + the trimmed messages, and resets the
    // counter to the new length so subsequent flushes diff against
    // post-boundary state.
    state.messages = [
      { role: 'user', content: '[Previous summary]\nDiscussed q1 and q2' },
      { role: 'assistant', content: 'a2' },
    ]
    await markBoundaryAndReflush(state, 'Discussed q1 and q2')
    expect(state.persistedMessageCount).toBe(2)

    const loaded = await loadSession(getSessionFilePath(state))
    expect(loaded!.messages).toHaveLength(2)
    expect(loaded!.messages[0]).toMatchObject({ role: 'user' })
    expect(loaded!.messages[0].content).toContain('[Previous summary]')
  })

  it('omits visual-check image bytes when compaction reflushes retained messages', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-visual-boundary'
    const screenshotData = 'BOUNDARY_SCREENSHOT_BASE64'
    state.messages = [
      { role: 'user', content: 'check again' },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-visual-boundary',
            toolName: 'browserVisualCheck',
            output: {
              type: 'content',
              value: [{ type: 'image-data', data: screenshotData, mediaType: 'image/jpeg' }],
            },
          },
        ],
      },
    ] as any

    await appendHeader(state, 'openai:test', 'check again')
    await markBoundaryAndReflush(state)

    const raw = await readFile(getSessionFilePath(state), 'utf8')
    expect(raw).not.toContain(screenshotData)
    expect(raw).toContain('screenshot omitted from session storage')
  })

  it('only the LAST boundary determines what is loaded (multiple boundaries)', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'multi-boundary'

    state.messages = [{ role: 'user', content: 'q1' }]
    await appendHeader(state, 'anthropic:claude-sonnet-5', 'q1')
    await flushPendingMessages(state)

    // First boundary
    state.messages = [{ role: 'user', content: 'after-first-boundary' }]
    await markBoundaryAndReflush(state, 'first summary')

    // Add more, then a second boundary
    state.messages.push({ role: 'assistant', content: 'mid' })
    await flushPendingMessages(state)

    state.messages = [{ role: 'user', content: 'after-second-boundary' }]
    await markBoundaryAndReflush(state, 'second summary')

    const loaded = await loadSession(getSessionFilePath(state))
    expect(loaded!.messages).toHaveLength(1)
    expect(loaded!.messages[0]).toEqual({ role: 'user', content: 'after-second-boundary' })
  })
})

describe('session-store: orphan tool-call sanitisation', () => {
  it('trims trailing assistant tool_calls without paired tool_results', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'orphan-tail'

    // Resolved tool-call (followed by a matching tool result) — must be kept.
    // Then an orphan tool_call at the very end — must be trimmed.
    state.messages = [
      { role: 'user', content: 'work on something' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc-resolved', toolName: 'shell', input: { command: 'ls' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'tc-resolved', toolName: 'shell', output: { type: 'text', value: 'ok' } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc-orphan', toolName: 'shell', input: { command: 'failed' } }],
      },
    ] as never[]
    await appendHeader(state, 'anthropic:claude-sonnet-5', 'work on something')
    await flushPendingMessages(state)

    const loaded = await loadSession(getSessionFilePath(state))
    // The orphan tool_call assistant message at index 3 is dropped.
    expect(loaded!.messages).toHaveLength(3)
    expect(loaded!.transcriptRequiresSnapshot).toBe(true)
    const lastAssistant = loaded!.messages[1]
    expect(lastAssistant.role).toBe('assistant')

    const resumed = hydrateLoopState(loaded!)
    resumed.messages.push({ role: 'assistant', content: 'recovered' })
    await flushPendingMessages(resumed)
    const reloaded = await loadSession(getSessionFilePath(resumed))
    expect(reloaded?.transcriptIntegrity).toBe('clean')
    expect(reloaded?.messages).toHaveLength(4)
    expect(reloaded?.messages.at(-1)).toEqual({ role: 'assistant', content: 'recovered' })
  })

  it('keeps fully-resolved assistant tool_calls intact', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'clean-tail'

    state.messages = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'shell', input: { command: 'ls' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'tc-1', toolName: 'shell', output: { type: 'text', value: 'ok' } },
        ],
      },
    ] as never[]
    await appendHeader(state, 'anthropic:claude-sonnet-5', 'do it')
    await flushPendingMessages(state)

    const loaded = await loadSession(getSessionFilePath(state))
    expect(loaded!.messages).toHaveLength(3)
  })
})

describe('session-store: serialized binary part repair', () => {
  // Older builds put raw Buffer instances into attachment parts;
  // JSON.stringify turned them into {"type":"Buffer","data":[...]} (or the
  // numeric-keys Uint8Array form), which fails the SDK's ModelMessage schema
  // on resume. loadSession must restore them to base64 strings.
  it('restores image/file parts persisted as JSON-serialized Buffers', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'buffer-image'
    state.messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', image: { type: 'Buffer', data: [137, 80, 78, 71] }, mediaType: 'image/png' },
          { type: 'file', data: { type: 'Buffer', data: [37, 80, 68, 70] }, mediaType: 'application/pdf' },
        ],
      },
    ] as never[]
    await appendHeader(state, 'anthropic:claude-sonnet-5', 'look')
    await flushPendingMessages(state)

    const loaded = await loadSession(getSessionFilePath(state))
    const content = loaded!.messages[0].content as Array<Record<string, unknown>>
    expect(content[1].image).toBe(Buffer.from([137, 80, 78, 71]).toString('base64'))
    expect(content[2].data).toBe(Buffer.from([37, 80, 68, 70]).toString('base64'))
    expect(loaded!.transcriptRequiresSnapshot).toBe(true)

    const resumed = hydrateLoopState(loaded!)
    resumed.messages.push({ role: 'assistant', content: 'attachment processed' })
    await flushPendingMessages(resumed)
    const reloaded = await loadSession(getSessionFilePath(resumed))
    expect(reloaded?.transcriptIntegrity).toBe('clean')
    expect(reloaded?.messages).toHaveLength(2)
    expect(reloaded?.transcriptRequiresSnapshot).toBe(false)
  })

  it('restores the numeric-keys Uint8Array form and tool-result media entries', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'uint8-image'
    state.messages = [
      {
        role: 'user',
        content: [{ type: 'image', image: { 0: 137, 1: 80, 2: 78 }, mediaType: 'image/png' }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'browser',
            output: {
              type: 'content',
              value: [{ type: 'media', data: { type: 'Buffer', data: [255, 216, 255] }, mediaType: 'image/jpeg' }],
            },
          },
        ],
      },
    ] as never[]
    await appendHeader(state, 'anthropic:claude-sonnet-5', 'img')
    await flushPendingMessages(state)

    const loaded = await loadSession(getSessionFilePath(state))
    const userContent = loaded!.messages[0].content as Array<Record<string, unknown>>
    expect(userContent[0].image).toBe(Buffer.from([137, 80, 78]).toString('base64'))
    const toolContent = loaded!.messages[1].content as Array<{
      output: { value: Array<{ data: unknown }> }
    }>
    expect(toolContent[0].output.value[0].data).toBe(Buffer.from([255, 216, 255]).toString('base64'))
  })
})

describe('session-store: concurrent appends', () => {
  it('serializes fire-and-forget writes so lines never interleave', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'race'
    await appendHeader(state, 'anthropic:claude-sonnet-5', 'race')

    // A large message widens the window in which concurrent appendFile calls
    // would interleave without the per-file write queue.
    state.messages = [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }]
    await Promise.all([flushPendingMessages(state), appendUsage(state, 'm'), appendUsage(state, 'm')])

    const raw = await readFile(getSessionFilePath(state), 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim())
    // Header + the four-line committed snapshot epoch + two usage entries;
    // every line must remain a complete JSON document under concurrent writes.
    expect(lines).toHaveLength(7)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('serializes concurrent delta state derivation so epochs remain parent-linear', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-concurrent-deltas'
    state.messages = [{ role: 'user', content: 'root' }]
    await appendHeader(state, 'test:model', 'root')
    await flushPendingMessages(state)

    state.messages.push({ role: 'assistant', content: 'first delta' })
    let signalWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => (signalWriteStarted = resolve))
    let releaseWrite!: () => void
    const writeGate = new Promise<void>((resolve) => (releaseWrite = resolve))
    const realOpen = fs.open.bind(fs)
    let blockNextAppend = true
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args)
      if (args[1] !== 'a' || !blockNextAppend) return handle
      blockNextAppend = false
      const writeFile = handle.writeFile.bind(handle)
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'writeFile') {
            return async (...writeArgs: Parameters<typeof handle.writeFile>) => {
              signalWriteStarted()
              await writeGate
              return writeFile(...writeArgs)
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    })
    try {
      const first = flushPendingMessages(state)
      await writeStarted
      state.messages.push({ role: 'user', content: 'second delta' })
      const second = flushPendingMessages(state)
      releaseWrite()
      await Promise.all([first, second])
    } finally {
      releaseWrite()
      openSpy.mockRestore()
    }

    const loaded = await loadSession(getSessionFilePath(state))
    expect(loaded?.transcriptIntegrity).toBe('clean')
    expect(loaded?.transcriptRequiresSnapshot).toBe(false)
    expect(loaded?.messages).toEqual([
      { role: 'user', content: 'root' },
      { role: 'assistant', content: 'first delta' },
      { role: 'user', content: 'second delta' },
    ])

    const raw = await readFile(getSessionFilePath(state), 'utf8')
    const starts = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind?: string; epochId?: string; parentEpochId?: string })
      .filter((entry) => entry.kind === 'transcript-epoch-start')
    expect(starts).toHaveLength(3)
    expect(starts[1]?.parentEpochId).toBe(starts[0]?.epochId)
    expect(starts[2]?.parentEpochId).toBe(starts[1]?.epochId)
  })

  it('atomically replaces a partially written failed delta before retrying', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-partial-delta'
    state.messages = [{ role: 'user', content: 'durable' }]
    await appendHeader(state, 'test:model', 'durable')
    await flushPendingMessages(state)

    state.messages.push({ role: 'assistant', content: 'retry me' })
    const filePath = getSessionFilePath(state)
    const fakeHandle = {
      async writeFile(data: string | Uint8Array) {
        const payload = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
        await fs.appendFile(filePath, payload.slice(0, payload.indexOf('\n') + 1) + '{', 'utf8')
        throw new Error('simulated partial write')
      },
      async sync() {},
      async close() {},
    }
    const openSpy = vi.spyOn(fs, 'open').mockResolvedValueOnce(fakeHandle as never)
    try {
      await expect(flushPendingMessages(state)).rejects.toThrow('Failed to commit transcript delta')
    } finally {
      openSpy.mockRestore()
    }

    expect(state.transcriptRequiresSnapshot).toBe(true)
    expect(state.persistedMessageCount).toBe(1)
    expect(state.pendingFlush).toBeNull()

    await flushPendingMessages(state)
    const raw = await readFile(filePath, 'utf8')
    for (const line of raw.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow()
    const loaded = await loadSession(filePath)
    expect(loaded?.transcriptIntegrity).toBe('clean')
    expect(loaded?.messages).toEqual([
      { role: 'user', content: 'durable' },
      { role: 'assistant', content: 'retry me' },
    ])
  })

  it('forces a root snapshot after rename succeeds but directory fsync fails', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-snapshot-dir-fsync'
    state.messages = [{ role: 'user', content: 'durable root' }]
    await appendHeader(state, 'test:model', 'durable root')
    await flushPendingMessages(state)
    const oldEpochId = state.committedTranscriptEpochId

    state.messages.push({ role: 'assistant', content: 'snapshot reached rename' })
    state.transcriptRequiresSnapshot = true
    const filePath = getSessionFilePath(state)
    const sessionDirectory = join(filePath, '..')
    const realOpen = fs.open.bind(fs)
    let failDirectorySync = true
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args)
      if (String(args[0]) !== sessionDirectory || args[1] !== 'r' || !failDirectorySync) return handle
      failDirectorySync = false
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') return async () => Promise.reject(new Error('simulated directory fsync failure'))
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    })
    try {
      await expect(flushPendingMessages(state)).rejects.toThrow('simulated directory fsync failure')
    } finally {
      openSpy.mockRestore()
    }

    expect(state.committedTranscriptEpochId).toBe(oldEpochId)
    expect(state.transcriptRequiresSnapshot).toBe(true)
    state.messages.push({ role: 'user', content: 'continue after uncertain durability' })
    await flushPendingMessages(state)

    const loaded = await loadSession(filePath)
    expect(loaded?.transcriptIntegrity).toBe('clean')
    expect(loaded?.transcriptRequiresSnapshot).toBe(false)
    expect(loaded?.messages).toEqual([
      { role: 'user', content: 'durable root' },
      { role: 'assistant', content: 'snapshot reached rename' },
      { role: 'user', content: 'continue after uncertain durability' },
    ])
  })

  it('lets cleanup enqueue a recovery snapshot behind a failing delta flush', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-cleanup-repair'
    state.messages = [{ role: 'user', content: 'durable' }]
    await appendHeader(state, 'test:model', 'durable')
    await flushPendingMessages(state)

    state.messages.push({ role: 'assistant', content: 'must survive cleanup' })
    const filePath = getSessionFilePath(state)
    let signalPartialWrite!: () => void
    const partialWriteStarted = new Promise<void>((resolve) => (signalPartialWrite = resolve))
    let releaseFailure!: () => void
    const failureGate = new Promise<void>((resolve) => (releaseFailure = resolve))
    const fakeHandle = {
      async writeFile(data: string | Uint8Array) {
        const payload = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
        await fs.appendFile(filePath, payload.slice(0, payload.indexOf('\n') + 1) + '{', 'utf8')
        signalPartialWrite()
        await failureGate
        throw new Error('simulated concurrent partial append')
      },
      async sync() {},
      async close() {},
    }
    const openSpy = vi.spyOn(fs, 'open').mockResolvedValueOnce(fakeHandle as never)
    try {
      const failedFlush = flushPendingMessages(state)
      const observedFailure = expect(failedFlush).rejects.toThrow('Failed to commit transcript delta')
      await partialWriteStarted
      const cleanup = saveSession(state, {} as never)
      releaseFailure()
      await observedFailure
      await cleanup
    } finally {
      releaseFailure()
      openSpy.mockRestore()
    }

    expect(state.transcriptRequiresSnapshot).toBe(false)
    const loaded = await loadSession(filePath)
    expect(loaded?.transcriptIntegrity).toBe('clean')
    expect(loaded?.transcriptRequiresSnapshot).toBe(false)
    expect(loaded?.messages).toEqual([
      { role: 'user', content: 'durable' },
      { role: 'assistant', content: 'must survive cleanup' },
    ])
  })
})

describe('session-store: malformed input', () => {
  it('returns null when the file does not exist', async () => {
    const result = await loadSession(join(tempDir, 'nonexistent.jsonl'))
    expect(result).toBeNull()
  })

  it('returns null when the file has no parseable header', async () => {
    const sessionsDir = join(tempDir, '.x-code', 'sessions')
    const filePath = join(sessionsDir, 'orphan.jsonl')
    await writeFile(filePath, '{"t":"msg","message":{"role":"user","content":"x"},"ts":"now"}\n', { flag: 'wx' }).catch(
      async () => {
        // Directory may not exist — let appendHeader create it via a probe call.
        const state = createLoopState()
        state.sessionId = 'probe'
        state.taskSlug = 'probe'
        await appendHeader(state, 'm', 'p')
        await writeFile(filePath, '{"t":"msg","message":{"role":"user","content":"x"},"ts":"now"}\n')
      },
    )
    const result = await loadSession(filePath)
    expect(result).toBeNull()
  })

  it('stops at a malformed gap and fails closed instead of accepting a later epoch', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'mixed-junk'
    state.messages = [{ role: 'user', content: 'real' }]
    await appendHeader(state, 'anthropic:claude-sonnet-5', 'real')
    await flushPendingMessages(state)
    // Append a corrupt line.
    const fp = getSessionFilePath(state)
    await writeFile(fp, '{not json\n', { flag: 'a' })
    state.messages.push({ role: 'assistant', content: 'reply' })
    await flushPendingMessages(state)

    const loaded = await loadSession(fp)
    expect(loaded!.messages).toEqual([{ role: 'user', content: 'real' }])
    expect(loaded!.transcriptIntegrity).toBe('failed')
    expect(loaded!.contextSecurity).toMatchObject({ peerInfluenceActive: true, integrityFailure: true })
  })
})

describe('session-store: listSessions / pickLatestSession', () => {
  it('returns empty when no session directory exists', async () => {
    expect(await listSessions(tempDir)).toEqual([])
    expect(await pickLatestSession(tempDir)).toBeNull()
  })

  it('lists sessions newest first', async () => {
    // Create two sessions with distinct slugs and a delay between them
    // so mtime ordering is deterministic.
    const s1 = createLoopState()
    s1.sessionId = '20260101-120000-000'
    s1.taskSlug = 'older'
    s1.messages = [{ role: 'user', content: 'old prompt' }]
    await appendHeader(s1, 'm1', 'old prompt')
    await flushPendingMessages(s1)

    await new Promise((r) => setTimeout(r, 20))

    const s2 = createLoopState()
    s2.sessionId = '20260101-120001-000'
    s2.taskSlug = 'newer'
    s2.messages = [{ role: 'user', content: 'new prompt' }]
    await appendHeader(s2, 'm2', 'new prompt')
    await flushPendingMessages(s2)

    const list = await listSessions()
    expect(list).toHaveLength(2)
    expect(list[0].taskSlug).toBe('newer')
    expect(list[1].taskSlug).toBe('older')

    const latest = await pickLatestSession()
    expect(latest!.taskSlug).toBe('newer')
  })
})

describe('session-store: hydrateLoopState', () => {
  it('seeds a LoopState ready for agentLoop continuation', async () => {
    const s = createLoopState()
    s.sessionId = '20260101-120000-000'
    s.taskSlug = 'continue'
    s.messages = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]
    s.tokenUsage = {
      inputTokens: 50,
      outputTokens: 5,
      totalTokens: 55,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 55,
    }
    await appendHeader(s, 'anthropic:claude-sonnet-5', 'q')
    await flushPendingMessages(s)
    await appendUsage(s, 'anthropic:claude-sonnet-5')

    const loaded = await loadSession(getSessionFilePath(s))
    const hydrated = hydrateLoopState(loaded!)
    expect(hydrated.sessionId).toBe('20260101-120000-000')
    expect(hydrated.sessionFilePath).toBe(loaded!.filePath)
    expect(hydrated.taskSlug).toBe('continue')
    expect(hydrated.messages).toHaveLength(2)
    expect(hydrated.tokenUsage.inputTokens).toBe(50)
    expect(hydrated.persistedMessageCount).toBe(2)
  })

  it('hydrates the latest goal input entry by id after promotion', async () => {
    const s = createLoopState()
    s.sessionId = '20260101-120000-001'
    s.taskSlug = 'goal'
    const goal = createGoal(s, { objective: 'finish durable goal' })
    const input = admitGoalInput(s, { goalId: goal.id, kind: 'initial', content: 'start' })

    await appendHeader(s, 'anthropic:claude-sonnet-5', 'finish durable goal')
    await appendGoalState(s)
    await appendGoalInput(s, input)
    const promoted = promoteNextGoalInput(s, goal.id)!
    await appendGoalInput(s, promoted)

    const loaded = await loadSession(getSessionFilePath(s))
    const hydrated = hydrateLoopState(loaded!)

    expect(hydrated.goalInputs).toHaveLength(1)
    expect(hydrated.goalInputs[0]?.id).toBe(input.id)
    expect(hydrated.goalInputs[0]?.promotedAt).toBe(promoted.promotedAt)
  })

  it('restores the persisted memory generation even without tombstones', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-002'
    state.taskSlug = 'memory-generation'
    state.memoryGeneration = 7
    await appendHeader(state, 'test:model', 'resume memory')
    await appendMemoryRecall(state, {
      anchorMessageIndex: 0,
      placement: 'before-user',
      estimatedTokens: 5,
      topics: [
        {
          topicId: 'profile',
          topicHash: 'topic-hash',
          factIds: ['user.language'],
          factHashes: { 'user.language': 'fact-hash' },
          renderedContent: 'OPAQUE_RECALLED_VALUE',
        },
      ],
    })

    const loaded = await loadSession(getSessionFilePath(state))
    expect(loaded?.memoryGeneration).toBe(7)
    expect(hydrateLoopState(loaded!).memoryGeneration).toBe(7)
  })
})
