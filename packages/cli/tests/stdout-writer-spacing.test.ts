import { resetScrollbackSpacing, writeMessageToStdout } from '../src/ui/render/stdout-writer.js'

const { originalNoColor } = vi.hoisted(() => {
  const originalNoColor = process.env.NO_COLOR
  delete process.env.NO_COLOR
  return { originalNoColor }
})

describe('stdout writer spacing', () => {
  afterAll(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = originalNoColor
  })

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

  it('strips terminal injection from peer messages before adding trusted renderer styling', () => {
    let output = ''

    writeMessageToStdout(
      (chunk) => {
        output += chunk
      },
      {
        id: 'peer-message',
        role: 'user',
        kind: 'peer-message',
        content:
          '你好\x1b[2J世界\x1b]8;;https://evil.test\x1b\\链接\x1b]8;;\x1b\\' + '\x1b]52;c;Y2xpcGJvYXJk\x07\u202e\n🧑🏽‍💻',
        peer: {
          name: 'peer\x1b]0;title\x07',
          address: 'peer:address\x07',
          summary: 'summary\u009b2J',
        },
        timestamp: 0,
      },
    )

    expect(output).toContain('你好世界链接')
    expect(output).toContain('🧑🏽‍💻')
    expect(output).not.toContain('\x1b[2J')
    expect(output).not.toContain('\x1b]52;')
    expect(output).not.toContain('https://evil.test')
    expect(output).not.toContain('\x07')
    expect(output).not.toContain('\u202e')
  })

  it('applies the same defense to peer status reasons', () => {
    let output = ''

    writeMessageToStdout(
      (chunk) => {
        output += chunk
      },
      {
        id: 'peer-status',
        role: 'assistant',
        kind: 'peer-status',
        content: 'Denied\x1b]52;c;c2VjcmV0\x07 safely\u2066',
        timestamp: 0,
      },
    )

    expect(output).toContain('Denied safely')
    expect(output).not.toContain('c2VjcmV0')
    expect(output).not.toContain('\u2066')
  })

  it('syntax-highlights successful shell command previews (codex-style)', () => {
    let output = ''

    writeMessageToStdout(
      (chunk) => {
        output += chunk
      },
      {
        id: 'shell-ok',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'tool-call',
            toolName: 'shell',
            input: { command: 'git log --oneline && echo "done"' },
            status: 'completed',
            output: 'abc123 commit\ndone',
          },
        ],
        timestamp: 0,
      },
    )

    // Command text survives verbatim once the SGR color runs are stripped…
    expect(output.replace(/\x1b\[[0-9;]*m/g, '')).toContain('git log --oneline && echo "done"')
    // …and the flag + string carry syntax colors (one-dark palette:
    // storage #c678dd, string #98c379) instead of the flat primary blue.
    expect(output).toContain('\x1b[38;2;198;120;221m--oneline')
    expect(output).toContain('\x1b[38;2;152;195;121m"done"')
  })

  it('renders denied authority tool input as visible escapes in scrollback', () => {
    let output = ''

    writeMessageToStdout(
      (chunk) => {
        output += chunk
      },
      {
        id: 'authority-denied',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'tool-call',
            toolName: 'shell',
            input: { command: 'printf safe\x1b[999;999H\x1b]52;c;c2VjcmV0\x07\u202e' },
            status: 'denied',
          },
        ],
        timestamp: 0,
      },
    )

    expect(output).toContain('printf safe\\u001B[999;999H\\u001B]52;c;c2VjcmV0\\u0007\\u202E')
    expect(output).not.toContain('\x1b[999;999H')
    expect(output).not.toContain('\x1b]52;c;c2VjcmV0\x07')
    expect(output).not.toContain('\x07')
    expect(output).not.toContain('\u202e')
  })
})
