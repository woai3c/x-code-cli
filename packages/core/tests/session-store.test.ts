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
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import {
  appendHeader,
  appendUsage,
  flushPendingMessages,
  getSessionFilePath,
  hydrateLoopState,
  listSessions,
  loadSession,
  markBoundaryAndReflush,
  pickLatestSession,
} from '../src/agent/session-store.js'

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
  it('uses slug-id when slug is non-empty', () => {
    const state = { sessionId: '20260101-120000-000', taskSlug: 'fix-login' }
    const p = getSessionFilePath(state, tempDir)
    expect(p.endsWith('fix-login-20260101-120000-000.jsonl')).toBe(true)
  })

  it('falls back to id-only when slug is empty (CJK first message)', () => {
    const state = { sessionId: '20260101-120000-000', taskSlug: '' }
    const p = getSessionFilePath(state, tempDir)
    expect(p.endsWith('20260101-120000-000.jsonl')).toBe(true)
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

    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'Hello')
    await flushPendingMessages(state)
    state.tokenUsage.inputTokens = 100
    state.tokenUsage.outputTokens = 20
    state.tokenUsage.totalTokens = 120
    await appendUsage(state, 'anthropic:claude-sonnet-4-6')

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

  it('persistedMessageCount stays in sync after multiple flushes', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'multi-flush'

    state.messages.push({ role: 'user', content: 'msg 1' })
    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'msg 1')
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
    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'q1')
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

  it('only the LAST boundary determines what is loaded (multiple boundaries)', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'multi-boundary'

    state.messages = [{ role: 'user', content: 'q1' }]
    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'q1')
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
    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'work on something')
    await flushPendingMessages(state)

    const loaded = await loadSession(getSessionFilePath(state))
    // The orphan tool_call assistant message at index 3 is dropped.
    expect(loaded!.messages).toHaveLength(3)
    const lastAssistant = loaded!.messages[1]
    expect(lastAssistant.role).toBe('assistant')
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
    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'do it')
    await flushPendingMessages(state)

    const loaded = await loadSession(getSessionFilePath(state))
    expect(loaded!.messages).toHaveLength(3)
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

  it('skips malformed lines silently', async () => {
    const state = createLoopState()
    state.sessionId = '20260101-120000-000'
    state.taskSlug = 'mixed-junk'
    state.messages = [{ role: 'user', content: 'real' }]
    await appendHeader(state, 'anthropic:claude-sonnet-4-6', 'real')
    await flushPendingMessages(state)
    // Append a corrupt line.
    const fp = getSessionFilePath(state)
    await writeFile(fp, '{not json\n', { flag: 'a' })
    state.messages.push({ role: 'assistant', content: 'reply' })
    await flushPendingMessages(state)

    const loaded = await loadSession(fp)
    expect(loaded!.messages).toHaveLength(2)
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
    await appendHeader(s, 'anthropic:claude-sonnet-4-6', 'q')
    await flushPendingMessages(s)
    await appendUsage(s, 'anthropic:claude-sonnet-4-6')

    const loaded = await loadSession(getSessionFilePath(s))
    const hydrated = hydrateLoopState(loaded!)
    expect(hydrated.sessionId).toBe('20260101-120000-000')
    expect(hydrated.taskSlug).toBe('continue')
    expect(hydrated.messages).toHaveLength(2)
    expect(hydrated.tokenUsage.inputTokens).toBe(50)
    expect(hydrated.persistedMessageCount).toBe(2)
  })
})
