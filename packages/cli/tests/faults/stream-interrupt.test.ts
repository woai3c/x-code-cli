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
  it('handles disconnects before HTTP headers without an uncaught rejection', async () => {
    const { provider, workspace } = await setup([
      { type: 'disconnect', afterBytes: 0 },
      { type: 'disconnect', afterBytes: 0 },
      { type: 'disconnect', afterBytes: 0 },
      { type: 'disconnect', afterBytes: 0 },
    ])
    const result = await runPrintCli({ workspace, provider, timeoutMs: 25_000 })

    expect(result.exitCode).toBe(1)
    expect(provider.requests()).toHaveLength(4)
    expect(result.stderr).toContain('Network connection failed or was interrupted')
    expect(result.stderr).not.toMatch(/unhandled|NoOutputGeneratedError|APICallError|RetryError/i)
    await expect(readSessionJsonl(workspace.cwd)).resolves.toBeInstanceOf(Array)
  })

  it('reports an interrupted text SSE stream once and keeps the session JSONL valid', async () => {
    const { provider, workspace } = await setup([
      { type: 'partial-sse', chunks: [textSseEvent('partial-visible-text')], closeAfterChunk: 1 },
    ])
    const result = await runPrintCli({ workspace, provider })
    const entries = await readSessionJsonl(workspace.cwd)

    expect(result.exitCode).toBe(1)
    expect(provider.requests()).toHaveLength(1)
    expect(result.stderr).toContain('Network connection failed or was interrupted')
    expect(result.stderr).not.toMatch(/unhandled|NoOutputGeneratedError|APICallError|RetryError/i)
    expect(entries.length).toBeGreaterThan(0)
    expect(orphanToolCallIds(entries)).toEqual([])
  })

  it('does not execute a tool whose streamed JSON arguments are incomplete', async () => {
    const { provider, workspace } = await setup([
      { type: 'partial-sse', chunks: [incompleteToolEvent()], closeAfterChunk: 1 },
    ])
    const result = await runPrintCli({ workspace, provider, args: ['--trust'] })

    await expect(fs.access(path.join(workspace.cwd, 'should-not-exist.txt'))).rejects.toThrow()
    expect(result.stderr).not.toMatch(/unhandled|NoOutputGeneratedError|APICallError|RetryError/i)
    const entries = await readSessionJsonl(workspace.cwd)
    expect(orphanToolCallIds(entries)).toEqual([])
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

    await waitFor(async () => {
      try {
        await fs.access(readyPath)
        return true
      } catch {
        return false
      }
    }, 'controlled tool to start')
    processUnderTest.kill('SIGINT')
    const result = await processUnderTest.wait()

    await waitFor(async () => {
      try {
        await fs.access(abortedPath)
        return true
      } catch {
        return false
      }
    }, 'controlled tool to observe abort')
    expect(result.stderr).not.toMatch(/unhandled|NoOutputGeneratedError|APICallError|RetryError/i)
    const entries = await readSessionJsonl(workspace.cwd)
    expect(orphanToolCallIds(entries)).toEqual([])
  })
})
