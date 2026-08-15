import { HeadTailOutputBuffer } from '../src/tools/shell-session/output-buffer.js'

describe('HeadTailOutputBuffer', () => {
  it('returns small output unchanged and resets after drain', () => {
    const buffer = new HeadTailOutputBuffer(64)
    buffer.append('hello')
    buffer.append(' world')

    expect(buffer.snapshot()).toEqual({ output: 'hello world', originalBytes: 11, omittedBytes: 0 })
    expect(buffer.drain()).toEqual({ output: 'hello world', originalBytes: 11, omittedBytes: 0 })
    expect(buffer.snapshot()).toEqual({ output: '', originalBytes: 0, omittedBytes: 0 })
  })

  it('retains the byte-bounded head and tail with an exact omission count', () => {
    const buffer = new HeadTailOutputBuffer(10)
    buffer.append('abcdefghijklmnopqrst')

    const snapshot = buffer.snapshot()
    expect(snapshot.originalBytes).toBe(20)
    expect(snapshot.omittedBytes).toBe(10)
    expect(snapshot.output).toBe('abcde\n... 10 bytes omitted ...\npqrst')
  })

  it('keeps rolling the tail after the buffer first overflows', () => {
    const buffer = new HeadTailOutputBuffer(8)
    buffer.append('abcdefghij')
    buffer.append('klmnop')

    expect(buffer.snapshot()).toEqual({
      output: 'abcd\n... 8 bytes omitted ...\nmnop',
      originalBytes: 16,
      omittedBytes: 8,
    })
  })

  it('does not concatenate the retained tail for every small append after truncation', () => {
    const buffer = new HeadTailOutputBuffer(1024 * 1024)
    buffer.append(Buffer.alloc(1024 * 1024, 97))
    buffer.append('b')
    const concat = vi.spyOn(Buffer, 'concat')
    try {
      for (let index = 0; index < 10_000; index++) buffer.append('x')
      expect(concat).not.toHaveBeenCalled()
      expect(buffer.retainedBytes).toBe(1024 * 1024)
    } finally {
      concat.mockRestore()
    }
  })

  it('reads a bounded recent tail without concatenating the retained transcript', () => {
    const buffer = new HeadTailOutputBuffer(1024 * 1024)
    buffer.append(Buffer.alloc(1024 * 1024, 97))
    buffer.append('recent-output')
    const concat = vi.spyOn(Buffer, 'concat')
    try {
      expect(buffer.tailSnapshot(13)).toBe('recent-output')
      expect(concat).not.toHaveBeenCalled()
    } finally {
      concat.mockRestore()
    }
  })

  it('keeps recent tail snapshots on UTF-8 character boundaries', () => {
    const buffer = new HeadTailOutputBuffer(64)
    buffer.append(`prefix-${'界'.repeat(40)}-end`)
    expect(buffer.tailSnapshot(12)).toBe('界界-end')
    expect(buffer.tailSnapshot(11)).not.toContain('\uFFFD')
  })

  it('never slices a multibyte character into a replacement glyph', () => {
    const value = '开头-中间-结尾'
    const buffer = new HeadTailOutputBuffer(13)
    buffer.append(value)

    const snapshot = buffer.snapshot()
    expect(snapshot.output).not.toContain('\uFFFD')
    expect(snapshot.originalBytes).toBe(Buffer.byteLength(value, 'utf8'))
    expect(snapshot.omittedBytes).toBeGreaterThan(0)
    expect(snapshot.originalBytes - snapshot.omittedBytes).toBeLessThanOrEqual(13)
  })

  it('drops an incomplete leading character at the exact head boundary', () => {
    const buffer = new HeadTailOutputBuffer(4)
    buffer.append(`中${'x'.repeat(8)}`)

    const snapshot = buffer.snapshot()
    expect(snapshot.output).not.toContain('\uFFFD')
    expect(snapshot.originalBytes - snapshot.omittedBytes).toBeLessThanOrEqual(4)
  })

  it('supports a zero-byte retention budget', () => {
    const buffer = new HeadTailOutputBuffer(0)
    buffer.append('secret')
    expect(buffer.snapshot()).toEqual({
      output: '\n... 6 bytes omitted ...\n',
      originalBytes: 6,
      omittedBytes: 6,
    })
  })

  it('rejects invalid byte budgets', () => {
    expect(() => new HeadTailOutputBuffer(-1)).toThrow(/non-negative safe integer/)
    expect(() => new HeadTailOutputBuffer(1.5)).toThrow(/non-negative safe integer/)
    expect(() => new HeadTailOutputBuffer().tailSnapshot(-1)).toThrow(/non-negative safe integer/)
  })
})
