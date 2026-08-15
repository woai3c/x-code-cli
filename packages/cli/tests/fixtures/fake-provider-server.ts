import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

import { errorMessage } from '../../../core/dist/utils.js'

export interface CapturedProviderRequest {
  sequence: number
  receivedAt: number
  method: string
  url: string
  model?: string
  messages: unknown[]
  tools: string[]
  authorizationPresent: boolean
  rawBody: string
  body: Record<string, unknown>
  kind: 'main' | 'memory-selector' | 'memory-extractor'
  cancelled: boolean
  responseClosed: boolean
}

export type ScriptedResponse =
  | { type: 'completion'; text: string; chunks?: string[]; chunkDelayMs?: number }
  | { type: 'tool-call'; name: string; input: unknown; id?: string; finalText?: string }
  | {
      type: 'http-error'
      status: 401 | 403 | 429 | 500 | 503
      retryAfterMs?: number
      message?: string
    }
  | { type: 'stall'; afterHeaders?: boolean }
  | { type: 'disconnect'; afterBytes: number }
  | { type: 'partial-sse'; chunks: string[]; closeAfterChunk: number; chunkDelayMs?: number }

export interface FakeProvider {
  baseUrl: string
  enqueue(...responses: ScriptedResponse[]): void
  requests(): CapturedProviderRequest[]
  mainRequests(): CapturedProviderRequest[]
  waitForRequests(count: number, timeoutMs?: number): Promise<CapturedProviderRequest[]>
  waitForMainRequests(count: number, timeoutMs?: number): Promise<CapturedProviderRequest[]>
  openConnections(): number
  close(): Promise<void>
}

const DEFAULT_COMPLETION: ScriptedResponse = { type: 'completion', text: 'ok' }

function writeSseHeaders(response: http.ServerResponse): void {
  response.writeHead(200, {
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
  })
  response.flushHeaders()
}

function chunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function completionChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return chunk({
    id: 'chatcmpl-x-code-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
}

function usageChunk(): string {
  return chunk({
    id: 'chatcmpl-x-code-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  })
}

export function textSseEvent(text: string): string {
  return completionChunk({ role: 'assistant', content: text })
}

export function toolCallSseEvent(name: string, input: unknown, id = 'call_x_code_test'): string {
  return completionChunk({
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(input) },
      },
    ],
  })
}

function responseBody(status: number, message?: string): string {
  return JSON.stringify({
    error: {
      message: message ?? `scripted HTTP ${status}`,
      type: status === 429 ? 'rate_limit_error' : status < 500 ? 'authentication_error' : 'server_error',
      code: status === 429 ? 'rate_limit_exceeded' : undefined,
    },
  })
}

function extractToolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return []
  return body.tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return ''
      const record = tool as Record<string, unknown>
      if (typeof record.name === 'string') return record.name
      const fn = record.function
      return fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string'
        ? ((fn as Record<string, unknown>).name as string)
        : ''
    })
    .filter(Boolean)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function classifyRequest(messages: unknown[]): CapturedProviderRequest['kind'] {
  const first = messages[0]
  const content =
    first && typeof first === 'object' && typeof (first as Record<string, unknown>).content === 'string'
      ? ((first as Record<string, unknown>).content as string)
      : ''
  if (content.startsWith('You select relevant long-term memory topics')) return 'memory-selector'
  if (content.startsWith('You extract durable, cross-session user memory')) return 'memory-extractor'
  return 'main'
}

export async function startFakeProvider(initialResponses: ScriptedResponse[] = []): Promise<FakeProvider> {
  const scripted = [...initialResponses]
  const captured: CapturedProviderRequest[] = []
  const sockets = new Set<Socket>()
  let closed = false

  const server = http.createServer((request, response) => {
    void (async () => {
      const bodyBuffers: Buffer[] = []
      for await (const value of request) bodyBuffers.push(Buffer.isBuffer(value) ? value : Buffer.from(value))
      const rawBody = Buffer.concat(bodyBuffers).toString('utf-8')
      let body: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(rawBody) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
      } catch {
        // Keep malformed bodies observable in rawBody; the fake endpoint still
        // responds so the client failure remains deterministic.
      }

      const messages = Array.isArray(body.messages) ? body.messages : []
      const entry: CapturedProviderRequest = {
        sequence: captured.length + 1,
        receivedAt: Date.now(),
        method: request.method ?? '',
        url: request.url ?? '',
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        messages,
        tools: extractToolNames(body),
        authorizationPresent: typeof request.headers.authorization === 'string',
        rawBody,
        body,
        kind: classifyRequest(messages),
        cancelled: false,
        responseClosed: false,
      }
      captured.push(entry)

      request.once('aborted', () => {
        entry.cancelled = true
      })
      response.once('close', () => {
        entry.responseClosed = true
        if (!response.writableEnded) entry.cancelled = true
      })

      const next: ScriptedResponse =
        entry.kind === 'memory-selector'
          ? { type: 'completion', text: '{"topicIds":[]}' }
          : entry.kind === 'memory-extractor'
            ? { type: 'completion', text: '{"operations":[]}' }
            : (scripted.shift() ?? DEFAULT_COMPLETION)
      if (next.type === 'http-error') {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (next.retryAfterMs !== undefined) headers['retry-after'] = String(next.retryAfterMs / 1000)
        response.writeHead(next.status, headers)
        response.end(responseBody(next.status, next.message))
        return
      }

      if (next.type === 'stall') {
        if (next.afterHeaders) writeSseHeaders(response)
        return
      }

      if (next.type === 'disconnect') {
        if (next.afterBytes <= 0) {
          response.socket?.destroy()
          return
        }
        writeSseHeaders(response)
        const prefix = textSseEvent('interrupted-stream').slice(0, next.afterBytes)
        response.write(prefix)
        response.socket?.destroy()
        return
      }

      if (next.type === 'partial-sse') {
        writeSseHeaders(response)
        const last = Math.min(next.closeAfterChunk, next.chunks.length)
        for (let i = 0; i < last; i++) {
          response.write(next.chunks[i])
          if (next.chunkDelayMs) await wait(next.chunkDelayMs)
        }
        response.socket?.destroy()
        return
      }

      writeSseHeaders(response)
      if (next.type === 'tool-call') {
        const id = next.id ?? 'call_x_code_test'
        response.write(toolCallSseEvent(next.name, next.input, id))
        response.write(completionChunk({}, 'tool_calls'))
        response.write(usageChunk())
        response.end('data: [DONE]\n\n')
        if (next.finalText !== undefined) scripted.unshift({ type: 'completion', text: next.finalText })
        return
      }

      const pieces = next.chunks ?? [next.text]
      for (let i = 0; i < pieces.length; i++) {
        response.write(completionChunk({ ...(i === 0 ? { role: 'assistant' } : {}), content: pieces[i] }))
        if (next.chunkDelayMs) await wait(next.chunkDelayMs)
      }
      response.write(completionChunk({}, 'stop'))
      response.write(usageChunk())
      response.end('data: [DONE]\n\n')
    })().catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
      } else {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(responseBody(500, errorMessage(error)))
      }
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    enqueue: (...responses) => scripted.push(...responses),
    requests: () => captured,
    mainRequests: () => captured.filter((request) => request.kind === 'main'),
    waitForRequests: async (count, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs
      while (captured.length < count) {
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for ${count} provider requests; saw ${captured.length}`)
        await wait(10)
      }
      return captured
    },
    waitForMainRequests: async (count, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs
      while (captured.filter((request) => request.kind === 'main').length < count) {
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for ${count} main provider requests; saw ${captured.filter((request) => request.kind === 'main').length}`,
          )
        }
        await wait(10)
      }
      return captured.filter((request) => request.kind === 'main')
    },
    openConnections: () => sockets.size,
    close: async () => {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
