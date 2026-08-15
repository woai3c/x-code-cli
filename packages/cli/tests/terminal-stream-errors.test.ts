import { EventEmitter } from 'node:events'

import { installTerminalStreamErrorGuards } from '../src/terminal-stream-errors.js'

describe('terminal stream error guards', () => {
  it('isolates EPIPE during terminal disconnect cleanup', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const dispose = installTerminalStreamErrorGuards([stdout, stderr])
    const brokenPipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })

    expect(() => stdout.emit('error', brokenPipe)).not.toThrow()
    expect(() => stderr.emit('error', brokenPipe)).not.toThrow()
    dispose()
    expect(stdout.listenerCount('error')).toBe(0)
    expect(stderr.listenerCount('error')).toBe(0)
  })

  it('does not hide unrelated stream failures', () => {
    const stream = new EventEmitter()
    installTerminalStreamErrorGuards([stream])

    expect(() => stream.emit('error', Object.assign(new Error('bad descriptor'), { code: 'EBADF' }))).toThrow(
      'bad descriptor',
    )
  })
})
