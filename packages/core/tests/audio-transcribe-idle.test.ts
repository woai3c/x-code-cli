import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EventEmitter as EventEmitterType } from 'node:events'

import { disposeWhisperProcess, runWhisperTranscription } from '../src/agent/audio-transcribe-runner.js'

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
    expect(childState.options[0]?.execArgv).toEqual([])
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
})
