import { afterEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  createTestWorkspace,
  isolatedCliEnv,
  readSessionJsonl,
  runPrintCli,
  spawnCli,
  waitFor,
} from '../fixtures/cli-test-helpers.js'
import { startFakeProvider, textSseEvent } from '../fixtures/fake-provider-server.js'
import type { FakeProvider } from '../fixtures/fake-provider-server.js'

const providers: FakeProvider[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(providers.splice(0).map((provider) => provider.close()))
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function setup(responses: Parameters<typeof startFakeProvider>[0]) {
  const provider = await startFakeProvider(responses)
  providers.push(provider)
  const workspace = await createTestWorkspace('xc-stream-interrupt-')
  cleanups.push(workspace.cleanup)
  return { provider, workspace }
}

function incompleteToolEvent(): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-partial-tool',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_partial',
              type: 'function',
              function: { name: 'writeFile', arguments: '{"filePath":"should-not-exist.txt","content":"unfinished' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  })}\n\n`
}

function orphanToolCallIds(entries: unknown[]): string[] {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (record.t !== 'msg') continue
    const message = record.message as { content?: unknown } | undefined
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type === 'tool-call' && typeof part.toolCallId === 'string') calls.add(part.toolCallId)
      if (part.type === 'tool-result' && typeof part.toolCallId === 'string') results.add(part.toolCallId)
    }
  }
  return [...calls].filter((id) => !results.has(id))
}

describe('stream interruption recovery', () => {
  it('reconnects after the request-level retry budget is exhausted', async () => {
    const { provider, workspace } = await setup([
      { type: 'disconnect', afterBytes: 0 },
      { type: 'disconnect', afterBytes: 0 },
      { type: 'disconnect', afterBytes: 0 },
      { type: 'disconnect', afterBytes: 0 },
      { type: 'completion', text: 'recovered-after-reconnect' },
    ])
    const result = await runPrintCli({ workspace, provider, timeoutMs: 25_000 })

    expect(result.exitCode).toBe(0)
    expect(provider.requests()).toHaveLength(5)
    expect(result.stdout).toContain('recovered-after-reconnect')
    expect(result.stderr).toContain('Reconnecting... 1/5')
    expect(result.stderr).not.toMatch(/unhandled|NoOutputGeneratedError|APICallError|RetryError/i)
    await expect(readSessionJsonl(workspace.cwd)).resolves.toBeInstanceOf(Array)
  })

  it('continues an interrupted text stream and keeps recovery context request-only', async () => {
    const { provider, workspace } = await setup([
      {
        type: 'partial-sse',
        chunks: [textSseEvent('partial-visible-text')],
        closeAfterChunk: 1,
        chunkDelayMs: 50,
      },
      { type: 'completion', text: '-continued' },
    ])
    const result = await runPrintCli({ workspace, provider })
    const entries = await readSessionJsonl(workspace.cwd)

    expect(result.exitCode).toBe(0)
    expect(provider.requests()).toHaveLength(2)
    expect(result.stdout).toContain('partial-visible-text-continued')
    expect(result.stderr).toContain('Reconnecting... 1/5')
    expect(result.stderr).not.toMatch(/unhandled|NoOutputGeneratedError|APICallError|RetryError/i)
    expect(entries.length).toBeGreaterThan(0)
    expect(orphanToolCallIds(entries)).toEqual([])

    const retryMessages = provider.requests()[1]!.messages as Array<{ role?: string; content?: unknown }>
    expect(retryMessages.at(-2)).toMatchObject({ role: 'assistant', content: 'partial-visible-text' })
    expect(retryMessages.at(-1)?.role).toBe('user')
    expect(String(retryMessages.at(-1)?.content)).toContain('Continue directly')
  })

  it('reconnects safely when streamed tool JSON never became a complete call', async () => {
    const { provider, workspace } = await setup([
      { type: 'partial-sse', chunks: [incompleteToolEvent()], closeAfterChunk: 1 },
      { type: 'completion', text: 'recovered-after-incomplete-tool' },
    ])
    const result = await runPrintCli({ workspace, provider, args: ['--trust'] })

    expect(result.exitCode).toBe(0)
    expect(provider.requests()).toHaveLength(2)
    expect(result.stdout).toContain('recovered-after-incomplete-tool')
    await expect(fs.access(path.join(workspace.cwd, 'should-not-exist.txt'))).rejects.toThrow()
    expect(result.stderr).not.toMatch(/unhandled|NoOutputGeneratedError|APICallError|RetryError/i)
    const entries = await readSessionJsonl(workspace.cwd)
    expect(orphanToolCallIds(entries)).toEqual([])
  })

  it('cancels reconnect backoff without issuing another request', async () => {
    const { provider, workspace } = await setup([
      { type: 'partial-sse', chunks: [textSseEvent('partial-before-cancel')], closeAfterChunk: 1 },
      { type: 'completion', text: 'must-not-be-requested' },
    ])
    const processUnderTest = spawnCli({
      cwd: workspace.cwd,
      env: isolatedCliEnv(workspace, provider),
      args: ['--print', '--no-plugins', '--no-hooks', '--max-turns', '4', 'hi'],
      timeoutMs: 10_000,
    })

    await waitFor(() => processUnderTest.stderr().includes('Reconnecting... 1/5'), 'reconnect status')
    processUnderTest.kill('SIGINT')
    const result = await processUnderTest.wait()
    await new Promise((resolve) => setTimeout(resolve, 1100))

    expect(result.exitCode === 0 || result.exitCode === 130 || result.signal === 'SIGINT').toBe(true)
    expect(provider.requests()).toHaveLength(1)
    expect(result.stderr).not.toContain('[error]')
  })

  it('threads abort to a tool that started after a complete tool call', async () => {
    const { provider, workspace } = await setup([])
    const readyPath = path.join(workspace.cwd, 'ready.txt')
    const abortedPath = path.join(workspace.cwd, 'aborted.txt')
    const scriptPath = path.join(workspace.cwd, 'controlled-tool.mjs')
    await fs.writeFile(
      scriptPath,
      [
        "import fs from 'node:fs'",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready')`,
        `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(abortedPath)}, 'aborted'); process.exit(0) })`,
        `process.on('SIGINT', () => { fs.writeFileSync(${JSON.stringify(abortedPath)}, 'aborted'); process.exit(0) })`,
        'setInterval(() => {}, 1000)',
      ].join('\n'),
      'utf-8',
    )
    provider.enqueue({
      type: 'tool-call',
      name: 'shell',
      input: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}` },
    })
    const processUnderTest = spawnCli({
      cwd: workspace.cwd,
      env: isolatedCliEnv(workspace, provider),
      args: ['--print', '--trust', '--no-plugins', '--no-hooks', '--max-turns', '4', 'hi'],
      timeoutMs: 15_000,
    })

    await waitFor(
      async () => {
        try {
          await fs.access(readyPath)
          return true
        } catch {
          return false
        }
      },
      'controlled tool to start',
      15_000,
    )
    processUnderTest.kill('SIGINT')
    const result = await processUnderTest.wait()

    await waitFor(
      async () => {
        try {
          await fs.access(abortedPath)
          return true
        } catch {
          return false
        }
      },
      'controlled tool to observe abort',
      15_000,
    )
    expect(result.stderr).not.toMatch(/unhandled|NoOutputGeneratedError|APICallError|RetryError/i)
    const entries = await readSessionJsonl(workspace.cwd)
    expect(orphanToolCallIds(entries)).toEqual([])
  })
})
