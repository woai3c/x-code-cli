import { resetScrollbackSpacing, writeMessageToStdout } from '../src/ui/stdout-writer.js'

describe('stdout writer spacing', () => {
  beforeEach(() => resetScrollbackSpacing())

  it('leaves exactly one blank row after a non-streaming assistant message', () => {
    let output = ''

    writeMessageToStdout(
      (chunk) => {
        output += chunk
      },
      {
        id: 'help',
        role: 'assistant',
        content: 'X-Code CLI\n\n/help  Show help\nKeyboard: Ctrl+C',
        timestamp: 0,
      },
    )

    expect(output.endsWith('\r\n\r\n')).toBe(true)
    expect(output.endsWith('\r\n\r\n\r\n')).toBe(false)
  })
})
