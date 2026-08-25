import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EventEmitter as EventEmitterType } from 'node:events'

import {
  disposeWhisperProcess,
  probeWhisperRuntime,
  runWhisperTranscription,
} from '../src/agent/audio-transcribe-runner.js'

const childState = vi.hoisted(() => ({
  options: [] as Array<{ execArgv?: string[] }>,
  instances: [] as Array<
    EventEmitterType & {
      channel: { ref: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }
      connected: boolean
      kill: ReturnType<typeof vi.fn>
      ref: ReturnType<typeof vi.fn>
      send: ReturnType<typeof vi.fn>
      unref: ReturnType<typeof vi.fn>
    }
  >,
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    fork: vi.fn((_modulePath: string, _args: string[], options: { execArgv?: string[] }) => {
      childState.options.push(options)
      const child = Object.assign(new EventEmitter(), {
        channel: { ref: vi.fn(), unref: vi.fn() },
        connected: true,
        ref: vi.fn(),
        unref: vi.fn(),
        send: vi.fn((_message: unknown, callback?: (error: Error | null) => void) => callback?.(null)),
        kill: vi.fn(function (this: (typeof childState.instances)[number], signal?: string) {
          this.connected = false
          this.emit('exit', 0, signal ?? null)
          return true
        }),
      })
      childState.instances.push(child)
      return child
    }),
  }
})

function sentRequest(child: (typeof childState.instances)[number]): { id: number } {
  return child.send.mock.calls[0]?.[0] as { id: number }
}

beforeEach(() => {
  vi.useFakeTimers()
  childState.options.length = 0
  childState.instances.length = 0
  disposeWhisperProcess()
})

afterEach(() => {
  disposeWhisperProcess()
  vi.useRealTimers()
})

describe('Whisper process lifetime', () => {
  it('starts the idle termination timer only after a transcription finishes', async () => {
    const pending = runWhisperTranscription('/model.bin', '/long.wav')
    await vi.waitFor(() => expect(childState.instances).toHaveLength(1))
    const child = childState.instances[0]!
    expect(childState.options[0]?.execArgv).toEqual(['--max-old-space-size=256'])
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(1))
    const request = sentRequest(child)

    await vi.advanceTimersByTimeAsync(60_001)
    expect(child.kill).not.toHaveBeenCalled()

    child.emit('message', {
      id: request.id,
      type: 'result',
      result: {
        isAborted: false,
        language: 'en',
        result: 'done',
        segments: [{ t0: 0, t1: 1, text: 'done' }],
      },
    })
    await expect(pending).resolves.toMatchObject({ result: 'done' })
    expect(child.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_001)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('settles cancellation immediately and force-terminates native decoding', async () => {
    const controller = new AbortController()
    const pending = runWhisperTranscription('/model.bin', '/long.wav', { abortSignal: controller.signal })
    await vi.waitFor(() => expect(childState.instances).toHaveLength(1))
    const child = childState.instances[0]!
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(1))

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('settles an aborted queued request without waiting for the active transcription', async () => {
    const first = runWhisperTranscription('/model.bin', '/first.pcm')
    await vi.waitFor(() => expect(childState.instances).toHaveLength(1))
    const child = childState.instances[0]!
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(1))

    const controller = new AbortController()
    const queued = runWhisperTranscription('/model.bin', '/queued.pcm', { abortSignal: controller.signal })
    controller.abort()

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.send).toHaveBeenCalledTimes(1)
    expect(child.kill).not.toHaveBeenCalled()

    const request = sentRequest(child)
    child.emit('message', {
      id: request.id,
      type: 'result',
      result: { isAborted: false, result: 'first', segments: [] },
    })
    await expect(first).resolves.toMatchObject({ result: 'first' })
    await Promise.resolve()
    expect(child.send).toHaveBeenCalledTimes(1)
  })

  it('counts queue wait against a request timeout without terminating the active transcription', async () => {
    const first = runWhisperTranscription('/model.bin', '/first.pcm')
    await vi.waitFor(() => expect(childState.instances).toHaveLength(1))
    const child = childState.instances[0]!
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(1))

    const queued = runWhisperTranscription('/model.bin', '/queued.pcm', { timeoutMs: 1_000 })
    const rejection = expect(queued).rejects.toThrow(/including queue wait/i)
    await vi.advanceTimersByTimeAsync(1_001)

    await rejection
    expect(child.send).toHaveBeenCalledTimes(1)
    expect(child.kill).not.toHaveBeenCalled()

    const request = sentRequest(child)
    child.emit('message', {
      id: request.id,
      type: 'result',
      result: { isAborted: false, result: 'first', segments: [] },
    })
    await expect(first).resolves.toMatchObject({ result: 'first' })
    await Promise.resolve()
    expect(child.send).toHaveBeenCalledTimes(1)
  })

  it('probes the native runtime through the isolated process', async () => {
    const pending = probeWhisperRuntime()
    await vi.waitFor(() => expect(childState.instances).toHaveLength(1))
    const child = childState.instances[0]!
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(1))
    const request = child.send.mock.calls[0]?.[0] as { id: number; type: string }
    expect(request.type).toBe('probe')

    child.emit('message', { id: request.id, type: 'ready' })

    await expect(pending).resolves.toBeUndefined()
  })

  it('force-terminates a transcription that exceeds its total timeout', async () => {
    const pending = runWhisperTranscription('/model.bin', '/long.wav', { timeoutMs: 1_000 })
    const rejection = expect(pending).rejects.toThrow(/timed out/i)
    await vi.waitFor(() => expect(childState.instances).toHaveLength(1))
    const child = childState.instances[0]!
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(1_001)

    await rejection
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
